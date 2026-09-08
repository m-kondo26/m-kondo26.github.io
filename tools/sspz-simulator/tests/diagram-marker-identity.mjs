// Presentation-only regression: combine angular-branch contributions only
// when they refer to the same physical acquired sample at the same reference
// view. Coincident coordinates are not a physical-identity criterion.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DEFAULT_PARAMS, computeUnwrapped, validateParams } from "../sim-core.js";

const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
function functionSource(name) {
  const match = new RegExp(`^function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Application function ${name} must exist`);
  const next = /^function /gm;
  next.lastIndex = match.index + match[0].length;
  const following = next.exec(source);
  return source.slice(match.index, following ? following.index : source.length).trim();
}
const context = vm.createContext({ console });
vm.runInContext(functionSource("mergeDiagramMarkers"), context);
const merge = points => context.mergeDiagramMarkers(points);
const identity = point => `${point.referenceViewIndex}:${point.absoluteViewIndex}:${point.row}`;
const plain = value => JSON.parse(JSON.stringify(value));
const close = (actual, expected, tolerance, label) => {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: actual=${actual}; expected=${expected}`);
};

function independentGroups(points) {
  const groups = new Map();
  for (const point of points) {
    const key = identity(point);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(point);
  }
  return groups;
}

function verifyMerge(points, label) {
  const before = JSON.stringify(points);
  const expected = independentGroups(points);
  const merged = merge(points);
  assert.equal(JSON.stringify(points), before, `${label}: raw candidates must remain unchanged`);
  assert.equal(merged.length, expected.size, `${label}: physical marker count`);
  const observed = new Map(merged.map(point => [identity(point), point]));
  assert.equal(observed.size, merged.length, `${label}: duplicate output identity`);
  for (const [key, members] of expected) {
    const marker = observed.get(key);
    assert.ok(marker, `${label}: missing physical marker ${key}`);
    assert.equal(marker.contributionCount, members.length, `${label}: contribution count ${key}`);
    assert.equal(marker.contributions.length, members.length);
    close(marker.weight, members.reduce((sum, point) => sum + point.weight, 0), 1e-12, `${label}: summed weight ${key}`);
    close(marker.x, members[0].x, 1e-9, `${label}: x position ${key}`);
    close(marker.y, members[0].y, 1e-9, `${label}: y position ${key}`);
    assert.equal(marker.row, members[0].row);
    assert.equal(marker.traceFamilyId, members[0].traceFamilyId);
    assert.deepEqual(Array.from(marker.traceFamilyIds).sort(), [...new Set(members.map(point => point.traceFamilyId))].sort());
    assert.deepEqual(Array.from(marker.dataKinds).sort(), [...new Set(members.map(point => point.dataKind))].sort());
    const copies = Array.from(marker.contributions, plain).sort((a, b) => a.weight - b.weight);
    assert.deepEqual(copies, members.map(plain).sort((a, b) => a.weight - b.weight), `${label}: all original contribution fields retained`);
    for (const contribution of marker.contributions) {
      assert.ok(!members.includes(contribution), `${label}: contributions must be copies, not original mutable references`);
    }
    assert.ok(!members.includes(marker), `${label}: output must not alias input`);
  }
  close(merged.reduce((sum, point) => sum + point.weight, 0),
    points.reduce((sum, point) => sum + point.weight, 0), 1e-10, `${label}: total contribution weight retained`);
  const viewWeights = new Map();
  for (const point of merged) viewWeights.set(point.referenceViewIndex,
    (viewWeights.get(point.referenceViewIndex) || 0) + point.weight);
  for (const [view, sum] of viewWeights) close(sum, 1, 1e-10, `${label}: normalized view ${view}`);
  return { merged, duplicateGroups: [...expected.values()].filter(members => members.length > 1).length };
}

const userParams = validateParams({ ...DEFAULT_PARAMS, rows: 4, rowWidth: 1, beamPitch: 0.875,
  sourceRadius: 600, radius: 102, phase: 0, state: 0, zReference: 0,
  sliceThicknessMm: 5, filterWidthMm: 5, filterSamples: 129,
  viewSamples: 720, zSamples: 4000, reconstructionPath: "fan-beam-180li" });
const userDiagram = computeUnwrapped(userParams, { state: 0, coneOn: true, samples: 720 });
const userRawBefore = JSON.stringify(userDiagram);
const userCheck = verifyMerge(userDiagram.weightedPoints, "user-4-row-state0");
assert.equal(userDiagram.weightedPoints.length, 284);
assert.equal(userCheck.merged.length, 214);
assert.equal(userCheck.duplicateGroups, 70);
const beta160 = userCheck.merged.find(point => point.referenceViewIndex === 320
  && point.absoluteViewIndex === 320 && point.row === 0);
assert.ok(beta160);
close(beta160.weight, 0.600102534235464, 1e-13, "160-degree actual acquired-point coefficient");
assert.equal(beta160.contributionCount, 2);
assert.ok(beta160.weight > Math.max(...beta160.contributions.map(point => point.weight)),
  "The marker must represent the sum, not the last/largest opaque contribution");

const fixtureResults = [];
for (const detector of [
  { rows: 4, rowWidth: 1, radius: 0, viewSamples: 720 },
  { rows: 4, rowWidth: 1, radius: 102, viewSamples: 720 },
  { rows: 160, rowWidth: 0.5, radius: 250, viewSamples: 1200 },
]) {
  for (const state of [0, 0.137, 0.5, 0.999]) {
    for (const coneOn of [false, true]) {
      const p = validateParams({ ...userParams, ...detector, state });
      const diagram = computeUnwrapped(p, { state, coneOn, samples: 720 });
      const checked = verifyMerge(diagram.weightedPoints, `${p.rows}-rows/r${p.radius}/s${state}/cone${coneOn}`);
      fixtureResults.push({ rows: p.rows, radius: p.radius, state, coneOn,
        rawCount: diagram.weightedPoints.length, markerCount: checked.merged.length, duplicateGroups: checked.duplicateGroups });
    }
  }
}

assert.equal(merge([]).length, 0, "empty candidates");
const original = userDiagram.weightedPoints[0];
const frozen = Object.freeze(userDiagram.weightedPoints.map(point => Object.freeze({ ...point })));
verifyMerge(frozen, "frozen-candidates");
const distinctCoincident = [
  { ...original, weight: 0.1 },
  { ...original, weight: 0.2, absoluteViewIndex: original.absoluteViewIndex + 720 },
  { ...original, weight: 0.3, row: original.row + 1 },
  { ...original, weight: 0.4, referenceViewIndex: original.referenceViewIndex + 1 },
];
assert.equal(merge(distinctCoincident).length, 4,
  "Same xy with different acquisition, row, or reference view must remain four distinct points");
for (const coordinate of ["x", "y"]) {
  assert.throws(() => merge([{ ...original }, { ...original, [coordinate]: original[coordinate] + 0.1 }]),
    undefined, `Contradictory ${coordinate} for the same physical key must fail explicitly`);
}
const complementary = userDiagram.weightedPoints.find(point => point.traceFamilyId.startsWith("complementary-"));
assert.ok(complementary);
assert.equal(merge([{ ...complementary, traceFamilyId: "complementary-lower" },
  { ...complementary, traceFamilyId: "complementary-upper" }]).length, 1,
"Two complementary angular branches may name the same physical acquired sample");
const dualRolePoints = [{ ...original, weight: 0.4, dataKind: "direct", traceFamilyId: "direct" },
  { ...original, weight: 0.6, dataKind: "complementary", traceFamilyId: "complementary-lower" }];
const dualRoleMarker = verifyMerge(dualRolePoints, "same-acquired-sample-in-both-angular-roles").merged[0];
assert.equal(dualRoleMarker.weight, 1);
assert.equal(dualRoleMarker.traceFamilyIds.length, 2,
  "Physical identity overrides different angular roles; all role metadata must survive");
for (const badPoint of [{ ...original, referenceViewIndex: 0.5 },
  { ...original, absoluteViewIndex: NaN }, { ...original, row: NaN },
  { ...original, x: Infinity }, { ...original, y: NaN },
  { ...original, weight: -0.1 }, { ...original, weight: NaN }]) {
  assert.throws(() => merge([badPoint]), undefined, "Invalid physical identity or coefficient must fail explicitly");
}
assert.equal(JSON.stringify(userDiagram), userRawBefore, "The raw diagram is not rewritten by display aggregation");

// Execute the actual marker painter and drawDiagram. Only axes, trajectories,
// and explanatory labels are stubbed here so every recorded fill is a data
// glyph, not a legend example. Colors are independently calculated below.
class RecordingCanvasContext {
  constructor() {
    this.events = [];
    this.stack = [];
    this.path = [];
    this.state = { strokeStyle: "#000000", fillStyle: "#000000", globalAlpha: 1,
      globalCompositeOperation: "source-over", lineWidth: 1, dash: [], clipped: false };
  }
  save() { this.stack.push({ ...this.state, dash: [...this.state.dash] }); }
  restore() {
    assert.ok(this.stack.length, "Balanced canvas save/restore");
    this.state = this.stack.pop();
  }
  beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push({ op: "M", x, y }); }
  lineTo(x, y) { this.path.push({ op: "L", x, y }); }
  arc(x, y, radius, start, end) { this.path.push({ op: "A", x, y, radius, start, end }); }
  closePath() { this.path.push({ op: "Z" }); }
  rect(x, y, width, height) { this.path.push({ op: "R", x, y, width, height }); }
  clip() { this.state.clipped = true; }
  fillRect() {}
  setLineDash(dash) { this.state.dash = Array.from(dash); }
  fill() { this.record("fill"); }
  stroke() { this.record("stroke"); }
  record(type) {
    this.events.push({ type, ...this.state, dash: [...this.state.dash],
      path: this.path.map(operation => ({ ...operation })) });
  }
}
for (const property of ["strokeStyle", "fillStyle", "globalAlpha", "globalCompositeOperation", "lineWidth", "lineDashOffset"]) {
  Object.defineProperty(RecordingCanvasContext.prototype, property, {
    get() { return this.state[property]; },
    set(value) { this.state[property] = value; },
  });
}

function rendererRuntime(restoreUnmergedMarkers = false) {
  const runtime = vm.createContext({ console,
    localizedText: ja => ja,
    symmetricNiceAxis: limit => ({ xMin: -limit, xMax: limit, step: limit / 3,
      ticks: [-limit, 0, limit], formatter: String }),
    axisContext: canvas => ({ ctx: canvas.context, canvas, margin: { left: 0, top: 0 },
      innerWidth: 1000, innerHeight: 360, x: value => value, yDown: value => value }),
    drawAxes() {}, drawOverviewLegend() {}, drawWeightLegend() {},
    drawDirectRowLabels() {}, drawDetectorRowLegend() {}, drawCandidateTrace() {},
  });
  const constants = ["ROW_COLORS", "PALE", "RED", "INK", "MUTED", "FIGURE_FONT"].map(name => {
    const match = new RegExp(`^const ${name} = .+;$`, "m").exec(source);
    assert.ok(match, `Application constant ${name} exists`);
    return match[0];
  }).join("\n");
  const painters = ["hexToRgb", "rowRgb", "rowColor", "opaqueWeightColor", "drawWeightedMarker",
    "mergeDiagramMarkers", "drawDiagram"].map(functionSource).join("\n\n");
  vm.runInContext(`${constants}\n${painters}`, runtime);
  if (restoreUnmergedMarkers) {
    vm.runInContext("mergeDiagramMarkers = points => points.map(point => ({ ...point, contributionCount: 1, contributions: [{ ...point }], traceFamilyIds: [point.traceFamilyId], dataKinds: [point.dataKind] }));", runtime);
  }
  return runtime;
}

function independentRowRgb(row, rows) {
  const categorical = [[0, 114, 178], [213, 94, 0], [0, 158, 115], [230, 159, 0],
    [204, 121, 167], [86, 180, 233], [0, 0, 0], [119, 119, 119]];
  if (rows <= 8) return categorical[row];
  const fraction = row / (rows - 1);
  const lower = fraction <= 0.5 ? [31, 78, 121] : [67, 131, 120];
  const upper = fraction <= 0.5 ? [67, 131, 120] : [204, 126, 0];
  const local = fraction <= 0.5 ? fraction * 2 : (fraction - 0.5) * 2;
  return lower.map((channel, index) => Math.round(channel * (1 - local) + upper[index] * local));
}
const rgb = channels => `rgb(${channels.join(", ")})`;
function independentFill(row, rows, weight) {
  const saturation = 0.12 + 0.88 * Math.min(1, Math.max(0, weight));
  return rgb(independentRowRgb(row, rows).map(channel => Math.round(255 - (255 - channel) * saturation)));
}

function verifyRenderedMarkers(diagram, publicationMode, oldOrder = false) {
  const runtime = rendererRuntime(oldOrder);
  const ctx = new RecordingCanvasContext();
  const canvas = { context: ctx, dataset: { publicationMode: String(publicationMode) } };
  const before = JSON.stringify(diagram);
  runtime.drawDiagram(canvas, diagram, "zoom");
  const markers = ctx.events.filter(event => event.type === "fill");
  const expected = [...independentGroups(diagram.weightedPoints).values()].map(members => ({
    ...members[0], weight: members.reduce((sum, member) => sum + member.weight, 0),
    traceFamilyIds: [...new Set(members.map(member => member.traceFamilyId))],
  })).sort((a, b) => a.weight - b.weight);
  assert.equal(markers.length, expected.length, "Actual renderer must paint one glyph per physical sample, not per angular branch");
  for (let index = 0; index < expected.length; index += 1) {
    const point = expected[index];
    const event = markers[index];
    assert.equal(event.strokeStyle, rgb(independentRowRgb(point.row, diagram.totalRows)),
      `Rendered outline keeps detector row ${point.row + 1}`);
    assert.equal(event.fillStyle, independentFill(point.row, diagram.totalRows, point.weight),
      `Rendered fill encodes summed coefficient at physical key ${identity(point)}`);
    assert.equal(event.globalAlpha, 1, "Summed coefficients must use opaque fills, not opacity accumulation");
    assert.equal(event.globalCompositeOperation, "source-over",
      "Weight glyph colors must not inherit trajectory multiply compositing");
    assert.equal(event.clipped, true, "Data markers remain inside the plot clipping region");
    const roles = new Set(point.traceFamilyIds.map(id => id.startsWith("complementary-") ? "complementary" : "direct"));
    if (roles.has("complementary")) {
      assert.deepEqual(event.path.map(operation => operation.op), ["M", "L", "L", "Z"]);
      close(event.path[0].x, point.x, 1e-12, "Triangle x matches complementary candidate");
      close((event.path[1].x + event.path[2].x) / 2, point.x, 1e-12, "Triangle center x");
      close(event.path[0].y + (event.path[1].y - event.path[0].y) * 1.25 / 2.05,
        point.y, 1e-12, "Triangle center matches direct reference angle");
      if (roles.size > 1) {
        const eventIndex = ctx.events.indexOf(event);
        const innerCircle = ctx.events[eventIndex + 2];
        assert.equal(innerCircle.type, "stroke", "Dual-role marker has a visible inner-circle outline");
        assert.deepEqual(innerCircle.path.map(operation => operation.op), ["A"]);
        close(innerCircle.path[0].x, point.x, 1e-12, "Dual-role circle x");
        close(innerCircle.path[0].y, point.y, 1e-12, "Dual-role circle y");
        assert.equal(innerCircle.strokeStyle, event.strokeStyle);
      }
    } else {
      assert.deepEqual(event.path.map(operation => operation.op), ["A"]);
      close(event.path[0].x, point.x, 1e-12, "Circle x matches direct candidate");
      close(event.path[0].y, point.y, 1e-12, "Circle y matches direct reference angle");
    }
  }
  assert.equal(ctx.stack.length, 0, "Balanced canvas state after actual drawDiagram");
  assert.equal(JSON.stringify(diagram), before, "Renderer does not rewrite numerical diagram results");
  return { rows: diagram.totalRows, publicationMode, physicalMarkersPainted: markers.length };
}

const largeDiagram = computeUnwrapped(validateParams({ ...userParams, rows: 160, rowWidth: 0.5,
  radius: 250, viewSamples: 1200, state: 0.5 }), { state: 0.5, coneOn: true, samples: 720 });
const rendererResults = [userDiagram, largeDiagram].flatMap(diagram => [false, true]
  .map(publicationMode => verifyRenderedMarkers(diagram, publicationMode)));
rendererResults.push(verifyRenderedMarkers({ ...userDiagram, weightedPoints: dualRolePoints }, false));
assert.throws(() => verifyRenderedMarkers(userDiagram, false, true),
  /one glyph per physical sample/, "Memory-local old unmerged rendering must fail the count assertion");

// Separately run the real trajectory painter. A single row/turn trajectory
// must retain the same row color; dashed complementary paths are distinct.
const traceRuntime = rendererRuntime();
vm.runInContext(functionSource("drawCandidateTrace"), traceRuntime);
let traceCases = 0;
for (const diagram of [userDiagram, largeDiagram]) {
  for (const row of [0, diagram.totalRows - 1]) {
    for (const trace of diagram.traceFamilies) {
      const ctx = new RecordingCanvasContext();
      traceRuntime.drawCandidateTrace(ctx, diagram, trace, row, 0, value => value, value => value, 1000);
      assert.equal(ctx.events.length, 1, "One stroke per physical row/turn trajectory");
      assert.equal(ctx.events[0].strokeStyle, rgb(independentRowRgb(row, diagram.totalRows)));
      assert.deepEqual(ctx.events[0].dash, trace.family === "complementary" ? [5, 3] : []);
      assert.equal(ctx.events[0].globalCompositeOperation, "multiply", "Intersecting trajectories use multiply without recoloring the physical trace");
      close(ctx.events[0].globalAlpha, (trace.family === "complementary" ? 0.45 : 0.60)
        * Math.min(1, Math.sqrt(24 / diagram.totalRows)), 1e-12,
      "Dense-row trajectory opacity uses square-root density compensation alongside reduced line width");
      close(ctx.events[0].lineWidth, Math.max(0.45, 1.35 * Math.min(1, Math.sqrt(24 / diagram.totalRows))),
        1e-12, "Trajectory width uses the same density factor with the minimum visible width retained");
      assert.equal(ctx.globalCompositeOperation, "source-over", "Trajectory blending does not leak into subsequent markers");
      assert.equal(ctx.stack.length, 0);
      traceCases += 1;
    }
  }
}

console.log(JSON.stringify({ status: "PASS", scope: "Physical-marker presentation identity and local FW=0 weights; no SSPz numerical changes.",
  userFixture: { rawCount: 284, physicalMarkerCount: 214, duplicateGroups: 70,
    beta160SummedWeight: beta160.weight }, fixtureCount: fixtureResults.length, fixtureResults,
  rendererResults, traceCases, oldUnmergedRendererNegativeControl: "expected failure confirmed" }, null, 2));
