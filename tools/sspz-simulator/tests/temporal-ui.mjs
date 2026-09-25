import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the production temporal painters/exporters with a recording Canvas.
// Numeric impulse/gate validation belongs to axial-temporal-response.mjs.
// Axes are identity mappings here so every native time/profile sample is visible
// in the recorded path; the real strokeNativeProfile performs the drawing.
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function sourceFunction(name){
  const start=new RegExp(`^function ${name}\\(`,'m').exec(app);
  assert.ok(start,`${name} must remain available`);
  const next=/^function /gm;next.lastIndex=start.index+start[0].length;
  const end=next.exec(app);
  return app.slice(start.index,end?.index??app.length).trim();
}
const elements=new Map(),created=[],downloads=[],axesCalls=[];
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
  drawImage(source){this.events.push({kind:'image',source});}
  fillText(text,x,y){this.events.push({kind:'text',text,x,y,...this.state});}
  setLineDash(){}
}
for(const key of ['strokeStyle','fillStyle','globalAlpha','lineWidth','font','textAlign'])Object.defineProperty(Context.prototype,key,{get(){return this.state[key];},set(value){this.state[key]=value;}});
class Element {
  constructor(tag='div',id=''){this.tag=tag;this.id=id;this.dataset={};this.width=1000;this.height=610;this.value='';this.disabled=false;this.textContent='';this.attributes={};}
  getContext(){return this.ctx??=new Context(this);}
  removeAttribute(key){delete this.attributes[key];}
  setAttribute(key,value){this.attributes[key]=value;}
}
const el=id=>{if(!elements.has(id))elements.set(id,new Element(['position-tsp','fdk-tsp'].includes(id)?'canvas':'div',id));return elements.get(id);};
const rotationField={value:'.5'};
el('tsp-time-unit').value='ms';
const runtime=vm.createContext({
  document:{getElementById:el,createElement:tag=>{const out=new Element(tag);created.push(out);return out;}},
  form:{elements:{namedItem:name=>name==='rotationTime'?rotationField:null}},
  fdkText:(_ja,en)=>en,FIGURE_FONT:'Arial',loadingCanvasStatuses:new Map(),
  positionAngle:phase=>((phase*180/Math.PI%360+360)%360).toFixed(1)+'°',
  positionMovie:{series:null,index:0,valid:true},positionResult:null,fdkResult:null,selectedStateIndex:0,
  symmetricNiceAxis:bound=>({xMax:bound}),
  fdkAxes:(canvas,xMin,xMax,yMin,yMax,xLabel,yLabel)=>{
    axesCalls.push({canvas,xMin,xMax,yMin,yMax,xLabel,yLabel});
    return {ctx:canvas.getContext('2d'),b:{left:0,right:1000,top:0,bottom:610},x:v=>v,y:v=>v};
  },
  drawCanvasStatus:(canvas,title,message,state)=>{canvas.getContext('2d').events.push({kind:'status',title,message,state});canvas.dataset.renderState=state;},
  csvEscape:value=>{const s=String(value??'');return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;},
  downloadBlob:(filename,body,mime)=>downloads.push({filename,body,mime}),
});
vm.runInContext(['parseRotationTime','readRotationTime','strokeNativeProfile'].map(sourceFunction).join('\n')+'\n'+readFileSync(new URL('../temporal-ui.js',import.meta.url),'utf8'),runtime);
const run=code=>vm.runInContext(code,runtime);
const color='#d71920',grey='#89949e';
function response(index=0){
  const profile=Float64Array.of(0,.2+index/1800,1,0,.35,0);
  const raw=Float64Array.from(profile,v=>v*2),sum=raw.reduce((a,b)=>a+b,0);
  return {timeTurns:Float64Array.of(-1.2,-.7,-.2,.3,.8,1.3),viewIndices:Int32Array.of(-12,-7,-2,3,8,13),raw,profile,sum,centerValue:sum,closureError:0,equivalentWidthTurns:.4,coverage90:{widthTurns:1.2}};
}
const single={config:{radius:123,phase:.37,rotationTime:.5},temporalResponse:response()};
const series={config:{...single.config},profiles:Array.from({length:360},(_,index)=>({phase:.37+index*Math.PI/180,temporalResponse:response(index)}))};
runtime.single=single;runtime.series=series;
const canvas=el('position-tsp'),detailed=el('fdk-tsp');
const lastStroke=(cv,strokeColor=color)=>cv.getContext('2d').events.filter(e=>e.kind==='stroke'&&e.strokeStyle===strokeColor).at(-1);
const coords=stroke=>stroke.path.filter(p=>p.op==='M'||p.op==='L').map(p=>[p.x,p.y]);
const expected=(t,scale)=>Array.from(t.timeTurns,(time,i)=>[time*scale,t.profile[i]]);
let checks=0;

// Native signed acquisition times (including >1 turn and zero gaps) survive.
assert.equal(run('drawTemporalResponse(document.getElementById("position-tsp"),single)'),true);
assert.deepEqual(coords(lastStroke(canvas)),expected(single.temporalResponse,500));
assert.equal(lastStroke(canvas).path.length,single.temporalResponse.timeTurns.length);
assert.equal(canvas.dataset.temporalSource,'original-acquired-view');
assert.match(el('position-tsp-stats').textContent,/200\.0 ms.*600\.0 ms/);
assert.equal(axesCalls.at(-1).xLabel,'Acquisition time (ms)');
checks++;

// Scaling time never modifies either the normalized shape or core data.
const rawBefore=Array.from(single.temporalResponse.raw),shapeBefore=Array.from(single.temporalResponse.profile);
rotationField.value='1';
run('drawTemporalResponse(document.getElementById("position-tsp"),single)');
assert.deepEqual(coords(lastStroke(canvas)),expected(single.temporalResponse,1000));
assert.match(el('position-tsp-stats').textContent,/400\.0 ms.*1200\.0 ms/);
assert.deepEqual(Array.from(single.temporalResponse.raw),rawBefore);
assert.deepEqual(Array.from(single.temporalResponse.profile),shapeBefore);
el('tsp-time-unit').value='turns';
run('drawTemporalResponse(document.getElementById("position-tsp"),single)');
assert.deepEqual(coords(lastStroke(canvas)),expected(single.temporalResponse,1));
assert.match(el('position-tsp-stats').textContent,/0\.400 Trot.*1\.200 Trot/);
assert.equal(axesCalls.at(-1).xLabel,'Acquisition time / Trot');
checks++;

// One shared 360-curve background is reused across selections. Both views
// paint their selected curve last, above grey curves, at the native samples.
el('tsp-time-unit').value='ms';rotationField.value='.5';
run('drawTemporalResponse(document.getElementById("position-tsp"),series,0)');
const background=canvas.getContext('2d').events.filter(e=>e.kind==='image').at(-1).source;
assert.equal(background.getContext('2d').events.filter(e=>e.kind==='stroke'&&e.strokeStyle===grey).length,360);
const createdBefore=created.length,backgroundEvents=background.getContext('2d').events.length;
run('drawTemporalResponse(document.getElementById("position-tsp"),series,207)');
assert.equal(created.length,createdBefore,'Selecting an angle must reuse the existing 360-curve background');
assert.equal(background.getContext('2d').events.length,backgroundEvents);
assert.equal(canvas.getContext('2d').events.filter(e=>e.kind==='image').at(-1).source,background);
assert.deepEqual(coords(lastStroke(canvas)),expected(series.profiles[207].temporalResponse,500));
assert.equal(canvas.dataset.startIndex,'207');
assert.equal(Number(canvas.dataset.phase),series.profiles[207].phase);
assert.equal(canvas.dataset.profileCount,'360');
const recent=canvas.getContext('2d').events.slice(-4);
assert.equal(recent[0].kind,'image');assert.equal(recent[1].strokeStyle,color);
runtime.fdkResult=series;runtime.selectedStateIndex=59;
run('renderDetailedTemporal()');
assert.deepEqual(coords(lastStroke(detailed)),expected(series.profiles[59].temporalResponse,500));
assert.equal(detailed.dataset.startIndex,'59');
checks++;

// A centre with zero response cannot acquire a normalized TSP or an export.
runtime.positionResult={...single,temporalResponse:{...response(),sum:0,centerValue:0}};
runtime.positionMovie.series=null;runtime.positionMovie.valid=true;
run('renderPositionTemporal()');
assert.equal(canvas.dataset.renderState,'unavailable');
assert.equal(canvas.dataset.temporalSource,undefined);
assert.equal(el('position-tsp-csv').disabled,true);
assert.equal(el('position-tsp-stats').textContent,'');
const exportCount=downloads.length;run('downloadPositionTsp()');assert.equal(downloads.length,exportCount);
checks++;

// Invalid rotation input retains the last valid pixels and disables exports;
// correcting it recovers through a display update, without any worker call.
runtime.positionResult=single;runtime.fdkResult=null;rotationField.value='.5';
run('refreshTemporalDisplay()');
const paintedBefore=canvas.getContext('2d').events.length;
rotationField.value='';run('refreshTemporalDisplay()');
assert.equal(canvas.getContext('2d').events.length,paintedBefore,'Invalid time input must retain the valid curve');
assert.equal(canvas.dataset.renderState,'invalid-time');
assert.equal(el('position-tsp-csv').disabled,true);assert.equal(el('position-json').disabled,true);
run('downloadPositionTsp()');assert.equal(downloads.length,exportCount);
rotationField.value='1';run('refreshTemporalDisplay()');
assert.equal(canvas.dataset.renderState,'ready');
assert.equal(el('position-tsp-csv').disabled,false);assert.equal(el('position-json').disabled,false);
assert.deepEqual(coords(lastStroke(canvas)),expected(single.temporalResponse,1000));
checks++;

// CSV and JSON identify the currently displayed phase and ORIGINAL views.
const selected={...single,config:{...single.config,phase:series.profiles[207].phase},temporalResponse:series.profiles[207].temporalResponse};
runtime.positionResult=selected;el('tsp-time-unit').value='turns';
run('downloadPositionTsp()');
const csv=downloads.at(-1);assert.equal(csv.mime,'text/csv');
assert.match(csv.filename,/angle228\.2_rot1s\.csv$/);
assert.ok(csv.body.includes('# phase_rad,'+selected.config.phase));
assert.ok(csv.body.includes('# rotation_time_s,1'));
assert.ok(csv.body.includes('original_view,time_turns,time_ms,raw_contribution,normalized_peak_1'));
const lines=csv.body.trimStart().split('\r\n'),first=lines.findIndex(line=>line.startsWith('original_view,'));
assert.deepEqual(lines.slice(first+1).map(line=>line.split(',').map(Number)),Array.from(selected.temporalResponse.timeTurns,(time,i)=>[selected.temporalResponse.viewIndices[i],time,time*1000,selected.temporalResponse.raw[i],selected.temporalResponse.profile[i]]));
const exported=run('temporalExport(positionResult)');
assert.equal(exported.timeDisplay.rotationTimeSeconds,1);assert.equal(exported.timeDisplay.unit,'turns');
assert.equal(exported.timeDisplay.origin,'original acquired reference view 0');
assert.deepEqual(Array.from(exported.temporalResponse.timeMs),Array.from(selected.temporalResponse.timeTurns,v=>v*1000));
assert.equal(exported.config.phase,selected.config.phase);
assert.equal(exported.config.rotationTime,1,'Export config must agree with the current displayed time axis');
assert.equal(selected.config.rotationTime,.5,'Export must not mutate the original cached calculation');
checks++;

console.log(`PASS: temporal UI ${checks} groups; native signed times, scaling, cached 360 overlays, selected red, unavailable centre, invalid input retention, CSV/JSON provenance`);
