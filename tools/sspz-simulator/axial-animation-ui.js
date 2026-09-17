// Optional, user-started flipbook. Its phase is explicitly local to this block;
// the original complete-view profiles provide every SSP frame.
const axialMovie={audit:null,index:0,frame:0,mode:'thickness',playing:false,timer:null,request:0,pending:false,background:null,cache:new Map()};
function initializeAxialMovie(after){
  const section=document.createElement('section');section.id='axial-movie';section.className='workflow-block';
  section.innerHTML=`<h2>${fdkText('2C　候補点からSSPzへ：動画で確認','2C  From candidates to SSPz: interactive playback')}</h2>
  <p>${fdkText('① 幅T内の断面を動かして重みを積み重ねる　② 開始角度を変えてSSPzの変化を見る','1. Move through width T and accumulate weights.  2. Change the start angle and compare SSPz.')}</p>
  <div class="axial-movie-controls">
    <label>${fdkText('再生する動き','Playback mode')}<select id="axial-movie-mode"><option value="thickness">${fdkText('① 幅T内の断面移動','1. Plane sweep within T')}</option><option value="phase">${fdkText('② X線管の開始角度','2. Tube start angle')}</option></select></label>
    <label>${fdkText('再生速度','Playback speed')}<select id="axial-movie-speed"><option value="500">${fdkText('ゆっくり','Slow')}</option><option value="200" selected>${fdkText('標準','Normal')}</option><option value="100">${fdkText('速い','Fast')}</option></select></label>
    <button type="button" id="axial-movie-play" disabled>${fdkText('▶ 再生','▶ Play')}</button>
    <button type="button" id="axial-movie-prev" disabled>${fdkText('1コマ戻る','Previous frame')}</button>
    <button type="button" id="axial-movie-next" disabled>${fdkText('1コマ進む','Next frame')}</button>
    <button type="button" id="axial-movie-reset" disabled>${fdkText('先頭へ','Rewind')}</button>
  </div>
  <label class="axial-movie-position" for="axial-movie-position"><span id="axial-movie-position-label">${fdkText('計算後に再生できます','Available after calculation')}</span><input id="axial-movie-position" type="range" min="0" max="40" step="1" value="0" disabled></label>
  <p id="axial-movie-status" role="status"></p>
  <label class="axial-movie-role-control">${fdkText('（b）の使用内訳','Role categories in (b)')}<select id="axial-movie-role"><option value="all">${fdkText('全体','All')}</option><option value="direct">${fdkText('実データ側のみで使用','Used only as direct data')}</option><option value="complementary">${fdkText('対向データ側のみで使用','Used only as complementary data')}</option><option value="both">${fdkText('両側で使用','Used in both roles')}</option></select></label>
  <div class="axial-movie-grid">
    <article class="chart-card"><h3>${fdkText('（a）動かした断面の候補点と重み','(a) Candidates and weights at the moving plane')}</h3><div class="axial-movie-scroll" tabindex="0"><canvas id="axial-movie-instant" width="900" height="960"></canvas></div></article>
    <article class="chart-card"><h3 id="axial-movie-total-title">${fdkText('（b）幅T内で積み重ねた重み','(b) Weights accumulated within T')}</h3><div class="axial-movie-scroll" tabindex="0"><canvas id="axial-movie-total" width="900" height="960"></canvas></div></article>
  </div>
  <p id="axial-movie-detail">${fdkText('重みの点をクリックすると、同じデータの使用内訳を表示します。','Click a weight marker to inspect both roles of the same datum.')}</p>
  <article class="chart-card axial-movie-ssp"><h3>${fdkText('（c）同じ開始角度のモデルSSPz：幅T全体の平均化後','(c) Model SSPz at the same start angle: after the complete T average')}</h3><div class="axial-movie-scroll" tabindex="0"><canvas id="axial-movie-profile" width="1200" height="540"></canvas></div></article>
  <p id="axial-movie-note"></p>
  <button type="button" class="secondary" id="axial-movie-apply" disabled>${fdkText('この開始角度をほかの図にも表示','Show this start angle in the other figures')}</button>
  <details class="reading-details"><summary>${fdkText('図の読み方','How to read the animation')}</summary><p>${fdkText('赤線は平均化の中心、青線は幅T内を動く断面です。（b）は下端から青線までの重みを、全幅Tを分母として積算します。終端で既存の合計重みと一致します。（c）は途中の積算値ではなく、全幅で平均化した最終SSPzです。使用内訳は全幅で判定し、同じデータを両側へ二重計上しません。','The red line marks the averaging centre; the blue line moves within T. Panel (b) integrates from the lower boundary to the blue line, always dividing by the full T. At the end it equals the existing total weights. Panel (c) shows the final full-width SSPz, not a partially accumulated profile. Role categories refer to the full window; aggregate weights are not duplicated into both roles.')}</p><p>${fdkText('図の候補点は表示用に角度を抜粋しています。SSPzは設定した全取得ビューで計算した結果です。幅Tの矩形平均化は本モデルの仮定であり、実機固有の重みを示すものではありません。開始角度の再生は異なる撮影条件の比較であり、1回の撮影中の管球回転を再現した動画ではありません。','Markers use a subset of display angles; SSPz retains all configured acquired views. The rectangular T average is a model assumption, not a scanner-specific kernel. Start-angle playback compares separate acquisition conditions; it is not tube motion during one scan.')}</p></details>`;
  after.after(section);
  const el=id=>document.getElementById('axial-movie-'+id);
  el('mode').onchange=()=>{stopAxialMovie();axialMovie.mode=el('mode').value;axialMovie.frame=0;requestAxialMovie(axialMovie.index);};
  el('play').onclick=()=>{if(axialMovie.playing)stopAxialMovie();else{axialMovie.playing=true;el('play').textContent=fdkText('Ⅱ 一時停止','Ⅱ Pause');if(axialMovie.mode==='thickness'&&axialMovie.frame===40)axialMovie.frame=-1;scheduleAxialMovie();}};
  el('prev').onclick=()=>{stopAxialMovie();advanceAxialMovie(-1);};el('next').onclick=()=>{stopAxialMovie();advanceAxialMovie(1);};
  el('reset').onclick=()=>{stopAxialMovie();if(axialMovie.mode==='phase')requestAxialMovie(0);else{axialMovie.frame=0;renderAxialMovie();}};
  el('position').oninput=e=>{stopAxialMovie();if(axialMovie.mode==='phase')requestAxialMovie(Number(e.target.value));else{axialMovie.frame=Number(e.target.value);renderAxialMovie();}};
  el('role').onchange=()=>renderAxialMovie();el('apply').onclick=()=>{stopAxialMovie();selectFdkState(axialMovie.index,true);};
  el('total').onclick=event=>inspectAxialMovieMarker(event);
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
  document.querySelectorAll('#axial-movie button, #axial-movie input').forEach(e=>e.disabled=true);
  const e=document.getElementById('axial-movie-status');if(e)e.textContent=fdkText('計算後に再生できます。','Available after calculation.');
}
function syncAxialMovie(){
  if(!fdkResult?.profiles?.length)return;
  stopAxialMovie();axialMovie.frame=0;requestAxialMovie(selectedStateIndex);
}
function requestAxialMovie(index){
  if(!fdkResult?.profiles?.length||!worker)return;
  clearTimeout(axialMovie.timer);axialMovie.index=((index%fdkResult.profiles.length)+fdkResult.profiles.length)%fdkResult.profiles.length;
  axialMovie.request++;axialMovie.pending=true;
  document.getElementById('axial-movie-status').textContent=fdkText('候補点の動画を準備中…（一時停止できます）','Preparing candidate frames… (Pause remains available)');
  const key=axialMovie.mode+':'+axialMovie.index;
  if(axialMovie.cache.has(key)){receiveAxialMovie({requestId:axialMovie.request,index:axialMovie.index,audit:axialMovie.cache.get(key)});return;}
  worker.postMessage({type:'axial-animation',index:axialMovie.index,mode:axialMovie.mode,requestId:axialMovie.request});
}
function receiveAxialMovie(message){
  if(message.requestId!==axialMovie.request)return;
  axialMovie.audit=message.audit;axialMovie.pending=false;axialMovie.background=null;
  const key=axialMovie.mode+':'+message.index;axialMovie.cache.set(key,message.audit);
  while(axialMovie.cache.size>4)axialMovie.cache.delete(axialMovie.cache.keys().next().value);
  document.querySelectorAll('#axial-movie button, #axial-movie input').forEach(e=>e.disabled=false);
  renderAxialMovie();scheduleAxialMovie();
}
function failAxialMovie(message){
  if(message.requestId!==axialMovie.request)return;
  stopAxialMovie();axialMovie.pending=false;document.getElementById('axial-movie-status').textContent=message.message;
}
function scheduleAxialMovie(){
  clearTimeout(axialMovie.timer);if(!axialMovie.playing||axialMovie.pending||document.hidden)return;
  axialMovie.timer=setTimeout(()=>advanceAxialMovie(1),Number(document.getElementById('axial-movie-speed').value));
}
function advanceAxialMovie(delta){
  if(!axialMovie.audit)return;
  if(axialMovie.mode==='phase'){
    const next=axialMovie.index+delta;
    if(next>=fdkResult.profiles.length||next<0){stopAxialMovie();return;}
    requestAxialMovie(next);
  }else{
    const next=axialMovie.frame+delta;
    if(next>=axialMovie.audit.frames.length||next<0){stopAxialMovie();return;}
    axialMovie.frame=next;renderAxialMovie();scheduleAxialMovie();
  }
}
function axialMovieBackground(audit){
  const c=audit.config,V=c.viewSamples,angles=[],families=[];
  const segments=Math.min(V,360),firstGroups=axialAnimationGroups(c,audit.base);
  firstGroups.forEach(g=>families.push({id:(g.direction?'complementary-':'direct-')+g.focus,family:g.direction?'complementary':'direct',angles,axial:[],scales:[]}));
  let min=Infinity,max=-Infinity;
  for(let i=0;i<=segments;i++){
    angles.push(360*i/segments);
    axialAnimationGroups(c,audit.base+V*i/segments).forEach((g,j)=>{
      families[j].axial.push(g.origin);families[j].scales.push(g.spacing/c.rowWidth);
      for(const row of [0,c.rows-1]){const z=g.origin+(row-(c.rows-1)/2)*g.spacing-audit.zObject;min=Math.min(min,z);max=Math.max(max,z);}
    });
  }
  const limit=symmetricNiceAxis(audit.xHalfSpan,3).xMax;
  const turnMin=Math.ceil((-limit-max)/c.feed),turnMax=Math.floor((limit-min)/c.feed);
  const turns=Array.from({length:turnMax-turnMin+1},(_,i)=>turnMin+i);
  const diagram={totalRows:c.rows,z0:audit.zObject,zoomXLimit:audit.xHalfSpan,overviewXLimit:audit.xHalfSpan,
    interpolationBandHalfWidth:c.axialAverageMm/2,traceFamilies:families,
    traceGeometry:{...families[0],rowOffsets:Array.from({length:c.rows},(_,i)=>(i-(c.rows-1)/2)*c.rowWidth),feed:c.feed,turns},weightedPoints:[],
    xAxisLabel:fdkText('候補列中心  zᵢ − z₀  (mm)','Candidate row centre  zᵢ − z₀  (mm)'),
    yAxisLabel:fdkText('実データ側の角度差  θ  (°)','Direct-side angle offset  θ  (°)'),
    directLegendLabel:fdkText('実データ側 ○','Direct ○'),weightLegendLabel:fdkText('重み w','Weight w'),
    weightLegendNote:fdkText('赤：平均化の中心　青：幅T内の断面','Red: averaging centre; blue: plane within T'),
    referenceViewSamples:V,renderedAngleSamples:audit.angleSamplesPerTurn};
  const canvas=document.createElement('canvas');canvas.width=900;canvas.height=960;
  drawDiagram(canvas,diagram,'zoom');return canvas;
}
function paintAxialMovieWeights(canvas,points,u,accumulated){
  const a=axialMovie.audit,c=a.config;
  axialMovie.background??=axialMovieBackground(a);
  const ctx=canvas.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,900,960);ctx.drawImage(axialMovie.background,0,0);
  const xmin=Number(axialMovie.background.dataset.xMin),xmax=Number(axialMovie.background.dataset.xMax),left=112,top=32,width=754,height=650;
  const x=z=>left+(z-xmin)/(xmax-xmin)*width,y=v=>top+(((v-a.base)%c.viewSamples+c.viewSamples)%c.viewSamples)/c.viewSamples*height;
  const role=document.getElementById('axial-movie-role').value;
  ctx.save();ctx.beginPath();ctx.rect(left,top,width,height);ctx.clip();
  if(accumulated&&axialMovie.mode==='thickness'){
    ctx.fillStyle='rgba(35,105,175,.09)';ctx.fillRect(x(-c.axialAverageMm/2),top,x(u)-x(-c.axialAverageMm/2),height);
  }
  const rendered=[];
  for(const p of [...points].sort((a,b)=>a.weight-b.weight)){
    if(accumulated&&role!=='all'&&p.use!==role)continue;
    drawWeightedMarker(ctx,p.row,c.rows,x(p.z),y(p.referenceView),5.2,p.weight,p.direction?'triangle':'circle');
    rendered.push({p,x:x(p.z),y:y(p.referenceView)});
  }
  if(axialMovie.mode==='thickness'||!accumulated){ctx.strokeStyle='#2166ac';ctx.lineWidth=2.5;ctx.setLineDash([7,4]);ctx.beginPath();ctx.moveTo(x(u),top);ctx.lineTo(x(u),top+height);ctx.stroke();ctx.setLineDash([]);}
  ctx.restore();canvas.dataset.renderState='ready';canvas.dataset.startIndex=axialMovie.index;canvas.dataset.planeMm=u;canvas.dataset.partial=String(accumulated&&axialMovie.mode==='thickness');canvas.dataset.markerCount=rendered.length;
  if(accumulated)axialMovie.hitPoints=rendered;
}
function renderAxialMovie(){
  const audit=axialMovie.audit;if(!audit||!fdkResult||axialMovie.pending)return;
  const c=audit.config,frame=audit.frames[axialMovie.mode==='phase'?0:axialMovie.frame];if(!frame)return;
  const phase=c.phase*180/Math.PI,progress=Math.round(frame.fraction*100),el=id=>document.getElementById('axial-movie-'+id);
  el('position').max=axialMovie.mode==='phase'?fdkResult.profiles.length-1:audit.frames.length-1;
  el('position').value=axialMovie.mode==='phase'?axialMovie.index:axialMovie.frame;
  el('position-label').textContent=fdkText('動画内の開始角度','Start angle in this animation')+` ${phase.toFixed(1)}° / T = ${c.axialAverageMm.toFixed(2)} mm`+(axialMovie.mode==='thickness'?` / u = ${frame.u.toFixed(2)} mm`:``);
  el('status').textContent=axialMovie.mode==='thickness'?fdkText('開始角度を固定：幅Tの','Fixed start angle: ')+` ${progress}% `+fdkText('まで積算','of T accumulated'):fdkText('開始角度ごとの別撮影を比較：幅T全体の重みを表示','Comparing separate start-angle conditions: full-T weights shown');
  el('total-title').textContent=axialMovie.mode==='thickness'?fdkText('（b）幅T内で積み重ねた重み','(b) Weights accumulated within T')+` — ${progress}%`:fdkText('（b）幅T全体の合計重み','(b) Total weights over T');
  el('note').textContent=fdkText('（a）（b）は中央の応答を作る重みです。（c）は全評価位置で計算済みのSSPzです。候補点は','Panels (a) and (b) explain the central response; (c) is the computed SSPz at all evaluation positions. Markers sample ')+`${audit.angleSamplesPerTurn}`+fdkText('角度を抜粋。',' display angles.');
  paintAxialMovieWeights(el('instant'),frame.instant,frame.u,false);paintAxialMovieWeights(el('total'),frame.accumulated,frame.u,true);
  const p=fdkResult.profiles[axialMovie.index],xs=fdkResult.z,plot=fdkAxes(el('profile'),xs[0],xs.at(-1),0,1.05,'z position (mm)','Normalized SSPz','', [0,.5,1],70);
  fdkDrawLines(plot,xs,[p.profile],FDK_PRIMARY_COLOR);fdkArrow(plot,p.fwhm,.5,FDK_PRIMARY_COLOR);
  plot.ctx.strokeStyle='#555';plot.ctx.setLineDash([5,5]);plot.ctx.beginPath();plot.ctx.moveTo(plot.x(0),plot.b.top);plot.ctx.lineTo(plot.x(0),plot.b.bottom);plot.ctx.stroke();plot.ctx.setLineDash([]);
  plot.ctx.fillStyle=FDK_PRIMARY_COLOR;plot.ctx.textAlign='center';plot.ctx.font='24px Arial';plot.ctx.fillText(`FWHM ${p.fwhm.width.toFixed(2)} mm / ${phase.toFixed(1)}°`,(plot.b.left+plot.b.right)/2,38);
  el('profile').dataset.startIndex=axialMovie.index;el('profile').dataset.profileSource='full-acquired-view-result';
  el('detail').textContent=fdkText('（b）の点をクリックすると、同じデータの使用内訳を表示します。','Click a marker in (b) to inspect both roles of that datum.');
}
function inspectAxialMovieMarker(event){
  if(!axialMovie.hitPoints)return;const rect=event.currentTarget.getBoundingClientRect(),x=(event.clientX-rect.left)*900/rect.width,y=(event.clientY-rect.top)*960/rect.height;
  let hit=null,distance=16;for(const q of axialMovie.hitPoints){const d=Math.hypot(q.x-x,q.y-y);if(d<distance){hit=q;distance=d;}}
  if(!hit)return;const p=hit.p,c=axialMovie.audit.config;
  const weight=v=>v===0?'0':v<.001?'<0.001':v.toFixed(3);
  document.getElementById('axial-movie-detail').textContent=fdkText('全幅Tでの使用内訳：検出器列','Full-T role weights: detector row')+` ${p.row+1}${c.zFfsEnabled?' / '+(p.focus?'B':'A'):''} / z = ${p.z.toFixed(2)} mm / `+fdkText('実データ側','direct')+`: ${weight(p.directWeight)} / `+fdkText('対向データ側','complementary')+`: ${weight(p.complementaryWeight)} / `+fdkText('合計','total')+`: ${weight(p.directWeight+p.complementaryWeight)}`;
}
