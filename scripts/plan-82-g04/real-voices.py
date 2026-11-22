"""Plan 91 phase 6: score each wake model on a person's own voice.

`record` asks one person to say "Hey Satyr" and "Hey Sous Chef" 10 times each at 1 m and at 2 m
from this Mac, in a mixed order, and keeps each 3 s take in .cache/human/wake-<time>/. The
recordings stay on this Mac. `score` runs both wake models on every take. A model hears a take
when its best window reaches the Portal's threshold. Each model also scores the other phrase's
takes, which must not wake it.

Usage (the wake bench's Python, and ffmpeg):
  ~/.satyr-voice-test/wake/.venv/bin/python scripts/plan-82-g04/real-voices.py record
  ~/.satyr-voice-test/wake/.venv/bin/python scripts/plan-82-g04/real-voices.py score [<folder>] [<Sous Chef model>]

Results: output/shop-voice/wake-real-voices-<folder>.json
"""
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from phrases import DATA, PHRASES

ROOT = Path(__file__).resolve().parents[2]
# The main clone's .cache/human, also from a worktree, so the takes outlive the worktree.
HUMAN = Path(subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=ROOT,
                            capture_output=True, text=True, check=True).stdout.strip()).parent / ".cache/human"
THRESHOLD = 0.995
TAKES = 10
SECONDS = 3.0
DISTANCES = ("1 m", "2 m")
MICROPHONE = "MacBook Pro Microphone"


def microphone() -> str:
    listing = subprocess.run(["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
                             capture_output=True, text=True).stderr
    return f":{MICROPHONE}" if MICROPHONE in listing else ":default"


def record() -> None:
    folder = HUMAN / time.strftime("wake-%Y-%m-%d-%H%M")
    folder.mkdir(parents=True)
    device = microphone()
    phrases = [PHRASES["satyr"], PHRASES["sous-chef"]]
    rng = np.random.default_rng(91)
    takes = []
    print("Each take records 3 seconds. Say the phrase once, in your usual voice, after the prompt.")
    for distance in DISTANCES:
        input(f"\nStand about {distance} from the Mac. Press Return when you are ready.")
        order = [phrase for phrase in phrases for _ in range(TAKES)]
        rng.shuffle(order)
        for number, phrase in enumerate(order, 1):
            name = f"{distance.replace(' ', '')}-{number:02d}-{phrase.slug}.wav"
            print(f"  {number:2d}/{len(order)}  Say: {phrase.title}", flush=True)
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", device,
                            "-t", str(SECONDS), "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", str(folder / name)],
                           check=True)
            takes.append({"file": name, "phrase": phrase.key, "distance": distance})
            time.sleep(0.5)
    (folder / "session.json").write_text(json.dumps({"takes": takes}, indent=1) + "\n")
    print(f"\nDone. {len(takes)} takes in {folder}. Now run: real-voices.py score")


def score(folder: Path, sous_chef_model: Path) -> None:
    import onnxruntime as ort
    import soundfile as sf
    sys.path.insert(0, str(Path(__file__).parent))
    import wake as w

    features = w.Features(DATA / "models")
    models = {"satyr": ROOT / "apps/portal/public/voice/hey_satyr.onnx", "sous-chef": sous_chef_model}
    sessions = {key: ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]) for key, path in models.items()}
    takes = json.loads((folder / "session.json").read_text())["takes"]
    rows = []
    for take in takes:
        audio, rate = sf.read(folder / take["file"], dtype="float64")
        assert rate == w.RATE
        # A second of quiet before the take, as the live stream has, so the first window is whole.
        frames = features(np.concatenate([np.zeros(w.RATE), audio])).astype(np.float32)
        x = np.stack([frames[i:i + 16] for i in range(len(frames) - 15)])
        rows.append({**take, **{key: round(float(session.run(None, {"input": x})[0].max()), 5)
                                for key, session in sessions.items()}})
    summary = {}
    for model in models:
        for phrase in models:
            for distance in DISTANCES:
                picked = [row[model] for row in rows if row["phrase"] == phrase and row["distance"] == distance]
                kind = "heard" if model == phrase else "woke on the other phrase"
                summary[f"{PHRASES[model].title} model, {PHRASES[phrase].title} at {distance}"] = \
                    f"{kind}: {sum(s >= THRESHOLD for s in picked)} of {len(picked)}"
    result = {"threshold": THRESHOLD, "models": {k: str(v) for k, v in models.items()}, "summary": summary, "takes": rows}
    path = ROOT / "output/shop-voice" / f"wake-real-voices-{folder.name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps(summary, indent=1))
    print("->", path.relative_to(ROOT))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "record":
        record()
    elif command == "score":
        folder = Path(sys.argv[2]) if len(sys.argv) > 2 else max(HUMAN.glob("wake-*"), key=lambda p: p.stat().st_mtime)
        model = Path(sys.argv[3]) if len(sys.argv) > 3 else PHRASES["sous-chef"].onnx(DATA)
        score(folder, model)
    else:
        raise SystemExit(__doc__)
