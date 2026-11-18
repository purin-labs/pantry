#!/bin/sh
# The shop Mac journey's certificate authority (Plan 82 Phase 1B). It takes the place of certbot,
# because the journey has no public DNS. It calls the service's real hooks as certbot does.
# Usage: issue-certificate.sh <CA folder> <python> <hostname> <certificate folder>
set -eu
CA="$1"; PYTHON="$2"; HOST="$3"; LIVE="$4/live/$HOST"
CERTBOT_VALIDATION=journeyChallengeValue0123456789abcdefghijklmn "$PYTHON" -m shop_voice certificate-hook put
"$PYTHON" -m shop_voice certificate-hook delete
mkdir -p "$LIVE"
/usr/bin/openssl req -new -newkey rsa:2048 -sha256 -nodes -subj "/CN=$HOST" \
  -keyout "$LIVE/privkey.pem" -out "$LIVE/request.csr" 2>/dev/null
# The Safari journey reaches the service as localhost. Apple's TLS rules require the usage line.
printf 'subjectAltName=DNS:%s,DNS:localhost\nextendedKeyUsage=serverAuth\n' "$HOST" > "$LIVE/san.ext"
/usr/bin/openssl x509 -req -in "$LIVE/request.csr" -CA "$CA/ca.pem" -CAkey "$CA/ca.key" -CAcreateserial -days 90 -sha256 \
  -extfile "$LIVE/san.ext" -out "$LIVE/fullchain.pem" 2>/dev/null
rm -f "$LIVE/request.csr" "$LIVE/san.ext"
