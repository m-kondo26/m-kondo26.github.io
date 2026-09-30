// Geometry-side counts before interpolation selection or signal weighting.
// Both pools use the SAME finite acquired-source range and angular stencil.
import {sourceAxialGroups} from './axial-source-response.js';
import {axialSourceWindow,axialSourceStencil} from './axial-source-support.js';
import {fdkWidth} from './fdk-core.js';

export const CANDIDATE_DENSITY_VERSION='2026-09-30.1';
const CD_TAU=2*Math.PI,CD_EPS=1e-10;

function densityWindows(windows){
  const out={fwhm:windows.fwhm??windows.FWHM,fwtm:windows.fwtm??windows.FWTM};
  for(const name of ['fwhm','fwtm']){
    const w=out[name];
    if(!w||![w.left,w.right].every(Number.isFinite)||w.left>=w.right)throw Error('CANDIDATE_DENSITY_WINDOW: complete bilateral crossings required');
    out[name]={left:w.left,right:w.right,width:w.right-w.left};
  }
  if(out.fwtm.left>out.fwhm.left+CD_EPS||out.fwtm.right<out.fwhm.right-CD_EPS)throw Error('CANDIDATE_DENSITY_WINDOW: FWTM must contain FWHM');
  return out;
}

export function candidateDensityWindows(series){
  const z=series.z;
  let mean=series.mean;
  if(!mean&&series.profiles?.length)mean=Float64Array.from(z,(_,i)=>series.profiles.reduce((s,p)=>s+p.profile[i],0)/series.profiles.length);
  if(!z||!mean||z.length!==mean.length||z.length<3)throw Error('CANDIDATE_DENSITY_MEAN: complete start-angle SSPz series required');
  let low=Infinity,high=-Infinity;
  for(let i=0;i<z.length;i++){
    if(!Number.isFinite(z[i])||!Number.isFinite(mean[i])||(i&&z[i]<=z[i-1]))throw Error('CANDIDATE_DENSITY_MEAN: invalid native grid');
    low=Math.min(low,mean[i]);high=Math.max(high,mean[i]);
  }
  if(!(high>low))throw Error('CANDIDATE_DENSITY_MEAN: no response');
  const normalized=Float64Array.from(mean,v=>(v-low)/(high-low));
  return densityWindows({fwhm:fdkWidth(z,normalized,.5),fwtm:fdkWidth(z,normalized,.1)});
}

// A detector group is a uniformly spaced row lattice. Its window population
// is obtained by integer bounds, preserving each row (including zero-weight
// rows) without allocating up to 320 row objects at every analysis angle.
function densityRowCount(c,origin,spacing,w){
  const half=(c.rows-1)/2;
  const first=Math.max(0,Math.ceil((w.left-CD_EPS-origin)/spacing+half));
  const last=Math.min(c.rows-1,Math.floor((w.right+CD_EPS-origin)/spacing+half));
  return Math.max(0,last-first+1);
}

export function candidateDensityCountsAt(c,thetaDeg,zObject,windows){
  const w=densityWindows(windows),v=(thetaDeg*Math.PI/180-c.phase)*c.viewSamples/CD_TAU;
  const groups=sourceAxialGroups(c,v),support=axialSourceWindow(c,zObject),seen=new Set();
  const counts={direct:{fwhm:0,fwtm:0},combined:{fwhm:0,fwtm:0}};
  for(const g of groups){
    // Coincident focal positions are one acquisition trajectory (the same
    // full angular grid), not two distinct physical measurements.
    if(c.zFfsEnabled&&c.zFfsOffset===0&&g.focus===1)continue;
    const beta=g.beta??(c.phase+g.view*CD_TAU/c.viewSamples);
    const first=Math.ceil((support.betaMin-beta)/CD_TAU-CD_EPS);
    const last=Math.floor((support.betaMax-beta)/CD_TAU+CD_EPS);
    for(let turn=first;turn<=last;turn++){
      const actualBeta=beta+turn*CD_TAU,stencil=axialSourceStencil(c,actualBeta,g.focus??0);
      if(stencil[0]<support.firstView||stencil.at(-1)>support.lastView)continue;
      const key=(g.view+turn*c.viewSamples).toFixed(8)+':'+(g.focus??0);
      if(seen.has(key))continue;
      seen.add(key);
      // SSPz native z is a physical-mm offset from zObject; acquired source
      // support remains centred on the absolute target plane.
      const origin=g.origin+turn*c.feed-zObject;
      for(const name of ['fwhm','fwtm']){
        const n=densityRowCount(c,origin,g.spacing,w[name]);
        counts.combined[name]+=n;
        if(g.direction===0)counts.direct[name]+=n;
      }
    }
  }
  return counts;
}

function densityAccumulator(size,keep){return {n:0,sum:0,sum2:0,min:Infinity,max:0,hist:new Map(),counts:keep?new Uint16Array(size):null};}
function densityAccumulate(a,value,index){
  if(!Number.isInteger(value)||value<0||value>65535)throw Error('CANDIDATE_DENSITY_COUNT: invalid integer count');
  a.n++;a.sum+=value;a.sum2+=value*value;a.min=Math.min(a.min,value);a.max=Math.max(a.max,value);
  a.hist.set(value,(a.hist.get(value)??0)+1);if(a.counts)a.counts[index]=value;
}
function densityDistribution(a){
  const mean=a.sum/a.n;
  return {frequencies:[...a.hist].sort((x,y)=>x[0]-y[0]).map(([count,frequency])=>({count,frequency,fraction:frequency/a.n})),mean,min:a.min,max:a.max,sd:Math.sqrt(Math.max(0,a.sum2/a.n-mean*mean)),n:a.n,...(a.counts?{counts:a.counts}:{})};
}

export async function computeCandidateDensity(config,windows,options={}){
  const c={...config},w=densityWindows(windows),angleSamples=options.angleSamples??360,startSamples=options.startSamples??360;
  if(!Number.isFinite(c.feed)||c.feed<=0||!Number.isInteger(c.rows)||c.rows<1||c.rows>320)throw Error('CANDIDATE_DENSITY_GEOMETRY: positive helical feed and 1 to 320 rows required');
  if(c.candidateSearch!=='source-fan-window')throw Error('CANDIDATE_DENSITY_SUPPORT: finite source-angle model required');
  if(![angleSamples,startSamples].every(n=>Number.isInteger(n)&&n>0&&n<=360))throw Error('CANDIDATE_DENSITY_ANGLES');
  const zObject=options.zObject??(c.state??0)*c.feed,size=angleSamples*startSamples,acc={};
  for(const pool of ['direct','combined'])acc[pool]={fwhm:densityAccumulator(size,options.includeCounts!==false),fwtm:densityAccumulator(size,options.includeCounts!==false)};
  let yielded=performance.now();
  for(let start=0;start<startSamples;start++){
    if(options.cancelled?.())throw Error('CANDIDATE_DENSITY_CANCELLED');
    c.phase=start*CD_TAU/startSamples;
    for(let angle=0;angle<angleSamples;angle++){
      const counts=candidateDensityCountsAt(c,angle*360/angleSamples,zObject,w),index=start*angleSamples+angle;
      for(const pool of ['direct','combined']){
        if(counts[pool].fwhm>counts[pool].fwtm)throw Error('CANDIDATE_DENSITY_NESTING');
        for(const name of ['fwhm','fwtm'])densityAccumulate(acc[pool][name],counts[pool][name],index);
      }
      if(counts.direct.fwhm>counts.combined.fwhm||counts.direct.fwtm>counts.combined.fwtm)throw Error('CANDIDATE_DENSITY_SUBSET');
    }
    if(performance.now()-yielded>=20||start===startSamples-1){
      options.onProgress?.({completed:start+1,total:startSamples,fraction:(start+1)/startSamples});
      await new Promise(resolve=>setTimeout(resolve,0));yielded=performance.now();
    }
  }
  const groups={};for(const pool of ['direct','combined'])groups[pool]={fwhm:densityDistribution(acc[pool].fwhm),fwtm:densityDistribution(acc[pool].fwtm)};
  return {version:CANDIDATE_DENSITY_VERSION,config:{...config},zObject,windows:w,sampleCount:size,angleSamples,startSamples,groups,
    definitions:{
      candidate:'Geometric rebinned detector-row centre before interpolation selection; every row centre in the response window is counted regardless of interpolation weight or signal.',
      direct:'Only own-direction real-data centres (direction 0).',
      combined:'Unique centres from direct and conjugate roles (directions 0 and 1), within the same acquired-source window.',
      support:'The central target plane source window and its complete acquired-view rebinning stencil, identical for both pools; finite 360 degrees + twice the declared full fan angle.',
      window:'Fixed bilateral 50% and 10% crossings of the native-z mean of normalized SSPz over all start angles, followed by min-max normalization of the mean. FWTM includes FWHM.',
      unit:'Centres per ONE interpolation direction in each angle/start state; not summed over all directions.',
      aggregation:'Equal-weight interpolation-direction and acquisition-start-angle combinations; complete 0 to <360-degree cycles in both variables. Pooling does not identify a period or its angle.',
      identity:'Rebinned view, focal trajectory and detector row, with coincident focal trajectories counted once. Conjugate representation does not add an acquisition; counts are not independent raw-record/photon counts.',
      coordinates:'One in-plane evaluation position (radius,0); native physical-mm z offset from the target plane, with no FWHM/FWTM alignment or spatial rescaling; not a full XY map.',
      scope:'Response-window populations; not dose, noise, motion-correction performance or a measure of within-window spacing.',
      countOrder:'start-major: index=startIndex*angleSamples+directionIndex.',
      grid:'Analysis directions/start angles are independent of native acquired-view sampling; full native source stencils are retained.'}};
}

export async function computeCandidateDensityFromSeries(series,options={}){
  if(series.geometryOnly||!series.profiles||series.profiles.length!==360)throw Error('CANDIDATE_DENSITY_SERIES: prepare all 360 start angles first');
  return computeCandidateDensity(series.config,candidateDensityWindows(series),{...options,zObject:series.zObject??(series.config.state??0)*series.config.feed});
}
