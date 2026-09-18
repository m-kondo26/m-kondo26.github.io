import {moriStaticConfig,moriStaticView,moriStaticAngleProfile,moriStaticCalculate,moriStaticProgress} from './mori-static-core.js?v=20260918-10';

const $=id=>document.getElementById(id),NS='http://www.w3.org/2000/svg';
const query=new URLSearchParams(location.search),en=query.get('lang')==='en',tr=(ja,eng)=>en?eng:ja;
document.documentElement.lang=en?'en':'ja';
document.title=tr('検出器列とSSP — 図6.25の計算をたどる','Detector rows and SSP — following Fig. 6.25');
document.querySelectorAll('[data-ja]').forEach(el=>el.textContent=en?el.dataset.en:el.dataset.ja);
if(en){document.querySelector('.controls').setAttribute('aria-label','Conditions');for(const [id,label] of Object.entries({orbit:'Source, rotation axis and evaluation point',geometry:'Detector rows and selected reconstruction plane',instant:'Per-angle response and row contributions',accumulation:'Partial sum and completed full-turn SSP'}))$(id).setAttribute('aria-label',label);}
$('back').textContent=tr('← SSPzシミュレーション','← SSPz simulator');$('back').href=en?'index-en.html':'./';
$('language').textContent=en?'日本語':'English';
const c=moriStaticConfig(),blue='#126cab',orange='#c67813',red='#b63446',ink='#213c50',muted='#778b9a';
const safe=(value,min,max,fallback)=>Number.isFinite(Number(value))&&value!==null?Math.max(min,Math.min(max,Number(value))):fallback;
let row=Math.round(safe(query.get('row'),1,16,13))-1,radius=[0,80,160].includes(Number(query.get('r')))&&query.has('r')?Number(query.get('r')):160;
let angle=safe(query.get('angle'),0,360,0),result=null,playing=false,lastTime=0,frameId=0,hold=0,progressCache=new Map();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
for(let k=0;k<c.rows;k++){const o=document.createElement('option');o.value=k;o.textContent=tr(`第${k+1}列の面`,`Plane for row ${k+1}`);$('row').append(o);}
$('row').value=row;$('radius').value=radius;$('angle').value=angle;
const displayedAngle=()=>Number((Math.round(angle*c.viewSamples/360)*360/c.viewSamples).toFixed(1));
function stateUrl(){const u=new URL(location.href);u.search='';if(en)u.searchParams.set('lang','en');u.searchParams.set('row',row+1);u.searchParams.set('r',radius);u.searchParams.set('angle',displayedAngle());return u;}
function saveState(){history.replaceState(null,'',stateUrl());const u=stateUrl();if(en)u.searchParams.delete('lang');else u.searchParams.set('lang','en');$('language').href=u.href;}
function node(tag,attrs={},parent){const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))if(v!==null&&v!==undefined)e.setAttribute(k,v);if(parent)parent.append(e);return e;}
function text(parent,x,y,label,attrs={}){const e=node('text',{x,y,fill:ink,'font-size':13,...attrs},parent);e.textContent=label;return e;}
function line(parent,x1,y1,x2,y2,attrs={}){return node('line',{x1,y1,x2,y2,stroke:'#cdd8e0','stroke-width':1,...attrs},parent);}
function init(id,height){const svg=$(id),width=Math.max(270,Math.round(svg.getBoundingClientRect().width));svg.replaceChildren();svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('height',height);return {svg,w:width,h:height};}
const scale=(lo,hi,a,b)=>x=>a+(x-lo)*(b-a)/(hi-lo);
function pathData(xs,ys,X,Y){let s='';for(let i=0;i<xs.length;i++)s+=(i?'L':'M')+X(xs[i]).toFixed(2)+','+Y(ys[i]).toFixed(2);return s;}
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
function drawGeometry(view){const {svg,w,h}=init('geometry',270),X=scale(0,c.detectorDistance,32,w-42),maxZ=Math.max(...view.detectorRowCentres.map(Math.abs))+4,Y=scale(-maxZ,maxZ,h-36,28),tx=X(view.transverseDistance),sx=X(0),dx=X(c.detectorDistance),sy=Y(0),pz=Y(view.zPlane);
  // Quiet guides first, data above them.
  for(const z of [-20,0,20]){line(svg,sx,Y(z),dx,Y(z),{stroke:'#edf1f4'});text(svg,3,Y(z)+4,`${z}`,{'font-size':11,fill:muted});}
  line(svg,tx,22,tx,h-28,{stroke:'#879baa','stroke-dasharray':'3 4'});
  for(const s of view.selected){const half=c.axialAperture*c.detectorDistance/c.sourceRadius/2,zd=view.detectorRowCentres[s.row],col=s===view.selected[0]?blue:orange;node('path',{d:`M${sx},${sy}L${dx},${Y(zd-half)}L${dx},${Y(zd+half)}Z`,fill:col,'fill-opacity':.08},svg);}
  for(let k=0;k<c.rows;k++){const selected=view.selected.find(s=>s.row===k),col=selected?(selected===view.selected[0]?blue:orange):'#bdcbd5',zz=view.detectorRowCentres[k];line(svg,sx,sy,dx,Y(zz),{stroke:col,'stroke-width':selected?2:0.7});line(svg,dx-3,Y(zz-c.axialAperture*c.detectorDistance/c.sourceRadius/2),dx-3,Y(zz+c.axialAperture*c.detectorDistance/c.sourceRadius/2),{stroke:col,'stroke-width':selected?5:2});
    if(selected||k===0||k===15)text(svg,dx+8,Y(zz)+4,k+1,{'font-size':12,fill:col,'font-weight':selected?700:400});}
  line(svg,sx,pz,dx,pz,{stroke:red,'stroke-width':1.5,'stroke-dasharray':'6 3'});
  node('circle',{cx:tx,cy:pz,r:5,fill:'white',stroke:red,'stroke-width':2},svg);
  for(let i=0;i<view.selected.length;i++){const s=view.selected[i];node('circle',{cx:tx,cy:Y(s.zCentre),r:4,fill:i?orange:blue,stroke:'white','stroke-width':1},svg);}
  node('circle',{cx:sx,cy:sy,r:5.5,fill:orange},svg);
  text(svg,sx,14,tr('X線源','Source'),{'font-size':12});text(svg,tx,14,tr('評価点','Point'),{'text-anchor':'middle','font-size':12});text(svg,dx,h-9,tr('検出器列','Rows'),{'text-anchor':'end','font-size':12});
  text(svg,sx+14,h-9,tr(`赤破線：選択した面 z = ${view.zPlane.toFixed(1)} mm`,`Red: selected plane z = ${view.zPlane.toFixed(1)} mm`),{fill:red,'font-size':w<450?11:12});
}
function currentFinal(){return result?.groups.find(g=>g.radius===radius).profiles[row];}
function localDomain(){const p=currentFinal();if(!p)return [-6,6];let a=0,b=p.profile.length-1;while(a<b&&p.profile[a]<p.peak*.0001)a++;while(b>a&&p.profile[b]<p.peak*.0001)b--;const span=Math.max(3,Math.abs(result.z[a]-p.zPlane)+.8,Math.abs(result.z[b]-p.zPlane)+.8);return [-Math.ceil(span),Math.ceil(span)];}
function displayView(){const shown=displayedAngle(),v=moriStaticView(c,{row,radius,angleDeg:shown});$('angle-value').value=`${shown}°`;$('angle-value').textContent=`${shown}°`;$('angle').value=shown;
  $('plane-description').textContent=tr(`再構成面は第${row+1}列の回転軸上の位置、z = ${v.zPlane.toFixed(1)} mmに固定しています。`,`The reconstruction plane stays at z = ${v.zPlane.toFixed(1)} mm, where row ${row+1} projects onto the axis.`);
  drawOrbit(v);drawGeometry(v);
  const descriptions=v.selected.map(s=>tr(`第${s.row+1}列 × ${s.weight.toFixed(2)}`,`Row ${s.row+1} × ${s.weight.toFixed(2)}`));
  $('weights').replaceChildren();v.selected.forEach((s,i)=>{const tag=document.createElement('span');tag.className='weight-tag';tag.style.borderColor=i?orange:blue;tag.textContent=descriptions[i];$('weights').append(tag);});
  const distanceTag=document.createElement('span');distanceTag.className='weight-tag';distanceTag.style.borderColor=muted;distanceTag.textContent=tr(`距離重み × ${v.backprojectionWeight.toFixed(3)}`,`Distance factor × ${v.backprojectionWeight.toFixed(3)}`);$('weights').append(distanceTag);
  $('selection-note').classList.toggle('edge',v.edgeFallback);
  $('selection-note').textContent=v.edgeFallback?tr(`この角度では、選んだ面を挟む列がありません。端の第${v.selected[0].row+1}列で代替しています。`,`At this angle, no rows bracket the plane. End row ${v.selected[0].row+1} substitutes.`):v.selected.length===1?tr(`この角度では、第${v.selected[0].row+1}列の中心が選んだ面と一致します。`,`At this angle, row ${v.selected[0].row+1} is centred on the selected plane.`):tr(`選んだ面を挟む2列を使います：${descriptions.join(' ＋ ')}。`,`Two rows bracket the plane: ${descriptions.join(' + ')}.`);
  if(!result)return;
  const single=moriStaticAngleProfile(c,{row,radius,angleDeg:shown,z:result.z}),rel=Float64Array.from(result.z,z=>z-v.zPlane),domain=localDomain(),max=(c.sourceRadius/(c.sourceRadius-radius))**2*1.12;
  const plot=chart('instant',{domain,ymax:max,xlabel:tr('選んだ面からの z 位置 (mm)','z relative to selected plane (mm)'),ylabel:tr('その角度の応答','Response at this angle')});
  // Clip all paths to the plotted area without changing calculation or export.
  function clipped(p,id){const defs=node('defs',{},p.svg),clip=node('clipPath',{id},defs);node('rect',{x:48,y:27,width:p.w-61,height:p.h-75},clip);return node('g',{'clip-path':`url(#${id})`},p.svg);}
  const g=clipped(plot,'instant-clip');single.components.forEach((s,i)=>path(g,rel,s.profile,plot.X,plot.Y,{stroke:i?orange:blue,'stroke-width':2,'stroke-dasharray':i?'5 3':null}));path(g,rel,single.raw,plot.X,plot.Y,{stroke:ink,'stroke-width':1.6});
  const key=shown;let part=progressCache.get(key);if(!part){part=moriStaticProgress(c,{row,radius,angleDeg:key,z:result.z});progressCache.set(key,part);}
  const complete=currentFinal(),acc=chart('accumulation',{domain,ymax:complete.peak*1.15,xlabel:tr('選んだ面からの z 位置 (mm)','z relative to selected plane (mm)'),ylabel:tr('面積で正規化した応答 (1/mm)','Area-normalized response (1/mm)')});
  const ag=clipped(acc,'acc-clip');path(ag,rel,complete.profile,acc.X,acc.Y,{stroke:'#9aaab6','stroke-dasharray':'5 4','stroke-width':1.6});path(ag,rel,part.profile,acc.X,acc.Y,{stroke:blue,'stroke-width':2.4});
  $('progress-label').textContent=tr(`${part.viewsIncluded} / ${part.viewCount} 方向を合算（${Math.round(part.fraction*100)}%）`,`${part.viewsIncluded} / ${part.viewCount} directions accumulated (${Math.round(part.fraction*100)}%)`);
}
function drawFamilies(){if(!result)return;$('families').replaceChildren();const ymax=Math.max(...result.groups.flatMap(g=>g.profiles.map(p=>p.peak)))*1.1;
  for(const group of result.groups){const wrap=document.createElement('div'),label=document.createElement('p');label.className='family-label';const title=document.createElement('strong');title.textContent=`r = ${group.radius} mm`;label.append(title);const p=group.profiles[row],s=document.createElement('span');s.textContent=tr(`青：第${row+1}列に対応する面 ／ 端列での代替 ${(p.edgeFraction*100).toFixed(1)}% の方向`,`Blue: plane for row ${row+1} / end-row substitution in ${(p.edgeFraction*100).toFixed(1)}% of directions`);label.append(s);wrap.append(label);const id=`family-${group.radius}`,svg=node('svg',{id,role:'img','aria-label':tr(`r ${group.radius} mmにおける16再構成面のSSP`,`SSPs of 16 planes at r ${group.radius} mm`)});wrap.append(svg);$('families').append(wrap);
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
$('inner').addEventListener('click',()=>{$('row').value=8;selectionChange();});$('outer').addEventListener('click',()=>{$('row').value=15;selectionChange();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});reduced.addEventListener('change',()=>{if(reduced.matches)pause();});
if(reduced.matches){$('play').title=tr('再生は任意です。スライダーでも角度を変更できます。','Playback is optional. Use the slider for static steps.');}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('download').addEventListener('click',()=>{if(!result)return;const rows=[`# model=${result.version}; static table; ideal point focus; peak-one local apertures; curved distance weight (R/L)^2; final unit area`,`# R=${c.sourceRadius} mm; D=${c.detectorDistance} mm; rows=${c.rows}; rowPitch=${c.rowPitch} mm; views=${c.viewSamples}; dz=${c.zStep} mm; not exact Fig6.25 reproduction`,'radius_mm,row,reconstruction_z_mm,object_z_mm,ssp_per_mm,raw_response,edge_fraction'];for(const group of result.groups)for(const p of group.profiles)for(let i=0;i<result.z.length;i++)rows.push([group.radius,p.row+1,p.zPlane,result.z[i],p.profile[i],p.raw[i],p.edgeFraction].join(','));download(new Blob(['\ufeff'+rows.join('\r\n')],{type:'text/csv;charset=utf-8'}),'mori-static-ideal-focus-profiles.csv');});
$('save-svg').addEventListener('click',()=>{if(!result)return;const svgs=[...$('families').querySelectorAll('svg')],sourceWidth=Math.max(...svgs.map(s=>s.viewBox.baseVal.width)),width=Math.max(720,sourceWidth),factor=width/sourceWidth,blockHeight=170*factor+36,height=85+3*blockHeight+28,out=node('svg',{xmlns:NS,width,height,viewBox:`0 0 ${width} ${height}`,'font-family':'system-ui, Yu Gothic, sans-serif'});node('rect',{width:'100%',height:'100%',fill:'white'},out);text(out,16,23,tr('16再構成面のSSP：静止寝台・理想点焦点','SSP at 16 planes: static table, ideal point focus'),{'font-size':16});text(out,16,45,tr('図6.25の手順に沿う検証用モデル（掲載曲線の厳密再現ではない）','Fig.6.25-inspired model, not an exact reproduction'),{'font-size':12});svgs.forEach((svg,i)=>{text(out,16,75+i*blockHeight,`r = ${result.groups[i].radius} mm`);const g=node('g',{transform:`translate(0 ${85+i*blockHeight}) scale(${factor})`},out);for(const child of svg.children)g.append(child.cloneNode(true));});text(out,16,height-9,'16 × 2 mm · R 600 mm · 900 views · unit area · 2026-09-18.1',{'font-size':11});download(new Blob([new XMLSerializer().serializeToString(out)],{type:'image/svg+xml'}),'mori-static-16-planes.svg');});
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(stateUrl().href);$('save-status').textContent=tr('URLをコピーしました','URL copied');}catch{$('save-status').textContent=stateUrl().href;}});
let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{displayView();drawFamilies();},100);}).observe(document.querySelector('main'));
saveState();displayView();
setTimeout(()=>{try{result=moriStaticCalculate(c);drawFamilies();displayView();$('download').disabled=false;$('save-svg').disabled=false;document.body.dataset.ready='true';}catch(e){$('error').hidden=false;$('error').textContent=tr('計算を完了できませんでした：','Calculation failed: ')+e.message;$('families').setAttribute('aria-busy','false');$('play').disabled=true;console.error(e);}},30);
