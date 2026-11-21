# Seams Pantry shop voice

The Mac end of Portal voice control ([Plan 82](../../docs/plan-82-portal-voice-control.md)).
It transcribes a spoken command with a speech engine in the shop: Whisper large-v3-turbo with MLX, or
Qwen3-ASR 1.7B when a manager chooses it. The Portal sends the audio directly to this Mac. The Platform never calls the Mac and never receives the
audio or the transcript from it.

## Install

A manager starts an enrollment in the Portal, which gives a one-time code. Run the command on
the Mac, in the account that stays signed in. It needs Apple silicon and macOS 14 or later, and
no administrator.

```bash
curl -fsSL https://<origin>/shop-voice/install.sh | sh -s -- --origin https://<origin> --organisation <id> --mac <id> --code <code> --accept-letsencrypt-terms
```

The Worker serves the script from the Portal's assets. `pack.mjs` writes it at the Portal build.
The flag accepts the Let's Encrypt subscriber agreement, for the certificate of the Mac's name.
The Whisper model has the MIT licence, and the Kokoro voice has the Apache-2.0 licence. The service
downloads them after enrollment (1.7 GB).

The service is a `launchd` job in the person's session. After a restart of the Mac, that person
must sign in, so turn on automatic login. If the macOS firewall is on, allow incoming connections
for the service. To read the state of the service:

```bash
PYTHONPATH=~/.pantry-voice/app ~/.pantry-voice/venv/bin/python -m shop_voice status
```

To remove the service, run this command, and then revoke the Mac in the Portal. A revocation
alone stops the service and deletes its model, certificate and credential.

```bash
PYTHONPATH=~/.pantry-voice/app ~/.pantry-voice/venv/bin/python -m shop_voice uninstall
```

To update an enrolled Mac to the version that the deployed Worker serves, run this command. The Mac
keeps its name, certificate, credential and model. A Mac from before 0.4.0 moves Whisper's files into
the engine's own folder at its next start, so it downloads nothing again.

```bash
curl -fsSL https://<origin>/shop-voice/install.sh | sh -s -- --update
```

## Speech engines

Each engine is one module in `shop_voice/engines/`, behind the `SpeechEngine` interface: its file
pins, its load and unload, and `hear`, which returns the text after the engine's own noise rule
([Plan 82C](../../docs/plan-82C-speech-engines.md)). The ids are those of the catalogue in
`packages/control-api/src/voice-engines.ts`. Each engine keeps its files in `~/.pantry-voice/model/<id>/`.
`ModelHost` (`model_host.py`) loads, unloads and queues the engine and the answer voice alike. The
Portal's text check drops the rest of what an engine invents on noise, for every engine.

A new Mac runs Whisper. An owner or admin chooses another engine for each Mac in the Portal's voice
control dialog, and the Platform names the choice in each heartbeat answer (`engine_choice.py`). The
Mac then downloads the engine's files (Qwen3-ASR: 4.1 GB, Apache-2.0 licence), answers with its old
engine until they are complete, and changes engine. Only one engine is in memory: Qwen3-ASR needs
5.0 GB, against 2.5 GB for Whisper. The old engine's files stay for 14 days with no use, so a change
back needs no download. The Mac records its engine in `~/.pantry-voice/engine` and starts with it.

## Spoken answers

The Portal sends the text of a short answer to `POST /speech`, and the Mac answers with a WAV file in
the Kokoro `af_heart` voice. The text goes to no disk and no log. If the Mac does not answer, the
Portal uses the browser's voice. Phonemes come from misaki with no espeak-ng, because espeak-ng has
the GPL. Words outside misaki's lexicon use the letter rules in `speech.py`, so they sound rough.

## Change a package

Edit `requirements.in`, then run `./lock.sh`. The install takes only the hashes in
`requirements.lock`.

## Test

The journey runs the real install, `launchd`, Whisper and Platform routes on this Mac, against a
local Worker. It needs a speech bench with the model snapshot. The
results go to `output/shop-voice/journey-results.json`.

```bash
python3 scripts/shop-voice/run-journey.py
```

The Portal journey also drives real Chrome from the microphone input to the chat. Run
`pnpm portal:build` first. It needs Playwright 1.64.1 or later, because 1.55 holds
`audioWorklet.addModule` forever. The results go to `output/shop-voice/portal-journey-results.json`.

```bash
PLAYWRIGHT_MODULE=<Playwright package folder> python3 scripts/shop-voice/run-portal-journey.py
```
