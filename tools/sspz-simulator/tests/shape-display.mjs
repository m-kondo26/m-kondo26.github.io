import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../shape-export.js';
import '../shape-display.js';

// Analytically known triangular widths, with independent shifts and widths.
const z = Float64Array.from({length: 601}, (_, i) => (i - 300) * .01);
const widths = [.8, 1, 1.2], centers = [-.13, 0, .17];
const profiles = widths.map((w, k) => ({
  profile: Array.from(z, v => Math.max(0, 1 - Math.abs(v - centers[k]) / w)),
  fwhm: {width: w, left: centers[k] - w / 2, right: centers[k] + w / 2}
}));
const result = {z, profiles}, before = JSON.stringify(result);
const [{analysis: a}] = SSPZShapeDisplay.fromFdk(result);
assert.equal(JSON.stringify(result), before, 'The renderer analysis must not mutate native results');
a.fwhm.forEach((v, i) => assert.ok(Math.abs(v - widths[i]) < 1e-12));
a.mid.forEach((v, i) => assert.ok(Math.abs(v - centers[i]) < 1e-12));
assert.ok(-a.low > .06, 'Expand to include a broad deviation distribution');
assert.equal(a.outside.reduce((s, v) => s + v, 0), 0, 'No deviations silently clipped');
for(let i=0; i<a.x.length; i++) {
  assert.ok(Math.abs(a.delta.reduce((s, p) => s+p[i],0))<1e-12);
  assert.ok(Math.abs(a.hist.slice(i*a.bins,(i+1)*a.bins).reduce((s,v)=>s+v,0)-1)<1e-12);
}
assert.ok(SSPZShapeDisplay.intensity(.01) > Math.round(255 * Math.sqrt(.01)));
assert.equal(SSPZShapeDisplay.intensity(0), 0); assert.equal(SSPZShapeDisplay.intensity(1), 255);
assert.deepEqual(SSPZShapeDisplay.ticks(-1.5,1.5),[-1.5,-1,-.5,0,.5,1,1.5]);

// Optional genuine saved CBA/RRI export: validate width preservation and every
// column's probability mass on an actual reconstruction, without rerunning FBP.
if(process.argv[2]) {
  const r = JSON.parse(fs.readFileSync(process.argv[2],'utf8')), saved = JSON.stringify(r);
  for(const g of SSPZShapeDisplay.fromFdk(r)) {
    const source=g.name==='RRI'?r.reference:r;
    g.analysis.fwhm.forEach((v,i)=>assert.ok(Math.abs(v-source.profiles[g.analysis.valid[i]].fwhm.width)<1e-12));
    assert.equal(g.analysis.outside.reduce((s,v)=>s+v,0),0);
    for(let i=0;i<g.analysis.x.length;i++)assert.ok(Math.abs(g.analysis.hist.slice(i*g.analysis.bins,(i+1)*g.analysis.bins).reduce((s,v)=>s+v,0)-1)<1e-12);
  }
  assert.equal(JSON.stringify(r), saved);
}
console.log('PASS: known widths and translations, native-result immutability, mean subtraction, no clipping, histogram mass and intensity mapping');
