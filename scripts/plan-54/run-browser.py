#!/usr/bin/env python3
"""Verify separate authenticated Portal sessions against an isolated local Worker/D1."""
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
ARTIFACTS = ROOT / "output/playwright/plan-54"


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
        "--journey", type=Path, default=ROOT / "scripts/plan-54/browser-membership.js"
    )
    parser.add_argument("--artifacts", type=Path, default=ARTIFACTS)
    parser.add_argument("--provider", type=Path)
    parser.add_argument("--entry", default="/chat-preview.html")
    parser.add_argument("--setup-path", default="/test/setup")
    args = parser.parse_args()
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex[:8]
    session = "plan54-" + run_id
    persistence = ROOT / "tmp" / ("plan54-browser-" + run_id)
    config = ROOT / "scripts/plan-54/wrangler.jsonc"
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
    secret_command = wrangler + [
        "secrets-store", "secret", "create", "browser-fixture", "--config", str(config),
        "--persist-to", str(persistence), "--name", "checkpoint-root",
        "--scopes", "workers", "--value", "ERERERERERERERERERERERERERERERERERERERERERE=",
    ]
    with (artifacts / "checkpoint-fixture.log").open("w") as log:
        subprocess.run(
            secret_command, cwd=ROOT, check=True, stdout=log, stderr=subprocess.STDOUT
        )
    processes = []
    opened = False
    try:
        worker_command = wrangler + [
            "dev", "--config", str(config), "--local", "--persist-to", str(persistence),
            "--port", "8834", "--inspector-port", "9234",
        ]
        if args.provider is not None:
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
            str(ROOT / "scripts/plan-54/vite.config.ts"),
        ]
        with (artifacts / "portal.log").open("w") as log:
            portal = subprocess.Popen(
                portal_command, cwd=ROOT, start_new_session=True,
                stdout=log, stderr=subprocess.STDOUT,
            )
        processes.append(portal)
        wait_ready("http://127.0.0.1:8834/test/health", backend)
        wait_ready("http://127.0.0.1:3116" + args.entry, portal)
        request = urllib.request.Request(
            "http://127.0.0.1:8834" + args.setup_path, method="POST"
        )
        with urllib.request.urlopen(request) as response:
            fixtures = json.load(response)
        runner.run_cli(
            args.cli, session,
            ["open", "http://127.0.0.1:3116" + args.entry], "open",
        )
        opened = True
        runner.run_cli(args.cli, session, ["snapshot"], "initial-snapshot")
        journey = args.journey.read_text()
        journey = journey.strip().removesuffix(";")
        journey = journey.replace(
            "FIXTURE_SOURCE",
            json.dumps((ROOT / "scripts/plan-54/browser-fixture.js").read_text()),
        )
        journey = journey.replace("JOURNEY_FIXTURES", json.dumps(fixtures))
        output = runner.run_cli(
            args.cli, session, ["run-code", journey], "authenticated-journey"
        )
        evidence = {
            "backend": "isolated local production Worker routing and D1",
            "identity": "independent browser contexts with real control sessions",
            "model": "simulated provider" if args.provider else "no inference calls",
            "journey": runner.result_json(output),
        }
        if args.provider is not None:
            provider = json.loads((artifacts / "provider-results.json").read_text())
            if len(provider["calls"]) != evidence["journey"]["modelTurns"]:
                raise RuntimeError("Provider calls do not match accepted model turns")
            evidence["provider"] = provider
        (artifacts / "authenticated-browser-results.json").write_text(
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
