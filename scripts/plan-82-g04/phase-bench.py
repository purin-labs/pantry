"""Plan 82 D11: how much the "Hey Satyr" score depends on where the phrase falls in an 80 ms chunk.

The wake worker (apps/portal/src/features/voice/wake-worker.ts) makes one embedding for each 80 ms
chunk, so the model sees the phrase on an 80 ms grid. This bench runs the Portal's own ONNX files
through the same stream, moves the phrase in 5 ms steps, and scores it on 1, 2, 4 and 8 grids
(phases) that start 80/phases ms apart. A wake on any phase counts. It reports, for each count of
phases, the share of wake phrases heard, the share of near phrases accepted, and the false wakes in
café talk. The voices are macOS voices, which the model did not train on, and the noise is the
DEMAND test part, so the numbers compare the phase counts and do not predict a real shop.

Run it with the wake bench's Python (onnxruntime, numpy, scipy):

    ~/.satyr-voice-test/wake/.venv/bin/python scripts/plan-82-g04/phase-bench.py

Results: output/shop-voice/wake-phase-bench.json
"""
import json
import os
import subprocess
from concurrent.futures import ProcessPoolExecutor
import tempfile
import uuid
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "apps/portal/public/voice"
NOISE = Path(os.environ.get("WAKE_PHASE_NOISE", Path.home() / ".satyr-voice-test/wake/noise-test.npz"))
RESULTS = ROOT / "output/shop-voice/wake-phase-bench.json"
RATE = 16_000
CHUNK = 1280
MEL_OVERLAP = 480
MEL_BINS = 32
MEL_WINDOW = 76
FRAMES_PER_CHUNK = 8
EMBEDDING_WINDOW = 16
THRESHOLD = 0.995
PHASES = (1, 2, 4, 8)
SHIFTS_MS = tuple(range(0, 80, 5))
LEVELS_DB = (None, 10, 5)
LEAD_SECONDS = 2.0
TAIL_SECONDS = 0.6
VOICES = (
    "Samantha", "Daniel", "Karen", "Moira", "Rishi", "Tessa", "Fred", "Kathy", "Ralph", "Junior",
    "Eddy (English (UK))", "Flo (English (US))", "Reed (English (UK))", "Sandy (English (US))",
    "Shelley (English (UK))", "Rocko (English (US))", "Grandma (English (US))", "Grandpa (English (UK))",
)
WAKE_PHRASES = ("Hey Satyr", "Hey, Satyr")
NEAR_PHRASES = ("Hey sayter", "Hey Sarah", "Hey satire", "Hey Peter", "Hey sailor", "Hey Saturday",
                "Hey cedar", "Hey, setter")
TALK = (
    "Put two trays of kouign amann in the second oven.", "How much butter is left for tomorrow?",
    "Can you pass me the piping bag?", "The croissants need another five minutes.",
    "Say hi to Sarah for me.", "Hey, did the flour delivery come in?", "It's a satire, really.",
    "We have a lot of orders for Saturday.", "Hey Peter, can you take the next customer?",
    "Mark the black sesame financiers as sold out.", "That will be six hundred yen, please.",
    "Would you like that warmed up?", "The setter on the mixer is stuck again.",
    "Hey, can you check the proofer temperature?", "Thank you, have a nice day!",
    "Is the matcha latte with oat milk?", "We are out of the pistachio cakes.",
    "Hey there, what can I get for you?", "The sailor stripes on the boxes look great.",
    "Start the shift for the morning bake.",
)
TALK_LEVEL_DB = 5
WORKERS = max(1, (os.cpu_count() or 2) - 4)


class Wake:
    def __init__(self) -> None:
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        self.mel, self.embedding, self.classifier = (
            ort.InferenceSession(str(MODELS / f"{name}.onnx"), options, providers=["CPUExecutionProvider"])
            for name in ("melspectrogram", "embedding_model", "hey_satyr"))

    def mel_frames(self, samples: np.ndarray) -> np.ndarray:
        """The worker's mel stream: each 80 ms chunk with the last 480 samples before it."""
        previous = np.zeros(MEL_OVERLAP, "float32")
        frames = []
        for at in range(0, len(samples) - CHUNK + 1, CHUNK):
            part = np.concatenate([previous, samples[at:at + CHUNK] * 32767]).astype("float32")
            previous = part[CHUNK:]
            values = self.mel.run(None, {self.mel.get_inputs()[0].name: part[None, :]})[0]
            rows = values.reshape(-1, MEL_BINS) / 10 + 2
            assert len(rows) == FRAMES_PER_CHUNK, len(rows)
            frames.append(rows)
        return np.concatenate(frames).astype("float32")

    def embeddings(self, frames: np.ndarray) -> np.ndarray:
        """One embedding for each window end, every 10 ms. Row e ends at frame e + MEL_WINDOW."""
        windows = np.stack([frames[end - MEL_WINDOW:end] for end in range(MEL_WINDOW, len(frames) + 1)])
        name = self.embedding.get_inputs()[0].name
        return np.concatenate([self.embedding.run(None, {name: windows[at:at + 256, :, :, None]})[0].reshape(-1, 96)
                               for at in range(0, len(windows), 256)])

    def lag_scores(self, rows: np.ndarray, frame_count: int, lag: int) -> np.ndarray:
        """The score at each chunk end on the grid that lags phase 0 by `lag` frames (10 ms each).

        A window with fewer than 16 embeddings scores 0, as in the worker. The model gives 0.99999 to
        a window of zeros, so such a window must never reach it.
        """
        ends = list(range(FRAMES_PER_CHUNK, frame_count + 1, FRAMES_PER_CHUNK))
        scores = np.zeros(len(ends), "float32")
        features, at = [], []
        for index, end in enumerate(ends):
            last = end - lag - MEL_WINDOW  # the row of the newest embedding
            first = last - FRAMES_PER_CHUNK * (EMBEDDING_WINDOW - 1)
            if first >= 0:
                features.append(rows[first:last + 1:FRAMES_PER_CHUNK])
                at.append(index)
        if features:
            scores[at] = self.classifier.run(None, {"input": np.stack(features).astype("float32")})[0].reshape(-1)
        return scores

    def peaks(self, samples: np.ndarray) -> dict[int, float]:
        """The highest score on each count of phases. Phase j lags phase 0 by j * 80 / phases ms."""
        frames = self.mel_frames(samples)
        rows = self.embeddings(frames)
        scores = {lag: float(self.lag_scores(rows, len(frames), lag).max()) for lag in range(FRAMES_PER_CHUNK)}
        return {count: max(scores[lag] for lag in range(0, FRAMES_PER_CHUNK, FRAMES_PER_CHUNK // count))
                for count in PHASES}

    def events(self, samples: np.ndarray) -> dict[int, int]:
        """False wakes in a long stream: one event for each run of chunks over the threshold."""
        frames = self.mel_frames(samples)
        rows = self.embeddings(frames)
        by_lag = np.stack([self.lag_scores(rows, len(frames), lag) for lag in range(FRAMES_PER_CHUNK)])
        over = {count: list(by_lag[0:FRAMES_PER_CHUNK:FRAMES_PER_CHUNK // count].max(axis=0) >= THRESHOLD)
                for count in PHASES}
        return {count: sum(1 for at, hit in enumerate(flags) if hit and (at == 0 or not flags[at - 1]))
                for count, flags in over.items()}


def say(voice: str, text: str, folder: str) -> np.ndarray:
    path = Path(folder) / f"{uuid.uuid4().hex}.wav"
    subprocess.run(["say", "-v", voice, "-o", str(path), "--data-format=LEI16@16000", text], check=True, timeout=60)
    with wave.open(str(path)) as file:
        samples = np.frombuffer(file.readframes(file.getnframes()), dtype="<i2").astype("float32") / 32768.0
    path.unlink()
    nonzero = np.flatnonzero(np.abs(samples) > 0.01)
    return samples[nonzero[0]:nonzero[-1] + 1] if len(nonzero) else samples


def active_rms(samples: np.ndarray) -> float:
    frames = samples[: len(samples) // 160 * 160].reshape(-1, 160)
    power = (frames ** 2).mean(axis=1)
    loud = power[power > power.max() * 0.01]
    return float(np.sqrt(loud.mean())) if len(loud) else 1e-6


def mix(speech: np.ndarray, noise: np.ndarray, level_db: float | None, lead: int, at: int) -> np.ndarray:
    """Speech at -26 dBFS after `lead` samples of room sound. No level means a quiet room at -60 dBFS."""
    speech = speech * (10 ** (-26 / 20) / active_rms(speech))
    total = lead + len(speech) + int(TAIL_SECONDS * RATE)
    total += (-total) % CHUNK
    room = np.resize(noise[at % len(noise):], total)
    room_db = -60 if level_db is None else -26 - level_db
    room = room * (10 ** (room_db / 20) / (active_rms(room) or 1e-6))
    out = room.copy()
    out[lead:lead + len(speech)] += speech
    return np.clip(out, -1, 1).astype("float32")


_process_wake: "Wake | None" = None


def voice_rows(task: tuple[int, str, tuple[str, ...]]) -> list[dict]:
    """One voice's rows, in a worker process with its own models."""
    global _process_wake
    index, voice, phrases = task
    _process_wake = _process_wake or Wake()
    noises = {kind: samples.astype("float32") for kind, samples in np.load(NOISE).items()}
    kinds = list(noises)
    rows = []
    with tempfile.TemporaryDirectory() as folder:
        for text in phrases:
            speech = say(voice, text, folder)
            for level in LEVELS_DB:
                kind = kinds[index % len(kinds)]
                for shift in SHIFTS_MS:
                    lead = int((LEAD_SECONDS * 1000 + shift) * RATE / 1000)
                    peaks = _process_wake.peaks(mix(speech, noises[kind], level, lead, index * 41_000))
                    rows.append({"voice": voice, "text": text, "level": level, "shiftMs": shift,
                                 **{f"phases{count}": round(score, 5) for count, score in peaks.items()}})
    print(voice, "done", flush=True)
    return rows


def phrase_rows(phrases: tuple[str, ...]) -> list[dict]:
    tasks = [(index, voice, phrases) for index, voice in enumerate(VOICES)]
    with ProcessPoolExecutor(max_workers=WORKERS) as pool:
        return [row for rows in pool.map(voice_rows, tasks) for row in rows]


def heard(rows: list[dict]) -> dict:
    """The share over threshold, and how many phrase and level groups depend on the shift."""
    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        groups.setdefault((row["voice"], row["text"], row["level"]), []).append(row)
    summary = {}
    for count in PHASES:
        key = f"phases{count}"
        hits = [row[key] >= THRESHOLD for row in rows]
        mixed = sum(1 for group in groups.values() if 0 < sum(r[key] >= THRESHOLD for r in group) < len(group))
        spread = [max(r[key] for r in group) - min(r[key] for r in group) for group in groups.values()]
        by_level = {str(level): f"{sum(r[key] >= THRESHOLD for r in rows if r['level'] == level)} of "
                                 f"{sum(1 for r in rows if r['level'] == level)}" for level in LEVELS_DB}
        summary[key] = {"over": f"{sum(hits)} of {len(hits)}", "byLevel": by_level,
                        "groupsThatDependOnShift": f"{mixed} of {len(groups)}",
                        "medianSpread": round(float(np.median(spread)), 4)}
    return summary


def talk_stream(noises: dict[str, np.ndarray], folder: str) -> np.ndarray:
    """Every voice says every sentence, with pauses, over café noise."""
    parts = []
    rng = np.random.default_rng(82)
    for voice in VOICES:
        for text in TALK:
            parts.append(say(voice, text, folder) * (10 ** (-26 / 20)))
            parts.append(np.zeros(int(rng.uniform(0.3, 1.2) * RATE), "float32"))
    speech = np.concatenate(parts)
    speech = speech * (10 ** (-26 / 20) / active_rms(speech))
    room = np.resize(noises["PCAFETER"], len(speech))
    room = room * (10 ** ((-26 - TALK_LEVEL_DB) / 20) / active_rms(room))
    total = len(speech) - len(speech) % CHUNK
    return np.clip(speech + room, -1, 1)[:total].astype("float32")


def main() -> None:
    wake = Wake()
    noises = {kind: samples.astype("float32") for kind, samples in np.load(NOISE).items()}
    wake_rows = phrase_rows(WAKE_PHRASES)
    near_rows = phrase_rows(NEAR_PHRASES)
    with tempfile.TemporaryDirectory() as folder:
        talk = talk_stream(noises, folder)
    talk_events = wake.events(talk)
    hours = len(talk) / RATE / 3600
    report = {
        "threshold": THRESHOLD,
        "wakePhrases": heard(wake_rows),
        "nearPhrases": heard(near_rows),
        "cafeTalk": {"minutes": round(hours * 60, 1),
                     "falseWakes": {f"phases{count}": events for count, events in talk_events.items()}},
    }
    RESULTS.parent.mkdir(parents=True, exist_ok=True)
    RESULTS.write_text(json.dumps({"summary": report, "wake": wake_rows, "near": near_rows}, indent=1) + "\n")
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
