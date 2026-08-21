(() => {
"use strict";
const MODEL_VERSION = "2026-08-21.5";

const PROFILE_MODES = Object.freeze({
  LAYERED_RECT: "layered-rect",
  DIRECT_TRIANGULAR: "direct-triangular",
});

const DEFAULT_PARAMS = Object.freeze({
  rows: 4,
  rowWidth: 1.0,
  beamPitch: 0.875,
  sourceRadius: 600.0,
  radius: 100.0,
  zReference: 0.0,
  state: 0.0,
  sliceThicknessMm: 1.0,
  profileMode: PROFILE_MODES.LAYERED_RECT,
  viewSamples: 360,
  zSamples: 800,
  stateSamples: 360,
  phase: 0.0,
});

const EPS = 1e-12;
const PI2 = 2 * Math.PI;
const MAX_CONFIGURED_SLICE_THICKNESS_MM = 20;

function validateParams(input) {
  const p = {
    rows: Math.round(Number(input.rows)),
    rowWidth: Number(input.rowWidth),
    beamPitch: Number(input.beamPitch),
    sourceRadius: Number(input.sourceRadius),
    radius: Math.abs(Number(input.radius)),
    // These remain internal model coordinates. The public UI evaluates all
    // relative states automatically and no longer asks the user to set them.
    zReference: Number(input.zReference ?? 0),
    state: Number(input.state ?? 0),
    // targetFwhm is accepted only as an old saved-input migration path.
    // It no longer means that the computed FWHM is fitted to this value.
    sliceThicknessMm: Number(input.sliceThicknessMm ?? input.targetFwhm),
    // Legacy direct-triangular URLs are migrated to the single transparent
    // reference model: nearest bracketing interpolation followed by the
    // declared configured-thickness window.
    profileMode: PROFILE_MODES.LAYERED_RECT,
    // thetaSamples is accepted only for migration from pre-full-scan URLs and
    // saved settings.  viewSamples always spans one complete 0-360 degree turn.
    viewSamples: Math.round(Number(input.viewSamples ?? input.thetaSamples)),
    zSamples: Math.round(Number(input.zSamples)),
    stateSamples: Math.round(Number(input.stateSamples)),
    phase: Number(input.phase ?? 0),
  };
  const finite = Object.entries(p).filter(([, value]) => typeof value === "number" && !Number.isFinite(value));
  if (finite.length) throw new Error(`The following inputs could not be parsed as numbers: ${finite.map(([key]) => key).join(", ")}`);
  if (p.rows < 1 || p.rows > 320) throw new Error("Set the number of detector rows to a value from 1 to 320.");
  if (p.rowWidth <= 0 || p.rowWidth > 10) throw new Error("Set the single-row width to a value greater than 0 and no greater than 10 mm.");
  if (p.beamPitch <= 0 || p.beamPitch > 3) throw new Error("Set the beam pitch to a value greater than 0 and no greater than 3.");
  if (p.sourceRadius <= 0) throw new Error("The source-to-isocenter distance must be positive.");
  if (p.radius > 250) throw new Error("Set the radial distance from isocenter to a value from 0 to 250 mm.");
  if (p.radius >= p.sourceRadius) throw new Error("The radial distance from isocenter must be smaller than the source-to-isocenter distance.");
  if (p.sliceThicknessMm <= 0 || p.sliceThicknessMm > 20) throw new Error("Set the configured slice thickness to a value greater than 0 and no greater than 20 mm.");
  if (p.viewSamples < 90 || p.viewSamples > 2400) throw new Error("Set the number of relative tube-angle samples per rotation to a value from 90 to 2400.");
  if (p.zSamples < 300 || p.zSamples > 4000) throw new Error("Set the SSPz grid size to a value from 300 to 4000.");
  if (p.stateSamples < 12 || p.stateSamples > 720) throw new Error("Set the number of model states to a value from 12 to 720.");
  p.state = ((p.state % 1) + 1) % 1;
  return p;
}

function tableFeedMm(p) {
  return p.beamPitch * p.rows * p.rowWidth;
}

function linspace(start, stop, count) {
  const out = new Float64Array(count);
  const step = (stop - start) / Math.max(1, count - 1);
  for (let i = 0; i < count; i += 1) out[i] = start + step * i;
  return out;
}

function roundHalfEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (Math.abs(fraction - 0.5) < 1e-12) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

function clipIndex(value, maxInclusive) {
  return Math.max(0, Math.min(maxInclusive, roundHalfEven(value)));
}

function profileWidth(profile, z, level) {
  let peak = 0;
  for (let i = 1; i < profile.length; i += 1) if (profile[i] > profile[peak]) peak = i;
  const above = new Uint8Array(profile.length);
  for (let i = 0; i < profile.length; i += 1) above[i] = profile[i] >= level ? 1 : 0;
  const components = [];
  let start = -1;
  for (let i = 0; i < above.length; i += 1) {
    if (above[i] && start < 0) start = i;
    if (start >= 0 && (!above[i] || i === above.length - 1)) {
      const end = above[i] && i === above.length - 1 ? i : i - 1;
      components.push([start, end]);
      start = -1;
    }
  }
  if (!components.length) return { width: 0, components: 0 };
  let component = components.find(([left, right]) => left <= peak && peak <= right);
  if (!component) component = components.reduce((best, item) => item[1] - item[0] > best[1] - best[0] ? item : best);
  const [leftIndex, rightIndex] = component;
  let left = z[0];
  if (leftIndex > 0) {
    const y0 = profile[leftIndex - 1];
    const y1 = profile[leftIndex];
    const fraction = Math.abs(y1 - y0) < 1e-15 ? 0 : (level - y0) / (y1 - y0);
    left = z[leftIndex - 1] + fraction * (z[leftIndex] - z[leftIndex - 1]);
  }
  let right = z[z.length - 1];
  if (rightIndex < profile.length - 1) {
    const y0 = profile[rightIndex];
    const y1 = profile[rightIndex + 1];
    const fraction = Math.abs(y1 - y0) < 1e-15 ? 0 : (level - y0) / (y1 - y0);
    right = z[rightIndex] + fraction * (z[rightIndex + 1] - z[rightIndex]);
  }
  return { width: Math.max(0, right - left), components: components.length };
}

function profileStats(profile, z, dz) {
  let peak = 0;
  for (const value of profile) peak = Math.max(peak, value);
  if (peak <= 0) return { fwhm: 0, fwtm: 0, sigma: 0, area: 0, centroid: 0, halfComponents: 0 };
  let area = 0;
  let first = 0;
  for (let i = 0; i < profile.length; i += 1) {
    area += profile[i] * dz;
    first += z[i] * profile[i] * dz;
  }
  const centroid = area > EPS ? first / area : 0;
  let variance = 0;
  if (area > EPS) {
    for (let i = 0; i < profile.length; i += 1) variance += (z[i] - centroid) ** 2 * profile[i] * dz / area;
  }
  const half = profileWidth(profile, z, 0.5);
  const tenth = profileWidth(profile, z, 0.1);
  return {
    fwhm: half.width,
    fwtm: tenth.width,
    sigma: Math.sqrt(Math.max(0, variance)),
    area,
    centroid,
    halfComponents: half.components,
  };
}

function geometryAtFullScanAngle(p, z0, beta, coneOn) {
  const feed = tableFeedMm(p);
  const slope = feed / PI2;
  const rho = p.radius / p.sourceRadius;
  const scale = coneOn
    ? Math.sqrt(Math.max(EPS, 1 + rho * rho - 2 * rho * Math.cos(beta - p.phase)))
    : 1;
  const exact = [];
  let lowerDelta = -Infinity;
  let upperDelta = Infinity;
  let lower = [];
  let upper = [];
  for (let row = 0; row < p.rows; row += 1) {
    const rowOffset = (row + 0.5 - p.rows / 2) * p.rowWidth;
    const base = slope * beta + scale * rowOffset;
    const quotient = (z0 - base) / feed;
    const integerTurn = Math.round(quotient);
    const turns = Math.abs(quotient - integerTurn) <= 1e-10
      ? [integerTurn]
      : [Math.floor(quotient), Math.ceil(quotient)];
    for (const turn of turns) {
      const center = base + turn * feed;
      const delta = center - z0;
      const candidate = {
        dataKind: "actual",
        row,
        turn,
        beta,
        center,
        delta,
        aperture: p.rowWidth * scale,
        rawWeight: 0,
        weight: 0,
      };
      if (Math.abs(delta) <= 1e-10) {
        exact.push(candidate);
      } else if (delta < 0) {
        if (delta > lowerDelta + 1e-10) {
          lowerDelta = delta;
          lower = [candidate];
        } else if (Math.abs(delta - lowerDelta) <= 1e-10) {
          lower.push(candidate);
        }
      } else if (delta < upperDelta - 1e-10) {
        upperDelta = delta;
        upper = [candidate];
      } else if (Math.abs(delta - upperDelta) <= 1e-10) {
        upper.push(candidate);
      }
    }
  }
  let candidates = [];
  let bracketGapMm = NaN;
  let exactMatch = false;
  if (exact.length) {
    exactMatch = true;
    const weight = 1 / exact.length;
    candidates = exact.map(candidate => ({ ...candidate, rawWeight: weight, weight }));
    bracketGapMm = 0;
  } else if (lower.length && upper.length) {
    bracketGapMm = upperDelta - lowerDelta;
    const totalLowerWeight = upperDelta / bracketGapMm;
    const totalUpperWeight = -lowerDelta / bracketGapMm;
    candidates = [
      ...lower.map(candidate => ({ ...candidate, rawWeight: totalLowerWeight / lower.length, weight: totalLowerWeight / lower.length })),
      ...upper.map(candidate => ({ ...candidate, rawWeight: totalUpperWeight / upper.length, weight: totalUpperWeight / upper.length })),
    ];
  }
  const normalizedWeightSum = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  return {
    beta,
    scale,
    candidates,
    rawWeightSum: normalizedWeightSum,
    normalizedWeightSum,
    bracketGapMm,
    bracketGapRatio: bracketGapMm / p.sliceThicknessMm,
    exactMatch,
    lowerDistanceMm: Number.isFinite(lowerDelta) ? -lowerDelta : 0,
    upperDistanceMm: Number.isFinite(upperDelta) ? upperDelta : 0,
    valid: candidates.length > 0 && Math.abs(normalizedWeightSum - 1) <= 1e-9,
  };
}

function computeSsp(rawParams, options = {}) {
  const p = validateParams(rawParams);
  const state = options.state ?? p.state;
  const coneOn = Boolean(options.coneOn);
  const collectGeometrySeries = Boolean(options.collectGeometrySeries);
  const feed = tableFeedMm(p);
  const z0 = p.zReference + feed * state;
  const rho = p.radius / p.sourceRadius;
  const geometries = new Array(p.viewSamples);
  const gapRatios = collectGeometrySeries ? new Float32Array(p.viewSamples) : null;
  let maximumCandidateExtent = 0;
  let gapSum = 0;
  let gapMin = Infinity;
  let gapMax = 0;
  let exactMatchCount = 0;
  let validCount = 0;
  for (let viewIndex = 0; viewIndex < p.viewSamples; viewIndex += 1) {
    const beta = PI2 * viewIndex / p.viewSamples;
    const geometry = geometryAtFullScanAngle(p, z0, beta, coneOn);
    geometries[viewIndex] = geometry;
    if (!geometry.valid) {
      if (gapRatios) gapRatios[viewIndex] = NaN;
      continue;
    }
    validCount += 1;
    gapSum += geometry.bracketGapMm;
    gapMin = Math.min(gapMin, geometry.bracketGapMm);
    gapMax = Math.max(gapMax, geometry.bracketGapMm);
    if (geometry.exactMatch) exactMatchCount += 1;
    if (gapRatios) gapRatios[viewIndex] = geometry.bracketGapRatio;
    for (const candidate of geometry.candidates) {
      maximumCandidateExtent = Math.max(maximumCandidateExtent, Math.abs(candidate.delta) + candidate.aperture / 2);
    }
  }
  // Use one state-, cone-, and configured-thickness-independent longitudinal
  // domain.  This prevents changes of the numerical search window from being
  // mistaken for geometry-driven SSPz variation.  The grid count is treated
  // as a minimum and is expanded when many narrow rows require finer sampling.
  const maximumAperture = p.rowWidth * (1 + rho);
  const maxDz = Math.max(
    p.rowWidth * 2,
    feed + maximumAperture / 2 + MAX_CONFIGURED_SLICE_THICKNESS_MM / 2 + p.rowWidth,
    maximumCandidateExtent + MAX_CONFIGURED_SLICE_THICKNESS_MM / 2 + p.rowWidth,
  );
  const resolutionDrivenCount = Math.ceil(2 * maxDz / Math.max(p.rowWidth / 10, 0.005)) + 1;
  const zCount = Math.min(4000, Math.max(p.zSamples, resolutionDrivenCount));
  const z = linspace(-maxDz, maxDz, zCount);
  const dz = z[1] - z[0];
  const diff = new Float64Array(zCount + 1);
  for (let viewIndex = 0; viewIndex < p.viewSamples; viewIndex += 1) {
    const geometry = geometries[viewIndex];
    if (!geometry.valid) continue;
    for (const candidate of geometry.candidates) {
      if (candidate.weight <= EPS) continue;
      const half = candidate.aperture / 2;
      const lo = clipIndex((candidate.delta - half - z[0]) / dz, zCount);
      const hi = clipIndex((candidate.delta + half - z[0]) / dz, zCount);
      const amplitude = candidate.weight / Math.max(candidate.aperture, EPS);
      diff[lo] += amplitude;
      diff[hi] -= amplitude;
    }
  }
  const profile = new Float64Array(zCount);
  let running = 0;
  let peak = 0;
  for (let i = 0; i < zCount; i += 1) {
    running += diff[i];
    profile[i] = Math.max(0, running);
    peak = Math.max(peak, profile[i]);
  }
  if (peak > 0) for (let i = 0; i < profile.length; i += 1) profile[i] /= peak;
  const stats = profileStats(profile, z, dz);
  return {
    state,
    z0,
    coneOn,
    candidateSelectionRule: "nearest-bracketing-linear",
    candidateWeightHalfSupportMm: null,
    kernelWidth: null,
    z: Array.from(z),
    profile: Array.from(profile),
    coverage: validCount / p.viewSamples,
    angularRangeDeg: 360,
    viewSamples: p.viewSamples,
    requestedZSamples: p.zSamples,
    actualZSamples: zCount,
    longitudinalDomainHalfWidthMm: maxDz,
    dataKind: "actual-full-scan",
    bracketGapMeanMm: validCount ? gapSum / validCount : NaN,
    bracketGapMinMm: validCount ? gapMin : NaN,
    bracketGapMaxMm: validCount ? gapMax : NaN,
    bracketGapRatioMean: validCount ? gapSum / validCount / p.sliceThicknessMm : NaN,
    bracketGapRatioMax: validCount ? gapMax / p.sliceThicknessMm : NaN,
    exactCandidateFraction: validCount ? exactMatchCount / validCount : NaN,
    gapRatios,
    ...stats,
  };
}

function cumulativeIntegral(profile, z) {
  const cumulative = new Float64Array(profile.length);
  for (let i = 1; i < profile.length; i += 1) {
    cumulative[i] = cumulative[i - 1] + 0.5 * (profile[i - 1] + profile[i]) * (z[i] - z[i - 1]);
  }
  return cumulative;
}

function integralAt(profile, z, cumulative, value) {
  if (value <= z[0]) return 0;
  const last = z.length - 1;
  if (value >= z[last]) return cumulative[last];
  const dz = z[1] - z[0];
  const scaled = (value - z[0]) / dz;
  const index = Math.max(0, Math.min(last - 1, Math.floor(scaled)));
  const fraction = Math.max(0, Math.min(1, scaled - index));
  const y0 = profile[index];
  const y1 = profile[index + 1];
  return cumulative[index] + dz * (y0 * fraction + 0.5 * (y1 - y0) * fraction * fraction);
}

function rectangularAverageProfile(profileInput, zInput, width) {
  const profile = Float64Array.from(profileInput);
  const z = Float64Array.from(zInput);
  if (!(width > EPS)) return Array.from(profile);
  const cumulative = cumulativeIntegral(profile, z);
  const out = new Float64Array(profile.length);
  const half = width / 2;
  let peak = 0;
  for (let i = 0; i < profile.length; i += 1) {
    const area = integralAt(profile, z, cumulative, z[i] + half)
      - integralAt(profile, z, cumulative, z[i] - half);
    out[i] = Math.max(0, area / width);
    peak = Math.max(peak, out[i]);
  }
  if (peak > 0) for (let i = 0; i < out.length; i += 1) out[i] /= peak;
  return Array.from(out);
}

function computeLayeredSsp(rawParams, options = {}) {
  const p = validateParams(rawParams);
  const sliceKernelWidthMm = Math.max(0, Number(options.sliceKernelWidthMm ?? options.sliceKernelWidth ?? 0));
  const base = computeSsp(p, {
    state: options.state ?? p.state,
    coneOn: Boolean(options.coneOn),
    collectGeometrySeries: Boolean(options.collectGeometrySeries),
  });
  const finalProfile = rectangularAverageProfile(base.profile, base.z, sliceKernelWidthMm);
  const dz = base.z[1] - base.z[0];
  const finalStats = profileStats(finalProfile, base.z, dz);
  return {
    ...base,
    profileMode: PROFILE_MODES.LAYERED_RECT,
    candidateWeightHalfSupportMm: null,
    sliceKernelWidthMm,
    baseKernelWidth: null,
    sliceKernelWidth: sliceKernelWidthMm,
    baseProfile: base.profile,
    baseFwhm: base.fwhm,
    baseFwtm: base.fwtm,
    baseSigma: base.sigma,
    baseCentroid: base.centroid,
    profile: finalProfile,
    ...finalStats,
  };
}

function createProfileAssumptions(rawParams) {
  const p = validateParams(rawParams);
  return {
    profileMode: PROFILE_MODES.LAYERED_RECT,
    candidateSelectionRule: "nearest-bracketing",
    candidateWeightShape: "linear-between-nearest-smaller-z-and-larger-z-candidates",
    candidateWeightHalfSupportMm: null,
    candidateWeightFwhmMm: null,
    sliceKernelShape: "rectangular",
    sliceKernelWidthMm: p.sliceThicknessMm,
    mapping: "configured-thickness-to-rectangular-kernel",
    geometryIndicator: "nearest-bracketing-gap-over-configured-thickness",
  };
}

function computeProfileModel(rawParams, options = {}) {
  const p = validateParams(rawParams);
  const assumptions = options.assumptions ?? createProfileAssumptions(p);
  return computeLayeredSsp(p, {
    state: options.state ?? p.state,
    coneOn: Boolean(options.coneOn),
    sliceKernelWidthMm: assumptions.sliceKernelWidthMm,
    collectGeometrySeries: Boolean(options.collectGeometrySeries),
  });
}

function computeUnwrapped(rawParams, options = {}) {
  const p = validateParams(rawParams);
  const state = options.state ?? p.state;
  const coneOn = Boolean(options.coneOn);
  const samples = Math.max(90, Math.min(2400, Math.round(options.samples ?? Math.min(360, p.viewSamples))));
  const feed = tableFeedMm(p);
  const z0 = p.zReference + feed * state;
  // Traces include the 360-degree endpoint for a closed visual period.  SSPz
  // integration and marker weights use the non-duplicated samples 0 <= beta < 2pi.
  const traceSamples = samples + 1;
  const angleValues = new Float32Array(traceSamples);
  const axialValues = new Float64Array(traceSamples);
  const scaleValues = new Float32Array(traceSamples);
  const rho = p.radius / p.sourceRadius;
  for (let i = 0; i < traceSamples; i += 1) {
    const beta = PI2 * i / samples;
    angleValues[i] = 360 * i / samples;
    axialValues[i] = feed * beta / PI2;
    scaleValues[i] = coneOn
      ? Math.sqrt(Math.max(EPS, 1 + rho * rho - 2 * rho * Math.cos(beta - p.phase)))
      : 1;
  }
  const displayRows = Array.from({ length: p.rows }, (_, row) => row);
  const rowOffsets = Float64Array.from(displayRows, row => (row + 0.5 - p.rows / 2) * p.rowWidth);
  const centerTurn = roundHalfEven(z0 / feed);
  // The ideal helix is infinite.  The reproducible finite display contract is
  // every turn containing a row-wise nearest smaller-z or larger-z candidate over the
  // full 0-360 degree period, plus one neighboring turn on either side.
  let turnMin = Infinity;
  let turnMax = -Infinity;
  const endpointOffsets = rowOffsets.length > 1
    ? [rowOffsets[0], rowOffsets[rowOffsets.length - 1]]
    : [rowOffsets[0]];
  for (let i = 0; i < traceSamples; i += 1) {
    const beta = PI2 * i / samples;
    const distanceScale = Math.sqrt(Math.max(EPS, 1 + rho * rho - 2 * rho * Math.cos(beta - p.phase)));
    for (const scale of [1, distanceScale]) {
      for (const rowOffset of endpointOffsets) {
        const base = feed * beta / PI2 + scale * rowOffset;
        const quotient = (z0 - base) / feed;
        turnMin = Math.min(turnMin, Math.floor(quotient) - 1);
        turnMax = Math.max(turnMax, Math.ceil(quotient) + 1);
      }
    }
  }
  if (!Number.isFinite(turnMin) || !Number.isFinite(turnMax)) {
    turnMin = centerTurn - 2;
    turnMax = centerTurn + 2;
  }
  const turns = Int32Array.from({ length: turnMax - turnMin + 1 }, (_, index) => turnMin + index);
  const turnOffsetMin = turnMin - centerTurn;
  const turnOffsetMax = turnMax - centerTurn;
  const baseZoomXLimit = Math.max(1.65, p.rowWidth * 1.5);
  const weightedPoints = [];
  const viewWeightSums = new Float32Array(samples);
  let maximumWeightedDistance = 0;
  const markerStride = Math.max(
    1,
    Math.ceil(samples / 72),
    Math.ceil(samples * 2 / 12000),
  );
  let validViewCount = 0;
  let normalizationErrorMax = 0;
  for (let i = 0; i < samples; i += 1) {
    const beta = PI2 * i / samples;
    const geometry = geometryAtFullScanAngle(p, z0, beta, coneOn);
    viewWeightSums[i] = geometry.normalizedWeightSum;
    if (geometry.valid) {
      validViewCount += 1;
      normalizationErrorMax = Math.max(normalizationErrorMax, Math.abs(1 - geometry.normalizedWeightSum));
    }
    if (i % markerStride !== 0) continue;
    for (const candidate of geometry.candidates) {
      if (candidate.weight <= EPS) continue;
      weightedPoints.push({
        x: candidate.delta,
        y: 360 * i / samples,
        weight: candidate.weight,
        dataKind: candidate.dataKind,
        row: candidate.row,
        turn: candidate.turn,
        turnOffset: candidate.turn - centerTurn,
        sampleIndex: i,
      });
      maximumWeightedDistance = Math.max(maximumWeightedDistance, Math.abs(candidate.delta));
    }
  }
  let maximumCandidateDistance = baseZoomXLimit;
  for (let i = 0; i < traceSamples; i += 1) {
    for (const turn of [turnMin, turnMax]) {
      for (const rowOffset of endpointOffsets) {
        const delta = axialValues[i] + turn * feed + scaleValues[i] * rowOffset - z0;
        maximumCandidateDistance = Math.max(maximumCandidateDistance, Math.abs(delta));
      }
    }
  }
  const overviewXLimit = maximumCandidateDistance + Math.max(0.35, p.rowWidth * 0.35);
  const zoomXLimit = Math.max(baseZoomXLimit, maximumWeightedDistance + Math.max(0.15, p.rowWidth * 0.15));
  const usedTurns = [...new Set(weightedPoints.map(point => point.turnOffset))].sort((a, b) => a - b);
  const usedTurnsOutsideOverview = usedTurns.filter(turn => turn < turnOffsetMin || turn > turnOffsetMax);
  return {
    coneOn,
    state,
    z0,
    candidateSelectionRule: "nearest-bracketing-linear",
    candidateWeightHalfSupportMm: null,
    kernelWidth: null,
    interpolationBandHalfWidth: maximumWeightedDistance,
    xLimit: zoomXLimit,
    zoomXLimit,
    overviewXLimit,
    traceGeometry: {
      angles: angleValues,
      axial: axialValues,
      scales: scaleValues,
      rowOffsets,
      turns,
      feed,
    },
    weightedPoints,
    displayedRows: displayRows.length,
    displayRows,
    totalRows: p.rows,
    centerTurn,
    turnMin,
    turnMax,
    turnCount: turns.length,
    turnOffsetMin,
    turnOffsetMax,
    candidateLineCount: p.rows * turns.length,
    actualDataFamilyCount: 1,
    angularRangeDeg: 360,
    viewWeightSums,
    validViewCount,
    normalizationErrorMax,
    automaticTurnRange: true,
    searchTurnRadius: null,
    usedTurns,
    usedTurnsOutsideOverview,
    markerStride,
    renderedAngleSamples: Math.ceil(samples / markerStride),
    samples,
  };
}

function summarizeSweep(rows, coneOn) {
  const complete = rows.filter(row => row.coneOn === coneOn && row.coverage >= 1 - 1e-12);
  const range = key => {
    if (!complete.length) return { min: NaN, max: NaN, range: NaN };
    const values = complete.map(row => row[key]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { min, max, range: max - min };
  };
  return {
    coneOn,
    complete: complete.length,
    total: rows.filter(row => row.coneOn === coneOn).length,
    fwhm: range("fwhm"),
    fwtm: range("fwtm"),
    sigma: range("sigma"),
    centroid: range("centroid"),
    baseFwhm: range("baseFwhm"),
    baseFwtm: range("baseFwtm"),
    baseSigma: range("baseSigma"),
    baseCentroid: range("baseCentroid"),
    bracketGapMeanMm: range("bracketGapMeanMm"),
    bracketGapMaxMm: range("bracketGapMaxMm"),
    bracketGapRatioMean: range("bracketGapRatioMean"),
    bracketGapRatioMax: range("bracketGapRatioMax"),
    exactCandidateFraction: range("exactCandidateFraction"),
  };
}

// Figure palette and typography follow the journal-facing conventions used by
// Medical Physics: black sans-serif text, gray gridlines, restrained color,
// and redundant line/marker encodings.  Japanese and future English labels use
// the same rendering contract.
const BLUE = "#0072b2";
const ORANGE = "#d55e00";
const GREEN = "#009e73";
const INK = "#000000";
const MUTED = "#505a60";
const GRID = "#d0d4d7";
const LIGHT = "#aeb6bb";
const PALE = "#eef3f5";
const RED = "#b2182b";
const ROW_COLORS = ["#0072b2", "#d55e00", "#009e73", "#e69f00", "#cc79a7", "#56b4e9", "#000000", "#777777"];
const FIGURE_FONT = "Arial, Helvetica, sans-serif";
const PUBLICATION_DPI = 600;
const PUBLICATION_WIDTH_MM = Object.freeze({ panel: 80, full: 180 });
// The log-tail plot still renders values only at or above 0.1%.  These limits
// add print-space around the 100% peak and the 0.1% endpoints so neither is
// hidden by the plot frame in the 80-mm publication export.
const PROFILE_TAIL_DISPLAY_BOUNDS = Object.freeze({ yMin: -3.08, yMax: 0.08 });
const RESULT_CANVAS_SELECTOR = "canvas";

const form = document.querySelector("#parameter-form");
const runButton = document.querySelector("#run-button");
const cancelButton = document.querySelector("#cancel-button");
const resetButton = document.querySelector("#reset-button");
const copyLinkButton = document.querySelector("#copy-link-button");
const progress = document.querySelector("#progress");
const status = document.querySelector("#status");
const errorBox = document.querySelector("#error-box");
const inspectState = document.querySelector("#inspect-state");
const inspectStateLabel = document.querySelector("#inspect-state-label");
const inspectPrev = document.querySelector("#inspect-prev");
const inspectNext = document.querySelector("#inspect-next");
const resultTable = document.querySelector("#result-table");
const summaryCards = document.querySelector("#summary-cards");
const downloadCsvButton = document.querySelector("#download-csv-button");
const downloadProfileButton = document.querySelector("#download-profile-button");
const metricSelect = document.querySelector("#widthMetric");
const metricLabel = document.querySelector("#metric-label");
const sweepInterpretation = document.querySelector("#sweep-interpretation");
const versionLabel = document.querySelector("#version");
const profileModelNote = document.querySelector("#profile-model-note");
const profileAxisNote = document.querySelector("#profile-axis-note");
const legacyUrlNote = document.querySelector("#legacy-url-note");

let worker = null;
let workerObjectUrl = null;
let lastResult = null;
let startedAt = 0;
let legacyInputMigrated = false;
let selectedStateIndex = 0;
let inspectTimer = null;
let lastPlaceholderPaint = 0;

versionLabel.textContent = `Web reference build ${MODEL_VERSION}`;

function syncLanguageLinks() {
  document.querySelectorAll("[data-language-target]").forEach(link => {
    const target = new URL(link.dataset.languageTarget, window.location.href);
    target.search = window.location.search;
    link.href = target.toString();
  });
}

syncLanguageLinks();
document.addEventListener("click", event => {
  const link = event.target.closest?.("[data-language-target]");
  if (!link) return;
  const target = new URL(link.dataset.languageTarget, window.location.href);
  target.search = paramsToUrl(readParams()).search;
  link.href = target.toString();
});

function fmt(value, digits = 4) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "—";
}

function readParams() {
  const data = new FormData(form);
  return {
    rows: Number(data.get("rows")),
    rowWidth: Number(data.get("rowWidth")),
    beamPitch: Number(data.get("beamPitch")),
    sourceRadius: Number(data.get("sourceRadius")),
    radius: Number(data.get("radius")),
    zReference: 0,
    state: selectedStateIndex / 360,
    sliceThicknessMm: Number(data.get("sliceThicknessMm")),
    profileMode: String(data.get("profileMode") || DEFAULT_PARAMS.profileMode),
    viewSamples: Number(data.get("viewSamples")),
    zSamples: Number(data.get("zSamples")),
    stateSamples: 360,
    phase: 0,
  };
}

function writeParams(params) {
  for (const [key, value] of Object.entries(params)) {
    const input = form.elements.namedItem(key);
    if (input) input.value = value;
  }
  updateInputDecorations();
}

function updateInputDecorations() {
  const radius = Number(form.elements.namedItem("radius").value);
  document.querySelectorAll("[data-radius]").forEach(button => {
    button.classList.toggle("active", Number(button.dataset.radius) === radius);
  });
  if (inspectState) inspectState.value = String(selectedStateIndex);
  if (inspectStateLabel) inspectStateLabel.textContent = `State ${selectedStateIndex}/359 (s = ${(selectedStateIndex / 360).toFixed(3)})`;
  if (inspectState) inspectState.setAttribute("aria-valuetext", `State ${selectedStateIndex}, relative position ${(selectedStateIndex / 360).toFixed(3)}`);
}

function paramsToUrl(params) {
  const url = new URL(window.location.href);
  url.search = "";
  const compact = {
    v: 6,
    n: params.rows,
    d: params.rowWidth,
    p: params.beamPitch,
    R: params.sourceRadius,
    r: params.radius,
    vs: selectedStateIndex,
    st: params.sliceThicknessMm,
    pm: params.profileMode,
    wm: metricSelect?.value ?? "fwhm",
    nv: params.viewSamples,
    nz: params.zSamples,
  };
  for (const [key, value] of Object.entries(compact)) url.searchParams.set(key, value);
  return url;
}

function paramsFromUrl() {
  const query = new URLSearchParams(window.location.search);
  if (!query.size) return null;
  const get = (key, fallback) => query.has(key) ? Number(query.get(key)) : fallback;
  const getText = (key, fallback) => query.has(key) ? String(query.get(key)) : fallback;
  const hasNewThickness = query.has("st");
  const hasLegacyThickness = !hasNewThickness && query.has("t");
  const hasLegacyState = query.has("s") && !query.has("vs");
  legacyInputMigrated = hasLegacyThickness || hasLegacyState || query.has("z") || query.has("nr") || query.has("nt") || query.has("stage");
  selectedStateIndex = query.has("vs")
    ? Math.max(0, Math.min(359, Math.round(get("vs", 0))))
    : hasLegacyState
      ? Math.max(0, Math.min(359, Math.round(get("s", 0) * 360) % 360))
      : 0;
  if (query.has("wm") && metricSelect) metricSelect.value = getText("wm", "fwhm");
  return {
    ...DEFAULT_PARAMS,
    rows: get("n", DEFAULT_PARAMS.rows),
    rowWidth: get("d", DEFAULT_PARAMS.rowWidth),
    beamPitch: get("p", DEFAULT_PARAMS.beamPitch),
    sourceRadius: get("R", DEFAULT_PARAMS.sourceRadius),
    radius: get("r", DEFAULT_PARAMS.radius),
    zReference: 0,
    state: selectedStateIndex / 360,
    sliceThicknessMm: hasNewThickness
      ? get("st", DEFAULT_PARAMS.sliceThicknessMm)
      : get("t", DEFAULT_PARAMS.sliceThicknessMm),
    profileMode: getText("pm", DEFAULT_PARAMS.profileMode),
    viewSamples: query.has("nv")
      ? get("nv", DEFAULT_PARAMS.viewSamples)
      : get("nt", DEFAULT_PARAMS.viewSamples),
    zSamples: get("nz", DEFAULT_PARAMS.zSamples),
    stateSamples: 360,
  };
}

function setBusy(busy) {
  runButton.disabled = busy;
  cancelButton.disabled = !busy;
  form.querySelectorAll("input, select").forEach(input => input.disabled = busy);
  const inspectDisabled = busy || !lastResult;
  if (inspectState) inspectState.disabled = inspectDisabled;
  if (inspectPrev) inspectPrev.disabled = inspectDisabled;
  if (inspectNext) inspectNext.disabled = inspectDisabled;
  document.querySelectorAll("[data-canvas]").forEach(button => {
    button.disabled = busy || !lastResult;
  });
  downloadCsvButton.disabled = busy || !lastResult;
  downloadProfileButton.disabled = busy || !lastResult;
}

function drawCanvasStatus(canvas, title, detail, state = "loading") {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const accent = state === "error" ? RED : state === "cancelled" ? MUTED : BLUE;
  const titleSize = Math.max(22, Math.min(30, width * 0.03));
  const detailSize = Math.max(15, Math.min(20, width * 0.02));

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d0d4d7";
  ctx.lineWidth = Math.max(1, width / 900);
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

  const centerX = width / 2;
  const centerY = height / 2;
  const dotRadius = Math.max(5, Math.min(8, width / 120));
  const dotGap = dotRadius * 3;
  [-1, 0, 1].forEach((offset, index) => {
    ctx.globalAlpha = state === "loading" ? 0.4 + index * 0.3 : 0.75;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(centerX + offset * dotGap, centerY - titleSize * 1.65, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = INK;
  ctx.font = `700 ${titleSize}px ${FIGURE_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, centerX, centerY - titleSize * 0.35);
  ctx.fillStyle = MUTED;
  ctx.font = `400 ${detailSize}px ${FIGURE_FONT}`;
  ctx.fillText(detail, centerX, centerY + detailSize * 1.55, width * 0.82);
  ctx.restore();

  canvas.dataset.renderState = state;
  if (state === "loading") canvas.setAttribute("aria-busy", "true");
  else canvas.removeAttribute("aria-busy");
}

function setResultPlaceholder(state, title, detail) {
  document.querySelectorAll(RESULT_CANVAS_SELECTOR).forEach(canvas => {
    drawCanvasStatus(canvas, title, detail, state);
  });
  summaryCards.innerHTML = `<div class="result-placeholder" data-result-state="${state}"><strong>${title}</strong><span>${detail}</span></div>`;
  resultTable.innerHTML = `<tr class="result-placeholder-row" data-result-state="${state}"><td colspan="5"><strong>${title}</strong><span>${detail}</span></td></tr>`;
  const caption = document.querySelector("#result-caption");
  if (caption) caption.textContent = title;
  if (sweepInterpretation) sweepInterpretation.hidden = true;
  if (state === "loading") {
    for (const selector of ["#overview-scope", "#calculation-scope", "#overlay-scope", "#profile-axis-note", "#metric-label", "#overlay-core-heading", "#overlay-core-description"]) {
      const element = document.querySelector(selector);
      if (element) element.textContent = title;
    }
    if (profileModelNote) profileModelNote.textContent = `${title} ${detail}`;
  }
}

function showCalculatingState(detail = "Generating figures for the current conditions", force = false) {
  const now = performance.now();
  if (!force && now - lastPlaceholderPaint < 500) return;
  lastPlaceholderPaint = now;
  setResultPlaceholder("loading", "Calculating…", detail);
}

function markResultCanvasesReady() {
  document.querySelectorAll(RESULT_CANVAS_SELECTOR).forEach(canvas => {
    canvas.dataset.renderState = "ready";
    canvas.removeAttribute("aria-busy");
  });
}

function showError(message) {
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function releaseWorker() {
  if (worker) worker.terminate();
  worker = null;
  if (workerObjectUrl) URL.revokeObjectURL(workerObjectUrl);
  workerObjectUrl = null;
}

function createComputationWorker() {
  if (typeof globalThis.SSPZ_WORKER_SOURCE === "string") {
    const blob = new Blob([globalThis.SSPZ_WORKER_SOURCE], { type: "text/javascript" });
    workerObjectUrl = URL.createObjectURL(blob);
    return new Worker(workerObjectUrl);
  }
  const fallbackWorker = document.documentElement.lang.toLowerCase().startsWith("en")
    ? "worker-en.js"
    : "worker.js";
  return new Worker(fallbackWorker, { type: "module" });
}

function runSimulation() {
  releaseWorker();
  clearError();
  const params = readParams();
  lastResult = null;
  setBusy(true);
  lastPlaceholderPaint = 0;
  showCalculatingState(undefined, true);
  progress.value = 0;
  status.textContent = "Starting computation";
  startedAt = performance.now();
  const url = paramsToUrl(params);
  try { history.replaceState(null, "", url); } catch { /* file:// may restrict history mutation */ }
  try { localStorage.setItem("sspz-unwrapped-params", JSON.stringify(params)); } catch { /* storage may be disabled */ }
  worker = createComputationWorker();
  worker.onmessage = event => {
    const message = event.data;
    if (message.type === "progress") {
      progress.value = message.value;
      status.textContent = message.label;
      showCalculatingState(message.label);
    } else if (message.type === "result") {
      lastResult = message.result;
      selectedStateIndex = Math.max(0, Math.min(359, Math.round(lastResult.params.state * 360) % 360));
      const elapsed = (performance.now() - startedAt) / 1000;
      renderAll(lastResult);
      markResultCanvasesReady();
      progress.value = 1;
      status.textContent = `Completed in ${elapsed.toFixed(1)} s / linear interpolation between the two nearest bracketing candidates / configured thickness=${fmt(lastResult.params.sliceThicknessMm, 3)} mm / maximum Δz/T at inspected state ${selectedStateIndex}=${fmt(lastResult.selectedOff.bracketGapRatioMax, 3)} and ${fmt(lastResult.selectedOn.bracketGapRatioMax, 3)}`;
      setBusy(false);
      inspectState.disabled = false;
      inspectPrev.disabled = false;
      inspectNext.disabled = false;
    } else if (message.type === "inspection-result") {
      selectedStateIndex = message.stateIndex;
      lastResult.params.state = message.state;
      lastResult.selectedOff = message.selectedOff;
      lastResult.selectedOn = message.selectedOn;
      lastResult.diagramOff = message.diagramOff;
      lastResult.diagramOn = message.diagramOn;
      renderInspectionDetails(lastResult);
      drawGapMap(document.querySelector("#gap-map-off"), lastResult, false);
      drawGapMap(document.querySelector("#gap-map-on"), lastResult, true);
      drawSweep(document.querySelector("#sweep-chart"), lastResult);
      const url = paramsToUrl(readParams());
      try { history.replaceState(null, "", url); } catch { /* file:// may restrict history mutation */ }
      status.textContent = `Detailed view updated to state ${selectedStateIndex}/359 (s=${(selectedStateIndex / 360).toFixed(3)})`;
      inspectState.disabled = false;
      inspectPrev.disabled = false;
      inspectNext.disabled = false;
    } else if (message.type === "cancelled") {
      status.textContent = "Computation cancelled";
      setResultPlaceholder("cancelled", "Computation cancelled", "Review the conditions, then select Compute again.");
      setBusy(false);
      releaseWorker();
    } else if (message.type === "error") {
      showError(message.message);
      status.textContent = "Computation error";
      setResultPlaceholder("error", "The figures could not be generated", "Review the error message above.");
      setBusy(false);
      releaseWorker();
    }
  };
  worker.onerror = event => {
    showError(event.message || "A Web Worker error occurred.");
    status.textContent = "Computation error";
    setResultPlaceholder("error", "The figures could not be generated", "Review the error message above.");
    setBusy(false);
  };
  worker.postMessage({ type: "run", params });
}

function requestStateInspection(index, immediate = false) {
  selectedStateIndex = ((Math.round(index) % 360) + 360) % 360;
  updateInputDecorations();
  if (!lastResult || !worker) return;
  clearTimeout(inspectTimer);
  const send = () => {
    inspectState.disabled = true;
    inspectPrev.disabled = true;
    inspectNext.disabled = true;
    status.textContent = `Computing details for state ${selectedStateIndex}/359`;
    worker.postMessage({ type: "inspect-state", stateIndex: selectedStateIndex });
  };
  if (immediate) send();
  else inspectTimer = setTimeout(send, 120);
}

function axisContext(canvas, bounds, labels) {
  const ctx = canvas.getContext("2d");
  const renderScale = Math.max(1, Number(canvas.dataset.renderScale) || 1);
  const width = canvas.width / renderScale;
  const height = canvas.height / renderScale;
  const compactPanel = width <= 950;
  const style = {
    tickFontPx: compactPanel ? 31 : 27,
    axisFontPx: compactPanel ? 34 : 31,
    legendFontPx: compactPanel ? 26 : 24,
    noteFontPx: compactPanel ? 23 : 21,
    majorAxisWidth: 2.7,
    frameWidth: 1.1,
    gridWidth: 1,
  };
  const margin = {
    left: labels.leftMargin ?? (compactPanel ? 112 : 106),
    right: labels.rightMargin ?? (compactPanel ? 34 : 38),
    top: labels.topMargin ?? 44,
    bottom: labels.bottomMargin ?? (compactPanel ? 96 : 90),
  };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  const x = value => margin.left + (value - bounds.xMin) / (bounds.xMax - bounds.xMin) * innerWidth;
  const y = value => margin.top + (bounds.yMax - value) / (bounds.yMax - bounds.yMin) * innerHeight;
  const yDown = value => margin.top + (value - bounds.yMin) / (bounds.yMax - bounds.yMin) * innerHeight;
  return { ctx, width, height, margin, innerWidth, innerHeight, x, y, yDown, labels, style, renderScale };
}

function setFittedFigureFont(ctx, text, preferredPx, minimumPx, maximumWidth, weight = "") {
  let size = preferredPx;
  const prefix = weight ? `${weight} ` : "";
  while (size > minimumPx) {
    ctx.font = `${prefix}${size}px ${FIGURE_FONT}`;
    if (ctx.measureText(text).width <= maximumWidth) return size;
    size -= 1;
  }
  ctx.font = `${prefix}${minimumPx}px ${FIGURE_FONT}`;
  return minimumPx;
}

function drawAxes(plot, xTicks, yTicks, useYDown = false) {
  const { ctx, margin, innerWidth, innerHeight, x, y, yDown, labels, width, height, style } = plot;
  const xValues = xTicks.filter(Number.isFinite);
  const yValues = yTicks.filter(Number.isFinite);
  const xFormatter = labels.xFormatter ?? (value => String(value));
  const yFormatter = labels.yFormatter ?? (value => String(value));
  ctx.save();
  ctx.strokeStyle = GRID;
  ctx.lineWidth = style.gridWidth;
  // Publication figures use black tick-label numerals; only the supporting
  // gridlines remain gray so the coordinate scale keeps full print contrast.
  ctx.fillStyle = INK;
  ctx.font = `${style.tickFontPx}px ${FIGURE_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const tick of xValues) {
    const px = x(tick);
    ctx.beginPath(); ctx.moveTo(px, margin.top); ctx.lineTo(px, margin.top + innerHeight); ctx.stroke();
    ctx.fillText(xFormatter(tick), px, margin.top + innerHeight + 15);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const tick of yValues) {
    const py = useYDown ? yDown(tick) : y(tick);
    ctx.beginPath(); ctx.moveTo(margin.left, py); ctx.lineTo(margin.left + innerWidth, py); ctx.stroke();
    ctx.fillText(yFormatter(tick), margin.left - 16, py);
  }

  // Major ticks point outside the plotting field.  Midpoint minor ticks point
  // inward and carry no labels, keeping the scale readable without extra grid.
  ctx.strokeStyle = INK;
  ctx.lineWidth = style.majorAxisWidth;
  for (const tick of xValues) {
    const px = x(tick);
    ctx.beginPath(); ctx.moveTo(px, margin.top + innerHeight); ctx.lineTo(px, margin.top + innerHeight + 10); ctx.stroke();
  }
  for (const tick of yValues) {
    const py = useYDown ? yDown(tick) : y(tick);
    ctx.beginPath(); ctx.moveTo(margin.left - 10, py); ctx.lineTo(margin.left, py); ctx.stroke();
  }
  ctx.lineWidth = 1.2;
  for (let index = 0; index + 1 < xValues.length; index += 1) {
    const px = x((xValues[index] + xValues[index + 1]) / 2);
    ctx.beginPath(); ctx.moveTo(px, margin.top + innerHeight); ctx.lineTo(px, margin.top + innerHeight - 6); ctx.stroke();
  }
  for (let index = 0; index + 1 < yValues.length; index += 1) {
    const value = (yValues[index] + yValues[index + 1]) / 2;
    const py = useYDown ? yDown(value) : y(value);
    ctx.beginPath(); ctx.moveTo(margin.left, py); ctx.lineTo(margin.left + 6, py); ctx.stroke();
  }
  ctx.lineWidth = style.frameWidth;
  ctx.strokeRect(margin.left, margin.top, innerWidth, innerHeight);
  ctx.lineWidth = style.majorAxisWidth;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + innerHeight);
  ctx.lineTo(margin.left + innerWidth, margin.top + innerHeight);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const xLabelCenter = margin.left + innerWidth / 2;
  const xLabelWidth = Math.max(1, Math.min(innerWidth, 2 * Math.min(xLabelCenter, width - xLabelCenter)) - 16);
  setFittedFigureFont(ctx, labels.x, style.axisFontPx, 21, xLabelWidth);
  ctx.fillText(labels.x, xLabelCenter, height - 11);
  ctx.save();
  // Keep the rotated y-axis title inside the export canvas at the final
  // 80/180-mm sizes; 31 px allowed glyph overhang to touch the left edge.
  ctx.translate(width <= 950 ? 46 : 44, margin.top + innerHeight / 2);
  ctx.rotate(-Math.PI / 2);
  setFittedFigureFont(ctx, labels.y, style.axisFontPx, 21, innerHeight - 16);
  ctx.fillText(labels.y, 0, 0);
  ctx.restore();
  ctx.restore();
}

function hexToRgb(color) {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = saturation / 100;
  const l = lightness / 100;
  if (s === 0) return [l, l, l].map(value => Math.round(value * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hueToRgb = t0 => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hueToRgb(h + 1 / 3), hueToRgb(h), hueToRgb(h - 1 / 3)]
    .map(value => Math.round(value * 255));
}

function rowRgb(row, totalRows = ROW_COLORS.length) {
  const index = Math.max(0, Number(row));
  if (totalRows <= ROW_COLORS.length) return hexToRgb(ROW_COLORS[index % ROW_COLORS.length]);
  const ratio = totalRows <= 1 ? 0.5 : index / (totalRows - 1);
  // Detector row is ordinal, not categorical.  For many rows use a restrained
  // blue-to-gold ordered ramp instead of a rainbow categorical palette.
  const stops = [
    { at: 0, rgb: [31, 78, 121] },
    { at: 0.5, rgb: [67, 131, 120] },
    { at: 1, rgb: [204, 126, 0] },
  ];
  const upper = ratio <= 0.5 ? stops[1] : stops[2];
  const lower = ratio <= 0.5 ? stops[0] : stops[1];
  const local = (ratio - lower.at) / (upper.at - lower.at);
  return lower.rgb.map((value, channel) => Math.round(value + local * (upper.rgb[channel] - value)));
}

function rowColor(row, totalRows = ROW_COLORS.length) {
  return `rgb(${rowRgb(row, totalRows).join(", ")})`;
}

function opaqueWeightColor(row, totalRows, weight) {
  const clipped = Math.max(0, Math.min(1, Number(weight)));
  // Keep the visual mapping monotonic and linear.  The outline preserves the
  // row identity even at w=0, while the fill progresses uniformly from pale
  // to saturated as the assumed normalized weight increases from 0 to 1.
  const amount = 0.12 + 0.88 * clipped;
  const channels = rowRgb(row, totalRows)
    .map(channel => Math.round(255 - (255 - channel) * amount));
  return `rgb(${channels.join(", ")})`;
}

function drawWeightedMarker(ctx, row, totalRows, x, y, radius, weight) {
  const color = rowColor(row, totalRows);
  ctx.fillStyle = opaqueWeightColor(row, totalRows, weight);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawWrappedLegendText(ctx, text, left, y, maxWidth, lineHeight = 22) {
  const segments = String(text).split(/\s*[／/]\s*/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const segment of segments) {
    const candidate = line ? `${line} / ${segment}` : segment;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = segment;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  lines.forEach((value, index) => ctx.fillText(value, left, y + index * lineHeight));
}

function drawWeightLegend(ctx, left, top, width, totalRows, countText) {
  const y0 = top + 6;
  ctx.save();
  ctx.fillStyle = INK;
  ctx.font = `20px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const weightLabel = "Linear interpolation weight w";
  ctx.fillText(weightLabel, left, y0 + 18);
  const labelWidth = ctx.measureText(weightLabel).width;
  const weights = [0, 0.25, 0.5, 0.75, 1];
  const markerStart = left + labelWidth + 24;
  const markerSpacing = Math.min(70, Math.max(48, (width - labelWidth - 48) / (weights.length - 1)));
  weights.forEach((weight, index) => {
    const markerX = markerStart + index * markerSpacing;
    drawWeightedMarker(ctx, 0, totalRows, markerX, y0 + 18, 6, weight);
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FIGURE_FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(weight.toFixed(weight === 0 || weight === 1 ? 0 : 2), markerX, y0 + 44);
  });
  ctx.font = `20px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2;
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(left, y0 + 76); ctx.lineTo(left + 43, y0 + 76); ctx.stroke();
  ctx.fillStyle = INK; ctx.fillText("Acquired projection data over 0-360°", left + 53, y0 + 76);
  if (countText) {
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FIGURE_FONT}`;
    drawWrappedLegendText(ctx, countText, left, y0 + 108, width);
  }
  ctx.restore();
}

function drawCandidateTrace(ctx, diagram, row, turn, x, yDown) {
  const trace = diagram.traceGeometry;
  const angles = trace.angles;
  const axial = trace.axial;
  const scales = trace.scales;
  const rowOffset = trace.rowOffsets[row];
  const totalRows = diagram.totalRows;
  ctx.save();
  ctx.strokeStyle = rowColor(row, totalRows);
  const densityScale = Math.min(1, Math.sqrt(24 / Math.max(24, totalRows)));
  ctx.globalAlpha = 0.60 * densityScale;
  ctx.lineWidth = Math.max(0.45, 1.35 * densityScale);
  ctx.setLineDash([]);
  ctx.beginPath();
  let previousAngle = null;
  for (let index = 0; index < angles.length; index += 1) {
    const angle = angles[index];
    const delta = axial[index] + turn * trace.feed + scales[index] * rowOffset - diagram.z0;
    const px = x(delta);
    const py = yDown(angle);
    if (previousAngle === null || Math.abs(angle - previousAngle) > 180) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
    previousAngle = angle;
  }
  ctx.stroke();
  ctx.restore();
}

function drawOverviewLegend(ctx, diagram, left, top, width, countText) {
  const legendCount = Math.min(6, diagram.totalRows);
  const rows = Array.from({ length: legendCount }, (_, index) => (
    legendCount === 1 ? 0 : Math.round(index * (diagram.totalRows - 1) / (legendCount - 1))
  ));
  ctx.save();
  ctx.font = `20px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = INK;
  const rowLabel = "Detector row";
  ctx.fillText(rowLabel, left, top + 21);
  const rowLabelWidth = ctx.measureText(rowLabel).width;
  ctx.font = `18px ${FIGURE_FONT}`;
  const itemWidths = rows.map(row => 34 + ctx.measureText(`${row + 1}`).width);
  const itemWidthTotal = itemWidths.reduce((sum, value) => sum + value, 0);
  const rowLegendStart = left + rowLabelWidth + 24;
  const remainingGapWidth = Math.max(0, left + width - rowLegendStart - itemWidthTotal);
  const itemGap = rows.length > 1 ? Math.max(12, Math.min(32, remainingGapWidth / (rows.length - 1))) : 0;
  let rowLegendX = rowLegendStart;
  rows.forEach((row, index) => {
    const x0 = rowLegendX;
    const y = top + 21;
    ctx.strokeStyle = rowColor(row, diagram.totalRows);
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + 28, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FIGURE_FONT}`;
    ctx.fillText(`${row + 1}`, x0 + 34, y);
    rowLegendX += itemWidths[index] + itemGap;
  });
  ctx.font = `19px ${FIGURE_FONT}`;
  const acquiredLabel = "Acquired projection data";
  const targetLabel = "Target plane (zᵢ-z₀=0)";
  const secondRowY = top + 54;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2;
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(left, secondRowY); ctx.lineTo(left + 42, secondRowY); ctx.stroke();
  const acquiredTextX = left + 52;
  ctx.fillStyle = INK; ctx.fillText(acquiredLabel, acquiredTextX, secondRowY);
  const acquiredTextRight = acquiredTextX + ctx.measureText(acquiredLabel).width;
  const targetTextWidth = ctx.measureText(targetLabel).width;
  let targetMarkerX = acquiredTextRight + 24;
  let targetTextX = targetMarkerX + 12;
  let targetY = secondRowY;
  let countY = top + 84;
  if (targetTextX + targetTextWidth > left + width) {
    targetMarkerX = left;
    targetTextX = left + 12;
    targetY = top + 84;
    countY = top + 114;
  }
  ctx.strokeStyle = RED;
  ctx.lineWidth = 2.4;
  ctx.beginPath(); ctx.moveTo(targetMarkerX, targetY - 12); ctx.lineTo(targetMarkerX, targetY + 12); ctx.stroke();
  ctx.fillStyle = INK; ctx.fillText(targetLabel, targetTextX, targetY);
  if (countText) {
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FIGURE_FONT}`;
    drawWrappedLegendText(ctx, countText, left, countY, width);
  }
  ctx.restore();
}

function drawDiagram(canvas, diagram, mode = "zoom", sharedXLimit = null, focusXLimit = null) {
  const publicationMode = canvas.dataset.publicationMode === "true";
  const ownLimit = mode === "overview" ? diagram.overviewXLimit : diagram.zoomXLimit;
  const requiredXLimit = sharedXLimit ?? ownLimit;
  const xAxis = symmetricNiceAxis(requiredXLimit, 3);
  const xLimit = xAxis.xMax;
  const plot = axisContext(canvas, { xMin: xAxis.xMin, xMax: xAxis.xMax, yMin: 0, yMax: 360 }, {
    x: "Longitudinal candidate position  zᵢ - z₀  (mm)",
    y: "Relative tube angle  β  (°)",
    xFormatter: xAxis.formatter,
    yFormatter: value => Number(value).toFixed(0),
    topMargin: publicationMode ? 116 : 164,
  });
  const { ctx, margin, innerWidth, innerHeight, x, yDown } = plot;
  const bandLimit = Math.min(xLimit, mode === "overview"
    ? (focusXLimit ?? diagram.zoomXLimit)
    : Math.max(diagram.interpolationBandHalfWidth ?? 0, 0.15));
  ctx.fillStyle = PALE;
  ctx.fillRect(x(-bandLimit), margin.top, x(bandLimit) - x(-bandLimit), innerHeight);
  if (mode === "overview") {
    ctx.fillStyle = "#557482";
    ctx.font = `18px ${FIGURE_FONT}`;
    ctx.textAlign = "center";
    ctx.fillText("Enlarged range in 2B", x(0), margin.top + 24);
  } else {
    ctx.fillStyle = "#557482";
    ctx.font = `18px ${FIGURE_FONT}`;
    ctx.textAlign = "center";
    ctx.fillText("Range in which the nearest candidates bracket z₀", x(0), margin.top + 24);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, innerWidth, innerHeight);
  ctx.clip();
  for (let row = 0; row < diagram.totalRows; row += 1) {
    for (const turn of diagram.traceGeometry.turns) {
      drawCandidateTrace(ctx, diagram, row, turn, x, yDown);
    }
  }
  if (mode === "zoom") {
    const pointsByWeight = [...diagram.weightedPoints].sort((a, b) => a.weight - b.weight);
    for (const point of pointsByWeight) {
      const px = x(point.x); const py = yDown(point.y);
      drawWeightedMarker(ctx, point.row, diagram.totalRows, px, py, 5.2, point.weight);
    }
  }
  ctx.strokeStyle = RED;
  ctx.setLineDash([]);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x(0), margin.top); ctx.lineTo(x(0), margin.top + innerHeight); ctx.stroke();
  ctx.restore();
  drawAxes(plot, xAxis.ticks, [0, 60, 120, 180, 240, 300, 360], true);
  const usedTurnText = diagram.usedTurns.length ? diagram.usedTurns.map(value => value > 0 ? `+${value}` : String(value)).join(", ") : "none";
  if (mode === "overview") {
    const countText = `All ${diagram.totalRows} rows shown (legend: ${Math.min(6, diagram.totalRows)} representative rows) / offsets from reference rotation ${diagram.turnOffsetMin} to ${diagram.turnOffsetMax} (${diagram.turnCount} rotations) / ${diagram.candidateLineCount} candidate trajectories`;
    drawOverviewLegend(ctx, diagram, margin.left, 8, innerWidth, publicationMode ? "" : countText);
  } else {
    const outside = diagram.usedTurnsOutsideOverview.length ? ` / ${diagram.usedTurnsOutsideOverview.length} rotations outside overview` : "";
    const countText = `${diagram.weightedPoints.length} nearest candidates (${diagram.renderedAngleSamples}/${diagram.samples} angular samples shown) / contributing rotations ${usedTurnText}${outside}`;
    drawWeightLegend(ctx, margin.left, 8, innerWidth, diagram.totalRows, publicationMode ? "" : countText);
  }
  canvas.dataset.xMin = String(xAxis.xMin);
  canvas.dataset.xMax = String(xAxis.xMax);
  canvas.dataset.xStep = String(xAxis.step);
  canvas.dataset.xRequiredHalfSpan = String(requiredXLimit);
  canvas.dataset.axisRule = "symmetric-natural-1-2-5-containing-all-rendered-data";
}

function gapMapMaximum(result) {
  let maximum = 0;
  for (const condition of [result.overlay?.off, result.overlay?.on]) {
    if (!condition?.gapRatio) continue;
    for (const value of condition.gapRatio) if (Number.isFinite(value)) maximum = Math.max(maximum, value);
  }
  if (!(maximum > 0)) return 1;
  const step = niceCeilingStep(maximum / 4);
  return Math.max(step, Math.ceil(maximum / step - 1e-12) * step);
}

function gapMapColor(value, maximum) {
  const ratio = Math.max(0, Math.min(1, value / Math.max(maximum, Number.EPSILON)));
  const stops = [
    { at: 0, rgb: [247, 250, 252] },
    { at: 0.25, rgb: [198, 219, 239] },
    { at: 0.5, rgb: [107, 174, 214] },
    { at: 0.75, rgb: [33, 113, 181] },
    { at: 1, rgb: [8, 48, 107] },
  ];
  const upperIndex = Math.min(stops.length - 1, Math.max(1, stops.findIndex(stop => ratio <= stop.at)));
  const lower = stops[upperIndex - 1];
  const upper = stops[upperIndex];
  const local = (ratio - lower.at) / Math.max(Number.EPSILON, upper.at - lower.at);
  const rgb = lower.rgb.map((channel, index) => Math.round(channel + local * (upper.rgb[index] - channel)));
  return `rgb(${rgb.join(", ")})`;
}

function drawGapMap(canvas, result, coneOn) {
  const publicationMode = canvas.dataset.publicationMode === "true";
  const overlay = result.overlay;
  if (!overlay) return;
  const condition = coneOn ? overlay.on : overlay.off;
  const maximum = gapMapMaximum(result);
  const plot = axisContext(canvas, { xMin: 0, xMax: 1, yMin: 0, yMax: 360 }, {
    x: "Relative reconstruction position within one table feed  s",
    y: "Relative tube angle  β  (°)",
    xFormatter: value => Number(value).toFixed(1),
    yFormatter: value => Number(value).toFixed(0),
    topMargin: publicationMode ? 76 : 112,
    rightMargin: 112,
  });
  const cellWidth = plot.innerWidth / overlay.stateCount;
  const cellHeight = plot.innerHeight / overlay.geometryAngleCount;
  plot.ctx.save();
  plot.ctx.beginPath();
  plot.ctx.rect(plot.margin.left, plot.margin.top, plot.innerWidth, plot.innerHeight);
  plot.ctx.clip();
  for (let stateIndex = 0; stateIndex < overlay.stateCount; stateIndex += 1) {
    const offset = stateIndex * overlay.geometryAngleCount;
    for (let angleIndex = 0; angleIndex < overlay.geometryAngleCount; angleIndex += 1) {
      const value = condition.gapRatio[offset + angleIndex];
      plot.ctx.fillStyle = Number.isFinite(value) ? gapMapColor(value, maximum) : "#bdbdbd";
      plot.ctx.fillRect(
        plot.margin.left + stateIndex * cellWidth,
        plot.margin.top + angleIndex * cellHeight,
        Math.ceil(cellWidth + 0.5),
        Math.ceil(cellHeight + 0.5),
      );
    }
  }
  if (!publicationMode) {
    const selectedState = selectedStateIndex / 360;
    plot.ctx.strokeStyle = RED;
    plot.ctx.lineWidth = 1.8;
    plot.ctx.beginPath();
    plot.ctx.moveTo(plot.x(selectedState), plot.margin.top);
    plot.ctx.lineTo(plot.x(selectedState), plot.margin.top + plot.innerHeight);
    plot.ctx.stroke();
  }
  plot.ctx.restore();
  drawAxes(plot, [0, 0.2, 0.4, 0.6, 0.8, 1], [0, 60, 120, 180, 240, 300, 360], true);

  const colorX = plot.margin.left + plot.innerWidth + 24;
  const colorWidth = 18;
  const gradient = plot.ctx.createLinearGradient(0, plot.margin.top + plot.innerHeight, 0, plot.margin.top);
  for (const stop of [0, 0.25, 0.5, 0.75, 1]) gradient.addColorStop(stop, gapMapColor(stop * maximum, maximum));
  plot.ctx.fillStyle = gradient;
  plot.ctx.fillRect(colorX, plot.margin.top, colorWidth, plot.innerHeight);
  plot.ctx.strokeStyle = INK;
  plot.ctx.lineWidth = 1;
  plot.ctx.strokeRect(colorX, plot.margin.top, colorWidth, plot.innerHeight);
  const colorTicks = [0, maximum / 2, maximum];
  const colorFormatter = fixedFormatterForTicks(colorTicks);
  plot.ctx.fillStyle = INK;
  plot.ctx.font = `19px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "left";
  plot.ctx.textBaseline = "middle";
  for (const value of colorTicks) {
    const py = plot.margin.top + plot.innerHeight * (1 - value / maximum);
    plot.ctx.fillText(colorFormatter(value), colorX + colorWidth + 7, py);
  }
  plot.ctx.font = `700 20px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "center";
  plot.ctx.textBaseline = "bottom";
  plot.ctx.fillText("Δz/T", colorX + colorWidth / 2, plot.margin.top - 8);
  plot.ctx.fillStyle = INK;
  plot.ctx.font = `700 23px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "left";
  plot.ctx.textBaseline = "top";
  const conditionLabel = coneOn ? "With cone-geometry scaling (periodic source-to-point distance)" : "Without cone-geometry scaling (parallel-beam approximation)";
  plot.ctx.fillText(`Nearest-candidate spacing ratio Δz/T - ${conditionLabel}`, plot.margin.left, 10);
  if (!publicationMode) {
    plot.ctx.fillStyle = MUTED;
    plot.ctx.font = `18px ${FIGURE_FONT}`;
    plot.ctx.fillText(`Configured thickness T=${fmt(result.params.sliceThicknessMm, 1)} mm / no fixed search support / gray indicates missing values`, plot.margin.left, 43);
  }
  canvas.dataset.colorMin = "0";
  canvas.dataset.colorMax = String(maximum);
  canvas.dataset.colorScale = "linear-shared-off-on";
  canvas.dataset.geometryIndicator = "nearest-bracketing-gap-over-configured-thickness";
}

function niceBounds(values, padFraction = 0.08, minimumSpan = 0) {
  let min = Math.min(...values.filter(Number.isFinite));
  let max = Math.max(...values.filter(Number.isFinite));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max - min < minimumSpan) {
    const middle = 0.5 * (min + max);
    min = middle - minimumSpan / 2;
    max = middle + minimumSpan / 2;
  } else if (Math.abs(max - min) < 1e-9) {
    min -= 0.05;
    max += 0.05;
  }
  const pad = (max - min) * padFraction;
  return [min - pad, max + pad];
}

function drawPolyline(ctx, points, x, y, color, width = 3, dash = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) { started = false; continue; }
    const px = x(point[0]); const py = y(point[1]);
    if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

function drawLegend(ctx, items, x0, y0, fontSize = 20) {
  ctx.save();
  ctx.font = `${fontSize}px ${FIGURE_FONT}`;
  ctx.textBaseline = "middle";
  items.forEach((item, index) => {
    const y = y0 + index * 30;
    ctx.strokeStyle = item.color; ctx.lineWidth = 5; ctx.setLineDash(item.dash || []);
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + 42, y); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = INK; ctx.fillText(item.label, x0 + 54, y);
  });
  ctx.restore();
}

function niceProfileTicks(min, max, targetCount = 5) {
  const span = Math.max(Number.EPSILON, max - min);
  const rawStep = span / Math.max(2, targetCount - 1);
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const scaled = rawStep / power;
  const factor = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  const step = factor * power;
  const ticks = [];
  const start = Math.ceil((min - 1e-10) / step) * step;
  const end = Math.floor((max + 1e-10) / step) * step;
  for (let value = start; value <= end + step * 1e-8; value += step) {
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : Number(value.toPrecision(12)));
  }
  return ticks.length >= 2 ? ticks : [min, 0, max].filter((value, index, values) => value >= min && value <= max && values.indexOf(value) === index);
}

function stepFromTicks(ticks) {
  const differences = [];
  for (let index = 1; index < ticks.length; index += 1) {
    const difference = Math.abs(ticks[index] - ticks[index - 1]);
    if (difference > Number.EPSILON) differences.push(difference);
  }
  return differences.length ? Math.min(...differences) : 1;
}

function fixedFormatterForTicks(ticks, maximumDigits = 6) {
  const digits = Math.min(maximumDigits, decimalPlacesForStep(stepFromTicks(ticks)));
  return value => {
    const normalized = Math.abs(value) < 0.5 * (10 ** -digits) ? 0 : value;
    return Number(normalized).toFixed(digits);
  };
}

function symmetricNiceAxis(requiredHalfSpan, targetHalfIntervals = 3) {
  const rawStep = Math.max(Number.EPSILON, requiredHalfSpan / Math.max(1, targetHalfIntervals));
  const step = niceNearestStep(rawStep);
  const halfIntervals = Math.max(1, Math.ceil(requiredHalfSpan / step - 1e-12));
  const limit = halfIntervals * step;
  const ticks = Array.from({ length: 2 * halfIntervals + 1 }, (_, index) => (index - halfIntervals) * step);
  return { xMin: -limit, xMax: limit, step, ticks, formatter: fixedFormatterForTicks(ticks) };
}

function niceNearestStep(value) {
  const positive = Math.max(Number.EPSILON, Number(value));
  const power = 10 ** Math.floor(Math.log10(positive));
  const normalized = positive / power;
  const factors = [1, 2, 5, 10];
  let best = factors[0];
  let bestDistance = Math.abs(normalized - best);
  for (const factor of factors.slice(1)) {
    const distance = Math.abs(normalized - factor);
    if (distance < bestDistance - 1e-12) {
      best = factor;
      bestDistance = distance;
    }
  }
  return best * power;
}

function niceScale(values, { targetIntervals = 4, padFraction = 0.06, minimumSpan = 0 } = {}) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], step: 0.25 };
  let minimum = Math.min(...finite);
  let maximum = Math.max(...finite);
  if (maximum - minimum < minimumSpan) {
    const middle = 0.5 * (minimum + maximum);
    minimum = middle - minimumSpan / 2;
    maximum = middle + minimumSpan / 2;
  }
  if (maximum - minimum <= Number.EPSILON) {
    const delta = Math.max(0.05, Math.abs(maximum) * 0.02);
    minimum -= delta;
    maximum += delta;
  }
  const paddedSpan = (maximum - minimum) * (1 + 2 * padFraction);
  const step = niceCeilingStep(paddedSpan / Math.max(2, targetIntervals));
  const paddedMinimum = minimum - (maximum - minimum) * padFraction;
  const paddedMaximum = maximum + (maximum - minimum) * padFraction;
  let niceMinimum = Math.floor((paddedMinimum + 1e-12) / step) * step;
  let niceMaximum = Math.ceil((paddedMaximum - 1e-12) / step) * step;
  if (niceMaximum <= niceMinimum) niceMaximum = niceMinimum + step;
  const ticks = [];
  for (let value = niceMinimum; value <= niceMaximum + step * 1e-8; value += step) {
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : Number(value.toPrecision(12)));
  }
  return { min: niceMinimum, max: niceMaximum, ticks, step, formatter: fixedFormatterForTicks(ticks) };
}

function niceCeilingStep(value) {
  const positive = Math.max(Number.EPSILON, Number(value));
  const power = 10 ** Math.floor(Math.log10(positive));
  const normalized = positive / power;
  for (const factor of [1, 2, 5, 10]) {
    if (normalized <= factor + 1e-12) return factor * power;
  }
  return 10 * power;
}

function decimalPlacesForStep(step) {
  for (let digits = 0; digits <= 6; digits += 1) {
    if (Math.abs(step - Number(step.toFixed(digits))) <= Math.max(1e-12, Math.abs(step) * 1e-10)) return digits;
  }
  return 6;
}

function selectedProfileAxis(result) {
  // The selected-state chart is a linear-scale view of the configured output,
  // so its domain is determined only by the part of the final SSPz at or above
  // 10% of the peak. Low-amplitude tails are intentionally moved to the
  // dedicated logarithmic tail panel instead of compressing the central shape.
  const threshold = 0.1;
  const z = result.selectedOff.z;
  const dz = z.length > 1 ? Math.abs(z[1] - z[0]) : 0;
  let observedHalfSupport = 0;

  const includeProfile = (profileZ, profile) => {
    if (!profileZ || !profile) return;
    const length = Math.min(profileZ.length, profile.length);
    for (let index = 0; index < length; index += 1) {
      if (profile[index] >= threshold) observedHalfSupport = Math.max(observedHalfSupport, Math.abs(profileZ[index]));
    }
  };

  includeProfile(result.selectedOff.z, result.selectedOff.profile);
  includeProfile(result.selectedOn.z, result.selectedOn.profile);

  const minimumHalfSpan = Math.max(0.75 * result.params.sliceThicknessMm, 6 * dz);
  const requiredHalfSpan = Math.max(minimumHalfSpan, observedHalfSupport * 1.15 + 3 * dz);
  const nice = symmetricNiceAxis(requiredHalfSpan, 3);
  return {
    xMin: nice.xMin,
    xMax: nice.xMax,
    tickStep: nice.step,
    ticks: nice.ticks,
    observedHalfSupport,
  };
}

function drawProfileEncodingLegend(ctx, left, top) {
  ctx.save();
  ctx.font = `22px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const drawKey = (x, y, color, dash, label) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 50, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK;
    ctx.fillText(label, x + 62, y);
  };
  drawKey(left, top + 20, BLUE, [], "Without cone-geometry scaling");
  drawKey(left + 410, top + 20, ORANGE, [], "With cone-geometry scaling (idealized)");
  ctx.restore();
}

function drawProfiles(canvas, result) {
  const publicationMode = canvas.dataset.publicationMode === "true";
  const axis = selectedProfileAxis(result);
  const { xMin, xMax } = axis;
  const plot = axisContext(canvas, { xMin, xMax, yMin: 0, yMax: 1.04 }, {
    x: "Position relative to reconstruction plane  z - z₀  (mm)",
    y: "Normalized SSPz",
    xFormatter: value => Number(value).toFixed(decimalPlacesForStep(axis.tickStep)),
    yFormatter: value => value.toFixed(1),
    topMargin: publicationMode ? 96 : 126,
  });
  const off = result.selectedOff.z.map((z, i) => [z, result.selectedOff.profile[i]]);
  const on = result.selectedOn.z.map((z, i) => [z, result.selectedOn.profile[i]]);
  plot.ctx.save();
  plot.ctx.beginPath();
  plot.ctx.rect(plot.margin.left, plot.margin.top, plot.innerWidth, plot.innerHeight);
  plot.ctx.clip();
  drawPolyline(plot.ctx, off, plot.x, plot.y, BLUE, 4);
  drawPolyline(plot.ctx, on, plot.x, plot.y, ORANGE, 4);
  plot.ctx.save(); plot.ctx.strokeStyle = MUTED; plot.ctx.setLineDash([5,5]); plot.ctx.lineWidth = 1;
  for (const level of [0.5, 0.1]) { plot.ctx.beginPath(); plot.ctx.moveTo(plot.margin.left, plot.y(level)); plot.ctx.lineTo(plot.margin.left + plot.innerWidth, plot.y(level)); plot.ctx.stroke(); }
  plot.ctx.restore();
  plot.ctx.restore();
  drawAxes(plot, axis.ticks, [0, 0.2, 0.4, 0.6, 0.8, 1.0]);
  drawProfileEncodingLegend(plot.ctx, plot.margin.left, 6);
  plot.ctx.save();
  plot.ctx.fillStyle = MUTED;
  plot.ctx.font = `18px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "right";
  plot.ctx.textBaseline = "bottom";
  plot.ctx.fillText("50% (FWHM)", plot.margin.left + plot.innerWidth - 8, plot.y(0.5) - 5);
  plot.ctx.fillText("10% (FWTM)", plot.margin.left + plot.innerWidth - 8, plot.y(0.1) - 5);
  plot.ctx.restore();
  canvas.dataset.xMin = String(axis.xMin);
  canvas.dataset.xMax = String(axis.xMax);
  canvas.dataset.xStep = String(axis.tickStep);
  canvas.dataset.configuredThicknessMm = String(result.params.sliceThicknessMm);
  canvas.dataset.axisRule = "configured-output-at-or-above-ten-percent";
  canvas.dataset.legendOrder = "configured-output-only";
  canvas.setAttribute("aria-label", `Selected-state SSPz comparison after applying T=${fmt(result.params.sliceThicknessMm, 1)} mm. The horizontal range is determined from the central profile at or above 10%.`);
  if (profileAxisNote) {
    profileAxisNote.textContent = `Configured thickness T=${fmt(result.params.sliceThicknessMm, 1)} mm / horizontal range ${fmt(axis.xMin, decimalPlacesForStep(axis.tickStep))} to +${fmt(axis.xMax, decimalPlacesForStep(axis.tickStep))} mm (automatically determined from the post-thickness SSPz at or above 10%)`;
  }
}

function drawOverlayLegend(ctx, x, y, color) {
  ctx.save();
  ctx.font = `20px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 36, y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = INK;
  ctx.fillText("360 states", x + 45, y);
  ctx.restore();
}

function configuredOverlayBounds(result, threshold, minimumHalfSpan) {
  const overlay = result.overlay;
  const summaries = [overlay.off.finalSummary, overlay.on.finalSummary];
  let first = overlay.zCount - 1;
  let last = 0;
  let found = false;
  for (const summary of summaries) {
    for (let index = 0; index < overlay.zCount; index += 1) {
      if (summary.maximum[index] >= threshold) {
        found = true;
        first = Math.min(first, index);
        last = Math.max(last, index);
      }
    }
  }
  const rawHalfSpan = found
    ? Math.max(Math.abs(overlay.z[Math.max(0, first)]), Math.abs(overlay.z[Math.min(overlay.zCount - 1, last)]))
    : 0;
  const dz = overlay.zCount > 1 ? Math.abs(overlay.z[1] - overlay.z[0]) : 0;
  const requiredHalfSpan = Math.max(minimumHalfSpan, rawHalfSpan * 1.12 + 3 * dz);
  return symmetricNiceAxis(requiredHalfSpan, 3);
}

function configuredOverlayAxes(result) {
  const core = configuredOverlayBounds(result, 0.1, 0.75 * result.params.sliceThicknessMm);
  const tail = configuredOverlayBounds(result, 0.001, core.xMax);
  return { core, tail };
}

function drawProfileOverlay(canvas, result, coneOn, viewMode, xAxis = configuredOverlayAxes(result)[viewMode]) {
  const publicationMode = canvas.dataset.publicationMode === "true";
  const overlay = result.overlay;
  if (!overlay) return;
  const condition = coneOn ? overlay.on : overlay.off;
  const values = condition.final;
  const summary = condition.finalSummary;
  const z = overlay.z;
  const { xMin, xMax } = xAxis;
  const color = coneOn ? ORANGE : BLUE;
  const layered = result.params.profileMode === PROFILE_MODES.LAYERED_RECT;
  const tailView = viewMode === "tail";
  const stageLabel = tailView
    ? `Low-amplitude tails after applying T=${fmt(result.params.sliceThicknessMm, 1)} mm (log scale)`
    : layered
      ? `Primary display: central profiles after applying T=${fmt(result.params.sliceThicknessMm, 1)} mm`
      : `Model SSPz, T=${fmt(result.params.sliceThicknessMm, 1)} mm`;
  const plot = axisContext(canvas, {
    xMin,
    xMax,
    yMin: tailView ? PROFILE_TAIL_DISPLAY_BOUNDS.yMin : 0,
    yMax: tailView ? PROFILE_TAIL_DISPLAY_BOUNDS.yMax : 1.04,
  }, {
    x: "Position relative to reconstruction plane  z - z₀  (mm)",
    y: tailView ? "Normalized SSPz (log scale)" : "Normalized SSPz",
    xFormatter: xAxis.formatter,
    yFormatter: tailView
      ? value => ({ "-3": "0.1%", "-2": "1%", "-1": "10%", "0": "100%" }[String(value)] ?? "")
      : value => value.toFixed(1),
    topMargin: publicationMode ? 116 : 126,
    leftMargin: tailView ? 158 : undefined,
  });

  plot.ctx.save();
  plot.ctx.beginPath();
  plot.ctx.rect(plot.margin.left, plot.margin.top, plot.innerWidth, plot.innerHeight);
  plot.ctx.clip();

  // Draw all 360 configured-output states as separate paths, without a
  // summary band or state decimation. The core view is linear and restricted
  // to >=10%; the tail view is logarithmic and restricted to >=0.1%.
  for (let stateIndex = 0; stateIndex < overlay.stateCount; stateIndex += 1) {
    const complete = condition.coverage[stateIndex] >= 1 - 1e-7;
    const offset = stateIndex * overlay.zCount;
    plot.ctx.save();
    plot.ctx.strokeStyle = complete ? color : MUTED;
    plot.ctx.globalAlpha = complete ? 0.13 : 0.26;
    plot.ctx.lineWidth = 1.1;
    plot.ctx.setLineDash(complete ? [] : [4, 4]);
    plot.ctx.beginPath();
    let active = false;
    for (let zIndex = 0; zIndex < overlay.zCount; zIndex += 1) {
      const value = values[offset + zIndex];
      if (tailView && value < 0.001) {
        active = false;
        continue;
      }
      const px = plot.x(z[zIndex]);
      const py = plot.y(tailView ? Math.log10(Math.max(0.001, value)) : value);
      if (!active) plot.ctx.moveTo(px, py); else plot.ctx.lineTo(px, py);
      active = true;
    }
    plot.ctx.stroke();
    plot.ctx.restore();
  }

  plot.ctx.strokeStyle = MUTED;
  plot.ctx.setLineDash([5, 5]);
  plot.ctx.lineWidth = 1;
  const guideLevels = tailView ? [-2, -1] : [0.5, 0.1];
  for (const level of guideLevels) {
    plot.ctx.beginPath();
    plot.ctx.moveTo(plot.margin.left, plot.y(level));
    plot.ctx.lineTo(plot.margin.left + plot.innerWidth, plot.y(level));
    plot.ctx.stroke();
  }
  plot.ctx.restore();
  drawAxes(plot, xAxis.ticks, tailView ? [-3, -2, -1, 0] : [0, 0.2, 0.4, 0.6, 0.8, 1.0]);

  plot.ctx.save();
  plot.ctx.fillStyle = INK;
  plot.ctx.font = `700 23px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "left";
  plot.ctx.textBaseline = "top";
  const conditionLabel = coneOn ? "With cone-geometry scaling (periodic source-to-point distance)" : "Without cone-geometry scaling (parallel-beam approximation)";
  if (publicationMode) {
    const conciseCondition = coneOn ? "Cone-geometry scaling" : "Parallel-beam approximation";
    const conciseStage = tailView
      ? `Post-thickness low-amplitude tails (T=${fmt(result.params.sliceThicknessMm, 1)} mm)`
      : layered
        ? `Post-thickness central profiles (T=${fmt(result.params.sliceThicknessMm, 1)} mm)`
        : `Model SSPz (T=${fmt(result.params.sliceThicknessMm, 1)} mm)`;
    // Keep the scientific stage and geometry condition on separate lines.
    // A single English line exceeds the fixed 80-mm journal figure width.
    plot.ctx.fillText(conciseStage, plot.margin.left, 8);
    plot.ctx.font = `20px ${FIGURE_FONT}`;
    plot.ctx.fillText(conciseCondition, plot.margin.left, 38);
  } else {
    plot.ctx.fillText(stageLabel, plot.margin.left, 10);
    plot.ctx.fillStyle = MUTED;
    plot.ctx.font = `20px ${FIGURE_FONT}`;
    plot.ctx.fillText(`${conditionLabel} / complete states ${summary.completeCount}/${overlay.stateCount}`, plot.margin.left, 44);
  }
  plot.ctx.restore();
  drawOverlayLegend(plot.ctx, plot.margin.left, publicationMode ? 82 : 92, color);
  plot.ctx.save();
  plot.ctx.fillStyle = INK;
  plot.ctx.font = `18px ${FIGURE_FONT}`;
  plot.ctx.textAlign = "right";
  plot.ctx.textBaseline = "bottom";
  if (tailView) {
    plot.ctx.fillText("10%", plot.margin.left + plot.innerWidth - 8, plot.y(-1) - 5);
    plot.ctx.fillText("1%", plot.margin.left + plot.innerWidth - 8, plot.y(-2) - 5);
  } else {
    plot.ctx.fillText("50%", plot.margin.left + plot.innerWidth - 8, plot.y(0.5) - 5);
    plot.ctx.fillText("10%", plot.margin.left + plot.innerWidth - 8, plot.y(0.1) - 5);
  }
  plot.ctx.restore();
  canvas.dataset.individualProfileCount = String(overlay.stateCount);
  canvas.dataset.individualProfileRendering = "one-path-per-state";
  canvas.dataset.xMin = String(xAxis.xMin);
  canvas.dataset.xMax = String(xAxis.xMax);
  canvas.dataset.xStep = String(xAxis.step);
  canvas.dataset.profileStage = "configured-output-only";
  canvas.dataset.viewMode = viewMode;
  if (tailView) {
    canvas.dataset.renderedMinimum = "0.001";
    canvas.dataset.displayYMinLog10 = String(PROFILE_TAIL_DISPLAY_BOUNDS.yMin);
    canvas.dataset.displayYMaxLog10 = String(PROFILE_TAIL_DISPLAY_BOUNDS.yMax);
  }
  canvas.dataset.sharedXDomain = `configured-output-${viewMode}-off-on`;
  canvas.setAttribute("aria-label", tailView
    ? `Log-scale display of post-thickness SSPz tails at or above 0.1% for 360 states: ${conditionLabel}`
    : `Linear display of post-thickness SSPz central profiles at or above 10% for 360 states: ${conditionLabel}`);
}

function selectedMetric(result) {
  const key = metricSelect.value;
  const labels = { fwhm: "FWHM", fwtm: "FWTM", sigma: "σ" };
  const layered = result?.params.profileMode === PROFILE_MODES.LAYERED_RECT;
  const stageLabel = layered
    ? `Post-thickness model SSPz (T=${fmt(result.params.sliceThicknessMm, 1)} mm)`
    : `Model SSPz (T=${fmt(result.params.sliceThicknessMm, 1)} mm)`;
  metricLabel.textContent = `${stageLabel} / ${labels[key]}`;
  return { key, rawKey: key, label: labels[key], stageLabel, layered };
}

function drawConditionLegend(ctx, left, y) {
  ctx.save();
  ctx.font = `21px ${FIGURE_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const items = [
    { x: left, color: BLUE, label: "Without cone-geometry scaling" },
    { x: left + 430, color: ORANGE, label: "With cone-geometry scaling (idealized)" },
  ];
  for (const item of items) {
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 4;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(item.x, y); ctx.lineTo(item.x + 52, y); ctx.stroke();
    ctx.fillStyle = INK;
    ctx.fillText(item.label, item.x + 64, y);
  }
  ctx.restore();
}

function drawSweep(canvas, result) {
  const metric = selectedMetric(result);
  const publicationMode = canvas.dataset.publicationMode === "true";
  const thickness = result.params.sliceThicknessMm;
  const ratioValue = row => row[metric.key] / thickness;
  const values = result.sweep.map(ratioValue);
  const yScale = niceScale(values, { targetIntervals: 5, padFraction: 0.08, minimumSpan: 0.01 });
  const plot = axisContext(canvas, { xMin: 0, xMax: 1, yMin: yScale.min, yMax: yScale.max }, {
    x: "Model state within one table feed  s",
    y: `${metric.label} / T`,
    xFormatter: value => Number(value).toFixed(1),
    yFormatter: yScale.formatter,
    topMargin: publicationMode ? 78 : 134,
    leftMargin: 158,
  });
  for (const coneOn of [false, true]) {
    const points = result.sweep
      .filter(row => row.coneOn === coneOn)
      .map(row => [row.state, ratioValue(row)]);
    drawPolyline(plot.ctx, points, plot.x, plot.y, coneOn ? ORANGE : BLUE, 4);
  }
  if (metric.rawKey === "fwhm" && yScale.min <= 1 && 1 <= yScale.max) {
    plot.ctx.save();
    plot.ctx.strokeStyle = MUTED;
    plot.ctx.lineWidth = 1.4;
    plot.ctx.setLineDash([6, 5]);
    plot.ctx.beginPath();
    plot.ctx.moveTo(plot.margin.left, plot.y(1));
    plot.ctx.lineTo(plot.margin.left + plot.innerWidth, plot.y(1));
    plot.ctx.stroke();
    plot.ctx.restore();
  }
  if (!publicationMode) {
    const selectedState = selectedStateIndex / 360;
    plot.ctx.save();
    plot.ctx.strokeStyle = INK;
    plot.ctx.lineWidth = 2;
    plot.ctx.setLineDash([5, 4]);
    plot.ctx.beginPath();
    plot.ctx.moveTo(plot.x(selectedState), plot.margin.top);
    plot.ctx.lineTo(plot.x(selectedState), plot.margin.top + plot.innerHeight);
    plot.ctx.stroke();
    plot.ctx.setLineDash([]);
    for (const coneOn of [false, true]) {
      const row = result.sweep.find(item => item.coneOn === coneOn && item.stateIndex === selectedStateIndex);
      if (!row) continue;
      plot.ctx.fillStyle = coneOn ? ORANGE : BLUE;
      plot.ctx.strokeStyle = "#fff";
      plot.ctx.lineWidth = 2;
      plot.ctx.beginPath();
      plot.ctx.arc(plot.x(selectedState), plot.y(ratioValue(row)), 6, 0, Math.PI * 2);
      plot.ctx.fill();
      plot.ctx.stroke();
    }
    plot.ctx.restore();
  }
  const stateTicks = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  drawAxes(plot, stateTicks, yScale.ticks);
  if (!publicationMode) {
    plot.ctx.save();
    plot.ctx.fillStyle = INK;
    plot.ctx.font = `700 24px ${FIGURE_FONT}`;
    plot.ctx.textAlign = "left";
    plot.ctx.textBaseline = "top";
    plot.ctx.fillText(`${metric.stageLabel} / ${metric.label}`, plot.margin.left, 13);
    plot.ctx.fillStyle = MUTED;
    plot.ctx.font = `20px ${FIGURE_FONT}`;
    const subtitle = metric.layered
      ? `${metric.label} computed after applying the configured slice thickness T=${fmt(result.params.sliceThicknessMm, 1)} mm`
      : `Model SSPz for configured slice thickness T=${fmt(result.params.sliceThicknessMm, 1)} mm`;
    plot.ctx.fillText(subtitle, plot.margin.left, 45);
    plot.ctx.restore();
  }
  drawConditionLegend(plot.ctx, plot.margin.left, publicationMode ? 34 : 94);
  canvas.dataset.xMin = "0";
  canvas.dataset.xMax = "1";
  canvas.dataset.xStep = "0.2";
  canvas.dataset.yMin = String(yScale.min);
  canvas.dataset.yMax = String(yScale.max);
  canvas.dataset.yStep = String(yScale.step);
  canvas.dataset.normalization = "width-divided-by-configured-slice-thickness";
  canvas.dataset.axisRule = "natural-1-2-5-with-consistent-decimals";
  if (sweepInterpretation) {
    const structurallyConstrained = result.params.profileMode === PROFILE_MODES.LAYERED_RECT
      && metric.rawKey === "fwhm";
    sweepInterpretation.hidden = false;
    sweepInterpretation.textContent = structurallyConstrained
      ? "Because the explanatory model uses a rectangular window with the configured thickness, post-thickness FWHM/T is structurally constrained near 1. This plot does not show the intermediate width before thickness application. A flat curve does not prove that geometric effects are absent; inspect the complete post-thickness SSPz, FWTM/T, σ/T, and the angular-longitudinal diagram together."
      : `This plot shows ${metric.label}/T for ${metric.stageLabel}. It is not the intermediate width before thickness application. Interpret FWTM, σ, and the complete post-thickness SSPz together with FWHM.`;
  }
}

function renderSummary(result) {
  const primaryCards = [];
  const secondaryCards = [];
  for (const [key, label, css] of [["off", "Without cone-geometry scaling", ""], ["on", "With cone-geometry scaling", "on"]]) {
    const summary = result.summaries[key];
    primaryCards.push(`
      <div class="summary-card ${css}">
        <span>${label} / maximum Δz/T over all angles and states</span>
        <strong>${fmt(summary.bracketGapRatioMax.max, 3)}</strong>
        <small>State-wise maxima ${fmt(summary.bracketGapRatioMax.min, 3)}-${fmt(summary.bracketGapRatioMax.max, 3)}</small>
      </div>`);
    secondaryCards.push(`
      <div class="summary-card ${css}">
        <span>${label} / range of post-thickness SSPz FWHM/T</span>
        <strong>${fmt(summary.fwhm.range / result.params.sliceThicknessMm, 4)}</strong>
        <small>${fmt(summary.fwhm.min / result.params.sliceThicknessMm, 3)}–${fmt(summary.fwhm.max / result.params.sliceThicknessMm, 3)}</small>
      </div>`);
  }
  // SSPz-shape evidence is the primary reader-facing result.  The abstract
  // bracket-gap indicator remains available after the profile summaries.
  summaryCards.innerHTML = [...secondaryCards, ...primaryCards].join("");
  resultTable.innerHTML = [
    ["Without cone-geometry scaling (parallel-beam approximation)", result.selectedOff],
    ["With cone-geometry scaling (periodic source-to-point distance)", result.selectedOn],
  ].map(([label, row]) => `<tr><td>${label}</td><td>${fmt(row.fwhm, 3)}</td><td>${fmt(row.fwtm, 3)}</td><td>${fmt(row.sigma, 3)}</td><td>${fmt(row.bracketGapRatioMax, 3)}</td></tr>`).join("");
  const caption = document.querySelector("#result-caption");
  if (caption) caption.textContent = `Results for inspected model state ${selectedStateIndex}/359 (s=${(selectedStateIndex / 360).toFixed(3)})`;
}

function updateProfileModelNote(result) {
  const multiComponent = Math.max(result.selectedOff.halfComponents, result.selectedOn.halfComponents) > 1;
  const modelText = `All primary displays and width metrics are derived from model SSPz curves after applying the configured slice thickness T=${fmt(result.params.sliceThicknessMm, 1)} mm to 360 states within one table feed. Central profiles at or above 10% are shown linearly, and low-amplitude tails at or above 0.1% are shown separately on a log scale. Intermediate SSPz curves and widths before thickness application are excluded from publication figures and width analyses. Only Δz/T, the candidate spacing Δz divided by T, is retained as a supplementary geometric indicator of the computational pathway. FWHM is measured from the post-thickness curve and is not fitted to T.`;
  const topologyText = multiComponent
    ? " Caution: the 50% level is split into multiple components; do not represent the profile by FWHM alone."
    : "";
  profileModelNote.textContent = modelText + topologyText;
}

function renderInspectionDetails(result) {
  const overviewLimit = Math.max(result.diagramOff.overviewXLimit, result.diagramOn.overviewXLimit);
  const zoomLimit = Math.max(result.diagramOff.zoomXLimit, result.diagramOn.zoomXLimit);
  const overviewScope = document.querySelector("#overview-scope");
  const calculationScope = document.querySelector("#calculation-scope");
  overviewScope.textContent = `Automatic range: rotations containing the nearest candidates on the smaller-z and larger-z sides of z₀, plus one adjacent rotation on each side (offsets from the reference rotation ${result.diagramOff.turnOffsetMin} to ${result.diagramOff.turnOffsetMax}; ${result.diagramOff.turnCount} rotations in total)`;
  calculationScope.textContent = `One acquired projection-data series over 0-360°, all ${result.params.rows} rows, and ${result.diagramOff.candidateLineCount} candidate trajectories / linear weights normalized between the two nearest bracketing candidates at each angle`;
  drawDiagram(document.querySelector("#diagram-overview-off"), result.diagramOff, "overview", overviewLimit, zoomLimit);
  drawDiagram(document.querySelector("#diagram-overview-on"), result.diagramOn, "overview", overviewLimit, zoomLimit);
  drawDiagram(document.querySelector("#diagram-zoom-off"), result.diagramOff, "zoom", zoomLimit);
  drawDiagram(document.querySelector("#diagram-zoom-on"), result.diagramOn, "zoom", zoomLimit);
  drawProfiles(document.querySelector("#profile-chart"), result);
  renderSummary(result);
  updateProfileModelNote(result);
  updateInputDecorations();
}

function renderAll(result) {
  renderInspectionDetails(result);
  const layered = result.params.profileMode === PROFILE_MODES.LAYERED_RECT;
  const finalHeading = document.querySelector("#overlay-core-heading");
  const finalDescription = document.querySelector("#overlay-core-description");
  if (finalHeading) finalHeading.textContent = layered
    ? `Primary display: central profiles after applying T=${fmt(result.params.sliceThicknessMm, 1)} mm`
    : "Model SSPz";
  if (finalDescription) finalDescription.textContent = layered
    ? "Linear display at or above 10% for comparison of geometric variation remaining after application of the configured thickness"
    : "Explanatory model SSPz";
  // Core and tail panels have distinct semantic jobs. Each pair shares one
  // symmetric domain between cone-off and cone-on, but a low-amplitude tail is
  // never allowed to compress the linear central-shape view.
  const overlayAxes = configuredOverlayAxes(result);
  drawGapMap(document.querySelector("#gap-map-off"), result, false);
  drawGapMap(document.querySelector("#gap-map-on"), result, true);
  drawProfileOverlay(document.querySelector("#overlay-core-off"), result, false, "core", overlayAxes.core);
  drawProfileOverlay(document.querySelector("#overlay-core-on"), result, true, "core", overlayAxes.core);
  drawProfileOverlay(document.querySelector("#overlay-tail-off"), result, false, "tail", overlayAxes.tail);
  drawProfileOverlay(document.querySelector("#overlay-tail-on"), result, true, "tail", overlayAxes.tail);
  const overlayScope = document.querySelector("#overlay-scope");
  if (overlayScope && result.overlay) {
    overlayScope.textContent = `One table feed divided into ${result.overlay.stateCount} equal states (equivalent to 1°) / each state computed from all ${result.params.viewSamples} views over 0-360°`;
  }
  drawSweep(document.querySelector("#sweep-chart"), result);
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadBlob(filename, content, type = "text/csv;charset=utf-8") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadSweepCsv() {
  if (!lastResult) return;
  const header = ["model_version","scan_angular_range_deg","actual_data_family_count","full_scan_view_samples","profile_mode","candidate_selection_rule","configured_slice_thickness_mm","assumed_slice_kernel_width_mm","model_state_index","model_state_fraction_within_one_table_feed","z0_mm","idealized_source_to_point_distance_scaling","bracket_gap_mean_mm","bracket_gap_max_mm","bracket_gap_ratio_mean","bracket_gap_ratio_max","exact_candidate_fraction","configured_output_fwhm_mm","configured_output_fwtm_mm","configured_output_sigma_mm","coverage","profile_area_mm","centroid_mm","half_height_component_count"];
  const rows = lastResult.sweep.map(row => [MODEL_VERSION,360,1,lastResult.params.viewSamples,lastResult.params.profileMode,lastResult.assumptions.candidateSelectionRule,lastResult.params.sliceThicknessMm,lastResult.assumptions.sliceKernelWidthMm,row.stateIndex,row.state,row.z0,row.coneOn,row.bracketGapMeanMm,row.bracketGapMaxMm,row.bracketGapRatioMean,row.bracketGapRatioMax,row.exactCandidateFraction,row.fwhm,row.fwtm,row.sigma,row.coverage,row.area,row.centroid,row.halfComponents]);
  const csv = [header, ...rows].map(row => row.map(csvEscape).join(",")).join("\n");
  downloadBlob("sspz_full_scan_geometry_state_sweep.csv", `\uFEFF${csv}`);
}

function downloadProfileCsv() {
  if (!lastResult) return;
  const rows = [["z_mm","configured_output_sspz_distance_change_off","configured_output_sspz_distance_change_on"]];
  const length = Math.min(lastResult.selectedOff.z.length, lastResult.selectedOn.z.length);
  for (let i = 0; i < length; i += 1) {
    rows.push([lastResult.selectedOff.z[i],lastResult.selectedOff.profile[i],lastResult.selectedOn.profile[i]]);
  }
  downloadBlob(`sspz_geometry_state_${selectedStateIndex}_profiles.csv`, `\uFEFF${rows.map(row => row.join(",")).join("\n")}`);
}

function publicationWidthMm(canvasId) {
  return canvasId === "profile-chart" || canvasId === "sweep-chart"
    ? PUBLICATION_WIDTH_MM.full
    : PUBLICATION_WIDTH_MM.panel;
}

function publicationPixelWidth(canvasId) {
  return Math.round(publicationWidthMm(canvasId) / 25.4 * PUBLICATION_DPI);
}

function renderCanvasById(canvasId, canvas, result) {
  if (canvasId.startsWith("diagram-")) {
    const overviewLimit = Math.max(result.diagramOff.overviewXLimit, result.diagramOn.overviewXLimit);
    const zoomLimit = Math.max(result.diagramOff.zoomXLimit, result.diagramOn.zoomXLimit);
    const coneOn = canvasId.endsWith("-on");
    const diagram = coneOn ? result.diagramOn : result.diagramOff;
    const mode = canvasId.includes("-overview-") ? "overview" : "zoom";
    drawDiagram(canvas, diagram, mode, mode === "overview" ? overviewLimit : zoomLimit, mode === "overview" ? zoomLimit : null);
    return;
  }
  if (canvasId.startsWith("overlay-")) {
    const [, viewMode, condition] = canvasId.split("-");
    drawProfileOverlay(canvas, result, condition === "on", viewMode, configuredOverlayAxes(result)[viewMode]);
    return;
  }
  if (canvasId.startsWith("gap-map-")) {
    drawGapMap(canvas, result, canvasId.endsWith("-on"));
    return;
  }
  if (canvasId === "profile-chart") {
    drawProfiles(canvas, result);
    return;
  }
  if (canvasId === "sweep-chart") {
    drawSweep(canvas, result);
    return;
  }
  throw new Error(`Unsupported figure ID: ${canvasId}`);
}

function writeUint32BigEndian(bytes, offset, value) {
  const normalized = Number(value) >>> 0;
  bytes[offset] = (normalized >>> 24) & 255;
  bytes[offset + 1] = (normalized >>> 16) & 255;
  bytes[offset + 2] = (normalized >>> 8) & 255;
  bytes[offset + 3] = normalized & 255;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function pngWithResolution(blob, dpi) {
  const source = new Uint8Array(await blob.arrayBuffer());
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (source.length < 33 || !pngSignature.every((value, index) => source[index] === value)) return blob;
  const type = String.fromCharCode(...source.slice(12, 16));
  if (type !== "IHDR") return blob;

  const pixelsPerMeter = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  writeUint32BigEndian(chunk, 0, 9);
  chunk.set([112, 72, 89, 115], 4); // pHYs
  writeUint32BigEndian(chunk, 8, pixelsPerMeter);
  writeUint32BigEndian(chunk, 12, pixelsPerMeter);
  chunk[16] = 1; // unit is metre
  writeUint32BigEndian(chunk, 17, crc32(chunk.slice(4, 17)));

  // The Canvas PNG has IHDR as its first chunk.  Insert pHYs immediately after
  // IHDR so downstream software reads the intended 600-dpi physical size.
  return new Blob([source.slice(0, 33), chunk, source.slice(33)], { type: "image/png" });
}

function publicationFilename(canvasId) {
  let filename = `${canvasId}.png`;
  if (canvasId === "sweep-chart" && lastResult) {
    const metric = selectedMetric(lastResult);
    const thickness = String(Number(lastResult.params.sliceThicknessMm)).replace(".", "p");
    const radius = String(Number(lastResult.params.radius)).replace(".", "p");
    filename = `sweep-configured-thickness-${metric.rawKey}-T${thickness}mm-r${radius}mm.png`;
  } else if (canvasId.startsWith("overlay-") && lastResult) {
    const [, viewMode, condition] = canvasId.split("-");
    const thickness = String(Number(lastResult.params.sliceThicknessMm)).replace(".", "p");
    const radius = String(Number(lastResult.params.radius)).replace(".", "p");
    filename = `sspz-overlay-configured-${viewMode}-T${thickness}mm-r${radius}mm-${condition}-360-relative-states.png`;
  } else if (canvasId.startsWith("gap-map-") && lastResult) {
    const condition = canvasId.endsWith("-on") ? "on" : "off";
    const thickness = String(Number(lastResult.params.sliceThicknessMm)).replace(".", "p");
    const radius = String(Number(lastResult.params.radius)).replace(".", "p");
    filename = `geometry-gap-ratio-T${thickness}mm-r${radius}mm-${condition}.png`;
  } else if (canvasId === "profile-chart" && lastResult) {
    filename = `sspz-detail-state-${selectedStateIndex}-of-360.png`;
  } else if (canvasId.startsWith("diagram-") && lastResult) {
    filename = `${canvasId}-state-${selectedStateIndex}-of-360.png`;
  }
  const widthMm = publicationWidthMm(canvasId);
  return filename.replace(/\.png$/i, `-${widthMm}mm-${PUBLICATION_DPI}dpi.png`);
}

async function downloadCanvas(canvasId) {
  if (!lastResult) return;
  const source = document.getElementById(canvasId);
  const pixelWidth = publicationPixelWidth(canvasId);
  const renderScale = pixelWidth / source.width;
  const target = document.createElement("canvas");
  target.width = pixelWidth;
  target.height = Math.round(source.height * renderScale);
  target.dataset.renderScale = String(renderScale);
  target.dataset.publicationMode = "true";
  renderCanvasById(canvasId, target, lastResult);
  const rawBlob = await new Promise((resolve, reject) => {
    target.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG generation failed.")), "image/png");
  });
  const publicationBlob = await pngWithResolution(rawBlob, PUBLICATION_DPI);
  downloadBlob(publicationFilename(canvasId), publicationBlob, "image/png");
  status.textContent = `Saved a publication PNG at ${publicationWidthMm(canvasId)} mm width and ${PUBLICATION_DPI} dpi (${target.width} x ${target.height} px)`;
}

runButton.addEventListener("click", runSimulation);
cancelButton.addEventListener("click", () => worker?.postMessage({ type: "cancel" }));
resetButton.addEventListener("click", () => {
  selectedStateIndex = 0;
  writeParams(DEFAULT_PARAMS);
  if (metricSelect) metricSelect.value = "fwhm";
  try { localStorage.removeItem("sspz-unwrapped-params"); } catch { /* storage may be disabled */ }
  try { history.replaceState(null, "", window.location.pathname); } catch { /* file:// may restrict history mutation */ }
});
copyLinkButton.addEventListener("click", async () => {
  const url = paramsToUrl(readParams()).toString();
  try { await navigator.clipboard.writeText(url); status.textContent = "Condition URL copied"; }
  catch { window.prompt("Copy this URL", url); }
});
form.addEventListener("input", () => {
  updateInputDecorations();
  if (!runButton.disabled) status.textContent = "Conditions changed. Select Compute to update the results.";
});
inspectState?.addEventListener("input", () => requestStateInspection(Number(inspectState.value)));
inspectPrev?.addEventListener("click", () => requestStateInspection(selectedStateIndex - 1, true));
inspectNext?.addEventListener("click", () => requestStateInspection(selectedStateIndex + 1, true));
function updateSweepDisplay() {
  if (lastResult) drawSweep(document.querySelector("#sweep-chart"), lastResult);
  try { history.replaceState(null, "", paramsToUrl(readParams())); } catch { /* file:// may restrict history mutation */ }
}
metricSelect.addEventListener("change", updateSweepDisplay);
document.querySelectorAll("[data-radius]").forEach(button => button.addEventListener("click", () => {
  form.elements.namedItem("radius").value = button.dataset.radius;
  updateInputDecorations();
  status.textContent = "The transaxial position changed. Select Compute to update the results.";
}));
document.querySelectorAll("[data-canvas]").forEach(button => button.addEventListener("click", () => downloadCanvas(button.dataset.canvas)));
downloadCsvButton.addEventListener("click", downloadSweepCsv);
downloadProfileButton.addEventListener("click", downloadProfileCsv);

const initial = paramsFromUrl() ?? (() => {
  try {
    const stored = JSON.parse(localStorage.getItem("sspz-unwrapped-params")) || DEFAULT_PARAMS;
    if (stored.thetaSamples != null && stored.viewSamples == null) {
      legacyInputMigrated = true;
      stored.viewSamples = stored.thetaSamples;
    }
    if (stored.targetFwhm != null && stored.sliceThicknessMm == null) {
      legacyInputMigrated = true;
      return { ...stored, sliceThicknessMm: stored.targetFwhm };
    }
    return stored;
  }
  catch { return DEFAULT_PARAMS; }
})();
writeParams({ ...DEFAULT_PARAMS, ...initial });
if (legacyUrlNote) {
  legacyUrlNote.hidden = !legacyInputMigrated;
  if (legacyInputMigrated) legacyUrlNote.textContent = "The legacy URL or saved conditions were migrated to the current model. SSPz is recomputed from acquired projection data over 0-360° without reusing results from the former 180° half-scan model; therefore, the results will differ from the former version.";
}
runSimulation();

})();
