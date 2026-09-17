(() => {
"use strict";
// Shared physical cell aperture. Coordinates, pitch and aperture use the same
// units. Sampling pitch is not aperture width; a gap is not filled by a ray.
function detectorCellMembership(coordinate, pitch, aperture, count) {
  if (!(pitch > 0 && aperture > 0 && aperture <= pitch && Number.isInteger(count) && count > 0))
    throw Error('DETECTOR_APERTURE: require 0 < aperture <= channel spacing');
  const q=coordinate/pitch+(count-1)/2, radius=aperture/(2*pitch), out=[];
  for(let k=Math.max(0,Math.ceil(q-radius-1e-10));k<=Math.min(count-1,Math.floor(q+radius+1e-10));k++){
    const distance=Math.abs(q-k), boundary=Math.abs(distance-radius)<=1e-10;
    if(boundary||distance<radius)out.push([k,boundary?.5:1]);
  }
  return out;
}

// A unit-integral Cartesian point projected onto the source-centred cylinder.
// Transaxial coordinates are R*gamma; axial coordinates are cylinder heights.
// parallel=true is the explicitly nondivergent reference acquisition, not FBP.
function detectorPointProjection(c,beta,zObject,parallel=false){
  const R=c.sourceRadius, L=parallel?R:Math.hypot(R*Math.cos(beta)-c.radius,R*Math.sin(beta));
  const transverse=parallel?-c.radius*Math.sin(beta):R*Math.atan2(-c.radius*Math.sin(beta),R-c.radius*Math.cos(beta));
  const sourceZ=c.sourceZ, w=parallel?zObject-sourceZ:R*(zObject-sourceZ)/L;
  const aperture=c.channelApertureMm??c.channelWidth;
  const js=detectorCellMembership(transverse,c.channelWidth,aperture,c.channels);
  const ks=detectorCellMembership(w,c.rowWidth,c.rowWidth,c.rows);
  const empty={j0:0,j1:-1,k0:0,k1:-1,width:0,height:0,data:new Float64Array(0),transverse,w};
  if(!js.length||!ks.length)return empty;
  const j0=js[0][0],j1=js.at(-1)[0],k0=ks[0][0],k1=ks.at(-1)[0];
  const width=j1-j0+1,height=k1-k0+1,data=new Float64Array(width*height);
  const signal=parallel?1/(aperture*c.rowWidth):Math.hypot(R,w)/(L*L*(aperture/R)*c.rowWidth);
  for(const [j,a] of js)for(const [k,b] of ks)data[(k-k0)*width+j-j0]=signal*a*b;
  return {j0,j1,k0,k1,width,height,data,transverse,w};
}

// Read the acquired, cell-averaged data at the ray through the transverse point.
// This is interpolation of acquired channels, not an average of finished SSPs.
function detectorRowReadout(c,p,row){
  if(row<p.k0||row>p.k1)return 0;
  const q=p.transverse/c.channelWidth+(c.channels-1)/2,j=Math.floor(q),a=q-j;
  const at=k=>k<p.j0||k>p.j1?0:p.data[(row-p.k0)*p.width+k-p.j0];
  return (1-a)*at(j)+a*at(j+1);
}

const MODEL_VERSION = "2026-09-17.4";

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
  channelWidth: .25,
  channelApertureMm: .25,
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
    channelWidth: Number(input.channelWidth??.25),
    channelApertureMm: Number(input.channelApertureMm??input.channelWidth??.25),
    detectorModel: input.detectorModel==='finite-channel'?'finite-channel':'axial-only-legacy',
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
    // Public browser callers explicitly map FW=T. The independent-width API
    // retains historical behavior for reproducibility and filter validation.
    thicknessMapping: input.thicknessMapping === 'configured-rectangular' ? 'configured-rectangular' : 'independent-reference',
    filterWidthMm: Number(input.thicknessMapping === 'configured-rectangular' ? (input.sliceThicknessMm ?? input.targetFwhm) : (input.filterWidthMm ?? input.sliceThicknessMm ?? input.targetFwhm)),
    filterSamples: Number(input.filterSamples ?? 129),
    filterWidthInitialization: input.thicknessMapping === 'configured-rectangular' ? 'configured-thickness-as-rectangular-width' : input.filterWidthInitialization
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
  if (finite.length) throw new Error(`数値として解釈できない入力があります: ${finite.map(([key]) => key).join(", ")}`);
  if (p.rows < 1 || p.rows > 320) throw new Error("検出器列数は1〜320にしてください。");
  if (p.rowWidth <= 0 || p.rowWidth > 10) throw new Error("1列幅は0より大きく10 mm以下にしてください。");
  if(!(p.channelWidth>=.05&&p.channelWidth<=1&&p.channelApertureMm>0&&p.channelApertureMm<=p.channelWidth))throw new Error('DETECTOR_APERTURE: require 0 < aperture <= channel spacing (0.05–1 mm)');
  if (p.beamPitch < 0 || (!allowZeroPitch && p.beamPitch === 0) || p.beamPitch > 3) throw new Error("ビームピッチは0より大きく3以下にしてください。");
  if (p.sourceRadius <= 0) throw new Error("焦点―回転中心距離は正にしてください。");
  if (p.radius > 250) throw new Error("横断面内位置の回転中心からの距離は0〜250 mmにしてください。");
  if (p.radius >= p.sourceRadius) throw new Error("横断面内位置の回転中心からの距離は、焦点―回転中心距離未満にしてください。");
  if (p.sliceThicknessMm <= 0 || p.sliceThicknessMm > 20) throw new Error("設定スライス厚は0より大きく20 mm以下にしてください。");
  if (p.filterWidthMm < 0 || p.filterWidthMm > 20) throw new Error("フィルタ幅 FW は0〜20 mmにしてください。");
  if (!Number.isInteger(p.filterSamples) || p.filterSamples < 33 || p.filterSamples > 2049
    || p.filterSamples % 2 !== 1) throw new Error("フィルタの再標本化点数は33〜2049の奇数にしてください。");
  if (p.viewSamples < 90 || p.viewSamples > 2400) throw new Error("1回転の相対X線管角度サンプル数は90〜2400にしてください。");
  if (p.zSamples < 300 || p.zSamples > 4000) throw new Error("SSPzグリッド点数は300〜4000にしてください。");
  if (p.stateSamples < 12 || p.stateSamples > 720) throw new Error("状態スイープ数は12〜720にしてください。");
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
    throw new Error("直接投影ビュー索引は整数にしてください。");
  }
  const commonTurnShift = Number(options.commonTurnShift ?? 0);
  if (!Number.isInteger(commonTurnShift)) {
    throw new Error("全候補に共通する回転移動量は整数にしてください。");
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
    throw new Error(`未対応の取得幾何モデルです: ${reconstructionPath}`);
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
    const acquired=p.detectorModel==='finite-channel'?axialDetectorProjection(p,zObject,angleRad,turn,coneOn):null;
    const firstRow = Math.max(0, Math.min(p.rows - 1,
      Math.floor((left - firstAtTurn) / aperture)));
    const lastRow = Math.max(0, Math.min(p.rows - 1,
      Math.ceil((right - firstAtTurn) / aperture)));
    for (let row = firstRow; row <= lastRow; row += 1) {
      const offset = firstAtTurn + row * aperture - zObject;
      const boundaryDistance = Math.abs(offset) - aperture / 2;
      // The half-height boundary is the symmetric thin-bead limit of a
      // rectangular detector aperture, avoiding double-height edge ties.
      const response = acquired?detectorRowReadout(acquired.config,acquired.projection,row):Math.abs(boundaryDistance) <= 1e-10
        ? 0.5 / aperture
        : boundaryDistance < 0 ? 1 / aperture : 0;
      knots.push({ x: offset, y: response });
    }
  }
  return knots;
}

function axialDetectorProjection(p,zObject,angleRad,turn=0,coneOn=true){
  // Even channel grid with half-integer centres, identical to the 3D path.
  // Extra empty outer channels do not change the interior sample locations.
  const channels=2*Math.ceil((Math.asin(p.radius/p.sourceRadius)*p.sourceRadius+3*p.channelWidth)/p.channelWidth);
  const config={...p,channels,sourceZ:tableFeedMm(p)*(angleRad/PI2+turn)};
  return {config,projection:detectorPointProjection(config,angleRad-p.phase,zObject,!coneOn)};
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
    throw new Error(`未対応の取得幾何モデルです: ${reconstructionPath}`);
  }
  const filterWidthMm = Number(p.thicknessMapping === 'configured-rectangular' ? p.sliceThicknessMm : (options.filterWidthMm ?? p.filterWidthMm));
  const filterSamples = Number(options.filterSamples ?? p.filterSamples);
  if (!Number.isFinite(filterWidthMm) || filterWidthMm < 0 || filterWidthMm > 20
    || !Number.isInteger(filterSamples) || filterSamples < 33 || filterSamples > 2049
    || filterSamples % 2 !== 1) throw new Error("フィルタ幅または再標本化点数が範囲外です。");
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
    fixedObjectResponseDefinition: p.detectorModel==='finite-channel'
      ? 'shared-unit-point-detector-cell-integral-and-linear-channel-readout; axial interpolation only, no transaxial ramp or image backprojection'
      : "unit-area-projected-rectangular-row-aperture-half-height-at-exact-boundaries",
    detectorModel: p.detectorModel,
    channelApertureMm: p.channelApertureMm,
    channelSpacingMm: p.channelWidth,
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
    mapping: p.thicknessMapping === 'configured-rectangular' ? 'configured-thickness-as-rectangular-width-not-prescribed-fwhm' : "independent-filter-width-not-fitted-to-configured-thickness",
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
  const filterWidthMm = Number(p.thicknessMapping === 'configured-rectangular' ? p.sliceThicknessMm : (options.filterWidthMm ?? assumptions.filterWidthMm ?? p.filterWidthMm));
  const requestedFilterSamples = Number(options.filterSamples ?? assumptions.filterSamples ?? p.filterSamples);
  if (!Number.isFinite(filterWidthMm) || filterWidthMm < 0 || filterWidthMm > 20
    || !Number.isInteger(requestedFilterSamples) || requestedFilterSamples < 33
    || requestedFilterSamples > 2049 || requestedFilterSamples % 2 !== 1) {
    throw new Error("フィルタ幅または再標本化点数が範囲外です。");
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
    throw new Error(`FW=${filterWidthMm} mmでは再標本化点数が少なくとも${accuracyRequiredFilterSamples}点必要です。現行の精度上限2049点を超えるため、この条件のSSPzは表示しません。`);
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

// Two alternating axial focal positions with a fixed cylindrical detector.
// The quarter-row default follows the isocentre interlacing in Mori (2008),
// Fig. 4 / Eqs. 19-22. Pure axial motion is an explicit idealization.
const ZFFS_VERSION='2026-09-17.1';
function zffsConfig(input,c){
  c.zFfsEnabled=input.zFfsEnabled===true||input.zFfsEnabled===1||input.zFfsEnabled==='1';
  if(!c.zFfsEnabled)return c;
  c.zFfsMagnification=Number(input.zFfsMagnification??(1072/600));
  c.zFfsOffset=Number(input.zFfsOffset??.25);
  if(!(Number.isFinite(c.zFfsMagnification)&&c.zFfsMagnification>1&&c.zFfsMagnification<=4))throw Error('ZFFS_GEOMETRY: detector magnification must be > 1 and <= 4');
  if(!(Number.isFinite(c.zFfsOffset)&&c.zFfsOffset>=0&&c.zFfsOffset<=.5))throw Error('ZFFS_GEOMETRY: isocentre half-offset must be 0 to 0.5 row pitches');
  if(c.axialRule==='parallel')throw Error('ZFFS_GEOMETRY: focal switching requires cone-ray geometry');
  c.zFfsSourceDetectorMm=c.sourceRadius*c.zFfsMagnification;
  if(c.zFfsSourceDetectorMm<=c.sourceRadius+c.radius)throw Error('ZFFS_GEOMETRY: detector must lie beyond the evaluation point for every view');
  c.zFfsSourceOffsetMm=c.zFfsOffset*c.rowWidth/(1-1/c.zFfsMagnification);
  return c;
}
function zffsState(view){return ((view%2)+2)%2;}
function zffsShift(c,focus){return (focus===0?-1:1)*c.zFfsSourceOffsetMm;}
function zffsRowGeometry(c,view,row){
  const beta=c.phase+2*Math.PI*view/c.viewSamples;
  const L=Math.hypot(c.sourceRadius*Math.cos(beta)-c.radius,c.sourceRadius*Math.sin(beta));
  const focus=zffsState(view),shift=zffsShift(c,focus),baseZ=c.feed*view/c.viewSamples;
  const spacing=c.rowWidth*L/c.sourceRadius;
  const origin=baseZ+shift*(1-L/c.zFfsSourceDetectorMm);
  return {view,row,focus,beta,theta:beta,sourceZ:baseZ+shift,baseZ,L,spacing,z:origin+(row-(c.rows-1)/2)*spacing};
}
function zffsRebinStencil(c,theta,focus){
  const gamma=Math.asin(-c.radius*Math.sin(theta)/c.sourceRadius),beta=theta+gamma;
  // Coincident foci are one acquisition trajectory: use the original full grid.
  const stride=c.zFfsOffset===0?1:2,origin=c.zFfsOffset===0?0:focus;
  const vf=(beta-c.phase)*c.viewSamples/(2*Math.PI),q=(vf-origin)/stride,i=Math.floor(q),a=q-i;
  const jf=gamma*c.sourceRadius/c.channelWidth+(c.channels-1)/2,j=Math.floor(jf),b=jf-j;
  const out=[];
  for(const [view,wv] of [[origin+stride*i,1-a],[origin+stride*(i+1),a]])for(const [channel,wc] of [[j,1-b],[j+1,b]]){
    const weight=wv*wc;if(weight>1e-14)out.push({view,channel,weight});
  }
  return {beta,gamma,stencil:out};
}

// Presentation/export only: does not alter the acquisition or response model.
globalThis.SSPZShape = (() => {
  function analyze(overlay, key, step = 0.01) {
    const {z, zCount:n, stateCount:count} = overlay, c=overlay[key], valid=[], mid=[], fwhm=[];
    for(let s=0;s<count;s++) {
      if(c.coverage[s]<1-1e-7) continue;
      const y=c.final.subarray(s*n,(s+1)*n);let peak=0;
      for(let i=1;i<n;i++) if(y[i]>y[peak]) peak=i;
      const level=y[peak]/2;let l=peak,r=peak;
      while(l>0&&y[l]>=level)l--;while(r<n-1&&y[r]>=level)r++;
      if(l===peak||r===peak||y[l]>=level||y[r]>=level)continue;
      const left=z[l]+(level-y[l])*(z[l+1]-z[l])/(y[l+1]-y[l]);
      const right=z[r-1]+(level-y[r-1])*(z[r]-z[r-1])/(y[r]-y[r-1]);
      valid.push(s);mid.push((left+right)/2);fwhm.push(right-left);
    }
    if(!valid.length)throw new Error('No complete profiles with valid bilateral FWHM crossings.');
    const start=Math.ceil(Math.max(...mid.map(m=>z[0]-m))/step-1e-9);
    const stop=Math.floor(Math.min(...mid.map(m=>z[n-1]-m))/step+1e-9);
    const x=Float64Array.from({length:Math.max(0,stop-start+1)},(_,i)=>(start+i)*step);
    if(!x.length)throw new Error('No shared aligned support.');
    const aligned=valid.map((s,j)=>{
      const out=new Float64Array(x.length);let k=0;
      for(let i=0;i<x.length;i++) {
        const target=x[i]+mid[j];while(k<n-2&&z[k+1]<target)k++;
        const t=(target-z[k])/(z[k+1]-z[k]);
        out[i]=c.final[s*n+k]*(1-t)+c.final[s*n+k+1]*t;
      }return out;
    });
    const mean=Float64Array.from(x,(_,i)=>aligned.reduce((sum,y)=>sum+y[i],0)/valid.length);
    const delta=aligned.map(y=>Float64Array.from(y,(v,i)=>v-mean[i]));
    let maximum=.06; for(const y of delta)for(const v of y)maximum=Math.max(maximum,Math.abs(v));
    const limit=Math.ceil((maximum-1e-12)/.02)*.02;
    const width=.002,low=-limit,bins=Math.round(2*limit/width), hist=new Float64Array(x.length*bins),outside=new Uint16Array(x.length);
    delta.forEach(y=>y.forEach((v,i)=>{let b=Math.floor((v-low)/width);if(b===bins&&v<=limit+1e-12)b=bins-1;if(b<0||b>=bins)outside[i]++;else hist[i*bins+b]+=1/valid.length;}));
    return {x,valid,mid,fwhm,aligned,mean,delta,hist,outside,bins,low,width,step};
  }
  const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  function column(i){let s='';for(i++;i;i=Math.floor((i-1)/26))s=String.fromCharCode(65+(i-1)%26)+s;return s;}
  function sheet(rows) {
    return '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" state="frozen"/></sheetView></sheetViews><sheetData>'+rows.map((row,r)=>'<row r="'+(r+1)+'">'+row.map((v,c)=>{const ref=column(c)+(r+1);return typeof v==='number'&&Number.isFinite(v)?'<c r="'+ref+'"><v>'+v+'</v></c>':'<c r="'+ref+'" t="inlineStr"><is><t>'+escape(v??'')+'</t></is></c>';}).join('')+'</row>').join('')+'</sheetData></worksheet>';
  }
  async function zip(files) {
    const enc=new TextEncoder(),parts=[],directory=[];let offset=0;
    const table=Uint32Array.from({length:256},(_,i)=>{let v=i;for(let b=0;b<8;b++)v=v&1?0xedb88320^(v>>>1):v>>>1;return v>>>0;});
    for(const [name,content] of files){const nameBytes=enc.encode(name),bytes=enc.encode(content);let crc=0xffffffff;for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);crc=(crc^0xffffffff)>>>0;
      let packed=bytes,method=0;
      try {packed=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());method=8;} catch { /* Standards-compatible uncompressed ZIP fallback. */ }
      const head=new Uint8Array(30+nameBytes.length),h=new DataView(head.buffer);h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(8,method,true);h.setUint32(14,crc,true);h.setUint32(18,packed.length,true);h.setUint32(22,bytes.length,true);h.setUint16(26,nameBytes.length,true);head.set(nameBytes,30);
      const entry=new Uint8Array(46+nameBytes.length),e=new DataView(entry.buffer);e.setUint32(0,0x02014b50,true);e.setUint16(4,20,true);e.setUint16(6,20,true);e.setUint16(10,method,true);e.setUint32(16,crc,true);e.setUint32(20,packed.length,true);e.setUint32(24,bytes.length,true);e.setUint16(28,nameBytes.length,true);e.setUint32(42,offset,true);entry.set(nameBytes,46);directory.push(entry);parts.push(head,packed);offset+=head.length+packed.length;
    }
    const size=directory.reduce((n,a)=>n+a.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,size,true);e.setUint32(16,offset,true);
    return new Blob([...parts,...directory,end],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  }
  function workbook(result,analyses,version){
    const o=result.overlay,sheets=[];
    sheets.push(['Readme',[
      ['SSPz simulation export','Value'],['model_version',version],['export_version','2026-09-15.5'],['generated_utc',new Date().toISOString()],
      ['normalization','Peak-normalized model profiles; no measured data'],['native_coordinate','reconstruction-plane minus fixed-object position (mm)'],['aligned_coordinate','z position relative to native FWHM midpoint (mm)'],['alignment','Bilateral native linear half-height crossings; translation only'],['resampling','0.01 mm linear grid; common finite support; no extrapolation or smoothing'],['deviation','Each aligned profile minus its condition-specific pointwise arithmetic mean'],['inclusion','Complete coverage and valid bilateral FWHM crossings; excluded states retained in Native sheets'],['numeric_storage','Native model overlay arrays are Float32; exported without display rounding'],['distribution','Fractions describe sampled model states, not measured tube-angle probabilities'],['histogram','Minimum extent -0.06 to +0.06, expanded to contain all deviations; width 0.002; intensity fraction^0.35, fixed 0..1; arrows show mean individual native FWHM'],['units','Positions and widths: mm; normalized SSPz and deviations: dimensionless'],['acquired_signal','Unit point integrated over shared finite channel/row cells; linear transaxial readout before axial interpolation; no transaxial ramp or image backprojection'],['detector_spacing','parameter_channelWidth is center spacing; parameter_channelApertureMm is active width; both at isocenter'],['off_condition','Parallel reference; no cone distance scaling'],['on_condition','Fan-beam cone geometry'],...Object.entries(result.params).map(([k,v])=>['parameter_'+k,typeof v==='object'?JSON.stringify(v):v])]]);
    for(const key of ['off','on']){const a=analyses[key],ids=Array.from({length:o.stateCount},(_,i)=>'state_'+i);
      const nativeRows=Array.from(o.z,(z,i)=>[z,...ids.map((_,s)=>o[key].final[s*o.zCount+i])]);
      sheets.push([key+'_Native',[['z_position_mm',...ids],...nativeRows]]);
      const headers=['z_position_mm',...a.valid.map(s=>'state_'+s)];
      for(const [label,series] of [['Aligned',a.aligned],['Deviation',a.delta]])sheets.push([key+'_'+label,[headers,...Array.from(a.x,(z,i)=>[z,...series.map(y=>y[i])])]]);
      sheets.push([key+'_Mean',[['z_position_mm','mean_sspz','outside_histogram_count'],...Array.from(a.x,(z,i)=>[z,a.mean[i],a.outside[i]])]]);
      sheets.push([key+'_States',[['state_index','object_position_fraction','included_in_shape','FWHM_midpoint_mm','coverage'],...ids.map((_,s)=>{const j=a.valid.indexOf(s);return [s,o.states[s],j>=0?1:0,j>=0?a.mid[j]:'',o[key].coverage[s]];})]]);
    }
    const keys=Object.keys(result.sweep[0]??{});sheets.push(['Width_metrics',[keys,...result.sweep.map(r=>keys.map(k=>r[k]))]]);
    return fromSheets(sheets);
  }
  function fromSheets(sheets) {
    const files=[['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+sheets.map((_,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')+'</Types>'],['_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],['xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+sheets.map(([name],i)=>'<sheet name="'+escape(name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets></workbook>'],['xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+sheets.map((_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+'</Relationships>']];
    sheets.forEach(([,rows],i)=>files.push(['xl/worksheets/sheet'+(i+1)+'.xml',sheet(rows)]));return zip(files);
  }
  return {analyze,workbook,fromSheets};
})();

// Shared manuscript-style density view. Derived display only; native SSP and
// widths stay in the numerical result. At most two axial panels or one FBP panel.
globalThis.SSPZShapeDisplay = (() => {
  const exponent = 0.35;
  const intensity = fraction => Math.round(255 * Math.max(0, Math.min(1, fraction)) ** exponent);
  function ticks(lo, hi, target = 6) {
    const raw = (hi - lo) / target, unit = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(v => v * unit).find(v => v >= raw - 1e-12);
    const out = [];
    for (let i = Math.ceil(lo / step - 1e-9); i <= Math.floor(hi / step + 1e-9); i++) out.push(Number((i * step).toPrecision(12)));
    return out;
  }
  function fromFdk(result) {
    const name={'axial-merged':'Merged axial','axial-rri':'RRI axial','axial-parallel':'Parallel axial',rri:'RRI'}[result.model?.kind]??'FDK';
    const displayName=name+(result.config?.zFfsEnabled?' + z-FFS':'');
    const groups = result.reference ? [['CBA', result, [1, 0, 0]], ['RRI', result.reference, [0, 0, 1]]] : [[displayName, result, [1, 0, 0]]];
    return groups.map(([name, r, rgb]) => {
      const z = r.z, count = r.profiles.length, values = new Float64Array(z.length * count);
      r.profiles.forEach((p, i) => values.set(p.profile, i * z.length));
      const a = SSPZShape.analyze({ z, zCount: z.length, stateCount: count, data: { final: values, coverage: new Float64Array(count).fill(1) } }, 'data');
      return { name, rgb, analysis: a };
    });
  }
  function draw(canvas, groups, { title = '', panel = '', span = null } = {}) {
    const ctx = canvas.getContext('2d'), scale = canvas.width / 1000, height = canvas.height / scale;
    ctx.save(); ctx.scale(scale, scale); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1000, height);
    const b = { left: 145, right: 965, top: 78 + 63 * groups.length, bottom: height - 218 };
    const domain = Math.min(...groups.map(g => Math.min(-g.analysis.x[0], g.analysis.x.at(-1))));
    const maxWidth = Math.max(...groups.flatMap(g => g.analysis.fwhm));
    const requested = span ?? (maxWidth <= 2 ? 1.5 : Math.max(4, Math.ceil(maxWidth * .8 - 1e-9)));
    span = Math.min(domain, Math.max(requested, maxWidth * .55));
    if (!(span > 0)) throw new Error('No bilateral common support for the aligned shape view.');
    const limit = Math.max(...groups.map(g => -g.analysis.low));
    const x = v => b.left + (v + span) / (2 * span) * (b.right - b.left);
    const y = v => b.bottom - (v + limit) / (2 * limit) * (b.bottom - b.top);
    const xt = ticks(-span, span, span >= 3 ? 8 : 6), yt = ticks(-limit, limit);
    // Histogram cells are discrete and are never spatially smoothed. Composite
    // channels use the same fraction mapping and add only different source hues.
    const step = groups[0].analysis.step, width = groups[0].analysis.width;
    const start = Math.ceil(Math.max(-span, ...groups.map(g => g.analysis.x[0])) / step - 1e-8);
    const stop = Math.floor(Math.min(span, ...groups.map(g => g.analysis.x.at(-1))) / step + 1e-8);
    const nx = stop - start + 1, ny = Math.round(2 * limit / width);
    const temp = document.createElement('canvas'); temp.width = nx; temp.height = ny;
    const tc = temp.getContext('2d'), im = tc.createImageData(nx, ny);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const rgb = [0, 0, 0], z = (start + i) * step, value = -limit + (j + .5) * width;
      for (const g of groups) {
        const a = g.analysis, ix = Math.round((z - a.x[0]) / step), iy = Math.floor((value - a.low) / width + 1e-8);
        if (ix < 0 || ix >= a.x.length || iy < 0 || iy >= a.bins) continue;
        const v = intensity(a.hist[ix * a.bins + iy]);
        g.rgb.forEach((c, k) => { rgb[k] += c * v; });
      }
      im.data.set([...rgb.map(v => Math.min(255, v)), 255], 4 * ((ny - 1 - j) * nx + i));
    }
    tc.putImageData(im, 0, 0);
    ctx.save(); ctx.beginPath(); ctx.rect(b.left, b.top, b.right - b.left, b.bottom - b.top); ctx.clip();
    ctx.fillStyle = '#000'; ctx.fillRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(temp, x((start - .5) * step), b.top, x((stop + .5) * step) - x((start - .5) * step), b.bottom - b.top);
    ctx.strokeStyle = 'rgba(255,255,255,.34)'; ctx.lineWidth = 1; ctx.setLineDash([4, 6]);
    // Guides follow the labeled ticks on both axes, including zero. They are
    // display overlays; histogram values and the adaptive domain are unchanged.
    ctx.beginPath();
    for (const v of xt) { ctx.moveTo(x(v), b.top); ctx.lineTo(x(v), b.bottom); }
    for (const v of yt) { ctx.moveTo(b.left, y(v)); ctx.lineTo(b.right, y(v)); }
    ctx.stroke(); ctx.restore();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 1.8; ctx.strokeRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
    ctx.font = '30px Arial'; ctx.fillStyle = '#111';
    for (const v of xt) {
      ctx.beginPath(); ctx.moveTo(x(v), b.bottom); ctx.lineTo(x(v), b.bottom + 9); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText(Math.abs(v) < 1e-9 ? '0' : String(v), x(v), b.bottom + 39);
    }
    for (const v of yt) {
      ctx.beginPath(); ctx.moveTo(b.left - 9, y(v)); ctx.lineTo(b.left, y(v)); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText(Math.abs(v) < 1e-9 ? '0' : v.toFixed(2), b.left - 16, y(v) + 10);
    }
    ctx.font = '34px Arial'; ctx.textAlign = 'center'; ctx.fillText('z position (mm)', (b.left + b.right) / 2, b.bottom + 83);
    ctx.save(); ctx.translate(39, (b.top + b.bottom) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('SSPz − mean', 0, 0); ctx.restore();
    ctx.font = 'bold 32px Arial'; ctx.textAlign = 'left'; ctx.fillText(panel, 18, 36);
    ctx.font = '30px Arial'; ctx.textAlign = 'center'; ctx.fillText(title, (b.left + b.right) / 2, 39);
    groups.forEach((g, i) => {
      const w = g.analysis.fwhm, mean = w.reduce((s, v) => s + v, 0) / w.length;
      const sd = w.length > 1 ? Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / (w.length - 1)) : null;
      const color = g.rgb.every(v => v === 1) ? '#444' : `rgb(${g.rgb.map(v => Math.round(v * 180)).join(',')})`, yy = 106 + 63 * i;
      ctx.fillStyle = color; ctx.font = '28px Arial'; ctx.textAlign = 'center';
      const stats = sd === null ? `${mean.toFixed(2)} mm` : sd < .001 ? `${mean.toFixed(2)} mm; SD < 0.001 mm` : `${mean.toFixed(2)} ± ${sd.toFixed(3)} mm`;
      ctx.fillText(`${g.name}: FWHM ${stats}`, (b.left + b.right) / 2, yy - 17);
      ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x(-mean / 2), yy); ctx.lineTo(x(mean / 2), yy);
      for (const [v, d] of [[-mean / 2, 1], [mean / 2, -1]]) { ctx.moveTo(x(v) + d * 10, yy - 5); ctx.lineTo(x(v), yy); ctx.lineTo(x(v) + d * 10, yy + 5); }
      ctx.stroke();
      // Short ticks above the plot align the arrow ends with the z axis without
      // drawing vertical lines through (or anchoring) the observed distribution.
      ctx.lineWidth = 1.2;
      for (const v of [-mean / 2, mean / 2]) { ctx.beginPath(); ctx.moveTo(x(v), b.top - 7); ctx.lineTo(x(v), b.top); ctx.stroke(); }
      const gap = 75, bw = ((b.right - b.left) - gap * (groups.length - 1)) / groups.length;
      const bx = b.left + i * (bw + gap), by = height - 82;
      ctx.font = '28px Arial'; ctx.fillStyle = '#111'; ctx.fillText(g.name, bx + bw / 2, by - 13);
      const lut = document.createElement('canvas'); lut.width = 256; lut.height = 1;
      const lc = lut.getContext('2d'), pixels = lc.createImageData(256, 1);
      for (let k = 0; k < 256; k++) pixels.data.set([...g.rgb.map(c => c * intensity(k / 255)), 255], 4 * k);
      lc.putImageData(pixels, 0, 0); ctx.imageSmoothingEnabled = false; ctx.drawImage(lut, bx, by, bw, 19);
      ctx.strokeStyle = '#111'; ctx.lineWidth = 1; ctx.strokeRect(bx, by, bw, 19);
      ctx.font = '24px Arial'; ctx.fillStyle = '#111';
      for (const v of [0, 25, 50, 75, 100]) ctx.fillText(String(v), bx + bw * v / 100, by + 46);
    });
    ctx.fillStyle = '#111'; ctx.font = '26px Arial'; ctx.fillText('Fraction per bin (%)', (b.left + b.right) / 2, height - 12);
    ctx.restore();
    canvas.dataset.intensityExponent = String(exponent);
    canvas.dataset.alignment = 'native-fwhm-midpoint-translation-only';
    canvas.dataset.xTicks = JSON.stringify(xt); canvas.dataset.yTicks = JSON.stringify(yt);
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${title}. ${groups.map(g => `${g.name}: ${g.analysis.valid.length} profiles`).join('; ')}. SSPz minus each group mean, native FWHM midpoints aligned to zero. Arrows show mean individual FWHM. Fraction per bin intensity power ${exponent}.`);
  }
  return { draw, fromFdk, intensity, ticks, exponent };
})();

// Optional acquired-point view. A/B are physical alternating exposures.
const ZFFS_COLORS=['#0072b2','#d55e00'];
let zffsSceneCache=null;
function readZffsParams(){return {zFfsEnabled:!!document.getElementById('zffs-enabled')?.checked,zFfsMagnification:Number(document.getElementById('zffs-magnification')?.value??1072/600),zFfsOffset:Number(document.getElementById('zffs-offset')?.value??.25)};}
function initializeZffsUi(initial,changed){
  const box=document.createElement('div');box.id='zffs-controls';box.className='zffs-controls';
  box.innerHTML=`<label class="zffs-switch"><input type="checkbox" id="zffs-enabled">${fdkText('z方向の焦点移動による倍密度サンプリング（z-FFS）','Use z-flying focal spot sampling (z-FFS)')}</label>
  <p id="zffs-unavailable" hidden>${fdkText('焦点移動は、ピッチが正のコーン幾何モデルで使用できます。','Focal switching requires cone geometry and positive pitch.')}</p>
  <div id="zffs-options" hidden><p>${fdkText('焦点A・Bを交互に切り替え、候補点・補間重み・SSPzを計算します。取得ビュー数はA+Bの合計です。初期設定では回転中心の列間隔を半分にします。','Alternate focal positions A and B for candidate geometry, interpolation weights and SSPz. The view count is the total A+B acquisitions. The default interlaces rows at half spacing at isocentre.')}</p>
  <details class="reading-details"><summary>${fdkText('焦点移動の幾何条件','Focal-switching geometry')}</summary><div class="parameter-grid">
  <label>${fdkText('線源–検出器間距離 / 線源–回転中心間距離','Source–detector / source–isocentre distance')}<input id="zffs-magnification" type="number" min="1.01" max="4" step="any" value="${1072/600}"></label>
  <label>${fdkText('回転中心での片側移動量 / 列間隔','One-sided isocentre offset / row pitch')}<input id="zffs-offset" type="number" min="0" max="0.5" step="0.01" value="0.25"></label></div>
  <p>${fdkText('固定した円筒検出器に対し、焦点を体軸方向だけに移動する理想モデルです。実機の設定値ではありません。回転中心から離れると、列間隔は一様に半分にはなりません。','An ideal model of pure axial focal motion relative to a fixed cylindrical detector, not scanner settings. Away from isocentre, the interlaced spacing is not uniformly halved.')}</p>
  <a href="ZFFS_METHOD.md">${fdkText('計算方法と検証範囲','Method and verification scope')}</a> · <a href="https://doi.org/10.1118/1.2828403">Mori (2008)</a></details></div>`;
  document.getElementById('fdk-controls').prepend(box);
  const ref=document.createElement('li');ref.innerHTML=`<div class="reference-citation">Mori I. <a href="https://doi.org/10.1118/1.2828403" target="_blank" rel="noopener noreferrer">Antialiasing backprojection for helical MDCT.</a> <i>Medical Physics.</i> 2008;35:1065–1077.</div><p>${fdkText('図4・式（19）～（22）の焦点移動と標本配置を参照しました。純粋な体軸方向移動を仮定した追加モデルです。同報のシフト逆投影や実機のアーチファクト低減は再現していません。','Fig. 4 and Eqs. (19)–(22) motivate focal switching and sampling geometry. This extension assumes pure axial motion; it does not reproduce shifted backprojection or scanner artifact reduction.')}</p>`;document.querySelector('.reference-list').append(ref);
  document.getElementById('zffs-enabled').checked=initial.zFfsEnabled===true;
  document.getElementById('zffs-magnification').value=initial.zFfsMagnification??1072/600;
  document.getElementById('zffs-offset').value=initial.zFfsOffset??.25;
  const block=document.createElement('div');block.id='zffs-diagrams';block.hidden=true;
  block.innerHTML=`<h3>${fdkText('焦点A・Bの取得点と選択重み','Focal positions A/B: acquired points and selected weights')}</h3>
  <p id="zffs-result-note"></p><div class="zffs-view-controls"><label>${fdkText('表示角度の開始 (°)','Display angle start (°)')}<input id="zffs-angle" type="range" min="0" max="300" step="1" value="0"><output id="zffs-angle-value">0°</output></label>
  <label>${fdkText('表示角度幅','Angular span')}<select id="zffs-span"><option value="60">60°</option><option value="10">10°</option><option value="360">360°</option></select></label></div>
  <div class="chart-grid two">${[0,1,2,3].map(i=>`<article class="chart-card"><div class="zffs-canvas-scroll" tabindex="0"><canvas id="zffs-panel-${i}" width="1000" height="850"></canvas></div></article>`).join('')}</div>
  <p>${fdkText('全パネルは同じ軸・縮尺です。○：焦点A、△：焦点B。各点は実際に取得する角度の検出器列中心です。右下の濃さは、対象位置で幅Tにわたり合計した取得データの重みです。','All panels share axes and scale. Circle: focus A; triangle: focus B. Points are detector-row centres at actual acquired angles. Bottom-right intensity shows acquired-data weights summed over T at the object location.')}</p>
  <div class="action-row"><button type="button" class="secondary" id="zffs-png" disabled>${fdkText('4パネルを600 dpi PNG保存','Save four panels as 600-dpi PNG')}</button><button type="button" class="secondary" id="zffs-csv" disabled>${fdkText('取得点・重みをCSV保存','Export acquired points and weights as CSV')}</button></div>
  <details class="reading-details"><summary>${fdkText('表示範囲内の選択データ（先頭100点）','Selected data in this viewport (first 100 points)')}</summary><div class="zffs-table-scroll"><table><thead><tr><th>Focus</th><th>View</th><th>Row</th><th>β (°)</th><th>z (mm)</th><th>Weight</th></tr></thead><tbody id="zffs-weight-table"></tbody></table></div></details>`;
  document.getElementById('fdk-geometry-step').append(block);
  for(const id of ['zffs-enabled','zffs-magnification','zffs-offset'])document.getElementById(id).addEventListener('change',()=>{changed();syncZffsUi();});
  for(const id of ['zffs-angle','zffs-span'])document.getElementById(id).addEventListener('input',()=>{zffsSceneCache=null;renderZffsSelected();});
  document.getElementById('zffs-csv').onclick=()=>{if(!fdkSelectedResult?.config.zFfsEnabled)return;downloadBlob(fdkFileStem(fdkResult)+'_angle-'+selectedStateIndex+'_zFFS_acquired_weights.csv','\uFEFF'+zffsWeightRows(fdkSelectedResult).map(r=>r.join(',')).join('\r\n'));};
  document.getElementById('zffs-png').onclick=exportZffsPanels;
  resetButton.addEventListener('click',()=>{document.getElementById('zffs-enabled').checked=false;document.getElementById('zffs-magnification').value=1072/600;document.getElementById('zffs-offset').value=.25;syncZffsUi();});
  syncZffsUi();
}
function syncZffsUi(){
  const e=document.getElementById('zffs-enabled');if(!e)return;
  const available=document.getElementById('computationModel').value!=='parallel'&&Number(form.elements.namedItem('beamPitch').value)>0;
  if(!available)e.checked=false;e.disabled=runButton.disabled||!available;
  document.getElementById('zffs-unavailable').hidden=available;
  document.getElementById('zffs-options').hidden=!e.checked;
  document.getElementById('zffs-diagrams').hidden=!e.checked;
  document.getElementById('fdk-geometry').closest('article').hidden=e.checked;
  document.getElementById('fdk-weight-step').hidden=e.checked;
  for(const id of ['zffs-png','zffs-csv'])document.getElementById(id).disabled=!fdkSelectedResult?.config.zFfsEnabled;
}
function zffsWeightRows(r){return [['focus','view_unwrapped','row_index_zero_based','channel_index_zero_based','source_angle_rad','source_z_mm','row_center_relative_mm','interpolation_weight','angular_mean_factor','acquired_point_value','response_contribution'],...r.weightAudit.samples.map(q=>[q.focus?'B':'A',q.view,q.row,q.channel,q.beta,q.sourceZ,q.z,q.weight,r.weightAudit.db,q.acquiredValue,q.weight*r.weightAudit.db*q.acquiredValue])];}
function zffsScene(r){
  const span=Number(document.getElementById('zffs-span').value),slider=document.getElementById('zffs-angle');slider.max=360-span;slider.disabled=span===360;
  const start=Math.min(Number(slider.value),360-span);slider.value=start;document.getElementById('zffs-angle-value').value=start+'°';
  const key=start+':'+span;if(zffsSceneCache?.r===r&&zffsSceneCache.key===key)return zffsSceneCache;
  const c=r.config,nv=c.viewSamples,base=Math.ceil(((2*Math.PI*r.zObject/c.feed)-Math.PI)/(2*Math.PI/nv)-1e-12);
  const limit=symmetricNiceAxis(Math.max(c.rowWidth,c.axialAverageMm/2+2*c.rowWidth*(1+c.radius/c.sourceRadius)+c.zFfsSourceOffsetMm),3).xMax;
  const angle=v=>((v-base)%nv+nv)%nv*360/nv;
  const axialReach=(c.rows-1)/2*c.rowWidth*(1+c.radius/c.sourceRadius)+c.zFfsSourceOffsetMm;
  const first=Math.floor((r.zObject-limit-axialReach)/c.feed*nv),last=Math.ceil((r.zObject+limit+axialReach)/c.feed*nv),points=[];
  for(let v=first;v<=last;v++){
    const a=angle(v);if(a<start-1e-9||a>start+span+1e-9)continue;
    const q=zffsRowGeometry(c,v,0),lo=Math.max(0,Math.ceil((-limit+r.zObject-q.z)/q.spacing)),hi=Math.min(c.rows-1,Math.floor((limit+r.zObject-q.z)/q.spacing));
    for(let row=lo;row<=hi;row++)points.push({view:v,row,focus:q.focus,z:q.z+row*q.spacing-r.zObject,angle:a,weight:0});
  }
  const weights=new Map();for(const q of r.weightAudit.samples){const k=q.view+':'+q.row;if(!weights.has(k))weights.set(k,{...q,angle:angle(q.view),weight:0});weights.get(k).weight+=q.weight*r.weightAudit.db;}
  const selected=[...weights.values()].filter(q=>q.angle>=start-1e-9&&q.angle<=start+span+1e-9&&Math.abs(q.z)<=limit).sort((a,b)=>a.angle-b.angle||a.z-b.z);
  const maxWeight=Math.max(0,...selected.map(q=>q.weight));
  return zffsSceneCache={r,key,start,span,limit,points,selected,maxWeight};
}
function drawZffsPanel(canvas,r,kind){
  canvas.dataset.renderScale=String(canvas.width/1000);
  const s=zffsScene(r),titles=[fdkText('焦点Aの取得点','Acquired points: focus A'),fdkText('焦点Bの取得点','Acquired points: focus B'),fdkText('焦点A+Bの重ね合わせ','Overlay: focus A+B'),fdkText('選択されたデータの重み','Selected acquired-data weights')];
  const plot=axisContext(canvas,{xMin:-s.limit,xMax:s.limit,yMin:s.start+s.span,yMax:s.start},{x:'',y:'β − βref (°)',topMargin:85,leftMargin:130,rightMargin:35,bottomMargin:170,xFormatter:v=>Number(v.toFixed(2)).toString(),yFormatter:v=>Number(v.toFixed(1)).toString()});
  const xs=SSPZShapeDisplay.ticks(-s.limit,s.limit),ys=Array.from({length:7},(_,i)=>s.start+i*s.span/6);drawAxes(plot,xs,ys);
  const {ctx,x,y,margin:m,innerWidth:w,innerHeight:h}=plot;
  ctx.save();ctx.fillStyle=INK;ctx.font=`700 27px ${FIGURE_FONT}`;ctx.textAlign='left';ctx.fillText('('+String.fromCharCode(97+kind)+')',18,32);ctx.textAlign='center';ctx.font=`27px ${FIGURE_FONT}`;ctx.fillText(titles[kind],m.left+w/2,43);
  ctx.beginPath();ctx.rect(m.left,m.top,w,h);ctx.clip();ctx.strokeStyle='#b41630';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x(0),m.top);ctx.lineTo(x(0),m.top+h);ctx.stroke();
  const marker=(q,weighted)=>{ctx.globalAlpha=weighted?.15+.85*q.weight/(s.maxWeight||1):.65;ctx.fillStyle=ZFFS_COLORS[q.focus];ctx.beginPath();const px=x(q.z),py=y(q.angle),sz=weighted?5:2.8;if(q.focus){ctx.moveTo(px,py-sz);ctx.lineTo(px-sz,py+sz);ctx.lineTo(px+sz,py+sz);ctx.closePath();}else ctx.arc(px,py,sz,0,2*Math.PI);ctx.fill();};
  if(kind<3){for(const q of s.points)if(kind===2||q.focus===kind)marker(q,false);}
  else {for(const q of s.selected)marker(q,true);}
  ctx.restore();ctx.save();ctx.textAlign='center';ctx.fillStyle=INK;ctx.font=`31px ${FIGURE_FONT}`;ctx.fillText('zᵢ − z₀ (mm)',m.left+w/2,m.top+h+80);ctx.font=`23px ${FIGURE_FONT}`;ctx.textAlign='left';ctx.fillStyle=ZFFS_COLORS[0];ctx.fillText('○  '+fdkText('焦点A','Focus A'),m.left,m.top+h+118);ctx.fillStyle=ZFFS_COLORS[1];ctx.fillText('△  '+fdkText('焦点B','Focus B'),m.left+230,m.top+h+118);
  if(kind===3){ctx.fillStyle=INK;ctx.font=`19px ${FIGURE_FONT}`;ctx.fillText(fdkText('濃さ：重み 0 ～ ','Intensity: weight 0 – ')+s.maxWeight.toPrecision(3),m.left,m.top+h+149);}ctx.restore();
  canvas.dataset.renderState='ready';canvas.dataset.zffsFocus=String(kind);canvas.dataset.xRange=String(s.limit);canvas.dataset.angleRange=s.key;
}
function renderZffsSelected(){
  syncZffsUi();const r=fdkSelectedResult;if(!r?.config.zFfsEnabled)return;
  for(let i=0;i<4;i++)drawZffsPanel(document.getElementById('zffs-panel-'+i),r,i);
  const c=r.config;document.getElementById('zffs-result-note').textContent=`${c.viewSamples} views/turn (A: ${c.viewSamples/2}, B: ${c.viewSamples/2}) / `+fdkText('焦点移動','Source offset')+` ±${c.zFfsSourceOffsetMm.toFixed(3)} mm / `+fdkText('回転中心の片側ずれ','One-sided isocentre offset')+` ${c.zFfsOffset} `+fdkText('列分。選択した開始角度のSSPzと同じ取得データです。','row pitches. These data also determine the SSPz at the selected start angle.');
  const s=zffsScene(r);document.getElementById('zffs-weight-table').innerHTML=s.selected.slice(0,100).map(q=>`<tr><td>${q.focus?'B':'A'}</td><td>${q.view}</td><td>${q.row+1}</td><td>${q.angle.toFixed(1)}</td><td>${q.z.toFixed(3)}</td><td>${q.weight.toPrecision(4)}</td></tr>`).join('');
}
async function exportZffsPanels(){
  const r=fdkSelectedResult;if(!r?.config.zFfsEnabled)return;
  const c=document.createElement('canvas');c.width=Math.round(180/25.4*600);c.height=Math.round(c.width*.85);const ctx=c.getContext('2d');
  for(let i=0;i<4;i++){const tile=document.createElement('canvas');tile.width=Math.round(c.width/2);tile.height=Math.round(tile.width*.85);drawZffsPanel(tile,r,i);ctx.drawImage(tile,(i%2)*tile.width,Math.floor(i/2)*tile.height);}
  const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob(fdkFileStem(fdkResult)+'_angle-'+selectedStateIndex+'_zFFS_4panels_600dpi.png',await pngWithResolution(blob,600),'image/png');
}

// One reconstruction result supplies the diagram, weights, selected SSP and
// phase-ordered widths. Rendering never substitutes axial-model coefficients.
let fdkSelectedResult=null,fdkRunParams=null,fdkInspectionRequest=0,fdkInspectionTimer=null;
const fdkAngleTicks=[0,60,120,180,240,300,360];
function initializeFdkWorkflow(panel){
  const block=(id,title)=>{const e=document.createElement('div');e.id=id;e.className='workflow-block';e.innerHTML=`<h2>${title}</h2>`;return e;};
  const geometry=block('fdk-geometry-step',fdkText('2　展開図と補間の重み','2  Unwrapped geometry and interpolation weights'));
  geometry.insertAdjacentHTML('beforeend',`<div class="state-inspector"><label for="fdk-inspect">${fdkText('表示する回転開始角度','Start angle to inspect')} <span id="fdk-inspect-label"></span></label><div class="state-controls"><button type="button" id="fdk-prev" disabled>−1°</button><input type="range" id="fdk-inspect" min="0" max="359" step="1" value="0" disabled><button type="button" id="fdk-next" disabled>+1°</button></div><p id="fdk-inspection-status" aria-live="polite"></p></div>`);
  document.getElementById('fdk-geometry').width=900;document.getElementById('fdk-geometry').height=960;
  const firstCard=document.getElementById('fdk-geometry').closest('article');geometry.append(firstCard);
  firstCard.querySelector('h3').textContent=fdkText('2A　補間候補の配置：0～360°展開図','2A  Candidate arrangement: 0–360° unwrapped diagram');
  const weights=block('fdk-weight-step',fdkText('2B　選択されたデータと重み','2B  Selected data and weights'));
  weights.insertAdjacentHTML('beforeend',`<p>${fdkText('同じ開始角度・同じ対象位置の重みです。応答の体軸方向平均化を指定した場合は、その幅全体の重みを合計します。','Weights refer to the same start angle and target location. If axial response averaging is enabled, coefficients are summed across that window.')}</p><div class="chart-grid two"><article class="chart-card"><h3 id="fdk-primary-weight-title">RRI</h3><canvas id="fdk-weights-primary" width="900" height="960"></canvas></article><article class="chart-card" id="fdk-rri-weights-card"><h3>RRI</h3><canvas id="fdk-weights-rri" width="900" height="960"></canvas></article></div><p id="fdk-weight-scope"></p>`);
  const profile=block('fdk-profile-step',fdkText('3　選択角度のSSPzと全360条件','3  Selected SSPz and all 360 conditions'));
  profile.insertAdjacentHTML('beforeend',`<article class="chart-card"><h3>${fdkText('選択角度：半値の交点とFWHM','Selected angle: half-maximum crossings and FWHM')}</h3><canvas id="fdk-selected-profile" width="1200" height="800"></canvas></article>`);
  const overlay=document.getElementById('fdk-profile').closest('article');profile.append(overlay);overlay.querySelector('h3').textContent=fdkText('全360条件の重ね合わせ','Overlay of all 360 conditions');
  profile.insertAdjacentHTML('beforeend',`<article class="chart-card"><h3>${fdkText('全360条件：裾の拡大表示','All 360 conditions: tail detail')}</h3><canvas id="fdk-tail" width="1200" height="700"></canvas></article>`);
  const widths=block('fdk-width-step',fdkText('4　開始角度による幅の変動','4  Width variation with start angle'));
  widths.insertAdjacentHTML('beforeend',`<label>${fdkText('表示する幅','Width metric')}<select id="fdk-width-metric"><option value="fwhm">FWHM</option><option value="fwtm">FWTM</option></select></label><article class="chart-card"><canvas id="fdk-sweep" width="1200" height="700"></canvas></article><p>${fdkText('横軸は設定した基準開始角度からの差です。グラフのクリックでも角度を選べます。','The horizontal axis is the offset from the configured base start angle. Click the graph to select an angle.')}</p>`);
  const shape=block('fdk-shape-step',fdkText('5　SSPzの形状変動','5  SSPz shape variation'));
  widths.insertAdjacentHTML('beforeend',`<button type="button" class="secondary" id="fdk-width-csv" disabled>${fdkText('全360角度の幅をCSV保存','Export widths for all 360 angles as CSV')}</button>`);
  shape.append(document.getElementById('fdk-difference-wrap'),document.getElementById('fdk-shape-wrap'));
  const images=document.createElement('details');images.className='reading-details';images.hidden=true;images.innerHTML=`<summary>${fdkText('選択角度の再構成画像','Reconstructed images at the selected angle')}</summary><div class="chart-grid two"></div>`;
  images.lastElementChild.append(document.getElementById('fdk-axial').closest('article'),document.getElementById('fdk-coronal').closest('article'));
  const oldGrid=panel.querySelector('.chart-grid.two');oldGrid.replaceWith(geometry,weights,profile,widths,shape,images);
  // The old first-angle-only audit is superseded by the linked window audit.
  document.getElementById('cba-samples-wrap').hidden=true;
  document.getElementById('cba-samples-wrap').style.display='none';
  document.getElementById('fdk-inspect').oninput=e=>selectFdkState(Number(e.target.value));
  document.getElementById('fdk-prev').onclick=()=>selectFdkState(selectedStateIndex-1,true);
  document.getElementById('fdk-next').onclick=()=>selectFdkState(selectedStateIndex+1,true);
  document.getElementById('fdk-width-metric').value=['fwhm','fwtm'].includes(metricSelect.value)?metricSelect.value:'fwhm';
  document.getElementById('fdk-width-metric').onchange=e=>{metricSelect.value=e.target.value;if(fdkResult){drawFdkSweep(document.getElementById('fdk-sweep'));const url=paramsToUrl(fdkRunParams);try{history.replaceState(null,'',url);}catch{}syncLanguageLinks(url.search);}};
  document.getElementById('fdk-width-csv').onclick=()=>{if(!fdkResult)return;const rows=[['method','start_index','start_angle_rad','FWHM_mm','FWTM_mm','configured_thickness_mm','axial_average_mm'],...fdkGroups(fdkResult).flatMap(([name,g])=>g.profiles.map((p,i)=>[name,i,p.phase,p.fwhm.width,p.fwtm.width,fdkResult.config.sliceThicknessMm,fdkResult.config.axialAverageMm]))];downloadBlob(fdkFileStem(fdkResult)+'_360_angles_widths.csv','\uFEFF'+rows.map(r=>r.join(',')).join('\r\n'));};
  document.getElementById('fdk-sweep').onclick=e=>{if(!fdkResult)return;const box=e.currentTarget.getBoundingClientRect(),x=(e.clientX-box.left)/box.width;selectFdkState(Math.max(0,Math.min(359,Math.round((x-.13)/.835*360))),true);};
  for(const id of ['fdk-geometry','fdk-weights-primary','fdk-weights-rri','fdk-selected-profile','fdk-tail','fdk-sweep','fdk-difference']){
    const b=document.createElement('button');b.type='button';b.className='secondary';b.dataset.fdkCanvas=id;b.disabled=true;b.textContent=fdkText('600 dpi PNG保存','Save 600-dpi PNG');b.onclick=()=>exportFdkWorkflowCanvas(id);document.getElementById(id).after(b);
  }
}
function fdkWorkflowAvailability(on){
  for(const id of ['fdk-inspect','fdk-prev','fdk-next','fdk-width-metric','fdk-width-csv'])document.getElementById(id).disabled=!on;
  document.querySelectorAll('[data-fdk-canvas]').forEach(b=>b.disabled=!on||!fdkSelectedResult);
}
function selectFdkState(index,immediate=false){
  if(!fdkResult)return;
  selectedStateIndex=((Math.round(index)%360)+360)%360;fdkInspectionRequest++;clearTimeout(fdkInspectionTimer);fdkSelectedResult=null;
  document.getElementById('fdk-inspect').value=selectedStateIndex;
  const angle=fdkResult.profiles[selectedStateIndex].phase*180/Math.PI;
  document.getElementById('fdk-inspect-label').textContent=`+${selectedStateIndex}° / ${fdkText('開始角度','start angle')} ${angle.toFixed(1)}°`;
  document.getElementById('fdk-inspection-status').textContent=fdkText('選択角度の展開図・重み・応答を更新中…','Updating geometry, weights and response for the selected angle…');
  for(const id of ['fdk-geometry','fdk-weights-primary','fdk-weights-rri','fdk-axial','fdk-coronal'])drawCanvasStatus(document.getElementById(id),'',fdkText('選択角度を計算中','Computing selected angle'));
  drawFdkSelectedProfile(document.getElementById('fdk-selected-profile'));drawFdkSweep(document.getElementById('fdk-sweep'));drawFdkTail(document.getElementById('fdk-tail'));fdkDrawProfile(document.getElementById('fdk-profile'),fdkResult);
  syncZffsUi();for(const cv of document.querySelectorAll('#zffs-diagrams canvas'))drawCanvasStatus(cv,'z-FFS',fdkText('選択角度を計算中','Computing selected angle'));
  fdkWorkflowAvailability(true);document.getElementById('fdk-json').disabled=true;document.getElementById('fdk-xlsx').disabled=true;
  const url=paramsToUrl(fdkRunParams);try{history.replaceState(null,'',url);}catch{}syncLanguageLinks(url.search);
  const requestId=fdkInspectionRequest;
  const send=()=>worker?.postMessage({type:'fdk-inspect',index:selectedStateIndex,requestId});
  if(immediate)send();else fdkInspectionTimer=setTimeout(send,180);
}
function renderFdkSelected(){
  const r=fdkSelectedResult;if(!r)return;
  document.getElementById('fdk-primary-weight-title').textContent=fdkMethodName(r);
  document.querySelector('#fdk-rri-weights-card h3').textContent=fdkText('RRI：列間の線形補間','RRI: linear row interpolation');
  drawFdkCandidateDiagram(document.getElementById('fdk-geometry'),r,false);
  drawFdkCandidateDiagram(document.getElementById('fdk-weights-primary'),r,true,false);
  document.getElementById('fdk-rri-weights-card').hidden=!r.reference;
  document.getElementById('fdk-rri-weights-card').parentElement.classList.toggle('two',!!r.reference);
  if(r.reference)drawFdkCandidateDiagram(document.getElementById('fdk-weights-rri'),r,true,true);
  // Reduced response has no image volume.
  document.getElementById('fdk-weight-scope').textContent=fdkText('対象点の位置で、幅Tにわたり合算した補間重みです。フィルタ前の取得応答と掛け合わせて、同じ位置の応答を再計算できます。角度は0～360°に折り返しますが、異なる回転のデータは別の点として保持しています。','Weights sum over T at the object point. Combined with unfiltered acquired responses, they reproduce that response sample. Angles are folded into 0–360°, while samples from different turns retain separate identities.');
  document.getElementById('fdk-inspection-status').textContent=fdkText('展開図・重み・モデルSSPzは、選択した同じ開始角度に対応しています。','Geometry, weights and model SSPz now refer to the same selected start angle.');
  document.getElementById('fdk-summary').textContent=fdkText('全360条件の計算が完了しました。角度を選んで、候補データからSSPzまで確認できます。','All 360 conditions are complete. Select an angle to inspect the candidates, weights and SSPz.');
  const c=fdkResult.config;document.getElementById('fdk-result-config').textContent=`${c.rows} rows × ${c.rowWidth.toFixed(2)} mm / pitch ${c.beamPitch} / r = ${c.radius} mm / ${c.viewSamples} views/turn / 360 start angles / T = axial averaging width = ${(c.axialAverageMm??0).toFixed(2)} mm`;
  renderZffsSelected();
  fdkWorkflowAvailability(true);document.getElementById('fdk-json').disabled=false;document.getElementById('fdk-xlsx').disabled=false;
}
// Adapt the actual reconstruction audit to the established diagram renderer.
// Only the scene data differ; palette, opacity, marker size and layout are shared.
function drawFdkCandidateDiagram(canvas,r,zoom,reference=false){
  if(r.config.zFfsEnabled)return drawZffsPanel(canvas,r,zoom?3:2);
  const c=r.config,audit=r.weightAudit,step=2*Math.PI/c.viewSamples;
  if(!audit)return;
  const samples=audit.samples,base=Math.ceil(((c.feed?2*Math.PI*r.zObject/c.feed:0)-Math.PI)/step-1e-12);
  const first=Math.min(base,...samples.map(q=>q.view)),last=Math.max(base+c.viewSamples,...samples.map(q=>q.view));
  const rebinned=r.coordinateSystem==='rebinned-theta'||!!r.reference;
  const physical=!zoom&&!rebinned;
  const rowMin=rebinned||physical?0:Math.min(...samples.map(q=>q.row))-2;
  const rowMax=rebinned||physical?c.rows-1:Math.max(...samples.map(q=>q.row))+2;
  const rows=rowMax-rowMin+1,angles=[],axial=[],scales=[];
  const fold=v=>((v-base)%c.viewSamples+c.viewSamples)%c.viewSamples*360/c.viewSamples;
  const geometryAt=v=>{
    const angle=c.phase+v*step;
    if(c.axialRule==='parallel')return [c.feed*v/c.viewSamples,1];
    if(rebinned){
      const t=-c.radius*Math.sin(angle),gamma=Math.asin(t/c.sourceRadius);
      return [c.feed*(angle+gamma-c.phase)/(2*Math.PI),(Math.sqrt(c.sourceRadius**2-t*t)-c.radius*Math.cos(angle))/c.sourceRadius];
    }
    return [c.feed*v/c.viewSamples,physical?Math.hypot(c.sourceRadius*Math.cos(angle)-c.radius,c.sourceRadius*Math.sin(angle))/c.sourceRadius:(c.sourceRadius-c.radius*Math.cos(angle))/c.sourceRadius];
  };
  const rowOffsets=Array.from({length:rows},(_,i)=>(rebinned||physical?i-(c.rows-1)/2:rowMin+i+c.vOffset)*c.rowWidth);
  // Preserve the established axis range, which follows the selected audit.
  let extent=0;
  for(let v=first;v<=last;v++){
    const [z,scale]=geometryAt(v);
    for(const row of [0,rows-1])extent=Math.max(extent,Math.abs(z+scale*rowOffsets[row]-r.zObject));
  }
  const zoomLimit=Math.max(c.rowWidth,Math.ceil(Math.max(...samples.map(q=>Math.abs(q.z)))*10)/10)*1.12;
  // Background curves describe geometry, not the support of selected weights.
  // Draw complete turns and clip them at the axes; never join folded endpoints.
  let minCentral=Infinity,maxCentral=-Infinity;
  for(let i=0;i<=c.viewSamples;i++){
    const [z,scale]=geometryAt(base+i);
    angles.push(i*360/c.viewSamples);axial.push(z);scales.push(scale);
    for(const row of [0,rows-1]){
      const delta=z+scale*rowOffsets[row]-r.zObject;
      minCentral=Math.min(minCentral,delta);maxCentral=Math.max(maxCentral,delta);
    }
  }
  const xLimit=symmetricNiceAxis(zoom?zoomLimit:extent,3).xMax;
  const turnMin=c.feed?Math.ceil((-xLimit-maxCentral)/c.feed):0;
  const turnMax=c.feed?Math.floor((xLimit-minCentral)/c.feed):0;
  const turns=Array.from({length:turnMax-turnMin+1},(_,i)=>turnMin+i);
  const stride=Math.max(1,Math.ceil(c.viewSamples/72));
  const trace={id:'acquired',family:'direct',angles,axial,scales};
  const diagram={totalRows:rows,z0:r.zObject,overviewXLimit:extent,zoomXLimit:zoomLimit,
    interpolationBandHalfWidth:(c.axialAverageMm??0)/2,
    traceGeometry:{...trace,rowOffsets,feed:c.feed,turns},traceFamilies:[trace],
    weightedPoints:zoom?samples.filter(q=>((q.view-base)%stride+stride)%stride===0).map(q=>({
      x:q.z,y:fold(q.view),row:q.row-rowMin,weight:reference?q.referenceWeight:q.weight,
      referenceViewIndex:q.view,absoluteViewIndex:q.view,traceFamilyId:'acquired',dataKind:'unfiltered-data'
    })):[],
    referenceViewSamples:c.viewSamples,renderedAngleSamples:Math.ceil(c.viewSamples/stride),acquiredTraceSamples:angles.length,
    xAxisLabel:fdkText('候補列中心  zᵢ − z₀  (mm)','Candidate row centre  zᵢ − z₀  (mm)'),
    yAxisLabel:rebinned?fdkText('再配列後の角度差  θ  (°)','Rebinned angle offset  θ  (°)'):fdkText('線源角度差  β  (°)','Source angle offset  β  (°)'),
    directLegendLabel:rebinned?fdkText('再配列データ ○','Rebinned data ○'):fdkText('取得データ ○','Acquired data ○'),
    overviewLegendLabel:fdkText('全{rows}列の幾何軌跡','Geometric trajectories: all {rows} rows').replace('{rows}',c.rows),
    weightLegendLabel:fdkText('合計重み w','Total weight w'),
    angleCoordinate:rebinned?'rebinned theta; relative to centre turn':'source beta; relative to centre turn'
  };
  if(!zoom)diagram.directLegendLabel=rebinned?fdkText('再配列後の列軌跡','Rebinned row trajectories'):fdkText('検出器列の軌跡','Detector-row trajectories');
  if(!rebinned&&zoom){
    diagram.rowLegendLabel=fdkText('仮想平面列','Virtual row');
    diagram.rowLabels=Array.from({length:rows},(_,i)=>rowMin+i);
    diagram.directLegendLabel=fdkText('仮想平面データ ○','Flat-grid data ○');
    diagram.weightLegendNote=fdkText('仮想平面上の行補間重み。軌道の重なりは混色。','Flat-grid row weights; trace overlaps blend.');
  }
  canvas.dataset.renderScale=String(canvas.width/900);
  drawDiagram(canvas,diagram,zoom?'zoom':'overview');
  for(const key of Object.keys(canvas.dataset))if(canvas.dataset[key]==='undefined')delete canvas.dataset[key];
  canvas.dataset.renderState='ready';
  canvas.dataset.complementaryMarkerShape='not-applicable-in-own-angle-coordinate';
  canvas.dataset.complementaryLineStyle='not-applicable-in-own-angle-coordinate';
  canvas.dataset.startIndex=selectedStateIndex;canvas.dataset.auditSamples=samples.length;
  canvas.dataset.markerEncoding='fixed-radius;row-colour;weight-fill';
  canvas.dataset.familyEncoding='each sample at its own acquired angle; no direct-reference folding';
  canvas.dataset.backgroundTraceScope='geometric-context-independent-of-selected-weight-support';
  canvas.dataset.backgroundTurns=turns.join(',');
}
function fdkArrow(a,fw,level,color){const {ctx,s}=a,yy=a.y(level);ctx.strokeStyle=color;ctx.lineWidth=2*s;ctx.setLineDash([5*s,5*s]);for(const v of [fw.left,fw.right]){ctx.beginPath();ctx.moveTo(a.x(v),a.b.bottom);ctx.lineTo(a.x(v),yy);ctx.stroke();}ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(a.x(fw.left),yy);ctx.lineTo(a.x(fw.right),yy);for(const [v,d] of [[fw.left,1],[fw.right,-1]]){ctx.moveTo(a.x(v)+d*9*s,yy-6*s);ctx.lineTo(a.x(v),yy);ctx.lineTo(a.x(v)+d*9*s,yy+6*s);}ctx.stroke();}
function drawFdkSelectedProfile(canvas){
  const r=fdkResult,groups=fdkGroups(r),low=Math.min(0,...groups.map(([,g])=>Math.min(...g.profiles[selectedStateIndex].profile)));
  const a=fdkAxes(canvas,r.z[0],r.z.at(-1),Math.floor(low*10)/10,1.02,'z position (mm)','Normalized SSPz','(d)',low<0?[Math.floor(low*10)/10,0,.2,.4,.6,.8,1]:[0,.2,.4,.6,.8,1],120);
  groups.forEach(([name,g],i)=>{const p=g.profiles[selectedStateIndex],color=i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR;fdkDrawLines(a,g.z,[p.profile],color);fdkArrow(a,p.fwhm,.5,color);a.ctx.fillStyle=color;a.ctx.textAlign='center';a.ctx.font=`${23*a.s}px Arial`;a.ctx.fillText(`${name} / +${selectedStateIndex}°: FWHM ${p.fwhm.width.toFixed(2)} mm; FWTM ${p.fwtm.width.toFixed(2)} mm`,(a.b.left+a.b.right)/2,(50+i*35)*a.s);});canvas.dataset.startIndex=selectedStateIndex;
}
function drawFdkTail(canvas){
  const r=fdkResult,a=fdkAxes(canvas,r.z[0],r.z.at(-1),PROFILE_TAIL_DISPLAY_BOUNDS.yMin,PROFILE_TAIL_DISPLAY_BOUNDS.yMax,'z position (mm)','Normalized SSPz','(f)',[-3,-2,-1,0],110,null,v=>10**v);
  const {ctx,b}=a;ctx.save();ctx.beginPath();ctx.rect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.clip();
  for(const [i,[,g]] of fdkGroups(r).entries()){
    ctx.strokeStyle=i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR;ctx.globalAlpha=.13;ctx.lineWidth=1.1;
    for(const p of g.profiles)strokeNativeProfile(ctx,r.z,p.profile,a.x,a.y,{tailView:true});
  }
  ctx.restore();drawFdkProfileLegend(a,r);
  canvas.dataset.profileOpacity='0.13';canvas.dataset.profileLineWidth='1.1';canvas.dataset.yScale='log10';canvas.dataset.tailFloor='0.001';
}
function drawFdkSweep(canvas){
  const r=fdkResult,key=document.getElementById('fdk-width-metric').value,values=fdkGroups(r).flatMap(([,g])=>g.profiles.map(p=>p[key].width)),lo=Math.min(...values),hi=Math.max(...values),pad=Math.max(.01,(hi-lo)*.1),a=fdkAxes(canvas,0,360,Math.max(0,Math.floor((lo-pad)*100)/100),Math.ceil((hi+pad)*100)/100,'Start-angle offset (°)',`${key.toUpperCase()} (mm)`,'(g)',null,95,fdkAngleTicks);
  for(const [i,[name,g]] of fdkGroups(r).entries()){const color=i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR,ys=g.profiles.map(p=>p[key].width);fdkDrawLines(a,ys.map((_,j)=>j),[ys],color);a.ctx.fillStyle=color;a.ctx.textAlign='center';a.ctx.fillText(`${name}: ${Math.min(...ys).toFixed(2)}–${Math.max(...ys).toFixed(2)} mm`,a.b.left+(i?.73:.27)*(a.b.right-a.b.left),53*a.s);a.ctx.beginPath();a.ctx.arc(a.x(selectedStateIndex),a.y(ys[selectedStateIndex]),5*a.s,0,2*Math.PI);a.ctx.fill();}
  a.ctx.strokeStyle='#555';a.ctx.setLineDash([5*a.s,5*a.s]);a.ctx.beginPath();a.ctx.moveTo(a.x(selectedStateIndex),a.b.top);a.ctx.lineTo(a.x(selectedStateIndex),a.b.bottom);a.ctx.stroke();a.ctx.setLineDash([]);canvas.dataset.startIndex=selectedStateIndex;
}
function addFdkWorkflowSheets(sheets){
  sheets[0][1]=sheets[0][1].filter(([key])=>!['volume_storage','sample_weights_scope'].includes(key));
  sheets[0][1].push(['selected_start_index',selectedStateIndex],['start_angle_sweep','base phase + 0..359 degrees; object z fixed'],['volume_storage','No image volume; JSON stores selected-angle response and weights'],['thickness_definition','Configured thickness T is the rectangular averaging width; FWHM is measured from the resulting SSPz, not prescribed'],['first_angle_weights','Sample_weights contains the unaveraged centre snapshot at index 0; Selected_weights includes the response-average window at the inspected angle']);
  const r=fdkSelectedResult;if(!r?.weightAudit)return;
  if(r.config.zFfsEnabled){sheets.push(['zFFS_acquired_weights',zffsWeightRows(r)]);sheets.push(['zFFS_rebinned_weights',[['view_index','focus','row_index','theta_rad','beta_rad','z_relative_mm','weight','rebinned_value'],...r.rebinnedWeightAudit.map(q=>[q.view,q.focus?'B':'A',q.row,q.theta,q.beta,q.z,q.weight,q.acquiredValue])]]);}
  sheets[0][1].push(['selected_weight_scope',r.weightAudit.definition]);
  sheets.push(['Selected_weights',[['start_index','view_unwrapped','row_index','theta_rad','source_angle_rad','z_relative_mm',r.model?.kind==='rri'?'RRI_weight':'weight',...(r.reference?['reference_weight']:[]),'angular_mean_factor','unfiltered_acquired_value'],...r.weightAudit.samples.map(q=>[selectedStateIndex,q.view,q.row,q.theta,q.beta,q.z,q.weight,...(r.reference?[q.referenceWeight]:[]),r.weightAudit.db,q.acquiredValue])]]);
}
async function exportFdkWorkflowCanvas(id){
  if(!fdkSelectedResult)return;const source=document.getElementById(id),c=document.createElement('canvas'),diagram=id==='fdk-geometry'||id.startsWith('fdk-weights');c.width=Math.round((diagram?80:180)/25.4*600);c.height=Math.round(c.width*source.height/source.width);
  if(id==='fdk-geometry')drawFdkCandidateDiagram(c,fdkSelectedResult,false);
  else if(id.startsWith('fdk-weights'))drawFdkCandidateDiagram(c,fdkSelectedResult,true,id.endsWith('rri'));
  else if(id==='fdk-selected-profile')drawFdkSelectedProfile(c);
  else if(id==='fdk-tail')drawFdkTail(c);
  else if(id==='fdk-sweep')drawFdkSweep(c);
  else drawFdkDifference(c,fdkResult);
  const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob(`${fdkFileStem(fdkResult)}_${id}_angle-${selectedStateIndex}_600dpi.png`,await pngWithResolution(blob,600),'image/png');
}

// Integrated UI for the browser worker, using the existing shared form,
// geometry conventions, XLSX writer and PNG resolution metadata.
const FDK_UI_FIELDS={method:'rri',edgePolicy:'available',axialAverageMm:0,objectModel:'point',
  xyExtent:1.5,xySamples:17,zExtent:3,zStep:.05,phaseCount:360,phase:0,state:0,normalization:'minmax'};
let fdkResult=null;
let fdkShapeGroups=null;
const fdkMethodName=r=>({'axial-merged':'Merged axial','axial-rri':'RRI axial','axial-parallel':'Parallel axial'}[r.model?.kind]??'Legacy FBP')+(r.config?.zFfsEnabled?' + z-FFS':'');
const fdkGroups=r=>r.reference?[['CBA',r],['RRI',r.reference]]:[[fdkMethodName(r),r]];
const fdkSheetPrefix=name=>name.includes('z-FFS')?name.replace(' + z-FFS','_FFS').replace(' axial',''):name;
const fdkFileStem=r=>(r.reference?'Hsieh_CBA_RRI':fdkMethodName(r))+'_point_T'+(r.config.sliceThicknessMm??r.config.axialAverageMm)+'mm';
function fdkWidthStats(r){const v=r.profiles.map(p=>p.fwhm.width),mean=v.reduce((s,x)=>s+x,0)/v.length;return {mean,sd:v.length>1?Math.sqrt(v.reduce((s,x)=>s+(x-mean)**2,0)/(v.length-1)):null,min:Math.min(...v),max:Math.max(...v)};}
const fdkWidthAnnotation=(mean,sd)=>sd===null?`${mean.toFixed(2)} mm`:sd<.001?`${mean.toFixed(2)} mm; SD < 0.001 mm`:`${mean.toFixed(2)} ± ${sd.toFixed(3)} mm`;
function fdkProfileRows(r){const groups=fdkGroups(r);return [['z_position_mm',...groups.flatMap(([name,g])=>g.profiles.flatMap((_,i)=>[name+'_raw_'+i,name+'_normalized_'+i]))],...Array.from(r.z,(z,i)=>[z,...groups.flatMap(([,g])=>g.profiles.flatMap(p=>[p.raw[i],p.profile[i]]))])];}
const fdkText=(ja,en)=>document.documentElement.lang.startsWith('en')?en:ja;
function syncFdkMethodControls(){syncZffsUi();const method=document.getElementById('fdk-method');if(!method)return;for(const key of ['edgePolicy'])document.getElementById('fdk-'+key).disabled=runButton.disabled||method.value!=='rri';}
function readFdkParams(){
  const out={computationModel:document.querySelector('#computationModel')?.value??'axial'};
  for(const [k,v] of Object.entries(FDK_UI_FIELDS)){
    const e=document.getElementById('fdk-'+k);out[k]=e?(typeof v==='number'?Number(e.value):e.value):v;
  }
  out.axialAverageMm=Number(form.elements.namedItem('sliceThicknessMm').value);
  out.axialRule=out.computationModel==='fdk'?'rri':out.computationModel==='parallel'?'parallel':'merged';
  const d=Number(form.elements.namedItem('rowWidth').value),r=Number(form.elements.namedItem('radius').value),R=Number(form.elements.namedItem('sourceRadius').value);
  out.zExtent=Math.max(1,out.axialAverageMm+2*d*(1+r/R));
  out.state=0;out.method='rri';
  out.objectModel='point';
  out.thicknessMapping='configured-rectangular';
  out.phaseCount=360;
  Object.assign(out,readZffsParams());
  if(out.zFfsEnabled)out.zExtent+=2*out.zFfsOffset*d/(1-1/out.zFfsMagnification);
  return out;
}
function writeFdkUrl(url,p){
  url.searchParams.set('model',p.computationModel==='fdk'?'rri':p.computationModel??'axial');
  url.searchParams.set('response','axial-interpolation');
  for(const k of ['zffs','zffs_m','zffs_a'])url.searchParams.delete(k);
  if(p.zFfsEnabled){url.searchParams.set('zffs','1');url.searchParams.set('zffs_m',p.zFfsMagnification);url.searchParams.set('zffs_a',p.zFfsOffset);}
  for(const key of ['nf','pm','rp','nz',...Object.keys(FDK_UI_FIELDS).map(k=>'fdk_'+k)])url.searchParams.delete(key);
  for(const k of ['edgePolicy','zStep','phase','normalization'])url.searchParams.set('fdk_'+k,p[k]??FDK_UI_FIELDS[k]);
}
function fdkParamsFromUrl(q){
  const out={computationModel:q.get('model')==='rri'?'fdk':['fdk','parallel'].includes(q.get('model'))?q.get('model'):'axial',legacyResponse:!!q.get('v')&&Number(q.get('v'))<11};
  for(const [k,v] of Object.entries(FDK_UI_FIELDS))out[k]=q.has('fdk_'+k)?(typeof v==='number'?Number(q.get('fdk_'+k)):q.get('fdk_'+k)):v;
  out.zFfsEnabled=q.get('zffs')==='1';out.zFfsMagnification=Number(q.get('zffs_m')??1072/600);out.zFfsOffset=Number(q.get('zffs_a')??.25);
  out.phaseCount=360;
  out.legacyCbaComparison=out.method==='hsieh';
  if(out.legacyCbaComparison)out.method='rri';
  out.legacySphereInput=q.get('fdk_objectModel')!=='point';
  out.objectModel='point';
  return out;
}
function initializeFdkUi(initial){
  initial={...initial,method:'rri'};
  const pick=document.createElement('label');pick.innerHTML=fdkText('体軸補間モデル','Axial interpolation model')+`<select id="computationModel" name="computationModel"><option value="axial">${fdkText('コーン幾何：候補を統合して2点補間','Cone geometry: merged bracketing pair')}</option><option value="fdk">${fdkText('コーン幾何：RRI相当の列間補間','Cone geometry: RRI-equivalent row interpolation')}</option><option value="parallel">${fdkText('比較基準：発散なし・2点補間','Reference: nondivergent, merged pair')}</option></select>`;
  form.prepend(pick);pick.querySelector('select').value=initial.computationModel??'axial';
  const controls=document.createElement('div');controls.id='fdk-controls';controls.className='fdk-controls';
  controls.innerHTML=`<p class="section-summary">${fdkText('共通の点対象・検出器開口から、候補の選択と体軸補間によるモデルSSPzを求めます。横断画像は再構成しません。','Model SSPz is the axial interpolation response of a shared point object and detector aperture. No transverse image is reconstructed.')}</p>
  <details class="reading-details"><summary>${fdkText('補間規則と共通の計算設定','Interpolation rules and shared numerical settings')}</summary>
  <p>${fdkText('候補統合では、実・対向方向の列データ全体から評価位置を挟む2点を選びます。RRI（row-to-row interpolation）は各方向の隣接列を線形補間し、対向ペアで重みを正規化します。どちらも同じ取得データと角度集合を用います。発散なしの基準は、別の幾何仮定です。','Merged interpolation selects the nearest bracketing pair from both directions. Row-to-row interpolation (RRI) interpolates adjacent rows within each direction and normalizes across the pair. Both cone models use the same acquired data and angles. The nondivergent reference uses a separate geometry assumption.')}</p>
  <div class="parameter-grid">
  <input type="hidden" id="fdk-method" value="rri"><input type="hidden" id="fdk-objectModel" value="point"><input type="hidden" id="fdk-axialAverageMm" value="1"><input type="hidden" id="fdk-xyExtent" value="0.5"><input type="hidden" id="fdk-xySamples" value="5"><input type="hidden" id="fdk-zExtent" value="3"><input type="hidden" id="fdk-state" value="0"><input type="hidden" id="fdk-phaseCount" value="360">
  <label>${fdkText('体軸方向の計算間隔 (mm)','Axial calculation spacing (mm)')}<input id="fdk-zStep" type="number" min="0.01" max="0.2" step="0.01" value="0.05"></label>
  <label>${fdkText('基準開始角度 (rad)','Base start angle (rad)')}<input id="fdk-phase" type="number" min="0" max="6.28318530718" step="0.01" value="0"></label>
  <label>${fdkText('検出器端の扱い','Detector-edge policy')}<select id="fdk-edgePolicy"><option value="available">${fdkText('取得済みの列を使用','Use acquired rows')}</option><option value="strict">${fdkText('両方向の隣接列を要求','Require both complete brackets')}</option></select></label>
  <label>${fdkText('正規化','Normalization')}<select id="fdk-normalization"><option value="minmax">${fdkText('最小値0・最大値1','Minimum 0, maximum 1')}</option><option value="peak">${fdkText('最大値1','Peak 1')}</option></select></label>
  </div><p>${fdkText('対象の位置を固定し、開始角度を1°間隔で360条件計算します。設定厚Tは体軸方向の矩形平均幅です。計算範囲はTと検出器列幅から裾を含むように決めます。','The object stays fixed while all 360 start angles are evaluated at 1-degree increments. T is the rectangular axial averaging width. The profile domain follows T and detector-row width to include the tails.')}</p>
  <p><a href="AXIAL_RESPONSE_METHOD.md">${fdkText('計算式と適用範囲','Equations and scope')}</a> · <a href="https://doi.org/10.1117/1.2746866">Hsieh et al. (2007)</a></p></details>`;
  form.append(controls);
  if(initial.legacyResponse){const note=document.createElement('p');note.className='model-note';note.id='axial-response-migration';note.textContent=fdkText('旧版の条件を読み込みました。現在は共通の体軸補間応答モデルで計算するため、従来のFBP・体軸モデルの保存結果とは数値が異なります。','Older settings loaded. The current shared axial interpolation model produces different values from previous FBP and axial results.');controls.prepend(note);}
  document.getElementById('fdk-method').setAttribute('aria-describedby','fdk-controls');
  document.getElementById('fdk-method').addEventListener('change',syncFdkMethodControls);
  for(const [k,v] of Object.entries(FDK_UI_FIELDS))document.getElementById('fdk-'+k).value=initial[k]??v;
  document.getElementById('fdk-objectModel').value='point';
  document.getElementById('fdk-phaseCount').value=360;
  syncFdkMethodControls();updateInputDecorations();
  const panel=document.createElement('section');panel.id='fdk-panel';panel.setAttribute('aria-labelledby','fdk-title');
  panel.innerHTML=`<div class="section-heading"><h2 id="fdk-title">${fdkText('展開図から体軸補間応答へ','From candidate geometry to axial response')}</h2></div>
  <p class="section-summary">${fdkText('展開図の候補と補間重みから、モデルSSPzとその変動を示します。コーン幾何の2モデルは、取得データを共通にして補間規則を比較します。','Candidate positions and interpolation weights lead to the model SSPz and its variation. The two cone models compare interpolation rules with shared acquired data.')} <a href="#fdk-controls">${fdkText('補間規則の説明','Interpolation rules')}</a></p>
  <p id="fdk-summary" aria-live="polite"></p><p id="fdk-result-config"></p><div id="cba-comparison" hidden></div>
  <div class="chart-grid two">
  <article class="chart-card"><h3>${fdkText('取得列の展開図','Acquired detector-row geometry')}</h3><canvas id="fdk-geometry" width="1000" height="700"></canvas></article>
  <article class="chart-card"><h3>${fdkText('モデルSSPz：点への応答','Model SSPz: point response')}</h3><canvas id="fdk-profile" width="1000" height="700"></canvas></article>
  <article class="chart-card"><h3>${fdkText('横断像：点の位置断面','Axial image through the object point')}</h3><canvas id="fdk-axial" width="900" height="800"></canvas></article>
  <article class="chart-card"><h3>${fdkText('冠状断像：点の位置断面','Coronal image through the object point')}</h3><canvas id="fdk-coronal" width="900" height="800"></canvas></article>
  </div><div id="fdk-difference-wrap" class="chart-card" hidden><h3>${fdkText('各SSPzと平均SSPzの差','Each SSPz minus the mean SSPz')}</h3><canvas id="fdk-difference" width="1200" height="650"></canvas><p>${fdkText('点の位置を共通の原点とし、各z位置の平均を引きます。FWHM中点での位置合わせは行いません。','The object point is the common origin; the pointwise mean is subtracted. Profiles are not aligned by their FWHM midpoints.')}</p></div>
  <div id="fdk-shape-wrap" class="chart-card shape-card" hidden>
    <h3>${fdkText('SSPzの形状変動分布','SSPz shape-variation distribution')}</h3>
    <p>${fdkText('各曲線のFWHM中点を0 mmに揃え、方法ごとの平均からの偏差を重ねます。両矢印は個々のFWHMの平均です。','Align each native FWHM midpoint to zero and overlay deviations from each method’s own mean. Double-headed arrows show the mean of individual FWHMs.')}</p>
    <div class="shape-canvas-wrap" tabindex="0"><canvas id="fdk-shape" width="1000" height="830"></canvas></div>
    <p id="fdk-shape-summary"></p>
    <button type="button" id="fdk-shape-png" class="secondary" disabled>${fdkText('分布図を600 dpi PNG保存','Save distribution as 600-dpi PNG')}</button>
    <details class="reading-details"><summary>${fdkText('分布図の読み方','Reading the distribution')}</summary><p>${fdkText('赤：選択した体軸補間モデル。0.01 mm格子への線形補間、偏差ビン幅0.002を用い、濃さは各ビンの割合の0.35乗です。位置合わせと正規化の影響を含み、幅方向の拡大縮小は行いません。表示範囲は偏差を切り捨てないよう拡張します。','Red: the selected axial interpolation model. Linear sampling uses a 0.01-mm grid and deviation bins of 0.002; intensity is fraction^0.35. Alignment and normalization affect the distribution; widths are not rescaled. The deviation range expands to retain all values.')}</p></details>
  </div>
  <div class="action-row"><button type="button" id="fdk-xlsx" class="secondary" disabled>${fdkText('SSPz・平均差をExcel保存','Export SSPz and mean differences to Excel')}</button><button type="button" id="fdk-csv" class="secondary" disabled>SSPz CSV</button><button type="button" id="fdk-json" class="secondary" disabled>${fdkText('応答・重み・条件をJSON保存','Export response, weights and conditions as JSON')}</button><button type="button" id="fdk-png" class="secondary" disabled>${fdkText('SSPzを600 dpi PNG保存','Save SSPz as 600-dpi PNG')}</button></div>
  <details class="reading-details"><summary>${fdkText('方法・解釈の範囲','Method and interpretation')}</summary><p>${fdkText('モデルSSPzは、有限検出器開口で取得した理想点応答に候補の選択・線形補間を適用し、角度方向に平均して求めます。面内のランプフィルタ、FBPの幾何重み、横断画像の再構成は含みません。3次元画像再構成後のSSPやTCOTを再現するものではありません。','Model SSPz is obtained by selecting and linearly interpolating finite-aperture point measurements and averaging over angles. It omits the transaxial ramp, FBP geometric weights and transverse image reconstruction. It is not the image SSP of 3D FBP or TCOT.')}</p><p>${fdkText('両コーンモデルの差は、共通幾何における候補選択・補間規則の差です。設定厚Tの矩形平均後に正規化し、元の計算点間の直線交点からFWHM・FWTMを求めます。FWHMをTに合わせる調整はしません。','The two cone models differ in candidate selection and interpolation under shared geometry. Normalization follows rectangular T averaging; widths use linear crossings between native samples. FWHM is not fitted to T.')}</p><p>${fdkText('80～320列も計算できますが、広角コーンビームの画像再構成精度を検証するモデルではありません。','80–320 rows are supported; this model does not evaluate the accuracy of wide-cone image reconstruction.')}</p><a href="AXIAL_RESPONSE_METHOD.md">${fdkText('計算方法と確認記録','Method and verification')}</a></details>`;
  panel.insertAdjacentHTML('beforeend',`<div id="cba-samples-wrap" class="chart-card" hidden><h3>${fdkText('補間に使うサンプルと重み：点の位置位置（画像平均化前）','Interpolation samples and weights before image averaging')}</h3><canvas id="cba-samples" width="1200" height="700"></canvas><p>${fdkText('青：RRI、赤：CBA。点の面積は正規化した重みです。横軸は点の位置からの距離。各対向ペアの補間候補を、再配列後の角度で示します。これは中心位置の局所的な重みであり、SSPz全体の寄与率ではありません。','Blue: RRI; red: CBA. Marker area represents normalized weight. The interpolation candidates in each conjugate pair are shown at the rebinned angle and relative to the object point. These are local weights at the central point, not total contributions to SSPz.')}</p></div><p><a href="AXIAL_RESPONSE_METHOD.md">${fdkText('RRI相当の線形補間：計算方法と適用範囲','RRI-equivalent interpolation: equations and scope')}</a> · <a href="https://doi.org/10.1117/1.2746866" target="_blank" rel="noopener noreferrer">Hsieh et al. (2007)</a></p>`);
  document.querySelector('.control-shell').after(panel);
  initializeFdkWorkflow(panel);
  const viewHelp=document.querySelector('#viewSamples')?.parentElement.querySelector('small');
  const axialViewHelp=viewHelp?.textContent;
  function modeChanged(){
    fdkInspectionRequest++;clearTimeout(fdkInspectionTimer);releaseWorker();if(runButton.disabled)setBusy(false);
    const on=Number(form.elements.namedItem('beamPitch').value)>0;controls.hidden=false;panel.hidden=!on;
    if(fdkResult){fdkResult=null;fdkSelectedResult=null;fdkShapeGroups=null;fdkToggleDownloads(false);for(const cv of panel.querySelectorAll('canvas'))drawCanvasStatus(cv,'Axial interpolation',fdkText('条件を変更しました。再計算してください。','Settings changed. Recalculate.'));}
    document.querySelectorAll('main > section').forEach(s=>{if(s!==panel&&!s.classList.contains('control-shell')&&!s.querySelector('#reference-title'))s.hidden=on;});
    for(const k of ['filterSamples','profileMode','reconstructionPath','zSamples'])document.getElementById(k)?.closest('label')?.toggleAttribute('hidden',on);
    const help=document.querySelector('#beamPitch')?.parentElement.querySelector('small');if(help)help.hidden=on;
    if(viewHelp)viewHelp.textContent=on?fdkText('1回転の実取得ビュー数です。周辺の点応答はビュー数の影響を受けます。720・1440・2400で結果の変化を確認できます。','Acquired views per full turn. Off-centre point responses are sensitive to view sampling; compare 720, 1440 and 2400 views.'):axialViewHelp;

    syncZffsUi();
    if(!runButton.disabled)status.textContent=fdkText('計算モデルを選択しました。条件を確認して計算してください。','Model selected. Check the conditions and calculate.');
  }
  initializeZffsUi(initial,modeChanged);
  pick.querySelector('select').addEventListener('change',modeChanged);form.elements.namedItem('beamPitch').addEventListener('change',modeChanged);modeChanged();
  resetButton.addEventListener('click',()=>{pick.querySelector('select').value='axial';for(const [k,v] of Object.entries(FDK_UI_FIELDS))document.getElementById('fdk-'+k).value=v;modeChanged();});
  document.getElementById('fdk-csv').onclick=()=>{const r=fdkResult;if(!r)return;downloadBlob(fdkFileStem(r)+'_SSPz.csv','\uFEFF'+fdkProfileRows(r).map(row=>row.join(',')).join('\r\n'));};
  document.getElementById('fdk-json').onclick=()=>{if(fdkSelectedResult)downloadBlob(fdkFileStem(fdkResult)+'_angle-'+selectedStateIndex+'_response.json',JSON.stringify({seriesConfig:fdkResult.config,selectedIndex:selectedStateIndex,result:fdkSelectedResult},(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v),'application/json');};
  document.getElementById('fdk-xlsx').onclick=async()=>{
    const r=fdkResult;if(!r)return;
    const sheets=[['Readme',[['Item','Value'],['version',r.model.version],...Object.entries(r.model),...Object.entries(r.config).filter(([key])=>!['sphereDiameter','apertureSamples'].includes(key)),['detector_spacing','channelWidth is detector-center spacing; channelApertureMm is physical active width; both at isocenter, distinct from image pixels'],['coordinate','z relative to object point (mm); no FWHM alignment'],['readout','fixed transverse object location; one point sample per z; no disk ROI average'],['raw_profile','unfiltered axial interpolation response of shared ideal-point data, after T averaging'],['normalization_baseline',r.baseline],['width_definition','each normalized native profile; linear threshold crossings'],['volume_storage','No image volume; selected-angle response and weight trace'],['precision','Unrounded Float64 values; display precision is not measurement accuracy']]],
      ['SSPz',fdkProfileRows(r)],
      ...fdkGroups(r).map(([name,g])=>[fdkSheetPrefix(name)+'_Mean_difference',[['z_position_mm','mean_normalized',...g.profiles.map((_,i)=>'difference_'+i)],...Array.from(g.z,(z,i)=>[z,g.mean[i],...g.meanDifference.map(p=>p[i])])]]),
      ['Widths',[['method','start_angle_rad','FWHM_mm','FWTM_mm','normalization_baseline'],...fdkGroups(r).flatMap(([name,g])=>g.profiles.map(p=>[name,p.phase,p.fwhm.width,p.fwtm.width,p.baseline]))]]];
    if(r.reference){sheets[0][1].push(['CBA','Conjugate backprojection algorithm: jointly weighted conjugate detector-row samples'],['RRI','Row-to-row interpolation: linear interpolation between adjacent detector rows; matched reference with shared edge extension'],['comparison','CBA and RRI share acquired projections, rebinning, filter, image grid and fixed-point readout; CBA power 2, RRI power 1'],['sample_weights_scope','first angle; object point voxel; local row interpolation only']);sheets.push(['Sample_weights',[['pair_angle_deg','source_angle_rad','conjugate_source_angle_rad','sample','z_relative_mm','CBA_weight','RRI_weight','CBA_weighted_distance_mm','RRI_weighted_distance_mm'],...r.sampleAudit.flatMap(v=>v.z.map((z,i)=>[v.relativeAngleDeg,v.beta,v.betaConjugate,i,z,v.weights[i],v.rriWeights[i],v.weightedDistance,v.rriWeightedDistance]))]]);}
    if(r.model.kind.startsWith('axial-')){
      sheets[0][1].push(['RRI','Row-to-row interpolation; linear weights with an explicit acquired-row edge extension']);
      sheets.push(['Sample_weights',[['pair_angle_deg','source_angle_rad','conjugate_source_angle_rad','sample','z_relative_mm','interpolation_weight',...(r.config.zFfsEnabled?['focus']:[])],...r.sampleAudit.flatMap(v=>v.z.map((z,i)=>[v.relativeAngleDeg,v.beta,v.betaConjugate,i,z,v.weights[i],...(r.config.zFfsEnabled?[v.focus[i]?'B':'A']:[])]))]]);
    }
    if(fdkShapeGroups){
      sheets[0][1].push(['shape_distribution','Each native FWHM midpoint translated to zero; no width rescaling; 0.01-mm linear common grid; each method own mean subtracted; bin width 0.002; intensity fraction^0.35'],['shape_arrow','Mean of individual native FWHMs; values and SD retain full precision in Widths']);
      for(const g of fdkShapeGroups){const a=g.analysis;
        sheets.push([fdkSheetPrefix(g.name)+'_Shape_aligned',[['z_position_mm','mean',...a.valid.map(i=>'aligned_'+i)],...Array.from(a.x,(z,i)=>[z,a.mean[i],...a.aligned.map(p=>p[i])])]]);
        sheets.push([fdkSheetPrefix(g.name)+'_Shape_deviation',[['z_position_mm',...a.valid.map(i=>'deviation_'+i)],...Array.from(a.x,(z,i)=>[z,...a.delta.map(p=>p[i])])]]);
      }
    }
    addFdkWorkflowSheets(sheets);
    downloadBlob(fdkFileStem(r)+'_SSPz.xlsx',await SSPZShape.fromSheets(sheets),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  document.getElementById('fdk-shape-png').onclick=async()=>{if(!fdkShapeGroups)return;const c=document.createElement('canvas');c.width=Math.round(180/25.4*600);c.height=Math.round(c.width*.83);drawFdkShape(c);const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob(fdkFileStem(fdkResult)+'_shape_distribution_600dpi.png',await pngWithResolution(blob,600),'image/png');};
  document.getElementById('fdk-png').onclick=async()=>{if(!fdkResult)return;const c=document.createElement('canvas');c.width=Math.round(180/25.4*600);c.height=Math.round(c.width*.7);fdkDrawProfile(c,fdkResult);const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob(fdkFileStem(fdkResult)+'_SSPz_600dpi.png',await pngWithResolution(blob,600),'image/png');};
}
function fdkToggleDownloads(on){syncZffsUi();for(const id of ['fdk-xlsx','fdk-csv','fdk-json','fdk-png','fdk-shape-png'])document.getElementById(id).disabled=!on||(id==='fdk-shape-png'&&!fdkShapeGroups);fdkWorkflowAvailability(on);}
function runFdkSimulation(){
  const params={...readParams(),...readFdkParams()};
  for(const id of ['fdk-profile-step','fdk-width-step','fdk-shape-step'])document.getElementById(id).hidden=false;
  fdkRunParams=params;
  releaseWorker();clearError();lastResult=null;fdkResult=null;fdkSelectedResult=null;fdkInspectionRequest++;clearTimeout(fdkInspectionTimer);fdkShapeGroups=null;fdkToggleDownloads(false);setBusy(true);
  document.getElementById('fdk-summary').textContent=fdkText('体軸補間応答を計算中…','Computing axial response…');document.getElementById('fdk-result-config').textContent='';
  for(const canvas of document.querySelectorAll('#fdk-panel canvas'))drawCanvasStatus(canvas,'Axial interpolation',fdkText('計算中','Calculating'));
  document.getElementById('fdk-shape-wrap').hidden=true;document.getElementById('fdk-shape-summary').textContent='';
  document.getElementById('fdk-difference-wrap').hidden=true;document.getElementById('cba-samples-wrap').hidden=true;document.getElementById('cba-comparison').hidden=true;
  startedAt=performance.now();progress.value=0;
  const url=paramsToUrl(params);try{history.replaceState(null,'',url);localStorage.setItem('sspz-unwrapped-params',JSON.stringify(params));}catch{}
  syncLanguageLinks(url.search);worker=createComputationWorker();
  const fail=text=>{setBusy(false);fdkToggleDownloads(false);showError(text);status.textContent=fdkText('計算を完了できませんでした','Calculation could not be completed');document.getElementById('fdk-summary').textContent=text;for(const c of document.querySelectorAll('#fdk-panel canvas'))drawCanvasStatus(c,'Axial interpolation',fdkText('有効な応答なし','No valid response'),'error');releaseWorker();};
  worker.onmessage=({data:m})=>{
    if(m.type==='progress'){progress.value=m.value;status.textContent=m.label;}
    else if(m.type==='fdk-result'){
      if(m.result.geometryOnly){
        fdkResult=m.result;fdkSelectedResult=m.result;selectedStateIndex=0;progress.value=1;setBusy(false);fdkToggleDownloads(false);
        for(const id of ['fdk-profile-step','fdk-width-step','fdk-shape-step'])document.getElementById(id).hidden=true;
        document.getElementById('fdk-rri-weights-card').hidden=true;
        document.getElementById('fdk-primary-weight-title').textContent=fdkMethodName(m.result);
        drawFdkCandidateDiagram(document.getElementById('fdk-geometry'),m.result,false);
        drawFdkCandidateDiagram(document.getElementById('fdk-weights-primary'),m.result,true);
        document.querySelectorAll('[data-fdk-canvas="fdk-geometry"],[data-fdk-canvas="fdk-weights-primary"]').forEach(b=>b.disabled=false);
        status.textContent=fdkText('取得応答がないため、展開図のみ表示します。','No acquired point response; geometry only.');
        document.getElementById('fdk-summary').textContent=fdkText('点対象の信号を取得できません。検出器開口・隙間・標本間隔を確認してください。候補配置と重みは表示できますが、SSPz・幅指標は算出できません。','The point signal is not acquired. Check detector aperture, gaps and sampling. Candidate geometry and weights remain available; SSPz and widths are undefined.');
        renderZffsSelected();releaseWorker();return;
      }
      fdkResult=m.result;renderFdkResult(fdkResult);progress.value=1;setBusy(false);fdkToggleDownloads(true);status.textContent=fdkText('完了 ','Completed ')+((performance.now()-startedAt)/1000).toFixed(1)+' s / 360 angles';selectFdkState(selectedStateIndex,true);
    }else if(m.type==='fdk-inspection'){if(m.requestId===fdkInspectionRequest){fdkSelectedResult=m.result;renderFdkSelected();}}
    else if(m.type==='fdk-inspection-error'){if(m.requestId===fdkInspectionRequest){document.getElementById('fdk-inspection-status').textContent=m.message;}}
    else if(m.type==='cancelled'){setBusy(false);document.getElementById('fdk-summary').textContent=fdkText('計算を中止しました','Calculation cancelled');status.textContent=document.getElementById('fdk-summary').textContent;for(const c of document.querySelectorAll('#fdk-panel canvas'))drawCanvasStatus(c,'Axial interpolation',status.textContent,'cancelled');releaseWorker();}
    else if(m.type==='error'){
      let text=m.message;
      if(text.startsWith('FDK_COVERAGE'))text=fdkText('この条件では、点の投影または局所画像に必要な連続360°のデータが検出器範囲から外れます。ピッチまたは再構成範囲を小さくしてください。展開図・体軸方向モデルは引き続き選択できます。',text);
      if(text.startsWith('FDK_DOMAIN')||text.startsWith('CBA_DOMAIN'))text=fdkText('幅を求める交点が計算範囲内にありません。SSPzの計算範囲を広げてください。',text);
      if(text.startsWith('CBA_COVERAGE'))text=fdkText('RRIに必要な投影または対向する列のサンプルが、検出器範囲から外れます。ピッチまたは再構成範囲を小さくしてください。',text);
      if(text.startsWith('AXIAL_DOMAIN'))text=fdkText('取得応答がないか、裾が計算範囲を超えています。開口・標本間隔・計算範囲を確認してください。',text);
      if(text.startsWith('ZFFS_GEOMETRY'))text=fdkText('焦点移動の幾何条件を確認してください。距離比は1より大きく、検出器は評価点の外側にある必要があります。片側移動量は0～0.5列分です。',text);
      if(text.startsWith('AXIAL_COVERAGE'))text=fdkText('この条件では、選択規則に必要な取得列が不足しています。ピッチまたは検出器端の設定を確認してください。',text);
      if(text.startsWith('CBA_VIEWS')||text.startsWith('AXIAL_VIEWS'))text=fdkText('RRIでは、1回転の取得ビュー数を偶数にしてください。',text);
      fail(text);
    }
  };worker.onerror=e=>fail(e.message);worker.postMessage({type:'fdk-run',params});
}
// Reuse the original figure axes and native-sample stroke implementation.
const FDK_PRIMARY_COLOR='#ff0000',FDK_REFERENCE_COLOR='#0000ff';
function fdkAxes(canvas,xmin,xmax,ymin,ymax,xlabel,ylabel,panel,yTicks=null,top=72,xTicks=null,yFormatter=null){
  canvas.dataset.renderScale=String(canvas.width/1000);
  const label=v=>Math.abs(v)<1e-10?'0':Math.abs(v)>=100?v.toFixed(0):Number(v.toFixed(2)).toString();
  const plot=axisContext(canvas,{xMin:xmin,xMax:xmax,yMin:ymin,yMax:ymax},{x:xlabel,y:ylabel,xFormatter:label,yFormatter:yFormatter??label,topMargin:top,leftMargin:130,rightMargin:35,bottomMargin:105});
  drawAxes(plot,xTicks??SSPZShapeDisplay.ticks(xmin,xmax),yTicks??SSPZShapeDisplay.ticks(Math.min(ymin,ymax),Math.max(ymin,ymax)));
  plot.ctx.save();plot.ctx.font=`700 25px ${FIGURE_FONT}`;plot.ctx.fillStyle=INK;plot.ctx.textAlign='left';plot.ctx.textBaseline='alphabetic';plot.ctx.fillText(panel,18,30);plot.ctx.restore();
  const b={left:plot.margin.left,right:plot.margin.left+plot.innerWidth,top:plot.margin.top,bottom:plot.margin.top+plot.innerHeight};
  canvas.dataset.axisStyle='original-shared-axisContext-drawAxes';
  canvas.dataset.renderState='ready';
  return {ctx:plot.ctx,s:1,b,x:plot.x,y:plot.y};
}
function fdkDrawLines(a,xs,series,color=FDK_PRIMARY_COLOR){
  const {ctx,b,x,y}=a;ctx.save();ctx.beginPath();ctx.rect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.clip();
  ctx.strokeStyle=color;ctx.globalAlpha=series.length>1?.13:1;ctx.lineWidth=series.length>1?1.1:4;
  for(const values of series)strokeNativeProfile(ctx,xs,values,x,y);
  ctx.restore();
}
function drawFdkProfileLegend(a,r){
  a.ctx.save();a.ctx.textAlign='center';a.ctx.textBaseline='alphabetic';a.ctx.font=`24px ${FIGURE_FONT}`;
  fdkGroups(r).forEach(([name,g],i)=>{const q=fdkWidthStats(g);a.ctx.fillStyle=i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR;a.ctx.fillText(`${name}: FWHM ${fdkWidthAnnotation(q.mean,q.sd)}`,(a.b.left+a.b.right)/2,48+i*35);});
  a.ctx.restore();
}
function fdkDrawProfile(canvas,r){
  const ymin=Math.min(0,...fdkGroups(r).flatMap(([,g])=>g.profiles.map(p=>Math.min(...p.profile)))),low=ymin<0?Math.floor(ymin*10)/10:0;
  const a=fdkAxes(canvas,r.z[0],r.z.at(-1),low,1.04,'z position (mm)','Normalized SSPz','(e)',low<0?[low,0,.2,.4,.6,.8,1]:[0,.2,.4,.6,.8,1],110,null,v=>v.toFixed(1));
  for(const [i,[,g]] of fdkGroups(r).entries())fdkDrawLines(a,r.z,g.profiles.map(p=>p.profile),i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR);
  a.ctx.save();a.ctx.strokeStyle=MUTED;a.ctx.lineWidth=1;a.ctx.setLineDash([5,4]);
  for(const level of [.5,.1]){a.ctx.beginPath();a.ctx.moveTo(a.b.left,a.y(level));a.ctx.lineTo(a.b.right,a.y(level));a.ctx.stroke();}a.ctx.restore();
  drawFdkProfileLegend(a,r);
  const fw=r.profiles[Math.min(selectedStateIndex,r.profiles.length-1)].fwhm;fdkArrow(a,fw,.5,INK);
  canvas.dataset.profileOpacity='0.13';canvas.dataset.profileLineWidth='1.1';canvas.dataset.profileInterpolation='native-sample-linear';
}
function drawFdkDifference(canvas,r){
  const limit=Math.ceil(Math.max(.02,...fdkGroups(r).flatMap(([,g])=>g.meanDifference.map(p=>Math.max(...p.map(Math.abs)))))/.02)*.02;
  const a=fdkAxes(canvas,r.z[0],r.z.at(-1),-limit,limit,'z position (mm)','SSPz minus mean','(h)');
  for(const [i,[,g]] of fdkGroups(r).entries())fdkDrawLines(a,g.z,g.meanDifference,i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR);
  a.ctx.textAlign='center';a.ctx.fillStyle=INK;a.ctx.font=`21px ${FIGURE_FONT}`;a.ctx.fillText(r.reference?'CBA (red) / RRI (blue); each minus its own mean':'Each profile minus the mean SSPz',(a.b.left+a.b.right)/2,49);
  canvas.dataset.profileOpacity='0.13';canvas.dataset.yMin=String(-limit);canvas.dataset.yMax=String(limit);
}
function fdkDrawGeometry(canvas,r){
  const c=r.config,feed=c.feed,step=2*Math.PI/c.viewSamples;
  const first=r.reference?r.acquisition.firstView:Math.ceil(((feed?2*Math.PI*r.zObject/feed:0)-Math.PI)/step-1e-12),beta0=c.phase+first*step;
  const viewCount=r.reference?r.acquisition.lastViewExclusive-first-1:c.viewSamples,angleExtent=360*viewCount/c.viewSamples;
  const betas=Array.from({length:viewCount+1},(_,i)=>beta0+i*step),curves=[];let limit=0;
  for(let row=0;row<c.rows;row++){
    const values=betas.map(beta=>{const L=Math.hypot(c.sourceRadius*Math.cos(beta)-c.radius,c.sourceRadius*Math.sin(beta));return feed*(beta-c.phase)/(2*Math.PI)+(row-(c.rows-1)/2)*c.rowWidth*L/c.sourceRadius-r.zObject;});
    limit=Math.max(limit,...values.map(Math.abs));curves.push(values);
  }
  limit=Math.ceil(limit/5)*5||5;
  const a=fdkAxes(canvas,-limit,limit,angleExtent,0,'Row position relative to object (mm)','Source angle offset (°)','(a)',fdkAngleTicks);
  const {ctx,s}=a;ctx.save();ctx.beginPath();ctx.rect(a.b.left,a.b.top,a.b.right-a.b.left,a.b.bottom-a.b.top);ctx.clip();ctx.lineWidth=Math.max(.6,1.1- c.rows/800)*s;ctx.strokeStyle='#687780';ctx.globalAlpha=Math.max(.22,Math.min(.7,25/c.rows));
  for(const values of curves){ctx.beginPath();values.forEach((v,i)=>i?ctx.lineTo(a.x(v),a.y(360*i/c.viewSamples)):ctx.moveTo(a.x(v),a.y(0)));ctx.stroke();}
  ctx.globalAlpha=1;ctx.strokeStyle='#d55e00';ctx.lineWidth=2*s;ctx.setLineDash([7*s,5*s]);ctx.beginPath();ctx.moveTo(a.x(0),a.y(0));ctx.lineTo(a.x(0),a.y(angleExtent));ctx.stroke();ctx.restore();
  ctx.font=`${22*s}px Arial`;ctx.fillStyle='#000';ctx.textAlign='center';ctx.fillText(`${c.rows} rows / ${r.reference?'all acquired views used':'central-slice full turn'}`,(a.b.left+a.b.right)/2,49*s);
}
function fdkDrawImage(canvas,r,coronal){
  const n=r.config.xySamples,nz=r.z.length,m=(n-1)/2,iz=(nz-1)/2,values=[];
  const nx=n,ny=coronal?nz:n;
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++)values.push(coronal?r.volume[((nz-1-j)*n+m)*n+i]:r.volume[(iz*n+(n-1-j))*n+i]);
  const peak=r.volume.reduce((m,v)=>Math.max(m,v),0),pixel=2*r.config.xyExtent/(n-1),xmin=-r.config.xyExtent-pixel/2,xmax=-xmin;
  const ymin=coronal?r.z[0]-r.config.zStep/2:xmin,ymax=-ymin;
  const a=fdkAxes(canvas,xmin,xmax,ymin,ymax,'x relative to object (mm)',coronal?'z position (mm)':'y relative to object (mm)',coronal?'(d)':'(c)');
  const w=a.b.right-a.b.left,h=a.b.bottom-a.b.top,scale=Math.min(w/(xmax-xmin),h/(ymax-ymin));
  // Reuse the numeric frame but draw a square metric image in its own bounds.
  // Give x and y the same mm-to-pixel scale by extending the narrower axis.
  const rx=(xmax-xmin)/2,ry=(ymax-ymin)/2,cx=(a.b.left+a.b.right)/2,cy=(a.b.top+a.b.bottom)/2;
  const physical=fdkAxes(canvas,-w/(2*scale),w/(2*scale),-h/(2*scale),h/(2*scale),'x relative to object (mm)',coronal?'z position (mm)':'y relative to object (mm)',coronal?'(d)':'(c)');
  const temp=document.createElement('canvas');temp.width=nx;temp.height=ny;const tc=temp.getContext('2d'),im=tc.createImageData(nx,ny);
  values.forEach((v,i)=>{const shade=Math.round(Math.max(0,Math.min(1,v/peak))*255);im.data.set([shade,shade,shade,255],4*i);});tc.putImageData(im,0,0);physical.ctx.imageSmoothingEnabled=false;physical.ctx.drawImage(temp,cx-rx*scale,cy-ry*scale,2*rx*scale,2*ry*scale);
  physical.ctx.textAlign='center';physical.ctx.fillStyle='#000';physical.ctx.font=`${22*a.s}px Arial`;physical.ctx.fillText(`Point response: black 0 / white ${peak.toFixed(2)}`,(a.b.left+a.b.right)/2,49*a.s);
}
function drawFdkShape(canvas){SSPZShapeDisplay.draw(canvas,fdkShapeGroups,{title:`FWHM-midpoint aligned; r = ${fdkResult.config.radius} mm; n = ${fdkResult.profiles.length}`,panel:'(i)'});}
function renderFdkResult(r){
  const c=r.config;document.getElementById('fdk-summary').textContent=fdkText('全360条件の計算が完了しました。選択角度の表示を準備しています。','All 360 conditions are complete. Preparing the selected-angle view.');
  document.getElementById('fdk-result-config').textContent=`${c.rows} rows / ${c.viewSamples} views/turn / ${r.profiles.length} start angles`;
  fdkDrawProfile(document.getElementById('fdk-profile'),r);
  const comparison=document.getElementById('cba-comparison');comparison.hidden=!r.reference;document.getElementById('cba-samples-wrap').hidden=true;
  if(r.reference){comparison.innerHTML=`<table><caption>${fdkText('各SSPzから求めたFWHM','FWHM computed from individual SSPz profiles')}</caption><thead><tr><th>${fdkText('補間方法','Method')}</th><th>${fdkText('平均 (mm)','Mean (mm)')}</th><th>SD (mm)</th><th>${fdkText('範囲 (mm)','Range (mm)')}</th></tr></thead><tbody>${fdkGroups(r).map(([name,g])=>{const q=fdkWidthStats(g);return `<tr><td>${name}</td><td>${q.mean.toFixed(2)}</td><td>${q.sd===null?'—':q.sd<.001?'&lt; 0.001':q.sd.toFixed(3)}</td><td>${q.min.toFixed(2)}–${q.max.toFixed(2)}</td></tr>`;}).join('')}</tbody></table>`;cbaDrawSamples(document.getElementById('cba-samples'),r);}
  document.getElementById('fdk-shape-wrap').hidden=false;
  try {
    fdkShapeGroups=SSPZShapeDisplay.fromFdk(r);drawFdkShape(document.getElementById('fdk-shape'));
    document.getElementById('fdk-shape-summary').textContent=fdkShapeGroups.map(g=>`${g.name}: ${g.analysis.valid.length} / ${r.profiles.length}`).join(' · ')+fdkText(' 条件。濃さ：ビン内の割合。',' conditions. Intensity: fraction per bin.')+(r.profiles.length===1?fdkText('1条件では変動を評価できません。条件数を増やしてください。',' Variation cannot be assessed from one condition; increase the number of start angles.'):'');
  }catch(error){fdkShapeGroups=null;document.getElementById('fdk-shape-summary').textContent=error.message;}
  document.getElementById('fdk-difference-wrap').hidden=r.profiles.length===1;
  if(r.profiles.length>1)drawFdkDifference(document.getElementById('fdk-difference'),r);
}
function cbaDrawSamples(canvas,r){
  const audit=r.sampleAudit,limit=Math.ceil(Math.max(...audit.flatMap(q=>q.z.map(Math.abs)))*10)/10;
  const a=fdkAxes(canvas,-limit,limit,0,180,'Sample z relative to object (mm)','Rebinned angle within pair sweep (°)','(g)');
  const {ctx,s}=a;ctx.save();ctx.beginPath();ctx.rect(a.b.left,a.b.top,a.b.right-a.b.left,a.b.bottom-a.b.top);ctx.clip();
  const stride=Math.max(1,Math.ceil(audit.length/45));
  audit.forEach((q,j)=>{if(j%stride)return;for(let i=0;i<4;i++){
    const yy=a.y(q.relativeAngleDeg);ctx.strokeStyle='#0033bb';ctx.lineWidth=1.4*s;ctx.beginPath();ctx.arc(a.x(q.z[i]),yy,10*s*Math.sqrt(q.rriWeights[i]),0,2*Math.PI);ctx.stroke();
    ctx.fillStyle='rgba(209,59,50,.78)';ctx.beginPath();ctx.arc(a.x(q.z[i]),yy,10*s*Math.sqrt(q.weights[i]),0,2*Math.PI);ctx.fill();
  }});ctx.restore();ctx.textAlign='center';ctx.fillStyle='#000';ctx.font=`${22*s}px Arial`;ctx.fillText('Blue outline: RRI / red fill: CBA',(a.b.left+a.b.right)/2,49*s);
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
const PROFILE_DISPLAY_VERSION = "2026-09-08.1";
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

versionLabel.textContent = `Web build 2026-09-17.7 / shared axial response 2026-09-17.6 / optional z-FFS 2026-09-17.1`;

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
    ? "0～360°実データ側フルスキャン（比較）"
    : "180LI取得幾何（主解析）";
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
    channelWidth: Number(data.get("channelWidth")),
    channelApertureMm: Number(data.get("channelApertureMm")),
    detectorModel: "finite-channel",
    beamPitch: Number(data.get("beamPitch")),
    sourceRadius: Number(data.get("sourceRadius")),
    radius: Number(data.get("radius")),
    zReference: 0,
    state: selectedStateIndex / 360,
    sliceThicknessMm: Number(data.get("sliceThicknessMm")),
    filterWidthMm: Number(data.get("sliceThicknessMm")),
    thicknessMapping: "configured-rectangular",
    filterSamples: Number(data.get("filterSamples")),
    profileMode: String(data.get("profileMode") || DEFAULT_PARAMS.profileMode),
    reconstructionPath: String(data.get("reconstructionPath") || DEFAULT_PARAMS.reconstructionPath),
    viewSamples: Number(data.get("viewSamples")),
    zSamples: Number(data.get("zSamples")),
    stateSamples: 360,
    phase: 0,
    ...readFdkParams(),
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
  const thickness=Number(form.elements.namedItem('sliceThicknessMm').value);
  form.elements.namedItem('filterWidthMm').value=thickness;
  const average=document.getElementById('fdk-axialAverageMm');if(average)average.value=thickness;
  const radius = Number(form.elements.namedItem("radius").value);
  document.querySelectorAll("[data-radius]").forEach(button => {
    button.classList.toggle("active", Number(button.dataset.radius) === radius);
  });
  if (inspectState) inspectState.value = String(selectedStateIndex);
  if (inspectStateLabel) inspectStateLabel.textContent = `状態 ${selectedStateIndex}/359（s = ${(selectedStateIndex / 360).toFixed(3)}）`;
  if (inspectState) inspectState.setAttribute("aria-valuetext", `状態${selectedStateIndex}、相対位置${(selectedStateIndex / 360).toFixed(3)}`);
}

function paramsToUrl(params) {
  const url = new URL(window.location.href);
  url.search = "";
  const compact = {
    v: 11,
    cp: params.channelWidth,
    ca: params.channelApertureMm,
    n: params.rows,
    d: params.rowWidth,
    p: params.beamPitch,
    R: params.sourceRadius,
    r: params.radius,
    vs: selectedStateIndex,
    st: params.sliceThicknessMm,
    nf: params.filterSamples,
    pm: params.profileMode,
    rp: reconstructionPathUrlValue(params.reconstructionPath),
    wm: metricSelect?.value ?? "fwhm",
    nv: params.viewSamples,
    nz: params.zSamples,
  };
  for (const [key, value] of Object.entries(compact)) url.searchParams.set(key, value);
  writeFdkUrl(url, params);
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
  legacyInputMigrated = get("v", 0) < 9 || hasLegacyThickness || hasLegacyState || getText("pm", "") !== "taguchi-filter" || query.has("z") || query.has("nr") || query.has("nt") || query.has("stage");
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
    channelWidth: get("cp",get("fdk_channelWidth",.25)),
    channelApertureMm: get("ca",get("cp",get("fdk_channelWidth",.25))),
    detectorModel: "finite-channel",
    beamPitch: get("p", DEFAULT_PARAMS.beamPitch),
    sourceRadius: get("R", DEFAULT_PARAMS.sourceRadius),
    radius: get("r", DEFAULT_PARAMS.radius),
    zReference: 0,
    state: selectedStateIndex / 360,
    sliceThicknessMm: hasNewThickness
      ? get("st", DEFAULT_PARAMS.sliceThicknessMm)
      : get("t", DEFAULT_PARAMS.sliceThicknessMm),
    filterWidthMm: hasNewThickness ? get("st", DEFAULT_PARAMS.sliceThicknessMm) : get("t", DEFAULT_PARAMS.sliceThicknessMm),
    thicknessMapping: "configured-rectangular",
    filterSamples: get("nf", DEFAULT_PARAMS.filterSamples),
    profileMode: "taguchi-filter",
    reconstructionPath: reconstructionPathFromUrl(getText("rp", "")),
    viewSamples: query.has("nv")
      ? get("nv", DEFAULT_PARAMS.viewSamples)
      : get("nt", DEFAULT_PARAMS.viewSamples),
    zSamples: get("nz", DEFAULT_PARAMS.zSamples),
    stateSamples: 360,
    ...fdkParamsFromUrl(query),
  };
}

function setBusy(busy) {
  runButton.disabled = busy;
  cancelButton.disabled = !busy;
  form.querySelectorAll("input, select").forEach(input => input.disabled = busy);
  syncFdkMethodControls();
  const inspectDisabled = busy || !lastResult || lastResult.geometryOnly;
  if (inspectState) inspectState.disabled = inspectDisabled;
  if (inspectPrev) inspectPrev.disabled = inspectDisabled;
  if (inspectNext) inspectNext.disabled = inspectDisabled;
  document.querySelectorAll("[data-canvas]").forEach(button => {
    button.disabled = busy || !lastResult || (lastResult.geometryOnly && !button.dataset.canvas?.startsWith("diagram-"));
  });
  downloadCsvButton.disabled = busy || !lastResult || lastResult.geometryOnly;
  downloadProfileButton.disabled = busy || !lastResult || lastResult.geometryOnly;
  document.querySelector('#download-excel-button').disabled = busy || !lastResult?.shapeAnalysis;
  if (downloadComplementaryGeometryButton) {
    downloadComplementaryGeometryButton.disabled = busy || !lastResult || lastResult.geometryOnly;
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

function showCalculatingState(detail = "新しい条件で図を作成しています", force = false) {
  const now = performance.now();
  if (!force && now - lastPlaceholderPaint < 500) return;
  lastPlaceholderPaint = now;
  setResultPlaceholder("loading", "ただ今計算中…", detail);
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
  if (Number(form.elements.namedItem('beamPitch').value)>0) return runFdkSimulation();
  releaseWorker();
  clearError();
  const params = readParams();
  lastResult = null;
  setBusy(true);
  lastPlaceholderPaint = 0;
  showCalculatingState(undefined, true);
  progress.value = 0;
  status.textContent = "計算を開始しています";
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
    } else if (message.type === "geometry-result") {
      lastResult = message.result;
      const gap=lastResult.geometryReason==='detector-gap';
      const title = gap?localizedText('点対象がチャネル間の非感度領域にあります：展開図のみ表示','Point object lies in a detector gap: geometry only'):localizedText("ピッチ0：寝台移動なしの展開図", "Pitch 0: stationary-table geometry");
      const detail = gap?localizedText('回転中心の点が偶数チャネルの中央の隙間にあり、信号を取得できません。SSPz・幅指標は計算できません。','The isocenter point lies in the central gap of the even-channel grid. No signal is acquired; SSPz and widths are unavailable.'):localizedText("ヘリカルSSPz・補間重み・状態変動は計算対象外です。", "Helical SSPz, interpolation weights and state sweeps are not evaluated.");
      setResultPlaceholder("unavailable", title, detail);
      for (const selector of ["#overview-scope", "#calculation-scope", "#overlay-scope", "#profile-axis-note", "#metric-label", "#overlay-core-heading", "#overlay-core-description", "#profile-model-note"]) {
        const element = document.querySelector(selector);
        if (element) element.textContent = detail;
      }
      document.querySelector("#overview-scope").textContent = title;
      const limit = Math.max(lastResult.diagramOff.overviewXLimit, lastResult.diagramOn.overviewXLimit);
      for (const condition of ["off", "on"]) {
        const diagram = condition === "on" ? lastResult.diagramOn : lastResult.diagramOff;
        for (const mode of ["overview", "zoom"]) {
          const canvas = document.querySelector(`#diagram-${mode}-${condition}`);
          drawDiagram(canvas, diagram, mode, limit);
          canvas.dataset.renderState = "ready";
        }
      }
      progress.value = 1;
      status.textContent = title;
      setBusy(false);
      releaseWorker();
    } else if (message.type === "result") {
      lastResult = message.result;
      selectedStateIndex = Math.max(0, Math.min(359, Math.round(lastResult.params.state * 360) % 360));
      const elapsed = (performance.now() - startedAt) / 1000;
      renderAll(lastResult);
      markResultCanvasesReady();
      progress.value = 1;
      const axialSpreadMaximum = allCandidateAxialSpreadMaximum(lastResult);
      status.textContent = `完了 ${elapsed.toFixed(1)}秒 / ${reconstructionPathLabel(lastResult.params.reconstructionPath)} / 設定厚=${fmt(lastResult.params.sliceThicknessMm, 3)} mm / 候補位置の体軸方向標準偏差の最大=${fmt(axialSpreadMaximum, 3)} mm`;
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
      status.textContent = `詳細表示を状態${selectedStateIndex}/359（s=${(selectedStateIndex / 360).toFixed(3)}）へ更新しました`;
      inspectState.disabled = false;
      inspectPrev.disabled = false;
      inspectNext.disabled = false;
    } else if (message.type === "cancelled") {
      status.textContent = "計算を中止しました";
      setResultPlaceholder("cancelled", "計算を中止しました", "条件を確認し、もう一度「計算する」を押してください。");
      setBusy(false);
      releaseWorker();
    } else if (message.type === "error") {
      showError(message.message);
      status.textContent = "計算エラー";
      setResultPlaceholder("error", "図を作成できませんでした", "上のエラー内容を確認してください。");
      setBusy(false);
      releaseWorker();
    }
  };
  worker.onerror = event => {
    showError(event.message || "Web Workerでエラーが発生しました。");
    status.textContent = "計算エラー";
    setResultPlaceholder("error", "図を作成できませんでした", "上のエラー内容を確認してください。");
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
    status.textContent = `状態${selectedStateIndex}/359の詳細を計算中`;
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
  ctx.fillText(labels.x, xLabelCenter, labels.xLabelY ?? (height - 11));
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

function drawWeightedMarker(ctx, row, totalRows, x, y, radius, weight, shape = "circle") {
  const color = rowColor(row, totalRows);
  ctx.fillStyle = opaqueWeightColor(row, totalRows, weight);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  if (shape === "triangle" || shape === "circle-triangle") {
    ctx.moveTo(x, y - radius * 1.25);
    ctx.lineTo(x + radius * 1.1, y + radius * 0.8);
    ctx.lineTo(x - radius * 1.1, y + radius * 0.8);
    ctx.closePath();
  } else ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (shape === "circle-triangle") {
    ctx.beginPath(); ctx.arc(x, y, radius * 0.52, 0, Math.PI * 2); ctx.stroke();
  }
}

function mergeDiagramMarkers(points) {
  // A direct acquired sample can contribute through both angular branches.
  // Sum its coefficients before drawing an opaque marker, not by overpainting.
  // Coordinate coincidence alone never establishes physical sample identity.
  const merged = new Map();
  for (const point of points) {
    if (![point.referenceViewIndex, point.absoluteViewIndex, point.row].every(Number.isInteger)
      || ![point.x, point.y, point.weight].every(Number.isFinite) || point.weight < 0) {
      throw new Error("Invalid acquired-sample identity or coefficient in diagram marker");
    }
    const key = `${point.referenceViewIndex}:${point.absoluteViewIndex}:${point.row}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, {
        ...point, contributionCount: 1, contributions: [{ ...point }],
        traceFamilyIds: [point.traceFamilyId], dataKinds: [point.dataKind],
      });
      continue;
    }
    if (Math.abs(previous.x - point.x) > 1e-9 || Math.abs(previous.y - point.y) > 1e-9) {
      throw new Error(`Conflicting coordinates for acquired diagram sample ${key}`);
    }
    previous.weight += point.weight;
    previous.contributionCount += 1;
    previous.contributions.push({ ...point });
    if (!previous.traceFamilyIds.includes(point.traceFamilyId)) previous.traceFamilyIds.push(point.traceFamilyId);
    if (!previous.dataKinds.includes(point.dataKind)) previous.dataKinds.push(point.dataKind);
  }
  return [...merged.values()];
}

function drawDetectorRowLegend(ctx, diagram, left, y, width) {
  const count = Math.min(6, diagram.totalRows);
  const rows = Array.from({ length: count }, (_, i) => count === 1 ? 0 : Math.round(i * (diagram.totalRows - 1) / (count - 1)));
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = INK;
  ctx.font = `26px ${FIGURE_FONT}`;
  const label = diagram.rowLegendLabel ?? localizedText("検出器列", "Detector row");
  ctx.fillText(label, left, y);
  const start = left + ctx.measureText(label).width + 24;
  const cell = (left + width - start) / count;
  rows.forEach((row, index) => {
    const x0 = start + index * cell;
    ctx.strokeStyle = rowColor(row, diagram.totalRows);
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + 24, y); ctx.stroke();
    ctx.fillStyle = INK;
    ctx.fillText(String(diagram.rowLabels?.[row] ?? row + 1), x0 + 31, y);
  });
  ctx.restore();
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

function drawDiagramFamilyLegend(ctx, diagram, left, y, width) {
  const paired = diagram.traceFamilies?.some(trace => trace.family === "complementary");
  const items = [{ label: diagram.directLegendLabel ?? localizedText("実データ側 ○", "Direct ○"), dashed: false, color: INK }];
  if (paired) items.push({ label: localizedText("対向データ側 △", "Complementary △"), dashed: true, color: INK });
  items.push({ label: localizedText("目的断面", "Target plane"), dashed: false, color: RED });
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const columnWidth = width / items.length;
  items.forEach((item, index) => {
    const start = left + index * columnWidth;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 2.4;
    ctx.setLineDash(item.dashed ? [5, 3] : []);
    ctx.beginPath(); ctx.moveTo(start, y); ctx.lineTo(start + 30, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK;
    setFittedFigureFont(ctx, item.label, 26, 22, columnWidth - 44);
    ctx.fillText(item.label, start + 40, y);
  });
  ctx.restore();
}

function drawWeightLegend(ctx, left, top, width, diagram, countText) {
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = INK;
  const weightLabel = diagram.weightLegendLabel ?? localizedText("合計重み w (FW=0)", "Total weight w (FW=0)");
  const markerStart = left + width * 0.43;
  setFittedFigureFont(ctx, weightLabel, 26, 24, markerStart - left - 20);
  ctx.fillText(weightLabel, left, top);
  const weights = [0, 0.25, 0.5, 0.75, 1];
  const cell = (left + width - markerStart) / weights.length;
  weights.forEach((weight, index) => {
    const markerX = markerStart + index * cell;
    drawWeightedMarker(ctx, 0, diagram.totalRows, markerX, top, 7, weight);
    ctx.fillStyle = INK;
    ctx.font = `25px ${FIGURE_FONT}`;
    ctx.textAlign = "left";
    ctx.fillText(weight.toFixed(weight === 0 || weight === 1 ? 0 : 2), markerX + 14, top);
  });
  drawDetectorRowLegend(ctx, diagram, left, top + 38, width);
  drawDiagramFamilyLegend(ctx, diagram, left, top + 76, width);
  ctx.textAlign = "left";
  ctx.fillStyle = MUTED;
  const note = diagram.weightLegendNote ?? localizedText("同じ取得データの重みを合算。軌道の重なりは混色。", "Weights sum per acquired sample; trace overlaps blend.");
  setFittedFigureFont(ctx, note, 24, 22, width);
  ctx.fillText(note, left, top + 114);
  ctx.restore();
}

function drawCandidateTrace(ctx, diagram, trace, row, turn, x, yDown, xLimit) {
  const angles = trace.angles;
  const axial = trace.axial;
  const scales = trace.scales;
  const rowOffset = diagram.traceGeometry.rowOffsets[row];
  const feed = diagram.traceGeometry.feed;
  const complementary = trace.family === "complementary";
  const totalRows = diagram.totalRows;
  ctx.save();
  ctx.strokeStyle = rowColor(row, totalRows);
  const densityScale = Math.min(1, Math.sqrt(24 / Math.max(24, totalRows)));
  // Multiplication makes coincident trajectory colors blend independent of
  // draw order. Opacity and stroke width both fall with sqrt(row density),
  // preserving visible trajectories without allowing many-row bands to blacken.
  // This is an overlap cue only, never a numerical weight or a new row color.
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = (complementary ? 0.45 : 0.60) * densityScale;
  ctx.lineWidth = Math.max(0.45, 1.35 * densityScale);
  ctx.setLineDash(complementary ? [5, 3] : []);
  // Avoid artificial horizontal bands from aligned dash phases in dense rows.
  ctx.lineDashOffset = complementary ? -(row % 11) * 0.73 : 0;
  ctx.beginPath();
  let previousAngle = null;
  let previousDelta = null;
  for (let index = 0; index < angles.length; index += 1) {
    const angle = angles[index];
    const delta = axial[index] + turn * feed + scales[index] * rowOffset - diagram.z0;
    // Preserve every acquired reference view. Cull only whole off-screen
    // segments, never downsample the complementary-angle geometry.
    const outside = previousDelta !== null && (
      (delta < -xLimit && previousDelta < -xLimit)
      || (delta > xLimit && previousDelta > xLimit)
    );
    const px = x(delta);
    const py = yDown(angle);
    if (previousAngle === null || outside || Math.abs(angle - previousAngle) > 180) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
    previousAngle = angle;
    previousDelta = delta;
  }
  ctx.stroke();
  ctx.restore();
}

function drawOverviewLegend(ctx, diagram, left, top, width, countText) {
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = INK;
  const scope = diagram.overviewLegendLabel ?? localizedText(`全${diagram.totalRows}列の候補軌道`, `Candidate trajectories: all ${diagram.totalRows} rows`);
  setFittedFigureFont(ctx, scope, 26, 24, width);
  ctx.fillText(scope, left, top);
  drawDetectorRowLegend(ctx, diagram, left, top + 38, width);
  drawDiagramFamilyLegend(ctx, diagram, left, top + 76, width);
  ctx.textAlign = "left";
  ctx.fillStyle = MUTED;
  const band = localizedText("淡色帯：拡大図の表示範囲（設定厚Tとは別）", "Shaded band: zoomed range, independent of thickness T");
  setFittedFigureFont(ctx, band, 24, 22, width);
  ctx.fillText(band, left, top + 114);
  ctx.restore();
}

function drawDiagram(canvas, diagram, mode = "zoom", sharedXLimit = null, focusXLimit = null) {
  const publicationMode = canvas.dataset.publicationMode === "true";
  const ownLimit = mode === "overview" ? diagram.overviewXLimit : diagram.zoomXLimit;
  const requiredXLimit = sharedXLimit ?? ownLimit;
  const xAxis = symmetricNiceAxis(requiredXLimit, 3);
  const xLimit = xAxis.xMax;
  const plot = axisContext(canvas, { xMin: xAxis.xMin, xMax: xAxis.xMax, yMin: 0, yMax: 360 }, {
    x: diagram.xAxisLabel ?? "候補列中心  zᵢ − z₀  (mm)",
    y: diagram.yAxisLabel ?? localizedText("実データ側の角度  β  (°)", "Direct-data reference angle  β  (°)"),
    xFormatter: xAxis.formatter,
    yFormatter: value => Number(value).toFixed(0),
    topMargin: 32,
    bottomMargin: 278,
  });
  const { ctx, margin, innerWidth, innerHeight, x, yDown } = plot;
  const bandLimit = Math.min(xLimit, mode === "overview"
    ? (focusXLimit ?? diagram.zoomXLimit)
    : Math.max(diagram.interpolationBandHalfWidth ?? 0, 0.15));
  ctx.fillStyle = PALE;
  ctx.fillRect(x(-bandLimit), margin.top, x(bandLimit) - x(-bandLimit), innerHeight);
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, innerWidth, innerHeight);
  ctx.clip();
  // Every family is expressed in the same DIRECT reference-angle coordinate.
  // In particular, complementary markers are not drawn on direct-only traces.
  const traceFamilies = diagram.traceFamilies ?? [diagram.traceGeometry];
  for (const trace of traceFamilies) {
    // Exact angular matches have only one distinct complementary family.
    if (trace.id === "complementary-upper") {
      const lower = traceFamilies.find(item => item.id === "complementary-lower");
      if (lower && trace.absoluteViewIndices.every((value, index) => value === lower.absoluteViewIndices[index])) continue;
    }
    for (let row = 0; row < diagram.totalRows; row += 1) {
      for (const turn of diagram.traceGeometry.turns) {
        drawCandidateTrace(ctx, diagram, trace, row, turn, x, yDown, xLimit);
      }
    }
  }
  const mergedPoints = mode === "zoom" ? mergeDiagramMarkers(diagram.weightedPoints) : [];
  if (mode === "zoom") {
    const pointsByWeight = [...mergedPoints].sort((a, b) => a.weight - b.weight);
    for (const point of pointsByWeight) {
      const px = x(point.x); const py = yDown(point.y);
      let shape = point.traceFamilyId?.startsWith("complementary-") ? "triangle" : "circle";
      const familyRoles = new Set(point.traceFamilyIds.map(id => id?.startsWith("complementary-") ? "complementary" : "direct"));
      if (familyRoles.size > 1) shape = "circle-triangle";
      drawWeightedMarker(ctx, point.row, diagram.totalRows, px, py, 5.2, point.weight, shape);
    }
  }
  ctx.strokeStyle = RED;
  ctx.setLineDash([]);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x(0), margin.top); ctx.lineTo(x(0), margin.top + innerHeight); ctx.stroke();
  ctx.restore();
  // The key belongs below the axes, in a separate footer. Reserve plot
  // height in the canvas dimensions rather than squeezing it for the legend.
  plot.labels.xLabelY = margin.top + innerHeight + 86;
  drawAxes(plot, xAxis.ticks, [0, 60, 120, 180, 240, 300, 360], true);
  const legendTop = margin.top + innerHeight + 136;
  ctx.save(); ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(margin.left, legendTop - 27); ctx.lineTo(margin.left + innerWidth, legendTop - 27); ctx.stroke(); ctx.restore();
  if (mode === "overview" || diagram.geometryOnly) {
    const countText = localizedText(
      `全${diagram.totalRows}列・全${diagram.referenceViewSamples}取得角度／共通の実データ側角度βで表示／Tで除外しない`,
      `All ${diagram.totalRows} rows / ${diagram.referenceViewSamples} acquired angles / common direct-data reference angle β / no T-based exclusion`,
    );
    drawOverviewLegend(ctx, diagram, margin.left, legendTop, innerWidth, countText);
  } else {
    const countText = localizedText(
      `点は${diagram.renderedAngleSamples}角度を抜粋／軌道は全取得角度／Tで除外しない`,
      `Markers: ${diagram.renderedAngleSamples} reference angles / trajectories: all acquired angles / no T-based exclusion`,
    );
    drawWeightLegend(
      ctx,
      margin.left,
      legendTop,
      innerWidth,
      diagram,
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
  canvas.dataset.angleCoordinate = diagram.angleCoordinate;
  canvas.dataset.traceFamilyIds = traceFamilies.map(trace => trace.id).join(",");
  canvas.dataset.traceSamplesPerFamily = String(diagram.acquiredTraceSamples);
  canvas.dataset.complementaryMarkerShape = "triangle";
  canvas.dataset.complementaryLineStyle = "dashed";
  canvas.dataset.markerAggregation = "referenceViewIndex:absoluteViewIndex:row;sum-contributions";
  canvas.dataset.rawMarkerContributions = String(mode === "zoom" ? diagram.weightedPoints.length : 0);
  canvas.dataset.uniqueAcquiredMarkers = String(mergedPoints.length);
  canvas.dataset.inlineRowLabels = "0";
  canvas.dataset.traceOverlapEncoding = "multiply;opacity-and-width-density-compensated;not-weight";
  canvas.dataset.diagramDisplayVersion = "2026-09-16.1";
  canvas.dataset.legendPlacement = "below-axes";
  canvas.dataset.plotHeight = String(innerHeight);
  canvas.dataset.legendTop = String(legendTop);
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
    x: "実データ側の角度  β  (°)",
    y: "対向データ側のレイまでの角度差  Δβc  (°)",
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
    { label: "理想対向角差 180°+2γ", color: ORANGE },
    { label: "最近接実取得ビュー", color: INK, dash: [5, 4] },
    { label: "理想角を挟む実取得2ビュー", color: LIGHT, dash: [8, 6] },
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
    x: "実データ側の角度  β  (°)",
    y: "目的断面を挟む対応区間幅  G  (mm)",
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
    { label: "理想角：実データₙ → 対向データₙ", color: BLUE },
    { label: "理想角：対向データₙ → 実データₙ₊₁", color: ORANGE, dash: [7, 5] },
    { label: "Gmin = min(G₁, G₂)", color: INK },
    { label: "淡色帯：理想角を挟む実取得2ビュー", color: LIGHT },
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
    x: "実データ側の角度  β  (°)",
    y: "目的断面に対する候補位置  z − z₀  (mm)",
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
    { label: "全候補統合後の最近接挟み込み Gmerge", color: LIGHT },
    { label: "小さいz側（点＝最近接実取得ビュー）", color: BLUE },
    { label: "大きいz側（点＝最近接実取得ビュー）", color: ORANGE, dash: [7, 5] },
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
    drawCanvasStatus(canvas, "候補点の広がりを計算中", "無重み標準偏差の計算結果を待っています");
    return;
  }
  const angleCount = Math.min(
    Number(overlay.geometryAngleCount) || offValues.length,
    offValues.length,
    onValues.length,
    betaValues?.length ?? Infinity,
  );
  if (!(angleCount > 0)) {
    drawCanvasStatus(canvas, "候補点の広がりを表示できません", "投影角度ごとの計算結果がありません", "error");
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
    x: "相対X線管角度  β  (°)",
    y: "候補位置の体軸方向標準偏差  σz  (mm)",
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
  const title = "候補点の体軸方向の広がり";
  setFittedFigureFont(plot.ctx, title, 25, 18, plot.innerWidth, "700");
  plot.ctx.fillText(title, plot.margin.left, 8);
  const subtitle = "実データ側N列＋理想対向角を挟む実取得ビューの全列（無重み）";
  plot.ctx.fillStyle = MUTED;
  setFittedFigureFont(plot.ctx, subtitle, 18, 13, plot.innerWidth);
  plot.ctx.fillText(subtitle, plot.margin.left, 43);
  drawLegend(plot.ctx, [
    { label: "コーン幾何を反映しない", color: BLUE },
    { label: "コーン幾何を反映する", color: ORANGE, dash: [9, 5] },
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

  const minimumHalfSpan = Math.max(0.5 * result.params.rowWidth, 6 * dz);
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
  drawKey(left, top + 20, BLUE, [], "コーン幾何を反映しない");
  drawKey(left + 410, top + 20, ORANGE, [], "コーン幾何を反映する（理想化）");
  ctx.restore();
}

function strokeNativeProfile(ctx, z, values, x, y, { offset = 0, tailView = false } = {}) {
  // Display the original calculation grid directly, including nonuniform z.
  // This painter neither resamples/smooths points nor changes model values.
  ctx.beginPath();
  let active = false;
  for (let index = 0; index < z.length; index += 1) {
    const value = values[offset + index];
    if (!Number.isFinite(z[index]) || !Number.isFinite(value) || (tailView && value < 0.001)) {
      active = false;
      continue;
    }
    const px = x(z[index]);
    const py = y(tailView ? Math.log10(Math.max(0.001, value)) : value);
    if (!active) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    active = true;
  }
  ctx.stroke();
}

function setProfileDisplayMetadata(canvas) {
  canvas.dataset.profileDisplayVersion = PROFILE_DISPLAY_VERSION;
  canvas.dataset.profileInterpolation = "native-samples-piecewise-linear";
  canvas.dataset.profileSmoothing = "none";
  canvas.dataset.profileSpline = "none";
  canvas.dataset.profileDecimation = "none";
  canvas.dataset.profileDisplayGrid = "original-calculated-z-values";
}

function drawProfiles(canvas, result) {
  const publicationMode = canvas.dataset.publicationMode === "true";
  const axis = selectedProfileAxis(result);
  const { xMin, xMax } = axis;
  const plot = axisContext(canvas, { xMin, xMax, yMin: 0, yMax: 1.04 }, {
    x: localizedText("物体に対する再構成面の位置  zᵣ − zₒ (mm)", "Reconstruction-plane position relative to object  zᵣ − zₒ (mm)"),
    y: "正規化SSPz",
    xFormatter: value => Number(value).toFixed(decimalPlacesForStep(axis.tickStep)),
    yFormatter: value => value.toFixed(1),
    topMargin: publicationMode ? 96 : 126,
  });
  // Paint the grid first: a flat normalized peak at exactly 1 must remain
  // visible instead of being overwritten by the 100% gridline.
  drawAxes(plot, axis.ticks, [0, 0.2, 0.4, 0.6, 0.8, 1.0]);
  plot.ctx.save();
  plot.ctx.beginPath();
  plot.ctx.rect(plot.margin.left, plot.margin.top, plot.innerWidth, plot.innerHeight);
  plot.ctx.clip();
  plot.ctx.save();
  plot.ctx.lineWidth = 4;
  plot.ctx.setLineDash([]);
  plot.ctx.strokeStyle = BLUE;
  strokeNativeProfile(plot.ctx, result.selectedOff.z, result.selectedOff.profile, plot.x, plot.y);
  plot.ctx.strokeStyle = ORANGE;
  strokeNativeProfile(plot.ctx, result.selectedOn.z, result.selectedOn.profile, plot.x, plot.y);
  plot.ctx.restore();
  plot.ctx.save(); plot.ctx.strokeStyle = MUTED; plot.ctx.setLineDash([5,5]); plot.ctx.lineWidth = 1;
  for (const level of [0.5, 0.1]) { plot.ctx.beginPath(); plot.ctx.moveTo(plot.margin.left, plot.y(level)); plot.ctx.lineTo(plot.margin.left + plot.innerWidth, plot.y(level)); plot.ctx.stroke(); }
  plot.ctx.restore();
  plot.ctx.restore();
  drawProfileEncodingLegend(plot.ctx, plot.margin.left, 6);
  plot.ctx.save();
  plot.ctx.fillStyle = MUTED;
  setFittedFigureFont(plot.ctx, filterParameterLabel(result.params, result.selectedOn.filterSamples), 18, 14, plot.innerWidth);
  plot.ctx.fillText(filterParameterLabel(result.params, result.selectedOn.filterSamples), plot.margin.left, 72);
  plot.ctx.restore();
  plot.ctx.save();
  plot.ctx.fillStyle = MUTED;
  plot.ctx.font = `18px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "right";
  plot.ctx.textBaseline = "bottom";
  plot.ctx.fillText("50%（FWHM）", plot.margin.left + plot.innerWidth - 8, plot.y(0.5) - 5);
  plot.ctx.fillText("10%（FWTM）", plot.margin.left + plot.innerWidth - 8, plot.y(0.1) - 5);
  plot.ctx.restore();
  canvas.dataset.xMin = String(axis.xMin);
  canvas.dataset.xMax = String(axis.xMax);
  canvas.dataset.xStep = String(axis.tickStep);
  canvas.dataset.configuredThicknessMm = String(result.params.sliceThicknessMm);
  canvas.dataset.filterWidthMm = String(result.params.filterWidthMm);
  canvas.dataset.filterSamples = String(result.selectedOn.filterSamples);
  canvas.dataset.requestedFilterSamples = String(result.params.filterSamples);
  canvas.dataset.responseCoordinate = "reconstruction-plane-minus-fixed-object-mm";
  canvas.dataset.axisRule = "configured-output-at-or-above-ten-percent";
  canvas.dataset.legendOrder = "configured-output-only";
  setProfileDisplayMetadata(canvas);
  canvas.dataset.nativeProfilePointCounts = JSON.stringify([result.selectedOff.z.length, result.selectedOn.z.length]);
  canvas.setAttribute("aria-label", localizedText(`フィルタ補間後の選択状態SSPz。${filterParameterLabel(result.params, result.selectedOn.filterSamples)}。横軸は固定した薄い物体に対する再構成面位置`, `Selected-state SSPz after filter interpolation. ${filterParameterLabel(result.params, result.selectedOn.filterSamples)}. Horizontal axis: reconstruction-plane position relative to a fixed thin object.`));
  if (profileAxisNote) {
    profileAxisNote.textContent = localizedText(`${filterParameterLabel(result.params, result.selectedOn.filterSamples)}／横軸は固定物体に対する再構成面位置（10%以上から自動調整）`, `${filterParameterLabel(result.params, result.selectedOn.filterSamples)} / horizontal axis: reconstruction-plane position relative to the fixed object (auto-scaled from values >=10%)`);
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
  ctx.fillText("360状態", x + 45, y);
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
  const core = configuredOverlayBounds(result, 0.1, 0.5 * result.params.rowWidth);
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
  const tailView = viewMode === "tail";
  const stageLabel = tailView
    ? localizedText("フィルタ補間後SSPz・低振幅裾", "Filter-interpolated SSPz: low-amplitude tails")
    : localizedText("フィルタ補間後SSPz・中心形状", "Filter-interpolated SSPz: central shape");
  const plot = axisContext(canvas, {
    xMin,
    xMax,
    yMin: tailView ? PROFILE_TAIL_DISPLAY_BOUNDS.yMin : 0,
    yMax: tailView ? PROFILE_TAIL_DISPLAY_BOUNDS.yMax : 1.04,
  }, {
    x: localizedText("物体に対する再構成面の位置  zᵣ − zₒ (mm)", "Reconstruction-plane position relative to object  zᵣ − zₒ (mm)"),
    y: tailView ? "正規化SSPz（対数）" : "正規化SSPz",
    xFormatter: xAxis.formatter,
    yFormatter: tailView
      ? value => ({ "-3": "0.1%", "-2": "1%", "-1": "10%", "0": "100%" }[String(value)] ?? "")
      : value => value.toFixed(1),
    topMargin: publicationMode ? 116 : 126,
    leftMargin: tailView ? 158 : undefined,
  });

  // The 100% plateau can coincide exactly with a gridline. Keep the grid
  // behind every individual SSPz in both the screen and publication paths.
  drawAxes(plot, xAxis.ticks, tailView ? [-3, -2, -1, 0] : [0, 0.2, 0.4, 0.6, 0.8, 1.0]);
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
    strokeNativeProfile(plot.ctx, z, values, plot.x, plot.y, { offset, tailView });
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

  plot.ctx.save();
  plot.ctx.fillStyle = INK;
  plot.ctx.font = `700 23px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "left";
  plot.ctx.textBaseline = "top";
  const conditionLabel = coneOn ? "コーン幾何を反映する（周期的距離変化）" : "コーン幾何を反映しない（平行ビーム近似）";
  if (publicationMode) {
    const conciseCondition = coneOn ? "コーン幾何あり" : "コーン幾何なし";
    const conciseStage = stageLabel;
    // Keep the scientific stage and geometry condition on separate lines.
    // A single English line exceeds the fixed 80-mm journal figure width.
    setFittedFigureFont(plot.ctx, conciseStage, 23, 17, plot.innerWidth, "700");
    plot.ctx.fillText(conciseStage, plot.margin.left, 8);
    plot.ctx.font = `20px ${FIGURE_FONT}`;
    const subtitle = `${conciseCondition} / ${filterParameterLabel(result.params, result.selectedOn.filterSamples)}`;
    setFittedFigureFont(plot.ctx, subtitle, 20, 13, plot.innerWidth);
    plot.ctx.fillText(subtitle, plot.margin.left, 38);
  } else {
    setFittedFigureFont(plot.ctx, stageLabel, 23, 17, plot.innerWidth, "700");
    plot.ctx.fillText(stageLabel, plot.margin.left, 10);
    plot.ctx.fillStyle = MUTED;
    const statusLabel = `${conditionLabel} / ${filterParameterLabel(result.params, result.selectedOn.filterSamples)}`;
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
  setProfileDisplayMetadata(canvas);
  canvas.dataset.nativeProfilePointCount = String(overlay.zCount);
  canvas.dataset.xMin = String(xAxis.xMin);
  canvas.dataset.xMax = String(xAxis.xMax);
  canvas.dataset.xStep = String(xAxis.step);
  canvas.dataset.profileStage = "configured-output-only";
  canvas.dataset.filterWidthMm = String(result.params.filterWidthMm);
  canvas.dataset.filterSamples = String(result.selectedOn.filterSamples);
  canvas.dataset.requestedFilterSamples = String(result.params.filterSamples);
  canvas.dataset.responseCoordinate = "reconstruction-plane-minus-fixed-object-mm";
  canvas.dataset.viewMode = viewMode;
  if (tailView) {
    canvas.dataset.renderedMinimum = "0.001";
    canvas.dataset.displayYMinLog10 = String(PROFILE_TAIL_DISPLAY_BOUNDS.yMin);
    canvas.dataset.displayYMaxLog10 = String(PROFILE_TAIL_DISPLAY_BOUNDS.yMax);
  }
  canvas.dataset.sharedXDomain = tailView
    ? "configured-output-tail-cone-on"
    : "configured-output-core-off-on";
  canvas.setAttribute("aria-label", `${stageLabel} / ${conditionLabel} / ${filterParameterLabel(result.params, result.selectedOn.filterSamples)}`);
}

function filterParameterLabel(params, actualSamples = params.filterSamples) {
  return `T = FW = ${fmt(params.sliceThicknessMm, 2)} mm; K=${actualSamples}`;
}

function selectedMetric(result) {
  const key = metricSelect.value;
  const labels = { fwhm: "FWHM", fwtm: "FWTM", sigma: "σ" };
  const layered = false;
  const stageLabel = localizedText("フィルタ補間後SSPz", "Filter-interpolated SSPz");
  metricLabel.textContent = `${stageLabel} / ${labels[key]}`;
  return { key, rawKey: key, label: labels[key], stageLabel, layered };
}

function drawConditionLegend(ctx, left, y) {
  ctx.save();
  ctx.font = `21px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const items = [
    { x: left, color: BLUE, label: "コーン幾何を反映しない" },
    { x: left + 430, color: ORANGE, label: "コーン幾何を反映する（理想化）" },
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
    x: localizedText("1回転寝台移動量内の物体位置  s", "Object position within one table feed  s"),
    y: `${metric.label} / T`,
    xFormatter: value => Number(value).toFixed(1),
    yFormatter: yScale.formatter,
    topMargin: publicationMode ? 105 : 134,
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
    const subtitle = filterParameterLabel(result.params, result.selectedOn.filterSamples);
    plot.ctx.fillText(subtitle, plot.margin.left, 45);
    plot.ctx.restore();
  }
  if (publicationMode) {
    plot.ctx.save();
    plot.ctx.fillStyle = MUTED;
    setFittedFigureFont(plot.ctx, filterParameterLabel(result.params, result.selectedOn.filterSamples), 19, 14, plot.innerWidth);
    plot.ctx.fillText(filterParameterLabel(result.params, result.selectedOn.filterSamples), plot.margin.left, 78);
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
    sweepInterpretation.hidden = false;
    sweepInterpretation.textContent = localizedText("設定厚Tを矩形平均化幅FWとして計算し、得られた幅をTで除しています。FWHMは出力値であり、Tと一致するよう調整していません。", "Configured thickness T defines rectangular averaging width FW. The resulting width is divided by T; FWHM is an output, not fitted to T.");
  }
}

function renderSummary(result) {
  const primaryCards = [];
  const secondaryCards = [];
  const uses180Li = result.params.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI;
  const gapRatioLabel = uses180Li ? "Gₑff/T" : "Δz/T";
  for (const [key, label, css, spreadKey] of [
    ["off", "コーン幾何を反映しない", "", "allCandidateAxialSpreadOffMm"],
    ["on", "コーン幾何を反映する", "on", "allCandidateAxialSpreadOnMm"],
  ]) {
    const summary = result.summaries[key];
    const spreadValues = Array.from(result.overlay?.[spreadKey] ?? []).filter(Number.isFinite);
    const spreadMinimum = spreadValues.length ? Math.min(...spreadValues) : NaN;
    const spreadMaximum = spreadValues.length ? Math.max(...spreadValues) : NaN;
    primaryCards.push(`
      <div class="summary-card ${css}">
        <span>${label} / 候補位置の体軸方向標準偏差の最大（mm）</span>
        <strong>${fmt(spreadMaximum, 3)}</strong>
        <small>投影角度別範囲 ${fmt(spreadMinimum, 3)}–${fmt(spreadMaximum, 3)} mm／無重み</small>
      </div>`);
    secondaryCards.push(`
      <div class="summary-card ${css}">
        <span>${label} / ${localizedText("フィルタ補間後SSPzのFWHM/T変動幅", "Range of filter-interpolated SSPz FWHM/T")}</span>
        <strong>${fmt(summary.fwhm.range / result.params.sliceThicknessMm, 4)}</strong>
        <small>${fmt(summary.fwhm.min / result.params.sliceThicknessMm, 3)}–${fmt(summary.fwhm.max / result.params.sliceThicknessMm, 3)}</small>
      </div>`);
  }
  // SSPz-shape evidence is followed by the pre-adoption, unweighted geometric
  // spread of all row-center candidates for each direct-view angle.
  summaryCards.innerHTML = [...secondaryCards, ...primaryCards].join("");
  resultTable.innerHTML = [
    ["コーン幾何を反映しない（平行ビーム近似）", result.selectedOff],
    ["コーン幾何を反映する（周期的距離変化）", result.selectedOn],
  ].map(([label, row]) => `<tr><td>${label}</td><td>${fmt(row.fwhm, 3)}</td><td>${fmt(row.fwtm, 3)}</td><td>${fmt(row.sigma, 3)}</td><td>${fmt(row.bracketGapRatioMax, 3)}</td></tr>`).join("");
  const gapHeading = document.querySelector("#gap-summary-heading");
  if (gapHeading) gapHeading.textContent = `最大 ${gapRatioLabel}（監査）`;
  const gapNote = document.querySelector("#gap-summary-note");
  if (gapNote) gapNote.textContent = uses180Li
    ? "注：SSPz＝体軸方向スライス感度プロファイル、FWHM＝半値幅、FWTM＝10%幅、σ＝面積正規化したSSPzの標準偏差。Gₑff/Tは、理想対向角を挟む2枝の挟み込み幅を角度方向に加重し、設定スライス厚で除した値です。表示桁数はモデル出力の記録用であり、実測精度を意味しません。"
    : "注：SSPz＝体軸方向スライス感度プロファイル、FWHM＝半値幅、FWTM＝10%幅、σ＝面積正規化したSSPzの標準偏差。Δz/Tは、実データ側で目的断面を挟む最近接候補間隔を設定スライス厚で除した値です。表示桁数はモデル出力の記録用であり、実測精度を意味しません。";
  const caption = document.querySelector("#result-caption");
  if (caption) caption.textContent = `閲覧中のモデル状態${selectedStateIndex}/359（s=${(selectedStateIndex / 360).toFixed(3)}）における結果`;
}

function updateProfileModelNote(result) {
  const multiComponent = Math.max(result.selectedOff.halfComponents, result.selectedOn.halfComponents) > 1;
  const pathText = result.params.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
    ? "主解析では、各実データ側ビューの理想対向角を挟む両隣の実取得ビューについて、実データ側・対向データ側の全列候補を統合して体軸方向の最近接挟み込みを作り、その2枝を角度方向に線形合成します。"
    : "比較表示では、対向データ側をSSPzへ用いず、0～360°の実データ側ビューだけで体軸方向の最近接挟み込みを作ります。";
  const candidateSpreadText = "幾何表示では、実データ側の全列と、理想対向角を挟む実取得ビューの全列について、列中心位置の体軸方向標準偏差を無重みで示します。候補点の採用、補間・再構成重み、設定厚による閾値は適用しません。";
  const modelText = localizedText(`Taguchiらの式（6）・Fig. 5/6に基づき、再構成面周囲のK個のz位置で取得候補を選び直し、線形補間した値を矩形重みで平均します。${filterParameterLabel(result.params, result.selectedOn.filterSamples)}。固定した薄い物体に対して再構成面を動かした応答です。360状態は寝台移動量内の物体位置であり、各SSPz内の横軸はzᵣ−zₒです。FWと設定厚Tの対応は実機に校正せず、FWHMは結果として計算します。展開図の端点・間隔は中心位置でのFW=0の局所補間の監査で、厚いスライスの全寄与候補ではありません。取得幾何の全列表示は変更していません。面内・列方向とも有限開口で取得した点信号を使い、面内の線形補間後に体軸方向を補間します。これは体軸応答のモデルであり、全画像再構成・装置固有の重み・逆投影・有限ビーズ径は再現しません。`, `Using Eq. (6) and Figs. 5/6 of Taguchi et al., acquired candidates are reselected at K longitudinal positions around the reconstruction plane, locally linearly interpolated, and averaged with rectangular weights. ${filterParameterLabel(result.params, result.selectedOn.filterSamples)}. The response is evaluated by moving the reconstruction plane past a fixed thin object. The 360 states are object positions within one table feed; the coordinate within each SSPz is zᵣ−zₒ. FW is not calibrated to scanner-specific nominal thickness T, and FWHM is an output. Diagram endpoints and gaps audit local FW=0 interpolation at the central position; they are not all contributors to the thick-slice response. All-row acquisition geometry is unchanged. Acquired point signals include finite channel and row apertures, followed by linear transaxial readout and axial interpolation. This axial-response model does not reproduce full image reconstruction, scanner-specific weights, backprojection, or finite bead diameter.`);
  const topologyText = multiComponent
    ? " 注意：50%水準が複数成分に分かれています。FWHMだけで形状を代表させないでください。"
    : "";
  const gridWarning = [result.selectedOff, result.selectedOn].some(profile => profile.gridResolutionAdequate === false)
    ? localizedText(" 注意：SSPzの体軸グリッドが精度目安より粗い状態です。グリッド点数を増やして収束を確認するまで、幅指標を確定値として使用しないでください。", " Warning: the SSPz longitudinal grid is coarser than the accuracy guideline. Increase grid resolution and verify convergence before treating width metrics as final.")
    : "";
  profileModelNote.textContent = modelText + topologyText + gridWarning;
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
    drawCanvasStatus(canvas, localizedText("幾何を表示できません", "Geometry unavailable"), "", "error");
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
  ctx.fillText(localizedText("A　取得幾何（被写体固定座標・縮尺なし）", "A  Acquisition geometry (object-fixed; not to scale)"), panelA.x + 12, panelA.y + 10, panelA.width - 24);
  ctx.fillText(localizedText("B　全列位置と、再構成面に最も近い候補点", "B  All row positions and candidates nearest to the reconstruction plane"), panelB.x + 12, panelB.y + 10, panelB.width - 24);

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
      localizedText(`s=0（現在）  z₀=zref`, `s=0 (current)  z₀=zref`),
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
      localizedText(`現在 s=${shortState}  z₀`, `current s=${shortState}  z₀`),
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
      localizedText(`現在 s=${shortState}  z₀`, `current s=${shortState}  z₀`),
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
  ctx.fillText(localizedText("実データ側 β", "Direct side β"), directSource.x + 7, directSource.y - 17);
  ctx.fillStyle = ORANGE;
  ctx.fillText(localizedText("対向データ側の実取得ビュー", "Acquired complementary views"), complementSource.x + 7, complementSource.y + 7, panelA.width * 0.38);
  ctx.fillStyle = "#4f5b63";
  ctx.fillText(localizedText("理想 βc", "Ideal βc"), idealSource.x + 7, idealSource.y - 18);
  ctx.fillStyle = RED;
  ctx.save();
  ctx.strokeStyle = RED;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(panelA.x + 12, panelA.y + 38);
  ctx.lineTo(panelA.x + 34, panelA.y + 38);
  ctx.stroke();
  ctx.fillText(
    localizedText("選択中の再構成面 z₀", "Selected reconstruction plane z₀"),
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
    localizedText(`細線は代表${representativeRows.length}列、○・△は再構成面に最も近い候補点（採用・重みは示さない）`, `Thin rays show ${representativeRows.length} representative rows; circles and triangles mark candidates nearest to the reconstruction plane (no adoption or weight is shown)`),
    panelA.x + 12,
    panelA.y + panelA.height - 21,
    panelA.width - 24,
  );

  // Panel B: every detector-row center for the direct view and both acquired
  // neighbors bracketing the ideal complementary angle.  Row centers are
  // short ticks; only selected reconstruction candidates receive markers.
  const columns = [
    { key: "direct", family: scene.direct, xFraction: 0.22, color: BLUE, label: localizedText("実データ側 β", "Direct β") },
    { key: "complementary-lower", family: scene.complementaryLower, xFraction: 0.54, color: ORANGE, label: localizedText("対向側 下側ビュー", "Complement lower view") },
    { key: "complementary-upper", family: scene.complementaryUpper, xFraction: 0.82, color: ORANGE, label: localizedText("対向側 上側ビュー", "Complement upper view") },
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
    `現在の条件：N=${scene.rows}列、d=${scene.rowWidth.toFixed(3)} mm、p=${scene.beamPitch.toFixed(3)}、1回転の寝台移動量F=${scene.feed.toFixed(3)} mm。選択中の再構成面z₀=${scene.z0.toFixed(3)} mmは、基準面zrefから${(scene.state * scene.feed).toFixed(3)} mm、すなわちs=${scene.state.toFixed(3)}の位置です。○は実データ側、△は対向データ側で再構成面に最も近い候補点を位置関係の目印として示します。候補点の採用や重みは示しません。`,
    `Current conditions: N=${scene.rows} rows, d=${scene.rowWidth.toFixed(3)} mm, p=${scene.beamPitch.toFixed(3)}, and table feed per rotation F=${scene.feed.toFixed(3)} mm. The selected reconstruction plane z₀=${scene.z0.toFixed(3)} mm lies ${(scene.state * scene.feed).toFixed(3)} mm from the reference plane zref, corresponding to s=${scene.state.toFixed(3)}. Circles and triangles mark the direct- and complementary-side candidates nearest to the reconstruction plane as positional guides. Candidate adoption and weights are not shown.`,
  );
}

function renderInspectionDetails(result) {
  const overviewLimit = Math.max(result.diagramOff.overviewXLimit, result.diagramOn.overviewXLimit);
  const zoomLimit = Math.max(result.diagramOff.zoomXLimit, result.diagramOn.zoomXLimit);
  const overviewScope = document.querySelector("#overview-scope");
  const calculationScope = document.querySelector("#calculation-scope");
  overviewScope.textContent = `自動表示範囲：全列候補軌道のうち、選択端点を含む回転と前後1回転（基準回転との差 ${result.diagramOff.turnOffsetMin}〜${result.diagramOff.turnOffsetMax}、合計${result.diagramOff.turnCount}回転）`;
  const complementary = result.diagramOn.complementaryCandidates;
  const applicationText = result.params.reconstructionPath === RECONSTRUCTION_PATHS.FAN_BEAM_180LI
    ? "両隣の取得ビューから得た挟み込みをSSPzへ角度線形合成"
    : "2Cは幾何監査のみ（SSPzは実データ側フルスキャン）";
  calculationScope.textContent = `${reconstructionPathLabel(result.params.reconstructionPath)}／各実取得ビューの全${result.params.rows}列を候補母集団として保持（Tによる候補除外なし）／理想対向角を挟む取得ビューも同じ全列規則／${applicationText}／最大角度量子化差 ${fmt(complementary.maximumAngularResidualDeg, 4)}°`;
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
  try { result.shapeAnalysis = {off: SSPZShape.analyze(result.overlay, 'off'), on: SSPZShape.analyze(result.overlay, 'on')}; }
  catch(error) { result.shapeAnalysis = null; document.querySelector('#shape-status').textContent = error.message; }
  drawShapeDeviation(document.querySelector('#shape-deviation-off'), result, 'off');
  drawShapeDeviation(document.querySelector('#shape-deviation-on'), result, 'on');
  renderInspectionDetails(result);
  const finalHeading = document.querySelector("#overlay-core-heading");
  const finalDescription = document.querySelector("#overlay-core-description");
  if (finalHeading) finalHeading.textContent = localizedText("フィルタ補間後SSPz・中心形状", "Filter-interpolated SSPz: central shape");
  if (finalDescription) finalDescription.textContent = filterParameterLabel(result.params, result.selectedOn.filterSamples);
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
    overlayScope.textContent = localizedText(`1回転寝台移動量内の物体位置を${result.overlay.stateCount}等分／各状態${result.params.viewSamples}ビュー／${filterParameterLabel(result.params, result.selectedOn.filterSamples)}`, `${result.overlay.stateCount} object positions within one table feed / ${result.params.viewSamples} views per state / ${filterParameterLabel(result.params, result.selectedOn.filterSamples)}`);
  }
  drawSweep(document.querySelector("#sweep-chart"), result);
}

function drawShapeDeviation(canvas, result, key) {
  if(!result.shapeAnalysis) return;
  const a=result.shapeAnalysis[key], span=result.params.sliceThicknessMm<=1?1.5:Math.max(4,result.params.sliceThicknessMm*.8);
  SSPZShapeDisplay.draw(canvas,[{name:key==='on'?'Cone geometry':'Parallel reference',rgb:key==='on'?[1,0,0]:[1,1,1],analysis:a}],{
    title:key==='on'?'Fan-beam cone geometry':'Parallel reference',panel:key==='on'?'(b)':'(a)',span
  });
  const counts=Object.values(result.shapeAnalysis).map(v=>v.valid.length).join(' / ');
  const outside=Object.values(result.shapeAnalysis).reduce((sum,v)=>sum+v.outside.reduce((n,x)=>n+x,0),0);
  document.querySelector('#shape-status').textContent=localizedText(`採用状態数（左／右）：${counts}。表示偏差範囲外：${outside}点（Excelの偏差には全値を保存）。`,`Included states (left/right): ${counts}. Outside deviation range: ${outside} samples (all deviations retained in Excel).`);
}

async function downloadAllProfilesExcel() {
  if(!lastResult?.shapeAnalysis)return;
  const button=document.querySelector('#download-excel-button');button.disabled=true;
  const captured=lastResult;
  try {
    document.querySelector('#shape-status').textContent=localizedText('全状態のExcelファイルを作成中…','Preparing all-state Excel workbook…');
    await new Promise(resolve=>setTimeout(resolve,30));
    const blob=await SSPZShape.workbook(captured,captured.shapeAnalysis,MODEL_VERSION);
    downloadBlob('SSPz_all_states.xlsx',blob);
    document.querySelector('#shape-status').textContent=localizedText('Excelファイルを出力しました。曲線・平均・偏差・計算条件を収録しています。','Excel exported: profiles, means, deviations and calculation settings.');
  } catch(error){document.querySelector('#shape-status').textContent=error.message;}
  finally{button.disabled=false;}
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
  const header = ["model_version","reconstruction_path","profile_mode","filter_width_mm","filter_resampling_count","requested_minimum_filter_resampling_count","reference_slice_thickness_mm","filter_width_calibration","response_coordinate","direct_view_samples_per_rotation","model_state_index","object_position_fraction_within_one_table_feed","object_z_mm","idealized_source_to_point_distance_scaling","local_FW0_bracket_gap_mean_mm","local_FW0_bracket_gap_max_mm","local_FW0_bracket_gap_ratio_max","pre_normalization_area","pre_normalization_peak","filtered_fwhm_mm","filtered_fwtm_mm","filtered_sigma_mm","coverage","profile_area_mm","centroid_mm","half_height_component_count"];
  const rows = lastResult.sweep.map(row => [MODEL_VERSION,row.reconstructionPath ?? lastResult.params.reconstructionPath,lastResult.params.profileMode,lastResult.params.filterWidthMm,lastResult.selectedOn.filterSamples,lastResult.params.filterSamples,lastResult.params.sliceThicknessMm,"not-scanner-calibrated","reconstruction-plane-minus-fixed-object-mm",lastResult.params.viewSamples,row.stateIndex,row.state,row.z0,row.coneOn,row.bracketGapMeanMm,row.bracketGapMaxMm,row.bracketGapRatioMax,row.preNormalizationArea,row.preNormalizationPeak,row.fwhm,row.fwtm,row.sigma,row.coverage,row.area,row.centroid,row.halfComponents]);
  const csv = [header, ...rows].map(row => row.map(csvEscape).join(",")).join("\n");
  downloadBlob(`sspz_${reconstructionPathUrlValue(lastResult.params.reconstructionPath)}_geometry_state_sweep.csv`, `\uFEFF${csv}`);
}

function downloadProfileCsv() {
  if (!lastResult) return;
  const rows = [["model_version","reconstruction_path","profile_mode","filter_width_mm","filter_resampling_count","requested_minimum_filter_resampling_count","reference_slice_thickness_mm","model_state_index","reconstruction_plane_minus_fixed_object_mm","filtered_sspz_distance_change_off","filtered_sspz_distance_change_on"]];
  const length = Math.min(lastResult.selectedOff.z.length, lastResult.selectedOn.z.length);
  for (let i = 0; i < length; i += 1) {
    rows.push([MODEL_VERSION,lastResult.params.reconstructionPath,lastResult.params.profileMode,lastResult.params.filterWidthMm,lastResult.selectedOn.filterSamples,lastResult.params.filterSamples,lastResult.params.sliceThicknessMm,selectedStateIndex,lastResult.selectedOff.z[i],lastResult.selectedOff.profile[i],lastResult.selectedOn.profile[i]]);
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
  if (canvasId.startsWith('shape-deviation-')) {
    drawShapeDeviation(canvas, result, canvasId.endsWith('-on') ? 'on' : 'off'); return;
  }
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
  throw new Error(`未対応の図IDです: ${canvasId}`);
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
    filename = `sweep-taguchi-${metric.rawKey}-FW${lastResult.params.filterWidthMm}mm-K${lastResult.selectedOn.filterSamples}-T${thickness}mm-r${radius}mm.png`;
  } else if (canvasId.startsWith("overlay-") && lastResult) {
    const [, viewMode, condition] = canvasId.split("-");
    const thickness = String(Number(lastResult.params.sliceThicknessMm)).replace(".", "p");
    const radius = String(Number(lastResult.params.radius)).replace(".", "p");
    filename = `sspz-overlay-taguchi-${viewMode}-FW${lastResult.params.filterWidthMm}mm-K${lastResult.selectedOn.filterSamples}-T${thickness}mm-r${radius}mm-${condition}-360-object-states.png`;
  } else if (canvasId === "candidate-axial-spread-chart" && lastResult) {
    const rows = String(Number(lastResult.params.rows));
    const rowWidth = String(Number(lastResult.params.rowWidth)).replace(".", "p");
    const pitch = String(Number(lastResult.params.beamPitch)).replace(".", "p");
    const radius = String(Number(lastResult.params.radius)).replace(".", "p");
    filename = `geometry-all-candidate-axial-spread-N${rows}-d${rowWidth}mm-p${pitch}-r${radius}mm-${lastResult.params.viewSamples}views.png`;
  } else if (canvasId === "profile-chart" && lastResult) {
    filename = `sspz-taguchi-FW${lastResult.params.filterWidthMm}mm-K${lastResult.selectedOn.filterSamples}-T${lastResult.params.sliceThicknessMm}mm-state-${selectedStateIndex}-of-360.png`;
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
    target.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNGの生成に失敗しました。")), "image/png");
  });
  const publicationBlob = await pngWithResolution(rawBlob, PUBLICATION_DPI);
  downloadBlob(publicationFilename(canvasId), publicationBlob, "image/png");
  status.textContent = `${publicationWidthMm(canvasId)} mm幅・${PUBLICATION_DPI} dpiの投稿用PNGを保存しました（${target.width}×${target.height} px）`;
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
  try { await navigator.clipboard.writeText(url); status.textContent = "条件URLをコピーしました"; }
  catch { window.prompt("このURLをコピーしてください", url); }
});
form.addEventListener("input", () => {
  updateInputDecorations();
  if (!runButton.disabled) status.textContent = "条件が変更されました。計算するを押してください。";
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
  status.textContent = "横断面内位置を変更しました。計算するを押してください。";
}));
document.querySelectorAll("[data-canvas]").forEach(button => button.addEventListener("click", () => downloadCanvas(button.dataset.canvas)));
downloadCsvButton.addEventListener("click", downloadSweepCsv);
downloadProfileButton.addEventListener("click", downloadProfileCsv);
document.querySelector('#download-excel-button').addEventListener('click',downloadAllProfilesExcel);
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
      stored.sliceThicknessMm = stored.targetFwhm;
    }
    if (stored.filterWidthMm == null || stored.profileMode !== "taguchi-filter") {
      legacyInputMigrated = true;
      stored.filterWidthMm ??= stored.sliceThicknessMm ?? DEFAULT_PARAMS.sliceThicknessMm;
      stored.filterSamples ??= DEFAULT_PARAMS.filterSamples;
      stored.profileMode = "taguchi-filter";
    }
    return {...stored,zFfsEnabled:false};
  }
  catch { return DEFAULT_PARAMS; }
})();
if(initial!==DEFAULT_PARAMS && (initial.thicknessMapping!=='configured-rectangular' || initial.detectorModel!=='finite-channel'))legacyInputMigrated=true;
// Old saved 3D conditions used channelWidth for both physical aperture and pitch.
if(initial!==DEFAULT_PARAMS && initial.channelApertureMm==null)initial.channelApertureMm=initial.channelWidth??DEFAULT_PARAMS.channelApertureMm;
writeParams({ ...DEFAULT_PARAMS, ...initial, filterWidthMm:initial.sliceThicknessMm??DEFAULT_PARAMS.sliceThicknessMm, thicknessMapping:'configured-rectangular' });
if (legacyUrlNote) {
  legacyUrlNote.hidden = !legacyInputMigrated;
  if (legacyInputMigrated) legacyUrlNote.textContent = localizedText("両モデルに共通の面内有限開口を導入しました。旧条件は共通開口で再計算されるため、従来の体軸補間モデルと結果が異なります。設定厚Tは平均化幅として使用します。", "A shared finite transaxial aperture now applies to both models. Older settings are recalculated with this aperture and differ from the former axial-only response. Configured thickness T sets the averaging width.");
}
initializeFdkUi(initial);
runSimulation();

})();
