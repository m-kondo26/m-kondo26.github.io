import assert from 'node:assert/strict';
import {axialResponseConfig} from '../axial-response-core.js';
import {createAxialAnimationAudit} from '../axial-animation-core.js';
import '../axial-angle-display.js';

const input={rows:320,rowWidth:.5,beamPitch:.5,sourceRadius:600,radius:102,
  viewSamples:360,zStep:.05,zExtent:3,phase:.31,state:0,
  channelWidth:.58,channelApertureMm:.58,axialAverageMm:1,axialRule:'merged'};
const inRange=(audit,range,p)=>{const a=SSPZAngles.offset(audit.config,audit.base,p.referenceView);return a>=range[0]-1e-10&&a<range[1]-1e-10;};
const key=p=>`${p.referenceView}:${p.direction}:${p.view}:${p.focus??0}:${p.row}`;
const compare=(actual,expected,label)=>{
  const reference=new Map(expected.map(p=>[key(p),p]));
  assert.equal(actual.length,reference.size,label+' point count');
  for(const p of actual){
    const q=reference.get(key(p));assert(q,label+' identity');
    for(const k of ['z','weight','directWeight','complementaryWeight'])assert.ok(Math.abs(p[k]-q[k])<2e-12,`${label} ${k}`);
  }
};
let checks=0;
for(const extra of [{},{axialRule:'rri'},{rows:4,rowWidth:1,beamPitch:.875,axialAverageMm:5},
  {rows:64,viewSamples:2400},{zFfsEnabled:true,zFfsOffset:.25}]){
  const c=axialResponseConfig({...input,...extra}),snapshot=JSON.stringify(c);
  const all=SSPZAngles.animation(await createAxialAnimationAudit(c,{frameCount:3,maxAngles:c.viewSamples}));
  for(const range of [[0,30],[165,195],[180,210],[330,360]]){
    const audit=SSPZAngles.animation(await createAxialAnimationAudit(c,{frameCount:3,angleRange:range}));
    assert.equal(audit.stride,1);assert.deepEqual(audit.angleRange,range);
    const visible=p=>inRange(audit,range,p);
    compare(audit.total.filter(visible),all.total.filter(visible),'total');
    for(let i=0;i<audit.frames.length;i++){
      for(const kind of ['instant','accumulated'])compare(audit.frames[i][kind].filter(visible),all.frames[i][kind].filter(visible),`frame ${i} ${kind}`);
      assert.equal(new Set(audit.frames[i].instant.filter(visible).map(p=>p.referenceView)).size,c.viewSamples/12,'every native direction in 30-degree window');
    }
    assert(audit.total.length<all.total.length/3,'worker retains only window pairs, not all native views');
    checks++;
  }
  assert.equal(JSON.stringify(c),snapshot,'display requests do not mutate scientific configuration');
}
const c=axialResponseConfig(input);
assert.deepEqual(await createAxialAnimationAudit(c,{frameCount:1}),await createAxialAnimationAudit(c,{frameCount:1,maxAngles:72,angleRange:null}),'overview remains the original sampled display');
for(const range of [[-1,30],[330,361],[10,10],[NaN,30],[0,30,40]])await assert.rejects(()=>createAxialAnimationAudit(c,{angleRange:range}),/ANIMATION_ANGLE_RANGE/);
await assert.rejects(()=>createAxialAnimationAudit(c,{angleRange:[0,30],cancelled:()=>true}),/ANIMATION_CANCELLED/);
console.log(JSON.stringify({status:'PASS',cases:checks,checks:'native angle coverage; identity/weight/role equivalence to full native audit; bounded worker output; default unchanged; invalid range; cancellation'}));
