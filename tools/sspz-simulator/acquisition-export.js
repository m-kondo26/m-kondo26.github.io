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

async function exportAcquisitionMp4(model, secondsPerTurn, mimeType, text, onProgress) {
  const timeline = acquisitionExportTimeline(secondsPerTurn, model.tableFeed > 0);
  const renderer = createAcquisitionExportRenderer(model, text);
  renderer.draw(0, false);
  const stream = renderer.canvas.captureStream(ACQUISITION_EXPORT_FPS);

  return new Promise((resolve, reject) => {
    let recorder;
    let request = 0;
    let finished = false;
    let complete = false;
    let lastFrame = -1;
    let started = 0;
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
        const elapsed = Math.max(0, (now - started) / 1000);
        if (elapsed >= timeline.duration) {
          complete = true;
          recorder.stop();
          return;
        }
        const frameIndex = Math.floor(elapsed * ACQUISITION_EXPORT_FPS);
        if (frameIndex !== lastFrame) {
          lastFrame = frameIndex;
          const frame = timeline.frameAt(elapsed);
          renderer.draw(frame.fraction, frame.moving);
          onProgress(elapsed / timeline.duration);
        }
        request = requestAnimationFrame(recordFrame);
      } catch (error) {
        fail(error);
      }
    }

    try {
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
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
