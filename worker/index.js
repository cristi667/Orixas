/**
 * Orixas backend (Cloudflare Worker + D1).
 *
 * Public:
 *   GET  /api/founder                 -> starea curenta a locurilor Founder
 *   GET  /api/founder/stream          -> Server-Sent Events, emite starea la fiecare schimbare
 *   POST /api/accounts                -> creeaza contul si rezerva atomic un loc Founder
 *   GET  /api/accounts/:id            -> datele publice ale unui cont (fara email complet)
 *
 * Administrare (necesita header `Authorization: Bearer <ADMIN_TOKEN>`):
 *   POST /api/admin/login             -> verifica tokenul
 *   GET  /api/admin/accounts          -> lista conturilor + statistici
 *   POST /api/admin/accounts/:id/cancel -> anuleaza rezervarea si elibereaza locul
 *
 * Orice alta ruta este servita din assets (site-ul static).
 */

const DEFAULT_TOTAL_SEATS = 20;
const SEAT_RETRIES = 3;
const STREAM_INTERVAL_MS = 4000;
const ADMIN_SEARCH_LIMIT = 500;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 12;

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
     created_at TEXT NOT NULL
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
   )`
];

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

  const pending = env.DB.batch(
    SCHEMA_STATEMENTS.map(function (sql) {
      return env.DB.prepare(sql);
    }).concat([
      env.DB.prepare(
        "INSERT INTO founder_config (id, total_seats) VALUES (1, ?1) ON CONFLICT (id) DO NOTHING"
      ).bind(DEFAULT_TOTAL_SEATS)
    ])
  ).catch(function (error) {
    schemaReady.delete(env);
    throw error;
  });

  schemaReady.set(env, pending);
  return pending;
}

/* -------------------------------------------------------------------- state */

async function readFounderState(env) {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE((SELECT total_seats FROM founder_config WHERE id = 1), ?1) AS total,
       (SELECT COUNT(*) FROM accounts WHERE seat_number IS NOT NULL) AS taken,
       (SELECT MAX(created_at) FROM accounts WHERE seat_number IS NOT NULL) AS lastChange`
  )
    .bind(DEFAULT_TOTAL_SEATS)
    .first();

  const total = Math.max(0, Number(row && row.total) || DEFAULT_TOTAL_SEATS);
  const taken = Math.max(0, Math.min(total, Number(row && row.taken) || 0));

  return {
    total: total,
    taken: taken,
    remaining: Math.max(0, total - taken),
    soldOut: taken >= total,
    lastChange: (row && row.lastChange) || null,
    updatedAt: new Date().toISOString()
  };
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
    errors.push({ field: "consentLegal", message: "Este necesar acordul pentru Termeni si Confidentialitate." });
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
 * Rezerva atomic primul loc liber (1..total). Locurile eliberate de anulari
 * sunt reutilizate, deci `remaining` si numerotarea raman coerente.
 */
function insertAccount(env, data) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  return env.DB.prepare(
    `WITH RECURSIVE seq(n) AS (
       SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?8
     ),
     taken AS (
       SELECT seat_number FROM accounts WHERE seat_number IS NOT NULL
     ),
     free_seat AS (
       SELECT MIN(n) AS seat FROM seq WHERE n NOT IN (SELECT seat_number FROM taken)
     )
     INSERT INTO accounts (id, name, email, cui, role, marketing_consent, status, seat_number, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'reserved', (SELECT seat FROM free_seat), ?7
     WHERE (SELECT seat FROM free_seat) IS NOT NULL
       AND (SELECT COUNT(*) FROM taken) < ?8
     RETURNING id, seat_number, created_at`
  )
    .bind(id, data.name, data.email, data.cui, data.role, data.marketingConsent, now, DEFAULT_TOTAL_SEATS)
    .all();
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

  await ensureSchema(env);

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
    return fail("SOLD_OUT", "Toate locurile Founder Bundle au fost rezervate.", 409, state);
  }

  await logFounderEvent(env, created.seat_number, "reserved");

  const state = await readFounderState(env);

  return jsonResponse(
    {
      ok: true,
      account: {
        id: created.id,
        seatNumber: created.seat_number,
        createdAt: created.created_at,
        name: validation.data.name,
        cui: validation.data.cui,
        role: validation.data.role
      },
      founder: state
    },
    201
  );
}

async function handleGetAccount(env, id) {
  const row = await env.DB.prepare(
    "SELECT id, name, cui, role, seat_number, status, created_at FROM accounts WHERE id = ?1"
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
      createdAt: row.created_at
    }
  });
}

function logFounderEvent(env, seatNumber, kind) {
  return env.DB.prepare(
    "INSERT INTO founder_events (seat_number, kind, created_at) VALUES (?1, ?2, ?3)"
  )
    .bind(seatNumber, kind, new Date().toISOString())
    .run()
    .catch(function () {
      /* audit trail is best-effort */
    });
}

/* -------------------------------------------------------------------- admin */

const loginAttempts = new Map();

function loginKey(request) {
  return request.headers.get("cf-connecting-ip") || "local";
}

function loginBlocked(key) {
  const entry = loginAttempts.get(key);
  if (!entry) {
    return false;
  }
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function registerLoginFailure(key) {
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { first: Date.now(), count: 1 });
    return;
  }
  entry.count += 1;
}

function adminGuard(env, request) {
  const expected = env && env.ADMIN_TOKEN;
  if (!expected) {
    return fail(
      "ADMIN_NOT_CONFIGURED",
      "Panoul de administrare nu are token configurat. Adauga secretul ADMIN_TOKEN pentru acest site.",
      503
    );
  }

  if (loginBlocked(loginKey(request))) {
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

  const key = loginKey(request);
  if (loginBlocked(key)) {
    return fail("TOO_MANY_ATTEMPTS", "Prea multe incercari. Reincearca peste cateva minute.", 429);
  }

  const body = await readJson(request);
  const provided = clean(body && body.token);

  if (!provided || !tokensMatch(provided, env.ADMIN_TOKEN)) {
    registerLoginFailure(key);
    return fail("UNAUTHORIZED", "Token invalid.", 401);
  }

  loginAttempts.delete(key);
  await ensureSchema(env);
  return jsonResponse({ ok: true, founder: await readFounderState(env) });
}

async function handleAdminAccounts(env, url) {
  const search = clean(url.searchParams.get("q")).toLowerCase();

  const rows = await env.DB.prepare(
    `SELECT id, name, email, cui, role, marketing_consent, status, seat_number, created_at
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
        createdAt: row.created_at
      };
    });

  const founder = await readFounderState(env);
  const cancelled = accounts.filter(function (account) {
    return account.status === "cancelled";
  }).length;

  return jsonResponse({
    ok: true,
    founder: founder,
    stats: {
      reserved: accounts.length - cancelled,
      cancelled: cancelled,
      totalAccounts: accounts.length
    },
    accounts: accounts
  });
}

async function handleAdminCancel(env, id) {
  const account = await env.DB.prepare(
    "SELECT id, name, email, seat_number, status FROM accounts WHERE id = ?1"
  )
    .bind(id)
    .first();

  if (!account) {
    return fail("NOT_FOUND", "Contul nu exista.", 404);
  }

  if (account.status !== "reserved" || account.seat_number === null) {
    return fail("ALREADY_CANCELLED", "Aceasta rezervare este deja anulata.", 409);
  }

  await env.DB.prepare(
    "UPDATE accounts SET status = 'cancelled', seat_number = NULL WHERE id = ?1 AND status = 'reserved'"
  )
    .bind(id)
    .run();

  await logFounderEvent(env, account.seat_number, "cancelled");

  return jsonResponse({
    ok: true,
    cancelled: {
      id: account.id,
      name: account.name,
      email: account.email,
      seatNumber: account.seat_number
    },
    founder: await readFounderState(env)
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
      console.error("create-account failed", error);
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
      console.error("admin list failed", error);
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
      console.error("admin cancel failed", error);
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
          headers: { "allow": "GET, POST, OPTIONS", "cache-control": "no-store" }
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
