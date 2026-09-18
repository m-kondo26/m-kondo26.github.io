import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {moriStaticConfig,moriStaticView,moriStaticGrid,moriStaticCalculate,moriStaticCalculateSteps} from '../mori-static-core.js';

let checks=0;
const near=(a,b,tol,label)=>{assert.ok(Math.abs(a-b)<=tol,`${label}: ${a} vs ${b}`);checks++;};
const hash=result=>{
  const h=createHash('sha256');h.update(Buffer.from(result.z.buffer));
  for(const group of result.groups)for(const p of group.profiles){
    h.update(Buffer.from(p.raw.buffer));h.update(Buffer.from(p.profile.buffer));
  }
  return h.digest('hex');
};

// Saved from static core 2026-09-18.2, before geometry-allocation optimization.
assert.equal(hash(moriStaticCalculate()),'692949928e9081cec5d4f0b401687d3a39e0cb0ad5f9cd250a622efcd8848389');checks++;

// Independent nearest-bracketing search among physical detector centres.
// This does not use the core's analytic row-index selection formula.
function oracle(c,row,radius){
  const plane=(row-(c.rows-1)/2)*c.rowPitch;
  let area=0,first=0,second=0,edge=0;
  for(let i=0;i<c.viewSamples;i++){
    const beta=i*2*Math.PI/c.viewSamples;
    const L=Math.sqrt(c.sourceRadius**2+radius**2-2*c.sourceRadius*radius*Math.cos(beta));
    const scale=L/c.sourceRadius,aperture=c.axialAperture*scale;
    const blur=c.focalSizeMm*Math.abs(1-L/c.detectorDistance),W=(c.sourceRadius/L)**2;
    const centres=Array.from({length:c.rows},(_,k)=>(k-(c.rows-1)/2)*c.rowPitch*scale);
    let selected;
    if(plane<centres[0]-1e-10){selected=[[0,1]];edge++;}
    else if(plane>centres.at(-1)+1e-10){selected=[[c.rows-1,1]];edge++;}
    else{
      let hi=0;while(hi<c.rows-1&&centres[hi]<plane)hi++;
      if(hi===0)selected=[[0,1]];
      else {const t=(plane-centres[hi-1])/(centres[hi]-centres[hi-1]);selected=[[hi-1,1-t],[hi,t]];}
    }
    for(const [k,w] of selected){
      const mass=aperture*w*W/c.viewSamples;
      area+=mass;first+=mass*centres[k];second+=mass*(centres[k]**2+(aperture**2+blur**2)/12);
    }
  }
  return {area,centroid:first/area,variance:second/area-(first/area)**2,edge};
}

for(const rows of [1,4,80,160,320]){
  const c=moriStaticConfig({rows,rowPitch:.5,axialAperture:.5,viewSamples:360,radii:[0,80,160]});
  const result=moriStaticCalculate(c),z=result.z;
  assert.equal(result.config.rows,rows);assert.equal(result.groups.length,c.radii.length);checks+=2;
  for(const group of result.groups){
    assert.equal(group.profiles.length,rows);checks++;
    for(const p of group.profiles){
      const area=p.profile.reduce((s,v)=>s+v*c.zStep,0);
      near(area,1,2e-11,'every row area one');
      assert.ok(p.profile.every(v=>Number.isFinite(v)&&v>=0));checks++;
      assert.equal(p.profile[0],0);assert.equal(p.profile.at(-1),0);checks+=2;
      assert.ok(Number.isFinite(p.fwhm)&&p.fwhm>0);checks++;
      assert.ok(p.edgeCount>=0&&p.edgeCount<c.viewSamples);checks++;
      near(p.zPlane,(p.row-(rows-1)/2)*.5,0,'configured row plane');
      const opposite=group.profiles[rows-1-p.row];
      near(p.centroid,-opposite.centroid,2e-11,'opposite row centroid');
      near(p.fwhm,opposite.fwhm,1e-9,'opposite row width');
    }
    for(const row of new Set([0,Math.floor(rows/2),rows-1])){
      const p=group.profiles[row],ref=oracle(c,row,group.radius);
      near(p.area,ref.area,2e-11,'independent mixture area');
      near(p.centroid,ref.centroid,3e-11,'independent mixture centroid');
      near(p.sigma**2,ref.variance,5e-10,'independent mixture variance');
      assert.equal(p.edgeCount,ref.edge);checks++;
    }
  }
  for(const angleDeg of [0,73,180,359]){
    const v=moriStaticView(c,{row:rows-1,radius:160,angleDeg});
    assert.equal(v.rowCentres.length,rows);assert.equal(v.detectorRowCentres.length,rows);checks+=2;
    near(v.selected.reduce((s,p)=>s+p.weight,0),1,1e-12,'selected weights');
    near(v.detectorRowCentres[0],-(rows-1)*.5/2*1070/600,1e-12,'physical low row centre');
    near(v.detectorRowCentres.at(-1),(rows-1)*.5/2*1070/600,1e-12,'physical high row centre');
    for(const s of v.selected){
      assert.ok(s.row>=0&&s.row<rows);checks++;
      near(s.apertureMm,.5*v.transverseDistance/600,1e-14,'local aperture width');
      assert.ok(z[0]<s.zCentre-(s.apertureMm+s.focalBlurMm)/2);checks++;
      assert.ok(z.at(-1)>s.zCentre+(s.apertureMm+s.focalBlurMm)/2);checks++;
    }
    if(rows>1){
      near(v.detectorRowCentres[1]-v.detectorRowCentres[0],.5*1070/600,3e-14,'physical detector pitch');
      near(v.rowCentres[1]-v.rowCentres[0],.5*v.transverseDistance/600,2e-14,'local row pitch');
    }
  }
  const steps=moriStaticCalculateSteps(c);let done,count=0;
  do{
    done=steps.next();
    if(!done.done){
      assert.equal(done.value.completed,++count);assert.equal(done.value.total,rows*c.radii.length);checks+=2;
      assert.equal(done.value.row,(count-1)%rows);checks++;
    }
  }while(!done.done);
  assert.equal(count,rows*c.radii.length);checks++;
  assert.equal(hash(done.value),hash(result));checks++;
  if(rows===320){assert.equal(hash(result),'f417b0d3bf89e4bf9a1c2ee5db061a728d1beb1dfb91f2bc7f81d45419ee873d');checks++;}
}

// Supported single-row and unequal aperture/pitch cases preserve their input;
// aperture width must not be substituted for the spacing between row centres.
const separated=moriStaticConfig({rows:4,rowPitch:1,axialAperture:.5,focalSizeMm:0,radii:[0],viewSamples:360});
const separateResult=moriStaticCalculate(separated);
for(const p of separateResult.groups[0].profiles)near(p.fwhm,.5,1e-10,'aperture differs from row pitch');
near(separateResult.groups[0].profiles[1].zPlane-separateResult.groups[0].profiles[0].zPlane,1,0,'plane spacing');
for(const rows of [0,321,1.5]){assert.throws(()=>moriStaticConfig({rows}),/rows/);checks++;}
assert.throws(()=>moriStaticGrid({rows:320,rowPitch:20,axialAperture:20,zStep:.01}),/50001/);checks++;
console.log(`PASS mori-static-rows: ${checks} checks for 1/4/80/160/320 rows, physical spacing, full support, moments, edges, exact generator parity and historical hashes`);
