import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {renderFigure3Svg, figure3FrequencyCsv, figure3SummaryCsv} from '../figure3-render.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../figure3-data.json', import.meta.url), 'utf8'));
const clone = object => JSON.parse(JSON.stringify(object));
function freeze(object) {
  Object.values(object).forEach(value => {if (value && typeof value === 'object') freeze(value);});
  return Object.freeze(object);
}
const original = JSON.stringify(fixture);
freeze(fixture);
const pools = ['direct', 'combined'], windows = ['fwhm', 'fwtm'];
const rows = data => pools.flatMap(pool => data.radii.flatMap(radius => windows.map(window =>
  ({pool, window, radius, group: radius.groups[pool][window]}))));
const close = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-12, `${label}: ${a} != ${b}`);
function csvRecords(csv) {
  assert.ok(csv.endsWith('\r\n'), 'CSV uses complete RFC-style CRLF records');
  assert.ok(!csv.startsWith('\uFEFF'), 'Pure export helper leaves optional BOM to the UI');
  const [header, ...lines] = csv.trimEnd().split('\r\n').map(line => line.split(','));
  return {header, records: lines.map(line => {
    assert.equal(line.length, header.length);
    return Object.fromEntries(header.map((key, index) => [key, line[index]]));
  })};
}
function observations(svg) {
  return [...svg.matchAll(/<circle\b([^>]*class="figure3-observation"[^>]*)>([\s\S]*?)<\/circle>/g)]
    .map(match => ({attributes: Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]])), child: match[2]}));
}

// The packaged manuscript fixture, rather than a fabricated trend, supplies
// every expected observed integer, frequency, relative size and offset.
assert.equal(fixture.schemaVersion, 1);
assert.deepEqual(fixture.radii.map(radius => radius.radiusMm), [10, 50, 80, 102]);
assert.equal(rows(fixture).length, 16);
const expected = rows(fixture).flatMap(({pool, window, radius, group}) => group.frequencies
  .filter(point => point.frequency > 0).map(point => ({pool, window, radius, point})));
assert.equal(expected.length, 52);
const svg = renderFigure3Svg(fixture);
assert.match(svg, /^<svg[^>]*width="180mm" height="95mm"/);
const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
close(Number(viewBox[1]), 180 / 25.4 * 72, 'publication width in points');
close(Number(viewBox[2]), 95 / 25.4 * 72, 'publication height in points');
assert.match(svg, /role="img" aria-labelledby="figure3-en-wide-title figure3-en-wide-desc"/);
assert.match(svg, /<title id="figure3-en-wide-title">/);
assert.match(svg, /<desc id="figure3-en-wide-desc">/);
assert.equal((svg.match(/Distance from isocenter \(mm\)/g) ?? []).length, 2);
assert.ok(!svg.includes('Radial position'), 'Latest adopted x label supersedes historical source wording');
assert.match(svg, /Collimation: 4 × 1\.0 mm; pitch: 0\.875; 360 directions × 360 start angles/);
assert.equal((svg.match(/>9<\/text>/g) ?? []).length, 2, 'Both panels retain the T=1 common integer maximum');
const circles = observations(svg);
assert.equal(circles.length, 52);
for (const {pool, window, radius, point} of expected) {
  const item = circles.find(({attributes: a}) => a['data-pool'] === pool && a['data-window'] === window &&
    Number(a['data-radius-mm']) === radius.radiusMm && Number(a['data-count']) === point.count);
  assert.ok(item, `Observed integer retained: ${pool}/${window}/r${radius.radiusMm}/${point.count}`);
  const a = item.attributes;
  assert.equal(a['data-frequency'], String(point.frequency));
  assert.equal(a['data-fraction'], String(point.fraction), 'Unrounded source fraction retained');
  assert.equal(a.fill, window === 'fwhm' ? '#2166A5' : '#C87620');
  assert.equal(a.stroke, a.fill);
  assert.equal(a['stroke-width'], '0.55');
  close(Number(a['data-x-display-mm']), radius.radiusMm + (window === 'fwhm' ? -4.4 : 4.4), 'source x offset');
  close(Number(a['data-marker-size-pt2']), 1 + 95 * point.fraction, 'source scatter size');
  close(Number(a.r), Math.sqrt(1 + 95 * point.fraction) / 2, 'Matplotlib circular-marker radius');
  assert.match(item.child, /<title>.*129600.*<\/title>/, 'Every marker has a readable frequency label');
}
for (const fraction of [.1, .5, 1]) {
  const legend = [...svg.matchAll(/<circle\b([^>]*)>/g)].map(match => match[1])
    .find(attributes => attributes.includes(`data-legend-fraction="${fraction}"`));
  assert.ok(legend);
  close(Number(legend.match(/\br="([^"]+)"/)[1]), Math.sqrt(1 + 95 * fraction) / 2, 'legend/source size agreement');
}

const frequency = csvRecords(figure3FrequencyCsv(fixture));
assert.equal(frequency.records.length, 160, 'All 0..9 integer cells retained in all sixteen groups');
assert.deepEqual(frequency.header, ['radius_mm', 'data_included', 'window', 'candidate_count', 'frequency', 'fraction',
  'total_observations', 'window_left_mm', 'window_right_mm', 'window_width_mm']);
assert.equal(frequency.records.filter(record => Number(record.frequency) > 0).length, 52);
for (const {pool, window, radius, group} of rows(fixture)) {
  const cells = frequency.records.filter(record => record.data_included === pool && record.window === window.toUpperCase() && Number(record.radius_mm) === radius.radiusMm);
  assert.deepEqual(cells.map(cell => Number(cell.candidate_count)), Array.from({length: 10}, (_, i) => i));
  assert.equal(cells.reduce((sum, cell) => sum + Number(cell.frequency), 0), 129600);
  for (const cell of cells) {
    const point = group.frequencies.find(point => point.count === Number(cell.candidate_count));
    assert.equal(cell.frequency, String(point?.frequency ?? 0));
    assert.equal(cell.fraction, String(point?.fraction ?? 0));
    assert.equal(cell.total_observations, String(group.n));
    assert.equal(cell.window_left_mm, String(radius.windows[window].left));
    assert.equal(cell.window_right_mm, String(radius.windows[window].right));
    assert.equal(cell.window_width_mm, String(radius.windows[window].width));
  }
}
const summary = csvRecords(figure3SummaryCsv(fixture));
assert.equal(summary.records.length, 16);
for (const {pool, window, radius, group} of rows(fixture)) {
  const row = summary.records.find(row => row.data_included === pool && row.window === window.toUpperCase() && Number(row.radius_mm) === radius.radiusMm);
  for (const [name, field] of [['min', 'minimum_count'], ['max', 'maximum_count'], ['mean', 'mean_count'], ['sd', 'population_sd_count'], ['n', 'total_observations']]) {
    assert.equal(row[field], String(group[name]), 'Summary exports the original full-precision statistic');
  }
}

// A zero-valued count is an observed outcome. A zero-frequency cell is absent
// from the figure, while remaining available in the numerical table.
const zero = clone(fixture);
zero.condition.statesPerRadius = 4;
zero.radii = [zero.radii[0]];
zero.radii[0].sampleCount = 4;
for (const {group} of rows(zero)) Object.assign(group, {n: 4, min: 0, max: 1, mean: .75, sd: Math.sqrt(.1875),
  frequencies: [{count: 0, frequency: 1, fraction: .25}, {count: 1, frequency: 3, fraction: .75}, {count: 12, frequency: 0, fraction: 0}]});
const zeroCircles = observations(renderFigure3Svg(zero));
assert.equal(zeroCircles.length, 8);
assert.equal(zeroCircles.filter(item => item.attributes['data-count'] === '0').length, 4);
assert.ok(zeroCircles.every(item => item.attributes['data-count'] !== '12'));
assert.equal(csvRecords(figure3FrequencyCsv(zero)).records.filter(row => row.candidate_count === '12' && row.frequency === '0').length, 4);

const stacked = renderFigure3Svg(fixture, {stacked: true});
assert.match(stacked, /width="100mm" height="175mm"/);
assert.match(stacked, /aria-labelledby="figure3-en-stacked-title figure3-en-stacked-desc"/);
assert.equal(observations(stacked).length, 52);
assert.match(renderFigure3Svg(fixture, {lang: 'ja'}), /候補データ数（個）/);
assert.equal(JSON.stringify(fixture), original, 'All render/export paths leave original data untouched');
const invalid = clone(fixture);
invalid.radii[0].groups.direct.fwhm.frequencies[0].frequency++;
assert.throws(() => renderFigure3Svg(invalid), /FIGURE3_DATA/);
assert.throws(() => figure3FrequencyCsv({schemaVersion: 2, radii: []}), /FIGURE3_DATA/);
const repeated = clone(fixture);
repeated.radii.push(clone(repeated.radii[0]));
assert.throws(() => figure3SummaryCsv(repeated), /repeated radius/);

console.log(JSON.stringify({status: 'pass', fixture: fileURLToPath(new URL('../figure3-data.json', import.meta.url)),
  observedCircles: circles.length, frequencyRows: frequency.records.length, summaryRows: summary.records.length,
  sourceSize: 's=1+95*fraction; circular radius=sqrt(s)/2 pt', publicationMm: [180, 95], stackedMm: [100, 175]}));
