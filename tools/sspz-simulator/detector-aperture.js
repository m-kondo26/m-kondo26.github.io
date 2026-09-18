// Shared physical cell aperture. Coordinates, pitch and aperture use the same
// units. Sampling pitch is not aperture width; a gap is not filled by a ray.
export function detectorCellMembership(coordinate, pitch, aperture, count) {
  if (!(pitch > 0 && aperture > 0 && aperture <= pitch && Number.isInteger(count) && count > 0))
    throw Error('DETECTOR_APERTURE: require 0 < aperture <= channel spacing');
  const q=coordinate/pitch+(count-1)/2, radius=aperture/(2*pitch), out=[];
  for(let k=Math.max(0,Math.ceil(q-radius-1e-10));k<=Math.min(count-1,Math.floor(q+radius+1e-10));k++){
    const distance=Math.abs(q-k), boundary=Math.abs(distance-radius)<=1e-10;
    if(boundary||distance<radius)out.push([k,boundary?.5:1]);
  }
  return out;
}

export const FINITE_FOCUS_VERSION='2026-09-18.1';
// Effective axial focal width at the source, not the physical target length.
// The source-detector distance belongs to the fixed detector geometry. With
// z-FFS, its existing magnification defines that same physical distance.
export function finiteFocusConfig(input,c){
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
export function focalBlurWidth(c,L=c.sourceRadius){
  return (c.focalSizeMm??0)*Math.abs(1-L/(c.zFfsEnabled?c.zFfsSourceDetectorMm:(c.focalSourceDetectorMm??1070)));
}
export function focalBlurMetadata(c){
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
export function detectorAxialFocusRows(c,w0,wRay0,L,parallel=false){
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
export function detectorPointProjection(c,beta,zObject,parallel=false){
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
export function detectorRowReadout(c,p,row){
  if(row<p.k0||row>p.k1)return 0;
  const q=p.transverse/c.channelWidth+(c.channels-1)/2,j=Math.floor(q),a=q-j;
  const at=k=>k<p.j0||k>p.j1?0:p.data[(row-p.k0)*p.width+k-p.j0];
  return (1-a)*at(j)+a*at(j+1);
}
