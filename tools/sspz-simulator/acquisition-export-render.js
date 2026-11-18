// Compose just the synchronized simulation on a 16:9 presentation canvas.
function createAcquisitionExportRenderer(model, text) {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d", { alpha: false });
  const panels = {};
  for (const name of ["xy", "section", "diagram"]) {
    const panel = document.createElement("canvas");
    panel.width = 420;
    panel.height = 335;
    panels[name] = panel;
  }

  const ink = "#173644";
  const muted = "#47616d";
  const accent = "#0b6779";
  const rule = "#d6e3e8";
  const panelWidth = 576;
  const panelHeight = panelWidth * panels.xy.height / panels.xy.width;
  const left = 64;
  const gap = 32;
  const contentWidth = canvas.width - 2 * left;
  const font = new Intl.NumberFormat(document.documentElement.lang || "ja", {
    maximumFractionDigits: 3,
    useGrouping: false,
  });
  const format = value => font.format(Math.abs(value) < 0.0005 ? 0 : value);
  const headings = [
    text("XY平面", "XY plane"),
    text("Z方向の断面", "Longitudinal section"),
    text("展開図", "Unwrapped diagram"),
  ];
  const n = model.rows;
  const width = format(model.rowWidth);
  const detectorWidth = format(model.detectorRowWidth);
  const radius = format(model.radius);
  const pitch = format(model.tableFeed / (n * model.rowWidth));
  const feed = format(model.tableFeed);
  const distance = format(model.sourceRadius);
  const detector = format(model.detectorDistance);
  const fan = format(model.fullFanAngleDeg);
  const start = format(model.startAngleDeg);
  const period = format(model.rotationTime);
  const reference = format(model.referenceZ);
  const acquisitionSummary = text(
    `検出器 ${n}列 × ${width} mm（中心換算）　｜　検出器面の1列幅 ${detectorWidth} mm　｜　評価半径 ${radius} mm　｜　ピッチ ${pitch}　｜　寝台移動量 ${feed} mm/回転`,
    `Detector rows ${n} × ${width} mm at isocentre  |  Row width at detector face ${detectorWidth} mm  |  Target radius ${radius} mm  |  Pitch ${pitch}  |  Table feed ${feed} mm/turn`);
  const geometrySummary = text(
    `焦点–回転中心 ${distance} mm　｜　焦点–検出器 ${detector} mm　｜　全ファン角 ${fan}°　｜　開始角度 ${start}°　｜　設定回転時間 ${period} s/回転`,
    `Source–isocentre ${distance} mm  |  Source–detector ${detector} mm  |  Fan opening ${fan}°  |  Start angle ${start}°  |  Acquisition rotation time ${period} s/turn`);
  const scope = model.detectorBeyondTarget && model.targetWithinFan
    ? text("区画は検出器面での列幅、区画内の点は列中心です。展開図は列中心に向かう光線と、Pを通るZ方向の直線との交点を示します。",
      "Blocks show the row widths at the detector face, and dots mark their centres. The unwrapped diagram traces the row-centre rays at the Z line through P.")
    : text("区画は検出器面での列幅、区画内の点は列中心です。検出器の範囲外では光線を破線で延長しています。",
      "Blocks show detector-face row widths, and dots mark their centres. Dashed rays show geometric extensions outside detector coverage.");
  const plane = model.tableFeed === 0
    ? text(`　再構成面 z₀ = ${reference} mm`, `  |  Reconstruction plane z₀ = ${reference} mm`)
    : "";

  function write(label, x, y, size, {
    color = ink, weight = 400, align = "left", maxWidth = contentWidth,
  } = {}) {
    ctx.font = `${weight} ${size}px system-ui, sans-serif`;
    const width = ctx.measureText(label).width;
    if (width > maxWidth) ctx.font = `${weight} ${size * maxWidth / width}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y);
  }

  function draw(fraction, moving) {
    const helical = moving && model.tableFeed > 0;
    const frame = drawAcquisitionPlayback(panels, model, fraction, helical, text);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    write(text("CTの展開図ができるまで", "How the CT unwrapped diagram takes shape"),
      left, 100, 60, { weight: 700 });
    write(helical
      ? text("ヘリカル・寝台を等速移動", "Helical · constant table speed")
      : text("ノンヘリカル・寝台静止", "Non-helical · stationary table"),
      left, 176, 40, { color: accent, weight: 700 });
    write(helical
      ? text("寝台移動によって、同じ時点の交点がそろってZ方向へずれます。",
        "Table movement shifts the intersections together along Z at each instant.")
      : text("評価位置との交点を、回転に沿って展開図に描き足します。",
        "The diagram traces intersections at the target position as the tube rotates."),
      left, 229, 29, { color: muted });
    ctx.fillStyle = rule;
    ctx.fillRect(left, 273, contentWidth, 2);
    const frames = Object.values(panels);
    frames.forEach((panel, i) => {
      const x = left + (panelWidth + gap) * i;
      write(headings[i], x + panelWidth / 2, 318, 34, { align: "center", weight: 650 });
      ctx.drawImage(panel, x, 347, panelWidth, panelHeight);
    });

    const angle = Math.round(frame.sourceDeg);
    const direction = Math.round(frame.directionDeg);
    const shift = format(frame.sourceZ);
    const spacing = n > 1
      ? format(frame.intersections[1] - frame.intersections[0])
      : null;
    const metrics = [
      text(`管球角の差 ${angle}°　｜　補間方向の差 ${direction}°`,
        `Tube angle Δ${angle}°  |  Rebinned direction Δ${direction}°`),
      spacing === null
        ? text("評価点 P・1列", "Target P · single detector row")
        : text(`評価点 P での列中心間隔 ${spacing} mm`, `Row-centre spacing at P ${spacing} mm`),
      text(`Z移動量 ${shift} mm`, `Z shift ${shift} mm`),
    ];
    metrics.forEach((label, i) => {
      const x = left + (panelWidth + gap) * i;
      write(label, x + panelWidth / 2, 839, 25, { align: "center", weight: 600, maxWidth: panelWidth });
    });
    ctx.fillStyle = rule;
    ctx.fillRect(left, 881, contentWidth, 2);
    write(acquisitionSummary + plane, left, 916, 25, { color: muted });
    write(geometrySummary, left, 955, 25, { color: muted });
    write(scope, left, 1005, 24, { color: muted });
    return frame;
  }

  return { canvas, draw };
}
