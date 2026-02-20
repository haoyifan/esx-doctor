const state = {
  columns: [],
  parsedColumns: [],
  attributes: [],
  attributeMap: new Map(),
  selected: new Set(),
  selectedAttribute: null,
  times: [],
  series: [],
  range: { start: null, end: null },
  view: { start: null, end: null },
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
const $attributes = document.getElementById("attributes");
const $instances = document.getElementById("instances");
const $filePath = document.getElementById("filePath");
const $range = document.getElementById("range");
const $status = document.getElementById("status");
const $chart = document.getElementById("chart");
const $overlay = document.getElementById("overlay");
const $tooltip = document.getElementById("tooltip");

const ctx = $chart.getContext("2d");
const octx = $overlay.getContext("2d");

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
  else if (/Latency|ms/i.test(counter)) unit = "ms";

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

  state.attributes = Array.from(state.attributeMap.values()).sort((a, b) => {
    return a.label.localeCompare(b.label);
  });

  if (!state.selectedAttribute && state.attributes.length > 0) {
    state.selectedAttribute = state.attributes[0].key;
  }
}

function getVisibleAttributes() {
  const filter = ($search.value || "").trim().toLowerCase();
  if (!filter) return state.attributes;
  return state.attributes.filter((a) => a.label.toLowerCase().includes(filter));
}

function renderAttributes() {
  const visible = getVisibleAttributes();
  const frag = document.createDocumentFragment();
  $attributes.innerHTML = "";

  visible.forEach((attr) => {
    const label = document.createElement("label");
    if (state.selectedAttribute === attr.key) label.classList.add("active");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "attribute";
    radio.checked = state.selectedAttribute === attr.key;
    radio.addEventListener("change", () => {
      state.selectedAttribute = attr.key;
      renderAttributes();
      renderInstances();
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
  const attr = state.attributeMap.get(state.selectedAttribute);
  $instances.innerHTML = "";
  if (!attr) return;

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
  const patterns = {
    cpu: [/Physical Cpu/i, /Cpu Load/i, /Vcpu:/i, /% Used/i, /% Processor Time/i, /% Util Time/i],
    memory: [/Memory:/i, /Memctl/i, /Swap/i],
    io: [/Disk/i, /Storage/i, /IOPS/i, /Latency/i],
    network: [/Net/i, /NIC/i, /Network/i],
  };

  const pat = patterns[type] || [];
  const first = state.attributes.find((a) => pat.some((p) => p.test(a.label)));
  if (first) {
    state.selectedAttribute = first.key;
    renderAttributes();
    renderInstances();
  }
}

async function loadMeta() {
  const res = await fetch("/api/meta");
  const data = await res.json();

  state.columns = data.columns || [];
  state.file = data.file || "";
  state.rows = data.rows || 0;
  state.range.start = data.start || null;
  state.range.end = data.end || null;
  state.parsedColumns = state.columns
    .map((col, idx) => parsePDHColumn(col, idx))
    .filter((item) => item.idx > 0);

  buildAttributeModel();
  renderAttributes();
  renderInstances();

  $filePath.textContent = state.file;
  if (state.range.start && state.range.end) {
    $range.textContent = `${fmtTime(state.range.start)} to ${fmtTime(state.range.end)} (${state.rows.toLocaleString()} rows)`;
  }

  // Initial selection for quick first render.
  const initialAttr = state.attributes.find((a) => /Cpu Load.*1 Minute Avg/i.test(a.label)) || state.attributes[0];
  if (initialAttr) {
    state.selectedAttribute = initialAttr.key;
    initialAttr.items.slice(0, 2).forEach((item) => state.selected.add(item.idx));
    renderAttributes();
    renderInstances();
  }
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
  const attr = state.attributeMap.get(state.selectedAttribute);
  if (!attr) return "value";
  return attr.unit || "value";
}

function drawChart() {
  resizeCanvas();
  const rect = $chart.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  if (state.times.length === 0 || state.series.length === 0) {
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

  const lines = [`<strong>${fmtTime(timeValue)}</strong>`];
  state.series.forEach((s, i) => {
    const v = s.values[idx];
    const text = Number.isFinite(v) ? `${v.toFixed(3)} ${state.yUnit}` : "n/a";
    lines.push(`<span style=\"color:${palette[i % palette.length]}\">${s.name}</span>: ${text}`);
  });

  $tooltip.innerHTML = lines.join("<br>");
  $tooltip.style.display = "block";
  $tooltip.style.left = `${x + 14}px`;
  $tooltip.style.top = `${y + 14}px`;
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

async function loadSeries(rangeOverride = null) {
  const cols = Array.from(state.selected.values()).sort((a, b) => a - b);
  if (cols.length === 0) {
    setStatus("Select at least one instance.");
    return;
  }

  setStatus("Loading...");
  const params = new URLSearchParams();
  cols.forEach((c) => params.append("col", c));
  params.append("maxPoints", "2000");

  if (rangeOverride) {
    params.append("start", String(Math.floor(rangeOverride.start)));
    params.append("end", String(Math.floor(rangeOverride.end)));
  } else if (state.view.start && state.view.end) {
    params.append("start", String(state.view.start));
    params.append("end", String(state.view.end));
  }

  const res = await fetch(`/api/series?${params.toString()}`);
  const data = await res.json();
  if (data.error) {
    setStatus(data.error);
    return;
  }

  state.times = data.times || [];
  state.series = data.series || [];
  if (rangeOverride) {
    state.view.start = rangeOverride.start;
    state.view.end = rangeOverride.end;
  } else {
    state.view.start = null;
    state.view.end = null;
  }

  drawChart();
  setStatus(`Loaded ${state.times.length.toLocaleString()} points, ${state.series.length} series`);
}

$search.addEventListener("input", () => {
  const visible = getVisibleAttributes();
  if (!visible.some((a) => a.key === state.selectedAttribute)) {
    state.selectedAttribute = visible.length > 0 ? visible[0].key : null;
  }
  renderAttributes();
  renderInstances();
});

document.getElementById("selectAllAttrs").addEventListener("click", () => {
  const visible = getVisibleAttributes();
  visible.forEach((attr) => {
    attr.items.forEach((item) => state.selected.add(item.idx));
  });
  renderInstances();
});

document.getElementById("clearAll").addEventListener("click", () => {
  state.selected.clear();
  renderInstances();
});

document.getElementById("selectAllInstances").addEventListener("click", () => {
  const attr = state.attributeMap.get(state.selectedAttribute);
  if (!attr) return;
  attr.items.forEach((item) => state.selected.add(item.idx));
  renderInstances();
});

document.getElementById("clearInstances").addEventListener("click", () => {
  const attr = state.attributeMap.get(state.selectedAttribute);
  if (!attr) return;
  attr.items.forEach((item) => state.selected.delete(item.idx));
  renderInstances();
});

document.getElementById("loadSeries").addEventListener("click", () => loadSeries());

document.getElementById("resetZoom").addEventListener("click", () => {
  state.view.start = null;
  state.view.end = null;
  loadSeries();
});

document.querySelectorAll("[data-report]").forEach((btn) => {
  btn.addEventListener("click", () => selectReport(btn.dataset.report));
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
  const left = Math.min(startX, endX) - padding.left;
  const right = Math.max(startX, endX) - padding.left;
  if (right - left < plotW * 0.02) return;

  const domain = computeDomain();
  const tStart = domain.start + (left / plotW) * (domain.end - domain.start);
  const tEnd = domain.start + (right / plotW) * (domain.end - domain.start);

  loadSeries({
    start: Math.max(tStart, state.range.start || tStart),
    end: Math.min(tEnd, state.range.end || tEnd),
  });
});

window.addEventListener("resize", drawChart);

loadMeta().then(() => loadSeries());
