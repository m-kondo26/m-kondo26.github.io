import {writeFile} from 'node:fs/promises';
import {reconstructFdk} from '../fdk-core.js';
const records=[];
for(const rows of [80,160,320]){
  for(const [label,change] of [['baseline',{}],['720_views',{viewSamples:720}],['1440_views',{viewSamples:1440}],['16_aperture',{apertureSamples:16}],['z_0.025',{zStep:.025}],['xy_33',{xySamples:33}],['xy_65',{xySamples:65}],['r250',{radius:250}]]){
    const r=await reconstructFdk({rows,...change});
    const item={rows,label,config:r.config,fwhm:r.fwhm.width,fwtm:r.fwtm.width,peak:r.max,baseline:r.baseline};
    records.push(item);console.log(JSON.stringify({rows,label,FWHM:item.fwhm,FWTM:item.fwtm}));
  }
}
await writeFile(new URL('../tests/fdk-verification.json',import.meta.url),JSON.stringify({date:'2026-09-14',scope:'Numerical sensitivity and implementation checks; not scanner validation',records},null,2)+'\n');
