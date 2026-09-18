import assert from 'node:assert/strict';
import {axialResponseConfig,computeAxialResponse,computeAxialResponseSeries} from '../axial-response-core.js';
import {AXIAL_TAIL_TOLERANCE,AXIAL_MAX_EXTENT_MM,assertAxialRawDomain,axialRawTailFraction,expandAxialDomain} from '../axial-domain.js';

// These are numerical-domain regression checks, not validation of a scanner
// reconstruction. Low view counts keep the tests small; no clinical precision
// claim is made from these fixtures.
let checks=0;
const near=(a,b,t=1e-12)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
const tails=e=>e.code==='AXIAL_DOMAIN_TAILS'&&e.rawTailFraction>AXIAL_TAIL_TOLERANCE;
const base={rows:16,rowWidth:.5,beamPitch:3,sourceRadius:600,radius:0,
  viewSamples:90,zExtent:2,zStep:.1,axialAverageMm:1,axialRule:'merged'};

// A clipped nonzero baseline must be rejected before either normalization.
// On the pre-fix implementation this fixture returned minmax FWHM 1.05158565
// mm despite 5.334% raw endpoint response, while peak normalization rejected it.
for(const normalization of ['minmax','peak']){
  await assert.rejects(()=>computeAxialResponse({...base,normalization},{profileOnly:true,lockDomain:true}),tails);
  checks++;
}
const expandedEvents=[];
const minmax=await computeAxialResponse({...base,normalization:'minmax'},
  {profileOnly:true,domainExpanded:e=>expandedEvents.push(e)});
const peak=await computeAxialResponse({...base,normalization:'peak'},{profileOnly:true});
assert.deepEqual(minmax.raw,peak.raw);
assert.deepEqual(minmax.profile,peak.profile);
assert.deepEqual(minmax.fwhm,peak.fwhm);
assert.deepEqual(minmax.fwtm,peak.fwtm);
assert.equal(minmax.baseline,0);
assert.equal(minmax.config.zExtent,8);
assert.deepEqual(expandedEvents.map(e=>e.extentMm),[4,8]);
assert.equal(minmax.domainCheck.requestedExtentMm,2);
assert.equal(minmax.domainCheck.actualExtentMm,8);
assert.equal(minmax.domainCheck.expansions,2);
assert.equal(minmax.domainCheck.rawTailFraction,0);
assert.equal(minmax.config.zStep,axialResponseConfig(base).zStep);
const explicit=await computeAxialResponse({...base,zExtent:8},{profileOnly:true,lockDomain:true});
assert.deepEqual(minmax.z,explicit.z);
assert.deepEqual(minmax.raw,explicit.raw);
checks++;

// A later phase, not the first, exposes clipping. The whole series must then
// restart on one common grid; earlier profiles cannot retain their short grid.
const seriesInput={...base,radius:102,zExtent:1.5,phase:Math.PI/4,phaseCount:8};
const first=await computeAxialResponse(seriesInput,{profileOnly:true,lockDomain:true});
assert.equal(first.config.zExtent,1.5);
await assert.rejects(()=>computeAxialResponse({...seriesInput,phase:3*Math.PI/4},
  {profileOnly:true,lockDomain:true}),tails);
let lockedRetries=0;
await assert.rejects(()=>computeAxialResponseSeries(seriesInput,{profileOnly:true,lockDomain:true,
  domainExpanded:()=>lockedRetries++}),tails);
assert.equal(lockedRetries,0);
let progress=0;
const seriesEvents=[];
const series=await computeAxialResponseSeries(seriesInput,{profileOnly:true,
  progress:v=>progress=v,domainExpanded:e=>seriesEvents.push({...e,progress})});
assert.equal(seriesEvents[0].progress,.25);
assert.deepEqual(seriesEvents.map(e=>e.extentMm),[3,6,12]);
assert.equal(series.config.zExtent,12);
assert.equal(series.config.zStep,first.config.zStep);
assert.equal(series.profiles.length,8);
assert.equal(series.domainCheck.expansions,3);
for(let i=0;i<series.profiles.length;i++){
  const p=series.profiles[i];
  const single=await computeAxialResponse({...series.config,phase:p.phase},
    {profileOnly:true,lockDomain:true});
  assert.deepEqual(single.z,series.z);
  assert.deepEqual(single.raw,p.raw);
  assert.deepEqual(single.profile,p.profile);
  assert.equal(p.raw.length,series.z.length);
  assert.ok(p.rawTailFraction<=AXIAL_TAIL_TOLERANCE);
}
for(let j=0;j<series.z.length;j++){
  near(series.mean[j],series.profiles.reduce((s,p)=>s+p.profile[j],0)/8);
  near(series.meanDifference.reduce((s,p)=>s+p[j],0),0);
}
checks++;

// All active response implementations validate raw tails before treating a
// normalized flat plateau as an absent response, including legacy z-FFS.
const plateau={...base,rows:4,rowWidth:1,beamPitch:.875,viewSamples:180,
  zExtent:1,axialAverageMm:5};
for(const mode of [{},{candidateSearch:'one-turn'},
  {candidateSearch:'one-turn',zFfsEnabled:true}]){
  await assert.rejects(()=>computeAxialResponse({...plateau,...mode},
    {profileOnly:true,lockDomain:true}),e=>tails(e)&&e.rawTailFraction>.99);
}
checks++;

// Round-tripping a derived grid must not add an interval through ceil rounding.
// Widening preserves actual dz and the positions of the former grid samples.
for(const extent of [1.003,1.1,1.23456789,2.3])for(const dz of [.01,.05,.17]){
  const c=axialResponseConfig({...base,zExtent:extent,zStep:dz});
  const again=axialResponseConfig(c);
  assert.equal(again.zSamples,c.zSamples);
  assert.equal(again.zStep,c.zStep);
  assert.equal(again.zExtent,c.zExtent);
  const wider=expandAxialDomain(c),roundTrip=axialResponseConfig(wider);
  assert.equal(wider.zStep,c.zStep);
  assert.equal(roundTrip.zStep,wider.zStep);
  assert.equal(roundTrip.zSamples,wider.zSamples);
  const offset=(wider.zSamples-c.zSamples)/2;
  assert.equal(Number.isInteger(offset),true);
  for(let i=0;i<c.zSamples;i++)near(-c.zExtent+i*c.zStep,-wider.zExtent+(i+offset)*wider.zStep);
  checks++;
}

// Guard edge cases: the flat-positive case used to resemble "no response"
// after subtracting its minimum, but is evidence of an insufficient domain.
assert.throws(()=>assertAxialRawDomain(Float64Array.of(2,2,2),2),tails);
assert.throws(()=>assertAxialRawDomain(Float64Array.of(0,1,.01),1),tails);
assert.throws(()=>assertAxialRawDomain(Float64Array.of(.01,1,0),1),tails);
assert.doesNotThrow(()=>assertAxialRawDomain(Float64Array.of(0,0,0),0));
assert.doesNotThrow(()=>assertAxialRawDomain(Float64Array.of(1e-11,1,0),1));
assert.throws(()=>assertAxialRawDomain(Float64Array.of(1e-9,1,0),1),tails);
for(const value of [NaN,Infinity,-Infinity]){
  assert.throws(()=>assertAxialRawDomain(Float64Array.of(0,value,0),1),/AXIAL_NUMERIC/);
  assert.throws(()=>assertAxialRawDomain(Float64Array.of(0,1,0),value),/AXIAL_NUMERIC/);
}
near(axialRawTailFraction(Float64Array.of(.2,2,.1),2),.1);
checks++;

// Respect the finite cap without reducing resolution to fit it. Exercise this
// via the domain helper rather than an expensive 80-mm reconstruction.
const capped=expandAxialDomain({zSamples:801,zStep:.13,zExtent:52});
assert.ok(capped.zExtent<=AXIAL_MAX_EXTENT_MM);
assert.equal(capped.zStep,.13);
assert.equal(capped.zSamples%2,1);
assert.throws(()=>expandAxialDomain(capped),/AXIAL_DOMAIN_LIMIT/);
assert.throws(()=>expandAxialDomain({zSamples:16001,zStep:.01,zExtent:80}),/AXIAL_DOMAIN_LIMIT/);
checks++;

// Cancellation is preserved at entry, after a retry, and between phases.
await assert.rejects(()=>computeAxialResponse(base,{cancelled:()=>true}),/FDK_CANCELLED/);
let stop=false,retries=0;
await assert.rejects(()=>computeAxialResponse(base,{profileOnly:true,cancelled:()=>stop,
  domainExpanded:()=>{retries++;stop=true;}}),/FDK_CANCELLED/);
assert.equal(retries,1);
stop=false;
await assert.rejects(()=>computeAxialResponseSeries({...seriesInput,zExtent:12},
  {profileOnly:true,cancelled:()=>stop,progress:v=>{if(v>=1/8)stop=true;}}),/FDK_CANCELLED/);
let invalidRetries=0;
await assert.rejects(()=>computeAxialResponse({...base,beamPitch:0},
  {domainExpanded:()=>invalidRetries++}),/GEOMETRY_ONLY/);
assert.equal(invalidRetries,0);
checks++;

console.log(`PASS: axial domain ${checks} groups (raw-tail guard, normalization equivalence, later-phase shared-grid retries, derived grids, finite cap, cancellation)`);
