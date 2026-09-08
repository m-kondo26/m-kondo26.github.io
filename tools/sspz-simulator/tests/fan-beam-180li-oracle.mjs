import assert from "node:assert/strict";
import {
  DEFAULT_PARAMS,
  computeLayeredSsp,
  computeSsp,
  computeUnwrapped,
  validateParams,
} from "../sim-core.js";

// Independent geometry oracle for the public fan-beam 180LI path.
//
// Deliberately do not call computeFanBeamComplementaryGeometry or any private
// candidate-selection helper in sim-core.js.  Candidate centers are enumerated
// row-by-row over a deliberately broad turn interval; the oracle then performs
// the two longitudinal branch interpolations and the angular interpolation
// directly from the geometric definitions.

const TWO_PI = 2 * Math.PI;
const GEOMETRY_TOLERANCE_MM = 2e-9;
const WEIGHT_TOLERANCE = 2e-10;
const PUBLIC_FLOAT32_TOLERANCE = 4e-6;
const TIE_TOLERANCE_MM = 1e-10;

function close(label, actual, expected, tolerance) {
  const error = Math.abs(actual - expected);
  assert.ok(
    error <= tolerance,
    `${label}: actual=${actual}, expected=${expected}, error=${error}, tolerance=${tolerance}`,
  );
}

function wrapAngleRad(angle) {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

function independentComplementaryAngle(p, beta, coneOn) {
  const betaWrapped = wrapAngleRad(beta);
  if (!coneOn || p.radius <= Number.EPSILON) return beta + Math.PI;

  const source = [
    p.sourceRadius * Math.cos(betaWrapped),
    p.sourceRadius * Math.sin(betaWrapped),
  ];
  const point = [
    p.radius * Math.cos(p.phase),
    p.radius * Math.sin(p.phase),
  ];
  const direction = [point[0] - source[0], point[1] - source[1]];
  const directionSquared = direction[0] ** 2 + direction[1] ** 2;
  const secondRoot = -2 * (source[0] * direction[0] + source[1] * direction[1])
    / directionSquared;
  const secondSource = [
    source[0] + secondRoot * direction[0],
    source[1] + secondRoot * direction[1],
  ];
  const complementaryWrapped = wrapAngleRad(Math.atan2(secondSource[1], secondSource[0]));
  let forward = wrapAngleRad(complementaryWrapped - betaWrapped);
  if (forward <= Number.EPSILON) forward = TWO_PI;
  return beta + forward;
}

function acquiredAngularBracket(viewSamples, idealAngleUnwrappedRad) {
  const step = TWO_PI / viewSamples;
  const idealAbsoluteView = idealAngleUnwrappedRad / step;
  const lowerAbsoluteViewIndex = Math.floor(idealAbsoluteView + 1e-12);
  const upperAbsoluteViewIndex = Math.ceil(idealAbsoluteView - 1e-12);
  const lowerAngle = lowerAbsoluteViewIndex * step;
  const upperAngle = upperAbsoluteViewIndex * step;
  const span = upperAngle - lowerAngle;
  const fraction = span <= Number.EPSILON
    ? 0
    : (idealAngleUnwrappedRad - lowerAngle) / span;
  return {
    step,
    idealAbsoluteView,
    lowerAbsoluteViewIndex,
    upperAbsoluteViewIndex,
    lowerAngle,
    upperAngle,
    fraction,
  };
}

function enumerateRowTurnLattice(p, z0, beta, coneOn, dataKind, family) {
  const feed = p.beamPitch * p.rows * p.rowWidth;
  const slope = feed / TWO_PI;
  const rho = p.radius / p.sourceRadius;
  const scale = coneOn
    ? Math.sqrt(1 + rho ** 2 - 2 * rho * Math.cos(beta - p.phase))
    : 1;
  const bases = Array.from({ length: p.rows }, (_, row) => (
    slope * beta + scale * (row + 0.5 - p.rows / 2) * p.rowWidth
  ));
  const minimumBase = Math.min(...bases);
  const maximumBase = Math.max(...bases);

  // Every row repeats once per table feed.  Its nearest point to z0 is less
  // than one feed away.  The extra turn on each side makes this an exhaustive
  // finite enumeration of every center that can possibly be a global nearest
  // lower, upper, or exact candidate.
  const turnMinimum = Math.floor((z0 - feed - maximumBase) / feed) - 1;
  const turnMaximum = Math.ceil((z0 + feed - minimumBase) / feed) + 1;
  const candidates = [];
  for (let turn = turnMinimum; turn <= turnMaximum; turn += 1) {
    for (let row = 0; row < p.rows; row += 1) {
      const center = bases[row] + turn * feed;
      candidates.push({
        dataKind,
        family,
        row,
        turn,
        center,
        delta: center - z0,
        aperture: p.rowWidth * scale,
      });
    }
  }
  return candidates;
}

function longitudinalBranch(p, directLattice, complementaryLattice) {
  const union = [...directLattice, ...complementaryLattice];
  const exact = union.filter(candidate => Math.abs(candidate.delta) <= TIE_TOLERANCE_MM);
  if (exact.length) {
    return {
      candidates: exact.map(candidate => ({ ...candidate, longitudinalWeight: 1 / exact.length })),
      gapMm: 0,
    };
  }

  const lowerDelta = Math.max(...union
    .filter(candidate => candidate.delta < -TIE_TOLERANCE_MM)
    .map(candidate => candidate.delta));
  const upperDelta = Math.min(...union
    .filter(candidate => candidate.delta > TIE_TOLERANCE_MM)
    .map(candidate => candidate.delta));
  assert.ok(Number.isFinite(lowerDelta) && Number.isFinite(upperDelta));
  const lower = union.filter(candidate => Math.abs(candidate.delta - lowerDelta) <= TIE_TOLERANCE_MM);
  const upper = union.filter(candidate => Math.abs(candidate.delta - upperDelta) <= TIE_TOLERANCE_MM);
  const gapMm = upperDelta - lowerDelta;
  const lowerEndpointWeight = upperDelta / gapMm;
  const upperEndpointWeight = -lowerDelta / gapMm;
  return {
    candidates: [
      ...lower.map(candidate => ({
        ...candidate,
        longitudinalWeight: lowerEndpointWeight / lower.length,
      })),
      ...upper.map(candidate => ({
        ...candidate,
        longitudinalWeight: upperEndpointWeight / upper.length,
      })),
    ],
    gapMm,
  };
}

// Exhaustive but allocation-light family oracle used by the production-size
// regression below.  Every detector row and every turn in the independently
// derived necessary interval is visited.  Only the exact/nearest endpoint
// candidates are retained, so the 160-row x 1200-view audit remains practical
// without reusing the production lattice-search helper.
function exhaustiveFamilyEndpoints(p, z0, beta, coneOn, dataKind, family) {
  const feed = p.beamPitch * p.rows * p.rowWidth;
  const slope = feed / TWO_PI;
  const rho = p.radius / p.sourceRadius;
  const scale = coneOn
    ? Math.sqrt(1 + rho ** 2 - 2 * rho * Math.cos(beta - p.phase))
    : 1;
  const firstBase = slope * beta + scale * (0.5 - p.rows / 2) * p.rowWidth;
  const lastBase = firstBase + scale * (p.rows - 1) * p.rowWidth;
  const turnMinimum = Math.floor((z0 - feed - lastBase) / feed) - 1;
  const turnMaximum = Math.ceil((z0 + feed - firstBase) / feed) + 1;
  const exact = [];
  let lowerDelta = -Infinity;
  let upperDelta = Infinity;
  let lower = [];
  let upper = [];

  for (let turn = turnMinimum; turn <= turnMaximum; turn += 1) {
    for (let row = 0; row < p.rows; row += 1) {
      const center = firstBase + scale * row * p.rowWidth + turn * feed;
      const delta = center - z0;
      const candidate = {
        dataKind,
        family,
        row,
        turn,
        center,
        delta,
        aperture: p.rowWidth * scale,
      };
      if (Math.abs(delta) <= TIE_TOLERANCE_MM) {
        exact.push(candidate);
      } else if (delta < 0) {
        if (delta > lowerDelta + TIE_TOLERANCE_MM) {
          lowerDelta = delta;
          lower = [candidate];
        } else if (Math.abs(delta - lowerDelta) <= TIE_TOLERANCE_MM) {
          lower.push(candidate);
        }
      } else if (delta < upperDelta - TIE_TOLERANCE_MM) {
        upperDelta = delta;
        upper = [candidate];
      } else if (Math.abs(delta - upperDelta) <= TIE_TOLERANCE_MM) {
        upper.push(candidate);
      }
    }
  }
  return { exact, lowerDelta, upperDelta, lower, upper };
}

function branchFromExhaustiveFamilyEndpoints(direct, complementary) {
  const exact = [...direct.exact, ...complementary.exact];
  const directExactMultiplicity = direct.exact.length;
  const complementaryExactMultiplicity = complementary.exact.length;
  if (exact.length) {
    return {
      candidates: exact.map(candidate => ({
        ...candidate,
        longitudinalWeight: 1 / exact.length,
      })),
      gapMm: 0,
      lowerDelta: 0,
      upperDelta: 0,
      lowerWeight: 1,
      upperWeight: 0,
      lowerFamilyMask: (directExactMultiplicity ? 1 : 0)
        | (complementaryExactMultiplicity ? 2 : 0),
      upperFamilyMask: (directExactMultiplicity ? 1 : 0)
        | (complementaryExactMultiplicity ? 2 : 0),
      lowerTieCount: exact.length,
      upperTieCount: exact.length,
      directExactMultiplicity,
      complementaryExactMultiplicity,
      exactMatch: true,
    };
  }

  const lowerDelta = Math.max(direct.lowerDelta, complementary.lowerDelta);
  const upperDelta = Math.min(direct.upperDelta, complementary.upperDelta);
  const directLowerTied = Math.abs(direct.lowerDelta - lowerDelta) <= TIE_TOLERANCE_MM;
  const complementaryLowerTied = Math.abs(complementary.lowerDelta - lowerDelta)
    <= TIE_TOLERANCE_MM;
  const directUpperTied = Math.abs(direct.upperDelta - upperDelta) <= TIE_TOLERANCE_MM;
  const complementaryUpperTied = Math.abs(complementary.upperDelta - upperDelta)
    <= TIE_TOLERANCE_MM;
  const lower = [
    ...(directLowerTied ? direct.lower : []),
    ...(complementaryLowerTied ? complementary.lower : []),
  ];
  const upper = [
    ...(directUpperTied ? direct.upper : []),
    ...(complementaryUpperTied ? complementary.upper : []),
  ];
  assert.ok(lower.length && upper.length);
  const gapMm = upperDelta - lowerDelta;
  const lowerWeight = upperDelta / gapMm;
  const upperWeight = -lowerDelta / gapMm;
  return {
    candidates: [
      ...lower.map(candidate => ({
        ...candidate,
        longitudinalWeight: lowerWeight / lower.length,
      })),
      ...upper.map(candidate => ({
        ...candidate,
        longitudinalWeight: upperWeight / upper.length,
      })),
    ],
    gapMm,
    lowerDelta,
    upperDelta,
    lowerWeight,
    upperWeight,
    lowerFamilyMask: (directLowerTied ? 1 : 0) | (complementaryLowerTied ? 2 : 0),
    upperFamilyMask: (directUpperTied ? 1 : 0) | (complementaryUpperTied ? 2 : 0),
    lowerTieCount: lower.length,
    upperTieCount: upper.length,
    directExactMultiplicity: 0,
    complementaryExactMultiplicity: 0,
    exactMatch: false,
  };
}

function independent180LiAtViewExhaustiveEndpoints(p, state, viewIndex, coneOn) {
  const feed = p.beamPitch * p.rows * p.rowWidth;
  const z0 = p.zReference + feed * state;
  const beta = TWO_PI * viewIndex / p.viewSamples;
  const idealComplementaryAngle = independentComplementaryAngle(p, beta, coneOn);
  const angular = acquiredAngularBracket(p.viewSamples, idealComplementaryAngle);
  const direct = exhaustiveFamilyEndpoints(
    p, z0, beta, coneOn, "direct-acquired", "direct",
  );
  const lowerBranch = branchFromExhaustiveFamilyEndpoints(
    direct,
    exhaustiveFamilyEndpoints(
      p,
      z0,
      angular.lowerAngle,
      coneOn,
      "complementary-acquired-lower-angular-neighbor",
      "complementary",
    ),
  );
  const sameAngularView = angular.lowerAbsoluteViewIndex === angular.upperAbsoluteViewIndex;
  const upperBranch = sameAngularView
    ? lowerBranch
    : branchFromExhaustiveFamilyEndpoints(
      direct,
      exhaustiveFamilyEndpoints(
        p,
        z0,
        angular.upperAngle,
        coneOn,
        "complementary-acquired-upper-angular-neighbor",
        "complementary",
      ),
    );
  const lowerAngularWeight = sameAngularView ? 1 : 1 - angular.fraction;
  const upperAngularWeight = sameAngularView ? 0 : angular.fraction;
  const candidates = [];
  for (const [branch, angularWeight] of [
    [lowerBranch, lowerAngularWeight],
    [upperBranch, upperAngularWeight],
  ]) {
    if (angularWeight <= Number.EPSILON) continue;
    for (const candidate of branch.candidates) {
      candidates.push({
        ...candidate,
        angularWeight,
        weight: angularWeight * candidate.longitudinalWeight,
      });
    }
  }
  const weightSum = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  const firstMomentMm = candidates.reduce(
    (sum, candidate) => sum + candidate.weight * candidate.delta,
    0,
  );
  const meanMm = firstMomentMm / weightSum;
  const secondCentralMomentMm2 = candidates.reduce(
    (sum, candidate) => sum + candidate.weight * (
      (candidate.delta - meanMm) ** 2 + candidate.aperture ** 2 / 12
    ),
    0,
  ) / weightSum;
  return {
    angular,
    lowerBranch,
    upperBranch,
    lowerAngularWeight,
    upperAngularWeight,
    effectiveGapMm: lowerAngularWeight * lowerBranch.gapMm
      + upperAngularWeight * upperBranch.gapMm,
    candidates,
    weightSum,
    firstMomentMm,
    secondCentralMomentMm2,
  };
}

function independent180LiAtView(p, state, viewIndex, coneOn) {
  const feed = p.beamPitch * p.rows * p.rowWidth;
  const z0 = p.zReference + feed * state;
  const beta = TWO_PI * viewIndex / p.viewSamples;
  const idealComplementaryAngle = independentComplementaryAngle(p, beta, coneOn);
  const angular = acquiredAngularBracket(p.viewSamples, idealComplementaryAngle);
  const direct = enumerateRowTurnLattice(
    p,
    z0,
    beta,
    coneOn,
    "direct-acquired",
    "direct",
  );
  const lowerBranch = longitudinalBranch(
    p,
    direct,
    enumerateRowTurnLattice(
      p,
      z0,
      angular.lowerAngle,
      coneOn,
      "complementary-acquired-lower-angular-neighbor",
      "complementary",
    ),
  );
  const sameAngularView = angular.lowerAbsoluteViewIndex === angular.upperAbsoluteViewIndex;
  const upperBranch = sameAngularView
    ? lowerBranch
    : longitudinalBranch(
      p,
      direct,
      enumerateRowTurnLattice(
        p,
        z0,
        angular.upperAngle,
        coneOn,
        "complementary-acquired-upper-angular-neighbor",
        "complementary",
      ),
    );
  const lowerAngularWeight = sameAngularView ? 1 : 1 - angular.fraction;
  const upperAngularWeight = sameAngularView ? 0 : angular.fraction;
  const candidates = [];
  for (const [branch, angularWeight] of [
    [lowerBranch, lowerAngularWeight],
    [upperBranch, upperAngularWeight],
  ]) {
    if (angularWeight <= Number.EPSILON) continue;
    for (const candidate of branch.candidates) {
      candidates.push({
        ...candidate,
        angularWeight,
        weight: angularWeight * candidate.longitudinalWeight,
      });
    }
  }
  return {
    beta,
    idealComplementaryAngle,
    angular,
    lowerBranch,
    upperBranch,
    lowerAngularWeight,
    upperAngularWeight,
    candidates,
    effectiveGapMm: lowerAngularWeight * lowerBranch.gapMm
      + upperAngularWeight * upperBranch.gapMm,
    weightSum: candidates.reduce((sum, candidate) => sum + candidate.weight, 0),
    firstMomentMm: candidates.reduce((sum, candidate) => sum + candidate.weight * candidate.delta, 0),
    secondMomentMm2: candidates.reduce((sum, candidate) => sum + candidate.weight * candidate.delta ** 2, 0),
  };
}

function sortCandidates(candidates) {
  return [...candidates].sort((left, right) => (
    left.dataKind.localeCompare(right.dataKind)
    || left.row - right.row
    || left.turn - right.turn
    || left.delta - right.delta
    || left.weight - right.weight
  ));
}

function compareCandidateMultiset(label, actualRaw, expectedRaw) {
  const actual = sortCandidates(actualRaw.map(candidate => ({
    dataKind: candidate.dataKind,
    row: candidate.row,
    turn: candidate.turn,
    delta: candidate.x,
    weight: candidate.weight,
  })));
  const expected = sortCandidates(expectedRaw);
  assert.equal(actual.length, expected.length, `${label}.candidateCount`);
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(actual[index].dataKind, expected[index].dataKind, `${label}[${index}].dataKind`);
    assert.equal(actual[index].row, expected[index].row, `${label}[${index}].row`);
    assert.equal(actual[index].turn, expected[index].turn, `${label}[${index}].turn`);
    close(`${label}[${index}].delta`, actual[index].delta, expected[index].delta, GEOMETRY_TOLERANCE_MM);
    close(`${label}[${index}].weight`, actual[index].weight, expected[index].weight, WEIGHT_TOLERANCE);
  }
}

const oracleFixtures = [
  {
    name: "four-row-off-center",
    rows: 4,
    rowWidth: 0.5,
    beamPitch: 0.875,
    radius: 250,
    phase: 0.23,
    state: 0.371,
    viewSamples: 90,
  },
  {
    name: "five-row-tie-stress",
    rows: 5,
    rowWidth: 0.4,
    beamPitch: 1.125,
    radius: 137,
    phase: 1.1,
    state: 0.5,
    viewSamples: 120,
  },
];

let auditedViews = 0;
let auditedCandidateInstances = 0;
for (const fixture of oracleFixtures) {
  const p = validateParams({
    ...DEFAULT_PARAMS,
    ...fixture,
    sourceRadius: 600,
    sliceThicknessMm: 1,
    zSamples: 300,
    stateSamples: 24,
  });
  for (const coneOn of [false, true]) {
    const publicAudit = computeSsp(p, {
      state: p.state,
      coneOn,
      reconstructionPath: "fan-beam-180li",
      collectGeometrySeries: true,
      collectComplementaryCandidates: true,
    });
    const publicDiagram = computeUnwrapped(p, {
      state: p.state,
      coneOn,
      reconstructionPath: "fan-beam-180li",
      samples: p.viewSamples,
    });
    const pointsByView = new Map();
    for (const point of publicDiagram.weightedPoints) {
      if (!pointsByView.has(point.sampleIndex)) pointsByView.set(point.sampleIndex, []);
      pointsByView.get(point.sampleIndex).push(point);
    }
    let oracleKernelSecondMomentSumMm2 = 0;

    for (let viewIndex = 0; viewIndex < p.viewSamples; viewIndex += 1) {
      const oracle = independent180LiAtView(p, p.state, viewIndex, coneOn);
      const oracleMeanMm = oracle.firstMomentMm / oracle.weightSum;
      const oracleKernelSecondMomentMm2 = oracle.candidates.reduce(
        (sum, candidate) => sum + candidate.weight * (
          (candidate.delta - oracleMeanMm) ** 2 + candidate.aperture ** 2 / 12
        ),
        0,
      ) / oracle.weightSum;
      oracleKernelSecondMomentSumMm2 += oracleKernelSecondMomentMm2;
      close(`${fixture.name}.cone${Number(coneOn)}.weightSum[${viewIndex}]`, oracle.weightSum, 1, 2e-12);
      close(`${fixture.name}.cone${Number(coneOn)}.zMoment[${viewIndex}]`, oracle.firstMomentMm, 0, 2e-10);
      close(
        `${fixture.name}.cone${Number(coneOn)}.angularMoment[${viewIndex}]`,
        oracle.lowerAngularWeight * oracle.angular.lowerAngle
          + oracle.upperAngularWeight * oracle.angular.upperAngle,
        oracle.idealComplementaryAngle,
        2e-12,
      );
      close(
        `${fixture.name}.cone${Number(coneOn)}.publicLowerGap[${viewIndex}]`,
        publicAudit.branchGapMmLower[viewIndex],
        oracle.lowerBranch.gapMm,
        PUBLIC_FLOAT32_TOLERANCE,
      );
      close(
        `${fixture.name}.cone${Number(coneOn)}.publicUpperGap[${viewIndex}]`,
        publicAudit.branchGapMmUpper[viewIndex],
        oracle.upperBranch.gapMm,
        PUBLIC_FLOAT32_TOLERANCE,
      );
      close(
        `${fixture.name}.cone${Number(coneOn)}.publicEffectiveGap[${viewIndex}]`,
        publicAudit.gapRatios[viewIndex] * p.sliceThicknessMm,
        oracle.effectiveGapMm,
        PUBLIC_FLOAT32_TOLERANCE,
      );
      close(
        `${fixture.name}.cone${Number(coneOn)}.publicWeightSum[${viewIndex}]`,
        publicAudit.viewContributionSums[viewIndex],
        oracle.weightSum,
        PUBLIC_FLOAT32_TOLERANCE,
      );
      close(
        `${fixture.name}.cone${Number(coneOn)}.publicZMoment[${viewIndex}]`,
        publicAudit.longitudinalMomentResiduals[viewIndex],
        oracle.firstMomentMm,
        PUBLIC_FLOAT32_TOLERANCE,
      );
      close(
        `${fixture.name}.cone${Number(coneOn)}.publicKernelRms[${viewIndex}]`,
        publicAudit.viewKernelRmsMm[viewIndex],
        Math.sqrt(oracleKernelSecondMomentMm2),
        PUBLIC_FLOAT32_TOLERANCE,
      );
      assert.equal(
        publicAudit.complementaryCandidates.lowerComplementAbsoluteViewIndices[viewIndex],
        oracle.angular.lowerAbsoluteViewIndex,
        `${fixture.name}.cone${Number(coneOn)}.lowerAngularView[${viewIndex}]`,
      );
      assert.equal(
        publicAudit.complementaryCandidates.upperComplementAbsoluteViewIndices[viewIndex],
        oracle.angular.upperAbsoluteViewIndex,
        `${fixture.name}.cone${Number(coneOn)}.upperAngularView[${viewIndex}]`,
      );

      if (viewIndex % publicDiagram.markerStride === 0) {
        compareCandidateMultiset(
          `${fixture.name}.cone${Number(coneOn)}.candidates[${viewIndex}]`,
          pointsByView.get(viewIndex) ?? [],
          oracle.candidates,
        );
        auditedCandidateInstances += oracle.candidates.length;
      }
      auditedViews += 1;
    }
    const oracleMeanKernelSecondMomentMm2 = oracleKernelSecondMomentSumMm2 / p.viewSamples;
    close(
      `${fixture.name}.cone${Number(coneOn)}.meanKernelSecondMoment`,
      publicAudit.meanKernelSecondMomentMm2,
      oracleMeanKernelSecondMomentMm2,
      2e-10,
    );
    close(
      `${fixture.name}.cone${Number(coneOn)}.analyticBaseSigma`,
      publicAudit.analyticBaseSigmaMm,
      Math.sqrt(oracleMeanKernelSecondMomentMm2),
      2e-10,
    );
    // Retained legacy comparator: this identity does not validate the new
    // fixed-object Taguchi response (see taguchi-filter-oracle.mjs).
    const configured = computeLayeredSsp(p, {
      sliceKernelWidthMm: p.sliceThicknessMm,
      state: p.state,
      coneOn,
      reconstructionPath: "fan-beam-180li",
      collectGeometrySeries: true,
      collectComplementaryCandidates: false,
    });
    close(
      `${fixture.name}.cone${Number(coneOn)}.configuredVarianceIdentity`,
      configured.analyticConfiguredSigmaMm ** 2,
      oracleMeanKernelSecondMomentMm2 + p.sliceThicknessMm ** 2 / 12,
      2e-10,
    );
    assert.ok(
      Math.abs(configured.numericalSigmaResidualMm) < 1.2e-4,
      `${fixture.name}.cone${Number(coneOn)}.numericalSigmaResidualMm=${configured.numericalSigmaResidualMm}`,
    );
  }
}

// View-count contract.  This intentionally does not assert monotonic FWHM:
// changing acquired-view density changes both angular quadrature and which
// acquired neighbors straddle the ideal complementary angle.  The defensible
// invariants are exact convex weights/moments, a one-view angular bracket, and
// exact agreement at shared angles when the complementary view lies on-grid.
const viewCounts = [360, 720, 1200, 2400];
const commonAngles = 120;
let isocenterReference = null;
const convergenceDiagnostics = [];
for (const viewSamples of viewCounts) {
  const p = validateParams({
    ...DEFAULT_PARAMS,
    rows: 4,
    rowWidth: 0.5,
    beamPitch: 0.875,
    sourceRadius: 600,
    radius: 250,
    phase: 0.23,
    state: 0.371,
    sliceThicknessMm: 1,
    viewSamples,
    zSamples: 300,
    stateSamples: 24,
  });
  const publicAudit = computeSsp(p, {
    state: p.state,
    coneOn: true,
    reconstructionPath: "fan-beam-180li",
    collectGeometrySeries: true,
    collectComplementaryCandidates: false,
  });
  assert.equal(publicAudit.coverage, 1, `viewCount${viewSamples}.coverage`);
  assert.ok(publicAudit.maximumViewContributionError <= 2e-12);
  assert.ok(publicAudit.maximumAngularInterpolationWeightError <= 2e-12);
  assert.ok(publicAudit.maximumLongitudinalMomentResidualMm <= 2e-10);

  let maximumAngularBracket = 0;
  let maximumAngularMomentError = 0;
  let secondMomentSum = 0;
  for (let commonIndex = 0; commonIndex < commonAngles; commonIndex += 1) {
    const viewIndex = commonIndex * (viewSamples / commonAngles);
    assert.ok(Number.isInteger(viewIndex));
    const oracle = independent180LiAtView(p, p.state, viewIndex, true);
    maximumAngularBracket = Math.max(
      maximumAngularBracket,
      oracle.angular.upperAngle - oracle.angular.lowerAngle,
    );
    maximumAngularMomentError = Math.max(
      maximumAngularMomentError,
      Math.abs(
        oracle.lowerAngularWeight * oracle.angular.lowerAngle
          + oracle.upperAngularWeight * oracle.angular.upperAngle
          - oracle.idealComplementaryAngle
      ),
    );
    secondMomentSum += oracle.secondMomentMm2;
    close(`viewCount${viewSamples}.commonWeight[${commonIndex}]`, oracle.weightSum, 1, 2e-12);
    close(`viewCount${viewSamples}.commonMoment[${commonIndex}]`, oracle.firstMomentMm, 0, 2e-10);
  }
  assert.ok(maximumAngularBracket <= TWO_PI / viewSamples + 2e-12);
  assert.ok(maximumAngularMomentError <= 2e-12);

  const isocenter = validateParams({ ...p, radius: 0 });
  const commonCandidateSets = [];
  for (let commonIndex = 0; commonIndex < commonAngles; commonIndex += 1) {
    const viewIndex = commonIndex * (viewSamples / commonAngles);
    const oracle = independent180LiAtView(isocenter, isocenter.state, viewIndex, true);
    close(`viewCount${viewSamples}.isocenterOnGridFraction[${commonIndex}]`, oracle.angular.fraction, 0, 2e-12);
    commonCandidateSets.push(sortCandidates(oracle.candidates).map(candidate => ({
      dataKind: candidate.dataKind,
      row: candidate.row,
      turn: candidate.turn,
      delta: candidate.delta,
      weight: candidate.weight,
    })));
  }
  if (isocenterReference == null) {
    isocenterReference = commonCandidateSets;
  } else {
    for (let commonIndex = 0; commonIndex < commonAngles; commonIndex += 1) {
      compareCandidateMultiset(
        `viewCount${viewSamples}.isocenterConsistency[${commonIndex}]`,
        commonCandidateSets[commonIndex].map(candidate => ({ ...candidate, x: candidate.delta })),
        isocenterReference[commonIndex],
      );
    }
  }

  convergenceDiagnostics.push({
    viewSamples,
    maximumAngularBracketDeg: maximumAngularBracket * 180 / Math.PI,
    maximumAngularMomentErrorRad: maximumAngularMomentError,
    meanCommonAngleSecondMomentMm2: secondMomentSum / commonAngles,
    fwhmMm: publicAudit.fwhm,
    fwtmMm: publicAudit.fwtm,
  });
}

for (let index = 1; index < convergenceDiagnostics.length; index += 1) {
  assert.ok(
    convergenceDiagnostics[index].maximumAngularBracketDeg
      < convergenceDiagnostics[index - 1].maximumAngularBracketDeg,
    "the acquired angular bracket bound must shrink as the declared view grid becomes denser",
  );
}

// Persistent production-condition regression requested for the primary
// publication example.  Unlike the optimized implementation, the oracle above
// visits every one of the 160 rows over an independently derived exhaustive
// turn interval for both angular branches at all 1200 direct views.
const productionCondition = validateParams({
  ...DEFAULT_PARAMS,
  rows: 160,
  rowWidth: 0.5,
  beamPitch: 0.875,
  sourceRadius: 600,
  radius: 250,
  phase: 0,
  state: 0.5,
  sliceThicknessMm: 1,
  viewSamples: 1200,
  zSamples: 800,
  stateSamples: 360,
  reconstructionPath: "fan-beam-180li",
});
const productionConditionStart = performance.now();
const productionConditionDiagnostics = {};
const PRODUCTION_FLOAT32_TOLERANCE = 2e-7;

function compareIntegratedBranchSeries(label, series, viewIndex, branch) {
  assert.equal(series.valid[viewIndex], 1, `${label}.valid`);
  close(
    `${label}.gapMm`,
    series.gapMm[viewIndex],
    branch.gapMm,
    PRODUCTION_FLOAT32_TOLERANCE,
  );
  close(
    `${label}.lowerSignedDistanceMm`,
    series.lowerSignedDistanceMm[viewIndex],
    branch.lowerDelta,
    PRODUCTION_FLOAT32_TOLERANCE,
  );
  close(
    `${label}.upperSignedDistanceMm`,
    series.upperSignedDistanceMm[viewIndex],
    branch.upperDelta,
    PRODUCTION_FLOAT32_TOLERANCE,
  );
  close(
    `${label}.lowerWeight`,
    series.lowerWeights[viewIndex],
    branch.lowerWeight,
    PRODUCTION_FLOAT32_TOLERANCE,
  );
  close(
    `${label}.upperWeight`,
    series.upperWeights[viewIndex],
    branch.upperWeight,
    PRODUCTION_FLOAT32_TOLERANCE,
  );
  assert.equal(
    series.lowerFamilyMasks[viewIndex],
    branch.lowerFamilyMask,
    `${label}.lowerFamilyMask`,
  );
  assert.equal(
    series.upperFamilyMasks[viewIndex],
    branch.upperFamilyMask,
    `${label}.upperFamilyMask`,
  );
  assert.equal(series.lowerTieCounts[viewIndex], branch.lowerTieCount, `${label}.lowerTieCount`);
  assert.equal(series.upperTieCounts[viewIndex], branch.upperTieCount, `${label}.upperTieCount`);
  assert.equal(
    series.directExactMultiplicities[viewIndex],
    branch.directExactMultiplicity,
    `${label}.directExactMultiplicity`,
  );
  assert.equal(
    series.complementaryExactMultiplicities[viewIndex],
    branch.complementaryExactMultiplicity,
    `${label}.complementaryExactMultiplicity`,
  );
  assert.equal(
    series.exactMatchFlags[viewIndex],
    Number(branch.exactMatch),
    `${label}.exactMatch`,
  );
}

for (const coneOn of [false, true]) {
  const publicAudit = computeSsp(productionCondition, {
    state: productionCondition.state,
    coneOn,
    reconstructionPath: "fan-beam-180li",
    collectGeometrySeries: true,
    collectComplementaryCandidates: true,
  });
  assert.equal(publicAudit.coverage, 1, `production.cone${Number(coneOn)}.coverage`);
  const lowerSeries = publicAudit.complementaryCandidates
    .lowerAngularNeighborIntegratedPairs;
  const upperSeries = publicAudit.complementaryCandidates
    .upperAngularNeighborIntegratedPairs;
  let maximumRmsDifferenceMm = 0;
  let maximumEffectiveGapDifferenceMm = 0;
  let maximumBranchGapDifferenceMm = 0;
  let maximumOracleWeightError = 0;
  let maximumOracleFirstMomentMm = 0;
  let finalCandidateInstances = 0;

  for (let viewIndex = 0; viewIndex < productionCondition.viewSamples; viewIndex += 1) {
    const oracle = independent180LiAtViewExhaustiveEndpoints(
      productionCondition,
      productionCondition.state,
      viewIndex,
      coneOn,
    );
    finalCandidateInstances += oracle.candidates.length;
    assert.equal(
      publicAudit.complementaryCandidates.lowerComplementAbsoluteViewIndices[viewIndex],
      oracle.angular.lowerAbsoluteViewIndex,
      `production.cone${Number(coneOn)}.lowerAngularView[${viewIndex}]`,
    );
    assert.equal(
      publicAudit.complementaryCandidates.upperComplementAbsoluteViewIndices[viewIndex],
      oracle.angular.upperAbsoluteViewIndex,
      `production.cone${Number(coneOn)}.upperAngularView[${viewIndex}]`,
    );
    compareIntegratedBranchSeries(
      `production.cone${Number(coneOn)}.lowerBranch[${viewIndex}]`,
      lowerSeries,
      viewIndex,
      oracle.lowerBranch,
    );
    compareIntegratedBranchSeries(
      `production.cone${Number(coneOn)}.upperBranch[${viewIndex}]`,
      upperSeries,
      viewIndex,
      oracle.upperBranch,
    );
    const oracleRmsMm = Math.sqrt(oracle.secondCentralMomentMm2);
    close(
      `production.cone${Number(coneOn)}.viewRms[${viewIndex}]`,
      publicAudit.viewKernelRmsMm[viewIndex],
      oracleRmsMm,
      PRODUCTION_FLOAT32_TOLERANCE,
    );
    close(
      `production.cone${Number(coneOn)}.effectiveGap[${viewIndex}]`,
      publicAudit.gapRatios[viewIndex] * productionCondition.sliceThicknessMm,
      oracle.effectiveGapMm,
      PRODUCTION_FLOAT32_TOLERANCE,
    );
    close(
      `production.cone${Number(coneOn)}.weightSum[${viewIndex}]`,
      publicAudit.viewContributionSums[viewIndex],
      oracle.weightSum,
      PRODUCTION_FLOAT32_TOLERANCE,
    );
    close(
      `production.cone${Number(coneOn)}.firstMoment[${viewIndex}]`,
      publicAudit.longitudinalMomentResiduals[viewIndex],
      oracle.firstMomentMm,
      PRODUCTION_FLOAT32_TOLERANCE,
    );
    maximumRmsDifferenceMm = Math.max(
      maximumRmsDifferenceMm,
      Math.abs(publicAudit.viewKernelRmsMm[viewIndex] - oracleRmsMm),
    );
    maximumEffectiveGapDifferenceMm = Math.max(
      maximumEffectiveGapDifferenceMm,
      Math.abs(
        publicAudit.gapRatios[viewIndex] * productionCondition.sliceThicknessMm
          - oracle.effectiveGapMm
      ),
    );
    maximumBranchGapDifferenceMm = Math.max(
      maximumBranchGapDifferenceMm,
      Math.abs(publicAudit.branchGapMmLower[viewIndex] - oracle.lowerBranch.gapMm),
      Math.abs(publicAudit.branchGapMmUpper[viewIndex] - oracle.upperBranch.gapMm),
    );
    maximumOracleWeightError = Math.max(
      maximumOracleWeightError,
      Math.abs(1 - oracle.weightSum),
    );
    maximumOracleFirstMomentMm = Math.max(
      maximumOracleFirstMomentMm,
      Math.abs(oracle.firstMomentMm),
    );
  }
  productionConditionDiagnostics[coneOn ? "coneOn" : "coneOff"] = {
    auditedViews: productionCondition.viewSamples,
    finalCandidateInstances,
    maximumRmsDifferenceMm,
    maximumEffectiveGapDifferenceMm,
    maximumBranchGapDifferenceMm,
    maximumOracleWeightError,
    maximumOracleFirstMomentMm,
  };
}
const productionConditionRuntimeMs = performance.now() - productionConditionStart;

console.log(JSON.stringify({
  status: "PASS",
  contract: "independent-fan-beam-180li-candidate-and-weight-oracle",
  fixtures: oracleFixtures.length,
  auditedViews,
  auditedCandidateInstances,
  viewCountConsistency: {
    viewCounts,
    commonAngles,
    fwhmMonotonicityAsserted: false,
    diagnostics: convergenceDiagnostics,
  },
  productionConditionRegression: {
    params: {
      rows: productionCondition.rows,
      rowWidth: productionCondition.rowWidth,
      beamPitch: productionCondition.beamPitch,
      sourceRadius: productionCondition.sourceRadius,
      radius: productionCondition.radius,
      sliceThicknessMm: productionCondition.sliceThicknessMm,
      viewSamples: productionCondition.viewSamples,
      state: productionCondition.state,
    },
    exhaustiveRule: "all-rows-over-independent-required-turn-interval",
    publicFloat32Tolerance: PRODUCTION_FLOAT32_TOLERANCE,
    runtimeMs: productionConditionRuntimeMs,
    diagnostics: productionConditionDiagnostics,
  },
}, null, 2));
