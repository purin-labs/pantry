# Plan 82B — Ambient voice: no wake phrase

Status (2026-11-18): draft. Nothing is built. Decisions D1–D9 need the owner. Phase 0 needs
recordings of staff in a shop, and the owner has no shop yet (2026-11-17), so this plan waits.
[The voice handover](plan-82-voice-handover.md) lists it with the other open voice steps. This plan changes
[Plan 82](plan-82-portal-voice-control.md) D2 only for a member who turns on a new mode on one
device. The wake phrase and hold-to-talk (Plan 82 D10) stay as they are. Since
[Plan 91](plan-91-seams-atelier-rename.md) the agent is "Sous Chef", so the addressee rules
below accept the agent's name and the wake phrase's "Satyr".

## Result in one paragraph

A baker talks to the Portal chat agent as to a person in the room, with no wake phrase and no
key. The Portal listens all the time while the mode is on. Four gates decide what happens to
each piece of speech. First, the device checks if the voice is the voice of the signed-in
member. Speech from any other voice, for example a customer, stops on the device and never
becomes text. Second, the shop Mac transcribes the member's speech. Third, an addressee check
decides if the member spoke to the agent or to another person. Fourth, the agent does only safe
work without a confirmation. The first release is smaller: a follow-up window, in which the
member can answer the agent for 8 s after it speaks, with no wake phrase.

## Problem

Plan 82 starts each command with "Hey Satyr" or a held key. The owner's report on 2026-11-02
says that the wake phrase needs a raised voice. A wake model trained on 15,000 more synthetic
clips made false wakes worse (1.17 to 4.39 for each 8 h) and did not hear "Hey Satyr" with no
pause better (Plan 82 D11). The held key needs a free hand, which a baker does not have.

A wake phrase before every sentence is also not natural. After an answer, a person expects to
reply at once: "And the oat milk?" or "No, the one from Tuesday." A public demo of Jev, the
TypeSafe model that Satyr already uses ([Plan 88](plan-88-satyr-funded-jev.md)), decides in
real time if a sentence is for the AI or for another person. It uses the topic of the earlier
turns and the kind of request. This plan uses the same idea, with one more gate before it: who
speaks.

A shared device also has a gap today. Plan 82 says that every voice near a shared device can
give the signed-in member's commands. A speaker check closes that gap for every start mode.

## What exists and stays

| Part                                    | Where                                                                             | Use in this plan                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Capture, VAD, wake phrase, hold-to-talk | `apps/portal/src/features/voice/session.ts`, `wake-worker.ts`, `start-attempt.ts` | The VAD gives the speech pieces. The wake and the key stay.          |
| Shop Mac transcription and noise rule   | `services/shop-voice/shop_voice/engines/` (service 0.5.1, Plan 82C)               | Transcribes the member's speech. The noise rule (Plan 82 D11) stays. |
| Workers AI fallback                     | `services/platform/src/voice/`                                                    | Wake and key commands only (D6).                                     |
| Spoken answers                          | Mac `POST /speech`, Kokoro `af_heart` (Plan 82 D9)                                | The follow-up window starts when an answer ends.                     |
| Speaker model                           | seams-wallet VoiceID: ReDimNet B1, ONNX Runtime Web                               | The speaker check (D2).                                              |
| Jev transport, allowance and switches   | `integrations/typesafe/system-one-client.ts`, Plan 88                             | One option for the addressee check (D5).                             |
| Screen context                          | [Plan 87](plan-87-screen-context.md)                                              | The page on screen is one input to the addressee check.              |
| Chat send, approvals, receipts          | `features/chat/api.ts`, `approval-authentication.ts`                              | An accepted sentence goes through the same send path as typed text.  |
| Daily counts on the device              | Plan 82 D11                                                                       | New counts for each gate.                                            |

## Evidence so far

From the VoiceID evaluation in seams-wallet (`docs/evidence/voiceid-redimnet-20261024`,
`docs/evidence/voiceid-short-speech`). It used LibriSpeech audiobook speech, not a shop
microphone:

| ReDimNet B1                                                      | Value                            |
| ---------------------------------------------------------------- | -------------------------------- |
| Model and runtime download, gzip                                 | 11.7 MB                          |
| Time for 4 s of audio, Chrome WASM on an M4 Pro, p50 / p95       | 71 / 75 ms                       |
| Wrong voice accepted, 4 s / 2 s, threshold for 1% on calibration | 1.37% / 2.88%                    |
| Owner rejected at threshold 0.5: 0.75 s / 1 s / 1.5 s / 2 s      | 26 / 56, 14 / 56, 6 / 56, 2 / 56 |
| Wrong voice accepted at threshold 0.5, every length              | 0 / 728                          |

So the check is reliable for a piece of speech of 1.5 s or more, and weak under 1 s. Distance,
café noise, a moving speaker and a phone microphone are not measured.

From Plan 82: the Mac transcribes at about 0.21 of real time (60 commands, 139 s of audio in
28.7 s) and 0.5 s for a 5 s command. One Jev call costs $0.000022 to $0.000024. Jev latency
for a short sentence is not measured.

## Design

### Modes

The voice dialog gets one choice for each member on each device:

| Mode                | How speech reaches the agent                                   |
| ------------------- | -------------------------------------------------------------- |
| Wake phrase (today) | "Hey Satyr" or the held key                                    |
| Follow-up           | As above, and 8 s after each spoken answer with no wake phrase |
| Ambient             | As above, and any sentence that passes the four gates          |

The default stays "Wake phrase". A move to Follow-up or Ambient shows what the mode does, and
asks for speaker enrollment first.

### Speaker enrollment

1. The member reads three short sentences of about 4 s each, in a normal voice, at the place
   where they work.
2. The device makes one speaker template from the three recordings. The template stays on the
   device in IndexedDB. It goes to no server, not to the Mac and not to the Platform (D4).
3. The Portal checks the template against the three recordings and asks for a new one if the
   recordings do not agree.
4. "Off" or "Forget my voice" deletes the template and the model files.

### The four gates

1. **Speech.** The VAD that exists cuts the audio into pieces of speech. A piece ends after
   0.8 s of silence or at 15 s.
2. **Speaker, on the device.** ReDimNet B1 compares each piece with the template. A piece
   shorter than 1.5 s, or with a score under the threshold, is dropped at once. Nothing about it
   leaves the device, and nothing is stored. Only a count goes up. The device also drops the
   audio while it plays its own spoken answer.
3. **Transcript, on the shop Mac.** The device posts a piece that passed to the Mac, as Plan 82
   does. The Mac applies the noise rule. If the Mac does not answer, the piece is dropped (D6).
4. **Addressee.** A check decides if the sentence is for the agent. The rules come first, and
   the model runs only when no rule decides:
   - The sentence names "Sous Chef", or "Satyr" while the wake phrase is "Hey Satyr": accept.
     "Chef" alone does not count, because a kitchen says "yes chef", and "the sous chef" can be a
     person on the staff. The first "Hey Sous Chef" wake models woke on "hey" + any word + "chef"
     ([Plan 91](plan-91-seams-atelier-rename.md), phase 6), so G0.2 includes such sentences.
   - The sentence starts in the follow-up window: accept, with no model call.
   - The sentence is only a short thanks or a filler word: drop.
   - Else the model gets the sentence, the last two turns of the chat, the time since the last
     answer and the page on screen (Plan 87). It answers `agent`, `person` or `unsure`. Only
     `agent` sends. `unsure` drops the sentence and plays no tone.

An accepted sentence plays the short tone and goes through `sendChat` with
`inputMode: "voice"` and a new field `start: "ambient" | "follow_up"`. A dropped transcript is
deleted at once. Only the counts stay.

### What an ambient sentence can do

A sentence that no person started on purpose must not change records by itself (D7):

- Reads, page moves, filters and draft text run as they do for typed text.
- Any action that changes a record shows its confirmation card, also when the policy does not
  require an approval for typed text. The member confirms with a click or with the spoken
  phrase of Plan 82.
- Money and step-up actions keep their step-up.

### Signs that the Portal listens

- The microphone mark shows the mode: one mark for wake phrase, another for ambient.
- A tone plays only when a sentence is accepted, so a sentence that is not sent is silent.
- "Sous Chef, stop listening" or a tap on the mark pauses ambient mode for 15 minutes. The wake
  phrase still works in the pause.
- The voice dialog shows today's counts: pieces of speech, pieces with the member's voice,
  sentences sent, sentences dropped by the addressee check.

### Information flow

| Data                              | Where it goes                           | Where it is kept                    |
| --------------------------------- | --------------------------------------- | ----------------------------------- |
| Audio of any other voice          | Nowhere                                 | Not kept                            |
| Speaker template                  | Nowhere                                 | The device, until "Forget my voice" |
| Audio of the member               | The shop Mac                            | Not kept (Plan 82 D4)               |
| Transcript that the check drops   | The addressee check, if no rule decides | Not kept                            |
| Transcript that the check accepts | The chat, as typed text                 | The Case, as typed text             |

If D5 picks Jev, a transcript that no rule decides goes to TypeSafe. TypeSafe can keep customer
data for telemetry, fraud checks and legal needs (MCA §4.1(c)) unless Satyr has zero data
retention. That transcript passes `TypeSafeDisclosure` with the purpose `voice_addressee` and
the member's own request authority.

### Agent access

The chat agent can read the voice mode of the member and today's counts. The agent cannot turn
ambient mode on or off, and cannot enroll or delete a voice. The reason: the mode opens the
microphone on one device, and the person must choose it on that device. A spoken "stop
listening" is the person's own command and not an agent tool.

## Decisions

**D1. Ambient mode and Plan 82 D2.** Recommendation: ambient mode is a choice for one member on
one device, off by default. An admin can turn it off for the Organisation with the capability
`voice_ambient`. Cost: one capability row and its backfill. Default: as recommended.

**D2. Where the speaker check runs.** Recommendation: on the device, with ReDimNet B1, so that
another voice never leaves the device. Cost: an 11.7 MB download after opt-in and about 2% of
one core while people speak. The other choice is the Mac: no download, but every voice goes to
the Mac. Default: the device.

**D3. Whose voice passes.** Recommendation: only the member who is signed in on the device.
Another enrolled member's voice is dropped, so a voice never picks the person who acts. Cost: a
shared device needs a sign-in change for each person. Default: as recommended.

**D4. Where the speaker template is kept.** Recommendation: on the device only. Cost: the member
enrolls again on each device and after a browser reset. Default: as recommended.

**D5. The addressee model.** Recommendation: Phase 0 measures Jev and a small local model on the
shop Mac on the same recordings. Choose the Mac model if it is no more than 3 points worse on
each limit, because the talk then stays in the shop. Else choose Jev with a new switch
"Voice addressee" in Plan 88. Cost of Jev: about $0.02 to $0.04 for each baker each day after
the rules, which is $0.60 to $1.20 a month. This uses the $1.00 monthly allowance for each
Organisation at about one baker. Cost of the Mac model: no fee; memory is not measured.
Default: decided by the Phase 0 numbers.

**D6. Ambient mode with no Mac.** Recommendation: ambient and follow-up pause when the Mac does
not answer. The wake phrase and the key still use the Workers AI fallback. Cost: no ambient
mode while the Mac is off. Default: as recommended.

**D7. Confirmation for ambient writes.** Recommendation: as in "What an ambient sentence can
do". Cost: one more click or phrase for each write that starts with no wake phrase. Default: as
recommended.

**D8. Follow-up window.** Recommendation: 8 s from the end of the spoken answer, or from the end
of the answer text if the Portal does not speak it. A new answer opens a new window. Cost: none.
Default: 8 s.

**D9. Legal check.** A speaker template can count as personal information in Japan and in other
APAC markets. Recommendation: before any release, ask counsel about the notice to staff, the
consent text and the notice to customers in the shop. Phase 1 needs the check too, because it
also uses the template. Cost: counsel's fee. Default: no release of Phase 1 or Phase 2 until the
check passes.

## Cost

| Item                                     | For each baker on each day                 | Notes                                               |
| ---------------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| Speaker check on the device              | About 2% of one core while people speak    | 71 ms for 4 s of audio                              |
| Mac transcription of the member's speech | About 13–25 min of GPU for 1–2 h of speech | 0.21 of real time                                   |
| Addressee model with Jev                 | $0.02–0.04                                 | 900–1,800 sentences, half of them decided by a rule |
| Addressee model on the Mac               | No fee                                     | Memory and speed measured in Phase 0                |
| Model download                           | 11.7 MB, one time                          | After opt-in only                                   |

One Mac serves about two or three bakers in ambient mode. Plan 82 did not measure a load of more
than three requests at once.

## Phases

### Phase 0 — Measure before code

No product code. Recordings come only from staff who agree in writing, with café noise from the
existing noise sets. No customer audio is recorded.

- **G0.1 Speaker check in the shop.** Each staff member enrolls, then speaks 40 sentences at
  0.5 m, 1 m and 2 m, and 40 short sentences. Other staff and a played café recording are the
  other voices. Limits: another voice accepted in at most 1% of pieces of 1.5 s or more; the
  member rejected in at most 10% of pieces of 1.5 s or more at 1 m.
- **G0.2 Addressee check.** 300 scripted turns between two staff members and the agent: commands,
  replies to the agent, talk to each other about the same products, talk to a customer, and
  kitchen talk with "chef" and "the sous chef". Limits: talk to a person sent to the agent in at most 2% of sentences; sentences for the agent
  dropped in at most 15%; added latency at most 0.7 s at p95. Measure Jev and the Mac model.
- **G0.3 Load.** Two bakers in ambient mode on one Mac for one hour of recordings. Limit: a
  wake command still gets its transcript within Plan 82 D1a.

### Phase 1 — Follow-up window

Enrollment, the speaker check on the device and the follow-up window (D8), with no addressee
model. Rules: speaker match, the Mac noise rule and the drop of thanks and filler words. The
speaker check also guards the wake phrase and the key, so a customer's "Hey Satyr" does
nothing on a device in Follow-up mode.

### Phase 2 — Ambient mode

The addressee check (D5), the action limits (D7), the marks, the pause and the counts. The
capability `voice_ambient` and its backfill.

### Phase 3 — Release

The owner's shift in the shop with the real counts. G0.1 and G0.2 again on the shift
recordings. The legal check (D9). Then the release needs the owner's word.

## E2E journeys

Each journey uses Chrome's fake microphone with a recorded file, the real speaker model, the
real Mac service and a fake TypeSafe that only records and answers. Each journey writes its
counts and the network log as a repeatable artifact.

- **J1 Follow-up.** The member asks a question with the wake phrase. During the answer window,
  a second voice speaks, then the member asks "And the oat milk?". Outcome: one new message,
  the member's; the second voice sent no request to the Mac.
- **J2 Customer voice stays on the device.** Two minutes of a customer voice and café noise in
  ambient mode. Outcome: no request leaves the device, and the counts show the pieces.
- **J3 Talk to a colleague.** The member says "Can you take the croissants out?" to a colleague,
  then "Sous Chef, how many croissants are left?". Outcome: one message, the second one.
- **J4 Ambient write.** An ambient sentence asks to mark an order ready. Outcome: a confirmation
  card appears and nothing changes until the member confirms.
- **J5 Off in the middle.** The member turns ambient mode off while a piece is at the Mac.
  Outcome: no message, and the microphone is off.
- **J6 Refused.** An admin turns `voice_ambient` off. Outcome: the device returns to wake phrase
  mode, and the chat route refuses a message with `start: "ambient"`.

## Risks and limits

- A short reply under 1.5 s ("Yes", "That one") fails the speaker check and is dropped. The
  member then uses the wake phrase. Phase 0 shows how often this happens.
- The speaker numbers come from audiobook speech. A shop at 1–3 m can be much worse. G0.1
  decides.
- A recording of the member's voice can pass the speaker check. The check is not proof of
  identity, so D7 and the step-ups protect records and money.
- Staff can feel that the Portal listens to them all the time. The marks, the pause and the
  daily counts show what happened. Only accepted sentences become text that stays.
- Jev can send a person's talk to the agent. D7 limits the effect to reads and drafts.
- Ambient mode keeps the Mac busier. G0.3 checks that wake commands stay inside their limit.

## Not in scope

- Voice as proof of identity for approvals or step-ups (Seams VoiceID in the Wallet).
- A choice of member by voice on a shared device.
- Ambient mode in Japanese, before Plan 82 Phase 5.
- Ambient mode with no open Portal tab, or a desktop helper.
- Speaker diarization of a whole conversation, or storage of conversation audio.

## Effect on other plans

- Plan 82: D2 stays the default. This plan adds two opt-in modes and the speaker check.
- Plan 88: if D5 picks Jev, a fourth switch "Voice addressee" and its use in the allowance.
- Plan 87: the page on screen is an input to the addressee check.
