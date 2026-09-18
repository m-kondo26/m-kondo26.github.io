// Independent exhaustive acquisition/row enumeration. No production selector,
// support-window helper, stencil helper, or candidate shortcut is used.
export function sourceOracle(c,reference,z){
 const V=c.viewSamples,db=2*Math.PI/V,half=(180+(c.axialRule==='parallel'?0:c.fullFanAngleDeg))*Math.PI/180;
 const centre=2*Math.PI*z/c.feed,all=[];
 for(let direction=0;direction<2;direction++){
  const root=reference+direction*V/2,kc=Math.floor(z/c.feed-root/V);
  for(let k=kc-3;k<=kc+3;k++){
   const view=root+k*V,theta=c.phase+view*db;
   const gamma=c.axialRule==='parallel'?0:Math.asin(-c.radius*Math.sin(theta)/c.sourceRadius),beta=theta+gamma;
   if(beta-c.phase<centre-half-1e-10||beta-c.phase>centre+half+1e-10)continue;
   const L=c.axialRule==='parallel'?c.sourceRadius:Math.hypot(c.sourceRadius*Math.cos(beta)-c.radius,c.sourceRadius*Math.sin(beta));
   for(let focus=0;focus<(c.zFfsEnabled?2:1);focus++){
    const step=c.zFfsEnabled&&c.zFfsOffset!==0?2:1,offset=step===2?focus:0,x=((beta-c.phase)/db-offset)/step;
    const views=Math.abs(x-Math.round(x))<1e-10?[offset+step*Math.round(x)]:[offset+step*Math.floor(x),offset+step*Math.ceil(x)];
    if(views.some(v=>v*db<centre-half-1e-10||v*db>centre+half+1e-10))continue;
    const shift=c.zFfsEnabled?(focus?1:-1)*c.zFfsSourceOffsetMm:0;
    const origin=c.feed*(beta-c.phase)/(2*Math.PI)+(shift?shift*(1-L/c.zFfsSourceDetectorMm):0),spacing=c.rowWidth*L/c.sourceRadius;
    for(let row=0;row<c.rows;row++)all.push({view,direction,focus,row,beta,theta,stencilViews:views,z:origin+(row-(c.rows-1)/2)*spacing,spacing,weight:0});
   }
  }
 }
 if(c.axialRule==='rri')all.forEach(p=>p.weight=Math.max(0,1-Math.abs(z-p.z)/p.spacing));
 else{
  const exact=all.filter(p=>Math.abs(p.z-z)<1e-10);
  if(exact.length)exact.forEach(p=>p.weight=1/exact.length);
  else{
   const lo=Math.max(...all.filter(p=>p.z<z).map(p=>p.z)),hi=Math.min(...all.filter(p=>p.z>z).map(p=>p.z));
   if(!Number.isFinite(lo)||!Number.isFinite(hi))throw Error('oracle coverage');
   const a=all.filter(p=>Math.abs(p.z-lo)<1e-10),b=all.filter(p=>Math.abs(p.z-hi)<1e-10);
   a.forEach(p=>p.weight=(hi-z)/(hi-lo)/a.length);b.forEach(p=>p.weight=(z-lo)/(hi-lo)/b.length);
  }
 }
 const selected=all.filter(p=>p.weight>1e-12),sum=selected.reduce((s,p)=>s+p.weight,0);
 if(!sum)throw Error('oracle coverage');return selected.map(p=>({...p,weight:p.weight/sum}));
}
