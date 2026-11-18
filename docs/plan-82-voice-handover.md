# Voice handover — Plans 82, 82B and 82C

Date: 18 November 2026. Written for the move to the new repository `seams-tech/pantry`
([Plan 91](plan-91-seams-atelier-rename.md)), and for the next move: the GitHub organisation
`purin-io`, the folder `/Users/pta/Dev/purin-io` and the Purin rename (see "The move to purin-io").
This file is the entry point for voice work. Each plan keeps its decisions, its phases and its
evidence.

## Result

Voice control works in production on every Portal page again. The Plan 91 rename broke it from
2026-11-17 11:16 UTC to 2026-11-18 02:34 UTC (see "The wake model fault"). Most of the
work that remains needs a real shop, and the owner has no shop for a while. So the voice plans
wait, except the steps in "Steps that do not need a shop".

| Plan                                                         | State on 2026-11-18                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| [82 — Portal voice control](plan-82-portal-voice-control.md) | Phases 0–3 and D9–D12 in production, with the wake model fault. Phase 4 (the owner's shift) and Phase 5 remain.    |
| [82B — Ambient voice](plan-82B-ambient-voice.md)             | Draft. Nothing is built. Decisions D1–D9 need the owner.                                                           |
| [82C — Speech engines](plan-82C-speech-engines.md)           | Phases 0–3 in production (service 0.5.1). D5, the week of use and Phase 4 are deferred until the owner has a shop. |

## What runs in production

Checked on 2026-11-18:

- The Portal and the Platform hold all the voice work of Plans 82 and 82C. The live install script
  (`/shop-voice/install.sh`) gives service 0.5.1.
- A command starts with "Hey Satyr" or a held Right Option key. The shop Mac transcribes it with
  Whisper large-v3-turbo. If the Mac does not answer, Whisper on Workers AI is the fallback.
- A manager can choose Qwen3-ASR 1.7B for one Mac in the voice dialog. Whisper stays the default
  for new Macs (Plan 82C D5).
- Spoken answers come from the Mac (`POST /speech`, Kokoro `af_heart`). Spoken approvals need an
  exact phrase match.
- One test Mac is enrolled: the owner's MacBook Pro (M4 Pro), name `dd8267f68371.voice.seams.sh`,
  private address `192.168.210.75`. It runs service 0.5.1 on Whisper as the launchd job
  `sh.seams.satyr.shop-voice`, from `~/.satyr-voice/app`. Its certificate lasts to 2027-01-31 and
  renews 30 days before.
- No real spoken command was checked in production after service 0.3.0, and no signed-in
  production journey ran. The agent cannot sign in to the Portal.

## The wake model fault (released fix)

Found on 2026-11-18. The Plan 91 codemod renamed `apps/portal/public/voice/hey_satyr.onnx` to
`hey_atelier.onnx` (commit `d241e969d`), but `features/voice/wake-worker.ts` loads
`/voice/hey_satyr.onnx`. Production (`satyr-edge` `347178c4`) answers that path with the Portal
page and status 200. The wake worker then fails, and the Portal shows that voice stopped. The model
cache also kept that page, so a device stays broken after a plain fix of the file name. A device
that kept the real file before the rename still works.

The fix (dev `6a3058272`):

- The file has its old name again, `hey_satyr.onnx`, because the model hears "Hey Satyr". The new
  wake phrase gets its own file in step 5.
- `features/voice/model-cache.ts` refuses a `text/html` answer, and it fetches again a page that a
  device kept. Such a device heals at its next voice start.
- The voice journey scripts call `pnpm --filter @seams/platform` and `@seams/portal`. The old
  package names matched no package after the rename.

Proof on 2026-11-18: the built Portal has `voice/hey_satyr.onnx` again, and the Chrome journey's
closed-chat scene passes (`SHOP_VOICE_APPROVAL_ONLY=1 SHOP_VOICE_SCENE=closed_chat
run-portal-journey.py`). In it the wake phrase starts a command through the Portal's own wake
worker, the test Mac's Whisper hears "Label the second tray", and the chat opens beside the page
with a spoken answer. Not run: the whole journey, and a device that kept the page in its cache. On
the first run in a fresh worktree, Vite found `onnxruntime-web/wasm` as a new dependency, reloaded
the page during the scene, and the Knowledge page failed with two React copies. Run the journey a
second time in a fresh worktree.

Released on 2026-11-18 02:34 UTC as `satyr-edge` `b30cd3c3`, on the owner's words "Yes, release
it". The release is narrow: the live source `41b4f4128` with the two code files of `6a3058272`, as
`9d8f565bf` (ref `refs/backup/released-2026-11-18-voice-wake-model`). It has no D1 change, and the
rollback target is `347178c4`. Before the upload, 15 of the 16 Portal entry files and the shop Mac
installer's files matched production, which shows that `41b4f4128` was the live source. After it,
`/voice/hey_satyr.onnx` answers 411,982 bytes with the build's SHA-256 and no `text/html` type, and
the live wake worker equals the build. A 65-second log tail had 6 events, all ok, with no
exception. No signed-in check ran. No other file that the codemod
renamed is still loaded by its old name.

## Steps that need a shop

These wait until the owner has a shop. Do not ask the owner for them before that.

1. **Plan 82 Phase 4: the owner's shift.** One real shift with voice control. It closes G0.3 (real
   approval phrases with the mixer on, a wearable microphone and the device at 2 m), G0.4 (at most
   one false wake in 8 hours, and 95% of wake phrases heard at 1 m) and the G0.6 device part
   (Chrome and Safari on a tablet and a phone, on the shop's Wi-Fi, with three bakers). Record false
   wakes, misheard commands, refusals and each fallback in
   [the evidence file](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-82-phase-0.md). If a limit fails, stop and return to the wake
   model or the microphone with the numbers.
2. **Plan 82C D5, then the week.** Record about 3 minutes of room sound with
   `voice-recorder.html?only=room`. Run the D5 bench (the command is in Plan 82C, "Deferred"). If
   D5 passes, a manager chooses Qwen3-ASR for the shop Mac for 7 days. If the week passes, Plan
   82C Phase 4 makes the Platform write Qwen3-ASR as the engine of each new Mac (one release).
3. **Plan 82B Phase 0 G0.1 and G0.3, and Phase 3.** The speaker check and the load test use staff
   recordings in the shop.

## Steps that do not need a shop

4. **G0.2 and the live journey (Plan 82 Phase 4).** Send one recorded command through this Mac and
   one through real Workers AI, on the deployed Worker, from the Portal to an agent answer. Measure
   the fallback time from the end of a 3 s command: the limit is 6 s at p95. This needs a signed-in
   Portal in the owner's Chrome. It is about one hour of agent work.
5. **The wake phrase rename.** Plan 91 phase 6 planned "Hey Sous Chef". The Purin rename can change
   the agent's name again, so train a wake model only for the final name. Train it with
   `scripts/plan-82-g04/wake.py`, measure it with `phase-bench.py` against the G0.4 limits, and
   add the phrase to the Mac's lexicon in `services/shop-voice/shop_voice/speech.py`. Switch the
   model file, the wake phrase and the voice prompts in one release. Until then, the Portal says
   "Hey Satyr".
6. **Plan 82B decisions.** The owner decides D1–D9. D9 needs counsel before any release, because a
   speaker template can be personal information.
7. **Plan 82 Phase 5: Japanese.** Measure Whisper latency on the Japanese phrases, pass
   `language: "ja"` on both paths, and build a Japanese phrase bank for approvals.
8. **Small open checks.** A real Fn key press, the talk key with a real microphone, Safari on a
   real iPhone or iPad, and one spoken approval through the deployed Portal.

## The G0.6 test cleanup

Plan 82 Phase 4 uses the shop Mac's own name, so the G0.6 test from 2026-10-31 is not needed. The
owner said "Yes, delete them" on 2026-11-18.

- Deleted on 2026-11-18: the Worker `satyr-voice-path-test`. Its workers.dev address answers 404,
  and the API says that the Worker does not exist.
- Deleted on 2026-11-18 by the owner in the Cloudflare dashboard: the DNS name
  `2ea5e7dbf048.voice.seams.tokyo` (an A record to `192.168.210.84`) and its TXT record
  `_acme-challenge.2ea5e7dbf048.voice.seams.tokyo`. Cloudflare's own name server, 1.1.1.1 and
  8.8.8.8 answer neither record. No API token can change the `seams.tokyo` zone.
- Kept: `~/.satyr-voice-test`. Its `results` folders are the G0.6 evidence, and `wake/` is the
  wake model data. `scripts/plan-82-g06/` can deploy the test again.

## The move to purin-io

The owner's plan on 2026-11-18:

1. The GitHub organisation changes from `seams-tech` to `purin-io`.
2. The repositories move from `~/Dev/lowerarchy` and `~/Dev/rust` to `/Users/pta/Dev/purin-io`.
3. A few days later, after the hackathon, the Seams names change to Purin.

No voice file names the GitHub organisation, so step 1 changes nothing for voice.

### What a fresh clone does not have

Git ignores these files. A moved folder keeps them, but a new clone does not have them:

| Item                                         | Size   | What to do                                                                                                            |
| -------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `.cache/human/2026-11-16-1912/`              | 9.6 MB | The owner's voice. The D5 run needs it. Never commit it. Copied to the clone `~/Dev/lowerarchy/pantry` on 2026-11-18. |
| `output/shop-voice/`                         | 25 MB  | Journey and bench results that the plans cite. Copied to the clone `~/Dev/lowerarchy/pantry` on 2026-11-18.           |
| `.claude/launch.json`, `voice-recorder-p82c` | —      | The new clone has no `.claude/launch.json`. Add the entry with the new path if you use the recorder.                  |

### What stays where it is

These are outside the repositories, so the move does not change them:

- `~/.satyr-voice`: the installed Mac service, its model files and its certificate. The service
  runs from there, not from the checkout. Update it with `install.sh --update` from production.
- `~/.satyr-voice-test/wake/`: the wake model data, the training pipeline's inputs and the Kokoro
  files (1.7 GB with the G0.6 files). Step 5 needs it.

### Paths that change with the move

- The speech bench in seams-monorepo (`voiceId/stt-bench`, worktree
  `~/Dev/rust/seams-monorepo/.claude/worktrees/voiceid-stt-bench`, 31 GB with its `.cache`). The Mac
  journeys and `SHOP_VOICE_QWEN3` read the model files from its Hugging Face cache. The bench holds
  uncommitted work from the 2026-11-14 bake-off, so move it and do not delete it. After the move,
  run `git worktree repair` in seams-monorepo. Then give the new bench folder to
  `SHOP_VOICE_BENCH` (the Mac journeys) and its Qwen3-ASR folder to `SHOP_VOICE_QWEN3` (the
  benches).
- Playwright 1.64.1 in `~/Dev/rust/seams-wallet/node_modules/playwright`, for `PLAYWRIGHT_MODULE`.
  After the move, use the new seams-wallet path.
- The account Worker in `~/Dev/rust/seams-monorepo/.artifacts/shared-account-platform/account-worker/index.mjs`,
  for `SATYR_ACCOUNT_WORKER_ARTIFACT`. After the move, use the new seams-monorepo path.
- Claude Code keeps its project notes in a folder named after the checkout's path. A checkout at a
  new path starts with no notes. Today three folders hold separate copies, named after the clones
  `satyr`, `seams-atelier` and `pantry`, for example
  `~/.claude/projects/-Users-pta-Dev-lowerarchy-pantry/memory`. The `pantry` folder has the voice
  notes of 2026-11-18. Merge the three into the new project's `memory/` folder.

### What the Purin rename changes for voice

- The wake phrase: see step 5.
- The text that people see, for example "Seams Pantry shop voice" on the Mac and the Portal's
  voice prompts, follows the rename of all text.
- The shop Mac names. The Platform names each Mac `<id>.voice.<VOICE_DNS_ZONE_NAME>`, today
  `dd8267f68371.voice.seams.sh`, and `VOICE_DNS_API_TOKEN` can change only the `seams.sh` zone.
  Recommendation: keep the Mac names on `seams.sh`, because nobody types them. If the zone must
  change, the release needs a token for the new zone, new `VOICE_DNS_ZONE_ID` and
  `VOICE_DNS_ZONE_NAME` values, and a new enrollment of each Mac for a new name and certificate.
- Deployed names stay, as for Plan 91: the launchd label `sh.seams.satyr.shop-voice` and the folder
  `~/.satyr-voice`.

## How to check voice work

| Check                       | Command or file                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform journey            | `services/platform/tests/e2e/voice-control.test.ts` (needs `SATYR_ACCOUNT_WORKER_ARTIFACT`)                                                                               |
| Mac journey                 | `scripts/shop-voice/run-journey.py` (run `pnpm portal:build` first: it reads the install script from `apps/portal/dist`; `SHOP_VOICE_BENCH` names the bench after a move) |
| Chrome journey              | `scripts/shop-voice/run-portal-journey.py` (needs `PLAYWRIGHT_MODULE` and `SATYR_ACCOUNT_WORKER_ARTIFACT`)                                                                |
| Safari on the iOS Simulator | `scripts/shop-voice/run-safari-journey.py`                                                                                                                                |
| Noise bench                 | `scripts/shop-voice/confidence-bench.py`                                                                                                                                  |
| Real voices and D5          | `scripts/shop-voice/phrase-bench.py human <session>`; recorder: `pnpm --filter @seams/portal exec vite --config ../../scripts/shop-voice/recorder.vite.config.ts`         |

## Rules to keep

- Each release needs the owner's words. Order: the D1 patch on each regional database, then the
  Portal and the Platform, then `install.sh --update` on each Mac.
- Nothing voice-related downloads before a person turns voice on. Models load only when a voice
  session starts.
- Do not propose or measure other speech models unless the owner asks. Whisper is the owner's
  choice, and Qwen3-ASR is a measured option.
- Never train a wake model on macOS `say` voices, and never use openWakeWord's pre-trained models
  or features (CC BY-NC-SA). More synthetic voices cannot settle G0.4.
- The owner finds manual tests hard. Ask for one command or one page at a time.
- Recordings of voices stay on the Mac that made them, in `.cache/human/`.
