"""Plan 82 G0.6: give this Mac the D8 name and a real certificate.

Uses one DNS-only A record, <random id>.voice.seams.tokyo, with this Mac's private
address, and gets a Let's Encrypt certificate through a DNS-01 challenge. The private
key stays in ~/.pantry-voice-test. Run it again when the Mac's address changes.

With a token, the script writes the records. It needs CLOUDFLARE_DNS_API_TOKEN in
.env.local.production (Zone, DNS, Edit on seams.tokyo).
With --by-hand, it needs no token. A person adds the A record and the TXT record in the
Cloudflare dashboard, and wait-for-txt.sh holds certbot until the TXT record is live.
--accept-letsencrypt-terms is required, because certbot accepts the subscriber agreement.

Usage:
  python3 scripts/plan-82-g06/setup-name.py --accept-letsencrypt-terms [--by-hand] [--interface en0]
"""
import argparse
import json
import os
import re
import secrets
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

ZONE = "seams.tokyo"
HERE = Path(__file__).resolve().parent
REPO = Path(__file__).resolve().parents[2]
HOME = Path.home() / ".pantry-voice-test"

parser = argparse.ArgumentParser()
parser.add_argument("--accept-letsencrypt-terms", action="store_true")
parser.add_argument("--by-hand", action="store_true")
parser.add_argument("--interface", default="en0")
args = parser.parse_args()
if not args.accept_letsencrypt_terms:
    raise SystemExit("Pass --accept-letsencrypt-terms to accept the Let's Encrypt subscriber agreement.")


def read_token() -> str:
    env_text = (REPO / ".env.local.production").read_text()
    match = re.search(r"^\s*(?:export\s+)?CLOUDFLARE_DNS_API_TOKEN=[\"']?([^\"'\s]+)", env_text, re.M)
    if not match:
        raise SystemExit("CLOUDFLARE_DNS_API_TOKEN is not in .env.local.production.")
    return match[1]


def api(token: str, method: str, path: str, body: dict | None = None) -> dict:
    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4{path}", method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "pantry-g06"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)["result"]
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Cloudflare refused {method} {path.split('?')[0]}: {error.code} {error.read()[:300]!r}")


HOME.mkdir(mode=0o700, exist_ok=True)
name_file = HOME / "name"
if not name_file.exists():
    name_file.write_text(f"{secrets.token_hex(6)}.voice.{ZONE}\n")
name = name_file.read_text().strip()
address = subprocess.check_output(["ipconfig", "getifaddr", args.interface], text=True).strip()
(HOME / "address").write_text(f"{address}\n")

certbot = ["uvx", "--with", "certbot-dns-cloudflare", "certbot", "certonly", "--non-interactive", "--agree-tos",
           "--register-unsafely-without-email", "--keep-until-expiring",
           "--config-dir", str(HOME / "letsencrypt"), "--work-dir", str(HOME / "work"), "--logs-dir", str(HOME / "logs"),
           "-d", name]

if args.by_hand:
    print(f"Add in Cloudflare: A {name} {address}, DNS only, TTL 1 min", flush=True)
    subprocess.run(certbot + ["--manual", "--preferred-challenges", "dns",
                              "--manual-auth-hook", str(HERE / "wait-for-txt.sh")],
                   check=True, env={**os.environ})
else:
    token = read_token()
    zone_id = api(token, "GET", f"/zones?name={ZONE}")[0]["id"]
    record = {"type": "A", "name": name, "content": address, "ttl": 60, "proxied": False,
              "comment": "Plan 82 G0.6 test; delete when G0.6 closes"}
    existing = api(token, "GET", f"/zones/{zone_id}/dns_records?type=A&name={name}")
    if existing:
        api(token, "PUT", f"/zones/{zone_id}/dns_records/{existing[0]['id']}", record)
    else:
        api(token, "POST", f"/zones/{zone_id}/dns_records", record)
    credentials = HOME / "cloudflare.ini"
    credentials.touch(mode=0o600, exist_ok=True)
    credentials.write_text(f"dns_cloudflare_api_token = {token}\n")
    subprocess.run(certbot + ["--dns-cloudflare", "--dns-cloudflare-credentials", str(credentials),
                              "--dns-cloudflare-propagation-seconds", "30"],
                   check=True, env={**os.environ})
    credentials.unlink()
print(f"name: {name}\naddress: {address}\ncertificate: {HOME}/letsencrypt/live/{name}/fullchain.pem")
