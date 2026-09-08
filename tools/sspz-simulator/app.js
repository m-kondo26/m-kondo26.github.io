import {
  DEFAULT_PARAMS,
  MODEL_VERSION,
  PROFILE_MODES,
  RECONSTRUCTION_PATHS,
} from "./sim-core.js";

// Figure palette and typography follow the journal-facing conventions used by
// Medical Physics: black sans-serif text, gray gridlines, restrained color,
// and redundant line/marker encodings.  Japanese and future English labels use
// the same rendering contract.
const BLUE = "#0072b2";
const ORANGE = "#d55e00";
const GREEN = "#009e73";
const INK = "#000000";
const MUTED = "#505a60";
const GRID = "#d0d4d7";
const LIGHT = "#aeb6bb";
const PALE = "#eef3f5";
const RED = "#b2182b";
const PAIR_TYPE_COLORS = Object.freeze([
  "#0072b2", // DD
  "#009e73", // DC
  "#56b4e9", // DB
  "#e69f00", // CD
  "#cc79a7", // CC
  "#d890c7", // CB
  "#4e79a7", // BD
  "#f28e2b", // BC
  "#7a7a7a", // BB
  "#4d4d4d", // D0
  "#a0a0a0", // C0
  "#000000", // B0
]);
const ROW_COLORS = ["#0072b2", "#d55e00", "#009e73", "#e69f00", "#cc79a7", "#56b4e9", "#000000", "#777777"];
const FIGURE_FONT = "Arial, Helvetica, sans-serif";
const PUBLICATION_DPI = 600;
const PUBLICATION_WIDTH_MM = Object.freeze({ panel: 80, full: 180 });
// The log-tail plot still renders values only at or above 0.1%.  These limits
// add print-space around the 100% peak and the 0.1% endpoints so neither is
// hidden by the plot frame in the 80-mm publication export.
const PROFILE_TAIL_DISPLAY_BOUNDS = Object.freeze({ yMin: -3.08, yMax: 0.08 });
const RESULT_CANVAS_SELECTOR = "canvas";

const form = document.querySelector("#parameter-form");
const runButton = document.querySelector("#run-button");
const cancelButton = document.querySelector("#cancel-button");
const resetButton = document.querySelector("#reset-button");
const copyLinkButton = document.querySelector("#copy-link-button");
const progress = document.querySelector("#progress");
const status = document.querySelector("#status");
const errorBox = document.querySelector("#error-box");
const inspectState = document.querySelector("#inspect-state");
const inspectStateLabel = document.querySelector("#inspect-state-label");
const inspectPrev = document.querySelector("#inspect-prev");
const inspectNext = document.querySelector("#inspect-next");
const resultTable = document.querySelector("#result-table");
const summaryCards = document.querySelector("#summary-cards");
const downloadCsvButton = document.querySelector("#download-csv-button");
const downloadProfileButton = document.querySelector("#download-profile-button");
const downloadComplementaryGeometryButton = document.querySelector("#download-complementary-geometry-button");
const metricSelect = document.querySelector("#widthMetric");
const metricLabel = document.querySelector("#metric-label");
const sweepInterpretation = document.querySelector("#sweep-interpretation");
const versionLabel = document.querySelector("#version");
const profileModelNote = document.querySelector("#profile-model-note");
const profileAxisNote = document.querySelector("#profile-axis-note");
const legacyUrlNote = document.querySelector("#legacy-url-note");

let worker = null;
let workerObjectUrl = null;
let lastResult = null;
let startedAt = 0;
let legacyInputMigrated = false;
let selectedStateIndex = 0;
let inspectTimer = null;
let lastPlaceholderPaint = 0;

versionLabel.textContent = `Web reference build ${MODEL_VERSION} / Diagram display 2026-09-08.1`;

function syncLanguageLinks(search = window.location.search) {
  document.querySelectorAll("[data-language-target]").forEach(link => {
    const target = new URL(link.dataset.languageTarget, window.location.href);
    target.search = search;
    link.href = target.toString();
  });
}

syncLanguageLinks();
document.addEventListener("click", event => {
  const link = event.target.closest?.("[data-language-target]");
  if (!link) return;
  const target = new URL(link.dataset.languageTarget, window.location.href);
  target.search = paramsToUrl(readParams()).search;
  link.href = target.toString();
});

function fmt(value, digits = 4) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "—";
}

function reconstructionPathLabel(path) {
  return path === RECONSTRUCTION_PATHS.DIRECT_FULL_SCAN
    ? "0～360°実データ側フルスキャン（比較）"
    : "180LI取得幾何（主解析）";
}

function reconstructionPathUrlValue(path) {
  return path === RECONSTRUCTION_PATHS.DIRECT_FULL_SCAN ? "full360" : "180li";
}

function reconstructionPathFromUrl(value) {
  if (value === "full360" || value === RECONSTRUCTION_PATHS.DIRECT_FULL_SCAN) {
    return RECONSTRUCTION_PATHS.DIRECT_FULL_SCAN;
  }
  if (value === "180li" || value === RECONSTRUCTION_PATHS.FAN_BEAM_180LI) {
    return RECONSTRUCTION_PATHS.FAN_BEAM_180LI;
  }
  return DEFAULT_PARAMS.reconstructionPath;
}

function readParams() {
  const data = new FormData(form);
  return {
    rows: Number(data.get("rows")),
    rowWidth: Number(data.get("rowWidth")),
    beamPitch: Number(data.get("beamPitch")),
    sourceRadius: Number(data.get("sourceRadius")),
    radius: Number(data.get("radius")),
    zReference: 0,
    state: selectedStateIndex / 360,
    sliceThicknessMm: Number(data.get("sliceThicknessMm")),
    filterWidthMm: Number(data.get("filterWidthMm")),
    filterSamples: Number(data.get("filterSamples")),
    profileMode: String(data.get("profileMode") || DEFAULT_PARAMS.profileMode),
    reconstructionPath: String(data.get("reconstructionPath") || DEFAULT_PARAMS.reconstructionPath),
    viewSamples: Number(data.get("viewSamples")),
    zSamples: Number(data.get("zSamples")),
    stateSamples: 360,
    phase: 0,
  };
}

function writeParams(params) {
  for (const [key, value] of Object.entries(params)) {
    const input = form.elements.namedItem(key);
    if (input) input.value = value;
  }
  updateInputDecorations();
}

function updateInputDecorations() {
  const radius = Number(form.elements.namedItem("radius").value);
  document.querySelectorAll("[data-radius]").forEach(button => {
    button.classList.toggle("active", Number(button.dataset.radius) === radius);
  });
  if (inspectState) inspectState.value = String(selectedStateIndex);
  if (inspectStateLabel) inspectStateLabel.textContent = `状態 ${selectedStateIndex}/359（s = ${(selectedStateIndex / 360).toFixed(3)}）`;
  if (inspectState) inspectState.setAttribute("aria-valuetext", `状態${selectedStateIndex}、相対位置${(selectedStateIndex / 360).toFixed(3)}`);
}

function paramsToUrl(params) {
  const url = new URL(window.location.href);
  url.search = "";
  const compact = {
    v: 7,
    n: params.rows,
    d: params.rowWidth,
    p: params.beamPitch,
    R: params.sourceRadius,
    r: params.radius,
    vs: selectedStateIndex,
    st: params.sliceThicknessMm,
    fw: params.filterWidthMm,
    nf: params.filterSamples,
    pm: params.profileMode,
    rp: reconstructionPathUrlValue(params.reconstructionPath),
    wm: metricSelect?.value ?? "fwhm",
    nv: params.viewSamples,
    nz: params.zSamples,
  };
  for (const [key, value] of Object.entries(compact)) url.searchParams.set(key, value);
  return url;
}

function paramsFromUrl() {
  const query = new URLSearchParams(window.location.search);
  if (!query.size) return null;
  const get = (key, fallback) => query.has(key) ? Number(query.get(key)) : fallback;
  const getText = (key, fallback) => query.has(key) ? String(query.get(key)) : fallback;
  const hasNewThickness = query.has("st");
  const hasLegacyThickness = !hasNewThickness && query.has("t");
  const hasLegacyState = query.has("s") && !query.has("vs");
  legacyInputMigrated = hasLegacyThickness || hasLegacyState || !query.has("fw") || getText("pm", "") !== "taguchi-filter" || query.has("z") || query.has("nr") || query.has("nt") || query.has("stage");
  selectedStateIndex = query.has("vs")
    ? Math.max(0, Math.min(359, Math.round(get("vs", 0))))
    : hasLegacyState
      ? Math.max(0, Math.min(359, Math.round(get("s", 0) * 360) % 360))
      : 0;
  if (query.has("wm") && metricSelect) metricSelect.value = getText("wm", "fwhm");
  return {
    ...DEFAULT_PARAMS,
    rows: get("n", DEFAULT_PARAMS.rows),
    rowWidth: get("d", DEFAULT_PARAMS.rowWidth),
    beamPitch: get("p", DEFAULT_PARAMS.beamPitch),
    sourceRadius: get("R", DEFAULT_PARAMS.sourceRadius),
    radius: get("r", DEFAULT_PARAMS.radius),
    zReference: 0,
    state: selectedStateIndex / 360,
    sliceThicknessMm: hasNewThickness
      ? get("st", DEFAULT_PARAMS.sliceThicknessMm)
      : get("t", DEFAULT_PARAMS.sliceThicknessMm),
    filterWidthMm: get("fw", hasNewThickness ? get("st", DEFAULT_PARAMS.sliceThicknessMm) : get("t", DEFAULT_PARAMS.sliceThicknessMm)),
    filterSamples: get("nf", DEFAULT_PARAMS.filterSamples),
    profileMode: "taguchi-filter",
    reconstructionPath: reconstructionPathFromUrl(getText("rp", "")),
    viewSamples: query.has("nv")
      ? get("nv", DEFAULT_PARAMS.viewSamples)
      : get("nt", DEFAULT_PARAMS.viewSamples),
    zSamples: get("nz", DEFAULT_PARAMS.zSamples),
    stateSamples: 360,
  };
}

function setBusy(busy) {
  runButton.disabled = busy;
  cancelButton.disabled = !busy;
  form.querySelectorAll("input, select").forEach(input => input.disabled = busy);
  const inspectDisabled = busy || !lastResult;
  if (inspectState) inspectState.disabled = inspectDisabled;
  if (inspectPrev) inspectPrev.disabled = inspectDisabled;
  if (inspectNext) inspectNext.disabled = inspectDisabled;
  document.querySelectorAll("[data-canvas]").forEach(button => {
    button.disabled = busy || !lastResult;
  });
  downloadCsvButton.disabled = busy || !lastResult;
  downloadProfileButton.disabled = busy || !lastResult;
  if (downloadComplementaryGeometryButton) {
    downloadComplementaryGeometryButton.disabled = busy || !lastResult;
  }
}

function drawCanvasStatus(canvas, title, detail, state = "loading") {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const accent = state === "error" ? RED : state === "cancelled" ? MUTED : BLUE;
  const titleSize = Math.max(22, Math.min(30, width * 0.03));
  const detailSize = Math.max(15, Math.min(20, width * 0.02));

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d0d4d7";
  ctx.lineWidth = Math.max(1, width / 900);
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

  const centerX = width / 2;
  const centerY = height / 2;
  const dotRadius = Math.max(5, Math.min(8, width / 120));
  const dotGap = dotRadius * 3;
  [-1, 0, 1].forEach((offset, index) => {
    ctx.globalAlpha = state === "loading" ? 0.4 + index * 0.3 : 0.75;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(centerX + offset * dotGap, centerY - titleSize * 1.65, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = INK;
  ctx.font = `700 ${titleSize}px ${FIGURE_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, centerX, centerY - titleSize * 0.35);
  ctx.fillStyle = MUTED;
  ctx.font = `400 ${detailSize}px ${FIGURE_FONT}`;
  ctx.fillText(detail, centerX, centerY + detailSize * 1.55, width * 0.82);
  ctx.restore();

  canvas.dataset.renderState = state;
  if (state === "loading") canvas.setAttribute("aria-busy", "true");
  else canvas.removeAttribute("aria-busy");
}

function setResultPlaceholder(state, title, detail) {
  document.querySelectorAll(RESULT_CANVAS_SELECTOR).forEach(canvas => {
    drawCanvasStatus(canvas, title, detail, state);
  });
  summaryCards.innerHTML = `<div class="result-placeholder" data-result-state="${state}"><strong>${title}</strong><span>${detail}</span></div>`;
  resultTable.innerHTML = `<tr class="result-placeholder-row" data-result-state="${state}"><td colspan="5"><strong>${title}</strong><span>${detail}</span></td></tr>`;
  const caption = document.querySelector("#result-caption");
  if (caption) caption.textContent = title;
  if (sweepInterpretation) sweepInterpretation.hidden = true;
  if (state === "loading") {
    for (const selector of ["#overview-scope", "#calculation-scope", "#overlay-scope", "#profile-axis-note", "#metric-label", "#overlay-core-heading", "#overlay-core-description"]) {
      const element = document.querySelector(selector);
      if (element) element.textContent = title;
    }
    if (profileModelNote) profileModelNote.textContent = `${title} ${detail}`;
  }
}

function showCalculatingState(detail = "新しい条件で図を作成しています", force = false) {
  const now = performance.now();
  if (!force && now - lastPlaceholderPaint < 500) return;
  lastPlaceholderPaint = now;
  setResultPlaceholder("loading", "ただ今計算中…", detail);
}

function markResultCanvasesReady() {
  document.querySelectorAll(RESULT_CANVAS_SELECTOR).forEach(canvas => {
    canvas.dataset.renderState = "ready";
    canvas.removeAttribute("aria-busy");
  });
}

function showError(message) {
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function releaseWorker() {
  if (worker) worker.terminate();
  worker = null;
  if (workerObjectUrl) URL.revokeObjectURL(workerObjectUrl);
  workerObjectUrl = null;
}

function createComputationWorker() {
  if (typeof globalThis.SSPZ_WORKER_SOURCE === "string") {
    const blob = new Blob([globalThis.SSPZ_WORKER_SOURCE], { type: "text/javascript" });
    workerObjectUrl = URL.createObjectURL(blob);
    return new Worker(workerObjectUrl);
  }
  const fallbackWorker = document.documentElement.lang.toLowerCase().startsWith("en")
    ? "worker-en.js"
    : "worker.js";
  return new Worker(fallbackWorker, { type: "module" });
}

function runSimulation() {
  releaseWorker();
  clearError();
  const params = readParams();
  lastResult = null;
  setBusy(true);
  lastPlaceholderPaint = 0;
  showCalculatingState(undefined, true);
  progress.value = 0;
  status.textContent = "計算を開始しています";
  startedAt = performance.now();
  const url = paramsToUrl(params);
  try { history.replaceState(null, "", url); } catch { /* file:// may restrict history mutation */ }
  syncLanguageLinks(url.search);
  try { localStorage.setItem("sspz-unwrapped-params", JSON.stringify(params)); } catch { /* storage may be disabled */ }
  worker = createComputationWorker();
  worker.onmessage = event => {
    const message = event.data;
    if (message.type === "progress") {
      progress.value = message.value;
      status.textContent = message.label;
      showCalculatingState(message.label);
    } else if (message.type === "result") {
      lastResult = message.result;
      selectedStateIndex = Math.max(0, Math.min(359, Math.round(lastResult.params.state * 360) % 360));
      const elapsed = (performance.now() - startedAt) / 1000;
      renderAll(lastResult);
      markResultCanvasesReady();
      progress.value = 1;
      const axialSpreadMaximum = allCandidateAxialSpreadMaximum(lastResult);
      status.textContent = `完了 ${elapsed.toFixed(1)}秒 / ${reconstructionPathLabel(lastResult.params.reconstructionPath)} / 設定厚=${fmt(lastResult.params.sliceThicknessMm, 3)} mm / 候補位置の体軸方向標準偏差の最大=${fmt(axialSpreadMaximum, 3)} mm`;
      setBusy(false);
      inspectState.disabled = false;
      inspectPrev.disabled = false;
      inspectNext.disabled = false;
    } else if (message.type === "inspection-result") {
      selectedStateIndex = message.stateIndex;
      lastResult.params.state = message.state;
      lastResult.selectedOff = message.selectedOff;
      lastResult.selectedOn = message.selectedOn;
      lastResult.diagramOff = message.diagramOff;
      lastResult.diagramOn = message.diagramOn;
      renderInspectionDetails(lastResult);
      drawCandidateAxialSpreadChart(document.querySelector("#candidate-axial-spread-chart"), lastResult);
      drawSweep(document.querySelector("#sweep-chart"), lastResult);
      const url = paramsToUrl(readParams());
      try { history.replaceState(null, "", url); } catch { /* file:// may restrict history mutation */ }
      syncLanguageLinks(url.search);
      status.textContent = `詳細表示を状態${selectedStateIndex}/359（s=${(selectedStateIndex / 360).toFixed(3)}）へ更新しました`;
      inspectState.disabled = false;
      inspectPrev.disabled = false;
      inspectNext.disabled = false;
    } else if (message.type === "cancelled") {
      status.textContent = "計算を中止しました";
      setResultPlaceholder("cancelled", "計算を中止しました", "条件を確認し、もう一度「計算する」を押してください。");
      setBusy(false);
      releaseWorker();
    } else if (message.type === "error") {
      showError(message.message);
      status.textContent = "計算エラー";
      setResultPlaceholder("error", "図を作成できませんでした", "上のエラー内容を確認してください。");
      setBusy(false);
      releaseWorker();
    }
  };
  worker.onerror = event => {
    showError(event.message || "Web Workerでエラーが発生しました。");
    status.textContent = "計算エラー";
    setResultPlaceholder("error", "図を作成できませんでした", "上のエラー内容を確認してください。");
    setBusy(false);
  };
  worker.postMessage({ type: "run", params });
}

function requestStateInspection(index, immediate = false) {
  selectedStateIndex = ((Math.round(index) % 360) + 360) % 360;
  updateInputDecorations();
  if (!lastResult || !worker) return;
  clearTimeout(inspectTimer);
  const send = () => {
    inspectState.disabled = true;
    inspectPrev.disabled = true;
    inspectNext.disabled = true;
    status.textContent = `状態${selectedStateIndex}/359の詳細を計算中`;
    worker.postMessage({ type: "inspect-state", stateIndex: selectedStateIndex });
  };
  if (immediate) send();
  else inspectTimer = setTimeout(send, 120);
}

function axisContext(canvas, bounds, labels) {
  const ctx = canvas.getContext("2d");
  const renderScale = Math.max(1, Number(canvas.dataset.renderScale) || 1);
  const width = canvas.width / renderScale;
  const height = canvas.height / renderScale;
  const compactPanel = width <= 950;
  const style = {
    tickFontPx: compactPanel ? 31 : 27,
    axisFontPx: compactPanel ? 34 : 31,
    legendFontPx: compactPanel ? 26 : 24,
    noteFontPx: compactPanel ? 23 : 21,
    majorAxisWidth: 2.7,
    frameWidth: 1.1,
    gridWidth: 1,
  };
  const margin = {
    left: labels.leftMargin ?? (compactPanel ? 112 : 106),
    right: labels.rightMargin ?? (compactPanel ? 34 : 38),
    top: labels.topMargin ?? 44,
    bottom: labels.bottomMargin ?? (compactPanel ? 96 : 90),
  };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  const x = value => margin.left + (value - bounds.xMin) / (bounds.xMax - bounds.xMin) * innerWidth;
  const y = value => margin.top + (bounds.yMax - value) / (bounds.yMax - bounds.yMin) * innerHeight;
  const yDown = value => margin.top + (value - bounds.yMin) / (bounds.yMax - bounds.yMin) * innerHeight;
  return { ctx, width, height, margin, innerWidth, innerHeight, x, y, yDown, labels, style, renderScale };
}

function setFittedFigureFont(ctx, text, preferredPx, minimumPx, maximumWidth, weight = "") {
  let size = preferredPx;
  const prefix = weight ? `${weight} ` : "";
  while (size > minimumPx) {
    ctx.font = `${prefix}${size}px ${FIGURE_FONT}`;
    if (ctx.measureText(text).width <= maximumWidth) return size;
    size -= 1;
  }
  ctx.font = `${prefix}${minimumPx}px ${FIGURE_FONT}`;
  return minimumPx;
}

function drawAxes(plot, xTicks, yTicks, useYDown = false) {
  const { ctx, margin, innerWidth, innerHeight, x, y, yDown, labels, width, height, style } = plot;
  const xValues = xTicks.filter(Number.isFinite);
  const yValues = yTicks.filter(Number.isFinite);
  const xFormatter = labels.xFormatter ?? (value => String(value));
  const yFormatter = labels.yFormatter ?? (value => String(value));
  ctx.save();
  ctx.strokeStyle = GRID;
  ctx.lineWidth = style.gridWidth;
  // Publication figures use black tick-label numerals; only the supporting
  // gridlines remain gray so the coordinate scale keeps full print contrast.
  ctx.fillStyle = INK;
  ctx.font = `${style.tickFontPx}px ${FIGURE_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const tick of xValues) {
    const px = x(tick);
    ctx.beginPath(); ctx.moveTo(px, margin.top); ctx.lineTo(px, margin.top + innerHeight); ctx.stroke();
    ctx.fillText(xFormatter(tick), px, margin.top + innerHeight + 15);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const tick of yValues) {
    const py = useYDown ? yDown(tick) : y(tick);
    ctx.beginPath(); ctx.moveTo(margin.left, py); ctx.lineTo(margin.left + innerWidth, py); ctx.stroke();
    ctx.fillText(yFormatter(tick), margin.left - 16, py);
  }

  // Major ticks point outside the plotting field.  Midpoint minor ticks point
  // inward and carry no labels, keeping the scale readable without extra grid.
  ctx.strokeStyle = INK;
  ctx.lineWidth = style.majorAxisWidth;
  for (const tick of xValues) {
    const px = x(tick);
    ctx.beginPath(); ctx.moveTo(px, margin.top + innerHeight); ctx.lineTo(px, margin.top + innerHeight + 10); ctx.stroke();
  }
  for (const tick of yValues) {
    const py = useYDown ? yDown(tick) : y(tick);
    ctx.beginPath(); ctx.moveTo(margin.left - 10, py); ctx.lineTo(margin.left, py); ctx.stroke();
  }
  ctx.lineWidth = 1.2;
  for (let index = 0; index + 1 < xValues.length; index += 1) {
    const px = x((xValues[index] + xValues[index + 1]) / 2);
    ctx.beginPath(); ctx.moveTo(px, margin.top + innerHeight); ctx.lineTo(px, margin.top + innerHeight - 6); ctx.stroke();
  }
  for (let index = 0; index + 1 < yValues.length; index += 1) {
    const value = (yValues[index] + yValues[index + 1]) / 2;
    const py = useYDown ? yDown(value) : y(value);
    ctx.beginPath(); ctx.moveTo(margin.left, py); ctx.lineTo(margin.left + 6, py); ctx.stroke();
  }
  ctx.lineWidth = style.frameWidth;
  ctx.strokeRect(margin.left, margin.top, innerWidth, innerHeight);
  ctx.lineWidth = style.majorAxisWidth;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + innerHeight);
  ctx.lineTo(margin.left + innerWidth, margin.top + innerHeight);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const xLabelCenter = margin.left + innerWidth / 2;
  const xLabelWidth = Math.max(1, Math.min(innerWidth, 2 * Math.min(xLabelCenter, width - xLabelCenter)) - 16);
  setFittedFigureFont(ctx, labels.x, style.axisFontPx, 21, xLabelWidth);
  ctx.fillText(labels.x, xLabelCenter, height - 11);
  ctx.save();
  // Keep the rotated y-axis title inside the export canvas at the final
  // 80/180-mm sizes; 31 px allowed glyph overhang to touch the left edge.
  ctx.translate(width <= 950 ? 46 : 44, margin.top + innerHeight / 2);
  ctx.rotate(-Math.PI / 2);
  setFittedFigureFont(ctx, labels.y, style.axisFontPx, 21, innerHeight - 16);
  ctx.fillText(labels.y, 0, 0);
  ctx.restore();
  ctx.restore();
}

function hexToRgb(color) {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = saturation / 100;
  const l = lightness / 100;
  if (s === 0) return [l, l, l].map(value => Math.round(value * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hueToRgb = t0 => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hueToRgb(h + 1 / 3), hueToRgb(h), hueToRgb(h - 1 / 3)]
    .map(value => Math.round(value * 255));
}

function rowRgb(row, totalRows = ROW_COLORS.length) {
  const index = Math.max(0, Number(row));
  if (totalRows <= ROW_COLORS.length) return hexToRgb(ROW_COLORS[index % ROW_COLORS.length]);
  const ratio = totalRows <= 1 ? 0.5 : index / (totalRows - 1);
  // Detector row is ordinal, not categorical.  For many rows use a restrained
  // blue-to-gold ordered ramp instead of a rainbow categorical palette.
  const stops = [
    { at: 0, rgb: [31, 78, 121] },
    { at: 0.5, rgb: [67, 131, 120] },
    { at: 1, rgb: [204, 126, 0] },
  ];
  const upper = ratio <= 0.5 ? stops[1] : stops[2];
  const lower = ratio <= 0.5 ? stops[0] : stops[1];
  const local = (ratio - lower.at) / (upper.at - lower.at);
  return lower.rgb.map((value, channel) => Math.round(value + local * (upper.rgb[channel] - value)));
}

function rowColor(row, totalRows = ROW_COLORS.length) {
  return `rgb(${rowRgb(row, totalRows).join(", ")})`;
}

function opaqueWeightColor(row, totalRows, weight) {
  const clipped = Math.max(0, Math.min(1, Number(weight)));
  // Keep the visual mapping monotonic and linear.  The outline preserves the
  // row identity even at w=0, while the fill progresses uniformly from pale
  // to saturated as the assumed normalized weight increases from 0 to 1.
  const amount = 0.12 + 0.88 * clipped;
  const channels = rowRgb(row, totalRows)
    .map(channel => Math.round(255 - (255 - channel) * amount));
  return `rgb(${channels.join(", ")})`;
}

function drawWeightedMarker(ctx, row, totalRows, x, y, radius, weight, shape = "circle") {
  const color = rowColor(row, totalRows);
  ctx.fillStyle = opaqueWeightColor(row, totalRows, weight);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  if (shape === "triangle") {
    ctx.moveTo(x, y - radius * 1.25);
    ctx.lineTo(x + radius * 1.1, y + radius * 0.8);
    ctx.lineTo(x - radius * 1.1, y + radius * 0.8);
    ctx.closePath();
  } else ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawWrappedLegendText(ctx, text, left, y, maxWidth, lineHeight = 22) {
  const segments = String(text).split(/\s*[／/]\s*/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const segment of segments) {
    const candidate = line ? `${line} / ${segment}` : segment;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = segment;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  lines.forEach((value, index) => ctx.fillText(value, left, y + index * lineHeight));
}

function drawDiagramFamilyLegend(ctx, diagram, left, y, width) {
  const paired = diagram.traceFamilies?.some(trace => trace.family === "complementary");
  const items = [{
    label: localizedText("実データ側：実線・○", "Direct data: solid line / circle"),
    dashed: false,
  }];
  if (paired) items.push({
    label: localizedText("対向データ側：破線・△", "Complementary data: dashed line / triangle"),
    dashed: true,
  });
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const columnWidth = width / items.length;
  items.forEach((item, index) => {
    const start = left + index * columnWidth;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.8;
    ctx.setLineDash(item.dashed ? [5, 3] : []);
    ctx.beginPath(); ctx.moveTo(start, y); ctx.lineTo(start + 30, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK;
    setFittedFigureFont(ctx, item.label, 18, 13, columnWidth - 44);
    ctx.fillText(item.label, start + 40, y);
  });
  ctx.restore();
}

function drawWeightLegend(ctx, left, top, width, diagram, countText) {
  const totalRows = diagram.totalRows;
  const y0 = top + 6;
  ctx.save();
  ctx.fillStyle = INK;
  ctx.font = `20px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const weightLabel = "選択端点の線形補間重み w";
  const markerStart = left + Math.max(300, width * 0.48);
  setFittedFigureFont(ctx, weightLabel, 20, 15, markerStart - left - 18);
  ctx.fillText(weightLabel, left, y0 + 18);
  const weights = [0, 0.25, 0.5, 0.75, 1];
  const markerSpacing = Math.min(70, Math.max(42, (left + width - markerStart - 8) / (weights.length - 1)));
  weights.forEach((weight, index) => {
    const markerX = markerStart + index * markerSpacing;
    drawWeightedMarker(ctx, 0, totalRows, markerX, y0 + 18, 6, weight);
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FIGURE_FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(weight.toFixed(weight === 0 || weight === 1 ? 0 : 2), markerX, y0 + 44);
  });
  drawDiagramFamilyLegend(ctx, diagram, left, y0 + 76, width);
  ctx.textAlign = "left";
  const acquisitionLabel = localizedText(
    "線：全列候補　○・△：選択端点　赤線：目的断面",
    "Lines: all rows; markers: selected endpoints; red line: target plane",
  );
  ctx.fillStyle = INK;
  setFittedFigureFont(ctx, acquisitionLabel, 18, 13, width);
  ctx.fillText(acquisitionLabel, left, y0 + 104);
  if (countText) {
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FIGURE_FONT}`;
    drawWrappedLegendText(ctx, countText, left, y0 + 132, width);
  }
  ctx.restore();
}

function drawCandidateTrace(ctx, diagram, trace, row, turn, x, yDown, xLimit) {
  const angles = trace.angles;
  const axial = trace.axial;
  const scales = trace.scales;
  const rowOffset = diagram.traceGeometry.rowOffsets[row];
  const feed = diagram.traceGeometry.feed;
  const complementary = trace.family === "complementary";
  const totalRows = diagram.totalRows;
  ctx.save();
  ctx.strokeStyle = rowColor(row, totalRows);
  const densityScale = Math.min(1, Math.sqrt(24 / Math.max(24, totalRows)));
  ctx.globalAlpha = (complementary ? 0.45 : 0.60) * densityScale;
  ctx.lineWidth = Math.max(0.45, 1.35 * densityScale);
  ctx.setLineDash(complementary ? [5, 3] : []);
  // Avoid artificial horizontal bands from aligned dash phases in dense rows.
  ctx.lineDashOffset = complementary ? -(row % 11) * 0.73 : 0;
  ctx.beginPath();
  let previousAngle = null;
  let previousDelta = null;
  for (let index = 0; index < angles.length; index += 1) {
    const angle = angles[index];
    const delta = axial[index] + turn * feed + scales[index] * rowOffset - diagram.z0;
    // Preserve every acquired reference view. Cull only whole off-screen
    // segments, never downsample the complementary-angle geometry.
    const outside = previousDelta !== null && (
      (delta < -xLimit && previousDelta < -xLimit)
      || (delta > xLimit && previousDelta > xLimit)
    );
    const px = x(delta);
    const py = yDown(angle);
    if (previousAngle === null || outside || Math.abs(angle - previousAngle) > 180) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
    previousAngle = angle;
    previousDelta = delta;
  }
  ctx.stroke();
  ctx.restore();
}

function drawOverviewLegend(ctx, diagram, left, top, width, countText) {
  const legendCount = Math.min(6, diagram.totalRows);
  const rows = Array.from({ length: legendCount }, (_, index) => (
    legendCount === 1 ? 0 : Math.round(index * (diagram.totalRows - 1) / (legendCount - 1))
  ));
  ctx.save();
  ctx.font = `20px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = INK;
  const rowLabel = "検出器列";
  ctx.fillText(rowLabel, left, top + 21);
  const rowLabelWidth = ctx.measureText(rowLabel).width;
  ctx.font = `18px ${FIGURE_FONT}`;
  const itemWidths = rows.map(row => 34 + ctx.measureText(`${row + 1}`).width);
  const itemWidthTotal = itemWidths.reduce((sum, value) => sum + value, 0);
  const rowLegendStart = left + rowLabelWidth + 24;
  const remainingGapWidth = Math.max(0, left + width - rowLegendStart - itemWidthTotal);
  const itemGap = rows.length > 1 ? Math.max(12, Math.min(32, remainingGapWidth / (rows.length - 1))) : 0;
  let rowLegendX = rowLegendStart;
  rows.forEach((row, index) => {
    const x0 = rowLegendX;
    const y = top + 21;
    ctx.strokeStyle = rowColor(row, diagram.totalRows);
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + 28, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FIGURE_FONT}`;
    ctx.fillText(`${row + 1}`, x0 + 34, y);
    rowLegendX += itemWidths[index] + itemGap;
  });
  drawDiagramFamilyLegend(ctx, diagram, left, top + 54, width);
  ctx.font = `18px ${FIGURE_FONT}`;
  const acquiredLabel = "全列候補軌道（Tで除外しない）";
  const targetLabel = "目的断面 z₀";
  const secondRowY = top + 84;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2;
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(left, secondRowY); ctx.lineTo(left + 42, secondRowY); ctx.stroke();
  const acquiredTextX = left + 52;
  ctx.fillStyle = INK; ctx.fillText(acquiredLabel, acquiredTextX, secondRowY);
  const acquiredTextRight = acquiredTextX + ctx.measureText(acquiredLabel).width;
  const targetTextWidth = ctx.measureText(targetLabel).width;
  let targetMarkerX = acquiredTextRight + 24;
  let targetTextX = targetMarkerX + 12;
  let targetY = secondRowY;
  let countY = top + 144;
  if (targetTextX + targetTextWidth > left + width) {
    targetMarkerX = left;
    targetTextX = left + 12;
    targetY = top + 114;
    countY = top + 174;
  }
  ctx.strokeStyle = RED;
  ctx.lineWidth = 2.4;
  ctx.beginPath(); ctx.moveTo(targetMarkerX, targetY - 12); ctx.lineTo(targetMarkerX, targetY + 12); ctx.stroke();
  ctx.fillStyle = INK; ctx.fillText(targetLabel, targetTextX, targetY);
  const bandLabel = "淡色帯：2Bの拡大範囲（Tとは別）";
  ctx.fillStyle = MUTED;
  setFittedFigureFont(ctx, bandLabel, 17, 13, width);
  ctx.fillText(bandLabel, left, targetY + 30);
  if (countText) {
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FIGURE_FONT}`;
    drawWrappedLegendText(ctx, countText, left, countY, width);
  }
  ctx.restore();
}

function drawDiagram(canvas, diagram, mode = "zoom", sharedXLimit = null, focusXLimit = null) {
  const publicationMode = canvas.dataset.publicationMode === "true";
  const ownLimit = mode === "overview" ? diagram.overviewXLimit : diagram.zoomXLimit;
  const requiredXLimit = sharedXLimit ?? ownLimit;
  const xAxis = symmetricNiceAxis(requiredXLimit, 3);
  const xLimit = xAxis.xMax;
  const plot = axisContext(canvas, { xMin: xAxis.xMin, xMax: xAxis.xMax, yMin: 0, yMax: 360 }, {
    x: "候補列中心  zᵢ − z₀  (mm)",
    y: localizedText("実データ側の角度  β  (°)", "Direct-data reference angle  β  (°)"),
    xFormatter: xAxis.formatter,
    yFormatter: value => Number(value).toFixed(0),
    topMargin: publicationMode ? 148 : 206,
  });
  const { ctx, margin, innerWidth, innerHeight, x, yDown } = plot;
  const bandLimit = Math.min(xLimit, mode === "overview"
    ? (focusXLimit ?? diagram.zoomXLimit)
    : Math.max(diagram.interpolationBandHalfWidth ?? 0, 0.15));
  ctx.fillStyle = PALE;
  ctx.fillRect(x(-bandLimit), margin.top, x(bandLimit) - x(-bandLimit), innerHeight);
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, innerWidth, innerHeight);
  ctx.clip();
  // Every family is expressed in the same DIRECT reference-angle coordinate.
  // In particular, complementary markers are not drawn on direct-only traces.
  const traceFamilies = diagram.traceFamilies ?? [diagram.traceGeometry];
  for (const trace of traceFamilies) {
    // Exact angular matches have only one distinct complementary family.
    if (trace.id === "complementary-upper") {
      const lower = traceFamilies.find(item => item.id === "complementary-lower");
      if (lower && trace.absoluteViewIndices.every((value, index) => value === lower.absoluteViewIndices[index])) continue;
    }
    for (let row = 0; row < diagram.totalRows; row += 1) {
      for (const turn of diagram.traceGeometry.turns) {
        drawCandidateTrace(ctx, diagram, trace, row, turn, x, yDown, xLimit);
      }
    }
  }
  if (mode === "zoom") {
    const pointsByWeight = [...diagram.weightedPoints].sort((a, b) => a.weight - b.weight);
    for (const point of pointsByWeight) {
      const px = x(point.x); const py = yDown(point.y);
      const shape = point.traceFamilyId?.startsWith("complementary-") ? "triangle" : "circle";
      drawWeightedMarker(ctx, point.row, diagram.totalRows, px, py, 5.2, point.weight, shape);
    }
  }
  ctx.strokeStyle = RED;
  ctx.setLineDash([]);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x(0), margin.top); ctx.lineTo(x(0), margin.top + innerHeight); ctx.stroke();
  ctx.restore();
  drawAxes(plot, xAxis.ticks, [0, 60, 120, 180, 240, 300, 360], true);
  if (mode === "overview") {
    const countText = localizedText(
      `全${diagram.totalRows}列・全${diagram.referenceViewSamples}取得角度／共通の実データ側角度βで表示／Tで除外しない`,
      `All ${diagram.totalRows} rows / ${diagram.referenceViewSamples} acquired angles / common direct-data reference angle β / no T-based exclusion`,
    );
    drawOverviewLegend(ctx, diagram, margin.left, 8, innerWidth, publicationMode ? "" : countText);
  } else {
    const countText = localizedText(
      `点は${diagram.renderedAngleSamples}角度を抜粋／軌道は全取得角度／Tで除外しない`,
      `Markers: ${diagram.renderedAngleSamples} reference angles / trajectories: all acquired angles / no T-based exclusion`,
    );
    drawWeightLegend(
      ctx,
      margin.left,
      8,
      innerWidth,
      diagram,
      publicationMode ? "" : countText,
    );
  }
  canvas.dataset.xMin = String(xAxis.xMin);
  canvas.dataset.xMax = String(xAxis.xMax);
  canvas.dataset.xStep = String(xAxis.step);
  canvas.dataset.xRequiredHalfSpan = String(requiredXLimit);
  canvas.dataset.axisRule = "symmetric-natural-1-2-5-containing-all-rendered-data";
  canvas.dataset.candidatePopulation = diagram.candidatePopulation;
  canvas.dataset.candidatePoolDefinition = diagram.candidatePoolDefinition;
  canvas.dataset.sliceThicknessThresholdUsed = String(diagram.sliceThicknessThresholdUsed);
  canvas.dataset.candidatePoolUsesConfiguredSliceThickness = String(diagram.candidatePoolUsesConfiguredSliceThickness);
  canvas.dataset.rowTraceWeighting = diagram.rowTraceWeighting;
  canvas.dataset.rowsPerView = String(diagram.rowsPerAcquiredView);
  canvas.dataset.configuredSliceThicknessMm = String(diagram.configuredSliceThicknessMm);
  canvas.dataset.markerScope = mode === "zoom" ? "selected-interpolation-endpoints" : "none";
  canvas.dataset.selectedEndpointStage = diagram.selectedEndpointStage;
  canvas.dataset.doesNotRestrictCandidatePopulation = String(diagram.doesNotRestrictCandidatePopulation);
  canvas.dataset.angleCoordinate = diagram.angleCoordinate;
  canvas.dataset.traceFamilyIds = traceFamilies.map(trace => trace.id).join(",");
  canvas.dataset.traceSamplesPerFamily = String(diagram.acquiredTraceSamples);
  canvas.dataset.complementaryMarkerShape = "triangle";
  canvas.dataset.complementaryLineStyle = "dashed";
  canvas.dataset.diagramDisplayVersion = "2026-09-08.1";
}

function drawSeriesMarkers(ctx, points, x, y, color, shape = "circle", stride = 1) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  for (let index = 0; index < points.length; index += Math.max(1, stride)) {
    const point = points[index];
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    const px = x(point[0]);
    const py = y(point[1]);
    if (shape === "cross") {
      ctx.beginPath();
      ctx.moveTo(px - 3.5, py - 3.5); ctx.lineTo(px + 3.5, py + 3.5);
      ctx.moveTo(px - 3.5, py + 3.5); ctx.lineTo(px + 3.5, py - 3.5);
      ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(px, py, 3.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore();
}

function complementaryPoints(series, values) {
  return Array.from(values, (value, index) => [series.baseAnglesDeg[index], value]);
}

function fillSeriesEnvelope(ctx, xValues, firstValues, secondValues, x, y, color, alpha = 0.14) {
  const lower = [];
  const upper = [];
  for (let index = 0; index < xValues.length; index += 1) {
    const xValue = xValues[index];
    const first = firstValues[index];
    const second = secondValues[index];
    if (!Number.isFinite(xValue) || !Number.isFinite(first) || !Number.isFinite(second)) continue;
    lower.push([xValue, Math.min(first, second)]);
    upper.push([xValue, Math.max(first, second)]);
  }
  if (lower.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x(lower[0][0]), y(lower[0][1]));
  for (let index = 1; index < lower.length; index += 1) ctx.lineTo(x(lower[index][0]), y(lower[index][1]));
  for (let index = upper.length - 1; index >= 0; index -= 1) ctx.lineTo(x(upper[index][0]), y(upper[index][1]));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPairTypeBand(plot, series, labels) {
  const { ctx, margin, innerWidth } = plot;
  const count = series.pairTypeCodes.length;
  const bandY = margin.top + 5;
  const bandHeight = 9;
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, innerWidth, plot.innerHeight);
  ctx.clip();
  for (let index = 0; index < count; index += 1) {
    if (!series.valid[index]) continue;
    const x0 = margin.left + index / count * innerWidth;
    const x1 = margin.left + (index + 1) / count * innerWidth;
    ctx.fillStyle = PAIR_TYPE_COLORS[series.pairTypeCodes[index]] ?? LIGHT;
    ctx.fillRect(x0, bandY, Math.max(1, x1 - x0 + 0.4), bandHeight);
  }
  ctx.restore();

  ctx.save();
  ctx.font = `14px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  let cursorX = margin.left;
  const legendY = margin.top - 17;
  labels.forEach((label, code) => {
    const countValue = series.typeCounts[code] ?? 0;
    if (countValue <= 0) return;
    ctx.fillStyle = PAIR_TYPE_COLORS[code] ?? LIGHT;
    ctx.fillRect(cursorX, legendY - 5, 12, 10);
    ctx.fillStyle = INK;
    const text = `${label}: ${countValue}`;
    ctx.fillText(text, cursorX + 17, legendY);
    cursorX += 23 + ctx.measureText(text).width;
  });
  ctx.restore();
}

function drawComplementaryAngleChart(canvas, result) {
  const series = result.diagramOn.complementaryCandidates;
  const idealPoints = complementaryPoints(series, series.forwardSeparationsDeg);
  const actualPoints = complementaryPoints(series, series.nearestForwardSeparationsDeg);
  const lowerAcquired = Array.from(series.forwardSeparationsDeg, (value, index) => (
    value + series.lowerAngularResidualsDeg[index]
  ));
  const upperAcquired = Array.from(series.forwardSeparationsDeg, (value, index) => (
    value + series.upperAngularResidualsDeg[index]
  ));
  const yScale = niceScale([
    180,
    ...series.forwardSeparationsDeg,
    ...series.nearestForwardSeparationsDeg,
    ...lowerAcquired,
    ...upperAcquired,
  ], { targetIntervals: 5, padFraction: 0.05, minimumSpan: Math.max(4, 4 * series.viewStepDeg) });
  const plot = axisContext(canvas, { xMin: 0, xMax: 360, yMin: yScale.min, yMax: yScale.max }, {
    x: "実データ側の角度  β  (°)",
    y: "対向データ側のレイまでの角度差  Δβc  (°)",
    xFormatter: value => Number(value).toFixed(0),
    yFormatter: fixedFormatterForTicks(yScale.ticks),
    topMargin: 112,
  });
  const reference = [[0, 180], [360, 180]];
  drawPolyline(plot.ctx, reference, plot.x, plot.y, LIGHT, 2, [8, 6]);
  fillSeriesEnvelope(
    plot.ctx,
    series.baseAnglesDeg,
    lowerAcquired,
    upperAcquired,
    plot.x,
    plot.y,
    LIGHT,
    0.25,
  );
  drawPolyline(plot.ctx, idealPoints, plot.x, plot.y, ORANGE, 3.2);
  drawPolyline(plot.ctx, actualPoints, plot.x, plot.y, INK, 1.4, [5, 4]);
  const markerStride = Math.max(1, Math.ceil(series.viewCount / 72));
  drawSeriesMarkers(plot.ctx, actualPoints, plot.x, plot.y, INK, "circle", markerStride);
  drawAxes(plot, [0, 60, 120, 180, 240, 300, 360], yScale.ticks);
  drawLegend(plot.ctx, [
    { label: "理想対向角差 180°+2γ", color: ORANGE },
    { label: "最近接実取得ビュー", color: INK, dash: [5, 4] },
    { label: "理想角を挟む実取得2ビュー", color: LIGHT, dash: [8, 6] },
  ], plot.margin.left, 20, 18);
  canvas.dataset.viewCount = String(series.viewCount);
  canvas.dataset.maximumAngularResidualDeg = String(series.maximumAngularResidualDeg);
  canvas.dataset.pairingModel = series.model;
}

function drawComplementaryDistanceChart(canvas, result) {
  const series = result.diagramOn.complementaryCandidates;
  const ideal = series.idealAnglePairs;
  const lowerNeighbor = series.lowerAngularNeighborPairs;
  const upperNeighbor = series.upperAngularNeighborPairs;
  const pairOne = complementaryPoints(series, ideal.pairOneGapMm);
  const pairTwo = complementaryPoints(series, ideal.pairTwoGapMm);
  const selectedMinimum = complementaryPoints(series, ideal.selectedGapMm);
  const yScale = niceScale([
    0,
    ...ideal.pairOneGapMm,
    ...ideal.pairTwoGapMm,
    ...lowerNeighbor.pairOneGapMm,
    ...lowerNeighbor.pairTwoGapMm,
    ...upperNeighbor.pairOneGapMm,
    ...upperNeighbor.pairTwoGapMm,
  ], { targetIntervals: 5, padFraction: 0.06, minimumSpan: Math.max(0.5, result.params.rowWidth) });
  yScale.min = 0;
  yScale.ticks = niceProfileTicks(yScale.min, yScale.max, 6);
  const plot = axisContext(canvas, { xMin: 0, xMax: 360, yMin: yScale.min, yMax: yScale.max }, {
    x: "実データ側の角度  β  (°)",
    y: "目的断面を挟む対応区間幅  G  (mm)",
    xFormatter: value => Number(value).toFixed(0),
    yFormatter: fixedFormatterForTicks(yScale.ticks),
    topMargin: 144,
  });
  fillSeriesEnvelope(
    plot.ctx,
    series.baseAnglesDeg,
    lowerNeighbor.pairOneGapMm,
    upperNeighbor.pairOneGapMm,
    plot.x,
    plot.y,
    BLUE,
    0.12,
  );
  fillSeriesEnvelope(
    plot.ctx,
    series.baseAnglesDeg,
    lowerNeighbor.pairTwoGapMm,
    upperNeighbor.pairTwoGapMm,
    plot.x,
    plot.y,
    ORANGE,
    0.12,
  );
  drawPolyline(plot.ctx, pairOne, plot.x, plot.y, BLUE, 2.8);
  drawPolyline(plot.ctx, pairTwo, plot.x, plot.y, ORANGE, 2.8, [7, 5]);
  drawPolyline(plot.ctx, selectedMinimum, plot.x, plot.y, INK, 3.6);
  drawAxes(plot, [0, 60, 120, 180, 240, 300, 360], yScale.ticks);
  drawLegend(plot.ctx, [
    { label: "理想角：実データₙ → 対向データₙ", color: BLUE },
    { label: "理想角：対向データₙ → 実データₙ₊₁", color: ORANGE, dash: [7, 5] },
    { label: "Gmin = min(G₁, G₂)", color: INK },
    { label: "淡色帯：理想角を挟む実取得2ビュー", color: LIGHT },
  ], plot.margin.left, 20, 18);
  canvas.dataset.helicalPairOrder = ideal.helicalOrder;
  canvas.dataset.pairOneDefinition = ideal.pairOneDefinition;
  canvas.dataset.pairTwoDefinition = ideal.pairTwoDefinition;
  canvas.dataset.pairSwitchCount = String(ideal.switchCount);
  canvas.dataset.candidateRule = series.candidateRule;
}

function drawGeneralTwoPointCandidateChart(canvas, result) {
  const series = result.diagramOn.complementaryCandidates;
  const ideal = series.idealIntegratedPairs;
  const lowerNeighbor = series.lowerAngularNeighborIntegratedPairs;
  const upperNeighbor = series.upperAngularNeighborIntegratedPairs;
  const nearestAcquired = series.nearestIntegratedPairs;
  const maximumMagnitude = Math.max(
    result.params.rowWidth / 4,
    ...Array.from(ideal.lowerSignedDistanceMm, Math.abs),
    ...Array.from(ideal.upperSignedDistanceMm, Math.abs),
    ...Array.from(lowerNeighbor.lowerSignedDistanceMm, Math.abs),
    ...Array.from(lowerNeighbor.upperSignedDistanceMm, Math.abs),
    ...Array.from(upperNeighbor.lowerSignedDistanceMm, Math.abs),
    ...Array.from(upperNeighbor.upperSignedDistanceMm, Math.abs),
  );
  const yAxis = symmetricNiceAxis(maximumMagnitude * 1.06, 3);
  const plot = axisContext(canvas, { xMin: 0, xMax: 360, yMin: yAxis.xMin, yMax: yAxis.xMax }, {
    x: "実データ側の角度  β  (°)",
    y: "目的断面に対する候補位置  z − z₀  (mm)",
    xFormatter: value => Number(value).toFixed(0),
    yFormatter: yAxis.formatter,
    topMargin: 146,
  });
  fillSeriesEnvelope(
    plot.ctx,
    series.baseAnglesDeg,
    ideal.lowerSignedDistanceMm,
    ideal.upperSignedDistanceMm,
    plot.x,
    plot.y,
    LIGHT,
    0.12,
  );
  fillSeriesEnvelope(
    plot.ctx,
    series.baseAnglesDeg,
    lowerNeighbor.lowerSignedDistanceMm,
    upperNeighbor.lowerSignedDistanceMm,
    plot.x,
    plot.y,
    BLUE,
    0.13,
  );
  fillSeriesEnvelope(
    plot.ctx,
    series.baseAnglesDeg,
    lowerNeighbor.upperSignedDistanceMm,
    upperNeighbor.upperSignedDistanceMm,
    plot.x,
    plot.y,
    ORANGE,
    0.13,
  );
  drawPolyline(plot.ctx, [[0, 0], [360, 0]], plot.x, plot.y, INK, 1.4, [5, 4]);
  drawPolyline(plot.ctx, complementaryPoints(series, ideal.lowerSignedDistanceMm), plot.x, plot.y, BLUE, 2.8);
  drawPolyline(plot.ctx, complementaryPoints(series, ideal.upperSignedDistanceMm), plot.x, plot.y, ORANGE, 2.8, [7, 5]);
  const markerStride = Math.max(1, Math.ceil(series.viewCount / 72));
  drawSeriesMarkers(
    plot.ctx,
    complementaryPoints(series, nearestAcquired.lowerSignedDistanceMm),
    plot.x,
    plot.y,
    INK,
    "circle",
    markerStride,
  );
  drawSeriesMarkers(
    plot.ctx,
    complementaryPoints(series, nearestAcquired.upperSignedDistanceMm),
    plot.x,
    plot.y,
    INK,
    "circle",
    markerStride,
  );
  drawAxes(plot, [0, 60, 120, 180, 240, 300, 360], yAxis.ticks);
  drawLegend(plot.ctx, [
    { label: "全候補統合後の最近接挟み込み Gmerge", color: LIGHT },
    { label: "小さいz側（点＝最近接実取得ビュー）", color: BLUE },
    { label: "大きいz側（点＝最近接実取得ビュー）", color: ORANGE, dash: [7, 5] },
  ], plot.margin.left, 20, 18);
  drawPairTypeBand(plot, ideal, ideal.typeLabels);
  canvas.dataset.selectionRule = ideal.selectionRule;
  canvas.dataset.pairTypeLabels = ideal.typeLabels.join(",");
  canvas.dataset.pairTypeCounts = Array.from(ideal.typeCounts).join(",");
  canvas.dataset.pairTypeSwitchCount = String(ideal.switchCount);
  canvas.dataset.angularBracketEnvelope = "lower-and-upper-acquired-views-around-the-ideal-complementary-angle";
  canvas.dataset.availableDetectorRowsPerAbsoluteView = String(series.availableDetectorRowsPerAbsoluteView);
  canvas.dataset.rowCandidatesPerDirectComplementPair = String(series.rowCandidatesPerDirectComplementPair);
}

function allCandidateAxialSpreadMaximum(result) {
  let maximum = -Infinity;
  for (const key of ["allCandidateAxialSpreadOffMm", "allCandidateAxialSpreadOnMm"]) {
    const values = result?.overlay?.[key];
    if (!values) continue;
    for (const value of values) if (Number.isFinite(value)) maximum = Math.max(maximum, value);
  }
  return Number.isFinite(maximum) ? maximum : NaN;
}

function drawCandidateAxialSpreadChart(canvas, result) {
  if (!canvas) return;
  const overlay = result?.overlay;
  const offValues = overlay?.allCandidateAxialSpreadOffMm;
  const onValues = overlay?.allCandidateAxialSpreadOnMm;
  const betaValues = overlay?.geometryAnglesDeg;
  if (!offValues || !onValues) {
    drawCanvasStatus(canvas, "候補点の広がりを計算中", "無重み標準偏差の計算結果を待っています");
    return;
  }
  const angleCount = Math.min(
    Number(overlay.geometryAngleCount) || offValues.length,
    offValues.length,
    onValues.length,
    betaValues?.length ?? Infinity,
  );
  if (!(angleCount > 0)) {
    drawCanvasStatus(canvas, "候補点の広がりを表示できません", "投影角度ごとの計算結果がありません", "error");
    return;
  }
  const offPoints = [];
  const onPoints = [];
  const finiteValues = [0];
  for (let index = 0; index < angleCount; index += 1) {
    const beta = Number.isFinite(betaValues?.[index])
      ? Number(betaValues[index])
      : 360 * index / angleCount;
    const off = Number(offValues[index]);
    const on = Number(onValues[index]);
    offPoints.push([beta, off]);
    onPoints.push([beta, on]);
    if (Number.isFinite(off)) finiteValues.push(off);
    if (Number.isFinite(on)) finiteValues.push(on);
  }
  // Close the periodic curve at 360° without treating it as an independent view.
  offPoints.push([360, Number(offValues[0])]);
  onPoints.push([360, Number(onValues[0])]);

  const observedMaximum = Math.max(...finiteValues);
  const paddedMaximum = Math.max(0.01, observedMaximum * 1.06);
  const yStep = niceCeilingStep(paddedMaximum / 5);
  const yMaximum = Math.max(yStep, Math.ceil(paddedMaximum / yStep - 1e-12) * yStep);
  const yTicks = [];
  for (let value = 0; value <= yMaximum + yStep * 1e-8; value += yStep) {
    yTicks.push(Number(value.toPrecision(12)));
  }
  const publicationMode = canvas.dataset.publicationMode === "true";
  const plot = axisContext(canvas, { xMin: 0, xMax: 360, yMin: 0, yMax: yMaximum }, {
    x: "相対X線管角度  β  (°)",
    y: "候補位置の体軸方向標準偏差  σz  (mm)",
    xFormatter: value => Number(value).toFixed(0),
    yFormatter: fixedFormatterForTicks(yTicks, 4),
    topMargin: publicationMode ? 126 : 146,
    bottomMargin: 98,
  });

  plot.ctx.save();
  plot.ctx.beginPath();
  plot.ctx.rect(plot.margin.left, plot.margin.top, plot.innerWidth, plot.innerHeight);
  plot.ctx.clip();
  drawPolyline(plot.ctx, offPoints, plot.x, plot.y, BLUE, 2.6);
  drawPolyline(plot.ctx, onPoints, plot.x, plot.y, ORANGE, 2.8, [9, 5]);
  const markerStride = Math.max(1, Math.ceil(angleCount / 72));
  drawSeriesMarkers(plot.ctx, offPoints.slice(0, angleCount), plot.x, plot.y, BLUE, "circle", markerStride);
  drawSeriesMarkers(plot.ctx, onPoints.slice(0, angleCount), plot.x, plot.y, ORANGE, "cross", markerStride);
  plot.ctx.restore();
  drawAxes(plot, [0, 60, 120, 180, 240, 300, 360], yTicks);

  plot.ctx.fillStyle = INK;
  plot.ctx.textAlign = "left";
  plot.ctx.textBaseline = "top";
  const title = "候補点の体軸方向の広がり";
  setFittedFigureFont(plot.ctx, title, 25, 18, plot.innerWidth, "700");
  plot.ctx.fillText(title, plot.margin.left, 8);
  const subtitle = "実データ側N列＋理想対向角を挟む実取得ビューの全列（無重み）";
  plot.ctx.fillStyle = MUTED;
  setFittedFigureFont(plot.ctx, subtitle, 18, 13, plot.innerWidth);
  plot.ctx.fillText(subtitle, plot.margin.left, 43);
  drawLegend(plot.ctx, [
    { label: "コーン幾何を反映しない", color: BLUE },
    { label: "コーン幾何を反映する", color: ORANGE, dash: [9, 5] },
  ], plot.margin.left, 82, 18);

  canvas.dataset.xAxisMeaning = "relative-tube-angle-beta-degrees-0-to-360";
  canvas.dataset.yAxisMeaning = "unweighted-standard-deviation-of-candidate-row-center-z-positions-mm";
  canvas.dataset.candidateSet = "direct-N-rows-plus-all-rows-of-unique-acquired-complementary-views-bracketing-beta-c";
  canvas.dataset.candidateAdoption = "not-applied";
  canvas.dataset.weighting = overlay.allCandidateAxialSpreadMetadata?.weighting ?? "none";
  canvas.dataset.sliceThicknessUsed = String(overlay.allCandidateAxialSpreadMetadata?.sliceThicknessUsed ?? false);
  canvas.dataset.stateInvariant = String(overlay.allCandidateAxialSpreadMetadata?.stateInvariant ?? true);
  canvas.dataset.unit = overlay.allCandidateAxialSpreadMetadata?.unit ?? "mm";
  canvas.dataset.angularSampleCount = String(angleCount);
  canvas.dataset.angularCoordinates = betaValues ? "overlay.geometryAnglesDeg-half-open" : "fallback-index-over-count-half-open";
  canvas.dataset.periodicEndpoint = "360-degrees-repeats-first-view-for-line-closure-only";
}

function niceBounds(values, padFraction = 0.08, minimumSpan = 0) {
  let min = Math.min(...values.filter(Number.isFinite));
  let max = Math.max(...values.filter(Number.isFinite));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max - min < minimumSpan) {
    const middle = 0.5 * (min + max);
    min = middle - minimumSpan / 2;
    max = middle + minimumSpan / 2;
  } else if (Math.abs(max - min) < 1e-9) {
    min -= 0.05;
    max += 0.05;
  }
  const pad = (max - min) * padFraction;
  return [min - pad, max + pad];
}

function drawPolyline(ctx, points, x, y, color, width = 3, dash = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) { started = false; continue; }
    const px = x(point[0]); const py = y(point[1]);
    if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

function drawLegend(ctx, items, x0, y0, fontSize = 20) {
  ctx.save();
  ctx.font = `${fontSize}px ${FIGURE_FONT}`;
  ctx.textBaseline = "middle";
  items.forEach((item, index) => {
    const y = y0 + index * 30;
    ctx.strokeStyle = item.color; ctx.lineWidth = 5; ctx.setLineDash(item.dash || []);
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + 42, y); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = INK; ctx.fillText(item.label, x0 + 54, y);
  });
  ctx.restore();
}

function niceProfileTicks(min, max, targetCount = 5) {
  const span = Math.max(Number.EPSILON, max - min);
  const rawStep = span / Math.max(2, targetCount - 1);
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const scaled = rawStep / power;
  const factor = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  const step = factor * power;
  const ticks = [];
  const start = Math.ceil((min - 1e-10) / step) * step;
  const end = Math.floor((max + 1e-10) / step) * step;
  for (let value = start; value <= end + step * 1e-8; value += step) {
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : Number(value.toPrecision(12)));
  }
  return ticks.length >= 2 ? ticks : [min, 0, max].filter((value, index, values) => value >= min && value <= max && values.indexOf(value) === index);
}

function stepFromTicks(ticks) {
  const differences = [];
  for (let index = 1; index < ticks.length; index += 1) {
    const difference = Math.abs(ticks[index] - ticks[index - 1]);
    if (difference > Number.EPSILON) differences.push(difference);
  }
  return differences.length ? Math.min(...differences) : 1;
}

function fixedFormatterForTicks(ticks, maximumDigits = 6) {
  const digits = Math.min(maximumDigits, decimalPlacesForStep(stepFromTicks(ticks)));
  return value => {
    const normalized = Math.abs(value) < 0.5 * (10 ** -digits) ? 0 : value;
    return Number(normalized).toFixed(digits);
  };
}

function symmetricNiceAxis(requiredHalfSpan, targetHalfIntervals = 3) {
  const rawStep = Math.max(Number.EPSILON, requiredHalfSpan / Math.max(1, targetHalfIntervals));
  const step = niceNearestStep(rawStep);
  const halfIntervals = Math.max(1, Math.ceil(requiredHalfSpan / step - 1e-12));
  const limit = halfIntervals * step;
  const ticks = Array.from({ length: 2 * halfIntervals + 1 }, (_, index) => (index - halfIntervals) * step);
  return { xMin: -limit, xMax: limit, step, ticks, formatter: fixedFormatterForTicks(ticks) };
}

function niceNearestStep(value) {
  const positive = Math.max(Number.EPSILON, Number(value));
  const power = 10 ** Math.floor(Math.log10(positive));
  const normalized = positive / power;
  const factors = [1, 2, 5, 10];
  let best = factors[0];
  let bestDistance = Math.abs(normalized - best);
  for (const factor of factors.slice(1)) {
    const distance = Math.abs(normalized - factor);
    if (distance < bestDistance - 1e-12) {
      best = factor;
      bestDistance = distance;
    }
  }
  return best * power;
}

function niceScale(values, { targetIntervals = 4, padFraction = 0.06, minimumSpan = 0 } = {}) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], step: 0.25 };
  let minimum = Math.min(...finite);
  let maximum = Math.max(...finite);
  if (maximum - minimum < minimumSpan) {
    const middle = 0.5 * (minimum + maximum);
    minimum = middle - minimumSpan / 2;
    maximum = middle + minimumSpan / 2;
  }
  if (maximum - minimum <= Number.EPSILON) {
    const delta = Math.max(0.05, Math.abs(maximum) * 0.02);
    minimum -= delta;
    maximum += delta;
  }
  const paddedSpan = (maximum - minimum) * (1 + 2 * padFraction);
  const step = niceCeilingStep(paddedSpan / Math.max(2, targetIntervals));
  const paddedMinimum = minimum - (maximum - minimum) * padFraction;
  const paddedMaximum = maximum + (maximum - minimum) * padFraction;
  let niceMinimum = Math.floor((paddedMinimum + 1e-12) / step) * step;
  let niceMaximum = Math.ceil((paddedMaximum - 1e-12) / step) * step;
  if (niceMaximum <= niceMinimum) niceMaximum = niceMinimum + step;
  const ticks = [];
  for (let value = niceMinimum; value <= niceMaximum + step * 1e-8; value += step) {
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : Number(value.toPrecision(12)));
  }
  return { min: niceMinimum, max: niceMaximum, ticks, step, formatter: fixedFormatterForTicks(ticks) };
}

function niceCeilingStep(value) {
  const positive = Math.max(Number.EPSILON, Number(value));
  const power = 10 ** Math.floor(Math.log10(positive));
  const normalized = positive / power;
  for (const factor of [1, 2, 5, 10]) {
    if (normalized <= factor + 1e-12) return factor * power;
  }
  return 10 * power;
}

function decimalPlacesForStep(step) {
  for (let digits = 0; digits <= 6; digits += 1) {
    if (Math.abs(step - Number(step.toFixed(digits))) <= Math.max(1e-12, Math.abs(step) * 1e-10)) return digits;
  }
  return 6;
}

function selectedProfileAxis(result) {
  // The selected-state chart is a linear-scale view of the configured output,
  // so its domain is determined only by the part of the final SSPz at or above
  // 10% of the peak. Low-amplitude tails are intentionally moved to the
  // dedicated logarithmic tail panel instead of compressing the central shape.
  const threshold = 0.1;
  const z = result.selectedOff.z;
  const dz = z.length > 1 ? Math.abs(z[1] - z[0]) : 0;
  let observedHalfSupport = 0;

  const includeProfile = (profileZ, profile) => {
    if (!profileZ || !profile) return;
    const length = Math.min(profileZ.length, profile.length);
    for (let index = 0; index < length; index += 1) {
      if (profile[index] >= threshold) observedHalfSupport = Math.max(observedHalfSupport, Math.abs(profileZ[index]));
    }
  };

  includeProfile(result.selectedOff.z, result.selectedOff.profile);
  includeProfile(result.selectedOn.z, result.selectedOn.profile);

  const minimumHalfSpan = Math.max(0.5 * result.params.rowWidth, 6 * dz);
  const requiredHalfSpan = Math.max(minimumHalfSpan, observedHalfSupport * 1.15 + 3 * dz);
  const nice = symmetricNiceAxis(requiredHalfSpan, 3);
  return {
    xMin: nice.xMin,
    xMax: nice.xMax,
    tickStep: nice.step,
    ticks: nice.ticks,
    observedHalfSupport,
  };
}

function drawProfileEncodingLegend(ctx, left, top) {
  ctx.save();
  ctx.font = `22px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const drawKey = (x, y, color, dash, label) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 50, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK;
    ctx.fillText(label, x + 62, y);
  };
  drawKey(left, top + 20, BLUE, [], "コーン幾何を反映しない");
  drawKey(left + 410, top + 20, ORANGE, [], "コーン幾何を反映する（理想化）");
  ctx.restore();
}

function drawProfiles(canvas, result) {
  const publicationMode = canvas.dataset.publicationMode === "true";
  const axis = selectedProfileAxis(result);
  const { xMin, xMax } = axis;
  const plot = axisContext(canvas, { xMin, xMax, yMin: 0, yMax: 1.04 }, {
    x: localizedText("物体に対する再構成面の位置  zᵣ − zₒ (mm)", "Reconstruction-plane position relative to object  zᵣ − zₒ (mm)"),
    y: "正規化SSPz",
    xFormatter: value => Number(value).toFixed(decimalPlacesForStep(axis.tickStep)),
    yFormatter: value => value.toFixed(1),
    topMargin: publicationMode ? 96 : 126,
  });
  const off = result.selectedOff.z.map((z, i) => [z, result.selectedOff.profile[i]]);
  const on = result.selectedOn.z.map((z, i) => [z, result.selectedOn.profile[i]]);
  // Paint the grid first: a flat normalized peak at exactly 1 must remain
  // visible instead of being overwritten by the 100% gridline.
  drawAxes(plot, axis.ticks, [0, 0.2, 0.4, 0.6, 0.8, 1.0]);
  plot.ctx.save();
  plot.ctx.beginPath();
  plot.ctx.rect(plot.margin.left, plot.margin.top, plot.innerWidth, plot.innerHeight);
  plot.ctx.clip();
  drawPolyline(plot.ctx, off, plot.x, plot.y, BLUE, 4);
  drawPolyline(plot.ctx, on, plot.x, plot.y, ORANGE, 4);
  plot.ctx.save(); plot.ctx.strokeStyle = MUTED; plot.ctx.setLineDash([5,5]); plot.ctx.lineWidth = 1;
  for (const level of [0.5, 0.1]) { plot.ctx.beginPath(); plot.ctx.moveTo(plot.margin.left, plot.y(level)); plot.ctx.lineTo(plot.margin.left + plot.innerWidth, plot.y(level)); plot.ctx.stroke(); }
  plot.ctx.restore();
  plot.ctx.restore();
  drawProfileEncodingLegend(plot.ctx, plot.margin.left, 6);
  plot.ctx.save();
  plot.ctx.fillStyle = MUTED;
  setFittedFigureFont(plot.ctx, filterParameterLabel(result.params, result.selectedOn.filterSamples), 18, 14, plot.innerWidth);
  plot.ctx.fillText(filterParameterLabel(result.params, result.selectedOn.filterSamples), plot.margin.left, 72);
  plot.ctx.restore();
  plot.ctx.save();
  plot.ctx.fillStyle = MUTED;
  plot.ctx.font = `18px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "right";
  plot.ctx.textBaseline = "bottom";
  plot.ctx.fillText("50%（FWHM）", plot.margin.left + plot.innerWidth - 8, plot.y(0.5) - 5);
  plot.ctx.fillText("10%（FWTM）", plot.margin.left + plot.innerWidth - 8, plot.y(0.1) - 5);
  plot.ctx.restore();
  canvas.dataset.xMin = String(axis.xMin);
  canvas.dataset.xMax = String(axis.xMax);
  canvas.dataset.xStep = String(axis.tickStep);
  canvas.dataset.configuredThicknessMm = String(result.params.sliceThicknessMm);
  canvas.dataset.filterWidthMm = String(result.params.filterWidthMm);
  canvas.dataset.filterSamples = String(result.selectedOn.filterSamples);
  canvas.dataset.requestedFilterSamples = String(result.params.filterSamples);
  canvas.dataset.responseCoordinate = "reconstruction-plane-minus-fixed-object-mm";
  canvas.dataset.axisRule = "configured-output-at-or-above-ten-percent";
  canvas.dataset.legendOrder = "configured-output-only";
  canvas.setAttribute("aria-label", localizedText(`フィルタ補間後の選択状態SSPz。${filterParameterLabel(result.params, result.selectedOn.filterSamples)}。横軸は固定した薄い物体に対する再構成面位置`, `Selected-state SSPz after filter interpolation. ${filterParameterLabel(result.params, result.selectedOn.filterSamples)}. Horizontal axis: reconstruction-plane position relative to a fixed thin object.`));
  if (profileAxisNote) {
    profileAxisNote.textContent = localizedText(`${filterParameterLabel(result.params, result.selectedOn.filterSamples)}／横軸は固定物体に対する再構成面位置（10%以上から自動調整）`, `${filterParameterLabel(result.params, result.selectedOn.filterSamples)} / horizontal axis: reconstruction-plane position relative to the fixed object (auto-scaled from values >=10%)`);
  }
}

function drawOverlayLegend(ctx, x, y, color) {
  ctx.save();
  ctx.font = `20px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 36, y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = INK;
  ctx.fillText("360状態", x + 45, y);
  ctx.restore();
}

function configuredOverlayBounds(result, threshold, minimumHalfSpan, conditions = ["off", "on"]) {
  const overlay = result.overlay;
  const summaries = conditions.map(condition => overlay[condition].finalSummary);
  let first = overlay.zCount - 1;
  let last = 0;
  let found = false;
  for (const summary of summaries) {
    for (let index = 0; index < overlay.zCount; index += 1) {
      if (summary.maximum[index] >= threshold) {
        found = true;
        first = Math.min(first, index);
        last = Math.max(last, index);
      }
    }
  }
  const rawHalfSpan = found
    ? Math.max(Math.abs(overlay.z[Math.max(0, first)]), Math.abs(overlay.z[Math.min(overlay.zCount - 1, last)]))
    : 0;
  const dz = overlay.zCount > 1 ? Math.abs(overlay.z[1] - overlay.z[0]) : 0;
  const requiredHalfSpan = Math.max(minimumHalfSpan, rawHalfSpan * 1.12 + 3 * dz);
  return symmetricNiceAxis(requiredHalfSpan, 3);
}

function configuredOverlayAxes(result) {
  const core = configuredOverlayBounds(result, 0.1, 0.5 * result.params.rowWidth);
  const tail = configuredOverlayBounds(result, 0.001, core.xMax, ["on"]);
  return { core, tail };
}

function drawProfileOverlay(canvas, result, coneOn, viewMode, xAxis = configuredOverlayAxes(result)[viewMode]) {
  const publicationMode = canvas.dataset.publicationMode === "true";
  const overlay = result.overlay;
  if (!overlay) return;
  const condition = coneOn ? overlay.on : overlay.off;
  const values = condition.final;
  const summary = condition.finalSummary;
  const z = overlay.z;
  const { xMin, xMax } = xAxis;
  const color = coneOn ? ORANGE : BLUE;
  const tailView = viewMode === "tail";
  const stageLabel = tailView
    ? localizedText("フィルタ補間後SSPz・低振幅裾", "Filter-interpolated SSPz: low-amplitude tails")
    : localizedText("フィルタ補間後SSPz・中心形状", "Filter-interpolated SSPz: central shape");
  const plot = axisContext(canvas, {
    xMin,
    xMax,
    yMin: tailView ? PROFILE_TAIL_DISPLAY_BOUNDS.yMin : 0,
    yMax: tailView ? PROFILE_TAIL_DISPLAY_BOUNDS.yMax : 1.04,
  }, {
    x: localizedText("物体に対する再構成面の位置  zᵣ − zₒ (mm)", "Reconstruction-plane position relative to object  zᵣ − zₒ (mm)"),
    y: tailView ? "正規化SSPz（対数）" : "正規化SSPz",
    xFormatter: xAxis.formatter,
    yFormatter: tailView
      ? value => ({ "-3": "0.1%", "-2": "1%", "-1": "10%", "0": "100%" }[String(value)] ?? "")
      : value => value.toFixed(1),
    topMargin: publicationMode ? 116 : 126,
    leftMargin: tailView ? 158 : undefined,
  });

  // The 100% plateau can coincide exactly with a gridline. Keep the grid
  // behind every individual SSPz in both the screen and publication paths.
  drawAxes(plot, xAxis.ticks, tailView ? [-3, -2, -1, 0] : [0, 0.2, 0.4, 0.6, 0.8, 1.0]);
  plot.ctx.save();
  plot.ctx.beginPath();
  plot.ctx.rect(plot.margin.left, plot.margin.top, plot.innerWidth, plot.innerHeight);
  plot.ctx.clip();

  // Draw all 360 configured-output states as separate paths, without a
  // summary band or state decimation. The core view is linear and restricted
  // to >=10%; the tail view is logarithmic and restricted to >=0.1%.
  for (let stateIndex = 0; stateIndex < overlay.stateCount; stateIndex += 1) {
    const complete = condition.coverage[stateIndex] >= 1 - 1e-7;
    const offset = stateIndex * overlay.zCount;
    plot.ctx.save();
    plot.ctx.strokeStyle = complete ? color : MUTED;
    plot.ctx.globalAlpha = complete ? 0.13 : 0.26;
    plot.ctx.lineWidth = 1.1;
    plot.ctx.setLineDash(complete ? [] : [4, 4]);
    plot.ctx.beginPath();
    let active = false;
    for (let zIndex = 0; zIndex < overlay.zCount; zIndex += 1) {
      const value = values[offset + zIndex];
      if (tailView && value < 0.001) {
        active = false;
        continue;
      }
      const px = plot.x(z[zIndex]);
      const py = plot.y(tailView ? Math.log10(Math.max(0.001, value)) : value);
      if (!active) plot.ctx.moveTo(px, py); else plot.ctx.lineTo(px, py);
      active = true;
    }
    plot.ctx.stroke();
    plot.ctx.restore();
  }

  plot.ctx.strokeStyle = MUTED;
  plot.ctx.setLineDash([5, 5]);
  plot.ctx.lineWidth = 1;
  const guideLevels = tailView ? [-2, -1] : [0.5, 0.1];
  for (const level of guideLevels) {
    plot.ctx.beginPath();
    plot.ctx.moveTo(plot.margin.left, plot.y(level));
    plot.ctx.lineTo(plot.margin.left + plot.innerWidth, plot.y(level));
    plot.ctx.stroke();
  }
  plot.ctx.restore();

  plot.ctx.save();
  plot.ctx.fillStyle = INK;
  plot.ctx.font = `700 23px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "left";
  plot.ctx.textBaseline = "top";
  const conditionLabel = coneOn ? "コーン幾何を反映する（周期的距離変化）" : "コーン幾何を反映しない（平行ビーム近似）";
  if (publicationMode) {
    const conciseCondition = coneOn ? "コーン幾何あり" : "コーン幾何なし";
    const conciseStage = stageLabel;
    // Keep the scientific stage and geometry condition on separate lines.
    // A single English line exceeds the fixed 80-mm journal figure width.
    setFittedFigureFont(plot.ctx, conciseStage, 23, 17, plot.innerWidth, "700");
    plot.ctx.fillText(conciseStage, plot.margin.left, 8);
    plot.ctx.font = `20px ${FIGURE_FONT}`;
    const subtitle = `${conciseCondition} / ${filterParameterLabel(result.params, result.selectedOn.filterSamples)}`;
    setFittedFigureFont(plot.ctx, subtitle, 20, 13, plot.innerWidth);
    plot.ctx.fillText(subtitle, plot.margin.left, 38);
  } else {
    setFittedFigureFont(plot.ctx, stageLabel, 23, 17, plot.innerWidth, "700");
    plot.ctx.fillText(stageLabel, plot.margin.left, 10);
    plot.ctx.fillStyle = MUTED;
    const statusLabel = `${conditionLabel} / ${filterParameterLabel(result.params, result.selectedOn.filterSamples)}`;
    setFittedFigureFont(plot.ctx, statusLabel, 20, 15, plot.innerWidth);
    plot.ctx.fillText(statusLabel, plot.margin.left, 44);
  }
  plot.ctx.restore();
  drawOverlayLegend(plot.ctx, plot.margin.left, publicationMode ? 82 : 92, color);
  plot.ctx.save();
  plot.ctx.fillStyle = INK;
  plot.ctx.font = `18px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "right";
  plot.ctx.textBaseline = "bottom";
  if (tailView) {
    plot.ctx.fillText("10%", plot.margin.left + plot.innerWidth - 8, plot.y(-1) - 5);
    plot.ctx.fillText("1%", plot.margin.left + plot.innerWidth - 8, plot.y(-2) - 5);
  } else {
    plot.ctx.fillText("50%", plot.margin.left + plot.innerWidth - 8, plot.y(0.5) - 5);
    plot.ctx.fillText("10%", plot.margin.left + plot.innerWidth - 8, plot.y(0.1) - 5);
  }
  plot.ctx.restore();
  canvas.dataset.individualProfileCount = String(overlay.stateCount);
  canvas.dataset.individualProfileRendering = "one-path-per-state";
  canvas.dataset.xMin = String(xAxis.xMin);
  canvas.dataset.xMax = String(xAxis.xMax);
  canvas.dataset.xStep = String(xAxis.step);
  canvas.dataset.profileStage = "configured-output-only";
  canvas.dataset.filterWidthMm = String(result.params.filterWidthMm);
  canvas.dataset.filterSamples = String(result.selectedOn.filterSamples);
  canvas.dataset.requestedFilterSamples = String(result.params.filterSamples);
  canvas.dataset.responseCoordinate = "reconstruction-plane-minus-fixed-object-mm";
  canvas.dataset.viewMode = viewMode;
  if (tailView) {
    canvas.dataset.renderedMinimum = "0.001";
    canvas.dataset.displayYMinLog10 = String(PROFILE_TAIL_DISPLAY_BOUNDS.yMin);
    canvas.dataset.displayYMaxLog10 = String(PROFILE_TAIL_DISPLAY_BOUNDS.yMax);
  }
  canvas.dataset.sharedXDomain = tailView
    ? "configured-output-tail-cone-on"
    : "configured-output-core-off-on";
  canvas.setAttribute("aria-label", `${stageLabel} / ${conditionLabel} / ${filterParameterLabel(result.params, result.selectedOn.filterSamples)}`);
}

function filterParameterLabel(params, actualSamples = params.filterSamples) {
  return `FW=${fmt(params.filterWidthMm, 2)} mm; K=${actualSamples}; T=${fmt(params.sliceThicknessMm, 1)} mm`;
}

function selectedMetric(result) {
  const key = metricSelect.value;
  const labels = { fwhm: "FWHM", fwtm: "FWTM", sigma: "σ" };
  const layered = false;
  const stageLabel = localizedText("フィルタ補間後SSPz", "Filter-interpolated SSPz");
  metricLabel.textContent = `${stageLabel} / ${labels[key]}`;
  return { key, rawKey: key, label: labels[key], stageLabel, layered };
}

function drawConditionLegend(ctx, left, y) {
  ctx.save();
  ctx.font = `21px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const items = [
    { x: left, color: BLUE, label: "コーン幾何を反映しない" },
    { x: left + 430, color: ORANGE, label: "コーン幾何を反映する（理想化）" },
  ];
  for (const item of items) {
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 4;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(item.x, y); ctx.lineTo(item.x + 52, y); ctx.stroke();
    ctx.fillStyle = INK;
    ctx.fillText(item.label, item.x + 64, y);
  }
  ctx.restore();
}

function drawSweep(canvas, result) {
  const metric = selectedMetric(result);
  const publicationMode = canvas.dataset.publicationMode === "true";
  const thickness = result.params.sliceThicknessMm;
  const ratioValue = row => row[metric.key] / thickness;
  const values = result.sweep.map(ratioValue);
  const yScale = niceScale(values, { targetIntervals: 5, padFraction: 0.08, minimumSpan: 0.01 });
  const plot = axisContext(canvas, { xMin: 0, xMax: 1, yMin: yScale.min, yMax: yScale.max }, {
    x: localizedText("1回転寝台移動量内の物体位置  s", "Object position within one table feed  s"),
    y: `${metric.label} / T`,
    xFormatter: value => Number(value).toFixed(1),
    yFormatter: yScale.formatter,
    topMargin: publicationMode ? 105 : 134,
    leftMargin: 158,
  });
  for (const coneOn of [false, true]) {
    const points = result.sweep
      .filter(row => row.coneOn === coneOn)
      .map(row => [row.state, ratioValue(row)]);
    drawPolyline(plot.ctx, points, plot.x, plot.y, coneOn ? ORANGE : BLUE, 4);
  }
  if (metric.rawKey === "fwhm" && yScale.min <= 1 && 1 <= yScale.max) {
    plot.ctx.save();
    plot.ctx.strokeStyle = MUTED;
    plot.ctx.lineWidth = 1.4;
    plot.ctx.setLineDash([6, 5]);
    plot.ctx.beginPath();
    plot.ctx.moveTo(plot.margin.left, plot.y(1));
    plot.ctx.lineTo(plot.margin.left + plot.innerWidth, plot.y(1));
    plot.ctx.stroke();
    plot.ctx.restore();
  }
  if (!publicationMode) {
    const selectedState = selectedStateIndex / 360;
    plot.ctx.save();
    plot.ctx.strokeStyle = INK;
    plot.ctx.lineWidth = 2;
    plot.ctx.setLineDash([5, 4]);
    plot.ctx.beginPath();
    plot.ctx.moveTo(plot.x(selectedState), plot.margin.top);
    plot.ctx.lineTo(plot.x(selectedState), plot.margin.top + plot.innerHeight);
    plot.ctx.stroke();
    plot.ctx.setLineDash([]);
    for (const coneOn of [false, true]) {
      const row = result.sweep.find(item => item.coneOn === coneOn && item.stateIndex === selectedStateIndex);
      if (!row) continue;
      plot.ctx.fillStyle = coneOn ? ORANGE : BLUE;
      plot.ctx.strokeStyle = "#fff";
      plot.ctx.lineWidth = 2;
      plot.ctx.beginPath();
      plot.ctx.arc(plot.x(selectedState), plot.y(ratioValue(row)), 6, 0, Math.PI * 2);
      plot.ctx.fill();
      plot.ctx.stroke();
    }
    plot.ctx.restore();
  }
  const stateTicks = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  drawAxes(plot, stateTicks, yScale.ticks);
  if (!publicationMode) {
    plot.ctx.save();
    plot.ctx.fillStyle = INK;
    plot.ctx.font = `700 24px ${FIGURE_FONT}`;
    plot.ctx.textAlign = "left";
    plot.ctx.textBaseline = "top";
    plot.ctx.fillText(`${metric.stageLabel} / ${metric.label}`, plot.margin.left, 13);
    plot.ctx.fillStyle = MUTED;
    plot.ctx.font = `20px ${FIGURE_FONT}`;
    const subtitle = filterParameterLabel(result.params, result.selectedOn.filterSamples);
    plot.ctx.fillText(subtitle, plot.margin.left, 45);
    plot.ctx.restore();
  }
  if (publicationMode) {
    plot.ctx.save();
    plot.ctx.fillStyle = MUTED;
    setFittedFigureFont(plot.ctx, filterParameterLabel(result.params, result.selectedOn.filterSamples), 19, 14, plot.innerWidth);
    plot.ctx.fillText(filterParameterLabel(result.params, result.selectedOn.filterSamples), plot.margin.left, 78);
    plot.ctx.restore();
  }
  drawConditionLegend(plot.ctx, plot.margin.left, publicationMode ? 34 : 94);
  canvas.dataset.xMin = "0";
  canvas.dataset.xMax = "1";
  canvas.dataset.xStep = "0.2";
  canvas.dataset.yMin = String(yScale.min);
  canvas.dataset.yMax = String(yScale.max);
  canvas.dataset.yStep = String(yScale.step);
  canvas.dataset.normalization = "width-divided-by-configured-slice-thickness";
  canvas.dataset.axisRule = "natural-1-2-5-with-consistent-decimals";
  if (sweepInterpretation) {
    sweepInterpretation.hidden = false;
    sweepInterpretation.textContent = localizedText("Taguchiらのフィルタ補間後の幅を参照値Tで除しています。FWはTと独立で、FW=TでもFWHM=Tを保証しません。フィルタ再標本点数Kを増やした収束と、FWTM・σ・形状全体を併せて確認してください。", "Widths after Taguchi-style filter interpolation are divided by reference thickness T. FW is independent of T; FW=T does not guarantee FWHM=T. Check convergence as filter resampling count K increases, together with FWTM, sigma, and the full profile shape.");
  }
}

function renderSummary(result) {
  const primaryCards = [];
  const secondaryCards = [];
  const uses180Li = result.params.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI;
  const gapRatioLabel = uses180Li ? "Gₑff/T" : "Δz/T";
  for (const [key, label, css, spreadKey] of [
    ["off", "コーン幾何を反映しない", "", "allCandidateAxialSpreadOffMm"],
    ["on", "コーン幾何を反映する", "on", "allCandidateAxialSpreadOnMm"],
  ]) {
    const summary = result.summaries[key];
    const spreadValues = Array.from(result.overlay?.[spreadKey] ?? []).filter(Number.isFinite);
    const spreadMinimum = spreadValues.length ? Math.min(...spreadValues) : NaN;
    const spreadMaximum = spreadValues.length ? Math.max(...spreadValues) : NaN;
    primaryCards.push(`
      <div class="summary-card ${css}">
        <span>${label} / 候補位置の体軸方向標準偏差の最大（mm）</span>
        <strong>${fmt(spreadMaximum, 3)}</strong>
        <small>投影角度別範囲 ${fmt(spreadMinimum, 3)}–${fmt(spreadMaximum, 3)} mm／無重み</small>
      </div>`);
    secondaryCards.push(`
      <div class="summary-card ${css}">
        <span>${label} / ${localizedText("フィルタ補間後SSPzのFWHM/T変動幅", "Range of filter-interpolated SSPz FWHM/T")}</span>
        <strong>${fmt(summary.fwhm.range / result.params.sliceThicknessMm, 4)}</strong>
        <small>${fmt(summary.fwhm.min / result.params.sliceThicknessMm, 3)}–${fmt(summary.fwhm.max / result.params.sliceThicknessMm, 3)}</small>
      </div>`);
  }
  // SSPz-shape evidence is followed by the pre-adoption, unweighted geometric
  // spread of all row-center candidates for each direct-view angle.
  summaryCards.innerHTML = [...secondaryCards, ...primaryCards].join("");
  resultTable.innerHTML = [
    ["コーン幾何を反映しない（平行ビーム近似）", result.selectedOff],
    ["コーン幾何を反映する（周期的距離変化）", result.selectedOn],
  ].map(([label, row]) => `<tr><td>${label}</td><td>${fmt(row.fwhm, 3)}</td><td>${fmt(row.fwtm, 3)}</td><td>${fmt(row.sigma, 3)}</td><td>${fmt(row.bracketGapRatioMax, 3)}</td></tr>`).join("");
  const gapHeading = document.querySelector("#gap-summary-heading");
  if (gapHeading) gapHeading.textContent = `最大 ${gapRatioLabel}（監査）`;
  const gapNote = document.querySelector("#gap-summary-note");
  if (gapNote) gapNote.textContent = uses180Li
    ? "注：SSPz＝体軸方向スライス感度プロファイル、FWHM＝半値幅、FWTM＝10%幅、σ＝面積正規化したSSPzの標準偏差。Gₑff/Tは、理想対向角を挟む2枝の挟み込み幅を角度方向に加重し、設定スライス厚で除した値です。表示桁数はモデル出力の記録用であり、実測精度を意味しません。"
    : "注：SSPz＝体軸方向スライス感度プロファイル、FWHM＝半値幅、FWTM＝10%幅、σ＝面積正規化したSSPzの標準偏差。Δz/Tは、実データ側で目的断面を挟む最近接候補間隔を設定スライス厚で除した値です。表示桁数はモデル出力の記録用であり、実測精度を意味しません。";
  const caption = document.querySelector("#result-caption");
  if (caption) caption.textContent = `閲覧中のモデル状態${selectedStateIndex}/359（s=${(selectedStateIndex / 360).toFixed(3)}）における結果`;
}

function updateProfileModelNote(result) {
  const multiComponent = Math.max(result.selectedOff.halfComponents, result.selectedOn.halfComponents) > 1;
  const pathText = result.params.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
    ? "主解析では、各実データ側ビューの理想対向角を挟む両隣の実取得ビューについて、実データ側・対向データ側の全列候補を統合して体軸方向の最近接挟み込みを作り、その2枝を角度方向に線形合成します。"
    : "比較表示では、対向データ側をSSPzへ用いず、0～360°の実データ側ビューだけで体軸方向の最近接挟み込みを作ります。";
  const candidateSpreadText = "幾何表示では、実データ側の全列と、理想対向角を挟む実取得ビューの全列について、列中心位置の体軸方向標準偏差を無重みで示します。候補点の採用、補間・再構成重み、設定厚による閾値は適用しません。";
  const modelText = localizedText(`Taguchiらの式（6）・Fig. 5/6に基づき、再構成面周囲のK個のz位置で取得候補を選び直し、線形補間した値を矩形重みで平均します。${filterParameterLabel(result.params, result.selectedOn.filterSamples)}。固定した薄い物体に対して再構成面を動かした応答です。360状態は寝台移動量内の物体位置であり、各SSPz内の横軸はzᵣ−zₒです。FWと設定厚Tの対応は実機に校正せず、FWHMは結果として計算します。展開図の端点・間隔は中心位置でのFW=0の局所補間の監査で、厚いスライスの全寄与候補ではありません。取得幾何の全列表示は変更していません。これは理想的な列開口と体軸応答のモデルであり、全画像再構成・装置固有の重み・逆投影・有限ビーズ径は再現しません。`, `Using Eq. (6) and Figs. 5/6 of Taguchi et al., acquired candidates are reselected at K longitudinal positions around the reconstruction plane, locally linearly interpolated, and averaged with rectangular weights. ${filterParameterLabel(result.params, result.selectedOn.filterSamples)}. The response is evaluated by moving the reconstruction plane past a fixed thin object. The 360 states are object positions within one table feed; the coordinate within each SSPz is zᵣ−zₒ. FW is not calibrated to scanner-specific nominal thickness T, and FWHM is an output. Diagram endpoints and gaps audit local FW=0 interpolation at the central position; they are not all contributors to the thick-slice response. All-row acquisition geometry is unchanged. This ideal row-aperture and axial-response model does not reproduce full image reconstruction, scanner-specific weights, backprojection, or finite bead diameter.`);
  const topologyText = multiComponent
    ? " 注意：50%水準が複数成分に分かれています。FWHMだけで形状を代表させないでください。"
    : "";
  const gridWarning = [result.selectedOff, result.selectedOn].some(profile => profile.gridResolutionAdequate === false)
    ? localizedText(" 注意：SSPzの体軸グリッドが精度目安より粗い状態です。グリッド点数を増やして収束を確認するまで、幅指標を確定値として使用しないでください。", " Warning: the SSPz longitudinal grid is coarser than the accuracy guideline. Increase grid resolution and verify convergence before treating width metrics as final.")
    : "";
  profileModelNote.textContent = modelText + topologyText + gridWarning;
}

function localizedText(ja, en) {
  return document.documentElement.lang.toLowerCase().startsWith("en") ? en : ja;
}

function drawGeometryArrow(ctx, from, to, color = INK, width = 1.5) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = 7;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawGeometryMarker(ctx, point, type, color, size = 4.5, fill = "#fff") {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = fill;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.beginPath();
  if (type === "square") {
    ctx.rect(point.x - size, point.y - size, size * 2, size * 2);
  } else if (type === "diamond") {
    ctx.moveTo(point.x, point.y - size * 1.25);
    ctx.lineTo(point.x + size * 1.25, point.y);
    ctx.lineTo(point.x, point.y + size * 1.25);
    ctx.lineTo(point.x - size * 1.25, point.y);
    ctx.closePath();
  } else if (type === "triangle") {
    ctx.moveTo(point.x, point.y - size * 1.2);
    ctx.lineTo(point.x + size * 1.1, point.y + size);
    ctx.lineTo(point.x - size * 1.1, point.y + size);
    ctx.closePath();
  } else {
    ctx.arc(point.x, point.y, size, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function acquisitionGeometryScene(result) {
  const diagram = result?.diagramOn;
  const series = diagram?.complementaryCandidates;
  const trace = diagram?.traceGeometry;
  if (!diagram || !series || !trace || !series.viewCount) return null;
  const params = result.params;
  const viewCount = series.viewCount;
  const viewStepDeg = series.viewStepDeg;
  const feed = trace.feed;
  const z0 = diagram.z0;
  const zReference = Number(params.zReference ?? 0);
  const targetAngleDeg = 360 * z0 / feed;
  let directViewIndex = 0;
  let turnShift = 0;
  let bestError = Infinity;
  for (let index = 0; index < viewCount; index += 1) {
    const midpoint = (series.baseAnglesDeg[index] + series.idealComplementAnglesUnwrappedDeg[index]) / 2;
    const shift = Math.round((targetAngleDeg - midpoint) / 360);
    const error = Math.abs(midpoint + shift * 360 - targetAngleDeg);
    if (error < bestError) {
      bestError = error;
      directViewIndex = index;
      turnShift = shift;
    }
  }
  const directAbsoluteViewIndex = directViewIndex + turnShift * viewCount;
  const lowerComplementAbsoluteViewIndex = series.lowerComplementAbsoluteViewIndices[directViewIndex] + turnShift * viewCount;
  const upperComplementAbsoluteViewIndex = series.upperComplementAbsoluteViewIndices[directViewIndex] + turnShift * viewCount;
  const nearestComplementAbsoluteViewIndex = series.nearestComplementAbsoluteViewIndices[directViewIndex] + turnShift * viewCount;
  const directAngleDeg = series.baseAnglesDeg[directViewIndex] + turnShift * 360;
  const idealComplementAngleDeg = series.idealComplementAnglesUnwrappedDeg[directViewIndex] + turnShift * 360;
  const lowerComplementAngleDeg = lowerComplementAbsoluteViewIndex * viewStepDeg;
  const upperComplementAngleDeg = upperComplementAbsoluteViewIndex * viewStepDeg;
  const nearestComplementAngleDeg = nearestComplementAbsoluteViewIndex * viewStepDeg;
  const phase = Number(params.phase ?? 0);
  const sourceRadius = params.sourceRadius;
  const radialPosition = params.radius;
  const rowOffsets = Array.from(trace.rowOffsets);
  const point = {
    x: radialPosition * Math.cos(phase),
    y: radialPosition * Math.sin(phase),
  };
  const distanceScale = angleDeg => {
    const angle = angleDeg * Math.PI / 180;
    const sourceX = sourceRadius * Math.cos(angle);
    const sourceY = sourceRadius * Math.sin(angle);
    return Math.hypot(point.x - sourceX, point.y - sourceY) / sourceRadius;
  };
  const family = (angleDeg, absoluteViewIndex, kind) => {
    const angle = angleDeg * Math.PI / 180;
    const sourceZ = feed * absoluteViewIndex / viewCount;
    const scale = distanceScale(angleDeg);
    return {
      kind,
      angleDeg,
      absoluteViewIndex,
      scale,
      source: {
        x: sourceRadius * Math.cos(angle),
        y: sourceRadius * Math.sin(angle),
        z: sourceZ,
      },
      candidates: rowOffsets.map((rowOffset, row) => ({
        row,
        absoluteViewIndex,
        x: point.x,
        y: point.y,
        z: sourceZ + scale * rowOffset,
      })),
    };
  };
  const direct = family(directAngleDeg, directAbsoluteViewIndex, "direct");
  const complementaryLower = family(
    lowerComplementAngleDeg,
    lowerComplementAbsoluteViewIndex,
    "complementary-lower",
  );
  const complementaryUpper = family(
    upperComplementAngleDeg,
    upperComplementAbsoluteViewIndex,
    "complementary-upper",
  );
  const complementaryNearest = family(
    nearestComplementAngleDeg,
    nearestComplementAbsoluteViewIndex,
    "complementary-nearest",
  );

  // The model SSPz uses the two acquired complementary views bracketing the
  // ideal fan-beam complementary angle.  In each angular branch it first
  // selects the nearest longitudinal candidates from the union of the direct
  // and complementary families.  Retain only those selected endpoints for the
  // circle/triangle markers; all row centers remain available as unmarked
  // geometric context.
  const normalizedViewIndex = value => ((Math.round(value) % viewCount) + viewCount) % viewCount;
  const locateFamilyEndpoint = (baseAbsoluteViewIndex, kind, targetZ, preferredRow, preferredAbsoluteViewIndex) => {
    const baseView = Math.round(baseAbsoluteViewIndex);
    const baseModulo = normalizedViewIndex(baseView);
    const preferredView = Math.round(preferredAbsoluteViewIndex);
    if (Number.isFinite(preferredAbsoluteViewIndex)
      && preferredAbsoluteViewIndex >= -Number.MAX_SAFE_INTEGER
      && normalizedViewIndex(preferredView) === baseModulo
      && preferredRow >= 0
      && preferredRow < rowOffsets.length) {
      const selectedFamily = family(preferredView * viewStepDeg, preferredView, kind);
      return { selectedFamily, row: preferredRow };
    }
    const baseAngleDeg = baseView * viewStepDeg;
    const scale = distanceScale(baseAngleDeg);
    const baseSourceZ = feed * baseView / viewCount;
    let best = null;
    for (let row = 0; row < rowOffsets.length; row += 1) {
      const baseCenter = baseSourceZ + scale * rowOffsets[row];
      const turn = Math.round((targetZ - baseCenter) / feed);
      const absoluteViewIndex = baseView + turn * viewCount;
      const center = feed * absoluteViewIndex / viewCount + scale * rowOffsets[row];
      const error = Math.abs(center - targetZ);
      if (!best || error < best.error) best = { row, absoluteViewIndex, error };
    }
    if (!best) return null;
    return {
      selectedFamily: family(best.absoluteViewIndex * viewStepDeg, best.absoluteViewIndex, kind),
      row: best.row,
    };
  };
  const selectedCandidateMap = new Map();
  let selectedBranchEndpointCount = 0;
  const addSelectedEndpoint = (pairSeries, side, branchName, angularWeight, complementBaseAbsoluteViewIndex) => {
    if (!(angularWeight > 1e-12) || !pairSeries?.valid?.[directViewIndex]) return;
    const title = side === "lower" ? "lower" : "upper";
    const signedDistanceMm = Number(pairSeries[`${title}SignedDistanceMm`][directViewIndex]);
    const preferredRow = Number(pairSeries[`${title}Rows`][directViewIndex]);
    const preferredAbsoluteViewIndex = Number(pairSeries[`${title}AbsoluteViewIndices`][directViewIndex]);
    const familyMask = Number(pairSeries[`${title}FamilyMasks`][directViewIndex]);
    const targetZ = z0 + signedDistanceMm;
    const familySpecs = [];
    if (familyMask & 1) {
      familySpecs.push({
        family: "direct",
        baseAbsoluteViewIndex: directViewIndex,
        marker: "circle",
        color: BLUE,
      });
    }
    if (familyMask & 2) {
      familySpecs.push({
        family: branchName === "lower-angle" ? "complementary-lower" : "complementary-upper",
        baseAbsoluteViewIndex: complementBaseAbsoluteViewIndex,
        marker: "triangle",
        color: ORANGE,
      });
    }
    for (const spec of familySpecs) {
      const located = locateFamilyEndpoint(
        spec.baseAbsoluteViewIndex,
        spec.family,
        targetZ,
        preferredRow,
        preferredAbsoluteViewIndex,
      );
      if (!located) continue;
      const candidate = located.selectedFamily.candidates[located.row];
      const key = `${located.selectedFamily.absoluteViewIndex}|${located.row}`;
      selectedBranchEndpointCount += 1;
      const previous = selectedCandidateMap.get(key);
      if (previous) {
        if (!previous.branches.includes(branchName)) previous.branches.push(branchName);
        continue;
      }
      selectedCandidateMap.set(key, {
        key,
        family: spec.family,
        marker: spec.marker,
        color: spec.color,
        row: located.row,
        absoluteViewIndex: located.selectedFamily.absoluteViewIndex,
        source: located.selectedFamily.source,
        point: { ...candidate, z: targetZ },
        signedDistanceMm,
        side,
        branches: [branchName],
      });
    }
  };
  const angularFraction = Math.max(0, Math.min(1, series.angularInterpolationFractions[directViewIndex]));
  const sameComplementaryView = series.lowerComplementAbsoluteViewIndices[directViewIndex]
    === series.upperComplementAbsoluteViewIndices[directViewIndex];
  const lowerAngularWeight = sameComplementaryView ? 1 : 1 - angularFraction;
  const upperAngularWeight = sameComplementaryView ? 0 : angularFraction;
  for (const side of ["lower", "upper"]) {
    addSelectedEndpoint(
      series.lowerAngularNeighborIntegratedPairs,
      side,
      "lower-angle",
      lowerAngularWeight,
      series.lowerComplementAbsoluteViewIndices[directViewIndex],
    );
    addSelectedEndpoint(
      series.upperAngularNeighborIntegratedPairs,
      side,
      "upper-angle",
      upperAngularWeight,
      series.upperComplementAbsoluteViewIndices[directViewIndex],
    );
  }
  const selectedCandidates = [...selectedCandidateMap.values()];
  return {
    feed,
    z0,
    zReference,
    state: diagram.state,
    sourceRadius,
    radialPosition,
    point,
    rows: params.rows,
    rowWidth: params.rowWidth,
    beamPitch: params.beamPitch,
    viewCount,
    viewStepDeg,
    directViewIndex,
    directAngleDisplayDeg: series.baseAnglesDeg[directViewIndex],
    idealComplementAngleDisplayDeg: series.idealComplementAnglesDeg[directViewIndex],
    idealComplementAngleDeg,
    forwardSeparationDeg: series.forwardSeparationsDeg[directViewIndex],
    fanAngleDeg: series.fanAnglesDeg[directViewIndex],
    angularInterpolationFraction: angularFraction,
    direct,
    complementaryLower,
    complementaryUpper,
    complementaryNearest,
    selectedCandidates,
    selectedBranchEndpointCount,
    idealSource: {
      x: sourceRadius * Math.cos(idealComplementAngleDeg * Math.PI / 180),
      y: sourceRadius * Math.sin(idealComplementAngleDeg * Math.PI / 180),
      z: feed * idealComplementAngleDeg / 360,
    },
  };
}

function geometryProjector(panel, scene, zValues) {
  const zMinimum = Math.min(...zValues);
  const zMaximum = Math.max(...zValues);
  const zCenter = (zMinimum + zMaximum) / 2;
  const zUnit = Math.max(scene.feed, scene.rows * scene.rowWidth, zMaximum - zMinimum, 1);
  const raw = point => {
    const x = point.x / scene.sourceRadius;
    const y = point.y / scene.sourceRadius;
    const z = (point.z - zCenter) / zUnit;
    return {
      // Keep the longitudinal z-axis vertical on the page.  Axial position
      // therefore changes screen y only, never screen x.
      x: 0.78 * x - 0.52 * y,
      y: 0.27 * x + 0.24 * y - 0.88 * z,
    };
  };
  const samples = [];
  const helixStartDeg = scene.direct.angleDeg - 55;
  for (let index = 0; index <= 120; index += 1) {
    const angleDeg = helixStartDeg + 360 * index / 120;
    const angle = angleDeg * Math.PI / 180;
    samples.push(raw({
      x: scene.sourceRadius * Math.cos(angle),
      y: scene.sourceRadius * Math.sin(angle),
      z: scene.feed * angleDeg / 360,
    }));
  }
  const planeRadius = Math.max(90, Math.min(270, Math.max(scene.radialPosition + 20, 150)));
  for (let index = 0; index < 72; index += 1) {
    const angle = Math.PI * 2 * index / 72;
    samples.push(raw({ x: planeRadius * Math.cos(angle), y: planeRadius * Math.sin(angle), z: scene.z0 }));
  }
  for (const family of [scene.direct, scene.complementaryLower, scene.complementaryUpper]) {
    samples.push(raw(family.source));
    for (const candidate of family.candidates) samples.push(raw(candidate));
  }
  for (const selected of scene.selectedCandidates) {
    samples.push(raw(selected.source));
    samples.push(raw(selected.point));
  }
  samples.push(raw({ ...scene.point, z: scene.zReference }));
  samples.push(raw({ ...scene.point, z: scene.zReference + scene.feed }));
  samples.push(raw(scene.idealSource));
  const minX = Math.min(...samples.map(point => point.x));
  const maxX = Math.max(...samples.map(point => point.x));
  const minY = Math.min(...samples.map(point => point.y));
  const maxY = Math.max(...samples.map(point => point.y));
  const scale = Math.min(
    (panel.width - 42) / Math.max(0.1, maxX - minX),
    (panel.height - 88) / Math.max(0.1, maxY - minY),
  );
  const offsetX = panel.x + panel.width / 2 - scale * (minX + maxX) / 2;
  const offsetY = panel.y + 48 + (panel.height - 58) / 2 - scale * (minY + maxY) / 2;
  return {
    planeRadius,
    helixStartDeg,
    project(point) {
      const projected = raw(point);
      return { x: offsetX + scale * projected.x, y: offsetY + scale * projected.y };
    },
  };
}

function drawAcquisitionGeometry3D(canvas, result) {
  if (!canvas) return;
  const scene = acquisitionGeometryScene(result);
  if (!scene) {
    drawCanvasStatus(canvas, localizedText("幾何を表示できません", "Geometry unavailable"), "", "error");
    return;
  }
  const cssWidth = Math.max(300, Math.round(canvas.getBoundingClientRect().width || 900));
  const mobile = cssWidth < 620;
  const cssHeight = mobile ? Math.max(630, Math.min(720, cssWidth * 1.9)) : Math.max(500, Math.min(650, cssWidth * 0.66));
  const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const pixelWidth = Math.round(cssWidth * pixelRatio);
  const pixelHeight = Math.round(cssHeight * pixelRatio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.height = `${cssHeight}px`;
  canvas.style.minHeight = "0";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const outer = 12;
  const gap = mobile ? 18 : 16;
  const panelA = mobile
    ? { x: outer, y: outer, width: cssWidth - 2 * outer, height: Math.round(cssHeight * 0.57) }
    : { x: outer, y: outer, width: Math.round((cssWidth - 2 * outer - gap) * 0.65), height: cssHeight - 2 * outer };
  const panelB = mobile
    ? { x: outer, y: panelA.y + panelA.height + gap, width: cssWidth - 2 * outer, height: cssHeight - panelA.height - gap - 2 * outer }
    : { x: panelA.x + panelA.width + gap, y: outer, width: cssWidth - panelA.width - gap - 2 * outer, height: cssHeight - 2 * outer };
  for (const panel of [panelA, panelB]) {
    ctx.fillStyle = "#fbfcfd";
    ctx.strokeStyle = "#c8d2d8";
    ctx.lineWidth = 1;
    ctx.fillRect(panel.x, panel.y, panel.width, panel.height);
    ctx.strokeRect(panel.x + 0.5, panel.y + 0.5, panel.width - 1, panel.height - 1);
  }

  const headingSize = mobile ? 14 : 15;
  const labelSize = mobile ? 11.5 : 12.5;
  const noteSize = mobile ? 10.5 : 11.5;
  ctx.fillStyle = INK;
  ctx.font = `700 ${headingSize}px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(localizedText("A　取得幾何（被写体固定座標・縮尺なし）", "A  Acquisition geometry (object-fixed; not to scale)"), panelA.x + 12, panelA.y + 10, panelA.width - 24);
  ctx.fillText(localizedText("B　全列位置と、再構成面に最も近い候補点", "B  All row positions and candidates nearest to the reconstruction plane"), panelB.x + 12, panelB.y + 10, panelB.width - 24);

  const allZ = [
    scene.zReference,
    scene.z0,
    scene.zReference + scene.feed,
    scene.direct.source.z,
    scene.complementaryLower.source.z,
    scene.complementaryUpper.source.z,
  ];
  for (const family of [scene.direct, scene.complementaryLower, scene.complementaryUpper]) {
    for (const candidate of family.candidates) allZ.push(candidate.z);
  }
  for (const selected of scene.selectedCandidates) {
    allZ.push(selected.source.z, selected.point.z);
  }
  const projector = geometryProjector(panelA, scene, allZ);
  const project = projector.project;

  // Axial reconstruction plane.  It is deliberately orthographic and not a
  // physical detector plane; the latter cannot be located without an SDD.
  ctx.save();
  ctx.beginPath();
  for (let index = 0; index <= 72; index += 1) {
    const angle = Math.PI * 2 * index / 72;
    const point = project({
      x: projector.planeRadius * Math.cos(angle),
      y: projector.planeRadius * Math.sin(angle),
      z: scene.z0,
    });
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(178,24,43,0.075)";
  ctx.strokeStyle = RED;
  ctx.lineWidth = 1.8;
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // One-turn helical focal-spot trajectory, sampled from the same table feed.
  ctx.save();
  ctx.strokeStyle = "#65747d";
  ctx.lineWidth = 1.6;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  for (let index = 0; index <= 160; index += 1) {
    const angleDeg = projector.helixStartDeg + 360 * index / 160;
    const angle = angleDeg * Math.PI / 180;
    const point = project({
      x: scene.sourceRadius * Math.cos(angle),
      y: scene.sourceRadius * Math.sin(angle),
      z: scene.feed * angleDeg / 360,
    });
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
  ctx.restore();

  const representativeRows = Array.from({ length: Math.min(9, scene.rows) }, (_, index) => (
    Math.round(index * (scene.rows - 1) / Math.max(1, Math.min(9, scene.rows) - 1))
  ));
  const rayFamilies = [
    { family: scene.direct, color: BLUE, dash: [], alpha: 0.28 },
    { family: scene.complementaryLower, color: ORANGE, dash: [6, 4], alpha: 0.20 },
    { family: scene.complementaryUpper, color: ORANGE, dash: [2, 3], alpha: 0.20 },
  ];
  for (const item of rayFamilies) {
    const source = project(item.family.source);
    ctx.save();
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 1.25;
    ctx.globalAlpha = item.alpha;
    ctx.setLineDash(item.dash);
    for (const row of representativeRows) {
      const candidate = project(item.family.candidates[row]);
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(candidate.x, candidate.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Stronger rays terminate only at the candidates actually selected by the
  // same two angular branches used by the explanatory 180LI SSPz model.
  for (const selected of scene.selectedCandidates) {
    const source = project(selected.source);
    const candidate = project(selected.point);
    ctx.save();
    ctx.strokeStyle = selected.color;
    ctx.lineWidth = 1.8;
    ctx.globalAlpha = 0.86;
    ctx.setLineDash(selected.family === "direct" ? [] : [4, 3]);
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(candidate.x, candidate.y);
    ctx.stroke();
    ctx.restore();
  }
  drawGeometryMarker(ctx, project(scene.idealSource), "diamond", "#4f5b63", 5, "#fff");

  // Evaluation-point longitudinal line and axis triad.
  const zLow = Math.min(...allZ);
  const zHigh = Math.max(...allZ);
  const pointLow = project({ ...scene.point, z: zLow });
  const pointHigh = project({ ...scene.point, z: zHigh });
  ctx.save();
  ctx.strokeStyle = "#20282d";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(pointLow.x, pointLow.y); ctx.lineTo(pointHigh.x, pointHigh.y); ctx.stroke();
  ctx.restore();
  const targetPoint = project({ ...scene.point, z: scene.z0 });
  for (const selected of scene.selectedCandidates) {
    drawGeometryMarker(
      ctx,
      project(selected.point),
      selected.marker,
      selected.color,
      mobile ? 4.0 : 4.6,
      "#fff",
    );
  }

  // Show where the selected reconstruction plane lies within one table feed.
  // These are positions, not projection angles or interpolation weights.
  const referencePoint = project({ ...scene.point, z: scene.zReference });
  const periodEndPoint = project({ ...scene.point, z: scene.zReference + scene.feed });
  const gaugeX = targetPoint.x;
  const gaugeSide = gaugeX < panelA.x + panelA.width * 0.58 ? 1 : -1;
  const tickLength = 6;
  const labelOffset = gaugeSide * 10;
  const bracketX = gaugeX - gaugeSide * 12;
  const drawPositionTick = (point, color = "#20282d") => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(point.x - tickLength, point.y);
    ctx.lineTo(point.x + tickLength, point.y);
    ctx.stroke();
    ctx.restore();
  };
  drawPositionTick(referencePoint);
  drawPositionTick(periodEndPoint);
  drawPositionTick(targetPoint, RED);
  ctx.save();
  ctx.strokeStyle = "#52616a";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(bracketX, referencePoint.y);
  ctx.lineTo(bracketX, periodEndPoint.y);
  ctx.moveTo(bracketX - 4, referencePoint.y);
  ctx.lineTo(bracketX + 4, referencePoint.y);
  ctx.moveTo(bracketX - 4, periodEndPoint.y);
  ctx.lineTo(bracketX + 4, periodEndPoint.y);
  ctx.stroke();
  ctx.fillStyle = MUTED;
  ctx.font = `700 ${noteSize}px ${FIGURE_FONT}`;
  ctx.textAlign = gaugeSide > 0 ? "left" : "right";
  ctx.textBaseline = "middle";
  ctx.fillText("F", bracketX - gaugeSide * 7, (referencePoint.y + periodEndPoint.y) / 2);
  const sameAsReference = Math.abs(targetPoint.y - referencePoint.y) < 18;
  const sameAsPeriodEnd = Math.abs(targetPoint.y - periodEndPoint.y) < 18;
  const labelX = gaugeX + labelOffset;
  const shortState = scene.state.toFixed(3);
  if (sameAsReference) {
    ctx.fillStyle = RED;
    ctx.fillText(
      localizedText(`s=0（現在）  z₀=zref`, `s=0 (current)  z₀=zref`),
      labelX,
      targetPoint.y,
    );
  } else {
    ctx.fillStyle = MUTED;
    ctx.fillText(localizedText("s=0  zref", "s=0  zref"), labelX, referencePoint.y);
  }
  if (sameAsPeriodEnd) {
    ctx.fillStyle = RED;
    ctx.fillText(
      localizedText(`現在 s=${shortState}  z₀`, `current s=${shortState}  z₀`),
      labelX,
      targetPoint.y,
    );
  } else {
    ctx.fillStyle = MUTED;
    ctx.fillText(localizedText("s=1  zref+F", "s=1  zref+F"), labelX, periodEndPoint.y);
  }
  if (!sameAsReference && !sameAsPeriodEnd) {
    ctx.fillStyle = RED;
    ctx.fillText(
      localizedText(`現在 s=${shortState}  z₀`, `current s=${shortState}  z₀`),
      labelX,
      targetPoint.y,
    );
  }
  ctx.restore();

  const origin = project({ x: 0, y: 0, z: scene.z0 });
  const axisLength = Math.max(80, scene.sourceRadius * 0.22);
  const axisZLength = Math.max(scene.feed * 0.38, scene.rowWidth * 8);
  const xAxis = project({ x: axisLength, y: 0, z: scene.z0 });
  const yAxis = project({ x: 0, y: axisLength, z: scene.z0 });
  const zAxis = project({ x: 0, y: 0, z: scene.z0 + axisZLength });
  drawGeometryArrow(ctx, origin, xAxis, "#46545d", 1.2);
  drawGeometryArrow(ctx, origin, yAxis, "#46545d", 1.2);
  drawGeometryArrow(ctx, origin, zAxis, "#46545d", 1.2);
  ctx.font = `700 ${labelSize}px ${FIGURE_FONT}`;
  ctx.fillStyle = INK;
  ctx.fillText("x", xAxis.x + 3, xAxis.y - 2);
  ctx.fillText("y", yAxis.x + 3, yAxis.y - 2);
  ctx.fillText("z", zAxis.x + 3, zAxis.y - 2);

  const directSource = project(scene.direct.source);
  const complementSource = project(scene.complementaryNearest.source);
  const idealSource = project(scene.idealSource);
  ctx.font = `700 ${labelSize}px ${FIGURE_FONT}`;
  ctx.fillStyle = BLUE;
  ctx.fillText(localizedText("実データ側 β", "Direct side β"), directSource.x + 7, directSource.y - 17);
  ctx.fillStyle = ORANGE;
  ctx.fillText(localizedText("対向データ側の実取得ビュー", "Acquired complementary views"), complementSource.x + 7, complementSource.y + 7, panelA.width * 0.38);
  ctx.fillStyle = "#4f5b63";
  ctx.fillText(localizedText("理想 βc", "Ideal βc"), idealSource.x + 7, idealSource.y - 18);
  ctx.fillStyle = RED;
  ctx.save();
  ctx.strokeStyle = RED;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(panelA.x + 12, panelA.y + 38);
  ctx.lineTo(panelA.x + 34, panelA.y + 38);
  ctx.stroke();
  ctx.fillText(
    localizedText("選択中の再構成面 z₀", "Selected reconstruction plane z₀"),
    panelA.x + 40,
    panelA.y + 30,
    panelA.width * 0.47,
  );
  ctx.restore();

  ctx.fillStyle = MUTED;
  ctx.font = `${noteSize}px ${FIGURE_FONT}`;
  const formula = `βc−β=${scene.forwardSeparationDeg.toFixed(2)}° = 180°+2γ  (γ=${scene.fanAngleDeg.toFixed(2)}°)`;
  ctx.fillText(formula, panelA.x + 12, panelA.y + panelA.height - 37, panelA.width - 24);
  ctx.fillText(
    localizedText(`細線は代表${representativeRows.length}列、○・△は再構成面に最も近い候補点（採用・重みは示さない）`, `Thin rays show ${representativeRows.length} representative rows; circles and triangles mark candidates nearest to the reconstruction plane (no adoption or weight is shown)`),
    panelA.x + 12,
    panelA.y + panelA.height - 21,
    panelA.width - 24,
  );

  // Panel B: every detector-row center for the direct view and both acquired
  // neighbors bracketing the ideal complementary angle.  Row centers are
  // short ticks; only selected reconstruction candidates receive markers.
  const columns = [
    { key: "direct", family: scene.direct, xFraction: 0.22, color: BLUE, label: localizedText("実データ側 β", "Direct β") },
    { key: "complementary-lower", family: scene.complementaryLower, xFraction: 0.54, color: ORANGE, label: localizedText("対向側 下側ビュー", "Complement lower view") },
    { key: "complementary-upper", family: scene.complementaryUpper, xFraction: 0.82, color: ORANGE, label: localizedText("対向側 上側ビュー", "Complement upper view") },
  ];
  const candidateDeltas = columns.flatMap(column => column.family.candidates.map(candidate => candidate.z - scene.z0));
  let deltaMin = Math.min(0, ...candidateDeltas);
  let deltaMax = Math.max(0, ...candidateDeltas);
  const deltaPadding = Math.max(scene.rowWidth * 2, (deltaMax - deltaMin) * 0.06, 0.5);
  deltaMin -= deltaPadding;
  deltaMax += deltaPadding;
  const plot = {
    left: panelB.x + (mobile ? 50 : 48),
    right: panelB.x + panelB.width - 15,
    top: panelB.y + 56,
    bottom: panelB.y + panelB.height - (mobile ? 52 : 65),
  };
  const py = value => plot.bottom - (value - deltaMin) / Math.max(1e-9, deltaMax - deltaMin) * (plot.bottom - plot.top);
  const tickCount = 5;
  ctx.save();
  ctx.font = `${noteSize}px ${FIGURE_FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let index = 0; index < tickCount; index += 1) {
    const value = deltaMin + (deltaMax - deltaMin) * index / (tickCount - 1);
    const y = py(value);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plot.left, y); ctx.lineTo(plot.right, y); ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.fillText(value.toFixed(Math.abs(deltaMax - deltaMin) < 10 ? 1 : 0), plot.left - 6, y);
  }
  const zeroY = py(0);
  ctx.strokeStyle = RED;
  ctx.lineWidth = 1.8;
  ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(plot.left, zeroY); ctx.lineTo(plot.right, zeroY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = RED;
  ctx.textAlign = "left";
  ctx.fillText("z₀", plot.right - 20, zeroY - 9);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(plot.left, plot.top); ctx.lineTo(plot.left, plot.bottom); ctx.lineTo(plot.right, plot.bottom); ctx.stroke();
  ctx.restore();

  for (const column of columns) {
    const x = panelB.x + panelB.width * column.xFraction;
    ctx.save();
    ctx.strokeStyle = column.color;
    ctx.lineWidth = 0.8;
    ctx.globalAlpha = 0.24;
    for (const candidate of column.family.candidates) {
      const y = py(candidate.z - scene.z0);
      ctx.beginPath();
      ctx.moveTo(x - (mobile ? 2 : 2.8), y);
      ctx.lineTo(x + (mobile ? 2 : 2.8), y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = column.color;
    ctx.font = `700 ${noteSize}px ${FIGURE_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const parts = column.label.split(" ");
    if (mobile && parts.length > 2) {
      ctx.fillText(parts.slice(0, Math.ceil(parts.length / 2)).join(" "), x, plot.bottom + 8, panelB.width * 0.27);
      ctx.fillText(parts.slice(Math.ceil(parts.length / 2)).join(" "), x, plot.bottom + 22, panelB.width * 0.27);
    } else {
      ctx.fillText(column.label, x, plot.bottom + 9, panelB.width * 0.28);
    }
  }
  for (const selected of scene.selectedCandidates) {
    const column = columns.find(item => item.key === selected.family);
    if (!column) continue;
    const x = panelB.x + panelB.width * column.xFraction;
    drawGeometryMarker(
      ctx,
      { x, y: py(selected.signedDistanceMm) },
      selected.marker,
      selected.color,
      mobile ? 4.0 : 4.6,
      "#fff",
    );
  }
  ctx.save();
  ctx.translate(panelB.x + 14, (plot.top + plot.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = INK;
  ctx.font = `700 ${labelSize}px ${FIGURE_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("z − z₀ (mm)", 0, 0);
  ctx.restore();

  canvas.dataset.renderState = "ready";
  canvas.dataset.geometryStage = "acquired-row-geometry-with-selected-bracketing-candidates-before-weighting";
  canvas.dataset.geometryBaseStage = "all-acquired-row-center-geometry";
  canvas.dataset.markerStage = "selected-bracketing-candidates-before-weighting";
  canvas.dataset.weightEncoding = "none";
  canvas.dataset.detectorDistanceAssumption = "none-row-centers-mapped-to-evaluation-point";
  canvas.dataset.candidateMarkerScope = "selected-bracketing-endpoints-only";
  canvas.dataset.candidateMarkerShapes = "direct-circle-complementary-triangle";
  canvas.dataset.targetPointMarker = "none";
  canvas.dataset.rowsShownAsRays = String(representativeRows.length);
  canvas.dataset.rowsShownAsCandidates = String(scene.rows);
  canvas.dataset.rowsUsed = String(scene.rows);
  canvas.dataset.availableRowCentersPerView = String(scene.rows);
  canvas.dataset.selectedBranchEndpointCount = String(scene.selectedBranchEndpointCount);
  canvas.dataset.selectedUniqueCandidateCount = String(scene.selectedCandidates.length);
  canvas.dataset.feedMm = String(scene.feed);
  canvas.dataset.state = String(scene.state);
  canvas.dataset.stateDomain = "0-inclusive-1-exclusive-periodic";
  canvas.dataset.referencePlaneMm = String(scene.zReference);
  canvas.dataset.stateOffsetMm = String(scene.state * scene.feed);
  canvas.dataset.targetPlaneMm = String(scene.z0);
  canvas.dataset.periodEndPlaneMm = String(scene.zReference + scene.feed);
  canvas.dataset.zAxisScreenAlignment = "vertical";
  canvas.dataset.zAxisScreenDxPx = String(zAxis.x - origin.x);
  canvas.dataset.zAxisScreenDyPx = String(zAxis.y - origin.y);
  canvas.dataset.directAngleDeg = String(scene.directAngleDisplayDeg);
  canvas.dataset.idealComplementAngleDeg = String(scene.idealComplementAngleDisplayDeg);
  canvas.dataset.fanAngleDeg = String(scene.fanAngleDeg);
  canvas.dataset.sourceRadiusMm = String(scene.sourceRadius);
  canvas.dataset.radialPositionMm = String(scene.radialPosition);
  const summary = document.querySelector("#acquisition-geometry-summary");
  if (summary) summary.textContent = localizedText(
    `現在の条件：N=${scene.rows}列、d=${scene.rowWidth.toFixed(3)} mm、p=${scene.beamPitch.toFixed(3)}、1回転の寝台移動量F=${scene.feed.toFixed(3)} mm。選択中の再構成面z₀=${scene.z0.toFixed(3)} mmは、基準面zrefから${(scene.state * scene.feed).toFixed(3)} mm、すなわちs=${scene.state.toFixed(3)}の位置です。○は実データ側、△は対向データ側で再構成面に最も近い候補点を位置関係の目印として示します。候補点の採用や重みは示しません。`,
    `Current conditions: N=${scene.rows} rows, d=${scene.rowWidth.toFixed(3)} mm, p=${scene.beamPitch.toFixed(3)}, and table feed per rotation F=${scene.feed.toFixed(3)} mm. The selected reconstruction plane z₀=${scene.z0.toFixed(3)} mm lies ${(scene.state * scene.feed).toFixed(3)} mm from the reference plane zref, corresponding to s=${scene.state.toFixed(3)}. Circles and triangles mark the direct- and complementary-side candidates nearest to the reconstruction plane as positional guides. Candidate adoption and weights are not shown.`,
  );
}

function renderInspectionDetails(result) {
  const overviewLimit = Math.max(result.diagramOff.overviewXLimit, result.diagramOn.overviewXLimit);
  const zoomLimit = Math.max(result.diagramOff.zoomXLimit, result.diagramOn.zoomXLimit);
  const overviewScope = document.querySelector("#overview-scope");
  const calculationScope = document.querySelector("#calculation-scope");
  overviewScope.textContent = `自動表示範囲：全列候補軌道のうち、選択端点を含む回転と前後1回転（基準回転との差 ${result.diagramOff.turnOffsetMin}〜${result.diagramOff.turnOffsetMax}、合計${result.diagramOff.turnCount}回転）`;
  const complementary = result.diagramOn.complementaryCandidates;
  const applicationText = result.params.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
    ? "両隣の取得ビューから得た挟み込みをSSPzへ角度線形合成"
    : "2Cは幾何監査のみ（SSPzは実データ側フルスキャン）";
  calculationScope.textContent = `${reconstructionPathLabel(result.params.reconstructionPath)}／各実取得ビューの全${result.params.rows}列を候補母集団として保持（Tによる候補除外なし）／理想対向角を挟む取得ビューも同じ全列規則／${applicationText}／最大角度量子化差 ${fmt(complementary.maximumAngularResidualDeg, 4)}°`;
  drawAcquisitionGeometry3D(document.querySelector("#acquisition-geometry-3d"), result);
  drawDiagram(document.querySelector("#diagram-overview-off"), result.diagramOff, "overview", overviewLimit, zoomLimit);
  drawDiagram(document.querySelector("#diagram-overview-on"), result.diagramOn, "overview", overviewLimit, zoomLimit);
  drawDiagram(document.querySelector("#diagram-zoom-off"), result.diagramOff, "zoom", zoomLimit);
  drawDiagram(document.querySelector("#diagram-zoom-on"), result.diagramOn, "zoom", zoomLimit);
  drawComplementaryAngleChart(document.querySelector("#complementary-angle-chart"), result);
  drawComplementaryDistanceChart(document.querySelector("#complementary-distance-chart"), result);
  drawGeneralTwoPointCandidateChart(document.querySelector("#complementary-general-pair-chart"), result);
  drawProfiles(document.querySelector("#profile-chart"), result);
  renderSummary(result);
  updateProfileModelNote(result);
  updateInputDecorations();
}

function renderAll(result) {
  renderInspectionDetails(result);
  const finalHeading = document.querySelector("#overlay-core-heading");
  const finalDescription = document.querySelector("#overlay-core-description");
  if (finalHeading) finalHeading.textContent = localizedText("フィルタ補間後SSPz・中心形状", "Filter-interpolated SSPz: central shape");
  if (finalDescription) finalDescription.textContent = filterParameterLabel(result.params, result.selectedOn.filterSamples);
  // Core and tail panels have distinct semantic jobs. Each pair shares one
  // symmetric domain between cone-off and cone-on, but a low-amplitude tail is
  // never allowed to compress the linear central-shape view.
  const overlayAxes = configuredOverlayAxes(result);
  drawCandidateAxialSpreadChart(document.querySelector("#candidate-axial-spread-chart"), result);
  drawProfileOverlay(document.querySelector("#overlay-core-off"), result, false, "core", overlayAxes.core);
  drawProfileOverlay(document.querySelector("#overlay-core-on"), result, true, "core", overlayAxes.core);
  drawProfileOverlay(document.querySelector("#overlay-tail-on"), result, true, "tail", overlayAxes.tail);
  const overlayScope = document.querySelector("#overlay-scope");
  if (overlayScope && result.overlay) {
    overlayScope.textContent = localizedText(`1回転寝台移動量内の物体位置を${result.overlay.stateCount}等分／各状態${result.params.viewSamples}ビュー／${filterParameterLabel(result.params, result.selectedOn.filterSamples)}`, `${result.overlay.stateCount} object positions within one table feed / ${result.params.viewSamples} views per state / ${filterParameterLabel(result.params, result.selectedOn.filterSamples)}`);
  }
  drawSweep(document.querySelector("#sweep-chart"), result);
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadBlob(filename, content, type = "text/csv;charset=utf-8") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadSweepCsv() {
  if (!lastResult) return;
  const header = ["model_version","reconstruction_path","profile_mode","filter_width_mm","filter_resampling_count","requested_minimum_filter_resampling_count","reference_slice_thickness_mm","filter_width_calibration","response_coordinate","direct_view_samples_per_rotation","model_state_index","object_position_fraction_within_one_table_feed","object_z_mm","idealized_source_to_point_distance_scaling","local_FW0_bracket_gap_mean_mm","local_FW0_bracket_gap_max_mm","local_FW0_bracket_gap_ratio_max","pre_normalization_area","pre_normalization_peak","filtered_fwhm_mm","filtered_fwtm_mm","filtered_sigma_mm","coverage","profile_area_mm","centroid_mm","half_height_component_count"];
  const rows = lastResult.sweep.map(row => [MODEL_VERSION,row.reconstructionPath ?? lastResult.params.reconstructionPath,lastResult.params.profileMode,lastResult.params.filterWidthMm,lastResult.selectedOn.filterSamples,lastResult.params.filterSamples,lastResult.params.sliceThicknessMm,"not-scanner-calibrated","reconstruction-plane-minus-fixed-object-mm",lastResult.params.viewSamples,row.stateIndex,row.state,row.z0,row.coneOn,row.bracketGapMeanMm,row.bracketGapMaxMm,row.bracketGapRatioMax,row.preNormalizationArea,row.preNormalizationPeak,row.fwhm,row.fwtm,row.sigma,row.coverage,row.area,row.centroid,row.halfComponents]);
  const csv = [header, ...rows].map(row => row.map(csvEscape).join(",")).join("\n");
  downloadBlob(`sspz_${reconstructionPathUrlValue(lastResult.params.reconstructionPath)}_geometry_state_sweep.csv`, `\uFEFF${csv}`);
}

function downloadProfileCsv() {
  if (!lastResult) return;
  const rows = [["model_version","reconstruction_path","profile_mode","filter_width_mm","filter_resampling_count","requested_minimum_filter_resampling_count","reference_slice_thickness_mm","model_state_index","reconstruction_plane_minus_fixed_object_mm","filtered_sspz_distance_change_off","filtered_sspz_distance_change_on"]];
  const length = Math.min(lastResult.selectedOff.z.length, lastResult.selectedOn.z.length);
  for (let i = 0; i < length; i += 1) {
    rows.push([MODEL_VERSION,lastResult.params.reconstructionPath,lastResult.params.profileMode,lastResult.params.filterWidthMm,lastResult.selectedOn.filterSamples,lastResult.params.filterSamples,lastResult.params.sliceThicknessMm,selectedStateIndex,lastResult.selectedOff.z[i],lastResult.selectedOff.profile[i],lastResult.selectedOn.profile[i]]);
  }
  downloadBlob(`sspz_${reconstructionPathUrlValue(lastResult.params.reconstructionPath)}_geometry_state_${selectedStateIndex}_profiles.csv`, `\uFEFF${rows.map(row => row.map(csvEscape).join(",")).join("\n")}`);
}

function downloadComplementaryGeometryCsv() {
  if (!lastResult) return;
  const series = lastResult.diagramOn.complementaryCandidates;
  const header = [
    "model_version",
    "selected_sspz_reconstruction_path",
    "direct_absolute_view_index",
    "direct_angle_deg",
    "complementary_scope",
    "complementary_absolute_view_index",
    "complementary_angle_unwrapped_deg",
    "ideal_complementary_angle_unwrapped_deg",
    "lower_acquired_complementary_absolute_view_index",
    "upper_acquired_complementary_absolute_view_index",
    "ideal_angle_fraction_between_acquired_views",
    "sspz_lower_angular_branch_integrated_gap_mm",
    "sspz_upper_angular_branch_integrated_gap_mm",
    "sspz_angularly_weighted_effective_gap_mm",
    "complementary_angle_minus_ideal_deg",
    "Dn_to_Cn_gap_mm",
    "Dn_to_Cn_lower_z_minus_z0_mm",
    "Dn_to_Cn_upper_z_minus_z0_mm",
    "Dn_to_Cn_lower_coefficient",
    "Dn_to_Cn_upper_coefficient",
    "Dn_to_Cn_lower_row_1_based",
    "Dn_to_Cn_upper_row_1_based",
    "Dn_to_Cn_pair_turn",
    "Dn_to_Cn_lower_absolute_view_index",
    "Dn_to_Cn_upper_absolute_view_index",
    "Cn_to_Dn_plus_1_gap_mm",
    "Cn_to_Dn_plus_1_lower_z_minus_z0_mm",
    "Cn_to_Dn_plus_1_upper_z_minus_z0_mm",
    "Cn_to_Dn_plus_1_lower_coefficient",
    "Cn_to_Dn_plus_1_upper_coefficient",
    "Cn_to_Dn_plus_1_lower_row_1_based",
    "Cn_to_Dn_plus_1_upper_row_1_based",
    "Cn_to_Dn_plus_1_pair_turn",
    "Cn_to_Dn_plus_1_lower_absolute_view_index",
    "Cn_to_Dn_plus_1_upper_absolute_view_index",
    "integrated_lower_z_minus_z0_mm",
    "integrated_upper_z_minus_z0_mm",
    "integrated_gap_mm",
    "integrated_lower_distance_coefficient",
    "integrated_upper_distance_coefficient",
    "integrated_pair_type",
    "integrated_lower_row_1_based",
    "integrated_upper_row_1_based",
    "integrated_lower_turn",
    "integrated_upper_turn",
    "integrated_lower_absolute_view_index",
    "integrated_upper_absolute_view_index",
    "integrated_lower_tie_count",
    "integrated_upper_tie_count",
  ];
  const rows = [header];
  const scopeDefinitions = [
    {
      name: "ideal_continuous",
      cross: series.idealAnglePairs,
      integrated: series.idealIntegratedPairs,
      absoluteIndex: () => "",
      angleDeg: index => series.idealComplementAnglesUnwrappedDeg[index],
      residualDeg: () => 0,
      endpointsHaveAbsoluteViews: false,
    },
    {
      name: "lower_acquired_view",
      cross: series.lowerAngularNeighborPairs,
      integrated: series.lowerAngularNeighborIntegratedPairs,
      absoluteIndex: index => series.lowerComplementAbsoluteViewIndices[index],
      angleDeg: index => series.lowerComplementAbsoluteViewIndices[index] * series.viewStepDeg,
      residualDeg: index => series.lowerAngularResidualsDeg[index],
      endpointsHaveAbsoluteViews: true,
    },
    {
      name: "upper_acquired_view",
      cross: series.upperAngularNeighborPairs,
      integrated: series.upperAngularNeighborIntegratedPairs,
      absoluteIndex: index => series.upperComplementAbsoluteViewIndices[index],
      angleDeg: index => series.upperComplementAbsoluteViewIndices[index] * series.viewStepDeg,
      residualDeg: index => series.upperAngularResidualsDeg[index],
      endpointsHaveAbsoluteViews: true,
    },
    {
      name: "nearest_acquired_view",
      cross: series.nearestViewPairs,
      integrated: series.nearestIntegratedPairs,
      absoluteIndex: index => series.nearestComplementAbsoluteViewIndices[index],
      angleDeg: index => series.nearestComplementAbsoluteViewIndices[index] * series.viewStepDeg,
      residualDeg: index => series.angularResidualsDeg[index],
      endpointsHaveAbsoluteViews: true,
    },
  ];
  const endpointAbsoluteView = (scope, values, index) => (
    scope.endpointsHaveAbsoluteViews ? values[index] : ""
  );
  for (let index = 0; index < series.viewCount; index += 1) {
    const angularFraction = series.angularInterpolationFractions[index];
    const lowerBranchGap = series.lowerAngularNeighborIntegratedPairs.gapMm[index];
    const upperBranchGap = series.upperAngularNeighborIntegratedPairs.gapMm[index];
    const effectiveGap = (1 - angularFraction) * lowerBranchGap + angularFraction * upperBranchGap;
    for (const scope of scopeDefinitions) {
      const cross = scope.cross;
      const integrated = scope.integrated;
      rows.push([
        MODEL_VERSION,
        lastResult.params.reconstructionPath,
        index,
        series.baseAnglesDeg[index],
        scope.name,
        scope.absoluteIndex(index),
        scope.angleDeg(index),
        series.idealComplementAnglesUnwrappedDeg[index],
        series.lowerComplementAbsoluteViewIndices[index],
        series.upperComplementAbsoluteViewIndices[index],
        angularFraction,
        lowerBranchGap,
        upperBranchGap,
        effectiveGap,
        scope.residualDeg(index),
        cross.pairOneGapMm[index],
        cross.pairOneLowerSignedDistanceMm[index],
        cross.pairOneUpperSignedDistanceMm[index],
        cross.pairOneLowerWeights[index],
        cross.pairOneUpperWeights[index],
        cross.pairOneLowerRows[index] + 1,
        cross.pairOneUpperRows[index] + 1,
        cross.pairOneTurns[index],
        endpointAbsoluteView(scope, cross.pairOneLowerAbsoluteViewIndices, index),
        endpointAbsoluteView(scope, cross.pairOneUpperAbsoluteViewIndices, index),
        cross.pairTwoGapMm[index],
        cross.pairTwoLowerSignedDistanceMm[index],
        cross.pairTwoUpperSignedDistanceMm[index],
        cross.pairTwoLowerWeights[index],
        cross.pairTwoUpperWeights[index],
        cross.pairTwoLowerRows[index] + 1,
        cross.pairTwoUpperRows[index] + 1,
        cross.pairTwoTurns[index],
        endpointAbsoluteView(scope, cross.pairTwoLowerAbsoluteViewIndices, index),
        endpointAbsoluteView(scope, cross.pairTwoUpperAbsoluteViewIndices, index),
        integrated.lowerSignedDistanceMm[index],
        integrated.upperSignedDistanceMm[index],
        integrated.gapMm[index],
        integrated.lowerWeights[index],
        integrated.upperWeights[index],
        integrated.typeLabels[integrated.pairTypeCodes[index]],
        integrated.lowerRows[index] + 1,
        integrated.upperRows[index] + 1,
        integrated.lowerTurns[index],
        integrated.upperTurns[index],
        endpointAbsoluteView(scope, integrated.lowerAbsoluteViewIndices, index),
        endpointAbsoluteView(scope, integrated.upperAbsoluteViewIndices, index),
        integrated.lowerTieCounts[index],
        integrated.upperTieCounts[index],
      ]);
    }
  }
  const csv = rows.map(row => row.map(csvEscape).join(",")).join("\n");
  downloadBlob("fan_beam_180li_acquisition_geometry.csv", `\uFEFF${csv}`);
}

function publicationWidthMm(canvasId) {
  return canvasId === "profile-chart"
    || canvasId === "sweep-chart"
    || canvasId === "complementary-general-pair-chart"
    || canvasId === "candidate-axial-spread-chart"
    ? PUBLICATION_WIDTH_MM.full
    : PUBLICATION_WIDTH_MM.panel;
}

function publicationPixelWidth(canvasId) {
  return Math.round(publicationWidthMm(canvasId) / 25.4 * PUBLICATION_DPI);
}

function renderCanvasById(canvasId, canvas, result) {
  if (canvasId.startsWith("diagram-")) {
    const overviewLimit = Math.max(result.diagramOff.overviewXLimit, result.diagramOn.overviewXLimit);
    const zoomLimit = Math.max(result.diagramOff.zoomXLimit, result.diagramOn.zoomXLimit);
    const coneOn = canvasId.endsWith("-on");
    const diagram = coneOn ? result.diagramOn : result.diagramOff;
    const mode = canvasId.includes("-overview-") ? "overview" : "zoom";
    drawDiagram(canvas, diagram, mode, mode === "overview" ? overviewLimit : zoomLimit, mode === "overview" ? zoomLimit : null);
    return;
  }
  if (canvasId.startsWith("overlay-")) {
    const [, viewMode, condition] = canvasId.split("-");
    drawProfileOverlay(canvas, result, condition === "on", viewMode, configuredOverlayAxes(result)[viewMode]);
    return;
  }
  if (canvasId === "candidate-axial-spread-chart") {
    drawCandidateAxialSpreadChart(canvas, result);
    return;
  }
  if (canvasId === "complementary-angle-chart") {
    drawComplementaryAngleChart(canvas, result);
    return;
  }
  if (canvasId === "complementary-distance-chart") {
    drawComplementaryDistanceChart(canvas, result);
    return;
  }
  if (canvasId === "complementary-general-pair-chart") {
    drawGeneralTwoPointCandidateChart(canvas, result);
    return;
  }
  if (canvasId === "profile-chart") {
    drawProfiles(canvas, result);
    return;
  }
  if (canvasId === "sweep-chart") {
    drawSweep(canvas, result);
    return;
  }
  throw new Error(`未対応の図IDです: ${canvasId}`);
}

function writeUint32BigEndian(bytes, offset, value) {
  const normalized = Number(value) >>> 0;
  bytes[offset] = (normalized >>> 24) & 255;
  bytes[offset + 1] = (normalized >>> 16) & 255;
  bytes[offset + 2] = (normalized >>> 8) & 255;
  bytes[offset + 3] = normalized & 255;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function pngWithResolution(blob, dpi) {
  const source = new Uint8Array(await blob.arrayBuffer());
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (source.length < 33 || !pngSignature.every((value, index) => source[index] === value)) return blob;
  const type = String.fromCharCode(...source.slice(12, 16));
  if (type !== "IHDR") return blob;

  const pixelsPerMeter = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  writeUint32BigEndian(chunk, 0, 9);
  chunk.set([112, 72, 89, 115], 4); // pHYs
  writeUint32BigEndian(chunk, 8, pixelsPerMeter);
  writeUint32BigEndian(chunk, 12, pixelsPerMeter);
  chunk[16] = 1; // unit is metre
  writeUint32BigEndian(chunk, 17, crc32(chunk.slice(4, 17)));

  // The Canvas PNG has IHDR as its first chunk.  Insert pHYs immediately after
  // IHDR so downstream software reads the intended 600-dpi physical size.
  return new Blob([source.slice(0, 33), chunk, source.slice(33)], { type: "image/png" });
}

function publicationFilename(canvasId) {
  let filename = `${canvasId}.png`;
  if (canvasId === "sweep-chart" && lastResult) {
    const metric = selectedMetric(lastResult);
    const thickness = String(Number(lastResult.params.sliceThicknessMm)).replace(".", "p");
    const radius = String(Number(lastResult.params.radius)).replace(".", "p");
    filename = `sweep-taguchi-${metric.rawKey}-FW${lastResult.params.filterWidthMm}mm-K${lastResult.selectedOn.filterSamples}-T${thickness}mm-r${radius}mm.png`;
  } else if (canvasId.startsWith("overlay-") && lastResult) {
    const [, viewMode, condition] = canvasId.split("-");
    const thickness = String(Number(lastResult.params.sliceThicknessMm)).replace(".", "p");
    const radius = String(Number(lastResult.params.radius)).replace(".", "p");
    filename = `sspz-overlay-taguchi-${viewMode}-FW${lastResult.params.filterWidthMm}mm-K${lastResult.selectedOn.filterSamples}-T${thickness}mm-r${radius}mm-${condition}-360-object-states.png`;
  } else if (canvasId === "candidate-axial-spread-chart" && lastResult) {
    const rows = String(Number(lastResult.params.rows));
    const rowWidth = String(Number(lastResult.params.rowWidth)).replace(".", "p");
    const pitch = String(Number(lastResult.params.beamPitch)).replace(".", "p");
    const radius = String(Number(lastResult.params.radius)).replace(".", "p");
    filename = `geometry-all-candidate-axial-spread-N${rows}-d${rowWidth}mm-p${pitch}-r${radius}mm-${lastResult.params.viewSamples}views.png`;
  } else if (canvasId === "profile-chart" && lastResult) {
    filename = `sspz-taguchi-FW${lastResult.params.filterWidthMm}mm-K${lastResult.selectedOn.filterSamples}-T${lastResult.params.sliceThicknessMm}mm-state-${selectedStateIndex}-of-360.png`;
  } else if (canvasId.startsWith("complementary-") && lastResult) {
    const radius = String(Number(lastResult.params.radius)).replace(".", "p");
    filename = `${canvasId}-r${radius}mm-${lastResult.params.viewSamples}views.png`;
  } else if (canvasId.startsWith("diagram-") && lastResult) {
    filename = `${canvasId}-state-${selectedStateIndex}-of-360.png`;
  }
  const widthMm = publicationWidthMm(canvasId);
  return filename.replace(/\.png$/i, `-${widthMm}mm-${PUBLICATION_DPI}dpi.png`);
}

async function downloadCanvas(canvasId) {
  if (!lastResult) return;
  const source = document.getElementById(canvasId);
  const pixelWidth = publicationPixelWidth(canvasId);
  const renderScale = pixelWidth / source.width;
  const target = document.createElement("canvas");
  target.width = pixelWidth;
  target.height = Math.round(source.height * renderScale);
  target.dataset.renderScale = String(renderScale);
  target.dataset.publicationMode = "true";
  renderCanvasById(canvasId, target, lastResult);
  const rawBlob = await new Promise((resolve, reject) => {
    target.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNGの生成に失敗しました。")), "image/png");
  });
  const publicationBlob = await pngWithResolution(rawBlob, PUBLICATION_DPI);
  downloadBlob(publicationFilename(canvasId), publicationBlob, "image/png");
  status.textContent = `${publicationWidthMm(canvasId)} mm幅・${PUBLICATION_DPI} dpiの投稿用PNGを保存しました（${target.width}×${target.height} px）`;
}

runButton.addEventListener("click", runSimulation);
cancelButton.addEventListener("click", () => worker?.postMessage({ type: "cancel" }));
resetButton.addEventListener("click", () => {
  selectedStateIndex = 0;
  writeParams(DEFAULT_PARAMS);
  if (metricSelect) metricSelect.value = "fwhm";
  try { localStorage.removeItem("sspz-unwrapped-params"); } catch { /* storage may be disabled */ }
  try { history.replaceState(null, "", window.location.pathname); } catch { /* file:// may restrict history mutation */ }
  syncLanguageLinks("");
});
copyLinkButton.addEventListener("click", async () => {
  const url = paramsToUrl(readParams()).toString();
  try { await navigator.clipboard.writeText(url); status.textContent = "条件URLをコピーしました"; }
  catch { window.prompt("このURLをコピーしてください", url); }
});
form.addEventListener("input", () => {
  updateInputDecorations();
  if (!runButton.disabled) status.textContent = "条件が変更されました。計算するを押してください。";
});
inspectState?.addEventListener("input", () => requestStateInspection(Number(inspectState.value)));
inspectPrev?.addEventListener("click", () => requestStateInspection(selectedStateIndex - 1, true));
inspectNext?.addEventListener("click", () => requestStateInspection(selectedStateIndex + 1, true));
function updateSweepDisplay() {
  if (lastResult) drawSweep(document.querySelector("#sweep-chart"), lastResult);
  const url = paramsToUrl(readParams());
  try { history.replaceState(null, "", url); } catch { /* file:// may restrict history mutation */ }
  syncLanguageLinks(url.search);
}
metricSelect.addEventListener("change", updateSweepDisplay);
document.querySelectorAll("[data-radius]").forEach(button => button.addEventListener("click", () => {
  form.elements.namedItem("radius").value = button.dataset.radius;
  updateInputDecorations();
  status.textContent = "横断面内位置を変更しました。計算するを押してください。";
}));
document.querySelectorAll("[data-canvas]").forEach(button => button.addEventListener("click", () => downloadCanvas(button.dataset.canvas)));
downloadCsvButton.addEventListener("click", downloadSweepCsv);
downloadProfileButton.addEventListener("click", downloadProfileCsv);
downloadComplementaryGeometryButton?.addEventListener("click", downloadComplementaryGeometryCsv);
let acquisitionGeometryResizeFrame = 0;
window.addEventListener("resize", () => {
  if (!lastResult) return;
  cancelAnimationFrame(acquisitionGeometryResizeFrame);
  acquisitionGeometryResizeFrame = requestAnimationFrame(() => {
    drawAcquisitionGeometry3D(document.querySelector("#acquisition-geometry-3d"), lastResult);
  });
});

const initial = paramsFromUrl() ?? (() => {
  try {
    const stored = JSON.parse(localStorage.getItem("sspz-unwrapped-params")) || DEFAULT_PARAMS;
    if (stored.thetaSamples != null && stored.viewSamples == null) {
      legacyInputMigrated = true;
      stored.viewSamples = stored.thetaSamples;
    }
    if (stored.targetFwhm != null && stored.sliceThicknessMm == null) {
      legacyInputMigrated = true;
      stored.sliceThicknessMm = stored.targetFwhm;
    }
    if (stored.filterWidthMm == null || stored.profileMode !== "taguchi-filter") {
      legacyInputMigrated = true;
      stored.filterWidthMm ??= stored.sliceThicknessMm ?? DEFAULT_PARAMS.sliceThicknessMm;
      stored.filterSamples ??= DEFAULT_PARAMS.filterSamples;
      stored.profileMode = "taguchi-filter";
    }
    return stored;
  }
  catch { return DEFAULT_PARAMS; }
})();
writeParams({ ...DEFAULT_PARAMS, ...initial });
if (legacyUrlNote) {
  legacyUrlNote.hidden = !legacyInputMigrated;
  if (legacyInputMigrated) legacyUrlNote.textContent = localizedText("旧URL・保存条件をTaguchiらのフィルタ補間へ移行しました。FWが未指定の場合だけ初期値をTと同じ数値に置いていますが、これは実機に校正した対応ではありません。FWを独立に設定してください。旧版の計算値を流用せず、応答の定義も固定物体に対する再構成面移動へ変更して再計算します。", "Legacy URL or saved settings were migrated to Taguchi-style filter interpolation. Only when FW was unspecified, its initial numerical value was set equal to T; this is not a scanner-calibrated correspondence. Set FW independently. Old results are not reused; the response is recalculated for a reconstruction plane moving past a fixed object.");
}
runSimulation();
