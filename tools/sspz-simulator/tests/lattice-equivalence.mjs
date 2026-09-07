import assert from "node:assert/strict";
import {
  DEFAULT_PARAMS,
  computeFanBeamComplementaryGeometry,
  computeSsp,
  tableFeedMm,
  validateParams,
} from "../sim-core.js";

const TWO_PI = 2 * Math.PI;
const TOLERANCE_MM = 3e-6;

function close(label, actual, expected, tolerance = TOLERANCE_MM) {
  const error = Math.abs(actual - expected);
  assert.ok(error <= tolerance, `${label}: actual=${actual}, expected=${expected}, error=${error}`);
}

function bruteFamilyGeometry(p, z0, beta, coneOn) {
  const feed = tableFeedMm(p);
  const slope = feed / TWO_PI;
  const rho = p.radius / p.sourceRadius;
  const scale = coneOn
    ? Math.sqrt(Math.max(Number.EPSILON, 1 + rho * rho - 2 * rho * Math.cos(beta - p.phase)))
    : 1;
  let exact = false;
  let lower = -Infinity;
  let upper = Infinity;
  for (let row = 0; row < p.rows; row += 1) {
    const rowOffset = (row + 0.5 - p.rows / 2) * p.rowWidth;
    const base = slope * beta + scale * rowOffset;
    const quotient = (z0 - base) / feed;
    const rounded = Math.round(quotient);
    const turns = Math.abs(quotient - rounded) <= 1e-10
      ? [rounded]
      : [Math.floor(quotient), Math.ceil(quotient)];
    for (const turn of turns) {
      const delta = base + turn * feed - z0;
      if (Math.abs(delta) <= 1e-10) exact = true;
      else if (delta < 0) lower = Math.max(lower, delta);
      else upper = Math.min(upper, delta);
    }
  }
  return {
    exact,
    lower,
    upper,
    gapMm: exact ? 0 : upper - lower,
  };
}

function unionGap(direct, complementary) {
  if (direct.exact || complementary.exact) return 0;
  const lower = Math.max(direct.lower, complementary.lower);
  const upper = Math.min(direct.upper, complementary.upper);
  return upper - lower;
}

const fixtures = [
  { rows: 1, rowWidth: 0.25, beamPitch: 0.25, radius: 0, state: 0.137 },
  { rows: 4, rowWidth: 1, beamPitch: 0.875, radius: 102, state: 0.5 },
  { rows: 40, rowWidth: 0.5, beamPitch: 1.35, radius: 250, state: 0.999 },
  { rows: 80, rowWidth: 0.5, beamPitch: 0.675, radius: 150, state: 0.271 },
  { rows: 160, rowWidth: 0.5, beamPitch: 0.875, radius: 250, state: 0.5 },
  { rows: 320, rowWidth: 0.05, beamPitch: 2.5, radius: 249.9, state: 0.731 },
];

let comparedViews = 0;
for (const [fixtureIndex, fixture] of fixtures.entries()) {
  const p = validateParams({
    ...DEFAULT_PARAMS,
    ...fixture,
    sourceRadius: 600,
    sliceThicknessMm: 1,
    viewSamples: 120,
    zSamples: 500,
    stateSamples: 24,
  });
  const z0 = p.zReference + tableFeedMm(p) * p.state;
  for (const coneOn of [false, true]) {
    const directResult = computeSsp(p, {
      state: p.state,
      coneOn,
      reconstructionPath: "direct-full-scan",
      collectGeometrySeries: true,
    });
    const liResult = computeSsp(p, {
      state: p.state,
      coneOn,
      reconstructionPath: "fan-beam-180li",
      collectGeometrySeries: true,
      collectComplementaryCandidates: false,
    });
    for (let viewIndex = 0; viewIndex < p.viewSamples; viewIndex += 1) {
      const beta = TWO_PI * viewIndex / p.viewSamples;
      const direct = bruteFamilyGeometry(p, z0, beta, coneOn);
      close(
        `fixture${fixtureIndex}.cone${Number(coneOn)}.directGap[${viewIndex}]`,
        directResult.gapRatios[viewIndex] * p.sliceThicknessMm,
        direct.gapMm,
      );

      const pairing = computeFanBeamComplementaryGeometry(p, beta, { coneOn });
      const idealAbsoluteView = pairing.complementaryAngleUnwrappedRad / (TWO_PI / p.viewSamples);
      const lowerAbsoluteView = Math.floor(idealAbsoluteView + 1e-12);
      const upperAbsoluteView = Math.ceil(idealAbsoluteView - 1e-12);
      const lowerAngle = lowerAbsoluteView * TWO_PI / p.viewSamples;
      const upperAngle = upperAbsoluteView * TWO_PI / p.viewSamples;
      const lowerComplementary = bruteFamilyGeometry(p, z0, lowerAngle, coneOn);
      const upperComplementary = bruteFamilyGeometry(p, z0, upperAngle, coneOn);
      const lowerGap = unionGap(direct, lowerComplementary);
      const upperGap = unionGap(direct, upperComplementary);
      const angularSpan = upperAbsoluteView - lowerAbsoluteView;
      const lambda = angularSpan === 0
        ? 0
        : (idealAbsoluteView - lowerAbsoluteView) / angularSpan;
      const effectiveGap = (1 - lambda) * lowerGap + lambda * upperGap;
      close(`fixture${fixtureIndex}.cone${Number(coneOn)}.liLower[${viewIndex}]`, liResult.branchGapMmLower[viewIndex], lowerGap);
      close(`fixture${fixtureIndex}.cone${Number(coneOn)}.liUpper[${viewIndex}]`, liResult.branchGapMmUpper[viewIndex], upperGap);
      close(
        `fixture${fixtureIndex}.cone${Number(coneOn)}.liEffective[${viewIndex}]`,
        liResult.gapRatios[viewIndex] * p.sliceThicknessMm,
        effectiveGap,
      );
      comparedViews += 1;
    }
  }
}

console.log(JSON.stringify({
  status: "PASS",
  contract: "optimized-row-turn-lattice-equals-exhaustive-row-search",
  fixtures: fixtures.length,
  comparedViews,
  toleranceMm: TOLERANCE_MM,
}, null, 2));
