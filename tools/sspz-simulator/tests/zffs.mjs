import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {axialResponseConfig,computeAxialResponse,computeAxialResponseSeries} from '../axial-response-core.js';
import {zffsRowGeometry,zffsState,zffsRebinStencil} from '../zffs-geometry.js';
import {zffsPointProjection,zffsCandidateWeights} from '../zffs-response.js';
const near=(a,b,t=1e-10)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
let checks=0;
const base={rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,radius:102,viewSamples:180,zExtent:4,zStep:.1,phaseCount:1,axialAverageMm:1,phase:.37,zFfsEnabled:true};
// Independent Cartesian ray: fixed detector at baseZ + row*M*d, actual source
// at baseZ +/- delta. Intersection with the target's transverse location.
for(const radius of [0,102,250])for(const view of [-183,-91,-1,0,1,56,182])for(const row of [0,1,3]){
 const c=axialResponseConfig({...base,radius}),q=zffsRowGeometry(c,view,row),beta=c.phase+2*Math.PI*view/c.viewSamples;
 const S=[600*Math.cos(beta),600*Math.sin(beta),c.feed*view/c.viewSamples+(view%2===0?-1:1)*c.zFfsSourceOffsetMm];
 const vx=radius-S[0],vy=-S[1],dist=Math.hypot(vx,vy),D=[S[0]+vx/dist*c.zFfsSourceDetectorMm,S[1]+vy/dist*c.zFfsSourceDetectorMm,c.feed*view/c.viewSamples+(row-1.5)*c.zFfsMagnification];
 const fraction=dist/c.zFfsSourceDetectorMm;
 near(q.z,S[2]+fraction*(D[2]-S[2]));near(q.sourceZ,S[2]);assert.equal(q.focus,view%2===0?0:1);checks++;
}
// Mori Eq.20: at the centre the two hypothetical states at a common nominal
// angle are separated by d/2; away from centre the separation changes with L.
for(const radius of [0,102,250]){
 const c=axialResponseConfig({...base,radius});
 for(const L of [600-radius,600+radius]){const sep=2*c.zFfsSourceOffsetMm*(1-L/c.zFfsSourceDetectorMm);near(sep,.5*(c.zFfsSourceDetectorMm-L)/(c.zFfsSourceDetectorMm-600));if(radius===0)near(sep,.5);checks++;}
}
// Stencils contain actual same-focus exposures, including negative indices.
const c=axialResponseConfig(base);
for(const theta of [-8,-2,.37,1.4,9])for(const focus of [0,1]){
 const q=zffsRebinStencil(c,theta,focus);near(q.stencil.reduce((s,p)=>s+p.weight,0),1);
 for(const p of q.stencil)assert.equal(zffsState(p.view),focus);
 near(q.stencil.reduce((s,p)=>s+p.weight*(3*p.view+2*p.channel+7),0),3*(q.beta-c.phase)*c.viewSamples/(2*Math.PI)+2*(q.gamma*c.sourceRadius/c.channelWidth+(c.channels-1)/2)+7,1e-8);checks++;
}
// Independent exhaustive four-family selection oracle.
function oracle(c,groups,z){
 const all=groups.flatMap((g,group)=>Array.from({length:c.rows},(_,row)=>({group,row,z:g.origin+(row-(c.rows-1)/2)*g.spacing,weight:0,spacing:g.spacing})));
 if(c.axialRule==='rri')all.forEach(q=>q.weight=Math.max(0,1-Math.abs(q.z-z)/q.spacing));
 else {const eq=all.filter(q=>Math.abs(q.z-z)<1e-10);if(eq.length)eq.forEach(q=>q.weight=1/eq.length);else{const lo=Math.max(...all.filter(q=>q.z<z).map(q=>q.z)),hi=Math.min(...all.filter(q=>q.z>z).map(q=>q.z));const a=all.filter(q=>Math.abs(q.z-lo)<1e-10),b=all.filter(q=>Math.abs(q.z-hi)<1e-10);a.forEach(q=>q.weight=(hi-z)/(hi-lo)/a.length);b.forEach(q=>q.weight=(z-lo)/(hi-lo)/b.length);}}
 const sum=all.reduce((s,q)=>s+q.weight,0);return all.filter(q=>q.weight>1e-12).map(q=>({...q,weight:q.weight/sum}));
}
for(const rows of [4,80,160,320])for(const axialRule of ['merged','rri'])for(const z of [-1,-.2,0,.5,1]){
 const c={rows,axialRule,edgePolicy:'available'},g=[{origin:-.7,spacing:.8},{origin:-.2,spacing:.8},{origin:1,spacing:1.1},{origin:1.6,spacing:1.1}];
 const a=zffsCandidateWeights(c,g,z),b=oracle(c,g,z);near(a.reduce((s,q)=>s+q.weight,0),1);for(const q of b)near(a.find(x=>x.group===q.group&&x.row===q.row)?.weight??0,q.weight);checks++;
}
// Off path unchanged; zero displacement collapses the coincident trajectories.
for(const axialRule of ['merged','rri']){
 const p={...base,axialRule};delete p.zFfsEnabled;
 const a=await computeAxialResponse(p),b=await computeAxialResponse({...p,zFfsEnabled:false,zFfsOffset:.49}),zero=await computeAxialResponse({...p,zFfsEnabled:true,zFfsOffset:0});
 assert.deepEqual(a.raw,b.raw);assert.deepEqual(a.profile,b.profile);a.raw.forEach((v,i)=>near(v,zero.raw[i]));checks++;
}
// Slow direct angular/candidate oracle at several native z samples, no caches
// and no optimized pair selector. T=0 leaves only the acquired response.
for(const axialRule of ['merged','rri']){
 const r=await computeAxialResponse({...base,axialRule,axialAverageMm:0,candidateSearch:'one-turn'}),c=r.config;
 for(const iz of [36,40,44]){
  const z=r.z[iz],step=2*Math.PI/c.viewSamples,start=Math.ceil((2*Math.PI*z/c.feed-Math.PI)/step-1e-12);let sum=0;
  for(let v=start;v<start+c.viewSamples/2;v++){
   const groups=[];
   for(const direction of [0,1])for(const focus of [0,1]){const theta=c.phase+(v+direction*c.viewSamples/2)*step,gamma=Math.asin(-c.radius*Math.sin(theta)/600),beta=theta+gamma,L=Math.sqrt(600**2-(-c.radius*Math.sin(theta))**2)-c.radius*Math.cos(theta),shift=(focus?1:-1)*c.zFfsSourceOffsetMm;
    groups.push({theta,focus,origin:c.feed*(beta-c.phase)/(2*Math.PI)+shift*(1-L/c.zFfsSourceDetectorMm),spacing:c.rowWidth*L/600});}
   for(const q of oracle(c,groups,z)){const g=groups[q.group],st=zffsRebinStencil(c,g.theta,g.focus);let value=0;for(const s of st.stencil)value+=s.weight*(zffsPointProjection(c,s.view,0).data.get(q.row+':'+s.channel)??0);sum+=q.weight*value/(c.viewSamples/2);}
  }
  near(sum,r.raw[iz]);checks++;
 }
}
const cases=[];
for(const rows of [4,80,160,320])for(const radius of [0,102,250])for(const T of [1,5])for(const axialRule of ['merged','rri']){
 const rowWidth=rows===4?1:.5,beamPitch=rows===4?.875:.5,zExtent=T+2*rowWidth*(1+radius/600)+2;
 const r=await computeAxialResponse({...base,rows,rowWidth,beamPitch,radius,axialRule,zExtent,axialAverageMm:T}),a=r.weightAudit;
 const closure=a.samples.reduce((s,q)=>s+q.weight*q.acquiredValue*a.db,0)-a.centerValue;near(closure,0,1e-9);
 assert.ok(r.counts.every(n=>n===180));assert.equal(r.volume,null);assert.ok(r.fwhm.width>0&&r.fwtm.width>=r.fwhm.width);near(Math.min(...r.profile),0);near(Math.max(...r.profile),1);
 assert.ok(a.samples.every(q=>q.focus===zffsState(q.view)));assert.equal(r.acquisition.viewsPerFocusPerTurn,90);
 cases.push({rows,radius,T,axialRule,fwhm:r.fwhm.width,fwtm:r.fwtm.width,closureError:closure});checks++;
}
const serial=await computeAxialResponseSeries({...base,phaseCount:4,axialRule:'rri'});
for(let k=0;k<4;k++){const single=await computeAxialResponse({...base,axialRule:'rri',phase:base.phase+k*Math.PI/2},{profileOnly:true});assert.deepEqual(serial.profiles[k].raw,single.raw);checks++;}
await assert.rejects(()=>computeAxialResponse(base,{cancelled:()=>true}),/CANCELLED/);
assert.throws(()=>axialResponseConfig({...base,zFfsMagnification:1.1}),/ZFFS_GEOMETRY/);
assert.throws(()=>axialResponseConfig({...base,axialRule:'parallel'}),/ZFFS_GEOMETRY/);
assert.throws(()=>axialResponseConfig({...base,viewSamples:181}),/AXIAL_VIEWS/);
writeFileSync(new URL('zffs-verification.json',import.meta.url),JSON.stringify({version:'2026-09-18.7',checks:checks+4,scope:'Implementation consistency of an ideal axial focal-switching extension; not scanner or publication-convergence validation',cases},null,2)+'\n');
console.log(`PASS: z-FFS ${checks+4} groups; Cartesian geometry, physical parity, same-focus interpolation, exhaustive weights, response oracle, off/zero regression, 48 multirow cases and trace closure`);
