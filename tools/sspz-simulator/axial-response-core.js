// Shared acquisition -> local axial interpolation -> angular mean -> T average.
// No ramp, cone-FBP preweight, inverse-distance backprojection or image volume.
// The two selection rules are explicit reduced models, not commercial 2D/3D FBP.
import {fdkConfig,fdkWidth,fdkSlabMean,fdkSlabCoefficients} from './fdk-core.js';
import {cbaCoordinates,cbaRebinAt} from './cba-core.js';
import {detectorPointProjection,detectorRowReadout,finiteFocusConfig,focalBlurMetadata} from './detector-aperture.js';
import {zffsConfig} from './zffs-geometry.js';
import {computeZffsResponse} from './zffs-response.js';
import {computeSourceSupportedAxialResponse} from './axial-source-response.js';
export const AXIAL_RESPONSE_VERSION='2026-09-18.8';
const AR_TAU=2*Math.PI;
export function axialResponseConfig(input={}){
  const rule=input.axialRule??(input.computationModel==='fdk'?'rri':'merged');
  if(!['merged','rri','parallel'].includes(rule))throw Error('AXIAL_RULE');
  const extent=Number(input.zExtent??3);
  if(!Number.isFinite(extent)||extent<1||extent>80)throw Error('AXIAL_DOMAIN: z extent must be 1 to 80 mm');
  const c=fdkConfig({...input,response:'axial-interpolation',zExtent:Math.min(20,extent),objectModel:'point',xyExtent:.5,xySamples:5});
  c.zExtent=extent;c.zSamples=2*Math.ceil(extent/Number(input.zStep??.05))+1;c.zStep=2*extent/(c.zSamples-1);
  if(c.beamPitch<=0)throw Error('AXIAL_GEOMETRY_ONLY: stationary table');
  if(c.viewSamples%2)throw Error('AXIAL_VIEWS: an even view count is required');
  c.axialRule=rule;c.edgePolicy=input.edgePolicy??'available';
  if(!['available','strict'].includes(c.edgePolicy))throw Error('AXIAL_EDGE_POLICY');
  c.candidateSearch=input.candidateSearch??'source-fan-window';
  c.fullFanAngleDeg=Number(input.fullFanAngleDeg??50);
  if(!Number.isFinite(c.fullFanAngleDeg)||c.fullFanAngleDeg<=0||c.fullFanAngleDeg>=180)throw Error('AXIAL_FAN: full fan opening must be > 0 and < 180 degrees');
  if(rule!=='parallel'&&c.candidateSearch==='source-fan-window'&&2*Math.asin(c.radius/c.sourceRadius)*180/Math.PI>c.fullFanAngleDeg+1e-10)throw Error('AXIAL_FAN: evaluation point is outside the declared full fan opening');
  if(!['one-turn','source-fan-window'].includes(c.candidateSearch))throw Error('AXIAL_CANDIDATE_SEARCH');
  const ffsInput=Number(input.focalSizeMm??0)>0&&input.focalSourceDetectorMm!=null&&input.zFfsMagnification==null
    ?{...input,zFfsMagnification:Number(input.focalSourceDetectorMm)/c.sourceRadius}:input;
  return finiteFocusConfig(input,zffsConfig(ffsInput,c));
}
// RRI: normalized compact row tents. Merged: bracketing samples from the
// union of the two directions. Ties split weight, independent of signal value.
export function axialPairWeights(c,a,b,z){
  const samples=[];
  for(const [q,direction] of [[a,0],[b,1]]){
    const f=(z-q.sourceZ)/q.spacing+(c.rows-1)/2,n=Math.floor(f),delta=f-n;
    if(c.edgePolicy==='strict'&&(n<0||n+1>=c.rows))throw Error('AXIAL_COVERAGE: full row brackets required');
    const rows=c.axialRule==='rri'?[n,n+1]:[Math.max(0,Math.min(c.rows-1,n)),Math.max(0,Math.min(c.rows-1,n+1))];
    for(const row of new Set(rows))if(row>=0&&row<c.rows){
      samples.push({direction,row,z:q.sourceZ+(row-(c.rows-1)/2)*q.spacing,
        weight:c.axialRule==='rri'?Math.max(0,1-Math.abs(f-row)):0});
    }
  }
  if(c.axialRule!=='rri'){
    const coincident=samples.filter(q=>Math.abs(q.z-z)<1e-10);
    if(coincident.length){for(const q of coincident)q.weight=1/coincident.length;}
    else{
      const lo=Math.max(...samples.filter(q=>q.z<z).map(q=>q.z));
      const hi=Math.min(...samples.filter(q=>q.z>z).map(q=>q.z));
      if(!Number.isFinite(lo)||!Number.isFinite(hi))throw Error('AXIAL_COVERAGE: no acquired bracketing pair');
      const lower=samples.filter(q=>Math.abs(q.z-lo)<1e-10),upper=samples.filter(q=>Math.abs(q.z-hi)<1e-10);
      for(const q of lower)q.weight=(hi-z)/(hi-lo)/lower.length;
      for(const q of upper)q.weight=(z-lo)/(hi-lo)/upper.length;
    }
  }
  const sum=samples.reduce((s,q)=>s+q.weight,0);
  if(!(sum>1e-14))throw Error('AXIAL_COVERAGE: no acquired row support');
  return samples.filter(q=>q.weight>0).map(q=>({...q,weight:q.weight/sum}));
}
export async function computeAxialResponse(input={},hooks={}){
  const configured=axialResponseConfig(input);
  if(configured.candidateSearch==='source-fan-window')return computeSourceSupportedAxialResponse(configured,hooks);
  if(input.zFfsEnabled===true||input.zFfsEnabled===1||input.zFfsEnabled==='1')return computeZffsResponse(axialResponseConfig(input),hooks);
  const c=axialResponseConfig(input),nv=c.viewSamples,half=nv/2,db=AR_TAU/nv;
  const zObject=c.state*c.feed,padding=Math.ceil(c.axialAverageMm/(2*c.zStep));
  const zs=Float64Array.from({length:c.zSamples+2*padding},(_,i)=>zObject-c.zExtent+(i-padding)*c.zStep);
  const starts=Int32Array.from(zs,z=>Math.ceil((AR_TAU*z/c.feed-Math.PI)/db-1e-12));
  const first=Math.min(...starts),last=Math.max(...starts)+half;
  const rawCache=new Map(),rebinnedCache=new Map();let firstAcquired=Infinity,lastAcquired=-Infinity;
  const rawAt=v=>{
    if(!rawCache.has(v)){
      rawCache.set(v,detectorPointProjection({...c,sourceZ:c.feed*v/nv},c.phase+v*db,zObject,c.axialRule==='parallel'));
      firstAcquired=Math.min(firstAcquired,v);lastAcquired=Math.max(lastAcquired,v);
    }
    return rawCache.get(v);
  };
  const at=v=>{
    if(rebinnedCache.has(v))return rebinnedCache.get(v);
    const theta=c.phase+v*db;
    const q=c.axialRule==='parallel'?{t:-c.radius*Math.sin(theta),beta:theta,sourceZ:c.feed*v/nv,L:c.sourceRadius}:cbaCoordinates(c,theta,c.radius,0,0);
    q.spacing=c.rowWidth*q.L/c.sourceRadius;q.values=new Float64Array(c.rows);
    if(c.axialRule==='parallel'){
      const p=rawAt(v);for(let k=p.k0;k<=p.k1;k++)q.values[k]=detectorRowReadout(c,p,k);
    }else{
      const va=(q.beta-c.phase)/db,j=Math.floor(va),p0=rawAt(j),p1=rawAt(j+1);
      const lo=Math.max(0,Math.min(p0.height?p0.k0:c.rows,p1.height?p1.k0:c.rows));
      const hi=Math.min(c.rows-1,Math.max(p0.height?p0.k1:-1,p1.height?p1.k1:-1));
      for(let k=lo;k<=hi;k++)q.values[k]=cbaRebinAt(c,rawAt,theta,q.t,k);
    }
    rebinnedCache.set(v,q);return q;
  };
  const padded=new Float64Array(zs.length),counts=new Uint16Array(zs.length);
  const slab=fdkSlabCoefficients(zs.length,c.zStep,c.axialAverageMm),weights=new Map(),pairedWeights=new Map(),sampleAudit=[];
  const centre=(zs.length-1)/2;let lastYield=performance.now();
  for(let v=first;v<last;v++){
    if(hooks.cancelled?.())throw Error('FDK_CANCELLED');
    const a=at(v),b=at(v+half),pair=[a,b];
    for(let iz=0;iz<zs.length;iz++)if(v>=starts[iz]&&v<starts[iz]+half){
      const ws=axialPairWeights(c,a,b,zs[iz]);counts[iz]+=2;
      for(const s of ws){
        const q=pair[s.direction],value=q.values[s.row];
        padded[iz]+=s.weight*value/half;
        if(!hooks.profileOnly&&slab[iz]>0){
          const view=v+s.direction*half,key=view+':'+s.row;
          if(!weights.has(key))weights.set(key,{view,row:s.row,theta:c.phase+view*db,beta:q.beta,z:s.z-zObject,weight:0,referenceWeight:0,acquiredValue:value});
          weights.get(key).weight+=slab[iz]*s.weight;
          // Display audit only: retain the reference pair and direction before
          // the existing acquired-row accumulation combines their roles.
          const pairKey=v+':'+s.direction+':'+s.row;
          if(!pairedWeights.has(pairKey))pairedWeights.set(pairKey,{referenceView:v,direction:s.direction,view,row:s.row,theta:c.phase+view*db,beta:q.beta,z:s.z-zObject,weight:0,acquiredValue:value});
          pairedWeights.get(pairKey).weight+=slab[iz]*s.weight;
        }
      }
      if(!hooks.profileOnly&&iz===centre)sampleAudit.push({theta:c.phase+v*db,relativeAngleDeg:(v-starts[iz])*360/nv,beta:a.beta,betaConjugate:b.beta,z:ws.map(s=>s.z-zObject),weights:ws.map(s=>s.weight)});
    }
    if(performance.now()-lastYield>24){hooks.progress?.((v-first)/(last-first));await new Promise(resolve=>setTimeout(resolve,0));lastYield=performance.now();}
  }
  if(!counts.every(n=>n===nv))throw Error('AXIAL_INTERNAL: angular count mismatch');
  const raw=fdkSlabMean(padded,c.zStep,c.axialAverageMm,padding),z=Float64Array.from(zs.slice(padding,zs.length-padding),v=>v-zObject);
  const min=Math.min(...raw),max=Math.max(...raw),baseline=c.normalization==='minmax'?min:0;
  if(!(max>baseline))return {config:c,z,zObject,raw,geometryOnly:true,reason:'no-acquired-point-response',profiles:[],volume:null,
    coordinateSystem:'rebinned-theta',model:{version:AXIAL_RESPONSE_VERSION,kind:'axial-'+c.axialRule,focalBlur:focalBlurMetadata(c)},
    weightAudit:{db:1/half,centerValue:0,axialAverageMm:c.axialAverageMm,samples:[...weights.values()],pairedSamples:[...pairedWeights.values()]}};
  const profile=Float64Array.from(raw,v=>(v-baseline)/(max-baseline));
  const fwhm=fdkWidth(z,profile,.5),fwtm=fdkWidth(z,profile,.1);
  if(!fwhm||!fwtm||Math.max(profile[0],profile.at(-1))>.001)throw Error('AXIAL_DOMAIN: extend z range to contain response tails');
  const weightAudit=hooks.profileOnly?null:{definition:'Unfiltered rebinned row weights at the target transverse point, integrated over T; angular mean applied separately.',db:1/half,axialAverageMm:c.axialAverageMm,centerValue:raw[(raw.length-1)/2],samples:[...weights.values()],pairedSamples:[...pairedWeights.values()]};
  return {config:c,z,zObject,raw,profile,fwhm,fwtm,min,max,baseline,counts:counts.slice(padding,counts.length-padding),sampleAudit,weightAudit,
    volume:null,x:Float64Array.of(c.radius),y:Float64Array.of(0),coordinateSystem:'rebinned-theta',
    acquisition:{firstView:firstAcquired,lastViewExclusive:lastAcquired+1,viewsPerSlice:nv,rebinnedPairsPerSlice:half},
    model:{version:AXIAL_RESPONSE_VERSION,kind:'axial-'+c.axialRule,focalBlur:focalBlurMetadata(c),algorithm:'reduced axial interpolation response',
      geometry:c.axialRule==='parallel'?'nondivergent parallel reference':'three-dimensional cylindrical cone-ray geometry',
      interpolation:c.axialRule==='rri'?'linear row interpolation within each direction; normalize acquired rows over pair':'nearest bracketing pair from union of both acquired row sets; split coincident samples',
      object:'unit-integral ideal point; finite detector cell integrals',filter:'none; no transaxial ramp or FBP preweight',
      angularWeight:'one slice-centred turn; common paired angular mean',extraAxialAveraging:!!c.axialAverageMm,axialAverageMm:c.axialAverageMm,
      profileReadout:'fixed transverse point; moving axial evaluation; no reconstructed image',scientificScope:'geometry and interpolation reference; not a 2D/3D FBP image SSP or commercial reconstruction'}};
}
export async function computeAxialResponseSeries(input={},hooks={}){
  const c=axialResponseConfig(input),profiles=[];let selected;
  for(let i=0;i<c.phaseCount;i++){
    const phase=c.phase+AR_TAU*i/c.phaseCount;
    const r=await computeAxialResponse({...c,phase},{...hooks,profileOnly:i>0||hooks.profileOnly,progress:v=>hooks.progress?.((i+v)/c.phaseCount)});
    if(r.geometryOnly)return r;
    selected??=r;profiles.push({phase,profile:r.profile,raw:r.raw,fwhm:r.fwhm,fwtm:r.fwtm,baseline:r.baseline});
    hooks.progress?.((i+1)/c.phaseCount);await new Promise(resolve=>setTimeout(resolve,0));
  }
  const mean=Float64Array.from(selected.z,(_,j)=>profiles.reduce((s,p)=>s+p.profile[j],0)/profiles.length);
  return {...selected,profiles,mean,meanDifference:profiles.map(p=>Float64Array.from(p.profile,(v,j)=>v-mean[j]))};
}
