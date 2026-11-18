// Draw the position movie from the prepared series, using the screen player's axes and weights.
function createPositionExportRenderer({ series, displayProfiles, xLimit }, text) {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d", { alpha: false });

  const diagram = document.createElement("canvas");
  diagram.width = 1800;
  diagram.height = 1920;
  diagram.dataset.renderScale = "2";
  const background = document.createElement("canvas");
  background.width = 2000;
  background.height = 1400;
  const axes = positionProfileAxes(background, displayProfiles, series.profiles);
  drawPositionProfileGuides(axes);
  series.profiles.forEach((profile, index) => {
    fdkDrawLines(axes, displayProfiles[index].z, [profile.profile], "#89949e", { opacity: .13, lineWidth: 1.1 });
  });
  const profile = document.createElement("canvas");
  profile.width = background.width;
  profile.height = background.height;
  const profileState = { series, background, axes, displayProfiles };

  const ink = "#173644";
  const accent = "#0b6779";
  const muted = "#47616d";
  const rule = "#d6e3e8";
  const margin = 64;
  const contentWidth = canvas.width - 2 * margin;
  const format = new Intl.NumberFormat(document.documentElement.lang || "ja", {
    maximumFractionDigits: 4,
    useGrouping: false,
  });
  const { config, profiles } = series;
  const count = profiles.length;
  const title = text("評価位置と開始角度で、展開図・SSPzはどう変わる？",
    "How do position and start angle affect geometry and SSPz?");
  const subtitle = text(`評価位置 r = ${format.format(config.radius)} mm で ${count} 通りの開始角度を比較します。`,
    `Compare ${count} start-angle conditions at an evaluation position of r = ${format.format(config.radius)} mm.`);
  const diagramTitle = text("データ配置と補間重み", "Data geometry and interpolation weights");
  const profileTitle = text("同じ評価位置のSSPz", "SSPz at the same evaluation point");
  const conditions = [
    text(`検出器 ${config.rows} 列 × ${format.format(config.rowWidth)} mm`,
      `Detector rows ${config.rows} × ${format.format(config.rowWidth)} mm`),
    text(`ビームピッチ ${format.format(config.beamPitch)}`, `Beam pitch ${format.format(config.beamPitch)}`),
    text(`1回転あたり ${config.viewSamples} ビュー`, `${config.viewSamples} views/turn`),
    text(`設定厚 T = ${format.format(config.axialAverageMm)} mm`,
      `Configured thickness T = ${format.format(config.axialAverageMm)} mm`),
    fdkInterpolationLabel(config),
    config.zFfsEnabled && text("z-FFSあり", "z-FFS on"),
  ].filter(Boolean).join("  |  ");

  const diagramWidth = 662;
  const diagramHeight = diagramWidth * diagram.height / diagram.width;
  const diagramX = margin + 14;
  const profileWidth = 956;
  const profileHeight = profileWidth * profile.height / profile.width;
  const profileX = canvas.width - margin - profileWidth;
  const chartY = 224;
  const profileY = chartY + (diagramHeight - profileHeight) / 2 - 8;

  function write(label, x, y, size, { color = ink, weight = 400, align = "left", maxWidth = contentWidth } = {}) {
    ctx.font = `${weight} ${size}px system-ui, sans-serif`;
    const width = ctx.measureText(label).width;
    if (width > maxWidth) ctx.font = `${weight} ${size * maxWidth / width}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y);
  }

  let lastIndex = -1;
  function draw(index) {
    if (index !== lastIndex) {
      const selected = positionFrameResult(series, index);
      drawDiagram(diagram, positionFrameScene(selected, xLimit), "zoom", xLimit);
      drawPositionSeriesProfile(profile, profileState, index);
      lastIndex = index;
    }

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    write(title, margin, 77, 55, { weight: 700 });
    write(subtitle, margin, 142, 28, { color: muted });
    ctx.fillStyle = rule;
    ctx.fillRect(margin, 176, contentWidth, 2);
    write(diagramTitle, diagramX + diagramWidth / 2, 207, 34,
      { align: "center", weight: 650, maxWidth: diagramWidth });
    write(profileTitle, profileX + profileWidth / 2, 207, 34,
      { align: "center", weight: 650, maxWidth: profileWidth });
    ctx.drawImage(diagram, diagramX, chartY, diagramWidth, diagramHeight);
    ctx.drawImage(profile, profileX, profileY, profileWidth, profileHeight);

    const p = profiles[index];
    const widths = [
      Number.isFinite(p.fwhm?.width) && `FWHM ${p.fwhm.width.toFixed(2)} mm`,
      Number.isFinite(p.fwtm?.width) && `FWTM ${p.fwtm.width.toFixed(2)} mm`,
    ].filter(Boolean);
    if (widths.length) write(widths.join("  |  "), profileX + profileWidth / 2, 925, 29,
      { align: "center", color: accent, weight: 650, maxWidth: profileWidth });

    const origin = displayProfiles[index].aligned
      ? text("左図の0は対象点、右図の0は表示中のSSPzのFWHM中点です。",
        "Zero is the object point on the left and the selected SSPz's FWHM midpoint on the right.")
      : text("両図の0は対象点です。", "Zero is the object point in both plots.");
    ctx.fillStyle = rule;
    ctx.fillRect(margin, 950, contentWidth, 2);
    write(conditions, margin, 981, 26, { color: muted });
    write(origin, margin, 1027, 24, { color: muted });
  }

  return { canvas, draw };
}
