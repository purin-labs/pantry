#!/usr/bin/env python3
"""The Portal voice journey (Plan 82 Phase 2).

Chrome's microphone input plays a file of speech from macOS, and the built Portal runs on a local
Worker with the Platform's real routes. The real wake phrase model, shop Mac service and Whisper
turn that speech into chat messages. With SHOP_VOICE_ENGINE=qwen3-asr-1.7b, the manager chooses Qwen3-ASR
in the dialog after the install, and the scenes run on it. The stand-ins that only record or answer are the Cloudflare DNS
API, Workers AI, the model provider, the model's download host and the certificate authority.
The full Portal runs from source, with the real Access routes.
The results go to output/shop-voice/portal-journey-results.json.
"""
import importlib.util
import json
import os
from array import array
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid
import wave

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("shop_voice_journey", ROOT / "scripts/shop-voice/run-journey.py")
journey = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journey)

PLATFORM = journey.PLATFORM
PORTAL = "http://127.0.0.1:3191"
ARTIFACTS = journey.ARTIFACTS
SAMPLE_RATE = 16_000
WAKE = ("Tessa", "hey, sayter")
# Seconds from the start of the microphone stream, and the words after the wake phrase.
SCENES = (
    (8, "Put two trays of kouign amann in the second oven."),
    (15, "Also check the butter in the walk in fridge."),
    (36, "Bake the financiers at one hundred eighty degrees."),
    (42, "Change that to one hundred seventy degrees."),
    (56, "Proof the croissants for two hours."),
    (62, "Cancel."),
    (72, None),  # The wake phrase, and then no speech.
    (92, "Label the second tray."),
)
OTHER_TALK = (84, "See you later, the oven is hot.")
LENGTH_SECONDS = 110


def single_database_schema_file():
    """The one-database schema, built from the two deployed baselines."""
    out = Path(tempfile.mkdtemp(prefix="satyr-single-database-")) / "schema.sql"
    subprocess.run(
        ["node", str(ROOT / "services/platform/scripts/single-database-schema.mjs"), str(out)],
        check=True,
    )
    return out


def say(voice: str, text: str, folder: Path) -> array:
    path = folder / f"{uuid.uuid4().hex}.wav"
    subprocess.run(["say", "-v", voice, "-o", str(path), "--data-format=LEI16@16000", text], check=True, timeout=60)
    with wave.open(str(path)) as file:
        samples = array("h", file.readframes(file.getnframes()))
    path.unlink()
    return samples


def microphone_file(folder: Path) -> Path:
    stream = array("h", bytes(2 * SAMPLE_RATE * LENGTH_SECONDS))

    def place(at: float, samples: array) -> int:
        start = int(at * SAMPLE_RATE)
        stream[start:start + len(samples)] = samples
        return start + len(samples)

    for at, words in SCENES:
        end = place(at, say(*WAKE, folder))
        if words is not None:
            place(end / SAMPLE_RATE + 0.25, say("Samantha", words, folder))
    place(OTHER_TALK[0], say("Daniel", OTHER_TALK[1], folder))
    path = folder / "microphone.wav"
    with wave.open(str(path), "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(SAMPLE_RATE)
        file.writeframes(stream.tobytes())
    return path


def portal_up() -> bool:
    try:
        urllib.request.urlopen(f"{PORTAL}/portal", timeout=1)
        return True
    except OSError:
        return False


def main() -> None:
    if not os.environ.get("PANTRY_ACCOUNT_WORKER_ARTIFACT"):
        raise SystemExit("Set PANTRY_ACCOUNT_WORKER_ARTIFACT to the built shared account Worker.")
    # Playwright 1.55 holds audioWorklet.addModule forever. 1.64.1 does not.
    if not os.environ.get("PLAYWRIGHT_MODULE"):
        raise SystemExit("Set PLAYWRIGHT_MODULE to a Playwright 1.64.1 or later package folder.")
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="shop-voice-portal-")).resolve()
    voice_home = work / "home"
    label = f"sh.seams.satyr.shop-voice.journey-{uuid.uuid4().hex[:8]}"
    domain_job = f"gui/{os.getuid()}/{label}"
    plist = Path.home() / "Library/LaunchAgents" / f"{label}.plist"
    mirror = journey.Mirror(("127.0.0.1", journey.MIRROR_PORT), journey.MirrorHandler)
    mirror.served_bad_config = True
    mirror.broken = set(journey.SNAPSHOTS)
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
        wrangler = ["pnpm", "--filter", "@purin-labs/platform", "exec", "wrangler"]
        with (ARTIFACTS / "portal-schema.log").open("w") as log:
            subprocess.run([*wrangler, "d1", "execute", "DB", "--config", str(config), "--local", "--persist-to", str(persistence),
                            "--file", str(single_database_schema_file())],
                           cwd=ROOT, check=True, stdout=log, stderr=subprocess.STDOUT)
            for name in ("checkpoint-root", "vault-root"):
                subprocess.run([*wrangler, "secrets-store", "secret", "create", "browser-fixture", "--config", str(config),
                                "--persist-to", str(persistence), "--name", name, "--scopes", "workers",
                                "--value", "ERERERERERERERERERERERERERERERERERERERERERE="],
                               cwd=ROOT, check=True, stdout=log, stderr=subprocess.STDOUT)
        with (ARTIFACTS / "portal-worker.log").open("w") as log:
            backend = subprocess.Popen(["node", str(ROOT / "scripts/shop-voice/provider.mjs"), str(config), str(persistence)],
                                       env={**os.environ, "SHOP_VOICE_PUBLIC_ORIGIN": PORTAL},
                                       cwd=ROOT, start_new_session=True, stdout=log, stderr=subprocess.STDOUT)
        with (ARTIFACTS / "portal-vite.log").open("w") as log:
            portal = subprocess.Popen(["pnpm", "--filter", "@purin-labs/portal", "exec", "vite", "--config",
                                       str(ROOT / "scripts/shop-voice/vite.config.ts")],
                                      cwd=ROOT, start_new_session=True, stdout=log, stderr=subprocess.STDOUT)

        def worker_up() -> bool:
            journey.require(backend.poll() is None, "The Worker exited. See portal-worker.log.")
            try:
                urllib.request.urlopen(f"{PLATFORM}/test/health", timeout=1)
                return True
            except OSError:
                return False

        journey.wait_for("the Worker", worker_up, 90)
        journey.wait_for("the Portal", lambda: portal_up(), 60)
        with urllib.request.urlopen(urllib.request.Request(f"{PLATFORM}/test/setup", method="POST")) as response:
            setup = json.load(response)
        organisation_id = setup["organisationId"]
        owner = journey.Member("Owner", organisation_id)
        microphone = microphone_file(work)
        env = {**os.environ, "PANTRY_VOICE_HOME": str(voice_home), "PANTRY_VOICE_LABEL": label}
        browser_input = {
            "platform": PORTAL, "worker": PLATFORM, "organisationId": organisation_id, "ownerId": setup["users"]["Owner"],
            "cookie": owner.cookie, "csrf": owner.csrf,
            "builtWorker": "/assets/" + next((ROOT / "apps/portal/dist/assets").glob("wake-worker-*.js")).name,
            "microphone": str(microphone), "artifacts": str(ARTIFACTS), "macPort": journey.MAC_PORT,
            "scenes": [list(scene) for scene in SCENES],
            # SHOP_VOICE_ENGINE runs the scenes on another engine, which the manager chooses (Plan 82C).
            "engine": os.environ.get("SHOP_VOICE_ENGINE", journey.ENGINE.id),
            "installFlags": ["--port", str(journey.MAC_PORT), "--journey-heartbeat-seconds", "5",
                             "--journey-idle-unload-seconds", "1800",
                             "--journey-model-base-url", f"http://127.0.0.1:{journey.MIRROR_PORT}/model",
                             "--journey-certificate-command", f"{ROOT / 'scripts/shop-voice/issue-certificate.sh'} {ca}"],
        }
        result = subprocess.run(["node", str(ROOT / "scripts/shop-voice/portal-browser.cjs"), json.dumps(browser_input)],
                                env=env, cwd=ROOT, timeout=900)
        journey.require(result.returncode == 0, "The browser journey failed.")
        python = voice_home / "venv/bin/python"
        subprocess.run([str(python), "-m", "shop_voice", "uninstall"], env={**env, "PYTHONPATH": str(voice_home / "app")}, check=True,
                       capture_output=True)
        journey.require(not voice_home.exists() and not plist.exists(), "The uninstall left files.")
    finally:
        subprocess.run(["launchctl", "bootout", domain_job], capture_output=True)
        plist.unlink(missing_ok=True)
        log = voice_home / "service.log"
        if log.exists():
            shutil.copy(log, ARTIFACTS / "portal-service.log")
        mirror.shutdown()
        if portal is not None:
            journey.stop(portal)
        if backend is not None:
            journey.stop(backend)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
