import {
  createProfileAssumptions,
  computeProfileModel,
  computeUnwrapped,
  summarizeSweep,
  tableFeedMm,
  validateParams,
} from "./sim-core.js";

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
    if (!activeContext) return self.postMessage({ type: "error", message: "先に全360状態を計算してください。" });
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
    self.postMessage({ type: "progress", value: 0.01, label: "設定スライス厚と仮定重みを適用中" });
    const assumptions = createProfileAssumptions(params);
    if (cancelled) return self.postMessage({ type: "cancelled" });

    self.postMessage({ type: "progress", value: 0.04, label: "0～360°フルスキャンで選択状態のSSPzと展開図を計算中" });
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
            label: `360状態SSPzと幅指標を計算中 ${completed}/${total}`,
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
