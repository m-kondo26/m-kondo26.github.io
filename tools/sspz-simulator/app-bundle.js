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

const FINITE_FOCUS_VERSION='2026-09-18.1';
// Effective axial focal width at the source, not the physical target length.
// The source-detector distance belongs to the fixed detector geometry. With
// z-FFS, its existing magnification defines that same physical distance.
function finiteFocusConfig(input,c){
  c.focalSizeMm=Number(input.focalSizeMm??0);
  c.focalSourceDetectorMm=Number(input.focalSourceDetectorMm??(c.zFfsEnabled?c.zFfsSourceDetectorMm:1070));
  if(!Number.isFinite(c.focalSizeMm)||c.focalSizeMm<0)throw Error('FOCAL_SIZE: effective axial focal width must be finite and >= 0 mm');
  if(!Number.isFinite(c.focalSourceDetectorMm)||c.focalSourceDetectorMm<=0)throw Error('FOCAL_GEOMETRY: source-detector distance must be finite and > 0 mm');
  if(c.zFfsEnabled){
    if(c.focalSizeMm>0&&input.focalSourceDetectorMm!=null&&Math.abs(c.focalSourceDetectorMm-c.zFfsSourceDetectorMm)>1e-9*Math.max(1,c.focalSourceDetectorMm))throw Error('FOCAL_GEOMETRY: focal source-detector distance conflicts with z-FFS detector magnification');
    c.focalSourceDetectorMm=c.zFfsSourceDetectorMm;
  }
  if(c.focalSizeMm>0&&c.focalSourceDetectorMm<=c.sourceRadius+c.radius)throw Error('FOCAL_GEOMETRY: detector must lie beyond the evaluation point for every view');
  return c;
}
function focalBlurWidth(c,L=c.sourceRadius){
  return (c.focalSizeMm??0)*Math.abs(1-L/(c.zFfsEnabled?c.zFfsSourceDetectorMm:(c.focalSourceDetectorMm??1070)));
}
function focalBlurMetadata(c){
  return {version:FINITE_FOCUS_VERSION,kind:c.focalSizeMm>0?'uniform-effective-axial-source':'point-source',
    focalSizeMm:c.focalSizeMm??0,sourceDetectorMm:c.zFfsEnabled?c.zFfsSourceDetectorMm:(c.focalSourceDetectorMm??1070),
    distribution:'unit-integral uniform axial source; fixed total exposure',
    integration:'exact source intervals within each acquired detector cell, with ray Jacobian',
    candidateGeometry:'mean focal position; candidate centres and interpolation coefficients unchanged',
    parallelReference:'same isocentre-projected axial blur, fixed with position and angle; no divergent-ray Jacobian',
    targetAngle:'effective focal width is already projected; no additional target-angle factor',
    scope:'axial finite-focus acquisition only; no transverse focal blur, heel effect or direction-dependent apparent focal shape'};
}
// Stable average of sqrt(R^2+w^2) over a linear w interval. This is the exact
// antiderivative difference, with asinh(b)-asinh(a) expressed via atanh to
// avoid cancellation for short intervals near the central ray.
function meanRayLength(R,a,b){
  const h0=Math.hypot(R,a),h1=Math.hypot(R,b),sum=h0+h1,q=(b-a)/sum;
  return .5*(h1+a*(a+b)/sum+2*R*R/sum*(q===0?1:Math.atanh(q)/q));
}
// Integrate a single physical exposure over its finite axial focal support.
// w0 is its mean-focus coordinate on the FIXED detector; wRay0 is relative
// to that mean focus. The two coordinates differ for z-FFS. The returned
// signal is already averaged over source emission; no new views are added.
function detectorAxialFocusRows(c,w0,wRay0,L,parallel=false){
  const f=c.focalSizeMm??0,R=c.sourceRadius,d=c.rowWidth;
  const aperture=c.channelApertureMm??c.channelWidth;
  const D=c.zFfsEnabled?c.zFfsSourceDetectorMm:(c.focalSourceDetectorMm??1070);
  const slope=R/D-R/L,raySlope=-R/L;
  const scale=parallel?1/(aperture*d):1/(L*L*(aperture/R)*d);
  if(!(f>0)){
    const signal=parallel?scale:scale*Math.hypot(R,wRay0);
    return detectorCellMembership(w0,d,d,c.rows).map(([row,weight])=>[row,signal*weight]);
  }
  const half=f/2,loW=w0-Math.abs(slope)*half,hiW=w0+Math.abs(slope)*half;
  const k0=Math.max(0,Math.ceil(loW/d+(c.rows-1)/2-.5));
  const k1=Math.min(c.rows-1,Math.floor(hiW/d+(c.rows-1)/2+.5));
  const out=[];
  for(let row=k0;row<=k1;row++){
    const centre=(row-(c.rows-1)/2)*d;
    let lo=-half,hi=half;
    if(slope===0){
      const membership=detectorCellMembership(w0,d,d,c.rows).find(q=>q[0]===row)?.[1]??0;
      if(membership)out.push([row,scale*(parallel?1:meanRayLength(R,wRay0+raySlope*lo,wRay0+raySlope*hi))*membership]);
      continue;
    }
    const a=(centre-d/2-w0)/slope,b=(centre+d/2-w0)/slope;
    lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));
    if(!(hi>lo))continue;
    const ray=parallel?1:meanRayLength(R,wRay0+raySlope*lo,wRay0+raySlope*hi);
    out.push([row,(hi-lo)/f*scale*ray]);
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
  if(c.focalSizeMm>0){
    const ks=detectorAxialFocusRows(c,w,w,L,parallel);
    const empty={j0:0,j1:-1,k0:0,k1:-1,width:0,height:0,data:new Float64Array(0),transverse,w};
    if(!js.length||!ks.length)return empty;
    const j0=js[0][0],j1=js.at(-1)[0],k0=ks[0][0],k1=ks.at(-1)[0];
    const width=j1-j0+1,height=k1-k0+1,data=new Float64Array(width*height);
    for(const [j,a] of js)for(const [k,signal] of ks)data[(k-k0)*width+j-j0]=signal*a;
    return {j0,j1,k0,k1,width,height,data,transverse,w};
  }
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

const CBA_TAU=2*Math.PI;
function cbaCoordinates(c,theta,x,y,z){
  const t=-x*Math.sin(theta)+y*Math.cos(theta),along=x*Math.cos(theta)+y*Math.sin(theta);
  const gamma=Math.asin(t/c.sourceRadius),beta=theta+gamma;
  const L=Math.sqrt(c.sourceRadius*c.sourceRadius-t*t)-along;
  const sourceZ=c.feed*(beta-c.phase)/CBA_TAU,w=c.sourceRadius*(z-sourceZ)/L;
  const row=w/c.rowWidth+(c.rows-1)/2,n=Math.floor(row);
  return {t,along,gamma,beta,L,sourceZ,w,n,delta:row-n};
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

// Display-only audit. Reuse the numerical model's candidate selectors and
// piecewise-linear T integral; never reconstruct a substitute SSP for playback.
function axialAnimationGroups(c,view){
  const V=c.viewSamples,groups=[];
  for(let direction=0;direction<2;direction++){
    const v=view+direction*V/2,theta=c.phase+v*(2*Math.PI/V);
    const q=c.axialRule==='parallel'?{sourceZ:c.feed*v/V,L:c.sourceRadius}:cbaCoordinates(c,theta,c.radius,0,0);
    for(let focus=0;focus<(c.zFfsEnabled?2:1);focus++){
      const origin=q.sourceZ+(c.zFfsEnabled?zffsShift(c,focus)*(1-q.L/c.zFfsSourceDetectorMm):0);
      groups.push({...q,origin,sourceZ:origin,spacing:c.rowWidth*q.L/c.sourceRadius,view:v,focus,direction});
    }
  }
  return groups;
}


const SSPZTaguchi=(()=>{
// Central-axis HFI coefficient response, independent of the SSPz point model.
// Taguchi & Aradate (1998), Eq. (6) and Appendix A1–A5: integrate the
// piecewise-linear interpolant through a rectangular axial filter.
// Ichikawa et al. (2015), p.376: sum row coefficients at their original times.
//
// Scope: four uniform rows, gamma=0, a continuous helix and all equivalent
// direct/complementary ray copies. This explicit candidate convention is NOT
// a verified reproduction of Aquilion's acquisition selection: Fig.5(d)'s
// detailed shape remains discrepant. Never replace this with a fitted curve.

const TAGUCHI_TSP_VERSION = '2026-09-25.1';

function finiteValue(value, fallback, name, lower, upper) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < lower || number > upper) {
    throw new RangeError(`${name} must be between ${lower} and ${upper}.`);
  }
  return number;
}

function configuration(input = {}) {
  const rows = finiteValue(input.rows, 4, 'rows', 4, 4);
  if (input.radius != null && Number(input.radius) !== 0) {
    throw new RangeError('This HFI reference is defined only at radius = 0.');
  }
  const rowWidth = finiteValue(input.rowWidth, 2, 'rowWidth', 0.05, 20);
  const beamPitch = finiteValue(input.beamPitch, 0.625, 'beamPitch', 0.05, 3);
  const filterWidthMm = finiteValue(input.filterWidthMm, 2, 'filterWidthMm', 0, 40);
  const rotationTime = finiteValue(input.rotationTime, 1, 'rotationTime', 0.05, 5);
  const viewSamples = finiteValue(input.viewSamples, 7200, 'viewSamples', 16, 28800);
  if (!Number.isInteger(viewSamples)) throw new RangeError('viewSamples must be an integer.');
  return {
    rows, rowWidth, beamPitch, filterWidthMm, rotationTime, viewSamples,
    radius: 0, channelAngleRadians: 0, tableFeedPerRotationMm: rows * rowWidth * beamPitch,
    rowPitch: rows * beamPitch, filterShape: 'rectangular',
    temporalGridMeaning: 'numerical evaluation samples per rotation; not acquired view count',
    candidateRule: 'all-equivalent-rays-on-continuous-helix',
    coincidentRule: 'equal-average-of-coincident-acquisitions',
  };
}

// Merge coincident z knots before interpolation. Equal averaging shares a
// knot's coefficient across the ORIGINAL acquisitions, retaining their times.
// Eq.(6) assumes distinct neighbors; this tie convention is stated explicitly.
function mergedKnots(config, phaseTurns, halfCopies) {
  const points = [];
  const feed = config.tableFeedPerRotationMm;
  const tolerance = 1e-10 * config.rowWidth;
  for (let halfTurn = -halfCopies; halfTurn <= halfCopies; halfTurn += 1) {
    for (let row = 0; row < config.rows; row += 1) {
      const timeTurns = phaseTurns + halfTurn / 2;
      points.push({
        z: feed * timeTurns + (row + 0.5 - config.rows / 2) * config.rowWidth,
        row, halfTurn, timeTurns,
      });
    }
  }
  points.sort((a, b) => a.z - b.z || a.timeTurns - b.timeTurns || a.row - b.row);
  const knots = [];
  for (const point of points) {
    const previous = knots[knots.length - 1];
    if (previous && Math.abs(point.z - previous.z) <= tolerance) previous.acquisitions.push(point);
    else knots.push({z: point.z, acquisitions: [point]});
  }
  return knots;
}

// Integral of the cardinal, piecewise-linear basis centered at b, clipped to
// the filter. This is the rectangular direct-filtering Appendix in one form.
function basisAverage(a, b, c, filterWidth) {
  if (filterWidth === 0) {
    if (0 < a || 0 > c) return 0;
    return 0 <= b ? (0 - a) / (b - a) : (c - 0) / (c - b);
  }
  const lower = -filterWidth / 2;
  const upper = filterWidth / 2;
  let integral = 0;
  let left = Math.max(a, lower);
  let right = Math.min(b, upper);
  if (right > left) integral += (right - left) * ((left - a) + (right - a)) / (2 * (b - a));
  left = Math.max(b, lower);
  right = Math.min(c, upper);
  if (right > left) integral += (right - left) * ((c - left) + (c - right)) / (2 * (c - b));
  return integral / filterWidth;
}

function directRowBasis(config) {
  const rowSpan = (config.rows - 1) * config.rowWidth;
  // Every row at halfTurn=0 has both neighbors well inside this superset.
  const copies = Math.ceil(2 * rowSpan / config.tableFeedPerRotationMm) + 3;
  const knots = mergedKnots(config, 0, copies);
  const basis = [];
  for (let j = 1; j < knots.length - 1; j += 1) {
    for (const acquisition of knots[j].acquisitions) {
      if (acquisition.halfTurn === 0) basis.push({
        row: acquisition.row, a: knots[j - 1].z, b: knots[j].z, c: knots[j + 1].z,
        share: 1 / knots[j].acquisitions.length,
      });
    }
  }
  if (basis.length !== config.rows) throw new Error('HFI candidate enumeration lost a detector row.');
  return basis.sort((a, b) => a.row - b.row);
}

// Exposed for audit/teaching: one oriented-ray family after rectangular HFI.
// Nonzero coefficients sum to one; temporal coefficients are not normalized
// per acquisition time or multiplied by a stationary-object detector signal.
function taguchiHfiWeightsAtPhase(input = {}, phaseTurns = 0) {
  const config = configuration(input);
  if (!Number.isFinite(phaseTurns)) throw new RangeError('phaseTurns must be finite.');
  const feed = config.tableFeedPerRotationMm;
  const span = config.filterWidthMm / 2 + (config.rows - 1) * config.rowWidth / 2;
  const copies = Math.ceil(2 * (span / feed + Math.abs(phaseTurns))) + 4;
  const knots = mergedKnots(config, phaseTurns, copies);
  const records = [];
  for (let j = 1; j < knots.length - 1; j += 1) {
    const coefficient = basisAverage(knots[j - 1].z, knots[j].z, knots[j + 1].z, config.filterWidthMm);
    if (!(coefficient > 0)) continue;
    const weight = coefficient / knots[j].acquisitions.length;
    for (const acquisition of knots[j].acquisitions) records.push({
      row: acquisition.row, halfTurn: acquisition.halfTurn,
      timeTurns: acquisition.timeTurns, zMm: acquisition.z, weight,
      coincidentAcquisitions: knots[j].acquisitions.length,
    });
  }
  records.sort((a, b) => a.timeTurns - b.timeTurns || a.row - b.row);
  return {config, records, sum: records.reduce((sum, record) => sum + record.weight, 0)};
}

function thresholdWidth(times, values, fraction) {
  const epsilon = 1e-12;
  let first = -1;
  let last = -1;
  let intervals = 0;
  let within = false;
  let thresholdPlateau = false;
  for (let i = 0; i < values.length; i += 1) {
    const above = values[i] >= fraction - epsilon;
    if (above) {
      if (first < 0) first = i;
      last = i;
      if (!within) intervals += 1;
    }
    if (i > 0 && Math.abs(values[i] - fraction) <= epsilon && Math.abs(values[i - 1] - fraction) <= epsilon) {
      thresholdPlateau = true;
    }
    within = above;
  }
  if (first < 0 || first === 0 || last === values.length - 1) return {width: null, envelopeWidth: null, intervals, reason: 'unbounded-or-missing-crossing'};
  const crossing = (a, b) => {
    const slope = values[b] - values[a];
    if (Math.abs(slope) < epsilon) return (times[a] + times[b]) / 2;
    return times[a] + (times[b] - times[a]) * (fraction - values[a]) / slope;
  };
  const lower = crossing(first - 1, first);
  const upper = crossing(last, last + 1);
  const reason = intervals > 1 ? 'disconnected-threshold-intervals'
    : thresholdPlateau ? 'plateau-at-threshold' : null;
  return {width: reason ? null : upper - lower, envelopeWidth: upper - lower, lower, upper, intervals, reason};
}

function computeTaguchiTsp(input = {}) {
  const config = configuration(input);
  const basis = directRowBasis(config);
  const feed = config.tableFeedPerRotationMm;
  const width = config.filterWidthMm;
  const maxZ = Math.max(...basis.map(row => Math.max(Math.abs(row.a), Math.abs(row.c))));
  const supportTurns = (maxZ + width / 2) / feed;
  // Preserve the full helix. +/- one rotation was Ichikawa's example grid,
  // not a universal acquisition boundary for arbitrary pitch/filter width.
  const halfSamples = Math.ceil(supportTurns * config.viewSamples) + 2;
  const timeTurns = new Float64Array(2 * halfSamples + 1);
  const raw = new Float64Array(timeTurns.length);
  let peak = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const time = (i - halfSamples) / config.viewSamples;
    timeTurns[i] = time;
    const shift = feed * time;
    for (const row of basis) raw[i] += row.share * basisAverage(row.a + shift, row.b + shift, row.c + shift, width);
    peak = Math.max(peak, raw[i]);
  }
  if (!(peak > 0)) throw new Error('HFI produced no positive coefficients.');
  const profile = Float64Array.from(raw, value => value / peak);
  const fwhm = thresholdWidth(timeTurns, profile, 0.5);
  const fwtm = thresholdWidth(timeTurns, profile, 0.1);
  let rawArea = 0;
  for (let i = 1; i < raw.length; i += 1) rawArea += (raw[i - 1] + raw[i]) / (2 * config.viewSamples);
  const equivalentWidthTurns = rawArea / peak;
  const msPerTurn = 1000 * config.rotationTime;
  const weights = taguchiHfiWeightsAtPhase(config, 0.137);
  return {
    version: TAGUCHI_TSP_VERSION, method: 'taguchi-hfi-central-axis-reference',
    config, timeTurns, raw, profile,
    metrics: {
      fwhmTurns: fwhm.width, fwtmTurns: fwtm.width, equivalentWidthTurns,
      fwhmMs: fwhm.width == null ? null : fwhm.width * msPerTurn,
      fwtmMs: fwtm.width == null ? null : fwtm.width * msPerTurn,
      equivalentWidthMs: equivalentWidthTurns * msPerTurn,
      fwhmIntervals: fwhm.intervals, fwtmIntervals: fwtm.intervals,
      fwhmReason: fwhm.reason, fwtmReason: fwtm.reason,
      fwhmEnvelopeTurns: fwhm.envelopeWidth, fwtmEnvelopeTurns: fwtm.envelopeWidth,
      widthDefinition: 'interpolated threshold crossings; null for disconnected intervals or a plateau at the threshold; enclosing extent retained separately',
      equivalentWidthDefinition: 'trapezoidal integral of peak-normalized continuous-time coefficient curve',
    },
    audit: {
      rawPeak: peak, rawAreaTurns: rawArea, expectedRawAreaTurns: 0.5,
      rawAreaErrorTurns: rawArea - 0.5,
      sampleStepTurns: 1 / config.viewSamples, supportTurns,
      endpointRaw: [raw[0], raw[raw.length - 1]],
      partitionAtPhase0137: weights.sum,
      directRowBasis: basis,
    },
    provenance: {
      primaryMethod: 'Taguchi K, Aradate H. Medical Physics 25 (1998) 550-561. Eq.(6), Appendix A1-A5.',
      primaryMethodDoi: '10.1118/1.598230',
      temporalAggregation: 'Ichikawa et al. Physica Medica 31 (2015) 374-381, p.376 steps 1-5.',
      temporalAggregationDoi: '10.1016/j.ejmp.2015.02.012',
      timeOrigin: 'tube central plane crosses reconstructed z=0 at t/Trot=0',
      input: 'simultaneous unit temporal signal to every row; interpolation coefficients only',
      scope: 'central channel at rotation center; rectangular HFI on a continuous helix; no object point-signal factor, FBP, cone correction, or scanner measurement',
      acquisitionSelection: config.candidateRule,
      coincidentData: 'Equal-average coincident z knots, dividing their weight among distinct original acquisition times. This is an explicit implementation convention.',
      fig5Reproduction: 'not-established: the all-equivalent-ray convention differs from the detailed shape of Ichikawa Fig.5(d); no fit to published widths',
    },
  };
}

return {computeTaguchiTsp};})();

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
    const name={'axial-merged':'Merged axial','axial-rri':'Cone geometry','axial-parallel':'Parallel reference',rri:'RRI'}[result.model?.kind]??'FDK';
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

// The normal workflow uses cone geometry. Keep the hidden select as the
// existing parameter bridge so reset and shared-condition controls still work.
function initializeAxialModelChoice(initial = 'fdk', changed) {
  const element = document.createElement('fieldset');
  element.className = 'model-choice';
  const legend = document.createElement('legend');
  legend.textContent = fdkText('評価位置によって、データの並びはどう変わる？', 'How does evaluation position change the data arrangement?');
  const select = document.createElement('select');
  select.id = 'computationModel';
  select.name = 'computationModel';
  select.hidden = true;
  select.add(new Option(fdkText('コーン幾何', 'Cone geometry'), 'fdk'));

  const introduction = document.createElement('div');
  introduction.className = 'model-choice-introduction';
  const chip = document.createElement('span');
  chip.className = 'model-choice-chip';
  chip.textContent = fdkText('コーン幾何で計算', 'Calculated with cone geometry');
  const scope = document.createElement('p');
  scope.className = 'model-choice-scope';
  scope.textContent = fdkText('回転中心からの評価位置 r を動かすと、その位置を通るX線と検出器列の関係が変わります。同じ撮影条件のまま、展開図の配置とSSPzへの現れ方を確認します。r はFOV内で調べる点の位置で、表示するFOVの大きさではありません。', 'Moving the evaluation position r away from the rotation centre changes how rays and detector rows intersect that position. Keep the acquisition settings fixed and inspect the arrangement in the unwrapped diagram and its effect on SSPz. Here r locates the point within the FOV; it is not the displayed FOV size.');
  introduction.append(chip, scope);

  const steps = document.createElement('ol');
  steps.className = 'model-choice-reading-steps';
  for (const [title, description] of [
    [
      fdkText('評価位置を動かす', 'Move the evaluation position'),
      fdkText('r = 0 mm が回転中心です。周辺へ動かすと、方向ごとの列間隔や実・対向データの位置関係が変わります。', 'r = 0 mm is the rotation centre. Moving towards the periphery changes row spacing and the relation between direct and opposing data in each direction.'),
    ],
    [
      fdkText('展開図で配置と重みを読む', 'Read positions and weights in the diagram'),
      fdkText('同じ開始角度で、列の軌跡、目的断面の前後で補間に使う点、その重みを確認します。', 'At the same start angle, inspect the row trajectories, the samples used around the target plane and their interpolation weights.'),
    ],
    [
      fdkText('SSPzへの現れ方を見る', 'Inspect the resulting SSPz'),
      fdkText('同じ位置のSSPzを確認します。配置が変わっても、補間・平均後の形状や幅が同じ程度に変わるとは限りません。', 'Inspect SSPz at that position. A change in arrangement need not produce a comparable change in profile shape or width after interpolation and averaging.'),
    ],
  ]) {
    const step = document.createElement('li');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const text = document.createElement('p');
    text.textContent = description;
    step.append(heading, text);
    steps.append(step);
  }

  const geometry = document.createElement('p');
  geometry.className = 'model-choice-geometry';
  const geometryTitle = document.createElement('strong');
  geometryTitle.textContent = fdkText('展開図の幾何：', 'Diagram geometry: ');
  geometry.append(geometryTitle, document.createTextNode(fdkText('面内はファンパラ変換後の方向で整理し、体軸方向はコーン角による広がりを反映します。ファンパラ変換をしても、体軸方向の広がりは残ります。', 'Transverse rays are organized by their directions after fan-to-parallel rebinning; axial divergence from the cone angle is retained. Fan-to-parallel rebinning does not remove axial divergence.')));

  const details = document.createElement('details');
  details.className = 'model-choice-notes';
  const summary = document.createElement('summary');
  summary.textContent = fdkText('展開図の読み方・補間方法と根拠', 'Diagram key, interpolation and sources');
  const diagramKey = document.createElement('p');
  diagramKey.textContent = fdkText('実・対向データを重ねる展開図は、横軸が体軸位置 z (mm)、縦軸が補間対象方向（上から下へ0～360°）です。色は検出器列、実線・○は実データ側、破線・△は対向データ側を示します。重み付きの点では、塗りの濃さが補間重み w を表します。', 'The paired unwrapped diagram uses axial position z (mm) horizontally and output interpolation direction vertically (0–360° from top to bottom). Colour identifies detector rows. Solid lines and circles show direct data; dashed lines and triangles show opposing data. For weighted markers, fill intensity represents interpolation weight w.');
  const searchRange = document.createElement('div');
  searchRange.className = 'model-choice-range';
  const rangeTable = document.createElement('table');
  rangeTable.createCaption().textContent = fdkText('補間候補の範囲', 'Interpolation candidate support');
  const headRow = rangeTable.createTHead().insertRow();
  for (const text of [fdkText('範囲', 'Range'), fdkText('現在の定義と根拠', 'Current definition and basis')]) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = text;
    headRow.append(cell);
  }
  const rangeBody = rangeTable.createTBody();
  for (const entry of [
    {
      title: fdkText('重みを付ける列の範囲', 'Rows receiving weight'),
      definition: fdkText('実・対向それぞれで、目的断面に隣接する列を線形補間します（RRI相当）。対象位置・方向ごとの列間隔 s より近い列に重みが付きます。点数は常に4点とは限りません。', 'Linearly interpolate adjacent rows around the target plane on each direct and opposing side (RRI-equivalent). Rows closer than the local spacing s receive weight; s varies with position and direction. The number of points is not always four.'),
      source: fdkText('Hsiehら（2007）：p.067001-2、図5・式(6)', 'Hsieh et al. (2007): p.067001-2, Fig.5 and Eq.(6)'),
      href: 'https://doi.org/10.1117/1.2746866',
    },
    {
      title: fdkText('探索する取得角度の範囲', 'Acquired angles searched'),
      definition: fdkText('360°＋全ファン角の2倍。古典的な対向ビーム補間を参照して採用した範囲です。全ファン角50°なら460°です。', '360° plus twice the full fan opening, adopted with reference to classical opposing-beam interpolation. A 50° full opening gives 460°.'),
      source: fdkText('Toki：EP0450152B1、図4～6・図10B', 'Toki: EP0450152B1, Figs.4–6 and 10B'),
      href: 'https://patents.google.com/patent/EP0450152B1/en',
    },
  ]) {
    const row = rangeBody.insertRow();
    const title = document.createElement('th');
    title.scope = 'row';
    title.textContent = entry.title;
    row.append(title);
    const cell = row.insertCell();
    const definition = document.createElement('p');
    definition.textContent = entry.definition;
    const source = document.createElement('a');
    source.href = entry.href;
    source.textContent = entry.source;
    cell.append(definition, source);
  }
  searchRange.append(rangeTable);
  const limits = document.createElement('p');
  limits.textContent = fdkText('設定スライス厚 T は平均する幅であり、候補を探す距離の上限ではありません。検出器端では存在する列の重みを正規化し、重みが付く列がなければ支持不足として停止します。取得角度範囲の多列への適用、検出器端や複数回転の重みの正規化は本モデルで採用した定義です。これは体軸方向の応答モデルであり、画像再構成は行いません。', 'Slice thickness T specifies the averaging width, not a candidate-distance limit. Available detector-edge rows are normalized; if none receives weight, calculation stops for insufficient support. Applying this angular interval to multiple rows and normalizing detector-edge and multiple-turn weights are definitions adopted by this model. This is an axial response model without image reconstruction.');
  const sourceLink = document.createElement('a');
  sourceLink.href = fdkText('methods.html?topic=axial&lang=ja#rri-search-basis', 'methods.html?topic=axial&lang=en#rri-search-basis');
  sourceLink.textContent = fdkText('根拠文献・式・適用範囲', 'Sources, equations and applicability');
  details.append(summary, diagramKey, searchRange, limits, sourceLink);

  function sync() {
    // Old saved conditions can still request a removed model. The UI and
    // parameter bridge always represent the cone-geometry workflow.
    select.value = 'fdk';
    element.dataset.model = 'fdk';
  }
  select.addEventListener('change', () => {
    sync();
    if (typeof changed === 'function') changed('fdk');
  });
  element.append(legend, select, introduction, steps, geometry, details);
  sync();
  return {element, select, sync};
}

// Drawing order only: each row trajectory retains its original coordinates.
// Both roles of the same datum use the same unwrapped source angle beta.
globalThis.SSPZConstruction=Object.freeze({
  window(scene,xLimit){
    let lo=Infinity,hi=-Infinity;
    for(const t of scene.traceFamilies)for(const turn of scene.traceGeometry.turns){
      for(const offset of scene.traceGeometry.rowOffsets){
        for(let i=1;i<t.angles.length;i++){
          const a=t.axial[i-1]+turn*scene.traceGeometry.feed+t.scales[i-1]*offset-scene.z0;
          const b=t.axial[i]+turn*scene.traceGeometry.feed+t.scales[i]*offset-scene.z0;
          let u=0,v=1;
          if(a===b){if(Math.abs(a)>xLimit)continue;}
          else {const q=(-xLimit-a)/(b-a),r=(xLimit-a)/(b-a);u=Math.max(0,Math.min(q,r));v=Math.min(1,Math.max(q,r));if(u>v)continue;}
          const beta=t.sourceAngles[i-1]+turn*2*Math.PI,db=t.sourceAngles[i]-t.sourceAngles[i-1];
          lo=Math.min(lo,beta+u*db);hi=Math.max(hi,beta+v*db);
        }
      }
    }
    // Zero refers to the direct/output direction of the diagram, not a new source
    // phase. Its beta includes the fan-angle offset and repeats each turn.
    const phase=scene.traceFamilies.find(t=>t.family==='direct')?.sourceAngles[0]??scene.sourcePhase??0,tau=2*Math.PI;
    if(!Number.isFinite(lo))return {start:phase,end:phase+tau,turns:1};
    // Begin at diagram angle zero, outside the left plot edge.
    const start=phase+Math.floor((lo-phase)/tau-1e-10)*tau;
    const end=phase+Math.ceil((hi-phase)/tau+1e-10)*tau;
    return {start,end,turns:(end-start)/tau};
  },
  prefix(trace,turn,cutoff){
    const t=cutoff-turn*2*Math.PI,beta=trace.sourceAngles,n=beta.length;
    if(t>=beta[n-1])return trace;
    if(t<beta[0])return {...trace,angles:[],axial:[],scales:[],sourceAngles:[]};
    let lo=0,hi=n-1;
    while(lo+1<hi){const m=(lo+hi)>>1;if(beta[m]<=t)lo=m;else hi=m;}
    const f=(t-beta[lo])/(beta[hi]-beta[lo]),out={...trace,frontier:true};
    for(const k of ['angles','axial','scales','sourceAngles']){
      out[k]=Array.from(trace[k].slice(0,lo+1));
      if(f>0)out[k].push(trace[k][lo]+f*(trace[k][hi]-trace[k][lo]));
    }
    return out;
  },
  role(scene,role,cutoff=null){
    return {...scene,visibleRole:role,
      traceFamilies:scene.traceFamilies.filter(t=>role==='all'||t.family===role),
      construction:cutoff===null?null:{cutoff}};
  }
});

// Construct one fixed-phase diagram by advancing acquisition angle across turns.
// This never changes the selected start phase, sample weights, or SSPz.
const geometryPlayback={playing:false,pending:false,timer:null,cache:new Map(),scene:null,window:null,fraction:1,lastTime:0};
function initializeGeometryPlayback(geometry,weights){
  const controls=document.createElement('div');controls.className='geometry-construction-controls';
  controls.innerHTML=`<h3>${fdkText('展開図ができるまで','How the unwrapped diagram is drawn')}</h3><div class="geometry-playback-controls">
    <button type="button" id="geometry-play" disabled>${fdkText('▶ 描く過程を再生','▶ Play drawing process')}</button>
    <button type="button" id="geometry-restart" disabled>${fdkText('最初から','Restart')}</button>
    <button type="button" id="geometry-complete" disabled>${fdkText('完成図を表示','Show complete diagram')}</button>
    <label>${fdkText('再生速度','Playback speed')}<select id="geometry-speed"><option value="45">${fdkText('ゆっくり','Slow')}</option><option value="90" selected>${fdkText('標準','Normal')}</option><option value="180">${fdkText('速い','Fast')}</option></select></label></div>
    <label class="geometry-drawing-progress">${fdkText('描画の進み具合','Drawing progress')}<input id="geometry-progress" type="range" min="0" max="1000" step="1" value="1000" disabled></label>
    <p id="geometry-play-status" role="status"></p>
    <p class="geometry-play-note">${fdkText('開始角度を固定し、左から右へ進む列軌跡を描き足します。1回転ごとに縦軸の0°へ戻り、次の体軸位置へ続きます。実データと、その同じデータを対向側へ写した破線を並べて確認できます。小さな四角は描画中の先端です。右端まで描き終えると、先頭から繰り返します。','The start phase stays fixed while row trajectories grow from left to right. Each turn wraps to 0° and continues at the next axial position. Direct data and the same data mapped to the complementary side are drawn together. Small squares mark the advancing tips. After completing the right edge, playback repeats.')}</p>
    <p class="geometry-play-note">${fdkText('軌跡を描く順序の表示です。下の補間重みとSSPzは完成した計算結果を保持します。','This illustrates trajectory construction. The interpolation weights and SSPz below retain the completed calculation.')}</p>`;
  const addRoles=(parent,id)=>{
    const all=document.getElementById(id).closest('article'),grid=document.createElement('div');grid.className='geometry-role-grid';
    all.before(grid);
    for(const role of ['direct','complementary']){
      const card=document.createElement('article');card.className='chart-card';
      card.innerHTML=`<h3>${role==='direct'?fdkText('① 実データ側','1. Direct data'):fdkText('② 対向データ側','2. Complementary data')}</h3><canvas id="${id}-${role}" width="900" height="960" aria-label="${role==='direct'?fdkText('実データ側の展開図','Direct-data diagram'):fdkText('対向データ側の展開図','Complementary-data diagram')}"></canvas>`;
      grid.append(card);
    }
    all.querySelector('h3').textContent=fdkText('③ 重ね合わせ','3. Overlay');grid.append(all);
    for(const canvas of grid.querySelectorAll('canvas')){
      const b=document.createElement('button');b.type='button';b.className='secondary';b.dataset.fdkCanvas=canvas.id;b.disabled=true;b.textContent=fdkText('600 dpi PNG保存','Save 600-dpi PNG');b.onclick=()=>exportFdkWorkflowCanvas(canvas.id);canvas.after(b);
    }
    parent.classList.add('has-role-diagrams');
  };
  addRoles(geometry,'fdk-geometry');addRoles(weights,'fdk-weights-primary');
  geometry.querySelector('.geometry-role-grid').insertAdjacentHTML('beforebegin',`<h3>${fdkText('2A　補間候補の配置：0～360°展開図','2A  Candidate arrangement: 0–360° unwrapped diagram')}</h3>`);
  geometry.querySelector('.geometry-role-grid').before(controls);
  document.getElementById('geometry-play').onclick=()=>{
    if(geometryPlayback.playing)stopGeometryPlayback();else{
      stopAxialMovie();if(geometryPlayback.fraction>=1)geometryPlayback.fraction=0;
      geometryPlayback.playing=true;geometryPlayback.lastTime=performance.now();paintGeometryConstruction();scheduleGeometryPlayback();
    }
  };
  document.getElementById('geometry-restart').onclick=()=>{stopGeometryPlayback();geometryPlayback.fraction=0;paintGeometryConstruction();};
  document.getElementById('geometry-complete').onclick=()=>{stopGeometryPlayback();geometryPlayback.fraction=1;paintGeometryConstruction();};
  document.getElementById('geometry-progress').oninput=e=>{const fraction=Number(e.target.value)/1000;stopGeometryPlayback();geometryPlayback.fraction=fraction;paintGeometryConstruction();};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopGeometryPlayback();});
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  if(reduced.matches)document.getElementById('geometry-speed').value='45';
  reduced.addEventListener('change',()=>{stopGeometryPlayback();if(reduced.matches)document.getElementById('geometry-speed').value='45';});
}
function updateGeometryPlayControl(){
  const button=document.getElementById('geometry-play');if(!button)return;
  button.textContent=geometryPlayback.playing?fdkText('Ⅱ 一時停止','Ⅱ Pause'):fdkText('▶ 描く過程を再生','▶ Play drawing process');
  button.setAttribute('aria-pressed',String(geometryPlayback.playing));
  const w=geometryPlayback.window;
  const deg=w?geometryPlayback.fraction*(w.end-w.start)*180/Math.PI:0;
  document.getElementById('geometry-progress').value=Math.round(geometryPlayback.fraction*1000);
  document.getElementById('geometry-play-status').textContent=w?
    fdkText('描画開始から ','From drawing start: ')+`${Math.floor(deg/360)} `+fdkText('回転 ＋ ','turns + ')+`${Math.floor(deg%360)}° / ${Math.round(100*geometryPlayback.fraction)}%`+
    (geometryPlayback.fraction===1?fdkText('：完成図',' · complete'):geometryPlayback.playing?fdkText('：描画中',' · drawing'):fdkText('：停止中',' · paused')):'';
}
function stopGeometryPlayback(){
  geometryPlayback.playing=false;clearTimeout(geometryPlayback.timer);geometryPlayback.timer=null;updateGeometryPlayControl();
}
function resetGeometryPlayback(){
  geometryPlayback.playing=false;clearTimeout(geometryPlayback.timer);geometryPlayback.timer=null;geometryPlayback.pending=false;geometryPlayback.cache.clear();geometryPlayback.scene=null;geometryPlayback.window=null;geometryPlayback.fraction=1;updateGeometryPlayControl();
}
function scheduleGeometryPlayback(){
  clearTimeout(geometryPlayback.timer);
  if(!geometryPlayback.playing||geometryPlayback.pending||document.hidden||!geometryPlayback.scene)return;
  geometryPlayback.timer=setTimeout(()=>{
    const now=performance.now(),w=geometryPlayback.window;
    if(geometryPlayback.fraction>=1)geometryPlayback.fraction=0;
    else geometryPlayback.fraction=Math.min(1,geometryPlayback.fraction+Math.min(100,now-geometryPlayback.lastTime)/1000*Number(document.getElementById('geometry-speed').value)*Math.PI/180/(w.end-w.start));
    geometryPlayback.lastTime=now;paintGeometryConstruction();scheduleGeometryPlayback();
  },geometryPlayback.fraction>=1?1600:50);
}
function receiveGeometryInspection(result){
  fdkSelectedResult=result;geometryPlayback.pending=false;
  geometryPlayback.cache.set(selectedStateIndex,result);
  while(geometryPlayback.cache.size>8)geometryPlayback.cache.delete(geometryPlayback.cache.keys().next().value);
  renderFdkSelected();prepareGeometryConstruction();
}
function prepareGeometryConstruction(){
  stopGeometryPlayback();geometryPlayback.fraction=1;
  const r=fdkSelectedResult;if(!r)return;
  geometryPlayback.scene=drawFdkCandidateDiagram({width:900,dataset:{}},r,false,false,'all',true);
  geometryPlayback.window=SSPZConstruction.window(geometryPlayback.scene,symmetricNiceAxis(geometryPlayback.scene.overviewXLimit,3).xMax);
  for(const id of ['geometry-play','geometry-restart','geometry-complete','geometry-progress'])document.getElementById(id).disabled=false;
  updateGeometryPlayControl();
}
function paintGeometryConstruction(){
  const p=geometryPlayback;if(!p.scene||!p.window)return;
  const cutoff=p.fraction>=1?null:p.window.start+p.fraction*(p.window.end-p.window.start);
  for(const role of ['direct','complementary','all']){
    const canvas=document.getElementById('fdk-geometry'+(role==='all'?'':'-'+role));
    drawDiagram(canvas,SSPZConstruction.role(p.scene,role,cutoff),'overview');
    canvas.dataset.constructionProgress=String(p.fraction);canvas.dataset.sourceCursor=String(cutoff??p.window.end);canvas.dataset.startIndex=selectedStateIndex;
  }
  updateGeometryPlayControl();
}
function drawFdkRoleDiagrams(r){
  for(const id of ['fdk-geometry','fdk-weights-primary'])for(const role of ['direct','complementary','all']){
    const canvas=document.getElementById(id+(role==='all'?'':'-'+role));
    drawFdkCandidateDiagram(canvas,r,id!=='fdk-geometry',false,role);
  }
}

// Display coordinates only. Never selects candidates or changes their weights.
globalThis.SSPZAngles = Object.freeze({
  offset(c, base, view) {
    const V = c.viewSamples;
    return ((view - base) % V + V) % V * 360 / V;
  },
  view(point, coordinate) {
    return coordinate === 'own' ? point.view : point.referenceView;
  },
  // Each existing pair supplies two output directions. Acquired/rebinned
  // identities stay fixed; only their roles relative to the output change.
  // Over T, the same directional datum can occur with different opposing
  // views. Sum those contributions for a single correctly shaded marker.
  expand(points, c) {
    const map = new Map(), half = c.viewSamples / 2;
    for (const p of points) for (const reverse of [false, true]) {
      const referenceView = p.referenceView + (reverse ? half : 0);
      const oppositeView = p.referenceView + (reverse ? 0 : half);
      const direction = reverse ? 1 - p.direction : p.direction;
      const key = `${referenceView}:${direction}:${p.view}:${p.focus ?? 0}:${p.row}`;
      let q = map.get(key);
      if (!q) {
        q = {...p, referenceView, direction, weight: 0, oppositeViews: [], sourcePairReferenceViews: []};
        if (p.referenceWeight !== undefined) q.referenceWeight = 0;
        map.set(key, q);
      }
      q.weight += p.weight;
      if (p.referenceWeight !== undefined) q.referenceWeight += p.referenceWeight;
      if (!q.oppositeViews.includes(oppositeView)) q.oppositeViews.push(oppositeView);
      if (!q.sourcePairReferenceViews.includes(p.referenceView)) q.sourcePairReferenceViews.push(p.referenceView);
    }
    return [...map.values()].map(p => ({...p,
      oppositeView: p.oppositeViews.length === 1 ? p.oppositeViews[0] : null}));
  },
  animation(audit) {
    if (audit.directionalFullTurn) return audit;
    const total = this.expand(audit.total, audit.config), roles = new Map();
    const key = p => `${p.view}:${p.focus ?? 0}:${p.row}`;
    for (const p of total) {
      if (!roles.has(key(p))) roles.set(key(p), [0, 0]);
      roles.get(key(p))[p.direction] += p.weight;
    }
    const classify = points => points.map(p => {
      const [directWeight, complementaryWeight] = roles.get(key(p)) ?? [0, 0];
      return {...p, directWeight, complementaryWeight};
    });
    return {...audit, directionalFullTurn: true, angularMeanFactor: 1 / audit.config.viewSamples,
      total: classify(total), frames: audit.frames.map(frame => ({...frame,
        instant: classify(this.expand(frame.instant, audit.config)),
        accumulated: classify(this.expand(frame.accumulated, audit.config))})),
      coordinate: 'Full-turn output interpolation direction; opposing rebinned data at theta +/- pi',
      definition: audit.definition + ' Both output directions shown; angular mean factor 1/V. No change to acquisition support or SSP.'};
  },
  weightAudit(result) {
    if (!result.weightAudit?.pairedSamples) return null;
    return {definition: 'Full-turn directional representation of the same coefficients. Alternative to weightAudit, not additive.',
      angularMeanFactor: 1 / result.config.viewSamples,
      samples: this.expand(result.weightAudit.pairedSamples, result.config)};
  },
  sample(c, base, point) {
    const theta=c.phase+point.view*2*Math.PI/c.viewSamples;
    const gamma=c.axialRule==='parallel'?0:Math.asin(-c.radius*Math.sin(theta)/c.sourceRadius);
    return {...point,theta,gamma,beta:theta+gamma,referenceOffset:this.offset(c,base,point.referenceView),ownOffset:this.offset(c,base,point.view)};
  },
  pair(c, base, referenceView, oppositeView = referenceView + c.viewSamples / 2) {
    return [0, 1].map(direction => {
      const view = direction ? oppositeView : referenceView;
      const theta = c.phase + view * 2 * Math.PI / c.viewSamples;
      const gamma = c.axialRule === 'parallel' ? 0 : Math.asin(-c.radius * Math.sin(theta) / c.sourceRadius);
      const beta = theta + gamma;
      return { direction, view, theta, gamma, beta,
        referenceOffset: this.offset(c, base, referenceView),
        ownOffset: this.offset(c, base, view) };
    });
  }
});

// Optional acquired-point view. A/B are physical alternating exposures.
const ZFFS_COLORS=['#0072b2','#d55e00'];
let zffsSceneCache=null;
function readZffsParams(){return {zFfsEnabled:!!document.getElementById('zffs-enabled')?.checked,zFfsMagnification:Number(document.getElementById('zffs-magnification')?.value??1072/600),zFfsOffset:Number(document.getElementById('zffs-offset')?.value??.25)};}
function initializeZffsUi(initial,changed){
  const box=document.createElement('div');box.id='zffs-controls';box.className='zffs-controls';
  box.innerHTML=`<label class="zffs-switch"><input type="checkbox" id="zffs-enabled">${fdkText('z方向の焦点移動による倍密度サンプリング（z-FFS）','Use z-flying focal spot sampling (z-FFS)')}</label>
  <p id="zffs-unavailable" hidden>${fdkText('②では焦点移動をOFFにします。①と②の幾何を比較するときは、両者ともOFFにしてください。','Reference ② turns focal switching OFF. Compare ① and ② with switching OFF in both.')}</p>
  <div id="zffs-options" hidden><p>${fdkText('焦点A・Bを交互に切り替え、候補点・補間重み・SSPzを計算します。取得ビュー数はA+Bの合計です。①と②の比較では両者ともOFFにしてください。初期設定では回転中心の列間隔を半分にします。','Alternate focal positions A and B for candidate geometry, interpolation weights and SSPz. The view count is the total A+B acquisitions. Keep switching OFF in both models for the ①/② comparison. The default interlaces rows at half spacing at isocentre.')}</p>
  <details class="reading-details"><summary>${fdkText('焦点移動の幾何条件','Focal-switching geometry')}</summary><div class="parameter-grid">
  <input id="zffs-magnification" type="hidden" value="${1072/600}">
  <label>${fdkText('回転中心での片側移動量 / 列間隔','One-sided isocentre offset / row pitch')}<input id="zffs-offset" type="number" min="0" max="0.5" step="0.01" value="0.25"></label></div>
  <p>${fdkText('固定した円筒検出器に対し、焦点を体軸方向だけに移動する理想モデルです。実機の設定値ではありません。回転中心から離れると、列間隔は一様に半分にはなりません。','An ideal model of pure axial focal motion relative to a fixed cylindrical detector, not scanner settings. Away from isocentre, the interlaced spacing is not uniformly halved.')}</p>
  <a href="${fdkText('methods.html?topic=zffs','methods.html?topic=zffs&lang=en')}">${fdkText('計算方法と検証範囲','Method and verification scope')}</a> · <a href="https://doi.org/10.1118/1.2828403">Mori (2008)</a></details></div>`;
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
  syncSharedFocalControls();
  const e=document.getElementById('zffs-enabled');if(!e)return;
  const available=document.getElementById('computationModel').value!=='parallel'&&Number(form.elements.namedItem('beamPitch').value)>0;
  if(!available)e.checked=false;e.disabled=runButton.disabled||!available;
  document.getElementById('zffs-unavailable').hidden=available;
  document.getElementById('zffs-options').hidden=!e.checked;
  document.getElementById('zffs-diagrams').hidden=!e.checked;
  document.getElementById('fdk-geometry').closest('article').hidden=false;
  document.getElementById('fdk-weight-step').hidden=false;
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

// Optional, user-started flipbook. Its phase is explicitly local to this block;
// the original complete-view profiles provide every SSP frame.
const axialMovie={audit:null,index:0,frame:0,mode:'thickness',selectedPair:null,playing:false,timer:null,request:0,pending:false,background:null,cache:new Map(),cacheKey:null};
function initializeAxialMovie(after){
  const section=document.createElement('section');section.id='axial-movie';section.className='workflow-block';
  section.innerHTML=`<h2>${fdkText('2C　候補点からSSPzへ：動画で確認','2C  From candidates to SSPz: interactive playback')}</h2>
  <p>${fdkText('① 幅T内の断面を動かして重みを積み重ねる　② 開始角度を変えてSSPzの変化を見る','1. Move through width T and accumulate weights.  2. Change the start angle and compare SSPz.')}</p>
  <p>${fdkText('再生は先頭に戻って繰り返します。「一時停止」で止められます。','Playback loops back to the beginning. Select Pause to stop.')}</p>
  <label class="axial-movie-position axial-movie-start" for="axial-movie-start"><strong>${fdkText('（a）～（c）共通の撮影開始角度','Acquisition start angle shared by (a)–(c)')} <span id="axial-movie-start-label">—</span></strong><input id="axial-movie-start" type="range" min="0" max="359" step="1" value="0" disabled><small>${fdkText('この角度を変えると、候補点・重み・SSPzが一緒に更新されます。','Changing this angle updates candidates, weights and SSPz together.')}</small></label>
  <div class="axial-movie-controls">
    <label>${fdkText('再生する動き','Playback mode')}<select id="axial-movie-mode"><option value="thickness">${fdkText('① 幅T内の断面移動','1. Plane sweep within T')}</option><option value="phase">${fdkText('② X線管の開始角度','2. Tube start angle')}</option></select></label>
    <label>${fdkText('再生速度','Playback speed')}<select id="axial-movie-speed"><option value="500">${fdkText('ゆっくり','Slow')}</option><option value="200" selected>${fdkText('標準','Normal')}</option><option value="100">${fdkText('速い','Fast')}</option></select></label>
    <button type="button" id="axial-movie-play" disabled>${fdkText('▶ 再生','▶ Play')}</button>
    <button type="button" id="axial-movie-prev" disabled>${fdkText('1コマ戻る','Previous frame')}</button>
    <button type="button" id="axial-movie-next" disabled>${fdkText('1コマ進む','Next frame')}</button>
    <button type="button" id="axial-movie-reset" disabled>${fdkText('先頭へ','Rewind')}</button>
  </div>
  <label id="axial-movie-plane-control" class="axial-movie-position" for="axial-movie-position"><span id="axial-movie-position-label">${fdkText('計算後に再生できます','Available after calculation')}</span><input id="axial-movie-position" type="range" min="0" max="40" step="1" value="0" disabled></label>
  <p id="axial-movie-status" role="status"></p>
  <p id="axial-movie-coordinate-note" class="angle-reading-note"></p>
  <details class="reading-details axial-angle-detail"><summary>${fdkText('詳細：図中の投影方向とX線管角度を確認','Details: inspect output direction and tube angles')}</summary>
  <div class="axial-angle-controls">
    <label>${fdkText('（a）で強調する補間対象方向（開始角度とは別）','Output direction to highlight in (a), not the start angle')}<select id="axial-movie-pair" disabled></select></label>
  </div>
    <p>${fdkText('同じ撮影条件の中で、候補点の枠と下表に示す方向を選びます。この選択では、全方向から求めた（c）のSSPzは変わりません。撮影開始角度は上の共通スライダーで変更します。','This selects the highlighted candidates and table direction within the same acquisition. It does not change the all-direction SSPz in (c). Use the shared start-angle slider above to change the acquisition.')}</p>
    <p id="axial-movie-source-window"></p>
    <div class="axial-angle-table-scroll" tabindex="0"><table><caption>${fdkText('（a）で強調した対：θ ＋ γ = β','Highlighted pair in (a): θ + γ = β')}</caption><thead><tr><th>${fdkText('使用する側','Role')}</th><th>${fdkText('図での角度差 (°)','Plotted offset (°)')}</th><th>${fdkText('再配列角 θ (°)','Rebinned θ (°)')}</th><th>${fdkText('ファン角 γ (°)','Fan angle γ (°)')}</th><th>${fdkText('X線管角 β (°)','Tube angle β (°)')}</th></tr></thead><tbody id="axial-movie-angle-values"></tbody></table></div>
    <p>${fdkText('実・対向方向の再配列角θは、360°で折り返すと180°異なります。表には実際に選んだ列・回転のθと、ファン角γを加えたX線管角βを示します。同じ側の異なる列が選ばれる場合もあります。βの前後で用いる取得ビューも、下記の有限取得範囲内に限ります。表の角度は折り返しません。図の0°は表示基準であり、X線管角0°ではありません。','Direct and opposing θ differ by 180° modulo a full turn. The table lists actual selected rows and turns, with β = θ + γ. Both selected rows may belong to the same side. Neighboring acquired views used for rebinning must also fit the stated finite source interval. Table angles are unwrapped. Plot zero is a display reference, not tube angle zero.')}</p>
  </details>
  <label class="axial-movie-role-control">${fdkText('（b）に表示する側','Side shown in (b)')}<select id="axial-movie-role"><option value="all">${fdkText('両側','Both sides')}</option><option value="direct">${fdkText('実データ側 ○','Direct ○')}</option><option value="complementary">${fdkText('対向データ側 △','Complementary △')}</option></select></label>
  <div class="axial-movie-grid">
    <article class="chart-card"><h3>${fdkText('（a）動かした断面の候補点と重み','(a) Candidates and weights at the moving plane')}</h3><div class="axial-movie-scroll" tabindex="0"><canvas id="axial-movie-instant" width="900" height="960"></canvas></div></article>
    <article class="chart-card"><h3 id="axial-movie-total-title">${fdkText('（b）幅T内で積み重ねた重み','(b) Weights accumulated within T')}</h3><div class="axial-movie-scroll" tabindex="0"><canvas id="axial-movie-total" width="900" height="960"></canvas></div></article>
  </div>
  <p id="axial-movie-detail">${fdkText('重みの点をクリックすると、同じデータの使用内訳を表示します。','Click a weight marker to inspect both roles of the same datum.')}</p>
  <article class="chart-card axial-movie-ssp"><h3>${fdkText('（c）同じ開始角度のモデルSSPz：幅T全体の平均化後','(c) Model SSPz at the same start angle: after the complete T average')}</h3><div class="axial-movie-scroll" tabindex="0"><canvas id="axial-movie-profile" width="1200" height="540"></canvas></div><button type="button" class="secondary" id="axial-movie-profile-png" disabled>${fdkText('600 dpi PNG保存','Save 600-dpi PNG')}</button></article>
  <p id="axial-movie-acquisition-note"></p>
  <p id="axial-movie-note"></p>
  <button type="button" class="secondary" id="axial-movie-apply" disabled>${fdkText('この開始角度をほかの図にも表示','Show this start angle in the other figures')}</button>
  <details class="reading-details"><summary>${fdkText('図の読み方','How to read the animation')}</summary><p>${fdkText('赤線は平均化の中心、青線は幅T内を動く断面です。（b）は下端から青線までの重みを、全幅Tを分母として積算します。終端で既存の合計重みと一致します。（c）は途中の積算値ではなく、全幅で平均化した最終SSPzです。全周の補間対象方向を対象とし、同じデータが実データ側・対向側として再利用される場合も示します。応答は全方向で平均するため、表示を全周に展開してもSSPzは変わりません。','The red line marks the averaging centre; the blue line moves within T. Panel (b) integrates from the lower boundary to the blue line, always dividing by the full T. At the end it equals the existing total weights. Panel (c) shows the final full-width SSPz, not a partially accumulated profile. The display covers a full turn of output directions, including reuse of the same datum in direct and complementary roles. Averaging over all directions preserves the SSPz.')}</p><p>${fdkText('全周表示では候補点の角度を抜粋し、拡大表示では範囲内の計算方向を省略せず描きます。SSPzは設定した全取得ビューで計算した結果です。幅Tの矩形平均化は本モデルの仮定であり、実機固有の重みを示すものではありません。開始角度の再生は異なる撮影条件の比較であり、1回の撮影中の管球回転を再現した動画ではありません。','The overview samples marker angles; detail retains every calculated direction in the enlarged interval. SSPz retains all configured acquired views. The rectangular T average is a model assumption, not a scanner-specific kernel. Start-angle playback compares separate acquisition conditions; it is not tube motion during one scan.')}</p></details>`;
  after.after(section);
  const el=id=>document.getElementById('axial-movie-'+id);
  el('mode').onchange=()=>{stopAxialMovie();axialMovie.mode=el('mode').value;el('plane-control').hidden=axialMovie.mode==='phase';axialMovie.frame=0;requestAxialMovie(axialMovie.index);};
  el('play').onclick=()=>{if(axialMovie.playing)stopAxialMovie();else{stopGeometryPlayback();axialMovie.playing=true;el('play').textContent=fdkText('Ⅱ 一時停止','Ⅱ Pause');scheduleAxialMovie();}};
  el('prev').onclick=()=>{stopAxialMovie();advanceAxialMovie(-1);};el('next').onclick=()=>{stopAxialMovie();advanceAxialMovie(1);};
  el('reset').onclick=()=>{stopAxialMovie();if(axialMovie.mode==='phase')requestAxialMovie(0);else{axialMovie.frame=0;renderAxialMovie();}};
  el('start').oninput=e=>{stopAxialMovie();requestAxialMovie(Number(e.target.value));};
  el('position').oninput=e=>{stopAxialMovie();axialMovie.frame=Number(e.target.value);renderAxialMovie();};
  el('role').onchange=()=>renderAxialMovie();el('apply').onclick=()=>{stopAxialMovie();selectFdkState(axialMovie.index,true);};
  el('pair').onchange=()=>{stopAxialMovie();axialMovie.selectedPair=Number(el('pair').value);renderAxialMovie();};
  el('instant').onclick=event=>inspectAxialMoviePair(event);
  el('total').onclick=event=>inspectAxialMovieMarker(event);
  el('profile-png').onclick=exportAxialMovieProfile;
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAxialMovie();});
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');if(reduced.matches)el('speed').value='500';
  reduced.addEventListener('change',()=>{stopAxialMovie();if(reduced.matches)el('speed').value='500';});
}
function stopAxialMovie(){
  axialMovie.playing=false;clearTimeout(axialMovie.timer);axialMovie.timer=null;
  const button=document.getElementById('axial-movie-play');if(button)button.textContent=fdkText('▶ 再生','▶ Play');
}
function disableAxialMovie(){
  stopAxialMovie();axialMovie.request++;axialMovie.pending=false;axialMovie.audit=null;axialMovie.background=null;axialMovie.cache.clear();
  worker?.postMessage({type:'axial-animation-cancel'});
  document.querySelectorAll('#axial-movie button, #axial-movie input, #axial-movie-pair').forEach(e=>e.disabled=true);
  const e=document.getElementById('axial-movie-status');if(e)e.textContent=fdkText('計算後に再生できます。','Available after calculation.');
}
function syncAxialMovie(){
  if(!fdkResult?.profiles?.length)return;
  stopAxialMovie();axialMovie.frame=0;requestAxialMovie(selectedStateIndex);
}
function refreshAxialMovieDisplay(){
  stopAxialMovie();requestAxialMovie(axialMovie.index);
}
function axialMovieAngleVisible(audit,point){
  if(!audit.angleRange)return true;
  const angle=SSPZAngles.offset(audit.config,audit.base,point.referenceView);
  return angle>=audit.angleRange[0]-1e-10&&angle<audit.angleRange[1]-1e-10;
}
function requestAxialMovie(index){
  if(!fdkResult?.profiles?.length||!worker)return;
  clearTimeout(axialMovie.timer);axialMovie.index=((index%fdkResult.profiles.length)+fdkResult.profiles.length)%fdkResult.profiles.length;
  axialMovie.request++;axialMovie.pending=true;
  const angle=fdkResult.profiles[axialMovie.index].phase*180/Math.PI;
  document.getElementById('axial-movie-start').value=axialMovie.index;
  document.getElementById('axial-movie-start-label').textContent=`${angle.toFixed(1)}°`;
  document.getElementById('axial-movie-profile-png').disabled=true;
  document.getElementById('axial-movie-status').textContent=fdkText('候補点・重み・SSPzを更新中：','Updating candidates, weights and SSPz: ')+`${angle.toFixed(1)}°`;
  const displayRange=typeof candidateDisplayRange==='function'?candidateDisplayRange():null;
  const angleRange=displayRange?[displayRange.min,displayRange.max]:null;
  const key=axialMovie.mode+':'+axialMovie.index+':'+(angleRange?angleRange.join('-'):'overview');axialMovie.cacheKey=key;
  if(axialMovie.cache.has(key)){receiveAxialMovie({requestId:axialMovie.request,index:axialMovie.index,audit:axialMovie.cache.get(key)});return;}
  for(const id of ['instant','total','profile']){
    const canvas=document.getElementById('axial-movie-'+id);
    delete canvas.dataset.startIndex;
    drawCanvasStatus(canvas,`${fdkText('開始角度','Start angle')} ${angle.toFixed(1)}°`,fdkText('同じ条件の3図を更新中','Updating all three panels for the same condition'));
  }
  worker.postMessage({type:'axial-animation',index:axialMovie.index,mode:axialMovie.mode,angleRange,requestId:axialMovie.request});
}
function receiveAxialMovie(message){
  if(message.requestId!==axialMovie.request||message.index!==axialMovie.index)return;
  axialMovie.audit=SSPZAngles.animation(message.audit);axialMovie.pending=false;axialMovie.background=null;
  axialMovie.cache.set(axialMovie.cacheKey,axialMovie.audit);
  while(axialMovie.cache.size>4)axialMovie.cache.delete(axialMovie.cache.keys().next().value);
  document.querySelectorAll('#axial-movie button, #axial-movie input, #axial-movie-pair').forEach(e=>e.disabled=false);
  renderAxialMovie();scheduleAxialMovie();
}
function failAxialMovie(message){
  if(message.requestId!==axialMovie.request)return;
  stopAxialMovie();axialMovie.pending=false;axialMovie.audit=null;document.getElementById('axial-movie-status').textContent=message.message;
  for(const id of ['instant','total','profile'])drawCanvasStatus(document.getElementById('axial-movie-'+id),fdkText('更新できませんでした','Update failed'),message.message,'error');
}
function scheduleAxialMovie(){
  clearTimeout(axialMovie.timer);if(!axialMovie.playing||axialMovie.pending||document.hidden)return;
  axialMovie.timer=setTimeout(()=>advanceAxialMovie(1),Number(document.getElementById('axial-movie-speed').value));
}
function advanceAxialMovie(delta){
  if(!axialMovie.audit)return;
  const phase=axialMovie.mode==='phase',count=phase?fdkResult.profiles.length:axialMovie.audit.frames.length;
  if(!count){stopAxialMovie();return;}
  let next=(phase?axialMovie.index:axialMovie.frame)+delta;
  if(next>=count||next<0){
    if(!axialMovie.playing){stopAxialMovie();return;}
    next=((next%count)+count)%count;
  }
  if(phase){
    requestAxialMovie(next);
  }else{
    axialMovie.frame=next;renderAxialMovie();scheduleAxialMovie();
  }
}
function axialMovieBackground(audit,candidatesOnly=false){
  const c=audit.config,V=c.viewSamples,angles=[],families=[];
  const groupsAt=v=>axialAnimationGroups(c,v);
  const segments=Math.min(V,360),firstGroups=groupsAt(audit.base);
  firstGroups.forEach(g=>families.push({id:(g.direction?'complementary-':'direct-')+g.focus,family:g.direction?'complementary':'direct',angles,axial:[],scales:[]}));
  let min=Infinity,max=-Infinity;
  for(let i=0;i<=segments;i++){
    angles.push(360*i/segments);
    groupsAt(audit.base+V*i/segments).forEach((g,j)=>{
      families[j].axial.push(g.origin);families[j].scales.push(g.spacing/c.rowWidth);
      for(const row of [0,c.rows-1]){const z=g.origin+(row-(c.rows-1)/2)*g.spacing-audit.zObject;min=Math.min(min,z);max=Math.max(max,z);}
    });
  }
  const limit=symmetricNiceAxis(audit.xHalfSpan,3).xMax;
  const turnMin=Math.ceil((-limit-max)/c.feed),turnMax=Math.floor((limit-min)/c.feed);
  const turns=Array.from({length:turnMax-turnMin+1},(_,i)=>turnMin+i);
  const diagram={totalRows:c.rows,z0:audit.zObject,zoomXLimit:audit.xHalfSpan,overviewXLimit:audit.xHalfSpan,
    angleMin:audit.angleRange?.[0]??0,angleMax:audit.angleRange?.[1]??360,
    interpolationBandHalfWidth:c.axialAverageMm/2,traceFamilies:candidatesOnly?[]:families,roleMarkersOnly:candidatesOnly,
    traceGeometry:{...families[0],rowOffsets:Array.from({length:c.rows},(_,i)=>(i-(c.rows-1)/2)*c.rowWidth),feed:c.feed,turns},weightedPoints:[],
    xAxisLabel:fdkText('候補列中心  zᵢ − z₀  (mm)','Candidate row centre  zᵢ − z₀  (mm)'),
    yAxisLabel:fdkText('補間対象方向の角度差 (°)','Output interpolation direction (°)'),
    directLegendLabel:fdkText('実データ側 ○','Direct ○'),weightLegendLabel:fdkText('重み w','Weight w'),
    weightLegendNote:candidatesOnly
      ?fdkText('選ばれた候補点のみ。○：実データ側、△：対向側。','Selected candidates only. ○: direct; △: opposing.' )
      :fdkText('各方向の補間重み。対向側の再配列角は±180°。','Weights at each output direction; opposing data: ±180°.'),
    referenceViewSamples:V,renderedAngleSamples:audit.angleSamplesPerTurn};
  const canvas=document.createElement('canvas');canvas.width=900;canvas.height=960;
  drawDiagram(canvas,diagram,'zoom');canvas.dataset.geometryTrajectories=String(!candidatesOnly);return canvas;
}
function paintAxialMovieWeights(canvas,points,u,accumulated){
  const a=axialMovie.audit,c=a.config;
  axialMovie.background??={};
  const background=axialMovie.background[accumulated?'total':'instant']??=axialMovieBackground(a,!accumulated);
  const ctx=canvas.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,900,960);ctx.drawImage(background,0,0);
  const xmin=Number(background.dataset.xMin),xmax=Number(background.dataset.xMax),left=112,top=32,width=754,height=650;
  const angleMin=a.angleRange?.[0]??0,angleMax=a.angleRange?.[1]??360;
  const x=z=>left+(z-xmin)/(xmax-xmin)*width,y=v=>top+(SSPZAngles.offset(c,a.base,v)-angleMin)/(angleMax-angleMin)*height;
  const role=document.getElementById('axial-movie-role').value;
  ctx.save();ctx.beginPath();ctx.rect(left,top,width,height);ctx.clip();
  if(accumulated&&axialMovie.mode==='thickness'){
    ctx.fillStyle='rgba(35,105,175,.09)';ctx.fillRect(x(-c.axialAverageMm/2),top,x(u)-x(-c.axialAverageMm/2),height);
  }
  const rendered=[];
  for(const p of [...points].sort((a,b)=>a.weight-b.weight)){
    if(!axialMovieAngleVisible(a,p))continue;
    if(accumulated&&role!=='all'&&p.direction!==(role==='direct'?0:1))continue;
    const py=y(p.referenceView);
    drawWeightedMarker(ctx,p.row,c.rows,x(p.z),py,5.2,p.weight,p.direction?'triangle':'circle');
    rendered.push({p,x:x(p.z),y:py});
  }
  if(!accumulated){
    ctx.strokeStyle='#233746';ctx.lineWidth=1.8;ctx.setLineDash([]);
    for(const q of rendered)if(q.p.referenceView===axialMovie.selectedPair)ctx.strokeRect(q.x-8,q.y-8,16,16);
  }
  if(axialMovie.mode==='thickness'||!accumulated){ctx.strokeStyle='#2166ac';ctx.lineWidth=2.5;ctx.setLineDash([7,4]);ctx.beginPath();ctx.moveTo(x(u),top);ctx.lineTo(x(u),top+height);ctx.stroke();ctx.setLineDash([]);}
  ctx.restore();canvas.dataset.renderState='ready';canvas.dataset.startIndex=axialMovie.index;canvas.dataset.planeMm=u;canvas.dataset.partial=String(accumulated&&axialMovie.mode==='thickness');canvas.dataset.markerCount=rendered.length;
  canvas.dataset.angleCoordinate='full-turn-output';
  canvas.dataset.geometryTrajectories=background.dataset.geometryTrajectories;
  canvas.dataset.outputDirectionCount=new Set(rendered.map(q=>SSPZAngles.offset(c,a.base,q.p.referenceView))).size;
  canvas.dataset.angleMin=angleMin;canvas.dataset.angleMax=angleMax;canvas.dataset.nativeAngleDetail=String(!!a.angleRange);
  if(accumulated)axialMovie.hitPoints=rendered;else axialMovie.instantHitPoints=rendered;
}
function renderAxialAngleReading(frame){
  const a=axialMovie.audit,c=a.config,el=id=>document.getElementById('axial-movie-'+id);
  const refs=[...new Set(frame.instant.filter(p=>axialMovieAngleVisible(a,p)).map(p=>p.referenceView))].sort((x,y)=>SSPZAngles.offset(c,a.base,x)-SSPZAngles.offset(c,a.base,y));
  if(!refs.length){el('pair').disabled=true;el('angle-values').replaceChildren();return;}
  const targetOffset=SSPZAngles.offset(c,a.base,axialMovie.selectedPair??refs[0]);
  const distance=v=>{const d=Math.abs(SSPZAngles.offset(c,a.base,v)-targetOffset);return Math.min(d,360-d);};
  axialMovie.selectedPair=refs.reduce((best,v)=>distance(v)<distance(best)?v:best,refs[0]);
  const key=refs.join(',');
  if(el('pair').dataset.refs!==key){
    el('pair').replaceChildren(...refs.map(v=>new Option(`${SSPZAngles.offset(c,a.base,v).toFixed(1)}°`,String(v))));
    el('pair').dataset.refs=key;
  }
  el('pair').disabled=false;el('pair').value=axialMovie.selectedPair;
  el('coordinate-note').textContent=(a.angleRange
    ?`${a.angleRange[0]}–${a.angleRange[1]}°`+fdkText('の範囲を、計算した全方向で拡大表示します。',' is enlarged with every calculated output direction.')
    :fdkText('補間対象の全周0～360°を表示します。','The display covers output directions over 0–360°.'))
    +fdkText('各方向で使う実データ側○と対向側△を、同じ高さに示します。（a）は選ばれた候補点のみを表示し、枠は強調する方向の候補を示します。',' Direct ○ and complementary △ data for each output direction share a height. Panel (a) shows selected candidates only; boxes highlight the chosen direction’s candidates.');
  const degrees=r=>{const d=r*180/Math.PI;return (Math.abs(d)<.05?0:d).toFixed(1);};
  const supportFan=c.axialRule==='parallel'&&c.comparisonMode!=='matched-rri'?0:c.fullFanAngleDeg;
  const centre=c.phase+2*Math.PI*(a.zObject+frame.u)/c.feed,half=Math.PI+supportFan*Math.PI/180;
  el('source-window').textContent=fdkText('この断面の取得範囲 β：','Source-angle support at this plane, β: ')+`${degrees(centre-half)}° ～ ${degrees(centre+half)}°`+fdkText('（取得範囲を決める Φ＝',' (support parameter Φ = ')+`${supportFan}°)`;
  const chosen=frame.instant.filter(p=>p.referenceView===axialMovie.selectedPair);
  const rows=chosen.map(p=>SSPZAngles.sample(c,a.base,p)).map(q=>{
    const tr=document.createElement('tr');
    const role=(q.direction?fdkText('対向側 △','Complementary △'):fdkText('実データ側 ○','Direct ○'))+` / ${fdkText('列','row')} ${q.row+1}${c.zFfsEnabled?' / '+(q.focus?'B':'A'):''}`;
    const values=[role,q.referenceOffset.toFixed(1),degrees(q.theta),degrees(q.gamma),degrees(q.beta)];
    values.forEach((value,i)=>{const td=document.createElement(i?'td':'th');if(!i)td.scope='row';td.textContent=value;tr.append(td);});
    return tr;
  });
  el('angle-values').replaceChildren(...rows);
}
function inspectAxialMoviePair(event){
  if(!axialMovie.audit||axialMovie.pending||!axialMovie.instantHitPoints)return;
  const rect=event.currentTarget.getBoundingClientRect(),x=(event.clientX-rect.left)*900/rect.width,y=(event.clientY-rect.top)*960/rect.height;
  let hit=null,distance=20;
  for(const q of axialMovie.instantHitPoints){const d=Math.hypot(q.x-x,q.y-y);if(d<distance){hit=q;distance=d;}}
  if(hit){stopAxialMovie();axialMovie.selectedPair=hit.p.referenceView;renderAxialMovie();}
}
function renderAxialMovie(){
  const audit=axialMovie.audit;if(!audit||!fdkResult||axialMovie.pending)return;
  const c=audit.config,frame=audit.frames[axialMovie.mode==='phase'?0:axialMovie.frame];if(!frame)return;
  const phase=c.phase*180/Math.PI,progress=Math.round(frame.fraction*100),el=id=>document.getElementById('axial-movie-'+id);
  el('start').max=fdkResult.profiles.length-1;el('start').value=axialMovie.index;
  el('start-label').textContent=`${phase.toFixed(1)}°`;
  el('plane-control').hidden=axialMovie.mode==='phase';
  el('position').max=audit.frames.length-1;el('position').value=axialMovie.frame;
  el('position-label').textContent=fdkText('幅T内を動かす断面位置','Plane position within T')+` u = ${frame.u.toFixed(2)} mm / T = ${c.axialAverageMm.toFixed(2)} mm`;
  el('status').textContent=axialMovie.mode==='thickness'?fdkText('開始角度を固定：幅Tの','Fixed start angle: ')+` ${progress}% `+fdkText('まで積算','of T accumulated'):fdkText('開始角度ごとの別撮影を比較：幅T全体の重みを表示','Comparing separate start-angle conditions: full-T weights shown');
  el('total-title').textContent=axialMovie.mode==='thickness'?fdkText('（b）幅T内で積み重ねた重み','(b) Weights accumulated within T')+` — ${progress}%`:fdkText('（b）幅T全体の合計重み','(b) Total weights over T');
  el('note').textContent=fdkText('赤線：平均化の中心。青線：幅T内を動く断面。（a）（b）は中央の応答を作る重み、（c）は全評価位置で計算済みのSSPzです。','Red: averaging centre. Blue: plane moving within T. (a) and (b) explain the central response; (c) is the SSPz at all evaluation positions.')+(audit.angleRange
    ?fdkText('拡大範囲内の候補点は、計算した全方向を省略せず表示しています。',' Within the enlarged interval, markers retain every calculated output direction.')
    :fdkText('候補点は',' Markers are sampled every ')+`${(360*audit.stride/c.viewSamples).toFixed(1)}°`+fdkText('間隔で抜粋。',' from the full calculation.'))
    +fdkText('（a）は候補点のみ、（b）の背景は選択区間外の隣接回転を含む列軌跡です。',' Panel (a) shows candidates only; the background in (b) shows row trajectories, including neighboring turns outside the selected interval.');
  renderAxialAngleReading(frame);
  for(const id of ['instant','total','profile']){loadingCanvasStatuses.delete(el(id));el(id).removeAttribute('aria-busy');}
  paintAxialMovieWeights(el('instant'),frame.instant,frame.u,false);paintAxialMovieWeights(el('total'),frame.accumulated,frame.u,true);
  drawAxialMovieProfile(el('profile'));
  const focus=c.focalSizeMm??0;
  el('acquisition-note').textContent=(focus>0
    ?fdkText('取得応答に体軸方向の有限焦点を適用：','Finite axial focus applied to acquired data: ')+`${focus.toFixed(2)} mm. `
    :fdkText('点焦点で計算。','Point-focus calculation. '))
    +fdkText('候補点は列中心、マーカーの濃さは補間重みです。SSPzには、各取得データの検出器開口と焦点の応答を反映しています。','Candidate markers show row centres and interpolation weights. SSPz also includes each acquired datum’s detector-aperture and focal response.');
  el('detail').textContent=fdkText('（b）の点をクリックすると、同じデータの使用内訳を表示します。','Click a marker in (b) to inspect both roles of that datum.');
}
function drawAxialMovieProfile(canvas,index=axialMovie.index){
  const p=fdkResult.profiles[index],xs=fdkResult.z,phase=p.phase*180/Math.PI;
  const plot=fdkAxes(canvas,xs[0],xs.at(-1),0,1.05,'z position (mm)','Normalized SSPz','(c)', [0,.5,1],70);
  fdkDrawLines(plot,xs,[p.profile],FDK_PRIMARY_COLOR);fdkArrow(plot,p.fwhm,.5,FDK_PRIMARY_COLOR);
  plot.ctx.strokeStyle='#555';plot.ctx.setLineDash([5,5]);plot.ctx.beginPath();plot.ctx.moveTo(plot.x(0),plot.b.top);plot.ctx.lineTo(plot.x(0),plot.b.bottom);plot.ctx.stroke();plot.ctx.setLineDash([]);
  plot.ctx.fillStyle=FDK_PRIMARY_COLOR;plot.ctx.textAlign='center';plot.ctx.font='24px Arial';plot.ctx.fillText(`FWHM ${p.fwhm.width.toFixed(2)} mm / FWTM ${p.fwtm.width.toFixed(2)} mm / ${phase.toFixed(1)}°`,(plot.b.left+plot.b.right)/2,38);
  canvas.dataset.startIndex=index;canvas.dataset.profileSource='full-acquired-view-result';
}
async function exportAxialMovieProfile(){
  if(!fdkResult||!axialMovie.audit||axialMovie.pending)return;
  stopAxialMovie();const index=axialMovie.index,source=document.getElementById('axial-movie-profile'),canvas=document.createElement('canvas');
  canvas.width=Math.round(180/25.4*600);canvas.height=Math.round(canvas.width*source.height/source.width);
  drawAxialMovieProfile(canvas,index);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve));
  downloadBlob(`${fdkFileStem(fdkResult)}_selected-profile_angle-${index}_600dpi.png`,await pngWithResolution(blob,600),'image/png');
}
function inspectAxialMovieMarker(event){
  if(!axialMovie.audit||axialMovie.pending||!axialMovie.hitPoints)return;const rect=event.currentTarget.getBoundingClientRect(),x=(event.clientX-rect.left)*900/rect.width,y=(event.clientY-rect.top)*960/rect.height;
  let hit=null,distance=16;for(const q of axialMovie.hitPoints){const d=Math.hypot(q.x-x,q.y-y);if(d<distance){hit=q;distance=d;}}
  if(!hit)return;const p=hit.p,c=axialMovie.audit.config;
  const weight=v=>v===0?'0':v<.001?'<0.001':v.toFixed(3);
  document.getElementById('axial-movie-detail').textContent=fdkText('全幅Tでの使用内訳（角度平均前）：検出器列','Full-T role weights (before angular averaging): detector row')+` ${p.row+1}${c.zFfsEnabled?' / '+(p.focus?'B':'A'):''} / z = ${p.z.toFixed(2)} mm / `+fdkText('実データ側','direct')+`: ${weight(p.directWeight)} / `+fdkText('対向データ側','complementary')+`: ${weight(p.complementaryWeight)} / `+fdkText('合計','total')+`: ${weight(p.directWeight+p.complementaryWeight)}`;
}

// One reconstruction result supplies the diagram, weights, selected SSP and
// shape variation. Rendering never substitutes axial-model coefficients.
let fdkSelectedResult=null,fdkRunParams=null,fdkInspectionRequest=0,fdkInspectionTimer=null;
const fdkAngleTicks=[0,60,120,180,240,300,360];
function candidateDisplayRange(){
  if(document.getElementById('candidate-display-mode')?.value!=='detail')return null;
  const min=Number(document.getElementById('candidate-display-start').value);
  return {min,max:min+30};
}
function updateCandidateDisplay(){
  const range=candidateDisplayRange();
  document.getElementById('candidate-display-window').hidden=!range;
  stopAxialMovie();
  if(fdkSelectedResult)for(const role of ['direct','complementary','all'])drawFdkCandidateDiagram(document.getElementById('fdk-weights-primary'+(role==='all'?'':'-'+role)),fdkSelectedResult,true,false,role);
  if(fdkSelectedResult?.reference)drawFdkCandidateDiagram(document.getElementById('fdk-weights-rri'),fdkSelectedResult,true,true);
  if(axialMovie.audit||fdkResult?.profiles?.length)refreshAxialMovieDisplay();
}
function initializeFdkWorkflow(panel){
  const block=(id,title)=>{const e=document.createElement('div');e.id=id;e.className='workflow-block';e.innerHTML=`<h2>${title}</h2>`;return e;};
  const geometry=block('fdk-geometry-step',fdkText('2　展開図と補間の重み','2  Unwrapped geometry and interpolation weights'));
  geometry.insertAdjacentHTML('beforeend',`<div class="state-inspector"><label for="fdk-inspect">${fdkText('表示する回転開始角度','Start angle to inspect')} <span id="fdk-inspect-label"></span></label><div class="state-controls"><button type="button" id="fdk-prev" disabled>−1°</button><input type="range" id="fdk-inspect" min="0" max="359" step="1" value="0" disabled><button type="button" id="fdk-next" disabled>+1°</button></div><p id="fdk-inspection-status" aria-live="polite"></p></div>`);
  document.getElementById('fdk-geometry').width=900;document.getElementById('fdk-geometry').height=960;
  const firstCard=document.getElementById('fdk-geometry').closest('article');geometry.append(firstCard);
  firstCard.querySelector('h3').textContent=fdkText('2A　補間候補の配置：0～360°展開図','2A  Candidate arrangement: 0–360° unwrapped diagram');
  firstCard.querySelector('h3').insertAdjacentHTML('afterend',`<p id="fdk-paired-coordinate" hidden></p>`);
  const weights=block('fdk-weight-step',fdkText('2B　選択されたデータと重み','2B  Selected data and weights'));
  weights.insertAdjacentHTML('beforeend',`<p>${fdkText('同じ開始角度・同じ対象位置の重みです。応答の体軸方向平均化を指定した場合は、その幅全体の重みを合計します。','Weights refer to the same start angle and target location. If axial response averaging is enabled, coefficients are summed across that window.')}</p><div class="chart-grid two"><article class="chart-card"><h3 id="fdk-primary-weight-title">RRI</h3><canvas id="fdk-weights-primary" width="900" height="960"></canvas></article><article class="chart-card" id="fdk-rri-weights-card"><h3>RRI</h3><canvas id="fdk-weights-rri" width="900" height="960"></canvas></article></div><p id="fdk-weight-scope"></p>`);
  weights.querySelector('.chart-grid').insertAdjacentHTML('beforebegin',`<div class="candidate-display-controls"><label>${fdkText('2B・2Cの候補点の表示','Candidate display in 2B and 2C')}<select id="candidate-display-mode"><option value="overview">${fdkText('全周：代表角度を表示','Full turn: sampled directions')}</option><option value="detail">${fdkText('30°拡大：間引きなし','30° detail: every direction')}</option></select></label><label id="candidate-display-window" hidden>${fdkText('拡大する角度範囲','Angular range')}<select id="candidate-display-start">${Array.from({length:12},(_,i)=>`<option value="${i*30}">${i*30}°–${i*30+30}°</option>`).join('')}</select></label></div><p id="candidate-display-status" class="candidate-display-status" aria-live="polite"></p><p class="candidate-display-note">${fdkText('記号は選択された点の重みです。全周表示では角度を抜粋します。多列での細かな切り替わりは「30°拡大」で確認できます。背景の線は全列を描き、多列では重なりを見やすくするため薄くしています。','Markers encode weights on selected points. The full-turn view samples directions; use 30° detail to inspect rapid row changes. Background trajectories include all rows and become lighter with more rows to keep overlaps visible.')}</p>`);
  weights.querySelector('#candidate-display-mode').onchange=updateCandidateDisplay;
  weights.querySelector('#candidate-display-start').onchange=updateCandidateDisplay;
  const profile=block('fdk-profile-step',fdkText('3　全360条件のSSPz','3  SSPz across all 360 conditions'));
  const overlay=document.getElementById('fdk-profile').closest('article');profile.append(overlay);overlay.querySelector('h3').textContent=fdkText('全360条件の重ね合わせ','Overlay of all 360 conditions');
  const shape=block('fdk-shape-step',fdkText('SSPzの平均からの差・形状変動','SSPz deviations from the mean and shape variation'));
  shape.querySelector('h2').id='sspz-variation-title';
  shape.insertAdjacentHTML('beforeend',`<p id="sspz-variation-status" role="status" aria-live="polite"></p><button type="button" id="sspz-variation-calculate" class="secondary">${fdkText('360開始角度を計算して変動図を表示','Calculate 360 start angles to show variation')}</button><p class="field-help">${fdkText('同じ評価位置の360本から平均を求めます。上の1開始角度だけのプレビューでは、平均からの変動は評価しません。','The mean uses 360 profiles at the same evaluation position. The single-start-angle preview above cannot show variation about that mean.')}</p>`);
  shape.append(document.getElementById('fdk-difference-wrap'),document.getElementById('fdk-shape-wrap'));
  const variation=document.createElement('section');variation.id='sspz-variation';variation.setAttribute('aria-labelledby','sspz-variation-title');variation.append(shape);panel.before(variation);
  document.getElementById('sspz-variation-calculate').onclick=()=>document.getElementById('position-prepare').click();
  updateSspzVariation('idle');
  const images=document.createElement('details');images.className='reading-details';images.hidden=true;images.innerHTML=`<summary>${fdkText('選択角度の再構成画像','Reconstructed images at the selected angle')}</summary><div class="chart-grid two"></div>`;
  images.lastElementChild.append(document.getElementById('fdk-axial').closest('article'),document.getElementById('fdk-coronal').closest('article'));
  const oldGrid=panel.querySelector('.chart-grid.two');oldGrid.replaceWith(geometry,weights,profile,images);
  initializeAxialMovie(weights);
  initializeGeometryPlayback(geometry,weights);
  geometry.querySelector('.geometry-role-grid').before(document.getElementById('fdk-paired-coordinate'));
  // The old first-angle-only audit is superseded by the linked window audit.
  document.getElementById('cba-samples-wrap').hidden=true;
  document.getElementById('cba-samples-wrap').style.display='none';
  document.getElementById('fdk-inspect').oninput=e=>selectFdkState(Number(e.target.value));
  document.getElementById('fdk-prev').onclick=()=>selectFdkState(selectedStateIndex-1,true);
  document.getElementById('fdk-next').onclick=()=>selectFdkState(selectedStateIndex+1,true);
  for(const id of ['fdk-weights-rri','fdk-difference']){
    const b=document.createElement('button');b.type='button';b.className='secondary';b.dataset.fdkCanvas=id;b.disabled=true;b.textContent=fdkText('600 dpi PNG保存','Save 600-dpi PNG');b.onclick=()=>exportFdkWorkflowCanvas(id);document.getElementById(id).after(b);
  }
}
function updateSspzVariation(state,result=null,message=''){
  const section=document.getElementById('sspz-variation');if(!section)return;
  section.hidden=Number(form.elements.namedItem('beamPitch').value)<=0;
  section.dataset.renderState=state;
  if(state==='ready'&&result){
    const c=result.config;
    section.dataset.resultSettings=`r = ${c.radius} mm / ${c.rows} rows × ${c.rowWidth} mm / pitch ${c.beamPitch} / T = ${c.axialAverageMm??0} mm / ${c.viewSamples} views/turn / ${result.profiles.length} start angles`;
    section.dataset.profileCount=String(result.profiles.length);
  }
  const prior=section.dataset.resultSettings;
  const descriptions={
    idle:fdkText('平均差・形状変動の図を表示するには、360開始角度を計算してください。','Calculate 360 start angles to display deviations from the mean and shape variation.'),
    loading:fdkText('360開始角度のSSPzから平均差・形状変動を計算中です。','Calculating deviations and shape variation from 360 start-angle SSPz profiles.'),
    ready:fdkText('同じ評価位置の全開始角度から求めた変動です。平均の求め方と位置合わせは、各図の説明をご覧ください。','Variation across all start angles at one position. Each plot explains its mean and alignment convention.'),
    unavailable:fdkText('この条件ではSSPzが得られないため、平均差・形状変動を表示できません。','No SSPz response is available at these settings, so mean deviations and shape variation cannot be calculated.'),
    error:fdkText('360開始角度の計算を完了できませんでした。','The 360-start-angle calculation did not complete.')
  };
  const held=prior&&state!=='ready'?fdkText('下の図は変更前の条件の結果です。現在の条件では再計算が必要です。','The plots below use the previous settings. Recalculate for the current settings.')+' '+prior:'';
  document.getElementById('sspz-variation-status').textContent=[descriptions[state]??'',message,state==='ready'?prior:held].filter(Boolean).join(' ');
  const button=document.getElementById('sspz-variation-calculate');button.disabled=state==='loading';
  button.textContent=state==='ready'?fdkText('360開始角度を再計算','Recalculate 360 start angles'):fdkText('360開始角度を計算して変動図を表示','Calculate 360 start angles to show variation');
  if(!prior){document.getElementById('fdk-difference-wrap').hidden=true;document.getElementById('fdk-shape-wrap').hidden=true;}
  for(const canvas of section.querySelectorAll('canvas')){
    canvas.dataset.renderState=prior?(state==='ready'?'ready':'stale'):state;
    canvas.setAttribute('aria-busy',String(state==='loading'));
  }
}
function fdkWorkflowAvailability(on){
  if(!on){resetGeometryPlayback();disableAxialMovie();}
  for(const id of ['candidate-display-mode','candidate-display-start'])document.getElementById(id).disabled=!on||!fdkSelectedResult;
  if(!on)document.getElementById('candidate-display-status').textContent='';
  for(const id of ['geometry-play','geometry-restart','geometry-complete','geometry-progress'])document.getElementById(id).disabled=!on||!fdkSelectedResult;
  for(const id of ['fdk-inspect','fdk-prev','fdk-next'])document.getElementById(id).disabled=!on;
  document.querySelectorAll('[data-fdk-canvas]').forEach(b=>b.disabled=!on||!fdkSelectedResult);
}
function selectFdkState(index,immediate=false){
  if(!fdkResult)return;
  stopGeometryPlayback();
  stopAxialMovie();
  geometryPlayback.pending=true;updateGeometryPlayControl();
  selectedStateIndex=((Math.round(index)%360)+360)%360;fdkInspectionRequest++;clearTimeout(fdkInspectionTimer);fdkSelectedResult=null;
  document.getElementById('fdk-inspect').value=selectedStateIndex;
  const angle=fdkResult.profiles[selectedStateIndex].phase*180/Math.PI;
  document.getElementById('fdk-inspect-label').textContent=`+${selectedStateIndex}° / ${fdkText('開始角度','start angle')} ${angle.toFixed(1)}°`;
  document.getElementById('fdk-inspection-status').textContent=fdkText('選択角度の展開図・重み・応答を更新中…','Updating geometry, weights and response for the selected angle…');
  for(const id of ['fdk-geometry','fdk-geometry-direct','fdk-geometry-complementary','fdk-weights-primary','fdk-weights-primary-direct','fdk-weights-primary-complementary','fdk-weights-rri','fdk-axial','fdk-coronal'])drawCanvasStatus(document.getElementById(id),'',fdkText('選択角度を計算中','Computing selected angle'));
  syncZffsUi();for(const cv of document.querySelectorAll('#zffs-diagrams canvas'))drawCanvasStatus(cv,'z-FFS',fdkText('選択角度を計算中','Computing selected angle'));
  fdkWorkflowAvailability(true);document.getElementById('fdk-json').disabled=true;document.getElementById('fdk-xlsx').disabled=true;
  const url=paramsToUrl(fdkRunParams);try{history.replaceState(null,'',url);}catch{}syncLanguageLinks(url.search);
  const requestId=fdkInspectionRequest;
  if(geometryPlayback.cache.has(selectedStateIndex)){receiveGeometryInspection(geometryPlayback.cache.get(selectedStateIndex));return;}
  const send=()=>worker?.postMessage({type:'fdk-inspect',index:selectedStateIndex,requestId});
  if(immediate)send();else fdkInspectionTimer=setTimeout(send,180);
}
function renderFdkSelected(){
  const r=fdkSelectedResult;if(!r)return;
  clearCanvasStatusAnimations();
  document.getElementById('fdk-primary-weight-title').textContent=fdkText('③ 重ね合わせ','3. Overlay');
  document.querySelector('#fdk-rri-weights-card h3').textContent=fdkText('RRI：列間の線形補間','RRI: linear row interpolation');
  drawFdkRoleDiagrams(r);
  fdkDrawProfile(document.getElementById('fdk-profile'),fdkResult);

  const pairNote=document.getElementById('fdk-paired-coordinate');
  pairNote.hidden=!r.weightAudit?.pairedSamples;
  pairNote.textContent=fdkText('実線：実データ側。破線：対向側。補間対象の全周0～360°を表示し、各方向の両側の候補を同じ高さに示します。対向側自身の再配列角は±180°異なります。縦軸はX線管角度ではなく、2Cの表でその対応を確認できます。','Solid: direct. Dashed: complementary. All output directions over 0–360° are shown, with both sides at the same height for each direction. The opposing data’s own rebinned angle differs by ±180°. This axis is not tube angle; the table in 2C shows the correspondence.');
  document.getElementById('fdk-rri-weights-card').hidden=!r.reference;
  document.getElementById('fdk-rri-weights-card').parentElement.classList.remove('two');
  if(r.reference)drawFdkCandidateDiagram(document.getElementById('fdk-weights-rri'),r,true,true);
  // Reduced response has no image volume.
  document.getElementById('fdk-weight-scope').textContent=fdkText('対象点の位置で、幅Tにわたり合算した補間重みです。フィルタ前の取得応答と掛け合わせて、同じ位置の応答を再計算できます。角度は0～360°に折り返しますが、異なる回転のデータは別の点として保持しています。','Weights sum over T at the object point. Combined with unfiltered acquired responses, they reproduce that response sample. Angles are folded into 0–360°, while samples from different turns retain separate identities.');
  if(r.weightAudit?.pairedSamples)document.getElementById('fdk-weight-scope').textContent=fdkText('○は実データ側、△は対向データ側です。各補間対象方向について、同じデータに掛かる重みを幅Tにわたり合算しています。同じデータが180°異なる方向で対向側として使われる場合も表示します。全方向の重みはExcel・JSONに保存します。','Circles: direct; triangles: complementary. For each output direction, weights on the same datum are summed over T. Reuse as complementary data for the opposing output direction is also shown. Excel and JSON retain full-direction weights.');
  document.getElementById('fdk-inspection-status').textContent=fdkText('展開図・重み・モデルSSPzは、選択した同じ開始角度に対応しています。','Geometry, weights and model SSPz now refer to the same selected start angle.');
  document.getElementById('fdk-summary').textContent=fdkText('全360条件の計算が完了しました。角度を選んで、候補データからSSPzまで確認できます。','All 360 conditions are complete. Select an angle to inspect the candidates, weights and SSPz.');
  const c=fdkResult.config;document.getElementById('fdk-result-config').textContent=`${c.rows} rows × ${c.rowWidth.toFixed(2)} mm / pitch ${c.beamPitch} / r = ${c.radius} mm / ${c.viewSamples} views/turn / 360 start angles / full fan Φ = ${c.fullFanAngleDeg}° / source support = ${fdkResult.model.sourceAngleSpanDeg??360+2*c.fullFanAngleDeg}° / T = axial averaging width = ${(c.axialAverageMm??0).toFixed(2)} mm`;
  document.getElementById('fdk-result-config').textContent+=` / axial focus = ${(c.focalSizeMm??0).toFixed(2)} mm / source–detector = ${c.focalSourceDetectorMm??1070} mm`;
  if(fdkResult.domainCheck?.expansions>0)document.getElementById('fdk-result-config').textContent+=fdkText(` / 裾の確認のため計算範囲を±${c.zExtent.toFixed(2)} mmに拡張`,` / calculation range expanded to ±${c.zExtent.toFixed(2)} mm to check tails`);
  renderZffsSelected();
  if(!geometryPlayback.playing)syncAxialMovie();
  fdkWorkflowAvailability(true);document.getElementById('fdk-json').disabled=false;document.getElementById('fdk-xlsx').disabled=false;
}
// Adapt the actual reconstruction audit to the established diagram renderer.
// Only the scene data differ; palette, opacity, marker size and layout are shared.
function drawFdkCandidateDiagram(canvas,r,zoom,reference=false,role='all',capture=false,options={}){
  if(r.config.zFfsEnabled&&!r.weightAudit?.pairedSamples)return drawZffsPanel(canvas,r,zoom?3:2);
  const c=r.config,audit=r.weightAudit,step=2*Math.PI/c.viewSamples;
  if(!audit)return;
  const paired=!!audit.pairedSamples,samples=paired?SSPZAngles.expand(audit.pairedSamples,c):audit.samples,base=Math.ceil(((c.feed?2*Math.PI*r.zObject/c.feed:0)-Math.PI)/step-1e-12);
  const frameExtent=r.diagramFrame?.extent;
  const first=Math.min(base,frameExtent?.minView??Math.min(...samples.map(q=>q.view))),last=Math.max(base+c.viewSamples,frameExtent?.maxView??Math.max(...samples.map(q=>q.view)));
  const rebinned=paired||r.coordinateSystem==='rebinned-theta'||!!r.reference;
  const physical=!zoom&&!rebinned;
  const rowMin=rebinned||physical?0:Math.min(...samples.map(q=>q.row))-2;
  const rowMax=rebinned||physical?c.rows-1:Math.max(...samples.map(q=>q.row))+2;
  const rows=rowMax-rowMin+1,angles=[],axial=[],scales=[],opposedAxial=[],opposedScales=[];
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
  const zoomLimit=Math.max(c.rowWidth,Math.ceil((frameExtent?.maxAbsZ??Math.max(...samples.map(q=>Math.abs(q.z))))*10)/10)*1.12;
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
    if(paired){
      const [opposedZ,opposedScale]=geometryAt(base+i+c.viewSamples/2);
      opposedAxial.push(opposedZ);opposedScales.push(opposedScale);
      for(const row of [0,rows-1]){
        const delta=opposedZ+opposedScale*rowOffsets[row]-r.zObject;
        minCentral=Math.min(minCentral,delta);maxCentral=Math.max(maxCentral,delta);
      }
    }
  }
  if(c.zFfsEnabled){
    const reach=c.zFfsSourceOffsetMm*(1+(1+c.radius/c.sourceRadius)/c.zFfsMagnification);
    extent+=reach;minCentral-=reach;maxCentral+=reach;
  }
  const xLimit=symmetricNiceAxis(options.sharedXLimit??(zoom?zoomLimit:extent),3).xMax;
  const turnMin=c.feed?Math.ceil((-xLimit-maxCentral)/c.feed):0;
  const turnMax=c.feed?Math.floor((xLimit-minCentral)/c.feed):0;
  const turns=Array.from({length:turnMax-turnMin+1},(_,i)=>turnMin+i);
  const angleRange=!options.fullTurn&&zoom&&typeof candidateDisplayRange==='function'?candidateDisplayRange():null;
  let stride=angleRange?1:Math.max(1,Math.ceil(c.viewSamples/72));
  if(paired)while((c.viewSamples/2)%stride!==0)stride++;
  const trace={id:'acquired',family:'direct',angles,axial,scales};
  const traceFamilies=[trace];
  if(paired)traceFamilies.push({id:'complementary-rebinned',family:'complementary',angles,axial:opposedAxial,scales:opposedScales});
  if(c.zFfsEnabled){
    for(const family of [...traceFamilies]){
      const original=family.axial;
      for(const focus of [0,1]){
        const offset=(focus?1:-1)*c.zFfsSourceOffsetMm;
        const axial=original.map((z,i)=>z+offset*(1-family.scales[i]*c.sourceRadius/c.zFfsSourceDetectorMm));
        if(focus===0)family.axial=axial;
        else traceFamilies.push({...family,id:family.id+'-focus-b',axial});
      }
    }
  }
  for(const t of traceFamilies)t.sourceAngles=angles.map((deg,i)=>{
    const theta=c.phase+(base+i+(t.family==='complementary'?c.viewSamples/2:0))*step;
    return rebinned&&c.axialRule!=='parallel'?theta+Math.asin(-c.radius*Math.sin(theta)/c.sourceRadius):theta;
  });
  const referenceView=q=>paired?q.referenceView:q.view;
  const diagram={totalRows:rows,z0:r.zObject,sourcePhase:c.phase,overviewXLimit:extent,zoomXLimit:zoomLimit,
    interpolationBandHalfWidth:(c.axialAverageMm??0)/2,
    traceGeometry:{...trace,rowOffsets,feed:c.feed,turns},traceFamilies,
    weightedPoints:zoom?samples.filter(q=>angleRange?fold(referenceView(q))>=angleRange.min-1e-9&&fold(referenceView(q))<angleRange.max-1e-9:((referenceView(q)-base)%stride+stride)%stride===0).map(q=>({
      x:q.z,y:fold(referenceView(q)),row:q.row-rowMin,focus:q.focus??0,weight:reference?q.referenceWeight:q.weight,
      referenceViewIndex:referenceView(q),absoluteViewIndex:q.view,traceFamilyId:(paired&&q.direction?'complementary-rebinned':'acquired')+(c.zFfsEnabled&&q.focus?'-focus-b':''),dataKind:'unfiltered-data'
    })):[],
    referenceViewSamples:c.viewSamples,renderedAngleSamples:Math.ceil(c.viewSamples/stride),acquiredTraceSamples:angles.length,
    xAxisLabel:fdkText('候補列中心  zᵢ − z₀  (mm)','Candidate row centre  zᵢ − z₀  (mm)'),
    yAxisLabel:rebinned?fdkText('再配列後の角度差  θ  (°)','Rebinned angle offset  θ  (°)'):fdkText('線源角度差  β  (°)','Source angle offset  β  (°)'),
    directLegendLabel:rebinned?fdkText('再配列データ ○','Rebinned data ○'):fdkText('取得データ ○','Acquired data ○'),
    overviewLegendLabel:fdkText('全{rows}列の幾何軌跡','Geometric trajectories: all {rows} rows').replace('{rows}',c.rows),
    weightLegendLabel:fdkText('合計重み w','Total weight w'),
    angleCoordinate:rebinned?'rebinned theta; relative to centre turn':'source beta; relative to centre turn'
  };
  if(angleRange){diagram.angleMin=angleRange.min;diagram.angleMax=angleRange.max;}
  const displayedDirections=new Set(diagram.weightedPoints.map(p=>p.y)).size;
  if(zoom&&role==='all'&&!reference&&!capture&&typeof document!=='undefined'){
    const status=document.getElementById('candidate-display-status');
    if(status)status.textContent=angleRange
      ?`${angleRange.min}°–${angleRange.max}°: ${displayedDirections} `+fdkText('方向を間引かず表示','directions, without subsampling')+` / ${diagram.weightedPoints.length} `+fdkText('点','points')
      :fdkText('計算した全','Displaying ')+`${c.viewSamples}`+fdkText('方向のうち',' calculated directions: ')+`${displayedDirections}`+fdkText('方向を表示。重みの付いた点：',' sampled. Weighted points: ')+`${diagram.weightedPoints.length} / ${samples.length}`+fdkText('点。',' points.');
  }
  if(paired){
    diagram.yAxisLabel=fdkText('補間対象方向の角度差 (°)','Output interpolation direction (°)');
    diagram.directLegendLabel=fdkText('実データ側 ○','Direct ○');
    diagram.weightLegendNote=fdkText('各方向で幅Tの重みを合算。対向側の角度は±180°。','T-summed weights per output direction; opposing data: ±180°.');
    diagram.angleCoordinate='full-turn output interpolation direction; complementary at theta +/- pi; relative to centre turn';
  }
  if(!zoom&&!paired)diagram.directLegendLabel=rebinned?fdkText('再配列後の列軌跡','Rebinned row trajectories'):fdkText('検出器列の軌跡','Detector-row trajectories');
  if(!rebinned&&zoom){
    diagram.rowLegendLabel=fdkText('仮想平面列','Virtual row');
    diagram.rowLabels=Array.from({length:rows},(_,i)=>rowMin+i);
    diagram.directLegendLabel=fdkText('仮想平面データ ○','Flat-grid data ○');
    diagram.weightLegendNote=fdkText('仮想平面上の行補間重み。軌道の重なりは混色。','Flat-grid row weights; trace overlaps blend.');
  }
  canvas.dataset.renderScale=String(canvas.width/900);
  // Split the same scene by role; axis limits and each retained weight stay fixed.
  diagram.visibleRole=role;
  if(role!=='all'){
    diagram.traceFamilies=diagram.traceFamilies.filter(t=>t.family===role);
    diagram.weightedPoints=diagram.weightedPoints.filter(p=>p.traceFamilyId.startsWith('complementary-')===(role==='complementary'));
  }
  if(capture)return diagram;
  drawDiagram(canvas,diagram,zoom?'zoom':'overview');
  canvas.dataset.visibleRole=role;
  canvas.dataset.constructionProgress='1';
  for(const key of Object.keys(canvas.dataset))if(canvas.dataset[key]==='undefined')delete canvas.dataset[key];
  canvas.dataset.renderState='ready';
  canvas.dataset.complementaryMarkerShape=paired?'triangle':'not-applicable-in-own-angle-coordinate';
  canvas.dataset.complementaryLineStyle=paired?'dashed':'not-applicable-in-own-angle-coordinate';
  canvas.dataset.startIndex=selectedStateIndex;canvas.dataset.auditSamples=samples.length;
  canvas.dataset.displayedDirections=String(displayedDirections);canvas.dataset.displayStride=String(stride);
  canvas.dataset.markerEncoding='fixed-radius;row-colour;weight-fill';
  canvas.dataset.familyEncoding=paired?'direct solid/circle; complementary dashed/triangle; common direct-side rebinned angle':'each sample at its own acquired angle; no direct-reference folding';
  if(paired)canvas.dataset.diagramDisplayVersion='2026-09-18.16';
  canvas.dataset.backgroundTraceScope='geometric-context-independent-of-selected-weight-support';
  canvas.dataset.backgroundTurns=turns.join(',');
}
function fdkArrow(a,fw,level,color){const {ctx,s}=a,yy=a.y(level);ctx.strokeStyle=color;ctx.lineWidth=2*s;ctx.setLineDash([5*s,5*s]);for(const v of [fw.left,fw.right]){ctx.beginPath();ctx.moveTo(a.x(v),a.b.bottom);ctx.lineTo(a.x(v),yy);ctx.stroke();}ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(a.x(fw.left),yy);ctx.lineTo(a.x(fw.right),yy);for(const [v,d] of [[fw.left,1],[fw.right,-1]]){ctx.moveTo(a.x(v)+d*9*s,yy-6*s);ctx.lineTo(a.x(v),yy);ctx.lineTo(a.x(v)+d*9*s,yy+6*s);}ctx.stroke();}
function addFdkWorkflowSheets(sheets){
  sheets[0][1]=sheets[0][1].filter(([key])=>!['volume_storage','sample_weights_scope'].includes(key));
  sheets[0][1].push(['selected_start_index',selectedStateIndex],['start_angle_sweep','base phase + 0..359 degrees; object z fixed'],['volume_storage','No image volume; JSON stores selected-angle response and weights'],['thickness_definition','Configured thickness T is the rectangular averaging width; FWHM is measured from the resulting SSPz, not prescribed'],['first_angle_weights','Sample_weights contains the unaveraged centre snapshot at index 0; Selected_weights includes the response-average window at the inspected angle']);
  const r=fdkSelectedResult;if(!r?.weightAudit)return;
  if(r.acquisition.centreWindow){
    sheets.push(['Source_support',[['plane_z_relative_mm','source_beta_min_rad','source_beta_max_rad','first_acquired_view','last_acquired_view_inclusive'],
      ...[[-r.config.axialAverageMm/2,r.acquisition.averagingWindowStart],[0,r.acquisition.centreWindow],[r.config.axialAverageMm/2,r.acquisition.averagingWindowEnd]].map(([z,w])=>[z,w.betaMin,w.betaMax,w.firstView,w.lastView])]]);
  }
  if(r.config.zFfsEnabled){sheets.push(['zFFS_acquired_weights',zffsWeightRows(r)]);sheets.push(['zFFS_rebinned_weights',[['view_index','focus','row_index','theta_rad','beta_rad','z_relative_mm','weight','rebinned_value'],...r.rebinnedWeightAudit.map(q=>[q.view,q.focus?'B':'A',q.row,q.theta,q.beta,q.z,q.weight,q.acquiredValue])]]);}
  sheets[0][1].push(['selected_weight_scope',r.weightAudit.definition]);
  if(r.weightAudit.pairedSamples){
    sheets[0][1].push(['paired_diagram','Full-turn output interpolation directions. Directional_weights uses angular factor 1/V; legacy Paired_weights and Selected_weights use 2/V. Alternative representations of the same response: do not add sheets together. Direction families are separated by V/2 modulo V; actual acquisition turns remain explicit.']);
    sheets.push(['Paired_weights',[['start_index','reference_view_unwrapped','direction','rebinned_view_unwrapped','focus','row_index','reference_theta_rad','rebinned_theta_rad','source_angle_rad','z_relative_mm','weight','angular_mean_factor','unfiltered_acquired_value'],...r.weightAudit.pairedSamples.map(q=>[selectedStateIndex,q.referenceView,q.direction?'complementary':'direct',q.view,q.focus??0,q.row,r.config.phase+q.referenceView*2*Math.PI/r.config.viewSamples,q.theta,q.beta,q.z,q.weight,r.weightAudit.db,q.acquiredValue])]]);
    const directional=SSPZAngles.weightAudit(r);
    sheets.push(['Directional_weights',[['start_index','output_view_unwrapped','opposite_views_unwrapped','direction','rebinned_view_unwrapped','focus','row_index','output_theta_rad','rebinned_theta_rad','source_angle_rad','z_relative_mm','weight','angular_mean_factor','unfiltered_acquired_value'],...directional.samples.map(q=>[selectedStateIndex,q.referenceView,q.oppositeViews.join(';'),q.direction?'complementary':'direct',q.view,q.focus??0,q.row,r.config.phase+q.referenceView*2*Math.PI/r.config.viewSamples,q.theta,q.beta,q.z,q.weight,directional.angularMeanFactor,q.acquiredValue])]]);
  }
  sheets.push(['Selected_weights',[['start_index','view_unwrapped','row_index','theta_rad','source_angle_rad','z_relative_mm',r.model?.kind==='rri'?'RRI_weight':'weight',...(r.reference?['reference_weight']:[]),'angular_mean_factor','unfiltered_acquired_value'],...r.weightAudit.samples.map(q=>[selectedStateIndex,q.view,q.row,q.theta,q.beta,q.z,q.weight,...(r.reference?[q.referenceWeight]:[]),r.weightAudit.db,q.acquiredValue])]]);
}
async function exportFdkWorkflowCanvas(id){
  if(!fdkSelectedResult)return;const source=document.getElementById(id),c=document.createElement('canvas'),diagram=id.startsWith('fdk-geometry')||id.startsWith('fdk-weights');c.width=Math.round((diagram?80:180)/25.4*600);c.height=Math.round(c.width*source.height/source.width);
  const role=id.endsWith('-complementary')?'complementary':id.endsWith('-direct')?'direct':'all';
  if(id.startsWith('fdk-geometry')&&geometryPlayback.scene){
    stopGeometryPlayback();c.dataset.renderScale=String(c.width/900);
    const p=geometryPlayback,cutoff=p.fraction>=1?null:p.window.start+p.fraction*(p.window.end-p.window.start);
    drawDiagram(c,SSPZConstruction.role(p.scene,role,cutoff),'overview');
  }
  else if(id.startsWith('fdk-geometry'))drawFdkCandidateDiagram(c,fdkSelectedResult,false,false,role);
  else if(id.startsWith('fdk-weights'))drawFdkCandidateDiagram(c,fdkSelectedResult,true,id.endsWith('rri'),role);
  else drawFdkDifference(c,fdkResult);
  const frame=id.startsWith('fdk-geometry')&&geometryPlayback.scene&&geometryPlayback.fraction<1?`_draw-${Math.round(geometryPlayback.fraction*1000)}`:'';
  const range=id.startsWith('fdk-weights')?candidateDisplayRange():null,detail=range?`_directions-${range.min}-${range.max}`:'';
  const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob(`${fdkFileStem(fdkResult)}_${id}_angle-${selectedStateIndex}${frame}${detail}_600dpi.png`,await pngWithResolution(blob,600),'image/png');
}

// Integrated UI for the browser worker, using the existing shared form,
// geometry conventions, XLSX writer and PNG resolution metadata.
const FDK_UI_FIELDS={method:'rri',edgePolicy:'available',axialAverageMm:0,objectModel:'point',
  xyExtent:1.5,xySamples:17,zExtent:3,zStep:.05,phaseCount:360,phase:0,state:0,fullFanAngleDeg:50,normalization:'minmax'};
let fdkResult=null;
let fdkShapeGroups=null;
const fdkMethodName=r=>({'axial-merged':'Merged axial','axial-rri':'Cone geometry','axial-parallel':'Parallel reference'}[r.model?.kind]??'Legacy FBP')+(r.config?.zFfsEnabled?' + z-FFS':'');
const fdkGroups=r=>r.reference?[['CBA',r],['RRI',r.reference]]:[[fdkMethodName(r),r]];
const fdkSheetPrefix=name=>name.includes('z-FFS')?name.replace(' + z-FFS','_FFS').replace(' axial',''):name;
const fdkFileStem=r=>(r.reference?'Hsieh_CBA_RRI':fdkMethodName(r))+'_point_T'+(r.config.sliceThicknessMm??r.config.axialAverageMm)+'mm_focus-'+(r.config.focalSizeMm??0)+'mm';
function fdkWidthStats(r){const v=r.profiles.map(p=>p.fwhm.width),mean=v.reduce((s,x)=>s+x,0)/v.length;return {mean,sd:v.length>1?Math.sqrt(v.reduce((s,x)=>s+(x-mean)**2,0)/(v.length-1)):null,min:Math.min(...v),max:Math.max(...v)};}
const fdkWidthAnnotation=(mean,sd)=>sd===null?`${mean.toFixed(2)} mm`:sd<.001?`${mean.toFixed(2)} mm; SD < 0.001 mm`:`${mean.toFixed(2)} ± ${sd.toFixed(3)} mm`;
function fdkProfileRows(r){const groups=fdkGroups(r);return [['z_position_mm',...groups.flatMap(([name,g])=>g.profiles.flatMap((_,i)=>[name+'_raw_'+i,name+'_normalized_'+i]))],...Array.from(r.z,(z,i)=>[z,...groups.flatMap(([,g])=>g.profiles.flatMap(p=>[p.raw[i],p.profile[i]]))])];}
const fdkText=(ja,en)=>document.documentElement.lang.startsWith('en')?en:ja;
function syncSharedFocalControls(){
  const R=Number(form.elements.namedItem('sourceRadius')?.value),radius=Number(form.elements.namedItem('radius')?.value),focal=Number(form.elements.namedItem('focalSizeMm')?.value),distance=form.elements.namedItem('focalSourceDetectorMm'),D=Number(distance?.value);
  if(distance&&Number.isFinite(R))distance.min=String(R+(focal>0?radius:0)+1);
  const ratio=document.getElementById('zffs-magnification');
  if(ratio&&R>0&&Number.isFinite(D))ratio.value=String(D/R);
}
function fdkCsvRows(r){return [
  ['# model_version',r.model.version],
  ['# focalSizeMm',r.config.focalSizeMm??0],
  ['# focalSourceDetectorMm',r.config.focalSourceDetectorMm??1070],
  ['# focal_model_metadata',JSON.stringify(r.model.focalBlur??{})],
  ['# configuration',JSON.stringify(spatialExport(r).config)],
  ['# axial_domain_check',JSON.stringify(r.domainCheck??{})],
  ['# focal_model','uniform effective axial source integrated over acquired detector cells before interpolation; unit total source weight'],
  ['# focal_reference','CT and MRI Fig.6.6; target-angle dependence not modelled'],
  ...fdkProfileRows(r),
];}
function syncFdkMethodControls(){syncZffsUi();const method=document.getElementById('fdk-method');if(!method)return;for(const key of ['edgePolicy'])document.getElementById('fdk-'+key).disabled=runButton.disabled||method.value!=='rri';}
function readFdkParams(){
  syncSharedFocalControls();
  const out={computationModel:'fdk'};
  for(const [k,v] of Object.entries(FDK_UI_FIELDS)){
    const e=document.getElementById('fdk-'+k);out[k]=e?(typeof v==='number'?Number(e.value):e.value):v;
  }
  out.axialAverageMm=Number(form.elements.namedItem('sliceThicknessMm').value);
  out.axialRule='rri';
  out.comparisonMode='matched-rri';
  const d=Number(form.elements.namedItem('rowWidth').value),r=Number(form.elements.namedItem('radius').value),R=Number(form.elements.namedItem('sourceRadius').value);
  out.focalSizeMm=Number(form.elements.namedItem('focalSizeMm').value);
  out.focalSourceDetectorMm=Number(form.elements.namedItem('focalSourceDetectorMm').value);
  out.zExtent=Math.max(1,out.axialAverageMm+2*d*(1+r/R));
  // Retain the entire finite-focus support in addition to the aperture and
  // averaging support. The parallel reference uses the centre-projected width.
  const focalScale=out.axialRule==='parallel'?Math.abs(1-R/out.focalSourceDetectorMm):Math.max(Math.abs(1-(R-r)/out.focalSourceDetectorMm),Math.abs(1-(R+r)/out.focalSourceDetectorMm));
  out.zExtent+=out.focalSizeMm*focalScale/2;
  out.state=0;out.method='rri';
  out.objectModel='point';
  out.thicknessMapping='configured-rectangular';
  out.phaseCount=360;
  Object.assign(out,readZffsParams());
  if(out.zFfsEnabled)out.zExtent+=2*out.zFfsOffset*d/(1-1/out.zFfsMagnification);
  return out;
}
function writeFdkUrl(url,p){
  url.searchParams.set('model','rri');
  url.searchParams.set('response','axial-interpolation');
  for(const k of ['zffs','zffs_m','zffs_a'])url.searchParams.delete(k);
  if(p.zFfsEnabled){url.searchParams.set('zffs','1');url.searchParams.set('zffs_m',p.zFfsMagnification);url.searchParams.set('zffs_a',p.zFfsOffset);}
  for(const key of ['nf','pm','rp','nz',...Object.keys(FDK_UI_FIELDS).map(k=>'fdk_'+k)])url.searchParams.delete(key);
  for(const k of ['edgePolicy','zStep','phase','fullFanAngleDeg','normalization'])url.searchParams.set('fdk_'+k,p[k]??FDK_UI_FIELDS[k]);
}
function fdkParamsFromUrl(q){
  const out={computationModel:'fdk',coneOnlyMigrated:q.get('model')==='parallel',legacyResponse:!!q.get('v')&&Number(q.get('v'))<11};
  for(const [k,v] of Object.entries(FDK_UI_FIELDS))out[k]=q.has('fdk_'+k)?(typeof v==='number'?Number(q.get('fdk_'+k)):q.get('fdk_'+k)):v;
  out.zFfsEnabled=q.get('zffs')==='1';out.zFfsMagnification=Number(q.get('zffs_m')??1072/600);out.zFfsOffset=Number(q.get('zffs_a')??.25);
  if(q.has('fd'))out.zFfsMagnification=Number(q.get('fd'))/Number(q.get('R')??600);
  out.comparisonMode='matched-rri';
  out.matchedComparisonMigrated=(q.has('v')&&Number(q.get('v'))<14)||q.get('model')==='axial';
  out.sourceSupportMigrated=!!q.get('v')&&Number(q.get('v'))<12;
  out.phaseCount=360;
  out.legacyCbaComparison=out.method==='hsieh';
  if(out.legacyCbaComparison)out.method='rri';
  out.legacySphereInput=q.get('fdk_objectModel')!=='point';
  out.objectModel='point';
  return out;
}
function initializeFdkUi(initial){
  initial={...initial,coneOnlyMigrated:initial.coneOnlyMigrated||initial.computationModel==='parallel',computationModel:'fdk',matchedComparisonMigrated:initial.matchedComparisonMigrated||!!initial.computationModel&&initial.comparisonMode!=='matched-rri',method:'rri'};
  const modelChoice=initializeAxialModelChoice(initial),pick=modelChoice.element;
  form.prepend(pick);
  const controls=document.createElement('div');controls.id='fdk-controls';controls.className='fdk-controls';
  controls.innerHTML=`<p class="section-summary">${fdkText('共通の点対象・検出器開口から、候補の選択と体軸補間によるモデルSSPzを求めます。横断画像は再構成しません。','Model SSPz is the axial interpolation response of a shared point object and detector aperture. No transverse image is reconstructed.')}</p>
  <details class="reading-details"><summary>${fdkText('補間規則と共通の計算設定','Interpolation rules and shared numerical settings')}</summary>
  <p>${fdkText('実・対向方向ごとに隣接列を線形補間し、有効な重み全体を正規化します（RRI：row-to-row interpolation相当）。X線管角360°＋2Φの有限取得範囲を使います。Φは全ファン角です。','Adjacent rows are interpolated within each direction, with all valid weights normalized (RRI-equivalent row-to-row interpolation). Finite tube-angle support is 360° + 2Φ, where Φ is the full fan opening.')}</p>
  <p>${fdkText('焦点寸法は『CTとMRI』図6.6の実効焦点1.2 × 1.2 mmのうち体軸方向の1.2 mmを参照します。焦点内の各位置から固定した検出器開口に入る信号を平均し、その取得応答に補間を適用します。ターゲット角7°による方向依存性や面内方向の焦点ぼけは含めません。','The effective axial focal size defaults to 1.2 mm from the 1.2 × 1.2 mm focus in CT and MRI Fig.6.6. Signals from uniformly distributed positions within the focus are averaged within each fixed detector cell before interpolation. Directional changes due to the 7° target angle and transverse focal blur are omitted.')}</p>
  <div class="parameter-grid">
  <input type="hidden" id="fdk-method" value="rri"><input type="hidden" id="fdk-objectModel" value="point"><input type="hidden" id="fdk-axialAverageMm" value="1"><input type="hidden" id="fdk-xyExtent" value="0.5"><input type="hidden" id="fdk-xySamples" value="5"><input type="hidden" id="fdk-zExtent" value="3"><input type="hidden" id="fdk-state" value="0"><input type="hidden" id="fdk-phaseCount" value="360">
  <label>${fdkText('全ファン角 Φ (°)','Full fan opening Φ (°)')}<input id="fdk-fullFanAngleDeg" type="number" min="1" max="179" step="0.1" value="50"><small>${fdkText('取得範囲は360°＋2Φ。初期値50°はモデル設定であり、装置固有値ではありません。','Source support is 360° + 2Φ. The default 50° is a model setting, not a scanner specification.')}</small></label>
  <label>${fdkText('体軸方向の計算間隔 (mm)','Axial calculation spacing (mm)')}<input id="fdk-zStep" type="number" min="0.01" max="0.2" step="0.01" value="0.05"></label>
  <label>${fdkText('基準開始角度 (rad)','Base start angle (rad)')}<input id="fdk-phase" type="number" min="0" max="6.28318530718" step="0.01" value="0"></label>
  <label>${fdkText('検出器端の扱い','Detector-edge policy')}<select id="fdk-edgePolicy"><option value="available">${fdkText('取得済みの列を使用','Use acquired rows')}</option><option value="strict">${fdkText('選択した方向の隣接列を要求','Require complete selected brackets')}</option></select></label>
  <label>${fdkText('正規化','Normalization')}<select id="fdk-normalization"><option value="minmax">${fdkText('最小値0・最大値1','Minimum 0, maximum 1')}</option><option value="peak">${fdkText('最大値1','Peak 1')}</option></select></label>
  </div><p>${fdkText('対象の位置を固定し、開始角度を1°間隔で360条件計算します。設定厚Tは体軸方向の矩形平均幅です。計算範囲はT、検出器列幅、焦点ぼけ幅から裾を含むように決めます。','The object stays fixed while all 360 start angles are evaluated at 1-degree increments. T is the rectangular axial averaging width. The profile domain includes the tails from T, detector-row width and focal blur.')}</p>
  <p><a href="${fdkText('methods.html?topic=axial','methods.html?topic=axial&lang=en')}">${fdkText('計算式と適用範囲','Equations and scope')}</a> · <a href="https://doi.org/10.1117/1.2746866">Hsieh et al. (2007)</a></p></details>`;
  form.append(controls);
  if(initial.coneOnlyMigrated||initial.matchedComparisonMigrated){const note=document.createElement('p');note.className='model-note';note.id='matched-comparison-migration';note.textContent=fdkText('旧モデルの条件を読み込みました。現在の画面はコーン幾何に固定し、評価位置を変えて比較します。旧モデルの保存結果とは区別してください。','Older model settings loaded. This interface now uses cone geometry with position comparison. Keep results from the old model separate.');controls.prepend(note);}
  if(initial.sourceSupportMigrated){const note=document.createElement('p');note.className='model-note';note.textContent=fdkText('取得範囲の判定を再配列角360°からX線管角360°＋2Φへ修正しました。旧版とは候補・重み・SSPzが変わる場合があります。全ファン角を確認して再計算してください。','Source support now uses tube angles over 360° + 2Φ instead of one rebinned turn. Candidates, weights and SSPz may differ from older results. Check the full fan opening and recalculate.');controls.prepend(note);}
  if(initial.legacyResponse){const note=document.createElement('p');note.className='model-note';note.id='axial-response-migration';note.textContent=fdkText('旧版の条件を読み込みました。現在は共通の体軸補間応答モデルで計算するため、従来のFBP・体軸モデルの保存結果とは数値が異なります。','Older settings loaded. The current shared axial interpolation model produces different values from previous FBP and axial results.');controls.prepend(note);}
  document.getElementById('fdk-method').setAttribute('aria-describedby','fdk-controls');
  document.getElementById('fdk-method').addEventListener('change',syncFdkMethodControls);
  for(const [k,v] of Object.entries(FDK_UI_FIELDS))document.getElementById('fdk-'+k).value=initial[k]??v;
  document.getElementById('fdk-objectModel').value='point';
  document.getElementById('fdk-phaseCount').value=360;
  syncFdkMethodControls();updateInputDecorations();
  const panel=document.createElement('section');panel.id='fdk-panel';panel.setAttribute('aria-labelledby','fdk-title');
  panel.innerHTML=`<div class="section-heading"><h2 id="fdk-title">${fdkText('展開図から体軸補間応答へ','From candidate geometry to axial response')}</h2></div>
  <p class="section-summary">${fdkText('展開図の候補と補間重みから、モデルSSPzとその変動を示します。コーン幾何のもとで評価位置を変更し、データ配置と応答の位置依存性を調べます。','Candidate positions and interpolation weights lead to the model SSPz and its variation. Move the evaluation point within cone geometry to examine position-dependent data geometry and response.')} <a href="#fdk-controls">${fdkText('補間規則の説明','Interpolation rules')}</a></p>
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
  <details class="reading-details"><summary>${fdkText('方法・解釈の範囲','Method and interpretation')}</summary><p>${fdkText('モデルSSPzは、有限検出器開口と設定した焦点寸法を反映した点対象の取得応答に、候補の選択・線形補間を適用し、角度方向に平均して求めます。面内のランプフィルタ、FBPの幾何重み、横断画像の再構成は含みません。3次元画像再構成後のSSPやTCOTを再現するものではありません。','Model SSPz applies candidate selection, linear interpolation and angular averaging to point-object measurements with the finite detector aperture and configured axial focal size. It omits the transaxial ramp, FBP geometric weights and transverse image reconstruction. It is not the image SSP of 3D FBP or TCOT.')}</p><p>${fdkText('位置による応答の違いには、幾何に加えて再配列・開口・焦点ぼけ・補間の影響が含まれます。設定厚Tの矩形平均後に正規化し、元の計算点間の直線交点からFWHM・FWTMを求めます。FWHMをTに合わせる調整はしません。','Position-dependent responses reflect geometry together with rebinning, aperture, focal blur and interpolation. Normalization follows rectangular T averaging; widths use linear crossings between native samples. FWHM is not fitted to T.')}</p><p>${fdkText('80～320列も計算できますが、広角コーンビームの画像再構成精度を検証するモデルではありません。','80–320 rows are supported; this model does not evaluate the accuracy of wide-cone image reconstruction.')}</p><a href="${fdkText('methods.html?topic=axial','methods.html?topic=axial&lang=en')}">${fdkText('計算方法と確認記録','Method and verification')}</a></details>`;
  panel.insertAdjacentHTML('beforeend',`<div id="cba-samples-wrap" class="chart-card" hidden><h3>${fdkText('補間に使うサンプルと重み：点の位置位置（画像平均化前）','Interpolation samples and weights before image averaging')}</h3><canvas id="cba-samples" width="1200" height="700"></canvas><p>${fdkText('青：RRI、赤：CBA。点の面積は正規化した重みです。横軸は点の位置からの距離。各対向ペアの補間候補を、再配列後の角度で示します。これは中心位置の局所的な重みであり、SSPz全体の寄与率ではありません。','Blue: RRI; red: CBA. Marker area represents normalized weight. The interpolation candidates in each conjugate pair are shown at the rebinned angle and relative to the object point. These are local weights at the central point, not total contributions to SSPz.')}</p></div><p><a href="${fdkText('methods.html?topic=axial','methods.html?topic=axial&lang=en')}">${fdkText('RRI相当の線形補間：計算方法と適用範囲','RRI-equivalent interpolation: equations and scope')}</a> · <a href="https://doi.org/10.1117/1.2746866" target="_blank" rel="noopener noreferrer">Hsieh et al. (2007)</a></p>`);
  document.querySelector('.control-shell').after(panel);
  initializeFdkWorkflow(panel);
  const viewHelp=document.querySelector('#viewSamples')?.parentElement.querySelector('small');
  const axialViewHelp=viewHelp?.textContent;
  function modeChanged(){
    modelChoice.sync();
    const hadResultOrPending=!!fdkResult||loadingCanvasStatuses.size>0;
    fdkInspectionRequest++;clearTimeout(fdkInspectionTimer);releaseWorker();if(runButton.disabled)setBusy(false);
    const on=Number(form.elements.namedItem('beamPitch').value)>0;controls.hidden=false;panel.hidden=!on;
    if(hadResultOrPending){fdkResult=null;fdkSelectedResult=null;fdkShapeGroups=null;fdkToggleDownloads(false);for(const cv of panel.querySelectorAll('canvas'))drawCanvasStatus(cv,'Axial interpolation',fdkText('条件を変更しました。再計算してください。','Settings changed. Recalculate.'),'idle');}
    document.querySelectorAll('main > section').forEach(s=>{if(s!==panel&&s.id!=='taguchi-tsp'&&s.id!=='sspz-variation'&&!s.classList.contains('control-shell')&&!s.querySelector('#reference-title'))s.hidden=on;});
    document.getElementById('sspz-variation').hidden=!on;
    for(const k of ['filterSamples','profileMode','reconstructionPath','zSamples'])document.getElementById(k)?.closest('label')?.toggleAttribute('hidden',on);
    const help=document.querySelector('#beamPitch')?.parentElement.querySelector('small');if(help)help.hidden=on;
    if(viewHelp)viewHelp.textContent=on?fdkText('1回転の実取得ビュー数です。周辺の点応答はビュー数の影響を受けます。720・1440・2400で結果の変化を確認できます。','Acquired views per full turn. Off-centre point responses are sensitive to view sampling; compare 720, 1440 and 2400 views.'):axialViewHelp;

    syncZffsUi();
    if(!runButton.disabled)status.textContent=fdkText('コーン幾何で評価位置を比較します。','Compare evaluation positions using cone geometry.');
  }
  initializeZffsUi(initial,()=>{modeChanged();if(document.getElementById('position-preview'))schedulePositionPreview();});
  pick.querySelector('select').addEventListener('change',modeChanged);form.elements.namedItem('beamPitch').addEventListener('change',()=>{modeChanged();if(document.getElementById('position-preview'))schedulePositionPreview();});modeChanged();
  resetButton.addEventListener('click',()=>{pick.querySelector('select').value='fdk';for(const [k,v] of Object.entries(FDK_UI_FIELDS))document.getElementById('fdk-'+k).value=v;modeChanged();});
  document.getElementById('fdk-csv').onclick=()=>{const r=fdkResult;if(!r)return;downloadBlob(fdkFileStem(r)+'_SSPz.csv','\uFEFF'+fdkCsvRows(r).map(row=>row.map(csvEscape).join(',')).join('\r\n'));};
  document.getElementById('fdk-json').onclick=()=>{if(fdkSelectedResult)downloadBlob(fdkFileStem(fdkResult)+'_angle-'+selectedStateIndex+'_response.json',JSON.stringify({seriesConfig:spatialExport(fdkResult).config,seriesDomainCheck:fdkResult.domainCheck,selectedIndex:selectedStateIndex,result:spatialExport(fdkSelectedResult),directionalWeightAudit:SSPZAngles.weightAudit(fdkSelectedResult)},(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v),'application/json');};
  document.getElementById('fdk-xlsx').onclick=async()=>{
    const r=fdkResult;if(!r)return;
    const sheets=[['Readme',[['Item','Value'],['version',r.model.version],['axial_domain_check',JSON.stringify(r.domainCheck??{})],...Object.entries(r.model).map(([key,value])=>[key,typeof value==='object'?JSON.stringify(value):value]),...Object.entries(spatialExport(r).config).filter(([key])=>!['sphereDiameter','apertureSamples'].includes(key)),['detector_spacing','channelWidth is detector-center spacing; channelApertureMm is physical active width; both at isocenter, distinct from image pixels'],['coordinate','z relative to object point (mm); no FWHM alignment'],['readout','fixed transverse object location; one point sample per z; no disk ROI average'],['raw_profile','unfiltered axial interpolation response of a shared point object; finite focal blur is applied during acquisition before interpolation and T averaging'],['focal_normalization','uniform source with unit total weight; focalSizeMm=0 is the historical point-source limit'],['focal_reference','CT and MRI Fig.6.6: effective axial size 1.2 mm; 7-degree directional target effects and transverse focal blur omitted'],['normalization_baseline',r.baseline],['width_definition','each normalized native profile; linear threshold crossings'],['volume_storage','No image volume; selected-angle response and weight trace'],['precision','Unrounded Float64 values; display precision is not measurement accuracy']]],
      ['SSPz',fdkProfileRows(r)],
      ...fdkGroups(r).map(([name,g])=>[fdkSheetPrefix(name)+'_Mean_difference',[['z_position_mm','mean_normalized',...g.profiles.map((_,i)=>'difference_'+i)],...Array.from(g.z,(z,i)=>[z,g.mean[i],...g.meanDifference.map(p=>p[i])])]]),
      ['Widths',[['method','start_angle_rad','FWHM_mm','FWTM_mm','normalization_baseline'],...fdkGroups(r).flatMap(([name,g])=>g.profiles.map(p=>[name,p.phase,p.fwhm.width,p.fwtm.width,p.baseline]))]]];
    if(r.reference){sheets[0][1].push(['CBA','Conjugate backprojection algorithm: jointly weighted conjugate detector-row samples'],['RRI','Row-to-row interpolation: linear interpolation between adjacent detector rows; matched reference with shared edge extension'],['comparison','CBA and RRI share acquired projections, rebinning, filter, image grid and fixed-point readout; CBA power 2, RRI power 1'],['sample_weights_scope','first angle; object point voxel; local row interpolation only']);sheets.push(['Sample_weights',[['pair_angle_deg','source_angle_rad','conjugate_source_angle_rad','sample','z_relative_mm','CBA_weight','RRI_weight','CBA_weighted_distance_mm','RRI_weighted_distance_mm'],...r.sampleAudit.flatMap(v=>v.z.map((z,i)=>[v.relativeAngleDeg,v.beta,v.betaConjugate,i,z,v.weights[i],v.rriWeights[i],v.weightedDistance,v.rriWeightedDistance]))]]);}
    if(r.model.kind.startsWith('axial-')){
      sheets[0][1].push(['RRI','Row-to-row interpolation; linear weights with an explicit acquired-row edge extension']);
      sheets.push(['Sample_weights',[['output_pair_angle_deg','selected_rebinned_view','selected_source_angle_rad','sample','z_relative_mm','interpolation_weight',...(r.config.zFfsEnabled?['focus']:[])],...r.sampleAudit.flatMap(v=>v.z.map((z,i)=>[v.relativeAngleDeg,v.views?.[i]??'',v.betas?.[i]??'',i,z,v.weights[i],...(r.config.zFfsEnabled?[v.focus[i]?'B':'A']:[])]))]]);
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
  stopPositionPreview();document.getElementById('fdk-panel').hidden=false;
  beginPositionSeries();
  const params={...readParams(),...readFdkParams()};
  for(const id of ['fdk-profile-step','fdk-shape-step'])document.getElementById(id).hidden=false;
  fdkRunParams=params;
  releaseWorker();clearError();lastResult=null;fdkResult=null;fdkSelectedResult=null;fdkInspectionRequest++;clearTimeout(fdkInspectionTimer);fdkShapeGroups=null;fdkToggleDownloads(false);setBusy(true);
  document.getElementById('fdk-summary').textContent=fdkText('体軸補間応答を計算中…','Computing axial response…');document.getElementById('fdk-result-config').textContent='';
  for(const canvas of document.querySelectorAll('#fdk-panel canvas'))drawCanvasStatus(canvas,'Axial interpolation',fdkText('計算中','Calculating'));
  if(!document.getElementById('sspz-variation').dataset.resultSettings){document.getElementById('fdk-shape-wrap').hidden=true;document.getElementById('fdk-shape-summary').textContent='';document.getElementById('fdk-difference-wrap').hidden=true;}
  document.getElementById('cba-samples-wrap').hidden=true;document.getElementById('cba-comparison').hidden=true;
  startedAt=performance.now();progress.value=0;
  const url=paramsToUrl(params);try{history.replaceState(null,'',url);localStorage.setItem('sspz-unwrapped-params',JSON.stringify(params));}catch{}
  syncLanguageLinks(url.search);worker=createComputationWorker();
  const activeWorker=worker;
  const fail=text=>{if(worker!==activeWorker)return;failPositionSeries(text);setBusy(false);fdkToggleDownloads(false);showError(text);status.textContent=fdkText('計算を完了できませんでした','Calculation could not be completed');document.getElementById('fdk-summary').textContent=text;for(const c of document.querySelectorAll('#fdk-panel canvas'))drawCanvasStatus(c,'Axial interpolation',fdkText('有効な応答なし','No valid response'),'error');releaseWorker();};
  worker.onmessage=({data:m})=>{
    if(worker!==activeWorker)return;
    if(m.type==='progress'){progress.value=m.value;status.textContent=m.label;positionSeriesProgress(fdkText(`360開始角度を準備中：${Math.floor(m.value*360)} / 360`,`Preparing start angles: ${Math.floor(m.value*360)} / 360`));}
    else if(m.type==='domain-expansion'){progress.value=0;status.textContent=fdkText(`裾を確認するため、計算範囲を±${m.extentMm.toFixed(2)} mmに広げて再計算しています。`,`Recomputing all angles over ±${m.extentMm.toFixed(2)} mm to check the response tails.`);document.getElementById('fdk-summary').textContent=status.textContent;}
    else if(m.type==='fdk-result'){
      preparePositionSeries(m.result);
      if(m.result.geometryOnly){
        fdkResult=m.result;fdkSelectedResult=m.result;selectedStateIndex=0;progress.value=1;setBusy(false);fdkToggleDownloads(false);
        document.getElementById('fdk-profile-step').hidden=true;
        updateSspzVariation('unavailable');
        document.getElementById('fdk-rri-weights-card').hidden=true;
        document.getElementById('fdk-primary-weight-title').textContent=fdkMethodName(m.result);
        drawFdkRoleDiagrams(m.result);
        prepareGeometryConstruction();
        document.querySelectorAll('[data-fdk-canvas^="fdk-geometry"],[data-fdk-canvas^="fdk-weights-primary"]').forEach(b=>b.disabled=false);
        status.textContent=fdkText('取得応答がないため、展開図のみ表示します。','No acquired point response; geometry only.');
        document.getElementById('fdk-summary').textContent=fdkText('点対象の信号を取得できません。検出器開口・隙間・標本間隔を確認してください。候補配置と重みは表示できますが、SSPz・幅指標は算出できません。','The point signal is not acquired. Check detector aperture, gaps and sampling. Candidate geometry and weights remain available; SSPz and widths are undefined.');
        renderZffsSelected();releaseWorker();return;
      }
      fdkResult=m.result;renderFdkResult(fdkResult);progress.value=1;setBusy(false);fdkToggleDownloads(true);status.textContent=fdkText('完了 ','Completed ')+((performance.now()-startedAt)/1000).toFixed(1)+' s / 360 angles';selectFdkState(selectedStateIndex,true);
    }else if(m.type==='axial-animation'){receiveAxialMovie(m);}
    else if(m.type==='axial-animation-error'){failAxialMovie(m);}
    else if(m.type==='fdk-inspection'){if(m.requestId===fdkInspectionRequest)receiveGeometryInspection(m.result);}
    else if(m.type==='fdk-inspection-error'){if(m.requestId===fdkInspectionRequest){geometryPlayback.pending=false;stopGeometryPlayback();document.getElementById('geometry-play').disabled=true;document.getElementById('fdk-inspection-status').textContent=m.message;for(const canvas of [...loadingCanvasStatuses.keys()])drawCanvasStatus(canvas,'Axial interpolation',m.message,'error');}}
    else if(m.type==='cancelled'){failPositionSeries(fdkText('計算を中止しました','Calculation cancelled'));setBusy(false);document.getElementById('fdk-summary').textContent=fdkText('計算を中止しました','Calculation cancelled');status.textContent=document.getElementById('fdk-summary').textContent;for(const c of document.querySelectorAll('#fdk-panel canvas'))drawCanvasStatus(c,'Axial interpolation',status.textContent,'cancelled');releaseWorker();}
    else if(m.type==='error'){
      let text=m.message;
      if(text.startsWith('FDK_COVERAGE'))text=fdkText('この条件では、点の投影または局所画像に必要な連続360°のデータが検出器範囲から外れます。ピッチまたは再構成範囲を小さくしてください。展開図・体軸方向モデルは引き続き選択できます。',text);
      if(text.startsWith('FDK_DOMAIN')||text.startsWith('CBA_DOMAIN'))text=fdkText('幅を求める交点が計算範囲内にありません。SSPzの計算範囲を広げてください。',text);
      if(text.startsWith('CBA_COVERAGE'))text=fdkText('RRIに必要な投影または対向する列のサンプルが、検出器範囲から外れます。ピッチまたは再構成範囲を小さくしてください。',text);
      if(text.startsWith('AXIAL_DOMAIN_LIMIT'))text=fdkText('計算範囲を上限の±80 mmまで広げても裾を確認できないため、SSPzの幅は確定しませんでした。この条件は現在の計算範囲上限を超えています。',text);
      else if(text.startsWith('AXIAL_DOMAIN'))text=fdkText('取得応答がないか、裾が計算範囲を超えています。開口・標本間隔・計算範囲を確認してください。',text);
      if(text.startsWith('ZFFS_GEOMETRY'))text=fdkText('焦点移動の幾何条件を確認してください。距離比は1より大きく、検出器は評価点の外側にある必要があります。片側移動量は0～0.5列分です。',text);
      if(text.startsWith('AXIAL_COVERAGE'))text=fdkText('この条件では、選択規則に必要な取得列が不足しています。ピッチまたは検出器端の設定を確認してください。',text);
      if(text.startsWith('AXIAL_FAN'))text=fdkText('全ファン角は0°より大きく180°未満とし、評価位置を含む範囲にしてください。',text);
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
function fdkDrawProfile(canvas,r,panelLabel='(d)'){
  const ymin=Math.min(0,...fdkGroups(r).flatMap(([,g])=>g.profiles.map(p=>Math.min(...p.profile)))),low=ymin<0?Math.floor(ymin*10)/10:0;
  const a=fdkAxes(canvas,r.z[0],r.z.at(-1),low,1.04,'z position (mm)','Normalized SSPz',panelLabel,low<0?[low,0,.2,.4,.6,.8,1]:[0,.2,.4,.6,.8,1],110,null,v=>v.toFixed(1));
  for(const [i,[,g]] of fdkGroups(r).entries())fdkDrawLines(a,r.z,g.profiles.map(p=>p.profile),i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR);
  a.ctx.save();a.ctx.strokeStyle=MUTED;a.ctx.lineWidth=1;a.ctx.setLineDash([5,4]);
  for(const level of [.5,.1]){a.ctx.beginPath();a.ctx.moveTo(a.b.left,a.y(level));a.ctx.lineTo(a.b.right,a.y(level));a.ctx.stroke();}a.ctx.restore();
  drawFdkProfileLegend(a,r);
  const fw=r.profiles[Math.min(selectedStateIndex,r.profiles.length-1)].fwhm;fdkArrow(a,fw,.5,INK);
  canvas.dataset.profileOpacity='0.13';canvas.dataset.profileLineWidth='1.1';canvas.dataset.profileInterpolation='native-sample-linear';
}
function drawFdkDifference(canvas,r){
  const limit=Math.ceil(Math.max(.02,...fdkGroups(r).flatMap(([,g])=>g.meanDifference.map(p=>Math.max(...p.map(Math.abs)))))/.02)*.02;
  const a=fdkAxes(canvas,r.z[0],r.z.at(-1),-limit,limit,'z position (mm)','SSPz minus mean','(e)');
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
function drawFdkShape(canvas){SSPZShapeDisplay.draw(canvas,fdkShapeGroups,{title:`FWHM-midpoint aligned; r = ${fdkResult.config.radius} mm; n = ${fdkResult.profiles.length}`,panel:'(f)'});}
function renderFdkResult(r){
  const c=r.config;document.getElementById('fdk-summary').textContent=fdkText('全360条件の計算が完了しました。選択角度の表示を準備しています。','All 360 conditions are complete. Preparing the selected-angle view.');
  document.getElementById('fdk-result-config').textContent=`${c.rows} rows / ${c.viewSamples} views/turn / ${r.profiles.length} start angles`;
  fdkDrawProfile(document.getElementById('fdk-profile'),r);

  const comparison=document.getElementById('cba-comparison');comparison.hidden=!r.reference;document.getElementById('cba-samples-wrap').hidden=true;
  if(r.reference){comparison.innerHTML=`<table><caption>${fdkText('各SSPzから求めたFWHM','FWHM computed from individual SSPz profiles')}</caption><thead><tr><th>${fdkText('補間方法','Method')}</th><th>${fdkText('平均 (mm)','Mean (mm)')}</th><th>SD (mm)</th><th>${fdkText('範囲 (mm)','Range (mm)')}</th></tr></thead><tbody>${fdkGroups(r).map(([name,g])=>{const q=fdkWidthStats(g);return `<tr><td>${name}</td><td>${q.mean.toFixed(2)}</td><td>${q.sd===null?'—':q.sd<.001?'&lt; 0.001':q.sd.toFixed(3)}</td><td>${q.min.toFixed(2)}–${q.max.toFixed(2)}</td></tr>`;}).join('')}</tbody></table>`;cbaDrawSamples(document.getElementById('cba-samples'),r);}
  document.getElementById('fdk-shape-wrap').hidden=false;
  let shapeError='';
  try {
    fdkShapeGroups=SSPZShapeDisplay.fromFdk(r);drawFdkShape(document.getElementById('fdk-shape'));
    document.getElementById('fdk-shape-summary').textContent=fdkShapeGroups.map(g=>`${g.name}: ${g.analysis.valid.length} / ${r.profiles.length}`).join(' · ')+fdkText(' 条件。濃さ：ビン内の割合。',' conditions. Intensity: fraction per bin.')+(r.profiles.length===1?fdkText('1条件では変動を評価できません。条件数を増やしてください。',' Variation cannot be assessed from one condition; increase the number of start angles.'):'');
  }catch(error){fdkShapeGroups=null;document.getElementById('fdk-shape-wrap').hidden=true;shapeError=fdkText('位置合わせ後の形状変動分布は表示できません：','The aligned shape distribution is unavailable: ')+error.message;}
  document.getElementById('fdk-difference-wrap').hidden=r.profiles.length===1;
  if(r.profiles.length>1)drawFdkDifference(document.getElementById('fdk-difference'),r);
  updateSspzVariation('ready',r,shapeError);
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

// Independent HFI calculation. Only an explicit copy action copies geometry
// settings; the cone-model SSPz and its start-angle playback remain separate.
let taguchiResult=null,taguchiResultValid=false,taguchiRunId=0;
const TAGUCHI_DEVELOPMENT_STATUS={status:'under-development',validation:'incomplete',intendedUse:'development and verification only',warning:'Provisional TSP curves and metrics; not ready for research conclusions or scanner performance evaluation. Reproduction of the published theoretical curves has not been established.'};
function temporalUnit(){return document.getElementById('tsp-time-unit')?.value==='turns'?'turns':'ms';}
function taguchiInput(id){const e=document.getElementById(id);return e&&e.value!==''&&e.checkValidity()?Number(e.value):NaN;}
function taguchiSettings(){return {rows:4,rowWidth:taguchiInput('taguchi-row-width'),beamPitch:taguchiInput('taguchi-pitch'),filterWidthMm:taguchiInput('taguchi-filter-width'),rotationTime:readRotationTime(),viewSamples:7200};}
function initializeTaguchiUi(){
  const section=document.createElement('section');section.id='taguchi-tsp';section.setAttribute('aria-labelledby','taguchi-title');
  section.innerHTML=`<p class="eyebrow">${fdkText('追加計算・構築中','Additional calculation · Under development')}</p><h2 id="taguchi-title">${fdkText('TaguchiらのHFIに基づくTSP参照計算','TSP reference calculation based on Taguchi et al.’s HFI')}</h2>
  <aside class="taguchi-development-notice" aria-labelledby="taguchi-development-title"><strong id="taguchi-development-title">${fdkText('現在構築中・検証未完了','UNDER DEVELOPMENT — VALIDATION INCOMPLETE')}</strong><p>${fdkText('このTSP機能は開発・検証用です。表示される曲線・数値は暫定結果であり、研究結果や装置性能の評価に使用できる段階ではありません。','This TSP feature is for development and verification. Its curves and metrics are provisional and are not ready for research conclusions or scanner performance evaluation.')}</p><p>${fdkText('論文の理論曲線の再現は確認できていません。市川論文Fig.5(d)、p = 0.625では曲線形状に差が残っています。','Reproduction of the published theoretical curves has not been established. A curve-shape difference remains for Ichikawa Fig.5(d), p = 0.625.')}</p></aside>
  <p>${fdkText('ここからは、ヘリカルフィルタ補間（HFI）の重みを用いて時間感度を追加計算します。上のSSPzとは計算方法が異なります。','This section calculates temporal sensitivity from helical filter interpolation (HFI) weights. It uses a different calculation method from the SSPz above.')}</p>
  <p class="taguchi-scope"><strong>${fdkText('計算対象：4列・回転中心（r = 0 mm）','Scope: four rows at isocentre (r = 0 mm)')}</strong><br>${fdkText('実データと対向データの隣接2点から再サンプリングし、幅FWの矩形フィルタを適用します。補間重みを元の取得時刻ごとに合計します。','Resample between adjacent direct and complementary data, apply a rectangular filter of width FW, and sum interpolation weights by original acquisition time.')}</p>
  <div class="action-row"><button type="button" id="taguchi-copy" class="secondary">${fdkText('上の列幅・ピッチをコピー','Copy row width and pitch from above')}</button></div>
  <div class="taguchi-inputs">
  <label>${fdkText('回転中心換算の列幅 d (mm)','Row width at isocentre d (mm)')}<input id="taguchi-row-width" type="number" min="0.1" max="10" step="0.1" value="1" required></label>
  <label>${fdkText('ビームピッチ p','Beam pitch p')}<input id="taguchi-pitch" type="number" min="0.1" max="2" step="0.001" value="0.875" required></label>
  <label>${fdkText('HFIフィルタ幅 FW (mm)','HFI filter width FW (mm)')}<input id="taguchi-filter-width" type="number" min="0.1" max="20" step="0.1" value="1" required></label>
  <label>${fdkText('回転時間 (s/rot)','Rotation time (s/rot)')}<input id="taguchi-rotation" type="number" min="0.05" max="5" step="0.05" value="0.5" required></label></div>
  <p class="field-help">${fdkText('pは1回転の寝台移動量 ÷（4 × d）。FWは上の設定厚Tとは独立です。回転時間は上の条件欄と共通です。','p is table travel per rotation divided by (4 × d). FW is independent of thickness T above. Rotation time is shared with the settings above.')}</p>
  <p class="field-help">${fdkText('上の評価位置r・開始角度の再生・焦点サイズは使いません。','The radius r, start-angle playback and focal size above are not used.')}</p>
  <div class="action-row"><button type="button" id="taguchi-calculate">${fdkText('HFIでTSPを試算（検証用）','Calculate provisional HFI TSP')}</button><label for="tsp-time-unit">${fdkText('時間軸','Time axis')} <select id="tsp-time-unit"><option value="ms">ms</option><option value="turns">t / Trot</option></select></label></div>
  <p id="taguchi-status" role="status" aria-live="polite"></p>
  <div class="position-canvas"><canvas id="taguchi-tsp-plot" width="1100" height="660" role="img" aria-label="${fdkText('構築中・検証未完了のHFI TSP試算','Provisional HFI TSP; under development, validation incomplete')}"></canvas></div>
  <p id="taguchi-result-settings"></p><p id="taguchi-tsp-stats" class="tsp-stats"></p><p id="taguchi-reference-note" class="field-help"></p>
  <div class="action-row"><button type="button" id="taguchi-csv" class="secondary" disabled>${fdkText('試算TSPをCSV保存','Save provisional TSP as CSV')}</button><button type="button" id="taguchi-json" class="secondary" disabled>${fdkText('試算TSP・条件をJSON保存','Save provisional TSP and settings as JSON')}</button></div>
  <details class="reading-details"><summary>${fdkText('計算方法と論文との照合','Method and comparison with the paper')}</summary><p>${fdkText('Taguchi・Aradate（1998）の式(6)と付録の矩形フィルタに基づき、線形補間の係数をFW内で積分します。固定点対象の検出器信号は掛けません。時間0は目的断面に対する中央時刻です。','Linear interpolation coefficients are integrated over FW using Eq. (6) and the rectangular-filter appendix of Taguchi and Aradate (1998). No fixed-point detector signal is multiplied into these weights. Time zero is the central time of the target plane.')}</p>
  <p>${fdkText('計算刻みは回転時間の1/7200です。理論曲線を評価する刻みであり、上の取得ビュー数とは別です。表示は最大値1。FWHM・FWTMは半値・10%値の交点間の幅、Teqは面積÷最大値です。交点が一意でない場合は幅を確定しません。','The theoretical time-sampling interval is 1/7200 of a rotation, independent of the acquired view count above. Curves are normalized to a peak of one. FWHM and FWTM use the half-maximum and 10% crossings; Teq is area divided by peak. Widths are not assigned when crossings are ambiguous.')}</p>
  <p>${fdkText('比較対象は市川ら（2015）Fig.5(d–f)のHFI条件です。実機の再構成画像や周辺位置のTSPを再現したものではありません。','The reference comparison is the HFI setting in Ichikawa et al. (2015), Fig. 5(d–f). This does not reproduce reconstructed scanner images or off-centre TSPs.')} <a href="${fdkText('methods.html?topic=axial#taguchi-hfi-tsp','methods.html?topic=axial&lang=en#taguchi-hfi-tsp')}">${fdkText('計算式・確認結果','Equations and checks')}</a></p>
  <p><a href="https://doi.org/10.1118/1.598230">Taguchi &amp; Aradate (1998)</a> · <a href="https://doi.org/10.1016/j.ejmp.2015.02.012">Ichikawa et al. (2015)</a></p></details>`;
  document.getElementById('fdk-panel').after(section);
  for(const id of ['taguchi-row-width','taguchi-pitch','taguchi-filter-width'])document.getElementById(id).addEventListener('input',invalidateTaguchiResult);
  document.getElementById('taguchi-copy').onclick=copyTaguchiSettings;
  document.getElementById('taguchi-calculate').onclick=runTaguchiCalculation;
  document.getElementById('taguchi-rotation').oninput=e=>setTaguchiRotation(e.target.value);
  document.getElementById('tsp-time-unit').onchange=refreshTemporalDisplay;
  document.getElementById('taguchi-csv').onclick=downloadTaguchiCsv;
  document.getElementById('taguchi-json').onclick=()=>{const r=taguchiExport();if(r)downloadBlob('Taguchi_HFI_TSP.json',JSON.stringify(r,(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v),'application/json');};
  const width=Number(form.elements.namedItem('rowWidth').value),pitch=Number(form.elements.namedItem('beamPitch').value);
  if(width>=.1&&width<=10){document.getElementById('taguchi-row-width').value=String(width);document.getElementById('taguchi-filter-width').value=String(width);}
  if(pitch>=.1&&pitch<=2)document.getElementById('taguchi-pitch').value=String(pitch);
  refreshTemporalDisplay();drawCanvasStatus(document.getElementById('taguchi-tsp-plot'),'HFI TSP',fdkText('条件を入力し、追加計算を実行してください。','Enter settings and run the additional calculation.'),'idle');
  document.getElementById('taguchi-status').textContent=fdkText('SSPzの計算とは独立して実行します。','This calculation runs independently of SSPz.');
}
function setTaguchiRotation(value){form.elements.namedItem('rotationTime').value=value;persistTemporalSettings();refreshTemporalDisplay();}
function copyTaguchiSettings(){
  document.getElementById('taguchi-row-width').value=form.elements.namedItem('rowWidth').value;document.getElementById('taguchi-pitch').value=form.elements.namedItem('beamPitch').value;
  invalidateTaguchiResult();refreshTemporalDisplay();
  document.getElementById('taguchi-status').textContent=fdkText('列幅とピッチをコピーしました。4列・回転中心で計算します。FWを確認して追加計算してください。','Row width and pitch copied. Calculation remains at isocentre with four rows. Check FW, then calculate.');
}
function taguchiDownloads(enabled){for(const id of ['taguchi-csv','taguchi-json'])document.getElementById(id).disabled=!enabled;}
function invalidateTaguchiResult(){
  taguchiRunId++;taguchiResultValid=false;taguchiDownloads(false);document.getElementById('taguchi-calculate').disabled=false;
  document.getElementById('taguchi-tsp-plot').dataset.renderState=taguchiResult?'stale':'idle';
  document.getElementById('taguchi-status').textContent=taguchiResult?fdkText('条件を変更しました。前の条件の曲線を保持しています。追加計算で更新してください。','Settings changed. The previous curve is retained; calculate again to update.'):fdkText('条件を確認して追加計算してください。','Check settings and run the additional calculation.');
}
async function runTaguchiCalculation(){
  const config=taguchiSettings();
  if(Object.values(config).some(v=>!Number.isFinite(v))){invalidateTaguchiResult();document.getElementById('taguchi-status').textContent=fdkText('列幅・ピッチ・FW・回転時間の入力範囲を確認してください。','Check the ranges for row width, pitch, FW and rotation time.');return;}
  const run=++taguchiRunId;taguchiResultValid=false;taguchiDownloads(false);document.getElementById('taguchi-calculate').disabled=true;
  document.getElementById('taguchi-status').textContent=fdkText('検証用のHFI TSPを試算中…','Calculating the provisional HFI TSP…');
  await new Promise(resolve=>setTimeout(resolve,0));
  try{const r=await SSPZTaguchi.computeTaguchiTsp(config);if(run!==taguchiRunId)return;taguchiResult=r;taguchiResultValid=true;renderTaguchiTsp();if(Number.isFinite(readRotationTime()))document.getElementById('taguchi-status').textContent=fdkText('試算が完了しました（構築中・検証未完了）。','Provisional calculation complete; under development, validation incomplete.');}
  catch(error){if(run!==taguchiRunId)return;invalidateTaguchiResult();document.getElementById('taguchi-status').textContent=fdkText('追加計算を完了できませんでした。入力条件を確認してください。','Additional calculation failed. Check the input settings.')+' '+error.message;}
  finally{if(run===taguchiRunId)document.getElementById('taguchi-calculate').disabled=false;}
}
function renderTaguchiTsp(){
  if(!taguchiResult)return;
  const r=taguchiResult,rotation=readRotationTime(),canvas=document.getElementById('taguchi-tsp-plot');
  if(!Number.isFinite(rotation)){canvas.dataset.renderState='invalid-time';taguchiDownloads(false);document.getElementById('taguchi-status').textContent=fdkText('回転時間を0.05～5秒で入力してください。前の図を保持しています。','Enter a rotation time from 0.05 to 5 s. The previous plot is retained.');return;}
  if(canvas.dataset.renderState==='invalid-time')document.getElementById('taguchi-status').textContent=taguchiResultValid?fdkText('回転時間を反映しました。計算済みのHFI曲線を表示しています。','Rotation time updated. Showing the calculated HFI curve.'):fdkText('条件を変更しました。前の条件の曲線を保持しています。追加計算で更新してください。','Settings changed. The previous curve is retained; calculate again to update.');
  const units=temporalUnit(),scale=units==='ms'?1000*rotation:1,bound=Math.max(Math.abs(r.timeTurns[0]),Math.abs(r.timeTurns.at(-1)))*scale,limit=symmetricNiceAxis(bound,3).xMax;
  const axes=fdkAxes(canvas,-limit,limit,0,1.04,units==='ms'?'Relative acquisition time (ms)':'Relative acquisition time / Trot','Normalized HFI TSP','',[0,.2,.4,.6,.8,1],100,null,v=>v.toFixed(1));
  const {ctx,b,x,y}=axes;ctx.save();ctx.beginPath();ctx.rect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.clip();ctx.strokeStyle='#176b87';ctx.lineWidth=3.2;strokeNativeProfile(ctx,Float64Array.from(r.timeTurns,t=>t*scale),r.profile,x,y);
  ctx.strokeStyle='#a9b4bd';ctx.lineWidth=1;ctx.setLineDash([5,5]);for(const h of [.5,.1]){ctx.beginPath();ctx.moveTo(b.left,y(h));ctx.lineTo(b.right,y(h));ctx.stroke();}ctx.restore();
  ctx.save();ctx.fillStyle='#174157';ctx.font=`700 24px ${FIGURE_FONT}`;ctx.textAlign='center';ctx.fillText(`HFI TSP (UNDER DEVELOPMENT) · p = ${r.config.beamPitch} · FW = ${r.config.filterWidthMm} mm`,(b.left+b.right)/2,45);ctx.restore();
  loadingCanvasStatuses.delete(canvas);Object.assign(canvas.dataset,{renderState:taguchiResultValid?'ready':'stale',method:'taguchi-hfi',radiusMm:'0',rows:'4',rotationTime:String(rotation),timeUnit:units,timeAxisLimit:String(limit)});
  const unit=units==='ms'?'ms':'Trot',fmt=v=>Number.isFinite(v)?(v*scale).toFixed(units==='ms'?1:4):fdkText('未定義','undefined');
  document.getElementById('taguchi-tsp-stats').textContent=`FWHM ${fmt(r.metrics.fwhmTurns)} ${unit} ／ FWTM ${fmt(r.metrics.fwtmTurns)} ${unit} ／ Teq ${fmt(r.metrics.equivalentWidthTurns)} ${unit}`;
  document.getElementById('taguchi-result-settings').textContent=fdkText(`表示条件：4列・r = 0 mm ／ d = ${r.config.rowWidth} mm ／ p = ${r.config.beamPitch} ／ FW = ${r.config.filterWidthMm} mm ／ ${rotation} s/rot`,`Displayed settings: 4 rows, r = 0 mm / d = ${r.config.rowWidth} mm / p = ${r.config.beamPitch} / FW = ${r.config.filterWidthMm} mm / ${rotation} s/rot`);
  const ref={.625:[1531,1710],1:[1001,1284],1.5:[501,791]}[r.config.beamPitch];
  document.getElementById('taguchi-reference-note').textContent=ref&&Math.abs(r.config.filterWidthMm/r.config.rowWidth-1)<1e-10?fdkText(`参考：同じFW/d比・回転時間1 sでの市川論文の実測値はFWHM ${ref[0]} ms、FWTM ${ref[1]} msです。実測値は理論計算の厳密な正解値ではありません。`,`Reference: at the same FW/d ratio and 1 s rotation, Ichikawa reports measured FWHM ${ref[0]} ms and FWTM ${ref[1]} ms. These measured values are not exact theoretical targets.`):'';
  taguchiDownloads(taguchiResultValid);
}
function refreshTemporalDisplay(){const e=document.getElementById('taguchi-rotation');if(!e)return;e.value=form.elements.namedItem('rotationTime').value;renderTaguchiTsp();}
function taguchiExport(){
  const rotationTime=readRotationTime();if(!taguchiResultValid||!taguchiResult||!Number.isFinite(rotationTime))return null;
  const r=taguchiResult,metrics={...r.metrics};for(const [key,v] of Object.entries(r.metrics))if(key.endsWith('Turns'))metrics[key.slice(0,-5)+'Ms']=Number.isFinite(v)?v*rotationTime*1000:null;
  return {...r,scope:'Provisional Taguchi HFI TSP; four rows at isocentre; independent from cone-model SSPz',developmentStatus:{...TAGUCHI_DEVELOPMENT_STATUS},config:{...r.config,rotationTime},metrics,timeMs:Float64Array.from(r.timeTurns,t=>t*rotationTime*1000)};
}
function downloadTaguchiCsv(){
  const r=taguchiExport();if(!r)return;
  const rows=[['# method','Provisional Taguchi HFI TSP'],['# development_status',JSON.stringify(r.developmentStatus)],['# config',JSON.stringify(r.config)],['# provenance',JSON.stringify(r.provenance)],['# metrics',JSON.stringify(r.metrics)],['time_turns','time_ms','summed_interpolation_weight','normalized_peak_1'],...Array.from(r.timeTurns,(t,i)=>[t,r.timeMs[i],r.raw[i],r.profile[i]])];
  downloadBlob(`Taguchi_HFI_TSP_p${r.config.beamPitch}_FW${r.config.filterWidthMm}mm.csv`,'\uFEFF'+rows.map(row=>row.map(csvEscape).join(',')).join('\r\n'),'text/csv');
}
function spatialExport(result){
  if(!result)return result;const {temporalResponse,temporalResponseUnavailable,...spatial}=result;
  if(spatial.config)spatial.config={...spatial.config,rotationTime:Number.isFinite(readRotationTime())?readRotationTime():null};
  if(spatial.profiles)spatial.profiles=spatial.profiles.map(spatialExport);if(spatial.reference)spatial.reference=spatialExport(spatial.reference);return spatial;
}

// One real response at the current FOV position. Full 360-start-angle analysis
// remains an explicit action; this worker/result never impersonates that series.
let positionWorker=null,positionWorkerUrl=null,positionTimer=null,positionRequest=0,positionResult=null;
const positionMovie={series:null,index:0,playing:false,timer:null,scenes:new Map(),background:null,axes:null,xLimit:null,valid:false};
function stopPositionPreview(){
  clearTimeout(positionTimer);positionRequest++;
  positionWorker?.terminate();positionWorker=null;
  if(positionWorkerUrl)URL.revokeObjectURL(positionWorkerUrl);positionWorkerUrl=null;
}
function positionCanvases(){return [...document.querySelectorAll('#position-preview canvas')];}
function syncPositionControls(){
  const radius=Number(form.elements.namedItem('radius').value),range=document.getElementById('position-radius');
  if(!range)return;range.value=radius;
  document.getElementById('position-radius-value').textContent=`${radius} mm`;
  const on=Number(form.elements.namedItem('beamPitch').value)>0;
  document.getElementById('position-preview').hidden=!on;
  runButton.textContent=on?fdkText('全360開始角度を計算する','Calculate all 360 start angles'):fdkText('寝台静止時の展開図を計算する','Calculate stationary-table geometry');
  if(!on)for(const id of ['diagram-overview-off','diagram-zoom-off'])document.getElementById(id)?.closest('article')?.setAttribute('hidden','');
  document.getElementById('position-angle').textContent=((Number(document.getElementById('fdk-phase').value)*180/Math.PI)%360).toFixed(1)+'°';
}
function clearPositionResult(message,state='loading'){
  positionResult=null;
  document.getElementById('position-json').disabled=true;
  document.getElementById('position-stats').textContent='';
  document.getElementById('position-status').textContent=message;
  for(const canvas of positionCanvases()){
    delete canvas.dataset.radiusMm;delete canvas.dataset.responseRequest;
    drawCanvasStatus(canvas,'',message,state);
  }
}
function holdPositionResult(message,state='loading'){
  positionMovie.valid=false;stopPositionMovie();updatePositionMovieControls();
  document.getElementById('position-json').disabled=true;
  document.getElementById('position-movie-status').textContent=fdkText('条件を変更したため、360開始角度は再準備が必要です。','Settings changed. Prepare the 360 start angles again.');
  if(!positionResult){clearPositionResult(message,state);return;}
  document.getElementById('position-status').textContent=message+' '+fdkText(`前の条件の図を保持しています（r = ${positionResult.config.radius} mm）。`,`Keeping the previous plots (r = ${positionResult.config.radius} mm).`);
  for(const canvas of positionCanvases()){canvas.dataset.renderState='stale';canvas.setAttribute('aria-busy',String(state==='loading'));}
}
function invalidatePositionMovie(){
  stopPositionMovie();positionMovie.series=null;positionMovie.scenes.clear();positionMovie.background=null;positionMovie.valid=false;updatePositionMovieControls();
  const prepare=document.getElementById('position-prepare');if(prepare)prepare.disabled=false;
}
function schedulePositionPreview(delay=220){
  stopPositionPreview();syncPositionControls();clearError();
  invalidatePositionMovie();
  // Re-enable form controls before FormData is read. A radius chip or slider
  // can interrupt an ongoing full sweep without losing the other inputs.
  releaseWorker();if(runButton.disabled)setBusy(false);
  fdkInspectionRequest++;clearTimeout(fdkInspectionTimer);fdkToggleDownloads(false);
  fdkResult=null;fdkSelectedResult=null;fdkShapeGroups=null;lastResult=null;
  document.getElementById('fdk-panel').hidden=true;
  updateSspzVariation('idle');
  document.getElementById('position-preview').hidden=Number(form.elements.namedItem('beamPitch').value)<=0;
  holdPositionResult(fdkText('新しい条件を計算中…','Computing the new settings…'));
  status.textContent=fdkText('位置に連動して計算します。全360開始角度は計算ボタンで実行できます。','Position-linked calculation. Use Calculate for all 360 start angles.');
  if(Number(form.elements.namedItem('beamPitch').value)<=0){clearCanvasStatusAnimations();positionTimer=setTimeout(runSimulation,delay);return;}
  positionTimer=setTimeout(runPositionPreview,delay);
}
function runPositionPreview(){
  stopPositionPreview();syncPositionControls();
  if([...form.querySelectorAll('input[type=number]')].some(e=>e.id!=='rotationTime'&&(e.value===''||e.validity.badInput||e.validity.rangeUnderflow||e.validity.rangeOverflow))){
    holdPositionResult(fdkText('入力値の範囲を確認してください。','Check the input ranges.'),'error');return;
  }
  const params=readParams(),requestId=positionRequest;
  const previewParams={...params,phase:params.phase};
  const url=paramsToUrl(params);
  try{history.replaceState(null,'',url);localStorage.setItem('sspz-unwrapped-params',JSON.stringify(params));}catch{}
  syncLanguageLinks(url.search);
  const blob=new Blob([globalThis.SSPZ_WORKER_SOURCE],{type:'text/javascript'});
  positionWorkerUrl=URL.createObjectURL(blob);
  const active=positionWorker=new Worker(positionWorkerUrl);
  const fail=message=>{
    if(active!==positionWorker||requestId!==positionRequest)return;
    holdPositionResult(message,'error');stopPositionPreview();
  };
  active.onerror=e=>fail(e.message);
  active.onmessage=({data:m})=>{
    if(active!==positionWorker||requestId!==positionRequest||m.requestId!==requestId)return;
    if(m.type==='position-preview-error'){fail(m.message);return;}
    if(m.type!=='position-preview-result')return;
    try{
      renderPositionPreview(m.result,requestId);
      stopPositionPreview();
    }catch(error){fail(error.message);}
  };
  active.postMessage({type:'position-preview',requestId,params:previewParams});
}
function initializePositionPreview(){
  const section=document.createElement('section');section.id='position-preview';
  section.innerHTML=`<h2>${fdkText('評価位置と開始角度で、展開図・SSPzはどう変わる？','How do position and start angle affect geometry and SSPz?')}</h2>
  <p>${fdkText('評価位置を決めて、360開始角度を準備します。灰色の360本を残したまま、選択中のSSPzを赤く強調し、同じ開始角度の展開図と一緒に再生できます。','Choose an evaluation position and prepare all 360 start angles. Keep all 360 profiles in grey and highlight the selected SSPz in red, together with its matching unwrapped diagram.')}</p>
  <div class="position-controls"><label for="position-radius">${fdkText('回転中心からの距離 r','Distance from isocentre r')} <output id="position-radius-value"></output></label><input id="position-radius" type="range" min="0" max="250" step="1"><button type="button" id="position-centre">${fdkText('中心へ戻す','Return to centre')}</button><span>${fdkText('基準開始角度','Base start angle')}: <b id="position-angle"></b></span></div>
  <p class="field-help">${fdkText('FOVの表示サイズではなく、FOV内の評価位置を変えます。取得ビュー数・補間方法・設定厚Tは現在の入力値を使います。展開図は横軸が体軸位置、縦軸が0～360°の補間対象方向です。','This moves the evaluation point within the FOV, not the displayed FOV size. Current view count, interpolation and thickness T are retained. The diagram uses axial position horizontally and the 0–360° output direction vertically.')}</p>
  <div class="position-movie-controls"><button type="button" id="position-prepare">${fdkText('360開始角度を準備','Prepare 360 start angles')}</button><button type="button" id="position-play" disabled aria-pressed="false">${fdkText('▶ 開始角度を再生','▶ Play start angles')}</button><button type="button" id="position-prev" disabled>−1°</button><button type="button" id="position-next" disabled>+1°</button><label>${fdkText('再生速度','Playback speed')} <select id="position-speed"><option value="400">${fdkText('ゆっくり','Slow')}</option><option value="150" selected>${fdkText('標準','Normal')}</option><option value="75">${fdkText('速い','Fast')}</option></select></label><label class="position-phase-control" for="position-phase">${fdkText('表示中の開始角度','Displayed start angle')} <output id="position-phase-value">—</output><input id="position-phase" type="range" min="0" max="359" step="1" value="0" disabled></label></div>
  <p id="position-movie-status" aria-live="polite">${fdkText('最初に基準角度の1本を表示します。準備ボタンで全360本を計算します。','One base-angle profile is shown first. Prepare calculates all 360 profiles.')}</p>
  <p class="field-help">${fdkText('再生は、同じ評価位置で開始角度だけが異なる360条件の比較です。X線管が撮影中に回る動きではありません。準備後の角度変更では再計算しません。','Playback compares 360 separate start-angle conditions at the same position, not tube motion during a scan. Once prepared, angle changes require no recalculation.')}</p>
  <p id="position-status" aria-live="polite"></p><div class="position-plots"><article class="chart-card"><h3>${fdkText('データ配置と補間重み','Data geometry and interpolation weights')}</h3><div class="position-canvas"><canvas id="position-diagram" width="900" height="960" role="img" aria-label="${fdkText('評価位置の展開図','Unwrapped diagram at the evaluation point')}"></canvas></div></article><article class="chart-card"><h3>${fdkText('同じ評価位置のSSPz','SSPz at the same evaluation point')}</h3><div class="position-canvas"><canvas id="position-profile" width="1000" height="700" role="img" aria-label="${fdkText('同じ評価位置のSSPz','SSPz at the same evaluation point')}"></canvas></div><p id="position-stats"></p><p>${fdkText('配置の変化が、補間・角度平均・厚さTの平均後にどこまで残るかを見ます。配置が変わっても半値幅が大きく変わるとは限りません。','See how changes in data geometry carry through interpolation, angular averaging and thickness T. Different geometry need not produce a large FWHM change.')}</p></article></div>
  <button type="button" id="position-json" class="secondary" disabled>${fdkText('表示中の応答・条件をJSON保存','Save the displayed response and conditions')}</button><p class="field-help">${fdkText('SSPzは全取得ビューから計算しています。展開図の重み記号は全周の代表方向を表示します。全方向の重みは、下の詳細結果で開始角度を選んでJSON保存できます。','SSPz uses all acquired views. Diagram weight markers show sampled directions around the full turn. For complete weights, select a start angle in the detailed results below and export JSON.')}</p>`;
  document.getElementById('fdk-panel').before(section);
  document.getElementById('fdk-panel').before(document.getElementById('sspz-variation'));
  initializeTaguchiUi();
  const change=value=>{form.elements.namedItem('radius').value=value;updateInputDecorations();schedulePositionPreview();};
  document.getElementById('position-radius').oninput=e=>change(e.target.value);
  document.getElementById('position-centre').onclick=()=>change(0);
  document.getElementById('position-json').onclick=()=>{if(positionResult&&positionMovie.valid)downloadBlob(`Cone_geometry_r${positionResult.config.radius}mm_angle${(positionResult.config.phase*180/Math.PI).toFixed(1)}_response.json`,JSON.stringify({scope:'displayed single-start-angle SSPz; diagramFrame contains display-sampled weights only',result:spatialExport(positionResult)},(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v),'application/json');};
  document.getElementById('position-prepare').onclick=()=>{
    if([...form.querySelectorAll('input[type=number]')].some(e=>e.id!=='rotationTime'&&(e.value===''||e.validity.badInput||e.validity.rangeUnderflow||e.validity.rangeOverflow))){holdPositionResult(fdkText('入力値の範囲を確認してください。','Check the input ranges.'),'error');return;}runSimulation();
  };
  document.getElementById('position-play').onclick=()=>{if(positionMovie.playing)stopPositionMovie();else if(positionMovie.valid&&positionMovie.series){stopAxialMovie();stopGeometryPlayback();positionMovie.playing=true;updatePositionMovieControls();schedulePositionMovie();}};
  document.getElementById('position-phase').oninput=e=>{stopPositionMovie();renderPositionFrame(Number(e.target.value));};
  document.getElementById('position-prev').onclick=()=>{stopPositionMovie();renderPositionFrame(positionMovie.index-1);};
  document.getElementById('position-next').onclick=()=>{stopPositionMovie();renderPositionFrame(positionMovie.index+1);};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPositionMovie();});
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');if(reduced.matches)document.getElementById('position-speed').value='400';
  reduced.addEventListener('change',()=>{stopPositionMovie();if(reduced.matches)document.getElementById('position-speed').value='400';});
  runButton.textContent=fdkText('全360開始角度を計算する','Calculate all 360 start angles');
  resetButton.addEventListener('click',()=>schedulePositionPreview());
  syncPositionControls();
}

function renderPositionPreview(r,requestId='series'){
  invalidatePositionMovie();
  const {profiles,mean,meanDifference,...singleResponse}=r;
  positionResult=singleResponse;
      for(const cv of positionCanvases())loadingCanvasStatuses.delete(cv);
      const canvas=document.getElementById('position-diagram');
      const scene=drawFdkCandidateDiagram(canvas,r,true,false,'all',true,{fullTurn:true});
      // Keep full-turn coordinates irrespective of the advanced-panel zoom.
      drawDiagram(canvas,scene,'zoom');
      const profile=document.getElementById('position-profile');
      if(r.geometryOnly)drawCanvasStatus(profile,'',fdkText('取得応答なし：SSPzは算出できません。','No acquired response: SSPz is unavailable.'),'unavailable');
      else fdkDrawProfile(profile,{...r,profiles:[r]},'');
      for(const cv of positionCanvases()){
        cv.removeAttribute('aria-busy');
        delete cv.dataset.profileCount;delete cv.dataset.selectedColor;delete cv.dataset.profileSource;delete cv.dataset.xLimit;
        cv.dataset.startIndex='0';cv.dataset.phase=String(r.config.phase);
        cv.dataset.radiusMm=String(r.config.radius);cv.dataset.responseRequest=String(requestId);
        cv.dataset.renderState=r.geometryOnly&&cv===profile?'unavailable':'ready';
      }
      document.getElementById('position-stats').textContent=r.geometryOnly?'':`FWHM ${r.fwhm.width.toFixed(2)} mm / FWTM ${r.fwtm.width.toFixed(2)} mm`;
      document.getElementById('position-status').textContent=fdkText(`r = ${r.config.radius} mm：同じ位置・開始角度の展開図・SSPzです。`,`r = ${r.config.radius} mm: diagram and SSPz share this position and start angle.`);
      document.getElementById('position-json').disabled=false;
      positionMovie.valid=true;
      document.getElementById('position-phase-value').textContent=positionAngle(r.config.phase);
      document.getElementById('position-phase').value=0;
      document.getElementById('position-movie-status').textContent=r.geometryOnly?fdkText('取得応答がないため、展開図のみ表示します。','No acquired response; only the diagram is available.'):fdkText('基準角度の1本を表示中。360開始角度を準備すると、全曲線を残して再生できます。','Showing one base-angle profile. Prepare 360 start angles to play with every profile visible.');
      updatePositionMovieControls();
      status.textContent=fdkText('評価位置の計算が完了しました。','Position calculation complete.');

}
function positionAngle(phase){return ((phase*180/Math.PI%360+360)%360).toFixed(1)+'°';}
function updatePositionMovieControls(){
  const m=positionMovie,ready=!!m.series&&m.valid,button=document.getElementById('position-play');if(!button)return;
  for(const id of ['position-play','position-prev','position-next','position-phase'])document.getElementById(id).disabled=!ready;
  button.textContent=m.playing?fdkText('Ⅱ 一時停止','Ⅱ Pause'):fdkText('▶ 開始角度を再生','▶ Play start angles');button.setAttribute('aria-pressed',String(m.playing));
}
function stopPositionMovie(){positionMovie.playing=false;clearTimeout(positionMovie.timer);positionMovie.timer=null;updatePositionMovieControls();}
function schedulePositionMovie(){
  if(!positionMovie.playing||!positionMovie.valid||document.hidden)return;
  positionMovie.timer=setTimeout(()=>{if(!positionMovie.playing||!positionMovie.valid)return;renderPositionFrame(positionMovie.index+1);schedulePositionMovie();},Number(document.getElementById('position-speed').value));
}
function beginPositionSeries(){
  updateSspzVariation('loading');
  invalidatePositionMovie();
  document.getElementById('position-prepare').disabled=true;
  holdPositionResult(fdkText('360開始角度を準備中…','Preparing 360 start angles…'));
  document.getElementById('position-movie-status').textContent=fdkText('展開図とSSPzをまとめて準備します。完了後は計算待ちなしで角度を変更できます。','Preparing diagrams and SSPz together. Angle changes will require no calculation after completion.');
}
function positionSeriesProgress(message){document.getElementById('position-movie-status').textContent=message;}
function failPositionSeries(message){document.getElementById('position-prepare').disabled=false;holdPositionResult(message,'error');positionSeriesProgress(message);updateSspzVariation('error',null,message);}
function preparePositionSeries(r){
  document.getElementById('position-prepare').disabled=false;
  if(r.geometryOnly||!r.profiles?.every(p=>p.diagramFrame)){renderPositionPreview(r,'series');return;}
  const m=positionMovie;stopPositionMovie();m.series=r;m.index=0;m.valid=true;m.scenes.clear();
  // Pass the same unrounded span to scene construction and axis painting.
  // Re-rounding an already nice span can enlarge it and omit edge turns.
  m.xLimit=Math.max(...r.profiles.map(p=>Math.max(r.config.rowWidth,Math.ceil(p.diagramFrame.extent.maxAbsZ*10)/10)*1.12));
  const canvas=document.getElementById('position-profile');m.background=document.createElement('canvas');m.background.width=canvas.width;m.background.height=canvas.height;
  const low=Math.min(0,Math.floor(Math.min(...r.profiles.map(p=>Math.min(...p.profile)))*10)/10);
  m.axes=fdkAxes(m.background,r.z[0],r.z.at(-1),low,1.04,'z position (mm)','Normalized SSPz','',low<0?[low,0,.2,.4,.6,.8,1]:[0,.2,.4,.6,.8,1],110,null,v=>v.toFixed(1));
  fdkDrawLines(m.axes,r.z,r.profiles.map(p=>p.profile),'#89949e');
  const {ctx,b,y}=m.axes;ctx.save();ctx.strokeStyle='#9ba5ad';ctx.lineWidth=1;ctx.setLineDash([5,4]);for(const level of [.5,.1]){ctx.beginPath();ctx.moveTo(b.left,y(level));ctx.lineTo(b.right,y(level));ctx.stroke();}ctx.restore();
  document.getElementById('position-phase').max=r.profiles.length-1;
  renderPositionFrame(0);
  positionSeriesProgress(fdkText(`${r.profiles.length}開始角度の準備が完了しました。灰色：全曲線／赤：表示中の開始角度。`,`${r.profiles.length} start angles ready. Grey: all profiles / red: displayed start angle.`));
  updatePositionMovieControls();
}
function renderPositionFrame(index){
  const m=positionMovie,r=m.series;if(!r||!m.valid)return;
  index=((Math.round(index)%r.profiles.length)+r.profiles.length)%r.profiles.length;m.index=index;
  const p=r.profiles[index],frame=p.diagramFrame;
  const selected={config:{...r.config,phase:p.phase},z:r.z,zObject:r.zObject,raw:p.raw,profile:p.profile,fwhm:p.fwhm,fwtm:p.fwtm,baseline:p.baseline,model:r.model,domainCheck:{...r.domainCheck,rawTailFraction:p.rawTailFraction},coordinateSystem:frame.coordinateSystem,diagramFrame:frame};
  // Compact display coefficients never masquerade as a complete weight audit.
  positionResult=selected;
  if(!m.scenes.has(index)){
    m.scenes.set(index,drawFdkCandidateDiagram({width:900,dataset:{}},{...selected,weightAudit:frame.weightAudit,rebinnedWeightAudit:frame.rebinnedWeightAudit},true,false,'all',true,{fullTurn:true,sharedXLimit:m.xLimit}));
    while(m.scenes.size>8)m.scenes.delete(m.scenes.keys().next().value);
  }
  drawDiagram(document.getElementById('position-diagram'),m.scenes.get(index),'zoom',m.xLimit);
  const canvas=document.getElementById('position-profile'),ctx=canvas.getContext('2d');ctx.drawImage(m.background,0,0);
  const axes={...m.axes,ctx};fdkDrawLines(axes,r.z,[p.profile],'#d71920');
  ctx.save();ctx.fillStyle='#d71920';ctx.font=`700 26px ${FIGURE_FONT}`;ctx.textAlign='center';ctx.fillText(fdkText(`開始角度 ${positionAngle(p.phase)} · r = ${r.config.radius} mm`,`Start angle ${positionAngle(p.phase)} · r = ${r.config.radius} mm`),(axes.b.left+axes.b.right)/2,45);ctx.fillStyle='#65727e';ctx.font=`21px ${FIGURE_FONT}`;ctx.fillText(fdkText(`灰色：全${r.profiles.length}本　赤：選択中`,`Grey: all ${r.profiles.length} profiles   Red: selected`),(axes.b.left+axes.b.right)/2,80);ctx.restore();
  for(const cv of positionCanvases()){loadingCanvasStatuses.delete(cv);cv.removeAttribute('aria-busy');Object.assign(cv.dataset,{radiusMm:String(r.config.radius),startIndex:String(index),phase:String(p.phase),renderState:'ready',responseRequest:'cached-series',xLimit:String(m.xLimit)});}
  Object.assign(canvas.dataset,{profileCount:String(r.profiles.length),selectedColor:'#d71920',profileSource:'precomputed-full-acquired-view-series',profileInterpolation:'native-sample-linear'});
  document.getElementById('position-phase').value=index;document.getElementById('position-phase-value').textContent=positionAngle(p.phase);
  document.getElementById('position-stats').textContent=`FWHM ${p.fwhm.width.toFixed(2)} mm / FWTM ${p.fwtm.width.toFixed(2)} mm`;
  document.getElementById('position-status').textContent=fdkText(`r = ${r.config.radius} mm ／ 開始角度 ${positionAngle(p.phase)}：展開図・赤いSSPzは同じ条件です。`,`r = ${r.config.radius} mm / start angle ${positionAngle(p.phase)}: the diagram and red SSPz share the same settings.`);
  document.getElementById('position-json').disabled=false;
}

// Browser defaults use the textbook-derived isocenter estimate. The numerical
// core keeps its historical defaults so incomplete saved conditions retain
// their original detector settings when loaded below.
const WEB_DEFAULT_PARAMS = Object.freeze({
  ...DEFAULT_PARAMS,
  channelWidth: 0.58,
  channelApertureMm: 0.58,
  focalSizeMm: 1.2,
  focalSourceDetectorMm: 1070,
  rotationTime: 0.5,
  detectorModel: "finite-channel",
  thicknessMapping: "configured-rectangular",
});

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
const PROFILE_DISPLAY_VERSION = "2026-09-17.1";
const PUBLICATION_WIDTH_MM = Object.freeze({ panel: 80, full: 180 });
// The log-tail plot still renders values only at or above 1%.  These limits
// add print-space around the 100% peak and the 1% endpoints so neither is
// hidden by the plot frame in the 80-mm publication export.
const PROFILE_TAIL_DISPLAY_BOUNDS = Object.freeze({ yMin: -2.08, yMax: 0.08, minimum: 0.01 });
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
const loadingCanvasStatuses = new Map();
const loadingMotionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
let canvasStatusAnimation = null;
let lastCanvasAnimationPaint = 0;

versionLabel.textContent = `Web build 2026-09-25.8 / shared axial response 2026-09-24.1 / optional z-FFS 2026-09-17.1`;

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

function parseRotationTime(value) {
  if (value == null || String(value).trim() === "") return NaN;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0.05 && seconds <= 5 ? seconds : NaN;
}

function rotationTimeFromSettings(params) {
  const key = ["rotationTime", "rotationTimeSec", "rt"].find(name => Object.prototype.hasOwnProperty.call(params, name));
  return key ? parseRotationTime(params[key]) : WEB_DEFAULT_PARAMS.rotationTime;
}

// Read the field directly: FormData omits disabled controls, and an empty
// number input must not become a zero-second rotation through Number("").
function readRotationTime() {
  return parseRotationTime(form.elements.namedItem("rotationTime")?.value);
}

function readParams() {
  const data = new FormData(form);
  return {
    rows: Number(data.get("rows")),
    rowWidth: Number(data.get("rowWidth")),
    channelWidth: Number(data.get("channelWidth")),
    channelApertureMm: Number(data.get("channelApertureMm")),
    focalSizeMm: Number(data.get("focalSizeMm")),
    focalSourceDetectorMm: Number(data.get("focalSourceDetectorMm")),
    detectorModel: "finite-channel",
    beamPitch: Number(data.get("beamPitch")),
    rotationTime: readRotationTime(),
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
  const rotationInput = form.elements.namedItem("rotationTime");
  const rotationTime = rotationTimeFromSettings(params);
  if (rotationInput) rotationInput.value = Number.isFinite(rotationTime) ? rotationTime : "";
  updateInputDecorations();
  if (typeof refreshTemporalDisplay === "function") refreshTemporalDisplay();
}

function updateInputDecorations() {
  syncSharedFocalControls();
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
  syncStaticReferenceLink();
}

// This reference has its own stationary-table operator. Transfer only the
// shared axial acquisition geometry and sampling, not the helical method/T.
function syncStaticReferenceLink() {
  const link = document.getElementById('static-response-link');
  if (!link) return;
  const p = readParams(), target = new URL('mori-static.html', location.href);
  // FormData omits disabled fields while the main calculation is running.
  // The reference link must still carry the values visible in those fields.
  for (const [key,value] of Object.entries(p)) {
    const input = form.elements.namedItem(key);
    if (input) p[key] = typeof value === 'number' ? Number(input.value) : input.value;
  }
  for (const [key, value] of Object.entries({n:p.rows,d:p.rowWidth,R:p.sourceRadius,D:p.focalSourceDetectorMm,r:p.radius,focus:p.focalSizeMm,nv:p.viewSamples,dz:p.zStep,from:'main'})) target.searchParams.set(key,value);
  if (document.documentElement.lang === 'en') target.searchParams.set('lang','en');
  target.searchParams.set('main',paramsToUrl(p).search);
  link.href = target.href;
}
document.getElementById('static-response-link')?.addEventListener('click',syncStaticReferenceLink);
form.addEventListener('input',syncStaticReferenceLink);
form.addEventListener('change',syncStaticReferenceLink);

function paramsToUrl(params) {
  const url = new URL(window.location.href);
  url.search = "";
  const compact = {
    v: 20,
    cp: params.channelWidth,
    ca: params.channelApertureMm,
    ff: params.focalSizeMm,
    fd: params.focalSourceDetectorMm,
    n: params.rows,
    d: params.rowWidth,
    p: params.beamPitch,
    rt: rotationTimeFromSettings(params),
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
    channelWidth: get("cp",get("fdk_channelWidth",DEFAULT_PARAMS.channelWidth)),
    channelApertureMm: get("ca",get("cp",get("fdk_channelWidth",DEFAULT_PARAMS.channelApertureMm))),
    // Missing focus parameters identify historical point-focus conditions.
    focalSizeMm: get("ff", 0),
    focalSourceDetectorMm: get("fd", query.has('zffs_m')||query.get('zffs')==='1'
      ? get('zffs_m',1072/600)*get('R',DEFAULT_PARAMS.sourceRadius) : 1070),
    detectorModel: "finite-channel",
    beamPitch: get("p", DEFAULT_PARAMS.beamPitch),
    rotationTime: ["rt", "rotationTime", "rotationTimeSec"].some(key => query.has(key))
      ? parseRotationTime(query.get(["rt", "rotationTime", "rotationTimeSec"].find(key => query.has(key))))
      : WEB_DEFAULT_PARAMS.rotationTime,
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
  if (!busy) clearCanvasStatusAnimations();
  runButton.disabled = busy;
  cancelButton.disabled = !busy;
  form.querySelectorAll("input, select").forEach(input => input.disabled = busy && input.name !== "rotationTime");
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

function clearCanvasStatusAnimations() {
  if (canvasStatusAnimation !== null) cancelAnimationFrame(canvasStatusAnimation);
  canvasStatusAnimation = null;
  for (const canvas of loadingCanvasStatuses.keys()) {
    canvas.removeAttribute("aria-busy");
    canvas.dataset.renderState = "ready";
  }
  loadingCanvasStatuses.clear();
}

function scheduleCanvasStatusAnimation() {
  if (canvasStatusAnimation !== null || !loadingCanvasStatuses.size || loadingMotionPreference.matches) return;
  canvasStatusAnimation = requestAnimationFrame(animateCanvasStatuses);
}

function animateCanvasStatuses(now) {
  canvasStatusAnimation = null;
  // One shared loop, capped at 25 fps. Hidden/off-screen plots need no repaint.
  if (!document.hidden && now - lastCanvasAnimationPaint >= 40) {
    lastCanvasAnimationPaint = now;
    for (const [canvas, message] of loadingCanvasStatuses) {
      if (!canvas.isConnected || canvas.dataset.renderState !== "loading") {
        loadingCanvasStatuses.delete(canvas);
        continue;
      }
      const box = canvas.getBoundingClientRect();
      if (box.width && box.height && box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth) {
        paintCanvasStatus(canvas, message.title, message.detail, "loading", now);
      }
    }
  }
  scheduleCanvasStatusAnimation();
}

loadingMotionPreference.addEventListener("change", () => {
  if (canvasStatusAnimation !== null) cancelAnimationFrame(canvasStatusAnimation);
  canvasStatusAnimation = null;
  for (const [canvas, message] of loadingCanvasStatuses) paintCanvasStatus(canvas, message.title, message.detail, "loading");
  scheduleCanvasStatusAnimation();
});

function drawCanvasStatus(canvas, title, detail, state = "loading") {
  canvas.dataset.renderState = state;
  if (state === "loading") {
    canvas.setAttribute("aria-busy", "true");
    loadingCanvasStatuses.set(canvas, { title, detail });
  } else {
    canvas.removeAttribute("aria-busy");
    loadingCanvasStatuses.delete(canvas);
    if (!loadingCanvasStatuses.size && canvasStatusAnimation !== null) {
      cancelAnimationFrame(canvasStatusAnimation);
      canvasStatusAnimation = null;
    }
  }
  paintCanvasStatus(canvas, title, detail, state);
  scheduleCanvasStatusAnimation();
}

function paintCanvasStatus(canvas, title, detail, state, now = performance.now()) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const accent = state === "error" ? RED : state === "cancelled" ? MUTED : BLUE;
  const displayScale = width / Math.max(1, canvas.clientWidth || width);
  const titleSize = Math.max(22, Math.min(30, width * 0.03), 18 * displayScale);
  const detailSize = Math.max(15, Math.min(20, width * 0.02), 14 * displayScale);

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
  const dotRadius = Math.max(5, Math.min(8, width / 120), 5 * displayScale);
  const dotGap = dotRadius * 3;
  [-1, 0, 1].forEach((offset, index) => {
    const moving = state === "loading" && !loadingMotionPreference.matches;
    const phase = ((now / 1100 - index * 0.18) % 1 + 1) % 1;
    const lift = moving ? Math.max(0, Math.sin(phase * Math.PI * 2)) : 0;
    ctx.globalAlpha = moving ? 0.35 + 0.65 * lift : state === "loading" ? 0.4 + index * 0.3 : 0.75;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(centerX + offset * dotGap, centerY - titleSize * 1.65 - lift * dotRadius * 1.8, dotRadius, 0, Math.PI * 2);
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
  clearCanvasStatusAnimations();
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
  clearCanvasStatusAnimations();
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
  stopPositionPreview();
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

function drawAxisGrid(plot, xTicks, yTicks, useYDown = false) {
  const { ctx, margin, innerWidth, innerHeight, x, y, yDown, style } = plot;
  ctx.save();
  ctx.strokeStyle = GRID;
  ctx.lineWidth = style.gridWidth;
  for (const tick of xTicks.filter(Number.isFinite)) {
    const px = x(tick);
    ctx.beginPath(); ctx.moveTo(px, margin.top); ctx.lineTo(px, margin.top + innerHeight); ctx.stroke();
  }
  for (const tick of yTicks.filter(Number.isFinite)) {
    const py = useYDown ? yDown(tick) : y(tick);
    ctx.beginPath(); ctx.moveTo(margin.left, py); ctx.lineTo(margin.left + innerWidth, py); ctx.stroke();
  }
  ctx.restore();
}

function drawAxes(plot, xTicks, yTicks, useYDown = false, includeGrid = true) {
  const { ctx, margin, innerWidth, innerHeight, x, y, yDown, labels, width, height, style } = plot;
  const xValues = xTicks.filter(Number.isFinite);
  const yValues = yTicks.filter(Number.isFinite);
  const xFormatter = labels.xFormatter ?? (value => String(value));
  const yFormatter = labels.yFormatter ?? (value => String(value));
  if (includeGrid) drawAxisGrid(plot, xTicks, yTicks, useYDown);
  ctx.save();
  // Publication figures use black tick-label numerals; only the supporting
  // gridlines remain gray so the coordinate scale keeps full print contrast.
  ctx.fillStyle = INK;
  ctx.font = `${style.tickFontPx}px ${FIGURE_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const tick of xValues) {
    const px = x(tick);
    ctx.fillText(xFormatter(tick), px, margin.top + innerHeight + 15);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const tick of yValues) {
    const py = useYDown ? yDown(tick) : y(tick);
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
    const key = `${point.referenceViewIndex}:${point.absoluteViewIndex}:${point.focus ?? 0}:${point.row}`;
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

function drawDiagramFamilyLegend(ctx, diagram, left, y, width, includeMarkers = true) {
  const paired = diagram.traceFamilies?.some(trace => trace.family === "complementary");
  const rolesOnly = diagram.roleMarkersOnly && includeMarkers;
  const items = [];
  if (diagram.visibleRole !== 'complementary') items.push({ label: diagram.directLegendLabel ?? localizedText("実データ側 ○", "Direct ○"), dashed: false, color: INK, noLine: rolesOnly });
  if ((paired || rolesOnly) && diagram.visibleRole !== 'direct') items.push({ label: localizedText("対向データ側 △", "Complementary △"), dashed: true, color: INK, noLine: rolesOnly });
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
    if (!item.noLine) { ctx.beginPath(); ctx.moveTo(start, y); ctx.lineTo(start + 30, y); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.fillStyle = INK;
    // A geometry-only overview has trajectories but no selected-point glyphs.
    const label = includeMarkers ? item.label : item.label.replace(/\s*[○△]/g, "");
    setFittedFigureFont(ctx, label, 26, 22, columnWidth - 44);
    ctx.fillText(label, start + (item.noLine ? 0 : 40), y);
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
  if(trace.frontier&&angles.length){
    const i=angles.length-1,delta=axial[i]+turn*feed+scales[i]*rowOffset-diagram.z0;
    ctx.globalCompositeOperation='source-over';ctx.globalAlpha=.95;ctx.fillStyle=rowColor(row,totalRows);
    ctx.fillRect(x(delta)-3,yDown(angles[i])-3,6,6);
  }
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
  drawDiagramFamilyLegend(ctx, diagram, left, top + 76, width, false);
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
  const angleMin=diagram.angleMin??0,angleMax=diagram.angleMax??360;
  const plot = axisContext(canvas, { xMin: xAxis.xMin, xMax: xAxis.xMax, yMin: angleMin, yMax: angleMax }, {
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
  // Paint supporting guides behind all trajectories, weight glyphs and the
  // target plane. Keep the black frame, ticks and labels in the foreground.
  const angleTicks = angleMax-angleMin===360?[0,60,120,180,240,300,360]:Array.from({length:7},(_,i)=>angleMin+(angleMax-angleMin)*i/6);
  drawAxisGrid(plot, xAxis.ticks, angleTicks, true);
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, innerWidth, innerHeight);
  ctx.clip();
  // Every family is expressed in the same DIRECT reference-angle coordinate.
  // In particular, complementary markers are not drawn on direct-only traces.
  const traceFamilies = diagram.traceFamilies ?? [diagram.traceGeometry];
  for (const trace of traceFamilies) {
    if(diagram.construction){
      for(const turn of diagram.traceGeometry.turns){
        const partial=SSPZConstruction.prefix(trace,turn,diagram.construction.cutoff);
        if(!partial.angles.length)continue;
        for(let row=0;row<diagram.totalRows;row++)drawCandidateTrace(ctx,diagram,partial,row,turn,x,yDown,xLimit);
      }
      continue;
    }
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
  drawAxes(plot, xAxis.ticks, angleTicks, true, false);
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
  canvas.dataset.angleMin=String(angleMin);canvas.dataset.angleMax=String(angleMax);
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
  canvas.dataset.markerAggregation = "referenceViewIndex:absoluteViewIndex:focus:row;sum-contributions";
  canvas.dataset.rawMarkerContributions = String(mode === "zoom" ? diagram.weightedPoints.length : 0);
  canvas.dataset.uniqueAcquiredMarkers = String(mergedPoints.length);
  canvas.dataset.inlineRowLabels = "0";
  canvas.dataset.traceOverlapEncoding = "multiply;opacity-and-width-density-compensated;not-weight";
  canvas.dataset.diagramDisplayVersion = "2026-09-16.1";
  canvas.dataset.gridLayer = "behind-trajectories-and-markers";
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
    if (!Number.isFinite(z[index]) || !Number.isFinite(value) || (tailView && value < PROFILE_TAIL_DISPLAY_BOUNDS.minimum)) {
      active = false;
      continue;
    }
    const px = x(z[index]);
    const py = y(tailView ? Math.log10(value) : value);
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
  const tail = configuredOverlayBounds(result, PROFILE_TAIL_DISPLAY_BOUNDS.minimum, core.xMax, ["on"]);
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
      ? value => ({ "-2": "1%", "-1": "10%", "0": "100%" }[String(value)] ?? "")
      : value => value.toFixed(1),
    topMargin: publicationMode ? 116 : 126,
    leftMargin: tailView ? 158 : undefined,
  });

  // The 100% plateau can coincide exactly with a gridline. Keep the grid
  // behind every individual SSPz in both the screen and publication paths.
  drawAxes(plot, xAxis.ticks, tailView ? [-2, -1, 0] : [0, 0.2, 0.4, 0.6, 0.8, 1.0]);
  plot.ctx.save();
  plot.ctx.beginPath();
  plot.ctx.rect(plot.margin.left, plot.margin.top, plot.innerWidth, plot.innerHeight);
  plot.ctx.clip();

  // Draw all 360 configured-output states as separate paths, without a
  // summary band or state decimation. The core view is linear and restricted
  // to >=10%; the tail view is logarithmic and restricted to >=1%.
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
    canvas.dataset.renderedMinimum = String(PROFILE_TAIL_DISPLAY_BOUNDS.minimum);
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
  writeParams(WEB_DEFAULT_PARAMS);
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
function persistTemporalSettings() {
  const params = readParams();
  // Rotation time remains editable while a spatial sweep is running. Preserve
  // the visible values of its disabled spatial inputs in shared URLs/storage.
  for (const [key, value] of Object.entries(params)) {
    const input = form.elements.namedItem(key);
    if (input?.disabled && key !== "rotationTime") params[key] = typeof value === "number" ? Number(input.value) : input.value;
  }
  if (typeof fdkRunParams !== "undefined" && fdkRunParams) fdkRunParams.rotationTime = params.rotationTime;
  const url = paramsToUrl(params);
  try { history.replaceState(null, "", url); localStorage.setItem("sspz-unwrapped-params", JSON.stringify(params)); } catch {}
  syncLanguageLinks(url.search);
}

form.addEventListener("input", event => {
  updateInputDecorations();
  if (event.target?.name === "rotationTime") {
    if (typeof refreshTemporalDisplay === "function") refreshTemporalDisplay();
    persistTemporalSettings();
    return;
  }
  schedulePositionPreview();
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
  schedulePositionPreview();
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
    const stored = JSON.parse(localStorage.getItem("sspz-unwrapped-params"));
    if (!stored) return { ...WEB_DEFAULT_PARAMS, zFfsEnabled: false };
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
    // Saved conditions without explicit detector fields used the historical
    // 0.25-mm defaults; do not silently recalculate them at the new defaults.
    return {
      ...DEFAULT_PARAMS, ...stored,
      rotationTime: rotationTimeFromSettings(stored),
      channelWidth: stored.channelWidth ?? DEFAULT_PARAMS.channelWidth,
      channelApertureMm: stored.channelApertureMm ?? stored.channelWidth ?? DEFAULT_PARAMS.channelApertureMm,
      focalSizeMm: stored.focalSizeMm ?? 0,
      focalSourceDetectorMm: stored.focalSourceDetectorMm
        ?? ((stored.zFfsMagnification!=null||stored.zFfsEnabled)
          ? (stored.zFfsMagnification??1072/600)*(stored.sourceRadius??DEFAULT_PARAMS.sourceRadius) : 1070),
      zFfsEnabled: false,
    };
  }
  catch { return WEB_DEFAULT_PARAMS; }
})();
if(initial!==DEFAULT_PARAMS && (initial.thicknessMapping!=='configured-rectangular' || initial.detectorModel!=='finite-channel'))legacyInputMigrated=true;
// Old saved 3D conditions used channelWidth for both physical aperture and pitch.
if(initial!==DEFAULT_PARAMS && initial.channelApertureMm==null)initial.channelApertureMm=initial.channelWidth??DEFAULT_PARAMS.channelApertureMm;
writeParams({ ...DEFAULT_PARAMS, ...initial, filterWidthMm:initial.sliceThicknessMm??DEFAULT_PARAMS.sliceThicknessMm, thicknessMapping:'configured-rectangular' });
if (legacyUrlNote) {
  legacyUrlNote.hidden = !legacyInputMigrated;
  if (legacyInputMigrated) legacyUrlNote.textContent = localizedText("面内有限開口を含むコーン幾何モデルで再計算します。旧版の体軸補間モデルの結果とは区別してください。設定厚Tは平均化幅として使用します。", "Recalculation uses cone geometry with a finite transaxial aperture. Keep results from the older axial model separate. Configured thickness T sets the averaging width.");
}
initializeFdkUi(initial);
initializePositionPreview();
schedulePositionPreview(0);

})();
