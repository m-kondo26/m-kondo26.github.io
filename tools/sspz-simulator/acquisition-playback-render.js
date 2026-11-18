// One acquisition frame has the same row identity in all three panels.
const drawAcquisitionPlayback = (() => {
  const ink = "#173644";
  const muted = "#47616d";
  const grid = "#dfebef";
  const guide = "#8399a2";
  const ray = "#0b6779";
  const palette = ["#ad411a", "#866300", "#005993", "#00775b", "#a13160", "#61448c", "#456b20", "#5a5869"];
  const diagramLayers = new WeakMap();

  function canvasDimensions(canvas) {
    return {
      width: canvas.logicalWidth ?? canvas.width,
      height: canvas.logicalHeight ?? canvas.height,
    };
  }

  function rowColor(row, count) {
    if (count <= palette.length) return palette[row];
    return `hsl(${(12 + 312 * row / (count - 1)).toFixed(2)}, 72%, 35%)`;
  }

  function line(ctx, x1, y1, x2, y2, color, width = 1) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function dot(ctx, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fill();
  }

  function label(ctx, value, x, y, { color = ink, size = 14, align = "left", bold = false, background = false } = {}) {
    ctx.font = `${bold ? "600 " : ""}${size}px system-ui, sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    if (background) {
      const width = ctx.measureText(value).width;
      const left = align === "left" ? x : align === "right" ? x - width : x - width / 2;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillRect(left - 3, y - size * 0.56, width + 6, size * 1.12);
    }
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  }

  function clear(canvas) {
    const ctx = canvas.getContext("2d");
    const { width, height } = canvasDimensions(canvas);
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    return ctx;
  }

  function drawTransverse(canvas, model, frame, text) {
    const ctx = clear(canvas);
    const { width, height } = canvasDimensions(canvas);
    const { sourceRadius: radius, detectorDistance, fullFanAngleDeg } = model;
    const halfFan = fullFanAngleDeg * Math.PI / 360;
    const detectorExtent = Math.hypot(radius - detectorDistance * Math.cos(halfFan), detectorDistance * Math.sin(halfFan));
    const cx = width / 2;
    const cy = (height - 22) / 2;
    const scale = (Math.min(width, height - 22) / 2 - 26) / Math.max(radius, detectorExtent);
    // Rotate the transverse picture by a quarter turn, preserving clockwise
    // motion and the geometry relative to P. Physical 0° is on the +Y axis.
    const x = value => cx + scale * value;
    const y = value => cy - scale * value;
    const sx = x(frame.sourceY);
    const sy = y(frame.sourceX);
    const tx = cx;
    const ty = y(model.radius);
    const dx = x(frame.detectorY);
    const dy = y(frame.detectorX);
    const axis = frame.beta + Math.PI / 2;
    const reachesDetector = frame.detectorBeyondTarget && frame.withinFan;

    line(ctx, cx - radius * scale, cy, cx + radius * scale, cy, grid);
    line(ctx, cx, cy - radius * scale, cx, cy + radius * scale, grid);
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = "#9ab1bd";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * scale, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.arc(sx, sy, detectorDistance * scale, axis - halfFan, axis + halfFan);
    ctx.closePath();
    ctx.fillStyle = "#e4f1f4";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(sx, sy, detectorDistance * scale, axis - halfFan, axis + halfFan);
    ctx.strokeStyle = "#548e9c";
    ctx.lineWidth = 4;
    ctx.stroke();

    if (!reachesDetector) ctx.setLineDash([5, 4]);
    line(ctx, sx, sy, reachesDetector ? dx : tx, reachesDetector ? dy : ty, ray, 2.4);
    ctx.setLineDash([]);
    if (reachesDetector) dot(ctx, dx, dy, 3.5, ray);
    dot(ctx, cx, cy, 3.2, muted);
    dot(ctx, tx, ty, 4.4, ray);
    ctx.fillStyle = ink;
    ctx.fillRect(sx - 4.5, sy - 4.5, 9, 9);
    label(ctx, "O", cx - 7, cy + 14, { color: muted, align: "right" });
    label(ctx, "P", tx + 9, ty, { color: ray, bold: true });
    label(ctx, "+Y / 0°", cx, 12, { color: muted, align: "center", size: 13, bold: true });
    label(ctx, "+X", cx + radius * scale + 7, cy - 14, { color: muted, size: 13, bold: true });
    const centreDx = x(frame.sourceY - frame.sourceY / radius * detectorDistance);
    const centreDy = y(frame.sourceX - frame.sourceX / radius * detectorDistance);
    const detectorOnRight = centreDx > cx;
    label(ctx, text("検出器", "Detector"), centreDx + (detectorOnRight ? 10 : -10), centreDy,
      { color: muted, align: detectorOnRight ? "left" : "right", size: 13, background: true });
    const sourceOnRight = sx > cx;
    label(ctx, text("焦点", "Source"), sx + (sourceOnRight ? 10 : -10), sy,
      { align: sourceOnRight ? "left" : "right", size: 13, background: true });
    label(ctx, text("O 回転中心　 P 評価位置", "O Isocentre     P Target"), cx, height - 18,
      { color: muted, align: "center" });
  }

  function zTicks(min, max) {
    const target = (max - min) / 5;
    const unit = 10 ** Math.floor(Math.log10(target));
    const step = [1, 2, 2.5, 5, 10].find(value => value * unit >= target) * unit;
    const count = Math.floor(max / step + 1e-9) - Math.ceil(min / step - 1e-9) + 1;
    return Array.from({ length: count }, (_, index) => (index + Math.ceil(min / step - 1e-9)) * step);
  }

  function zAxes(ctx, canvas, model, text) {
    const { width, height } = canvasDimensions(canvas);
    const [min, max] = model.domain;
    const left = 62;
    const right = width - 22;
    const top = 37;
    const bottom = height - 54;
    const x = value => left + (value - min) / (max - min) * (right - left);
    for (const value of zTicks(min - model.referenceZ, max - model.referenceZ)) {
      const xx = x(value + model.referenceZ);
      line(ctx, xx, top, xx, bottom, grid);
      label(ctx, String(Number(value.toPrecision(8))), xx, bottom + 17, { color: muted, align: "center" });
    }
    if (model.referenceZ >= min && model.referenceZ <= max) {
      const xx = x(model.referenceZ);
      line(ctx, xx, top, xx, bottom, "#a7bdc6", 1.2);
    }
    line(ctx, left, bottom, right, bottom, guide);
    const zLabel = model.tableFeed === 0
      ? text("再構成面からの位置 z − z₀ (mm)", "Axial offset from the plane z − z₀ (mm)")
      : text("体軸位置 z (mm)", "Axial position z (mm)");
    label(ctx, zLabel, (left + right) / 2, height - 14, { align: "center", bold: true });
    return { x, left, right, top, bottom };
  }

  function drawLongitudinal(canvas, model, frame, text) {
    const ctx = clear(canvas);
    const { x, left, right, top, bottom } = zAxes(ctx, canvas, model, text);
    const depth = Math.max(model.detectorDistance, model.sourceRadius + model.radius);
    const depthY = distance => top + (bottom - top - 49) * distance / depth;
    const focusX = x(frame.sourceZ);
    const focusY = depthY(0);
    const detectorY = depthY(model.detectorDistance);
    const targetY = depthY(frame.distance);
    const rowWidth = model.detectorRowWidth;
    const halfRowWidth = rowWidth / 2;
    const edgeA = x(frame.detectorZ[0] - halfRowWidth);
    const edgeB = x(frame.detectorZ.at(-1) + halfRowWidth);
    const cellWidth = (edgeB - edgeA) / model.rows;
    const cellTop = detectorY - 7;
    const cellHeight = 14;
    const rowSize = Math.max(1.3, Math.min(4.2, cellWidth * 0.31));
    const numerous = model.rows > 24;

    ctx.setLineDash([5, 4]);
    line(ctx, left, targetY, right, targetY, guide, 1.3);
    ctx.setLineDash([]);
    ctx.save();
    ctx.beginPath();
    ctx.rect(left - 1, top - 7, right - left + 2, bottom - top);
    ctx.clip();
    // Draw each physical row aperture to scale along Z. The coloured ray and
    // dot identify only its centre; the cell height is schematic.
    ctx.globalAlpha = 0.18;
    for (let i = 0; i < model.rows; ++i) {
      ctx.fillStyle = rowColor(i, model.rows);
      ctx.fillRect(edgeA + i * cellWidth, cellTop, cellWidth, cellHeight);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = guide;
    ctx.lineWidth = 1;
    ctx.strokeRect(edgeA, cellTop, edgeB - edgeA, cellHeight);
    if (cellWidth >= 2.5) {
      for (let i = 1; i < model.rows; ++i) {
        const edge = edgeA + i * cellWidth;
        line(ctx, edge, cellTop, edge, cellTop + cellHeight, guide, 0.8);
      }
    }
    for (let i = 0; i < model.rows; ++i) {
      const color = rowColor(i, model.rows);
      const colX = x(frame.detectorZ[i]);
      const hitX = x(frame.intersections[i]);
      ctx.globalAlpha = numerous ? 0.29 : 0.88;
      if (!frame.withinFan) ctx.setLineDash([4, 4]);
      line(ctx, focusX, focusY, colX, detectorY, color, numerous ? 0.7 : 1.65);
      ctx.setLineDash([]);
      if (!frame.detectorBeyondTarget) {
        ctx.setLineDash([4, 4]);
        line(ctx, colX, detectorY, hitX, targetY, color, numerous ? 0.7 : 1.4);
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
      dot(ctx, colX, detectorY, Math.min(4, cellWidth * 0.24), color);
      dot(ctx, hitX, targetY, rowSize + 0.6, color);
      if (model.rows <= 10 && cellWidth > 13) {
        label(ctx, String(i + 1), colX, detectorY + 14, { color, align: "center", size: 12, bold: true });
      }
    }
    ctx.restore();

    if (cellWidth >= 18) {
      const midRow = Math.floor((model.rows - 1) / 2);
      const start = edgeA + midRow * cellWidth;
      const end = start + cellWidth;
      const level = detectorY + 26;
      line(ctx, start, level, end, level, muted);
      for (const edge of [start, end]) line(ctx, edge, level - 3, edge, level + 3, muted);
    }

    dot(ctx, focusX, focusY, 4.7, ink);
    label(ctx, text("焦点", "Source"), focusX, focusY - 15, { align: "center", size: 13, bold: true });
    label(ctx, text("評価位置 P の z 直線", "Z line at target P"), left + 4, targetY - 11,
      { color: muted, size: 12, background: true });
    const widthLabel = String(Number(rowWidth.toPrecision(3)));
    label(ctx, text(`検出器面での列幅 ${widthLabel} mm　● 列中心`, `Detector row width ${widthLabel} mm  ·  ● Row centre`),
      (left + right) / 2, detectorY + 39, { color: muted, size: 12, align: "center" });
  }

  function trackLayer(canvas, model, plot, moving, reference) {
    const { width, height } = canvasDimensions(canvas);
    const layer = canvas.ownerDocument.createElement("canvas");
    layer.width = canvas.width;
    layer.height = canvas.height;
    const ctx = layer.getContext("2d");
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    const track = model.track(moving);
    const numerous = model.rows > 24;
    ctx.globalAlpha = reference ? (numerous ? 0.28 : 0.74) : (numerous ? 0.48 : 1);
    ctx.lineWidth = numerous ? 0.7 : reference ? 1.35 : 2;
    const visible = frame => frame.detectorBeyondTarget && frame.withinFan;
    for (let row = 0; row < model.rows; row++) {
      ctx.strokeStyle = reference ? "#97a8ad" : rowColor(row, model.rows);
      const moveTo = sample => ctx.moveTo(plot.x(sample.intersections[row]), plot.y(sample.directionDeg));
      let dashed = reference || !visible(track[0]) || !visible(track[1]);
      ctx.setLineDash(dashed ? [4, 4] : []);
      ctx.beginPath();
      moveTo(track[0]);
      for (let i = 1; i < track.length; i++) {
        const nextDashed = reference || !visible(track[i - 1]) || !visible(track[i]);
        if (nextDashed !== dashed) {
          ctx.stroke();
          dashed = nextDashed;
          ctx.setLineDash(dashed ? [4, 4] : []);
          ctx.beginPath();
          moveTo(track[i - 1]);
        }
        ctx.lineTo(plot.x(track[i].intersections[row]), plot.y(track[i].directionDeg));
      }
      ctx.stroke();
    }
    return layer;
  }

  function drawUnwrapped(canvas, model, frame, moving, text) {
    const ctx = clear(canvas);
    const { width, height } = canvasDimensions(canvas);
    const plot = zAxes(ctx, canvas, model, text);
    const { x, left, right, top, bottom } = plot;
    const y = degree => top + (bottom - top) * degree / 360;
    for (let degree = 0; degree <= 360; degree += 60) {
      line(ctx, left, y(degree), right, y(degree), degree === 360 ? guide : grid);
      label(ctx, `${degree}°`, left - 8, y(degree), { align: "right", color: muted });
    }
    line(ctx, left, top, left, bottom, guide);
    ctx.save();
    ctx.translate(16, (top + bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    label(ctx, text("補間方向 θ（開始から）", "Rebinned direction from start"), 0, 0, { align: "center", bold: true });
    ctx.restore();

    let layers = diagramLayers.get(canvas);
    if (!layers || layers.model !== model || layers.width !== canvas.width || layers.height !== canvas.height
      || layers.logicalWidth !== width || layers.logicalHeight !== height) {
      layers = { model, width: canvas.width, height: canvas.height, logicalWidth: width, logicalHeight: height };
      diagramLayers.set(canvas, layers);
    }
    const plotLayer = { x, y };
    const mode = moving ? "moving" : "stationary";
    const cursor = y(frame.directionDeg);
    layers[mode] ??= trackLayer(canvas, model, plotLayer, moving, false);
    if (moving) {
      layers.reference ??= trackLayer(canvas, model, plotLayer, false, true);
      ctx.drawImage(layers.reference, 0, 0, width, height);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(left - 1, top - 1, right - left + 2, cursor - top + 1);
    ctx.clip();
    ctx.drawImage(layers[mode], 0, 0, width, height);
    ctx.restore();

    line(ctx, left, cursor, right, cursor, guide, 1.2);
    const markerSize = model.rows > 24 ? 1.8 : 4.1;
    frame.intersections.forEach((position, row) => dot(ctx, x(position), cursor, markerSize, rowColor(row, model.rows)));
    if (moving) {
      ctx.setLineDash([4, 4]);
      line(ctx, left, 17, left + 25, 17, "#97a8ad", 1.6);
      ctx.setLineDash([]);
      label(ctx, text("寝台静止時の軌跡", "Stationary-table trajectories"), left + 32, 17, { color: muted, size: 13 });
    }
  }

  return (canvases, model, fraction, moving, text) => {
    const translate = text ?? ((ja) => ja);
    const helical = moving && model.tableFeed > 0;
    const frame = model.frame(fraction, helical);
    drawTransverse(canvases.xy, model, frame, translate);
    drawLongitudinal(canvases.section, model, frame, translate);
    drawUnwrapped(canvases.diagram, model, frame, helical, translate);
    return frame;
  };
})();
