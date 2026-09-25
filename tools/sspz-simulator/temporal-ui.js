// Independent HFI calculation. Only an explicit copy action copies geometry
// settings; the cone-model SSPz and its start-angle playback remain separate.
let taguchiResult=null,taguchiResultValid=false,taguchiRunId=0;
function temporalUnit(){return document.getElementById('tsp-time-unit')?.value==='turns'?'turns':'ms';}
function taguchiInput(id){const e=document.getElementById(id);return e&&e.value!==''&&e.checkValidity()?Number(e.value):NaN;}
function taguchiSettings(){return {rows:4,rowWidth:taguchiInput('taguchi-row-width'),beamPitch:taguchiInput('taguchi-pitch'),filterWidthMm:taguchiInput('taguchi-filter-width'),rotationTime:readRotationTime(),viewSamples:7200};}
function initializeTaguchiUi(){
  const section=document.createElement('section');section.id='taguchi-tsp';section.setAttribute('aria-labelledby','taguchi-title');
  section.innerHTML=`<p class="eyebrow">${fdkText('追加計算','Additional calculation')}</p><h2 id="taguchi-title">${fdkText('TaguchiらのHFIに基づくTSP参照計算','TSP reference calculation based on Taguchi et al.’s HFI')}</h2>
  <p>${fdkText('ここからは、ヘリカルフィルタ補間（HFI）の重みを用いて時間感度を追加計算します。上のSSPzとは計算方法が異なります。','This section calculates temporal sensitivity from helical filter interpolation (HFI) weights. It uses a different calculation method from the SSPz above.')}</p>
  <p class="taguchi-scope"><strong>${fdkText('計算対象：4列・回転中心（r = 0 mm）','Scope: four rows at isocentre (r = 0 mm)')}</strong><br>${fdkText('実データと対向データの隣接2点から再サンプリングし、幅FWの矩形フィルタを適用します。補間重みを元の取得時刻ごとに合計します。','Resample between adjacent direct and complementary data, apply a rectangular filter of width FW, and sum interpolation weights by original acquisition time.')}</p>
  <p class="taguchi-verification-note">${fdkText('照合状況：市川論文Fig.5(d)、p = 0.625では曲線形状に差が残っています。論文値に合わせる調整はしていません。','Comparison status: a curve-shape difference remains for Ichikawa Fig. 5(d), p = 0.625. No parameters have been fitted to the published values.')}</p>
  <div class="taguchi-preset-row"><label for="taguchi-preset">${fdkText('論文の比較条件','Paper comparison settings')} <select id="taguchi-preset"><option value="custom">${fdkText('任意の条件','Custom settings')}</option><option value="0.625">Ichikawa Fig. 5(d): p = 0.625</option><option value="1">Ichikawa Fig. 5(e): p = 1.0</option><option value="1.5">Ichikawa Fig. 5(f): p = 1.5</option></select></label><button type="button" id="taguchi-copy" class="secondary">${fdkText('上の列幅・ピッチをコピー','Copy row width and pitch from above')}</button></div>
  <div class="taguchi-inputs">
  <label>${fdkText('回転中心換算の列幅 d (mm)','Row width at isocentre d (mm)')}<input id="taguchi-row-width" type="number" min="0.1" max="10" step="0.1" value="1" required></label>
  <label>${fdkText('ビームピッチ p','Beam pitch p')}<input id="taguchi-pitch" type="number" min="0.1" max="2" step="0.001" value="0.875" required></label>
  <label>${fdkText('HFIフィルタ幅 FW (mm)','HFI filter width FW (mm)')}<input id="taguchi-filter-width" type="number" min="0.1" max="20" step="0.1" value="1" required></label>
  <label>${fdkText('回転時間 (s/rot)','Rotation time (s/rot)')}<input id="taguchi-rotation" type="number" min="0.05" max="5" step="0.05" value="0.5" required></label></div>
  <p class="field-help">${fdkText('pは1回転の寝台移動量 ÷（4 × d）。FWは上の設定厚Tとは独立です。回転時間は上の条件欄と共通です。','p is table travel per rotation divided by (4 × d). FW is independent of thickness T above. Rotation time is shared with the settings above.')}</p>
  <p class="field-help">${fdkText('上の評価位置r・開始角度の再生・焦点サイズは使いません。論文条件は d = 2 mm、FW = 2 mm、回転時間1 sです。','The radius r, start-angle playback and focal size above are not used. Paper settings use d = 2 mm, FW = 2 mm and a 1 s rotation.')}</p>
  <div class="action-row"><button type="button" id="taguchi-calculate">${fdkText('HFIでTSPを追加計算','Calculate the HFI TSP')}</button><label for="tsp-time-unit">${fdkText('時間軸','Time axis')} <select id="tsp-time-unit"><option value="ms">ms</option><option value="turns">t / Trot</option></select></label></div>
  <p id="taguchi-status" role="status" aria-live="polite"></p>
  <div class="position-canvas"><canvas id="taguchi-tsp-plot" width="1100" height="660" role="img" aria-label="${fdkText('Taguchi HFIによる回転中心の理論TSP','Isocentre theoretical TSP using Taguchi HFI')}"></canvas></div>
  <p id="taguchi-result-settings"></p><p id="taguchi-tsp-stats" class="tsp-stats"></p><p id="taguchi-reference-note" class="field-help"></p>
  <div class="action-row"><button type="button" id="taguchi-csv" class="secondary" disabled>${fdkText('HFI TSPをCSV保存','Save HFI TSP as CSV')}</button><button type="button" id="taguchi-json" class="secondary" disabled>${fdkText('HFI TSP・条件をJSON保存','Save HFI TSP and settings as JSON')}</button></div>
  <details class="reading-details"><summary>${fdkText('計算方法と論文との照合','Method and comparison with the paper')}</summary><p>${fdkText('Taguchi・Aradate（1998）の式(6)と付録の矩形フィルタに基づき、線形補間の係数をFW内で積分します。固定点対象の検出器信号は掛けません。時間0は目的断面に対する中央時刻です。','Linear interpolation coefficients are integrated over FW using Eq. (6) and the rectangular-filter appendix of Taguchi and Aradate (1998). No fixed-point detector signal is multiplied into these weights. Time zero is the central time of the target plane.')}</p>
  <p>${fdkText('計算刻みは回転時間の1/7200です。理論曲線を評価する刻みであり、上の取得ビュー数とは別です。表示は最大値1。FWHM・FWTMは半値・10%値の交点間の幅、Teqは面積÷最大値です。交点が一意でない場合は幅を確定しません。','The theoretical time-sampling interval is 1/7200 of a rotation, independent of the acquired view count above. Curves are normalized to a peak of one. FWHM and FWTM use the half-maximum and 10% crossings; Teq is area divided by peak. Widths are not assigned when crossings are ambiguous.')}</p>
  <p>${fdkText('比較対象は市川ら（2015）Fig.5(d–f)のHFI条件です。実機の再構成画像や周辺位置のTSPを再現したものではありません。','The reference comparison is the HFI setting in Ichikawa et al. (2015), Fig. 5(d–f). This does not reproduce reconstructed scanner images or off-centre TSPs.')} <a href="${fdkText('methods.html?topic=axial#taguchi-hfi-tsp','methods.html?topic=axial&lang=en#taguchi-hfi-tsp')}">${fdkText('計算式・確認結果','Equations and checks')}</a></p>
  <p><a href="https://doi.org/10.1118/1.598230">Taguchi &amp; Aradate (1998)</a> · <a href="https://doi.org/10.1016/j.ejmp.2015.02.012">Ichikawa et al. (2015)</a></p></details>`;
  document.getElementById('fdk-panel').after(section);
  for(const id of ['taguchi-row-width','taguchi-pitch','taguchi-filter-width'])document.getElementById(id).addEventListener('input',()=>{document.getElementById('taguchi-preset').value='custom';invalidateTaguchiResult();});
  document.getElementById('taguchi-preset').onchange=e=>{if(e.target.value==='custom')return;document.getElementById('taguchi-row-width').value='2';document.getElementById('taguchi-filter-width').value='2';document.getElementById('taguchi-pitch').value=e.target.value;setTaguchiRotation('1');invalidateTaguchiResult();};
  document.getElementById('taguchi-copy').onclick=copyTaguchiSettings;
  document.getElementById('taguchi-calculate').onclick=runTaguchiCalculation;
  document.getElementById('taguchi-rotation').oninput=e=>setTaguchiRotation(e.target.value);
  document.getElementById('tsp-time-unit').onchange=refreshTemporalDisplay;
  document.getElementById('taguchi-csv').onclick=downloadTaguchiCsv;
  document.getElementById('taguchi-json').onclick=()=>{const r=taguchiExport();if(r)downloadBlob('Taguchi_HFI_TSP.json',JSON.stringify(r,(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v),'application/json');};
  const width=Number(form.elements.namedItem('rowWidth').value),pitch=Number(form.elements.namedItem('beamPitch').value);
  if(width>=.1&&width<=10){document.getElementById('taguchi-row-width').value=String(width);document.getElementById('taguchi-filter-width').value=String(width);}
  if(pitch>=.1&&pitch<=2)document.getElementById('taguchi-pitch').value=String(pitch);
  refreshTemporalDisplay();drawCanvasStatus(document.getElementById('taguchi-tsp-plot'),'HFI TSP',fdkText('条件を選び、追加計算を実行してください。','Choose settings and run the additional calculation.'),'idle');
  document.getElementById('taguchi-status').textContent=fdkText('SSPzの計算とは独立して実行します。','This calculation runs independently of SSPz.');
}
function setTaguchiRotation(value){form.elements.namedItem('rotationTime').value=value;persistTemporalSettings();refreshTemporalDisplay();}
function copyTaguchiSettings(){
  document.getElementById('taguchi-row-width').value=form.elements.namedItem('rowWidth').value;document.getElementById('taguchi-pitch').value=form.elements.namedItem('beamPitch').value;
  document.getElementById('taguchi-preset').value='custom';invalidateTaguchiResult();refreshTemporalDisplay();
  document.getElementById('taguchi-status').textContent=fdkText('列幅とピッチをコピーしました。4列・回転中心で計算します。FWを確認して追加計算してください。','Row width and pitch copied. Calculation remains at isocentre with four rows. Check FW, then calculate.');
}
function taguchiDownloads(enabled){for(const id of ['taguchi-csv','taguchi-json'])document.getElementById(id).disabled=!enabled;}
function invalidateTaguchiResult(){
  taguchiRunId++;taguchiResultValid=false;taguchiDownloads(false);document.getElementById('taguchi-calculate').disabled=false;
  document.getElementById('taguchi-tsp-plot').dataset.renderState=taguchiResult?'stale':'idle';
  document.getElementById('taguchi-status').textContent=taguchiResult?fdkText('条件を変更しました。前の条件の曲線を保持しています。追加計算で更新してください。','Settings changed. The previous curve is retained; calculate again to update.'):fdkText('条件を確認して追加計算してください。','Check settings and run the additional calculation.');
}
async function runTaguchiCalculation(){
  const config=taguchiSettings();
  if(Object.values(config).some(v=>!Number.isFinite(v))){invalidateTaguchiResult();document.getElementById('taguchi-status').textContent=fdkText('列幅・ピッチ・FW・回転時間の入力範囲を確認してください。','Check the ranges for row width, pitch, FW and rotation time.');return;}
  const run=++taguchiRunId;taguchiResultValid=false;taguchiDownloads(false);document.getElementById('taguchi-calculate').disabled=true;
  document.getElementById('taguchi-status').textContent=fdkText('HFIの重みから理論TSPを計算中…','Calculating the theoretical TSP from HFI weights…');
  await new Promise(resolve=>setTimeout(resolve,0));
  try{const r=await SSPZTaguchi.computeTaguchiTsp(config);if(run!==taguchiRunId)return;taguchiResult=r;taguchiResultValid=true;renderTaguchiTsp();if(Number.isFinite(readRotationTime()))document.getElementById('taguchi-status').textContent=fdkText('追加計算が完了しました。回転中心のHFI参照計算です。','Additional calculation complete: HFI reference at isocentre.');}
  catch(error){if(run!==taguchiRunId)return;invalidateTaguchiResult();document.getElementById('taguchi-status').textContent=fdkText('追加計算を完了できませんでした。入力条件を確認してください。','Additional calculation failed. Check the input settings.')+' '+error.message;}
  finally{if(run===taguchiRunId)document.getElementById('taguchi-calculate').disabled=false;}
}
function renderTaguchiTsp(){
  if(!taguchiResult)return;
  const r=taguchiResult,rotation=readRotationTime(),canvas=document.getElementById('taguchi-tsp-plot');
  if(!Number.isFinite(rotation)){canvas.dataset.renderState='invalid-time';taguchiDownloads(false);document.getElementById('taguchi-status').textContent=fdkText('回転時間を0.05～5秒で入力してください。前の図を保持しています。','Enter a rotation time from 0.05 to 5 s. The previous plot is retained.');return;}
  if(canvas.dataset.renderState==='invalid-time')document.getElementById('taguchi-status').textContent=taguchiResultValid?fdkText('回転時間を反映しました。計算済みのHFI曲線を表示しています。','Rotation time updated. Showing the calculated HFI curve.'):fdkText('条件を変更しました。前の条件の曲線を保持しています。追加計算で更新してください。','Settings changed. The previous curve is retained; calculate again to update.');
  const units=temporalUnit(),scale=units==='ms'?1000*rotation:1,bound=Math.max(Math.abs(r.timeTurns[0]),Math.abs(r.timeTurns.at(-1)))*scale,limit=symmetricNiceAxis(bound,3).xMax;
  const axes=fdkAxes(canvas,-limit,limit,0,1.04,units==='ms'?'Relative acquisition time (ms)':'Relative acquisition time / Trot','Normalized HFI TSP','',[0,.2,.4,.6,.8,1],100,null,v=>v.toFixed(1));
  const {ctx,b,x,y}=axes;ctx.save();ctx.beginPath();ctx.rect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.clip();ctx.strokeStyle='#176b87';ctx.lineWidth=3.2;strokeNativeProfile(ctx,Float64Array.from(r.timeTurns,t=>t*scale),r.profile,x,y);
  ctx.strokeStyle='#a9b4bd';ctx.lineWidth=1;ctx.setLineDash([5,5]);for(const h of [.5,.1]){ctx.beginPath();ctx.moveTo(b.left,y(h));ctx.lineTo(b.right,y(h));ctx.stroke();}ctx.restore();
  ctx.save();ctx.fillStyle='#174157';ctx.font=`700 24px ${FIGURE_FONT}`;ctx.textAlign='center';ctx.fillText(`Taguchi HFI · p = ${r.config.beamPitch} · FW = ${r.config.filterWidthMm} mm`,(b.left+b.right)/2,45);ctx.restore();
  loadingCanvasStatuses.delete(canvas);Object.assign(canvas.dataset,{renderState:taguchiResultValid?'ready':'stale',method:'taguchi-hfi',radiusMm:'0',rows:'4',rotationTime:String(rotation),timeUnit:units,timeAxisLimit:String(limit)});
  const unit=units==='ms'?'ms':'Trot',fmt=v=>Number.isFinite(v)?(v*scale).toFixed(units==='ms'?1:4):fdkText('未定義','undefined');
  document.getElementById('taguchi-tsp-stats').textContent=`FWHM ${fmt(r.metrics.fwhmTurns)} ${unit} ／ FWTM ${fmt(r.metrics.fwtmTurns)} ${unit} ／ Teq ${fmt(r.metrics.equivalentWidthTurns)} ${unit}`;
  document.getElementById('taguchi-result-settings').textContent=fdkText(`表示条件：4列・r = 0 mm ／ d = ${r.config.rowWidth} mm ／ p = ${r.config.beamPitch} ／ FW = ${r.config.filterWidthMm} mm ／ ${rotation} s/rot`,`Displayed settings: 4 rows, r = 0 mm / d = ${r.config.rowWidth} mm / p = ${r.config.beamPitch} / FW = ${r.config.filterWidthMm} mm / ${rotation} s/rot`);
  const ref={.625:[1531,1710],1:[1001,1284],1.5:[501,791]}[r.config.beamPitch];
  document.getElementById('taguchi-reference-note').textContent=ref&&Math.abs(r.config.filterWidthMm/r.config.rowWidth-1)<1e-10?fdkText(`参考：同じFW/d比・回転時間1 sでの市川論文の実測値はFWHM ${ref[0]} ms、FWTM ${ref[1]} msです。実測値は理論計算の厳密な正解値ではありません。`,`Reference: at the same FW/d ratio and 1 s rotation, Ichikawa reports measured FWHM ${ref[0]} ms and FWTM ${ref[1]} ms. These measured values are not exact theoretical targets.`):'';
  taguchiDownloads(taguchiResultValid);
}
function refreshTemporalDisplay(){const e=document.getElementById('taguchi-rotation');if(!e)return;e.value=form.elements.namedItem('rotationTime').value;renderTaguchiTsp();}
function taguchiExport(){
  const rotationTime=readRotationTime();if(!taguchiResultValid||!taguchiResult||!Number.isFinite(rotationTime))return null;
  const r=taguchiResult,metrics={...r.metrics};for(const [key,v] of Object.entries(r.metrics))if(key.endsWith('Turns'))metrics[key.slice(0,-5)+'Ms']=Number.isFinite(v)?v*rotationTime*1000:null;
  return {...r,scope:'Taguchi HFI theoretical TSP; four rows at isocentre; independent from cone-model SSPz',config:{...r.config,rotationTime},metrics,timeMs:Float64Array.from(r.timeTurns,t=>t*rotationTime*1000)};
}
function downloadTaguchiCsv(){
  const r=taguchiExport();if(!r)return;
  const rows=[['# method','Taguchi HFI theoretical TSP'],['# config',JSON.stringify(r.config)],['# provenance',JSON.stringify(r.provenance)],['# metrics',JSON.stringify(r.metrics)],['time_turns','time_ms','summed_interpolation_weight','normalized_peak_1'],...Array.from(r.timeTurns,(t,i)=>[t,r.timeMs[i],r.raw[i],r.profile[i]])];
  downloadBlob(`Taguchi_HFI_TSP_p${r.config.beamPitch}_FW${r.config.filterWidthMm}mm.csv`,'\uFEFF'+rows.map(row=>row.map(csvEscape).join(',')).join('\r\n'),'text/csv');
}
function spatialExport(result){
  if(!result)return result;const {temporalResponse,temporalResponseUnavailable,...spatial}=result;
  if(spatial.config)spatial.config={...spatial.config,rotationTime:Number.isFinite(readRotationTime())?readRotationTime():null};
  if(spatial.profiles)spatial.profiles=spatial.profiles.map(spatialExport);if(spatial.reference)spatial.reference=spatialExport(spatial.reference);return spatial;
}
