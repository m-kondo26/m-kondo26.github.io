// Display-only audit. Reuse the numerical model's candidate selectors and
// piecewise-linear T integral; never reconstruct a substitute SSP for playback.
import {axialPairWeights} from './axial-response-core.js';
import {cbaCoordinates} from './cba-core.js';
import {zffsCandidateWeights} from './zffs-response.js';
import {zffsShift} from './zffs-geometry.js';

export function axialAnimationGroups(c,view){
  const V=c.viewSamples,groups=[];
  for(let direction=0;direction<2;direction++){
    const v=view+direction*V/2,theta=c.phase+v*(2*Math.PI/V);
    const q=c.axialRule==='parallel'?{sourceZ:c.feed*v/V,L:c.sourceRadius}:cbaCoordinates(c,theta,c.radius,0,0);
    for(let focus=0;focus<(c.zFfsEnabled?2:1);focus++){
      const origin=q.sourceZ+(c.zFfsEnabled?zffsShift(c,focus)*(1-q.L/c.zFfsSourceDetectorMm):0);
      groups.push({...q,origin,sourceZ:origin,spacing:c.rowWidth*q.L/c.sourceRadius,view:v,focus,direction});
    }
  }
  return groups;
}

// Coefficients of (1/T) integral A(u) du from -T/2 to upper. The denominator
// stays T while accumulating: partial sums are not independently normalized.
export function axialAnimationIntegralCoefficients(c,upper){
  const T=c.axialAverageMm,padding=Math.ceil(T/(2*c.zStep));
  const length=c.zSamples+2*padding,mid=(length-1)/2,out=new Float64Array(length);
  if(T===0){out[mid]=1;return out;}
  const lo=mid-T/(2*c.zStep),hi=mid+Math.max(-T/2,Math.min(T/2,upper))/c.zStep;
  for(let i=Math.floor(lo);i<Math.ceil(hi);i++){
    const a=Math.max(0,lo-i),b=Math.min(1,hi-i);
    if(b<=a)continue;
    const right=(b*b-a*a)/2;
    out[i]+=c.zStep*(b-a-right)/T;out[i+1]+=c.zStep*right/T;
  }
  return out;
}

export async function createAxialAnimationAudit(c,{frameCount=41,maxAngles=72,cancelled=()=>false}={}){
  const V=c.viewSamples,half=V/2,db=2*Math.PI/V,z0=c.state*c.feed,T=c.axialAverageMm;
  const base=Math.ceil((2*Math.PI*z0/c.feed-Math.PI)/db-1e-12);
  // A half-turn must preserve the display lattice, otherwise one role of the
  // same datum could be dropped and a "both" datum misclassified as one-sided.
  let stride=Math.max(1,Math.ceil(V/maxAngles));while(half%stride!==0)stride++;
  const totalCoefficients=axialAnimationIntegralCoefficients(c,T/2),mid=(totalCoefficients.length-1)/2;
  const groupCache=new Map(),nodePoints=new Map();
  const key=p=>`${p.referenceView}:${p.direction}:${p.focus}:${p.row}`;
  const dataKey=p=>`${p.view}:${p.focus}:${p.row}`;
  const groupsAt=v=>{if(!groupCache.has(v))groupCache.set(v,axialAnimationGroups(c,v));return groupCache.get(v);};
  const pointsAt=(u,z=z0+u)=>{
    const start=Math.ceil((2*Math.PI*z/c.feed-Math.PI)/db-1e-12),points=[];
    const first=base+Math.ceil((start-base)/stride)*stride;
    for(let v=first;v<start+half;v+=stride){
      const groups=groupsAt(v),ws=c.zFfsEnabled?zffsCandidateWeights(c,groups,z):axialPairWeights(c,groups[0],groups[1],z);
      for(const s of ws)points.push({referenceView:v,view:v+s.direction*half,direction:s.direction,focus:s.focus??0,row:s.row,z:s.z-z0,weight:s.weight});
    }
    return points;
  };
  let yielded=performance.now();
  for(let i=0;i<totalCoefficients.length;i++)if(totalCoefficients[i]>0){
    if(cancelled())throw Error('ANIMATION_CANCELLED');
    // Use exactly the original numerical lattice expression. At an angular
    // interval boundary, algebraically equivalent floating-point expressions
    // can move a ceil() boundary by one view.
    const z=z0-c.zExtent+(i-Math.ceil(T/(2*c.zStep)))*c.zStep;
    nodePoints.set(i,pointsAt(z-z0,z));
    if(performance.now()-yielded>20){await new Promise(resolve=>setTimeout(resolve,0));yielded=performance.now();}
  }
  const integrate=coefficients=>{
    const map=new Map();
    for(const [i,points] of nodePoints){const coefficient=coefficients[i];if(!coefficient)continue;
      for(const p of points){const k=key(p);if(!map.has(k))map.set(k,{...p,weight:0});map.get(k).weight+=coefficient*p.weight;}
    }
    return [...map.values()];
  };
  const total=integrate(totalCoefficients),roles=new Map();
  for(const p of total){const k=dataKey(p);if(!roles.has(k))roles.set(k,[0,0]);roles.get(k)[p.direction]+=p.weight;}
  const classify=points=>points.map(p=>{
    const weights=roles.get(dataKey(p))??[0,0];
    return {...p,directWeight:weights[0],complementaryWeight:weights[1],use:weights[0]>0&&weights[1]>0?'both':weights[0]>0?'direct':'complementary'};
  });
  const frames=[];
  for(let i=0;i<frameCount;i++){
    if(cancelled())throw Error('ANIMATION_CANCELLED');
    const fraction=frameCount===1?1:i/(frameCount-1),u=frameCount===1?0:T*(fraction-.5);
    frames.push({u,fraction,instant:classify(pointsAt(u)),accumulated:classify(frameCount===1?total:integrate(axialAnimationIntegralCoefficients(c,u)))});
    if(performance.now()-yielded>20){await new Promise(resolve=>setTimeout(resolve,0));yielded=performance.now();}
  }
  return {config:c,zObject:z0,base,stride,frames,total:classify(total),angleSamplesPerTurn:Math.ceil(V/stride),
    xHalfSpan:Math.max(T/2+2*c.rowWidth*(1+c.radius/c.sourceRadius)+(c.zFfsEnabled?2*c.zFfsSourceOffsetMm:0),1),
    coordinate:'common direct-side rebinned angle; opposing data at theta+pi',
    definition:'Display-angle subset only; exact native-grid integral coefficients; partial integral divided by full T; SSP from original full-view calculation.'};
}
