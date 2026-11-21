#!/bin/sh
# Installs the Pantry shop gateway on this computer (Plan 85). The Portal shows the command:
#   curl -fsSL <origin>/shop-gateway/install.sh | sh -s -- --url <origin> \
#     --organisation <id> --gateway <id> --code <one-time code>
# It needs no administrator on a Mac. On Linux, run it as root to install a system service.
# `--no-service` installs and enrolls only, for a run by hand. `pack.mjs` fills in the digests.
set -eu

URL=""
ORGANISATION=""
GATEWAY=""
CODE=""
SERVICE=yes
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --organisation) ORGANISATION="$2"; shift 2 ;;
    --gateway) GATEWAY="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --no-service) SERVICE=no; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
if [ -z "$URL" ] || [ -z "$ORGANISATION" ] || [ -z "$GATEWAY" ] || [ -z "$CODE" ]; then
  echo "Copy the whole command from Devices > Add gateway." >&2
  exit 1
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=aarch64-apple-darwin; WANT='__DIGEST_aarch64-apple-darwin__' ;;
  Linux-aarch64 | Linux-arm64) TARGET=aarch64-unknown-linux-musl; WANT='__DIGEST_aarch64-unknown-linux-musl__' ;;
  Linux-x86_64) TARGET=x86_64-unknown-linux-musl; WANT='__DIGEST_x86_64-unknown-linux-musl__' ;;
  *) echo "This computer is not supported: $(uname -s) $(uname -m)." >&2; exit 1 ;;
esac
case "$WANT" in
  __*) echo "This Pantry release has no gateway build for $TARGET." >&2; exit 1 ;;
esac

PANTRY_GATEWAY_HOME="${PANTRY_GATEWAY_HOME:-$HOME/.pantry-gateway}"
export PANTRY_GATEWAY_HOME
mkdir -p "$PANTRY_GATEWAY_HOME/bin"
chmod 700 "$PANTRY_GATEWAY_HOME"
BINARY="$PANTRY_GATEWAY_HOME/bin/shop-gateway"
DOWNLOAD="$(mktemp)"
curl -fsSL -o "$DOWNLOAD" "$URL/shop-gateway/$TARGET/shop-gateway"
if command -v sha256sum >/dev/null 2>&1; then
  HAVE="$(sha256sum "$DOWNLOAD" | cut -d' ' -f1)"
else
  HAVE="$(shasum -a 256 "$DOWNLOAD" | cut -d' ' -f1)"
fi
if [ "$HAVE" != "$WANT" ]; then
  rm -f "$DOWNLOAD"
  echo "The gateway download failed its SHA-256 check." >&2
  exit 1
fi
chmod 755 "$DOWNLOAD"
mv "$DOWNLOAD" "$BINARY"

"$BINARY" enroll --url "$URL" --organisation "$ORGANISATION" --gateway "$GATEWAY" --code "$CODE"

if [ "$SERVICE" = no ]; then
  echo "Start it with: PANTRY_GATEWAY_HOME=$PANTRY_GATEWAY_HOME $BINARY run"
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    LABEL=io.purin.pantry.shop-gateway
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BINARY</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>PANTRY_GATEWAY_HOME</key><string>$PANTRY_GATEWAY_HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardErrorPath</key><string>$PANTRY_GATEWAY_HOME/gateway.log</string>
  <key>StandardOutPath</key><string>$PANTRY_GATEWAY_HOME/gateway.log</string>
</dict></plist>
PLIST
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    ;;
  Linux)
    UNIT="[Unit]
Description=Pantry shop gateway
After=network-online.target
Wants=network-online.target

[Service]
Environment=PANTRY_GATEWAY_HOME=$PANTRY_GATEWAY_HOME
ExecStart=$BINARY run
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target"
    if [ "$(id -u)" = 0 ]; then
      printf '%s\n' "$UNIT" >/etc/systemd/system/pantry-shop-gateway.service
      systemctl daemon-reload
      systemctl enable --now pantry-shop-gateway.service
    else
      mkdir -p "$HOME/.config/systemd/user"
      printf '%s\n' "$UNIT" >"$HOME/.config/systemd/user/pantry-shop-gateway.service"
      systemctl --user daemon-reload
      systemctl --user enable --now pantry-shop-gateway.service
      loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
    fi
    ;;
esac
echo "The gateway runs. Return to the Portal to confirm its devices."
