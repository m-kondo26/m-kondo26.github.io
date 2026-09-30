// Independent numerical audit: enumerate every detector row and eligible helix
// turn rather than reuse the production integer-lattice population formula.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {axialResponseConfig} from '../axial-response-core.js';
import {candidateDensityCountsAt, candidateDensityWindows, computeCandidateDensity,
  computeCandidateDensityFromSeries} from '../candidate-density-core.js';

const SIMULATOR_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const WORKSPACE_PARENT=path.dirname(SIMULATOR_ROOT);
// Research fixtures are optional and are not required by a public checkout.
// An explicitly supplied fixture directory is checked rather than silently
// skipped when its files are missing.
const PROTOTYPE=process.env.SSPZ_DENSITY_FIXTURE_DIR
  ?path.resolve(process.env.SSPZ_DENSITY_FIXTURE_DIR)
  :path.join(WORKSPACE_PARENT,'revision_20260930/candidate_count_position_prototype');
const REPORT=fs.existsSync(path.join(WORKSPACE_PARENT,'revision_20260930'))
  ?path.join(WORKSPACE_PARENT,'revision_20260930/candidate_density_publication/independent_audit.json')
  :path.join(SIMULATOR_ROOT,'output/candidate-density/independent_audit.json');
const TAU=2*Math.PI, EPS=1e-10;
const report={status:'running',scope:'Numerical count audit of the declared rebinned centre geometry; no dose/noise/scanner validation.',
  oracle:'Explicit independent cone/fan formula, finite acquired-source gate, independently derived nonzero stencil, turn and every-row enumeration; no production count/group/stencil helpers.',
  checks:{oracleStates:0,oracleValues:0,nested:0,subset:0,theta180:0,theta360:0,phase360:0,zeroFfs:0,edgeCases:0,frozenFrequencyCells:0},conditions:[]};
const started=performance.now();
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const cfg=input=>axialResponseConfig({rows:4,rowWidth:1,beamPitch:.875,sourceRadius:600,
  viewSamples:2400,state:0,channelWidth:.58,channelApertureMm:.58,focalSizeMm:1.2,
  focalSourceDetectorMm:1070,zExtent:3,zStep:.01,axialAverageMm:1,edgePolicy:'available',
  normalization:'minmax',fullFanAngleDeg:50,comparisonMode:'matched-rri',axialRule:'rri',...input});

function oraclePool(c,thetaDeg,zObject){
  const db=TAU/c.viewSamples,centre=TAU*zObject/c.feed;
  const half=Math.PI+(c.axialRule==='parallel'&&c.comparisonMode!=='matched-rri'?0:c.fullFanAngleDeg*Math.PI/180);
  const betaMin=c.phase+centre-half,betaMax=c.phase+centre+half;
  const firstView=Math.ceil((centre-half)/db-EPS),lastView=Math.floor((centre+half)/db+EPS);
  const map=new Map();
  for(let direction=0;direction<2;direction++){
    const theta=(thetaDeg+direction*180)*Math.PI/180;
    const t=-c.radius*Math.sin(theta),along=c.radius*Math.cos(theta);
    const beta=c.axialRule==='parallel'?theta:theta+Math.asin(t/c.sourceRadius);
    const L=c.axialRule==='parallel'?c.sourceRadius:Math.sqrt(c.sourceRadius**2-t*t)-along;
    const spacing=c.rowWidth*L/c.sourceRadius;
    const rebinnedView=(theta-c.phase)*c.viewSamples/TAU;
    const sourceOrigin=c.feed*(beta-c.phase)/TAU;
    const focalStates=c.zFfsEnabled&&c.zFfsOffset!==0?2:1;
    for(let focus=0;focus<focalStates;focus++){
      const offset=c.zFfsEnabled?(focus===0?-1:1)*c.zFfsSourceOffsetMm:0;
      const origin=sourceOrigin+offset*(1-L/c.zFfsSourceDetectorMm||0);
      const middleTurn=Math.round((c.phase+centre-beta)/TAU);
      // A deliberately broad, fixed turn search followed by explicit gates.
      for(let turn=middleTurn-3;turn<=middleTurn+3;turn++){
        const actualBeta=beta+turn*TAU;
        if(actualBeta<betaMin-TAU*EPS||actualBeta>betaMax+TAU*EPS)continue;
        const vf=(actualBeta-c.phase)/db,stride=focalStates===2?2:1,gridOrigin=stride===2?focus:0;
        const q=(vf-gridOrigin)/stride,nearest=Math.round(q);
        const stencil=Math.abs(q-nearest)<EPS?[gridOrigin+stride*nearest]
          :[gridOrigin+stride*Math.floor(q),gridOrigin+stride*(Math.floor(q)+1)];
        if(stencil[0]<firstView||stencil.at(-1)>lastView)continue;
        for(let row=0;row<c.rows;row++){
          const z=origin+turn*c.feed+(row-(c.rows-1)/2)*spacing-zObject;
          const key=(rebinnedView+turn*c.viewSamples).toFixed(8)+':'+focus+':'+row;
          const previous=map.get(key);
          if(previous){assert.ok(Math.abs(previous.z-z)<1e-8,'duplicate identity has same row centre');previous.roles.add(direction);}
          else map.set(key,{key,z,roles:new Set([direction]),stencil,actualBeta,firstView,lastView});
        }
      }
    }
  }
  return [...map.values()];
}
function oracleCounts(c,theta,zObject,windows){
  const points=oraclePool(c,theta,zObject),out={direct:{fwhm:0,fwtm:0},combined:{fwhm:0,fwtm:0}};
  for(const p of points)for(const name of ['fwhm','fwtm']){
    const w=windows[name]??windows[name.toUpperCase()];
    if(p.z>=w.left-EPS&&p.z<=w.right+EPS){out.combined[name]++;if(p.roles.has(0))out.direct[name]++;}
  }
  return out;
}
function checked(c,theta,zObject,windows,label){
  const actual=candidateDensityCountsAt(c,theta,zObject,windows),expected=oracleCounts(c,theta,zObject,windows);
  assert.deepEqual(actual,expected,label);report.checks.oracleStates++;report.checks.oracleValues+=4;
  for(const pool of ['direct','combined']){assert.ok(actual[pool].fwhm<=actual[pool].fwtm,label+' nested');report.checks.nested++;}
  for(const name of ['fwhm','fwtm']){assert.ok(actual.direct[name]<=actual.combined[name],label+' subset');report.checks.subset++;}
  return actual;
}
function symmetries(c,theta,zObject,windows,label){
  const a=checked(c,theta,zObject,windows,label),b=checked(c,theta+180,zObject,windows,label+' theta+180');
  assert.deepEqual(a.combined,b.combined,label+' combined PI-pair equivalence');
  for(const name of ['fwhm','fwtm'])assert.equal(a.direct[name]+b.direct[name],a.combined[name],label+' direct role exchange');
  report.checks.theta180++;
  assert.deepEqual(candidateDensityCountsAt(c,theta+360,zObject,windows),a,label+' theta periodicity');report.checks.theta360++;
  assert.deepEqual(candidateDensityCountsAt({...c,phase:c.phase+TAU},theta,zObject,windows),a,label+' phase periodicity');report.checks.phase360++;
}
function hist(values){const out=new Map();for(const v of values)out.set(v,(out.get(v)??0)+1);return [...out].sort((a,b)=>a[0]-b[0]);}
function countStats(values){let sum=0,sum2=0,min=Infinity,max=-Infinity;for(const v of values){sum+=v;sum2+=v*v;min=Math.min(min,v);max=Math.max(max,v);}
  const mean=sum/values.length;return {n:values.length,mean,min,max,sd:Math.sqrt(Math.max(0,sum2/values.length-mean**2))};}

async function audit(){
  report.coreSha256=hash(path.join(SIMULATOR_ROOT,'candidate-density-core.js'));
  const windowsFile=path.join(PROTOTYPE,'windows.json'),legacyFile=path.join(PROTOTYPE,'counts.json');
  const hasFrozenFixtures=fs.existsSync(windowsFile)&&fs.existsSync(legacyFile);
  if(process.env.SSPZ_DENSITY_FIXTURE_DIR)assert.ok(hasFrozenFixtures,'SSPZ_DENSITY_FIXTURE_DIR must contain windows.json and counts.json');
  if(hasFrozenFixtures){
  const windowData=JSON.parse(fs.readFileSync(windowsFile,'utf8')),legacy=JSON.parse(fs.readFileSync(legacyFile,'utf8'));
  const manifestPath=windowData.sourceManifest
    ??path.join(path.dirname(path.dirname(PROTOTYPE)),'revision_20260924/matched_geometry/sweep_manifest.json');
  const manifest=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):{base:{},modelVersion:legacy.modelVersion};
  report.frozenFixture={status:'run',directory:PROTOTYPE,windowsSha256:hash(windowsFile),countsSha256:hash(legacyFile),modelVersion:manifest.modelVersion,
    comparison:'Combined full 360-direction integer frequencies equal two copies of the frozen 180-direction PMF. Old ungated real-only prototype deliberately not used as a comparator.'};
  for(const job of windowData.conditions){
    const c=cfg({...manifest.base,radius:job.radiusMm,axialAverageMm:job.Tmm}),w=job.windows;
    const derived=candidateDensityWindows({z:job.z,mean:job.meanProfile});
    for(const name of ['fwhm','fwtm'])for(const side of ['left','right'])assert.ok(Math.abs(derived[name][side]-w[name.toUpperCase()][side])<1e-12,'Frozen response crossing '+side);
    const current=await computeCandidateDensity(c,w,{includeCounts:true});
    assert.equal(current.sampleCount,129600,'ONE direction in each 360 x 360 state');
    assert.equal(current.config.phase,c.phase,'input configuration remains unchanged');
    const local={radiusMm:job.radiusMm,Tmm:job.Tmm,states:0,statistics:{}};
    for(let start=0;start<360;start++){
      const state={...c,phase:start*Math.PI/180};
      for(let theta=0;theta<360;theta++){
        const index=start*360+theta,expected=checked(state,theta,0,w,`frozen r${job.radiusMm} T${job.Tmm} phase${start} theta${theta}`);
        for(const pool of ['direct','combined'])for(const name of ['fwhm','fwtm'])assert.equal(current.groups[pool][name].counts[index],expected[pool][name],'stored full-state count parity');
        local.states++;
        if(start%30===0&&theta%45===0)symmetries(state,theta,0,w,'frozen symmetry');
      }
    }
    const old=legacy.results.find(j=>j.radiusMm===job.radiusMm&&j.Tmm===job.Tmm);
    for(const name of ['fwhm','fwtm']){
      const oldHist=hist(old.counts[name.toUpperCase()]),newHist=hist(current.groups.combined[name].counts);
      assert.deepEqual(newHist,oldHist.map(([count,n])=>[count,2*n]),'exact frozen combined histogram parity');
      report.checks.frozenFrequencyCells+=oldHist.length;
      for(const pool of ['direct','combined']){
        const g=current.groups[pool][name],s=countStats(g.counts);
        assert.ok(Math.abs(s.mean-g.mean)<1e-12&&Math.abs(s.sd-g.sd)<1e-12,'stored moments');
        assert.equal(g.n,129600);assert.equal(g.frequencies.reduce((n,p)=>n+p.frequency,0),129600);
        assert.ok(Math.abs(g.frequencies.reduce((n,p)=>n+p.fraction,0)-1)<1e-12,'normalized frequencies');
        local.statistics[pool+'_'+name]=s;
      }
    }
    report.conditions.push(local);console.log(JSON.stringify({fixture:'frozen',radius:job.radiusMm,T:job.Tmm,states:local.states,pass:true}));
  }
  }else report.frozenFixture={status:'skipped',reason:'Optional research windows.json/counts.json are absent; portable independent tests still run.',directory:PROTOTYPE};

  const w={fwhm:{left:-.731,right:.839},fwtm:{left:-3.121,right:3.409}};
  // The public checkout also exercises a successful asynchronous aggregation,
  // start-major ordering, and histogram closure without external fixtures.
  const portableConfig=cfg({radius:102,state:.35}),portable=await computeCandidateDensity(portableConfig,w,{angleSamples:24,startSamples:24,includeCounts:true});
  assert.equal(portable.sampleCount,576);assert.equal(portable.zObject,.35*portableConfig.feed);
  for(let start=0;start<24;start++)for(let angle=0;angle<24;angle++){
    const expected=checked({...portableConfig,phase:start*TAU/24},angle*360/24,portable.zObject,w,'portable asynchronous count/order');
    for(const pool of ['direct','combined'])for(const name of ['fwhm','fwtm'])assert.equal(portable.groups[pool][name].counts[start*24+angle],expected[pool][name]);
  }
  for(const pool of ['direct','combined'])for(const name of ['fwhm','fwtm']){
    const g=portable.groups[pool][name],s=countStats(g.counts);
    assert.equal(g.n,576);assert.ok(Math.abs(g.mean-s.mean)<1e-12&&Math.abs(g.sd-s.sd)<1e-12);
    assert.equal(g.frequencies.reduce((sum,p)=>sum+p.frequency,0),576);
  }
  report.portableAggregation={angleSamples:24,startSamples:24,states:576,state:.35,pass:true};
  for(const rows of [1,4,320])for(const zFfsOffset of [null,0,.25,.5]){
    const c=cfg({rows,rowWidth:rows===320?.5:1,radius:102,zFfsEnabled:zFfsOffset!==null,...(zFfsOffset===null?{}:{zFfsOffset})});
    let states=0;
    for(const start of [0,17,89,179,270,359])for(const theta of [0,.037,23,89.999,90,140,179.999,180,271.125,359.999])for(const state of [0,.35,-.7]){
      const cc={...c,phase:start*Math.PI/180,state},zObject=state*c.feed;
      symmetries(cc,theta,zObject,w,`rows${rows} ffs${zFfsOffset} phase${start} theta${theta} state${state}`);states++;
      if(zFfsOffset===0){assert.deepEqual(candidateDensityCountsAt(cc,theta,zObject,w),candidateDensityCountsAt({...cc,zFfsEnabled:false},theta,zObject,w),'zero-offset FFS does not duplicate trajectory');report.checks.zeroFfs++;}
    }
    report.conditions.push({rows,zFfsOffset,states,explicitEveryRow:true,pass:true});
  }

  // Solve beta(theta) for the acquired-grid edge; both stencil endpoints have
  // to fit, and a fractional rebin just beyond the edge must be excluded.
  const edge=cfg({radius:102}),wide={fwhm:{left:-1000,right:1000},fwtm:{left:-2000,right:2000}};
  const betaOf=t=>t+Math.asin(-edge.radius*Math.sin(t)/edge.sourceRadius);
  const thetaOf=beta=>{let t=beta;for(let i=0;i<20;i++){
    const h=1e-6,derivative=(betaOf(t+h)-betaOf(t-h))/(2*h);t-=(betaOf(t)-beta)/derivative;}return t*180/Math.PI;};
  const half=Math.PI+edge.fullFanAngleDeg*Math.PI/180,db=TAU/edge.viewSamples;
  const firstView=Math.ceil(-half/db-EPS),lastView=Math.floor(half/db+EPS);
  for(const sourceView of [firstView-1e-5,firstView,firstView+1e-5,lastView-1e-5,lastView,lastView+1e-5]){
    const theta=thetaOf(edge.phase+sourceView*db),got=checked(edge,theta,0,wide,'acquired source edge '+sourceView);
    // The neighbouring helix turn remains available at this overlap edge;
    // the edge turn contributes one additional all-row group only inside.
    const expectedDirect=edge.rows*(sourceView<firstView||sourceView>lastView?1:2);
    assert.equal(got.direct.fwtm,expectedDirect,'complete source stencil at edge');report.checks.edgeCases++;
  }
  // Exact count inclusion on a detector-row centre and either side of its
  // tolerance is also checked by the enumerator (not rounded row indices).
  for(const p of oraclePool(edge,73,0).slice(0,8))for(const delta of [-2e-10,0,2e-10]){
    const left=p.z+delta;
    checked(edge,73,0,{fwhm:{left,right:left+.0001},fwtm:{left:left-.0001,right:left+.0002}},'row/window edge');report.checks.edgeCases++;
  }

  // Native-mm mean crossings remain offset from zero. No width normalization
  // or per-profile midpoint alignment is allowed in this count window.
  const z=Float64Array.from({length:401},(_,i)=>-4+i*.02),mean=Float64Array.from(z,v=>.3+2*Math.exp(-.5*((v-.37)/.8)**2));
  const native=candidateDensityWindows({z,mean});
  assert.ok(Math.abs((native.fwhm.left+native.fwhm.right)/2-.37)<.001,'native mean retains its coordinate origin');
  const normalized=Array.from(mean,v=>(v-Math.min(...mean))/(Math.max(...mean)-Math.min(...mean)));
  function crossing(level,left){let peak=normalized.indexOf(Math.max(...normalized));
    if(left){for(let i=peak;i>0;i--)if(normalized[i-1]<level&&normalized[i]>=level)return z[i-1]+(level-normalized[i-1])*(z[i]-z[i-1])/(normalized[i]-normalized[i-1]);}
    else{for(let i=peak;i<z.length-1;i++)if(normalized[i]>=level&&normalized[i+1]<level)return z[i]+(level-normalized[i])*(z[i+1]-z[i])/(normalized[i+1]-normalized[i]);}
    throw Error('crossing missing');}
  for(const [name,level] of [['fwhm',.5],['fwtm',.1]]){assert.ok(Math.abs(native[name].left-crossing(level,true))<1e-12);assert.ok(Math.abs(native[name].right-crossing(level,false))<1e-12);}
  assert.throws(()=>candidateDensityWindows({z,mean:new Float64Array(z.length)}),/no response/);
  assert.throws(()=>candidateDensityCountsAt(edge,0,0,{fwhm:{left:-3,right:3},fwtm:{left:-2,right:2}}),/contain/);
  await assert.rejects(()=>computeCandidateDensity({...edge,rows:321},w),/GEOMETRY/);
  await assert.rejects(()=>computeCandidateDensity({...edge,candidateSearch:'one-turn'},w),/SUPPORT/);
  await assert.rejects(()=>computeCandidateDensityFromSeries({config:edge,z,mean,profiles:[{}]}),/360 start/);
  await assert.rejects(()=>computeCandidateDensity(edge,w,{cancelled:()=>true}),/CANCELLED/);
  assert.equal(hash(path.join(SIMULATOR_ROOT,'candidate-density-core.js')),report.coreSha256,'core unchanged while audit ran');
  report.status='pass';report.elapsedSeconds=(performance.now()-started)/1000;
  fs.mkdirSync(path.dirname(REPORT),{recursive:true});fs.writeFileSync(REPORT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,checks:report.checks,elapsedSeconds:report.elapsedSeconds,report:REPORT}));
}
try{await audit();}catch(error){report.status='fail';report.failure=String(error.stack??error);report.elapsedSeconds=(performance.now()-started)/1000;
  fs.mkdirSync(path.dirname(REPORT),{recursive:true});fs.writeFileSync(REPORT,JSON.stringify(report,null,2));throw error;}
