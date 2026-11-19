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
    return /^[A-Za-zA-Za-z\u00C0-\u017F\s\-'.]{3,80}$/.test(name);
  }

  function validCui(cui) {
    return /^RO\d{6,10}$/.test(cui);
  }

  form.addEventListener("submit", function (event) {
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
      message.textContent = "Numele trebuie să aibă între 3 și 80 caractere și să conțină doar litere uzuale.";
      message.classList.add("error");
      return;
    }

    if (!validEmail(rawEmail)) {
      message.textContent = "Email invalid. Verifică formatul adresei.";
      message.classList.add("error");
      return;
    }

    if (!validCui(rawCui)) {
      message.textContent = "CUI invalid. Folosește formatul RO urmat de 6-10 cifre (ex: RO41892014).";
      message.classList.add("error");
      return;
    }

    if (rawRole !== "antreprenor" && rawRole !== "contabil") {
      message.textContent = "Selectează un rol valid.";
      message.classList.add("error");
      return;
    }

    if (!consentLegal) {
      message.textContent = "Pentru crearea contului trebuie să accepți Termenii și Politica de Confidențialitate.";
      message.classList.add("error");
      return;
    }

    const payload = {
      name: rawName,
      email: rawEmail,
      cui: rawCui,
      role: rawRole,
      consentLegalAt: new Date().toISOString(),
      consentMarketing: consentMarketing,
      founderSeatRequestedAt: new Date().toISOString()
    };

    try {
      sessionStorage.setItem("orixasSignup", JSON.stringify(payload));
    } catch (err) {
      message.textContent = "Datele nu au putut fi salvate local. Continuă direct în demo.";
      message.classList.add("error");
      return;
    }

    message.textContent = "Loc Founder rezervat. Te redirecționăm în platformă...";
    message.classList.add("success");

    setTimeout(function () {
      window.location.href = "app.html";
    }, 850);
  });
})();
