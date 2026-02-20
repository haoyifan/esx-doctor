const state = {
  columns: [],
  parsedColumns: [],
  indexMap: new Map(),
  attributes: [],
  attributeMap: new Map(),
  reports: [],
  selected: new Set(),
  selectedAttribute: null,
  times: [],
  series: [],
  range: { start: null, end: null },
  view: { start: null, end: null },
  zoomStack: [],
  file: "",
  rows: 0,
  yUnit: "value",
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

const $search = document.getElementById("search");
const $reports = document.getElementById("reports");
const $attributes = document.getElementById("attributes");
const $instances = document.getElementById("instances");
const $filePath = document.getElementById("filePath");
const $range = document.getElementById("range");
const $filePicker = document.getElementById("filePicker");
const $status = document.getElementById("status");
const $chart = document.getElementById("chart");
const $overlay = document.getElementById("overlay");
const $tooltip = document.getElementById("tooltip");
const $zoomPanWrap = document.getElementById("zoomPanWrap");
const $zoomPanLabel = document.getElementById("zoomPanLabel");
const $zoomPan = document.getElementById("zoomPan");

const ctx = $chart.getContext("2d");
const octx = $overlay.getContext("2d");
let tooltipHovered = false;

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").replace("Z", " UTC");
}

function setStatus(msg) {
  $status.textContent = msg;
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

function resetDataState() {
  state.selected.clear();
  state.times = [];
  state.series = [];
  state.view.start = null;
  state.view.end = null;
  state.zoomStack = [];
  drawChart();
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
    { key: "cpu", label: "CPU", patterns: [/cpu/i, /vcpu/i, /numa node.*processor/i, /% used/i, /% ready/i] },
    { key: "memory", label: "Memory", patterns: [/memory/i, /swap/i, /memctl/i, /compressed/i] },
    { key: "network", label: "Network", patterns: [/\bnet/i, /nic/i, /network/i] },
    { key: "storage", label: "Storage", patterns: [/disk/i, /datastore/i, /storage/i, /latency/i, /iops/i] },
    { key: "power", label: "Power", patterns: [/power/i, /watts/i] },
    { key: "numa", label: "NUMA", patterns: [/numa/i] },
    { key: "vsan", label: "vSAN", patterns: [/vsan/i] },
    { key: "groups", label: "Groups", patterns: [/group cpu/i, /group memory/i] },
  ];

  const reports = [];
  defs.forEach((def) => {
    const attrs = state.attributes.filter((a) => def.patterns.some((p) => p.test(a.label)));
    if (attrs.length > 0) {
      reports.push({ key: def.key, label: def.label, attrs });
    }
  });
  state.reports = reports;
}

function renderReports() {
  $reports.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.reports.forEach((report) => {
    const btn = document.createElement("button");
    btn.className = "btn ghost";
    btn.textContent = report.label;
    btn.dataset.report = report.key;
    btn.addEventListener("click", () => selectReport(report.key));
    frag.appendChild(btn);
  });
  $reports.appendChild(frag);
}

function getVisibleAttributes() {
  const filter = ($search.value || "").trim().toLowerCase();
  if (!filter) return state.attributes;
  return state.attributes.filter((a) => a.label.toLowerCase().includes(filter));
}

function enforceSingleAttributeSelection() {
  const attr = currentAttribute();
  if (!attr) return;
  const allowed = new Set(attr.items.map((item) => item.idx));
  for (const idx of Array.from(state.selected.values())) {
    if (!allowed.has(idx)) state.selected.delete(idx);
  }
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
    count.textContent = `${attr.items.length} instances`;

    label.appendChild(radio);
    label.appendChild(name);
    label.appendChild(count);
    frag.appendChild(label);
  });

  $attributes.appendChild(frag);
}

function renderInstances() {
  const attr = currentAttribute();
  $instances.innerHTML = "";
  if (!attr) return;

  enforceSingleAttributeSelection();

  const sorted = [...attr.items].sort((a, b) => a.instance.localeCompare(b.instance));
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

    const idx = document.createElement("span");
    idx.textContent = `#${item.idx}`;

    label.appendChild(checkbox);
    label.appendChild(name);
    label.appendChild(idx);
    frag.appendChild(label);
  });

  $instances.appendChild(frag);
}

function selectReport(type) {
  const report = state.reports.find((r) => r.key === type);
  if (!report || report.attrs.length === 0) return;
  const first = report.attrs[0];
  if (!first) return;

  state.selectedAttribute = first.key;
  state.selected.clear();
  first.items.slice(0, 4).forEach((item) => state.selected.add(item.idx));
  renderAttributes();
  renderInstances();

  $reports.querySelectorAll(".btn").forEach((b) => {
    if (b.dataset.report === type) b.classList.add("active");
    else b.classList.remove("active");
  });
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

  $filePath.textContent = state.file;
  if (state.range.start && state.range.end) {
    $range.textContent = `${fmtTime(state.range.start)} to ${fmtTime(state.range.end)} (${state.rows.toLocaleString()} rows)`;
  } else {
    $range.textContent = "";
  }

  const initialAttr = state.attributes.find((a) => /Cpu Load.*1 Minute Avg/i.test(a.label)) || state.attributes[0];
  if (initialAttr) {
    state.selectedAttribute = initialAttr.key;
    initialAttr.items.slice(0, 2).forEach((item) => state.selected.add(item.idx));
  }

  renderReports();
  renderAttributes();
  renderInstances();
}

async function loadMeta() {
  const res = await fetch("/api/meta");
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

  const res = await fetch("/api/upload", {
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

  const startIdx = Math.max(0, Math.min(binarySearchTimes(state.view.start), state.times.length - 1));
  let endIdx = Math.max(0, Math.min(binarySearchTimes(state.view.end), state.times.length - 1));
  if (state.times[endIdx] > state.view.end && endIdx > 0) endIdx -= 1;
  if (endIdx <= startIdx) endIdx = Math.min(state.times.length - 1, startIdx + 1);

  const span = Math.max(1, endIdx - startIdx);
  const maxStart = Math.max(0, state.times.length - 1 - span);

  $zoomPan.max = String(maxStart);
  $zoomPan.value = String(Math.min(startIdx, maxStart));
  $zoomPan.dataset.span = String(span);
  $zoomPanLabel.textContent = `Zoom window: ${fmtTime(state.view.start)} to ${fmtTime(state.view.end)}`;
  $zoomPanWrap.classList.remove("hidden");
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
    ctx.fillStyle = "#9aa2b2";
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

  ctx.strokeStyle = "#3a455d";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + plotH);
  ctx.lineTo(padding.left + plotW, padding.top + plotH);
  ctx.stroke();

  ctx.strokeStyle = "#273347";
  ctx.beginPath();
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotH / 4) * i;
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
  }
  ctx.stroke();

  ctx.fillStyle = "#9aa2b2";
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
  ctx.fillStyle = "#b4bdcf";
  ctx.fillText("Time (UTC)", padding.left + plotW / 2, rect.height - 6);

  state.yUnit = resolveYUnit();
  ctx.save();
  ctx.translate(16, padding.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#b4bdcf";
  ctx.fillText(`Value (${state.yUnit})`, 0, 0);
  ctx.restore();

  state.series.forEach((s, idx) => {
    ctx.strokeStyle = palette[idx % palette.length];
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
    return;
  }

  const domain = computeDomain();
  const t = domain.start + ((x - padding.left) / plotW) * (domain.end - domain.start);
  const idx = Math.min(binarySearchTimes(t), state.times.length - 1);
  const timeValue = state.times[idx];

  const rows = state.series.map((s, i) => ({
    name: s.name,
    color: palette[i % palette.length],
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
  $tooltip.style.display = "block";

  const offset = 14;
  const tw = $tooltip.offsetWidth || 260;
  const th = $tooltip.offsetHeight || 120;
  const left = Math.max(8, Math.min(x + offset, rect.width - tw - 8));
  const top = Math.max(8, Math.min(y + offset, rect.height - th - 8));
  $tooltip.style.left = `${left}px`;
  $tooltip.style.top = `${top}px`;
}

let dragStart = null;

function drawSelection(startX, currentX) {
  const rect = $overlay.getBoundingClientRect();
  octx.clearRect(0, 0, rect.width, rect.height);
  const left = Math.min(startX, currentX);
  const right = Math.max(startX, currentX);
  octx.fillStyle = "rgba(93, 214, 199, 0.15)";
  octx.strokeStyle = "rgba(93, 214, 199, 0.85)";
  octx.lineWidth = 1;
  octx.fillRect(left, 0, right - left, rect.height);
  octx.strokeRect(left, 0, right - left, rect.height);
}

function clearSelection() {
  const rect = $overlay.getBoundingClientRect();
  octx.clearRect(0, 0, rect.width, rect.height);
}

function zoomToRange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  if (state.times.length < 2) return;

  const domain = computeDomain();
  if (domain) state.zoomStack.push({ start: domain.start, end: domain.end });

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

  drawChart();
  setStatus(`Zoom ${fmtTime(state.view.start)} to ${fmtTime(state.view.end)}`);
}

function zoomOut() {
  if (state.zoomStack.length === 0) {
    state.view.start = null;
    state.view.end = null;
    drawChart();
    return;
  }
  const prev = state.zoomStack.pop();
  if (!prev) return;

  state.view.start = prev.start;
  state.view.end = prev.end;

  if (state.view.start === state.times[0] && state.view.end === state.times[state.times.length - 1]) {
    state.view.start = null;
    state.view.end = null;
  }

  drawChart();
  setStatus("Zoomed out");
}

async function loadSeries() {
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

  setStatus("Loading full timestamps...");
  const params = new URLSearchParams();
  cols.forEach((c) => params.append("col", c));
  params.append("maxPoints", "0");
  if (Number.isFinite(state.range.start) && Number.isFinite(state.range.end)) {
    params.append("start", String(state.range.start));
    params.append("end", String(state.range.end));
  }

  const res = await fetch(`/api/series?${params.toString()}`);
  const data = await res.json();
  if (data.error) {
    setStatus(data.error);
    return;
  }

  state.times = data.times || [];
  state.series = data.series || [];
  state.view.start = null;
  state.view.end = null;
  state.zoomStack = [];

  drawChart();
  setStatus(`Loaded ${state.times.length.toLocaleString()} timestamps, ${state.series.length} series`);
}

$search.addEventListener("input", () => {
  const visible = getVisibleAttributes();
  if (!visible.some((a) => a.key === state.selectedAttribute)) {
    state.selectedAttribute = visible.length > 0 ? visible[0].key : null;
    enforceSingleAttributeSelection();
  }
  renderAttributes();
  renderInstances();
});

document.getElementById("selectAllAttrs").addEventListener("click", () => {
  const visible = getVisibleAttributes();
  if (visible.length === 0) return;

  // Keep single-attribute mode: pick the first visible attribute and select its instances.
  const attr = visible[0];
  state.selectedAttribute = attr.key;
  state.selected.clear();
  attr.items.forEach((item) => state.selected.add(item.idx));
  renderAttributes();
  renderInstances();
});

document.getElementById("clearAll").addEventListener("click", () => {
  state.selected.clear();
  renderInstances();
});

document.getElementById("selectAllInstances").addEventListener("click", () => {
  const attr = currentAttribute();
  if (!attr) return;
  state.selected.clear();
  attr.items.forEach((item) => state.selected.add(item.idx));
  renderInstances();
});

document.getElementById("clearInstances").addEventListener("click", () => {
  const attr = currentAttribute();
  if (!attr) return;
  attr.items.forEach((item) => state.selected.delete(item.idx));
  renderInstances();
});

document.getElementById("openFile").addEventListener("click", () => openPickedFile());

document.getElementById("loadSeries").addEventListener("click", () => loadSeries());
document.getElementById("zoomOut").addEventListener("click", () => zoomOut());
$zoomPan.addEventListener("input", (e) => {
  if (state.times.length < 2) return;
  const span = parseInt($zoomPan.dataset.span || "0", 10);
  const startIdx = parseInt(e.target.value || "0", 10);
  if (!Number.isFinite(span) || span < 1) return;
  const endIdx = Math.min(state.times.length - 1, startIdx + span);
  state.view.start = state.times[startIdx];
  state.view.end = state.times[endIdx];
  drawChart();
});

document.getElementById("resetZoom").addEventListener("click", () => {
  state.view.start = null;
  state.view.end = null;
  state.zoomStack = [];
  drawChart();
  setStatus("Zoom reset");
});

$overlay.addEventListener("mousedown", (e) => {
  if (state.times.length === 0) return;
  dragStart = { x: e.offsetX };
});

$overlay.addEventListener("mousemove", (e) => {
  showTooltip(e.offsetX, e.offsetY);
  if (!dragStart) return;
  drawSelection(dragStart.x, e.offsetX);
});

$overlay.addEventListener("mouseup", (e) => {
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

$overlay.addEventListener("dblclick", () => {
  if (!isZoomed()) return;
  zoomOut();
});

$overlay.addEventListener("mouseleave", (e) => {
  if (e.relatedTarget === $tooltip || $tooltip.contains(e.relatedTarget)) return;
  $tooltip.style.display = "none";
  if (!dragStart) return;
  dragStart = null;
  clearSelection();
});

$tooltip.addEventListener("mouseenter", () => {
  tooltipHovered = true;
});

$tooltip.addEventListener("mouseleave", () => {
  tooltipHovered = false;
});

window.addEventListener("resize", drawChart);

loadMeta().then(() => loadSeries());
