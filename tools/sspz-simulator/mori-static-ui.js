import {moriStaticConfig,moriStaticView,moriStaticAngleProfile,moriStaticCalculateSteps,moriStaticProgress} from './mori-static-core.js?v=20260918-15';

const $=id=>document.getElementById(id),NS='http://www.w3.org/2000/svg';
const query=new URLSearchParams(location.search),en=query.get('lang')==='en',tr=(ja,eng)=>en?eng:ja;
document.documentElement.lang=en?'en':'ja';
document.title=tr('寝台静止時の再構成位置とSSPz','Reconstruction positions and SSPz with a stationary table');
document.querySelectorAll('[data-ja]').forEach(el=>el.textContent=en?el.dataset.en:el.dataset.ja);
if(en){document.querySelector('.controls').setAttribute('aria-label','Conditions');for(const [id,label] of Object.entries({orbit:'Source, rotation axis and evaluation point',geometry:'Detector rows and selected reconstruction plane',instant:'Per-angle response and row contributions',accumulation:'Partial sum and completed full-turn SSP'}))$(id).setAttribute('aria-label',label);}
$('back').textContent=tr('← SSPzシミュレーション','← SSPz simulator');$('back').href=en?'index-en.html':'./';
if(query.has('main')){const back=new URL($('back').href);back.search=query.get('main');$('back').href=back.href;}
$('language').textContent=en?'日本語':'English';
const blue='#126cab',orange='#c67813',red='#b63446',ink='#213c50',muted='#778b9a';
const safe=(value,min,max,fallback)=>Number.isFinite(Number(value))&&value!==null?Math.max(min,Math.min(max,Number(value))):fallback;
const numberParam=(name,fallback)=>query.has(name)?Number(query.get(name)):fallback;
const inherited=query.get('from')==='main',sourceRadius=numberParam('R',600),requestedRadius=numberParam('r',160);
const focusReference=numberParam('focusRef',inherited?numberParam('focus',1.2):numberParam('focus',1.2)||1.2);
// Legacy standalone links retain the original book-reference conditions.
// Main-page links explicitly supply every shared value, including zero focus.
const comparisonRadii=[...new Set(query.has('radii')?[...query.get('radii').split(',').map(Number),requestedRadius]:inherited?[0,requestedRadius]:[0,80,160,requestedRadius])].filter(r=>r<sourceRadius).sort((a,b)=>a-b);
let c;
try{c=moriStaticConfig({rows:numberParam('n',16),rowPitch:numberParam('d',2),axialAperture:numberParam('d',2),sourceRadius,detectorDistance:numberParam('D',1070),viewSamples:numberParam('nv',900),zStep:numberParam('dz',.05),focalSizeMm:numberParam('focus',1.2),radii:comparisonRadii});if(requestedRadius<0||requestedRadius>=c.sourceRadius||!Number.isFinite(requestedRadius))throw new RangeError('r must be within the source radius');}
catch(e){$('error').hidden=false;$('error').textContent=tr('計算条件を確認してください：','Check the calculation settings: ')+e.message;$('families').setAttribute('aria-busy','false');$('play').disabled=true;throw e;}
let row=Math.round(safe(query.get('row'),1,c.rows,inherited?Math.floor(c.rows/2)+1:Math.min(13,c.rows)))-1,radius=requestedRadius;
let angle=safe(query.get('angle'),0,360,0),result=null,playing=false,lastTime=0,frameId=0,hold=0,progressCache=new Map(),calculationId=0;
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
for(let k=0;k<c.rows;k++){const o=document.createElement('option');o.value=k;o.textContent=tr(`第${k+1}列の面`,`Plane for row ${k+1}`);$('row').append(o);}
$('radius').replaceChildren();for(const r of c.radii){const o=document.createElement('option');o.value=r;o.textContent=`${r} mm`;$('radius').append(o);}
$('focus').replaceChildren();for(const f of [...new Set([c.focalSizeMm,focusReference,0])]){const o=document.createElement('option');o.value=f;o.textContent=f>0?tr(`有限焦点 ${f} mm`,`Finite focus ${f} mm`):tr('点焦点（0 mm）','Point focus (0 mm)');$('focus').append(o);}
$('angle').step=360/c.viewSamples;
$('family-title').textContent=tr(`再構成面を変えて、${c.rows}本のSSPzを並べる`,`Repeat for all ${c.rows} reconstruction planes`);
$('row').value=row;$('radius').value=radius;$('angle').value=angle;$('focus').value=c.focalSizeMm;
const displayedAngle=()=>Math.round(angle*c.viewSamples/360)*360/c.viewSamples;
function stateUrl(){const u=new URL(location.href);u.search='';if(en)u.searchParams.set('lang','en');for(const [key,value] of Object.entries({n:c.rows,d:c.rowPitch,R:c.sourceRadius,D:c.detectorDistance,nv:c.viewSamples,dz:c.zStep,row:row+1,r:radius,angle:displayedAngle(),focus:c.focalSizeMm}))u.searchParams.set(key,value);if(inherited)u.searchParams.set('from','main');if(query.has('main'))u.searchParams.set('main',query.get('main'));u.searchParams.set('radii',c.radii.join(','));u.searchParams.set('focusRef',focusReference);return u;}
function saveState(){history.replaceState(null,'',stateUrl());const u=stateUrl();if(en)u.searchParams.delete('lang');else u.searchParams.set('lang','en');$('language').href=u.href;}
function node(tag,attrs={},parent){const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))if(v!==null&&v!==undefined)e.setAttribute(k,v);if(parent)parent.append(e);return e;}
function text(parent,x,y,label,attrs={}){const e=node('text',{x,y,fill:ink,'font-size':13,...attrs},parent);e.textContent=label;return e;}
function line(parent,x1,y1,x2,y2,attrs={}){return node('line',{x1,y1,x2,y2,stroke:'#cdd8e0','stroke-width':1,...attrs},parent);}
function init(id,height){const svg=$(id),width=Math.max(270,Math.round(svg.getBoundingClientRect().width));svg.replaceChildren();svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('height',height);return {svg,w:width,h:height};}
const scale=(lo,hi,a,b)=>x=>a+(x-lo)*(b-a)/(hi-lo);
function pathData(xs,ys,X,Y){let a=0,b=ys.length-1;while(a<b&&ys[a]===0)a++;while(b>a&&ys[b]===0)b--;a=Math.max(0,a-1);b=Math.min(ys.length-1,b+1);let s='';for(let i=a;i<=b;i++)s+=(i===a?'M':'L')+X(xs[i]).toFixed(2)+','+Y(ys[i]).toFixed(2);return s;}
function path(svg,x,y,X,Y,attrs={}){return node('path',{d:pathData(x,y,X,Y),fill:'none',stroke:blue,'stroke-width':2,...attrs},svg);}
function niceTicks(lo,hi,count=5){const base=(hi-lo)/count,mag=10**Math.floor(Math.log10(base)),n=base/mag,step=(n<=1?1:n<=2?2:n<=5?5:10)*mag;const vals=[];for(let v=Math.ceil(lo/step)*step;v<=hi+step*1e-5;v+=step)vals.push(+v.toFixed(8));return vals;}
function chart(id,{domain,ymax,xlabel,ylabel,height=230,zeroPlane=true}){const {svg,w,h}=init(id,height),m={l:48,r:13,t:27,b:48},X=scale(...domain,m.l,w-m.r),Y=scale(0,ymax,h-m.b,m.t);
  const xt=niceTicks(...domain,w<410?4:6),yt=niceTicks(0,ymax,3);
  for(const x of xt){line(svg,X(x),m.t,X(x),h-m.b,{stroke:'#e3e9ee'});text(svg,X(x),h-m.b+20,x.toFixed(Math.abs(x)%1?1:0),{'text-anchor':'middle','font-size':12});}
  for(const y of yt){line(svg,m.l,Y(y),w-m.r,Y(y),{stroke:'#e3e9ee'});text(svg,m.l-8,Y(y)+4,Number(y.toFixed(2)),{'text-anchor':'end','font-size':12});}
  line(svg,m.l,h-m.b,w-m.r,h-m.b,{stroke:muted});text(svg,m.l,15,ylabel,{'font-size':12});text(svg,(m.l+w-m.r)/2,h-3,xlabel,{'text-anchor':'middle','font-size':12});
  if(zeroPlane&&domain[0]<0&&domain[1]>0)line(svg,X(0),m.t,X(0),h-m.b,{stroke:red,'stroke-dasharray':'4 4','stroke-width':1});return {svg,X,Y,w,h};
}
function drawOrbit(view){const {svg,w,h}=init('orbit',190),cx=w/2,cy=94,rad=66,S=(v)=>v/c.sourceRadius*rad;
  node('circle',{cx,cy,r:rad,fill:'#f8fafc',stroke:'#bccbd6','stroke-dasharray':'3 4'},svg);
  line(svg,cx-rad-10,cy,cx+rad+10,cy,{stroke:'#e1e8ee'});line(svg,cx,cy-rad-8,cx,cy+rad+8,{stroke:'#e1e8ee'});
  const sx=cx+S(view.source.x),sy=cy-S(view.source.y),px=cx+S(radius),py=cy;
  line(svg,sx,sy,px,py,{stroke:blue,'stroke-width':2});node('circle',{cx,cy,r:3,fill:muted},svg);node('circle',{cx:sx,cy:sy,r:7,fill:orange,stroke:'white','stroke-width':2},svg);node('circle',{cx:px,cy:py,r:4.5,fill:red},svg);
  text(svg,12,16,tr('● X線源','● Source'),{fill:orange,'font-size':12});text(svg,12,182,tr(`● 評価点 r = ${radius} mm`,`● Point r = ${radius} mm`),{fill:red,'font-size':12});
}
function drawGeometry(view){const {svg,w,h}=init('geometry',270),X=scale(0,c.detectorDistance,32,w-42),supportZ=Math.max(Math.max(...view.detectorRowCentres.map(Math.abs))+c.axialAperture*c.detectorDistance/c.sourceRadius/2,c.focalSizeMm/2),maxZ=supportZ+Math.max(.5,supportZ*.12),Y=scale(-maxZ,maxZ,h-36,28),tx=X(view.transverseDistance),sx=X(0),dx=X(c.detectorDistance),sy=Y(0),pz=Y(view.zPlane);
  // Quiet guides first, data above them.
  for(const z of niceTicks(-maxZ,maxZ,4)){line(svg,sx,Y(z),dx,Y(z),{stroke:'#edf1f4'});text(svg,3,Y(z)+4,`${z}`,{'font-size':11,fill:muted});}
  line(svg,tx,22,tx,h-28,{stroke:'#879baa','stroke-dasharray':'3 4'});
  for(const s of view.selected){const half=c.axialAperture*c.detectorDistance/c.sourceRadius/2,zd=view.detectorRowCentres[s.row],col=s===view.selected[0]?blue:orange,f=c.focalSizeMm/2;
    // Both detector edges stay fixed while the source spans its effective
    // axial extent. The outer envelope is the finite-focus support; the
    // inner reference triangle is the point-focus aperture footprint.
    node('path',{d:`M${sx},${Y(-f)}L${dx},${Y(zd-half)}L${dx},${Y(zd+half)}L${sx},${Y(f)}Z`,fill:col,'fill-opacity':.07},svg);
    node('path',{d:`M${sx},${sy}L${dx},${Y(zd-half)}L${dx},${Y(zd+half)}Z`,fill:col,'fill-opacity':.07},svg);
    if(f>0)for(const sourceZ of [-f,f])for(const detectorZ of [zd-half,zd+half])line(svg,sx,Y(sourceZ),dx,Y(detectorZ),{stroke:col,'stroke-width':.65,'stroke-opacity':.45,'stroke-dasharray':'2 3'});
  }
  for(let k=0;k<c.rows;k++){const selected=view.selected.find(s=>s.row===k),col=selected?(selected===view.selected[0]?blue:orange):'#bdcbd5',zz=view.detectorRowCentres[k];line(svg,sx,sy,dx,Y(zz),{stroke:col,'stroke-width':selected?2:0.7});line(svg,dx-3,Y(zz-c.axialAperture*c.detectorDistance/c.sourceRadius/2),dx-3,Y(zz+c.axialAperture*c.detectorDistance/c.sourceRadius/2),{stroke:col,'stroke-width':selected?5:2});
    if(selected||k===0||k===c.rows-1)text(svg,dx+8,Y(zz)+4,k+1,{'font-size':12,fill:col,'font-weight':selected?700:400});}
  line(svg,sx,pz,dx,pz,{stroke:red,'stroke-width':1.5,'stroke-dasharray':'6 3'});
  node('circle',{cx:tx,cy:pz,r:5,fill:'white',stroke:red,'stroke-width':2},svg);
  for(let i=0;i<view.selected.length;i++){const s=view.selected[i];node('circle',{cx:tx,cy:Y(s.zCentre),r:4,fill:i?orange:blue,stroke:'white','stroke-width':1},svg);}
  if(c.focalSizeMm>0){line(svg,sx,Y(-c.focalSizeMm/2),sx,Y(c.focalSizeMm/2),{stroke:'white','stroke-width':7});line(svg,sx,Y(-c.focalSizeMm/2),sx,Y(c.focalSizeMm/2),{stroke:orange,'stroke-width':4});}else node('circle',{cx:sx,cy:sy,r:4,fill:orange},svg);
  text(svg,sx,14,tr('X線源','Source'),{'font-size':12});text(svg,tx,14,tr('評価点','Point'),{'text-anchor':'middle','font-size':12});text(svg,dx,h-9,tr('検出器列','Rows'),{'text-anchor':'end','font-size':12});
  text(svg,sx+14,h-9,tr(`赤破線：選択した面 z = ${view.zPlane.toFixed(2)} mm`,`Red: selected plane z = ${view.zPlane.toFixed(2)} mm`),{fill:red,'font-size':w<450?11:12});
}
function currentFinal(){return result?.groups.find(g=>g.radius===radius).profiles[row];}
function localDomain(){const p=currentFinal();if(!p)return [-6,6];let a=0,b=p.profile.length-1;while(a<b&&p.profile[a]<p.peak*.0001)a++;while(b>a&&p.profile[b]<p.peak*.0001)b--;const span=Math.max(3,Math.abs(result.z[a]-p.zPlane)+.8,Math.abs(result.z[b]-p.zPlane)+.8);return [-Math.ceil(span),Math.ceil(span)];}
function displayView(){const shown=displayedAngle(),label=Number(shown.toFixed(3)),v=moriStaticView(c,{row,radius,angleDeg:shown});$('angle-value').value=`${label}°`;$('angle-value').textContent=`${label}°`;$('angle').value=shown;
  $('scope').textContent=tr(`${inherited?'本体から引き継いだ条件':'現在の条件'}：${c.rows}列 × ${c.rowPitch} mm ／ 実効焦点 ${c.focalSizeMm} mm ／ R ${c.sourceRadius} mm ／ D ${c.detectorDistance} mm ／ ${c.viewSamples} views ／ z刻み ${c.zStep} mm。`,`${inherited?'Settings transferred from the main simulator':'Current settings'}: ${c.rows} × ${c.rowPitch} mm rows / effective axial focus ${c.focalSizeMm} mm / R ${c.sourceRadius} mm / D ${c.detectorDistance} mm / ${c.viewSamples} views / z step ${c.zStep} mm.`);
  $('plane-description').textContent=tr(`再構成面は第${row+1}列の回転軸上の位置、z = ${v.zPlane.toFixed(2)} mmに固定しています。`,`The reconstruction plane stays at z = ${v.zPlane.toFixed(2)} mm, where row ${row+1} projects onto the axis.`);
  drawOrbit(v);drawGeometry(v);
  const descriptions=v.selected.map(s=>tr(`第${s.row+1}列 × ${s.weight.toFixed(2)}`,`Row ${s.row+1} × ${s.weight.toFixed(2)}`));
  $('weights').replaceChildren();v.selected.forEach((s,i)=>{const tag=document.createElement('span');tag.className='weight-tag';tag.style.borderColor=i?orange:blue;tag.textContent=descriptions[i];$('weights').append(tag);});
  const distanceTag=document.createElement('span');distanceTag.className='weight-tag';distanceTag.style.borderColor=muted;distanceTag.textContent=tr(`距離重み × ${v.backprojectionWeight.toFixed(3)}`,`Distance factor × ${v.backprojectionWeight.toFixed(3)}`);$('weights').append(distanceTag);
  $('blur-description').textContent=tr(`評価位置での検出器開口：${v.selected[0].apertureMm.toFixed(2)} mm ／ 焦点ぼけ幅：${v.focalBlurMm.toFixed(2)} mm。${c.focalSizeMm>0?'両者を畳み込んだ応答に、列の重みを掛けます。':'点焦点では検出器開口の矩形応答です。'}`,`At the point: detector aperture ${v.selected[0].apertureMm.toFixed(2)} mm / focal blur ${v.focalBlurMm.toFixed(2)} mm. ${c.focalSizeMm>0?'Convolve the two responses, then apply each row weight.':'Point focus leaves the rectangular aperture response.'}`);
  $('instant-legend').textContent=tr(`色線：各列の寄与。黒線：その角度での合計。${c.focalSizeMm>0?'灰色破線：同じ列・重みを点焦点で計算した合計。':''}`,`Colour: each row’s contribution. Black: their sum at this angle.${c.focalSizeMm>0?' Grey dashed: the same rows and weights with point focus.':''}`);
  $('selection-note').classList.toggle('edge',v.edgeFallback);
  $('selection-note').textContent=v.edgeFallback?tr(`この角度では、選んだ面を挟む列がありません。端の第${v.selected[0].row+1}列で代替しています。`,`At this angle, no rows bracket the plane. End row ${v.selected[0].row+1} substitutes.`):v.selected.length===1?tr(`この角度では、第${v.selected[0].row+1}列の中心が選んだ面と一致します。`,`At this angle, row ${v.selected[0].row+1} is centred on the selected plane.`):tr(`選んだ面を挟む2列を使います：${descriptions.join(' ＋ ')}。`,`Two rows bracket the plane: ${descriptions.join(' + ')}.`);
  if(!result)return;
  const single=moriStaticAngleProfile(c,{row,radius,angleDeg:shown,z:result.z}),rel=Float64Array.from(result.z,z=>z-v.zPlane),domain=localDomain(),max=(c.sourceRadius/(c.sourceRadius-radius))**2*1.12;
  const plot=chart('instant',{domain,ymax:max,xlabel:tr('選んだ面からの z 位置 (mm)','z relative to selected plane (mm)'),ylabel:tr('その角度の応答','Response at this angle')});
  // Clip all paths to the plotted area without changing calculation or export.
  function clipped(p,id){const defs=node('defs',{},p.svg),clip=node('clipPath',{id},defs);node('rect',{x:48,y:27,width:p.w-61,height:p.h-75},clip);return node('g',{'clip-path':`url(#${id})`},p.svg);}
  const g=clipped(plot,'instant-clip');if(c.focalSizeMm>0){const point=moriStaticAngleProfile({...c,focalSizeMm:0},{row,radius,angleDeg:shown,z:result.z});path(g,rel,point.raw,plot.X,plot.Y,{stroke:'#96a5b0','stroke-width':1.3,'stroke-dasharray':'4 3','data-point-focus':'true'});}single.components.forEach((s,i)=>path(g,rel,s.profile,plot.X,plot.Y,{stroke:i?orange:blue,'stroke-width':2,'stroke-dasharray':i?'5 3':null}));path(g,rel,single.raw,plot.X,plot.Y,{stroke:ink,'stroke-width':1.6,'data-total':'true'});
  const key=shown;let part=progressCache.get(key);if(!part){part=moriStaticProgress(c,{row,radius,angleDeg:key,z:result.z});progressCache.set(key,part);}
  const complete=currentFinal(),acc=chart('accumulation',{domain,ymax:complete.peak*1.15,xlabel:tr('選んだ面からの z 位置 (mm)','z relative to selected plane (mm)'),ylabel:tr('面積で正規化した応答 (1/mm)','Area-normalized response (1/mm)')});
  const ag=clipped(acc,'acc-clip');path(ag,rel,complete.profile,acc.X,acc.Y,{stroke:'#9aaab6','stroke-dasharray':'5 4','stroke-width':1.6});path(ag,rel,part.profile,acc.X,acc.Y,{stroke:blue,'stroke-width':2.4});
  $('progress-label').textContent=tr(`${part.viewsIncluded} / ${part.viewCount} 方向を合算（${Math.round(part.fraction*100)}%）`,`${part.viewsIncluded} / ${part.viewCount} directions accumulated (${Math.round(part.fraction*100)}%)`);
}
function drawFamilies(){if(!result)return;$('families').replaceChildren();const ymax=Math.max(...result.groups.flatMap(g=>g.profiles.map(p=>p.peak)))*1.1;
  for(const group of result.groups){const wrap=document.createElement('div'),label=document.createElement('p');label.className='family-label';const title=document.createElement('strong');title.textContent=`r = ${group.radius} mm`;label.append(title);const p=group.profiles[row],s=document.createElement('span');s.textContent=tr(`青：第${row+1}列に対応する面 ／ 端列での代替 ${(p.edgeFraction*100).toFixed(1)}% の方向`,`Blue: plane for row ${row+1} / end-row substitution in ${(p.edgeFraction*100).toFixed(1)}% of directions`);label.append(s);wrap.append(label);const id=`family-${group.radius}`,svg=node('svg',{id,role:'img','aria-label':tr(`r ${group.radius} mmにおける${c.rows}再構成面のSSPz`,`SSPs of ${c.rows} planes at r ${group.radius} mm`)});wrap.append(svg);$('families').append(wrap);
    const plot=chart(id,{domain:[result.z[0],result.z.at(-1)],ymax,height:170,zeroPlane:false,xlabel:tr('体軸位置 z (mm)','Axial position z (mm)'),ylabel:tr('等面積のSSP (1/mm)','Equal-area SSP (1/mm)')});
    for(const p of group.profiles)if(p.row!==row)path(plot.svg,result.z,p.profile,plot.X,plot.Y,{stroke:'#98a6b0','stroke-width':1});
    line(plot.svg,plot.X(p.zPlane),27,plot.X(p.zPlane),122,{stroke:red,'stroke-dasharray':'4 4'});path(plot.svg,result.z,p.profile,plot.X,plot.Y,{stroke:blue,'stroke-width':2.5});
    text(plot.svg,plot.X(p.zPlane),39,`${row+1}`,{fill:blue,'text-anchor':'middle','font-size':12,'font-weight':700});
  }
  $('families').setAttribute('aria-busy','false');
}
function pause(){playing=false;cancelAnimationFrame(frameId);$('play').textContent=tr('▶ 回して見る','▶ Rotate');saveState();}
function animate(now){if(!playing)return;const dt=lastTime?Math.min(now-lastTime,100):0;lastTime=now;if(hold){hold-=dt;if(hold<=0){hold=0;angle=0;displayView();}}else{angle=Math.min(360,angle+dt*360/24000);if(now-(animate.lastDraw||0)>90||angle===360){displayView();animate.lastDraw=now;}if(angle===360)hold=1100;}
  frameId=requestAnimationFrame(animate);
}
$('play').addEventListener('click',()=>{if(playing){pause();return;}playing=true;lastTime=0;hold=angle>=360?1:0;$('play').textContent=tr('❚❚ 一時停止','❚❚ Pause');frameId=requestAnimationFrame(animate);});
$('reset').addEventListener('click',()=>{pause();angle=0;displayView();saveState();});
$('angle').addEventListener('input',()=>{pause();angle=Number($('angle').value);displayView();saveState();});
function selectionChange(){pause();row=Number($('row').value);radius=Number($('radius').value);progressCache.clear();displayView();drawFamilies();saveState();}
$('row').addEventListener('change',selectionChange);$('radius').addEventListener('change',selectionChange);
$('focus').addEventListener('change',()=>{pause();c=moriStaticConfig({...c,focalSizeMm:Number($('focus').value)});recalculate();saveState();});
$('inner').addEventListener('click',()=>{$('row').value=Math.floor(c.rows/2);selectionChange();});$('outer').addEventListener('click',()=>{$('row').value=c.rows-1;selectionChange();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});reduced.addEventListener('change',()=>{if(reduced.matches)pause();});
if(reduced.matches){$('play').title=tr('再生は任意です。スライダーでも角度を変更できます。','Playback is optional. Use the slider for static steps.');}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('download').addEventListener('click',()=>{if(!result)return;const rc=result.config,rows=[`# model=${result.version}; static table; focal model=${rc.focalSpotModel}; peak-one detector aperture convolved with unit-area focal kernel; curved distance weight (R/L)^2; final unit area`,`# focal_axial_mm=${rc.focalSizeMm}; focal_transverse_reference_mm=${rc.focalTransverseMm}; target_angle_reference_deg=${rc.targetAngleDeg}; target-angle-dependent focal shape NOT modelled`,`# R=${rc.sourceRadius} mm; D=${rc.detectorDistance} mm; rows=${rc.rows}; rowPitch=${rc.rowPitch} mm; views=${rc.viewSamples}; dz=${rc.zStep} mm; not exact Fig6.25 reproduction`,'radius_mm,row,reconstruction_z_mm,object_z_mm,ssp_per_mm,raw_response,edge_fraction'];for(const group of result.groups)for(const p of group.profiles)for(let i=0;i<result.z.length;i++)rows.push([group.radius,p.row+1,p.zPlane,result.z[i],p.profile[i],p.raw[i],p.edgeFraction].join(','));download(new Blob(['\ufeff'+rows.join('\r\n')],{type:'text/csv;charset=utf-8'}),`static-sspz-${rc.rows}rows-${rc.rowPitch}mm-profiles.csv`);});
$('save-svg').addEventListener('click',()=>{if(!result)return;const rc=result.config,svgs=[...$('families').querySelectorAll('svg')],sourceWidth=Math.max(...svgs.map(s=>s.viewBox.baseVal.width)),width=Math.max(720,sourceWidth),factor=width/sourceWidth,blockHeight=170*factor+36,height=85+svgs.length*blockHeight+52,out=node('svg',{xmlns:NS,width,height,viewBox:`0 0 ${width} ${height}`,'font-family':'system-ui, Yu Gothic, sans-serif'});node('rect',{width:'100%',height:'100%',fill:'white'},out);text(out,16,23,tr(`${rc.rows}再構成面のSSPz：静止寝台・実効焦点 ${rc.focalSizeMm} mm`,`SSPz at ${rc.rows} planes: static table, axial focus ${rc.focalSizeMm} mm`),{'font-size':16});text(out,16,45,tr('列間補間と距離重みによる体軸応答モデル','Axial response model with row interpolation and distance weighting'),{'font-size':12});const metadata=node('metadata',{},out);metadata.textContent=JSON.stringify({model:result.version,config:rc,targetAngleUse:'reference only; directional focal shape not modelled'});svgs.forEach((svg,i)=>{text(out,16,75+i*blockHeight,`r = ${result.groups[i].radius} mm`);const g=node('g',{transform:`translate(0 ${85+i*blockHeight}) scale(${factor})`},out);for(const child of svg.children)g.append(child.cloneNode(true));});text(out,16,height-27,`${rc.rows} × ${rc.rowPitch} mm · R ${rc.sourceRadius} mm · ${rc.viewSamples} views · unit area · ${result.version}`,{'font-size':11});text(out,16,height-9,`D ${rc.detectorDistance} mm; axial focus ${rc.focalSizeMm} mm; z step ${rc.zStep} mm; static table, no T averaging`,{'font-size':11});download(new Blob([new XMLSerializer().serializeToString(out)],{type:'image/svg+xml'}),`static-sspz-${rc.rows}rows-${rc.rowPitch}mm-focus-${rc.focalSizeMm}mm.svg`);});
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(stateUrl().href);$('save-status').textContent=tr('URLをコピーしました','URL copied');}catch{$('save-status').textContent=stateUrl().href;}});
let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{displayView();drawFamilies();},100);}).observe(document.querySelector('main'));
function recalculate(){const ticket=++calculationId;result=null;progressCache.clear();document.body.dataset.ready='false';$('error').hidden=true;$('download').disabled=true;$('save-svg').disabled=true;$('play').disabled=true;$('families').setAttribute('aria-busy','true');$('families').replaceChildren();const status=document.createElement('p');status.setAttribute('role','status');status.textContent=tr(`${c.rows}か所 × ${c.radii.length}評価位置の応答を計算しています…`,`Calculating ${c.rows} planes × ${c.radii.length} radii…`);$('families').append(status);$('instant').replaceChildren();$('accumulation').replaceChildren();$('progress-label').textContent=tr('計算中…','Calculating…');displayView();
  const steps=moriStaticCalculateSteps(c);
  function advance(){if(ticket!==calculationId)return;try{const deadline=performance.now()+20;let next;
    do{next=steps.next();if(next.done){result=next.value;drawFamilies();displayView();$('download').disabled=false;$('save-svg').disabled=false;$('play').disabled=false;document.body.dataset.ready='true';return;}}while(performance.now()<deadline);
    const {completed,total}=next.value;status.textContent=tr(`応答を計算しています… ${completed} / ${total}（${Math.round(100*completed/total)}%）`,`Calculating responses… ${completed} / ${total} (${Math.round(100*completed/total)}%)`);$('progress-label').textContent=status.textContent;setTimeout(advance,0);
  }catch(e){$('error').hidden=false;$('error').textContent=tr('計算を完了できませんでした：','Calculation failed: ')+e.message;$('families').setAttribute('aria-busy','false');$('play').disabled=true;status.textContent=tr('計算を中止しました。条件を確認してください。','Calculation stopped. Check the settings.');$('progress-label').textContent=status.textContent;console.error(e);}}
  setTimeout(advance,30);
}
saveState();recalculate();
