// Finite acquired SOURCE-angle support. Phi denotes the FULL fan opening.
// Rebinned theta is only an output-direction coordinate, not an acquisition gate.
export function axialSourceWindow(c,z){
  const db=2*Math.PI/c.viewSamples,centre=2*Math.PI*z/c.feed;
  const half=Math.PI+(c.axialRule==='parallel'&&c.comparisonMode!=='matched-rri'?0:c.fullFanAngleDeg*Math.PI/180);
  const lower=centre-half,upper=centre+half;
  return {betaMin:c.phase+lower,betaMax:c.phase+upper,
    firstView:Math.ceil(lower/db-1e-10),lastView:Math.floor(upper/db+1e-10)};
}

// Nonzero angular-rebinning stencil; coincident focal states use the full grid.
export function axialSourceStencil(c,beta,focus=0){
  const vf=(beta-c.phase)*c.viewSamples/(2*Math.PI);
  const stride=c.zFfsEnabled&&c.zFfsOffset!==0?2:1,origin=stride===2?focus:0;
  const q=(vf-origin)/stride,nearest=Math.round(q);
  if(Math.abs(q-nearest)<1e-10)return [origin+stride*nearest];
  const i=Math.floor(q);return [origin+stride*i,origin+stride*(i+1)];
}

export function sourceSupportedAxialWeights(c,groups,z){
  const window=axialSourceWindow(c,z),V=c.viewSamples,h=c.feed,halfRows=(c.rows-1)/2,samples=[];
  for(const g of groups){
    const beta=g.beta??(c.phase+g.view*2*Math.PI/V);
    const k0=Math.ceil((window.betaMin-beta)/(2*Math.PI)-1e-10);
    const k1=Math.floor((window.betaMax-beta)/(2*Math.PI)+1e-10);
    for(let k=k0;k<=k1;k++){
      const actualBeta=beta+k*2*Math.PI,stencil=axialSourceStencil(c,actualBeta,g.focus??0);
      if(stencil[0]<window.firstView||stencil.at(-1)>window.lastView)continue;
      const origin=g.origin+k*h,f=(z-origin)/g.spacing+halfRows,n=Math.floor(f);
      const rows=(c.interpolationRule??c.axialRule)==='rri'?[n,n+1]:[Math.max(0,Math.min(c.rows-1,n)),Math.max(0,Math.min(c.rows-1,n+1))];
      for(const row of new Set(rows))if(row>=0&&row<c.rows){
        const weight=(c.interpolationRule??c.axialRule)==='rri'?Math.max(0,1-Math.abs(f-row)):0;
        samples.push({direction:g.direction,focus:g.focus??0,row,view:g.view+k*V,turn:k,
          z:origin+(row-halfRows)*g.spacing,weight,completeBracket:n>=0&&n+1<c.rows});
      }
    }
  }
  if((c.interpolationRule??c.axialRule)!=='rri'){
    const exact=samples.filter(p=>Math.abs(p.z-z)<1e-10);
    if(exact.length)exact.forEach(p=>p.weight=1/exact.length);
    else{
      let lo=-Infinity,hi=Infinity;
      for(const p of samples){if(p.z<z)lo=Math.max(lo,p.z);if(p.z>z)hi=Math.min(hi,p.z);}
      if(!Number.isFinite(lo)||!Number.isFinite(hi))throw Error('AXIAL_COVERAGE: no bracketing pair inside finite source-angle support');
      const lower=samples.filter(p=>Math.abs(p.z-lo)<1e-10),upper=samples.filter(p=>Math.abs(p.z-hi)<1e-10);
      lower.forEach(p=>p.weight=(hi-z)/(hi-lo)/lower.length);
      upper.forEach(p=>p.weight=(z-lo)/(hi-lo)/upper.length);
    }
  }
  const selected=samples.filter(p=>p.weight>0),sum=selected.reduce((s,p)=>s+p.weight,0);
  if(!(sum>1e-14))throw Error('AXIAL_COVERAGE: no row support inside finite source-angle support');
  if(c.edgePolicy==='strict'&&selected.some(p=>!p.completeBracket))throw Error('AXIAL_COVERAGE: selected direction requires complete row brackets');
  return selected.map(({completeBracket,...p})=>({...p,weight:p.weight/sum}));
}
