const state = {
  templates: [],
  selectedId: null,
  attributeOptions: [],
  objectOptions: [],
};

const sessionKey = "esxDoctorClientSession";
function getOrCreateSessionID() {
  try {
    const existing = sessionStorage.getItem(sessionKey);
    if (existing) return existing;
    const created = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : `sid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem(sessionKey, created);
    return created;
  } catch (_err) {
    return `sid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}
const clientSessionID = getOrCreateSessionID();

async function apiFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-ESX-Session-ID", clientSessionID);
  return fetch(url, { ...init, headers });
}

const $ = (id) => document.getElementById(id);
const $list = $("tmList");
const $name = $("tmName");
const $desc = $("tmDesc");
const $severity = $("tmSeverity");
const $type = $("tmType");
const $enabled = $("tmEnabled");
const $filterLogic = $("tmFilterLogic");
const $conditions = $("tmConditions");
const $status = $("tmStatus");

function setStatus(msg) {
  if ($status) $status.textContent = msg || "";
}

function parsePDHColumn(raw) {
  const fallback = { object: "Other", counter: raw, attributeLabel: raw, instance: "Global" };
  if (!raw || !raw.startsWith("\\\\")) return fallback;
  const parts = raw.split("\\");
  if (parts.length < 5) return fallback;
  const objectPart = parts[3] || "Other";
  const counter = parts.slice(4).join("\\") || raw;
  const objectBase = objectPart.split("(")[0] || objectPart;
  const instanceMatch = objectPart.match(/\((.*)\)/);
  const instance = instanceMatch ? instanceMatch[1] : "Global";
  return { object: objectBase, counter, attributeLabel: `${objectBase}: ${counter}`, instance };
}

async function loadMetadataOptions() {
  try {
    const res = await apiFetch("/api/meta");
    const data = await res.json();
    const cols = Array.isArray(data.columns) ? data.columns.slice(1) : [];
    const attrs = new Set();
    const objs = new Set();
    cols.forEach((c) => {
      const p = parsePDHColumn(c);
      attrs.add(p.attributeLabel);
      objs.add(p.object);
    });
    state.attributeOptions = Array.from(attrs).sort((a, b) => a.localeCompare(b));
    state.objectOptions = Array.from(objs).sort((a, b) => a.localeCompare(b));
  } catch (_err) {
    state.attributeOptions = [];
    state.objectOptions = [];
  }
}

function renderTemplateList() {
  $list.innerHTML = "";
  if (!state.templates.length) {
    $list.textContent = "No templates";
    return;
  }
  const frag = document.createDocumentFragment();
  state.templates.forEach((t) => {
    const div = document.createElement("div");
    div.className = "tm-item" + (t.id === state.selectedId ? " active" : "");
    const title = document.createElement("div");
    title.className = "tm-item-title";
    title.textContent = `${t.name} [${t.severity || "medium"}]`;
    const meta = document.createElement("div");
    meta.className = "tm-item-meta";
    const kind = t.detector?.type || "unknown";
    const builtin = !String(t.id || "").startsWith("custom.") ? "built-in" : "custom";
    meta.textContent = `${kind} | ${builtin} | ${t.enabled === false ? "disabled" : "enabled"}`;
    div.appendChild(title);
    div.appendChild(meta);
    div.addEventListener("click", () => {
      state.selectedId = t.id;
      renderTemplateList();
      fillForm(t);
    });
    frag.appendChild(div);
  });
  $list.appendChild(frag);
}

function defaultCondition() {
  return { field: "attribute", op: "eq", value: "" };
}

function createConditionRow(cond = defaultCondition()) {
  const row = document.createElement("div");
  row.className = "tm-cond-row";

  const field = document.createElement("select");
  ["object", "attribute", "instance", "counter"].forEach((v) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    field.appendChild(o);
  });
  field.value = cond.field || "attribute";

  const op = document.createElement("select");
  [["eq", "equals"], ["neq", "not equals"], ["contains", "contains"], ["not_contains", "not contains"], ["regex", "regex"], ["not_regex", "not regex"]].forEach(([v, l]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    op.appendChild(o);
  });
  op.value = cond.op || "eq";

  let valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.value = cond.value || "";

  function rebuildValueInput() {
    const prev = valueInput.value;
    const isAttribute = field.value === "attribute";
    const isObject = field.value === "object";
    const replacement = document.createElement("select");
    if (isAttribute || isObject) {
      const options = isAttribute ? state.attributeOptions : state.objectOptions;
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "--select--";
      replacement.appendChild(empty);
      options.forEach((x) => {
        const o = document.createElement("option");
        o.value = x;
        o.textContent = x;
        replacement.appendChild(o);
      });
      replacement.value = options.includes(prev) ? prev : "";
      valueInput.replaceWith(replacement);
      valueInput = replacement;
      return;
    }
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = prev;
    valueInput.replaceWith(inp);
    valueInput = inp;
  }

  field.addEventListener("change", rebuildValueInput);
  rebuildValueInput();

  const remove = document.createElement("button");
  remove.className = "btn ghost";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => row.remove());

  row.appendChild(field);
  row.appendChild(op);
  row.appendChild(valueInput);
  row.appendChild(remove);
  row._get = () => ({ field: field.value, op: op.value, value: (valueInput.value || "").trim() });
  return row;
}

function getDetectorType() {
  return ($type.value || "threshold_sustained").trim();
}

function refreshTypeParams() {
  const kind = getDetectorType();
  $("tmThresholdParams").style.display = kind === "threshold_sustained" ? "block" : "none";
  $("tmZigzagParams").style.display = kind === "numa_zigzag" ? "block" : "none";
  $("tmImbalanceParams").style.display = kind === "numa_imbalance" ? "block" : "none";
}

function clearForm() {
  state.selectedId = null;
  $name.value = "";
  $desc.value = "";
  $severity.value = "medium";
  $enabled.value = "true";
  $type.value = "threshold_sustained";
  $filterLogic.value = "and";
  $conditions.innerHTML = "";
  $conditions.appendChild(createConditionRow(defaultCondition()));
  $("tmThreshold").value = "5";
  $("tmComparison").value = "greater";
  $("tmMinConsecutive").value = "6";
  $("tmMinSwitches").value = "6";
  $("tmMinGap").value = "3";
  $("tmHighThreshold").value = "80";
  $("tmLowThreshold").value = "20";
  $("tmImbalanceGap").value = "45";
  $("tmImbalanceConsecutive").value = "6";
  refreshTypeParams();
  renderTemplateList();
}

function fillForm(t) {
  if (!t) return clearForm();
  $name.value = t.name || "";
  $desc.value = t.description || "";
  $severity.value = (t.severity || "medium").toLowerCase();
  $enabled.value = t.enabled === false ? "false" : "true";
  $type.value = t.detector?.type || "threshold_sustained";
  const logic = (t.detector?.filter?.logic || "and").toLowerCase();
  $filterLogic.value = logic === "or" ? "or" : "and";
  $conditions.innerHTML = "";
  const conds = Array.isArray(t.detector?.filter?.conditions) ? t.detector.filter.conditions : [];
  if (!conds.length) $conditions.appendChild(createConditionRow(defaultCondition()));
  else conds.forEach((c) => $conditions.appendChild(createConditionRow(c)));

  $("tmThreshold").value = Number.isFinite(t.detector?.threshold) ? String(t.detector.threshold) : "";
  $("tmComparison").value = (t.detector?.comparison || "greater").toLowerCase() === "less" ? "less" : "greater";
  $("tmMinConsecutive").value = t.detector?.min_consecutive || 6;
  $("tmMinSwitches").value = t.detector?.min_switches || 6;
  $("tmMinGap").value = t.detector?.min_gap || 3;
  $("tmHighThreshold").value = t.detector?.high_threshold || 80;
  $("tmLowThreshold").value = t.detector?.low_threshold || 20;
  $("tmImbalanceGap").value = t.detector?.min_gap || 45;
  $("tmImbalanceConsecutive").value = t.detector?.min_consecutive || 6;

  refreshTypeParams();
}

function collectConditions() {
  const rows = Array.from($conditions.querySelectorAll(".tm-cond-row"));
  return rows
    .map((r) => (typeof r._get === "function" ? r._get() : null))
    .filter((x) => x && x.field && x.op && x.value);
}

function parseNum(id) {
  const v = Number($(id).value);
  return Number.isFinite(v) ? v : 0;
}

function toTemplatePayload() {
  const type = getDetectorType();
  const detector = {
    type,
    filter: {
      logic: $filterLogic.value || "and",
      conditions: collectConditions(),
    },
  };
  if (type === "threshold_sustained") {
    detector.threshold = parseNum("tmThreshold");
    detector.comparison = $("tmComparison").value || "greater";
    detector.min_consecutive = Math.max(1, parseInt($("tmMinConsecutive").value || "6", 10));
  } else if (type === "numa_zigzag") {
    detector.min_switches = Math.max(1, parseInt($("tmMinSwitches").value || "6", 10));
    detector.min_gap = parseNum("tmMinGap");
  } else if (type === "numa_imbalance") {
    detector.high_threshold = parseNum("tmHighThreshold");
    detector.low_threshold = parseNum("tmLowThreshold");
    detector.min_gap = parseNum("tmImbalanceGap");
    detector.min_consecutive = Math.max(1, parseInt($("tmImbalanceConsecutive").value || "6", 10));
  }
  return {
    id: state.selectedId || "",
    name: ($name.value || "").trim(),
    description: ($desc.value || "").trim(),
    severity: ($severity.value || "medium").trim(),
    enabled: $enabled.value !== "false",
    detector,
  };
}

async function saveTemplate() {
  const payload = toTemplatePayload();
  if (!payload.name) {
    setStatus("Template name is required.");
    return;
  }
  try {
    const res = await apiFetch("/api/diagnostics/templates/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: payload }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      setStatus(data.error || "Failed to save template.");
      return;
    }
    state.templates = Array.isArray(data.templates) ? data.templates : [];
    state.selectedId = data.template?.id || payload.id;
    renderTemplateList();
    const selected = state.templates.find((t) => t.id === state.selectedId);
    if (selected) fillForm(selected);
    setStatus("Template saved.");
  } catch (_err) {
    setStatus("Save request failed.");
  }
}

async function deleteTemplate() {
  if (!state.selectedId) return;
  if (!String(state.selectedId).startsWith("custom.")) {
    setStatus("Built-in templates cannot be deleted.");
    return;
  }
  if (!window.confirm("Delete selected template?")) return;
  try {
    const res = await apiFetch("/api/diagnostics/templates/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: state.selectedId }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      setStatus(data.error || "Failed to delete template.");
      return;
    }
    state.templates = Array.isArray(data.templates) ? data.templates : [];
    clearForm();
    setStatus("Template deleted.");
  } catch (_err) {
    setStatus("Delete request failed.");
  }
}

function exportTemplates() {
  apiFetch("/api/diagnostics/templates/export")
    .then((r) => r.json())
    .then((data) => {
      const text = JSON.stringify({ templates: data.templates || [] }, null, 2);
      const blob = new Blob([text], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "esx-doctor-templates.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      setStatus("Templates exported.");
    })
    .catch(() => setStatus("Export failed."));
}

async function importTemplates(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const templates = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.templates) ? parsed.templates : []);
    if (!templates.length) {
      setStatus("No templates found in JSON.");
      return;
    }
    const replace = window.confirm("Replace existing custom templates? Click Cancel to merge.");
    const res = await apiFetch("/api/diagnostics/templates/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templates, replace }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      setStatus(data.error || "Import failed.");
      return;
    }
    state.templates = Array.isArray(data.templates) ? data.templates : [];
    clearForm();
    setStatus(`Imported ${templates.length} template(s).`);
  } catch (_err) {
    setStatus("Import failed: invalid JSON.");
  }
}

async function loadTemplates() {
  try {
    const res = await apiFetch("/api/diagnostics/templates");
    const data = await res.json();
    state.templates = Array.isArray(data.templates) ? data.templates : [];
    renderTemplateList();
    if (state.templates.length > 0) {
      state.selectedId = state.templates[0].id;
      renderTemplateList();
      fillForm(state.templates[0]);
    } else {
      clearForm();
    }
  } catch (_err) {
    setStatus("Failed to load templates.");
  }
}

$("tmAddCondition").addEventListener("click", () => {
  $conditions.appendChild(createConditionRow(defaultCondition()));
});
$("tmType").addEventListener("change", refreshTypeParams);
$("tmNew").addEventListener("click", clearForm);
$("tmDuplicate").addEventListener("click", () => {
  const t = state.templates.find((x) => x.id === state.selectedId);
  if (!t) return;
  state.selectedId = null;
  fillForm({ ...t, id: "", name: `${t.name} (copy)` });
  renderTemplateList();
  setStatus("Template duplicated. Save to create a new custom template.");
});
$("tmDelete").addEventListener("click", deleteTemplate);
$("tmSave").addEventListener("click", saveTemplate);
$("tmExport").addEventListener("click", exportTemplates);
$("tmImport").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  importTemplates(file);
  e.target.value = "";
});

loadMetadataOptions().then(() => loadTemplates());
