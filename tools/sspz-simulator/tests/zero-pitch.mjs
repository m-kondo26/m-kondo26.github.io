import assert from "node:assert/strict";
import { DEFAULT_PARAMS, RECONSTRUCTION_PATHS, computeUnwrapped, computeProfileModel } from "../sim-core.js";
for (const rows of [1, 4, 160]) for (const radius of [0, 250]) {
  for (const reconstructionPath of Object.values(RECONSTRUCTION_PATHS)) for (const coneOn of [false, true]) {
    const params = { ...DEFAULT_PARAMS, beamPitch: 0, rows, radius, reconstructionPath };
    const d = computeUnwrapped(params, { coneOn });
    assert.equal(d.geometryOnly, true);
    assert.deepEqual([...d.traceGeometry.turns], [0]);
    assert.equal(d.weightedPoints.length, 0);
    assert.ok(Number.isFinite(d.overviewXLimit));
    for (const family of d.traceFamilies) for (let i = 0; i < family.axial.length; i++) {
      assert.equal(family.axial[i], 0);
      const beta = family.acquiredAngles[i] * Math.PI / 180;
      const expected = coneOn ? Math.sqrt(1 + (radius / params.sourceRadius) ** 2 - 2 * radius / params.sourceRadius * Math.cos(beta)) : 1;
      assert.ok(Math.abs(family.scales[i] - expected) < 1e-12);
    }
    assert.throws(() => computeProfileModel(params), /ビームピッチ/);
  }
}
assert.throws(() => computeUnwrapped({ ...DEFAULT_PARAMS, beamPitch: -0.1 }), /ビームピッチ/);
console.log("PASS: zero-pitch stationary geometry, no repeated turns or helical interpolation");
