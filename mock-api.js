(function () {
  const STORAGE_KEY = "orixasTenantStoreV1";

  const seed = {
    RO41892014: {
      name: "ACME LOGISTIC SRL",
      logs: [
        "18 nov: Facturi SPV sincronizate (34 documente)",
        "17 nov: TVA limitat 50% pe vehicule mixte marcat pentru review",
        "15 nov: Export contabil aprobat de CFO"
      ],
      invoices: [
        { no: "INV-2026-310", provider: "AutoFleet Expert SRL", amount: "4.980,00 RON", tva: "946,20 RON", status: "Nou" },
        { no: "INV-2026-311", provider: "FuelFast Romania SA", amount: "2.140,00 RON", tva: "406,60 RON", status: "Nou" },
        { no: "INV-2026-312", provider: "OfficeSmart Distribution", amount: "1.255,00 RON", tva: "238,45 RON", status: "Nou" }
      ]
    },
    RO12900455: {
      name: "NOVA RETAIL SRL",
      logs: [
        "18 nov: 2 facturi respinse CIUS-RO și corectate",
        "16 nov: Interogare Art. 298 emisă către iLegis",
        "14 nov: Sold TVA verificat cu contabilul extern"
      ],
      invoices: [
        { no: "INV-2026-111", provider: "Retail Plus SRL", amount: "3.412,00 RON", tva: "648,28 RON", status: "Nou" },
        { no: "INV-2026-112", provider: "Print Hub SA", amount: "980,00 RON", tva: "186,20 RON", status: "Nou" },
        { no: "INV-2026-113", provider: "Clean Store SRL", amount: "1.690,00 RON", tva: "321,10 RON", status: "Nou" }
      ]
    },
    RO39211701: {
      name: "FENIX SERVICES SRL",
      logs: [
        "18 nov: OAuth2 SPV reautorizat",
        "16 nov: Furnizor recurent clasificat automat",
        "12 nov: Exportul așteaptă validare manager"
      ],
      invoices: [
        { no: "INV-2026-901", provider: "WorkGear Trading", amount: "2.520,00 RON", tva: "478,80 RON", status: "Nou" },
        { no: "INV-2026-902", provider: "AutoService 24", amount: "4.300,00 RON", tva: "817,00 RON", status: "Nou" },
        { no: "INV-2026-903", provider: "Tech Support SRL", amount: "1.380,00 RON", tva: "262,20 RON", status: "Nou" }
      ]
    }
  };

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
        return deepClone(seed);
      }

      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch (err) {
      return deepClone(seed);
    }

    return deepClone(seed);
  }

  function saveStore(store) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function listTenants() {
    await wait(120);
    const store = loadStore();
    return Object.keys(store).map(function (cui) {
      return { cui: cui, name: store[cui].name };
    });
  }

  async function getTenant(cui) {
    await wait(140);
    const store = loadStore();
    const tenant = store[cui];
    if (!tenant) {
      throw new Error("Tenant inexistent");
    }

    return {
      cui: cui,
      name: tenant.name,
      logs: deepClone(tenant.logs),
      invoices: deepClone(tenant.invoices)
    };
  }

  async function addTenantLog(cui, message) {
    await wait(80);
    const store = loadStore();
    if (!store[cui]) {
      throw new Error("Tenant inexistent");
    }

    store[cui].logs.unshift(message);
    store[cui].logs = store[cui].logs.slice(0, 20);
    saveStore(store);
    return deepClone(store[cui].logs);
  }

  async function updateInvoiceStatuses(cui, updater) {
    await wait(80);
    const store = loadStore();
    if (!store[cui]) {
      throw new Error("Tenant inexistent");
    }

    store[cui].invoices = store[cui].invoices.map(function (invoice) {
      const updated = updater(deepClone(invoice));
      return updated;
    });

    saveStore(store);
    return deepClone(store[cui].invoices);
  }

  window.oriMockApi = {
    listTenants: listTenants,
    getTenant: getTenant,
    addTenantLog: addTenantLog,
    updateInvoiceStatuses: updateInvoiceStatuses
  };
})();
