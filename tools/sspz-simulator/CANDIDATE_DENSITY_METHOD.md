# Candidate-count distributions within FWHM and FWTM

Feature/core version: **2026-09-30.1**. The SSPz response operator remains **2026-09-24.1**. This feature adds a geometrical count analysis; it does not change the SSPz calculation.

## Population and coordinate

At the current in-plane evaluation position `(radius, 0)`, the analysis counts geometrical **rebinned detector-row centres before interpolation selection and weighting**. All centres inside the declared response window count, including points with zero interpolation weight or signal. The two populations are:

- **Direct only:** own-direction real-data centres (`direction = 0`).
- **Direct + complementary:** the union of direct and complementary roles (`direction = 0` and `1`) within the same finite acquired-source support.

The complementary role reassigns acquired data; it does not create another acquisition. The identity retained by this reduced geometrical representation is the rebinned view, focal trajectory, and detector row. Repeated identities are counted once. Coincident focal trajectories at zero z-FFS offset are also counted once. These are not counts of independent raw-view/channel records or photons.

The physical coordinate is `z − zObject`, in millimetres. The SSPz series supplies its native grid in this coordinate, and each row centre is translated by the same `zObject`. No FWHM/FWTM midpoint alignment, width rescaling, or conversion to a dimensionless position is applied. One radius is one evaluation position, not a complete XY map.

## Shared finite acquisition support

Both populations use `axialSourceWindow(config, zObject)`. With the declared full fan opening `Φ`, the current cone-model interval has width **360° + 2Φ**. In radians it is:

\[
\beta_{\min}=\phi+2\pi z_{\mathrm{Object}}/F-(\pi+\Phi),\qquad
\beta_{\max}=\phi+2\pi z_{\mathrm{Object}}/F+(\pi+\Phi),
\]

where `φ` is the acquisition start angle, `F = rows × rowWidth × beamPitch` is table feed per rotation, and `Φ` is converted to radians. `Φ` denotes the **full fan opening**, as explicitly defined by the current numerical model.

`sourceAxialGroups` supplies each rebinned direct/complementary group's source position, row spacing, actual source angle, and focal state. Equivalent helix turns are included only if their actual source angle lies in the finite interval. The entire nonzero acquired-view rebinning stencil from `axialSourceStencil` must also fit between the first and last acquired views. A centre is excluded if either necessary stencil endpoint falls outside that range. This gate is identical for direct-only and combined counts; the complementary display does not obtain a larger source range.

The source interval is centred on the **central target plane**. It is not extended independently for the FWHM or FWTM boundaries. Row centres are enumerated geometrically within this fixed interval, regardless of which ones the response operator later selects.

## Fixed response windows

The interface requires a complete series of **360 SSPz profiles** at the same evaluation position. It uses their mean on the unchanged native z grid. When the cached `mean` is absent, the arithmetic mean of the normalized profiles is computed. The mean is then min–max normalized, and the existing `fdkWidth` routine finds the bilateral crossings of the component containing the highest peak:

- FWHM: left and right crossings at 0.5.
- FWTM: left and right crossings at 0.1.

These four crossings are fixed for every counted direction/start-angle state and for both data populations. Individual profiles do not receive individual count windows. Complete bilateral crossings are required; the calculation rejects an absent response, an invalid native grid, or a FWTM window that does not contain FWHM.

For a group's row spacing `Δz`, origin `o` relative to `zObject`, and row index `j = 0, …, N − 1`, its centre is:

\[
z_j=o+\left(j-\frac{N-1}{2}\right)\Delta z.
\]

The count includes every `zj` between the fixed left and right crossings, with a numerical boundary tolerance of `10⁻¹⁰ mm`. Production code obtains the first/last eligible row indices with integer bounds rather than allocating or iterating over every row. It preserves all rows, including at 320-row inputs.

## Angular sampling and distribution

The Web interface evaluates start angles **0, 1, …, 359°** and output directions **0, 1, …, 359°**. The latter are the rebinned interpolation-target directions, not the original source angles used by the acquisition gate. This creates **129,600 observations per population/window**, each representing the count for **one direction in one start-angle state**. Counts are never summed over all directions before plotting.

The analysis grid is separate from the configured number of acquired views per turn. The full acquired-view stencil remains in the gate; changing the analysis direction grid does not downsample the acquired support. The result stores observations in start-major order:

`index = startIndex × angleSamples + directionIndex`.

The pooled distribution assigns equal weight to every direction/start-angle combination. It reports frequency, fraction, mean, minimum, maximum, and population standard deviation. Pooling summarizes variation magnitude but does not identify where in angle an extreme occurs, a period, or a phase. The complete observation export preserves those indices for further inspection.

## Plot and exports

The two panels share the candidate-count axis and the frequency-width scale. Blue denotes FWHM and orange FWTM. The outlined circle denotes the mean count. Each occupied integer count has a compact smoothed lobe with support of ±0.45 count; its maximum half-width is proportional to its observed fraction. The same smoothing and width scale apply to all four groups. An exact-frequency marker remains at the integer value, and an unobserved integer has no lobe. Interpolated lobe contours are display shapes, not observations of fractional candidate counts.

The output files are:

| File | Contents |
|---|---|
| 600-dpi PNG | Both panels, shared scales, fixed window bounds, and condition labels; 180-mm figure width with resolution metadata |
| SVG | The same figure as editable vector graphics |
| Integer-frequency CSV | Population, window, integer count, frequency, fraction, observation total, and fixed left/right window bounds |
| All-direction/start-angle CSV | One row per state, with absolute start/output-direction angles and the four counts |
| JSON | Configuration, coordinate origin, windows, complete count arrays, frequencies/statistics, version, and definitions |

The PNG/SVG labels display rounded numbers for readability; CSV/JSON retain full-precision window bounds and numerical statistics. Filenames contain row count, row width, pitch, thickness, and evaluation radius.

Preparing the SSPz series automatically starts counting from that cached series. Counting can be cancelled and restarted without another SSPz sweep. A settings change cancels the current job, preserves the old figure with its previous-condition label, and disables exports until a result for the current conditions is ready. Changing a playback frame does not recompute this pooled distribution.

## Verification and interpretation

Run `node tests/candidate-density.mjs` for the independent numerical audit. It uses an independent fan/cone formula, acquired-source gate, rebinning stencil, turn search, and explicit enumeration of every detector row. The audit compares complete frozen 360 × 360 conditions, stored integer frequencies/moments, direct/combined nesting, FWHM/FWTM nesting, angular symmetry, nonzero z origins, source-range endpoints, single-row and 320-row configurations, and coincident/noncoincident z-FFS trajectories. Existing SSPz calculation and playback checks remain separate.

This analysis expresses how many geometrical centres lie in the declared response windows. Equal counts can correspond to different local intervals, gaps, or clusters, so the distributions complement the scan diagrams. The windows depend on the declared response model and are not an independent geometry-efficiency measure. No local dose, noise reduction, motion-correction accuracy, commercial reconstruction weighting, or clinical performance follows from these counts alone.
