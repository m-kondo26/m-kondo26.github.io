import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../shape-export.js';
const z=Float32Array.from({length:401},(_,i)=>(i-200)*.01), count=3;
const values=new Float32Array(z.length*count);
for(let s=0;s<count;s++)for(let i=0;i<z.length;i++)values[s*z.length+i]=Math.max(0,1-Math.abs(z[i]-(s-1)*.1));
const c={final:values,coverage:new Float32Array(count).fill(1)};
const overlay={z,zCount:z.length,stateCount:count,states:new Float32Array([0,1/3,2/3]),off:c,on:c};
const a=SSPZShape.analyze(overlay,'on');
assert.equal(a.valid.length,3);
assert.ok(Math.max(...a.delta.flatMap(y=>Array.from(y,Math.abs)))<2e-7,'Translation-only profiles should have negligible shape residuals');
for(let i=0;i<a.x.length;i++){assert.ok(Math.abs(a.delta.reduce((sum,y)=>sum+y[i],0))<1e-12);assert.ok(Math.abs(a.hist.slice(i*60,(i+1)*60).reduce((x,y)=>x+y,0)+a.outside[i]/count-1)<1e-12);}
c.coverage[1]=.9;assert.deepEqual(SSPZShape.analyze(overlay,'on').valid,[0,2]);c.coverage[1]=1;
const out=process.argv[2];if(out){const blob=await SSPZShape.workbook({overlay,params:{radius:10},sweep:[{state:0,fwhm:1}]},{off:a,on:a},'test');fs.writeFileSync(out,Buffer.from(await blob.arrayBuffer()));}
console.log('PASS: translation alignment, zero mean residuals, histogram mass, coverage exclusion and workbook generation');
