import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {axialResponseConfig,computeAxialResponse} from '../axial-response-core.js';
import {candidateDensityWindows} from '../candidate-density-core.js';
import {FIGURE3_RADII,FIGURE3_CONDITION,figure3PresetInput,meanNormalizedProfiles,createFigure3Runner} from '../figure3-worker.js';

const near=(a,b,tolerance=1e-12)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=tolerance,`${a} != ${b}`);
const profile=(values,z=[-2,-1,0,1,2])=>({z:Float64Array.from(z),profile:Float64Array.from(values)});
const a=profile([0,1,.5,0,0]),b=profile([0,0,.5,1,0]);
const originalA=Array.from(a.profile),originalB=Array.from(b.profile);
const mean=meanNormalizedProfiles([a,b]);
assert.deepEqual(Array.from(mean.z),[-2,-1,0,1,2]);
assert.deepEqual(Array.from(mean.mean),[0,.5,.5,.5,0]);
assert.deepEqual(Array.from(a.profile),originalA);
assert.deepEqual(Array.from(b.profile),originalB);
const windows=candidateDensityWindows(mean);
near(windows.fwhm.left,-1.5);near(windows.fwhm.right,1.5);
near(windows.fwtm.left,-1.9);near(windows.fwtm.right,1.9);
assert.throws(()=>meanNormalizedProfiles([]),/profiles required/);
assert.throws(()=>meanNormalizedProfiles([a,profile([0,0,.5,1,0],[-2,-1,.01,1,2])]),/grids differ/);
assert.throws(()=>meanNormalizedProfiles([profile([0,0,NaN,0,0])]),/normalized responses/);
assert.throws(()=>figure3PresetInput(100),/fixed manuscript positions/);

// Actual full-resolution production response, compared with the saved manuscript
// r=102,start=0,T=1 benchmark. One start only, not a substitute360-angle result.
const actual=await computeAxialResponse(figure3PresetInput(102),{profileOnly:true});
assert.equal(actual.config.viewSamples,1200);
assert.equal(actual.config.candidateSearch,'source-fan-window');
assert.equal(actual.model.sourceAngleSpanDeg,460);
near(actual.fwhm.width,1.4389893709926054);
near(actual.fwtm.width,2.5580890849083047);
// Stored rri_r102_s0.json, T=1 response samples, before any display alignment.
for(const [z,expected] of [
  [-1.5,.03805494907697534],[-1,.25514814595321306],[-.5,.7181605937621918],
  [0,1],[.5,.7181605937621917],[1,.2551481459532133],[1.5,.03805494907697571],
]){
  const index=Math.round((z-actual.z[0])/actual.config.zStep);
  near(actual.z[index],z);near(actual.profile[index],expected);
}
const single=meanNormalizedProfiles([{z:actual.z,profile:actual.profile}]);
assert.deepEqual(single.mean,actual.profile);
const singleWindows=candidateDensityWindows(single);
near(singleWindows.fwhm.width,actual.fwhm.width);
near(singleWindows.fwtm.width,actual.fwtm.width);
const digest=createHash('sha256').update(Buffer.from(actual.profile.buffer)).digest('hex');

// Fast orchestration test: kernel doubles produce test-only profiles; the same
// production runner still requests all4x360 starts and360x360 count states.
const calls=[],progress=[],densityCalls=[];
const testGroups=Object.fromEntries(['direct','combined'].map((pool,p)=>[pool,
  Object.fromEntries(['fwhm','fwtm'].map((window,w)=>[window,
    {n:129600,min:1+p+w,max:1+p+w,mean:1+p+w,sd:0,
      frequencies:[{count:1+p+w,frequency:129600,fraction:1}]}]))]));
const run=createFigure3Runner({
  computeProfile:async (input,hooks)=>{
    calls.push({...input});
    assert.equal(hooks.profileOnly,true);
    assert.equal(hooks.cancelled(),false);
    hooks.progress(.5);
    return {config:axialResponseConfig(input),model:{sourceAngleSpanDeg:460},...profile([0,.5,1,.5,0])};
  },
  computeDensity:async (config,window,options)=>{
    densityCalls.push({config,window,options});
    assert.equal(options.startSamples,360);assert.equal(options.angleSamples,360);
    assert.equal(options.includeCounts,false);assert.equal(options.zObject,0);
    options.onProgress({completed:180,total:360,fraction:.5});
    return {sampleCount:129600,windows:window,groups:testGroups};
  },
});
const result=await run({onProgress:value=>progress.push(value)});
assert.equal(calls.length,1440);
for(const [ri,radius] of FIGURE3_RADII.entries())for(let i=0;i<360;i++){
  assert.deepEqual(calls[ri*360+i],figure3PresetInput(radius,2*Math.PI*i/360));
}
assert.equal(densityCalls.length,4);
assert.deepEqual(result.radii.map(r=>r.radiusMm),[10,50,80,102]);
assert.deepEqual(result.condition,FIGURE3_CONDITION);
assert.equal(result.schemaVersion,1);
assert.equal(result.provenance.mode,'recalculated');
assert.equal(result.provenance.cached,false);
assert.equal(result.provenance.complete,true);
assert.ok(result.radii.every(r=>r.sampleCount===129600));
assert.deepEqual(result.radii[0].groups,testGroups);
assert.ok(progress.length>=1440);
assert.ok(progress.every((p,i)=>p.type==='progress'&&p.totalStarts===360&&p.fraction>=0&&p.fraction<=1&&(!i||p.fraction>=progress[i-1].fraction)));
assert.equal(progress.at(-1).fraction,1);

let cancelProfileCalls=0,cancelCountCalls=0;
const cancelledRun=createFigure3Runner({
  computeProfile:async input=>{
    cancelProfileCalls++;
    return {config:axialResponseConfig(input),model:{sourceAngleSpanDeg:460},...profile([0,.5,1,.5,0])};
  },computeDensity:async()=>{cancelCountCalls++;},
});
await assert.rejects(cancelledRun({cancelled:()=>cancelProfileCalls>=1}),/FIGURE3_CANCELLED/);
assert.equal(cancelProfileCalls,1);assert.equal(cancelCountCalls,0);
await assert.rejects(createFigure3Runner({computeProfile:async()=>{throw Error('kernel-failure');}})(),/kernel-failure/);

// Invalid browser messages cannot change the preset or begin expensive work.
const moduleUrl=new URL('../figure3-worker.js',import.meta.url).href;
const wrapper=`import {parentPort} from 'node:worker_threads';
globalThis.self={postMessage:m=>parentPort.postMessage(m),close:()=>parentPort.close(),addEventListener:(kind,fn)=>parentPort.on(kind,data=>fn({data}))};
await import(${JSON.stringify(moduleUrl)});parentPort.postMessage({type:'test-ready'});`;
const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(wrapper)),{type:'module'});
await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{worker.terminate();reject(Error('worker protocol timeout'));},10000);
  worker.on('error',error=>{clearTimeout(timeout);reject(error);});
  worker.on('message',message=>{
    if(message.type==='test-ready')worker.postMessage({type:'start',params:{viewSamples:90}});
    else if(message.type==='error'){
      assert.match(message.message,/fixed manuscript preset/);
      clearTimeout(timeout);resolve();
    }else{clearTimeout(timeout);reject(Error('invalid request started calculation'));}
  });
});
await worker.terminate();
console.log(JSON.stringify({status:'pass',actualStart0ProfileHash:digest,
  actualFWHM:actual.fwhm.width,actualFWTM:actual.fwtm.width,
  nativeGridSamples:actual.z.length,testDoubleOrchestrationProfileCalls:calls.length,
  testDoubleOrchestrationRadiusCalls:densityCalls.length,
  full360ScientificRunPerformed:false}));
