import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {DEFAULT_PARAMS,RECONSTRUCTION_PATHS} from '../sim-core.js';
import {finalizeEnglishHtml} from '../scripts/english-replacements.mjs';

// Exercise the actual browser parameter functions and input handler without
// loading a page or starting the spatial worker.
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const defaultSource=source.match(/const WEB_DEFAULT_PARAMS = Object\.freeze\(\{[\s\S]*?\}\);/)[0];
const functions=source.slice(source.indexOf('function parseRotationTime('),source.indexOf('function updateInputDecorations('))
  +source.slice(source.indexOf('function paramsToUrl('),source.indexOf('function setBusy('))
  +source.slice(source.indexOf('function persistTemporalSettings('),source.indexOf('inspectState?.addEventListener',source.indexOf('function persistTemporalSettings(')));
const initialSource=source.slice(source.indexOf('const initial = paramsFromUrl()'),source.indexOf('})();',source.indexOf('const initial = paramsFromUrl()'))+5);
const values={rows:4,rowWidth:1,channelWidth:.58,channelApertureMm:.58,focalSizeMm:1.2,focalSourceDetectorMm:1070,
  beamPitch:.875,rotationTime:.5,sourceRadius:600,radius:100,sliceThicknessMm:1,filterWidthMm:1,filterSamples:129,
  profileMode:'taguchi-filter',reconstructionPath:DEFAULT_PARAMS.reconstructionPath,viewSamples:360,zSamples:801};
const fields=new Map(Object.entries(values).map(([name,value])=>[name,{name,value:String(value),disabled:false}]));
const handlers=new Map(),storage=new Map();let temporalRefreshes=0,spatialRequests=0,decorations=0,languageSearch='',lastUrl=null;
const form={elements:{namedItem:name=>fields.get(name)},addEventListener:(event,callback)=>handlers.set(event,callback)};
const location={href:'http://127.0.0.1/index.html',search:'',pathname:'/index.html'};
const context={DEFAULT_PARAMS,RECONSTRUCTION_PATHS,form,window:{location},URL,URLSearchParams,
  selectedStateIndex:73,legacyInputMigrated:false,metricSelect:{value:'fwhm'},fdkRunParams:{rotationTime:.5},
  FormData:class {constructor(){this.fields=fields;}get(name){const input=this.fields.get(name);return !input||input.disabled?null:input.value;}},
  readFdkParams:()=>({phase:.37,axialRule:'rri'}),writeFdkUrl:(url)=>url.searchParams.set('model','rri'),
  fdkParamsFromUrl:()=>({phase:.37,axialRule:'rri'}),
  reconstructionPathUrlValue:()=> '180li',reconstructionPathFromUrl:()=>DEFAULT_PARAMS.reconstructionPath,
  updateInputDecorations:()=>decorations++,refreshTemporalDisplay:()=>temporalRefreshes++,
  schedulePositionPreview:()=>spatialRequests++,syncLanguageLinks:search=>languageSearch=search,
  history:{replaceState:(_state,_title,url)=>{lastUrl=url;}},
  localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
};
vm.createContext(context);
vm.runInContext(defaultSource+'\n'+functions+'\n'+`globalThis.api={readParams,writeParams,readRotationTime,parseRotationTime,
  rotationTimeFromSettings,paramsToUrl,paramsFromUrl,persistTemporalSettings,defaults:WEB_DEFAULT_PARAMS};`,context);
const api=context.api,rotation=fields.get('rotationTime');
const input=value=>{rotation.value=value;handlers.get('input')({target:rotation});};
const fromUrl=query=>{location.search=query;return api.paramsFromUrl();};
let checks=0;

// Match the restored control's historical units, bounds, default, and name.
assert.match(html,/<input id="rotationTime" name="rotationTime" type="number" min="0\.05" max="5" step="0\.05" value="0\.5" required>/);
assert.match(finalizeEnglishHtml(html),/<label>Rotation time <span class="unit">s\/rot<\/span>/);
assert.equal(api.defaults.rotationTime,.5);
assert.equal(api.readParams().rotationTime,.5);checks++;

// A rotation-only edit redraws temporal data and persists it without triggering
// new SSPz/360-angle work, including while the spatial form is disabled.
input('.75');assert.equal(temporalRefreshes,1);assert.equal(spatialRequests,0);
assert.equal(lastUrl.searchParams.get('rt'),'0.75');assert.equal(lastUrl.searchParams.get('vs'),'73');
assert.equal(new URLSearchParams(languageSearch).get('rt'),'0.75');
assert.equal(JSON.parse(storage.get('sspz-unwrapped-params')).rotationTime,.75);
assert.equal(context.fdkRunParams.rotationTime,.75);
for(const field of fields.values())if(field!==rotation)field.disabled=true;
input('1');const storedDuringSweep=JSON.parse(storage.get('sspz-unwrapped-params'));
assert.equal(storedDuringSweep.rotationTime,1);assert.equal(storedDuringSweep.radius,100);
assert.equal(storedDuringSweep.rows,4);assert.equal(storedDuringSweep.beamPitch,.875);
assert.equal(lastUrl.searchParams.get('n'),'4');assert.equal(lastUrl.searchParams.get('r'),'100');
assert.equal(temporalRefreshes,2);assert.equal(spatialRequests,0);
for(const field of fields.values())field.disabled=false;
handlers.get('input')({target:fields.get('radius')});assert.equal(spatialRequests,1);checks++;

// Invalid input remains invalid; zero, blank and non-finite values must never
// silently provide a valid zero-second time scale or the default time.
for(const value of ['', '0', '-1', 'NaN', 'Infinity', '0.049', '5.01']){
  input(value);assert.ok(Number.isNaN(api.readRotationTime()),value);
  assert.ok(Number.isNaN(api.readParams().rotationTime),value);
}
assert.equal(spatialRequests,1);
for(const value of ['0.05','0.63','0.75','5']){rotation.value=value;assert.equal(api.readRotationTime(),Number(value));}
checks++;

// Canonical rt and historical aliases restore seconds and keep the inspected
// angle. Missing time uses .5; invalid explicit time does not fall back.
for(const key of ['rt','rotationTime','rotationTimeSec']){
  const params=fromUrl(`?v=15&${key}=0.75&vs=123`);
  assert.equal(params.rotationTime,.75);assert.equal(context.selectedStateIndex,123);
  const url=api.paramsToUrl(params);assert.equal(url.searchParams.get('rt'),'0.75');
  assert.equal(url.searchParams.has('rotationTime'),false);assert.equal(url.searchParams.has('rotationTimeSec'),false);
}
assert.equal(fromUrl('?r=100').rotationTime,.5);
assert.equal(fromUrl('?rt=.75&rotationTime=1&rotationTimeSec=2').rotationTime,.75);
for(const suffix of ['','0','Infinity','6'])assert.ok(Number.isNaN(fromUrl(`?rt=${suffix}`).rotationTime));
checks++;

// Storage migration and resetting use the same canonical value. An explicitly
// invalid value serialized as JSON null stays blank instead of becoming zero.
location.search='';
const loadStored=value=>{storage.set('sspz-unwrapped-params',JSON.stringify(value));return vm.runInContext(`(()=>{${initialSource}\nreturn initial;})()`,context);};
for(const key of ['rotationTime','rotationTimeSec'])assert.equal(loadStored({...DEFAULT_PARAMS,[key]:.75}).rotationTime,.75);
assert.equal(loadStored({...DEFAULT_PARAMS}).rotationTime,.5);
const invalid=loadStored({...DEFAULT_PARAMS,rotationTime:null});assert.ok(Number.isNaN(invalid.rotationTime));
api.writeParams(invalid);assert.equal(rotation.value,'');assert.ok(Number.isNaN(api.readRotationTime()));
api.writeParams({...DEFAULT_PARAMS,rotationTimeSec:.75});assert.equal(Number(rotation.value),.75);
api.writeParams(api.defaults);assert.equal(Number(rotation.value),.5);checks++;

console.log(`PASS: rotation input ${checks} groups; restored control, temporal-only edits, disabled-form persistence, URL aliases, invalid values and storage/reset`);
