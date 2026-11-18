import assert from "node:assert/strict";
import { createAcquisitionPlayback } from "../acquisition-playback-core.js";
import { cbaCoordinates } from "../cba-core.js";
import { fdkRowPosition } from "../fdk-core.js";

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} differs from ${b}`);
const example = {
  rows: 4, rowWidth: 1, radius: 102, sourceRadius: 600,
  focalSourceDetectorMm: 1070, beamPitch: 1, rotationTime: 0.75,
};
const model = createAcquisitionPlayback(example);
const start = model.frame(0, false);
const quarter = model.frame(0.25, false);
const half = model.frame(0.5, false);
const finish = model.frame(1, true);
assert.equal(model.tableFeed, 4);
assert.equal(model.rotationTime, 0.75);
assert.equal(model.baseline.length, 181);
assert.equal(model.track(false), model.baseline);
assert.equal(model.track(true), model.track(true));
assert.ok(quarter.sourceY > 0); // The tube travels from screen right to screen bottom.
assert.ok(quarter.directionDeg > quarter.sourceDeg);
near(Math.hypot(quarter.detectorX - quarter.sourceX, quarter.detectorY - quarter.sourceY), 1070);
near(start.detectorZ[1] - start.detectorZ[0], 1070 / 600);
near(half.detectorZ[1] - half.detectorZ[0], 1070 / 600);
near(start.intersections[1] - start.intersections[0], 0.83);
near(half.intersections[1] - half.intersections[0], 1.17);
finish.intersections.forEach((z, k) => near(z - start.intersections[k], 4));

for (const scenario of [
  { ...example, startAngleDeg: 137 },
  { ...example, rows: 160, rowWidth: 0.5, radius: 72, beamPitch: 0.65, phase: 0.9 },
  { ...example, radius: 0 },
]) {
  const m = createAcquisitionPlayback(scenario);
  const phase = m.startAngleDeg * Math.PI / 180;
  const theta0 = Math.atan2(m.frame(0, false).sourceY, m.frame(0, false).sourceX - m.radius);
  const c = { ...scenario, phase, feed: m.tableFeed };
  for (const fraction of [0, 1/6, 1/3, 0.875, 1]) {
    const still = m.frame(fraction, false);
    const moving = m.frame(fraction, true);
    const theta = theta0 + moving.directionDeg * Math.PI / 180;
    const q = cbaCoordinates(c, theta, m.radius, 0, 0);
    near(q.L, moving.distance);
    near(Math.sin(q.beta - moving.beta), 0);
    near(Math.cos(q.beta - moving.beta), 1);
    near(moving.sourceZ, m.tableFeed * fraction);
    for (let k = 0; k < m.rows; k++) {
      near(moving.intersections[k], fdkRowPosition(c, moving.beta, k));
      near(moving.intersections[k] - still.intersections[k], moving.sourceZ);
      near(moving.detectorZ[k] - still.detectorZ[k], moving.sourceZ);
      near(moving.intersections[k], moving.sourceZ
        + (moving.detectorZ[k] - moving.sourceZ) * moving.distance / m.detectorDistance);
    }
    const halfDetectorPitch = m.rowWidth * m.detectorDistance / m.sourceRadius / 2;
    const edges = [moving.detectorZ[0] - halfDetectorPitch, moving.detectorZ.at(-1) + halfDetectorPitch];
    for (const z of [moving.sourceZ, ...moving.intersections, ...edges]) {
      assert.ok(z >= m.domain[0] && z <= m.domain[1]);
    }
  }
  assert.ok(m.baseline.every((frame, i) => i === 0 || frame.directionDeg > m.baseline[i - 1].directionDeg));
  assert.equal(m.baseline.at(-1).directionDeg, 360);
}

const stationary = createAcquisitionPlayback({ ...example, rows: 8, rowWidth: 0.5, beamPitch: 0, nonhelicalRow: 7 });
assert.equal(stationary.referenceZ, 1.25);
assert.equal(stationary.tableFeed, 0);
assert.equal(stationary.track(true), stationary.baseline);
assert.deepEqual(stationary.frame(0.4, false), stationary.frame(0.4, true));
for (const nonhelicalRow of ["", "0", 0, undefined]) {
  assert.equal(createAcquisitionPlayback({ ...example, beamPitch: 0, nonhelicalRow }).referenceZ, 0.5);
}
const singleRow = createAcquisitionPlayback({ ...example, beamPitch: 0, rows: 1 });
assert.equal(singleRow.referenceZ, 0);
assert.ok(singleRow.domain[1] >= singleRow.rowWidth * singleRow.detectorDistance / singleRow.sourceRadius / 2);
assert.throws(() => createAcquisitionPlayback({ ...example, beamPitch: 0, nonhelicalRow: 5 }), /outside/);

const short = createAcquisitionPlayback({ ...example, focalSourceDetectorMm: 650, fullFanAngleDeg: 8 });
assert.equal(short.detectorBeyondTarget, false);
assert.equal(short.frame(0, false).detectorBeyondTarget, true);
assert.equal(short.frame(0.5, false).detectorBeyondTarget, false);
assert.equal(short.targetWithinFan, false);
assert.equal(short.frame(0.25, false).withinFan, false);
assert.equal(short.frame(0, false).withinFan, true);

console.log("PASS: clockwise projection geometry, stationary reference, matched helical row positions and live scanner settings");
