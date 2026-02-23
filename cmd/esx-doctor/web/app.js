const state = {
  columns: [],
  parsedColumns: [],
  indexMap: new Map(),
  attributes: [],
  attributeMap: new Map(),
  reports: [],
  activeReport: null,
  windows: [],
  activeWindowId: null,
  windowSeq: 1,
  selected: new Set(),
  selectedAttribute: null,
  times: [],
  rawSeries: [],
  series: [],
  range: { start: null, end: null },
  view: { start: null, end: null },
  zoomStack: [],
  panSpan: null,
  file: "",
  rows: 0,
  yUnit: "value",
  filter: {
    min: null,
    max: null,
  },
  marks: [],
  markSeq: 1,
  selectedMarkId: null,
  hoveredMarkId: null,
  markDraftColor: "#ff9f0a",
  contextMarkId: null,
  contextMenuX: null,
  diagnosticsTemplates: [],
  selectedDiagnosticTemplateIds: new Set(),
  diagnosticsFindings: [],
};

const palette = [
  "#5dd6c7",
  "#f4b05d",
  "#7aa2f7",
  "#f7768e",
  "#9ece6a",
  "#bb9af7",
  "#e0af68",
];
const themePalettes = {
  midnight: palette,
  "classic-light": ["#0071e3", "#34c759", "#ff9f0a", "#5e5ce6", "#ff375f", "#64d2ff", "#30b0c7"],
};
const loadSeriesSoftLimit = 10000;
const tooltipIdleDelayMs = 250;
const themeStorageKey = "esxDoctorTheme";
const sidebarStorageKey = "esxDoctorSidebarCollapsed";
const clientSessionStorageKey = "esxDoctorClientSession";
const templateSyncChannelName = "esxDoctorTemplatesSync";
const templateSyncStorageKey = "esxDoctorTemplatesSyncAt";
const defaultTheme = "midnight";

function getOrCreateClientSessionID() {
  try {
    const existing = sessionStorage.getItem(clientSessionStorageKey);
    if (existing) return existing;
    const created = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : `sid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem(clientSessionStorageKey, created);
    return created;
  } catch (_err) {
    return `sid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

const clientSessionID = getOrCreateClientSessionID();

async function apiFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-ESX-Session-ID", clientSessionID);
  return fetch(input, { ...init, headers });
}

const $search = document.getElementById("search");
const $reports = document.getElementById("reports");
const $attributes = document.getElementById("attributes");
const $instances = document.getElementById("instances");
const $instanceSearch = document.getElementById("instanceSearch");
const $filePath = document.getElementById("filePath");
const $filePicker = document.getElementById("filePicker");
const $urlInput = document.getElementById("urlInput");
const $datasetTabFile = document.getElementById("datasetTabFile");
const $datasetTabUrl = document.getElementById("datasetTabUrl");
const $datasetFilePane = document.getElementById("datasetFilePane");
const $datasetUrlPane = document.getElementById("datasetUrlPane");
const $themeSelect = document.getElementById("themeSelect");
const $filterMin = document.getElementById("filterMin");
const $filterMax = document.getElementById("filterMax");
const $diagTemplates = document.getElementById("diagTemplates");
const $runDiagnostics = document.getElementById("runDiagnostics");
const $openTemplateManager = document.getElementById("openTemplateManager");
const $diagFindings = document.getElementById("diagFindings");
const $diagRunMeta = document.getElementById("diagRunMeta");
const $sidebarToggleHandle = document.getElementById("sidebarToggleHandle");
const $markMenu = document.getElementById("markMenu");
const $markMenuAdd = document.getElementById("markMenuAdd");
const $markMenuEdit = document.getElementById("markMenuEdit");
const $markMenuDelete = document.getElementById("markMenuDelete");
const $markMenuClear = document.getElementById("markMenuClear");
const $markMenuColor = document.getElementById("markMenuColor");
const $markEditModal = document.getElementById("markEditModal");
const $markEditName = document.getElementById("markEditName");
const $markEditComment = document.getElementById("markEditComment");
const $markEditSave = document.getElementById("markEditSave");
const $markEditCancel = document.getElementById("markEditCancel");
const $status = document.getElementById("status");
const $selectedAttributeLabel = document.getElementById("selectedAttributeLabel");
const $windowTabs = document.getElementById("windowTabs");
const $splitter = document.getElementById("splitter");
const $chart = document.getElementById("chart");
const $overlay = document.getElementById("overlay");
const $tooltip = document.getElementById("tooltip");
const $zoomPanWrap = document.getElementById("zoomPanWrap");
const $zoomPanLabel = document.getElementById("zoomPanLabel");
const $zoomPanTrack = document.getElementById("zoomPanTrack");
const $zoomPanWindow = document.getElementById("zoomPanWindow");
const $loadGuardModal = document.getElementById("loadGuardModal");
const $loadGuardBody = document.getElementById("loadGuardBody");
const $loadGuardCancel = document.getElementById("loadGuardCancel");
const $loadGuardSuggested = document.getElementById("loadGuardSuggested");
const $loadGuardAll = document.getElementById("loadGuardAll");

const ctx = $chart.getContext("2d");
const octx = $overlay.getContext("2d");
let tooltipHovered = false;
let hoverPoint = null;
let dragCurrentX = null;
let pointerMovePending = null;
let pointerMoveRAF = 0;
let tooltipSeriesIndex = -1;
let tooltipIdleTimer = 0;
let tooltipIdlePoint = null;
let templateSyncChannel = null;
const panDrag = {
  active: false,
  startX: 0,
  startIdx: 0,
  span: 1,
  maxStart: 0,
};
const splitDrag = {
  active: false,
};
const markDrag = {
  active: false,
  markID: null,
};

function getCSSVar(name, fallback = "") {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function getActiveTheme() {
  const t = document.body.dataset.theme || defaultTheme;
  return themePalettes[t] ? t : defaultTheme;
}

function getSeriesPalette() {
  return themePalettes[getActiveTheme()] || themePalettes[defaultTheme];
}

function applyTheme(theme) {
  const next = themePalettes[theme] ? theme : defaultTheme;
  document.body.dataset.theme = next;
  if ($themeSelect) $themeSelect.value = next;
  try {
    localStorage.setItem(themeStorageKey, next);
  } catch (_err) {
    // Ignore storage errors in restricted browser contexts.
  }
  drawChart();
}

function initTheme() {
  let saved = defaultTheme;
  try {
    saved = localStorage.getItem(themeStorageKey) || defaultTheme;
  } catch (_err) {
    saved = defaultTheme;
  }
  applyTheme(saved);
}

function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  if ($sidebarToggleHandle) {
    $sidebarToggleHandle.textContent = collapsed ? "›" : "‹";
    $sidebarToggleHandle.setAttribute("aria-label", collapsed ? "Show side panel" : "Hide side panel");
    $sidebarToggleHandle.title = collapsed ? "Show side panel" : "Hide side panel";
  }
  try {
    localStorage.setItem(sidebarStorageKey, collapsed ? "1" : "0");
  } catch (_err) {
    // Ignore storage errors.
  }
  requestAnimationFrame(() => {
    drawChart();
  });
}

function initSidebarState() {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(sidebarStorageKey) === "1";
  } catch (_err) {
    collapsed = false;
  }
  applySidebarCollapsed(collapsed);
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").replace("Z", " UTC");
}

function setStatus(msg) {
  $status.textContent = msg;
  const w = state.windows.find((x) => x.id === state.activeWindowId);
  if (w) w.status = msg;
}

function plotMetrics() {
  const rect = $chart.getBoundingClientRect();
  const padding = { left: 74, right: 18, top: 20, bottom: 56 };
  const plotW = rect.width - padding.left - padding.right;
  const plotH = rect.height - padding.top - padding.bottom;
  return { rect, padding, plotW, plotH };
}

function nearestTimestamp(target) {
  if (!Array.isArray(state.times) || state.times.length === 0) return null;
  let idx = Math.min(binarySearchTimes(target), state.times.length - 1);
  if (idx > 0) {
    const left = state.times[idx - 1];
    const right = state.times[idx];
    if (Math.abs(target - left) <= Math.abs(right - target)) idx -= 1;
  }
  return state.times[idx];
}

function marksInView(domain, metrics) {
  const { padding, plotW } = metrics;
  if (!domain || !Number.isFinite(plotW) || plotW <= 0) return [];
  const span = domain.end - domain.start || 1;
  return state.marks
    .filter((m) => m.time >= domain.start && m.time <= domain.end)
    .map((m, i) => ({
      ...m,
      order: i + 1,
      x: padding.left + ((m.time - domain.start) / span) * plotW,
    }));
}

function hitTestMark(x, y) {
  const domain = computeDomain();
  if (!domain) return null;
  const m = plotMetrics();
  if (x < m.padding.left || x > m.padding.left + m.plotW || y < m.padding.top || y > m.padding.top + m.plotH) return null;
  const marks = marksInView(domain, m);
  const threshold = 6;
  for (let i = 0; i < marks.length; i += 1) {
    if (Math.abs(x - marks[i].x) <= threshold) return marks[i];
  }
  return null;
}

function updateMarkButtons() {
  const mark = state.marks.find((m) => m.id === state.selectedMarkId);
  if ($markMenuColor) $markMenuColor.value = mark ? (mark.color || state.markDraftColor) : state.markDraftColor;
}

function drawMarkHoverText(mark, x, topY) {
  if (!mark) return;
  const title = (mark.title || "").trim();
  const comment = (mark.comment || "").trim();
  if (!title && !comment) return;
  const padX = 8;
  const lines = [];
  if (title) lines.push(title);
  if (comment) lines.push(comment);
  const h = 20 + (lines.length - 1) * 16;
  octx.font = "12px var(--font-sans)";
  let textW = 70;
  lines.forEach((line) => {
    textW = Math.max(textW, Math.ceil(octx.measureText(line).width));
  });
  const w = Math.min(300, textW + padX * 2);
  const left = Math.max(8, Math.min(x - w / 2, $overlay.clientWidth - w - 8));
  const y = Math.max(8, topY);
  octx.fillStyle = getCSSVar("--tooltip-bg", "#0b0f16");
  octx.strokeStyle = getCSSVar("--tooltip-border", "#3a455d");
  octx.lineWidth = 1;
  octx.fillRect(left, y, w, h);
  octx.strokeRect(left, y, w, h);
  octx.textAlign = "left";
  octx.textBaseline = "top";
  octx.fillStyle = getCSSVar("--text", "#e6e8ef");
  if (title) octx.fillText(title.length > 56 ? `${title.slice(0, 53)}...` : title, left + padX, y + 5);
  if (comment) {
    octx.fillStyle = getCSSVar("--muted", "#9aa2b2");
    octx.fillText(comment.length > 56 ? `${comment.slice(0, 53)}...` : comment, left + padX, y + 21);
  }
}

function drawMarks() {
  if (state.times.length === 0 || state.marks.length === 0) return;
  const domain = computeDomain();
  if (!domain) return;
  const m = plotMetrics();
  const marks = marksInView(domain, m);
  marks.forEach((mark) => {
    const selected = mark.id === state.selectedMarkId;
    octx.strokeStyle = mark.color || "#ff9f0a";
    octx.lineWidth = selected ? 2 : 1.25;
    octx.setLineDash([6, 5]);
    octx.beginPath();
    octx.moveTo(mark.x, m.padding.top);
    octx.lineTo(mark.x, m.padding.top + m.plotH);
    octx.stroke();
    octx.setLineDash([]);
    const tag = (mark.title || "").trim() || `M${mark.order}`;
    octx.font = "11px var(--font-mono)";
    const shownTag = tag.length > 18 ? `${tag.slice(0, 15)}...` : tag;
    const tw = Math.ceil(octx.measureText(shownTag).width) + 10;
    const tx = Math.max(4, Math.min(mark.x - tw / 2, m.rect.width - tw - 4));
    const ty = m.padding.top + 4;
    octx.fillStyle = mark.color || "#ff9f0a";
    octx.fillRect(tx, ty, tw, 16);
    octx.fillStyle = "#111";
    octx.textAlign = "left";
    octx.textBaseline = "middle";
    octx.fillText(shownTag, tx + 5, ty + 8);
    if (mark.id === state.hoveredMarkId) drawMarkHoverText(mark, mark.x, ty + 20);
  });
}

function addMarkAtX(x) {
  const domain = computeDomain();
  if (!domain) return;
  const m = plotMetrics();
  if (x < m.padding.left || x > m.padding.left + m.plotW) return;
  const t = domain.start + ((x - m.padding.left) / (m.plotW || 1)) * (domain.end - domain.start);
  const nearest = nearestTimestamp(t);
  if (!Number.isFinite(nearest)) return;
  const existing = state.marks.find((mk) => mk.time === nearest);
  if (existing) {
    state.selectedMarkId = existing.id;
    updateMarkButtons();
    redrawOverlay();
    return;
  }
  const mark = {
    id: `mk-${state.markSeq++}`,
    time: nearest,
    title: "",
    comment: "",
    color: state.markDraftColor || "#ff9f0a",
  };
  state.marks.push(mark);
  state.marks.sort((a, b) => a.time - b.time);
  state.selectedMarkId = mark.id;
  state.markDraftColor = mark.color;
  updateMarkButtons();
  redrawOverlay();
}

function moveMarkToX(markID, x) {
  const mark = state.marks.find((m) => m.id === markID);
  if (!mark) return;
  const domain = computeDomain();
  if (!domain) return;
  const m = plotMetrics();
  const clampedX = Math.max(m.padding.left, Math.min(x, m.padding.left + m.plotW));
  const t = domain.start + ((clampedX - m.padding.left) / (m.plotW || 1)) * (domain.end - domain.start);
  const nearest = nearestTimestamp(t);
  if (!Number.isFinite(nearest)) return;
  const conflict = state.marks.find((other) => other.id !== markID && other.time === nearest);
  if (conflict) return;
  mark.time = nearest;
  state.marks.sort((a, b) => a.time - b.time);
  redrawOverlay();
}

function openMarkEditor(mark) {
  if (!mark || !$markEditModal || !$markEditName || !$markEditComment || !$markEditSave || !$markEditCancel) return;
  $markEditName.value = mark.title || "";
  $markEditComment.value = mark.comment || "";
  $markEditModal.classList.remove("hidden");
  $markEditName.focus();

  const cleanup = () => {
    $markEditModal.classList.add("hidden");
    $markEditSave.removeEventListener("click", onSave);
    $markEditCancel.removeEventListener("click", onCancel);
    $markEditModal.removeEventListener("click", onBackdrop);
    window.removeEventListener("keydown", onKey);
  };
  const onSave = () => {
    mark.title = ($markEditName.value || "").trim();
    mark.comment = ($markEditComment.value || "").trim();
    cleanup();
    redrawOverlay();
  };
  const onCancel = () => cleanup();
  const onBackdrop = (e) => {
    if (e.target === $markEditModal) cleanup();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      const active = document.activeElement;
      if (active === $markEditName) $markEditName.value = "";
      else if (active === $markEditComment) $markEditComment.value = "";
    }
  };
  $markEditSave.addEventListener("click", onSave);
  $markEditCancel.addEventListener("click", onCancel);
  $markEditModal.addEventListener("click", onBackdrop);
  window.addEventListener("keydown", onKey);
}

function editSelectedMark() {
  const mark = state.marks.find((m) => m.id === state.selectedMarkId);
  if (!mark) return;
  openMarkEditor(mark);
}

function deleteSelectedMark() {
  if (!state.selectedMarkId) return;
  const before = state.marks.length;
  state.marks = state.marks.filter((m) => m.id !== state.selectedMarkId);
  if (state.marks.length !== before) {
    state.selectedMarkId = null;
    updateMarkButtons();
    redrawOverlay();
  }
}

function clearAllMarks() {
  if (state.marks.length === 0) return;
  state.marks = [];
  state.selectedMarkId = null;
  state.contextMarkId = null;
  state.hoveredMarkId = null;
  updateMarkButtons();
  redrawOverlay();
}

function hideMarkMenu() {
  if ($markMenu) $markMenu.classList.add("hidden");
  state.contextMarkId = null;
  state.contextMenuX = null;
}

function showMarkMenu(clientX, clientY, hitMark) {
  if (!$markMenu || !$markMenuAdd || !$markMenuEdit || !$markMenuDelete || !$markMenuClear || !$markMenuColor) return;
  state.contextMarkId = hitMark ? hitMark.id : null;
  if (hitMark) state.selectedMarkId = hitMark.id;
  updateMarkButtons();

  $markMenuEdit.disabled = !state.contextMarkId;
  $markMenuDelete.disabled = !state.contextMarkId;
  $markMenuClear.disabled = state.marks.length === 0;

  const selected = state.marks.find((m) => m.id === state.selectedMarkId);
  $markMenuColor.value = selected ? (selected.color || state.markDraftColor) : state.markDraftColor;

  $markMenu.classList.remove("hidden");
  const menuW = $markMenu.offsetWidth || 210;
  const menuH = $markMenu.offsetHeight || 200;
  const left = Math.max(8, Math.min(clientX, window.innerWidth - menuW - 8));
  const top = Math.max(8, Math.min(clientY, window.innerHeight - menuH - 8));
  $markMenu.style.left = `${left}px`;
  $markMenu.style.top = `${top}px`;
}

function chooseLargeLoadAction(totalSelected) {
  return new Promise((resolve) => {
    if (!$loadGuardModal || !$loadGuardBody || !$loadGuardCancel || !$loadGuardSuggested || !$loadGuardAll) {
      resolve("suggested");
      return;
    }
    $loadGuardBody.textContent = `You selected ${totalSelected} instances.\n\nTo keep the app responsive, the recommended option loads the first ${loadSeriesSoftLimit} instances.`;
    $loadGuardModal.classList.remove("hidden");

    const cleanup = () => {
      $loadGuardModal.classList.add("hidden");
      $loadGuardCancel.removeEventListener("click", onCancel);
      $loadGuardSuggested.removeEventListener("click", onSuggested);
      $loadGuardAll.removeEventListener("click", onAll);
      $loadGuardModal.removeEventListener("click", onBackdrop);
      window.removeEventListener("keydown", onKey);
    };
    const finish = (choice) => {
      cleanup();
      resolve(choice);
    };
    const onCancel = () => finish("cancel");
    const onSuggested = () => finish("suggested");
    const onAll = () => finish("all");
    const onBackdrop = (e) => {
      if (e.target === $loadGuardModal) finish("cancel");
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish("cancel");
    };

    $loadGuardCancel.addEventListener("click", onCancel);
    $loadGuardSuggested.addEventListener("click", onSuggested);
    $loadGuardAll.addEventListener("click", onAll);
    $loadGuardModal.addEventListener("click", onBackdrop);
    window.addEventListener("keydown", onKey);
  });
}

function setDatasetMode(mode) {
  const useURL = mode === "url";
  if ($datasetTabFile) $datasetTabFile.classList.toggle("active", !useURL);
  if ($datasetTabUrl) $datasetTabUrl.classList.toggle("active", useURL);
  if ($datasetFilePane) $datasetFilePane.classList.toggle("hidden", useURL);
  if ($datasetUrlPane) $datasetUrlPane.classList.toggle("hidden", !useURL);
}

function formatSeverity(s) {
  const v = (s || "").trim().toLowerCase();
  if (!v) return "medium";
  return v;
}

function renderDiagnosticTemplates() {
  if (!$diagTemplates) return;
  $diagTemplates.innerHTML = "";
  if (!state.diagnosticsTemplates || state.diagnosticsTemplates.length === 0) {
    $diagTemplates.textContent = "No templates available.";
    return;
  }
  const frag = document.createDocumentFragment();
  state.diagnosticsTemplates.forEach((t) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selectedDiagnosticTemplateIds.has(t.id);
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedDiagnosticTemplateIds.add(t.id);
      else state.selectedDiagnosticTemplateIds.delete(t.id);
    });
    const textWrap = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = `${t.name} [${formatSeverity(t.severity)}]`;
    const desc = document.createElement("span");
    desc.textContent = t.description || "";
    textWrap.appendChild(title);
    textWrap.appendChild(desc);
    label.appendChild(cb);
    label.appendChild(textWrap);
    frag.appendChild(label);
  });
  $diagTemplates.appendChild(frag);
}

function renderDiagnosticFindings() {
  if (!$diagFindings) return;
  $diagFindings.innerHTML = "";
  if (!state.diagnosticsFindings || state.diagnosticsFindings.length === 0) {
    const m = document.createElement("div");
    m.className = "muted";
    m.textContent = "No findings.";
    $diagFindings.appendChild(m);
    return;
  }
  const frag = document.createDocumentFragment();
  state.diagnosticsFindings.forEach((f) => {
    const card = document.createElement("div");
    card.className = "diag-finding";
    const title = document.createElement("div");
    title.className = "diag-finding-title";
    title.textContent = `${f.title} (${formatSeverity(f.severity)})`;
    const meta = document.createElement("div");
    meta.className = "diag-finding-meta";
    const range = Number.isFinite(f.start) && Number.isFinite(f.end) ? `${fmtTime(f.start)} to ${fmtTime(f.end)}` : "";
    meta.textContent = [f.templateName, f.reportKey ? `report: ${f.reportKey}` : "", range].filter(Boolean).join(" | ");
    const summary = document.createElement("div");
    summary.className = "diag-finding-meta";
    summary.textContent = f.summary || "";
    const instances = document.createElement("div");
    instances.className = "diag-finding-meta";
    const listed = Array.isArray(f.instances) ? f.instances.filter(Boolean) : [];
    instances.textContent = listed.length > 0 ? `Instances: ${listed.join(", ")}` : "Instances: n/a";
    const actions = document.createElement("div");
    actions.className = "diag-finding-actions";
    const jump = document.createElement("button");
    jump.className = "btn ghost";
    jump.textContent = "Open";
    jump.addEventListener("click", () => jumpToFinding(f));
    actions.appendChild(jump);
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(summary);
    card.appendChild(instances);
    card.appendChild(actions);
    frag.appendChild(card);
  });
  $diagFindings.appendChild(frag);
}

async function loadDiagnosticTemplates() {
  if (!$diagTemplates) return;
  try {
    const res = await apiFetch("/api/diagnostics/templates");
    const data = await res.json();
    const list = Array.isArray(data.templates) ? data.templates : [];
    state.diagnosticsTemplates = list;
    state.selectedDiagnosticTemplateIds = new Set(list.filter((t) => t.enabled !== false).map((t) => t.id));
    renderDiagnosticTemplates();
  } catch (_err) {
    $diagTemplates.textContent = "Failed to load templates.";
  }
}

function setupTemplateSync() {
  window.addEventListener("storage", (e) => {
    if (e.key === templateSyncStorageKey) loadDiagnosticTemplates();
  });

  window.addEventListener("focus", () => loadDiagnosticTemplates());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadDiagnosticTemplates();
  });

  try {
    templateSyncChannel = new BroadcastChannel(templateSyncChannelName);
    templateSyncChannel.onmessage = (e) => {
      if (e && e.data && e.data.type === "templates-updated") {
        loadDiagnosticTemplates();
      }
    };
  } catch (_err) {
    templateSyncChannel = null;
  }
}

async function runDiagnostics() {
  if (!$runDiagnostics) return;
  const ids = Array.from(state.selectedDiagnosticTemplateIds.values());
  setStatus("Running diagnostics...");
  if ($diagRunMeta) $diagRunMeta.textContent = "";
  try {
    const res = await apiFetch("/api/diagnostics/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateIds: ids }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      setStatus(data.error || "Diagnostics failed.");
      return;
    }
    state.diagnosticsFindings = Array.isArray(data.findings) ? data.findings : [];
    renderDiagnosticFindings();
    if ($diagRunMeta) $diagRunMeta.textContent = `Scanned ${data.rowsScanned || 0} rows in ${data.durationMs || 0}ms using ${data.templates || 0} templates`;
    setStatus(`Diagnostics complete: ${state.diagnosticsFindings.length} finding(s).`);
  } catch (_err) {
    setStatus("Diagnostics request failed.");
  }
}

async function jumpToFinding(finding) {
  if (!finding) return;
  if (finding.reportKey) selectReport(finding.reportKey);
  if (finding.attributeLabel) {
    const attr = state.attributes.find((a) => a.label === finding.attributeLabel);
    if (attr) {
      state.selectedAttribute = attr.key;
      enforceSingleAttributeSelection();
      renderAttributes();
      renderInstances();
    }
  }
  const attr = currentAttribute();
  if (attr && Array.isArray(finding.instances) && finding.instances.length > 0) {
    state.selected.clear();
    const targets = finding.instances.map((x) => String(x).toLowerCase());
    attr.items.forEach((item) => {
      const raw = (item.instance || "").toLowerCase();
      const compact = compactInstanceName(item).toLowerCase();
      if (targets.some((t) => raw.includes(t) || compact.includes(t))) state.selected.add(item.idx);
    });
    if (state.selected.size === 0) {
      attr.items.slice(0, 1).forEach((item) => state.selected.add(item.idx));
    }
    renderInstances();
  }
  await loadSeries();
  if (Number.isFinite(finding.start) && Number.isFinite(finding.end) && finding.end > finding.start) {
    zoomToRange(finding.start, finding.end);
  }
}

function cloneSeries(series) {
  return (series || []).map((s) => ({
    ...s,
    values: Array.isArray(s.values) ? [...s.values] : [],
  }));
}

function cloneFilter(filter) {
  const f = filter || {};
  return {
    min: Number.isFinite(f.min) ? f.min : null,
    max: Number.isFinite(f.max) ? f.max : null,
  };
}

function makeWindowFromCurrent(name) {
  return {
    id: `w-${state.windowSeq++}`,
    name,
    selected: new Set(state.selected),
    selectedAttribute: state.selectedAttribute,
    activeReport: state.activeReport,
    times: [...state.times],
    rawSeries: cloneSeries(state.rawSeries),
    series: cloneSeries(state.series),
    view: { ...state.view },
    zoomStack: [...state.zoomStack],
    panSpan: state.panSpan,
    search: $search.value || "",
    instanceSearch: $instanceSearch.value || "",
    filter: cloneFilter(state.filter),
    status: $status.textContent || "Idle",
  };
}

function saveCurrentWindowState() {
  const w = state.windows.find((x) => x.id === state.activeWindowId);
  if (!w) return;
  w.selected = new Set(state.selected);
  w.selectedAttribute = state.selectedAttribute;
  w.activeReport = state.activeReport;
  w.times = [...state.times];
  w.rawSeries = cloneSeries(state.rawSeries);
  w.series = cloneSeries(state.series);
  w.view = { ...state.view };
  w.zoomStack = [...state.zoomStack];
  w.panSpan = state.panSpan;
  w.search = $search.value || "";
  w.instanceSearch = $instanceSearch.value || "";
  w.filter = cloneFilter(state.filter);
  w.status = $status.textContent || "Idle";
}

function loadWindowState(w) {
  if (!w) return;
  state.selected = new Set(w.selected);
  state.selectedAttribute = w.selectedAttribute;
  state.activeReport = w.activeReport || null;
  state.times = [...w.times];
  state.rawSeries = cloneSeries(w.rawSeries);
  state.series = cloneSeries(w.series);
  state.view = { ...w.view };
  state.zoomStack = [...w.zoomStack];
  state.panSpan = w.panSpan;
  $search.value = w.search || "";
  $instanceSearch.value = w.instanceSearch || "";
  state.filter = cloneFilter(w.filter);
  syncFilterInputs();
  $status.textContent = w.status || "Idle";
}

function renderWindowTabs() {
  $windowTabs.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.windows.forEach((w) => {
    const btn = document.createElement("button");
    btn.className = "window-tab";
    if (w.id === state.activeWindowId) btn.classList.add("active");
    btn.textContent = w.name;
    btn.addEventListener("click", () => switchWindow(w.id));
    btn.addEventListener("dblclick", () => {
      const next = window.prompt("Rename window", w.name);
      if (next === null) return;
      const name = next.trim();
      if (!name) return;
      w.name = name;
      renderWindowTabs();
    });
    frag.appendChild(btn);
  });
  $windowTabs.appendChild(frag);
}

function switchWindow(id) {
  if (id === state.activeWindowId) return;
  saveCurrentWindowState();
  const w = state.windows.find((x) => x.id === id);
  if (!w) return;
  state.activeWindowId = id;
  loadWindowState(w);
  renderWindowTabs();
  renderReports();
  renderAttributes();
  renderInstances();
  drawChart();
}

function createWindow(cloneCurrent = true) {
  if (cloneCurrent) saveCurrentWindowState();
  if (cloneCurrent && state.windows.length > 0) {
    const base = state.windows.find((x) => x.id === state.activeWindowId);
    if (base) {
      const w = {
        ...base,
        id: `w-${state.windowSeq++}`,
        name: `Window ${state.windowSeq - 1}`,
        selected: new Set(base.selected),
        times: [...base.times],
        series: cloneSeries(base.series),
        view: { ...base.view },
        zoomStack: [...base.zoomStack],
      };
      state.windows.push(w);
      state.activeWindowId = w.id;
      loadWindowState(w);
      renderWindowTabs();
      renderReports();
      renderAttributes();
      renderInstances();
      drawChart();
      return;
    }
  }
  const w = makeWindowFromCurrent(`Window ${state.windowSeq}`);
  state.windows.push(w);
  state.activeWindowId = w.id;
  loadWindowState(w);
  renderWindowTabs();
  renderReports();
  renderAttributes();
  renderInstances();
  drawChart();
}

function closeActiveWindow() {
  if (state.windows.length <= 1) {
    setStatus("At least one window is required.");
    return;
  }
  const idx = state.windows.findIndex((x) => x.id === state.activeWindowId);
  if (idx < 0) return;
  state.windows.splice(idx, 1);
  const next = state.windows[Math.max(0, idx - 1)];
  state.activeWindowId = next.id;
  loadWindowState(next);
  renderWindowTabs();
  renderReports();
  renderAttributes();
  renderInstances();
  drawChart();
}

function parsePDHColumn(raw, idx) {
  const fallback = {
    idx,
    raw,
    object: "Other",
    instance: "Global",
    counter: raw,
    attributeKey: `Other|${raw}`,
    attributeLabel: raw,
    unit: "value",
  };

  if (!raw || !raw.startsWith("\\\\")) return fallback;
  const parts = raw.split("\\");
  if (parts.length < 5) return fallback;

  const objectPart = parts[3] || "Other";
  const counter = parts.slice(4).join("\\") || raw;
  const objectBase = objectPart.split("(")[0] || objectPart;
  const instanceMatch = objectPart.match(/\((.*)\)/);
  const instance = instanceMatch ? instanceMatch[1] : "Global";

  let unit = "value";
  if (/^%/.test(counter) || /percent/i.test(counter)) unit = "%";
  else if (/MBytes/i.test(counter)) unit = "MBytes";
  else if (/KBytes/i.test(counter)) unit = "KBytes";
  else if (/Watts/i.test(counter)) unit = "Watts";
  else if (/MHz/i.test(counter)) unit = "MHz";
  else if (/\/sec/i.test(counter)) unit = "/sec";
  else if (/Latency|\bms\b/i.test(counter)) unit = "ms";

  const attributeKey = `${objectBase}|${counter}`;
  const attributeLabel = `${objectBase}: ${counter}`;

  return {
    idx,
    raw,
    object: objectBase,
    instance,
    counter,
    attributeKey,
    attributeLabel,
    unit,
  };
}

function currentAttribute() {
  return state.attributeMap.get(state.selectedAttribute) || null;
}

function updateSelectedAttributeHeader() {
  if (!$selectedAttributeLabel) return;
  const attr = currentAttribute();
  $selectedAttributeLabel.textContent = `Attribute: ${attr ? attr.label : "-"}`;
}

function resetDataState() {
  state.selected.clear();
  state.times = [];
  state.rawSeries = [];
  state.series = [];
  tooltipSeriesIndex = -1;
  state.view.start = null;
  state.view.end = null;
  state.zoomStack = [];
  state.panSpan = null;
  drawChart();
}

function syncFilterInputs() {
  if ($filterMin) $filterMin.value = Number.isFinite(state.filter.min) ? String(state.filter.min) : "";
  if ($filterMax) $filterMax.value = Number.isFinite(state.filter.max) ? String(state.filter.max) : "";
}

function parseOptionalNumber(value) {
  const raw = (value || "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function applySeriesFilter(baseSeries, filter) {
  if (!Array.isArray(baseSeries) || baseSeries.length === 0) return [];
  const f = cloneFilter(filter);
  const useMin = Number.isFinite(f.min);
  const useMax = Number.isFinite(f.max);
  if (!useMin && !useMax) return cloneSeries(baseSeries);

  return baseSeries.filter((s) => {
    const total = Array.isArray(s.values) ? s.values.length : 0;
    if (total === 0) return false;
    for (let i = 0; i < total; i += 1) {
      const v = s.values[i];
      if (!Number.isFinite(v)) continue;
      if (useMin && v < f.min) continue;
      if (useMax && v > f.max) continue;
      return true;
    }
    return false;
  });
}

function refreshFilteredSeries() {
  state.series = applySeriesFilter(state.rawSeries, state.filter);
  tooltipSeriesIndex = -1;
  drawChart();
}

function applyAdvancedFilterFromInputs() {
  const min = parseOptionalNumber($filterMin ? $filterMin.value : "");
  const max = parseOptionalNumber($filterMax ? $filterMax.value : "");

  if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
    setStatus("Invalid filter: Min value must be <= Max value.");
    return;
  }

  state.filter = { min, max };
  syncFilterInputs();
  refreshFilteredSeries();
  saveCurrentWindowState();
  const kept = state.series.length;
  const total = state.rawSeries.length;
  setStatus(`Filter applied: ${kept}/${total} instances shown.`);
}

function resetAdvancedFilter() {
  state.filter = { min: null, max: null };
  syncFilterInputs();
  refreshFilteredSeries();
  saveCurrentWindowState();
  setStatus("Filter reset.");
}

function buildAttributeModel() {
  state.attributeMap = new Map();
  state.parsedColumns.forEach((item) => {
    const entry = state.attributeMap.get(item.attributeKey) || {
      key: item.attributeKey,
      label: item.attributeLabel,
      unit: item.unit,
      items: [],
    };
    entry.items.push(item);
    state.attributeMap.set(item.attributeKey, entry);
  });

  state.attributes = Array.from(state.attributeMap.values()).sort((a, b) => a.label.localeCompare(b.label));
  state.selectedAttribute = state.attributes.length > 0 ? state.attributes[0].key : null;
  buildReportsModel();
}

function buildReportsModel() {
  const defs = [
    { key: "cpu", label: "CPU", patterns: [/cpu/i, /vcpu/i, /group cpu/i, /% used/i, /% ready/i] },
    { key: "memory", label: "Memory", patterns: [/memory/i, /swap/i, /memctl/i, /compressed/i, /group memory/i] },
    { key: "numa", label: "NUMA", patterns: [/numa/i] },
    { key: "power", label: "Power", patterns: [/power/i, /watts/i, /pstate/i, /cstate/i] },
    { key: "network", label: "Network", patterns: [/\bnet/i, /nic/i, /network/i] },
    { key: "storage", label: "Storage", patterns: [/disk/i, /datastore/i, /storage/i, /latency/i, /iops/i] },
    { key: "vsan", label: "vSAN", patterns: [/vsan/i] },
  ];

  const reportMap = new Map(defs.map((d) => [d.key, { key: d.key, label: d.label, attrs: [] }]));
  const other = { key: "other", label: "Other", attrs: [] };

  state.attributes.forEach((attr) => {
    let assignedKey = "other";
    for (const def of defs) {
      if (def.patterns.some((p) => p.test(attr.label))) {
        assignedKey = def.key;
        break;
      }
    }
    attr.reportKey = assignedKey;
    if (assignedKey === "other") {
      other.attrs.push(attr);
    } else {
      const bucket = reportMap.get(assignedKey);
      if (bucket) bucket.attrs.push(attr);
    }
  });

  const reports = defs.map((d) => reportMap.get(d.key)).filter((r) => r && r.attrs.length > 0);
  if (other.attrs.length > 0) reports.push(other);
  const all = { key: "all", label: "All", attrs: [...state.attributes] };
  state.reports = [all, ...reports];

  if (!state.activeReport || !state.reports.some((r) => r.key === state.activeReport)) state.activeReport = "all";
}

function renderReports() {
  $reports.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.reports.forEach((report) => {
    const btn = document.createElement("button");
    btn.className = "btn ghost";
    btn.textContent = report.label;
    btn.dataset.report = report.key;
    if (state.activeReport === report.key) btn.classList.add("active");
    btn.addEventListener("click", () => selectReport(report.key));
    frag.appendChild(btn);
  });
  $reports.appendChild(frag);
}

function getVisibleAttributes() {
  let attrs = state.attributes;
  if (state.activeReport && state.activeReport !== "all") {
    attrs = attrs.filter((a) => a.reportKey === state.activeReport);
  }
  const filter = ($search.value || "").trim().toLowerCase();
  if (!filter) return attrs;
  return attrs.filter((a) => a.label.toLowerCase().includes(filter));
}

function enforceSingleAttributeSelection() {
  const attr = currentAttribute();
  if (!attr) return;
  const allowed = new Set(attr.items.map((item) => item.idx));
  for (const idx of Array.from(state.selected.values())) {
    if (!allowed.has(idx)) state.selected.delete(idx);
  }
}

function compactInstanceName(item) {
  if (!item) return "";
  const instance = (item.instance || "").trim();
  const obj = (item.object || "").toLowerCase();
  if (instance === "") return `#${item.idx}`;

  if (obj === "vcpu") {
    const parts = instance.split(":");
    if (parts.length >= 2) {
      const num = parts[0].trim();
      const name = parts[parts.length - 1].trim();
      if (num && name) return `vCPU ${num} ${name}`;
      if (name) return name;
    }
  }
  if (obj.startsWith("physical cpu")) {
    return `pCPU ${instance}`;
  }
  return instance;
}

function compactSeriesNameFromRaw(rawName) {
  if (!rawName) return "";
  const suffixMatch = rawName.match(/\s+\[home \d+\]$/i);
  const suffix = suffixMatch ? suffixMatch[0] : "";
  const base = suffix ? rawName.slice(0, -suffix.length) : rawName;
  const parsed = parsePDHColumn(base, -1);
  const compact = compactInstanceName(parsed);
  if (!compact) return rawName;
  return `${compact}${suffix}`;
}

function getVisibleInstances(attr) {
  if (!attr) return [];
  const filter = ($instanceSearch.value || "").trim().toLowerCase();
  return [...attr.items]
    .filter((a) => {
      if (filter === "") return true;
      const raw = (a.instance || "").toLowerCase();
      const compact = compactInstanceName(a).toLowerCase();
      return raw.includes(filter) || compact.includes(filter);
    })
    .sort((a, b) => a.instance.localeCompare(b.instance));
}

function renderAttributes() {
  const visible = getVisibleAttributes();
  $attributes.innerHTML = "";

  const frag = document.createDocumentFragment();
  visible.forEach((attr) => {
    const label = document.createElement("label");
    if (state.selectedAttribute === attr.key) label.classList.add("active");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "attribute";
    radio.checked = state.selectedAttribute === attr.key;
    radio.addEventListener("change", () => {
      state.selectedAttribute = attr.key;
      enforceSingleAttributeSelection();
      renderAttributes();
      renderInstances();
      drawChart();
    });

    const name = document.createElement("div");
    name.textContent = attr.label;

    const count = document.createElement("span");
    count.textContent = state.selectedAttribute === attr.key ? `${attr.items.length} instances` : "";

    label.appendChild(radio);
    label.appendChild(name);
    label.appendChild(count);
    frag.appendChild(label);
  });

  $attributes.appendChild(frag);
  updateSelectedAttributeHeader();
}

function renderInstances() {
  const attr = currentAttribute();
  $instances.innerHTML = "";
  if (!attr) return;

  enforceSingleAttributeSelection();
  const sorted = getVisibleInstances(attr);
  const frag = document.createDocumentFragment();

  sorted.forEach((item) => {
    const label = document.createElement("label");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(item.idx);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(item.idx);
      else state.selected.delete(item.idx);
    });

    const name = document.createElement("div");
    name.textContent = item.instance;

    label.appendChild(checkbox);
    label.appendChild(name);
    frag.appendChild(label);
  });

  $instances.appendChild(frag);
}

function selectReport(type) {
  const report = state.reports.find((r) => r.key === type);
  if (!report || report.attrs.length === 0) return;
  state.activeReport = report.key;
  if (!report.attrs.some((a) => a.key === state.selectedAttribute)) {
    const first = report.attrs[0];
    if (!first) return;
    state.selectedAttribute = first.key;
    state.selected.clear();
    first.items.slice(0, 4).forEach((item) => state.selected.add(item.idx));
  }
  renderAttributes();
  renderInstances();
  renderReports();
  saveCurrentWindowState();
}

function applyMeta(data) {
  state.columns = data.columns || [];
  state.file = data.file || "";
  state.rows = data.rows || 0;
  state.range.start = data.start || null;
  state.range.end = data.end || null;
  state.parsedColumns = state.columns
    .map((col, idx) => parsePDHColumn(col, idx))
    .filter((item) => item.idx > 0);
  state.indexMap = new Map(state.parsedColumns.map((item) => [item.idx, item]));

  buildAttributeModel();
  resetDataState();
  state.filter = { min: null, max: null };
  state.marks = [];
  state.markSeq = 1;
  state.selectedMarkId = null;
  state.contextMarkId = null;
  state.hoveredMarkId = null;
  updateMarkButtons();
  hideMarkMenu();
  state.diagnosticsFindings = [];
  renderDiagnosticFindings();
  if ($diagRunMeta) $diagRunMeta.textContent = "";

  $filePath.textContent = state.file;

  const initialAttr = state.attributes.find((a) => /Cpu Load.*1 Minute Avg/i.test(a.label)) || state.attributes[0];
  if (initialAttr) {
    state.selectedAttribute = initialAttr.key;
    state.activeReport = "all";
    initialAttr.items.slice(0, 2).forEach((item) => state.selected.add(item.idx));
  }

  state.windows = [];
  state.activeWindowId = null;
  state.windowSeq = 1;
  const firstWindow = makeWindowFromCurrent("Window 1");
  state.windows.push(firstWindow);
  state.activeWindowId = firstWindow.id;
  loadWindowState(firstWindow);
  renderWindowTabs();

  renderReports();
  renderAttributes();
  renderInstances();
  syncFilterInputs();
}

async function loadMeta() {
  const res = await apiFetch("/api/meta");
  const data = await res.json();
  applyMeta(data);
}

async function openPickedFile() {
  const file = $filePicker.files && $filePicker.files[0];
  if (!file) {
    setStatus("Select a CSV file first.");
    return;
  }

  setStatus(`Uploading ${file.name}...`);
  const form = new FormData();
  form.append("file", file);

  const res = await apiFetch("/api/upload", {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    setStatus(data.error || "Failed to open CSV");
    return;
  }

  await loadMeta();
  await loadSeries();
}

async function openFromURL() {
  const raw = ($urlInput.value || "").trim();
  if (raw === "") {
    setStatus("Enter a CSV URL first.");
    return;
  }
  setStatus("Loading CSV from URL...");
  try {
    const res = await apiFetch("/api/open-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: raw }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      setStatus(data.error || "Failed to load URL");
      return;
    }
    await loadMeta();
    await loadSeries();
  } catch (_err) {
    setStatus("Failed to access URL.");
  }
}

function downloadScreenshot() {
  if ($chart.width < 2 || $chart.height < 2) {
    setStatus("Nothing to screenshot yet.");
    return;
  }
  const out = document.createElement("canvas");
  const titleH = 48;
  out.width = $chart.width;
  out.height = $chart.height + titleH;
  const octx2 = out.getContext("2d");
  octx2.fillStyle = getCSSVar("--bg", "#0b0f16");
  octx2.fillRect(0, 0, out.width, out.height);
  octx2.drawImage($chart, 0, titleH);
  // Include overlay layer so screenshot captures marks/crosshair annotations.
  octx2.drawImage($overlay, 0, titleH);
  const attr = currentAttribute();
  const domain = computeDomain();
  const title = attr ? attr.label : "Graph";
  const subtitle = domain ? `${fmtTime(domain.start)} to ${fmtTime(domain.end)}` : "";
  octx2.fillStyle = getCSSVar("--text", "#e6e8ef");
  octx2.font = "600 14px Figtree, Segoe UI, sans-serif";
  octx2.fillText(title, 12, 20);
  octx2.fillStyle = getCSSVar("--muted", "#9aa2b2");
  octx2.font = "12px JetBrains Mono, ui-monospace, monospace";
  octx2.fillText(subtitle, 12, 38);
  const link = document.createElement("a");
  const suggested = `esx-doctor-${(title || "graph").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "graph"}`;
  const entered = window.prompt("Screenshot file name", suggested);
  if (entered === null) return;
  const trimmed = entered.trim();
  const baseName = trimmed === "" ? suggested : trimmed.replace(/[\\/:*?"<>|]+/g, "-");
  link.download = `${baseName}.png`;
  link.href = out.toDataURL("image/png");
  link.click();
}

function resizeCanvas() {
  const rect = $chart.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;

  $chart.width = Math.max(1, Math.floor(rect.width * ratio));
  $chart.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  $overlay.width = Math.max(1, Math.floor(rect.width * ratio));
  $overlay.height = Math.max(1, Math.floor(rect.height * ratio));
  octx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function computeDomain() {
  if (state.times.length === 0) return null;
  const start = state.view.start ?? state.times[0];
  const end = state.view.end ?? state.times[state.times.length - 1];
  return { start, end };
}

function isZoomed() {
  if (state.times.length < 2) return false;
  return Number.isFinite(state.view.start) && Number.isFinite(state.view.end);
}

function updateZoomPanUI() {
  if (!isZoomed()) {
    $zoomPanWrap.classList.add("hidden");
    return;
  }
  $zoomPanWrap.classList.remove("hidden");

  const startIdx = Math.max(0, Math.min(binarySearchTimes(state.view.start), state.times.length - 2));
  let span = Number.isInteger(state.panSpan) ? state.panSpan : null;
  if (span === null || span < 1) {
    let endIdx = Math.max(0, Math.min(binarySearchTimes(state.view.end), state.times.length - 1));
    if (state.times[endIdx] > state.view.end && endIdx > 0) endIdx -= 1;
    span = Math.max(1, endIdx - startIdx);
    state.panSpan = span;
  }

  const maxStart = Math.max(0, state.times.length - 1 - span);

  const clampedStart = Math.max(0, Math.min(startIdx, maxStart));
  const trackW = Math.max(1, $zoomPanTrack.clientWidth);
  const ratio = (span + 1) / Math.max(1, state.times.length);
  const minPx = 16;
  const winW = Math.min(trackW, Math.max(minPx, Math.round(trackW * ratio)));
  const maxLeft = Math.max(0, trackW - winW);
  const left = maxStart > 0 ? Math.round((clampedStart / maxStart) * maxLeft) : 0;

  $zoomPanWindow.style.width = `${winW}px`;
  $zoomPanWindow.style.left = `${left}px`;
  $zoomPanTrack.dataset.span = String(span);
  $zoomPanTrack.dataset.maxStart = String(maxStart);
  $zoomPanTrack.dataset.startIdx = String(clampedStart);
  $zoomPanLabel.textContent = `Zoom window: ${fmtTime(state.view.start)} to ${fmtTime(state.view.end)}`;
}

function applyPanStartIndex(startIdx) {
  if (state.times.length < 2) return;
  const span = Number.isInteger(state.panSpan) ? state.panSpan : 1;
  const maxStart = Math.max(0, state.times.length - 1 - span);
  const clampedStart = Math.max(0, Math.min(startIdx, maxStart));
  const endIdx = Math.min(state.times.length - 1, clampedStart + span);
  state.view.start = state.times[clampedStart];
  state.view.end = state.times[endIdx];
  drawChart();
}

function computeYRange(domain) {
  let min = Infinity;
  let max = -Infinity;

  state.series.forEach((s) => {
    s.values.forEach((v, i) => {
      const t = state.times[i];
      if (t < domain.start || t > domain.end) return;
      if (!Number.isFinite(v)) return;
      if (v < min) min = v;
      if (v > max) max = v;
    });
  });

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  return { min, max };
}

function resolveYUnit() {
  const attr = currentAttribute();
  return attr ? (attr.unit || "value") : "value";
}

function drawChart() {
  resizeCanvas();
  const rect = $chart.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  if (state.times.length === 0 || state.series.length === 0) {
    $zoomPanWrap.classList.add("hidden");
    hoverPoint = null;
    redrawOverlay();
    ctx.fillStyle = getCSSVar("--chart-empty", "#9aa2b2");
    ctx.font = "14px var(--font-sans)";
    ctx.fillText("No data loaded", 24, 32);
    return;
  }

  const padding = { left: 74, right: 18, top: 20, bottom: 56 };
  const plotW = rect.width - padding.left - padding.right;
  const plotH = rect.height - padding.top - padding.bottom;
  if (plotW <= 5 || plotH <= 5) return;

  const domain = computeDomain();
  const yrange = computeYRange(domain);
  const colors = getSeriesPalette();
  const axisColor = getCSSVar("--chart-axis", "#3a455d");
  const gridColor = getCSSVar("--chart-grid", "#273347");
  const tickColor = getCSSVar("--chart-tick", "#9aa2b2");
  const labelColor = getCSSVar("--chart-label", "#b4bdcf");

  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + plotH);
  ctx.lineTo(padding.left + plotW, padding.top + plotH);
  ctx.stroke();

  ctx.strokeStyle = gridColor;
  ctx.beginPath();
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotH / 4) * i;
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
  }
  ctx.stroke();

  ctx.fillStyle = tickColor;
  ctx.font = "11px var(--font-mono)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i += 1) {
    const value = yrange.max - ((yrange.max - yrange.min) / 4) * i;
    const y = padding.top + (plotH / 4) * i;
    ctx.fillText(value.toFixed(2), padding.left - 8, y);
  }

  const xTicks = 4;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i <= xTicks; i += 1) {
    const x = padding.left + (plotW / xTicks) * i;
    const t = domain.start + ((domain.end - domain.start) / xTicks) * i;
    const label = new Date(t).toISOString().slice(11, 19);
    ctx.fillText(label, x, padding.top + plotH + 8);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = labelColor;
  ctx.fillText("Time (UTC)", padding.left + plotW / 2, rect.height - 6);

  state.yUnit = resolveYUnit();
  ctx.save();
  ctx.translate(16, padding.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = labelColor;
  ctx.fillText(`Value (${state.yUnit})`, 0, 0);
  ctx.restore();

  state.series.forEach((s, idx) => {
    ctx.strokeStyle = colors[idx % colors.length];
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;

    s.values.forEach((v, i) => {
      const t = state.times[i];
      if (t < domain.start || t > domain.end) return;
      if (!Number.isFinite(v)) return;
      const x = padding.left + ((t - domain.start) / (domain.end - domain.start || 1)) * plotW;
      const y = padding.top + (1 - (v - yrange.min) / (yrange.max - yrange.min || 1)) * plotH;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();
  });

  updateZoomPanUI();
  redrawOverlay();
}

function binarySearchTimes(target) {
  let lo = 0;
  let hi = state.times.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (state.times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function showTooltip(x, y) {
  if (state.times.length === 0) return;
  if (tooltipHovered) return;

  const rect = $chart.getBoundingClientRect();
  const padding = { left: 74, right: 18, top: 20, bottom: 56 };
  const plotW = rect.width - padding.left - padding.right;
  const plotH = rect.height - padding.top - padding.bottom;

  if (x < padding.left || x > padding.left + plotW || y < padding.top || y > padding.top + plotH) {
    $tooltip.style.display = "none";
    tooltipSeriesIndex = -1;
    return;
  }

  const domain = computeDomain();
  const t = domain.start + ((x - padding.left) / plotW) * (domain.end - domain.start);
  const idx = Math.min(binarySearchTimes(t), state.times.length - 1);
  const timeValue = state.times[idx];

  if (idx !== tooltipSeriesIndex) {
    const colors = getSeriesPalette();
    const rows = state.series.map((s, i) => ({
      name: s.name,
      color: colors[i % colors.length],
      value: s.values[idx],
    }));

    rows.sort((a, b) => {
      const af = Number.isFinite(a.value);
      const bf = Number.isFinite(b.value);
      if (af && bf) return b.value - a.value;
      if (af) return -1;
      if (bf) return 1;
      return a.name.localeCompare(b.name);
    });

    const lines = [`<strong>${fmtTime(timeValue)}</strong>`];
    rows.forEach((r) => {
      const valueText = Number.isFinite(r.value) ? `${r.value.toFixed(3)} ${state.yUnit}` : "n/a";
      lines.push(`<span style=\"color:${r.color}\">${r.name}</span>: ${valueText}`);
    });
    $tooltip.innerHTML = lines.join("<br>");
    tooltipSeriesIndex = idx;
  }
  $tooltip.style.display = "block";

  const offset = 14;
  const tw = $tooltip.offsetWidth || 260;
  const th = $tooltip.offsetHeight || 120;
  const left = Math.max(8, Math.min(x + offset, rect.width - tw - 8));
  const top = Math.max(8, Math.min(y + offset, rect.height - th - 8));
  $tooltip.style.left = `${left}px`;
  $tooltip.style.top = `${top}px`;
}

function flushPointerMove() {
  pointerMoveRAF = 0;
  if (!pointerMovePending) return;
  const p = pointerMovePending;
  pointerMovePending = null;
  hoverPoint = { x: p.x, y: p.y };
  const hit = hitTestMark(p.x, p.y);
  state.hoveredMarkId = hit ? hit.id : null;
  if (dragStart) dragCurrentX = p.x;
  if (tooltipIdleTimer) {
    window.clearTimeout(tooltipIdleTimer);
    tooltipIdleTimer = 0;
  }
  tooltipIdlePoint = { x: p.x, y: p.y };
  if (dragStart) {
    $tooltip.style.display = "none";
    tooltipSeriesIndex = -1;
  } else if (state.hoveredMarkId) {
    $tooltip.style.display = "none";
    tooltipSeriesIndex = -1;
  } else {
    $tooltip.style.display = "none";
    tooltipIdleTimer = window.setTimeout(() => {
      tooltipIdleTimer = 0;
      if (!tooltipIdlePoint) return;
      showTooltip(tooltipIdlePoint.x, tooltipIdlePoint.y);
    }, tooltipIdleDelayMs);
  }
  redrawOverlay();
}

let dragStart = null;

function drawSelection(startX, currentX) {
  const rect = $overlay.getBoundingClientRect();
  const left = Math.min(startX, currentX);
  const right = Math.max(startX, currentX);
  octx.fillStyle = getCSSVar("--select-fill", "rgba(93, 214, 199, 0.15)");
  octx.strokeStyle = getCSSVar("--select-stroke", "rgba(93, 214, 199, 0.85)");
  octx.lineWidth = 1;
  octx.fillRect(left, 0, right - left, rect.height);
  octx.strokeRect(left, 0, right - left, rect.height);
}

function drawCrosshair(x, y) {
  const rect = $overlay.getBoundingClientRect();
  const padding = { left: 74, right: 18, top: 20, bottom: 56 };
  const plotW = rect.width - padding.left - padding.right;
  const plotH = rect.height - padding.top - padding.bottom;
  if (x < padding.left || x > padding.left + plotW || y < padding.top || y > padding.top + plotH) return;
  octx.strokeStyle = getCSSVar("--crosshair", "rgba(186, 196, 219, 0.55)");
  octx.lineWidth = 1;
  octx.setLineDash([4, 4]);
  octx.beginPath();
  octx.moveTo(x, padding.top);
  octx.lineTo(x, padding.top + plotH);
  octx.moveTo(padding.left, y);
  octx.lineTo(padding.left + plotW, y);
  octx.stroke();
  octx.setLineDash([]);
}

function redrawOverlay() {
  const rect = $overlay.getBoundingClientRect();
  octx.clearRect(0, 0, rect.width, rect.height);
  drawMarks();
  if (hoverPoint) drawCrosshair(hoverPoint.x, hoverPoint.y);
  if (dragStart && Number.isFinite(dragCurrentX)) drawSelection(dragStart.x, dragCurrentX);
}

function clearSelection() {
  dragCurrentX = null;
  redrawOverlay();
}

function zoomToRange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  if (state.times.length < 2) return;

  const domain = computeDomain();
  if (domain) state.zoomStack.push({ start: domain.start, end: domain.end, span: state.panSpan });

  const clampedStart = Math.max(start, state.range.start || start);
  const clampedEnd = Math.min(end, state.range.end || end);
  if (clampedEnd <= clampedStart) return;

  // Snap zoom bounds to actual timestamp samples to avoid empty windows.
  let iStart = binarySearchTimes(clampedStart);
  let iEnd = binarySearchTimes(clampedEnd);
  iStart = Math.max(0, Math.min(iStart, state.times.length - 1));
  iEnd = Math.max(0, Math.min(iEnd, state.times.length - 1));
  if (state.times[iEnd] > clampedEnd && iEnd > 0) iEnd -= 1;
  if (iEnd <= iStart) iEnd = Math.min(state.times.length - 1, iStart + 1);
  if (iEnd <= iStart) return;

  state.view.start = state.times[iStart];
  state.view.end = state.times[iEnd];
  state.panSpan = iEnd - iStart;

  drawChart();
  setStatus(`Zoom ${fmtTime(state.view.start)} to ${fmtTime(state.view.end)}`);
}

function zoomOut() {
  if (state.zoomStack.length === 0) {
    state.view.start = null;
    state.view.end = null;
    state.panSpan = null;
    drawChart();
    return;
  }
  const prev = state.zoomStack.pop();
  if (!prev) return;

  state.view.start = prev.start;
  state.view.end = prev.end;
  state.panSpan = Number.isInteger(prev.span) ? prev.span : null;

  if (state.view.start === state.times[0] && state.view.end === state.times[state.times.length - 1]) {
    state.view.start = null;
    state.view.end = null;
    state.panSpan = null;
  }

  drawChart();
}

async function loadSeries() {
  const targetWindowId = state.activeWindowId;
  const attr = currentAttribute();
  if (!attr) {
    setStatus("No attribute selected.");
    return;
  }

  enforceSingleAttributeSelection();
  const cols = Array.from(state.selected.values()).sort((a, b) => a - b);
  if (cols.length === 0) {
    setStatus("Select at least one instance from the selected attribute.");
    return;
  }
  let requestedCols = cols;
  if (cols.length > loadSeriesSoftLimit) {
    const choice = await chooseLargeLoadAction(cols.length);
    if (choice === "cancel") {
      setStatus("Load canceled.");
      return;
    }
    if (choice === "suggested") {
      requestedCols = cols.slice(0, loadSeriesSoftLimit);
      state.selected = new Set(requestedCols);
      renderInstances();
      setStatus(`Loading first ${requestedCols.length}/${cols.length} instances for responsiveness...`);
    }
  }

  if (!(cols.length > loadSeriesSoftLimit && requestedCols.length < cols.length)) {
    setStatus("Loading full timestamps...");
  }
  const params = new URLSearchParams();
  requestedCols.forEach((c) => params.append("col", c));
  params.append("maxPoints", "0");
  if (Number.isFinite(state.range.start) && Number.isFinite(state.range.end)) {
    params.append("start", String(state.range.start));
    params.append("end", String(state.range.end));
  }

  let res;
  let data;
  try {
    res = await apiFetch(`/api/series?${params.toString()}`);
    data = await res.json();
  } catch (_err) {
    setStatus("Failed to load series data.");
    return;
  }
  if (!res.ok || data.error) {
    setStatus(data && data.error ? data.error : `Series request failed (${res.status})`);
    return;
  }

  const nextTimes = data.times || [];
  let nextSeries = (data.series || []).map((s, i) => {
    const idx = requestedCols[i];
    const item = state.indexMap.get(idx);
    return {
      ...s,
      name: item ? (compactInstanceName(item) || s.name) : (compactSeriesNameFromRaw(s.name) || s.name),
    };
  });
  const totalSeries = nextSeries.length;
  nextSeries = nextSeries.filter((s) => Array.isArray(s.values) && s.values.some((v) => Number.isFinite(v)));
  if (nextSeries.length < totalSeries) {
    setStatus(`Loaded ${nextSeries.length}/${totalSeries} plottable series (non-numeric/empty series skipped).`);
  }
  if (nextSeries.length === 0) {
    setStatus("No plottable numeric data in selected instances.");
  }
  const target = state.windows.find((w) => w.id === targetWindowId);
  if (target) {
    target.times = [...nextTimes];
    target.rawSeries = cloneSeries(nextSeries);
    target.series = cloneSeries(applySeriesFilter(nextSeries, state.filter));
    target.view = { start: null, end: null };
    target.zoomStack = [];
    target.panSpan = null;
  }
  if (state.activeWindowId !== targetWindowId) return;
  state.times = nextTimes;
  state.rawSeries = cloneSeries(nextSeries);
  state.series = applySeriesFilter(nextSeries, state.filter);
  tooltipSeriesIndex = -1;
  state.view.start = null;
  state.view.end = null;
  state.zoomStack = [];
  state.panSpan = null;

  drawChart();
  if (nextSeries.length > 0) setStatus("Ready");
  saveCurrentWindowState();
}

$search.addEventListener("input", () => {
  const visible = getVisibleAttributes();
  if (!visible.some((a) => a.key === state.selectedAttribute)) {
    state.selectedAttribute = visible.length > 0 ? visible[0].key : null;
    enforceSingleAttributeSelection();
  }
  renderAttributes();
  renderInstances();
  saveCurrentWindowState();
});

document.getElementById("selectAllInstances").addEventListener("click", () => {
  const attr = currentAttribute();
  if (!attr) return;
  const visible = getVisibleInstances(attr);
  if (visible.length === 0) return;
  visible.forEach((item) => state.selected.add(item.idx));
  renderInstances();
});

document.getElementById("clearInstances").addEventListener("click", () => {
  const attr = currentAttribute();
  if (!attr) return;
  attr.items.forEach((item) => state.selected.delete(item.idx));
  renderInstances();
});
$instanceSearch.addEventListener("input", () => {
  renderInstances();
  saveCurrentWindowState();
});

document.getElementById("openFile").addEventListener("click", () => openPickedFile());
document.getElementById("openUrl").addEventListener("click", () => openFromURL());
if ($datasetTabFile) $datasetTabFile.addEventListener("click", () => setDatasetMode("file"));
if ($datasetTabUrl) $datasetTabUrl.addEventListener("click", () => setDatasetMode("url"));
document.getElementById("applyFilter").addEventListener("click", () => applyAdvancedFilterFromInputs());
document.getElementById("resetFilter").addEventListener("click", () => resetAdvancedFilter());
$urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") openFromURL();
});
document.getElementById("newWindow").addEventListener("click", () => createWindow(true));
document.getElementById("closeWindow").addEventListener("click", () => closeActiveWindow());
document.getElementById("openManual").addEventListener("click", () => {
  window.open("/manual", "_blank", "noopener,noreferrer");
});
if ($markMenuAdd) $markMenuAdd.addEventListener("click", () => {
  if (Number.isFinite(state.contextMenuX)) addMarkAtX(state.contextMenuX);
  hideMarkMenu();
});
if ($markMenuEdit) $markMenuEdit.addEventListener("click", () => {
  if (state.contextMarkId) {
    state.selectedMarkId = state.contextMarkId;
    editSelectedMark();
  }
  hideMarkMenu();
});
if ($markMenuDelete) $markMenuDelete.addEventListener("click", () => {
  if (state.contextMarkId) {
    state.selectedMarkId = state.contextMarkId;
    deleteSelectedMark();
  }
  hideMarkMenu();
});
if ($markMenuClear) $markMenuClear.addEventListener("click", () => {
  clearAllMarks();
  hideMarkMenu();
});
if ($markMenuColor) $markMenuColor.addEventListener("input", () => {
  state.markDraftColor = $markMenuColor.value;
  const mark = state.marks.find((m) => m.id === (state.contextMarkId || state.selectedMarkId));
  if (mark) {
    mark.color = $markMenuColor.value;
    redrawOverlay();
  }
});

document.getElementById("loadSeries").addEventListener("click", () => loadSeries());
document.getElementById("screenshot").addEventListener("click", () => downloadScreenshot());
if ($runDiagnostics) $runDiagnostics.addEventListener("click", () => runDiagnostics());
if ($openTemplateManager) {
  $openTemplateManager.addEventListener("click", () => {
    window.open(`/templates?sid=${encodeURIComponent(clientSessionID)}`, "_blank", "noopener,noreferrer");
  });
}
$zoomPanWindow.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const span = parseInt($zoomPanTrack.dataset.span || "1", 10);
  const maxStart = parseInt($zoomPanTrack.dataset.maxStart || "0", 10);
  const startIdx = parseInt($zoomPanTrack.dataset.startIdx || "0", 10);
  panDrag.active = true;
  panDrag.startX = e.clientX;
  panDrag.startIdx = Number.isFinite(startIdx) ? startIdx : 0;
  panDrag.span = Number.isFinite(span) ? span : 1;
  panDrag.maxStart = Number.isFinite(maxStart) ? maxStart : 0;
  $zoomPanWindow.classList.add("dragging");
});

$zoomPanTrack.addEventListener("mousedown", (e) => {
  if (e.target === $zoomPanWindow) return;
  if (state.times.length < 2 || !isZoomed()) return;
  const rect = $zoomPanTrack.getBoundingClientRect();
  const span = Number.isInteger(state.panSpan) ? state.panSpan : parseInt($zoomPanTrack.dataset.span || "1", 10);
  const maxStart = Math.max(0, state.times.length - 1 - span);
  const clickRatio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
  const targetStart = Math.round(clickRatio * maxStart);
  applyPanStartIndex(targetStart);
});

window.addEventListener("mousemove", (e) => {
  if (!panDrag.active) return;
  const rect = $zoomPanTrack.getBoundingClientRect();
  const winW = Math.max(1, $zoomPanWindow.offsetWidth);
  const maxLeft = Math.max(1, rect.width - winW);
  const dx = e.clientX - panDrag.startX;
  const deltaRatio = dx / maxLeft;
  const deltaIdx = Math.round(deltaRatio * panDrag.maxStart);
  applyPanStartIndex(panDrag.startIdx + deltaIdx);
});

window.addEventListener("mouseup", () => {
  if (!panDrag.active) return;
  panDrag.active = false;
  $zoomPanWindow.classList.remove("dragging");
});

$splitter.addEventListener("mousedown", (e) => {
  if (e.target === $sidebarToggleHandle) return;
  if (document.body.classList.contains("sidebar-collapsed")) return;
  splitDrag.active = true;
  e.preventDefault();
  document.body.style.userSelect = "none";
});

window.addEventListener("mousemove", (e) => {
  if (!splitDrag.active) return;
  const minW = 300;
  const maxW = Math.max(minW, window.innerWidth - 420);
  const width = Math.max(minW, Math.min(e.clientX, maxW));
  document.documentElement.style.setProperty("--sidebar-width", `${Math.round(width)}px`);
});

window.addEventListener("mouseup", () => {
  if (!splitDrag.active) return;
  splitDrag.active = false;
  document.body.style.userSelect = "";
  drawChart();
});
window.addEventListener("mouseup", () => {
  if (!markDrag.active) return;
  markDrag.active = false;
  markDrag.markID = null;
  document.body.style.userSelect = "";
});

document.getElementById("resetZoom").addEventListener("click", () => {
  state.view.start = null;
  state.view.end = null;
  state.zoomStack = [];
  state.panSpan = null;
  drawChart();
  setStatus("Zoom reset");
});

$overlay.addEventListener("mousedown", (e) => {
  hideMarkMenu();
  if (state.times.length === 0) return;
  if (tooltipIdleTimer) {
    window.clearTimeout(tooltipIdleTimer);
    tooltipIdleTimer = 0;
  }
  tooltipIdlePoint = null;
  $tooltip.style.display = "none";
  tooltipSeriesIndex = -1;
  if (e.shiftKey) {
    addMarkAtX(e.offsetX);
    return;
  }
  const hit = hitTestMark(e.offsetX, e.offsetY);
  if (hit) {
    state.selectedMarkId = hit.id;
    state.hoveredMarkId = hit.id;
    if (e.button === 0) {
      markDrag.active = true;
      markDrag.markID = hit.id;
      document.body.style.userSelect = "none";
    }
    updateMarkButtons();
    redrawOverlay();
    return;
  }
  dragStart = { x: e.offsetX };
  dragCurrentX = e.offsetX;
  hoverPoint = { x: e.offsetX, y: e.offsetY };
  redrawOverlay();
});

$overlay.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (state.times.length === 0) return;
  const hit = hitTestMark(e.offsetX, e.offsetY);
  state.contextMenuX = e.offsetX;
  showMarkMenu(e.clientX, e.clientY, hit);
});

$overlay.addEventListener("mousemove", (e) => {
  if (markDrag.active && markDrag.markID) {
    moveMarkToX(markDrag.markID, e.offsetX);
    return;
  }
  pointerMovePending = { x: e.offsetX, y: e.offsetY };
  if (!pointerMoveRAF) pointerMoveRAF = window.requestAnimationFrame(flushPointerMove);
});

$overlay.addEventListener("mouseup", (e) => {
  if (markDrag.active) {
    if (markDrag.markID) moveMarkToX(markDrag.markID, e.offsetX);
    markDrag.active = false;
    markDrag.markID = null;
    document.body.style.userSelect = "";
    return;
  }
  if (!dragStart) return;

  const rect = $chart.getBoundingClientRect();
  const startX = dragStart.x;
  const endX = e.offsetX;
  dragStart = null;
  clearSelection();

  const padding = { left: 74, right: 18 };
  const plotW = rect.width - padding.left - padding.right;
  const left = Math.max(0, Math.min(startX, endX) - padding.left);
  const right = Math.min(plotW, Math.max(startX, endX) - padding.left);
  if (right - left < plotW * 0.02) return;

  const domain = computeDomain();
  if (!domain) return;

  const tStart = domain.start + (left / plotW) * (domain.end - domain.start);
  const tEnd = domain.start + (right / plotW) * (domain.end - domain.start);
  zoomToRange(tStart, tEnd);
});

$overlay.addEventListener("dblclick", (e) => {
  const hit = hitTestMark(e.offsetX, e.offsetY);
  if (hit) {
    state.selectedMarkId = hit.id;
    state.hoveredMarkId = hit.id;
    updateMarkButtons();
    editSelectedMark();
    return;
  }
  if (!isZoomed()) return;
  zoomOut();
});

$overlay.addEventListener("mouseleave", (e) => {
  if (e.relatedTarget === $tooltip || $tooltip.contains(e.relatedTarget)) return;
  if (markDrag.active) {
    markDrag.active = false;
    markDrag.markID = null;
    document.body.style.userSelect = "";
  }
  hoverPoint = null;
  state.hoveredMarkId = null;
  $tooltip.style.display = "none";
  tooltipSeriesIndex = -1;
  if (tooltipIdleTimer) {
    window.clearTimeout(tooltipIdleTimer);
    tooltipIdleTimer = 0;
  }
  tooltipIdlePoint = null;
  pointerMovePending = null;
  if (pointerMoveRAF) {
    window.cancelAnimationFrame(pointerMoveRAF);
    pointerMoveRAF = 0;
  }
  if (!dragStart) {
    redrawOverlay();
    return;
  }
  dragStart = null;
  clearSelection();
  redrawOverlay();
});

$tooltip.addEventListener("mouseenter", () => {
  tooltipHovered = true;
});

$tooltip.addEventListener("mouseleave", () => {
  tooltipHovered = false;
});

window.addEventListener("resize", drawChart);
window.addEventListener("mousedown", (e) => {
  if ($markMenu && !$markMenu.classList.contains("hidden") && !$markMenu.contains(e.target)) hideMarkMenu();
});
window.addEventListener("keydown", (e) => {
  const el = e.target;
  const typingTarget = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
  const editModalOpen = $markEditModal && !$markEditModal.classList.contains("hidden");
  if (typingTarget || editModalOpen) return;
  if ((e.key === "Delete" || e.key === "Backspace") && state.selectedMarkId) {
    e.preventDefault();
    deleteSelectedMark();
  } else if ((e.key === "e" || e.key === "E") && state.selectedMarkId) {
    e.preventDefault();
    editSelectedMark();
  }
});

if ($themeSelect) {
  $themeSelect.addEventListener("change", () => {
    applyTheme($themeSelect.value);
  });
}
if ($sidebarToggleHandle) {
  $sidebarToggleHandle.addEventListener("click", () => {
    applySidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
  });
}

initTheme();
initSidebarState();
setDatasetMode("file");
updateMarkButtons();
renderDiagnosticFindings();
setupTemplateSync();
loadDiagnosticTemplates();
loadMeta().then(() => loadSeries());
