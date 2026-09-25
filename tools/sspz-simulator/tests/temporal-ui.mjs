import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Production independent-HFI UI and export lifecycle. Numerical validation is
// separate; the labelled curves below stand in for already calculated data.
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function sourceFunction(name){
  const start=new RegExp(`^function ${name}\\(`,'m').exec(app);assert.ok(start,name);
  const next=/^function /gm;next.lastIndex=start.index+start[0].length;
  return app.slice(start.index,next.exec(app)?.index??app.length).trim();
}
const elements=new Map(),downloads=[],axesCalls=[],coreCalls=[],insertions=[];
let persistCalls=0;
class Context {
  constructor(canvas){this.canvas=canvas;this.events=[];this.stack=[];this.state={strokeStyle:'#000',fillStyle:'#000',globalAlpha:1,lineWidth:1};}
  save(){this.stack.push({...this.state});}
  restore(){assert.ok(this.stack.length);this.state=this.stack.pop();}
  beginPath(){this.path=[];}
  moveTo(x,y){this.path.push({op:'M',x,y});}
  lineTo(x,y){this.path.push({op:'L',x,y});}
  rect(){}
  clip(){}
  stroke(){this.events.push({kind:'stroke',...this.state,path:this.path.map(p=>({...p}))});}
  fillText(text,x,y){this.events.push({kind:'text',text,x,y,...this.state});}
  setLineDash(){}
}
for(const key of ['strokeStyle','fillStyle','globalAlpha','lineWidth','font','textAlign'])Object.defineProperty(Context.prototype,key,{get(){return this.state[key];},set(value){this.state[key]=value;}});
class Element {
  constructor(tag='div',id=''){this.tag=tag;this.dataset={};this.width=1100;this.height=660;this.value='';this.disabled=false;this.textContent='';this.attributes={};this.listeners=new Map();if(id)this.id=id;}
  set id(value){this._id=value;elements.set(value,this);}
  get id(){return this._id;}
  set innerHTML(value){
    this.html=value;
    for(const match of value.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)){
      const child=new Element(match[1],match[2]);child.disabled=/\bdisabled\b/.test(match[0]);
      for(const key of ['value','width','height','min','max','step']){const attr=match[0].match(new RegExp(`\\b${key}="([^"]+)"`));if(attr)child[key]=attr[1];}
    }
  }
  getContext(){return this.ctx??=new Context(this);}
  removeAttribute(key){delete this.attributes[key];}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(type,handler){const callbacks=this.listeners.get(type)??[];callbacks.push(handler);this.listeners.set(type,callbacks);}
  after(child){insertions.push({after:this.id,child:child.id});}
  checkValidity(){const n=Number(this.value);return this.value!==''&&Number.isFinite(n)&&(this.min==null||n>=Number(this.min))&&(this.max==null||n<=Number(this.max));}
}
const make=(id,tag='div')=>elements.get(id)??new Element(tag,id),el=id=>elements.get(id);
const fields=new Map(Object.entries({rowWidth:1,beamPitch:.875,rotationTime:.5,rows:80,radius:123,phase:1.23,sliceThicknessMm:5,focalSizeMm:1.2,viewSamples:360}).map(([id,value])=>{const e=make(id,'input');e.value=String(value);return [id,e];}));
make('fdk-panel');const ssp=make('position-profile','canvas'),sspSave=make('position-json');sspSave.disabled=false;
const nativeTimes=Float64Array.of(-1.2,-.7,-.2,.3,.8,1.3),nativeProfile=Float64Array.of(0,.2,1,0,.35,0);
function response(config){return {version:'ui-fixture',method:'taguchi-hfi-central-axis-reference',config:{...config,radius:0},timeTurns:nativeTimes.slice(),raw:Float64Array.from(nativeProfile,v=>v*2),profile:nativeProfile.slice(),metrics:{fwhmTurns:.4,fwtmTurns:1.2,equivalentWidthTurns:.6,fwhmMs:.4*config.rotationTime*1000,fwtmMs:1.2*config.rotationTime*1000,equivalentWidthMs:.6*config.rotationTime*1000,fwhmIntervals:1,fwtmIntervals:1},provenance:{input:'interpolation coefficients only',fig5Reproduction:'not-established'},audit:{fixture:true}};}
let coreImplementation=config=>response(config);
const runtime=vm.createContext({
  document:{getElementById:el,createElement:tag=>new Element(tag)},
  form:{elements:{namedItem:name=>fields.get(name)}},fdkText:(_ja,en)=>en,FIGURE_FONT:'Arial',loadingCanvasStatuses:new Map(),setTimeout,
  persistTemporalSettings:()=>persistCalls++,
  runSimulation:()=>assert.fail('HFI must not start the SSP simulation'),
  schedulePositionPreview:()=>assert.fail('HFI must not schedule an SSP preview'),
  Worker:class{constructor(){assert.fail('HFI must not create an SSP worker');}},
  SSPZTaguchi:{computeTaguchiTsp:config=>{coreCalls.push({...config});return coreImplementation(config);}},
  symmetricNiceAxis:bound=>({xMax:bound}),
  fdkAxes:(canvas,xMin,xMax,yMin,yMax,xLabel,yLabel)=>{axesCalls.push({canvas,xMin,xMax,yMin,yMax,xLabel,yLabel});return {ctx:canvas.getContext('2d'),b:{left:0,right:1100,top:0,bottom:660},x:v=>v,y:v=>v};},
  drawCanvasStatus:(canvas,title,message,state)=>{canvas.getContext('2d').events.push({kind:'status',title,message,state});canvas.dataset.renderState=state;},
  csvEscape:value=>{const s=String(value??'');return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;},
  downloadBlob:(filename,body,mime)=>downloads.push({filename,body,mime}),
});
vm.runInContext(['parseRotationTime','readRotationTime','strokeNativeProfile'].map(sourceFunction).join('\n')+'\n'+readFileSync(new URL('../temporal-ui.js',import.meta.url),'utf8')+'\nglobalThis.uiState={get result(){return taguchiResult;},get valid(){return taguchiResultValid;}};',runtime);
const run=code=>vm.runInContext(code,runtime),plain=value=>JSON.parse(JSON.stringify(value));
async function fire(id,event='click',value){const element=el(id);assert.ok(element,id);if(value!==undefined)element.value=String(value);const e={target:element};await element[`on${event}`]?.(e);for(const callback of element.listeners.get(event)??[])await callback(e);}
const plot=()=>el('taguchi-tsp-plot'),lastCurve=()=>plot().getContext('2d').events.filter(e=>e.kind==='stroke'&&e.strokeStyle==='#176b87').at(-1);
const coordinates=stroke=>stroke.path.filter(p=>p.op==='M'||p.op==='L').map(p=>[p.x,p.y]);
const expected=scale=>Array.from(nativeTimes,(t,i)=>[t*scale,nativeProfile[i]]);
let checks=0;

// Separate explicit calculation after full SSP results, without stacked TSP.
// FW must not be silently copied from the unrelated SSP thickness.
run('initializeTaguchiUi()');el('tsp-time-unit').value='ms';
assert.deepEqual(insertions,[{after:'fdk-panel',child:'taguchi-tsp'}]);
for(const id of ['position-tsp','position-tsp-card','fdk-tsp'])assert.equal(el(id),undefined);
assert.equal(coreCalls.length,0);assert.equal(plot().dataset.renderState,'idle');
assert.equal(el('taguchi-filter-width').value,'1');assert.equal(fields.get('sliceThicknessMm').value,'5');
assert.equal(el('taguchi-csv').disabled,true);assert.equal(el('taguchi-json').disabled,true);checks++;

await fire('taguchi-calculate');
assert.equal(coreCalls.length,1);
assert.deepEqual(coreCalls[0],{rows:4,rowWidth:1,beamPitch:.875,filterWidthMm:1,rotationTime:.5,viewSamples:7200});
assert.equal(plot().dataset.radiusMm,'0');assert.equal(plot().dataset.rows,'4');assert.equal(plot().dataset.renderState,'ready');
assert.deepEqual(coordinates(lastCurve()),expected(500));
assert.match(el('taguchi-tsp-stats').textContent,/FWHM 200\.0 ms.*FWTM 600\.0 ms.*Teq 300\.0 ms/);
assert.equal(ssp.getContext('2d').events.length,0);assert.equal(sspSave.disabled,false);checks++;

// Radius, phase, focal size and acquired-view count are not HFI arguments.
// The explicit copy action copies row width/pitch, retaining independent FW.
for(const [id,value] of Object.entries({radius:240,phase:4.1,rows:320,rowWidth:3,beamPitch:1.5,sliceThicknessMm:8,viewSamples:1440,focalSizeMm:2}))fields.get(id).value=String(value);
const priorCurve=lastCurve();run('refreshTemporalDisplay()');
assert.equal(coreCalls.length,1);assert.deepEqual(coordinates(lastCurve()),coordinates(priorCurve));
assert.deepEqual(plain(run('taguchiSettings()')),coreCalls[0]);
await fire('taguchi-copy');
assert.equal(el('taguchi-row-width').value,'3');assert.equal(el('taguchi-pitch').value,'1.5');assert.equal(el('taguchi-filter-width').value,'1');
assert.equal(runtime.uiState.valid,false);assert.equal(plot().dataset.renderState,'stale');
assert.equal(el('taguchi-csv').disabled,true);assert.equal(coreCalls.length,1);checks++;

// A FW edit holds the drawing but blocks export until explicit recomputation.
await fire('taguchi-calculate');const rendered=plot().getContext('2d').events.length;
await fire('taguchi-filter-width','input',2);
assert.equal(plot().getContext('2d').events.length,rendered);assert.equal(plot().dataset.renderState,'stale');
assert.equal(run('taguchiExport()'),null);const downloadsBefore=downloads.length;
await fire('taguchi-csv');await fire('taguchi-json');assert.equal(downloads.length,downloadsBefore);
assert.equal(coreCalls.length,2);await fire('taguchi-calculate');assert.equal(coreCalls.length,3);
assert.equal(coreCalls.at(-1).filterWidthMm,2);assert.equal(el('taguchi-csv').disabled,false);checks++;

// Shared rotation rescales only axes/widths. Invalid time retains the previous
// plot and disables HFI exports, never the otherwise valid SSP download.
const cachedResult=runtime.uiState.result,rawBefore=Array.from(cachedResult.raw),profilesBefore=Array.from(cachedResult.profile);
await fire('taguchi-rotation','input',1);
assert.equal(fields.get('rotationTime').value,'1');assert.equal(persistCalls,1);assert.equal(coreCalls.length,3);
assert.deepEqual(coordinates(lastCurve()),expected(1000));
assert.match(el('taguchi-tsp-stats').textContent,/FWHM 400\.0 ms.*FWTM 1200\.0 ms.*Teq 600\.0 ms/);
assert.equal(cachedResult.config.rotationTime,.5);assert.deepEqual(Array.from(cachedResult.raw),rawBefore);assert.deepEqual(Array.from(cachedResult.profile),profilesBefore);
await fire('tsp-time-unit','change','turns');assert.deepEqual(coordinates(lastCurve()),expected(1));
assert.match(el('taguchi-tsp-stats').textContent,/FWHM 0\.4000 Trot.*FWTM 1\.2000 Trot.*Teq 0\.6000 Trot/);
const lastPaintCount=plot().getContext('2d').events.length;fields.get('rotationTime').value='';run('refreshTemporalDisplay()');
assert.equal(el('taguchi-rotation').value,'');assert.equal(plot().dataset.renderState,'invalid-time');
assert.equal(plot().getContext('2d').events.length,lastPaintCount);assert.equal(el('taguchi-json').disabled,true);assert.equal(run('taguchiExport()'),null);assert.equal(sspSave.disabled,false);
fields.get('rotationTime').value='1';run('refreshTemporalDisplay()');assert.equal(el('taguchi-json').disabled,false);assert.equal(coreCalls.length,3);
assert.equal(plot().dataset.renderState,'ready');assert.match(el('taguchi-status').textContent,/Rotation time updated/);
assert.doesNotMatch(el('taguchi-status').textContent,/Enter a rotation time/);checks++;

// Export all native coefficients, internal zeros and signed times with the
// current time conversion; never overwrite the cached calculation settings.
const exported=run('taguchiExport()');
assert.equal(exported.config.rotationTime,1);assert.equal(exported.metrics.fwhmMs,400);assert.equal(exported.metrics.fwtmMs,1200);assert.equal(exported.metrics.equivalentWidthMs,600);
assert.deepEqual(Array.from(exported.timeMs),Array.from(nativeTimes,t=>1000*t));assert.deepEqual(Array.from(exported.raw),rawBefore);
assert.equal(exported.provenance.input,'interpolation coefficients only');assert.equal(cachedResult.config.rotationTime,.5);
await fire('taguchi-json');const json=JSON.parse(downloads.at(-1).body);assert.equal(json.config.rotationTime,1);assert.deepEqual(json.timeMs,Array.from(exported.timeMs));
await fire('taguchi-csv');const csv=downloads.at(-1);assert.match(csv.filename,/Taguchi_HFI_TSP/);
const lines=csv.body.replace(/^\uFEFF/,'').trim().split(/\r?\n/),header=lines.indexOf('time_turns,time_ms,summed_interpolation_weight,normalized_peak_1');assert.ok(header>=0);
assert.deepEqual(lines.slice(header+1).map(line=>line.split(',').map(Number)),Array.from(nativeTimes,(t,i)=>[t,1000*t,rawBefore[i],profilesBefore[i]]));checks++;

// SSP exports strip obsolete temporal fields, retain native spatial arrays,
// and represent invalid time as null instead of blocking the SSP download.
runtime.oldSpatial={config:{radius:123,phase:2,rotationTime:.5},z:Float64Array.of(-1,0,1),raw:Float64Array.of(0,2,0),temporalResponse:{old:true},temporalResponseUnavailable:'old',profiles:[{phase:2,raw:Float64Array.of(0,2,0),temporalResponse:{old:true}}]};
fields.get('rotationTime').value='';const spatial=run('spatialExport(oldSpatial)');
assert.equal(spatial.config.rotationTime,null);assert.equal(spatial.config.radius,123);assert.equal(spatial.raw,runtime.oldSpatial.raw);
assert.equal(Object.hasOwn(spatial,'temporalResponse'),false);assert.equal(Object.hasOwn(spatial,'temporalResponseUnavailable'),false);assert.equal(Object.hasOwn(spatial.profiles[0],'temporalResponse'),false);
assert.equal(runtime.oldSpatial.temporalResponse.old,true);assert.equal(runtime.oldSpatial.config.rotationTime,.5);assert.equal(sspSave.disabled,false);checks++;

// Invalid independent inputs never invoke the core or disable spatial output.
fields.get('rotationTime').value='.5';await fire('taguchi-pitch','input',0);const callsBeforeInvalid=coreCalls.length;
await fire('taguchi-calculate');assert.equal(coreCalls.length,callsBeforeInvalid);assert.equal(runtime.uiState.valid,false);assert.match(el('taguchi-status').textContent,/ranges/);assert.equal(sspSave.disabled,false);
assert.equal(ssp.getContext('2d').events.length,0);checks++;

// A superseded pending run cannot restore stale data or re-enable downloads.
await fire('taguchi-pitch','input',1);let resolvePending;
coreImplementation=config=>new Promise(resolve=>{resolvePending=()=>resolve(response(config));});
const pending=fire('taguchi-calculate');
while(!resolvePending)await new Promise(resolve=>setTimeout(resolve,1));
await fire('taguchi-filter-width','input',3);const heldResult=runtime.uiState.result;resolvePending();await pending;
assert.equal(runtime.uiState.result,heldResult);assert.equal(runtime.uiState.valid,false);assert.equal(plot().dataset.renderState,'stale');assert.equal(el('taguchi-json').disabled,true);assert.equal(el('taguchi-calculate').disabled,false);checks++;

// Recovering a valid time must also restore a stale-result warning when FW has
// changed; time recovery alone must never revalidate that older calculation.
fields.get('rotationTime').value='';run('refreshTemporalDisplay()');assert.equal(plot().dataset.renderState,'invalid-time');
fields.get('rotationTime').value='1';run('refreshTemporalDisplay()');
assert.equal(plot().dataset.renderState,'stale');assert.match(el('taguchi-status').textContent,/Settings changed.*previous curve.*calculate again/);
assert.equal(runtime.uiState.valid,false);assert.equal(el('taguchi-json').disabled,true);checks++;

// A valid run finishing after time was cleared may retain its native result,
// but completion must not overwrite the invalid-time status with success.
resolvePending=null;const invalidTimeRun=fire('taguchi-calculate');
while(!resolvePending)await new Promise(resolve=>setTimeout(resolve,1));
fields.get('rotationTime').value='';run('refreshTemporalDisplay()');resolvePending();await invalidTimeRun;
assert.equal(plot().dataset.renderState,'invalid-time');assert.match(el('taguchi-status').textContent,/Enter a rotation time/);
assert.equal(el('taguchi-json').disabled,true);assert.equal(el('taguchi-calculate').disabled,false);
fields.get('rotationTime').value='1';run('refreshTemporalDisplay()');assert.equal(plot().dataset.renderState,'ready');
assert.match(el('taguchi-status').textContent,/Rotation time updated/);assert.equal(el('taguchi-json').disabled,false);checks++;

console.log(`PASS: independent Taguchi UI ${checks} groups; explicit HFI lifecycle, SSP separation, stale holds, shared time scaling, native-coefficient CSV/JSON and superseded results`);
