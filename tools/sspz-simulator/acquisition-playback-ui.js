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
        <canvas id="acquisition-play-xy" width="460" height="360" role="img" aria-label="${text("管球角0°を真上にとるXY平面と、Y軸上の評価点P", "XY plane with tube angle 0° at the top and target P on the Y axis")}"></canvas>
      </figure>
      <figure>
        <figcaption>${text("Z方向の断面", "Longitudinal section")}</figcaption>
        <canvas id="acquisition-play-section" width="460" height="360" role="img" aria-label="${text("検出器各列の幅と中心、および列中心への光線が評価位置で交わる点", "Widths and centres of the detector rows, and where their centre rays cross the target line")}"></canvas>
      </figure>
      <figure>
        <figcaption>${text("展開図", "Unwrapped diagram")}</figcaption>
        <canvas id="acquisition-play-diagram" width="460" height="360" role="img" aria-label="${text("評価位置での列中心光線の交点を補間方向に沿ってつないだ展開図", "Unwrapped trajectories of the row-centre-ray intersections at the evaluation position")}"></canvas>
      </figure>
    </div>
    <p class="field-help acquisition-play-note">${text("管球角0°は真上で、評価点PはY軸上です。Z断面の区画は検出器面での列幅、区画内の点は列中心です。展開図には列中心に向かう光線と、Pを通るZ方向の直線との交点を描きます。ヘリカルの灰色の破線は寝台静止時の軌跡です。", "Tube angle 0° is at the top, with target P on the Y axis. In the Z section, the blocks show the detector-face row widths and the dots inside them mark their centres. The unwrapped diagram traces where the row-centre rays cross the Z line through P. Gray dashed lines show the stationary-table trajectories.")}</p>
    <p id="acquisition-coverage" class="field-help acquisition-play-note" hidden></p>`;
  form.closest("section").after(panel);

  const get = id => panel.querySelector("#acquisition-" + id);
  const play = get("play");
  const restart = get("restart");
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
  let animationFrame = 0;
  let lastTime = 0;
  let holdUntil = 0;

  const refreshMp4Download = bindMp4Download({
    button: get("save-mp4"),
    status: get("export-status"),
    download: get("export-download"),
    text,
    isReady: () => Boolean(model),
    createMovie: () => {
      stop();
      return acquisitionMp4Movie(model, rotationDuration() / 1000, text);
    },
    readyNote: text("現在の設定と再生速度で、発表用の16:9動画を保存します。", "Save a 16:9 video using the current settings and playback speed."),
  });

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
    const detectorWidth = decimal.format(model.detectorRowWidth);
    const spacing = model.rows > 1 ? decimal.format(frame.intersections[1] - frame.intersections[0]) : "";
    readout.textContent = text(
      `管球角の差 ${turn}° ／ 補間方向の差 ${direction}°　｜　経過 ${scanTime} s　｜　寝台 ${feed} mm/回転（${tableSpeed} mm/s）　｜　Z移動量 ${shift} mm`,
      `Tube angle from start ${turn}° / direction from start ${direction}° · Elapsed ${scanTime} s · Table ${feed} mm/turn (${tableSpeed} mm/s) · Z shift ${shift} mm`);
    readout.textContent += text(`　｜　検出器面の1列幅 ${detectorWidth} mm`, ` · Row width at detector face ${detectorWidth} mm`);
    if (spacing) readout.textContent += text(`　｜　Pでの列中心間隔 ${spacing} mm`, ` · Row-centre spacing at P ${spacing} mm`);
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
    refreshMp4Download();
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
