import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import {
  DEFAULT_PARAMS,
  computeProfileModel,
  computeSsp,
  computeUnwrapped,
  validateParams,
} from "../sim-core.js";

// Coordinate/serialization regression for Sections 2A and 2B. The independent
// angular formula and Cartesian distance calculation below do not call the
// production complementary-angle, row-lattice, or candidate-selection helpers.
// This verifies the declared explanatory geometry, not scanner reconstruction.
const TWO_PI = 2 * Math.PI;
const MM_TOLERANCE = 1e-9;
const ANGLE_TOLERANCE_DEG = 1e-9;
const DIRECT = "direct-full-scan";
const LI = "fan-beam-180li";
const fixtures = [
  { name: "single-centre-90", rows: 1, rowWidth: 0.25, beamPitch: 0.25, radius: 0, phase: 0, state: 0.137, viewSamples: 90 },
  { name: "four-offset-360", rows: 4, rowWidth: 1, beamPitch: 0.875, radius: 100, phase: 0.23, state: 0.371, viewSamples: 360 },
  { name: "eighty-offset-360", rows: 80, rowWidth: 0.5, beamPitch: 0.675, radius: 250, phase: 1.1, state: 0.271, viewSamples: 360 },
  { name: "publication-160-1200", rows: 160, rowWidth: 0.5, beamPitch: 0.875, radius: 250, phase: 0, state: 0.5, viewSamples: 1200 },
  { name: "dense-320-2400", rows: 320, rowWidth: 0.05, beamPitch: 2.5, radius: 249.9, phase: 2.4, state: 0.731, viewSamples: 2400 },
  { name: "four-shifted-90", rows: 4, rowWidth: 0.4, beamPitch: 1.125, radius: 137, phase: -1.7, state: 0.999, zReference: 7.3, viewSamples: 90 },
];

// Captured from the original 2026-08-28.2 core before the display-coordinate
// correction. Each hash contains complete z/profile arrays and public metrics
// for BOTH the pre-thickness and configured-thickness output. The four entries
// per fixture are direct off/on, then 180LI off/on. Do not refresh these merely
// to accommodate a diagram-only change: numerical reconstruction is out of scope.
const preFixProfileHashes = {
  "single-centre-90": [
    "c192fdde5d351701371934a95d6a69eb2c3581165976e9b5bc3622f496776f88",
    "c192fdde5d351701371934a95d6a69eb2c3581165976e9b5bc3622f496776f88",
    "1b00e4677890f70c60ddad6317af1bbb8b14ac5cbff4d440ca4c2a59a6f7b8c9",
    "1b00e4677890f70c60ddad6317af1bbb8b14ac5cbff4d440ca4c2a59a6f7b8c9",
  ],
  "four-offset-360": [
    "9fddef58c7fdf3b5eec56564be66f872cb16ddabf99c766147769939b7ecebeb",
    "dfd4d03ba43b93f37a20516156066892377a6a3bc6439b1bf28ae2eb20ed6bb9",
    "c93381c67ad69442d9f43d6f41f216d7bc9ca1f73e4206059934e61910f80f93",
    "9a9dd817c4f63614502e8b535c3e183fd27fc8b78c784038b8db11efb128eea7",
  ],
  "eighty-offset-360": [
    "4a63e1624906afe2e97383f838e17621e07b1734e15aa7c45606612c887a6c73",
    "6f03f7df9c2d33f333c437b4568f626705579e74134d77ccb83bdced9827585e",
    "735f0c76c4c20162d456b9b065e9886c144d46e55d2ce025e1d7c635a092e41b",
    "ed363e256a0cfd81a4d6832c15f8b311e87c182f8863cd9699d5cac6c68bf003",
  ],
  "publication-160-1200": [
    "b69924e11be7086909a299cfdda73aec95345ca92afc36f17155d581fd1d6ccf",
    "7fc257261608efea3953b06dc5cd783305cad63ccb387cbad88644c4b37cec89",
    "6f0f44c096f710b1918d38ce48fef1adcea69fe241d965659d5fdc067c666829",
    "68cff1c66d39244af7a00e4007a10e4fac9792a3a80084d79186890b744d193f",
  ],
  "dense-320-2400": [
    "4e229b1960f094349c1827959f87202fce489d0152230dd56779e995067ecdb6",
    "93db9345fa8c4f856685eadc0b4464c8270de8a247db0617c75fd137d9369d48",
    "dba2181c8ed5d260ae0c676517d1f0ff4ee0dd231237332c88f4df4206c9faa1",
    "555ec24e785e28a58ea6b08d6b5a699a065700c86eecd275f918fb137fb3a9c1",
  ],
  "four-shifted-90": [
    "4d2979cb9997096bd00b68d81eaf3f2be879c400fb5a0d7be0a33122a0c192a4",
    "d76a1e7cc47548e5c101e81cd6862b4df540366726e4531b8bdc0b3127768df8",
    "f8040bba93fa89e7024c1c8a07cdc2f53a0766a97e5a2deb9292aff9e4cf1b32",
    "df739874d17abc8546c2cdd180896f990e862cbfe050778aed027612e832cf80",
  ],
};

function close(actual, expected, tolerance, label) {
  const error = Math.abs(actual - expected);
  assert.ok(error <= tolerance, `${label}: actual=${actual}, expected=${expected}, error=${error}`);
  return error;
}

function independentFamilies(p, referenceViewIndex, coneOn) {
  const beta = TWO_PI * referenceViewIndex / p.viewSamples;
  const gamma = coneOn
    ? Math.atan2(p.radius * Math.sin(beta - p.phase), p.sourceRadius - p.radius * Math.cos(beta - p.phase))
    : 0;
  const complementaryAbsoluteView = (beta + Math.PI + 2 * gamma) * p.viewSamples / TWO_PI;
  // Recognize analytically on-grid angles without depending on the last ulp
  // of atan2 or the production floor/ceil implementation.
  const nearest = Math.round(complementaryAbsoluteView);
  const onGrid = Math.abs(complementaryAbsoluteView - nearest) < 1e-10;
  return {
    direct: referenceViewIndex,
    "complementary-lower": onGrid ? nearest : Math.floor(complementaryAbsoluteView),
    "complementary-upper": onGrid ? nearest : Math.ceil(complementaryAbsoluteView),
  };
}

function independentGeometry(p, acquiredViewIndex, coneOn) {
  const angle = TWO_PI * acquiredViewIndex / p.viewSamples;
  const sourceX = p.sourceRadius * Math.cos(angle);
  const sourceY = p.sourceRadius * Math.sin(angle);
  const pointX = p.radius * Math.cos(p.phase);
  const pointY = p.radius * Math.sin(p.phase);
  return {
    scale: coneOn ? Math.hypot(pointX - sourceX, pointY - sourceY) / p.sourceRadius : 1,
    sourceZ: p.beamPitch * p.rows * p.rowWidth * acquiredViewIndex / p.viewSamples,
  };
}

function numericProfile(result) {
  return {
    z: Array.from(result.z),
    profile: Array.from(result.profile),
    fwhm: result.fwhm,
    fwtm: result.fwtm,
    sigma: result.sigma,
    centroid: result.centroid,
    area: result.area,
  };
}

let checkedDiagrams = 0;
let checkedFamilyGridPoints = 0;
let checkedMarkers = 0;
let checkedProfilePairs = 0;
let maximumMarkerTrajectoryErrorMm = 0;
let maximumIndependentAxialErrorMm = 0;
let nonzeroFanPairingCases = 0;
let offGridComplementaryCases = 0;
for (const fixture of fixtures) {
  const p = validateParams({
    ...DEFAULT_PARAMS,
    ...fixture,
    sourceRadius: 600,
    sliceThicknessMm: 1,
    zSamples: 300,
    stateSamples: 24,
  });
  let profileHashIndex = 0;
  for (const reconstructionPath of [DIRECT, LI]) {
    const pairedDiagrams = [];
    for (const coneOn of [false, true]) {
      const label = `${fixture.name}.${reconstructionPath}.cone${Number(coneOn)}`;
      const options = { state: p.state, coneOn, reconstructionPath };
      const diagram = computeUnwrapped(p, { ...options, samples: 90 });
      pairedDiagrams.push(diagram);
      assert.equal(diagram.angleCoordinate, "direct-reference-view-angle", label);
      assert.equal(diagram.acquiredAngleCoordinate, "absolute-acquisition-angle-including-turn", label);
      const expectedFamilyIds = reconstructionPath === LI
        ? ["direct", "complementary-lower", "complementary-upper"]
        : ["direct"];
      assert.deepEqual(diagram.traceFamilies.map(family => family.id), expectedFamilyIds, label);
      assert.equal(diagram.traceFamilyCount, expectedFamilyIds.length, label);
      assert.equal(diagram.mappedCandidateLineCount, p.rows * diagram.turnCount * expectedFamilyIds.length, label);
      assert.equal(diagram.displayedRows, p.rows, label);
      assert.equal(diagram.traceGeometry.rowOffsets.length, p.rows, label);
      assert.deepEqual(diagram.usedTurnsOutsideOverview, [], label);
      const feed = p.beamPitch * p.rows * p.rowWidth;
      const families = new Map(diagram.traceFamilies.map(family => [family.id, family]));
      for (const family of diagram.traceFamilies) {
        assert.equal(family.family, family.id === "direct" ? "direct" : "complementary", label);
        for (const name of ["angles", "axial", "scales", "acquiredAngles", "absoluteViewIndices"]) {
          assert.equal(family[name].length, p.viewSamples + 1, `${label}.${family.id}.${name}.fullAcquiredGrid`);
        }
        assert.ok(family.angles instanceof Float64Array, label);
        assert.ok(family.axial instanceof Float64Array, label);
        assert.ok(family.scales instanceof Float64Array, label);
        assert.ok(family.acquiredAngles instanceof Float64Array, label);
        assert.ok(family.absoluteViewIndices instanceof Int32Array, label);
        for (let view = 0; view <= p.viewSamples; view += 1) {
          const expectedAcquiredView = independentFamilies(p, view, coneOn)[family.id];
          const expected = independentGeometry(p, expectedAcquiredView, coneOn);
          close(family.angles[view], 360 * view / p.viewSamples, ANGLE_TOLERANCE_DEG, `${label}.${family.id}.referenceAngle[${view}]`);
          assert.equal(family.absoluteViewIndices[view], expectedAcquiredView, `${label}.${family.id}.acquiredView[${view}]`);
          close(family.acquiredAngles[view], 360 * expectedAcquiredView / p.viewSamples, ANGLE_TOLERANCE_DEG, `${label}.${family.id}.acquiredAngle[${view}]`);
          maximumIndependentAxialErrorMm = Math.max(maximumIndependentAxialErrorMm,
            close(family.axial[view], expected.sourceZ, MM_TOLERANCE, `${label}.${family.id}.sourceZ[${view}]`));
          close(family.scales[view], expected.scale, 1e-12, `${label}.${family.id}.q[${view}]`);
          for (const row of [0, p.rows - 1]) {
            const rowOffset = (row + 0.5 - p.rows / 2) * p.rowWidth;
            const base = expected.sourceZ + expected.scale * rowOffset;
            // Extreme rows bound every intermediate row. The finite display
            // includes nearest turns and one neighbor on either side.
            const quotient = (diagram.z0 - base) / feed;
            const qNearest = Math.round(quotient);
            const stableQuotient = Math.abs(quotient - qNearest) < 1e-10 ? qNearest : quotient;
            assert.ok(diagram.turnMin <= Math.floor(stableQuotient) - 1, `${label}.${family.id}.lowerTurnCoverage`);
            assert.ok(diagram.turnMax >= Math.ceil(stableQuotient) + 1, `${label}.${family.id}.upperTurnCoverage`);
            for (const turn of [diagram.turnMin, diagram.turnMax]) {
              const position = base + turn * feed - diagram.z0;
              assert.ok(Math.abs(position) < diagram.overviewXLimit, `${label}.${family.id}.overviewCoverage`);
            }
          }
          checkedFamilyGridPoints += 1;
        }
        assert.equal(family.absoluteViewIndices.at(-1) - family.absoluteViewIndices[0], p.viewSamples, `${label}.${family.id}.seamViewShift`);
        close(family.axial.at(-1) - family.axial[0], feed, MM_TOLERANCE, `${label}.${family.id}.seamAxialShift`);
        close(family.scales.at(-1), family.scales[0], 1e-12, `${label}.${family.id}.seamScale`);
      }
      assert.ok(diagram.weightedPoints.length > 0, label);
      assert.ok(diagram.weightedPoints.some(point => point.y < 180), `${label}.firstHalfMarkers`);
      assert.ok(diagram.weightedPoints.some(point => point.y >= 180), `${label}.secondHalfMarkers`);
      for (const point of diagram.weightedPoints) {
        const expectedMarkerFamily = point.dataKind === "complementary-acquired-lower-angular-neighbor"
          ? "complementary-lower"
          : point.dataKind === "complementary-acquired-upper-angular-neighbor"
            ? "complementary-upper"
            : "direct";
        assert.equal(point.traceFamilyId, expectedMarkerFamily, `${label}.markerDataKindMatchesFamily`);
        const family = families.get(point.traceFamilyId);
        assert.ok(family, `${label}.markerFamily:${point.traceFamilyId}`);
        const view = point.referenceViewIndex;
        assert.ok(Number.isInteger(view) && view >= 0 && view < p.viewSamples, `${label}.markerReferenceGrid`);
        assert.equal(view, Math.floor(point.sampleIndex * p.viewSamples / diagram.samples), `${label}.markerDisplaySampleToAcquiredGrid`);
        assert.ok(Number.isInteger(point.row) && point.row >= 0 && point.row < p.rows, `${label}.markerRow`);
        assert.ok(diagram.traceGeometry.turns.includes(point.turn), `${label}.markerTurn`);
        assert.equal(point.baseAbsoluteViewIndex, family.absoluteViewIndices[view], `${label}.markerBaseView`);
        assert.equal(point.absoluteViewIndex, point.baseAbsoluteViewIndex + point.turn * p.viewSamples, `${label}.markerAbsoluteView`);
        close(point.acquiredAngleDeg, 360 * point.absoluteViewIndex / p.viewSamples, ANGLE_TOLERANCE_DEG, `${label}.markerAcquiredAngle`);
        close(point.y, family.angles[view], ANGLE_TOLERANCE_DEG, `${label}.markerReferenceAngle`);
        const rowOffset = diagram.traceGeometry.rowOffsets[point.row];
        const traceX = family.axial[view] + point.turn * feed + family.scales[view] * rowOffset - diagram.z0;
        maximumMarkerTrajectoryErrorMm = Math.max(maximumMarkerTrajectoryErrorMm,
          close(point.x, traceX, MM_TOLERANCE, `${label}.markerOnOwnTrajectory`));
        assert.ok(Math.abs(point.x) <= diagram.zoomXLimit, `${label}.markerZoomCoverage`);
        assert.ok(Math.abs(point.x) <= diagram.overviewXLimit, `${label}.markerOverviewCoverage`);
        checkedMarkers += 1;
      }
      if (reconstructionPath === LI) {
        const lower = families.get("complementary-lower");
        const upper = families.get("complementary-upper");
        for (let view = 0; view < p.viewSamples; view += 1) {
          if (lower.absoluteViewIndices[view] !== upper.absoluteViewIndices[view]) offGridComplementaryCases += 1;
          if (!coneOn || p.radius === 0) {
            assert.equal(lower.absoluteViewIndices[view], view + p.viewSamples / 2, `${label}.parallelComplement`);
            assert.equal(upper.absoluteViewIndices[view], lower.absoluteViewIndices[view], `${label}.parallelOnGrid`);
          }
        }
      }
      if (fixture.name === "publication-160-1200") {
        const thicker = computeUnwrapped({ ...p, sliceThicknessMm: 5 }, { ...options, samples: 90 });
        assert.deepEqual(thicker.traceFamilies, diagram.traceFamilies, `${label}.allAcquiredFamiliesThicknessInvariant`);
        assert.deepEqual(thicker.weightedPoints, diagram.weightedPoints, `${label}.allMarkerCoordinatesThicknessInvariant`);
        assert.deepEqual(thicker.traceGeometry.turns, diagram.traceGeometry.turns, `${label}.displayTurnsThicknessInvariant`);
        assert.equal(thicker.overviewXLimit, diagram.overviewXLimit, `${label}.overviewThicknessInvariant`);
        assert.equal(thicker.zoomXLimit, diagram.zoomXLimit, `${label}.zoomThicknessInvariant`);
      }
      const profilePair = {
        base: numericProfile(computeSsp(p, options)),
        configured: numericProfile(computeProfileModel(p, options)),
      };
      const hash = createHash("sha256").update(JSON.stringify(profilePair)).digest("hex");
      assert.equal(hash, preFixProfileHashes[fixture.name][profileHashIndex], `${label}.completeProfilesUnchangedFromPreFix`);
      profileHashIndex += 1;
      checkedProfilePairs += 1;
      checkedDiagrams += 1;
    }
    assert.deepEqual(pairedDiagrams[0].traceGeometry.turns, pairedDiagrams[1].traceGeometry.turns,
      `${fixture.name}.${reconstructionPath}.sharedComparisonTurns`);
    if (reconstructionPath === LI && p.radius > 0) {
      const off = pairedDiagrams[0].traceFamilies.find(family => family.id === "complementary-lower");
      const on = pairedDiagrams[1].traceFamilies.find(family => family.id === "complementary-lower");
      assert.ok(on.absoluteViewIndices.some((value, index) => value !== off.absoluteViewIndices[index]),
        `${fixture.name}.fanPairingMustRemainDistinctFromParallelReference`);
      assert.ok(on.scales.some(value => Math.abs(value - 1) > 1e-6), `${fixture.name}.offCentreDistanceScaling`);
      nonzeroFanPairingCases += 1;
    }
  }
}

assert.ok(nonzeroFanPairingCases > 0);
assert.ok(offGridComplementaryCases > 0);

// Execute the actual small canvas helpers against a recording context. This
// checks coordinates and family encodings without starting a browser or
// presenting a mock-canvas PASS as visual/export quality assurance.
const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
function sourceFunction(name, globals = {}) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Renderer helper ${name} must exist`);
  const nextFunction = appSource.indexOf("\nfunction ", start + 1);
  const body = appSource.slice(start, nextFunction < 0 ? appSource.length : nextFunction);
  return runInNewContext(`${body}\n${name};`, globals);
}
function recordingContext() {
  const calls = [];
  const context = { calls };
  for (const method of ["save", "restore", "beginPath", "closePath", "stroke", "fill", "setLineDash", "moveTo", "lineTo", "arc"]) {
    context[method] = (...args) => calls.push({ method, args: structuredClone(args) });
  }
  return context;
}
const drawCandidateTrace = sourceFunction("drawCandidateTrace", { rowColor: () => "#123456" });
const syntheticDiagram = {
  z0: 3,
  totalRows: 2,
  traceGeometry: {
    rowOffsets: new Float64Array([1, 2]),
    feed: 7,
    // Deliberately inconsistent legacy arrays: using these instead of the
    // supplied acquired family must fail the coordinate assertions below.
    angles: new Float64Array([999]),
    axial: new Float64Array([999]),
    scales: new Float64Array([999]),
  },
};
for (const family of ["direct", "complementary"]) {
  const trace = {
    family,
    angles: new Float64Array([0, 90, 180, 270, 360]),
    axial: new Float64Array([9, 10, 11, 12, 13]),
    scales: new Float64Array([0.5, 0.75, 1, 1.25, 1.5]),
  };
  const context = recordingContext();
  drawCandidateTrace(context, syntheticDiagram, trace, 1, -1, x => 10 * x, y => 2 * y, 100);
  const vertices = context.calls.filter(call => ["moveTo", "lineTo"].includes(call.method));
  assert.equal(vertices.length, trace.angles.length, `${family}.rendererRetainsEveryAcquiredView`);
  for (let index = 0; index < trace.angles.length; index += 1) {
    close(vertices[index].args[0], 10 * (trace.axial[index] - 7 + 2 * trace.scales[index] - 3), 1e-12, `${family}.rendererOwnFamilyX`);
    close(vertices[index].args[1], 2 * trace.angles[index], 1e-12, `${family}.rendererReferenceY`);
  }
  const lineDash = context.calls.find(call => call.method === "setLineDash");
  assert.deepEqual(lineDash.args[0], family === "complementary" ? [5, 3] : [], `${family}.rendererLineStyle`);
}
const drawWeightedMarker = sourceFunction("drawWeightedMarker", {
  rowColor: () => "#123456",
  opaqueWeightColor: () => "#abcdef",
});
for (const shape of ["circle", "triangle"]) {
  const context = recordingContext();
  drawWeightedMarker(context, 0, 2, 10, 20, 5, 0.5, shape);
  assert.equal(context.calls.filter(call => call.method === "arc").length, shape === "circle" ? 1 : 0, `${shape}.markerArc`);
  assert.equal(context.calls.filter(call => call.method === "lineTo").length, shape === "triangle" ? 2 : 0, `${shape}.markerSides`);
}
assert.match(appSource, /point\.traceFamilyId\?\.startsWith\("complementary-"\)\s*\?\s*"triangle"\s*:\s*"circle"/);
assert.match(appSource, /drawDiagramFamilyLegend\(ctx, diagram,/);
assert.match(appSource, /Direct data: solid line \/ circle/);
assert.match(appSource, /Complementary data: dashed line \/ triangle/);

console.log(JSON.stringify({
  status: "PASS",
  contract: "common-direct-reference-angle-with-own-acquired-family-row-turn-trajectories",
  fixtures: fixtures.length,
  checkedDiagrams,
  checkedFamilyGridPoints,
  checkedMarkers,
  checkedProfilePairs,
  profilesPerPair: 2,
  profileComparison: "exact-pre-fix-sha256-of-complete-z-profile-arrays-and-public-width-metrics",
  maximumMarkerTrajectoryErrorMm,
  maximumIndependentAxialErrorMm,
  nonzeroFanPairingCases,
  offGridComplementaryCases,
  rendererContract: "recorded-own-family-vertices-solid-dashed-lines-circle-triangle-markers",
  physicalValidationClaimed: false,
}, null, 2));
