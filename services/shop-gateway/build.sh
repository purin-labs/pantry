#!/usr/bin/env bash
# Builds the shop gateway for each computer that the install script supports. A release runs
# this before the Portal build. It needs a Mac with Apple silicon and Docker.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dist="$root/services/shop-gateway/dist"
target_dir="${CARGO_TARGET_DIR:-$root/target}"

cargo build --manifest-path "$root/Cargo.toml" --release -p shop-gateway --target aarch64-apple-darwin
mkdir -p "$dist/aarch64-apple-darwin"
cp "$target_dir/aarch64-apple-darwin/release/shop-gateway" "$dist/aarch64-apple-darwin/shop-gateway"

build_linux() {
  local platform="$1" target="$2"
  docker run --rm --platform "$platform" \
    -v "$root:/source:ro" -v "$dist:/dist" \
    rust:1-alpine sh -c "
      apk add --no-cache musl-dev gcc >/dev/null &&
      cargo build --manifest-path /source/Cargo.toml --release -p shop-gateway --target-dir /tmp/target &&
      mkdir -p /dist/$target &&
      cp /tmp/target/release/shop-gateway /dist/$target/shop-gateway"
}
build_linux linux/arm64 aarch64-unknown-linux-musl
build_linux linux/amd64 x86_64-unknown-linux-musl
