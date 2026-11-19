#!/usr/bin/env python3
"""Starts the voice journey's services for Safari on the iPhone simulator (Plan 82).

The services are those of run-portal-journey.py, with the real shop Mac service and Whisper. This
script enrolls the Mac, starts the simulator and opens the chat page. It then waits, because a real
tap is the only user gesture that Safari accepts. The steps run through /__probe/run on the page.
Create the file that SHOP_VOICE_STOP_FILE names to stop.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("shop_voice_journey", ROOT / "scripts/shop-voice/run-journey.py")
journey = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journey)

PLATFORM = journey.PLATFORM
PORTAL = "http://127.0.0.1:3191"
ARTIFACTS = journey.ARTIFACTS
SIMULATOR = os.environ.get("SHOP_VOICE_SIMULATOR", "iPhone 17")


def single_database_schema_file():
    """The one-database schema, built from the two deployed baselines."""
    out = Path(tempfile.mkdtemp(prefix="satyr-single-database-")) / "schema.sql"
    subprocess.run(
        ["node", str(ROOT / "services/platform/scripts/single-database-schema.mjs"), str(out)],
        check=True,
    )
    return out


def main() -> None:
    if not os.environ.get("PANTRY_ACCOUNT_WORKER_ARTIFACT"):
        raise SystemExit("Set PANTRY_ACCOUNT_WORKER_ARTIFACT to the built shared account Worker.")
    stop_file = Path(os.environ["SHOP_VOICE_STOP_FILE"])
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="shop-voice-safari-")).resolve()
    voice_home = work / "home"
    label = f"sh.seams.satyr.shop-voice.journey-{uuid.uuid4().hex[:8]}"
    domain_job = f"gui/{os.getuid()}/{label}"
    plist = Path.home() / "Library/LaunchAgents" / f"{label}.plist"
    mirror = journey.Mirror(("127.0.0.1", journey.MIRROR_PORT), journey.MirrorHandler)
    mirror.served_bad_config = True
    mirror.broke_weights = True
    threading.Thread(target=mirror.serve_forever, daemon=True).start()
    backend = None
    portal = None
    try:
        ca = work / "ca"
        ca.mkdir()
        subprocess.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
                        "-subj", "/CN=Shop voice journey", "-days", "2", "-keyout", str(ca / "ca.key"), "-out", str(ca / "ca.pem")],
                       check=True, capture_output=True)
        config = ROOT / "scripts/shop-voice/wrangler.jsonc"
        persistence = work / "worker"
        wrangler = ["pnpm", "--filter", "@seams/platform", "exec", "wrangler"]
        with (ARTIFACTS / "safari-schema.log").open("w") as log:
            subprocess.run([*wrangler, "d1", "execute", "DB", "--config", str(config), "--local", "--persist-to", str(persistence),
                            "--file", str(single_database_schema_file())],
                           cwd=ROOT, check=True, stdout=log, stderr=subprocess.STDOUT)
            for name in ("checkpoint-root", "vault-root"):
                subprocess.run([*wrangler, "secrets-store", "secret", "create", "browser-fixture", "--config", str(config),
                                "--persist-to", str(persistence), "--name", name, "--scopes", "workers",
                                "--value", "ERERERERERERERERERERERERERERERERERERERERERE="],
                               cwd=ROOT, check=True, stdout=log, stderr=subprocess.STDOUT)
        with (ARTIFACTS / "safari-worker.log").open("w") as log:
            backend = subprocess.Popen(["node", str(ROOT / "scripts/shop-voice/provider.mjs"), str(config), str(persistence)],
                                       env={**os.environ, "SHOP_VOICE_PUBLIC_ORIGIN": PORTAL},
                                       cwd=ROOT, start_new_session=True, stdout=log, stderr=subprocess.STDOUT)
        with (ARTIFACTS / "safari-vite.log").open("w") as log:
            portal = subprocess.Popen(["pnpm", "--filter", "@seams/portal", "exec", "vite", "--config",
                                       str(ROOT / "scripts/shop-voice/vite.config.ts")],
                                      env={**os.environ, "SHOP_VOICE_SAFARI": "1"},
                                      cwd=ROOT, start_new_session=True, stdout=log, stderr=subprocess.STDOUT)

        def up(url: str) -> bool:
            try:
                urllib.request.urlopen(url, timeout=1)
                return True
            except OSError:
                return False

        journey.wait_for("the Worker", lambda: up(f"{PLATFORM}/test/health"), 90)
        journey.wait_for("the Portal", lambda: up(f"{PORTAL}/portal"), 60)
        with urllib.request.urlopen(urllib.request.Request(f"{PLATFORM}/test/setup", method="POST")) as response:
            setup = json.load(response)
        organisation_id = setup["organisationId"]
        owner = journey.Member("Owner", organisation_id)

        def call(method: str, route: str, body: dict | None = None) -> dict:
            headers = {"cookie": owner.cookie, "origin": PORTAL}
            if method != "GET":
                headers.update({"content-type": "application/json", "x-satyr-csrf": owner.csrf,
                                "idempotency-key": f"journey-{uuid.uuid4()}"})
            request = urllib.request.Request(f"{PORTAL}/v1/control/organisations/{organisation_id}/{route}", method=method,
                                             headers=headers, data=None if body is None else json.dumps(body).encode())
            with urllib.request.urlopen(request) as response:
                return json.load(response)

        start = call("POST", "voice/macs", {})
        flags = ["--port", str(journey.MAC_PORT), "--journey-heartbeat-seconds", "5", "--journey-idle-unload-seconds", "1800",
                 "--journey-model-base-url", f"http://127.0.0.1:{journey.MIRROR_PORT}/model",
                 "--journey-certificate-command", f"{ROOT / 'scripts/shop-voice/issue-certificate.sh'} {ca}"]
        command = (f"curl -fsSL {PORTAL}/shop-voice/install.sh | sh -s -- --origin {PORTAL} --organisation {organisation_id} "
                   f"--mac {start['macId']} --code={start['code']} --accept-letsencrypt-terms "
                   + " ".join(f"'{flag}'" for flag in flags))
        env = {**os.environ, "PANTRY_VOICE_HOME": str(voice_home), "PANTRY_VOICE_LABEL": label}
        subprocess.run(command, shell=True, check=True, env=env, cwd=ROOT, timeout=400,
                       stdout=(ARTIFACTS / "safari-install.log").open("w"), stderr=subprocess.STDOUT)
        journey.wait_for("the model download", lambda: call("GET", "voice/macs")["macs"][0]["modelState"] == "unloaded", 300)

        # The model loads on a member's check. It takes 16 s the first time.
        grant = call("POST", "voice/grants", {"deviceId": "journeyprewarm0000"})["mac"]
        trust = ssl.create_default_context(cafile=str(ca / "ca.pem"))

        def loaded() -> bool:
            request = urllib.request.Request(f"https://localhost:{journey.MAC_PORT}/health",
                                             headers={"authorization": f"Bearer {grant['grant']}", "origin": PORTAL})
            with urllib.request.urlopen(request, context=trust, timeout=5) as response:
                return json.load(response)["modelState"] == "loaded"

        journey.wait_for("the model load", loaded, 120)

        subprocess.run(["xcrun", "simctl", "boot", SIMULATOR], capture_output=True)
        subprocess.run(["xcrun", "simctl", "bootstatus", SIMULATOR, "-b"], check=True, capture_output=True, timeout=180)
        subprocess.run(["xcrun", "simctl", "keychain", SIMULATOR, "add-root-cert", str(ca / "ca.pem")], check=True)
        urllib.request.urlopen(urllib.request.Request(f"{PORTAL}/__probe/cookies", method="POST",
                                                      data=json.dumps(owner.cookie.split("; ")).encode()))
        chat = "/portal/satyr-kitchen-acceptance/cafe-operations/chat"
        subprocess.run(["xcrun", "simctl", "openurl", SIMULATOR, f"{PORTAL}/__probe/open?to={urllib.parse.quote(chat, safe='')}"],
                       check=True)
        print(json.dumps({"ready": True, "organisationId": organisation_id, "csrf": owner.csrf, "chat": chat}), flush=True)
        while not stop_file.exists():
            time.sleep(1)
        python = voice_home / "venv/bin/python"
        subprocess.run([str(python), "-m", "shop_voice", "uninstall"], env={**env, "PYTHONPATH": str(voice_home / "app")},
                       check=True, capture_output=True)
    finally:
        subprocess.run(["launchctl", "bootout", domain_job], capture_output=True)
        plist.unlink(missing_ok=True)
        log = voice_home / "service.log"
        if log.exists():
            shutil.copy(log, ARTIFACTS / "safari-service.log")
        mirror.shutdown()
        if portal is not None:
            journey.stop(portal)
        if backend is not None:
            journey.stop(backend)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
