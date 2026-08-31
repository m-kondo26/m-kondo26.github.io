(() => {
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

versionLabel.textContent = `Web reference build ${MODEL_VERSION}`;

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
    ? "Direct-ray 0-360° full scan (comparator)"
    : "180LI acquisition geometry (primary analysis)";
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
  if (inspectStateLabel) inspectStateLabel.textContent = `State ${selectedStateIndex}/359 (s = ${(selectedStateIndex / 360).toFixed(3)})`;
  if (inspectState) inspectState.setAttribute("aria-valuetext", `State ${selectedStateIndex}, relative position ${(selectedStateIndex / 360).toFixed(3)}`);
}

function paramsToUrl(params) {
  const url = new URL(window.location.href);
  url.search = "";
  const compact = {
    v: 6,
    n: params.rows,
    d: params.rowWidth,
    p: params.beamPitch,
    R: params.sourceRadius,
    r: params.radius,
    vs: selectedStateIndex,
    st: params.sliceThicknessMm,
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
  legacyInputMigrated = hasLegacyThickness || hasLegacyState || query.has("z") || query.has("nr") || query.has("nt") || query.has("stage");
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
    profileMode: getText("pm", DEFAULT_PARAMS.profileMode),
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

function showCalculatingState(detail = "Generating figures for the current conditions", force = false) {
  const now = performance.now();
  if (!force && now - lastPlaceholderPaint < 500) return;
  lastPlaceholderPaint = now;
  setResultPlaceholder("loading", "Calculating…", detail);
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
  status.textContent = "Starting computation";
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
      status.textContent = `Completed in ${elapsed.toFixed(1)} s / ${reconstructionPathLabel(lastResult.params.reconstructionPath)} / configured thickness=${fmt(lastResult.params.sliceThicknessMm, 3)} mm / maximum longitudinal standard deviation of candidate positions=${fmt(axialSpreadMaximum, 3)} mm`;
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
      status.textContent = `Detailed view updated to state ${selectedStateIndex}/359 (s=${(selectedStateIndex / 360).toFixed(3)})`;
      inspectState.disabled = false;
      inspectPrev.disabled = false;
      inspectNext.disabled = false;
    } else if (message.type === "cancelled") {
      status.textContent = "Computation cancelled";
      setResultPlaceholder("cancelled", "Computation cancelled", "Review the conditions, then select Compute again.");
      setBusy(false);
      releaseWorker();
    } else if (message.type === "error") {
      showError(message.message);
      status.textContent = "Computation error";
      setResultPlaceholder("error", "The figures could not be generated", "Review the error message above.");
      setBusy(false);
      releaseWorker();
    }
  };
  worker.onerror = event => {
    showError(event.message || "A Web Worker error occurred.");
    status.textContent = "Computation error";
    setResultPlaceholder("error", "The figures could not be generated", "Review the error message above.");
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
    status.textContent = `Computing details for state ${selectedStateIndex}/359`;
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

function drawWeightedMarker(ctx, row, totalRows, x, y, radius, weight) {
  const color = rowColor(row, totalRows);
  ctx.fillStyle = opaqueWeightColor(row, totalRows, weight);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
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

function drawWeightLegend(ctx, left, top, width, totalRows, countText) {
  const y0 = top + 6;
  ctx.save();
  ctx.fillStyle = INK;
  ctx.font = `20px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const weightLabel = "Linear-interpolation weight w of selected endpoints";
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
  ctx.font = `20px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2;
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(left, y0 + 76); ctx.lineTo(left + 43, y0 + 76); ctx.stroke();
  const acquisitionLabel = "Thin lines: all-row candidate trajectories (not filtered by T)";
  ctx.fillStyle = INK;
  setFittedFigureFont(ctx, acquisitionLabel, 20, 15, width - 53);
  ctx.fillText(acquisitionLabel, left + 53, y0 + 76);
  if (countText) {
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FIGURE_FONT}`;
    drawWrappedLegendText(ctx, countText, left, y0 + 108, width);
  }
  ctx.restore();
}

function drawCandidateTrace(ctx, diagram, row, turn, x, yDown) {
  const trace = diagram.traceGeometry;
  const angles = trace.angles;
  const axial = trace.axial;
  const scales = trace.scales;
  const rowOffset = trace.rowOffsets[row];
  const totalRows = diagram.totalRows;
  ctx.save();
  ctx.strokeStyle = rowColor(row, totalRows);
  const densityScale = Math.min(1, Math.sqrt(24 / Math.max(24, totalRows)));
  ctx.globalAlpha = 0.60 * densityScale;
  ctx.lineWidth = Math.max(0.45, 1.35 * densityScale);
  ctx.setLineDash([]);
  ctx.beginPath();
  let previousAngle = null;
  for (let index = 0; index < angles.length; index += 1) {
    const angle = angles[index];
    const delta = axial[index] + turn * trace.feed + scales[index] * rowOffset - diagram.z0;
    const px = x(delta);
    const py = yDown(angle);
    if (previousAngle === null || Math.abs(angle - previousAngle) > 180) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
    previousAngle = angle;
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
  const rowLabel = "Detector row";
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
  ctx.font = `19px ${FIGURE_FONT}`;
  const acquiredLabel = "All-row candidate trajectories (not filtered by T)";
  const targetLabel = "Target plane z₀";
  const secondRowY = top + 54;
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
  let countY = top + 84;
  if (targetTextX + targetTextWidth > left + width) {
    targetMarkerX = left;
    targetTextX = left + 12;
    targetY = top + 84;
    countY = top + 114;
  }
  ctx.strokeStyle = RED;
  ctx.lineWidth = 2.4;
  ctx.beginPath(); ctx.moveTo(targetMarkerX, targetY - 12); ctx.lineTo(targetMarkerX, targetY + 12); ctx.stroke();
  ctx.fillStyle = INK; ctx.fillText(targetLabel, targetTextX, targetY);
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
    x: "Longitudinal candidate position  zᵢ - z₀  (mm)",
    y: "Relative tube angle  β  (°)",
    xFormatter: xAxis.formatter,
    yFormatter: value => Number(value).toFixed(0),
    topMargin: publicationMode ? 116 : 164,
  });
  const { ctx, margin, innerWidth, innerHeight, x, yDown } = plot;
  const bandLimit = Math.min(xLimit, mode === "overview"
    ? (focusXLimit ?? diagram.zoomXLimit)
    : Math.max(diagram.interpolationBandHalfWidth ?? 0, 0.15));
  ctx.fillStyle = PALE;
  ctx.fillRect(x(-bandLimit), margin.top, x(bandLimit) - x(-bandLimit), innerHeight);
  if (mode === "overview") {
    ctx.fillStyle = "#557482";
    const annotation = "Pale band: enlarged range in 2B (not configured thickness T)";
    setFittedFigureFont(ctx, annotation, 18, 14, Math.max(160, 2 * bandLimit / (2 * xLimit) * innerWidth - 12));
    ctx.textAlign = "center";
    ctx.fillText(annotation, x(0), margin.top + 24);
  } else {
    ctx.fillStyle = "#557482";
    const annotation = "Circles: selected interpolation endpoints";
    setFittedFigureFont(ctx, annotation, 18, 14, Math.max(180, innerWidth * 0.42));
    ctx.textAlign = "right";
    ctx.fillText(annotation, margin.left + innerWidth - 12, margin.top + 24);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, innerWidth, innerHeight);
  ctx.clip();
  for (let row = 0; row < diagram.totalRows; row += 1) {
    for (const turn of diagram.traceGeometry.turns) {
      drawCandidateTrace(ctx, diagram, row, turn, x, yDown);
    }
  }
  if (mode === "zoom") {
    const pointsByWeight = [...diagram.weightedPoints].sort((a, b) => a.weight - b.weight);
    for (const point of pointsByWeight) {
      const px = x(point.x); const py = yDown(point.y);
      drawWeightedMarker(ctx, point.row, diagram.totalRows, px, py, 5.2, point.weight);
    }
  }
  ctx.strokeStyle = RED;
  ctx.setLineDash([]);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x(0), margin.top); ctx.lineTo(x(0), margin.top + innerHeight); ctx.stroke();
  ctx.restore();
  drawAxes(plot, xAxis.ticks, [0, 60, 120, 180, 240, 300, 360], true);
  const usedTurnText = diagram.usedTurns.length ? diagram.usedTurns.map(value => value > 0 ? `+${value}` : String(value)).join(", ") : "none";
  if (mode === "overview") {
    const countText = `All ${diagram.totalRows} row trajectories shown at each displayed angle (legend: ${Math.min(6, diagram.totalRows)} representative rows) / no T-based candidate exclusion / displayed rotations ${diagram.turnOffsetMin} to ${diagram.turnOffsetMax}`;
    drawOverviewLegend(ctx, diagram, margin.left, 8, innerWidth, publicationMode ? "" : countText);
  } else {
    const outside = diagram.usedTurnsOutsideOverview.length ? ` / ${diagram.usedTurnsOutsideOverview.length} rotations outside overview` : "";
    const countText = `Circles: interpolation endpoints selected from the all-row candidates (${diagram.renderedAngleSamples}/${diagram.samples} angular samples shown) / no T-based endpoint exclusion / contributing rotations ${usedTurnText}${outside}`;
    drawWeightLegend(
      ctx,
      margin.left,
      8,
      innerWidth,
      diagram.totalRows,
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
    x: "Direct-ray angle  β  (°)",
    y: "Angular separation to the complementary ray  Δβc  (°)",
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
    { label: "Ideal complementary-ray angular separation 180°+2γ", color: ORANGE },
    { label: "Nearest acquired view", color: INK, dash: [5, 4] },
    { label: "Two acquired views bracketing the ideal angle", color: LIGHT, dash: [8, 6] },
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
    x: "Direct-ray angle  β  (°)",
    y: "Longitudinal span  G  bracketing the target plane (mm)",
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
    { label: "Ideal angle: direct rayₙ → complementary rayₙ", color: BLUE },
    { label: "Ideal angle: complementary rayₙ → direct rayₙ₊₁", color: ORANGE, dash: [7, 5] },
    { label: "Gmin = min(G₁, G₂)", color: INK },
    { label: "Pale bands: two acquired views bracketing the ideal angle", color: LIGHT },
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
    x: "Direct-ray angle  β  (°)",
    y: "Candidate position relative to the target plane  z - z₀  (mm)",
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
    { label: "Nearest bracket after merging all candidates, Gmerge", color: LIGHT },
    { label: "Smaller-z side (markers: nearest acquired view)", color: BLUE },
    { label: "Larger-z side (markers: nearest acquired view)", color: ORANGE, dash: [7, 5] },
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
    drawCanvasStatus(canvas, "Computing candidate-point spread", "Waiting for the unweighted-standard-deviation calculation");
    return;
  }
  const angleCount = Math.min(
    Number(overlay.geometryAngleCount) || offValues.length,
    offValues.length,
    onValues.length,
    betaValues?.length ?? Infinity,
  );
  if (!(angleCount > 0)) {
    drawCanvasStatus(canvas, "Candidate-point spread unavailable", "No results are available by projection angle", "error");
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
    x: "Relative tube angle  β  (°)",
    y: "Longitudinal standard deviation of candidate positions  σz  (mm)",
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
  const title = "Axial spread of candidate points";
  setFittedFigureFont(plot.ctx, title, 25, 18, plot.innerWidth, "700");
  plot.ctx.fillText(title, plot.margin.left, 8);
  const subtitle = "Direct-side N rows plus all rows in acquired views bracketing the ideal complementary angle (unweighted)";
  plot.ctx.fillStyle = MUTED;
  setFittedFigureFont(plot.ctx, subtitle, 18, 13, plot.innerWidth);
  plot.ctx.fillText(subtitle, plot.margin.left, 43);
  drawLegend(plot.ctx, [
    { label: "Without cone-geometry scaling", color: BLUE },
    { label: "With cone-geometry scaling", color: ORANGE, dash: [9, 5] },
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

  const minimumHalfSpan = Math.max(0.75 * result.params.sliceThicknessMm, 6 * dz);
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
  drawKey(left, top + 20, BLUE, [], "Without cone-geometry scaling");
  drawKey(left + 410, top + 20, ORANGE, [], "With cone-geometry scaling (idealized)");
  ctx.restore();
}

function drawProfiles(canvas, result) {
  const publicationMode = canvas.dataset.publicationMode === "true";
  const axis = selectedProfileAxis(result);
  const { xMin, xMax } = axis;
  const plot = axisContext(canvas, { xMin, xMax, yMin: 0, yMax: 1.04 }, {
    x: "Position relative to reconstruction plane  z - z₀  (mm)",
    y: "Normalized SSPz",
    xFormatter: value => Number(value).toFixed(decimalPlacesForStep(axis.tickStep)),
    yFormatter: value => value.toFixed(1),
    topMargin: publicationMode ? 96 : 126,
  });
  const off = result.selectedOff.z.map((z, i) => [z, result.selectedOff.profile[i]]);
  const on = result.selectedOn.z.map((z, i) => [z, result.selectedOn.profile[i]]);
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
  drawAxes(plot, axis.ticks, [0, 0.2, 0.4, 0.6, 0.8, 1.0]);
  drawProfileEncodingLegend(plot.ctx, plot.margin.left, 6);
  plot.ctx.save();
  plot.ctx.fillStyle = MUTED;
  plot.ctx.font = `18px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "right";
  plot.ctx.textBaseline = "bottom";
  plot.ctx.fillText("50% (FWHM)", plot.margin.left + plot.innerWidth - 8, plot.y(0.5) - 5);
  plot.ctx.fillText("10% (FWTM)", plot.margin.left + plot.innerWidth - 8, plot.y(0.1) - 5);
  plot.ctx.restore();
  canvas.dataset.xMin = String(axis.xMin);
  canvas.dataset.xMax = String(axis.xMax);
  canvas.dataset.xStep = String(axis.tickStep);
  canvas.dataset.configuredThicknessMm = String(result.params.sliceThicknessMm);
  canvas.dataset.axisRule = "configured-output-at-or-above-ten-percent";
  canvas.dataset.legendOrder = "configured-output-only";
  canvas.setAttribute("aria-label", `Selected-state SSPz comparison after applying T=${fmt(result.params.sliceThicknessMm, 1)} mm. The horizontal range is determined from the central profile at or above 10%.`);
  if (profileAxisNote) {
    profileAxisNote.textContent = `Configured thickness T=${fmt(result.params.sliceThicknessMm, 1)} mm / horizontal range ${fmt(axis.xMin, decimalPlacesForStep(axis.tickStep))} to +${fmt(axis.xMax, decimalPlacesForStep(axis.tickStep))} mm (automatically determined from the post-thickness SSPz at or above 10%)`;
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
  ctx.fillText("360 states", x + 45, y);
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
  const core = configuredOverlayBounds(result, 0.1, 0.75 * result.params.sliceThicknessMm);
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
  const layered = result.params.profileMode === PROFILE_MODES.LAYERED_RECT;
  const tailView = viewMode === "tail";
  const stageLabel = tailView
    ? `Low-amplitude tails after applying T=${fmt(result.params.sliceThicknessMm, 1)} mm (log scale)`
    : layered
      ? `Primary display: central profiles after applying T=${fmt(result.params.sliceThicknessMm, 1)} mm`
      : `Model SSPz, T=${fmt(result.params.sliceThicknessMm, 1)} mm`;
  const plot = axisContext(canvas, {
    xMin,
    xMax,
    yMin: tailView ? PROFILE_TAIL_DISPLAY_BOUNDS.yMin : 0,
    yMax: tailView ? PROFILE_TAIL_DISPLAY_BOUNDS.yMax : 1.04,
  }, {
    x: "Position relative to reconstruction plane  z - z₀  (mm)",
    y: tailView ? "Normalized SSPz (log scale)" : "Normalized SSPz",
    xFormatter: xAxis.formatter,
    yFormatter: tailView
      ? value => ({ "-3": "0.1%", "-2": "1%", "-1": "10%", "0": "100%" }[String(value)] ?? "")
      : value => value.toFixed(1),
    topMargin: publicationMode ? 116 : 126,
    leftMargin: tailView ? 158 : undefined,
  });

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
  drawAxes(plot, xAxis.ticks, tailView ? [-3, -2, -1, 0] : [0, 0.2, 0.4, 0.6, 0.8, 1.0]);

  plot.ctx.save();
  plot.ctx.fillStyle = INK;
  plot.ctx.font = `700 23px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "left";
  plot.ctx.textBaseline = "top";
  const conditionLabel = coneOn ? "With cone-geometry scaling (periodic source-to-point distance)" : "Without cone-geometry scaling (parallel-beam approximation)";
  if (publicationMode) {
    const conciseCondition = coneOn ? "Cone-geometry scaling" : "Parallel-beam approximation";
    const conciseStage = tailView
      ? `Post-thickness low-amplitude tails (T=${fmt(result.params.sliceThicknessMm, 1)} mm)`
      : layered
        ? `Post-thickness central profiles (T=${fmt(result.params.sliceThicknessMm, 1)} mm)`
        : `Model SSPz (T=${fmt(result.params.sliceThicknessMm, 1)} mm)`;
    // Keep the scientific stage and geometry condition on separate lines.
    // A single English line exceeds the fixed 80-mm journal figure width.
    plot.ctx.fillText(conciseStage, plot.margin.left, 8);
    plot.ctx.font = `20px ${FIGURE_FONT}`;
    plot.ctx.fillText(conciseCondition, plot.margin.left, 38);
  } else {
    plot.ctx.fillText(stageLabel, plot.margin.left, 10);
    plot.ctx.fillStyle = MUTED;
    const statusLabel = `${conditionLabel} / complete states ${summary.completeCount}/${overlay.stateCount}`;
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
  canvas.dataset.viewMode = viewMode;
  if (tailView) {
    canvas.dataset.renderedMinimum = "0.001";
    canvas.dataset.displayYMinLog10 = String(PROFILE_TAIL_DISPLAY_BOUNDS.yMin);
    canvas.dataset.displayYMaxLog10 = String(PROFILE_TAIL_DISPLAY_BOUNDS.yMax);
  }
  canvas.dataset.sharedXDomain = tailView
    ? "configured-output-tail-cone-on"
    : "configured-output-core-off-on";
  canvas.setAttribute("aria-label", tailView
    ? `Log-scale display of post-thickness SSPz tails at or above 0.1% for 360 states: ${conditionLabel}`
    : `Linear display of post-thickness SSPz central profiles at or above 10% for 360 states: ${conditionLabel}`);
}

function selectedMetric(result) {
  const key = metricSelect.value;
  const labels = { fwhm: "FWHM", fwtm: "FWTM", sigma: "σ" };
  const layered = result?.params.profileMode === PROFILE_MODES.LAYERED_RECT;
  const stageLabel = layered
    ? `Post-thickness model SSPz (T=${fmt(result.params.sliceThicknessMm, 1)} mm)`
    : `Model SSPz (T=${fmt(result.params.sliceThicknessMm, 1)} mm)`;
  metricLabel.textContent = `${stageLabel} / ${labels[key]}`;
  return { key, rawKey: key, label: labels[key], stageLabel, layered };
}

function drawConditionLegend(ctx, left, y) {
  ctx.save();
  ctx.font = `21px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const items = [
    { x: left, color: BLUE, label: "Without cone-geometry scaling" },
    { x: left + 430, color: ORANGE, label: "With cone-geometry scaling (idealized)" },
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
    x: "Reconstruction-plane position within one table feed  s",
    y: `${metric.label} / T`,
    xFormatter: value => Number(value).toFixed(1),
    yFormatter: yScale.formatter,
    topMargin: publicationMode ? 78 : 134,
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
    const subtitle = metric.layered
      ? `${metric.label} computed after applying the configured slice thickness T=${fmt(result.params.sliceThicknessMm, 1)} mm`
      : `Model SSPz for configured slice thickness T=${fmt(result.params.sliceThicknessMm, 1)} mm`;
    plot.ctx.fillText(subtitle, plot.margin.left, 45);
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
    const structurallyConstrained = result.params.profileMode === PROFILE_MODES.LAYERED_RECT
      && metric.rawKey === "fwhm";
    sweepInterpretation.hidden = false;
    sweepInterpretation.textContent = structurallyConstrained
      ? "Because the explanatory model uses a rectangular window with the configured thickness, post-thickness FWHM/T is structurally constrained near 1. This plot does not show the intermediate width before thickness application. A flat curve does not prove that geometric effects are absent; inspect the complete post-thickness SSPz, FWTM/T, σ/T, and the angular-longitudinal diagram together."
      : `This plot shows ${metric.label}/T for ${metric.stageLabel}. It is not the intermediate width before thickness application. Interpret FWTM, σ, and the complete post-thickness SSPz together with FWHM.`;
  }
}

function renderSummary(result) {
  const primaryCards = [];
  const secondaryCards = [];
  const uses180Li = result.params.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI;
  const gapRatioLabel = uses180Li ? "Gₑff/T" : "Δz/T";
  for (const [key, label, css, spreadKey] of [
    ["off", "Without cone-geometry scaling", "", "allCandidateAxialSpreadOffMm"],
    ["on", "With cone-geometry scaling", "on", "allCandidateAxialSpreadOnMm"],
  ]) {
    const summary = result.summaries[key];
    const spreadValues = Array.from(result.overlay?.[spreadKey] ?? []).filter(Number.isFinite);
    const spreadMinimum = spreadValues.length ? Math.min(...spreadValues) : NaN;
    const spreadMaximum = spreadValues.length ? Math.max(...spreadValues) : NaN;
    primaryCards.push(`
      <div class="summary-card ${css}">
        <span>${label} / maximum longitudinal standard deviation of candidate positions (mm)</span>
        <strong>${fmt(spreadMaximum, 3)}</strong>
        <small>Projection-angle range ${fmt(spreadMinimum, 3)}–${fmt(spreadMaximum, 3)} mm / unweighted</small>
      </div>`);
    secondaryCards.push(`
      <div class="summary-card ${css}">
        <span>${label} / range of post-thickness SSPz FWHM/T</span>
        <strong>${fmt(summary.fwhm.range / result.params.sliceThicknessMm, 4)}</strong>
        <small>${fmt(summary.fwhm.min / result.params.sliceThicknessMm, 3)}–${fmt(summary.fwhm.max / result.params.sliceThicknessMm, 3)}</small>
      </div>`);
  }
  // SSPz-shape evidence is followed by the pre-adoption, unweighted geometric
  // spread of all row-center candidates for each direct-view angle.
  summaryCards.innerHTML = [...secondaryCards, ...primaryCards].join("");
  resultTable.innerHTML = [
    ["Without cone-geometry scaling (parallel-beam approximation)", result.selectedOff],
    ["With cone-geometry scaling (periodic source-to-point distance)", result.selectedOn],
  ].map(([label, row]) => `<tr><td>${label}</td><td>${fmt(row.fwhm, 3)}</td><td>${fmt(row.fwtm, 3)}</td><td>${fmt(row.sigma, 3)}</td><td>${fmt(row.bracketGapRatioMax, 3)}</td></tr>`).join("");
  const gapHeading = document.querySelector("#gap-summary-heading");
  if (gapHeading) gapHeading.textContent = `Maximum ${gapRatioLabel} (audit)`;
  const gapNote = document.querySelector("#gap-summary-note");
  if (gapNote) gapNote.textContent = uses180Li
    ? "Definitions: SSPz, longitudinal slice sensitivity profile; FWHM, full width at half maximum; FWTM, full width at tenth maximum; σ, standard deviation of the area-normalized SSPz. Gₑff/T is the angularly weighted bracket width of the two branches bracketing the ideal complementary angle, divided by the configured slice thickness. Displayed precision is for recording model output and does not represent measurement accuracy."
    : "Definitions: SSPz, longitudinal slice sensitivity profile; FWHM, full width at half maximum; FWTM, full width at tenth maximum; σ, standard deviation of the area-normalized SSPz. Δz/T is the spacing between the nearest direct-ray candidates bracketing the target plane, divided by the configured slice thickness. Displayed precision is for recording model output and does not represent measurement accuracy.";
  const caption = document.querySelector("#result-caption");
  if (caption) caption.textContent = `Results for inspected model state ${selectedStateIndex}/359 (s=${(selectedStateIndex / 360).toFixed(3)})`;
}

function updateProfileModelNote(result) {
  const multiComponent = Math.max(result.selectedOff.halfComponents, result.selectedOn.halfComponents) > 1;
  const pathText = result.params.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
    ? "In the primary analysis, all detector-row candidates from the direct and complementary ray families are merged separately at the two acquired views bracketing the ideal complementary angle of each direct-ray view. Nearest longitudinal brackets are formed in both branches and then combined by linear angular interpolation."
    : "In the comparator, the complementary-ray family is not used for SSPz; nearest longitudinal brackets are formed from direct-ray views over 0-360° only.";
  const candidateSpreadText = "The geometry display reports the unweighted longitudinal standard deviation of row-center positions for all direct-side rows and all rows in the acquired views bracketing the ideal complementary angle. Candidate selection, interpolation or reconstruction weighting, and thresholds based on configured thickness are not applied.";
  const modelText = `${reconstructionPathLabel(result.params.reconstructionPath)} / ${pathText} All primary displays and width metrics are derived from the 360 model SSPz curves within one table feed after application of the configured slice thickness T=${fmt(result.params.sliceThicknessMm, 1)} mm. The central shape at or above the 10% level is shown on a linear scale, while only the low-amplitude tail at or above 0.1% for the condition with cone-geometry scaling is shown separately on a logarithmic scale. Intermediate SSPz curves and widths before thickness application are excluded from the public figures and width analysis.${candidateSpreadText} FWHM is not fitted; it is calculated from the curves after thickness application. Scanner-specific detector-channel interpolation, redundancy weighting, cone-beam weighting, and backprojection are not reproduced.`;
  const topologyText = multiComponent
    ? " Caution: the 50% level is split into multiple components; do not represent the profile by FWHM alone."
    : "";
  profileModelNote.textContent = modelText + topologyText;
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
    drawCanvasStatus(canvas, localizedText("Geometry unavailable", "Geometry unavailable"), "", "error");
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
  ctx.fillText(localizedText("A  Acquisition geometry (object-fixed; not to scale)", "A  Acquisition geometry (object-fixed; not to scale)"), panelA.x + 12, panelA.y + 10, panelA.width - 24);
  ctx.fillText(localizedText("B  All row positions and candidates nearest the reconstruction plane", "B  All row positions and candidates nearest to the reconstruction plane"), panelB.x + 12, panelB.y + 10, panelB.width - 24);

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
      localizedText(`s=0 (current)  z₀=zref`, `s=0 (current)  z₀=zref`),
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
      localizedText(`current s=${shortState}  z₀`, `current s=${shortState}  z₀`),
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
      localizedText(`current s=${shortState}  z₀`, `current s=${shortState}  z₀`),
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
  ctx.fillText(localizedText("Direct side β", "Direct side β"), directSource.x + 7, directSource.y - 17);
  ctx.fillStyle = ORANGE;
  ctx.fillText(localizedText("Acquired complementary views", "Acquired complementary views"), complementSource.x + 7, complementSource.y + 7, panelA.width * 0.38);
  ctx.fillStyle = "#4f5b63";
  ctx.fillText(localizedText("Ideal βc", "Ideal βc"), idealSource.x + 7, idealSource.y - 18);
  ctx.fillStyle = RED;
  ctx.save();
  ctx.strokeStyle = RED;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(panelA.x + 12, panelA.y + 38);
  ctx.lineTo(panelA.x + 34, panelA.y + 38);
  ctx.stroke();
  ctx.fillText(
    localizedText("Selected reconstruction plane z₀", "Selected reconstruction plane z₀"),
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
    localizedText(`Thin rays show ${representativeRows.length} representative rows; circles and triangles mark candidates nearest the reconstruction plane (candidate selection and weighting are not shown)`, `Thin rays show ${representativeRows.length} representative rows; circles and triangles mark candidates nearest to the reconstruction plane (no adoption or weight is shown)`),
    panelA.x + 12,
    panelA.y + panelA.height - 21,
    panelA.width - 24,
  );

  // Panel B: every detector-row center for the direct view and both acquired
  // neighbors bracketing the ideal complementary angle.  Row centers are
  // short ticks; only selected reconstruction candidates receive markers.
  const columns = [
    { key: "direct", family: scene.direct, xFraction: 0.22, color: BLUE, label: localizedText("Direct side β", "Direct β") },
    { key: "complementary-lower", family: scene.complementaryLower, xFraction: 0.54, color: ORANGE, label: localizedText("Complement lower view", "Complement lower view") },
    { key: "complementary-upper", family: scene.complementaryUpper, xFraction: 0.82, color: ORANGE, label: localizedText("Complement upper view", "Complement upper view") },
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
    `Current conditions: N=${scene.rows} rows, d=${scene.rowWidth.toFixed(3)} mm, p=${scene.beamPitch.toFixed(3)}, and table feed per rotation F=${scene.feed.toFixed(3)} mm. The selected reconstruction plane z₀=${scene.z0.toFixed(3)} mm lies ${(scene.state * scene.feed).toFixed(3)} mm from the reference plane zref, corresponding to s=${scene.state.toFixed(3)}. Circles and triangles mark the direct- and complementary-side candidates nearest the reconstruction plane as positional guides. Candidate selection and weighting are not shown.`,
    `Current conditions: N=${scene.rows} rows, d=${scene.rowWidth.toFixed(3)} mm, p=${scene.beamPitch.toFixed(3)}, and table feed per rotation F=${scene.feed.toFixed(3)} mm. The selected reconstruction plane z₀=${scene.z0.toFixed(3)} mm lies ${(scene.state * scene.feed).toFixed(3)} mm from the reference plane zref, corresponding to s=${scene.state.toFixed(3)}. Circles and triangles mark the direct- and complementary-side candidates nearest to the reconstruction plane as positional guides. Candidate adoption and weights are not shown.`,
  );
}

function renderInspectionDetails(result) {
  const overviewLimit = Math.max(result.diagramOff.overviewXLimit, result.diagramOn.overviewXLimit);
  const zoomLimit = Math.max(result.diagramOff.zoomXLimit, result.diagramOn.zoomXLimit);
  const overviewScope = document.querySelector("#overview-scope");
  const calculationScope = document.querySelector("#calculation-scope");
  overviewScope.textContent = `Automatic display range: among the all-row candidate trajectories, rotations containing selected endpoints plus one neighboring rotation on each side (offsets from the reference rotation ${result.diagramOff.turnOffsetMin} to ${result.diagramOff.turnOffsetMax}; ${result.diagramOff.turnCount} rotations total)`;
  const complementary = result.diagramOn.complementaryCandidates;
  const applicationText = result.params.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
    ? "SSPz uses linear angular interpolation between the brackets from the two neighboring acquired views"
    : "Section 2C is a geometry audit only (SSPz uses the direct-ray full scan)";
  calculationScope.textContent = `${reconstructionPathLabel(result.params.reconstructionPath)} / all ${result.params.rows} rows in every acquired view retained as the candidate population (no T-based exclusion) / the same all-row rule is used for acquired views bracketing the ideal complementary angle / ${applicationText} / maximum angular quantization difference ${fmt(complementary.maximumAngularResidualDeg, 4)}°`;
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
  const layered = result.params.profileMode === PROFILE_MODES.LAYERED_RECT;
  const finalHeading = document.querySelector("#overlay-core-heading");
  const finalDescription = document.querySelector("#overlay-core-description");
  if (finalHeading) finalHeading.textContent = layered
    ? `Primary display: central profiles after applying T=${fmt(result.params.sliceThicknessMm, 1)} mm`
    : "Model SSPz";
  if (finalDescription) finalDescription.textContent = layered
    ? "Linear display at or above 10% for comparison of geometric variation remaining after application of the configured thickness"
    : "Explanatory model SSPz";
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
    overlayScope.textContent = `${reconstructionPathLabel(result.params.reconstructionPath)} / one table feed divided into ${result.overlay.stateCount} model states (equivalent to 1° increments) / ${result.params.viewSamples} reference views per state`;
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
  const header = ["model_version","reconstruction_path","data_kind","scan_angular_range_deg","candidate_ray_family_count","direct_view_samples_per_rotation","profile_mode","candidate_selection_rule","configured_slice_thickness_mm","assumed_slice_kernel_width_mm","model_state_index","model_state_fraction_within_one_table_feed","z0_mm","idealized_source_to_point_distance_scaling","bracket_gap_mean_mm","bracket_gap_max_mm","bracket_gap_ratio_mean","bracket_gap_ratio_max","exact_candidate_fraction","maximum_view_contribution_error","maximum_angular_interpolation_weight_error","maximum_longitudinal_moment_residual_mm","mean_geometry_kernel_second_moment_mm2","analytic_base_sigma_mm","analytic_configured_sigma_mm","numerical_sigma_residual_mm","pre_normalization_area","pre_normalization_peak","configured_output_fwhm_mm","configured_output_fwtm_mm","configured_output_sigma_mm","coverage","profile_area_mm","centroid_mm","half_height_component_count"];
  const rows = lastResult.sweep.map(row => [MODEL_VERSION,row.reconstructionPath ?? lastResult.params.reconstructionPath,row.dataKind ?? "",360,row.candidateRayFamilyCount ?? (lastResult.params.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI ? 2 : 1),lastResult.params.viewSamples,lastResult.params.profileMode,row.candidateSelectionRule ?? lastResult.assumptions.candidateSelectionRule,lastResult.params.sliceThicknessMm,lastResult.assumptions.sliceKernelWidthMm,row.stateIndex,row.state,row.z0,row.coneOn,row.bracketGapMeanMm,row.bracketGapMaxMm,row.bracketGapRatioMean,row.bracketGapRatioMax,row.exactCandidateFraction,row.maximumViewContributionError,row.maximumAngularInterpolationWeightError,row.maximumLongitudinalMomentResidualMm,row.meanKernelSecondMomentMm2,row.analyticBaseSigmaMm,row.analyticConfiguredSigmaMm,row.numericalSigmaResidualMm,row.preNormalizationArea,row.preNormalizationPeak,row.fwhm,row.fwtm,row.sigma,row.coverage,row.area,row.centroid,row.halfComponents]);
  const csv = [header, ...rows].map(row => row.map(csvEscape).join(",")).join("\n");
  downloadBlob(`sspz_${reconstructionPathUrlValue(lastResult.params.reconstructionPath)}_geometry_state_sweep.csv`, `\uFEFF${csv}`);
}

function downloadProfileCsv() {
  if (!lastResult) return;
  const rows = [["model_version","reconstruction_path","model_state_index","z_mm","configured_output_sspz_distance_change_off","configured_output_sspz_distance_change_on"]];
  const length = Math.min(lastResult.selectedOff.z.length, lastResult.selectedOn.z.length);
  for (let i = 0; i < length; i += 1) {
    rows.push([MODEL_VERSION,lastResult.params.reconstructionPath,selectedStateIndex,lastResult.selectedOff.z[i],lastResult.selectedOff.profile[i],lastResult.selectedOn.profile[i]]);
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
  throw new Error(`Unsupported figure ID: ${canvasId}`);
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
    filename = `sweep-configured-thickness-${metric.rawKey}-T${thickness}mm-r${radius}mm.png`;
  } else if (canvasId.startsWith("overlay-") && lastResult) {
    const [, viewMode, condition] = canvasId.split("-");
    const thickness = String(Number(lastResult.params.sliceThicknessMm)).replace(".", "p");
    const radius = String(Number(lastResult.params.radius)).replace(".", "p");
    filename = `sspz-overlay-configured-${viewMode}-T${thickness}mm-r${radius}mm-${condition}-360-relative-states.png`;
  } else if (canvasId === "candidate-axial-spread-chart" && lastResult) {
    const rows = String(Number(lastResult.params.rows));
    const rowWidth = String(Number(lastResult.params.rowWidth)).replace(".", "p");
    const pitch = String(Number(lastResult.params.beamPitch)).replace(".", "p");
    const radius = String(Number(lastResult.params.radius)).replace(".", "p");
    filename = `geometry-all-candidate-axial-spread-N${rows}-d${rowWidth}mm-p${pitch}-r${radius}mm-${lastResult.params.viewSamples}views.png`;
  } else if (canvasId === "profile-chart" && lastResult) {
    filename = `sspz-detail-state-${selectedStateIndex}-of-360.png`;
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
    target.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG generation failed.")), "image/png");
  });
  const publicationBlob = await pngWithResolution(rawBlob, PUBLICATION_DPI);
  downloadBlob(publicationFilename(canvasId), publicationBlob, "image/png");
  status.textContent = `Saved a publication PNG at ${publicationWidthMm(canvasId)} mm width and ${PUBLICATION_DPI} dpi (${target.width} x ${target.height} px)`;
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
  try { await navigator.clipboard.writeText(url); status.textContent = "Condition URL copied"; }
  catch { window.prompt("Copy this URL", url); }
});
form.addEventListener("input", () => {
  updateInputDecorations();
  if (!runButton.disabled) status.textContent = "Conditions changed. Select Compute to update the results.";
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
  status.textContent = "The transaxial position changed. Select Compute to update the results.";
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
      return { ...stored, sliceThicknessMm: stored.targetFwhm };
    }
    return stored;
  }
  catch { return DEFAULT_PARAMS; }
})();
writeParams({ ...DEFAULT_PARAMS, ...initial });
if (legacyUrlNote) {
  legacyUrlNote.hidden = !legacyInputMigrated;
  if (legacyInputMigrated) legacyUrlNote.textContent = "The legacy URL or saved settings were migrated to the current model. Previous calculated values are not reused; SSPz is recomputed using the default 180LI acquisition geometry and therefore may differ from the legacy result. For comparison, select the direct-ray 0-360° full scan under acquisition geometry.";
}
runSimulation();

})();
