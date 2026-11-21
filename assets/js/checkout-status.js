/* Pagina de dupa plata: GET /api/checkout/status?session_id=... */
(function () {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session_id") || "";
  const accountId = params.get("account") || "";

  const statusEl = document.getElementById("reservationStatus");
  const titleEl = document.getElementById("reservationTitle");
  const detailEl = document.getElementById("reservationDetail");
  const actionsEl = document.getElementById("reservationActions");

  if (!statusEl || !titleEl) {
    return;
  }

  let attempts = 0;
  let timer = null;

  function setState(kind, title, detail) {
    titleEl.textContent = title;
    if (detailEl) {
      detailEl.textContent = detail || "";
    }
    document.body.dataset.reservationState = kind;
  }

  function formatAmount(cents, currency) {
    const value = (Number(cents) || 0) / 100;
    return value.toFixed(2).replace(".", ",") + " " + (currency || "EUR").toUpperCase();
  }

  function stop() {
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  async function poll() {
    attempts += 1;

    try {
      const query = new URLSearchParams();
      if (sessionId) query.set("session_id", sessionId);
      if (accountId) query.set("account", accountId);

      const response = await fetch("/api/checkout/status?" + query.toString(), {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      const body = await response.json().catch(function () {
        return null;
      });

      if (response.ok && body && body.paid) {
        stop();
        setState(
          "paid",
          "Locul #" + body.seatNumber + " este confirmat",
          "Am incasat avansul de " +
            formatAmount(body.amountCents, body.currency) +
            ", deductibil integral din prima factura lunara. Confirmarea si factura ajung pe emailul tau."
        );
        if (actionsEl) {
          actionsEl.innerHTML =
            '<a class="btn btn-primary" href="app.html">Intra in platforma</a>' +
            '<a class="btn" href="retragere.html">Retrage-te din contract</a>';
        }
        return;
      }

      if (response.ok && body && (body.paymentStatus === "expired" || body.status === "expired")) {
        stop();
        setState(
          "expired",
          "Rezervarea a expirat",
          "Nu am primit plata in cele 35 de minute, asa ca locul a fost eliberat. Poti relua rezervarea."
        );
        if (actionsEl) {
          actionsEl.innerHTML = '<a class="btn btn-primary" href="auth.html">Reia rezervarea</a>';
        }
        return;
      }

      if (response.status === 404) {
        stop();
        setState("unknown", "Nu am gasit rezervarea", "Verifica linkul din email sau scrie-ne la adresa de contact.");
        return;
      }

      setState(
        "pending",
        "Asteptam confirmarea platii",
        "Procesatorul de plati poate intarzia cateva secunde. Nu inchide pagina."
      );
    } catch (error) {
      setState("pending", "Verificam plata...", "Conexiunea a fost intrerupta temporar, reincercam.");
    }

    if (attempts >= 40) {
      stop();
      setState(
        "pending",
        "Plata este inca in procesare",
        "Daca ai finalizat plata, locul se activeaza automat. Poti verifica mai tarziu sau scrie-ne la adresa de contact."
      );
      return;
    }

    timer = window.setTimeout(poll, attempts < 10 ? 2000 : 4000);
  }

  if (!sessionId && !accountId) {
    setState("unknown", "Lipseste linkul de plata", "Deschide linkul primit dupa plata sau contacteaza-ne.");
    return;
  }

  poll();

  window.addEventListener("pagehide", stop);
})();
