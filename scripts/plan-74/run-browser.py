#!/usr/bin/env python3
"""Run the side Case journey (Plan 74) against an isolated local Worker and D1.

The model provider is simulated by side-case-provider.mjs, which also starts
the Worker. The account authority is the built account Worker of the
acceptance tests, which side-case-provider.mjs starts beside it. The Portal is
served from source.
"""
import tempfile
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
ARTIFACTS = ROOT / "output/playwright/plan-74"


def single_database_schema_file():
    """The one-database schema, built from the two deployed baselines."""
    out = Path(tempfile.mkdtemp(prefix="satyr-single-database-")) / "schema.sql"
    subprocess.run(
        ["node", str(ROOT / "services/platform/scripts/single-database-schema.mjs"), str(out)],
        check=True,
    )
    return out


def wait_ready(url: str, process: subprocess.Popen) -> None:
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Acceptance server exited: {url}")
        try:
            with urllib.request.urlopen(url, timeout=1):
                return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.2)
    raise RuntimeError(f"Acceptance server did not become ready: {url}")


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
    parser.add_argument(
        "--journey", type=Path, default=ROOT / "scripts/plan-74/browser-side-case.js"
    )
    parser.add_argument("--artifacts", type=Path, default=ARTIFACTS)
    parser.add_argument(
        "--provider", type=Path, default=ROOT / "scripts/plan-74/side-case-provider.mjs"
    )
    parser.add_argument("--entry", default="/chat-preview.html")
    parser.add_argument("--setup-path", default="/test/setup")
    args = parser.parse_args()
    if not os.environ.get("SATYR_ACCOUNT_WORKER_ARTIFACT"):
        raise SystemExit(
            "Set SATYR_ACCOUNT_WORKER_ARTIFACT to the built shared account Worker."
        )
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex[:8]
    session = "plan74-" + run_id
    persistence = ROOT / "tmp" / ("plan74-browser-" + run_id)
    config = ROOT / "scripts/plan-74/wrangler.jsonc"
    wrangler = ["pnpm", "--filter", "@seams/platform", "exec", "wrangler"]
    spec = importlib.util.spec_from_file_location(
        "browser_runner", ROOT / "scripts/plan-53/run-browser.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Existing browser runner is unavailable")
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.ARTIFACTS = artifacts
    schema_command = wrangler + [
        "d1", "execute", "DB", "--config", str(config), "--local",
        "--persist-to", str(persistence), "--file",
        str(single_database_schema_file()),
    ]
    with (artifacts / "schema.log").open("w") as log:
        subprocess.run(
            schema_command, cwd=ROOT, check=True, stdout=log, stderr=subprocess.STDOUT
        )
    for name in ("checkpoint-root", "vault-root"):
        secret_command = wrangler + [
            "secrets-store", "secret", "create", "browser-fixture",
            "--config", str(config), "--persist-to", str(persistence),
            "--name", name, "--scopes", "workers",
            "--value", "ERERERERERERERERERERERERERERERERERERERERERE=",
        ]
        with (artifacts / f"{name}-fixture.log").open("w") as log:
            subprocess.run(
                secret_command, cwd=ROOT, check=True, stdout=log,
                stderr=subprocess.STDOUT,
            )
    processes = []
    opened = False
    try:
        worker_command = [
            "node", str(args.provider.resolve()), str(config), str(persistence),
            str(artifacts / "provider-results.json"),
        ]
        with (artifacts / "worker.log").open("w") as log:
            backend = subprocess.Popen(
                worker_command, cwd=ROOT, start_new_session=True,
                stdout=log, stderr=subprocess.STDOUT,
            )
        processes.append(backend)
        portal_command = [
            "pnpm", "--filter", "@seams/portal", "exec", "vite", "--config",
            str(ROOT / "scripts/plan-74/vite.config.ts"),
        ]
        with (artifacts / "portal.log").open("w") as log:
            portal = subprocess.Popen(
                portal_command, cwd=ROOT, start_new_session=True,
                stdout=log, stderr=subprocess.STDOUT,
            )
        processes.append(portal)
        wait_ready("http://127.0.0.1:8874/test/health", backend)
        wait_ready("http://127.0.0.1:3174" + args.entry, portal)
        request = urllib.request.Request(
            "http://127.0.0.1:8874" + args.setup_path, method="POST"
        )
        with urllib.request.urlopen(request) as response:
            fixtures = json.load(response)
        runner.run_cli(
            args.cli, session,
            ["open", "http://127.0.0.1:3174" + args.entry], "open",
        )
        opened = True
        runner.run_cli(args.cli, session, ["snapshot"], "initial-snapshot")
        journey = args.journey.read_text()
        journey = journey.strip().removesuffix(";")
        journey = journey.replace("JOURNEY_FIXTURES", json.dumps(fixtures))
        journey = journey.replace("JOURNEY_ARTIFACTS", json.dumps(str(artifacts)))
        output = runner.run_cli(
            args.cli, session, ["run-code", journey], "authenticated-journey"
        )
        evidence = {
            "backend": "isolated local production Worker routing and D1",
            "identity": "independent browser contexts with real control sessions",
            "account": "built account Worker; each control request passes its check",
            "model": "simulated provider",
            "journey": runner.result_json(output),
            "provider": json.loads(
                (artifacts / "provider-results.json").read_text()
            ),
        }
        if evidence["journey"].get("result") != "passed":
            raise RuntimeError("The journey did not pass")
        (artifacts / "side-case-browser-results.json").write_text(
            json.dumps(evidence, indent=2) + "\n"
        )
        print(json.dumps(evidence, indent=2))
    finally:
        try:
            if opened:
                runner.run_cli(args.cli, session, ["close"], "close")
        finally:
            for process in reversed(processes):
                stop(process)


if __name__ == "__main__":
    main()
