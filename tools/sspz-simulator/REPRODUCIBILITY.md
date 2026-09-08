# Reproducibility and model scope

Numerical model: **2026-09-08.1**. Diagram/display revision: **2026-09-08.2**.

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

- FW (`fw` in shared URLs): independent filter width, 0–20 mm. FW=0 disables the filter average.
- T (`st`): reference thickness for width/T ratios, not an imposed FWHM or a broadening operator.
- K (`nf`): requested minimum odd resampling count, 33–2049; default 129. It is not the acquired-view count.
- Actual K is increased until `FW/K <= rowWidth*(1-radius/sourceRadius)/8`. The same conservative aperture bound is used for both cone conditions. Required K>2049 produces an explicit precision-limit error with no SSPz output.
- This sampling rule is a numerical safeguard, not a new physical weighting law or a universal convergence bound. Users should examine K sensitivity for their conditions.
- Legacy URLs without FW initialize it numerically to T with an explicit uncalibrated-migration notice. FW=T is not a scanner-specific thickness calibration and does not guarantee FWHM=T.

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

The nine test suites cover the numerical model manifest, explicit historical fixtures, independent row/turn enumeration, angular-neighbor geometry, all-row spread, complementary-trajectory provenance, the independent finite Taguchi-filter response, SSPz drawing order, and physical-sample marker identity and summed coefficients. Historical two-point-kernel fixtures are tested through the explicitly named legacy adapter; their agreement is not a validation target for the new response.

The Taguchi oracle independently enumerates acquired rows/turns and evaluates each filter position. It does not call production geometry, interpolation, aperture, or normalization helpers. It checks raw responses before normalization, zero FW, reference-T invariance, isocenter behavior, finite K, convergence toward independent segment integration, and the sampling-limit guard.

The numerical tests do not require a journal PDF or access to a private research folder. An optional `SSPZ_TAGUCHI_SOURCE_PDF` environment variable can identify a legitimately obtained source PDF for provenance checking. The PDF itself is not distributed. Test reports are generated under ignored `output/` directories.

The numerical core SHA256 is recorded in `model-manifest.json`. Current local acceptance included the test suites, independent raw-response differences at floating-point roundoff, bilingual desktop/mobile checks, URL migration, loading/cancellation/error states, and PNG/CSV export checks. Implementation agreement is not commercial-scanner validation.

## Display and publication checks

The Japanese and English pages share a generated numerical/rendering core. A versioned script URL prevents the revised page from reusing a prior unversioned calculation bundle. Width, axis, legend, and parameter captions use the same drawing code for screen and publication export.

Display revision 2026-09-08.1 places axes/grid behind SSPz curves. This keeps a flat 100% peak visible when it coincides with a gridline, without altering any computed samples, widths, or plot limits. The recording-Canvas regression exercises the actual screen/publication drawing functions and rejects the previous overpainting order.

Display revision 2026-09-08.2 sums Section 2B angular-branch coefficients sharing `(referenceViewIndex, absoluteViewIndex, row)` before drawing one opaque marker. Different physical samples at coincident coordinates are not merged. Both family roles are retained if a sample is direct and complementary, shown by a circle inside a triangle. This corrects branch overpainting without changing input contributions or numerical SSPz. These weights describe the central local FW=0 diagnostic, not the complete thick-slice filter contribution.

Detector-row hues remain fixed. A row-color legend and sparse inline row numbers help identify crossing trajectories. Only the trajectory lines use multiply blending to show overlap; both opacity and stroke width decrease with the square root of row density (with a minimum stroke width), balancing legibility against dark saturation. Blended line colors are neither new row identities nor numerical weights. Marker colors continue to encode summed coefficients. The actual-Canvas regression checks colors, symbols, positions, blending-state isolation, sample identity, and a negative control using the former unmerged renderer.

SSPz panels are 80 mm wide at 600 dpi (1890x1365 pixels), while the selected-profile figure is 180 mm wide (4252x2303 pixels). Unwrapped diagrams use the existing 80-mm format (1890x1470 pixels). PNG pHYs is 23622 pixels/m, approximately 600 dpi. Captions and filenames include FW and actual K; CSV also includes reference T, requested minimum K, model version, and response coordinate.

Browser checks for this revision use HTTP, including real published pages after deployment. Prior direct-file checks are historical only. Small-screen charts preserve the existing internally scrollable canvas containers; the full chart is not claimed to fit simultaneously on a narrow phone screen.

## Scientific boundary

The model includes ideal row apertures and stated angular/cone-geometry assumptions. It excludes complete filtered backprojection, scanner-specific detector-channel interpolation, redundancy and cone-beam weights, optimized-pitch selection, finite bead diameter, noise, and proprietary nominal-thickness calibration.

A broad rectangular filter can still produce FWHM near its filter width. This does not demonstrate invariant acquisition geometry or agreement with measured thick-slice SSPz. FWTM, the full response, numerical convergence, and the measurement definition must be considered separately. Data used to calibrate FW or another parameter cannot also be called independent validation data.

This public package contains the simulator and software checks, not manuscript results, measured patient/phantom data, or copyrighted journal PDFs. Updating the Web application does not revise any research manuscript.
