// Replays complete start-angle results, never animates a substitute SSP.
const geometryPlayback={playing:false,pending:false,timer:null,cache:new Map()};
function initializeGeometryPlayback(geometry,weights){
  geometry.querySelector('.state-inspector').insertAdjacentHTML('beforeend',`<div class="geometry-playback-controls">
    <button type="button" id="geometry-play" disabled>${fdkText('▶ 開始角度を再生','▶ Play start angles')}</button>
    <label>${fdkText('角度の刻み','Angle step')}<select id="geometry-stride"><option value="1">1°</option><option value="5" selected>5°</option><option value="10">10°</option></select></label>
    <label>${fdkText('再生速度','Playback speed')}<select id="geometry-speed"><option value="1000">${fdkText('ゆっくり','Slow')}</option><option value="350" selected>${fdkText('標準','Normal')}</option><option value="100">${fdkText('速い','Fast')}</option></select></label>
    <span id="geometry-play-status" role="status"></span></div>
    <p class="geometry-play-note">${fdkText('同じ開始角度の「実データ側 → 対向データ側 → 重ね合わせ」を並べます。再生は360°で先頭に戻り、繰り返します。これは開始角度の異なる撮影条件の比較です。1回の撮影中の管球回転・寝台移動の動画ではありません。','Direct → complementary → overlay use the same start angle. Playback loops at 360°. It compares scans with different start angles, rather than tube and table motion within one scan.')}</p>`);
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
  document.getElementById('geometry-play').onclick=()=>{
    if(geometryPlayback.playing)stopGeometryPlayback();else{
      stopAxialMovie();geometryPlayback.playing=true;updateGeometryPlayControl();scheduleGeometryPlayback();
    }
  };
  for(const id of ['geometry-stride','geometry-speed'])document.getElementById(id).onchange=()=>scheduleGeometryPlayback();
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopGeometryPlayback();});
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  if(reduced.matches)document.getElementById('geometry-speed').value='1000';
  reduced.addEventListener('change',()=>{stopGeometryPlayback();if(reduced.matches)document.getElementById('geometry-speed').value='1000';});
}
function updateGeometryPlayControl(){
  const button=document.getElementById('geometry-play');if(!button)return;
  button.textContent=geometryPlayback.playing?fdkText('Ⅱ 一時停止','Ⅱ Pause'):fdkText('▶ 開始角度を再生','▶ Play start angles');
  button.setAttribute('aria-pressed',String(geometryPlayback.playing));
  document.getElementById('geometry-play-status').textContent=geometryPlayback.playing?(geometryPlayback.pending?fdkText('次の角度を準備中…','Preparing the next angle…'):fdkText('再生中・繰り返し','Playing · loop')):'';
}
function stopGeometryPlayback(){
  const wasPlaying=geometryPlayback.playing;
  geometryPlayback.playing=false;clearTimeout(geometryPlayback.timer);geometryPlayback.timer=null;updateGeometryPlayControl();
  if(wasPlaying&&!geometryPlayback.pending&&fdkSelectedResult)syncAxialMovie();
}
function resetGeometryPlayback(){
  geometryPlayback.playing=false;clearTimeout(geometryPlayback.timer);geometryPlayback.timer=null;geometryPlayback.pending=false;geometryPlayback.cache.clear();updateGeometryPlayControl();
}
function scheduleGeometryPlayback(){
  clearTimeout(geometryPlayback.timer);
  if(!geometryPlayback.playing||geometryPlayback.pending||document.hidden||!fdkSelectedResult)return;
  geometryPlayback.timer=setTimeout(()=>{
    const step=Number(document.getElementById('geometry-stride').value);
    selectFdkState(selectedStateIndex+step,true,true);
  },Number(document.getElementById('geometry-speed').value));
}
function receiveGeometryInspection(result){
  fdkSelectedResult=result;geometryPlayback.pending=false;
  geometryPlayback.cache.set(selectedStateIndex,result);
  while(geometryPlayback.cache.size>8)geometryPlayback.cache.delete(geometryPlayback.cache.keys().next().value);
  renderFdkSelected();updateGeometryPlayControl();scheduleGeometryPlayback();
}
function drawFdkRoleDiagrams(r){
  for(const id of ['fdk-geometry','fdk-weights-primary'])for(const role of ['direct','complementary','all']){
    const canvas=document.getElementById(id+(role==='all'?'':'-'+role));
    drawFdkCandidateDiagram(canvas,r,id!=='fdk-geometry',false,role);
  }
}
