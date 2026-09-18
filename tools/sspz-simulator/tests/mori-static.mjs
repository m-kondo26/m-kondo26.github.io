import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {moriStaticConfig,moriStaticView,moriStaticGrid,moriStaticAngleProfile,moriStaticCalculate,moriStaticProgress} from '../mori-static-core.js';

let checks=0;
const near=(actual,expected,tol,label)=>{assert.ok(Math.abs(actual-expected)<=tol,`${label}: ${actual} vs ${expected}`);checks++;};
const sum=a=>a.reduce((s,v)=>s+v,0);
// Keep the original point-focus analytic checks as an explicit limiting case.
const c=moriStaticConfig({focalSizeMm:0}),result=moriStaticCalculate(c),dz=c.zStep;
const pointHash=createHash('sha256');
pointHash.update(Buffer.from(result.z.buffer));
for(const g of result.groups)for(const p of g.profiles){
  pointHash.update(Buffer.from(p.raw.buffer));pointHash.update(Buffer.from(p.profile.buffer));
}
// Saved from public core 2026-09-18.1 before finite focus was introduced.
assert.equal(pointHash.digest('hex'),'fce7fd542d1cf31343d54bd644017f7f780717f900d7b0a15587e6323ac7fc47');checks++;

// Independent continuous mixture oracle from line/plane intersections. It does
// not call the implementation's selection or profile routines. Rectangles have
// exact first/second moments; an axial sampled curve is not the reference.
function oracle(row,radius,views=c.viewSamples,focalSizeMm=0){
  const Z=(row-7.5)*2;let area=0,first=0,second=0,edge=0;
  for(let i=0;i<views;i++){
    const beta=2*Math.PI*i/views;
    const L=Math.sqrt(600**2+radius**2-1200*radius*Math.cos(beta));
    const s=L/600,a=2*s,W=600**2/L**2,b=focalSizeMm*Math.abs(1-L/1070);
    const centres=Array.from({length:16},(_,k)=>(k-7.5)*2*s);
    let ids,ws;
    if(Z<centres[0]-1e-10){ids=[0];ws=[1];edge++;}
    else if(Z>centres[15]+1e-10){ids=[15];ws=[1];edge++;}
    else {
      let lo=0;while(lo<15&&centres[lo+1]<=Z)lo++;
      if(lo===15){ids=[15];ws=[1];}
      else {const q=(Z-centres[lo])/(centres[lo+1]-centres[lo]);ids=[lo,lo+1];ws=[1-q,q];}
    }
    ids.forEach((k,j)=>{const m=W*a*ws[j]/views;area+=m;first+=m*centres[k];second+=m*(centres[k]**2+(a*a+b*b)/12);});
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
// The detector must be beyond every evaluation point over the whole orbit,
// even with a point source. R=600, r=160 reaches L=760 at 180 degrees;
// D=650 previously passed D>R and silently extrapolated behind the detector.
const detectorDomainError=/detectorDistance.*sourceRadius \+ radius/;
for(const focalSizeMm of [0,1.2]){
  for(const detectorDistance of [650,760]){
    assert.throws(()=>moriStaticConfig({sourceRadius:600,detectorDistance,radii:[0,160],focalSizeMm}),detectorDomainError);checks++;
  }
  const valid=moriStaticConfig({sourceRadius:600,detectorDistance:760.001,radii:[0,160],focalSizeMm});
  const far=moriStaticView(valid,{row:7,radius:160,angleDeg:180});
  near(far.transverseDistance,760,1e-12,'farthest evaluation point');
  assert.ok(far.transverseDistance<valid.detectorDistance);checks++;
  // Single-view/grid APIs allow a radius override outside config.radii.
  // Reject it even at a near-side angle where that one view fits; a full
  // physical orbit is the declared acquisition, rather than an angle subset.
  const centreOnly=moriStaticConfig({sourceRadius:600,detectorDistance:650,radii:[0],focalSizeMm});
  assert.throws(()=>moriStaticView(centreOnly,{row:7,radius:160,angleDeg:0}),detectorDomainError);checks++;
  assert.throws(()=>moriStaticGrid(centreOnly,{radius:160}),detectorDomainError);checks++;
  assert.throws(()=>moriStaticAngleProfile(centreOnly,{row:7,radius:160,angleDeg:180,z:result.z}),detectorDomainError);checks++;
  assert.throws(()=>moriStaticProgress(centreOnly,{row:7,radius:160,angleDeg:360,z:result.z}),detectorDomainError);checks++;
  // A different radius remains usable when its complete orbit is valid.
  assert.doesNotThrow(()=>moriStaticView(centreOnly,{row:7,radius:40,angleDeg:180}));checks++;
}
const one=moriStaticCalculate({...c,rows:1,radii:[0]});
near(one.groups[0].profiles[0].fwhm,2,1e-10,'single row centre response');
assert.equal(moriStaticGrid(c).length,result.z.length);checks++;

const finiteConfig=moriStaticConfig(),finite=moriStaticCalculate(finiteConfig);
assert.equal(finiteConfig.focalSizeMm,1.2);checks++;
assert.equal(finiteConfig.focalTransverseMm,1.2);checks++;
assert.equal(finiteConfig.targetAngleDeg,7);checks++;
assert.equal(finiteConfig.targetAngleUse,'reference-only-effective-size-already-specified');checks++;
const centreBlur=1.2*(1-600/1070);
near(centreBlur,.5271028037383177,1e-15,'centre projected effective focus');
for(const group of finite.groups)for(const p of group.profiles){
  const ref=oracle(p.row,group.radius,finiteConfig.viewSamples,finiteConfig.focalSizeMm);
  near(sum(p.profile)*finiteConfig.zStep,1,2e-12,'finite focus equal final area');
  near(p.area,ref.area,2e-11,'finite focus preserves detector aperture area');
  near(p.centroid,ref.centroid,2e-11,'finite focus symmetric first moment');
  near(p.sigma,ref.sigma,3e-11,'finite focus convolution second moment');
  assert.equal(p.edgeCount,ref.edge);checks++;
  assert.ok(p.profile.every(v=>v>=0));checks++;
  assert.equal(p.profile[0],0);assert.equal(p.profile.at(-1),0);checks+=2;
  const opposite=group.profiles[15-p.row];
  for(let i=0;i<finite.z.length;i++)assert.ok(Math.abs(p.profile[i]-opposite.profile.at(-1-i))<1e-9);
  checks++;
  if(group.radius===0){
    near(p.fwhm,2,1e-10,'finite centre FWHM remains detector width');
    near(p.sigma,Math.sqrt((4+centreBlur**2)/12),3e-11,'finite centre trapezoid variance');
    near(p.centroid,p.zPlane,1e-11,'finite centre reconstruction plane');
  }
  const original=result.groups.find(g=>g.radius===group.radius).profiles[p.row];
  near(p.area,original.area,2e-11,'focus convolution preserves raw mass');
  near(p.centroid,original.centroid,2e-11,'focus convolution preserves continuous centroid');
  assert.ok(p.sigma>original.sigma);checks++;
}

// A second, independent integral form: positive-part quadratic CDF obtained
// by integrating two uniform distributions. This is different from the core's
// factored piecewise trapezoid integral and checks both shoulder directions.
function uniformSumCdf(x,a,b){
  const h=(a+b)/2;if(x<=-h)return 0;if(x>=h)return 1;
  const pp=t=>Math.max(0,t)**2;
  return (pp(x+h)-pp(x+(a-b)/2)-pp(x+(b-a)/2)+pp(x-h))/(2*a*b);
}
for(const focalSizeMm of [1.2,2/(1-600/1070),6]){
  const cfg=moriStaticConfig({rows:1,radii:[0],focalSizeMm}),ap=moriStaticAngleProfile(cfg,{row:0,radius:0,angleDeg:0});
  const a=2,b=focalSizeMm*(1-600/1070);
  near(ap.focalBlurMm,b,1e-15,'view projected focus width');
  near(ap.components[0].focalBlurMm,b,1e-15,'component projected focus width');
  near(ap.components[0].effectiveFocalSizeMm,focalSizeMm,0,'component effective focus metadata');
  for(let i=0;i<ap.z.length;i++){
    const left=ap.z[i]-cfg.zStep/2,right=ap.z[i]+cfg.zStep/2;
    const expected=a*(uniformSumCdf(right,a,b)-uniformSumCdf(left,a,b))/cfg.zStep;
    near(ap.raw[i],expected,3e-12,'exact bin average of trapezoid/triangle');
  }
  near(sum(ap.raw)*cfg.zStep,2,1e-12,'uniform focus area preserving');
}

const finiteAngle=moriStaticAngleProfile(finiteConfig,{row:7,radius:160,angleDeg:47,z:finite.z});
for(let i=0;i<finiteAngle.raw.length;i++)near(finiteAngle.raw[i],sum(finiteAngle.components.map(s=>s.profile[i])),1e-13,'finite components sum to angular profile');
const finiteEnd=moriStaticProgress(finiteConfig,{row:7,radius:160,angleDeg:360,z:finite.z});
for(let i=0;i<finiteEnd.profile.length;i++)near(finiteEnd.profile[i],finite.groups[2].profiles[7].profile[i],1e-13,'finite accumulation equals final response');
const finiteHalf=moriStaticProgress(finiteConfig,{row:7,radius:160,angleDeg:180,z:finite.z});
assert.equal(finiteHalf.viewsIncluded,450);checks++;
for(let i=0;i<finiteHalf.profile.length;i++)assert.ok(finiteHalf.profile[i]<=finiteEnd.profile[i]+1e-13);checks++;
const finiteFiner=moriStaticCalculate({...finiteConfig,zStep:.025,radii:[160]});
for(const row of [0,3,7,15]){
  const coarse=finite.groups[2].profiles[row],fine=finiteFiner.groups[0].profiles[row];
  near(fine.centroid,coarse.centroid,1e-12,'finite analytic centroid grid independence');
  near(fine.sigma,coarse.sigma,1e-12,'finite analytic sigma grid independence');
  assert.ok(Math.abs(fine.sampledSigma-fine.sigma)<Math.abs(coarse.sampledSigma-coarse.sigma));checks++;
  assert.ok(Math.abs(fine.sampledCentroid-fine.centroid)<3e-7);checks++;
}
const finiteV1800=moriStaticCalculate({...finiteConfig,viewSamples:1800,radii:[160]});
for(const row of [0,3,7,15])near(finiteV1800.groups[0].profiles[row].sigma,finite.groups[2].profiles[row].sigma,1e-4,'finite angular convergence');
// The book's effective size is not multiplied by sin(target angle). Changing
// reference-only metadata therefore cannot change the calculated response.
const otherTarget=moriStaticAngleProfile({...finiteConfig,targetAngleDeg:14},{row:7,radius:160,angleDeg:47,z:finite.z});
assert.deepEqual(otherTarget.raw,finiteAngle.raw);checks++;
for(const focalSizeMm of [-1,NaN,Infinity]){assert.throws(()=>moriStaticConfig({focalSizeMm}),/focalSizeMm/);checks++;}
assert.throws(()=>moriStaticAngleProfile({...finiteConfig,focalSizeMm:20},{radius:160,z:result.z}),/support/);checks++;
console.log(`PASS mori-static: ${checks} point/finite-focus analytic, geometry, normalization, edge, accumulation and convergence checks`);
