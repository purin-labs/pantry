# VOX-01 — Voice control

Voice control lets a baker give the Sous Chef agent in the Purin Pantry Portal a command
with no hands. A person says the wake phrase or holds a key, and then speaks. A small
model in the browser hears the wake phrase, and no audio leaves the device before it. The
Portal sends the command to a Mac in the shop. If the Mac does not answer, the Portal
sends the audio to the Platform, which uses Workers AI. The transcript enters the chat
through the send path of typed text, so the same policy, approval, receipt and
information-flow rules apply. Pantry keeps no audio. Voice control takes English commands.

## What it does

A **host** runs an engine: `shop_mac` or `workers_ai` (`ChatTranscriptionPath`). An
**engine** is one speech-to-text model with its settings and its noise rule. The
**fallback** is the path through the Platform to Whisper on Workers AI. A **grant** is a
short token that lets one member's device call one Mac.

### Turn voice on

- A member opens **Voice control** in the chat composer. The dialog says what happens to
  the audio, and that fallback audio can be processed outside the country.
- The setting is for one browser profile and one Organisation
  (`pantry.voice.on.<organisationId>` in `localStorage`). A reload keeps it.
- The Portal loads no voice file before a person turns voice on. It keeps the files in
  Cache Storage (`pantry-voice-v1`), and the dialog gives their size as about 17 MB.
  **Turn off** closes the microphone and deletes them.
- The microphone runs in mono, with echo cancellation and automatic gain on and noise
  suppression off. A member can choose the input device.
- One session for each Organisation works on every Portal page (`features/voice/host.ts`).
  A page mark shows that voice listens, needs a tap or stopped. Leaving the workspace
  closes the microphone, and the setting stays.
- In the chat, the composer's edge shows the state in the theme accent
  (`features/chat/composer-glow.tsx`): a thin ring breathes while voice listens for the
  wake phrase, a halo pulses while a person speaks, and one light crosses the edge while
  the command is transcribed and while the agent works. The mic button shows five bars
  (`features/voice/wave.tsx`). While a person speaks, the bars follow the loudness of the
  microphone stream that is already open. With reduced motion, the states only fade.
- One device listens in one tab (the Web Lock `pantry-voice-control`). While voice is on,
  the Portal asks the browser to keep the screen awake.
- The Portal counts wakes, near wakes, key holds, wakes with no command, and the texts
  that each host and engine kept or dropped. It keeps numbers only, on the device
  (`pantry.voice.counts`), for the 14 newest days that have counts. It has no age check,
  so a kept day can be older than 14 days. **Turn off** does not clear the counts. The
  dialog shows today and the last 7 days.
- If `voice.transcription` is off, an access prompt opens in place. A person who may
  change the policy can allow it. Another person sees that an owner or admin must allow
  it.

The session status is `off`, `starting`, `listening`, `capturing`, `transcribing`,
`needs_tap` or `blocked`. The reason of `blocked` is `other_tab`, `microphone`,
`voice_disabled` or `failed`.

### Start a command

An `AudioWorklet` gives the listening worker 80 ms chunks of 16 kHz mono audio. Silero VAD
reads all audio. The wake model runs only within 2 s of speech. Audio stays in the worker.
The worker holds at most 50 chunks (4 s). If the device cannot keep up, the worker drops
the oldest chunk, so a capture can lose audio with no message to the person.

- **Wake phrase.** The phrase in the code is "Hey Sous Chef" (`WAKE_PHRASE`), with the model
  `hey_sous_chef.onnx` (`WAKE_MODEL`). A score of at least 0.995 wakes the Portal. The worker
  scores only a full window of 16 embeddings.
- **Held key.** While the page has focus, a person holds Right Option (Right Alt on other
  systems), speaks and releases. The code also accepts Fn on a browser that reports it.
  The capture keeps 160 ms from before the press and runs 240 ms after the release.
- A press under 180 ms is silent. A press with Control, Command or Shift does not start.
  Another key or a lost focus gives up the command, and no audio leaves the device.
- A high tone (880 Hz) marks the start and a middle tone (660 Hz) the end. Two low tones
  (440 Hz) say that nothing goes.
- After a wake, the capture ends at 0.8 s of silence. If no speech comes in 4 s, it ends
  with the low tones. The longest capture for each start is 14.96 s.

### One command

1. The Portal encodes the capture as a WAV file: 16-bit PCM, 16 kHz, mono.
2. If the last check says that the Mac answers, the Portal posts the file to the Mac with
   its grant. It waits 1 s plus 0.3 s for each second of audio (`voiceMacDeadlineMs`).
3. If the Mac fails, is busy, has no loaded model or refuses the grant, the Portal posts
   the same file to the Platform. A late Mac answer is dropped, so one command gives one
   message. A `rate_limited` or `too_long` answer from the Mac is a refusal, with no
   fallback.
4. The Portal runs the text check. If no text stays, it plays the low tones.
5. The Portal reads the text as one of these commands:

| Command        | When                                                                                   | Effect                                                    |
| -------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `stop`         | The whole text is "stop" or "cancel"                                                   | The chat stops the turn and sends no message              |
| Stop, by sound | A turn runs, and one word is in the engine's `heardAsStop` list                        | The same                                                  |
| Confirm        | An approval card waits, and the text holds the card's noun at the end or before digits | The Platform checks the phrase. Nothing goes to the agent |
| `steer`        | The text starts with "change" or "instead"                                             | A `steer` command while a turn runs, else a message       |
| `send`         | Any other text                                                                         | A message when the agent is idle, else `next`             |

The message records `inputMode` with the host and the engine, and the timeline shows a
microphone mark. A spoken command leaves the person's draft and attached files as they
are. If the chat is closed, the command opens it beside the page, in the chat of the last
spoken command. If the chat is not ready in 10 s, the Portal speaks a refusal and sends
nothing.

The Portal checks the Mac every 30 s while voice is on, and every 3 s while its model
loads. The chat composer shows **Cloud** when the next command will use the fallback.

### The text check

`keptVoiceText` (`packages/control-api/src/voice-text-check.ts`) runs in the Portal on the
text of every host and engine. It drops a sentence with a subtitle credit. It also drops a
comma list when at least two parts, and at least half of the parts, are vocabulary names.
It drops the whole text if the text is only "Thank you", or if it repeats a phrase of up
to four words five times. So a spoken bare list of shop names is lost.

### Spoken answers

The Portal speaks the first two sentences of the answer as they arrive, and "More on
screen." for a longer answer. A wake phrase or a held key stops the speech. "Stop" or
"cancel" leaves the rest unspoken. If an answer changes after its start, the Portal speaks
the first two sentences of the new text. If the turn waits for a permission, the Portal
says "This needs your approval on the screen."

The Mac makes the speech at `POST /speech`, in the Kokoro `af_heart` voice. If it does not
answer in 5 s, or the device has not opened audio, the Portal uses the browser's voice.

### Spoken approvals

An approval card that a click can approve also shows a phrase while voice listens.

| Card (`target.kind`)  | Phrase                            |
| --------------------- | --------------------------------- |
| `configuration_draft` | "confirm change" and three digits |
| `slack_draft`         | "send message" and three digits   |
| `email_draft`         | "send email" and three digits     |

- The digits are three, five, six, seven and nine. The Portal shows and speaks the phrase.
- The Platform compares the words after `normalizeVoicePhrase`, which ignores case and
  punctuation and joins digits. Only an exact match passes.
- A match spends the phrase. The Portal then runs the card's own click, so the card's
  route keeps its role check and receipt. If that click fails, the card shows a new
  phrase.
- A phrase works one time, for one member, in one chat, for 30 minutes. Five refused
  checks spend it. A refused check counts on each open phrase of the member in the chat.
  The transcript of a refusal is not stored.
- A permission prompt stays click only. A commerce approval has no phrase and keeps its
  own step-up.

### The shop Mac

`services/shop-voice` is a Python service (version 0.5.2) for Apple silicon and macOS 14
or later. It runs as the `launchd` job `io.purin.pantry.shop-voice` from
`~/.pantry-voice`, in the session of the person who installed it. The install needs no
administrator.

1. An admin selects **Add a shop Mac**. Pantry makes a `vmac_…` id, a random name and a
   one-time code that ends after 15 minutes. It stores only the SHA-256 of the code.
2. The Portal shows one install command for the script at `/shop-voice/install.sh`.
3. The code gives the credential `svm1.<organisationId>.<macId>.<secret>` and the Mac's
   grant key. Pantry stores only the hash of the secret.
4. The Mac downloads the pinned engine and voice files, with resume and a SHA-256 check.
   It gets a Let's Encrypt certificate through a DNS-01 challenge and keeps the private
   key.
5. Every 60 s, the Mac sends its private address, version, model state and engines. The
   Platform never calls the Mac. If the address changes, the Platform updates the DNS
   name.

The Portal reaches the Mac at `https://<nameId>.voice.<zone>`. The DNS record holds the
Mac's private IPv4 address, and the Platform refuses a public address.

- The engine and the answer voice load at a member's `GET /health`, never when the
  service starts. `POST /speech` also starts the load of the answer voice. An engine
  change loads the new engine at once if the old engine was in memory, with no member
  check. Each model unloads 30 minutes after its last check or call.
- If more than one Mac is enrolled, a grant names only the Mac with the latest fresh
  heartbeat. If that Mac fails, the Portal uses the fallback until a new grant names
  another Mac.
- The Mac runs one command and holds two more. After that it answers `busy`.
- No audio goes to disk. No transcript or answer text goes to a log or to the Platform.
- The service keeps the Mac awake. It updates only with `install.sh --update`.
- At a revoke, the Platform clears the Mac's secrets and removes its DNS names. At the
  first refused heartbeat (a 401 answer), the Mac stops all answers. After five refused
  heartbeats, it deletes its models, certificate and credential and stays stopped. Only
  an accepted heartbeat resets the count. A 503 or a lost network does not reset it. The
  revoke dialog says this: the Mac stops within about one minute and deletes its files
  within about five minutes.

### Speech engines

| Engine id                | Hosts                    | Download            | Peak memory | Licence    |
| ------------------------ | ------------------------ | ------------------- | ----------- | ---------- |
| `whisper-large-v3-turbo` | `shop_mac`, `workers_ai` | 1,613,977,880 bytes | 2.48 GB     | MIT        |
| `qwen3-asr-1.7b`         | `shop_mac`               | 4,080,707,826 bytes | 4.98 GB     | Apache-2.0 |

- A new Mac runs Whisper (`DEFAULT_MAC_VOICE_ENGINE`). The fallback always runs Whisper
  (`CLOUD_VOICE_ENGINE`).
- An admin chooses each Mac's engine in the voice dialog, among the engines that its
  service reports. The heartbeat answer carries the choice (`engineChoice`).
- The Mac answers with its old engine until the new files are complete, and then changes.
  Only one engine is in memory. During the load, the Portal uses the fallback.
- The files of an unused engine stay for 14 days, so a change back needs no download.
- **Whisper rule:** a segment with `avg_logprob` under -1.4 or `compression_ratio` over
  2.4 is noise, on the Mac and on Workers AI. Workers AI also runs with `vad_filter`. On
  Workers AI, a segment with no `avg_logprob` is noise, and an answer with no segment
  list keeps its whole text with no noise rule.
- **Qwen3-ASR rule:** a text that compresses more than 2.4, or a decode that reaches 160
  tokens, is noise. The decode stops early when its first three comma parts are the first
  three vocabulary terms. It also stops when 60 or more characters compress more than 2.4.

### The shop vocabulary

`readVoiceVocabulary` builds one list for the Mac, the fallback and the text check. The
agent's names come first: "Sous Chef" and "Pantry". Then each source gives one
name in turn. The sources are published products (the menu first), active recipes, active
stock items, and devices with the enrollment `active` or `restricted`. The list holds at
most 60 terms and 600 characters. Whisper takes it as `initial_prompt`, and Qwen3-ASR as
its system prompt.

If a source fails, the route answers 503, so the Mac keeps its last list in memory. The
fallback waits at most 800 ms for the list, and then runs with no prompt.

### Agents

Sous Chef has no voice tool. A spoken command reaches it as a chat message. The tool
`device_read` (DEV-01) returns each shop Mac that is not revoked: `macId`, name,
enrollment, connection, `modelState`, `engine`, `engineChoice` and `needsAttention`. It
gives no network address. The agent cannot choose an engine, because a change downloads up
to 4.1 GB onto shop hardware and changes the model that hears spoken approvals.

## Contracts

### Regional D1 tables

| Table                     | Holds                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voice_mac`               | One Mac: `state` (`pending`, `enrolled`, `revoked`), `name_id`, code and credential hashes, last heartbeat, private address, service version, `model_state` (`none`, `downloading`, `unloaded`, `loading`, `loaded`), `engine`, `engines`, `engine_choice` |
| `voice_transcription_use` | One fallback call: member, device, start, finish and billed `audio_milliseconds`. It holds no text                                                                                                                                                         |
| `voice_confirmation`      | One phrase: member, chat, `target_kind`, `target_id`, `phrase`, `state` (`open`, `matched`, `spent`), `refused_attempts`, and the host and engine of a match                                                                                               |

The baseline is `workers/platform/migrations-regional/0001_current_schema.sql`. Voice
has no Actor SQLite table and no event kind. Its patch scripts are
`workers/platform/scripts/voice-*-d1-patch.sql`.

### Control routes

The routes (`surfaces/voice/server/routes.ts`) are under
`/v1/control/organisations/:id/voice`. A write needs the control session and the CSRF
header. A role refusal is a 404.

| Route                                | Role     | `voice.transcription` | Purpose                                                           |
| ------------------------------------ | -------- | --------------------- | ----------------------------------------------------------------- |
| `POST /grants`                       | Operator | Required              | The Mac's origin and a grant, or `mac: null`                      |
| `POST /transcriptions`               | Operator | Required              | The fallback. The header `x-pantry-voice-device` names the device |
| `GET /vocabulary`                    | Operator | Required              | The names for the text check                                      |
| `GET /confirmations?conversationId=` | Operator | Not read              | The member's receipts in one chat                                 |
| `POST /confirmations`                | Operator | Required              | The phrase of one card                                            |
| `POST /confirmations/check`          | Operator | Required              | Check a transcript: `matched` or `refused`                        |
| `GET /macs`, `POST /macs`            | Admin    | Not read              | List the Macs, or start an enrollment                             |
| `POST /macs/:macId/revoke`           | Admin    | Not read              | Revoke a Mac and remove its DNS names                             |
| `POST /macs/:macId/engine`           | Admin    | Not read              | Choose the engine of a Mac                                        |

The refusals are `voice_disabled` (403); `voice_device_invalid`, `voice_audio_invalid`,
`voice_confirmation_invalid` and `voice_engine_invalid` (400); `voice_mac_not_found`
(404); `voice_engine_unsupported` (409); `too_long` (413); `rate_limited` (429); and
`transcription_unavailable`, `voice_vocabulary_unavailable` and `voice_dns_unavailable`
(503).

The chat route (`surfaces/portal/server/control/routes/chat.ts`) answers `voice_disabled`
for a message with `inputMode` while the capability is off. So a valid Mac grant cannot
put a command in the chat.

### Mac routes

| Route                                                | Caller             | Purpose                                                               |
| ---------------------------------------------------- | ------------------ | --------------------------------------------------------------------- |
| `POST /v1/voice-macs/enroll`                         | Mac, with the code | The credential, grant key and name                                    |
| `POST /v1/voice-macs/heartbeat`                      | Mac                | Address, version, model state, engines. The answer has `engineChoice` |
| `GET /v1/voice-macs/vocabulary`                      | Mac                | The shop vocabulary                                                   |
| `PUT`, `DELETE /v1/voice-macs/certificate-challenge` | Mac                | The DNS-01 TXT record                                                 |
| `GET /health` on the Mac                             | Portal             | Model state, `busy`, version, engine. It starts the model load        |
| `POST /transcriptions` on the Mac                    | Portal             | A WAV file, answered with `{ text, audioSeconds, engine }`            |
| `POST /speech` on the Mac                            | Portal             | `{ text }`, answered with a WAV file                                  |

The Platform routes are in `surfaces/voice/server/mac-routes.ts`. The Mac serves
HTTPS on port 443 (`shop_voice/server.py`) and admits only a listed Portal origin and a
valid grant. Its refusal codes are `origin_refused`, `grant_refused`, `rate_limited`,
`too_long`, `audio_invalid`, `speech_invalid`, `busy`, `model_not_ready` and `not_found`.

A grant is `vg1.<payload>.<signature>`, signed with HMAC-SHA-256. Each Mac has its own
key, which HKDF derives from `DATA_ENCRYPTION_ROOT`. The Mac checks the grant with no call
to the Platform. A grant has no authority at the Platform.

### Capability and configuration

- The capability `voice.transcription` is in
  `foundation/authority/authorization/capability-catalogue.ts`, with the modes `enabled`
  and `disabled`. A new Organisation has it enabled. An Organisation with no policy row
  gets a disabled row from `scripts/capability-policy-backfill-sql.mjs`.
- The Worker binds Workers AI as `AI` and calls `@cf/openai/whisper-large-v3-turbo`, with
  no AI Gateway.
- `VOICE_DNS_ZONE_ID`, `VOICE_DNS_ZONE_NAME` and `VOICE_DNS_API_TOKEN` configure the Mac
  names. Without them, no Mac can enroll, and every command uses the fallback.

### Code

| Part                                          | Path                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Shapes, engine catalogue, text check          | `packages/control-api/src/voice.ts`, `voice-engines.ts`, `voice-text-check.ts`             |
| Platform routes, records, engine, Mac rows    | `workers/platform/src/voice/`                                                              |
| Portal session, path choice, commands, dialog | `surfaces/voice/ui/features/voice/session.ts`, `transport.ts`, `command.ts`, `control.tsx` |
| Listening worker and its files                | `surfaces/voice/ui/features/voice/wake-worker.ts`, `apps/portal/public/voice/`             |
| Chat send of a spoken command                 | `acceptVoiceCommand` in `surfaces/portal/ui/features/chat/route.tsx`                       |
| Mac service and engines                       | `services/shop-voice/shop_voice/`, `shop_voice/engines/`                                   |
| Journeys, benches, wake model tools           | `scripts/shop-voice/`, `scripts/plan-82-g04/`                                              |

## Rules and limits

### Permissions

| Action                                                                    | Viewer | Operator                 | Admin and owner               | Agent                          |
| ------------------------------------------------------------------------- | ------ | ------------------------ | ----------------------------- | ------------------------------ |
| Get a grant, use the fallback, read the vocabulary, get or check a phrase | No     | Yes                      | Yes                           | No                             |
| Put a spoken command in the chat, or stop a turn                          | No     | No                       | Yes                           | No                             |
| Confirm a card with a phrase                                              | No     | The card's route decides | The card's route decides      | No                             |
| List, enroll or revoke a Mac, choose its engine                           | No     | No                       | Yes                           | No                             |
| Read the Macs on the Devices page                                         | Yes    | Yes                      | Yes, with the network address | `device_read`, with no address |

A shared device acts as its signed-in member: each voice near it can give that member's
commands.

### Time limits and retention

| Limit                                                | Value                                        | Constant                                                                                               |
| ---------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Wake score, near wake, wake model after speech       | 0.995, 0.9, 2 s                              | `WAKE_THRESHOLD`, `NEAR_WAKE_SCORE`, `NEAR_SPEECH_MS`                                                  |
| End of a command, no speech, longest capture         | 0.8 s, 4 s, 14.96 s                          | `END_SILENCE_MS`, `NO_SPEECH_MS`, `CAPTURE_LIMIT_MS`                                                   |
| Shortest hold, tail after a release                  | 180 ms, 240 ms                               | `HOLD_MINIMUM_MS`, `HOLD_RELEASE_TAIL_MS`                                                              |
| Mac check, during a load, its timeout                | 30 s, 3 s, 3 s                               | `CHECK_MS`, `CHECK_WHILE_LOADING_MS`, `CHECK_TIMEOUT_MS`                                               |
| New grant margin, Mac voice wait, chat open wait     | 2 minutes, 5 s, 10 s                         | `GRANT_MARGIN_MS`, `SPEECH_DEADLINE_MS`, `OPEN_WAIT_MS`                                                |
| Grant, enrollment code, Mac counts as answering      | 10, 15, 3 minutes                            | `VOICE_GRANT_TTL_MS`, `CODE_TTL_MS`, `MAC_HEARTBEAT_FRESH_MS`                                          |
| Audio, fallback body, commands for each member       | 15 s, 481,024 bytes, 60 in 10 minutes        | `VOICE_AUDIO_SECONDS_LIMIT`, `VOICE_BODY_BYTE_LIMIT`, `VOICE_REQUEST_LIMIT`, `VOICE_REQUEST_WINDOW_MS` |
| Open fallback call, vocabulary wait, Workers AI wait | 60 s, 800 ms, 20 s                           | `IN_FLIGHT_MS`, `VOCABULARY_WAIT_MS`, `CALL_DEADLINE_MS`                                               |
| Vocabulary cache, DNS record TTL                     | 5 minutes, 60 s                              | `CACHE_MS`, `RECORD_TTL_SECONDS`                                                                       |
| Phrase, refusals before a new phrase                 | 30 minutes, 5                                | `PHRASE_TTL_MS`, `REFUSALS_BEFORE_NEW_PHRASE`                                                          |
| Device counts, use rows, unused engine files         | 14 newest days with counts, 90 days, 14 days | `COUNT_DAYS`, `USE_RETENTION_MS`, `UNUSED_ENGINE_SECONDS`                                              |
| Mac heartbeat, vocabulary read, model unload         | 60 s, 5, 30 minutes                          | `DEFAULT_HEARTBEAT_SECONDS`, `VOCABULARY_SECONDS`, `DEFAULT_IDLE_UNLOAD_SECONDS`                       |
| Mac slots and queue wait: commands, voice            | 3 and 6 s, 2 and 5 s                         | `COMMAND_SLOTS`, `COMMAND_QUEUE_WAIT_SECONDS`, `ANSWER_SLOTS`, `QUEUE_WAIT_SECONDS`                    |
| Mac model answer, spoken answer text                 | 30 s, 1,000 characters                       | `ANSWER_TIMEOUT_SECONDS`, `SPEECH_TEXT_LIMIT`                                                          |
| Refusals before a wipe, certificate renewal          | 5, 30 days                                   | `REFUSALS_BEFORE_WIPE`, `RENEW_BEFORE_SECONDS`                                                         |

- The Mac and the Platform count the 60 commands separately. The Mac also counts spoken
  answers in their own window of the same size.
- The fallback admits one open call for each member and device. A second call within 60 s
  of an unfinished call gets `rate_limited` (429), also under the limit of 60.
- The end of a fallback call deletes the use rows of that Organisation that are older than
  90 days. A `voice_confirmation` row stays until the Organisation's purge.
- **End of an Organisation.** The archive cleanup revokes each Mac and tries to remove its
  DNS names. The purge repeats the removal, and it stops and tries again if DNS fails,
  because the voice rows hold the only list of the names. It then erases the three tables
  (`areas/organisation/server/data/onboarding-reconciliation.ts`).

### Information flow

- The transcript is the member's own input. It enters the turn through chat admission.
- The vocabulary holds names that every member reads from the viewer role up. It goes only
  to the Mac, to Workers AI and to the Portal's text check, so it adds no flow label.
- The code has no flow label and no destination check on the vocabulary. Plan 82 requires
  both before a restricted source joins the list.
- The Portal takes the Mac's text with no signature, so an enrolled Mac can read and
  change each transcript. The `voice_confirmation` row names the host and the engine of a
  match. A phrase covers only the three card kinds in "Spoken approvals".

### Boundaries

- **FND-05** owns chat messages. Voice adds only the `inputMode` part.
- **FND-06** owns the capability policy and approvals. A phrase replaces no step-up.
- **FND-07** owns information flow, and **FND-09** owns the agent tools and page context.
- **DEV-01** owns the Devices page, which only reads the Mac rows. **PRT-01** owns the
  Portal.
- **ENG-03** owns names.
- **[Plan 82B](../../../plan-82B-ambient-voice.md)** stays a plan. It owns commands with
  no wake phrase or key: the follow-up window, ambient mode and the speaker check.

**Out of scope.** Voice has no speaker verification, no voice step-up and no streaming
transcription. It does not transcribe Slack audio, and it runs no speech-to-text in the
browser. It uses no cloud speech provider other than Workers AI. No switch turns off the
fallback. `install.sh` refuses a machine that is not Apple silicon with macOS 14 or later.
The talk key works only while the page is in front.

## Open work

- **Real use.** No full shift ran in a shop. Real phones and tablets, shop Wi-Fi and
  routers, three bakers at one time and a microphone at 2 m are not proven.
- **Accuracy gates.** Real approval phrases with a mixer on are not measured. The wake
  limits are also open: 95% heard at 1 m, and at most one false wake in 8 hours.
- **Live checks.** The 6 s fallback limit at p95 and a live command on each host are open.
- **Mac enrollment.** The handover records no Mac on this stack and no token for its zone.
- **Wake phrase.** The "Hey Sous Chef" model fails the macOS voice check of
  `scripts/plan-82-g04/compare.py` (53.3% heard against 66.5% for "Hey Satyr"), and no
  recording of real voices has scored it (`scripts/plan-82-g04/real-voices.py`). The
  owner's first wake in production worked.
- **Qwen3-ASR as the default.** It needs a room-sound recording in a shop and a week of
  use. If it passes, the Platform writes Qwen3-ASR as the choice of each new Mac.
- **Japanese.** Not built. It needs a latency measure, `language: "ja"` and a phrase bank.
- **Small checks.** A real Fn key press and the talk key with a real microphone are open.
  So are Safari on a real iPhone or iPad and one spoken approval in the deployed Portal.
- **Fallback region.** Plan 82 found no page that names the Workers AI regions.
- **Smaller Macs.** Plan 82C measured the engines on an M4 Pro. A Mac with less memory is
  not measured.
- **Known faults in the code:**
  - The chat routes need the admin role, but the voice routes admit an operator.
  - With no commerce merchant binding, the vocabulary read answers 503, so the
    Organisation has no shop vocabulary, not even the agent's names.
  - A failed DNS removal at a revoke is not tried again before the end of the
    Organisation.
  - Each Mac heartbeat writes one D1 row, also when nothing changed.
  - A heartbeat answer that is not JSON stops the service until `launchd` restarts it.
  - A heartbeat 401 does not always mean a revoke. The Platform also answers 401 if the
    Organisation scope does not resolve, for example at a placement conflict, or if a
    `VOICE_DNS_*` setting is missing. After five such answers, an enrolled Mac deletes
    its files and needs a new enrollment.

## Sources

- [Plan 82](../../../history/plan-82-portal-voice-control.md), [Plan
  82C](../../../history/plan-82C-speech-engines.md) and [the voice
  handover](../../../plan-82-voice-handover.md). Where they differ from the code, this
  spec follows the code. Background: [Plan 82B](../../../plan-82B-ambient-voice.md).
- Evidence in the archive: [Plan 82 Phase 0](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-82-phase-0.md).
- E2E journeys in `workers/platform/tests/e2e/`: `voice-control.test.ts`,
  `devices-page.test.ts` and `device-agent.test.ts`.
- Journeys in `scripts/shop-voice/`: `run-journey.py` (the Mac), `run-portal-journey.py`
  (Chrome) and `run-safari-journey.py` (the iOS Simulator). Benches:
  `confidence-bench.py`, `phrase-bench.py`, `speech-gate.py`, and
  `scripts/plan-82-g04/compare.py`.
