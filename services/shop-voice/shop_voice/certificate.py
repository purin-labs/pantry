"""The certificate of the Mac's public name (Plan 82 D8), through a DNS-01 challenge.

The private key stays on this Mac. The Platform can only write the challenge record.
"""
import os
import shlex
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import platform_api
from .state import Config, certificate_dir, home

RENEW_BEFORE_SECONDS = 30 * 86_400
CHECK_SECONDS = 86_400
# A failed order counts against the certificate authority's limit of five in one hour.
RETRY_SECONDS = 3_600
DNS_WAIT_SECONDS = 600
DNS_SETTLE_SECONDS = 20


def live_files(hostname: str) -> tuple[Path, Path]:
    live = certificate_dir() / "live" / hostname
    return live / "fullchain.pem", live / "privkey.pem"


def _valid_for(chain: Path, seconds: int) -> bool:
    if not chain.exists():
        return False
    return subprocess.run(["/usr/bin/openssl", "x509", "-checkend", str(seconds), "-noout", "-in", str(chain)],
                          capture_output=True).returncode == 0


def _hook(action: str) -> str:
    return " ".join(shlex.quote(part) for part in (sys.executable, "-m", "shop_voice", "certificate-hook", action))


def _run_certbot(config: Config) -> bool:
    # The owner of the Mac accepted the certificate authority's terms at install.
    command = [str(Path(sys.executable).parent / "certbot"), "certonly", "--non-interactive", "--agree-tos",
               "--register-unsafely-without-email", "--keep-until-expiring", "--no-directory-hooks",
               "--config-dir", str(certificate_dir()), "--work-dir", str(home() / "certbot-work"),
               "--logs-dir", str(home() / "certbot-logs"), "--manual", "--preferred-challenges", "dns",
               "--manual-auth-hook", _hook("put"), "--manual-cleanup-hook", _hook("delete"), "-d", config.hostname]
    if config.certificate_command is not None:
        command = [*config.certificate_command, sys.executable, config.hostname, str(certificate_dir())]
    result = subprocess.run(command, capture_output=True, text=True, env={**os.environ, "PANTRY_VOICE_HOME": str(home())})
    if result.returncode != 0:
        print(f"Certificate: certbot exited with {result.returncode}. See {home() / 'certbot-logs'}.", flush=True)
    return result.returncode == 0


class Certificate:
    """Holds the TLS context. A renewal reaches each new connection with no restart."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.ready = threading.Event()

    def start(self) -> None:
        threading.Thread(target=self._run, name="certificate", daemon=True).start()

    def _load(self) -> None:
        chain, key = live_files(self.config.hostname)
        self.context.load_cert_chain(chain, key)
        self.ready.set()

    def _run(self) -> None:
        chain, _ = live_files(self.config.hostname)
        while True:
            renewed = False
            if not _valid_for(chain, RENEW_BEFORE_SECONDS):
                renewed = _run_certbot(self.config)
            if _valid_for(chain, 0) and (renewed or not self.ready.is_set()):
                try:
                    self._load()
                except OSError as error:  # The service keeps its last certificate, and tries again.
                    print(f"Certificate: {type(error).__name__}: {error}", flush=True)
            time.sleep(CHECK_SECONDS if _valid_for(chain, RENEW_BEFORE_SECONDS) else RETRY_SECONDS)


def _wait_for_record(hostname: str, value: str) -> None:
    """Asks the zone's own name server, because a public resolver can remember "no record"."""
    zone = hostname.split(".voice.", 1)[1]
    record = f"_acme-challenge.{hostname}"
    deadline = time.monotonic() + DNS_WAIT_SECONDS
    while time.monotonic() < deadline:
        servers = subprocess.run(["/usr/bin/dig", "+short", "NS", zone, "@1.1.1.1"], capture_output=True, text=True).stdout.split()
        if servers:
            answer = subprocess.run(["/usr/bin/dig", "+short", "TXT", record, f"@{servers[0]}"], capture_output=True, text=True).stdout
            if value in answer:
                time.sleep(DNS_SETTLE_SECONDS)
                return
        time.sleep(5)
    raise SystemExit("The challenge record did not appear in time.")


def run_hook(config: Config, action: str) -> None:
    if action == "put":
        value = os.environ["CERTBOT_VALIDATION"]
        platform_api.put_challenge(config.platform_origin, config.credential, value)
        if config.wait_for_dns:
            _wait_for_record(config.hostname, value)
    else:
        platform_api.delete_challenge(config.platform_origin, config.credential)
