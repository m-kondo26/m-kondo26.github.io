// Optional, user-started flipbook. Its phase is explicitly local to this block;
// the original complete-view profiles provide every SSP frame.
const axialMovie={audit:null,index:0,frame:0,mode:'thickness',selectedPair:null,playing:false,timer:null,request:0,pending:false,background:null,cache:new Map(),cacheKey:null};
function initializeAxialMovie(after){
  const section=document.createElement('section');section.id='axial-movie';section.className='workflow-block';
  section.innerHTML=`<h2>${fdkText('2C　候補点からSSPzへ：動画で確認','2C  From candidates to SSPz: interactive playback')}</h2>
  <p>${fdkText('① 幅T内の断面を動かして重みを積み重ねる　② 開始角度を変えてSSPzの変化を見る','1. Move through width T and accumulate weights.  2. Change the start angle and compare SSPz.')}</p>
  <p>${fdkText('再生は先頭に戻って繰り返します。「一時停止」で止められます。','Playback loops back to the beginning. Select Pause to stop.')}</p>
  <label class="axial-movie-position axial-movie-start" for="axial-movie-start"><strong>${fdkText('（a）～（c）共通の撮影開始角度','Acquisition start angle shared by (a)–(c)')} <span id="axial-movie-start-label">—</span></strong><input id="axial-movie-start" type="range" min="0" max="359" step="1" value="0" disabled><small>${fdkText('この角度を変えると、候補点・重み・SSPzが一緒に更新されます。','Changing this angle updates candidates, weights and SSPz together.')}</small></label>
  <div class="axial-movie-controls">
    <label>${fdkText('再生する動き','Playback mode')}<select id="axial-movie-mode"><option value="thickness">${fdkText('① 幅T内の断面移動','1. Plane sweep within T')}</option><option value="phase">${fdkText('② X線管の開始角度','2. Tube start angle')}</option></select></label>
    <label>${fdkText('再生速度','Playback speed')}<select id="axial-movie-speed"><option value="500">${fdkText('ゆっくり','Slow')}</option><option value="200" selected>${fdkText('標準','Normal')}</option><option value="100">${fdkText('速い','Fast')}</option></select></label>
    <button type="button" id="axial-movie-play" disabled>${fdkText('▶ 再生','▶ Play')}</button>
    <button type="button" id="axial-movie-prev" disabled>${fdkText('1コマ戻る','Previous frame')}</button>
    <button type="button" id="axial-movie-next" disabled>${fdkText('1コマ進む','Next frame')}</button>
    <button type="button" id="axial-movie-reset" disabled>${fdkText('先頭へ','Rewind')}</button>
  </div>
  <label id="axial-movie-plane-control" class="axial-movie-position" for="axial-movie-position"><span id="axial-movie-position-label">${fdkText('計算後に再生できます','Available after calculation')}</span><input id="axial-movie-position" type="range" min="0" max="40" step="1" value="0" disabled></label>
  <p id="axial-movie-status" role="status"></p>
  <p id="axial-movie-coordinate-note" class="angle-reading-note"></p>
  <details class="reading-details axial-angle-detail"><summary>${fdkText('詳細：図中の投影方向とX線管角度を確認','Details: inspect output direction and tube angles')}</summary>
  <div class="axial-angle-controls">
    <label>${fdkText('（a）で強調する補間対象方向（開始角度とは別）','Output direction to highlight in (a), not the start angle')}<select id="axial-movie-pair" disabled></select></label>
  </div>
    <p>${fdkText('同じ撮影条件の中で、候補点の枠と下表に示す方向を選びます。この選択では、全方向から求めた（c）のSSPzは変わりません。撮影開始角度は上の共通スライダーで変更します。','This selects the highlighted candidates and table direction within the same acquisition. It does not change the all-direction SSPz in (c). Use the shared start-angle slider above to change the acquisition.')}</p>
    <p id="axial-movie-source-window"></p>
    <div class="axial-angle-table-scroll" tabindex="0"><table><caption>${fdkText('（a）で強調した対：θ ＋ γ = β','Highlighted pair in (a): θ + γ = β')}</caption><thead><tr><th>${fdkText('使用する側','Role')}</th><th>${fdkText('図での角度差 (°)','Plotted offset (°)')}</th><th>${fdkText('再配列角 θ (°)','Rebinned θ (°)')}</th><th>${fdkText('ファン角 γ (°)','Fan angle γ (°)')}</th><th>${fdkText('X線管角 β (°)','Tube angle β (°)')}</th></tr></thead><tbody id="axial-movie-angle-values"></tbody></table></div>
    <p>${fdkText('実・対向方向の再配列角θは、360°で折り返すと180°異なります。表には実際に選んだ列・回転のθと、ファン角γを加えたX線管角βを示します。同じ側の異なる列が選ばれる場合もあります。βの前後で用いる取得ビューも、下記の有限取得範囲内に限ります。表の角度は折り返しません。図の0°は表示基準であり、X線管角0°ではありません。','Direct and opposing θ differ by 180° modulo a full turn. The table lists actual selected rows and turns, with β = θ + γ. Both selected rows may belong to the same side. Neighboring acquired views used for rebinning must also fit the stated finite source interval. Table angles are unwrapped. Plot zero is a display reference, not tube angle zero.')}</p>
  </details>
  <label class="axial-movie-role-control">${fdkText('（b）に表示する側','Side shown in (b)')}<select id="axial-movie-role"><option value="all">${fdkText('両側','Both sides')}</option><option value="direct">${fdkText('実データ側 ○','Direct ○')}</option><option value="complementary">${fdkText('対向データ側 △','Complementary △')}</option></select></label>
  <div class="axial-movie-grid">
    <article class="chart-card"><h3>${fdkText('（a）動かした断面の候補点と重み','(a) Candidates and weights at the moving plane')}</h3><div class="axial-movie-scroll" tabindex="0"><canvas id="axial-movie-instant" width="900" height="960"></canvas></div></article>
    <article class="chart-card"><h3 id="axial-movie-total-title">${fdkText('（b）幅T内で積み重ねた重み','(b) Weights accumulated within T')}</h3><div class="axial-movie-scroll" tabindex="0"><canvas id="axial-movie-total" width="900" height="960"></canvas></div></article>
  </div>
  <p id="axial-movie-detail">${fdkText('重みの点をクリックすると、同じデータの使用内訳を表示します。','Click a weight marker to inspect both roles of the same datum.')}</p>
  <article class="chart-card axial-movie-ssp"><h3>${fdkText('（c）同じ開始角度のモデルSSPz：幅T全体の平均化後','(c) Model SSPz at the same start angle: after the complete T average')}</h3><div class="axial-movie-scroll" tabindex="0"><canvas id="axial-movie-profile" width="1200" height="540"></canvas></div><button type="button" class="secondary" id="axial-movie-profile-png" disabled>${fdkText('600 dpi PNG保存','Save 600-dpi PNG')}</button></article>
  <p id="axial-movie-acquisition-note"></p>
  <p id="axial-movie-note"></p>
  <button type="button" class="secondary" id="axial-movie-apply" disabled>${fdkText('この開始角度をほかの図にも表示','Show this start angle in the other figures')}</button>
  <details class="reading-details"><summary>${fdkText('図の読み方','How to read the animation')}</summary><p>${fdkText('赤線は平均化の中心、青線は幅T内を動く断面です。（b）は下端から青線までの重みを、全幅Tを分母として積算します。終端で既存の合計重みと一致します。（c）は途中の積算値ではなく、全幅で平均化した最終SSPzです。全周の補間対象方向を対象とし、同じデータが実データ側・対向側として再利用される場合も示します。応答は全方向で平均するため、表示を全周に展開してもSSPzは変わりません。','The red line marks the averaging centre; the blue line moves within T. Panel (b) integrates from the lower boundary to the blue line, always dividing by the full T. At the end it equals the existing total weights. Panel (c) shows the final full-width SSPz, not a partially accumulated profile. The display covers a full turn of output directions, including reuse of the same datum in direct and complementary roles. Averaging over all directions preserves the SSPz.')}</p><p>${fdkText('全周表示では候補点の角度を抜粋し、拡大表示では範囲内の計算方向を省略せず描きます。SSPzは設定した全取得ビューで計算した結果です。幅Tの矩形平均化は本モデルの仮定であり、実機固有の重みを示すものではありません。開始角度の再生は異なる撮影条件の比較であり、1回の撮影中の管球回転を再現した動画ではありません。','The overview samples marker angles; detail retains every calculated direction in the enlarged interval. SSPz retains all configured acquired views. The rectangular T average is a model assumption, not a scanner-specific kernel. Start-angle playback compares separate acquisition conditions; it is not tube motion during one scan.')}</p></details>`;
  after.after(section);
  const el=id=>document.getElementById('axial-movie-'+id);
  el('mode').onchange=()=>{stopAxialMovie();axialMovie.mode=el('mode').value;el('plane-control').hidden=axialMovie.mode==='phase';axialMovie.frame=0;requestAxialMovie(axialMovie.index);};
  el('play').onclick=()=>{if(axialMovie.playing)stopAxialMovie();else{stopGeometryPlayback();axialMovie.playing=true;el('play').textContent=fdkText('Ⅱ 一時停止','Ⅱ Pause');scheduleAxialMovie();}};
  el('prev').onclick=()=>{stopAxialMovie();advanceAxialMovie(-1);};el('next').onclick=()=>{stopAxialMovie();advanceAxialMovie(1);};
  el('reset').onclick=()=>{stopAxialMovie();if(axialMovie.mode==='phase')requestAxialMovie(0);else{axialMovie.frame=0;renderAxialMovie();}};
  el('start').oninput=e=>{stopAxialMovie();requestAxialMovie(Number(e.target.value));};
  el('position').oninput=e=>{stopAxialMovie();axialMovie.frame=Number(e.target.value);renderAxialMovie();};
  el('role').onchange=()=>renderAxialMovie();el('apply').onclick=()=>{stopAxialMovie();selectFdkState(axialMovie.index,true);};
  el('pair').onchange=()=>{stopAxialMovie();axialMovie.selectedPair=Number(el('pair').value);renderAxialMovie();};
  el('instant').onclick=event=>inspectAxialMoviePair(event);
  el('total').onclick=event=>inspectAxialMovieMarker(event);
  el('profile-png').onclick=exportAxialMovieProfile;
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAxialMovie();});
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');if(reduced.matches)el('speed').value='500';
  reduced.addEventListener('change',()=>{stopAxialMovie();if(reduced.matches)el('speed').value='500';});
}
function stopAxialMovie(){
  axialMovie.playing=false;clearTimeout(axialMovie.timer);axialMovie.timer=null;
  const button=document.getElementById('axial-movie-play');if(button)button.textContent=fdkText('▶ 再生','▶ Play');
}
function disableAxialMovie(){
  stopAxialMovie();axialMovie.request++;axialMovie.pending=false;axialMovie.audit=null;axialMovie.background=null;axialMovie.cache.clear();
  worker?.postMessage({type:'axial-animation-cancel'});
  document.querySelectorAll('#axial-movie button, #axial-movie input, #axial-movie-pair').forEach(e=>e.disabled=true);
  const e=document.getElementById('axial-movie-status');if(e)e.textContent=fdkText('計算後に再生できます。','Available after calculation.');
}
function syncAxialMovie(){
  if(!fdkResult?.profiles?.length)return;
  stopAxialMovie();axialMovie.frame=0;requestAxialMovie(selectedStateIndex);
}
function refreshAxialMovieDisplay(){
  stopAxialMovie();requestAxialMovie(axialMovie.index);
}
function axialMovieAngleVisible(audit,point){
  if(!audit.angleRange)return true;
  const angle=SSPZAngles.offset(audit.config,audit.base,point.referenceView);
  return angle>=audit.angleRange[0]-1e-10&&angle<audit.angleRange[1]-1e-10;
}
function requestAxialMovie(index){
  if(!fdkResult?.profiles?.length||!worker)return;
  clearTimeout(axialMovie.timer);axialMovie.index=((index%fdkResult.profiles.length)+fdkResult.profiles.length)%fdkResult.profiles.length;
  axialMovie.request++;axialMovie.pending=true;
  const angle=fdkResult.profiles[axialMovie.index].phase*180/Math.PI;
  document.getElementById('axial-movie-start').value=axialMovie.index;
  document.getElementById('axial-movie-start-label').textContent=`${angle.toFixed(1)}°`;
  document.getElementById('axial-movie-profile-png').disabled=true;
  document.getElementById('axial-movie-status').textContent=fdkText('候補点・重み・SSPzを更新中：','Updating candidates, weights and SSPz: ')+`${angle.toFixed(1)}°`;
  const displayRange=typeof candidateDisplayRange==='function'?candidateDisplayRange():null;
  const angleRange=displayRange?[displayRange.min,displayRange.max]:null;
  const key=axialMovie.mode+':'+axialMovie.index+':'+(angleRange?angleRange.join('-'):'overview');axialMovie.cacheKey=key;
  if(axialMovie.cache.has(key)){receiveAxialMovie({requestId:axialMovie.request,index:axialMovie.index,audit:axialMovie.cache.get(key)});return;}
  for(const id of ['instant','total','profile']){
    const canvas=document.getElementById('axial-movie-'+id);
    delete canvas.dataset.startIndex;
    drawCanvasStatus(canvas,`${fdkText('開始角度','Start angle')} ${angle.toFixed(1)}°`,fdkText('同じ条件の3図を更新中','Updating all three panels for the same condition'));
  }
  worker.postMessage({type:'axial-animation',index:axialMovie.index,mode:axialMovie.mode,angleRange,requestId:axialMovie.request});
}
function receiveAxialMovie(message){
  if(message.requestId!==axialMovie.request||message.index!==axialMovie.index)return;
  axialMovie.audit=SSPZAngles.animation(message.audit);axialMovie.pending=false;axialMovie.background=null;
  axialMovie.cache.set(axialMovie.cacheKey,axialMovie.audit);
  while(axialMovie.cache.size>4)axialMovie.cache.delete(axialMovie.cache.keys().next().value);
  document.querySelectorAll('#axial-movie button, #axial-movie input, #axial-movie-pair').forEach(e=>e.disabled=false);
  renderAxialMovie();scheduleAxialMovie();
}
function failAxialMovie(message){
  if(message.requestId!==axialMovie.request)return;
  stopAxialMovie();axialMovie.pending=false;axialMovie.audit=null;document.getElementById('axial-movie-status').textContent=message.message;
  for(const id of ['instant','total','profile'])drawCanvasStatus(document.getElementById('axial-movie-'+id),fdkText('更新できませんでした','Update failed'),message.message,'error');
}
function scheduleAxialMovie(){
  clearTimeout(axialMovie.timer);if(!axialMovie.playing||axialMovie.pending||document.hidden)return;
  axialMovie.timer=setTimeout(()=>advanceAxialMovie(1),Number(document.getElementById('axial-movie-speed').value));
}
function advanceAxialMovie(delta){
  if(!axialMovie.audit)return;
  const phase=axialMovie.mode==='phase',count=phase?fdkResult.profiles.length:axialMovie.audit.frames.length;
  if(!count){stopAxialMovie();return;}
  let next=(phase?axialMovie.index:axialMovie.frame)+delta;
  if(next>=count||next<0){
    if(!axialMovie.playing){stopAxialMovie();return;}
    next=((next%count)+count)%count;
  }
  if(phase){
    requestAxialMovie(next);
  }else{
    axialMovie.frame=next;renderAxialMovie();scheduleAxialMovie();
  }
}
function axialMovieBackground(audit,candidatesOnly=false){
  const c=audit.config,V=c.viewSamples,angles=[],families=[];
  const groupsAt=v=>axialAnimationGroups(c,v);
  const segments=Math.min(V,360),firstGroups=groupsAt(audit.base);
  firstGroups.forEach(g=>families.push({id:(g.direction?'complementary-':'direct-')+g.focus,family:g.direction?'complementary':'direct',angles,axial:[],scales:[]}));
  let min=Infinity,max=-Infinity;
  for(let i=0;i<=segments;i++){
    angles.push(360*i/segments);
    groupsAt(audit.base+V*i/segments).forEach((g,j)=>{
      families[j].axial.push(g.origin);families[j].scales.push(g.spacing/c.rowWidth);
      for(const row of [0,c.rows-1]){const z=g.origin+(row-(c.rows-1)/2)*g.spacing-audit.zObject;min=Math.min(min,z);max=Math.max(max,z);}
    });
  }
  const limit=symmetricNiceAxis(audit.xHalfSpan,3).xMax;
  const turnMin=Math.ceil((-limit-max)/c.feed),turnMax=Math.floor((limit-min)/c.feed);
  const turns=Array.from({length:turnMax-turnMin+1},(_,i)=>turnMin+i);
  const diagram={totalRows:c.rows,z0:audit.zObject,zoomXLimit:audit.xHalfSpan,overviewXLimit:audit.xHalfSpan,
    angleMin:audit.angleRange?.[0]??0,angleMax:audit.angleRange?.[1]??360,
    interpolationBandHalfWidth:c.axialAverageMm/2,traceFamilies:candidatesOnly?[]:families,roleMarkersOnly:candidatesOnly,
    traceGeometry:{...families[0],rowOffsets:Array.from({length:c.rows},(_,i)=>(i-(c.rows-1)/2)*c.rowWidth),feed:c.feed,turns},weightedPoints:[],
    xAxisLabel:fdkText('候補列中心  zᵢ − z₀  (mm)','Candidate row centre  zᵢ − z₀  (mm)'),
    yAxisLabel:fdkText('補間対象方向の角度差 (°)','Output interpolation direction (°)'),
    directLegendLabel:fdkText('実データ側 ○','Direct ○'),weightLegendLabel:fdkText('重み w','Weight w'),
    weightLegendNote:candidatesOnly
      ?fdkText('選ばれた候補点のみ。○：実データ側、△：対向側。','Selected candidates only. ○: direct; △: opposing.' )
      :fdkText('各方向の補間重み。対向側の再配列角は±180°。','Weights at each output direction; opposing data: ±180°.'),
    referenceViewSamples:V,renderedAngleSamples:audit.angleSamplesPerTurn};
  const canvas=document.createElement('canvas');canvas.width=900;canvas.height=960;
  drawDiagram(canvas,diagram,'zoom');canvas.dataset.geometryTrajectories=String(!candidatesOnly);return canvas;
}
function paintAxialMovieWeights(canvas,points,u,accumulated){
  const a=axialMovie.audit,c=a.config;
  axialMovie.background??={};
  const background=axialMovie.background[accumulated?'total':'instant']??=axialMovieBackground(a,!accumulated);
  const ctx=canvas.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,900,960);ctx.drawImage(background,0,0);
  const xmin=Number(background.dataset.xMin),xmax=Number(background.dataset.xMax),left=112,top=32,width=754,height=650;
  const angleMin=a.angleRange?.[0]??0,angleMax=a.angleRange?.[1]??360;
  const x=z=>left+(z-xmin)/(xmax-xmin)*width,y=v=>top+(SSPZAngles.offset(c,a.base,v)-angleMin)/(angleMax-angleMin)*height;
  const role=document.getElementById('axial-movie-role').value;
  ctx.save();ctx.beginPath();ctx.rect(left,top,width,height);ctx.clip();
  if(accumulated&&axialMovie.mode==='thickness'){
    ctx.fillStyle='rgba(35,105,175,.09)';ctx.fillRect(x(-c.axialAverageMm/2),top,x(u)-x(-c.axialAverageMm/2),height);
  }
  const rendered=[];
  for(const p of [...points].sort((a,b)=>a.weight-b.weight)){
    if(!axialMovieAngleVisible(a,p))continue;
    if(accumulated&&role!=='all'&&p.direction!==(role==='direct'?0:1))continue;
    const py=y(p.referenceView);
    drawWeightedMarker(ctx,p.row,c.rows,x(p.z),py,5.2,p.weight,p.direction?'triangle':'circle');
    rendered.push({p,x:x(p.z),y:py});
  }
  if(!accumulated){
    ctx.strokeStyle='#233746';ctx.lineWidth=1.8;ctx.setLineDash([]);
    for(const q of rendered)if(q.p.referenceView===axialMovie.selectedPair)ctx.strokeRect(q.x-8,q.y-8,16,16);
  }
  if(axialMovie.mode==='thickness'||!accumulated){ctx.strokeStyle='#2166ac';ctx.lineWidth=2.5;ctx.setLineDash([7,4]);ctx.beginPath();ctx.moveTo(x(u),top);ctx.lineTo(x(u),top+height);ctx.stroke();ctx.setLineDash([]);}
  ctx.restore();canvas.dataset.renderState='ready';canvas.dataset.startIndex=axialMovie.index;canvas.dataset.planeMm=u;canvas.dataset.partial=String(accumulated&&axialMovie.mode==='thickness');canvas.dataset.markerCount=rendered.length;
  canvas.dataset.angleCoordinate='full-turn-output';
  canvas.dataset.geometryTrajectories=background.dataset.geometryTrajectories;
  canvas.dataset.outputDirectionCount=new Set(rendered.map(q=>SSPZAngles.offset(c,a.base,q.p.referenceView))).size;
  canvas.dataset.angleMin=angleMin;canvas.dataset.angleMax=angleMax;canvas.dataset.nativeAngleDetail=String(!!a.angleRange);
  if(accumulated)axialMovie.hitPoints=rendered;else axialMovie.instantHitPoints=rendered;
}
function renderAxialAngleReading(frame){
  const a=axialMovie.audit,c=a.config,el=id=>document.getElementById('axial-movie-'+id);
  const refs=[...new Set(frame.instant.filter(p=>axialMovieAngleVisible(a,p)).map(p=>p.referenceView))].sort((x,y)=>SSPZAngles.offset(c,a.base,x)-SSPZAngles.offset(c,a.base,y));
  if(!refs.length){el('pair').disabled=true;el('angle-values').replaceChildren();return;}
  const targetOffset=SSPZAngles.offset(c,a.base,axialMovie.selectedPair??refs[0]);
  const distance=v=>{const d=Math.abs(SSPZAngles.offset(c,a.base,v)-targetOffset);return Math.min(d,360-d);};
  axialMovie.selectedPair=refs.reduce((best,v)=>distance(v)<distance(best)?v:best,refs[0]);
  const key=refs.join(',');
  if(el('pair').dataset.refs!==key){
    el('pair').replaceChildren(...refs.map(v=>new Option(`${SSPZAngles.offset(c,a.base,v).toFixed(1)}°`,String(v))));
    el('pair').dataset.refs=key;
  }
  el('pair').disabled=false;el('pair').value=axialMovie.selectedPair;
  el('coordinate-note').textContent=(a.angleRange
    ?`${a.angleRange[0]}–${a.angleRange[1]}°`+fdkText('の範囲を、計算した全方向で拡大表示します。',' is enlarged with every calculated output direction.')
    :fdkText('補間対象の全周0～360°を表示します。','The display covers output directions over 0–360°.'))
    +fdkText('各方向で使う実データ側○と対向側△を、同じ高さに示します。（a）は選ばれた候補点のみを表示し、枠は強調する方向の候補を示します。',' Direct ○ and complementary △ data for each output direction share a height. Panel (a) shows selected candidates only; boxes highlight the chosen direction’s candidates.');
  const degrees=r=>{const d=r*180/Math.PI;return (Math.abs(d)<.05?0:d).toFixed(1);};
  const centre=c.phase+2*Math.PI*(a.zObject+frame.u)/c.feed,half=Math.PI+(c.axialRule==='parallel'?0:c.fullFanAngleDeg*Math.PI/180);
  el('source-window').textContent=fdkText('この断面の取得範囲 β：','Source-angle support at this plane, β: ')+`${degrees(centre-half)}° ～ ${degrees(centre+half)}°`+fdkText('（全ファン角 Φ＝',' (full fan Φ = ')+`${c.axialRule==='parallel'?0:c.fullFanAngleDeg}°)`;
  const chosen=frame.instant.filter(p=>p.referenceView===axialMovie.selectedPair);
  const rows=chosen.map(p=>SSPZAngles.sample(c,a.base,p)).map(q=>{
    const tr=document.createElement('tr');
    const role=(q.direction?fdkText('対向側 △','Complementary △'):fdkText('実データ側 ○','Direct ○'))+` / ${fdkText('列','row')} ${q.row+1}${c.zFfsEnabled?' / '+(q.focus?'B':'A'):''}`;
    const values=[role,q.referenceOffset.toFixed(1),degrees(q.theta),degrees(q.gamma),degrees(q.beta)];
    values.forEach((value,i)=>{const td=document.createElement(i?'td':'th');if(!i)td.scope='row';td.textContent=value;tr.append(td);});
    return tr;
  });
  el('angle-values').replaceChildren(...rows);
}
function inspectAxialMoviePair(event){
  if(!axialMovie.audit||axialMovie.pending||!axialMovie.instantHitPoints)return;
  const rect=event.currentTarget.getBoundingClientRect(),x=(event.clientX-rect.left)*900/rect.width,y=(event.clientY-rect.top)*960/rect.height;
  let hit=null,distance=20;
  for(const q of axialMovie.instantHitPoints){const d=Math.hypot(q.x-x,q.y-y);if(d<distance){hit=q;distance=d;}}
  if(hit){stopAxialMovie();axialMovie.selectedPair=hit.p.referenceView;renderAxialMovie();}
}
function renderAxialMovie(){
  const audit=axialMovie.audit;if(!audit||!fdkResult||axialMovie.pending)return;
  const c=audit.config,frame=audit.frames[axialMovie.mode==='phase'?0:axialMovie.frame];if(!frame)return;
  const phase=c.phase*180/Math.PI,progress=Math.round(frame.fraction*100),el=id=>document.getElementById('axial-movie-'+id);
  el('start').max=fdkResult.profiles.length-1;el('start').value=axialMovie.index;
  el('start-label').textContent=`${phase.toFixed(1)}°`;
  el('plane-control').hidden=axialMovie.mode==='phase';
  el('position').max=audit.frames.length-1;el('position').value=axialMovie.frame;
  el('position-label').textContent=fdkText('幅T内を動かす断面位置','Plane position within T')+` u = ${frame.u.toFixed(2)} mm / T = ${c.axialAverageMm.toFixed(2)} mm`;
  el('status').textContent=axialMovie.mode==='thickness'?fdkText('開始角度を固定：幅Tの','Fixed start angle: ')+` ${progress}% `+fdkText('まで積算','of T accumulated'):fdkText('開始角度ごとの別撮影を比較：幅T全体の重みを表示','Comparing separate start-angle conditions: full-T weights shown');
  el('total-title').textContent=axialMovie.mode==='thickness'?fdkText('（b）幅T内で積み重ねた重み','(b) Weights accumulated within T')+` — ${progress}%`:fdkText('（b）幅T全体の合計重み','(b) Total weights over T');
  el('note').textContent=fdkText('赤線：平均化の中心。青線：幅T内を動く断面。（a）（b）は中央の応答を作る重み、（c）は全評価位置で計算済みのSSPzです。','Red: averaging centre. Blue: plane moving within T. (a) and (b) explain the central response; (c) is the SSPz at all evaluation positions.')+(audit.angleRange
    ?fdkText('拡大範囲内の候補点は、計算した全方向を省略せず表示しています。',' Within the enlarged interval, markers retain every calculated output direction.')
    :fdkText('候補点は',' Markers are sampled every ')+`${(360*audit.stride/c.viewSamples).toFixed(1)}°`+fdkText('間隔で抜粋。',' from the full calculation.'))
    +fdkText('（a）は候補点のみ、（b）の背景は選択区間外の隣接回転を含む列軌跡です。',' Panel (a) shows candidates only; the background in (b) shows row trajectories, including neighboring turns outside the selected interval.');
  renderAxialAngleReading(frame);
  for(const id of ['instant','total','profile']){loadingCanvasStatuses.delete(el(id));el(id).removeAttribute('aria-busy');}
  paintAxialMovieWeights(el('instant'),frame.instant,frame.u,false);paintAxialMovieWeights(el('total'),frame.accumulated,frame.u,true);
  drawAxialMovieProfile(el('profile'));
  const focus=c.focalSizeMm??0;
  el('acquisition-note').textContent=(focus>0
    ?fdkText('取得応答に体軸方向の有限焦点を適用：','Finite axial focus applied to acquired data: ')+`${focus.toFixed(2)} mm. `
    :fdkText('点焦点で計算。','Point-focus calculation. '))
    +fdkText('候補点は列中心、マーカーの濃さは補間重みです。SSPzには、各取得データの検出器開口と焦点の応答を反映しています。','Candidate markers show row centres and interpolation weights. SSPz also includes each acquired datum’s detector-aperture and focal response.');
  el('detail').textContent=fdkText('（b）の点をクリックすると、同じデータの使用内訳を表示します。','Click a marker in (b) to inspect both roles of that datum.');
}
function drawAxialMovieProfile(canvas,index=axialMovie.index){
  const p=fdkResult.profiles[index],xs=fdkResult.z,phase=p.phase*180/Math.PI;
  const plot=fdkAxes(canvas,xs[0],xs.at(-1),0,1.05,'z position (mm)','Normalized SSPz','(c)', [0,.5,1],70);
  fdkDrawLines(plot,xs,[p.profile],FDK_PRIMARY_COLOR);fdkArrow(plot,p.fwhm,.5,FDK_PRIMARY_COLOR);
  plot.ctx.strokeStyle='#555';plot.ctx.setLineDash([5,5]);plot.ctx.beginPath();plot.ctx.moveTo(plot.x(0),plot.b.top);plot.ctx.lineTo(plot.x(0),plot.b.bottom);plot.ctx.stroke();plot.ctx.setLineDash([]);
  plot.ctx.fillStyle=FDK_PRIMARY_COLOR;plot.ctx.textAlign='center';plot.ctx.font='24px Arial';plot.ctx.fillText(`FWHM ${p.fwhm.width.toFixed(2)} mm / FWTM ${p.fwtm.width.toFixed(2)} mm / ${phase.toFixed(1)}°`,(plot.b.left+plot.b.right)/2,38);
  canvas.dataset.startIndex=index;canvas.dataset.profileSource='full-acquired-view-result';
}
async function exportAxialMovieProfile(){
  if(!fdkResult||!axialMovie.audit||axialMovie.pending)return;
  stopAxialMovie();const index=axialMovie.index,source=document.getElementById('axial-movie-profile'),canvas=document.createElement('canvas');
  canvas.width=Math.round(180/25.4*600);canvas.height=Math.round(canvas.width*source.height/source.width);
  drawAxialMovieProfile(canvas,index);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve));
  downloadBlob(`${fdkFileStem(fdkResult)}_selected-profile_angle-${index}_600dpi.png`,await pngWithResolution(blob,600),'image/png');
}
function inspectAxialMovieMarker(event){
  if(!axialMovie.audit||axialMovie.pending||!axialMovie.hitPoints)return;const rect=event.currentTarget.getBoundingClientRect(),x=(event.clientX-rect.left)*900/rect.width,y=(event.clientY-rect.top)*960/rect.height;
  let hit=null,distance=16;for(const q of axialMovie.hitPoints){const d=Math.hypot(q.x-x,q.y-y);if(d<distance){hit=q;distance=d;}}
  if(!hit)return;const p=hit.p,c=axialMovie.audit.config;
  const weight=v=>v===0?'0':v<.001?'<0.001':v.toFixed(3);
  document.getElementById('axial-movie-detail').textContent=fdkText('全幅Tでの使用内訳（角度平均前）：検出器列','Full-T role weights (before angular averaging): detector row')+` ${p.row+1}${c.zFfsEnabled?' / '+(p.focus?'B':'A'):''} / z = ${p.z.toFixed(2)} mm / `+fdkText('実データ側','direct')+`: ${weight(p.directWeight)} / `+fdkText('対向データ側','complementary')+`: ${weight(p.complementaryWeight)} / `+fdkText('合計','total')+`: ${weight(p.directWeight+p.complementaryWeight)}`;
}
