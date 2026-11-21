/*
 * Datele de identificare ale comerciantului + informatiile legale recurente.
 * COMPLETEAZA valorile de mai jos cu datele reale ale firmei inainte de lansarea comerciala.
 */
(function () {
  const LEGAL = {
    version: "2026-11-21",
    updated: "21 noiembrie 2026",
    companyName: "«Denumirea comerciantului»",
    legalForm: "«Forma juridica (SRL / PFA / II)»",
    cui: "«CUI»",
    regCom: "«Numar Registrul Comertului»",
    address: "«Sediul social complet»",
    email: "contact@orixas.app",
    phone: "«Telefon»",
    capital: "«Capital social»",
    vat: "«Regim TVA (platitor / neplatitor)»",
    deposit: "50 EUR",
    price: "100 EUR/luna",
    withdrawalDays: "14 zile",
    anpc: "https://anpc.ro",
    sal: "https://reclamatiisal.anpc.ro",
    salInfo: "https://anpc.ro/ce-este-sal/"
  };

  window.ORIXAS_LEGAL = LEGAL;

  function fill() {
    document.querySelectorAll("[data-legal]").forEach(function (el) {
      const key = el.getAttribute("data-legal");
      if (key && LEGAL[key]) {
        el.textContent = LEGAL[key];
      }
    });

    document.querySelectorAll("[data-legal-href]").forEach(function (el) {
      const key = el.getAttribute("data-legal-href");
      if (key === "email") {
        el.setAttribute("href", "mailto:" + LEGAL.email);
      } else if (key === "phone" && LEGAL.phone && LEGAL.phone.indexOf("«") === -1) {
        el.setAttribute("href", "tel:" + LEGAL.phone.replace(/\s+/g, ""));
      }
    });

    document.querySelectorAll("[data-legal-version]").forEach(function (el) {
      el.textContent = LEGAL.updated;
    });
  }

  function addFooterLinks() {
    document.querySelectorAll(".footer-links").forEach(function (nav) {
      if (nav.querySelector("[data-withdraw-link]")) {
        return;
      }
      const withdraw = document.createElement("a");
      withdraw.href = "retragere.html";
      withdraw.textContent = "Retrageti-va din contract aici";
      withdraw.setAttribute("data-withdraw-link", "");
      nav.appendChild(withdraw);
    });
  }

  function addLegalBar() {
    document.querySelectorAll(".site-footer").forEach(function (footer) {
      if (footer.querySelector(".legal-bar")) {
        return;
      }
      const bar = document.createElement("div");
      bar.className = "legal-bar";
      bar.innerHTML =
        '<p class="small">' +
        '<strong data-legal="companyName"></strong> · <span data-legal="legalForm"></span> · ' +
        'CUI <span data-legal="cui"></span> · Reg. Com. <span data-legal="regCom"></span> · ' +
        '<span data-legal="address"></span> · <a data-legal-href="email" href="mailto:contact@orixas.app"><span data-legal="email"></span></a>' +
        "</p>" +
        '<p class="small">' +
        '<a href="' + LEGAL.anpc + '" target="_blank" rel="noopener">ANPC</a> · ' +
        '<a href="' + LEGAL.sal + '" target="_blank" rel="noopener">SAL - Solutionarea Alternativa a Litigiilor</a> · ' +
        '<a href="' + LEGAL.salInfo + '" target="_blank" rel="noopener">Ce este SAL</a> · ' +
        '<a href="terms.html">Termeni si conditii</a> · ' +
        '<a href="privacy.html">Confidentialitate</a> · ' +
        '<a href="cookies.html">Cookie-uri</a> · ' +
        '<a href="retragere.html">Retragere din contract</a>' +
        "</p>";
      footer.appendChild(bar);
    });
  }

  function init() {
    fill();
    addFooterLinks();
    addLegalBar();
    fill();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
