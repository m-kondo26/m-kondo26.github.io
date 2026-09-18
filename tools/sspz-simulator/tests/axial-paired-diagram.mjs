// Full-direction display preserves the angular-averaged physical coefficients.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../axial-angle-display.js';
import {computeAxialResponse} from '../axial-response-core.js';
import {cbaCoordinates} from '../cba-core.js';
const near=(a,b,label)=>assert.ok(Math.abs(a-b)<2e-10,`${label}: ${a} != ${b}`);
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const workflow=fs.readFileSync(new URL('../fdk-workflow.js',import.meta.url),'utf8');
const helper=name=>{const i=app.indexOf(`function ${name}(`),j=app.indexOf('\nfunction ',i+1);assert.ok(i>=0);return app.slice(i,j);};
let scene;
const context=vm.createContext({SSPZAngles,fdkText:(_,en)=>en,selectedStateIndex:0,drawDiagram:(_,s)=>scene=s});
vm.runInContext(['symmetricNiceAxis','niceNearestStep','fixedFormatterForTicks','stepFromTicks','decimalPlacesForStep'].map(helper).join('\n')+'\n'+workflow.slice(workflow.indexOf('function drawFdkCandidateDiagram('),workflow.indexOf('function fdkArrow(')),context);
let scenes=0,markers=0;
const configs=[
 ...['merged','rri','parallel'].flatMap(axialRule=>[0,1,5].map(T=>({axialRule,axialAverageMm:T,radius:T===0?0:100}))),
 {axialRule:'merged',axialAverageMm:5,radius:100,viewSamples:2400,zStep:.05,phase:0},
 ...[4,80,160,320].map(rows=>({rows,rowWidth:rows===4?1:.5,beamPitch:rows===4?.875:.5,axialRule:'rri',axialAverageMm:5,radius:250,phase:1.13,state:.45})),
 {axialRule:'merged',axialAverageMm:1,radius:0,channelApertureMm:.1},
];
for(const config of configs){
 const r=await computeAxialResponse({rows:4,rowWidth:1,beamPitch:.875,radius:100,viewSamples:180,zStep:.1,zExtent:8,phaseCount:1,...config});
 const before=JSON.stringify(r),c=r.config,a=r.weightAudit,V=c.viewSamples;
 const directional=SSPZAngles.expand(a.pairedSamples,c);
 const directionalMap=new Map(directional.map(q=>[`${q.referenceView}:${q.view}:${q.row}`,q]));
 const base=Math.ceil((2*Math.PI*r.zObject/c.feed-Math.PI)/(2*Math.PI/V)-1e-12);
 const accumulated=new Map();
 for(const p of a.pairedSamples){
  near(((p.view-p.referenceView-p.direction*V/2)%V+V)%V,0,'direction family modulo full turn');
  const key=p.view+':'+p.row;
  accumulated.set(key,(accumulated.get(key)??0)+p.weight);
 }
 assert.equal(accumulated.size,a.samples.length);
 for(const p of a.samples)near(accumulated.get(p.view+':'+p.row),p.weight,'partition matches original weight');
 near(a.pairedSamples.reduce((s,p)=>s+p.weight*p.acquiredValue*a.db,0),a.centerValue,'partition reproduces central response');
 for(const zoom of [false,true]){
  const canvas={width:900,dataset:{}};
  context.drawFdkCandidateDiagram(canvas,r,zoom);
  const s=scene,g=s.traceGeometry;
  assert.equal(s.traceFamilies.length,2);
  assert.equal(s.traceFamilies[1].family,'complementary');
  assert.equal(canvas.dataset.complementaryLineStyle,'dashed');
  assert.equal(canvas.dataset.complementaryMarkerShape,'triangle');
  const limit=context.symmetricNiceAxis(zoom?s.zoomXLimit:s.overviewXLimit,3).xMax;
  for(const [direction,t] of s.traceFamilies.entries()){
   assert.equal(t.angles.length,V+1);assert.equal(t.angles[0],0);assert.equal(t.angles.at(-1),360);
   for(let turn=-4;turn<=4;turn++)for(const row of [0,c.rows-1])for(let i=0;i<=V;i+=V/12){
    const v=base+i+turn*V+direction*V/2,theta=c.phase+v*2*Math.PI/V;
    const q=c.axialRule==='parallel'?{sourceZ:c.feed*v/V,L:c.sourceRadius}:cbaCoordinates(c,theta,c.radius,0,0);
    const expected=q.sourceZ+(row-(c.rows-1)/2)*c.rowWidth*q.L/c.sourceRadius-r.zObject;
    near(t.axial[i]+turn*c.feed+t.scales[i]*g.rowOffsets[row]-r.zObject,expected,'independent direction-specific coordinate');
    if(Math.abs(expected)<limit-1e-10)assert.ok(g.turns.includes(turn),'retain complete visible turns for both directions');
   }
  }
  for(const p of s.weightedPoints){
   const q=directionalMap.get(`${p.referenceViewIndex}:${p.absoluteViewIndex}:${p.row}`);
   assert.ok(q);assert.equal(q.weight,p.weight);assert.equal(q.z,p.x);
   assert.equal(p.traceFamilyId,q.direction?'complementary-rebinned':'acquired');
   const i=((q.referenceView-base)%V+V)%V,turn=Math.round((q.view-base-i-q.direction*V/2)/V),t=s.traceFamilies[q.direction];
   near(p.y,i*360/V,'common reference angle');
   near(t.axial[i]+turn*c.feed+t.scales[i]*g.rowOffsets[p.row]-r.zObject,p.x,'marker on its own direction trajectory');
   markers++;
  }
  if(zoom&&r.config.axialAverageMm>=1)assert.ok(s.weightedPoints.some(p=>p.traceFamilyId==='complementary-rebinned'));
  scenes++;
 }
 assert.equal(JSON.stringify(r),before,'drawing does not mutate results');
}
console.log(JSON.stringify({status:'PASS',cases:configs.length,scenes,markers,checks:'direction-specific ray coordinates; common-reference markers; full visible turns; weight partition and response closure; no render mutations'}));
