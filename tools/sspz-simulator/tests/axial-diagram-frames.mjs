import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../axial-angle-display.js';
import {computeAxialResponse,computeAxialResponseSeries,compactAxialDiagramFrame} from '../axial-response-core.js';

// Display-cache consistency, not scanner-model validation or convergence.
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const workflow=fs.readFileSync(new URL('../fdk-workflow.js',import.meta.url),'utf8');
const helper=name=>{const i=app.indexOf(`function ${name}(`),j=app.indexOf('\nfunction ',i+1);assert.ok(i>=0);return app.slice(i,j);};
const context=vm.createContext({SSPZAngles,fdkText:(_,en)=>en,selectedStateIndex:0});
vm.runInContext(['symmetricNiceAxis','niceNearestStep','fixedFormatterForTicks','stepFromTicks','decimalPlacesForStep'].map(helper).join('\n')+'\n'+workflow.slice(workflow.indexOf('function drawFdkCandidateDiagram('),workflow.indexOf('function fdkArrow(')),context);
const scene=(r,zoom,role)=>context.drawFdkCandidateDiagram({width:900,dataset:{}},r,zoom,false,role,true,{fullTurn:true});
const base={rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,radius:150,
  viewSamples:180,zExtent:4,zStep:.1,phaseCount:3,axialAverageMm:1,phase:.37,
  computationModel:'fdk',axialRule:'rri',comparisonMode:'matched-rri'};
let frames=0,scenes=0;
for(const overrides of [
  {radius:0},
  {axialAverageMm:5,state:.45},
  {zFfsEnabled:true,radius:102},
  {candidateSearch:'one-turn'},
  {viewSamples:2400,phaseCount:2,zStep:.2,axialAverageMm:0},
]){
  const params={...base,...overrides};
  const plain=await computeAxialResponseSeries(params);
  const captured=await computeAxialResponseSeries(params,{captureDiagramFrames:true});
  assert.deepEqual(captured.profiles.map(({diagramFrame,...p})=>p),plain.profiles);
  assert.deepEqual(captured.mean,plain.mean);
  assert.deepEqual(captured.meanDifference,plain.meanDifference);
  assert.deepEqual(captured.weightAudit,plain.weightAudit,'The first full audit is retained');
  assert.deepEqual(captured.domainCheck,plain.domainCheck);
  for(const p of captured.profiles){
    const direct=await computeAxialResponse({...captured.config,phase:p.phase},{lockDomain:true});
    const f=p.diagramFrame,all=SSPZAngles.expand(direct.weightAudit.pairedSamples,direct.config);
    const visible=all.filter(q=>((q.referenceView-f.displaySampling.base)%f.displaySampling.stride+f.displaySampling.stride)%f.displaySampling.stride===0);
    const compactExpanded=SSPZAngles.expand(f.weightAudit.pairedSamples,direct.config);
    const displayFields=q=>({referenceView:q.referenceView,direction:q.direction,view:q.view,row:q.row,focus:q.focus??0,z:q.z,weight:q.weight,
      oppositeViews:q.oppositeViews,sourcePairReferenceViews:q.sourcePairReferenceViews});
    assert.deepEqual(compactExpanded.map(displayFields),visible.map(displayFields),'Direct and reverse direction sampling are identical');
    assert.equal(f.extent.minView,Math.min(...all.map(q=>q.view)));
    assert.equal(f.extent.maxView,Math.max(...all.map(q=>q.view)));
    assert.equal(f.extent.maxAbsZ,Math.max(...all.map(q=>Math.abs(q.z))));
    assert.equal(f.displaySampling.allExpandedSamples,all.length);
    assert.equal(f.displaySampling.allPairedSamples,direct.weightAudit.pairedSamples.length);
    assert.ok(f.weightAudit.pairedSamples.length<direct.weightAudit.pairedSamples.length);
    assert.ok(f.weightAudit.pairedSamples.every(q=>!('acquiredValue' in q)&&!('theta' in q)&&!('beta' in q)));
    const cached={config:direct.config,zObject:f.zObject,coordinateSystem:f.coordinateSystem,weightAudit:f.weightAudit,diagramFrame:f};
    for(const zoom of [false,true])for(const role of ['all','direct','complementary']){
      assert.deepEqual(scene(cached,zoom,role),scene(direct,zoom,role),'Cached and direct complete scenes must agree');
      scenes++;
    }
    frames++;
  }
}

// Historical one-turn z-FFS has acquired-cell audits without paired roles.
const legacy=await computeAxialResponseSeries({...base,candidateSearch:'one-turn',zFfsEnabled:true,phaseCount:2},{captureDiagramFrames:true});
for(const p of legacy.profiles){
  const direct=await computeAxialResponse({...legacy.config,phase:p.phase},{lockDomain:true});
  assert.equal(p.diagramFrame.displaySampling.kind,'full-audit-fallback');
  assert.deepEqual(p.diagramFrame.weightAudit,direct.weightAudit);
  assert.deepEqual(p.diagramFrame.rebinnedWeightAudit,direct.rebinnedWeightAudit);
  assert.deepEqual(p.raw,direct.raw);frames++;
}

// Domain expansion restarts the full series and drops earlier short-grid frames.
const domainParams={...base,zExtent:1,axialAverageMm:5,phaseCount:4};
const domain=await computeAxialResponseSeries(domainParams,{captureDiagramFrames:true});
const domainPlain=await computeAxialResponseSeries(domainParams);
assert.ok(domain.domainCheck.expansions>0);
assert.deepEqual(domain.domainCheck,domainPlain.domainCheck);
assert.deepEqual(domain.profiles.map(({diagramFrame,...p})=>p),domainPlain.profiles);
for(const p of domain.profiles){
  const direct=await computeAxialResponse({...domain.config,phase:p.phase},{lockDomain:true});
  assert.equal(p.profile.length,domain.z.length);
  assert.deepEqual(p.diagramFrame,compactAxialDiagramFrame(direct));
}
await assert.rejects(()=>computeAxialResponseSeries(domainParams,{captureDiagramFrames:true,lockDomain:true}),e=>e.code==='AXIAL_DOMAIN_TAILS');
for(const stopAt of [.25,1]){
  let cancelled=false;
  await assert.rejects(()=>computeAxialResponseSeries({...base,phaseCount:4},{captureDiagramFrames:true,
    progress:value=>{if(value>=stopAt)cancelled=true;},cancelled:()=>cancelled}),/FDK_CANCELLED/);
}
const gap=await computeAxialResponseSeries({...base,radius:0,channelApertureMm:.1},{captureDiagramFrames:true});
assert.equal(gap.geometryOnly,true);assert.deepEqual(gap.profiles,[]);

// Run the actual 360-state contract on a small numerical fixture. One-degree
// start-angle steps are acquisition conditions, not extra acquired views.
const fullTurn=await computeAxialResponseSeries({...base,viewSamples:90,zExtent:2,zStep:.2,
  axialAverageMm:0,phaseCount:360},{captureDiagramFrames:true});
assert.equal(fullTurn.profiles.length,360);
assert.ok(fullTurn.profiles.every(p=>p.diagramFrame?.displaySampling.kind==='full-turn'));
for(const index of [0,89,179,359]){
  const p=fullTurn.profiles[index];
  assert.equal(p.phase,fullTurn.config.phase+2*Math.PI*index/360);
  const direct=await computeAxialResponse({...fullTurn.config,phase:p.phase},{lockDomain:true});
  assert.deepEqual(p.raw,direct.raw);assert.deepEqual(p.profile,direct.profile);
  assert.deepEqual(p.diagramFrame,compactAxialDiagramFrame(direct));
}

// The worker opts into caching but explicit inspection still returns full data.
const workerSource=fs.readFileSync(new URL('../worker.js',import.meta.url),'utf8').replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\r?$/gm,'');
const messages=[],self={postMessage:message=>messages.push(message)};
vm.runInNewContext(workerSource,{self,setTimeout,computeAxialResponse,computeAxialResponseSeries});
await self.onmessage({data:{type:'fdk-run',params:{...base,phaseCount:2}}});
const result=messages.find(m=>m.type==='fdk-result')?.result;
assert.ok(result?.profiles.every(p=>p.diagramFrame));
await self.onmessage({data:{type:'fdk-inspect',requestId:17,index:1}});
const inspection=messages.find(m=>m.type==='fdk-inspection');
assert.equal(inspection.requestId,17);
assert.deepEqual(inspection.result.profile,result.profiles[1].profile);
assert.ok(inspection.result.weightAudit.pairedSamples.length>result.profiles[1].diagramFrame.weightAudit.pairedSamples.length);
console.log(JSON.stringify({status:'PASS',frames,scenes,fullTurnFrames:fullTurn.profiles.length,checks:'bit-identical profiles/raw/metrics; same full-turn scenes and reversed pairs; full audit preservation; adaptive-domain retries; cancellation; geometry-only; worker full inspection'}));
