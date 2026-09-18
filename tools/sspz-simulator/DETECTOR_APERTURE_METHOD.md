> Version note (2026-09-18.8): the public browser uses the reduced [shared axial interpolation response](AXIAL_RESPONSE_METHOD.md), now with [finite axial focal acquisition](FOCAL_BLUR_METHOD.md). The point-source formulas below remain the exact zero-focus limit. Image-reconstruction and prior-browser descriptions below document historical APIs; they do not describe the current public calculation. Detector-cell definitions remain shared. New/reset browser transverse aperture and pitch are 0.58 mm at isocentre; the 0.25 mm value below is the historical default.

# Shared detector aperture (2026-09-17.4)

Both browser models now use finite transaxial detector cells. The object is
a unit-integral point, with no sphere diameter. The common controls are the
row width d, transaxial aperture a and transaxial channel-center spacing c,
all in millimetres at isocenter. The default is a=c=0.25 mm. We require
0<a<=c. The numerical reconstruction grid is a different quantity: reducing
pixel size does not remove the acquisition aperture or guarantee finer
physical resolution.

## Shared acquired signal

`detector-aperture.js` is called by both `sim-core.js` and `fdk-core.js`.
Rows have width and spacing d; channels have aperture a and spacing c.
The active width can be smaller than the spacing, leaving an unsampled gap.
There is no redistribution of signal from a gap to nearby cells.

For source-to-axis distance R, horizontal source-to-point distance L,
point fan angle gamma and point cylinder height w, the cone projection is

    P_jk = hypot(R,w)/(L^2 (a/R) d) A_j(gamma) B_k(w).

A_j and B_k are the aperture membership factors: one in the cell interior,
one half on an exact boundary, and zero outside. The derivation from the
Cartesian delta function and ray-coordinate Jacobian is given in
POINT_RESPONSE_METHOD.md. Channel centers have half-integer offsets on
the even grid, as in the existing 3D acquisition. For the explicitly
nondivergent parallel reference, the detector coordinates are transverse
parallel-ray position and z-sourceZ, and the cell value is A_j B_k/(a d).
It intentionally changes ray geometry, while retaining the same cell sizes.

Finite detector integration of an ideal point is consistent with the
projection-response approach of Chen et al., Med Phys 35:724-734 (2008),
doi:10.1118/1.2829867. The specific cylindrical formula and the following
axial-reference extension are our declared model definitions, not equations
claimed to have been published by Chen or Taguchi.

## Axial interpolation reference

For each actually acquired view and row, linearly interpolate the measured
cell averages at the transverse ray through the evaluation point. Feed these
row values into the existing nearest-bracketing axial interpolation and
Taguchi-type rectangular filter sum. The object and its acquired signal
remain fixed while the reconstruction plane moves. This operation is not
a blur applied to the final SSPz and does not average neighboring objects.
The acquired point projection in the cone-geometry branch is the same
detector operator used by the 3D model. The parallel reference has the
separate, explicitly nondivergent geometry above.

This remains a reduced axial-interpolation reference, not full 2D image FBP:
it does not apply a transaxial ramp filter or reconstruct a transverse image.
Adding the acquisition aperture makes the detector assumptions comparable;
it does not make the subsequent reconstruction operators identical. Changes
from the former axial-only response include channel sampling/readout and
the geometric amplitude of the shared point projection. They must not all
be attributed to physical aperture width in isolation.

## Three-dimensional reference

FDK and CBA/RRI use these same acquired cell averages, followed by their
documented rebinning, ramp filtering and 3D backprojection. Existing default
results for a=c are numerically preserved to floating-point precision.
The reconstruction/filter grid continues to use spacing c. Varying a at
fixed c isolates acquisition aperture changes within this discretization;
varying c also changes sampling and requires its own convergence study.
Historical finite-sphere APIs remain separate from the browser point model.

## Interpretation and verification

A point at isocenter can lie in the gap between the two central channels
if a<c; in that case a nonzero point response need not be acquired. The
program does not fabricate signal or a valid SSPz for that configuration.
Any numerical or detector bandwidth is independent of the requested image
pixel spacing. Aperture width is not a hard lower bound to every fitted
FWHM, since geometry, reconstruction kernels and the response definition
also matter; no FWHM clipping or target-thickness fitting is introduced.

Tests compare cell integrals with independent analytic values and numerical
quadrature, compare the two models' acquired row samples, check the full-fill
legacy 3D limit, detect gaps/boundaries, vary aperture at fixed spacing and
verify that the aperture enters the axial calculation before interpolation.
Legacy axial APIs without `detectorModel: 'finite-channel'` retain their
previous response for reproducibility. Browser URLs use version 9 and always
select the shared finite-channel acquisition. Manuscript figures are not
automatically regenerated by this browser change. This is an implementation
and numerical verification, not validation of a commercial scanner.
