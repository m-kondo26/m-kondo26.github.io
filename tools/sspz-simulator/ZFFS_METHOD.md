# Optional axial flying focal spot model

Web release 2026-09-17.7; optional acquisition extension 2026-09-17.1.

The z-FFS switch is **off by default**. Enabling it changes acquired point data, candidate geometry, rebinning, interpolation weights and model SSPz together. A shared URL explicitly stores the switch and its geometry. Opening the base URL or resetting the controls starts with z-FFS off. Existing off results use the unchanged axial-response equations.

## Geometry and source

Mori I., *Antialiasing backprojection for helical MDCT*, Medical Physics 35 (2008), DOI [10.1118/1.2828403](https://doi.org/10.1118/1.2828403), Fig. 4 and Eqs. (19)–(22), describe alternating focal positions, isocentre interlacing and nonuniform off-centre sampling. The example distances R = 600 mm and source–detector distance D = 1072 mm motivate the editable default ratio M = D/R. Their shifted backprojection, image filtering and artifact results are **not** implemented or claimed here.

The explicit idealization is pure axial focal motion with a fixed cylindrical detector. Anode-related radial motion, exposure duration, focal-spot size, noise, motion and manufacturer timing are omitted. It is an explanatory acquisition model, not a scanner preset.

Let d be the detector-row pitch at isocentre, N the number of rows, V the **total actual acquisitions per turn**, h = N d p the table feed, and φ the start angle. A physical view v (including unwrapped negative indices) has:

- β_v = φ + 2πv/V;
- nominal axial source/detector origin b_v = hv/V;
- focal state A at even v and B at odd v;
- axial focal displacement δ_v = −δ for A, +δ for B;
- δ = a d / (1 − 1/M), where the default a = 0.25 is a one-sided isocentre offset in row pitches.

V is even. Each focus receives V/2 acquired views. No second exposure is fabricated at the same angle. The selectable view count does not double when the switch is enabled. For comparisons at fixed views per focal position, the user must explicitly double the **total** view count within the allowed range.

For the transverse object location (r, 0), the transverse ray length is L_v = √[(R cos β_v − r)² + (R sin β_v)²]. The centre of detector row k, projected onto that location, is

z_vk = b_v + δ_v(1 − L_v/D) + [k − (N−1)/2] d L_v/R.

At r = 0 the two hypothetical focal states at a common nominal angle differ by d/2 under the default displacement. Actual A/B acquisitions also have different angles and table positions. Away from isocentre, both row pitch and focal separation change with L_v; uniform doubling is not assumed. This formula follows directly by intersecting a ray from the displaced source with the fixed detector whose physical row pitch is Md. The pure-axial centre/meridional result agrees with Mori Eq. (20), rather than reproducing every feature of that scanner geometry.

## Acquired point response

The same unit-integral ideal point and finite detector cells as the off model are used. No sphere diameter is introduced. For object z_o, define γ = atan2(−r sin β_v, R − r cos β_v), w_ray = R(z_o − b_v − δ_v)/L_v and w_det = w_ray + δ_v/M. Membership in the fixed detector rows uses w_det, whereas ray length uses w_ray. For a cell containing the point ray the projection value is

P = √(R² + w_ray²) / [L_v² (aperture/R) d],

with the existing half-cell boundary convention. Transaxial channel spacing and active aperture remain distinct common inputs. No response is assigned to a detector gap.

## Rebinning, selection and SSPz

Rebin each focal state **separately** to common parallel angles using its neighboring actual exposures (view stride 2) and neighboring channels. Interpolating directly across alternating A/B samples would incorrectly treat focal displacement as a single continuous detector-row trajectory. The rebinned row geometry is evaluated for the target ray at its continuous source angle; linear rebinning remains an approximation at finite V.

At each opposing-angle pair there are four row families: A/direct, B/direct, A/opposing and B/opposing. The merged model selects the nearest bracketing samples from the union, splitting exact ties. RRI-equivalent interpolation uses linear row tents and normalizes across the four families. Available-row or strict-bracket policies remain explicit. This four-family extension is our stated model definition, not an algorithm reproduced from Mori. If the displacement is exactly zero, coincident focal trajectories collapse to the original full-view rebinning grid; the off response is recovered to floating-point precision.

Since Web 2026-09-18.7, selection uses the common finite SOURCE-angle window of 360° + 2Φ, where Φ is the full fan opening; see [AXIAL_RESPONSE_METHOD.md](AXIAL_RESPONSE_METHOD.md). Every nonzero within-focus rebinning stencil view must fit inside it. More than one eligible turn of a direction family may be present; all supported groups enter the same merged/row-tent rule. This replaces the old one-turn rebinned cutoff. The fixed point with moving evaluation plane, rectangular T average, normalization and native-sample width measurement remain unchanged. The focal-state sequence is fixed relative to the acquired view index as the start angle changes through 360 conditions. Full 3D FBP, image reconstruction, scanner validation, and a proof of artifact suppression remain outside scope.

## Linked diagrams and exports

The four panels show A, B, A+B and selected acquired-data weights on identical axes. They show physical acquired angles, not rebinned angles. The angle origin β_ref is the start of the slice-centred acquired-angle window; angles fold into 0–360°, but samples retain their unwrapped view index and turn identity. The angular viewport can be 10°, 60° or 360°. The red line is the target point's axial position.

For panel (d), weights are traced back through within-focus angle/channel interpolation and the T average to actual acquired cells. The plotted row weight sums the channels and includes the angular averaging factor; intensity scales from zero to the displayed maximum stated below the panel. It is a weight, not a signal contribution or SSPz amplitude. CSV, Excel and JSON retain the separate cell coefficients, focus, row, channel, unwrapped view, actual source position and acquired point value. Multiplying each coefficient by the angular factor and cell value, then summing, reproduces the unnormalized centre response. The sum includes data outside a zoomed viewport. JSON also retains the intermediate rebinned weights.

600-dpi PNG uses the same renderer as the screen. Numeric export retains unrounded values. Display precision is not an accuracy claim.

## Verification and limits

`tests/zffs.mjs` checks 183 groups: independent Cartesian ray geometry; the centre/meridional focal-separation formula; negative-view parity; same-focus rebin stencils; exhaustive four-family weights; a direct response oracle; omitted/false and zero-displacement regression; 48 cases across 4/80/160/320 rows, r = 0/102/250 mm, T = 1/5 mm and both interpolation rules; selected-phase/series identity; and acquired-cell trace closure. Results are recorded in `tests/zffs-verification.json`.

These tests establish implementation consistency under the declared model. They do not establish numerical convergence for a manuscript, reproduce a clinical scanner, or show that adding z-FFS always improves SSPz. Existing questions about the full-turn angular support, detector-edge normalization and publication calculation conditions remain separate. The two focus families have fewer angular samples each at a fixed total V; angular undersampling must not be interpreted as an intrinsic focal-switching effect.
