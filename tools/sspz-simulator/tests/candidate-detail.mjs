// Detail windows must partition the full audit, preserving every coefficient
// and datum identity. No synthetic candidates or interpolated weights.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../axial-angle-display.js';
import {computeAxialResponse} from '../axial-response-core.js';

const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const workflow=fs.readFileSync(new URL('../fdk-workflow.js',import.meta.url),'utf8');
const helper=name=>{const i=app.indexOf(`function ${name}(`),j=app.indexOf('\nfunction ',i+1);assert.ok(i>=0);return app.slice(i,j);};
let range=null;
const context=vm.createContext({SSPZAngles,fdkText:(_,en)=>en,selectedStateIndex:0,candidateDisplayRange:()=>range});
vm.runInContext(['symmetricNiceAxis','niceNearestStep','fixedFormatterForTicks','stepFromTicks','decimalPlacesForStep'].map(helper).join('\n')+'\n'+workflow.slice(workflow.indexOf('function drawFdkCandidateDiagram('),workflow.indexOf('function fdkArrow(')),context);
const key=p=>`${p.referenceViewIndex}:${p.absoluteViewIndex}:${p.focus}:${p.row}`;
let checked=0;
for(const spec of [{rows:64},{rows:320},{rows:80,axialRule:'rri'},{rows:4,rowWidth:1,beamPitch:.875,viewSamples:1440}]){
  const r=await computeAxialResponse({rows:64,rowWidth:.5,beamPitch:.5,R:600,radius:102,sourceRadius:600,viewSamples:720,zStep:.1,zExtent:4,axialAverageMm:1,phaseCount:1,phase:.3,axialRule:'merged',...spec});
  const unchanged=JSON.stringify(r),V=r.config.viewSamples;
  const original=SSPZAngles.expand(r.weightAudit.pairedSamples,r.config),expected=new Map(original.map(p=>[`${p.referenceView}:${p.view}:${p.focus??0}:${p.row}`,p]));
  const union=new Map();
  for(let min=0;min<360;min+=30){
    range={min,max:min+30};
    const scene=context.drawFdkCandidateDiagram({width:900,dataset:{}},r,true,false,'all',true);
    assert.equal(scene.angleMin,min);assert.equal(scene.angleMax,min+30);
    assert.equal(new Set(scene.weightedPoints.map(p=>p.y)).size,V/12);
    for(const p of scene.weightedPoints){
      assert.ok(p.y>=min-1e-9&&p.y<min+30-1e-9);
      const id=key(p),q=expected.get(id);assert.ok(q);assert.equal(p.weight,q.weight);assert.equal(p.x,q.z);
      assert.ok(!union.has(id),'each datum/direction appears in exactly one detail window');union.set(id,p);checked++;
    }
    const overview=context.drawFdkCandidateDiagram({width:900,dataset:{}},r,false,false,'all',true);
    assert.equal(overview.angleMin,undefined,'overview stays full-turn');
    for(const role of ['direct','complementary']){
      const split=context.drawFdkCandidateDiagram({width:900,dataset:{}},r,true,false,role,true);
      assert.ok(split.weightedPoints.every(p=>p.traceFamilyId.startsWith('complementary-')===(role==='complementary')));
    }
  }
  assert.equal(union.size,expected.size);
  range=null;
  const standard=context.drawFdkCandidateDiagram({width:900,dataset:{}},r,true,false,'all',true);
  assert.ok(new Set(standard.weightedPoints.map(p=>p.y)).size<=72);
  assert.ok(standard.weightedPoints.every(p=>union.has(key(p))));
  assert.equal(JSON.stringify(r),unchanged,'display does not modify SSP/audit');
}
console.log(`PASS candidate-detail: ${checked} exact weighted points partitioned across 12 windows; all rows/roles preserved, overview and SSP unchanged`);
