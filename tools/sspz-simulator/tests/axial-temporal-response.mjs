import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {computeAxialResponse,computeAxialResponseSeries} from '../axial-response-core.js';
import {sourceSupportedAxialWeights,axialSourceWindow,axialSourceStencil} from '../axial-source-support.js';
import {cbaCoordinates} from '../cba-core.js';
import {detectorPointProjection,detectorRowReadout,focalBlurMetadata} from '../detector-aperture.js';
import {fdkSlabMean,fdkSlabCoefficients,fdkWidth} from '../fdk-core.js';
import {zffsShift,zffsRebinStencil,zffsRowGeometry,ZFFS_VERSION} from '../zffs-geometry.js';
import {zffsPointProjection} from '../zffs-response.js';
import {assertAxialRawDomain} from '../axial-domain.js';

// Apply a temporal gate to every physical detector cell from an ORIGINAL
// acquired view, before the production rebinning operator. This independent
// input perturbation catches incorrect temporal attribution even if sum(K)
// still closes. It is not a scanner or dynamic-object validation.
const source=fs.readFileSync(new URL('../axial-source-response.js',import.meta.url),'utf8')
  .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\r?$/gm,'').replace(/^export\s+/gm,'');
function gatedOperator(gate){
  const context=vm.createContext({sourceSupportedAxialWeights,axialSourceWindow,axialSourceStencil,cbaCoordinates,
    detectorRowReadout,focalBlurMetadata,fdkSlabMean,fdkSlabCoefficients,fdkWidth,
    zffsShift,zffsRebinStencil,zffsRowGeometry,ZFFS_VERSION,assertAxialRawDomain,setTimeout,performance,
    detectorPointProjection(c,beta,zObject,parallel){
      const p=detectorPointProjection(c,beta,zObject,parallel);
      const v=Math.round((beta-c.phase)*c.viewSamples/(2*Math.PI));
      return {...p,data:p.data.map(value=>value*gate(v))};
    },
    zffsPointProjection(c,v,zObject){
      const p=zffsPointProjection(c,v,zObject);
      return {...p,data:new Map([...p.data].map(([key,value])=>[key,value*gate(v)]))};
    }});
  vm.runInContext(source,context,{filename:'gated-axial-source-response.js'});
  return context.computeSourceSupportedAxialResponse;
}
const near=(a,b,label,tolerance=2e-12)=>assert.ok(Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(a),Math.abs(b)),`${label}: ${a} != ${b}`);
const base={rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,radius:150,
  viewSamples:90,zExtent:4,zStep:.1,axialAverageMm:1,phase:.37,
  computationModel:'fdk',axialRule:'rri',comparisonMode:'matched-rri'};
let gates=0,checks=0;
for(const extra of [
  {radius:0,phase:0,axialAverageMm:0},
  {focalSizeMm:1.2,focalSourceDetectorMm:1070},
  {axialAverageMm:5,phase:.53},
  {radius:102,phase:.39,zFfsEnabled:true,focalSizeMm:1.2,focalSourceDetectorMm:1070},
]){
  const result=await computeAxialResponse({...base,...extra}),t=result.temporalResponse;
  const only=await computeAxialResponse({...base,...extra},{profileOnly:true});
  assert.deepEqual(only.raw,result.raw);assert.deepEqual(only.profile,result.profile);
  assert.deepEqual(only.fwhm,result.fwhm);assert.deepEqual(only.fwtm,result.fwtm);
  assert.deepEqual(only.temporalResponse,t,'Profile-only phases keep the same temporal response');
  assert.equal(only.weightAudit,null);
  assert.equal(t.status,'ok');assert.equal(t.raw[0],0);assert.equal(t.raw.at(-1),0);
  assert.ok(t.viewIndices[0]<0,'Negative original acquisition times remain negative');
  assert.equal(t.binWidthTurns,1/result.config.viewSamples);
  for(let i=0;i<t.raw.length;i++){
    assert.equal(t.timeTurns[i],t.viewIndices[i]/result.config.viewSamples);
    if(i)assert.equal(t.viewIndices[i]-t.viewIndices[i-1],1,'Keep internal zero bins');
    assert.ok(t.raw[i]>=0);near(t.profile[i],t.raw[i]/Math.max(...t.raw),'peak-only normalization');
  }
  near(t.sum,t.raw.reduce((a,b)=>a+b,0),'discrete sum');
  near(t.sum,result.raw[(result.raw.length-1)/2],'raw centre closure');
  near(t.equivalentWidthTurns,t.sum/Math.max(...t.raw)/result.config.viewSamples,'equivalent width');
  assert.equal('fwhm' in t,false,'A multimodal temporal response has no implied single FWHM');
  let cumulative=0,lower=null,upper=null;
  for(let i=0;i<t.raw.length;i++){cumulative+=t.raw[i];if(lower===null&&cumulative>=.05*t.sum)lower=t.timeTurns[i];if(upper===null&&cumulative>=.95*t.sum)upper=t.timeTurns[i];}
  assert.equal(t.coverage90.lowerTurns,lower);assert.equal(t.coverage90.upperTurns,upper);
  const occupied=[...t.viewIndices].filter((v,i)=>t.raw[i]>0);
  const impulses=[occupied[0],occupied[Math.floor(occupied.length/2)],occupied.at(-1)];
  for(const gate of [...impulses.map(selected=>v=>v===selected?1:0),v=>v<0||v>result.config.viewSamples/4?1:0,v=>(v%2+2)%2]){
    const forward=await gatedOperator(gate)(result.config,{profileOnly:true});
    const expected=t.raw.reduce((sum,value,i)=>sum+value*gate(t.viewIndices[i]),0);
    near(forward.raw[(forward.raw.length-1)/2],expected,'original-acquisition temporal gate');
    gates++;
  }
  if(result.config.zFfsEnabled){
    const perView=new Map();
    for(const q of result.weightAudit.samples)perView.set(q.view,(perView.get(q.view)??0)+q.weight*q.acquiredValue*result.weightAudit.db);
    for(let i=0;i<t.raw.length;i++)near(t.raw[i],perView.get(t.viewIndices[i])??0,'independent physical audit reduction');
  }
  checks++;
}

const series=await computeAxialResponseSeries({...base,phaseCount:4},{captureDiagramFrames:true});
for(const p of series.profiles){
  const single=await computeAxialResponse({...series.config,phase:p.phase},{lockDomain:true});
  assert.deepEqual(p.temporalResponse,single.temporalResponse);
  assert.equal(p.temporalResponse.centerValue,p.raw[(p.raw.length-1)/2]);
}
const expanded=await computeAxialResponse({...base,zExtent:1,axialAverageMm:5});
assert.ok(expanded.domainCheck.expansions>0);
const explicit=await computeAxialResponse({...expanded.config},{lockDomain:true});
assert.deepEqual(expanded.temporalResponse,explicit.temporalResponse);
const shortRotation=await computeAxialResponse({...base,rotationTimeMs:200});
const longRotation=await computeAxialResponse({...base,rotationTimeMs:500});
assert.deepEqual(shortRotation.raw,longRotation.raw);
assert.deepEqual(shortRotation.temporalResponse,longRotation.temporalResponse,'Rotation-time conversion belongs to presentation, not numerical acquisition geometry');
const t=shortRotation.temporalResponse;
near(t.equivalentWidthTurns*500/(t.equivalentWidthTurns*200),2.5,'linear equivalent-width unit conversion');
near(t.coverage90.widthTurns*500/(t.coverage90.widthTurns*200),2.5,'linear cumulative-span unit conversion');
const gap=await computeAxialResponse({...base,radius:0,channelApertureMm:.1});
assert.equal(gap.geometryOnly,true);assert.equal(gap.temporalResponse.status,'no-point-response');
assert.equal(gap.temporalResponse.raw.length,0);assert.equal(gap.temporalResponse.coverage90,null);
assert.equal(gap.temporalResponse.equivalentWidthTurns,null);
const historical=await computeAxialResponse({...base,candidateSearch:'one-turn'});
assert.equal(historical.temporalResponse,null);assert.match(historical.temporalResponseUnavailable,/historical one-turn/);
await assert.rejects(()=>computeAxialResponse(base,{cancelled:()=>true}),/FDK_CANCELLED/);
console.log(JSON.stringify({status:'PASS',cases:checks,originalViewGates:gates,checks:'raw-centre closure; original acquired-view impulse/window/parity gates; zFFS physical audit; profileOnly and phase matching; dense signed time grid; adaptive domain; rotation unit scaling; no-signal and legacy states'}));
