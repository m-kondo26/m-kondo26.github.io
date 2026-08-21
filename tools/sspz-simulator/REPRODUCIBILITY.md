# Reproducibility record

## Scientific scope

This project is a simplified geometry-plus-assumed-longitudinal-weighting reference. It is intended to make the following chain inspectable:

`candidate-ray geometry -> delta-z/T -> nearest-bracketing weights -> intermediate SSPz -> configured-thickness explanatory SSPz`

It is not an implementation of a commercial CT reconstruction algorithm. In particular, it does not infer proprietary projection selection, redundancy weighting, cone-beam backprojection, iterative reconstruction, deep-learning reconstruction, noise, temporal sensitivity, or motion response.

Version 2026-08-21.4 uses one actual-data family at equally spaced relative tube angles `beta=2*pi*k/N`, `k=0,...,N-1`, over a complete 0-to-360-degree turn. The interval is half-open, so the displayed 360-degree endpoint closes the helix trace but is not counted twice. Angles from 180 to 360 degrees use the same actual-data rule as angles from 0 to 180 degrees. No direct/opposing-ray split remains in the calculation, and no previous half-scan SSPz, FWHM, or FWTM value is reused.

For the idealized cone-geometry condition, the source-to-evaluation-point distance ratio is `q(beta)=L(beta)/R=sqrt(1+(r/R)^2-2(r/R)cos(beta))`, where `R` is source-to-isocenter distance, `r` is the transverse distance from isocenter to the fixed evaluation point, `beta=0` places the source in the evaluation-point direction, and `L(beta)` is source-to-point distance. The candidate-row center is the sum of the linear helical table-motion term and the detector-row offset scaled by `q(beta)`. Therefore the on-condition traces bend continuously over a rotation and return to the same distance scale at 360 degrees. The distance ratio increases from 0 to 180 degrees and decreases from 180 to 360 degrees; the signed deviation from the parallel-beam approximation, `q-1`, crosses zero twice. This is a first-order geometric projection model, not a complete cone-beam reconstruction.

At each tube angle, the calculation searches the ideal infinite helix for the nearest candidate with a longitudinal coordinate smaller than `z0` and the nearest candidate with a longitudinal coordinate larger than `z0`. These are the two sides of the longitudinal `z` coordinate; they do not denote the upper and lower directions of the unwrapped diagram. The two candidates receive linear interpolation weights; an exact match receives weight one. No fixed longitudinal support or fixed number of turns can invalidate an otherwise reconstructable ideal-helix state. The distance between the bracketing candidates is `delta-z`; `delta-z/T`, where `T` is configured slice thickness, is the primary geometry-sensitivity indicator. Scanner-specific projection selection, redundancy weighting, cone-beam backprojection, and proprietary z-filtering remain outside scope.

The reader-facing order is: the configured-output 360-state center-shape overlay, a separate configured-output low-amplitude-tail overlay, and scalar width summaries. The pre-thickness intermediate SSPz and its widths are not exposed in public figures, publication PNGs, or CSV files. The `delta-z/T` heat map remains available in a collapsed secondary-details panel as a geometry audit rather than a reconstructed-thickness output. The 360 reconstruction states are distinct from the user-selected number of full-scan tube-angle views used inside each SSPz calculation. The public input is configured slice thickness, not effective FWHM. No model parameter is fitted to the computed FWHM; FWHM, FWTM, standard deviation, centroid, and configured-output profile shape are outputs.

The numerical SSPz grid uses one state-, cone-condition-, and configured-thickness-independent longitudinal domain large enough to contain one table feed, the maximum idealized row aperture, and the allowed 20-mm configured-thickness window. The user-selected grid count is a minimum; it is automatically increased up to 4000 samples when narrow detector rows require finer sampling. This prevents a changing numerical search window from being mistaken for geometry-driven SSPz variation. The calculation domain is not reused as the visible domain. The selected-state detail and 360-state center-shape charts use symmetric outward-rounded axes derived only from configured-output values at or above 10% of peak. A separate logarithmic tail chart uses configured-output values at or above 0.1%. Off/on panels share horizontal limits only within the same center or tail role.

The same version removes relative reconstruction position, reference z position, state-sweep count, and diagram turn count from the acquisition-condition form. The full 360-state set is automatic. A result-side selector chooses one of those states only for detailed inspection. The unwrapped overview automatically covers the finite turn set inspected by the SSPz candidate search, retains every detector row, and stores shared parametric trace arrays rather than a nested point array for every row/turn trajectory. The radial-position interface spans 0--250 mm; 250 mm is identified as the geometric edge of a 500-mm field of view, not as a guarantee of a scanner-specific usable field.

The 360-profile overlay uses states `s=k/360`, `k=0,...,359`, within one table feed per rotation. It is not a set of measured absolute tube angles or 360 repeated acquisitions. All 360 configured-output states are rendered as 360 separate thin paths without state decimation or an overlaid pointwise summary curve or band. Each profile is peak-normalized and retained on its native `z-z0` coordinate without peak, centroid, or half-height-midpoint alignment. The pointwise configured-output maximum is retained internally only for threshold-based axis derivation and is not drawn. Full-resolution configured-output profiles are used for scalar metrics. If the SSPz grid contains more than 1000 samples, only the within-profile canvas z-grid is uniformly reduced to at most 1000 samples and this fact is written inside the exported image; the 360 states themselves are never reduced.

The publication renderer follows one shared axis contract. Axes and text are black; support grids are light gray; units appear in parentheses; all labels on one axis use the same number of decimal places. Tick steps are selected from the natural `1, 2, 5 x 10^n` sequence. Axis limits are expanded outward to integer multiples of that step and never rounded inward across rendered data. Thus an extent near 132 mm may be shown as 150 mm, while an 80-row condition whose complete candidate extent exceeds 300 mm is shown at 400 mm rather than being clipped to 150 mm. Major ticks point outward, minor midpoint ticks point inward, and the main axes use at least five divisions. Comparable SSPz panels share their horizontal domain.

The publication PNG control re-renders the chart at its target physical size rather than resizing the screen canvas. Panel figures are exported at 80 mm and 1890 pixels; full-width figures are exported at 180 mm and 4252 pixels. Both correspond to 600 dpi after rounding, and a PNG `pHYs` chunk records the physical resolution. Publication mode omits the interactive selected-state marker, long candidate-count annotations, and redundant title/subtitle text while retaining the axes, data, and essential encoding legend; detailed conditions belong in the figure caption. These rules are based on the current Medical Physics author instructions and the Wiley electronic-artwork guidance; final manuscript tables remain editable rather than being submitted as screenshots.

## Numerical regression

Run:

```powershell
npm test
```

The test loads `tests/full-scan-reference.json` and compares the JavaScript core with the independent NumPy implementation in `tests/full_scan_reference.py`. The fixed condition is 4 detector rows, 1.0-mm row width, beam pitch 0.875, 600-mm source-to-isocenter distance, 102-mm radial position, relative reconstruction position 0.5 within one table feed, 360 actual tube-angle views over 0-to-360 degrees, and 800 SSPz samples. The independent reference contains no direct/opposing-ray conversion.

The 102-mm radial position is retained only as a study-derived numerical regression fixture. It is not presented as a general CT reference radius or as a recommended public preset. The public interface uses generic presets of 0, 50, 100, 150, 200, and 250 mm.

The regression checks FWHM, FWTM, standard deviation, centroid, angular coverage, bracketing gap, and `delta-z/T` with and without idealized source-to-evaluation-point distance scaling. The independent 360-view nearest-bracketing reference produces intermediate FWHM values of approximately 1.199 and 1.330 mm without and with idealized distance scaling. At 102 mm and relative state 0.5, the 1-mm configured-thickness explanatory condition produces FWHM values of approximately 1.391 and 1.486 mm; the corresponding 5-mm FWHM remains approximately 5.000 mm because of the rectangular-window topology. The test also requires the intermediate SSPz and its z grid to remain identical when only configured thickness changes.

An 80-row, 0.5-mm-row-width, 250-mm-radius condition is evaluated at all 360 relative reconstruction states. Every state must retain 100% ideal-helix angular coverage and a finite intermediate FWHM. This specifically guards against the superseded fixed-support behavior that produced a missing central interval. A separate periodicity assertion verifies that source-to-evaluation-point distance increases from 0 to 180 degrees and decreases from 180 to 360 degrees.

A separate public-output regression uses 160 rows, 0.5-mm row width, beam pitch 1.35, 600-mm source-to-isocenter distance, 0-mm radial position, 1.0-mm configured thickness, 1200 full-scan views, and 2000 longitudinal samples. The configured-output values are FWHM 1.036719 mm, FWTM 1.707119 mm, and standard deviation 5.977569 mm, while the internal pre-thickness FWHM is 0.642580 mm. The test fails if the reader-facing configured-output width falls back to the approximately 0.5--0.7-mm internal response.

The authoritative file hashes and fixture parameters are recorded in `model-manifest.json`.

The unwrapped-diagram display is tested separately from the numerical SSPz regression. The overview includes the same 0-to-360-degree actual-data family used by the SSPz calculation, every detector row, and every turn containing the row-wise nearest smaller-z/larger-z candidates plus one neighboring turn on each side. There is no dashed opposing-data family. Tests require selected bracketing points in both angular halves, unit within-view weight sums on both sides of 180 degrees, one detector-row trajectory per displayed turn, and a periodic relation in which the 360-degree trace endpoint equals the 0-degree geometry shifted by one table feed.

## Browser verification

The 2026-08-21 full-scan build is checked with Chromium-based browser sessions at:

- desktop viewport: 1280 x 720 pixels;
- mobile viewport: 390 x 844 pixels.

The following were verified:

- the Japanese `index.html` and English `index-en.html` pages use the same numerical core and drawing code, with build-generated language-specific interface strings;
- the language switch preserves all URL-encoded calculation conditions and the selected inspection state;
- the English terminology distinguishes acquired projection data, opposite-ray data, the smaller-z and larger-z sides of `z0`, configured slice thickness, and measured output widths;
- the English page completes calculation without console errors at desktop and 390 x 844 pixel mobile viewports, with no horizontal document overflow;
- the 2B publication legend uses separate rows for the linear interpolation-weight scale and acquired projection data, preventing overlap in both Japanese and English 600-dpi PNGs;
- automatic calculation and completion;
- 0-degree-at-top and 360-degree-at-bottom diagram orientation;
- a two-level diagram sequence (candidate overview, then nonzero-weight zoom) without and with idealized source-to-point distance scaling;
- shared horizontal limits for each off/on comparison;
- fixed marker size with assumed weight encoded by color intensity;
- one solid actual-data family and circular markers throughout both 0--180 and 180--360 degrees, with no dashed opposing-data family;
- browser-visible scope text reporting the automatically derived turn range and candidate-line count for both default and 80-row conditions;
- SSPz whole-profile overlay;
- configured-output SSPz shown first as a 10%-and-above linear center-shape figure;
- configured-output values from 0.1% upward shown separately as a logarithmic low-amplitude-tail figure;
- `delta-z/T` maps retained behind a collapsed secondary-details control, with a shared linear color scale when opened;
- 360-state native-coordinate SSPz overlays with all 360 states rendered as separate thin paths and no synthetic pointwise summary curve or filled range;
- configured-thickness SSPz as the only public one-rotation width stage, with FWHM/T, FWTM/T, or standard-deviation/T selection;
- radial-position preset interaction;
- 250-mm radial input and rejection above 250 mm;
- automatic candidate-search turn range with all rows retained for 4-, 80-, and 320-row inputs;
- result-side state inspection without changing or recomputing the full 360-state set;
- responsive layout;
- absence of browser console errors after reload.
- natural outward-rounded axis limits and constant decimal precision, including an 80-row, 250-mm test condition in which the complete candidate range requires a broader round endpoint than 150 mm;
- role-specific shared horizontal domains for the configured-output center pair and tail pair;
- 80-mm panel and 180-mm full-width publication PNG re-rendering at approximately 600 dpi, including embedded PNG physical-resolution metadata;
- successful direct `file://` launch, calculation completion, and FWHM result rendering in Google Chrome.
- successful 5-mm configured-thickness direct `file://` calculation at a 150-mm radial position, including the non-calibration disclosure and configured-output-only profile display.
- standalone sweep PNGs include the displayed stage, configured thickness, and dimensionless width metric inside the canvas.
- an 80-mm publication export at 1890 x 1470 pixels with a PNG `pHYs` value of 23622 pixels/m in both directions, equivalent to 599.9988 dpi.
- an 80-row, 0.5-mm configured-thickness, 250-mm-radius SSPz-overlay publication export at 1890 x 1365 pixels and 599.9988 dpi, confirming that all 360 profile paths remain visible without a summary curve or filled band.

Rendered QA images are kept locally under `output/playwright/` and are intentionally excluded from the public repository by `.gitignore`. The complete 2026-08-21 full-scan page is recorded as `full-scan-default-20260821.png`. The dense all-row overview is recorded as `full-scan-80rows-r250-overview-20260821.png`, and its 600-dpi publication export as `full-scan-80rows-r250-overview-publication-20260821.png`. The N=160, row-width=0.5 mm, beam-pitch=1.35, T=1.0 mm regression view is recorded as `n160-p1p35-T1-configured-core-off.png`; its low-amplitude-tail companion is `n160-p1p35-T1-configured-tail-off.png`.

## Publishing

The GitHub Pages workflow first runs `npm test`, then uploads the static files and deploys them only if the regression passes. Repository visibility, authorship, and license must be selected by the research team before first publication.
