import assert from 'node:assert/strict';
import fs from 'node:fs';
import {renderCandidateCountsSvg, candidateFrequencyCsv, candidateSummaryCsv} from '../candidate-counts-render.js';

const clone = value => JSON.parse(JSON.stringify(value));
const pools = ['direct', 'combined'], windows = ['fwhm', 'fwtm'];
const groupRows = data => pools.flatMap(pool => data.radii.flatMap(radius => windows.map(window =>
  ({pool, window, radius, group: radius.groups[pool][window]}))));
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-10, `${message}: ${a} != ${b}`);
const nearManuscript = (a, b, message) => assert.ok(Math.abs(a - b) <= 1.01e-6,
  `${message}: ${a} != ${b} (six-decimal manuscript SVG coordinates)`);
function attributes(value) {
  return Object.fromEntries([...value.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
}
function circles(svg) {
  return [...svg.matchAll(/<circle\b([^>]*class="candidate-count-observation"[^>]*)>([\s\S]*?)<\/circle>/g)]
    .map(match => ({...attributes(match[1]), child: match[2]}));
}
function svgAttributes(svg) {
  return attributes(svg.match(/^<svg([^>]*)>/)[1]);
}
function panels(svg) {
  const starts = [...svg.matchAll(/<g\b([^>]*class="candidate-count-panel"[^>]*)>/g)];
  assert.equal(starts.length, 2, 'Both pools expose their own panel and vertical scale');
  return Object.fromEntries(starts.map((match, index) => {
    const a = attributes(match[1]);
    return [a['data-pool'], {attributes: a, body: svg.slice(match.index + match[0].length,
      starts[index + 1]?.index ?? svg.length)}];
  }));
}
function legendCircles(svg) {
  return [...svg.matchAll(/<circle\b([^>]*)>/g)].map(match => attributes(match[1]))
    .filter(circle => circle['data-legend-fraction'] !== undefined);
}
function textNodes(svg) {
  return [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)]
    .map(match => ({attributes: attributes(match[1]), text: match[2].replace(/<[^>]+>/g, '')}));
}
function axisGeometry(panel) {
  const horizontal = [...panel.body.matchAll(/<line\b([^>]*)\/?\s*>/g)]
    .map(match => attributes(match[1])).filter(a => Number(a.y1) === Number(a.y2) && Number(a.x2) > Number(a.x1));
  const longest = Math.max(...horizontal.map(a => Number(a.x2) - Number(a.x1)));
  const fullWidth = horizontal.filter(a => Math.abs(Number(a.x2) - Number(a.x1) - longest) < 1e-9);
  assert.ok(fullWidth.length >= 2, 'Read actual axis/grid geometry rather than text baselines');
  return {left: Number(fullWidth[0].x1), right: Number(fullWidth[0].x2),
    top: Math.min(...fullWidth.map(a => Number(a.y1))), bottom: Math.max(...fullWidth.map(a => Number(a.y1)))};
}
function checkIndependentAxes(svg, data) {
  const root = svgAttributes(svg), byPool = panels(svg), result = {};
  assert.equal(root['data-y-scale'], 'independent');
  assert.ok(!Object.hasOwn(root, 'data-y-maximum'), 'No ambiguous common maximum remains on the SVG');
  for (const pool of pools) {
    const panel = byPool[pool];
    assert.ok(panel, `Panel ${pool}`);
    const a = panel.attributes, maximum = Number(a['data-y-maximum']);
    assert.ok(!a.transform, 'A panel cannot stretch its circular markers to implement a different axis');
    const observedMaximum = Math.max(...data.radii.flatMap(radius => windows.flatMap(window =>
      radius.groups[pool][window].frequencies.filter(point => point.frequency > 0).map(point => point.count))));
    assert.equal(a['data-y-minimum'], '0');
    assert.equal(Number(a['data-observed-maximum']), observedMaximum);
    assert.equal(Number(root[`data-y-maximum-${pool}`]), maximum);
    const ticks = [...panel.body.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)]
      .map(match => ({attributes: attributes(match[1]), value: Number(match[2])}))
      .filter(tick => tick.attributes.class?.split(/\s+/).includes('candidate-count-tick'));
    assert.ok(ticks.length >= 2 && ticks.length <= 10, 'Bounded tick allocation within each panel');
    assert.equal(ticks[0].value, 0);
    assert.equal(ticks.at(-1).value, maximum);
    assert.ok(ticks.every(tick => Number.isInteger(tick.value)));
    const step = ticks[1].value - ticks[0].value;
    assert.ok(Number.isInteger(step) && step > 0);
    for (let i = 1; i < ticks.length; i++) {
      assert.equal(ticks[i].value - ticks[i - 1].value, step, 'Regular integer tick step');
      assert.ok(Number(ticks[i].attributes.y) < Number(ticks[i - 1].attributes.y));
    }
    if (observedMaximum <= 8) {
      assert.equal(maximum, observedMaximum + 1, 'Small counts have exactly one count of upper headroom');
      assert.equal(step, 1);
    } else {
      assert.ok(maximum >= observedMaximum + Math.max(1, observedMaximum * .06) - 1e-10,
        'Large counts include the requested headroom before rounding to nice ticks');
      const normalizedStep = step / 10 ** Math.floor(Math.log10(step));
      assert.ok([1, 2, 5, 10].some(nice => Math.abs(normalizedStep - nice) < 1e-10), 'Nice integer step');
    }
    // A publication font's text baseline can sit below its grid line. Candidate
    // coordinates are measured against actual grid/axis lines, not tick text.
    const {bottom, top} = axisGeometry(panel);
    for (const circle of circles(panel.body)) {
      assert.equal(circle['data-pool'], pool, 'A panel contains only its own pool');
      near(Number(circle.cy), bottom - Number(circle['data-count']) / maximum * (bottom - top),
        'Each point uses its own pool scale');
      assert.ok(!Object.hasOwn(circle, 'rx') && !Object.hasOwn(circle, 'ry'), 'Markers remain circles');
      assert.ok(!circle.transform, 'Candidate circles do not inherit an individual shape stretch');
    }
    result[pool] = {maximum, observedMaximum, step, ticks: ticks.map(tick => tick.value)};
  }
  return result;
}
function csvRows(csv) {
  assert.ok(csv.endsWith('\r\n'));
  assert.ok(!csv.startsWith('\uFEFF'), 'Optional BOM belongs to the download UI');
  const [header, ...rows] = csv.trimEnd().split('\r\n').map(line => line.split(','));
  return {header, rows: rows.map(row => {
    assert.equal(row.length, header.length);
    return Object.fromEntries(header.map((key, i) => [key, row[i]]));
  })};
}
function freeze(value) {
  Object.values(value).forEach(child => {if (child && typeof child === 'object') freeze(child);});
  return Object.freeze(value);
}

// Historical results are a portable regression fixture, never a production
// preset or an assumption about the number of requested evaluation positions.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/candidate-counts-original.json', import.meta.url), 'utf8'));
const before = JSON.stringify(fixture);
freeze(fixture);
const svg = renderCandidateCountsSvg(fixture);
const originalFrequencyCsv = candidateFrequencyCsv(fixture), originalSummaryCsv = candidateSummaryCsv(fixture);
const fixtureAxes = checkIndependentAxes(svg, fixture);
assert.equal(fixtureAxes.direct.maximum, 5);
assert.equal(fixtureAxes.combined.maximum, 9);
const observed = groupRows(fixture).flatMap(({pool, window, radius, group}) => group.frequencies
  .filter(point => point.frequency > 0).map(point => ({pool, window, radius, point})));
assert.equal(observed.length, 52);
assert.equal(circles(svg).length, 52);
assert.match(svg, /data-position-scale="physical"/);
assert.match(svg, /role="img" aria-labelledby="candidate-counts-en-wide-title candidate-counts-en-wide-desc"/);
assert.ok(!/Figure 3|figure3|Radial position/.test(svg), 'No fixed-paper label or obsolete position wording');
assert.match(svg, /data-style="manuscript"/, 'Adopt the figure style without adding a fixed-data preset');
for (const {pool, window, radius, point} of observed) {
  const circle = circles(svg).find(circle => circle['data-pool'] === pool && circle['data-window'] === window &&
    Number(circle['data-radius-mm']) === radius.radiusMm && Number(circle['data-count']) === point.count);
  assert.ok(circle);
  assert.equal(circle['data-fraction'], String(point.fraction));
  assert.equal(circle['data-frequency'], String(point.frequency));
  assert.equal(circle.fill, window === 'fwhm' ? '#2166A5' : '#C87620');
  const scale = Number(circle['data-marker-scale']);
  near(Number(circle['data-marker-size-pt2']), 1 + 95 * point.fraction, 'Occurrence size');
  near(Number(circle.r), Math.sqrt(1 + 95 * point.fraction) / 2 * scale, 'Circular path radius');
  assert.match(circle.child, /<title>.*129600.*<\/title>/);
}
const frequency = csvRows(candidateFrequencyCsv(fixture));
const summary = csvRows(candidateSummaryCsv(fixture));
assert.equal(frequency.rows.length, 52, 'Export supplied frequency cells without inventing a fixed integer range');
assert.equal(summary.rows.length, 16);
assert.ok(summary.header.includes('population_sd_count'));
assert.ok(summary.header.includes('window_left_mm'));
for (const {pool, window, radius, group} of groupRows(fixture)) {
  const cells = frequency.rows.filter(row => row.data_included === pool && row.window === window.toUpperCase() && Number(row.radius_mm) === radius.radiusMm);
  assert.equal(cells.reduce((sum, row) => sum + Number(row.frequency), 0), group.n);
  for (const point of group.frequencies) {
    const cell = cells.find(row => Number(row.candidate_count) === point.count);
    assert.equal(cell.frequency, String(point.frequency));
    assert.equal(cell.fraction, String(point.fraction));
    assert.equal(cell.window_left_mm, String(radius.windows[window].left));
    assert.equal(cell.window_width_mm, String(radius.windows[window].width));
  }
  const row = summary.rows.find(row => row.data_included === pool && row.window === window.toUpperCase() && Number(row.radius_mm) === radius.radiusMm);
  for (const [field, source] of [['minimum_count', 'min'], ['maximum_count', 'max'], ['mean_count', 'mean'], ['population_sd_count', 'sd'], ['total_observations', 'n']]) {
    assert.equal(row[field], String(group[source]), 'Full-precision original statistics');
  }
}
assert.equal(JSON.stringify(fixture), before, 'Drawing and exports leave the frozen input unchanged');
checkIndependentAxes(renderCandidateCountsSvg(fixture, {stacked: true}), fixture);
assert.equal(candidateFrequencyCsv(fixture), originalFrequencyCsv, 'Wide/stacked drawing never changes frequency CSV bytes');
assert.equal(candidateSummaryCsv(fixture), originalSummaryCsv, 'Wide/stacked drawing never changes summary CSV bytes');

// Golden display geometry comes from the adopted independent-axis Figure3 SVG
// (figure3_independent_axes, 2026-10-20). Coordinates are rounded to six decimals
// in Matplotlib's export; frequency/area checks above remain unrounded.
const manuscriptGeometry = {
  widthMm: 180, heightMm: 95, viewBox: [0, 0, 510.236220, 269.291339],
  direct: {left: 53.574803, right: 245.353245, top: 86.173228, bottom: 224.858268},
  combined: {left: 306.722346, right: 498.500787, top: 86.173228, bottom: 224.858268},
};
function checkManuscriptWideGeometry(svg, data) {
  const root = svgAttributes(svg), byPool = panels(svg);
  assert.equal(root.width, '180mm');
  assert.equal(root.height, '95mm');
  assert.equal(root['data-reference-domain'], 'true');
  assert.equal(Number(root['data-x-minimum']), -1);
  assert.equal(Number(root['data-x-maximum']), 114);
  root.viewBox.split(/\s+/).map(Number).forEach((value, i) => nearManuscript(value,
    manuscriptGeometry.viewBox[i], 'Figure footprint'));
  assert.deepEqual(root.viewBox.split(/\s+/).map(Number).slice(2).map(value => Math.floor(value * 600 / 72)),
    [4251, 2244], 'Adopted 600-dpi canvas dimensions');
  const title = `Simulated candidate counts within SSPz windows: T = ${data.condition.Tmm} mm`;
  const titleNode = textNodes(svg).find(node => node.text === title);
  assert.ok(titleNode, 'Title stays dynamic and matches the adopted format');
  for (const [text, x, y] of [[title, 22.960630, 14.773243],
    ['Occurrence', 307.672441, 52.039690], ['10%', 390.330709, 68.727571],
    ['50%', 436.251969, 68.727571], ['100%', 482.173228, 68.727571],
    ['FWHM (left)', 50.848031, 61.570091], ['FWTM (right)', 143.313656, 61.570091]]) {
    const node = textNodes(svg).find(node => node.text === text);
    assert.ok(node, text);
    nearManuscript(Number(node.attributes.x), x, `${text} anchor x`);
    nearManuscript(Number(node.attributes.y), y, `${text} anchor y`);
  }
  const subtitle = textNodes(svg).find(node => node.text.startsWith('Collimation:'));
  assert.ok(subtitle);
  nearManuscript(Number(subtitle.attributes.x), 22.960630, 'Subtitle x');
  nearManuscript(Number(subtitle.attributes.y), 34.796863, 'Subtitle y');
  assert.ok(!subtitle.text.includes('T ='), 'Averaging width is in the title, without redundant subtitle text');
  for (const pool of pools) {
    const plot = axisGeometry(byPool[pool]);
    for (const bound of ['left', 'right', 'top', 'bottom']) nearManuscript(plot[bound], manuscriptGeometry[pool][bound], `${pool} ${bound}`);
    const maximum = Number(byPool[pool].attributes['data-y-maximum']);
    for (const circle of circles(byPool[pool].body)) {
      const position = Number(circle['data-radius-mm']) + (circle['data-window'] === 'fwhm' ? -4.4 : 4.4);
      near(Number(circle.cx), plot.left + (position + 1) / 115 * (plot.right - plot.left), 'Manuscript physical horizontal positions');
      near(Number(circle.cy), plot.bottom - Number(circle['data-count']) / maximum * (plot.bottom - plot.top), 'Manuscript vertical positions');
    }
    const panelTitle = textNodes(byPool[pool].body).find(node => node.text.startsWith(pool === 'direct' ? '(a)' : '(b)'));
    assert.ok(panelTitle);
    nearManuscript(Number(panelTitle.attributes.y), 78.173228, 'Panel title y');
    const xlabel = textNodes(byPool[pool].body).find(node => node.text === 'Distance from isocenter (mm)');
    nearManuscript(Number(xlabel.attributes.x), pool === 'direct' ? 149.464024 : 402.611567, 'Distance-axis title x');
    nearManuscript(Number(xlabel.attributes.y), 252.434830, 'Distance-axis title y');
    const ylabel = textNodes(byPool[pool].body).find(node => node.text === 'Number of candidates');
    nearManuscript(Number(ylabel.attributes.x), pool === 'direct' ? 34.832616 : 287.980158, 'Count-axis title x');
    nearManuscript(Number(ylabel.attributes.y), 155.515748, 'Count-axis title y');
    for (const tick of textNodes(byPool[pool].body).filter(node => node.attributes.class === 'candidate-count-tick')) {
      near(Number(tick.attributes.y), plot.bottom - Number(tick.text) / maximum * (plot.bottom - plot.top) + 3.79921875,
        'Adopted count tick baseline below its grid line');
    }
    for (const tick of textNodes(byPool[pool].body).filter(node => node.attributes.class === 'candidate-distance-tick')) {
      near(Number(tick.attributes.y), plot.bottom + 12.8984375, 'Adopted distance tick baseline');
    }
  }
  for (const [index, circle] of legendCircles(svg).entries()) {
    nearManuscript(Number(circle.cx), [390.330709, 436.251969, 482.173228][index], 'Occurrence marker x');
    nearManuscript(Number(circle.cy), 49.280315, 'Occurrence marker y');
  }
  const seriesLegend = [...svg.matchAll(/<circle\b([^>]*)>/g)].map(match => attributes(match[1]))
    .filter(circle => !circle.class && circle['data-legend-fraction'] === undefined);
  assert.equal(seriesLegend.length, 2);
  seriesLegend.forEach((circle, index) => {
    nearManuscript(Number(circle.cx), [36.348031, 128.813656][index], 'Series legend marker x');
    nearManuscript(Number(circle.cy), 58.070091, 'Series legend marker y');
    assert.equal(Number(circle.r), 2.5);
    assert.equal(Number(circle['stroke-width']), 1);
  });
}
checkManuscriptWideGeometry(svg, fixture);

function custom(radii, values = [0, 11], condition = {}) {
  const n = 12, mean = values[0] * .25 + values[1] * .75;
  const sd = Math.sqrt((values[0] - mean) ** 2 * .25 + (values[1] - mean) ** 2 * .75);
  const frequencies = values[0] === values[1] ? [{count: values[0], frequency: n, fraction: 1}] :
    [{count: values[0], frequency: 3, fraction: .25}, {count: values[1], frequency: 9, fraction: .75}];
  return {schemaVersion: 1, condition: {rows: 32, rowSpacingMm: .625, beamPitch: 1.125, Tmm: 2.5,
    directions: 3, startAngles: 4, statesPerRadius: n, ...condition}, radii: radii.map(radiusMm => ({radiusMm, sampleCount: n,
    windows: {fwhm: {left: -.8123456789012345, right: 1.25, width: 2.0623456789012344}, fwtm: {left: -2, right: 2, width: 4}},
    groups: Object.fromEntries(pools.map(pool => [pool, Object.fromEntries(windows.map(window => [window,
      {n, min: Math.min(...values), max: Math.max(...values), mean, sd, frequencies: clone(frequencies)}]))]))}))};
}

const single = custom([37.25]);
const singleSvg = renderCandidateCountsSvg(single);
assert.equal(circles(singleSvg).length, 8);
assert.match(singleSvg, /Collimation: 32 × 0\.625 mm/);
assert.match(singleSvg, /pitch: 1\.125/);
assert.match(singleSvg, /T = 2\.5 mm/);
assert.match(singleSvg, /3 directions × 4 start angles/);
assert.match(singleSvg, /data-position-scale="physical"/);
assert.equal((singleSvg.match(/>37\.25<\/text>/g) ?? []).length, 2);
const singleAttributes = attributes(singleSvg.match(/^<svg([^>]*)>/)[1]);
assert.equal(singleAttributes['data-reference-domain'], 'false');
assert.ok(Number(singleAttributes['data-x-minimum']) > 0 && Number(singleAttributes['data-x-maximum']) < 50,
  'Physical x range comes from requested positions, without a historical 0..114 floor');
const singleAxes = checkIndependentAxes(singleSvg, single);
assert.equal(singleAxes.direct.maximum, 12);
assert.equal(singleAxes.combined.maximum, 12);

// Few requested positions leave balanced margins instead of filling both edges.
for (const radii of [[20, 60], [0, 250], [20, 20.01]]) {
  const twoSvg = renderCandidateCountsSvg(custom(radii));
  const a = attributes(twoSvg.match(/^<svg([^>]*)>/)[1]);
  const lo = Number(a['data-x-minimum']), hi = Number(a['data-x-maximum']);
  near((radii[0] - lo) / (hi - lo), .25, 'First position at one-quarter plot width');
  near((radii[1] - lo) / (hi - lo), .75, 'Second position at three-quarter plot width');
  assert.equal(a['data-position-scale'], 'physical');
  assert.equal(a['data-reference-domain'], 'false', 'Two positions retain a balanced dynamic domain');
}
const spacedThreeSvg = renderCandidateCountsSvg(custom([10, 50, 90]));
const a3 = attributes(spacedThreeSvg.match(/^<svg([^>]*)>/)[1]);
near((10 - Number(a3['data-x-minimum'])) / (Number(a3['data-x-maximum']) - Number(a3['data-x-minimum'])), 1 / 6, 'Three-position edge margin');

const three = custom([47.2, 2.5, 16.125], [1, 4], {rows: 16, rowSpacingMm: 1.25, beamPitch: .5625, Tmm: 3.2});
const threeBefore = JSON.stringify(three), threeSvg = renderCandidateCountsSvg(three);
assert.match(threeSvg, /Collimation: 16 × 1\.25 mm/);
assert.match(threeSvg, /pitch: 0\.5625/);
assert.match(threeSvg, /T = 3\.2 mm/);
const threeAxes = checkIndependentAxes(threeSvg, three);
assert.equal(threeAxes.direct.maximum, 5, 'No fixed 9-count floor; include one count of headroom');
assert.equal(threeAxes.combined.maximum, 5);
assert.match(threeSvg, /data-position-scale="physical"/);
assert.deepEqual(csvRows(candidateSummaryCsv(three)).rows.slice(0, 6).map(row => Number(row.radius_mm)), [2.5, 2.5, 16.125, 16.125, 47.2, 47.2]);
assert.equal(JSON.stringify(three), threeBefore, 'Sorting never mutates requested position order');

const changedConditionsAtReferencePositions = custom([102, 10, 80, 50], [1, 4],
  {rows: 16, rowSpacingMm: 1.25, beamPitch: .5625, Tmm: 3.2});
const changedConditionSvg = renderCandidateCountsSvg(changedConditionsAtReferencePositions);
checkManuscriptWideGeometry(changedConditionSvg, changedConditionsAtReferencePositions);
checkIndependentAxes(changedConditionSvg, changedConditionsAtReferencePositions);
assert.match(changedConditionSvg, /Collimation: 16 × 1\.25 mm/);
assert.match(changedConditionSvg, /pitch: 0\.5625/);
assert.match(changedConditionSvg, /T = 3\.2 mm/);

const unevenReadableSvg = renderCandidateCountsSvg(custom([20, 28, 60]));
assert.match(unevenReadableSvg, /data-position-scale="physical"/,
  'Extra margins must not force previously readable physical positions onto equal spacing');

const closePositions = custom([0, .000001, 100]);
const closeSvg = renderCandidateCountsSvg(closePositions);
assert.match(closeSvg, /data-position-scale="equally-spaced"/);
assert.equal((closeSvg.match(/class="candidate-position-note"/g) ?? []).length, 2);
assert.match(closeSvg, /Positions equally spaced for comparison/);
assert.ok(circles(closeSvg).some(circle => circle['data-radius-mm'] === '0.000001'), 'Actual distances retained');

const twelve = custom(Array.from({length: 12}, (_, i) => Number((3.1 + i * .03).toFixed(2))), [1, 6]);
const twelveSvg = renderCandidateCountsSvg(twelve);
assert.equal(circles(twelveSvg).length, 96);
assert.match(twelveSvg, /rotate\(-60\)/, 'Many decimal labels rotate instead of overlapping');
assert.ok(circles(twelveSvg).every(circle => Number(circle['data-marker-scale']) < 1));
for (const fraction of [.1, .5, 1]) {
  const legend = [...twelveSvg.matchAll(/<circle\b([^>]*)>/g)].map(match => attributes(match[1]))
    .find(circle => circle['data-legend-fraction'] === String(fraction));
  assert.equal(legend['data-marker-scale'], circles(twelveSvg)[0]['data-marker-scale'], 'Legend uses the same adaptive marker scale');
}
const stacked = renderCandidateCountsSvg(twelve, {stacked: true});
assert.match(stacked, /width="100mm"/);
assert.match(stacked, /candidate-counts-en-stacked-title/);
assert.equal(circles(stacked).length, 96);
assert.ok(!/NaN|Infinity/.test(stacked));
checkIndependentAxes(twelveSvg, twelve);
checkIndependentAxes(stacked, twelve);

// Only one radius/window in one pool changes its observed maximum. The other
// pool keeps its scale and all marker coordinates; marker size and the common
// occurrence legend remain independent of either pool's y range.
const independentBase = custom([20, 60], [1, 4]);
const onePoolChanged = clone(independentBase);
onePoolChanged.radii[1].groups.direct.fwtm = clone(custom([60], [1, 8]).radii[0].groups.direct.fwtm);
for (const stacked of [false, true]) {
  const baseSvg = renderCandidateCountsSvg(independentBase, {stacked});
  const changedSvg = renderCandidateCountsSvg(onePoolChanged, {stacked});
  const beforeAxes = checkIndependentAxes(baseSvg, independentBase);
  const afterAxes = checkIndependentAxes(changedSvg, onePoolChanged);
  assert.equal(beforeAxes.direct.maximum, 5);
  assert.equal(afterAxes.direct.maximum, 9);
  assert.deepEqual(afterAxes.combined, beforeAxes.combined, 'Unchanged pool retains its axis');
  assert.deepEqual(circles(changedSvg).filter(circle => circle['data-pool'] === 'combined'),
    circles(baseSvg).filter(circle => circle['data-pool'] === 'combined'), 'Other panel marker attributes and positions are identical');
  const oldMarkers = circles(baseSvg), newMarkers = circles(changedSvg);
  assert.equal(newMarkers.length, oldMarkers.length);
  for (let i = 0; i < oldMarkers.length; i++) {
    for (const field of ['cx', 'r', 'fill', 'stroke', 'stroke-width', 'data-marker-size-pt2', 'data-marker-scale', 'data-frequency', 'data-fraction']) {
      assert.equal(newMarkers[i][field], oldMarkers[i][field], `Axis change preserves ${field}`);
    }
  }
  assert.deepEqual(legendCircles(changedSvg), legendCircles(baseSvg), 'One common size legend, unchanged by individual axis ranges');
  assert.equal(legendCircles(changedSvg).length, 3);
  for (const legend of legendCircles(changedSvg)) {
    assert.equal(legend['data-marker-scale'], newMarkers[0]['data-marker-scale']);
    near(Number(legend.r), Math.sqrt(1 + 95 * Number(legend['data-legend-fraction'])) / 2 * Number(legend['data-marker-scale']), 'Common occurrence-legend circle size');
  }
}
for (const exporter of [candidateFrequencyCsv, candidateSummaryCsv]) {
  const beforeOtherPool = csvRows(exporter(independentBase)).rows.filter(row => row.data_included === 'combined');
  const afterOtherPool = csvRows(exporter(onePoolChanged)).rows.filter(row => row.data_included === 'combined');
  assert.deepEqual(afterOtherPool, beforeOtherPool, 'Other pool CSV data are unchanged');
}

const large = custom([9.5, 100.25], [30000, 65000], {rows: 320, beamPitch: 2.25});
const largeSvg = renderCandidateCountsSvg(large);
const largeAxes = checkIndependentAxes(largeSvg, large);
assert.equal(largeAxes.direct.maximum, 80000);
assert.equal(largeAxes.combined.maximum, 80000);
assert.ok((largeSvg.match(/class="candidate-count-tick"/g) ?? []).length <= 16,
  'Large counts use a small set of integer ticks, never an integer-by-integer allocation');
assert.equal(csvRows(candidateFrequencyCsv(large)).rows.length, 16,
  'Frequency export does not allocate every integer up to a large candidate count');

const zero = custom([0], [0, 0]);
const zeroSvg = renderCandidateCountsSvg(zero);
const zeroAxes = checkIndependentAxes(zeroSvg, zero);
assert.equal(zeroAxes.direct.maximum, 1);
assert.equal(zeroAxes.combined.maximum, 1);
assert.equal(circles(zeroSvg).length, 4);
assert.ok(circles(zeroSvg).every(circle => circle['data-count'] === '0'));
assert.ok(!/NaN|Infinity/.test(zeroSvg));
checkIndependentAxes(renderCandidateCountsSvg(zero, {stacked: true}), zero);
for (const maximum of [8, 9, 10, 100, 1000]) {
  const headroomCase = custom([20, 60], [0, maximum]);
  for (const stacked of [false, true]) checkIndependentAxes(renderCandidateCountsSvg(headroomCase, {stacked}), headroomCase);
}
const explicitZero = custom([.1]);
for (const {group} of groupRows(explicitZero)) group.frequencies.push({count: 50000, frequency: 0, fraction: 0});
assert.equal(circles(renderCandidateCountsSvg(explicitZero)).length, 8);
assert.equal(csvRows(candidateFrequencyCsv(explicitZero)).rows.filter(row => row.frequency === '0' && row.candidate_count === '50000').length, 4);
const explicitZeroAxes = checkIndependentAxes(renderCandidateCountsSvg(explicitZero), explicitZero);
assert.equal(explicitZeroAxes.direct.maximum, 12, 'Unobserved zero-frequency outcomes never inflate an axis');
assert.equal(explicitZeroAxes.combined.maximum, 12);
assert.match(renderCandidateCountsSvg(single, {lang: 'ja'}), /候補データ数（個）/);

const repeated = custom([1, 1]);
assert.throws(() => candidateSummaryCsv(repeated), /repeated radius/);
const invalid = custom([1]); invalid.radii[0].groups.direct.fwhm.frequencies[0].frequency++;
assert.throws(() => renderCandidateCountsSvg(invalid), /COUNT_COMPARISON_DATA/);
assert.throws(() => candidateFrequencyCsv({schemaVersion: 2, radii: []}), /COUNT_COMPARISON_DATA/);
console.log(JSON.stringify({status: 'pass', originalPoints: 52, originalGroups: 16,
  genericCases: ['one-position', 'three-custom-decimal-positions', 'uneven-close-positions', 'twelve-positions', 'large-counts', 'zero-counts', 'explicit-zero-frequency', 'one-pool-maximum-change', 'small-large-headroom-boundary'],
  axisPolicy: 'independent direct/combined; small max+1; large nice integer ticks include upper headroom; all-zero0..1',
  fixtureMaximum: {direct: fixtureAxes.direct.maximum, combined: fixtureAxes.combined.maximum},
  preservation: ['circle sizes', 'common occurrence legend', 'other panel scale and coordinates', 'CSV bytes for unchanged data'],
  manuscriptStyle: {wideMm: [180, 95], referenceDomain: [-1, 114], dynamicConditionsAndOtherPositions: true},
  frequencyPolicy: 'preserve supplied observed and explicit-zero cells; no huge dense range', widthsMm: {wide: 180, stacked: 100}}));
