#!/usr/bin/env bash
# Runs the Worker with the WHATSAPP_* values from .dev.vars injected as --var.
#
# They are deliberately not declared in wrangler.jsonc, and wrangler only
# injects a .dev.vars entry when its key is declared there — so without this
# the Worker starts cleanly and then reports whatsapp_*_missing no matter what
# .dev.vars contains. Values are read straight from the file and never echoed.
set -euo pipefail
cd "$(dirname "$0")/.."
ARGS=()
while IFS='=' read -r key value; do
  ARGS+=(--var "$key:$value")
done < <(grep -E '^WHATSAPP_[A-Z_]+=' .dev.vars || true)
if [ ${#ARGS[@]} -eq 0 ]; then
  echo "No WHATSAPP_* entries in workers/platform/.dev.vars" >&2
  exit 1
fi
exec pnpm exec wrangler dev --port "${PORT:-8787}" "${ARGS[@]}"
