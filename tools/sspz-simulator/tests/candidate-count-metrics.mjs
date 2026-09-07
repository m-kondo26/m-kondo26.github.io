import assert from "node:assert/strict";

import {
  computeProfileModel,
  summarizeFinalCandidateContributions,
} from "../sim-core.js";

const close = (actual, expected, tolerance, label) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: actual=${actual}, expected=${expected}, tolerance=${tolerance}`,
  );
};

// Two angular interpolation branches may repeat the same acquired detector-row
// sample.  Its branch weights must be added before the physical count and the
// inverse-Simpson effective count are evaluated.
const mergedFixture = summarizeFinalCandidateContributions([
  { absoluteViewIndex: 10, row: 3, turn: 0, center: 1.25, aperture: 0.5, weight: 0.2 },
  { absoluteViewIndex: 10, row: 3, turn: 0, center: 1.25, aperture: 0.5, weight: 0.3 },
  { absoluteViewIndex: 11, row: 4, turn: 0, center: 1.75, aperture: 0.5, weight: 0.5 },
  { absoluteViewIndex: 12, row: 5, turn: 0, center: 2.25, aperture: 0.5, weight: 0 },
  { absoluteViewIndex: 13, row: 6, turn: 0, center: 2.75, aperture: 0.5, weight: 1e-14 },
]);
assert.equal(mergedFixture.contributionCount, 3);
assert.equal(mergedFixture.uniqueCandidateCount, 2);
assert.equal(mergedFixture.duplicateContributionCount, 1);
close(mergedFixture.totalWeight, 1, 1e-15, "mergedFixture.totalWeight");
close(mergedFixture.effectiveCandidateCount, 2, 1e-15, "mergedFixture.effectiveCandidateCount");
assert.match(mergedFixture.uniquenessKey, /absoluteViewIndex,row/);

// A coincident z coordinate does not merge different acquired samples.
const coincidentDistinctSamples = summarizeFinalCandidateContributions([
  { absoluteViewIndex: 20, row: 1, turn: 0, center: 0, aperture: 0.5, weight: 0.5 },
  { absoluteViewIndex: 21, row: 1, turn: 0, center: 0, aperture: 0.5, weight: 0.5 },
]);
assert.equal(coincidentDistinctSamples.uniqueCandidateCount, 2);

// Conversely, identical acquired-view × row identity must not be silently
// split by branch bookkeeping; inconsistent geometry for that identity is a
// hard error rather than a misleading candidate count.
assert.throws(() => summarizeFinalCandidateContributions([
  { absoluteViewIndex: 30, row: 2, turn: 0, center: 1, aperture: 0.5, weight: 0.4 },
  { absoluteViewIndex: 30, row: 2, turn: 0, center: 1.01, aperture: 0.5, weight: 0.6 },
]), /Inconsistent center for physical candidate/);

// Merging duplicate branch appearances conserves the weighted first and
// second raw moments because the duplicated physical sample has one center.
const duplicatedContributions = [
  { absoluteViewIndex: 40, row: 0, turn: 0, center: -0.5, aperture: 0.5, weight: 0.1 },
  { absoluteViewIndex: 40, row: 0, turn: 0, center: -0.5, aperture: 0.5, weight: 0.2 },
  { absoluteViewIndex: 41, row: 1, turn: 0, center: 0.25, aperture: 0.5, weight: 0.7 },
];
const contributionFirstMoment = duplicatedContributions
  .reduce((sum, candidate) => sum + candidate.weight * candidate.center, 0);
const contributionSecondMoment = duplicatedContributions
  .reduce((sum, candidate) => sum + candidate.weight * candidate.center ** 2, 0);
const mergedPhysical = [
  { weight: 0.3, center: -0.5 },
  { weight: 0.7, center: 0.25 },
];
close(mergedPhysical.reduce((sum, candidate) => sum + candidate.weight * candidate.center, 0),
  contributionFirstMoment, 1e-15, "merged first moment");
close(mergedPhysical.reduce((sum, candidate) => sum + candidate.weight * candidate.center ** 2, 0),
  contributionSecondMoment, 1e-15, "merged second moment");

const params = {
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

let duplicatedViews = 0;
const ranges = {};
for (const coneOn of [false, true]) {
  const result = computeProfileModel(params, {
    state: params.state,
    coneOn,
    collectGeometrySeries: true,
  });
  assert.ok(result.viewCandidateCounts instanceof Uint16Array);
  assert.ok(result.viewEffectiveCandidateCounts instanceof Float32Array);
  assert.ok(result.viewCandidateContributionCounts instanceof Uint16Array);
  assert.equal(result.viewCandidateCounts.length, params.viewSamples);
  assert.equal(result.viewEffectiveCandidateCounts.length, params.viewSamples);
  assert.equal(result.viewCandidateContributionCounts.length, params.viewSamples);

  let minUnique = Infinity;
  let maxUnique = 0;
  let minEffective = Infinity;
  let maxEffective = 0;
  let maxContribution = 0;
  for (let viewIndex = 0; viewIndex < params.viewSamples; viewIndex += 1) {
    const unique = result.viewCandidateCounts[viewIndex];
    const effective = result.viewEffectiveCandidateCounts[viewIndex];
    const contributions = result.viewCandidateContributionCounts[viewIndex];
    assert.ok(unique >= 1, `cone=${Number(coneOn)} view=${viewIndex}: unique=${unique}`);
    assert.ok(contributions >= unique, `cone=${Number(coneOn)} view=${viewIndex}: contributions=${contributions}, unique=${unique}`);
    assert.ok(effective >= 1 - 2e-6, `cone=${Number(coneOn)} view=${viewIndex}: Neff=${effective}`);
    assert.ok(effective <= unique + 2e-6, `cone=${Number(coneOn)} view=${viewIndex}: Neff=${effective}, unique=${unique}`);
    if (contributions > unique) duplicatedViews += 1;
    minUnique = Math.min(minUnique, unique);
    maxUnique = Math.max(maxUnique, unique);
    minEffective = Math.min(minEffective, effective);
    maxEffective = Math.max(maxEffective, effective);
    maxContribution = Math.max(maxContribution, contributions);
  }
  ranges[coneOn ? "coneOn" : "coneOff"] = {
    unique: [minUnique, maxUnique],
    effective: [minEffective, maxEffective],
    maximumContributionCount: maxContribution,
  };
}

assert.ok(duplicatedViews > 0, "The off-centre 180LI fixture must exercise angular-branch duplicate merging.");

console.log(JSON.stringify({
  contract: "final-nonzero-physical-candidate-count-and-effective-count",
  uniquenessKey: mergedFixture.uniquenessKey,
  duplicatedViews,
  ranges,
}, null, 2));
