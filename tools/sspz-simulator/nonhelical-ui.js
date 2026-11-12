let nonhelicalResult = null;

function syncNonhelicalPlaneControl() {
  const stationary = Number(form.elements.namedItem("beamPitch").value) === 0;
  document.getElementById("nonhelical-panel").hidden = !stationary;
  const row = form.elements.namedItem("nonhelicalRow");
  const rows = Math.max(1, Math.round(Number(form.elements.namedItem("rows").value)) || 1);
  row.max = String(rows);
  if (Number(row.value) > rows) row.value = String(rows);
  for (const id of ["nonhelical-plane-control", "nonhelical-step-control"]) {
    document.getElementById(id).hidden = !stationary;
  }
}

function setNonhelicalStatus(state, message) {
  nonhelicalResult = null;
  document.getElementById("nonhelical-csv").disabled = true;
  document.getElementById("nonhelical-metrics").replaceChildren();
  document.getElementById("nonhelical-summary").textContent = message;
  for (const id of ["nonhelical-diagram", "nonhelical-profile"]) {
    drawCanvasStatus(document.getElementById(id), message, "", state);
  }
}

function renderNonhelical({ diagram, response }) {
  const { config, profiles, z } = response;
  const { row, zPlane } = profiles[0];
  const geometryCanvas = document.getElementById("nonhelical-diagram");
  const coverageHalfWidth = ((config.rows - 1) * config.rowPitch + config.axialAperture) / 2;
  const trace = diagram.traceFamilies[0];
  const coverageLimit = Math.max(...trace.axial.map((height, i) =>
    Math.abs(height - zPlane) + coverageHalfWidth * trace.scales[i]));
  drawDiagram(geometryCanvas, {
    ...diagram,
    compactGeometry: true,
    coverageHalfWidth,
    xAxisLabel: localizedText("再構成面からの列中心位置 (mm)", "Row centre relative to the reconstruction plane (mm)"),
    yAxisLabel: localizedText("X線管角度 (°)", "Tube angle (°)"),
  }, "overview", Math.max(diagram.overviewXLimit, coverageLimit * 1.03));

  const canvas = document.getElementById("nonhelical-profile");
  let extent = config.rowPitch;
  for (const profile of profiles) {
    for (let i = 0; i < z.length; i += 1) {
      if (profile.profile[i] >= 0.001 * profile.peak) extent = Math.max(extent, Math.abs(z[i] - zPlane));
    }
  }
  const xAxis = symmetricNiceAxis(extent * 1.07, 3);
  const plot = axisContext(canvas, { xMin: xAxis.xMin, xMax: xAxis.xMax, yMin: 0, yMax: 1.06 }, {
    x: localizedText("再構成面からの体軸位置 (mm)", "Axial position relative to the reconstruction plane (mm)"),
    y: localizedText("相対応答", "Relative response"),
    leftMargin: 132,
    xFormatter: xAxis.formatter,
    yFormatter: value => value.toFixed(2),
  });
  drawAxes(plot, xAxis.ticks, [0, 0.25, 0.5, 0.75, 1]);
  const { ctx, x, y, margin, innerWidth, innerHeight } = plot;
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, innerWidth, innerHeight);
  ctx.clip();
  ctx.strokeStyle = MUTED;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(x(xAxis.xMin), y(0.5));
  ctx.lineTo(x(xAxis.xMax), y(0.5));
  ctx.stroke();
  const metrics = document.getElementById("nonhelical-metrics");
  metrics.replaceChildren();
  profiles.forEach((profile, index) => {
    const color = index ? "#9b3d18" : "#14578a";
    ctx.strokeStyle = color;
    ctx.lineWidth = 3.2;
    ctx.setLineDash(index ? [12, 6] : []);
    const values = Float64Array.from(profile.profile, value => value / profile.peak);
    strokeNativeProfile(ctx, z, values, value => x(value - zPlane), y);
    const item = document.createElement("li");
    item.style.color = color;
    const width = profile.fwhm === null ? "—" : profile.fwhm.toFixed(3) + " mm";
    const edge = (100 * profile.edgeFraction).toFixed(1) + "%";
    const location = index
      ? localizedText(`破線：中心外 ${profile.radius} mm`, `Dashed: ${profile.radius} mm off centre`)
      : localizedText("実線：回転中心", "Solid: isocentre");
    item.textContent = localizedText(`${location} / FWHM ${width} / 端列代用 ${edge}`,
      `${location} / FWHM ${width} / end-row substitution ${edge}`);
    metrics.append(item);
  });
  ctx.restore();
  geometryCanvas.dataset.renderState = "ready";
  canvas.dataset.renderState = "ready";
  document.getElementById("nonhelical-summary").textContent = localizedText(
    `再構成面 z₀ = ${zPlane.toFixed(3)} mm（列 ${row + 1} / ${config.rows}）、評価半径 ${config.radii.at(-1)} mm`,
    `Reconstruction plane z₀ = ${zPlane.toFixed(3)} mm (row ${row + 1} / ${config.rows}), evaluation radius ${config.radii.at(-1)} mm`,
  );
  nonhelicalResult = response;
  document.getElementById("nonhelical-csv").disabled = false;
}

function downloadNonhelicalCsv() {
  if (!nonhelicalResult) return;
  const { config, version, z, profiles } = nonhelicalResult;
  const { row, zPlane } = profiles[0];
  const rows = [
    ["# model", version],
    ["# reconstruction_plane_mm", zPlane],
    ["# reconstruction_row_1_based", row + 1],
    ...Object.entries(config).filter(([key, value]) => key !== "radii" && typeof value === "number")
      .map(([key, value]) => ["# " + key, value]),
    ["# radius_mm", ...profiles.map(q => q.radius)],
    ["# fwhm_mm", ...profiles.map(q => q.fwhm ?? "")],
    ["# end_row_substitution_fraction", ...profiles.map(q => q.edgeFraction)],
    ["z_relative_to_plane_mm", ...profiles.map(q => `sspz_r${q.radius}_peak_normalized`)],
    ...Array.from(z, (value, i) => [value - zPlane, ...profiles.map(q => q.profile[i] / q.peak)]),
  ];
  downloadBlob(`sspz_nonhelical_row_${row + 1}.csv`, "\uFEFF" + rows.map(values => values.map(csvEscape).join(",")).join("\r\n"));
}
