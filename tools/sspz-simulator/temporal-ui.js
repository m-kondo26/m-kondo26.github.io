// Time uses original acquired-view indices, never rebinned or folded angles.
// Scaling the time axis is a display operation and does not rerun the model.
const temporalPlots=new WeakMap();
function temporalUnit(){return document.getElementById('tsp-time-unit')?.value==='turns'?'turns':'ms';}
function temporalScale(){return temporalUnit()==='turns'?1:1000*readRotationTime();}
function temporalSamples(result){return result?.profiles?.length?result.profiles:[result];}
function temporalAvailable(t){return !!t&&t.sum>0&&t.timeTurns?.length>0;}
function initializeTemporalUi(){
  const article=document.createElement('article');article.id='position-tsp-card';article.className='chart-card';
  article.innerHTML=`<h3>${fdkText('同じ評価位置のモデルTSP','Model TSP at the same evaluation point')}</h3>
  <p>${fdkText('各取得時刻のデータが、この点の応答にどれだけ寄与するかを示します。SSPzと同じ開始角度に連動します。','Shows how much data from each acquisition time contribute to the response at this point. The start angle matches SSPz.')}</p>
  <div class="tsp-controls"><label for="tsp-time-unit">${fdkText('時間軸の単位','Time-axis unit')} <select id="tsp-time-unit"><option value="ms">ms</option><option value="turns">t / Trot</option></select></label><span id="tsp-rotation-label"></span></div>
  <div class="position-canvas"><canvas id="position-tsp" width="1000" height="610" role="img" aria-label="${fdkText('元の取得時刻に対するモデルTSP','Model TSP versus original acquisition time')}"></canvas></div>
  <p id="position-tsp-stats" class="tsp-stats"></p>
  <p class="field-help">${fdkText('時間の原点は基準ビューの取得時刻です。負の時刻はその前の取得を表し、異なる回転を同じ時刻へ折り返しません。回転時間は上の条件欄で変更できます。','Time zero is acquisition of the reference view. Negative times precede it; different turns are not folded onto one time. Change rotation time in the settings above.')}</p>
  <button type="button" id="position-tsp-csv" class="secondary" disabled>${fdkText('表示中のTSPをCSV保存','Save the displayed TSP as CSV')}</button>
  <details class="reading-details"><summary>${fdkText('SSPzとTSPの関係・幅の読み方','How SSPz, TSP and temporal widths relate')}</summary>
  <table><thead><tr><th>${fdkText('応答','Response')}</th><th>${fdkText('集計の見方','What is measured')}</th></tr></thead><tbody><tr><th>SSPz</th><td>${fdkText('各体軸位置で取得データの寄与を足し、点対象への応答がz方向にどう広がるかを見る。','Sum acquired-data contributions at each axial position to show how the point response spreads along z.')}</td></tr><tr><th>TSP</th><td>${fdkText('評価点を固定し、列・チャネルの寄与を元の取得時刻ごとに足して、時間方向の感度を見る。','Fix the evaluation point and sum row/channel contributions by original acquisition time to show temporal sensitivity.')}</td></tr></tbody></table>
  <p>${fdkText('TSPは同じ点対象の強さを取得時刻ごとに変えた場合の、中心断面の応答です。最大値を1に正規化します。等価幅Teqは1ビューの時間間隔×寄与の総和÷最大寄与、寄与90%区間は累積寄与5%から95%までの幅です。どちらも実機の時間分解能を直接表す値ではありません。','TSP is the central-plane response when the amplitude of the same point changes with acquisition time, normalized to a peak of one. Equivalent width Teq is the view interval times total contribution divided by peak contribution. The 90% contribution interval spans cumulative 5% to 95%. Neither is directly a scanner temporal-resolution specification.')}</p>
  <p>${fdkText('SSPzを寝台速度で時間へ置き換える計算ではなく、元の取得ビューへ寄与を戻して集計します。本モデルは面内フィルタ・逆投影を含みません。','Contributions are traced back to original acquired views; SSPz is not converted to time using table speed. This model omits transaxial filtering and backprojection.')} <a href="${fdkText('methods.html?topic=axial','methods.html?topic=axial&lang=en')}">${fdkText('計算方法','Method')}</a></p></details>`;
  const ssp=document.getElementById('position-profile').closest('article'),stack=document.createElement('div');stack.className='position-response-stack';ssp.before(stack);stack.append(ssp,article);
  document.getElementById('tsp-time-unit').onchange=refreshTemporalDisplay;
  document.getElementById('position-tsp-csv').onclick=downloadPositionTsp;
  const detailed=document.createElement('article');detailed.className='chart-card';detailed.innerHTML=`<h3>${fdkText('全360条件のモデルTSP：赤は選択中の開始角度','Model TSP across 360 conditions: selected start angle in red')}</h3><div class="position-canvas"><canvas id="fdk-tsp" width="1000" height="610" role="img" aria-label="${fdkText('全開始角度のモデルTSP','Model TSP for all start angles')}"></canvas></div><p id="fdk-tsp-stats" class="tsp-stats"></p><p>${fdkText('時間軸の単位は上のTSPと共通です。各曲線は同じ評価点で開始角度を変えた計算結果です。','Time units match the TSP above. Each curve represents a different start angle at the same evaluation point.')}</p>`;
  document.getElementById('fdk-profile-step').append(detailed);
}
function temporalStroke(axes,t,scale,color,alpha=1,width=3.5){
  const {ctx,b,x,y}=axes;ctx.save();ctx.beginPath();ctx.rect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.clip();
  ctx.strokeStyle=color;ctx.globalAlpha=alpha;ctx.lineWidth=width;
  strokeNativeProfile(ctx,Float64Array.from(t.timeTurns,v=>v*scale),t.profile,x,y);ctx.restore();
}
function drawTemporalResponse(canvas,result,index=0){
  if(!canvas||!result)return false;
  const profiles=temporalSamples(result),selected=profiles[Math.min(index,profiles.length-1)],t=selected.temporalResponse;
  const stats=document.getElementById(canvas.id+'-stats'),scale=temporalScale(),units=temporalUnit(),rotation=readRotationTime();
  if(!Number.isFinite(rotation)){
    if(canvas.dataset.temporalSource!=='original-acquired-view')drawCanvasStatus(canvas,'TSP',fdkText('回転時間を入力してください。','Enter a valid rotation time.'),'unavailable');
    canvas.dataset.renderState='invalid-time';if(stats)stats.textContent=fdkText('回転時間を0.05～5秒で入力してください。以前の図がある場合は保持しています。','Enter a rotation time from 0.05 to 5 s. Any previous plot is retained.');return false;
  }
  if(!temporalAvailable(t)){
    drawCanvasStatus(canvas,'TSP',fdkText('この評価点の応答がないため、TSPを定義できません。','No response at this evaluation point; TSP is undefined.'),'unavailable');
    if(stats)stats.textContent='';delete canvas.dataset.temporalSource;return false;
  }
  let cached=temporalPlots.get(canvas);
  if(!cached||cached.result!==result||cached.scale!==scale||cached.units!==units||cached.width!==canvas.width){
    const valid=profiles.map(p=>p.temporalResponse).filter(temporalAvailable);
    const bound=Math.max(1e-6,...valid.map(q=>Math.max(Math.abs(q.timeTurns[0]),Math.abs(q.timeTurns.at(-1)))))*scale;
    const limit=symmetricNiceAxis(bound,3).xMax,background=document.createElement('canvas');background.width=canvas.width;background.height=canvas.height;
    const axes=fdkAxes(background,-limit,limit,0,1.04,units==='ms'?'Acquisition time (ms)':'Acquisition time / Trot','Normalized model TSP','',[0,.2,.4,.6,.8,1],110,null,v=>v.toFixed(1));
    if(profiles.length>1)for(const q of valid)temporalStroke(axes,q,scale,'#89949e',.13,1.1);
    cached={result,scale,units,width:canvas.width,background,axes,validCount:valid.length,limit};temporalPlots.set(canvas,cached);
  }
  const ctx=canvas.getContext('2d');ctx.drawImage(cached.background,0,0);const axes={...cached.axes,ctx};temporalStroke(axes,t,scale,'#d71920');
  const phase=selected.phase??result.config.phase;
  ctx.save();ctx.fillStyle='#d71920';ctx.textAlign='center';ctx.font=`700 25px ${FIGURE_FONT}`;ctx.fillText(fdkText(`開始角度 ${positionAngle(phase)} · r = ${result.config.radius} mm`,`Start angle ${positionAngle(phase)} · r = ${result.config.radius} mm`),(axes.b.left+axes.b.right)/2,43);
  ctx.fillStyle='#65727e';ctx.font=`21px ${FIGURE_FONT}`;ctx.fillText(profiles.length>1?fdkText(`灰色：有効${cached.validCount}/${profiles.length}本　赤：選択中`,`Grey: valid ${cached.validCount}/${profiles.length}   Red: selected`):fdkText('元の取得時刻ごとの寄与／最大値1','Original acquisition-time contributions / peak 1'),(axes.b.left+axes.b.right)/2,78);ctx.restore();
  loadingCanvasStatuses.delete(canvas);canvas.removeAttribute('aria-busy');Object.assign(canvas.dataset,{renderState:'ready',temporalSource:'original-acquired-view',startIndex:String(index),phase:String(phase),radiusMm:String(result.config.radius),rotationTime:String(rotation),timeUnit:units,timeAxisLimit:String(cached.limit),profileCount:String(profiles.length),closureError:String(t.closureError),rawSum:String(t.sum)});
  const unit=units==='ms'?'ms':'Trot',fmtT=value=>Number.isFinite(value)?(value*scale).toFixed(units==='ms'?1:3):'—';
  if(stats)stats.textContent=fdkText(`等価幅 Teq ${fmtT(t.equivalentWidthTurns)} ${unit} ／ 寄与90%区間 ${fmtT(t.coverage90?.widthTurns)} ${unit}`,`Equivalent width Teq ${fmtT(t.equivalentWidthTurns)} ${unit} / 90% contribution interval ${fmtT(t.coverage90?.widthTurns)} ${unit}`);
  return true;
}
function renderPositionTemporal(){
  const result=positionMovie.series??positionResult;if(!result)return;
  const ready=drawTemporalResponse(document.getElementById('position-tsp'),result,positionMovie.series?positionMovie.index:0);
  document.getElementById('position-tsp-csv').disabled=!ready||!positionMovie.valid;
  if(!positionMovie.valid)document.getElementById('position-tsp').dataset.renderState='stale';
  const rotation=readRotationTime();document.getElementById('tsp-rotation-label').textContent=Number.isFinite(rotation)?fdkText(`回転時間 ${rotation} s/rot`,`Rotation time ${rotation} s/rot`):fdkText('回転時間を確認してください','Check rotation time');
  if(!Number.isFinite(rotation))document.getElementById('position-json').disabled=true;
}
function renderDetailedTemporal(){if(fdkResult)drawTemporalResponse(document.getElementById('fdk-tsp'),fdkResult,selectedStateIndex);}
function refreshTemporalDisplay(){
  renderPositionTemporal();renderDetailedTemporal();
  if(positionResult)document.getElementById('position-json').disabled=!positionMovie.valid||!Number.isFinite(readRotationTime());
}
function temporalExport(result){
  const rotationTime=readRotationTime(),t=result.temporalResponse;
  return {...result,config:{...result.config,rotationTime:Number.isFinite(rotationTime)?rotationTime:null},timeDisplay:{rotationTimeSeconds:Number.isFinite(rotationTime)?rotationTime:null,unit:temporalUnit(),origin:'original acquired reference view 0'},
    ...(t?{temporalResponse:{...t,timeMs:Number.isFinite(rotationTime)?Float64Array.from(t.timeTurns,v=>v*rotationTime*1000):null}}:{})};
}
function downloadPositionTsp(){
  const r=positionResult,t=r?.temporalResponse,rotation=readRotationTime();if(!positionMovie.valid||!temporalAvailable(t)||!Number.isFinite(rotation))return;
  const rows=[['# scope','model point temporal impulse response at fixed evaluation point; original acquired-view contributions'],['# radius_mm',r.config.radius],['# phase_rad',r.config.phase],['# rotation_time_s',rotation],['# raw_sum',t.sum],['# raw_sspz_center',t.centerValue],['# closure_error',t.closureError],['# equivalent_width_ms',t.equivalentWidthTurns*rotation*1000],['# cumulative_5_to_95_width_ms',t.coverage90?.widthTurns*rotation*1000],['original_view','time_turns','time_ms','raw_contribution','normalized_peak_1'],...Array.from(t.timeTurns,(time,i)=>[t.viewIndices[i],time,time*rotation*1000,t.raw[i],t.profile[i]])];
  downloadBlob(`Model_TSP_r${r.config.radius}mm_angle${positionAngle(r.config.phase).replace('°','')}_rot${rotation}s.csv`,'\uFEFF'+rows.map(row=>row.map(csvEscape).join(',')).join('\r\n'),'text/csv');
}
