import assert from 'node:assert/strict';
import {computeTaguchiTsp, taguchiHfiWeightsAtPhase} from '../taguchi-tsp-core.js';

const close = (actual, expected, tolerance, label) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${label}: ${actual} != ${expected}, tolerance ${tolerance}`,
);

// Independent Eq.(6) oracle: enumerate physical acquisitions, sort them by z,
// then RESAMPLE each filter midpoint by its two adjacent data values. This
// does not call the production analytic hat integrals or basis enumeration.
// A temporal gate is applied to the original acquisitions before resampling.
function discreteResampling(config, phase, count, gate) {
  const d = config.rowWidth;
  const feed = 4 * d * config.beamPitch;
  const filterWidth = config.filterWidthMm;
  const points = [];
  for (let k = -60; k <= 60; k += 1) {
    const t = phase + k / 2;
    for (let row = 0; row < 4; row += 1) points.push({z: feed * t + (row - 1.5) * d, value: gate(t, row)});
  }
  points.sort((a, b) => a.z - b.z);
  const nodes = [];
  for (const point of points) {
    const last = nodes.at(-1);
    if (last && Math.abs(last.z - point.z) < 1e-9) { last.values.push(point.value); }
    else nodes.push({z: point.z, values: [point.value]});
  }
  for (const node of nodes) node.y = node.values.reduce((sum, y) => sum + y, 0) / node.values.length;
  let response = 0;
  for (let i = 0; i < count; i += 1) {
    const z = filterWidth * ((i + 0.5) / count - 0.5);
    let lower = 0;
    while (lower + 1 < nodes.length && nodes[lower + 1].z <= z) lower += 1;
    const a = nodes[lower], b = nodes[lower + 1];
    assert.ok(a && b && a.z <= z && b.z >= z, 'oracle has both neighbors');
    const q = (z - a.z) / (b.z - a.z);
    response += (1 - q) * a.y + q * b.y;
  }
  return response / count;
}

const base = {rows: 4, rowWidth: 2, beamPitch: 0.625, filterWidthMm: 2, rotationTime: 1, viewSamples: 7200};
let independentGates = 0;
for (const extra of [
  {}, {beamPitch: 1}, {beamPitch: 1.5}, {beamPitch: 0.875, filterWidthMm: 3},
  {beamPitch: 0.1, filterWidthMm: 1}, {beamPitch: 2.5, filterWidthMm: 5},
]) {
  const config = {...base, ...extra};
  for (const phase of [0, 0.137, -0.211]) {
    const weights = taguchiHfiWeightsAtPhase(config, phase);
    close(weights.sum, 1, 5e-13, 'constant input / partition of unity');
    assert.ok(weights.records.every(record => record.weight > 0), 'positive HFI coefficients');
    assert.ok(weights.records.every(record => record.timeTurns === phase + record.halfTurn / 2), 'original signed half-turn copies');
    const gates = [
      t => Math.abs(t - phase) < 1e-10 ? 1 : 0, // one original acquisition, all rows
      (t, row) => Math.abs(t - phase) < 1e-10 && row === 1 ? 1 : 0, // a single original cell
      t => t > -0.3 && t < 0.2 ? 1 : 0, // temporal rectangular perturbation
      (t, row) => (1 + Math.cos(4 * t + row)) / 2,
    ];
    for (const gate of gates) {
      const actual = weights.records.reduce((sum, item) => sum + item.weight * gate(item.timeTurns, item.row), 0);
      const expected = discreteResampling(config, phase, 8193, gate);
      close(actual, expected, 1.3e-7, 'independent finite-resampling temporal input response');
      independentGates += 1;
    }
    const curve = computeTaguchiTsp(config);
    const index = Math.round(phase * config.viewSamples) + (curve.raw.length - 1) / 2;
    const gridPhase = curve.timeTurns[index];
    const gridWeights = taguchiHfiWeightsAtPhase(config, gridPhase);
    const centralAcquisition = gridWeights.records.filter(record => record.halfTurn === 0)
      .reduce((sum, record) => sum + record.weight, 0);
    close(curve.raw[index], centralAcquisition, 3e-13, 'curve sums row coefficients at one original time');
  }
}

// The rectangular-filter limit is checked against closed-form values for
// this candidate convention, independently of the published measurements.
const analytic = [
  {beamPitch: 0.625, peak: 0.375, fwhm: 1.2 + Math.sqrt(0.12), fwtm: 1.8 - Math.sqrt(0.012), teq: 4 / 3},
  {beamPitch: 1, peak: 0.5, fwhm: 1, fwtm: 1.5 - Math.sqrt(0.05), teq: 1},
  {beamPitch: 1.5, peak: 1, fwhm: 0.5, fwtm: 1 - Math.sqrt(0.4) / 3, teq: 0.5},
];
for (const expected of analytic) {
  const result = computeTaguchiTsp({...base, beamPitch: expected.beamPitch});
  close(result.audit.rawPeak, expected.peak, 3e-13, 'analytic peak');
  close(result.metrics.fwhmTurns, expected.fwhm, 3e-8, 'analytic FWHM');
  close(result.metrics.fwtmTurns, expected.fwtm, 1e-7, 'analytic FWTM');
  close(result.metrics.equivalentWidthTurns, expected.teq, 1e-10, 'analytic area/peak');
  close(result.audit.rawAreaTurns, 0.5, 1e-10, 'half-turn family partition integral');
  assert.deepEqual(result.audit.endpointRaw, [0, 0]);
  assert.equal(result.metrics.fwhmIntervals, 1);
  for (let i = 0; i < result.raw.length; i += 1) {
    close(result.raw[i], result.raw[result.raw.length - 1 - i], 2e-13, 'central-axis temporal symmetry');
  }
  const coarse = computeTaguchiTsp({...base, beamPitch: expected.beamPitch, viewSamples: 100});
  const finer = computeTaguchiTsp({...base, beamPitch: expected.beamPitch, viewSamples: 1800});
  assert.ok(Math.abs(finer.metrics.fwtmTurns - expected.fwtm) <= Math.abs(coarse.metrics.fwtmTurns - expected.fwtm) + 1e-12);
  close(finer.metrics.fwtmTurns, result.metrics.fwtmTurns, 2e-6, 'temporal grid convergence');
}

const original = computeTaguchiTsp(base);
const rescaledTime = computeTaguchiTsp({...base, rotationTime: 0.5});
assert.deepEqual(rescaledTime.timeTurns, original.timeTurns);
assert.deepEqual(rescaledTime.raw, original.raw);
assert.deepEqual(rescaledTime.profile, original.profile);
close(rescaledTime.metrics.fwhmMs, original.metrics.fwhmMs / 2, 1e-10, 'rotation time converts units only');
const rescaledGeometry = computeTaguchiTsp({...base, rowWidth: 6, filterWidthMm: 6});
assert.deepEqual(rescaledGeometry.timeTurns, original.timeTurns);
for (let i = 0; i < original.raw.length; i += 1) close(rescaledGeometry.raw[i], original.raw[i], 5e-14, 'uniform length scaling');

// Keep original acquisition times distinct even where different rows have
// exactly the same z coordinate. There is no modulo-one rotation folding.
const coincident = taguchiHfiWeightsAtPhase({...base, beamPitch: 1}, 0.137);
assert.ok(coincident.records.some(record => record.coincidentAcquisitions > 1));
for (const a of coincident.records) {
  for (const b of coincident.records) {
    if (a !== b && Math.abs(a.zMm - b.zMm) < 1e-10) {
      assert.notEqual(a.timeTurns, b.timeTurns);
      close(a.weight, b.weight, 1e-14, 'explicit coincident sharing');
    }
  }
}
const wide = computeTaguchiTsp({...base, beamPitch: 0.1, filterWidthMm: 4});
assert.ok(wide.timeTurns.at(-1) > 1 && wide.timeTurns[0] < -1, 'not clipped to the benchmark one-rotation range');
close(wide.audit.rawAreaTurns, 0.5, 1e-8, 'low-pitch complete temporal support');
const zeroFilter = computeTaguchiTsp({...base, filterWidthMm: 0});
assert.ok(zeroFilter.profile.some(value => value > 0), 'FW=0 has the adjacent linear-interpolation limit');
assert.equal(zeroFilter.metrics.fwhmTurns, null);
assert.equal(zeroFilter.metrics.fwhmReason, 'disconnected-threshold-intervals');
assert.equal(zeroFilter.metrics.fwhmIntervals, 4);
close(zeroFilter.metrics.fwhmEnvelopeTurns, 1.3, 1e-12, 'multipeak enclosing extent kept separately');
const halfPlateau = computeTaguchiTsp({...base, beamPitch: 1.25});
assert.equal(halfPlateau.metrics.fwhmTurns, null);
assert.equal(halfPlateau.metrics.fwhmReason, 'plateau-at-threshold');
assert.ok(halfPlateau.metrics.equivalentWidthTurns > 0, 'area/peak remains defined on a half-height plateau');
for (const bad of [{rows: 16}, {radius: 100}, {beamPitch: 0}, {rotationTime: 0}, {viewSamples: 360.5}]) {
  assert.throws(() => computeTaguchiTsp({...base, ...bad}), RangeError);
}

// No fit to Fig.5: make the known discrepancy visible rather than silently
// accepting measured values as exact theoretical coefficients.
assert.match(original.provenance.fig5Reproduction, /^not-established/);
assert.ok(Math.abs(original.metrics.fwhmMs - 1531) > 4, 'known p=.625 published-width discrepancy retained');
close(original.profile[(original.profile.length - 1) / 2], 2 / 3, 1e-12, 'known central plateau differs from Fig.5(d) peak');
console.log(`Taguchi TSP: ${independentGates} independent input gates, analytic widths, convergence, original-time provenance, scaling and stated Fig.5 limit PASS`);
