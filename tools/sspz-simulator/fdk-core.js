// Full-turn FDK on a helix, with acquired cylindrical detector data rebinned
// to a virtual flat detector. Sources and assumptions: FDK_METHOD.md.
// A declared image-domain rectangular average follows FBP; no target-width fit or scanner-specific thickness kernel.
import {detectorPointProjection} from './detector-aperture.js';
export const FDK_VERSION = '2026-09-17.4';
export const FDK_DEFAULTS = Object.freeze({
  rows:80,rowWidth:.5,beamPitch:.5,sourceRadius:600,radius:100,
  viewSamples:360,phase:0,state:0,sphereDiameter:.65,channelWidth:.25,
  apertureSamples:8,xyExtent:1.5,xySamples:17,zExtent:3,zStep:.05,
  phaseCount:1,normalization:'minmax',axialAverageMm:0,objectModel:'sphere',
});
const FDK_TAU=2*Math.PI;
export function fdkConfig(input={}) {
  const c={...FDK_DEFAULTS,...input};
  c.channelApertureMm=Number(input.channelApertureMm??c.channelWidth);
  if(!(c.channelApertureMm>0&&c.channelApertureMm<=c.channelWidth))throw Error('DETECTOR_APERTURE: require 0 < aperture <= channel spacing');
  if(!['point','sphere'].includes(c.objectModel))throw Error('Unknown object model');
  // Legacy numerical API remains explicit/reproducible. The browser selects
  // point. In that branch these obsolete sphere controls have no effect.
  if(c.objectModel==='point'){c.sphereDiameter=0;c.apertureSamples=0;}
  if(c.thicknessMapping==='configured-rectangular'){
    if(!Number.isFinite(c.sliceThicknessMm)||c.sliceThicknessMm<=0||c.sliceThicknessMm>20)throw Error('THICKNESS: configured thickness must be > 0 and <= 20 mm');
    c.axialAverageMm=c.sliceThicknessMm;
  }
  for(const k of Object.keys(FDK_DEFAULTS)) if(!['normalization','objectModel'].includes(k)&&!Number.isFinite(c[k])) throw Error(`${k}: finite value required`);
  for(const [k,lo,hi] of [['rows',input.response==='axial-interpolation'?1:2,320],['viewSamples',90,2400],['apertureSamples',1,32],['xySamples',5,65],['phaseCount',1,360]])
    if(!(c.objectModel==='point'&&k==='apertureSamples')&&(!Number.isInteger(c[k])||c[k]<lo||c[k]>hi))throw Error(`${k}: integer ${lo}–${hi} required`);
  for(const [k,lo,hi] of [['axialAverageMm',0,20],['rowWidth',.05,10],['beamPitch',0,3],['sourceRadius',100,2000],['radius',0,250],['sphereDiameter',.1,10],['channelWidth',.05,1],['xyExtent',.5,10],['zExtent',1,20],['zStep',.01,.2],['state',0,1]])
    if(!(c.objectModel==='point'&&k==='sphereDiameter')&&(c[k]<lo||c[k]>hi))throw Error(`${k}: ${lo}–${hi} required`);
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
export function fdkSphereChord(sx,sy,sz,dx,dy,dz,cx,cy,cz,a) {
  const n=Math.hypot(dx,dy,dz);dx/=n;dy/=n;dz/=n;
  const vx=cx-sx,vy=cy-sy,vz=cz-sz,t=vx*dx+vy*dy+vz*dz;
  const px=vy*dz-vz*dy,py=vz*dx-vx*dz,pz=vx*dy-vy*dx;
  const disc=a*a-px*px-py*py-pz*pz;
  if(disc<=0)return 0;
  const root=Math.sqrt(disc);return Math.max(0,t+root)-Math.max(0,t-root);
}
export function fdkCoordinates(c,beta,x,y,z) {
  const cb=Math.cos(beta),sb=Math.sin(beta),D=c.sourceRadius-x*cb-y*sb;
  const u=c.sourceRadius*(-x*sb+y*cb)/D;
  const v=c.sourceRadius*(z-c.feed*(beta-c.phase)/FDK_TAU)/D;
  const gamma=Math.atan2(u,c.sourceRadius);
  return {u,v,gamma,w:v*Math.cos(gamma),weight:(c.sourceRadius/D)**2};
}
export function fdkRowPosition(c,beta,row) {
  const L=Math.hypot(c.sourceRadius*Math.cos(beta)-c.radius,c.sourceRadius*Math.sin(beta));
  return c.feed*(beta-c.phase)/FDK_TAU+(row-(c.rows-1)/2)*c.rowWidth*L/c.sourceRadius;
}
export function fdkRamp(k,du) {
  return k===0?1/(4*du):Math.abs(k)%2===1?-1/(Math.PI*Math.PI*k*k*du):0;
}
export function fdkWidth(z,y,level) {
  let p=0;for(let i=1;i<y.length;i++)if(y[i]>y[p])p=i;
  let l=p,r=p;while(l>0&&y[l]>=level)l--;while(r<y.length-1&&y[r]>=level)r++;
  if(l===p||r===p||y[l]>=level||y[r]>=level)return null;
  const left=z[l]+(level-y[l])*(z[l+1]-z[l])/(y[l+1]-y[l]);
  const right=z[r-1]+(level-y[r-1])*(z[r]-z[r-1])/(y[r]-y[r-1]);
  return {width:right-left,left,right};
}
// Cell-averaged projection of a unit-integral Cartesian Dirac point. This is
// the analytic zero-size limit, not a small sphere or a voxel phantom.
// In X=S+lambda*d(gamma,w), |J|=lambda^2 R^2 and dl=|d| d lambda.
// Thus the delta mass in detector (gamma,w) is hypot(R,w)/L^2.
// See POINT_RESPONSE_METHOD.md for the derivation and boundary convention.
export function fdkPointProjection(c,beta,zObject){
  return detectorPointProjection({...c,sourceZ:c.feed*(beta-c.phase)/FDK_TAU},beta,zObject);
}
// Store only the analytically bounded nonzero sphere projection. Missing
// entries are exact air measurements, not a cropped object or missing rays.
export function fdkArcProjection(c,beta,zObject) {
  if(c.objectModel==='point')return fdkPointProjection(c,beta,zObject);
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
      const aperture=c.channelApertureMm??c.channelWidth;
      const g=aperture===c.channelWidth
        ? (j-(c.channels-1)/2+(au+.5)/A-.5)*dg
        : (j-(c.channels-1)/2)*dg+((au+.5)/A-.5)*aperture/R;
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
export function fdkRebinAt(c,p,u,v) {
  const g=Math.atan2(u,c.sourceRadius),fj=g*c.sourceRadius/c.channelWidth+(c.channels-1)/2;
  const fk=v*Math.cos(g)/c.rowWidth+(c.rows-1)/2,j=Math.floor(fj),k=Math.floor(fk),a=fj-j,b=fk-k;
  // Air is zero outside the finite acquired array, only after full signal
  // support and reconstruction ray coverage have been checked independently.
  return (1-b)*((1-a)*fdkArcAt(c,p,j,k)+a*fdkArcAt(c,p,j+1,k))+b*((1-a)*fdkArcAt(c,p,j,k+1)+a*fdkArcAt(c,p,j+1,k+1));
}
// Full discrete convolution evaluated only at the needed output columns.
// Every nonzero input column participates; no filter support is truncated.
export function fdkFilteredPatch(c,p,i0,i1) {
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
// Continuous rectangular mean of a piecewise-linear sampled image column.
// The caller supplies reconstructed padding; no zero extension or clamping.
export function fdkSlabMean(values,dz,width,padding){
  if(width===0)return Float64Array.from(values);
  const n=values.length,prefix=new Float64Array(n),out=new Float64Array(n-2*padding);
  for(let i=1;i<n;i++)prefix[i]=prefix[i-1]+(values[i-1]+values[i])*dz/2;
  const integral=x=>{if(x<-1e-9||x>n-1+1e-9)throw Error('FDK_DOMAIN: missing reconstructed slab padding');
    x=Math.max(0,Math.min(n-1,x));const i=Math.min(n-2,Math.floor(x)),f=x-i;
    return prefix[i]+dz*(values[i]*f+(values[i+1]-values[i])*f*f/2);};
  const half=width/(2*dz);
  for(let i=0;i<out.length;i++){const j=i+padding;out[i]=(integral(j+half)-integral(j-half))/width;}
  return out;
}
// Exact coefficients of the same piecewise-linear rectangular integral.
// These are used only to trace the centre image sample, not to reconstruct it.
export function fdkSlabCoefficients(length,dz,width){
  const out=new Float64Array(length),mid=(length-1)/2;
  if(width===0){out[mid]=1;return out;}
  const lo=mid-width/(2*dz),hi=mid+width/(2*dz);
  for(let i=Math.floor(lo);i<Math.ceil(hi);i++){
    const a=Math.max(0,lo-i),b=Math.min(1,hi-i),right=(b*b-a*a)/2;
    out[i]+=dz*(b-a-right)/width;out[i+1]+=dz*right/width;
  }
  return out;
}
function fdkVolumeGeometry(c,zObject) {
  const n=c.xySamples,half=c.xyExtent;
  const x=Float64Array.from({length:n},(_,i)=>c.radius-half+2*half*i/(n-1));
  const y=Float64Array.from({length:n},(_,i)=>-half+2*half*i/(n-1));
  const padding=Math.ceil(c.axialAverageMm/(2*c.zStep));
  const z=Float64Array.from({length:c.zSamples+2*padding},(_,i)=>zObject-c.zExtent+(i-padding)*c.zStep);
  const db=FDK_TAU/c.viewSamples,starts=Int32Array.from(z,v=>Math.ceil(((c.feed?FDK_TAU*v/c.feed:0)-Math.PI)/db-1e-12));
  return {x,y,z,starts,padding,first:Math.min(...starts),last:Math.max(...starts)+c.viewSamples,db};
}
export function fdkCheckCoverage(c,g,zObject) {
  // Backprojection and the intermediate flat-grid interpolation need valid
  // acquired center support. Include a one-flat-cell guard for rebinning.
  const R=c.sourceRadius,a=c.sphereDiameter/2,dg=c.channelWidth/R;
  for(let view=g.first;view<g.last;view++){
    const beta=c.phase+view*g.db;
    const cb=Math.cos(beta),sb=Math.sin(beta),L=Math.hypot(R*cb-c.radius,R*sb),zs=c.feed*(beta-c.phase)/FDK_TAU;
    const wc=R*(zObject-zs)/L,wa=R*a/(L-a)+Math.abs(wc)*a/(L-a);
    if(Math.abs(wc)+wa>(c.rows/2)*c.rowWidth)throw Error('FDK_COVERAGE: the object projection is axially truncated. Reduce pitch or z extent; this full-turn FDK does not extrapolate missing data.');
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
export async function reconstructFdk(input={},hooks={}) {
  const c=fdkConfig(input),zObject=c.state*c.feed,g=fdkVolumeGeometry(c,zObject);
  fdkCheckCoverage(c,g,zObject);
  const n=c.xySamples,nxy=n*n,volume=new Float64Array(nxy*g.z.length),counts=new Uint16Array(g.z.length);
  const activePixels=[];for(let iy=0;iy<n;iy++)for(let ix=0;ix<n;ix++)if(!hooks.profileOnly||(g.x[ix]-c.radius)**2+g.y[iy]**2<=(c.sphereDiameter/2)**2+1e-12)activePixels.push(iy*n+ix);
  const weightMap=new Map(),slab=fdkSlabCoefficients(g.z.length,c.zStep,c.axialAverageMm);let lastYield=performance.now();
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
    for(let iz=0;iz<g.z.length;iz++)if(view>=g.starts[iz]&&view<g.starts[iz]+c.viewSamples){
      const dz=g.z[iz]-c.feed*(beta-c.phase)/FDK_TAU;counts[iz]++;
      for(const j of activePixels)volume[iz*nxy+j]+=fdkSamplePatch(c,patch,us[j],dz*scales[j])*weights[j]*g.db/2;
      if(!hooks.profileOnly&&slab[iz]>0){
        const j=(nxy-1)/2,fu=us[j]/c.channelWidth-c.uOffset,i=Math.floor(fu),a=fu-i,fv=dz*scales[j]/c.rowWidth-c.vOffset,k=Math.floor(fv),b=fv-k;
        for(const [row,w] of [[k,1-b],[k+1,b]])if(w>0){
          const weight=w*slab[iz],key=view+':'+row,previous=weightMap.get(key);
          if(previous)previous.weight+=weight;
          else weightMap.set(key,{view,row,theta:beta,beta,z:c.feed*view/c.viewSamples+(row+c.vOffset)*c.rowWidth/scales[j]-zObject,weight,referenceWeight:0,geometricWeight:weights[j],filteredValue:(1-a)*fdkPatchAt(patch,i,row)+a*fdkPatchAt(patch,i+1,row)});
        }
      }
    }
    if((view-g.first)%12===0&&performance.now()-lastYield>=32){hooks.progress?.((view-g.first)/(g.last-g.first));await new Promise(resolve=>setTimeout(resolve,0));lastYield=performance.now();}
  }
  if(!counts.every(v=>v===c.viewSamples))throw Error('Internal full-turn view-count mismatch');
  const roi=[];
  for(let iy=0;iy<n;iy++)for(let ix=0;ix<n;ix++)if((g.x[ix]-c.radius)**2+g.y[iy]**2<=(c.sphereDiameter/2)**2+1e-12)roi.push(iy*n+ix);
  const paddedRaw=Float64Array.from(g.z,(_,iz)=>roi.reduce((s,j)=>s+volume[iz*nxy+j],0)/roi.length);
  const raw=fdkSlabMean(paddedRaw,c.zStep,c.axialAverageMm,g.padding),outputZ=g.z.slice(g.padding,g.z.length-g.padding);
  const averagedVolume=c.axialAverageMm&&!hooks.profileOnly?new Float64Array(nxy*outputZ.length):volume;
  if(c.axialAverageMm&&!hooks.profileOnly)for(let j=0;j<nxy;j++){
    const col=fdkSlabMean(Float64Array.from(g.z,(_,iz)=>volume[iz*nxy+j]),c.zStep,c.axialAverageMm,g.padding);
    for(let iz=0;iz<col.length;iz++)averagedVolume[iz*nxy+j]=col[iz];
  }
  const min=Math.min(...raw),max=Math.max(...raw),baseline=c.normalization==='minmax'?min:0;
  if(!(max>baseline))throw Error('No positive reconstructed object signal');
  const profile=Float64Array.from(raw,v=>(v-baseline)/(max-baseline)),z=Float64Array.from(outputZ,v=>v-zObject);
  const fwhm=fdkWidth(z,profile,.5),fwtm=fdkWidth(z,profile,.1);
  if(!fwhm||!fwtm)throw Error('FDK_DOMAIN: increase z extent to enclose both width thresholds');
  const weightAudit=hooks.profileOnly?null:{definition:'Virtual flat filtered row interpolation at the transverse object centre, integrated over the image-domain axial averaging window; channel interpolation included in filteredValue, FDK geometricWeight and db/2 applied separately; not raw detector rows or whole-SSP contributions.',coordinate:'source angle beta; virtual flat row index',db:g.db/2,axialAverageMm:c.axialAverageMm,centerValue:averagedVolume[((outputZ.length-1)/2*n+(n-1)/2)*n+(n-1)/2],samples:[...weightMap.values()]};
  return {config:c,x:g.x,y:g.y,z,volume:hooks.profileOnly?null:averagedVolume,raw,profile,counts:counts.slice(g.padding,counts.length-g.padding),zObject,fwhm,fwtm,min,max,baseline,roiPixels:roi.length,weightAudit,
    acquisition:{firstView:g.first,lastViewExclusive:g.last,viewsPerSlice:c.viewSamples,paddedReconstructionSlices:g.z.length},
    model:{version:FDK_VERSION,algorithm:'full-turn helical FDK approximation',detector:'source-centered cylindrical; bilinear rebin to virtual flat detector',
      object:c.objectModel==='point'?'unit-integral Dirac point; exact detector-aperture integral':'unit-attenuation finite sphere; no deconvolution',
      profileReadout:c.objectModel==='point'?'fixed transverse point through object location; axial section of 3D PSF':'mean in disk ROI of sphere radius',filter:'unwindowed discrete Ram-Lak; full nonzero input support',
      interpolation:'bilinear rebin and backprojection; native linear width crossings',normalization:c.normalization,
      extraAxialAveraging:c.axialAverageMm>0,axialAverageMm:c.axialAverageMm,thicknessMapping:c.thicknessMapping??'explicit-average-width',axialAverageDefinition:'image-domain normalized rectangular mean; piecewise-linear z integration before profile normalization; reconstructed padding',fullTurnCoverage:true,scientificScope:'reference implementation; not a validated scanner-specific reconstruction or exact wide-cone inversion'}};
}
export async function reconstructFdkSeries(input,hooks={}) {
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
