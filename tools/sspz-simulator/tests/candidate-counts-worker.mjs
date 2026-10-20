import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {axialResponseConfig} from '../axial-response-core.js';
import {candidateDensityWindows,computeCandidateDensity} from '../candidate-density-core.js';
import {MAX_POSITIONS,readCandidateSettings,validateCandidateRequest,candidateProfileInput,candidateSettingsUrl} from '../candidate-counts-config.js';
import {countCandidatesAtBasePhase,createCandidateCountsRunner,recalculateCandidateCounts} from '../candidate-counts-worker.js';

const near=(a,b,tolerance=1e-12)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=tolerance,`${a} != ${b}`);
assert.equal(MAX_POSITIONS,12);
const q='?v=20&n=8&d=0.7&p=1.2&st=0.6&R=650&r=60&ff=0.8&fd=1120&cp=0.62&ca=0.41&nv=180&model=merged&fdk_zStep=0.2&fdk_phase=0.37&fdk_fullFanAngleDeg=60&fdk_edgePolicy=available&fdk_normalization=peak';
const settings=readCandidateSettings(q);
assert.equal(settings.rows,8);assert.equal(settings.rowWidth,.7);assert.equal(settings.beamPitch,1.2);
assert.equal(settings.sliceThicknessMm,.6);assert.equal(settings.phase,.37);
assert.equal(settings.normalization,'peak');assert.equal(settings.axialRule,'merged');
assert.deepEqual(readCandidateSettings(candidateSettingsUrl(settings)),settings);
assert.deepEqual(readCandidateSettings('?main='+encodeURIComponent(q)),settings);
assert.equal(readCandidateSettings().focalSizeMm,1.2);
assert.equal(readCandidateSettings('?n=4').focalSizeMm,0);
const input=candidateProfileInput(settings,90,.37+Math.PI);
const scale=Math.max(Math.abs(1-(650-90)/1120),Math.abs(1-(650+90)/1120));
near(input.zExtent,Math.max(1,.6+2*.7*(1+90/650))+.8*scale/2);
assert.equal(input.axialAverageMm,.6);assert.equal(input.phaseCount,360);
assert.equal(input.candidateSearch,'source-fan-window');assert.equal(input.normalization,'peak');
assert.equal(input.comparisonMode,'legacy');near(input.phase,.37+Math.PI);
assert.deepEqual(validateCandidateRequest({settings,radii:[20,60,90]}).radii,[20,60,90]);
assert.throws(()=>validateCandidateRequest({radii:[20]}),/settings object required/);
for(const invalid of [[],[20,20],Array.from({length:13},(_,i)=>i),[-1],[251],['bad'],[null],[false],[[]]])assert.throws(()=>validateCandidateRequest({settings,radii:invalid}));
for(const bad of [{rows:321},{rows:1.5},{beamPitch:0},{viewSamples:181},{channelApertureMm:.7},{normalization:'fit'},{axialRule:'parallel'}])assert.throws(()=>validateCandidateRequest({settings:{...settings,...bad},radii:[20]}));
assert.throws(()=>validateCandidateRequest({settings:{...settings,sourceRadius:100,fullFanAngleDeg:10},radii:[20]}),/outside/);
assert.throws(()=>validateCandidateRequest({settings:{...settings,focalSourceDetectorMm:700},radii:[90]}),/beyond/);
const ffs=readCandidateSettings('?n=8&d=.5&p=.625&st=.5&R=600&r=60&ff=0&fd=1070&cp=.25&ca=.25&nv=180&model=rri&zffs=1&zffs_m=9&zffs_a=.25');
near(ffs.zFfsMagnification,1070/600);
assert.deepEqual(readCandidateSettings(candidateSettingsUrl(ffs)),ffs);
const ffsInput=candidateProfileInput(ffs,60,0);
near(ffsInput.zExtent,Math.max(1,.5+2*.5*(1+60/600))+2*.25*.5/(1-600/1070));
assert.equal(axialResponseConfig(ffsInput).zFfsEnabled,true);
assert.throws(()=>validateCandidateRequest({settings:{...ffs,zFfsMagnification:2},radii:[60]}),/equal D\/R/);

const z=Float64Array.from([-2,-1,0,1,2]),profile=Float64Array.from([0,.5,1,.5,0]);
const windows=candidateDensityWindows({z,mean:profile});
const config=axialResponseConfig(candidateProfileInput({...settings,axialRule:'rri'},20,0));
const old=await computeCandidateDensity(config,windows,{startSamples:12,angleSamples:18,includeCounts:false});
const same=await countCandidatesAtBasePhase(config,windows,{basePhase:0,startSamples:12,angleSamples:18});
assert.deepEqual(same.groups,old.groups);
const phases=[],directions=[];
const phaseCounts=await countCandidatesAtBasePhase(config,windows,{basePhase:.37,startSamples:4,angleSamples:3,
  countsAt:(c,angle)=>{phases.push(c.phase);directions.push(angle);return {direct:{fwhm:1,fwtm:2},combined:{fwhm:2,fwtm:3}};}});
assert.equal(phaseCounts.sampleCount,12);
for(let i=0;i<4;i++)for(let j=0;j<3;j++){near(phases[i*3+j],.37+2*Math.PI*i/4);near(directions[i*3+j],j*120);}

const seriesCalls=[],countsCalls=[],partial=[],progress=[];
const runner=createCandidateCountsRunner({
  computeSeries:async (args,hooks)=>{
    seriesCalls.push(args);assert.equal(hooks.profileOnly,true);
    hooks.progress(.5);hooks.domainExpanded({extentMm:6});hooks.progress(0);hooks.progress(1);
    const c=axialResponseConfig(args);
    return {config:c,model:{sourceAngleSpanDeg:360+2*args.fullFanAngleDeg},z,mean:profile,
      profiles:Array.from({length:360},(_,i)=>({phase:args.phase+2*Math.PI*i/360,profile}))};
  },
  computeCounts:async (c,w,options)=>{
    countsCalls.push({c,w,options});near(options.basePhase,.37);
    assert.equal(options.startSamples,360);assert.equal(options.angleSamples,360);
    options.onProgress({completed:360,total:360,fraction:1});
    const g={n:129600,min:1,max:1,mean:1,sd:0,frequencies:[{count:1,frequency:129600,fraction:1}]};
    return {windows:w,sampleCount:129600,groups:{direct:{fwhm:g,fwtm:g},combined:{fwhm:g,fwtm:g}}};
  },
});
const result=await runner({settings,radii:[20,60,90]}, {onProgress:p=>progress.push(p),onRadiusComplete:p=>partial.push(p)});
assert.equal(seriesCalls.length,3);assert.equal(countsCalls.length,3);assert.equal(partial.length,3);
assert.deepEqual(seriesCalls.map(c=>c.radius),[20,60,90]);
assert.ok(seriesCalls.every(c=>c.phase===.37&&c.phaseCount===360&&c.rows===8&&c.normalization==='peak'));
assert.deepEqual(result.radii.map(r=>r.radiusMm),[20,60,90]);
assert.equal(result.condition.basePhaseRad,.37);assert.equal(result.condition.sourceSupportDeg,480);
assert.equal(result.condition.normalization,'peak');assert.equal(result.condition.axialRule,'merged');
assert.equal(result.provenance.cached,false);assert.equal(result.provenance.complete,true);
assert.ok(progress.every((p,i)=>p.radiusCount===3&&p.totalStarts===360&&(!i||p.fraction>=progress[i-1].fraction)));
assert.equal(progress.at(-1).fraction,1);assert.ok(progress.some(p=>p.domainRestarts===1));
let started=0;
await assert.rejects(createCandidateCountsRunner({computeSeries:async()=>{started++;return {};}})({settings,radii:[20]}, {cancelled:()=>started>0}),/CANCELLED/);
assert.equal(started,1);
await assert.rejects(createCandidateCountsRunner({computeSeries:async()=>{throw Error('unsupported-coverage');}})({settings,radii:[20]}),/unsupported-coverage/);

// Real complete360-start series at a deliberately inexpensive changed condition.
// This is a genuine calculation, with all129600 count states at each position.
const lowCost=readCandidateSettings('?n=8&d=.5&p=.625&st=.5&R=600&r=20&ff=0&fd=1070&cp=.58&ca=.58&nv=180&model=rri&fdk_zStep=.2&fdk_phase=.37&fdk_normalization=peak');
const realStarted=performance.now();
const real=await recalculateCandidateCounts({settings:lowCost,radii:[20,60]});
assert.equal(real.radii.length,2);assert.equal(real.condition.rows,8);
assert.equal(real.condition.nativeViewsPerRotation,180);assert.equal(real.condition.basePhaseRad,.37);
for(const r of real.radii){
  assert.equal(r.sampleCount,129600);
  assert.ok(r.windows.fwhm.left<r.windows.fwhm.right);
  assert.ok(r.windows.fwtm.left<=r.windows.fwhm.left&&r.windows.fwtm.right>=r.windows.fwhm.right);
  for(const pool of ['direct','combined'])for(const window of ['fwhm','fwtm']){
    const g=r.groups[pool][window];
    assert.equal(g.n,129600);assert.equal(g.frequencies.reduce((s,p)=>s+p.frequency,0),129600);
    near(g.frequencies.reduce((s,p)=>s+p.fraction,0),1);
  }
}

// Invalid browser requests are rejected before a calculation starts.
const moduleUrl=new URL('../candidate-counts-worker.js',import.meta.url).href;
const wrapper=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:m=>parentPort.postMessage(m),close:()=>parentPort.close(),addEventListener:(kind,fn)=>parentPort.on(kind,data=>fn({data}))};await import(${JSON.stringify(moduleUrl)});parentPort.postMessage({type:'test-ready'});`;
const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(wrapper)),{type:'module'});
await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{worker.terminate();reject(Error('worker protocol timeout'));},10000);
  worker.on('error',error=>{clearTimeout(timeout);reject(error);});
  worker.on('message',message=>{
    if(message.type==='test-ready')worker.postMessage({type:'start',settings,radii:[20,20]});
    else if(message.type==='error'){assert.match(message.message,/duplicate/);clearTimeout(timeout);resolve();}
    else{clearTimeout(timeout);reject(Error('invalid request started work'));}
  });
});
await worker.terminate();
console.log(JSON.stringify({status:'pass',realFullStartAnglesPerPosition:360,realPositions:real.radii.map(r=>r.radiusMm),
  realCountStatesPerPosition:129600,realElapsedMs:performance.now()-realStarted,
  phaseOffsetPreserved:real.condition.basePhaseRad,sharedDomainStrategy:real.provenance.nativeGrid,
  condition:real.condition}));
