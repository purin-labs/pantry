#!/bin/sh
# Installs the Satyr shop voice service on this Mac (Plan 82). The Portal shows the command:
#   curl -fsSL <origin>/shop-voice/install.sh | sh -s -- --origin <origin> \
#     --organisation <id> --mac <id> --code <one-time code> --accept-letsencrypt-terms
# An enrolled Mac updates its service with `sh -s -- --update`, and keeps its enrollment.
# It needs no administrator. It downloads Python and the packages now (about 0.7 GB). The
# service downloads the models after enrollment (1.7 GB). `pack.mjs` fills in the source.
set -eu
UV_VERSION=0.6.5
UV_SHA256=4952c6275778fbc7e5cf6b5739ffd944c47063134d6ea43a7037b0a028ef771e
PYTHON_VERSION=3.11

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "This service needs a Mac with Apple silicon." >&2
  exit 1
fi
if [ "$(sw_vers -productVersion | cut -d. -f1)" -lt 14 ]; then
  echo "This service needs macOS 14 or later." >&2
  exit 1
fi
PANTRY_VOICE_HOME="${PANTRY_VOICE_HOME:-$HOME/.satyr-voice}"
export PANTRY_VOICE_HOME
case "$PANTRY_VOICE_HOME" in
  *" "*) echo "The service folder must have no space in its path." >&2; exit 1 ;;
esac
mkdir -p "$PANTRY_VOICE_HOME/app" "$PANTRY_VOICE_HOME/bin"
chmod 700 "$PANTRY_VOICE_HOME"

PAYLOAD='__SHOP_VOICE_PAYLOAD__'
# An update removes the old source first, so a module that the new version deleted cannot stay.
rm -rf "$PANTRY_VOICE_HOME/app/shop_voice"
case "$PAYLOAD" in
  __*) cp -R "$(dirname "$0")/shop_voice" "$(dirname "$0")/requirements.lock" "$PANTRY_VOICE_HOME/app/" ;;
  *) printf '%s' "$PAYLOAD" | base64 -d | tar -xz -C "$PANTRY_VOICE_HOME/app" ;;
esac

UV="$PANTRY_VOICE_HOME/bin/uv"
if [ ! -x "$UV" ]; then
  ARCHIVE="$(mktemp)"
  curl -fsSL -o "$ARCHIVE" "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-aarch64-apple-darwin.tar.gz"
  if [ "$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)" != "$UV_SHA256" ]; then
    rm -f "$ARCHIVE"
    echo "The uv download failed its SHA-256 check." >&2
    exit 1
  fi
  tar -xzf "$ARCHIVE" -C "$PANTRY_VOICE_HOME/bin" --strip-components=1 uv-aarch64-apple-darwin/uv
  rm -f "$ARCHIVE"
fi

VENV="$PANTRY_VOICE_HOME/venv"
"$UV" venv -q --allow-existing --python "$PYTHON_VERSION" --python-preference only-managed "$VENV"
"$UV" pip install -q --python "$VENV/bin/python" --no-deps --require-hashes --compile-bytecode -r "$PANTRY_VOICE_HOME/app/requirements.lock"

export PYTHONPATH="$PANTRY_VOICE_HOME/app"
# An update keeps the Mac's name, certificate, credential and model.
if [ "${1:-}" != --update ]; then
  "$VENV/bin/python" -m shop_voice enroll "$@"
fi
"$VENV/bin/python" -m shop_voice start
echo "The service runs. To check it: PYTHONPATH=$PYTHONPATH $VENV/bin/python -m shop_voice status"
