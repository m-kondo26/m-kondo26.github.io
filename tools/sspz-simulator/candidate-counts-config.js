import {axialResponseConfig} from './axial-response-core.js';

export const MAX_POSITIONS=12;
export const CANDIDATE_START_ANGLES=360;
export const CANDIDATE_DIRECTIONS=360;
const TAU=2*Math.PI;
const DEFAULTS=Object.freeze({rows:4,rowWidth:1,beamPitch:.875,sliceThicknessMm:1,
  sourceRadius:600,radius:100,focalSourceDetectorMm:1070,focalSizeMm:1.2,
  channelWidth:.58,channelApertureMm:.58,viewSamples:360,zStep:.05,phase:0,
  fullFanAngleDeg:50,edgePolicy:'available',normalization:'minmax',axialRule:'rri',
  zFfsEnabled:false,zFfsOffset:.25});

function numeric(value,key,low,high,integer=false){
  if(value===null||typeof value==='boolean'||typeof value==='object')throw Error(`CANDIDATE_SETTINGS: ${key} must be a number`);
  if(typeof value==='string'&&!value.trim())throw Error(`CANDIDATE_SETTINGS: ${key} is empty`);
  const number=Number(value);
  if(!Number.isFinite(number)||number<low||number>high||(integer&&!Number.isInteger(number)))throw Error(`CANDIDATE_SETTINGS: ${key} must be ${integer?'an integer ':''}${low}–${high}`);
  return number;
}
function normalizedSettings(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('CANDIDATE_SETTINGS: settings object required');
  const s={...DEFAULTS,...input};
  for(const [key,lo,hi,integer] of [
    ['rows',1,320,true],['rowWidth',.05,10],['beamPitch',Number.MIN_VALUE,3],
    ['sliceThicknessMm',.1,20],['sourceRadius',100,2000],['radius',0,250],
    ['focalSourceDetectorMm',100,6000],['focalSizeMm',0,5],
    ['channelWidth',.05,1],['channelApertureMm',.01,1],
    ['viewSamples',90,2400,true],['zStep',.01,.2],['phase',0,TAU+1e-10],
    ['fullFanAngleDeg',1,179],['zFfsOffset',0,.5],
  ])s[key]=numeric(s[key],key,lo,hi,integer);
  if(s.viewSamples%2)throw Error('CANDIDATE_SETTINGS: acquired view count must be even');
  if(s.channelApertureMm>s.channelWidth)throw Error('CANDIDATE_SETTINGS: aperture exceeds channel spacing');
  if(s.focalSourceDetectorMm<=s.sourceRadius)throw Error('CANDIDATE_SETTINGS: detector must be beyond isocenter');
  if(!['available','strict'].includes(s.edgePolicy))throw Error('CANDIDATE_SETTINGS: unknown detector-edge policy');
  if(!['minmax','peak'].includes(s.normalization))throw Error('CANDIDATE_SETTINGS: unknown normalization');
  if(!['rri','merged'].includes(s.axialRule))throw Error('CANDIDATE_SETTINGS: choose row or combined two-point interpolation');
  if(![true,false,0,1,'0','1'].includes(s.zFfsEnabled))throw Error('CANDIDATE_SETTINGS: invalid focal-switch flag');
  s.zFfsEnabled=s.zFfsEnabled===true||s.zFfsEnabled===1||s.zFfsEnabled==='1';
  const magnification=s.focalSourceDetectorMm/s.sourceRadius;
  if(s.zFfsEnabled){
    s.zFfsMagnification=numeric(s.zFfsMagnification??magnification,'zFfsMagnification',1+Number.EPSILON,4);
    if(Math.abs(s.zFfsMagnification-magnification)>1e-9*Math.max(1,magnification))throw Error('CANDIDATE_SETTINGS: focal-switch magnification must equal D/R');
  }else s.zFfsMagnification=magnification;
  return Object.fromEntries([...Object.keys(DEFAULTS),'zFfsMagnification'].map(key=>[key,s[key]]));
}

/** Read the same compact query keys written by the simulator's paramsToUrl. */
export function readCandidateSettings(search=''){
  let q=new URLSearchParams(search instanceof URLSearchParams?search.toString():search);
  if(q.has('main'))q=new URLSearchParams(q.get('main'));
  const hasGeometry=['n','d','p','R','r','cp','ca','ff','fd','st','nv','model'].some(key=>q.has(key));
  const number=(key,fallback)=>q.has(key)?numeric(q.get(key),key,-Number.MAX_VALUE,Number.MAX_VALUE):fallback;
  const R=number('R',DEFAULTS.sourceRadius),zFfsEnabled=q.get('zffs')==='1';
  const D=number('fd',q.has('zffs_m')||zFfsEnabled?number('zffs_m',1072/600)*R:DEFAULTS.focalSourceDetectorMm);
  const cp=number('cp',number('fdk_channelWidth',hasGeometry?.25:DEFAULTS.channelWidth));
  const settings={
    rows:number('n',DEFAULTS.rows),rowWidth:number('d',DEFAULTS.rowWidth),
    beamPitch:number('p',DEFAULTS.beamPitch),sliceThicknessMm:number('st',number('t',DEFAULTS.sliceThicknessMm)),
    sourceRadius:R,radius:number('r',DEFAULTS.radius),focalSourceDetectorMm:D,
    focalSizeMm:number('ff',hasGeometry?0:DEFAULTS.focalSizeMm),
    channelWidth:cp,channelApertureMm:number('ca',cp),
    viewSamples:number('nv',number('nt',DEFAULTS.viewSamples)),zStep:number('fdk_zStep',DEFAULTS.zStep),
    phase:number('fdk_phase',DEFAULTS.phase),fullFanAngleDeg:number('fdk_fullFanAngleDeg',DEFAULTS.fullFanAngleDeg),
    edgePolicy:q.get('fdk_edgePolicy')??DEFAULTS.edgePolicy,normalization:q.get('fdk_normalization')??DEFAULTS.normalization,
    axialRule:q.get('model')==='merged'||(!q.has('model')&&q.get('fdk_method')==='merged')?'merged':'rri',
    zFfsEnabled,zFfsMagnification:D/R,zFfsOffset:number('zffs_a',.25),
  };
  return normalizedSettings(settings);
}

/** Same radius-dependent domain expression as readFdkParams in fdk-ui.js. */
export function candidateProfileInput(settings,radius,phase=settings.phase){
  const s=normalizedSettings(settings),r=numeric(radius,'radius',0,250);
  if(!Number.isFinite(phase))throw Error('CANDIDATE_SETTINGS: finite phase required');
  const R=s.sourceRadius,D=s.focalSourceDetectorMm,d=s.rowWidth;
  const focalScale=Math.max(Math.abs(1-(R-r)/D),Math.abs(1-(R+r)/D));
  let zExtent=Math.max(1,s.sliceThicknessMm+2*d*(1+r/R))+s.focalSizeMm*focalScale/2;
  if(s.zFfsEnabled)zExtent+=2*s.zFfsOffset*d/(1-1/s.zFfsMagnification);
  return {...s,radius:r,phase,axialAverageMm:s.sliceThicknessMm,zExtent,
    phaseCount:CANDIDATE_START_ANGLES,state:0,objectModel:'point',
    thicknessMapping:'configured-rectangular',computationModel:'fdk',method:s.axialRule,
    comparisonMode:s.axialRule==='merged'?'legacy':'matched-rri',candidateSearch:'source-fan-window'};
}

export function validateCandidateRequest({settings,radii}={}){
  if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('CANDIDATE_SETTINGS: settings object required');
  const normalized=normalizedSettings(settings);
  if(!Array.isArray(radii)||!radii.length||radii.length>MAX_POSITIONS)throw Error(`CANDIDATE_POSITIONS: choose1–${MAX_POSITIONS} positions`);
  const positions=radii.map(value=>numeric(value,'radius',0,250));
  if(new Set(positions).size!==positions.length)throw Error('CANDIDATE_POSITIONS: duplicate positions');
  for(const radius of positions)axialResponseConfig(candidateProfileInput(normalized,radius,normalized.phase));
  return {settings:normalized,radii:positions};
}

/** Return a query string suitable for linking back to index.html or index-en.html. */
export function candidateSettingsUrl(settings){
  const s=normalizedSettings(settings),q=new URLSearchParams();
  for(const [key,value] of Object.entries({v:20,n:s.rows,d:s.rowWidth,p:s.beamPitch,
    st:s.sliceThicknessMm,R:s.sourceRadius,r:s.radius,ff:s.focalSizeMm,fd:s.focalSourceDetectorMm,
    cp:s.channelWidth,ca:s.channelApertureMm,nv:s.viewSamples,model:s.axialRule,response:'axial-interpolation',
    fdk_zStep:s.zStep,fdk_phase:s.phase,fdk_fullFanAngleDeg:s.fullFanAngleDeg,
    fdk_edgePolicy:s.edgePolicy,fdk_normalization:s.normalization}))q.set(key,value);
  if(s.zFfsEnabled){q.set('zffs','1');q.set('zffs_m',s.zFfsMagnification);q.set('zffs_a',s.zFfsOffset);}
  return '?'+q.toString();
}
