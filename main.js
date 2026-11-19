(function () {
  function byId(id) {
    return document.getElementById(id);
  }

  const navToggle = byId("navToggle");
  const navLinks = byId("navLinks");

  if (navToggle && navLinks) {
    navToggle.addEventListener("click", function () {
      const open = navLinks.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", String(open));
    });

    navLinks.addEventListener("click", function (event) {
      const target = event.target;
      if (target instanceof HTMLElement && target.classList.contains("nav-link")) {
        navLinks.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  function normalizePath(pathname) {
    const cleaned = pathname.replace(/\\+/g, "/");
    return cleaned.substring(cleaned.lastIndexOf("/") + 1) || "index.html";
  }

  const current = normalizePath(window.location.pathname);
  document.querySelectorAll(".nav-link[data-page]").forEach(function (link) {
    if (!(link instanceof HTMLElement)) {
      return;
    }

    if (link.dataset.page === current) {
      link.classList.add("active");
      link.setAttribute("aria-current", "page");
    }
  });

  window.oriSanitize = function (value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .trim();
  };

  function createCookieBanner() {
    const banner = document.createElement("section");
    banner.className = "cookie-banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-live", "polite");
    banner.innerHTML =
      '<div class="cookie-row">' +
      '<p class="cookie-text">Folosim doar cookie-uri strict necesare pentru funcționare și, opțional, analytics anonimizat. Poți alege acum. Vezi și <a href="cookies.html">Politica de Cookie-uri</a>.</p>' +
      '<div class="actions" style="margin-top:0">' +
      '<button id="rejectCookiesBtn" class="btn" type="button">Respinge opționale</button>' +
      '<button id="acceptCookiesBtn" class="btn btn-primary" type="button">Acceptă toate</button>' +
      "</div></div>";

    return banner;
  }

  function setCookieChoice(choice) {
    const payload = {
      choice: choice,
      at: new Date().toISOString()
    };
    localStorage.setItem("orixasCookieConsent", JSON.stringify(payload));
  }

  function initCookieConsent() {
    let consent = null;
    try {
      consent = localStorage.getItem("orixasCookieConsent");
    } catch (err) {
      consent = null;
    }

    if (consent) {
      return;
    }

    const banner = createCookieBanner();
    document.body.appendChild(banner);

    const acceptBtn = byId("acceptCookiesBtn");
    const rejectBtn = byId("rejectCookiesBtn");
    if (acceptBtn) {
      acceptBtn.addEventListener("click", function () {
        setCookieChoice("all");
        banner.remove();
      });
    }

    if (rejectBtn) {
      rejectBtn.addEventListener("click", function () {
        setCookieChoice("necessary_only");
        banner.remove();
      });
    }
  }

  initCookieConsent();
})();
