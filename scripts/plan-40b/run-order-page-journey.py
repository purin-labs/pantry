"""Run the Plan 40B phase 2 journey: QR order pages at <name>.menu.<domain>.

The runner starts a local Underclerk with fresh storage and seeds two shops:
the Nuki café demo merchant and a second café merchant with the pâtisserie
menu. It gives each storefront a shop name through Underclerk's admin API
and checks the refusals (a taken name, a reserved name, a name of the wrong
form). Then it builds the storefront, runs the shop Worker with wrangler dev
(`menu.localhost` as the order page domain, Underclerk through a service
binding), and checks each host over HTTP: the right shop for each name, 404
for an unknown name, a redirect from an earlier name, and no Underclerk route
of another shop. Last, it drives both order pages in Chromium with the
Playwright CLI. Results and screenshots go to output/playwright/plan-40b-order-page.
"""

import argparse
import html
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
UNDERCLERK = ROOT / "services/commerce"
STOREFRONT = ROOT / "apps/storefront"
ARTIFACTS = ROOT / "output/playwright/plan-40b-order-page"
SUFFIX = "menu.localhost"
CAFE = "merchant_nuki_cafe_demo"
PATISSERIE = "merchant_order_page_patisserie"
STOREFRONT_ID = "storefront_cafe"


def free_port() -> int:
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
            f"--env-file={UNDERCLERK / '.dev.vars.local'}",
            str(UNDERCLERK / "scripts" / script),
            *arguments,
        ],
        cwd=UNDERCLERK,
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode not in (0, 2):
        raise RuntimeError(f"{script} failed:\n{result.stderr[-3000:]}")
    return result.stdout


def wait_ready(url: str, process: subprocess.Popen, host: str | None = None) -> None:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"The process for {url} stopped")
        try:
            request = urllib.request.Request(url)
            if host is not None:
                request.add_header("Host", host)
            with urllib.request.urlopen(request, timeout=2):
                return
        except urllib.error.HTTPError:
            return
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            time.sleep(0.5)
    raise RuntimeError(f"{url} did not start")


def get(port: int, host: str, path: str) -> tuple[int, dict[str, str], str]:
    """One request to the shop Worker with the Host of an order page."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    try:
        connection.request("GET", path, headers={"Host": host})
        response = connection.getresponse()
        body = response.read().decode("utf-8", "replace")
        return response.status, {k.lower(): v for k, v in response.getheaders()}, body
    finally:
        connection.close()


def shop_meta(body: str) -> dict | None:
    match = re.search(r'<meta name="underclerk-shop" content="([^"]*)">', body)
    return None if match is None else json.loads(html.unescape(match.group(1)))


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


class Checks:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def check(self, name: str, passed: bool, detail: object = None) -> None:
        self.items.append({"name": name, "passed": bool(passed), "detail": detail})
        if not passed:
            raise RuntimeError(f"{name}: {json.dumps(detail, ensure_ascii=False)[:2000]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cli",
        type=Path,
        default=Path.home() / ".codex/skills/playwright/scripts/playwright_cli.sh",
    )
    args = parser.parse_args()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    if not (UNDERCLERK / ".dev.vars.local").exists():
        raise SystemExit("services/commerce/.dev.vars.local is missing")
    run_id = uuid.uuid4().hex[:8]
    underclerk_name = f"underclerk-journey-{run_id}"
    port = free_port()
    scratch = Path(tempfile.mkdtemp(prefix=f"order-page-{run_id}-"))
    underclerk = subprocess.Popen(
        [
            "pnpm", "exec", "wrangler", "dev", "--local", "--env", "local",
            "--persist-to", str(scratch / "underclerk"),
            "--port", str(port), "--inspector-port", str(free_port()),
            # Its own name, so the run never replaces the developer's
            # Underclerk in the shared dev registry.
            "--name", underclerk_name,
        ],
        cwd=UNDERCLERK,
        start_new_session=True,
        stdout=(scratch / "underclerk.log").open("w"),
        stderr=subprocess.STDOUT,
    )
    try:
        wait_ready(f"http://127.0.0.1:{port}/health", underclerk)
        run_journey(args.cli, run_id, f"http://127.0.0.1:{port}", underclerk_name, scratch)
    finally:
        stop(underclerk)
        shutil.rmtree(scratch, ignore_errors=True)


def run_journey(
    cli: Path, run_id: str, underclerk: str, underclerk_name: str, scratch: Path
) -> None:
    checks = Checks()
    env = {**os.environ, "UNDERCLERK_BASE_URL": underclerk}
    node_script("seed-local-commerce.ts", [], env)
    node_script(
        "seed-local-commerce.ts",
        ["--other-cafe", "organisation_order_page_patisserie", PATISSERIE],
        env,
    )
    patisserie_menu = json.loads(
        node_script("configure-patisserie-menu.ts", ["--merchant", PATISSERIE], env)
    )

    def set_name(merchant: str, name: str) -> dict:
        return json.loads(node_script("set-shop-name.ts", ["--merchant", merchant, "--name", name], env))

    # Names: each shop takes one; the second shop cannot take the first
    # shop's name, a reserved name or a name of the wrong form. The café then
    # takes a new name and keeps its first one.
    first = set_name(CAFE, "nuki")
    checks.check("the café takes the name nuki", first.get("outcome") == "set", first)
    taken = set_name(PATISSERIE, "nuki")
    checks.check(
        "the second shop cannot take the café's name",
        taken == {"schemaVersion": "underclerk.storefront-shop-name-change.v1", "outcome": "refused", "reason": "taken"},
        taken,
    )
    for name, reason in (("www", "reserved"), ("Nuki", "invalid"), ("xn--nuki", "invalid")):
        refused = set_name(PATISSERIE, name)
        checks.check(f"the name {name} is refused as {reason}", refused.get("reason") == reason, refused)
    second = set_name(PATISSERIE, "petit-four")
    checks.check("the second shop takes the name petit-four", second.get("outcome") == "set", second)
    renamed = set_name(CAFE, "nuki-cafe")
    checks.check(
        "the café takes nuki-cafe and keeps nuki as an earlier name",
        renamed.get("outcome") == "set"
        and renamed["shopName"]["name"] == "nuki-cafe"
        and renamed["shopName"]["previousNames"] == ["nuki"],
        renamed,
    )
    still_taken = set_name(PATISSERIE, "nuki")
    checks.check(
        "an earlier name stays with its shop",
        still_taken.get("reason") == "taken",
        still_taken,
    )

    # The storefront as the shop Worker serves it, with Underclerk through
    # the dev registry under this run's own name.
    subprocess.run(
        ["pnpm", "exec", "vite", "build", "--outDir", str(scratch / "dist")],
        cwd=STOREFRONT,
        check=True,
        capture_output=True,
    )
    config = scratch / "shop-wrangler.json"
    config.write_text(
        json.dumps(
            {
                "name": f"seams-shop-journey-{run_id}",
                "main": str(STOREFRONT / "worker/index.ts"),
                "compatibility_date": "2026-07-07",
                "assets": {
                    "directory": str(scratch / "dist"),
                    "binding": "ASSETS",
                    "not_found_handling": "single-page-application",
                    "run_worker_first": True,
                },
                "vars": {"MENU_HOST_SUFFIX": SUFFIX},
                "services": [{"binding": "UNDERCLERK", "service": underclerk_name}],
            }
        )
    )
    shop_port = free_port()
    shop = subprocess.Popen(
        [
            "pnpm", "exec", "wrangler", "dev", "--local",
            "--config", str(config),
            "--port", str(shop_port), "--inspector-port", str(free_port()),
            "--persist-to", str(scratch / "shop"),
        ],
        cwd=UNDERCLERK,
        start_new_session=True,
        stdout=(scratch / "shop.log").open("w"),
        stderr=subprocess.STDOUT,
    )
    session = "order-page-" + run_id
    opened = False
    try:
        wait_ready(f"http://127.0.0.1:{shop_port}/health", shop, f"nuki-cafe.{SUFFIX}")
        http_checks(checks, shop_port)
        cafe_site = f"http://nuki-cafe.{SUFFIX}:{shop_port}/"
        patisserie_site = f"http://petit-four.{SUFFIX}:{shop_port}/"
        run_cli(cli, session, ["open", cafe_site], "open")
        opened = True
        journey = (ROOT / "scripts/plan-40b/order-page-journey.js").read_text()
        journey = journey.strip().removesuffix(";")
        journey = journey.replace("JOURNEY_CAFE_SITE", json.dumps(cafe_site))
        journey = journey.replace("JOURNEY_PATISSERIE_SITE", json.dumps(patisserie_site))
        journey = journey.replace("JOURNEY_ARTIFACTS", json.dumps(str(ARTIFACTS)))
        output = run_cli(cli, session, ["run-code", journey], "journey")
        browser = result_json(output)
        if browser.get("result") != "passed":
            raise RuntimeError("The browser journey did not pass")
        evidence = {
            "backend": "local Underclerk Worker with its own storage",
            "site": "the shop Worker under wrangler dev, order page domain menu.localhost",
            "shops": {
                "nuki-cafe": CAFE,
                "petit-four": PATISSERIE,
            },
            "patisserieMenu": patisserie_menu,
            "checks": checks.items,
            "browser": browser,
        }
        (ARTIFACTS / "order-page-results.json").write_text(
            json.dumps(evidence, indent=2, ensure_ascii=False) + "\n"
        )
        print(json.dumps({"result": "passed", "checks": len(checks.items), "browserChecks": len(browser["checks"])}, indent=2))
    except Exception:
        log = scratch / "shop.log"
        if log.exists():
            print(log.read_text()[-3000:])
        raise
    finally:
        try:
            if opened:
                run_cli(cli, session, ["close"], "close")
        finally:
            stop(shop)


def http_checks(checks: Checks, port: int) -> None:
    status, _, body = get(port, f"nuki-cafe.{SUFFIX}", "/")
    meta = shop_meta(body)
    checks.check(
        "nuki-cafe opens the café's storefront",
        status == 200 and meta == {"name": "nuki-cafe", "merchantId": CAFE, "storefrontId": STOREFRONT_ID},
        {"status": status, "meta": meta},
    )
    status, _, body = get(port, f"petit-four.{SUFFIX}", "/shops/" + CAFE)
    meta = shop_meta(body)
    checks.check(
        "petit-four opens the second shop, also on a path that names the café",
        status == 200 and meta == {"name": "petit-four", "merchantId": PATISSERIE, "storefrontId": STOREFRONT_ID},
        {"status": status, "meta": meta},
    )
    status, headers, _ = get(port, f"nuki.{SUFFIX}", "/?table=4")
    checks.check(
        "the earlier name nuki moves to nuki-cafe and keeps the path",
        status == 301 and headers.get("location", "").startswith(f"http://nuki-cafe.{SUFFIX}") and headers.get("location", "").endswith("/?table=4"),
        {"status": status, "location": headers.get("location")},
    )
    for host in (f"nobody.{SUFFIX}", f"www.{SUFFIX}", f"a.b.{SUFFIX}"):
        status, headers, body = get(port, host, "/")
        checks.check(
            f"{host} answers 404 with no shop",
            status == 404 and shop_meta(body) is None and "No shop at this address" in body,
            {"status": status},
        )
    own = f"/v1/public/merchants/{PATISSERIE}/storefronts/{STOREFRONT_ID}/catalog"
    status, _, _ = get(port, f"petit-four.{SUFFIX}", own)
    checks.check(
        "an order page passes its own storefront's routes to Underclerk",
        status == 401,
        {"status": status, "detail": "401: a catalog read needs a buyer session"},
    )
    for path in (
        f"/v1/public/merchants/{CAFE}/storefronts/{STOREFRONT_ID}/catalog",
        f"/v1/public/merchants/{CAFE}/storefronts/{STOREFRONT_ID}/sessions",
        f"/v1/admin/merchants/{PATISSERIE}/storefronts/{STOREFRONT_ID}/shop-name",
        "/v1/public/shop-names/nuki-cafe",
        f"/v1/public/merchants/{PATISSERIE}/storefronts/storefront_cookie_store_sg/catalog",
    ):
        status, _, body = get(port, f"petit-four.{SUFFIX}", path)
        checks.check(
            f"petit-four refuses {path}",
            status == 404 and "Route not found" in body,
            {"status": status, "body": body[:200]},
        )


if __name__ == "__main__":
    main()
