import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {axialResponseConfig,axialPairWeights,computeAxialResponse} from '../axial-response-core.js';
import {sourceSupportedAxialWeights,axialSourceWindow} from '../axial-source-support.js';
import {sourceAxialGroups} from '../axial-source-response.js';
import {sourceOracle} from './source-support-oracle.mjs';
const near=(a,b,t=1e-10)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
const base={rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,radius:102,viewSamples:360,phase:.37,zExtent:8,zStep:.1,axialAverageMm:1,channelWidth:.58,channelApertureMm:.58,focalSizeMm:1.2,focalSourceDetectorMm:1070};
let checks=0;
assert.equal(axialResponseConfig(base).axialRule,'rri');
for(const rows of [1,4,80,160,320])for(const radius of [0,102,250])for(const phase of [0,.37])for(const z of [-2.5,0,2.5]){
 const cone=axialResponseConfig({...base,rows,radius,phase,axialRule:'rri'}),parallel=axialResponseConfig({...base,rows,radius,phase,axialRule:'parallel'});
 assert.equal(parallel.interpolationRule,'rri');assert.equal(cone.interpolationRule,'rri');
 assert.deepEqual(axialSourceWindow(cone,z),axialSourceWindow(parallel,z));
 near((axialSourceWindow(cone,z).betaMax-axialSourceWindow(cone,z).betaMin)*180/Math.PI,460);
 for(const c of [cone,parallel])for(const view of [-180,-127,-30,-1]){
  let expected;try{expected=sourceOracle(c,view,z);}catch{assert.throws(()=>sourceSupportedAxialWeights(c,sourceAxialGroups(c,view),z),/COVERAGE/);continue;}
  const got=sourceSupportedAxialWeights(c,sourceAxialGroups(c,view),z).filter(q=>q.weight>1e-12);
  assert.equal(got.length,expected.length);near(got.reduce((s,q)=>s+q.weight,0),1);
  for(const q of expected){const a=got.find(v=>v.view===q.view&&v.row===q.row&&v.direction===q.direction);assert(a);near(a.z,q.z);near(a.weight,q.weight);}
  if(radius===0){const peer=c.axialRule==='rri'?parallel:cone,other=sourceSupportedAxialWeights(peer,sourceAxialGroups(peer,view),z);for(const a of got){const b=other.find(v=>v.view===a.view&&v.row===a.row&&v.direction===a.direction);assert(b);near(a.z,b.z);near(a.weight,b.weight);}}
  checks++;
 }
}
// A four-point example independently distinguishes row interpolation from
// selecting only the nearest two positions. Positions are exact input data.
const c=axialResponseConfig({...base,rows:2,axialRule:'parallel'});
const w=axialPairWeights(c,{sourceZ:-.3,spacing:1},{sourceZ:.2,spacing:1},0);
assert.equal(w.length,4);for(const [i,x] of [.1,.4,.35,.15].entries())near(w[i].weight,x);
// Parallel candidate lattice does not depend on radial position.
for(const r of [0,250]){
 const x=axialResponseConfig({...base,radius:r,axialRule:'parallel'}),y=axialResponseConfig({...base,radius:102,axialRule:'parallel'});
 assert.deepEqual(sourceSupportedAxialWeights(x,sourceAxialGroups(x,-57),.2),sourceSupportedAxialWeights(y,sourceAxialGroups(y,-57),.2));
}
const profiles=[];
for(const axialRule of ['rri','parallel'])for(const T of [1,5]){
 const result=await computeAxialResponse({...base,axialRule,axialAverageMm:T});
 assert.equal(result.model.sourceAngleSpanDeg,460);assert.equal(result.model.interpolationRule,'rri');
 const audit=result.weightAudit;near(audit.samples.reduce((s,q)=>s+q.weight*q.acquiredValue*audit.db,0),audit.centerValue,1e-9);
 profiles.push({axialRule,T,FWHM:result.fwhm.width,version:result.model.version});
}
writeFileSync(new URL('matched-geometry-verification.json',import.meta.url),JSON.stringify({checks,profiles,scope:'Matched declared support and row weights, independent exhaustive oracle, centre lattice and trace closure. Not scanner validation.'},null,2));
console.log(JSON.stringify({status:'PASS',checks,profiles}));
