// Use the same candidate trajectories and shared cutoff as the 2A browser player.
function createGeometryExportRenderer(scene, drawingWindow, text, { config = {}, stateIndex } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d", { alpha: false });
  const panels = [
    { role: "direct", heading: text("実データ側", "Direct data") },
    { role: "complementary", heading: text("対向データ側", "Complementary data") },
    { role: "all", heading: text("重ね合わせ", "Overlay") },
  ].map(panel => {
    const chart = document.createElement("canvas");
    chart.width = 1800;
    chart.height = 1920;
    chart.dataset.renderScale = "2";
    return { ...panel, chart };
  });

  const ink = "#173644";
  const accent = "#0b6779";
  const muted = "#47616d";
  const rule = "#d6e3e8";
  const margin = 64;
  const gap = 26;
  const contentWidth = canvas.width - 2 * margin;
  const panelWidth = (contentWidth - 2 * gap) / 3;
  const panelHeight = panelWidth * 960 / 900;
  const format = new Intl.NumberFormat(document.documentElement.lang || "ja", {
    maximumFractionDigits: 4,
    useGrouping: false,
  });
  const count = config.rows ?? scene.totalRows;
  const width = config.rowWidth;
  const feed = scene.traceGeometry.feed;
  const pitch = config.beamPitch ?? feed / (count * width);
  const conditions = [
    text(`検出器 ${count}列`, `Detector rows ${count}`),
    Number.isFinite(width) && text(`列幅 ${format.format(width)} mm`, `Row width ${format.format(width)} mm`),
    Number.isFinite(config.radius) && text(`評価半径 ${format.format(config.radius)} mm`,
      `Target radius ${format.format(config.radius)} mm`),
    Number.isFinite(pitch) && text(`ビームピッチ ${format.format(pitch)}`, `Beam pitch ${format.format(pitch)}`),
    Number.isFinite(feed) && text(`寝台移動量 ${format.format(feed)} mm/回転`,
      `Table feed ${format.format(feed)} mm/turn`),
    Number.isInteger(stateIndex) && text(`状態 ${stateIndex}/359`, `State ${stateIndex}/359`),
    config.zFfsEnabled && text("z-FFSあり", "z-FFS on"),
  ].filter(Boolean).join("  |  ");

  const title = text("展開図ができるまで", "How the unwrapped diagram is drawn");
  const subtitle = text("同じ取得データを実データ側と対向データ側で示し、取得順に軌跡を描き足します。",
    "The same acquired data appear on the direct and complementary sides. Trajectories are drawn in acquisition order.");
  const key = text("小さな四角は作画の先端です。1回転ごとに縦軸の0°へ戻り、次の体軸位置へ進みます。",
    "Small squares mark the advancing tips. Each turn returns to 0° and continues at the next axial position.");

  function write(label, x, y, size, { color = ink, weight = 400, align = "left", maxWidth = contentWidth } = {}) {
    ctx.font = `${weight} ${size}px system-ui, sans-serif`;
    const width = ctx.measureText(label).width;
    if (width > maxWidth) ctx.font = `${weight} ${size * maxWidth / width}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y);
  }

  let lastFraction = null;

  function draw(fraction) {
    const progress = Math.min(1, Math.max(0, fraction));
    const span = drawingWindow.end - drawingWindow.start;
    const cutoff = progress === 1 ? null : drawingWindow.start + progress * span;
    // Reuse unchanged plots for the first and final holds.
    if (progress !== lastFraction) {
      for (const panel of panels) {
        drawDiagram(panel.chart, SSPZConstruction.role(scene, panel.role, cutoff), "overview");
      }
      lastFraction = progress;
    }

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    write(title, margin, 91, 60, { weight: 700 });
    write(subtitle, margin, 151, 27, { color: muted });
    ctx.fillStyle = rule;
    ctx.fillRect(margin, 183, contentWidth, 2);
    panels.forEach(({ chart, heading }, i) => {
      const x = margin + i * (panelWidth + gap);
      write(heading, x + panelWidth / 2, 216, 33, { align: "center", weight: 650, maxWidth: panelWidth });
      ctx.drawImage(chart, x, 241, panelWidth, panelHeight);
    });

    const degrees = Math.floor(progress * span * 180 / Math.PI + 1e-8);
    const turns = Math.floor(degrees / 360);
    const remainder = degrees % 360;
    const percent = Math.floor(progress * 100);
    const status = progress === 1
      ? text("作画完了", "Drawing complete")
      : text(`描画開始から ${turns}回転 + ${remainder}°　｜　${percent}%`,
        `From drawing start: ${turns} turns + ${remainder}°  |  ${percent}%`);
    ctx.fillStyle = rule;
    ctx.fillRect(margin, 875, contentWidth, 2);
    write(status, margin, 906, 31, { color: accent, weight: 650 });
    write(conditions, margin, 957, 25, { color: muted });
    write(key, margin, 1001, 25, { color: muted });
  }

  return { canvas, draw };
}
