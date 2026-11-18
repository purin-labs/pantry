"""Qwen3-ASR 1.7B with MLX (mlx-audio), with the settings of the Plan 82C bench."""
import gc
import zlib
from pathlib import Path

from ..model_files import FileSet

ID = "qwen3-asr-1.7b"
FILES = FileSet(
    base_url="https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-bf16/resolve",
    revision="e1f6c266914abc5a46e8756e02580f834a6cf8a7",
    files=(
        ("chat_template.json", 1_161, "75a8cfca24f00de72d796fbfed6858fc9614ef3dabd8696684cc3bc03a9c58ff"),
        ("config.json", 6_983, "62fe9a2ba2de536820229e126fdfb35f9910b9a337dc46d3737c3b1ac0a9caa9"),
        ("generation_config.json", 142, "1da527824d81e07118facff437e03f2e24a23311e3bdeb2368973fe77e5f275c"),
        ("merges.txt", 1_671_853, "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5"),
        ("model.safetensors.index.json", 51_384, "a3ee6037ec82e95dc8577216ac84cf0b3c92cfefc099cf20b2296571f2fb3fc0"),
        ("preprocessor_config.json", 330, "45e120a4eda2c20c5d7f2ea9354e63536bf35e27aa573fb7cdf78017b378770d"),
        ("tokenizer_config.json", 12_487, "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c"),
        ("vocab.json", 2_776_833, "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"),
        ("model.safetensors", 4_076_186_653, "2f080a3b769ae469aeaaa2dcb9e13a94141e54c9e6d5a7aa63392e0dc5a51789"),
    ),
)
# A command is short. On noise, Qwen3-ASR can read its hotwords back until this limit.
MAX_TOKENS = 160
# The engine rule (Plan 82C): Qwen3-ASR reads its hotwords back on noise with more confidence than a real
# command, so its log-probabilities cannot separate the two. A text that repeats itself, or a decode that
# reaches its limit, is noise. On the bench no command of 432 reached the limit, and every readback of a
# 55-term list did.
REPEATED_TEXT_COMPRESSION = 2.4
# On noise, Qwen3-ASR reads the hotword list back in order. When the first parts of its text are the first
# terms of the list, the decode stops: the text is noise, and a whole readback of 55 terms takes 2.8 s, as
# long as the Portal waits for a 6 s clip. A person who says the first three terms in the list's own order
# is also stopped.
READBACK_TERMS = 3
# On other noise, Qwen3-ASR repeats one sound ("Rrrrr…") to its token limit, which took 3.5 s on the owner's
# room sound (Plan 82C Phase 3). The engine rule drops such a text at the end. The decode stops as soon as
# this much text repeats itself past the rule's limit, so that the Mac answers before the Portal's wait.
REPEAT_CHECK_CHARACTERS = 60
REPEAT_CHECK_EVERY = 8


def compression_ratio(text: str) -> float:
    """Whisper's own measure of repeated text."""
    data = text.encode()
    return len(data) / len(zlib.compress(data)) if data else 0.0


def is_noise(text: str, tokens: int) -> bool:
    return compression_ratio(text) > REPEATED_TEXT_COMPRESSION or tokens >= MAX_TOKENS


def repeats_itself(text: str) -> bool:
    """The engine rule's measure of repeated text, early: a short text compresses badly, so it waits for enough."""
    return len(text) >= REPEAT_CHECK_CHARACTERS and compression_ratio(text) > REPEATED_TEXT_COMPRESSION


def reads_back(text: str, vocabulary: tuple[str, ...]) -> bool:
    """True when the text so far starts with the list's first terms, and the next part has begun."""
    if len(vocabulary) < READBACK_TERMS:
        return False
    parts = [part.strip().lower() for part in text.split(",")]
    return len(parts) > READBACK_TERMS and parts[:READBACK_TERMS] == [
        term.strip().lower() for term in vocabulary[:READBACK_TERMS]]


class Qwen3Mlx:
    id = ID
    files = FILES

    def __init__(self) -> None:
        self._model = None

    def load(self, folder: Path) -> None:
        import numpy as np
        from mlx_audio.stt.utils import load
        self._model = load(str(folder), model_type="qwen3_asr")
        self.hear(np.zeros(16_000, dtype="float32"), ())

    def unload(self) -> None:
        import mlx.core as mx
        self._model = None
        gc.collect()
        mx.clear_cache()

    def hear(self, samples, vocabulary: tuple[str, ...]) -> str:
        """Greedy decoding, as `generate(hotwords=...)` with temperature 0: the terms are the system prompt."""
        import mlx.core as mx
        model = self._model
        tokenizer = model._tokenizer  # mlx-audio 0.6.5 has no public decode for a token stream.
        tokens: list[int] = []
        for token, _ in model.stream_generate(mx.array(samples), max_tokens=MAX_TOKENS, language="English",
                                              system_prompt=", ".join(vocabulary) or None):
            tokens.append(int(token))
            if "," in tokenizer.decode([tokens[-1]]) and reads_back(
                    tokenizer.decode(tokens, skip_special_tokens=True), vocabulary):
                return ""
            if len(tokens) % REPEAT_CHECK_EVERY == 0 and repeats_itself(
                    tokenizer.decode(tokens, skip_special_tokens=True)):
                return ""
        text = tokenizer.decode(tokens, skip_special_tokens=True).strip()
        return "" if is_noise(text, len(tokens)) else text
