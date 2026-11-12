import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { DEFAULT_PARAMS, RECONSTRUCTION_PATHS, computeUnwrapped, computeProfileModel } from "../sim-core.js";
import { moriStaticCalculate } from "../mori-static-core.js";
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
const params = {
  ...DEFAULT_PARAMS, beamPitch: 0, rows: 8, rowWidth: 0.5, sourceRadius: 600, radius: 150,
  focalSourceDetectorMm: 1200, focalSizeMm: 1.2, viewSamples: 90,
  nonhelicalRow: 7, nonhelicalStep: 0.005,
};
const reference = moriStaticCalculate({
  rows: 8, rowPitch: 0.5, axialAperture: 0.5, sourceRadius: 600, detectorDistance: 1200,
  focalSizeMm: 1.2, viewSamples: 90, zStep: 0.005, radii: [0, 150],
});
for (const filename of ["worker-source.js", "worker-source-en.js"]) {
  const messages = [];
  const context = vm.createContext({ self: { postMessage: message => messages.push(message) } });
  vm.runInContext(readFileSync(new URL("../" + filename, import.meta.url), "utf8"), context);
  vm.runInContext(context.SSPZ_WORKER_SOURCE, context);
  const unrelatedHelicalInputs = { sliceThicknessMm: 0, channelWidth: 0, filterSamples: 0 };
  await context.self.onmessage({ data: { type: "run", params: { ...params, ...unrelatedHelicalInputs } } });
  const reply = messages.at(-1);
  assert.equal(reply.type, "nonhelical-result", reply.message);
  assert.equal(reply.result.diagram.z0, 1.25);
  assert.equal(reply.result.diagram.traceFamilies.length, 1);
  assert.equal(reply.result.diagram.averagingWidthMm, 0);
  const { z, profiles } = reply.result.response;
  assert.deepEqual(Array.from(z), Array.from(reference.z));
  assert.deepEqual(Array.from(profiles, p => p.radius), [0, 150]);
  for (const [i, profile] of profiles.entries()) {
    assert.equal(profile.zPlane, 1.25);
    assert.equal(profile.fwhm, reference.groups[i].profiles[6].fwhm);
    assert.deepEqual(Array.from(profile.profile), Array.from(reference.groups[i].profiles[6].profile));
  }
  await context.self.onmessage({ data: { type: "run", params: { ...params, rows: 1, radius: 0, nonhelicalRow: 0 } } });
  const centre = messages.at(-1);
  assert.equal(centre.type, "nonhelical-result", centre.message);
  assert.equal(centre.result.response.profiles.length, 1);
  assert.equal(centre.result.response.profiles[0].zPlane, 0);
}
console.log("PASS: stationary geometry and single-plane SSPz through both standalone workers");
