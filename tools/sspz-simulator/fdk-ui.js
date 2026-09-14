// Integrated UI for the browser worker, using the existing shared form,
// geometry conventions, XLSX writer and PNG resolution metadata.
const FDK_UI_FIELDS={sphereDiameter:.65,channelWidth:.25,apertureSamples:8,
  xyExtent:1.5,xySamples:17,zExtent:3,zStep:.05,phaseCount:1,phase:0,state:0,normalization:'minmax'};
let fdkResult=null;
const fdkText=(ja,en)=>document.documentElement.lang.startsWith('en')?en:ja;
function readFdkParams(){
  const out={computationModel:document.querySelector('#computationModel')?.value??'axial'};
  if(out.computationModel!=='fdk')return out;
  for(const [k,v] of Object.entries(FDK_UI_FIELDS)){
    const e=document.getElementById('fdk-'+k);out[k]=e?(typeof v==='number'?Number(e.value):e.value):v;
  }
  return out;
}
function writeFdkUrl(url,p){
  if(p.computationModel!=='fdk')return;
  url.searchParams.set('model','fdk');
  for(const [k,v] of Object.entries(FDK_UI_FIELDS))url.searchParams.set('fdk_'+k,p[k]??v);
}
function fdkParamsFromUrl(q){
  const out={computationModel:q.get('model')==='fdk'?'fdk':'axial'};
  if(out.computationModel!=='fdk')return out;
  for(const [k,v] of Object.entries(FDK_UI_FIELDS))out[k]=q.has('fdk_'+k)?(typeof v==='number'?Number(q.get('fdk_'+k)):q.get('fdk_'+k)):v;
  return out;
}
function initializeFdkUi(initial){
  const pick=document.createElement('label');pick.innerHTML=fdkText('計算モデル','Calculation model')+`<select id="computationModel" name="computationModel"><option value="axial">${fdkText('展開図・体軸方向の補間モデル','Unwrapped geometry / axial interpolation')}</option><option value="fdk">${fdkText('3次元FBP（ヘリカルFDK近似）','3D FBP (helical FDK approximation)')}</option></select>`;
  form.prepend(pick);pick.querySelector('select').value=initial.computationModel??'axial';
  const controls=document.createElement('div');controls.id='fdk-controls';controls.className='fdk-controls';
  const num=(k,ja,en,min,max,step)=>`<label>${fdkText(ja,en)}<input id="fdk-${k}" name="${k}" type="number" min="${min}" max="${max}" step="${step}" value="${FDK_UI_FIELDS[k]}"></label>`;
  const sel=(k,ja,en,options)=>`<label>${fdkText(ja,en)}<select id="fdk-${k}" name="${k}">${options.map(([v,t])=>`<option value="${v}" ${v===FDK_UI_FIELDS[k]?'selected':''}>${t}</option>`).join('')}</select></label>`;
  controls.innerHTML=`<p class="section-summary">${fdkText('列数・列幅・ピッチ・焦点距離・評価位置・取得ビュー数は上の共通条件を使用します。以下は3次元FBP用の条件です。','Rows, row width, pitch, source radius, evaluation radius and views per turn use the shared controls above.')}</p>
  <div class="preset-row">${[80,160,320].map(n=>`<button class="chip" type="button" data-fdk-rows="${n}">${n} ${fdkText('列','rows')}</button>`).join('')}<span>${fdkText('プリセット：列幅0.5 mm・ピッチ0.5（装置仕様ではありません）','Presets: 0.5-mm rows, pitch 0.5 (not scanner specifications)')}</span></div>
  <div class="parameter-grid">
  ${num('sphereDiameter','球の直径 (mm)','Sphere diameter (mm)',.1,10,.01)}
  ${num('channelWidth','面内チャネル幅：回転中心換算 (mm)','Transaxial channel width at isocenter (mm)',.05,1,.05)}
  ${sel('apertureSamples','開口積分：各方向の分割数','Aperture quadrature per direction',[[4,'4 × 4'],[8,'8 × 8'],[16,'16 × 16'],[32,'32 × 32']])}
  ${num('zStep','再構成z間隔 (mm)','Reconstruction z spacing (mm)',.01,.2,.01)}
  ${num('zExtent','再構成z範囲：中心から± (mm)','Reconstruction z half-range (mm)',1,20,.5)}
  ${num('xyExtent','局所画像範囲：中心から± (mm)','Local image half-range (mm)',.5,10,.5)}
  ${sel('xySamples','局所画像の行列数','Local image matrix',[[17,'17 × 17'],[33,'33 × 33'],[65,'65 × 65']])}
  ${sel('phaseCount','回転開始角度の条件数','Number of start angles',[[1,'1'],[4,'4'],[12,'12']])}
  ${num('phase','z = 0でのX線源角度 (rad)','Source angle at z = 0 (rad)',0,6.28318530718,.01)}
  ${num('state','物体のz位置／1回転寝台移動量','Object z / table feed per turn',0,1,.01)}
  ${sel('normalization','表示と幅測定の正規化','Normalization for display and widths', [['minmax',fdkText('最小値0・最大値1','Minimum 0, maximum 1')],['peak',fdkText('最大値1（負値を保持）','Peak 1 (retain negative values)')]])}
  </div><p class="model-note">${fdkText('各断面に連続360°のデータを使用します。ピッチ0では円軌道FDKです。必要な投影が検出器範囲から外れる条件では、欠測を補わず計算を停止します。','Each slice uses a contiguous full turn; pitch 0 uses circular FDK. Computation stops if the required projections fall outside the detector; missing data are not extrapolated.')}</p>`;
  form.append(controls);
  for(const [k,v] of Object.entries(FDK_UI_FIELDS))document.getElementById('fdk-'+k).value=initial[k]??v;
  const panel=document.createElement('section');panel.id='fdk-panel';panel.setAttribute('aria-labelledby','fdk-title');
  panel.innerHTML=`<div class="section-heading"><h2 id="fdk-title">${fdkText('展開図から3次元FBPへ','From acquired geometry to 3D FBP')}</h2></div>
  <p class="section-summary">${fdkText('円弧状検出器の球投影 → 平面座標への再標本化 → コーン角の前重み → 面内Ram-Lakフィルタ → 3次元逆投影 → 各断面のROI平均。','Sphere projections on the cylindrical detector → flat-detector rebinning → cone preweight → transaxial Ram-Lak filtering → 3D backprojection → slice-wise ROI mean.')}</p>
  <p id="fdk-summary" aria-live="polite"></p><p id="fdk-result-config"></p>
  <div class="chart-grid two">
  <article class="chart-card"><h3>${fdkText('取得列の展開図','Acquired detector-row geometry')}</h3><canvas id="fdk-geometry" width="1000" height="700"></canvas></article>
  <article class="chart-card"><h3>${fdkText('球から求めたSSPz','Sphere-derived SSPz')}</h3><canvas id="fdk-profile" width="1000" height="700"></canvas></article>
  <article class="chart-card"><h3>${fdkText('横断像：球の中心断面','Axial image through the sphere center')}</h3><canvas id="fdk-axial" width="900" height="800"></canvas></article>
  <article class="chart-card"><h3>${fdkText('冠状断像：球の中心断面','Coronal image through the sphere center')}</h3><canvas id="fdk-coronal" width="900" height="800"></canvas></article>
  </div><div id="fdk-difference-wrap" class="chart-card" hidden><h3>${fdkText('各SSPzと平均SSPzの差','Each SSPz minus the mean SSPz')}</h3><canvas id="fdk-difference" width="1200" height="650"></canvas><p>${fdkText('球の中心を共通の原点とし、各z位置の平均を引きます。FWHM中点での位置合わせは行いません。','The sphere center is the common origin; the pointwise mean is subtracted. Profiles are not aligned by their FWHM midpoints.')}</p></div>
  <div class="action-row"><button type="button" id="fdk-xlsx" class="secondary" disabled>${fdkText('SSPz・平均差をExcel保存','Export SSPz and mean differences to Excel')}</button><button type="button" id="fdk-csv" class="secondary" disabled>SSPz CSV</button><button type="button" id="fdk-json" class="secondary" disabled>${fdkText('3次元画像・条件をJSON保存','Export 3D volume and conditions as JSON')}</button><button type="button" id="fdk-png" class="secondary" disabled>${fdkText('SSPzを600 dpi PNG保存','Save SSPz as 600-dpi PNG')}</button></div>
  <details class="reading-details"><summary>${fdkText('方法・解釈の範囲','Method and interpretation')}</summary><p>${fdkText('FDK型の近似3次元FBPです。既存の展開図と焦点軌道・検出器列位置を共有しますが、体軸方向だけの補間モデルとは計算経路が異なります。TCOTの再現や厳密な広角コーンビーム逆変換ではありません。','This is an approximate FDK-type 3D FBP. It shares the source trajectory and detector-row positions with the existing diagrams, but uses a different reconstruction path from the axial interpolation model. It does not reproduce TCOT or implement exact wide-cone inversion.')}</p><p>${fdkText('対象は有限径の一様な球です。像中心に置いた、球の投影半径と等しい円形ROIの平均を各断面で求めます。ビーズ径の補正、ノイズ、焦点サイズ、隔壁、装置固有の重みは含みません。設定厚T・FWはこの経路に適用しません。','The object is a uniform finite sphere. Each axial profile sample is the mean of a centered circular ROI with the sphere radius. Bead deconvolution, noise, focal-spot size, septa and scanner-specific weights are excluded. Reference thickness T and filter width FW do not apply to this path.')}</p><p>${fdkText('表示は計算点を直線で結びます。最小値0・最大値1の正規化では、FBP由来の負の応答も基線移動されます。元のROI値はExcelに保持し、最大値のみで正規化する表示も選べます。FWHMとFWTMは選択した正規化曲線から求めます。画像の濃淡は負値を黒にし、全画像共通の最大値まで表示します。','Displayed curves join native samples with straight lines. Min–max normalization also shifts any negative FBP lobes. Raw ROI values are retained in Excel, and peak-only normalization is available. Widths use the selected normalized curves. Images clip negative values to black and share the volume maximum as white.')}</p><p>${fdkText('80～320列は計算可能な検出器構成です。列数だけで実機への妥当性を保証しません。ビュー数・開口分割数・チャネル幅・画像格子を変えて数値依存性を確認してください。','80–320 rows are supported computational configurations; row count alone does not establish scanner validity. Assess numerical dependence on views, aperture quadrature, channel width and image grids.')}</p><p><a href="FDK_METHOD.md">${fdkText('数式・座標・検証記録','Equations, coordinates and verification')}</a> · <a href="https://doi.org/10.1364/JOSAA.1.000612">Feldkamp et al. (1984)</a> · <a href="https://doi.org/10.1088/0031-9155/49/13/011">Kudo et al. (2004)</a></p></details>`;
  document.querySelector('.control-shell').after(panel);
  const viewHelp=document.querySelector('#viewSamples')?.parentElement.querySelector('small');
  const axialViewHelp=viewHelp?.textContent;
  function modeChanged(){
    const on=pick.querySelector('select').value==='fdk';controls.hidden=!on;panel.hidden=!on;
    document.querySelectorAll('main > section').forEach(s=>{if(s!==panel&&!s.classList.contains('control-shell'))s.hidden=on;});
    for(const k of ['sliceThicknessMm','filterWidthMm','filterSamples','profileMode','reconstructionPath','zSamples'])document.getElementById(k)?.closest('label')?.toggleAttribute('hidden',on);
    const help=document.querySelector('#beamPitch')?.parentElement.querySelector('small');if(help)help.hidden=on;
    if(viewHelp)viewHelp.textContent=on?fdkText('1回転の実取得ビュー数です。角度条件数とは別です。','Acquired views per full turn; independent of the number of start angles.'):axialViewHelp;
    if(legacyUrlNote&&on)legacyUrlNote.hidden=true;
    if(!runButton.disabled)status.textContent=fdkText('計算モデルを選択しました。条件を確認して計算してください。','Model selected. Check the conditions and calculate.');
  }
  pick.querySelector('select').addEventListener('change',modeChanged);modeChanged();
  resetButton.addEventListener('click',()=>{pick.querySelector('select').value='axial';for(const [k,v] of Object.entries(FDK_UI_FIELDS))document.getElementById('fdk-'+k).value=v;modeChanged();});
  controls.querySelectorAll('[data-fdk-rows]').forEach(b=>b.addEventListener('click',()=>{if(runButton.disabled)return;form.elements.rows.value=b.dataset.fdkRows;form.elements.rowWidth.value=.5;form.elements.beamPitch.value=.5;status.textContent=fdkText('プリセットを設定しました。計算するを押してください。','Preset selected. Press Calculate.');}));
  document.getElementById('fdk-csv').onclick=()=>{const r=fdkResult;if(!r)return;downloadBlob('FDK_SSPz.csv','\uFEFF'+[['z_position_mm',...r.profiles.flatMap((_,i)=>['raw_'+i,'normalized_'+i])],...Array.from(r.z,(z,i)=>[z,...r.profiles.flatMap(p=>[p.raw[i],p.profile[i]])])].map(row=>row.join(',')).join('\r\n'));};
  document.getElementById('fdk-json').onclick=()=>{if(fdkResult)downloadBlob('FDK_volume.json',JSON.stringify(fdkResult,(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v),'application/json');};
  document.getElementById('fdk-xlsx').onclick=async()=>{
    const r=fdkResult;if(!r)return;
    const sheets=[['Readme',[['Item','Value'],['version',r.model.version],...Object.entries(r.model),...Object.entries(r.config),['coordinate','z relative to sphere center (mm); no FWHM alignment'],['ROI','disk centered on sphere, radius = sphere radius'],['raw_profile','mean reconstructed attenuation in disk ROI'],['normalization_baseline',r.baseline],['width_definition','each normalized native profile; linear threshold crossings'],['volume_storage','JSON volume[z,y,x], x fastest; selected first phase only'],['precision','Unrounded Float64 values; display precision is not measurement accuracy']]],
      ['SSPz',[['z_position_mm',...r.profiles.flatMap((_,i)=>['raw_'+i,'normalized_'+i])],...Array.from(r.z,(z,i)=>[z,...r.profiles.flatMap(p=>[p.raw[i],p.profile[i]])])]],
      ['Mean_difference',[['z_position_mm','mean_normalized',...r.profiles.map((_,i)=>'difference_'+i)],...Array.from(r.z,(z,i)=>[z,r.mean[i],...r.meanDifference.map(p=>p[i])])]],
      ['Widths',[['start_angle_rad','FWHM_mm','FWTM_mm','normalization_baseline'],...r.profiles.map(p=>[p.phase,p.fwhm.width,p.fwtm.width,p.baseline])]]];
    downloadBlob('FDK_SSPz.xlsx',await SSPZShape.fromSheets(sheets),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  document.getElementById('fdk-png').onclick=async()=>{if(!fdkResult)return;const c=document.createElement('canvas');c.width=Math.round(180/25.4*600);c.height=Math.round(c.width*.7);fdkDrawProfile(c,fdkResult);const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob('FDK_SSPz_600dpi.png',await pngWithResolution(blob,600),'image/png');};
}
function fdkToggleDownloads(on){for(const id of ['fdk-xlsx','fdk-csv','fdk-json','fdk-png'])document.getElementById(id).disabled=!on;}
function runFdkSimulation(){
  const params={...readParams(),...readFdkParams()};
  releaseWorker();clearError();lastResult=null;fdkResult=null;fdkToggleDownloads(false);setBusy(true);
  document.getElementById('fdk-summary').textContent=fdkText('3次元FBPを計算中…','Computing 3D FBP…');document.getElementById('fdk-result-config').textContent='';
  for(const canvas of document.querySelectorAll('#fdk-panel canvas'))drawCanvasStatus(canvas,'3D FBP',fdkText('計算中','Calculating'));
  document.getElementById('fdk-difference-wrap').hidden=true;
  startedAt=performance.now();progress.value=0;
  const url=paramsToUrl(params);try{history.replaceState(null,'',url);localStorage.setItem('sspz-unwrapped-params',JSON.stringify(params));}catch{}
  syncLanguageLinks(url.search);worker=createComputationWorker();
  const fail=text=>{setBusy(false);fdkToggleDownloads(false);showError(text);status.textContent=fdkText('計算を完了できませんでした','Calculation could not be completed');document.getElementById('fdk-summary').textContent=text;for(const c of document.querySelectorAll('#fdk-panel canvas'))drawCanvasStatus(c,'3D FBP',fdkText('有効な再構成結果なし','No valid reconstruction'),'error');releaseWorker();};
  worker.onmessage=({data:m})=>{
    if(m.type==='progress'){progress.value=m.value;status.textContent=m.label;}
    else if(m.type==='fdk-result'){
      fdkResult=m.result;renderFdkResult(fdkResult);progress.value=1;setBusy(false);fdkToggleDownloads(true);status.textContent=fdkText('完了 ','Completed ')+((performance.now()-startedAt)/1000).toFixed(1)+' s / 3D FBP';releaseWorker();
    }else if(m.type==='cancelled'){setBusy(false);document.getElementById('fdk-summary').textContent=fdkText('計算を中止しました','Calculation cancelled');status.textContent=document.getElementById('fdk-summary').textContent;releaseWorker();}
    else if(m.type==='error'){
      let text=m.message;
      if(text.startsWith('FDK_COVERAGE'))text=fdkText('この条件では、球の投影または局所画像に必要な連続360°のデータが検出器範囲から外れます。ピッチまたは再構成範囲を小さくしてください。展開図・体軸方向モデルは引き続き選択できます。',text);
      if(text.startsWith('FDK_DOMAIN'))text=fdkText('幅を求める交点が表示範囲内にありません。再構成z範囲を広げてください。',text);
      fail(text);
    }
  };worker.onerror=e=>fail(e.message);worker.postMessage({type:'fdk-run',params});
}
function fdkAxes(canvas,xmin,xmax,ymin,ymax,xlabel,ylabel,panel,yTicks=null){
  const ctx=canvas.getContext('2d'),s=canvas.width/1000,w=canvas.width,h=canvas.height;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.font=`${25*s}px Arial`;ctx.fillStyle='#000';ctx.textAlign='left';ctx.fillText(panel,18*s,30*s);
  const b={left:130*s,right:w-35*s,top:72*s,bottom:h-105*s};
  const x=v=>b.left+(v-xmin)/(xmax-xmin)*(b.right-b.left),y=v=>b.bottom-(v-ymin)/(ymax-ymin)*(b.bottom-b.top);
  const label=v=>Math.abs(v)<1e-10?'0':Math.abs(v)>=100?v.toFixed(0):Number(v.toFixed(2)).toString();
  ctx.font=`${23*s}px Arial`;
  for(let i=0;i<=4;i++){
    const vx=xmin+(xmax-xmin)*i/4;
    ctx.strokeStyle='#d6d6d6';ctx.lineWidth=s;ctx.beginPath();ctx.moveTo(x(vx),b.top);ctx.lineTo(x(vx),b.bottom);ctx.stroke();
    ctx.fillStyle='#000';ctx.textAlign='center';ctx.fillText(label(vx),x(vx),b.bottom+32*s);
  }
  for(const vy of yTicks??Array.from({length:5},(_,i)=>ymin+(ymax-ymin)*i/4)){
    ctx.strokeStyle='#d6d6d6';ctx.beginPath();ctx.moveTo(b.left,y(vy));ctx.lineTo(b.right,y(vy));ctx.stroke();ctx.fillStyle='#000';ctx.textAlign='right';ctx.fillText(label(vy),b.left-14*s,y(vy)+8*s);
  }
  ctx.strokeStyle='#000';ctx.lineWidth=1.6*s;ctx.strokeRect(b.left,b.top,b.right-b.left,b.bottom-b.top);
  ctx.textAlign='center';ctx.font=`${27*s}px Arial`;ctx.fillText(xlabel,(b.left+b.right)/2,h-26*s);
  ctx.save();ctx.translate(35*s,(b.top+b.bottom)/2);ctx.rotate(-Math.PI/2);ctx.fillText(ylabel,0,0);ctx.restore();
  return {ctx,s,b,x,y};
}
function fdkDrawLines(a,xs,series){
  const {ctx,s,b,x,y}=a;ctx.save();ctx.beginPath();ctx.rect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.clip();
  for(const values of series){ctx.strokeStyle=series.length>1?'rgba(213,94,0,.6)':'#d55e00';ctx.lineWidth=2*s;ctx.beginPath();values.forEach((v,i)=>i?ctx.lineTo(x(xs[i]),y(v)):ctx.moveTo(x(xs[i]),y(v)));ctx.stroke();}ctx.restore();
}
function fdkDrawProfile(canvas,r){
  const ymin=Math.min(0,...r.profiles.map(p=>Math.min(...p.profile))),low=ymin<0?Math.floor(ymin*10)/10:0,a=fdkAxes(canvas,r.z[0],r.z.at(-1),low,1.2,'z position (mm)','Normalized SSPz','(b)',low<0?[low,0,.5,1]:[0,.5,1]);
  fdkDrawLines(a,r.z,r.profiles.map(p=>p.profile));
  const widths=r.profiles.map(p=>p.fwhm.width),mean=widths.reduce((s,v)=>s+v,0)/widths.length;
  const sd=widths.length>1?Math.sqrt(widths.reduce((s,v)=>s+(v-mean)**2,0)/(widths.length-1)):null;
  a.ctx.font=`${25*a.s}px Arial`;a.ctx.textAlign='center';a.ctx.fillStyle='#000';
  a.ctx.fillText(`FWHM ${mean.toFixed(2)}${sd===null?'':' ± '+sd.toFixed(3)} mm`,(a.b.left+a.b.right)/2,a.y(1.08));
  const fw=r.profiles[0].fwhm,yy=a.y(.5);a.ctx.strokeStyle='#000';a.ctx.lineWidth=1.5*a.s;a.ctx.beginPath();a.ctx.moveTo(a.x(fw.left),yy);a.ctx.lineTo(a.x(fw.right),yy);
  for(const [v,d] of [[fw.left,1],[fw.right,-1]]){a.ctx.moveTo(a.x(v)+d*9*a.s,yy-5*a.s);a.ctx.lineTo(a.x(v),yy);a.ctx.lineTo(a.x(v)+d*9*a.s,yy+5*a.s);}a.ctx.stroke();
}
function fdkDrawGeometry(canvas,r){
  const c=r.config,feed=c.feed,step=2*Math.PI/c.viewSamples;
  const first=Math.ceil(((feed?2*Math.PI*r.zObject/feed:0)-Math.PI)/step-1e-12),beta0=c.phase+first*step;
  const betas=Array.from({length:c.viewSamples+1},(_,i)=>beta0+i*step),curves=[];let limit=0;
  for(let row=0;row<c.rows;row++){
    const values=betas.map(beta=>{const L=Math.hypot(c.sourceRadius*Math.cos(beta)-c.radius,c.sourceRadius*Math.sin(beta));return feed*(beta-c.phase)/(2*Math.PI)+(row-(c.rows-1)/2)*c.rowWidth*L/c.sourceRadius-r.zObject;});
    limit=Math.max(limit,...values.map(Math.abs));curves.push(values);
  }
  limit=Math.ceil(limit/5)*5||5;
  const a=fdkAxes(canvas,-limit,limit,0,360,'Row position relative to sphere (mm)','Acquired angle within turn (°)','(a)');
  const {ctx,s}=a;ctx.save();ctx.beginPath();ctx.rect(a.b.left,a.b.top,a.b.right-a.b.left,a.b.bottom-a.b.top);ctx.clip();ctx.lineWidth=Math.max(.6,1.1- c.rows/800)*s;ctx.strokeStyle='#687780';ctx.globalAlpha=Math.max(.22,Math.min(.7,25/c.rows));
  for(const values of curves){ctx.beginPath();values.forEach((v,i)=>i?ctx.lineTo(a.x(v),a.y(360*i/c.viewSamples)):ctx.moveTo(a.x(v),a.y(0)));ctx.stroke();}
  ctx.globalAlpha=1;ctx.strokeStyle='#d55e00';ctx.lineWidth=2*s;ctx.setLineDash([7*s,5*s]);ctx.beginPath();ctx.moveTo(a.x(0),a.y(0));ctx.lineTo(a.x(0),a.y(360));ctx.stroke();ctx.restore();
  ctx.font=`${22*s}px Arial`;ctx.fillStyle='#000';ctx.textAlign='center';ctx.fillText(`${c.rows} rows / central-slice full turn`,(a.b.left+a.b.right)/2,49*s);
}
function fdkDrawImage(canvas,r,coronal){
  const n=r.config.xySamples,nz=r.z.length,m=(n-1)/2,iz=(nz-1)/2,values=[];
  const nx=n,ny=coronal?nz:n;
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++)values.push(coronal?r.volume[((nz-1-j)*n+m)*n+i]:r.volume[(iz*n+(n-1-j))*n+i]);
  const peak=r.volume.reduce((m,v)=>Math.max(m,v),0),pixel=2*r.config.xyExtent/(n-1),xmin=-r.config.xyExtent-pixel/2,xmax=-xmin;
  const ymin=coronal?r.z[0]-r.config.zStep/2:xmin,ymax=-ymin;
  const a=fdkAxes(canvas,xmin,xmax,ymin,ymax,'x relative to sphere (mm)',coronal?'z position (mm)':'y relative to sphere (mm)',coronal?'(d)':'(c)');
  const w=a.b.right-a.b.left,h=a.b.bottom-a.b.top,scale=Math.min(w/(xmax-xmin),h/(ymax-ymin));
  // Reuse the numeric frame but draw a square metric image in its own bounds.
  // Give x and y the same mm-to-pixel scale by extending the narrower axis.
  const rx=(xmax-xmin)/2,ry=(ymax-ymin)/2,cx=(a.b.left+a.b.right)/2,cy=(a.b.top+a.b.bottom)/2;
  const physical=fdkAxes(canvas,-w/(2*scale),w/(2*scale),-h/(2*scale),h/(2*scale),'x relative to sphere (mm)',coronal?'z position (mm)':'y relative to sphere (mm)',coronal?'(d)':'(c)');
  const temp=document.createElement('canvas');temp.width=nx;temp.height=ny;const tc=temp.getContext('2d'),im=tc.createImageData(nx,ny);
  values.forEach((v,i)=>{const shade=Math.round(Math.max(0,Math.min(1,v/peak))*255);im.data.set([shade,shade,shade,255],4*i);});tc.putImageData(im,0,0);physical.ctx.imageSmoothingEnabled=false;physical.ctx.drawImage(temp,cx-rx*scale,cy-ry*scale,2*rx*scale,2*ry*scale);
  physical.ctx.textAlign='center';physical.ctx.fillStyle='#000';physical.ctx.font=`${22*a.s}px Arial`;physical.ctx.fillText(`Attenuation: black 0 / white ${peak.toFixed(2)}`,(a.b.left+a.b.right)/2,49*a.s);
}
function renderFdkResult(r){
  const c=r.config;document.getElementById('fdk-summary').textContent=fdkText('再構成完了。各断面の全360°の取得範囲を確認しました。','Reconstruction complete. Full-turn acquisition coverage was checked for every slice.');
  document.getElementById('fdk-result-config').textContent=`${c.rows} ${fdkText('列','rows')} × ${c.rowWidth.toFixed(2)} mm / pitch ${c.beamPitch} / r = ${c.radius} mm / ${c.viewSamples} views/turn / sphere ${c.sphereDiameter.toFixed(2)} mm / ${r.profiles.length} ${fdkText('角度条件','start angles')} / ${fdkText('最初の角度条件：','first angle: ')}FWTM ${r.fwtm.width.toFixed(2)} mm`+(r.profiles.length>1?fdkText('。FWHMは個々の幅の平均±SD。矢印・画像・展開図は最初の角度条件です。','. FWHM: mean ± SD of individual widths. Arrow, images and geometry show the first angle.'):'');
  fdkDrawGeometry(document.getElementById('fdk-geometry'),r);fdkDrawProfile(document.getElementById('fdk-profile'),r);fdkDrawImage(document.getElementById('fdk-axial'),r,false);fdkDrawImage(document.getElementById('fdk-coronal'),r,true);
  document.getElementById('fdk-difference-wrap').hidden=r.profiles.length===1;
  if(r.profiles.length>1){const limit=Math.ceil(Math.max(.02,...r.meanDifference.map(p=>Math.max(...p.map(Math.abs))))/.02)*.02,a=fdkAxes(document.getElementById('fdk-difference'),r.z[0],r.z.at(-1),-limit,limit,'z position (mm)','SSPz minus mean','(e)');fdkDrawLines(a,r.z,r.meanDifference);}
}
