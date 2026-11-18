#!/usr/bin/env python3
"""Satyr's approval phrases and the words "stop" and "cancel" on one speech engine (Plan 82C Phase 0).

The same macOS voices say each approval phrase ("confirm change", "send message", "send email" and three
digits), near misses of a phrase, and "Stop." and "Cancel.", in quiet and over recorded kitchen noise. The
engine hears each clip with the shop's vocabulary, with the same settings and noise rule as
`confidence-bench.py`, which this script loads. The script writes what the engine heard; `phrase-score.mjs`
scores the file with the Portal's own code. The speech is synthetic: this compares engines, and it does not
predict a real room.

Run it once for each engine, with the Python of that engine (see `confidence-bench.py`):

    ~/.satyr-voice/venv/bin/python scripts/shop-voice/phrase-bench.py
    SHOP_VOICE_QWEN3=<Qwen3-ASR MLX folder> SHOP_VOICE_RESULTS=phrase-bench-qwen3.json <mlx-audio python> \
        scripts/shop-voice/phrase-bench.py
    node scripts/shop-voice/phrase-score.mjs output/shop-voice/phrase-bench.json output/shop-voice/phrase-bench-qwen3.json

SHOP_VOICE_RESULTS names the results file in output/shop-voice (default phrase-bench.json).

Plan 82C Phase 3 runs the same cases on real voices. `phrase-bench.py prompts` writes what the recorder
(`apps/portal/voice-recorder.html`, started with `scripts/shop-voice/recorder.vite.config.ts`) asks a person
to say: the commands, the approval phrases and their near misses, "Stop." and "Cancel.", commands from about
2 m with the wake phrase, two bare lists of names, and 30 s of each room sound. The recordings stay on this
Mac in `.cache/human/<session>/`. Then both engines hear the same clips, and the scorer compares them:

    ~/.satyr-voice/venv/bin/python scripts/shop-voice/phrase-bench.py human .cache/human/<session>

A run can join sessions, and `:-<set>` leaves a set of one session out: the commands of one session with
the room sound of another, recorded in the shop (`voice-recorder.html?only=room`):

    phrase-bench.py human .cache/human/<commands>:-room .cache/human/<room sound>

SHOP_VOICE_QWEN3 names the Qwen3-ASR folder when the Mac has none in `~/.satyr-voice/model/qwen3-asr-1.7b`.
"""
import importlib.util
import json
import os
import random
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
# A run on recordings: a JSON list of the recorder's session folders, each as `<folder>` or
# `<folder>:-<set>,<set>` (Plan 82C Phase 3).
HUMAN = json.loads(os.environ["SHOP_VOICE_HUMAN"]) if "SHOP_VOICE_HUMAN" in os.environ else None


def human_specs(specs: list[str]) -> list[tuple[Path, set[str]]]:
    parts = [spec.partition(":-") for spec in specs]
    return [(Path(folder), set(filter(None, skip.split(",")))) for folder, _, skip in parts]


def human_name(specs: list[str]) -> str:
    return "+".join(folder.name for folder, _ in human_specs(specs))


os.environ.setdefault(
    "SHOP_VOICE_RESULTS",
    f"human-{human_name(HUMAN)}-{'qwen3' if os.environ.get('SHOP_VOICE_QWEN3') else 'whisper'}.json"
    if HUMAN else "phrase-bench.json")
_spec = importlib.util.spec_from_file_location("confidence_bench", HERE / "confidence-bench.py")
bench = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bench)

# Six voices with six accents, as in the Plan 82 measure of the phrase words.
PHRASE_VOICES = ("Samantha", "Daniel", "Karen", "Moira", "Rishi", "Tessa")
# More voices for one-word commands, because one wrong word is the whole result.
STOP_VOICES = PHRASE_VOICES + (
    "Fred", "Kathy", "Ralph", "Albert", "Eddy (English (US))", "Eddy (English (UK))", "Flo (English (US))",
    "Flo (English (UK))", "Reed (English (US))", "Reed (English (UK))", "Sandy (English (US))",
    "Shelley (English (UK))", "Rocko (English (US))", "Grandma (English (UK))", "Grandpa (English (US))")
# `services/platform/src/voice/confirmation.ts`
HEADS = ("confirm change", "send message", "send email")
DIGITS = ("three", "five", "six", "seven", "nine")
PHRASES_PER_HEAD = 3


def near_misses(head: str, digits: list[str], rng: random.Random) -> list[tuple[str, str]]:
    """What a person says that must not confirm the phrase: the kind and the spoken words."""
    other = list(digits)
    other[-1] = rng.choice([d for d in DIGITS if d != digits[-1]])
    noun = head.split()[1]
    return [
        ("negation", f"Don't {head} {' '.join(digits)}."),
        ("other digits", f"{head.capitalize()} {' '.join(other)}."),
        ("other verb", f"Cancel {noun} {' '.join(digits)}."),
        ("missing digit", f"{head.capitalize()} {' '.join(digits[:2])}."),
    ]


# The bench's commands that are neither a stop word nor an approval phrase: those have their own sets.
SPOKEN_COMMANDS = tuple(command for command in bench.COMMANDS
                        if command.rstrip(".").lower() not in ("stop", "cancel")
                        and not command.lower().startswith(HEADS))
# Commands that a person says from about 2 m, after the wake phrase, as at the counter.
FAR_COMMANDS = SPOKEN_COMMANDS[1:11:2]
# A bare list of names loses the command today (Plan 82C, Risks). Real voices say how often.
LISTS = ("Croissant, latte.", "Matcha tea, black sesame.")
ROOM_SOUNDS = ("the espresso machine or the grinder runs", "people talk near the Mac",
               "music or the radio plays", "a normal moment in the shop")
ROOM_SECONDS = 30


def human_prompts() -> list[dict]:
    """What the recorder asks for, in order. The digits come from a fixed seed, so each session is the same."""
    rng = random.Random(83)
    prompts = [{"set": "command", "kind": "command", "target": text, "spoken": text} for text in SPOKEN_COMMANDS]
    for head in HEADS:
        for _ in range(PHRASES_PER_HEAD):
            digits = [rng.choice(DIGITS) for _ in range(3)]
            phrase = f"{head} {' '.join(digits)}"
            prompts.append({"set": "phrase", "kind": "phrase", "target": phrase, "spoken": f"{phrase.capitalize()}."})
        digits = [rng.choice(DIGITS) for _ in range(3)]
        for kind, spoken in near_misses(head, digits, rng):
            prompts.append({"set": "near", "kind": kind, "target": f"{head} {' '.join(digits)}", "spoken": spoken})
    for word in ("stop", "cancel"):
        prompts += [{"set": "stop", "kind": word, "target": word, "spoken": f"{word.capitalize()}."}] * 4
    prompts += [{"set": "far", "kind": "wake", "target": text, "spoken": text} for text in FAR_COMMANDS]
    prompts += [{"set": "list", "kind": "list", "target": text, "spoken": text} for text in LISTS]
    prompts += [{"set": "room", "kind": sound, "target": "", "spoken": "", "seconds": ROOM_SECONDS}
                for sound in ROOM_SOUNDS]
    return [{"index": index, **prompt} for index, prompt in enumerate(prompts)]


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as file:
        return np.frombuffer(file.readframes(file.getnframes()), dtype="<i2").astype("float32") / 32768.0


def human_clips(folder: Path, skip: set[str]) -> tuple[list[tuple[dict, np.ndarray]], list[dict]]:
    """The recorded clips, with each room recording cut into the bench's noise clips, and the misses.

    The recorder writes one line for each attempt in `clips.jsonl`. A later attempt of the same prompt
    replaces the clip of an earlier one; a miss (the device heard no speech, or no wake phrase) stays
    a miss of that prompt, because a person in the shop would have had to say it again too."""
    lines = [line for line in (json.loads(text) for text in (folder / "clips.jsonl").read_text().splitlines()
                               if text.strip()) if line["set"] not in skip]
    latest = {line["index"]: line for line in lines if line["event"] == "captured"}
    misses = [line for line in lines if line["event"] != "captured"]
    clips = []
    size = bench.NOISE_CLIP_SECONDS * bench.SAMPLE_RATE
    for line in sorted(latest.values(), key=lambda line: line["index"]):
        samples = read_wav(folder / line["file"])
        line = {**line, "session": folder.name}
        if line["set"] == "room":
            for part, at in enumerate(range(0, len(samples) - size + 1, size)):
                clips.append(({**line, "part": part}, samples[at:at + size]))
        else:
            clips.append((line, samples))
    return clips, misses


def names_in(text: str) -> set[str]:
    lowered = text.lower()
    return {name for name in bench.NAMES if name.lower() in lowered}


def hear_human(specs: list[str]) -> None:
    clips, misses = [], []
    for folder, skip in human_specs(specs):
        found, missed = human_clips(folder, skip)
        clips += found
        misses += [{**miss, "session": folder.name} for miss in missed]
    engine = "qwen3-asr-1.7b" if bench.QWEN3 else "whisper-large-v3-turbo"
    rows = []
    # A Mac loads and warms its engine before a command comes, so the first clip does not pay the load.
    began = time.perf_counter()
    bench.hear(np.zeros(bench.SAMPLE_RATE, dtype="float32"))
    load_seconds = time.perf_counter() - began
    started = time.perf_counter()
    first_call = None
    for case, samples in clips:
        at = time.perf_counter()
        heard = bench.hear(samples)
        seconds = heard["engineSeconds"] if heard["engineSeconds"] is not None else time.perf_counter() - at
        first_call = seconds if first_call is None else first_call
        wanted = names_in(case["target"])
        rows.append({**case, "level": None, "noise": None, "audioSeconds": len(samples) / bench.SAMPLE_RATE,
                     "seconds": seconds, "text": heard["text"], "keptText": heard["keptText"],
                     "wordScore": bench.word_score(case["target"], heard["keptText"]) if case["target"] else None,
                     "namesWanted": len(wanted), "namesRight": len(wanted & names_in(heard["keptText"]))})
    result = {"engine": engine, "vocabulary": bench.PROMPT, "session": human_name(specs), "loadSeconds": load_seconds,
              "firstCallSeconds": first_call,
              "wallSeconds": time.perf_counter() - started, "rows": rows, "misses": misses}
    bench.RESULTS.parent.mkdir(parents=True, exist_ok=True)
    bench.RESULTS.write_text(json.dumps(result, indent=1) + "\n")
    print(f"{engine}: {len(rows)} clips and {len(misses)} misses -> {bench.RESULTS}", flush=True)


def human(specs: list[str]) -> None:
    """Both engines hear the sessions' clips in their own process, one model in memory at a time; then the score."""
    qwen3 = os.environ.get("SHOP_VOICE_QWEN3") or str(bench.state.engine_dir(bench.qwen3_mlx.ID))
    if not (Path(qwen3) / "model.safetensors").exists():
        sys.exit(f"No Qwen3-ASR files in {qwen3}: set SHOP_VOICE_QWEN3.")
    results = []
    for extra in ({}, {"SHOP_VOICE_QWEN3": qwen3}):
        env = {key: value for key, value in os.environ.items()
               if key not in ("SHOP_VOICE_QWEN3", "SHOP_VOICE_RESULTS")}
        resolved = [f"{folder.resolve()}{':-' + ','.join(sorted(skip)) if skip else ''}"
                    for folder, skip in human_specs(specs)]
        env.update(extra, SHOP_VOICE_HUMAN=json.dumps(resolved))
        name = f"human-{human_name(specs)}-{'qwen3' if extra else 'whisper'}.json"
        subprocess.run([sys.executable, __file__], env={**env, "SHOP_VOICE_RESULTS": name}, check=True)
        results.append(str(bench.RESULTS.parent / name))
    subprocess.run(["node", str(HERE / "phrase-score.mjs"), *results], check=True)


def main() -> None:
    if sys.argv[1:2] == ["prompts"]:
        print(json.dumps(human_prompts()))
        return
    if sys.argv[1:2] == ["human"]:
        human(sys.argv[2:])
        return
    if HUMAN is not None:
        hear_human(HUMAN)
        return
    rng = random.Random(82)
    cases = []
    for voice in PHRASE_VOICES:
        for head in HEADS:
            for _ in range(PHRASES_PER_HEAD):
                digits = [rng.choice(DIGITS) for _ in range(3)]
                phrase = f"{head} {' '.join(digits)}"
                cases.append({"set": "phrase", "voice": voice, "kind": "phrase", "target": phrase,
                              "spoken": f"{phrase.capitalize()}."})
        head = HEADS[len(cases) % len(HEADS)]
        digits = [rng.choice(DIGITS) for _ in range(3)]
        for kind, spoken in near_misses(head, digits, rng):
            cases.append({"set": "near", "voice": voice, "kind": kind,
                          "target": f"{head} {' '.join(digits)}", "spoken": spoken})
    for voice in STOP_VOICES:
        for word in ("stop", "cancel"):
            cases.append({"set": "stop", "voice": voice, "kind": word, "target": word,
                          "spoken": f"{word.capitalize()}."})

    noises = dict(np.load(bench.NOISE))
    kinds = list(noises)
    engine = "qwen3-asr-1.7b" if bench.QWEN3 else "whisper-large-v3-turbo"
    rows = []
    started = time.perf_counter()
    first_call = None
    with tempfile.TemporaryDirectory() as folder:
        for index, case in enumerate(cases):
            samples = bench.speech(case["voice"], case["spoken"], folder)
            for level in bench.LEVELS_DB:
                kind = kinds[index % len(kinds)]
                clip = bench.mixed(samples, noises[kind], level, index * 41_000)
                at = time.perf_counter()
                heard = bench.hear(clip)
                seconds = time.perf_counter() - at
                if first_call is None:
                    first_call = seconds
                rows.append({**case, "level": level, "noise": kind if level is not None else None,
                             "audioSeconds": len(clip) / bench.SAMPLE_RATE, "seconds": seconds,
                             "text": heard["text"], "keptText": heard["keptText"]})
            if index % 20 == 19:
                print(f"{index + 1} of {len(cases)} cases", flush=True)
    result = {"engine": engine, "vocabulary": bench.PROMPT, "firstCallSeconds": first_call,
              "wallSeconds": time.perf_counter() - started, "rows": rows}
    bench.RESULTS.parent.mkdir(parents=True, exist_ok=True)
    bench.RESULTS.write_text(json.dumps(result, indent=1) + "\n")
    print(f"{engine}: {len(rows)} clips -> {bench.RESULTS}")


if __name__ == "__main__":
    main()
