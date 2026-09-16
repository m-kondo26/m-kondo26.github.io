import assert from 'node:assert/strict';
import {DEFAULT_PARAMS,computeProfileModel} from '../sim-core.js';
import {fdkConfig,reconstructFdk,reconstructFdkSeries,fdkSlabMean} from '../fdk-core.js';
import {reconstructCba} from '../cba-core.js';
const near=(a,b,t=1e-10)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
const mapping='configured-rectangular';
// An independent segment-by-segment integral, without prefix sums or the
// implementation's coefficient generator. Supports non-grid-aligned widths.
function integralMean(z,y,centre,width){
  const lo=centre-width/2,hi=centre+width/2;let total=0;
  assert.ok(lo>=z[0]-1e-9&&hi<=z.at(-1)+1e-9);
  for(let i=0;i<z.length-1;i++){
    const a=Math.max(lo,z[i]),b=Math.min(hi,z[i+1]);if(b<=a)continue;
    const ya=y[i]+(y[i+1]-y[i])*(a-z[i])/(z[i+1]-z[i]);
    const yb=y[i]+(y[i+1]-y[i])*(b-z[i])/(z[i+1]-z[i]);total+=(ya+yb)*(b-a)/2;
  }
  return total/width;
}
for(const width of [.1,.63,1,5]){
  const dz=.1,z=Float64Array.from({length:201},(_,i)=>(i-100)*dz),y=Float64Array.from(z,v=>2+.5*v);
  const pad=Math.ceil(width/(2*dz)),out=fdkSlabMean(y,dz,width,pad);
  for(let i=0;i<out.length;i++)near(out[i],y[i+pad],1e-12);
}
for(const T of [1,5]){
  const input={...DEFAULT_PARAMS,sliceThicknessMm:T,filterWidthMm:.25,viewSamples:90,zSamples:300};
  const actual=computeProfileModel({...input,thicknessMapping:mapping},{coneOn:true,filterWidthMm:.5});
  const reference=computeProfileModel({...input,filterWidthMm:T},{coneOn:true});
  assert.ok(actual.rawProfile.length>0);assert.deepEqual(actual.rawProfile,reference.rawProfile);assert.deepEqual(actual.profile,reference.profile);assert.equal(actual.filterWidthMm,T);
}
const base={rows:80,rowWidth:.5,beamPitch:.5,radius:100,viewSamples:90,xySamples:5,xyExtent:.5,zExtent:4,zStep:.2,apertureSamples:4,state:.45};
const report=[];
for(const T of [.63,1,5]){
  const r=await reconstructFdk({...base,sliceThicknessMm:T,axialAverageMm:.1,thicknessMapping:mapping});
  assert.equal(r.config.axialAverageMm,T);assert.equal(r.volume.length,r.z.length*25);
  const pad=Math.ceil(T/(2*r.config.zStep));
  const expanded=await reconstructFdk({...base,zExtent:base.zExtent+pad*r.config.zStep,axialAverageMm:0});
  let maxError=0;
  for(let i=0;i<r.z.length;i++){
    const expected=integralMean(expanded.z,expanded.raw,r.z[i],T);maxError=Math.max(maxError,Math.abs(r.raw[i]-expected));near(r.raw[i],expected);
    for(const j of [0,12,24]){
      const column=Float64Array.from(expanded.z,(_,k)=>expanded.volume[k*25+j]);
      near(r.volume[i*25+j],integralMean(expanded.z,column,r.z[i],T));
    }
  }
  const roi=await reconstructFdk({...base,axialAverageMm:T},{profileOnly:true});assert.deepEqual(roi.raw,r.raw);
  const a=r.weightAudit;near(a.samples.reduce((s,q)=>s+a.db*q.weight*q.geometricWeight*q.filteredValue,0),a.centerValue);
  near(a.samples.reduce((s,q)=>s+a.db*q.weight,0),Math.PI);
  assert.equal(new Set(a.samples.map(q=>q.view+':'+q.row)).size,a.samples.length);
  assert.ok(a.samples.every(q=>q.weight>=0&&q.weight<=1+1e-12));
  assert.ok(r.counts.every(n=>n===base.viewSamples));
  report.push({method:'FDK',T,fwhm:r.fwhm.width,maxRawIntegrationError:maxError,paddedSlices:r.acquisition.paddedReconstructionSlices,outputSlices:r.z.length});
}
assert.notEqual(report[1].fwhm,1,'Input thickness must not prescribe FWHM');
for(const T of [1,5]){
  const params={...base,rows:4,rowWidth:1,beamPitch:.875};
  const actual=await reconstructCba({...params,sliceThicknessMm:T,axialAverageMm:.1,thicknessMapping:mapping});
  const explicit=await reconstructCba({...params,axialAverageMm:T});
  assert.deepEqual(actual.raw,explicit.raw);assert.deepEqual(actual.reference.raw,explicit.reference.raw);
  report.push({method:'CBA',T,fwhm:actual.fwhm.width});
}
const series=await reconstructFdkSeries({...base,phaseCount:2,sliceThicknessMm:1,thicknessMapping:mapping});
const selected=await reconstructFdk({...base,phase:Math.PI,sliceThicknessMm:1,thicknessMapping:mapping});
assert.deepEqual(series.profiles[1].raw,selected.raw);
assert.throws(()=>fdkConfig({sliceThicknessMm:0,thicknessMapping:mapping}),/THICKNESS/);
await assert.rejects(reconstructFdk({...base,rows:8,sliceThicknessMm:5,thicknessMapping:mapping}),/FDK_COVERAGE/);
console.log(JSON.stringify({status:'PASS',report,oracle:'Independent segment integration before normalization; selected images and weights verified'},null,2));
