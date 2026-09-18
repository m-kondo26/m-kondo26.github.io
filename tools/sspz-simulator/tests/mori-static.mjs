import assert from 'node:assert/strict';
import {moriStaticConfig,moriStaticView,moriStaticGrid,moriStaticAngleProfile,moriStaticCalculate,moriStaticProgress} from '../mori-static-core.js';

let checks=0;
const near=(actual,expected,tol,label)=>{assert.ok(Math.abs(actual-expected)<=tol,`${label}: ${actual} vs ${expected}`);checks++;};
const sum=a=>a.reduce((s,v)=>s+v,0);
const c=moriStaticConfig(),result=moriStaticCalculate(c),dz=c.zStep;

// Independent continuous mixture oracle from line/plane intersections. It does
// not call the implementation's selection or profile routines. Rectangles have
// exact first/second moments; an axial sampled curve is not the reference.
function oracle(row,radius,views=c.viewSamples){
  const Z=(row-7.5)*2;let area=0,first=0,second=0,edge=0;
  for(let i=0;i<views;i++){
    const beta=2*Math.PI*i/views;
    const L=Math.sqrt(600**2+radius**2-1200*radius*Math.cos(beta));
    const s=L/600,a=2*s,W=600**2/L**2;
    const centres=Array.from({length:16},(_,k)=>(k-7.5)*2*s);
    let ids,ws;
    if(Z<centres[0]-1e-10){ids=[0];ws=[1];edge++;}
    else if(Z>centres[15]+1e-10){ids=[15];ws=[1];edge++;}
    else {
      let lo=0;while(lo<15&&centres[lo+1]<=Z)lo++;
      if(lo===15){ids=[15];ws=[1];}
      else {const q=(Z-centres[lo])/(centres[lo+1]-centres[lo]);ids=[lo,lo+1];ws=[1-q,q];}
    }
    ids.forEach((k,j)=>{const m=W*a*ws[j]/views;area+=m;first+=m*centres[k];second+=m*(centres[k]**2+a*a/12);});
  }
  return {area,centroid:first/area,sigma:Math.sqrt(Math.max(0,second/area-(first/area)**2)),edge};
}

for(const group of result.groups)for(const p of group.profiles){
  const ref=oracle(p.row,group.radius);
  near(sum(p.profile)*dz,1,1e-12,'equal final area');
  near(p.area,ref.area,1e-11,'integral equals continuous mixture');
  near(p.centroid,ref.centroid,1e-11,'continuous centroid');
  near(p.sigma,ref.sigma,2e-11,'continuous sigma');
  assert.equal(p.edgeCount,ref.edge);checks++;
  assert.ok(p.profile.every(v=>v>=0));checks++;
  const opposite=group.profiles[15-p.row];
  for(let i=0;i<result.z.length;i++)assert.ok(Math.abs(p.profile[i]-opposite.profile.at(-1-i))<1e-9);
  checks++;
  if(group.radius===0){
    near(p.fwhm,2,1e-10,'centre exact FWHM equals aperture');
    near(p.sigma,2/Math.sqrt(12),2e-11,'centre rectangular variance');
    near(p.centroid,p.zPlane,1e-11,'centre reconstruction plane');
  }
  if(!p.edgeCount)near(p.centroid,p.zPlane,1e-11,'supported interpolation reproduces plane');
}

for(const radius of [0,80,160])for(const angleDeg of [0,37,90,180,293,360])for(const row of [0,7,15]){
  const v=moriStaticView(c,{row,radius,angleDeg});
  near(sum(v.selected.map(s=>s.weight)),1,1e-12,'row weights sum one');
  assert.ok(v.selected.every(s=>s.weight>0&&s.weight<=1));checks++;
  const beta=angleDeg*Math.PI/180;
  const L=Math.sqrt(600**2+radius**2-2*600*radius*Math.cos(beta));
  near(v.transverseDistance,L,2e-12,'Euclidean transverse ray length');
  near(v.backprojectionWeight,600**2/L**2,2e-14,'curved detector inverse-square factor');
  // Physical detector ray scaled to the target line must land on the displayed
  // row centre. Changing physical detector distance cannot change iso-defined
  // acquisition geometry when detector dimensions are scaled consistently.
  for(let k=0;k<16;k++)near(v.detectorRowCentres[k]*L/1070,v.rowCentres[k],1e-12,'ray intersection');
  const d2=moriStaticView({...c,detectorDistance:1200},{row,radius,angleDeg});
  near(d2.rowCentres[row],v.rowCentres[row],1e-12,'iso-defined row geometry');
  if(!v.edgeFallback)near(sum(v.selected.map(s=>s.weight*s.zCentre)),v.zPlane,1e-11,'affine interpolation');
}

const edge=moriStaticView(c,{row:15,radius:160,angleDeg:0});
assert.equal(edge.edgeSide,'high');assert.equal(edge.selected.length,1);assert.equal(edge.selected[0].row,15);checks+=3;
near(edge.selected[0].weight,1,0,'nearest-end-row replacement');
assert.ok(edge.selected[0].zCentre<edge.zPlane);checks++;

const ap=moriStaticAngleProfile(c,{row:7,radius:160,angleDeg:47,z:result.z});
for(let i=0;i<ap.raw.length;i++)near(ap.raw[i],sum(ap.components.map(s=>s.profile[i])),1e-13,'per-row pieces add to angular response');
near(sum(ap.raw)*dz,ap.selected[0].apertureMm*ap.backprojectionWeight,1e-12,'peak-one base aperture mass');
const ap2=moriStaticAngleProfile(c,{row:7,radius:160,angleDeg:407,z:result.z});
for(let i=0;i<ap.raw.length;i++)near(ap.raw[i],ap2.raw[i],2e-12,'full angle periodicity');

const p0=moriStaticProgress(c,{row:7,radius:160,angleDeg:0,z:result.z});
assert.equal(sum(p0.profile),0);checks++;
const pEnd=moriStaticProgress(c,{row:7,radius:160,angleDeg:360,z:result.z});
for(let i=0;i<pEnd.profile.length;i++)near(pEnd.profile[i],result.groups[2].profiles[7].profile[i],1e-13,'accumulation endpoint equals final response');
const half=moriStaticProgress(c,{row:7,radius:160,angleDeg:180,z:result.z});
assert.equal(half.viewsIncluded,450);checks++;
assert.ok(sum(half.profile)*dz>0&&sum(half.profile)*dz<1);checks++;
for(let i=0;i<half.profile.length;i++)assert.ok(half.profile[i]<=pEnd.profile[i]+1e-13);checks++;

const finer=moriStaticCalculate({...c,zStep:.025,radii:[160]});
const p=result.groups[2].profiles[7],fine=finer.groups[0].profiles[7];
assert.ok(Math.abs(fine.sampledCentroid-fine.centroid)<Math.abs(p.sampledCentroid-p.centroid));checks++;
assert.ok(Math.abs(fine.sampledSigma-fine.sigma)<Math.abs(p.sampledSigma-p.sigma));checks++;
near(fine.sigma,p.sigma,1e-12,'analytic moments independent of output grid');
const v1800=moriStaticCalculate({...c,viewSamples:1800,radii:[160]});
for(const row of [0,3,7,15])near(v1800.groups[0].profiles[row].sigma,result.groups[2].profiles[row].sigma,1e-4,'angular convergence of sigma');

assert.throws(()=>moriStaticConfig({radii:[600]}),/inside/);checks++;
assert.throws(()=>moriStaticConfig({axialAperture:3}),/exceed/);checks++;
assert.throws(()=>moriStaticAngleProfile(c,{radius:160,z:new Float64Array([-1,0,1])}),/support/);checks++;
assert.throws(()=>moriStaticView(c,{row:16}),/outside/);checks++;
const one=moriStaticCalculate({...c,rows:1,radii:[0]});
near(one.groups[0].profiles[0].fwhm,2,1e-10,'single row centre response');
assert.equal(moriStaticGrid(c).length,result.z.length);checks++;
console.log(`PASS mori-static: ${checks} analytic, geometry, normalization, edge, accumulation and convergence checks`);
