"""Run the pâtisserie storefront journey against a local Commerce.

The runner starts Commerce on a free port with fresh storage (the storefront
proxies /v1 there), seeds the local café merchant, runs the pâtisserie menu setup two
times (a second run must leave one menu of twenty-four items), starts the
storefront as shop.purin.io builds it, and drives it with the Playwright
CLI. Screenshots and the result go to output/playwright/patisserie-storefront.
"""

import argparse
import json
import os
from pathlib import Path
import signal
import socket
import tempfile
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
COMMERCE = ROOT / "services/commerce"
ARTIFACTS = ROOT / "output/playwright/patisserie-storefront"
MERCHANT = "merchant_nuki_cafe_demo"

def free_port() -> int:
    # Another session may run this journey at the same time, so each run
    # takes ports that nothing else holds.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def stop(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass  # It has stopped already.


def node_script(script: str, arguments: list[str], env: dict[str, str]) -> str:
    result = subprocess.run(
        [
            "node",
            "--experimental-strip-types",
            f"--env-file={COMMERCE / '.dev.vars.local'}",
            str(COMMERCE / "scripts" / script),
            *arguments,
        ],
        cwd=COMMERCE,
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"{script} failed:\n{result.stderr[-3000:]}")
    return result.stdout


def wait_ready(url: str, process: subprocess.Popen) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"The process for {url} stopped")
        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except (urllib.error.URLError, ConnectionError):
            time.sleep(0.5)
    raise RuntimeError(f"{url} did not start")


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
    if not (COMMERCE / ".dev.vars.local").exists():
        raise SystemExit("services/commerce/.dev.vars.local is missing")
    run_id = uuid.uuid4().hex[:8]
    port = free_port()
    commerce = subprocess.Popen(
        [
            "pnpm", "exec", "wrangler", "dev", "--local", "--env", "local",
            "--persist-to", tempfile.mkdtemp(prefix=f"patisserie-{run_id}-"),
            "--port", str(port), "--inspector-port", str(free_port()),
            # Its own Worker name: under the name "commerce" this run would
            # replace the developer's Commerce in the shared dev registry
            # and, when it stops, leave the local Platform without one.
            "--name", f"commerce-journey-{run_id}",
        ],
        cwd=COMMERCE,
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_ready(f"http://127.0.0.1:{port}/health", commerce)
        run_journey(args.cli, run_id, f"http://127.0.0.1:{port}")
    finally:
        stop(commerce)


def run_journey(cli: Path, run_id: str, commerce: str) -> None:
    env = {**os.environ, "COMMERCE_BASE_URL": commerce}
    node_script("seed-local-commerce.ts", [], env)
    # The first run also makes the listed prices include 8% tax.
    runs = [
        json.loads(
            node_script(
                "configure-patisserie-menu.ts",
                ["--merchant", MERCHANT, *extra],
                env,
            )
        )
        for extra in (["--included-tax", "800"], [])
    ]
    if any(run["items"] != 24 for run in runs):
        raise RuntimeError(f"The menu setup did not publish 24 items: {runs}")
    # Guest sessions come from a catalog snapshot that Commerce keeps for
    # 5 s, so a session in that time would still pin the old storefront.
    time.sleep(6)

    site_port = free_port()
    site = subprocess.Popen(
        [
            "pnpm", "--dir", str(ROOT / "apps/storefront"), "exec", "vite",
            "--port", str(site_port), "--strictPort", "--host", "127.0.0.1",
        ],
        cwd=ROOT,
        env={
            **os.environ,
            "VITE_SHOP_MERCHANT_ID": MERCHANT,
            "STOREFRONT_COMMERCE_ORIGIN": commerce,
        },
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    session = "patisserie-" + run_id
    opened = False
    try:
        site_url = f"http://127.0.0.1:{site_port}/"
        wait_ready(site_url, site)
        run_cli(cli, session, ["open", site_url], "open")
        opened = True
        journey = (ROOT / "scripts/patisserie/storefront-journey.js").read_text()
        journey = journey.strip().removesuffix(";")
        journey = journey.replace("JOURNEY_SITE", json.dumps(site_url))
        journey = journey.replace("JOURNEY_ARTIFACTS", json.dumps(str(ARTIFACTS)))
        output = run_cli(cli, session, ["run-code", journey], "journey")
        evidence = {
            "backend": "local Commerce Worker with its own storage",
            "site": "the storefront built as shop.purin.io builds it",
            "menuSetup": runs,
            "journey": result_json(output),
        }
        if evidence["journey"].get("result") != "passed":
            raise RuntimeError("The journey did not pass")
        (ARTIFACTS / "patisserie-storefront-results.json").write_text(
            json.dumps(evidence, indent=2, ensure_ascii=False) + "\n"
        )
        print(json.dumps(evidence, indent=2, ensure_ascii=False))
    finally:
        try:
            if opened:
                run_cli(cli, session, ["close"], "close")
        finally:
            stop(site)


if __name__ == "__main__":
    main()
