import {writeFile} from 'node:fs/promises';
import {reconstructCba} from '../cba-core.js';
const reports=[];
for(const rows of [4,160])for(const radius of [102,250]){
  const cases=[];
  for(const viewSamples of [360,720,1440,2400]){
    const config={objectModel:'point',rows,rowWidth:rows===4?1:.5,beamPitch:rows===4?.875:.5,radius,viewSamples,xyExtent:.5,xySamples:5,zExtent:3,zStep:.05,axialAverageMm:1};
    const r=await reconstructCba(config,{profileOnly:true});
    cases.push({viewSamples,zStep:.05,cbaFwhm:r.fwhm.width,rriFwhm:r.reference.fwhm.width,cbaFwtm:r.fwtm.width,rriFwtm:r.reference.fwtm.width});
    if(viewSamples===2400){const fine=await reconstructCba({...config,zStep:.025},{profileOnly:true});cases.push({viewSamples,zStep:.025,cbaFwhm:fine.fwhm.width,rriFwhm:fine.reference.fwhm.width,cbaFwtm:fine.fwtm.width,rriFwtm:fine.reference.fwtm.width});}
  }
  reports.push({rows,radius,phase:0,cases});
}
const report={scope:'Point-model sensitivity examples at one start angle and T=1 mm; not convergence certification for all angles or manuscript conditions',reports};
await writeFile(new URL('../tests/point-response-sensitivity.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
