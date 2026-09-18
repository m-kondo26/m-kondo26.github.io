import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {axialResponseConfig,computeAxialResponse} from '../axial-response-core.js';
import {detectorPointProjection,detectorAxialFocusRows,focalBlurWidth} from '../detector-aperture.js';
import {zffsPointProjection} from '../zffs-response.js';
const near=(a,b,t=1e-10)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=t,`${a} != ${b}; tolerance ${t}`);
let checks=0,maxCellError=0;
const base={rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,radius:102,viewSamples:180,zExtent:5,zStep:.1,phaseCount:1,axialAverageMm:1,phase:.37};
// Frozen before introducing finite focus: complete raw and normalized arrays.
const hashes=[
 ['merged',false,'4767fc95e0564cc52bd5d0e976435c482249ac7ed0e153f00c06b12270aeb79c','0dd68ad9379e7253c8d920dc31ed2162450c128c49b204c050395041ce0b0bc7'],
 ['merged',true,'2e73c45558674e88d03ba5a175fb562e329d97843ca800cefc37049eb8793647','c39bd456c96746488d89b8e17746a75873dd4cd3ca21394001902f321cf46e4a'],
 ['rri',false,'e74df7761f0428599b72dd177f8994a25ee074b05b2b61a428e61e9905539ca7','d978e02e1eae4e6e301003e7b823902fcccda7272c0dffe510f3d5704a169cbd'],
 ['rri',true,'328c32d9a2701c03a7aac2f564ef38737b06e6b99012b608030734e1f554f7b0','1e141c4ac14b7839e54af44dd6e96a2e175317c0477f54cf1c4edd9c276a2fcd'],
 ['parallel',false,'da33a280b724afcd80980531a6d6afa9645ee0d62d08e09b4a6c733a0302c13b','bab33e546e984c4b06cd0d8f6da5bff2343b5a46312a6dd54b97245122138d27']
];
const hash=v=>createHash('sha256').update(Buffer.from(v.buffer)).digest('hex');
for(const [axialRule,zFfsEnabled,raw,profile] of hashes){
  const r=await computeAxialResponse({...base,axialRule,zFfsEnabled,focalSizeMm:0});
  assert.equal(hash(r.raw),raw);assert.equal(hash(r.profile),profile);checks++;
}
// Independent source quadrature. A physical ray from (S_xy,base+delta+t)
// meets the fixed detector at base + D/L*(z-base) + (1-D/L)*(delta+t).
// Deliberately no production membership, interval or focal helpers here.
function oracle(c,beta,z,baseZ,delta=0,parallel=false){
  const R=c.sourceRadius,D=c.focalSourceDetectorMm,L=parallel?R:Math.hypot(R*Math.cos(beta)-c.radius,R*Math.sin(beta));
  const x=parallel?-c.radius*Math.sin(beta):R*Math.atan2(-c.radius*Math.sin(beta),R-c.radius*Math.cos(beta));
  const a=c.channelApertureMm,f=c.focalSizeMm,n=65536,out=new Float64Array(c.rows*c.channels);
  const js=[];
  for(let j=0;j<c.channels;j++){
    const d=Math.abs(x-(j-(c.channels-1)/2)*c.channelWidth)-a/2;
    if(d<=1e-10)js.push([j,Math.abs(d)<=1e-10?.5:1]);
  }
  for(let i=0;i<n;i++){
    const shift=delta+f*((i+.5)/n-.5),zs=baseZ+shift;
    const detectorZ=zs+D/L*(z-zs),detectorW=(detectorZ-baseZ)*R/D;
    const row=Math.floor(detectorW/c.rowWidth+c.rows/2);
    if(row<0||row>=c.rows)continue;
    const rayZ=(z-zs)*R/L,signal=parallel?1/(a*c.rowWidth):Math.hypot(R,rayZ)/(L*L*(a/R)*c.rowWidth);
    for(const [j,w] of js)out[row*c.channels+j]+=signal*w/n;
  }
  return out;
}
for(const radius of [0,102,250])for(const beta of [0,.71,2.3])for(const z of [-1.12,.03,1.83]){
  const c=axialResponseConfig({...base,radius,focalSizeMm:1.2,focalSourceDetectorMm:1070});
  c.sourceZ=.37;
  const p=detectorPointProjection(c,beta,z),expected=oracle(c,beta,z,c.sourceZ);
  for(let row=0;row<c.rows;row++)for(let j=0;j<c.channels;j++){
    const value=row<p.k0||row>p.k1||j<p.j0||j>p.j1?0:p.data[(row-p.k0)*p.width+j-p.j0];
    const error=Math.abs(value-expected[row*c.channels+j]);maxCellError=Math.max(maxCellError,error);
    near(value,expected[row*c.channels+j],.0002);
  }
  checks++;
}
// Finite source support gives detector-width + focal-width, including
// object-side magnification. Outside the exact support, a row acquires zero.
for(const L of [350,600,850]){
  const c=axialResponseConfig({...base,rows:1,focalSizeMm:1.2,focalSourceDetectorMm:1070});
  const support=c.rowWidth*L/c.sourceRadius+focalBlurWidth(c,L);
  const inside=detectorAxialFocusRows(c,c.sourceRadius*(support/2-1e-5)/L,c.sourceRadius*(support/2-1e-5)/L,L);
  const outside=detectorAxialFocusRows(c,c.sourceRadius*(support/2+1e-5)/L,c.sourceRadius*(support/2+1e-5)/L,L);
  assert.ok(inside.some(q=>q[1]>0));assert.equal(outside.length,0);checks++;
}
// Normalized source emission: summing a detector wide enough to contain the
// entire point response equals the source-averaged Jacobian, not f times it.
for(const f of [.01,1.2,4]){
  const c=axialResponseConfig({...base,rows:80,focalSizeMm:f,focalSourceDetectorMm:1070});
  const L=498,w=3.72,actual=detectorAxialFocusRows(c,w,w,L).reduce((s,q)=>s+q[1],0),n=10000;
  let expected=0;
  for(let i=0;i<n;i++){const t=f*((i+.5)/n-.5);expected+=Math.hypot(600,w-600/L*t)/(L*L*(.25/600)*c.rowWidth)/n;}
  near(actual,expected,1e-10);checks++;
}
// z-FFS shares the same source distribution around each actual focal state.
for(const view of [-77,0,1,63]){
  const c=axialResponseConfig({...base,focalSizeMm:1.2,focalSourceDetectorMm:1070,zFfsEnabled:true});
  const p=zffsPointProjection(c,view,.28),beta=c.phase+2*Math.PI*view/c.viewSamples;
  const delta=(view%2===0?-1:1)*c.zFfsSourceOffsetMm;
  const expected=oracle(c,beta,.28,c.feed*view/c.viewSamples,delta);
  for(let row=0;row<c.rows;row++)for(let j=0;j<c.channels;j++)near(p.data.get(row+':'+j)??0,expected[row*c.channels+j],.0002);
  checks++;
}
const selection=r=>r.weightAudit.pairedSamples.map(({acquiredValue,...q})=>q);
for(const axialRule of ['merged','rri','parallel']){
  const input={...base,axialRule,focalSourceDetectorMm:1070};
  const point=await computeAxialResponse({...input,focalSizeMm:0}),finite=await computeAxialResponse({...input,focalSizeMm:1.2});
  assert.deepEqual(selection(finite),selection(point));assert.deepEqual(finite.sampleAudit,point.sampleAudit);
  assert.ok(Math.max(...finite.profile.map((y,i)=>Math.abs(y-point.profile[i])))>.001);
  const a=finite.weightAudit;near(a.samples.reduce((s,q)=>s+q.weight*q.acquiredValue*a.db,0),a.centerValue,1e-10);
  assert.equal(finite.model.focalBlur.focalSizeMm,1.2);checks++;
  if(axialRule!=='parallel'){
    const zero=await computeAxialResponse({...input,focalSizeMm:1.2,zFfsEnabled:true,zFfsOffset:0});
    finite.raw.forEach((v,i)=>near(v,zero.raw[i],1e-10));
    const ffs=await computeAxialResponse({...input,focalSizeMm:1.2,zFfsEnabled:true});
    const audit=ffs.weightAudit;near(audit.samples.reduce((s,q)=>s+q.weight*q.acquiredValue*audit.db,0),audit.centerValue,1e-10);checks++;
  }
}
// The nondivergent comparison keeps the same isocentre blur at every angle.
for(const beta of [0,.2,2.3]){
  const c=axialResponseConfig({...base,axialRule:'parallel',focalSizeMm:1.2,focalSourceDetectorMm:1070});
  c.sourceZ=.3;const p=detectorPointProjection(c,beta,.71,true),expected=oracle(c,beta,.71,.3,0,true);
  for(let row=0;row<c.rows;row++)for(let j=0;j<c.channels;j++){
    const actual=row<p.k0||row>p.k1||j<p.j0||j>p.j1?0:p.data[(row-p.k0)*p.width+j-p.j0];near(actual,expected[row*c.channels+j],.0002);
  }checks++;
}
assert.throws(()=>axialResponseConfig({...base,focalSizeMm:-1}),/FOCAL_SIZE/);
assert.throws(()=>axialResponseConfig({...base,focalSizeMm:1.2,focalSourceDetectorMm:650}),/FOCAL_GEOMETRY/);
assert.throws(()=>axialResponseConfig({...base,focalSizeMm:1.2,zFfsEnabled:true,focalSourceDetectorMm:1070,zFfsMagnification:1072/600}),/conflicts/);
near(axialResponseConfig({...base,focalSizeMm:1.2,zFfsEnabled:true}).focalSourceDetectorMm,1072);
near(axialResponseConfig({...base,focalSizeMm:1.2,zFfsEnabled:true,focalSourceDetectorMm:1070}).zFfsSourceDetectorMm,1070);
checks+=5;
console.log(JSON.stringify({status:'PASS',checks,maxCellError,scope:'Source integration, support, exposure mass, zero-focus compatibility and audit closure; not scanner validation'},null,2));
