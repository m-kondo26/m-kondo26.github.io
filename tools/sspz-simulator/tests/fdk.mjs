import assert from 'node:assert/strict';
import {fdkConfig,fdkCoordinates,fdkRowPosition,fdkSphereChord,fdkRamp,fdkArcProjection,fdkRebinAt,fdkFilteredPatch,reconstructFdk,reconstructFdkSeries} from '../fdk-core.js';
const near=(a,b,t=1e-9)=>assert.ok(Math.abs(a-b)<=t,`${a} vs ${b}`);
near(fdkSphereChord(-2,0,0,1,0,0,0,0,0,1),2);
near(fdkSphereChord(-2,2,0,1,0,0,0,0,0,1),0);
near(fdkSphereChord(2,0,0,1,0,0,0,0,0,1),0);
// Independent Cartesian line-plane and line-cylinder intersections.
for(const rows of [80,160,320])for(const beta of [-2,.3,2.6])for(const row of [0,Math.floor(rows/2),rows-1]){
  const c=fdkConfig({rows,phase:.4}),R=c.sourceRadius;
  const sx=R*Math.cos(beta),sy=R*Math.sin(beta),sz=c.feed*(beta-c.phase)/(2*Math.PI);
  const dx=c.radius-sx,dy=-sy,L=Math.hypot(dx,dy),w=(row-(rows-1)/2)*c.rowWidth;
  const z=sz+w*L/R;
  near(fdkRowPosition(c,beta,row),z);
  const q=fdkCoordinates(c,beta,c.radius,0,z),t=R/(-dx*Math.cos(beta)-dy*Math.sin(beta));
  near(q.u,t*(-dx*Math.sin(beta)+dy*Math.cos(beta)));
  near(q.v,t*(z-sz));near(q.w,w);
}
// Dense all-cell quadratic intersection projection (no sparse bounding code).
const c=fdkConfig({rows:8,radius:1,beamPitch:0,xyExtent:.5,apertureSamples:4}),beta=.7,p=fdkArcProjection(c,beta,0),R=c.sourceRadius;
let denseError=0;
for(let k=0;k<c.rows;k++)for(let j=0;j<c.channels;j++){
  let expected=0;
  for(let v=0;v<4;v++)for(let u=0;u<4;u++){
    const gamma=(j-(c.channels-1)/2+(u+.5)/4-.5)*c.channelWidth/R,w=(k-(c.rows-1)/2+(v+.5)/4-.5)*c.rowWidth;
    const source=[R*Math.cos(beta),R*Math.sin(beta),0];
    const direction=[-R*Math.cos(beta-gamma),-R*Math.sin(beta-gamma),w];
    // Our detector u points (-sin beta, cos beta), so the ray azimuth is beta-gamma+pi.
    const offset=[source[0]-c.radius,source[1],0],A=direction.reduce((s,v)=>s+v*v,0),B=2*direction.reduce((s,v,i)=>s+v*offset[i],0),C=offset.reduce((s,v)=>s+v*v,0)-(c.sphereDiameter/2)**2;
    const D=B*B-4*A*C;if(D>0)expected+=Math.sqrt(D/A)/16;
  }
  const actual=j<p.j0||j>p.j1||k<p.k0||k>p.k1?0:p.data[(k-p.k0)*p.width+j-p.j0];
  denseError=Math.max(denseError,Math.abs(actual-expected));
}
// Independent quadratic form loses a little precision at R=600 mm.
assert.ok(denseError<1e-6,`Dense projection error ${denseError}`);
// Compare sparse output evaluation with a full flat-detector convolution.
const patch=fdkFilteredPatch(c,p,-8,8),jmax=Math.ceil(R*Math.tan(c.channels*c.channelWidth/(2*R))/c.channelWidth)+2;
for(let k=patch.v0;k<=patch.v1;k++)for(let i=-8;i<=8;i++){
  let expected=0;
  for(let j=-jmax;j<=jmax;j++){
    const u=(j+c.uOffset)*c.channelWidth,v=(k+c.vOffset)*c.rowWidth;
    expected+=fdkRebinAt(c,p,u,v)*R/Math.hypot(R,u,v)*fdkRamp(i-j,c.channelWidth);
  }
  near(patch.data[(k-patch.v0)*patch.width+i-patch.i0],expected,1e-12);
}
const circular=await reconstructFdk({beamPitch:0,radius:0,sphereDiameter:4,xyExtent:3,zExtent:4});
const center=circular.volume[(circular.z.length>>1)*17*17+144];
near(center,1,.002);
const widths=[];
for(const rows of [80,160,320]){
  const r=await reconstructFdk({rows});assert.equal(r.volume.length,121*17*17);assert.ok(r.volume.every(Number.isFinite));
  assert.ok(r.counts.every(n=>n===360));assert.equal(Math.min(...r.profile),0);assert.equal(Math.max(...r.profile),1);
  assert.ok(r.fwhm.width>.5&&r.fwhm.width<1.5);widths.push({rows,fwhm:r.fwhm.width,fwtm:r.fwtm.width});
}
const phases=await reconstructFdkSeries({phaseCount:4});
assert.ok(Math.max(...phases.profiles.map(p=>p.fwhm.width))-Math.min(...phases.profiles.map(p=>p.fwhm.width))>.001,'Start-angle series must change source orientation relative to table motion, not only renumber identical views');
for(let j=0;j<phases.z.length;j++)near(phases.meanDifference.reduce((s,p)=>s+p[j],0),0,1e-12);
await assert.rejects(reconstructFdk({beamPitch:1.5}),/FDK_COVERAGE/);
await assert.rejects(reconstructFdk({}, {cancelled:()=>true}),/FDK_CANCELLED/);
console.log(JSON.stringify({test:'FDK',status:'PASS',denseProjectionMaxError:denseError,unitSphereCenter:center,widths,phaseWidths:phases.profiles.map(p=>p.fwhm.width)}));
