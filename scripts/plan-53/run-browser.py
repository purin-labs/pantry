#!/usr/bin/env python3
"""Run real Portal preference controls against the isolated acceptance Worker."""

import argparse
import json
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "output/playwright/plan-53"


def run_cli(cli: Path, session: str, command: list[str], name: str) -> str:
    result = subprocess.run(
        ["bash", str(cli), "--session", session, *command],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    output = result.stdout + result.stderr
    (ARTIFACTS / f"{name}.log").write_text(output)
    if result.returncode != 0 or "### Error" in output:
        raise RuntimeError(f"{name} failed:\n{output[:3000]}")
    return output


def result_json(output: str) -> object:
    start = output.index("### Result\n") + len("### Result\n")
    end = output.index("\n### Ran Playwright code", start)
    return json.loads(output[start:end].strip())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cli",
        type=Path,
        default=Path.home() / ".codex/skills/playwright/scripts/playwright_cli.sh",
    )
    args = parser.parse_args()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    session = "plan53-" + uuid.uuid4().hex[:8]
    try:
        run_cli(
            args.cli,
            session,
            ["open", "http://127.0.0.1:3115/chat-preview.html"],
            "open",
        )
        fixture = (ROOT / "scripts/plan-53/browser-fixture.js").read_text()
        journey = (ROOT / "scripts/plan-53/browser-journey.js").read_text()
        journey = journey.strip().removesuffix(";")
        journey = journey.replace("FIXTURE_SOURCE", json.dumps(fixture))
        result = run_cli(args.cli, session, ["run-code", journey], "journey")
        evidence = {
            "session": session,
            "preferencesBackend": "isolated local Worker and D1",
            "journey": result_json(result),
        }
        (ARTIFACTS / "browser-results.json").write_text(
            json.dumps(evidence, indent=2) + "\n"
        )
        print(json.dumps(evidence, indent=2))
    finally:
        run_cli(args.cli, session, ["close"], "close")


if __name__ == "__main__":
    main()
