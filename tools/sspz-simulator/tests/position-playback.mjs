import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {fdkWidth} from '../fdk-core.js';
import {candidateDensityWindows} from '../candidate-density-core.js';

// UI-state regression checks. Small labelled arrays stand in for already
// computed responses; position-worker/axial-response tests verify the physics.
// This harness observes worker messages and canvas writes rather than copying
// the playback implementation or running 360 reconstructions.
const elements=new Map(),timers=new Map(),workers=[],exports=[],paints=[],lines=[],arrows=[],scenes=[],densityInputs=[];
const documentListeners=new Map(),motionListeners=new Map();
let nextTimer=0,nextUrl=0,calculations=0,statusPaints=0;
const context2d=canvas=>({canvas,save(){},restore(){},setLineDash(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},
  fillText(){},drawImage(source){paints.push({kind:'background',canvas,source});},
  clearRect(){paints.push({kind:'clear',canvas});}});
class Element {
  constructor(tag='div',id=''){
    this.tagName=tag.toUpperCase();this.dataset={};this.attributes={};this.listeners=new Map();
    this.value='';this.disabled=false;this.hidden=false;this.textContent='';this.width=1000;this.height=700;
    this.validity={badInput:false,rangeUnderflow:false,rangeOverflow:false,stepMismatch:false};
    if(id)this.id=id;
  }
  set id(value){this._id=value;elements.set(value,this);}
  get id(){return this._id;}
  set innerHTML(value){
    this.html=value;
    for(const match of value.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)){
      const child=new Element(match[1],match[2]);
      child.disabled=/\bdisabled\b/.test(match[0]);
      for(const key of ['value','width','height','min','max']){
        const attribute=match[0].match(new RegExp(`\\b${key}="([^"]+)"`));
        if(attribute)child[key]=attribute[1];
      }
    }
  }
  setAttribute(key,value){this.attributes[key]=String(value);}
  removeAttribute(key){delete this.attributes[key];}
  getAttribute(key){return this.attributes[key]??null;}
  addEventListener(type,handler){const handlers=this.listeners.get(type)??[];handlers.push(handler);this.listeners.set(type,handlers);}
  before(){}
  closest(){return this;}
  getContext(){return this.ctx??=context2d(this);}
}
const el=id=>elements.get(id)??new Element(id.includes('diagram')||id.includes('profile')?'canvas':'div',id);
const fields=new Map(Object.entries({radius:100,beamPitch:.875,rows:4,rowWidth:1,sliceThicknessMm:1}).map(([key,value])=>{
  const input=new Element('input',key);input.value=String(value);return [key,input];
}));
el('fdk-phase').value='.37';
const runButton=el('run-button'),resetButton=el('reset-button'),status=el('status');
const form={elements:{namedItem:key=>fields.get(key)},querySelectorAll:()=>[...fields.values()]};
const document={hidden:false,getElementById:el,createElement:tag=>new Element(tag),
  querySelectorAll:selector=>selector==='#position-preview canvas'?[el('position-diagram'),el('position-profile')]:[],
  addEventListener:(type,handler)=>documentListeners.set(type,handler)};
const motion={matches:false,addEventListener:(type,handler)=>motionListeners.set(type,handler)};
class FakeWorker {
  constructor(url){this.url=url;this.sent=[];this.terminated=false;workers.push(this);}
  postMessage(message){this.sent.push(message);}
  terminate(){this.terminated=true;}
  reply(message){this.onmessage?.({data:message});}
}
const readParams=()=>({radius:Number(fields.get('radius').value),beamPitch:Number(fields.get('beamPitch').value),
  rowWidth:Number(fields.get('rowWidth').value),phase:Number(el('fdk-phase').value),phaseCount:360});
const sandbox={document,form,runButton,resetButton,status,FIGURE_FONT:'Arial',Blob,Worker:FakeWorker,
  URL:{createObjectURL:()=>`blob:test-${++nextUrl}`,revokeObjectURL(){}},
  history:{replaceState(){}},localStorage:{setItem(){}},window:{matchMedia:()=>motion},SSPZ_WORKER_SOURCE:'',
  setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,delay});return id;},
  clearTimeout:id=>timers.delete(id),fdkText:(_ja,en)=>en,readParams,paramsToUrl:()=>({search:'?fixture=1'}),
  syncLanguageLinks(){},updateInputDecorations(){},clearError(){},releaseWorker(){},
  initializeTaguchiUi(){},spatialExport:result=>result,updateSspzVariation(){},
  setBusy:busy=>{runButton.disabled=busy;},fdkToggleDownloads(){},clearCanvasStatusAnimations(){},
  stopAxialMovie(){},stopGeometryPlayback(){},runSimulation:()=>{calculations++;},
  prepareCandidateDensityFromSeries:series=>densityInputs.push(series),
  fdkInspectionRequest:0,fdkInspectionTimer:null,fdkResult:null,fdkSelectedResult:null,fdkShapeGroups:null,lastResult:null,
  loadingCanvasStatuses:new Map(),
  downloadBlob:(name,body,type)=>exports.push({name,body,type}),
  drawCanvasStatus:(canvas,_title,message,state)=>{statusPaints++;canvas.dataset.renderState=state;paints.push({kind:'status',canvas,message,state});},
  symmetricNiceAxis:value=>({xMax:Math.ceil(value)}),
  drawFdkCandidateDiagram:(canvas,result,zoom,reference,role,capture,options)=>{
    assert.equal(capture,true);assert.equal(options.fullTurn,true);
    const scene={phase:result.config.phase,result,options};scenes.push(scene);return scene;
  },
  drawDiagram:(canvas,scene,mode,xLimit)=>paints.push({kind:'diagram',canvas,scene,mode,xLimit}),
  fdkDrawProfile:(canvas,result)=>paints.push({kind:'single-profile',canvas,result}),
  fdkAxes:(canvas,...args)=>({ctx:canvas.getContext('2d'),b:{left:130,right:965},y:value=>value,args}),
  fdkDrawLines:(axes,z,profiles,color,style)=>lines.push({canvas:axes.ctx.canvas,z,profiles,color,style,axes}),
  fdkArrow:(axes,width,level,color)=>arrows.push({canvas:axes.ctx.canvas,width,level,color}),
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL('../position-preview.js',import.meta.url),'utf8')+`
globalThis.testApi={initializePositionPreview,preparePositionSeries,renderPositionFrame,renderPositionPreview,
  beginPositionSeries,failPositionSeries,schedulePositionPreview,runPositionPreview,holdPositionResult,
  stopPositionMovie,stopPositionPreview,clearPositionResult,positionAngle,
  get movie(){return positionMovie;},get result(){return positionResult;},get worker(){return positionWorker;},
  get request(){return positionRequest;}};
`,sandbox);
const api=sandbox.testApi;
api.initializePositionPreview();el('position-speed').value='150';
const tick=()=>{
  const entry=timers.entries().next().value;assert.ok(entry,'Expected a scheduled callback');
  const [id,timer]=entry;timers.delete(id);timer.callback();
};
const fire=(id,event='click',value)=>{
  if(value!==undefined)el(id).value=String(value);
  el(id)[`on${event}`]({target:el(id)});
};
const makeSeries=(radius=100)=>{
  // Alternating asymmetric and flat-top profiles have true native crossings
  // and a peak away from their FWHM midpoint. z is ALREADY object-relative;
  // the nonzero absolute zObject must never be subtracted a second time.
  const phase=.37,z=Float64Array.of(-2,-1.2,-.7,-.1,.2,.6,1.3,2.1);
  const profiles=Array.from({length:360},(_,index)=>{
    const profile=Float64Array.from(index%2?
      [index/10000,.18+index/100000,.74,1,1,.84,.35,0]:
      [index/10000,.12+index/100000,.48,1,.83,.64,.19,0]);
    return {phase:phase+index*Math.PI/180,profile,raw:Float64Array.from(profile,v=>2*v),
      fwhm:fdkWidth(z,profile,.5),fwtm:fdkWidth(z,profile,.1),baseline:0,rawTailFraction:0,
      diagramFrame:{coordinateSystem:'rebinned-theta',extent:{maxAbsZ:1+index/360},
        weightAudit:{displayOnly:true,samples:[{index,weight:.5}]},rebinnedWeightAudit:{displayOnly:true,index}},
    };
  });
  const mean=Float64Array.from(z,(_,i)=>profiles.reduce((sum,p)=>sum+p.profile[i],0)/profiles.length);
  const meanDifference=profiles.map(p=>Float64Array.from(p.profile,(v,i)=>v-mean[i]));
  return {config:{...readParams(),radius,phase,feed:3.5,state:.35},z,zObject:1.225,profiles,mean,meanDifference,
    model:{kind:'axial-rri'},domainCheck:{expansions:0}};
};
const single=(radius=100)=>{
  const series=makeSeries(radius),p=series.profiles[0];
  return {config:series.config,z:series.z,zObject:series.zObject,...p,model:series.model,domainCheck:series.domainCheck,
    weightAudit:{samples:[{view:0,row:1,weight:1,acquiredValue:2}]}};
};
const bytes=a=>Buffer.from(a.buffer,a.byteOffset,a.byteLength).toString('hex');
const nativeSnapshot=r=>({z:bytes(r.z),zObject:r.zObject,config:JSON.stringify(r.config),
  mean:r.mean?bytes(r.mean):null,meanDifference:r.meanDifference?.map(bytes)??null,
  profiles:(r.profiles??[r]).map(p=>({profile:bytes(p.profile),raw:bytes(p.raw),
    fwhm:JSON.stringify(p.fwhm),fwtm:JSON.stringify(p.fwtm)}))});
const near=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<=1e-12,`${message}: ${actual} vs ${expected}`);
const assertRegisteredLine=(line,z,p)=>{
  assert.equal(line.profiles.length,1);assert.equal(line.profiles[0],p.profile,'Signal is not resampled');
  assert.notEqual(line.z,z,'Display coordinates use a separate array');
  const midpoint=(p.fwhm.left+p.fwhm.right)/2;
  assert.notEqual(midpoint,0,'Fixture must distinguish the native origin from the FWHM midpoint');
  for(let i=0;i<z.length;i++)assert.equal(line.z[i],z[i]-midpoint,'Translation uses native z, not z - zObject');
  const half=fdkWidth(line.z,p.profile,.5),tenth=fdkWidth(line.z,p.profile,.1);
  near((half.left+half.right)/2,0,'Displayed FWHM midpoint');
  near(half.width,p.fwhm.width,'FWHM width is unchanged');near(tenth.width,p.fwtm.width,'FWTM width is unchanged');
  const peak=p.profile.indexOf(Math.max(...p.profile));
  assert.ok(Math.abs(line.z[peak])>.05,'FWHM registration must not force the peak to zero');
};
let checks=0;

// Preparation is explicit. It disables export/play, retains an existing plot,
// and installs all 360 grey profiles once, not once per playback frame.
const singleResult=single(),singleBefore=nativeSnapshot(singleResult);
api.renderPositionPreview(singleResult);
assertRegisteredLine(lines.filter(p=>p.color==='#d71920').at(-1),singleResult.z,singleResult);
assert.deepEqual(nativeSnapshot(singleResult),singleBefore);
assert.equal(arrows.at(-1).level,.5);near((arrows.at(-1).width.left+arrows.at(-1).width.right)/2,0,'Single-profile arrow midpoint');
assert.match(lines.at(-1).axes.args[4],/FWHM midpoint/);
assert.equal(el('position-profile').dataset.profileAlignment,'fwhm-midpoint');
assert.equal(el('position-profile').dataset.displayFwhmMidpointMm,'0');checks++;
const previousResult=api.result,previousPaints=paints.length;
fire('position-prepare');assert.equal(calculations,1);
api.beginPositionSeries();
assert.equal(el('position-prepare').disabled,true);
assert.equal(el('position-json').disabled,true);assert.equal(el('position-play').disabled,true);
assert.equal(api.result,previousResult);assert.equal(paints.length,previousPaints);
assert.equal(el('position-diagram').dataset.renderState,'stale');
const series=makeSeries(),seriesBefore=nativeSnapshot(series),windowsBefore=candidateDensityWindows(series);
api.preparePositionSeries(series);
assert.equal(el('position-prepare').disabled,false);assert.equal(el('position-play').disabled,false);
assert.equal(api.movie.index,0);assert.equal(el('position-phase').max,359);
const greyLines=lines.filter(p=>p.color==='#89949e');assert.equal(greyLines.length,360);
greyLines.forEach((line,index)=>{
  assertRegisteredLine(line,series.z,series.profiles[index]);
  assert.equal(line.style.opacity,.13);assert.equal(line.style.lineWidth,1.1);
});
assert.equal(densityInputs.length,1);assert.equal(densityInputs[0],series,'Candidate counts receive the original native series');
assert.equal(api.movie.series,series);assert.deepEqual(nativeSnapshot(series),seriesBefore);
assert.deepEqual(candidateDensityWindows(densityInputs[0]),windowsBefore,'Native mean-response count windows are unchanged');
assert.equal(el('position-profile').dataset.profileCount,'360');checks++;

// A frame's diagram, red curve, reported phase and exported response must all
// come from the same cached phase. No worker or reconstruction is requested.
api.renderPositionFrame(123);
const chosen=series.profiles[123],sceneCount=scenes.length;
assert.equal(paints.filter(p=>p.kind==='diagram').at(-1).scene.phase,chosen.phase);
assert.equal(lines.filter(p=>p.color==='#d71920').at(-1).profiles[0],chosen.profile);
assertRegisteredLine(lines.filter(p=>p.color==='#d71920').at(-1),series.z,chosen);
near((arrows.at(-1).width.left+arrows.at(-1).width.right)/2,0,'Selected-profile arrow midpoint');
assert.equal(api.result.profile,chosen.profile);assert.equal(api.result.config.phase,chosen.phase);
assert.equal(el('position-diagram').dataset.phase,String(chosen.phase));
assert.equal(el('position-profile').dataset.phase,String(chosen.phase));
assert.equal(el('position-phase-value').textContent,api.positionAngle(chosen.phase));
api.renderPositionFrame(123);assert.equal(scenes.length,sceneCount,'Repeat frame should reuse its cached scene');
assert.equal(workers.length,0);assert.equal(calculations,1);checks++;

// Cached exported weights have an explicit display-only scope and cannot be
// mistaken for the complete acquired-direction audit used in the full panel.
fire('position-json');const downloaded=JSON.parse(exports.at(-1).body);
assert.match(downloaded.scope,/display-sampled weights only/);
assert.equal(downloaded.result.config.phase,chosen.phase);
assert.equal(downloaded.result.profile[0],chosen.profile[0]);
assert.deepEqual(downloaded.result.z,Array.from(series.z));
assert.deepEqual(downloaded.result.raw,Array.from(chosen.raw));
assert.deepEqual(downloaded.result.profile,Array.from(chosen.profile));
assert.deepEqual(downloaded.result.fwhm,chosen.fwhm);assert.deepEqual(downloaded.result.fwtm,chosen.fwtm);
assert.equal(downloaded.result.zObject,series.zObject);
assert.equal(downloaded.display.alignment,'fwhm-midpoint');assert.equal(downloaded.display.units,'mm');
assert.equal(downloaded.display.nativeCoordinateOrigin,'reconstruction object point');
assert.equal(downloaded.display.nativeFwhmMidpointMm,(chosen.fwhm.left+chosen.fwhm.right)/2);
assert.deepEqual(downloaded.display.z,Array.from(lines.filter(p=>p.color==='#d71920').at(-1).z));
near((downloaded.display.fwhm.left+downloaded.display.fwhm.right)/2,0,'Exported display midpoint');
assert.equal(downloaded.display.fwhm.width,chosen.fwhm.width);
assert.equal(downloaded.result.diagramFrame.weightAudit.displayOnly,true);
assert.equal(Object.hasOwn(downloaded.result,'weightAudit'),false);
assert.equal(Object.hasOwn(downloaded.result,'rebinnedWeightAudit'),false);
assert.equal(Object.hasOwn(downloaded.result,'profiles'),false);checks++;

// Wrap in both directions; playback uses the already prepared arrays and
// keeps the grey backing image without loading placeholders or canvas clears.
api.renderPositionFrame(-1);assert.equal(api.movie.index,359);
const beforePlayback={workers:workers.length,calculations,statusPaints,greys:lines.filter(p=>p.color==='#89949e').length};
fire('position-play');assert.equal(api.movie.playing,true);assert.equal(timers.size,1);
tick();assert.equal(api.movie.index,0);assert.equal(timers.size,1);
fire('position-phase','input',42);assert.equal(api.movie.index,42);assert.equal(api.movie.playing,false);assert.equal(timers.size,0);
fire('position-prev');assert.equal(api.movie.index,41);
fire('position-next');assert.equal(api.movie.index,42);
assert.deepEqual({workers:workers.length,calculations,statusPaints,greys:lines.filter(p=>p.color==='#89949e').length},beforePlayback);
assert.equal(paints.filter(p=>p.kind==='clear').length,0);
assert.ok(paints.filter(p=>p.kind==='background').every(p=>p.source===api.movie.background));
for(let index=0;index<12;index++)api.renderPositionFrame(index);
assert.deepEqual(nativeSnapshot(series),seriesBefore,'Playback leaves native arrays and widths byte-for-byte unchanged');
assert.deepEqual(candidateDensityWindows(series),windowsBefore);
assert.ok(api.movie.scenes.size<=8);checks++;

// Pausing on document hide/reduced motion cancels the next tick.
fire('position-play');document.hidden=true;documentListeners.get('visibilitychange')();
assert.equal(api.movie.playing,false);assert.equal(timers.size,0);document.hidden=false;
fire('position-play');motion.matches=true;motionListeners.get('change')();
assert.equal(api.movie.playing,false);assert.equal(timers.size,0);assert.equal(el('position-speed').value,'400');checks++;

// A settings change holds the exact displayed plots, disables stale export and
// playback immediately, and cancels a scheduled playback tick.
fire('position-play');const stale=api.result,paintCount=paints.length,exportCount=exports.length;
fields.get('radius').value='150';api.schedulePositionPreview(220);
assert.equal(api.result,stale);assert.equal(paints.length,paintCount);
assert.equal(api.movie.valid,false);assert.equal(api.movie.series,null);assert.equal(api.movie.playing,false);
for(const id of ['position-json','position-play','position-phase'])assert.equal(el(id).disabled,true);
assert.equal(el('position-diagram').dataset.renderState,'stale');assert.equal(el('position-profile').dataset.renderState,'stale');
assert.match(el('position-status').textContent,/previous plots \(r = 100 mm\)/);
fire('position-json');assert.equal(exports.length,exportCount);
assert.equal(timers.size,1,'Only the replacement preview debounce should remain');checks++;

// Even a late callback delivered after terminate must not repaint stale data
// or errors over a newer request. Check worker identity and request identity.
tick();const oldWorker=workers.at(-1),oldRequest=oldWorker.sent[0].requestId;
assert.equal(oldWorker.sent[0].params.radius,150);
fields.get('radius').value='200';api.schedulePositionPreview(0);tick();
const freshWorker=workers.at(-1),freshRequest=freshWorker.sent[0].requestId;
assert.notEqual(oldWorker,freshWorker);assert.equal(oldWorker.terminated,true);
const beforeLate=paints.length;
oldWorker.reply({type:'position-preview-result',requestId:oldRequest,result:single(150)});
oldWorker.onerror({message:'obsolete worker failure'});
freshWorker.reply({type:'position-preview-result',requestId:oldRequest,result:single(150)});
assert.equal(paints.length,beforeLate);assert.equal(api.result,stale);
freshWorker.reply({type:'position-preview-result',requestId:freshRequest,result:single(200)});
assert.equal(api.result.config.radius,200);assert.equal(el('position-diagram').dataset.radiusMm,'200');
assert.equal(el('position-profile').dataset.radiusMm,'200');assert.equal(freshWorker.terminated,true);
assert.equal(el('position-json').disabled,false);assert.equal(el('position-play').disabled,true);
assert.equal(el('position-diagram').getAttribute('aria-busy'),null);checks++;

// An unavailable response must not retain registration metadata from the
// previously displayed SSPz, or manufacture registered coordinates in JSON.
const alignmentKeys=['profileAlignment','nativeFwhmMidpointMm','displayFwhmMidpointMm'];
assert.equal(el('position-profile').dataset.profileAlignment,'fwhm-midpoint');
const {profile:_profile,raw:_raw,fwhm:_fwhm,fwtm:_fwtm,...geometryOnly}=single(200);
geometryOnly.geometryOnly=true;
const beforeUnavailable={lines:lines.length,arrows:arrows.length};api.renderPositionPreview(geometryOnly);
assert.equal(el('position-profile').dataset.renderState,'unavailable');
for(const key of alignmentKeys)assert.equal(Object.hasOwn(el('position-profile').dataset,key),false);
assert.equal(el('position-alignment').textContent,'');assert.equal(el('position-stats').textContent,'');
assert.deepEqual({lines:lines.length,arrows:arrows.length},beforeUnavailable);
fire('position-json');const unavailableJson=JSON.parse(exports.at(-1).body);
assert.equal(unavailableJson.result.geometryOnly,true);assert.equal(unavailableJson.display,null);checks++;

// Clearing a registered response resets both the annotation and canvas
// metadata, with no valid result/export left behind.
api.renderPositionPreview(single(200));
assert.equal(el('position-profile').dataset.profileAlignment,'fwhm-midpoint');
assert.notEqual(el('position-alignment').textContent,'');
api.clearPositionResult('Replacement response pending');
assert.equal(api.result,null);assert.equal(el('position-json').disabled,true);
assert.equal(el('position-alignment').textContent,'');assert.equal(el('position-stats').textContent,'');
for(const canvas of [el('position-diagram'),el('position-profile')]){
  for(const key of alignmentKeys)assert.equal(Object.hasOwn(canvas.dataset,key),false);
  assert.equal(canvas.dataset.renderState,'loading');
}
const afterClearExports=exports.length;fire('position-json');assert.equal(exports.length,afterClearExports);checks++;

console.log(`PASS: position playback ${checks} lifecycle groups; 360 independently FWHM-registered native curves, asymmetric/flat-top peaks, immutable responses/count windows, raw/display JSON separation, unavailable/reset metadata, phase pairing, wrap/scrub/pause, stale holds and superseded workers`);
