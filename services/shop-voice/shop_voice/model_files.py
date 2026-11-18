"""The pinned files of one model. They download only after enrollment, with resume and SHA-256."""
import hashlib
import http.client
import shutil
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import VERSION

CHUNK_BYTES = 1 << 20
RETRY_SECONDS = (5, 30, 120, 300)
READ_TIMEOUT_SECONDS = 60


@dataclass(frozen=True)
class FileSet:
    """Where a model's files come from: `{base_url}/{revision}/{name}`, with the size and SHA-256 of each.
    A name with a folder keeps only its last part on the Mac."""

    base_url: str
    revision: str
    files: tuple[tuple[str, int, str], ...]

    @property
    def download_bytes(self) -> int:
        return sum(size for _, size, _ in self.files)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


class DownloadStopped(Exception):
    pass


def _fetch(url: str, part: Path, stopped: threading.Event) -> None:
    """Adds the rest of the file to `part`. A server that ignores the range restarts it."""
    have = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": f"satyr-shop-voice/{VERSION}"}
    if have:
        headers["Range"] = f"bytes={have}-"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=READ_TIMEOUT_SECONDS) as response, \
                part.open("ab" if response.status == 206 else "wb") as file:
            while chunk := response.read(CHUNK_BYTES):
                if stopped.is_set():
                    raise DownloadStopped
                file.write(chunk)
    except urllib.error.HTTPError as error:
        if error.code != 416:  # The part already holds the whole file.
            raise


class ModelFiles:
    """`base_url` replaces the file set's own host, for a journey's local mirror."""

    def __init__(self, folder: Path, files: FileSet, base_url: str | None = None) -> None:
        self.folder = folder
        self.base_url = base_url or files.base_url
        self.revision = files.revision
        self.files = files.files
        self.ready = threading.Event()
        self.downloading = threading.Event()
        self.stopped = threading.Event()

    def start(self, on_ready: Callable[[], None] | None = None) -> None:
        """Downloads the missing files on its own thread. `on_ready` runs on that thread when all are here."""
        threading.Thread(target=self._run, args=(on_ready,), name="model-files", daemon=True).start()

    def stop(self) -> None:
        """Stops a download that is no longer needed. Its part stays, so a later start resumes it."""
        self.stopped.set()

    def complete(self) -> bool:
        return all((self.folder / Path(name).name).exists() for name, _, _ in self.files)

    def _download_one(self, name: str, size: int, sha256: str) -> None:
        target = self.folder / Path(name).name
        if target.exists():
            return
        part = self.folder / f"{target.name}.part"
        needed = size - (part.stat().st_size if part.exists() else 0)
        if shutil.disk_usage(self.folder).free < needed + CHUNK_BYTES:
            raise OSError("not enough disk space")
        _fetch(f"{self.base_url}/{self.revision}/{name}", part, self.stopped)
        have = part.stat().st_size
        if have < size:
            raise OSError("the download stopped early")
        if have > size or _sha256(part) != sha256:
            part.unlink()
            raise OSError("the file failed its SHA-256 check")
        part.rename(target)

    def _run(self, on_ready: Callable[[], None] | None) -> None:
        self.folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        failures = 0
        while not self.complete():
            if self.stopped.is_set():
                self.downloading.clear()
                return
            self.downloading.set()
            try:
                for name, size, sha256 in self.files:
                    self._download_one(name, size, sha256)
            except DownloadStopped:
                continue
            except (OSError, http.client.HTTPException) as error:
                print(f"Model download: {type(error).__name__}: {error}", flush=True)
                self.stopped.wait(RETRY_SECONDS[min(failures, len(RETRY_SECONDS) - 1)])
                failures += 1
        self.downloading.clear()
        self.ready.set()
        if on_ready is not None:
            on_ready()
