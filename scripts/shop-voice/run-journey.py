#!/usr/bin/env python3
"""The shop Mac journey (Plan 82 Phase 1B). It runs real parts from end to end:

- the Platform's real routes on a local Worker with its own D1, and the real account Worker,
- the real install script, launchd job, Python packages, Whisper and Qwen3-ASR with MLX on this Mac,
- real speech from macOS, sent over real TLS with the grants that the Platform signs.

Three outside services are stand-ins: the Cloudflare DNS API, the model's download host and the
certificate authority. They only record or answer calls. The Portal's calls are made here.
The results go to output/shop-voice/journey-results.json.
"""
import base64
import hashlib
import hmac
import http.client
import http.server
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import ssl
import statistics
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import sys
import uuid
import wave

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/shop-voice"))
from shop_voice.engines import DEFAULT_ENGINE, ENGINES  # noqa: E402

ARTIFACTS = ROOT / "output/shop-voice"
PLATFORM = "http://127.0.0.1:8891"
MIRROR_PORT = 18444
MAC_PORT = 18443
HEARTBEAT_SECONDS = 5
IDLE_UNLOAD_SECONDS = 40
# The speech bench whose Hugging Face cache holds each engine's files. SHOP_VOICE_BENCH names it when
# the repositories are not at their old paths.
BENCH = Path(
    os.environ.get("SHOP_VOICE_BENCH")
    or Path.home() / "Dev/rust/seams-monorepo/.claude/worktrees/voiceid-stt-bench/voiceId/stt-bench"
)
# The engine that a new Mac downloads, and the one that a manager chooses later (Plan 82C). Each engine's
# files come from its own module.
ENGINE = ENGINES[DEFAULT_ENGINE]
OTHER_ENGINE = ENGINES["qwen3-asr-1.7b"]


def snapshot(engine) -> Path:
    repository = engine.files.base_url.removeprefix("https://huggingface.co/").removesuffix("/resolve")
    return BENCH / f".cache/hf/models--{repository.replace('/', '--')}/snapshots/{engine.files.revision}"


def largest_file(engine) -> str:
    return max(engine.files.files, key=lambda file: file[1])[0]


# The mirror serves each engine's files by revision, and breaks the download of each largest file once, so
# the service must resume it.
SNAPSHOTS = {engine.files.revision: snapshot(engine) for engine in ENGINES.values()}
LARGEST_FILES = {engine.files.revision: largest_file(engine) for engine in ENGINES.values()}
LARGEST_FILE = largest_file(ENGINE)
PHRASE = "Put two trays of kouign amann in the second oven"
OTHER_PHRASE = "The butter needs ten more minutes"
ANSWER = "The second chiller holds the butter for ten more minutes. Move it to the mixer at seven."
results: dict = {"steps": []}


def single_database_schema_file():
    """The one-database schema, built from the two deployed baselines."""
    out = Path(tempfile.mkdtemp(prefix="satyr-single-database-")) / "schema.sql"
    subprocess.run(
        ["node", str(ROOT / "services/platform/scripts/single-database-schema.mjs"), str(out)],
        check=True,
    )
    return out


def step(name: str, **facts) -> None:
    results["steps"].append({"step": name, **facts})
    print(f"PASS {name} {json.dumps(facts) if facts else ''}", flush=True)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def wait_for(what: str, check, seconds: float, every: float = 0.5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(every)
    raise AssertionError(f"Timed out: {what}")


class Mirror(http.server.ThreadingHTTPServer):
    """The model's download host. Its first answers are bad, as a real network can be."""

    daemon_threads = True
    requests_seen: list[dict] = []
    served_bad_config = False
    broken: set[str] = set()


class MirrorHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *values) -> None:
        pass

    def do_GET(self) -> None:
        revision, name = self.path.rsplit("/", 2)[-2:]
        data_path = SNAPSHOTS[revision] / name
        byte_range = self.headers.get("Range")
        self.server.requests_seen.append({"revision": revision, "file": name, "range": byte_range})
        size = data_path.stat().st_size
        start = int(re.match(r"bytes=(\d+)-", byte_range)[1]) if byte_range else 0
        if name == "config.json" and not self.server.served_bad_config:
            self.server.served_bad_config = True
            self.send_response(200)
            self.send_header("Content-Length", str(size))
            self.end_headers()
            self.wfile.write(b"x" * size)
            return
        self.send_response(206 if byte_range else 200)
        self.send_header("Content-Length", str(size - start))
        self.end_headers()
        sent = 0
        with data_path.open("rb") as file:
            file.seek(start)
            while chunk := file.read(1 << 20):
                self.wfile.write(chunk)
                sent += len(chunk)
                if name == LARGEST_FILES[revision] and sent >= 64 << 20 and revision not in self.server.broken:
                    self.server.broken.add(revision)
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return


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

    def grant(self) -> dict:
        status, body = self.call("POST", "voice/grants", {"deviceId": uuid.uuid4().hex})
        require(status == 200 and body["mac"] is not None, f"grant: {status} {body}")
        return body["mac"]


class Mac:
    """The Portal's path to the Mac: the public name over real TLS, here on this machine."""

    def __init__(self, hostname: str, ca: Path) -> None:
        self.hostname = hostname
        self.context = ssl.create_default_context(cafile=str(ca))

    def call(self, method: str, path: str, grant: str | None, body: bytes | None = None,
             origin: str | None = PLATFORM) -> tuple[int, dict, dict]:
        raw = socket.create_connection(("127.0.0.1", MAC_PORT), timeout=60)
        secure = self.context.wrap_socket(raw, server_hostname=self.hostname)
        connection = http.client.HTTPConnection(self.hostname, MAC_PORT, timeout=60)
        connection.sock = secure
        headers = {"content-type": "audio/wav"} if body is not None else {}
        if grant is not None:
            headers["authorization"] = f"Bearer {grant}"
        if origin is not None:
            headers["origin"] = origin
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read()
            return response.status, json.loads(data) if data else {}, {k.lower(): v for k, v in response.getheaders()}
        finally:
            connection.close()


def speech(text: str, folder: Path) -> bytes:
    path = folder / f"{uuid.uuid4().hex}.wav"
    subprocess.run(["say", "-v", "Samantha", "-o", str(path), "--data-format=LEI16@16000", text], check=True, timeout=60)
    with wave.open(str(path)) as file:
        return file.readframes(file.getnframes())


def wav_file(pcm: bytes, rate: int = 16_000) -> bytes:
    size = len(pcm)
    return (b"RIFF" + (36 + size).to_bytes(4, "little") + b"WAVEfmt " + (16).to_bytes(4, "little")
            + (1).to_bytes(2, "little") + (1).to_bytes(2, "little") + rate.to_bytes(4, "little")
            + (rate * 2).to_bytes(4, "little") + (2).to_bytes(2, "little") + (16).to_bytes(2, "little")
            + b"data" + size.to_bytes(4, "little") + pcm)


def data_at_16k(data: bytes) -> bytes:
    """The Mac's voice at the rate that its Whisper route reads."""
    with wave.open(io.BytesIO(data)) as voice:
        rate = voice.getframerate()
        frames = voice.readframes(voice.getnframes())
    samples = [int.from_bytes(frames[at:at + 2], "little", signed=True) for at in range(0, len(frames), 2)]
    length = len(samples) * 16_000 // rate
    down = b"".join(samples[at * rate // 16_000].to_bytes(2, "little", signed=True) for at in range(length))
    return wav_file(down)


def sign(claims: dict, key: str) -> str:
    encode = lambda data: base64.urlsafe_b64encode(data).rstrip(b"=").decode()
    payload = encode(json.dumps(claims).encode())
    raw_key = base64.urlsafe_b64decode(key + "=" * (-len(key) % 4))
    return f"vg1.{payload}.{encode(hmac.new(raw_key, f'vg1.{payload}'.encode(), hashlib.sha256).digest())}"


def listening_pid() -> int | None:
    out = subprocess.run(["lsof", "-nP", f"-iTCP:{MAC_PORT}", "-sTCP:LISTEN", "-t"], capture_output=True, text=True).stdout.split()
    return int(out[0]) if out else None


def footprint_mb(pid: int) -> float:
    """The process's physical footprint, as macOS counts it for memory pressure. It holds MLX's GPU buffers
    and the pages that macOS compressed; the resident size of `ps` leaves those out when memory is short."""
    out = subprocess.check_output(["/usr/bin/footprint", "-p", str(pid)], text=True)
    value, unit = re.search(r"phys_footprint:\s+([\d.]+)\s+(KB|MB|GB)", out).groups()
    return round(float(value) * {"KB": 1 / 1024, "MB": 1, "GB": 1024}[unit], 1)


def stop(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def main() -> None:
    if not os.environ.get("PANTRY_ACCOUNT_WORKER_ARTIFACT"):
        raise SystemExit("Set PANTRY_ACCOUNT_WORKER_ARTIFACT to the built shared account Worker.")
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="shop-voice-journey-")).resolve()
    voice_home = work / "home"
    label = f"sh.seams.satyr.shop-voice.journey-{uuid.uuid4().hex[:8]}"
    env = {**os.environ, "PANTRY_VOICE_HOME": str(voice_home), "PANTRY_VOICE_LABEL": label}
    python = voice_home / "venv/bin/python"
    domain_job = f"gui/{os.getuid()}/{label}"
    plist = Path.home() / "Library/LaunchAgents" / f"{label}.plist"
    backend = None
    mirror = Mirror(("127.0.0.1", MIRROR_PORT), MirrorHandler)
    threading.Thread(target=mirror.serve_forever, daemon=True).start()
    try:
        ca = work / "ca"
        ca.mkdir()
        subprocess.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
                        "-subj", "/CN=Shop voice journey", "-days", "2", "-keyout", str(ca / "ca.key"), "-out", str(ca / "ca.pem")],
                       check=True, capture_output=True)
        config = ROOT / "scripts/shop-voice/wrangler.jsonc"
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
        worker_log = ARTIFACTS / "worker.log"
        with worker_log.open("w") as log:
            backend = subprocess.Popen(["node", str(ROOT / "scripts/shop-voice/provider.mjs"), str(config), str(persistence)],
                                       cwd=ROOT, start_new_session=True, stdout=log, stderr=subprocess.STDOUT)

        def worker_up() -> bool:
            require(backend.poll() is None, "The Worker exited. See worker.log.")
            try:
                urllib.request.urlopen(f"{PLATFORM}/test/health", timeout=1)
                return True
            except (urllib.error.URLError, TimeoutError):
                return False

        wait_for("the Worker", worker_up, 90)
        with urllib.request.urlopen(urllib.request.Request(f"{PLATFORM}/test/setup", method="POST")) as response:
            organisation_id = json.load(response)["organisationId"]
        owner = Member("Owner", organisation_id)
        other = Member("Other", organisation_id)

        def mac_view() -> dict:
            status, body = owner.call("GET", "voice/macs")
            require(status == 200, f"macs: {status} {body}")
            return body["macs"][0]

        def dns() -> dict:
            with urllib.request.urlopen(f"{PLATFORM}/test/dns") as response:
                return json.load(response)

        # A manager starts the enrollment, and the Mac runs the install command.
        status, started = owner.call("POST", "voice/macs")
        require(status == 201, f"enrollment: {status} {started}")
        installer = work / "install.sh"
        subprocess.run(["node", str(ROOT / "services/shop-voice/pack.mjs"), str(installer)], check=True)
        begun = time.monotonic()
        install = subprocess.run(
            ["sh", str(installer), "--origin", PLATFORM, "--organisation", started["organisationId"], "--mac", started["macId"],
             f"--code={started['code']}", "--accept-letsencrypt-terms", "--port", str(MAC_PORT),
             "--journey-heartbeat-seconds", str(HEARTBEAT_SECONDS), "--journey-idle-unload-seconds", str(IDLE_UNLOAD_SECONDS),
             "--journey-model-base-url", f"http://127.0.0.1:{MIRROR_PORT}/model",
             "--journey-certificate-command", f"{ROOT / 'scripts/shop-voice/issue-certificate.sh'} {ca}"],
            env=env, capture_output=True, text=True, timeout=900)
        require(install.returncode == 0, f"install: {install.stdout} {install.stderr}")
        # The journey's certificate authority takes certbot's place, so check that certbot runs.
        subprocess.run([str(voice_home / "venv/bin/certbot"), "--version"], check=True, capture_output=True)
        status_text = subprocess.run([str(python), "-m", "shop_voice", "status"], env={**env, "PYTHONPATH": str(voice_home / "app")},
                                     check=True, capture_output=True, text=True).stdout
        require("Enrolled: " in status_text and ".voice.shop-voice.test" in status_text, f"status: {status_text}")
        step("install", seconds=round(time.monotonic() - begun, 1))

        status = 0
        request = urllib.request.Request(f"{PLATFORM}/v1/voice-macs/enroll", method="POST",
                                         data=json.dumps({"organisationId": started["organisationId"], "macId": started["macId"],
                                                          "code": started["code"]}).encode(),
                                         headers={"content-type": "application/json"})
        try:
            urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            status = error.code
        require(status == 401, f"The one-time code worked twice: {status}")
        step("the one-time code works once")

        view = wait_for("the first heartbeat", lambda: (v := mac_view())["lastHeartbeatAt"] and v, 60)
        version = (ROOT / "services/shop-voice/shop_voice/__init__.py").read_text().split('"')[-2]
        require(view["state"] == "enrolled" and view["serviceVersion"] == version and view["engine"] == ENGINE.id,
                f"view: {view}")
        address = view["privateAddress"]
        records = dns()["records"]
        require(any(r["type"] == "A" and r["name"] == view["hostname"] and r["content"] == address and r["proxied"] is False
                    for r in records), f"DNS: {records}")
        require(any(w["record"] and w["record"]["type"] == "TXT" and w["method"] == "POST" for w in dns()["writes"]),
                "The certificate hook wrote no challenge record.")
        wait_for("the challenge record to go", lambda: not any(r["type"] == "TXT" for r in dns()["records"]), 30)
        step("heartbeat, DNS name and certificate challenge", hostname=view["hostname"], address=address)

        wait_for("the model files", lambda: mac_view()["modelState"] == "unloaded", 600, 2)
        ranges = [r["range"] for r in mirror.requests_seen if r["file"] == LARGEST_FILE and r["revision"] == ENGINE.files.revision]
        require(mirror.served_bad_config and sum(r["file"] == "config.json" for r in mirror.requests_seen) >= 2,
                "The service kept a bad file.")
        require(ENGINE.files.revision in mirror.broken and ranges[0] is None and ranges[-1] and int(ranges[-1][6:-1]) >= 64 << 20,
                f"The download did not resume: {ranges}")
        step("model download refuses a bad file and resumes", ranges=ranges)

        hostname = view["hostname"]
        mac = Mac(hostname, ca / "ca.pem")
        wait_for("the listener", listening_pid, 30)
        pid = listening_pid()
        before_load_mb = footprint_mb(pid)
        owner_grant = owner.grant()
        require(owner_grant["origin"] == f"https://{hostname}", f"grant origin: {owner_grant}")
        command = wav_file(speech(PHRASE, work))
        status, body, _ = mac.call("POST", "/transcriptions", owner_grant["grant"], command)
        require(status == 503 and body["error"] == "model_not_ready", f"before load: {status} {body}")
        owner_posts = 1
        require(mac_view()["modelState"] == "unloaded", "The model loaded with no check.")
        step("the model stays out of memory until a member checks", footprintMb=before_load_mb)

        status, _, headers = mac.call("OPTIONS", "/transcriptions", None)
        require(status == 204 and headers.get("access-control-allow-origin") == PLATFORM
                and headers.get("access-control-allow-private-network") == "true", f"preflight: {headers}")
        started_load = time.monotonic()

        def loaded() -> bool:
            status, body, headers = mac.call("GET", "/health", owner_grant["grant"])
            require(status == 200 and headers.get("access-control-allow-origin") == PLATFORM and body["engine"] == ENGINE.id,
                    f"health: {status} {body}")
            return body["modelState"] == "loaded"

        wait_for("the model load", loaded, 120)
        load_seconds = round(time.monotonic() - started_load, 1)
        loaded_mb = footprint_mb(pid)
        wait_for("the Platform to see the load", lambda: mac_view()["modelState"] == "loaded", 20)
        step("a member's check loads the model", seconds=load_seconds, footprintMb=loaded_mb)

        timings = []
        transcript = ""
        for _ in range(10):
            begun = time.monotonic()
            status, body, headers = mac.call("POST", "/transcriptions", owner_grant["grant"], command)
            timings.append(time.monotonic() - begun)
            owner_posts += 1
            require(status == 200 and body["engine"] == ENGINE.id, f"command: {status} {body}")
            transcript = body["text"]
            require(headers.get("access-control-allow-origin") == PLATFORM, "The answer has no CORS header.")
        lowered = transcript.lower()
        require("second oven" in lowered and "two trays" in lowered, f"Wrong transcript: {transcript}")
        require("Kouign-amann" in transcript, f"The vocabulary did not reach Whisper: {transcript}")
        require(body["audioSeconds"] > 1, f"audioSeconds: {body}")
        timings.sort()
        step("real speech over TLS gives the transcript, with the shop vocabulary", transcript=transcript,
             p50Ms=round(statistics.median(timings) * 1000), maxMs=round(timings[-1] * 1000))

        def speak(text: str) -> tuple[int, bytes, dict]:
            raw = socket.create_connection(("127.0.0.1", MAC_PORT), timeout=60)
            connection = http.client.HTTPConnection(mac.hostname, MAC_PORT, timeout=60)
            connection.sock = mac.context.wrap_socket(raw, server_hostname=mac.hostname)
            try:
                connection.request("POST", "/speech", body=json.dumps({"text": text}), headers={
                    "authorization": f"Bearer {owner_grant['grant']}", "origin": PLATFORM,
                    "content-type": "application/json"})
                response = connection.getresponse()
                return response.status, response.read(), {k.lower(): v for k, v in response.getheaders()}
            finally:
                connection.close()

        wait_for("the Mac's voice", lambda: speak("Ready.")[0] == 200, 300, 2)
        begun = time.monotonic()
        status, data, headers = speak(ANSWER)
        spoken_seconds = time.monotonic() - begun
        require(status == 200 and headers.get("content-type") == "audio/wav", f"speech: {status} {data[:100]}")
        require(headers.get("access-control-allow-origin") == PLATFORM, "The voice has no CORS header.")
        with wave.open(io.BytesIO(data)) as answer:
            answer_seconds = answer.getnframes() / answer.getframerate()
            samples = answer.readframes(answer.getnframes())
        require(answer_seconds > 3 and any(samples), f"The voice is {answer_seconds} s or silent.")
        # Whisper hears the words again, so the voice said the answer and not noise.
        status, body, _ = mac.call("POST", "/transcriptions", owner_grant["grant"], data_at_16k(data))
        spoken_back_posts = 1
        require(status == 200 and "chiller" in body["text"].lower(), f"The voice said: {body}")
        status, too_long, _ = speak("word " * 300)
        require(status == 413 and json.loads(too_long)["error"] == "too_long", f"long text: {status}")
        status, empty, _ = speak("  ")
        require(status == 400 and json.loads(empty)["error"] == "speech_invalid", f"empty text: {status}")
        status, body, _ = mac.call("POST", "/speech", owner_grant["grant"], b"{}", origin="https://evil.example")
        require(status == 403 and body["error"] == "origin_refused", f"origin: {body}")
        step("the Mac speaks an answer in af_heart, and Whisper hears the same words", answerSeconds=round(answer_seconds, 1),
             madeInSeconds=round(spoken_seconds, 2))

        status, body, headers = mac.call("POST", "/transcriptions", owner_grant["grant"], command, origin="https://other.example")
        require(status == 403 and body["error"] == "origin_refused" and "access-control-allow-origin" not in headers, f"origin: {body}")
        status, body, _ = mac.call("POST", "/transcriptions", owner_grant["grant"], command, origin=None)
        require(status == 403, f"no origin: {body}")
        status, body, _ = mac.call("GET", "/health", None)
        require(status == 401 and body["error"] == "grant_refused", f"no grant: {body}")
        status, _, _ = mac.call("GET", "/health", owner_grant["grant"][:-2] + "AA")
        require(status == 401, "A changed grant passed.")
        saved = json.loads((voice_home / "config.json").read_text())
        claims = {"version": 1, "organisationId": organisation_id, "userId": "journey", "deviceId": "journey",
                  "macId": saved["mac_id"], "expiresAt": int(time.time() * 1000) + 60_000}
        status, _, _ = mac.call("GET", "/health", sign({**claims, "expiresAt": int(time.time() * 1000) - 1}, saved["grant_key"]))
        require(status == 401, "An expired grant passed.")
        status, _, _ = mac.call("GET", "/health", sign({**claims, "macId": "vmac_" + "0" * 24}, saved["grant_key"]))
        require(status == 401, "A grant for another Mac passed.")
        status, _, _ = mac.call("GET", "/health", sign({**claims, "organisationId": "org_other"}, saved["grant_key"]))
        require(status == 401, "A grant for another Organisation passed.")
        status, _, _ = mac.call("GET", "/health", sign(claims, saved["grant_key"]))
        require(status == 200, "The journey's own check of a good signature failed.")
        status, body, _ = mac.call("POST", "/transcriptions", owner_grant["grant"], wav_file(b"\0\0" * 16_000 * 16))
        owner_posts += 1
        require(status == 413 and body["error"] == "too_long", f"too long: {body}")
        status, body, _ = mac.call("POST", "/transcriptions", owner_grant["grant"], b"not audio" * 10)
        owner_posts += 1
        require(status == 400 and body["error"] == "audio_invalid", f"not WAV: {body}")
        status, body, _ = mac.call("POST", "/transcriptions", owner_grant["grant"], wav_file(b"\0\0" * 8000, rate=8000))
        owner_posts += 1
        require(status == 400 and body["error"] == "audio_invalid", f"8 kHz: {body}")
        step("each refusal has its typed code")

        # Whisper's own value refuses one sentence said again and again, so these words differ.
        pcm = speech("Check how much butter is left, wipe the counter, sweep the floor, fill the sugar jars, count the "
                     "boxes, wash the mixing bowls, sharpen the knives, stack the crates, print the labels, restock the "
                     "ribbon, clean the display case, and write the delivery list for tomorrow morning.", work)
        long_command = wav_file(pcm[:16_000 * 2 * 15])
        replies = []

        def post_long() -> None:
            status, body, _ = mac.call("POST", "/transcriptions", owner_grant["grant"], long_command)
            replies.append((status, body))

        threads = [threading.Thread(target=post_long) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        owner_posts += 6
        answered = sum(status == 200 for status, _ in replies)
        busy = sum(status == 503 and body["error"] == "busy" for status, body in replies)
        require(answered + busy == 6 and busy >= 1 and answered >= 1, f"burst: {replies}")
        require(all("butter" in body["text"].lower() for status, body in replies if status == 200), f"burst text: {replies}")
        step("one command runs, two wait and the others hear busy", answered=answered, busy=busy)

        while True:
            status, body, _ = mac.call("POST", "/transcriptions", owner_grant["grant"], b"x")
            if status == 429:
                break
            owner_posts += 1
            require(owner_posts + spoken_back_posts <= 60, "The rate limit did not stop the member.")
        require(owner_posts + spoken_back_posts == 60 and body["error"] == "rate_limited", f"limit at {owner_posts}: {body}")
        other_grant = other.grant()
        status, body, _ = mac.call("POST", "/transcriptions", other_grant["grant"], command)
        require(status == 200 and "second oven" in body["text"].lower(), f"other member: {status} {body}")
        step("the limit of 60 is for each member")

        # A Mac from before 0.4.0 keeps the engine's files in the models' folder itself. The next start
        # moves them into the engine's folder, with no new download.
        engine_folder = voice_home / "model" / ENGINE.id
        for path in list(engine_folder.iterdir()):
            path.rename(voice_home / "model" / path.name)
        engine_folder.rmdir()
        downloads_before = len(mirror.requests_seen)
        os.kill(pid, signal.SIGKILL)
        new_pid = wait_for("launchd to restart the service", lambda: (p := listening_pid()) and p != pid and p, 60)
        status, body, _ = mac.call("GET", "/health", other_grant["grant"])
        require(status == 200 and body["modelState"] in ("loading", "unloaded"), f"after restart: {body}")

        def loaded_again() -> bool:
            status, body, _ = mac.call("GET", "/health", other_grant["grant"])
            return status == 200 and body["modelState"] == "loaded"

        started_load = time.monotonic()
        wait_for("the second load", loaded_again, 120)
        require(len(mirror.requests_seen) == downloads_before and (engine_folder / LARGEST_FILE).exists()
                and not (voice_home / "model" / LARGEST_FILE).exists(), "The old files did not move, or downloaded again.")
        step("launchd restarts a killed service, the grant still works, and the old layout moves with no download",
             loadSeconds=round(time.monotonic() - started_load, 1))

        loaded_at = time.monotonic()
        wait_for("the Platform to see the second load", lambda: mac_view()["modelState"] == "loaded", 20, 1)
        wait_for("the idle unload", lambda: mac_view()["modelState"] == "unloaded", IDLE_UNLOAD_SECONDS + 30, 2)
        require(time.monotonic() - loaded_at >= IDLE_UNLOAD_SECONDS - HEARTBEAT_SECONDS * 2, "The model unloaded too soon.")
        time.sleep(5)
        unloaded_mb = footprint_mb(new_pid)
        require(unloaded_mb < loaded_mb / 2, f"The unload freed too little: {unloaded_mb} of {loaded_mb} MB")
        cpu = float(subprocess.check_output(["ps", "-o", "%cpu=", "-p", str(new_pid)], text=True))
        step("the model unloads after the idle time", footprintMb=unloaded_mb, cpuPercent=cpu)

        # Plan 82C Phase 2: a manager chooses Qwen3-ASR. The Mac downloads it with its resume and SHA-256
        # check, answers with Whisper until the files are complete, and then changes engine.
        view = mac_view()
        require(sorted(view["engines"]) == sorted(ENGINES) and view["engineChoice"] == ENGINE.id, f"engines: {view}")
        wait_for("Whisper to load", loaded_again, 120)
        time.sleep(2)
        whisper_mb = footprint_mb(new_pid)
        other_folder = voice_home / "model" / OTHER_ENGINE.id
        status, body = owner.call("POST", f"voice/macs/{saved['mac_id']}/engine", {"engine": OTHER_ENGINE.id})
        require(status == 200, f"engine choice: {status} {body}")
        wait_for("the download to start", lambda: any(other_folder.glob("*.part")), HEARTBEAT_SECONDS * 4)
        status, body, _ = mac.call("POST", "/transcriptions", other_grant["grant"], command)
        require(status == 200 and body["engine"] == ENGINE.id, f"during the download: {status} {body}")
        wait_for("the change of engine", lambda: mac_view()["engine"] == OTHER_ENGINE.id, 600, 2)
        other_ranges = [r["range"] for r in mirror.requests_seen
                        if r["revision"] == OTHER_ENGINE.files.revision and r["file"] == largest_file(OTHER_ENGINE)]
        require(OTHER_ENGINE.files.revision in mirror.broken and other_ranges[-1], f"No resume: {other_ranges}")

        def loaded_with(engine) -> bool:
            status, body, _ = mac.call("GET", "/health", other_grant["grant"])
            return status == 200 and body["engine"] == engine.id and body["modelState"] == "loaded"

        wait_for("Qwen3-ASR to load", lambda: loaded_with(OTHER_ENGINE), 120)
        time.sleep(2)
        other_mb = footprint_mb(new_pid)
        # Qwen3-ASR's weights are 4.1 GB, so a reading below that misses the model. Alone, Qwen3-ASR holds
        # about 2.5 GB more than Whisper (Plan 82C Phase 0). With Whisper still beside it, 4.1 GB more.
        require(other_mb > 4000, f"The reading misses Qwen3-ASR: {other_mb} MB")
        require(other_mb < whisper_mb + 3500,
                f"Two engines in memory? {other_mb} MB with Qwen3-ASR, {whisper_mb} MB with Whisper")
        other_timings = []
        for _ in range(3):
            begun = time.monotonic()
            status, body, _ = mac.call("POST", "/transcriptions", other_grant["grant"], command)
            other_timings.append(time.monotonic() - begun)
            require(status == 200 and body["engine"] == OTHER_ENGINE.id, f"Qwen3-ASR command: {status} {body}")
        heard = body["text"].lower()
        require("second oven" in heard and "kouign" in heard, f"Wrong transcript: {body['text']}")
        step("a manager's choice brings Qwen3-ASR after its download, and Whisper answers until then",
             transcript=body["text"], whisperFootprintMb=whisper_mb, footprintMb=other_mb,
             p50Ms=round(statistics.median(other_timings) * 1000))

        # A change back needs no download: Whisper's files stayed. Qwen3-ASR's files stay for 14 days.
        downloads_before = len(mirror.requests_seen)
        status, body = owner.call("POST", f"voice/macs/{saved['mac_id']}/engine", {"engine": ENGINE.id})
        require(status == 200, f"engine choice back: {status} {body}")
        wait_for("the change back", lambda: mac_view()["engine"] == ENGINE.id, HEARTBEAT_SECONDS * 6, 1)
        wait_for("Whisper to load again", lambda: loaded_with(ENGINE), 120)
        status, body, _ = mac.call("POST", "/transcriptions", other_grant["grant"], command)
        require(status == 200 and body["engine"] == ENGINE.id, f"after the change back: {status} {body}")
        require(len(mirror.requests_seen) == downloads_before, "The change back downloaded files.")
        require((other_folder / largest_file(OTHER_ENGINE)).exists() and (other_folder / ".unused-since").exists(),
                "Qwen3-ASR's files did not stay with their 14 days.")
        status_text = subprocess.run([str(python), "-m", "shop_voice", "status"],
                                     env={**env, "PYTHONPATH": str(voice_home / "app")},
                                     check=True, capture_output=True, text=True).stdout
        require(f"Speech engine: {ENGINE.id}, files present" in status_text and OTHER_ENGINE.id in status_text,
                f"status: {status_text}")
        step("a change back to Whisper needs no download, and Qwen3-ASR's files stay for 14 days")

        for path in voice_home.rglob("*"):
            if path.is_symlink() or not path.is_file():
                continue
            parts = path.relative_to(voice_home).parts
            if parts[0] in ("venv", "app", "bin", "model"):
                continue
            require(path.suffix not in (".wav", ".pcm", ".aiff"), f"Audio on disk: {path}")
            data = path.read_bytes()
            require(b"WAVEfmt" not in data, f"Audio in {path}")
            lowered_data = data.lower()
            require(b"second oven" not in lowered_data and b"butter needs" not in lowered_data and b"second chiller" not in lowered_data, f"A transcript in {path}")
        worker_text = worker_log.read_text(errors="replace").lower()
        require("second oven" not in worker_text and "butter needs" not in worker_text and "second chiller" not in worker_text, "A transcript reached the Platform.")
        require(all(r["type"] in ("A", "TXT") for w in dns()["writes"] if (r := w["record"])), "An unknown DNS write.")
        step("no audio or transcript on disk, in the log or at the Platform")

        wait_for("a valid grant to keep working", lambda: mac.call("GET", "/health", other_grant["grant"])[0] == 200, 10)
        status, body = owner.call("POST", f"voice/macs/{saved['mac_id']}/revoke")
        require(status == 200 and body["dnsRemoved"] is True, f"revoke: {status} {body}")
        require(not any(r["type"] == "A" for r in dns()["records"]), "The A record stayed after revocation.")
        begun = time.monotonic()
        wait_for("the Mac to refuse a valid grant", lambda: mac.call("GET", "/health", other_grant["grant"])[0] == 401,
                 HEARTBEAT_SECONDS * 3)
        refused_after = round(time.monotonic() - begun, 1)
        wait_for("the files to go", lambda: not (voice_home / "model").exists() and not (voice_home / "speech").exists() and not (voice_home / "config.json").exists(),
                 HEARTBEAT_SECONDS * 10)
        wait_for("the service to stop", lambda: listening_pid() is None, 20)
        require(not (voice_home / "letsencrypt").exists(), "The private key stayed after revocation.")
        time.sleep(15)
        require(listening_pid() is None, "launchd restarted a revoked service.")
        step("revocation stops the Mac and deletes its model, key and credential", refusedAfterSeconds=refused_after)

        result = subprocess.run([str(python), "-m", "shop_voice", "uninstall"], env={**env, "PYTHONPATH": str(voice_home / "app")},
                                capture_output=True, text=True)
        require(result.returncode == 0, f"uninstall: {result.stderr}")
        require(not voice_home.exists() and not plist.exists(), "The uninstall left files.")
        require(subprocess.run(["launchctl", "print", domain_job], capture_output=True).returncode != 0, "The job stayed.")
        step("uninstall leaves nothing")
        results["result"] = "passed"
    except Exception as error:
        results["result"] = "failed"
        results["error"] = str(error)
        raise
    finally:
        (ARTIFACTS / "journey-results.json").write_text(json.dumps(results, indent=2) + "\n")
        subprocess.run(["launchctl", "bootout", domain_job], capture_output=True)
        plist.unlink(missing_ok=True)
        log = voice_home / "service.log"
        if log.exists():
            shutil.copy(log, ARTIFACTS / "service.log")
        mirror.shutdown()
        if backend is not None:
            stop(backend)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
