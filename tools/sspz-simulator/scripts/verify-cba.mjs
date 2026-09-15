import {writeFile} from 'node:fs/promises';
import {reconstructCba} from '../cba-core.js';
const results=[];
const cases=[];
for(const rows of [80,160,320])for(const viewSamples of [360,720,1440])cases.push({rows,viewSamples});
cases.push({rows:80,viewSamples:2400});
cases.push({rows:80,viewSamples:1440,apertureSamples:16});
cases.push({rows:80,viewSamples:1440,zStep:.025});
cases.push({rows:64,rowWidth:.625,beamPitch:33/64,radius:0,viewSamples:1440});
for(const input of cases){const r=await reconstructCba(input),record={input,config:r.config,CBA:{FWHM:r.fwhm.width,FWTM:r.fwtm.width,peak:r.max},RRI:{FWHM:r.reference.fwhm.width,FWTM:r.reference.fwtm.width,peak:r.reference.max},pairs:r.sampleAudit.length};results.push(record);console.log(JSON.stringify(record));}
await writeFile(new URL('../tests/cba-verification.json',import.meta.url),JSON.stringify({model:'2026-09-15.1',scope:'Numerical sensitivity of ideal finite-sphere model; not scanner validation or a reproduction of measured foil widths.',results},null,2)+'\n');
