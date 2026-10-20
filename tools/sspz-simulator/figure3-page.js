import {renderFigure3Svg,figure3FrequencyCsv,figure3SummaryCsv} from './figure3-render.js';

const english=new URLSearchParams(location.search).get('lang')==='en';
const en={back:'← Simulator',eyebrow:'SSPz manuscript figures and data',title:'Figure 3: candidate counts at four positions',intro:'Compare candidates within FWHM and FWTM windows at distances of 10, 50, 80 and 102 mm from isocenter.',loading:'Loading the manuscript results.',svg:'Save figure as SVG',png:'Save figure as 600-dpi PNG',frequencyCsv:'Save frequency table CSV',summaryCsv:'Save summary table CSV',json:'Save data and settings JSON',caption:'(a) Real data only. (b) Real + conjugate data. Blue: FWHM window; orange: FWTM window. Circle size represents the occurrence of each count. Each position pools 360 directions × 360 start angles = 129,600 combinations.',exportNote:'Saved figures use the manuscript two-panel layout and English labels. On phones, the screen panels are stacked. CSV and JSON retain unrounded values.',summaryTitle:'Candidate-count summary',summaryNote:'These are counts of candidate data within each window, not SSPz widths.',frequencyTitle:'Open integer-count frequency tables',frequencyNote:'Each cell shows percentage (frequency). A dash means zero occurrences.',conditionsTitle:'Shared manuscript conditions and counting rule',countRule:'Normalize each start-angle SSPz and average at its native z coordinates without alignment. Renormalize the mean and fix the count windows at its 50% and 10% crossings. Count row centers before interpolation selection or weighting.',scope:'Conjugate data are a reassignment of acquired data. These counts are not independent measurements or dose. Identical counts may conceal different spacing or concentration.',dataSource:'Manuscript data, conditions and provenance (JSON)',recalculateTitle:'Recalculate using the same conditions',recalculateNote:'The initial display contains the verified calculation results used in the manuscript. The action below recalculates all four positions and 360 start angles per position in this browser. This can take a long time. Cancelling retains the previously displayed data.',recalculate:'Recalculate four positions',cancel:'Cancel',restore:'Restore saved manuscript results',correspondenceTitle:'Relationship to other manuscript comparisons',parallelExplanation:'The nondivergent reference assumes that axial row spacing does not expand with position or direction. It retains helical motion and row interpolation for comparison with cone geometry. The regular interface does not currently provide this reference as a selectable condition.',hsiehExplanation:'For Table 2, FWHM and FWTM from the two-point verification calculation are multiplied by the ratio of active aperture width to row spacing, then compared with the Hsieh (2003) values. For row spacing 1.25 mm and inactive width 0.1 mm, both widths are multiplied by 1.15/1.25 = 0.92. This additional correction and comparison table is separate from the uncorrected widths exported by the regular simulator.',footer:'This page exports the fixed conditions used for manuscript Figure 3. Changing inputs in the regular simulator does not change this figure.'};
const t=(ja,eng)=>english?eng:ja;
if(english){document.documentElement.lang='en';document.title=en.title;for(const el of document.querySelectorAll('[data-i18n]'))el.textContent=en[el.dataset.i18n]??el.textContent;document.getElementById('back-link').href='index-en.html';document.getElementById('language-link').textContent='日本語';document.getElementById('language-link').href='figure3.html';}
const $=id=>document.getElementById(id);
let data=null,saved=null,worker=null,request=0;
const fmt=(n,d=3)=>Number(n).toFixed(d).replace(/\.?0+$/,'');
const roleLabel=k=>k==='direct'?t('実データのみ','Real data only'):t('実データ＋対向データ','Real + conjugate');
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function render(){
  if(!data)return;
  $('figure-chart').innerHTML=renderFigure3Svg(data,{stacked:matchMedia('(max-width:600px)').matches,lang:'en'});
  $('figure-chart').setAttribute('aria-busy','false');
  $('source-status').classList.remove('error');
  $('source-status').textContent=data.provenance.cached?t('原稿で使用した保存済み計算結果を表示しています。','Showing saved calculation results used in the manuscript.'):t('このブラウザで再計算した結果を表示しています。','Showing results recalculated in this browser.');
  const headings=[t('位置 r (mm)','Distance r (mm)'),t('候補群','Data included'),t('区間','Window'),t('最小個数','Minimum'),t('最大個数','Maximum'),t('平均個数','Mean count'),t('標準偏差','SD')];
  let rows='';
  for(const r of data.radii)for(const k of ['direct','combined'])for(const w of ['fwhm','fwtm']){const g=r.groups[k][w];rows+=`<tr><td>${r.radiusMm}</td><td>${roleLabel(k)}</td><td>${w.toUpperCase()}</td><td>${g.min}</td><td>${g.max}</td><td>${fmt(g.mean)}</td><td>${fmt(g.sd)}</td></tr>`;}
  $('summary-table').innerHTML=`<table><caption>${t('各位置129,600組の候補データ数','Candidate counts across 129,600 combinations per position')}</caption><thead><tr>${headings.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  let tables='';
  for(const k of ['direct','combined']){
    let body='';const counts=[...new Set(data.radii.flatMap(r=>['fwhm','fwtm'].flatMap(w=>r.groups[k][w].frequencies.map(f=>f.count))))].sort((a,b)=>a-b);
    for(const w of ['fwhm','fwtm'])for(const count of counts){const fs=data.radii.map(r=>r.groups[k][w].frequencies.find(f=>f.count===count));if(fs.every(f=>!f?.frequency))continue;body+=`<tr><th scope="row">${w.toUpperCase()} / ${count}</th>${fs.map(f=>`<td>${f?.frequency?`${(100*f.fraction).toFixed(3)}% (${f.frequency.toLocaleString('en-US')})`:'—'}</td>`).join('')}</tr>`;}
    tables+=`<div class="table-scroll"><table><caption>${roleLabel(k)}</caption><thead><tr><th scope="col">${t('区間 / 個数','Window / count')}</th>${data.radii.map(r=>`<th scope="col">${r.radiusMm} mm</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  $('frequency-tables').innerHTML=tables;
  const c=data.condition,conditions=[
    [t('検出器・ピッチ','Collimation and pitch'),`${c.rows} × ${c.rowSpacingMm} mm / pitch ${c.beamPitch}`],
    [t('位置・平均化幅','Positions and averaging width'),`r = ${data.radii.map(r=>r.radiusMm).join(', ')} mm / T = ${c.Tmm} mm`],
    [t('線源距離','Source distances'),`R = ${c.sourceRadiusMm} mm / D = ${c.sourceDetectorDistanceMm} mm`],
    [t('検出器開口・焦点','Aperture and focus'),`${t('面内開口・間隔','Transaxial aperture/spacing')} ${c.channelApertureMm}/${c.channelSpacingMm} mm / ${t('体軸焦点','axial focus')} ${c.axialFocusSizeMm} mm`],
    [t('取得・計算間隔','Acquisition and grid'),`${c.nativeViewsPerRotation} ${t('ビュー/回転','views/rotation')} / Δz = ${c.zStepMm??0.01} mm / ${c.sourceSupportDeg}°`],
    [t('補間・正規化','Interpolation and normalization'),`RRI / ${c.candidateSearch} / min–max / ${t('検出器端では取得済み列を使用','available acquired rows at detector edges')}`],
    [t('集計','Pooling'),`${c.directions} × ${c.startAngles} = ${c.statesPerRadius?.toLocaleString('en-US')??'129,600'} ${t('組/位置','combinations/position')}`]
  ];
  $('conditions').innerHTML=conditions.map(([a,b])=>`<dt>${escapeHtml(a)}</dt><dd>${escapeHtml(b)}</dd>`).join('');
  for(const b of document.querySelectorAll('[id^="export-"]'))b.disabled=false;
  $('recalculate').disabled=!!worker;$('restore').disabled=!!worker;
}
function download(name,body,mime){const url=URL.createObjectURL(body instanceof Blob?body:new Blob([body],{type:mime}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function publicationSvg(){return renderFigure3Svg(data,{stacked:false,lang:'en'});}
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
async function pngWithResolution(blob){
  const a=new Uint8Array(await blob.arrayBuffer()),source=new DataView(a.buffer),parts=[a.slice(0,8)],chunk=new Uint8Array(21),view=new DataView(chunk.buffer);
  if(![137,80,78,71,13,10,26,10].every((v,i)=>a[i]===v))throw Error('Invalid PNG signature');
  view.setUint32(0,9);chunk.set([112,72,89,115],4);view.setUint32(8,23622);view.setUint32(12,23622);chunk[16]=1;view.setUint32(17,crc32(chunk.slice(4,17)));
  let inserted=false;
  for(let offset=8;offset<a.length;){const end=offset+source.getUint32(offset)+12;if(end>a.length)throw Error('Invalid PNG chunk');const type=String.fromCharCode(...a.slice(offset+4,offset+8));if(type!=='pHYs')parts.push(a.slice(offset,end));if(type==='IHDR'){parts.push(chunk);inserted=true;}offset=end;}
  if(!inserted)throw Error('PNG header missing');
  return new Blob(parts,{type:'image/png'});
}
async function exportPng(){
  const button=$('export-png');button.disabled=true;
  const source=publicationSvg(),doc=new DOMParser().parseFromString(source,'image/svg+xml'),vb=doc.documentElement.getAttribute('viewBox').split(/\s+/).map(Number),url=URL.createObjectURL(new Blob([source],{type:'image/svg+xml'}));
  try{const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error(t('図の画像化に失敗しました。SVG保存を利用してください。','Could not rasterize the figure; please use SVG.')));image.src=url;});const canvas=document.createElement('canvas');canvas.width=Math.round(180/25.4*600);canvas.height=Math.round(canvas.width*vb[3]/vb[2]);const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('PNG encoding failed');download('SSPz_Figure3_180mm_600dpi.png',await pngWithResolution(blob),'image/png');}
  finally{URL.revokeObjectURL(url);button.disabled=false;}
}
function onExportError(error){$('source-status').classList.add('error');$('source-status').textContent=error.message;}
$('export-svg').onclick=()=>download('SSPz_Figure3.svg',publicationSvg(),'image/svg+xml;charset=utf-8');
$('export-png').onclick=()=>exportPng().catch(onExportError);
$('export-frequency').onclick=()=>download('SSPz_Figure3_frequencies.csv','\ufeff'+figure3FrequencyCsv(data),'text/csv;charset=utf-8');
$('export-summary').onclick=()=>download('SSPz_Figure3_summary.csv','\ufeff'+figure3SummaryCsv(data),'text/csv;charset=utf-8');
$('export-json').onclick=()=>download('SSPz_Figure3_data.json',JSON.stringify(data,null,2)+'\n','application/json');
function stopWorker(){request++;worker?.terminate();worker=null;$('cancel').hidden=true;$('recalculate').disabled=!saved;$('restore').disabled=!saved;$('calculation-progress').hidden=true;}
$('cancel').onclick=()=>{stopWorker();$('calculation-status').textContent=t('計算を中止しました。表示中の結果を保持しています。','Calculation cancelled. The displayed results have been retained.');};
$('restore').onclick=()=>{stopWorker();data=saved;render();$('calculation-status').textContent=t('原稿の保存結果に戻しました。','Restored saved manuscript results.');};
$('recalculate').onclick=()=>{
  stopWorker();const id=request;
  worker=new Worker(new URL('./figure3-worker.js',import.meta.url),{type:'module'});
  $('recalculate').disabled=true;$('restore').disabled=true;$('cancel').hidden=false;$('calculation-progress').hidden=false;$('calculation-progress').value=0;
  $('calculation-status').textContent=t('4位置の再計算を開始します。表示中の結果は完了まで保持します。','Starting recalculation at four positions. Existing results remain until completion.');
  const fail=message=>{if(id!==request)return;stopWorker();$('calculation-status').textContent=t('再計算できませんでした。表示中の結果は保持しています。 ','Recalculation failed; the displayed data were retained. ')+message;};
  worker.onmessage=({data:m})=>{
    if(id!==request)return;
    if(m.type==='progress'){$('calculation-progress').value=m.fraction;const count=m.completedStarts??0;$('calculation-status').textContent=`r = ${m.radiusMm} mm (${(m.radiusIndex??0)+1}/4) · ${m.stage==='counts'?t('候補数を集計','counting candidates'):`${t('開始角度','start angles')} ${count}/${m.totalStarts??360}`} · ${Math.round(m.fraction*100)}%`;}
    if(m.type==='complete'){data={...m.data,chart:saved.chart,provenance:{...m.data.provenance,cached:false}};stopWorker();render();$('calculation-status').textContent=t('4位置の再計算が完了しました。図と表を更新しました。','Recalculation completed at all four positions. The figure and tables have been updated.');}
    if(m.type==='error')fail(m.message);
  };
  worker.onerror=e=>fail(e.message||'Worker error');worker.postMessage({type:'start'});
};
const mq=matchMedia('(max-width:600px)');mq.addEventListener('change',render);
window.addEventListener('pagehide',()=>{if(worker){stopWorker();$('calculation-status').textContent=t('ページを離れたため計算を中止しました。表示中の結果は保持しています。','Calculation stopped when leaving the page. Displayed results were retained.');}});
try{const response=await fetch('./figure3-data.json?v=2026-10-20.1');if(!response.ok)throw Error(`HTTP ${response.status}`);saved=await response.json();data=saved;render();}
catch(error){onExportError(Error(t('原稿の数値を読み込めませんでした。ページを再読み込みしてください。 ','Could not load the manuscript data. Please reload. ')+error.message));$('figure-chart').setAttribute('aria-busy','false');}
