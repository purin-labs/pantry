# Plan 82 G0.6 test

This test sends a recorded 3 s command from a public HTTPS page to the Mac in the shop.

- `page/`: the test page, on the Worker `satyr-voice-path-test`. Deploy with
  `wrangler deploy` from this folder. It holds static files only.
- `server.py`: the Mac end, with Whisper turbo and MLX. It keeps no audio.
- `setup-name.py`: the D8 name and the Let's Encrypt certificate.
- `wait-for-txt.sh`: holds certbot until the TXT record is live, with `--by-hand`.
- `run-server.sh`: starts the server with that certificate and keeps the Mac awake.
- `drive-chrome.cjs`: presses the page's buttons in Chrome on this Mac.

Steps:

1. Put `CLOUDFLARE_DNS_API_TOKEN` in `.env.local.production` (Zone, DNS, Edit on
   `seams.tokyo`). With `--by-hand`, skip this step. Add the printed A record and the TXT
   record from `~/.satyr-voice-test/txt-record` in the Cloudflare dashboard.
2. On the shop network, run `python3 scripts/plan-82-g06/setup-name.py --accept-letsencrypt-terms`.
3. Run `scripts/plan-82-g06/run-server.sh`.
4. On each device, open the printed address and press the buttons in order. Allow
   local network access if the browser asks.

Each result goes to `~/.satyr-voice-test/results` on the Mac. If a device cannot reach
the Mac, the page shows the error and the Mac receives nothing.

The Worker `satyr-voice-path-test` was deleted on 2026-11-18, because Plan 82 Phase 4
uses the shop Mac's own name. To run the test again, deploy it again with
`wrangler deploy`. The voice handover (`docs/plan-82-voice-handover.md`) records the
state of the DNS records and of `~/.satyr-voice-test`.
