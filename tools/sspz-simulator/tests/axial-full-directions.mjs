import {sourceOracle} from './source-support-oracle.mjs';
// Independent all-row, Cartesian-ray oracle for the user's red angular gap.
import assert from 'node:assert/strict';
import '../axial-angle-display.js';
import {axialResponseConfig,computeAxialResponse} from '../axial-response-core.js';
import {createAxialAnimationAudit} from '../axial-animation-core.js';
const near=(a,b,label)=>assert.ok(Math.abs(a-b)<2e-10,`${label}: ${a} != ${b}`);
const c=axialResponseConfig({rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,radius:250,viewSamples:360,zExtent:8,zStep:.05,axialAverageMm:5,phase:0,state:0,axialRule:'merged'});
const raw=await createAxialAnimationAudit(c,{frameCount:3,maxAngles:360});
const full=SSPZAngles.animation(raw),V=c.viewSamples,H=V/2;
let checkedDirections=0;
for(const frame of full.frames){
 const u=frame.u,start=full.base;
 assert.equal(new Set(frame.instant.map(p=>p.referenceView)).size,V);
 for(let v=start;v<start+V;v++){
  const opposite=v<start+H?v+H:v-H,expected=sourceOracle(c,v,u);
  const actual=frame.instant.filter(p=>p.referenceView===v);
  near(actual.reduce((s,p)=>s+p.weight,0),1,'normalized direction');
  near(actual.reduce((s,p)=>s+p.weight*p.z,0),u,'brackets moving plane');
  for(const p of actual){
   const q=expected.find(q=>q.view===p.view&&q.row===p.row&&q.direction===p.direction);
   assert(q,'candidate identity agrees with independent oracle');
   near(q.weight,p.weight,'oracle weight');near(q.z,p.z,'oracle coordinate');
   assert.equal(p.oppositeView,opposite);
  }
  checkedDirections++;
 }
}
// Generic conservation: each raw physical datum contributes exactly the same
// angular-averaged coefficient after the directional display transformation.
const dataKey=p=>`${p.view}:${p.focus??0}:${p.row}`;
const aggregate=(points,factor)=>{
 const m=new Map();for(const p of points)m.set(dataKey(p),(m.get(dataKey(p))??0)+p.weight*factor);return m;
};
const compare=(before,after,c)=>{
 const a=aggregate(before,2/c.viewSamples),b=aggregate(after,1/c.viewSamples);
 assert.equal(a.size,b.size);for(const [k,v] of a)near(v,b.get(k),'physical coefficient conservation');
 const displayKeys=after.map(p=>`${p.referenceView}:${p.direction}:${dataKey(p)}`);
 assert.equal(new Set(displayKeys).size,after.length,'one summed marker per directional datum');
};
const cases=[{axialRule:'merged',axialAverageMm:5},{axialRule:'merged',axialAverageMm:0},
 {axialRule:'rri',axialAverageMm:1},{axialRule:'parallel',axialAverageMm:5},
 {axialRule:'merged',axialAverageMm:5,zFfsEnabled:true,zFfsSourceOffsetMm:.25},
 {axialRule:'merged',axialAverageMm:5,viewSamples:2400},
 {axialRule:'rri',rows:320,rowWidth:.5,beamPitch:.5,axialAverageMm:1}];
let responseChecks=0;
for(const extra of cases){
 const result=await computeAxialResponse({rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,radius:250,viewSamples:360,zExtent:8,zStep:.1,phase:.31,state:.45,...extra});
 const snapshot=JSON.stringify(result),config=result.config;
 const audit=await createAxialAnimationAudit(config,{frameCount:3,maxAngles:72}),before=JSON.stringify(audit),expanded=SSPZAngles.animation(audit);
 assert.equal(SSPZAngles.animation(expanded),expanded,'cache adapter idempotent');
 compare(audit.total,expanded.total,config);
 for(let i=0;i<audit.frames.length;i++)for(const key of ['instant','accumulated'])compare(audit.frames[i][key],expanded.frames[i][key],config);
 const weights=SSPZAngles.weightAudit(result);
 if(weights){
  compare(result.weightAudit.pairedSamples,weights.samples,config);
  near(weights.samples.reduce((s,p)=>s+p.weight*p.acquiredValue*weights.angularMeanFactor,0),result.weightAudit.centerValue,'exported weights reproduce the unchanged response');
  responseChecks++;
 }
 assert.equal(JSON.stringify(audit),before);assert.equal(JSON.stringify(result),snapshot);
}
console.log(JSON.stringify({status:'PASS',independentDirections:checkedDirections,cases:cases.length,responseChecks,checks:'full-turn candidates; coordinate/weight oracle; accumulated marker merging; angular mean; immutable SSP; cache idempotency'}));
