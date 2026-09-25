import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Lifecycle regression only. Labelled plot data stand in for the completed
// 360-angle response; the existing shape-display tests verify the arithmetic.
const workflow=readFileSync(new URL('../fdk-workflow.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../fdk-ui.js',import.meta.url),'utf8');
function sourceFunction(source,name){
  const start=new RegExp(`^function ${name}\\(`,'m').exec(source);assert.ok(start,name);
  const next=/^function /gm;next.lastIndex=start.index+start[0].length;
  return source.slice(start.index,next.exec(source)?.index??source.length).trim();
}
class Element{
  constructor(id){this.id=id;this.hidden=false;this.disabled=false;this.textContent='';this.dataset={};this.attributes={};this.pixels=[];}
  setAttribute(key,value){this.attributes[key]=String(value);}
  querySelectorAll(selector){return selector==='canvas'?canvases:[];}
  getContext(){return {clearRect:()=>assert.fail('A lifecycle update must retain plotted pixels')};}
}
const elements=new Map(),el=id=>elements.get(id)??elements.set(id,new Element(id)).get(id);
const canvases=['fdk-difference','fdk-shape'].map(el);
const section=el('sspz-variation'),status=el('sspz-variation-status'),button=el('sspz-variation-calculate');
const pitch={value:'.875'},renderCalls=[];
const runtime=vm.createContext({
  document:{getElementById:el},form:{elements:{namedItem:name=>{assert.equal(name,'beamPitch');return pitch;}}},
  fdkText:(_ja,en)=>en,fdkShapeGroups:null,
  fdkDrawProfile:(canvas,result)=>{canvas.pixels=[result.label];renderCalls.push({kind:'profile',result});},
  SSPZShapeDisplay:{fromFdk:result=>[{name:'fixture',analysis:{valid:result.profiles.map((_,i)=>i)}}]},
  drawFdkShape:canvas=>{canvas.pixels=['aligned-shape'];renderCalls.push({kind:'shape'});},
  drawFdkDifference:(canvas,result)=>{canvas.pixels=[result.label,'mean-difference'];renderCalls.push({kind:'difference',result});},
});
vm.runInContext(sourceFunction(workflow,'updateSspzVariation')+'\n'+sourceFunction(ui,'renderFdkResult'),runtime);
const update=(state,result=null,message='')=>{runtime.state=state;runtime.result=result;runtime.message=message;vm.runInContext('updateSspzVariation(state,result,message)',runtime);};
const render=result=>{runtime.result=result;vm.runInContext('renderFdkResult(result)',runtime);};
const makeResult=(radius=123,label='first')=>({label,config:{radius,rows:4,rowWidth:1,beamPitch:.875,axialAverageMm:1,viewSamples:360},profiles:Array.from({length:360},(_,i)=>({phase:i*Math.PI/180}))});
const snapshot=()=>canvases.map(canvas=>[...canvas.pixels]);
let checks=0;

// The feature remains discoverable before the first complete sweep. A single
// preview does not pretend to provide a mean or shape-variation distribution.
update('idle');
assert.equal(section.hidden,false);assert.equal(section.dataset.renderState,'idle');
assert.equal(el('fdk-difference-wrap').hidden,true);assert.equal(el('fdk-shape-wrap').hidden,true);
assert.match(status.textContent,/Calculate 360 start angles/);assert.equal(button.disabled,false);
assert.equal(section.dataset.resultSettings,undefined);assert.equal(renderCalls.length,0);
for(const canvas of canvases)assert.equal(canvas.dataset.renderState,'idle');checks++;

// Initial unavailable/loading/error states remain visible and actionable;
// only the ongoing sweep disables the button, with no invented plot data.
update('unavailable',null,'No acquired point response.');
assert.equal(section.hidden,false);assert.match(status.textContent,/No SSPz response.*No acquired point response/);
assert.equal(button.disabled,false);assert.equal(section.dataset.profileCount,undefined);
update('loading');assert.equal(button.disabled,true);
for(const canvas of canvases)assert.equal(canvas.attributes['aria-busy'],'true');
update('error',null,'fixture worker failure');assert.equal(button.disabled,false);
assert.match(status.textContent,/did not complete.*fixture worker failure/);
assert.equal(el('fdk-difference-wrap').hidden,true);assert.equal(el('fdk-shape-wrap').hidden,true);
assert.equal(renderCalls.length,0);checks++;

// A completed sweep uses the existing production render entry point. It
// reveals both plots and records the exact prior settings for later retention.
const first=makeResult();render(first);
assert.equal(el('fdk-difference-wrap').hidden,false);assert.equal(el('fdk-shape-wrap').hidden,false);
assert.equal(section.dataset.renderState,'ready');assert.equal(section.dataset.profileCount,'360');
assert.match(section.dataset.resultSettings,/r = 123 mm.*4 rows × 1 mm.*pitch 0\.875.*T = 1 mm.*360 views\/turn.*360 start angles/);
assert.ok(status.textContent.includes(section.dataset.resultSettings));assert.equal(button.disabled,false);
assert.deepEqual(renderCalls.map(call=>call.kind),['profile','shape','difference']);
assert.equal(renderCalls.find(call=>call.kind==='difference').result,first);
for(const canvas of canvases){assert.equal(canvas.dataset.renderState,'ready');assert.equal(canvas.attributes['aria-busy'],'false');}checks++;

// Re-previewing or retrying retains the previous native canvas pixels. Their
// explicit label prevents a retained plot being read as the new position.
const pixels=snapshot(),prior=section.dataset.resultSettings,paintCount=renderCalls.length;
for(const state of ['idle','loading','error','unavailable']){
  update(state,null,state==='error'?'fixture failure':'');
  assert.equal(section.hidden,false);assert.equal(section.dataset.resultSettings,prior);
  assert.deepEqual(snapshot(),pixels);assert.equal(renderCalls.length,paintCount);
  assert.equal(el('fdk-difference-wrap').hidden,false);assert.equal(el('fdk-shape-wrap').hidden,false);
  assert.match(status.textContent,/previous settings.*Recalculate for the current settings/);
  assert.ok(status.textContent.includes(prior));assert.equal(button.disabled,state==='loading');
  for(const canvas of canvases){assert.equal(canvas.dataset.renderState,'stale');assert.equal(canvas.attributes['aria-busy'],String(state==='loading'));}
}checks++;

// New full-sweep results replace the old conditions and clear stale labels.
const second=makeResult(87,'second');render(second);
assert.match(section.dataset.resultSettings,/r = 87 mm/);assert.doesNotMatch(section.dataset.resultSettings,/123/);
assert.doesNotMatch(status.textContent,/previous settings/);assert.equal(section.dataset.renderState,'ready');
assert.deepEqual(canvases[0].pixels,['second','mean-difference']);
for(const canvas of canvases)assert.equal(canvas.dataset.renderState,'ready');checks++;

// Stationary-table mode hides this helical-only display; returning to positive
// pitch restores the feature and still identifies the retained plots as old.
pitch.value='0';update('idle');assert.equal(section.hidden,true);
pitch.value='.625';update('idle');assert.equal(section.hidden,false);
assert.match(status.textContent,/previous settings/);assert.equal(section.dataset.profileCount,'360');checks++;

console.log(`PASS: persistent SSPz variation UI ${checks} groups; discoverability, existing plot rendering, retained pixels, stale provenance, failure recovery and pitch visibility`);
