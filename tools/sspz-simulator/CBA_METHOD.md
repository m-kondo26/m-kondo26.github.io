# Hsieh conjugate backprojection and matched RRI

Version 2026-09-15.1. Select **3D FBP**, then **Hsieh conjugate interpolation (CBA vs RRI)**. Both results are computed from the same finite-sphere projections in the browser. 80, 160 and 320 rows are supported, as is the 64-row configuration discussed by Hsieh. The FDK path remains available.

## Sources and implemented scope

- Hsieh J, Tang X, Thibault JB, Shaughnessy C, Nilsen RA, Williams E. *Conjugate cone-beam reconstruction algorithm.* Optical Engineering. 2007;46(6):067001. [doi:10.1117/1.2746866](https://doi.org/10.1117/1.2746866). Rowwise fan-to-parallel rebinning, conjugate pairing and normalized four-sample interpolation follow Eqs. (4)-(6). The quadratic interpolation function is the one described for their experiments. Its linear special case provides the matched RRI comparison.
- Tang X, Hsieh J, Nilsen RA, McOlash SM. *Extending three-dimensional weighted cone beam filtered backprojection (CB-FBP) algorithm for image reconstruction in volumetric CT at low helical pitches.* International Journal of Biomedical Imaging. 2006;2006:45942. [doi:10.1155/IJBI/2006/45942](https://doi.org/10.1155/IJBI/2006/45942). Eqs. (2)-(3) specify parallel-coordinate ramp filtering and the cone-cosine factor. We use these conventional operations; their adaptive 3D weighting and overscan algorithm are not implemented.

This is a numerical implementation of the specified interpolation within a conventional approximate cone-parallel FBP. It is not a reproduction of every acquisition, adaptive interpolation, overscan weighting or scanner correction used in Hsieh's experiments. No fitting to their measured FWHMs is performed. No TCOT implementation is claimed.

## Acquisition and coordinates

The acquired detector and finite-sphere line integrals are identical to `FDK_METHOD.md`: source radius R, row count N, row width d, pitch p, table feed H=pNd. Source angle beta has source position (R cos beta, R sin beta, H(beta-phi0)/(2 pi)). A detector ray has horizontal direction (-cos(beta-gamma), -sin(beta-gamma)); w is its axial coordinate on the source-centred cylinder of radius R. The finite detector aperture is integrated using midpoint subrays. Only discrete acquired views and channels are used in rebinning.

Define the rebinned ray direction by theta = beta - gamma and its transverse offset by t = R sin gamma. Thus

    gamma = asin(t/R)
    beta = theta + gamma
    q(theta,t,w) = P(beta,gamma,w).

The sign convention above follows the existing Cartesian acquisition; it is stated explicitly rather than copying angular signs from differently oriented diagrams. Rebinning is linear in acquired view and channel coordinates. The detector row w is unchanged. Unwrapped angles are retained: projections one turn apart have different source z positions and are never treated as periodic copies.

For voxel (x,y,z):

    t = -x sin(theta) + y cos(theta)
    h =  x cos(theta) + y sin(theta)
    L = sqrt(R^2-t^2) - h
    w = R [z - H(beta-phi0)/(2 pi)] / L.

The conjugate ray is evaluated at (theta+pi,-t) through the same voxel, with its own beta, source z, L and w. These two 3D rays intersect at the voxel; they are not assumed to be the same 3D ray.

## Filtering and paired interpolation

For each unchanged detector row, multiply q by R/sqrt(R^2+w^2) and convolve along t with the discrete unwindowed Ram-Lak kernel given in `FDK_METHOD.md`. Since the cone factor is constant along a row, applying it before or after this convolution is equivalent. There is no fan-beam inverse-distance-squared backprojection factor in this rebinned geometry.

Transverse interpolation of filtered samples is linear. Let a and b be the fractional row positions of the voxel's direct and conjugate rays. If q0,q1 and q2,q3 are the filtered values at the bracketing row centres, the normalized weights are

    RRI: [(1-a), a, (1-b), b] / 2
    CBA: [(1-a)^2, a^2, (1-b)^2, b^2] /
         [(1-a)^2 + a^2 + (1-b)^2 + b^2].

The paired backprojection value is the weighted sum of these four samples (Hsieh Eq. (6)). Weights depend on geometry, not measured intensity: the reconstruction remains linear in projection data. The nearest-two-sample special case of Hsieh Eq. (7) is not substituted for their four-sample experimental method.

For each slice, use a slice-centred full turn in the rebinned coordinate theta, pair its first half with its second half, and sum each paired value with angular step Delta_theta. Each of the two projections has its redundancy accounted for by the paired normalization; no additional factor of 1/2 is applied. Acquired views beyond the rebinned endpoints are required for fan-to-parallel interpolation and are included in the recorded acquisition range. The view count must be even. No additional turns, adaptive cone-angle weights or overscan window are added.

RRI and CBA share acquisition, rebinning, cone factor, ramp filter, angular interval, image grid, ROI and normalization rule. A difference between these two results isolates the specified interpolation-weight change within this model. A difference from the original FDK path also includes rebinning and filtering-geometry differences.

## Coverage, sparse computation and outputs

Full finite-sphere projection coverage is required on every acquired view used. Both rows of both conjugate brackets must be present at every reconstructed voxel. Unsupported conditions stop explicitly; pitch is never silently reduced, and missing measurements are not replaced by zero. This conservative paired-full-turn implementation does not implement Hsieh's high-pitch fallback or step-and-shoot extrapolation handling.

Only exactly zero sphere-projection samples are omitted. Filter inputs are bounded by the intersection of the acquired-view and channel interpolation tents with the nonzero projection support; every nonzero input contributes to the ramp convolution. Dense comparisons test this sparse evaluation. Increasing row count does not establish physical validity at wider cone angles.

SSPz is the disk-ROI mean through the reconstructed finite sphere. No rectangular z average, deconvolution or target-FWHM adjustment is added. Native linear crossings determine widths after the selected normalization. Mean and SD summarize individual FWHMs. CBA and RRI are normalized separately, with raw ROI values and baselines retained. The mean-difference curves subtract each method's own pointwise mean at the common sphere-centred coordinates.

The grey/red sample plot displays local row-interpolation weights at the sphere-centre voxel for the first start angle. Marker area represents weight; plotting is decimated to at most 45 pairs for readability. These are weights after rebinning and filtering, not total contributions of raw acquired cells to the entire SSPz. All pairs, coordinates and weights are preserved in Excel/JSON. The acquisition diagram includes the actual acquired views used across the local reconstructed volume. Images and the FWHM arrow show CBA at the first start angle.

Excel and CSV contain both methods' unrounded raw and normalized profiles. Excel also contains both width series, each method's mean differences, parameters and central-voxel sample weights. JSON includes both first-angle volumes and all profile series. The profile PNG includes both methods.

## Verification

`node tests/cba.mjs` checks independent Cartesian geometry, rebinning of known fields, dense versus sparse convolution, normalized pair weights, the linear RRI special case, unit attenuation recovery, 80/160/320-row operation, actual start-angle changes, coverage and cancellation. `node scripts/verify-cba.mjs` records sensitivity to view count, aperture integration and reconstruction spacing in `tests/cba-verification.json`.

These checks establish implementation consistency and the reported numerical behaviour, not validation of a commercial scanner. In particular, the paper's measured foil widths of 0.85/0.67 mm are not target values for this finite-sphere simulation. Numerical sensitivity and wide-cone approximation limits must be considered when interpreting small differences.

For the recorded 0.65-mm sphere at a 100-mm radius, 0.5-mm rows and pitch 0.5, changing 720 to 1440 views changed normalized FWHM by less than 0.003 mm in the 80/160/320-row cases. This is a limited sensitivity observation: the raw peak still changes substantially with view count because rebinning interpolates a small object's angular samples. It does not establish convergence of absolute attenuation, all profile features or other conditions. Raw and normalized profiles must not be confused when judging convergence.
