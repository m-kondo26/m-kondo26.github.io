// Static-table, reduced axial response following the operations described at
// Mori et al., CT and MRI, pp.72–74 (Fig.6.25). See MORI_STATIC_METHOD.md.
// This is an explicit reduced finite-focus benchmark, not an exact reproduction of that
// figure, a full image FDK reconstruction, or the helical simulator's operator.
export const MORI_STATIC_VERSION = '2026-09-18.2';
export const MORI_STATIC_DEFAULTS = Object.freeze({
  rows:16,rowPitch:2,axialAperture:2,sourceRadius:600,detectorDistance:1070,
  viewSamples:900,zStep:.05,radii:Object.freeze([0,80,160]),
  focalSizeMm:1.2,focalTransverseMm:1.2,targetAngleDeg:7,
});
const TAU=2*Math.PI;
const EPS=1e-11;

export function moriStaticConfig(input={}) {
  const c={...MORI_STATIC_DEFAULTS,...input};
  c.radii=Array.from(input.radii??MORI_STATIC_DEFAULTS.radii);
  for(const name of ['rowPitch','axialAperture','sourceRadius','detectorDistance','zStep'])
    if(!Number.isFinite(c[name])||c[name]<=0)throw Error(`${name}: positive finite value required`);
  if(!Number.isInteger(c.rows)||c.rows<1||c.rows>320)throw Error('rows: integer 1–320 required');
  if(!Number.isInteger(c.viewSamples)||c.viewSamples<4||c.viewSamples>14400)throw Error('viewSamples: integer 4–14400 required');
  if(c.axialAperture>c.rowPitch)throw Error('axialAperture must not exceed rowPitch');
  if(c.detectorDistance<=c.sourceRadius)throw Error('detectorDistance is source-to-detector and must exceed sourceRadius');
  for(const name of ['focalSizeMm','focalTransverseMm'])
    if(!Number.isFinite(c[name])||c[name]<0)throw Error(`${name}: nonnegative finite value required`);
  if(!Number.isFinite(c.targetAngleDeg)||c.targetAngleDeg<=0||c.targetAngleDeg>=90)
    throw Error('targetAngleDeg: reference angle between 0 and 90 required');
  if(!c.radii.length||c.radii.length>10||c.radii.some(r=>!Number.isFinite(r)||r<0||r>=c.sourceRadius))
    throw Error('radii: up to ten nonnegative positions inside the source orbit required');
  c.sourceZ=0;c.focalSpotModel=c.focalSizeMm===0?'ideal-point':'uniform-effective-axial';c.normalization='unit-area';
  c.targetAngleUse='reference-only-effective-size-already-specified';
  c.baseNormalization=c.focalSizeMm===0?'peak-one':'detector-peak-one-focus-unit-area';
  c.apertureGeometry='local-cone-scaled';
  c.edgePolicy='nearest-end-row';c.beamPitch=0;
  return c;
}

function rowZ(c,row) {return (row-(c.rows-1)/2)*c.rowPitch;}
function validateSelection(c,{row,radius,angleDeg}) {
  if(!Number.isInteger(row)||row<0||row>=c.rows)throw Error('row outside detector');
  if(!Number.isFinite(radius)||radius<0||radius>=c.sourceRadius)throw Error('radius outside source orbit');
  if(!Number.isFinite(angleDeg))throw Error('angleDeg must be finite');
}

// Each row is on a source-centred cylindrical detector. All source and row
// coordinates remain fixed while the reconstruction plane is selected.
export function moriStaticView(config,selection={}) {
  const c=moriStaticConfig(config);
  const {row=0,radius=c.radii[0],angleDeg=0}=selection;
  validateSelection(c,{row,radius,angleDeg});
  const beta=angleDeg*Math.PI/180,R=c.sourceRadius;
  const source={x:R*Math.cos(beta),y:R*Math.sin(beta),z:0};
  const U=R-radius*Math.cos(beta),L=Math.hypot(source.x-radius,source.y);
  const scale=L/R,zPlane=rowZ(c,row),spacing=c.rowPitch*scale;
  const rowCentres=Float64Array.from({length:c.rows},(_,k)=>rowZ(c,k)*scale);
  const detectorRowCentres=Float64Array.from({length:c.rows},(_,k)=>rowZ(c,k)*c.detectorDistance/R);
  const q=zPlane/spacing+(c.rows-1)/2;
  let selected,edgeSide=null;
  if(q< -EPS){selected=[{row:0,weight:1}];edgeSide='low';}
  else if(q>c.rows-1+EPS){selected=[{row:c.rows-1,weight:1}];edgeSide='high';}
  else {
    const clipped=Math.max(0,Math.min(c.rows-1,q)),nearest=Math.round(clipped);
    if(Math.abs(clipped-nearest)<EPS)selected=[{row:nearest,weight:1}];
    else {const lo=Math.floor(clipped),a=clipped-lo;selected=[{row:lo,weight:1-a},{row:lo+1,weight:a}];}
  }
  // A displacement t of the effective source with the detector fixed moves
  // the ray's intersection at L by t(1-L/D). focalSizeMm is already effective:
  // the reference target angle is not applied a second time.
  const focalBlurMm=c.focalSizeMm*Math.abs(1-L/c.detectorDistance);
  selected=selected.map(s=>({...s,zCentre:rowCentres[s.row],apertureMm:c.axialAperture*scale,
    focalBlurMm,effectiveFocalSizeMm:c.focalSizeMm}));
  // The curved-detector inverse-square factor is expressed using transverse
  // source-to-point distance. See the explicit convention in the method note.
  const backprojectionWeight=(R/L)**2;
  return {angleDeg,beta,row,radius,zPlane,source,transverseDistance:L,radialDistance:U,
    detectorDistance:c.detectorDistance,magnification:scale,rowScale:scale,physicalMagnification:c.detectorDistance/L,rowCentres,detectorRowCentres,
    rowPitchMmAtPoint:spacing,focalBlurMm,effectiveFocalSizeMm:c.focalSizeMm,
    selected,edgeFallback:edgeSide!==null,edgeSide,backprojectionWeight};
}

function supportExtent(c,radius) {
  const near=1-(c.sourceRadius-radius)/c.detectorDistance;
  const far=1-(c.sourceRadius+radius)/c.detectorDistance;
  const focusHalf=c.focalSizeMm*Math.max(Math.abs(near),Math.abs(far))/2;
  return ((c.rows-1)*c.rowPitch+c.axialAperture)/2*(1+radius/c.sourceRadius)+focusHalf;
}

export function moriStaticGrid(config,{radius}={}) {
  const c=moriStaticConfig(config),r=radius??Math.max(...c.radii);
  if(!Number.isFinite(r)||r<0||r>=c.sourceRadius)throw Error('radius outside source orbit');
  // Full support of every acquired aperture plus focal blur, at every angle, plus two
  // empty bins. This avoids truncating outer-row shapes for normalization.
  const support=supportExtent(c,r);
  const half=Math.ceil(support/c.zStep)+2;
  if(2*half+1>50001)throw Error('Static axial grid exceeds 50001 bins');
  return Float64Array.from({length:2*half+1},(_,i)=>(i-half)*c.zStep);
}

function gridInfo(z) {
  if(!z||z.length<3)throw Error('At least three uniform axial bins required');
  const dz=z[1]-z[0];
  if(!Number.isFinite(dz)||dz<=0)throw Error('Increasing uniform axial bins required');
  for(let i=0;i<z.length;i++)if(!Number.isFinite(z[i])||Math.abs(z[i]-(z[0]+i*dz))>1e-7*Math.max(1,Math.abs(z[i])))
    throw Error('Uniform finite axial bins required');
  return {dz,left:z[0]-dz/2};
}

function checkSupport(c,radius,z,g) {
  const support=supportExtent(c,radius);
  if(g.left> -support+EPS||g.left+z.length*g.dz<support-EPS)
    throw Error('Axial bins must contain full detector-aperture and focal-blur support');
}

// Exact cell averages of a rectangle whose integral is mass. This is sampling
// of B(z), not an additional filter or finite measurement target.
function addRectangle(out,z,g,centre,width,mass) {
  const left=centre-width/2,right=centre+width/2;
  const first=Math.max(0,Math.floor((left-g.left)/g.dz));
  const last=Math.min(out.length-1,Math.ceil((right-g.left)/g.dz)-1);
  for(let i=first;i<=last;i++){
    const a=Math.max(left,g.left+i*g.dz),b=Math.min(right,g.left+(i+1)*g.dz);
    if(b>a)out[i]+=mass*(b-a)/(width*g.dz);
  }
}

// Exact difference of the piecewise quadratic CDF of two uniform rectangles.
// Factored differences avoid subtracting CDF values close to one in the right
// tail. This integrates the trapezoid over each display bin; no smoothing of
// an already sampled or normalized SSP is performed.
function trapezoidProbability(left,right,widthA,widthB) {
  const A=Math.max(widthA,widthB),B=Math.min(widthA,widthB);
  const half=(A+B)/2,plateau=(A-B)/2;
  const lo=Math.max(-half,left),hi=Math.min(half,right);
  if(hi<=lo)return 0;
  let p=0,a=lo,b=Math.min(hi,-plateau);
  if(b>a)p+=(b-a)*(a+b+2*half)/(2*A*B);
  a=Math.max(lo,-plateau);b=Math.min(hi,plateau);
  if(b>a)p+=(b-a)/A;
  a=Math.max(lo,plateau);b=hi;
  if(b>a)p+=(b-a)*(2*half-a-b)/(2*A*B);
  return Math.max(0,p);
}

function addBlurredRectangle(out,z,g,centre,apertureMm,focalBlurMm,mass) {
  if(focalBlurMm===0){addRectangle(out,z,g,centre,apertureMm,mass);return;}
  const half=(apertureMm+focalBlurMm)/2;
  const first=Math.max(0,Math.floor((centre-half-g.left)/g.dz));
  const last=Math.min(out.length-1,Math.ceil((centre+half-g.left)/g.dz)-1);
  for(let i=first;i<=last;i++){
    const left=g.left+i*g.dz-centre,right=g.left+(i+1)*g.dz-centre;
    out[i]+=mass*trapezoidProbability(left,right,apertureMm,focalBlurMm)/g.dz;
  }
}

function angleProfile(c,selection,z,g) {
  const view=moriStaticView(c,selection),raw=new Float64Array(z.length),components=[];
  for(const s of view.selected){
    const profile=new Float64Array(z.length);
    // Book Eq.6.8 defines B_D as a peak-one rectangle. Do not independently
    // area-normalize the angle kernels: final SSP normalization comes later.
    addBlurredRectangle(profile,z,g,s.zCentre,s.apertureMm,s.focalBlurMm,s.apertureMm*s.weight*view.backprojectionWeight);
    for(let i=0;i<raw.length;i++)raw[i]+=profile[i];
    components.push({...s,profile});
  }
  return {...view,z,raw,components};
}

export function moriStaticAngleProfile(config,selection={}) {
  const c=moriStaticConfig(config),z=selection.z??moriStaticGrid(c,{radius:selection.radius});
  const g=gridInfo(z);checkSupport(c,selection.radius??c.radii[0],z,g);
  return angleProfile(c,selection,z,g);
}

function accumulate(c,row,radius,z,g,lastView=c.viewSamples) {
  const raw=new Float64Array(z.length);let edgeCount=0,weightSum=0,area=0,firstMoment=0,secondMoment=0;
  for(let i=0;i<lastView;i++){
    const v=moriStaticView(c,{row,radius,angleDeg:i*360/c.viewSamples});
    if(v.edgeFallback)edgeCount++;
    weightSum+=v.backprojectionWeight/c.viewSamples;
    for(const s of v.selected){
      const mass=s.apertureMm*s.weight*v.backprojectionWeight/c.viewSamples;
      addBlurredRectangle(raw,z,g,s.zCentre,s.apertureMm,s.focalBlurMm,mass);
      area+=mass;firstMoment+=mass*s.zCentre;
      secondMoment+=mass*(s.zCentre*s.zCentre+(s.apertureMm*s.apertureMm+s.focalBlurMm*s.focalBlurMm)/12);
    }
  }
  return {raw,edgeCount,weightSum,moments:{area,firstMoment,secondMoment}};
}

function measure(z,raw,g,zPlane,moments) {
  let area=0,moment=0;
  for(let i=0;i<raw.length;i++){const a=raw[i]*g.dz;area+=a;moment+=a*z[i];}
  if(!(area>0))throw Error('No positive static response area');
  const profile=Float64Array.from(raw,v=>v/area),sampledCentroid=moment/area;
  const centroid=moments.firstMoment/moments.area;
  let variance=0,peak=0;
  for(let i=0;i<raw.length;i++){
    // Cell-integrated second moment. Numerical cell representation contributes
    // dz²/12, converging to the continuous aperture response as dz -> 0.
    variance+=profile[i]*g.dz*((z[i]-sampledCentroid)**2+g.dz*g.dz/12);
    peak=Math.max(peak,profile[i]);
  }
  const level=peak/2;let first=-1,last=-1;
  for(let i=0;i<profile.length;i++)if(profile[i]>=level){if(first<0)first=i;last=i;}
  const crossing=(i,j)=>z[i]+(level-profile[i])*(z[j]-z[i])/(profile[j]-profile[i]);
  const left=first>0?crossing(first-1,first):null,right=last<profile.length-1?crossing(last,last+1):null;
  const fwhm=left!==null&&right!==null?right-left:null;
  const exactVariance=Math.max(0,moments.secondMoment/moments.area-centroid*centroid);
  return {raw,profile,area,centroid,centroidOffset:centroid-zPlane,sigma:Math.sqrt(exactVariance),
    sampledCentroid,sampledSigma:Math.sqrt(variance),peak,fwhm,halfMaxLeft:left,halfMaxRight:right};
}

export function moriStaticCalculate(config={}) {
  const c=moriStaticConfig(config),z=moriStaticGrid(c),g=gridInfo(z),groups=[];
  for(const radius of c.radii){
    const profiles=[];
    for(let row=0;row<c.rows;row++){
      const result=accumulate(c,row,radius,z,g),zPlane=rowZ(c,row);
      profiles.push({row,zPlane,...measure(z,result.raw,g,zPlane,result.moments),edgeCount:result.edgeCount,
        edgeFraction:result.edgeCount/c.viewSamples,weightSum:result.weightSum});
    }
    groups.push({radius,profiles});
  }
  return {version:MORI_STATIC_VERSION,config:c,z,groups};
}

// Uses actual acquisition angles and the final response area. Intermediate
// frames accumulate mass; they are never independently renormalized to area 1.
export function moriStaticProgress(config,selection={}) {
  const c=moriStaticConfig(config),{row=0,radius=c.radii[0],angleDeg=360}=selection;
  validateSelection(c,{row,radius,angleDeg});
  const z=selection.z??moriStaticGrid(c,{radius}),g=gridInfo(z);
  checkSupport(c,radius,z,g);
  const viewsIncluded=angleDeg>=360?c.viewSamples:angleDeg<=0?0:Math.ceil(angleDeg/360*c.viewSamples-1e-10);
  const total=accumulate(c,row,radius,z,g),part=viewsIncluded===c.viewSamples?total:accumulate(c,row,radius,z,g,viewsIncluded);
  const normalizingArea=total.raw.reduce((a,b)=>a+b*g.dz,0);
  return {z,profile:Float64Array.from(part.raw,v=>v/normalizingArea),fraction:viewsIncluded/c.viewSamples,
    viewsIncluded,viewCount:c.viewSamples,normalizingArea,edgeCount:part.edgeCount};
}
