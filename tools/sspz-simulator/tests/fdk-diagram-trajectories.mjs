// Background geometry must reach the plot boundary, independently of the
// selected centre-voxel weights. Reconstruction and marker identities stay fixed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {reconstructCba,reconstructRri,cbaCoordinates} from '../cba-core.js';
import {reconstructFdk,fdkRowPosition} from '../fdk-core.js';

const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const workflow=fs.readFileSync(new URL('../fdk-workflow.js',import.meta.url),'utf8');
const fn=name=>{
  const start=app.indexOf(`function ${name}(`),end=app.indexOf('\nfunction ',start+1);
  assert.ok(start>=0);return app.slice(start,end<0?app.length:end);
};
const helpers=['symmetricNiceAxis','niceNearestStep','fixedFormatterForTicks','stepFromTicks','decimalPlacesForStep'].map(fn).join('\n');
const source=workflow.slice(workflow.indexOf('function drawFdkCandidateDiagram('),workflow.indexOf('function fdkArrow('));
let scene;
const context=vm.createContext({fdkText:(_,en)=>en,selectedStateIndex:0,drawDiagram:(_,s)=>{scene=s;}});
vm.runInContext(helpers+'\n'+source,context);
const near=(a,b,label)=>assert.ok(Math.abs(a-b)<2e-11,`${label}: ${a} != ${b}`);
const plain=v=>JSON.parse(JSON.stringify(v));
let cases=0,markers=0;
for(const spec of [
  {method:'cba',rows:4,axialAverageMm:0},
  {method:'rri',rows:4,axialAverageMm:1,phase:1.13,state:.45,radius:250,objectModel:'point'},
  {method:'rri',rows:160,rowWidth:.5,beamPitch:.5,axialAverageMm:5,objectModel:'point'},
  {method:'cba',rows:4,axialAverageMm:1},
  {method:'cba',rows:4,axialAverageMm:5},
  {method:'cba',rows:4,axialAverageMm:1,phase:1.13,state:.45,radius:250},
  {method:'cba',rows:80,rowWidth:.5,beamPitch:.5,axialAverageMm:1},
  {method:'fdk',rows:80,rowWidth:.5,beamPitch:.5,axialAverageMm:1,phase:.73,state:.4},
]){
  const r=await (spec.method==='rri'?reconstructRri:spec.method==='cba'?reconstructCba:reconstructFdk)({rows:4,rowWidth:1,beamPitch:.875,radius:102,viewSamples:180,xySamples:5,zExtent:4,zStep:.2,apertureSamples:2,...spec});
  const before=JSON.stringify(r),c=r.config,N=c.viewSamples,base=Math.ceil(((2*Math.PI*r.zObject/c.feed)-Math.PI)/(2*Math.PI/N)-1e-12);
  for(const zoom of [false,true])for(const reference of (r.reference&&zoom?[false,true]:[false])){
    const canvas={width:900,dataset:{}};
    context.drawFdkCandidateDiagram(canvas,r,zoom,reference);
    const s=plain(scene),g=s.traceGeometry,t=s.traceFamilies[0];
    assert.equal(t.angles[0],0);assert.equal(t.angles.at(-1),360);
    assert.equal(t.angles.length,N+1);
    assert.ok(t.angles.every((a,i)=>i===0||a>t.angles[i-1]),'no folded jumps inside a turn');
    const limit=context.symmetricNiceAxis(zoom?s.zoomXLimit:s.overviewXLimit,3).xMax;
    // Independently evaluate physical/rebinned coordinates for multiple turns,
    // including turns outside the selected weight support.
    for(let turn=-4;turn<=4;turn++)for(let row=0;row<s.totalRows;row++)for(let i=0;i<=N;i+=15){
      const v=base+i+turn*N,angle=c.phase+v*2*Math.PI/N;
      let expected;
      if(r.coordinateSystem==='rebinned-theta'){
        const q=cbaCoordinates(c,angle,c.radius,0,r.zObject);
        expected=q.sourceZ+(row-(c.rows-1)/2)*c.rowWidth*q.L/c.sourceRadius-r.zObject;
      }else if(!zoom)expected=fdkRowPosition(c,angle,row)-r.zObject;
      else expected=c.feed*v/N+(1-c.radius*Math.cos(angle)/c.sourceRadius)*g.rowOffsets[row]-r.zObject;
      near(t.axial[i]+turn*c.feed+t.scales[i]*g.rowOffsets[row]-r.zObject,expected,'row coordinate');
      if(Math.abs(expected)<limit-1e-10)assert.ok(g.turns.includes(turn),'every visible turn must be retained');
    }
    for(const p of s.weightedPoints){
      const q=r.weightAudit.samples.find(q=>q.view===p.absoluteViewIndex&&q.row-(r.coordinateSystem==='rebinned-theta'?0:Math.min(...r.weightAudit.samples.map(q=>q.row))-2)===p.row);
      assert.ok(q,'marker keeps acquired sample identity');
      assert.equal(p.x,q.z);assert.equal(p.weight,reference?q.referenceWeight:q.weight);
      const i=((q.view-base)%N+N)%N,turn=Math.floor((q.view-base)/N);
      near(t.axial[i]+turn*c.feed+t.scales[i]*g.rowOffsets[p.row]-r.zObject,p.x,'marker on its geometric trajectory');
      markers++;
    }
    assert.equal(canvas.dataset.backgroundTraceScope,'geometric-context-independent-of-selected-weight-support');
    cases++;
  }
  assert.equal(JSON.stringify(r),before,'rendering must not mutate profiles or weights');
}
console.log(JSON.stringify({status:'PASS',scenes:cases,markers,checks:'complete turns; independently checked geometry and visible-turn coverage; unchanged selected weights and reconstruction input'}));
