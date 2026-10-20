// Dedicated manuscript preset. The main simulator and numerical kernels are unchanged.
import {computeAxialResponse,AXIAL_RESPONSE_VERSION} from './axial-response-core.js';
import {candidateDensityWindows,computeCandidateDensity,CANDIDATE_DENSITY_VERSION} from './candidate-density-core.js';

const STARTS=360,DIRECTIONS=360,TAU=2*Math.PI;
export const FIGURE3_RADII=Object.freeze([10,50,80,102]);
export const FIGURE3_CONDITION=Object.freeze({
  rows:4,rowSpacingMm:1,beamPitch:.875,Tmm:1,
  nativeViewsPerRotation:1200,sourceRadiusMm:600,sourceDetectorDistanceMm:1070,
  axialFocusSizeMm:1.2,channelSpacingMm:.58,channelApertureMm:.58,
  fullFanAngleDeg:50,sourceSupportDeg:460,axialRule:'rri',
  candidateSearch:'source-fan-window',normalization:'minmax',
  directions:DIRECTIONS,startAngles:STARTS,statesPerRadius:DIRECTIONS*STARTS,
  modelVersion:AXIAL_RESPONSE_VERSION,axialStepMm:.01,
});

export function figure3PresetInput(radiusMm,phase=0){
  if(!FIGURE3_RADII.includes(radiusMm))throw Error('FIGURE3_RADIUS: fixed manuscript positions required');
  if(!Number.isFinite(phase))throw Error('FIGURE3_PHASE');
  return {rows:4,rowWidth:1,beamPitch:.875,radius:radiusMm,
    sourceRadius:600,focalSourceDetectorMm:1070,viewSamples:1200,
    channelWidth:.58,channelApertureMm:.58,focalSizeMm:1.2,
    axialAverageMm:1,zExtent:3.5,zStep:.01,phase,state:0,
    edgePolicy:'available',normalization:'minmax',fullFanAngleDeg:50,
    comparisonMode:'matched-rri',axialRule:'rri',
    candidateSearch:'source-fan-window',zFfsEnabled:false};
}

// Average the normalized responses on their original physical z grid.
// Deliberately do not register peaks or move either width crossing.
export function meanNormalizedProfiles(profiles){
  if(!Array.isArray(profiles)||!profiles.length)throw Error('FIGURE3_MEAN: profiles required');
  const z=profiles[0].z;
  if(!z||z.length<3)throw Error('FIGURE3_GRID');
  for(let j=0;j<z.length;j++)if(!Number.isFinite(z[j])||(j&&z[j]<=z[j-1]))throw Error('FIGURE3_GRID');
  for(const p of profiles){
    if(!p.z||!p.profile||p.z.length!==z.length||p.profile.length!==z.length)throw Error('FIGURE3_GRID: inconsistent profiles');
    for(let j=0;j<z.length;j++){
      if(Math.abs(p.z[j]-z[j])>1e-10)throw Error('FIGURE3_GRID: native grids differ');
      if(!Number.isFinite(p.profile[j])||p.profile[j]<-1e-12||p.profile[j]>1+1e-12)throw Error('FIGURE3_PROFILE: normalized responses required');
    }
  }
  // Match the frozen manuscript's left-to-right start-angle sum and division.
  const mean=Float64Array.from(z,(_,j)=>profiles.reduce((sum,p)=>sum+p.profile[j],0)/profiles.length);
  return {z:Float64Array.from(z),mean};
}

function compactGroups(groups){
  return Object.fromEntries(['direct','combined'].map(pool=>[pool,
    Object.fromEntries(['fwhm','fwtm'].map(window=>{
      const g=groups[pool][window];
      return [window,{n:g.n,min:g.min,max:g.max,mean:g.mean,sd:g.sd,
        frequencies:g.frequencies.map(({count,frequency,fraction})=>({count,frequency,fraction}))}];
    }))]));
}

// Dependency injection permits fast orchestration tests; the browser entry point
// below always uses the unmodified production kernels and all 360 start angles.
export function createFigure3Runner({computeProfile=computeAxialResponse,computeDensity=computeCandidateDensity}={}){
  return async function recalculateFigure3({onProgress=()=>{},cancelled=()=>false}={}){
    const radii=[];
    const ensureActive=()=>{if(cancelled())throw Error('FIGURE3_CANCELLED');};
    let lastProgress=-Infinity;
    const progress=(radiusMm,radiusIndex,stage,completedStarts,withinStart=0,force=false)=>{
      const now=performance.now();
      if(!force&&now-lastProgress<100)return;
      lastProgress=now;
      const local=stage==='profiles'?.95*(completedStarts+withinStart)/STARTS
        :.95+.05*completedStarts/STARTS;
      onProgress({type:'progress',stage,radiusMm,radiusIndex,radiusCount:FIGURE3_RADII.length,
        completedStarts,totalStarts:STARTS,fraction:Math.min(1,(radiusIndex+local)/FIGURE3_RADII.length)});
    };
    for(const [radiusIndex,radiusMm] of FIGURE3_RADII.entries()){
      ensureActive();
      const profiles=[];
      let config;
      progress(radiusMm,radiusIndex,'profiles',0,0,true);
      for(let start=0;start<STARTS;start++){
        ensureActive();
        const result=await computeProfile(figure3PresetInput(radiusMm,TAU*start/STARTS),{
          profileOnly:true,cancelled,
          progress:value=>progress(radiusMm,radiusIndex,'profiles',start,Math.max(0,Math.min(1,value))),
        });
        ensureActive();
        if(result.geometryOnly||!result.profile)throw Error('FIGURE3_PROFILE: no response');
        if(result.config.candidateSearch!=='source-fan-window'||result.model.sourceAngleSpanDeg!==460)throw Error('FIGURE3_SUPPORT: manuscript source window required');
        config??={...result.config,phase:0};
        profiles.push({z:result.z,profile:result.profile});
        progress(radiusMm,radiusIndex,'profiles',start+1,0,true);
      }
      const nativeMean=meanNormalizedProfiles(profiles);
      const windows=candidateDensityWindows(nativeMean);
      ensureActive();
      progress(radiusMm,radiusIndex,'counts',0,0,true);
      const density=await computeDensity(config,windows,{
        angleSamples:DIRECTIONS,startSamples:STARTS,includeCounts:false,zObject:0,cancelled,
        onProgress:value=>progress(radiusMm,radiusIndex,'counts',value.completed),
      });
      ensureActive();
      if(density.sampleCount!==STARTS*DIRECTIONS)throw Error('FIGURE3_COUNTS: incomplete state set');
      radii.push({radiusMm,sampleCount:density.sampleCount,windows:density.windows,
        groups:compactGroups(density.groups)});
      progress(radiusMm,radiusIndex,'counts',STARTS,0,true);
    }
    ensureActive();
    return {schemaVersion:1,condition:{...FIGURE3_CONDITION},radii,
      provenance:{mode:'recalculated',cached:false,computedAt:new Date().toISOString(),
        modelVersion:AXIAL_RESPONSE_VERSION,candidateDensityVersion:CANDIDATE_DENSITY_VERSION,
        complete:true,profilesPerRadius:STARTS,
        windowMethod:'Native-z mean of 360 normalized SSPz profiles; renormalize the mean, then use fixed bilateral50%/10% crossings.',
        acquisitionSupport:'Finite460-degree source window, including complete angular-rebinning stencils.',
        scope:'Declared manuscript geometry and interpolation model; no scanner reconstruction or clinical validation.'}};
  };
}

export const recalculateFigure3=createFigure3Runner();

// The page owns Worker.terminate() for cancellation. Also close this dedicated
// worker after its final message so completed/failed work cannot remain active.
if(typeof self!=='undefined'&&typeof document==='undefined'&&typeof self.postMessage==='function'){
  let running=false,stopped=false;
  self.addEventListener('message',async event=>{
    const message=event.data;
    if(message?.type==='cancel'){
      stopped=true;self.close();return;
    }
    if(message?.type!=='start'||Object.keys(message).some(key=>key!=='type')||running){
      stopped=true;
      self.postMessage({type:'error',message:'FIGURE3_REQUEST: use only the fixed manuscript preset.'});
      self.close();return;
    }
    running=true;
    try{
      const data=await recalculateFigure3({cancelled:()=>stopped,onProgress:value=>self.postMessage(value)});
      if(!stopped)self.postMessage({type:'complete',data});
    }catch(error){
      if(!stopped)self.postMessage({type:'error',message:error?.message??String(error)});
    }finally{
      stopped=true;self.close();
    }
  });
}
