# Integrated three-dimensional FBP reference

Version 2026-09-17.2. This is an additional calculation path in the existing
public SSPz simulator, executed locally in the same browser Web Worker. The
original axial filter-interpolation model remains available. No server or
Python installation is needed for the public path.

## Algorithm and scientific scope

This implementation uses the full-turn extension of the Feldkamp–Davis–Kress
(FDK) approximate cone-beam FBP. It performs a transaxial ramp convolution and
voxel-wise three-dimensional backprojection. It does not use the existing
axial-only 180LI calculation as a substitute for FBP.

The circular FDK construction is described by Feldkamp, Davis and Kress
(1984), *Practical cone-beam algorithm*, JOSA A 1:612–619,
[doi:10.1364/JOSAA.1.000612](https://doi.org/10.1364/JOSAA.1.000612).
The standard extension to helical data and the choice of a slice-centered
helix segment are discussed in the Introduction of Kudo, Rodet, Noo and
Defrise (2004), *Exact and approximate algorithms for helical cone-beam CT*,
Phys Med Biol 49:2913–2931,
[doi:10.1088/0031-9155/49/13/011](https://doi.org/10.1088/0031-9155/49/13/011).
We implement the standard full-turn FDK reference discussed there, **not**
their new derivative/Hilbert or frequency-mixing algorithms.

This is not TCOT, an exact Katsevich inversion, or a validated prediction of
an 80-, 160- or 320-row commercial scanner. Wide-cone and high-pitch
approximation errors remain. A computationally supported row count is not
scientific validation for that detector configuration.

## Coordinates and connection to the existing unwrapped diagrams

All distances below are in mm; angles are radians. Let R be source-to-isocenter
distance, N the row count, d the row width at isocenter, and p the beam pitch.
The table feed per turn is H = pNd. At acquired view i,

    beta_i = phi_0 + i Delta_beta,  Delta_beta = 2 pi / views_per_turn
    source_i = (R cos beta_i, R sin beta_i, H i / views_per_turn).

phi_0 is the source angle at source z = 0. Changing it rotates the helix
relative to the object; it does not merely rename the same acquired views.
The object location is (r, 0, z_object), with z_object = state H.

The detector is a source-centered cylinder with horizontal radius R. This
is an isocenter-normalized virtual acquisition surface, not a specification
of a physical source-to-detector distance. Its central row coordinates are

    w_k = [k - (N - 1)/2] d,
    gamma_j = [j - (channels - 1)/2] channel_width / R.

The ray direction before normalization is

    -R cos(gamma) e_r + R sin(gamma) e_u + w e_z,
    e_r = (cos beta, sin beta, 0), e_u = (-sin beta, cos beta, 0).

At the evaluation-point longitudinal line, with horizontal source-to-point
distance L(beta), the row center is z_source + w_k L(beta)/R. **This is the
same distance-scaled row geometry as the original unwrapped diagrams.**
The displayed FDK diagram uses the actual full-turn acquisition interval
selected for the central reconstructed slice. Its red solid line is
the object's z position; the row trajectories are geometry, not FBP weights.
Only actual acquired rows are shown; a separate conjugate family is not
introduced into this FDK path.

## Forward projection and rebinning

The browser uses an ideal unit-integral point. Its detector-cell projection
is integrated analytically, including finite row and channel apertures; see
[the point-response definition](POINT_RESPONSE_METHOD.md) for its derivation.
The channel grid contains the object projection and local image volume.
The historical API sphere mode instead uses analytic sphere chords and
midpoint subray quadrature. That mode is not the browser's current object.
Neither mode includes septa, focal-spot blur, noise or measured projections.

For the FDK filter we bilinearly rebin the cylindrical samples to the virtual
flat plane through isocenter, perpendicular to e_r, using

    u = R tan(gamma),  v = w / cos(gamma),
    P_flat(beta,u,v) = P_cyl(beta, atan(u/R), v cos(atan(u/R))).

This is interpolation of the same measured-ray parameterization. No Jacobian
multiplier is applied to the line-integral sample value. Rebinning is an
additional interpolation and is part of this reference model; it can affect
the response. The flat grid uses the same center parity as the acquired row
and channel grids. In particular, an even-row detector uses half-integer
positions on both grids, avoiding an unnecessary half-cell shift at zero
fan angle. Its spacing is d longitudinally and channel_width transaxially.

## Filter and three-dimensional backprojection

The flat projections receive the cone preweight

    G_beta(u,v) = R / sqrt(R^2 + u^2 + v^2) P_flat(beta,u,v).

Each detector row is convolved along u with the unwindowed discrete Ram-Lak
kernel. Including the integration step Delta_u, the coefficients are

    h_0 Delta_u = 1/(4 Delta_u),
    h_k Delta_u = -1/(pi^2 k^2 Delta_u), k odd,
    h_k Delta_u = 0, k nonzero and even.

For voxel (x,y,z), define D = R - x cos(beta) - y sin(beta),

    u = R[-x sin(beta) + y cos(beta)]/D,
    v = R[z - z_source(beta)]/D.

The image is the discrete full-turn sum

    f(x,y,z) = (Delta_beta/2) sum_beta (R/D)^2 Q_beta(u,v),

with bilinear sampling of the filtered projection Q. The factor 1/2 accounts
for the redundant full turn under this ramp convention. Each slice uses
exactly views_per_turn contiguous acquired views, starting at the first
view at or after the lower endpoint of the slice-centered 2 pi segment.
For pitch 0, every slice uses the same circular full turn.

The optimized implementation stores only the analytically bounded nonzero
object projection. It evaluates the full discrete convolution at the output
columns needed by the local image. **Every nonzero input column participates**;
this is not truncation of the filter or of the object's projection. Exact
air samples can be zero; missing required detector measurements cannot.

Before computation, the full object projection and the reconstructed
volume's detector-center interpolation support are checked throughout the
selected acquisition. Conditions failing this conservative check stop with
an explanatory error. No pitch is silently reduced and no missing ray is
extrapolated. More efficient high-pitch short-scan/redundancy schemes are
outside this full-turn implementation.

## SSPz, normalization and output

A local 3D image array is reconstructed (z,y,x; x fastest). The browser
reads each z sample at the fixed transverse object location: an axial
section of the 3D PSF, displayed as model SSPz. This is a point response,
with no finite-sphere or sphere-radius ROI averaging. The historical sphere
API retains its disk-ROI readout; it is not the current browser result.
See POINT_RESPONSE_METHOD.md for comparison with the axial model and the
limits of the SSP interpretation. In the browser the configured
slice-thickness input T is the width of an image-domain rectangular mean:

    f_T(x,y,z) = (1/T) integral[-T/2,+T/2] f(x,y,z+u) du.

This average is applied after FDK backprojection and before SSPz normalization.
The padded image is reconstructed to cover the complete averaging window at
each requested output position. The integral is exact for piecewise-linear
image columns; missing slices are not filled with zeros. The same operation
is applied to the displayed/exported volume and the raw response profile. Profile-only
batch calculations commute these two linear averages and match the full-volume
result. The acquisition-coverage check includes the padding and still rejects
unsupported conditions. FWHM is measured from the resulting SSPz; it is not
adjusted to equal T. This is an explicit model definition, not a calibrated
commercial-scanner thickness kernel. The low-level numerical API retains an
explicit zero-average mode for reproducibility; the browser sends
thicknessMapping = configured-rectangular and uses T throughout.

The display offers min–max normalization (default, minimum 0 and maximum 1)
and peak-only normalization (negative lobes retained). Min–max normalization
can shift negative FBP lobes; raw reconstructed values and each baseline
remain in the exports. FWHM and FWTM use native linear crossings of the
selected normalized profile, and missing crossings cause an error. Width
display uses 0.01 mm and SD 0.001 mm, without rounding the exported analysis
values or implying that those digits establish measurement accuracy.

For multiple start angles, the displayed FWHM mean and sample SD summarize
widths computed from individual profiles, not the width of the mean profile.
The mean-difference plot subtracts the pointwise mean at the common
object-centered z coordinates. No FWHM alignment, width rescaling, spline,
or smoothing is applied. These equally spaced model start angles are not a
probability distribution for measured tube start angles. With one angle,
there is no SD or mean-difference plot.

Excel includes native raw/normalized profiles, pointwise means and deviations,
widths, parameters and method metadata. JSON additionally retains the local
3D volume for the currently inspected angle. Image displays use equal physical axis scale;
negative values are black and all images share the volume maximum as white.
The underlying values, including negatives, remain unchanged in JSON.

## Verification and reproducibility

Run `node tests/fdk.mjs`, `node scripts/verify-fdk.mjs`, and the existing
`npm test`. Numerical sensitivity records are in
`tests/fdk-verification.json`; they are examples, not universal tolerances.

The checks include an independent dense all-cell quadratic sphere projector,
Cartesian ray/plane/cylinder geometry, a full convolution comparison with
the sparse evaluation, absolute attenuation recovery for a circular uniform
sphere, 80/160/320-row volumes and per-slice view counts, genuine start-angle
changes, cancellation, and rejection of incomplete acquisition coverage.
They establish implementation consistency and selected numerical behavior.
Comparison to independently reconstructed helical phantom images or
commercial-scanner measurements remains unperformed. Previous standalone
Python flat-detector tests are development history and do not validate the
integrated cylindrical-detector implementation.

## Linked 360-angle workflow

The browser now automatically evaluates 360 start angles at one-degree increments. It links the inspected angle to acquired-row geometry, virtual-flat filtered row weights, the native SSPz, the width cursor and reconstructed images. Later batch angles compute the same ROI voxels without unused surrounding pixels; full images are recalculated when inspected. Tests confirm identical raw ROI values. Virtual-flat weights are not labeled as original cylindrical detector rows. Coefficients are aggregated over the complete image-averaging window for each unwrapped view and virtual row. Their channel-interpolated filtered values, aggregated row coefficients, FDK geometric factor and angular factor reproduce the averaged central voxel. All profiles remain available in Excel/CSV; the selected volume and audit are exported in JSON. See tests/fdk-workflow.mjs. The native FDK backprojection is unchanged; the added rectangular image average and its padding are explicit. See tests/configured-thickness.mjs for independent segment-integration, volume/profile and weight-audit checks.
