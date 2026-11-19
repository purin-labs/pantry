#!/usr/bin/env python3
"""The real shop gateway against a local Platform (Plan 85).

This journey runs the install command that the Portal shows, with the real binary and the
real routes. The simulated devices come from a file. The gateway enrolls, reports what it
found, sends samples and a fault, answers a pause, reconnects after a kill, and stops for
good when an owner revokes it. It writes output/shop-gateway/result.json.

Needs PANTRY_ACCOUNT_WORKER_ARTIFACT and free ports 8893 and 8894.
"""
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "output/shop-gateway"
PORT = 8893
PLATFORM = f"http://127.0.0.1:{PORT}"
SIMULATION = ROOT / "scripts/shop-gateway/simulation.json"
RESULT: dict = {"steps": []}


def single_database_schema_file():
    """The one-database schema, built from the two deployed baselines."""
    out = Path(tempfile.mkdtemp(prefix="satyr-single-database-")) / "schema.sql"
    subprocess.run(
        ["node", str(ROOT / "services/platform/scripts/single-database-schema.mjs"), str(out)],
        check=True,
    )
    return out


def step(name: str, **facts) -> None:
    RESULT["steps"].append({"step": name, **facts})
    print(f"ok  {name} {facts if facts else ''}", flush=True)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"FAILED: {message}")


def wait_for(what: str, check, seconds: float, every: float = 0.5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(every)
    raise SystemExit(f"FAILED: timed out waiting for {what}")


class Member:
    """A signed-in person, who calls the Platform as the Portal does."""

    def __init__(self, name: str, organisation_id: str) -> None:
        self.organisation_id = organisation_id
        request = urllib.request.Request(f"{PLATFORM}/test/session?user={name}", method="POST")
        with urllib.request.urlopen(request) as response:
            cookies = [header.split(";")[0] for header in response.headers.get_all("set-cookie")]
        self.cookie = "; ".join(cookies)
        self.csrf = next(c.split("=", 1)[1] for c in cookies if c.startswith("satyr_control_csrf="))

    def call(self, method: str, route: str, body: dict | None = None) -> tuple[int, dict]:
        headers = {"cookie": self.cookie, "origin": PLATFORM}
        if method != "GET":
            headers.update({"content-type": "application/json", "x-satyr-csrf": self.csrf,
                            "idempotency-key": f"journey-{uuid.uuid4()}"})
        request = urllib.request.Request(f"{PLATFORM}/v1/control/organisations/{self.organisation_id}/{route}",
                                         method=method, headers=headers,
                                         data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)


def main() -> None:
    if not os.environ.get("PANTRY_ACCOUNT_WORKER_ARTIFACT"):
        raise SystemExit("Set PANTRY_ACCOUNT_WORKER_ARTIFACT to the built shared account Worker.")
    shutil.rmtree(ARTIFACTS, ignore_errors=True)
    ARTIFACTS.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="shop-gateway-journey-")).resolve()
    gateway_home = work / "home"
    env = {**os.environ, "PANTRY_GATEWAY_HOME": str(gateway_home)}
    backend = None
    gateway = None
    try:
        # The binary for this computer, and the assets that the Worker serves.
        target = os.environ.get("CARGO_TARGET_DIR", str(ROOT / "target"))
        subprocess.run(["cargo", "build", "--release", "-p", "shop-gateway", "--target", "aarch64-apple-darwin"],
                       cwd=ROOT, check=True, capture_output=True)
        dist = ROOT / "services/shop-gateway/dist/aarch64-apple-darwin"
        dist.mkdir(parents=True, exist_ok=True)
        shutil.copy(Path(target) / "aarch64-apple-darwin/release/shop-gateway", dist / "shop-gateway")
        assets = ARTIFACTS / "assets"
        subprocess.run(["node", str(ROOT / "services/shop-gateway/pack.mjs"), str(assets / "shop-gateway")], check=True)
        (assets / "index.html").write_text("<!doctype html>")

        config = ROOT / "scripts/shop-gateway/wrangler.jsonc"
        persistence = work / "worker"
        wrangler = ["pnpm", "--filter", "@seams/platform", "exec", "wrangler"]
        with (ARTIFACTS / "schema.log").open("w") as log:
            subprocess.run([*wrangler, "d1", "execute", "DB", "--config", str(config), "--local", "--persist-to", str(persistence),
                            "--file", str(single_database_schema_file())],
                           cwd=ROOT, check=True, stdout=log, stderr=subprocess.STDOUT)
            for name in ("checkpoint-root", "vault-root"):
                subprocess.run([*wrangler, "secrets-store", "secret", "create", "browser-fixture", "--config", str(config),
                                "--persist-to", str(persistence), "--name", name, "--scopes", "workers",
                                "--value", "ERERERERERERERERERERERERERERERERERERERERERE="],
                               cwd=ROOT, check=True, stdout=log, stderr=subprocess.STDOUT)
        with (ARTIFACTS / "worker.log").open("w") as log:
            backend = subprocess.Popen(["node", str(ROOT / "scripts/shop-voice/provider.mjs"), str(config), str(persistence)],
                                       cwd=ROOT, start_new_session=True, stdout=log, stderr=subprocess.STDOUT,
                                       env={**os.environ, "SHOP_VOICE_PORT": str(PORT)})

        def worker_up() -> bool:
            require(backend.poll() is None, "The Worker exited. See worker.log.")
            try:
                urllib.request.urlopen(f"{PLATFORM}/test/health", timeout=1)
                return True
            except (urllib.error.URLError, TimeoutError):
                return False

        wait_for("the Worker", worker_up, 120)
        with urllib.request.urlopen(urllib.request.Request(f"{PLATFORM}/test/setup", method="POST")) as response:
            organisation_id = json.load(response)["organisationId"]
        owner = Member("Owner", organisation_id)

        def devices() -> list[dict]:
            status, body = owner.call("GET", "devices")
            require(status == 200, f"devices: {status} {body}")
            return body["devices"]

        def named(name: str) -> dict | None:
            return next((d for d in devices() if d["kind"] == "kitchen_device" and d["name"] == name), None)

        def start_gateway() -> subprocess.Popen:
            log = (ARTIFACTS / "gateway.log").open("a")
            return subprocess.Popen([str(gateway_home / "bin/shop-gateway"), "run", "--simulate", str(SIMULATION)],
                                    cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)

        # 1. An owner starts a gateway. The computer runs the command that the Portal shows.
        status, started = owner.call("POST", "devices/gateways", {"name": "Bakery gateway", "locationId": "Main shop"})
        require(status == 201, f"start: {status} {started}")
        gateway_id = started["gatewayId"]
        require(started["installCommand"].startswith(f"curl -fsSL {PLATFORM}/shop-gateway/install.sh | sh -s --"),
                started["installCommand"])
        begun = time.monotonic()
        install = subprocess.run(["sh", "-c", f"{started['installCommand']} --no-service"], env=env,
                                 capture_output=True, text=True, timeout=60)
        require(install.returncode == 0, f"install: {install.stdout} {install.stderr}")
        require("enrolled" in install.stdout, install.stdout)
        credential = gateway_home / "credential"
        require(oct(credential.stat().st_mode & 0o777) == "0o600", "The credential file is not private.")
        step("the install command enrolls the gateway", seconds=round(time.monotonic() - begun, 1))

        # 2. The same code cannot enroll twice.
        again = subprocess.run(["sh", "-c", f"{started['installCommand']} --no-service"], env=env,
                               capture_output=True, text=True, timeout=60)
        require(again.returncode != 0 and "refused" in again.stderr, f"second install: {again.stderr}")
        step("the one-time code works one time")

        # 3. The gateway connects and reports what it found. Both devices stay pending.
        gateway = start_gateway()
        wait_for("found devices", lambda: named("Tray cobot") and named("Oven"), 30)
        row = next(d for d in devices() if d["deviceId"] == gateway_id)
        require(row["connection"]["state"] == "connected", f"gateway: {row}")
        require(row["serviceVersion"] == "0.1.0", f"gateway: {row}")
        cobot = named("Tray cobot")
        require(cobot["enrollment"] == "pending" and cobot["readiness"]["reason"] == "pending", f"cobot: {cobot}")
        step("the gateway reports found devices, and they stay pending", found=3)

        # 4. An owner confirms them, and the cobot is ready.
        for device in (named("Tray cobot"), named("Oven"), named("Bench camera")):
            status, body = owner.call("POST", f"devices/{device['deviceId']}/confirm",
                                      {"name": device["name"], "stationId": "station_bakery"})
            require(status == 200, f"confirm: {status} {body}")
        cobot = wait_for("a ready cobot", lambda: (lambda d: d if d["readiness"]["kind"] == "ready" else None)(named("Tray cobot")), 20)
        step("a person confirms the devices", readiness=cobot["readiness"]["kind"])

        # 5. The simulated oven reports a fault, and it sends samples.
        oven = wait_for("the oven fault", lambda: (lambda d: d if d["health"] == "fault" else None)(named("Oven")), 30)
        require(oven["faultCode"] == "E07" and oven["readiness"] == {"kind": "blocked", "reason": "fault"}, f"oven: {oven}")
        status, activity = owner.call("GET", f"devices/{oven['deviceId']}/activity")
        require(status == 200 and activity["samples"], f"activity: {activity}")
        step("the oven reports a fault and samples", fault=oven["faultCode"], samples=len(activity["samples"]))

        # 5b. Snapshots stay off until an owner turns them on. Then the camera sends one.
        camera = named("Bench camera")
        require(camera["readiness"] == {"kind": "not_applicable"}, f"camera: {camera}")
        status, body = owner.call("POST", f"devices/{camera['deviceId']}/snapshot", {})
        require(status == 409 and body["error"] == "device_snapshots_off", f"off: {status} {body}")
        status, body = owner.call("PUT", "devices/camera-policy", {"enabled": True})
        require(status == 200, f"on: {status} {body}")
        status, body = owner.call("POST", f"devices/{camera['deviceId']}/snapshot", {})
        require(status == 202, f"snapshot: {status} {body}")

        def stored() -> list[dict]:
            _, read = owner.call("GET", f"devices/{camera['deviceId']}/snapshots")
            return read["snapshots"]

        taken = wait_for("the snapshot", stored, 20)
        step("the camera sends one snapshot only after an owner turns them on", snapshots=len(taken))

        # 6. A pause reaches the real gateway, and its answer goes on the record.
        status, body = owner.call("POST", f"devices/{cobot['deviceId']}/pause", {})
        require(status == 200, f"pause: {body}")

        def acknowledged() -> bool:
            _, read = owner.call("GET", f"devices/{cobot['deviceId']}/activity")
            return any(event["kind"] == "gateway_done" for event in read["events"])

        wait_for("the gateway's answer", acknowledged, 20)
        status, body = owner.call("POST", f"devices/{cobot['deviceId']}/resume", {})
        require(status == 200, f"resume: {body}")
        step("the gateway answers a pause")

        # 7. The gateway dies. Satyr cannot hear its devices, and it says unknown.
        gateway.kill()
        gateway.wait()
        lost = wait_for("an unknown cobot", lambda: (lambda d: d if d["connection"]["state"] == "unknown" else None)(named("Tray cobot")), 20)
        require(lost["readiness"] == {"kind": "blocked", "reason": "connection_lost"}, f"lost: {lost}")
        step("a killed gateway leaves its devices unknown")

        # 8. It starts again and connects with the same credential.
        gateway = start_gateway()
        wait_for("the reconnect", lambda: (lambda d: d if d["connection"]["state"] == "connected" else None)(named("Tray cobot")), 30)
        step("the gateway reconnects with its credential")

        # 9. An owner revokes it. The process stops for good, and a new start stops too.
        status, body = owner.call("POST", f"devices/{gateway_id}/revoke", {})
        require(status == 200, f"revoke: {body}")
        begun = time.monotonic()
        code = gateway.wait(timeout=15)
        seconds = round(time.monotonic() - begun, 1)
        require(code == 0, f"The gateway ended with {code}.")
        require(seconds < 5, f"The socket closed after {seconds} s.")
        gateway = None
        later = subprocess.run([str(gateway_home / "bin/shop-gateway"), "run"], env=env,
                               capture_output=True, text=True, timeout=30)
        require(later.returncode == 0 and "ended this gateway" in later.stdout, f"restart: {later.stdout} {later.stderr}")
        row = next(d for d in devices() if d["deviceId"] == gateway_id)
        require(row["enrollment"] == "revoked", f"gateway: {row}")
        require(named("Tray cobot")["enrollment"] == "revoked", "The cobot kept its access.")
        step("a revoke stops the gateway for good", seconds=seconds)

        RESULT["outcome"] = "passed"
        (ARTIFACTS / "result.json").write_text(json.dumps(RESULT, indent=2))
        print("PASSED", flush=True)
    finally:
        if gateway is not None and gateway.poll() is None:
            gateway.kill()
        if backend is not None and backend.poll() is None:
            os.killpg(backend.pid, signal.SIGTERM)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
