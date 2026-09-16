"use strict";
const MODEL_VERSION = "2026-09-08.1";

const PROFILE_MODES = Object.freeze({
  TAGUCHI_FILTER: "taguchi-filter",
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
  filterWidthMm: 1.0,
  filterSamples: 129,
  profileMode: PROFILE_MODES.TAGUCHI_FILTER,
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

function validateParams(input, { allowZeroPitch = false } = {}) {
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
    // FW is a reconstruction-filter parameter, NOT a prescribed SSP FWHM.
    // A missing legacy FW is initialized from T only once. Callers retain the
    // explicit returned FW when T is subsequently changed.
    filterWidthMm: Number(input.filterWidthMm ?? input.sliceThicknessMm ?? input.targetFwhm),
    filterSamples: Number(input.filterSamples ?? 129),
    filterWidthInitialization: input.filterWidthInitialization
      ?? (input.filterWidthMm == null ? "legacy-T-initialization-uncalibrated" : "explicit-independent-FW"),
    profileMode: PROFILE_MODES.TAGUCHI_FILTER,
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
  if (p.beamPitch < 0 || (!allowZeroPitch && p.beamPitch === 0) || p.beamPitch > 3) throw new Error("Set the beam pitch to a value greater than 0 and no greater than 3.");
  if (p.sourceRadius <= 0) throw new Error("The source-to-isocenter distance must be positive.");
  if (p.radius > 250) throw new Error("Set the radial distance from isocenter to a value from 0 to 250 mm.");
  if (p.radius >= p.sourceRadius) throw new Error("The radial distance from isocenter must be smaller than the source-to-isocenter distance.");
  if (p.sliceThicknessMm <= 0 || p.sliceThicknessMm > 20) throw new Error("Set the configured slice thickness to a value greater than 0 and no greater than 20 mm.");
  if (p.filterWidthMm < 0 || p.filterWidthMm > 20) throw new Error("Set filter width FW between 0 and 20 mm.");
  if (!Number.isInteger(p.filterSamples) || p.filterSamples < 33 || p.filterSamples > 2049
    || p.filterSamples % 2 !== 1) throw new Error("Set filter resampling count to an odd integer between 33 and 2049.");
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

/** Legacy fixed-plane sensitivity kernel; retained for geometry diagnostics. */
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

/** Legacy fixed-plane kernel followed by rectangular averaging, comparison only. */
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
    modelStatus: "legacy-comparison-only",
    responseDefinition: "fixed-reconstruction-plane-sensitivity-kernel-post-averaged",
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

// Taguchi and Aradate (1998), Fig. 5 and Eq. (6): first interpolate the
// ACQUIRED data at each zf(i)=zRecon+i*FW/(2I+1), then filter these values.
// The acquired response below is held fixed as zRecon moves. It must not be
// replaced by computeSsp(zRecon=zObject) followed by a window on object z.
// The projected rectangular row aperture and off-axis/angular-neighbour
// geometry are explicit extensions of this simulator, not a reproduction of
// all optimized-sampling / fan-beam FBP steps of the original paper.

function taguchiAcquiredFamilyKnots(p, zObject, angleRad, coneOn, searchHalfWidth) {
  const feed = tableFeedMm(p);
  const rho = p.radius / p.sourceRadius;
  const scale = coneOn
    ? Math.sqrt(Math.max(EPS, 1 + rho * rho - 2 * rho * Math.cos(angleRad - p.phase)))
    : 1;
  const aperture = p.rowWidth * scale;
  const first = feed * angleRad / PI2 + (0.5 - p.rows / 2) * aperture;
  const last = first + (p.rows - 1) * aperture;
  const left = zObject - searchHalfWidth;
  const right = zObject + searchHalfWidth;
  // All signal-bearing row centres lie inside [left,right]. For each
  // intersecting row band retain its nearest outside centre on both sides.
  // Adjacent exterior turns provide zero-valued guards when bands have gaps.
  // Thus every nonzero interpolation segment has its true nearest endpoints;
  // FW does not truncate the acquisition search and T is not used here.
  const firstTurn = Math.floor((left - last) / feed) - 1;
  const lastTurn = Math.ceil((right - first) / feed) + 1;
  const knots = [];
  for (let turn = firstTurn; turn <= lastTurn; turn += 1) {
    const firstAtTurn = first + turn * feed;
    const firstRow = Math.max(0, Math.min(p.rows - 1,
      Math.floor((left - firstAtTurn) / aperture)));
    const lastRow = Math.max(0, Math.min(p.rows - 1,
      Math.ceil((right - firstAtTurn) / aperture)));
    for (let row = firstRow; row <= lastRow; row += 1) {
      const offset = firstAtTurn + row * aperture - zObject;
      const boundaryDistance = Math.abs(offset) - aperture / 2;
      // The half-height boundary is the symmetric thin-bead limit of a
      // rectangular detector aperture, avoiding double-height edge ties.
      const response = Math.abs(boundaryDistance) <= 1e-10
        ? 0.5 / aperture
        : boundaryDistance < 0 ? 1 / aperture : 0;
      knots.push({ x: offset, y: response });
    }
  }
  return knots;
}

function taguchiBranchEvents(familyKnots, weight, events) {
  if (!(weight > 0)) return false;
  const ordered = familyKnots.flat().sort((a, b) => a.x - b.x);
  const knots = [];
  for (let index = 0; index < ordered.length;) {
    const x = ordered[index].x;
    let sum = 0;
    let count = 0;
    while (index < ordered.length && Math.abs(ordered[index].x - x) <= 1e-10) {
      sum += ordered[index].y;
      count += 1;
      index += 1;
    }
    // Coincident longitudinal samples share the endpoint weight, consistently
    // with the existing equal-z acquired-candidate policy.
    knots.push({ x, y: sum / count });
  }
  let signal = false;
  for (let i = 0; i + 1 < knots.length; i += 1) {
    const left = knots[i];
    const right = knots[i + 1];
    if (!(left.y > 0 || right.y > 0)) continue;
    signal = true;
    const slope = (right.y - left.y) / (right.x - left.x) * weight;
    // Slope-change events represent the full piecewise-linear interpolation
    // exactly, rather than sampling and re-interpolating it on the SSP grid.
    events.push({ x: left.x, slope, jump: left.y * weight });
    events.push({ x: right.x, slope: -slope, jump: -right.y * weight });
  }
  return signal;
}

function taguchiForwardKnots(p, zObject, coneOn, reconstructionPath) {
  const events = [];
  const searchHalfWidth = p.rowWidth * (1 + p.radius / p.sourceRadius) / 2 + 1e-8;
  let respondingViews = 0;
  let acquiredBranchCount = 0;
  for (let view = 0; view < p.viewSamples; view += 1) {
    const beta = PI2 * view / p.viewSamples;
    const direct = taguchiAcquiredFamilyKnots(p, zObject, beta, coneOn, searchHalfWidth);
    if (reconstructionPath === RECONSTRUCTION_PATHS.DIRECT_FULL_SCAN) {
      if (taguchiBranchEvents([direct], 1 / p.viewSamples, events)) respondingViews += 1;
      acquiredBranchCount += 1;
      continue;
    }
    const complementary = fanBeamComplementaryGeometryAtAngle(p, beta, coneOn);
    const acquired = acquiredViewMapping(p, complementary.complementaryAngleUnwrappedRad);
    const sameView = acquired.lowerAbsoluteViewIndex === acquired.upperAbsoluteViewIndex;
    const alpha = sameView ? 0 : Math.max(0, Math.min(1, acquired.angularInterpolationFraction));
    const branches = [[acquired.lowerAngleUnwrappedRad, 1 - alpha]];
    if (!sameView && alpha > 0) branches.push([acquired.upperAngleUnwrappedRad, alpha]);
    let viewHasSignal = false;
    for (const [angle, angularWeight] of branches) {
      if (!(angularWeight > 0)) continue;
      const other = taguchiAcquiredFamilyKnots(p, zObject, angle, coneOn, searchHalfWidth);
      viewHasSignal = taguchiBranchEvents(
        [direct, other], angularWeight / p.viewSamples, events,
      ) || viewHasSignal;
      acquiredBranchCount += 1;
    }
    if (viewHasSignal) respondingViews += 1;
  }
  events.sort((a, b) => a.x - b.x);
  const knots = [];
  let value = 0;
  let slope = 0;
  let previousX = events[0]?.x ?? 0;
  for (let i = 0; i < events.length;) {
    const x = events[i].x;
    value += slope * (x - previousX);
    let slopeChange = 0;
    let valueJump = 0;
    while (i < events.length && events[i].x === x) {
      slopeChange += events[i].slope;
      valueJump += events[i].jump;
      i += 1;
    }
    value += valueJump;
    slope += slopeChange;
    knots.push({ x, y: Math.max(0, value) });
    previousX = x;
  }
  // The finite acquired response has exactly zero support outside the guards.
  // Remove only floating-point accumulation at those known zero endpoints.
  if (knots.length) {
    knots[0].y = 0;
    knots[knots.length - 1].y = 0;
  }
  return { knots, respondingViews, acquiredBranchCount };
}

function taguchiPiecewiseMoments(knots) {
  let area = 0;
  let first = 0;
  let second = 0;
  for (let i = 0; i + 1 < knots.length; i += 1) {
    const a = knots[i];
    const b = knots[i + 1];
    const h = b.x - a.x;
    const dy = b.y - a.y;
    const localArea = h * (a.y + dy / 2);
    const localFirst = h * h * (a.y / 2 + dy / 3);
    const localSecond = h * h * h * (a.y / 3 + dy / 4);
    area += localArea;
    first += a.x * localArea + localFirst;
    second += a.x * a.x * localArea + 2 * a.x * localFirst + localSecond;
  }
  const centroid = area > EPS ? first / area : 0;
  const variance = area > EPS ? Math.max(0, second / area - centroid * centroid) : 0;
  return { area, centroid, variance, sigma: Math.sqrt(variance) };
}

function taguchiEvaluateFilter(knots, z, fw, samples) {
  const out = new Float64Array(z.length);
  if (knots.length < 2) return out;
  const count = fw > 0 ? samples : 1;
  const halfCount = (count - 1) / 2;
  const step = fw / count;
  const dz = z[1] - z[0];
  const leftSupport = knots[0].x;
  const rightSupport = knots[knots.length - 1].x;
  // Angular averaging commutes with Eq. (6)'s finite, normalized linear sum.
  // For every offset, evaluate the exact acquired-data piecewise-linear
  // function at zRecon+i*FW/K. No continuous-window approximation is used.
  for (let sample = -halfCount; sample <= halfCount; sample += 1) {
    const shift = sample * step;
    const first = Math.max(0, Math.ceil((leftSupport - shift - z[0]) / dz));
    const last = Math.min(z.length - 1, Math.floor((rightSupport - shift - z[0]) / dz));
    let segment = 0;
    for (let index = first; index <= last; index += 1) {
      const x = z[index] + shift;
      while (segment + 1 < knots.length - 1 && knots[segment + 1].x < x) segment += 1;
      const a = knots[segment];
      const b = knots[segment + 1];
      const fraction = Math.max(0, Math.min(1, (x - a.x) / (b.x - a.x)));
      out[index] += (a.y + fraction * (b.y - a.y)) / count;
    }
  }
  return out;
}

/** Fixed axial impulse, moving reconstruction plane, Taguchi Eq. (6). */
function computeTaguchiSsp(rawParams, options = {}) {
  const p = validateParams(rawParams);
  const stateInput = Number(options.state ?? p.state);
  const state = ((stateInput % 1) + 1) % 1;
  const coneOn = Boolean(options.coneOn);
  const reconstructionPath = options.reconstructionPath ?? p.reconstructionPath;
  if (!Object.values(RECONSTRUCTION_PATHS).includes(reconstructionPath)) {
    throw new Error(`Unsupported acquisition-geometry model: ${reconstructionPath}`);
  }
  const filterWidthMm = Number(options.filterWidthMm ?? p.filterWidthMm);
  const filterSamples = Number(options.filterSamples ?? p.filterSamples);
  if (!Number.isFinite(filterWidthMm) || filterWidthMm < 0 || filterWidthMm > 20
    || !Number.isInteger(filterSamples) || filterSamples < 33 || filterSamples > 2049
    || filterSamples % 2 !== 1) throw new Error("Filter width or resampling count is out of range.");
  const zObject = p.zReference + state * tableFeedMm(p);
  const forward = taguchiForwardKnots(p, zObject, coneOn, reconstructionPath);
  const moments = taguchiPiecewiseMoments(forward.knots);
  const maximumAperture = p.rowWidth * (1 + p.radius / p.sourceRadius);
  const maxDz = Math.max(2 * p.rowWidth,
    tableFeedMm(p) + maximumAperture / 2 + MAX_CONFIGURED_SLICE_THICKNESS_MM / 2 + p.rowWidth);
  // Same grid for both cone settings, every object state, every FW and T.
  const targetDz = Math.max(p.rowWidth / 64, 0.00025);
  const requestedInternalZCells = Math.max(p.zSamples, Math.ceil(2 * maxDz / targetDz));
  const zCount = oddCellCountAtLeast(requestedInternalZCells);
  const z = uniformCellCenters(-maxDz, maxDz, zCount);
  const dz = 2 * maxDz / zCount;
  const rawBase = taguchiEvaluateFilter(forward.knots, z, 0, 1);
  const rawFinal = filterWidthMm > 0
    ? taguchiEvaluateFilter(forward.knots, z, filterWidthMm, filterSamples)
    : rawBase.slice();
  let basePeak = 0;
  let finalPeak = 0;
  let finalArea = 0;
  for (let i = 0; i < zCount; i += 1) {
    basePeak = Math.max(basePeak, rawBase[i]);
    finalPeak = Math.max(finalPeak, rawFinal[i]);
    finalArea += rawFinal[i] * dz;
  }
  const baseProfile = Array.from(rawBase, value => basePeak > 0 ? value / basePeak : 0);
  const profile = Array.from(rawFinal, value => finalPeak > 0 ? value / finalPeak : 0);
  const baseStats = profileStats(baseProfile, z, dz);
  const finalStats = profileStats(profile, z, dz);
  // Preserve only the explicitly identified, unfiltered REFERENCE-PLANE
  // geometry diagnostics. They are not the contributors across the FW window.
  const reference = computeSsp(p, {
    state, coneOn, reconstructionPath,
    collectGeometrySeries: Boolean(options.collectGeometrySeries),
    collectComplementaryCandidates: options.collectComplementaryCandidates,
  });
  const filterShiftVarianceMm2 = filterWidthMm > 0
    ? filterWidthMm ** 2 * (filterSamples ** 2 - 1) / (12 * filterSamples ** 2) : 0;
  const analyticConfiguredSigmaMm = Math.sqrt(moments.variance + filterShiftVarianceMm2);
  const minimumProjectedRowApertureMm = p.rowWidth
    * (coneOn ? 1 - p.radius / p.sourceRadius : 1);
  const filterSampleStepMm = filterWidthMm > 0 ? filterWidthMm / filterSamples : 0;
  // Resolution screens are explicit advisory checks, not a substitute for
  // comparing K with 2K-1 or for the independently tested finite Eq. (6).
  const recommendedFilterSamples = oddCellCountAtLeast(Math.max(
    33, 8 * filterWidthMm / minimumProjectedRowApertureMm,
  ), Number.MAX_SAFE_INTEGER);
  const gridResolutionAdequate = dz <= minimumProjectedRowApertureMm / 16;
  const filterResamplingAdequate = filterSampleStepMm <= minimumProjectedRowApertureMm / 8;
  const relativeNumericalAreaError = moments.area > EPS
    ? Math.abs(finalArea - moments.area) / moments.area : null;
  const maximumFilterShift = filterWidthMm * (filterSamples - 1) / (2 * filterSamples);
  const supportWithinDomain = !forward.knots.length || (
    forward.knots[0].x - maximumFilterShift >= -maxDz
    && forward.knots[forward.knots.length - 1].x + maximumFilterShift <= maxDz
  );
  const profileValidity = !(moments.area > EPS)
    ? "no-acquired-response-to-fixed-object"
    : !(finalPeak > 0) ? "positive-analytic-response-missed-by-output-grid"
      : !supportWithinDomain ? "response-support-clipped-by-output-domain"
        : "positive-finite-response";
  if (profileValidity !== "positive-finite-response") {
    // Do not turn missing / unresolved reconstructed signal into a claimed
    // zero-millimetre width or a valid normalized SSP.
    finalStats.fwhm = NaN;
    finalStats.fwtm = NaN;
  }
  return {
    ...reference,
    state, z0: zObject, zObject, coneOn, reconstructionPath,
    profileMode: PROFILE_MODES.TAGUCHI_FILTER,
    modelStatus: "literature-based-reference-with-explicit-geometry-extensions",
    responseDefinition: "fixed-axial-impulse-moving-reconstruction-plane",
    fixedObjectResponseDefinition: "unit-area-projected-rectangular-row-aperture-half-height-at-exact-boundaries",
    axialCoordinateDefinition: "z-reconstruction-plane-minus-z-object",
    filterMethod: "Taguchi-Aradate-1998-Eq6-rectangular-filter-interpolation",
    filterEvaluation: "exact-finite-Eq6-sum-of-piecewise-linear-acquired-data-interpolation",
    filterWidthMm, filterSamples,
    filterResamplingStepMm: filterWidthMm / filterSamples,
    effectiveFilterSamples: filterWidthMm > 0 ? filterSamples : 1,
    filterWidthInitialization: p.filterWidthInitialization,
    filterWidthIsPrescribedFwhm: false,
    sliceKernelWidthMm: filterWidthMm,
    sliceKernelWidth: filterWidthMm,
    candidateSelectionRule: "adjacent-acquired-data-reselected-at-every-filter-resampling-position",
    candidateWeightHalfSupportMm: null,
    geometrySeriesDefinition: "unfiltered-fixed-reference-plane-diagnostics-not-FW-integrated-candidate-contributions",
    diagnosticStage: "reference-plane-FW0-geometry-not-filter-integrated-contributors",
    geometryIndicator: "reference-plane-FW0-candidate-weighted-rms-not-forward-response-sigma",
    dataKind: "Taguchi-filter-interpolation-with-explicit-off-axis-geometry-extension-no-transaxial-FBP",
    z: Array.from(z), profile, baseProfile,
    rawProfile: Array.from(rawFinal), rawBaseProfile: Array.from(rawBase),
    baseFwhm: baseStats.fwhm, baseFwtm: baseStats.fwtm,
    baseSigma: baseStats.sigma, baseCentroid: baseStats.centroid,
    actualZSamples: zCount, requestedInternalZCells,
    internalZCountCapped: requestedInternalZCells > MAX_INTERNAL_Z_CELLS,
    targetLongitudinalCellWidthMm: targetDz,
    longitudinalCellWidthMm: dz,
    longitudinalGridInterpretation: "exact-point-evaluations-at-uniform-reconstruction-plane-positions",
    longitudinalDomainHalfWidthMm: maxDz,
    preNormalizationPeak: finalPeak, basePreNormalizationPeak: basePeak,
    preNormalizationArea: finalArea,
    analyticForwardArea: moments.area,
    analyticForwardCentroidMm: moments.centroid,
    analyticBaseSigmaMm: moments.sigma,
    analyticConfiguredSigmaMm,
    analyticVarianceDefinition: "fixed-object-forward-response-variance-plus-finite-Eq6-filter-shift-variance",
    filterShiftVarianceMm2,
    minimumProjectedRowApertureMm,
    gridResolutionAdequate,
    filterResamplingAdequate,
    recommendedFilterSamples,
    filterResolutionCriterion: "advisory-FW-over-K-at-most-minimum-projected-row-aperture-over-eight-not-convergence-proof",
    relativeNumericalAreaError,
    supportWithinDomain,
    profileValidity,
    numericalSigmaResidualMm: finalStats.sigma - analyticConfiguredSigmaMm,
    meanKernelSecondMomentMm2: null,
    depositedArea: null, depositionAreaResidual: null, domainClippingAreaResidual: null,
    forwardPiecewiseKnotCount: forward.knots.length,
    fixedObjectRespondingViewFraction: forward.respondingViews / p.viewSamples,
    acquiredAngularBranchCount: forward.acquiredBranchCount,
    ...finalStats,
  };
}

function createProfileAssumptions(rawParams) {
  const p = validateParams(rawParams);
  return {
    profileMode: PROFILE_MODES.TAGUCHI_FILTER,
    responseDefinition: "fixed-axial-impulse-moving-reconstruction-plane",
    candidateSelectionRule: "adjacent-acquired-data-reselected-at-every-filter-resampling-position",
    candidateWeightShape: "Taguchi-Eq6-local-linear-resampling-then-normalized-rectangular-filter",
    candidateWeightHalfSupportMm: null,
    candidateWeightFwhmMm: null,
    sliceKernelShape: "rectangular",
    sliceKernelWidthMm: p.filterWidthMm,
    filterWidthMm: p.filterWidthMm,
    filterSamples: p.filterSamples,
    filterWidthInitialization: p.filterWidthInitialization,
    filterWidthIsPrescribedFwhm: false,
    mapping: "independent-filter-width-not-fitted-to-configured-thickness",
    geometryIndicator: "reference-plane-FW0-candidate-weighted-rms-not-forward-response-sigma",
    bracketAuditIndicator: p.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
      ? "angularly-weighted-180li-branch-bracketing-gap-over-configured-thickness"
      : "nearest-bracketing-gap-over-configured-thickness",
    reconstructionPath: p.reconstructionPath,
  };
}

function computeProfileModel(rawParams, options = {}) {
  const p = validateParams(rawParams);
  const assumptions = options.assumptions ?? createProfileAssumptions(p);
  const filterWidthMm = Number(options.filterWidthMm ?? assumptions.filterWidthMm ?? p.filterWidthMm);
  const requestedFilterSamples = Number(options.filterSamples ?? assumptions.filterSamples ?? p.filterSamples);
  if (!Number.isFinite(filterWidthMm) || filterWidthMm < 0 || filterWidthMm > 20
    || !Number.isInteger(requestedFilterSamples) || requestedFilterSamples < 33
    || requestedFilterSamples > 2049 || requestedFilterSamples % 2 !== 1) {
    throw new Error("Filter width or resampling count is out of range.");
  }
  // Public output uses the requested K as a MINIMUM numerical resolution.
  // Apply the same bound to cone-off and cone-on, so comparison differences
  // are not caused by unequal discretizations. This changes neither FW nor T.
  // The exported computeTaguchiSsp remains the literal fixed-K Eq. (6) API
  // for reproducing finite-K results and independent convergence tests.
  const minimumProjectedRowApertureMm = p.rowWidth * (1 - p.radius / p.sourceRadius);
  const accuracyRequiredFilterSamples = oddCellCountAtLeast(Math.max(
    33, 8 * filterWidthMm / minimumProjectedRowApertureMm,
  ), Number.MAX_SAFE_INTEGER);
  if (accuracyRequiredFilterSamples > 2049) {
    throw new Error(`FW=${filterWidthMm} mm requires at least ${accuracyRequiredFilterSamples} resampling points. This exceeds the current precision limit of 2049 points; no SSPz result is displayed for this condition.`);
  }
  const actualFilterSamples = Math.max(requestedFilterSamples, accuracyRequiredFilterSamples);
  const result = computeTaguchiSsp(p, {
    state: options.state ?? p.state,
    coneOn: Boolean(options.coneOn),
    filterWidthMm,
    filterSamples: actualFilterSamples,
    collectGeometrySeries: Boolean(options.collectGeometrySeries),
    collectComplementaryCandidates: options.collectComplementaryCandidates,
    reconstructionPath: options.reconstructionPath
      ?? assumptions.reconstructionPath
      ?? p.reconstructionPath,
  });
  return {
    ...result,
    requestedFilterSamples,
    accuracyRequiredFilterSamples,
    filterSamplesAdjustedForAccuracy: actualFilterSamples > requestedFilterSamples,
    filterSamplesAdjustmentRule: "requested-minimum-and-eight-samples-per-minimum-projected-row-aperture-shared-by-cone-settings",
  };
}

function computeUnwrapped(rawParams, options = {}) {
  const p = validateParams(rawParams, { allowZeroPitch: true });
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
  // Every displayed family uses the direct acquired-view angle as its common
  // reference coordinate.  A complementary family is reindexed onto that
  // coordinate, but keeps the source z and row scale of its OWN acquired view.
  // Use the complete acquired grid, independently of marker/display sampling,
  // so each selected endpoint has an exact corresponding trajectory sample.
  const traceFamilyDefinitions = [
    { id: "direct", family: "direct" },
    ...(reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI ? [
      { id: "complementary-lower", family: "complementary" },
      { id: "complementary-upper", family: "complementary" },
    ] : []),
  ];
  const acquiredTraceSamples = p.viewSamples + 1;
  const traceFamilies = traceFamilyDefinitions.map(definition => ({
    ...definition,
    angleCoordinate: "direct-reference-view-angle",
    acquiredAngleCoordinate: "base-absolute-acquisition-angle-before-turn",
    angles: new Float64Array(acquiredTraceSamples),
    axial: new Float64Array(acquiredTraceSamples),
    scales: new Float64Array(acquiredTraceSamples),
    acquiredAngles: new Float64Array(acquiredTraceSamples),
    absoluteViewIndices: new Int32Array(acquiredTraceSamples),
  }));
  const traceFamilyById = new Map(traceFamilies.map(family => [family.id, family]));
  const acquiredViewStepRad = PI2 / p.viewSamples;
  for (let viewIndex = 0; viewIndex < acquiredTraceSamples; viewIndex += 1) {
    const beta = acquiredViewStepRad * viewIndex;
    const complementaryAcquired = traceFamilies.length > 1
      ? acquiredViewMapping(p, fanBeamComplementaryGeometryAtAngle(p, beta, coneOn)
        .complementaryAngleUnwrappedRad)
      : null;
    for (const family of traceFamilies) {
      const absoluteViewIndex = family.id === "direct"
        ? viewIndex
        : family.id === "complementary-lower"
          ? complementaryAcquired.lowerAbsoluteViewIndex
          : complementaryAcquired.upperAbsoluteViewIndex;
      const acquiredAngle = acquiredViewStepRad * absoluteViewIndex;
      family.angles[viewIndex] = 360 * viewIndex / p.viewSamples;
      family.absoluteViewIndices[viewIndex] = absoluteViewIndex;
      family.acquiredAngles[viewIndex] = 360 * absoluteViewIndex / p.viewSamples;
      family.axial[viewIndex] = feed * acquiredAngle / PI2;
      family.scales[viewIndex] = coneOn
        ? Math.sqrt(Math.max(EPS, 1 + rho * rho - 2 * rho * Math.cos(acquiredAngle - p.phase)))
        : 1;
    }
  }
  const displayRows = Array.from({ length: p.rows }, (_, row) => row);
  const rowOffsets = Float64Array.from(displayRows, row => (row + 0.5 - p.rows / 2) * p.rowWidth);
  const centerTurn = feed === 0 ? 0 : roundHalfEven(z0 / feed);
  // The ideal helix is infinite.  The reproducible finite display contract is
  // every turn containing a row-wise nearest smaller-z or larger-z candidate in
  // ANY displayed family over the full reference-angle period, plus one
  // neighboring turn on either side.  Complementary base angles can enter the
  // next acquisition turn; their base turn must not be silently wrapped away.
  let turnMin = Infinity;
  let turnMax = -Infinity;
  const endpointOffsets = rowOffsets.length > 1
    ? [rowOffsets[0], rowOffsets[rowOffsets.length - 1]]
    : [rowOffsets[0]];
  for (let viewIndex = 0; feed > 0 && viewIndex < acquiredTraceSamples; viewIndex += 1) {
    const rangeViewIndices = new Set([viewIndex]);
    if (reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI) {
      // The two displayed conditions share one turn window.  Their fan-angle
      // mapping changes as well as their row scale, so bounds must include
      // BOTH complementary mappings and BOTH scale choices.  This union is
      // display-only: it adds no reconstruction candidates or weights.
      for (const rangeConeOn of [false, true]) {
        const beta = acquiredViewStepRad * viewIndex;
        const acquired = acquiredViewMapping(p,
          fanBeamComplementaryGeometryAtAngle(p, beta, rangeConeOn)
            .complementaryAngleUnwrappedRad);
        rangeViewIndices.add(acquired.lowerAbsoluteViewIndex);
        rangeViewIndices.add(acquired.upperAbsoluteViewIndex);
      }
    }
    for (const absoluteViewIndex of rangeViewIndices) {
      const acquiredAngle = acquiredViewStepRad * absoluteViewIndex;
      const sourceZ = feed * acquiredAngle / PI2;
      const distanceScale = Math.sqrt(Math.max(EPS,
        1 + rho * rho - 2 * rho * Math.cos(acquiredAngle - p.phase)));
      for (const scale of [1, distanceScale]) {
        for (const rowOffset of endpointOffsets) {
          const base = sourceZ + scale * rowOffset;
          const quotient = (z0 - base) / feed;
          turnMin = Math.min(turnMin, Math.floor(quotient) - 1);
          turnMax = Math.max(turnMax, Math.ceil(quotient) + 1);
        }
      }
    }
  }
  if (!Number.isFinite(turnMin) || !Number.isFinite(turnMax)) {
    turnMin = feed === 0 ? 0 : centerTurn - 2;
    turnMax = feed === 0 ? 0 : centerTurn + 2;
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
  for (let i = 0; feed > 0 && i < samples; i += 1) {
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
      const traceFamilyId = candidate.dataKind === "complementary-acquired-lower-angular-neighbor"
        ? "complementary-lower"
        : candidate.dataKind === "complementary-acquired-upper-angular-neighbor"
          ? "complementary-upper"
          : "direct";
      const traceFamily = traceFamilyById.get(traceFamilyId);
      const baseAbsoluteViewIndex = traceFamily.absoluteViewIndices[mappedViewIndex];
      weightedPoints.push({
        x: candidate.delta,
        y: 360 * mappedViewIndex / p.viewSamples,
        weight: candidate.weight,
        dataKind: candidate.dataKind,
        row: candidate.row,
        turn: candidate.turn,
        turnOffset: candidate.turn - centerTurn,
        sampleIndex: i,
        traceFamilyId,
        referenceViewIndex: mappedViewIndex,
        baseAbsoluteViewIndex,
        absoluteViewIndex: baseAbsoluteViewIndex + candidate.turn * p.viewSamples,
        baseAcquiredAngleDeg: traceFamily.acquiredAngles[mappedViewIndex],
        // Unlike y, this is the physical acquired angle, not a reference
        // angle.  It remains unwrapped and includes the candidate turn.
        acquiredAngleDeg: traceFamily.acquiredAngles[mappedViewIndex] + candidate.turn * 360,
      });
      maximumWeightedDistance = Math.max(maximumWeightedDistance, Math.abs(candidate.delta));
    }
  }
  let maximumCandidateDistance = Math.max(baseZoomXLimit, maximumWeightedDistance);
  for (const family of traceFamilies) {
    for (let i = 0; i < acquiredTraceSamples; i += 1) {
      for (const turn of [turnMin, turnMax]) {
        for (const rowOffset of endpointOffsets) {
          const delta = family.axial[i] + turn * feed + family.scales[i] * rowOffset - z0;
          maximumCandidateDistance = Math.max(maximumCandidateDistance, Math.abs(delta));
        }
      }
    }
  }
  const overviewXLimit = maximumCandidateDistance + Math.max(0.35, p.rowWidth * 0.35);
  const zoomXLimit = Math.max(baseZoomXLimit, maximumWeightedDistance + Math.max(0.15, p.rowWidth * 0.15));
  const usedTurns = [...new Set(weightedPoints.map(point => point.turnOffset))].sort((a, b) => a - b);
  const usedTurnsOutsideOverview = usedTurns.filter(turn => turn < turnOffsetMin || turn > turnOffsetMax);
  const complementaryCandidates = feed === 0 ? null : computeComplementaryCandidateSeries(p, z0, coneOn);
  return {
    geometryOnly: feed === 0,
    coneOn,
    reconstructionPath,
    state,
    z0,
    angleCoordinate: "direct-reference-view-angle",
    acquiredAngleCoordinate: "absolute-acquisition-angle-including-turn",
    traceFamilyAcquiredAngleCoordinate: "base-absolute-acquisition-angle-before-turn",
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
    traceFamilies,
    traceFamilyCount: traceFamilies.length,
    acquiredTraceSamples,
    referenceViewSamples: p.viewSamples,
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
    // Mapped traces are display representations, not unique acquired rows:
    // angular neighbors may coincide, and one acquired view may be reused.
    mappedCandidateLineCount: p.rows * turns.length * traceFamilies.length,
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

// Full-turn FDK on a helix, with acquired cylindrical detector data rebinned
// to a virtual flat detector. Sources and assumptions: FDK_METHOD.md.
// No scanner-specific algorithm, fitted width, z boxcar, or 180LI is used here.
const FDK_VERSION = '2026-09-14.1';
const FDK_DEFAULTS = Object.freeze({
  rows:80,rowWidth:.5,beamPitch:.5,sourceRadius:600,radius:100,
  viewSamples:360,phase:0,state:0,sphereDiameter:.65,channelWidth:.25,
  apertureSamples:8,xyExtent:1.5,xySamples:17,zExtent:3,zStep:.05,
  phaseCount:1,normalization:'minmax',
});
const FDK_TAU=2*Math.PI;
function fdkConfig(input={}) {
  const c={...FDK_DEFAULTS,...input};
  for(const k of Object.keys(FDK_DEFAULTS)) if(k!=='normalization'&&!Number.isFinite(c[k])) throw Error(`${k}: finite value required`);
  for(const [k,lo,hi] of [['rows',2,320],['viewSamples',90,2400],['apertureSamples',1,32],['xySamples',5,65],['phaseCount',1,360]])
    if(!Number.isInteger(c[k])||c[k]<lo||c[k]>hi)throw Error(`${k}: integer ${lo}–${hi} required`);
  for(const [k,lo,hi] of [['rowWidth',.05,10],['beamPitch',0,3],['sourceRadius',100,2000],['radius',0,250],['sphereDiameter',.1,10],['channelWidth',.05,1],['xyExtent',.5,10],['zExtent',1,20],['zStep',.01,.2],['state',0,1]])
    if(c[k]<lo||c[k]>hi)throw Error(`${k}: ${lo}–${hi} required`);
  if(c.xySamples%2!==1)throw Error('xySamples must be odd');
  if(c.radius+Math.SQRT2*c.xyExtent>=c.sourceRadius||c.xyExtent<c.sphereDiameter/2)throw Error('Local volume must contain the sphere and remain inside the source orbit');
  if(!['minmax','peak'].includes(c.normalization))throw Error('Unknown normalization');
  c.feed=c.rows*c.rowWidth*c.beamPitch;
  c.zSamples=2*Math.ceil(c.zExtent/c.zStep)+1;
  c.zStep=2*c.zExtent/(c.zSamples-1);
  c.channels=2*Math.ceil((Math.asin((c.radius+Math.SQRT2*c.xyExtent+c.sphereDiameter/2)/c.sourceRadius)*c.sourceRadius+2*c.channelWidth)/c.channelWidth);
  c.uOffset=((c.channels-1)/2)%1;c.vOffset=((c.rows-1)/2)%1;
  if(c.channels>16384)throw Error('Detector grid exceeds 16384 channels');
  return c;
}
// Ray parameter need not be unit length. Stable perpendicular-distance form
// avoids subtracting two numbers of order R squared for a sub-mm sphere.
function fdkSphereChord(sx,sy,sz,dx,dy,dz,cx,cy,cz,a) {
  const n=Math.hypot(dx,dy,dz);dx/=n;dy/=n;dz/=n;
  const vx=cx-sx,vy=cy-sy,vz=cz-sz,t=vx*dx+vy*dy+vz*dz;
  const px=vy*dz-vz*dy,py=vz*dx-vx*dz,pz=vx*dy-vy*dx;
  const disc=a*a-px*px-py*py-pz*pz;
  if(disc<=0)return 0;
  const root=Math.sqrt(disc);return Math.max(0,t+root)-Math.max(0,t-root);
}
function fdkCoordinates(c,beta,x,y,z) {
  const cb=Math.cos(beta),sb=Math.sin(beta),D=c.sourceRadius-x*cb-y*sb;
  const u=c.sourceRadius*(-x*sb+y*cb)/D;
  const v=c.sourceRadius*(z-c.feed*(beta-c.phase)/FDK_TAU)/D;
  const gamma=Math.atan2(u,c.sourceRadius);
  return {u,v,gamma,w:v*Math.cos(gamma),weight:(c.sourceRadius/D)**2};
}
function fdkRowPosition(c,beta,row) {
  const L=Math.hypot(c.sourceRadius*Math.cos(beta)-c.radius,c.sourceRadius*Math.sin(beta));
  return c.feed*(beta-c.phase)/FDK_TAU+(row-(c.rows-1)/2)*c.rowWidth*L/c.sourceRadius;
}
function fdkRamp(k,du) {
  return k===0?1/(4*du):Math.abs(k)%2===1?-1/(Math.PI*Math.PI*k*k*du):0;
}
function fdkWidth(z,y,level) {
  let p=0;for(let i=1;i<y.length;i++)if(y[i]>y[p])p=i;
  let l=p,r=p;while(l>0&&y[l]>=level)l--;while(r<y.length-1&&y[r]>=level)r++;
  if(l===p||r===p||y[l]>=level||y[r]>=level)return null;
  const left=z[l]+(level-y[l])*(z[l+1]-z[l])/(y[l+1]-y[l]);
  const right=z[r-1]+(level-y[r-1])*(z[r]-z[r-1])/(y[r]-y[r-1]);
  return {width:right-left,left,right};
}
// Store only the analytically bounded nonzero sphere projection. Missing
// entries are exact air measurements, not a cropped object or missing rays.
function fdkArcProjection(c,beta,zObject) {
  const R=c.sourceRadius,cb=Math.cos(beta),sb=Math.sin(beta),zs=c.feed*(beta-c.phase)/FDK_TAU,a=c.sphereDiameter/2;
  const L=Math.hypot(R*cb-c.radius,R*sb),gc=Math.atan2(-c.radius*sb,R-c.radius*cb);
  const ga=Math.asin(a/L),wc=R*(zObject-zs)/L;
  const wa=R*a/(L-a)+Math.abs(wc)*a/(L-a),dg=c.channelWidth/R;
  const j0=Math.max(0,Math.ceil((gc-ga)/dg+(c.channels-1)/2-.5));
  const j1=Math.min(c.channels-1,Math.floor((gc+ga)/dg+(c.channels-1)/2+.5));
  const k0=Math.max(0,Math.ceil((wc-wa)/c.rowWidth+(c.rows-1)/2-.5));
  const k1=Math.min(c.rows-1,Math.floor((wc+wa)/c.rowWidth+(c.rows-1)/2+.5));
  const width=Math.max(0,j1-j0+1),height=Math.max(0,k1-k0+1),data=new Float64Array(width*height),A=c.apertureSamples;
  for(let k=k0;k<=k1;k++)for(let j=j0;j<=j1;j++){
    let sum=0;
    for(let av=0;av<A;av++)for(let au=0;au<A;au++){
      const g=(j-(c.channels-1)/2+(au+.5)/A-.5)*dg;
      const w=(k-(c.rows-1)/2+(av+.5)/A-.5)*c.rowWidth;
      const cg=Math.cos(g),sg=Math.sin(g);
      sum+=fdkSphereChord(R*cb,R*sb,zs,-R*(cg*cb+sg*sb),R*(-cg*sb+sg*cb),w,c.radius,0,zObject,a);
    }
    data[(k-k0)*width+j-j0]=sum/(A*A);
  }
  return {j0,j1,k0,k1,width,height,data};
}
function fdkArcAt(c,p,j,k) {
  if(j<p.j0||j>p.j1||k<p.k0||k>p.k1)return 0;
  return p.data[(k-p.k0)*p.width+j-p.j0];
}
function fdkRebinAt(c,p,u,v) {
  const g=Math.atan2(u,c.sourceRadius),fj=g*c.sourceRadius/c.channelWidth+(c.channels-1)/2;
  const fk=v*Math.cos(g)/c.rowWidth+(c.rows-1)/2,j=Math.floor(fj),k=Math.floor(fk),a=fj-j,b=fk-k;
  // Air is zero outside the finite acquired array, only after full signal
  // support and reconstruction ray coverage have been checked independently.
  return (1-b)*((1-a)*fdkArcAt(c,p,j,k)+a*fdkArcAt(c,p,j+1,k))+b*((1-a)*fdkArcAt(c,p,j,k+1)+a*fdkArcAt(c,p,j+1,k+1));
}
// Full discrete convolution evaluated only at the needed output columns.
// Every nonzero input column participates; no filter support is truncated.
function fdkFilteredPatch(c,p,i0,i1) {
  const R=c.sourceRadius,du=c.channelWidth,dv=c.rowWidth;
  const g0=(p.j0-1-(c.channels-1)/2)*du/R,g1=(p.j1+1-(c.channels-1)/2)*du/R;
  const lo=Math.floor(R*Math.tan(g0)/du-c.uOffset)-1,hi=Math.ceil(R*Math.tan(g1)/du-c.uOffset)+1;
  const cosMin=Math.min(Math.cos(g0),Math.cos(g1));
  const ws=[(p.k0-1-(c.rows-1)/2)*dv,(p.k1+1-(c.rows-1)/2)*dv];
  const v0=Math.floor(Math.min(...ws,...ws.map(w=>w/cosMin))/dv-c.vOffset)-1;
  const v1=Math.ceil(Math.max(...ws,...ws.map(w=>w/cosMin))/dv-c.vOffset)+1;
  const width=i1-i0+1,height=v1-v0+1,data=new Float64Array(width*height);
  for(let k=v0;k<=v1;k++) {
    const inputs=[];
    for(let j=lo;j<=hi;j++){
      const u=(j+c.uOffset)*du,v=(k+c.vOffset)*dv,signal=fdkRebinAt(c,p,u,v);
      if(signal!==0)inputs.push([j,signal*R/Math.hypot(R,u,v)]);
    }
    for(let i=i0;i<=i1;i++){
      let sum=0;for(const [j,v] of inputs)sum+=v*fdkRamp(i-j,du);
      data[(k-v0)*width+i-i0]=sum;
    }
  }
  return {i0,i1,v0,v1,width,height,data};
}
function fdkPatchAt(p,i,j){return i<p.i0||i>p.i1||j<p.v0||j>p.v1?0:p.data[(j-p.v0)*p.width+i-p.i0];}
function fdkSamplePatch(c,p,u,v){
  const fu=u/c.channelWidth-c.uOffset,fv=v/c.rowWidth-c.vOffset,i=Math.floor(fu),j=Math.floor(fv),a=fu-i,b=fv-j;
  return (1-b)*((1-a)*fdkPatchAt(p,i,j)+a*fdkPatchAt(p,i+1,j))+b*((1-a)*fdkPatchAt(p,i,j+1)+a*fdkPatchAt(p,i+1,j+1));
}
function fdkVolumeGeometry(c,zObject) {
  const n=c.xySamples,half=c.xyExtent;
  const x=Float64Array.from({length:n},(_,i)=>c.radius-half+2*half*i/(n-1));
  const y=Float64Array.from({length:n},(_,i)=>-half+2*half*i/(n-1));
  const z=Float64Array.from({length:c.zSamples},(_,i)=>zObject-c.zExtent+i*c.zStep);
  const db=FDK_TAU/c.viewSamples,starts=Int32Array.from(z,v=>Math.ceil(((c.feed?FDK_TAU*v/c.feed:0)-Math.PI)/db-1e-12));
  return {x,y,z,starts,first:Math.min(...starts),last:Math.max(...starts)+c.viewSamples,db};
}
function fdkCheckCoverage(c,g,zObject) {
  // Backprojection and the intermediate flat-grid interpolation need valid
  // acquired center support. Include a one-flat-cell guard for rebinning.
  const R=c.sourceRadius,a=c.sphereDiameter/2,dg=c.channelWidth/R;
  for(let view=g.first;view<g.last;view++){
    const beta=c.phase+view*g.db;
    const cb=Math.cos(beta),sb=Math.sin(beta),L=Math.hypot(R*cb-c.radius,R*sb),zs=c.feed*(beta-c.phase)/FDK_TAU;
    const wc=R*(zObject-zs)/L,wa=R*a/(L-a)+Math.abs(wc)*a/(L-a);
    if(Math.abs(wc)+wa>(c.rows/2)*c.rowWidth)throw Error('FDK_COVERAGE: the sphere projection is axially truncated. Reduce pitch or z extent; this full-turn FDK does not extrapolate missing data.');
    for(let iz=0;iz<g.z.length;iz++)if(view>=g.starts[iz]&&view<g.starts[iz]+c.viewSamples){
      for(const x of [g.x[0],g.x.at(-1)])for(const y of [g.y[0],g.y.at(-1)]){
        const q=fdkCoordinates(c,beta,x,y,g.z[iz]);
        // Guard includes interpolation over flat u and v before arc rebinning.
        const guard=c.rowWidth+Math.abs(q.v)*c.channelWidth/R;
        if(Math.abs(q.w)+guard>=(c.rows-1)*c.rowWidth/2||Math.abs(q.gamma)+2*dg>=(c.channels-1)*dg/2)
          throw Error('FDK_COVERAGE: the local volume lacks full-turn detector coverage. Reduce pitch or volume extent. Unsupported rays are not replaced by zero.');
      }
    }
  }
}
async function reconstructFdk(input={},hooks={}) {
  const c=fdkConfig(input),zObject=c.state*c.feed,g=fdkVolumeGeometry(c,zObject);
  fdkCheckCoverage(c,g,zObject);
  const n=c.xySamples,nxy=n*n,volume=new Float64Array(nxy*c.zSamples),counts=new Uint16Array(c.zSamples);
  const activePixels=[];for(let iy=0;iy<n;iy++)for(let ix=0;ix<n;ix++)if(!hooks.profileOnly||(g.x[ix]-c.radius)**2+g.y[iy]**2<=(c.sphereDiameter/2)**2+1e-12)activePixels.push(iy*n+ix);
  const auditSamples=[];let lastYield=performance.now();
  for(let view=g.first;view<g.last;view++){
    if(hooks.cancelled?.())throw Error('FDK_CANCELLED');
    const beta=c.phase+view*g.db,cb=Math.cos(beta),sb=Math.sin(beta),R=c.sourceRadius;
    const us=new Float64Array(nxy),weights=new Float64Array(nxy),scales=new Float64Array(nxy);
    let uMin=Infinity,uMax=-Infinity;
    for(let iy=0;iy<n;iy++)for(let ix=0;ix<n;ix++){
      const j=iy*n+ix,D=R-g.x[ix]*cb-g.y[iy]*sb;
      scales[j]=R/D;us[j]=R*(-g.x[ix]*sb+g.y[iy]*cb)/D;weights[j]=scales[j]*scales[j];
      uMin=Math.min(uMin,us[j]);uMax=Math.max(uMax,us[j]);
    }
    const raw=fdkArcProjection(c,beta,zObject);
    const patch=fdkFilteredPatch(c,raw,Math.floor(uMin/c.channelWidth-c.uOffset)-1,Math.ceil(uMax/c.channelWidth-c.uOffset)+1);
    for(let iz=0;iz<c.zSamples;iz++)if(view>=g.starts[iz]&&view<g.starts[iz]+c.viewSamples){
      const dz=g.z[iz]-c.feed*(beta-c.phase)/FDK_TAU;counts[iz]++;
      for(const j of activePixels)volume[iz*nxy+j]+=fdkSamplePatch(c,patch,us[j],dz*scales[j])*weights[j]*g.db/2;
      if(!hooks.profileOnly&&iz===(c.zSamples-1)/2){
        const j=(nxy-1)/2,fu=us[j]/c.channelWidth-c.uOffset,i=Math.floor(fu),a=fu-i,fv=dz*scales[j]/c.rowWidth-c.vOffset,k=Math.floor(fv),b=fv-k;
        for(const [row,weight] of [[k,1-b],[k+1,b]])if(weight>0)auditSamples.push({view,row,theta:beta,beta,z:c.feed*view/c.viewSamples+(row+c.vOffset)*c.rowWidth/scales[j]-zObject,weight,referenceWeight:0,geometricWeight:weights[j],filteredValue:(1-a)*fdkPatchAt(patch,i,row)+a*fdkPatchAt(patch,i+1,row)});
      }
    }
    if((view-g.first)%12===0&&performance.now()-lastYield>=32){hooks.progress?.((view-g.first)/(g.last-g.first));await new Promise(resolve=>setTimeout(resolve,0));lastYield=performance.now();}
  }
  if(!counts.every(v=>v===c.viewSamples))throw Error('Internal full-turn view-count mismatch');
  const roi=[];
  for(let iy=0;iy<n;iy++)for(let ix=0;ix<n;ix++)if((g.x[ix]-c.radius)**2+g.y[iy]**2<=(c.sphereDiameter/2)**2+1e-12)roi.push(iy*n+ix);
  const raw=Float64Array.from(g.z,(_,iz)=>roi.reduce((s,j)=>s+volume[iz*nxy+j],0)/roi.length);
  const min=Math.min(...raw),max=Math.max(...raw),baseline=c.normalization==='minmax'?min:0;
  if(!(max>baseline))throw Error('No positive reconstructed sphere signal');
  const profile=Float64Array.from(raw,v=>(v-baseline)/(max-baseline)),z=Float64Array.from(g.z,v=>v-zObject);
  const fwhm=fdkWidth(z,profile,.5),fwtm=fdkWidth(z,profile,.1);
  if(!fwhm||!fwtm)throw Error('FDK_DOMAIN: increase z extent to enclose both width thresholds');
  const weightAudit=hooks.profileOnly?null:{definition:'Virtual flat filtered row interpolation at the sphere-centre voxel; channel interpolation included in filteredValue, FDK geometricWeight and db/2 applied separately; not raw detector rows or whole-SSP contributions.',coordinate:'source angle beta; virtual flat row index',db:g.db/2,centerValue:volume[((c.zSamples-1)/2*n+(n-1)/2)*n+(n-1)/2],samples:auditSamples};
  return {config:c,x:g.x,y:g.y,z,volume:hooks.profileOnly?null:volume,raw,profile,counts,zObject,fwhm,fwtm,min,max,baseline,roiPixels:roi.length,weightAudit,
    acquisition:{firstView:g.first,lastViewExclusive:g.last,viewsPerSlice:c.viewSamples},
    model:{version:FDK_VERSION,algorithm:'full-turn helical FDK approximation',detector:'source-centered cylindrical; bilinear rebin to virtual flat detector',
      object:'unit-attenuation finite sphere; no deconvolution',filter:'unwindowed discrete Ram-Lak; full nonzero input support',
      interpolation:'bilinear rebin and backprojection; native linear width crossings',normalization:c.normalization,
      extraAxialAveraging:false,fullTurnCoverage:true,scientificScope:'reference implementation; not a validated scanner-specific reconstruction or exact wide-cone inversion'}};
}
async function reconstructFdkSeries(input,hooks={}) {
  const c=fdkConfig(input),profiles=[];let selected;
  for(let i=0;i<c.phaseCount;i++){
    const phase=c.phase+FDK_TAU*i/c.phaseCount;
    const r=await reconstructFdk({...c,phase},{...hooks,profileOnly:i>0||hooks.profileOnly,progress:v=>hooks.progress?.((i+v)/c.phaseCount)});
    if(!selected)selected=r;
    profiles.push({phase,profile:r.profile,raw:r.raw,fwhm:r.fwhm,fwtm:r.fwtm,baseline:r.baseline});
    hooks.progress?.((i+1)/c.phaseCount);await new Promise(resolve=>setTimeout(resolve,0));
  }
  const mean=Float64Array.from(selected.z,(_,i)=>profiles.reduce((s,p)=>s+p.profile[i],0)/profiles.length);
  return {...selected,profiles,mean,meanDifference:profiles.map(p=>Float64Array.from(p.profile,(v,i)=>v-mean[i]))};
}

// Hsieh et al., Opt Eng 46:067001 (2007), Eqs. 4-6.
// Rowwise fan-to-parallel rebinning; matched RRI and CBA from identical data.
// Coordinates, quadrature, supported acquisition and limits: CBA_METHOD.md.
const CBA_VERSION='2026-09-15.3';
const CBA_TAU=2*Math.PI;
function cbaWeights(a,b,power=2){
  if(![a,b].every(v=>Number.isFinite(v)&&v>=0&&v<=1)||![1,2].includes(power))throw Error('CBA_WEIGHT_DOMAIN');
  const w=[(1-a)**power,a**power,(1-b)**power,b**power],sum=w.reduce((s,v)=>s+v,0);
  return w.map(v=>v/sum);
}
// Compact distance weights over acquired row centres only. The four-sample
// interior is Hsieh Eq. (6); omitting unavailable cells and renormalizing is
// our explicit boundary extension inspired by their conjugate compensation.
function cbaAvailableWeights(c,a,b,power=2){
  const w=[(1-a.delta)**power,a.delta**power,(1-b.delta)**power,b.delta**power];
  const rows=[a.n,a.n+1,b.n,b.n+1];
  for(let i=0;i<4;i++)if(rows[i]<0||rows[i]>=c.rows)w[i]=0;
  const sum=w.reduce((s,v)=>s+v,0);
  if(!(sum>1e-14))throw Error('CBA_COVERAGE: no acquired row support in the conjugate pair');
  return w.map(v=>v/sum);
}
// Continuous rectangular mean of a piecewise-linear sampled image column.
// The caller supplies reconstructed padding; no zero extension or clamping.
function cbaSlabMean(values,dz,width,padding){
  if(width===0)return Float64Array.from(values);
  const n=values.length,prefix=new Float64Array(n),out=new Float64Array(n-2*padding);
  for(let i=1;i<n;i++)prefix[i]=prefix[i-1]+(values[i-1]+values[i])*dz/2;
  const integral=x=>{if(x<-1e-9||x>n-1+1e-9)throw Error('CBA_DOMAIN: missing reconstructed slab padding');
    x=Math.max(0,Math.min(n-1,x));const i=Math.min(n-2,Math.floor(x)),f=x-i;
    return prefix[i]+dz*(values[i]*f+(values[i+1]-values[i])*f*f/2);};
  const half=width/(2*dz);
  for(let i=0;i<out.length;i++){const j=i+padding;out[i]=(integral(j+half)-integral(j-half))/width;}
  return out;
}
// Exact coefficients of the same piecewise-linear rectangular integral.
// These are used only to trace the centre image sample, not to reconstruct it.
function cbaSlabCoefficients(length,dz,width){
  const out=new Float64Array(length),mid=(length-1)/2;
  if(width===0){out[mid]=1;return out;}
  const lo=mid-width/(2*dz),hi=mid+width/(2*dz);
  for(let i=Math.floor(lo);i<Math.ceil(hi);i++){
    const a=Math.max(0,lo-i),b=Math.min(1,hi-i),right=(b*b-a*a)/2;
    out[i]+=dz*(b-a-right)/width;out[i+1]+=dz*right/width;
  }
  return out;
}
function cbaCoordinates(c,theta,x,y,z){
  const t=-x*Math.sin(theta)+y*Math.cos(theta),along=x*Math.cos(theta)+y*Math.sin(theta);
  const gamma=Math.asin(t/c.sourceRadius),beta=theta+gamma;
  const L=Math.sqrt(c.sourceRadius*c.sourceRadius-t*t)-along;
  const sourceZ=c.feed*(beta-c.phase)/CBA_TAU,w=c.sourceRadius*(z-sourceZ)/L;
  const row=w/c.rowWidth+(c.rows-1)/2,n=Math.floor(row);
  return {t,along,gamma,beta,L,sourceZ,w,n,delta:row-n};
}
function cbaGrid(c,zObject){
  const n=c.xySamples,h=c.xyExtent,db=CBA_TAU/c.viewSamples;
  const x=Float64Array.from({length:n},(_,i)=>c.radius-h+2*h*i/(n-1));
  const y=Float64Array.from({length:n},(_,i)=>-h+2*h*i/(n-1));
  const padding=Math.ceil((c.axialAverageMm??0)/(2*c.zStep));
  const z=Float64Array.from({length:c.zSamples+2*padding},(_,i)=>zObject-c.zExtent+(i-padding)*c.zStep);
  const starts=Int32Array.from(z,v=>Math.ceil(((c.feed?CBA_TAU*v/c.feed:0)-Math.PI)/db-1e-12));
  return {x,y,z,starts,db,padding,first:Math.min(...starts),last:Math.max(...starts)+c.viewSamples};
}
function cbaRawAt(p,j,k){
  return j<p.j0||j>p.j1||k<p.k0||k>p.k1?0:p.data[(k-p.k0)*p.width+j-p.j0];
}
function cbaRebinAt(c,rawAt,theta,t,k){
  const gamma=Math.asin(t/c.sourceRadius),v=(theta+gamma-c.phase)*c.viewSamples/CBA_TAU;
  const j=gamma*c.sourceRadius/c.channelWidth+(c.channels-1)/2,i0=Math.floor(v),j0=Math.floor(j),a=v-i0,b=j-j0;
  if(j0<0||j0+1>=c.channels||k<0||k>=c.rows)throw Error('CBA_COVERAGE: rebinning outside acquired detector');
  const p0=rawAt(i0),p1=rawAt(i0+1);
  return (1-a)*((1-b)*cbaRawAt(p0,j0,k)+b*cbaRawAt(p0,j0+1,k))+a*((1-b)*cbaRawAt(p1,j0,k)+b*cbaRawAt(p1,j0+1,k));
}
// Exact sparse support: intersect the support of each acquired view with
// both interpolation tents. No clipping of the ramp or sphere projection.
function cbaFilteredPatch(c,rawAt,theta,i0,i1){
  const R=c.sourceRadius,du=c.channelWidth,dg=du/R,db=CBA_TAU/c.viewSamples,mid=(c.channels-1)/2;
  const maxGamma=mid*dg;
  const first=Math.floor((theta-maxGamma-c.phase)/db),last=Math.ceil((theta+maxGamma-c.phase)/db);
  let lo=Infinity,hi=-Infinity,k0=c.rows,k1=-1;
  for(let v=first;v<=last;v++){
    const p=rawAt(v);if(!p.width||!p.height)continue;
    const b=c.phase+v*db;
    const gl=Math.max((p.j0-1-mid)*dg,b-db-theta,-maxGamma),gh=Math.min((p.j1+1-mid)*dg,b+db-theta,maxGamma);
    if(gl>gh)continue;
    lo=Math.min(lo,Math.floor(R*Math.sin(gl)/du-c.uOffset));hi=Math.max(hi,Math.ceil(R*Math.sin(gh)/du-c.uOffset));
    k0=Math.min(k0,p.k0);k1=Math.max(k1,p.k1);
  }
  const width=i1-i0+1,height=Math.max(0,k1-k0+1),data=new Float64Array(width*height);
  for(let k=k0;k<=k1;k++){
    const inputs=[],w=(k-(c.rows-1)/2)*c.rowWidth,cone=R/Math.hypot(R,w);
    for(let j=lo;j<=hi;j++){
      const t=(j+c.uOffset)*du;
      // Centres beyond the fan extent cannot have acquired nonzero support.
      if(Math.abs(t)>=R*Math.sin(maxGamma-dg))continue;
      const value=cbaRebinAt(c,rawAt,theta,t,k)*cone;if(value)inputs.push([j,value]);
    }
    for(let i=i0;i<=i1;i++){
      let sum=0;for(const [j,value] of inputs)sum+=value*fdkRamp(i-j,du);
      data[(k-k0)*width+i-i0]=sum;
    }
  }
  return {i0,i1,k0,k1,width,height,data,inputFirst:lo,inputLast:hi};
}
function cbaAt(p,j,k){return j<p.i0||j>p.i1||k<p.k0||k>p.k1?0:p.data[(k-p.k0)*p.width+j-p.i0];}
function cbaSampleRow(c,p,t,k){
  const f=t/c.channelWidth-c.uOffset,j=Math.floor(f),a=f-j;
  if(j<p.i0||j+1>p.i1||k<0||k>=c.rows)throw Error('CBA_COVERAGE: missing filtered interpolation support');
  return (1-a)*cbaAt(p,j,k)+a*cbaAt(p,j+1,k);
}
function cbaCheckPair(c,a,b){
  for(const q of [a,b])if(q.n<0||q.n+1>=c.rows)throw Error('CBA_COVERAGE: both conjugate row brackets are required; reduce pitch or reconstruction extent');
}
function cbaResult(c,g,volume,counts,zObject,kind,acquisition,profileOnly=false){
  const n=c.xySamples,nxy=n*n,roi=[];
  for(let iy=0;iy<n;iy++)for(let ix=0;ix<n;ix++)if((g.x[ix]-c.radius)**2+g.y[iy]**2<=(c.sphereDiameter/2)**2+1e-12)roi.push(iy*n+ix);
  const paddedRaw=Float64Array.from(g.z,(_,iz)=>roi.reduce((s,j)=>s+volume[iz*nxy+j],0)/roi.length);
  const raw=cbaSlabMean(paddedRaw,c.zStep,c.axialAverageMm,g.padding);
  const outputZ=g.z.slice(g.padding,g.z.length-g.padding);
  const averagedVolume=c.axialAverageMm&&!profileOnly?new Float64Array(nxy*outputZ.length):volume;
  if(c.axialAverageMm&&!profileOnly)for(let j=0;j<nxy;j++){
    const col=cbaSlabMean(Float64Array.from(g.z,(_,iz)=>volume[iz*nxy+j]),c.zStep,c.axialAverageMm,g.padding);
    for(let iz=0;iz<col.length;iz++)averagedVolume[iz*nxy+j]=col[iz];
  }
  const min=Math.min(...raw),max=Math.max(...raw),baseline=c.normalization==='minmax'?min:0;
  if(!(max>baseline))throw Error('CBA_DOMAIN: no positive reconstructed sphere');
  const profile=Float64Array.from(raw,v=>(v-baseline)/(max-baseline)),z=Float64Array.from(outputZ,v=>v-zObject);
  const fwhm=fdkWidth(z,profile,.5),fwtm=fdkWidth(z,profile,.1);
  if(!fwhm||!fwtm)throw Error('CBA_DOMAIN: increase z extent to contain width crossings');
  return {config:c,x:g.x,y:g.y,z,volume:profileOnly?null:averagedVolume,raw,profile,counts:counts.slice(g.padding,counts.length-g.padding),zObject,fwhm,fwtm,min,max,baseline,roiPixels:roi.length,acquisition,
    model:{version:CBA_VERSION,algorithm:kind==='cba'?'Hsieh conjugate backprojection (CBA)':'Matched row-to-row interpolation (RRI)',
      reference:'Hsieh et al. 2007; DOI 10.1117/1.2746866; Eqs. 4-6',detector:'same cylindrical sphere projections for RRI and CBA',
      rebinning:'rowwise fan-to-parallel; linear acquired view and channel interpolation; row unchanged',
      filter:'unwindowed discrete parallel Ram-Lak; cone cosine per row; full nonzero input support',
      interpolation:kind==='cba'?'normalized distance-quadratic acquired-row weights; Eq. 6 in the four-sample interior':'normalized distance-linear acquired-row weights; conventional RRI in the four-sample interior',
      angularWeight:'one paired full turn per slice; no overscan or adaptive cone weighting',object:'finite sphere; no deconvolution',normalization:c.normalization,
      edgePolicy:c.edgePolicy,edgeExtension:'unavailable acquired row coefficients are zero; normalize available distance weights; not the full published scanner algorithm',
      extraAxialAveraging:c.axialAverageMm>0,axialAverageMm:c.axialAverageMm,axialAverageDefinition:'image-domain normalized rectangular mean; piecewise-linear z integration before profile normalization; reconstructed padding',
      fullTurnCoverage:c.edgePolicy==='strict',pairedAngularCoverage:true,profileOnly,scientificScope:'paper-based approximate reference; not TCOT or a validated commercial scanner'}};
}
async function reconstructCba(input={},hooks={}){
  const c=fdkConfig(input);c.edgePolicy=input.edgePolicy??'available';c.axialAverageMm=Number(input.axialAverageMm??0);
  if(!['strict','available'].includes(c.edgePolicy))throw Error('CBA_EDGE_POLICY');
  if(!Number.isFinite(c.axialAverageMm)||c.axialAverageMm<0||c.axialAverageMm>10)throw Error('CBA_AVERAGE: width must be between 0 and 10 mm');
  if(c.viewSamples%2)throw Error('CBA_VIEWS: an even number of views per turn is required');
  const zObject=c.state*c.feed,g=cbaGrid(c,zObject),n=c.xySamples,nxy=n*n,half=c.viewSamples/2;
  const volume=new Float64Array(nxy*g.z.length),rriVolume=new Float64Array(volume.length),counts=new Uint16Array(g.z.length);
  const pixels=[];for(let iy=0;iy<n;iy++)for(let ix=0;ix<n;ix++)if(!hooks.profileOnly||(g.x[ix]-c.radius)**2+g.y[iy]**2<=(c.sphereDiameter/2)**2+1e-12)pixels.push({ix,iy,x:g.x[ix],y:g.y[iy],j:iy*n+ix});
  const raws=new Map(),patches=new Map();let rawFirst=Infinity,rawLast=-Infinity;
  const rawAt=v=>{
    if(raws.has(v))return raws.get(v);
    const beta=c.phase+v*g.db,R=c.sourceRadius,a=c.sphereDiameter/2,L=Math.hypot(R*Math.cos(beta)-c.radius,R*Math.sin(beta));
    const wc=R*(zObject-c.feed*v/c.viewSamples)/L,wa=(R+Math.abs(wc))*a/(L-a);
    if(c.edgePolicy==='strict'&&Math.abs(wc)+wa>=c.rows*c.rowWidth/2)throw Error('CBA_COVERAGE: acquired sphere projection is truncated');
    const p=fdkArcProjection(c,beta,zObject);raws.set(v,p);rawFirst=Math.min(rawFirst,v);rawLast=Math.max(rawLast,v);return p;
  };
  const patchAt=v=>{
    if(patches.has(v))return patches.get(v);
    const theta=c.phase+v*g.db,ts=[];
    for(const x of [g.x[0],g.x.at(-1)])for(const y of [g.y[0],g.y.at(-1)])ts.push(-x*Math.sin(theta)+y*Math.cos(theta));
    const p=cbaFilteredPatch(c,rawAt,theta,Math.floor(Math.min(...ts)/c.channelWidth-c.uOffset)-1,Math.ceil(Math.max(...ts)/c.channelWidth-c.uOffset)+1);
    patches.set(v,p);return p;
  };
  const sampleAudit=[],weightMap=new Map(),slab=cbaSlabCoefficients(g.z.length,c.zStep,c.axialAverageMm);
  let boundaryPairs=0,totalVoxelPairs=0,lastYield=performance.now();
  for(let v=g.first;v<g.last-half;v++){
    if(hooks.cancelled?.())throw Error('FDK_CANCELLED');
    const theta=c.phase+v*g.db,theta2=theta+Math.PI,p=patchAt(v),p2=patchAt(v+half);
    const geometry=pixels.map(pixel=>({pixel,a:cbaCoordinates(c,theta,pixel.x,pixel.y,0),b:cbaCoordinates(c,theta2,pixel.x,pixel.y,0)}));
    for(let iz=0;iz<g.z.length;iz++)if(v>=g.starts[iz]&&v<g.starts[iz]+half){
      counts[iz]+=2;
      for(const geo of geometry){
        const {pixel}=geo;
        const {ix,iy}=pixel,a0=geo.a,b0=geo.b;
        const ar=c.sourceRadius*(g.z[iz]-a0.sourceZ)/a0.L/c.rowWidth+(c.rows-1)/2,br=c.sourceRadius*(g.z[iz]-b0.sourceZ)/b0.L/c.rowWidth+(c.rows-1)/2;
        const an=Math.floor(ar),bn=Math.floor(br),ad=ar-an,bd=br-bn;
        const boundary=an<0||an+1>=c.rows||bn<0||bn+1>=c.rows;totalVoxelPairs++;if(boundary)boundaryPairs++;
        if(boundary&&c.edgePolicy==='strict')throw Error('CBA_COVERAGE: both conjugate row brackets are required');
        const l0=an>=0&&an<c.rows?1-ad:0,l1=an+1>=0&&an+1<c.rows?ad:0,l2=bn>=0&&bn<c.rows?1-bd:0,l3=bn+1>=0&&bn+1<c.rows?bd:0;
        const s=l0*l0+l1*l1+l2*l2+l3*l3,sr=l0+l1+l2+l3;
        if(!(s>1e-14))throw Error('CBA_COVERAGE: no acquired row support in the conjugate pair');
        const w0=l0*l0/s,w1=l1*l1/s,w2=l2*l2/s,w3=l3*l3/s;
        const q0=l0?cbaSampleRow(c,p,a0.t,an):0,q1=l1?cbaSampleRow(c,p,a0.t,an+1):0,q2=l2?cbaSampleRow(c,p2,b0.t,bn):0,q3=l3?cbaSampleRow(c,p2,b0.t,bn+1):0,j=iz*nxy+pixel.j;
        volume[j]+=g.db*(w0*q0+w1*q1+w2*q2+w3*q3);
        rriVolume[j]+=g.db*(l0/sr*q0+l1/sr*q1+l2/sr*q2+l3/sr*q3);
        if(!hooks.profileOnly&&slab[iz]>0&&ix===(n-1)/2&&iy===(n-1)/2){
          const ws=[w0,w1,w2,w3],rs=[l0/sr,l1/sr,l2/sr,l3/sr],qs=[q0,q1,q2,q3],rows=[an,an+1,bn,bn+1];
          for(let k=0;k<4;k++)if(ws[k]>0){
            const view=v+(k<2?0:half),row=rows[k],key=view+':'+row,coord=k<2?a0:b0;
            let entry=weightMap.get(key);
            if(!entry){entry={view,row,theta:c.phase+view*g.db,beta:coord.beta,
              z:coord.sourceZ+(row-(c.rows-1)/2)*c.rowWidth*coord.L/c.sourceRadius-zObject,
              weight:0,referenceWeight:0,filteredValue:qs[k]};weightMap.set(key,entry);}
            entry.weight+=slab[iz]*ws[k];entry.referenceWeight+=slab[iz]*rs[k];
          }
        }
        if(iz===(g.z.length-1)/2&&ix===(n-1)/2&&iy===(n-1)/2){
          const a={...a0,n:an,delta:ad},b={...b0,n:bn,delta:bd},w=[w0,w1,w2,w3],wr=[l0/sr,l1/sr,l2/sr,l3/sr];
          const zs=[a.sourceZ+(a.n-(c.rows-1)/2)*c.rowWidth*a.L/c.sourceRadius,a.sourceZ+(a.n+1-(c.rows-1)/2)*c.rowWidth*a.L/c.sourceRadius,
            b.sourceZ+(b.n-(c.rows-1)/2)*c.rowWidth*b.L/c.sourceRadius,b.sourceZ+(b.n+1-(c.rows-1)/2)*c.rowWidth*b.L/c.sourceRadius].map(z=>z-zObject);
          sampleAudit.push({theta,thetaDeg:theta*180/Math.PI,relativeAngleDeg:(v-g.starts[iz])*360/c.viewSamples,beta:a.beta,betaConjugate:b.beta,
            t:a.t,directRow:a.n,conjugateRow:b.n,delta:a.delta,deltaConjugate:b.delta,z:zs,weights:w,rriWeights:wr,available:[a.n,a.n+1,b.n,b.n+1].map(k=>k>=0&&k<c.rows),
            weightedDistance:zs.reduce((s,z,i)=>s+w[i]*Math.abs(z),0),rriWeightedDistance:zs.reduce((s,z,i)=>s+wr[i]*Math.abs(z),0)});
        }
      }
    }
    if((v-g.first)%6===0&&performance.now()-lastYield>=32){hooks.progress?.((v-g.first)/(g.last-half-g.first));await new Promise(resolve=>setTimeout(resolve,0));lastYield=performance.now();}
  }
  if(!counts.every(v=>v===c.viewSamples))throw Error('CBA_INTERNAL: paired view count mismatch');
  const acquisition={firstView:rawFirst,lastViewExclusive:rawLast+1,viewsPerSlice:c.viewSamples,rebinnedPairsPerSlice:half,firstRebinnedView:g.first,lastRebinnedViewExclusive:g.last,boundaryPairs,totalVoxelPairs,paddedReconstructionSlices:g.z.length};
  const r=cbaResult(c,g,volume,counts,zObject,'cba',acquisition,hooks.profileOnly),reference=cbaResult(c,g,rriVolume,counts,zObject,'rri',acquisition,hooks.profileOnly);
  const center=((r.z.length-1)/2*n+(n-1)/2)*n+(n-1)/2;
  const weightAudit=hooks.profileOnly?null:{
    definition:'Rebinned filtered row coefficients at the transverse sphere centre, integrated over the image-domain axial averaging window; not whole-SSP or raw-projection contributions.',
    coordinate:'parallel rebinned angle theta; unwrapped view identity retained',axialAverageMm:c.axialAverageMm,db:g.db,
    centerValue:r.volume[center],referenceCenterValue:reference.volume[center],samples:[...weightMap.values()]};
  return {...r,reference,sampleAudit,weightAudit};
}
async function reconstructCbaSeries(input,hooks={}){
  const c=fdkConfig(input),profiles=[],referenceProfiles=[];let selected;
  for(let i=0;i<c.phaseCount;i++){
    const phase=c.phase+CBA_TAU*i/c.phaseCount;
    const r=await reconstructCba({...c,phase},{...hooks,profileOnly:i>0||hooks.profileOnly,progress:v=>hooks.progress?.((i+v)/c.phaseCount)});
    if(!selected)selected=r;
    for(const [target,q] of [[profiles,r],[referenceProfiles,r.reference]])target.push({phase,profile:q.profile,raw:q.raw,fwhm:q.fwhm,fwtm:q.fwtm,baseline:q.baseline});
    hooks.progress?.((i+1)/c.phaseCount);await new Promise(resolve=>setTimeout(resolve,0));
  }
  const series=(r,ps)=>{const mean=Float64Array.from(r.z,(_,i)=>ps.reduce((s,p)=>s+p.profile[i],0)/ps.length);return {...r,profiles:ps,mean,meanDifference:ps.map(p=>Float64Array.from(p.profile,(v,i)=>v-mean[i]))};};
  return {...series(selected,profiles),reference:series(selected.reference,referenceProfiles)};
}

let cancelled = false;
let activeContext = null;
let fdkContext=null, fdkInspectionToken=0;
const yieldToMessages = () => new Promise(resolve => setTimeout(resolve, 0));
const OVERLAY_STATE_COUNT = 360;
function overlaySampleIndices(length) {
  // Preserve the numerical profile grid in screen and publication overlays.
  // A fixed 1000-point decimation can miss a narrow peak inside a broad domain.
  return Array.from({ length }, (_, index) => index);
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
  if (message.type === 'fdk-run') {
    cancelled = false;
    fdkContext=null;fdkInspectionToken++;
    try {
      const reconstruct = message.params.method === 'hsieh' ? reconstructCbaSeries : reconstructFdkSeries;
      const result = await reconstruct(message.params, {
        cancelled: () => cancelled,
        progress: value => self.postMessage({type:'progress',value,label:`3D FBP ${Math.min(message.params.phaseCount,Math.floor(value*message.params.phaseCount)+1)} / ${message.params.phaseCount} start angles (${Math.round(value*100)}%)`}),
      });
      fdkContext={params:message.params,first:result};
      self.postMessage({type:'fdk-result',result});
    } catch(error) {
      self.postMessage({type:error.message==='FDK_CANCELLED'?'cancelled':'error',message:error.message});
    }
    return;
  }
  if(message.type==='fdk-inspect'){
    const token=++fdkInspectionToken,context=fdkContext;if(!context)return;
    try{
      const index=((Math.round(message.index)%context.params.phaseCount)+context.params.phaseCount)%context.params.phaseCount;
      const reconstruct=context.params.method==='hsieh'?reconstructCba:reconstructFdk;
      const result=index===0?context.first:await reconstruct({...context.params,phase:context.params.phase+2*Math.PI*index/context.params.phaseCount},{cancelled:()=>cancelled||token!==fdkInspectionToken});
      if(token===fdkInspectionToken)self.postMessage({type:'fdk-inspection',index,requestId:message.requestId,result});
    }catch(error){if(token===fdkInspectionToken)self.postMessage({type:'fdk-inspection-error',requestId:message.requestId,message:error.message});}
    return;
  }
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
    const params = validateParams(message.params, { allowZeroPitch: true });
    if (params.beamPitch === 0) {
      activeContext = null;
      self.postMessage({ type: "geometry-result", result: {
        params, geometryOnly: true,
        diagramOff: computeUnwrapped(params, { coneOn: false }),
        diagramOn: computeUnwrapped(params, { coneOn: true }),
      } });
      return;
    }
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
      coordinate: "reconstruction-plane-z-minus-fixed-object-z",
      normalization: "each-profile-peak-normalized-to-one",
      stateMeaning: "fixed-object-position-within-one-table-feed-per-rotation",
      responseDefinition: "fixed-axial-impulse-moving-reconstruction-plane",
      profileMethod: "taguchi-1998-equation-6-finite-rectangular-filter-interpolation",
      filterWidthMm: params.filterWidthMm,
      filterSamples: selectedOn.filterSamples,
      requestedFilterSamples: params.filterSamples,
      diagnosticStage: "unfiltered-local-interpolation-at-the-central-plane-not-filtered-ssp-contributors",
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
            responseDefinition: result.responseDefinition,
            filterWidthMm: result.filterWidthMm,
            filterSamples: result.filterSamples,
            requestedFilterSamples: result.requestedFilterSamples,
            diagnosticStage: result.diagnosticStage,
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

