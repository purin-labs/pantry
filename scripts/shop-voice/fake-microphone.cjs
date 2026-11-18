// A microphone for a browser journey (Plan 82): macOS speech, played into the page's own
// microphone stream at 16 kHz. portal-browser.cjs and recorder-proof.cjs use it.
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Speech from macOS as a WAV file in base64. */
function speech(voice, text) {
  const file = path.join(os.tmpdir(), `shop-voice-${crypto.randomUUID()}.wav`);
  execFileSync(
    "say",
    ["-v", voice, "-o", file, "--data-format=LEI16@16000", text],
    { timeout: 60_000 },
  );
  const data = fs.readFileSync(file).toString("base64");
  fs.unlinkSync(file);
  return data;
}

/**
 * An init script: the page's microphone is a stream that `window.__play(base64)` fills
 * with one WAV at a time. The worklet, the wake phrase model and the rest are the page's own.
 */
function fakeMicrophone() {
  const audio = new AudioContext({ sampleRate: 16000 });
  const output = audio.createMediaStreamDestination();
  navigator.mediaDevices.getUserMedia = async () => output.stream;
  window.__play = async (base64) => {
    await audio.resume();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const buffer = await audio.decodeAudioData(bytes.buffer);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    await new Promise((resolve) => {
      source.onended = resolve;
      source.start();
    });
  };
}

async function play(base64) {
  await window.__play(base64);
}

module.exports = { speech, fakeMicrophone, play };
