import {detectorCellMembership,detectorAxialFocusRows,focalBlurMetadata} from './detector-aperture.js';
import {fdkSlabMean,fdkSlabCoefficients,fdkWidth} from './fdk-core.js';
import {zffsState,zffsShift,zffsRowGeometry,zffsRebinStencil,ZFFS_VERSION} from './zffs-geometry.js';

// Point mass on a cylinder whose axial origin stays at the nominal tube z.
// w is the detector coordinate; wRay is relative to the ACTUAL focal spot.
export function zffsPointProjection(c,view,zObject){
  const beta=c.phase+2*Math.PI*view/c.viewSamples,R=c.sourceRadius;
  const L=Math.hypot(R*Math.cos(beta)-c.radius,R*Math.sin(beta));
  const transverse=R*Math.atan2(-c.radius*Math.sin(beta),R-c.radius*Math.cos(beta));
  const shift=zffsShift(c,zffsState(view)),sourceZ=c.feed*view/c.viewSamples+shift;
  const wRay=R*(zObject-sourceZ)/L,w=wRay+shift/c.zFfsMagnification;
  const aperture=c.channelApertureMm??c.channelWidth;
  const js=detectorCellMembership(transverse,c.channelWidth,aperture,c.channels);
  if(c.focalSizeMm>0){
    const ks=detectorAxialFocusRows(c,w,wRay,L),data=new Map();
    for(const [j,a] of js)for(const [k,signal] of ks)data.set(k+':'+j,signal*a);
    return {data,transverse,w,wRay,sourceZ};
  }
  const ks=detectorCellMembership(w,c.rowWidth,c.rowWidth,c.rows);
  const signal=Math.hypot(R,wRay)/(L*L*(aperture/R)*c.rowWidth);
  const data=new Map();for(const [j,a] of js)for(const [k,b] of ks)data.set(k+':'+j,signal*a*b);
  return {data,transverse,w,wRay,sourceZ};
}
export function zffsCandidateWeights(c,groups,z){
  const samples=[];
  groups.forEach((g,group)=>{
    const f=(z-g.origin)/g.spacing+(c.rows-1)/2,n=Math.floor(f);
    if(c.edgePolicy==='strict'&&(n<0||n+1>=c.rows))throw Error('AXIAL_COVERAGE: full brackets required in each focal state and direction');
    const rows=c.axialRule==='rri'?[n,n+1]:[Math.max(0,Math.min(c.rows-1,n)),Math.max(0,Math.min(c.rows-1,n+1))];
    for(const row of new Set(rows))if(row>=0&&row<c.rows)samples.push({group,row,focus:g.focus,direction:g.direction,z:g.origin+(row-(c.rows-1)/2)*g.spacing,weight:c.axialRule==='rri'?Math.max(0,1-Math.abs(f-row)):0});
  });
  if(c.axialRule!=='rri'){
    const exact=samples.filter(s=>Math.abs(s.z-z)<1e-10);
    if(exact.length)exact.forEach(s=>s.weight=1/exact.length);
    else{
      const lo=Math.max(...samples.filter(s=>s.z<z).map(s=>s.z)),hi=Math.min(...samples.filter(s=>s.z>z).map(s=>s.z));
      if(!Number.isFinite(lo)||!Number.isFinite(hi))throw Error('AXIAL_COVERAGE: no z-FFS bracketing samples');
      const a=samples.filter(s=>Math.abs(s.z-lo)<1e-10),b=samples.filter(s=>Math.abs(s.z-hi)<1e-10);
      a.forEach(s=>s.weight=(hi-z)/(hi-lo)/a.length);b.forEach(s=>s.weight=(z-lo)/(hi-lo)/b.length);
    }
  }
  const sum=samples.reduce((v,s)=>v+s.weight,0);
  if(!(sum>1e-14))throw Error('AXIAL_COVERAGE: no acquired z-FFS rows');
  return samples.filter(s=>s.weight>0).map(s=>({...s,weight:s.weight/sum}));
}
export async function computeZffsResponse(c,hooks={}){
  const nv=c.viewSamples,half=nv/2,db=2*Math.PI/nv,zObject=c.state*c.feed;
  const padding=Math.ceil(c.axialAverageMm/(2*c.zStep));
  const zs=Float64Array.from({length:c.zSamples+2*padding},(_,i)=>zObject-c.zExtent+(i-padding)*c.zStep);
  const starts=Int32Array.from(zs,z=>Math.ceil((2*Math.PI*z/c.feed-Math.PI)/db-1e-12));
  const first=Math.min(...starts),last=Math.max(...starts)+half,rawCache=new Map(),groupCache=new Map();
  let firstAcquired=Infinity,lastAcquired=-Infinity;
  const rawAt=view=>{if(!rawCache.has(view)){rawCache.set(view,zffsPointProjection(c,view,zObject));firstAcquired=Math.min(firstAcquired,view);lastAcquired=Math.max(lastAcquired,view);}return rawCache.get(view);};
  const at=(v,focus,direction)=>{
    const key=v+':'+focus;if(groupCache.has(key))return {...groupCache.get(key),direction};
    const theta=c.phase+v*db,rebin=zffsRebinStencil(c,theta,focus),L=Math.sqrt(c.sourceRadius**2-(-c.radius*Math.sin(theta))**2)-c.radius*Math.cos(theta);
    const sourceZ=c.feed*(rebin.beta-c.phase)/(2*Math.PI);
    const origin=sourceZ+zffsShift(c,focus)*(1-L/c.zFfsSourceDetectorMm);
    const values=new Float64Array(c.rows);
    for(const s of rebin.stencil){if(s.channel<0||s.channel>=c.channels)throw Error('CBA_COVERAGE: z-FFS rebinning outside acquired channels');const p=rawAt(s.view);for(const [key,value] of p.data){const [row,ch]=key.split(':').map(Number);if(ch===s.channel)values[row]+=s.weight*value;}}
    const g={theta,...rebin,origin,spacing:c.rowWidth*L/c.sourceRadius,values,focus,direction};groupCache.set(key,g);return g;
  };
  const padded=new Float64Array(zs.length),counts=new Uint16Array(zs.length),slab=fdkSlabCoefficients(zs.length,c.zStep,c.axialAverageMm);
  const physical=new Map(),rebinned=new Map(),sampleAudit=[];let lastYield=performance.now();
  for(let v=first;v<last;v++){
    if(hooks.cancelled?.())throw Error('FDK_CANCELLED');
    const groups=[at(v,0,0),at(v,1,0),at(v+half,0,1),at(v+half,1,1)];
    for(let iz=0;iz<zs.length;iz++)if(v>=starts[iz]&&v<starts[iz]+half){
      const ws=zffsCandidateWeights(c,groups,zs[iz]);counts[iz]+=2;
      for(const s of ws){
        const g=groups[s.group];padded[iz]+=s.weight*g.values[s.row]/half;
        if(!hooks.profileOnly&&slab[iz]>0){
          const coeff=slab[iz]*s.weight,key=(v+s.direction*half)+':'+s.focus+':'+s.row;
          if(!rebinned.has(key))rebinned.set(key,{view:v+s.direction*half,row:s.row,focus:s.focus,theta:g.theta,beta:g.beta,z:s.z-zObject,weight:0,acquiredValue:g.values[s.row]});
          rebinned.get(key).weight+=coeff;
          for(const t of g.stencil){
            const pk=t.view+':'+s.row+':'+t.channel;
            if(!physical.has(pk)){const q=zffsRowGeometry(c,t.view,s.row);physical.set(pk,{...q,z:q.z-zObject,channel:t.channel,weight:0,acquiredValue:rawAt(t.view).data.get(s.row+':'+t.channel)??0});}
            physical.get(pk).weight+=coeff*t.weight;
          }
        }
      }
      if(!hooks.profileOnly&&iz===(zs.length-1)/2)sampleAudit.push({theta:groups[0].theta,relativeAngleDeg:(v-starts[iz])*360/nv,beta:groups[0].beta,betaConjugate:groups[2].beta,z:ws.map(s=>s.z-zObject),weights:ws.map(s=>s.weight),focus:ws.map(s=>s.focus)});
    }
    if(performance.now()-lastYield>24){hooks.progress?.((v-first)/(last-first));await new Promise(r=>setTimeout(r,0));lastYield=performance.now();}
  }
  if(!counts.every(v=>v===nv))throw Error('AXIAL_INTERNAL: z-FFS angular count mismatch');
  const raw=fdkSlabMean(padded,c.zStep,c.axialAverageMm,padding),z=Float64Array.from(zs.slice(padding,zs.length-padding),v=>v-zObject);
  const min=Math.min(...raw),max=Math.max(...raw),baseline=c.normalization==='minmax'?min:0;
  const model={version:'2026-09-18.8',focalBlur:focalBlurMetadata(c),kind:'axial-'+c.axialRule,zFfsVersion:ZFFS_VERSION,algorithm:'reduced axial interpolation response with alternating axial focal positions',geometry:'fixed cylindrical detector; ideal pure axial focal switching',rebinning:'within each focal state separately; never interpolate alternating states as one detector trajectory',interpolation:c.axialRule==='rri'?'normalize row tents over both directions and both focal states':'nearest bracketing pair across both directions and focal states',filter:'no transverse ramp or FBP',angularWeight:'one slice-centred turn; paired angular mean',profileReadout:'fixed ideal point; moving evaluation plane; no image reconstruction',axialAverageMm:c.axialAverageMm,viewsDefinition:'viewSamples is total physical acquisitions per turn; half at each focal position',scientificScope:'ideal acquisition-model extension; not a scanner implementation or shifted backprojection'};
  const audit={definition:'Actual acquired cell weights including within-focus angular/channel rebinning and T averaging; multiply by db and raw cell value to reproduce centre response.',db:1/half,axialAverageMm:c.axialAverageMm,centerValue:raw[(raw.length-1)/2],samples:[...physical.values()]};
  const out={config:c,z,zObject,raw,min,max,baseline,model,volume:null,x:Float64Array.of(c.radius),y:Float64Array.of(0),coordinateSystem:'zffs-acquired',counts:counts.slice(padding,counts.length-padding),sampleAudit,weightAudit:hooks.profileOnly?null:audit,rebinnedWeightAudit:hooks.profileOnly?null:[...rebinned.values()],acquisition:{firstView:firstAcquired,lastViewExclusive:lastAcquired+1,viewsPerTurn:nv,viewsPerFocusPerTurn:nv/2,rebinnedPairsPerSlice:half}};
  if(!(max>baseline))return {...out,geometryOnly:true,reason:'no-acquired-point-response',profiles:[]};
  const profile=Float64Array.from(raw,v=>(v-baseline)/(max-baseline)),fwhm=fdkWidth(z,profile,.5),fwtm=fdkWidth(z,profile,.1);
  if(!fwhm||!fwtm||Math.max(profile[0],profile.at(-1))>.001)throw Error('AXIAL_DOMAIN: extend z-FFS profile domain');
  return {...out,profile,fwhm,fwtm};
}
