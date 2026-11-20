/* Panou admin: POST /api/admin/login, GET /api/admin/accounts, POST /api/admin/accounts/:id/cancel */
(function () {
  const TOKEN_KEY = "orixasAdminToken";

  const loginView = document.getElementById("adminLogin");
  const panelView = document.getElementById("adminPanel");
  const loginForm = document.getElementById("adminLoginForm");
  const loginMessage = document.getElementById("adminLoginMessage");
  const tokenInput = document.getElementById("adminToken");
  const logoutBtn = document.getElementById("adminLogout");
  const refreshBtn = document.getElementById("adminRefresh");
  const searchInput = document.getElementById("adminSearch");
  const showCancelled = document.getElementById("adminShowCancelled");
  const tbody = document.getElementById("adminTbody");
  const emptyNote = document.getElementById("adminEmpty");
  const message = document.getElementById("adminMessage");
  const cancelledCount = document.getElementById("adminCancelled");

  if (!loginView || !panelView || !loginForm) {
    return;
  }

  let token = "";
  let accounts = [];
  let busy = false;

  function safe(text) {
    if (typeof window.oriSanitize === "function") {
      return window.oriSanitize(text);
    }
    return String(text == null ? "" : text);
  }

  function readToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function storeToken(value) {
    token = value;
    try {
      if (value) {
        sessionStorage.setItem(TOKEN_KEY, value);
      } else {
        sessionStorage.removeItem(TOKEN_KEY);
      }
    } catch (error) {
      /* fara sessionStorage ramane tokenul doar in memorie */
    }
  }

  function showMessage(text, kind) {
    message.className = "message" + (kind ? " " + kind : "");
    message.textContent = text || "";
  }

  function setView(authenticated) {
    loginView.hidden = authenticated;
    panelView.hidden = !authenticated;
  }

  function formatDate(value) {
    if (!value) {
      return "-";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return safe(value);
    }
    return date.toLocaleString("ro-RO", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  async function api(path, options) {
    const settings = Object.assign({ method: "GET" }, options || {});
    settings.headers = Object.assign(
      {
        authorization: "Bearer " + token,
        accept: "application/json"
      },
      (options && options.headers) || {}
    );

    const response = await fetch(path, settings);
    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      body = null;
    }
    return { ok: response.ok, status: response.status, body: body };
  }

  function applyFounderState(state) {
    if (!state || typeof window.oriFounder === "undefined") {
      return;
    }
    // founder.js isi actualizeaza propriii observablei; aici doar fortam re-renderul contorului
    if (typeof window.oriFounder.refresh === "function") {
      window.oriFounder.refresh();
    }
  }

  function render() {
    const query = (searchInput.value || "").trim().toLowerCase();
    const withCancelled = showCancelled.checked;

    const rows = accounts.filter(function (account) {
      if (!withCancelled && account.status === "cancelled") {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        String(account.name).toLowerCase().indexOf(query) !== -1 ||
        String(account.email).toLowerCase().indexOf(query) !== -1 ||
        String(account.cui).toLowerCase().indexOf(query) !== -1
      );
    });

    tbody.innerHTML = "";
    rows.forEach(function (account) {
      const tr = document.createElement("tr");
      const isCancelled = account.status === "cancelled";
      tr.innerHTML =
        '<td class="mono">' +
        (account.seatNumber == null ? "-" : "#" + safe(account.seatNumber)) +
        "</td><td>" +
        safe(account.name) +
        '</td><td class="mono">' +
        safe(account.email) +
        '</td><td class="mono">' +
        safe(account.cui) +
        "</td><td>" +
        safe(account.role) +
        '</td><td><span class="tag ' +
        (isCancelled ? "warn" : "ok") +
        '">' +
        (isCancelled ? "anulat" : "rezervat") +
        "</span></td><td>" +
        formatDate(account.createdAt) +
        '</td><td><button class="btn btn-cancel" type="button" data-cancel="' +
        safe(account.id) +
        '" data-seat="' +
        (account.seatNumber == null ? "" : safe(account.seatNumber)) +
        '"' +
        (isCancelled ? " disabled" : "") +
        ">" +
        (isCancelled ? "eliberat" : "Anulează locul") +
        "</button></td>";
      tbody.appendChild(tr);
    });

    emptyNote.hidden = rows.length > 0;
    cancelledCount.textContent = String(
      accounts.filter(function (account) {
        return account.status === "cancelled";
      }).length
    );
  }

  async function load() {
    if (!token) {
      setView(false);
      return;
    }

    const result = await api("/api/admin/accounts");

    if (result.status === 401) {
      storeToken("");
      setView(false);
      loginMessage.className = "message error";
      loginMessage.textContent = "Sesiunea a expirat. Introdu din nou tokenul.";
      return;
    }

    if (result.status === 503) {
      showMessage(
        "Panoul nu este configurat pe server: adaugă secretul ADMIN_TOKEN în setările site-ului, apoi reîncarcă.",
        "error"
      );
      setView(true);
      return;
    }

    if (!result.ok || !result.body) {
      showMessage("Nu am putut încărca lista de conturi. Încearcă din nou.", "error");
      setView(true);
      return;
    }

    accounts = result.body.accounts || [];
    setView(true);
    render();
    applyFounderState(result.body.founder);
  }

  async function cancel(accountId, seatNumber, button) {
    if (busy) {
      return;
    }
    busy = true;
    button.disabled = true;
    button.textContent = "Se anulează...";

    const result = await api("/api/admin/accounts/" + encodeURIComponent(accountId) + "/cancel", {
      method: "POST"
    });

    busy = false;

    if (result.ok) {
      showMessage(
        "Locul " + (seatNumber ? "#" + seatNumber : "") + " a fost eliberat și este din nou disponibil public.",
        "success"
      );
      await load();
      return;
    }

    button.disabled = false;
    button.textContent = "Anulează locul";
    showMessage(
      (result.body && result.body.message) || "Anularea nu a reușit. Încearcă din nou.",
      "error"
    );
  }

  tbody.addEventListener("click", function (event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest("button[data-cancel]");
    if (!button) {
      return;
    }
    const seat = button.dataset.seat;
    cancel(button.dataset.cancel, seat, button);
  });

  loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    loginMessage.className = "message";
    loginMessage.textContent = "";

    const value = (tokenInput.value || "").trim();
    if (value.length < 8) {
      loginMessage.className = "message error";
      loginMessage.textContent = "Tokenul trebuie să aibă cel puțin 8 caractere.";
      return;
    }

    storeToken(value);
    const result = await api("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: value })
    });

    if (result.ok) {
      loginMessage.className = "message success";
      loginMessage.textContent = "Autentificare reușită.";
      tokenInput.value = "";
      await load();
      return;
    }

    storeToken("");
    loginMessage.className = "message error";
    loginMessage.textContent =
      (result.body && result.body.message) || "Token invalid. Verifică valoarea configurată în site.";
  });

  logoutBtn.addEventListener("click", function () {
    storeToken("");
    accounts = [];
    showMessage("");
    setView(false);
    loginMessage.className = "message";
    loginMessage.textContent = "";
  });

  refreshBtn.addEventListener("click", function () {
    load();
  });

  searchInput.addEventListener("input", render);
  showCancelled.addEventListener("change", render);

  token = readToken();
  if (token) {
    load();
  } else {
    setView(false);
  }
})();
