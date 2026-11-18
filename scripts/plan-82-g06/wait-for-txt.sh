#!/bin/sh
# Plan 82 G0.6: certbot hook for setup-name.py --by-hand. It writes the TXT record that a
# person must add, and holds certbot until Cloudflare's own name server answers with it.
# It asks that server directly, because a public resolver can remember "no record" for 30 min.
set -eu
TEST_HOME="$HOME/.satyr-voice-test"
RECORD="_acme-challenge.$CERTBOT_DOMAIN"
printf '%s\n%s\n' "$RECORD" "$CERTBOT_VALIDATION" > "$TEST_HOME/txt-record"
ZONE_SERVER="$(dig +short NS seams.tokyo @1.1.1.1 | head -1)"
DEADLINE=$(( $(date +%s) + 14400 ))
until dig +short TXT "$RECORD" "@$ZONE_SERVER" | grep -qF "$CERTBOT_VALIDATION"; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "The TXT record did not appear in 4 hours." >&2
    exit 1
  fi
  sleep 15
done
sleep 20
