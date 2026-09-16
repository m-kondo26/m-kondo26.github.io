import assert from 'node:assert/strict';
import {detectorCellMembership,detectorRowReadout} from '../detector-aperture.js';
import {DEFAULT_PARAMS,validateParams,axialDetectorProjection,computeProfileModel} from '../sim-core.js';
import {fdkConfig,fdkPointProjection,fdkArcProjection,reconstructFdk} from '../fdk-core.js';
import {reconstructCba} from '../cba-core.js';
const near=(a,b,t=1e-10)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=t,`${a} vs ${b}; tolerance ${t}`);
assert.deepEqual(detectorCellMembership(0,.25,.25,8),[[3,.5],[4,.5]]);
assert.deepEqual(detectorCellMembership(0,.25,.2,8),[]);
assert.deepEqual(detectorCellMembership(.125,.25,.2,8),[[4,1]]);
assert.deepEqual(detectorCellMembership(1,.25,.25,8),[[7,.5]]);
assert.throws(()=>detectorCellMembership(0,.25,.3,8),/APERTURE/);
const samples=[];
for(const radius of [0,102,250])for(const aperture of [.2,.25])for(const beta of [0,.73,2.4]){
  const p=validateParams({...DEFAULT_PARAMS,radius,channelWidth:.25,channelApertureMm:aperture,detectorModel:'finite-channel'});
  const objectZ=.91,turn=0;
  const a=axialDetectorProjection(p,objectZ,beta,turn,true);
  const c=fdkConfig({...p,objectModel:'point'}),b=fdkPointProjection(c,beta,objectZ);
  // Independent physical-coordinate channel readout of the 3D projection.
  const q=b.transverse/c.channelWidth+(c.channels-1)/2,j=Math.floor(q),alpha=q-j;
  const get=(k,r)=>k<b.j0||k>b.j1||r<b.k0||r>b.k1?0:b.data[(r-b.k0)*b.width+k-b.j0];
  for(let row=0;row<p.rows;row++)near(detectorRowReadout(a.config,a.projection,row),(1-alpha)*get(j,row)+alpha*get(j+1,row),1e-11);
  // Delta mass times independently derived solid-angle Jacobian. Gaps and
  // truncated rows legitimately acquire less than unit angular point mass.
  if(b.data.length && b.width===1 && b.height===1){
    const L=Math.hypot(c.sourceRadius*Math.cos(beta)-radius,c.sourceRadius*Math.sin(beta));
    const dz=objectZ-c.feed*beta/(2*Math.PI),w=c.sourceRadius*dz/L;
    const jac=c.sourceRadius**2/(c.sourceRadius**2+w*w)**1.5;
    near(b.data[0]*(aperture/c.sourceRadius)*c.rowWidth*jac,1/(L*L+dz*dz),1e-16);
  }
}
// Independent literal axial operator. No production aperture, selection or
// integration helpers: enumerate rows/turns and interpolate each query.
function literal(p,objectZ,x,cone){
  const R=p.sourceRadius,feed=p.rows*p.rowWidth*p.beamPitch,K=p.filterSamples;
  let total=0;
  for(let v=0;v<p.viewSamples;v++){
    const beta=2*Math.PI*v/p.viewSamples,L=cone?Math.hypot(R*Math.cos(beta)-p.radius,R*Math.sin(beta)):R;
    const u=cone?R*Math.atan2(-p.radius*Math.sin(beta),R-p.radius*Math.cos(beta)):-p.radius*Math.sin(beta);
    const cell=u/p.channelWidth-.5,j=Math.floor(cell),alpha=cell-j;
    const member=t=>Math.abs(t)<1e-10?.5:t<0?1:0;
    const channelRead=(1-alpha)*member(Math.abs(u-(j+.5)*p.channelWidth)-p.channelApertureMm/2)+alpha*member(Math.abs(u-(j+1.5)*p.channelWidth)-p.channelApertureMm/2);
    const points=[];
    for(let turn=-6;turn<=6;turn++)for(let row=0;row<p.rows;row++){
      const zs=feed*(v/p.viewSamples+turn),w=R*(objectZ-zs)/L;
      const rowCenter=(row-(p.rows-1)/2)*p.rowWidth;
      const signal=(cone?Math.hypot(R,w)/(L*L*(p.channelApertureMm/R)*p.rowWidth):1/(p.channelApertureMm*p.rowWidth))*channelRead*member(Math.abs(w-rowCenter)-p.rowWidth/2);
      points.push({z:zs+rowCenter*L/R,y:signal});
    }
    points.sort((a,b)=>a.z-b.z);
    const knots=[];
    for(let i=0;i<points.length;){let n=1,sum=points[i].y;while(i+n<points.length&&Math.abs(points[i+n].z-points[i].z)<1e-10)sum+=points[i+n++].y;knots.push({z:points[i].z,y:sum/n});i+=n;}
    for(let k=-(K-1)/2;k<=(K-1)/2;k++){
      const z=objectZ+x+k*p.filterWidthMm/K;
      const hi=knots.findIndex(q=>q.z>=z),lo=hi-1;
      assert.ok(lo>=0&&hi<knots.length);
      const f=(z-knots[lo].z)/(knots[hi].z-knots[lo].z);
      total+=((1-f)*knots[lo].y+f*knots[hi].y)/(K*p.viewSamples);
    }
  }
  return total;
}
for(const coneOn of [false,true])for(const aperture of [.2,.25]){
  const p={...DEFAULT_PARAMS,radius:102,channelWidth:.25,channelApertureMm:aperture,detectorModel:'finite-channel',viewSamples:90,zSamples:300,filterSamples:33,reconstructionPath:'direct-full-scan'};
  const s=computeProfileModel(p,{coneOn,state:.31});let maxError=0;
  for(let i=20;i<s.z.length;i+=43){const expected=literal(p,s.zObject,s.z[i],coneOn);maxError=Math.max(maxError,Math.abs(s.rawProfile[i]-expected));near(s.rawProfile[i],expected,1e-9);}
  samples.push({coneOn,aperture,rawOracleMaxError:maxError,fwhm:s.fwhm});
}
const common={...DEFAULT_PARAMS,radius:102,detectorModel:'finite-channel',viewSamples:360,zSamples:800};
const a=computeProfileModel({...common,channelApertureMm:.25},{coneOn:true,state:.31});
const b=computeProfileModel({...common,channelApertureMm:.15},{coneOn:true,state:.31});
const maxShapeChange=Math.max(...a.profile.map((v,i)=>Math.abs(v-b.profile[i])));
assert.ok(maxShapeChange>.001,'Aperture must affect normalized axial shape, not just metadata or gain');
const empty=computeProfileModel({...common,radius:0,channelApertureMm:.2},{coneOn:true});
assert.equal(empty.profileValidity,'no-acquired-response-to-fixed-object');assert.ok(Number.isNaN(empty.fwhm));
// Legacy sphere quadrature must integrate the active width, not the pitch.
const c=fdkConfig({objectModel:'point',rows:4,rowWidth:1,beamPitch:0,radius:1,channelApertureMm:.2});
const beta=.12,z=.21,point=fdkArcProjection(c,beta,z),sum=p=>p.data.reduce((a,b)=>a+b,0);
const small={...c,objectModel:'sphere',sphereDiameter:.02,apertureSamples:512};
const error=Math.abs(sum(fdkArcProjection(small,beta,z))/(Math.PI*.02**3/6)/sum(point)-1);
assert.ok(error<.01,`Small sphere independent aperture quadrature: ${error}`);
// Profile extraction at the fixed point is independent of the image pixel
// spacing, including spacing finer than the detector aperture.
const f={objectModel:'point',rows:80,rowWidth:.5,beamPitch:.5,radius:102,viewSamples:360,channelWidth:.25,channelApertureMm:.2,xyExtent:.5,xySamples:5,zExtent:3,zStep:.1,axialAverageMm:1};
for(const method of [reconstructFdk,reconstructCba]){
  const coarse=await method(f,{profileOnly:true}),fine=await method({...f,xySamples:17},{profileOnly:true});
  coarse.raw.forEach((v,i)=>near(v,fine.raw[i]));assert.ok(coarse.fwhm.width>0);
}
console.log(JSON.stringify({status:'PASS',samples,maxShapeChange,smallSphereRelativeError:error,scope:'Shared aperture and axial integration; not scanner validation or publication convergence'},null,2));
