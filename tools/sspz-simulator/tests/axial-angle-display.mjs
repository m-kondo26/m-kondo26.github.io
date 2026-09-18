// Paired trajectory identity, visible solid/dashed encoding and angle table.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../axial-angle-display.js';
import {computeAxialResponse} from '../axial-response-core.js';
import {createAxialAnimationAudit,axialAnimationGroups} from '../axial-animation-core.js';
import {cbaCoordinates} from '../cba-core.js';
const near=(a,b,label)=>assert.ok(Math.abs(a-b)<2e-10,`${label}: ${a} != ${b}`);
const ui=fs.readFileSync(new URL('../axial-animation-ui.js',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const helper=name=>{const i=app.indexOf(`function ${name}(`),j=app.indexOf('\nfunction ',i+1);return app.slice(i,j);};
let scene,points=0;
const context=vm.createContext({axialAnimationGroups,SSPZAngles,fdkText:(_,en)=>en,
  rowColor:()=> '#0072b2',document:{createElement:()=>({dataset:{}})},drawDiagram:(_,s)=>scene=s});
vm.runInContext(['symmetricNiceAxis','niceNearestStep','fixedFormatterForTicks','stepFromTicks','decimalPlacesForStep','drawCandidateTrace'].map(helper).join('\n')+'\n'+ui,context);
const configs=[
 ...['merged','rri','parallel'].flatMap(axialRule=>[1,5].map(axialAverageMm=>({axialRule,axialAverageMm}))),
 {radius:0,axialAverageMm:5},
 {rows:80,rowWidth:.5,beamPitch:.5,radius:250,axialAverageMm:1},
 {rows:160,rowWidth:.5,beamPitch:.5,radius:250,axialAverageMm:5},
 {zFfsEnabled:true,zFfsSourceOffsetMm:.25,axialAverageMm:5},
];
for(const extra of configs){
 const result=await computeAxialResponse({rows:4,rowWidth:1,beamPitch:.875,radius:102,phase:.37,state:.45,viewSamples:180,zStep:.1,zExtent:8,phaseCount:1,axialRule:'rri',...extra});
 const before=JSON.stringify(result),c=result.config;
 const audit=await createAxialAnimationAudit(c,{frameCount:3,maxAngles:36}),snapshot=JSON.stringify(audit);
 {
  context.audit=audit;
  vm.runInContext('axialMovieBackground(audit);',context);
  assert(!scene.roleMarkersOnly,'Legend must show both line styles');
  assert.equal(scene.traceFamilies.length,(c.zFfsEnabled?2:1)*2);
  for(const trace of scene.traceFamilies){
   let dash=[],strokeDash=null,segments=0;
   const recorder={save(){},restore(){},setLineDash(d){dash=Array.from(d);},beginPath(){},moveTo(){},lineTo(){segments++;},stroke(){strokeDash=dash;}};
   context.drawCandidateTrace(recorder,scene,trace,0,0,x=>x,y=>y,100);
   assert(segments>0,'A trace is actually painted');
   assert.equal(strokeDash.length>0,trace.family==='complementary','Complementary paths must be dashed; direct paths solid');
  }
  for(const frame of audit.frames)for(const p of frame.instant){
   const view=p.referenceView,offset=SSPZAngles.offset(c,audit.base,view);
   const pair=SSPZAngles.pair(c,audit.base,p.referenceView),q=pair[p.direction];
   near(pair[1].theta-pair[0].theta,Math.PI,'rebinned opposing angles');
   near(q.beta,q.theta+q.gamma,'source/fan convention');
   if(c.axialRule!=='parallel')near(q.beta,cbaCoordinates(c,q.theta,c.radius,0,0).beta,'source-angle formula independently checked');
   near(offset,q.referenceOffset,'selected plot offset');
   if(p.direction)near((q.ownOffset-q.referenceOffset+360)%360,180,'opposing marker moves half a turn');
   const relative=((view-audit.base)%c.viewSamples+c.viewSamples)%c.viewSamples;
   const turn=Math.floor((view-audit.base)/c.viewSamples);
   const family=p.direction*(c.zFfsEnabled?2:1)+p.focus;
   const t=scene.traceFamilies[family];
   near(t.axial[relative]+turn*c.feed+t.scales[relative]*(p.row-(c.rows-1)/2)*c.rowWidth-audit.zObject,p.z,'own physical trajectory at displayed angle');
   points++;
  }
 }
 assert.equal(JSON.stringify(audit),snapshot,'display preserves identity and coefficients');
 assert.equal(JSON.stringify(result),before,'display preserves computed SSP and widths');
}
console.log(JSON.stringify({status:'PASS',cases:configs.length,points,scope:'both trajectory families and solid/dashed drawing, fan/source mapping, immutable weights and profiles'}));
