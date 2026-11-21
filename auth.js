(function () {
  const form = document.getElementById("signupForm");
  const message = document.getElementById("formMessage");

  if (!form || !message) {
    return;
  }

  const DEPOSIT_LABEL = "50 €";

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

  function showInfo(text) {
    message.className = "message";
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

  /* Mesaj pentru plata anulata, la intoarcerea din Stripe. */
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("anulat") === "1") {
      showInfo(
        "Plata a fost anulata, deci locul nu a fost rezervat si nu ai fost taxat. Poti relua rezervarea oricand."
      );
    }
  } catch (error) {
    /* fara URLSearchParams nu afisam nimic */
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
      showError(
        "Pentru rezervare trebuie sa accepti Termenii, Politica de confidentialitate si informarea privind dreptul de retragere."
      );
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
      submitButton.textContent = "Se pregateste plata...";
    }

    try {
      sessionStorage.setItem(
        "orixasSignup",
        JSON.stringify({
          name: payload.name,
          email: payload.email,
          cui: payload.cui,
          role: payload.role,
          createdAt: new Date().toISOString()
        })
      );
    } catch (err) {
      /* fara sessionStorage continuam oricum */
    }

    const result = await window.oriFounder.reserve(payload);

    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = submitButton.dataset.previousLabel || "Rezerva un loc Founder";
    }

    if (result.ok && result.body && result.body.checkoutUrl) {
      showSuccess(
        "Locul " +
          (result.body.account && result.body.account.seatNumber ? "#" + result.body.account.seatNumber + " " : "") +
          "este tinut rezervat 35 de minute. Te redirectionam catre plata securizata a avansului de " +
          DEPOSIT_LABEL +
          "..."
      );
      window.location.href = result.body.checkoutUrl;
      return;
    }

    if (result.ok && result.body && result.body.account) {
      showSuccess("Rezervarea exista deja. Reincarca pagina sau scrie-ne la adresa de contact.");
      return;
    }

    if (result.network) {
      showError(
        "Serverul de rezervari nu este disponibil. Incearca din nou in cateva momente."
      );
      return;
    }

    if (result.body && result.body.error === "EMAIL_EXISTS") {
      showError(
        "Exista deja un loc platit cu aceasta adresa de email. Scrie-ne daca vrei sa modifici datele contului."
      );
      return;
    }

    if (result.body && result.body.error === "SOLD_OUT") {
      showError("Toate cele 20 de locuri Founder Bundle sunt rezervate. Lasa-ne emailul pentru lista de asteptare.");
      return;
    }

    if (result.body && result.body.error === "PAYMENTS_NOT_CONFIGURED") {
      showError(
        "Plata avansului nu este inca activa pe acest site. Rezervarile se deschid imediat ce procesatorul de plati este configurat."
      );
      return;
    }

    showError(fieldErrorFrom(result.body));
  });
})();
