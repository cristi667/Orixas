/* Panou admin: login, lista conturi, anulare cu rambursare, reincercare rambursare. */
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
  const paidCount = document.getElementById("adminPaid");

  if (!loginView || !panelView || !loginForm) {
    return;
  }

  const PAYMENT_LABELS = {
    paid: "platit",
    unpaid: "in asteptare",
    expired: "expirat",
    refunded: "rambursat",
    cancelled: "anulat"
  };

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

  function formatAmount(cents, currency) {
    if (cents == null) {
      return "-";
    }
    return (Number(cents) / 100).toFixed(2).replace(".", ",") + " " + String(currency || "EUR").toUpperCase();
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

  function refreshFounderCounters() {
    if (window.oriFounder && typeof window.oriFounder.refresh === "function") {
      window.oriFounder.refresh();
    }
  }

  function render() {
    const query = (searchInput.value || "").trim().toLowerCase();
    const withCancelled = showCancelled.checked;

    const rows = accounts.filter(function (account) {
      const inactive = account.status === "cancelled" || account.status === "expired" || account.status === "withdrawn";
      if (!withCancelled && inactive) {
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
      const inactive = account.status !== "reserved" && account.status !== "pending";
      const canCancel = !inactive;
      const canRefund = account.paymentStatus === "paid" && !canCancel;
      const paymentLabel = PAYMENT_LABELS[account.paymentStatus] || account.paymentStatus;

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
        (account.paymentStatus === "paid" ? "ok" : account.paymentStatus === "refunded" ? "warn" : "") +
        '">' +
        safe(paymentLabel) +
        "</span><br><span class=\"small mono\">" +
        formatAmount(account.amountCents, account.currency) +
        "</span></td><td><span class=\"tag " +
        (inactive ? "warn" : "ok") +
        '">' +
        safe(account.status) +
        "</span></td><td>" +
        formatDate(account.paidAt || account.createdAt) +
        '</td><td class="admin-actions">' +
        (canCancel
          ? '<button class="btn btn-cancel" type="button" data-cancel="' +
            safe(account.id) +
            '" data-seat="' +
            (account.seatNumber == null ? "" : safe(account.seatNumber)) +
            '" data-paid="' +
            (account.paymentStatus === "paid" ? "1" : "0") +
            '">Anuleaza locul</button>'
          : "") +
        (canRefund
          ? '<button class="btn" type="button" data-refund="' + safe(account.id) + '">Ramburseaza</button>'
          : "") +
        "</td>";
      tbody.appendChild(tr);
    });

    emptyNote.hidden = rows.length > 0;
    cancelledCount.textContent = String(
      accounts.filter(function (account) {
        return account.status === "cancelled" || account.status === "expired" || account.status === "withdrawn";
      }).length
    );
    if (paidCount) {
      paidCount.textContent = String(
        accounts.filter(function (account) {
          return account.paymentStatus === "paid";
        }).length
      );
    }
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
        "Panoul nu este configurat pe server: adauga secretul ADMIN_TOKEN in setarile site-ului, apoi reincarca.",
        "error"
      );
      setView(true);
      return;
    }

    if (!result.ok || !result.body) {
      showMessage("Nu am putut incarca lista de conturi. Incearca din nou.", "error");
      setView(true);
      return;
    }

    accounts = result.body.accounts || [];
    setView(true);
    render();
    refreshFounderCounters();
  }

  function confirmCancel(seatNumber, isPaid) {
    const base = "Anulezi locul " + (seatNumber ? "#" + seatNumber : "") + "?";
    const extra = isPaid
      ? " Avansul incasat va fi rambursat automat pe aceeasi metoda de plata."
      : "";
    return window.confirm(base + extra + " Locul devine imediat disponibil public.");
  }

  async function cancel(accountId, seatNumber, isPaid, button) {
    if (busy) {
      return;
    }
    if (!confirmCancel(seatNumber, isPaid)) {
      return;
    }

    busy = true;
    button.disabled = true;
    button.textContent = "Se anuleaza...";

    const result = await api("/api/admin/accounts/" + encodeURIComponent(accountId) + "/cancel", {
      method: "POST"
    });

    busy = false;

    if (result.ok) {
      const refund = result.body && result.body.refund;
      showMessage(
        "Locul " +
          (seatNumber ? "#" + seatNumber : "") +
          " a fost eliberat si este din nou disponibil public." +
          (refund && refund.ok && !refund.skipped && !refund.already
            ? " Rambursarea a fost initiata in Stripe."
            : refund && refund.ok === false
              ? " ATENTIE: rambursarea nu a reusit - foloseste butonul Ramburseaza."
              : ""),
        "success"
      );
      await load();
      return;
    }

    button.disabled = false;
    button.textContent = "Anuleaza locul";
    showMessage((result.body && result.body.message) || "Anularea nu a reusit. Incearca din nou.", "error");
  }

  async function refund(accountId, button) {
    if (busy) {
      return;
    }
    if (!window.confirm("Rambursezi avansul acestui cont pe aceeasi metoda de plata?")) {
      return;
    }

    busy = true;
    button.disabled = true;
    button.textContent = "Se ramburseaza...";

    const result = await api("/api/admin/accounts/" + encodeURIComponent(accountId) + "/refund", {
      method: "POST"
    });

    busy = false;

    if (result.ok) {
      showMessage("Rambursarea a fost initiata in Stripe.", "success");
      await load();
      return;
    }

    button.disabled = false;
    button.textContent = "Ramburseaza";
    showMessage((result.body && result.body.message) || "Rambursarea nu a reusit.", "error");
  }

  tbody.addEventListener("click", function (event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const cancelBtn = target.closest("button[data-cancel]");
    if (cancelBtn) {
      cancel(cancelBtn.dataset.cancel, cancelBtn.dataset.seat, cancelBtn.dataset.paid === "1", cancelBtn);
      return;
    }

    const refundBtn = target.closest("button[data-refund]");
    if (refundBtn) {
      refund(refundBtn.dataset.refund, refundBtn);
    }
  });

  loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    loginMessage.className = "message";
    loginMessage.textContent = "";

    const value = (tokenInput.value || "").trim();
    if (value.length < 8) {
      loginMessage.className = "message error";
      loginMessage.textContent = "Tokenul trebuie sa aiba cel putin 8 caractere.";
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
      loginMessage.textContent = "Autentificare reusita.";
      tokenInput.value = "";
      await load();
      return;
    }

    storeToken("");
    loginMessage.className = "message error";
    loginMessage.textContent =
      (result.body && result.body.message) || "Token invalid. Verifica valoarea configurata in site.";
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
