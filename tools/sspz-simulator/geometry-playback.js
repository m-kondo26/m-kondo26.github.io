// Construct one fixed-phase diagram by advancing acquisition angle across turns.
// This never changes the selected start phase, sample weights, or SSPz.
const geometryPlayback={playing:false,pending:false,timer:null,cache:new Map(),scene:null,window:null,fraction:1,lastTime:0};
function initializeGeometryPlayback(geometry,weights){
  const controls=document.createElement('div');controls.className='geometry-construction-controls';
  controls.innerHTML=`<h3>${fdkText('展開図ができるまで','How the unwrapped diagram is drawn')}</h3><div class="geometry-playback-controls">
    <button type="button" id="geometry-play" disabled>${fdkText('▶ 描く過程を再生','▶ Play drawing process')}</button>
    <button type="button" id="geometry-restart" disabled>${fdkText('最初から','Restart')}</button>
    <button type="button" id="geometry-complete" disabled>${fdkText('完成図を表示','Show complete diagram')}</button>
    <label>${fdkText('再生速度','Playback speed')}<select id="geometry-speed"><option value="45">${fdkText('ゆっくり','Slow')}</option><option value="90" selected>${fdkText('標準','Normal')}</option><option value="180">${fdkText('速い','Fast')}</option></select></label></div>
    <label class="geometry-drawing-progress">${fdkText('描画の進み具合','Drawing progress')}<input id="geometry-progress" type="range" min="0" max="1000" step="1" value="1000" disabled></label>
    <p id="geometry-play-status" role="status"></p>
    <p class="geometry-play-note">${fdkText('開始角度を固定し、左から右へ進む列軌跡を描き足します。1回転ごとに縦軸の0°へ戻り、次の体軸位置へ続きます。実データと、その同じデータを対向側へ写した破線を並べて確認できます。小さな四角は描画中の先端です。右端まで描き終えると、先頭から繰り返します。','The start phase stays fixed while row trajectories grow from left to right. Each turn wraps to 0° and continues at the next axial position. Direct data and the same data mapped to the complementary side are drawn together. Small squares mark the advancing tips. After completing the right edge, playback repeats.')}</p>
    <p class="geometry-play-note">${fdkText('軌跡を描く順序の表示です。下の補間重みとSSPzは完成した計算結果を保持します。','This illustrates trajectory construction. The interpolation weights and SSPz below retain the completed calculation.')}</p>`;
  const addRoles=(parent,id)=>{
    const all=document.getElementById(id).closest('article'),grid=document.createElement('div');grid.className='geometry-role-grid';
    all.before(grid);
    for(const role of ['direct','complementary']){
      const card=document.createElement('article');card.className='chart-card';
      card.innerHTML=`<h3>${role==='direct'?fdkText('① 実データ側','1. Direct data'):fdkText('② 対向データ側','2. Complementary data')}</h3><canvas id="${id}-${role}" width="900" height="960" aria-label="${role==='direct'?fdkText('実データ側の展開図','Direct-data diagram'):fdkText('対向データ側の展開図','Complementary-data diagram')}"></canvas>`;
      grid.append(card);
    }
    all.querySelector('h3').textContent=fdkText('③ 重ね合わせ','3. Overlay');grid.append(all);
    for(const canvas of grid.querySelectorAll('canvas')){
      const b=document.createElement('button');b.type='button';b.className='secondary';b.dataset.fdkCanvas=canvas.id;b.disabled=true;b.textContent=fdkText('600 dpi PNG保存','Save 600-dpi PNG');b.onclick=()=>exportFdkWorkflowCanvas(canvas.id);canvas.after(b);
    }
    parent.classList.add('has-role-diagrams');
  };
  addRoles(geometry,'fdk-geometry');addRoles(weights,'fdk-weights-primary');
  geometry.querySelector('.geometry-role-grid').insertAdjacentHTML('beforebegin',`<h3>${fdkText('2A　補間候補の配置：0～360°展開図','2A  Candidate arrangement: 0–360° unwrapped diagram')}</h3>`);
  geometry.querySelector('.geometry-role-grid').before(controls);
  document.getElementById('geometry-play').onclick=()=>{
    if(geometryPlayback.playing)stopGeometryPlayback();else{
      stopAxialMovie();if(geometryPlayback.fraction>=1)geometryPlayback.fraction=0;
      geometryPlayback.playing=true;geometryPlayback.lastTime=performance.now();paintGeometryConstruction();scheduleGeometryPlayback();
    }
  };
  document.getElementById('geometry-restart').onclick=()=>{stopGeometryPlayback();geometryPlayback.fraction=0;paintGeometryConstruction();};
  document.getElementById('geometry-complete').onclick=()=>{stopGeometryPlayback();geometryPlayback.fraction=1;paintGeometryConstruction();};
  document.getElementById('geometry-progress').oninput=e=>{const fraction=Number(e.target.value)/1000;stopGeometryPlayback();geometryPlayback.fraction=fraction;paintGeometryConstruction();};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopGeometryPlayback();});
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  if(reduced.matches)document.getElementById('geometry-speed').value='45';
  reduced.addEventListener('change',()=>{stopGeometryPlayback();if(reduced.matches)document.getElementById('geometry-speed').value='45';});
}
function updateGeometryPlayControl(){
  const button=document.getElementById('geometry-play');if(!button)return;
  button.textContent=geometryPlayback.playing?fdkText('Ⅱ 一時停止','Ⅱ Pause'):fdkText('▶ 描く過程を再生','▶ Play drawing process');
  button.setAttribute('aria-pressed',String(geometryPlayback.playing));
  const w=geometryPlayback.window;
  const deg=w?geometryPlayback.fraction*(w.end-w.start)*180/Math.PI:0;
  document.getElementById('geometry-progress').value=Math.round(geometryPlayback.fraction*1000);
  document.getElementById('geometry-play-status').textContent=w?
    fdkText('描画開始から ','From drawing start: ')+`${Math.floor(deg/360)} `+fdkText('回転 ＋ ','turns + ')+`${Math.floor(deg%360)}° / ${Math.round(100*geometryPlayback.fraction)}%`+
    (geometryPlayback.fraction===1?fdkText('：完成図',' · complete'):geometryPlayback.playing?fdkText('：描画中',' · drawing'):fdkText('：停止中',' · paused')):'';
}
function stopGeometryPlayback(){
  geometryPlayback.playing=false;clearTimeout(geometryPlayback.timer);geometryPlayback.timer=null;updateGeometryPlayControl();
}
function resetGeometryPlayback(){
  geometryPlayback.playing=false;clearTimeout(geometryPlayback.timer);geometryPlayback.timer=null;geometryPlayback.pending=false;geometryPlayback.cache.clear();geometryPlayback.scene=null;geometryPlayback.window=null;geometryPlayback.fraction=1;updateGeometryPlayControl();
}
function scheduleGeometryPlayback(){
  clearTimeout(geometryPlayback.timer);
  if(!geometryPlayback.playing||geometryPlayback.pending||document.hidden||!geometryPlayback.scene)return;
  geometryPlayback.timer=setTimeout(()=>{
    const now=performance.now(),w=geometryPlayback.window;
    if(geometryPlayback.fraction>=1)geometryPlayback.fraction=0;
    else geometryPlayback.fraction=Math.min(1,geometryPlayback.fraction+Math.min(100,now-geometryPlayback.lastTime)/1000*Number(document.getElementById('geometry-speed').value)*Math.PI/180/(w.end-w.start));
    geometryPlayback.lastTime=now;paintGeometryConstruction();scheduleGeometryPlayback();
  },geometryPlayback.fraction>=1?1600:50);
}
function receiveGeometryInspection(result){
  fdkSelectedResult=result;geometryPlayback.pending=false;
  geometryPlayback.cache.set(selectedStateIndex,result);
  while(geometryPlayback.cache.size>8)geometryPlayback.cache.delete(geometryPlayback.cache.keys().next().value);
  renderFdkSelected();prepareGeometryConstruction();
}
function prepareGeometryConstruction(){
  stopGeometryPlayback();geometryPlayback.fraction=1;
  const r=fdkSelectedResult;if(!r)return;
  geometryPlayback.scene=drawFdkCandidateDiagram({width:900,dataset:{}},r,false,false,'all',true);
  geometryPlayback.window=SSPZConstruction.window(geometryPlayback.scene,symmetricNiceAxis(geometryPlayback.scene.overviewXLimit,3).xMax);
  for(const id of ['geometry-play','geometry-restart','geometry-complete','geometry-progress'])document.getElementById(id).disabled=false;
  updateGeometryPlayControl();
}
function paintGeometryConstruction(){
  const p=geometryPlayback;if(!p.scene||!p.window)return;
  const cutoff=p.fraction>=1?null:p.window.start+p.fraction*(p.window.end-p.window.start);
  for(const role of ['direct','complementary','all']){
    const canvas=document.getElementById('fdk-geometry'+(role==='all'?'':'-'+role));
    drawDiagram(canvas,SSPZConstruction.role(p.scene,role,cutoff),'overview');
    canvas.dataset.constructionProgress=String(p.fraction);canvas.dataset.sourceCursor=String(cutoff??p.window.end);canvas.dataset.startIndex=selectedStateIndex;
  }
  updateGeometryPlayControl();
}
function drawFdkRoleDiagrams(r){
  for(const id of ['fdk-geometry','fdk-weights-primary'])for(const role of ['direct','complementary','all']){
    const canvas=document.getElementById(id+(role==='all'?'':'-'+role));
    drawFdkCandidateDiagram(canvas,r,id!=='fdk-geometry',false,role);
  }
}
