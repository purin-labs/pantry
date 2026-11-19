"""POST /transcriptions, POST /speech and GET /health over HTTPS, from the Portal's origin only.

No audio goes to disk. No transcript or answer goes to a log or to the Platform: only the Portal
receives it. The shapes are in @purin-labs/control-api: voiceMacHealthSchema, voiceTranscriptionSchema
and voiceMacRefusalSchema. A spoken answer is a WAV file. The health and transcription answers name
the speech engine (Plan 82C).
"""
import json
import socket
import threading
import time
from collections import defaultdict, deque
from concurrent.futures import TimeoutError as FutureTimeout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import VERSION
from .certificate import Certificate
from .engines import samples_of
from .grant import Grant, check_grant
from .model_host import Busy, ModelHost, ModelNotReady
from .state import Config
from .wav import BODY_BYTE_LIMIT, BYTES_PER_SECOND, AudioInvalid, AudioTooLong, read_pcm

REQUEST_LIMIT = 60
REQUEST_WINDOW_SECONDS = 10 * 60
SOCKET_TIMEOUT_SECONDS = 10
ANSWER_TIMEOUT_SECONDS = 30
DRAIN_BYTE_LIMIT = 4 * BODY_BYTE_LIMIT
SPEECH_BODY_BYTE_LIMIT = 8_000
SPEECH_TEXT_LIMIT = 1_000


class RateLimit:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._uses: dict[str, deque[float]] = defaultdict(deque)

    def admit(self, user_id: str) -> bool:
        now = time.monotonic()
        with self._lock:
            uses = self._uses[user_id]
            while uses and now - uses[0] >= REQUEST_WINDOW_SECONDS:
                uses.popleft()
            if len(uses) >= REQUEST_LIMIT:
                return False
            uses.append(now)
            return True


class ShopVoice:
    """What the requests share: the service's enrollment, its models and the vocabulary.

    `transcription` hosts the speech engine, and `speech` hosts the answer voice."""

    def __init__(self, config: Config, transcription: ModelHost, speech: ModelHost) -> None:
        self.config = config
        self.transcription = transcription
        self.speech = speech
        self.rate_limit = RateLimit()
        self.speech_rate_limit = RateLimit()
        self.vocabulary: tuple[str, ...] = ()
        self.refusing = False

    @property
    def engine_id(self) -> str:
        return self.transcription.model.id


def make_handler(shop: ShopVoice) -> type[BaseHTTPRequestHandler]:
    origins = shop.config.portal_origins

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "satyr-shop-voice"
        sys_version = ""
        timeout = SOCKET_TIMEOUT_SECONDS

        def log_message(self, format: str, *values) -> None:
            pass  # A request line tells nothing that an operator needs, and the Mac keeps no record of members.

        def log_error(self, format: str, *values) -> None:
            pass

        def _cors(self) -> None:
            origin = self.headers.get("Origin", "")
            if origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Timing-Allow-Origin", origin)

        def _answer(self, status: int, body: dict, close: bool = False) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            if close:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(data)

        def _refuse(self, status: int, code: str) -> None:
            # A close with unread bytes resets the connection, and the Portal loses this answer.
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            self.rfile.read(min(length, DRAIN_BYTE_LIMIT))
            self._answer(status, {"ok": False, "error": code}, close=length > DRAIN_BYTE_LIMIT)

        def _admit(self) -> Grant | None:
            if self.headers.get("Origin", "") not in origins:
                self._refuse(403, "origin_refused")
                return None
            scheme, _, token = self.headers.get("Authorization", "").partition(" ")
            grant = None if scheme != "Bearer" or shop.refusing else check_grant(
                token, shop.config.grant_key, shop.config.organisation_id, shop.config.mac_id)
            if grant is None:
                self._refuse(401, "grant_refused")
            return grant

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self._cors()
            if self.headers.get("Origin", "") in origins:
                self.send_header("Access-Control-Allow-Methods", "GET, POST")
                self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:
            if self.path != "/health":
                self._refuse(404, "not_found")
            elif self._admit() is not None:
                shop.transcription.check()
                shop.speech.check()
                self._answer(200, {"ok": True, "modelState": shop.transcription.model_state,
                                   "busy": shop.transcription.busy, "serviceVersion": VERSION,
                                   "engine": shop.engine_id})

        def do_POST(self) -> None:
            if self.path not in ("/transcriptions", "/speech"):
                self._refuse(404, "not_found")
                return
            grant = self._admit()
            if grant is None:
                return
            speaking = self.path == "/speech"
            limit = shop.speech_rate_limit if speaking else shop.rate_limit
            if not limit.admit(grant.user_id):
                self._refuse(429, "rate_limited")
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length > (SPEECH_BODY_BYTE_LIMIT if speaking else BODY_BYTE_LIMIT):
                self._refuse(413, "too_long")
            elif length <= 0:
                self._refuse(400, "speech_invalid" if speaking else "audio_invalid")
            elif speaking:
                self._speak(self.rfile.read(length))
            else:
                self._transcribe(self.rfile.read(length))

        def _speak(self, body: bytes) -> None:
            try:
                parsed = json.loads(body)
                text = parsed.get("text") if isinstance(parsed, dict) else None
            except ValueError:
                text = None
            if not isinstance(text, str) or not text.strip():
                self._answer(400, {"ok": False, "error": "speech_invalid"})
                return
            if len(text) > SPEECH_TEXT_LIMIT:
                self._answer(413, {"ok": False, "error": "too_long"})
                return
            try:
                shop.speech.check()  # The voice's files can arrive after the Portal's last check.
                data = shop.speech.run(lambda voice: voice.read(text)).result(ANSWER_TIMEOUT_SECONDS)
            except (Busy, FutureTimeout):
                self._answer(503, {"ok": False, "error": "busy"})
            except ModelNotReady:
                self._answer(503, {"ok": False, "error": "model_not_ready"})
            except Exception as error:  # The Portal uses the browser's voice. The name of the error holds no text.
                print(f"Speech failed: {type(error).__name__}", flush=True)
                self._answer(503, {"ok": False, "error": "model_not_ready"})
            else:
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        def _transcribe(self, body: bytes) -> None:
            try:
                pcm = read_pcm(body)
                vocabulary = shop.vocabulary
                # The engine can change between the request and its turn, so the answer names the one that heard.
                text, engine_id = shop.transcription.run(
                    lambda engine: (engine.hear(samples_of(pcm), vocabulary), engine.id)).result(ANSWER_TIMEOUT_SECONDS)
            except AudioInvalid:
                self._answer(400, {"ok": False, "error": "audio_invalid"})
            except AudioTooLong:
                self._answer(413, {"ok": False, "error": "too_long"})
            except (Busy, FutureTimeout):
                self._answer(503, {"ok": False, "error": "busy"})
            except ModelNotReady:
                self._answer(503, {"ok": False, "error": "model_not_ready"})
            except Exception as error:  # The Portal uses the fallback. The name of the error holds no speech.
                print(f"Transcription failed: {type(error).__name__}", flush=True)
                self._answer(503, {"ok": False, "error": "model_not_ready"})
            else:
                self._answer(200, {"text": text[:8000], "audioSeconds": len(pcm) / BYTES_PER_SECOND,
                                   "engine": engine_id})

    return Handler


class Server(ThreadingHTTPServer):
    # The TLS handshake runs in the connection's own thread, so a stalled device holds no other device.
    daemon_threads = True
    certificate: Certificate

    def handle_error(self, request, client_address) -> None:
        pass  # A device that left in the middle of a request is normal here.

    def finish_request(self, request: socket.socket, client_address) -> None:
        request.settimeout(SOCKET_TIMEOUT_SECONDS)
        try:
            secure = self.certificate.context.wrap_socket(request, server_side=True)
        except OSError:
            return
        try:
            self.RequestHandlerClass(secure, client_address, self)
        finally:
            secure.close()


def serve(shop: ShopVoice, certificate: Certificate) -> None:
    certificate.ready.wait()
    server = Server(("0.0.0.0", shop.config.port), make_handler(shop))
    server.certificate = certificate
    print(f"Listening on port {shop.config.port}.", flush=True)
    server.serve_forever()
