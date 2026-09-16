// Hsieh et al., Opt Eng 46:067001 (2007), Eqs. 4-6.
// Rowwise fan-to-parallel rebinning; matched RRI and CBA from identical data.
// Coordinates, quadrature, supported acquisition and limits: CBA_METHOD.md.
import {fdkConfig,fdkArcProjection,fdkRamp,fdkWidth,fdkSlabMean,fdkSlabCoefficients} from './fdk-core.js';
export const CBA_VERSION='2026-09-17.4';
const CBA_TAU=2*Math.PI;
export function cbaWeights(a,b,power=2){
  if(![a,b].every(v=>Number.isFinite(v)&&v>=0&&v<=1)||![1,2].includes(power))throw Error('CBA_WEIGHT_DOMAIN');
  const w=[(1-a)**power,a**power,(1-b)**power,b**power],sum=w.reduce((s,v)=>s+v,0);
  return w.map(v=>v/sum);
}
// Compact distance weights over acquired row centres only. The four-sample
// interior is Hsieh Eq. (6); omitting unavailable cells and renormalizing is
// our explicit boundary extension inspired by their conjugate compensation.
export function cbaAvailableWeights(c,a,b,power=2){
  const w=[(1-a.delta)**power,a.delta**power,(1-b.delta)**power,b.delta**power];
  const rows=[a.n,a.n+1,b.n,b.n+1];
  for(let i=0;i<4;i++)if(rows[i]<0||rows[i]>=c.rows)w[i]=0;
  const sum=w.reduce((s,v)=>s+v,0);
  if(!(sum>1e-14))throw Error('CBA_COVERAGE: no acquired row support in the conjugate pair');
  return w.map(v=>v/sum);
}
// Compatibility exports use the shared image-domain rectangular integral.
export function cbaSlabMean(values,dz,width,padding){return fdkSlabMean(values,dz,width,padding);}
export function cbaSlabCoefficients(length,dz,width){return fdkSlabCoefficients(length,dz,width);}
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
  const padding=Math.ceil((c.axialAverageMm??0)/(2*c.zStep));
  const z=Float64Array.from({length:c.zSamples+2*padding},(_,i)=>zObject-c.zExtent+(i-padding)*c.zStep);
  const starts=Int32Array.from(z,v=>Math.ceil(((c.feed?CBA_TAU*v/c.feed:0)-Math.PI)/db-1e-12));
  return {x,y,z,starts,db,padding,first:Math.min(...starts),last:Math.max(...starts)+c.viewSamples};
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
  if(!(max>baseline))throw Error('CBA_DOMAIN: no positive reconstructed object');
  const profile=Float64Array.from(raw,v=>(v-baseline)/(max-baseline)),z=Float64Array.from(outputZ,v=>v-zObject);
  const fwhm=fdkWidth(z,profile,.5),fwtm=fdkWidth(z,profile,.1);
  if(!fwhm||!fwtm)throw Error('CBA_DOMAIN: increase z extent to contain width crossings');
  return {config:c,x:g.x,y:g.y,z,volume:profileOnly?null:averagedVolume,raw,profile,counts:counts.slice(g.padding,counts.length-g.padding),zObject,fwhm,fwtm,min,max,baseline,roiPixels:roi.length,acquisition,
    model:{version:CBA_VERSION,algorithm:kind==='cba'?'Hsieh conjugate backprojection (CBA)':'Matched row-to-row interpolation (RRI)',
      reference:'Hsieh et al. 2007; DOI 10.1117/1.2746866; Eqs. 4-6',detector:'same cylindrical projections for RRI and CBA',
      rebinning:'rowwise fan-to-parallel; linear acquired view and channel interpolation; row unchanged',
      filter:'unwindowed discrete parallel Ram-Lak; cone cosine per row; full nonzero input support',
      interpolation:kind==='cba'?'normalized distance-quadratic acquired-row weights; Eq. 6 in the four-sample interior':'normalized distance-linear acquired-row weights; conventional RRI in the four-sample interior',
      angularWeight:'one paired full turn per slice; no overscan or adaptive cone weighting',object:c.objectModel==='point'?'unit-integral Dirac point; exact detector-aperture integral':'finite sphere; no deconvolution',
      profileReadout:c.objectModel==='point'?'fixed transverse point through object location; axial section of 3D PSF':'mean in disk ROI of sphere radius',normalization:c.normalization,
      edgePolicy:c.edgePolicy,edgeExtension:'unavailable acquired row coefficients are zero; normalize available distance weights; not the full published scanner algorithm',
      extraAxialAveraging:c.axialAverageMm>0,axialAverageMm:c.axialAverageMm,thicknessMapping:c.thicknessMapping??'explicit-average-width',axialAverageDefinition:'image-domain normalized rectangular mean; piecewise-linear z integration before profile normalization; reconstructed padding',
      fullTurnCoverage:c.edgePolicy==='strict',pairedAngularCoverage:true,profileOnly,scientificScope:'paper-based approximate reference; not TCOT or a validated commercial scanner'}};
}
export async function reconstructCba(input={},hooks={}){
  const c=fdkConfig(input);c.edgePolicy=input.edgePolicy??'available';
  if(!['strict','available'].includes(c.edgePolicy))throw Error('CBA_EDGE_POLICY');
  if(c.viewSamples%2)throw Error('CBA_VIEWS: an even number of views per turn is required');
  const zObject=c.state*c.feed,g=cbaGrid(c,zObject),n=c.xySamples,nxy=n*n,half=c.viewSamples/2;
  const volume=new Float64Array(nxy*g.z.length),rriVolume=new Float64Array(volume.length),counts=new Uint16Array(g.z.length);
  const pixels=[];for(let iy=0;iy<n;iy++)for(let ix=0;ix<n;ix++)if(!hooks.profileOnly||(g.x[ix]-c.radius)**2+g.y[iy]**2<=(c.sphereDiameter/2)**2+1e-12)pixels.push({ix,iy,x:g.x[ix],y:g.y[iy],j:iy*n+ix});
  const raws=new Map(),patches=new Map();let rawFirst=Infinity,rawLast=-Infinity;
  const rawAt=v=>{
    if(raws.has(v))return raws.get(v);
    const beta=c.phase+v*g.db,R=c.sourceRadius,a=c.sphereDiameter/2,L=Math.hypot(R*Math.cos(beta)-c.radius,R*Math.sin(beta));
    const wc=R*(zObject-c.feed*v/c.viewSamples)/L,wa=(R+Math.abs(wc))*a/(L-a);
    if(c.edgePolicy==='strict'&&Math.abs(wc)+wa>=c.rows*c.rowWidth/2)throw Error('CBA_COVERAGE: acquired object projection is truncated');
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
    definition:'Rebinned filtered row coefficients at the transverse object centre, integrated over the image-domain axial averaging window; not whole-SSP or raw-projection contributions.',
    coordinate:'parallel rebinned angle theta; unwrapped view identity retained',axialAverageMm:c.axialAverageMm,db:g.db,
    centerValue:r.volume[center],referenceCenterValue:reference.volume[center],samples:[...weightMap.values()]};
  return {...r,reference,sampleAudit,weightAudit};
}
export async function reconstructCbaSeries(input,hooks={}){
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
