# Plan 82 — Portal voice control

Status (2026-11-18): Phases 0–3 and the later decisions D9–D12 are in production. Phase 4 waits
for a shop: its gates need the owner's shift in a shop, and the owner has no shop yet
(2026-11-17). Phase 5 has not started. The repository is now `purin-labs/pantry`
([Plan 94](plan-94-purin-labs-organisation.md)). [The voice handover](../plan-82-voice-handover.md)
lists the remaining steps of this plan, [Plan 82B](../plan-82B-ambient-voice.md) and
[Plan 82C](plan-82C-speech-engines.md), and the local state that a new clone lacks.

What production has:

- The wake phrase "Hey Satyr" and hold-to-talk (D10) in the Portal, on every page (D12).
- The shop Mac service 0.5.1 with Whisper, and Qwen3-ASR as a manager's choice
  ([Plan 82C](plan-82C-speech-engines.md)). Whisper on Workers AI is the fallback (D1).
- Spoken approvals (Phase 3), the Mac's answer voice (D9), and the noise rules and device counts
  (D11).
- One enrolled Mac: the owner's MacBook Pro as a test Mac, on Whisper.

What is not proven: no signed-in production journey ran. No real phone or tablet, no shop network
and no real shift used voice. The owner's real voice ran two commands on 2026-11-02 and the
Plan 82C recordings on 2026-11-16, both away from a shop.

Fault found and fixed on 2026-11-18: from the Plan 91 release to the fix, voice could not start
in production on a device that did not already keep the wake model in its cache. The Plan 91 rename moved `apps/portal/public/voice/hey_satyr.onnx`
to `hey_atelier.onnx`, but the wake worker loads `/voice/hey_satyr.onnx`. Production answers that
path with the Portal page and status 200, so the worker fails and the Portal shows that voice
stopped. The fix (dev `6a3058272`) restores the file name, because the model hears "Hey Satyr".
The model cache now also refuses a Portal page, and it fetches again a page that a device kept.
It is in production since 2026-11-18 02:34 UTC (`satyr-edge` `b30cd3c3`; the voice handover,
"The wake model fault").

Releases: Phase 3 in `satyr-edge` `6e713b13` (2026-11-04). D11 and D12 in `d7aae606`
(2026-11-14 02:09 UTC, ref `refs/backup/released-2026-11-14-voice-gaps`). Plan 82C in
`bdd553b2`, `f40050b1`, `5f0e9637` and `c25e66dd` (2026-11-15 and 2026-11-16). The Plan 91 release
`347178c4` carried all of it to the new repository with the fault above, and `b30cd3c3` fixed
the fault.

## Result in one paragraph

A baker can give the Portal chat agent a command by voice, with no hands. The
baker says "Hey Satyr" and then the command. A small model in the browser
hears the wake phrase; no audio leaves the device before it. The Portal sends
the spoken command to a Mac in the shop, which transcribes it with Whisper
large-v3-turbo, MLX and the shop vocabulary. The audio stays in the shop. If the
Mac does not answer, the Portal sends the audio to the Platform, which uses the same
model on Workers AI. The transcript goes into the chat
through the same send path as typed text, so the same Case, policy, approval,
receipt and information-flow rules apply. The Portal speaks the agent's answer.
For an action that needs approval, the baker says a displayed phrase, and only
an exact match approves. This release takes English commands. Japanese follows
on Whisper in Phase 5.

## Problem

In a bakery, the baker's hands are covered in flour or dough for most of the
shift, and the baker moves between the bench, the mixer, the oven and the
shop. The baker cannot type or touch a screen. Plan 81 lets the Portal chat agent do what a
person can do on a Portal page, but every
command still starts with typed text. So almost every command must be spoken.

The conditions are hard for speech-to-text: a mixer or oven fan runs, people
talk in the shop, the speaker moves, and the device can be 1–3 m away.

## Evidence so far

The speech bench is in the Seams monorepo, `voiceId/stt-bench`. It used
synthetic voices (macOS `say`) with recorded kitchen, café and motor noise. The
Whisper column is MLX on an M4 Pro. Whisper on Workers AI has equal accuracy
([G0.1](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-82-phase-0.md)).

| Measure                                                          | Whisper large-v3-turbo        | Best other model                                         |
| ---------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| English bakery dictation, word errors, clean / 0 dB              | 8.8% / 13.2%                  | Moonshine Medium 16.3% / 26.1%                           |
| Same, with the shop vocabulary as a prompt                       | 5.8% / 9.7%                   | Moonshine Medium 15.3% / 25.3%                           |
| Correct approval phrase accepted, clean / 10 / 5 / 0 dB          | 97.9% / 94.4% / 86.8% / 81.9% | Voxtral 4B Realtime 4-bit: 89.6% / 80.6% / 76.4% / 64.6% |
| Near-miss phrase accepted (negation, verb, detail, missing word) | 0 of 1,920                    | 0 of 1,920                                               |
| Japanese bakery dictation, character errors, clean               | 4.8% (2.8% with vocabulary)   | Moonshine Tiny 6.2%                                      |

EmbeddingGemma 2 gives no transcript and accepted at most 40% of correct
phrases. The bench did not measure real voices, a moving speaker, distance, or a
wake word.

| Whisper on the path                       | M4 Pro with MLX, no network | Workers AI in Tokyo               |
| ----------------------------------------- | --------------------------- | --------------------------------- |
| End of audio to transcript, p50 / p95     | 0.48 s / 0.49 s (max)       | 1.57 s / 3.93 s, 2.04 s / 5.71 s  |
| Memory held while loaded                  | About 2.5 GB                | None on the shop's devices        |
| CPU at idle                               | 0.01% of one core           | None on the shop's devices        |
| Audio leaves the shop                     | No                          | Yes                               |

## What exists and stays

| Part                                                    | Where                                                                     | Use in this plan                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| Portal chat send: message, steer, next, cancel          | `apps/portal/src/features/chat/api.ts` (`sendChat`, `cancelChat`)         | A spoken command uses the same commands          |
| Chat route and input admission                          | `services/platform/src/chat/application.ts`, `input-admission.ts`         | Admits a spoken command like typed text          |
| Agent control of Portal pages                           | Plan 81                                                                   | What a spoken command can do                     |
| Approval evidence and receipts                          | `services/platform/src/approval-authentication.ts`                        | Spoken confirmation adds a detail, not a step-up |
| Capability policy: enabled, approval required, disabled | `authorization/capability-catalogue.ts`, `organisation_capability_policy` | One new capability: voice transcription          |
| Information-flow kernel                                 | `services/platform/src/policy/information-flow/`                          | Vocabulary sources and the transcript label      |
| Access prompts in context                               | `features/chat/permission-prompt.tsx`, Plan 81                            | The microphone and voice opt-in prompts          |
| Voice opt-in and lazy models                            | Owner rule for every voice feature                                        | No model downloads before the person opts in     |

Phase 1 adds the Workers AI binding. Plan 37 stores Slack audio and
transcribes nothing; this plan does not change that.

## Decisions

**D1. Where speech-to-text runs (accepted 2026-10-31).** Whisper large-v3-turbo
with MLX on a Mac in the shop. The fallback is the same model on Workers AI
(`@cf/openai/whisper-large-v3-turbo`), called from the Platform Worker through a
Workers AI binding. Reasons: the Mac answers three to four times sooner at the median
with the same accuracy, it keeps the audio in the shop, and the baker's device
downloads no speech model. The fallback price is $0.000513 for each audio minute.
Rejected: Workers AI alone (slower, and no page names its regions), Whisper in the
browser (563 MB download for each device and browser profile), Voxtral (less
accurate and slower), and Deepgram (the owner does not accept its training terms;
[the measure](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-82-phase-0.md) stays as a record).

**D1a. The latency limits (accepted 2026-10-31).** Each limit is at p95, from the
end of the audio to the transcript.

- Mac: 1.5 s through the shop network. The M4 Pro takes 0.48 s at the median and
  0.49 s at most with no network. G0.6 measures the real path.
- Fallback: 6 s from the start of the Workers AI request. The measured p50 / p95 in
  Tokyo are 1.57 s / 3.93 s and, in a repeat run, 2.04 s / 5.71 s.

From the end of speech to the start of the agent's answer, the Mac path takes about
3.8–4.3 s at the median, with 0.8 s of silence and the agent's first text after
2.5–3.0 s. The fallback takes about 5.5 s at the median and 9–9.5 s at p95.

**D1b. When the fallback runs (accepted 2026-10-31).** The fallback runs only after
the Mac fails, never at the same time, so that audio leaves the shop only when it
must. The Portal checks the Mac every 30 s while voice control is on.

- If the last check failed, the Portal goes to the fallback at once.
- If the Mac gives no answer in 1 s plus 0.3 s for each second of audio, the Portal
  stops the request and uses the fallback. For a 3 s command, the wait is 1.9 s. A
  command can then take about 7.6 s at p95.
- If the Mac refuses because it is busy or has no loaded model, the Portal uses the
  fallback at once.
- If the shop has no enrolled Mac, every command uses Workers AI.

The chat panel shows "Cloud" on the microphone mark when the next command will
use the fallback. A refusal from the Platform's policy is not a fallback case.

**D2. How a command starts (accepted 2026-10-30).** A wake phrase, detected
on the device. The microphone stays open while voice control is on, but audio
stays in the browser until the wake phrase. Talk between staff and customers
never reaches the agent or the Platform.

**D3. The wake phrase.** Recommendation: "Hey Satyr". A phrase of three
syllables gives fewer false wakes than one word. Cost: none. Default: "Hey
Satyr".

**D4. Audio retention.** Recommendation: keep no audio. The Mac or the Platform
transcribes the command and drops the audio; the transcript is the chat
message. The Mac holds the audio in memory only. Cost: a misheard command cannot
be played again; the timeline shows
the text that the agent received. Default: no audio.

**D5. Who can use voice.** Recommendation: every member who can use the Portal
chat agent, with the Organisation's capability policy as the off switch.
Cost: none. Default: every chat member.

**D6. English first (accepted 2026-10-31).** Phases 1–4 build and release only
English commands. Phase 5 adds Japanese on the same model. The route asks for
`language: "en"` on each call, on the Mac and on the fallback, and the voice control
setting says that it takes English commands. Japanese speech in this release gives
a wrong transcript. Whisper latency in Japanese is not measured, so Phase 5 starts
with that measure.

**D7. Which Mac.** Recommendation: one M4 Pro for each shop, because this is the
only Mac that is measured. A shop that has one uses it, also with other work on it:
the measure ran at a machine load of 7–14. Cost: none for a shop that has one. A new
Mac mini M4 Pro lists at ¥218,800, about ¥4,560 a month over four years (price from
third-party lists, read 2026-10-31). Default: M4 Pro. A smaller Mac needs its own
measure before use.

**D8. The path from the browser to the Mac.** The Portal is an HTTPS page, so it
cannot call a plain name on the shop network. Recommendation: each Mac has a random
public name under a zone that Satyr owns, such as `<id>.voice.<zone>`. The name's
DNS record holds the Mac's private address, and the Mac holds a real certificate
through a DNS-01 challenge. The private key stays on the Mac. Cost: the Platform
writes DNS records, and a router that drops public names with private addresses
blocks the path, so that shop uses the fallback until a person changes the router.
Default: this design, subject to G0.6. Rejected: plain HTTP to the private address
(audio crosses the shop Wi-Fi with no encryption), a tunnel (audio leaves the shop
and takes a longer path), and a certificate installed on each device.

## Design

### One command

1. **Opt in.** A member turns on "Voice control" in the chat panel. The text
   says that a command's audio goes to the Mac in the shop. It also says that, if
   the Mac does not answer, the audio goes to the transcription service and can be
   processed outside the country. The Portal asks for the microphone and, where the
   browser requires it, for local network access. It then downloads the wake-phrase and
   speech-detection models (a few MB) into Cache Storage. Off deletes them.
   The setting is for one member on one device.
2. **Listen.** An `AudioWorklet` reads 16 kHz mono audio into a 2 s ring
   buffer. A speech-detection model (VAD) runs first; the wake-phrase model
   runs only on speech. Nothing is sent and nothing is stored. The chat panel
   and the page header show a microphone mark while voice control listens.
3. **Wake.** After "Hey Satyr", the Portal plays a short tone and shows
   "Listening". The command can follow in the same breath.
4. **Capture.** The Portal records until 0.8 s of silence, for a maximum of
   15 s, then plays a second tone. If no speech follows the wake phrase in
   4 s, it plays a third tone and goes back to listening.
5. **Transcribe.** The Portal posts the audio (a WAV file with 16-bit PCM,
   16 kHz, at most 15 s, about 480 KB) to the Mac with its voice grant. The Mac
   transcribes it and returns the text. If the Mac does not answer, the Portal posts
   the same audio to the Platform (D1b). A late answer from the Mac is dropped, so
   one command gives one message. Limits: D1a.
6. **Send.** The Portal sends the transcript with `sendChat`, with the same
   rules as typed text: a new message when the agent is idle and `next` when
   it works. A command that starts with "change" or "instead" is `steer`, the
   spoken form of the steer key. If the whole transcript is "stop" or "cancel", the Portal
   calls `cancelChat` and sends no message. The message records
   `inputMode: "voice"` and the transcription path (`shop_mac` or `workers_ai`); the
   timeline shows a microphone mark on it.
7. **Answer.** The Portal speaks the first two sentences of the agent's answer
   as each one arrives in the stream, then "More on screen" when the answer is
   longer. A closing sentence plays after them and does not cut them. A new wake
   phrase or a held key stops the speech, "stop" or "cancel" leaves the rest
   unspoken, and an answer that changes after its start plays in full. A
   sentence that arrives while the person speaks waits for the next text.
   Only the reply reaches the stream, so work before the reply stays silent.

### The shop Mac service

A small Python service on the Mac runs under `launchd`. It pins `mlx_whisper`
0.4.3 and one model snapshot, and uses the bench settings: `temperature` 0,
`condition_on_previous_text` off, `language: "en"` and the vocabulary as
`initial_prompt`.

- **Enrollment.** A member who manages the Organisation opens the voice setting. The
  Portal shows the install command, the download size (1.6 GB) and the licence. A
  one-time code gives the Mac an enrollment credential. That credential can only
  send the heartbeat, read the vocabulary and ask for the certificate challenge. The
  same member can revoke it.
- **Model files.** The model downloads only after enrollment, with resume and a
  SHA-256 check. Off or removal deletes the files.
- **Model memory.** The model loads when a member's Portal first checks the Mac,
  never when the Mac starts. It unloads 30 minutes after the last check. The first
  check starts a load, so the first command uses the fallback only if it comes before
  the load ends. The measured load is 16–17 s for the first time after the install and
  1.5 s after that. A restart of the Mac is not measured.
- **Heartbeat.** Every 60 s the Mac tells the Platform its private address, its
  version and its model state. The Platform never calls the Mac. If the address
  changes, the Platform changes the DNS record, with a TTL of 60 s.
- **Requests.** The Mac takes `POST /transcriptions` and `GET /health` over HTTPS
  from the Portal's origin only. It transcribes one command at a time and holds at
  most two more. It answers `busy` after that. It keeps the 15 s limit and the
  limit of 60 requests for each member in 10 minutes.
- **Storage and logs.** No audio goes to disk. No transcript goes to a log or to the
  Platform from the Mac. Only the Portal receives the transcript.
- **Power.** The service stops the Mac from going to sleep while it runs. A wired
  network connection is recommended.

### The Platform routes

`POST /v1/control/organisations/:id/voice/grants` and
`POST /v1/control/organisations/:id/voice/transcriptions`, with the control
session and the CSRF header, as for the chat route. The second route is the
fallback.

- Checks: a signed-in member of the Organisation, chat access, and the
  `voice_transcription` capability enabled. A refusal raises the access prompt
  in context.
- Grant: the Mac's address name and a token signed by the Platform for one member,
  one device and one Mac, with an expiry of 10 minutes. The Mac checks the signature
  and the expiry with no call to the Platform. The token has no authority at the
  Platform. The Portal gets a new one while voice control is on.
- Off switch: the capability stops new grants. The chat route also refuses a message
  with `inputMode: "voice"` when the capability is off, so the agent receives nothing
  at once, also while a grant is still valid.
- Limits: one request at a time for each member and device; at most 15 s of
  audio; at most 60 requests for each member in 10 minutes.
- Vocabulary: at most 60 terms and 600 characters (Whisper reads at most 224
  prompt tokens). "Satyr" comes first. Then each source gives one name in turn,
  so a long menu does not push out the ingredients: the published products (the
  menu first), the active recipes, the active stock items, and the devices that
  a person confirmed on the Devices page. Every member reads these names from the
  viewer role up, on the order page, Recipes, Ingredients & supplies and Devices.
  The list goes only to the enrolled Mac and to Workers AI, and no person reads
  it back, so it adds no information-flow label (2026-11-13). If a source fails,
  the route answers 503, so the Mac keeps its last whole list; a short list would
  replace it for five minutes. Supplier and staff
  names come later through the information-flow guide's "Add a source" steps.
  The Mac and the fallback use the same list.
- Call: `env.AI.run("@cf/openai/whisper-large-v3-turbo", …)` with `audio`,
  `language: "en"`, `initial_prompt` (the vocabulary) and `vad_filter`. The call
  never goes through AI Gateway (G0.5).
- Result: the text and the audio seconds. The Platform stores no audio and
  writes no transcript to logs. It records the audio seconds for cost.
- Errors: a typed refusal (`voice_disabled`, `too_long`, `rate_limited`,
  `transcription_unavailable`). The Portal speaks a short sentence for each
  one.

The request and response shapes live in `@seams/control-api`.

### Spoken confirmation of approvals

An approval card that a click can approve can also show a phrase: an action and
three digits, for example "send message three five nine". The Portal
speaks the phrase. The baker says it after the wake phrase. The Mac or the fallback
transcribes it. The Platform checks the transcript, and only an exact match after
normalization approves. A negation, another action word or other digits refuses,
and the card stays open.

- The phrase bank follows the bench rules: common words and numbers, no
  names, and no two action words that sound alike in one bank.
- A spoken confirmation has the same authority as a click in the same
  control session. The approval receipt records the phrase, the match and the
  transcription path.
- An action that needs a step-up (passkey, Google, Slack link) keeps its
  step-up. A voice step-up with speaker verification (Seams VoiceID) is not in
  this plan.

### Information flow

The transcript is the member's own input, like typed text, and enters the
turn through the existing chat admission. In Phase 1 the vocabulary contains
only unrestricted names, so it adds no label. A later restricted vocabulary
source joins its label into the transcript's label, and the chat admission
checks it like any other source. That source must also pass a destination check
for the Mac, because the Mac stores the vocabulary.

### Microphone and devices

The Portal lists the input devices and remembers the member's choice. A
wearable wireless microphone is the recommended setup; a device microphone at
2–3 m from a mixer is not measured. A shared device acts as its signed-in
member, like a shared keyboard: every voice near it can give that member's
commands. The step-up rules above protect money and records.

## Cost

Estimate: 30 minutes of commands for each baker on each day. Workers AI bills only
the audio that goes to the fallback, because the wake phrase stays on the device.

| Item                                    | For each baker on each day | For each baker in a month |
| --------------------------------------- | -------------------------- | ------------------------- |
| Whisper with MLX on the Mac             | About 6 minutes of GPU     | Price of the Mac (below)  |
| Whisper on Workers AI, if all fall back | At most $0.015             | At most $0.46             |
| Wake phrase and VAD                     | Device CPU only            | –                         |
| Spoken answers                          | Mac CPU, or browser        | –                         |
| Audio storage                           | None (D4)                  | –                         |

The Mac is a cost for each shop, not for each baker: no cost if the shop has one,
and about ¥4,560 a month over four years for a new M4 Pro (D7). The Mac costs more
than Workers AI. The reasons for it are latency and audio that stays in the shop.

The Mac holds about 2.5 GB of memory while the model is loaded and 1.6 GB of disk.
It uses 0.06 of a CPU core while it transcribes and 0.01% of one core at idle. Its
power use is not measured.

## Phases

### Phase 0 — Measure before code

- **G0.1 Workers AI accuracy.** Run the bench sets through Workers AI:
  `approval_en_v2`, `dictation_en` with and without the vocabulary, and the
  Japanese sets. Pass: correct phrases within 2 points of the MLX result at
  each noise level, and 0 near misses accepted. Cost: about $0.20 of audio.
- **G0.2 Fallback latency from Tokyo.** Measure the time from the end of a 3 s command
  to the transcript, through the deployed Platform. Pass: p95 at most 6 s (D1a).
  Record the Workers AI location that served the requests.
- **G0.3 Real voices.** The owner records the English bench prompts with
  `record.py` in two conditions, quiet and mixer, each with a wearable
  microphone and with the device microphone at 2 m. Whisper with MLX and Whisper on
  Workers AI transcribe the recordings. Pass on each path: at least 90% of correct phrases accepted in the mixer
  condition with the wearable microphone, and 0 near misses accepted.
- **G0.4 Wake phrase.** Train a "Hey Satyr" model. Measure it on recordings
  of a bakery shift with talk, radio and machines. Pass: at most one false
  wake in an 8-hour shift, and at least 95% of wake phrases heard at 1 m in
  the mixer condition. Check the licence of the engine, of any pre-trained
  model and of every training input before release.
- **G0.5 Data terms.** Confirm the Workers AI data terms for audio and the
  regions where inference runs. Record the result in this plan.
- **G0.6 The path to the Mac.** Serve a test HTTPS page from a public origin. Post a
  3 s command to the M4 Pro through the D8 name and certificate, on the shop's real
  network. Use Chrome on a tablet and on a phone, and Safari on an iPad and on an
  iPhone, each over Wi-Fi. Record the permission prompts, the effect of iCloud
  Private Relay and the effect of the shop router on the DNS answer. Measure three
  bakers at the same time. Pass: p95 at most 1.5 s from the end of the audio in at
  least one Chrome and one Safari setup that a shop can use, and no audio on the
  network with no encryption. Also measure the fallback when the Mac is off or hangs.

If G0.1, G0.2 or G0.6 fails, stop and return to D1 with the numbers.

Result for G0.6 so far (2026-10-31, [evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-82-phase-0.md)): the test
is in `scripts/plan-82-g06/`. In Chrome on the M4 Pro itself, with no Wi-Fi between
them, p95 is 0.50 s for one baker and 1.49 s for three bakers with no pause.

Result for G0.6 on 2026-11-01: the D8 name and a Let's Encrypt certificate work from this
Mac, and 3 commands with `curl` take 0.43–0.47 s. Chrome 156 holds the page's request
until a person allows local network access. The first device run left no result and no
connection on the Mac, and the cause is not known. G0.6 stays open: it needs results from
real devices on the shop network.

Browser run on this Mac on 2026-11-01, through the real name and certificate: Chrome 156
has p95 0.51 s for one baker and 1.00 s for three. Safari on the iOS Simulator has p95
0.53 s for one baker and 1.30 s for three, or 1.65 s when the Mac was heavily loaded. All
commands were correct. The browser and the server share one Mac, so this does not measure
Wi-Fi, the shop router, Private Relay or the Chrome prompt.

Owner decision on 2026-11-01: skip the manual device test in Phase 0. G0.6 did not pass and
did not fail. Its device part moves to Phase 4, where the deployed Portal and the owner's
real shift show the prompts, the shop network and the latency. Risk: a real device may not
reach the Mac, and the first device run did not explain why it left no result. If so, each
command uses the Workers AI fallback, with its 6 s limit, until the cause is fixed. Then the
Mac service in Phase 1B gives no benefit until that fix.

Result for G0.4 on 2026-11-01 ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-82-phase-0.md)): not passed, and
synthetic voices cannot close it. The tools are in `scripts/plan-82-g04/`. No threshold meets
both limits. At 0.995 the candidate gives 1.17 false wakes per 8 hours and hears 93.8–95.2% at
1 m in mixer noise. On macOS voices that it never trained on, it hears about 70%. With a pause
after "Hey" it hears 97–100% of those voices in quiet, and with no pause it hears 43–50%. Only
real voices can show how people say the phrase. In Chrome on the M4 Pro, the model found 3 of 3
wake phrases and 0 of 2 other phrases in 45 s of mixer noise, with about 3% of one core. The
false wake limit closes on the owner's real shift in Phase 4, which already records false wakes.

Licences for G0.4, read on 2026-11-01. Read them again before release. The engine files
(`melspectrogram.onnx`, `embedding_model.onnx`) and ONNX Runtime Web are Apache-2.0. The
classifier is Satyr's own. Its training inputs are Piper `en_US-libritts_r-medium`, LibriSpeech
and DEMAND, all CC BY 4.0, and Kokoro v1.0, Apache-2.0. Satyr does not use the pre-trained
openWakeWord models or `openwakeword_features`, which are CC BY-NC-SA 4.0. `piper-tts` and
`phonemizer` are GPL tools that made training audio, and no product ships them.

Owner decision on 2026-11-01: skip the G0.3 recording and the real-voice part of G0.4 in
Phase 0, and start Phase 1. G0.3 and G0.4 did not pass and did not fail. The owner's shift in
Phase 4 gives both results. Risk: Phases 1–3 are built before any real voice is measured. If
real voices fail, the wake model needs new training, or a wearable microphone becomes required.
The Platform routes and the Mac service do not depend on that result. The cost falls on
the Portal capture in Phase 2 and the phrase bank in Phase 3.

Result (2026-10-30): G0.1 passes in substance. Every band is within 1.3
points except the clean approval band, which has one more refusal of 48
(2.1 points: "badge" for "batch"). Dictation is equal or better, and 0 near
misses were accepted. G0.2 fails at p95 3.46–3.93 s for all four settings
tried, and at 5.71 s in the repeat run. See
[the evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-82-phase-0.md). Under D1a the limit is now 6 s.

Result for G0.5 (2026-10-31, [evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-82-phase-0.md)): the
published terms allow Whisper on Workers AI. Cloudflare does not train on inputs
and does not keep them after standard inference. One point stays open: no page
names the regions, so Satyr cannot promise that fallback audio stays in Japan or
Asia Pacific. The Mac path has no such limit. The opt-in text says that fallback
audio can leave the country. The owner accepts this limit or asks Cloudflare before
release.

### Phase 1 — Platform transcription and grants

- Workers AI binding `AI` in `services/platform/wrangler.jsonc`.
- The routes, limits, vocabulary and refusals above, in
  `services/platform/src/voice/`.
- Mac enrollment, heartbeat, revocation, DNS records and the certificate challenge,
  with a D1 baseline change and its patch script.
- The `voice_transcription` capability in the capability catalogue, with a
  policy-row backfill for existing Organisations.
- Shapes in `@seams/control-api`; `inputMode` and the transcription path on the chat
  message command and the timeline event.

Result on 2026-11-01: built. `services/platform/tests/e2e/voice-control.test.ts` passes with
a fake Workers AI and a fake Cloudflare DNS API, and with real chat turns. It covers enrollment,
private addresses only, the grant that a Mac can check alone, the fallback, each limit and
refusal, the vocabulary, a spoken command on the timeline, the off switch and revocation.

Choices that the design left open:

- The capability ID is `voice.transcription`. A new Organisation has it on. An existing
  Organisation gets the disabled row from the backfill, so an owner must turn it on.
- Each Mac has its own grant key, derived from `DATA_ENCRYPTION_ROOT`. So a Mac can sign grants
  only for itself. It receives the key once at enrollment.
- The grant route names the enrolled Mac with the latest heartbeat in the last 3 minutes. Satyr
  has no shop record in this path, so an Organisation with two shops shares one Mac.
- The routes `grants` and `transcriptions` need the operator role. The chat route keeps its own
  access check. The routes that manage a Mac need the admin role.

Before Phase 4 can use real services, do these steps:

- Apply `services/platform/scripts/voice-control-d1-patch.sql` and the capability backfill to
  each regional database.
- Set `VOICE_DNS_ZONE_ID` and `VOICE_DNS_ZONE_NAME`, and the secret `VOICE_DNS_API_TOKEN`. The
  token needs DNS edit access on that zone only. Without these three values, no Mac can enroll,
  and every command uses the fallback.

Limits: no real Workers AI call or real DNS change ran in this phase.

An archived Organisation's Macs stop at once, and the Platform removes their DNS names in the same
run. A failed removal does not hold the other revocations. The purge repeats the removal and then
deletes the voice rows. If DNS still fails, the purge stops and repeats on the next run, because
those rows hold the only list of the names. `voice-control.test.ts` runs this with a DNS outage.

### Phase 1B — The shop Mac service

- The service above, in `services/shop-voice/`, with its install command and
  `launchd` file.
- Its request and response shapes in `@seams/control-api`.

Result on 2026-11-01: built. `scripts/shop-voice/run-journey.py` passes on this M4 Pro. It uses the
real install script, `launchd` job, packages and Whisper, the Platform's real routes on a local
Worker, the real account Worker, and speech from macOS over real TLS. Three outside services are
stand-ins that only record or answer: the Cloudflare DNS API, the model host and the certificate
authority. The journey covers the one-time code, the DNS name, a bad file and a resumed download,
the load on a member's check, the shop vocabulary in the transcript, each refusal, the queue, the
limit for each member, a restart after a kill, the idle unload, no audio or transcript on disk or
in a log, revocation and uninstall.

Measured: about 420 ms at the median and at most 500 ms from the request to the transcript, on
this Mac with no network. The service holds 60 MB before the first load, 1.75–1.83 GB with the
model and 170–210 MB after the unload. It uses no measurable CPU when idle.

Choices that the design left open:

- The service listens on port 443, because the grant's origin has no port. macOS lets a person
  who is not an administrator bind this port on all addresses.
- `launchd` runs the service in the person's session, so the install needs no administrator.
  After a restart of the Mac, that person must sign in. Automatic login covers this.
- `GET /health` needs a grant, because it starts the model load.
- At the first refusal of its credential, the Mac stops all answers, also for a grant that is
  still valid. After five refusals in a row, about 5 minutes, it deletes the model, private key
  and credential, and stays stopped. So a fault in a Platform release does not cost a shop its
  enrollment and a 1.6 GB download.
- The install gets Python 3.11 and each package with a pinned hash. It leaves out `torch`, which
  `mlx-whisper` declares but uses only to convert models. The service needs about 0.5 GB for this
  and 1.6 GB for the model.
- The Worker serves the install script from the Portal's assets at `/shop-voice/install.sh`, so a
  shop Mac gets the version that is deployed. An installed service does not update itself.

Limits: no real certificate came through this service. Real certbot accepts the service's
arguments and hooks, and Let's Encrypt staging refused only the journey's test name. Phase 4 needs
the DNS token for the first real certificate. No real DNS change, real device or shop network ran.
If the macOS firewall is on, a person must allow the service. `status` shows the firewall state.

### Phase 2 — Portal voice capture

- `apps/portal/src/features/voice/`: opt-in, microphone choice, the audio
  worklet, VAD, wake phrase, tones, capture and spoken answers.
- The Mac check, the fallback rule in D1b and the "Cloud" mark.
- The manager's Mac list: the install command, the download size, the licence and revocation.

Result on 2026-11-01: built. `scripts/shop-voice/run-portal-journey.py` passes in real Chrome.
Chrome's microphone input plays speech from macOS, through the real wake phrase model, the shop Mac
service, Whisper and the Platform's real routes. The chat page runs from source in a development
page, with the real Access routes. The stand-ins that only record or answer are the Cloudflare DNS
API, Workers AI, the model provider, the model host and the certificate authority. The journey
covers these outcomes:

- No voice file loads before opt-in.
- A manager adds the Mac from the dialog, and the install command that the dialog shows enrolls it.
- If the Organisation's switch is off, the access prompt raises in place. Allow turns voice on.
- A command reaches the chat with the microphone mark and the shop vocabulary.
- A command during a turn waits as `next`. "Change that…" steers. "Cancel" stops the turn and sends
  no message. The end of the work is spoken as two sentences and "More on screen".
- No audio leaves the device for talk with no wake phrase, or for a wake with no command.
- If the Mac stops answering, the command takes the fallback, the "Cloud" mark shows and the command
  gives one message. A late answer from the Mac is dropped.
- A reload keeps the setting. Off closes the microphone and deletes the voice files.
- A revocation in the dialog stops the Mac.

The journey found a Phase 1 fault, now fixed: the Platform's public view dropped the voice part, so
the Portal could not show the mark.

Choices that the design left open:

- The download is about 17 MB, not "a few MB": ONNX Runtime is 11 MB and the four models are 5.3 MB.
  The Worker serves all of it from the Satyr origin. The speech detection model is Silero VAD 5.1.2,
  with the MIT licence.
- The microphone turns on echo cancellation and automatic gain, and it turns off noise suppression.
  The wake model did not train on suppressed audio. The real effect is not measured.
- Voice listens only while the chat panel is open, because the session belongs to the chat page. It
  starts again when the panel opens.
- A device listens in one tab. Another tab says that voice control is on in the first tab.
- While voice control is on, the screen stays awake where the browser allows it.
- A spoken command leaves the person's draft and attached files as they are.
- The speech for several queued commands waits for the end of the last one.

The journey now runs in the full Portal, because the fixture records an activation.

`scripts/shop-voice/run-safari-journey.py` starts the same services for Safari on the iPhone
simulator. A page script runs each step and plays speech as the microphone stream, and real taps on
the simulator give the user gestures. On 2026-11-02 the wake phrase, a command, a spoken approval, a
locked screen and off passed there. That run found four faults, now fixed:

- Safari leaves `audio.resume()` open until a tap, so the page stayed on Starting.
- The page showed that it listened while the device had stopped the audio for a locked screen.
- iOS plays no speech until one `speak()` runs inside a tap. Any tap on the page now unlocks it.
- The button that starts audio was 15 points high. It is now 44.

Limits: Chrome ran on this Mac and Safari ran on one simulator. No real microphone, room or Wi-Fi
ran, and no phone or tablet. In Safari the Mac's name is rewritten to `localhost`, so private DNS
and the local network prompt are not tested. A person who reloads the page and does not tap hears no
speech until the first tap, and the screen still shows each answer. Spoken output in Chrome ran as a
record of the text, because headless Chrome has no voices. The
wake phrase model is still the candidate from G0.4, so Phase 4 can change it with no change to this
code. Playwright 1.55 holds `audioWorklet.addModule` forever, so the journey needs 1.64.1 or later.
- The chat panel uses the existing send, queue, steer and cancel functions.
- The models load from the Satyr origin only after opt-in. Off deletes them.

### Phase 3 — Spoken confirmation

- Phrase bank and strict match for approval cards that a click can approve.
- The phrase and the match on the approval receipt.

Result on 2026-11-01: built. `tests/e2e/voice-control.test.ts` checks the Platform's rules, and
`scripts/shop-voice/run-portal-journey.py` runs a real card in Chrome through the wake phrase model,
the shop Mac and Whisper. In the journey, the agent stages a setup change and the Portal shows and
speaks its phrase after the answer. A negation, other digits, another word and a missing digit each
refuse: the card stays open, and nothing goes to the agent. The exact phrase runs the card's own
confirmation, and the change saves. The receipt holds the phrase, the match time and the path.

The words come from a measure on real Whisper with six macOS voices, 18 phrases each. "confirm
change", "send message", "send email", "approve message" and "approve email" each passed 18 of 18,
with 0 of 24 near misses accepted. "approve change" passed 5 of 18, because Whisper wrote "Approved
Change". This is a synthetic measure. G0.3 on the Phase 4 shift gives the real result.

Choices that the design left open:

- Three cards use a phrase: a setup change ("confirm change"), a Slack message ("send message") and
  an email ("send email"). The digits are three, five, six, seven and nine, because the bench found
  that the others sound like other words.
- Permission prompts stay click only, because they widen what the agent can do for the whole
  workspace. A commerce approval keeps its Google step-up, so a phrase cannot approve a refund or a
  price change. For a permission prompt, the Portal says that the request needs approval on the screen.
- The Platform checks the words, and then the Portal runs the card's own click. So the card's route
  keeps its own authority, checks and receipt. The voice receipt is a row in `voice_confirmation`.
  The card's own receipt does not hold the phrase. They join on the card's id.
- While a card waits, speech with the card's noun and digits is an attempt to confirm. It never goes
  to the agent. Other speech stays a normal command.
- A phrase works one time, for one member, in one chat, for 30 minutes. Five refusals spend it, and
  the card shows a new phrase.
- The transcript of a refusal is not stored.

Before release, apply `services/platform/scripts/voice-confirmation-d1-patch.sql` to each regional
database, with the Phase 1 patch.

The journey also found a Phase 2 fault, now fixed: the listener ignored audio for about 2 s after each
command, so a quick next command lost its wake phrase. The listener now keeps its audio context.

The Slack and email cards ran with real speech on 2026-11-02. Each shows and speaks its own phrase.
A Slack card with no channel asks for one, and a failed send keeps the card open. Both now give a
new phrase, because the old one is spent. The exact phrase sends to the chosen channel. That journey
found this fault: the card kept showing the spent phrase.

Limits: in that journey the Slack and email draft routes are stand-ins that record each call, because
a Slack workspace and a mailbox need their own providers. The speech is synthetic.

### Phase 4 — Release

- The live journey below on the deployed Worker with a real Mac and real Workers AI.
- G0.2 again through the deployed Platform, because the Phase 0 measure used a
  probe Worker. Pass: p95 at most 6 s from the end of the audio.
- G0.6 through the deployed Portal, including the device part that Phase 0 skipped. The
  owner's shift below provides these results, with no separate test page.
- The owner uses voice control for one real shift. Record false wakes,
  misheard commands, refusals and each fallback in the evidence file.
- G0.3 and G0.4 close on that shift, with the limits in Phase 0: wake phrases heard, false
  wakes, correct approval phrases accepted and near misses accepted. Record the microphone
  that the owner used. If a limit fails, stop the release and return to the wake model or
  the microphone choice with the numbers.

Progress on 2026-11-02: the code reached production through other uploads, and the patches and
capability rows were already applied. The owner created the DNS token (zone `seams.sh` only), and
the three settings are Worker secrets with no code upload. The owner's Mac enrolled through the
deployed Portal as a test Mac: real A record with the private address, real Let's Encrypt
certificate, model loaded. The owner's real voice then ran two commands through the deployed
Portal, and the fallback table stayed empty. The owner's first "Hey Satyr" did nothing, for a cause
that is not proven. In a test with the phrase on the Mac's speaker at 38% volume, Samantha woke it
2 of 2 times and Daniel 0 of 2 times. Whisper wrote "Satyr" as "Seder" one time. G0.2, G0.3, G0.4
and the G0.6 device part remain open for the owner's shift.

The owner's report on the same day: the wake phrase needs a raised voice, the answer is slow, and
the voice sounds robotic. Measured on this Mac, under load 7–15:

- Wake: with macOS voices, 5 of 6 clips still wake at -30 dB from a 0.5 peak, and 3 of 6 at -36 dB.
  So volume alone does not explain the owner's report. Only real voices can settle it.
- Answer: 9–28 s from the chat's admission to the end of the turn, in seven recent turns. Whisper takes
  about 0.5 s for a 5 s command. The Portal speaks only when the turn ends.
- Noise: Whisper with the vocabulary returned "Matcha Tea" repeated on 8 s of noise, and the owner
  got "Black sesame" repeated as a real command. The Portal now drops such a transcript, and
  "Thank you", with the two low tones.
- Voice: the owner chose Kokoro `af_heart` on 2026-11-02. The Mac makes 10 s of speech in about 1 s.

**D9. The voice of spoken answers (accepted 2026-11-02).** The Portal sends the text of a short
answer to `POST /speech` on the shop Mac, and plays the WAV file through its own AudioContext,
because the capture context runs at 16 kHz. The text goes to no disk, no log and not to the
Platform. The Portal's voice dialog says this. If the Mac does not answer, or a device has not
opened audio, the Portal uses the browser's voice. It sends no answer text to any other service.
Phonemes come from misaki with no espeak-ng, because espeak-ng has the GPL. The 81 locked packages
hold no GPL package; `num2words` has the LGPL and is imported, not changed. A word outside misaki's
lexicon uses rough letter rules. The cost on the Mac is about 300 MB of disk and no fee. Memory after
the idle unload is about 630 MB, because the imported libraries stay. An enrolled Mac updates with
`install.sh --update`. A Portal with an older Mac uses the browser's voice.

Results on this Mac: the Mac journey 16 of 16, and Whisper hears the voice's words again; the Chrome
Portal journey 21 of 21, with the browser's voice when the Mac stops; Safari on the iPhone simulator
plays the Mac's voice at 48 kHz, also after a reload and one tap. The owner has not heard the voice
in the Portal, on a real phone or in the shop.
Released on 2026-11-02 13:58 UTC as satyr-edge `d624374f`, from dev `7fa8dc754`.

**D10. Hold-to-talk (accepted 2026-11-03).** While voice control is on and the Portal has focus, a
person can hold Right Option (Right Alt on other systems), speak and release, with no wake phrase.
This adds a second start to D2. The disclosure now says that audio stays on the device until the
wake phrase or the held key.

- The capture starts at the press, with 160 ms of earlier audio, and runs 240 ms past the release.
  The first tone and "Listening. Release to send." come after 180 ms, so a shorter press is silent.
- Another key or a lost focus gives up the command, and no audio leaves the device. Speech detection
  still gates the send: a silent hold gives two low tones and sends nothing.
- At the limit, the command goes while the key is down. The same press does not capture again.
- The limit is now 14.96 s for both starts. The earlier limit made 15.04 s of audio, over the Mac's
  and the Platform's 15 s body limit. That refusal was reachable with a long wake command.
- A key while another app is in front needs a desktop helper with the macOS Input Monitoring
  permission. It is not built. A browser sees no key while the page is not in front.
- Fn: the code accepts it, but no real Fn press has reached a page in a test. Real Option and Command
  presses reached the listener in the owner's Chrome, and no Fn event did. It is not known if the
  owner pressed Fn. Chromium gives no user activation for a modifier key, so a device that shows
  "Tap to start" still needs one click.

**D11. Noise and real counts (accepted 2026-11-03).** The Mac drops each Whisper segment that has
`avg_logprob` under -1.4 or `compression_ratio` over 2.4. If nothing stays, the Portal plays its two
low tones and sends nothing. `scripts/shop-voice/confidence-bench.py` chose these numbers on one set
of recorded noise and macOS voices, and tested them on another set. In that second set:

- Noise clips of 6 s that pass the Portal's own check: 77 of 105 before, 1 of 105 after. The clip
  that stays echoes the vocabulary prompt.
- Good commands lost: 0 of 185, and 0 of 190 with 3 s or 9 s of silence or room sound after the words.
- One sentence said again and again also drops, because its text compresses. The Portal's own check
  already refuses a repeated phrase.
- The workers_ai fallback has the same rule since 2026-11-13 (`voice/transcribe.ts`). An older
  Mac does not have it until `install.sh --update`.
- Whisper's own silence rule (`no_speech_prob`) stopped nothing, because it read 0.0 on this noise
  with the prompt.
- In the first set, one voice's "Cancel" became "pencil" 4 times of 12, and another's "Stop" became
  "stock" 2 times of 12. While a turn runs, such one-word transcripts now count as stop.

The Portal counts each day on the device: wake phrases heard and almost heard (a peak of 0.9 to
0.995), key holds, wakes with no command and transcripts dropped. It keeps numbers only, for 14 days,
and sends them nowhere. The voice dialog shows today's first three. These counts give the real
missed-wake and false-wake data that G0.3 and G0.4 still need.

A wake model trained with 15,000 more Kokoro clips (`wake.py focus`: no pause after "hey", half in
café talk) was rejected on 2026-11-03. On macOS voices at 0.995, café talk at 5 dB went from 51.7% to
59.2%, but "hey satyr" with no pause stayed at 43.3%, "hey sayter" went from 50% to 46.7%, near
phrases accepted in café talk went from 7% to 12.7%, and false wakes went from 1.17 to 4.39 per 8 h.
More synthetic voices do not close the gap. Real recordings or hold-to-talk are the next step. The
score also moves with the position of the audio in an 80 ms chunk: one phrase read 0.03 and 1.00 at
two positions 20 ms apart.

**The chunk position, measured (2026-11-14).** `scripts/plan-82-g04/phase-bench.py` runs the
Portal's own model files through the worker's stream, moves each phrase in 5 ms steps, and scores it
on 1, 2, 4 and 8 grids of 80 ms that start 80 / n ms apart. It used 18 macOS voices, "Hey Satyr"
and "Hey, Satyr", 8 near phrases, quiet and 10 and 5 dB DEMAND noise, and 17.7 min of café talk with
near phrases in it. At 0.995:

| Grids | Wake phrases heard | Near phrases accepted | False wakes in the café talk |
| --- | --- | --- | --- |
| 1 (the worker) | 80.8% | 44.5% | 4 |
| 2 | 83.4% | 49.1% | 6 |
| 4 | 86.8% | 55.0% | 6 |
| 8 | 88.9% | 58.6% | 8 |

More grids act as a lower threshold. At the same near-phrase acceptance, 4 grids hear 81.3% and 1
grid 80.8%. So the worker keeps one grid. The position is not the limit: the model accepts 44.5% of
near phrases on these voices ("Hey sayter" 77%, "Hey Saturday" 66%, "Hey cedar" and "Hey satire"
53%, "Hey Sarah" 16%, "Hey Peter" 1%). A window with fewer than 16 embeddings must never reach
the model: it gives 0.99999 to a window of zeros. The worker scores only a full window.

**The fallback on the same bench (2026-11-13).** `confidence-bench.py` now also sends each clip to
Whisper on Workers AI (`SHOP_VOICE_WORKERS_AI_URL`). Workers AI's own speech filter (`vad_filter`)
already drops most noise: with the Portal's check alone, 10 of 45 and 11 of 105 noise clips became
text, against 77 of 105 on the Mac. With the rule above, 5 of 45 and 9 of 105 stayed. The rest were
high-confidence inventions: the vocabulary read back ("pour-over, Satyr, brown butter, …") and a
French subtitle credit ("Sous-titrage Société Radio-Canada"), although the call asks for English.
The fallback therefore also drops a segment with a known subtitle credit, and a segment that is a
list in which at least two parts, and at least half of the parts, are vocabulary names. On the
stored results, 3 of 45 and 3 of 105 noise clips then stay, and no good command is lost: 0 of 354
and 0 of 367, with the long tails. (Corrected 2026-11-14: the bench's copy of the Portal's check
counted 3 repeats, and the Portal counts 5. The first counts were 9 and 9, 4 and 8, and 2 and 2. The
Mac's counts in D11 and the Qwen3-ASR counts do not change.) On the Mac's held-out set, the list
rule would also drop the one clip that stays there, with 0 of 375 good commands lost; the Mac does not have it yet, because a
change to the Mac needs `install.sh --update` on each Mac.

**D12. Voice on every page (accepted 2026-11-13, owner: "Fix them").** The microphone no longer
belongs to the chat panel. One voice session for each Organisation lives for the page
(`features/voice/host.ts`). The open chat takes each command. With the chat closed, a mark at the
bottom of the page shows that voice listens, needs a tap or stopped. A command opens the chat
beside the page on screen, in the chat of the last spoken command, and the chat sends it when it
is ready. If the chat does not open in 10 s, the Portal speaks a refusal and sends nothing. Leaving
the workspace closes the microphone; the setting stays on the device. The Chrome scene
`closedChat` (`SHOP_VOICE_APPROVAL_ONLY=1 SHOP_VOICE_SCENE=closed_chat`) passed on 2026-11-14:
the mark on a page with the chat closed, a wake command that opens the chat beside Knowledge with
its answer spoken, and a second command in the same chat. The journey's Worker now binds a stand-in
`UNDERCLERK` that answers 503, because every agent turn reads it; without it each turn failed with
"Cannot read properties of undefined (reading 'fetch')".

The whole Chrome journey then passed, 37 of 37 steps, on 2026-11-14. It found two faults, now
fixed. The install command put the one-time code after `--code `, and a code that starts with "-"
(about one in 64) read as a missing value to the Mac's parser; the Portal now shows `--code=<code>`,
which every installed Mac accepts. After a reload, the page mark and the chat both started the
session, and the second start read the first start's lock as another tab; a start now runs once.

**Speech model bake-off (2026-11-14, owner: "Run the bake-off").** The seams-monorepo bench
(`voiceId/stt-bench`, README section of that date) ran three newer open models on the Mac's M4 Pro
with the same bakery sets: Qwen3-ASR 1.7B, Granite Speech 4.1 2B and Parakeet TDT 0.6B v3. The gates
were at least 20% fewer errors in noise, no near-miss approval accepted, and no slower than Whisper.

- Qwen3-ASR 1.7B with the shop vocabulary as hotwords made 26% fewer English dictation errors than
  Whisper averaged over 10, 5 and 0 dB (6.9% against 9.7% at 0 dB), 23–29% fewer on human read
  speech, accepted no near miss, and took the same time (0.43 s against 0.44 s at the median). It
  accepted the correct approval phrase less often at 10 and 0 dB (78.5% against 81.9% at 0 dB),
  mostly "yuan" for "yen" and "stop" for "stock"; the strict match refused them. Its files are 4.1 GB
  and it holds 5.1 GB, against 1.6 GB and 2.5 GB.
- Granite and Parakeet failed the first gate. Cohere Transcribe did not run (broken public MLX
  conversions; the original needs acceptance of Cohere's terms). Apple SpeechAnalyzer needs macOS 26.
- Not measured: real voices in the shop. The noise test follows.
- A model change saves no time for a command: the speech step stays about 0.4 s of the 3.8–4.3 s
  before an answer starts.

**Qwen3-ASR on noise (2026-11-14, owner: "Run the noise test").** `confidence-bench.py` now also
runs Qwen3-ASR 1.7B through mlx-audio with the vocabulary as hotwords (`SHOP_VOICE_QWEN3`), with the
log-probability of each chosen token in float32. `speech-gate.py` runs the Portal's speech detector
on the same noise clips. The sets are the D11 sets: one to choose the rule, one held out.

- On every noise clip, 150 of 150, Qwen3-ASR read the whole hotword list back. Its confidence in
  that list was higher than in any good command: a mean token log-probability of -0.001 to -0.008,
  against -0.34 for the lowest good command. No confidence threshold separates the two.
- The Platform's list check (`voice/transcribe.ts`) drops the readback. With it and the
  repeated-text check, the held-out set sent 0 of 105 noise clips, against 1 of 105 for Whisper with
  the Mac's rule. Good commands lost: 0 of 211, and 0 of 214 with 3 s or 9 s after the words. A
  production-size list of 55 terms (594 characters) gave the same counts.
- Qwen3-ASR heard 7 of 432 held-out commands badly, against 57 for Whisper. Most of Whisper's are
  digits for spoken numbers ("Confirm Change 375"), which this bench counts as wrong.
- The Portal's speech detector stops most noise before any model. After a wake, 9 of 45 and 17 of
  105 noise clips reach the Mac, nearly all of them café talk.
- A readback costs time. With 55 terms, a noise clip took 2.8 s to its 160-token limit, against
  0.38 s for a command. The Mac must stop the decoding when the first names repeat the list.

To use Qwen3-ASR, the Mac needs mlx-audio, the 4.1 GB model files, the list check, a token limit,
the early stop and `install.sh --update` on each Mac. The workers_ai fallback stays Whisper.
[Plan 82C](plan-82C-speech-engines.md) plans this switch as a choice for each Mac, behind one
engine interface for the Mac and Workers AI. Its Phase 1 (2026-11-15) builds the interface with
Whisper only: the Portal now runs the list check on the text of every host, so the Mac path drops
the held-out noise clip too (0 of 105). It is in production since 2026-11-15. Its Phase 2
(in production since 2026-11-15 15:28 UTC, `satyr-edge` `f40050b1`) adds Qwen3-ASR on the Mac as a
manager's choice in the voice control dialog, with the token limit and the early stop: a noise
decode with 55 terms now takes 0.91 s at most.

The Chrome journey presses the real key through Chrome's input events, and the Mac and Whisper hear
the speech. It covers a slip, a silent hold, a chord, a lost focus (a page event), a hold past the
limit and a spoken approval. The Fn case in the journey is a page event, not a real key. The owner
has not tried the key with a real microphone.

### Phase 5 — Japanese on Whisper

- Measure Whisper latency on the Japanese phrases on the Mac and in Tokyo, and check
  the limits in D1a.
- The Mac and the fallback route take the member's voice language and pass
  `language: "ja"`.
- A Japanese phrase bank for spoken approvals, then G0.3 with Japanese voices.

## Evidence

Follow the testing policy in `AGENTS.md`: end-to-end journeys only, and a fake
outside service only records or answers.

- **Spoken command journey.** Chromium with a fake microphone file
  (`--use-file-for-fake-audio-capture`) plays shop talk, then "Hey Satyr, run
  the financier shift". The real Mac service transcribes it, and a fake Workers AI
  binding records calls. Pass: no request leaves the browser during the shop talk;
  no audio reaches the binding; the agent receives one message with
  `inputMode: "voice"`; the chat timeline shows it once.
- **Fallback journey.** The Mac service stops, then hangs on the next command and
  answers late. A fake Workers AI binding answers the transcript. Pass: the agent
  receives one message for each command, the panel shows "Cloud", and the next
  command after the Mac returns reaches the Mac.
- **Refusal journey.** The Organisation turns voice transcription off while a grant
  is still valid. Pass: the Platform refuses, the Portal speaks the refusal and raises
  the access prompt, and the agent receives nothing.
- **Spoken approval journey.** The agent proposes a refund. A spoken negation
  ("do not approve refund six zero four") leaves the card open; the exact
  phrase approves it, and the receipt records the phrase.
- **Live journey before release.** One recorded command through a real Mac and one
  through real Workers AI on the deployed Worker, from the Portal to an agent answer.

## Risks and limits

- Distance and movement are not measured. A device microphone can fail in a
  loud room; the owner's shift in Phase 4 decides if a wearable microphone is required.
- A false wake sends shop talk to the Platform. G0.4 sets the limit, and the
  tones tell people when the Portal records.
- The wake model hears "Hey, Satyr" with a pause much better than "Hey Satyr" with no pause
  on voices that it did not train on. Real voices may show the same gap. If so, tell people
  to pause, or train on more speech with no pause.
- A misheard command reaches the agent. Page-local actions are harmless;
  actions on records keep their approval.
- Whisper can write text that was not said in noise or silence. The Portal's VAD,
  the 15 s limit and the strict phrase match reduce the effect. `vad_filter` exists
  only on Workers AI, and the MLX bench results did not use it.
- The browser path to the Mac is not proven. Chrome 156 refuses calls from a public page
  to a private address until the person allows
  [local network access](https://developer.chrome.com/blog/local-network-access). This
  refusal is measured. The prompt on a real device is not.
  Safari's behaviour is not read, and one developer reports that iCloud Private Relay
  [blocks local HTTPS calls](https://developer.apple.com/forums/thread/804316). Some
  routers drop public DNS answers with private addresses. If G0.6 finds one of these
  on a device, that device uses the fallback until the setting changes.
- A Mac that is off, asleep or restarting for an update sends the shop's audio to the
  fallback. The "Cloud" mark shows this. Latency then returns to the fallback limit.
- One Mac serves all bakers in a shop, one command at a time. A load of more than
  three at once is not measured; a full queue goes to the fallback.
- The Mac can read and change every transcript. A Mac under an attacker's control can
  turn a spoken negation into an approval phrase. The Mac is a trusted device of the
  shop, its enrollment can be revoked, the receipt records the path, and step-ups
  still protect money and records.
- Workers AI can change the model build or its location. G0.1 and G0.2 run
  again before each release that changes this path. The Worker location varied
  in the bench, so the release measure records the location.
- A change to the pinned `mlx_whisper` or the model snapshot runs G0.1 and G0.6 again.

## Not in scope

- Speaker verification and voice step-up (Seams VoiceID in the Wallet).
- Commands with no wake phrase or key: [Plan 82B](../plan-82B-ambient-voice.md) owns the
  follow-up window, ambient mode and the speaker check on the device.
- Transcription of Slack audio attachments (Plan 37 handler).
- Streaming transcription while the person speaks.
- Speech-to-text in the browser (Seams Wallet refactor 191).
- Languages other than English and Japanese.
- A setting that turns off the fallback for an Organisation.
- A Mac smaller than the M4 Pro, or a PC, until it has its own measure.
- A talk key that works while another app is in front (D10).
