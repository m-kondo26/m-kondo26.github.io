// Execute the real profile painters with a recording Canvas. A flat 100%
// response must remain above the grid, including the logarithmic tail panel.
// This is a drawing-order regression, not a numerical SSPz/model validation.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function functionSource(name) {
  const match = new RegExp(`^function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Application function ${name} must exist`);
  const next = /^function /gm;
  next.lastIndex = match.index + match[0].length;
  const following = next.exec(source);
  return source.slice(match.index, following ? following.index : source.length).trim();
}

const functionNames = ["axisContext", "setFittedFigureFont", "drawAxes", "drawPolyline",
  "decimalPlacesForStep", "drawProfileEncodingLegend", "strokeNativeProfile", "setProfileDisplayMetadata", "drawProfiles", "drawOverlayLegend",
  "drawProfileOverlay", "filterParameterLabel"];
const constantNames = ["BLUE", "ORANGE", "INK", "MUTED", "GRID", "FIGURE_FONT", "PROFILE_TAIL_DISPLAY_BOUNDS", "PROFILE_DISPLAY_VERSION"];
const constants = constantNames.map(name => {
  const match = new RegExp(`^const ${name} = .+;$`, "m").exec(source);
  assert.ok(match, `Application constant ${name} must exist`);
  return match[0];
}).join("\n");

// Put the actual drawAxes call back after data painting. Only a memory-local
// negative control is changed; application files are never rewritten here.
function restoreOldOrder(text, name) {
  const call = /^  drawAxes\([^\r\n]+\);\r?$/m.exec(text);
  assert.ok(call, `${name}: one movable drawAxes invocation`);
  assert.equal((text.match(/^  drawAxes\(/gm) || []).length, 1);
  const withoutCall = text.slice(0, call.index) + text.slice(call.index + call[0].length);
  const marker = name === "drawProfiles" ? "  drawProfileEncodingLegend(" : "  plot.ctx.fillStyle = INK;";
  const insertion = withoutCall.indexOf(marker);
  assert.ok(insertion > 0, `${name}: legend/title after data exists`);
  return withoutCall.slice(0, insertion) + call[0] + "\n" + withoutCall.slice(insertion);
}

class RecordingContext {
  constructor() {
    this.events = [];
    this.stack = [];
    this.currentPath = [];
    this.state = { strokeStyle: "#000000", fillStyle: "#000000", lineWidth: 1,
      globalAlpha: 1, clipped: false, font: "10px sans-serif", dash: [] };
  }
  save() { this.stack.push({ ...this.state, dash: [...this.state.dash] }); }
  restore() { assert.ok(this.stack.length, "Canvas save/restore balance"); this.state = this.stack.pop(); }
  setTransform() {}
  translate() {}
  rotate() {}
  clearRect() {}
  fillRect() {}
  fillText() {}
  measureText(text) { return { width: String(text).length * 8 }; }
  setLineDash(dash) { this.state.dash = [...dash]; }
  beginPath() { this.currentPath = []; }
  moveTo(x, y) { this.currentPath.push({ op: "M", x, y }); }
  lineTo(x, y) { this.currentPath.push({ op: "L", x, y }); }
  quadraticCurveTo(cx, cy, x, y) { this.currentPath.push({ op: "Q", cx, cy, x, y }); }
  bezierCurveTo(cx1, cy1, cx2, cy2, x, y) { this.currentPath.push({ op: "C", cx1, cy1, cx2, cy2, x, y }); }
  rect(x, y, width, height) { this.currentPath.push({ op: "R", x, y, width, height }); }
  clip() { this.state.clipped = true; }
  stroke() {
    this.events.push({ index: this.events.length, ...this.state,
      dash: [...this.state.dash], path: this.currentPath.map(point => ({ ...point })) });
  }
  strokeRect(x, y, width, height) {
    const saved = this.currentPath;
    this.beginPath();
    this.moveTo(x, y); this.lineTo(x + width, y); this.lineTo(x + width, y + height);
    this.lineTo(x, y + height); this.lineTo(x, y);
    this.stroke();
    this.currentPath = saved;
  }
}
for (const property of ["strokeStyle", "fillStyle", "lineWidth", "globalAlpha", "font", "textAlign", "textBaseline"]) {
  Object.defineProperty(RecordingContext.prototype, property, {
    get() { return this.state[property]; },
    set(value) { this.state[property] = value; },
  });
}

function createRuntime(oldOrder, nativeMutation = null) {
  const context = vm.createContext({
    console, profileAxisNote: null,
    localizedText: ja => ja,
    fmt: (value, digits) => Number(value).toFixed(digits),
    selectedProfileAxis: () => ({ xMin: -3, xMax: 3, tickStep: 1, ticks: [-3, -2, -1, 0, 1, 2, 3] }),
  });
  const functions = functionNames.map(name => {
    let text = functionSource(name);
    if (name === "strokeNativeProfile" && nativeMutation === "drop-points") {
      text = text.replace("index += 1", "index += 2");
    }
    if (name === "strokeNativeProfile" && nativeMutation === "curved-path") {
      text = text.replace("ctx.lineTo(px, py)", "ctx.quadraticCurveTo(px, py, px, py)");
    }
    return oldOrder && ["drawProfiles", "drawProfileOverlay"].includes(name) ? restoreOldOrder(text, name) : text;
  }).join("\n\n");
  vm.runInContext(`${constants}\n${functions}\n`
    + "globalThis.testColors={BLUE,ORANGE,GRID,INK};\n"
    + "globalThis.testTailBounds=PROFILE_TAIL_DISPLAY_BOUNDS;", context);
  return context;
}

function segments(event) {
  const result = [];
  let previous = null;
  for (const point of event.path) {
    if (point.op === "L" && previous) result.push([previous, point]);
    previous = ["M", "L"].includes(point.op) ? point : null;
  }
  return result;
}

function paintsPoint(event, x, y) {
  if (!(event.globalAlpha > 0)) return false;
  return segments(event).some(([a, b]) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const fraction = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - a.x - fraction * dx, y - a.y - fraction * dy) <= event.lineWidth / 2 + 1e-8;
  });
}

const stateCount = 360;
const z = [-2, -1, 0, 1, 2];
const flat = z.map(() => 1);
function condition() {
  return { final: new Float64Array(stateCount * z.length).fill(1),
    finalSummary: { maximum: new Float64Array(z.length).fill(1) },
    coverage: new Float64Array(stateCount).fill(1) };
}
const fixture = {
  params: { rowWidth: 1, sliceThicknessMm: 5, filterWidthMm: 5, filterSamples: 129 },
  selectedOff: { z, profile: flat, filterSamples: 129 },
  selectedOn: { z, profile: flat, filterSamples: 129 },
  overlay: { z, zCount: z.length, stateCount, off: condition(), on: condition() },
};

function checkDrawing(runtime, spec) {
  const ctx = new RecordingContext();
  const canvas = { width: spec.publication ? 1890 : 900, height: spec.publication ? 1365 : 650,
    dataset: { publicationMode: String(spec.publication), renderScale: spec.publication ? "2.1" : "1" },
    getContext: type => { assert.equal(type, "2d"); return ctx; },
    setAttribute() {},
  };
  const xAxis = { xMin: -3, xMax: 3, step: 1, ticks: [-3, -2, -1, 0, 1, 2, 3], formatter: String };
  if (spec.kind === "selected") runtime.drawProfiles(canvas, fixture);
  else runtime.drawProfileOverlay(canvas, fixture, spec.coneOn, spec.kind, xAxis);
  assert.equal(ctx.stack.length, 0, "Painter must restore Canvas state");

  const colors = runtime.testColors;
  const profileStrokes = ctx.events.filter(event => event.clipped && [colors.BLUE, colors.ORANGE].includes(event.strokeStyle));
  assert.equal(profileStrokes.length, spec.kind === "selected" ? 2 : stateCount,
    "All flat profile paths must actually be painted, not substituted by a summary");
  assert.ok(profileStrokes.every(event => segments(event).length === z.length - 1));
  assert.ok(profileStrokes.every(event => segments(event).every(([a, b]) => Math.abs(a.y - b.y) < 1e-9)),
    "Fixture must produce real horizontal 100% plateaus");

  const first = profileStrokes[0];
  const firstSegments = segments(first);
  // An interior point avoids frame/axis endpoints and all integer x ticks.
  const sampleX = firstSegments[2][0].x * 0.63 + firstSegments[2][1].x * 0.37;
  const sampleY = firstSegments[2][0].y;
  const gridAtPlateau = ctx.events.filter(event => event.strokeStyle === colors.GRID && paintsPoint(event, sampleX, sampleY));
  assert.ok(gridAtPlateau.length > 0, "The 100% gridline must coincide with the plateau; test may not omit the collision");
  assert.ok(gridAtPlateau.every(event => event.index < first.index),
    "100% gridline must be painted before every SSPz plateau, not cover it afterward");
  const axes = ctx.events.filter(event => [colors.GRID, colors.INK].includes(event.strokeStyle));
  assert.ok(axes.length > 0);
  assert.ok(axes.every(event => event.index < first.index), "Grid/frame/axes must not be stroked over already drawn SSPz data");
  const touching = ctx.events.filter(event => paintsPoint(event, sampleX, sampleY));
  const finalPainter = touching.at(-1);
  assert.ok(profileStrokes.includes(finalPainter), "The final painter at 100% must be a data curve, not gray grid or black axes");
  return { kind: spec.kind, coneOn: spec.coneOn ?? null, publication: spec.publication,
    profilePathCount: profileStrokes.length, coincidentGridCount: gridAtPlateau.length,
    finalPlateauStroke: finalPainter.strokeStyle };
}

const specs = [false, true].flatMap(publication => [
  { kind: "selected", publication },
  { kind: "core", coneOn: false, publication },
  { kind: "core", coneOn: true, publication },
  { kind: "tail", coneOn: true, publication },
]);
const currentRuntime = createRuntime(false);
const results = specs.map(spec => checkDrawing(currentRuntime, spec));

// More than 1000 nonuniform samples expose within-profile decimation. A peak
// one sample wide and different per-state shoulders also expose smoothing,
// assumed-uniform coordinates, and loss of the packed-array state offset.
const nativeZ = Array.from({ length: 1103 }, (_, index) => -2.4 + 4.8 * (index / 1102) ** 1.07);
function nativeValues(state = 0) {
  return nativeZ.map((_, index) => index === 501 ? 1
    : index === 500 ? 0.001
    : [0, 503, 1102].includes(index) ? 0.0004
      : 0.008 + (index % 19) * 0.003 + state * 0.00001);
}
function nativeCondition() {
  const values = new Float64Array(stateCount * nativeZ.length);
  for (let state = 0; state < stateCount; state += 1) values.set(nativeValues(state), state * nativeZ.length);
  return { final: values, finalSummary: { maximum: nativeValues(359) }, coverage: new Float64Array(stateCount).fill(1) };
}
const nativeFixture = {
  params: fixture.params,
  selectedOff: { z: nativeZ, profile: nativeValues(0), filterSamples: 129 },
  selectedOn: { z: nativeZ.map(value => value + 0.003), profile: nativeValues(17), filterSamples: 129 },
  overlay: { z: nativeZ, zCount: nativeZ.length, stateCount, off: nativeCondition(), on: nativeCondition() },
};

function checkNativeDrawing(runtime, spec) {
  const ctx = new RecordingContext();
  const canvas = { width: spec.publication ? 1890 : 900, height: spec.publication ? 1365 : 650,
    dataset: { publicationMode: String(spec.publication), renderScale: spec.publication ? "2.1" : "1" },
    getContext: () => ctx, setAttribute() {} };
  const xAxis = { xMin: -3, xMax: 3, step: 1, ticks: [-3, -2, -1, 0, 1, 2, 3], formatter: String };
  if (spec.kind === "selected") runtime.drawProfiles(canvas, nativeFixture);
  else runtime.drawProfileOverlay(canvas, nativeFixture, spec.coneOn, spec.kind, xAxis);
  const tail = spec.kind === "tail";
  const plot = runtime.axisContext({ ...canvas, getContext: () => new RecordingContext() },
    { xMin: -3, xMax: 3, yMin: tail ? runtime.testTailBounds.yMin : 0,
      yMax: tail ? runtime.testTailBounds.yMax : 1.04 },
    { topMargin: spec.publication ? (spec.kind === "selected" ? 96 : 116) : 126,
      leftMargin: tail ? 158 : undefined });
  const curves = ctx.events.filter(event => event.clipped
    && [runtime.testColors.BLUE, runtime.testColors.ORANGE].includes(event.strokeStyle));
  assert.equal(curves.length, spec.kind === "selected" ? 2 : stateCount, "Every state must retain its own native path");
  let checkedPoints = 0;
  for (const [state, curve] of curves.entries()) {
    const zs = spec.kind === "selected" && state === 1 ? nativeFixture.selectedOn.z : nativeZ;
    const values = nativeValues(spec.kind === "selected" && state === 1 ? 17 : state);
    const expected = [];
    let active = false;
    for (let index = 0; index < zs.length; index += 1) {
      if (tail && values[index] < 0.001) { active = false; continue; }
      expected.push({ op: active ? "L" : "M", x: plot.x(zs[index]),
        y: plot.y(tail ? Math.log10(values[index]) : values[index]) });
      active = true;
    }
    assert.equal(curve.path.length, expected.length, "Native samples must not be dropped or resampled");
    for (let index = 0; index < expected.length; index += 1) {
      assert.equal(curve.path[index].op, expected[index].op, "Native samples require straight segments and unbridged tail gaps");
      assert.ok(Math.abs(curve.path[index].x - expected[index].x) < 1e-10
        && Math.abs(curve.path[index].y - expected[index].y) < 1e-10,
      `Native coordinate/value changed at state ${state}, path point ${index}`);
    }
    checkedPoints += expected.length;
  }
  assert.equal(canvas.dataset.profileDisplayVersion, "2026-09-08.1");
  assert.equal(canvas.dataset.profileInterpolation, "native-samples-piecewise-linear");
  for (const field of ["profileSpline", "profileSmoothing", "profileDecimation"]) assert.equal(canvas.dataset[field], "none");
  assert.equal(canvas.dataset.profileDisplayGrid, "original-calculated-z-values");
  assert.equal(ctx.stack.length, 0);
  return { ...spec, nativePointCount: nativeZ.length, pathCount: curves.length, checkedPoints };
}
const nativeResults = specs.map(spec => checkNativeDrawing(currentRuntime, spec));
for (const mutation of ["drop-points", "curved-path"]) {
  const badRuntime = createRuntime(false, mutation);
  for (const spec of specs) {
    assert.throws(() => checkNativeDrawing(badRuntime, spec),
      /Native samples must not be dropped|Native samples require straight segments/,
      `${mutation} must fail for selected, core, and tail paths in screen/publication modes`);
  }
}
const oldRuntime = createRuntime(true);
for (const spec of specs) {
  assert.throws(() => checkDrawing(oldRuntime, spec), /100% gridline must be painted before every SSPz plateau/,
    "Restoring the old data-then-axes order must reproduce the hidden-plateau failure");
}
console.log(JSON.stringify({ status: "PASS", executedDrawingCases: results.length,
  oldOrderNegativeControlsRejected: specs.length,
  nativeCoordinateDrawingCases: nativeResults.length,
  nativeCoordinateNegativeControlsRejected: specs.length * 2,
  scope: "Real application profile painters with recording Canvas; no numerical model changes or pixel-antialiasing claim.",
  results, nativeResults }, null, 2));
