#!/usr/bin/env python3
"""What Whisper's own confidence values say about noise and about real commands (Plan 82).

The Mac's Whisper invents words on room noise when it has the shop's vocabulary as its prompt. This
bench runs noise with no speech and macOS speech over the same noise, with the same settings as the
service, and writes each transcript with its values. It then prints what each rule would drop. The
speech is synthetic and the noise is recorded: this bench compares rules, and it does not predict a
real room.

Run it with the Mac service's Python, because that one has mlx_whisper:

    ~/.pantry-voice/venv/bin/python scripts/shop-voice/confidence-bench.py

SHOP_VOICE_WORKERS_AI_URL sends each clip to Whisper on Workers AI instead, the Platform's fallback, through
a Worker that returns the model's whole answer. The fallback uses the same engine rule
(`voice/engines/workers-ai-whisper.ts`), and the Mac's rule comes from `shop_voice.engines.whisper_mlx`.
The Portal's text check (`keptVoiceText`) runs through the shipped code (`portal-voice.mjs`), so this
bench keeps no copy of it (Plan 82C).

SHOP_VOICE_QWEN3 names a Qwen3-ASR MLX folder and sends each clip to that model instead, with the same words
as hotwords. The service's Python has mlx-audio from 0.5.0. Qwen3-ASR gives one segment for a command and no
`no_speech_prob`; the bench takes the log-probability of each token that it chose, so `logprob` is the
mean over the tokens and `minLogprob` the lowest token. `keptText` and `engineSeconds` come from the
shipped engine (`shop_voice.engines.qwen3_mlx`), with its rule and its early stop, so the bench measures
what a Mac sends to the Portal and how long the Portal waits.

SHOP_VOICE_NOISE names an .npz file of 16 kHz float32 noise, one array for each kind of noise.
SHOP_VOICE_PROMPT replaces the vocabulary with other comma-separated terms.
SHOP_VOICE_VOICES names the macOS voices, and SHOP_VOICE_RESULTS the results file. The second run
uses other noise and other voices, because the first run chose the rule's numbers.
Results: output/shop-voice/confidence-bench.json
"""
import base64
import io
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.request
import uuid
import wave
import zlib
import sys
from functools import cache
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/shop-voice"))
from shop_voice import state  # noqa: E402
from shop_voice.engines import qwen3_mlx, whisper_mlx  # noqa: E402

# The Mac's own Whisper files, in their engine folder since service 0.4.0.
MODEL = state.engine_dir(whisper_mlx.ID)
NOISE = Path(os.environ.get("SHOP_VOICE_NOISE", Path.home() / ".pantry-voice-test/wake/noise-test.npz"))
RESULTS = ROOT / "output/shop-voice" / os.environ.get("SHOP_VOICE_RESULTS", "confidence-bench.json")
WORKERS_AI_URL = os.environ.get("SHOP_VOICE_WORKERS_AI_URL")
QWEN3 = os.environ.get("SHOP_VOICE_QWEN3")
# A command is short. On noise, a model can repeat a phrase until its limit.
QWEN3_MAX_TOKENS = 160
SAMPLE_RATE = 16_000
NOISE_CLIP_SECONDS = 6
# A person can hold the key after the last word, and the room goes on.
TAIL_SECONDS = (3, 9)
TAIL_LEVEL_DB = (5, None)
# The Portal's wait for the Mac: `macDeadline` of each engine in packages/control-api/src/voice-engines.ts.
MAC_DEADLINE_BASE_SECONDS = 1.0
MAC_DEADLINE_PER_AUDIO_SECOND = 0.3
LEVELS_DB = (None, 10, 5, 0)
VOICES = tuple(os.environ.get("SHOP_VOICE_VOICES", "Samantha,Daniel,Karen").split(","))
# A shop's vocabulary, with the terms that Whisper repeated on noise in the owner's first test.
PROMPT = os.environ.get("SHOP_VOICE_PROMPT") or ", ".join((
    "Black sesame", "Matcha Tea", "Kouign-amann", "financier", "croissant", "ginger tea", "siphon", "latte",
    "pour-over", "Sous Chef", "brown butter", "pistachio", "madeleine", "canelé"))
COMMANDS = (
    "Put two trays of kouign amann in the second oven.",
    "How much butter is left for tomorrow?",
    "Mark the black sesame financiers as sold out.",
    "Start the shift for the morning bake.",
    "Stop.",
    "Cancel.",
    "Show me today's failed payments.",
    "Open the order queue.",
    "Add twelve croissants to the first order.",
    "Change that to ten trays.",
    "Label the second tray.",
    "Send the supplier a message about the flour.",
    "What time does the matcha latte batch finish?",
    "Yes, do that.",
    "Confirm change three seven five.",
    "Send message nine six three.",
    "Run and play the shift.",
    "Move the pistachio cakes to the front case.",
    # A command of about 14 s, near the 15 s limit, so that a long command stays under Qwen3-ASR's token cap.
    "Tomorrow morning bake four trays of kouign amann and two trays of black sesame financiers, then three "
    "trays of pistachio madeleines, move the brown butter to the second chiller, and send the supplier a "
    "message about the flour for Friday.",
)


def speech(voice: str, text: str, folder: str) -> np.ndarray:
    path = Path(folder) / f"{uuid.uuid4().hex}.wav"
    subprocess.run(["say", "-v", voice, "-o", str(path), "--data-format=LEI16@16000", text], check=True, timeout=60)
    with wave.open(str(path)) as file:
        samples = np.frombuffer(file.readframes(file.getnframes()), dtype="<i2").astype("float32") / 32768.0
    path.unlink()
    return samples


def mixed(voice: np.ndarray, noise: np.ndarray, level_db: float | None, at: int, tail: float = 0.5) -> np.ndarray:
    """The capture holds some room sound before and after the words, as a real command does."""
    padded = np.concatenate([np.zeros(SAMPLE_RATE // 2, "float32"), voice, np.zeros(int(SAMPLE_RATE * tail), "float32")])
    if level_db is None:
        return padded
    part = np.resize(noise[at % len(noise):], len(padded))
    voice_power = float(np.mean(voice ** 2))
    noise_power = float(np.mean(part ** 2)) or 1e-9
    gain = (voice_power / (noise_power * 10 ** (level_db / 10))) ** 0.5
    together = padded + gain * part
    return np.clip(together, -1, 1).astype("float32")


def wav_base64(samples: np.ndarray) -> str:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(SAMPLE_RATE)
        file.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
    return base64.b64encode(buffer.getvalue()).decode()


def compression_ratio(text: str) -> float:
    """Whisper's own measure of repeated text."""
    data = text.encode()
    return len(data) / len(zlib.compress(data)) if data else 0.0


@cache
def qwen3_model():
    from mlx_audio.stt.utils import load
    return load(QWEN3, model_type="qwen3_asr")


def qwen3(samples: np.ndarray) -> dict:
    import mlx.core as mx
    model = qwen3_model()
    tokens: list[int] = []
    chosen: list[float] = []
    # The same system prompt as `generate(hotwords=...)`, and the same greedy choice as temperature 0. In
    # bf16 the log-probabilities move in steps of 0.125, so most tokens read 0; float32 does not change the
    # chosen token.
    for token, logprobs in model.stream_generate(mx.array(samples), max_tokens=QWEN3_MAX_TOKENS,
                                                 language="English", system_prompt=PROMPT,
                                                 logits_processors=[lambda _, logits: logits.astype(mx.float32)]):
        tokens.append(int(token))
        chosen.append(float(logprobs[int(token)]))
    text = model._tokenizer.decode(tokens, skip_special_tokens=True)
    segments = [{"text": text, "start": 0.0, "end": len(samples) / SAMPLE_RATE,
                 "avg_logprob": sum(chosen) / len(chosen), "min_logprob": min(chosen),
                 "compression_ratio": compression_ratio(text), "no_speech_prob": float("nan"),
                 "tokens": len(tokens), "capped": len(tokens) == QWEN3_MAX_TOKENS}] if tokens else []
    return {"text": text, "segments": segments}


@cache
def qwen3_engine() -> qwen3_mlx.Qwen3Mlx:
    """The shipped engine on the bench's own model, so that one copy is in memory."""
    engine = qwen3_mlx.Qwen3Mlx()
    engine._model = qwen3_model()
    return engine


def transcribe(samples: np.ndarray) -> dict:
    if QWEN3 is not None:
        return qwen3(samples)
    if WORKERS_AI_URL is None:
        import mlx_whisper
        return mlx_whisper.transcribe(samples, path_or_hf_repo=str(MODEL), language="en", temperature=0.0,
                                      condition_on_previous_text=False, initial_prompt=PROMPT, verbose=None)
    body = json.dumps({"audio": wav_base64(samples), "prompt": PROMPT}).encode()
    request = urllib.request.Request(WORKERS_AI_URL, data=body, headers={"content-type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                answer = json.load(response)
            break
        except OSError:
            if attempt == 2:
                raise
    # Workers AI can leave out a segment's values; a missing value reads as noise, as in the Platform.
    segments = [{"text": s.get("text", ""), "start": s.get("start", 0.0), "end": s.get("end", 0.0),
                 "avg_logprob": s.get("avg_logprob", float("nan")),
                 "compression_ratio": s.get("compression_ratio", float("nan")),
                 "no_speech_prob": s.get("no_speech_prob", 1.0)} for s in answer["segments"] or []]
    return {"text": answer["text"], "segments": segments}


def hear(samples: np.ndarray) -> dict:
    result = transcribe(samples)
    segments = result["segments"]
    seconds = sum(max(s["end"] - s["start"], 0.01) for s in segments)
    engine_seconds = None
    if QWEN3 is not None:
        began = time.perf_counter()
        kept_text = qwen3_engine().hear(samples, tuple(NAMES))
        engine_seconds = time.perf_counter() - began
    else:
        kept_text = "".join(s["text"] for s in segments if not whisper_mlx.is_noise(s)).strip()
    return {
        "text": result["text"].strip(),
        "keptText": kept_text,
        "engineSeconds": engine_seconds,
        "audioSeconds": len(samples) / SAMPLE_RATE,
        "segments": len(segments),
        "meanLogprob": sum(s["avg_logprob"] * max(s["end"] - s["start"], 0.01) for s in segments) / seconds
        if segments else -10.0,
        "noSpeech": max((s["no_speech_prob"] for s in segments), default=1.0),
        "logprob": min((s["avg_logprob"] for s in segments), default=-10.0),
        "minLogprob": min((s.get("min_logprob", s["avg_logprob"]) for s in segments), default=-10.0),
        "compression": max((s["compression_ratio"] for s in segments), default=0.0),
        "capped": any(s.get("capped", False) for s in segments),
    }


def words(text: str) -> list[str]:
    return re.sub(r"[^a-z0-9' ]+", " ", text.lower()).split()


def word_score(expected: str, heard: str) -> float:
    wanted = words(expected)
    got = words(heard)
    return sum(1 for word in wanted if word in got) / len(wanted)


NAMES = PROMPT.split(", ")
# What the Portal keeps of each text, filled in `main` through the shipped code.
KEPT: dict[str, str] = {}


def portal_kept(texts: list[str]) -> dict[str, str]:
    """The Portal's text check (`keptVoiceText`) on each text, through `portal-voice.mjs`."""
    unique = sorted(set(texts))
    answer = subprocess.run(["node", str(ROOT / "scripts/shop-voice/portal-voice.mjs"), "kept"],
                            input=json.dumps({"names": NAMES, "texts": unique}), capture_output=True, text=True,
                            check=True)
    return dict(zip(unique, json.loads(answer.stdout)))


def portal_drops(text: str) -> bool:
    return KEPT[text] == ""


RULES = {
    "Portal text check only": lambda r: False,
    "no speech > 0.6 and logprob < -1 (Whisper's silence rule)": lambda r: r["noSpeech"] > 0.6 and r["logprob"] < -1.0,
    "compression > 2.4": lambda r: r["compression"] > 2.4,
    "logprob < -1": lambda r: r["logprob"] < -1.0,
    "no speech > 0.6": lambda r: r["noSpeech"] > 0.6,
    "silence rule or compression": lambda r: (r["noSpeech"] > 0.6 and r["logprob"] < -1.0) or r["compression"] > 2.4,
    "logprob < -1 or compression": lambda r: r["logprob"] < -1.0 or r["compression"] > 2.4,
    "worst logprob < -1.4 or compression": lambda r: not r["logprob"] >= -1.4 or r["compression"] > 2.4,
    "mean logprob < -1.4 or compression": lambda r: not r["meanLogprob"] >= -1.4 or r["compression"] > 2.4,
}


def segment_rule(noise_rows: list[dict], speech_rows: list[dict]) -> dict:
    """The bad segments go, and the good ones stay. This is the service's rule."""
    def good(row: dict) -> bool:
        return not portal_drops(row["keptText"]) and word_score(row["command"], row["keptText"]) >= 0.8

    was_good = [r for r in speech_rows if r["score"] >= 0.8]
    tails = [r for r in was_good if r["tail"]]
    timed = [r for r in noise_rows + speech_rows if r["engineSeconds"] is not None]
    late = [r for r in timed if r["engineSeconds"] > MAC_DEADLINE_BASE_SECONDS
            + MAC_DEADLINE_PER_AUDIO_SECOND * r["audioSeconds"]]
    return {
        "rule": "the engine's rule" + (" with its early stop" if QWEN3 else ""),
        "noiseClipsSent": f"{sum(not portal_drops(r['keptText']) for r in noise_rows)} of {len(noise_rows)}",
        "clipsAfterThePortalsWait": f"{len(late)} of {len(timed)}" if timed else None,
        "noiseEngineSecondsMax": round(max((r["engineSeconds"] for r in noise_rows if r["engineSeconds"] is not None),
                                           default=0.0), 2) if timed else None,
        "goodCommandsLost": f"{sum(not good(r) for r in was_good if not r['tail'])} of {len(was_good) - len(tails)}",
        "tailGoodLost": f"{sum(not good(r) for r in tails)} of {len(tails)}",
        "sentNoise": [r["keptText"][:60] for r in noise_rows if not portal_drops(r["keptText"])],
        "lost": [(r["command"], r["level"], r["tail"], r["keptText"][:40]) for r in was_good if not good(r)],
    }


def report(noise_rows: list[dict], speech_rows: list[dict]) -> list[dict]:
    lines = []
    for name, rule in RULES.items():
        sent_noise = [r for r in noise_rows if not portal_drops(r["text"]) and not rule(r)]
        kept = {str(level): [r for r in speech_rows if r["level"] == level and not r["tail"]
                             and not portal_drops(r["text"]) and not rule(r)] for level in LEVELS_DB}
        tails = [r for r in speech_rows if r["tail"]]
        lines.append({
            "rule": name,
            "noiseClipsSent": f"{len(sent_noise)} of {len(noise_rows)}",
            "commandsKept": {level: f"{len(rows)} of {sum(1 for r in speech_rows if str(r['level']) == level and not r['tail'])}"
                             for level, rows in kept.items()},
            "tailGoodLost": sum(1 for r in tails if r["score"] >= 0.8 and (portal_drops(r["text"]) or rule(r))),
            "tailGood": sum(1 for r in tails if r["score"] >= 0.8),
            "goodCommandsLost": sum(1 for r in speech_rows if r["score"] >= 0.8 and (portal_drops(r["text"]) or rule(r))),
            "goodCommands": sum(1 for r in speech_rows if r["score"] >= 0.8),
            "badCommandsStopped": sum(1 for r in speech_rows if r["score"] < 0.8 and (portal_drops(r["text"]) or rule(r))),
            "badCommands": sum(1 for r in speech_rows if r["score"] < 0.8),
        })
    return lines


def main() -> None:
    noises = dict(np.load(NOISE))
    noise_rows = []
    for kind, noise in noises.items():
        clip = NOISE_CLIP_SECONDS * SAMPLE_RATE
        for at in range(0, len(noise) - clip, clip):
            part = noise[at:at + clip]
            noise_rows.append({"noise": kind, **hear(np.clip(part, -1, 1).astype("float32"))})
        print(kind, "noise done", flush=True)
    speech_rows = []
    kinds = list(noises)
    with tempfile.TemporaryDirectory() as folder:
        for voice in VOICES:
            for index, command in enumerate(COMMANDS):
                samples = speech(voice, command, folder)
                for level in LEVELS_DB:
                    kind = kinds[index % len(kinds)]
                    heard = hear(mixed(samples, noises[kind], level, index * 37_000))
                    speech_rows.append({"voice": voice, "command": command, "level": level, "noise": kind, **heard,
                                        "tail": False, "score": word_score(command, heard["text"])})
                kind = kinds[index % len(kinds)]
                for seconds in TAIL_SECONDS:
                    for level in TAIL_LEVEL_DB:
                        heard = hear(mixed(samples, noises[kind], level, index * 53_000, seconds))
                        speech_rows.append({"voice": voice, "command": command, "level": level, "noise": kind, **heard,
                                            "tail": True, "score": word_score(command, heard["text"])})
            print(voice, "speech done", flush=True)
    rows = noise_rows + speech_rows
    KEPT.update(portal_kept([r["text"] for r in rows] + [r["keptText"] for r in rows]))
    summary = [segment_rule(noise_rows, speech_rows), *report(noise_rows, speech_rows)]
    RESULTS.parent.mkdir(parents=True, exist_ok=True)
    RESULTS.write_text(json.dumps({"summary": summary, "noise": noise_rows, "speech": speech_rows}, indent=1) + "\n")
    for line in summary:
        print(json.dumps(line))


if __name__ == "__main__":
    main()
