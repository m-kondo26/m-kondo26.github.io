// One reconstruction result supplies the diagram, weights, selected SSP and
// phase-ordered widths. Rendering never substitutes axial-model coefficients.
let fdkSelectedResult=null,fdkRunParams=null,fdkInspectionRequest=0,fdkInspectionTimer=null;
const fdkAngleTicks=[0,60,120,180,240,300,360];
function initializeFdkWorkflow(panel){
  const block=(id,title)=>{const e=document.createElement('div');e.id=id;e.className='workflow-block';e.innerHTML=`<h2>${title}</h2>`;return e;};
  const geometry=block('fdk-geometry-step',fdkText('2　展開図と補間の重み','2  Unwrapped geometry and interpolation weights'));
  geometry.insertAdjacentHTML('beforeend',`<div class="state-inspector"><label for="fdk-inspect">${fdkText('表示する回転開始角度','Start angle to inspect')} <span id="fdk-inspect-label"></span></label><div class="state-controls"><button type="button" id="fdk-prev" disabled>−1°</button><input type="range" id="fdk-inspect" min="0" max="359" step="1" value="0" disabled><button type="button" id="fdk-next" disabled>+1°</button></div><p id="fdk-inspection-status" aria-live="polite"></p></div>`);
  document.getElementById('fdk-geometry').width=900;document.getElementById('fdk-geometry').height=960;
  const firstCard=document.getElementById('fdk-geometry').closest('article');geometry.append(firstCard);
  firstCard.querySelector('h3').textContent=fdkText('2A　補間候補の配置：0～360°展開図','2A  Candidate arrangement: 0–360° unwrapped diagram');
  firstCard.querySelector('h3').insertAdjacentHTML('afterend',`<p id="fdk-paired-coordinate" hidden></p>`);
  const weights=block('fdk-weight-step',fdkText('2B　選択されたデータと重み','2B  Selected data and weights'));
  weights.insertAdjacentHTML('beforeend',`<p>${fdkText('同じ開始角度・同じ対象位置の重みです。応答の体軸方向平均化を指定した場合は、その幅全体の重みを合計します。','Weights refer to the same start angle and target location. If axial response averaging is enabled, coefficients are summed across that window.')}</p><div class="chart-grid two"><article class="chart-card"><h3 id="fdk-primary-weight-title">RRI</h3><canvas id="fdk-weights-primary" width="900" height="960"></canvas></article><article class="chart-card" id="fdk-rri-weights-card"><h3>RRI</h3><canvas id="fdk-weights-rri" width="900" height="960"></canvas></article></div><p id="fdk-weight-scope"></p>`);
  const profile=block('fdk-profile-step',fdkText('3　選択角度のSSPzと全360条件','3  Selected SSPz and all 360 conditions'));
  profile.insertAdjacentHTML('beforeend',`<article class="chart-card"><h3>${fdkText('選択角度：半値の交点とFWHM','Selected angle: half-maximum crossings and FWHM')}</h3><canvas id="fdk-selected-profile" width="1200" height="800"></canvas></article>`);
  const overlay=document.getElementById('fdk-profile').closest('article');profile.append(overlay);overlay.querySelector('h3').textContent=fdkText('全360条件の重ね合わせ','Overlay of all 360 conditions');
  profile.insertAdjacentHTML('beforeend',`<article class="chart-card"><h3>${fdkText('全360条件：裾の拡大表示（0.01～1）','All 360 conditions: tail detail (0.01–1)')}</h3><canvas id="fdk-tail" width="1200" height="700"></canvas></article>`);
  const widths=block('fdk-width-step',fdkText('4　開始角度による幅の変動','4  Width variation with start angle'));
  widths.insertAdjacentHTML('beforeend',`<label>${fdkText('表示する幅','Width metric')}<select id="fdk-width-metric"><option value="fwhm">FWHM</option><option value="fwtm">FWTM</option></select></label><article class="chart-card"><canvas id="fdk-sweep" width="1200" height="700"></canvas></article><p>${fdkText('横軸は設定した基準開始角度からの差です。グラフのクリックでも角度を選べます。','The horizontal axis is the offset from the configured base start angle. Click the graph to select an angle.')}</p>`);
  const shape=block('fdk-shape-step',fdkText('5　SSPzの形状変動','5  SSPz shape variation'));
  widths.insertAdjacentHTML('beforeend',`<button type="button" class="secondary" id="fdk-width-csv" disabled>${fdkText('全360角度の幅をCSV保存','Export widths for all 360 angles as CSV')}</button>`);
  shape.append(document.getElementById('fdk-difference-wrap'),document.getElementById('fdk-shape-wrap'));
  const images=document.createElement('details');images.className='reading-details';images.hidden=true;images.innerHTML=`<summary>${fdkText('選択角度の再構成画像','Reconstructed images at the selected angle')}</summary><div class="chart-grid two"></div>`;
  images.lastElementChild.append(document.getElementById('fdk-axial').closest('article'),document.getElementById('fdk-coronal').closest('article'));
  const oldGrid=panel.querySelector('.chart-grid.two');oldGrid.replaceWith(geometry,weights,profile,widths,shape,images);
  initializeAxialMovie(weights);
  // The old first-angle-only audit is superseded by the linked window audit.
  document.getElementById('cba-samples-wrap').hidden=true;
  document.getElementById('cba-samples-wrap').style.display='none';
  document.getElementById('fdk-inspect').oninput=e=>selectFdkState(Number(e.target.value));
  document.getElementById('fdk-prev').onclick=()=>selectFdkState(selectedStateIndex-1,true);
  document.getElementById('fdk-next').onclick=()=>selectFdkState(selectedStateIndex+1,true);
  document.getElementById('fdk-width-metric').value=['fwhm','fwtm'].includes(metricSelect.value)?metricSelect.value:'fwhm';
  document.getElementById('fdk-width-metric').onchange=e=>{metricSelect.value=e.target.value;if(fdkResult){drawFdkSweep(document.getElementById('fdk-sweep'));const url=paramsToUrl(fdkRunParams);try{history.replaceState(null,'',url);}catch{}syncLanguageLinks(url.search);}};
  document.getElementById('fdk-width-csv').onclick=()=>{if(!fdkResult)return;const rows=[['method','start_index','start_angle_rad','FWHM_mm','FWTM_mm','configured_thickness_mm','axial_average_mm'],...fdkGroups(fdkResult).flatMap(([name,g])=>g.profiles.map((p,i)=>[name,i,p.phase,p.fwhm.width,p.fwtm.width,fdkResult.config.sliceThicknessMm,fdkResult.config.axialAverageMm]))];downloadBlob(fdkFileStem(fdkResult)+'_360_angles_widths.csv','\uFEFF'+rows.map(r=>r.join(',')).join('\r\n'));};
  document.getElementById('fdk-sweep').onclick=e=>{if(!fdkResult)return;const box=e.currentTarget.getBoundingClientRect(),x=(e.clientX-box.left)/box.width;selectFdkState(Math.max(0,Math.min(359,Math.round((x-.13)/.835*360))),true);};
  for(const id of ['fdk-geometry','fdk-weights-primary','fdk-weights-rri','fdk-selected-profile','fdk-tail','fdk-sweep','fdk-difference']){
    const b=document.createElement('button');b.type='button';b.className='secondary';b.dataset.fdkCanvas=id;b.disabled=true;b.textContent=fdkText('600 dpi PNG保存','Save 600-dpi PNG');b.onclick=()=>exportFdkWorkflowCanvas(id);document.getElementById(id).after(b);
  }
}
function fdkWorkflowAvailability(on){
  if(!on)disableAxialMovie();
  for(const id of ['fdk-inspect','fdk-prev','fdk-next','fdk-width-metric','fdk-width-csv'])document.getElementById(id).disabled=!on;
  document.querySelectorAll('[data-fdk-canvas]').forEach(b=>b.disabled=!on||!fdkSelectedResult);
}
function selectFdkState(index,immediate=false){
  if(!fdkResult)return;
  stopAxialMovie();
  selectedStateIndex=((Math.round(index)%360)+360)%360;fdkInspectionRequest++;clearTimeout(fdkInspectionTimer);fdkSelectedResult=null;
  document.getElementById('fdk-inspect').value=selectedStateIndex;
  const angle=fdkResult.profiles[selectedStateIndex].phase*180/Math.PI;
  document.getElementById('fdk-inspect-label').textContent=`+${selectedStateIndex}° / ${fdkText('開始角度','start angle')} ${angle.toFixed(1)}°`;
  document.getElementById('fdk-inspection-status').textContent=fdkText('選択角度の展開図・重み・応答を更新中…','Updating geometry, weights and response for the selected angle…');
  for(const id of ['fdk-geometry','fdk-weights-primary','fdk-weights-rri','fdk-axial','fdk-coronal'])drawCanvasStatus(document.getElementById(id),'',fdkText('選択角度を計算中','Computing selected angle'));
  drawFdkSelectedProfile(document.getElementById('fdk-selected-profile'));drawFdkSweep(document.getElementById('fdk-sweep'));drawFdkTail(document.getElementById('fdk-tail'));fdkDrawProfile(document.getElementById('fdk-profile'),fdkResult);
  syncZffsUi();for(const cv of document.querySelectorAll('#zffs-diagrams canvas'))drawCanvasStatus(cv,'z-FFS',fdkText('選択角度を計算中','Computing selected angle'));
  fdkWorkflowAvailability(true);document.getElementById('fdk-json').disabled=true;document.getElementById('fdk-xlsx').disabled=true;
  const url=paramsToUrl(fdkRunParams);try{history.replaceState(null,'',url);}catch{}syncLanguageLinks(url.search);
  const requestId=fdkInspectionRequest;
  const send=()=>worker?.postMessage({type:'fdk-inspect',index:selectedStateIndex,requestId});
  if(immediate)send();else fdkInspectionTimer=setTimeout(send,180);
}
function renderFdkSelected(){
  const r=fdkSelectedResult;if(!r)return;
  clearCanvasStatusAnimations();
  document.getElementById('fdk-primary-weight-title').textContent=fdkMethodName(r);
  document.querySelector('#fdk-rri-weights-card h3').textContent=fdkText('RRI：列間の線形補間','RRI: linear row interpolation');
  drawFdkCandidateDiagram(document.getElementById('fdk-geometry'),r,false);
  const pairNote=document.getElementById('fdk-paired-coordinate');
  pairNote.hidden=!r.weightAudit?.pairedSamples;
  pairNote.textContent=fdkText('実データ側は実線、対向データ側は破線です。両側を実データ側の再配列角度θにそろえ、対向側にはθ＋180°のデータを表示します。','Solid: direct side. Dashed: complementary side. Both are shown at the direct-side rebinned angle θ; the complementary data are from θ + 180°.');
  drawFdkCandidateDiagram(document.getElementById('fdk-weights-primary'),r,true,false);
  document.getElementById('fdk-rri-weights-card').hidden=!r.reference;
  document.getElementById('fdk-rri-weights-card').parentElement.classList.toggle('two',!!r.reference);
  if(r.reference)drawFdkCandidateDiagram(document.getElementById('fdk-weights-rri'),r,true,true);
  // Reduced response has no image volume.
  document.getElementById('fdk-weight-scope').textContent=fdkText('対象点の位置で、幅Tにわたり合算した補間重みです。フィルタ前の取得応答と掛け合わせて、同じ位置の応答を再計算できます。角度は0～360°に折り返しますが、異なる回転のデータは別の点として保持しています。','Weights sum over T at the object point. Combined with unfiltered acquired responses, they reproduce that response sample. Angles are folded into 0–360°, while samples from different turns retain separate identities.');
  if(r.weightAudit?.pairedSamples)document.getElementById('fdk-weight-scope').textContent=fdkText('○は実データ側、△は対向データ側です。各補間ペアの重みを幅Tにわたり合算しています。同じデータが別のペアでも使われる場合は区別し、全重みはExcel・JSONに保存します。','Circles: direct side; triangles: complementary side. Weights are accumulated over T for each interpolation pair. Reuse of a datum in another pair remains distinct; Excel and JSON retain all weights.');
  document.getElementById('fdk-inspection-status').textContent=fdkText('展開図・重み・モデルSSPzは、選択した同じ開始角度に対応しています。','Geometry, weights and model SSPz now refer to the same selected start angle.');
  document.getElementById('fdk-summary').textContent=fdkText('全360条件の計算が完了しました。角度を選んで、候補データからSSPzまで確認できます。','All 360 conditions are complete. Select an angle to inspect the candidates, weights and SSPz.');
  const c=fdkResult.config;document.getElementById('fdk-result-config').textContent=`${c.rows} rows × ${c.rowWidth.toFixed(2)} mm / pitch ${c.beamPitch} / r = ${c.radius} mm / ${c.viewSamples} views/turn / 360 start angles / T = axial averaging width = ${(c.axialAverageMm??0).toFixed(2)} mm`;
  renderZffsSelected();
  syncAxialMovie();
  fdkWorkflowAvailability(true);document.getElementById('fdk-json').disabled=false;document.getElementById('fdk-xlsx').disabled=false;
}
// Adapt the actual reconstruction audit to the established diagram renderer.
// Only the scene data differ; palette, opacity, marker size and layout are shared.
function drawFdkCandidateDiagram(canvas,r,zoom,reference=false){
  if(r.config.zFfsEnabled)return drawZffsPanel(canvas,r,zoom?3:2);
  const c=r.config,audit=r.weightAudit,step=2*Math.PI/c.viewSamples;
  if(!audit)return;
  const paired=!!audit.pairedSamples,samples=paired?audit.pairedSamples:audit.samples,base=Math.ceil(((c.feed?2*Math.PI*r.zObject/c.feed:0)-Math.PI)/step-1e-12);
  const first=Math.min(base,...samples.map(q=>q.view)),last=Math.max(base+c.viewSamples,...samples.map(q=>q.view));
  const rebinned=r.coordinateSystem==='rebinned-theta'||!!r.reference;
  const physical=!zoom&&!rebinned;
  const rowMin=rebinned||physical?0:Math.min(...samples.map(q=>q.row))-2;
  const rowMax=rebinned||physical?c.rows-1:Math.max(...samples.map(q=>q.row))+2;
  const rows=rowMax-rowMin+1,angles=[],axial=[],scales=[],opposedAxial=[],opposedScales=[];
  const fold=v=>((v-base)%c.viewSamples+c.viewSamples)%c.viewSamples*360/c.viewSamples;
  const geometryAt=v=>{
    const angle=c.phase+v*step;
    if(c.axialRule==='parallel')return [c.feed*v/c.viewSamples,1];
    if(rebinned){
      const t=-c.radius*Math.sin(angle),gamma=Math.asin(t/c.sourceRadius);
      return [c.feed*(angle+gamma-c.phase)/(2*Math.PI),(Math.sqrt(c.sourceRadius**2-t*t)-c.radius*Math.cos(angle))/c.sourceRadius];
    }
    return [c.feed*v/c.viewSamples,physical?Math.hypot(c.sourceRadius*Math.cos(angle)-c.radius,c.sourceRadius*Math.sin(angle))/c.sourceRadius:(c.sourceRadius-c.radius*Math.cos(angle))/c.sourceRadius];
  };
  const rowOffsets=Array.from({length:rows},(_,i)=>(rebinned||physical?i-(c.rows-1)/2:rowMin+i+c.vOffset)*c.rowWidth);
  // Preserve the established axis range, which follows the selected audit.
  let extent=0;
  for(let v=first;v<=last;v++){
    const [z,scale]=geometryAt(v);
    for(const row of [0,rows-1])extent=Math.max(extent,Math.abs(z+scale*rowOffsets[row]-r.zObject));
  }
  const zoomLimit=Math.max(c.rowWidth,Math.ceil(Math.max(...samples.map(q=>Math.abs(q.z)))*10)/10)*1.12;
  // Background curves describe geometry, not the support of selected weights.
  // Draw complete turns and clip them at the axes; never join folded endpoints.
  let minCentral=Infinity,maxCentral=-Infinity;
  for(let i=0;i<=c.viewSamples;i++){
    const [z,scale]=geometryAt(base+i);
    angles.push(i*360/c.viewSamples);axial.push(z);scales.push(scale);
    for(const row of [0,rows-1]){
      const delta=z+scale*rowOffsets[row]-r.zObject;
      minCentral=Math.min(minCentral,delta);maxCentral=Math.max(maxCentral,delta);
    }
    if(paired){
      const [opposedZ,opposedScale]=geometryAt(base+i+c.viewSamples/2);
      opposedAxial.push(opposedZ);opposedScales.push(opposedScale);
      for(const row of [0,rows-1]){
        const delta=opposedZ+opposedScale*rowOffsets[row]-r.zObject;
        minCentral=Math.min(minCentral,delta);maxCentral=Math.max(maxCentral,delta);
      }
    }
  }
  const xLimit=symmetricNiceAxis(zoom?zoomLimit:extent,3).xMax;
  const turnMin=c.feed?Math.ceil((-xLimit-maxCentral)/c.feed):0;
  const turnMax=c.feed?Math.floor((xLimit-minCentral)/c.feed):0;
  const turns=Array.from({length:turnMax-turnMin+1},(_,i)=>turnMin+i);
  const stride=Math.max(1,Math.ceil(c.viewSamples/72));
  const trace={id:'acquired',family:'direct',angles,axial,scales};
  const traceFamilies=[trace];
  if(paired)traceFamilies.push({id:'complementary-rebinned',family:'complementary',angles,axial:opposedAxial,scales:opposedScales});
  const referenceView=q=>paired?q.referenceView:q.view;
  const diagram={totalRows:rows,z0:r.zObject,overviewXLimit:extent,zoomXLimit:zoomLimit,
    interpolationBandHalfWidth:(c.axialAverageMm??0)/2,
    traceGeometry:{...trace,rowOffsets,feed:c.feed,turns},traceFamilies,
    weightedPoints:zoom?samples.filter(q=>((referenceView(q)-base)%stride+stride)%stride===0).map(q=>({
      x:q.z,y:fold(referenceView(q)),row:q.row-rowMin,weight:reference?q.referenceWeight:q.weight,
      referenceViewIndex:referenceView(q),absoluteViewIndex:q.view,traceFamilyId:paired&&q.direction?'complementary-rebinned':'acquired',dataKind:'unfiltered-data'
    })):[],
    referenceViewSamples:c.viewSamples,renderedAngleSamples:Math.ceil(c.viewSamples/stride),acquiredTraceSamples:angles.length,
    xAxisLabel:fdkText('候補列中心  zᵢ − z₀  (mm)','Candidate row centre  zᵢ − z₀  (mm)'),
    yAxisLabel:rebinned?fdkText('再配列後の角度差  θ  (°)','Rebinned angle offset  θ  (°)'):fdkText('線源角度差  β  (°)','Source angle offset  β  (°)'),
    directLegendLabel:rebinned?fdkText('再配列データ ○','Rebinned data ○'):fdkText('取得データ ○','Acquired data ○'),
    overviewLegendLabel:fdkText('全{rows}列の幾何軌跡','Geometric trajectories: all {rows} rows').replace('{rows}',c.rows),
    weightLegendLabel:fdkText('合計重み w','Total weight w'),
    angleCoordinate:rebinned?'rebinned theta; relative to centre turn':'source beta; relative to centre turn'
  };
  if(paired){
    diagram.yAxisLabel=fdkText('実データ側の角度差  θ  (°)','Direct-side angle offset  θ  (°)');
    diagram.directLegendLabel=fdkText('実データ側 ○','Direct ○');
    diagram.weightLegendNote=fdkText('各補間ペアの重みを幅Tで合算。軌道の重なりは混色。','Pair weights summed over T. Trace overlaps blend.');
    diagram.angleCoordinate='common direct-side rebinned theta; complementary at theta+pi; relative to centre turn';
  }
  if(!zoom&&!paired)diagram.directLegendLabel=rebinned?fdkText('再配列後の列軌跡','Rebinned row trajectories'):fdkText('検出器列の軌跡','Detector-row trajectories');
  if(!rebinned&&zoom){
    diagram.rowLegendLabel=fdkText('仮想平面列','Virtual row');
    diagram.rowLabels=Array.from({length:rows},(_,i)=>rowMin+i);
    diagram.directLegendLabel=fdkText('仮想平面データ ○','Flat-grid data ○');
    diagram.weightLegendNote=fdkText('仮想平面上の行補間重み。軌道の重なりは混色。','Flat-grid row weights; trace overlaps blend.');
  }
  canvas.dataset.renderScale=String(canvas.width/900);
  drawDiagram(canvas,diagram,zoom?'zoom':'overview');
  for(const key of Object.keys(canvas.dataset))if(canvas.dataset[key]==='undefined')delete canvas.dataset[key];
  canvas.dataset.renderState='ready';
  canvas.dataset.complementaryMarkerShape=paired?'triangle':'not-applicable-in-own-angle-coordinate';
  canvas.dataset.complementaryLineStyle=paired?'dashed':'not-applicable-in-own-angle-coordinate';
  canvas.dataset.startIndex=selectedStateIndex;canvas.dataset.auditSamples=samples.length;
  canvas.dataset.markerEncoding='fixed-radius;row-colour;weight-fill';
  canvas.dataset.familyEncoding=paired?'direct solid/circle; complementary dashed/triangle; common direct-side rebinned angle':'each sample at its own acquired angle; no direct-reference folding';
  if(paired)canvas.dataset.diagramDisplayVersion='2026-09-17.8';
  canvas.dataset.backgroundTraceScope='geometric-context-independent-of-selected-weight-support';
  canvas.dataset.backgroundTurns=turns.join(',');
}
function fdkArrow(a,fw,level,color){const {ctx,s}=a,yy=a.y(level);ctx.strokeStyle=color;ctx.lineWidth=2*s;ctx.setLineDash([5*s,5*s]);for(const v of [fw.left,fw.right]){ctx.beginPath();ctx.moveTo(a.x(v),a.b.bottom);ctx.lineTo(a.x(v),yy);ctx.stroke();}ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(a.x(fw.left),yy);ctx.lineTo(a.x(fw.right),yy);for(const [v,d] of [[fw.left,1],[fw.right,-1]]){ctx.moveTo(a.x(v)+d*9*s,yy-6*s);ctx.lineTo(a.x(v),yy);ctx.lineTo(a.x(v)+d*9*s,yy+6*s);}ctx.stroke();}
function drawFdkSelectedProfile(canvas){
  const r=fdkResult,groups=fdkGroups(r),low=Math.min(0,...groups.map(([,g])=>Math.min(...g.profiles[selectedStateIndex].profile)));
  const a=fdkAxes(canvas,r.z[0],r.z.at(-1),Math.floor(low*10)/10,1.02,'z position (mm)','Normalized SSPz','(d)',low<0?[Math.floor(low*10)/10,0,.2,.4,.6,.8,1]:[0,.2,.4,.6,.8,1],120);
  groups.forEach(([name,g],i)=>{const p=g.profiles[selectedStateIndex],color=i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR;fdkDrawLines(a,g.z,[p.profile],color);fdkArrow(a,p.fwhm,.5,color);a.ctx.fillStyle=color;a.ctx.textAlign='center';a.ctx.font=`${23*a.s}px Arial`;a.ctx.fillText(`${name} / +${selectedStateIndex}°: FWHM ${p.fwhm.width.toFixed(2)} mm; FWTM ${p.fwtm.width.toFixed(2)} mm`,(a.b.left+a.b.right)/2,(50+i*35)*a.s);});canvas.dataset.startIndex=selectedStateIndex;
}
function drawFdkTail(canvas){
  const r=fdkResult,a=fdkAxes(canvas,r.z[0],r.z.at(-1),PROFILE_TAIL_DISPLAY_BOUNDS.yMin,PROFILE_TAIL_DISPLAY_BOUNDS.yMax,'z position (mm)','Normalized SSPz','(f)',[-2,-1,0],110,null,v=>10**v);
  const {ctx,b}=a;ctx.save();ctx.beginPath();ctx.rect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.clip();
  for(const [i,[,g]] of fdkGroups(r).entries()){
    ctx.strokeStyle=i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR;ctx.globalAlpha=.13;ctx.lineWidth=1.1;
    for(const p of g.profiles)strokeNativeProfile(ctx,r.z,p.profile,a.x,a.y,{tailView:true});
  }
  ctx.restore();drawFdkProfileLegend(a,r);
  canvas.dataset.profileOpacity='0.13';canvas.dataset.profileLineWidth='1.1';canvas.dataset.yScale='log10';canvas.dataset.tailFloor=String(PROFILE_TAIL_DISPLAY_BOUNDS.minimum);
}
function drawFdkSweep(canvas){
  const r=fdkResult,key=document.getElementById('fdk-width-metric').value,values=fdkGroups(r).flatMap(([,g])=>g.profiles.map(p=>p[key].width)),lo=Math.min(...values),hi=Math.max(...values),pad=Math.max(.01,(hi-lo)*.1),a=fdkAxes(canvas,0,360,Math.max(0,Math.floor((lo-pad)*100)/100),Math.ceil((hi+pad)*100)/100,'Start-angle offset (°)',`${key.toUpperCase()} (mm)`,'(g)',null,95,fdkAngleTicks);
  for(const [i,[name,g]] of fdkGroups(r).entries()){const color=i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR,ys=g.profiles.map(p=>p[key].width);fdkDrawLines(a,ys.map((_,j)=>j),[ys],color);a.ctx.fillStyle=color;a.ctx.textAlign='center';a.ctx.fillText(`${name}: ${Math.min(...ys).toFixed(2)}–${Math.max(...ys).toFixed(2)} mm`,a.b.left+(i?.73:.27)*(a.b.right-a.b.left),53*a.s);a.ctx.beginPath();a.ctx.arc(a.x(selectedStateIndex),a.y(ys[selectedStateIndex]),5*a.s,0,2*Math.PI);a.ctx.fill();}
  a.ctx.strokeStyle='#555';a.ctx.setLineDash([5*a.s,5*a.s]);a.ctx.beginPath();a.ctx.moveTo(a.x(selectedStateIndex),a.b.top);a.ctx.lineTo(a.x(selectedStateIndex),a.b.bottom);a.ctx.stroke();a.ctx.setLineDash([]);canvas.dataset.startIndex=selectedStateIndex;
}
function addFdkWorkflowSheets(sheets){
  sheets[0][1]=sheets[0][1].filter(([key])=>!['volume_storage','sample_weights_scope'].includes(key));
  sheets[0][1].push(['selected_start_index',selectedStateIndex],['start_angle_sweep','base phase + 0..359 degrees; object z fixed'],['volume_storage','No image volume; JSON stores selected-angle response and weights'],['thickness_definition','Configured thickness T is the rectangular averaging width; FWHM is measured from the resulting SSPz, not prescribed'],['first_angle_weights','Sample_weights contains the unaveraged centre snapshot at index 0; Selected_weights includes the response-average window at the inspected angle']);
  const r=fdkSelectedResult;if(!r?.weightAudit)return;
  if(r.config.zFfsEnabled){sheets.push(['zFFS_acquired_weights',zffsWeightRows(r)]);sheets.push(['zFFS_rebinned_weights',[['view_index','focus','row_index','theta_rad','beta_rad','z_relative_mm','weight','rebinned_value'],...r.rebinnedWeightAudit.map(q=>[q.view,q.focus?'B':'A',q.row,q.theta,q.beta,q.z,q.weight,q.acquiredValue])]]);}
  sheets[0][1].push(['selected_weight_scope',r.weightAudit.definition]);
  if(r.weightAudit.pairedSamples){
    sheets[0][1].push(['paired_diagram','Common direct-side rebinned angle; complementary coordinates evaluated at theta+pi. Paired_weights partitions Selected_weights by reference pair; do not add the two sheets together.']);
    sheets.push(['Paired_weights',[['start_index','reference_view_unwrapped','direction','rebinned_view_unwrapped','row_index','reference_theta_rad','rebinned_theta_rad','source_angle_rad','z_relative_mm','weight','angular_mean_factor','unfiltered_acquired_value'],...r.weightAudit.pairedSamples.map(q=>[selectedStateIndex,q.referenceView,q.direction?'complementary':'direct',q.view,q.row,r.config.phase+q.referenceView*2*Math.PI/r.config.viewSamples,q.theta,q.beta,q.z,q.weight,r.weightAudit.db,q.acquiredValue])]]);
  }
  sheets.push(['Selected_weights',[['start_index','view_unwrapped','row_index','theta_rad','source_angle_rad','z_relative_mm',r.model?.kind==='rri'?'RRI_weight':'weight',...(r.reference?['reference_weight']:[]),'angular_mean_factor','unfiltered_acquired_value'],...r.weightAudit.samples.map(q=>[selectedStateIndex,q.view,q.row,q.theta,q.beta,q.z,q.weight,...(r.reference?[q.referenceWeight]:[]),r.weightAudit.db,q.acquiredValue])]]);
}
async function exportFdkWorkflowCanvas(id){
  if(!fdkSelectedResult)return;const source=document.getElementById(id),c=document.createElement('canvas'),diagram=id==='fdk-geometry'||id.startsWith('fdk-weights');c.width=Math.round((diagram?80:180)/25.4*600);c.height=Math.round(c.width*source.height/source.width);
  if(id==='fdk-geometry')drawFdkCandidateDiagram(c,fdkSelectedResult,false);
  else if(id.startsWith('fdk-weights'))drawFdkCandidateDiagram(c,fdkSelectedResult,true,id.endsWith('rri'));
  else if(id==='fdk-selected-profile')drawFdkSelectedProfile(c);
  else if(id==='fdk-tail')drawFdkTail(c);
  else if(id==='fdk-sweep')drawFdkSweep(c);
  else drawFdkDifference(c,fdkResult);
  const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob(`${fdkFileStem(fdkResult)}_${id}_angle-${selectedStateIndex}_600dpi.png`,await pngWithResolution(blob,600),'image/png');
}
