import assert from 'node:assert/strict';
import {fdkConfig,fdkArcProjection} from '../fdk-core.js';
import {cbaCoordinates,cbaWeights,cbaRebinAt,cbaFilteredPatch,reconstructCba,reconstructCbaSeries} from '../cba-core.js';
const near=(a,b,t=1e-10)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b} (tol ${t})`);
// Independent Cartesian source-to-voxel ray: recover its transverse normal
// and cylinder intersection, then verify both members of a conjugate pair.
for(const rows of [80,160,320])for(const theta of [-2.3,.17,1.8])for(const xyz of [[5,8,.1],[101,-1,-.5]]){
 const c=fdkConfig({rows,phase:.31});const qs=[0,Math.PI].map(offset=>cbaCoordinates(c,theta+offset,...xyz));
 near(qs[0].t,-qs[1].t);
 for(const q of qs){const s=[c.sourceRadius*Math.cos(q.beta),c.sourceRadius*Math.sin(q.beta),c.feed*(q.beta-c.phase)/(2*Math.PI)];const d=xyz.map((v,i)=>v-s[i]),L=Math.hypot(d[0],d[1]);near(q.w,c.sourceRadius*d[2]/L);near(q.L,L);near(Math.hypot(s[0],s[1]),c.sourceRadius);}
}
for(let i=0;i<=20;i++)for(let j=0;j<=20;j++){
 const a=i/20,b=j/20,w=cbaWeights(a,b),wr=cbaWeights(a,b,1),values=[.1,-.8,2,.6];near(w.reduce((s,v)=>s+v,0),1);assert.ok(w.every(v=>v>=0));
 near(wr.reduce((s,v,k)=>s+v*values[k],0),((1-a)*values[0]+a*values[1]+(1-b)*values[2]+b*values[3])/2);
 const swapped=cbaWeights(b,a);w.forEach((v,k)=>near(v,swapped[(k+2)%4]));
}
assert.throws(()=>cbaWeights(-.01,.5),/DOMAIN/);
// Rebinning preserves an affine sampled field and never wraps source z.
const c=fdkConfig({rows:8,radius:1,beamPitch:0,xyExtent:.5,viewSamples:90});
const affine=v=>({j0:0,j1:c.channels-1,k0:0,k1:7,width:c.channels,height:8,data:Float64Array.from({length:8*c.channels},(_,i)=>3*v+2*(i%c.channels)+5*Math.floor(i/c.channels))});
for(const theta of [-.31,.7,7])for(const t of [-.3,.25]){const gamma=Math.asin(t/c.sourceRadius),vi=(theta+gamma-c.phase)*c.viewSamples/(2*Math.PI),j=gamma*c.sourceRadius/c.channelWidth+(c.channels-1)/2;near(cbaRebinAt(c,affine,theta,t,3),3*vi+2*j+15,1e-9);}
const cache=new Map(),raw=v=>{if(!cache.has(v))cache.set(v,fdkArcProjection(c,c.phase+v*2*Math.PI/c.viewSamples,0));return cache.get(v);};
let maxError=0;
for(const theta of [-1.1,.4,2.2]){
 const patch=cbaFilteredPatch(c,raw,theta,-5,5),span=Math.floor(c.sourceRadius*Math.sin(((c.channels-1)/2-1)*c.channelWidth/c.sourceRadius)/c.channelWidth)-2;
 for(let k=0;k<c.rows;k++)for(let i=-5;i<=5;i++){
  let expected=0;for(let j=-span;j<=span;j++){const value=cbaRebinAt(c,raw,theta,(j+c.uOffset)*c.channelWidth,k),m=i-j,du=c.channelWidth;const h=m===0?1/(4*du):Math.abs(m)%2===1?-1/(Math.PI**2*m*m*du):0;expected+=value*h*c.sourceRadius/Math.hypot(c.sourceRadius,(k-3.5)*c.rowWidth);}
  const actual=k<patch.k0||k>patch.k1?0:patch.data[(k-patch.k0)*patch.width+i-patch.i0];maxError=Math.max(maxError,Math.abs(actual-expected));
 }
}
assert.ok(maxError<1e-11,`dense convolution ${maxError}`);
const circle=await reconstructCba({radius:0,beamPitch:0,sphereDiameter:4,xyExtent:3,zExtent:4,viewSamples:90});
const center=circle.volume[((circle.z.length-1)/2*17+8)*17+8];near(center,1,.003);
const rowsResults=[];
for(const rows of [80,160,320]){
 const r=await reconstructCba({rows});assert.ok(r.volume.every(Number.isFinite));assert.ok(r.reference.volume.every(Number.isFinite));assert.ok(r.counts.every(v=>v===360));
 assert.equal(r.sampleAudit.length,180);near(Math.min(...r.profile),0);near(Math.max(...r.profile),1);
 assert.ok(r.fwhm.width>0&&r.reference.fwhm.width>0);rowsResults.push({rows,cba:r.fwhm.width,rri:r.reference.fwhm.width});
}
const series=await reconstructCbaSeries({viewSamples:180,xySamples:5,phaseCount:4});
assert.ok(Math.max(...series.profiles.map(p=>p.fwhm.width))-Math.min(...series.profiles.map(p=>p.fwhm.width))>1e-5);
for(const r of [series,series.reference])for(let i=0;i<r.z.length;i++)near(r.meanDifference.reduce((s,v)=>s+v[i],0),0,1e-12);
await assert.rejects(reconstructCba({beamPitch:2}),/CBA_COVERAGE/);
await assert.rejects(reconstructCba({viewSamples:361}),/CBA_VIEWS/);
await assert.rejects(reconstructCba({}, {cancelled:()=>true}),/FDK_CANCELLED/);
console.log(JSON.stringify({test:'CBA',status:'PASS',denseConvolutionError:maxError,unitAttenuationCenter:center,rowsResults}));
