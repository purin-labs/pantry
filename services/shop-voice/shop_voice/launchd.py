"""The launchd job. It runs in the person's session, so that the install needs no administrator."""
import os
import plistlib
import subprocess
import sys
import time
from pathlib import Path

from .state import DEFAULT_LABEL, home

BOOTSTRAP_ATTEMPTS = 10


def label() -> str:
    return os.environ.get("PANTRY_VOICE_LABEL", DEFAULT_LABEL)


def plist_path() -> Path:
    return Path.home() / "Library/LaunchAgents" / f"{label()}.plist"


def _domain() -> str:
    return f"gui/{os.getuid()}"


def write_and_start() -> None:
    log = home() / "service.log"
    job = {
        "Label": label(),
        "ProgramArguments": [sys.executable, "-m", "shop_voice", "run"],
        "EnvironmentVariables": {"PANTRY_VOICE_HOME": str(home()), "PYTHONPATH": str(home() / "app"),
                                 "PYTHONUNBUFFERED": "1"},
        "WorkingDirectory": str(home()),
        "RunAtLoad": True,
        # A revoked service exits with 0 and stays stopped. Any other exit restarts it.
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 10,
        "ProcessType": "Interactive",
        "StandardOutPath": str(log),
        "StandardErrorPath": str(log),
    }
    path = plist_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    stop()
    path.write_bytes(plistlib.dumps(job))
    # After a stop, launchd refuses the same job for a moment. An update always comes here.
    for _ in range(BOOTSTRAP_ATTEMPTS - 1):
        if subprocess.run(["launchctl", "bootstrap", _domain(), str(path)], capture_output=True).returncode == 0:
            return
        time.sleep(1)
    subprocess.run(["launchctl", "bootstrap", _domain(), str(path)], check=True)


def stop() -> None:
    subprocess.run(["launchctl", "bootout", f"{_domain()}/{label()}"], capture_output=True)


def remove() -> None:
    stop()
    plist_path().unlink(missing_ok=True)
