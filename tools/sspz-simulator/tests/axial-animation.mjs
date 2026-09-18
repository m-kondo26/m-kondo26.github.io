import assert from 'node:assert/strict';
import {computeAxialResponse} from '../axial-response-core.js';
import {createAxialAnimationAudit,axialAnimationIntegralCoefficients} from '../axial-animation-core.js';
import {fdkSlabCoefficients} from '../fdk-core.js';
const near=(a,b,label)=>assert.ok(Math.abs(a-b)<1e-10,`${label}: ${a} != ${b}`);
const base={rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,radius:100,viewSamples:180,zStep:.1,zExtent:8,phaseCount:1,phase:.4,state:0,channelWidth:.25,channelApertureMm:.25};
const cases=[...['merged','rri','parallel'].flatMap(axialRule=>[0,1,5].map(axialAverageMm=>({axialRule,axialAverageMm}))),
  {axialRule:'merged',axialAverageMm:5,radius:250,viewSamples:2400,zStep:.05},
  {axialRule:'merged',axialAverageMm:5,radius:250,state:.45,zExtent:7.833333333333333,zStep:.05},
  ...[80,160,320].map(rows=>({axialRule:'rri',axialAverageMm:1,rows,rowWidth:.5,beamPitch:.5})),
  ...[0,.25].map(zFfsOffset=>({axialRule:'merged',axialAverageMm:5,zFfsEnabled:true,zFfsOffset}))];
let checked=0;
for(const item of cases){
  const r=await computeAxialResponse({...base,...item}),before=JSON.stringify(r),c=r.config;
  const audit=await createAxialAnimationAudit(c,{frameCount:7,maxAngles:72});
  const expected=fdkSlabCoefficients(c.zSamples+2*Math.ceil(c.axialAverageMm/(2*c.zStep)),c.zStep,c.axialAverageMm);
  const actual=axialAnimationIntegralCoefficients(c,c.axialAverageMm/2);
  actual.forEach((v,i)=>near(v,expected[i],'full T coefficients'));
  assert.equal((c.viewSamples/2)%audit.stride,0,'preserve both roles on display lattice');
  const totalKey=p=>`${p.view}:${p.focus??0}:${p.row}`;
  if(c.zFfsEnabled){
    const merged=new Map();for(const p of audit.total)merged.set(totalKey(p),(merged.get(totalKey(p))??0)+p.weight);
    for(const [key,value] of merged){const expected=r.rebinnedWeightAudit.find(p=>totalKey(p)===key);assert.ok(expected);near(value,expected.weight,'FFS full T weight');checked++;}
  }else{
    const keys=new Map(r.weightAudit.pairedSamples.map(p=>[`${p.referenceView}:${p.direction}:${p.view}:${p.row}`,p]));
    const roles=new Map();for(const p of r.weightAudit.pairedSamples){const key=totalKey(p);if(!roles.has(key))roles.set(key,[0,0]);roles.get(key)[p.direction]+=p.weight;}
    for(const p of audit.total){const expected=keys.get(`${p.referenceView}:${p.direction}:${p.view}:${p.row}`);assert.ok(expected);near(p.weight,expected.weight,'ordinary full T weight');const role=roles.get(totalKey(p));near(p.directWeight,role[0],'direct role');near(p.complementaryWeight,role[1],'complementary role');checked++;}
  }
  for(const frame of audit.frames){
    const sums=new Map();for(const p of frame.instant)sums.set(p.referenceView,(sums.get(p.referenceView)??0)+p.weight);
    for(const sum of sums.values())near(sum,1,'instant pair sum');
    const coeff=axialAnimationIntegralCoefficients(c,frame.u);
    near(coeff.reduce((s,v)=>s+v,0),c.axialAverageMm===0?1:frame.fraction,'partial normalization uses full T');
  }
  assert.deepEqual(audit.frames.at(-1).accumulated,audit.total,'last frame equals existing total');
  if(c.axialAverageMm>0)assert.equal(audit.frames[0].accumulated.length,0);
  assert.equal(JSON.stringify(r),before,'display audit does not mutate original profiles or weights');
}
await assert.rejects(()=>createAxialAnimationAudit((awaitConfig()),{cancelled:()=>true}),/ANIMATION_CANCELLED/);
function awaitConfig(){return {rows:4,rowWidth:1,feed:3.5,viewSamples:180,sourceRadius:600,radius:100,phase:0,state:0,axialRule:'merged',edgePolicy:'available',axialAverageMm:5,zSamples:161,zStep:.1};}
console.log(JSON.stringify({status:'PASS',cases:cases.length,checked,checks:'native full-T coefficient equality; partial normalization; both role identities; finite aperture profiles unchanged; FFS and cancellation'}));
