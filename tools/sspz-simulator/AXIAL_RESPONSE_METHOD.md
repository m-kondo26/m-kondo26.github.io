# Shared axial interpolation response — 2026-09-18.7

The public model compares candidate selection and longitudinal interpolation, using the same acquisition operator. It is called a **model SSPz / axial interpolation response**, not a reconstructed-image SSP from full 2D or 3D filtered backprojection (FBP). A three-dimensional cone-ray geometry does not, by itself, imply that three-dimensional image reconstruction has been performed.

## Scope and common quantities

Both cone models use the same fixed, unit-integral ideal point at `(r, 0, z0)`, source helix, cylindrical detector cells, acquired views, rowwise fan-to-parallel rebinning, finite source-angle support, axial averaging width T, normalization, and native-sample width crossings. An optional nondivergent parallel reference is a separate acquisition assumption; it is not a fan-beam image reconstruction.

No finite sphere is used. Active transaxial aperture and channel-center spacing remain separate physical parameters, specified at isocenter. Axial active aperture equals the row spacing in this idealized detector. There is no transverse image grid, reconstructed image volume, transverse ramp convolution, cone-FBP preweight, or inverse-distance FBP weight. Angular aggregation at a fixed transverse point remains; it should not be described as the absence of every operation resembling backprojection.

## Acquisition and coordinates

For source radius R, table feed h = N d p per turn, base phase beta0, and acquired view index v:

```
beta_v = beta0 + 2 pi v / V
S_v = (R cos beta_v, R sin beta_v, h v / V)
L = sqrt((R cos beta_v - r)^2 + (R sin beta_v)^2)
gamma = atan2(-r sin beta_v, R - r cos beta_v)
w = R (z0 - S_v,z) / L
```

The point's cell-averaged projection is zero outside the detector cells containing `(R gamma, w)`. Its nonzero amplitude is `sqrt(R^2 + w^2) / (L^2 Delta_gamma d)`, where `Delta_gamma = active_aperture/R`. This is the analytic detector-cell integral of a Cartesian point, including its coordinate Jacobian; see [POINT_RESPONSE_METHOD.md](POINT_RESPONSE_METHOD.md). Exact aperture edges split the mass symmetrically. Detector gaps do not acquire or redistribute that mass.

For rebinned angle theta and transverse target `(x,y)`:

```
t = -x sin theta + y cos theta
gamma = asin(t/R)
beta = theta + gamma
L = sqrt(R^2-t^2) - x cos theta - y sin theta
z_i(theta) = h (beta-beta0)/(2 pi) + (i-(N-1)/2) d L/R
```

Rebinning linearly reads the two neighboring acquired angles and channels; row identity is retained. The pair at theta and theta+pi shares a transverse direction, but its 3D rays need not be collinear. No claim of exact 3D conjugacy is made. Rebinning itself is an approximation and is shared by the two cone models.

## Explicit interpolation alternatives

1. **Merged bracketing pair:** enumerate acquired row centers from both directions and select the nearest positions below and above evaluation z. Their linear coefficients are `(z_hi-z)/(z_hi-z_lo)` and `(z-z_lo)/(z_hi-z_lo)`. Coincident rows split the endpoint coefficient equally. A missing bracket is an unsupported condition.
2. **RRI-equivalent row interpolation:** for each source-supported direction and turn, use its fractional row coordinate f. Each acquired row has compact weight `max(0,1-|f-i|)`. Normalize these weights over the supported groups. With two complete brackets, this is the mean of the two ordinary linear interpolants. More than two groups can fall inside the declared source interval. Omitting unavailable rows and renormalizing is an explicitly added edge policy, not a claimed scanner implementation. The optional strict policy requires complete row brackets in each group receiving nonzero weight. A single row is allowed, but a row tent without support remains an error; it is not extrapolated.

The second alternative uses the linear RRI reference discussed by Hsieh et al. (2007). It does not implement their quadratic CBA algorithm. The first uses the generalized neighboring-sample interpolation concept discussed by Hu (1999), in the shared rebinned geometry defined above; it is not an unchanged reproduction of the earlier browser's acquired-angle implementation.

**A difference between these two cone-model outputs is a difference in selection/interpolation under common geometry. It is not evidence of geometry alone, nor a generic 2D-versus-3D reconstruction effect.**

## Moving-plane response and averaging

The point and its acquired data stay fixed while evaluation z moves. The output-direction lattice has V directions, represented numerically as V/2 opposite-direction pairs. Its fixed origin is the first theta sample at or above `beta0 + 2 pi z0/h - pi`. This output lattice does not restrict acquired source angles.

At each evaluation z, define the source-angle centre `beta_c = beta0 + 2 pi z/h`. For full fan opening Phi, use the finite acquisition interval

```
beta_c - (pi + Phi) <= beta <= beta_c + (pi + Phi)
total span = 360 degrees + 2 Phi
```

Phi is the FULL opening, not the individual ray angle gamma nor the half-fan angle. It is a common input, default 50 degrees (a model choice, not a scanner specification). Changing evaluation radius does not change Phi. The point must lie within this opening. For the nondivergent reference, effective Phi is zero.

For each direction family, enumerate only integer turns inside this interval. Keep a rebinned candidate only when every nonzero acquired-angle interpolation stencil entry is also inside it. Actual source views are the integer grid points inside the closed interval; endpoints are not rounded outward. Focal switching uses the same rule with its within-focus stencil. No additional z-distance or T-based cutoff is imposed. The nearest lower and upper rows are selected from this finite set, or an explicit coverage error is returned. Large pitch does not authorize an unlimited-turn search.

The finite envelope is motivated by Toki's classical opposing-beam interpolation description, Figs. 4–6 of [EP0450152B1](https://patents.google.com/patent/EP0450152B1/en): a central turn plus a full-fan interval on either side. Its application to the present multirow reduced model is an explicit modelling choice, not a universal support theorem for all multislice reconstruction algorithms.

With `P_k` the unfiltered rebinned acquired response:

```
A_m(z) = (2/V) sum over fixed direction pairs [sum_k w_m,k(z) P_k]
B_m(z) = (1/T) integral from z-T/2 to z+T/2 A_m(u) du
```

For T=0 in the numerical API, B=A. The browser uses its single configured thickness T as the rectangular averaging width. FWHM is an output and is never fitted to T. Candidates are reselected at every evaluation u before averaging. The numerical integral is exact for the piecewise-linear sampled A(u), not necessarily for the underlying continuous acquisition/interpolation process. Axial grid and acquired-view convergence therefore still matter.

The published browser no longer uses the former finite-K Taguchi shifted sum. Taguchi and Aradate's filter-interpolation concept motivates averaging longitudinal interpolants, but the current continuous piecewise-linear integral is a declared numerical choice. The former finite-K API and full FBP APIs remain available in their unchanged source modules for reproducing historical results. The previous rebinned-one-turn axial calculation is retained only as explicit numerical API option `candidateSearch: 'one-turn'`; the browser uses `source-fan-window`. This support correction can change candidates, weights, profiles and widths, and is not merely a display change.

The output half-domain is `max(1 mm, T + 2d(1+r/R))`, plus the padding required for the integral. The calculation checks both width crossings and response tails; it does not silently accept a cropped response. An object entirely in inactive detector space produces geometry-only output and no invented width.

Each curve is independently min–max normalized by default; peak-only normalization is optional. FWHM and FWTM use linear native-sample crossings. All 360 start phases, separated by 1 degree, use a fixed object position. This is not the former sweep of object position through one table feed.

## Book consistency and limits

The source-ray and virtual-flat-detector formulas were checked against the supplied Chapter 3, *3D cone-beam projection and image reconstruction*, printed pp. 75–111. In particular, Eqs. (3-32) and (3-62) describe the same rays after `beta_book=beta_code-pi/2`, `X_book=-u_code`, and `Z_book=v_code`; cylindrical detector height is `w=v cos gamma`. Equal sampling on a flat detector is not the same sampling as equal angular channels on a cylinder.

The chapter separates FDK projection preweighting, transverse ramp filtering, and weighted backprojection in Eqs. (3-69)–(3-71), printed p.88; the program on pp.107–111 uses the same three stages. Those are essential to the chapter's image reconstruction and are intentionally outside this reduced response. We therefore do not call this model FDK. The chapter's circular-orbit FDK derivation does not independently validate helical RRI, a wide cone, the edge extension, or our simplified response. Circular cone-beam data sufficiency and image artifacts cannot be assessed with this model.

## Verification and version boundary

### Interactive playback (Web 2026-09-18.1)

Playback is a display audit and does not alter the SSP calculation. The plane
sweep keeps the start phase and the centre of the T window fixed, moves an
evaluation plane from -T/2 to +T/2, and displays its selected candidates. A
second panel accumulates the native-grid piecewise-linear integral from -T/2
to the moving plane, always dividing by the full T. Its last frame reproduces
the existing full-window coefficients. The SSP panel always shows the final
full-view, full-T profile, not a partially accumulated or display-sampled SSP.

The start-angle mode compares the already calculated acquisition conditions,
one degree per frame. It is not tube rotation within one scan. The animation
has its own labelled start angle; a button applies it to the other figures.
Playback is off until requested. Since Web 2026-09-18.6, both modes loop from
the last frame to the first until paused. A hidden page, changed settings,
new calculation, or error also stops playback. Manual frame stepping remains
bounded at the first and last frames. The display-angle lattice
is closed under a half-turn, so both roles of the same rebinned view/row are
retained. The side filter shows direct or complementary uses at every output
direction. Role weights are accumulated over full T, before angular averaging.
Optional z-FFS retains focal-state identity.

`tests/axial-animation.mjs` checks native-integral coefficients, partial-window
normalization, direct/complementary role sums, exact agreement with existing
weight audits, focal switching, multirow cases, cancellation and non-mutation.
These are display/implementation checks, not scanner validation.

Historical Web 2026-09-18.4 aligned both members of an interpolation pair
at the reference member's rebinned angle. Direct trajectories/circles are
solid; complementary trajectories/triangles are dashed. The own-angle
switch introduced in Web 2026-09-18.3 was removed because its all-solid
background obscured the complementary relationship. Data identities,
coefficients and numerical profiles are unchanged. The selected pair is
boxed and each member's own angles remain available in the numeric table.
Under this code's sign convention beta = theta + gamma. Beta is a rebinning
query angle, generally evaluated using neighboring acquired source views.
The plot folds angle offsets relative to a fixed centre-turn reference; its
zero is not tube angle zero. However, this half-turn display did not let readers
check the interpolation at every output direction. It was superseded by the
full-turn directional display described below; the older display must not be
interpreted as half-scan reconstruction. Numerical model/worker files are unchanged.

`tests/axial-response.mjs` checks independent all-row weight enumeration, Cartesian rays from the chapter, direct all-row response summation, exact response/weight-trace closure, selected-phase/series identity, and 4/80/160/320-row cases. These establish implementation consistency, not clinical or scanner validation. Results and cases are in `tests/axial-response-verification.json`.

Excel/CSV retain unrounded values. The selected-weight sheet stores unfiltered rebinned data and a separate angular-mean factor: summing `weight * unfiltered_acquired_value * angular_mean_factor` reproduces the target point's unnormalized response after T averaging. Diagram markers subsample angles for legibility; the export retains all computed weights.

URL schema v11 and model version 2026-09-17.6 identify this change. Old URLs load the acquisition settings with a notice and recalculate the new response. Old FBP numbers, old finite-K axial numbers, and manuscript figures must not be silently interpreted as current-model results. No manuscript figures were regenerated in this update.

## Primary sources

- Hsieh J et al. *Conjugate cone-beam reconstruction algorithm.* Optical Engineering. 2007;46:067001. [doi:10.1117/1.2746866](https://doi.org/10.1117/1.2746866). SSP/interpolation concept, row rebinning, and RRI comparison; not validation of all added assumptions above.
- Hu H. *Multi-slice helical CT: Scan and reconstruction.* Medical Physics. 1999;26:5–18. [doi:10.1118/1.598470](https://doi.org/10.1118/1.598470).
- Taguchi K, Aradate H. *Algorithm for image reconstruction in multi-slice helical CT.* Medical Physics. 1998;25:550–561. [doi:10.1118/1.598230](https://doi.org/10.1118/1.598230).
- Toki Y. *Computerized tomographic imaging method and apparatus utilizing data interpolation for helical scanning.* [EP0450152B1, Figs. 4–6](https://patents.google.com/patent/EP0450152B1/en). Source-angle support for classical opposing-beam interpolation; not validation of this entire reduced model.
- Kudo H et al. *Exact and approximate algorithms for helical cone-beam CT.* Physics in Medicine and Biology. 2004;49:2913–2931. [doi:10.1088/0031-9155/49/13/011](https://doi.org/10.1088/0031-9155/49/13/011). Background on exact and approximate reconstruction; this model does not implement its exact reconstruction.

The supplied textbook scan is not redistributed by this website.

## Historical paired unwrapped display (Web 2026-09-17.8; superseded below)

With z-FFS off, the overview and weight detail use a common direct-side rebinned angle. Solid curves/circles refer to theta; dashed curves/triangles refer to theta+pi. Each family's row positions use its own source z and ray length L from the equations above. The complementary family is not a copy of the direct family's z coordinates, and theta+pi does not imply an exact pi difference between the original fan-beam source angles. Both families retain complete visible geometric turns independently of the selected-weight support.

Previously, the same data were shown only at their own rebinned angles, so the complementary family was not separately visible. This display revision restores the paired reading of the diagram without changing acquisition, interpolation, averaging, normalization or width calculations. Beam pitch remains h/(N d); local row spacing in the off-centre diagram is d L/R.

The additional `weightAudit.pairedSamples` / Excel `Paired_weights` audit retains reference pair, direction, rebinned view, detector row, and the coefficient integrated over T. Summing it by rebinned view and row recovers the original `Selected_weights` audit. A datum reused in different reference pairs stays distinct in the diagram. Either complete audit, multiplied by the corresponding data values and angular-mean factor, reproduces the central raw response; the two audits must not be added together. Markers are subsampled by reference angle only for drawing. JSON and Excel retain all coefficients.

`tests/axial-paired-diagram.mjs` checks both families against independently evaluated ray coordinates, complete visible turns, marker identity, coefficient partition and response closure. The z-FFS A/B display retains its separate physical-view coordinates and focal-state encoding.


## Optional focal switching (Web 2026-09-17.7)

z-FFS is off by default. When enabled, acquired point data, within-focus rebinning, four-family candidate weights and model SSPz use the new explicitly declared acquisition model. See [ZFFS_METHOD.md](ZFFS_METHOD.md) for equations, assumptions, the total-view-count definition and verification. The off response equations above remain unchanged.


## Full-turn directional display (Web 2026-09-18.5)

The numerical kernel retains V/2 opposing pairs and angular mean factor 2/V.
The display now expands each pair into both output interpolation directions over
0–360 degrees. The same physical rebinned view, focus, detector row, position and
coefficient are retained; the direct/complementary roles reverse at the opposite
output direction. Within the existing finite window, the opposing view may lie
at either +V/2 or -V/2. Complementary traces remain dashed and markers triangular.

Over the T window, contributions with the same output direction, role and
physical datum are summed before drawing. Distinct opposite-view identities are
retained in the exported lists. The full-direction angular mean factor is 1/V:
sum(weight * acquiredValue / V) reproduces the original pair-averaged response.
Directional_weights (Excel) and directionalWeightAudit (JSON) are alternative
representations of the existing audits; they must not be added to those audits.

The animation's direction selector covers the complete turn (with the stated
display-angle sampling). Its angle table uses the actual opposite view, including
negative half-turn offsets. The 360-degree endpoint repeats zero and is not an
additional direction. The ordinary diagram and animation share this convention.

This is a display and audit change. It is not half-scan image reconstruction,
does not add acquired views, and does not establish image reconstruction
sufficiency. The finite candidate-window selection is unchanged; the separate
question of nearby data excluded by that window was resolved separately in Web 2026-09-18.7, as specified above. This paragraph records the scope of the older display-only revision.

## Source-support verification (Web 2026-09-18.7)

`tests/source-support.mjs` independently enumerates all detector rows and eligible turns using Cartesian ray lengths and an acquired-source grid. It covers 1, 4, 80, 160 and 320 rows, three pitches, both interpolation rules, the parallel reference and optional focal switching. Unsupported cases must report missing support. It checks the user's recovered near datum, a direct acquired-data response oracle, one-row responses, and saved before/after profiles. Animation tests separately verify the exact T-integrated weights, physical identities and full-turn directional normalization. These are implementation and declared-model checks, not scanner validation or final manuscript convergence.
