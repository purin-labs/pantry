"""The speech engines of the shop Mac (Plan 82C): one module for each engine, behind one interface.

An engine is one model with its own settings and its own noise rule. Its `hear` returns the text after
that rule; the Portal's text check (`keptVoiceText` in @purin-labs/control-api) drops the rest of what an
engine invents on noise, for every engine. The ids are those of the catalogue in
`packages/control-api/src/voice-engines.ts`.
"""
from pathlib import Path
from typing import Protocol

from ..model_files import FileSet
from . import qwen3_mlx, whisper_mlx

SAMPLE_RATE = 16_000


class SpeechEngine(Protocol):
    id: str
    files: FileSet

    def load(self, folder: Path) -> None: ...

    def unload(self) -> None: ...

    def hear(self, samples, vocabulary: tuple[str, ...]) -> str: ...


ENGINES = {whisper_mlx.ID: whisper_mlx.WhisperMlx, qwen3_mlx.ID: qwen3_mlx.Qwen3Mlx}
# A new Mac starts with this engine, until a manager chooses another one (Plan 82C D2).
DEFAULT_ENGINE = whisper_mlx.ID


def new_engine(engine_id: str = DEFAULT_ENGINE) -> SpeechEngine:
    return ENGINES[engine_id]()


def samples_of(pcm: bytes):
    """16-bit PCM at 16 kHz, as float32 samples."""
    import numpy as np
    return np.frombuffer(pcm, dtype="<i2").astype("float32") / 32768.0
