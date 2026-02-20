const state = {
  columns: [],
  selected: new Set(),
  times: [],
  series: [],
  range: { start: null, end: null },
  view: { start: null, end: null },
  file: "",
  rows: 0,
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

const $columns = document.getElementById("columns");
const $search = document.getElementById("search");
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

function parseGroup(col) {
  if (col.startsWith("\\\\")) {
    const parts = col.split("\\");
    if (parts.length >= 5) return parts[3];
  }
  return "Other";
}

function renderColumns(filter = "") {
  $columns.innerHTML = "";
  const lower = filter.toLowerCase();
  const fragment = document.createDocumentFragment();

  state.columns.forEach((col, idx) => {
    if (filter && !col.toLowerCase().includes(lower)) return;
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(idx);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(idx);
      else state.selected.delete(idx);
    });
    const name = document.createElement("div");
    name.textContent = col;
    const group = document.createElement("span");
    group.textContent = parseGroup(col);
    label.appendChild(checkbox);
    label.appendChild(name);
    label.appendChild(group);
    fragment.appendChild(label);
  });

  $columns.appendChild(fragment);
}

function selectByReport(type) {
  state.selected.clear();
  const patterns = {
    cpu: [/\\Physical Cpu/i, /Cpu Load/i, /% Processor Time/i, /% Util Time/i],
    memory: [/\\Memory\\/i, /Memctl/i, /Swap/i],
    io: [/\\Disk/i, /IOPS/i, /Latency/i],
    network: [/\\Net/i, /\bNIC\b/i, /Network/i],
  };
  const pats = patterns[type] || [];
  state.columns.forEach((col, idx) => {
    if (pats.some((p) => p.test(col))) state.selected.add(idx);
  });
  renderColumns($search.value);
}

function setStatus(msg) {
  $status.textContent = msg;
}

async function loadMeta() {
  const res = await fetch("/api/meta");
  const data = await res.json();
  state.columns = data.columns || [];
  state.file = data.file || "";
  state.rows = data.rows || 0;
  state.range.start = data.start || null;
  state.range.end = data.end || null;

  $filePath.textContent = state.file;
  if (state.range.start && state.range.end) {
    $range.textContent = `${fmtTime(state.range.start)} to ${fmtTime(state.range.end)} (${state.rows.toLocaleString()} rows)`;
  }

  // Default selection: a small set of useful counters
  state.columns.forEach((col, idx) => {
    if (/Cpu Load \(1 Minute Avg\)/i.test(col)) state.selected.add(idx);
    if (/Physical Cpu\(_Total\)\\% Processor Time/i.test(col)) state.selected.add(idx);
    if (/Memory\\Free MBytes/i.test(col)) state.selected.add(idx);
  });

  renderColumns();
}

function resizeCanvas() {
  const rect = $chart.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  $chart.width = rect.width * ratio;
  $chart.height = rect.height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  $overlay.width = rect.width * ratio;
  $overlay.height = rect.height * ratio;
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
    max += 1;
    min -= 1;
  }
  return { min, max };
}

function drawChart() {
  resizeCanvas();
  ctx.clearRect(0, 0, $chart.width, $chart.height);

  if (state.times.length === 0) {
    ctx.fillStyle = "#9aa2b2";
    ctx.font = "14px var(--font-sans)";
    ctx.fillText("No data loaded", 24, 30);
    return;
  }

  const rect = $chart.getBoundingClientRect();
  const padding = { left: 56, right: 24, top: 20, bottom: 32 };
  const plotW = rect.width - padding.left - padding.right;
  const plotH = rect.height - padding.top - padding.bottom;

  const domain = computeDomain();
  const yrange = computeYRange(domain);

  ctx.strokeStyle = "#2a3242";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (plotH / 4) * i;
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
  }
  ctx.stroke();

  ctx.fillStyle = "#9aa2b2";
  ctx.font = "11px var(--font-mono)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const value = yrange.max - ((yrange.max - yrange.min) / 4) * i;
    const y = padding.top + (plotH / 4) * i;
    ctx.fillText(value.toFixed(2), padding.left - 6, y);
  }

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(fmtTime(domain.start), padding.left, padding.top + plotH + 8);
  ctx.textAlign = "right";
  ctx.fillText(fmtTime(domain.end), padding.left + plotW, padding.top + plotH + 8);

  state.series.forEach((s, idx) => {
    ctx.strokeStyle = palette[idx % palette.length];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    s.values.forEach((v, i) => {
      const t = state.times[i];
      if (t < domain.start || t > domain.end) return;
      if (!Number.isFinite(v)) return;
      const x = padding.left + ((t - domain.start) / (domain.end - domain.start)) * plotW;
      const y = padding.top + (1 - (v - yrange.min) / (yrange.max - yrange.min)) * plotH;
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
  const padding = { left: 56, right: 24, top: 20, bottom: 32 };
  const plotW = rect.width - padding.left - padding.right;
  const plotH = rect.height - padding.top - padding.bottom;
  if (x < padding.left || x > padding.left + plotW || y < padding.top || y > padding.top + plotH) {
    $tooltip.style.display = "none";
    return;
  }

  const domain = computeDomain();
  const t = domain.start + ((x - padding.left) / plotW) * (domain.end - domain.start);
  const idx = binarySearchTimes(t);
  const timeValue = state.times[idx];

  const lines = [];
  lines.push(`<strong>${fmtTime(timeValue)}</strong>`);
  state.series.forEach((s, i) => {
    const v = s.values[idx];
    const text = Number.isFinite(v) ? v.toFixed(3) : "n/a";
    lines.push(`<span style="color:${palette[i % palette.length]}">${s.name}</span>: ${text}`);
  });

  $tooltip.innerHTML = lines.join("<br>");
  $tooltip.style.display = "block";
  $tooltip.style.left = `${x + 16}px`;
  $tooltip.style.top = `${y + 16}px`;
}

let dragStart = null;

function drawSelection(startX, currentX) {
  octx.clearRect(0, 0, $overlay.width, $overlay.height);
  const rect = $chart.getBoundingClientRect();
  const left = Math.min(startX, currentX);
  const right = Math.max(startX, currentX);
  octx.fillStyle = "rgba(93, 214, 199, 0.15)";
  octx.strokeStyle = "rgba(93, 214, 199, 0.8)";
  octx.lineWidth = 1;
  octx.fillRect(left, 0, right - left, rect.height);
  octx.strokeRect(left, 0, right - left, rect.height);
}

function clearSelection() {
  octx.clearRect(0, 0, $overlay.width, $overlay.height);
}

async function loadSeries(rangeOverride = null) {
  const cols = Array.from(state.selected.values());
  if (cols.length === 0) {
    alert("Select at least one counter.");
    return;
  }
  setStatus("Loading...");
  const params = new URLSearchParams();
  cols.forEach((c) => params.append("col", c));
  params.append("maxPoints", "2000");

  if (rangeOverride) {
    params.append("start", String(rangeOverride.start));
    params.append("end", String(rangeOverride.end));
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
  setStatus(`Loaded ${state.times.length.toLocaleString()} points`);
}

$search.addEventListener("input", (e) => renderColumns(e.target.value));

document.getElementById("selectAll").addEventListener("click", () => {
  state.columns.forEach((_, idx) => state.selected.add(idx));
  renderColumns($search.value);
});

document.getElementById("clearAll").addEventListener("click", () => {
  state.selected.clear();
  renderColumns($search.value);
});

document.getElementById("loadSeries").addEventListener("click", () => loadSeries());

document.getElementById("resetZoom").addEventListener("click", () => {
  state.view.start = null;
  state.view.end = null;
  loadSeries();
});

document.querySelectorAll("[data-report]").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectByReport(btn.dataset.report);
  });
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

  const padding = { left: 56, right: 24 };
  const plotW = rect.width - padding.left - padding.right;
  const left = Math.min(startX, endX) - padding.left;
  const right = Math.max(startX, endX) - padding.left;
  if (right - left < plotW * 0.02) return;

  const domain = computeDomain();
  const tStart = domain.start + (left / plotW) * (domain.end - domain.start);
  const tEnd = domain.start + (right / plotW) * (domain.end - domain.start);

  loadSeries({ start: Math.max(tStart, state.range.start), end: Math.min(tEnd, state.range.end) });
});

window.addEventListener("resize", drawChart);

loadMeta().then(() => loadSeries());
