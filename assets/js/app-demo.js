/* global oriMockApi */
(function () {

  const demoSteps = [
    "Conectare securizată OAuth2 la SPV ANAF pentru tenantul activ...",
    "Sincronizare facturi emise și primite din SPV ANAF...",
    "Validare CIUS-RO și structură XML pentru documentele noi...",
    "Analiză fiscală RAG: Art. 298 alin. (1) Cod Fiscal prin iLegis...",
    "Deschidere control Human-in-the-Loop pentru aprobare și export..."
  ];

  function byId(id) {
    return document.getElementById(id);
  }

  function safeText(text) {
    if (typeof window.oriSanitize === "function") {
      return window.oriSanitize(text);
    }
    return String(text);
  }

  const companySelect = byId("companySelect");
  const companyMeta = byId("companyMeta");
  const memoryList = byId("memoryList");
  const invoiceTbody = byId("invoiceTbody");
  const runDemoBtn = byId("runDemoBtn");
  const pipeline = Array.from(document.querySelectorAll(".pipeline-item"));
  const liveLog = byId("liveLog");
  const analysisText = byId("analysisText");
  const statusDot = byId("syncStatus");
  const legalQueryInput = byId("legalQueryInput");
  const legalQueryBtn = byId("legalQueryBtn");
  const legalAnswer = byId("legalAnswer");
  const uploadZone = byId("uploadZone");
  const uploadInput = byId("uploadInput");
  const uploadResult = byId("uploadResult");
  const modal = byId("approvalModal");
  const closeModalBtn = byId("closeModalBtn");
  const approveExportBtn = byId("approveExportBtn");
  const demoMessage = byId("demoMessage");
  const agentButtons = Array.from(document.querySelectorAll(".agent-btn"));
  const founderSeats = byId("founderSeats");

  let currentCui = "";
  let currentInvoices = [];

  function getApi() {
    if (window.oriMockApi) {
      return window.oriMockApi;
    }

    return null;
  }

  async function setTenant(cui) {
    const api = getApi();
    if (!api) {
      demoMessage.textContent = "Serviciul demo nu este disponibil momentan.";
      return;
    }

    const tenant = await api.getTenant(cui);
    currentCui = cui;
    currentInvoices = tenant.invoices;

    companyMeta.textContent = tenant.name + " - " + cui;
    memoryList.innerHTML = "";
    tenant.logs.forEach(function (entry) {
      const li = document.createElement("li");
      li.textContent = entry;
      memoryList.appendChild(li);
    });

    renderInvoices(currentInvoices);
  }

  function renderInvoices(invoices) {
    invoiceTbody.innerHTML = "";
    invoices.forEach(function (row) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td class=\"mono\">" +
        safeText(row.no) +
        "</td><td>" +
        safeText(row.provider) +
        "</td><td class=\"mono\">" +
        safeText(row.amount) +
        "</td><td class=\"mono\">" +
        safeText(row.tva) +
        "</td><td><span class=\"tag " +
        (row.status === "Valid" ? "ok" : row.status === "Review" ? "warn" : "") +
        "\">" +
        safeText(row.status) +
        "</span></td>";
      invoiceTbody.appendChild(tr);
    });
  }

  function clearPipeline() {
    pipeline.forEach(function (item) {
      item.classList.remove("done");
    });
  }

  function writeLiveLog(text) {
    const li = document.createElement("li");
    li.textContent = text;
    liveLog.prepend(li);
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  let runningDemo = false;

  async function runDemo() {
    if (runningDemo) {
      return;
    }

    runningDemo = true;
    runDemoBtn.disabled = true;
    demoMessage.textContent = "Simulare în desfășurare...";
    statusDot.textContent = "Sincronizare activă";
    statusDot.classList.add("active");
    clearPipeline();

    const api = getApi();
    if (!api || !currentCui) {
      runDemoBtn.disabled = false;
      runningDemo = false;
      return;
    }

    currentInvoices = await api.updateInvoiceStatuses(currentCui, function (invoice) {
      invoice.status = "Sincronizat";
      return invoice;
    });
    renderInvoices(currentInvoices);

    for (let i = 0; i < demoSteps.length; i += 1) {
      await delay(1000);
      pipeline[i].classList.add("done");
      writeLiveLog(demoSteps[i]);
      await api.addTenantLog(currentCui, demoSteps[i]);

      if (i === 2) {
        currentInvoices = await api.updateInvoiceStatuses(currentCui, function (invoice) {
          if (invoice.no.endsWith("11") || invoice.no.endsWith("311") || invoice.no.endsWith("902")) {
            invoice.status = "Review";
          } else {
            invoice.status = "Valid";
          }
          return invoice;
        });
        renderInvoices(currentInvoices);
      }

      if (i === 3) {
        analysisText.textContent =
          "Art. 298 alin. (1) Cod Fiscal indică deducere limitată la 50% pentru cheltuieli auto cu utilizare mixtă. Recomandare: marcare automată pe cont analitic distinct și validare umană înainte de export.";
      }
    }

    modal.classList.add("open");
    demoMessage.textContent = "Simulare finalizată. Așteaptă aprobarea umană pentru export.";
    runDemoBtn.disabled = false;
    runningDemo = false;
  }

  function openLegalAnswer() {
    const raw = legalQueryInput.value;
    const query = safeText(raw);
    if (!query || query.length < 8) {
      legalAnswer.textContent = "Introdu o întrebare mai clară (minim 8 caractere).";
      return;
    }

    legalAnswer.textContent =
      "Rezultat iLegis: pentru interogarea \"" +
      query +
      "\", verifică Art. 298 Cod Fiscal și normele metodologice pentru deducerea TVA. Recomandare Orixas: păstrează justificarea utilizării economice în dosarul fiscal.";
  }

  function onUpload(files) {
    if (!files || !files.length) {
      uploadResult.textContent = "Niciun fișier selectat.";
      return;
    }

    const allowed = [".pdf", ".docx", ".xml"];
    const names = [];
    Array.from(files).forEach(function (file) {
      const lower = file.name.toLowerCase();
      const accepted = allowed.some(function (ext) {
        return lower.endsWith(ext);
      });

      if (accepted) {
        names.push(safeText(file.name));
      }
    });

    if (!names.length) {
      uploadResult.textContent = "Tip invalid. Sunt acceptate doar PDF, DOCX sau XML.";
      return;
    }

    uploadResult.textContent = "Fișiere încărcate: " + names.join(", ");
  }

  function closeModal() {
    modal.classList.remove("open");
  }

  function approveExport() {
    closeModal();
    statusDot.textContent = "Export aprobat";
    statusDot.classList.remove("active");
    analysisText.textContent =
      "Exportul în contabilitate a fost aprobat de operatorul uman. Istoricul tenantului a fost actualizat și memorat per CUI.";
    writeLiveLog("Aprobă și Exportă în Contabilitate -> finalizat de operator.");
    demoMessage.textContent = "Flux complet: aprobat și exportat.";
    const api = getApi();
    if (api && currentCui) {
      api.addTenantLog(currentCui, "Export aprobat manual și transmis către contabilitate.").then(function () {
        return setTenant(currentCui);
      });
    }
  }

  if (companySelect && getApi()) {
    getApi()
      .listTenants()
      .then(function (tenants) {
        companySelect.innerHTML = "";
        tenants.forEach(function (tenant) {
          const option = document.createElement("option");
          option.value = tenant.cui;
          option.textContent = tenant.name + " - " + tenant.cui;
          companySelect.appendChild(option);
        });

        if (companySelect.options.length > 0) {
          setTenant(companySelect.value);
        }
      })
      .catch(function () {
        demoMessage.textContent = "Nu am putut încărca tenanturile demo.";
      });

    companySelect.addEventListener("change", function () {
      setTenant(companySelect.value);
    });
  }

  if (runDemoBtn) {
    runDemoBtn.addEventListener("click", runDemo);
  }

  if (legalQueryBtn) {
    legalQueryBtn.addEventListener("click", openLegalAnswer);
  }

  if (legalQueryInput) {
    legalQueryInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        openLegalAnswer();
      }
    });
  }

  if (uploadZone && uploadInput) {
    uploadZone.addEventListener("dragover", function (event) {
      event.preventDefault();
      uploadZone.classList.add("drag-over");
    });

    uploadZone.addEventListener("dragleave", function () {
      uploadZone.classList.remove("drag-over");
    });

    uploadZone.addEventListener("drop", function (event) {
      event.preventDefault();
      uploadZone.classList.remove("drag-over");
      onUpload(event.dataTransfer.files);
    });

    uploadZone.addEventListener("click", function () {
      uploadInput.click();
    });

    uploadInput.addEventListener("change", function () {
      onUpload(uploadInput.files);
    });
  }

  if (closeModalBtn) {
    closeModalBtn.addEventListener("click", closeModal);
  }

  if (approveExportBtn) {
    approveExportBtn.addEventListener("click", approveExport);
  }

  agentButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      agentButtons.forEach(function (item) {
        item.classList.remove("active");
      });
      button.classList.add("active");

      const agent = button.dataset.agent;
      if (agent === "juridic") {
        demoMessage.textContent = "Agent Juridic este în preview. Include flux de contracte și audit documente în etapa următoare.";
      } else {
        demoMessage.textContent = "Agent Financiar activ. Rulează demo-ul pentru flux complet SPV -> CIUS-RO -> fiscal -> aprobare.";
      }
    });
  });

  try {
    const signupRaw = sessionStorage.getItem("orixasSignup");
    if (signupRaw && founderSeats) {
      founderSeats.textContent = "19";
    }
  } catch (err) {
    if (founderSeats) {
      founderSeats.textContent = "20";
    }
  }
})();
