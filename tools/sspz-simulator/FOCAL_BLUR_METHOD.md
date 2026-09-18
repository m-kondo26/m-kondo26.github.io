# Finite axial focal blur in the main interpolation-response model

Model revision: `AXIAL_RESPONSE_VERSION = 2026-09-18.8`;
source integration: `FINITE_FOCUS_VERSION = 2026-09-18.1`.

## Purpose and source

The acquired value of a detector cell is averaged over a finite axial source
before angular/channel rebinning, candidate selection, axial interpolation,
angular averaging, and the declared width-T rectangular average. It is not a
convolution of the finished SSPz. The existing centre trajectories and nominal
candidate coefficients remain unchanged; the signal acquired by each selected
cell changes.

Mori et al., *CTとMRI* (Corona), supplied scans, printed pp.58–60,
Eqs.(6.6)–(6.10) and Fig.6.6, describe uniform focal/detector aperture responses
and their convolution. Printed p.72 Eq.(6.34) and pp.73–74 Fig.6.25 motivate
distinguishing detector response from reconstruction interpolation. Fig.6.6
provides the adopted example: effective focal dimensions 1.2 × 1.2 mm,
source–isocentre distance R=600 mm, detector–isocentre distance 470 mm,
and target angle 7°. The resulting source–detector distance is D=1070 mm.
Printed p.44 identifies nominal focus dimensions as effective dimensions.
The 1.2 mm value is therefore not multiplied by sin(7°).

Only the effective **axial** 1.2 mm width enters this model. No transverse
focal blur, heel effect, or direction-dependent apparent focus from target
tilt is simulated. These book-based example parameters are not a scanner
specification. This implementation extends the existing point-projection
operator, retaining its ray Jacobian; it does not claim exact reproduction of
Fig.6.25 or any commercial CT reconstruction.

## Geometry and units

All distances are millimetres. R is the source–rotation-centre distance;
D is the physical source–detector distance of the cylindrical detector.
At physical source angle beta, the transverse distance to evaluation radius r is

    L = sqrt((R cos(beta) - r)^2 + (R sin(beta))^2).

The detector axial coordinate is scaled to the isocentre radius R.
The detector stays fixed relative to the nominal tube position b. Let delta
be the mean z-FFS focal shift (zero without z-FFS), and let t be an axial
position within the effective focal support, uniformly distributed on
[-f/2,+f/2]. The unit-integral point object has axial coordinate z_o.

    source_z(t) = b + delta + t
    w_ray(t)    = R (z_o - b - delta - t) / L
    w_det(t)    = w_ray(t) + R (delta + t) / D

Consequently the detector-coordinate slope with focal displacement is
R/D - R/L. Row membership is evaluated on w_det; the ray Jacobian uses
w_ray. Substituting one for the other would incorrectly move the detector
with the source. The row aperture d and channel aperture a retain their
existing isocentre-scaled definitions. Channel pitch is distinct from a.
Pure axial focus displacement does not change channel membership.

At the evaluation point, projected detector aperture and focal blur support are

    a_z = d L/R
    b_z = f |1 - L/D|.

For the book-based R=600,D=1070,f=1.2 example, b_z at the rotation centre is
0.5271028037383177 mm. A single row has support a_z+b_z. A local aperture
convolution can change edge shape without increasing FWHM; the completed
helical SSPz also includes candidate selection and averaging.

## Acquired-cell value and normalization

For each source position, the previous point operator gives the acquired
axial/channel cell-averaged value

    J(t) = sqrt(R^2 + w_ray(t)^2) / [L^2 (a/R) d].

For each row k, solve the linear inequalities placing w_det(t) inside that
row aperture. Intersect the resulting interval [t_lo,t_hi] with [-f/2,+f/2].
The stored row value is

    (1/f) integral[t_lo,t_hi] J(t) dt.

The implementation uses an exact, numerically stable antiderivative of
sqrt(R²+w²). It rewrites the asinh difference as an atanh expression to
avoid cancellation for short source intervals. The source distribution has
unit integral: increasing f does not increase total source exposure.
Detector-end clipping is retained, without renormalizing away unacquired
focal contributions. Existing channel-boundary half-membership is retained.

Each physical view remains one exposure. No additional angular views or
independent noise samples are introduced. With z-FFS, the distribution is
centred on each actual A/B focal position and integrated within that exposure;
the existing within-focus angular/channel rebinning and physical exposure
identity are preserved. Candidate centres and interpolation weights remain
defined for the mean focus, which is the declared nominal-ray approximation.

## Comparison reference

The `parallel` option remains a nondivergent comparison, not a physical
finite-source parallel-beam scanner. It uses the same **isocentre-projected**
blur b0=f(1-R/D), invariant with radius and angle, and retains the previous
parallel signal factor 1/(a d). Thus the comparison does not silently remove
focal blur from one branch or invent divergent geometry for parallel rays.

## Configuration and compatibility

- `focalSizeMm`: effective axial width f, finite and >=0. Numerical API default
  0 preserves the old point-source model exactly. New/reset browser conditions
  can explicitly adopt 1.2 mm; legacy URLs must retain their point-source value.
- `focalSourceDetectorMm`: D; default 1070 mm without z-FFS. When z-FFS is
  enabled without an explicit D, its existing magnification defines D.
- A finite focus requires D>R+r, so the detector lies beyond the evaluation
  point for every view. Explicit finite-focus D and explicit z-FFS
  magnification must agree. If only D is supplied, z-FFS magnification is D/R.
- Setting f=0 executes the original projection branches without arithmetic
  changes. Historical z-FFS geometry is preserved in that point-source branch.
- `model.focalBlur` exports source distribution, D, nominal-candidate rule,
  integration scope, and the nondivergent comparison convention.

The response z range must include the additional focal support; the browser
adds half of the maximum projected focal support to its existing range.
Candidate-angle support, acquired view count, and configured T are unchanged.

## Verification and evidence limits

`tests/finite-focus.mjs` independently projects a dense set of physical source
points onto the fixed detector; it checks cell values, exact support,
unit-integral source weighting, z-FFS, unchanged candidate coefficients,
weight-audit response closure, and the nondivergent reference. Frozen hashes
of five complete prechange raw/profile arrays check exact f=0 compatibility.
The broader existing test suite remains applicable to the zero-focus path.

These checks establish numerical implementation consistency for this
declared model. They do not establish agreement with scanner-specific focal
shape, dose, noise, reconstruction filters, or measured SSPz.
