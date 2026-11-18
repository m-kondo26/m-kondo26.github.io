// Keep the recording timeline separate from disk writing and screen playback.
const ACQUISITION_MP4_TYPES = [
  "video/mp4;codecs=avc1.420028",
  "video/mp4;codecs=avc1",
  "video/mp4;codecs=avc1.4d0028",
];
const ACQUISITION_EXPORT_FPS = 30;

export function acquisitionMp4MimeType() {
  if (typeof MediaRecorder !== "function"
    || typeof HTMLCanvasElement === "undefined"
    || typeof HTMLCanvasElement.prototype.captureStream !== "function") return "";
  return ACQUISITION_MP4_TYPES.find(type => MediaRecorder.isTypeSupported(type)) ?? "";
}

export function acquisitionExportTimeline(secondsPerTurn, includeHelical) {
  const stationaryStart = 1;
  const stationaryEnd = stationaryStart + secondsPerTurn;
  const helicalStage = stationaryEnd + 1;
  const helicalStart = helicalStage + 0.65;
  const duration = (includeHelical ? helicalStart + secondsPerTurn : stationaryEnd) + 1.3;
  return {
    duration,
    frameAt(elapsed) {
      const moving = includeHelical && elapsed >= helicalStage;
      const start = moving ? helicalStart : stationaryStart;
      return { fraction: Math.max(0, Math.min(1, (elapsed - start) / secondsPerTurn)), moving };
    },
  };
}

export function geometryExportTimeline(span, degreesPerSecond) {
  const drawSeconds = (span.end - span.start) * 180 / Math.PI / degreesPerSecond;
  const intro = 0.8;
  return {
    duration: intro + drawSeconds + 1.5,
    fractionAt(elapsed) {
      return Math.max(0, Math.min(1, (elapsed - intro) / drawSeconds));
    },
  };
}

export function positionExportTimeline(angleCount, startIndex, millisecondsPerAngle) {
  const secondsPerAngle = millisecondsPerAngle / 1000;
  const intro = 0.8;
  return {
    duration: intro + angleCount * secondsPerAngle + 1.5,
    // When rendering is slower than playback, give each angle time to be recorded.
    maxFrameStep: secondsPerAngle * 0.99,
    indexAt(elapsed) {
      const step = Math.max(0, Math.min(angleCount - 1, Math.floor((elapsed - intro) / secondsPerAngle)));
      return (startIndex + step) % angleCount;
    },
  };
}

function acquisitionMp4Movie(model, secondsPerTurn, text) {
  const timeline = acquisitionExportTimeline(secondsPerTurn, model.tableFeed > 0);
  const renderer = createAcquisitionExportRenderer(model, text);
  const pitch = Number((model.tableFeed / (model.rows * model.rowWidth)).toFixed(6));
  return {
    filename: `CT-unwrapped_N${model.rows}_d${model.rowWidth}_r${model.radius}_p${pitch}.mp4`,
    canvas: renderer.canvas,
    duration: timeline.duration,
    drawFrame(elapsed) {
      const frame = timeline.frameAt(elapsed);
      renderer.draw(frame.fraction, frame.moving);
    },
  };
}

async function recordCanvasMp4({ canvas, duration, drawFrame, maxFrameStep = Infinity }, mimeType, onProgress) {
  drawFrame(0);
  const stream = canvas.captureStream(ACQUISITION_EXPORT_FPS);

  return new Promise((resolve, reject) => {
    let recorder;
    let request = 0;
    let finished = false;
    let complete = false;
    let lastFrame = -1;
    let started = 0;
    let lastWallTime = 0;
    let elapsed = 0;
    const chunks = [];

    function cleanup() {
      cancelAnimationFrame(request);
      document.removeEventListener("visibilitychange", tabVisibilityChanged);
      for (const track of stream.getTracks()) track.stop();
    }

    function fail(error) {
      if (finished) return;
      finished = true;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      cleanup();
      reject(error);
    }

    function tabVisibilityChanged() {
      if (document.hidden) fail(new DOMException("The tab was hidden during export.", "AbortError"));
    }

    function recordFrame(now) {
      try {
        const wallTime = Math.max(0, (now - started) / 1000);
        const frameIndex = Math.floor(wallTime * ACQUISITION_EXPORT_FPS);
        if (frameIndex !== lastFrame) {
          elapsed += Math.min(wallTime - lastWallTime, maxFrameStep);
          lastWallTime = wallTime;
          if (elapsed >= duration) {
            complete = true;
            recorder.stop();
            return;
          }
          lastFrame = frameIndex;
          drawFrame(elapsed);
          onProgress(elapsed / duration);
        }
        request = requestAnimationFrame(recordFrame);
      } catch (error) {
        fail(error);
      }
    }

    try {
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 8_000_000,
        // PowerPoint can report the last MP4 fragment start as the duration.
        // Keep a keyframe and fragment boundary within the final diagram hold.
        videoKeyFrameIntervalDuration: 500,
      });
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = event => fail(event.error || new Error("The recording failed."));
      recorder.onstop = () => {
        if (finished) return;
        finished = true;
        cleanup();
        const video = new Blob(chunks, { type: "video/mp4" });
        if (!complete || !video.size) reject(new Error("The recorder did not finish the video."));
        else resolve(video);
      };
      document.addEventListener("visibilitychange", tabVisibilityChanged);
      if (document.hidden) {
        tabVisibilityChanged();
        return;
      }
      recorder.start();
      started = performance.now();
      request = requestAnimationFrame(recordFrame);
    } catch (error) {
      fail(error);
    }
  });
}

let mp4DownloadActive = false;
const mp4DownloadControls = [];

function bindMp4Download({ button, status, download, text, isReady, createMovie, readyNote, waitingNote = readyNote }) {
  const mimeType = acquisitionMp4MimeType();
  let wasReady;
  function refresh() {
    const ready = isReady();
    button.disabled = mp4DownloadActive || !ready || !mimeType;
    if (ready === wasReady) return;
    wasReady = ready;
    status.textContent = mimeType ? (ready ? readyNote : waitingNote) : text(
      "H.264 MP4を保存するには、対応するデスクトップ版のEdgeまたはChromeで開いてください。",
      "For H.264 MP4 export, open the site in a supported desktop version of Edge or Chrome.");
  }
  mp4DownloadControls.push(refresh);
  refresh();

  button.onclick = async () => {
    if (button.disabled) return;
    mp4DownloadActive = true;
    mp4DownloadControls.forEach(update => update());
    if (download.hasAttribute("href")) URL.revokeObjectURL(download.href);
    download.removeAttribute("href");
    download.hidden = true;
    let shownPercent = -1;
    const reportProgress = progress => {
      const percent = Math.floor(progress * 10) * 10;
      if (shownPercent === percent) return;
      shownPercent = percent;
      status.textContent = text(
        `MP4を書き出しています（${percent}%）。このタブを表示したままお待ちください。`,
        `Exporting MP4 (${percent}%). Keep this tab visible until export finishes.`);
    };
    reportProgress(0);
    try {
      const movie = createMovie();
      const video = await recordCanvasMp4(movie, mimeType, reportProgress);
      download.href = URL.createObjectURL(video);
      download.download = movie.filename;
      download.hidden = false;
      download.click();
      status.textContent = text("MP4の書き出しが完了しました。", "MP4 export complete.");
    } catch (error) {
      status.textContent = error.name === "AbortError"
        ? text("タブが切り替わったため、書き出しを中止しました。このタブを開いたまま、もう一度保存してください。",
          "The export stopped when the tab was hidden. Keep this tab visible and try again.")
        : text("MP4を書き出せませんでした。再試行するか、デスクトップ版のEdgeまたはChromeで開いてください。",
          "Could not export MP4. Retry or open the site in desktop Edge or Chrome.");
    } finally {
      mp4DownloadActive = false;
      mp4DownloadControls.forEach(update => update());
    }
  };
  return refresh;
}
