import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {axialPairWeights,axialResponseConfig,computeAxialResponse,computeAxialResponseSeries} from '../axial-response-core.js';
import {cbaCoordinates,cbaRebinAt} from '../cba-core.js';
import {detectorPointProjection} from '../detector-aperture.js';
const near=(a,b,t=1e-10)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
let checks=0;
// Independent all-row enumeration: no floor/ceil shortcut.
function oracle(c,a,b,z){
 const all=[a,b].flatMap((q,direction)=>Array.from({length:c.rows},(_,row)=>({row,direction,z:q.sourceZ+(row-(c.rows-1)/2)*q.spacing,weight:0,spacing:q.spacing})));
 if(c.axialRule==='rri')for(const q of all)q.weight=Math.max(0,1-Math.abs(z-q.z)/q.spacing);
 else{
  const eq=all.filter(q=>Math.abs(q.z-z)<1e-10);
  if(eq.length)eq.forEach(q=>q.weight=1/eq.length);
  else{
   const low=all.filter(q=>q.z<z).sort((x,y)=>y.z-x.z),high=all.filter(q=>q.z>z).sort((x,y)=>x.z-y.z);
   if(!low.length||!high.length)throw Error('coverage');
   const lo=low.filter(q=>Math.abs(q.z-low[0].z)<1e-10),hi=high.filter(q=>Math.abs(q.z-high[0].z)<1e-10),gap=hi[0].z-lo[0].z;
   lo.forEach(q=>q.weight=(hi[0].z-z)/gap/lo.length);hi.forEach(q=>q.weight=(z-lo[0].z)/gap/hi.length);
  }
 }
 const sum=all.reduce((s,q)=>s+q.weight,0);if(sum<1e-14)throw Error('coverage');
 return all.filter(q=>q.weight>1e-13).map(q=>({...q,weight:q.weight/sum}));
}
for(const rows of [4,80,160,320])for(const axialRule of ['merged','rri'])for(const z of [-1,-.17,0,.5,1.2]){
 const c={rows,axialRule,edgePolicy:'available'},a={sourceZ:-.5,spacing:.7},b={sourceZ:.875,spacing:1.12};
 let expected;try{expected=oracle(c,a,b,z);}catch{assert.throws(()=>axialPairWeights(c,a,b,z));continue;}
 const actual=axialPairWeights(c,a,b,z);near(actual.reduce((s,q)=>s+q.weight,0),1);
 for(const q of expected)near(actual.find(v=>v.row===q.row&&v.direction===q.direction)?.weight??0,q.weight);
 checks++;
}
// Chapter 3 Eq. 3-32 and 3-62: flat detector ray and cylindrical model ray
// are collinear after beta_book=beta-pi/2, X_book=-u, Z_book=v.
for(const radius of [0,102,250])for(const theta of [-2,.3,2.8,8])for(const z of [-5,0,7]){
 const c=axialResponseConfig({rows:80,radius}),q=cbaCoordinates(c,theta,radius,0,z),B=q.beta-Math.PI/2,R=c.sourceRadius;
 const S=[-R*Math.sin(B),R*Math.cos(B),q.sourceZ],P=[radius,0,z],V=P.map((x,i)=>x-S[i]);
 const j=[-Math.sin(B),Math.cos(B)],i=[Math.cos(B),Math.sin(B)],den=R-P[0]*j[0]-P[1]*j[1];
 const X=R*(P[0]*i[0]+P[1]*i[1])/den,Z=R*(z-S[2])/den;
 const ray=[X*Math.cos(B)+R*Math.sin(B),X*Math.sin(B)-R*Math.cos(B),Z];
 for(let k=0;k<3;k++)near(ray[k]/Math.hypot(...ray),V[k]/Math.hypot(...V));
 near(q.w,Z*Math.cos(q.gamma));near(X,-R*Math.tan(q.gamma));checks++;
}
const base={rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,radius:102,viewSamples:180,zExtent:4,zStep:.1,phaseCount:1,axialAverageMm:0,phase:.37};
// Slow direct row enumeration and full data readout independently reproduce
// the moving-plane response at grid locations (without the cache/sparse shortcut).
for(const axialRule of ['merged','rri']){
 const r=await computeAxialResponse({...base,axialRule,candidateSearch:'one-turn'}),c=r.config,db=2*Math.PI/c.viewSamples;
 const rawAt=v=>detectorPointProjection({...c,sourceZ:c.feed*v/c.viewSamples},c.phase+v*db,0);
 for(const iz of [30,36,40,45,49]){
  const z=r.z[iz],start=Math.ceil((2*Math.PI*z/c.feed-Math.PI)/db-1e-12);let sum=0;
  for(let v=start;v<start+c.viewSamples/2;v++){
   const th=c.phase+v*db,qs=[cbaCoordinates(c,th,c.radius,0,z),cbaCoordinates(c,th+Math.PI,c.radius,0,z)];
   qs.forEach(q=>q.spacing=c.rowWidth*q.L/c.sourceRadius);
   for(const w of oracle(c,...qs,z))sum+=w.weight*cbaRebinAt(c,rawAt,th+w.direction*Math.PI,qs[w.direction].t,w.row)/(c.viewSamples/2);
  }
  near(sum,r.raw[iz]);checks++;
 }
}
const cases=[];
for(const rows of [4,80,160,320])for(const radius of [0,102,250])for(const T of [1,5])for(const axialRule of ['merged','rri']){
 const rowWidth=rows===4?1:.5,beamPitch=rows===4?.875:.5,zExtent=T+2*rowWidth*(1+radius/600);
 const r=await computeAxialResponse({...base,rows,rowWidth,beamPitch,radius,axialRule,zExtent,axialAverageMm:T});
 const a=r.weightAudit;near(a.samples.reduce((s,q)=>s+q.weight*q.acquiredValue*a.db,0),a.centerValue,1e-9);
 assert.equal(r.volume,null);assert.ok(r.counts.every(v=>v===180));near(Math.min(...r.profile),0);near(Math.max(...r.profile),1);
 assert.ok(r.fwhm.width>0&&r.fwtm.width>=r.fwhm.width);
 cases.push({rows,radius,T,axialRule,fwhm:r.fwhm.width,fwtm:r.fwtm.width,closureError:a.samples.reduce((s,q)=>s+q.weight*q.acquiredValue*a.db,0)-a.centerValue});checks++;
}
const serial=await computeAxialResponseSeries({...base,axialRule:'rri',axialAverageMm:1,phaseCount:4});
for(let k=0;k<4;k++){
 const single=await computeAxialResponse({...base,axialRule:'rri',axialAverageMm:1,phase:base.phase+k*Math.PI/2},{profileOnly:true});
 assert.deepEqual(single.profile,serial.profiles[k].profile);checks++;
}
await assert.rejects(()=>computeAxialResponse({...base,axialRule:'rri'},{cancelled:()=>true}),/CANCELLED/);
const gap=await computeAxialResponse({...base,radius:0,channelApertureMm:.1});assert.equal(gap.geometryOnly,true);assert.ok(gap.weightAudit.samples.length>0);
await assert.rejects(()=>computeAxialResponse({...base,beamPitch:0}),/GEOMETRY_ONLY/);
assert.throws(()=>axialPairWeights({rows:4,axialRule:'rri',edgePolicy:'strict'},{sourceZ:0,spacing:1},{sourceZ:10,spacing:1},0),/COVERAGE/);
const flat=await computeAxialResponse({...base,axialRule:'parallel',axialAverageMm:1});near(flat.weightAudit.samples.reduce((s,q)=>s+q.weight*q.acquiredValue*flat.weightAudit.db,0),flat.weightAudit.centerValue);
writeFileSync(new URL('axial-response-verification.json',import.meta.url),JSON.stringify({version:'2026-09-18.7',checks:checks+5,scope:'Implementation consistency and coordinate checks; not scanner validation or final manuscript convergence',cases},null,2)+'\n');
console.log(`PASS: axial response ${checks+5} groups, including chapter-3 coordinates, exhaustive weights, direct response oracle, 48 multirow cases, and trace closure`);
