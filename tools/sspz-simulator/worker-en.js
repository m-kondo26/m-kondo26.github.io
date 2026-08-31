"use strict";
const MODEL_VERSION = "2026-08-28.2";

const PROFILE_MODES = Object.freeze({
  LAYERED_RECT: "layered-rect",
  DIRECT_TRIANGULAR: "direct-triangular",
});

const RECONSTRUCTION_PATHS = Object.freeze({
  FAN_BEAM_180LI: "fan-beam-180li",
  DIRECT_FULL_SCAN: "direct-full-scan",
});

const DEFAULT_PARAMS = Object.freeze({
  rows: 4,
  rowWidth: 1.0,
  beamPitch: 0.875,
  sourceRadius: 600.0,
  radius: 100.0,
  zReference: 0.0,
  state: 0.0,
  sliceThicknessMm: 1.0,
  profileMode: PROFILE_MODES.LAYERED_RECT,
  reconstructionPath: RECONSTRUCTION_PATHS.FAN_BEAM_180LI,
  viewSamples: 360,
  zSamples: 800,
  stateSamples: 360,
  phase: 0.0,
});

const EPS = 1e-12;
const PI2 = 2 * Math.PI;
const RAD_TO_DEG = 180 / Math.PI;
const PHYSICAL_CANDIDATE_IDENTITY_TOLERANCE_MM = 1e-9;
const MAX_CONFIGURED_SLICE_THICKNESS_MM = 20;
// Internal longitudinal sampling is allowed to exceed the public selector.
// The odd cap keeps z=0 at a cell center while bounding memory use for the
// narrowest supported detector rows and the widest helical gaps.
const MAX_INTERNAL_Z_CELLS = 65535;

function validateParams(input) {
  const p = {
    rows: Math.round(Number(input.rows)),
    rowWidth: Number(input.rowWidth),
    beamPitch: Number(input.beamPitch),
    sourceRadius: Number(input.sourceRadius),
    radius: Math.abs(Number(input.radius)),
    // These remain internal model coordinates. The public UI evaluates all
    // relative states automatically and no longer asks the user to set them.
    zReference: Number(input.zReference ?? 0),
    state: Number(input.state ?? 0),
    // targetFwhm is accepted only as an old saved-input migration path.
    // It no longer means that the computed FWHM is fitted to this value.
    sliceThicknessMm: Number(input.sliceThicknessMm ?? input.targetFwhm),
    // Legacy direct-triangular URLs are migrated to the single transparent
    // reference model: nearest bracketing interpolation followed by the
    // declared configured-thickness window.
    profileMode: PROFILE_MODES.LAYERED_RECT,
    reconstructionPath: Object.values(RECONSTRUCTION_PATHS).includes(input.reconstructionPath)
      ? input.reconstructionPath
      : RECONSTRUCTION_PATHS.FAN_BEAM_180LI,
    // thetaSamples is accepted only for migration from pre-full-scan URLs and
    // saved settings.  viewSamples always spans one complete 0-360 degree turn.
    viewSamples: Math.round(Number(input.viewSamples ?? input.thetaSamples)),
    zSamples: Math.round(Number(input.zSamples)),
    stateSamples: Math.round(Number(input.stateSamples)),
    phase: Number(input.phase ?? 0),
  };
  const finite = Object.entries(p).filter(([, value]) => typeof value === "number" && !Number.isFinite(value));
  if (finite.length) throw new Error(`The following inputs could not be parsed as numbers: ${finite.map(([key]) => key).join(", ")}`);
  if (p.rows < 1 || p.rows > 320) throw new Error("Set the number of detector rows to a value from 1 to 320.");
  if (p.rowWidth <= 0 || p.rowWidth > 10) throw new Error("Set the single-row width to a value greater than 0 and no greater than 10 mm.");
  if (p.beamPitch <= 0 || p.beamPitch > 3) throw new Error("Set the beam pitch to a value greater than 0 and no greater than 3.");
  if (p.sourceRadius <= 0) throw new Error("The source-to-isocenter distance must be positive.");
  if (p.radius > 250) throw new Error("Set the radial distance from isocenter to a value from 0 to 250 mm.");
  if (p.radius >= p.sourceRadius) throw new Error("The radial distance from isocenter must be smaller than the source-to-isocenter distance.");
  if (p.sliceThicknessMm <= 0 || p.sliceThicknessMm > 20) throw new Error("Set the configured slice thickness to a value greater than 0 and no greater than 20 mm.");
  if (p.viewSamples < 90 || p.viewSamples > 2400) throw new Error("Set the number of relative tube-angle samples per rotation to a value from 90 to 2400.");
  if (p.zSamples < 300 || p.zSamples > 4000) throw new Error("Set the SSPz grid size to a value from 300 to 4000.");
  if (p.stateSamples < 12 || p.stateSamples > 720) throw new Error("Set the number of model states to a value from 12 to 720.");
  p.state = ((p.state % 1) + 1) % 1;
  return p;
}

function tableFeedMm(p) {
  return p.beamPitch * p.rows * p.rowWidth;
}

function linspace(start, stop, count) {
  const out = new Float64Array(count);
  const step = (stop - start) / Math.max(1, count - 1);
  for (let i = 0; i < count; i += 1) out[i] = start + step * i;
  return out;
}

function uniformCellCenters(leftEdge, rightEdge, count) {
  const out = new Float64Array(count);
  const width = (rightEdge - leftEdge) / count;
  for (let i = 0; i < count; i += 1) out[i] = leftEdge + (i + 0.5) * width;
  return out;
}

function oddCellCountAtLeast(requested, cap = MAX_INTERNAL_Z_CELLS) {
  let count = Math.max(1, Math.ceil(requested));
  if (count % 2 === 0) count += 1;
  if (count > cap) count = cap % 2 === 1 ? cap : cap - 1;
  return count;
}

function depositRectangleIntoUniformCellAverages(
  fullCellDiff,
  edgeCellContributions,
  left,
  right,
  amplitude,
  domainLeft,
  domainRight,
  dz,
) {
  const clippedLeft = Math.max(domainLeft, left);
  const clippedRight = Math.min(domainRight, right);
  if (!(clippedRight > clippedLeft) || !(amplitude > 0)) return 0;

  const cellCount = edgeCellContributions.length;
  const first = Math.max(0, Math.min(
    cellCount - 1,
    Math.floor((clippedLeft - domainLeft) / dz),
  ));
  const last = Math.max(0, Math.min(
    cellCount - 1,
    Math.floor((clippedRight - domainLeft) / dz),
  ));

  const overlapWithCell = (index) => {
    const cellLeft = domainLeft + index * dz;
    const cellRight = cellLeft + dz;
    return Math.max(0, Math.min(clippedRight, cellRight) - Math.max(clippedLeft, cellLeft));
  };

  if (first === last) {
    edgeCellContributions[first] += amplitude * overlapWithCell(first) / dz;
  } else {
    edgeCellContributions[first] += amplitude * overlapWithCell(first) / dz;
    edgeCellContributions[last] += amplitude * overlapWithCell(last) / dz;
    // Every cell strictly between the two boundary cells is covered in full.
    if (last > first + 1) {
      fullCellDiff[first + 1] += amplitude;
      fullCellDiff[last] -= amplitude;
    }
  }
  return amplitude * (clippedRight - clippedLeft);
}

function roundHalfEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (Math.abs(fraction - 0.5) < 1e-12) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

function wrapAngleRad(angle) {
  return ((angle % PI2) + PI2) % PI2;
}

function fanBeamComplementaryGeometryAtAngle(p, beta, coneOn) {
  const betaNormalized = wrapAngleRad(beta);
  if (!coneOn || p.radius <= EPS) {
    return {
      betaRad: betaNormalized,
      complementaryAngleRad: wrapAngleRad(betaNormalized + Math.PI),
      complementaryAngleUnwrappedRad: beta + Math.PI,
      forwardSeparationRad: Math.PI,
      fanAngleRad: 0,
      secondIntersectionParameter: 2,
      lineCircleResidualMm: 0,
    };
  }

  // Transaxial fan-beam geometry.  The source S(beta) and evaluation point P
  // define one ray.  Extending that ray to the second intersection with the
  // source orbit gives the complementary source angle without depending on a
  // fan-angle sign convention.  Its forward angular separation is equivalent
  // to pi + 2*gamma for the gamma convention returned below.
  const sourceX = p.sourceRadius * Math.cos(betaNormalized);
  const sourceY = p.sourceRadius * Math.sin(betaNormalized);
  const pointX = p.radius * Math.cos(p.phase);
  const pointY = p.radius * Math.sin(p.phase);
  const directionX = pointX - sourceX;
  const directionY = pointY - sourceY;
  const directionSquared = directionX * directionX + directionY * directionY;
  const secondIntersectionParameter = -2 * (sourceX * directionX + sourceY * directionY)
    / Math.max(directionSquared, EPS);
  const complementaryX = sourceX + secondIntersectionParameter * directionX;
  const complementaryY = sourceY + secondIntersectionParameter * directionY;
  const complementaryAngleRad = wrapAngleRad(Math.atan2(complementaryY, complementaryX));
  let forwardSeparationRad = wrapAngleRad(complementaryAngleRad - betaNormalized);
  if (forwardSeparationRad <= EPS) forwardSeparationRad = PI2;
  const complementaryAngleUnwrappedRad = beta + forwardSeparationRad;
  const fanAngleRad = (forwardSeparationRad - Math.PI) / 2;
  const lineCircleResidualMm = Math.abs(
    Math.hypot(complementaryX, complementaryY) - p.sourceRadius,
  );
  return {
    betaRad: betaNormalized,
    complementaryAngleRad,
    complementaryAngleUnwrappedRad,
    forwardSeparationRad,
    fanAngleRad,
    secondIntersectionParameter,
    lineCircleResidualMm,
  };
}

function computeFanBeamComplementaryGeometry(rawParams, beta, options = {}) {
  const p = validateParams(rawParams);
  return fanBeamComplementaryGeometryAtAngle(p, Number(beta), options.coneOn !== false);
}

function acquiredViewMapping(p, idealAngleUnwrappedRad) {
  const stepRad = PI2 / p.viewSamples;
  const idealAbsoluteView = idealAngleUnwrappedRad / stepRad;
  const nearestAbsoluteViewIndex = Math.round(idealAbsoluteView);
  const lowerAbsoluteViewIndex = Math.floor(idealAbsoluteView + 1e-12);
  const upperAbsoluteViewIndex = Math.ceil(idealAbsoluteView - 1e-12);
  const wrapViewIndex = index => ((index % p.viewSamples) + p.viewSamples) % p.viewSamples;
  const nearestAngleUnwrappedRad = nearestAbsoluteViewIndex * stepRad;
  const lowerAngleUnwrappedRad = lowerAbsoluteViewIndex * stepRad;
  const upperAngleUnwrappedRad = upperAbsoluteViewIndex * stepRad;
  const angularBracketWidthRad = upperAngleUnwrappedRad - lowerAngleUnwrappedRad;
  const angularInterpolationFraction = angularBracketWidthRad <= EPS
    ? 0
    : (idealAngleUnwrappedRad - lowerAngleUnwrappedRad) / angularBracketWidthRad;
  return {
    stepRad,
    nearestViewIndex: wrapViewIndex(nearestAbsoluteViewIndex),
    nearestAbsoluteViewIndex,
    nearestAngleRad: wrapAngleRad(nearestAngleUnwrappedRad),
    nearestAngleUnwrappedRad,
    angularResidualRad: nearestAngleUnwrappedRad - idealAngleUnwrappedRad,
    lowerViewIndex: wrapViewIndex(lowerAbsoluteViewIndex),
    lowerAbsoluteViewIndex,
    lowerAngleUnwrappedRad,
    upperViewIndex: wrapViewIndex(upperAbsoluteViewIndex),
    upperAbsoluteViewIndex,
    upperAngleUnwrappedRad,
    lowerAngularResidualRad: lowerAngleUnwrappedRad - idealAngleUnwrappedRad,
    upperAngularResidualRad: upperAngleUnwrappedRad - idealAngleUnwrappedRad,
    angularInterpolationFraction,
  };
}

function allCandidateAxialFamilySummary(p, absoluteViewIndex, coneOn, roles) {
  const feed = tableFeedMm(p);
  const angleRad = PI2 * absoluteViewIndex / p.viewSamples;
  const rho = p.radius / p.sourceRadius;
  const scale = coneOn
    ? Math.sqrt(Math.max(EPS, 1 + rho * rho - 2 * rho * Math.cos(angleRad - p.phase)))
    : 1;
  const meanAxialPositionMm = feed * absoluteViewIndex / p.viewSamples;
  const rowHalfSpanMm = scale * p.rowWidth * (p.rows - 1) / 2;
  // Population variance of N equally spaced detector-row centres about their
  // own mean.  This is an acquisition-geometry quantity: no reconstruction
  // weights, slice-thickness window, or nearest-row selection enters here.
  const withinFamilyVarianceMm2 = scale * scale * p.rowWidth * p.rowWidth
    * (p.rows * p.rows - 1) / 12;
  return {
    roles,
    absoluteViewIndex,
    angleRad,
    angleDeg: angleRad * RAD_TO_DEG,
    scale,
    rowCount: p.rows,
    meanAxialPositionMm,
    withinFamilyVarianceMm2,
    minimumAxialPositionMm: meanAxialPositionMm - rowHalfSpanMm,
    maximumAxialPositionMm: meanAxialPositionMm + rowHalfSpanMm,
  };
}

function allCandidateAxialSpreadAtValidatedView(p, directViewIndexInput, options = {}) {
  const directViewIndexNumber = Number(directViewIndexInput);
  if (!Number.isInteger(directViewIndexNumber)) {
    throw new Error("The direct-view index must be an integer.");
  }
  const commonTurnShift = Number(options.commonTurnShift ?? 0);
  if (!Number.isInteger(commonTurnShift)) {
    throw new Error("The whole-rotation offset common to all candidates must be an integer.");
  }
  const coneOn = options.coneOn !== false;
  const directViewIndex = (
    (directViewIndexNumber % p.viewSamples) + p.viewSamples
  ) % p.viewSamples;
  const beta = PI2 * directViewIndex / p.viewSamples;
  const complementary = fanBeamComplementaryGeometryAtAngle(p, beta, coneOn);
  const viewStepRad = PI2 / p.viewSamples;
  const idealComplementaryAbsoluteView
    = complementary.complementaryAngleUnwrappedRad / viewStepRad;
  // Only the two acquired angular neighbours that bracket the ideal
  // complementary angle are required.  Do not compute or select a nearest
  // acquired view in this pure all-row population.
  const lowerComplementaryAbsoluteViewIndex = Math.floor(
    idealComplementaryAbsoluteView + 1e-12,
  );
  const upperComplementaryAbsoluteViewIndex = Math.ceil(
    idealComplementaryAbsoluteView - 1e-12,
  );
  const turnDelta = commonTurnShift * p.viewSamples;
  const requestedFamilies = [
    { role: "direct", absoluteViewIndex: directViewIndex + turnDelta },
    {
      role: "complementary-lower",
      absoluteViewIndex: lowerComplementaryAbsoluteViewIndex + turnDelta,
    },
    {
      role: "complementary-upper",
      absoluteViewIndex: upperComplementaryAbsoluteViewIndex + turnDelta,
    },
  ];
  // One physical acquired detector row is identified by absolute view index
  // and row.  If the ideal complementary angle is itself acquired, lower and
  // upper are the same view and must appear only once in the population.
  const uniqueViews = new Map();
  for (const requested of requestedFamilies) {
    const existing = uniqueViews.get(requested.absoluteViewIndex);
    if (existing) existing.roles.push(requested.role);
    else uniqueViews.set(requested.absoluteViewIndex, {
      absoluteViewIndex: requested.absoluteViewIndex,
      roles: [requested.role],
    });
  }
  const families = [...uniqueViews.values()].map(family => allCandidateAxialFamilySummary(
    p,
    family.absoluteViewIndex,
    coneOn,
    family.roles,
  ));
  const familyCount = families.length;
  const meanAxialPositionMm = families.reduce(
    (sum, family) => sum + family.meanAxialPositionMm,
    0,
  ) / familyCount;
  const withinFamilyVarianceMm2 = families.reduce(
    (sum, family) => sum + family.withinFamilyVarianceMm2,
    0,
  ) / familyCount;
  const betweenFamilyVarianceMm2 = families.reduce(
    (sum, family) => sum + (family.meanAxialPositionMm - meanAxialPositionMm) ** 2,
    0,
  ) / familyCount;
  const populationVarianceMm2 = withinFamilyVarianceMm2 + betweenFamilyVarianceMm2;
  const minimumAxialPositionMm = Math.min(
    ...families.map(family => family.minimumAxialPositionMm),
  );
  const maximumAxialPositionMm = Math.max(
    ...families.map(family => family.maximumAxialPositionMm),
  );
  const populationStdDevMm = Math.sqrt(Math.max(0, populationVarianceMm2));
  return {
    definition: "all-acquired-detector-row-centres-from-direct-and-angularly-bracketing-complementary-views",
    candidateIdentity: "absoluteViewIndex,row",
    weighting: "none-equal-unit-mass-per-physical-acquired-row",
    reconstructionCandidateSelection: "none",
    coneOn,
    directViewIndex,
    directAbsoluteViewIndex: directViewIndex + turnDelta,
    directAngleRad: beta,
    directAngleDeg: beta * RAD_TO_DEG,
    idealComplementaryAngleUnwrappedRad: complementary.complementaryAngleUnwrappedRad
      + commonTurnShift * PI2,
    idealComplementaryAngleUnwrappedDeg: complementary.complementaryAngleUnwrappedRad * RAD_TO_DEG
      + commonTurnShift * 360,
    commonTurnShift,
    uniqueAcquiredViewCount: familyCount,
    candidateCount: p.rows * familyCount,
    families,
    meanAxialPositionMm,
    withinFamilyVarianceMm2,
    betweenFamilyVarianceMm2,
    populationVarianceMm2,
    populationStdDevMm,
    // Short alias retained for worker/plot contracts; both names denote the
    // same unweighted finite-population standard deviation in millimetres.
    populationStdMm: populationStdDevMm,
    minimumAxialPositionMm,
    maximumAxialPositionMm,
    rangeMm: maximumAxialPositionMm - minimumAxialPositionMm,
  };
}

/**
 * Pure acquisition-geometry spread for one direct projection view.
 *
 * The finite population contains every detector-row centre from the direct
 * acquired view and from the distinct acquired lower/upper views that bracket
 * its ideal complementary fan-beam angle.  It deliberately does not use the
 * configured slice thickness, reconstruction weights, or nearest candidates.
 */
function computeAllCandidateAxialSpreadAtView(rawParams, directViewIndex, options = {}) {
  const p = validateParams(rawParams);
  return allCandidateAxialSpreadAtValidatedView(p, directViewIndex, options);
}

/** Return the pure acquisition-geometry spread for every direct view. */
function computeAllCandidateAxialSpreadSeries(rawParams, options = {}) {
  const p = validateParams(rawParams);
  const count = p.viewSamples;
  const directAnglesDeg = new Float64Array(count);
  const idealComplementaryAnglesUnwrappedDeg = new Float64Array(count);
  const uniqueAcquiredViewCounts = new Uint8Array(count);
  const candidateCounts = new Uint16Array(count);
  const meanAxialPositionsMm = new Float64Array(count);
  const withinFamilyVariancesMm2 = new Float64Array(count);
  const betweenFamilyVariancesMm2 = new Float64Array(count);
  const populationVariancesMm2 = new Float64Array(count);
  const populationStdDevMm = new Float64Array(count);
  const minimumAxialPositionsMm = new Float64Array(count);
  const maximumAxialPositionsMm = new Float64Array(count);
  const rangesMm = new Float64Array(count);
  for (let directViewIndex = 0; directViewIndex < count; directViewIndex += 1) {
    const spread = allCandidateAxialSpreadAtValidatedView(p, directViewIndex, options);
    directAnglesDeg[directViewIndex] = spread.directAngleDeg;
    idealComplementaryAnglesUnwrappedDeg[directViewIndex]
      = spread.idealComplementaryAngleUnwrappedDeg;
    uniqueAcquiredViewCounts[directViewIndex] = spread.uniqueAcquiredViewCount;
    candidateCounts[directViewIndex] = spread.candidateCount;
    meanAxialPositionsMm[directViewIndex] = spread.meanAxialPositionMm;
    withinFamilyVariancesMm2[directViewIndex] = spread.withinFamilyVarianceMm2;
    betweenFamilyVariancesMm2[directViewIndex] = spread.betweenFamilyVarianceMm2;
    populationVariancesMm2[directViewIndex] = spread.populationVarianceMm2;
    populationStdDevMm[directViewIndex] = spread.populationStdDevMm;
    minimumAxialPositionsMm[directViewIndex] = spread.minimumAxialPositionMm;
    maximumAxialPositionsMm[directViewIndex] = spread.maximumAxialPositionMm;
    rangesMm[directViewIndex] = spread.rangeMm;
  }
  return {
    definition: "all-acquired-detector-row-centres-from-direct-and-angularly-bracketing-complementary-views",
    candidateIdentity: "absoluteViewIndex,row",
    weighting: "none-equal-unit-mass-per-physical-acquired-row",
    reconstructionCandidateSelection: "none",
    coneOn: options.coneOn !== false,
    viewCount: count,
    viewStepDeg: 360 / count,
    commonTurnShift: Number(options.commonTurnShift ?? 0),
    directAnglesDeg,
    idealComplementaryAnglesUnwrappedDeg,
    uniqueAcquiredViewCounts,
    candidateCounts,
    meanAxialPositionsMm,
    withinFamilyVariancesMm2,
    betweenFamilyVariancesMm2,
    populationVariancesMm2,
    populationStdDevMm,
    populationStdMm: populationStdDevMm,
    minimumAxialPositionsMm,
    maximumAxialPositionsMm,
    rangesMm,
  };
}

function profileWidth(profile, z, level) {
  let peak = 0;
  for (let i = 1; i < profile.length; i += 1) if (profile[i] > profile[peak]) peak = i;
  const above = new Uint8Array(profile.length);
  for (let i = 0; i < profile.length; i += 1) above[i] = profile[i] >= level ? 1 : 0;
  const components = [];
  let start = -1;
  for (let i = 0; i < above.length; i += 1) {
    if (above[i] && start < 0) start = i;
    if (start >= 0 && (!above[i] || i === above.length - 1)) {
      const end = above[i] && i === above.length - 1 ? i : i - 1;
      components.push([start, end]);
      start = -1;
    }
  }
  if (!components.length) return { width: 0, components: 0 };
  let component = components.find(([left, right]) => left <= peak && peak <= right);
  if (!component) component = components.reduce((best, item) => item[1] - item[0] > best[1] - best[0] ? item : best);
  const [leftIndex, rightIndex] = component;
  let left = z[0];
  if (leftIndex > 0) {
    const y0 = profile[leftIndex - 1];
    const y1 = profile[leftIndex];
    const fraction = Math.abs(y1 - y0) < 1e-15 ? 0 : (level - y0) / (y1 - y0);
    left = z[leftIndex - 1] + fraction * (z[leftIndex] - z[leftIndex - 1]);
  }
  let right = z[z.length - 1];
  if (rightIndex < profile.length - 1) {
    const y0 = profile[rightIndex];
    const y1 = profile[rightIndex + 1];
    const fraction = Math.abs(y1 - y0) < 1e-15 ? 0 : (level - y0) / (y1 - y0);
    right = z[rightIndex] + fraction * (z[rightIndex + 1] - z[rightIndex]);
  }
  return { width: Math.max(0, right - left), components: components.length };
}

function profileStats(profile, z, dz) {
  let peak = 0;
  for (const value of profile) peak = Math.max(peak, value);
  if (peak <= 0) return { fwhm: 0, fwtm: 0, sigma: 0, area: 0, centroid: 0, halfComponents: 0 };
  let area = 0;
  let first = 0;
  for (let i = 0; i < profile.length; i += 1) {
    area += profile[i] * dz;
    first += z[i] * profile[i] * dz;
  }
  const centroid = area > EPS ? first / area : 0;
  let variance = 0;
  if (area > EPS) {
    for (let i = 0; i < profile.length; i += 1) variance += (z[i] - centroid) ** 2 * profile[i] * dz / area;
  }
  const half = profileWidth(profile, z, 0.5);
  const tenth = profileWidth(profile, z, 0.1);
  return {
    fwhm: half.width,
    fwtm: tenth.width,
    sigma: Math.sqrt(Math.max(0, variance)),
    area,
    centroid,
    halfComponents: half.components,
  };
}

function geometryAtFullScanAngle(p, z0, beta, coneOn, metadata = {}) {
  const feed = tableFeedMm(p);
  const slope = feed / PI2;
  const rho = p.radius / p.sourceRadius;
  const scale = coneOn
    ? Math.sqrt(Math.max(EPS, 1 + rho * rho - 2 * rho * Math.cos(beta - p.phase)))
    : 1;
  const rowSpacing = p.rowWidth * scale;
  const firstBaseCenter = slope * beta + (0.5 - p.rows / 2) * rowSpacing;
  const lastBaseCenter = firstBaseCenter + (p.rows - 1) * rowSpacing;
  const exact = [];
  let lowerDelta = -Infinity;
  let upperDelta = Infinity;
  let lower = [];
  let upper = [];
  // Candidate centers form a regular row/turn lattice.  The closest point on
  // either side of z0 must lie within one table feed of z0; therefore only the
  // few turns whose row bands intersect that interval need inspection.  This
  // is numerically identical to scanning every row and its two nearest turns,
  // but its cost is independent of the entered detector-row count.
  const turnMin = Math.floor((z0 - feed - lastBaseCenter) / feed) - 1;
  const turnMax = Math.ceil((z0 + feed - firstBaseCenter) / feed) + 1;
  for (let turn = turnMin; turn <= turnMax; turn += 1) {
    const rowCoordinate = (z0 - firstBaseCenter - turn * feed) / rowSpacing;
    const rowCandidates = [
      Math.max(0, Math.min(p.rows - 1, Math.floor(rowCoordinate))),
      Math.max(0, Math.min(p.rows - 1, Math.ceil(rowCoordinate))),
    ];
    for (let rowCandidateIndex = 0; rowCandidateIndex < rowCandidates.length; rowCandidateIndex += 1) {
      const row = rowCandidates[rowCandidateIndex];
      if (rowCandidateIndex > 0 && row === rowCandidates[0]) continue;
      const center = firstBaseCenter + row * rowSpacing + turn * feed;
      const delta = center - z0;
      const candidate = {
        dataKind: metadata.dataKind ?? "actual",
        family: metadata.family ?? null,
        row,
        turn,
        beta,
        angleUnwrappedRad: beta + turn * PI2,
        absoluteViewIndex: metadata.baseAbsoluteViewIndex == null
          ? null
          : metadata.baseAbsoluteViewIndex + turn * p.viewSamples,
        center,
        delta,
        aperture: p.rowWidth * scale,
        rawWeight: 0,
        weight: 0,
      };
      if (Math.abs(delta) <= 1e-10) {
        exact.push(candidate);
      } else if (delta < 0) {
        if (delta > lowerDelta + 1e-10) {
          lowerDelta = delta;
          lower = [candidate];
        } else if (Math.abs(delta - lowerDelta) <= 1e-10) {
          lower.push(candidate);
        }
      } else if (delta < upperDelta - 1e-10) {
        upperDelta = delta;
        upper = [candidate];
      } else if (Math.abs(delta - upperDelta) <= 1e-10) {
        upper.push(candidate);
      }
    }
  }
  let candidates = [];
  let bracketGapMm = NaN;
  let exactMatch = false;
  if (exact.length) {
    exactMatch = true;
    const weight = 1 / exact.length;
    candidates = exact.map(candidate => ({ ...candidate, rawWeight: weight, weight }));
    bracketGapMm = 0;
  } else if (lower.length && upper.length) {
    bracketGapMm = upperDelta - lowerDelta;
    const totalLowerWeight = upperDelta / bracketGapMm;
    const totalUpperWeight = -lowerDelta / bracketGapMm;
    candidates = [
      ...lower.map(candidate => ({ ...candidate, rawWeight: totalLowerWeight / lower.length, weight: totalLowerWeight / lower.length })),
      ...upper.map(candidate => ({ ...candidate, rawWeight: totalUpperWeight / upper.length, weight: totalUpperWeight / upper.length })),
    ];
  }
  const normalizedWeightSum = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  return {
    beta,
    scale,
    candidates,
    rawWeightSum: normalizedWeightSum,
    normalizedWeightSum,
    bracketGapMm,
    bracketGapRatio: bracketGapMm / p.sliceThicknessMm,
    exactMatch,
    exactCandidate: exact[0] ?? null,
    lowerCandidate: lower[0] ?? null,
    upperCandidate: upper[0] ?? null,
    exactCandidateCount: exact.length,
    lowerCandidateCount: lower.length,
    upperCandidateCount: upper.length,
    lowerDistanceMm: Number.isFinite(lowerDelta) ? -lowerDelta : 0,
    upperDistanceMm: Number.isFinite(upperDelta) ? upperDelta : 0,
    family: metadata.family ?? null,
    baseAbsoluteViewIndex: metadata.baseAbsoluteViewIndex ?? null,
    valid: candidates.length > 0 && Math.abs(normalizedWeightSum - 1) <= 1e-9,
  };
}

function nearestCandidateDistanceMm(geometry) {
  if (geometry.exactMatch) return 0;
  const distances = [geometry.lowerDistanceMm, geometry.upperDistanceMm]
    .filter(value => Number.isFinite(value) && value >= 0);
  return distances.length ? Math.min(...distances) : NaN;
}

function pairEndpoint(geometry, family, side) {
  const candidate = geometry.exactMatch
    ? geometry.exactCandidate
    : (side === "lower" ? geometry.lowerCandidate : geometry.upperCandidate);
  if (!candidate) return null;
  return {
    family,
    side: geometry.exactMatch ? "exact" : side,
    signedDistanceMm: geometry.exactMatch ? 0 : candidate.delta,
    distanceMm: geometry.exactMatch ? 0 : Math.abs(candidate.delta),
    row: candidate.row,
    turn: candidate.turn,
    pairTurn: candidate.turn,
    angleUnwrappedRad: candidate.angleUnwrappedRad ?? (candidate.beta + candidate.turn * PI2),
    absoluteViewIndex: candidate.absoluteViewIndex ?? null,
  };
}

function crossFamilyPair(lower, upper) {
  if (!lower || !upper) return null;
  const direct = lower.family === "direct" ? lower : upper;
  const complementary = lower.family === "complementary" ? lower : upper;
  const gapMm = Math.max(0, upper.signedDistanceMm - lower.signedDistanceMm);
  const directWeight = gapMm <= EPS ? 0.5 : complementary.distanceMm / gapMm;
  const complementaryWeight = gapMm <= EPS ? 0.5 : direct.distanceMm / gapMm;
  return {
    lower,
    upper,
    gapMm,
    directDistanceMm: direct.distanceMm,
    complementaryDistanceMm: complementary.distanceMm,
    directWeight,
    complementaryWeight,
    lowerWeight: gapMm <= EPS ? 0.5 : upper.distanceMm / gapMm,
    upperWeight: gapMm <= EPS ? 0.5 : lower.distanceMm / gapMm,
    valid: Number.isFinite(gapMm)
      && lower.signedDistanceMm <= EPS
      && upper.signedDistanceMm >= -EPS
      && Math.abs(directWeight + complementaryWeight - 1) <= 1e-9,
  };
}

const INTEGRATED_PAIR_TYPES = Object.freeze({
  DD: 0,
  DC: 1,
  DB: 2,
  CD: 3,
  CC: 4,
  CB: 5,
  BD: 6,
  BC: 7,
  BB: 8,
  D0: 9,
  C0: 10,
  B0: 11,
});

function familyAtBaseAngle(p, baseAngleUnwrappedRad, coneOn, family, baseAbsoluteViewIndex = null) {
  const feed = tableFeedMm(p);
  const slope = feed / PI2;
  const rho = p.radius / p.sourceRadius;
  const scale = coneOn
    ? Math.sqrt(Math.max(EPS, 1 + rho * rho - 2 * rho * Math.cos(baseAngleUnwrappedRad - p.phase)))
    : 1;
  const centers = new Float64Array(p.rows);
  for (let row = 0; row < p.rows; row += 1) {
    const rowOffset = (row + 0.5 - p.rows / 2) * p.rowWidth;
    centers[row] = slope * baseAngleUnwrappedRad + scale * rowOffset;
  }
  return {
    family,
    baseAngleUnwrappedRad,
    baseAbsoluteViewIndex,
    centers,
    scale,
    minimumCenterMm: centers[0],
    maximumCenterMm: centers[centers.length - 1],
  };
}

function firstCenterAtOrAbove(centers, threshold) {
  let low = 0;
  let high = centers.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (centers[middle] < threshold - 1e-10) low = middle + 1;
    else high = middle;
  }
  return low;
}

function endpointAtPairTurn(p, z0, familyGeometry, row, pairTurn, familyTurnOffset, side) {
  const familyTurn = pairTurn + familyTurnOffset;
  const center = familyGeometry.centers[row] + familyTurn * tableFeedMm(p);
  const deltaRaw = center - z0;
  const delta = Math.abs(deltaRaw) <= 1e-10 ? 0 : deltaRaw;
  return {
    family: familyGeometry.family,
    side: delta === 0 ? "exact" : side,
    signedDistanceMm: delta,
    distanceMm: Math.abs(delta),
    row,
    turn: familyTurn,
    pairTurn,
    angleUnwrappedRad: familyGeometry.baseAngleUnwrappedRad + familyTurn * PI2,
    absoluteViewIndex: familyGeometry.baseAbsoluteViewIndex == null
      ? null
      : familyGeometry.baseAbsoluteViewIndex + familyTurn * p.viewSamples,
  };
}

function adjacentCrossPair(p, z0, lowerFamily, upperFamily, upperTurnOffset) {
  const feed = tableFeedMm(p);
  let best = null;
  let validPairCount = 0;
  let tieCount = 0;
  for (let lowerRow = 0; lowerRow < p.rows; lowerRow += 1) {
    // For a given lower-side row, only its closest turn at or below z0 can
    // minimize the pair span.  This avoids any fixed turn-search radius while
    // preserving the absolute helical ordering of the paired views.
    const pairTurn = Math.floor((z0 - lowerFamily.centers[lowerRow]) / feed + 1e-10);
    const lower = endpointAtPairTurn(p, z0, lowerFamily, lowerRow, pairTurn, 0, "lower");
    if (lower.signedDistanceMm > 1e-9) continue;
    const upperThresholdAtBase = z0 - (pairTurn + upperTurnOffset) * feed;
    const upperRow = firstCenterAtOrAbove(upperFamily.centers, upperThresholdAtBase);
    if (upperRow >= p.rows) continue;
    const upper = endpointAtPairTurn(p, z0, upperFamily, upperRow, pairTurn, upperTurnOffset, "upper");
    if (upper.signedDistanceMm < -1e-9) continue;
    const pair = crossFamilyPair(lower, upper);
    if (!pair?.valid) continue;
    validPairCount += 1;
    pair.pairTurn = pairTurn;
    const better = !best
      || pair.gapMm < best.gapMm - 1e-10
      || (Math.abs(pair.gapMm - best.gapMm) <= 1e-10
        && (pair.lower.distanceMm < best.lower.distanceMm - 1e-10
          || (Math.abs(pair.lower.distanceMm - best.lower.distanceMm) <= 1e-10
            && (pair.lower.row < best.lower.row
              || (pair.lower.row === best.lower.row && pair.upper.row < best.upper.row)))));
    if (better) {
      best = pair;
      tieCount = 1;
    } else if (best && Math.abs(pair.gapMm - best.gapMm) <= 1e-10) {
      tieCount += 1;
    }
  }
  if (best) {
    best.validPairCount = validPairCount;
    best.tieCount = tieCount;
  }
  return best;
}

function minimumBracketWithinAbsoluteViewPair(
  p,
  z0,
  firstFamily,
  secondFamily,
  secondTurnOffset,
) {
  // Acquisition order and longitudinal order are independent.  For example,
  // D_n is acquired before C_n, but either family may provide the smaller-z
  // endpoint.  Search both z orientations within the same absolute-view pair.
  const orientations = [
    {
      label: `${firstFamily.family}-lower-${secondFamily.family}-upper`,
      pair: adjacentCrossPair(p, z0, firstFamily, secondFamily, secondTurnOffset),
    },
    {
      label: `${secondFamily.family}-lower-${firstFamily.family}-upper`,
      pair: adjacentCrossPair(p, z0, secondFamily, firstFamily, -secondTurnOffset),
    },
  ];
  let best = null;
  let directionTieCount = 0;
  for (const orientation of orientations) {
    const pair = orientation.pair;
    if (!pair?.valid) continue;
    const better = !best
      || pair.gapMm < best.gapMm - 1e-10
      || (Math.abs(pair.gapMm - best.gapMm) <= 1e-10
        && (pair.lower.distanceMm < best.lower.distanceMm - 1e-10
          || (Math.abs(pair.lower.distanceMm - best.lower.distanceMm) <= 1e-10
            && orientation.label < best.zOrientation)));
    if (better) {
      best = pair;
      best.zOrientation = orientation.label;
      directionTieCount = 1;
    } else if (best && Math.abs(pair.gapMm - best.gapMm) <= 1e-10) {
      directionTieCount += 1;
    }
  }
  if (!best) return null;
  const firstEndpoint = best.lower.family === firstFamily.family ? best.lower : best.upper;
  const secondEndpoint = best.lower.family === secondFamily.family ? best.lower : best.upper;
  best.pairTurn = firstEndpoint.turn;
  best.directionTieCount = directionTieCount;
  best.absoluteViewPair = `${firstFamily.family}-n-to-${secondFamily.family}-n-plus-${secondTurnOffset}`;
  best.acquisitionFirstAbsoluteViewIndex = firstEndpoint.absoluteViewIndex;
  best.acquisitionSecondAbsoluteViewIndex = secondEndpoint.absoluteViewIndex;
  return best;
}

function pairedCrossFamilyGeometry(
  p,
  z0,
  coneOn,
  directAngleUnwrappedRad,
  complementaryAngleUnwrappedRad,
  directAbsoluteViewIndex,
  complementaryAbsoluteViewIndex,
) {
  const direct = familyAtBaseAngle(
    p,
    directAngleUnwrappedRad,
    coneOn,
    "direct",
    directAbsoluteViewIndex,
  );
  const complementary = familyAtBaseAngle(
    p,
    complementaryAngleUnwrappedRad,
    coneOn,
    "complementary",
    complementaryAbsoluteViewIndex,
  );
  // Along the forward helical branch the absolute ordering is
  // D_n -> C_n -> D_(n+1).  The two 180LI cross-family intervals are
  // therefore D_n/C_n and C_n/D_(n+1), not two independently selected turns.
  const pairOne = minimumBracketWithinAbsoluteViewPair(p, z0, direct, complementary, 0);
  const pairTwo = minimumBracketWithinAbsoluteViewPair(p, z0, complementary, direct, 1);
  const pairOneGap = pairOne?.valid ? pairOne.gapMm : Infinity;
  const pairTwoGap = pairTwo?.valid ? pairTwo.gapMm : Infinity;
  const selectedPairIndex = pairOneGap <= pairTwoGap ? 0 : 1;
  const selected = Number.isFinite(Math.min(pairOneGap, pairTwoGap))
    ? (selectedPairIndex === 0 ? pairOne : pairTwo)
    : null;
  const alternativeCandidate = selectedPairIndex === 0 ? pairTwo : pairOne;
  const alternative = alternativeCandidate?.valid ? alternativeCandidate : null;
  return {
    pairOne,
    pairTwo,
    selectedPairIndex,
    selected,
    alternative,
    valid: Boolean(pairOne?.valid || pairTwo?.valid),
    helicalOrder: "direct-n-to-complementary-n-to-direct-n-plus-one",
  };
}

function integratedPair(directGeometry, complementaryGeometry) {
  const directExact = directGeometry.exactMatch
    ? pairEndpoint(directGeometry, "direct", "lower")
    : null;
  const complementaryExact = complementaryGeometry.exactMatch
    ? pairEndpoint(complementaryGeometry, "complementary", "lower")
    : null;
  if (directExact || complementaryExact) {
    const endpoint = directExact ?? complementaryExact;
    const type = directExact && complementaryExact
      ? "B0"
      : (directExact ? "D0" : "C0");
    const directExactMultiplicity = directGeometry.exactCandidateCount ?? 0;
    const complementaryExactMultiplicity = complementaryGeometry.exactCandidateCount ?? 0;
    return {
      lower: endpoint,
      upper: endpoint,
      gapMm: 0,
      lowerWeight: 1,
      upperWeight: 0,
      typeCode: INTEGRATED_PAIR_TYPES[type],
      type,
      exactMatch: true,
      directExactMultiplicity,
      complementaryExactMultiplicity,
      lowerTieCount: directExactMultiplicity + complementaryExactMultiplicity,
      upperTieCount: directExactMultiplicity + complementaryExactMultiplicity,
      lowerFamilyMask: (directExact ? 1 : 0) | (complementaryExact ? 2 : 0),
      upperFamilyMask: (directExact ? 1 : 0) | (complementaryExact ? 2 : 0),
      valid: true,
    };
  }
  const directLower = pairEndpoint(directGeometry, "direct", "lower");
  const complementaryLower = pairEndpoint(complementaryGeometry, "complementary", "lower");
  const directUpper = pairEndpoint(directGeometry, "direct", "upper");
  const complementaryUpper = pairEndpoint(complementaryGeometry, "complementary", "upper");
  const lowerDistance = Math.min(
    directLower?.distanceMm ?? Infinity,
    complementaryLower?.distanceMm ?? Infinity,
  );
  const upperDistance = Math.min(
    directUpper?.distanceMm ?? Infinity,
    complementaryUpper?.distanceMm ?? Infinity,
  );
  const directLowerTied = directLower && Math.abs(directLower.distanceMm - lowerDistance) <= 1e-10;
  const complementaryLowerTied = complementaryLower
    && Math.abs(complementaryLower.distanceMm - lowerDistance) <= 1e-10;
  const directUpperTied = directUpper && Math.abs(directUpper.distanceMm - upperDistance) <= 1e-10;
  const complementaryUpperTied = complementaryUpper
    && Math.abs(complementaryUpper.distanceMm - upperDistance) <= 1e-10;
  // A deterministic representative is retained for plotting, while the masks
  // and multiplicities below preserve coincident endpoints instead of silently
  // collapsing them to a unique direct/complementary family.
  const lower = directLowerTied ? directLower : complementaryLower;
  const upper = directUpperTied ? directUpper : complementaryUpper;
  if (!lower || !upper) return { valid: false };
  const gapMm = Math.max(0, upper.signedDistanceMm - lower.signedDistanceMm);
  const lowerFamilyMask = (directLowerTied ? 1 : 0) | (complementaryLowerTied ? 2 : 0);
  const upperFamilyMask = (directUpperTied ? 1 : 0) | (complementaryUpperTied ? 2 : 0);
  const familyLabel = mask => mask === 1 ? "D" : mask === 2 ? "C" : "B";
  const type = `${familyLabel(lowerFamilyMask)}${familyLabel(upperFamilyMask)}`;
  return {
    lower,
    upper,
    gapMm,
    lowerWeight: gapMm <= EPS ? 0.5 : upper.distanceMm / gapMm,
    upperWeight: gapMm <= EPS ? 0.5 : lower.distanceMm / gapMm,
    typeCode: INTEGRATED_PAIR_TYPES[type],
    type,
    exactMatch: false,
    directExactMultiplicity: 0,
    complementaryExactMultiplicity: 0,
    lowerTieCount: (directLowerTied ? directGeometry.lowerCandidateCount : 0)
      + (complementaryLowerTied ? complementaryGeometry.lowerCandidateCount : 0),
    upperTieCount: (directUpperTied ? directGeometry.upperCandidateCount : 0)
      + (complementaryUpperTied ? complementaryGeometry.upperCandidateCount : 0),
    lowerFamilyMask,
    upperFamilyMask,
    valid: Number.isFinite(gapMm)
      && lower.signedDistanceMm <= EPS
      && upper.signedDistanceMm >= -EPS,
  };
}

function integratedCandidateGeometry(p, directGeometry, complementaryGeometry) {
  const union = [
    ...directGeometry.candidates,
    ...complementaryGeometry.candidates,
  ];
  const exact = union.filter(candidate => Math.abs(candidate.delta) <= 1e-10);
  let selected = [];
  let lowerDelta = NaN;
  let upperDelta = NaN;
  let bracketGapMm = NaN;
  let exactMatch = false;

  if (exact.length) {
    exactMatch = true;
    bracketGapMm = 0;
    const sharedWeight = 1 / exact.length;
    selected = exact.map(candidate => ({
      ...candidate,
      rawWeight: sharedWeight,
      weight: sharedWeight,
      longitudinalWeight: sharedWeight,
    }));
  } else {
    for (const candidate of union) {
      if (candidate.delta < -1e-10
        && (!Number.isFinite(lowerDelta) || candidate.delta > lowerDelta)) {
        lowerDelta = candidate.delta;
      }
      if (candidate.delta > 1e-10
        && (!Number.isFinite(upperDelta) || candidate.delta < upperDelta)) {
        upperDelta = candidate.delta;
      }
    }
    if (Number.isFinite(lowerDelta) && Number.isFinite(upperDelta)) {
      const lower = union.filter(candidate => Math.abs(candidate.delta - lowerDelta) <= 1e-10);
      const upper = union.filter(candidate => Math.abs(candidate.delta - upperDelta) <= 1e-10);
      bracketGapMm = upperDelta - lowerDelta;
      const lowerEndpointWeight = upperDelta / bracketGapMm;
      const upperEndpointWeight = -lowerDelta / bracketGapMm;
      selected = [
        ...lower.map(candidate => ({
          ...candidate,
          rawWeight: lowerEndpointWeight / lower.length,
          weight: lowerEndpointWeight / lower.length,
          longitudinalWeight: lowerEndpointWeight / lower.length,
        })),
        ...upper.map(candidate => ({
          ...candidate,
          rawWeight: upperEndpointWeight / upper.length,
          weight: upperEndpointWeight / upper.length,
          longitudinalWeight: upperEndpointWeight / upper.length,
        })),
      ];
    }
  }

  const normalizedWeightSum = selected.reduce((sum, candidate) => sum + candidate.weight, 0);
  const longitudinalMomentResidualMm = selected.reduce(
    (sum, candidate) => sum + candidate.weight * candidate.delta,
    0,
  );
  return {
    candidates: selected,
    bracketGapMm,
    bracketGapRatio: bracketGapMm / p.sliceThicknessMm,
    exactMatch,
    normalizedWeightSum,
    longitudinalMomentResidualMm,
    valid: selected.length > 0
      && Math.abs(normalizedWeightSum - 1) <= 1e-9
      && Math.abs(longitudinalMomentResidualMm) <= 1e-8,
  };
}

function physicalCandidateKey(candidate) {
  // A physical acquired sample is identified by its absolute acquired-view
  // index and detector row.  The same sample can appear in both angular
  // interpolation branches; turn, center, and aperture are consistency
  // properties of that identity rather than additional identity fields.
  const absoluteViewIndex = Number.isFinite(candidate.absoluteViewIndex)
    ? Math.round(candidate.absoluteViewIndex)
    : "none";
  const row = Number.isFinite(candidate.row) ? Math.round(candidate.row) : "none";
  return `${absoluteViewIndex}|${row}`;
}

function assertConsistentPhysicalCandidate(previous, candidate, key) {
  for (const field of ["center", "aperture"]) {
    const before = Number(previous[field]);
    const after = Number(candidate[field]);
    if (Number.isFinite(before) && Number.isFinite(after)
      && Math.abs(before - after) > PHYSICAL_CANDIDATE_IDENTITY_TOLERANCE_MM) {
      throw new Error(`Inconsistent ${field} for physical candidate ${key}: ${before} versus ${after}`);
    }
  }
  if (Number.isFinite(previous.turn) && Number.isFinite(candidate.turn)
    && Math.round(previous.turn) !== Math.round(candidate.turn)) {
    throw new Error(`Inconsistent turn for physical candidate ${key}: ${previous.turn} versus ${candidate.turn}`);
  }
}

function summarizeFinalCandidateContributions(candidatesInput) {
  const mergedCandidates = new Map();
  let contributionCount = 0;
  let totalWeight = 0;
  for (const candidate of candidatesInput ?? []) {
    const weight = Number(candidate?.weight);
    if (!(weight > EPS) || !Number.isFinite(weight)) continue;
    const key = physicalCandidateKey(candidate);
    const previous = mergedCandidates.get(key);
    if (previous) {
      assertConsistentPhysicalCandidate(previous.candidate, candidate, key);
      previous.weight += weight;
    } else {
      mergedCandidates.set(key, { candidate, weight });
    }
    contributionCount += 1;
    totalWeight += weight;
  }
  let mergedSquaredWeightSum = 0;
  for (const { weight } of mergedCandidates.values()) mergedSquaredWeightSum += weight * weight;
  const effectiveCandidateCount = totalWeight > EPS && mergedSquaredWeightSum > EPS
    ? totalWeight * totalWeight / mergedSquaredWeightSum
    : 0;
  return {
    uniqueCandidateCount: mergedCandidates.size,
    effectiveCandidateCount,
    contributionCount,
    duplicateContributionCount: contributionCount - mergedCandidates.size,
    totalWeight,
    mergedSquaredWeightSum,
    uniquenessKey: "absoluteViewIndex,row; turn,centerMm,apertureMm-consistency-checked-at-1e-9-mm",
  };
}

function fanBeam180LiGeometryAtView(p, z0, viewIndex, coneOn) {
  const beta = PI2 * viewIndex / p.viewSamples;
  const pairing = fanBeamComplementaryGeometryAtAngle(p, beta, coneOn);
  const acquired = acquiredViewMapping(p, pairing.complementaryAngleUnwrappedRad);
  const direct = geometryAtFullScanAngle(p, z0, beta, coneOn, {
    dataKind: "direct-acquired",
    family: "direct",
    baseAbsoluteViewIndex: viewIndex,
  });
  const complementaryLower = geometryAtFullScanAngle(
    p,
    z0,
    acquired.lowerAngleUnwrappedRad,
    coneOn,
    {
      dataKind: "complementary-acquired-lower-angular-neighbor",
      family: "complementary",
      baseAbsoluteViewIndex: acquired.lowerAbsoluteViewIndex,
    },
  );
  const complementaryUpper = acquired.upperAbsoluteViewIndex === acquired.lowerAbsoluteViewIndex
    ? complementaryLower
    : geometryAtFullScanAngle(
      p,
      z0,
      acquired.upperAngleUnwrappedRad,
      coneOn,
      {
        dataKind: "complementary-acquired-upper-angular-neighbor",
        family: "complementary",
        baseAbsoluteViewIndex: acquired.upperAbsoluteViewIndex,
      },
    );
  const lowerBranch = integratedCandidateGeometry(p, direct, complementaryLower);
  const upperBranch = integratedCandidateGeometry(p, direct, complementaryUpper);
  const sameAngularView = acquired.lowerAbsoluteViewIndex === acquired.upperAbsoluteViewIndex;
  const angularFraction = Math.max(0, Math.min(1, acquired.angularInterpolationFraction));
  const lowerAngularWeight = sameAngularView ? 1 : 1 - angularFraction;
  const upperAngularWeight = sameAngularView ? 0 : angularFraction;
  const candidates = [];
  for (const [branch, angularWeight, branchLabel] of [
    [lowerBranch, lowerAngularWeight, "lower-angular-neighbor"],
    [upperBranch, upperAngularWeight, "upper-angular-neighbor"],
  ]) {
    if (angularWeight <= EPS || !branch.valid) continue;
    for (const candidate of branch.candidates) {
      candidates.push({
        ...candidate,
        branch: branchLabel,
        angularWeight,
        longitudinalWeight: candidate.weight,
        rawWeight: candidate.weight * angularWeight,
        weight: candidate.weight * angularWeight,
      });
    }
  }
  const angularInterpolationWeightSum = lowerAngularWeight + upperAngularWeight;
  const normalizedWeightSum = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  const longitudinalMomentResidualMm = candidates.reduce(
    (sum, candidate) => sum + candidate.weight * candidate.delta,
    0,
  );
  const bracketGapMm = lowerAngularWeight * lowerBranch.bracketGapMm
    + upperAngularWeight * upperBranch.bracketGapMm;
  return {
    beta,
    pairing,
    acquired,
    direct,
    complementaryLower,
    complementaryUpper,
    lowerBranch,
    upperBranch,
    candidates,
    angularFraction,
    lowerAngularWeight,
    upperAngularWeight,
    angularInterpolationWeightSum,
    normalizedWeightSum,
    longitudinalMomentResidualMm,
    bracketGapMm,
    bracketGapRatio: bracketGapMm / p.sliceThicknessMm,
    exactMatch: bracketGapMm <= 1e-10,
    valid: lowerBranch.valid
      && upperBranch.valid
      && Math.abs(angularInterpolationWeightSum - 1) <= 1e-9
      && Math.abs(normalizedWeightSum - 1) <= 1e-9
      && Math.abs(longitudinalMomentResidualMm) <= 1e-8,
  };
}

function createCrossPairSeries(count) {
  return {
    pairOneGapMm: new Float32Array(count),
    pairTwoGapMm: new Float32Array(count),
    pairOneLowerSignedDistanceMm: new Float32Array(count),
    pairOneUpperSignedDistanceMm: new Float32Array(count),
    pairTwoLowerSignedDistanceMm: new Float32Array(count),
    pairTwoUpperSignedDistanceMm: new Float32Array(count),
    pairOneLowerWeights: new Float32Array(count),
    pairOneUpperWeights: new Float32Array(count),
    pairTwoLowerWeights: new Float32Array(count),
    pairTwoUpperWeights: new Float32Array(count),
    pairOneTurns: new Int32Array(count),
    pairTwoTurns: new Int32Array(count),
    pairOneLowerRows: new Uint16Array(count),
    pairOneUpperRows: new Uint16Array(count),
    pairTwoLowerRows: new Uint16Array(count),
    pairTwoUpperRows: new Uint16Array(count),
    pairOneLowerAbsoluteViewIndices: new Int32Array(count).fill(-1),
    pairOneUpperAbsoluteViewIndices: new Int32Array(count).fill(-1),
    pairTwoLowerAbsoluteViewIndices: new Int32Array(count).fill(-1),
    pairTwoUpperAbsoluteViewIndices: new Int32Array(count).fill(-1),
    selectedPairIndices: new Uint8Array(count),
    selectedGapMm: new Float32Array(count),
    alternativeGapMm: new Float32Array(count),
    selectedDirectDistanceMm: new Float32Array(count),
    selectedComplementaryDistanceMm: new Float32Array(count),
    selectedDirectWeights: new Float32Array(count),
    selectedComplementaryWeights: new Float32Array(count),
    selectedLowerWeights: new Float32Array(count),
    selectedUpperWeights: new Float32Array(count),
    valid: new Uint8Array(count),
    switchFlags: new Uint8Array(count),
  };
}

function writeCrossPairSeries(series, index, pairs) {
  const one = pairs.pairOne;
  const two = pairs.pairTwo;
  const selected = pairs.selected;
  const alternative = pairs.alternative;
  series.pairOneGapMm[index] = one?.valid ? one.gapMm : NaN;
  series.pairTwoGapMm[index] = two?.valid ? two.gapMm : NaN;
  series.pairOneLowerSignedDistanceMm[index] = one?.valid ? one.lower.signedDistanceMm : NaN;
  series.pairOneUpperSignedDistanceMm[index] = one?.valid ? one.upper.signedDistanceMm : NaN;
  series.pairTwoLowerSignedDistanceMm[index] = two?.valid ? two.lower.signedDistanceMm : NaN;
  series.pairTwoUpperSignedDistanceMm[index] = two?.valid ? two.upper.signedDistanceMm : NaN;
  series.pairOneLowerWeights[index] = one?.valid ? one.lowerWeight : NaN;
  series.pairOneUpperWeights[index] = one?.valid ? one.upperWeight : NaN;
  series.pairTwoLowerWeights[index] = two?.valid ? two.lowerWeight : NaN;
  series.pairTwoUpperWeights[index] = two?.valid ? two.upperWeight : NaN;
  series.pairOneTurns[index] = one?.valid ? one.pairTurn : 0;
  series.pairTwoTurns[index] = two?.valid ? two.pairTurn : 0;
  series.pairOneLowerRows[index] = one?.valid ? one.lower.row : 0;
  series.pairOneUpperRows[index] = one?.valid ? one.upper.row : 0;
  series.pairTwoLowerRows[index] = two?.valid ? two.lower.row : 0;
  series.pairTwoUpperRows[index] = two?.valid ? two.upper.row : 0;
  series.pairOneLowerAbsoluteViewIndices[index] = one?.valid && one.lower.absoluteViewIndex != null
    ? one.lower.absoluteViewIndex : -1;
  series.pairOneUpperAbsoluteViewIndices[index] = one?.valid && one.upper.absoluteViewIndex != null
    ? one.upper.absoluteViewIndex : -1;
  series.pairTwoLowerAbsoluteViewIndices[index] = two?.valid && two.lower.absoluteViewIndex != null
    ? two.lower.absoluteViewIndex : -1;
  series.pairTwoUpperAbsoluteViewIndices[index] = two?.valid && two.upper.absoluteViewIndex != null
    ? two.upper.absoluteViewIndex : -1;
  series.selectedPairIndices[index] = pairs.selectedPairIndex;
  series.selectedGapMm[index] = selected?.valid ? selected.gapMm : NaN;
  series.alternativeGapMm[index] = alternative?.valid ? alternative.gapMm : NaN;
  series.selectedDirectDistanceMm[index] = selected?.valid ? selected.directDistanceMm : NaN;
  series.selectedComplementaryDistanceMm[index] = selected?.valid ? selected.complementaryDistanceMm : NaN;
  series.selectedDirectWeights[index] = selected?.valid ? selected.directWeight : NaN;
  series.selectedComplementaryWeights[index] = selected?.valid ? selected.complementaryWeight : NaN;
  series.selectedLowerWeights[index] = selected?.valid ? selected.lowerWeight : NaN;
  series.selectedUpperWeights[index] = selected?.valid ? selected.upperWeight : NaN;
  series.valid[index] = pairs.valid ? 1 : 0;
}

function createIntegratedPairSeries(count) {
  return {
    gapMm: new Float32Array(count),
    lowerSignedDistanceMm: new Float32Array(count),
    upperSignedDistanceMm: new Float32Array(count),
    lowerWeights: new Float32Array(count),
    upperWeights: new Float32Array(count),
    lowerRows: new Uint16Array(count),
    upperRows: new Uint16Array(count),
    lowerTurns: new Int32Array(count),
    upperTurns: new Int32Array(count),
    lowerAnglesUnwrappedDeg: new Float32Array(count),
    upperAnglesUnwrappedDeg: new Float32Array(count),
    lowerAbsoluteViewIndices: new Int32Array(count).fill(-1),
    upperAbsoluteViewIndices: new Int32Array(count).fill(-1),
    lowerFamilyMasks: new Uint8Array(count),
    upperFamilyMasks: new Uint8Array(count),
    lowerTieCounts: new Uint16Array(count),
    upperTieCounts: new Uint16Array(count),
    directExactMultiplicities: new Uint16Array(count),
    complementaryExactMultiplicities: new Uint16Array(count),
    pairTypeCodes: new Uint8Array(count),
    exactMatchFlags: new Uint8Array(count),
    valid: new Uint8Array(count),
    switchFlags: new Uint8Array(count),
  };
}

function writeIntegratedPairSeries(series, index, pair) {
  series.gapMm[index] = pair.valid ? pair.gapMm : NaN;
  series.lowerSignedDistanceMm[index] = pair.valid ? pair.lower.signedDistanceMm : NaN;
  series.upperSignedDistanceMm[index] = pair.valid ? pair.upper.signedDistanceMm : NaN;
  series.lowerWeights[index] = pair.valid ? pair.lowerWeight : NaN;
  series.upperWeights[index] = pair.valid ? pair.upperWeight : NaN;
  series.lowerRows[index] = pair.valid ? pair.lower.row : 0;
  series.upperRows[index] = pair.valid ? pair.upper.row : 0;
  series.lowerTurns[index] = pair.valid ? pair.lower.turn : 0;
  series.upperTurns[index] = pair.valid ? pair.upper.turn : 0;
  series.lowerAnglesUnwrappedDeg[index] = pair.valid ? pair.lower.angleUnwrappedRad * RAD_TO_DEG : NaN;
  series.upperAnglesUnwrappedDeg[index] = pair.valid ? pair.upper.angleUnwrappedRad * RAD_TO_DEG : NaN;
  series.lowerAbsoluteViewIndices[index] = pair.valid && pair.lower.absoluteViewIndex != null
    ? pair.lower.absoluteViewIndex : -1;
  series.upperAbsoluteViewIndices[index] = pair.valid && pair.upper.absoluteViewIndex != null
    ? pair.upper.absoluteViewIndex : -1;
  series.lowerFamilyMasks[index] = pair.valid ? pair.lowerFamilyMask : 0;
  series.upperFamilyMasks[index] = pair.valid ? pair.upperFamilyMask : 0;
  series.lowerTieCounts[index] = pair.valid ? pair.lowerTieCount : 0;
  series.upperTieCounts[index] = pair.valid ? pair.upperTieCount : 0;
  series.directExactMultiplicities[index] = pair.valid ? pair.directExactMultiplicity : 0;
  series.complementaryExactMultiplicities[index] = pair.valid ? pair.complementaryExactMultiplicity : 0;
  series.pairTypeCodes[index] = pair.valid ? pair.typeCode : 0;
  series.exactMatchFlags[index] = pair.valid && pair.exactMatch ? 1 : 0;
  series.valid[index] = pair.valid ? 1 : 0;
}

function finalizeIntegratedPairSeries(series) {
  let validCount = 0;
  let switchCount = 0;
  let firstValid = -1;
  let lastValid = -1;
  const typeCounts = new Uint32Array(Object.keys(INTEGRATED_PAIR_TYPES).length);
  for (let index = 0; index < series.valid.length; index += 1) {
    if (!series.valid[index]) continue;
    validCount += 1;
    typeCounts[series.pairTypeCodes[index]] += 1;
    if (firstValid < 0) firstValid = index;
    lastValid = index;
    let previous = index - 1;
    while (previous >= 0 && !series.valid[previous]) previous -= 1;
    if (previous >= 0 && series.pairTypeCodes[index] !== series.pairTypeCodes[previous]) {
      series.switchFlags[index] = 1;
      switchCount += 1;
    }
  }
  if (firstValid >= 0 && lastValid > firstValid
    && series.pairTypeCodes[firstValid] !== series.pairTypeCodes[lastValid]) {
    series.switchFlags[firstValid] = 1;
    switchCount += 1;
  }
  series.validCount = validCount;
  series.switchCount = switchCount;
  series.typeLabels = ["DD", "DC", "DB", "CD", "CC", "CB", "BD", "BC", "BB", "D0", "C0", "B0"];
  series.typeCounts = typeCounts;
  series.selectionRule = "general-two-point-li-reference-nearest-smaller-z-and-larger-z-candidates-from-the-union-of-direct-and-complementary-families";
  return series;
}

function finalizeCrossPairSeries(series) {
  let switchCount = 0;
  let validCount = 0;
  let firstValid = -1;
  let lastValid = -1;
  for (let index = 0; index < series.valid.length; index += 1) {
    if (!series.valid[index]) continue;
    validCount += 1;
    if (firstValid < 0) firstValid = index;
    lastValid = index;
    let previous = index - 1;
    while (previous >= 0 && !series.valid[previous]) previous -= 1;
    if (previous >= 0 && series.selectedPairIndices[index] !== series.selectedPairIndices[previous]) {
      series.switchFlags[index] = 1;
      switchCount += 1;
    }
  }
  if (firstValid >= 0 && lastValid > firstValid
    && series.selectedPairIndices[firstValid] !== series.selectedPairIndices[lastValid]) {
    series.switchFlags[firstValid] = 1;
    switchCount += 1;
  }
  series.validCount = validCount;
  series.switchCount = switchCount;
  const summarize = values => {
    let minimum = Infinity;
    let maximum = -Infinity;
    let sum = 0;
    let count = 0;
    for (let index = 0; index < values.length; index += 1) {
      if (!series.valid[index] || !Number.isFinite(values[index])) continue;
      minimum = Math.min(minimum, values[index]);
      maximum = Math.max(maximum, values[index]);
      sum += values[index];
      count += 1;
    }
    return {
      min: count ? minimum : NaN,
      max: count ? maximum : NaN,
      mean: count ? sum / count : NaN,
    };
  };
  series.pairOneGapSummaryMm = summarize(series.pairOneGapMm);
  series.pairTwoGapSummaryMm = summarize(series.pairTwoGapMm);
  series.selectedGapSummaryMm = summarize(series.selectedGapMm);
  series.selectionRule = "minimum-longitudinal-bracketing-span-between-two-absolute-view-pairs-with-both-z-orientations-searched-ties-to-pair-one-geometry-reference-only";
  series.pairOneDefinition = "minimum-bracketing-span-within-direct-n-and-complementary-n-both-z-orientations-searched";
  series.pairTwoDefinition = "minimum-bracketing-span-within-complementary-n-and-direct-n-plus-one-both-z-orientations-searched";
  series.helicalOrder = "direct-n-to-complementary-n-to-direct-n-plus-one";
  return series;
}

function computeComplementaryCandidateSeries(p, z0, coneOn) {
  const count = p.viewSamples;
  const baseAnglesDeg = new Float32Array(count);
  const idealComplementAnglesDeg = new Float32Array(count);
  const idealComplementAnglesUnwrappedDeg = new Float32Array(count);
  const forwardSeparationsDeg = new Float32Array(count);
  const fanAnglesDeg = new Float32Array(count);
  const nearestComplementViewIndices = new Int32Array(count);
  const lowerComplementViewIndices = new Int32Array(count);
  const upperComplementViewIndices = new Int32Array(count);
  const nearestComplementAbsoluteViewIndices = new Int32Array(count);
  const lowerComplementAbsoluteViewIndices = new Int32Array(count);
  const upperComplementAbsoluteViewIndices = new Int32Array(count);
  const nearestComplementAnglesDeg = new Float32Array(count);
  const nearestForwardSeparationsDeg = new Float32Array(count);
  const angularResidualsDeg = new Float32Array(count);
  const lowerAngularResidualsDeg = new Float32Array(count);
  const upperAngularResidualsDeg = new Float32Array(count);
  const angularInterpolationFractions = new Float32Array(count);
  const directNearestDistancesMm = new Float32Array(count);
  const complementaryNearestDistancesMm = new Float32Array(count);
  const directLowerDistancesMm = new Float32Array(count);
  const directUpperDistancesMm = new Float32Array(count);
  const complementaryLowerDistancesMm = new Float32Array(count);
  const complementaryUpperDistancesMm = new Float32Array(count);
  const directCandidateCounts = new Uint16Array(count);
  const complementaryCandidateCounts = new Uint16Array(count);
  const nearestViewPairs = createCrossPairSeries(count);
  const idealAnglePairs = createCrossPairSeries(count);
  const lowerAngularNeighborPairs = createCrossPairSeries(count);
  const upperAngularNeighborPairs = createCrossPairSeries(count);
  const nearestIntegratedPairs = createIntegratedPairSeries(count);
  const idealIntegratedPairs = createIntegratedPairSeries(count);
  const lowerAngularNeighborIntegratedPairs = createIntegratedPairSeries(count);
  const upperAngularNeighborIntegratedPairs = createIntegratedPairSeries(count);
  const stepRad = PI2 / count;
  let maximumLineCircleResidualMm = 0;
  let maximumAngularResidualDeg = 0;
  let directExactViewCount = 0;
  let complementaryExactViewCount = 0;

  for (let viewIndex = 0; viewIndex < count; viewIndex += 1) {
    const beta = viewIndex * stepRad;
    const pairing = fanBeamComplementaryGeometryAtAngle(p, beta, coneOn);
    const acquired = acquiredViewMapping(p, pairing.complementaryAngleUnwrappedRad);
    const direct = geometryAtFullScanAngle(p, z0, beta, coneOn, {
      family: "direct",
      baseAbsoluteViewIndex: viewIndex,
    });
    const complementary = geometryAtFullScanAngle(p, z0, acquired.nearestAngleUnwrappedRad, coneOn, {
      family: "complementary",
      baseAbsoluteViewIndex: acquired.nearestAbsoluteViewIndex,
    });
    const idealComplementary = geometryAtFullScanAngle(p, z0, pairing.complementaryAngleUnwrappedRad, coneOn, {
      family: "complementary",
      baseAbsoluteViewIndex: null,
    });
    const lowerAngularComplementary = geometryAtFullScanAngle(p, z0, acquired.lowerAngleUnwrappedRad, coneOn, {
      family: "complementary",
      baseAbsoluteViewIndex: acquired.lowerAbsoluteViewIndex,
    });
    const upperAngularComplementary = geometryAtFullScanAngle(p, z0, acquired.upperAngleUnwrappedRad, coneOn, {
      family: "complementary",
      baseAbsoluteViewIndex: acquired.upperAbsoluteViewIndex,
    });
    const nearestForwardSeparationRad = acquired.nearestAngleUnwrappedRad - beta;

    baseAnglesDeg[viewIndex] = beta * RAD_TO_DEG;
    idealComplementAnglesDeg[viewIndex] = pairing.complementaryAngleRad * RAD_TO_DEG;
    idealComplementAnglesUnwrappedDeg[viewIndex] = pairing.complementaryAngleUnwrappedRad * RAD_TO_DEG;
    forwardSeparationsDeg[viewIndex] = pairing.forwardSeparationRad * RAD_TO_DEG;
    fanAnglesDeg[viewIndex] = pairing.fanAngleRad * RAD_TO_DEG;
    nearestComplementViewIndices[viewIndex] = acquired.nearestViewIndex;
    lowerComplementViewIndices[viewIndex] = acquired.lowerViewIndex;
    upperComplementViewIndices[viewIndex] = acquired.upperViewIndex;
    nearestComplementAbsoluteViewIndices[viewIndex] = acquired.nearestAbsoluteViewIndex;
    lowerComplementAbsoluteViewIndices[viewIndex] = acquired.lowerAbsoluteViewIndex;
    upperComplementAbsoluteViewIndices[viewIndex] = acquired.upperAbsoluteViewIndex;
    nearestComplementAnglesDeg[viewIndex] = acquired.nearestAngleRad * RAD_TO_DEG;
    nearestForwardSeparationsDeg[viewIndex] = nearestForwardSeparationRad * RAD_TO_DEG;
    angularResidualsDeg[viewIndex] = acquired.angularResidualRad * RAD_TO_DEG;
    lowerAngularResidualsDeg[viewIndex] = acquired.lowerAngularResidualRad * RAD_TO_DEG;
    upperAngularResidualsDeg[viewIndex] = acquired.upperAngularResidualRad * RAD_TO_DEG;
    angularInterpolationFractions[viewIndex] = acquired.angularInterpolationFraction;
    directNearestDistancesMm[viewIndex] = nearestCandidateDistanceMm(direct);
    complementaryNearestDistancesMm[viewIndex] = nearestCandidateDistanceMm(complementary);
    directLowerDistancesMm[viewIndex] = direct.lowerDistanceMm;
    directUpperDistancesMm[viewIndex] = direct.upperDistanceMm;
    complementaryLowerDistancesMm[viewIndex] = complementary.lowerDistanceMm;
    complementaryUpperDistancesMm[viewIndex] = complementary.upperDistanceMm;
    directCandidateCounts[viewIndex] = direct.candidates.length;
    complementaryCandidateCounts[viewIndex] = complementary.candidates.length;
    writeCrossPairSeries(nearestViewPairs, viewIndex, pairedCrossFamilyGeometry(
      p,
      z0,
      coneOn,
      beta,
      acquired.nearestAngleUnwrappedRad,
      viewIndex,
      acquired.nearestAbsoluteViewIndex,
    ));
    writeCrossPairSeries(idealAnglePairs, viewIndex, pairedCrossFamilyGeometry(
      p,
      z0,
      coneOn,
      beta,
      pairing.complementaryAngleUnwrappedRad,
      viewIndex,
      null,
    ));
    writeCrossPairSeries(lowerAngularNeighborPairs, viewIndex, pairedCrossFamilyGeometry(
      p,
      z0,
      coneOn,
      beta,
      acquired.lowerAngleUnwrappedRad,
      viewIndex,
      acquired.lowerAbsoluteViewIndex,
    ));
    writeCrossPairSeries(upperAngularNeighborPairs, viewIndex, pairedCrossFamilyGeometry(
      p,
      z0,
      coneOn,
      beta,
      acquired.upperAngleUnwrappedRad,
      viewIndex,
      acquired.upperAbsoluteViewIndex,
    ));
    writeIntegratedPairSeries(nearestIntegratedPairs, viewIndex, integratedPair(direct, complementary));
    writeIntegratedPairSeries(idealIntegratedPairs, viewIndex, integratedPair(direct, idealComplementary));
    writeIntegratedPairSeries(lowerAngularNeighborIntegratedPairs, viewIndex, integratedPair(direct, lowerAngularComplementary));
    writeIntegratedPairSeries(upperAngularNeighborIntegratedPairs, viewIndex, integratedPair(direct, upperAngularComplementary));
    if (direct.exactMatch) directExactViewCount += 1;
    if (complementary.exactMatch) complementaryExactViewCount += 1;
    maximumLineCircleResidualMm = Math.max(maximumLineCircleResidualMm, pairing.lineCircleResidualMm);
    maximumAngularResidualDeg = Math.max(maximumAngularResidualDeg, Math.abs(angularResidualsDeg[viewIndex]));
  }

  const finiteExtrema = array => {
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const value of array) {
      if (!Number.isFinite(value)) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    return {
      min: Number.isFinite(minimum) ? minimum : NaN,
      max: Number.isFinite(maximum) ? maximum : NaN,
    };
  };

  finalizeCrossPairSeries(nearestViewPairs);
  finalizeCrossPairSeries(idealAnglePairs);
  finalizeCrossPairSeries(lowerAngularNeighborPairs);
  finalizeCrossPairSeries(upperAngularNeighborPairs);
  finalizeIntegratedPairSeries(nearestIntegratedPairs);
  finalizeIntegratedPairSeries(idealIntegratedPairs);
  finalizeIntegratedPairSeries(lowerAngularNeighborIntegratedPairs);
  finalizeIntegratedPairSeries(upperAngularNeighborIntegratedPairs);

  return {
    model: coneOn ? "fan-beam-180li-complementary-ray" : "parallel-beam-180-degree-reference",
    viewCount: count,
    viewStepDeg: 360 / count,
    baseAnglesDeg,
    idealComplementAnglesDeg,
    idealComplementAnglesUnwrappedDeg,
    forwardSeparationsDeg,
    fanAnglesDeg,
    nearestComplementViewIndices,
    lowerComplementViewIndices,
    upperComplementViewIndices,
    nearestComplementAbsoluteViewIndices,
    lowerComplementAbsoluteViewIndices,
    upperComplementAbsoluteViewIndices,
    nearestComplementAnglesDeg,
    nearestForwardSeparationsDeg,
    angularResidualsDeg,
    lowerAngularResidualsDeg,
    upperAngularResidualsDeg,
    angularInterpolationFractions,
    directNearestDistancesMm,
    complementaryNearestDistancesMm,
    directLowerDistancesMm,
    directUpperDistancesMm,
    complementaryLowerDistancesMm,
    complementaryUpperDistancesMm,
    directCandidateCounts,
    complementaryCandidateCounts,
    directSelectedEndpointCounts: directCandidateCounts,
    complementarySelectedEndpointCounts: complementaryCandidateCounts,
    availableDetectorRowsPerAbsoluteView: p.rows,
    rowCandidatesPerDirectComplementPair: 2 * p.rows,
    rowCandidatesAcrossDirectAndAngularBracketViews: 3 * p.rows,
    candidateCountMeaning: "selected-nearest-bracketing-endpoint-multiplicity-not-the-number-of-available-detector-row-samples",
    nearestViewPairs,
    idealAnglePairs,
    lowerAngularNeighborPairs,
    upperAngularNeighborPairs,
    nearestIntegratedPairs,
    idealIntegratedPairs,
    lowerAngularNeighborIntegratedPairs,
    upperAngularNeighborIntegratedPairs,
    forwardSeparationRangeDeg: finiteExtrema(forwardSeparationsDeg),
    fanAngleRangeDeg: finiteExtrema(fanAnglesDeg),
    directNearestDistanceRangeMm: finiteExtrema(directNearestDistancesMm),
    complementaryNearestDistanceRangeMm: finiteExtrema(complementaryNearestDistancesMm),
    maximumAngularResidualDeg,
    maximumLineCircleResidualMm,
    directExactViewCount,
    complementaryExactViewCount,
    actualViewRule: "nearest-acquired-view-to-ideal-complementary-angle-for-geometry-display",
    angularBracketRule: "both-neighboring-acquired-view-indices-and-the-ideal-angle-position-fraction-are-retained-without-commercial-reconstruction-weights",
    candidateRule: "absolute-view-coupled-cross-pairs-follow-direct-n-to-complementary-n-to-direct-n-plus-one-and-bracket-the-target-plane",
    helicalPairOrder: "direct-n-to-complementary-n-to-direct-n-plus-one",
    pairSelectionRule: nearestViewPairs.selectionRule,
    integratedPairSelectionRule: nearestIntegratedPairs.selectionRule,
  };
}

function computeSsp(rawParams, options = {}) {
  const p = validateParams(rawParams);
  const requestedState = Number(options.state ?? p.state);
  const state = ((requestedState % 1) + 1) % 1;
  const coneOn = Boolean(options.coneOn);
  const collectGeometrySeries = Boolean(options.collectGeometrySeries);
  const collectComplementaryCandidates = collectGeometrySeries
    && options.collectComplementaryCandidates !== false;
  const reconstructionPath = options.reconstructionPath ?? p.reconstructionPath;
  if (!Object.values(RECONSTRUCTION_PATHS).includes(reconstructionPath)) {
    throw new Error(`Unsupported acquisition-geometry model: ${reconstructionPath}`);
  }
  const feed = tableFeedMm(p);
  const z0 = p.zReference + feed * state;
  const rho = p.radius / p.sourceRadius;
  const geometries = new Array(p.viewSamples);
  const gapRatios = collectGeometrySeries ? new Float32Array(p.viewSamples) : null;
  const viewContributionSums = collectGeometrySeries ? new Float32Array(p.viewSamples) : null;
  const angularInterpolationWeightSums = collectGeometrySeries ? new Float32Array(p.viewSamples) : null;
  const longitudinalMomentResiduals = collectGeometrySeries ? new Float32Array(p.viewSamples) : null;
  const branchGapMmLower = collectGeometrySeries ? new Float32Array(p.viewSamples) : null;
  const branchGapMmUpper = collectGeometrySeries ? new Float32Array(p.viewSamples) : null;
  const viewKernelRmsMm = collectGeometrySeries ? new Float32Array(p.viewSamples) : null;
  const viewKernelRmsRatio = collectGeometrySeries ? new Float32Array(p.viewSamples) : null;
  const viewCandidateCounts = collectGeometrySeries ? new Uint16Array(p.viewSamples) : null;
  const viewEffectiveCandidateCounts = collectGeometrySeries ? new Float32Array(p.viewSamples) : null;
  const viewCandidateContributionCounts = collectGeometrySeries ? new Uint16Array(p.viewSamples) : null;
  let maximumCandidateExtent = 0;
  let gapSum = 0;
  let gapMin = Infinity;
  let gapMax = 0;
  let exactMatchCount = 0;
  let validCount = 0;
  let maximumViewContributionError = 0;
  let maximumAngularInterpolationWeightError = 0;
  let maximumLongitudinalMomentResidualMm = 0;
  let kernelSecondMomentSumMm2 = 0;
  for (let viewIndex = 0; viewIndex < p.viewSamples; viewIndex += 1) {
    const beta = PI2 * viewIndex / p.viewSamples;
    const geometry = reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
      ? fanBeam180LiGeometryAtView(p, z0, viewIndex, coneOn)
      : geometryAtFullScanAngle(p, z0, beta, coneOn, {
        dataKind: "actual-full-scan",
        family: "direct",
        baseAbsoluteViewIndex: viewIndex,
      });
    geometries[viewIndex] = geometry;
    if (!geometry.valid) {
      if (gapRatios) gapRatios[viewIndex] = NaN;
      if (viewContributionSums) viewContributionSums[viewIndex] = geometry.normalizedWeightSum ?? NaN;
      if (angularInterpolationWeightSums) angularInterpolationWeightSums[viewIndex] = NaN;
      if (longitudinalMomentResiduals) longitudinalMomentResiduals[viewIndex] = NaN;
      if (branchGapMmLower) branchGapMmLower[viewIndex] = NaN;
      if (branchGapMmUpper) branchGapMmUpper[viewIndex] = NaN;
      if (viewKernelRmsMm) viewKernelRmsMm[viewIndex] = NaN;
      if (viewKernelRmsRatio) viewKernelRmsRatio[viewIndex] = NaN;
      if (viewEffectiveCandidateCounts) viewEffectiveCandidateCounts[viewIndex] = NaN;
      continue;
    }
    validCount += 1;
    gapSum += geometry.bracketGapMm;
    gapMin = Math.min(gapMin, geometry.bracketGapMm);
    gapMax = Math.max(gapMax, geometry.bracketGapMm);
    if (geometry.exactMatch) exactMatchCount += 1;
    if (gapRatios) gapRatios[viewIndex] = geometry.bracketGapRatio;
    const contributionSum = geometry.normalizedWeightSum;
    const angularWeightSum = reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
      ? geometry.angularInterpolationWeightSum
      : 1;
    const momentResidual = reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
      ? geometry.longitudinalMomentResidualMm
      : geometry.candidates.reduce((sum, candidate) => sum + candidate.weight * candidate.delta, 0);
    maximumViewContributionError = Math.max(maximumViewContributionError, Math.abs(1 - contributionSum));
    maximumAngularInterpolationWeightError = Math.max(
      maximumAngularInterpolationWeightError,
      Math.abs(1 - angularWeightSum),
    );
    maximumLongitudinalMomentResidualMm = Math.max(
      maximumLongitudinalMomentResidualMm,
      Math.abs(momentResidual),
    );
    const normalizedContributionSum = Math.max(contributionSum, EPS);
    const viewMeanMm = geometry.candidates.reduce(
      (sum, candidate) => sum + candidate.weight * candidate.delta,
      0,
    ) / normalizedContributionSum;
    const viewSecondMomentMm2 = geometry.candidates.reduce(
      (sum, candidate) => sum + candidate.weight * (
        (candidate.delta - viewMeanMm) ** 2 + candidate.aperture ** 2 / 12
      ),
      0,
    ) / normalizedContributionSum;
    const viewRmsMm = Math.sqrt(Math.max(0, viewSecondMomentMm2));
    const candidateSummary = summarizeFinalCandidateContributions(geometry.candidates);
    kernelSecondMomentSumMm2 += viewSecondMomentMm2;
    if (viewContributionSums) viewContributionSums[viewIndex] = contributionSum;
    if (angularInterpolationWeightSums) angularInterpolationWeightSums[viewIndex] = angularWeightSum;
    if (longitudinalMomentResiduals) longitudinalMomentResiduals[viewIndex] = momentResidual;
    if (viewKernelRmsMm) viewKernelRmsMm[viewIndex] = viewRmsMm;
    if (viewKernelRmsRatio) viewKernelRmsRatio[viewIndex] = viewRmsMm / p.sliceThicknessMm;
    if (viewCandidateCounts) {
      viewCandidateCounts[viewIndex] = candidateSummary.uniqueCandidateCount;
    }
    if (viewEffectiveCandidateCounts) {
      viewEffectiveCandidateCounts[viewIndex] = candidateSummary.effectiveCandidateCount;
    }
    if (viewCandidateContributionCounts) {
      viewCandidateContributionCounts[viewIndex] = candidateSummary.contributionCount;
    }
    if (branchGapMmLower) {
      branchGapMmLower[viewIndex] = reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
        ? geometry.lowerBranch.bracketGapMm
        : geometry.bracketGapMm;
    }
    if (branchGapMmUpper) {
      branchGapMmUpper[viewIndex] = reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
        ? geometry.upperBranch.bracketGapMm
        : geometry.bracketGapMm;
    }
    for (const candidate of geometry.candidates) {
      maximumCandidateExtent = Math.max(maximumCandidateExtent, Math.abs(candidate.delta) + candidate.aperture / 2);
    }
  }
  // Use one state-, cone-, and configured-thickness-independent longitudinal
  // domain.  This prevents changes of the numerical search window from being
  // mistaken for geometry-driven SSPz variation.  The grid count is treated
  // as a minimum and is expanded when many narrow rows require finer sampling.
  const maximumAperture = p.rowWidth * (1 + rho);
  const maxDz = Math.max(
    p.rowWidth * 2,
    feed + maximumAperture / 2 + MAX_CONFIGURED_SLICE_THICKNESS_MM / 2 + p.rowWidth,
    maximumCandidateExtent + MAX_CONFIGURED_SLICE_THICKNESS_MM / 2 + p.rowWidth,
  );
  // Resolve both a detector-row aperture and the configured-thickness window.
  // Exact fractional deposition below remains area conserving even for a
  // sub-cell aperture; this adaptive target limits shape error while the hard
  // cap keeps extreme pitch/row-width combinations bounded.
  const targetDz = Math.max(
    Math.min(p.rowWidth / 16, p.sliceThicknessMm / 64),
    0.00025,
  );
  const resolutionDrivenCount = Math.ceil(2 * maxDz / targetDz);
  const requestedInternalZCells = Math.max(p.zSamples, resolutionDrivenCount);
  const zCount = oddCellCountAtLeast(requestedInternalZCells);
  const domainLeft = -maxDz;
  const domainRight = maxDz;
  const dz = (domainRight - domainLeft) / zCount;
  const z = uniformCellCenters(domainLeft, domainRight, zCount);
  const fullCellDiff = new Float64Array(zCount + 1);
  const edgeCellContributions = new Float64Array(zCount);
  let depositedArea = 0;
  for (let viewIndex = 0; viewIndex < p.viewSamples; viewIndex += 1) {
    const geometry = geometries[viewIndex];
    if (!geometry.valid) continue;
    for (const candidate of geometry.candidates) {
      if (candidate.weight <= EPS) continue;
      const half = candidate.aperture / 2;
      const amplitude = candidate.weight / Math.max(candidate.aperture, EPS) / p.viewSamples;
      depositedArea += depositRectangleIntoUniformCellAverages(
        fullCellDiff,
        edgeCellContributions,
        candidate.delta - half,
        candidate.delta + half,
        amplitude,
        domainLeft,
        domainRight,
        dz,
      );
    }
  }
  const profile = new Float64Array(zCount);
  let running = 0;
  let peak = 0;
  let preNormalizationArea = 0;
  for (let i = 0; i < zCount; i += 1) {
    running += fullCellDiff[i];
    profile[i] = Math.max(0, running + edgeCellContributions[i]);
    peak = Math.max(peak, profile[i]);
    preNormalizationArea += profile[i] * dz;
  }
  const preNormalizationPeak = peak;
  if (peak > 0) for (let i = 0; i < profile.length; i += 1) profile[i] /= peak;
  const stats = profileStats(profile, z, dz);
  const complementaryCandidates = collectComplementaryCandidates
    && reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
    ? computeComplementaryCandidateSeries(p, z0, coneOn)
    : null;
  return {
    state,
    z0,
    coneOn,
    reconstructionPath,
    candidateSelectionRule: reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
      ? "fan-beam-180li-angular-neighbor-interpolation-after-direct-complementary-union-z-bracketing"
      : "direct-full-scan-nearest-bracketing-linear",
    candidateWeightHalfSupportMm: null,
    kernelWidth: null,
    z: Array.from(z),
    profile: Array.from(profile),
    coverage: validCount / p.viewSamples,
    angularRangeDeg: 360,
    viewSamples: p.viewSamples,
    requestedZSamples: p.zSamples,
    actualZSamples: zCount,
    requestedInternalZCells,
    internalZCountCapped: requestedInternalZCells > MAX_INTERNAL_Z_CELLS,
    internalZCellCap: MAX_INTERNAL_Z_CELLS,
    targetLongitudinalCellWidthMm: targetDz,
    longitudinalCellWidthMm: dz,
    longitudinalGridInterpretation: "uniform-cell-average-values-reported-at-cell-centers",
    longitudinalDomainHalfWidthMm: maxDz,
    dataKind: reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
      ? "fan-beam-180li-acquisition-geometry-explanatory-model"
      : "actual-full-scan",
    bracketGapMeanMm: validCount ? gapSum / validCount : NaN,
    bracketGapMinMm: validCount ? gapMin : NaN,
    bracketGapMaxMm: validCount ? gapMax : NaN,
    bracketGapRatioMean: validCount ? gapSum / validCount / p.sliceThicknessMm : NaN,
    bracketGapRatioMax: validCount ? gapMax / p.sliceThicknessMm : NaN,
    exactCandidateFraction: validCount ? exactMatchCount / validCount : NaN,
    gapRatios,
    viewContributionSums,
    angularInterpolationWeightSums,
    longitudinalMomentResiduals,
    branchGapMmLower,
    branchGapMmUpper,
    viewKernelRmsMm,
    viewKernelRmsRatio,
    viewCandidateCounts,
    viewEffectiveCandidateCounts,
    viewCandidateContributionCounts,
    candidateCountIndicator: "unique-physical-final-nonzero-candidate-count-after-angular-branch-duplicate-merging",
    candidateCountWeightThreshold: EPS,
    candidateUniquenessKey: "absoluteViewIndex,row; turn,centerMm,apertureMm-consistency-checked-at-1e-9-mm",
    effectiveCandidateCountIndicator: "inverse-simpson-effective-count-from-merged-normalized-final-candidate-weights",
    candidateContributionCountIndicator: "pre-merge-final-nonzero-angular-branch-contribution-count",
    complementaryCandidates,
    maximumViewContributionError,
    maximumAngularInterpolationWeightError,
    maximumLongitudinalMomentResidualMm,
    meanKernelSecondMomentMm2: validCount ? kernelSecondMomentSumMm2 / validCount : NaN,
    analyticBaseSigmaMm: validCount ? Math.sqrt(kernelSecondMomentSumMm2 / validCount) : NaN,
    depositedArea,
    depositionAreaResidual: preNormalizationArea - depositedArea,
    domainClippingAreaResidual: depositedArea - validCount / p.viewSamples,
    preNormalizationArea,
    preNormalizationPeak,
    ...stats,
  };
}

function cumulativeCellIntegral(profile, dz) {
  const cumulative = new Float64Array(profile.length + 1);
  for (let i = 0; i < profile.length; i += 1) {
    cumulative[i + 1] = cumulative[i] + profile[i] * dz;
  }
  return cumulative;
}

function cellIntegralAt(profile, z, cumulative, value) {
  const dz = z.length > 1 ? z[1] - z[0] : 1;
  const leftEdge = z[0] - dz / 2;
  const rightEdge = z[z.length - 1] + dz / 2;
  if (value <= leftEdge) return 0;
  if (value >= rightEdge) return cumulative[profile.length];
  const scaled = (value - leftEdge) / dz;
  const index = Math.max(0, Math.min(profile.length - 1, Math.floor(scaled)));
  const cellLeft = leftEdge + index * dz;
  return cumulative[index] + profile[index] * (value - cellLeft);
}

function rectangularAverageProfile(profileInput, zInput, width) {
  const profile = Float64Array.from(profileInput);
  const z = Float64Array.from(zInput);
  if (!(width > EPS)) return Array.from(profile);
  const dz = z.length > 1 ? z[1] - z[0] : width;
  const cumulative = cumulativeCellIntegral(profile, dz);
  const out = new Float64Array(profile.length);
  const half = width / 2;
  let peak = 0;
  for (let i = 0; i < profile.length; i += 1) {
    const area = cellIntegralAt(profile, z, cumulative, z[i] + half)
      - cellIntegralAt(profile, z, cumulative, z[i] - half);
    out[i] = Math.max(0, area / width);
    peak = Math.max(peak, out[i]);
  }
  if (peak > 0) for (let i = 0; i < out.length; i += 1) out[i] /= peak;
  return Array.from(out);
}

function computeLayeredSsp(rawParams, options = {}) {
  const p = validateParams(rawParams);
  const sliceKernelWidthMm = Math.max(0, Number(options.sliceKernelWidthMm ?? options.sliceKernelWidth ?? 0));
  const base = computeSsp(p, {
    state: options.state ?? p.state,
    coneOn: Boolean(options.coneOn),
    collectGeometrySeries: Boolean(options.collectGeometrySeries),
    collectComplementaryCandidates: options.collectComplementaryCandidates,
    reconstructionPath: options.reconstructionPath ?? p.reconstructionPath,
  });
  const finalProfile = rectangularAverageProfile(base.profile, base.z, sliceKernelWidthMm);
  const dz = base.z[1] - base.z[0];
  const finalStats = profileStats(finalProfile, base.z, dz);
  const analyticConfiguredSigmaMm = Math.sqrt(Math.max(
    0,
    base.meanKernelSecondMomentMm2 + sliceKernelWidthMm ** 2 / 12,
  ));
  return {
    ...base,
    profileMode: PROFILE_MODES.LAYERED_RECT,
    candidateWeightHalfSupportMm: null,
    sliceKernelWidthMm,
    baseKernelWidth: null,
    sliceKernelWidth: sliceKernelWidthMm,
    baseProfile: base.profile,
    baseFwhm: base.fwhm,
    baseFwtm: base.fwtm,
    baseSigma: base.sigma,
    baseCentroid: base.centroid,
    analyticConfiguredSigmaMm,
    numericalSigmaResidualMm: finalStats.sigma - analyticConfiguredSigmaMm,
    profile: finalProfile,
    ...finalStats,
  };
}

function createProfileAssumptions(rawParams) {
  const p = validateParams(rawParams);
  return {
    profileMode: PROFILE_MODES.LAYERED_RECT,
    candidateSelectionRule: "nearest-bracketing",
    candidateWeightShape: "linear-between-nearest-smaller-z-and-larger-z-candidates",
    candidateWeightHalfSupportMm: null,
    candidateWeightFwhmMm: null,
    sliceKernelShape: "rectangular",
    sliceKernelWidthMm: p.sliceThicknessMm,
    mapping: "configured-thickness-to-rectangular-kernel",
    geometryIndicator: "final-candidate-weighted-rms-with-row-aperture-over-configured-thickness",
    bracketAuditIndicator: p.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
      ? "angularly-weighted-180li-branch-bracketing-gap-over-configured-thickness"
      : "nearest-bracketing-gap-over-configured-thickness",
    reconstructionPath: p.reconstructionPath,
  };
}

function computeProfileModel(rawParams, options = {}) {
  const p = validateParams(rawParams);
  const assumptions = options.assumptions ?? createProfileAssumptions(p);
  return computeLayeredSsp(p, {
    state: options.state ?? p.state,
    coneOn: Boolean(options.coneOn),
    sliceKernelWidthMm: assumptions.sliceKernelWidthMm,
    collectGeometrySeries: Boolean(options.collectGeometrySeries),
    collectComplementaryCandidates: options.collectComplementaryCandidates,
    reconstructionPath: options.reconstructionPath
      ?? assumptions.reconstructionPath
      ?? p.reconstructionPath,
  });
}

function computeUnwrapped(rawParams, options = {}) {
  const p = validateParams(rawParams);
  const requestedState = Number(options.state ?? p.state);
  const state = ((requestedState % 1) + 1) % 1;
  const coneOn = Boolean(options.coneOn);
  const reconstructionPath = options.reconstructionPath ?? p.reconstructionPath;
  const samples = Math.max(90, Math.min(2400, Math.round(options.samples ?? Math.min(360, p.viewSamples))));
  const feed = tableFeedMm(p);
  const z0 = p.zReference + feed * state;
  // Traces include the 360-degree endpoint for a closed visual period.  SSPz
  // integration and marker weights use the non-duplicated samples 0 <= beta < 2pi.
  const traceSamples = samples + 1;
  const angleValues = new Float32Array(traceSamples);
  const axialValues = new Float64Array(traceSamples);
  const scaleValues = new Float32Array(traceSamples);
  const rho = p.radius / p.sourceRadius;
  for (let i = 0; i < traceSamples; i += 1) {
    const beta = PI2 * i / samples;
    angleValues[i] = 360 * i / samples;
    axialValues[i] = feed * beta / PI2;
    scaleValues[i] = coneOn
      ? Math.sqrt(Math.max(EPS, 1 + rho * rho - 2 * rho * Math.cos(beta - p.phase)))
      : 1;
  }
  const displayRows = Array.from({ length: p.rows }, (_, row) => row);
  const rowOffsets = Float64Array.from(displayRows, row => (row + 0.5 - p.rows / 2) * p.rowWidth);
  const centerTurn = roundHalfEven(z0 / feed);
  // The ideal helix is infinite.  The reproducible finite display contract is
  // every turn containing a row-wise nearest smaller-z or larger-z candidate over the
  // full 0-360 degree period, plus one neighboring turn on either side.
  let turnMin = Infinity;
  let turnMax = -Infinity;
  const endpointOffsets = rowOffsets.length > 1
    ? [rowOffsets[0], rowOffsets[rowOffsets.length - 1]]
    : [rowOffsets[0]];
  for (let i = 0; i < traceSamples; i += 1) {
    const beta = PI2 * i / samples;
    const distanceScale = Math.sqrt(Math.max(EPS, 1 + rho * rho - 2 * rho * Math.cos(beta - p.phase)));
    for (const scale of [1, distanceScale]) {
      for (const rowOffset of endpointOffsets) {
        const base = feed * beta / PI2 + scale * rowOffset;
        const quotient = (z0 - base) / feed;
        turnMin = Math.min(turnMin, Math.floor(quotient) - 1);
        turnMax = Math.max(turnMax, Math.ceil(quotient) + 1);
      }
    }
  }
  if (!Number.isFinite(turnMin) || !Number.isFinite(turnMax)) {
    turnMin = centerTurn - 2;
    turnMax = centerTurn + 2;
  }
  const turns = Int32Array.from({ length: turnMax - turnMin + 1 }, (_, index) => turnMin + index);
  const turnOffsetMin = turnMin - centerTurn;
  const turnOffsetMax = turnMax - centerTurn;
  const baseZoomXLimit = Math.max(1.65, p.rowWidth * 1.5);
  const weightedPoints = [];
  const viewWeightSums = new Float32Array(samples);
  let maximumWeightedDistance = 0;
  const markerStride = Math.max(
    1,
    Math.ceil(samples / 72),
    Math.ceil(samples * 2 / 12000),
  );
  let validViewCount = 0;
  let normalizationErrorMax = 0;
  for (let i = 0; i < samples; i += 1) {
    const mappedViewIndex = Math.min(
      p.viewSamples - 1,
      Math.floor(i * p.viewSamples / samples),
    );
    const beta = PI2 * mappedViewIndex / p.viewSamples;
    const geometry = reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
      ? fanBeam180LiGeometryAtView(p, z0, mappedViewIndex, coneOn)
      : geometryAtFullScanAngle(p, z0, beta, coneOn, {
        dataKind: "actual-full-scan",
        family: "direct",
        baseAbsoluteViewIndex: mappedViewIndex,
      });
    viewWeightSums[i] = geometry.normalizedWeightSum;
    if (geometry.valid) {
      validViewCount += 1;
      normalizationErrorMax = Math.max(normalizationErrorMax, Math.abs(1 - geometry.normalizedWeightSum));
    }
    if (i % markerStride !== 0) continue;
    for (const candidate of geometry.candidates) {
      if (candidate.weight <= EPS) continue;
      weightedPoints.push({
        x: candidate.delta,
        y: 360 * mappedViewIndex / p.viewSamples,
        weight: candidate.weight,
        dataKind: candidate.dataKind,
        row: candidate.row,
        turn: candidate.turn,
        turnOffset: candidate.turn - centerTurn,
        sampleIndex: i,
      });
      maximumWeightedDistance = Math.max(maximumWeightedDistance, Math.abs(candidate.delta));
    }
  }
  let maximumCandidateDistance = baseZoomXLimit;
  for (let i = 0; i < traceSamples; i += 1) {
    for (const turn of [turnMin, turnMax]) {
      for (const rowOffset of endpointOffsets) {
        const delta = axialValues[i] + turn * feed + scaleValues[i] * rowOffset - z0;
        maximumCandidateDistance = Math.max(maximumCandidateDistance, Math.abs(delta));
      }
    }
  }
  const overviewXLimit = maximumCandidateDistance + Math.max(0.35, p.rowWidth * 0.35);
  const zoomXLimit = Math.max(baseZoomXLimit, maximumWeightedDistance + Math.max(0.15, p.rowWidth * 0.15));
  const usedTurns = [...new Set(weightedPoints.map(point => point.turnOffset))].sort((a, b) => a - b);
  const usedTurnsOutsideOverview = usedTurns.filter(turn => turn < turnOffsetMin || turn > turnOffsetMax);
  const complementaryCandidates = computeComplementaryCandidateSeries(p, z0, coneOn);
  return {
    coneOn,
    reconstructionPath,
    state,
    z0,
    configuredSliceThicknessMm: p.sliceThicknessMm,
    // Public diagram contract: acquisition-side candidates are every detector-
    // row centre in each displayed acquired view.  Configured slice thickness
    // is applied later to the explanatory SSPz and never filters this pool.
    candidatePopulation: "all-detector-row-centers",
    candidatePoolDefinition: "all-detector-row-centers-in-displayed-acquired-views",
    candidatePoolUsesConfiguredSliceThickness: false,
    sliceThicknessThresholdUsed: false,
    rowTraceWeighting: "none",
    rowsPerAcquiredView: p.rows,
    selectedEndpointStage: "nearest-bracketing-after-all-row-pool",
    doesNotRestrictCandidatePopulation: true,
    candidateSelectionRule: reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
      ? "fan-beam-180li-angular-neighbor-interpolation-after-direct-complementary-union-z-bracketing"
      : "direct-full-scan-nearest-bracketing-linear",
    candidateWeightHalfSupportMm: null,
    kernelWidth: null,
    interpolationBandHalfWidth: maximumWeightedDistance,
    xLimit: zoomXLimit,
    zoomXLimit,
    overviewXLimit,
    traceGeometry: {
      angles: angleValues,
      axial: axialValues,
      scales: scaleValues,
      rowOffsets,
      turns,
      feed,
    },
    weightedPoints,
    displayedRows: displayRows.length,
    displayRows,
    totalRows: p.rows,
    centerTurn,
    turnMin,
    turnMax,
    turnCount: turns.length,
    turnOffsetMin,
    turnOffsetMax,
    candidateLineCount: p.rows * turns.length,
    actualDataFamilyCount: reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI ? 2 : 1,
    angularRangeDeg: 360,
    complementaryCandidates,
    viewWeightSums,
    validViewCount,
    normalizationErrorMax,
    automaticTurnRange: true,
    searchTurnRadius: null,
    usedTurns,
    usedTurnsOutsideOverview,
    markerStride,
    renderedAngleSamples: Math.ceil(samples / markerStride),
    samples,
  };
}

function summarizeSweep(rows, coneOn) {
  const complete = rows.filter(row => row.coneOn === coneOn && row.coverage >= 1 - 1e-12);
  const range = key => {
    if (!complete.length) return { min: NaN, max: NaN, range: NaN };
    const values = complete.map(row => row[key]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { min, max, range: max - min };
  };
  return {
    coneOn,
    complete: complete.length,
    total: rows.filter(row => row.coneOn === coneOn).length,
    fwhm: range("fwhm"),
    fwtm: range("fwtm"),
    sigma: range("sigma"),
    centroid: range("centroid"),
    baseFwhm: range("baseFwhm"),
    baseFwtm: range("baseFwtm"),
    baseSigma: range("baseSigma"),
    baseCentroid: range("baseCentroid"),
    bracketGapMeanMm: range("bracketGapMeanMm"),
    bracketGapMaxMm: range("bracketGapMaxMm"),
    bracketGapRatioMean: range("bracketGapRatioMean"),
    bracketGapRatioMax: range("bracketGapRatioMax"),
    exactCandidateFraction: range("exactCandidateFraction"),
    analyticBaseSigmaMm: range("analyticBaseSigmaMm"),
    analyticConfiguredSigmaMm: range("analyticConfiguredSigmaMm"),
    numericalSigmaResidualMm: range("numericalSigmaResidualMm"),
  };
}

let cancelled = false;
let activeContext = null;
const yieldToMessages = () => new Promise(resolve => setTimeout(resolve, 0));
const OVERLAY_STATE_COUNT = 360;
const OVERLAY_MAX_Z_POINTS = 1000;

function overlaySampleIndices(length) {
  const count = Math.min(length, OVERLAY_MAX_Z_POINTS);
  if (count === length) return Array.from({ length }, (_, index) => index);
  return Array.from({ length: count }, (_, index) => Math.round(index * (length - 1) / (count - 1)));
}

function createOverlayCondition(stateCount, zCount, angleCount) {
  return {
    coverage: new Float32Array(stateCount),
    base: new Float32Array(stateCount * zCount),
    final: new Float32Array(stateCount * zCount),
    gapRatio: new Float32Array(stateCount * angleCount),
    spreadRatio: new Float32Array(stateCount * angleCount),
    candidateCount: new Uint16Array(stateCount * angleCount),
    effectiveCandidateCount: new Float32Array(stateCount * angleCount),
    candidateContributionCount: new Uint16Array(stateCount * angleCount),
  };
}

function copyOverlayProfile(target, stateIndex, sampleIndices, profile) {
  const offset = stateIndex * sampleIndices.length;
  for (let i = 0; i < sampleIndices.length; i += 1) {
    target[offset + i] = profile[sampleIndices[i]];
  }
}

function copyGeometrySeries(target, stateIndex, sampleIndices, series) {
  const offset = stateIndex * sampleIndices.length;
  for (let i = 0; i < sampleIndices.length; i += 1) {
    target[offset + i] = series[sampleIndices[i]];
  }
}

function summarizeOverlayProfiles(values, coverage, stateCount, zCount) {
  const completeStates = [];
  for (let stateIndex = 0; stateIndex < stateCount; stateIndex += 1) {
    if (coverage[stateIndex] >= 1 - 1e-7) completeStates.push(stateIndex);
  }
  const includedStates = completeStates.length ? completeStates : Array.from({ length: stateCount }, (_, index) => index);
  const maximum = new Float32Array(zCount);
  for (let zIndex = 0; zIndex < zCount; zIndex += 1) {
    let hi = -Infinity;
    for (let i = 0; i < includedStates.length; i += 1) {
      const value = values[includedStates[i] * zCount + zIndex];
      hi = Math.max(hi, value);
    }
    maximum[zIndex] = hi;
  }
  return {
    maximum,
    completeCount: completeStates.length,
    summaryFallbackToAllStates: completeStates.length === 0,
  };
}

function finalizeOverlayCondition(condition, stateCount, zCount) {
  condition.baseSummary = summarizeOverlayProfiles(condition.base, condition.coverage, stateCount, zCount);
  condition.finalSummary = summarizeOverlayProfiles(condition.final, condition.coverage, stateCount, zCount);
  return condition;
}

function overlayTransferList(overlay) {
  const arrays = [
    overlay.z,
    overlay.states,
    overlay.geometryAnglesDeg,
    overlay.allCandidateAxialSpreadOffMm,
    overlay.allCandidateAxialSpreadOnMm,
  ];
  for (const condition of [overlay.off, overlay.on]) {
    arrays.push(
      condition.coverage,
      condition.base,
      condition.final,
      condition.gapRatio,
      condition.spreadRatio,
      condition.candidateCount,
      condition.effectiveCandidateCount,
      condition.candidateContributionCount,
    );
    for (const summary of [condition.baseSummary, condition.finalSummary]) {
      arrays.push(summary.maximum);
    }
  }
  return arrays.map(array => array.buffer);
}

self.onmessage = async event => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelled = true;
    return;
  }
  if (message.type === "inspect-state") {
    if (!activeContext) return self.postMessage({ type: "error", message: "Compute all 360 model states first." });
    try {
      const stateIndex = ((Math.round(Number(message.stateIndex)) % 360) + 360) % 360;
      const state = stateIndex / 360;
      const { params, assumptions, diagramSamples } = activeContext;
      const selectedOff = computeProfileModel(params, { state, coneOn: false, assumptions });
      const selectedOn = computeProfileModel(params, { state, coneOn: true, assumptions });
      const diagramOff = computeUnwrapped(params, { state, coneOn: false, samples: diagramSamples });
      const diagramOn = computeUnwrapped(params, { state, coneOn: true, samples: diagramSamples });
      return self.postMessage({
        type: "inspection-result",
        stateIndex,
        state,
        selectedOff,
        selectedOn,
        diagramOff,
        diagramOn,
      });
    } catch (error) {
      return self.postMessage({ type: "error", message: error?.message ?? String(error), stack: error?.stack ?? "" });
    }
  }
  if (message.type !== "run") return;
  cancelled = false;
  activeContext = null;
  try {
    const params = validateParams(message.params);
    self.postMessage({ type: "progress", value: 0.01, label: "Applying the configured slice thickness and assumed weights" });
    const assumptions = createProfileAssumptions(params);
    if (cancelled) return self.postMessage({ type: "cancelled" });

    const acquisitionLabel = params.reconstructionPath === RECONSTRUCTION_PATHS.DIRECT_FULL_SCAN
      ? "Direct-ray 0-360° full scan (comparator)"
      : "180LI acquisition geometry (primary analysis)";
    self.postMessage({ type: "progress", value: 0.04, label: `Computing the selected-state SSPz and diagram using ${acquisitionLabel}` });
    const selectedOff = computeProfileModel(params, { state: params.state, coneOn: false, assumptions });
    const selectedOn = computeProfileModel(params, { state: params.state, coneOn: true, assumptions });
    const diagramSamples = Math.min(360, params.viewSamples);
    activeContext = { params, assumptions, diagramSamples };
    const diagramOff = computeUnwrapped(params, { state: params.state, coneOn: false, samples: diagramSamples });
    const diagramOn = computeUnwrapped(params, { state: params.state, coneOn: true, samples: diagramSamples });
    if (cancelled) return self.postMessage({ type: "cancelled" });

    const overlayStates = Array.from({ length: OVERLAY_STATE_COUNT }, (_, index) => index / OVERLAY_STATE_COUNT);
    const sweepStates = Array.from({ length: params.stateSamples }, (_, index) => index / params.stateSamples);
    const jobs = new Map();
    const addJob = (state, kind, index) => {
      const key = state.toFixed(12);
      if (!jobs.has(key)) jobs.set(key, { state, sweepIndex: null, overlayIndex: null });
      jobs.get(key)[kind] = index;
    };
    sweepStates.forEach((state, index) => addJob(state, "sweepIndex", index));
    overlayStates.forEach((state, index) => addJob(state, "overlayIndex", index));
    const orderedJobs = [...jobs.values()].sort((a, b) => a.state - b.state);

    const sampleIndices = overlaySampleIndices(selectedOff.z.length);
    const zCount = sampleIndices.length;
    // Preserve every acquired view in the angle-state map. Decimating (for
    // example, 1200 acquired views to 360 display columns) changes the sampled
    // angles and can hide acquisition-grid structure. The map therefore uses
    // the same view grid as each SSPz calculation.
    const geometryAngleCount = params.viewSamples;
    const geometrySampleIndices = Array.from({ length: geometryAngleCount }, (_, index) => index);
    // This acquisition-side quantity depends only on the entered geometry and
    // relative tube angle.  It is independent of the reconstruction-plane
    // position sweep, interpolation weights, and configured slice thickness,
    // so calculate each geometry condition exactly once per run.
    const allCandidateAxialSpreadOff = computeAllCandidateAxialSpreadSeries(params, { coneOn: false });
    const allCandidateAxialSpreadOn = computeAllCandidateAxialSpreadSeries(params, { coneOn: true });
    const overlay = {
      stateCount: OVERLAY_STATE_COUNT,
      zCount,
      z: Float32Array.from(sampleIndices, index => selectedOff.z[index]),
      states: Float32Array.from(overlayStates),
      coordinate: "z-minus-z0-native",
      normalization: "each-profile-peak-normalized-to-one",
      stateMeaning: "relative-reconstruction-state-within-one-table-feed-per-rotation",
      reconstructionPath: params.reconstructionPath,
      acquisitionModel: params.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
        ? "fan-beam-180li-acquisition-geometry-explanatory-model"
        : "actual-data-only-full-scan-0-to-360-degrees",
      fullScanViewSamples: params.viewSamples,
      displayDecimated: zCount < selectedOff.z.length,
      sourceZCount: selectedOff.z.length,
      geometryAngleCount,
      geometryAnglesDeg: Float32Array.from({ length: geometryAngleCount }, (_, index) => 360 * index / geometryAngleCount),
      geometryAngularSampling: "all-acquired-views-no-decimation",
      allCandidateAxialSpreadOffMm: allCandidateAxialSpreadOff.populationStdMm,
      allCandidateAxialSpreadOnMm: allCandidateAxialSpreadOn.populationStdMm,
      allCandidateAxialSpreadMetadata: {
        unit: "mm",
        weighting: "none",
        sliceThicknessUsed: false,
        stateInvariant: true,
        candidateSet: "direct-N-rows-plus-all-rows-of-distinct-acquired-complementary-views-bracketing-beta-c",
        candidateIdentity: "absoluteViewIndex,row",
        statistic: "unweighted-population-standard-deviation-of-row-centre-z",
        rowApertureUsed: false,
        nearestCandidateSelectionUsed: false,
      },
      geometryIndicator: "final-candidate-weighted-rms-with-row-aperture-over-configured-thickness",
      bracketAuditIndicator: params.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
        ? "angularly-weighted-180li-branch-bracketing-gap-over-configured-thickness"
        : "nearest-bracketing-gap-over-configured-thickness",
      spreadIndicator: "final-candidate-weighted-rms-with-row-aperture-over-configured-thickness",
      candidateCountIndicator: "unique-physical-final-nonzero-candidate-count-after-angular-branch-duplicate-merging",
      candidateCountWeightThreshold: 1e-12,
      candidateUniquenessKey: "absoluteViewIndex,row; turn,centerMm,apertureMm-consistency-checked-at-1e-9-mm",
      candidateBranchDuplicateHandling: "sum-weights-of-identical-physical-candidates-before-count-and-effective-count",
      effectiveCandidateCountIndicator: "inverse-simpson-effective-count-from-merged-normalized-final-candidate-weights",
      candidateContributionCountIndicator: "pre-merge-final-nonzero-angular-branch-contribution-count",
      off: createOverlayCondition(OVERLAY_STATE_COUNT, zCount, geometryAngleCount),
      on: createOverlayCondition(OVERLAY_STATE_COUNT, zCount, geometryAngleCount),
    };
    const sweepRows = new Array(params.stateSamples * 2);
    const total = orderedJobs.length * 2;
    let completed = 0;
    let lastYield = performance.now();
    for (const job of orderedJobs) {
      const state = job.state;
      for (const coneOn of [false, true]) {
        const result = computeProfileModel(params, {
          state,
          coneOn,
          assumptions,
          collectGeometrySeries: job.overlayIndex != null,
          // The selected-state unwrapped calculation already retains the full
          // Section 2C audit.  Rebuilding that audit for every overlay state is
          // unnecessary and substantially increases run time.
          collectComplementaryCandidates: false,
        });
        if (job.sweepIndex != null) {
          sweepRows[job.sweepIndex * 2 + Number(coneOn)] = {
            stateIndex: job.sweepIndex,
            state,
            z0: result.z0,
            coneOn,
            reconstructionPath: result.reconstructionPath,
            dataKind: result.dataKind,
            candidateRayFamilyCount: result.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI ? 2 : 1,
            candidateSelectionRule: result.candidateSelectionRule,
            fwhm: result.fwhm,
            fwtm: result.fwtm,
            sigma: result.sigma,
            coverage: result.coverage,
            area: result.area,
            centroid: result.centroid,
            halfComponents: result.halfComponents,
            baseFwhm: result.baseFwhm,
            baseFwtm: result.baseFwtm,
            baseSigma: result.baseSigma,
            baseCentroid: result.baseCentroid,
            bracketGapMeanMm: result.bracketGapMeanMm,
            bracketGapMaxMm: result.bracketGapMaxMm,
            bracketGapRatioMean: result.bracketGapRatioMean,
            bracketGapRatioMax: result.bracketGapRatioMax,
            exactCandidateFraction: result.exactCandidateFraction,
            maximumViewContributionError: result.maximumViewContributionError,
            maximumAngularInterpolationWeightError: result.maximumAngularInterpolationWeightError,
            maximumLongitudinalMomentResidualMm: result.maximumLongitudinalMomentResidualMm,
            preNormalizationArea: result.preNormalizationArea,
            preNormalizationPeak: result.preNormalizationPeak,
            meanKernelSecondMomentMm2: result.meanKernelSecondMomentMm2,
            analyticBaseSigmaMm: result.analyticBaseSigmaMm,
            analyticConfiguredSigmaMm: result.analyticConfiguredSigmaMm,
            numericalSigmaResidualMm: result.numericalSigmaResidualMm,
          };
        }
        if (job.overlayIndex != null) {
          const condition = coneOn ? overlay.on : overlay.off;
          condition.coverage[job.overlayIndex] = result.coverage;
          copyOverlayProfile(condition.final, job.overlayIndex, sampleIndices, result.profile);
          copyOverlayProfile(condition.base, job.overlayIndex, sampleIndices, result.baseProfile ?? result.profile);
          copyGeometrySeries(condition.gapRatio, job.overlayIndex, geometrySampleIndices, result.gapRatios);
          copyGeometrySeries(condition.spreadRatio, job.overlayIndex, geometrySampleIndices, result.viewKernelRmsRatio);
          copyGeometrySeries(
            condition.candidateCount,
            job.overlayIndex,
            geometrySampleIndices,
            result.viewCandidateCounts,
          );
          copyGeometrySeries(
            condition.effectiveCandidateCount,
            job.overlayIndex,
            geometrySampleIndices,
            result.viewEffectiveCandidateCounts,
          );
          copyGeometrySeries(
            condition.candidateContributionCount,
            job.overlayIndex,
            geometrySampleIndices,
            result.viewCandidateContributionCounts,
          );
        }
        completed += 1;
        if (performance.now() - lastYield >= 25 || completed === total) {
          self.postMessage({
            type: "progress",
            value: 0.08 + 0.90 * completed / total,
            label: `${acquisitionLabel}: computing SSPz curves and width metrics for 360 states ${completed}/${total}`,
          });
          await yieldToMessages();
          lastYield = performance.now();
          if (cancelled) return self.postMessage({ type: "cancelled" });
        }
      }
    }
    const sweep = sweepRows;
    finalizeOverlayCondition(overlay.off, OVERLAY_STATE_COUNT, zCount);
    finalizeOverlayCondition(overlay.on, OVERLAY_STATE_COUNT, zCount);
    const summaries = {
      off: summarizeSweep(sweep, false),
      on: summarizeSweep(sweep, true),
    };
    const result = {
      params,
      tableFeed: tableFeedMm(params),
      assumptions,
      selectedOff,
      selectedOn,
      diagramOff,
      diagramOn,
      overlay,
      sweep,
      summaries,
    };
    self.postMessage({
      type: "result",
      result,
    }, overlayTransferList(overlay));
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message ?? String(error), stack: error?.stack ?? "" });
  }
};
