#!/usr/bin/env python3
"""Which of the noise bench's clips the Portal would send to a speech model at all (Plan 82).

`confidence-bench.py` sends every noise clip to the model, as a worst case. The Portal sends a capture
only when its speech detector (Silero VAD, `surfaces/voice/ui/features/voice/wake-worker.ts`) reads at least
0.5 in one 80 ms chunk. After a wake, the first 320 ms do not count, and the capture ends after 4 s with
no speech. A held key counts every chunk until the release. This script runs the Portal's own ONNX file
through the same stream on the same 6 s clips, in the same order, and writes the gate for each clip.

Run it with the wake bench's Python (onnxruntime, numpy):

    ~/.pantry-voice-test/wake/.venv/bin/python scripts/shop-voice/speech-gate.py

SHOP_VOICE_NOISE names the .npz file, as for the bench.
Results: output/shop-voice/speech-gate-<noise file>.json
"""
import importlib.util
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("bench", Path(__file__).with_name("confidence-bench.py"))
bench = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bench)

CHUNK = 1280
CHUNK_MS = 80
VAD_WINDOW = 512
VAD_CONTEXT = 64
VAD_SPEECH = 0.5
WAKE_TAIL_MS = 320
NO_SPEECH_MS = 4000


class SpeechDetector:
    """The worker's detector: windows of 512 samples with 64 before them, and the state kept across chunks."""

    def __init__(self) -> None:
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        self.session = ort.InferenceSession(str(ROOT / "apps/portal/public/voice/silero_vad.onnx"), options,
                                            providers=["CPUExecutionProvider"])
        self.state = np.zeros((2, 1, 128), "float32")
        self.buffered = np.zeros(0, "float32")
        self.context = np.zeros(VAD_CONTEXT, "float32")

    def run(self, chunk: np.ndarray) -> float:
        samples = np.concatenate([self.buffered, chunk]).astype("float32")
        at = 0
        highest = 0.0
        while at + VAD_WINDOW <= len(samples):
            window = np.concatenate([self.context, samples[at:at + VAD_WINDOW]])[None, :]
            self.context = samples[at + VAD_WINDOW - VAD_CONTEXT:at + VAD_WINDOW]
            output, self.state = self.session.run(None, {"input": window, "state": self.state,
                                                         "sr": np.array(16_000, "int64")})
            highest = max(highest, float(output[0][0]))
            at += VAD_WINDOW
        self.buffered = samples[at:]
        return highest


def main() -> None:
    noises = dict(np.load(bench.NOISE))
    rows = []
    for kind, noise in noises.items():
        clip = bench.NOISE_CLIP_SECONDS * bench.SAMPLE_RATE
        for at in range(0, len(noise) - clip, clip):
            part = np.clip(noise[at:at + clip], -1, 1).astype("float32")
            detector = SpeechDetector()
            peaks = [detector.run(part[start:start + CHUNK]) for start in range(0, len(part) - CHUNK + 1, CHUNK)]
            wake = [p for index, p in enumerate(peaks) if WAKE_TAIL_MS < (index + 1) * CHUNK_MS <= NO_SPEECH_MS]
            rows.append({"noise": kind, "peak": max(peaks), "afterWake": max(wake) >= VAD_SPEECH,
                         "held": max(peaks) >= VAD_SPEECH})
    path = ROOT / "output/shop-voice" / f"speech-gate-{Path(bench.NOISE).stem}.json"
    path.write_text(json.dumps(rows, indent=1) + "\n")
    print(path.name, f"after a wake {sum(r['afterWake'] for r in rows)} of {len(rows)},",
          f"held {sum(r['held'] for r in rows)} of {len(rows)}")


if __name__ == "__main__":
    main()
