import {computeAxialResponseSeries,AXIAL_RESPONSE_VERSION} from './axial-response-core.js';
import {candidateDensityWindows,candidateDensityCountsAt,CANDIDATE_DENSITY_VERSION} from './candidate-density-core.js';
import {validateCandidateRequest,candidateProfileInput,CANDIDATE_START_ANGLES,CANDIDATE_DIRECTIONS} from './candidate-counts-config.js';

const TAU=2*Math.PI;
function cancellationCheck(cancelled){if(cancelled())throw Error('CANDIDATE_COUNTS_CANCELLED');}
function accumulator(){return {n:0,sum:0,sum2:0,min:Infinity,max:0,hist:new Map()};}
function add(a,count){
  if(!Number.isInteger(count)||count<0)throw Error('CANDIDATE_COUNTS: invalid count');
  a.n++;a.sum+=count;a.sum2+=count*count;a.min=Math.min(a.min,count);a.max=Math.max(a.max,count);
  a.hist.set(count,(a.hist.get(count)??0)+1);
}
function distribution(a){
  const mean=a.sum/a.n;
  return {n:a.n,min:a.min,max:a.max,mean,sd:Math.sqrt(Math.max(0,a.sum2/a.n-mean*mean)),
    frequencies:[...a.hist].sort((a,b)=>a[0]-b[0]).map(([count,frequency])=>({count,frequency,fraction:frequency/a.n}))};
}

// The shared single-state count kernel is unchanged. The caller's base phase is
// retained here; the older bulk API intentionally starts its count sweep at0.
export async function countCandidatesAtBasePhase(config,windows,{basePhase=config.phase??0,
  startSamples=CANDIDATE_START_ANGLES,angleSamples=CANDIDATE_DIRECTIONS,
  cancelled=()=>false,onProgress=()=>{},countsAt=candidateDensityCountsAt}={}){
  if(!Number.isFinite(basePhase)||![startSamples,angleSamples].every(n=>Number.isInteger(n)&&n>0&&n<=360))throw Error('CANDIDATE_COUNTS: invalid phase grid');
  const c={...config},acc={};
  for(const pool of ['direct','combined'])acc[pool]={fwhm:accumulator(),fwtm:accumulator()};
  let yielded=performance.now();
  for(let start=0;start<startSamples;start++){
    cancellationCheck(cancelled);c.phase=basePhase+TAU*start/startSamples;
    for(let angle=0;angle<angleSamples;angle++){
      const counts=countsAt(c,angle*360/angleSamples,0,windows);
      for(const pool of ['direct','combined']){
        if(counts[pool].fwhm>counts[pool].fwtm)throw Error('CANDIDATE_COUNTS: nested windows required');
        for(const window of ['fwhm','fwtm'])add(acc[pool][window],counts[pool][window]);
      }
      if(counts.direct.fwhm>counts.combined.fwhm||counts.direct.fwtm>counts.combined.fwtm)throw Error('CANDIDATE_COUNTS: invalid candidate pools');
    }
    if(performance.now()-yielded>=20||start===startSamples-1){
      onProgress({completed:start+1,total:startSamples,fraction:(start+1)/startSamples});
      await new Promise(resolve=>setTimeout(resolve,0));yielded=performance.now();
    }
  }
  cancellationCheck(cancelled);
  return {windows,sampleCount:startSamples*angleSamples,
    groups:Object.fromEntries(['direct','combined'].map(pool=>[pool,
      Object.fromEntries(['fwhm','fwtm'].map(window=>[window,distribution(acc[pool][window])]))]))};
}

export function createCandidateCountsRunner({computeSeries=computeAxialResponseSeries,computeCounts=countCandidatesAtBasePhase}={}){
  return async function recalculateCandidateCounts(request,{onProgress=()=>{},onRadiusComplete=()=>{},cancelled=()=>false}={}){
    const {settings,radii}=validateCandidateRequest(request),results=[];
    let lastProgress=-Infinity,maximumFraction=0;
    for(const [radiusIndex,radiusMm] of radii.entries()){
      cancellationCheck(cancelled);
      let domainRestarts=0;
      const emit=(stage,completedStarts,localFraction,force=false,extra={})=>{
        const now=performance.now();if(!force&&now-lastProgress<100)return;lastProgress=now;
        const fraction=(radiusIndex+(stage==='profiles'?.95*localFraction:.95+.05*localFraction))/radii.length;
        maximumFraction=Math.max(maximumFraction,fraction);
        onProgress({type:'progress',stage,radiusMm,radiusIndex,radiusCount:radii.length,
          completedStarts,totalStarts:360,fraction:maximumFraction,domainRestarts,...extra});
      };
      emit('profiles',0,0,true);
      // This shared series routine restarts every phase on an expanded common
      // native grid if any phase fails the raw-tail check. No profile alignment,
      // interpolation between grids, or silent zero extension is performed.
      const series=await computeSeries(candidateProfileInput(settings,radiusMm,settings.phase),{
        profileOnly:true,cancelled,
        progress:value=>emit('profiles',Math.min(360,Math.floor(value*360)),value),
        domainExpanded:value=>{domainRestarts++;emit('profiles',0,0,true,{domainExtentMm:value.extentMm});},
      });
      cancellationCheck(cancelled);
      if(series.geometryOnly||series.profiles?.length!==360)throw Error('CANDIDATE_COUNTS: complete360-start response required');
      if(series.config.candidateSearch!=='source-fan-window'||series.model.sourceAngleSpanDeg!==360+2*settings.fullFanAngleDeg)throw Error('CANDIDATE_COUNTS: incorrect source support');
      for(const p of series.profiles)if(!p.profile||p.profile.length!==series.z.length)throw Error('CANDIDATE_COUNTS: inconsistent native grid');
      const windows=candidateDensityWindows(series);
      emit('profiles',360,1,true);
      emit('counts',0,0,true);
      const density=await computeCounts(series.config,windows,{basePhase:settings.phase,
        startSamples:360,angleSamples:360,cancelled,
        onProgress:value=>emit('counts',value.completed,value.fraction)});
      cancellationCheck(cancelled);
      if(density.sampleCount!==129600)throw Error('CANDIDATE_COUNTS: incomplete state set');
      const result={radiusMm,sampleCount:density.sampleCount,windows:density.windows,groups:density.groups};
      results.push(result);
      onRadiusComplete({type:'radius-complete',result,radiusIndex,radiusCount:radii.length});
      emit('counts',360,1,true);
    }
    cancellationCheck(cancelled);
    return {schemaVersion:1,settings:{...settings},condition:{
      rows:settings.rows,rowSpacingMm:settings.rowWidth,beamPitch:settings.beamPitch,Tmm:settings.sliceThicknessMm,
      nativeViewsPerRotation:settings.viewSamples,sourceRadiusMm:settings.sourceRadius,
      sourceDetectorDistanceMm:settings.focalSourceDetectorMm,axialFocusSizeMm:settings.focalSizeMm,
      channelSpacingMm:settings.channelWidth,channelApertureMm:settings.channelApertureMm,
      fullFanAngleDeg:settings.fullFanAngleDeg,sourceSupportDeg:360+2*settings.fullFanAngleDeg,
      axialRule:settings.axialRule,candidateSearch:'source-fan-window',normalization:settings.normalization,
      directions:360,startAngles:360,statesPerRadius:129600,basePhaseRad:settings.phase,
      zStepMm:settings.zStep,zFfsEnabled:settings.zFfsEnabled,zFfsMagnification:settings.zFfsMagnification,
      zFfsOffset:settings.zFfsOffset,edgePolicy:settings.edgePolicy,modelVersion:AXIAL_RESPONSE_VERSION,
    },radii:results,provenance:{mode:'recalculated',cached:false,complete:true,computedAt:new Date().toISOString(),
      modelVersion:AXIAL_RESPONSE_VERSION,candidateDensityVersion:CANDIDATE_DENSITY_VERSION,
      phaseGrid:'basePhaseRad +2pi*i/360 for both normalized response means and candidate counts; directions0..359degrees.',
      nativeGrid:'Shared series domain; all starts restarted together after any raw-tail domain expansion.',
      windowMethod:'Mean normalized responses at native z; renormalize the mean and keep bilateral50%/10% windows fixed.',
      scope:'Geometric candidates before interpolation selection and weighting; not independent measurements or dose.'}};
  };
}
export const recalculateCandidateCounts=createCandidateCountsRunner();

if(typeof self!=='undefined'&&typeof document==='undefined'&&typeof self.postMessage==='function'){
  let running=false,stopped=false;
  self.addEventListener('message',async event=>{
    const message=event.data;
    if(message?.type==='cancel'){stopped=true;self.close();return;}
    if(message?.type!=='start'||running){self.postMessage({type:'error',message:'CANDIDATE_COUNTS_REQUEST: invalid request'});stopped=true;self.close();return;}
    running=true;
    try{
      const data=await recalculateCandidateCounts(message,{cancelled:()=>stopped,
        onProgress:value=>self.postMessage(value),onRadiusComplete:value=>self.postMessage(value)});
      if(!stopped)self.postMessage({type:'complete',data});
    }catch(error){if(!stopped)self.postMessage({type:'error',message:error?.message??String(error)});}
    finally{stopped=true;self.close();}
  });
}
