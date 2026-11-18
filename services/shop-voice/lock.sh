#!/bin/sh
# Writes requirements.lock, with a hash for each package, for Python 3.11 on Apple silicon and macOS 14, the oldest that has mlx wheels.
set -eu
cd "$(dirname "$0")"
export MACOSX_DEPLOYMENT_TARGET=14.0
FLAGS="--generate-hashes --python-version 3.11 --python-platform aarch64-apple-darwin --no-header --no-annotate -q"
uv pip compile requirements.in $FLAGS -o requirements.lock
echo 'mlx-whisper==0.4.3' | uv pip compile - --no-deps $FLAGS >> requirements.lock
echo 'mlx-audio==0.6.5' | uv pip compile - --no-deps $FLAGS >> requirements.lock
