"""Plan 82 G0.4: train the "Hey Satyr" classifier on the embeddings from wake.py and measure it.

The classifier has the openWakeWord shape: 16 frames of 96 values, then small dense layers.
Training runs in rounds. After each round, the training speech that tricks the model joins the
near phrases. False wakes count one event for each run of frames above the threshold, with a
2 s lock. LibriSpeech test-clean tunes the threshold. The held-out train-clean-100 speakers only
report it.

Usage: train.py --data <folder>
"""
import argparse
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn

FRAMES = 16
FRAMES_PER_HOUR = 12.5 * 3600
LOCK_FRAMES = 25
THRESHOLDS = [round(float(t), 4) for t in (0.3, 0.5, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99, 0.995, 0.998, 0.999, 0.9995)]


class Wake(nn.Module):
    def __init__(self, width: int) -> None:
        super().__init__()
        self.net = nn.Sequential(nn.Flatten(), nn.Linear(FRAMES * 96, width), nn.LayerNorm(width), nn.ReLU(), nn.Dropout(0.1),
                                 nn.Linear(width, width), nn.LayerNorm(width), nn.ReLU(), nn.Dropout(0.1), nn.Linear(width, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


def load_sequences(paths: list[Path]) -> tuple[np.ndarray, np.ndarray]:
    """Frames end to end, and each window start that stays inside one sequence."""
    frames, starts, base = [], [], 0
    for path in paths:
        data = np.load(path)
        offset = 0
        for length in data["lengths"]:
            if length >= FRAMES:
                starts.append(np.arange(base + offset, base + offset + length - FRAMES + 1))
            offset += int(length)
        frames.append(data["frames"])
        base += offset
    return np.concatenate(frames), np.concatenate(starts)


def windows(frames: np.ndarray, starts: np.ndarray) -> np.ndarray:
    index = starts[:, None] + np.arange(FRAMES)
    return frames[index].astype(np.float32)


@torch.no_grad()
def scores(model: Wake, x: np.ndarray, batch: int = 8192) -> np.ndarray:
    out = [torch.sigmoid(model(torch.from_numpy(x[i:i + batch]))).numpy() for i in range(0, len(x), batch)]
    return np.concatenate(out) if out else np.zeros(0)


@torch.no_grad()
def scan_clips(model: Wake, clips: np.ndarray) -> np.ndarray:
    """The best score in each clip, across all windows, as a live scan sees it."""
    count = clips.shape[1] - FRAMES + 1
    x = np.stack([clips[:, i:i + FRAMES] for i in range(count)], axis=1).astype(np.float32)
    return scores(model, x.reshape(-1, FRAMES, 96)).reshape(-1, count).max(axis=1)


def false_wakes(model: Wake, path: Path) -> dict:
    data = np.load(path)
    frames, offset, events = data["frames"], 0, {t: 0 for t in THRESHOLDS}
    frame_scores = []
    for length in data["lengths"]:
        length = int(length)
        if length >= FRAMES:
            part = frames[offset:offset + length]
            frame_scores.append(scores(model, windows(part, np.arange(length - FRAMES + 1))))
        offset += length
    for values in frame_scores:
        for threshold in THRESHOLDS:
            hits = np.flatnonzero(values >= threshold)
            last = -LOCK_FRAMES
            for hit in hits:
                if hit - last >= LOCK_FRAMES:
                    events[threshold] += 1
                    last = hit
    return {"hours": round(float(data["lengths"].sum() / FRAMES_PER_HOUR), 2), "events": {str(k): v for k, v in events.items()}}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path.home() / ".satyr-voice-test/wake")
    parser.add_argument("--width", type=int, default=64)
    parser.add_argument("--rounds", type=int, nargs="+", default=[15000, 10000, 10000, 15000])
    parser.add_argument("--near-weight", type=float, default=8)
    parser.add_argument("--speech-weight", type=float, default=40)
    args = parser.parse_args()
    features = args.data / "features"
    torch.manual_seed(82)
    torch.set_num_threads(6)
    rng = np.random.default_rng(82)

    wake = np.concatenate([np.load(path).astype(np.float32) for path in sorted(features.glob("train-wake*.npy"))])
    near = np.concatenate([np.load(features / name).astype(np.float32) for name in ("train-near.npy", "train-near2.npy", "train-near3.npy")])
    speech, speech_starts = load_sequences([features / "train-train-clean-100.npz", features / "train-speech.npz", features / "train-noise.npz"])
    print(f"wake {len(wake)}, near {len(near)}, speech hours {len(speech) / FRAMES_PER_HOUR:.1f}", flush=True)

    model = Wake(args.width)
    mined = np.zeros((0, FRAMES, 96), dtype=np.float32)
    total_steps = sum(args.rounds)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-3)
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, 2e-3, total_steps=total_steps)
    done = 0
    y = torch.cat([torch.ones(256), torch.zeros(512 + 1024)])
    for round_steps in args.rounds:
        for _ in range(round_steps):
            speech_x = windows(speech, speech_starts[rng.integers(0, len(speech_starts), 1024)])
            if len(mined):
                speech_x[:384] = mined[rng.integers(0, len(mined), 384)]
            x = np.concatenate([wake[rng.integers(0, len(wake), 256)], near[rng.integers(0, len(near), 512)], speech_x])
            ramp = min(1.0, done / (total_steps * 0.5))
            w = torch.cat([torch.ones(256), torch.full((512,), 1 + (args.near_weight - 1) * ramp), torch.full((1024,), 1 + (args.speech_weight - 1) * ramp)])
            loss = nn.functional.binary_cross_entropy_with_logits(model(torch.from_numpy(x)), y, weight=w)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            schedule.step()
            done += 1
        # The speech that tricks this round's model is the hardest input for the next round.
        model.eval()
        values = scores(model, windows(speech, speech_starts[::2]), batch=32768)
        hard = speech_starts[::2][values >= 0.05]
        if len(hard) > 60000:
            hard = rng.choice(hard, 60000, replace=False)
        if len(hard):
            mined = np.concatenate([mined, windows(speech, hard)])[-120000:]
        model.train()
        print(f"step {done} loss {loss.item():.4f} tricked {len(hard)} mined {len(mined)}", flush=True)

    model.eval()
    torch.save(model.state_dict(), args.data / "hey-satyr.pt")
    clips = np.load(features / "test-clips.npz")
    report = {"thresholds": THRESHOLDS, "wake": {}, "falseWakes": {}, "near": {}, "parameters": sum(p.numel() for p in model.parameters())}
    for name in clips.files:
        if name.startswith("wake-"):
            best = scan_clips(model, clips[name])
            report["wake"][name[5:]] = {str(t): round(float((best >= t).mean()), 4) for t in THRESHOLDS}
    best = scan_clips(model, clips["near"])
    labels = clips["near-labels"]
    for threshold in THRESHOLDS:
        hits = labels[best >= threshold]
        words, counts = np.unique(hits, return_counts=True)
        share = {str(w): int(c) for w, c in sorted(zip(words, counts), key=lambda r: -r[1])[:6]}
        report["near"][str(threshold)] = {"rate": round(float((best >= threshold).mean()), 4), "top": share}
    for path in sorted(features.glob("test-*.npz")):
        if path.name != "test-clips.npz":
            report["falseWakes"][path.stem] = false_wakes(model, path)
    (args.data / "report.json").write_text(json.dumps(report, indent=1))

    def rate(names: list[str], threshold: float) -> tuple[float, int, float]:
        hours = sum(report["falseWakes"][n]["hours"] for n in names)
        events = sum(report["falseWakes"][n]["events"][str(threshold)] for n in names)
        return events / hours * 8, events, hours

    tune = ["test-speech-clean", "test-speech-noisy"]
    final = ["test-train-clean-100-clean", "test-train-clean-100-noisy"]
    print("thr    tune/8h final/8h ev/hours  " + " ".join(f"{k[:11]:>11}" for k in report["wake"]) + "   near")
    for t in THRESHOLDS:
        row = " ".join(f"{report['wake'][k][str(t)] * 100:10.1f}%" for k in report["wake"])
        final_rate = rate(final, t)
        print(f"{t:<6} {rate(tune, t)[0]:7.2f} {final_rate[0]:8.2f} {final_rate[1]:3d}/{final_rate[2]:.1f}  {row}  {report['near'][str(t)]['rate'] * 100:5.1f}%")


if __name__ == "__main__":
    main()
