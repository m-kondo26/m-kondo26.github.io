// Central-axis HFI coefficient response, independent of the SSPz point model.
// Taguchi & Aradate (1998), Eq. (6) and Appendix A1–A5: integrate the
// piecewise-linear interpolant through a rectangular axial filter.
// Ichikawa et al. (2015), p.376: sum row coefficients at their original times.
//
// Scope: four uniform rows, gamma=0, a continuous helix and all equivalent
// direct/complementary ray copies. This explicit candidate convention is NOT
// a verified reproduction of Aquilion's acquisition selection: Fig.5(d)'s
// detailed shape remains discrepant. Never replace this with a fitted curve.

export const TAGUCHI_TSP_VERSION = '2026-09-25.1';

function finiteValue(value, fallback, name, lower, upper) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < lower || number > upper) {
    throw new RangeError(`${name} must be between ${lower} and ${upper}.`);
  }
  return number;
}

function configuration(input = {}) {
  const rows = finiteValue(input.rows, 4, 'rows', 4, 4);
  if (input.radius != null && Number(input.radius) !== 0) {
    throw new RangeError('This HFI reference is defined only at radius = 0.');
  }
  const rowWidth = finiteValue(input.rowWidth, 2, 'rowWidth', 0.05, 20);
  const beamPitch = finiteValue(input.beamPitch, 0.625, 'beamPitch', 0.05, 3);
  const filterWidthMm = finiteValue(input.filterWidthMm, 2, 'filterWidthMm', 0, 40);
  const rotationTime = finiteValue(input.rotationTime, 1, 'rotationTime', 0.05, 5);
  const viewSamples = finiteValue(input.viewSamples, 7200, 'viewSamples', 16, 28800);
  if (!Number.isInteger(viewSamples)) throw new RangeError('viewSamples must be an integer.');
  return {
    rows, rowWidth, beamPitch, filterWidthMm, rotationTime, viewSamples,
    radius: 0, channelAngleRadians: 0, tableFeedPerRotationMm: rows * rowWidth * beamPitch,
    rowPitch: rows * beamPitch, filterShape: 'rectangular',
    temporalGridMeaning: 'numerical evaluation samples per rotation; not acquired view count',
    candidateRule: 'all-equivalent-rays-on-continuous-helix',
    coincidentRule: 'equal-average-of-coincident-acquisitions',
  };
}

// Merge coincident z knots before interpolation. Equal averaging shares a
// knot's coefficient across the ORIGINAL acquisitions, retaining their times.
// Eq.(6) assumes distinct neighbors; this tie convention is stated explicitly.
function mergedKnots(config, phaseTurns, halfCopies) {
  const points = [];
  const feed = config.tableFeedPerRotationMm;
  const tolerance = 1e-10 * config.rowWidth;
  for (let halfTurn = -halfCopies; halfTurn <= halfCopies; halfTurn += 1) {
    for (let row = 0; row < config.rows; row += 1) {
      const timeTurns = phaseTurns + halfTurn / 2;
      points.push({
        z: feed * timeTurns + (row + 0.5 - config.rows / 2) * config.rowWidth,
        row, halfTurn, timeTurns,
      });
    }
  }
  points.sort((a, b) => a.z - b.z || a.timeTurns - b.timeTurns || a.row - b.row);
  const knots = [];
  for (const point of points) {
    const previous = knots[knots.length - 1];
    if (previous && Math.abs(point.z - previous.z) <= tolerance) previous.acquisitions.push(point);
    else knots.push({z: point.z, acquisitions: [point]});
  }
  return knots;
}

// Integral of the cardinal, piecewise-linear basis centered at b, clipped to
// the filter. This is the rectangular direct-filtering Appendix in one form.
function basisAverage(a, b, c, filterWidth) {
  if (filterWidth === 0) {
    if (0 < a || 0 > c) return 0;
    return 0 <= b ? (0 - a) / (b - a) : (c - 0) / (c - b);
  }
  const lower = -filterWidth / 2;
  const upper = filterWidth / 2;
  let integral = 0;
  let left = Math.max(a, lower);
  let right = Math.min(b, upper);
  if (right > left) integral += (right - left) * ((left - a) + (right - a)) / (2 * (b - a));
  left = Math.max(b, lower);
  right = Math.min(c, upper);
  if (right > left) integral += (right - left) * ((c - left) + (c - right)) / (2 * (c - b));
  return integral / filterWidth;
}

function directRowBasis(config) {
  const rowSpan = (config.rows - 1) * config.rowWidth;
  // Every row at halfTurn=0 has both neighbors well inside this superset.
  const copies = Math.ceil(2 * rowSpan / config.tableFeedPerRotationMm) + 3;
  const knots = mergedKnots(config, 0, copies);
  const basis = [];
  for (let j = 1; j < knots.length - 1; j += 1) {
    for (const acquisition of knots[j].acquisitions) {
      if (acquisition.halfTurn === 0) basis.push({
        row: acquisition.row, a: knots[j - 1].z, b: knots[j].z, c: knots[j + 1].z,
        share: 1 / knots[j].acquisitions.length,
      });
    }
  }
  if (basis.length !== config.rows) throw new Error('HFI candidate enumeration lost a detector row.');
  return basis.sort((a, b) => a.row - b.row);
}

// Exposed for audit/teaching: one oriented-ray family after rectangular HFI.
// Nonzero coefficients sum to one; temporal coefficients are not normalized
// per acquisition time or multiplied by a stationary-object detector signal.
export function taguchiHfiWeightsAtPhase(input = {}, phaseTurns = 0) {
  const config = configuration(input);
  if (!Number.isFinite(phaseTurns)) throw new RangeError('phaseTurns must be finite.');
  const feed = config.tableFeedPerRotationMm;
  const span = config.filterWidthMm / 2 + (config.rows - 1) * config.rowWidth / 2;
  const copies = Math.ceil(2 * (span / feed + Math.abs(phaseTurns))) + 4;
  const knots = mergedKnots(config, phaseTurns, copies);
  const records = [];
  for (let j = 1; j < knots.length - 1; j += 1) {
    const coefficient = basisAverage(knots[j - 1].z, knots[j].z, knots[j + 1].z, config.filterWidthMm);
    if (!(coefficient > 0)) continue;
    const weight = coefficient / knots[j].acquisitions.length;
    for (const acquisition of knots[j].acquisitions) records.push({
      row: acquisition.row, halfTurn: acquisition.halfTurn,
      timeTurns: acquisition.timeTurns, zMm: acquisition.z, weight,
      coincidentAcquisitions: knots[j].acquisitions.length,
    });
  }
  records.sort((a, b) => a.timeTurns - b.timeTurns || a.row - b.row);
  return {config, records, sum: records.reduce((sum, record) => sum + record.weight, 0)};
}

function thresholdWidth(times, values, fraction) {
  const epsilon = 1e-12;
  let first = -1;
  let last = -1;
  let intervals = 0;
  let within = false;
  let thresholdPlateau = false;
  for (let i = 0; i < values.length; i += 1) {
    const above = values[i] >= fraction - epsilon;
    if (above) {
      if (first < 0) first = i;
      last = i;
      if (!within) intervals += 1;
    }
    if (i > 0 && Math.abs(values[i] - fraction) <= epsilon && Math.abs(values[i - 1] - fraction) <= epsilon) {
      thresholdPlateau = true;
    }
    within = above;
  }
  if (first < 0 || first === 0 || last === values.length - 1) return {width: null, envelopeWidth: null, intervals, reason: 'unbounded-or-missing-crossing'};
  const crossing = (a, b) => {
    const slope = values[b] - values[a];
    if (Math.abs(slope) < epsilon) return (times[a] + times[b]) / 2;
    return times[a] + (times[b] - times[a]) * (fraction - values[a]) / slope;
  };
  const lower = crossing(first - 1, first);
  const upper = crossing(last, last + 1);
  const reason = intervals > 1 ? 'disconnected-threshold-intervals'
    : thresholdPlateau ? 'plateau-at-threshold' : null;
  return {width: reason ? null : upper - lower, envelopeWidth: upper - lower, lower, upper, intervals, reason};
}

export function computeTaguchiTsp(input = {}) {
  const config = configuration(input);
  const basis = directRowBasis(config);
  const feed = config.tableFeedPerRotationMm;
  const width = config.filterWidthMm;
  const maxZ = Math.max(...basis.map(row => Math.max(Math.abs(row.a), Math.abs(row.c))));
  const supportTurns = (maxZ + width / 2) / feed;
  // Preserve the full helix. +/- one rotation was Ichikawa's example grid,
  // not a universal acquisition boundary for arbitrary pitch/filter width.
  const halfSamples = Math.ceil(supportTurns * config.viewSamples) + 2;
  const timeTurns = new Float64Array(2 * halfSamples + 1);
  const raw = new Float64Array(timeTurns.length);
  let peak = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const time = (i - halfSamples) / config.viewSamples;
    timeTurns[i] = time;
    const shift = feed * time;
    for (const row of basis) raw[i] += row.share * basisAverage(row.a + shift, row.b + shift, row.c + shift, width);
    peak = Math.max(peak, raw[i]);
  }
  if (!(peak > 0)) throw new Error('HFI produced no positive coefficients.');
  const profile = Float64Array.from(raw, value => value / peak);
  const fwhm = thresholdWidth(timeTurns, profile, 0.5);
  const fwtm = thresholdWidth(timeTurns, profile, 0.1);
  let rawArea = 0;
  for (let i = 1; i < raw.length; i += 1) rawArea += (raw[i - 1] + raw[i]) / (2 * config.viewSamples);
  const equivalentWidthTurns = rawArea / peak;
  const msPerTurn = 1000 * config.rotationTime;
  const weights = taguchiHfiWeightsAtPhase(config, 0.137);
  return {
    version: TAGUCHI_TSP_VERSION, method: 'taguchi-hfi-central-axis-reference',
    config, timeTurns, raw, profile,
    metrics: {
      fwhmTurns: fwhm.width, fwtmTurns: fwtm.width, equivalentWidthTurns,
      fwhmMs: fwhm.width == null ? null : fwhm.width * msPerTurn,
      fwtmMs: fwtm.width == null ? null : fwtm.width * msPerTurn,
      equivalentWidthMs: equivalentWidthTurns * msPerTurn,
      fwhmIntervals: fwhm.intervals, fwtmIntervals: fwtm.intervals,
      fwhmReason: fwhm.reason, fwtmReason: fwtm.reason,
      fwhmEnvelopeTurns: fwhm.envelopeWidth, fwtmEnvelopeTurns: fwtm.envelopeWidth,
      widthDefinition: 'interpolated threshold crossings; null for disconnected intervals or a plateau at the threshold; enclosing extent retained separately',
      equivalentWidthDefinition: 'trapezoidal integral of peak-normalized continuous-time coefficient curve',
    },
    audit: {
      rawPeak: peak, rawAreaTurns: rawArea, expectedRawAreaTurns: 0.5,
      rawAreaErrorTurns: rawArea - 0.5,
      sampleStepTurns: 1 / config.viewSamples, supportTurns,
      endpointRaw: [raw[0], raw[raw.length - 1]],
      partitionAtPhase0137: weights.sum,
      directRowBasis: basis,
    },
    provenance: {
      primaryMethod: 'Taguchi K, Aradate H. Medical Physics 25 (1998) 550-561. Eq.(6), Appendix A1-A5.',
      primaryMethodDoi: '10.1118/1.598230',
      temporalAggregation: 'Ichikawa et al. Physica Medica 31 (2015) 374-381, p.376 steps 1-5.',
      temporalAggregationDoi: '10.1016/j.ejmp.2015.02.012',
      timeOrigin: 'tube central plane crosses reconstructed z=0 at t/Trot=0',
      input: 'simultaneous unit temporal signal to every row; interpolation coefficients only',
      scope: 'central channel at rotation center; rectangular HFI on a continuous helix; no object point-signal factor, FBP, cone correction, or scanner measurement',
      acquisitionSelection: config.candidateRule,
      coincidentData: 'Equal-average coincident z knots, dividing their weight among distinct original acquisition times. This is an explicit implementation convention.',
      fig5Reproduction: 'not-established: the all-equivalent-ray convention differs from the detailed shape of Ichikawa Fig.5(d); no fit to published widths',
    },
  };
}
