"""Spoken answers: Kokoro with the af_heart voice, on the CPU, from pinned files.

The text of an answer goes to no disk and no log. Phonemes come from misaki with no espeak-ng, so
the service loads no GPL library. A word outside misaki's lexicon gets the letter rules here. A
`ModelHost` runs it, as it runs the speech engine.
"""
import gc
import io
import json
import re
import unicodedata
import wave
from pathlib import Path

from .model_files import FileSet

# Kokoro v1.0 with the af_heart voice (Apache-2.0).
VOICE_FILES = FileSet(
    base_url="https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve",
    revision="1939ad2a8e416c0acfeecc08a694d14ef25f2231",
    files=(
        ("onnx/model_quantized.onnx", 92_361_116, "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478"),
        ("voices/af_heart.bin", 522_240, "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b"),
        ("tokenizer.json", 3_497, "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34"),
    ),
)
SAMPLE_RATE = 24_000
# Kokoro reads at most 510 phonemes at a time.
PHONEME_LIMIT = 400
# One answer that runs and one that waits. The Portal uses the browser's voice after that.
ANSWER_SLOTS = 2
CPU_THREADS = 4
# The Portal stops waiting after 5 s.
QUEUE_WAIT_SECONDS = 5.0

_LETTERS = (("tch", "ʧ"), ("igh", "I"), ("ch", "ʧ"), ("sh", "ʃ"), ("th", "θ"), ("ph", "f"), ("ck", "k"), ("kn", "n"),
            ("gn", "n"), ("qu", "kw"), ("ng", "ŋ"), ("ee", "i"), ("ea", "i"), ("oo", "u"), ("ou", "u"), ("ai", "A"),
            ("ay", "A"), ("ey", "A"), ("oa", "O"), ("a", "æ"), ("b", "b"), ("d", "d"), ("e", "ɛ"), ("f", "f"),
            ("g", "ɡ"), ("h", "h"), ("i", "ɪ"), ("j", "ʤ"), ("k", "k"), ("l", "l"), ("m", "m"), ("n", "n"), ("o", "ɑ"),
            ("p", "p"), ("q", "k"), ("r", "ɹ"), ("s", "s"), ("t", "t"), ("u", "ʌ"), ("v", "v"), ("w", "w"), ("x", "ks"),
            ("y", "i"), ("z", "z"))
_VOWELS = "æɛɪɑʌiuAIO"
_UNITS = (("kg", "kilograms"), ("ml", "millilitres"), ("g", "grams"), ("l", "litres"), ("°C", "degrees"))


def _sounds_of(word: str) -> str:
    """Rough phonemes for a shop word that the lexicon does not hold, such as "kouign"."""
    letters = re.sub(r"([bcdfgklmnprstz])\1", r"\1", word.lower())
    sounds = ""
    at = 0
    while at < len(letters):
        if letters[at] == "c" and letters[at + 1:at + 2] not in ("h", "k"):
            sounds += "s" if letters[at + 1:at + 2] in ("e", "i", "y") else "k"
            at += 1
            continue
        for spelling, sound in _LETTERS:
            if letters.startswith(spelling, at):
                sounds += sound
                at += len(spelling)
                break
        else:
            at += 1
    first_vowel = next((index for index, sound in enumerate(sounds) if sound in _VOWELS), None)
    return sounds if first_vowel is None else f"{sounds[:first_vowel]}ˈ{sounds[first_vowel:]}"


def speakable(text: str) -> str:
    """Accents, clock times, money and units in the words that misaki reads."""
    plain = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    plain = re.sub(r"(\d):(\d\d)", r"\1 \2", plain)
    plain = re.sub(r"¥\s*([\d,]+)", r"\1 yen", plain)
    for unit, name in _UNITS:
        plain = re.sub(rf"(\d)\s*{re.escape(unit)}(?![^\W\d_])", rf"\1 {name}", plain)
    return plain


def split_phonemes(phonemes: str) -> list[str]:
    """Parts that Kokoro can read, cut at the punctuation first, then at a space."""
    parts: list[str] = []
    current = ""
    for piece in re.split(r"(?<=[.!?…,;:])\s+", phonemes):
        while len(piece) > PHONEME_LIMIT:
            cut = piece.rfind(" ", 0, PHONEME_LIMIT)
            cut = PHONEME_LIMIT if cut <= 0 else cut
            if current:
                parts.append(current)
                current = ""
            parts.append(piece[:cut])
            piece = piece[cut:].strip()
        if current and len(current) + 1 + len(piece) > PHONEME_LIMIT:
            parts.append(current)
            current = ""
        current = f"{current} {piece}" if current else piece
    if current:
        parts.append(current)
    return parts


def _wav(samples) -> bytes:
    import numpy as np
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    body = io.BytesIO()
    with wave.open(body, "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(SAMPLE_RATE)
        file.writeframes(pcm)
    return body.getvalue()


class AnswerVoice:
    """The spoken answers, as a model for `ModelHost`."""

    def __init__(self) -> None:
        self._model = None

    def load(self, folder: Path) -> None:
        import numpy as np
        import onnxruntime
        from misaki import en

        try:
            options = onnxruntime.SessionOptions()
            options.intra_op_num_threads = CPU_THREADS
            session = onnxruntime.InferenceSession(str(folder / "model_quantized.onnx"), options,
                                                   providers=["CPUExecutionProvider"])
            voice = np.fromfile(folder / "af_heart.bin", dtype="<f4").reshape(-1, 1, 256)
            vocabulary = json.loads((folder / "tokenizer.json").read_text())["model"]["vocab"]
            phonemes = en.G2P(trf=False, british=False, fallback=lambda token: (_sounds_of(token.text), 1))
            phonemes.lexicon.golds["Satyr"] = "sˈATəɹ"
            phonemes.lexicon.golds["pantry"] = "sˈATəɹ"
            self._model = (session, voice, vocabulary, phonemes)
            self.read("Ready.")
        except Exception:  # A failed load leaves the browser's voice in use, and the next check retries.
            self._model = None
            raise

    def unload(self) -> None:
        self._model = None
        gc.collect()

    def read(self, text: str) -> bytes:
        import numpy as np
        session, voice, vocabulary, phonemes = self._model
        spoken, _ = phonemes(speakable(text))
        parts = []
        for part in split_phonemes(spoken):
            tokens = [vocabulary[sound] for sound in part if sound in vocabulary]
            if tokens:
                parts.append(session.run(None, {
                    "input_ids": np.array([[0, *tokens, 0]], dtype=np.int64),
                    "style": voice[min(len(tokens), len(voice) - 1)],
                    "speed": np.array([1.0], dtype=np.float32),
                })[0].reshape(-1))
        return _wav(np.concatenate(parts) if parts else np.zeros(SAMPLE_RATE // 10, dtype=np.float32))
