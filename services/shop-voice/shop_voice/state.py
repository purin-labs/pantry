"""The service's folder: configuration, secrets, model files and certificate.

No audio and no transcript ever comes here.
"""
import json
import os
import shutil
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

DEFAULT_PORT = 443
DEFAULT_HEARTBEAT_SECONDS = 60
DEFAULT_IDLE_UNLOAD_SECONDS = 30 * 60
# A Mac from before 0.4.0 saved these hosts of the files in its configuration. Each file set now names
# its own host (Plan 82C), so these values mean no override.
_OLD_BASE_URLS = {
    "model_base_url": "https://huggingface.co/mlx-community/whisper-large-v3-turbo/resolve",
    "speech_base_url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve",
}
DEFAULT_LABEL = "io.purin.pantry.shop-voice"
# An engine's files stay this long after the Mac stops using it, so a change back needs no download
# (Plan 82C D3).
UNUSED_ENGINE_SECONDS = 14 * 24 * 60 * 60
_UNUSED_SINCE = ".unused-since"


def home() -> Path:
    # certbot splits its hook command at each space, so this path must have none.
    return Path(os.environ.get("PANTRY_VOICE_HOME", Path.home() / ".pantry-voice"))


@dataclass(frozen=True)
class Config:
    platform_origin: str
    organisation_id: str
    mac_id: str
    credential: str
    grant_key: str
    hostname: str
    portal_origins: list[str] = field(default_factory=list)
    port: int = DEFAULT_PORT
    heartbeat_seconds: int = DEFAULT_HEARTBEAT_SECONDS
    idle_unload_seconds: int = DEFAULT_IDLE_UNLOAD_SECONDS
    # A journey's local mirror of the engine's and the voice's files. None means each file set's own host.
    model_base_url: str | None = None
    speech_base_url: str | None = None
    # A journey with no public DNS or certificate authority sets these two.
    wait_for_dns: bool = True
    certificate_command: list[str] | None = None


def config_path() -> Path:
    return home() / "config.json"


def save_config(config: Config) -> None:
    home().mkdir(mode=0o700, parents=True, exist_ok=True)
    path = config_path()
    path.touch(mode=0o600, exist_ok=True)
    path.write_text(json.dumps(asdict(config), indent=1))


def load_config() -> Config | None:
    try:
        saved = json.loads(config_path().read_text())
    except FileNotFoundError:
        return None
    for key, old in _OLD_BASE_URLS.items():
        if saved.get(key) == old:
            saved[key] = None
    return Config(**saved)


def model_dir() -> Path:
    """The engines' folders. Each engine keeps its files in its own folder, so that two can stay."""
    return home() / "model"


def engine_dir(engine_id: str) -> Path:
    return model_dir() / engine_id


def adopt_loose_model_files(engine_id: str, names: list[str]) -> None:
    """A Mac from before 0.4.0 keeps Whisper's files in the models' folder itself. Moving them into the
    engine's folder saves a download of 1.6 GB. A part of a download moves too, so it resumes."""
    folder = engine_dir(engine_id)
    for name in names:
        for loose in (model_dir() / name, model_dir() / f"{name}.part"):
            if loose.is_file() and not (folder / loose.name).exists():
                folder.mkdir(mode=0o700, parents=True, exist_ok=True)
                loose.rename(folder / loose.name)


def active_engine(default: str, known: set[str]) -> str:
    """The engine that the Mac ran last. A Mac from before Plan 82C Phase 2 has no record, and runs `default`."""
    try:
        engine = (home() / "engine").read_text().strip()
    except FileNotFoundError:
        return default
    return engine if engine in known else default


def save_active_engine(engine_id: str) -> None:
    path = home() / "engine"
    path.write_text(engine_id)


def mark_engine_used(engine_id: str) -> None:
    (engine_dir(engine_id) / _UNUSED_SINCE).unlink(missing_ok=True)


def mark_engine_unused(engine_id: str, now: float | None = None) -> None:
    """Starts the 14 days of an engine that the Mac no longer uses. An earlier start stays."""
    folder = engine_dir(engine_id)
    if folder.is_dir() and not (folder / _UNUSED_SINCE).exists():
        (folder / _UNUSED_SINCE).write_text(str(int(time.time() if now is None else now)))


def kept_engine_files() -> list[str]:
    """The engines whose folders are on this Mac."""
    return sorted(path.name for path in model_dir().iterdir() if path.is_dir()) if model_dir().is_dir() else []


def remove_unused_engines(keep: set[str], now: float | None = None) -> list[str]:
    """Deletes the files of each engine that the Mac did not use for 14 days. A folder of another engine
    with no record starts its 14 days now. It returns the engines whose files went."""
    now = time.time() if now is None else now
    removed = []
    for engine_id in kept_engine_files():
        if engine_id in keep:
            continue
        marker = engine_dir(engine_id) / _UNUSED_SINCE
        try:
            since = int(marker.read_text())
        except (FileNotFoundError, ValueError):
            mark_engine_unused(engine_id, now)
            continue
        if now - since >= UNUSED_ENGINE_SECONDS:
            shutil.rmtree(engine_dir(engine_id), ignore_errors=True)
            removed.append(engine_id)
    return removed


def speech_dir() -> Path:
    return home() / "speech"


def certificate_dir() -> Path:
    return home() / "letsencrypt"


def wipe_enrollment() -> None:
    """After a revocation: the models, the certificate, the credential and the grant key."""
    shutil.rmtree(model_dir(), ignore_errors=True)
    shutil.rmtree(speech_dir(), ignore_errors=True)
    (home() / "engine").unlink(missing_ok=True)
    for name in ("letsencrypt", "certbot-work", "certbot-logs"):
        shutil.rmtree(home() / name, ignore_errors=True)
    config_path().unlink(missing_ok=True)
