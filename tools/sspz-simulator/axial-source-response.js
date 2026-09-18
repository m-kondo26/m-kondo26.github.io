import {sourceSupportedAxialWeights,axialSourceWindow,axialSourceStencil} from './axial-source-support.js';
import {cbaCoordinates} from './cba-core.js';
import {detectorPointProjection,detectorRowReadout,focalBlurMetadata} from './detector-aperture.js';
import {fdkSlabMean,fdkSlabCoefficients,fdkWidth} from './fdk-core.js';
import {zffsShift,zffsRebinStencil,zffsRowGeometry,ZFFS_VERSION} from './zffs-geometry.js';
import {zffsPointProjection} from './zffs-response.js';

export function sourceAxialGroups(c,v){
  const groups=[],V=c.viewSamples;
  for(let direction=0;direction<2;direction++){
    const view=v+direction*V/2,theta=c.phase+view*2*Math.PI/V;
    const q=c.axialRule==='parallel'?{sourceZ:c.feed*view/V,L:c.sourceRadius,beta:theta,t:-c.radius*Math.sin(theta)}:cbaCoordinates(c,theta,c.radius,0,0);
    for(let focus=0;focus<(c.zFfsEnabled?2:1);focus++)groups.push({...q,view,theta,direction,focus,
      origin:q.sourceZ+(c.zFfsEnabled?zffsShift(c,focus)*(1-q.L/c.zFfsSourceDetectorMm):0),spacing:c.rowWidth*q.L/c.sourceRadius});
  }
  return groups;
}

export async function computeSourceSupportedAxialResponse(c,hooks={}){
  const V=c.viewSamples,H=V/2,db=2*Math.PI/V,zObject=c.state*c.feed;
  const padding=Math.ceil(c.axialAverageMm/(2*c.zStep));
  const zs=Float64Array.from({length:c.zSamples+2*padding},(_,i)=>zObject-c.zExtent+(i-padding)*c.zStep);
  const base=Math.ceil((2*Math.PI*zObject/c.feed-Math.PI)/db-1e-12);
  const rawCache=new Map(),rebinnedCache=new Map();let firstAcquired=Infinity,lastAcquired=-Infinity;
  const rawAt=v=>{
    if(!rawCache.has(v)){
      rawCache.set(v,c.zFfsEnabled?zffsPointProjection(c,v,zObject):detectorPointProjection({...c,sourceZ:c.feed*v/V},c.phase+v*db,zObject,c.axialRule==='parallel'));
      firstAcquired=Math.min(firstAcquired,v);lastAcquired=Math.max(lastAcquired,v);
    }
    return rawCache.get(v);
  };
  const at=(v,focus)=>{
    const key=v+':'+focus;if(rebinnedCache.has(key))return rebinnedCache.get(key);
    const g=sourceAxialGroups(c,v).find(q=>q.direction===0&&q.focus===focus),values=new Float64Array(c.rows);
    if(c.zFfsEnabled){
      const rebin=zffsRebinStencil(c,g.theta,focus),views=axialSourceStencil(c,g.beta,focus);
      g.stencil=rebin.stencil.filter(s=>views.includes(s.view));
      const mass=g.stencil.reduce((sum,s)=>sum+s.weight,0);
      g.stencil=g.stencil.map(s=>({...s,weight:s.weight/mass}));
      for(const s of g.stencil){
        if(s.channel<0||s.channel>=c.channels)throw Error('CBA_COVERAGE: z-FFS rebinning outside acquired channels');
        for(const [key,value] of rawAt(s.view).data){const [row,ch]=key.split(':').map(Number);if(ch===s.channel)values[row]+=s.weight*value;}
      }
    }else if(c.axialRule==='parallel'){
      const p=rawAt(v);for(let k=p.k0;k<=p.k1;k++)values[k]=detectorRowReadout(c,p,k);
    }else{
      const views=axialSourceStencil(c,g.beta),vf=(g.beta-c.phase)/db;
      const jf=Math.asin(g.t/c.sourceRadius)*c.sourceRadius/c.channelWidth+(c.channels-1)/2,j=Math.floor(jf),b=jf-j;
      if(j<0||j+1>=c.channels)throw Error('CBA_COVERAGE: rebinning outside acquired channels');
      for(const view of views){
        const w=views.length===1?1:Math.max(0,1-Math.abs(vf-view)),p=rawAt(view);
        for(let row=p.k0;row<=p.k1;row++){
          const cell=ch=>ch<p.j0||ch>p.j1?0:p.data[(row-p.k0)*p.width+ch-p.j0];
          values[row]+=w*((1-b)*cell(j)+b*cell(j+1));
        }
      }
    }
    const q={...g,values};rebinnedCache.set(key,q);return q;
  };
  const padded=new Float64Array(zs.length),slab=fdkSlabCoefficients(zs.length,c.zStep,c.axialAverageMm);
  const weights=new Map(),paired=new Map(),physical=new Map(),sampleAudit=[];
  let lastYield=performance.now(),maxBracketGapMm=0,maxCandidateDistanceMm=0;
  for(let v=base;v<base+H;v++){
    if(hooks.cancelled?.())throw Error('FDK_CANCELLED');
    const groups=sourceAxialGroups(c,v);
    for(let iz=0;iz<zs.length;iz++){
      const ws=sourceSupportedAxialWeights(c,groups,zs[iz]);
      maxBracketGapMm=Math.max(maxBracketGapMm,Math.max(...ws.map(s=>s.z))-Math.min(...ws.map(s=>s.z)));
      for(const s of ws){
        const q=at(s.view,s.focus),value=q.values[s.row];padded[iz]+=s.weight*value/H;
        maxCandidateDistanceMm=Math.max(maxCandidateDistanceMm,Math.abs(s.z-zs[iz]));
        if(!hooks.profileOnly&&slab[iz]>0){
          const coeff=slab[iz]*s.weight,key=s.view+':'+s.focus+':'+s.row;
          const point={view:s.view,row:s.row,focus:s.focus,theta:q.theta,beta:q.beta,z:s.z-zObject,weight:0,acquiredValue:value};
          if(!weights.has(key))weights.set(key,{...point});weights.get(key).weight+=coeff;
          const pk=v+':'+s.direction+':'+key;
          if(!paired.has(pk))paired.set(pk,{...point,referenceView:v,direction:s.direction});paired.get(pk).weight+=coeff;
          if(c.zFfsEnabled)for(const t of q.stencil){
            const cell=t.view+':'+s.row+':'+t.channel;
            if(!physical.has(cell)){const geometry=zffsRowGeometry(c,t.view,s.row);physical.set(cell,{...geometry,z:geometry.z-zObject,channel:t.channel,weight:0,acquiredValue:rawAt(t.view).data.get(s.row+':'+t.channel)??0});}
            physical.get(cell).weight+=coeff*t.weight;
          }
        }
      }
      if(!hooks.profileOnly&&iz===(zs.length-1)/2)sampleAudit.push({theta:c.phase+v*db,relativeAngleDeg:(v-base)*360/V,beta:groups[0].beta,betaConjugate:groups.at(-1).beta,
        z:ws.map(s=>s.z-zObject),weights:ws.map(s=>s.weight),views:ws.map(s=>s.view),betas:ws.map(s=>at(s.view,s.focus).beta),focus:ws.map(s=>s.focus)});
    }
    if(performance.now()-lastYield>24){hooks.progress?.((v-base)/H);await new Promise(r=>setTimeout(r,0));lastYield=performance.now();}
  }
  const raw=fdkSlabMean(padded,c.zStep,c.axialAverageMm,padding),z=Float64Array.from(zs.slice(padding,zs.length-padding),v=>v-zObject);
  const min=Math.min(...raw),max=Math.max(...raw),baseline=c.normalization==='minmax'?min:0;
  const model={version:'2026-09-18.8',kind:'axial-'+c.axialRule,focalBlur:focalBlurMetadata(c),algorithm:'reduced axial interpolation response',
    geometry:c.axialRule==='parallel'?'nondivergent parallel reference':'three-dimensional cylindrical cone-ray geometry',
    candidateSearch:'source-fan-window',fullFanAngleDeg:c.fullFanAngleDeg,sourceAngleSpanDeg:c.axialRule==='parallel'?360:360+2*c.fullFanAngleDeg,
    interpolation:c.axialRule==='rri'?'compact row tents normalized across source-supported directions and turns':'nearest bracketing row centres within finite source-angle support; split coincident endpoints',
    object:'unit-integral ideal point; finite detector cell integrals',filter:'none; no transaxial ramp or FBP preweight',
    angularWeight:'V/2 transverse direction pairs; equivalent to V output directions with angular factor 1/V',
    acquisitionBoundary:'per evaluation plane: beta0 + 2 pi z/h +/- (pi + full fan opening); only acquired-grid views inside; all nonzero rebin stencil views must fit',axialAverageMm:c.axialAverageMm,
    profileReadout:'fixed transverse point; moving axial evaluation; no reconstructed image',scientificScope:'declared geometry and interpolation model; not scanner reconstruction',
    ...(c.zFfsEnabled?{zFfsVersion:ZFFS_VERSION,viewsDefinition:'V total physical acquisitions per turn; within-focus rebinning retained'}:{})};
  const audit={definition:c.zFfsEnabled?'Actual acquired cell weights including within-focus rebinning and T averaging. Paired_samples are an alternative rebinned representation.':'Unfiltered rebinned row weights selected across helix turns, integrated over T; angular mean applied separately.',
    db:1/H,axialAverageMm:c.axialAverageMm,centerValue:raw[(raw.length-1)/2],samples:[...(c.zFfsEnabled?physical:weights).values()],pairedSamples:[...paired.values()]};
  const out={config:c,z,zObject,raw,min,max,baseline,counts:new Uint16Array(z.length).fill(V),sampleAudit,model,volume:null,
    x:Float64Array.of(c.radius),y:Float64Array.of(0),coordinateSystem:c.zFfsEnabled?'zffs-acquired':'rebinned-theta',
    weightAudit:hooks.profileOnly?null:audit,...(c.zFfsEnabled?{rebinnedWeightAudit:hooks.profileOnly?null:[...weights.values()]}:{}),
    acquisition:{firstView:firstAcquired,lastViewExclusive:lastAcquired+1,viewsPerTurn:V,...(c.zFfsEnabled?{viewsPerFocusPerTurn:H}:{}),rebinnedPairsPerSlice:H,candidateSearch:'source-fan-window',centreWindow:axialSourceWindow(c,zObject),averagingWindowStart:axialSourceWindow(c,zObject-c.axialAverageMm/2),averagingWindowEnd:axialSourceWindow(c,zObject+c.axialAverageMm/2),maxBracketGapMm,maxCandidateDistanceMm}};
  if(!(max>baseline))return {...out,geometryOnly:true,reason:'no-acquired-point-response',profiles:[]};
  const profile=Float64Array.from(raw,v=>(v-baseline)/(max-baseline)),fwhm=fdkWidth(z,profile,.5),fwtm=fdkWidth(z,profile,.1);
  if(!fwhm||!fwtm||Math.max(profile[0],profile.at(-1))>.001)throw Error('AXIAL_DOMAIN: extend z range to contain response tails');
  return {...out,profile,fwhm,fwtm};
}
