/**
 * Orixas backend (Cloudflare Worker + D1).
 *
 * Public:
 *   GET  /api/founder                 -> starea curenta a locurilor Founder
 *   GET  /api/founder/stream          -> Server-Sent Events, emite starea la schimbare
 *   POST /api/accounts                -> creeaza contul, tine locul 35 min si deschide plata avansului
 *   GET  /api/accounts/:id            -> datele publice ale unui cont (fara email)
 *   GET  /api/checkout/status         -> sincronizeaza plata cu Stripe (success page)
 *   POST /api/withdrawals             -> declaratie online de retragere din contract (OUG 18/2026)
 *   POST /api/stripe/webhook          -> webhook Stripe (semnatura verificata)
 *
 * Administrare (header `Authorization: Bearer <ADMIN_TOKEN>`):
 *   POST /api/admin/login                    -> verifica tokenul
 *   GET  /api/admin/accounts                 -> lista conturilor + statistici
 *   POST /api/admin/accounts/:id/cancel      -> anuleaza rezervarea, ramburseaza, elibereaza locul
 *   POST /api/admin/accounts/:id/refund      -> reincearca rambursarea
 *
 * Orice alta ruta este servita din assets (site-ul static).
 */

const DEFAULT_TOTAL_SEATS = 20;
const SEAT_RETRIES = 3;
const STREAM_INTERVAL_MS = 4000;
const ADMIN_SEARCH_LIMIT = 500;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 12;
const WITHDRAW_WINDOW_MS = 10 * 60 * 1000;
const WITHDRAW_MAX_REQUESTS = 8;
const PAYMENT_SIGNATURE_TOLERANCE_SECONDS = 300;

/* Avansul de rezervare: 50 EUR, deductibil integral din prima factura lunara. */
const DEPOSIT_CENTS = 5000;
const DEPOSIT_CURRENCY = "eur";
/* Cat timp sta locul rezervat cat timp clientul plateste. */
const HOLD_MINUTES = 35;
/* Trebuie sa coincida cu versiunea publicata in paginile legale. */
const TERMS_VERSION = "2026-11-21";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_RE = /^[A-Za-z\u00C0-\u024F\u1E00-\u1EFF][A-Za-z0-9\u00C0-\u024F\u1E00-\u1EFF\s\-'.]{2,79}$/;
const CUI_RE = /^RO\d{6,10}$/;

const ROLES = ["antreprenor", "contabil"];

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL,
     cui TEXT NOT NULL,
     role TEXT NOT NULL,
     marketing_consent INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'reserved',
     seat_number INTEGER,
     created_at TEXT NOT NULL,
     payment_status TEXT NOT NULL DEFAULT 'unpaid',
     amount_cents INTEGER,
     currency TEXT,
     stripe_session_id TEXT,
     stripe_checkout_url TEXT,
     stripe_payment_intent TEXT,
     checkout_expires_at TEXT,
     paid_at TEXT,
     refunded_at TEXT,
     withdrawal_requested_at TEXT,
     terms_version TEXT,
     terms_accepted_at TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts (email)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_seat ON accounts (seat_number)`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_created_at ON accounts (created_at)`,
  `CREATE TABLE IF NOT EXISTS founder_config (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     total_seats INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS founder_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     seat_number INTEGER,
     kind TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS withdrawals (
     id TEXT PRIMARY KEY,
     reference TEXT NOT NULL,
     account_id TEXT,
     email TEXT NOT NULL,
     name TEXT,
     reason TEXT,
     requested_at TEXT NOT NULL,
     status TEXT NOT NULL,
     refund_status TEXT,
     refund_id TEXT,
     email_status TEXT,
     note TEXT
   )`
];

/* Coloane adaugate dupa prima versiune a schemei (baza de date deja existenta). */
const MIGRATION_STATEMENTS = [
  `ALTER TABLE accounts ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'`,
  "ALTER TABLE accounts ADD COLUMN amount_cents INTEGER",
  "ALTER TABLE accounts ADD COLUMN currency TEXT",
  "ALTER TABLE accounts ADD COLUMN stripe_session_id TEXT",
  "ALTER TABLE accounts ADD COLUMN stripe_checkout_url TEXT",
  "ALTER TABLE accounts ADD COLUMN stripe_payment_intent TEXT",
  "ALTER TABLE accounts ADD COLUMN checkout_expires_at TEXT",
  "ALTER TABLE accounts ADD COLUMN paid_at TEXT",
  "ALTER TABLE accounts ADD COLUMN refunded_at TEXT",
  "ALTER TABLE accounts ADD COLUMN withdrawal_requested_at TEXT",
  "ALTER TABLE accounts ADD COLUMN terms_version TEXT",
  "ALTER TABLE accounts ADD COLUMN terms_accepted_at TEXT",
  "CREATE INDEX IF NOT EXISTS idx_accounts_payment ON accounts (payment_status)"
];

const INACTIVE_STATUSES = ["cancelled", "expired", "withdrawn"];

/* ------------------------------------------------------------------ helpers */

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign(
      {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, max-age=0"
      },
      extraHeaders || {}
    )
  });
}

function fail(error, message, status, details) {
  return jsonResponse({ ok: false, error, message, details: details || null }, status || 400);
}

function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function readJson(request) {
  return request
    .json()
    .catch(function () {
      return null;
    })
    .then(function (body) {
      return body && typeof body === "object" ? body : null;
    });
}

function isTrue(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function nowIso() {
  return new Date().toISOString();
}

function isoInMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function depositCents(env) {
  const configured = Number(env && env.DEPOSIT_AMOUNT_CENTS);
  return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : DEPOSIT_CENTS;
}

/** Comparatie in timp constant, ca tokenul sa nu fie ghicit prin timing. */
function tokensMatch(provided, expected) {
  const a = new TextEncoder().encode(String(provided || ""));
  const b = new TextEncoder().encode(String(expected || ""));
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] || 0) ^ (b[i] || 0);
  }
  return diff === 0;
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "local";
}

function maskEmail(email) {
  const value = String(email || "");
  const at = value.indexOf("@");
  if (at < 1) {
    return "***";
  }
  const name = value.slice(0, at);
  return name.slice(0, 2) + "***" + value.slice(at);
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(function (byte) {
      return byte.toString(16).padStart(2, "0");
    })
    .join("");
}

/* ------------------------------------------------------------------- schema */

const schemaReady = new WeakMap();

function ensureSchema(env) {
  if (!env || !env.DB) {
    return Promise.reject(new Error("D1 binding DB is not configured"));
  }

  const cached = schemaReady.get(env);
  if (cached) {
    return cached;
  }

  const pending = (async function () {
    await env.DB.batch(
      SCHEMA_STATEMENTS.map(function (sql) {
        return env.DB.prepare(sql);
      })
    );

    await env.DB.prepare(
      "INSERT INTO founder_config (id, total_seats) VALUES (1, ?1) ON CONFLICT (id) DO NOTHING"
    )
      .bind(DEFAULT_TOTAL_SEATS)
      .run();

    for (const sql of MIGRATION_STATEMENTS) {
      try {
        await env.DB.prepare(sql).run();
      } catch (error) {
        /* coloana exista deja */
      }
    }
  })().catch(function (error) {
    console.error("schema init failed", String((error && error.message) || error));
    schemaReady.delete(env);
    throw error;
  });

  schemaReady.set(env, pending);
  return pending;
}

/* -------------------------------------------------------------------- state */

/**
 * Locurile ocupate = rezervari platite + rezervari in curs de plata (max 35 min).
 * Rezervarile neplatite si expirate nu mai blocheaza locul.
 */
async function readFounderState(env) {
  const now = nowIso();
  const row = await env.DB.prepare(
    `SELECT
       COALESCE((SELECT total_seats FROM founder_config WHERE id = 1), ?1) AS total,
       (SELECT COUNT(*) FROM accounts
          WHERE seat_number IS NOT NULL
            AND (payment_status = 'paid'
                 OR (payment_status = 'unpaid' AND checkout_expires_at IS NOT NULL AND checkout_expires_at > ?2))) AS taken,
       (SELECT COUNT(*) FROM accounts WHERE payment_status = 'paid' AND seat_number IS NOT NULL) AS paid,
       (SELECT MAX(created_at) FROM accounts WHERE seat_number IS NOT NULL) AS lastChange`
  )
    .bind(DEFAULT_TOTAL_SEATS, now)
    .first();

  const total = Math.max(0, Number(row && row.total) || DEFAULT_TOTAL_SEATS);
  const taken = Math.max(0, Math.min(total, Number(row && row.taken) || 0));
  const paid = Math.max(0, Math.min(taken, Number(row && row.paid) || 0));

  return {
    total: total,
    taken: taken,
    paid: paid,
    pending: Math.max(0, taken - paid),
    remaining: Math.max(0, total - taken),
    soldOut: taken >= total,
    depositCents: DEPOSIT_CENTS,
    depositCurrency: DEPOSIT_CURRENCY,
    lastChange: (row && row.lastChange) || null,
    updatedAt: now
  };
}

/** Elibereaza locurile tinute de plati abandonate/expirate. */
function releaseExpiredHolds(env) {
  const now = nowIso();
  return env.DB.prepare(
    `UPDATE accounts
        SET status = 'expired', payment_status = 'expired', seat_number = NULL
      WHERE payment_status = 'unpaid'
        AND (checkout_expires_at IS NULL OR checkout_expires_at <= ?1)
        AND status NOT IN ('cancelled', 'withdrawn')`
  )
    .bind(now)
    .run()
    .catch(function () {
      /* curatarea este best-effort; starea publica filtreaza oricum expirarile */
    });
}

/* ----------------------------------------------------------------- - stream */

function streamFounderState(env, request) {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  let stopped = false;
  if (request.signal) {
    request.signal.addEventListener("abort", function () {
      stopped = true;
    });
  }

  (async function () {
    try {
      await writer.write(encoder.encode("retry: 4000\n\n"));
      let previous = "";
      while (!stopped) {
        let state;
        try {
          state = await readFounderState(env);
        } catch (error) {
          await writer.write(encoder.encode(": state-error\n\n"));
          await sleep(STREAM_INTERVAL_MS);
          continue;
        }

        const signature = JSON.stringify(state);
        if (signature !== previous) {
          previous = signature;
          await writer.write(
            encoder.encode("event: founder\ndata: " + JSON.stringify(state) + "\n\n")
          );
        } else {
          await writer.write(encoder.encode(": ping\n\n"));
        }

        await sleep(STREAM_INTERVAL_MS);
      }
    } catch (error) {
      /* client disconnected */
    } finally {
      try {
        await writer.close();
      } catch (error) {
        /* already closed */
      }
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no"
    }
  });
}

/* ------------------------------------------------------------------- Stripe */

function stripeConfigured(env) {
  return Boolean(env && env.STRIPE_SECRET_KEY);
}

function stripeBase(env) {
  return String((env && env.STRIPE_API_BASE) || "https://api.stripe.com").replace(/\/+$/, "");
}

async function stripeRequest(env, method, path, params) {
  if (!stripeConfigured(env)) {
    throw new Error("STRIPE_NOT_CONFIGURED");
  }

  const query = params ? new URLSearchParams(params).toString() : "";
  const url = stripeBase(env) + path + (method === "GET" && query ? "?" + query : "");

  const response = await fetch(url, {
    method: method,
    headers: {
      authorization: "Bearer " + env.STRIPE_SECRET_KEY,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": "2024-06-20"
    },
    body: method === "GET" ? undefined : query
  });

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (error) {
    data = null;
  }

  if (!response.ok) {
    const detail = (data && data.error && data.error.message) || text.slice(0, 200);
    throw new Error("Stripe " + response.status + ": " + detail);
  }

  return data;
}

async function createCheckoutSession(env, account, origin) {
  const amount = depositCents(env);
  const expiresAt = Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60 - 60;
  const params = {
    mode: "payment",
    locale: "ro",
    customer_email: account.email,
    client_reference_id: account.id,
    success_url: origin + "/rezervare.html?account=" + account.id + "&session_id={CHECKOUT_SESSION_ID}",
    cancel_url: origin + "/auth.html?anulat=1",
    expires_at: String(expiresAt),
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": DEPOSIT_CURRENCY,
    "line_items[0][price_data][unit_amount]": String(amount),
    "line_items[0][price_data][product_data][name]": "Orixas Founder Bundle - avans rezervare loc",
    "line_items[0][price_data][product_data][description]":
      "Avans de 50 EUR pentru rezervarea unui loc Founder Bundle. Se deduce integral din prima factura a abonamentului de 100 EUR/luna.",
    "metadata[accountId]": account.id,
    "metadata[seatNumber]": String(account.seat_number),
    "metadata[termsVersion]": TERMS_VERSION,
    "payment_intent_data[metadata][accountId]": account.id,
    "payment_intent_data[description]": "Orixas Founder Bundle - avans rezervare loc",
    "invoice_creation[enabled]": "true",
    "invoice_creation[invoice_data][description]": "Avans rezervare loc Founder Bundle (deductibil din prima factura)",
    "invoice_creation[invoice_data][metadata][accountId]": account.id,
    "custom_text[submit][message]":
      "Platesti un avans de 50 EUR, deductibil din prima factura. Ai drept de retragere in 14 zile."
  };

  return stripeRequest(env, "POST", "/v1/checkout/sessions", params);
}

async function verifyStripeSignature(env, payload, header) {
  const secret = env && env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) {
    return false;
  }

  const parts = String(header).split(",");
  let timestamp = "";
  const signatures = [];

  parts.forEach(function (part) {
    const pair = part.split("=");
    const key = (pair[0] || "").trim();
    const value = (pair[1] || "").trim();
    if (key === "t") {
      timestamp = value;
    } else if (key === "v1") {
      signatures.push(value);
    }
  });

  if (!timestamp || !signatures.length) {
    return false;
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > PAYMENT_SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(timestamp + "." + payload)
  );
  const expected = toHex(signature);

  return signatures.some(function (candidate) {
    return tokensMatch(candidate, expected);
  });
}

async function markAccountPaid(env, lookup, paymentIntentId) {
  const now = nowIso();
  const account = await env.DB.prepare(
    `SELECT id, status, seat_number, payment_status, amount_cents, currency, created_at
       FROM accounts WHERE ${lookup.column} = ?1`
  )
    .bind(lookup.value)
    .first();

  if (!account) {
    return null;
  }

  if (account.payment_status === "paid") {
    return account;
  }

  await env.DB.prepare(
    `UPDATE accounts
        SET payment_status = 'paid',
            status = 'reserved',
            paid_at = ?2,
            stripe_payment_intent = COALESCE(?3, stripe_payment_intent),
            amount_cents = COALESCE(amount_cents, ?4),
            currency = COALESCE(currency, ?5)
      WHERE id = ?1`
  )
    .bind(account.id, now, paymentIntentId || null, DEPOSIT_CENTS, DEPOSIT_CURRENCY)
    .run();

  await logFounderEvent(env, account.seat_number, "paid");

  return Object.assign({}, account, { payment_status: "paid", paid_at: now });
}

async function releaseAccount(env, accountId, status, paymentStatus) {
  await env.DB.prepare(
    "UPDATE accounts SET status = ?2, payment_status = ?3, seat_number = NULL WHERE id = ?1"
  )
    .bind(accountId, status, paymentStatus)
    .run();
}

async function refundAccount(env, account) {
  if (account.payment_status === "refunded") {
    return { ok: true, already: true, refundId: null };
  }

  if (!stripeConfigured(env)) {
    return { ok: false, error: "STRIPE_NOT_CONFIGURED" };
  }

  let paymentIntent = account.stripe_payment_intent;

  if (!paymentIntent && account.stripe_session_id) {
    try {
      const session = await stripeRequest(
        env,
        "GET",
        "/v1/checkout/sessions/" + encodeURIComponent(account.stripe_session_id)
      );
      paymentIntent = (session && session.payment_intent) || null;
    } catch (error) {
      /* incercam rambursarea pe baza datelor existente */
    }
  }

  if (!paymentIntent) {
    return { ok: false, error: "MISSING_PAYMENT" };
  }

  try {
    const refund = await stripeRequest(env, "POST", "/v1/refunds", {
      payment_intent: paymentIntent,
      reason: "requested_by_customer",
      "metadata[accountId]": account.id
    });

    await env.DB.prepare(
      `UPDATE accounts SET payment_status = 'refunded', refunded_at = ?2,
        stripe_payment_intent = COALESCE(stripe_payment_intent, ?3)
       WHERE id = ?1`
    )
      .bind(account.id, nowIso(), paymentIntent)
      .run();

    return { ok: true, refundId: (refund && refund.id) || null, status: (refund && refund.status) || null };
  } catch (error) {
    return { ok: false, error: "REFUND_FAILED", detail: String((error && error.message) || error) };
  }
}

/* ----------------------------------------------------------------- accounts */

function validateAccount(body) {
  const errors = [];

  const name = clean(body && body.name);
  const email = clean(body && body.email).toLowerCase();
  const cui = clean(body && body.cui).toUpperCase();
  const role = clean(body && body.role).toLowerCase();
  const marketingConsent = isTrue(body && body.marketingConsent);
  const consentLegal = isTrue(body && body.consentLegal);

  if (!NAME_RE.test(name)) {
    errors.push({ field: "name", message: "Numele trebuie sa aiba intre 3 si 80 caractere." });
  }
  if (email.length > 120 || !EMAIL_RE.test(email)) {
    errors.push({ field: "email", message: "Adresa de email nu este valida." });
  }
  if (!CUI_RE.test(cui)) {
    errors.push({ field: "cui", message: "CUI invalid. Formatul acceptat este RO urmat de 6-10 cifre." });
  }
  if (ROLES.indexOf(role) === -1) {
    errors.push({ field: "role", message: "Rolul selectat nu este valid." });
  }
  if (!consentLegal) {
    errors.push({
      field: "consentLegal",
      message:
        "Este necesar sa accepti Termenii, Politica de confidentialitate si informarea privind dreptul de retragere."
    });
  }

  return {
    valid: errors.length === 0,
    errors: errors,
    data: {
      name: name,
      email: email,
      cui: cui,
      role: role,
      marketingConsent: marketingConsent ? 1 : 0
    }
  };
}

function isUniqueEmailError(error) {
  return String((error && error.message) || "").indexOf("accounts.email") !== -1;
}

function isUniqueSeatError(error) {
  return String((error && error.message) || "").indexOf("accounts.seat_number") !== -1;
}

/**
 * Rezerva atomic primul loc liber (1..total). Locurile eliberate de anulari,
 * expirari sau retrageri sunt reutilizate.
 */
function insertAccount(env, data) {
  const now = nowIso();
  const id = crypto.randomUUID();
  const expiresAt = isoInMinutes(HOLD_MINUTES);

  return env.DB.prepare(
    `WITH RECURSIVE seq(n) AS (
       SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?9
     ),
     taken AS (
       SELECT seat_number FROM accounts WHERE seat_number IS NOT NULL
     ),
     free_seat AS (
       SELECT MIN(n) AS seat FROM seq WHERE n NOT IN (SELECT seat_number FROM taken)
     )
     INSERT INTO accounts
       (id, name, email, cui, role, marketing_consent, status, payment_status,
        seat_number, created_at, terms_version, terms_accepted_at, checkout_expires_at,
        amount_cents, currency)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'pending', 'unpaid',
            (SELECT seat FROM free_seat), ?7, ?8, ?7, ?10, ?11, ?12
     WHERE (SELECT seat FROM free_seat) IS NOT NULL
       AND (SELECT COUNT(*) FROM taken) < ?9
     RETURNING id, seat_number, created_at, payment_status, checkout_expires_at`
  )
    .bind(
      id,
      data.name,
      data.email,
      data.cui,
      data.role,
      data.marketingConsent,
      now,
      TERMS_VERSION,
      DEFAULT_TOTAL_SEATS,
      expiresAt,
      depositCents(env),
      DEPOSIT_CURRENCY
    )
    .all();
}

async function findAccountByEmail(env, email) {
  return env.DB.prepare(
    `SELECT id, email, status, seat_number, payment_status, stripe_checkout_url, checkout_expires_at
       FROM accounts WHERE email = ?1`
  )
    .bind(email)
    .first();
}

async function handleCreateAccount(env, request) {
  const body = await readJson(request);
  if (!body) {
    return fail("INVALID_BODY", "Cererea nu contine un corp JSON valid.", 400);
  }

  const validation = validateAccount(body);
  if (!validation.valid) {
    return fail("VALIDATION", "Datele trimise nu sunt valide.", 422, validation.errors);
  }

  if (!stripeConfigured(env)) {
    return fail(
      "PAYMENTS_NOT_CONFIGURED",
      "Plata avansului nu este inca activa pe acest site. Rezervarile se deschid imediat ce procesatorul de plati este configurat.",
      503
    );
  }

  await ensureSchema(env);
  await releaseExpiredHolds(env);

  const existing = await findAccountByEmail(env, validation.data.email);

  if (existing) {
    if (existing.payment_status === "paid") {
      return fail("EMAIL_EXISTS", "Exista deja un cont cu aceasta adresa de email.", 409);
    }

    const expiresAt = existing.checkout_expires_at ? Date.parse(existing.checkout_expires_at) : 0;
    const stillOpen = existing.payment_status === "unpaid" && expiresAt > Date.now();

    if (stillOpen && existing.stripe_checkout_url) {
      return jsonResponse(
        {
          ok: true,
          reused: true,
          account: { id: existing.id, seatNumber: existing.seat_number },
          checkoutUrl: existing.stripe_checkout_url,
          founder: await readFounderState(env)
        },
        200
      );
    }

    /* Rezervare abandonata/expirata: o inlocuim cu una noua. */
    await env.DB.prepare(
      "DELETE FROM accounts WHERE id = ?1 AND payment_status <> 'paid'"
    )
      .bind(existing.id)
      .run();
  }

  let created = null;
  let lastError = null;

  for (let attempt = 0; attempt < SEAT_RETRIES; attempt += 1) {
    try {
      const result = await insertAccount(env, validation.data);
      created = (result && result.results && result.results[0]) || null;
      break;
    } catch (error) {
      lastError = error;
      if (isUniqueEmailError(error)) {
        return fail("EMAIL_EXISTS", "Exista deja un cont cu aceasta adresa de email.", 409);
      }
      if (!isUniqueSeatError(error)) {
        throw error;
      }
      await sleep(60 + attempt * 90);
    }
  }

  if (!created) {
    if (lastError && !isUniqueSeatError(lastError)) {
      throw lastError;
    }
    const state = await readFounderState(env);
    return fail("SOLD_OUT", "Toate cele 20 de locuri Founder Bundle sunt rezervate.", 409, state);
  }

  const account = {
    id: created.id,
    email: validation.data.email,
    seat_number: created.seat_number,
    created_at: created.created_at,
    payment_status: created.payment_status
  };

  await logFounderEvent(env, created.seat_number, "reserved");

  let session = null;
  try {
    const origin = new URL(request.url).origin;
    session = await createCheckoutSession(env, account, origin);
  } catch (error) {
    console.error("stripe checkout failed", String((error && error.message) || error));
    await releaseAccount(env, created.id, "expired", "expired");
    return fail(
      "PAYMENT_ERROR",
      "Plata nu a putut fi initializata. Locul nu a fost rezervat. Incearca din nou.",
      502
    );
  }

  await env.DB.prepare(
    "UPDATE accounts SET stripe_session_id = ?2, stripe_checkout_url = ?3 WHERE id = ?1"
  )
    .bind(created.id, session && session.id, (session && session.url) || null)
    .run();

  return jsonResponse(
    {
      ok: true,
      requiresPayment: true,
      checkoutUrl: (session && session.url) || null,
      deposit: { amountCents: depositCents(env), currency: DEPOSIT_CURRENCY, holdMinutes: HOLD_MINUTES },
      account: {
        id: created.id,
        seatNumber: created.seat_number,
        createdAt: created.created_at,
        paymentStatus: "unpaid",
        name: validation.data.name,
        cui: validation.data.cui,
        role: validation.data.role
      },
      founder: await readFounderState(env)
    },
    201
  );
}

async function handleGetAccount(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, name, cui, role, seat_number, status, payment_status, amount_cents, currency,
            created_at, paid_at, refunded_at
       FROM accounts WHERE id = ?1`
  )
    .bind(id)
    .first();

  if (!row) {
    return fail("NOT_FOUND", "Contul nu exista.", 404);
  }

  return jsonResponse({
    ok: true,
    account: {
      id: row.id,
      name: row.name,
      cui: row.cui,
      role: row.role,
      seatNumber: row.seat_number,
      status: row.status,
      paymentStatus: row.payment_status,
      amountCents: row.amount_cents,
      currency: row.currency,
      createdAt: row.created_at,
      paidAt: row.paid_at,
      refundedAt: row.refunded_at
    }
  });
}

async function handleCheckoutStatus(env, url) {
  const sessionId = clean(url.searchParams.get("session_id"));
  const accountId = clean(url.searchParams.get("account"));

  if (!sessionId && !accountId) {
    return fail("MISSING_PARAMETER", "Lipseste identificatorul sesiunii de plata.", 400);
  }

  const row = sessionId
    ? await env.DB.prepare(
        `SELECT * FROM accounts WHERE stripe_session_id = ?1`
      )
        .bind(sessionId)
        .first()
    : await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?1`).bind(accountId).first();

  if (!row) {
    return fail("NOT_FOUND", "Sesiunea de plata nu exista sau a expirat.", 404);
  }

  let paymentStatus = row.payment_status;

  if (paymentStatus !== "paid" && stripeConfigured(env) && row.stripe_session_id) {
    try {
      const session = await stripeRequest(
        env,
        "GET",
        "/v1/checkout/sessions/" + encodeURIComponent(row.stripe_session_id)
      );

      if (session && session.payment_status === "paid") {
        await markAccountPaid(env, { column: "id", value: row.id }, session.payment_intent);
        paymentStatus = "paid";
      } else if (session && session.status === "expired" && paymentStatus === "unpaid") {
        await releaseAccount(env, row.id, "expired", "expired");
        paymentStatus = "expired";
      }
    } catch (error) {
      console.error("checkout status sync failed", String((error && error.message) || error));
    }
  }

  const fresh = await env.DB.prepare(
    "SELECT id, seat_number, status, payment_status, amount_cents, currency FROM accounts WHERE id = ?1"
  )
    .bind(row.id)
    .first();

  return jsonResponse({
    ok: true,
    paid: Boolean(fresh && fresh.payment_status === "paid"),
    paymentStatus: (fresh && fresh.payment_status) || paymentStatus,
    status: (fresh && fresh.status) || null,
    accountId: row.id,
    seatNumber: (fresh && fresh.seat_number) || null,
    amountCents: (fresh && fresh.amount_cents) || depositCents(env),
    currency: (fresh && fresh.currency) || DEPOSIT_CURRENCY,
    founder: await readFounderState(env)
  });
}

/* --------------------------------------------------------------- webhooks */

async function handleStripeWebhook(env, request) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return fail("WEBHOOK_NOT_CONFIGURED", "Webhook-ul Stripe nu este configurat.", 503);
  }

  const payload = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!(await verifyStripeSignature(env, payload, signature))) {
    return fail("INVALID_SIGNATURE", "Semnatura webhook-ului este invalida.", 400);
  }

  let event = null;
  try {
    event = JSON.parse(payload);
  } catch (error) {
    return fail("INVALID_PAYLOAD", "Payload invalid.", 400);
  }

  await ensureSchema(env);

  const type = (event && event.type) || "";
  const object = (event && event.data && event.data.object) || {};

  try {
    if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
      if (object.payment_status === "paid" || type === "checkout.session.async_payment_succeeded") {
        await markAccountPaid(env, { column: "stripe_session_id", value: object.id }, object.payment_intent);
      }
    } else if (type === "checkout.session.expired") {
      await env.DB.prepare(
        `UPDATE accounts SET status = 'expired', payment_status = 'expired', seat_number = NULL
          WHERE stripe_session_id = ?1 AND payment_status = 'unpaid'`
      )
        .bind(object.id)
        .run();
    } else if (type === "charge.refunded") {
      await env.DB.prepare(
        "UPDATE accounts SET payment_status = 'refunded', refunded_at = ?2 WHERE stripe_payment_intent = ?1 AND payment_status = 'paid'"
      )
        .bind(object.payment_intent, nowIso())
        .run();
    }
  } catch (error) {
    console.error("webhook handling failed", type, String((error && error.message) || error));
    return fail("WEBHOOK_ERROR", "Evenimentul nu a putut fi procesat.", 500);
  }

  return jsonResponse({ ok: true, received: true, type: type });
}

/* -------------------------------------------------------------- withdrawals */

const withdrawAttempts = new Map();

function rateLimited(map, key, limit, windowMs) {
  const entry = map.get(key);
  if (!entry || Date.now() - entry.first > windowMs) {
    map.set(key, { first: Date.now(), count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

function withdrawalReference() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes)
    .map(function (byte) {
      return byte.toString(16).padStart(2, "0");
    })
    .join("")
    .toUpperCase();
  return "RT-" + new Date().getUTCFullYear() + "-" + suffix;
}

async function sendWithdrawalEmail(env, withdrawal, account) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    return "not_configured";
  }

  const submitted = new Date(withdrawal.requested_at).toLocaleString("ro-RO", {
    timeZone: "Europe/Bucharest",
    dateStyle: "long",
    timeStyle: "short"
  });

  const html =
    "<p>Am primit declaratia ta de retragere din contract pentru Orixas Founder Bundle.</p>" +
    "<p><strong>Continutul declaratiei</strong></p>" +
    "<ul>" +
    "<li>Nume: " + (withdrawal.name || account.name) + "</li>" +
    "<li>Email: " + withdrawal.email + "</li>" +
    "<li>Loc Founder: #" + (account.seat_number || "-") + "</li>" +
    "<li>Cod contract: " + account.id + "</li>" +
    "<li>Data si ora trimiterii: " + submitted + "</li>" +
    "<li>Numar de referinta: " + withdrawal.reference + "</li>" +
    "</ul>" +
    "<p>Rambursarea avansului de 50 EUR se face in maximum 14 zile, pe aceeasi metoda de plata.</p>" +
    "<p>Aceasta confirmare este trimisa pe un suport durabil, conform OUG 34/2014.</p>";

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.RESEND_API_KEY,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [withdrawal.email],
        subject: "Confirmare retragere din contract - " + withdrawal.reference,
        html: html
      })
    });

    return response.ok ? "sent" : "failed";
  } catch (error) {
    return "failed";
  }
}

async function handleWithdrawal(env, request) {
  const ip = clientIp(request);

  if (rateLimited(withdrawAttempts, "wd:" + ip, WITHDRAW_MAX_REQUESTS, WITHDRAW_WINDOW_MS)) {
    return fail("TOO_MANY_ATTEMPTS", "Prea multe cereri. Reincearca peste cateva minute.", 429);
  }

  const body = await readJson(request);
  if (!body) {
    return fail("INVALID_BODY", "Cererea nu contine un corp JSON valid.", 400);
  }

  const email = clean(body.email).toLowerCase();
  const accountId = clean(body.accountId || body.orderNumber);
  const name = clean(body.name);
  const reason = clean(body.reason).slice(0, 500);
  const confirmed = isTrue(body.confirmed);

  const errors = [];
  if (!EMAIL_RE.test(email)) {
    errors.push({ field: "email", message: "Adresa de email nu este valida." });
  }
  if (!/^[A-Za-z0-9-]{8,64}$/.test(accountId)) {
    errors.push({ field: "accountId", message: "Codul contractului (locul rezervat) nu este valid." });
  }
  if (!confirmed) {
    errors.push({ field: "confirmed", message: "Trebuie sa confirmi retragerea din contract." });
  }
  if (errors.length) {
    return fail("VALIDATION", "Datele trimise nu sunt valide.", 422, errors);
  }

  await ensureSchema(env);

  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?1 AND email = ?2")
    .bind(accountId, email)
    .first();

  if (!account) {
    return fail(
      "NOT_FOUND",
      "Nu am gasit niciun contract cu acest cod si aceasta adresa de email. Verifica datele din confirmarea de plata.",
      404
    );
  }

  if (account.status === "withdrawn") {
    return fail("ALREADY_WITHDRAWN", "Pentru acest contract a fost deja inregistrata o retragere.", 409);
  }

  const now = nowIso();
  const reference = withdrawalReference();

  await env.DB.prepare(
    `UPDATE accounts
        SET status = 'withdrawn', seat_number = NULL, withdrawal_requested_at = ?2
      WHERE id = ?1`
  )
    .bind(account.id, now)
    .run();

  await logFounderEvent(env, account.seat_number, "withdrawn");

  let refund = { ok: true, already: true, refundId: null };
  if (account.payment_status === "paid") {
    refund = await refundAccount(env, account);
  }

  const withdrawal = {
    id: crypto.randomUUID(),
    reference: reference,
    account_id: account.id,
    email: email,
    name: name || account.name,
    reason: reason,
    requested_at: now,
    status: "registered",
    refund_status: refund.ok ? "refunded" : "pending_manual",
    refund_id: refund.refundId || null
  };

  const emailStatus = await sendWithdrawalEmail(env, withdrawal, account);

  await env.DB.prepare(
    `INSERT INTO withdrawals
       (id, reference, account_id, email, name, reason, requested_at, status, refund_status, refund_id, email_status, note)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
  )
    .bind(
      withdrawal.id,
      withdrawal.reference,
      withdrawal.account_id,
      withdrawal.email,
      withdrawal.name,
      withdrawal.reason,
      withdrawal.requested_at,
      withdrawal.status,
      withdrawal.refund_status,
      withdrawal.refund_id,
      emailStatus,
      refund.ok ? null : String(refund.error || "")
    )
    .run();

  return jsonResponse(
    {
      ok: true,
      reference: reference,
      requestedAt: now,
      refund: {
        processed: refund.ok,
        refundId: refund.refundId || null,
        deadlineDays: 14
      },
      confirmationEmail: emailStatus,
      founder: await readFounderState(env)
    },
    201
  );
}

/* -------------------------------------------------------------------- admin */

const loginAttempts = new Map();

function adminGuard(env, request) {
  const expected = env && env.ADMIN_TOKEN;
  if (!expected) {
    return fail(
      "ADMIN_NOT_CONFIGURED",
      "Panoul de administrare nu are token configurat. Adauga secretul ADMIN_TOKEN pentru acest site.",
      503
    );
  }

  if (rateLimited(loginAttempts, "admin:" + clientIp(request), LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)) {
    return fail("TOO_MANY_ATTEMPTS", "Prea multe incercari. Reincearca peste cateva minute.", 429);
  }

  if (!tokensMatch(bearerToken(request), expected)) {
    return fail("UNAUTHORIZED", "Token de administrare invalid.", 401);
  }

  return null;
}

async function handleAdminLogin(env, request) {
  if (!env || !env.ADMIN_TOKEN) {
    return fail(
      "ADMIN_NOT_CONFIGURED",
      "Panoul de administrare nu are token configurat. Adauga secretul ADMIN_TOKEN pentru acest site.",
      503
    );
  }

  const key = "admin:" + clientIp(request);
  if (rateLimited(loginAttempts, key, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)) {
    return fail("TOO_MANY_ATTEMPTS", "Prea multe incercari. Reincearca peste cateva minute.", 429);
  }

  const body = await readJson(request);
  const provided = clean(body && body.token);

  if (!provided || !tokensMatch(provided, env.ADMIN_TOKEN)) {
    return fail("UNAUTHORIZED", "Token invalid.", 401);
  }

  loginAttempts.delete(key);
  await ensureSchema(env);
  await releaseExpiredHolds(env);
  return jsonResponse({ ok: true, founder: await readFounderState(env) });
}

async function handleAdminAccounts(env, url) {
  const search = clean(url.searchParams.get("q")).toLowerCase();

  await releaseExpiredHolds(env);

  const rows = await env.DB.prepare(
    `SELECT id, name, email, cui, role, marketing_consent, status, seat_number, created_at,
            payment_status, amount_cents, currency, paid_at, refunded_at, withdrawal_requested_at,
            stripe_session_id, terms_version
       FROM accounts
       ORDER BY CASE WHEN seat_number IS NULL THEN 1 ELSE 0 END, seat_number ASC, created_at DESC
       LIMIT ?1`
  )
    .bind(ADMIN_SEARCH_LIMIT)
    .all();

  const accounts = ((rows && rows.results) || [])
    .filter(function (row) {
      if (!search) {
        return true;
      }
      return (
        String(row.name || "").toLowerCase().indexOf(search) !== -1 ||
        String(row.email || "").toLowerCase().indexOf(search) !== -1 ||
        String(row.cui || "").toLowerCase().indexOf(search) !== -1
      );
    })
    .map(function (row) {
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        cui: row.cui,
        role: row.role,
        marketingConsent: Number(row.marketing_consent) === 1,
        status: row.status,
        seatNumber: row.seat_number,
        createdAt: row.created_at,
        paymentStatus: row.payment_status,
        amountCents: row.amount_cents,
        currency: row.currency,
        paidAt: row.paid_at,
        refundedAt: row.refunded_at,
        withdrawalRequestedAt: row.withdrawal_requested_at,
        termsVersion: row.terms_version
      };
    });

  const founder = await readFounderState(env);
  const inactive = accounts.filter(function (account) {
    return INACTIVE_STATUSES.indexOf(account.status) !== -1;
  }).length;

  return jsonResponse({
    ok: true,
    founder: founder,
    stats: {
      reserved: accounts.length - inactive,
      cancelled: inactive,
      paid: accounts.filter(function (account) {
        return account.paymentStatus === "paid";
      }).length,
      totalAccounts: accounts.length
    },
    accounts: accounts
  });
}

async function handleAdminCancel(env, id) {
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?1")
    .bind(id)
    .first();

  if (!account) {
    return fail("NOT_FOUND", "Contul nu exista.", 404);
  }

  if (INACTIVE_STATUSES.indexOf(account.status) !== -1 || account.seat_number === null) {
    if (account.payment_status === "paid") {
      /* rambursarea poate fi reluata din butonul dedicat */
      const refund = await refundAccount(env, account);
      return jsonResponse({ ok: true, refund: refund, founder: await readFounderState(env) });
    }
    return fail("ALREADY_CANCELLED", "Aceasta rezervare este deja anulata.", 409);
  }

  await env.DB.prepare(
    "UPDATE accounts SET status = 'cancelled', payment_status = ?2, seat_number = NULL WHERE id = ?1"
  )
    .bind(id, account.payment_status === "paid" ? "paid" : "cancelled")
    .run();

  await logFounderEvent(env, account.seat_number, "cancelled");

  const refund = account.payment_status === "paid" ? await refundAccount(env, account) : { ok: true, skipped: true };

  return jsonResponse({
    ok: true,
    cancelled: {
      id: account.id,
      name: account.name,
      email: account.email,
      seatNumber: account.seat_number
    },
    refund: refund,
    founder: await readFounderState(env)
  });
}

async function handleAdminRefund(env, id) {
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?1")
    .bind(id)
    .first();

  if (!account) {
    return fail("NOT_FOUND", "Contul nu exista.", 404);
  }

  if (account.payment_status === "paid" && account.seat_number !== null) {
    return fail(
      "STILL_ACTIVE",
      "Contul este inca activ. Anuleaza mai intai rezervarea, apoi ramburseaza.",
      409
    );
  }

  const refund = await refundAccount(env, account);

  if (!refund.ok) {
    return fail(
      "REFUND_FAILED",
      "Rambursarea nu a reusit. Verifica plata in Stripe si incearca din nou.",
      502,
      refund
    );
  }

  return jsonResponse({ ok: true, refund: refund, founder: await readFounderState(env) });
}

function logFounderEvent(env, seatNumber, kind) {
  return env.DB.prepare(
    "INSERT INTO founder_events (seat_number, kind, created_at) VALUES (?1, ?2, ?3)"
  )
    .bind(seatNumber, kind, nowIso())
    .run()
    .catch(function () {
      /* audit trail is best-effort */
    });
}

/* -------------------------------------------------------------------- router */

async function routeApi(env, request, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, "") || "/api";

  if (path === "/api/founder" && (method === "GET" || method === "HEAD")) {
    try {
      await ensureSchema(env);
      return jsonResponse(await readFounderState(env));
    } catch (error) {
      return fail("DB_UNAVAILABLE", "Baza de date nu este disponibila.", 503);
    }
  }

  if (path === "/api/founder/stream" && (method === "GET" || method === "HEAD")) {
    try {
      await ensureSchema(env);
      return streamFounderState(env, request);
    } catch (error) {
      return fail("DB_UNAVAILABLE", "Baza de date nu este disponibila.", 503);
    }
  }

  if (path === "/api/accounts" && method === "POST") {
    try {
      return await handleCreateAccount(env, request);
    } catch (error) {
      console.error("create-account failed", String((error && error.message) || error));
      return fail("SERVER_ERROR", "Rezervarea nu a putut fi salvata. Incearca din nou.", 500);
    }
  }

  const accountMatch = path.match(/^\/api\/accounts\/([A-Za-z0-9-]{8,64})$/);
  if (accountMatch && method === "GET") {
    try {
      await ensureSchema(env);
      return await handleGetAccount(env, accountMatch[1]);
    } catch (error) {
      return fail("DB_UNAVAILABLE", "Baza de date nu este disponibila.", 503);
    }
  }

  if (path === "/api/checkout/status" && method === "GET") {
    try {
      await ensureSchema(env);
      return await handleCheckoutStatus(env, url);
    } catch (error) {
      console.error("checkout status failed", String((error && error.message) || error));
      return fail("DB_UNAVAILABLE", "Baza de date nu este disponibila.", 503);
    }
  }

  if (path === "/api/withdrawals" && method === "POST") {
    try {
      return await handleWithdrawal(env, request);
    } catch (error) {
      console.error("withdrawal failed", String((error && error.message) || error));
      return fail("SERVER_ERROR", "Cererea de retragere nu a putut fi inregistrata.", 500);
    }
  }

  if (path === "/api/stripe/webhook" && method === "POST") {
    return handleStripeWebhook(env, request);
  }

  /* -------------------------------------------------------------- admin */

  if (path === "/api/admin/login" && method === "POST") {
    return handleAdminLogin(env, request);
  }

  if (path === "/api/admin/accounts" && method === "GET") {
    const denied = adminGuard(env, request);
    if (denied) {
      return denied;
    }
    try {
      await ensureSchema(env);
      return await handleAdminAccounts(env, url);
    } catch (error) {
      console.error("admin list failed", String((error && error.message) || error));
      return fail("DB_UNAVAILABLE", "Baza de date nu este disponibila.", 503);
    }
  }

  const cancelMatch = path.match(/^\/api\/admin\/accounts\/([A-Za-z0-9-]{8,64})\/cancel$/);
  if (cancelMatch && method === "POST") {
    const denied = adminGuard(env, request);
    if (denied) {
      return denied;
    }
    try {
      await ensureSchema(env);
      return await handleAdminCancel(env, cancelMatch[1]);
    } catch (error) {
      console.error("admin cancel failed", String((error && error.message) || error));
      return fail("DB_UNAVAILABLE", "Baza de date nu este disponibila.", 503);
    }
  }

  const refundMatch = path.match(/^\/api\/admin\/accounts\/([A-Za-z0-9-]{8,64})\/refund$/);
  if (refundMatch && method === "POST") {
    const denied = adminGuard(env, request);
    if (denied) {
      return denied;
    }
    try {
      await ensureSchema(env);
      return await handleAdminRefund(env, refundMatch[1]);
    } catch (error) {
      console.error("admin refund failed", String((error && error.message) || error));
      return fail("DB_UNAVAILABLE", "Baza de date nu este disponibila.", 503);
    }
  }

  return fail("NOT_FOUND", "Ruta API nu exista.", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { allow: "GET, POST, OPTIONS", "cache-control": "no-store" }
        });
      }
      return routeApi(env, request, url);
    }

    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};
