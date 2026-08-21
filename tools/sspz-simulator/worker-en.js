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

let cancelled = false;
let activeContext = null;
const yieldToMessages = () => new Promise(resolve => setTimeout(resolve, 0));
const OVERLAY_STATE_COUNT = 360;
const OVERLAY_MAX_Z_POINTS = 1000;

function overlaySampleIndices(length) {
  const count = Math.min(length, OVERLAY_MAX_Z_POINTS);
  if (count === length) return Array.from({ length }, (_, index) => index);
  return Array.from({ length: count }, (_, index) => Math.round(index * (length - 1) / (count - 1)));
}

function createOverlayCondition(stateCount, zCount, angleCount) {
  return {
    coverage: new Float32Array(stateCount),
    base: new Float32Array(stateCount * zCount),
    final: new Float32Array(stateCount * zCount),
    gapRatio: new Float32Array(stateCount * angleCount),
  };
}

function copyOverlayProfile(target, stateIndex, sampleIndices, profile) {
  const offset = stateIndex * sampleIndices.length;
  for (let i = 0; i < sampleIndices.length; i += 1) {
    target[offset + i] = profile[sampleIndices[i]];
  }
}

function copyGeometrySeries(target, stateIndex, sampleIndices, series) {
  const offset = stateIndex * sampleIndices.length;
  for (let i = 0; i < sampleIndices.length; i += 1) {
    target[offset + i] = series[sampleIndices[i]];
  }
}

function summarizeOverlayProfiles(values, coverage, stateCount, zCount) {
  const completeStates = [];
  for (let stateIndex = 0; stateIndex < stateCount; stateIndex += 1) {
    if (coverage[stateIndex] >= 1 - 1e-7) completeStates.push(stateIndex);
  }
  const includedStates = completeStates.length ? completeStates : Array.from({ length: stateCount }, (_, index) => index);
  const maximum = new Float32Array(zCount);
  for (let zIndex = 0; zIndex < zCount; zIndex += 1) {
    let hi = -Infinity;
    for (let i = 0; i < includedStates.length; i += 1) {
      const value = values[includedStates[i] * zCount + zIndex];
      hi = Math.max(hi, value);
    }
    maximum[zIndex] = hi;
  }
  return {
    maximum,
    completeCount: completeStates.length,
    summaryFallbackToAllStates: completeStates.length === 0,
  };
}

function finalizeOverlayCondition(condition, stateCount, zCount) {
  condition.baseSummary = summarizeOverlayProfiles(condition.base, condition.coverage, stateCount, zCount);
  condition.finalSummary = summarizeOverlayProfiles(condition.final, condition.coverage, stateCount, zCount);
  return condition;
}

function overlayTransferList(overlay) {
  const arrays = [overlay.z, overlay.states, overlay.geometryAnglesDeg];
  for (const condition of [overlay.off, overlay.on]) {
    arrays.push(condition.coverage, condition.base, condition.final, condition.gapRatio);
    for (const summary of [condition.baseSummary, condition.finalSummary]) {
      arrays.push(summary.maximum);
    }
  }
  return arrays.map(array => array.buffer);
}

self.onmessage = async event => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelled = true;
    return;
  }
  if (message.type === "inspect-state") {
    if (!activeContext) return self.postMessage({ type: "error", message: "Compute all 360 model states first." });
    try {
      const stateIndex = ((Math.round(Number(message.stateIndex)) % 360) + 360) % 360;
      const state = stateIndex / 360;
      const { params, assumptions, diagramSamples } = activeContext;
      const selectedOff = computeProfileModel(params, { state, coneOn: false, assumptions });
      const selectedOn = computeProfileModel(params, { state, coneOn: true, assumptions });
      const diagramOff = computeUnwrapped(params, { state, coneOn: false, samples: diagramSamples });
      const diagramOn = computeUnwrapped(params, { state, coneOn: true, samples: diagramSamples });
      return self.postMessage({
        type: "inspection-result",
        stateIndex,
        state,
        selectedOff,
        selectedOn,
        diagramOff,
        diagramOn,
      });
    } catch (error) {
      return self.postMessage({ type: "error", message: error?.message ?? String(error), stack: error?.stack ?? "" });
    }
  }
  if (message.type !== "run") return;
  cancelled = false;
  activeContext = null;
  try {
    const params = validateParams(message.params);
    self.postMessage({ type: "progress", value: 0.01, label: "Applying the configured slice thickness and assumed weights" });
    const assumptions = createProfileAssumptions(params);
    if (cancelled) return self.postMessage({ type: "cancelled" });

    self.postMessage({ type: "progress", value: 0.04, label: "Computing the selected-state SSPz and diagram from the 0-360 degree full scan" });
    const selectedOff = computeProfileModel(params, { state: params.state, coneOn: false, assumptions });
    const selectedOn = computeProfileModel(params, { state: params.state, coneOn: true, assumptions });
    const diagramSamples = Math.min(360, params.viewSamples);
    activeContext = { params, assumptions, diagramSamples };
    const diagramOff = computeUnwrapped(params, { state: params.state, coneOn: false, samples: diagramSamples });
    const diagramOn = computeUnwrapped(params, { state: params.state, coneOn: true, samples: diagramSamples });
    if (cancelled) return self.postMessage({ type: "cancelled" });

    const overlayStates = Array.from({ length: OVERLAY_STATE_COUNT }, (_, index) => index / OVERLAY_STATE_COUNT);
    const sweepStates = Array.from({ length: params.stateSamples }, (_, index) => index / params.stateSamples);
    const jobs = new Map();
    const addJob = (state, kind, index) => {
      const key = state.toFixed(12);
      if (!jobs.has(key)) jobs.set(key, { state, sweepIndex: null, overlayIndex: null });
      jobs.get(key)[kind] = index;
    };
    sweepStates.forEach((state, index) => addJob(state, "sweepIndex", index));
    overlayStates.forEach((state, index) => addJob(state, "overlayIndex", index));
    const orderedJobs = [...jobs.values()].sort((a, b) => a.state - b.state);

    const sampleIndices = overlaySampleIndices(selectedOff.z.length);
    const zCount = sampleIndices.length;
    const geometryAngleCount = Math.min(360, params.viewSamples);
    const geometrySampleIndices = Array.from({ length: geometryAngleCount }, (_, index) => (
      Math.floor(index * params.viewSamples / geometryAngleCount)
    ));
    const overlay = {
      stateCount: OVERLAY_STATE_COUNT,
      zCount,
      z: Float32Array.from(sampleIndices, index => selectedOff.z[index]),
      states: Float32Array.from(overlayStates),
      coordinate: "z-minus-z0-native",
      normalization: "each-profile-peak-normalized-to-one",
      stateMeaning: "relative-reconstruction-state-within-one-table-feed-per-rotation",
      acquisitionModel: "actual-data-only-full-scan-0-to-360-degrees",
      fullScanViewSamples: params.viewSamples,
      displayDecimated: zCount < selectedOff.z.length,
      sourceZCount: selectedOff.z.length,
      geometryAngleCount,
      geometryAnglesDeg: Float32Array.from({ length: geometryAngleCount }, (_, index) => 360 * index / geometryAngleCount),
      geometryIndicator: "nearest-bracketing-gap-over-configured-thickness",
      off: createOverlayCondition(OVERLAY_STATE_COUNT, zCount, geometryAngleCount),
      on: createOverlayCondition(OVERLAY_STATE_COUNT, zCount, geometryAngleCount),
    };
    const sweepRows = new Array(params.stateSamples * 2);
    const total = orderedJobs.length * 2;
    let completed = 0;
    let lastYield = performance.now();
    for (const job of orderedJobs) {
      const state = job.state;
      for (const coneOn of [false, true]) {
        const result = computeProfileModel(params, {
          state,
          coneOn,
          assumptions,
          collectGeometrySeries: job.overlayIndex != null,
        });
        if (job.sweepIndex != null) {
          sweepRows[job.sweepIndex * 2 + Number(coneOn)] = {
            stateIndex: job.sweepIndex,
            state,
            z0: result.z0,
            coneOn,
            fwhm: result.fwhm,
            fwtm: result.fwtm,
            sigma: result.sigma,
            coverage: result.coverage,
            area: result.area,
            centroid: result.centroid,
            halfComponents: result.halfComponents,
            baseFwhm: result.baseFwhm,
            baseFwtm: result.baseFwtm,
            baseSigma: result.baseSigma,
            baseCentroid: result.baseCentroid,
            bracketGapMeanMm: result.bracketGapMeanMm,
            bracketGapMaxMm: result.bracketGapMaxMm,
            bracketGapRatioMean: result.bracketGapRatioMean,
            bracketGapRatioMax: result.bracketGapRatioMax,
            exactCandidateFraction: result.exactCandidateFraction,
          };
        }
        if (job.overlayIndex != null) {
          const condition = coneOn ? overlay.on : overlay.off;
          condition.coverage[job.overlayIndex] = result.coverage;
          copyOverlayProfile(condition.final, job.overlayIndex, sampleIndices, result.profile);
          copyOverlayProfile(condition.base, job.overlayIndex, sampleIndices, result.baseProfile ?? result.profile);
          copyGeometrySeries(condition.gapRatio, job.overlayIndex, geometrySampleIndices, result.gapRatios);
        }
        completed += 1;
        if (performance.now() - lastYield >= 25 || completed === total) {
          self.postMessage({
            type: "progress",
            value: 0.08 + 0.90 * completed / total,
            label: `Computing SSPz curves and width metrics for 360 states ${completed}/${total}`,
          });
          await yieldToMessages();
          lastYield = performance.now();
          if (cancelled) return self.postMessage({ type: "cancelled" });
        }
      }
    }
    const sweep = sweepRows;
    finalizeOverlayCondition(overlay.off, OVERLAY_STATE_COUNT, zCount);
    finalizeOverlayCondition(overlay.on, OVERLAY_STATE_COUNT, zCount);
    const summaries = {
      off: summarizeSweep(sweep, false),
      on: summarizeSweep(sweep, true),
    };
    const result = {
      params,
      tableFeed: tableFeedMm(params),
      assumptions,
      selectedOff,
      selectedOn,
      diagramOff,
      diagramOn,
      overlay,
      sweep,
      summaries,
    };
    self.postMessage({
      type: "result",
      result,
    }, overlayTransferList(overlay));
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message ?? String(error), stack: error?.stack ?? "" });
  }
};
