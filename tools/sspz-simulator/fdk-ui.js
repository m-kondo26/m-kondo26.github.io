// Integrated UI for the browser worker, using the existing shared form,
// geometry conventions, XLSX writer and PNG resolution metadata.
const FDK_UI_FIELDS={method:'hsieh',edgePolicy:'available',axialAverageMm:0,objectModel:'point',channelWidth:.25,
  xyExtent:1.5,xySamples:17,zExtent:3,zStep:.05,phaseCount:360,phase:0,state:0,normalization:'minmax'};
let fdkResult=null;
let fdkShapeGroups=null;
const fdkGroups=r=>r.reference?[['CBA',r],['RRI',r.reference]]:[['FDK',r]];
const fdkFileStem=r=>(r.reference?'Hsieh_CBA_RRI':'FDK')+'_point_T'+(r.config.sliceThicknessMm??r.config.axialAverageMm)+'mm';
function fdkWidthStats(r){const v=r.profiles.map(p=>p.fwhm.width),mean=v.reduce((s,x)=>s+x,0)/v.length;return {mean,sd:v.length>1?Math.sqrt(v.reduce((s,x)=>s+(x-mean)**2,0)/(v.length-1)):null,min:Math.min(...v),max:Math.max(...v)};}
const fdkWidthAnnotation=(mean,sd)=>sd===null?`${mean.toFixed(2)} mm`:sd<.001?`${mean.toFixed(2)} mm; SD < 0.001 mm`:`${mean.toFixed(2)} ± ${sd.toFixed(3)} mm`;
function fdkProfileRows(r){const groups=fdkGroups(r);return [['z_position_mm',...groups.flatMap(([name,g])=>g.profiles.flatMap((_,i)=>[name+'_raw_'+i,name+'_normalized_'+i]))],...Array.from(r.z,(z,i)=>[z,...groups.flatMap(([,g])=>g.profiles.flatMap(p=>[p.raw[i],p.profile[i]]))])];}
const fdkText=(ja,en)=>document.documentElement.lang.startsWith('en')?en:ja;
function syncFdkMethodControls(){const method=document.getElementById('fdk-method');if(!method)return;for(const key of ['edgePolicy'])document.getElementById('fdk-'+key).disabled=runButton.disabled||method.value!=='hsieh';}
function readFdkParams(){
  const out={computationModel:document.querySelector('#computationModel')?.value??'axial'};
  if(out.computationModel!=='fdk')return out;
  for(const [k,v] of Object.entries(FDK_UI_FIELDS)){
    const e=document.getElementById('fdk-'+k);out[k]=e?(typeof v==='number'?Number(e.value):e.value):v;
  }
  out.axialAverageMm=Number(form.elements.namedItem('sliceThicknessMm').value);
  out.objectModel='point';
  out.thicknessMapping='configured-rectangular';
  out.phaseCount=360;
  return out;
}
function writeFdkUrl(url,p){
  if(p.computationModel!=='fdk')return;
  url.searchParams.set('model','fdk');
  for(const [k,v] of Object.entries(FDK_UI_FIELDS))if(k!=='axialAverageMm')url.searchParams.set('fdk_'+k,p[k]??v);
}
function fdkParamsFromUrl(q){
  const out={computationModel:q.get('model')==='fdk'?'fdk':'axial'};
  if(out.computationModel!=='fdk')return out;
  for(const [k,v] of Object.entries(FDK_UI_FIELDS))out[k]=q.has('fdk_'+k)?(typeof v==='number'?Number(q.get('fdk_'+k)):q.get('fdk_'+k)):v;
  out.phaseCount=360;
  out.legacySphereInput=q.get('fdk_objectModel')!=='point';
  out.objectModel='point';
  return out;
}
function initializeFdkUi(initial){
  const pick=document.createElement('label');pick.innerHTML=fdkText('計算モデル','Calculation model')+`<select id="computationModel" name="computationModel"><option value="axial">${fdkText('展開図・体軸方向の補間モデル','Unwrapped geometry / axial interpolation')}</option><option value="fdk">${fdkText('3次元フィルタ逆投影（FBP）','3D filtered backprojection (FBP)')}</option></select>`;
  form.prepend(pick);pick.querySelector('select').value=initial.computationModel??'axial';
  const controls=document.createElement('div');controls.id='fdk-controls';controls.className='fdk-controls';
  const num=(k,ja,en,min,max,step,help='')=>`<label>${fdkText(ja,en)}<input id="fdk-${k}" name="${k}" type="number" min="${min}" max="${max}" step="${step}" value="${FDK_UI_FIELDS[k]}"${help?` aria-describedby="fdk-${k}-help"`:''}>${help?`<small class="field-help" id="fdk-${k}-help">${help}</small>`:''}</label>`;
  const sel=(k,ja,en,options)=>`<label>${fdkText(ja,en)}<select id="fdk-${k}" name="${k}">${options.map(([v,t])=>`<option value="${v}" ${v===FDK_UI_FIELDS[k]?'selected':''}>${t}</option>`).join('')}</select></label>`;
  controls.innerHTML=`<p class="section-summary">${fdkText('上の共通条件を使用し、球径を含まない理想的な点への応答を計算します。','Shared controls apply. The object is an ideal point, with no finite sphere diameter.')}</p>
  <div id="reconstruction-method-guide" class="reconstruction-method-guide">
    <dl>
      <dt><span lang="en">Conjugate backprojection algorithm</span> (CBA)</dt>
      <dd>${fdkText('対向データを用いる逆投影法。対向する投影の検出器列データをまとめて重み付けします。','Jointly weights detector-row samples from conjugate projections during backprojection.')}</dd>
      <dt><span lang="en">Row-to-row interpolation</span> (RRI)</dt>
      <dd>${fdkText('検出器列間の線形補間。各投影で隣り合う2列のデータを線形補間します。','Linearly interpolates data from two adjacent detector rows within each projection.')}</dd>
    </dl>
    <p>${fdkText('このサイトでは、両者とも3次元逆投影に用います。同じ投影・前処理から、CBAの二乗重みとRRI相当の線形重みを比較します。','Both are used within 3D backprojection here. Identical projections and preprocessing are used to compare squared CBA weights with a linear-weight RRI reference.')}</p>
    <p class="method-source"><a href="https://doi.org/10.1117/1.2746866" target="_blank" rel="noopener noreferrer">Hsieh et al. (2007)</a> · <a href="CBA_METHOD.md">${fdkText('数式・検出器端の処理','Equations and detector-edge treatment')}</a></p>
  </div>
  <div class="parameter-grid">
  ${sel('method','3次元再構成法','3D reconstruction method',[['fdk',fdkText('従来のヘリカルFDK近似','Original helical FDK reference')],['hsieh',fdkText('Hsieh法：CBA / RRI 比較','Hsieh: CBA / RRI comparison')]])}
  ${sel('edgePolicy','Hsieh法の検出器端処理','Hsieh detector-edge treatment',[['available',fdkText('取得済みの列で正規化','Normalize acquired rows')],['strict',fdkText('4点が揃う場合のみ','Require all four row samples')]])}
  </div>
  <details class="reading-details"><summary>${fdkText('3次元計算・画像表示の詳細設定','3D numerical and image-display settings')}</summary>
  <div class="parameter-grid">
  <input id="fdk-axialAverageMm" type="hidden" value="1"><input id="fdk-objectModel" type="hidden" value="point">
  ${num('channelWidth','面内チャネル幅：回転中心換算 (mm)','Transaxial channel width at isocenter (mm)',.05,1,.05)}
  ${num('zStep','再構成z間隔 (mm)','Reconstruction z spacing (mm)',.01,.2,.01)}
  ${num('zExtent','SSPzの計算範囲：中心から± (mm)','SSPz calculation half-range (mm)',1,20,.5,fdkText('3なら−3～+3 mmを計算します。厚みではなく、SSPzの裾まで含める計算区間です。','A value of 3 covers −3 to +3 mm. This is the profile interval, including its tails, rather than slice thickness.'))}
  ${num('xyExtent','局所画像範囲：中心から± (mm)','Local image half-range (mm)',.5,10,.5)}
  ${sel('xySamples','局所画像の行列数','Local image matrix',[[17,'17 × 17'],[33,'33 × 33'],[65,'65 × 65']])}
  <input type="hidden" id="fdk-phaseCount" value="360"><p>${fdkText('回転開始角度：1°間隔・全360条件を自動計算','Start angles: automatically calculate all 360 conditions at 1° increments')}</p>
  ${num('phase','z = 0でのX線源角度 (rad)','Source angle at z = 0 (rad)',0,6.28318530718,.01)}
  ${num('state','物体のz位置／1回転寝台移動量','Object z / table feed per turn',0,1,.01)}
  ${sel('normalization','表示と幅測定の正規化','Normalization for display and widths', [['minmax',fdkText('最小値0・最大値1','Minimum 0, maximum 1')],['peak',fdkText('最大値1（負値を保持）','Peak 1 (retain negative values)')]])}
  </div><p class="model-note">${fdkText('各断面に1回転分を使用します。Hsieh法は同じ前処理・同じ投影からCBAとRRIを計算します。取得ビュー数は偶数にしてください。取得済みの列で正規化する設定では、検出器外の列を除いて対向データと重みを正規化します。両方向とも支持を失う場合は停止します。','Each slice uses one turn. The Hsieh path computes CBA and RRI from identical projections and preprocessing. Use an even view count. The acquired-row option omits unavailable rows and normalizes the remaining conjugate weights. Computation stops if neither direction has support.')}</p></details>`;
  form.append(controls);
  if(initial.computationModel==='fdk'&&(initial.legacySphereInput||initial.objectModel!=='point')){
    const note=document.createElement('p');note.id='fdk-point-migration';note.className='model-note';
    note.textContent=fdkText('旧条件を読み込みました。今回から球径を含まない点応答を計算します。以前の有限球の結果とは異なります。','Older settings loaded. Calculations now use an ideal point, without sphere diameter. Results differ from the former finite-sphere response.');controls.prepend(note);
  }
  const syncHsiehControls=syncFdkMethodControls;
  document.getElementById('fdk-method').setAttribute('aria-describedby','reconstruction-method-guide');
  document.getElementById('fdk-method').addEventListener('change',syncHsiehControls);
  for(const [k,v] of Object.entries(FDK_UI_FIELDS))document.getElementById('fdk-'+k).value=initial[k]??v;
  document.getElementById('fdk-objectModel').value='point';
  document.getElementById('fdk-phaseCount').value=360;
  syncHsiehControls();updateInputDecorations();
  const panel=document.createElement('section');panel.id='fdk-panel';panel.setAttribute('aria-labelledby','fdk-title');
  panel.innerHTML=`<div class="section-heading"><h2 id="fdk-title">${fdkText('展開図から3次元FBPへ','From acquired geometry to 3D FBP')}</h2></div>
  <p class="section-summary">${fdkText('点の投影データから局所3次元画像とモデルSSPzを計算します。Hsieh法では、CBAの二乗重みと、線形重みの参照結果を比較します。4点が揃う内部では、線形重みは従来RRIと一致します。検出器端の扱いは両者で共通です。','Reconstruct local 3D images and model SSPz from ideal-point projections. The Hsieh path compares squared CBA weights with a linear reference. The linear reference equals conventional RRI in the four-sample interior; both use the same edge treatment.')} <a href="#reconstruction-method-guide">${fdkText('CBA・RRIの意味','CBA and RRI definitions')}</a></p>
  <p id="fdk-summary" aria-live="polite"></p><p id="fdk-result-config"></p><div id="cba-comparison" hidden></div>
  <div class="chart-grid two">
  <article class="chart-card"><h3>${fdkText('取得列の展開図','Acquired detector-row geometry')}</h3><canvas id="fdk-geometry" width="1000" height="700"></canvas></article>
  <article class="chart-card"><h3>${fdkText('モデルSSPz：点への応答','Model SSPz: point response')}</h3><canvas id="fdk-profile" width="1000" height="700"></canvas></article>
  <article class="chart-card"><h3>${fdkText('横断像：点の位置断面','Axial image through the object point')}</h3><canvas id="fdk-axial" width="900" height="800"></canvas></article>
  <article class="chart-card"><h3>${fdkText('冠状断像：点の位置断面','Coronal image through the object point')}</h3><canvas id="fdk-coronal" width="900" height="800"></canvas></article>
  </div><div id="fdk-difference-wrap" class="chart-card" hidden><h3>${fdkText('各SSPzと平均SSPzの差','Each SSPz minus the mean SSPz')}</h3><canvas id="fdk-difference" width="1200" height="650"></canvas><p>${fdkText('点の位置を共通の原点とし、各z位置の平均を引きます。FWHM中点での位置合わせは行いません。','The object point is the common origin; the pointwise mean is subtracted. Profiles are not aligned by their FWHM midpoints.')}</p></div>
  <div id="fdk-shape-wrap" class="chart-card shape-card" hidden>
    <h3>${fdkText('SSPzの形状変動分布','SSPz shape-variation distribution')}</h3>
    <p>${fdkText('各曲線のFWHM中点を0 mmに揃え、方法ごとの平均からの偏差を重ねます。両矢印は個々のFWHMの平均です。','Align each native FWHM midpoint to zero and overlay deviations from each method’s own mean. Double-headed arrows show the mean of individual FWHMs.')}</p>
    <div class="shape-canvas-wrap" tabindex="0"><canvas id="fdk-shape" width="1000" height="830"></canvas></div>
    <p id="fdk-shape-summary"></p>
    <button type="button" id="fdk-shape-png" class="secondary" disabled>${fdkText('分布図を600 dpi PNG保存','Save distribution as 600-dpi PNG')}</button>
    <details class="reading-details"><summary>${fdkText('分布図の読み方','Reading the distribution')}</summary><p>${fdkText('赤：CBA（単独計算ではFDK）、青：RRI。紫は同じ位置・偏差のビンに両者が存在することを表します。曲線全体や平均形状の一致ではありません。0.01 mm格子への線形補間、偏差ビン幅0.002、濃さは各ビンの割合の0.35乗で、色間で共通です。位置合わせと正規化の影響を含み、幅方向の拡大縮小は行いません。表示範囲は偏差を切り捨てないよう拡張します。','Red: CBA (FDK for a single-method calculation); blue: RRI. Purple means both occur in the same position–deviation bin, not agreement of whole curves or mean shapes. Linear sampling uses a 0.01-mm grid and deviation bins of 0.002. All channels use fraction^0.35. Alignment and normalization affect the distribution; widths are not rescaled. The deviation range expands to retain all values.')}</p></details>
  </div>
  <div class="action-row"><button type="button" id="fdk-xlsx" class="secondary" disabled>${fdkText('SSPz・平均差をExcel保存','Export SSPz and mean differences to Excel')}</button><button type="button" id="fdk-csv" class="secondary" disabled>SSPz CSV</button><button type="button" id="fdk-json" class="secondary" disabled>${fdkText('3次元画像・条件をJSON保存','Export 3D volume and conditions as JSON')}</button><button type="button" id="fdk-png" class="secondary" disabled>${fdkText('SSPzを600 dpi PNG保存','Save SSPz as 600-dpi PNG')}</button></div>
  <details class="reading-details"><summary>${fdkText('方法・解釈の範囲','Method and interpretation')}</summary><p>${fdkText('近似3次元FBPです。従来FDKと、投影を再配列して対向データを補間するHsieh法を選択できます。両者は焦点軌道・検出器列位置を共有します。TCOTの再現や厳密な広角コーンビーム逆変換ではありません。','Choose conventional FDK or the Hsieh path with rebinned conjugate interpolation. Both are approximate 3D FBP paths with the same source trajectory and detector-row geometry. Neither reproduces TCOT or implements exact wide-cone inversion.')}</p><p>${fdkText('対象は大きさを持たない理想的な点です。検出器開口への投影は解析的に積分し、再構成像の同じ面内位置から体軸方向の応答を取り出します。球径と球径に依存するROI平均は含みません。2Dと対象の体軸方向の厚みを0に揃えていますが、3Dでは面内の検出器開口・フィルタ・逆投影も含むため、両者の応答が同じになるとは限りません。FDK・CBA・RRIのいずれも、設定スライス厚Tを幅とする矩形平均化を再構成画像に適用し、その後にSSPzを正規化します。平均化には必要な周辺断面も再構成して用います。FWHMをTに一致させる調整や実機のスライス厚の校正は行いません。','The object is a unit-integral ideal point, analytically integrated over each detector aperture. The profile follows a fixed transverse position through the reconstructed point (an axial section of the 3D PSF); no sphere-size blur or sphere-dependent ROI averaging is included. Both 2D and 3D use zero axial object extent; 3D additionally includes transaxial aperture, filtering and backprojection, so their responses need not coincide. FDK, CBA and RRI all apply an image-domain rectangular average of width T before SSPz normalization, reconstructing the required surrounding slices. FWHM is not fitted to T, and no scanner thickness calibration is performed.')}</p><p>${fdkText('表示は計算点を直線で結びます。最小値0・最大値1の正規化では、FBP由来の負の応答も基線移動されます。正規化前の点応答はExcelに保持し、最大値のみで正規化する表示も選べます。FWHMとFWTMは選択した正規化曲線から求めます。画像の濃淡は負値を黒にし、全画像共通の最大値まで表示します。','Displayed curves join native samples with straight lines. Min–max normalization also shifts any negative FBP lobes. Raw point responses are retained in Excel, and peak-only normalization is available. Widths use the selected normalized curves. Images clip negative values to black and share the volume maximum as white.')}</p><p>${fdkText('80～320列は計算可能な検出器構成です。列数だけで実機への妥当性を保証しません。ビュー数・チャネル幅・再構成z間隔を変えて数値依存性を確認してください。','80–320 rows are supported computational configurations; row count alone does not establish scanner validity. Assess numerical dependence on views, channel width and reconstruction z spacing.')}</p><p><a href="POINT_RESPONSE_METHOD.md">${fdkText('点応答の定義・2Dとの関係','Point-response definition and relationship to 2D')}</a> · <a href="FDK_METHOD.md">${fdkText('FDK：数式・座標・検証記録','FDK: equations, coordinates and verification')}</a> · <a href="https://doi.org/10.1364/JOSAA.1.000612">Feldkamp et al. (1984)</a> · <a href="https://doi.org/10.1088/0031-9155/49/13/011">Kudo et al. (2004)</a></p></details>`;
  panel.insertAdjacentHTML('beforeend',`<div id="cba-samples-wrap" class="chart-card" hidden><h3>${fdkText('補間に使うサンプルと重み：点の位置位置（画像平均化前）','Interpolation samples and weights before image averaging')}</h3><canvas id="cba-samples" width="1200" height="700"></canvas><p>${fdkText('青：RRI、赤：CBA。点の面積は正規化した重みです。横軸は点の位置からの距離。各対向ペアの補間候補を、再配列後の角度で示します。これは中心位置の局所的な重みであり、SSPz全体の寄与率ではありません。','Blue: RRI; red: CBA. Marker area represents normalized weight. The interpolation candidates in each conjugate pair are shown at the rebinned angle and relative to the object point. These are local weights at the central point, not total contributions to SSPz.')}</p></div><p><a href="CBA_METHOD.md">${fdkText('Hsieh法：計算方法と適用範囲','Hsieh path: equations and scope')}</a> · <a href="https://doi.org/10.1117/1.2746866" target="_blank" rel="noopener noreferrer">Hsieh et al. (2007)</a></p>`);
  document.querySelector('.control-shell').after(panel);
  initializeFdkWorkflow(panel);
  const viewHelp=document.querySelector('#viewSamples')?.parentElement.querySelector('small');
  const axialViewHelp=viewHelp?.textContent;
  function modeChanged(){
    const on=pick.querySelector('select').value==='fdk';controls.hidden=!on;panel.hidden=!on;
    document.querySelectorAll('main > section').forEach(s=>{if(s!==panel&&!s.classList.contains('control-shell')&&!s.querySelector('#reference-title'))s.hidden=on;});
    for(const k of ['filterSamples','profileMode','reconstructionPath','zSamples'])document.getElementById(k)?.closest('label')?.toggleAttribute('hidden',on);
    const help=document.querySelector('#beamPitch')?.parentElement.querySelector('small');if(help)help.hidden=on;
    if(viewHelp)viewHelp.textContent=on?fdkText('1回転の実取得ビュー数です。周辺の点応答はビュー数の影響を受けます。720・1440・2400で結果の変化を確認できます。','Acquired views per full turn. Off-centre point responses are sensitive to view sampling; compare 720, 1440 and 2400 views.'):axialViewHelp;

    if(!runButton.disabled)status.textContent=fdkText('計算モデルを選択しました。条件を確認して計算してください。','Model selected. Check the conditions and calculate.');
  }
  pick.querySelector('select').addEventListener('change',modeChanged);modeChanged();
  resetButton.addEventListener('click',()=>{pick.querySelector('select').value='axial';for(const [k,v] of Object.entries(FDK_UI_FIELDS))document.getElementById('fdk-'+k).value=v;modeChanged();});
  document.getElementById('fdk-csv').onclick=()=>{const r=fdkResult;if(!r)return;downloadBlob(fdkFileStem(r)+'_SSPz.csv','\uFEFF'+fdkProfileRows(r).map(row=>row.join(',')).join('\r\n'));};
  document.getElementById('fdk-json').onclick=()=>{if(fdkSelectedResult)downloadBlob(fdkFileStem(fdkResult)+'_angle-'+selectedStateIndex+'_volume.json',JSON.stringify({seriesConfig:fdkResult.config,selectedIndex:selectedStateIndex,result:fdkSelectedResult},(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v),'application/json');};
  document.getElementById('fdk-xlsx').onclick=async()=>{
    const r=fdkResult;if(!r)return;
    const sheets=[['Readme',[['Item','Value'],['version',r.model.version],...Object.entries(r.model),...Object.entries(r.config).filter(([key])=>!['sphereDiameter','apertureSamples'].includes(key)),['coordinate','z relative to object point (mm); no FWHM alignment'],['readout','fixed transverse object location; one point sample per z; no disk ROI average'],['raw_profile','axial section of reconstructed unit-integral 3D point response, after configured axial averaging'],['normalization_baseline',r.baseline],['width_definition','each normalized native profile; linear threshold crossings'],['volume_storage','JSON volume[z,y,x], x fastest; selected first phase only'],['precision','Unrounded Float64 values; display precision is not measurement accuracy']]],
      ['SSPz',fdkProfileRows(r)],
      ...fdkGroups(r).map(([name,g])=>[name+'_Mean_difference',[['z_position_mm','mean_normalized',...g.profiles.map((_,i)=>'difference_'+i)],...Array.from(g.z,(z,i)=>[z,g.mean[i],...g.meanDifference.map(p=>p[i])])]]),
      ['Widths',[['method','start_angle_rad','FWHM_mm','FWTM_mm','normalization_baseline'],...fdkGroups(r).flatMap(([name,g])=>g.profiles.map(p=>[name,p.phase,p.fwhm.width,p.fwtm.width,p.baseline]))]]];
    if(r.reference){sheets[0][1].push(['CBA','Conjugate backprojection algorithm: jointly weighted conjugate detector-row samples'],['RRI','Row-to-row interpolation: linear interpolation between adjacent detector rows; matched reference with shared edge extension'],['comparison','CBA and RRI share acquired projections, rebinning, filter, image grid and fixed-point readout; CBA power 2, RRI power 1'],['sample_weights_scope','first angle; object point voxel; local row interpolation only']);sheets.push(['Sample_weights',[['pair_angle_deg','source_angle_rad','conjugate_source_angle_rad','sample','z_relative_mm','CBA_weight','RRI_weight','CBA_weighted_distance_mm','RRI_weighted_distance_mm'],...r.sampleAudit.flatMap(v=>v.z.map((z,i)=>[v.relativeAngleDeg,v.beta,v.betaConjugate,i,z,v.weights[i],v.rriWeights[i],v.weightedDistance,v.rriWeightedDistance]))]]);}
    if(fdkShapeGroups){
      sheets[0][1].push(['shape_distribution','Each native FWHM midpoint translated to zero; no width rescaling; 0.01-mm linear common grid; each method own mean subtracted; bin width 0.002; intensity fraction^0.35'],['shape_arrow','Mean of individual native FWHMs; values and SD retain full precision in Widths']);
      for(const g of fdkShapeGroups){const a=g.analysis;
        sheets.push([g.name+'_Shape_aligned',[['z_position_mm','mean',...a.valid.map(i=>'aligned_'+i)],...Array.from(a.x,(z,i)=>[z,a.mean[i],...a.aligned.map(p=>p[i])])]]);
        sheets.push([g.name+'_Shape_deviation',[['z_position_mm',...a.valid.map(i=>'deviation_'+i)],...Array.from(a.x,(z,i)=>[z,...a.delta.map(p=>p[i])])]]);
      }
    }
    addFdkWorkflowSheets(sheets);
    downloadBlob(fdkFileStem(r)+'_SSPz.xlsx',await SSPZShape.fromSheets(sheets),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  document.getElementById('fdk-shape-png').onclick=async()=>{if(!fdkShapeGroups)return;const c=document.createElement('canvas');c.width=Math.round(180/25.4*600);c.height=Math.round(c.width*.83);drawFdkShape(c);const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob(fdkFileStem(fdkResult)+'_shape_distribution_600dpi.png',await pngWithResolution(blob,600),'image/png');};
  document.getElementById('fdk-png').onclick=async()=>{if(!fdkResult)return;const c=document.createElement('canvas');c.width=Math.round(180/25.4*600);c.height=Math.round(c.width*.7);fdkDrawProfile(c,fdkResult);const blob=await new Promise(resolve=>c.toBlob(resolve));downloadBlob(fdkFileStem(fdkResult)+'_SSPz_600dpi.png',await pngWithResolution(blob,600),'image/png');};
}
function fdkToggleDownloads(on){for(const id of ['fdk-xlsx','fdk-csv','fdk-json','fdk-png','fdk-shape-png'])document.getElementById(id).disabled=!on||(id==='fdk-shape-png'&&!fdkShapeGroups);fdkWorkflowAvailability(on);}
function runFdkSimulation(){
  const params={...readParams(),...readFdkParams()};
  fdkRunParams=params;
  releaseWorker();clearError();lastResult=null;fdkResult=null;fdkSelectedResult=null;fdkInspectionRequest++;clearTimeout(fdkInspectionTimer);fdkShapeGroups=null;fdkToggleDownloads(false);setBusy(true);
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
      fdkResult=m.result;renderFdkResult(fdkResult);progress.value=1;setBusy(false);fdkToggleDownloads(true);status.textContent=fdkText('完了 ','Completed ')+((performance.now()-startedAt)/1000).toFixed(1)+' s / 360 angles';selectFdkState(selectedStateIndex,true);
    }else if(m.type==='fdk-inspection'){if(m.requestId===fdkInspectionRequest){fdkSelectedResult=m.result;renderFdkSelected();}}
    else if(m.type==='fdk-inspection-error'){if(m.requestId===fdkInspectionRequest){document.getElementById('fdk-inspection-status').textContent=m.message;}}
    else if(m.type==='cancelled'){setBusy(false);document.getElementById('fdk-summary').textContent=fdkText('計算を中止しました','Calculation cancelled');status.textContent=document.getElementById('fdk-summary').textContent;for(const c of document.querySelectorAll('#fdk-panel canvas'))drawCanvasStatus(c,'3D FBP',status.textContent,'cancelled');releaseWorker();}
    else if(m.type==='error'){
      let text=m.message;
      if(text.startsWith('FDK_COVERAGE'))text=fdkText('この条件では、点の投影または局所画像に必要な連続360°のデータが検出器範囲から外れます。ピッチまたは再構成範囲を小さくしてください。展開図・体軸方向モデルは引き続き選択できます。',text);
      if(text.startsWith('FDK_DOMAIN')||text.startsWith('CBA_DOMAIN'))text=fdkText('幅を求める交点が計算範囲内にありません。SSPzの計算範囲を広げてください。',text);
      if(text.startsWith('CBA_COVERAGE'))text=fdkText('Hsieh法に必要な投影または対向する列のサンプルが、検出器範囲から外れます。ピッチまたは再構成範囲を小さくしてください。',text);
      if(text.startsWith('CBA_VIEWS'))text=fdkText('Hsieh法では、1回転の取得ビュー数を偶数にしてください。',text);
      fail(text);
    }
  };worker.onerror=e=>fail(e.message);worker.postMessage({type:'fdk-run',params});
}
// Reuse the original figure axes and native-sample stroke implementation.
const FDK_PRIMARY_COLOR='#ff0000',FDK_REFERENCE_COLOR='#0000ff';
function fdkAxes(canvas,xmin,xmax,ymin,ymax,xlabel,ylabel,panel,yTicks=null,top=72,xTicks=null,yFormatter=null){
  canvas.dataset.renderScale=String(canvas.width/1000);
  const label=v=>Math.abs(v)<1e-10?'0':Math.abs(v)>=100?v.toFixed(0):Number(v.toFixed(2)).toString();
  const plot=axisContext(canvas,{xMin:xmin,xMax:xmax,yMin:ymin,yMax:ymax},{x:xlabel,y:ylabel,xFormatter:label,yFormatter:yFormatter??label,topMargin:top,leftMargin:130,rightMargin:35,bottomMargin:105});
  drawAxes(plot,xTicks??SSPZShapeDisplay.ticks(xmin,xmax),yTicks??SSPZShapeDisplay.ticks(Math.min(ymin,ymax),Math.max(ymin,ymax)));
  plot.ctx.save();plot.ctx.font=`700 25px ${FIGURE_FONT}`;plot.ctx.fillStyle=INK;plot.ctx.textAlign='left';plot.ctx.textBaseline='alphabetic';plot.ctx.fillText(panel,18,30);plot.ctx.restore();
  const b={left:plot.margin.left,right:plot.margin.left+plot.innerWidth,top:plot.margin.top,bottom:plot.margin.top+plot.innerHeight};
  canvas.dataset.axisStyle='original-shared-axisContext-drawAxes';
  canvas.dataset.renderState='ready';
  return {ctx:plot.ctx,s:1,b,x:plot.x,y:plot.y};
}
function fdkDrawLines(a,xs,series,color=FDK_PRIMARY_COLOR){
  const {ctx,b,x,y}=a;ctx.save();ctx.beginPath();ctx.rect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.clip();
  ctx.strokeStyle=color;ctx.globalAlpha=series.length>1?.13:1;ctx.lineWidth=series.length>1?1.1:4;
  for(const values of series)strokeNativeProfile(ctx,xs,values,x,y);
  ctx.restore();
}
function drawFdkProfileLegend(a,r){
  a.ctx.save();a.ctx.textAlign='center';a.ctx.textBaseline='alphabetic';a.ctx.font=`24px ${FIGURE_FONT}`;
  fdkGroups(r).forEach(([name,g],i)=>{const q=fdkWidthStats(g);a.ctx.fillStyle=i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR;a.ctx.fillText(`${name}: FWHM ${fdkWidthAnnotation(q.mean,q.sd)}`,(a.b.left+a.b.right)/2,48+i*35);});
  a.ctx.restore();
}
function fdkDrawProfile(canvas,r){
  const ymin=Math.min(0,...fdkGroups(r).flatMap(([,g])=>g.profiles.map(p=>Math.min(...p.profile)))),low=ymin<0?Math.floor(ymin*10)/10:0;
  const a=fdkAxes(canvas,r.z[0],r.z.at(-1),low,1.04,'z position (mm)','Normalized SSPz','(e)',low<0?[low,0,.2,.4,.6,.8,1]:[0,.2,.4,.6,.8,1],110,null,v=>v.toFixed(1));
  for(const [i,[,g]] of fdkGroups(r).entries())fdkDrawLines(a,r.z,g.profiles.map(p=>p.profile),i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR);
  a.ctx.save();a.ctx.strokeStyle=MUTED;a.ctx.lineWidth=1;a.ctx.setLineDash([5,4]);
  for(const level of [.5,.1]){a.ctx.beginPath();a.ctx.moveTo(a.b.left,a.y(level));a.ctx.lineTo(a.b.right,a.y(level));a.ctx.stroke();}a.ctx.restore();
  drawFdkProfileLegend(a,r);
  const fw=r.profiles[Math.min(selectedStateIndex,r.profiles.length-1)].fwhm;fdkArrow(a,fw,.5,INK);
  canvas.dataset.profileOpacity='0.13';canvas.dataset.profileLineWidth='1.1';canvas.dataset.profileInterpolation='native-sample-linear';
}
function drawFdkDifference(canvas,r){
  const limit=Math.ceil(Math.max(.02,...fdkGroups(r).flatMap(([,g])=>g.meanDifference.map(p=>Math.max(...p.map(Math.abs)))))/.02)*.02;
  const a=fdkAxes(canvas,r.z[0],r.z.at(-1),-limit,limit,'z position (mm)','SSPz minus mean','(h)');
  for(const [i,[,g]] of fdkGroups(r).entries())fdkDrawLines(a,g.z,g.meanDifference,i?FDK_REFERENCE_COLOR:FDK_PRIMARY_COLOR);
  a.ctx.textAlign='center';a.ctx.fillStyle=INK;a.ctx.font=`21px ${FIGURE_FONT}`;a.ctx.fillText(r.reference?'CBA (red) / RRI (blue); each minus its own mean':'Each profile minus the mean SSPz',(a.b.left+a.b.right)/2,49);
  canvas.dataset.profileOpacity='0.13';canvas.dataset.yMin=String(-limit);canvas.dataset.yMax=String(limit);
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
  const a=fdkAxes(canvas,-limit,limit,angleExtent,0,'Row position relative to object (mm)','Source angle offset (°)','(a)',fdkAngleTicks);
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
  const a=fdkAxes(canvas,xmin,xmax,ymin,ymax,'x relative to object (mm)',coronal?'z position (mm)':'y relative to object (mm)',coronal?'(d)':'(c)');
  const w=a.b.right-a.b.left,h=a.b.bottom-a.b.top,scale=Math.min(w/(xmax-xmin),h/(ymax-ymin));
  // Reuse the numeric frame but draw a square metric image in its own bounds.
  // Give x and y the same mm-to-pixel scale by extending the narrower axis.
  const rx=(xmax-xmin)/2,ry=(ymax-ymin)/2,cx=(a.b.left+a.b.right)/2,cy=(a.b.top+a.b.bottom)/2;
  const physical=fdkAxes(canvas,-w/(2*scale),w/(2*scale),-h/(2*scale),h/(2*scale),'x relative to object (mm)',coronal?'z position (mm)':'y relative to object (mm)',coronal?'(d)':'(c)');
  const temp=document.createElement('canvas');temp.width=nx;temp.height=ny;const tc=temp.getContext('2d'),im=tc.createImageData(nx,ny);
  values.forEach((v,i)=>{const shade=Math.round(Math.max(0,Math.min(1,v/peak))*255);im.data.set([shade,shade,shade,255],4*i);});tc.putImageData(im,0,0);physical.ctx.imageSmoothingEnabled=false;physical.ctx.drawImage(temp,cx-rx*scale,cy-ry*scale,2*rx*scale,2*ry*scale);
  physical.ctx.textAlign='center';physical.ctx.fillStyle='#000';physical.ctx.font=`${22*a.s}px Arial`;physical.ctx.fillText(`Point response: black 0 / white ${peak.toFixed(2)}`,(a.b.left+a.b.right)/2,49*a.s);
}
function drawFdkShape(canvas){SSPZShapeDisplay.draw(canvas,fdkShapeGroups,{title:`FWHM-midpoint aligned; r = ${fdkResult.config.radius} mm; n = ${fdkResult.profiles.length}`,panel:'(i)'});}
function renderFdkResult(r){
  const c=r.config;document.getElementById('fdk-summary').textContent=fdkText('全360条件の計算が完了しました。選択角度の表示を準備しています。','All 360 conditions are complete. Preparing the selected-angle view.');
  document.getElementById('fdk-result-config').textContent=`${c.rows} rows / ${c.viewSamples} views/turn / ${r.profiles.length} start angles`;
  fdkDrawProfile(document.getElementById('fdk-profile'),r);
  const comparison=document.getElementById('cba-comparison');comparison.hidden=!r.reference;document.getElementById('cba-samples-wrap').hidden=true;
  if(r.reference){comparison.innerHTML=`<table><caption>${fdkText('各SSPzから求めたFWHM','FWHM computed from individual SSPz profiles')}</caption><thead><tr><th>${fdkText('補間方法','Method')}</th><th>${fdkText('平均 (mm)','Mean (mm)')}</th><th>SD (mm)</th><th>${fdkText('範囲 (mm)','Range (mm)')}</th></tr></thead><tbody>${fdkGroups(r).map(([name,g])=>{const q=fdkWidthStats(g);return `<tr><td>${name}</td><td>${q.mean.toFixed(2)}</td><td>${q.sd===null?'—':q.sd<.001?'&lt; 0.001':q.sd.toFixed(3)}</td><td>${q.min.toFixed(2)}–${q.max.toFixed(2)}</td></tr>`;}).join('')}</tbody></table>`;cbaDrawSamples(document.getElementById('cba-samples'),r);}
  document.getElementById('fdk-shape-wrap').hidden=false;
  try {
    fdkShapeGroups=SSPZShapeDisplay.fromFdk(r);drawFdkShape(document.getElementById('fdk-shape'));
    document.getElementById('fdk-shape-summary').textContent=fdkShapeGroups.map(g=>`${g.name}: ${g.analysis.valid.length} / ${r.profiles.length}`).join(' · ')+fdkText(' 条件。濃さ：ビン内の割合。',' conditions. Intensity: fraction per bin.')+(r.profiles.length===1?fdkText('1条件では変動を評価できません。条件数を増やしてください。',' Variation cannot be assessed from one condition; increase the number of start angles.'):'');
  }catch(error){fdkShapeGroups=null;document.getElementById('fdk-shape-summary').textContent=error.message;}
  document.getElementById('fdk-difference-wrap').hidden=r.profiles.length===1;
  if(r.profiles.length>1)drawFdkDifference(document.getElementById('fdk-difference'),r);
}
function cbaDrawSamples(canvas,r){
  const audit=r.sampleAudit,limit=Math.ceil(Math.max(...audit.flatMap(q=>q.z.map(Math.abs)))*10)/10;
  const a=fdkAxes(canvas,-limit,limit,0,180,'Sample z relative to object (mm)','Rebinned angle within pair sweep (°)','(g)');
  const {ctx,s}=a;ctx.save();ctx.beginPath();ctx.rect(a.b.left,a.b.top,a.b.right-a.b.left,a.b.bottom-a.b.top);ctx.clip();
  const stride=Math.max(1,Math.ceil(audit.length/45));
  audit.forEach((q,j)=>{if(j%stride)return;for(let i=0;i<4;i++){
    const yy=a.y(q.relativeAngleDeg);ctx.strokeStyle='#0033bb';ctx.lineWidth=1.4*s;ctx.beginPath();ctx.arc(a.x(q.z[i]),yy,10*s*Math.sqrt(q.rriWeights[i]),0,2*Math.PI);ctx.stroke();
    ctx.fillStyle='rgba(209,59,50,.78)';ctx.beginPath();ctx.arc(a.x(q.z[i]),yy,10*s*Math.sqrt(q.weights[i]),0,2*Math.PI);ctx.fill();
  }});ctx.restore();ctx.textAlign='center';ctx.fillStyle='#000';ctx.font=`${22*s}px Arial`;ctx.fillText('Blue outline: RRI / red fill: CBA',(a.b.left+a.b.right)/2,49*s);
}
