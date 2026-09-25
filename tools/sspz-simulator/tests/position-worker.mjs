import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {computeAxialResponse} from '../axial-response-core.js';

// Exercise the actual browser-worker handler, injecting its imported core.
// These reduced numerical fixtures check implementation and message lifecycle;
// they do not establish scanner reconstruction accuracy or convergence.
const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8')
  .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\r?$/gm,'');
function harness(compute=computeAxialResponse){
  const messages=[];
  const self={postMessage:message=>messages.push(message)};
  const context=vm.createContext({self,setTimeout,computeAxialResponse:compute});
  vm.runInContext(source,context,{filename:'worker.js'});
  return {messages,send:data=>self.onmessage({data})};
}
const fixed={computationModel:'fdk',axialRule:'rri',comparisonMode:'matched-rri'};
const base={rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,
  viewSamples:90,zExtent:4,zStep:.1,phaseCount:360,axialAverageMm:1,phase:.37};
let checks=0;
const real=harness();
for(const radius of [0,150]){
  const params={...base,radius,computationModel:'parallel',axialRule:'parallel',comparisonMode:'legacy'};
  await real.send({type:'position-preview',requestId:radius,params});
  const reply=real.messages.at(-1);
  assert.equal(reply.type,'position-preview-result');
  assert.equal(reply.requestId,radius);
  const direct=await computeAxialResponse({...params,...fixed});
  assert.deepEqual(reply.result,direct);
  assert.equal(reply.result.config.axialRule,'rri');
  assert.equal(reply.result.config.comparisonMode,'matched-rri');
  assert.ok(reply.result.weightAudit.samples.length>0);
  assert.ok(!reply.result.profiles,'A position preview must not run the 360-phase sweep');
  checks++;
}
assert.equal(real.messages.length,2,'Each preview emits only its one final reply');
// The preview keeps the production adaptive-domain behavior intact.
const domainParams={...base,radius:0,zExtent:1,axialAverageMm:5};
await real.send({type:'position-preview',requestId:'domain',params:domainParams});
const domain=real.messages.at(-1);
assert.equal(domain.type,'position-preview-result');
assert.ok(domain.result.domainCheck.expansions>0);
assert.deepEqual(domain.result,await computeAxialResponse({...domainParams,...fixed}));
checks++;
await real.send({type:'position-preview',requestId:'invalid',params:{...base,beamPitch:0}});
assert.equal(real.messages.at(-1).type,'position-preview-error');
assert.equal(real.messages.at(-1).requestId,'invalid');
assert.match(real.messages.at(-1).message,/AXIAL_GEOMETRY_ONLY/);
checks++;

// Controlled asynchronous completion makes stale-success and stale-error races
// deterministic, independently of how quickly a real fixture finishes.
const calls=[];
const races=harness((params,hooks)=>new Promise((resolve,reject)=>calls.push({params,hooks,resolve,reject})));
const first=races.send({type:'position-preview',requestId:'old',params:base});
const second=races.send({type:'position-preview',requestId:'new',params:base});
assert.equal(calls.length,2);
assert.equal(calls[0].hooks.cancelled(),true);
assert.equal(calls[1].hooks.cancelled(),false);
assert.equal(calls[1].hooks.lockDomain,undefined);
assert.equal(calls[1].params.axialRule,'rri');
calls[1].resolve({id:'new'});await second;
calls[0].resolve({id:'old'});await first;
assert.deepEqual(races.messages.map(m=>m.requestId),['new']);
checks++;
const oldError=races.send({type:'position-preview',requestId:'old-error',params:base});
const newAfterError=races.send({type:'position-preview',requestId:'after-error',params:base});
calls[2].reject(Error('stale failure'));await oldError;
calls[3].resolve({id:'after-error'});await newAfterError;
assert.deepEqual(races.messages.map(m=>m.requestId),['new','after-error']);
checks++;
const cancelled=races.send({type:'position-preview',requestId:'cancelled',params:base});
await races.send({type:'cancel'});
assert.equal(calls[4].hooks.cancelled(),true);
const restarted=races.send({type:'position-preview',requestId:'restarted',params:base});
assert.equal(calls[4].hooks.cancelled(),true,'Restart must not revive an older cancelled preview');
assert.equal(calls[5].hooks.cancelled(),false);
calls[4].reject(Error('FDK_CANCELLED'));await cancelled;
calls[5].resolve({id:'restarted'});await restarted;
assert.deepEqual(races.messages.map(m=>m.requestId),['new','after-error','restarted']);
checks++;
console.log(`PASS: position preview worker ${checks} groups; direct core equality at r=0/150 mm, adaptive domain, fixed cone/RRI mode, errors, stale requests and cancellation`);
