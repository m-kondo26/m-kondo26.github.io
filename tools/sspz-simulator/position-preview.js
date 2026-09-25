// One real response at the current FOV position. Full 360-start-angle analysis
// remains an explicit action; this worker/result never impersonates that series.
let positionWorker=null,positionWorkerUrl=null,positionTimer=null,positionRequest=0,positionResult=null;
const positionMovie={series:null,index:0,playing:false,timer:null,scenes:new Map(),background:null,axes:null,xLimit:null,valid:false};
function stopPositionPreview(){
  clearTimeout(positionTimer);positionRequest++;
  positionWorker?.terminate();positionWorker=null;
  if(positionWorkerUrl)URL.revokeObjectURL(positionWorkerUrl);positionWorkerUrl=null;
}
function positionCanvases(){return [...document.querySelectorAll('#position-preview canvas')];}
function syncPositionControls(){
  const radius=Number(form.elements.namedItem('radius').value),range=document.getElementById('position-radius');
  if(!range)return;range.value=radius;
  document.getElementById('position-radius-value').textContent=`${radius} mm`;
  const on=Number(form.elements.namedItem('beamPitch').value)>0;
  document.getElementById('position-preview').hidden=!on;
  runButton.textContent=on?fdkText('全360開始角度を計算する','Calculate all 360 start angles'):fdkText('寝台静止時の展開図を計算する','Calculate stationary-table geometry');
  if(!on)for(const id of ['diagram-overview-off','diagram-zoom-off'])document.getElementById(id)?.closest('article')?.setAttribute('hidden','');
  document.getElementById('position-angle').textContent=((Number(document.getElementById('fdk-phase').value)*180/Math.PI)%360).toFixed(1)+'°';
}
function clearPositionResult(message,state='loading'){
  positionResult=null;
  document.getElementById('position-json').disabled=true;
  document.getElementById('position-stats').textContent='';
  document.getElementById('position-status').textContent=message;
  for(const canvas of positionCanvases()){
    delete canvas.dataset.radiusMm;delete canvas.dataset.responseRequest;
    drawCanvasStatus(canvas,'',message,state);
  }
}
function holdPositionResult(message,state='loading'){
  positionMovie.valid=false;stopPositionMovie();updatePositionMovieControls();
  document.getElementById('position-json').disabled=true;
  document.getElementById('position-movie-status').textContent=fdkText('条件を変更したため、360開始角度は再準備が必要です。','Settings changed. Prepare the 360 start angles again.');
  if(!positionResult){clearPositionResult(message,state);return;}
  document.getElementById('position-status').textContent=message+' '+fdkText(`前の条件の図を保持しています（r = ${positionResult.config.radius} mm）。`,`Keeping the previous plots (r = ${positionResult.config.radius} mm).`);
  for(const canvas of positionCanvases()){canvas.dataset.renderState='stale';canvas.setAttribute('aria-busy',String(state==='loading'));}
}
function invalidatePositionMovie(){
  stopPositionMovie();positionMovie.series=null;positionMovie.scenes.clear();positionMovie.background=null;positionMovie.valid=false;updatePositionMovieControls();
  const prepare=document.getElementById('position-prepare');if(prepare)prepare.disabled=false;
}
function schedulePositionPreview(delay=220){
  stopPositionPreview();syncPositionControls();clearError();
  invalidatePositionMovie();
  // Re-enable form controls before FormData is read. A radius chip or slider
  // can interrupt an ongoing full sweep without losing the other inputs.
  releaseWorker();if(runButton.disabled)setBusy(false);
  fdkInspectionRequest++;clearTimeout(fdkInspectionTimer);fdkToggleDownloads(false);
  fdkResult=null;fdkSelectedResult=null;fdkShapeGroups=null;lastResult=null;
  document.getElementById('fdk-panel').hidden=true;
  document.getElementById('position-preview').hidden=Number(form.elements.namedItem('beamPitch').value)<=0;
  holdPositionResult(fdkText('新しい条件を計算中…','Computing the new settings…'));
  status.textContent=fdkText('位置に連動して計算します。全360開始角度は計算ボタンで実行できます。','Position-linked calculation. Use Calculate for all 360 start angles.');
  if(Number(form.elements.namedItem('beamPitch').value)<=0){clearCanvasStatusAnimations();positionTimer=setTimeout(runSimulation,delay);return;}
  positionTimer=setTimeout(runPositionPreview,delay);
}
function runPositionPreview(){
  stopPositionPreview();syncPositionControls();
  if([...form.querySelectorAll('input[type=number]')].some(e=>e.value===''||e.validity.badInput||e.validity.rangeUnderflow||e.validity.rangeOverflow)){
    holdPositionResult(fdkText('入力値の範囲を確認してください。','Check the input ranges.'),'error');return;
  }
  const params=readParams(),requestId=positionRequest;
  const previewParams={...params,phase:params.phase};
  const url=paramsToUrl(params);
  try{history.replaceState(null,'',url);localStorage.setItem('sspz-unwrapped-params',JSON.stringify(params));}catch{}
  syncLanguageLinks(url.search);
  const blob=new Blob([globalThis.SSPZ_WORKER_SOURCE],{type:'text/javascript'});
  positionWorkerUrl=URL.createObjectURL(blob);
  const active=positionWorker=new Worker(positionWorkerUrl);
  const fail=message=>{
    if(active!==positionWorker||requestId!==positionRequest)return;
    holdPositionResult(message,'error');stopPositionPreview();
  };
  active.onerror=e=>fail(e.message);
  active.onmessage=({data:m})=>{
    if(active!==positionWorker||requestId!==positionRequest||m.requestId!==requestId)return;
    if(m.type==='position-preview-error'){fail(m.message);return;}
    if(m.type!=='position-preview-result')return;
    try{
      renderPositionPreview(m.result,requestId);
      stopPositionPreview();
    }catch(error){fail(error.message);}
  };
  active.postMessage({type:'position-preview',requestId,params:previewParams});
}
function initializePositionPreview(){
  const section=document.createElement('section');section.id='position-preview';
  section.innerHTML=`<h2>${fdkText('評価位置と開始角度で、データの並びとSSPzはどう変わる？','How do position and start angle affect data geometry and SSPz?')}</h2>
  <p>${fdkText('評価位置を決めて、360開始角度を準備します。灰色の360本を残したまま、選択中のSSPzを赤く強調し、同じ開始角度の展開図と一緒に再生できます。','Choose an evaluation position and prepare all 360 start angles. Keep all 360 profiles in grey and highlight the selected SSPz in red, together with its matching unwrapped diagram.')}</p>
  <div class="position-controls"><label for="position-radius">${fdkText('回転中心からの距離 r','Distance from isocentre r')} <output id="position-radius-value"></output></label><input id="position-radius" type="range" min="0" max="250" step="1"><button type="button" id="position-centre">${fdkText('中心へ戻す','Return to centre')}</button><span>${fdkText('基準開始角度','Base start angle')}: <b id="position-angle"></b></span></div>
  <p class="field-help">${fdkText('FOVの表示サイズではなく、FOV内の評価位置を変えます。取得ビュー数・補間方法・設定厚Tは現在の入力値を使います。展開図は横軸が体軸位置、縦軸が0～360°の補間対象方向です。','This moves the evaluation point within the FOV, not the displayed FOV size. Current view count, interpolation and thickness T are retained. The diagram uses axial position horizontally and the 0–360° output direction vertically.')}</p>
  <div class="position-movie-controls"><button type="button" id="position-prepare">${fdkText('360開始角度を準備','Prepare 360 start angles')}</button><button type="button" id="position-play" disabled aria-pressed="false">${fdkText('▶ 開始角度を再生','▶ Play start angles')}</button><button type="button" id="position-prev" disabled>−1°</button><button type="button" id="position-next" disabled>+1°</button><label>${fdkText('再生速度','Playback speed')} <select id="position-speed"><option value="400">${fdkText('ゆっくり','Slow')}</option><option value="150" selected>${fdkText('標準','Normal')}</option><option value="75">${fdkText('速い','Fast')}</option></select></label><label class="position-phase-control" for="position-phase">${fdkText('表示中の開始角度','Displayed start angle')} <output id="position-phase-value">—</output><input id="position-phase" type="range" min="0" max="359" step="1" value="0" disabled></label></div>
  <p id="position-movie-status" aria-live="polite">${fdkText('最初に基準角度の1本を表示します。準備ボタンで全360本を計算します。','One base-angle profile is shown first. Prepare calculates all 360 profiles.')}</p>
  <p class="field-help">${fdkText('再生は、同じ評価位置で開始角度だけが異なる360条件の比較です。X線管が撮影中に回る動きではありません。準備後の角度変更では再計算しません。','Playback compares 360 separate start-angle conditions at the same position, not tube motion during a scan. Once prepared, angle changes require no recalculation.')}</p>
  <p id="position-status" aria-live="polite"></p><div class="position-plots"><article class="chart-card"><h3>${fdkText('データ配置と補間重み','Data geometry and interpolation weights')}</h3><div class="position-canvas"><canvas id="position-diagram" width="900" height="960" role="img" aria-label="${fdkText('評価位置の展開図','Unwrapped diagram at the evaluation point')}"></canvas></div></article><article class="chart-card"><h3>${fdkText('同じ評価位置のSSPz','SSPz at the same evaluation point')}</h3><div class="position-canvas"><canvas id="position-profile" width="1000" height="700" role="img" aria-label="${fdkText('同じ評価位置のSSPz','SSPz at the same evaluation point')}"></canvas></div><p id="position-stats"></p><p>${fdkText('配置の変化が、補間・角度平均・厚さTの平均後にどこまで残るかを見ます。配置が変わっても半値幅が大きく変わるとは限りません。','See how changes in data geometry carry through interpolation, angular averaging and thickness T. Different geometry need not produce a large FWHM change.')}</p></article></div>
  <button type="button" id="position-json" class="secondary" disabled>${fdkText('表示中の応答・条件をJSON保存','Save the displayed response and conditions')}</button><p class="field-help">${fdkText('SSPzは全取得ビューから計算しています。展開図の重み記号は全周の代表方向を表示します。全方向の重みは、下の詳細結果で開始角度を選んでJSON保存できます。','SSPz uses all acquired views. Diagram weight markers show sampled directions around the full turn. For complete weights, select a start angle in the detailed results below and export JSON.')}</p>`;
  document.getElementById('fdk-panel').before(section);
  const change=value=>{form.elements.namedItem('radius').value=value;updateInputDecorations();schedulePositionPreview();};
  document.getElementById('position-radius').oninput=e=>change(e.target.value);
  document.getElementById('position-centre').onclick=()=>change(0);
  document.getElementById('position-json').onclick=()=>{if(positionResult&&positionMovie.valid)downloadBlob(`Cone_geometry_r${positionResult.config.radius}mm_angle${(positionResult.config.phase*180/Math.PI).toFixed(1)}_response.json`,JSON.stringify({scope:'displayed single-start-angle response; diagramFrame contains display-sampled weights only',result:positionResult},(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v),'application/json');};
  document.getElementById('position-prepare').onclick=()=>{
    if([...form.querySelectorAll('input[type=number]')].some(e=>e.value===''||e.validity.badInput||e.validity.rangeUnderflow||e.validity.rangeOverflow)){holdPositionResult(fdkText('入力値の範囲を確認してください。','Check the input ranges.'),'error');return;}runSimulation();
  };
  document.getElementById('position-play').onclick=()=>{if(positionMovie.playing)stopPositionMovie();else if(positionMovie.valid&&positionMovie.series){stopAxialMovie();stopGeometryPlayback();positionMovie.playing=true;updatePositionMovieControls();schedulePositionMovie();}};
  document.getElementById('position-phase').oninput=e=>{stopPositionMovie();renderPositionFrame(Number(e.target.value));};
  document.getElementById('position-prev').onclick=()=>{stopPositionMovie();renderPositionFrame(positionMovie.index-1);};
  document.getElementById('position-next').onclick=()=>{stopPositionMovie();renderPositionFrame(positionMovie.index+1);};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPositionMovie();});
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');if(reduced.matches)document.getElementById('position-speed').value='400';
  reduced.addEventListener('change',()=>{stopPositionMovie();if(reduced.matches)document.getElementById('position-speed').value='400';});
  runButton.textContent=fdkText('全360開始角度を計算する','Calculate all 360 start angles');
  resetButton.addEventListener('click',()=>schedulePositionPreview());
  syncPositionControls();
}

function renderPositionPreview(r,requestId='series'){
  invalidatePositionMovie();
  const {profiles,mean,meanDifference,...singleResponse}=r;
  positionResult=singleResponse;
      for(const cv of positionCanvases())loadingCanvasStatuses.delete(cv);
      const canvas=document.getElementById('position-diagram');
      const scene=drawFdkCandidateDiagram(canvas,r,true,false,'all',true,{fullTurn:true});
      // Keep full-turn coordinates irrespective of the advanced-panel zoom.
      drawDiagram(canvas,scene,'zoom');
      const profile=document.getElementById('position-profile');
      if(r.geometryOnly)drawCanvasStatus(profile,'',fdkText('取得応答なし：SSPzは算出できません。','No acquired response: SSPz is unavailable.'),'unavailable');
      else fdkDrawProfile(profile,{...r,profiles:[r]},'');
      for(const cv of positionCanvases()){
        cv.removeAttribute('aria-busy');
        delete cv.dataset.profileCount;delete cv.dataset.selectedColor;delete cv.dataset.profileSource;delete cv.dataset.xLimit;
        cv.dataset.startIndex='0';cv.dataset.phase=String(r.config.phase);
        cv.dataset.radiusMm=String(r.config.radius);cv.dataset.responseRequest=String(requestId);
        cv.dataset.renderState=r.geometryOnly&&cv===profile?'unavailable':'ready';
      }
      document.getElementById('position-stats').textContent=r.geometryOnly?'':`FWHM ${r.fwhm.width.toFixed(2)} mm / FWTM ${r.fwtm.width.toFixed(2)} mm`;
      document.getElementById('position-status').textContent=fdkText(`r = ${r.config.radius} mm：同じ位置・開始角度の展開図とSSPzです。`,`r = ${r.config.radius} mm: diagram and SSPz share this position and start angle.`);
      document.getElementById('position-json').disabled=false;
      positionMovie.valid=true;
      document.getElementById('position-phase-value').textContent=positionAngle(r.config.phase);
      document.getElementById('position-phase').value=0;
      document.getElementById('position-movie-status').textContent=r.geometryOnly?fdkText('取得応答がないため、展開図のみ表示します。','No acquired response; only the diagram is available.'):fdkText('基準角度の1本を表示中。360開始角度を準備すると、全曲線を残して再生できます。','Showing one base-angle profile. Prepare 360 start angles to play with every profile visible.');
      updatePositionMovieControls();
      status.textContent=fdkText('評価位置の計算が完了しました。','Position calculation complete.');

}
function positionAngle(phase){return ((phase*180/Math.PI%360+360)%360).toFixed(1)+'°';}
function updatePositionMovieControls(){
  const m=positionMovie,ready=!!m.series&&m.valid,button=document.getElementById('position-play');if(!button)return;
  for(const id of ['position-play','position-prev','position-next','position-phase'])document.getElementById(id).disabled=!ready;
  button.textContent=m.playing?fdkText('Ⅱ 一時停止','Ⅱ Pause'):fdkText('▶ 開始角度を再生','▶ Play start angles');button.setAttribute('aria-pressed',String(m.playing));
}
function stopPositionMovie(){positionMovie.playing=false;clearTimeout(positionMovie.timer);positionMovie.timer=null;updatePositionMovieControls();}
function schedulePositionMovie(){
  if(!positionMovie.playing||!positionMovie.valid||document.hidden)return;
  positionMovie.timer=setTimeout(()=>{if(!positionMovie.playing||!positionMovie.valid)return;renderPositionFrame(positionMovie.index+1);schedulePositionMovie();},Number(document.getElementById('position-speed').value));
}
function beginPositionSeries(){
  invalidatePositionMovie();
  document.getElementById('position-prepare').disabled=true;
  holdPositionResult(fdkText('360開始角度を準備中…','Preparing 360 start angles…'));
  document.getElementById('position-movie-status').textContent=fdkText('展開図とSSPzをまとめて準備します。完了後は計算待ちなしで角度を変更できます。','Preparing diagrams and SSPz together. Angle changes will require no calculation after completion.');
}
function positionSeriesProgress(message){document.getElementById('position-movie-status').textContent=message;}
function failPositionSeries(message){document.getElementById('position-prepare').disabled=false;holdPositionResult(message,'error');positionSeriesProgress(message);}
function preparePositionSeries(r){
  document.getElementById('position-prepare').disabled=false;
  if(r.geometryOnly||!r.profiles?.every(p=>p.diagramFrame)){renderPositionPreview(r,'series');return;}
  const m=positionMovie;stopPositionMovie();m.series=r;m.index=0;m.valid=true;m.scenes.clear();
  // Pass the same unrounded span to scene construction and axis painting.
  // Re-rounding an already nice span can enlarge it and omit edge turns.
  m.xLimit=Math.max(...r.profiles.map(p=>Math.max(r.config.rowWidth,Math.ceil(p.diagramFrame.extent.maxAbsZ*10)/10)*1.12));
  const canvas=document.getElementById('position-profile');m.background=document.createElement('canvas');m.background.width=canvas.width;m.background.height=canvas.height;
  const low=Math.min(0,Math.floor(Math.min(...r.profiles.map(p=>Math.min(...p.profile)))*10)/10);
  m.axes=fdkAxes(m.background,r.z[0],r.z.at(-1),low,1.04,'z position (mm)','Normalized SSPz','',low<0?[low,0,.2,.4,.6,.8,1]:[0,.2,.4,.6,.8,1],110,null,v=>v.toFixed(1));
  fdkDrawLines(m.axes,r.z,r.profiles.map(p=>p.profile),'#89949e');
  const {ctx,b,y}=m.axes;ctx.save();ctx.strokeStyle='#9ba5ad';ctx.lineWidth=1;ctx.setLineDash([5,4]);for(const level of [.5,.1]){ctx.beginPath();ctx.moveTo(b.left,y(level));ctx.lineTo(b.right,y(level));ctx.stroke();}ctx.restore();
  document.getElementById('position-phase').max=r.profiles.length-1;
  renderPositionFrame(0);
  positionSeriesProgress(fdkText(`${r.profiles.length}開始角度の準備が完了しました。灰色：全曲線／赤：表示中の開始角度。`,`${r.profiles.length} start angles ready. Grey: all profiles / red: displayed start angle.`));
  updatePositionMovieControls();
}
function renderPositionFrame(index){
  const m=positionMovie,r=m.series;if(!r||!m.valid)return;
  index=((Math.round(index)%r.profiles.length)+r.profiles.length)%r.profiles.length;m.index=index;
  const p=r.profiles[index],frame=p.diagramFrame;
  const selected={config:{...r.config,phase:p.phase},z:r.z,zObject:r.zObject,raw:p.raw,profile:p.profile,fwhm:p.fwhm,fwtm:p.fwtm,baseline:p.baseline,model:r.model,domainCheck:{...r.domainCheck,rawTailFraction:p.rawTailFraction},coordinateSystem:frame.coordinateSystem,diagramFrame:frame};
  // Compact display coefficients never masquerade as a complete weight audit.
  positionResult=selected;
  if(!m.scenes.has(index)){
    m.scenes.set(index,drawFdkCandidateDiagram({width:900,dataset:{}},{...selected,weightAudit:frame.weightAudit,rebinnedWeightAudit:frame.rebinnedWeightAudit},true,false,'all',true,{fullTurn:true,sharedXLimit:m.xLimit}));
    while(m.scenes.size>8)m.scenes.delete(m.scenes.keys().next().value);
  }
  drawDiagram(document.getElementById('position-diagram'),m.scenes.get(index),'zoom',m.xLimit);
  const canvas=document.getElementById('position-profile'),ctx=canvas.getContext('2d');ctx.drawImage(m.background,0,0);
  const axes={...m.axes,ctx};fdkDrawLines(axes,r.z,[p.profile],'#d71920');
  ctx.save();ctx.fillStyle='#d71920';ctx.font=`700 26px ${FIGURE_FONT}`;ctx.textAlign='center';ctx.fillText(fdkText(`開始角度 ${positionAngle(p.phase)} · r = ${r.config.radius} mm`,`Start angle ${positionAngle(p.phase)} · r = ${r.config.radius} mm`),(axes.b.left+axes.b.right)/2,45);ctx.fillStyle='#65727e';ctx.font=`21px ${FIGURE_FONT}`;ctx.fillText(fdkText(`灰色：全${r.profiles.length}本　赤：選択中`,`Grey: all ${r.profiles.length} profiles   Red: selected`),(axes.b.left+axes.b.right)/2,80);ctx.restore();
  for(const cv of positionCanvases()){loadingCanvasStatuses.delete(cv);cv.removeAttribute('aria-busy');Object.assign(cv.dataset,{radiusMm:String(r.config.radius),startIndex:String(index),phase:String(p.phase),renderState:'ready',responseRequest:'cached-series',xLimit:String(m.xLimit)});}
  Object.assign(canvas.dataset,{profileCount:String(r.profiles.length),selectedColor:'#d71920',profileSource:'precomputed-full-acquired-view-series',profileInterpolation:'native-sample-linear'});
  document.getElementById('position-phase').value=index;document.getElementById('position-phase-value').textContent=positionAngle(p.phase);
  document.getElementById('position-stats').textContent=`FWHM ${p.fwhm.width.toFixed(2)} mm / FWTM ${p.fwtm.width.toFixed(2)} mm`;
  document.getElementById('position-status').textContent=fdkText(`r = ${r.config.radius} mm ／ 開始角度 ${positionAngle(p.phase)}：展開図と赤いSSPzは同じ条件です。`,`r = ${r.config.radius} mm / start angle ${positionAngle(p.phase)}: the diagram and red SSPz share the same settings.`);
  document.getElementById('position-json').disabled=false;
}
