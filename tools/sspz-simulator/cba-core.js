// Hsieh et al., Opt Eng 46:067001 (2007), Eqs. 4-6.
// Rowwise fan-to-parallel rebinning; matched RRI and CBA from identical data.
// Coordinates, quadrature, supported acquisition and limits: CBA_METHOD.md.
import {fdkConfig,fdkArcProjection,fdkRamp,fdkWidth} from './fdk-core.js';
export const CBA_VERSION='2026-09-15.1';
const CBA_TAU=2*Math.PI;
export function cbaWeights(a,b,power=2){
  if(![a,b].every(v=>Number.isFinite(v)&&v>=0&&v<=1)||![1,2].includes(power))throw Error('CBA_WEIGHT_DOMAIN');
  const w=[(1-a)**power,a**power,(1-b)**power,b**power],sum=w.reduce((s,v)=>s+v,0);
  return w.map(v=>v/sum);
}
export function cbaCoordinates(c,theta,x,y,z){
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
  const z=Float64Array.from({length:c.zSamples},(_,i)=>zObject-c.zExtent+i*c.zStep);
  const starts=Int32Array.from(z,v=>Math.ceil(((c.feed?CBA_TAU*v/c.feed:0)-Math.PI)/db-1e-12));
  return {x,y,z,starts,db,first:Math.min(...starts),last:Math.max(...starts)+c.viewSamples};
}
function cbaRawAt(p,j,k){
  return j<p.j0||j>p.j1||k<p.k0||k>p.k1?0:p.data[(k-p.k0)*p.width+j-p.j0];
}
export function cbaRebinAt(c,rawAt,theta,t,k){
  const gamma=Math.asin(t/c.sourceRadius),v=(theta+gamma-c.phase)*c.viewSamples/CBA_TAU;
  const j=gamma*c.sourceRadius/c.channelWidth+(c.channels-1)/2,i0=Math.floor(v),j0=Math.floor(j),a=v-i0,b=j-j0;
  if(j0<0||j0+1>=c.channels||k<0||k>=c.rows)throw Error('CBA_COVERAGE: rebinning outside acquired detector');
  const p0=rawAt(i0),p1=rawAt(i0+1);
  return (1-a)*((1-b)*cbaRawAt(p0,j0,k)+b*cbaRawAt(p0,j0+1,k))+a*((1-b)*cbaRawAt(p1,j0,k)+b*cbaRawAt(p1,j0+1,k));
}
// Exact sparse support: intersect the support of each acquired view with
// both interpolation tents. No clipping of the ramp or sphere projection.
export function cbaFilteredPatch(c,rawAt,theta,i0,i1){
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
export function cbaCheckPair(c,a,b){
  for(const q of [a,b])if(q.n<0||q.n+1>=c.rows)throw Error('CBA_COVERAGE: both conjugate row brackets are required; reduce pitch or reconstruction extent');
}
function cbaResult(c,g,volume,counts,zObject,kind,acquisition){
  const n=c.xySamples,nxy=n*n,roi=[];
  for(let iy=0;iy<n;iy++)for(let ix=0;ix<n;ix++)if((g.x[ix]-c.radius)**2+g.y[iy]**2<=(c.sphereDiameter/2)**2+1e-12)roi.push(iy*n+ix);
  const raw=Float64Array.from(g.z,(_,iz)=>roi.reduce((s,j)=>s+volume[iz*nxy+j],0)/roi.length);
  const min=Math.min(...raw),max=Math.max(...raw),baseline=c.normalization==='minmax'?min:0;
  if(!(max>baseline))throw Error('CBA_DOMAIN: no positive reconstructed sphere');
  const profile=Float64Array.from(raw,v=>(v-baseline)/(max-baseline)),z=Float64Array.from(g.z,v=>v-zObject);
  const fwhm=fdkWidth(z,profile,.5),fwtm=fdkWidth(z,profile,.1);
  if(!fwhm||!fwtm)throw Error('CBA_DOMAIN: increase z extent to contain width crossings');
  return {config:c,x:g.x,y:g.y,z,volume,raw,profile,counts,zObject,fwhm,fwtm,min,max,baseline,roiPixels:roi.length,acquisition,
    model:{version:CBA_VERSION,algorithm:kind==='cba'?'Hsieh conjugate backprojection (CBA)':'Matched row-to-row interpolation (RRI)',
      reference:'Hsieh et al. 2007; DOI 10.1117/1.2746866; Eqs. 4-6',detector:'same cylindrical sphere projections for RRI and CBA',
      rebinning:'rowwise fan-to-parallel; linear acquired view and channel interpolation; row unchanged',
      filter:'unwindowed discrete parallel Ram-Lak; cone cosine per row; full nonzero input support',
      interpolation:kind==='cba'?'four conjugate row samples; normalized distance-quadratic weights, Eq. 6':'linear row interpolation per view, then equal conjugate average',
      angularWeight:'one paired full turn per slice; no overscan or adaptive cone weighting',object:'finite sphere; no deconvolution',normalization:c.normalization,
      extraAxialAveraging:false,fullTurnCoverage:true,scientificScope:'paper-based approximate reference; not TCOT or a validated 80/160/320-row scanner'}};
}
export async function reconstructCba(input={},hooks={}){
  const c=fdkConfig(input);if(c.viewSamples%2)throw Error('CBA_VIEWS: an even number of views per turn is required');
  const zObject=c.state*c.feed,g=cbaGrid(c,zObject),n=c.xySamples,nxy=n*n,half=c.viewSamples/2;
  const volume=new Float64Array(nxy*c.zSamples),rriVolume=new Float64Array(volume.length),counts=new Uint16Array(c.zSamples);
  const raws=new Map(),patches=new Map();let rawFirst=Infinity,rawLast=-Infinity;
  const rawAt=v=>{
    if(raws.has(v))return raws.get(v);
    const beta=c.phase+v*g.db,R=c.sourceRadius,a=c.sphereDiameter/2,L=Math.hypot(R*Math.cos(beta)-c.radius,R*Math.sin(beta));
    const wc=R*(zObject-c.feed*v/c.viewSamples)/L,wa=(R+Math.abs(wc))*a/(L-a);
    if(Math.abs(wc)+wa>=c.rows*c.rowWidth/2)throw Error('CBA_COVERAGE: acquired sphere projection is truncated');
    const p=fdkArcProjection(c,beta,zObject);raws.set(v,p);rawFirst=Math.min(rawFirst,v);rawLast=Math.max(rawLast,v);return p;
  };
  const patchAt=v=>{
    if(patches.has(v))return patches.get(v);
    const theta=c.phase+v*g.db,ts=[];
    for(const x of [g.x[0],g.x.at(-1)])for(const y of [g.y[0],g.y.at(-1)])ts.push(-x*Math.sin(theta)+y*Math.cos(theta));
    const p=cbaFilteredPatch(c,rawAt,theta,Math.floor(Math.min(...ts)/c.channelWidth-c.uOffset)-1,Math.ceil(Math.max(...ts)/c.channelWidth-c.uOffset)+1);
    patches.set(v,p);return p;
  };
  const sampleAudit=[];
  for(let v=g.first;v<g.last-half;v++){
    if(hooks.cancelled?.())throw Error('FDK_CANCELLED');
    const theta=c.phase+v*g.db,theta2=theta+Math.PI,p=patchAt(v),p2=patchAt(v+half);
    for(let iz=0;iz<g.z.length;iz++)if(v>=g.starts[iz]&&v<g.starts[iz]+half){
      counts[iz]+=2;
      for(let iy=0;iy<n;iy++)for(let ix=0;ix<n;ix++){
        const a=cbaCoordinates(c,theta,g.x[ix],g.y[iy],g.z[iz]),b=cbaCoordinates(c,theta2,g.x[ix],g.y[iy],g.z[iz]);
        cbaCheckPair(c,a,b);
        const samples=[cbaSampleRow(c,p,a.t,a.n),cbaSampleRow(c,p,a.t,a.n+1),cbaSampleRow(c,p2,b.t,b.n),cbaSampleRow(c,p2,b.t,b.n+1)];
        const w=cbaWeights(a.delta,b.delta),wr=cbaWeights(a.delta,b.delta,1),j=iz*nxy+iy*n+ix;
        volume[j]+=g.db*samples.reduce((s,q,k)=>s+w[k]*q,0);
        rriVolume[j]+=g.db*samples.reduce((s,q,k)=>s+wr[k]*q,0);
        if(iz===(g.z.length-1)/2&&ix===(n-1)/2&&iy===(n-1)/2){
          const zs=[a.sourceZ+(a.n-(c.rows-1)/2)*c.rowWidth*a.L/c.sourceRadius,a.sourceZ+(a.n+1-(c.rows-1)/2)*c.rowWidth*a.L/c.sourceRadius,
            b.sourceZ+(b.n-(c.rows-1)/2)*c.rowWidth*b.L/c.sourceRadius,b.sourceZ+(b.n+1-(c.rows-1)/2)*c.rowWidth*b.L/c.sourceRadius].map(z=>z-zObject);
          sampleAudit.push({theta,thetaDeg:theta*180/Math.PI,relativeAngleDeg:(v-g.starts[iz])*360/c.viewSamples,beta:a.beta,betaConjugate:b.beta,
            t:a.t,directRow:a.n,conjugateRow:b.n,delta:a.delta,deltaConjugate:b.delta,z:zs,weights:w,rriWeights:wr,
            weightedDistance:zs.reduce((s,z,i)=>s+w[i]*Math.abs(z),0),rriWeightedDistance:zs.reduce((s,z,i)=>s+wr[i]*Math.abs(z),0)});
        }
      }
    }
    if((v-g.first)%6===0){hooks.progress?.((v-g.first)/(g.last-half-g.first));await new Promise(resolve=>setTimeout(resolve,0));}
  }
  if(!counts.every(v=>v===c.viewSamples))throw Error('CBA_INTERNAL: paired view count mismatch');
  const acquisition={firstView:rawFirst,lastViewExclusive:rawLast+1,viewsPerSlice:c.viewSamples,rebinnedPairsPerSlice:half,firstRebinnedView:g.first,lastRebinnedViewExclusive:g.last};
  const r=cbaResult(c,g,volume,counts,zObject,'cba',acquisition),reference=cbaResult(c,g,rriVolume,counts,zObject,'rri',acquisition);
  return {...r,reference,sampleAudit};
}
export async function reconstructCbaSeries(input,hooks={}){
  const c=fdkConfig(input),profiles=[],referenceProfiles=[];let selected;
  for(let i=0;i<c.phaseCount;i++){
    const phase=c.phase+CBA_TAU*i/c.phaseCount;
    const r=await reconstructCba({...c,phase},{...hooks,progress:v=>hooks.progress?.((i+v)/c.phaseCount)});
    if(!selected)selected=r;
    for(const [target,q] of [[profiles,r],[referenceProfiles,r.reference]])target.push({phase,profile:q.profile,raw:q.raw,fwhm:q.fwhm,fwtm:q.fwtm,baseline:q.baseline});
  }
  const series=(r,ps)=>{const mean=Float64Array.from(r.z,(_,i)=>ps.reduce((s,p)=>s+p.profile[i],0)/ps.length);return {...r,profiles:ps,mean,meanDifference:ps.map(p=>Float64Array.from(p.profile,(v,i)=>v-mean[i]))};};
  return {...series(selected,profiles),reference:series(selected.reference,referenceProfiles)};
}
