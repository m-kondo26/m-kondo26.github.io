import assert from "node:assert/strict";
import { acquisitionExportTimeline, acquisitionMp4MimeType } from "../acquisition-export.js";

for (const seconds of [0.05, 0.5, 6, 12]) {
  const stationary = acquisitionExportTimeline(seconds, false);
  const helical = acquisitionExportTimeline(seconds, true);
  for (const timeline of [stationary, helical]) {
    assert.deepEqual(timeline.frameAt(0), { fraction: 0, moving: false });
    assert.equal(timeline.frameAt(1).fraction, 0);
    assert.ok(Math.abs(timeline.frameAt(1 + seconds / 2).fraction - 0.5) < 1e-9);
    assert.equal(timeline.frameAt(1 + seconds + 0.1).fraction, 1);
  }
  assert.deepEqual(stationary.frameAt(stationary.duration), { fraction: 1, moving: false });
  assert.deepEqual(helical.frameAt(2 + seconds + 0.001), { fraction: 0, moving: true });
  assert.ok(Math.abs(helical.frameAt(2.65 + 1.5 * seconds).fraction - 0.5) < 1e-9);
  assert.deepEqual(helical.frameAt(helical.duration), { fraction: 1, moving: true });
}

assert.equal(acquisitionMp4MimeType(), "");
globalThis.HTMLCanvasElement = class { captureStream() {} };
globalThis.MediaRecorder = class {
  static isTypeSupported(type) { return type.includes("webm"); }
};
assert.equal(acquisitionMp4MimeType(), "");
globalThis.MediaRecorder.isTypeSupported = type => type === "video/mp4;codecs=avc1";
assert.equal(acquisitionMp4MimeType(), "video/mp4;codecs=avc1");

console.log("PASS: MP4 export timing, stationary/helical endpoints, and explicit AVC support");
