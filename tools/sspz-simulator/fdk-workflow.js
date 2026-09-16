// One reconstruction result supplies the diagram, weights, selected SSP and
// phase-ordered widths. Rendering never substitutes axial-model coefficients.
let fdkSelectedResult=null,fdkRunParams=null,fdkInspectionRequest=0,fdkInspectionTimer=null;
const fdkAngleTicks=[0,60,120,180,240,300,360];
function initializeFdkWorkflow(panel){
  const block=(id,title)=>{const e=document.createElement('div');e.id=id;e.className='workflow-block';e.innerHTML=`<h2>${title}</h2>`;return e;};
  const geometry=block('fdk-geometry-step',fdkText('2　展開図と補間の重み','2  Unwrapped geometry and interpolation weights'));
  geometry.insertAdjacentHTML('beforeend',`<div class="state-inspector"><label for="fdk-inspect">${fdkText('表示する回転開始角度','Start angle to inspect')} <span id="fdk-inspect-label"></span></label><div class="state-controls"><button type="button" id="fdk-prev" disabled>−1°</button><input type="range" id="fdk-inspect" min="0" max="359" step="1" value="0" disabled><button type="button" id="fdk-next" disabled>+1°</button></div><p id="fdk-inspection-status" aria-live="polite"></p></div>`);
  const firstCard=document.getElementById('fdk-geometry').closest('article');geometry.append(firstCard);
  firstCard.querySelector('h3').textContent=fdkText('2A　補間候補の配置：0～360°展開図','2A  Candidate arrangement: 0–360° unwrapped diagram');
  const weights=block('fdk-weight-step',fdkText('2B　選択されたデータと重み','2B  Selected data and weights'));
  weights.insertAdjacentHTML('beforeend',`<p>${fdkText('同じ開始角度・同じ対象位置の重みです。画像の体軸方向平均化を指定した場合は、その幅全体の重みを合計します。','Weights refer to the same start angle and target location. If image-domain axial averaging is enabled, coefficients are summed across that window.')}</p><div class="chart-grid two"><article class="chart-card"><canvas id="fdk-weights-cba" width="1000" height="850"></canvas></article><article class="chart-card" id="fdk-rri-weights-card"><canvas id="fdk-weights-rri" width="1000" height="850"></canvas></article></div><p id="fdk-weight-scope"></p>`);
  const profile=block('fdk-profile-step',fdkText('3　選択角度のSSPzと全360条件','3  Selected SSPz and all 360 conditions'));
  profile.insertAdjacentHTML('beforeend',`<article class="chart-card"><h3>${fdkText('選択角度：半値の交点とFWHM','Selected angle: half-maximum crossings and FWHM')}</h3><canvas id="fdk-selected-profile" width="1200" height="800"></canvas></article>`);
  const overlay=document.getElementById('fdk-profile').closest('article');profile.append(overlay);overlay.querySelector('h3').textContent=fdkText('全360条件の重ね合わせ','Overlay of all 360 conditions');
  profile.insertAdjacentHTML('beforeend',`<article class="chart-card"><h3>${fdkText('全360条件：裾の拡大表示','All 360 conditions: tail detail')}</h3><canvas id="fdk-tail" width="1200" height="700"></canvas></article>`);
  const widths=block('fdk-width-step',fdkText('4　開始角度による幅の変動','4  Width variation with start angle'));
  widths.insertAdjacentHTML('beforeend',`<label>${fdkText('表示する幅','Width metric')}<select id="fdk-width-metric"><option value="fwhm">FWHM</option><option value="fwtm">FWTM</option></select></label><article class="chart-card"><canvas id="fdk-sweep" width="1200" height="700"></canvas></article><p>${fdkText('横軸は設定した基準開始角度からの差です。グラフのクリックでも角度を選べます。','The horizontal axis is the offset from the configured base start angle. Click the graph to select an angle.')}</p>`);
  const shape=block('fdk-shape-step',fdkText('5　SSPzの形状変動','5  SSPz shape variation'));
  widths.insertAdjacentHTML('beforeend',`<button type="button" class="secondary" id="fdk-width-csv" disabled>${fdkText('全360角度の幅をCSV保存','Export widths for all 360 angles as CSV')}</button>`);
  shape.append(document.getElementById('fdk-difference-wrap'),document.getElementById('fdk-shape-wrap'));
  const images=document.createElement('details');images.className='reading-details';images.innerHTML=`<summary>${fdkText('選択角度の再構成画像','Reconstructed images at the selected angle')}</summary><div class="chart-grid two"></div>`;
  images.lastElementChild.append(document.getElementById('fdk-axial').closest('article'),document.getElementById('fdk-coronal').closest('article'));
  const oldGrid=panel.querySelector('.chart-grid.two');oldGrid.replaceWith(geometry,weights,profile,widths,shape,images);
  // The old first-angle-only audit is superseded by the linked window audit.
  document.getElementById('cba-samples-wrap').hidden=true;
  document.getElementById('cba-samples-wrap').style.display='none';
  document.getElementById('fdk-inspect').oninput=e=>selectFdkState(Number(e.target.value));
  document.getElementById('fdk-prev').onclick=()=>selectFdkState(selectedStateIndex-1,true);
  document.getElementById('fdk-next').onclick=()=>selectFdkState(selectedStateIndex+1,true);
  document.getElementById('fdk-width-metric').value=['fwhm','fwtm'].includes(metricSelect.value)?metricSelect.value:'fwhm';
  document.getElementById('fdk-width-metric').onchange=e=>{metricSelect.value=e.target.value;if(fdkResult){drawFdkSweep(document.getElementById('fdk-sweep'));const url=paramsToUrl(fdkRunParams);try{history.replaceState(null,'',url);}catch{}syncLanguageLinks(url.search);}};
  document.getElementById('fdk-width-csv').onclick=()=>{if(!fdkResult)return;const rows=[['method','start_index','start_angle_rad','FWHM_mm','FWTM_mm'],...fdkGroups(fdkResult).flatMap(([name,g])=>g.profiles.map((p,i)=>[name,i,p.phase,p.fwhm.width,p.fwtm.width]))];downloadBlob(fdkFileStem(fdkResult)+'_360_angles_widths.csv','\uFEFF'+rows.map(r=>r.join(',')).join('\r\n'));};
  document.getElementById('fdk-sweep').onclick=e=>{if(!fdkResult)return;const box=e.currentTarget.getBoundingClientRect(),x=(e.clientX-box.left)/box.width;selectFdkState(Math.max(0,Math.min(359,Math.round((x-.13)/.835*360))),true);};
  for(const id of ['fdk-geometry','fdk-weights-cba','fdk-weights-rri','fdk-selected-profile','fdk-tail','fdk-sweep','fdk-difference']){
    const b=document.createElement('button');b.type='button';b.className='secondary';b.dataset.fdkCanvas=id;b.disabled=true;b.textContent=fdkText('600 dpi PNG保存','Save 600-dpi PNG');b.onclick=()=>exportFdkWorkflowCanvas(id);document.getElementById(id).after(b);
  }
}
function fdkWorkflowAvailability(on){
  for(const id of ['fdk-inspect','fdk-prev','fdk-next','fdk-width-metric','fdk-width-csv'])document.getElementById(id).disabled=!on;
  document.querySelectorAll('[data-fdk-canvas]').forEach(b=>b.disabled=!on||!fdkSelectedResult);
}
function selectFdkState(index,immediate=false){
  if(!fdkResult)return;
  selectedStateIndex=((Math.round(index)%360)+360)%360;fdkInspectionRequest++;clearTimeout(fdkInspectionTimer);fdkSelectedResult=null;
  document.getElementById('fdk-inspect').value=selectedStateIndex;
  const angle=fdkResult.profiles[selectedStateIndex].phase*180/Math.PI;
  document.getElementById('fdk-inspect-label').textContent=`+${selectedStateIndex}° / ${fdkText('開始角度','start angle')} ${angle.toFixed(1)}°`;
  document.getElementById('fdk-inspection-status').textContent=fdkText('選択角度の展開図・重み・画像を更新中…','Updating geometry, weights and images for the selected angle…');
  for(const id of ['fdk-geometry','fdk-weights-cba','fdk-weights-rri','fdk-axial','fdk-coronal'])drawCanvasStatus(document.getElementById(id),'',fdkText('選択角度を計算中','Computing selected angle'));
  drawFdkSelectedProfile(document.getElementById('fdk-selected-profile'));drawFdkSweep(document.getElementById('fdk-sweep'));drawFdkTail(document.getElementById('fdk-tail'));fdkDrawProfile(document.getElementById('fdk-profile'),fdkResult);
  fdkWorkflowAvailability(true);document.getElementById('fdk-json').disabled=true;document.getElementById('fdk-xlsx').disabled=true;
  const url=paramsToUrl(fdkRunParams);try{history.replaceState(null,'',url);}catch{}syncLanguageLinks(url.search);
  const requestId=fdkInspectionRequest;
  const send=()=>worker?.postMessage({type:'fdk-inspect',index:selectedStateIndex,requestId});
  if(immediate)send();else fdkInspectionTimer=setTimeout(send,180);
}
function renderFdkSelected(){
  const r=fdkSelectedResult;if(!r)return;
  drawFdkCandidateDiagram(document.getElementById('fdk-geometry'),r,false);
  drawFdkCandidateDiagram(document.getElementById('fdk-weights-cba'),r,true,false);
  document.getElementById('fdk-rri-weights-card').hidden=!r.reference;
  if(r.reference)drawFdkCandidateDiagram(document.getElementById('fdk-weights-rri'),r,true,true);
  fdkDrawImage(document.getElementById('fdk-axial'),r,false);fdkDrawImage(document.getElementById('fdk-coronal'),r,true);
  document.getElementById('fdk-weight-scope').textContent=fdkText('球中心の面内位置における、フィルタ適用後のデータへの重みを表示します。SSPz全体の寄与率ではありません。角度は0～360°に折り返しますが、異なる回転のデータは別の点として保持しています。','Weights apply to filtered data at the transverse sphere centre, not to the entire SSPz. Angles are folded into 0–360°, while samples from different turns retain separate identities.');
  document.getElementById('fdk-inspection-status').textContent=fdkText('展開図・重み・SSPz・画像は、選択した同じ開始角度に対応しています。','Geometry, weights, SSPz and images now refer to the same selected start angle.');
  document.getElementById('fdk-summary').textContent=fdkText('全360条件の計算が完了しました。角度を選んで、候補データからSSPzまで確認できます。','All 360 conditions are complete. Select an angle to inspect the candidates, weights and SSPz.');
  const c=fdkResult.config;document.getElementById('fdk-result-config').textContent=`${c.rows} rows × ${c.rowWidth.toFixed(2)} mm / pitch ${c.beamPitch} / r = ${c.radius} mm / ${c.viewSamples} views/turn / 360 start angles / axial mean ${(c.axialAverageMm??0).toFixed(2)} mm`;
  fdkWorkflowAvailability(true);document.getElementById('fdk-json').disabled=false;document.getElementById('fdk-xlsx').disabled=false;
}
function drawFdkCandidateDiagram(canvas,r,zoom,reference=false){
  const c=r.config,audit=r.weightAudit,step=2*Math.PI/c.viewSamples;
  if(!r.reference&&!zoom){fdkDrawGeometry(canvas,r);canvas.dataset.startIndex=selectedStateIndex;return;}
  if(!audit){fdkDrawGeometry(canvas,r);return;}
  const samples=audit.samples,base=Math.ceil(((c.feed?2*Math.PI*r.zObject/c.feed:0)-Math.PI)/step-1e-12);
  const first=Math.min(base,...samples.map(q=>q.view)),last=Math.max(base+c.viewSamples,...samples.map(q=>q.view));
  const position=(view,row)=>{const angle=c.phase+view*step;
    if(r.reference){const t=-c.radius*Math.sin(angle),gamma=Math.asin(t/c.sourceRadius),L=Math.sqrt(c.sourceRadius**2-t*t)-c.radius*Math.cos(angle);return c.feed*(angle+gamma-c.phase)/(2*Math.PI)+(row-(c.rows-1)/2)*c.rowWidth*L/c.sourceRadius-r.zObject;}
    const D=c.sourceRadius-c.radius*Math.cos(angle);return c.feed*view/c.viewSamples+(row+c.vOffset)*c.rowWidth*D/c.sourceRadius-r.zObject;
  };
  const rowMin=r.reference?0:Math.min(...samples.map(q=>q.row))-2,rowMax=r.reference?c.rows-1:Math.max(...samples.map(q=>q.row))+2;
  let extent=0;for(let v=first;v<=last;v++)for(const k of [rowMin,rowMax])extent=Math.max(extent,Math.abs(position(v,k)));
  const limit=zoom?Math.max(c.rowWidth,Math.ceil(Math.max(...samples.map(q=>Math.abs(q.z)))*10)/10)*1.12:Math.ceil(extent*10)/10;
  const a=fdkAxes(canvas,-limit,limit,360,0,'Data z relative to sphere (mm)',r.reference?'Rebinned angle offset (°)':'Source angle offset (°)',zoom?(reference?'(c)':'(b)'):'(a)',fdkAngleTicks,115);
  const {ctx,s,b}=a,fold=v=>((v-base)%c.viewSamples+c.viewSamples)%c.viewSamples*360/c.viewSamples;
  ctx.textAlign='center';ctx.font=`${23*s}px Arial`;ctx.fillStyle='#000';ctx.fillText(zoom?`${reference?'RRI':r.reference?'CBA':'FDK'} / start offset +${selectedStateIndex}° / axial mean ${(c.axialAverageMm??0).toFixed(2)} mm`:`${r.reference?'Rebinned detector rows':'Virtual flat rows'} / start offset +${selectedStateIndex}°`,(b.left+b.right)/2,50*s);
  ctx.font=`${20*s}px Arial`;
  if(zoom){ctx.textAlign='left';ctx.fillText('Weight',180*s,88*s);for(const [i,w] of [.25,.5,.75,1].entries()){const xx=(340+i*145)*s;ctx.fillStyle=reference?'#0033bb':'#bd0000';ctx.beginPath();ctx.arc(xx,81*s,10*s*Math.sqrt(w),0,2*Math.PI);ctx.fill();ctx.fillStyle='#000';ctx.fillText(String(w),xx+18*s,88*s);}}
  else ctx.fillText('All candidate rows; bold points: selected data',(b.left+b.right)/2,85*s);
  ctx.save();ctx.beginPath();ctx.rect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.clip();
  ctx.strokeStyle='#607681';ctx.globalAlpha=zoom?.20:Math.max(.18,Math.min(.65,30/c.rows));ctx.lineWidth=.8*s;
  for(let row=rowMin;row<=rowMax;row++){
    ctx.beginPath();let previous=-1;for(let v=first;v<=last;v++){const yy=fold(v),xx=position(v,row);if(previous<0||yy<previous)ctx.moveTo(a.x(xx),a.y(yy));else ctx.lineTo(a.x(xx),a.y(yy));previous=yy;}ctx.stroke();
  }
  ctx.globalAlpha=1;ctx.strokeStyle='#a00000';ctx.lineWidth=1.6*s;ctx.setLineDash([7*s,5*s]);ctx.beginPath();ctx.moveTo(a.x(0),b.top);ctx.lineTo(a.x(0),b.bottom);ctx.stroke();ctx.setLineDash([]);
  const stride=Math.max(1,Math.ceil(c.viewSamples/72));
  for(const q of samples){if(((q.view-base)%stride+stride)%stride)continue;const w=reference?q.referenceWeight:q.weight;if(!(w>0))continue;ctx.fillStyle=reference?'rgba(0,51,187,.8)':'rgba(190,0,0,.8)';ctx.beginPath();ctx.arc(a.x(q.z),a.y(fold(q.view)),(zoom?10:4)*s*Math.sqrt(w),0,2*Math.PI);ctx.fill();}
  ctx.restore();canvas.dataset.startIndex=selectedStateIndex;canvas.dataset.auditSamples=samples.length;
}
function fdkArrow(a,fw,level,color){const {ctx,s}=a,yy=a.y(level);ctx.strokeStyle=color;ctx.lineWidth=2*s;ctx.setLineDash([5*s,5*s]);for(const v of [fw.left,fw.right]){ctx.beginPath();ctx.moveTo(a.x(v),a.b.bottom);ctx.lineTo(a.x(v),yy);ctx.stroke();}ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(a.x(fw.left),yy);ctx.lineTo(a.x(fw.right),yy);for(const [v,d] of [[fw.left,1],[fw.right,-1]]){ctx.moveTo(a.x(v)+d*9*s,yy-6*s);ctx.lineTo(a.x(v),yy);ctx.lineTo(a.x(v)+d*9*s,yy+6*s);}ctx.stroke();}
function drawFdkSelectedProfile(canvas){
  const r=fdkResult,groups=fdkGroups(r),low=Math.min(0,...groups.map(([,g])=>Math.min(...g.profiles[selectedStateIndex].profile)));
  const a=fdkAxes(canvas,r.z[0],r.z.at(-1),Math.floor(low*10)/10,1.02,'z position (mm)','Normalized SSPz','(d)',low<0?[Math.floor(low*10)/10,0,.25,.5,.75,1]:[0,.25,.5,.75,1],120);
  groups.forEach(([name,g],i)=>{const p=g.profiles[selectedStateIndex],color=i?'#0033bb':'#bd0000';fdkDrawLines(a,g.z,[p.profile],color);fdkArrow(a,p.fwhm,.5,color);a.ctx.fillStyle=color;a.ctx.textAlign='center';a.ctx.font=`${23*a.s}px Arial`;a.ctx.fillText(`${name} / +${selectedStateIndex}°: FWHM ${p.fwhm.width.toFixed(2)} mm; FWTM ${p.fwtm.width.toFixed(2)} mm`,(a.b.left+a.b.right)/2,(50+i*35)*a.s);});canvas.dataset.startIndex=selectedStateIndex;
}
function drawFdkTail(canvas){const r=fdkResult,low=Math.min(0,...fdkGroups(r).flatMap(([,g])=>g.profiles.map(p=>Math.min(...p.profile)))),a=fdkAxes(canvas,r.z[0],r.z.at(-1),Math.floor(low*10)/10,.2,'z position (mm)','Normalized SSPz','(f)',null,72);for(const [i,[,g]] of fdkGroups(r).entries())fdkDrawLines(a,r.z,g.profiles.map(p=>p.profile),i?'rgba(0,51,187,.45)':'rgba(190,0,0,.45)');a.ctx.textAlign='center';a.ctx.fillStyle='#000';a.ctx.fillText('All 360 start angles; native samples joined by straight lines',(a.b.left+a.b.right)/2,48*a.s);}
function drawFdkSweep(canvas){
  const r=fdkResult,key=document.getElementById('fdk-width-metric').value,values=fdkGroups(r).flatMap(([,g])=>g.profiles.map(p=>p[key].width)),lo=Math.min(...values),hi=Math.max(...values),pad=Math.max(.01,(hi-lo)*.1),a=fdkAxes(canvas,0,360,Math.max(0,Math.floor((lo-pad)*100)/100),Math.ceil((hi+pad)*100)/100,'Start-angle offset (°)',`${key.toUpperCase()} (mm)`,'(g)',null,95,fdkAngleTicks);
  for(const [i,[name,g]] of fdkGroups(r).entries()){const color=i?'#0033bb':'#bd0000',ys=g.profiles.map(p=>p[key].width);fdkDrawLines(a,ys.map((_,j)=>j),[ys],color);a.ctx.fillStyle=color;a.ctx.textAlign='center';a.ctx.fillText(`${name}: ${Math.min(...ys).toFixed(2)}–${Math.max(...ys).toFixed(2)} mm`,a.b.left+(i?.73:.27)*(a.b.right-a.b.left),53*a.s);a.ctx.beginPath();a.ctx.arc(a.x(selectedStateIndex),a.y(ys[selectedStateIndex]),5*a.s,0,2*Math.PI);a.ctx.fill();}
  a.ctx.strokeStyle='#555';a.ctx.setLineDash([5*a.s,5*a.s]);a.ctx.beginPath();a.ctx.moveTo(a.x(selectedStateIndex),a.b.top);a.ctx.lineTo(a.x(selectedStateIndex),a.b.bottom);a.ctx.stroke();a.ctx.setLineDash([]);canvas.dataset.startIndex=selectedStateIndex;
}
function addFdkWorkflowSheets(sheets){
  sheets[0][1]=sheets[0][1].filter(([key])=>!['volume_storage','sample_weights_scope'].includes(key));
  sheets[0][1].push(['selected_start_index',selectedStateIndex],['start_angle_sweep','base phase + 0..359 degrees; object z fixed'],['volume_storage','JSON contains selected angle volume, x fastest'],['first_angle_weights','Sample_weights contains the unaveraged centre snapshot at index 0; Selected_weights includes the image-average window at the inspected angle']);
  const r=fdkSelectedResult;if(!r?.weightAudit)return;
  sheets[0][1].push(['selected_weight_scope',r.weightAudit.definition]);
  sheets.push(['Selected_weights',[['start_index','view_unwrapped','row_index','theta_rad','source_angle_rad','z_relative_mm','weight','reference_weight','geometric_weight','filtered_value'],...r.weightAudit.samples.map(q=>[selectedStateIndex,q.view,q.row,q.theta,q.beta,q.z,q.weight,q.referenceWeight,q.geometricWeight??1,q.filteredValue])]]);
}
async function exportFdkWorkflowCanvas(id){
  if(!fdkSelectedResult)return;const source=document.getElementById(id),c=document.createElement('canvas');c.width=Math.round(180/25.4*600);c.height=Math.round(c.width*source.height/source.width);
  if(id==='fdk-geometry')drawFdkCandidateDiagram(c,fdkSelectedResult,false);
  else if(id.startsWith('fdk-weights'))drawFdkCandidateDiagram(c,fdkSelectedResult,true,id.endsWith('rri'));
  else if(id==='fdk-selected-profile')drawFdkSelectedProfile(c);
  else if(id==='fdk-tail')drawFdkTail(c);
  else if(id==='fdk-sweep')drawFdkSweep(c);
  else {const limit=Math.ceil(Math.max(.02,...fdkGroups(fdkResult).flatMap(([,g])=>g.meanDifference.map(p=>Math.max(...p.map(Math.abs)))))/.02)*.02,a=fdkAxes(c,fdkResult.z[0],fdkResult.z.at(-1),-limit,limit,'z position (mm)','SSPz minus mean','(h)');for(const [i,[,g]] of fdkGroups(fdkResult).entries())fdkDrawLines(a,g.z,g.meanDifference,i?'#0033bb':'#bd0000');}
  const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob(`${fdkFileStem(fdkResult)}_${id}_angle-${selectedStateIndex}_600dpi.png`,await pngWithResolution(blob,600),'image/png');
}
