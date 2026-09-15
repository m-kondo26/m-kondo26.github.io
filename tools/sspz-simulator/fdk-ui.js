// Integrated UI for the browser worker, using the existing shared form,
// geometry conventions, XLSX writer and PNG resolution metadata.
const FDK_UI_FIELDS={method:'fdk',edgePolicy:'available',axialAverageMm:0,sphereDiameter:.65,channelWidth:.25,apertureSamples:8,
  xyExtent:1.5,xySamples:17,zExtent:3,zStep:.05,phaseCount:1,phase:0,state:0,normalization:'minmax'};
let fdkResult=null;
let fdkShapeGroups=null;
const fdkGroups=r=>r.reference?[['CBA',r],['RRI',r.reference]]:[['FDK',r]];
const fdkFileStem=r=>r.reference?'Hsieh_CBA_RRI':'FDK';
function fdkWidthStats(r){const v=r.profiles.map(p=>p.fwhm.width),mean=v.reduce((s,x)=>s+x,0)/v.length;return {mean,sd:v.length>1?Math.sqrt(v.reduce((s,x)=>s+(x-mean)**2,0)/(v.length-1)):null,min:Math.min(...v),max:Math.max(...v)};}
const fdkWidthAnnotation=(mean,sd)=>sd===null?`${mean.toFixed(2)} mm`:sd<.001?`${mean.toFixed(2)} mm; SD < 0.001 mm`:`${mean.toFixed(2)} ± ${sd.toFixed(3)} mm`;
function fdkProfileRows(r){const groups=fdkGroups(r);return [['z_position_mm',...groups.flatMap(([name,g])=>g.profiles.flatMap((_,i)=>[name+'_raw_'+i,name+'_normalized_'+i]))],...Array.from(r.z,(z,i)=>[z,...groups.flatMap(([,g])=>g.profiles.flatMap(p=>[p.raw[i],p.profile[i]]))])];}
const fdkText=(ja,en)=>document.documentElement.lang.startsWith('en')?en:ja;
function readFdkParams(){
  const out={computationModel:document.querySelector('#computationModel')?.value??'axial'};
  if(out.computationModel!=='fdk')return out;
  for(const [k,v] of Object.entries(FDK_UI_FIELDS)){
    const e=document.getElementById('fdk-'+k);out[k]=e?(typeof v==='number'?Number(e.value):e.value):v;
  }
  if(out.method!=='hsieh')out.axialAverageMm=0;
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
  const pick=document.createElement('label');pick.innerHTML=fdkText('計算モデル','Calculation model')+`<select id="computationModel" name="computationModel"><option value="axial">${fdkText('展開図・体軸方向の補間モデル','Unwrapped geometry / axial interpolation')}</option><option value="fdk">${fdkText('3次元FBP（FDK・Hsieh CBA/RRI）','3D FBP (FDK / Hsieh CBA and RRI)')}</option></select>`;
  form.prepend(pick);pick.querySelector('select').value=initial.computationModel??'axial';
  const controls=document.createElement('div');controls.id='fdk-controls';controls.className='fdk-controls';
  const num=(k,ja,en,min,max,step)=>`<label>${fdkText(ja,en)}<input id="fdk-${k}" name="${k}" type="number" min="${min}" max="${max}" step="${step}" value="${FDK_UI_FIELDS[k]}"></label>`;
  const sel=(k,ja,en,options)=>`<label>${fdkText(ja,en)}<select id="fdk-${k}" name="${k}">${options.map(([v,t])=>`<option value="${v}" ${v===FDK_UI_FIELDS[k]?'selected':''}>${t}</option>`).join('')}</select></label>`;
  controls.innerHTML=`<p class="section-summary">${fdkText('列数・列幅・ピッチ・焦点距離・評価位置・取得ビュー数は上の共通条件を使用します。以下は3次元FBP用の条件です。','Rows, row width, pitch, source radius, evaluation radius and views per turn use the shared controls above.')}</p>
  <div class="preset-row">${[80,160,320].map(n=>`<button class="chip" type="button" data-fdk-rows="${n}">${n} ${fdkText('列','rows')}</button>`).join('')}<span>${fdkText('プリセット：列幅0.5 mm・ピッチ0.5（装置仕様ではありません）','Presets: 0.5-mm rows, pitch 0.5 (not scanner specifications)')}</span></div>
  <div class="parameter-grid">
  ${sel('method','3次元再構成法','3D reconstruction method',[['fdk',fdkText('従来のヘリカルFDK近似','Original helical FDK reference')],['hsieh',fdkText('Hsiehらの対向データ補間（CBAとRRIを比較）','Hsieh conjugate interpolation (CBA vs RRI)')]])}
  ${sel('edgePolicy','Hsieh法の検出器端処理','Hsieh detector-edge treatment',[['available',fdkText('取得済みの列で正規化','Normalize acquired rows')],['strict',fdkText('4点が揃う場合のみ','Require all four row samples')]])}
  ${num('axialAverageMm','Hsieh法：画像の体軸方向平均化幅 (mm)','Hsieh image-domain axial averaging width (mm)',0,10,.1)}
  ${num('sphereDiameter','球の直径 (mm)','Sphere diameter (mm)',.1,10,.01)}
  ${num('channelWidth','面内チャネル幅：回転中心換算 (mm)','Transaxial channel width at isocenter (mm)',.05,1,.05)}
  ${sel('apertureSamples','開口積分：各方向の分割数','Aperture quadrature per direction',[[4,'4 × 4'],[8,'8 × 8'],[16,'16 × 16'],[32,'32 × 32']])}
  ${num('zStep','再構成z間隔 (mm)','Reconstruction z spacing (mm)',.01,.2,.01)}
  ${num('zExtent','再構成z範囲：中心から± (mm)','Reconstruction z half-range (mm)',1,20,.5)}
  ${num('xyExtent','局所画像範囲：中心から± (mm)','Local image half-range (mm)',.5,10,.5)}
  ${sel('xySamples','局所画像の行列数','Local image matrix',[[17,'17 × 17'],[33,'33 × 33'],[65,'65 × 65']])}
  ${sel('phaseCount','回転開始角度の条件数','Number of start angles',[[1,'1'],[4,'4'],[12,'12'],[36,'36'],[120,'120'],[360,'360']])}
  ${num('phase','z = 0でのX線源角度 (rad)','Source angle at z = 0 (rad)',0,6.28318530718,.01)}
  ${num('state','物体のz位置／1回転寝台移動量','Object z / table feed per turn',0,1,.01)}
  ${sel('normalization','表示と幅測定の正規化','Normalization for display and widths', [['minmax',fdkText('最小値0・最大値1','Minimum 0, maximum 1')],['peak',fdkText('最大値1（負値を保持）','Peak 1 (retain negative values)')]])}
  </div><p class="model-note">${fdkText('各断面に1回転分を使用します。Hsieh法は同じ前処理・同じ投影からCBAとRRIを計算します。取得ビュー数は偶数にしてください。取得済みの列で正規化する設定では、検出器外の列を除いて対向データと重みを正規化します。両方向とも支持を失う場合は停止します。','Each slice uses one turn. The Hsieh path computes CBA and RRI from identical projections and preprocessing. Use an even view count. The acquired-row option omits unavailable rows and normalizes the remaining conjugate weights. Computation stops if neither direction has support.')}</p>`;
  form.append(controls);
  const syncHsiehControls=()=>{const enabled=document.getElementById('fdk-method').value==='hsieh';for(const key of ['edgePolicy','axialAverageMm'])document.getElementById('fdk-'+key).disabled=!enabled;};
  document.getElementById('fdk-method').addEventListener('change',syncHsiehControls);
  for(const [k,v] of Object.entries(FDK_UI_FIELDS))document.getElementById('fdk-'+k).value=initial[k]??v;
  syncHsiehControls();
  const panel=document.createElement('section');panel.id='fdk-panel';panel.setAttribute('aria-labelledby','fdk-title');
  panel.innerHTML=`<div class="section-heading"><h2 id="fdk-title">${fdkText('展開図から3次元FBPへ','From acquired geometry to 3D FBP')}</h2></div>
  <p class="section-summary">${fdkText('球の投影データから局所3次元画像とSSPzを計算します。Hsieh法では、CBAの二次重みと、線形重みの参照結果を比較します。4点が揃う内部では、線形重みは従来RRIと一致します。検出器端の扱いは両者で共通です。','Reconstruct local 3D images and SSPz from sphere projections. The Hsieh path compares quadratic CBA weights with a linear reference. The linear reference equals conventional RRI in the four-sample interior; both use the same edge treatment.')}</p>
  <p id="fdk-summary" aria-live="polite"></p><p id="fdk-result-config"></p><div id="cba-comparison" hidden></div>
  <div class="chart-grid two">
  <article class="chart-card"><h3>${fdkText('取得列の展開図','Acquired detector-row geometry')}</h3><canvas id="fdk-geometry" width="1000" height="700"></canvas></article>
  <article class="chart-card"><h3>${fdkText('球から求めたSSPz','Sphere-derived SSPz')}</h3><canvas id="fdk-profile" width="1000" height="700"></canvas></article>
  <article class="chart-card"><h3>${fdkText('横断像：球の中心断面','Axial image through the sphere center')}</h3><canvas id="fdk-axial" width="900" height="800"></canvas></article>
  <article class="chart-card"><h3>${fdkText('冠状断像：球の中心断面','Coronal image through the sphere center')}</h3><canvas id="fdk-coronal" width="900" height="800"></canvas></article>
  </div><div id="fdk-difference-wrap" class="chart-card" hidden><h3>${fdkText('各SSPzと平均SSPzの差','Each SSPz minus the mean SSPz')}</h3><canvas id="fdk-difference" width="1200" height="650"></canvas><p>${fdkText('球の中心を共通の原点とし、各z位置の平均を引きます。FWHM中点での位置合わせは行いません。','The sphere center is the common origin; the pointwise mean is subtracted. Profiles are not aligned by their FWHM midpoints.')}</p></div>
  <div id="fdk-shape-wrap" class="chart-card shape-card" hidden>
    <h3>${fdkText('SSPzの形状変動分布','SSPz shape-variation distribution')}</h3>
    <p>${fdkText('各曲線のFWHM中点を0 mmに揃え、方法ごとの平均からの偏差を重ねます。両矢印は個々のFWHMの平均です。','Align each native FWHM midpoint to zero and overlay deviations from each method’s own mean. Double-headed arrows show the mean of individual FWHMs.')}</p>
    <div class="shape-canvas-wrap" tabindex="0"><canvas id="fdk-shape" width="1000" height="830"></canvas></div>
    <p id="fdk-shape-summary"></p>
    <button type="button" id="fdk-shape-png" class="secondary" disabled>${fdkText('分布図を600 dpi PNG保存','Save distribution as 600-dpi PNG')}</button>
    <details class="reading-details"><summary>${fdkText('分布図の読み方','Reading the distribution')}</summary><p>${fdkText('赤：CBA（単独計算ではFDK）、青：RRI。紫は同じ位置・偏差のビンに両者が存在することを表します。曲線全体や平均形状の一致ではありません。0.01 mm格子への線形補間、偏差ビン幅0.002、濃さは各ビンの割合の0.35乗で、色間で共通です。位置合わせと正規化の影響を含み、幅方向の拡大縮小は行いません。表示範囲は偏差を切り捨てないよう拡張します。','Red: CBA (FDK for a single-method calculation); blue: RRI. Purple means both occur in the same position–deviation bin, not agreement of whole curves or mean shapes. Linear sampling uses a 0.01-mm grid and deviation bins of 0.002. All channels use fraction^0.35. Alignment and normalization affect the distribution; widths are not rescaled. The deviation range expands to retain all values.')}</p></details>
  </div>
  <div class="action-row"><button type="button" id="fdk-xlsx" class="secondary" disabled>${fdkText('SSPz・平均差をExcel保存','Export SSPz and mean differences to Excel')}</button><button type="button" id="fdk-csv" class="secondary" disabled>SSPz CSV</button><button type="button" id="fdk-json" class="secondary" disabled>${fdkText('3次元画像・条件をJSON保存','Export 3D volume and conditions as JSON')}</button><button type="button" id="fdk-png" class="secondary" disabled>${fdkText('SSPzを600 dpi PNG保存','Save SSPz as 600-dpi PNG')}</button></div>
  <details class="reading-details"><summary>${fdkText('方法・解釈の範囲','Method and interpretation')}</summary><p>${fdkText('近似3次元FBPです。従来FDKと、投影を再配列して対向データを補間するHsieh法を選択できます。両者は焦点軌道・検出器列位置を共有します。TCOTの再現や厳密な広角コーンビーム逆変換ではありません。','Choose conventional FDK or the Hsieh path with rebinned conjugate interpolation. Both are approximate 3D FBP paths with the same source trajectory and detector-row geometry. Neither reproduces TCOT or implements exact wide-cone inversion.')}</p><p>${fdkText('対象は有限径の一様な球です。像中心に置いた、球の投影半径と等しい円形ROIの平均を各断面で求めます。ビーズ径の補正、ノイズ、焦点サイズ、隔壁、装置固有の重みは含みません。Hsieh法では、専用の平均化幅を画像領域に適用できます。0は平均化なしです。この幅を装置の実効スライス厚に一致させる校正は行っていません。従来の体軸方向モデルのT・FWとは別の設定です。','The object is a uniform finite sphere. Each axial profile sample is the mean of a centered circular ROI with the sphere radius. Bead deconvolution, noise, focal-spot size, septa and scanner-specific weights are excluded. For the Hsieh path, the dedicated averaging width applies a rectangular image-domain mean before normalization; zero disables it. This width is not calibrated to scanner FWHM. It is separate from the axial model T and FW controls.')}</p><p>${fdkText('表示は計算点を直線で結びます。最小値0・最大値1の正規化では、FBP由来の負の応答も基線移動されます。元のROI値はExcelに保持し、最大値のみで正規化する表示も選べます。FWHMとFWTMは選択した正規化曲線から求めます。画像の濃淡は負値を黒にし、全画像共通の最大値まで表示します。','Displayed curves join native samples with straight lines. Min–max normalization also shifts any negative FBP lobes. Raw ROI values are retained in Excel, and peak-only normalization is available. Widths use the selected normalized curves. Images clip negative values to black and share the volume maximum as white.')}</p><p>${fdkText('80～320列は計算可能な検出器構成です。列数だけで実機への妥当性を保証しません。ビュー数・開口分割数・チャネル幅・画像格子を変えて数値依存性を確認してください。','80–320 rows are supported computational configurations; row count alone does not establish scanner validity. Assess numerical dependence on views, aperture quadrature, channel width and image grids.')}</p><p><a href="FDK_METHOD.md">${fdkText('FDK：数式・座標・検証記録','FDK: equations, coordinates and verification')}</a> · <a href="https://doi.org/10.1364/JOSAA.1.000612">Feldkamp et al. (1984)</a> · <a href="https://doi.org/10.1088/0031-9155/49/13/011">Kudo et al. (2004)</a></p></details>`;
  panel.insertAdjacentHTML('beforeend',`<div id="cba-samples-wrap" class="chart-card" hidden><h3>${fdkText('補間に使うサンプルと重み：球の中心位置（画像平均化前）','Interpolation samples and weights before image averaging')}</h3><canvas id="cba-samples" width="1200" height="700"></canvas><p>${fdkText('青：RRI、赤：CBA。点の面積は正規化した重みです。横軸は球の中心からの距離。各対向ペアの補間候補を、再配列後の角度で示します。これは中心位置の局所的な重みであり、SSPz全体の寄与率ではありません。','Blue: RRI; red: CBA. Marker area represents normalized weight. The interpolation candidates in each conjugate pair are shown at the rebinned angle and relative to the sphere center. These are local weights at the central point, not total contributions to SSPz.')}</p></div><p><a href="CBA_METHOD.md">${fdkText('Hsieh法：計算方法と適用範囲','Hsieh path: equations and scope')}</a> · <a href="https://doi.org/10.1117/1.2746866" target="_blank" rel="noopener noreferrer">Hsieh et al. (2007)</a></p>`);
  document.querySelector('.control-shell').after(panel);
  const viewHelp=document.querySelector('#viewSamples')?.parentElement.querySelector('small');
  const axialViewHelp=viewHelp?.textContent;
  function modeChanged(){
    const on=pick.querySelector('select').value==='fdk';controls.hidden=!on;panel.hidden=!on;
    document.querySelectorAll('main > section').forEach(s=>{if(s!==panel&&!s.classList.contains('control-shell')&&!s.querySelector('#reference-title'))s.hidden=on;});
    for(const k of ['sliceThicknessMm','filterWidthMm','filterSamples','profileMode','reconstructionPath','zSamples'])document.getElementById(k)?.closest('label')?.toggleAttribute('hidden',on);
    const help=document.querySelector('#beamPitch')?.parentElement.querySelector('small');if(help)help.hidden=on;
    if(viewHelp)viewHelp.textContent=on?fdkText('1回転の実取得ビュー数です。周辺の小さな球はビュー数の影響を受けます。720・1440・2400で結果の変化を確認できます。','Acquired views per full turn. Small off-centre spheres are sensitive to view sampling; compare 720, 1440 and 2400 views.'):axialViewHelp;
    if(legacyUrlNote&&on)legacyUrlNote.hidden=true;
    if(!runButton.disabled)status.textContent=fdkText('計算モデルを選択しました。条件を確認して計算してください。','Model selected. Check the conditions and calculate.');
  }
  pick.querySelector('select').addEventListener('change',modeChanged);modeChanged();
  resetButton.addEventListener('click',()=>{pick.querySelector('select').value='axial';for(const [k,v] of Object.entries(FDK_UI_FIELDS))document.getElementById('fdk-'+k).value=v;modeChanged();});
  controls.querySelectorAll('[data-fdk-rows]').forEach(b=>b.addEventListener('click',()=>{if(runButton.disabled)return;form.elements.rows.value=b.dataset.fdkRows;form.elements.rowWidth.value=.5;form.elements.beamPitch.value=.5;status.textContent=fdkText('プリセットを設定しました。計算するを押してください。','Preset selected. Press Calculate.');}));
  document.getElementById('fdk-csv').onclick=()=>{const r=fdkResult;if(!r)return;downloadBlob(fdkFileStem(r)+'_SSPz.csv','\uFEFF'+fdkProfileRows(r).map(row=>row.join(',')).join('\r\n'));};
  document.getElementById('fdk-json').onclick=()=>{if(fdkResult)downloadBlob(fdkFileStem(fdkResult)+'_volume.json',JSON.stringify(fdkResult,(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v),'application/json');};
  document.getElementById('fdk-xlsx').onclick=async()=>{
    const r=fdkResult;if(!r)return;
    const sheets=[['Readme',[['Item','Value'],['version',r.model.version],...Object.entries(r.model),...Object.entries(r.config),['coordinate','z relative to sphere center (mm); no FWHM alignment'],['ROI','disk centered on sphere, radius = sphere radius'],['raw_profile','mean reconstructed attenuation in disk ROI'],['normalization_baseline',r.baseline],['width_definition','each normalized native profile; linear threshold crossings'],['volume_storage','JSON volume[z,y,x], x fastest; selected first phase only'],['precision','Unrounded Float64 values; display precision is not measurement accuracy']]],
      ['SSPz',fdkProfileRows(r)],
      ...fdkGroups(r).map(([name,g])=>[name+'_Mean_difference',[['z_position_mm','mean_normalized',...g.profiles.map((_,i)=>'difference_'+i)],...Array.from(g.z,(z,i)=>[z,g.mean[i],...g.meanDifference.map(p=>p[i])])]]),
      ['Widths',[['method','start_angle_rad','FWHM_mm','FWTM_mm','normalization_baseline'],...fdkGroups(r).flatMap(([name,g])=>g.profiles.map(p=>[name,p.phase,p.fwhm.width,p.fwtm.width,p.baseline]))]]];
    if(r.reference){sheets[0][1].push(['comparison','CBA and RRI share acquired projections, rebinning, filter, image grid and ROI; CBA power 2, RRI power 1'],['sample_weights_scope','first angle; sphere center voxel; local row interpolation only']);sheets.push(['Sample_weights',[['pair_angle_deg','source_angle_rad','conjugate_source_angle_rad','sample','z_relative_mm','CBA_weight','RRI_weight','CBA_weighted_distance_mm','RRI_weighted_distance_mm'],...r.sampleAudit.flatMap(v=>v.z.map((z,i)=>[v.relativeAngleDeg,v.beta,v.betaConjugate,i,z,v.weights[i],v.rriWeights[i],v.weightedDistance,v.rriWeightedDistance]))]]);}
    if(fdkShapeGroups){
      sheets[0][1].push(['shape_distribution','Each native FWHM midpoint translated to zero; no width rescaling; 0.01-mm linear common grid; each method own mean subtracted; bin width 0.002; intensity fraction^0.35'],['shape_arrow','Mean of individual native FWHMs; values and SD retain full precision in Widths']);
      for(const g of fdkShapeGroups){const a=g.analysis;
        sheets.push([g.name+'_Shape_aligned',[['z_position_mm','mean',...a.valid.map(i=>'aligned_'+i)],...Array.from(a.x,(z,i)=>[z,a.mean[i],...a.aligned.map(p=>p[i])])]]);
        sheets.push([g.name+'_Shape_deviation',[['z_position_mm',...a.valid.map(i=>'deviation_'+i)],...Array.from(a.x,(z,i)=>[z,...a.delta.map(p=>p[i])])]]);
      }
    }
    downloadBlob(fdkFileStem(r)+'_SSPz.xlsx',await SSPZShape.fromSheets(sheets),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  document.getElementById('fdk-shape-png').onclick=async()=>{if(!fdkShapeGroups)return;const c=document.createElement('canvas');c.width=Math.round(180/25.4*600);c.height=Math.round(c.width*.83);drawFdkShape(c);const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob(fdkFileStem(fdkResult)+'_shape_distribution_600dpi.png',await pngWithResolution(blob,600),'image/png');};
  document.getElementById('fdk-png').onclick=async()=>{if(!fdkResult)return;const c=document.createElement('canvas');c.width=Math.round(180/25.4*600);c.height=Math.round(c.width*.7);fdkDrawProfile(c,fdkResult);const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob(fdkFileStem(fdkResult)+'_SSPz_600dpi.png',await pngWithResolution(blob,600),'image/png');};
}
function fdkToggleDownloads(on){for(const id of ['fdk-xlsx','fdk-csv','fdk-json','fdk-png','fdk-shape-png'])document.getElementById(id).disabled=!on||(id==='fdk-shape-png'&&!fdkShapeGroups);}
function runFdkSimulation(){
  const params={...readParams(),...readFdkParams()};
  releaseWorker();clearError();lastResult=null;fdkResult=null;fdkShapeGroups=null;fdkToggleDownloads(false);setBusy(true);
  document.getElementById('fdk-summary').textContent=fdkText('3次元FBPを計算中…','Computing 3D FBP…');document.getElementById('fdk-result-config').textContent='';
  for(const canvas of document.querySelectorAll('#fdk-panel canvas'))drawCanvasStatus(canvas,'3D FBP',fdkText('計算中','Calculating'));
  document.getElementById('fdk-shape-wrap').hidden=true;document.getElementById('fdk-shape-summary').textContent='';
  document.getElementById('fdk-difference-wrap').hidden=true;document.getElementById('cba-samples-wrap').hidden=true;document.getElementById('cba-comparison').hidden=true;
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
      if(text.startsWith('FDK_DOMAIN')||text.startsWith('CBA_DOMAIN'))text=fdkText('幅を求める交点が表示範囲内にありません。再構成z範囲を広げてください。',text);
      if(text.startsWith('CBA_COVERAGE'))text=fdkText('Hsieh法に必要な投影または対向する列のサンプルが、検出器範囲から外れます。ピッチまたは再構成範囲を小さくしてください。',text);
      if(text.startsWith('CBA_VIEWS'))text=fdkText('Hsieh法では、1回転の取得ビュー数を偶数にしてください。',text);
      fail(text);
    }
  };worker.onerror=e=>fail(e.message);worker.postMessage({type:'fdk-run',params});
}
function fdkAxes(canvas,xmin,xmax,ymin,ymax,xlabel,ylabel,panel,yTicks=null,top=72){
  const ctx=canvas.getContext('2d'),s=canvas.width/1000,w=canvas.width,h=canvas.height;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.font=`${25*s}px Arial`;ctx.fillStyle='#000';ctx.textAlign='left';ctx.fillText(panel,18*s,30*s);
  const b={left:130*s,right:w-35*s,top:top*s,bottom:h-105*s};
  const x=v=>b.left+(v-xmin)/(xmax-xmin)*(b.right-b.left),y=v=>b.bottom-(v-ymin)/(ymax-ymin)*(b.bottom-b.top);
  const label=v=>Math.abs(v)<1e-10?'0':Math.abs(v)>=100?v.toFixed(0):Number(v.toFixed(2)).toString();
  ctx.font=`${23*s}px Arial`;
  for(const vx of SSPZShapeDisplay.ticks(xmin,xmax)){
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
function fdkDrawLines(a,xs,series,color=null){
  const {ctx,s,b,x,y}=a;ctx.save();ctx.beginPath();ctx.rect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.clip();
  for(const values of series){ctx.strokeStyle=color??(series.length>1?'rgba(209,59,50,.78)':'#d13b32');ctx.lineWidth=2*s;ctx.beginPath();values.forEach((v,i)=>i?ctx.lineTo(x(xs[i]),y(v)):ctx.moveTo(x(xs[i]),y(v)));ctx.stroke();}ctx.restore();
}
function fdkDrawProfile(canvas,r){
  const ymin=Math.min(0,...fdkGroups(r).flatMap(([,g])=>g.profiles.map(p=>Math.min(...p.profile)))),low=ymin<0?Math.floor(ymin*10)/10:0,a=fdkAxes(canvas,r.z[0],r.z.at(-1),low,1.03,'z position (mm)','Normalized SSPz','(b)',low<0?[low,0,.2,.4,.6,.8,1]:[0,.2,.4,.6,.8,1],r.reference?128:90);
  if(r.reference)fdkDrawLines(a,r.z,r.reference.profiles.map(p=>p.profile),'#0033bb');
  fdkDrawLines(a,r.z,r.profiles.map(p=>p.profile));
  const widths=r.profiles.map(p=>p.fwhm.width),mean=widths.reduce((s,v)=>s+v,0)/widths.length;
  const sd=widths.length>1?Math.sqrt(widths.reduce((s,v)=>s+(v-mean)**2,0)/(widths.length-1)):null;
  a.ctx.font=`${25*a.s}px Arial`;a.ctx.textAlign='center';a.ctx.fillStyle='#000';
  a.ctx.fillStyle='#b40000';a.ctx.fillText(`${r.reference?'CBA: ':''}FWHM ${fdkWidthAnnotation(mean,sd)}`,(a.b.left+a.b.right)/2,61*a.s);
  if(r.reference){const q=fdkWidthStats(r.reference);a.ctx.fillStyle='#0033bb';a.ctx.fillText(`RRI: FWHM ${fdkWidthAnnotation(q.mean,q.sd)}`,(a.b.left+a.b.right)/2,99*a.s);}
  const fw=r.profiles[0].fwhm,yy=a.y(.5);a.ctx.strokeStyle='#000';a.ctx.lineWidth=1.5*a.s;a.ctx.beginPath();a.ctx.moveTo(a.x(fw.left),yy);a.ctx.lineTo(a.x(fw.right),yy);
  for(const [v,d] of [[fw.left,1],[fw.right,-1]]){a.ctx.moveTo(a.x(v)+d*9*a.s,yy-5*a.s);a.ctx.lineTo(a.x(v),yy);a.ctx.lineTo(a.x(v)+d*9*a.s,yy+5*a.s);}a.ctx.stroke();
}
function fdkDrawGeometry(canvas,r){
  const c=r.config,feed=c.feed,step=2*Math.PI/c.viewSamples;
  const first=r.reference?r.acquisition.firstView:Math.ceil(((feed?2*Math.PI*r.zObject/feed:0)-Math.PI)/step-1e-12),beta0=c.phase+first*step;
  const viewCount=r.reference?r.acquisition.lastViewExclusive-first-1:c.viewSamples,angleExtent=360*viewCount/c.viewSamples;
  const betas=Array.from({length:viewCount+1},(_,i)=>beta0+i*step),curves=[];let limit=0;
  for(let row=0;row<c.rows;row++){
    const values=betas.map(beta=>{const L=Math.hypot(c.sourceRadius*Math.cos(beta)-c.radius,c.sourceRadius*Math.sin(beta));return feed*(beta-c.phase)/(2*Math.PI)+(row-(c.rows-1)/2)*c.rowWidth*L/c.sourceRadius-r.zObject;});
    limit=Math.max(limit,...values.map(Math.abs));curves.push(values);
  }
  limit=Math.ceil(limit/5)*5||5;
  const a=fdkAxes(canvas,-limit,limit,0,angleExtent,'Row position relative to sphere (mm)','Angle from first displayed view (°)','(a)');
  const {ctx,s}=a;ctx.save();ctx.beginPath();ctx.rect(a.b.left,a.b.top,a.b.right-a.b.left,a.b.bottom-a.b.top);ctx.clip();ctx.lineWidth=Math.max(.6,1.1- c.rows/800)*s;ctx.strokeStyle='#687780';ctx.globalAlpha=Math.max(.22,Math.min(.7,25/c.rows));
  for(const values of curves){ctx.beginPath();values.forEach((v,i)=>i?ctx.lineTo(a.x(v),a.y(360*i/c.viewSamples)):ctx.moveTo(a.x(v),a.y(0)));ctx.stroke();}
  ctx.globalAlpha=1;ctx.strokeStyle='#d55e00';ctx.lineWidth=2*s;ctx.setLineDash([7*s,5*s]);ctx.beginPath();ctx.moveTo(a.x(0),a.y(0));ctx.lineTo(a.x(0),a.y(angleExtent));ctx.stroke();ctx.restore();
  ctx.font=`${22*s}px Arial`;ctx.fillStyle='#000';ctx.textAlign='center';ctx.fillText(`${c.rows} rows / ${r.reference?'all acquired views used':'central-slice full turn'}`,(a.b.left+a.b.right)/2,49*s);
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
function drawFdkShape(canvas){SSPZShapeDisplay.draw(canvas,fdkShapeGroups,{title:`FWHM-midpoint aligned; r = ${fdkResult.config.radius} mm; n = ${fdkResult.profiles.length}`,panel:'(f)'});}
function renderFdkResult(r){
  const c=r.config;document.getElementById('fdk-summary').textContent=r.reference?fdkText('Hsieh法：CBAとRRIの比較が完了しました。投影・前処理・画像格子は共通です。画像とSSPz曲線内の矢印はCBAの最初の角度条件です。','Hsieh comparison complete: CBA and RRI share projections, preprocessing and image grids. Images and the arrow within the SSPz curves show CBA at the first start angle.'):fdkText('再構成完了。各断面の全360°の取得範囲を確認しました。','Reconstruction complete. Full-turn acquisition coverage was checked for every slice.');
  document.getElementById('fdk-result-config').textContent=(r.reference?fdkText('画像平均化幅 ','Image averaging width ')+(c.axialAverageMm??0).toFixed(2)+' mm / ':'')+`${c.rows} ${fdkText('列','rows')} × ${c.rowWidth.toFixed(2)} mm / pitch ${c.beamPitch} / r = ${c.radius} mm / ${c.viewSamples} views/turn / sphere ${c.sphereDiameter.toFixed(2)} mm / ${r.profiles.length} ${fdkText('角度条件','start angles')} / ${fdkText('最初の角度条件：','first angle: ')}FWTM ${r.fwtm.width.toFixed(2)} mm`+(r.profiles.length>1?fdkText('。FWHMは個々の幅の平均±SD。SSPz曲線内の矢印・画像・展開図は最初の角度条件です。','. FWHM: mean ± SD of individual widths. The arrow within SSPz curves, images and geometry show the first angle.'):'');
  fdkDrawGeometry(document.getElementById('fdk-geometry'),r);fdkDrawProfile(document.getElementById('fdk-profile'),r);fdkDrawImage(document.getElementById('fdk-axial'),r,false);fdkDrawImage(document.getElementById('fdk-coronal'),r,true);
  const comparison=document.getElementById('cba-comparison');comparison.hidden=!r.reference;document.getElementById('cba-samples-wrap').hidden=!r.reference;
  if(r.reference){comparison.innerHTML=`<table><caption>${fdkText('各SSPzから求めたFWHM','FWHM computed from individual SSPz profiles')}</caption><thead><tr><th>${fdkText('補間方法','Method')}</th><th>${fdkText('平均 (mm)','Mean (mm)')}</th><th>SD (mm)</th><th>${fdkText('範囲 (mm)','Range (mm)')}</th></tr></thead><tbody>${fdkGroups(r).map(([name,g])=>{const q=fdkWidthStats(g);return `<tr><td>${name}</td><td>${q.mean.toFixed(2)}</td><td>${q.sd===null?'—':q.sd<.001?'&lt; 0.001':q.sd.toFixed(3)}</td><td>${q.min.toFixed(2)}–${q.max.toFixed(2)}</td></tr>`;}).join('')}</tbody></table>`;cbaDrawSamples(document.getElementById('cba-samples'),r);}
  document.getElementById('fdk-shape-wrap').hidden=false;
  try {
    fdkShapeGroups=SSPZShapeDisplay.fromFdk(r);drawFdkShape(document.getElementById('fdk-shape'));
    document.getElementById('fdk-shape-summary').textContent=fdkShapeGroups.map(g=>`${g.name}: ${g.analysis.valid.length} / ${r.profiles.length}`).join(' · ')+fdkText(' 条件。濃さ：ビン内の割合。',' conditions. Intensity: fraction per bin.')+(r.profiles.length===1?fdkText('1条件では変動を評価できません。条件数を増やしてください。',' Variation cannot be assessed from one condition; increase the number of start angles.'):'');
  }catch(error){fdkShapeGroups=null;document.getElementById('fdk-shape-summary').textContent=error.message;}
  document.getElementById('fdk-difference-wrap').hidden=r.profiles.length===1;
  if(r.profiles.length>1){const limit=Math.ceil(Math.max(.02,...fdkGroups(r).flatMap(([,g])=>g.meanDifference.map(p=>Math.max(...p.map(Math.abs)))))/.02)*.02,a=fdkAxes(document.getElementById('fdk-difference'),r.z[0],r.z.at(-1),-limit,limit,'z position (mm)','SSPz minus mean','(e)');if(r.reference)fdkDrawLines(a,r.z,r.reference.meanDifference,'#0033bb');fdkDrawLines(a,r.z,r.meanDifference);if(r.reference){a.ctx.textAlign='center';a.ctx.fillStyle='#000';a.ctx.fillText('Blue: RRI / red: CBA; each minus its own mean',(a.b.left+a.b.right)/2,49*a.s);}}
}
function cbaDrawSamples(canvas,r){
  const audit=r.sampleAudit,limit=Math.ceil(Math.max(...audit.flatMap(q=>q.z.map(Math.abs)))*10)/10;
  const a=fdkAxes(canvas,-limit,limit,0,180,'Sample z relative to sphere (mm)','Rebinned angle within pair sweep (°)','(g)');
  const {ctx,s}=a;ctx.save();ctx.beginPath();ctx.rect(a.b.left,a.b.top,a.b.right-a.b.left,a.b.bottom-a.b.top);ctx.clip();
  const stride=Math.max(1,Math.ceil(audit.length/45));
  audit.forEach((q,j)=>{if(j%stride)return;for(let i=0;i<4;i++){
    const yy=a.y(q.relativeAngleDeg);ctx.strokeStyle='#0033bb';ctx.lineWidth=1.4*s;ctx.beginPath();ctx.arc(a.x(q.z[i]),yy,10*s*Math.sqrt(q.rriWeights[i]),0,2*Math.PI);ctx.stroke();
    ctx.fillStyle='rgba(209,59,50,.78)';ctx.beginPath();ctx.arc(a.x(q.z[i]),yy,10*s*Math.sqrt(q.weights[i]),0,2*Math.PI);ctx.fill();
  }});ctx.restore();ctx.textAlign='center';ctx.fillStyle='#000';ctx.font=`${22*s}px Arial`;ctx.fillText('Blue outline: RRI / red fill: CBA',(a.b.left+a.b.right)/2,49*s);
}
