(function () {
  const API = "/policies";

  const policyInput = document.getElementById("policyInput");
  const submitPolicyBtn = document.getElementById("submitPolicy");
  const submitStatus = document.getElementById("submitStatus");
  const pasteStatus = document.getElementById("pasteStatus");
  const policyList = document.getElementById("policyList");
  const policyListEmpty = document.getElementById("policyListEmpty");
  const auditSection = document.getElementById("auditSection");
  const auditPolicyName = document.getElementById("auditPolicyName");
  const auditPlaceholder = document.getElementById("auditPlaceholder");
  const auditLog = document.getElementById("auditLog");
  const auditLive = document.getElementById("auditLive");
  const builderPanel = document.getElementById("builderPanel");
  const pastePanel = document.getElementById("pastePanel");
  const policyForm = document.getElementById("policyForm");
  const walletsList = document.getElementById("walletsList");
  const addWalletBtn = document.getElementById("addWallet");

  let selectedPolicyId = null;
  let auditPollTimer = null;
  const POLL_INTERVAL_MS = 2500;

  function setStatus(el, text, type) {
    if (!el) return;
    el.textContent = text;
    el.className = "status" + (type ? " " + type : "");
  }

  function toISO(d) {
    return d.toISOString().slice(0, 19) + "Z";
  }

  function setValidityDefaults() {
    const now = new Date();
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const startEl = document.getElementById("validityStart");
    const endEl = document.getElementById("validityEnd");
    if (startEl && !startEl.value) startEl.value = toISO(now);
    if (endEl && !endEl.value) endEl.value = toISO(end);
  }

  function addWalletRow(address = "") {
    const row = document.createElement("div");
    row.className = "wallet-row";
    row.innerHTML = `
      <input type="text" name="walletAddress" placeholder="0x..." value="${escapeHtml(address)}" />
      <button type="button" class="btn-remove" aria-label="Remove">×</button>
    `;
    row.querySelector(".btn-remove").addEventListener("click", () => row.remove());
    walletsList.appendChild(row);
  }

  function buildPolicyFromForm() {
    const get = (id) => (document.getElementById(id) && document.getElementById(id).value) || "";
    const num = (id) => {
      const v = document.getElementById(id) && document.getElementById(id).value;
      return v === "" ? 0 : Number(v);
    };
    const wallets = [];
    walletsList.querySelectorAll('input[name="walletAddress"]').forEach((input) => {
      const a = input.value.trim();
      if (a) wallets.push(a);
    });

    const description = get("policyDescription").trim();
    return {
      apl_version: "0.1",
      policy: {
        name: get("policyName"),
        ...(description ? { description } : {}),
        wallets: wallets.length ? wallets : [],
        validity: {
          not_before: get("validityStart"),
          not_after: get("validityEnd"),
        },
        budget: { total: Math.round(num("budgetTotal") * 100), currency: get("budgetCurrency") || "USD" },
        max_without_approval: Math.round(num("maxWithoutApproval") * 100),
        permissions: ["payment"],
      },
    };
  }

  async function listPolicies() {
    const res = await fetch(API);
    if (!res.ok) throw new Error("Failed to list policies");
    return res.json();
  }

  async function submitPolicy(body) {
    const isJson = body.trim().startsWith("{");
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": isJson ? "application/json" : "text/yaml",
      },
      body: isJson ? body : body,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || err.details?.map((d) => d.message).join(", ") || "Upload failed");
    }
    return res.json();
  }

  async function deletePolicy(id) {
    const res = await fetch(`${API}/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete");
  }

  async function getAudit(id) {
    const res = await fetch(`${API}/${encodeURIComponent(id)}/audit`);
    if (!res.ok) throw new Error("Failed to load audit");
    return res.json();
  }

  function renderPolicyItem(p) {
    const li = document.createElement("li");
    li.dataset.id = p.id;
    li.classList.toggle("selected", p.id === selectedPolicyId);
    const desc = p.description ? `<span class="policy-description">${escapeHtml(p.description)}</span>` : "";
    li.innerHTML = `
      <span class="policy-info">
        <span class="policy-name">${escapeHtml(p.name)}</span>
        ${desc}
        <span class="policy-id">${escapeHtml(p.id)}</span>
      </span>
      <button type="button" class="btn btn-danger" data-action="delete" data-id="${escapeHtml(p.id)}">Delete</button>
    `;
    li.addEventListener("click", (e) => {
      if (e.target.closest("[data-action=delete]")) return;
      selectPolicy(p.id, p.name);
    });
    li.querySelector("[data-action=delete]").addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDelete(p.id, p.name);
    });
    return li;
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  async function refreshPolicyList() {
    try {
      const policies = await listPolicies();
      policyList.innerHTML = "";
      policyListEmpty.classList.toggle("hidden", policies.length > 0);
      policies.forEach((p) => policyList.appendChild(renderPolicyItem(p)));
      // Auto-select first policy so audit log is loaded and visible; otherwise refresh audit if one is selected
      if (policies.length > 0) {
        if (selectedPolicyId && policies.some((p) => p.id === selectedPolicyId)) {
          loadAudit(selectedPolicyId);
        } else {
          selectPolicy(policies[0].id, policies[0].name);
        }
      } else {
        selectedPolicyId = null;
        stopAuditPolling();
        auditPolicyName.textContent = "";
        auditLive.classList.add("hidden");
        auditPlaceholder.classList.remove("hidden");
        auditPlaceholder.textContent = "Select a policy to view its audit log.";
        renderAudit([]);
      }
    } catch (err) {
      setStatus(submitStatus, "Could not load policies", "error");
    }
  }

  function formatDollars(cents) {
    if (cents == null) return "";
    return "$" + (Number(cents) / 100).toFixed(2);
  }

  function formatEvent(ev) {
    const time = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : "";
    const type = ev.event_type || "event";
    let details = "";
    if (ev.request && (ev.request.action_type || ev.request.amount != null)) {
      const a = ev.request.action_type || "action";
      const amt = ev.request.amount != null ? ` ${formatDollars(ev.request.amount)}` : "";
      details = `${a}${amt}`.trim();
    }
    if (ev.decision && ev.decision.outcome) {
      if (details) details += " → ";
      details += ev.decision.outcome;
    }
    if (ev.budget_state && ev.budget_state.total_budget != null) {
      const b = ev.budget_state;
      details += ` · budget: ${formatDollars(b.spent_after ?? b.spent_before)}/${formatDollars(b.total_budget)} (${formatDollars(b.remaining)} left)`;
    }
    const txHash = ev.settlement_tx_hash;
    const safeHash = txHash ? String(txHash).trim().replace(/[^a-fA-F0-9x]/g, "") : "";
    const tx =
      txHash && safeHash
        ? `<div class="tx-hash"><a href="https://sepolia.basescan.org/tx/${safeHash}" target="_blank" rel="noopener noreferrer">${escapeHtml(txHash)}</a></div>`
        : "";
    return { type, time, details, tx };
  }

  function renderAudit(events) {
    auditLog.innerHTML = "";
    if (!events || events.length === 0) {
      auditLog.classList.add("hidden");
      auditPlaceholder.classList.remove("hidden");
      auditPlaceholder.textContent = selectedPolicyId
        ? "No audit entries yet."
        : "Select a policy to view its audit log.";
      return;
    }
    auditPlaceholder.classList.add("hidden");
    auditLog.classList.remove("hidden");
    events.forEach((ev) => {
      const { type, time, details, tx } = formatEvent(ev);
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="event-type">${escapeHtml(type)}</div>
        <div class="event-time">${escapeHtml(time)}</div>
        <div class="event-details">${escapeHtml(details)}</div>
        ${tx}
      `;
      auditLog.appendChild(li);
    });
  }

  async function loadAudit(id) {
    try {
      const events = await getAudit(id);
      renderAudit(events);
    } catch (err) {
      renderAudit([]);
      setStatus(submitStatus, "Could not load audit", "error");
    }
  }

  function selectPolicy(id, name) {
    selectedPolicyId = id;
    auditPolicyName.textContent = name ? `${name} (${id})` : id;
    auditLive.classList.remove("hidden");
    auditPlaceholder.classList.add("hidden");
    document.querySelectorAll(".policy-list li").forEach((li) => {
      li.classList.toggle("selected", li.dataset.id === id);
    });
    loadAudit(id);
    startAuditPolling();
  }

  function startAuditPolling() {
    stopAuditPolling();
    if (!selectedPolicyId) return;
    auditPollTimer = setInterval(() => {
      if (!selectedPolicyId) return;
      getAudit(selectedPolicyId).then(renderAudit).catch(() => {});
    }, POLL_INTERVAL_MS);
  }

  function stopAuditPolling() {
    if (auditPollTimer) {
      clearInterval(auditPollTimer);
      auditPollTimer = null;
    }
  }

  async function confirmDelete(id, name) {
    if (!confirm(`Delete policy "${name}" (${id})? This cannot be undone.`)) return;
    try {
      await deletePolicy(id);
      setStatus(submitStatus, "Policy deleted", "success");
      if (selectedPolicyId === id) {
        selectedPolicyId = null;
        stopAuditPolling();
        auditPolicyName.textContent = "";
        auditLive.classList.add("hidden");
        auditPlaceholder.classList.remove("hidden");
        auditPlaceholder.textContent = "Select a policy to view its audit log.";
        renderAudit([]);
      }
      await refreshPolicyList();
    } catch (err) {
      setStatus(submitStatus, err.message || "Delete failed", "error");
    }
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const isBuild = tab.dataset.tab === "build";
      builderPanel.classList.toggle("active", isBuild);
      builderPanel.classList.toggle("hidden", !isBuild);
      pastePanel.classList.toggle("active", !isBuild);
      pastePanel.classList.toggle("hidden", isBuild);
    });
  });

  document.querySelectorAll("[data-set-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const which = btn.dataset.setDate;
      if (which === "not_before") {
        const el = document.getElementById("validityStart");
        if (el) el.value = toISO(new Date());
      } else if (which === "not_after") {
        const el = document.getElementById("validityEnd");
        if (el) el.value = toISO(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
      }
    });
  });

  policyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = buildPolicyFromForm();
    if (!payload.policy.name) {
      setStatus(submitStatus, "Fill required field: name", "error");
      return;
    }
    if (!payload.policy.wallets.length) {
      setStatus(submitStatus, "Add at least one allowed wallet address", "error");
      return;
    }
    if (!payload.policy.validity.not_before || !payload.policy.validity.not_after) {
      setStatus(submitStatus, "Set validity start and end", "error");
      return;
    }
    if (!payload.policy.budget.total || payload.policy.budget.total < 100) {
      setStatus(submitStatus, "Budget total must be at least $1", "error");
      return;
    }
    setStatus(submitStatus, "Submitting…");
    try {
      const result = await submitPolicy(JSON.stringify(payload));
      setStatus(submitStatus, `Submitted: ${result.name} (${result.id})`, "success");
      await refreshPolicyList();
      policyForm.reset();
      setValidityDefaults();
      document.getElementById("budgetCurrency").value = "USD";
      walletsList.innerHTML = "";
      addWalletRow("");
    } catch (err) {
      setStatus(submitStatus, err.message || "Submit failed", "error");
    }
  });

  submitPolicyBtn.addEventListener("click", async () => {
    const body = policyInput.value.trim();
    if (!body) {
      setStatus(pasteStatus, "Paste a policy first", "error");
      return;
    }
    setStatus(pasteStatus, "Submitting…");
    try {
      const result = await submitPolicy(body);
      setStatus(pasteStatus, `Submitted: ${result.name} (${result.id})`, "success");
      await refreshPolicyList();
      policyInput.value = "";
    } catch (err) {
      setStatus(pasteStatus, err.message || "Submit failed", "error");
    }
  });

  addWalletBtn.addEventListener("click", () => addWalletRow(""));

  setValidityDefaults();
  addWalletRow("");

  refreshPolicyList();
})();
