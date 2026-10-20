import {readCandidateSettings,validateCandidateRequest,candidateSettingsUrl,MAX_POSITIONS} from './candidate-counts-config.js';
import {renderCandidateCountsSvg,candidateFrequencyCsv,candidateSummaryCsv} from './candidate-counts-render.js?v=2026-10-20.4';

const query=new URLSearchParams(location.search),english=query.get('lang')==='en',$=id=>document.getElementById(id),t=(ja,en)=>english?en:ja;
const labels={back:'← Change conditions in the simulator',eyebrow:'Position-dependent acquisition geometry',title:'Compare candidate counts at chosen positions',intro:'Keep the simulator collimation, pitch and other settings, and choose the positions to compare.',settingsTitle:'Inherited simulation settings',settingsDetails:'Show all conditions',positionsTitle:'Positions to compare: distance from isocenter (mm)',add:'+ Add a position',calculate:'Calculate chosen positions',cancel:'Cancel',timeNote:'At every position, 360 start-angle SSPz profiles are calculated before counting candidates. Runtime depends on position count, row count, acquired views and other settings.',resultsTitle:'Candidate-count distributions',empty:'Choose positions and calculate their distributions.',svg:'Save figure as SVG',png:'Save figure as 600-dpi PNG',frequencyCsv:'Save frequency table CSV',summaryCsv:'Save summary table CSV',json:'Save data and settings JSON',exportNote:'Count axes adjust independently for panels (a) and (b). Blue: FWHM window; orange: FWTM window. Circle size uses a shared occurrence scale. Figures use English labels; CSV and JSON retain unrounded values.',summaryTitle:'Candidate-count summary',summaryNote:'These are counts of candidate data inside each response window.',frequencyTitle:'Integer-count frequency tables',frequencyNote:'Each cell shows percentage (frequency). A dash means zero occurrences.',countTitle:'Counting rule and interpretation',countRule:'At each position, average 360 normalized SSPz profiles on their native z grid. Renormalize the mean and determine fixed 50% and 10% crossing windows. Pool 360 directions × 360 start angles = 129,600 equally weighted combinations.',scope:'Compare real-only and real-plus-conjugate row-center populations before selection or interpolation weighting. Counts are not independent measurements or dose; equal counts may conceal different spatial gaps.',footer:'Figures and tables are calculated from the inherited conditions and the positions specified on this page.'};
if(english){document.documentElement.lang='en';document.title=labels.title;for(const el of document.querySelectorAll('[data-i18n]'))el.textContent=labels[el.dataset.i18n]??el.textContent;}
let settings=null,data=null,dataKey='',worker=null,generation=0,busy=false;
const escapeHtml=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,d=3)=>Number(n).toFixed(d).replace(/\.?0+$/,'');
const roleLabel=k=>k==='direct'?t('実データのみ','Real data only'):t('実データ＋対向データ','Real + conjugate');
const rows=()=>[...document.querySelectorAll('#position-list input')];
const selected=()=>rows().map(el=>el.value===''?NaN:Number(el.value));
const keyOf=request=>JSON.stringify({settings:request.settings,radii:request.radii});

function readableError(error){
  const message=String(error?.message??error);
  if(!english){
    if(/pitch|stationary|feed/i.test(message))return '候補数の比較はピッチが0より大きいヘリカル取得で計算します。シミュレーターでピッチを確認してください。';
    if(/duplicate|unique|repeated/i.test(message))return '同じ位置が重複しています。異なる距離を指定してください。';
    if(/fan|radius|position|radii/i.test(message))return `位置は0〜${fmt(Math.min(250,settings?.sourceRadius??600,(settings?.sourceRadius??600)*Math.sin((settings?.fullFanAngleDeg??50)*Math.PI/360)),3)} mmの範囲で、1〜${MAX_POSITIONS}か所指定してください。`;
    if(/coverage|bracket|unsupported/i.test(message))return 'この位置・ピッチ・補間条件では必要な列データが不足しています。条件を確認してください。';
    if(/geometry.only|no.response|channel.*gap|no response/i.test(message))return 'この条件ではSSPzの応答が得られず、集計範囲を定められません。条件を確認してください。';
    if(/grid|domain|tail|extent/i.test(message))return 'この条件ではSSPzの共通計算範囲を確保できませんでした。スライス厚や計算間隔などを確認してください。';
  }
  return t('条件を確認してください：','Check the conditions: ')+message;
}
function updateLinks(){
  if(!settings)return;
  const parameters=new URLSearchParams(query);parameters.delete('main');
  for(const [key,value] of new URLSearchParams(candidateSettingsUrl(settings)))parameters.set(key,value);
  if(rows().length)parameters.set('radii',selected().filter(Number.isFinite).join(','));
  const page=new URL(location.href);page.search=parameters.toString();if(english)page.searchParams.set('lang','en');history.replaceState(null,'',page);
  const back=new URL(english?'index-en.html':'./',location.href),backParameters=new URLSearchParams(parameters);backParameters.delete('radii');backParameters.delete('lang');back.search=backParameters.toString();$('back-link').href=back.href;
  const other=new URL(page);if(english)other.searchParams.delete('lang');else other.searchParams.set('lang','en');$('language-link').href=other.href;$('language-link').textContent=english?'日本語':'English';
}
function currentRequest(){return validateCandidateRequest({settings,radii:selected()});}
function refreshState(){
  let fresh=false;try{fresh=!!data&&keyOf(currentRequest())===dataKey;}catch{}
  for(const button of document.querySelectorAll('[id^="export-"]'))button.disabled=!fresh||busy;
  if(!busy){$('source-status').classList.toggle('error',!!data&&!fresh);$('source-status').textContent=data?(fresh?t(`${data.radii.length}位置の計算結果です。`,`Calculated results at ${data.radii.length} positions.`):t('表示は変更前の条件です。指定した位置で再計算してください。','Displayed results use previous settings. Recalculate the selected positions.')):t('比較する位置を指定し、計算してください。','Choose positions and calculate their distributions.');}
}
function onPositionEdit(){updateLinks();try{sessionStorage.setItem('sspz-candidate-positions',JSON.stringify(selected()));}catch{}refreshState();$('calculation-status').textContent='';}
function renderPositions(values){
  $('position-list').replaceChildren();
  values.forEach((value,index)=>{const row=document.createElement('div');row.className='position-row';const label=document.createElement('label'),name=document.createElement('span'),input=document.createElement('input'),remove=document.createElement('button');name.textContent=t(`位置 ${index+1}`,`Position ${index+1}`);input.type='number';input.min='0';input.max=String(Math.min(250,settings.sourceRadius*Math.sin(settings.fullFanAngleDeg*Math.PI/360)));input.step='any';input.required=true;input.value=Number.isFinite(value)?String(value):'';input.id=`comparison-radius-${index}`;input.addEventListener('input',onPositionEdit);label.append(name,input);remove.type='button';remove.textContent=t('削除','Remove');remove.setAttribute('aria-label',t(`位置 ${index+1}を削除`,`Remove position ${index+1}`));remove.disabled=values.length===1;remove.onclick=()=>{const next=selected();next.splice(index,1);renderPositions(next);onPositionEdit();rows()[Math.min(index,next.length-1)]?.focus();};row.append(label,remove);$('position-list').append(row);});
  $('add-position').disabled=values.length>=MAX_POSITIONS;
}
function renderSettings(){
  const s=settings;$('settings-summary').textContent=`${t('コリメーション','Collimation')}: ${s.rows} × ${s.rowWidth} mm · pitch ${s.beamPitch} · T = ${s.sliceThicknessMm} mm`;
  const fields=[
    [t('取得・計算間隔','Acquisition and grid'),`${s.viewSamples} ${t('ビュー/回転','views/rotation')} / Δz = ${s.zStep} mm`],
    [t('線源距離','Source distances'),`R = ${s.sourceRadius} mm / D = ${s.focalSourceDetectorMm} mm`],
    [t('面内開口・チャネル間隔','Transaxial aperture / channel spacing'),`${s.channelApertureMm} / ${s.channelWidth} mm`],
    [t('体軸焦点寸法','Axial focal size'),`${s.focalSizeMm} mm`],
    [t('補間規則','Interpolation'),s.axialRule==='merged'?t('実・対向をまとめて2点補間','Combined two-point interpolation'):t('実・対向を分けて列間補間','Row interpolation')],
    [t('取得範囲・基準開始角度','Source support / base start angle'),`${360+2*s.fullFanAngleDeg}° / ${s.phase} rad`],
    [t('正規化・検出器端','Normalization / detector edges'),`${s.normalization} / ${s.edgePolicy}`],
    ['z-FFS',s.zFfsEnabled?`${t('有効','Enabled')} (m = ${s.zFfsMagnification}, a = ${s.zFfsOffset})`:t('無効','Disabled')]
  ];$('conditions').innerHTML=fields.map(([a,b])=>`<dt>${escapeHtml(a)}</dt><dd>${escapeHtml(b)}</dd>`).join('');
  $('position-help').textContent=t(`位置は追加・削除できます（1〜${MAX_POSITIONS}か所）。距離はmmで指定してください。`,`Add or remove positions (${MAX_POSITIONS} maximum); enter distances in mm.`);
}
function renderResults(){
  if(!data)return;
  $('result-figure').hidden=false;$('summary-details').hidden=false;$('frequency-details').hidden=false;
  $('figure-chart').innerHTML=renderCandidateCountsSvg(data,{stacked:matchMedia('(max-width:600px)').matches,lang:'en'});
  $('result-caption').textContent=t(`（a）実データのみ、（b）実データ＋対向データ。各位置で360方向×360開始角度＝129,600組を集計。位置：${data.radii.map(r=>r.radiusMm).join('、')} mm。`,`(a) Real data only. (b) Real + conjugate. Each position pools 360 directions × 360 start angles = 129,600 combinations. Positions: ${data.radii.map(r=>r.radiusMm).join(', ')} mm.`);
  const heads=[t('位置 r (mm)','Distance r (mm)'),t('候補群','Data included'),t('区間','Window'),t('最小個数','Minimum'),t('最大個数','Maximum'),t('平均個数','Mean count'),t('標準偏差','SD')];let body='';
  for(const r of data.radii)for(const pool of ['direct','combined'])for(const w of ['fwhm','fwtm']){const g=r.groups[pool][w];body+=`<tr><td>${r.radiusMm}</td><td>${roleLabel(pool)}</td><td>${w.toUpperCase()}</td><td>${g.min}</td><td>${g.max}</td><td>${fmt(g.mean)}</td><td>${fmt(g.sd)}</td></tr>`;}
  $('summary-table').innerHTML=`<table><caption>${t('各位置129,600組の候補データ数','Candidate counts across 129,600 combinations per position')}</caption><thead><tr>${heads.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  let tables='';for(const pool of ['direct','combined']){const counts=[...new Set(data.radii.flatMap(r=>['fwhm','fwtm'].flatMap(w=>r.groups[pool][w].frequencies.map(f=>f.count))))].sort((a,b)=>a-b);let body='';for(const w of ['fwhm','fwtm'])for(const count of counts){const fs=data.radii.map(r=>r.groups[pool][w].frequencies.find(f=>f.count===count));if(fs.every(f=>!f?.frequency))continue;body+=`<tr><th scope="row">${w.toUpperCase()} / ${count}</th>${fs.map(f=>`<td>${f?.frequency?`${(100*f.fraction).toFixed(3)}% (${f.frequency.toLocaleString('en-US')})`:'—'}</td>`).join('')}</tr>`;}tables+=`<div class="table-scroll"><table><caption>${roleLabel(pool)}</caption><thead><tr><th scope="col">${t('区間 / 個数','Window / count')}</th>${data.radii.map(r=>`<th scope="col">${r.radiusMm} mm</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;}$('frequency-tables').innerHTML=tables;
  refreshState();
}
function setBusy(value){busy=value;$('comparison-form').setAttribute('aria-busy',String(value));for(const el of document.querySelectorAll('#position-list input,#position-list button,#add-position,#calculate'))el.disabled=value;if(!value){rows().forEach(el=>{el.disabled=false;});for(const b of document.querySelectorAll('#position-list button'))b.disabled=rows().length===1;$('add-position').disabled=rows().length>=MAX_POSITIONS;}$('cancel').hidden=!value;$('calculation-progress').hidden=!value;refreshState();}
function stopWorker(){generation++;worker?.terminate();worker=null;setBusy(false);}
$('add-position').onclick=()=>{renderPositions([...selected(),NaN]);onPositionEdit();rows().at(-1)?.focus();};
$('cancel').onclick=()=>{stopWorker();$('calculation-status').textContent=t('計算を中止しました。完了済みの前回結果は保持しています。','Calculation cancelled. Previous completed results were retained.');};
$('comparison-form').onsubmit=event=>{
  event.preventDefault();let request;try{request=currentRequest();}catch(error){$('calculation-status').textContent=readableError(error);return;}
  stopWorker();const id=generation,requestKey=keyOf(request);setBusy(true);$('calculation-progress').value=0;$('source-status').textContent=t('指定した条件・位置で計算中です。','Calculating the specified conditions and positions.');$('calculation-status').textContent=t('計算を開始します。','Starting calculation.');
  const fail=error=>{if(id!==generation)return;stopWorker();$('calculation-status').textContent=readableError(error);};
  try{worker=new Worker(new URL('./candidate-counts-worker.js',import.meta.url),{type:'module'});}catch(error){fail(error);return;}
  worker.onmessage=({data:m})=>{if(id!==generation)return;if(m.type==='progress'){$('calculation-progress').value=m.fraction;$('calculation-status').textContent=`r = ${m.radiusMm} mm (${m.radiusIndex+1}/${m.radiusCount}) · ${m.stage==='counts'?t('候補数を集計','counting candidates'):`${t('開始角度','start angles')} ${m.completedStarts??0}/${m.totalStarts??360}`} · ${Math.round(100*m.fraction)}%`;}if(m.type==='complete'){data=m.data;dataKey=requestKey;stopWorker();renderResults();$('calculation-status').textContent=t(`${data.radii.length}位置の計算が完了しました。`,`${data.radii.length} positions completed.`);}if(m.type==='error')fail(Error(m.message));};
  worker.onerror=error=>fail(Error(error.message||'Worker error'));worker.postMessage({type:'start',...request});
};
function download(name,body,mime){const url=URL.createObjectURL(body instanceof Blob?body:new Blob([body],{type:mime})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
const stem=()=>`candidate-counts_N${data.condition.rows}_d${data.condition.rowSpacingMm}_pitch${data.condition.beamPitch}_T${data.condition.Tmm}`;
const publicationSvg=()=>renderCandidateCountsSvg(data,{stacked:false,lang:'en'});
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
async function pngWithResolution(blob){const a=new Uint8Array(await blob.arrayBuffer()),source=new DataView(a.buffer),parts=[a.slice(0,8)],chunk=new Uint8Array(21),view=new DataView(chunk.buffer);if(![137,80,78,71,13,10,26,10].every((v,i)=>a[i]===v))throw Error('Invalid PNG');view.setUint32(0,9);chunk.set([112,72,89,115],4);view.setUint32(8,23622);view.setUint32(12,23622);chunk[16]=1;view.setUint32(17,crc32(chunk.slice(4,17)));let inserted=false;for(let i=8;i<a.length;){const end=i+source.getUint32(i)+12;if(end>a.length)throw Error('Invalid PNG chunk');const type=String.fromCharCode(...a.slice(i+4,i+8));if(type!=='pHYs')parts.push(a.slice(i,end));if(type==='IHDR'){parts.push(chunk);inserted=true;}i=end;}if(!inserted)throw Error('PNG header missing');return new Blob(parts,{type:'image/png'});}
async function exportPng(){const button=$('export-png');button.disabled=true;const source=publicationSvg(),svg=new DOMParser().parseFromString(source,'image/svg+xml'),vb=svg.documentElement.getAttribute('viewBox').split(/\s+/).map(Number),url=URL.createObjectURL(new Blob([source],{type:'image/svg+xml'}));try{const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('SVG rasterization failed'));image.src=url;});const canvas=document.createElement('canvas');canvas.width=Math.round(180/25.4*600);canvas.height=Math.round(canvas.width*vb[3]/vb[2]);const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('PNG encoding failed');download(stem()+'_600dpi.png',await pngWithResolution(blob),'image/png');}finally{URL.revokeObjectURL(url);refreshState();}}
$('export-svg').onclick=()=>download(stem()+'.svg',publicationSvg(),'image/svg+xml;charset=utf-8');$('export-png').onclick=()=>exportPng().catch(error=>{$('calculation-status').textContent=error.message;});$('export-frequency').onclick=()=>download(stem()+'_frequencies.csv','\ufeff'+candidateFrequencyCsv(data),'text/csv;charset=utf-8');$('export-summary').onclick=()=>download(stem()+'_summary.csv','\ufeff'+candidateSummaryCsv(data),'text/csv;charset=utf-8');$('export-json').onclick=()=>download(stem()+'.json',JSON.stringify(data,null,2)+'\n','application/json');
matchMedia('(max-width:600px)').addEventListener('change',()=>{if(data)renderResults();});
window.addEventListener('pagehide',()=>{if(worker){stopWorker();$('calculation-status').textContent=t('ページを離れたため計算を中止しました。','Calculation stopped on leaving the page.');}});
try{settings=readCandidateSettings(location.search);renderSettings();const raw=query.get('radii');let remembered;try{remembered=JSON.parse(sessionStorage.getItem('sspz-candidate-positions'));}catch{}const positions=raw!==null?raw.split(',').map(x=>x.trim()===''?NaN:Number(x)):Array.isArray(remembered)&&remembered.length&&remembered.length<=MAX_POSITIONS?remembered.map(x=>x===null?NaN:Number(x)):[settings.radius];renderPositions(positions.length?positions:[settings.radius]);updateLinks();refreshState();}
catch(error){$('settings-summary').textContent=t('条件を読み込めませんでした。','Could not read the simulation settings.');$('calculation-status').textContent=readableError(error);$('calculate').disabled=true;$('add-position').disabled=true;}
