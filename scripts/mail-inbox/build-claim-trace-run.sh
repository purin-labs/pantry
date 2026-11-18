#!/bin/bash
# Builds output/playwright/mail-claim-trace-run.js: one run-code function that
# installs the shared reply room, mounts the Inbox fixture and runs the Claim
# Trace journey. Run it in a fresh playwright-cli session (it installs a page
# binding), against the Portal Vite server:
#   P=$HOME/.codex/skills/playwright/scripts/playwright_cli.sh
#   bash $P -s=claims open http://127.0.0.1:3103/theme-preview.html
#   bash $P -s=claims --json run-code --filename output/playwright/mail-claim-trace-run.js
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
out=$root/output/playwright
mkdir -p "$out"
room=$("$root/apps/portal/node_modules/.bin/esbuild" \
  "$root/scripts/frontend-foundation/portal-mail-reply-room.mjs" \
  --bundle --format=iife --global-name=SatyrReplyRoom --platform=browser \
  --log-level=warning)
{
  echo "async function runClaimTrace(page) {"
  echo "$room"
  echo "await SatyrReplyRoom.installMailReplyRoom(page);"
  cat "$root/scripts/mail-inbox/mount-browser-fixture.js"
  echo "await mountMailInbox(page);"
  cat "$root/scripts/mail-inbox/verify-browser-claim-trace.js"
  echo "return verifyClaimTrace(page);"
  echo "}"
} > "$out/mail-claim-trace-run.js"
echo "$out/mail-claim-trace-run.js"
