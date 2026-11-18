"""The Mac follows the engine that a manager chose (Plan 82C D2).

The Platform names the choice in each heartbeat answer. On a new choice, the Mac downloads the engine's
files with the usual resume and SHA-256 check, and keeps its engine in use until they are complete. It
then changes engine, and only one is ever in memory. The old engine's files stay for 14 days with no use,
so a change back needs no download (D3).
"""
import threading

from . import state
from .engines import ENGINES, SpeechEngine, new_engine
from .model_files import ModelFiles
from .model_host import ModelHost


class EngineChoice:
    def __init__(self, host: ModelHost, base_url: str | None) -> None:
        self.host = host
        self._base_url = base_url
        self._lock = threading.Lock()
        self._active: str = host.model.id
        self._pending: tuple[SpeechEngine, ModelFiles] | None = None

    @property
    def downloading(self) -> str | None:
        """The chosen engine whose files are on their way."""
        with self._lock:
            return None if self._pending is None else self._pending[0].id

    def follow(self, chosen: object) -> None:
        """Takes the choice of a heartbeat answer. An engine that this service does not know stays unused."""
        if not isinstance(chosen, str) or chosen not in ENGINES:
            return
        with self._lock:
            if self._pending is not None and self._pending[0].id != chosen:
                engine, files = self._pending
                files.stop()
                state.mark_engine_unused(engine.id)
                self._pending = None
            if chosen == self._active or self._pending is not None:
                return
            engine = new_engine(chosen)
            files = ModelFiles(state.engine_dir(chosen), engine.files, self._base_url)
            self._pending = (engine, files)
            state.mark_engine_used(chosen)
        files.start(on_ready=lambda: self._change(engine, files))

    def remove_unused(self) -> None:
        with self._lock:
            keep = {self._active} | ({self._pending[0].id} if self._pending else set())
        for engine_id in state.remove_unused_engines(keep):
            print(f"Removed the files of {engine_id}, unused for 14 days.", flush=True)

    def _change(self, engine: SpeechEngine, files: ModelFiles) -> None:
        with self._lock:
            # The choice can have changed while the files came.
            if self._pending is None or self._pending[1] is not files:
                return
            previous = self._active
            self.host.replace(engine, files)
            self._active = engine.id
            self._pending = None
            state.save_active_engine(engine.id)
            state.mark_engine_unused(previous)
        print(f"Speech engine: {previous} -> {engine.id}", flush=True)
