## 2026-09-14: integrated 3D FBP path

The live application now offers the original axial model and a separate calculation path for full-turn helical FDK with cylindrical detector acquisition. Both are integrated in the same public UI and worker bundle. See [FDK_METHOD.md](FDK_METHOD.md) and [tests/fdk-verification.json](tests/fdk-verification.json). The numerical checks cover 80, 160 and 320 rows; they do not establish scanner-specific or exact wide-cone validity. Excel, CSV, 600-dpi PNG and first-angle 3D volume JSON are available.

The stationary-table geometry changes already present in the local source are included; pitch 0 produces diagrams without helical interpolation in the axial path, and circular FDK in the 3D path. The manifest identifies the current source hash using UTF-8/LF normalization so Windows checkout line endings do not invalidate public-source verification. The older hashes and verification statements below describe their dated revisions, not this release.

# Reproducibility record

## SSPz profile display contract: 2026-09-08.1

The selected-state and all-360-state SSPz painters now share `strokeNativeProfile`. Every original calculated z coordinate and value is passed directly to a Canvas move/line path, including nonuniform spacing and sharp sampled peaks. There is no display resampling, spline, smoothing, or within-profile/state decimation. The existing log-tail cutoff remains 0.001; samples below it break a path, and retained samples are joined in log10 coordinates. The Japanese/English screen and 600 dpi export paths use these same painters. Canvas metadata records `profileDisplayVersion`, `profileInterpolation`, `profileSpline`, `profileSmoothing`, `profileDecimation`, and the native point count. The independent diagram display version remains `2026-09-08.3`.

This is a display refactor and explicit contract, not a change to model calculation, normalization, FWHM/FWTM, alignment, filtering, state count, or axis/cutoff rules. The numerical model remains `2026-09-08.1`; `sim-core.js` SHA256 remains `27a6e7f48a562050992108af95e21ed5af70b4919a2604c769862d2a92e09a5e` and `worker.js` SHA256 remains `4bc7e71b7a78a846cfc86071e2f73a8f8e0ff3cc950aec3ab4a8e12917ea7052`. The profile-rendering test executes the real application painters and checks every coordinate of a nonuniform grid with a narrow peak, all 360 profiles, screen/publication paths, tail gaps, and negative controls for point deletion and curved Canvas commands. These are display and numerical non-regression checks, not scanner-specific physical validation.

## Display-only update: 2026-09-08.3

Detector-row numbers are no longer drawn on trajectories, at any row count. The compact detector-row color legend and the axes remain visible in both languages and in screen/publication output. Only the inline-number painter and its explanatory wording were removed; trajectories, physical marker identity, summed coefficients, color mapping, opacity, stroke width and canvas dimensions are unchanged.

The numerical model remains `2026-09-08.1`; `sim-core.js` SHA256 remains `27a6e7f48a562050992108af95e21ed5af70b4919a2604c769862d2a92e09a5e`. `tests/diagram-marker-identity.mjs` now additionally executes 24 display cases: 4/160/320 rows, both geometry conditions, screen/publication, and overview/zoom. Each case requires zero inline labels, retained axes and legend calls, the same physical marker count, and unchanged numerical diagram fields. The existing weight, shape, color, trajectory-opacity and negative-control checks remain in place. This does not alter the response calculation or establish scanner-specific validity.

## Historical display-only update: 2026-09-08.2

Section 2B now sums angular-branch contributions for each `(referenceViewIndex, absoluteViewIndex, row)` before drawing one opaque marker. This corrects the former overpainting of branch coefficients. The input contributions and numerical SSPz are unchanged. Coordinate coincidence alone never merges different acquired samples. A dual-role acquired sample retains both roles and is drawn as a triangle with a small circle inside.

Detector-row hue stays fixed along each trajectory. An added row-color legend and inline row numbers for sparse detectors help distinguish crossing lines. Trajectories alone use multiply blending; both opacity and stroke width decrease with the square root of detector-row density (with a minimum stroke width), balancing legibility against dark saturation. Blended line colors indicate overlap, not a new row or a weight. Marker fill continues to encode the summed coefficient of the same acquired sample at the central local FW=0 diagnostic plane, not the complete thick-slice filter contribution.

The numerical model remains `2026-09-08.1`; `sim-core.js` SHA256 remains `27a6e7f48a562050992108af95e21ed5af70b4919a2604c769862d2a92e09a5e`. The ninth suite, `tests/diagram-marker-identity.mjs`, independently checks sample identity, conservation of weights, unchanged inputs, collocated distinct samples, dual-role samples, actual Canvas marker colors and shapes, and an old-renderer negative control. Screen and publication use the same drawing functions. This display update does not revise manuscripts or establish commercial-scanner validation.

## Current scientific contract: Taguchi-filter revision, 2026-09-08

This revision changes the thick-slice SSPz model and its response definition. It retains the all-row acquisition-geometry equations and the corrected complementary-trajectory display. The new default is `profileMode=taguchi-filter`; no numerical result from the former fixed-plane kernel plus width-T post-average is reused as a new-model result.

Primary source: Taguchi K, Aradate H. Algorithm for image reconstruction in multi-slice helical CT. Medical Physics. 1998;25:550–561. DOI: [10.1118/1.598230](https://doi.org/10.1118/1.598230), Eq. (6), Figs. 5 and 6. Only the longitudinal filter-interpolation construction is implemented, not the entire original image reconstruction or optimized-pitch selection.

### Response definition

For each state, a thin object at `z_object=zReference+sF` remains fixed. Its acquired samples are modeled using the declared ideal row apertures. The reconstruction plane moves through `z_r`, and the SSPz coordinate is `z_r-z_object`. The 360 states use `s=j/360` and change object position within one table feed `F=pNd`. This is neither 360 separate scans nor a fixed-reconstruction-plane object-displacement kernel. Each curve is peak-normalized without additional peak, centroid, or half-height alignment.

For `K=2I+1`, the finite filter positions are:

```
z_f(i) = z_r + i FW/K,  i = -I,...,I
P(z_r) = sum_i P_local(z_f(i)) / K
```

At every `z_f`, adjacent acquired candidates are reselected. This is essential when acquisition geometry and interpolation weights vary with reconstruction-plane position. Each angularly compatible direct/complementary branch is locally linearly interpolated and the angular branches are combined by their declared linear fraction. The rectangular filter averages those values. An acquired sample outside FW may contribute if it brackets a resampling position inside FW. FW is not a candidate-exclusion threshold.

The implementation combines the local piecewise-linear moving-plane responses by linearity before evaluating the finite shifted sum. It does not replace the finite sum by a continuous boxcar convolution, and it does not convolve the former fixed-plane candidate kernel.

### Parameters and numerical accuracy

- `filterWidthMm` (URL `fw`): FW, from 0 to 20 mm. FW=0 selects the unfiltered moving-plane response.
- `filterSamples` (URL `nf`): requested minimum odd K, from 33 to 2049; default 129.
- The public calculation increases K until `FW/K <= rowWidth*(1-radius/sourceRadius)/8`, using one conservative cone-condition-independent bound. If the required odd K exceeds 2049, calculation stops with a precision-limit error and does not publish an under-resolved result.
- Literal finite-K Eq. (6) evaluation remains available to numerical tests. The automatic lower bound is an implementation accuracy guard, not a new physical weighting law or proof of convergence.
- `sliceThicknessMm` (URL `st`): reference thickness T for width/T ratios. It does not broaden the response or serve as a fitted target FWHM.
- Missing legacy FW is initialized numerically to T with a visible uncalibrated-migration note. FW and T remain independent; FW=T does not guarantee FWHM=T.
- Shared URLs use v7 and preserve FW, requested minimum K, T, geometry path, and state. PNG captions/files record actual K, FW, and T. CSV additionally records requested minimum K and the response coordinate.

The computed longitudinal grid is retained for every displayed/exported SSPz: no former 1000-point within-profile decimation. All 360 curves are retained. Peak normalization is distinct from evaluation of unnormalized response. Display domains use the >=10% central shape and >=0.1% cone-on log tails, with separate domains by role. These are display thresholds, not physical absence below the threshold or a calculation cutoff.

### Geometry and diagnostics remain separate

All detector rows remain in acquisition-geometry displays; T does not exclude candidates. The cone-off reference uses `q=1`, `gamma=0`, and a 180-degree complementary angle. Cone-on uses `beta_c=beta+180 degrees+2gamma` and each acquired family's own row scaling. Complementary trajectories retain absolute acquired-view provenance and are plotted on a common direct-data reference-angle axis.

Section 2B endpoints and weights, Section 2C pair spans/gaps, and the state-table `G_eff/T` audit refer to local FW=0 interpolation at the selected central position. They are not the entire set of thick-filter contributors. The 3D reference plane passes through the object position selected for SSPz and remains a geometric locator.

The unweighted all-row axial-spread curve is unchanged: it includes all rows in the direct acquired view and each distinct acquired angular neighbor of the ideal complementary angle. It does not use T, FW, row-aperture variance, interpolation weights, or nearest-candidate selection.

### Required independent verification and interpretation limits

The current acceptance checks must cover:

1. A direct per-view/per-plane/per-filter-position implementation of the finite Eq. (6) sum against the optimized response.
2. FW=0; changing reference T alone leaves the unnormalized and normalized response unchanged.
3. One-table-feed periodicity; cone-off/on equality at isocenter; symmetric and shifted response cases.
4. FW and K sensitivity and convergence, with actual K reported.
5. Acquisition geometry and its row/angle provenance remain unchanged, independently of SSPz response changes.
6. Japanese/English controls, URL migration, loading state, complete output grids, and legible publication exports.

Tests of the former fixed-plane candidate kernel remain explicitly marked legacy diagnostics. Its `sigma_configured^2=mean(M2)+T^2/12` identity does not validate the new moving-plane response. Old fixture PASS status is historical and model-specific. A numerical implementation PASS establishes agreement with declared equations, not physical reproduction of a commercial scanner.

The model excludes complete filtered backprojection, scanner-specific channel interpolation and redundancy weights, cone-beam backprojection, finite bead diameter, noise, and proprietary T-to-filter calibration. Comparison with bead-derived measured SSPz therefore requires matching measurement definitions and discussing the missing finite-bead response. If FW is selected using measurements, those calibration data cannot also serve as independent validation.

## Current verification results

Verified locally on 2026-09-08 with numerical model `2026-09-08.1`, core SHA256 `27a6e7f48a562050992108af95e21ed5af70b4919a2604c769862d2a92e09a5e`. The complete seven-suite `npm test` passed, including the new independent Taguchi oracle. Historical browser records below are provenance only; they do not certify this revision.

- Independent raw-response comparison: nine fixtures, maximum absolute difference `2.3887e-15`. The oracle independently enumerates detector rows, turns, angular neighbors, aperture responses, and the finite filter sum; it does not call production interpolation or geometry helpers.
- Literal K=33/65/129/257/513 checks passed for FW=1 and 5 mm. Against independent exact continuous segment integration, the K=513 maximum sampled raw differences were `1.04e-6` and `5.46e-6`, respectively. This finite set is convergence evidence, not a universal error bound.
- With FW=1 mm held fixed, changing reference T from 1 to 5 mm leaves the full grid and raw/normalized responses identical. Isocenter equality and zero-FW checks passed.
- Public accuracy guard: the independent test confirmed requested K=33 becomes K=549 for FW=20 mm, d=0.5 mm, r=250 mm, R=600 mm. Conditions requiring K>2049 explicitly fail rather than display an under-resolved SSPz.
- A separate old/new comparison recalculated 360 states for each of four FW/geometry combinations (1440 new profiles). The four all-row geometry comparisons against the unchanged public-release checkout were identical, including 160 rows at r=250 mm. See `output/taguchi-validation-20260908/study-comparison.json` and its CSV.

The N=4, d=1 mm, p=0.875, R=600 mm, r=102 mm, 720-view, requested-4000-z-point study comparison used FW=T only as an explicitly uncalibrated comparison setting:

| Cone-on condition | New FWHM across 360 states (mm) | New FWTM across 360 states (mm) |
| --- | --- | --- |
| FW=1 mm, T=1 mm | 1.15254–1.30695 | 1.97117–2.25847 |
| FW=5 mm, T=5 mm | 4.99978–5.00000 | 5.91599–6.12902 |

Thus the corrected broad rectangular filter still produces FWHM very close to FW. Its tiny finite-K width variation is not evidence of measured scanner variability. This revision corrects the response definition and published interpolation construction; it does not establish agreement with measured 5-mm SSPz.

Browser QA used the local HTTP server, current standalone bundles, and real Chromium at 1440x1000 and 390x844 pixels. Japanese and English controls were visually inspected; page horizontal overflow was zero in both mobile checks. Long canvases retain their existing internally scrollable chart containers. Language switching preserves fw/nf/T. A legacy v6 URL without fw/nf migrated to v7, FW=T as an uncalibrated initial value, minimum K=129, and a visible migration explanation. Initial calculation and recalculation replace old figures by loading placeholders and disable exports; cancellation leaves a cancelled placeholder with exports disabled.

For the 4-row FW=5-mm case, three 80-mm SSPz panel exports and one 180-mm selected-profile export were captured in each language under `output/playwright/taguchi-ja/` and `taguchi-en/`. Inspected titles, parameter captions, axes, and legends were legible without observed clipping. Additional English 160-row, d=0.5-mm, r=250-mm, FW=5-mm, 1200-view checks completed in 10.7 seconds in the tested environment; requested K=33 was increased to K=139 and correctly disclosed in canvas metadata and PNG filenames/captions. The all-row overview and filtered SSPz export were visually inspected. A d=0.1-mm/FW=20-mm browser check reported required K=2743, showed an English precision-limit error, and disabled output. This is an explicit implementation limit, not physical absence of data.

PNG binary checks confirmed the eight bilingual SSPz exports have the expected 1890x1365 or 4252x2303 dimensions, pHYs=23622 pixels/m (approximately 600 dpi), and valid chunk CRCs. The Japanese profile CSV retains all 4001 grid points. Against current Node-core recomputation, all z and cone-off values are exactly equal; the largest cone-on difference is `8.88e-16`, below the separately declared `32*Number.EPSILON` export tolerance. This is not a bitwise-equality claim. Metadata/CSV checks are reproducible with `node scripts/validate-taguchi-exports.mjs`; see `output/taguchi-validation-20260908/export-validation.json`.

The GitHub Pages checkout and manuscripts were not changed in this implementation turn. Local HTTP QA is not a claim of public deployment or a new direct-file-protocol browser test.

## Historical browser verification (pre-Taguchi builds)

### Display revision 2026-09-07.1 (historical numerical model)

Both languages were verified using the loopback HTTP preview at a 1800 x 1100 desktop viewport with `N=160`, `d=0.5 mm`, `p=0.875`, `R=600 mm`, `r=250 mm`, `T=1 mm`, `s=0`, `1200` acquired views, and the primary 180LI path. All four Section 2 canvases rendered with direct, complementary-lower, and complementary-upper trajectory families on the common direct-data angle axis. Each family retains 1201 reference samples. Legend explanations were moved outside the data rectangle. The final cone-on overview and zoom exports in both languages were visually inspected without observed legend, title, or axis clipping.

The eight final PNGs under `output/playwright/opposing-ja-160row-final/` and `output/playwright/opposing-en-160row-final/` have `1890 x 1470` pixels and `pHYs=23622` pixels/m in both directions. At a 390 x 844 viewport in both languages, page-level horizontal overflow was zero; the 620-pixel diagram canvas remains intentionally horizontally scrollable inside its chart card and its right edge was verified reachable. This is not a claim that the full plot fits simultaneously on a narrow screen. Direct `file://` navigation was blocked by the CLI browser in this turn, so the current browser checks used HTTP and do not repeat the historical file-protocol verification.

The final `npm test` passed all six suites. `tests/unwrapped-complementary-trajectories.mjs` checks 24 diagrams, 36,048 family-grid points, and 2,958 markers, with a maximum marker-to-trajectory error of `2.842170943040401e-14 mm`. Forty-eight complete SSPz profiles, z arrays, and public metrics match the pre-fix fingerprints exactly. These tests establish the display-coordinate and numerical non-regression contracts, not scanner-specific physical validity. Numerical model version 2026-08-28.2 is unchanged. See `design-qa.md` for the completed scope and remaining model limits.

### Historical verification before the complementary-trajectory display correction

The earlier Version 2026-08-28.2 unwrapped-diagram appearance was checked in direct `file://` sessions for both Japanese `index.html` and English `index-en.html` at a 1800-pixel-wide desktop viewport. The checked condition was `N=160`, row width `0.5 mm`, beam pitch `0.875`, source-to-isocenter distance `R=600 mm`, radial position `r=250 mm`, configured slice thickness `T=1.0 mm`, `1200` acquired views, and the primary 180LI path. These earlier appearance checks did not detect the complementary-marker/direct-only-trajectory mismatch and do not validate the corrected display contract above.

The current desktop verification established:

- all four Section 2 canvases (2A/2B, no-cone/cone-geometry-scaled) were non-empty after calculation;
- neither language produced page-level horizontal overflow at the checked 1800-pixel viewport;
- the 2A all-row candidate-pool legend, 2B selected-endpoint weight legend, axes, and in-plot annotations were visually inspected in both languages without observed overlap or clipping;
- the publication diagrams were re-rendered at `1890 x 1470` pixels;
- the publication PNGs contained `pHYs=23622` pixels/m in both directions, equivalent to approximately 600 dpi;
- the publication legends, axes, and annotations were visually inspected without observed clipping.

This verification statement is intentionally limited to the checked desktop and publication-export scope.

Rendered QA images are kept locally under `output/playwright/` and are intentionally excluded from the public repository by `.gitignore`. The complete 2026-08-21 full-scan page is recorded as `full-scan-default-20260821.png`. The dense all-row overview is recorded as `full-scan-80rows-r250-overview-20260821.png`, and its 600-dpi publication export as `full-scan-80rows-r250-overview-publication-20260821.png`. The N=160, row-width=0.5 mm, beam-pitch=1.35, T=1.0 mm regression view is recorded as `n160-p1p35-T1-configured-core-off.png`. Low-amplitude-tail QA is performed only for the retained cone-geometry-scaled panel.

Versions 2026-08-27.1 through 2026-08-27.4 are superseded geometry or rasterization builds and do not validate the fractional-overlap SSPz and all-contribution moment contract retained by versions 2026-08-27.5 through 2026-08-27.7. Version 2026-08-27.5 is additionally superseded for Section 3C because it decimated acquired-view angles for display. Versions 2026-08-27.6 and 2026-08-27.7 remain historical weighted-RMS and candidate-count display baselines; neither is the current pre-weight all-row geometry display. For Version 2026-08-28.2, the current Japanese/English desktop and 600-dpi diagram-export checks have been completed under the 160-row, 0.5-mm-row-width, 250-mm-radius condition and are recorded at the beginning of this section. The separate numerical acceptance contract continues to cover the all-row identities, no-`T` candidate exclusion, angular-neighbour mapping, 180LI branch diagnostics, translation and `T` invariance, and grouped-row variance agreement.

The 2026-08-27.6 browser QA was completed for both languages with 160 rows, 0.5-mm row width, beam pitch 0.875, source-to-isocenter distance 600 mm, radial position 250 mm, configured thickness 1.0 mm, 1200 acquired views, and the primary 180LI path. In the final direct-`file://` reload, both the Japanese and English pages completed in 8.5 s, with no calculation error and with every required diagram canvas nonblank. Section 2C renders remain stored as `output/playwright/jp-180li-section2c-terminology-final.png` and `output/playwright/en-180li-section2c-terminology-final.png`. The final transposed Section 3C renders and publication exports are stored under `output/playwright/geometry-rms-axis-transposed-ja-v6-final/` and `output/playwright/geometry-rms-axis-transposed-en-v6-final/`. In each language, both `geometry-weighted-rms-ratio-T1mm-r250mm-1200views-off-80mm-600dpi.png` and `geometry-weighted-rms-ratio-T1mm-r250mm-1200views-on-80mm-600dpi.png` were exported at 1890 x 1470 pixels with 23622 pixels/m in both directions. The maps contain all 1200 acquired angular samples for every one of 360 reconstruction-plane positions; x is relative tube angle beta and y is the upward-positive reconstruction-plane position s within one table feed. Screen and publication figures showed the same selected `final-candidate-weighted-rms-with-row-aperture-over-configured-thickness` indicator and a shared 0-to-0.6 linear scale for the paired conditions. The selector was also changed to the distinct `angularly-weighted-180li-branch-bracketing-gap-over-configured-thickness` path audit and restored to the default RMS display in both languages. Automated dataset assertions and visual inspection confirmed the axis order, all-view sampling, exact non-overdrawing cell widths, periodic-state convention, and absence of clipped titles, legends, axes, or color scales in either language.

The 2026-08-27.7 candidate-count browser QA was completed under the same 160-row, 0.5-mm-row-width, beam-pitch-0.875, 600-mm source-to-isocenter, 250-mm radial-position, 1.0-mm configured-thickness, 1200-view, primary-180LI condition. Final Japanese and English publication exports are stored under `output/playwright/candidate-count-ja-v7-final-palette/` and `output/playwright/candidate-count-en-v7-final-palette/`. Each language contains off/on `geometry-final-candidate-count-T1mm-r250mm-1200views-*-80mm-600dpi.png` panels at 1890 x 1470 pixels with 23622 pixels/m in both directions. Both panels use the same integer K scale from 2 through 6, retain all 1200 angular samples for all 360 reconstruction-plane positions, and distinguish the minimum positive count with a visible light-blue level from the gray invalid/missing color. Automated DOM checks at 390 x 844 pixels confirmed vertical stacking, no page or candidate-card horizontal overflow, and full-width responsive headings in both languages. Visual inspection confirmed that titles, axes, and discrete color scales are not clipped.

The 2026-08-28 reader-facing terminology update replaces the previous abstract label with "reconstruction-plane position within one table feed" in both languages. Section 3C now begins with an accessible inline SVG schematic in object-fixed coordinates showing the reference plane `s=0`, the evaluated plane `0<s<1`, the next-period boundary `s=1`, the axial distances `sF` and `F=pNd`, and the relative X-ray source trajectory during one rotation. The figure explicitly states that `s=1` is one full table feed away and has the same relative geometry as the next period's `s=0`; it is not the same physical plane. Japanese and English 1440-pixel desktop and 390 x 844 mobile browser renders showed no overlap, clipping, or page-level horizontal overflow. The inspected schematic renders are stored under `output/playwright/candidate-count-ja-v12-explainer-final/` and `output/playwright/candidate-count-en-v12-explainer-final/`; the final Japanese and English RMS-map publication QA is stored under the corresponding `geometry-rms-*-v12-explainer-final/` directories. This is a terminology and explanatory-figure change only; the numerical model and stored results are unchanged.

The subsequent 2026-08-28 acquisition-geometry update replaces that abstract inline SVG with a data-driven Canvas 2D figure. For the currently inspected state it draws an orthographic, not-to-scale, object-fixed view of the relative helical focal-spot trajectory, target plane, direct acquired view, the two acquired complementary views that bracket the ideal `beta+180 degrees+2 gamma` angle, and all detector-row centers mapped onto the evaluation-point longitudinal line. Only nine representative ray lines are drawn in the 3-D panel for legibility, while all `N` row-center candidates remain visible in the adjacent longitudinal panel and all `N` rows remain in the calculation. No physical detector plane is inferred because detector-to-isocenter distance is not an input. Color, opacity, and line width encode geometric role only and never interpolation weight. The figure stops before the Schaller AAI weighting function `h(z)`, normalization, filtering, and backprojection. Version 2026-08-28.1 added the separate pre-weight, all-row axial-spread curve and removed the reader-facing weighted-RMS and candidate-count heat maps. Version 2026-08-28.2 applies the same stage separation to the unwrapped diagrams: 2A thin traces are the all-row candidate pool in both geometry conditions, 2B circles are selected nearest interpolation endpoints, and configured slice thickness `T` is applied only at the later configured-output SSPz stage. The current Japanese/English desktop and publication-export visual QA for this contract has been completed within the scope stated above.

## Publishing

The GitHub Pages workflow first runs `npm test`, then uploads the static files and deploys them only if the regression passes. Repository visibility, authorship, and license must be selected by the research team before first publication.
