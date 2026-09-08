// Explicit compatibility adapter for the archived 2026-08-28 model fixtures.
// These assertions protect the retained historical comparator, NOT the new
// public Taguchi filter-interpolation response. The latter is independently
// checked in taguchi-filter-oracle.mjs.
import { computeLayeredSsp, validateParams } from "../sim-core.js";

export function createLegacyProfileAssumptions(rawParams) {
  const p = validateParams(rawParams);
  return {
    candidateWeightHalfSupportMm: null,
    candidateSelectionRule: "nearest-bracketing",
    geometryIndicator: "final-candidate-weighted-rms-with-row-aperture-over-configured-thickness",
    bracketAuditIndicator: p.reconstructionPath === "fan-beam-180li"
      ? "angularly-weighted-180li-branch-bracketing-gap-over-configured-thickness"
      : "nearest-bracketing-gap-over-configured-thickness",
    sliceKernelWidthMm: p.sliceThicknessMm,
    mapping: "configured-thickness-to-rectangular-kernel",
    reconstructionPath: p.reconstructionPath,
  };
}

export function computeLegacyConfiguredProfile(rawParams, options = {}) {
  const p = validateParams(rawParams);
  return computeLayeredSsp(p, {
    ...options,
    sliceKernelWidthMm: options.assumptions?.sliceKernelWidthMm ?? p.sliceThicknessMm,
  });
}
