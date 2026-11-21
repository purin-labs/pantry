"""Plan 82 G0.4: build the training data for a "Hey Satyr" wake phrase and measure it.

Audio becomes openWakeWord embeddings: 12.5 frames each second and 96 values in each frame.
The script keeps only embeddings, so the disk holds little. Speakers 0-799 and the first 70%
of each noise train the model. Speakers 800-903 and the last 30% of each noise only measure it.

Inputs and licences:
  speech voices   Piper en_US-libritts_r-medium, CC BY 4.0
  general speech  LibriSpeech train-clean-100, dev-clean and test-clean, CC BY 4.0. It is read
                  from the network and not kept. 30% of the train-clean-100 speakers only measure.
  noise           DEMAND DKITCHEN, PCAFETER, DWASHING, CC BY 4.0
  second voices   Kokoro v1.0 weights and voices, Apache-2.0
  feature models  openWakeWord melspectrogram and embedding_model, Apache-2.0

Usage:
  wake.py prepare --data <folder> --demand <folder with the DEMAND zips>
  wake.py more --demand <same folder> --wake 7000 --near 30000
  wake.py kokoro --demand <same folder> --wake 10000 --near 16000
"""
import argparse
import concurrent.futures as futures
import io
import os
import tarfile
import urllib.request
import zipfile
from math import gcd
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np
import onnxruntime as ort
import soundfile as sf
from scipy.signal import fftconvolve, resample_poly

RATE = 16000
WINDOW = RATE * 2  # Two seconds of audio give 16 embedding frames.
TRAIN_SPEAKERS = range(800)
TEST_SPEAKERS = range(800, 904)
NOISES = ("DKITCHEN", "PCAFETER", "DWASHING")
LIBRISPEECH = "https://www.openslr.org/resources/12/{}.tar.gz"
MIN_FREE_BYTES = 1_500_000_000

# Satyr has two usual English forms, with the vowel of "say" and of "sat". Both wake the Portal.
WAKE_FORMS = (
    "hey sayter", "hey, sayter", "[[ heɪ sˈeɪtə ]]", "[[ heɪ sˈeɪɾɚ ]]",
    "hey pantry", "hey, pantry", "[[ heɪ sˈætə ]]",
)
NEAR_TRAIN = (
    "hey sailor", "hey sister", "hey there", "hey waiter", "hey later", "hey peter", "hey sadie",
    "hey hater", "hey cater", "hey sara", "hey slater", "hey sweater", "hey saturday", "hey sugar",
    "hey siri", "hey summer", "hey sir", "say to her", "say that", "satire", "pantry", "sayter", "hey",
    "hey doctor", "hey water", "stay there", "safer", "greater", "hey sam", "a pantry came",
    "see you later", "pass the butter", "hey set a timer", "they sat here", "the baker", "hey taylor",
)
NEAR_TEST = (
    "hey sayer", "hey seder", "hey cedar", "hey setter", "hey saver", "hey sitter", "hey sader",
    "hey data", "hey dater", "hey spatter", "hey shatter", "hey matter", "say her", "hey skater",
    "hey straighter", "hey it's later", "hey, sit there", "hey said her", "sat here", "they say to her",
)
BAKERY_TALK = (
    "put the second tray in the oven", "the butter needs ten more minutes", "two flat whites for table six",
    "can you check the proofing cabinet", "we are out of almond flour", "hey can you pass the scraper",
    "the financiers are ready to box", "order forty seven is ready for pickup", "hey, watch out, hot tray behind you",
    "start the mixer at speed two", "the delivery came early today", "take the croissants off the rack",
    "thank you, see you next time", "would you like a bag for that", "hey, do we have more pistachio paste",
)


# Every near phrase in the form "hey" + onset + vowel + middle + end. The forms of the wake phrase
# are left out, and so are the forms of NEAR_TEST, so that the measure stays on unseen phrases.
ONSETS = ("s", "ʃ", "z", "θ", "t", "d", "k", "ɡ", "p", "b", "f", "v", "m", "n", "l", "ɹ", "w", "j", "h", "st", "sp", "sk", "sl", "sw", "sn", "sm")
VOWELS = ("eɪ", "æ", "ɛ", "ɪ", "iː", "ʌ", "ɑː", "ɔː", "oʊ", "aɪ", "aʊ", "uː")
MIDDLES = ("t", "ɾ", "d", "l", "n", "m", "v", "s", "z", "k", "p", "b", "ð")
ENDS = ("ɚ", "ə", "iː", "oʊ", "ɪŋ", "ən")
LEADS = ("deɪ", "seɪ", "eɪ", "ðə", "ə", "meɪ", "weɪ", "pleɪ", "stɑːp", "oʊ", "wɛl")
WAKE_ONSET_VOWELS = {("s", "eɪ"), ("s", "æ")}
HELD_OUT = {("s", "eɪ", "d"), ("s", "iː", "d"), ("s", "ɛ", "ɾ"), ("s", "ɛ", "t"), ("s", "eɪ", "v"), ("s", "ɪ", "ɾ"), ("s", "ɪ", "t"),
            ("d", "eɪ", "ɾ"), ("d", "eɪ", "t"), ("d", "æ", "ɾ"), ("d", "æ", "t"), ("sp", "æ", "ɾ"), ("sp", "æ", "t"), ("ʃ", "æ", "ɾ"),
            ("ʃ", "æ", "t"), ("m", "æ", "ɾ"), ("m", "æ", "t"), ("sk", "eɪ", "ɾ"), ("sk", "eɪ", "t")}


def near_phonemes(rng: np.random.Generator, count: int) -> list[str]:
    out = []
    while len(out) < count:
        onset, vowel, middle, end = (str(rng.choice(part)) for part in (ONSETS, VOWELS, MIDDLES, ENDS))
        if (onset, vowel, middle) in HELD_OUT or ((onset, vowel) in WAKE_ONSET_VOWELS and middle in "tɾ" and end in ("ɚ", "ə")):
            continue
        if rng.random() < 0.1:
            # The name with another word before it must not wake the Portal.
            out.append(f"[[ {rng.choice(LEADS)} sˈeɪɾɚ ]]" if rng.random() < 0.5 else f"[[ {rng.choice(LEADS)} sˈætə ]]")
        else:
            out.append(f"[[ heɪ {onset}ˈ{vowel}{middle}{end} ]]")
    return out


def free_bytes(path: Path) -> int:
    stat = os.statvfs(path)
    return stat.f_bavail * stat.f_frsize


class Features:
    def __init__(self, models: Path) -> None:
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        self.mel = ort.InferenceSession(str(models / "melspectrogram.onnx"), options, providers=["CPUExecutionProvider"])
        self.embed = ort.InferenceSession(str(models / "embedding_model.onnx"), options, providers=["CPUExecutionProvider"])
        self.mel_name = self.mel.get_inputs()[0].name
        self.embed_name = self.embed.get_inputs()[0].name

    def __call__(self, samples: np.ndarray) -> np.ndarray:
        """Float audio in [-1, 1] to embedding frames of shape (T, 96)."""
        pcm = np.clip(samples, -1, 1) * 32767
        mel = np.squeeze(self.mel.run(None, {self.mel_name: pcm[None].astype(np.float32)})[0]) / 10 + 2
        frames = []
        for start in range(0, mel.shape[0] - 75, 8):
            frames.append(mel[start:start + 76])
        output = []
        for start in range(0, len(frames), 256):
            batch = np.array(frames[start:start + 256], dtype=np.float32)[..., None]
            output.append(np.squeeze(self.embed.run(None, {self.embed_name: batch})[0], axis=(1, 2)))
        return np.concatenate(output)


def room(rng: np.random.Generator, distance_m: float) -> np.ndarray:
    """A plain room echo: one direct path and a decay of random reflections."""
    rt60 = rng.uniform(0.25, 0.6)
    length = int(rt60 * RATE)
    tail = rng.standard_normal(length) * np.exp(-6.9 * np.arange(length) / length)
    response = tail * 0.1 * max(distance_m, 0.3) ** 0.8 / np.sqrt(np.sum(tail**2) / RATE * 0.01 + 1e-9) / 100
    response[0] = 1.0
    return response / max(distance_m, 0.3)


def active_rms(samples: np.ndarray) -> float:
    frames = samples[: len(samples) // 160 * 160].reshape(-1, 160)
    energy = np.sqrt(np.mean(frames**2, axis=1) + 1e-12)
    loud = energy[energy > energy.max() * 0.1]
    return float(np.sqrt(np.mean(loud**2)))


def add_noise(speech: np.ndarray, noise: np.ndarray, snr_db: float, rng: np.random.Generator) -> np.ndarray:
    start = rng.integers(0, len(noise) - len(speech) - 1)
    part = noise[start:start + len(speech)]
    gain = active_rms(speech) / (np.sqrt(np.mean(part**2)) + 1e-9) / 10 ** (snr_db / 20)
    return speech + part * gain


def level(samples: np.ndarray, dbfs: float) -> np.ndarray:
    return samples * (10 ** (dbfs / 20) / (active_rms(samples) + 1e-9))


def place_at_end(speech: np.ndarray, rng: np.random.Generator, total: int = WINDOW) -> np.ndarray:
    """Put the speech so that it ends near the end of the window, as a live model sees it."""
    room_after = int(rng.uniform(0.02, 0.24) * RATE)
    speech = speech[-(total - room_after):]
    out = np.zeros(total, dtype=np.float32)
    start = total - room_after - len(speech)
    out[start:start + len(speech)] = speech
    return out


# Worker state. Each process holds one voice and one feature model.
_voice = None
_features = None
_noises = None


def _init_worker(data: str, models: str, split: str) -> None:
    global _voice, _features, _noises
    from piper import PiperVoice
    _voice = PiperVoice.load(str(Path(data) / "voice" / "lr.onnx"))
    # Piper's session uses every core. The pool already gives one core to each worker.
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    _voice.session = ort.InferenceSession(str(Path(data) / "voice" / "lr.onnx"), options, providers=["CPUExecutionProvider"])
    _features = Features(Path(models))
    _noises = dict(np.load(Path(data) / f"noise-{split}.npz"))


def _speak(text: str, rng: np.random.Generator, speakers: range) -> np.ndarray:
    from piper import SynthesisConfig
    config = SynthesisConfig(speaker_id=int(rng.choice(speakers)), length_scale=float(rng.uniform(0.8, 1.25)),
                             noise_scale=float(rng.uniform(0.4, 0.9)), noise_w_scale=float(rng.uniform(0.5, 1.0)))
    chunks = list(_voice.synthesize(text, syn_config=config))
    audio = np.concatenate([c.audio_float_array for c in chunks]).astype(np.float64)
    rate = chunks[0].sample_rate
    divisor = gcd(rate, RATE)
    audio = resample_poly(audio, RATE // divisor, rate // divisor)
    index = np.flatnonzero(np.abs(audio) > np.abs(audio).max() * 0.02)
    return audio[index[0]:index[-1] + 1]


def _train_clip(task: tuple[str, int, bool]) -> np.ndarray:
    text, seed, noisy = task
    rng = np.random.default_rng(seed)
    speech = level(_speak(text, rng, TRAIN_SPEAKERS), rng.uniform(-35, -18))
    if rng.random() < 0.7:
        speech = fftconvolve(speech, room(rng, rng.uniform(0.3, 3.0)))
    window = place_at_end(speech, rng)
    if noisy and rng.random() < 0.8:
        key = rng.choice(list(_noises))
        window = add_noise(window, _noises[key], rng.uniform(-3, 25), rng)
    return _features(window)[-16:].astype(np.float16)


def _test_clip(task: tuple[str, int, str, float | None, float]) -> np.ndarray:
    """A three-second clip at a distance, for a sliding scan. Speakers and noise are held out."""
    text, seed, noise_key, snr_db, distance = task
    rng = np.random.default_rng(seed)
    speech = level(_speak(text, rng, TEST_SPEAKERS), -26)
    speech = fftconvolve(speech, room(rng, distance))
    clip = np.zeros(RATE * 3, dtype=np.float64)
    start = int(rng.uniform(1.0, 1.6) * RATE)
    speech = speech[: len(clip) - start]
    clip[start:start + len(speech)] = speech
    if noise_key:
        clip = add_noise(clip, _noises[noise_key], snr_db, rng)
    return _features(clip).astype(np.float16)


def load_noises(demand: Path, data: Path) -> None:
    train, test = {}, {}
    for key in NOISES:
        with zipfile.ZipFile(demand / f"{key}_16k.zip") as archive:
            name = next(n for n in archive.namelist() if n.endswith("ch01.wav"))
            with archive.open(name) as handle:
                samples, rate = sf.read(handle, dtype="float32")
        assert rate == RATE
        cut = int(len(samples) * 0.7)
        train[key], test[key] = samples[:cut], samples[cut:]
    np.savez(data / "noise-train.npz", **train)
    np.savez(data / "noise-test.npz", **test)


def _speech_chunk(task: tuple[str | bytes, str | None, float, int]) -> np.ndarray:
    source, noise_key, snr_db, seed = task
    samples, rate = sf.read(io.BytesIO(source) if isinstance(source, bytes) else source, dtype="float64")
    assert rate == RATE
    rng = np.random.default_rng(seed)
    samples = level(samples, rng.uniform(-36, -20))
    if len(samples) < WINDOW:
        samples = np.pad(samples, (0, WINDOW - len(samples)))
    if noise_key:
        samples = add_noise(samples, _noises[noise_key], snr_db, rng)
    return _features(samples).astype(np.float16)


def librispeech(name: str, data: Path) -> list[str]:
    folder = data / "speech" / name
    if not folder.exists():
        folder.mkdir(parents=True)
        archive = data / f"{name}.tar.gz"
        urllib.request.urlretrieve(LIBRISPEECH.format(name), archive)
        with tarfile.open(archive) as tar:
            for member in tar:
                if member.name.endswith(".flac"):
                    member.name = os.path.basename(member.name)
                    tar.extract(member, folder, filter="data")
        archive.unlink()
    return sorted(str(p) for p in folder.glob("*.flac"))


def stream_speech(name: str, data: Path, models: Path, workers: int, out: Path) -> None:
    """Read one LibriSpeech archive from the network. Keep only embeddings, split by speaker."""
    rng = np.random.default_rng(83)
    keys = list(NOISES)
    train, clean, noisy = [], [], []
    init = lambda split: dict(initializer=_init_worker, initargs=(str(data), str(models), split))
    with futures.ProcessPoolExecutor(workers // 2, **init("train")) as train_pool, \
            futures.ProcessPoolExecutor(workers // 2, **init("test")) as test_pool:
        request = urllib.request.urlopen(LIBRISPEECH.format(name), timeout=120)
        train_batch, test_batch = [], []

        def flush(final: bool = False) -> None:
            nonlocal train_batch, test_batch
            if train_batch and (final or len(train_batch) >= 256):
                train.extend(train_pool.map(_speech_chunk, train_batch, chunksize=8))
                train_batch = []
            if test_batch and (final or len(test_batch) >= 256):
                results = list(test_pool.map(_speech_chunk, test_batch, chunksize=8))
                clean.extend(r for r, t in zip(results, test_batch) if t[1] is None)
                noisy.extend(r for r, t in zip(results, test_batch) if t[1] is not None)
                test_batch = []
            if free_bytes(data) < MIN_FREE_BYTES:
                raise SystemExit("The disk is too full. Stop the speech stream.")

        count = 0
        with tarfile.open(fileobj=request, mode="r|gz") as tar:
            for member in tar:
                if not member.name.endswith(".flac"):
                    continue
                speaker = int(os.path.basename(member.name).split("-")[0])
                audio = tar.extractfile(member).read()
                task = (audio, keys[count % 3] if count % 2 else None, float(rng.uniform(0, 20)), int(rng.integers(0, 2**31)))
                (test_batch if speaker % 10 < 3 else train_batch).append(task)
                count += 1
                flush()
                if count % 2000 == 0:
                    print(f"stream {name}: {count} files, disk free {free_bytes(data) / 1e9:.1f} GB", flush=True)
        flush(final=True)
    save_sequences(out / f"train-{name}.npz", train)
    save_sequences(out / f"test-{name}-clean.npz", clean)
    save_sequences(out / f"test-{name}-noisy.npz", noisy)
    print(f"stream {name} done: {len(train)} train, {len(clean)} clean, {len(noisy)} noisy", flush=True)


def save_sequences(path: Path, sequences: list[np.ndarray]) -> None:
    """All sequences end to end, with the offsets. A window must not cross one offset."""
    lengths = np.array([len(s) for s in sequences])
    np.savez(path, frames=np.concatenate(sequences), lengths=lengths)


_kokoro = None
_kokoro_names = None


def _init_kokoro(data: str, models: str) -> None:
    global _kokoro, _kokoro_names, _features, _noises
    from kokoro_onnx import Kokoro
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(Path(data) / "kokoro/k.onnx"), options, providers=["CPUExecutionProvider"])
    _kokoro = Kokoro.from_session(session, str(Path(data) / "kokoro/voices.bin"))
    _kokoro_names = [v for v in _kokoro.get_voices() if v[:2] in ("af", "am", "bf", "bm")]
    _features = Features(Path(models))
    _noises = dict(np.load(Path(data) / "noise-train.npz"))


def _kokoro_clip(task: tuple[str, int] | tuple[str, int, bool]) -> np.ndarray:
    """One clip from a blend of two voices, at a changed pitch. A blend is a new speaker."""
    text, seed, cafe = task if len(task) == 3 else (*task, False)
    rng = np.random.default_rng(seed)
    first, second = rng.choice(_kokoro_names, 2, replace=False)
    mix = rng.uniform(0, 1)
    voice = _kokoro.get_voice_style(str(first)) * mix + _kokoro.get_voice_style(str(second)) * (1 - mix)
    english = "en-gb" if str(first)[0] == "b" else "en-us"
    phonemes = text.startswith("[[")
    spoken = text.strip("[] ") if phonemes else text
    audio, rate = _kokoro.create(spoken, voice=voice, speed=float(rng.uniform(0.8, 1.25)), lang=english, is_phonemes=phonemes)
    audio = np.asarray(audio, dtype=np.float64)
    # Playing the audio faster or slower moves the pitch, and so the apparent speaker.
    target = int(RATE * rng.uniform(0.87, 1.15))
    divisor = gcd(rate, target)
    audio = resample_poly(audio, target // divisor, rate // divisor)
    index = np.flatnonzero(np.abs(audio) > np.abs(audio).max() * 0.02)
    speech = level(audio[index[0]:index[-1] + 1], rng.uniform(-35, -18))
    if rng.random() < 0.7:
        speech = fftconvolve(speech, room(rng, rng.uniform(0.3, 3.0)))
    window = place_at_end(speech, rng)
    if cafe and rng.random() < 0.5:
        window = add_noise(window, _noises["PCAFETER"], rng.uniform(0, 15), rng)
    elif rng.random() < 0.8:
        window = add_noise(window, _noises[rng.choice(list(_noises))], rng.uniform(-3, 25), rng)
    return _features(window)[-16:].astype(np.float16)


def second_engine(args: argparse.Namespace) -> None:
    data, models = args.data, args.models
    out = data / "features"
    rng = np.random.default_rng(86)

    def run(tasks: list, name: str) -> np.ndarray:
        with futures.ProcessPoolExecutor(args.workers, initializer=_init_kokoro, initargs=(str(data), str(models))) as pool:
            result = np.stack(list(pool.map(_kokoro_clip, tasks, chunksize=8)))
        print(f"{name}: {len(result)} items, disk free {free_bytes(data) / 1e9:.1f} GB", flush=True)
        return result

    wake = [(WAKE_FORMS[i % len(WAKE_FORMS)], int(s)) for i, s in enumerate(rng.integers(0, 2**31, args.wake))]
    np.save(out / "train-wake3.npy", run(wake, "kokoro wake"))
    texts = near_phonemes(rng, args.near // 2) + [(NEAR_TRAIN + BAKERY_TALK)[i % 51] for i in range(args.near // 2)]
    near = [(t, int(s)) for t, s in zip(texts, rng.integers(0, 2**31, len(texts)))]
    np.save(out / "train-near3.npy", run(near, "kokoro near"))
    print("kokoro done", flush=True)


def focus(args: argparse.Namespace) -> None:
    """Natural speech has no pause after "hey", and macOS voices were heard 43-50% in that form.
    Half of these clips have café talk, where the model hears the least. train.py finds this file."""
    rng = np.random.default_rng(87)
    forms = [form for form in WAKE_FORMS if "," not in form]
    tasks = [(forms[i % len(forms)], int(s), True) for i, s in enumerate(rng.integers(0, 2**31, args.wake))]
    with futures.ProcessPoolExecutor(args.workers, initializer=_init_kokoro,
                                     initargs=(str(args.data), str(args.models))) as pool:
        result = np.stack(list(pool.map(_kokoro_clip, tasks, chunksize=8)))
    np.save(args.data / "features/train-wake4.npy", result)
    print(f"focus wake: {len(result)} items, disk free {free_bytes(args.data) / 1e9:.1f} GB", flush=True)


def more(args: argparse.Namespace) -> None:
    data, models = args.data, args.models
    out = data / "features"
    rng = np.random.default_rng(84)

    def run(tasks: list, name: str) -> np.ndarray:
        with futures.ProcessPoolExecutor(args.workers, initializer=_init_worker,
                                         initargs=(str(data), str(models), "train")) as pool:
            result = np.stack(list(pool.map(_train_clip, tasks, chunksize=16)))
        print(f"{name}: {len(result)} items, disk free {free_bytes(data) / 1e9:.1f} GB", flush=True)
        return result

    seeds = [int(x) for x in rng.integers(0, 2**31, args.wake + args.near)]
    wake = [(WAKE_FORMS[i % len(WAKE_FORMS)], seeds[i], True) for i in range(args.wake)]
    np.save(out / "train-wake2.npy", run(wake, "more wake"))
    near = [(text, seeds[args.wake + i], True) for i, text in enumerate(near_phonemes(rng, args.near))]
    np.save(out / "train-near2.npy", run(near, "more near"))
    print("more done", flush=True)


def prepare(args: argparse.Namespace) -> None:
    data, models = args.data, args.models
    out = data / "features"
    out.mkdir(parents=True, exist_ok=True)
    load_noises(args.demand, data)
    rng = np.random.default_rng(82)

    def seeds(count: int) -> list[int]:
        return [int(s) for s in rng.integers(0, 2**31, count)]

    def run(split: str, target, tasks: list, name: str) -> list[np.ndarray]:
        if free_bytes(data) < MIN_FREE_BYTES:
            raise SystemExit(f"The disk has less than {MIN_FREE_BYTES} bytes free. Stop at {name}.")
        with futures.ProcessPoolExecutor(args.workers, initializer=_init_worker,
                                         initargs=(str(data), str(models), split)) as pool:
            result = list(pool.map(target, tasks, chunksize=16))
        print(f"{name}: {len(result)} items, disk free {free_bytes(data) / 1e9:.1f} GB", flush=True)
        return result

    # Training: fixed windows of 16 frames.
    wake = [(WAKE_FORMS[i % len(WAKE_FORMS)], s, True) for i, s in enumerate(seeds(args.wake))]
    np.save(out / "train-wake.npy", np.stack(run("train", _train_clip, wake, "train wake")))
    near = [(NEAR_TRAIN[i % len(NEAR_TRAIN)], s, True) for i, s in enumerate(seeds(args.near))]
    near += [(BAKERY_TALK[i % len(BAKERY_TALK)], s, True) for i, s in enumerate(seeds(args.near // 4))]
    np.save(out / "train-near.npy", np.stack(run("train", _train_clip, near, "train near")))

    keys = list(NOISES)
    train_files = librispeech("dev-clean", data)
    tasks = [(p, keys[i % 3] if i % 2 else None, float(rng.uniform(0, 20)), s)
             for i, (p, s) in enumerate(zip(train_files, seeds(len(train_files))))]
    save_sequences(out / "train-speech.npz", run("train", _speech_chunk, tasks, "train speech"))
    train_noise = np.load(data / "noise-train.npz")
    feature = Features(models)
    save_sequences(out / "train-noise.npz", [feature(np.array(train_noise[k], dtype=np.float64) * 0.3).astype(np.float16) for k in NOISES])

    # Measure: held-out speakers and noise, scanned like a live stream.
    tests = {}
    for label, noise_key, snr_db, distance in (("clean-1m", "", None, 1.0), ("mixer10-1m", "DWASHING", 10.0, 1.0),
                                               ("mixer5-1m", "DWASHING", 5.0, 1.0), ("mixer0-1m", "DWASHING", 0.0, 1.0),
                                               ("kitchen5-1m", "DKITCHEN", 5.0, 1.0), ("cafe5-1m", "PCAFETER", 5.0, 1.0),
                                               ("mixer5-2m", "DWASHING", 5.0, 2.0)):
        items = [(WAKE_FORMS[i % len(WAKE_FORMS)], s, noise_key, snr_db, distance) for i, s in enumerate(seeds(args.test))]
        tests[f"wake-{label}"] = np.stack(run("test", _test_clip, items, f"test wake {label}"))
    near_items = [(NEAR_TEST[i % len(NEAR_TEST)], s, "DKITCHEN", 15.0, 1.0) for i, s in enumerate(seeds(args.test * 2))]
    tests["near"] = np.stack(run("test", _test_clip, near_items, "test near"))
    tests["near-labels"] = np.array([NEAR_TEST[i % len(NEAR_TEST)] for i in range(args.test * 2)])
    np.savez(out / "test-clips.npz", **tests)

    stream_speech("train-clean-100", data, models, args.workers, out)

    test_files = librispeech("test-clean", data)
    clean = run("test", _speech_chunk, [(p, None, 0.0, s) for p, s in zip(test_files, seeds(len(test_files)))], "test speech clean")
    save_sequences(out / "test-speech-clean.npz", clean)
    noisy = run("test", _speech_chunk, [(p, keys[i % 3], 10.0, s) for i, (p, s) in enumerate(zip(test_files, seeds(len(test_files))))], "test speech noisy")
    save_sequences(out / "test-speech-noisy.npz", noisy)
    test_noise = np.load(data / "noise-test.npz")
    save_sequences(out / "test-noise.npz", [feature(np.array(test_noise[k], dtype=np.float64) * 0.3).astype(np.float16) for k in NOISES])
    print("prepare done", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "more", "kokoro", "focus"])
    parser.add_argument("--data", type=Path, default=Path.home() / ".pantry-voice-test/wake")
    parser.add_argument("--models", type=Path, default=Path.home() / ".pantry-voice-test/wake/models")
    parser.add_argument("--demand", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--wake", type=int, default=7000)
    parser.add_argument("--near", type=int, default=6000)
    parser.add_argument("--test", type=int, default=400)
    arguments = parser.parse_args()
    {"prepare": prepare, "more": more, "kokoro": second_engine, "focus": focus}[arguments.command](arguments)
