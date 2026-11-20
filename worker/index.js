/**
 * Orixas backend (Cloudflare Worker + D1).
 *
 * Endpoints:
 *   GET  /api/founder                 -> starea curenta a locurilor Founder
 *   GET  /api/founder/stream          -> Server-Sent Events, emite starea la fiecare schimbare
 *   POST /api/accounts                -> creeaza contul si rezerva atomic un loc Founder
 *   GET  /api/accounts/:id            -> datele publice ale unui cont (fara email complet)
 *
 * Orice alta ruta este servita din assets (site-ul static).
 */

const DEFAULT_TOTAL_SEATS = 20;
const SEAT_RETRIES = 3;
const STREAM_INTERVAL_MS = 4000;

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

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

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

  const push = async function (eventName, data) {
    const payload = "event: " + eventName + "\ndata: " + JSON.stringify(data) + "\n\n";
    await writer.write(encoder.encode(payload));
  };

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
          await push("founder", state);
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
  const message = String((error && error.message) || "");
  return message.indexOf("accounts.email") !== -1;
}

function isUniqueSeatError(error) {
  const message = String((error && error.message) || "");
  return message.indexOf("accounts.seat_number") !== -1;
}

async function insertAccount(env, data) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const statement = env.DB.prepare(
    `INSERT INTO accounts (id, name, email, cui, role, marketing_consent, status, seat_number, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'reserved', (SELECT COUNT(*) + 1 FROM accounts), ?7
     WHERE (SELECT COUNT(*) FROM accounts) <
           COALESCE((SELECT total_seats FROM founder_config WHERE id = 1), ?8)
     RETURNING id, seat_number, created_at`
  ).bind(id, data.name, data.email, data.cui, data.role, data.marketingConsent, now, DEFAULT_TOTAL_SEATS);

  const result = await statement.all();
  const row = result && result.results && result.results[0];
  return row || null;
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
      created = await insertAccount(env, validation.data);
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

  await env.DB.prepare(
    "INSERT INTO founder_events (seat_number, kind, created_at) VALUES (?1, 'reserved', ?2)"
  )
    .bind(created.seat_number, created.created_at)
    .run()
    .catch(function () {
      /* audit trail is best-effort */
    });

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
