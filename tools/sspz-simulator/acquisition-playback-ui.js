// Keep the acquisition explanation independent of the SSPz calculation worker.
let refreshAcquisitionPlayback = () => {};

function initializeAcquisitionPlayback(form) {
  const text = fdkText;
  const panel = document.createElement("section");
  panel.id = "acquisition-playback";
  panel.setAttribute("aria-labelledby", "acquisition-playback-title");
  panel.innerHTML = `
    <div class="section-heading">
      <h2 id="acquisition-playback-title">${text("展開図ができるまで", "Watch the unwrapped diagram take shape")}</h2>
      <p class="section-note">${text("設定条件で、寝台静止の1回転から始めます。ビームピッチが正の場合は、続いて寝台を等速移動させた1回転を描きます。", "Start with one stationary-table rotation at the current settings. With positive beam pitch, a second rotation shows the table moving at constant speed.")}</p>
    </div>
    <div class="acquisition-play-controls">
      <button type="button" class="primary" id="acquisition-play">${text("作画を再生", "Play drawing")}</button>
      <button type="button" class="secondary" id="acquisition-restart">${text("最初に戻る", "Go to start")}</button>
      <label>${text("再生速度", "Playback speed")}
        <select id="acquisition-speed">
          <option value="slow">${text("ゆっくり（12秒/回転）", "Slow (12 s/turn)")}</option>
          <option value="normal" selected>${text("標準（6秒/回転）", "Normal (6 s/turn)")}</option>
          <option value="actual">${text("設定した回転時間", "Configured rotation time")}</option>
        </select>
      </label>
      <button type="button" class="secondary" id="acquisition-save-mp4">${text("MP4を保存", "Save MP4")}</button>
    </div>
    <div class="acquisition-export-info field-help">
      <span id="acquisition-export-status" role="status"></span>
      <a id="acquisition-export-download" hidden>${text("MP4をもう一度ダウンロード", "Download the MP4 again")}</a>
    </div>
    <label class="acquisition-play-progress">
      <span>${text("作画の進み具合", "Drawing progress")}</span>
      <input type="range" id="acquisition-progress" min="0" max="2000" step="1" value="0">
    </label>
    <p id="acquisition-stage" class="acquisition-play-stage" role="status"></p>
    <p id="acquisition-readout" class="acquisition-play-readout"></p>
    <div class="acquisition-play-panels">
      <figure>
        <figcaption>${text("XY平面", "XY plane")}</figcaption>
        <canvas id="acquisition-play-xy" width="460" height="360" role="img" aria-label="${text("時計回りに動く焦点と評価点を結ぶ面内の光線", "In-plane ray through the target and clockwise-moving focal spot")}"></canvas>
      </figure>
      <figure>
        <figcaption>${text("Z方向の断面", "Longitudinal section")}</figcaption>
        <canvas id="acquisition-play-section" width="460" height="360" role="img" aria-label="${text("検出器列に向かう光線と評価位置の体軸線との交点", "Intersections of detector row rays with the target's longitudinal line")}"></canvas>
      </figure>
      <figure>
        <figcaption>${text("展開図", "Unwrapped diagram")}</figcaption>
        <canvas id="acquisition-play-diagram" width="460" height="360" role="img" aria-label="${text("補間方向が進むにつれて描き足される列の軌跡", "Detector row trajectories traced as the interpolation direction advances")}"></canvas>
      </figure>
    </div>
    <p class="field-help acquisition-play-note">${text("同じ色は同じ検出器列です。ヘリカルの灰色の破線は寝台静止時の軌跡です。平均焦点から列中心への一方向の光線を表示します。", "Matching colors identify the same detector row. Gray dashed lines in helical playback show stationary-table trajectories. The rays shown run from the mean focal position to the row centers on the direct side.")}</p>
    <p id="acquisition-coverage" class="field-help acquisition-play-note" hidden></p>`;
  form.closest("section").after(panel);

  const get = id => panel.querySelector("#acquisition-" + id);
  const play = get("play");
  const restart = get("restart");
  const save = get("save-mp4");
  const exportStatus = get("export-status");
  const exportDownload = get("export-download");
  const mp4MimeType = acquisitionMp4MimeType();
  exportStatus.textContent = mp4MimeType
    ? text("現在の設定と再生速度で、発表用の16:9動画を保存します。", "Save a 16:9 video using the current settings and playback speed.")
    : text("H.264 MP4を保存するには、対応するデスクトップ版のEdgeまたはChromeで開いてください。", "For H.264 MP4 export, open the site in a supported desktop version of Edge or Chrome.");
  const speed = get("speed");
  const slider = get("progress");
  const stage = get("stage");
  const readout = get("readout");
  const coverage = get("coverage");
  const diagrams = panel.querySelector(".acquisition-play-panels");
  const canvases = { xy: get("play-xy"), section: get("play-section"), diagram: get("play-diagram") };
  const phaseInput = document.getElementById("fdk-phase");
  const fanInput = document.getElementById("fdk-fullFanAngleDeg");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const decimal = new Intl.NumberFormat(document.documentElement.lang, { maximumFractionDigits: 3 });
  const rotationDuration = () => speed.value === "actual" ? model.rotationTime * 1000 : speed.value === "slow" ? 12000 : 6000;
  let model = null;
  let paramsKey = "";
  let position = 0;
  let playing = false;
  let exporting = false;
  let animationFrame = 0;
  let lastTime = 0;
  let holdUntil = 0;

  function stop() {
    playing = false;
    cancelAnimationFrame(animationFrame);
    play.textContent = text("作画を再生", "Play drawing");
  }

  function paint() {
    if (!model) return;
    const moving = position > 1;
    const fraction = moving ? position - 1 : position;
    const frame = drawAcquisitionPlayback(canvases, model, fraction, moving, text);
    const mode = moving ? text("ヘリカル・寝台を等速移動", "Helical · constant table speed")
      : text("ノンヘリカル・寝台静止", "Non-helical · stationary table");
    const label = mode + (position === Number(slider.max) / 1000 ? text("（作画完了）", " (drawing complete)") : "");
    if (stage.textContent !== label) stage.textContent = label;
    slider.value = String(Math.round(position * 1000));
    slider.setAttribute("aria-valuetext", `${mode} · ${Math.round(fraction * 360)}°`);
    const turn = Math.round(frame.sourceDeg);
    const direction = Math.round(frame.directionDeg);
    const feed = decimal.format(moving ? model.tableFeed : 0);
    const tableSpeed = decimal.format(moving ? model.tableFeed / model.rotationTime : 0);
    const scanTime = decimal.format(fraction * model.rotationTime);
    const shift = decimal.format(moving ? fraction * model.tableFeed : 0);
    const spacing = model.rows > 1 ? decimal.format(frame.intersections[1] - frame.intersections[0]) : "";
    readout.textContent = text(
      `管球角の差 ${turn}° ／ 補間方向の差 ${direction}°　｜　経過 ${scanTime} s　｜　寝台 ${feed} mm/回転（${tableSpeed} mm/s）　｜　Z移動量 ${shift} mm`,
      `Tube angle from start ${turn}° / direction from start ${direction}° · Elapsed ${scanTime} s · Table ${feed} mm/turn (${tableSpeed} mm/s) · Z shift ${shift} mm`);
    if (spacing) readout.textContent += text(`　｜　Pでの列間隔 ${spacing} mm`, ` · Row spacing at P ${spacing} mm`);
    panel.dataset.stage = moving ? "helical" : "stationary";
    panel.dataset.progress = String(position);
  }

  function tick(now) {
    if (!playing) return;
    const maximum = Number(slider.max) / 1000;
    const next = Math.min(maximum, position + Math.max(0, now - lastTime) / rotationDuration());
    lastTime = now;
    if (now >= holdUntil) {
      if (maximum === 2 && position < 1 && next >= 1) {
        position = 1;
        holdUntil = now + 900;
      } else {
        position = next;
      }
      paint();
    }
    if (position < maximum) animationFrame = requestAnimationFrame(tick);
    else stop();
  }

  refreshAcquisitionPlayback = () => {
    const fieldNumber = name => {
      const value = form.elements.namedItem(name).value;
      return value === "" ? NaN : Number(value);
    };
    const params = Object.fromEntries(
      ["rows", "rowWidth", "sourceRadius", "focalSourceDetectorMm", "radius", "beamPitch"]
        .map(name => [name, fieldNumber(name)]));
    params.rotationTime = parseRotationTime(form.elements.namedItem("rotationTime").value);
    params.nonhelicalRow = Number(form.elements.namedItem("nonhelicalRow").value);
    params.phase = Number(phaseInput.value);
    params.fullFanAngleDeg = Number(fanInput.value);
    const key = JSON.stringify(params);
    if (key === paramsKey) return;
    paramsKey = key;
    stop();
    position = 0;
    holdUntil = 0;
    try {
      model = createAcquisitionPlayback(params);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      model = null;
    }
    diagrams.hidden = play.disabled = restart.disabled = speed.disabled = slider.disabled = !model;
    save.disabled = exporting || !model || !mp4MimeType;
    coverage.hidden = !model || (model.detectorBeyondTarget && model.targetWithinFan);
    coverage.textContent = coverage.hidden ? "" : text(
      "一部の角度で評価位置が検出器の外側にあるため、破線は列中心の幾何を延長して示しています。",
      "The target lies outside the detector coverage at some angles. Dashed rays show the geometric extension of the row-center rays.");
    if (!model) {
      stage.textContent = text("作画するには、有効な撮影条件を入力してください。", "Enter valid acquisition settings to draw the diagram.");
      readout.textContent = "";
      delete panel.dataset.stage;
      delete panel.dataset.progress;
      return;
    }
    slider.max = model.tableFeed > 0 ? "2000" : "1000";
    paint();
  };

  play.onclick = () => {
    if (playing) {
      stop();
      return;
    }
    if (position >= Number(slider.max) / 1000) position = 0;
    holdUntil = 0;
    playing = true;
    play.textContent = text("一時停止", "Pause");
    lastTime = performance.now();
    paint();
    animationFrame = requestAnimationFrame(tick);
  };
  save.onclick = async () => {
    if (exporting || !model || !mp4MimeType) return;
    const exportModel = model;
    const secondsPerTurn = rotationDuration() / 1000;
    const pitch = Number((exportModel.tableFeed / (exportModel.rows * exportModel.rowWidth)).toFixed(6));
    const filename = `CT-unwrapped_N${exportModel.rows}_d${exportModel.rowWidth}_r${exportModel.radius}_p${pitch}.mp4`;
    stop();
    exporting = save.disabled = true;
    if (exportDownload.hasAttribute("href")) URL.revokeObjectURL(exportDownload.href);
    exportDownload.removeAttribute("href");
    exportDownload.hidden = true;
    let shownPercent = -1;
    const reportProgress = progress => {
      const percent = Math.floor(progress * 10) * 10;
      if (shownPercent === percent) return;
      shownPercent = percent;
      exportStatus.textContent = text(
        `MP4を書き出しています（${percent}%）。このタブを表示したままお待ちください。`,
        `Exporting MP4 (${percent}%). Keep this tab visible until export finishes.`);
    };
    reportProgress(0);
    try {
      const video = await exportAcquisitionMp4(exportModel, secondsPerTurn, mp4MimeType, text, reportProgress);
      exportDownload.href = URL.createObjectURL(video);
      exportDownload.download = filename;
      exportDownload.hidden = false;
      exportDownload.click();
      exportStatus.textContent = text("MP4の書き出しが完了しました。", "MP4 export complete.");
    } catch (error) {
      exportStatus.textContent = error.name === "AbortError"
        ? text("タブが切り替わったため、書き出しを中止しました。このタブを開いたまま、もう一度保存してください。",
          "The export stopped when the tab was hidden. Keep this tab visible and try again.")
        : text("MP4を書き出せませんでした。再試行するか、デスクトップ版のEdgeまたはChromeで開いてください。",
          "Could not export MP4. Retry or open the site in desktop Edge or Chrome.");
    } finally {
      exporting = false;
      save.disabled = !model || !mp4MimeType;
    }
  };
  restart.onclick = () => {
    stop();
    position = 0;
    paint();
  };
  slider.oninput = () => {
    stop();
    position = Number(slider.value) / 1000;
    paint();
  };
  if (reducedMotion.matches) speed.value = "slow";
  reducedMotion.addEventListener("change", () => {
    stop();
    if (reducedMotion.matches) speed.value = "slow";
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
  });
  phaseInput.addEventListener("input", refreshAcquisitionPlayback);
  fanInput.addEventListener("input", refreshAcquisitionPlayback);
  refreshAcquisitionPlayback();
}
