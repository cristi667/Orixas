/* Declaratie online de retragere din contract (OUG 18/2026): doi pasi + confirmare. */
(function () {
  const form = document.getElementById("withdrawForm");
  const summary = document.getElementById("withdrawSummary");
  const confirmBox = document.getElementById("withdrawConfirmBox");
  const confirmButton = document.getElementById("withdrawConfirm");
  const backButton = document.getElementById("withdrawBack");
  const message = document.getElementById("withdrawMessage");
  const result = document.getElementById("withdrawResult");

  if (!form || !summary || !confirmBox || !confirmButton) {
    return;
  }

  let draft = null;

  function showMessage(text, kind) {
    message.className = "message" + (kind ? " " + kind : "");
    message.textContent = text || "";
  }

  function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
  }

  function readForm() {
    return {
      name: (form.name.value || "").trim().slice(0, 80),
      email: (form.email.value || "").trim().toLowerCase().slice(0, 120),
      accountId: (form.accountId.value || "").trim(),
      reason: (form.reason.value || "").trim().slice(0, 500)
    };
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    showMessage("");

    const data = readForm();

    if (!validEmail(data.email)) {
      showMessage("Adresa de email nu este valida.", "error");
      return;
    }

    if (!/^[A-Za-z0-9-]{8,64}$/.test(data.accountId)) {
      showMessage(
        "Codul contractului nu este valid. Il gasesti in confirmarea de plata, in linkul din pagina de rezervare sau in emailul primit.",
        "error"
      );
      return;
    }

    draft = data;

    summary.innerHTML =
      "<dt>Nume</dt><dd>" + data.name + "</dd>" +
      "<dt>Email</dt><dd>" + data.email + "</dd>" +
      "<dt>Cod contract</dt><dd class=\"mono\">" + data.accountId + "</dd>" +
      "<dt>Motiv (optional)</dt><dd>" + (data.reason || "-") + "</dd>";

    form.hidden = true;
    confirmBox.hidden = false;
    confirmButton.focus();
  });

  if (backButton) {
    backButton.addEventListener("click", function () {
      confirmBox.hidden = true;
      form.hidden = false;
      showMessage("");
    });
  }

  confirmButton.addEventListener("click", async function () {
    if (!draft) {
      return;
    }

    confirmButton.disabled = true;
    confirmButton.textContent = "Se trimite...";
    showMessage("");

    try {
      const response = await fetch("/api/withdrawals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          email: draft.email,
          accountId: draft.accountId,
          reason: draft.reason,
          confirmed: true
        })
      });

      const body = await response.json().catch(function () {
        return null;
      });

      if (response.ok && body && body.ok) {
        confirmBox.hidden = true;
        if (result) {
          result.hidden = false;
          result.innerHTML =
            "<h3>Retragerea a fost inregistrata</h3>" +
            "<p class=\"text-muted\">Numar de referinta: <strong class=\"mono\">" + body.reference + "</strong></p>" +
            "<p class=\"text-muted\">Data si ora: " +
            new Date(body.requestedAt).toLocaleString("ro-RO", { dateStyle: "long", timeStyle: "short" }) +
            "</p>" +
            "<p class=\"text-muted\">Locul Founder a fost eliberat. " +
            (body.refund && body.refund.processed
              ? "Avansul a fost rambursat pe aceeasi metoda de plata; suma poate aparea in cont in cateva zile lucratoare."
              : "Rambursarea avansului se face in maximum 14 zile, pe aceeasi metoda de plata.") +
            "</p>" +
            "<p class=\"text-muted small\">" +
            (body.confirmationEmail === "sent"
              ? "Ai primit confirmarea pe email, pe un suport durabil."
              : "Pastreaza acest numar de referinta. Confirmarea se trimite si pe email.") +
            "</p>";
        }
        showMessage("Retragerea a fost inregistrata.", "success");
        return;
      }

      showMessage(
        (body && body.message) || "Cererea nu a putut fi inregistrata. Verifica datele si incearca din nou.",
        "error"
      );
    } catch (error) {
      showMessage("Serverul nu raspunde. Incearca din nou in cateva momente.", "error");
    }

    confirmButton.disabled = false;
    confirmButton.textContent = "Confirmati retragerea";
  });
})();
