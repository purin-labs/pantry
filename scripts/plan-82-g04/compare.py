"""Plan 91 phase 6: compare a new wake phrase model with the "Hey Satyr" model, and say if it passes.

The rule was fixed before the first "Hey Sous Chef" model was measured. Everything is at the
Portal's threshold, 0.995 (WAKE_THRESHOLD in apps/portal/src/features/voice/wake-worker.ts).

1. False wakes. The sum of events on every shared false-wake set (held-out LibriSpeech speakers,
   LibriSpeech test-clean with and without noise, and DEMAND noise) is not more than for
   "Hey Satyr". The sets are the same files for both phrases.
2. Recall on held-out Piper speakers. In each of the seven noise and distance conditions, the new
   model hears at most 2 percentage points less than "Hey Satyr", and its mean over the seven
   conditions is not lower.
3. Another speech engine. On the macOS voices, which neither model trained on, the mean share
   heard over the six conditions is at most 5 points lower, and the mean share of near phrases
   accepted is at most 5 points higher.

The near phrases differ for each phrase, and so do six lines of the café talk in phase-bench.py.
Those numbers are in the report, but they do not decide.

Usage: <wake venv>/bin/python compare.py [sous-chef]
Results: output/shop-voice/wake-phrase-compare-<slug>.json
"""
import json
import sys
from pathlib import Path

from phrases import DATA, PHRASES

THRESHOLD = "0.995"
RECALL_MARGIN = 0.02
ENGINE_MARGIN = 0.05
ROOT = Path(__file__).resolve().parents[2]


def load(path: Path) -> dict | None:
    return json.loads(path.read_text()) if path.exists() else None


def measure(key: str) -> dict:
    phrase = PHRASES[key]
    folder = phrase.folder(DATA)
    report = load(folder / "report.json")
    if report is None:
        raise SystemExit(f"No report for {phrase.title} in {folder}. Run train.py --phrase {key}.")
    macos = load(folder / "report-macos-voices.json")
    bench = load(ROOT / "output/shop-voice" / ("wake-phase-bench.json" if key == "satyr" else f"wake-phase-bench-{phrase.slug}.json"))
    wakes = {name: entry["events"][THRESHOLD] for name, entry in report["falseWakes"].items()}
    hours = {name: entry["hours"] for name, entry in report["falseWakes"].items()}
    heldout = ("test-train-clean-100-clean", "test-train-clean-100-noisy")
    result = {
        "phrase": phrase.title,
        "falseWakes": wakes,
        "falseWakeHours": hours,
        "falseWakesTotal": sum(wakes.values()),
        "falseWakesPer8hHeldOut": round(sum(wakes[n] for n in heldout) / sum(hours[n] for n in heldout) * 8, 2),
        "recall": {name: values[THRESHOLD] for name, values in report["wake"].items()},
        "nearTest": report["near"][THRESHOLD],
    }
    result["recallMean"] = round(sum(result["recall"].values()) / len(result["recall"]), 4)
    if macos:
        result["macosHeard"] = {name: values["heard"] for name, values in macos["wake"].items()}
        result["macosNear"] = {name: values["accepted"] for name, values in macos["near"].items()}
        result["macosHeardMean"] = round(sum(result["macosHeard"].values()) / len(result["macosHeard"]), 4)
        result["macosNearMean"] = round(sum(result["macosNear"].values()) / len(result["macosNear"]), 4)
        result["macosByForm"] = macos.get("cleanByForm")
    if bench:
        summary = bench["summary"]
        result["phaseBench"] = {"wakeHeard": summary["wakePhrases"]["phases1"]["over"],
                                "nearAccepted": summary["nearPhrases"]["phases1"]["over"],
                                "cafeTalkMinutes": summary["cafeTalk"]["minutes"],
                                "cafeTalkFalseWakes": summary["cafeTalk"]["falseWakes"]["phases1"]}
    return result


def main() -> None:
    key = sys.argv[1] if len(sys.argv) > 1 else "sous-chef"
    old, new = measure("satyr"), measure(key)
    checks = {
        "falseWakes": new["falseWakesTotal"] <= old["falseWakesTotal"],
        "recallEachCondition": all(new["recall"][c] >= old["recall"][c] - RECALL_MARGIN for c in old["recall"]),
        "recallMean": new["recallMean"] >= old["recallMean"],
    }
    if "macosHeardMean" in old and "macosHeardMean" in new:
        checks["otherEngineHeard"] = new["macosHeardMean"] >= old["macosHeardMean"] - ENGINE_MARGIN
        checks["otherEngineNear"] = new["macosNearMean"] <= old["macosNearMean"] + ENGINE_MARGIN
    else:
        checks["otherEngineMeasured"] = False
    result = {"threshold": float(THRESHOLD), "passes": all(checks.values()), "checks": checks, "satyr": old, key: new}
    path = ROOT / "output/shop-voice" / f"wake-phrase-compare-{PHRASES[key].slug}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=1) + "\n")

    print(f"{'':28} {'Hey Satyr':>10} {new['phrase']:>14}")
    print(f"{'false wakes, all sets':28} {old['falseWakesTotal']:>10} {new['falseWakesTotal']:>14}")
    for name in old["falseWakes"]:
        print(f"  {name:26} {old['falseWakes'][name]:>10} {new['falseWakes'][name]:>14}   ({old['falseWakeHours'][name]} h)")
    print(f"{'false wakes / 8 h held out':28} {old['falseWakesPer8hHeldOut']:>10} {new['falseWakesPer8hHeldOut']:>14}")
    for name in old["recall"]:
        print(f"{'heard ' + name:28} {old['recall'][name] * 100:>9.1f}% {new['recall'][name] * 100:>13.1f}%")
    print(f"{'heard, mean':28} {old['recallMean'] * 100:>9.1f}% {new['recallMean'] * 100:>13.1f}%")
    print(f"{'near test accepted':28} {old['nearTest']['rate'] * 100:>9.1f}% {new['nearTest']['rate'] * 100:>13.1f}%   (other phrases)")
    if "macosHeardMean" in old and "macosHeardMean" in new:
        print(f"{'macOS voices heard, mean':28} {old['macosHeardMean'] * 100:>9.1f}% {new['macosHeardMean'] * 100:>13.1f}%")
        print(f"{'macOS near accepted, mean':28} {old['macosNearMean'] * 100:>9.1f}% {new['macosNearMean'] * 100:>13.1f}%")
    if "phaseBench" in old and "phaseBench" in new:
        for field in ("wakeHeard", "nearAccepted", "cafeTalkFalseWakes"):
            print(f"{'phase bench ' + field:28} {old['phaseBench'][field]!s:>10} {new['phaseBench'][field]!s:>14}")
    print("checks:", json.dumps(checks))
    print("PASSES" if result["passes"] else "DOES NOT PASS", "->", path.relative_to(ROOT))


if __name__ == "__main__":
    main()
