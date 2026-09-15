// Full-turn FDK on a helix, with acquired cylindrical detector data rebinned
// to a virtual flat detector. Sources and assumptions: FDK_METHOD.md.
// No scanner-specific algorithm, fitted width, z boxcar, or 180LI is used here.
export const FDK_VERSION = '2026-09-14.1';
export const FDK_DEFAULTS = Object.freeze({
  rows:80,rowWidth:.5,beamPitch:.5,sourceRadius:600,radius:100,
  viewSamples:360,phase:0,state:0,sphereDiameter:.65,channelWidth:.25,
  apertureSamples:8,xyExtent:1.5,xySamples:17,zExtent:3,zStep:.05,
  phaseCount:1,normalization:'minmax',
});
const FDK_TAU=2*Math.PI;
export function fdkConfig(input={}) {
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
// Store only the analytically bounded nonzero sphere projection. Missing
// entries are exact air measurements, not a cropped object or missing rays.
export function fdkArcProjection(c,beta,zObject) {
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
function fdkVolumeGeometry(c,zObject) {
  const n=c.xySamples,half=c.xyExtent;
  const x=Float64Array.from({length:n},(_,i)=>c.radius-half+2*half*i/(n-1));
  const y=Float64Array.from({length:n},(_,i)=>-half+2*half*i/(n-1));
  const z=Float64Array.from({length:c.zSamples},(_,i)=>zObject-c.zExtent+i*c.zStep);
  const db=FDK_TAU/c.viewSamples,starts=Int32Array.from(z,v=>Math.ceil(((c.feed?FDK_TAU*v/c.feed:0)-Math.PI)/db-1e-12));
  return {x,y,z,starts,first:Math.min(...starts),last:Math.max(...starts)+c.viewSamples,db};
}
export function fdkCheckCoverage(c,g,zObject) {
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
export async function reconstructFdk(input={},hooks={}) {
  const c=fdkConfig(input),zObject=c.state*c.feed,g=fdkVolumeGeometry(c,zObject);
  fdkCheckCoverage(c,g,zObject);
  const n=c.xySamples,nxy=n*n,volume=new Float64Array(nxy*c.zSamples),counts=new Uint16Array(c.zSamples);
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
      for(let j=0;j<nxy;j++)volume[iz*nxy+j]+=fdkSamplePatch(c,patch,us[j],dz*scales[j])*weights[j]*g.db/2;
    }
    if((view-g.first)%12===0){hooks.progress?.((view-g.first)/(g.last-g.first));await new Promise(resolve=>setTimeout(resolve,0));}
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
  return {config:c,x:g.x,y:g.y,z,volume,raw,profile,counts,zObject,fwhm,fwtm,min,max,baseline,roiPixels:roi.length,
    acquisition:{firstView:g.first,lastViewExclusive:g.last,viewsPerSlice:c.viewSamples},
    model:{version:FDK_VERSION,algorithm:'full-turn helical FDK approximation',detector:'source-centered cylindrical; bilinear rebin to virtual flat detector',
      object:'unit-attenuation finite sphere; no deconvolution',filter:'unwindowed discrete Ram-Lak; full nonzero input support',
      interpolation:'bilinear rebin and backprojection; native linear width crossings',normalization:c.normalization,
      extraAxialAveraging:false,fullTurnCoverage:true,scientificScope:'reference implementation; not a validated scanner-specific reconstruction or exact wide-cone inversion'}};
}
export async function reconstructFdkSeries(input,hooks={}) {
  const c=fdkConfig(input),profiles=[];let selected;
  for(let i=0;i<c.phaseCount;i++){
    const phase=c.phase+FDK_TAU*i/c.phaseCount;
    const r=await reconstructFdk({...c,phase},{...hooks,progress:v=>hooks.progress?.((i+v)/c.phaseCount)});
    if(!selected)selected=r;
    profiles.push({phase,profile:r.profile,raw:r.raw,fwhm:r.fwhm,fwtm:r.fwtm,baseline:r.baseline});
  }
  const mean=Float64Array.from(selected.z,(_,i)=>profiles.reduce((s,p)=>s+p.profile[i],0)/profiles.length);
  return {...selected,profiles,mean,meanDifference:profiles.map(p=>Float64Array.from(p.profile,(v,i)=>v-mean[i]))};
}
