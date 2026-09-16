import assert from 'node:assert/strict';
import {fdkConfig,fdkArcProjection,reconstructFdk} from '../fdk-core.js';
import {reconstructCba} from '../cba-core.js';
const near=(a,b,t=1e-10)=>assert.ok(Math.abs(a-b)<=t,`${a} vs ${b}; tolerance ${t}`);
const sum=p=>p.data.reduce((a,b)=>a+b,0);
// Independent Cartesian solid-angle Jacobian. A unit point's ray integral
// has angular mass 1/distance^2; dOmega/dgamma/dw=R^2/(R^2+w^2)^(3/2).
for(const r of [0,102,250])for(const beta of [0,.73,2.4])for(const z of [-.11,0,.31]){
  const c=fdkConfig({objectModel:'point',rows:80,rowWidth:1,beamPitch:0,radius:r});
  const p=fdkArcProjection(c,beta,z),L=Math.hypot(c.sourceRadius*Math.cos(beta)-r,c.sourceRadius*Math.sin(beta));
  const w=c.sourceRadius*z/L,distance=Math.hypot(L,z);
  const jac=c.sourceRadius**2/(c.sourceRadius**2+w*w)**1.5;
  near(sum(p)*c.channelWidth/c.sourceRadius*c.rowWidth*jac,1/distance**2,1e-17);
}
const centered=fdkConfig({objectModel:'point',beamPitch:0,radius:0});
const cp=fdkArcProjection(centered,0,0);
assert.equal(cp.data.length,4);cp.data.forEach(v=>near(v,1/(4*centered.channelWidth*centered.rowWidth)));
// Exact symmetric aperture boundary convention: half the mass is unacquired
// on an outer row boundary; a point beyond the detector yields no signal.
const outer=centered.rows*centered.rowWidth/2;
near(sum(fdkArcProjection(centered,0,outer)),.5*Math.hypot(centered.sourceRadius,outer)/(centered.sourceRadius*centered.channelWidth*centered.rowWidth));
near(sum(fdkArcProjection(centered,0,outer+.001)),0);
// Small spheres normalized by volume approach the point projection, using
// dense subray quadrature independent of the analytic delta branch.
const convergence=[];
for(const diameter of [.1,.05]){
  const c={...centered,objectModel:'sphere',sphereDiameter:diameter,apertureSamples:512};
  const mass=sum(fdkArcProjection(c,0,0))/(Math.PI*diameter**3/6),expected=sum(cp);
  const relativeError=Math.abs(mass/expected-1);assert.ok(relativeError<.004);
  convergence.push({diameter,relativeError});
}
const base={objectModel:'point',rows:4,rowWidth:1,beamPitch:.875,radius:102,viewSamples:360,xySamples:5,xyExtent:.5,zExtent:3,zStep:.05,axialAverageMm:1};
const full=await reconstructCba(base);
assert.equal(full.roiPixels,1);assert.equal(full.reference.roiPixels,1);
// Old bead/quadrature controls are ineffectual, including out-of-range ones.
const changed=await reconstructCba({...base,sphereDiameter:8,apertureSamples:1,xySamples:17,xyExtent:1.5},{profileOnly:true});
for(const key of ['raw','profile'])full[key].forEach((v,i)=>near(v,changed[key][i],1e-10));
assert.equal(changed.config.sphereDiameter,0);assert.equal(changed.config.apertureSamples,0);
const audit=full.weightAudit;
near(audit.samples.reduce((s,q)=>s+q.weight*q.filteredValue*audit.db,0),audit.centerValue,1e-10);
near(audit.samples.reduce((s,q)=>s+q.referenceWeight*q.filteredValue*audit.db,0),audit.referenceCenterValue,1e-10);
near(full.raw[full.raw.length>>1],audit.centerValue,1e-10);
const rotated=await reconstructCba({...base,phase:Math.PI/2},{profileOnly:true});
assert.ok(Math.max(...full.profile.map((v,i)=>Math.abs(v-rotated.profile[i])))>.01);
const closure=await reconstructCba({...base,phase:2*Math.PI},{profileOnly:true});
full.profile.forEach((v,i)=>near(v,closure.profile[i],1e-9));
const widths=[];
for(const rows of [4,80,160,320])for(const thickness of [1,5]){
  const c={...base,rows,rowWidth:rows===4?1:.5,beamPitch:rows===4?.875:.5,zExtent:thickness+2,axialAverageMm:thickness};
  const r=await reconstructCba(c,{profileOnly:true});
  for(const g of [r,r.reference]){
    assert.ok(g.profile.every(Number.isFinite));assert.equal(Math.min(...g.profile),0);assert.equal(Math.max(...g.profile),1);
    assert.ok(g.counts.every(v=>v===c.viewSamples));assert.ok(g.fwhm.width>0&&g.fwtm.width>g.fwhm.width);
  }
  widths.push({rows,thickness,cba:r.fwhm.width,rri:r.reference.fwhm.width});
  if(rows>=80){
    // FDK still requires complete turn coverage. The wide output/padding at
    // 80 rows, T=5 mm exceeds that coverage at pitch .5; retain the rejection.
    if(rows===80&&thickness===5)await assert.rejects(reconstructFdk(c,{profileOnly:true}),/FDK_COVERAGE/);
    const fdkPitch=rows===80&&thickness===5?.25:c.beamPitch;
    const f=await reconstructFdk({...c,beamPitch:fdkPitch},{profileOnly:true});assert.equal(f.roiPixels,1);assert.ok(f.fwhm.width>0);widths.at(-1).fdk={pitch:fdkPitch,fwhm:f.fwhm.width};
  }
}
console.log(JSON.stringify({status:'PASS',contract:'ideal point projection and fixed-point 3D response; legacy sphere API separate',convergence,widths}));
