const state = {
  templates: [],
  selectedId: null,
  attributeOptions: [],
  objectOptions: [],
};
const templateSyncChannelName = "esxDoctorTemplatesSync";
const templateSyncStorageKey = "esxDoctorTemplatesSyncAt";

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
function sessionIDFromURL() {
  try {
    const url = new URL(window.location.href);
    const sid = (url.searchParams.get("sid") || "").trim();
    return sid || "";
  } catch (_err) {
    return "";
  }
}

const clientSessionID = sessionIDFromURL() || getOrCreateSessionID();
let templateSyncChannel = null;

try {
  templateSyncChannel = new BroadcastChannel(templateSyncChannelName);
} catch (_err) {
  templateSyncChannel = null;
}

async function apiFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-ESX-Session-ID", clientSessionID);
  return fetch(url, { ...init, headers });
}

function notifyTemplatesUpdated() {
  try {
    localStorage.setItem(templateSyncStorageKey, String(Date.now()));
  } catch (_err) {
    // ignore
  }
  try {
    if (templateSyncChannel) {
      templateSyncChannel.postMessage({ type: "templates-updated", ts: Date.now() });
    }
  } catch (_err) {
    // ignore
  }
}

const $ = (id) => document.getElementById(id);
const $list = $("tmList");
const $name = $("tmName");
const $desc = $("tmDesc");
const $severity = $("tmSeverity");
const $type = $("tmType");
const $attribute = $("tmAttribute");
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
    cols.forEach((c) => {
      const p = parsePDHColumn(c);
      attrs.add(p.attributeLabel);
    });
    state.attributeOptions = Array.from(attrs).sort((a, b) => a.localeCompare(b));
    state.objectOptions = [];
  } catch (_err) {
    state.attributeOptions = [];
    state.objectOptions = [];
  }
  renderAttributeOptions();
}

function renderAttributeOptions(selected = "") {
  if (!$attribute) return;
  const current = selected || $attribute.value || "";
  $attribute.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "-- select attribute --";
  $attribute.appendChild(empty);
  state.attributeOptions.forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a;
    $attribute.appendChild(opt);
  });
  $attribute.value = state.attributeOptions.includes(current) ? current : "";
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
    const rawKind = t.detector?.type || "unknown";
    const kindMap = {
      threshold_sustained: "sustained-threshold",
      value_switch: "value-switch",
      zigzag_switch: "zigzag-switch",
      numa_zigzag: "zigzag-switch",
      dominance_imbalance: "dominance-imbalance",
      numa_imbalance: "dominance-imbalance",
      exclusive_affinity: "boolean-active-flag",
    };
    const kind = kindMap[rawKind] || rawKind;
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
  return { field: "instance", op: "contains", value: "" };
}

function createConditionRow(cond = defaultCondition()) {
  const row = document.createElement("div");
  row.className = "tm-cond-row";

  const op = document.createElement("select");
  [["contains", "contains"], ["not_contains", "not contains"], ["eq", "equals"], ["neq", "not equals"], ["regex", "regex"], ["not_regex", "not regex"]].forEach(([v, l]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    op.appendChild(o);
  });
  op.value = cond.op || "contains";

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.placeholder = "Instance match text or regex";
  valueInput.value = cond.value || "";

  const remove = document.createElement("button");
  remove.className = "btn ghost";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => row.remove());

  row.appendChild(op);
  row.appendChild(valueInput);
  row.appendChild(remove);
  row._get = () => ({ field: "instance", op: op.value, value: (valueInput.value || "").trim() });
  return row;
}

function getDetectorType() {
  return ($type.value || "threshold_sustained").trim();
}

function refreshTypeParams() {
  const kind = getDetectorType();
  $("tmThresholdParams").style.display = kind === "threshold_sustained" ? "block" : "none";
  $("tmZigzagParams").style.display = (kind === "value_switch" || kind === "zigzag_switch" || kind === "numa_zigzag") ? "block" : "none";
  $("tmMinGapWrap").style.display = (kind === "zigzag_switch" || kind === "numa_zigzag") ? "block" : "none";
  $("tmImbalanceParams").style.display = (kind === "dominance_imbalance" || kind === "numa_imbalance") ? "block" : "none";
}

function clearForm() {
  state.selectedId = null;
  $name.value = "";
  $desc.value = "";
  $severity.value = "medium";
  $enabled.value = "true";
  $type.value = "threshold_sustained";
  renderAttributeOptions("");
  $filterLogic.value = "and";
  $conditions.innerHTML = "";
  $conditions.appendChild(createConditionRow(defaultCondition()));
  $("tmThreshold").value = "5";
  $("tmUpperThreshold").value = "";
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
  const rawType = t.detector?.type || "threshold_sustained";
  if (rawType === "numa_zigzag") $type.value = "zigzag_switch";
  else if (rawType === "numa_imbalance") $type.value = "dominance_imbalance";
  else $type.value = rawType;
  const explicitAttr = (t.detector?.target_attribute || "").trim();
  let selectedAttr = explicitAttr;
  if (!selectedAttr) {
    const firstAttrCond = (Array.isArray(t.detector?.filter?.conditions) ? t.detector.filter.conditions : [])
      .find((c) => String(c.field || "").toLowerCase() === "attribute" && String(c.op || "").toLowerCase() === "eq");
    selectedAttr = firstAttrCond?.value || "";
  }
  renderAttributeOptions(selectedAttr);
  const logic = (t.detector?.filter?.logic || "and").toLowerCase();
  $filterLogic.value = logic === "or" ? "or" : "and";
  $conditions.innerHTML = "";
  const conds = (Array.isArray(t.detector?.filter?.conditions) ? t.detector.filter.conditions : [])
    .filter((c) => String(c.field || "").toLowerCase() === "instance");
  if (!conds.length) $conditions.appendChild(createConditionRow(defaultCondition()));
  else conds.forEach((c) => $conditions.appendChild(createConditionRow(c)));

  $("tmThreshold").value = Number.isFinite(t.detector?.threshold) ? String(t.detector.threshold) : "";
  $("tmUpperThreshold").value = Number.isFinite(t.detector?.upper_threshold) ? String(t.detector.upper_threshold) : "";
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
    .filter((x) => x && x.op && x.value);
}

function parseNum(id) {
  const v = Number($(id).value);
  return Number.isFinite(v) ? v : 0;
}

function toTemplatePayload() {
  const type = getDetectorType();
  const detector = {
    type,
    target_attribute: ($attribute && $attribute.value) ? $attribute.value.trim() : "",
    filter: {
      logic: $filterLogic.value || "and",
      conditions: collectConditions(),
    },
  };
  if (type === "threshold_sustained") {
    detector.threshold = parseNum("tmThreshold");
    const upper = parseNum("tmUpperThreshold");
    if (Number.isFinite(upper) && upper > 0) detector.upper_threshold = upper;
    detector.comparison = "greater";
    detector.min_consecutive = Math.max(1, parseInt($("tmMinConsecutive").value || "6", 10));
  } else if (type === "value_switch") {
    detector.min_switches = Math.max(1, parseInt($("tmMinSwitches").value || "6", 10));
  } else if (type === "zigzag_switch" || type === "numa_zigzag") {
    detector.min_switches = Math.max(1, parseInt($("tmMinSwitches").value || "6", 10));
    detector.min_gap = parseNum("tmMinGap");
  } else if (type === "dominance_imbalance" || type === "numa_imbalance") {
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
  if (!payload.detector.target_attribute) {
    setStatus("Attribute is required.");
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
    notifyTemplatesUpdated();
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
    notifyTemplatesUpdated();
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
    notifyTemplatesUpdated();
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
