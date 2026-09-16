import assert from 'node:assert/strict';
import {cbaSlabMean,cbaSlabCoefficients,reconstructCba,reconstructCbaSeries} from '../cba-core.js';
import {reconstructFdk} from '../fdk-core.js';
const near=(a,b,t=1e-10)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
for(const width of [0,.63,1,5]){
  const y=Float64Array.from({length:151},(_,i)=>Math.sin(i*.17)+i*.012),dz=.05,pad=Math.ceil(width/(2*dz));
  const coeff=cbaSlabCoefficients(y.length,dz,width),mean=cbaSlabMean(y,dz,width,pad);
  near(coeff.reduce((a,b)=>a+b,0),1);near(coeff.reduce((s,w,i)=>s+w*y[i],0),mean[(mean.length-1)/2]);
}
const cba={rows:4,rowWidth:1,beamPitch:.875,radius:102,viewSamples:180,xySamples:5,zExtent:2,zStep:.1,apertureSamples:4,state:.45};
for(const axialAverageMm of [0,.63,1,5]){
  const r=await reconstructCba({...cba,zExtent:axialAverageMm>1?5:2,axialAverageMm}),a=r.weightAudit;
  near(a.samples.reduce((s,q)=>s+a.db*q.weight*q.filteredValue,0),a.centerValue);
  near(a.samples.reduce((s,q)=>s+a.db*q.referenceWeight*q.filteredValue,0),a.referenceCenterValue);
  near(a.samples.reduce((s,q)=>s+a.db*q.weight,0),Math.PI);
  assert.equal(new Set(a.samples.map(q=>q.view+':'+q.row)).size,a.samples.length);
  assert.ok(a.samples.every(q=>q.row>=0&&q.row<4&&q.weight>=0&&q.weight<=1));
  if(axialAverageMm>1)assert.ok(Math.max(...a.samples.map(q=>q.view))-Math.min(...a.samples.map(q=>q.view))>cba.viewSamples);
}
const fdk={rows:80,rowWidth:.5,beamPitch:.5,radius:100,viewSamples:90,xySamples:5,zExtent:2,zStep:.1,apertureSamples:4};
const full=await reconstructFdk(fdk),roi=await reconstructFdk(fdk,{profileOnly:true});
assert.deepEqual(full.raw,roi.raw);assert.equal(roi.volume,null);
near(full.weightAudit.samples.reduce((s,q)=>s+full.weightAudit.db*q.weight*q.geometricWeight*q.filteredValue,0),full.weightAudit.centerValue);
const series=await reconstructCbaSeries({...cba,phaseCount:4});
for(let i=0;i<4;i++){
  const selected=await reconstructCba({...cba,phase:2*Math.PI*i/4});
  assert.deepEqual(selected.profile,series.profiles[i].profile);assert.deepEqual(selected.reference.profile,series.reference.profiles[i].profile);
}
let cancelled=false;
await assert.rejects(reconstructCbaSeries({...cba,phaseCount:360},{progress:()=>{cancelled=true;},cancelled:()=>cancelled}),/FDK_CANCELLED/);
console.log(JSON.stringify({status:'PASS',slabAndAudit:'actual reconstructed centre reproduced for 0, 0.63, 1, 5 mm',fdkRoi:'bit-identical',selectedPhase:'matches saved series',cancellation:'PASS'}));
