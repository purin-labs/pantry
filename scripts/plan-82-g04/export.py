"""Plan 82 G0.4: write the classifier as ONNX, then measure it on voices from another engine.

The model never trained on macOS voices. So this test shows how far the Piper voices carry.

Usage:
  <bench venv>/bin/python export.py weights
  <wake venv>/bin/python export.py onnx
  <wake venv>/bin/python export.py voices
  <wake venv>/bin/python export.py stream
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

DATA = Path.home() / ".satyr-voice-test/wake"
THRESHOLD = 0.995
WAKE = ("hey sayter", "hey, sayter", "hey satyr", "hey, satyr")
NEAR = ("hey sailor", "hey setter", "hey data", "hey waiter", "hey later", "say to her", "see you later",
        "put the second tray in the oven", "hey can you pass the scraper", "the butter needs ten more minutes")
RATES = (160, 190, 220)
VOICES = ("Samantha", "Daniel", "Karen", "Moira", "Rishi", "Tessa", "Eddy (English (US))", "Flo (English (UK))", "Reed (English (US))", "Shelley (English (UK))")
CONDITIONS = (("clean", None, None), ("mixer10", "DWASHING", 10.0), ("mixer5", "DWASHING", 5.0), ("mixer0", "DWASHING", 0.0),
              ("kitchen5", "DKITCHEN", 5.0), ("cafe5", "PCAFETER", 5.0))


def weights() -> None:
    import torch
    state = torch.load(DATA / "hey-satyr.pt", weights_only=True)
    np.savez(DATA / "hey-satyr-weights.npz", **{k: v.numpy() for k, v in state.items()})
    sys.path.insert(0, str(Path(__file__).parent))
    from train import Wake
    model = Wake(64)
    model.load_state_dict(state)
    model.eval()
    x = np.load(DATA / "features/test-clips.npz")["wake-clean-1m"][:64, :16].astype(np.float32)
    with torch.no_grad():
        np.savez(DATA / "hey-satyr-check.npz", x=x, y=torch.sigmoid(model(torch.from_numpy(x))).numpy())


def build() -> None:
    import onnx
    from onnx import TensorProto, helper, numpy_helper
    w = np.load(DATA / "hey-satyr-weights.npz")
    init = []
    nodes = [helper.make_node("Flatten", ["input"], ["x0"], axis=1)]

    def dense(index: int, source: str, target: str) -> None:
        kernel, bias = f"k{index}", f"b{index}"
        init.append(numpy_helper.from_array(w[f"net.{index}.weight"], kernel))
        init.append(numpy_helper.from_array(w[f"net.{index}.bias"], bias))
        nodes.append(helper.make_node("Gemm", [source, kernel, bias], [target], transB=1))

    def norm(index: int, source: str, target: str) -> None:
        scale, bias = f"s{index}", f"n{index}"
        init.append(numpy_helper.from_array(w[f"net.{index}.weight"], scale))
        init.append(numpy_helper.from_array(w[f"net.{index}.bias"], bias))
        nodes.append(helper.make_node("LayerNormalization", [source, scale, bias], [target], axis=-1, epsilon=1e-5))

    dense(1, "x0", "x1")
    norm(2, "x1", "x2")
    nodes.append(helper.make_node("Relu", ["x2"], ["x3"]))
    dense(5, "x3", "x4")
    norm(6, "x4", "x5")
    nodes.append(helper.make_node("Relu", ["x5"], ["x6"]))
    dense(9, "x6", "x7")
    nodes.append(helper.make_node("Sigmoid", ["x7"], ["score"]))
    graph = helper.make_graph(nodes, "hey_satyr", [helper.make_tensor_value_info("input", TensorProto.FLOAT, [None, 16, 96])],
                              [helper.make_tensor_value_info("score", TensorProto.FLOAT, [None, 1])], init)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, DATA / "models/hey_satyr.onnx")

    import onnxruntime as ort
    check = np.load(DATA / "hey-satyr-check.npz")
    session = ort.InferenceSession(str(DATA / "models/hey_satyr.onnx"), providers=["CPUExecutionProvider"])
    got = session.run(None, {"input": check["x"]})[0].squeeze(-1)
    print(f"bytes {(DATA / 'models/hey_satyr.onnx').stat().st_size}, largest difference from torch {np.abs(got - check['y']).max():.2e}")


def voices() -> None:
    import onnxruntime as ort
    from math import gcd

    import soundfile as sf
    from scipy.signal import fftconvolve, resample_poly
    sys.path.insert(0, str(Path(__file__).parent))
    import wake as w

    names = list(VOICES)
    session = ort.InferenceSession(str(DATA / "models/hey_satyr.onnx"), providers=["CPUExecutionProvider"])
    features = w.Features(DATA / "models")
    noise = np.load(DATA / "noise-test.npz")
    rng = np.random.default_rng(85)

    def speak(voice: str, text: str, rate: int) -> np.ndarray:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "a.wav"
            subprocess.run(["say", "-v", voice, "-r", str(rate), "-o", str(path), "--data-format=LEI16@16000", text], check=True)
            audio, sample_rate = sf.read(path, dtype="float64")
        assert sample_rate == w.RATE
        index = np.flatnonzero(np.abs(audio) > np.abs(audio).max() * 0.02)
        return audio[index[0]:index[-1] + 1]

    def best(speech: np.ndarray, noise_key: str | None, snr_db: float | None) -> float:
        speech = fftconvolve(w.level(speech, -26), w.room(rng, 1.0))
        clip = np.zeros(w.RATE * 4)
        start = int(rng.uniform(1.0, 1.6) * w.RATE)
        speech = speech[:len(clip) - start]
        clip[start:start + len(speech)] = speech
        if noise_key:
            clip = w.add_noise(clip, noise[noise_key], snr_db, rng)
        frames = features(clip).astype(np.float32)
        x = np.stack([frames[i:i + 16] for i in range(len(frames) - 15)])
        return float(session.run(None, {"input": x})[0].max())

    results = {"voices": names, "threshold": THRESHOLD, "wake": {}, "near": {}}
    wake_audio = [(v, speak(v, t, r)) for v in names for t in WAKE for r in RATES]
    near_audio = [speak(v, t, r) for v in names for t in NEAR for r in RATES]
    for label, key, snr in CONDITIONS:
        scores = np.array([best(a, key, snr) for _, a in wake_audio])
        results["wake"][label] = {"clips": len(scores), "heard": round(float((scores >= THRESHOLD).mean()), 4),
                                  "heardAt0.9": round(float((scores >= 0.9).mean()), 4)}
        scores = np.array([best(a, key, snr) for a in near_audio])
        results["near"][label] = {"clips": len(scores), "accepted": round(float((scores >= THRESHOLD).mean()), 4)}
        print(label, results["wake"][label], results["near"][label], flush=True)
    forms = {}
    for index, form in enumerate(WAKE):
        picked = [a for i, (_, a) in enumerate(wake_audio) if (i // len(RATES)) % len(WAKE) == index]
        forms[form] = round(float(np.mean([best(a, None, None) >= THRESHOLD for a in picked])), 3)
    results["cleanByForm"] = forms
    print(forms)
    per_voice = {v: round(float(np.mean([best(a, "DWASHING", 5.0) >= THRESHOLD for n, a in wake_audio if n == v])), 3) for v in names}
    results["mixer5ByVoice"] = per_voice
    print(len(names), per_voice)
    (DATA / "report-macos-voices.json").write_text(json.dumps(results, indent=1))


def stream() -> None:
    """Write 45 s of mixer noise with known phrases, and print the events that the batch path finds."""
    import onnxruntime as ort
    import soundfile as sf
    from scipy.signal import fftconvolve
    sys.path.insert(0, str(Path(__file__).parent))
    import wake as w

    rng = np.random.default_rng(7)
    noise = np.load(DATA / "noise-test.npz")["DWASHING"]
    clip = np.zeros(w.RATE * 45)
    for at, voice, text in ((8, "Tessa", "hey, sayter"), (16, "Daniel", "put the second tray in the oven"), (24, "Reed (English (US))", "hey, satyr"),
                            (32, "Karen", "see you later"), (38, "Eddy (English (US))", "hey sayter")):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "a.wav"
            subprocess.run(["say", "-v", voice, "-o", str(path), "--data-format=LEI16@16000", text], check=True, timeout=60)
            audio, _ = sf.read(path, dtype="float64")
        speech = fftconvolve(w.level(audio, -26), w.room(rng, 1.0))
        clip[at * w.RATE:at * w.RATE + len(speech)] = speech
    clip = w.add_noise(clip, noise, 5.0, rng)
    (DATA / "stream.pcm").write_bytes((np.clip(clip, -1, 1) * 32767).astype(np.int16).tobytes())
    session = ort.InferenceSession(str(DATA / "models/hey_satyr.onnx"), providers=["CPUExecutionProvider"])
    frames = w.Features(DATA / "models")(clip).astype(np.float32)
    x = np.stack([frames[i:i + 16] for i in range(len(frames) - 15)])
    scores = session.run(None, {"input": x})[0].squeeze(-1)
    events, last = [], -25
    for index in np.flatnonzero(scores >= THRESHOLD):
        if index - last >= 25:
            events.append(round((index + 15) * 0.08 + 0.76, 2))
            last = index
    print(json.dumps({"batchEventsAtS": events, "bestScore": float(scores.max())}))


if __name__ == "__main__":
    {"weights": weights, "onnx": build, "voices": voices, "stream": stream}[sys.argv[1]]()
