// Portal voice control (Plan 82): hands 80 ms of microphone audio at a time to the worker.
// The page's AudioContext runs at 16 kHz, so one chunk is 1280 samples.
const CHUNK = 1280;

class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(CHUNK);
    this.filled = 0;
    this.target = null;
    this.port.onmessage = (event) => {
      this.target = event.data.port;
    };
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples === undefined || this.target === null) return true;
    let at = 0;
    while (at < samples.length) {
      const take = Math.min(samples.length - at, CHUNK - this.filled);
      this.chunk.set(samples.subarray(at, at + take), this.filled);
      this.filled += take;
      at += take;
      if (this.filled === CHUNK) {
        const full = this.chunk;
        this.target.postMessage(full, [full.buffer]);
        this.chunk = new Float32Array(CHUNK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("voice-capture", VoiceCapture);
