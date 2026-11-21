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
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .trim();
  };

  /*
   * Site-ul nu foloseste cookie-uri de analiza sau de marketing, doar stocare locala
   * strict necesara, deci nu este afisat un banner de consimtamant.
   * Detalii: cookies.html
   */
})();
