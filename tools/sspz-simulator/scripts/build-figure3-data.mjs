#!/usr/bin/env node
// Package the archived manuscript Figure 3 results. This does not run a model.
// Usage: node scripts/build-figure3-data.mjs --source /path/to/candidate_density_data.json
// Optional: --out /path/to/simulator-directory
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const SOURCE_SHA256 = '9ca2171f3d6d78b79939ff04e2816e4f336188af7a033140b1cdd98f4a0803f9';
const COUNT_CORE_SHA256 = '48cf219834f7ee65ac9d90664a79f4241d7814e9f4de2c87756d8e70cbe74c21';
const RADII = [10, 50, 80, 102];
const POOLS = ['direct', 'combined'];
const WINDOWS = ['fwhm', 'fwtm'];
const STATES = 360 * 360;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function argumentsFor(argv) {
  let source;
  let out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--help' || value === '-h') return {help: true};
    if (value === '--source') source = argv[++i];
    else if (value === '--out') out = argv[++i];
    else if (!value.startsWith('-') && !source) source = value;
    else throw Error('Use --source <archived-json> and optionally --out <directory>.');
    if ((value === '--source' && !source) || (value === '--out' && !out)) throw Error('Missing argument.');
  }
  if (!source) throw Error('The archived candidate_density_data.json must be supplied with --source.');
  return {source: path.resolve(source), out: path.resolve(out)};
}

function distribution(source) {
  assert.equal(source.n, STATES);
  assert.equal(source.counts.length, STATES);
  const histogram = new Map();
  let sum = 0, sum2 = 0, minimum = Infinity, maximum = -Infinity;
  for (const value of source.counts) {
    assert.ok(Number.isInteger(value) && value >= 0);
    histogram.set(value, (histogram.get(value) ?? 0) + 1);
    sum += value;
    sum2 += value * value;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const frequencies = [...histogram].sort((a, b) => a[0] - b[0]).map(([count, frequency]) => ({
    count, frequency, fraction: frequency / STATES,
  }));
  assert.deepEqual(source.frequencies, frequencies);
  assert.equal(source.min, minimum);
  assert.equal(source.max, maximum);
  assert.equal(source.mean, sum / STATES);
  assert.equal(source.sd, Math.sqrt(Math.max(0, sum2 / STATES - source.mean * source.mean)));
  // Copy the archived values without rounding. Counts arrays stay local.
  return {
    n: source.n, min: source.min, max: source.max, mean: source.mean, sd: source.sd,
    frequencies: source.frequencies.map(point => ({...point})),
  };
}

function build(source, sourceSha256) {
  assert.equal(source.provenance.nativeViewsPerTurn, 1200);
  assert.equal(source.provenance.countCoreSha256, COUNT_CORE_SHA256);
  const selected = source.conditions.filter(item => item.Tmm === 1).sort((a, b) => a.radiusMm - b.radiusMm);
  assert.deepEqual(selected.map(item => item.radiusMm), RADII);
  const radii = selected.map(item => {
    const result = item.result, config = result.config;
    for (const [key, expected] of Object.entries({
      rows: 4, rowWidth: 1, beamPitch: 0.875, sourceRadius: 600,
      radius: item.radiusMm, viewSamples: 1200, focalSizeMm: 1.2,
      focalSourceDetectorMm: 1070, channelWidth: 0.58, channelApertureMm: 0.58,
      normalization: 'minmax', axialAverageMm: 1, fullFanAngleDeg: 50,
      comparisonMode: 'matched-rri', axialRule: 'rri',
      candidateSearch: 'source-fan-window', zFfsEnabled: false,
    })) assert.equal(config[key], expected, key);
    assert.equal(result.zObject, 0);
    assert.equal(result.sampleCount, STATES);
    assert.equal(result.angleSamples, 360);
    assert.equal(result.startSamples, 360);
    const windows = {};
    for (const name of WINDOWS) {
      const original = result.windows[name];
      assert.ok([original.left, original.right, original.width].every(Number.isFinite));
      assert.ok(original.left < original.right);
      assert.ok(Math.abs(original.width - (original.right - original.left)) < 1e-12);
      windows[name] = {left: original.left, right: original.right, width: original.width};
    }
    assert.ok(windows.fwtm.left <= windows.fwhm.left && windows.fwtm.right >= windows.fwhm.right);
    const groups = {};
    for (const pool of POOLS) {
      groups[pool] = {};
      for (const name of WINDOWS) groups[pool][name] = distribution(result.groups[pool][name]);
    }
    return {radiusMm: item.radiusMm, sampleCount: result.sampleCount, config: {...config}, windows, groups};
  });
  const groupCount = radii.length * POOLS.length * WINDOWS.length;
  const observedPointCount = radii.reduce((sum, radius) => sum + POOLS.reduce((s, pool) =>
    s + WINDOWS.reduce((n, name) => n + radius.groups[pool][name].frequencies.length, 0), 0), 0);
  assert.equal(groupCount, 16);
  assert.equal(observedPointCount, 52);
  const provenance = {
    sourceLabel: 'Archived calculation results for manuscript Figure 3',
    sourceFile: 'candidate_density_data.json',
    sourceSha256,
    sourceCountCoreSha256: source.provenance.countCoreSha256,
    sourceWindowSha256: source.provenance.windowSourceSha256,
    aggregation: '360 interpolation directions × 360 start angles, equally weighted',
    cached: true,
  };
  const chart = {
    type: 'frequency-dot-plot', widthMm: 180, heightMm: 95,
    colors: {fwhm: '#2166A5', fwtm: '#C87620'},
    xOffsetsMm: {fwhm: -4.4, fwtm: 4.4},
    markerSize: {basePt2: 1, frequencyScalePt2: 95, formula: '1 + 95 * fraction',
      circleRadiusPt: 'sqrt(1 + 95 * fraction) / 2'},
    frequencyLegendFractions: [0.1, 0.5, 1],
    xLimitsMm: [-1, 114], yLimits: [0, 9], xTicksMm: RADII, yTicks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    labels: {
      title: 'Simulated candidate counts within SSPz windows: T = 1 mm',
      subtitle: 'Collimation: 4 × 1.0 mm; pitch: 0.875; 360 directions × 360 start angles',
      x: 'Distance from isocenter (mm)', y: 'Number of candidates',
      direct: '(a)  Real data only', combined: '(b)  Real + conjugate',
      fwhm: 'FWHM (left)', fwtm: 'FWTM (right)', frequency: 'Occurrence',
    },
    fonts: {family: 'DejaVu Sans', bodyPt: 10, titlePt: 12, panelTitlePt: 10.5},
    markerStrokePt: 0.55,
  };
  const data = {
    schemaVersion: 1, title: 'Candidate-count distributions corresponding to manuscript Figure 3',
    condition: {
      rows: 4, rowSpacingMm: 1, beamPitch: 0.875, Tmm: 1, nativeViewsPerRotation: 1200,
      sourceRadiusMm: 600, sourceDetectorDistanceMm: 1070, axialFocusSizeMm: 1.2,
      channelSpacingMm: 0.58, channelApertureMm: 0.58, fullFanAngleDeg: 50,
      sourceSupportDeg: 460, axialRule: 'rri', candidateSearch: 'source-fan-window',
      normalization: 'minmax', directions: 360, startAngles: 360,
      statesPerRadius: STATES, modelVersion: '2026-09-24.1',
    },
    radii, provenance, chart,
  };
  const receipt = {
    schemaVersion: 1, datasetFile: 'figure3-data.json',
    source: provenance,
    selection: {radiiMm: RADII, Tmm: 1, pools: POOLS, windows: WINDOWS,
      groups: groupCount, observedFrequencyPoints: observedPointCount, statesPerGroup: STATES},
    definitions: {
      sd: 'Population standard deviation of the 129600 equally weighted integer counts.',
      fraction: 'Observed frequency divided by 129600, retained without rounding.',
      window: 'Bilateral 50% and 10% crossings of the native-z mean of 360 min-max normalized SSPz, with min-max normalization of that mean.',
      candidates: 'Rebinned detector-row centers before interpolation selection or weighting; direct and combined share the finite 460-degree acquired-source/stencil support.',
      displaySize: 'Matplotlib scatter size s = 1 + 95 × fraction in pt². Its circle path has diameter sqrt(s) pt; the 1 pt² floor makes size non-proportional at rare frequencies.',
    },
    validation: {
      archivedSourceSha256Verified: true,
      everySourceIntegerCountChecked: true,
      integerObservationsChecked: groupCount * STATES,
      allSixteenDistributionsCopiedExactly: true,
      allMeanSdMinMaxAndFrequenciesVerified: true,
      fullIntegerArraysOmittedFromPublicData: true,
      generator: 'scripts/build-figure3-data.mjs',
      sourceLocationsExcludedFromPublicFiles: true,
    },
    scope: 'Cached manuscript results. Changing simulator inputs does not change this dataset. Candidate counts do not specify within-window spacing, commercial reconstruction weights, independent measurements, noise or dose.',
  };
  return {data, receipt};
}

const options = argumentsFor(process.argv.slice(2));
if (options.help) {
  console.log('Usage: node scripts/build-figure3-data.mjs --source <archived-candidate-density-json> [--out <directory>]');
} else {
  const sourceBytes = fs.readFileSync(options.source);
  const sourceSha256 = sha256(sourceBytes);
  assert.equal(sourceSha256, SOURCE_SHA256, 'Input must be the unchanged archived manuscript Figure 3 source.');
  const {data, receipt} = build(JSON.parse(sourceBytes.toString('utf8')), sourceSha256);
  const serialized = JSON.stringify(data, null, 2) + '\n';
  receipt.datasetSha256 = sha256(serialized);
  fs.mkdirSync(options.out, {recursive: true});
  fs.writeFileSync(path.join(options.out, 'figure3-data.json'), serialized);
  fs.writeFileSync(path.join(options.out, 'figure3-data-provenance.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({groups: 16, observedPoints: 52, statesPerGroup: STATES,
    sourceSha256, datasetSha256: receipt.datasetSha256, bytes: Buffer.byteLength(serialized)}));
}
