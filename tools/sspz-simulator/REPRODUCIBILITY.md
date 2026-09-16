## 2026-09-17.5: RRI-equivalent linear interpolation adopted

The browser's conjugate-data path now publishes one RRI result. `reconstructRri` and `reconstructRriSeries` select the existing linear branch, including its images, native profiles, local row weights and image-window-integrated weights. The paired CBA/RRI APIs remain available for reproducibility. This adoption changes the formerly primary CBA result to RRI; it does not establish equivalence between them. Old `hsieh` URLs show a migration notice; v10 URLs save `rri`.

All 21 `npm test` suites passed. The added RRI tests cover 4, 80, 160 and 320 rows, exact same-runtime equality to the retained RRI branch, independently evaluated linear-distance weights, averaged centre-value closure and selected/series/profile-only consistency. Diagram tests additionally verify rebinned RRI coordinates without a paired result. The axial numerical core and original FDK numerical core are unchanged.

Browser QA used four rows, d=1 mm, pitch 0.875, r=102 mm, T=1 mm, 360 acquired views per turn and all 360 start angles, 0.1-mm reconstruction z spacing, 0.20-mm aperture and 0.25-mm channel spacing. At selected angle 90, the downloaded JSON volume agrees with the Node RRI result within 5.1e-15 (raw profile within 1.4e-15). Actual Excel/CSV raw and normalized profiles agree exactly with JSON; 360 width rows are named RRI, and 1086 selected-window weights agree exactly with the RRI audit. PNGs retain 600-dpi metadata and the shared renderer. Japanese, English, mobile, legacy URL migration, and the optional 80-row FDK browser path were checked.

These settings verify integration and export consistency, not manuscript-condition convergence or commercial scanner validity. No manuscript figure was regenerated in this release. Browser evidence is retained locally in `output/playwright/rri/`; numerical scope and the prior CBA/RRI comparison are recorded separately.

## 2026-09-17.4: shared finite transaxial aperture

The browser axial model now uses the same point-to-detector-cell integral as the 3D paths, followed by linear channel readout and its existing axial interpolation/filter sum. Active aperture (`channelApertureMm`, URL `ca`) and detector-center spacing (`channelWidth`, URL `cp`) are separate common inputs. URL version is 9. This changes the axial numerical model; it does not add full 2D FBP. See DETECTOR_APERTURE_METHOD.md for scope and the additional geometric amplitude convention.

All 20 suites in `npm test` passed. `tests/detector-aperture.mjs` independently enumerates acquired data and axial interpolation/filter queries: maximum raw discrepancy was 1.2 × 10⁻¹⁴. It checks shared 2D/3D acquired samples, inactive gaps and edge ties, finite-sphere quadrature approaching a point for aperture smaller than spacing, and fixed-point extraction with different image pixel spacings. Changing aperture at fixed spacing changes the normalized axial shape. These are implementation checks, not commercial-scanner validation or proof of publication-condition convergence.

A separate comparison with published release af79993 at full fill (aperture=spacing=0.25 mm) found exactly unchanged raw CBA/RRI profiles at 4, 80 and 320 rows and T=1/5 mm, and unchanged FDK profiles at 320 rows and T=1/5 mm. No manuscript result or figure was regenerated. Older low-level axial calculations remain reproducible via the explicitly documented legacy acquisition mode.

## 2026-09-17: ideal point without a measurement sphere

Web build and 3D cores **2026-09-17.2** use `fdk_objectModel=point` in browser URLs. The object is projected analytically through each detector aperture and read at its fixed transverse location after 3D reconstruction and the configured axial average. The old sphere-diameter and subray controls are absent. Older browser settings are migrated with a visible notice; the numerical API still accepts explicit `objectModel: 'sphere'` for reproduction of historical studies. See POINT_RESPONSE_METHOD.md for the formula and comparison limits.

The new implementation checks pass: solid-angle mass, aperture edges, small-sphere projection limits, bead-parameter independence, fixed-point readout, weight-audit closure, full angular closure, and 4/80/160/320-row cases. Tests for the unchanged axial model and historical finite-sphere API also pass. Browser checks cover the 360-angle CBA/RRI series, selected-angle images, shape maps, Excel and JSON exports, and both languages.

`tests/point-response-sensitivity.json` records additional view/z-spacing examples. These are not convergence certificates for manuscript conditions. For example, at four rows, radius 250 mm, T=1 mm and start angle zero, CBA FWHM changes from 1.18 to 1.16 mm between 1440 and 2400 acquired views. The original axial kernel and existing manuscript figures have not been replaced by this update. Historical sphere-based sensitivity reports below must not be read as validation of the point-response model.

## 2026-09-16: configured thickness drives rectangular averaging

Web build **2026-09-16.4**, URL schema **v8**, FDK core **2026-09-16.1**. The public Japanese and English interfaces use one configured slice-thickness input T. The axial interpolation path uses FW=T in its finite rectangular-weight filter; FDK, CBA and RRI use T as the normalized rectangular image-domain z-average width after reconstruction and before profile normalization. FWHM is measured from each resulting profile, never fitted to T. This is an explicit model convention, not a scanner-specific thickness calibration.

The FDK path now reconstructs the additional slices needed for both ends of the averaging window, integrates piecewise-linear image columns, and crops to the requested output range. It does not zero-pad unsupported rays or relax the full-turn coverage guard. Selected volumes, ROI profiles and centre-pixel weight audits use the same average. Older independent FW or image-average URL settings are replaced by T with a visible migration notice; previously saved results can therefore differ. The low-level numerical API retains explicit independent-width/zero-average operation for historical reproduction.

All 17 suites in `npm test` passed. The new `tests/configured-thickness.mjs` compares raw FDK values and image columns with an independently coded segment integral of separately reconstructed, expanded, zero-average volumes at widths 0.63, 1 and 5 mm (maximum raw discrepancy below 5 × 10⁻¹⁶). It also checks affine-field preservation, axial/CBA/RRI mapping, stale-width overrides, selected/batch agreement, averaged centre-pixel reconstruction from weights and unsupported-coverage rejection. These are implementation checks, not clinical scanner validation.

Browser checks completed all 360 start angles for CBA/RRI at 4 × 1 mm, pitch 0.875, radius 102 mm, and FDK at 80 × 0.5 mm, pitch 0.3, radius 100 mm, with T=1 and 5 mm. Both used 180 views, 4 × 4 aperture quadrature and 0.2-mm z spacing for interface verification; these are not study-quality convergence claims. The selected 90-degree profile matched the corresponding series profile exactly. A separate axial-browser T=5 check confirmed FW=5. JSON and Excel retained T=5 and the mapping definition; SSPz values in Excel/CSV matched JSON without display rounding. The weight-diagram PNG retained 1890 × 2016 pixels and 600-dpi metadata. Existing figure colors, opacity and layout were retained.

The dated statements below describe their respective releases. The current definitions above and in `FDK_METHOD.md`, `CBA_METHOD.md` and `model-manifest.json` supersede earlier independent-T/FW input semantics. This application update does not regenerate a research manuscript or measured study data.

## 2026-09-15: diagram legend below the axes

Display version 2026-09-15.1 / web build 2026-09-15.2. The overview and zoom renderers share a four-row legend below the x-axis. The 900 × 960 canvas leaves a 650-unit plotting height; the prior 80-mm zoom export had a 404-unit plotting height. Axis labels, major/minor ticks, detector-row colors, acquired-sample marker identity and summed coefficients remain intact. The 80-mm, 600-dpi export is now 1890 × 2016 pixels. Both Japanese and English layouts were visually inspected; model-regression, diagram-marker-identity and unwrapped-complementary-trajectories tests passed. No computation core changed.

## 2026-09-15: Hsieh CBA and matched RRI

The integrated worker implements rowwise fan-to-parallel rebinning and Hsieh et al. (2007), Eqs. (4)-(6), with matched linear RRI and quadratic CBA. Both methods share all operations apart from their four-sample row weights. See [CBA_METHOD.md](CBA_METHOD.md) and [tests/cba-verification.json](tests/cba-verification.json).

The complete existing test suite and new CBA tests passed: independent Cartesian geometry, affine-field rebinning, dense convolution comparison, constant-preserving weights, linear RRI special case, unit-sphere attenuation, 80/160/320-row volumes, start-angle dependence and coverage rejection. Dense convolution agreed within 6 × 10⁻¹⁷; central attenuation of a 4-mm sphere in the circular check was 0.9997 for an input of 1. These are implementation checks, not independent validation of the clinical helical response.

Browser checks at 80 × 0.5 mm, pitch 0.5, radius 100 mm and 1440 views covered four start angles, both profiles, mean differences, sample weights, Excel, CSV, PNG and JSON. Spreadsheet and CSV values matched exported JSON without display rounding. The PNG was 4252 × 2976 pixels with 600-dpi metadata. View/aperture/grid sensitivity was recorded separately; raw amplitude was not declared converged.

## 2026-09-14: integrated 3D FBP path

The live application now offers the original axial model and a separate calculation path for full-turn helical FDK with cylindrical detector acquisition. Both are integrated in the same public UI and worker bundle. See [FDK_METHOD.md](FDK_METHOD.md) and [tests/fdk-verification.json](tests/fdk-verification.json). The numerical checks cover 80, 160 and 320 rows; they do not establish scanner-specific or exact wide-cone validity. Excel, CSV, 600-dpi PNG and first-angle 3D volume JSON are available.

The stationary-table geometry changes already present in the local source are included; pitch 0 produces diagrams without helical interpolation in the axial path, and circular FDK in the 3D path. The manifest identifies the current source hash using UTF-8/LF normalization so Windows checkout line endings do not invalidate public-source verification. The older hashes and verification statements below describe their dated revisions, not this release.

# Reproducibility and model scope

Numerical model: **2026-09-08.1**. Diagram/display revision: **2026-09-08.3**.

## Current axial-response definition

The thick-slice reference follows the longitudinal filter-interpolation construction in Taguchi K and Aradate H, *Algorithm for image reconstruction in multi-slice helical CT*, Medical Physics 1998;25:550–561, [DOI: 10.1118/1.598230](https://doi.org/10.1118/1.598230), Eq. (6) and Figs. 5/6. It is not the complete image-reconstruction algorithm from that paper.

A thin object remains fixed. Ideal unit-area rectangular detector-row apertures define its acquired samples. The reconstruction plane moves through z_r; the response coordinate is z_r minus z_object. The 360 displayed curves correspond to distinct object positions within one table feed, not 360 separate scans or 360 independent projection data sets.

For K=2I+1, the filter positions are:

```
z_f(i) = z_r + i FW/K,  i = -I,...,I
P(z_r) = sum_i P_local(z_f(i)) / K
```

At each z_f, adjacent acquired candidates are reselected and locally linearly interpolated. The values are combined with equal rectangular weights. Thus local two-point interpolation is part of a multi-position filter; the whole filtered response is not restricted to the same two acquired samples. Acquired samples outside FW may contribute when they bracket a position inside the filter.

The optimized implementation first combines piecewise-linear local responses by linearity, then evaluates the finite shifted sum. It does not reuse the previous fixed-reconstruction-plane candidate kernel and does not silently replace the finite sum with a continuous convolution.

## Inputs and accuracy limits

- FW: derived from T in public v8 URLs. The low-level numerical API retains independent widths, including FW=0, for historical reproduction and filter tests.
- T (`st`): configured rectangular averaging width and denominator for width/T ratios; it does not prescribe the measured FWHM. The public v8 browser sets FW=T.
- K (`nf`): requested minimum odd resampling count, 33–2049; default 129. It is not the acquired-view count.
- Actual K is increased until `FW/K <= rowWidth*(1-radius/sourceRadius)/8`. The same conservative aperture bound is used for both cone conditions. Required K>2049 produces an explicit precision-limit error with no SSPz output.
- This sampling rule is a numerical safeguard, not a new physical weighting law or a universal convergence bound. Users should examine K sensitivity for their conditions.
- Legacy URLs and saved independent widths are replaced by T with a visible migration notice. This changes calculations when the former FW or image-domain average differed from T. FW=T is not a scanner-specific thickness calibration and does not guarantee FWHM=T.

The complete computed longitudinal grid is retained in each curve. All 360 states are retained. Curves are individually peak-normalized after the view, angular-branch, and filter sums; there is no additional peak or centroid alignment. The center display uses the 10% level to set its range; the separate logarithmic tail display shows amplitudes at or above 0.1%. These are display choices, not physical absence below a threshold or cutoffs in the numerical calculation.

## Geometry remains a separate stage

All detector rows are retained in the acquisition geometry. T and FW do not exclude rows. Each direct-data view is paired with the acquired angular neighbors of the ideal complementary angle beta_c=beta+180 degrees+2 gamma. Local longitudinal interpolation is evaluated in the two angular branches, then combined with their stated angular linear weights.

The unwrapped trajectories use each acquired family's own source z and row scale on a common direct-reference-angle axis. The no-cone comparison uses q=1 and gamma=0. The unweighted all-row axial-spread curve does not use interpolation weights, FW, T, or row-aperture variance.

Diagram endpoints in 2B and gap audits in 2C refer to local FW=0 interpolation at the selected central plane. They are not all contributors to a thick-filter SSPz. The 3D reference plane locates the selected object position.

## Reproduce the software checks

Run from this directory with Node.js:

```
npm run build
npm test
```

The axial-model test suites cover the numerical model manifest, explicit historical fixtures, independent row/turn enumeration, angular-neighbor geometry, all-row spread, complementary-trajectory provenance, the independent finite Taguchi-filter response, SSPz drawing order, and physical-sample marker identity and summed coefficients. Historical two-point-kernel fixtures are tested through the explicitly named legacy adapter; their agreement is not a validation target for the new response.

The Taguchi oracle independently enumerates acquired rows/turns and evaluates each filter position. It does not call production geometry, interpolation, aperture, or normalization helpers. It checks raw responses before normalization, zero FW and reference-T invariance in the independent-width legacy API, isocenter behavior, finite K, convergence toward independent segment integration, and the sampling-limit guard.

The numerical tests do not require a journal PDF or access to a private research folder. An optional `SSPZ_TAGUCHI_SOURCE_PDF` environment variable can identify a legitimately obtained source PDF for provenance checking. The PDF itself is not distributed. Test reports are generated under ignored `output/` directories.

The numerical core SHA256 is recorded in `model-manifest.json`. Current local acceptance included the test suites, independent raw-response differences at floating-point roundoff, bilingual desktop/mobile checks, URL migration, loading/cancellation/error states, and PNG/CSV export checks. Implementation agreement is not commercial-scanner validation.

## Display and publication checks

SSPz profile display contract `2026-09-08.1` is separate from numerical model `2026-09-08.1` and diagram display revision `2026-09-08.3`. Selected-state and all-360-state SSPz painters share `strokeNativeProfile`, connecting the original calculated z/value pairs directly with straight Canvas segments. No display resampling, spline, smoothing, or point/state decimation is applied. The existing log-tail cutoff is 0.001: retained samples are connected in log10 coordinates, with a path break below the cutoff. Japanese/English screen and 600 dpi export use the same painters. Canvas metadata records the rule and native point count.

The recording-Canvas regression checks every coordinate of 1103 nonuniform samples with a narrow peak in eight screen/publication cases, all 360 states, and the exact tail threshold. Negative controls reject point deletion and curved Canvas commands. The numerical core, workers, normalization, FWHM/FWTM, alignment, filtering, state count, and display axes/cutoffs remain unchanged. The numerical core SHA256 remains `27a6e7f48a562050992108af95e21ed5af70b4919a2604c769862d2a92e09a5e`; the worker SHA256 remains `4bc7e71b7a78a846cfc86071e2f73a8f8e0ff3cc950aec3ab4a8e12917ea7052`.

The Japanese and English pages share a generated numerical/rendering core. A versioned script URL prevents the revised page from reusing a prior unversioned calculation bundle. Width, axis, legend, and parameter captions use the same drawing code for screen and publication export.

Display revision 2026-09-08.1 places axes/grid behind SSPz curves. This keeps a flat 100% peak visible when it coincides with a gridline, without altering any computed samples, widths, or plot limits. The recording-Canvas regression exercises the actual screen/publication drawing functions and rejects the previous overpainting order.

Display revision 2026-09-08.2 sums Section 2B angular-branch coefficients sharing `(referenceViewIndex, absoluteViewIndex, row)` before drawing one opaque marker. Different physical samples at coincident coordinates are not merged. Both family roles are retained if a sample is direct and complementary, shown by a circle inside a triangle. This corrects branch overpainting without changing input contributions or numerical SSPz. These weights describe the central local FW=0 diagnostic, not the complete thick-slice filter contribution.

Detector-row hues remain fixed. A compact row-color legend identifies trajectory colors. Only the trajectory lines use multiply blending to show overlap; both opacity and stroke width decrease with the square root of row density (with a minimum stroke width), balancing legibility against dark saturation. Blended line colors are neither new row identities nor numerical weights. Marker colors continue to encode summed coefficients. The actual-Canvas regression checks colors, symbols, positions, blending-state isolation, sample identity, and a negative control using the former unmerged renderer.

Display revision 2026-09-08.3 removes detector-row numbers from the trajectories at every row count, superseding the sparse inline labels introduced in revision .2. Axes and the compact row-color legend remain visible in Japanese, English and publication PNGs. Geometry, weights, color mapping, opacity, stroke width, canvas dimensions and numerical SSPz are unchanged. The marker-identity suite additionally exercises 24 drawing cases covering 4/160/320 rows, both geometry conditions, screen/publication output and overview/zoom, requiring zero inline labels and unchanged diagram data.

SSPz panels are 80 mm wide at 600 dpi (1890x1365 pixels), while the selected-profile figure is 180 mm wide (4252x2303 pixels). Unwrapped diagrams use the existing 80-mm format (1890x1470 pixels). PNG pHYs is 23622 pixels/m, approximately 600 dpi. Captions and filenames include FW and actual K; CSV also includes reference T, requested minimum K, model version, and response coordinate.

Browser checks for this revision use HTTP, including real published pages after deployment. Prior direct-file checks are historical only. Small-screen charts preserve the existing internally scrollable canvas containers; the full chart is not claimed to fit simultaneously on a narrow phone screen.

## Scientific boundary

The axial interpolation model includes ideal row apertures and stated angular/cone-geometry assumptions. It excludes complete filtered backprojection, scanner-specific detector-channel interpolation, redundancy and cone-beam weights, optimized-pitch selection, finite bead diameter, noise, and proprietary nominal-thickness calibration.

A broad rectangular filter can still produce FWHM near its filter width. This does not demonstrate invariant acquisition geometry or agreement with measured thick-slice SSPz. FWTM, the full response, numerical convergence, and the measurement definition must be considered separately. Data used to calibrate FW or another parameter cannot also be called independent validation data.

This public package contains the simulator and software checks, not manuscript results, measured patient/phantom data, or copyrighted journal PDFs. Updating the Web application does not revise any research manuscript.
