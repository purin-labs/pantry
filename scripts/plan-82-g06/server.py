"""Plan 82 G0.6: the Mac end of the browser-to-Mac test.

Serves Whisper turbo with MLX over HTTPS, as the shop Mac service will. It uses the
bench settings and the queue limit from Plan 82: one command at a time and at most
two more waiting. It keeps no audio. Results that the test page sends go to --results.

Usage:
  <venv>/bin/python server.py --cert fullchain.pem --key privkey.pem \
    --model <MLX snapshot folder> --origin https://<test page origin> --results <folder>
"""
import argparse
import io
import json
import os
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import mlx_whisper
import numpy as np
import soundfile as sf

MAX_BODY_BYTES = 1_000_000
MAX_SECONDS = 15.0
HANG_SECONDS = 20.0
QUEUE_SLOTS = 3  # One command that runs and two that wait.

parser = argparse.ArgumentParser()
parser.add_argument("--cert", required=True)
parser.add_argument("--key", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--origin", required=True, action="append")
parser.add_argument("--results", required=True, type=Path)
parser.add_argument("--port", type=int, default=8443)
args = parser.parse_args()
args.results.mkdir(parents=True, exist_ok=True)

slots = threading.BoundedSemaphore(QUEUE_SLOTS)
whisper = threading.Lock()


def transcribe(samples: np.ndarray) -> str:
    result = mlx_whisper.transcribe(samples, path_or_hf_repo=args.model, language="en", temperature=0.0,
                                    condition_on_previous_text=False, verbose=None)
    return result["text"].strip()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "shop-voice-test"
    sys_version = ""

    def log_message(self, format: str, *values) -> None:
        print(f"{time.strftime('%H:%M:%S')} {self.address_string()} {format % values}", flush=True)

    def answer(self, status: int, body: dict | None = None, close: bool = False) -> None:
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        origin = self.headers.get("Origin", "")
        if origin in args.origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Timing-Allow-Origin", origin)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        origin = self.headers.get("Origin", "")
        if origin in args.origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.split("?")[0] == "/health":
            self.answer(200, {"ok": True, "model": "whisper-large-v3-turbo", "engine": "mlx"})
        else:
            self.answer(404, {"error": "not_found"})

    def read_body(self) -> bytes | None:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            self.answer(413, {"error": "too_long"}, close=True)
            return None
        return self.rfile.read(length)

    def do_POST(self) -> None:
        path, _, query = self.path.partition("?")
        if self.headers.get("Origin", "") not in args.origin:
            self.answer(403, {"error": "origin_refused"}, close=True)
        elif path == "/transcriptions":
            self.post_transcription(query)
        elif path == "/results":
            self.post_results()
        else:
            self.answer(404, {"error": "not_found"}, close=True)

    def post_transcription(self, query: str) -> None:
        body = self.read_body()
        if body is None:
            return
        cold = "cold=1" in query
        if "hang=1" in query:
            time.sleep(HANG_SECONDS)
            self.answer(200, {"text": "", "hung": True}, close=True)
            return
        if not slots.acquire(blocking=False):
            self.answer(503, {"error": "busy"}, close=cold)
            return
        try:
            samples, rate = sf.read(io.BytesIO(body), dtype="float32")
            if rate != 16000 or samples.ndim != 1 or len(samples) / rate > MAX_SECONDS:
                self.answer(400, {"error": "bad_audio"}, close=cold)
                return
            received = time.perf_counter()
            with whisper:
                started = time.perf_counter()
                text = transcribe(samples)
            finished = time.perf_counter()
            self.answer(200, {"text": text, "waitMs": round((started - received) * 1000),
                              "transcribeMs": round((finished - started) * 1000)}, close=cold)
        finally:
            slots.release()

    def post_results(self) -> None:
        body = self.read_body()
        if body is None:
            return
        report = json.loads(body)
        name = f"{time.strftime('%Y%m%d-%H%M%S')}-{report.get('test', 'run')}-{os.urandom(2).hex()}.json"
        report["receivedFrom"] = self.address_string()
        (args.results / name).write_text(json.dumps(report, indent=2))
        self.answer(200, {"saved": name})


class Server(ThreadingHTTPServer):
    # The TLS handshake runs in the connection's own thread. So the log shows a device
    # that connects and fails, and a stalled connection cannot hold the others.
    def finish_request(self, request, client_address) -> None:
        stamp = f"{time.strftime('%H:%M:%S')} {client_address[0]}"
        print(f"{stamp} connected", flush=True)
        request.settimeout(10)
        try:
            secure = context.wrap_socket(request, server_side=True)
        except OSError as error:
            print(f"{stamp} TLS failed: {error}", flush=True)
            return
        secure.settimeout(None)
        try:
            self.RequestHandlerClass(secure, client_address, self)
        finally:
            secure.close()


transcribe(np.zeros(16000, dtype="float32"))  # Load the model before the first command.
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(args.cert, args.key)
server = Server(("0.0.0.0", args.port), Handler)
print(f"ready on port {args.port}", flush=True)
server.serve_forever()
