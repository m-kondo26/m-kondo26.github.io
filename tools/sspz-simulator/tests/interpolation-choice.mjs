import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {computeAxialResponse} from '../axial-response-core.js';

// UI/worker propagation regression. This does not validate either response
// against a scanner, and does not replace the numerical interpolation tests.
const ui=fs.readFileSync(new URL('../fdk-ui.js',import.meta.url),'utf8');
const choice=fs.readFileSync(new URL('../model-choice.js',import.meta.url),'utf8');
const density=fs.readFileSync(new URL('../candidate-density-ui.js',import.meta.url),'utf8');
const elements=new Map();
class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.listeners=new Map();this.value='';this.disabled=false;this.hidden=false;this.dataset={};this.attributes={};this.textContent='';}
  set id(value){this._id=value;elements.set(value,this);}get id(){return this._id;}
  append(...children){this.children.push(...children);}
  add(option){this.children.push(option);if(!this.value)this.value=option.value;}
  setAttribute(key,value){this.attributes[key]=String(value);}
  addEventListener(type,fn){const callbacks=this.listeners.get(type)??[];callbacks.push(fn);this.listeners.set(type,callbacks);}
  fire(type){for(const fn of this.listeners.get(type)??[])fn({target:this});}
  querySelector(selector){return this.children.flatMap(child=>[child,...(child.children??[])]).find(child=>selector==='select'&&child.tagName==='SELECT');}
  createCaption(){const e=new Element('caption');this.append(e);return e;}
  createTHead(){const e=new Element('thead');this.append(e);return e;}
  createTBody(){const e=new Element('tbody');this.append(e);return e;}
  insertRow(){const e=new Element('tr');this.append(e);return e;}
  insertCell(){const e=new Element('td');this.append(e);return e;}
}
const el=id=>{if(!elements.has(id)){const element=new Element();element.id=id;}return elements.get(id);};
const fields=new Map(Object.entries({rowWidth:1,radius:102,sourceRadius:600,sliceThicknessMm:1,focalSizeMm:1.2,focalSourceDetectorMm:1070,beamPitch:.875}).map(([name,value])=>[name,{value:String(value)}]));
const resetButton=new Element('button'),runButton=new Element('button');
let modeChanges=0,scheduled=0;
const document={documentElement:{lang:'ja'},getElementById:el,createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})};
const runtime=vm.createContext({document,form:{elements:{namedItem:name=>fields.get(name)}},runButton,resetButton,
  Option:class extends Element{constructor(text,value){super('option');this.textContent=text;this.value=value;}},
  readZffsParams:()=>({zFfsEnabled:false}),URL,spatialExport:r=>r,
  modeChanged:()=>{modeChanges++;vm.runInContext('picker.sync()',runtime);},schedulePositionPreview:()=>scheduled++});
vm.runInContext(ui+'\n'+choice+'\n'+density,runtime);
const defaults=vm.runInContext('FDK_UI_FIELDS',runtime);
for(const [key,value]of Object.entries(defaults))el('fdk-'+key).value=value;
vm.runInContext('globalThis.picker=initializeAxialModelChoice({method:"rri"});globalThis.pick=picker.element;',runtime);
let checks=0;
assert.equal(el('fdk-method').hidden,false);
assert.equal(el('fdk-method').children.length,2);
assert.equal(el('fdk-method').value,'rri');
assert.match(el('model-choice-rule-description').textContent,/主解析/);
assert.match(el('model-choice-rule-scope').textContent,/2次元・3次元.*行うものではありません/);checks++;

// Read the actual form bridge and share-URL parser under both choices. Only the
// rule/required comparison-mode metadata can change these acquisition inputs.
const params={};
for(const rule of ['rri','merged']){
  el('fdk-method').value=rule;el('fdk-method').fire('change');
  params[rule]=vm.runInContext('readFdkParams()',runtime);
  assert.equal(params[rule].axialRule,rule);assert.equal(params[rule].method,rule);
  assert.equal(params[rule].comparisonMode,rule==='merged'?'legacy':'matched-rri');
  assert.equal(params[rule].computationModel,'fdk');
  const url=new URL('https://example.test/?model=rri&fdk_method=rri&v=20');
  runtime.url=url;runtime.params=params[rule];vm.runInContext('writeFdkUrl(url,params)',runtime);
  assert.equal(url.searchParams.get('model'),rule);assert.equal(url.searchParams.has('fdk_method'),false);
  runtime.query=url.searchParams;const restored=vm.runInContext('fdkParamsFromUrl(query)',runtime);
  assert.equal(restored.method,rule);assert.equal(restored.axialRule,rule);
  assert.equal(restored.comparisonMode,params[rule].comparisonMode);
  assert.equal(restored.legacyCbaComparison,false);
  runtime.input=params[rule];assert.equal(vm.runInContext('fdkInterpolationRule(input)',runtime),rule);
}
for(const key of Object.keys(params.rri).filter(key=>!['axialRule','method','comparisonMode'].includes(key)))assert.deepEqual(params.rri[key],params.merged[key],key);
assert.match(el('model-choice-rule-description').textContent,/文献との比較用/);checks++;
runtime.query=new URLSearchParams('model=axial&v=11');
assert.equal(vm.runInContext('fdkParamsFromUrl(query).axialRule',runtime),'rri');
runtime.query=new URLSearchParams('fdk_method=hsieh');
assert.equal(vm.runInContext('fdkParamsFromUrl(query).legacyCbaComparison',runtime),true);checks++;

// Exercise the actual initializer's change and reset registrations without
// reconstructing its many canvas panels. Observe invalidation callbacks.
const changeLine=ui.split(/\r?\n/).find(line=>line.includes("document.getElementById('fdk-method').addEventListener('change',()=>{modeChanged();"));
assert.ok(changeLine);
fields.get('beamPitch').addEventListener=()=>{};
el('position-preview');vm.runInContext(changeLine,runtime);
const prior=modeChanges;el('fdk-method').value='merged';el('fdk-method').fire('change');
assert.equal(modeChanges,prior+1);assert.equal(scheduled,1);
const resetLine=ui.split(/\r?\n/).find(line=>line.includes("resetButton.addEventListener('click',()=>{pick.querySelector('select')"));
assert.ok(resetLine);vm.runInContext(resetLine,runtime);resetButton.fire('click');
assert.equal(el('fdk-method').value,'rri');assert.equal(vm.runInContext('readFdkParams().axialRule',runtime),'rri');
assert.match(el('model-choice-rule-description').textContent,/主解析/);checks++;

document.documentElement.lang='en';vm.runInContext('initializeAxialModelChoice({method:"merged"})',runtime);
assert.equal(el('fdk-method').children[0].textContent,'Row interpolation by direction');
assert.equal(el('fdk-method').children[1].textContent,'Combined two-point interpolation');checks++;

// Export labels, filenames and metadata describe the result's rule, not the
// currently selected control. Numeric profile columns remain unmodified.
for(const rule of ['rri','merged']){
  const r={model:{kind:'axial-'+rule,version:'fixture'},config:{...params[rule],rows:4,rowWidth:1,radius:102,beamPitch:.875},z:[-1,0,1],profiles:[{raw:[0,2,0],profile:[0,1,0]}]};
  runtime.result=r;
  const rows=vm.runInContext('fdkCsvRows(result)',runtime);
  const configuration=JSON.parse(rows.find(row=>row[0]==='# configuration')[1]);
  assert.equal(configuration.axialRule,rule);
  assert.match(vm.runInContext('fdkFileStem(result)',runtime),rule==='merged'?/Combined two-point/:/Row interpolation/);
  assert.match(vm.runInContext('densityExportStem(result)',runtime),new RegExp('candidate-count-'+rule+'-'));
  assert.match(vm.runInContext('densitySettingsLabel(result)',runtime),rule==='merged'?/Combined two-point/:/Row interpolation/);
  runtime.name=vm.runInContext('fdkMethodName(result)',runtime);
  assert.ok(vm.runInContext('fdkSheetPrefix(name)',runtime).length+'_Mean_difference'.length<=31);
  r.config.zFfsEnabled=true;runtime.name=vm.runInContext('fdkMethodName(result)',runtime);
  assert.ok(vm.runInContext('fdkSheetPrefix(name)',runtime).length+'_Mean_difference'.length<=31);
}checks++;

// Real worker handler tests: numerical preview equals the direct core under
// the requested merged rule, and differs from RRI under identical geometry.
const workerSource=fs.readFileSync(new URL('../worker.js',import.meta.url),'utf8').replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\r?$/gm,'');
function workerHarness(extra){const messages=[],self={postMessage:message=>messages.push(message)};vm.runInNewContext(workerSource,{self,setTimeout,...extra});return {messages,send:data=>self.onmessage({data})};}
const base={rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,radius:0,viewSamples:90,zExtent:4,zStep:.1,axialAverageMm:1,phase:.37,phaseCount:360,fullFanAngleDeg:50,candidateSearch:'source-fan-window',axialRule:'merged',comparisonMode:'legacy'};
const real=workerHarness({computeAxialResponse});
await real.send({type:'position-preview',requestId:'merged',params:base});
const preview=real.messages.at(-1);assert.equal(preview.type,'position-preview-result');
const direct=await computeAxialResponse({...base,computationModel:'fdk'});
assert.deepEqual(preview.result,direct);assert.equal(preview.result.config.axialRule,'merged');
const rri=await computeAxialResponse({...base,axialRule:'rri',comparisonMode:'matched-rri'});
assert.ok(direct.profile.some((value,i)=>Math.abs(value-rri.profile[i])>1e-3));checks++;

// Full sweep, selected-angle inspection and animation must inherit the chosen
// rule. Labelled numerical results isolate message propagation from runtime.
const calls=[];
const resultFor=input=>({config:input,z:Float64Array.of(-1,0,1),profile:Float64Array.of(0,1,0)});
const routing=workerHarness({
  computeAxialResponseSeries:async(input,hooks)=>{calls.push({kind:'series',input,hooks});return resultFor(input);},
  computeAxialResponse:async input=>{calls.push({kind:'inspect',input});return resultFor(input);},
  createAxialAnimationAudit:async input=>{calls.push({kind:'animation',input});return {config:input};}
});
await routing.send({type:'fdk-run',params:base});
await routing.send({type:'fdk-inspect',index:37,requestId:'inspect'});
await routing.send({type:'axial-animation',index:37,requestId:'animation',mode:'thickness'});
assert.deepEqual(calls.map(call=>call.kind),['series','inspect','animation']);
for(const {input}of calls){assert.equal(input.axialRule,'merged');assert.equal(input.comparisonMode,'legacy');assert.equal(input.fullFanAngleDeg,base.fullFanAngleDeg);}
assert.equal(calls[0].hooks.captureDiagramFrames,true);
assert.equal(calls[1].input.phase,calls[2].input.phase);
assert.deepEqual(routing.messages.map(message=>message.type),['fdk-result','fdk-inspection','axial-animation']);checks++;
console.log(`PASS: interpolation choice ${checks} groups; visible bilingual rule, unchanged acquisition settings, URL/storage choice, reset, stale invalidation, export metadata, exact merged preview, sweep/inspection/animation routing. Not scanner validation.`);
