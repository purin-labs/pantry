#!/bin/sh
# Plan 82 G0.6: start the Mac test server with the D8 certificate, and keep the Mac awake.
# Needs setup-name.py first, and the speech bench venv and model from voiceId/stt-bench.
set -eu
BENCH="${BENCH:-$HOME/Dev/rust/seams-console/.claude/worktrees/voiceid-stt-bench/voiceId/stt-bench}"
MODEL="$BENCH/.cache/hf/models--mlx-community--whisper-large-v3-turbo/snapshots/a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"
TEST_HOME="$HOME/.pantry-voice-test"
NAME="$(cat "$TEST_HOME/name")"
HERE="$(dirname "$0")"
echo "Open on each device:"
echo "https://pantry-voice-path-test.n6378056.workers.dev/?mac=https://$NAME:8443"
exec caffeinate -i "$BENCH/.cache/.venv/bin/python" "$HERE/server.py" \
  --cert "$TEST_HOME/letsencrypt/live/$NAME/fullchain.pem" \
  --key "$TEST_HOME/letsencrypt/live/$NAME/privkey.pem" \
  --model "$MODEL" \
  --origin https://pantry-voice-path-test.n6378056.workers.dev \
  --results "$TEST_HOME/results"
