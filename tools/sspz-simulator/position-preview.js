// One real response at the current FOV position. Full 360-start-angle analysis
// remains an explicit action; this worker/result never impersonates that series.
let positionWorker=null,positionWorkerUrl=null,positionTimer=null,positionRequest=0,positionResult=null;
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
function schedulePositionPreview(delay=220){
  stopPositionPreview();syncPositionControls();clearError();
  // Re-enable form controls before FormData is read. A radius chip or slider
  // can interrupt an ongoing full sweep without losing the other inputs.
  releaseWorker();if(runButton.disabled)setBusy(false);
  fdkInspectionRequest++;clearTimeout(fdkInspectionTimer);fdkToggleDownloads(false);
  fdkResult=null;fdkSelectedResult=null;fdkShapeGroups=null;lastResult=null;
  document.getElementById('fdk-panel').hidden=true;
  document.getElementById('position-preview').hidden=Number(form.elements.namedItem('beamPitch').value)<=0;
  clearPositionResult(fdkText('評価位置の展開図とSSPzを更新中…','Updating the diagram and SSPz at this position…'));
  status.textContent=fdkText('位置に連動して計算します。全360開始角度は計算ボタンで実行できます。','Position-linked calculation. Use Calculate for all 360 start angles.');
  if(Number(form.elements.namedItem('beamPitch').value)<=0){clearCanvasStatusAnimations();positionTimer=setTimeout(runSimulation,delay);return;}
  positionTimer=setTimeout(runPositionPreview,delay);
}
function runPositionPreview(){
  stopPositionPreview();syncPositionControls();
  if([...form.querySelectorAll('input[type=number]')].some(e=>e.value===''||e.validity.badInput||e.validity.rangeUnderflow||e.validity.rangeOverflow)){
    clearPositionResult(fdkText('入力値の範囲を確認してください。','Check the input ranges.'),'error');return;
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
    clearPositionResult(message,'error');stopPositionPreview();
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
  section.innerHTML=`<h2>${fdkText('評価位置によって、データの並びとSSPzはどう変わる？','How do data geometry and SSPz change with FOV position?')}</h2>
  <p>${fdkText('コーン幾何を固定し、回転中心からの距離だけを動かします。位置を変えると、同じ開始角度の展開図とSSPzを再計算します。','Keep cone geometry fixed and move the evaluation point away from isocentre. Both plots are recalculated at the same start angle when the position changes.')}</p>
  <div class="position-controls"><label for="position-radius">${fdkText('回転中心からの距離 r','Distance from isocentre r')} <output id="position-radius-value"></output></label><input id="position-radius" type="range" min="0" max="250" step="1"><button type="button" id="position-centre">${fdkText('中心へ戻す','Return to centre')}</button><span>${fdkText('基準開始角度','Base start angle')}: <b id="position-angle"></b></span></div>
  <p class="field-help">${fdkText('FOVの表示サイズではなく、FOV内の評価位置を変えます。取得ビュー数・補間方法・設定厚Tは現在の入力値を使います。展開図は横軸が体軸位置、縦軸が0～360°の補間対象方向です。','This moves the evaluation point within the FOV, not the displayed FOV size. Current view count, interpolation and thickness T are retained. The diagram uses axial position horizontally and the 0–360° output direction vertically.')}</p>
  <p id="position-status" aria-live="polite"></p><div class="position-plots"><article class="chart-card"><h3>${fdkText('データ配置と補間重み','Data geometry and interpolation weights')}</h3><div class="position-canvas"><canvas id="position-diagram" width="900" height="960" role="img" aria-label="${fdkText('評価位置の展開図','Unwrapped diagram at the evaluation point')}"></canvas></div></article><article class="chart-card"><h3>${fdkText('同じ評価位置のSSPz','SSPz at the same evaluation point')}</h3><div class="position-canvas"><canvas id="position-profile" width="1000" height="700" role="img" aria-label="${fdkText('同じ評価位置のSSPz','SSPz at the same evaluation point')}"></canvas></div><p id="position-stats"></p><p>${fdkText('配置の変化が、補間・角度平均・厚さTの平均後にどこまで残るかを見ます。配置が変わっても半値幅が大きく変わるとは限りません。','See how changes in data geometry carry through interpolation, angular averaging and thickness T. Different geometry need not produce a large FWHM change.')}</p></article></div>
  <button type="button" id="position-json" class="secondary" disabled>${fdkText('この位置の応答・重み・条件をJSON保存','Save response, weights and conditions at this position')}</button><p class="field-help">${fdkText('ここでは1つの開始角度を計算します。全360開始角度の変動解析は、上の計算ボタンから実行できます。','This panel computes one start angle. Use the Calculate button above for the full 360-start-angle analysis.')}</p>`;
  document.getElementById('fdk-panel').before(section);
  const change=value=>{form.elements.namedItem('radius').value=value;updateInputDecorations();schedulePositionPreview();};
  document.getElementById('position-radius').oninput=e=>change(e.target.value);
  document.getElementById('position-centre').onclick=()=>change(0);
  document.getElementById('position-json').onclick=()=>{if(positionResult)downloadBlob(`Cone_geometry_r${positionResult.config.radius}mm_response.json`,JSON.stringify({scope:'single-start-angle position response',result:positionResult},(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v),'application/json');};
  runButton.textContent=fdkText('全360開始角度を計算する','Calculate all 360 start angles');
  resetButton.addEventListener('click',()=>schedulePositionPreview());
  syncPositionControls();
}

function renderPositionPreview(r,requestId='series'){
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
        cv.dataset.radiusMm=String(r.config.radius);cv.dataset.responseRequest=String(requestId);
        cv.dataset.renderState=r.geometryOnly&&cv===profile?'unavailable':'ready';
      }
      document.getElementById('position-stats').textContent=r.geometryOnly?'':`FWHM ${r.fwhm.width.toFixed(2)} mm / FWTM ${r.fwtm.width.toFixed(2)} mm`;
      document.getElementById('position-status').textContent=fdkText(`r = ${r.config.radius} mm：同じ位置・開始角度の展開図とSSPzです。`,`r = ${r.config.radius} mm: diagram and SSPz share this position and start angle.`);
      document.getElementById('position-json').disabled=false;
      status.textContent=fdkText('評価位置の計算が完了しました。','Position calculation complete.');

}
