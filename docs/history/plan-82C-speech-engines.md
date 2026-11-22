# Plan 82C — Speech engines: one seam for local and cloud models

Status (2026-11-18): Phases 0, 1 and 2 are done (their results are under Phases). Phase 1 is in
production since 2026-11-15 12:41 UTC (`satyr-edge` `bdd553b2`), and Phase 2 since 2026-11-15
15:28 UTC (`satyr-edge` `f40050b1`). Phase 3's tools and device counts are built, proved with a
synthetic voice, and in production since 2026-11-16 10:06 UTC (`satyr-edge` `5f0e9637`). On the
owner's voice, Qwen3-ASR passes every speech check of D5, with service 0.5.1 (`satyr-edge`
`c25e66dd`) for a noise form that the recordings found. The room sound, the week of use and Phase 4
are deferred until the owner has a shop (see "Deferred" under Phase 3). Whisper stays the default.
[The voice handover](../plan-82-voice-handover.md) lists these steps with the other open voice steps.
Owner, 2026-11-14:
"Let's prepare a plan for it as an alternative but don't implement it yet. Make sure our voice
architecture is clean enough to seamlessly switch between audio voice models (whenever in cloud or
hosted locally)." Owner, 2026-11-15: "D1-D6: yes, I agree with your defaults. Proceed with phase
0". So D1–D6 take their recommendations. This plan changes [Plan 82](plan-82-portal-voice-control.md)
D1 only for a Mac on which a member chooses another engine. Whisper stays the default on the Mac
and the only engine on Workers AI.

## Result in one paragraph

Each place that turns speech into text (a host: the shop Mac or Workers AI) runs a speech engine
through one interface. An engine is one model with its own settings and its own noise rule. One
catalogue in `@seams/control-api` names the engines and their facts. One text check, in the
Portal, drops invented text for every engine and host. Every transcript and every spoken approval
records its engine. A member who manages the Organisation chooses the engine of each shop Mac,
and the Mac changes engine with no reinstall. The first alternative engine is Qwen3-ASR 1.7B on
the Mac. It made 26% fewer dictation errors than Whisper in the bake-off, and it passes the noise
test with the list check (Plan 82, entries of 2026-11-14). A new cloud engine then needs one
adapter module and one catalogue entry.

## Problem

The model is fixed in 15 places, in three runtimes and two languages. A model change today
touches each of them:

| #   | What is fixed                                | Where                                                                                                            |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Decoding, warm-up and unload of Whisper      | `services/shop-voice/shop_voice/engine.py` (`_run_whisper`, `_load`, `_unload` through `ModelHolder`)            |
| 2   | The Mac's noise rule (Whisper segments only) | `engine.py` `_is_noise`                                                                                          |
| 3   | The Mac's model files                        | `model_files.py` `REVISION`, `FILES`; `state.py` `DEFAULT_MODEL_BASE_URL`; `__main__.py` `status()`              |
| 4   | The Mac's packages                           | `requirements.in`: `mlx-whisper` with `--no-deps` through `lock.sh`                                              |
| 5   | The vocabulary as one Whisper prompt         | `__main__.py` joins the terms into `shop.prompt`                                                                 |
| 6   | The cloud call                               | `services/platform/src/voice/transcribe.ts` `WHISPER_MODEL`; `env.ts` types `AI.run` for one model name          |
| 7   | The cloud noise rules                        | `transcribe.ts` `isSpeech` (Whisper segments) and `isInvented` (credits and the list read back)                  |
| 8   | The vocabulary limits                        | `@seams/control-api` `VOICE_VOCABULARY_TERM_LIMIT`; `vocabulary.ts` `PROMPT_CHARACTER_LIMIT` (224 tokens)        |
| 9   | The Portal's text checks                     | `apps/portal/src/features/voice/command.ts` `isWhisperNoise`, `HEARD_AS_STOP` (Whisper's own mishearings)        |
| 10  | The Mac's answer deadline                    | `transport.ts` `macDeadlineMs`: 1 s and 0.3 s for each second of audio, from Whisper's speed                     |
| 11  | The enrollment text                          | `control.tsx`: "the Whisper and voice models after that (1.7 GB, MIT and Apache-2.0 licences)"                   |
| 12  | The records                                  | A message and an approval receipt record the host (`shop_mac`, `workers_ai`) and no model                        |
| 13  | The bench                                    | `scripts/shop-voice/confidence-bench.py` copies the Mac's rule, the Platform's list check and the Portal's check |
| 14  | The Mac journey                              | `scripts/shop-voice/run-journey.py` serves the Whisper snapshot and tests the resume on `weights.safetensors`    |
| 15  | The E2E suite                                | `voice-control.test.ts` checks the cloud list check on the Platform route                                        |

Three faults follow from this:

- The list check (item 7) runs only on the cloud path. On the Mac's held-out set it would stop the
  one noise clip that passes today, with no good command lost. The Mac does not have it, because a
  Mac change needs `install.sh --update` on each Mac (Plan 82, 2026-11-13).
- The bench's copy of the Portal's check drifted: it counted 3 repeats, and the Portal counts 5.
  Fixed in the bench on 2026-11-14. The fallback's recorded counts in Plan 82 moved from 2 of 45 and
  2 of 105 to 3 of 45 and 3 of 105. The Mac's counts and the Qwen3-ASR counts did not change.
- The Mac's transcription host (`engine.py` `Engine`) and its answer voice (`speech.py` `Speech`)
  repeat the same code: load on a check, unload when idle, slots, a queue deadline and the states.

What is already clean and stays:

- The Portal's path choice (`transport.ts`) knows only the hosts: the Mac first, then the Platform
  (Plan 82 D1b). The answer of both hosts is `{ text, audioSeconds }`.
- The Mac's HTTP routes, grants, rate limits, enrollment, DNS name and certificate know no model.
- The capture, the speech detector and the wake phrase run on the device, before any engine.

## Words

- **Engine**: one speech-to-text model with its decoding settings and its noise rule, for example
  `whisper-large-v3-turbo` or `qwen3-asr-1.7b`.
- **Host**: the place where an engine runs: `shop_mac` (local) or `workers_ai` (cloud). The
  `ChatTranscriptionPath` values stay the host names.
- **Engine rule**: the noise rule that needs the model's own values, such as Whisper's segment
  log-probability or a token count.
- **Text check**: the noise rule that needs only the text: a subtitle credit, the vocabulary read
  back as a list, a repeated phrase or "Thank you".

## Design

### One engine catalogue

`packages/control-api/src/voice-engines.ts` holds the engine ids as a TypeBox union and one
record for each engine. The Portal and the Platform read it. The Mac keeps its file pins in its
own engine module, because only the Mac uses them.

```ts
export const voiceEngineIdSchema = Type.Union([
  Type.Literal("whisper-large-v3-turbo"),
  Type.Literal("qwen3-asr-1.7b"),
]);

export const VOICE_ENGINES = {
  "whisper-large-v3-turbo": {
    label: "Whisper large-v3-turbo",
    licence: "MIT",
    hosts: ["shop_mac", "workers_ai"],
    macDownloadBytes: 1_614_000_000,
    macMemoryBytes: 2_500_000_000,
    vocabulary: { terms: 60, characters: 600 },
    macDeadline: { baseMs: 1000, perAudioSecondMs: 300 },
    heardAsStop: ["stock", "stopped", "pencil", "canceled", "cancelled"],
  },
  "qwen3-asr-1.7b": {
    label: "Qwen3-ASR 1.7B",
    licence: "Apache-2.0",
    hosts: ["shop_mac"],
    macDownloadBytes: 4_080_707_826,
    macMemoryBytes: 5_000_000_000,
    vocabulary: { terms: 60, characters: 600 },
    macDeadline: { baseMs: 1000, perAudioSecondMs: 300 },
    heardAsStop: ["capsule", "candle", "kazil", "canzil", "castle"],
  },
} as const satisfies Record<VoiceEngineId, VoiceEngineFacts>;
```

A change to a Mac engine's file pins updates its `macDownloadBytes` in the same commit.

### The engine interface on the Mac

`services/shop-voice/shop_voice/engines/` holds one module for each engine and the interface:

```python
class SpeechEngine(Protocol):
    id: str
    files: FileSet  # the base URL, the revision and the SHA-256 of each file

    def load(self, folder: Path) -> None: ...
    def unload(self) -> None: ...
    def hear(self, samples: "np.ndarray", vocabulary: tuple[str, ...]) -> str: ...
```

- `hear` returns the text after the engine rule. Each engine makes its own prompt from the
  terms: Whisper joins them into `initial_prompt`, and Qwen3-ASR gives them as hotwords.
  `shop.prompt` becomes `shop.vocabulary`, a tuple of terms.
- `whisper_mlx.py` holds today's `_run_whisper`, `_is_noise` and the `ModelHolder` unload, with no
  change of behaviour.
- One model-neutral `ModelHost` holds the slots, the queue deadline, the load on a check, the
  unload when idle and the states. The transcription host and the answer voice (`Speech`) both use
  it, so the repeated code goes.
- `ModelFiles` takes its folder, base URL and pins from the engine. Each engine has its own folder
  under `model/`, so two engines' files can stay on the Mac at the same time.
- `status` names the chosen engine and whether its files are present.

### The engine interface on the Platform

`services/platform/src/voice/engines/` holds one module for each cloud engine. Today that is
`workers-ai-whisper.ts`, with the call and `isSpeech`. `transcribe.ts` keeps the deadline and calls
the cloud engine that the catalogue names for `workers_ai`. The `AI.run` type in `env.ts` takes the
model names of the cloud engines.

A new Workers AI engine is one module, one catalogue entry and one model name in `env.ts`. An
engine of another provider is not in this plan: audio would then go to a new processor, and the
owner decides on its terms first, as for Deepgram (Plan 82 D1).

### One text check

The text check moves from `transcribe.ts` and `command.ts` into
`packages/control-api/src/voice-text-check.ts`: `keptVoiceText(text, names)`. It drops each
sentence that is a subtitle credit or the list read back, and then the whole text if it is "Thank
you" or a repeated phrase. A sentence of its own takes the place of a Whisper segment, because the
Mac sends one text and Qwen3-ASR gives no segments. The Portal runs it in `readVoiceCommand` on the
text of every host and engine (D1), and a spoken approval reads the text after the check. The
Platform's fallback then returns the text after the engine rule only, as the Mac does.

- The Mac path gets the list check with a Portal release, with no Mac update. A later change to
  the check is also a Portal release only.
- The Portal reads the names from `GET .../voice/vocabulary` each time that it reads a grant (at
  most 60 terms and 600 characters). The grant itself does not carry them: its schema is strict, so
  a Portal tab from before the release would refuse a grant with a new field, and voice would stop
  in that tab. The names are the ones that every member reads from the viewer role up (Plan 82,
  Vocabulary). The route asks for the operator role and the voice capability, as the grant does,
  so a member gets no name that their pages do not show. The Portal compares a transcript with the
  names and shows them nowhere. They are Organisation records with no flow label, so no
  [IFC](../../foundation/authority/policy/information-flow/README.md) sink or label applies.
- The benches score with the shipped Portal code through `scripts/shop-voice/portal-voice.mjs`,
  which bundles `command.ts` with `@seams/control-api`, so a bench cannot drift again. For the Mac's
  engine rule, `confidence-bench.py` imports `shop_voice.engines`. The cloud engine rule keeps its
  copy in the bench Worker of Plan 82 D11 until a bench run of the fallback needs it again.

The Whisper engine rule stays in two languages, because the same model runs on two hosts. The two
copies hold the same two numbers, and the bench measures both.

### The engine of each Mac

- A member who manages the Organisation chooses the engine of each Mac in the voice setting. The
  choice uses the `Select` from `apps/portal/src/ui/` and offers only the engines that the Mac's
  service version reports. The default is `whisper-large-v3-turbo` (D2).
- `voice_mac` gets the reported `engine` in Phase 1, and `engine_choice` and the reported `engines`
  in Phase 2. The heartbeat sends `engine`, and in Phase 2 `engines`; its answer then carries
  `engineChoice`. The Platform never calls the Mac, as today. A heartbeat with no engine comes from
  a service from before 0.4.0, and the Platform records Whisper for it.
- On a new choice, the Mac downloads the files with the existing resume and SHA-256 check. It keeps
  the old engine loaded until the files are complete. It then unloads the old engine and loads the
  new one. During the load it answers `model_not_ready`, and the Portal uses the fallback, as for
  any load (Plan 82 D1b). Only one engine is in memory at a time.
- The old engine's files stay for 14 days with no use, so a switch back needs no download (D3).
- The Devices page row of a shop Mac (Plan 85) shows the engine beside the model state. The
  agent's `device_read` tool reads only gateways and kitchen devices today. Phase 2 adds the shop
  Mac rows to it, with the connection, the model state and the engine.
- The agent does not change the engine: a change downloads up to 4.1 GB onto shop hardware and
  changes which model hears spoken approvals, so a person decides.

### The engine on every record

- The Mac's `/transcriptions` and `/health` answers add `engine`. The fallback's answer does not:
  the Portal and the Platform release together, so the Portal takes the cloud engine from the
  catalogue (`CLOUD_VOICE_ENGINE`). A Portal tab from before the release refuses the Mac's new field
  and uses the fallback, which still answers it.
- The chat input mode adds `transcriptionEngine`, and `voice_confirmation` adds
  `transcription_engine`, so an approval receipt names the model that heard the phrase (D4).
- The Portal reads `macDeadline` and `heardAsStop` from the catalogue for the engine that the Mac
  reports in `/health`. An answer with no `engine` comes from an older Mac, which runs Whisper.
- The device's daily counts (Plan 82 D11) count, for each host and engine, the commands that the
  Portal kept and the texts that it dropped as noise (Phase 3).

The schemas are strict. An older Portal refuses a Mac answer with an unknown field and uses the
fallback, and an older Platform refuses such a heartbeat. So the Portal and the Platform release
first, with the new fields optional, and the Macs update after that.

### The vocabulary for each engine

The Platform builds one list, with the smallest limits of the engines in the catalogue
(`VOICE_VOCABULARY_LIMITS`). The Mac, the fallback and the Portal's text check read the same list
(Plan 82). Today both engines take 60 terms and 600 characters, so the smallest limits cost
nothing. A limit for each Organisation's engines in use waits for an engine with other limits.

## Qwen3-ASR on the Mac

What the bench measured on the M4 Pro (Plan 82, entries of 2026-11-14):

| Measure                                        | Whisper large-v3-turbo | Qwen3-ASR 1.7B        |
| ---------------------------------------------- | ---------------------- | --------------------- |
| English dictation errors at 0 dB               | 9.7%                   | 6.9%                  |
| Time for a command, median                     | 0.44 s                 | 0.43 s                |
| Held-out noise clips sent, with its noise rule | 1 of 105               | 0 of 105              |
| Good commands lost, held out                   | 0 of 185 and 0 of 190  | 0 of 211 and 0 of 214 |
| Commands heard badly, held out                 | 57 of 432              | 7 of 432              |
| Files                                          | 1.6 GB                 | 4.1 GB                |
| Memory when loaded                             | 2.5 GB                 | 5.1 GB                |

The engine module `qwen3_mlx.py`:

- Packages: mlx-audio 0.6.5. It needs mlx 0.32.4 or later, which the Mac already pins, so both
  engines live in one environment. It also brings transformers 5, sentencepiece, tokenizers,
  miniaudio and sounddevice. The lock names only the parts that the engine imports, as for
  mlx-whisper.
- Files: `mlx-community/Qwen3-ASR-1.7B-bf16` at revision `e1f6c266914abc5a46e8756e02580f834a6cf8a7`:
  `model.safetensors` (4,076,186,653 bytes) and eight small configuration and tokenizer files,
  each with its SHA-256.
- Decoding: `stream_generate` with `language="English"`, the terms as hotwords and at most 160
  tokens. The engine needs no float32 log-probabilities: its rule uses no confidence value. Only
  the bench reads them, because bf16 values move in steps of 0.125.
- Engine rule: a text that compresses more than 2.4 is noise, and a decode that reaches its token
  limit is noise. On the bench, no command of 432 reached the limit, and every readback of the
  55-term list did. The bench's longest command has 49 characters, so Phase 2 adds a 15 s command.
- Early stop: on noise, Qwen3-ASR reads the whole hotword list back, in order. The engine stops the
  decode when the first three comma parts are the first three terms of the list. Without the stop,
  a noise clip takes 2.8 s with 55 terms. The Portal waits 2.8 s for a 6 s clip. If the Mac answers
  later, the Portal sends the clip to the fallback, and the audio leaves the shop.
- The Workers AI fallback stays Whisper.

## Decisions

The owner accepted each recommendation on 2026-11-15.

**D1. Where the text check runs.** Recommendation: in the Portal, for every host, with the names
in the grant. Cost: the names reach the member's device, so the grant route needs the read checks
and one IFC review; about 0.5 day. The other choice is a Python copy on the Mac beside the
TypeScript one; a later rule change then needs `install.sh --update` on each Mac. Default: the
Portal.

**D2. Who chooses a Mac's engine.** Recommendation: a member who manages the Organisation, for each
Mac, in the voice setting. Cost: one column and one control. Default: Whisper on every Mac.

**D3. The old engine's files.** Recommendation: keep them for 14 days with no use. Cost: 1.6 GB or
4.1 GB of disk on the Mac. Default: 14 days.

**D4. The engine on approval receipts.** Recommendation: record it. Cost: one column and its D1
patch script. Default: record it.

**D5. Qwen3-ASR as the default for new Macs.** Recommendation: not before real voices in the shop
pass (Phase 3). Cost of the wait: none. Default: Whisper stays the default.

**D6. A smaller Qwen3-ASR file (8-bit, about half the size).** Recommendation: measure it only if a
shop Mac has less memory than the M4 Pro. Its accuracy is not measured. Default: bf16, as measured.

## Phases

### Phase 0 — Measure what is missing

- Satyr's own approval phrases ("confirm change", "send message", "send email" and three digits) on
  Qwen3-ASR with six macOS voices, against Whisper's 18 of 18. The bake-off misses ("yuan" for
  "yen") came from the seams bench's phrases, not from Satyr's.
- Qwen3-ASR's one-word mishearings of "stop" and "cancel", for its `heardAsStop`.
- Qwen3-ASR's load time: the first load after the download and a load after that.
- The size of the service environment with mlx-audio, against the 0.7 GB today.
- The licence of the Qwen3-ASR weights and of each new package.
- Whether Workers AI now lists a newer speech model. This plan did not check it.

Result on 2026-11-15: done. `scripts/shop-voice/phrase-bench.py` gives both engines the same clips,
with the shop's 14-term vocabulary, in quiet and at 10, 5 and 0 dB of kitchen, cafeteria and
washing noise. Six voices say 54 approval phrases and 24 near misses at each level, and 21 voices
say "Stop." and "Cancel.". `scripts/shop-voice/phrase-score.mjs` scores each text with the Portal's
own `command.ts` and `normalizeVoicePhrase`, so no copy of the rules can drift. The voices are
synthetic, and the M4 Pro ran both engines.

| Measure                                               | Whisper large-v3-turbo | Qwen3-ASR 1.7B        |
| ----------------------------------------------------- | ---------------------- | --------------------- |
| Approval phrases that confirm the card                | 215 of 216             | 213 of 216            |
| Near misses that confirm a card                       | 0 of 96                | 0 of 96               |
| "Stop." that stops the turn                           | 80 of 84               | 83 of 84              |
| "Cancel." that stops the turn, with its `heardAsStop` | 55 of 84               | 74 of 84 (list below) |
| "Stop." and "Cancel." from the six phrase voices      | 47 of 48               | 48 of 48              |
| Time for a clip, median and 90th percentile           | 0.39 s and 0.42 s      | 0.22 s and 0.25 s     |
| First call of a new bench process (load and 1 decode) | 2.6 s                  | 6.0 s                 |
| Load as the service does it: first, then later        | 1.9 s, then 1.0–1.2 s  | 3.1 s, then 1.0–1.1 s |
| MLX memory at its peak                                | 2.48 GB                | 4.98 GB               |
| Files                                                 | 1.61 GB                | 4,080,707,826 bytes   |

- Qwen3-ASR wrote "Confirmed change" two times. The Platform refused both, and the card stayed
  open. For "Send email three five three" from one voice at 0 dB, both engines wrote other words,
  and the text went to the agent as a message. No near miss confirmed a card.
- The "Cancel." misses of both engines come from the older and the Eloquence voices (Fred, Kathy,
  Ralph, Albert, Eddy, Flo, Reed, Rocko, Shelley, Grandma and Grandpa). They also occur in quiet,
  so the voice causes them, not the noise.
- Each engine wrote a vocabulary term for "Cancel." two times: Whisper "canelé", Qwen3-ASR "Black
  sesame". Each of these texts went to the agent as a message.
- `heardAsStop` for Qwen3-ASR: "capsule" (13), "candle" (5), "kazil" (4), "canzil" (2) and
  "castle" (2). These are the one-word forms that came two times or more and that are no command.
  The list applies only to a one-word text while a turn runs, so a person who says only "Candle."
  then stops the turn. The same rule finds three forms that Whisper's list lacks: "cousel" (11),
  "casual" (2) and "curso" (2). With them, Whisper's "Cancel." count goes from 55 to 70 of 84.
  Phase 1 takes both lists from the bench with this one rule.
- The time for a command fits the Portal's wait (`macDeadline` unchanged). Only the noise readback
  needs the early stop. A switch of engine takes a few seconds of load, and the fallback answers
  during it. A cold disk read after a download is not measured: macOS needs a password to empty its
  disk cache. The bench's first call read files that no process had read since 2026-11-14.
- The service environment with mlx-audio is 911 MB, against 740 MB today. Whisper gives the same
  text and time in it. The new packages are mlx-audio 0.6.5 (MIT), transformers 5.23.0, tokenizers
  0.23.3, sentencepiece 0.2.3 and safetensors 0.8.0 (Apache 2.0), and miniaudio 1.73 and
  sounddevice 0.5.6 (MIT). A new lock also moves 14 other pins by a minor version, such as certbot
  5.9.0 to 5.10.0.
- The weights of `Qwen/Qwen3-ASR-1.7B` and of the `mlx-community` conversion are Apache 2.0, with
  no gate.
- Workers AI lists five speech models (`wrangler ai models list`, 2026-11-15): `whisper`,
  `whisper-large-v3-turbo` ($0.000513 for each audio minute), `whisper-tiny-en` (retired on
  2026-11-20), and Deepgram's `nova-3` ($0.0052) and `flux` ($0.0077, WebSocket only). No open
  model is newer than Whisper turbo. The Deepgram models are partner models under Deepgram's terms,
  so they stay out of scope (Plan 82 D1). Satyr names only `whisper-large-v3-turbo`.

### Phase 1 — The seam, with Whisper only

- The catalogue, the text check and the optional `engine` fields in `@seams/control-api`.
- The Mac: `engines/`, `ModelHost` for both models, `ModelFiles` from the engine, the engine on
  the heartbeat, the health answer and the transcription answer.
- The Platform: `engines/workers-ai-whisper.ts`, the engine columns and their patch script, the
  vocabulary route for the Portal, and the engine on the Devices row.
- The Portal: the text check for every host, the deadline and the stop words from the catalogue,
  and the enrollment text from the catalogue.
- The bench: the Mac rule from `shop_voice.engines`, and the text check through the built package.
  `phrase-score.mjs` already scores with the Portal's code; `confidence-bench.py` moves its copies
  of `portal_guard` and `invented` to the same Node scoring.
- The Mac journey takes the engine's files from its engine module. The E2E case for the fallback's
  list check moves to the Portal journey, because the Platform no longer drops that text.
- Proof: the 37-step Chrome journey passes with Whisper. The bench gives the recorded counts, and
  the Mac path now drops the clip that the list check stops (0 of 105).
- Release order: the Portal and the Platform, then `install.sh --update` on each Mac.

Result on 2026-11-15: built, with Whisper only, and not released. The owner: "Start Phase 1".

- Each host runs its engine through one interface: `shop_voice/engines/whisper_mlx.py` on the Mac
  and `voice/engines/workers-ai-whisper.ts` on the Platform. A new engine is one module and one
  catalogue entry on each host that runs it.
- `ModelHost` now loads, unloads and queues the engine and the answer voice alike, so the repeated
  code of `engine.py` and `speech.py` is gone. A transcription still starts no load: only a member's
  check does (Plan 82 D1b).
- The Portal runs `keptVoiceText` on the text of every host. On the held-out set of Plan 82 D11
  (`confidence-bench.py` with the training noise and Tessa, Moira and Rishi), the Mac path with its
  engine rule and the text check sent 0 of 105 noise clips, against 1 of 105 before, and lost 0 of
  185 good commands and 0 of 190 with a tail of room sound.
- The chat's voice mark, the Mac list, the Devices drawer, the approval receipts and the device's
  daily counts name the engine.
- Mac service 0.4.0. A Mac from before 0.4.0 moves Whisper's files into `model/whisper-large-v3-turbo/`
  at its next start, with no download. The Mac journey (`run-journey.py`, 16 of 16 steps) proves
  it on the real service: it puts the files back in the old layout, kills the service, and checks
  that launchd's restart moves them and reads nothing from the mirror.
- The Platform's voice journeys pass (4 of 4). A viewer is refused the vocabulary route, and the
  fallback's answer keeps the text that its engine rule keeps.
- The Chrome journey (`run-portal-journey.py`, 38 of 38 steps) checks the engine in the voice
  marks. It says the shop's names as a list on the Mac's path: the Mac's Whisper wrote
  "Kouign-amann, Financier, Canelé", and the Portal kept it out of the chat and counted it as noise.
- Before the release: apply `services/platform/scripts/voice-engine-d1-patch.sql` to each regional
  database. Then release the Portal and the Platform, and then run `install.sh --update` on each
  Mac. A Portal tab from before the release keeps working: it refuses the Mac's new `engine` field
  and uses the fallback until it reloads.

Release on 2026-11-15. The owner: "proceed with next steps", after the release was the next step.

- The D1 patch went to `satyr-organisation-apac` at 12:41 UTC. The Worker that ran then names its
  columns, so the two new nullable columns did not change it.
- The release is narrow: the live source `d797f0e2b` and the four Plan 82C commits, as `62b80484a`
  (ref `refs/backup/released-2026-11-15-plan-82c-phase-1`). Dev's other unreleased work stays out:
  the appliance models, the Plan 86 Phase 8 polish and Plan 61B, which is on hold. Before the
  upload, the Platform voice journeys (4 of 4) and the Devices page journey passed on that source.
- Only the Platform Worker changed: `satyr-edge` `bdd553b2`, from `34d733eb`, which is the
  rollback target. The schema check matched (global 62, APAC 368 and 1 extra). The 13 Portal entry
  files and `shop-voice/install.sh` in production equal the build. A 60-second tail had 3 events
  with no exception: the minute cron, and the Mac's heartbeat and vocabulary requests, both 200.
- The shop Mac on the owner's machine took `install.sh --update` from production: service 0.4.0
  moved Whisper's files into `model/whisper-large-v3-turbo/` with no download, and production
  records engine `whisper-large-v3-turbo` for it.
- Not checked: a signed-in Portal page and a spoken command in production, because the agent
  cannot sign in.

### Phase 2 — Qwen3-ASR on the Mac

- `qwen3_mlx.py`, its file pins and its locked packages.
- The engine choice in the voice setting, the heartbeat answer and the switch on the Mac.
- The shop Mac rows in the agent's `device_read`, with a chat journey: the agent names a Mac's
  engine, and a person without the right to read devices stays refused.
- Proof: the Chrome journey with Qwen3-ASR on this Mac, including a spoken approval and a switch
  back to Whisper with no download. The bench's held-out set with the shipped engine: no noise clip
  sent and no good command lost. A noise clip with the early stop ends before the Portal's wait.

Result on 2026-11-15: built, and not released. The owner: "Start Phase 2".

- `shop_voice/engines/qwen3_mlx.py` runs Qwen3-ASR 1.7B with mlx-audio 0.6.5, with the shop's terms
  as its system prompt and at most 160 tokens. Its rule drops a text that compresses more than 2.4 or
  that reaches the token limit. Its early stop ends a decode when the first three comma parts of the
  text are the first three terms of the list. A person who says those three terms in that order is
  also stopped; the Portal's list check would drop that text anyway.
- The lock adds mlx-audio alone with `--no-deps`, as for mlx-whisper, and the four parts that its
  Qwen3-ASR decode imports: transformers 5.23.0, tokenizers 0.23.3, sentencepiece 0.2.3 and
  safetensors 0.8.0. No other pin moved. The service's environment is 886 MB, against 723 MB.
- An owner or admin chooses each Mac's engine in the voice control dialog, with the Portal `Select`,
  among the engines that the Mac's service reports, through `POST .../voice/macs/:macId/engine`.
  It refuses a viewer (404), an engine that Satyr does not know (400) and an engine that the Mac's
  service did not report (409). The heartbeat sends `engines`, and its answer names `engineChoice`.
  `voice_mac` adds `engines` and `engine_choice`, with
  `services/platform/scripts/voice-engine-choice-d1-patch.sql`.
- The Mac follows the choice in `engine_choice.py`. It downloads the files with the usual resume and
  SHA-256 check, answers with its old engine until they are complete, and then changes engine on the
  model host's own thread: the old engine leaves memory before the new one loads. It records its
  engine in `~/.satyr-voice/engine` and starts with it. A choice that changes during a download stops
  that download and keeps its part. An engine's files go after 14 days with no use (D3).
- The dialog shows "Ready with Whisper large-v3-turbo. Downloads Qwen3-ASR 1.7B." while the Mac
  changes, and a note with the download, the licence and the memory.
- The agent's `device_read` returns the shop Macs with their connection, model state, `engine` and
  `engineChoice`. The agent has no tool that changes an engine.
- Mac service 0.5.0. A Portal tab from before the release refuses the Mac list, which has two new
  fields, so a manager's dialog shows no Mac until the tab reloads. Voice commands keep working in
  that tab.

Proofs:

- The Platform's voice journeys pass (4 of 4): a viewer and an engine that the Mac did not report
  are refused, the heartbeat answer carries the choice, and the Mac's view follows its engine. The
  Devices page journey passes, and it now shares the Mac's helpers with the voice journeys in
  `tests/e2e/voice-mac-support.ts`.
- The agent journey J5 (`device-agent.test.ts`) passes: after the person's allow, the agent reads a
  shop Mac that runs Whisper with Qwen3-ASR chosen. The person who denies the read gets nothing, and
  no offered tool changes an engine.
- The Mac journey (`run-journey.py`, 18 of 18 steps) runs the real service. A manager chooses
  Qwen3-ASR. The mirror breaks its 4.1 GB file once and the Mac resumes it. During the download, the
  Mac answers with Whisper. After the change, Qwen3-ASR wrote "Put two trays of Kouign-amann in the
  second oven." with the shop's terms, at a median of 633 ms. The change back to Whisper took no
  download, and Qwen3-ASR's files stayed with their 14 days. The memory reading is `footprint`, not
  `ps`: under memory pressure, `ps` showed 929 MB with Qwen3-ASR loaded. With `footprint`, Whisper
  loaded reads 2,781 MB and Qwen3-ASR loaded 4,468 MB, against about 6,900 MB with both.
- The held-out bench (`confidence-bench.py` with the training noise and Tessa, Moira and Rishi) now
  runs the shipped engine and adds a 14 s command. With the shop's 14 terms: 0 of 105 noise clips
  sent, 0 of 223 good commands lost, 0 of 226 lost with a tail of room sound, and no clip of 561
  past the Portal's wait. The longest noise decode took 0.92 s. The 14 s command stayed whole in
  each of its 24 clips.
- The same bench with the 55-term list of the Phase 0 measure gives the same counts: 0 of 105, 0 of
  223, 0 of 226 and 0 of 561. Without the early stop, each of the 105 noise decodes read the list
  back to the 160-token limit, which takes about 2.8 s. With it, a noise decode took 0.38 s at the
  median and 0.91 s at most.
- The Chrome journey (`run-portal-journey.py` with `SHOP_VOICE_ENGINE=qwen3-asr-1.7b`, 40 of 40
  steps) runs the scenes on Qwen3-ASR. The manager chooses it in the dialog after the install. The
  voice marks name Qwen3-ASR 1.7B, the approval, Slack and email phrases each confirm their own card,
  and each near miss refuses. Qwen3-ASR wrote "Cancel." for Karen's "Cancel.", where Whisper wrote
  "pencil". It wrote the list "Kouign-amann, Financier, Canelé.", and the Portal kept it out of the
  chat and counted it for Qwen3-ASR. At the end the manager changes back to Whisper in the dialog,
  and Whisper's file stays the same file: no download. The default journey, which keeps Whisper,
  passes 38 of 38.
- Before the release: apply `services/platform/scripts/voice-engine-choice-d1-patch.sql` to each
  regional database. Then release the Portal and the Platform, and then run `install.sh --update` on
  each Mac (service 0.5.0). A Mac on 0.5.0 sends `engines`, which a Platform from before Phase 2
  refuses, so the Macs update last.

Release on 2026-11-16 (Tokyo). The owner: "Release Phase 2".

- The D1 patch went to `satyr-organisation-apac` at 15:28 UTC on 2026-11-15. The Worker that ran
  then names its columns, so the two new nullable columns did not change it.
- The release is narrow: the live source `5f968ec01` (the idle-tenant writes release) and the two
  Plan 82C commits after it on dev, as `c41540df1` (ref
  `refs/backup/released-2026-11-16-plan-82c-phase-2`). Dev's other unreleased work stays out. Before
  the upload, the Platform voice journeys, the Devices page journey and the agent journey passed on
  that source (3 files, 6 tests).
- Only the Platform Worker changed: `satyr-edge` `f40050b1`, from `45c909c5`, which is the rollback
  target. The schema check matched (global 62, APAC 368 and 1 extra). The 13 Portal entry files,
  the chunk with the engine choice and `shop-voice/install.sh` in production equal the build. A
  60-second tail had 2 events, both ok, with no exception.
- The shop Mac on the owner's machine took `install.sh --update` from production. It runs service
  0.5.0, and production records `engines` `["whisper-large-v3-turbo","qwen3-asr-1.7b"]`, engine
  `whisper-large-v3-turbo` and no choice, which is Whisper. No engine changed.
- Not checked: a signed-in Portal page, a choice of Qwen3-ASR and a spoken command in production,
  because the agent cannot sign in.

### Phase 3 — Real voices and the decision on D5

- The owner records about 10 minutes of real commands in the shop. The files stay on this Mac in
  `.cache/human/`. Both engines hear the same files.
- One week of the device's daily counts for each engine, on the shop's own device.

The tools (2026-11-16). The owner: "Start Phase 3", then "let's implement the full plan end-to-end".

- The recorder: `apps/portal/voice-recorder.html`, which
  `scripts/shop-voice/recorder.vite.config.ts` serves on `127.0.0.1:3185` only. It opens the
  microphone with the Portal's own settings, and a held key and the wake phrase go through the
  Portal's own worker, so that a clip is what a command sends. `features/voice/capture.ts` holds
  that code for the session and the recorder. The room sound comes straight from the microphone,
  because the worker sends nothing without speech. A prompt where the worker sends nothing stays
  a miss of that prompt, because a person in the shop must say it again too.
- The prompts (`phrase-bench.py prompts`, 55 in all): 15 of the bench's commands, 9 approval phrases
  and 12 near misses, "Stop." and "Cancel." 4 times each, 5 commands from about 2 m after "Hey
  Satyr", 2 bare lists of names, and 30 s of each of 4 room sounds. The recorder writes each
  session to `.cache/human/<session>/`, which git ignores.
- The bench: `phrase-bench.py human .cache/human/<session>`. Whisper and then Qwen3-ASR hear the
  same clips with the shipped engine code and the shop's 14 terms. Each room recording becomes five
  6 s clips. `phrase-score.mjs` scores both with the Portal's own code.
- The device counts: each day, for each host and engine, the commands that the Portal kept and the
  texts that it dropped as noise. The voice dialog shows the last 7 days. The counts stay in the
  browser, as before.

The D5 rule, fixed before the recordings. Qwen3-ASR becomes the default for new Macs only if, on
the owner's recordings, against Whisper:

1. It sends no more room clips to the agent.
2. It loses no more commands, from near or from 2 m.
3. It matches no fewer approval phrases, and it matches no near miss.
4. It hears no fewer stop words.
5. No clip ends after the Portal's wait.
6. It hears no fewer of the command words.

Then the week. A manager chooses Qwen3-ASR for the shop Mac, and the shop uses voice as usual for 7
days. The week passes if the cloud fallback heard no more than 1 transcript in 20, and the owner saw
no message in the chat that came from noise. If either part fails, Whisper stays the default and
the manager can change the Mac back with no download.

Proof of the tools, with a synthetic voice (`recorder-proof.cjs`, Moira, a silent room). These numbers
prove the tools and say nothing about real voices:

- Chrome went through the whole recorder: 55 prompts, each in one attempt, the 5 wake-phrase
  prompts included. The session had 71 clips after the room recordings were cut.
- Both engines heard every clip. Each sent 0 of 20 room clips, lost 0 of 20 commands, matched 9 of
  9 phrases, matched 0 of 12 near misses and heard 8 of 8 stop words. Whisper heard 96.4% of the
  command words near and 93.5% from 2 m, and Qwen3-ASR 100% and 100%. No clip ended after the
  Portal's wait, once each engine is warm as on a Mac. The D5 rule passes on this session.
- Both engines lost both bare lists ("Croissant, latte."): the Portal's text check drops them, as
  the Risks say.
- The Chrome journey passes 39 of 39 steps with the shared capture module and the new counts. Its
  dialog showed "Whisper large-v3-turbo on the shop Mac: 7 commands, 2 dropped as noise."

The owner's part:

1. In the shop, on this Mac, start the recorder from the checkout (add `?only=room` to the page's
   address to record only the shop's sound):
   `pnpm --filter @seams/portal exec vite --config ../../scripts/shop-voice/recorder.vite.config.ts`.
   Open `http://127.0.0.1:3185/voice-recorder.html` in Chrome, choose the microphone that voice
   control uses, and follow the page for about 10 minutes.
2. Give the session name that the last page shows. The agent then runs
   `phrase-bench.py human .cache/human/<session>` and records the result here.
3. If the D5 rule passes, choose Qwen3-ASR for the shop Mac in the voice dialog, and use voice for
   7 days. The dialog's note "Last 7 days on this device" gives the counts for the week.

Release on 2026-11-16. The owner: "let's implement the full plan end-to-end".

- No D1 patch. The release is narrow: the live source `c4e946402` (the Plan 83 Gmail reconnect
  release) with the Phase 2 record and the Phase 3 commit, as `ef29c7c8d` (ref
  `refs/backup/released-2026-11-16-plan-82c-phase-3`). The Platform and Portal types passed on that
  source.
- Only the Platform Worker changed: `satyr-edge` `5f0e9637`, from `470b8e39`, which is the rollback
  target. The schema check matched (global 62, APAC 368 and 1 extra). The 13 Portal entry files,
  the chunk with the week note and `shop-voice/install.sh` (still service 0.5.0) equal the build. A
  60-second tail had 2 events, both ok, with no exception. The recorder page is not in the build.
- The shop Mac needs no update. Counts start on each device when its Portal tab reloads.
- Not checked: a signed-in Portal page in production, because the agent cannot sign in.

Result on the owner's voice, 2026-11-16 (session `2026-11-16-1912`, the MacBook Pro's own
microphone, not in the shop). The owner recorded every prompt. The room sound was not the shop's,
and each room recording starts with the owner reading the prompt aloud, so the D5 run leaves the
room set out (`2026-11-16-1912:-room`):

| Measure                       | Whisper large-v3-turbo | Qwen3-ASR 1.7B |
| ----------------------------- | ---------------------- | -------------- |
| Commands sent to the agent    | 20 of 20               | 20 of 20       |
| Command words heard, near     | 94.6%                  | 99.2%          |
| Command words heard, from 2 m | 83.5%                  | 90.0%          |
| Approval phrases matched      | 8 of 9                 | 9 of 9         |
| Near misses matched           | 0 of 12                | 0 of 12        |
| Stop words heard              | 8 of 8                 | 8 of 8         |
| Bare lists kept               | 0 of 2                 | 1 of 2         |
| Clips after the Portal's wait | 0                      | 0              |

- Whisper wrote "send an email 677" for "Send email six seven seven", so the card refused it and
  the person would say it again. The wake phrase failed one time in 6 from 2 m.
- A new noise form, on 6 s of the owner's room after the prompt: Qwen3-ASR wrote "Rrrrr…" to its
  160-token limit, in 3.55 s. The engine rule dropped it, but after the Portal's 2.8 s wait, so the
  Portal would have sent the clip to the cloud. Service 0.5.1 stops a decode as soon as 60 characters
  of its text compress more than the rule's 2.4. That clip now ends in 0.68 s. On the held-out bench
  the fixed engine keeps its results: 0 of 105 noise clips sent, 0 of 223 good commands lost, 0 of
  226 lost with a tail, no clip of 561 late, and the longest noise decode 0.78 s, against 0.92 s.
- D5 on these recordings: every check passes except the room sound, which waits for the shop.
- The recorder now records the room alone (`voice-recorder.html?only=room`), waits 3 s after the
  key, and says not to read the prompt aloud. `phrase-bench.py human` joins sessions, so the run
  that decides D5 is `human .cache/human/2026-11-16-1912:-room .cache/human/<room session>`. A
  proof with a synthetic, silent room session passed through the whole join.

Release of service 0.5.1 on 2026-11-16, under the same words of the owner. The release is narrow:
the live source `ef29c7c8d` with the Phase 3 record and the fix, as `465d7dcdc` (ref
`refs/backup/released-2026-11-16-plan-82c-service-0-5-1`), with no D1 patch. Only the Platform
Worker changed: `satyr-edge` `c25e66dd`, from `5f0e9637`, which is the rollback target. The schema
check matched, the 13 Portal entry files and `shop-voice/install.sh` (service 0.5.1) equal the
build, and a 60-second tail had 3 events, all ok. The shop Mac took `install.sh --update` from
production: it runs 0.5.1 with Whisper, and production records 0.5.1 and both engines for it.

Deferred on 2026-11-17. The owner: "I won't have a shop for a while, let's skip that step and defer
it for later". The rest of Phase 3 needs a shop, so it waits:

- The room sound: about 3 minutes with `voice-recorder.html?only=room`, in the shop, with nobody
  speaking near the microphone. The four sounds are the espresso machine or the grinder, people who
  talk near the Mac, music or the radio, and a normal moment in the shop.
- The week of use on Qwen3-ASR, which needs the shop's own device and the shop's day.
- Phase 4, which runs only after both pass.

Until then, D5 stays not decided, and its default holds: Whisper is the default for new Macs, and
the shop Mac stays on Whisper. A manager can still choose Qwen3-ASR for a Mac in the voice dialog.
The tools, the owner's speech session `2026-11-16-1912` and the bench stay as they are. Git
ignores the session, so it was copied from the old checkouts to the clone `~/Dev/lowerarchy/pantry` (now `~/Dev/purin-labs/pantry`)
on 2026-11-18. To resume,
record the room session, then run `phrase-bench.py human .cache/human/2026-11-16-1912:-room
.cache/human/<room session>` and record the result here. If the owner records new speech in the
shop, use that session in place of `2026-11-16-1912`.

### Phase 4 — Release

Deferred with the rest of Phase 3 (2026-11-17).

Each release needs the owner's words. The Portal and the Platform go first, then each Mac.

The Phase 3 tools and the device counts are released with Phase 3. If D5 passes after the
week, one change remains: the Platform writes Qwen3-ASR as the choice of each Mac at its enrollment.
A Mac that is enrolled keeps its manager's choice. The installer stays as it is, so a new Mac
answers with Whisper while Qwen3-ASR downloads, and then changes engine. If D5 does not pass, no
change remains, and Whisper stays the default.

## Cost

- Work: Phase 0 about 0.5 day, Phase 1 about 1.5 days, Phase 2 about 1 day. Phase 3 needs about
  15 minutes of the owner's time and a week of counts.
- A Mac on Qwen3-ASR: a 4.1 GB download and 5.1 GB of memory when loaded, against 2.5 GB.
- Cloud: no change. Whisper on Workers AI costs $0.000513 for each audio minute.
- Time: none saved. The speech step stays about 0.4 s of the 3.8–4.3 s before an answer starts.

## Risks and limits

- The list check depends on the readback that the bench saw: one text, in list order, with commas.
  Real noise can give another form, which then reaches the agent as a message. The owner's room
  gave one: one sound repeated to the token limit, which the repeated-text stop now ends early.
- A person who says a bare list of names with commas ("croissant, latte") loses the command. The
  bench had no such command. The early stop is stricter: it needs the first three terms in order.
- Every voice in the bench is synthetic. Real voices, the shop microphone and distance are not
  measured.
- An mlx upgrade must now suit both mlx-whisper and mlx-audio.
- A Mac with less memory than the M4 Pro is not measured (Plan 82 D7).

## Not in scope

- Engines for the answer voice. Kokoro stays, and the same `ModelHost` can hold another voice later.
- Two engines for one command, such as Parakeet for short commands and Qwen3-ASR for long ones.
  The owner asked on 2026-11-14. Parakeet takes no vocabulary (11.7–16.1% errors against
  4.6–6.9%), the router cannot see the text before it chooses, and it saves about 0.35 s.
- A speech engine of another cloud provider, and a Satyr-hosted cloud engine.
- Streaming transcription.
- Japanese (Plan 82 Phase 5). The catalogue can give each engine its languages then.

## Effect on other plans

- Plan 82: D1 stays for every Mac that keeps Whisper. D11's Mac rule gains the list check through
  the Portal in Phase 1.
- Plan 82B: its four gates use the transcription host through the same interface. Its counts can
  name the engine.
- Plan 85: the shop Mac row shows the engine.
