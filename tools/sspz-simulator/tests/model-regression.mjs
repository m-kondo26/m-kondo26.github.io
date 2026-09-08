import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_PARAMS,
  MODEL_VERSION,
  PROFILE_MODES,
  computeFanBeamComplementaryGeometry,
  computeSsp,
  computeUnwrapped,
  validateParams,
} from "../sim-core.js";
// Numeric configured-thickness fixtures below intentionally retain the old
// comparator; the public Taguchi method has its own independent oracle suite.
import {
  createLegacyProfileAssumptions as createProfileAssumptions,
  computeLegacyConfiguredProfile as computeProfileModel,
} from "./legacy-thickness-reference.mjs";

const fixture = JSON.parse(await readFile(new URL("./full-scan-reference.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("../model-manifest.json", import.meta.url), "utf8"));
const coreSource = await readFile(new URL("../sim-core.js", import.meta.url));
const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
const englishIndexSource = await readFile(new URL("../index-en.html", import.meta.url), "utf8");
const englishAppBundle = await readFile(new URL("../app-bundle-en.js", import.meta.url), "utf8");
const englishWorkerSource = await readFile(new URL("../worker-source-en.js", import.meta.url), "utf8");
const englishWorkerModule = await readFile(new URL("../worker-en.js", import.meta.url), "utf8");
const coreHash = createHash("sha256").update(coreSource).digest("hex");
const DIRECT_FULL_SCAN_PATH = "direct-full-scan";
const FAN_BEAM_180LI_PATH = "fan-beam-180li";

assert.equal(fixture.fixture_version, "2026-08-27.5");
assert.equal(fixture.grid_contract.z_samples, "uniform cell centres");
assert.match(fixture.grid_contract.deposition, /rectangular-support overlap/);

function close(label, actual, expected, tolerance) {
  const error = Math.abs(actual - expected);
  assert.ok(error <= tolerance, `${label}: actual=${actual}, expected=${expected}, error=${error}, tolerance=${tolerance}`);
}

function finiteSummary(values, valid = null) {
  let minimum = Infinity;
  let maximum = -Infinity;
  let sum = 0;
  let count = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (valid && !valid[index]) continue;
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    sum += value;
    count += 1;
  }
  return {
    min: count ? minimum : NaN,
    max: count ? maximum : NaN,
    mean: count ? sum / count : NaN,
    count,
  };
}

const params = validateParams(fixture.parameters);
const off = computeSsp(params, {
  state: params.state,
  coneOn: false,
  reconstructionPath: DIRECT_FULL_SCAN_PATH,
});
const on = computeSsp(params, {
  state: params.state,
  coneOn: true,
  reconstructionPath: DIRECT_FULL_SCAN_PATH,
});
for (const [name, actual, expected] of [
  ["coneOff", off, fixture.expected.coneOff],
  ["coneOn", on, fixture.expected.coneOn],
]) {
  close(`${name}.fwhm`, actual.fwhm, expected.fwhm, 0.003);
  close(`${name}.fwtm`, actual.fwtm, expected.fwtm, 0.004);
  close(`${name}.sigma`, actual.sigma, expected.sigma, 0.003);
  close(`${name}.normalizedArea`, actual.area, expected.normalizedArea, 0.003);
  close(`${name}.coverage`, actual.coverage, expected.coverage, 1e-12);
  close(`${name}.centroid`, actual.centroid, expected.centroid, 1e-12);
  close(`${name}.preNormalizationArea.reference`, actual.preNormalizationArea, expected.preNormalizationArea, 2e-12);
  close(`${name}.preNormalizationArea.unit`, actual.preNormalizationArea, 1, 2e-12);
  close(`${name}.depositedArea.unit`, actual.depositedArea, 1, 2e-12);
  close(`${name}.depositionAreaResidual`, actual.depositionAreaResidual, 0, 2e-12);
  close(`${name}.domainClippingAreaResidual`, actual.domainClippingAreaResidual, 0, 2e-12);
  close(`${name}.referenceAnalyticArea`, expected.analyticArea, 1, 2e-12);
  close(`${name}.referenceAnalyticCentroid`, expected.analyticCentroid, 0, 1e-12);
  close(
    `${name}.meanKernelSecondMomentMm2`,
    actual.meanKernelSecondMomentMm2,
    expected.meanKernelSecondMomentMm2,
    2e-12,
  );
  close(`${name}.analyticBaseSigmaMm`, actual.analyticBaseSigmaMm, expected.analyticBaseSigmaMm, 2e-12);
  const gridSpacingMm = actual.z[1] - actual.z[0];
  close(`${name}.gridSpacingMm`, gridSpacingMm, expected.gridSpacingMm, 1e-12);
  close(`${name}.reportedGridSpacingMm`, actual.longitudinalCellWidthMm, expected.gridSpacingMm, 1e-12);
  close(
    `${name}.targetLongitudinalCellWidthMm`,
    actual.targetLongitudinalCellWidthMm,
    expected.targetLongitudinalCellWidthMm,
    1e-15,
  );
  assert.equal(actual.actualZSamples, expected.actualZSamples);
  assert.equal(actual.requestedInternalZCells, expected.requestedInternalZCells);
  assert.equal(actual.internalZCountCapped, expected.internalZCountCapped);
  assert.equal(actual.longitudinalGridInterpretation, "uniform-cell-average-values-reported-at-cell-centers");
  assert.ok(
    Math.abs(actual.centroid) <= gridSpacingMm * 1e-6,
    `${name}.centroid=${actual.centroid} must not retain a half-cell raster offset (dz=${gridSpacingMm})`,
  );
  close(`${name}.bracketGapMeanMm`, actual.bracketGapMeanMm, expected.bracketGapMeanMm, 1e-12);
  close(`${name}.bracketGapMaxMm`, actual.bracketGapMaxMm, expected.bracketGapMaxMm, 1e-12);
  close(`${name}.bracketGapRatioMean`, actual.bracketGapRatioMean, expected.bracketGapRatioMean, 1e-12);
  close(`${name}.bracketGapRatioMax`, actual.bracketGapRatioMax, expected.bracketGapRatioMax, 1e-12);
  assert.equal(actual.halfComponents, expected.halfComponents);
  assert.equal(actual.angularRangeDeg, 360);
  assert.equal(actual.dataKind, "actual-full-scan");
  assert.equal(actual.reconstructionPath, DIRECT_FULL_SCAN_PATH);

  const configured = computeProfileModel(params, {
    state: params.state,
    coneOn: actual.coneOn,
    reconstructionPath: DIRECT_FULL_SCAN_PATH,
  });
  close(`${name}.configured.fwhm`, configured.fwhm, expected.configuredOutput.fwhm, 2e-9);
  close(`${name}.configured.fwtm`, configured.fwtm, expected.configuredOutput.fwtm, 2e-9);
  close(`${name}.configured.sigma`, configured.sigma, expected.configuredOutput.sigma, 2e-9);
  close(`${name}.configured.area`, configured.area, expected.configuredOutput.area, 2e-9);
  close(`${name}.configured.centroid`, configured.centroid, expected.configuredOutput.centroid, 1e-12);
  assert.equal(configured.halfComponents, expected.configuredOutput.halfComponents);
  assert.ok(
    Math.abs(actual.sigma - actual.analyticBaseSigmaMm) <= gridSpacingMm / 2,
    `${name}: sampled base sigma must converge to the analytic rectangle-mixture sigma`,
  );
  assert.ok(
    Math.abs(configured.sigma - expected.analyticConfiguredSigmaMm) <= gridSpacingMm / 2,
    `${name}: configured sigma must converge to analytic variance addition`,
  );
}

// A detector-row aperture much narrower than dz is a decisive regression for
// fractional-cell deposition.  Rounded endpoints collapse both rectangle
// edges to one index and erase the profile; overlap integration must retain
// unit area and the symmetric full-scan centroid.
const extremeNarrowParams = validateParams(fixture.extreme_narrow_case.parameters);
for (const [name, coneOn, expected] of [
  ["extremeNarrow.coneOff", false, fixture.extreme_narrow_case.expected.coneOff],
  ["extremeNarrow.coneOn", true, fixture.extreme_narrow_case.expected.coneOn],
]) {
  const actual = computeSsp(extremeNarrowParams, {
    state: extremeNarrowParams.state,
    coneOn,
    reconstructionPath: DIRECT_FULL_SCAN_PATH,
  });
  const dz = actual.z[1] - actual.z[0];
  assert.ok(extremeNarrowParams.rowWidth < dz / 20, `${name}: aperture must be substantially narrower than dz`);
  assert.ok(actual.preNormalizationPeak > 0, `${name}: narrow aperture must not disappear`);
  close(`${name}.gridSpacingMm`, dz, expected.gridSpacingMm, 1e-12);
  close(`${name}.preNormalizationArea.reference`, actual.preNormalizationArea, expected.preNormalizationArea, 2e-12);
  close(`${name}.preNormalizationArea.unit`, actual.preNormalizationArea, 1, 2e-12);
  close(`${name}.depositedArea.unit`, actual.depositedArea, 1, 2e-12);
  close(`${name}.depositionAreaResidual`, actual.depositionAreaResidual, 0, 2e-12);
  close(`${name}.domainClippingAreaResidual`, actual.domainClippingAreaResidual, 0, 2e-12);
  close(`${name}.centroid`, actual.centroid, expected.centroid, 1e-12);
  close(`${name}.fwhm`, actual.fwhm, expected.fwhm, 2e-6);
  close(`${name}.fwtm`, actual.fwtm, expected.fwtm, 2e-6);
  close(`${name}.sigma`, actual.sigma, expected.sigma, 2e-6);
  close(
    `${name}.meanKernelSecondMomentMm2`,
    actual.meanKernelSecondMomentMm2,
    expected.meanKernelSecondMomentMm2,
    2e-12,
  );
  close(`${name}.analyticBaseSigmaMm`, actual.analyticBaseSigmaMm, expected.analyticBaseSigmaMm, 2e-12);
  assert.equal(actual.actualZSamples, expected.actualZSamples);
  assert.equal(actual.requestedInternalZCells, expected.requestedInternalZCells);
  assert.equal(actual.internalZCountCapped, true);
  assert.equal(actual.coverage, 1);

  const configured = computeProfileModel(extremeNarrowParams, {
    state: extremeNarrowParams.state,
    coneOn,
    reconstructionPath: DIRECT_FULL_SCAN_PATH,
  });
  close(`${name}.configured.fwhm`, configured.fwhm, expected.configuredOutput.fwhm, 2e-9);
  close(`${name}.configured.fwtm`, configured.fwtm, expected.configuredOutput.fwtm, 2e-9);
  close(`${name}.configured.sigma`, configured.sigma, expected.configuredOutput.sigma, 2e-9);
  close(`${name}.configured.area`, configured.area, expected.configuredOutput.area, 2e-9);
  close(`${name}.configured.centroid`, configured.centroid, expected.configuredOutput.centroid, 1e-12);
  assert.ok(Math.abs(actual.sigma - actual.analyticBaseSigmaMm) <= dz / 2);
  assert.ok(Math.abs(configured.sigma - expected.analyticConfiguredSigmaMm) <= dz / 2);
}

assert.throws(() => validateParams({ ...params, radius: params.sourceRadius }), /横断面内位置/);
assert.doesNotThrow(() => validateParams({ ...params, sourceRadius: 600, radius: 250 }));
assert.throws(() => validateParams({ ...params, sourceRadius: 600, radius: 251 }), /0〜250 mm/);
assert.throws(() => validateParams({ ...params, rows: 0 }), /検出器列数/);
assert.throws(() => validateParams({ ...params, sliceThicknessMm: 0 }), /設定スライス厚/);
assert.equal(DEFAULT_PARAMS.radius, 100);
assert.equal(DEFAULT_PARAMS.state, 0);
assert.equal(DEFAULT_PARAMS.zReference, 0);
assert.equal(DEFAULT_PARAMS.stateSamples, 360);
assert.equal(DEFAULT_PARAMS.profileMode, PROFILE_MODES.TAGUCHI_FILTER);
assert.equal(DEFAULT_PARAMS.viewSamples, 360);
assert.equal(validateParams({ ...params, viewSamples: undefined, thetaSamples: 720 }).viewSamples, 720);
assert.equal(MODEL_VERSION, "2026-09-08.1");
if (process.env.SSPZ_SKIP_MANIFEST_INTEGRITY !== "1") {
  assert.equal(manifest.modelVersion, MODEL_VERSION);
  assert.equal(manifest.browserCore.sha256, coreHash);
}
assert.match(indexSource, /id="reconstructionPath"/);
assert.match(indexSource, /180LI取得幾何（主解析）/);
assert.match(indexSource, /0～360°実データ側フルスキャン（比較）/);
assert.match(indexSource, /実測された絶対X線管角度ではありません/);
assert.ok(indexSource.indexOf('id="overlay-core-block"') < indexSource.indexOf('id="candidate-axial-spread-chart"'));
assert.match(indexSource, /3A　フィルタ補間後の360状態SSPz重ね合わせ/);
assert.match(indexSource, /3B　フィルタ補間後の低振幅裾/);
assert.match(indexSource, /id="profileMode"[^>]*value="taguchi-filter"/);
assert.match(indexSource, /id="filterWidthMm"[^>]*min="0"[^>]*max="20"/);
assert.match(indexSource, /id="filterSamples"/);
assert.match(indexSource, /幅指標をTで除すための参照値です/);
assert.match(indexSource, /フィルタ幅FWとは独立で、FWHMの目標値ではありません/);
assert.match(indexSource, /FWと設定厚Tの対応は実機に校正していません/);
assert.match(indexSource, /フィルタ内の各z位置で隣接する取得候補を選び直して線形補間/);
assert.match(indexSource, /幅Tの後段平均ではありません/);
assert.match(indexSource, /厚いスライスの全寄与候補を示すものではありません/);
assert.match(indexSource, /3C　候補点の体軸方向の広がり/);
assert.match(indexSource, /採用・重みづけ前の全候補点を投影角度ごとに比較/);
assert.match(indexSource, /<section class="geometry-analysis" aria-labelledby="gap-analysis-heading">/);
assert.match(indexSource, /id="axial-position-explainer"/);
assert.match(indexSource, /id="acquisition-geometry-3d"/);
assert.match(indexSource, /多列らせん収集の3D幾何と再構成面に最も近い候補点/);
assert.match(indexSource, /再構成面に最も近い候補点を○と△で示します/);
assert.match(indexSource, /候補点の採用や重みは示しません/);
assert.match(indexSource, /評価点を通る体軸線上の列中心位置/);
assert.match(indexSource, /選択中の再構成面 <i>z<\/i><sub>0<\/sub>/);
assert.match(indexSource, /<i>z<\/i><sub>0<\/sub>=<i>z<\/i><sub>ref<\/sub>\+<i>sF<\/i>/);
assert.match(appSource, /x: 0\.78 \* x - 0\.52 \* y,/);
assert.doesNotMatch(appSource, /x: 0\.78 \* x - 0\.52 \* y \+ 0\.30 \* z/);
assert.doesNotMatch(appSource, /drawGeometryMarker\(ctx, targetPoint/);
assert.match(appSource, /candidateMarkerScope = "selected-bracketing-endpoints-only"/);
assert.match(appSource, /candidateMarkerShapes = "direct-circle-complementary-triangle"/);
assert.match(appSource, /targetPointMarker = "none"/);
assert.match(appSource, /selectedUniqueCandidateCount = String\(scene\.selectedCandidates\.length\)/);
assert.match(appSource, /zAxisScreenAlignment = "vertical"/);
assert.match(appSource, /zAxisScreenDxPx = String\(zAxis\.x - origin\.x\)/);
assert.match(appSource, /s=0（現在）  z₀=zref/);
assert.match(appSource, /s=1  zref\+F/);
assert.doesNotMatch(indexSource, /<details class="secondary-analysis">/);
assert.match(indexSource, /同じ実取得ビューが重なる場合は一度だけ含めます/);
assert.match(indexSource, /候補点の採用、補間・再構成重み、設定スライス厚<i>T<\/i>による閾値は適用しません/);
assert.match(indexSource, /id="candidate-axial-spread-chart"/);
assert.match(indexSource, /data-canvas="candidate-axial-spread-chart"/);
assert.doesNotMatch(indexSource, /candidate-count-map|gap-map-(?:off|on)|id="geometryIndicator"/);
assert.doesNotMatch(indexSource, /現在の説明用SSPzの重みへ適用していません/);
for (const id of ["overlay-core-off", "overlay-core-on", "overlay-tail-on"]) {
  assert.ok(indexSource.includes(`id="${id}"`));
}
assert.doesNotMatch(indexSource, /id="overlay-tail-off"/);
assert.doesNotMatch(indexSource, /data-canvas="overlay-tail-off"/);
assert.doesNotMatch(indexSource, /id="overlay-base-/);
assert.doesNotMatch(indexSource, /data-canvas="overlay-base-/);
assert.doesNotMatch(indexSource, /id="sweepStage"/);
assert.doesNotMatch(appSource, /sweepStageSelect/);
assert.match(indexSource, /フィルタ補間後SSPzの1回転内幅変動/);
assert.match(indexSource, /計算モデルの文献的背景/);
for (const doi of [
  "10.1118/1.597199",
  "10.3233/XST-2003-00064",
  "10.1109/42.887832",
  "10.1088/0031-9155/49/13/011",
  "10.1118/1.598230",
  "10.1118/1.598470",
]) {
  assert.ok(indexSource.includes(doi));
  assert.ok(manifest.literatureBackground.some(reference => reference.doi === doi));
}
assert.match(indexSource, /各論文の再構成アルゴリズムを本Web版が再現している、という意味ではありません/);
assert.match(appSource, /フィルタ補間後の幅を参照値Tで除しています/);
assert.match(appSource, /FWはTと独立で、FW=TでもFWHM=Tを保証しません/);
assert.match(appSource, /sweep-taguchi-\$\{metric\.rawKey\}-FW/);
assert.match(appSource, /function drawProfileOverlay/);
assert.match(appSource, /function configuredOverlayAxes/);
assert.match(appSource, /configuredOverlayBounds\(result, 0\.1,/);
assert.match(appSource, /configuredOverlayBounds\(result, 0\.001,/);
assert.doesNotMatch(appSource, /function sharedOverlayXBounds/);
assert.doesNotMatch(appSource, /drawProfileOverlay\([^\n]+"base"/);
assert.doesNotMatch(appSource, /base_fwhm_mm/);
assert.doesNotMatch(appSource, /base_fwtm_mm/);
// Keep the deprecated sampled base-width column out of exports while allowing
// the distinct, analytically conserved `analytic_base_sigma_mm` audit field.
assert.doesNotMatch(appSource, /[,\"]base_sigma_mm(?:[,\"])/);
assert.match(appSource, /function drawCandidateAxialSpreadChart/);
assert.match(appSource, /allCandidateAxialSpreadOffMm/);
assert.match(appSource, /allCandidateAxialSpreadOnMm/);
assert.match(appSource, /candidateSet = "direct-N-rows-plus-all-rows-of-unique-acquired-complementary-views-bracketing-beta-c"/);
assert.match(appSource, /candidateAdoption = "not-applied"/);
assert.match(appSource, /stateInvariant = String\(overlay\.allCandidateAxialSpreadMetadata\?\.stateInvariant \?\? true\)/);
assert.match(appSource, /geometry-all-candidate-axial-spread-N/);
assert.doesNotMatch(appSource, /function drawGapMap|function drawCandidateCountMap|geometryIndicatorSelect|geometryIndicatorMode|candidate-count-map/);
assert.match(appSource, /x: "相対X線管角度  β  \(°\)"/);
assert.match(appSource, /y: "候補位置の体軸方向標準偏差  σz  \(mm\)"/);
assert.match(appSource, /const beta = Number\.isFinite\(betaValues\?\.\[index\]\)/);
assert.match(appSource, /periodicEndpoint = "360-degrees-repeats-first-view-for-line-closure-only"/);
assert.match(appSource, /\$\{lastResult\.params\.viewSamples\}views/);
assert.match(workerSource, /const geometryAngleCount = params\.viewSamples/);
assert.match(workerSource, /geometryAngularSampling: "all-acquired-views-no-decimation"/);
assert.match(workerSource, /computeAllCandidateAxialSpreadSeries/);
assert.equal(
  (workerSource.match(/computeAllCandidateAxialSpreadSeries\(params, \{ coneOn: (?:false|true) \}\)/g) ?? []).length,
  2,
  "The state-invariant all-candidate spread must be computed exactly once for each geometry condition.",
);
assert.match(workerSource, /allCandidateAxialSpreadOffMm: allCandidateAxialSpreadOff\.populationStdMm/);
assert.match(workerSource, /allCandidateAxialSpreadOnMm: allCandidateAxialSpreadOn\.populationStdMm/);
assert.match(workerSource, /allCandidateAxialSpreadMetadata:\s*\{[\s\S]*?unit: "mm"/);
assert.match(workerSource, /allCandidateAxialSpreadMetadata:\s*\{[\s\S]*?weighting: "none"/);
assert.match(workerSource, /allCandidateAxialSpreadMetadata:\s*\{[\s\S]*?sliceThicknessUsed: false/);
assert.match(workerSource, /allCandidateAxialSpreadMetadata:\s*\{[\s\S]*?stateInvariant: true/);
assert.match(workerSource, /allCandidateAxialSpreadMetadata:\s*\{[\s\S]*?candidateSet: "direct-N-rows-plus-all-rows-of-distinct-acquired-complementary-views-bracketing-beta-c"/);
assert.match(workerSource, /allCandidateAxialSpreadMetadata:\s*\{[\s\S]*?candidateIdentity: "absoluteViewIndex,row"/);
assert.match(workerSource, /allCandidateAxialSpreadMetadata:\s*\{[\s\S]*?statistic: "unweighted-population-standard-deviation-of-row-centre-z"/);
assert.match(workerSource, /allCandidateAxialSpreadMetadata:\s*\{[\s\S]*?rowApertureUsed: false/);
assert.match(workerSource, /allCandidateAxialSpreadMetadata:\s*\{[\s\S]*?nearestCandidateSelectionUsed: false/);
assert.match(workerSource, /overlay\.allCandidateAxialSpreadOffMm/);
assert.match(workerSource, /overlay\.allCandidateAxialSpreadOnMm/);
assert.match(workerSource, /nearest-bracketing-gap-over-configured-thickness/);
assert.match(workerSource, /final-candidate-weighted-rms-with-row-aperture-over-configured-thickness/);
assert.match(workerSource, /candidateCount: new Uint16Array/);
assert.match(workerSource, /effectiveCandidateCount: new Float32Array/);
assert.match(workerSource, /candidateContributionCount: new Uint16Array/);
assert.match(workerSource, /unique-physical-final-nonzero-candidate-count-after-angular-branch-duplicate-merging/);
assert.match(appSource, /360-object-states/);
assert.match(appSource, /individualProfileRendering = "one-path-per-state"/);
assert.match(appSource, /const PUBLICATION_DPI = 600/);
assert.match(appSource, /const INK = "#000000"/);
assert.match(appSource, /Publication figures use black tick-label numerals/);
assert.match(appSource, /panel: 80, full: 180/);
assert.match(appSource, /function setFittedFigureFont/);
assert.match(appSource, /setFittedFigureFont\(ctx, labels\.x, style\.axisFontPx, 21, xLabelWidth\)/);
assert.match(appSource, /setFittedFigureFont\(ctx, labels\.y, style\.axisFontPx, 21, innerHeight - 16\)/);
assert.match(appSource, /PROFILE_TAIL_DISPLAY_BOUNDS = Object\.freeze\(\{ yMin: -3\.08, yMax: 0\.08 \}\)/);
assert.match(appSource, /leftMargin: tailView \? 158 : undefined/);
assert.match(appSource, /plot\.ctx\.fillText\(conciseStage, plot\.margin\.left, 8\)/);
assert.match(appSource, /const subtitle = `\$\{conciseCondition\} \/ \$\{filterParameterLabel\(result\.params, result\.selectedOn\.filterSamples\)\}`/);
assert.match(appSource, /setFittedFigureFont\(plot\.ctx, subtitle, 20, 13, plot\.innerWidth\)/);
assert.match(appSource, /plot\.ctx\.fillText\(subtitle, plot\.margin\.left, 38\)/);
assert.doesNotMatch(appSource, /\$\{conciseStage\}／\$\{conciseCondition\}/);
assert.match(appSource, /function pngWithResolution/);
assert.match(appSource, /chunk\.set\(\[112, 72, 89, 115\], 4\)/);
assert.match(appSource, /function symmetricNiceAxis/);
assert.match(appSource, /const factors = \[1, 2, 5, 10\]/);
assert.match(appSource, /const stateTicks = \[0, 0\.2, 0\.4, 0\.6, 0\.8, 1\.0\]/);
assert.match(appSource, /0\.12 \+ 0\.88 \* clipped/);
assert.doesNotMatch(appSource, /Math\.sqrt\(clipped\)/);
assert.doesNotMatch(appSource, /\(degree\)/);
assert.match(indexSource, /最大 Gₑff\/T/);
assert.match(indexSource, /投稿用PNG（600 dpi）/);
assert.match(indexSource, /id="status" role="status" aria-live="polite"/);
assert.match(indexSource, /0～360°実データ側フルスキャン/);
assert.match(indexSource, /各SSPzの基準となる実データ側ビューを0°以上360°未満に等角度配置します/);
assert.doesNotMatch(`${indexSource}\n${appSource}`, /上下候補|上下から挟む|上下の候補|直下・直上/);
assert.match(indexSource, /目的断面のz座標より小さい側と大きい側の最近接2点/);
assert.doesNotMatch(indexSource, /Wang型ハーフスキャン候補幾何/);
assert.doesNotMatch(appSource, /drawWeightedMarker\(ctx, family/);
assert.match(indexSource, /状態の間引きなしで1本ずつ/);
assert.doesNotMatch(indexSource, /中央値/);
assert.doesNotMatch(appSource, /label: "中央値"/);
assert.doesNotMatch(appSource, /summary\.median/);
assert.doesNotMatch(workerSource, /const median/);
assert.doesNotMatch(workerSource, /summary\.median/);
assert.doesNotMatch(indexSource, /最小値―最大値/);
assert.doesNotMatch(appSource, /label: "最小値–最大値"/);
assert.doesNotMatch(appSource, /summary\.minimum/);
assert.doesNotMatch(workerSource, /const minimum/);
assert.doesNotMatch(workerSource, /summary\.minimum/);
assert.doesNotMatch(indexSource, /name="state"/);
assert.doesNotMatch(indexSource, /name="nRot"/);
assert.match(indexSource, /data-radius="250"/);
assert.match(indexSource, /詳細表示するモデル状態/);
assert.match(appSource, /inspect-state/);
assert.doesNotMatch(indexSource, /direct-triangular/);
assert.match(indexSource, /data-language-target="index-en\.html"/);
assert.match(appSource, /setFittedFigureFont\(ctx, weightLabel/);
// Distinct legend rows explain weight, detector-row color, and direct/paired
// encodings. The weight caption describes summed physical-sample coefficients.
assert.match(appSource, /drawDetectorRowLegend\(ctx, diagram, left, y0 \+ 74, width\)/);
assert.match(appSource, /drawDiagramFamilyLegend\(ctx, diagram, left, y0 \+ 104, width\)/);
assert.match(appSource, /濃淡：同じ取得データの寄与を合算　赤線：目的断面/);
assert.match(appSource, /function showCalculatingState/);
assert.match(appSource, /showCalculatingState\(message\.label\)/);
assert.match(appSource, /lastResult = null;[\s\S]*setBusy\(true\);[\s\S]*showCalculatingState\(undefined, true\)/);
assert.match(appSource, /now - lastPlaceholderPaint < 500/);
assert.match(appSource, /canvas\.dataset\.renderState = state/);
assert.match(appSource, /button\.disabled = busy \|\| !lastResult/);

// Japanese and English interfaces must share identical element IDs and the
// same computation source while exposing fully localized static and Canvas text.
assert.match(englishIndexSource, /<html lang="en">/);
assert.match(englishIndexSource, /CT Angular-Longitudinal Diagram and SSPz Geometry Reference/);
assert.match(englishIndexSource, /data-language-target="index\.html"/);
assert.match(englishIndexSource, /worker-source-en\.js/);
assert.match(englishIndexSource, /app-bundle-en\.js/);
assert.match(englishIndexSource, /Adjacent acquired samples are linearly interpolated at each position/);
assert.match(englishIndexSource, /FW is independent of T and is not calibrated to scanner nominal thickness/);
assert.match(englishIndexSource, /moving the reconstruction plane past a fixed thin object/);
assert.match(englishIndexSource, /not all contributors to a thick-slice response/);
assert.match(englishIndexSource, /acquired projection data/);
assert.match(englishIndexSource, /full width at half maximum \(FWHM\)/i);
assert.match(indexSource, /全検出器列を候補とした0～360°展開図/);
assert.match(indexSource, /設定スライス厚<i>T<\/i>で候補を除外しません/);
assert.match(indexSource, /細線は2Aと同じ全検出器列の候補軌道/);
assert.match(appSource, /選択候補の合計重み w \(FW=0\)/);
assert.match(appSource, /全列候補軌道（Tで除外しない）/);
assert.match(appSource, /candidatePopulation = diagram\.candidatePopulation/);
assert.doesNotMatch(appSource, /候補線 \$\{diagram\.candidateLineCount\}本/);
assert.doesNotMatch(appSource, /最近接候補 \$\{diagram\.weightedPoints\.length\}点/);
assert.doesNotMatch(appSource, /計\$\{complementary\.rowCandidatesPerDirectComplementPair\}列候補/);
assert.match(englishIndexSource, /every detector row retained as a candidate/i);
assert.match(englishIndexSource, /does not exclude candidates according to configured slice thickness/i);
assert.match(englishIndexSource, /Thin lines show the same all-row candidate trajectories as in 2A/i);
assert.match(englishAppBundle, /Local total weight w \(FW=0\)/);
assert.match(englishAppBundle, /Fill: summed contributions from the same acquired sample; red: target plane/);
assert.match(englishAppBundle, /All-row candidate trajectories \(not filtered by T\)/);
assert.match(englishWorkerSource, /computing SSPz curves and width metrics for 360 states/i);
assert.match(englishAppBundle, /Calculating…/);
assert.match(englishAppBundle, /Generating figures for the current conditions/);
assert.match(appSource, /fw: params\.filterWidthMm/);
assert.match(appSource, /nf: params\.filterSamples/);
assert.match(appSource, /旧版の計算値を流用せず/);
assert.match(appSource, /filter_width_mm/);
assert.match(appSource, /filter_resampling_count/);
assert.match(appSource, /requested_minimum_filter_resampling_count/);
assert.match(appSource, /canvas\.dataset\.requestedFilterSamples = String\(result\.params\.filterSamples\)/);
assert.match(appSource, /reconstruction-plane-minus-fixed-object-mm/);
for (const id of [
  "parameter-form", "diagram-overview-off", "diagram-overview-on", "diagram-zoom-off", "diagram-zoom-on",
  "complementary-angle-chart", "complementary-distance-chart", "complementary-general-pair-chart",
  "overlay-core-off", "overlay-core-on", "overlay-tail-on", "candidate-axial-spread-chart",
  "axial-position-explainer", "acquisition-geometry-3d",
  "profile-chart", "sweep-chart", "result-table",
  "profileMode", "filterWidthMm", "filterSamples",
]) {
  assert.ok(indexSource.includes(`id="${id}"`));
  assert.ok(englishIndexSource.includes(`id="${id}"`));
}
assert.match(indexSource, /2C　180LIの対応角・絶対ビュー対・二点挟み込み/);
assert.match(indexSource, /β<sub>c<\/sub>=β\+180°\+2γ/);
assert.match(englishIndexSource, /180LI complementary angles, absolute-view pairs, and two-point bracketing/);
assert.match(englishIndexSource, /β<sub>c<\/sub>=β\+180°\+2γ/);
assert.match(englishIndexSource, /Axial spread of candidate points/);
assert.match(englishIndexSource, /All candidate points before selection or weighting, compared by projection angle/);
assert.match(englishIndexSource, /3D geometry of multislice helical acquisition and candidates nearest the reconstruction plane/);
assert.match(englishIndexSource, /Candidate selection and weighting are not shown/);
assert.match(englishIndexSource, /Selected reconstruction plane/);
assert.match(englishIndexSource, /Unweighted longitudinal standard deviation of all candidate detector-row centers/);
assert.doesNotMatch(englishIndexSource, /final contributing candidates K|geometry-display metric selection/i);
assert.doesNotMatch(englishIndexSource, /id="overlay-tail-off"/);
assert.doesNotMatch(englishIndexSource, /data-canvas="overlay-tail-off"/);
const japaneseCharacters = /[ぁ-んァ-ヶ一-龠々〇]/;
for (const [label, source] of [
  ["index-en.html", englishIndexSource],
  ["app-bundle-en.js", englishAppBundle],
  ["worker-source-en.js", englishWorkerSource],
  ["worker-en.js", englishWorkerModule],
]) assert.doesNotMatch(source, japaneseCharacters, `${label} contains untranslated Japanese text`);

const baseInput = {
  ...params,
  reconstructionPath: DIRECT_FULL_SCAN_PATH,
  radius: 102,
  state: 0.5,
  profileMode: PROFILE_MODES.LAYERED_RECT,
  viewSamples: 360,
  zSamples: 800,
  stateSamples: 36,
};
const expectedByThickness = {
  1: {
    off: fixture.expected.coneOff.configuredOutput,
    on: fixture.expected.coneOn.configuredOutput,
  },
  5: {
    off: fixture.five_mm_case.expected.coneOff.configuredOutput,
    on: fixture.five_mm_case.expected.coneOn.configuredOutput,
  },
};

for (const thickness of [1, 5]) {
  const p = validateParams({ ...baseInput, sliceThicknessMm: thickness });
  const assumptions = createProfileAssumptions(p);
  assert.equal(assumptions.candidateWeightHalfSupportMm, null);
  assert.equal(assumptions.candidateSelectionRule, "nearest-bracketing");
  assert.equal(assumptions.geometryIndicator, "final-candidate-weighted-rms-with-row-aperture-over-configured-thickness");
  assert.equal(assumptions.bracketAuditIndicator, "nearest-bracketing-gap-over-configured-thickness");
  assert.equal(assumptions.sliceKernelWidthMm, thickness);
  assert.equal(assumptions.mapping, "configured-thickness-to-rectangular-kernel");
  assert.ok(!("achieved" in assumptions));
  assert.ok(!("calibrated" in assumptions));
  for (const [label, coneOn] of [["off", false], ["on", true]]) {
    const result = computeProfileModel(p, {
      state: 0.5,
      coneOn,
      assumptions,
      reconstructionPath: DIRECT_FULL_SCAN_PATH,
    });
    const expected = expectedByThickness[thickness][label];
    close(`T${thickness}.${label}.fwhm`, result.fwhm, expected.fwhm, 2e-9);
    close(`T${thickness}.${label}.fwtm`, result.fwtm, expected.fwtm, 2e-9);
    close(`T${thickness}.${label}.sigma`, result.sigma, expected.sigma, 2e-9);
    close(`T${thickness}.${label}.area`, result.area, expected.area, 2e-9);
    assert.equal(result.reconstructionPath, DIRECT_FULL_SCAN_PATH);
    assert.equal(result.halfComponents, 1);
    assert.equal(result.coverage, 1);
    assert.equal(result.candidateSelectionRule, "direct-full-scan-nearest-bracketing-linear");
    assert.ok(result.bracketGapRatioMax >= 0);
    assert.ok(Array.isArray(result.baseProfile));
    assert.equal(result.baseProfile.length, result.profile.length);
    assert.ok(result.profile.every(value => value >= 0 && value <= 1 + 1e-12));
  }
}

// Protect the one-way input -> SSPz -> measured width contract.
const oneMmParams = validateParams({ ...baseInput, sliceThicknessMm: 1 });
const oneMmAssumptions = createProfileAssumptions(oneMmParams);
const oneMmResult = computeProfileModel(oneMmParams, {
  state: 0.5,
  coneOn: false,
  assumptions: oneMmAssumptions,
  reconstructionPath: DIRECT_FULL_SCAN_PATH,
});
assert.ok(Math.abs(oneMmResult.fwhm - oneMmParams.sliceThicknessMm) > 0.3);

const sweepRange = (radius, thickness, key) => {
  const p = validateParams({ ...baseInput, radius, sliceThicknessMm: thickness });
  const assumptions = createProfileAssumptions(p);
  const values = Array.from({ length: p.stateSamples }, (_, index) => (
    computeProfileModel(p, {
      state: index / p.stateSamples,
      coneOn: true,
      assumptions,
      reconstructionPath: DIRECT_FULL_SCAN_PATH,
    })[key]
  ));
  return Math.max(...values) - Math.min(...values);
};
close("r102.T1.finalFwhmRange", sweepRange(102, 1, "fwhm"), 0.1182129268, 2e-6);
close("r102.T5.finalFwtmRange", sweepRange(102, 5, "fwtm"), 0.1212719882, 2e-6);
close("r102.T5.finalSigmaRange", sweepRange(102, 5, "sigma"), 0.0112337278, 2e-6);
assert.ok(sweepRange(102, 5, "fwhm") < 5e-5);

// The former modes migrate to the literature-based public filter model.
const migrated = validateParams({ ...baseInput, profileMode: PROFILE_MODES.DIRECT_TRIANGULAR });
assert.equal(migrated.profileMode, PROFILE_MODES.TAGUCHI_FILTER);

const invariantBaseOne = computeProfileModel(
  validateParams({ ...baseInput, sliceThicknessMm: 1 }),
  { state: 0.5, coneOn: true, reconstructionPath: DIRECT_FULL_SCAN_PATH },
);
const invariantBaseFive = computeProfileModel(
  validateParams({ ...baseInput, sliceThicknessMm: 5 }),
  { state: 0.5, coneOn: true, reconstructionPath: DIRECT_FULL_SCAN_PATH },
);
close(
  "configuredThicknessGridConvergenceOfIntermediateFwhm",
  invariantBaseOne.baseFwhm,
  invariantBaseFive.baseFwhm,
  5e-4,
);
assert.notEqual(invariantBaseOne.actualZSamples, invariantBaseFive.actualZSamples);
close("T1.intermediateAreaConservation", invariantBaseOne.preNormalizationArea, 1, 2e-12);
close("T5.intermediateAreaConservation", invariantBaseFive.preNormalizationArea, 1, 2e-12);

const clinicalManyRowParams = validateParams({
  ...baseInput,
  rows: 80,
  rowWidth: 0.5,
  radius: 250,
  stateSamples: 360,
});
const clinicalManyRowAssumptions = createProfileAssumptions(clinicalManyRowParams);
for (let stateIndex = 0; stateIndex < 360; stateIndex += 1) {
  const result = computeProfileModel(clinicalManyRowParams, {
    state: stateIndex / 360,
    coneOn: true,
    assumptions: clinicalManyRowAssumptions,
    reconstructionPath: DIRECT_FULL_SCAN_PATH,
  });
  assert.equal(result.coverage, 1, `80-row state ${stateIndex} must retain full ideal-helix coverage`);
  assert.ok(Number.isFinite(result.baseFwhm), `80-row state ${stateIndex} must have a finite intermediate FWHM`);
}

// Regression for the condition that exposed the public-output mix-up:
// 160 x 0.5 mm, pitch 1.35, configured thickness 1.0 mm. The internal
// pre-thickness response remains near the detector-row width, whereas every
// reader-facing width must be measured from the configured-output response.
const highPitchManyRowParams = validateParams({
  ...baseInput,
  rows: 160,
  rowWidth: 0.5,
  beamPitch: 1.35,
  sourceRadius: 600,
  radius: 0,
  state: 0,
  sliceThicknessMm: 1,
  viewSamples: 1200,
  zSamples: 2000,
  stateSamples: 360,
});
const highPitchManyRowAssumptions = createProfileAssumptions(highPitchManyRowParams);
const highPitchManyRow = computeProfileModel(highPitchManyRowParams, {
  state: 0,
  coneOn: false,
  assumptions: highPitchManyRowAssumptions,
  reconstructionPath: DIRECT_FULL_SCAN_PATH,
});
close("N160.pitch1.35.T1.configuredFwhm", highPitchManyRow.fwhm, 1.0360393597, 2e-6);
close("N160.pitch1.35.T1.configuredFwtm", highPitchManyRow.fwtm, 1.7019993122, 2e-6);
close("N160.pitch1.35.T1.configuredSigma", highPitchManyRow.sigma, 5.9882352198, 2e-6);
close("N160.pitch1.35.T1.internalFwhm", highPitchManyRow.baseFwhm, 0.6376814632, 2e-6);
close("N160.pitch1.35.T1.maximumGapRatio", highPitchManyRow.bracketGapRatioMax, 28.5, 1e-12);
assert.equal(highPitchManyRow.coverage, 1);
assert.ok(highPitchManyRow.fwhm > 0.95 && highPitchManyRow.fwhm < 1.15);
assert.ok(highPitchManyRow.baseFwhm < 0.75);
assert.ok(
  Math.abs(highPitchManyRow.fwhm - highPitchManyRowParams.sliceThicknessMm)
    < Math.abs(highPitchManyRow.baseFwhm - highPitchManyRowParams.sliceThicknessMm),
  "The public configured-output width must not fall back to the internal pre-thickness width",
);

const diagram = computeUnwrapped(params, {
  state: params.state,
  coneOn: true,
  reconstructionPath: DIRECT_FULL_SCAN_PATH,
  candidateWeightHalfSupportMm: params.rowWidth,
  samples: 180,
});
assert.equal(diagram.automaticTurnRange, true);
assert.equal(diagram.turnMax - diagram.turnMin + 1, diagram.turnCount);
assert.equal(diagram.candidateLineCount, diagram.totalRows * diagram.turnCount);
assert.equal(diagram.actualDataFamilyCount, 1);
assert.equal(diagram.angularRangeDeg, 360);
assert.equal(diagram.configuredSliceThicknessMm, params.sliceThicknessMm);
assert.equal(diagram.candidatePopulation, "all-detector-row-centers");
assert.equal(diagram.candidatePoolDefinition, "all-detector-row-centers-in-displayed-acquired-views");
assert.equal(diagram.candidatePoolUsesConfiguredSliceThickness, false);
assert.equal(diagram.sliceThicknessThresholdUsed, false);
assert.equal(diagram.rowTraceWeighting, "none");
assert.equal(diagram.rowsPerAcquiredView, params.rows);
assert.equal(diagram.selectedEndpointStage, "nearest-bracketing-after-all-row-pool");
assert.equal(diagram.doesNotRestrictCandidatePopulation, true);
assert.equal(diagram.candidateWeightHalfSupportMm, null);
assert.equal(diagram.displayedRows, params.rows);
assert.deepEqual(diagram.displayRows, Array.from({ length: params.rows }, (_, row) => row));
assert.ok(!("segments" in diagram));
assert.equal(diagram.traceGeometry.rowOffsets.length, params.rows);
assert.equal(diagram.traceGeometry.turns.length, diagram.turnCount);
assert.ok(diagram.overviewXLimit > diagram.zoomXLimit);
assert.ok(diagram.weightedPoints.length > 0);
assert.ok(diagram.weightedPoints.every(point => point.weight > 0));
assert.ok(diagram.weightedPoints.every(point => point.dataKind === "actual-full-scan"));
assert.ok(diagram.weightedPoints.every(point => !("family" in point)));
assert.ok(diagram.weightedPoints.some(point => point.y < 180));
assert.ok(diagram.weightedPoints.some(point => point.y >= 180));
assert.ok(diagram.weightedPoints.every(point => Math.abs(point.x) <= diagram.zoomXLimit));
assert.ok(diagram.displayRows.includes(0));
assert.ok(diagram.displayRows.includes(params.rows - 1));
assert.equal(diagram.usedTurnsOutsideOverview.length, 0);
assert.equal(diagram.validViewCount, diagram.samples);
assert.ok(diagram.normalizationErrorMax < 1e-12);
assert.ok(Array.from(diagram.viewWeightSums).every(sum => Math.abs(sum - 1) < 1e-7));
assert.ok(Math.abs(diagram.viewWeightSums[diagram.samples / 2 - 1] - diagram.viewWeightSums[diagram.samples / 2]) < 1e-7);

// Configured slice thickness is a downstream SSPz operation.  It must not
// change the all-row trajectories or the explanatory interpolation endpoints
// in either geometry condition.
for (const coneOn of [false, true]) {
  const thinDiagram = computeUnwrapped({ ...params, sliceThicknessMm: 0.5 }, {
    state: params.state,
    coneOn,
    reconstructionPath: FAN_BEAM_180LI_PATH,
    samples: 180,
  });
  const thickDiagram = computeUnwrapped({ ...params, sliceThicknessMm: 5 }, {
    state: params.state,
    coneOn,
    reconstructionPath: FAN_BEAM_180LI_PATH,
    samples: 180,
  });
  assert.deepEqual(thickDiagram.displayRows, thinDiagram.displayRows, `display rows must be T-invariant, cone=${coneOn}`);
  assert.deepEqual(Array.from(thickDiagram.traceGeometry.turns), Array.from(thinDiagram.traceGeometry.turns), `turns must be T-invariant, cone=${coneOn}`);
  assert.deepEqual(Array.from(thickDiagram.traceGeometry.angles), Array.from(thinDiagram.traceGeometry.angles), `angles must be T-invariant, cone=${coneOn}`);
  assert.deepEqual(Array.from(thickDiagram.traceGeometry.axial), Array.from(thinDiagram.traceGeometry.axial), `axial positions must be T-invariant, cone=${coneOn}`);
  assert.deepEqual(Array.from(thickDiagram.traceGeometry.scales), Array.from(thinDiagram.traceGeometry.scales), `distance scales must be T-invariant, cone=${coneOn}`);
  assert.deepEqual(Array.from(thickDiagram.traceGeometry.rowOffsets), Array.from(thinDiagram.traceGeometry.rowOffsets), `row offsets must be T-invariant, cone=${coneOn}`);
  assert.equal(thickDiagram.candidateLineCount, thinDiagram.candidateLineCount, `candidate line count must be T-invariant, cone=${coneOn}`);
  const endpointContract = item => ({
    x: item.x,
    y: item.y,
    weight: item.weight,
    dataKind: item.dataKind,
    row: item.row,
    turn: item.turn,
    sampleIndex: item.sampleIndex,
  });
  assert.deepEqual(
    thickDiagram.weightedPoints.map(endpointContract),
    thinDiagram.weightedPoints.map(endpointContract),
    `selected endpoints must be T-invariant, cone=${coneOn}`,
  );
  assert.equal(thinDiagram.sliceThicknessThresholdUsed, false);
  assert.equal(thickDiagram.sliceThicknessThresholdUsed, false);
}
const halfIndex = diagram.samples / 2;
const axialStepBefore180 = diagram.traceGeometry.axial[halfIndex] - diagram.traceGeometry.axial[halfIndex - 1];
const axialStepAfter180 = diagram.traceGeometry.axial[halfIndex + 1] - diagram.traceGeometry.axial[halfIndex];
close("fullScan.axialContinuityAt180", axialStepBefore180, axialStepAfter180, 1e-12);
assert.ok(Math.abs(diagram.traceGeometry.scales[halfIndex + 1] - diagram.traceGeometry.scales[halfIndex - 1]) < 0.001);
assert.equal(diagram.traceGeometry.angles[0], 0);
assert.equal(diagram.traceGeometry.angles.at(-1), 360);
close("fullScan.periodicAxialShift", diagram.traceGeometry.axial.at(-1) - diagram.traceGeometry.axial[0], 3.5, 1e-12);
close("fullScan.periodicScale", diagram.traceGeometry.scales.at(-1), diagram.traceGeometry.scales[0], 1e-7);
const quarterIndex = diagram.samples / 4;
const threeQuarterIndex = 3 * diagram.samples / 4;
assert.ok(diagram.traceGeometry.scales[0] < diagram.traceGeometry.scales[quarterIndex]);
assert.ok(diagram.traceGeometry.scales[quarterIndex] < diagram.traceGeometry.scales[halfIndex]);
assert.ok(diagram.traceGeometry.scales[halfIndex] > diagram.traceGeometry.scales[threeQuarterIndex]);
assert.ok(diagram.traceGeometry.scales[threeQuarterIndex] > diagram.traceGeometry.scales.at(-1));

// The fan-beam complementary angle is derived from the second intersection of
// the ray through the evaluation point with the source orbit.  At isocenter,
// or when the cone/fan geometry is disabled, the result must reduce to 180°.
const betaQuarterTurn = Math.PI / 2;
const isocenterPair = computeFanBeamComplementaryGeometry({ ...params, radius: 0 }, betaQuarterTurn, { coneOn: true });
close("complementary.isocenterSeparation", isocenterPair.forwardSeparationRad, Math.PI, 1e-12);
close("complementary.isocenterFanAngle", isocenterPair.fanAngleRad, 0, 1e-12);
const parallelPair = computeFanBeamComplementaryGeometry(params, betaQuarterTurn, { coneOn: false });
close("complementary.parallelSeparation", parallelPair.forwardSeparationRad, Math.PI, 1e-12);
const fanPair = computeFanBeamComplementaryGeometry(params, betaQuarterTurn, { coneOn: true });
const expectedFanAngle = Math.atan2(params.radius, params.sourceRadius);
close("complementary.fanAngle", fanPair.fanAngleRad, expectedFanAngle, 1e-12);
close("complementary.fanSeparation", fanPair.forwardSeparationRad, Math.PI + 2 * expectedFanAngle, 1e-12);
assert.ok(fanPair.lineCircleResidualMm < 1e-10);
const inverseFanPair = computeFanBeamComplementaryGeometry(params, fanPair.complementaryAngleRad, { coneOn: true });
const circularError = Math.abs(Math.atan2(
  Math.sin(inverseFanPair.complementaryAngleRad - betaQuarterTurn),
  Math.cos(inverseFanPair.complementaryAngleRad - betaQuarterTurn),
));
assert.ok(circularError < 1e-12, `complementary mapping must be involutive; error=${circularError}`);

// Independent analytic oracle for the fan-beam complementary source angle.
// For an evaluation point at polar angle phase, gamma is defined by the ray
// from the source to that point; the forward complementary separation is
// pi + 2*gamma, wrapped to one positive turn.
const wrapPositiveRad = angle => ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
const oracleParams = validateParams({ ...params, radius: 250, sourceRadius: 600, phase: 0 });
for (let index = 0; index < 360; index += 1) {
  const beta = 2 * Math.PI * index / 360;
  const delta = beta - oracleParams.phase;
  const gammaReference = Math.atan2(
    oracleParams.radius * Math.sin(delta),
    oracleParams.sourceRadius - oracleParams.radius * Math.cos(delta),
  );
  let separationReference = wrapPositiveRad(Math.PI + 2 * gammaReference);
  if (separationReference <= 1e-12) separationReference = 2 * Math.PI;
  const actual = computeFanBeamComplementaryGeometry(oracleParams, beta, { coneOn: true });
  close(`analyticComplement.gamma[${index}]`, actual.fanAngleRad, gammaReference, 2e-12);
  close(`analyticComplement.separation[${index}]`, actual.forwardSeparationRad, separationReference, 2e-12);
  close(
    `analyticComplement.angle[${index}]`,
    actual.complementaryAngleUnwrappedRad,
    beta + separationReference,
    2e-12,
  );
  const mirrorIndex = (360 - index) % 360;
  const mirrorBeta = 2 * Math.PI * mirrorIndex / 360;
  const mirror = computeFanBeamComplementaryGeometry(oracleParams, mirrorBeta, { coneOn: true });
  close(
    `analyticComplement.mirrorSymmetry[${index}]`,
    actual.forwardSeparationRad + mirror.forwardSeparationRad,
    2 * Math.PI,
    3e-12,
  );
}

const complementary = diagram.complementaryCandidates;
assert.equal(complementary.viewCount, params.viewSamples);
assert.equal(complementary.baseAnglesDeg.length, params.viewSamples);
assert.equal(complementary.nearestComplementViewIndices.length, params.viewSamples);
assert.equal(complementary.nearestComplementAbsoluteViewIndices.length, params.viewSamples);
assert.equal(complementary.lowerComplementAbsoluteViewIndices.length, params.viewSamples);
assert.equal(complementary.upperComplementAbsoluteViewIndices.length, params.viewSamples);
assert.equal(complementary.directNearestDistancesMm.length, params.viewSamples);
assert.equal(complementary.complementaryNearestDistancesMm.length, params.viewSamples);
assert.ok(complementary.forwardSeparationRangeDeg.min < 180);
assert.ok(complementary.forwardSeparationRangeDeg.max > 180);
assert.ok(complementary.maximumAngularResidualDeg <= complementary.viewStepDeg / 2 + 1e-6);
assert.ok(complementary.maximumLineCircleResidualMm < 1e-9);
assert.ok(Array.from(complementary.directNearestDistancesMm).every(value => Number.isFinite(value) && value >= 0));
assert.ok(Array.from(complementary.complementaryNearestDistancesMm).every(value => Number.isFinite(value) && value >= 0));
assert.ok(Array.from(complementary.directCandidateCounts).every(value => value >= 1));
assert.ok(Array.from(complementary.complementaryCandidateCounts).every(value => value >= 1));

function verifyAngularAcquisitionBracket(label, candidates) {
  const toleranceDeg = 2e-5;
  for (let index = 0; index < candidates.viewCount; index += 1) {
    const lowerResidual = candidates.lowerAngularResidualsDeg[index];
    const upperResidual = candidates.upperAngularResidualsDeg[index];
    const fraction = candidates.angularInterpolationFractions[index];
    const lowerAngularWeight = 1 - fraction;
    const upperAngularWeight = fraction;
    assert.ok(
      lowerResidual <= toleranceDeg,
      `${label}.angularBracket[${index}] lower acquired view must not follow the ideal angle: ${lowerResidual}`,
    );
    assert.ok(
      upperResidual >= -toleranceDeg,
      `${label}.angularBracket[${index}] upper acquired view must not precede the ideal angle: ${upperResidual}`,
    );
    const bracketWidth = upperResidual - lowerResidual;
    assert.ok(bracketWidth >= -toleranceDeg, `${label}.angularBracket[${index}] has reversed neighbors`);
    assert.ok(
      bracketWidth <= candidates.viewStepDeg + toleranceDeg,
      `${label}.angularBracket[${index}] spans more than one acquired-view step: ${bracketWidth}`,
    );
    assert.ok(fraction >= -1e-6 && fraction <= 1 + 1e-6, `${label}.angularFraction[${index}]=${fraction}`);
    close(
      `${label}.angularWeightSum[${index}]`,
      lowerAngularWeight + upperAngularWeight,
      1,
      1e-12,
    );
    close(
      `${label}.angularInterpolationMoment[${index}]`,
      lowerAngularWeight * lowerResidual + upperAngularWeight * upperResidual,
      0,
      2e-5,
    );
    if (Math.abs(bracketWidth) <= toleranceDeg) {
      close(`${label}.angularFraction.exact[${index}]`, fraction, 0, 1e-6);
    } else {
      close(`${label}.angularFraction[${index}]`, fraction, -lowerResidual / bracketWidth, 2e-6);
    }
    const wrappedViewSpan = (
      candidates.upperComplementViewIndices[index]
      - candidates.lowerComplementViewIndices[index]
      + candidates.viewCount
    ) % candidates.viewCount;
    assert.ok(
      wrappedViewSpan === 0 || wrappedViewSpan === 1,
      `${label}.angularBracket[${index}] must use the same or adjacent acquired views; span=${wrappedViewSpan}`,
    );
    const lowerAbsolute = candidates.lowerComplementAbsoluteViewIndices[index];
    const upperAbsolute = candidates.upperComplementAbsoluteViewIndices[index];
    const nearestAbsolute = candidates.nearestComplementAbsoluteViewIndices[index];
    assert.ok(
      upperAbsolute - lowerAbsolute === 0 || upperAbsolute - lowerAbsolute === 1,
      `${label}.absoluteAngularBracket[${index}] must use the same or adjacent absolute views`,
    );
    assert.ok(
      nearestAbsolute === lowerAbsolute || nearestAbsolute === upperAbsolute,
      `${label}.nearestAbsoluteView[${index}] must be one of the angular bracket endpoints`,
    );
    assert.equal(
      ((nearestAbsolute % candidates.viewCount) + candidates.viewCount) % candidates.viewCount,
      candidates.nearestComplementViewIndices[index],
      `${label}.nearestAbsoluteView[${index}] wrapping`,
    );
    close(
      `${label}.lowerAbsoluteResidual[${index}]`,
      lowerAbsolute * candidates.viewStepDeg - candidates.idealComplementAnglesUnwrappedDeg[index],
      lowerResidual,
      5e-5,
    );
    close(
      `${label}.upperAbsoluteResidual[${index}]`,
      upperAbsolute * candidates.viewStepDeg - candidates.idealComplementAnglesUnwrappedDeg[index],
      upperResidual,
      5e-5,
    );
  }
}

function verifyCrossPairSeries(label, candidates, pairs, { absoluteViewOrder = false } = {}) {
  assert.equal(pairs.validCount, candidates.viewCount, `${label} must retain one valid pair set per acquired view`);
  const pairDefinitions = [
    {
      name: "G1",
      gap: pairs.pairOneGapMm,
      lower: pairs.pairOneLowerSignedDistanceMm,
      upper: pairs.pairOneUpperSignedDistanceMm,
      lowerWeight: pairs.pairOneLowerWeights,
      upperWeight: pairs.pairOneUpperWeights,
    },
    {
      name: "G2",
      gap: pairs.pairTwoGapMm,
      lower: pairs.pairTwoLowerSignedDistanceMm,
      upper: pairs.pairTwoUpperSignedDistanceMm,
      lowerWeight: pairs.pairTwoLowerWeights,
      upperWeight: pairs.pairTwoUpperWeights,
    },
  ];
  for (let index = 0; index < candidates.viewCount; index += 1) {
    assert.equal(pairs.valid[index], 1, `${label}[${index}] must be valid`);
    for (const pair of pairDefinitions) {
      const gap = pair.gap[index];
      const lower = pair.lower[index];
      const upper = pair.upper[index];
      const lowerWeight = pair.lowerWeight[index];
      const upperWeight = pair.upperWeight[index];
      assert.ok(Number.isFinite(gap) && gap >= 0, `${label}.${pair.name}[${index}] gap=${gap}`);
      assert.ok(lower <= 1e-6, `${label}.${pair.name}[${index}] lower=${lower}`);
      assert.ok(upper >= -1e-6, `${label}.${pair.name}[${index}] upper=${upper}`);
      close(`${label}.${pair.name}.gap[${index}]`, gap, upper - lower, 2e-6);
      close(`${label}.${pair.name}.weightSum[${index}]`, lowerWeight + upperWeight, 1, 1e-6);
      close(
        `${label}.${pair.name}.reconstructedTarget[${index}]`,
        lowerWeight * lower + upperWeight * upper,
        0,
        2e-6,
      );
    }
    const expectedSelected = Math.min(pairs.pairOneGapMm[index], pairs.pairTwoGapMm[index]);
    close(`${label}.selectedGap[${index}]`, pairs.selectedGapMm[index], expectedSelected, 2e-6);
    if (Math.abs(pairs.pairOneGapMm[index] - pairs.pairTwoGapMm[index]) > 2e-6) {
      assert.equal(
        pairs.selectedPairIndices[index],
        pairs.pairOneGapMm[index] < pairs.pairTwoGapMm[index] ? 0 : 1,
        `${label}.selectedPair[${index}]`,
      );
    }

    if (absoluteViewOrder) {
      const wrapAbsoluteView = value => ((value % candidates.viewCount) + candidates.viewCount) % candidates.viewCount;
      const pairOneAbsolute = [
        pairs.pairOneLowerAbsoluteViewIndices[index],
        pairs.pairOneUpperAbsoluteViewIndices[index],
      ].sort((a, b) => a - b);
      const pairTwoAbsolute = [
        pairs.pairTwoLowerAbsoluteViewIndices[index],
        pairs.pairTwoUpperAbsoluteViewIndices[index],
      ].sort((a, b) => a - b);
      assert.deepEqual(
        pairOneAbsolute.map(wrapAbsoluteView).sort((a, b) => a - b),
        [index, candidates.nearestComplementViewIndices[index]].sort((a, b) => a - b),
        `${label}.G1[${index}] must use the direct-n/complementary-n absolute-view pair`,
      );
      assert.deepEqual(
        pairTwoAbsolute.map(wrapAbsoluteView).sort((a, b) => a - b),
        [candidates.nearestComplementViewIndices[index], index].sort((a, b) => a - b),
        `${label}.G2[${index}] must use the complementary-n/direct-n-plus-one absolute-view pair`,
      );
      assert.equal(
        wrapAbsoluteView(pairOneAbsolute[0]),
        index,
        `${label}.G1[${index}] acquisition-first endpoint must be direct-n`,
      );
      assert.equal(
        wrapAbsoluteView(pairOneAbsolute[1]),
        candidates.nearestComplementViewIndices[index],
        `${label}.G1[${index}] acquisition-second endpoint must be complementary-n`,
      );
      assert.equal(
        wrapAbsoluteView(pairTwoAbsolute[0]),
        candidates.nearestComplementViewIndices[index],
        `${label}.G2[${index}] acquisition-first endpoint must be complementary-n`,
      );
      assert.equal(
        wrapAbsoluteView(pairTwoAbsolute[1]),
        index,
        `${label}.G2[${index}] acquisition-second endpoint must be direct-n-plus-one`,
      );
      const directToComplementarySpan = pairOneAbsolute[1] - pairOneAbsolute[0];
      const complementaryToNextDirectSpan = pairTwoAbsolute[1] - pairTwoAbsolute[0];
      assert.ok(directToComplementarySpan > 0, `${label}.G1[${index}] must follow D_n -> C_n`);
      assert.ok(complementaryToNextDirectSpan > 0, `${label}.G2[${index}] must follow C_n -> D_(n+1)`);
      assert.equal(
        directToComplementarySpan + complementaryToNextDirectSpan,
        candidates.viewCount,
        `${label}[${index}] must close exactly one full absolute-view turn`,
      );
      assert.equal(
        directToComplementarySpan,
        candidates.nearestComplementAbsoluteViewIndices[index] - index,
        `${label}.G1[${index}] absolute-view advance`,
      );
      assert.equal(
        complementaryToNextDirectSpan,
        index + candidates.viewCount - candidates.nearestComplementAbsoluteViewIndices[index],
        `${label}.G2[${index}] absolute-view advance`,
      );
    }
  }
}

function verifyIntegratedPairSeries(label, candidates, crossPairs, integratedPairs) {
  assert.equal(integratedPairs.validCount, candidates.viewCount, `${label} must retain one valid pair per acquired view`);
  assert.deepEqual(
    integratedPairs.typeLabels,
    ["DD", "DC", "DB", "CD", "CC", "CB", "BD", "BC", "BB", "D0", "C0", "B0"],
  );
  assert.equal(
    Array.from(integratedPairs.typeCounts).reduce((sum, count) => sum + count, 0),
    integratedPairs.validCount,
    `${label} DD/DC/CD/CC counts must account for every valid acquired view`,
  );
  for (let index = 0; index < candidates.viewCount; index += 1) {
    assert.equal(integratedPairs.valid[index], 1, `${label}[${index}] must be valid`);
    const lower = integratedPairs.lowerSignedDistanceMm[index];
    const upper = integratedPairs.upperSignedDistanceMm[index];
    const gap = integratedPairs.gapMm[index];
    const lowerWeight = integratedPairs.lowerWeights[index];
    const upperWeight = integratedPairs.upperWeights[index];
    assert.ok(
      integratedPairs.pairTypeCodes[index] < integratedPairs.typeLabels.length,
      `${label}.typeCode[${index}]`,
    );
    assert.ok(
      integratedPairs.lowerFamilyMasks[index] >= 1 && integratedPairs.lowerFamilyMasks[index] <= 3,
      `${label}.lowerFamilyMask[${index}]`,
    );
    assert.ok(
      integratedPairs.upperFamilyMasks[index] >= 1 && integratedPairs.upperFamilyMasks[index] <= 3,
      `${label}.upperFamilyMask[${index}]`,
    );
    assert.ok(integratedPairs.lowerTieCounts[index] >= 1, `${label}.lowerTieCount[${index}]`);
    assert.ok(integratedPairs.upperTieCounts[index] >= 1, `${label}.upperTieCount[${index}]`);
    assert.ok(lower <= 1e-6, `${label}.lower[${index}]=${lower}`);
    assert.ok(upper >= -1e-6, `${label}.upper[${index}]=${upper}`);
    close(`${label}.gap[${index}]`, gap, upper - lower, 2e-6);
    close(`${label}.weightSum[${index}]`, lowerWeight + upperWeight, 1, 1e-6);
    close(`${label}.reconstructedTarget[${index}]`, lowerWeight * lower + upperWeight * upper, 0, 2e-6);
    assert.ok(
      gap <= crossPairs.pairOneGapMm[index] + 2e-6,
      `${label}[${index}] general pair exceeds G1`,
    );
    assert.ok(
      gap <= crossPairs.pairTwoGapMm[index] + 2e-6,
      `${label}[${index}] general pair exceeds G2`,
    );
  }
}

const coupledGeometryExpected = {
  0: {
    pairOne: [0, 13, 2.725416666666667],
    pairTwo: [0, 13, 2.725416666666667],
    selected: [0, 0.5, 0.49166666666666664],
    integrated: [0, 0.5, 0.49166666666666664],
    nearestTypeCounts: { BB: 1180, B0: 20 },
    idealTypeCounts: { BB: 1180, B0: 20 },
  },
  250: {
    pairOne: [0.016275392845273018, 14.780770301818848, 8.556322842696682],
    pairTwo: [0.016275392845273018, 14.780770301818848, 8.556322842696682],
    selected: [0.016275392845273018, 12.166666984558105, 4.619490819492688],
    integrated: [0.016275392845273018, 0.7083333134651184, 0.5269507314451038],
    nearestTypeCounts: { DD: 537, DC: 189, CD: 189, CC: 285 },
    idealTypeCounts: { DD: 537, DC: 186, CD: 186, CC: 291 },
  },
};

const coupledGeometryResults = {};
for (const radius of [0, 250]) {
  const p = validateParams({
    ...DEFAULT_PARAMS,
    rows: 160,
    rowWidth: 0.5,
    beamPitch: 0.875,
    sourceRadius: 600,
    radius,
    state: 0.5,
    sliceThicknessMm: 1,
    viewSamples: 1200,
    zSamples: 800,
    stateSamples: 360,
    profileMode: PROFILE_MODES.LAYERED_RECT,
  });
  const candidates = computeUnwrapped(p, {
    state: 0.5,
    coneOn: true,
    samples: 90,
  }).complementaryCandidates;
  const expected = coupledGeometryExpected[radius];

  verifyAngularAcquisitionBracket(`coupled.r${radius}`, candidates);
  verifyCrossPairSeries(`coupled.r${radius}.nearest`, candidates, candidates.nearestViewPairs, {
    absoluteViewOrder: true,
  });
  verifyCrossPairSeries(`coupled.r${radius}.ideal`, candidates, candidates.idealAnglePairs);
  verifyCrossPairSeries(`coupled.r${radius}.lowerAngularNeighbor`, candidates, candidates.lowerAngularNeighborPairs);
  verifyCrossPairSeries(`coupled.r${radius}.upperAngularNeighbor`, candidates, candidates.upperAngularNeighborPairs);
  verifyIntegratedPairSeries(
    `coupled.r${radius}.nearestIntegrated`,
    candidates,
    candidates.nearestViewPairs,
    candidates.nearestIntegratedPairs,
  );
  verifyIntegratedPairSeries(
    `coupled.r${radius}.idealIntegrated`,
    candidates,
    candidates.idealAnglePairs,
    candidates.idealIntegratedPairs,
  );
  verifyIntegratedPairSeries(
    `coupled.r${radius}.lowerAngularNeighborIntegrated`,
    candidates,
    candidates.lowerAngularNeighborPairs,
    candidates.lowerAngularNeighborIntegratedPairs,
  );
  verifyIntegratedPairSeries(
    `coupled.r${radius}.upperAngularNeighborIntegrated`,
    candidates,
    candidates.upperAngularNeighborPairs,
    candidates.upperAngularNeighborIntegratedPairs,
  );

  const summaries = {
    pairOne: finiteSummary(candidates.nearestViewPairs.pairOneGapMm, candidates.nearestViewPairs.valid),
    pairTwo: finiteSummary(candidates.nearestViewPairs.pairTwoGapMm, candidates.nearestViewPairs.valid),
    selected: finiteSummary(candidates.nearestViewPairs.selectedGapMm, candidates.nearestViewPairs.valid),
    integrated: finiteSummary(candidates.nearestIntegratedPairs.gapMm, candidates.nearestIntegratedPairs.valid),
  };
  for (const key of ["pairOne", "pairTwo", "selected", "integrated"]) {
    close(`coupled.r${radius}.${key}.min`, summaries[key].min, expected[key][0], 2e-6);
    close(`coupled.r${radius}.${key}.max`, summaries[key].max, expected[key][1], 2e-6);
    close(`coupled.r${radius}.${key}.mean`, summaries[key].mean, expected[key][2], 2e-6);
    assert.equal(summaries[key].count, 1200);
  }
  for (const [seriesLabel, series, expectedCounts] of [
    ["nearest", candidates.nearestIntegratedPairs, expected.nearestTypeCounts],
    ["ideal", candidates.idealIntegratedPairs, expected.idealTypeCounts],
  ]) {
    const actualCounts = Object.fromEntries(series.typeLabels.map((type, index) => [type, series.typeCounts[index]]));
    for (const type of series.typeLabels) {
      assert.equal(
        actualCounts[type],
        expectedCounts[type] ?? 0,
        `coupled.r${radius}.${seriesLabel}.typeCounts.${type}`,
      );
    }
  }
  coupledGeometryResults[radius] = summaries;
}

function verifyFanBeam180LiSspAudit(label, result, p) {
  assert.equal(result.reconstructionPath, FAN_BEAM_180LI_PATH, `${label}.reconstructionPath`);
  assert.match(result.dataKind, /180li/i, `${label}.dataKind=${result.dataKind}`);
  assert.equal(result.viewSamples, p.viewSamples);
  assert.equal(result.complementaryCandidates.viewCount, p.viewSamples);
  for (const [name, values] of [
    ["viewContributionSums", result.viewContributionSums],
    ["angularInterpolationWeightSums", result.angularInterpolationWeightSums],
    ["longitudinalMomentResiduals", result.longitudinalMomentResiduals],
    ["branchGapMmLower", result.branchGapMmLower],
    ["branchGapMmUpper", result.branchGapMmUpper],
  ]) {
    assert.ok(values != null && values.length === p.viewSamples, `${label}.${name} must retain one value per direct view`);
  }

  const candidates = result.complementaryCandidates;
  for (let index = 0; index < p.viewSamples; index += 1) {
    const fraction = candidates.angularInterpolationFractions[index];
    close(`${label}.angularAuditSum[${index}]`, result.angularInterpolationWeightSums[index], 1, 1e-7);
    close(`${label}.viewContributionSum[${index}]`, result.viewContributionSums[index], 1, 1e-7);
    close(`${label}.longitudinalMoment[${index}]`, result.longitudinalMomentResiduals[index], 0, 2e-6);
    assert.ok(fraction >= -1e-6 && fraction <= 1 + 1e-6, `${label}.angularFraction[${index}]`);
    assert.ok(Number.isFinite(result.branchGapMmLower[index]) && result.branchGapMmLower[index] >= 0);
    assert.ok(Number.isFinite(result.branchGapMmUpper[index]) && result.branchGapMmUpper[index] >= 0);
    close(
      `${label}.lowerBranchGap[${index}]`,
      result.branchGapMmLower[index],
      candidates.lowerAngularNeighborIntegratedPairs.gapMm[index],
      2e-6,
    );
    close(
      `${label}.upperBranchGap[${index}]`,
      result.branchGapMmUpper[index],
      candidates.upperAngularNeighborIntegratedPairs.gapMm[index],
      2e-6,
    );
    for (const [branchLabel, branch] of [
      ["lower", candidates.lowerAngularNeighborIntegratedPairs],
      ["upper", candidates.upperAngularNeighborIntegratedPairs],
    ]) {
      assert.equal(branch.valid[index], 1, `${label}.${branchLabel}Branch[${index}]`);
      close(
        `${label}.${branchLabel}ZWeightSum[${index}]`,
        branch.lowerWeights[index] + branch.upperWeights[index],
        1,
        1e-6,
      );
      close(
        `${label}.${branchLabel}ZMoment[${index}]`,
        branch.lowerWeights[index] * branch.lowerSignedDistanceMm[index]
          + branch.upperWeights[index] * branch.upperSignedDistanceMm[index],
        0,
        2e-6,
      );
    }
  }
  close(`${label}.profilePeak`, Math.max(...result.profile), 1, 1e-12);
  assert.ok(result.profile.every(value => Number.isFinite(value) && value >= 0 && value <= 1 + 1e-12));
}

const fanBeamSspAuditParams = validateParams({
  ...DEFAULT_PARAMS,
  rows: 80,
  rowWidth: 0.5,
  beamPitch: 0.875,
  sourceRadius: 600,
  radius: 250,
  state: 0.5,
  sliceThicknessMm: 1,
  viewSamples: 360,
  zSamples: 800,
  stateSamples: 360,
});
const fanBeamSspExplicit = computeSsp(fanBeamSspAuditParams, {
  state: 0.5,
  coneOn: true,
  reconstructionPath: FAN_BEAM_180LI_PATH,
  collectGeometrySeries: true,
});
const fanBeamSspDefault = computeSsp(fanBeamSspAuditParams, {
  state: 0.5,
  coneOn: true,
  collectGeometrySeries: true,
});
const directFullScanComparison = computeSsp(fanBeamSspAuditParams, {
  state: 0.5,
  coneOn: true,
  reconstructionPath: DIRECT_FULL_SCAN_PATH,
  collectGeometrySeries: true,
});
verifyFanBeam180LiSspAudit("ssp180li.explicit", fanBeamSspExplicit, fanBeamSspAuditParams);
verifyFanBeam180LiSspAudit("ssp180li.default", fanBeamSspDefault, fanBeamSspAuditParams);
assert.equal(directFullScanComparison.reconstructionPath, DIRECT_FULL_SCAN_PATH);
assert.notEqual(directFullScanComparison.dataKind, fanBeamSspExplicit.dataKind);
for (const key of ["fwhm", "fwtm", "sigma", "centroid", "coverage"]) {
  close(`ssp180li.defaultMatchesExplicit.${key}`, fanBeamSspDefault[key], fanBeamSspExplicit[key], 1e-12);
}
assert.deepEqual(fanBeamSspDefault.profile, fanBeamSspExplicit.profile);
const pathProfileDifference = fanBeamSspExplicit.profile.length === directFullScanComparison.profile.length
  ? fanBeamSspExplicit.profile.reduce(
    (maximum, value, index) => Math.max(maximum, Math.abs(value - directFullScanComparison.profile[index])),
    0,
  )
  : Infinity;
assert.ok(
  pathProfileDifference > 1e-6,
  `fan-beam 180LI and direct full-scan paths must remain numerically distinguishable; max profile difference=${pathProfileDifference}`,
);

const isocenter180LiParams = validateParams({ ...fanBeamSspAuditParams, radius: 0 });
const isocenter180Li = computeSsp(isocenter180LiParams, {
  state: 0.5,
  coneOn: true,
  reconstructionPath: FAN_BEAM_180LI_PATH,
  collectGeometrySeries: true,
});
verifyFanBeam180LiSspAudit("ssp180li.isocenter", isocenter180Li, isocenter180LiParams);
assert.ok(Array.from(isocenter180Li.complementaryCandidates.forwardSeparationsDeg)
  .every(value => Math.abs(value - 180) < 1e-6));

const periodic180Li = computeSsp(fanBeamSspAuditParams, {
  state: 1.5,
  coneOn: true,
  reconstructionPath: FAN_BEAM_180LI_PATH,
  collectGeometrySeries: true,
});
assert.equal(periodic180Li.state, fanBeamSspExplicit.state);
assert.deepEqual(periodic180Li.z, fanBeamSspExplicit.z);
assert.deepEqual(periodic180Li.profile, fanBeamSspExplicit.profile);
for (const key of ["fwhm", "fwtm", "sigma", "centroid", "coverage"]) {
  close(`ssp180li.oneTurnPeriodicity.${key}`, periodic180Li[key], fanBeamSspExplicit[key], 1e-12);
}

const singleRowOneSided = computeUnwrapped(validateParams({
  ...DEFAULT_PARAMS,
  rows: 1,
  rowWidth: 0.25,
  beamPitch: 0.875,
  sourceRadius: 600,
  radius: 0,
  state: 0.37,
  sliceThicknessMm: 1,
  viewSamples: 360,
  zSamples: 800,
  stateSamples: 360,
}), {
  state: 0.37,
  coneOn: true,
  samples: 90,
}).complementaryCandidates.nearestViewPairs;
let oneSidedValidCount = 0;
for (let index = 0; index < singleRowOneSided.valid.length; index += 1) {
  const pairOneFinite = Number.isFinite(singleRowOneSided.pairOneGapMm[index]);
  const pairTwoFinite = Number.isFinite(singleRowOneSided.pairTwoGapMm[index]);
  if (pairOneFinite !== pairTwoFinite) {
    oneSidedValidCount += 1;
    assert.equal(singleRowOneSided.valid[index], 1, `single-row one-sided pair[${index}] must remain valid`);
    assert.ok(Number.isFinite(singleRowOneSided.selectedGapMm[index]), `single-row selected gap[${index}]`);
  }
}
assert.ok(oneSidedValidCount > 0, "single-row fixture must exercise one valid constrained interval");

const isocenterDiagram = computeUnwrapped({ ...params, radius: 0 }, {
  state: params.state,
  coneOn: true,
  samples: 90,
});
assert.ok(Array.from(isocenterDiagram.complementaryCandidates.forwardSeparationsDeg)
  .every(value => Math.abs(value - 180) < 1e-6));

const manyRows = computeUnwrapped({ ...params, rows: 320, rowWidth: 0.05 }, {
  state: params.state,
  coneOn: false,
  candidateWeightHalfSupportMm: 0.05,
  samples: 90,
});
assert.equal(manyRows.displayedRows, 320);
assert.equal(manyRows.displayRows.length, 320);
assert.deepEqual(manyRows.displayRows, Array.from({ length: 320 }, (_, row) => row));
assert.ok(manyRows.displayRows.includes(0));
assert.ok(manyRows.displayRows.includes(319));
assert.ok(manyRows.weightedPoints.length > 0);
assert.equal(manyRows.candidateLineCount, 320 * manyRows.turnCount);
assert.ok(!("segments" in manyRows));

for (const rowCount of [4, 80, 320]) {
  const allRows = computeUnwrapped({ ...params, rows: rowCount, rowWidth: rowCount === 320 ? 0.05 : 1 }, {
    state: 0,
    coneOn: true,
    candidateWeightHalfSupportMm: rowCount === 320 ? 0.05 : 1,
    samples: 90,
  });
  assert.equal(allRows.displayedRows, rowCount);
  assert.equal(allRows.candidateLineCount, rowCount * allRows.turnCount);
  assert.equal(new Set(allRows.displayRows).size, rowCount);
  assert.ok(allRows.usedTurns.every(offset => offset >= allRows.turnOffsetMin && offset <= allRows.turnOffsetMax));
  assert.equal(allRows.traceGeometry.angles.length, allRows.samples + 1);
  assert.equal(allRows.traceGeometry.axial.length, allRows.samples + 1);
  assert.equal(allRows.traceGeometry.scales.length, allRows.samples + 1);
  assert.ok(!("angleByFamily" in allRows.traceGeometry));
}

// The 3D explanatory figure must mark the same two angular-branch endpoints
// used by the 180LI SSPz model.  For the publication example, four branch
// endpoints reduce to three unique acquired samples because the same direct
// sample participates in both angular branches.
const geometryFigureFixture = computeUnwrapped(validateParams({
  ...DEFAULT_PARAMS,
  rows: 160,
  rowWidth: 0.5,
  beamPitch: 0.875,
  sourceRadius: 600,
  radius: 250,
  zReference: 0,
  state: 0,
  sliceThicknessMm: 1,
  viewSamples: 1200,
  zSamples: 800,
  reconstructionPath: FAN_BEAM_180LI_PATH,
}), {
  state: 0,
  coneOn: true,
  samples: 90,
  reconstructionPath: FAN_BEAM_180LI_PATH,
});
const geometryFigureSeries = geometryFigureFixture.complementaryCandidates;
const geometryFigureTargetAngleDeg = 360 * geometryFigureFixture.z0 / geometryFigureFixture.traceGeometry.feed;
let geometryFigureViewIndex = 0;
let geometryFigureTurnShift = 0;
let geometryFigureBestError = Infinity;
for (let index = 0; index < geometryFigureSeries.viewCount; index += 1) {
  const midpoint = (
    geometryFigureSeries.baseAnglesDeg[index]
    + geometryFigureSeries.idealComplementAnglesUnwrappedDeg[index]
  ) / 2;
  const shift = Math.round((geometryFigureTargetAngleDeg - midpoint) / 360);
  const error = Math.abs(midpoint + shift * 360 - geometryFigureTargetAngleDeg);
  if (error < geometryFigureBestError) {
    geometryFigureBestError = error;
    geometryFigureViewIndex = index;
    geometryFigureTurnShift = shift;
  }
}
assert.equal(geometryFigureViewIndex, 982);
assert.equal(geometryFigureTurnShift, -1);
const geometryFigureBranches = [
  geometryFigureSeries.lowerAngularNeighborIntegratedPairs,
  geometryFigureSeries.upperAngularNeighborIntegratedPairs,
];
const geometryFigureEndpoints = [];
for (const branch of geometryFigureBranches) {
  assert.equal(branch.valid[geometryFigureViewIndex], 1);
  for (const side of ["lower", "upper"]) {
    geometryFigureEndpoints.push({
      side,
      row: branch[`${side}Rows`][geometryFigureViewIndex],
      absoluteViewIndex: branch[`${side}AbsoluteViewIndices`][geometryFigureViewIndex],
      delta: branch[`${side}SignedDistanceMm`][geometryFigureViewIndex],
      familyMask: branch[`${side}FamilyMasks`][geometryFigureViewIndex],
    });
  }
}
assert.equal(geometryFigureEndpoints.length, 4);
for (const [index, endpoint] of geometryFigureEndpoints.entries()) {
  assert.ok(endpoint.familyMask === 1 || endpoint.familyMask === 2, `geometry figure endpoint ${index} family mask`);
  if (endpoint.side === "lower") assert.ok(endpoint.delta <= 1e-9);
  else assert.ok(endpoint.delta >= -1e-9);
}
const geometryFigureUniqueEndpoints = new Map(
  geometryFigureEndpoints.map(endpoint => [`${endpoint.absoluteViewIndex}|${endpoint.row}`, endpoint]),
);
assert.equal(geometryFigureUniqueEndpoints.size, 3);
const geometryFigureExpectedEndpoints = [
  { absoluteViewIndex: -218, row: 107, delta: -0.21466904878616333, familyMask: 1 },
  { absoluteViewIndex: 217, row: 52, delta: 0.18633344769477844, familyMask: 2 },
  { absoluteViewIndex: 218, row: 52, delta: 0.21466904878616333, familyMask: 2 },
];
const geometryFigureObservedEndpoints = [...geometryFigureUniqueEndpoints.values()]
  .sort((a, b) => a.absoluteViewIndex - b.absoluteViewIndex);
for (let index = 0; index < geometryFigureExpectedEndpoints.length; index += 1) {
  const actual = geometryFigureObservedEndpoints[index];
  const expected = geometryFigureExpectedEndpoints[index];
  assert.equal(actual.absoluteViewIndex, expected.absoluteViewIndex);
  assert.equal(actual.row, expected.row);
  assert.equal(actual.familyMask, expected.familyMask);
  close(`geometryFigure.delta[${index}]`, actual.delta, expected.delta, 2e-6);
}
close("geometryFigure.feed", geometryFigureFixture.traceGeometry.feed, 70, 1e-12);
close("geometryFigure.z0", geometryFigureFixture.z0, 0, 1e-12);

// Full-scan integration must converge as the number of actual 0-360 degree
// views increases; this protects against accidentally reverting to a 180-degree
// half-scan with a display-only second half.
const convergence = [];
for (const viewSamples of [360, 720, 1440]) {
  const p = validateParams({ ...baseInput, viewSamples, zSamples: 1600 });
  convergence.push(computeSsp(p, {
    state: 0.5,
    coneOn: true,
    candidateWeightHalfSupportMm: 1,
    reconstructionPath: DIRECT_FULL_SCAN_PATH,
  }));
}
close("convergence.fwhm.720-1440", convergence[1].fwhm, convergence[2].fwhm, 0.002);
close("convergence.fwtm.720-1440", convergence[1].fwtm, convergence[2].fwtm, 0.002);
close("convergence.sigma.720-1440", convergence[1].sigma, convergence[2].sigma, 0.0001);

console.log(JSON.stringify({
  status: "PASS",
  configuredThicknessContract: {
    oneMmOutputFwhm: oneMmResult.fwhm,
    fiveMmFwtmRangeAt102Mm: sweepRange(102, 5, "fwtm"),
    highPitchManyRow: {
      configuredFwhm: highPitchManyRow.fwhm,
      configuredFwtm: highPitchManyRow.fwtm,
      configuredSigma: highPitchManyRow.sigma,
      internalFwhm: highPitchManyRow.baseFwhm,
    },
  },
  nearestBracketingReference: {
    coneOff: { fwhm: off.fwhm, fwtm: off.fwtm, sigma: off.sigma },
    coneOn: { fwhm: on.fwhm, fwtm: on.fwtm, sigma: on.sigma },
  },
  diagramContract: {
    displayedTurns: diagram.turnCount,
    candidateLines: diagram.candidateLineCount,
    weightedPoints: diagram.weightedPoints.length,
  },
  geometryFigureMarkerContract: {
    viewIndex: geometryFigureViewIndex,
    branchEndpointCount: geometryFigureEndpoints.length,
    uniqueCandidateCount: geometryFigureUniqueEndpoints.size,
    feedMm: geometryFigureFixture.traceGeometry.feed,
    z0Mm: geometryFigureFixture.z0,
  },
  absoluteViewCoupledGeometry: coupledGeometryResults,
  fanBeam180LiSspContract: {
    defaultPath: fanBeamSspDefault.reconstructionPath,
    explicitPath: fanBeamSspExplicit.reconstructionPath,
    directComparisonPath: directFullScanComparison.reconstructionPath,
    pathProfileDifference,
    fwhm: fanBeamSspExplicit.fwhm,
    fwtm: fanBeamSspExplicit.fwtm,
    sigma: fanBeamSspExplicit.sigma,
  },
}, null, 2));
