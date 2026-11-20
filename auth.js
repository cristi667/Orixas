(function () {
  const form = document.getElementById("signupForm");
  const message = document.getElementById("formMessage");

  if (!form || !message) {
    return;
  }

  function sanitize(value) {
    if (typeof window.oriSanitize === "function") {
      return window.oriSanitize(value);
    }
    return String(value).trim();
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  }

  function validName(name) {
    return /^[A-Za-z\u00C0-\u024F\u1E00-\u1EFF][A-Za-z0-9\u00C0-\u024F\u1E00-\u1EFF\s\-'.]{2,79}$/.test(name);
  }

  function validCui(cui) {
    return /^RO\d{6,10}$/.test(cui);
  }

  const submitButton = form.querySelector("button[type=submit]");
  if (submitButton) {
    submitButton.setAttribute("data-founder-submit", "");
  }

  function showError(text) {
    message.className = "message error";
    message.textContent = text;
  }

  function showSuccess(text) {
    message.className = "message success";
    message.textContent = text;
  }

  function fieldErrorFrom(body) {
    if (body && Array.isArray(body.details) && body.details.length) {
      return body.details[0].message;
    }
    return (body && body.message) || "Rezervarea nu a putut fi salvata. Incearca din nou.";
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    message.className = "message";
    message.textContent = "";

    const rawName = sanitize(form.name.value);
    const rawEmail = sanitize(form.email.value).toLowerCase();
    const rawCui = sanitize(form.cui.value).toUpperCase();
    const rawRole = sanitize(form.role.value);
    const consentLegal = form.consentLegal.checked;
    const consentMarketing = form.consentMarketing.checked;

    if (!validName(rawName)) {
      showError("Numele trebuie sa aiba intre 3 si 80 caractere si sa contina doar litere uzuale.");
      return;
    }

    if (!validEmail(rawEmail)) {
      showError("Email invalid. Verifica formatul adresei.");
      return;
    }

    if (!validCui(rawCui)) {
      showError("CUI invalid. Foloseste formatul RO urmat de 6-10 cifre (ex: RO41892014).");
      return;
    }

    if (rawRole !== "antreprenor" && rawRole !== "contabil") {
      showError("Selecteaza un rol valid.");
      return;
    }

    if (!consentLegal) {
      showError("Pentru crearea contului trebuie sa accepti Termenii si Politica de Confidentialitate.");
      return;
    }

    const payload = {
      name: rawName,
      email: rawEmail,
      cui: rawCui,
      role: rawRole,
      consentLegal: true,
      marketingConsent: consentMarketing
    };

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.dataset.previousLabel = submitButton.dataset.previousLabel || submitButton.textContent;
      submitButton.textContent = "Se rezerva locul...";
    }

    const founderApi = window.oriFounder;
    const result = founderApi && typeof founderApi.reserve === "function"
      ? await founderApi.reserve(payload)
      : { ok: false, status: 0, body: null, network: true };

    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = submitButton.dataset.previousLabel || "Rezerva un loc Founder";
    }

    if (result.ok && result.body && result.body.account) {
      const account = result.body.account;
      const founder = result.body.founder || {};

      try {
        sessionStorage.setItem(
          "orixasSignup",
          JSON.stringify({
            name: payload.name,
            email: payload.email,
            cui: payload.cui,
            role: payload.role,
            accountId: account.id,
            seatNumber: account.seatNumber,
            founderSeatsLeft: founder.remaining,
            createdAt: account.createdAt
          })
        );
      } catch (err) {
        /* continui chiar daca sessionStorage nu e disponibil */
      }

      showSuccess(
        "Cont creat. Locul Founder #" +
          account.seatNumber +
          " este rezervat pe numele " +
          payload.email +
          ". Au ramas " +
          (typeof founder.remaining === "number" ? founder.remaining : "?") +
          " locuri. Te redirectionam in platforma..."
      );

      setTimeout(function () {
        window.location.href = "app.html";
      }, 1200);
      return;
    }

    if (result.network) {
      // Backend-ul nu raspunde: pastram rezervarea local, ca sa nu pierdem datele introduse.
      try {
        sessionStorage.setItem(
          "orixasSignup",
          JSON.stringify({
            name: payload.name,
            email: payload.email,
            cui: payload.cui,
            role: payload.role,
            pendingSync: true,
            createdAt: new Date().toISOString()
          })
        );
      } catch (err) {
        /* ignore */
      }

      showError(
        "Serverul de rezervari nu este disponibil. Datele au fost salvate local in acest browser; reincearca dupa ce backend-ul este pornit."
      );
      return;
    }

    if (result.body && result.body.error === "EMAIL_EXISTS") {
      showError("Exista deja un cont cu aceasta adresa de email. Foloseste adresa contului existent sau scrie-ne.");
      return;
    }

    if (result.body && result.body.error === "SOLD_OUT") {
      showError("Toate cele 20 de locuri Founder Bundle sunt rezervate. Lasa-ne emailul pentru lista de asteptare.");
      return;
    }

    showError(fieldErrorFrom(result.body));
  });
})();
