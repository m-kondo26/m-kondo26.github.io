import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../geometry-construction.js';
import '../axial-angle-display.js';
import {computeAxialResponse} from '../axial-response-core.js';
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const workflow=fs.readFileSync(new URL('../fdk-workflow.js',import.meta.url),'utf8');
const helper=name=>{const i=app.indexOf(`function ${name}(`),j=app.indexOf('\nfunction ',i+1);return app.slice(i,j);};
const ctx=vm.createContext({SSPZAngles,fdkText:(_,en)=>en,selectedStateIndex:0});
vm.runInContext(['symmetricNiceAxis','niceNearestStep','fixedFormatterForTicks','stepFromTicks','decimalPlacesForStep'].map(helper).join('\n')+'\n'+workflow.slice(workflow.indexOf('function drawFdkCandidateDiagram('),workflow.indexOf('function fdkArrow(')),ctx);
let checks=0;
for(const spec of [{rows:1},{rows:4},{rows:4,phase:.81},{rows:80,rowWidth:.5,beamPitch:.5},{rows:4,zFfsEnabled:true}]){
 const r=await computeAxialResponse({rows:4,rowWidth:1,beamPitch:.875,radius:102,viewSamples:180,zStep:.1,zExtent:8,phase:0,axialRule:'merged',axialAverageMm:5,...spec});
 const before=JSON.stringify(r),scene=ctx.drawFdkCandidateDiagram({width:900,dataset:{}},r,false,false,'all',true),limit=ctx.symmetricNiceAxis(scene.overviewXLimit,3).xMax;
 const w=SSPZConstruction.window(scene,limit),anchor=scene.traceFamilies[0].sourceAngles[0];
 assert.ok(w.end>w.start);
 assert.ok(Math.abs((w.start-anchor)/(2*Math.PI)-Math.round((w.start-anchor)/(2*Math.PI)))<1e-10,'begin at plot zero modulo a full turn');
 for(const trace of scene.traceFamilies)for(const turn of scene.traceGeometry.turns){
  let previous=0;
  for(const fraction of [0,.1,.25,.5,.75,.9,1]){
   const cutoff=w.start+fraction*(w.end-w.start),p=SSPZConstruction.prefix(trace,turn,cutoff);
   assert.ok(p.angles.length>=previous,'prefix never shrinks during drawing');previous=p.angles.length;
   if(p.angles.length)assert.ok(p.sourceAngles.at(-1)+turn*2*Math.PI<=cutoff+1e-10,'no future acquired angle is shown');
   for(let i=0;i<p.angles.length;i++)for(const offset of scene.traceGeometry.rowOffsets){
    const x=p.axial[i]+turn*scene.traceGeometry.feed+p.scales[i]*offset-scene.z0;
    if(fraction===0)assert.ok(Math.abs(x)>=limit-1e-8,'empty starting frame inside plot');
   }
  }
  // All visible native vertices must be included at the final source angle.
  const p=SSPZConstruction.prefix(trace,turn,w.end);
  for(let i=0;i<trace.angles.length;i++)for(const offset of scene.traceGeometry.rowOffsets){
   const x=trace.axial[i]+turn*scene.traceGeometry.feed+trace.scales[i]*offset-scene.z0;
   if(Math.abs(x)<limit)assert.ok(i<p.angles.length,'all visible trajectory data covered');
  }
 }
 const direct=scene.traceFamilies.find(t=>t.family==='direct'),opposed=scene.traceFamilies.find(t=>t.family==='complementary');
 for(let i=90;i<180;i+=7){
  const j=i-90,cut=direct.sourceAngles[i];
  assert.ok(Math.abs(opposed.sourceAngles[j]-cut)<1e-12,'same acquired datum has one drawing time');
  assert.ok(Math.abs(direct.axial[i]-opposed.axial[j])<1e-12);
  assert.ok(Math.abs(direct.scales[i]-opposed.scales[j])<1e-12);
  const a=SSPZConstruction.prefix(direct,0,cut),b=SSPZConstruction.prefix(opposed,0,cut);
  assert.ok(Math.abs(a.sourceAngles.at(-1)-b.sourceAngles.at(-1))<1e-12);
 }
 assert.equal(SSPZConstruction.role(scene,'all',null).construction,null,'complete frame uses original painter');
 assert.equal(JSON.stringify(r),before,'construction must not mutate numerical data');checks++;
}
console.log(JSON.stringify({status:'PASS',cases:checks,checks:'plot-zero start, accumulated source-angle prefixes, matched direct/opposing timing, complete visible support, unchanged response'}));
