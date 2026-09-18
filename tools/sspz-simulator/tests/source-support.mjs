import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {sourceOracle} from './source-support-oracle.mjs';
import {axialResponseConfig,computeAxialResponse} from '../axial-response-core.js';
import {sourceSupportedAxialWeights,axialSourceWindow} from '../axial-source-support.js';
import {sourceAxialGroups} from '../axial-source-response.js';
import {cbaRebinAt} from '../cba-core.js';
import {detectorPointProjection} from '../detector-aperture.js';
import {zffsPointProjection} from '../zffs-response.js';
import {zffsRebinStencil} from '../zffs-geometry.js';
const near=(a,b,t=2e-9)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
const base={rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,radius:250,viewSamples:360,phase:0,zExtent:8,zStep:.1,axialAverageMm:5};
let checks=0,unsupported=0;
for(const rows of [1,4,80,160,320])for(const axialRule of ['merged','rri','parallel'])for(const zFfsEnabled of [false,true]){
 if(axialRule==='parallel'&&zFfsEnabled)continue;
 for(const beamPitch of [.5,.875,3]){
  const c=axialResponseConfig({...base,rows,rowWidth:rows<=4?1:.5,axialRule,zFfsEnabled,beamPitch,phase:.31});
  for(const z of [-2.5,-.5,0,2.5])for(const v of [-180,-127,-30,-1]){
   let expected;try{expected=sourceOracle(c,v,z);}catch{
    assert.throws(()=>sourceSupportedAxialWeights(c,sourceAxialGroups(c,v),z),/COVERAGE/);unsupported++;continue;
   }
   const got=sourceSupportedAxialWeights(c,sourceAxialGroups(c,v),z);
   near(got.reduce((s,p)=>s+p.weight,0),1);
   assert.equal(got.filter(p=>p.weight>1e-12).length,expected.length);
   for(const p of expected){const q=got.find(q=>q.view===p.view&&q.row===p.row&&q.focus===p.focus&&q.direction===p.direction);assert(q);near(q.weight,p.weight);near(q.z,p.z);}
   if(axialRule!=='rri')near(got.reduce((s,p)=>s+p.weight*p.z,0),z);
   checks++;
  }
 }
}
// Exact user-reported near datum, previously removed by theta [-231,129).
const c=axialResponseConfig(base),points=sourceSupportedAxialWeights(c,sourceAxialGroups(c,-30),-.5);
const recovered=points.find(p=>p.view===150&&p.row===0);assert(recovered);
near(recovered.z,-.6669261659089627);near(recovered.weight,.09061457141365137);
const beta=(150+Math.asin(-250*Math.sin(150*Math.PI/180)/600)*180/Math.PI);
near(beta,137.97530081943418);
// Shared candidate support; independent acquired-data readout reconstructs raw response.
for(const axialRule of ['merged','rri'])for(const zFfsEnabled of [false,true]){
 const r=await computeAxialResponse({...base,axialRule,zFfsEnabled,axialAverageMm:0,zExtent:4,viewSamples:180,phase:.37}),c=r.config,H=c.viewSamples/2,db=2*Math.PI/c.viewSamples;
 for(const i of [35,40,44]){
  const z=r.z[i];let sum=0;
  for(let v=-H;v<0;v++)for(const q of sourceOracle(c,v,z)){
   let value=0;
   if(zFfsEnabled)for(const s of zffsRebinStencil(c,q.theta,q.focus).stencil)value+=s.weight*(zffsPointProjection(c,s.view,0).data.get(q.row+':'+s.channel)??0);
   else value=cbaRebinAt(c,v=>detectorPointProjection({...c,sourceZ:c.feed*v/c.viewSamples},c.phase+v*db,0),q.theta,-c.radius*Math.sin(q.theta),q.row);
   sum+=q.weight*value/H;
  }
  near(sum,r.raw[i]);checks++;
 }
}
const single=[];
for(const radius of [0,102,250])for(const phase of [0,Math.PI/2]){
 const r=await computeAxialResponse({...base,rows:1,radius,phase,axialAverageMm:1,zExtent:4});assert(r.fwhm.width>0);single.push({radius,phase,fwhm:r.fwhm.width});
}
const comparisons=[];
for(const radius of [0,102,250])for(const axialAverageMm of [1,5]){
 const input={...base,radius,axialAverageMm};
 const a=await computeAxialResponse({...input,candidateSearch:'one-turn'}),b=await computeAxialResponse(input);
 comparisons.push({radius,T:axialAverageMm,oldFwhm:a.fwhm.width,newFwhm:b.fwhm.width,maxProfileChange:Math.max(...a.profile.map((v,i)=>Math.abs(v-b.profile[i])))});
}
assert.throws(()=>axialResponseConfig({...base,fullFanAngleDeg:10}),/AXIAL_FAN/);
const wide=axialResponseConfig({...base,fullFanAngleDeg:80});near((axialSourceWindow(wide,0).betaMax-axialSourceWindow(wide,0).betaMin)*180/Math.PI,520);
writeFileSync(new URL('source-support-verification.json',import.meta.url),JSON.stringify({version:'2026-09-18.7',checks,unsupported,recovered,sourceBetaDeg:beta,window:axialSourceWindow(c,-.5),single,comparisons,scope:'Finite acquisition-model and implementation checks; not scanner validation'},null,2));
console.log(JSON.stringify({status:'PASS',checks,unsupported,recovered,single,comparisons}));
