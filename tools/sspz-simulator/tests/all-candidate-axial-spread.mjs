import assert from "node:assert/strict";

import {
  computeAllCandidateAxialSpreadAtView,
  computeAllCandidateAxialSpreadSeries,
  computeFanBeamComplementaryGeometry,
  tableFeedMm,
  validateParams,
} from "../sim-core.js";

const close = (actual, expected, tolerance, label) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: actual=${actual}, expected=${expected}, tolerance=${tolerance}`,
  );
};

const closeArrays = (actual, expected, tolerance, label) => {
  assert.equal(actual.length, expected.length, `${label}.length`);
  for (let index = 0; index < actual.length; index += 1) {
    close(actual[index], expected[index], tolerance, `${label}[${index}]`);
  }
};

const baseParams = {
  rows: 160,
  rowWidth: 0.5,
  beamPitch: 0.875,
  sourceRadius: 600,
  radius: 250,
  zReference: 0,
  state: 0.5,
  sliceThicknessMm: 1,
  profileMode: "layered-rect",
  reconstructionPath: "fan-beam-180li",
  viewSamples: 1200,
  zSamples: 800,
  stateSamples: 360,
  phase: 0,
};

function explicitPopulationOracle(rawParams, directViewIndexInput, { coneOn, commonTurnShift = 0 }) {
  const p = validateParams(rawParams);
  const viewCount = p.viewSamples;
  const directViewIndex = ((directViewIndexInput % viewCount) + viewCount) % viewCount;
  const stepRad = 2 * Math.PI / viewCount;
  const beta = stepRad * directViewIndex;
  const complementary = computeFanBeamComplementaryGeometry(p, beta, { coneOn });
  const idealAbsoluteView = complementary.complementaryAngleUnwrappedRad / stepRad;
  const lowerAbsoluteViewIndex = Math.floor(idealAbsoluteView + 1e-12);
  const upperAbsoluteViewIndex = Math.ceil(idealAbsoluteView - 1e-12);
  const turnDelta = commonTurnShift * viewCount;
  const absoluteViewIndices = [...new Set([
    directViewIndex + turnDelta,
    lowerAbsoluteViewIndex + turnDelta,
    upperAbsoluteViewIndex + turnDelta,
  ])];
  const feed = tableFeedMm(p);
  const rho = p.radius / p.sourceRadius;
  const positions = [];
  for (const absoluteViewIndex of absoluteViewIndices) {
    const angle = stepRad * absoluteViewIndex;
    const scale = coneOn
      ? Math.sqrt(1 + rho * rho - 2 * rho * Math.cos(angle - p.phase))
      : 1;
    const sourceZ = feed * absoluteViewIndex / viewCount;
    for (let row = 0; row < p.rows; row += 1) {
      const rowOffset = (row + 0.5 - p.rows / 2) * p.rowWidth;
      positions.push(sourceZ + scale * rowOffset);
    }
  }
  const mean = positions.reduce((sum, value) => sum + value, 0) / positions.length;
  const variance = positions.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    / positions.length;
  const minimum = Math.min(...positions);
  const maximum = Math.max(...positions);
  return {
    absoluteViewIndices,
    candidateCount: positions.length,
    mean,
    variance,
    standardDeviation: Math.sqrt(variance),
    minimum,
    maximum,
    range: maximum - minimum,
  };
}

// The production implementation is analytic; verify its first two moments and
// extrema against explicit enumeration of every physical acquired row.
for (const coneOn of [false, true]) {
  for (const directViewIndex of [0, 1, 119, 377, 599, 982, 1199]) {
    const actual = computeAllCandidateAxialSpreadAtView(baseParams, directViewIndex, { coneOn });
    const oracle = explicitPopulationOracle(baseParams, directViewIndex, { coneOn });
    assert.equal(actual.candidateCount, oracle.candidateCount, `count cone=${coneOn} view=${directViewIndex}`);
    assert.deepEqual(
      actual.families.map(family => family.absoluteViewIndex),
      oracle.absoluteViewIndices,
      `view identities cone=${coneOn} view=${directViewIndex}`,
    );
    close(actual.meanAxialPositionMm, oracle.mean, 2e-12, `mean cone=${coneOn} view=${directViewIndex}`);
    close(actual.populationVarianceMm2, oracle.variance, 2e-10, `variance cone=${coneOn} view=${directViewIndex}`);
    close(actual.populationStdDevMm, oracle.standardDeviation, 5e-12, `sd cone=${coneOn} view=${directViewIndex}`);
    close(actual.populationStdMm, actual.populationStdDevMm, 0, `sd alias cone=${coneOn} view=${directViewIndex}`);
    close(actual.minimumAxialPositionMm, oracle.minimum, 2e-12, `minimum cone=${coneOn} view=${directViewIndex}`);
    close(actual.maximumAxialPositionMm, oracle.maximum, 2e-12, `maximum cone=${coneOn} view=${directViewIndex}`);
    close(actual.rangeMm, oracle.range, 2e-12, `range cone=${coneOn} view=${directViewIndex}`);
    close(
      actual.withinFamilyVarianceMm2 + actual.betweenFamilyVarianceMm2,
      actual.populationVarianceMm2,
      2e-12,
      `variance decomposition cone=${coneOn} view=${directViewIndex}`,
    );
    for (const family of actual.families) {
      assert.equal(Object.hasOwn(family, "weight"), false);
      assert.equal(family.rowCount, baseParams.rows);
    }
  }
}

// The configured thickness is deliberately outside the data path.  Changing T
// must not alter the acquired identities, moments, or ranges.
for (const coneOn of [false, true]) {
  const thicknessSeries = [0.5, 1, 5, 20].map(sliceThicknessMm => (
    computeAllCandidateAxialSpreadSeries({ ...baseParams, sliceThicknessMm }, { coneOn })
  ));
  for (const series of thicknessSeries.slice(1)) {
    assert.deepEqual(series.uniqueAcquiredViewCounts, thicknessSeries[0].uniqueAcquiredViewCounts);
    assert.deepEqual(series.candidateCounts, thicknessSeries[0].candidateCounts);
    closeArrays(series.meanAxialPositionsMm, thicknessSeries[0].meanAxialPositionsMm, 0, `T invariant mean cone=${coneOn}`);
    closeArrays(series.populationStdDevMm, thicknessSeries[0].populationStdDevMm, 0, `T invariant sd cone=${coneOn}`);
    closeArrays(series.rangesMm, thicknessSeries[0].rangesMm, 0, `T invariant range cone=${coneOn}`);
  }
  assert.strictEqual(thicknessSeries[0].populationStdMm, thicknessSeries[0].populationStdDevMm);
}

// At the rotation centre, cone scaling is exactly unity and therefore the
// cone-on and cone-off populations must agree at every view.
const centreParams = { ...baseParams, radius: 0 };
const centreOff = computeAllCandidateAxialSpreadSeries(centreParams, { coneOn: false });
const centreOn = computeAllCandidateAxialSpreadSeries(centreParams, { coneOn: true });
assert.deepEqual(centreOn.uniqueAcquiredViewCounts, centreOff.uniqueAcquiredViewCounts);
assert.deepEqual(centreOn.candidateCounts, centreOff.candidateCounts);
closeArrays(centreOn.meanAxialPositionsMm, centreOff.meanAxialPositionsMm, 0, "r=0 mean");
closeArrays(centreOn.populationStdDevMm, centreOff.populationStdDevMm, 0, "r=0 sd");
closeArrays(centreOn.rangesMm, centreOff.rangesMm, 0, "r=0 range");

// An exactly acquired complementary angle contributes one complementary view
// (2N points total); an off-grid ideal angle contributes both neighbours (3N).
const onGrid = computeAllCandidateAxialSpreadAtView(baseParams, 0, { coneOn: true });
assert.equal(onGrid.uniqueAcquiredViewCount, 2);
assert.equal(onGrid.candidateCount, 2 * baseParams.rows);
const coneOffSeries = computeAllCandidateAxialSpreadSeries(baseParams, { coneOn: false });
assert.ok(Array.from(coneOffSeries.uniqueAcquiredViewCounts).every(value => value === 2));
assert.ok(Array.from(coneOffSeries.candidateCounts).every(value => value === 2 * baseParams.rows));
const coneSeries = computeAllCandidateAxialSpreadSeries(baseParams, { coneOn: true });
const offGridViewIndex = coneSeries.uniqueAcquiredViewCounts.findIndex(value => value === 3);
assert.ok(offGridViewIndex >= 0, "The off-centre fan-beam fixture must contain an off-grid complementary angle.");
const offGrid = computeAllCandidateAxialSpreadAtView(baseParams, offGridViewIndex, { coneOn: true });
assert.equal(offGrid.uniqueAcquiredViewCount, 3);
assert.equal(offGrid.candidateCount, 3 * baseParams.rows);
assert.ok(offGrid.families.every(family => family.rowCount === baseParams.rows));

// Rows remain in the population even when their longitudinal positions are
// far outside the configured-thickness half width around the inspected plane.
const targetPlaneMm = tableFeedMm(validateParams(baseParams)) * baseParams.state;
const farthestDistanceMm = Math.max(...offGrid.families.flatMap(family => [
  Math.abs(family.minimumAxialPositionMm - targetPlaneMm),
  Math.abs(family.maximumAxialPositionMm - targetPlaneMm),
]));
assert.ok(farthestDistanceMm > baseParams.sliceThicknessMm / 2);

// Moving every acquired view by one complete turn is a common axial
// translation.  It changes the origin-dependent locations by F but not spread.
const unshifted = computeAllCandidateAxialSpreadAtView(baseParams, 377, {
  coneOn: true,
  commonTurnShift: 0,
});
const shifted = computeAllCandidateAxialSpreadAtView(baseParams, 377, {
  coneOn: true,
  commonTurnShift: 1,
});
const feed = tableFeedMm(validateParams(baseParams));
assert.deepEqual(
  shifted.families.map(family => family.absoluteViewIndex),
  unshifted.families.map(family => family.absoluteViewIndex + baseParams.viewSamples),
);
close(shifted.meanAxialPositionMm - unshifted.meanAxialPositionMm, feed, 2e-12, "common-turn mean shift");
close(shifted.minimumAxialPositionMm - unshifted.minimumAxialPositionMm, feed, 2e-12, "common-turn minimum shift");
close(shifted.maximumAxialPositionMm - unshifted.maximumAxialPositionMm, feed, 2e-12, "common-turn maximum shift");
close(shifted.populationStdDevMm, unshifted.populationStdDevMm, 2e-12, "common-turn sd invariance");
close(shifted.rangeMm, unshifted.rangeMm, 2e-12, "common-turn range invariance");

// Reconstruction-plane state s is absent from the pure acquisition-geometry
// statistic.  The same beta series must therefore be exactly state invariant.
const stateSeries = [0, 0.123, 0.5, 0.999].map(state => (
  computeAllCandidateAxialSpreadSeries({ ...baseParams, state }, { coneOn: true })
));
for (const series of stateSeries.slice(1)) {
  assert.deepEqual(series.uniqueAcquiredViewCounts, stateSeries[0].uniqueAcquiredViewCounts);
  closeArrays(series.populationStdDevMm, stateSeries[0].populationStdDevMm, 0, "state invariant sd");
  closeArrays(series.rangesMm, stateSeries[0].rangesMm, 0, "state invariant range");
}

// The direct-view argument is periodic: V represents the same 360-degree
// acquisition angle as view 0, not an additional candidate family.
const atZero = computeAllCandidateAxialSpreadAtView(baseParams, 0, { coneOn: true });
const atFullTurn = computeAllCandidateAxialSpreadAtView(
  baseParams,
  baseParams.viewSamples,
  { coneOn: true },
);
assert.equal(atFullTurn.directViewIndex, 0);
assert.deepEqual(atFullTurn.families, atZero.families);
close(atFullTurn.populationStdDevMm, atZero.populationStdDevMm, 0, "0/360 sd periodicity");
close(atFullTurn.rangeMm, atZero.rangeMm, 0, "0/360 range periodicity");

// Series values are the same public calculation evaluated at every view.
for (const directViewIndex of [0, offGridViewIndex, 377, 1199]) {
  const single = computeAllCandidateAxialSpreadAtView(baseParams, directViewIndex, { coneOn: true });
  close(coneSeries.populationStdDevMm[directViewIndex], single.populationStdDevMm, 0, `series sd view=${directViewIndex}`);
  close(coneSeries.rangesMm[directViewIndex], single.rangeMm, 0, `series range view=${directViewIndex}`);
  assert.equal(coneSeries.candidateCounts[directViewIndex], single.candidateCount);
}

console.log(JSON.stringify({
  contract: "pure-unweighted-all-acquired-row-centre-population-spread",
  candidateIdentity: coneSeries.candidateIdentity,
  viewCount: coneSeries.viewCount,
  onGridCandidateCount: onGrid.candidateCount,
  offGridViewIndex,
  offGridCandidateCount: offGrid.candidateCount,
  populationStdDevMmRange: [
    Math.min(...coneSeries.populationStdDevMm),
    Math.max(...coneSeries.populationStdDevMm),
  ],
  axialRangeMmRange: [
    Math.min(...coneSeries.rangesMm),
    Math.max(...coneSeries.rangesMm),
  ],
}, null, 2));
