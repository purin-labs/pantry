"""One model on one worker thread (Plan 82C): the speech engine and the answer voice each have one.

The host loads the model when a member's Portal checks the Mac, unloads it after an idle time, and
runs one call at a time while a few wait. MLX, ONNX Runtime and their dependencies import only in the
model's own load, so a service with no member near it stays small. The host can change its model for
another one whose files are complete, as when a manager chooses another speech engine.
"""
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Generic, Protocol, TypeVar

from .model_files import ModelFiles

T = TypeVar("T")
M = TypeVar("M", bound="HostedModel")


class Busy(Exception):
    pass


class ModelNotReady(Exception):
    pass


class HostedModel(Protocol):
    def load(self, folder: Path) -> None:
        """Loads the model from its files and runs it once, so that the first command is fast."""

    def unload(self) -> None:
        """Frees the model's memory."""


class ModelHost(Generic[M]):
    def __init__(self, model: M, files: ModelFiles, idle_unload_seconds: int, *, label: str,
                 slots: int, queue_wait_seconds: float) -> None:
        self.model = model
        self.files = files
        self.idle_unload_seconds = idle_unload_seconds
        self._label = label
        self._slots = slots
        self._queue_wait_seconds = queue_wait_seconds
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix=label.lower().replace(" ", "-"))
        self._lock = threading.Lock()
        self._loaded_state = "unloaded"
        self._last_use = time.monotonic()
        self._free = threading.BoundedSemaphore(slots)
        self._waiting = 0

    @property
    def model_state(self) -> str:
        if self.files.ready.is_set():
            with self._lock:
                return self._loaded_state
        return "downloading" if self.files.downloading.is_set() else "none"

    @property
    def busy(self) -> bool:
        with self._lock:
            return self._waiting >= self._slots

    def check(self) -> None:
        """A member's Portal checked the Mac: keep the model, or start its load."""
        with self._lock:
            self._last_use = time.monotonic()
            if not self.files.ready.is_set() or self._loaded_state != "unloaded":
                return
            self._loaded_state = "loading"
        self._worker.submit(self._load)

    def unload_if_idle(self) -> None:
        with self._lock:
            idle = time.monotonic() - self._last_use >= self.idle_unload_seconds
            if not idle or self._loaded_state != "loaded":
                return
        self._worker.submit(self._unload)

    def run(self, call: Callable[[M], T]) -> "Future[T]":
        """Runs the call with the hosted model on the worker. It starts no load: only a member's check does
        (Plan 82 D1b). The call gets the model that is loaded when it runs, not the one at its request."""
        with self._lock:
            self._last_use = time.monotonic()
            if self._loaded_state != "loaded":
                raise ModelNotReady
        if not self._free.acquire(blocking=False):
            raise Busy
        with self._lock:
            self._waiting += 1
        deadline = time.monotonic() + self._queue_wait_seconds
        future = self._worker.submit(self._run, call, deadline)
        future.add_done_callback(self._release)
        return future

    def _release(self, _: Future) -> None:
        with self._lock:
            self._waiting -= 1
        self._free.release()

    def _run(self, call: Callable[[M], T], deadline: float) -> T:
        # The Portal stopped waiting for a call that waited this long, so it has no reader.
        if time.monotonic() > deadline:
            raise Busy
        with self._lock:
            if self._loaded_state != "loaded":
                raise ModelNotReady
        return call(self.model)

    def replace(self, model: M, files: ModelFiles) -> None:
        """Changes the model for one whose files are complete. The old model leaves memory before the new one
        loads, so only one is ever in memory. The new one loads at once if the old one was in memory. The
        calls in between hear `ModelNotReady`, and the Portal uses the fallback."""
        self._worker.submit(self._replace, model, files)

    def _replace(self, model: M, files: ModelFiles) -> None:
        with self._lock:
            # On the worker, a load that a check started has run, or it waits behind this turn.
            was = self._loaded_state
            if was == "loaded":
                self._loaded_state = "loading"
        if was == "loaded":
            self.model.unload()
        with self._lock:
            self.model = model
            self.files = files
        if was == "loaded":
            self._load()

    def _load(self) -> None:
        try:
            self.model.load(self.files.folder)
            state = "loaded"
        except Exception as error:  # A failed load leaves the fallback in use, and the next check retries.
            print(f"{self._label} load failed: {type(error).__name__}", flush=True)
            state = "unloaded"
        with self._lock:
            self._loaded_state = state

    def _unload(self) -> None:
        with self._lock:
            # A member can come back between the decision and this turn of the worker.
            if time.monotonic() - self._last_use < self.idle_unload_seconds or self._loaded_state != "loaded":
                return
            self._loaded_state = "unloaded"
        self.model.unload()
