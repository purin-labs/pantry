"""Whisper large-v3-turbo with MLX, with the settings of the bench (Plan 82 G0.1)."""
import gc
from pathlib import Path

from ..model_files import FileSet

ID = "whisper-large-v3-turbo"
FILES = FileSet(
    base_url="https://huggingface.co/mlx-community/whisper-large-v3-turbo/resolve",
    revision="a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb",
    files=(
        ("config.json", 268, "b34fc29e4e11e0a25e812775dd67f4dd16fc2c8eb43d28ae25ff7d660ecb6379"),
        ("weights.safetensors", 1_613_977_612, "951ed3fc1203e6a62467abb2144a96ce7eafca8fa77e3704fdb8635ff3e7f8a6"),
    ),
)
# Whisper invents words on room noise when its prompt holds the shop's vocabulary. On noise and voices
# that did not choose these numbers, dropping such segments stopped 76 of the 77 noise clips that passed
# the Portal's own check, and no good command of 375 (scripts/shop-voice/confidence-bench.py). The
# fallback on Workers AI uses the same two numbers (services/platform/src/voice/engines/).
LOW_CONFIDENCE_LOGPROB = -1.4
REPEATED_TEXT_COMPRESSION = 2.4


def is_noise(segment: dict) -> bool:
    """The engine rule. A NaN value also counts as noise."""
    return not segment["avg_logprob"] >= LOW_CONFIDENCE_LOGPROB or segment["compression_ratio"] > REPEATED_TEXT_COMPRESSION


class WhisperMlx:
    id = ID
    files = FILES

    def __init__(self) -> None:
        self._folder: Path | None = None

    def load(self, folder: Path) -> None:
        import numpy as np
        self._folder = folder
        self.hear(np.zeros(16_000, dtype="float32"), ())

    def unload(self) -> None:
        import mlx.core as mx
        from mlx_whisper.transcribe import ModelHolder
        ModelHolder.model = None
        ModelHolder.model_path = None
        gc.collect()
        mx.clear_cache()

    def hear(self, samples, vocabulary: tuple[str, ...]) -> str:
        import mlx_whisper
        result = mlx_whisper.transcribe(samples, path_or_hf_repo=str(self._folder), language="en", temperature=0.0,
                                        condition_on_previous_text=False,
                                        initial_prompt=", ".join(vocabulary) or None, verbose=None)
        return "".join(segment["text"] for segment in result["segments"] if not is_noise(segment)).strip()
