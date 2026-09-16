# Point-response definition (2026-09-17.4)

The browser's FDK, CBA and matched RRI paths now reconstruct a unit-integral
Dirac point at (r, 0, z0). No bead diameter, finite sphere blur, subray sphere
quadrature or sphere-radius ROI average is used. The previous finite-sphere
implementation remains available only in the numerical API as
`objectModel: 'sphere'` (the API default for historical reproducibility).
The browser always sends `objectModel: 'point'`, records it in shared URLs
and exports, and identifies migration from old finite-sphere settings.

## Relation to the axial model

Both paths fix an object with zero axial extent and evaluate response as
the reconstruction position moves in z. Detector row aperture remains
finite. Both apply a normalized rectangular longitudinal average of width
T, followed by the selected profile normalization. T is not a fitted FWHM.

Both paths use the same finite detector-cell point projection (see
[shared aperture](DETECTOR_APERTURE_METHOD.md)). The axial reference reads
these samples with linear transaxial interpolation before axial
interpolation. The 3D path additionally rebins and ramp-filters the data,
and backprojects in three dimensions. It reads
the reconstructed value at the fixed transverse object location for every
z, rather than averaging a bead-dependent ROI. The output is specifically
an **axial section of the 3D point spread function (PSF)**, shown as model
SSPz. This is not a claim that an arbitrary 3D PSF is separable into an
in-plane PSF and an independent SSP, or that this section equals its
transverse integral. It is not a simulation of a finite-bead measurement.

The shared ideal-object convention removes object-size and bead-ROI
differences. It does not make the axial and 3D operators identical or
isolate geometry from all interpolation and filtering assumptions. Their
state sweeps also retain their documented distinction: object position
within one feed for the axial model; tube start angle for the 3D model.

Point projections, detector aperture and Feldkamp reconstruction are used
to study 3D PSFs by Chen et al., *Spatial resolution properties in cone beam
CT: A simulation study*, Med Phys 35:724–734 (2008),
[doi:10.1118/1.2829867](https://doi.org/10.1118/1.2829867).
The separability assumption involved in connecting SSP and a 3D PSF is
discussed by Ohkubo et al., Jpn J Med Phys 24:115–122 (2004),
[doi:10.11323/jjmp2000.24.3_115](https://doi.org/10.11323/jjmp2000.24.3_115).
The following cylindrical-cell formula is derived for our stated detector
coordinates; it is not claimed to be an equation from those papers or from
Hsieh's CBA paper.

## Analytic detector-cell integral

Use the source and ray coordinates of FDK_METHOD.md:

    X(lambda,gamma,w) = S + lambda d(gamma,w)
    d = -R cos(gamma) e_r + R sin(gamma) e_u + w e_z.

For a point at horizontal source distance L, lambda0 = L/R. The Cartesian
Jacobian has magnitude lambda² R², and ray length dl = |d| d lambda.
Integrating the Cartesian unit delta along the ray therefore gives

    P(gamma,w) = hypot(R,w0)/L² delta(gamma-gamma0) delta(w-w0).

The detector averages line-integral values uniformly in gamma and w, just
as in the former midpoint quadrature. With angular cell width Dgamma =
channelApertureMm/R and axial width d, the cell value is

    P_jk = hypot(R,w0) / (L² Dgamma d) * a_j * b_k.

The aperture membership a or b is 1 inside the cell, 0 outside and 1/2 at
an exact cell boundary (the symmetric delta limit). At a corner, four cells
receive a quarter each. An outer detector boundary does not redistribute
the unacquired half into acquired cells. Float roundoff within 1e-10 cell
spacings is treated as an exact boundary. No sphere radius or numerical
subray quadrature is involved. At isocenter and w0=0 the full signal equals
1/(channelApertureMm*d) for touching, full-fill cells. If the aperture
is smaller than channel spacing, the even grid has a gap at isocenter:
a point there is not acquired. Detector aperture blur and interpolation remain.

The same acquired point projections feed CBA and RRI. All rebinning,
filtering, backprojection, detector-coverage rules, image-domain averaging,
native width crossings, plot colors and plot-opacity rules are retained.
The source contains no fit to measured SSPz or to nominal FWHM.

## Extraction and verification

The odd transverse grid contains the object location exactly; one sample
per slice is read at this location. Image matrix and local image extent
govern the displayed images, not the profile extraction area. Raw output
has the units of a unit-integral 3D response, not the unit-attenuation
sphere's reconstructed attenuation. Exports retain raw values, normalization
baselines, object definition and extraction definition.

`tests/point-response.mjs` checks the projection mass against an independent
solid-angle Jacobian, symmetric cell boundaries, lost support at the outer
detector edge, small-sphere volume-normalized projection limits, independence
from legacy bead/quadrature inputs, full-image versus point-only extraction,
weight-audit closure, angular closure and 4/80/160/320-row reconstructions.
Historical finite-sphere and axial regression suites remain separate.
These are implementation checks, not scanner validation. Sparse point data
can remain sensitive to acquired view sampling and z spacing; numerical
convergence must be checked for publication conditions before replacing
manuscript results. Existing finite-sphere verification files do not
establish convergence of this point-response model.
