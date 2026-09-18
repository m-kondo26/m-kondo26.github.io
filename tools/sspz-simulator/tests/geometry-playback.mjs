// Role views must partition the original display without changing weights,
// physical identity, coordinate extents, or response data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../axial-angle-display.js';
import {computeAxialResponse} from '../axial-response-core.js';
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const workflow=fs.readFileSync(new URL('../fdk-workflow.js',import.meta.url),'utf8');
const helper=name=>{const i=app.indexOf(`function ${name}(`),j=app.indexOf('\nfunction ',i+1);return app.slice(i,j);};
let scene;const ctx=vm.createContext({SSPZAngles,fdkText:(_,en)=>en,selectedStateIndex:0,drawDiagram:(_,s)=>scene=s});
vm.runInContext(['symmetricNiceAxis','niceNearestStep','fixedFormatterForTicks','stepFromTicks','decimalPlacesForStep','mergeDiagramMarkers'].map(helper).join('\n')+'\n'+workflow.slice(workflow.indexOf('function drawFdkCandidateDiagram('),workflow.indexOf('function fdkArrow(')),ctx);
const plain=x=>JSON.parse(JSON.stringify(x));
let count=0;
for(const extra of [{rows:1,axialAverageMm:1},{rows:4,axialAverageMm:5},{rows:80,rowWidth:.5,beamPitch:.5,axialAverageMm:1},{rows:4,axialAverageMm:1,zFfsEnabled:true,zFfsOffset:.25,zFfsMagnification:1072/600}]){
  const r=await computeAxialResponse({rows:4,rowWidth:1,beamPitch:.875,radius:102,viewSamples:180,zStep:.1,zExtent:8,phase:.83,axialRule:'merged',...extra});
  const before=JSON.stringify(r);
  for(const zoom of [false,true]){
    const scenes={};for(const role of ['direct','complementary','all']){
      ctx.drawFdkCandidateDiagram({width:900,dataset:{}},r,zoom,false,role);scenes[role]=plain(scene);
      ctx.mergeDiagramMarkers(scene.weightedPoints); // also checks focal identities
    }
    const {all,direct,complementary}=scenes;
    for(const one of [direct,complementary])for(const k of ['overviewXLimit','zoomXLimit','interpolationBandHalfWidth'])assert.equal(one[k],all[k]);
    const sort=x=>x.map(v=>JSON.stringify(v)).sort();
    assert.deepEqual(sort([...direct.weightedPoints,...complementary.weightedPoints]),sort(all.weightedPoints));
    assert.deepEqual(sort([...direct.traceFamilies,...complementary.traceFamilies]),sort(all.traceFamilies));
    assert.ok(direct.traceFamilies.every(t=>t.family==='direct'));
    assert.ok(complementary.traceFamilies.every(t=>t.family==='complementary'));
    if(zoom){assert.ok(direct.weightedPoints.length);assert.ok(complementary.weightedPoints.length);}
    // Every marker remains on the matching row, role, focus and turn trajectory.
    for(const p of all.weightedPoints){
      const t=all.traceFamilies.find(t=>t.id===p.traceFamilyId),i=Math.round(p.y/360*r.config.viewSamples);
      const z=t.axial[i]+t.scales[i]*all.traceGeometry.rowOffsets[p.row]-r.zObject;
      const turns=(p.x-z)/r.config.feed;
      assert.ok(Math.abs(turns-Math.round(turns))<1e-9,JSON.stringify({extra,p,z,turns}));
    }
    count++;
  }
  assert.equal(JSON.stringify(r),before,'display must not mutate calculated results');
}
console.log(JSON.stringify({status:'PASS',cases:count,checks:'role union, exact weight preservation, shared axes, focal identity and trajectory, immutable response'}));
