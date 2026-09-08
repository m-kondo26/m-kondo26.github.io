// Independent reference for Taguchi & Aradate (1998), Eq. (6), Fig. 5/6.
// This deliberately does NOT call any production geometry, interpolation,
// aperture, normalization, quadrature, or width-measurement helper.
// Passing this test verifies the declared reduced model, not a CT vendor's
// reconstruction, fan-beam FBP, finite-bead response, or experimental validity.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as production from "../sim-core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUTPUT = path.join(ROOT, "output", "taguchi-validation-20260908");
const TWO_PI = 2 * Math.PI;
const Z_TOL = 1e-10;
const RAW_TOL = 2e-8;
const sourcePdfFileName = "07_Taguchi_Aradate_1998_Algorithm_for_image_reconstruction_in_multislice_helical_CT.pdf";
const sourcePdfReferenceSha256 = "1df2f58c64eabc35d8acfecde9dc0fe72e41e68fc7ca37d44a79846b618c1248";
const sha256 = filename => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
// The numerical oracle is standalone. The reviewed, copyrighted PDF is not
// distributed and is not required to run it. An optional local copy can be
// fingerprinted without retaining its private directory in the output report.
const sourcePdfEnvironmentPath = process.env.SSPZ_TAGUCHI_SOURCE_PDF;
const sourcePdfVerification = { optional: true, environmentVariable: "SSPZ_TAGUCHI_SOURCE_PDF",
  status: "not-provided", note: "The reference SHA256 identifies the reviewed copy; no PDF was checked during this run." };
if (sourcePdfEnvironmentPath !== undefined) {
  let actualSha256;
  try {
    actualSha256 = sha256(sourcePdfEnvironmentPath);
  } catch {
    throw new Error("SSPZ_TAGUCHI_SOURCE_PDF was set, but the specified PDF could not be read. Numerical tests were not run.");
  }
  assert.equal(actualSha256, sourcePdfReferenceSha256,
    "SSPZ_TAGUCHI_SOURCE_PDF does not match the reviewed reference copy; this fingerprint check does not assess other legitimate PDF editions.");
  Object.assign(sourcePdfVerification, { status: "reference-hash-match", actualSha256,
    fileName: path.basename(sourcePdfEnvironmentPath),
    note: "The optional local PDF matches the reviewed-copy fingerprint; no private directory is recorded." });
}

function close(actual, expected, tolerance, label) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${label}: nonfinite ${actual}, ${expected}`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: actual=${actual}, expected=${expected}, error=${Math.abs(actual - expected)}, tolerance=${tolerance}`);
}

// An infinitesimally thin, fixed object integrated by a unit-area rectangular
// detector aperture. Half height at the boundary is the symmetric thin-object
// limit; it prevents counting two touching apertures as two complete responses.
function apertureResponse(center, aperture, objectZ) {
  const edgeDistance = Math.abs(center - objectZ) - aperture / 2;
  if (Math.abs(edgeDistance) <= Z_TOL) return 0.5 / aperture;
  return edgeDistance < 0 ? 1 / aperture : 0;
}

// Analytic fan-angle relation, independent of production's line/circle solve.
function angularBranches(p, viewIndex, coneOn) {
  const beta = TWO_PI * viewIndex / p.viewSamples;
  const gamma = !coneOn ? 0 : Math.atan2(
    p.radius * Math.sin(beta - p.phase),
    p.sourceRadius - p.radius * Math.cos(beta - p.phase),
  );
  const idealComplement = beta + Math.PI + 2 * gamma;
  const coordinate = idealComplement / TWO_PI * p.viewSamples;
  const nearest = Math.round(coordinate);
  if (Math.abs(coordinate - nearest) <= 1e-10) {
    return [{ complementaryIndex: nearest, weight: 1 }];
  }
  const lower = Math.floor(coordinate);
  const fraction = coordinate - lower;
  return [
    { complementaryIndex: lower, weight: 1 - fraction },
    { complementaryIndex: lower + 1, weight: fraction },
  ];
}

function enumerateFamily(p, absoluteBaseIndex, coneOn, objectZ, queryBound) {
  const feed = p.rows * p.rowWidth * p.beamPitch;
  const beta = TWO_PI * absoluteBaseIndex / p.viewSamples;
  const q = coneOn ? Math.hypot(
    p.sourceRadius * Math.cos(beta) - p.radius * Math.cos(p.phase),
    p.sourceRadius * Math.sin(beta) - p.radius * Math.sin(p.phase),
  ) / p.sourceRadius : 1;
  const aperture = p.rowWidth * q;
  // Exhaustive finite superset. The extra turns guarantee zero-valued knots
  // outside every requested point and both FW edges; no nearest-row shortcut.
  const turns = Math.ceil((Math.abs(objectZ) + queryBound
    + p.rows * aperture + 2 * feed) / feed) + 3;
  const points = [];
  for (let turn = -turns; turn <= turns; turn += 1) {
    for (let row = 0; row < p.rows; row += 1) {
      const center = feed * (absoluteBaseIndex / p.viewSamples + turn)
        + (row + 0.5 - p.rows / 2) * aperture;
      points.push({ z: center, y: apertureResponse(center, aperture, objectZ) });
    }
  }
  return points;
}

function mergeEqualPositions(points) {
  const sorted = [...points].sort((a, b) => a.z - b.z);
  const knots = [];
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    let sum = sorted[start].y;
    while (end < sorted.length && Math.abs(sorted[end].z - sorted[start].z) <= Z_TOL) {
      sum += sorted[end].y;
      end += 1;
    }
    knots.push({ z: sorted[start].z, y: sum / (end - start) });
    start = end;
  }
  return knots;
}

function interpolate(knots, z) {
  let low = 0;
  let high = knots.length - 1;
  assert.ok(z >= knots[low].z - Z_TOL && z <= knots[high].z + Z_TOL,
    "oracle enumeration did not cover requested coordinate");
  while (high - low > 1) {
    const middle = (high + low) >> 1;
    if (knots[middle].z <= z) low = middle;
    else high = middle;
  }
  if (Math.abs(z - knots[low].z) <= Z_TOL) return knots[low].y;
  if (Math.abs(z - knots[high].z) <= Z_TOL) return knots[high].y;
  const fraction = (z - knots[low].z) / (knots[high].z - knots[low].z);
  return knots[low].y * (1 - fraction) + knots[high].y * fraction;
}

// Literal Eq. (6): each resampling position uses its own adjacent knots.
// There is intentionally no convolution of a fixed-plane sensitivity kernel.
function resampledFilter(knots, z, width, samples) {
  if (width === 0) return interpolate(knots, z);
  const halfCount = (samples - 1) / 2;
  let sum = 0;
  for (let i = -halfCount; i <= halfCount; i += 1) {
    sum += interpolate(knots, z + i * width / samples);
  }
  return sum / samples;
}

// Independent continuum check corresponding to the Appendix: integrate each
// linear segment exactly, clipping it at the two FW edges. This is not used
// to validate finite-K equality; it is a convergence reference only.
function exactRectangularFilter(knots, z, width) {
  if (width === 0) return interpolate(knots, z);
  const left = z - width / 2;
  const right = z + width / 2;
  let area = 0;
  for (let i = 0; i < knots.length - 1; i += 1) {
    const a = Math.max(left, knots[i].z);
    const b = Math.min(right, knots[i + 1].z);
    if (!(b > a)) continue;
    const slope = (knots[i + 1].y - knots[i].y) / (knots[i + 1].z - knots[i].z);
    const ya = knots[i].y + slope * (a - knots[i].z);
    const yb = knots[i].y + slope * (b - knots[i].z);
    area += (ya + yb) * (b - a) / 2;
  }
  return area / width;
}

function prepareOracle(p, state, coneOn, queryBound = 40) {
  const feed = p.rows * p.rowWidth * p.beamPitch;
  const objectZ = p.zReference + (((state % 1) + 1) % 1) * feed;
  const views = [];
  for (let view = 0; view < p.viewSamples; view += 1) {
    const direct = enumerateFamily(p, view, coneOn, objectZ, queryBound);
    views.push(angularBranches(p, view, coneOn).map(branch => ({
      weight: branch.weight,
      knots: mergeEqualPositions([
        ...direct,
        ...enumerateFamily(p, branch.complementaryIndex, coneOn, objectZ, queryBound),
      ]),
    })));
  }
  return { objectZ, views };
}

function rawAt(oracle, relativeZ, width, samples, exact = false) {
  let sum = 0;
  for (const branches of oracle.views) {
    for (const branch of branches) {
      const value = exact
        ? exactRectangularFilter(branch.knots, oracle.objectZ + relativeZ, width)
        : resampledFilter(branch.knots, oracle.objectZ + relativeZ, width, samples);
      sum += branch.weight * value;
    }
  }
  return sum / oracle.views.length;
}

function maximum(values) {
  let peak = -Infinity;
  for (const value of values) peak = Math.max(peak, value);
  return peak;
}

function selectedIndices(result) {
  const indices = new Set([0, result.z.length - 1, (result.z.length - 1) >> 1]);
  const desired = [-9, -6, -4, -3, -2.7, -2.3, -1.75, -1.2, -0.85, -0.5,
    -0.2, -0.015, 0, 0.015, 0.2, 0.5, 0.85, 1.2, 1.75, 2.3, 2.7, 3, 4, 6, 9];
  const dz = result.z[1] - result.z[0];
  for (const value of desired) {
    const index = Math.round((value - result.z[0]) / dz);
    if (index >= 0 && index < result.z.length) indices.add(index);
  }
  let peakIndex = 0;
  for (let i = 0; i < result.rawProfile.length; i += 1) {
    if (result.rawProfile[i] > result.rawProfile[peakIndex]) peakIndex = i;
  }
  for (const offset of [-2, -1, 0, 1, 2]) {
    if (peakIndex + offset >= 0 && peakIndex + offset < result.z.length) indices.add(peakIndex + offset);
  }
  return [...indices].sort((a, b) => a - b);
}

const baseParams = {
  rows: 4, rowWidth: 1, beamPitch: 0.875, sourceRadius: 600, radius: 102,
  zReference: 0, state: 0, sliceThicknessMm: 1, profileMode: "taguchi-filter",
  reconstructionPath: "fan-beam-180li", viewSamples: 90, zSamples: 300,
  stateSamples: 12, phase: 0,
};

const report = {
  generatedAt: new Date().toISOString(),
  source: {
    title: "Algorithm for image reconstruction in multi-slice helical CT",
    authors: "Taguchi and Aradate", year: 1998, doi: "10.1118/1.598230",
    inspected: "Eq. (6), Fig. 5/6 (p. 554); Appendix A1-A10 (pp. 560-561)",
    pdf: sourcePdfFileName, sha256: sourcePdfReferenceSha256,
    pdfVerification: sourcePdfVerification,
  },
  scope: "Independent implementation verification of declared fixed-thin-object longitudinal reduced model; not a scanner, finite-bead, full-FBP, or experimental validation.",
  conventions: {
    object: "fixed zReference + state * tableFeed; reconstruction plane moves",
    rowResponse: "unit-area top-hat, half-height at exact aperture boundary",
    ties: "average raw amplitudes at coincident longitudinal knots",
    normalization: "after all view and angular/filter sums, not per view or resampling position",
    finiteFilterNodes: "i*FW/K, i=-(K-1)/2..(K-1)/2; Eq. (6)",
    continuumReference: "exact clipped trapezoidal integration of independently enumerated linear segments",
  },
  coreSha256: sha256(path.join(ROOT, "sim-core.js")),
  fixtures: [], convergence: [], checks: [],
};

// Analytic boundary and tie checks on the independent building blocks.
close(apertureResponse(0.5, 1, 0), 0.5, 0, "touching upper aperture");
close(apertureResponse(-0.5, 1, 0), 0.5, 0, "touching lower aperture");
close(apertureResponse(0.499, 1, 0), 1, 0, "interior aperture");
close(apertureResponse(0.501, 1, 0), 0, 0, "outside aperture");
assert.deepEqual(mergeEqualPositions([{ z: 0, y: 1 }, { z: 0, y: 3 }]), [{ z: 0, y: 2 }]);
const triangle = [{ z: -2, y: 0 }, { z: -1, y: 0 }, { z: 0, y: 1 }, { z: 1, y: 0 }, { z: 2, y: 0 }];
close(exactRectangularFilter(triangle, 0, 2), 0.5, 1e-15, "triangle integral");
close(resampledFilter(triangle, 0.3, 0, 129), 0.7, 1e-15, "FW zero collapses to linear interpolation");
close(resampledFilter(triangle, 0.3, 2, 1), 0.7, 1e-15, "Eq6 K1 has only central resampling point");
report.checks.push("analytic aperture boundaries, coincident knots, zero-FW and one-node limits");

if (!process.argv.includes("--oracle-only")) {
  assert.equal(typeof production.computeProfileModel, "function");
  const fixtures = [
    ...[0, 102].flatMap(radius => [0, 1, 5].map(filterWidthMm => ({
      label: `r${radius}-FW${filterWidthMm}`, radius, filterWidthMm, filterSamples: 129,
      state: radius === 0 ? 0 : 0.371, coneOn: true,
    }))),
    { label: "coincident-rows-pitch0.5", radius: 0, beamPitch: 0.5, state: 0,
      filterWidthMm: 1, filterSamples: 33, coneOn: true },
    { label: "aperture-boundary-and-fw0", radius: 0, state: 0,
      filterWidthMm: 0, filterSamples: 33, coneOn: false },
    { label: "offcenter-phase-and-fw-not-T", radius: 102, state: 0.125, phase: 0.27,
      sliceThicknessMm: 5, filterWidthMm: 1, filterSamples: 65, coneOn: true },
  ];
  for (const fixture of fixtures) {
    const p = { ...baseParams, ...fixture };
    const result = production.computeProfileModel(p, { state: p.state, coneOn: p.coneOn });
    assert.equal(result.profileMode, "taguchi-filter", `${fixture.label}: not new model`);
    assert.ok(result.rawProfile?.length === result.z.length, `${fixture.label}: rawProfile required`);
    assert.ok(result.rawBaseProfile?.length === result.z.length, `${fixture.label}: rawBaseProfile required`);
    const queryBound = Math.max(Math.abs(result.z[0]), Math.abs(result.z.at(-1))) + p.filterWidthMm / 2 + 2;
    const oracle = prepareOracle(p, p.state, p.coneOn, queryBound);
    let maximumRawError = 0;
    let maximumBaseError = 0;
    const indices = selectedIndices(result);
    for (const index of indices) {
      const expected = rawAt(oracle, result.z[index], p.filterWidthMm, p.filterSamples);
      const expectedBase = rawAt(oracle, result.z[index], 0, 1);
      maximumRawError = Math.max(maximumRawError, Math.abs(result.rawProfile[index] - expected));
      maximumBaseError = Math.max(maximumBaseError, Math.abs(result.rawBaseProfile[index] - expectedBase));
      close(result.rawProfile[index], expected, RAW_TOL, `${fixture.label}.raw[${index}]`);
      close(result.rawBaseProfile[index], expectedBase, RAW_TOL, `${fixture.label}.base[${index}]`);
    }
    const peak = maximum(result.rawProfile);
    close(maximum(result.profile), 1, 2e-12, `${fixture.label}.normalizedPeak`);
    for (let i = 0; i < result.z.length; i += 1) {
      close(result.profile[i], result.rawProfile[i] / peak, 2e-12, `${fixture.label}.globalNormalization[${i}]`);
    }
    report.fixtures.push({ label: fixture.label, radius: p.radius, pitch: p.beamPitch,
      state: p.state, filterWidthMm: p.filterWidthMm, filterSamples: p.filterSamples,
      configuredThicknessMm: p.sliceThicknessMm, testedGridPoints: indices.length,
      totalGridPoints: result.z.length, maximumRawError, maximumBaseError,
      fwhm: result.fwhm, fwtm: result.fwtm, preNormalizationPeak: peak });
  }
  report.checks.push("raw fixed-object response agrees with independently enumerated Eq6 oracle before normalization");
  report.checks.push("global peak normalization occurs only after view, angular-branch and filter sums");

  // FW controls filtering, while T remains a reporting/reference thickness.
  const independentWidth = { ...baseParams, filterWidthMm: 1, filterSamples: 65, state: 0.371 };
  const t1 = production.computeProfileModel(independentWidth, { coneOn: true });
  const t5 = production.computeProfileModel({ ...independentWidth, sliceThicknessMm: 5 }, { coneOn: true });
  assert.deepEqual(t1.z, t5.z, "T changes must not change fixed-FW profile grid");
  assert.deepEqual(t1.rawProfile, t5.rawProfile, "T changes must not change fixed-FW raw response");
  assert.deepEqual(t1.profile, t5.profile, "T changes must not change fixed-FW normalized response");
  report.checks.push("T1 versus T5 gives identical grids/raw/normalized responses when FW remains 1 mm");

  const centerParams = { ...independentWidth, radius: 0 };
  const centerOn = production.computeProfileModel(centerParams, { coneOn: true });
  const centerOff = production.computeProfileModel(centerParams, { coneOn: false });
  assert.deepEqual(centerOn.z, centerOff.z, "isocenter grid");
  for (let i = 0; i < centerOn.z.length; i += 1) {
    close(centerOn.rawProfile[i], centerOff.rawProfile[i], RAW_TOL, `isocenter cone reduction[${i}]`);
  }
  report.checks.push("isocenter cone-on reduces to cone-off reference");

  // Public requested K is now a minimum, guarded by FW/K <= d*(1-r/R)/8.
  // Test both successful increase and explicit rejection above the hard cap;
  // a silently under-resolved comb-like profile is not an acceptable fallback.
  const guardedParams = { ...baseParams, rowWidth: 0.5, radius: 250,
    filterWidthMm: 20, filterSamples: 33, state: 0.125 };
  const guarded = production.computeProfileModel(guardedParams, { coneOn: true });
  assert.ok(guarded.filterSamples > guardedParams.filterSamples, "public K must increase for wide FW");
  assert.equal(guarded.requestedFilterSamples, guardedParams.filterSamples);
  assert.equal(guarded.filterSamplesAdjustedForAccuracy, true);
  assert.equal(guarded.filterSamples % 2, 1, "accuracy-adjusted K must remain odd");
  assert.ok(guardedParams.filterWidthMm / guarded.filterSamples
    <= guardedParams.rowWidth * (1 - guardedParams.radius / guardedParams.sourceRadius) / 8 + 1e-12);
  const literalGuarded = production.computeTaguchiSsp({ ...guardedParams,
    filterSamples: guarded.filterSamples }, { coneOn: true });
  assert.deepEqual(guarded.rawProfile, literalGuarded.rawProfile,
    "public adaptive call must equal literal Eq6 at the disclosed actual K");
  assert.throws(() => production.computeProfileModel({ ...guardedParams, rowWidth: 0.1 },
    { coneOn: true }), /2049|精度|accuracy|precision/i);
  report.publicAccuracyGuard = {
    requestedK: guarded.requestedFilterSamples, actualK: guarded.filterSamples,
    requiredK: guarded.accuracyRequiredFilterSamples,
    wideFilterWidthMm: guardedParams.filterWidthMm, rowWidthMm: guardedParams.rowWidth,
    veryNarrowRowsAboveCap: "explicit error verified",
  };
  report.checks.push("public K minimum auto-increases with disclosed actual K and rejects unresolved cases above 2049");

  // Finite Eq6 versus exact linear-segment integral: no artificial demand for
  // strictly monotonic errors when a knot crosses a changing quadrature grid.
  for (const filterWidthMm of [1, 5]) {
    const p = { ...baseParams, state: 0.371, filterWidthMm };
    const oracle = prepareOracle(p, p.state, true);
    const queryZ = [-3.1, -2.3, -1.7, -1.1, -0.6, -0.2, 0, 0.17, 0.55, 1.05, 1.65, 2.35, 3.05];
    const continuum = queryZ.map(z => rawAt(oracle, z, filterWidthMm, 1, true));
    const steps = [];
    for (const filterSamples of [33, 65, 129, 257, 513]) {
      // Literal-K API is essential here: the public API may increase requested
      // K for accuracy, which would invalidate a fixed-K convergence series.
      const result = production.computeTaguchiSsp({ ...p, filterSamples }, { coneOn: true });
      const indices = selectedIndices(result);
      let productionError = 0;
      for (const index of indices) {
        const expected = rawAt(oracle, result.z[index], filterWidthMm, filterSamples);
        productionError = Math.max(productionError, Math.abs(result.rawProfile[index] - expected));
        close(result.rawProfile[index], expected, RAW_TOL,
          `FW${filterWidthMm}.K${filterSamples}.finiteEq6[${index}]`);
      }
      const errors = queryZ.map((z, i) => Math.abs(rawAt(oracle, z, filterWidthMm, filterSamples) - continuum[i]));
      steps.push({ filterSamples, maximumContinuumError: maximum(errors),
        meanContinuumError: errors.reduce((a, b) => a + b, 0) / errors.length,
        maximumProductionOracleError: productionError, fwhm: result.fwhm, fwtm: result.fwtm });
    }
    assert.ok(steps.at(-1).maximumContinuumError < steps[0].maximumContinuumError,
      `FW${filterWidthMm}: 513-node error must improve over 33-node error`);
    assert.ok(steps.at(-1).maximumContinuumError < 2e-5,
      `FW${filterWidthMm}: 513-node maximum error exceeds absolute 2e-5 response units`);
    report.convergence.push({ filterWidthMm, independentQueryCount: queryZ.length, steps });
  }
  report.checks.push("33/65/129/257/513 nodes agree with literal finite Eq6 and converge toward exact segment integration");
}

report.status = "PASS";
report.oracleOnly = process.argv.includes("--oracle-only");
fs.mkdirSync(OUTPUT, { recursive: true });
const filename = path.join(OUTPUT, report.oracleOnly ? "independent-oracle-selftest.json" : "independent-oracle-results.json");
fs.writeFileSync(filename, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: report.status, oracleOnly: report.oracleOnly,
  fixtures: report.fixtures.length, convergenceCases: report.convergence.length,
  checks: report.checks, output: filename }, null, 2));
