// Candidate counts are geometric row-centre populations before selection.
// Drawing and CSV exports retain the supplied unrounded numerical results.
const COUNT_COMPARISON_POOLS = ['direct', 'combined'];
const COUNT_COMPARISON_WINDOWS = ['fwhm', 'fwtm'];
const COUNT_COMPARISON_COLORS = {fwhm: '#2166A5', fwtm: '#C87620'};
const COUNT_COMPARISON_PT_PER_MM = 72 / 25.4;

function countComparisonEscape(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function countComparisonFinite(value, name, minimum = -Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`COUNT_COMPARISON_DATA: invalid ${name}`);
  }
  return value;
}

function countComparisonInteger(value, name, minimum = 0) {
  countComparisonFinite(value, name, minimum);
  if (!Number.isInteger(value)) throw new Error(`COUNT_COMPARISON_DATA: invalid ${name}`);
  return value;
}

function countComparisonValidatedData(data) {
  if (data?.schemaVersion !== 1 || !Array.isArray(data.radii) || !data.radii.length) {
    throw new Error('COUNT_COMPARISON_DATA: schemaVersion 1 and radius results are required');
  }
  const condition = data.condition ?? {};
  countComparisonInteger(condition.rows, 'row count', 1);
  countComparisonFinite(condition.rowSpacingMm, 'row spacing', Number.MIN_VALUE);
  countComparisonFinite(condition.beamPitch, 'beam pitch', Number.MIN_VALUE);
  countComparisonFinite(condition.Tmm, 'averaging width', 0);
  countComparisonInteger(condition.directions, 'analysis directions', 1);
  countComparisonInteger(condition.startAngles, 'start angles', 1);
  const seen = new Set();
  const radii = data.radii.map(radius => {
    const radiusMm = countComparisonFinite(radius.radiusMm, 'radius', 0);
    if (seen.has(radiusMm)) throw new Error('COUNT_COMPARISON_DATA: repeated radius');
    seen.add(radiusMm);
    const sampleCount = countComparisonInteger(radius.sampleCount, 'sample count', 1);
    if (sampleCount !== condition.directions * condition.startAngles) {
      throw new Error('COUNT_COMPARISON_DATA: sample count disagrees with angular grids');
    }
    if (condition.statesPerRadius !== undefined && sampleCount !== condition.statesPerRadius) {
      throw new Error('COUNT_COMPARISON_DATA: sample count disagrees with conditions');
    }
    const windows = {};
    for (const name of COUNT_COMPARISON_WINDOWS) {
      const window = radius.windows?.[name];
      if (!window) throw new Error(`COUNT_COMPARISON_DATA: missing ${name} window`);
      const left = countComparisonFinite(window.left, 'window left');
      const right = countComparisonFinite(window.right, 'window right');
      if (right <= left) throw new Error('COUNT_COMPARISON_DATA: empty response window');
      const width = window.width === undefined ? right - left : countComparisonFinite(window.width, 'window width', 0);
      if (Math.abs(width - (right - left)) > 1e-10) throw new Error('COUNT_COMPARISON_DATA: inconsistent window width');
      windows[name] = {left, right, width};
    }
    const groups = {};
    for (const pool of COUNT_COMPARISON_POOLS) {
      groups[pool] = {};
      for (const name of COUNT_COMPARISON_WINDOWS) {
        const group = radius.groups?.[pool]?.[name];
        if (!group || !Array.isArray(group.frequencies) || !group.frequencies.length) {
          throw new Error(`COUNT_COMPARISON_DATA: missing ${pool}/${name} distribution`);
        }
        const n = countComparisonInteger(group.n, 'group observations', 1);
        if (n !== sampleCount) throw new Error('COUNT_COMPARISON_DATA: inconsistent group sample count');
        const counts = new Set();
        const frequencies = group.frequencies.map(point => {
          const count = countComparisonInteger(point.count, 'candidate count');
          const frequency = countComparisonInteger(point.frequency, 'frequency');
          const fraction = countComparisonFinite(point.fraction, 'fraction', 0);
          if (counts.has(count) || fraction > 1 || Math.abs(fraction - frequency / n) > 1e-12) {
            throw new Error('COUNT_COMPARISON_DATA: inconsistent integer frequency');
          }
          counts.add(count);
          return {count, frequency, fraction};
        }).sort((a, b) => a.count - b.count);
        if (frequencies.reduce((sum, point) => sum + point.frequency, 0) !== n) {
          throw new Error('COUNT_COMPARISON_DATA: frequency total does not equal sample count');
        }
        const observed = frequencies.filter(point => point.frequency > 0);
        const min = countComparisonInteger(group.min, 'minimum count');
        const max = countComparisonInteger(group.max, 'maximum count');
        if (min !== observed[0].count || max !== observed.at(-1).count) {
          throw new Error('COUNT_COMPARISON_DATA: extrema disagree with frequencies');
        }
        const mean = countComparisonFinite(group.mean, 'mean count', 0);
        const sd = countComparisonFinite(group.sd, 'population standard deviation', 0);
        groups[pool][name] = {n, min, max, mean, sd, frequencies};
      }
    }
    return {radiusMm, sampleCount, windows, groups};
  }).sort((a, b) => a.radiusMm - b.radiusMm);
  return {condition, radii};
}

function countComparisonGroups(data) {
  return COUNT_COMPARISON_POOLS.flatMap(pool => data.radii.flatMap(radius =>
    COUNT_COMPARISON_WINDOWS.map(window => ({pool, window, radius, group: radius.groups[pool][window]}))));
}

function countComparisonCsv(rows) {
  const cell = value => /[",\r\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Supplied integer-frequency cells, including explicit zero-frequency cells.
 * Do not allocate every integer below a potentially very large observed count.
 */
export function candidateFrequencyCsv(input) {
  const rows = [['radius_mm', 'data_included', 'window', 'candidate_count', 'frequency', 'fraction',
    'total_observations', 'window_left_mm', 'window_right_mm', 'window_width_mm']];
  for (const {pool, window, radius, group} of countComparisonGroups(countComparisonValidatedData(input))) {
    const bounds = radius.windows[window];
    for (const point of group.frequencies) rows.push([radius.radiusMm, pool, window.toUpperCase(), point.count,
      point.frequency, point.fraction, group.n, bounds.left, bounds.right, bounds.width]);
  }
  return countComparisonCsv(rows);
}

/** Full-precision group statistics and response-window coordinates in mm. */
export function candidateSummaryCsv(input) {
  const rows = [['radius_mm', 'data_included', 'window', 'minimum_count', 'maximum_count', 'mean_count',
    'population_sd_count', 'total_observations', 'window_left_mm', 'window_right_mm', 'window_width_mm']];
  for (const {pool, window, radius, group} of countComparisonGroups(countComparisonValidatedData(input))) {
    const bounds = radius.windows[window];
    rows.push([radius.radiusMm, pool, window.toUpperCase(), group.min, group.max, group.mean, group.sd,
      group.n, bounds.left, bounds.right, bounds.width]);
  }
  return countComparisonCsv(rows);
}

function countComparisonYAxis(maximum) {
  if (maximum <= 8) return {maximum: Math.max(1, maximum), ticks: Array.from({length: Math.max(1, maximum) + 1}, (_, i) => i)};
  const raw = maximum / 6, power = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].find(multiplier => multiplier * power >= raw) * power);
  const top = Math.ceil(maximum / step) * step;
  return {maximum: top, ticks: Array.from({length: Math.round(top / step) + 1}, (_, i) => i * step)};
}

function countComparisonTextWidth(value, size = 10) {
  return [...String(value)].reduce((sum, character) => sum + (/[\u3000-\u9fff\uff00-\uffef]/.test(character) ? size : size * .56), 0);
}

function countComparisonHeaderLines(tokens, available) {
  const lines = []; let current = '';
  for (const token of tokens) {
    const next = current ? `${current}; ${token}` : token;
    if (current && countComparisonTextWidth(next) > available) {lines.push(current); current = token;}
    else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

/** Arbitrary evaluation positions; physical spacing is retained when legible.
 * Very close/uneven positions use an explicitly labelled equally spaced axis.
 * Export width is 180 mm; stacked screen width is 100 mm. Height adapts to
 * tick-label length and panel arrangement, and is recorded in the SVG itself.
 */
export function renderCandidateCountsSvg(input, {stacked = false, lang = 'en', idPrefix} = {}) {
  const data = countComparisonValidatedData(input), japanese = lang.startsWith('ja');
  const text = (en, ja) => japanese ? ja : en;
  const widthMm = stacked ? 100 : 180, width = widthMm * COUNT_COMPARISON_PT_PER_MM;
  const yAxis = countComparisonYAxis(Math.max(...countComparisonGroups(data).map(({group}) => group.max)));
  const yLabelWidth = Math.max(...yAxis.ticks.map(value => countComparisonTextWidth(value)));
  const leftMargin = Math.max(stacked ? 44 : 54, yLabelWidth + 24), rightMargin = 12;
  const panelGap = Math.max(60, yLabelWidth + 30);
  const axisWidth = stacked ? width - leftMargin - rightMargin : (width - leftMargin - rightMargin - panelGap) / 2;
  const labels = data.radii.map(radius => String(radius.radiusMm));
  const labelWidth = Math.max(...labels.map(value => countComparisonTextWidth(value, 9)));
  const minimum = data.radii[0].radiusMm, maximum = data.radii.at(-1).radiusMm;
  const span = maximum - minimum;
  const gaps = data.radii.slice(1).map((radius, i) => radius.radiusMm - data.radii[i].radiusMm);
  const minimumGap = gaps.length ? Math.min(...gaps) : 0;
  const requiredGapPt = Math.max(27, labelWidth + 4);
  const basePadding = span * .12;
  // Give a small set of positions half a nominal inter-position gap at each
  // edge. Two positions sit at 25% and 75% when labels permit. Cap additional
  // padding before it would squeeze readable physical spacing into a fallback.
  const equallySpaced = data.radii.length > 1 && minimumGap / (span + 2 * basePadding) * axisWidth < requiredGapPt;
  const paddingFraction = data.radii.length > 1 ? Math.max(.12, 1 / (2 * (data.radii.length - 1))) : 0;
  let padding = span ? span * paddingFraction : Math.max(1, Math.abs(minimum) * .1);
  if (data.radii.length > 1 && !equallySpaced) {
    const readablePadding = (minimumGap * axisWidth / requiredGapPt - span) / 2;
    padding = Math.min(padding, Math.max(basePadding, readablePadding));
  }
  const xMinimum = minimum - padding, xMaximum = maximum + padding;
  const physicalGapPt = (gaps.length ? minimumGap : xMaximum - xMinimum) / (xMaximum - xMinimum) * axisWidth;
  const slot = equallySpaced ? axisWidth / data.radii.length : physicalGapPt;
  const markerScale = Math.min(1, slot * .8 / (2 * Math.sqrt(96)));
  const rotated = labelWidth > slot * .9;
  const tickHeight = rotated ? labelWidth * Math.sin(Math.PI / 3) + 12 : 18;
  const axisTextHeight = tickHeight + 20 + (equallySpaced ? 13 : 0);
  const rowSpacing = Number.isInteger(data.condition.rowSpacingMm) ? data.condition.rowSpacingMm.toFixed(1) : String(data.condition.rowSpacingMm);
  const directions = data.condition.directions, starts = data.condition.startAngles;
  const header = countComparisonHeaderLines([
    text(`Collimation: ${data.condition.rows} × ${rowSpacing} mm`, `検出器：${data.condition.rows} × ${rowSpacing} mm`),
    `pitch: ${data.condition.beamPitch}`, `T = ${data.condition.Tmm} mm`,
    text(`${directions} directions × ${starts} start angles`, `${directions}方向 × ${starts}開始角度`),
  ], width - 24);
  const subtitleEnd = 30 + (header.length - 1) * 14;
  const legendY = subtitleEnd + 19, occurrenceY = stacked ? legendY + 23 : legendY;
  const plotTop = occurrenceY + 39, plotHeight = stacked ? 122 : 138;
  const panelHeight = plotHeight + axisTextHeight + 29;
  const height = plotTop + plotHeight + axisTextHeight + 12 + (stacked ? panelHeight : 0);
  const heightMm = height / COUNT_COMPARISON_PT_PER_MM;
  const prefix = String(idPrefix ?? `candidate-counts-${japanese ? 'ja' : 'en'}-${stacked ? 'stacked' : 'wide'}`).replace(/[^a-zA-Z0-9_-]/g, '-');
  const title = text('Candidate counts within SSPz windows', 'SSPz範囲内の候補データ数');
  const axisNote = equallySpaced ? text('Positions equally spaced for comparison', '位置は比較のため等間隔表示') : '';
  const description = text('Real-only and real-plus-conjugate panels compare geometric detector-row centres before interpolation selection or weighting. Blue represents FWHM and orange FWTM. Circle size encodes occurrence. Unobserved outcomes have no circle.',
    '実データのみと実データ・対向データについて、補間の選択・重みづけ前の列中心数を比較します。青はFWHM、橙はFWTMです。円の大きさは出現割合を示し、出現しない個数は描画しません。') + (axisNote ? ` ${axisNote}.` : '');
  const output = [`<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${prefix}-title ${prefix}-desc" data-layout="${stacked ? 'stacked' : 'wide'}" data-position-scale="${equallySpaced ? 'equally-spaced' : 'physical'}" data-x-minimum="${xMinimum}" data-x-maximum="${xMaximum}" data-y-maximum="${yAxis.maximum}">`,
    `<title id="${prefix}-title">${countComparisonEscape(title)}</title>`, `<desc id="${prefix}-desc">${countComparisonEscape(description)}</desc>`,
    `<rect width="${width}" height="${height}" fill="white"/>`,
    '<g font-family="DejaVu Sans, Arial, Noto Sans CJK JP, sans-serif" font-size="10" fill="#263544">'];
  const label = (x, y, value, attributes = '') => output.push(`<text x="${x}" y="${y}" ${attributes}>${countComparisonEscape(value)}</text>`);
  const line = (x1, y1, x2, y2, color = '#263544', stroke = .6) => output.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${stroke}"/>`);
  const marker = (x, y, fraction, color, attributes = '', titleText = '', scale = markerScale) => {
    const size = 1 + 95 * fraction, radius = Math.sqrt(size) / 2 * scale;
    output.push(`<circle cx="${x}" cy="${y}" r="${radius}" fill="${color}" stroke="${color}" stroke-width="${.55 * scale}" data-marker-size-pt2="${size}" data-marker-scale="${scale}" ${attributes}>${titleText ? `<title>${countComparisonEscape(titleText)}</title>` : ''}</circle>`);
  };
  label(12, 14, title, 'font-size="12" font-weight="700"');
  header.forEach((value, i) => label(12, 30 + 14 * i, value));
  for (const [index, window] of COUNT_COMPARISON_WINDOWS.entries()) {
    const x = 17 + index * (stacked ? 118 : 115);
    output.push(`<circle cx="${x}" cy="${legendY}" r="2.5" fill="${COUNT_COMPARISON_COLORS[window]}"/>`);
    label(x + 8, legendY, text(`${window.toUpperCase()} (${index === 0 ? 'left' : 'right'})`, `${window.toUpperCase()}（${index === 0 ? '左' : '右'}）`), 'dominant-baseline="middle"');
  }
  label(stacked ? 12 : width * .603, occurrenceY, text('Occurrence', '出現割合'), 'dominant-baseline="middle"');
  for (const [i, fraction] of [.1, .5, 1].entries()) {
    const x = stacked ? 136 + i * 60 : width * [.765, .855, .945][i];
    marker(x, occurrenceY, fraction, '#59636D', `data-legend-fraction="${fraction}"`);
    label(x, occurrenceY + 13, `${fraction * 100}%`, 'text-anchor="middle"');
  }
  for (const [panelIndex, pool] of COUNT_COMPARISON_POOLS.entries()) {
    const left = leftMargin + (stacked ? 0 : panelIndex * (axisWidth + panelGap));
    const right = left + axisWidth, top = plotTop + (stacked ? panelIndex * panelHeight : 0), bottom = top + plotHeight;
    const x = (radius, index) => equallySpaced ? left + (index + .5) / data.radii.length * axisWidth : left + (radius - xMinimum) / (xMaximum - xMinimum) * axisWidth;
    const offset = equallySpaced ? Math.min(12, slot * .2) : Math.min((gaps.length ? minimumGap : xMaximum - xMinimum) * .2, (xMaximum - xMinimum) * .06) / (xMaximum - xMinimum) * axisWidth;
    const y = count => bottom - count / yAxis.maximum * plotHeight;
    const panelTitle = pool === 'direct' ? text('Real data only', '実データのみ') : text('Real + conjugate', '実データ＋対向データ');
    label(left, top - 10, `(${String.fromCharCode(97 + panelIndex)})  ${panelTitle}`, 'font-size="10.5" font-weight="700"');
    for (const count of yAxis.ticks) {
      line(left, y(count), right, y(count), '#E3E7EB', .4);
      line(left - 2.3, y(count), left, y(count), '#263544', .55);
      label(left - 5.3, y(count), count, 'class="candidate-count-tick" text-anchor="end" dominant-baseline="middle"');
    }
    line(left, top, left, bottom); line(left, bottom, right, bottom);
    data.radii.forEach((radius, index) => {
      const center = x(radius.radiusMm, index);
      line(center, bottom, center, bottom + 2.3, '#263544', .55);
      if (rotated) output.push(`<text class="candidate-distance-tick" transform="translate(${center} ${bottom + 8}) rotate(-60)" text-anchor="end" font-size="9">${countComparisonEscape(labels[index])}</text>`);
      else label(center, bottom + 14.5, labels[index], 'class="candidate-distance-tick" text-anchor="middle" font-size="9"');
    });
    const axisLabelY = bottom + tickHeight + 14;
    label((left + right) / 2, axisLabelY, text('Distance from isocenter (mm)', 'アイソセンタからの距離（mm）'), 'text-anchor="middle"');
    if (axisNote) label((left + right) / 2, axisLabelY + 13, axisNote, 'class="candidate-position-note" text-anchor="middle" font-size="8.5"');
    const yTitleX = Math.max(12, left - yLabelWidth - 14);
    output.push(`<text transform="translate(${yTitleX} ${(top + bottom) / 2}) rotate(-90)" text-anchor="middle">${countComparisonEscape(text('Number of candidates', '候補データ数（個）'))}</text>`);
    const clip = `${prefix}-clip-${pool}`, bleed = 6 * markerScale;
    output.push(`<defs><clipPath id="${clip}"><rect x="${left - bleed}" y="${top - bleed}" width="${axisWidth + 2 * bleed}" height="${plotHeight + 2 * bleed}"/></clipPath></defs><g clip-path="url(#${clip})">`);
    data.radii.forEach((radius, index) => COUNT_COMPARISON_WINDOWS.forEach((window, windowIndex) => {
      for (const point of radius.groups[pool][window].frequencies) {
        if (point.frequency === 0) continue;
        const center = x(radius.radiusMm, index) + (windowIndex === 0 ? -offset : offset);
        const attributes = `class="candidate-count-observation" data-pool="${pool}" data-radius-mm="${radius.radiusMm}" data-window="${window}" data-count="${point.count}" data-frequency="${point.frequency}" data-fraction="${point.fraction}"`;
        const hover = `${panelTitle}; r = ${radius.radiusMm} mm; ${window.toUpperCase()}; ${point.count} ${text('candidates', '個')}; ${point.frequency}/${radius.sampleCount} (${Number((100 * point.fraction).toPrecision(6))}%)`;
        marker(center, y(point.count), point.fraction, COUNT_COMPARISON_COLORS[window], attributes, hover);
      }
    }));
    output.push('</g>');
  }
  output.push('</g></svg>');
  return output.join('');
}
