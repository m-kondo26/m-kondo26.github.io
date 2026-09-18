// Optional acquired-point view. A/B are physical alternating exposures.
const ZFFS_COLORS=['#0072b2','#d55e00'];
let zffsSceneCache=null;
function readZffsParams(){return {zFfsEnabled:!!document.getElementById('zffs-enabled')?.checked,zFfsMagnification:Number(document.getElementById('zffs-magnification')?.value??1072/600),zFfsOffset:Number(document.getElementById('zffs-offset')?.value??.25)};}
function initializeZffsUi(initial,changed){
  const box=document.createElement('div');box.id='zffs-controls';box.className='zffs-controls';
  box.innerHTML=`<label class="zffs-switch"><input type="checkbox" id="zffs-enabled">${fdkText('z方向の焦点移動による倍密度サンプリング（z-FFS）','Use z-flying focal spot sampling (z-FFS)')}</label>
  <p id="zffs-unavailable" hidden>${fdkText('焦点移動は、ピッチが正のコーン幾何モデルで使用できます。','Focal switching requires cone geometry and positive pitch.')}</p>
  <div id="zffs-options" hidden><p>${fdkText('焦点A・Bを交互に切り替え、候補点・補間重み・SSPzを計算します。取得ビュー数はA+Bの合計です。初期設定では回転中心の列間隔を半分にします。','Alternate focal positions A and B for candidate geometry, interpolation weights and SSPz. The view count is the total A+B acquisitions. The default interlaces rows at half spacing at isocentre.')}</p>
  <details class="reading-details"><summary>${fdkText('焦点移動の幾何条件','Focal-switching geometry')}</summary><div class="parameter-grid">
  <input id="zffs-magnification" type="hidden" value="${1072/600}">
  <label>${fdkText('回転中心での片側移動量 / 列間隔','One-sided isocentre offset / row pitch')}<input id="zffs-offset" type="number" min="0" max="0.5" step="0.01" value="0.25"></label></div>
  <p>${fdkText('固定した円筒検出器に対し、焦点を体軸方向だけに移動する理想モデルです。実機の設定値ではありません。回転中心から離れると、列間隔は一様に半分にはなりません。','An ideal model of pure axial focal motion relative to a fixed cylindrical detector, not scanner settings. Away from isocentre, the interlaced spacing is not uniformly halved.')}</p>
  <a href="ZFFS_METHOD.md">${fdkText('計算方法と検証範囲','Method and verification scope')}</a> · <a href="https://doi.org/10.1118/1.2828403">Mori (2008)</a></details></div>`;
  document.getElementById('fdk-controls').prepend(box);
  const ref=document.createElement('li');ref.innerHTML=`<div class="reference-citation">Mori I. <a href="https://doi.org/10.1118/1.2828403" target="_blank" rel="noopener noreferrer">Antialiasing backprojection for helical MDCT.</a> <i>Medical Physics.</i> 2008;35:1065–1077.</div><p>${fdkText('図4・式（19）～（22）の焦点移動と標本配置を参照しました。純粋な体軸方向移動を仮定した追加モデルです。同報のシフト逆投影や実機のアーチファクト低減は再現していません。','Fig. 4 and Eqs. (19)–(22) motivate focal switching and sampling geometry. This extension assumes pure axial motion; it does not reproduce shifted backprojection or scanner artifact reduction.')}</p>`;document.querySelector('.reference-list').append(ref);
  document.getElementById('zffs-enabled').checked=initial.zFfsEnabled===true;
  document.getElementById('zffs-magnification').value=initial.zFfsMagnification??1072/600;
  document.getElementById('zffs-offset').value=initial.zFfsOffset??.25;
  const block=document.createElement('div');block.id='zffs-diagrams';block.hidden=true;
  block.innerHTML=`<h3>${fdkText('焦点A・Bの取得点と選択重み','Focal positions A/B: acquired points and selected weights')}</h3>
  <p id="zffs-result-note"></p><div class="zffs-view-controls"><label>${fdkText('表示角度の開始 (°)','Display angle start (°)')}<input id="zffs-angle" type="range" min="0" max="300" step="1" value="0"><output id="zffs-angle-value">0°</output></label>
  <label>${fdkText('表示角度幅','Angular span')}<select id="zffs-span"><option value="60">60°</option><option value="10">10°</option><option value="360">360°</option></select></label></div>
  <div class="chart-grid two">${[0,1,2,3].map(i=>`<article class="chart-card"><div class="zffs-canvas-scroll" tabindex="0"><canvas id="zffs-panel-${i}" width="1000" height="850"></canvas></div></article>`).join('')}</div>
  <p>${fdkText('全パネルは同じ軸・縮尺です。○：焦点A、△：焦点B。各点は実際に取得する角度の検出器列中心です。右下の濃さは、対象位置で幅Tにわたり合計した取得データの重みです。','All panels share axes and scale. Circle: focus A; triangle: focus B. Points are detector-row centres at actual acquired angles. Bottom-right intensity shows acquired-data weights summed over T at the object location.')}</p>
  <div class="action-row"><button type="button" class="secondary" id="zffs-png" disabled>${fdkText('4パネルを600 dpi PNG保存','Save four panels as 600-dpi PNG')}</button><button type="button" class="secondary" id="zffs-csv" disabled>${fdkText('取得点・重みをCSV保存','Export acquired points and weights as CSV')}</button></div>
  <details class="reading-details"><summary>${fdkText('表示範囲内の選択データ（先頭100点）','Selected data in this viewport (first 100 points)')}</summary><div class="zffs-table-scroll"><table><thead><tr><th>Focus</th><th>View</th><th>Row</th><th>β (°)</th><th>z (mm)</th><th>Weight</th></tr></thead><tbody id="zffs-weight-table"></tbody></table></div></details>`;
  document.getElementById('fdk-geometry-step').append(block);
  for(const id of ['zffs-enabled','zffs-magnification','zffs-offset'])document.getElementById(id).addEventListener('change',()=>{changed();syncZffsUi();});
  for(const id of ['zffs-angle','zffs-span'])document.getElementById(id).addEventListener('input',()=>{zffsSceneCache=null;renderZffsSelected();});
  document.getElementById('zffs-csv').onclick=()=>{if(!fdkSelectedResult?.config.zFfsEnabled)return;downloadBlob(fdkFileStem(fdkResult)+'_angle-'+selectedStateIndex+'_zFFS_acquired_weights.csv','\uFEFF'+zffsWeightRows(fdkSelectedResult).map(r=>r.join(',')).join('\r\n'));};
  document.getElementById('zffs-png').onclick=exportZffsPanels;
  resetButton.addEventListener('click',()=>{document.getElementById('zffs-enabled').checked=false;document.getElementById('zffs-magnification').value=1072/600;document.getElementById('zffs-offset').value=.25;syncZffsUi();});
  syncZffsUi();
}
function syncZffsUi(){
  syncSharedFocalControls();
  const e=document.getElementById('zffs-enabled');if(!e)return;
  const available=document.getElementById('computationModel').value!=='parallel'&&Number(form.elements.namedItem('beamPitch').value)>0;
  if(!available)e.checked=false;e.disabled=runButton.disabled||!available;
  document.getElementById('zffs-unavailable').hidden=available;
  document.getElementById('zffs-options').hidden=!e.checked;
  document.getElementById('zffs-diagrams').hidden=!e.checked;
  document.getElementById('fdk-geometry').closest('article').hidden=false;
  document.getElementById('fdk-weight-step').hidden=false;
  for(const id of ['zffs-png','zffs-csv'])document.getElementById(id).disabled=!fdkSelectedResult?.config.zFfsEnabled;
}
function zffsWeightRows(r){return [['focus','view_unwrapped','row_index_zero_based','channel_index_zero_based','source_angle_rad','source_z_mm','row_center_relative_mm','interpolation_weight','angular_mean_factor','acquired_point_value','response_contribution'],...r.weightAudit.samples.map(q=>[q.focus?'B':'A',q.view,q.row,q.channel,q.beta,q.sourceZ,q.z,q.weight,r.weightAudit.db,q.acquiredValue,q.weight*r.weightAudit.db*q.acquiredValue])];}
function zffsScene(r){
  const span=Number(document.getElementById('zffs-span').value),slider=document.getElementById('zffs-angle');slider.max=360-span;slider.disabled=span===360;
  const start=Math.min(Number(slider.value),360-span);slider.value=start;document.getElementById('zffs-angle-value').value=start+'°';
  const key=start+':'+span;if(zffsSceneCache?.r===r&&zffsSceneCache.key===key)return zffsSceneCache;
  const c=r.config,nv=c.viewSamples,base=Math.ceil(((2*Math.PI*r.zObject/c.feed)-Math.PI)/(2*Math.PI/nv)-1e-12);
  const limit=symmetricNiceAxis(Math.max(c.rowWidth,c.axialAverageMm/2+2*c.rowWidth*(1+c.radius/c.sourceRadius)+c.zFfsSourceOffsetMm),3).xMax;
  const angle=v=>((v-base)%nv+nv)%nv*360/nv;
  const axialReach=(c.rows-1)/2*c.rowWidth*(1+c.radius/c.sourceRadius)+c.zFfsSourceOffsetMm;
  const first=Math.floor((r.zObject-limit-axialReach)/c.feed*nv),last=Math.ceil((r.zObject+limit+axialReach)/c.feed*nv),points=[];
  for(let v=first;v<=last;v++){
    const a=angle(v);if(a<start-1e-9||a>start+span+1e-9)continue;
    const q=zffsRowGeometry(c,v,0),lo=Math.max(0,Math.ceil((-limit+r.zObject-q.z)/q.spacing)),hi=Math.min(c.rows-1,Math.floor((limit+r.zObject-q.z)/q.spacing));
    for(let row=lo;row<=hi;row++)points.push({view:v,row,focus:q.focus,z:q.z+row*q.spacing-r.zObject,angle:a,weight:0});
  }
  const weights=new Map();for(const q of r.weightAudit.samples){const k=q.view+':'+q.row;if(!weights.has(k))weights.set(k,{...q,angle:angle(q.view),weight:0});weights.get(k).weight+=q.weight*r.weightAudit.db;}
  const selected=[...weights.values()].filter(q=>q.angle>=start-1e-9&&q.angle<=start+span+1e-9&&Math.abs(q.z)<=limit).sort((a,b)=>a.angle-b.angle||a.z-b.z);
  const maxWeight=Math.max(0,...selected.map(q=>q.weight));
  return zffsSceneCache={r,key,start,span,limit,points,selected,maxWeight};
}
function drawZffsPanel(canvas,r,kind){
  canvas.dataset.renderScale=String(canvas.width/1000);
  const s=zffsScene(r),titles=[fdkText('焦点Aの取得点','Acquired points: focus A'),fdkText('焦点Bの取得点','Acquired points: focus B'),fdkText('焦点A+Bの重ね合わせ','Overlay: focus A+B'),fdkText('選択されたデータの重み','Selected acquired-data weights')];
  const plot=axisContext(canvas,{xMin:-s.limit,xMax:s.limit,yMin:s.start+s.span,yMax:s.start},{x:'',y:'β − βref (°)',topMargin:85,leftMargin:130,rightMargin:35,bottomMargin:170,xFormatter:v=>Number(v.toFixed(2)).toString(),yFormatter:v=>Number(v.toFixed(1)).toString()});
  const xs=SSPZShapeDisplay.ticks(-s.limit,s.limit),ys=Array.from({length:7},(_,i)=>s.start+i*s.span/6);drawAxes(plot,xs,ys);
  const {ctx,x,y,margin:m,innerWidth:w,innerHeight:h}=plot;
  ctx.save();ctx.fillStyle=INK;ctx.font=`700 27px ${FIGURE_FONT}`;ctx.textAlign='left';ctx.fillText('('+String.fromCharCode(97+kind)+')',18,32);ctx.textAlign='center';ctx.font=`27px ${FIGURE_FONT}`;ctx.fillText(titles[kind],m.left+w/2,43);
  ctx.beginPath();ctx.rect(m.left,m.top,w,h);ctx.clip();ctx.strokeStyle='#b41630';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x(0),m.top);ctx.lineTo(x(0),m.top+h);ctx.stroke();
  const marker=(q,weighted)=>{ctx.globalAlpha=weighted?.15+.85*q.weight/(s.maxWeight||1):.65;ctx.fillStyle=ZFFS_COLORS[q.focus];ctx.beginPath();const px=x(q.z),py=y(q.angle),sz=weighted?5:2.8;if(q.focus){ctx.moveTo(px,py-sz);ctx.lineTo(px-sz,py+sz);ctx.lineTo(px+sz,py+sz);ctx.closePath();}else ctx.arc(px,py,sz,0,2*Math.PI);ctx.fill();};
  if(kind<3){for(const q of s.points)if(kind===2||q.focus===kind)marker(q,false);}
  else {for(const q of s.selected)marker(q,true);}
  ctx.restore();ctx.save();ctx.textAlign='center';ctx.fillStyle=INK;ctx.font=`31px ${FIGURE_FONT}`;ctx.fillText('zᵢ − z₀ (mm)',m.left+w/2,m.top+h+80);ctx.font=`23px ${FIGURE_FONT}`;ctx.textAlign='left';ctx.fillStyle=ZFFS_COLORS[0];ctx.fillText('○  '+fdkText('焦点A','Focus A'),m.left,m.top+h+118);ctx.fillStyle=ZFFS_COLORS[1];ctx.fillText('△  '+fdkText('焦点B','Focus B'),m.left+230,m.top+h+118);
  if(kind===3){ctx.fillStyle=INK;ctx.font=`19px ${FIGURE_FONT}`;ctx.fillText(fdkText('濃さ：重み 0 ～ ','Intensity: weight 0 – ')+s.maxWeight.toPrecision(3),m.left,m.top+h+149);}ctx.restore();
  canvas.dataset.renderState='ready';canvas.dataset.zffsFocus=String(kind);canvas.dataset.xRange=String(s.limit);canvas.dataset.angleRange=s.key;
}
function renderZffsSelected(){
  syncZffsUi();const r=fdkSelectedResult;if(!r?.config.zFfsEnabled)return;
  for(let i=0;i<4;i++)drawZffsPanel(document.getElementById('zffs-panel-'+i),r,i);
  const c=r.config;document.getElementById('zffs-result-note').textContent=`${c.viewSamples} views/turn (A: ${c.viewSamples/2}, B: ${c.viewSamples/2}) / `+fdkText('焦点移動','Source offset')+` ±${c.zFfsSourceOffsetMm.toFixed(3)} mm / `+fdkText('回転中心の片側ずれ','One-sided isocentre offset')+` ${c.zFfsOffset} `+fdkText('列分。選択した開始角度のSSPzと同じ取得データです。','row pitches. These data also determine the SSPz at the selected start angle.');
  const s=zffsScene(r);document.getElementById('zffs-weight-table').innerHTML=s.selected.slice(0,100).map(q=>`<tr><td>${q.focus?'B':'A'}</td><td>${q.view}</td><td>${q.row+1}</td><td>${q.angle.toFixed(1)}</td><td>${q.z.toFixed(3)}</td><td>${q.weight.toPrecision(4)}</td></tr>`).join('');
}
async function exportZffsPanels(){
  const r=fdkSelectedResult;if(!r?.config.zFfsEnabled)return;
  const c=document.createElement('canvas');c.width=Math.round(180/25.4*600);c.height=Math.round(c.width*.85);const ctx=c.getContext('2d');
  for(let i=0;i<4;i++){const tile=document.createElement('canvas');tile.width=Math.round(c.width/2);tile.height=Math.round(tile.width*.85);drawZffsPanel(tile,r,i);ctx.drawImage(tile,(i%2)*tile.width,Math.floor(i/2)*tile.height);}
  const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob(fdkFileStem(fdkResult)+'_angle-'+selectedStateIndex+'_zFFS_4panels_600dpi.png',await pngWithResolution(blob,600),'image/png');
}
