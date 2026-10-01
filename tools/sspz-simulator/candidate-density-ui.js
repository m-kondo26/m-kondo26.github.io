// Geometry counts precede interpolation selection and weighting. The cached
// full-turn SSP mean supplies fixed native-mm response windows; no profile is
// aligned or stretched, and playback never recalculates this pooled result.
const candidateDensityUi={result:null,series:null,request:0,busy:false,worker:null,workerUrl:null,svg:''};

function densityEsc(value){const codes=[38,60,62,34,39],entities=['&amp;','&lt;','&gt;','&quot;','&apos;'];return String(value).replace(/[\u0026\u003c\u003e\u0022\u0027]/g,c=>entities[codes.indexOf(c.charCodeAt(0))]);}
function densityT(ja,en){return document.documentElement.lang==='en'?en:ja;}
function densityFixed(value,digits=1){return Number.isFinite(Number(value))?Number(value).toFixed(digits):'—';}

function initializeCandidateDensityUi(){
  if(document.getElementById('candidate-density'))return;
  const section=document.createElement('section');section.id='candidate-density';section.dataset.renderState='idle';
  section.innerHTML=`<h2>${fdkText('候補データの数と変動：FWHM・FWTM内の分布','Candidate counts and variation within FWHM and FWTM')}</h2>
    <p class="density-intro">${fdkText('同じ範囲にある実データのみの数と、対向データを含む候補数を並べます。選択や補間重みが付く前の、検出器列中心の数です。','Compare direct-data counts with counts including complementary data in the same windows. These detector-row centres are counted before selection or interpolation weighting.')}</p>
    <div class="density-actions"><button type="button" id="density-calculate">${fdkText('360開始角度を準備して分布を表示','Prepare 360 start angles and show distributions')}</button><button type="button" id="density-cancel" class="secondary" hidden>${fdkText('集計を中止','Cancel counting')}</button></div>
    <p id="density-status" class="density-status" role="status" aria-live="polite"></p>
    <figure class="density-figure" id="density-figure" hidden></figure>
    <div class="density-table-scroll" id="density-summary"></div>
    <div class="density-actions" id="density-exports" hidden><button type="button" class="secondary" id="density-png">${fdkText('600 dpi PNG保存','Save 600-dpi PNG')}</button><button type="button" class="secondary" id="density-svg">SVG</button><button type="button" class="secondary" id="density-csv">${fdkText('整数頻度CSV','Integer-frequency CSV')}</button><button type="button" class="secondary" id="density-samples">${fdkText('全方向・開始角度CSV','All directions and start angles CSV')}</button><button type="button" class="secondary" id="density-json">JSON</button></div>
    <p class="density-note">${fdkText('各開始角度で、0～359°の補間対象方向を1°ずつ集計します。1個の値は1方向の候補数です。バイオリンの横幅は出現割合を示し、全群で同じ尺度です。','At each start angle, output directions 0–359° are counted in 1° steps. Each observation is a count for one direction. Violin width shows frequency on a common scale across every group.')}</p>
    <details class="reading-details"><summary>${fdkText('数え方と読み方','Counting rule and interpretation')}</summary><p>${fdkText('集計範囲は、同じ評価位置の360開始角度から求めた平均SSPzの左右50%交点（FWHM）と10%交点（FWTM）で固定します。両表示は同じ有限取得角度範囲を使い、範囲内の全検出器列中心を数えます。重みが0の点も含みます。','Windows are fixed by the left/right 50% (FWHM) and 10% (FWTM) crossings of the mean SSPz across 360 start angles at the same position. Both displays use the same finite acquisition-angle support and count every detector-row centre in each window, including zero-weight centres.')}</p><p>${fdkText('対向データは取得済みデータの対応づけです。合算した候補数は、独立した測定数や被ばく線量ではありません。また同じ個数でも、範囲内の間隔や集中する位置は異なり得るため、展開図と併せて確認してください。','Complementary data are a reassignment of acquired data. Combined candidate counts are not independent measurement counts or dose. Equal counts can conceal different spacing or concentration within a window; read these distributions together with the unwrapped diagrams.')}</p></details>`;
  document.getElementById('position-preview').after(section);
  document.getElementById('density-calculate').onclick=()=>{
    if(candidateDensityUi.series)prepareCandidateDensityFromSeries(candidateDensityUi.series);
    else document.getElementById('position-prepare').click();
  };
  document.getElementById('density-cancel').onclick=()=>invalidateCandidateDensityUi('cancelled');
  for(const kind of ['svg','png','csv','samples','json'])document.getElementById('density-'+kind).onclick=()=>exportCandidateDensity(kind);
  updateCandidateDensityStatus('idle');
}

function releaseCandidateDensityWorker(){
  candidateDensityUi.worker?.terminate();candidateDensityUi.worker=null;
  if(candidateDensityUi.workerUrl)URL.revokeObjectURL(candidateDensityUi.workerUrl);
  candidateDensityUi.workerUrl=null;
}
function invalidateCandidateDensityUi(state='idle'){
  const q=candidateDensityUi;q.request++;q.busy=false;if(state!=='cancelled')q.series=null;releaseCandidateDensityWorker();
  if(document.getElementById('candidate-density'))updateCandidateDensityStatus(state);
}
function updateCandidateDensityStatus(state,message=''){
  const section=document.getElementById('candidate-density');if(!section)return;
  const q=candidateDensityUi,held=!!q.result&&state!=='ready';
  section.hidden=Number(form.elements.namedItem('beamPitch').value)<=0;
  section.dataset.renderState=held?'stale':state;
  section.setAttribute('aria-busy',String(state==='loading'));
  const messages={
    idle:fdkText('360開始角度を準備すると、同じ評価位置の候補数の分布を表示します。','Prepare all 360 start angles to show candidate-count distributions at this position.'),
    loading:fdkText('全方向・開始角度の候補数を集計中です。','Counting candidates for all directions and start angles.'),
    ready:fdkText('同じ取得範囲・集計範囲で、実データのみと対向を含む候補を比較しています。','Direct-only and combined candidates share identical acquisition support and count windows.'),
    cancelled:fdkText('集計を中止しました。','Counting cancelled.'),
    error:fdkText('候補数の分布を算出できませんでした。','Candidate-count distributions could not be computed.'),
    unavailable:fdkText('この条件では平均SSPzの集計範囲を求められません。','Mean-SSPz count windows are unavailable at these settings.')
  };
  const prior=held?fdkText('下の図は変更前の条件です。再計算してください。','The figure below uses the previous settings; recalculate.')+' '+densitySettingsLabel(q.result):'';
  document.getElementById('density-status').textContent=[messages[state]??'',message,state==='ready'?densitySettingsLabel(q.result):prior].filter(Boolean).join(' ');
  document.getElementById('density-calculate').disabled=state==='loading';
  document.getElementById('density-cancel').hidden=state!=='loading';
  for(const button of document.getElementById('density-exports').querySelectorAll('button'))button.disabled=state!=='ready';
  document.getElementById('density-calculate').textContent=state==='ready'?fdkText('候補数の分布を再集計','Recount candidate distributions'):fdkText('360開始角度を準備して分布を表示','Prepare 360 start angles and show distributions');
}
function densitySettingsLabel(result){
  if(!result)return '';
  const c=result.config;
   return `r = ${c.radius} mm / ${c.rows} × ${c.rowWidth} mm / pitch ${c.beamPitch} / T = ${c.axialAverageMm??c.sliceThicknessMm??0} mm / ${fdkInterpolationLabel(c)}`;
}

// Filled by the core/worker integration: one job uses the already calculated
// mean response and never requests another SSP sweep when the cache is valid.
async function prepareCandidateDensityFromSeries(series){
  const q=candidateDensityUi;
  releaseCandidateDensityWorker();const requestId=++q.request;q.series=series;q.busy=true;
  updateCandidateDensityStatus('loading');
  try{
    const result=await computeCandidateDensityFromSeries(series,{angleSamples:360,startSamples:360,includeCounts:true,
      cancelled:()=>requestId!==q.request,
      onProgress:value=>{if(requestId===q.request)updateCandidateDensityStatus('loading',`${Math.round(value.fraction*100)}%`);}});
    if(requestId!==q.request)return;
    q.result=result;q.busy=false;renderCandidateDensityUi(result);updateCandidateDensityStatus('ready');
  }catch(error){if(requestId===q.request){q.busy=false;updateCandidateDensityStatus('error',error.message);}}
}

function densityGroups(result){return ['direct','combined'].flatMap(kind=>['fwhm','fwtm'].map(window=>({kind,window,...result.groups[kind][window]})));}
function densityIntegerTicks(maximum){
  const step=Math.max(1,Math.ceil(maximum/10));
  return Array.from({length:Math.floor(maximum/step)+1},(_,i)=>i*step);
}
function candidateDensitySvg(result){
  const W=1700,H=1080,groups=densityGroups(result),maxCount=Math.max(1,...groups.map(g=>g.max));
  const axisMax=maxCount+1,ticks=densityIntegerTicks(axisMax);
  const maxFraction=Math.max(...groups.flatMap(g=>g.frequencies.map(p=>p.frequency/result.sampleCount)));
  const color={fwhm:'#3279b5',fwtm:'#d88328'},ink='#243847',muted='#5c6e7c';
  const out=[`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="density-svg-title density-svg-description">`,
    `<title id="density-svg-title">${densityEsc(densityT('FWHM・FWTM内の候補数の分布','Distribution of candidate counts within FWHM and FWTM'))}</title>`,
    `<desc id="density-svg-description">${densityEsc(densityT('実データのみと、対向データを含む候補を同じ個数軸で比較。横幅は整数個数の出現割合。','Direct-only and combined candidates on the same count axis. Width represents the frequency of each integer count.'))}</desc>`,
    `<rect width="${W}" height="${H}" fill="white"/><g font-family="Arial, Noto Sans CJK JP, sans-serif" fill="${ink}">`];
  const text=(x,y,label,size=26,anchor='start',weight='400',fill=ink)=>out.push(`<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" font-weight="${weight}" fill="${fill}">${densityEsc(label)}</text>`);
  const line=(x1,y1,x2,y2,stroke='#dce4ea',width=1)=>out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}"/>`);
  text(50,51,densityT('候補数の分布：実データのみ／実データ＋対向データ','Candidate counts within FWHM and FWTM'),35,'start','700');
  text(50,93,densitySettingsLabel(result),25,'start','400',muted);
  text(50,131,densityT('各1方向の個数を集計 · 補間対象方向360 × 開始角度360','Counts per direction · 360 output directions × 360 start angles'),24,'start','400',muted);
  for(const [i,window] of ['fwhm','fwtm'].entries()){
    out.push(`<rect x="${50+i*360}" y="161" width="31" height="17" fill="${color[window]}" fill-opacity=".55" stroke="${color[window]}"/>`);
    text(95+i*360,180,`${window.toUpperCase()}${densityT('内',' window')}`,24);
  }
  out.push('<circle cx="851" cy="170" r="7" fill="white" stroke="#344b5c" stroke-width="2"/>');text(870,180,densityT('平均個数','Mean count'),24);
  const top=286,bottom=804,plotHeight=bottom-top;
  for(const [panel,kind] of ['direct','combined'].entries()){
    const left=142+panel*850,right=780+panel*850;
    text((left+right)/2,233,(panel?'(b) ':'(a) ')+densityT(kind==='direct'?'実データのみ':'実データ＋対向データ',kind==='direct'?'Direct data only':'Direct + complementary data'),31,'middle','700');
    const y=v=>bottom-(v+.5)/(axisMax+.5)*plotHeight;
    for(const tick of ticks){line(left,y(tick),right,y(tick));text(left-16,y(tick)+9,String(tick),24,'end');}
    line(left,top,left,bottom,ink,2);line(left,bottom,right,bottom,ink,2);
    const xlabel=densityT('集計範囲','Count window');text((left+right)/2,891,xlabel,28,'middle');
    out.push(`<text transform="translate(${left-88} ${(top+bottom)/2}) rotate(-90)" font-size="28" text-anchor="middle">${densityEsc(densityT('候補数（個／補間対象方向）','Candidate count (per output direction)'))}</text>`);
    for(const [i,window] of ['fwhm','fwtm'].entries()){
      const g=result.groups[kind][window],cx=left+190+i*270;
      text(cx,852,window.toUpperCase(),27,'middle','700',color[window]);
      // Compact smoothing never fills an unobserved integer: support is only
      // ±0.45 count around occupied values. Exact frequency dots remain visible.
      for(const entry of g.frequencies){
        if(!entry.frequency)continue;
        const halfWidth=92*(entry.frequency/result.sampleCount)/maxFraction,points=[];
        for(let k=0;k<=24;k++){const u=-1+2*k/24;points.push([cx+halfWidth*(1-u*u)**2,y(entry.count+.45*u)]);}
        for(let k=24;k>=0;k--){const u=-1+2*k/24;points.push([cx-halfWidth*(1-u*u)**2,y(entry.count+.45*u)]);}
        out.push(`<path d="${points.map(([x,z],n)=>`${n?'L':'M'}${x.toFixed(2)},${z.toFixed(2)}`).join(' ')} Z" fill="${color[window]}" fill-opacity=".52" stroke="${color[window]}" stroke-width="1.3"/>`);
        out.push(`<circle cx="${cx}" cy="${y(entry.count).toFixed(2)}" r="3.8" fill="${color[window]}"><title>${entry.count}: ${entry.frequency} / ${result.sampleCount} (${(100*entry.frequency/result.sampleCount).toFixed(2)}%)</title></circle>`);
      }
      out.push(`<circle cx="${cx}" cy="${y(g.mean).toFixed(2)}" r="7.3" fill="white" stroke="#344b5c" stroke-width="2.1"/>`);
    }
    text(left,940,densityT('固定した集計範囲（mm）','Fixed count windows (mm)'),24,'start','700');
    for(const [i,window] of ['fwhm','fwtm'].entries()){
      const b=result.windows[window];text(left,978+i*34,`${window.toUpperCase()}: ${densityFixed(b.left,2)} → ${densityFixed(b.right,2)} / ${densityT('幅','width')} ${densityFixed(b.width)}`,23,'start','400',color[window]);
    }
  }
  text(50,1052,densityT('横幅＝整数個数の出現割合（共通尺度）。出現しない整数個数には分布を描きません。','Width = integer-count frequency (common scale). Unobserved integer counts remain empty.'),23,'start','400',muted);
  out.push('</g></svg>');return out.join('');
}
function renderCandidateDensityUi(result){
  const q=candidateDensityUi;q.svg=candidateDensitySvg(result);
  const figure=document.getElementById('density-figure');figure.innerHTML=q.svg;figure.hidden=false;
  document.getElementById('density-exports').hidden=false;
  document.getElementById('density-summary').innerHTML=`<table><caption>${fdkText('分布の要約：1方向の候補数','Distribution summary: candidates per direction')}</caption><thead><tr><th>${fdkText('表示','Data included')}</th><th>${fdkText('集計範囲','Window')}</th><th>${fdkText('平均個数','Mean count')}</th><th>${fdkText('最小個数','Minimum count')}</th><th>${fdkText('最大個数','Maximum count')}</th></tr></thead><tbody>${densityGroups(result).map(g=>`<tr><td>${g.kind==='direct'?fdkText('実データのみ','Direct only'):fdkText('実データ＋対向データ','Direct + complementary')}</td><td>${g.window.toUpperCase()}</td><td>${densityFixed(g.mean)}</td><td>${g.min}</td><td>${g.max}</td></tr>`).join('')}</tbody></table>`;
  figure.dataset.sampleCount=String(result.sampleCount);
  figure.dataset.countScope='geometrical-row-centres-before-selection-and-weighting';
  figure.dataset.integerHoles='unobserved-integers-empty';
  figure.dataset.sharedAxes='count-and-frequency-width';
}
function densityExportStem(result){const c=result.config;return `candidate-count-${fdkInterpolationRule(c)}-N${c.rows}-d${c.rowWidth}mm-p${c.beamPitch}-T${c.axialAverageMm??c.sliceThicknessMm??0}mm-r${c.radius}mm`;}
function candidateDensitySamplesCsv(result){
  const r=result,rows=[['start_index','start_angle_deg','direction_index','output_direction_deg','direct_fwhm_count','direct_fwtm_count','combined_fwhm_count','combined_fwtm_count']];
  for(let s=0;s<r.startSamples;s++)for(let a=0;a<r.angleSamples;a++){
    const i=s*r.angleSamples+a;
    rows.push([s,s*360/r.startSamples,a,a*360/r.angleSamples,
      r.groups.direct.fwhm.counts[i],r.groups.direct.fwtm.counts[i],r.groups.combined.fwhm.counts[i],r.groups.combined.fwtm.counts[i]]);
  }
  return rows.map(row=>row.map(csvEscape).join(',')).join('\n');
}
async function exportCandidateDensity(kind){
  const q=candidateDensityUi,r=q.result;if(!r||q.busy||document.getElementById('candidate-density').dataset.renderState!=='ready')return;
  const stem=densityExportStem(r);
  if(kind==='svg'){downloadBlob(stem+'.svg',q.svg,'image/svg+xml;charset=utf-8');return;}
  if(kind==='json'){downloadBlob(stem+'.json',JSON.stringify(r,(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v),'application/json');return;}
  if(kind==='csv'){
    const rows=[['data_included','window','candidate_count','frequency','fraction','total_observations','window_left_mm','window_right_mm'],...densityGroups(r).flatMap(g=>g.frequencies.map(p=>[g.kind,g.window,p.count,p.frequency,p.frequency/r.sampleCount,r.sampleCount,r.windows[g.window].left,r.windows[g.window].right]))];
    downloadBlob(stem+'-frequencies.csv','\uFEFF'+rows.map(row=>row.map(csvEscape).join(',')).join('\n'));return;
  }
  if(kind==='samples'){downloadBlob(stem+'-all-directions-starts.csv','\uFEFF'+candidateDensitySamplesCsv(r));return;}
  const button=document.getElementById('density-png');button.disabled=true;
  const source=new Blob([q.svg],{type:'image/svg+xml'}),url=URL.createObjectURL(source);
  try{
    const bitmap=new Image();await new Promise((resolve,reject)=>{bitmap.onload=resolve;bitmap.onerror=()=>reject(Error('PNG image rendering failed'));bitmap.src=url;});
    const canvas=document.createElement('canvas');canvas.width=Math.round(180/25.4*600);canvas.height=Math.round(canvas.width*1080/1700);
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if(!blob)throw Error('PNG export failed');
    downloadBlob(stem+'-600dpi.png',await pngWithResolution(blob,600),'image/png');
  }catch(error){if(q.result===r&&document.getElementById('candidate-density').dataset.renderState==='ready')updateCandidateDensityStatus('ready',error.message);}
  finally{URL.revokeObjectURL(url);button.disabled=document.getElementById('candidate-density').dataset.renderState!=='ready';}
}
