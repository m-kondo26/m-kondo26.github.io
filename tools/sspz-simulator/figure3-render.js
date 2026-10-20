// Figure 3 uses the manuscript's integer-frequency circles, not selected
// positive-weight candidates. Drawing and CSV exports never alter the data.
const FIGURE3_POOLS = ['direct', 'combined'];
const FIGURE3_WINDOWS = ['fwhm', 'fwtm'];
const FIGURE3_COLORS = {fwhm: '#2166A5', fwtm: '#C87620'};
const FIGURE3_PT_PER_MM = 72 / 25.4;

function figure3Escape(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function figure3Finite(value, name, minimum = -Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`FIGURE3_DATA: invalid ${name}`);
  }
  return value;
}

function figure3Integer(value, name, minimum = 0) {
  figure3Finite(value, name, minimum);
  if (!Number.isInteger(value)) throw new Error(`FIGURE3_DATA: invalid ${name}`);
  return value;
}

function figure3ValidatedData(data) {
  if (data?.schemaVersion !== 1 || !Array.isArray(data.radii) || !data.radii.length) {
    throw new Error('FIGURE3_DATA: schemaVersion 1 and radius results are required');
  }
  const condition = data.condition ?? {};
  figure3Integer(condition.rows, 'row count', 1);
  figure3Finite(condition.rowSpacingMm, 'row spacing', Number.MIN_VALUE);
  figure3Finite(condition.beamPitch, 'beam pitch', Number.MIN_VALUE);
  figure3Finite(condition.Tmm, 'averaging width', 0);
  const seen = new Set();
  const radii = data.radii.map(radius => {
    const radiusMm = figure3Finite(radius.radiusMm, 'radius', 0);
    if (seen.has(radiusMm)) throw new Error('FIGURE3_DATA: repeated radius');
    seen.add(radiusMm);
    const sampleCount = figure3Integer(radius.sampleCount, 'sample count', 1);
    if (condition.statesPerRadius !== undefined && sampleCount !== condition.statesPerRadius) {
      throw new Error('FIGURE3_DATA: sample count disagrees with conditions');
    }
    const windows = {};
    for (const name of FIGURE3_WINDOWS) {
      const window = radius.windows?.[name];
      if (!window) throw new Error(`FIGURE3_DATA: missing ${name} window`);
      const left = figure3Finite(window.left, 'window left');
      const right = figure3Finite(window.right, 'window right');
      if (right <= left) throw new Error('FIGURE3_DATA: empty response window');
      const width = window.width === undefined ? right - left : figure3Finite(window.width, 'window width', 0);
      if (Math.abs(width - (right - left)) > 1e-10) throw new Error('FIGURE3_DATA: inconsistent window width');
      windows[name] = {left, right, width};
    }
    const groups = {};
    for (const pool of FIGURE3_POOLS) {
      groups[pool] = {};
      for (const name of FIGURE3_WINDOWS) {
        const group = radius.groups?.[pool]?.[name];
        if (!group || !Array.isArray(group.frequencies) || !group.frequencies.length) {
          throw new Error(`FIGURE3_DATA: missing ${pool}/${name} distribution`);
        }
        const n = figure3Integer(group.n, 'group observations', 1);
        if (n !== sampleCount) throw new Error('FIGURE3_DATA: inconsistent group sample count');
        const counts = new Set();
        const frequencies = group.frequencies.map(point => {
          const count = figure3Integer(point.count, 'candidate count');
          const frequency = figure3Integer(point.frequency, 'frequency');
          const fraction = figure3Finite(point.fraction, 'fraction', 0);
          if (counts.has(count) || fraction > 1 || Math.abs(fraction - frequency / n) > 1e-12) {
            throw new Error('FIGURE3_DATA: inconsistent integer frequency');
          }
          counts.add(count);
          return {count, frequency, fraction};
        }).sort((a, b) => a.count - b.count);
        if (frequencies.reduce((sum, point) => sum + point.frequency, 0) !== n) {
          throw new Error('FIGURE3_DATA: frequency total does not equal sample count');
        }
        const observed = frequencies.filter(point => point.frequency > 0);
        const min = figure3Integer(group.min, 'minimum count');
        const max = figure3Integer(group.max, 'maximum count');
        if (min !== observed[0].count || max !== observed.at(-1).count) {
          throw new Error('FIGURE3_DATA: extrema disagree with frequencies');
        }
        const mean = figure3Finite(group.mean, 'mean count', 0);
        const sd = figure3Finite(group.sd, 'population standard deviation', 0);
        groups[pool][name] = {n, min, max, mean, sd, frequencies};
      }
    }
    return {radiusMm, sampleCount, windows, groups};
  }).sort((a, b) => a.radiusMm - b.radiusMm);
  return {condition, radii};
}

function figure3CountMaximum(data) {
  return Math.max(data.condition.Tmm === 1 ? 9 : 13,
    ...data.radii.flatMap(radius => FIGURE3_POOLS.flatMap(pool =>
      FIGURE3_WINDOWS.map(window => radius.groups[pool][window].max))));
}

function figure3GroupRows(data) {
  return FIGURE3_POOLS.flatMap(pool => data.radii.flatMap(radius =>
    FIGURE3_WINDOWS.map(window => ({pool, window, radius, group: radius.groups[pool][window]}))));
}

function figure3Csv(rows) {
  const cell = value => /[",\r\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Full-precision integer frequencies; unobserved integer cells have zero frequency. */
export function figure3FrequencyCsv(input) {
  const data = figure3ValidatedData(input), maximum = figure3CountMaximum(data);
  const rows = [['radius_mm', 'data_included', 'window', 'candidate_count', 'frequency', 'fraction',
    'total_observations', 'window_left_mm', 'window_right_mm', 'window_width_mm']];
  for (const {pool, window, radius, group} of figure3GroupRows(data)) {
    const points = new Map(group.frequencies.map(point => [point.count, point]));
    const counts = [...new Set([...Array.from({length: maximum + 1}, (_, i) => i), ...points.keys()])].sort((a, b) => a - b);
    for (const count of counts) {
      const point = points.get(count) ?? {frequency: 0, fraction: 0};
      const bounds = radius.windows[window];
      rows.push([radius.radiusMm, pool, window.toUpperCase(), count, point.frequency, point.fraction,
        group.n, bounds.left, bounds.right, bounds.width]);
    }
  }
  return figure3Csv(rows);
}

/** Group statistics retain the supplied unrounded values and physical-mm windows. */
export function figure3SummaryCsv(input) {
  const data = figure3ValidatedData(input);
  const rows = [['radius_mm', 'data_included', 'window', 'minimum_count', 'maximum_count', 'mean_count',
    'population_sd_count', 'total_observations', 'window_left_mm', 'window_right_mm', 'window_width_mm']];
  for (const {pool, window, radius, group} of figure3GroupRows(data)) {
    const bounds = radius.windows[window];
    rows.push([radius.radiusMm, pool, window.toUpperCase(), group.min, group.max, group.mean, group.sd,
      group.n, bounds.left, bounds.right, bounds.width]);
  }
  return figure3Csv(rows);
}

/** Publication layout is 180 × 95 mm. Stacked screen layout is 100 × 175 mm. */
export function renderFigure3Svg(input, {stacked = false, lang = 'en', idPrefix} = {}) {
  const data = figure3ValidatedData(input), japanese = lang.startsWith('ja');
  const text = (en, ja) => japanese ? ja : en;
  const widthMm = stacked ? 100 : 180, heightMm = stacked ? 175 : 95;
  const width = widthMm * FIGURE3_PT_PER_MM, height = heightMm * FIGURE3_PT_PER_MM;
  const maximum = figure3CountMaximum(data);
  const prefix = String(idPrefix ?? `figure3-${japanese ? 'ja' : 'en'}-${stacked ? 'stacked' : 'wide'}`).replace(/[^a-zA-Z0-9_-]/g, '-');
  const title = text(`Simulated candidate counts within SSPz windows: T = ${data.condition.Tmm} mm`,
    `SSPzの範囲内にある候補データ数：T = ${data.condition.Tmm} mm`);
  const description = text('Two panels compare real data only and real plus conjugate data. Blue circles are FWHM windows; orange circles are FWTM windows. Circle size encodes occurrence. Counts precede interpolation selection and weighting. Unobserved counts have no circle.',
    '実データのみと実データ・対向データの候補数を比較します。青はFWHM、橙はFWTMの範囲です。円の大きさは出現割合です。選択・重みづけ前に数え、出現しない個数には円を描きません。');
  const output = [`<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${prefix}-title ${prefix}-desc" data-layout="${stacked ? 'stacked' : 'publication'}">`,
    `<title id="${prefix}-title">${figure3Escape(title)}</title>`,
    `<desc id="${prefix}-desc">${figure3Escape(description)}</desc>`,
    `<rect width="${width}" height="${height}" fill="white"/>`,
    '<g font-family="DejaVu Sans, Arial, Noto Sans CJK JP, sans-serif" font-size="10" fill="#263544">'];
  const label = (x, y, value, attributes = '') => output.push(`<text x="${x}" y="${y}" ${attributes}>${figure3Escape(value)}</text>`);
  const line = (x1, y1, x2, y2, color = '#263544', stroke = .6) => output.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${stroke}"/>`);
  const marker = (x, y, fraction, color, attributes = '', titleText = '') => {
    // Matplotlib scatter s is in square points; its circular path has unit
    // diameter, hence radius sqrt(s)/2. Keep the adopted +1 pt² floor.
    const size = 1 + 95 * fraction, radius = Math.sqrt(size) / 2;
    output.push(`<circle cx="${x}" cy="${y}" r="${radius}" fill="${color}" stroke="${color}" stroke-width="0.55" data-marker-size-pt2="${size}" ${attributes}>${titleText ? `<title>${figure3Escape(titleText)}</title>` : ''}</circle>`);
  };
  const spacing = Number.isInteger(data.condition.rowSpacingMm) ? data.condition.rowSpacingMm.toFixed(1) : String(data.condition.rowSpacingMm);
  const directions = data.condition.directions ?? 360, starts = data.condition.startAngles ?? 360;
  const subtitle = text(`Collimation: ${data.condition.rows} × ${spacing} mm; pitch: ${data.condition.beamPitch}; ${directions} directions × ${starts} start angles`,
    `コリメーション：${data.condition.rows} × ${spacing} mm、pitch：${data.condition.beamPitch}、${directions}方向 × ${starts}開始角度`);
  if (stacked) {
    if (japanese) label(12, 18, title, 'font-size="11" font-weight="700"');
    else {
      label(12, 18, 'Simulated candidate counts within', 'font-size="12" font-weight="700"');
      label(12, 33, `SSPz windows: T = ${data.condition.Tmm} mm`, 'font-size="12" font-weight="700"');
    }
    label(12, 52, text(`Collimation: ${data.condition.rows} × ${spacing} mm; pitch: ${data.condition.beamPitch}`, `コリメーション：${data.condition.rows} × ${spacing} mm、pitch：${data.condition.beamPitch}`));
    label(12, 66, text(`${directions} directions × ${starts} start angles`, `${directions}方向 × ${starts}開始角度`));
  } else {
    label(.045 * width, .021 * height, title, 'font-size="12" font-weight="700" dominant-baseline="hanging"');
    label(.045 * width, .101 * height, subtitle, 'dominant-baseline="hanging"');
  }
  const legendY = stacked ? 85 : .183 * height;
  const legendX = stacked ? 17 : .05 * width;
  for (const [index, window] of FIGURE3_WINDOWS.entries()) {
    const x = legendX + index * (stacked ? 115 : 118);
    output.push(`<circle cx="${x}" cy="${legendY}" r="2.5" fill="${FIGURE3_COLORS[window]}"/>`);
    label(x + 8, legendY, text(`${window.toUpperCase()} (${index === 0 ? 'left' : 'right'})`, `${window.toUpperCase()}（${index === 0 ? '左' : '右'}）`), 'dominant-baseline="middle"');
  }
  const occurrenceY = stacked ? 107 : .183 * height;
  label(stacked ? 12 : .603 * width, occurrenceY, text('Occurrence', '出現割合'), 'dominant-baseline="middle"');
  for (const [i, fraction] of [.1, .5, 1].entries()) {
    const x = stacked ? 136 + i * 60 : [.765, .855, .945][i] * width;
    marker(x, occurrenceY, fraction, '#59636D', `data-legend-fraction="${fraction}"`);
    label(x, occurrenceY + 13, `${fraction * 100}%`, 'text-anchor="middle"');
  }
  const axisWidth = .872 * width / 2.32;
  const xMinimum = Math.min(-1, data.radii[0].radiusMm - 11);
  const xMaximum = Math.max(114, data.radii.at(-1).radiusMm + 12);
  for (const [index, pool] of FIGURE3_POOLS.entries()) {
    const left = stacked ? 45 : .105 * width + index * axisWidth * 1.32;
    const right = stacked ? width - 11 : left + axisWidth;
    const top = stacked ? 150 + index * 184 : .32 * height;
    const bottom = stacked ? top + 118 : .835 * height;
    const x = value => left + (value - xMinimum) / (xMaximum - xMinimum) * (right - left);
    const y = value => bottom - value / maximum * (bottom - top);
    const panelTitle = pool === 'direct' ? text('Real data only', '実データのみ') : text('Real + conjugate', '実データ＋対向データ');
    label(left, top - 8, `(${String.fromCharCode(97 + index)})  ${panelTitle}`, 'font-size="10.5" font-weight="700"');
    for (let count = 0; count <= maximum; count++) {
      line(left, y(count), right, y(count), '#E3E7EB', .4);
      line(left - 2.3, y(count), left, y(count), '#263544', .55);
      label(left - 5.3, y(count), count, 'text-anchor="end" dominant-baseline="middle"');
    }
    line(left, top, left, bottom); line(left, bottom, right, bottom);
    for (const radius of data.radii) {
      line(x(radius.radiusMm), bottom, x(radius.radiusMm), bottom + 2.3, '#263544', .55);
      label(x(radius.radiusMm), bottom + 14.5, radius.radiusMm, 'text-anchor="middle"');
    }
    label((left + right) / 2, bottom + 31, text('Distance from isocenter (mm)', 'アイソセンタからの距離（mm）'), 'text-anchor="middle"');
    output.push(`<text transform="translate(${left - 32} ${(top + bottom) / 2}) rotate(-90)" text-anchor="middle">${figure3Escape(text('Number of candidates', '候補データ数（個）'))}</text>`);
    const clip = `${prefix}-clip-${pool}`;
    output.push(`<defs><clipPath id="${clip}"><rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}"/></clipPath></defs><g clip-path="url(#${clip})">`);
    for (const radius of data.radii) for (const [windowIndex, window] of FIGURE3_WINDOWS.entries()) {
      for (const point of radius.groups[pool][window].frequencies) {
        if (point.frequency === 0) continue;
        const center = radius.radiusMm + (windowIndex === 0 ? -4.4 : 4.4);
        const attributes = `class="figure3-observation" data-pool="${pool}" data-radius-mm="${radius.radiusMm}" data-window="${window}" data-count="${point.count}" data-frequency="${point.frequency}" data-fraction="${point.fraction}" data-x-display-mm="${center}"`;
        const hover = `${panelTitle}; r = ${radius.radiusMm} mm; ${window.toUpperCase()}; ${point.count} ${text('candidates', '個')}; ${point.frequency}/${radius.sampleCount} (${Number((100 * point.fraction).toPrecision(6))}%)`;
        marker(x(center), y(point.count), point.fraction, FIGURE3_COLORS[window], attributes, hover);
      }
    }
    output.push('</g>');
  }
  output.push('</g></svg>');
  return output.join('');
}
