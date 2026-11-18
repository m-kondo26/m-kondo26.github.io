import { DEFAULT_PARAMS, tableFeedMm } from "./sim-core.js";

const ACQUISITION_TURN = 2 * Math.PI;
const ACQUISITION_RADIANS = Math.PI / 180;
const ACQUISITION_TRACK_STEPS = 180;

export function createAcquisitionPlayback(params = {}) {
  const rows = Number(params.rows ?? DEFAULT_PARAMS.rows);
  const rowWidth = Number(params.rowWidth ?? DEFAULT_PARAMS.rowWidth);
  const radius = Number(params.radius ?? DEFAULT_PARAMS.radius);
  const sourceRadius = Number(params.sourceRadius ?? DEFAULT_PARAMS.sourceRadius);
  const detectorDistance = Number(params.focalSourceDetectorMm ?? params.detectorDistance ?? 1070);
  const beamPitch = Number(params.beamPitch ?? DEFAULT_PARAMS.beamPitch);
  const rotationTime = Number(params.rotationTime ?? 0.5);
  const fullFanAngleDeg = Number(params.fullFanAngleDeg ?? 50);
  const start = Number(params.startAngleDeg ?? Number(params.phase ?? 0) / ACQUISITION_RADIANS);

  if (!Number.isInteger(rows) || rows < 1 || rows > 320) {
    throw new RangeError("rows: integer between 1 and 320");
  }
  if (![rowWidth, sourceRadius, detectorDistance, rotationTime].every(n => Number.isFinite(n) && n > 0)) {
    throw new RangeError("row width, scanner distances and rotation time must be positive");
  }
  if (!Number.isFinite(radius) || radius < 0 || radius >= sourceRadius || detectorDistance <= sourceRadius) {
    throw new RangeError("evaluation radius must be inside the source orbit and detector distance must exceed the source radius");
  }
  if (!Number.isFinite(beamPitch) || beamPitch < 0 || beamPitch > 3) {
    throw new RangeError("beam pitch must be between 0 and 3");
  }
  if (!Number.isFinite(fullFanAngleDeg) || fullFanAngleDeg <= 0 || fullFanAngleDeg >= 180 || !Number.isFinite(start)) {
    throw new RangeError("valid full fan angle and tube start angle required");
  }

  const tableFeed = tableFeedMm({ beamPitch, rows, rowWidth });
  const centerRowIndex = (rows - 1) / 2;
  // The stationary SSPz calculation uses a 1-based reconstruction row in the form.
  // Its blank setting selects the upper middle row of an even-row detector.
  const requestedRow = Number(params.nonhelicalRow ?? 0);
  const selectedRow = requestedRow === 0 ? Math.floor(rows / 2) + 1 : requestedRow;
  if (beamPitch === 0 && (!Number.isInteger(selectedRow) || selectedRow < 1 || selectedRow > rows)) {
    throw new RangeError("stationary reconstruction row is outside the detector");
  }
  const referenceZ = beamPitch === 0
    ? (selectedRow - 1 - centerRowIndex) * rowWidth
    : Number(params.referenceZ ?? params.zReference ?? 0);
  const startAngleDeg = ((start % 360) + 360) % 360;
  const initialBeta = startAngleDeg * ACQUISITION_RADIANS;
  const halfFan = fullFanAngleDeg * ACQUISITION_RADIANS / 2;
  const rowOffsets = Array.from({ length: rows }, (_, row) => (row - centerRowIndex) * rowWidth);
  const detectorScale = detectorDistance / sourceRadius;

  // The evaluation point is at (radius, 0). Its ray direction in screen
  // coordinates advances monotonically with the clockwise tube angle.
  const directionOffset = beta => Math.atan2(radius * Math.sin(beta), sourceRadius - radius * Math.cos(beta));
  const initialDirectionOffset = directionOffset(initialBeta);
  const halfDetectorWidth = rows * rowWidth / 2;
  const envelope = halfDetectorWidth * Math.max(detectorScale, 1 + radius / sourceRadius);
  const limits = [Math.min(-envelope, referenceZ), Math.max(tableFeed + envelope, referenceZ)];
  const margin = (limits[1] - limits[0]) * 0.06;
  const domain = [limits[0] - margin, limits[1] + margin];
  if (!domain.every(Number.isFinite)) {
    throw new RangeError("invalid longitudinal extent");
  }

  function frame(fraction, moving) {
    if (!Number.isFinite(fraction)) throw new RangeError("drawing progress must be finite");
    const progress = Math.max(0, Math.min(1, fraction));
    const sourceDeg = 360 * progress;
    const beta = initialBeta + ACQUISITION_TURN * progress;
    const offset = directionOffset(beta);
    const directionDeg = (progress === 0 || progress === 1)
      ? sourceDeg : sourceDeg + (offset - initialDirectionOffset) / ACQUISITION_RADIANS;
    const sourceX = sourceRadius * Math.cos(beta);
    const sourceY = sourceRadius * Math.sin(beta);
    const dx = radius - sourceX;
    const dy = -sourceY;
    const distance = Math.hypot(dx, dy);
    const sourceZ = moving ? tableFeed * progress : 0;
    // The physical detector follows the focal spot's translation. At the
    // evaluation line, similar triangles scale its offsets by distance / D.
    const detectorZ = rowOffsets.map(z => sourceZ + z * detectorScale);
    const intersections = rowOffsets.map(z => sourceZ + z * distance / sourceRadius);
    return {
      sourceX, sourceY, detectorX: sourceX + dx * detectorDistance / distance,
      detectorY: sourceY + dy * detectorDistance / distance,
      distance, sourceDeg, directionDeg, sourceZ, detectorZ, intersections, beta,
      detectorBeyondTarget: detectorDistance > distance,
      withinFan: Math.abs(offset) <= halfFan + 1e-12,
    };
  }

  const makeTrack = moving => Array.from(
    { length: ACQUISITION_TRACK_STEPS + 1 },
    (_, step) => frame(step / ACQUISITION_TRACK_STEPS, moving),
  );
  const baseline = makeTrack(false);
  let movingTrack;
  function track(moving) {
    if (!moving || tableFeed === 0) return baseline;
    movingTrack ??= makeTrack(true);
    return movingTrack;
  }

  return {
    rows, rowWidth, radius, sourceRadius, detectorDistance, tableFeed, rotationTime,
    referenceZ, domain, fullFanAngleDeg, startAngleDeg, baseline, track, frame,
    detectorBeyondTarget: detectorDistance > sourceRadius + radius,
    targetWithinFan: Math.asin(radius / sourceRadius) <= halfFan + 1e-12,
  };
}
