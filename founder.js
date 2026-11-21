/* Realtime founder seats: GET /api/founder + SSE /api/founder/stream */
(function () {
  const STREAM_URL = "/api/founder/stream";
  const STATE_URL = "/api/founder";
  const POLL_MS = 15000;

  const subscribers = [];
  let state = null;
  let source = null;
  let pollTimer = null;

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalize(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const total = Math.max(0, number(payload.total, 20));
    const taken = Math.max(0, Math.min(total, number(payload.taken, 0)));

    return {
      total: total,
      taken: taken,
      remaining: Math.max(0, total - taken),
      soldOut: taken >= total,
      depositCents: number(payload.depositCents, 5000),
      depositCurrency: payload.depositCurrency || "eur",
      updatedAt: payload.updatedAt || null
    };
  }

  function render() {
    if (!state) {
      return;
    }

    document.querySelectorAll("[data-founder-remaining]").forEach(function (el) {
      el.textContent = String(state.remaining);
    });

    document.querySelectorAll("[data-founder-taken]").forEach(function (el) {
      el.textContent = String(state.taken);
    });

    document.querySelectorAll("[data-founder-total]").forEach(function (el) {
      el.textContent = String(state.total);
    });

    document.querySelectorAll("[data-founder-meter]").forEach(function (el) {
      const pct = state.total ? Math.round((state.taken / state.total) * 100) : 0;
      el.style.width = pct + "%";
    });

    document.querySelectorAll("[data-founder-note]").forEach(function (el) {
      el.textContent = state.soldOut
        ? "Programul Founder Bundle este complet. Scrie-ne pentru lista de asteptare."
        : state.remaining + " din " + state.total + " locuri inca disponibile, actualizat in timp real.";
    });

    document.querySelectorAll("[data-founder-submit]").forEach(function (el) {
      if (state.soldOut) {
        el.disabled = true;
        el.textContent = "Programul Founder este complet";
      } else {
        el.disabled = false;
        el.textContent =
          "Plateste avansul de 50 EUR si rezerva unul dintre cele " + state.remaining + " locuri";
      }
    });

    document.body.dataset.founderState = state.soldOut ? "sold-out" : "open";

    subscribers.forEach(function (fn) {
      try {
        fn(state);
      } catch (error) {
        /* ignore subscriber errors */
      }
    });
  }

  function apply(payload) {
    const next = normalize(payload);
    if (!next) {
      return;
    }

    const changed = !state || state.remaining !== next.remaining || state.taken !== next.taken;
    state = next;
    render();

    if (changed) {
      document.querySelectorAll("[data-founder-live]").forEach(function (el) {
        el.classList.remove("bump");
        // restart CSS animation
        void el.offsetWidth;
        el.classList.add("bump");
      });
    }
  }

  async function refresh() {
    try {
      const response = await fetch(STATE_URL, {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      apply(await response.json());
      return state;
    } catch (error) {
      document.body.dataset.founderState = "offline";
      return null;
    }
  }

  function stopPolling() {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling() {
    if (pollTimer) {
      return;
    }
    pollTimer = window.setInterval(refresh, POLL_MS);
  }

  function connect() {
    if (typeof window.EventSource !== "function") {
      startPolling();
      return;
    }

    try {
      source = new window.EventSource(STREAM_URL);
    } catch (error) {
      startPolling();
      return;
    }

    source.addEventListener("founder", function (event) {
      stopPolling();
      try {
        apply(JSON.parse(event.data));
      } catch (error) {
        /* malformed frame, wait for the next one */
      }
    });

    source.addEventListener("error", function () {
      // EventSource reconnects by itself; keep the UI fresh meanwhile.
      startPolling();
    });

    window.addEventListener("pagehide", function () {
      if (source) {
        source.close();
        source = null;
      }
    });
  }

  async function reserve(account) {
    try {
      const response = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(account)
      });

      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }

      if (body && body.founder) {
        apply(body.founder);
      }

      return { ok: response.ok, status: response.status, body: body };
    } catch (error) {
      return { ok: false, status: 0, body: null, network: true };
    }
  }

  window.oriFounder = {
    refresh: refresh,
    reserve: reserve,
    getState: function () {
      return state;
    },
    subscribe: function (fn) {
      if (typeof fn === "function") {
        subscribers.push(fn);
        if (state) {
          fn(state);
        }
      }
    }
  };

  connect();
  refresh();
})();
