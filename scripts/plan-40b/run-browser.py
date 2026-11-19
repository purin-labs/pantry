#!/usr/bin/env python3
"""Run the shop screen's player at /tv in a browser (Plan 40B phase 1).

The Portal is built and served with `vite preview`, so that the page runs
with its service worker as in production. The browser answers the screen API
and the signal socket with the shapes that the Pantry Worker answers in the
E2E journey `services/platform/tests/e2e/menu-board-screen.test.ts`; that
journey proves the server side. This one proves the player: pairing,
playing, a signal, the saved copy offline, a restart with no network, the
catch-up after reconnect, and the end of the pairing.

    python3 scripts/plan-40b/run-browser.py

Screenshots and `screen-browser-results.json` go to output/playwright/plan-40b.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "output/playwright/plan-40b"
PORTAL = "http://127.0.0.1:3140"


def wait_ready(url: str, process: subprocess.Popen) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"The preview server exited: {url}")
        try:
            with urllib.request.urlopen(url, timeout=1):
                return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.2)
    raise RuntimeError(f"The preview server did not become ready: {url}")


def stop(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cli",
        type=Path,
        default=Path.home() / ".codex/skills/playwright/scripts/playwright_cli.sh",
    )
    args = parser.parse_args()
    artifacts = ARTIFACTS.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(
        "browser_runner", ROOT / "scripts/plan-53/run-browser.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("The browser runner is unavailable")
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.ARTIFACTS = artifacts
    dist = artifacts / "portal-dist"
    with (artifacts / "build.log").open("w") as log:
        subprocess.run(
            ["pnpm", "--filter", "@seams/portal", "exec", "vite", "build",
             "--outDir", str(dist), "--emptyOutDir"],
            cwd=ROOT, check=True, stdout=log, stderr=subprocess.STDOUT,
        )
    session = "plan40b-" + uuid.uuid4().hex[:8]
    opened = False
    with (artifacts / "preview.log").open("w") as log:
        preview = subprocess.Popen(
            ["pnpm", "--filter", "@seams/portal", "exec", "vite", "preview",
             "--outDir", str(dist), "--host", "127.0.0.1", "--port", "3140",
             "--strictPort"],
            cwd=ROOT, start_new_session=True, stdout=log, stderr=subprocess.STDOUT,
        )
    try:
        wait_ready(PORTAL + "/tv", preview)
        runner.run_cli(args.cli, session, ["open", "about:blank"], "open")
        opened = True
        journey = (ROOT / "scripts/plan-40b/browser-screen.js").read_text()
        journey = journey.strip().removesuffix(";")
        journey = journey.replace("JOURNEY_ARTIFACTS", json.dumps(str(artifacts)))
        output = runner.run_cli(args.cli, session, ["run-code", journey], "journey")
        evidence = {
            "page": "built Portal /tv with its service worker (vite preview)",
            "server": "the browser answers the screen API with the Pantry Worker's shapes",
            "journey": runner.result_json(output),
        }
        if evidence["journey"].get("result") != "passed":
            raise RuntimeError("The journey did not pass")
        (artifacts / "screen-browser-results.json").write_text(
            json.dumps(evidence, indent=2) + "\n"
        )
        print(json.dumps(evidence, indent=2))
    finally:
        try:
            if opened:
                runner.run_cli(args.cli, session, ["close"], "close")
        finally:
            stop(preview)


if __name__ == "__main__":
    main()
