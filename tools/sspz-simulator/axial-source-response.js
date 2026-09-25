import {sourceSupportedAxialWeights,axialSourceWindow,axialSourceStencil} from './axial-source-support.js';
import {cbaCoordinates} from './cba-core.js';
import {detectorPointProjection,detectorRowReadout,focalBlurMetadata} from './detector-aperture.js';
import {fdkSlabMean,fdkSlabCoefficients,fdkWidth} from './fdk-core.js';
import {zffsShift,zffsRebinStencil,zffsRowGeometry,ZFFS_VERSION} from './zffs-geometry.js';
import {zffsPointProjection} from './zffs-response.js';
import {assertAxialRawDomain} from './axial-domain.js';

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

// For a fixed spatial point, y(g)=sum_v K_v g_v where g_v modulates its
// amplitude at the ORIGINAL acquired exposure. K_v is mass per discrete view,
// not a histogram of rebinned row weights and not a continuous-time density.
export function axialTemporalResponse(contributions,viewsPerTurn,centerValue){
  const occupied=[...contributions.entries()].filter(([,value])=>value>0).sort((a,b)=>a[0]-b[0]);
  const first=occupied.length?occupied[0][0]-1:0,last=occupied.length?occupied.at(-1)[0]+1:-1;
  const viewIndices=Int32Array.from({length:last-first+1},(_,i)=>first+i);
  const timeTurns=Float64Array.from(viewIndices,v=>v/viewsPerTurn);
  const raw=Float64Array.from(viewIndices,v=>contributions.get(v)??0);
  let sum=0,peak=0;for(const value of raw){sum+=value;peak=Math.max(peak,value);}
  const profile=Float64Array.from(raw,value=>peak>0?value/peak:0);
  let lower=null,upper=null,cumulative=0;
  if(sum>0)for(let i=0;i<raw.length;i++){
    cumulative+=raw[i];
    if(lower===null&&cumulative>=.05*sum)lower=timeTurns[i];
    if(upper===null&&cumulative>=.95*sum){upper=timeTurns[i];break;}
  }
  return {version:'2026-09-25.1',viewIndices,timeTurns,raw,profile,sum,centerValue,closureError:sum-centerValue,
    binWidthTurns:1/viewsPerTurn,equivalentWidthTurns:peak>0?sum/peak/viewsPerTurn:null,
    equivalentWidthDefinition:'Sampled area divided by peak, assuming uniform one-view bins.',
    coverage90:lower===null?null:{lowerTurns:lower,upperTurns:upper,widthTurns:upper-lower,
      method:'First discrete acquired-view bins reaching cumulative 5% and 95% of positive contribution.'},
    status:peak>0?'ok':'no-point-response',normalization:'peak',
    sampleMeaning:'Discrete acquired-view contribution mass; sum(raw) equals the unnormalized spatial response at the fixed output plane.',
    timeOrigin:'Acquired view 0; timeTurns=view/viewsPerTurn. Negative times and multiple turns are retained without folding.',
    displayGrid:'Uniform acquired-view bin centres, including internal zero bins and one zero bin beyond each positive-support endpoint.',
    definition:'Fixed spatial point amplitude impulse response at the output plane zObject, including physical-cell signal, original-view rebinning coefficients, row interpolation, angular mean and T averaging.',
    modelScope:'Linear reduced axial model before SSP min-max normalization; not an object-independent scanner temporal response, motion simulation or complete image reconstruction.'};
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
      const channel=p.transverse/c.channelWidth+(c.channels-1)/2,j=Math.floor(channel),b=channel-j;
      g.stencil=[{view:v,channel:j,weight:1-b},{view:v,channel:j+1,weight:b}].filter(s=>s.weight>0);
    }else{
      const views=axialSourceStencil(c,g.beta),vf=(g.beta-c.phase)/db;
      const jf=Math.asin(g.t/c.sourceRadius)*c.sourceRadius/c.channelWidth+(c.channels-1)/2,j=Math.floor(jf),b=jf-j;
      if(j<0||j+1>=c.channels)throw Error('CBA_COVERAGE: rebinning outside acquired channels');
      g.stencil=[];
      for(const view of views){
        const w=views.length===1?1:Math.max(0,1-Math.abs(vf-view)),p=rawAt(view);
        if(w*(1-b)>0)g.stencil.push({view,channel:j,weight:w*(1-b)});
        if(w*b>0)g.stencil.push({view,channel:j+1,weight:w*b});
        for(let row=p.k0;row<=p.k1;row++){
          const cell=ch=>ch<p.j0||ch>p.j1?0:p.data[(row-p.k0)*p.width+ch-p.j0];
          values[row]+=w*((1-b)*cell(j)+b*cell(j+1));
        }
      }
    }
    const q={...g,values};rebinnedCache.set(key,q);return q;
  };
  const temporalRow=(q,row)=>{
    q.temporalRows??=new Map();if(q.temporalRows.has(row))return q.temporalRows.get(row);
    const perView=new Map();
    for(const s of q.stencil){
      const p=rawAt(s.view);
      const value=c.zFfsEnabled?(p.data.get(row+':'+s.channel)??0)
        :row<p.k0||row>p.k1||s.channel<p.j0||s.channel>p.j1?0:p.data[(row-p.k0)*p.width+s.channel-p.j0];
      perView.set(s.view,(perView.get(s.view)??0)+s.weight*value);
    }
    const values=[...perView.entries()];q.temporalRows.set(row,values);return values;
  };
  const padded=new Float64Array(zs.length),slab=fdkSlabCoefficients(zs.length,c.zStep,c.axialAverageMm);
  const weights=new Map(),paired=new Map(),physical=new Map(),sampleAudit=[],temporal=new Map();
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
        if(slab[iz]>0){
          const coefficient=slab[iz]*s.weight/H;
          for(const [view,acquiredValue] of temporalRow(q,s.row))if(acquiredValue!==0)
            temporal.set(view,(temporal.get(view)??0)+coefficient*acquiredValue);
        }
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
  const min=Math.min(...raw),max=Math.max(...raw);
  assertAxialRawDomain(raw,max);
  const baseline=c.normalization==='minmax'?min:0;
  const model={version:'2026-09-24.1',kind:'axial-'+c.axialRule,comparisonMode:c.comparisonMode,interpolationRule:c.interpolationRule,focalBlur:focalBlurMetadata(c),algorithm:'reduced axial interpolation response',
    geometry:c.axialRule==='parallel'?'nondivergent parallel reference':'three-dimensional cylindrical cone-ray geometry',
    candidateSearch:'source-fan-window',fullFanAngleDeg:c.fullFanAngleDeg,sourceAngleSpanDeg:c.axialRule==='parallel'&&c.comparisonMode!=='matched-rri'?360:360+2*c.fullFanAngleDeg,
    interpolation:c.interpolationRule==='rri'?'compact row tents normalized across source-supported directions and turns':'nearest bracketing row centres within finite source-angle support; split coincident endpoints',
    object:'unit-integral ideal point; finite detector cell integrals',filter:'none; no transaxial ramp or FBP preweight',
    angularWeight:'V/2 transverse direction pairs; equivalent to V output directions with angular factor 1/V',
    acquisitionBoundary:'per evaluation plane: beta0 + 2 pi z/h +/- (pi + full fan opening); only acquired-grid views inside; all nonzero rebin stencil views must fit',axialAverageMm:c.axialAverageMm,
    profileReadout:'fixed transverse point; moving axial evaluation; no reconstructed image',scientificScope:'declared geometry and interpolation model; not scanner reconstruction',
    ...(c.zFfsEnabled?{zFfsVersion:ZFFS_VERSION,viewsDefinition:'V total physical acquisitions per turn; within-focus rebinning retained'}:{})};
  const audit={definition:c.zFfsEnabled?'Actual acquired cell weights including within-focus rebinning and T averaging. Paired_samples are an alternative rebinned representation.':'Unfiltered rebinned row weights selected across helix turns, integrated over T; angular mean applied separately.',
    db:1/H,axialAverageMm:c.axialAverageMm,centerValue:raw[(raw.length-1)/2],samples:[...(c.zFfsEnabled?physical:weights).values()],pairedSamples:[...paired.values()]};
  const out={config:c,z,zObject,raw,min,max,baseline,counts:new Uint16Array(z.length).fill(V),sampleAudit,model,volume:null,
    temporalResponse:axialTemporalResponse(temporal,V,raw[(raw.length-1)/2]),
    x:Float64Array.of(c.radius),y:Float64Array.of(0),coordinateSystem:c.zFfsEnabled?'zffs-acquired':'rebinned-theta',
    weightAudit:hooks.profileOnly?null:audit,...(c.zFfsEnabled?{rebinnedWeightAudit:hooks.profileOnly?null:[...weights.values()]}:{}),
    acquisition:{firstView:firstAcquired,lastViewExclusive:lastAcquired+1,viewsPerTurn:V,...(c.zFfsEnabled?{viewsPerFocusPerTurn:H}:{}),rebinnedPairsPerSlice:H,candidateSearch:'source-fan-window',centreWindow:axialSourceWindow(c,zObject),averagingWindowStart:axialSourceWindow(c,zObject-c.axialAverageMm/2),averagingWindowEnd:axialSourceWindow(c,zObject+c.axialAverageMm/2),maxBracketGapMm,maxCandidateDistanceMm}};
  if(!(max>baseline))return {...out,geometryOnly:true,reason:'no-acquired-point-response',profiles:[]};
  const profile=Float64Array.from(raw,v=>(v-baseline)/(max-baseline)),fwhm=fdkWidth(z,profile,.5),fwtm=fdkWidth(z,profile,.1);
  if(!fwhm||!fwtm||Math.max(profile[0],profile.at(-1))>.001)throw Error('AXIAL_DOMAIN: extend z range to contain response tails');
  return {...out,profile,fwhm,fwtm};
}
