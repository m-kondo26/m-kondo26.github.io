// A primary RRI result must promote the actual linear branch everywhere,
// including the selected image and its weight audit, not merely its label.
import assert from 'node:assert/strict';
import {reconstructCba,reconstructCbaSeries,reconstructRri,reconstructRriSeries} from '../cba-core.js';
const near=(a,b,t=2e-12)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
const base={objectModel:'point',sourceRadius:600,radius:102,rows:4,rowWidth:1,
  beamPitch:.875,viewSamples:180,xySamples:5,xyExtent:.5,zExtent:4,zStep:.2,
  channelWidth:.25,channelApertureMm:.2,normalization:'minmax',edgePolicy:'available'};
let samples=0,cases=0;
for(const spec of [
  {axialAverageMm:0},
  {axialAverageMm:1,phase:1.57,state:.45},
  {axialAverageMm:5,phase:.37},
  ...[80,160,320].map(rows=>({rows,rowWidth:.5,beamPitch:.5,axialAverageMm:1,phase:.21})),
]){
  const p={...base,...spec},paired=await reconstructCba(p),r=await reconstructRri(p);
  assert.equal(r.model.kind,'rri');assert.equal(r.config.method,'rri');
  assert.equal(r.coordinateSystem,'rebinned-theta');assert.equal('reference' in r,false);
  for(const key of ['z','volume','raw','profile','fwhm','fwtm','baseline'])assert.deepEqual(r[key],paired.reference[key],key);
  assert.ok(r.raw.some((v,i)=>Math.abs(v-paired.raw[i])>1e-9),'RRI is not a relabeled CBA result');
  for(const q of r.sampleAudit){
    const a=q.delta,b=q.deltaConjugate;
    const l=[1-a,a,1-b,b].map((v,i)=>q.available[i]?v:0),sum=l.reduce((s,v)=>s+v,0);
    q.weights.forEach((v,i)=>near(v,l[i]/sum));
    near(q.weightedDistance,q.z.reduce((s,z,i)=>s+Math.abs(z)*l[i]/sum,0));
    assert.equal('rriWeights' in q,false);samples++;
  }
  const audit=r.weightAudit;
  assert.equal('referenceCenterValue' in audit,false);
  audit.samples.forEach((q,i)=>{
    assert.equal(q.weight,paired.weightAudit.samples[i].referenceWeight);
    assert.equal('referenceWeight' in q,false);
  });
  near(audit.centerValue,audit.db*audit.samples.reduce((s,q)=>s+q.weight*q.filteredValue,0));
  const n=r.config.xySamples,mid=(n-1)/2,index=(((r.z.length-1)/2*n+mid)*n+mid);
  near(audit.centerValue,r.volume[index]);
  near(audit.centerValue,r.raw[(r.z.length-1)/2]);cases++;
}
const p={...base,axialAverageMm:1,phase:.31,phaseCount:4};
const paired=await reconstructCbaSeries(p),series=await reconstructRriSeries(p);
for(const key of ['profiles','mean','meanDifference','volume'])assert.deepEqual(series[key],paired.reference[key]);
const selected=await reconstructRri({...p,phase:p.phase+Math.PI});
assert.deepEqual(selected.profile,series.profiles[2].profile);
assert.deepEqual(selected.raw,series.profiles[2].raw);
const profileOnly=await reconstructRri(p,{profileOnly:true});
assert.equal(profileOnly.volume,null);assert.equal(profileOnly.weightAudit,null);
assert.deepEqual(profileOnly.profile,series.profile);
await assert.rejects(reconstructRri(p,{cancelled:()=>true}),/CANCELLED/);
console.log(JSON.stringify({status:'PASS',cases,samples,checks:'exact existing RRI arrays and volumes; independent linear weights; averaged audit closure; series/selected/profile-only agreement; cancellation'}));
