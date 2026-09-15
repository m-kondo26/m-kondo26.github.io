import assert from 'node:assert/strict';
import {fdkConfig} from '../fdk-core.js';
import {cbaWeights,cbaAvailableWeights,cbaCoordinates,cbaSlabMean,reconstructCba} from '../cba-core.js';
const near=(a,b,t=1e-11)=>assert.ok(Math.abs(a-b)<=t,`${a} versus ${b}`);
for(const width of [.6,1,5]){
 const dz=.05,pad=Math.ceil(width/(2*dz));
 const linear=Float64Array.from({length:401},(_,i)=>3+(i-200)*dz*2);
 const mean=cbaSlabMean(linear,dz,width,pad);
 mean.forEach((v,i)=>near(v,linear[i+pad],2e-12));
}
const c=fdkConfig({rows:4,rowWidth:1,beamPitch:.875,radius:10});
for(let i=0;i<360;i++){
 const theta=-Math.PI+2*Math.PI*i/720,a=cbaCoordinates(c,theta,10,0,0),b=cbaCoordinates(c,theta+Math.PI,10,0,0);
 for(const power of [1,2]){
  const actual=cbaAvailableWeights(c,a,b,power),rowLocations=[a.w/c.rowWidth+1.5,b.w/c.rowWidth+1.5];
  const expected=[];for(const q of rowLocations)for(const k of [Math.floor(q),Math.floor(q)+1])expected.push(k<0||k>=4?0:Math.max(0,1-Math.abs(q-k))**power);
  const sum=expected.reduce((s,v)=>s+v,0);actual.forEach((v,j)=>near(v,expected[j]/sum));near(actual.reduce((s,v)=>s+v,0),1);
  if(a.n>=0&&a.n+1<4&&b.n>=0&&b.n+1<4)assert.deepEqual(actual,cbaWeights(a.delta,b.delta,power));
 }
}
assert.throws(()=>cbaAvailableWeights(c,{n:-4,delta:.5},{n:8,delta:.5}),/CBA_COVERAGE/);
const input={rows:4,rowWidth:1,beamPitch:.875,radius:102,viewSamples:180,xySamples:5,axialAverageMm:1,zExtent:2,edgePolicy:'available'};
const full=await reconstructCba(input),roi=await reconstructCba(input,{profileOnly:true});
assert.deepEqual(roi.raw,full.raw);assert.deepEqual(roi.reference.raw,full.reference.raw);assert.equal(roi.volume,null);
assert.ok(full.acquisition.boundaryPairs>0);assert.equal(full.z.length,full.config.zSamples);assert.equal(full.volume.length,25*full.z.length);
for(const g of [full,full.reference]){near(Math.min(...g.profile),0);near(Math.max(...g.profile),1);assert.ok(g.fwhm.width>0&&g.fwtm.width>g.fwhm.width);}
const cols=full.volume,iz=Math.floor(full.z.length/2);near(cols[iz*25+12],full.raw[iz]);
await assert.rejects(reconstructCba({...input,edgePolicy:'strict'}),/CBA_COVERAGE/);
const interior={rows:80,beamPitch:.5,radius:100,viewSamples:180,xySamples:5,zExtent:2};
const strict=await reconstructCba({...interior,edgePolicy:'strict'}),available=await reconstructCba({...interior,edgePolicy:'available'});
assert.deepEqual(strict.raw,available.raw);assert.deepEqual(strict.reference.raw,available.reference.raw);
console.log(JSON.stringify({status:'PASS',test:'CBA four-row extension',fullVsRoi:'identical',interiorStrictVsAvailable:'identical',cbaFwhm:full.fwhm.width,rriFwhm:full.reference.fwhm.width}));
