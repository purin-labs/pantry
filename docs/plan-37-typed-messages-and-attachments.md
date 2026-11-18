# Plan 37 — Typed Messages and General Attachments

Status: production acceptance partial · Updated: 2026-09-08 · Owner: Satyr platform

Depends on:
[Plan 15 — Case-Centered Actor Runtime](./plan-15.md),
[Plan 34 — Permission-Aware File Context](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-34-drive-dropbox-file-context.md),
[Plan 35 — Access and Data-Flow Controls](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-35-access-and-data-flow-controls.md),
[Plan 36 — Shared Async Control Primitives](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-36-async-control-primitives.md),
[Runtime architecture: data model (was Spec 1)](./architecture/runtime.md#data-model-and-actor-persistence),
[Runtime architecture: agent sessions (was Spec 3)](./architecture/runtime.md#agent-sessions),
and [Integration architecture: capabilities and tools (was Spec 10)](./architecture/integrations.md#capabilities-and-tools).

## Implementation status

Recorded against the code, not against intent.

Latest scoped production acceptance: text, image, PDF, DOCX, audio metadata,
opaque CAD, mixed content, public-link fetching, and H.264 visual interpretation
have positive evidence in CafeOS `#cafe-ops`. The final video canary reports four
decoded stills and correctly identifies orange pixels without a color hint;
matching preparation receipts and frame manifests are persisted in R2. Audio
remains metadata-only and opaque CAD correctly reports `handler_not_available`.
Worker `43b287a0-8650-4c85-bda4-66d3089ed8af` includes the policy publication
recovery, allocation schema migration, link handoff, Pi image-input fixes, and
the replay-timeout case-walking fix; health returned 200, containers were
unchanged, and 27 schema queries wrote zero rows.
Worker `b484eb27-4697-4935-a97b-4f22edd080c5` adds owned preparation
interruption and sanitized exact-session link-receipt inspection; health
returned 200, all three container images were unchanged, and its 27 schema
queries wrote zero rows.
Worker `477cbb8c-4f81-4990-836d-6fc1281c6d49` adds ledger-proven checkpoint
resume after controlled preparation cancellation. The full platform suite
passes 1,768 tests (three skipped), source and test TypeScript checks pass, and
the remote schema check read 2,117 rows with zero rows written. All three
container images were unchanged. Rotating `ORGANISATION_ADMIN_TOKEN` created active
secret-only version `6881b039-fdd8-48ce-993c-571c3392a625`; `/health` remains
healthy and the application code is unchanged.
Worker `adceba85-5a15-4267-a130-e1640b3cf1d9` adds the exact quarantined-Case
discard operation. The full platform suite passes 1,771 tests (three skipped),
source and test TypeScript checks pass, the remote schema check wrote zero rows,
and all three container images were unchanged. The deployed diagnostic identified `registryId`,
`activationToken`, and `fenceToken` as the quarantined Case's conflicting fields;
logical/physical identity and placement matched. With explicit operator
authorization, the discard operation revalidated that exact mismatch inside
the physical Case, found zero reachable attachments, cleared its Durable Object
storage, and removed only the exact fenced registry row. Production readback
now shows 146 active registry entries and no quarantined entry for this organisation.
The next scheduled attachment-collection audit receipt is due after
2026-09-08T03:45:23Z.
The strict follow-up loopback canary returned
`destination_not_public` / `loopback` with its exact nonce. Exact-session
readback exposed the accepted, digest-bound denial-tool receipt with the same
bounded refusal code and reason while omitting the complete URL. This closes
the production denial-receipt audit.
The scoped Session status endpoint returned in 720 ms. A live canary then proved
exact-turn interruption and cleanup: processing/active reservation became
sleeping/no reservation, with zero harness leases and replay streams. Slack
displayed a generic failure message. The later 18,383,549-byte synthetic H.264
probe proved interruption during active heavy preparation. Exact-session
inspection observed the preparation executor and active run reservation;
interruption destroyed that executor and settled the Session to sleeping with
no preparation, reservation, stream, or harness lease. A follow-up in the same
Session returned nonce `p37-heavy-20260908-y` and committed a new checkpoint at
budget cursor 18. A later byte-distinct live probe destroyed the exact active
executor and still delivered the accepted seven-still result; details follow.
Global execution admission was explicitly reopened by the user (generation 11).
The acceptance-only executor fault command was removed, and clean Worker
`d6a080f1-c12f-4e89-8848-8ee2c5cb4a34` is deployed. The replay-timeout
deployment is now read back. The retained acceptance notes below record the handoff constraints.
The next scheduled attachment-collection audit receipt is the remaining
non-deferred production gate.

| Phase                                      | State    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P37-0 contract and fixture lock            | complete | Rust contracts, generated bindings, type-level negative fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| P37-1 Slack boundary normalization         | complete | rich_text-first canonicalization, `file_share`, manifest v3 with `files:read`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| P37-2 general attachment storage           | complete | content-addressed staging and commit, classification with evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| P37-3 canonical Actor carry-through        | complete | one message shape through Connector, Case, Session, history, restore                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| P37-4 preparation and workspace inspection | complete | Typed allocation parent, Actor-owned receipts, immutable R2 inputs, bounded replacement-lease recovery, and the deployed replay-timeout case-walking fix are implemented. Deployed H.264 decode, persistence, native visual interpretation, DOCX extraction, and audio metadata canaries pass; opaque CAD correctly remains `handler_not_available`. Production probes cover exact active-preparation interruption, cleanup, budget settlement, same-session checkpoint resume, exact executor destruction, and reuse of the accepted seven-still result. VP9 and AV1 report `decoder_required` |
| P37-5 harness and link tools               | partial  | Both tools are registered, scoped, capability-gated, and flow-bound. Credential-free Rust egress pins validated addresses with hostname/TLS checks. Deployed public-link, Pi native-image, and strict loopback-denial canaries pass. Sanitized exact-session receipt readback closes the underlying denial-tool audit. Codex-route acceptance is explicitly deferred pending organisation OAuth authority and owner approval for a pinned-route change                                                                                                                                          |
| P37-6 end-to-end closure                   | partial  | Local attachment journeys and denial coverage pass. Production sweeps completed across 100 actors and migration readers are removed with the accepted historical-digest gap. Modality canaries, exact active-preparation interruption/cleanup, executor destruction/result reuse, same-session resume, and denial-receipt readback pass in CafeOS `#cafe-ops`. The authorized synthetic orphan was safely discarded and no quarantined registry entry remains. The next scheduled attachment-collection audit receipt is pending. Codex acceptance carries the prerequisite deferral above      |

Remaining implementation and production acceptance:

1. ~~**A video decoder.**~~ Resolved for H.264, which is what phones record.
   The contracts crate plans the decode — keyframe selection, `avcC` parameter
   sets, length-prefixed NAL units rewritten to Annex B — as pure parsing that
   stays wasm-safe. The executor decodes each packet on a fresh `openh264`
   decoder and returns JPEG stills with per-frame digests, bounded by picture
   size and a total byte budget with omitted frames counted rather than
   dropped. The decoder is Cisco's, compiled into the binary in the builder
   stage; the runtime image gains no compiler, no ffmpeg, and no subprocess.
   VP9 and AV1 still report `decoder_required` naming the codec.
2. **Preparation closure.** Local preparation now precedes model startup,
   preserves the model's Code Mode execution, and persists accepted inputs with
   identity, source digest, handler revision, limits, usage, and derived keys.
   A pending preparation with a saved result can finish receipt acceptance.
   Without a saved result, a replacement lease can resume Worker preparation
   within the original deadline, with heavy redispatch disabled. The deployed
   binding is proven by the H.264 canary. The 18.4 MB H.264 probe established
   active heavy-preparation interruption, exact executor destruction, budget
   settlement, resource cleanup, and same-session checkpoint resume. The
   saved-result and replacement-lease branches remain locally proven
   implementation invariants. A byte-distinct 18,383,558-byte production probe
   destroyed its exact active executor and still published seven digest-bound
   JPEG stills under `plan37.frames.v1`; Slack then reported `video=avc1`,
   `decodedStills=7`, dominant color `green`, and the exact nonce. The
   acceptance-only fault command was removed after use. Interruption now owns the active
   preparation allocation, destroys that exact executor, waits for the turn to
   settle, and prevents dispatch after cancellation. Exact-session inspection
   distinguishes preparation from model execution and reports whether the
   executor is active, giving the production probe a controlled trigger. Case
   walking now settles a fresh
   running assignment at the exact replay timeout, settles a recovered running
   assignment without model redispatch, observes rejected promises immediately,
   and preserves budget exhaustion; the fix is deployed and read back. Exact
   executor destruction and accepted-result reuse pass in production.
3. **Connection-time link validation.** The local transport now uses a dedicated
   credential-free fetch container. Rust validates the destination and pins its
   connection to the selected IP while retaining the original HTTP Host and TLS
   certificate identity. Redirects return to the Worker for revalidation.
   Compressed bodies are explicitly refused; identity responses are byte- and
   deadline-bounded. Local positive/negative proofs pass; the deployed positive
   public-link canary passes. The later Slack result contains the expected
   refusal code, reason, and nonce. Deployed exact-session inspection now returns
   the accepted history entry and authority digests plus a bounded refusal
   code/reason, while omitting the complete URL. Production receipt readback
   matches the strict denial canary and is complete.
4. **Production acceptance and migration cleanup.** The earlier baseline was
   Worker version `8f7daf76-f964-4ce9-a448-3533fc12bf9d`; the current takeover
   clean closure deployment is Worker version
   `d6a080f1-c12f-4e89-8848-8ee2c5cb4a34`; the
   earlier `1a7a3190-9e21-4171-b5e1-cb140156c055` remains historical. Migration
   sweep and reader cleanup are complete, with the accepted historical-digest
   evidence gap recorded in the handoff. The deployed Container Durable Object
   binding and scoped text/image/PDF/DOCX/audio/opaque-CAD/mixed/link/H.264
   canaries are now proven. Production active-preparation interruption,
   cleanup, same-session resume, and denial-receipt readback are complete. Real
   executor destruction and result reuse pass in production. The quarantined
   synthetic Case is discarded; its next scheduled attachment-collection audit
   receipt remains pending. Codex-route acceptance has the explicit prerequisite
   deferral below.

   Codex-specific acceptance has a separate prerequisite. CafeOS is currently
   pinned to the Satyr-funded `satyr_platform`/Pi route, and production has no
   organisation Codex OAuth connection. The supported organisation-funded Codex route is a
   persisted `organisation_subscription`/OpenAI selection made through an
   owner-authenticated control session; there is no per-session route override.
   Because that selection changes the organisation's default route, no route or global
   funding change was made for this handoff. An organisation-admin bearer token alone
   did not establish the required control session. P37 therefore defers this
   acceptance gate until an owner supplies the organisation OAuth connection and
   approves the persisted route change.

   The executor round trip has been exercised against the built container
   image over HTTP: a real H.264 file decoded to four stills, every digest
   verified, and a tampered body refused as `attachment_digest_mismatch`
   before any parse. The deployed Durable Object binding subsequently produced
   four native JPEG inputs and persisted its preparation receipt; the final
   Slack response correctly described their color.

   The canary itself remains available as a repeatable audit command:

   ```bash
   SLACK_CANARY_USER_TOKEN=xoxp-... SLACK_CANARY_CHANNEL=C... SLACK_APP_USER_ID=U... \
     pnpm --filter satyr-edge canary:plan37
   ```

   It posts one message per supported class with synthetic disposable fixtures,
   checks the addressed reply, and writes `plan37-canary-evidence.json`. Each
   reply must match its nonce and fixture-specific content assertions to count
   as verified. An observed reply alone cannot pass the script. Executor
   receipts require separate runtime evidence. The latest live results are
   recorded in the handoff; the initial `image-g` and `docx-g` attempts omitted
   their attachments because of browser upload timing and are invalid canaries,
   not product failures.

## Preparation before model start

The current Rust reducer admits one Code Mode execution per turn. Its accepted
receipt moves the turn to `ReducingResult`, and organisation/platform reservations
are unique per organisation, session, and turn. Spending that execution on preparation
would consume the model's execution authority. A fabricated Code Mode lease
would violate the same contract.

The local implementation uses these boundaries:

1. Define preparation state and immutable receipt contracts in Lexicon. Bind
   them to the turn, source digest, handler revision, limits, result digest,
   derived keys, measured usage, and terminal outcome.
2. Add an `attachment_preparation` parent alongside the existing Code Mode
   parent in allocation admission. Reuse the turn's open run budget and the
   platform concurrency cap. Keep each parent's identity and lease fields in
   separate union branches.
3. Persist pending work and completed receipts in the Session Actor's
   `session_message_preparation` table. Gate `runtime.startTurn` on accepted
   preparation results. The table joins normal Actor export/restore; snapshot
   keys join R2 placement export. Current lease checks fence late acceptance.
4. Give the executor attachment operation its own required identity and limit
   fields. Remove product-workspace revision fields from that branch. Recovery
   accepts a saved immutable result. Without a saved result, a replacement lease
   can resume Worker preparation within the original deadline and limits.
   Recovery reuses cached stills and never dispatches another heavy executor
   operation; absent decoded content retains an explicit limitation.
5. Materialize the accepted preparation results before `runtime.startTurn`.
   Prove a crash/restart reuses the accepted result, charges preparation once,
   and leaves the model's single Code Mode execution available.

The existing Rust model-turn reducer remains unchanged. Preparation has its
own typed persistence boundary, shares the turn's run budget, and deducts its
elapsed time from the model's remaining wall allowance. Oversized attachments
produce a preserved manifest with an explicit size limitation and zero source
bytes read. These local changes are absent from the prior deployment.

## Decision summary

Replace Slack's current text-plus-image sidecar with one ordered,
provider-neutral `UserMessage` contract. A message contains one or more typed
parts:

- text;
- an HTTP or HTTPS link; or
- a stored file attachment.

A stored attachment carries a behavioral media class, media-identification
evidence, exact source provenance, byte length, content digest, and
organisation-scoped R2 reference. The initial media classes are image, document,
audio, video, and opaque. Archives, CAD files, `.3ds` models, and unfamiliar
formats enter the opaque branch. Their exact media declaration and extension
hint remain available for a later format-specific preparation handler.

The first delivery is Slack inbound. Connector, Case, and Agent Session code
use the provider-neutral contract. Future chat providers normalize their own
payloads into the same type. The existing routing rule continues: an app
mention starts a Case and a reply continues an active Case. Ambient channel
messages and message edits do not start agent turns.

The delivery accepts audio files without interpreting speech. It adds no
speech-to-text, speaker identification, Deepgram, VoxTerm, or other
transcription integration. Audio preparation produces bounded technical
metadata. Video preparation produces bounded technical metadata and sampled
visual frames; its audio track is not transcribed.

General file support has a precise initial meaning. Satyr securely admits,
stores, identifies, preserves, and describes opaque files. Semantic
understanding requires a format-specific preparation handler. Adding such a
handler does not change Slack ingestion, Actor message contracts, or R2
storage.

## Goal

A supported Slack message reaches the selected Satyr harness without losing
authored content, attachment identity, source provenance, or deterministic
canonical order. The system accepts:

- text-only messages;
- file-only messages;
- link-only messages;
- text mixed with links and files;
- images;
- PDFs and common office documents;
- video files;
- audio files; and
- opaque formats such as `.3ds` and CAD files.

Each Slack file source revision is committed once. A successful retry reuses
the already verified object. A message with multiple files reaches the agent
only after the complete batch is verified and committed. Permanent rejection
or retry exhaustion produces one addressed Slack notice with an idempotent
Connector receipt.

## Current baseline

The Actor path already completes addressed text:

```text
signed Slack event
  -> Integration Gateway
  -> ConnectorActor durable admission
  -> CaseActor
  -> AgentSessionActor
  -> pinned Codex or Pi harness
  -> Case output outbox
  -> ConnectorActor Slack delivery receipt
```

Image carry-through exists, including Slack download, R2 storage, hash and
length verification, Case/Session references, and native image model input.
The current implementation has these gaps:

1. `SlackMessageEvent` requires non-empty text, so file-only messages fail at
   the boundary.
2. the parser discards every non-empty message subtype other than
   `message_changed`, including `file_share` deliveries still represented by
   Slack's Events API types;
3. attachment hydration exists, while `case-processing.ts` returns before
   calling it when the event has no inline files;
4. `AttachmentMediaType` contains only PNG, JPEG, and WebP. PDF, office,
   audio, video, CAD, 3D, archive, and unknown files are rejected;
5. attachments travel beside text through parallel arrays in Connector, Case,
   Session, journal, and harness structures;
6. Slack `text`, `blocks`, `files`, and legacy `attachments` are not assigned
   explicit canonicalization precedence;
7. links survive only as characters inside Slack text, and the harness has no
   bounded public-link reader;
8. Case purpose, context query, harness instruction, and accepted content
   digest are derived from text alone;
9. the D1 Slack provider manifest omits `files:read`, although the compiled
   Slack adapter and OAuth request require it;
10. attachment R2 objects are purged during organisation erasure, while Case-scoped
    attachment retention and collection are not defined; and
11. the full Slack Actor journey has no attachment-modality coverage. Its
    current local Miniflare/workerd run must be stable before this plan can
    claim end-to-end closure.

Plan 34's Dropbox and Google Drive projections are a separate boundary. They
are durable, explicitly granted organizational context. Plan 37 attachments
are message-scoped input admitted under the current conversation's authority.
An inbound Slack attachment does not create or broaden a Drive or Dropbox
grant and does not become organizational context automatically.

The current `WorkspaceExecutorContainer` also has a narrower contract than
this plan requires. It accepts only a JSON product-folder validation operation,
with a 1 MiB request limit and 256 KiB file limit. Document and media
preparation therefore require a new bounded binary-streaming operation on the
existing executor boundary. The plan does not treat that operation as already
implemented.

## Fixed product decisions

1. Lexicon (`packages/contracts`) owns the canonical Rust contracts and
   generated TypeScript bindings. Handwritten overlapping domain types are
   deleted.
2. `UserMessage` is ordered and non-empty. Its cross-language representation
   contains a required first part plus a list of remaining parts.
3. Text is one message-part variant. File-only and link-only messages are
   valid.
4. Links and files are distinct. A link names a remote resource. A stored file
   has admitted bytes, integrity evidence, an owning reference, and an R2
   lifecycle.
5. Attachment behavior dispatches on the closed image, document, audio, video,
   and opaque media-class union. Exact format identity remains an open,
   validated value inside each branch.
6. Media identification records its evidence. A provider declaration is never
   described as byte-verified. Reliable signatures and container inspection
   can produce a verified identity. Unknown input becomes opaque
   `application/octet-stream`.
7. Provider filenames and extensions are display values and classification
   hints. They are never filesystem paths, object-key components, executable
   selectors, or authority.
8. Executables and opaque files are inert. Archives are not expanded. The
   Worker never launches attached bytes.
9. Message attachment admission is batch-atomic from the agent's perspective.
   Satyr stages and verifies every file before it commits the canonical
   message. A rejected batch never starts an AgentSession turn.
10. ConnectorActor owns staged Slack acquisition and pre-Case rejection
    delivery. CaseActor becomes the primary owner of committed message
    attachment references. AgentSession history and preparation outputs are
    secondary references.
11. Message attachments use the `session` retention class. Original bytes are
    collectible only after the accepted reachability inventory proves that no
    retained Connector work, Case trigger, Session history, checkpoint, or
    preparation result references the content object.
12. Prepared derivatives use the original attachment's retention class or a
    shorter one. Staged objects have a fixed short expiry and are deleted after
    rejection, cancellation, or abandoned Connector work.
13. Links are parsed during ingress and never fetched automatically. The agent
    may request a bounded public HTTP(S) read through a trusted tool admitted
    by session policy.
14. Image attachments use native image model input after byte-signature and
    integrity verification.
15. Common documents use bounded deterministic extraction. Failure to extract
    produces an explicit limitation and preserves the stored attachment
    reference.
16. Video preparation returns bounded container metadata and sampled visual
    frames. Audio preparation returns bounded container, codec, channel,
    duration, and signal metadata. Neither path produces a transcript.
17. Opaque attachments produce a model-visible manifest containing display
    name, media identification, extension hint, byte length, and attachment ID.
    A later format handler can replace that preparation result for recognized
    formats.
18. Heavy document and media work uses a new operation on the existing
    `WorkspaceExecutorContainer`. The platform streams one exact verified R2
    object to the network-disabled container. The container receives no R2,
    Slack, organisation, or provider credential.
19. The initial acquisition limit retains the current 20 MiB per-file ceiling.
    One message admits at most 10 files and 50 MiB total. Text extraction is
    capped at 1 MiB and 32,768 normalized characters per file. Video sampling
    is capped at 12 frames and 8 MiB of returned frame bytes. Public link reads
    are capped at 5 MiB transferred and 32,768 normalized characters returned.
    Raising a limit requires measured Worker, R2, deadline, memory, and
    container evidence.
20. Shared deadlines and cancellation use Plan 36 primitives where native APIs
    do not already express ownership. A timed-out acquisition or preparation
    settles and cleans up before its owner reports completion.
21. Attachment text, sampled frames, technical metadata, public-link results,
    and tool outputs retain the original request authority and provenance. The
    final Case output passes the same cumulative information-flow checks as
    text-only work.
22. Slack-hosted files are byte attachments. Slack remote-file blocks become
    links when they contain an admissible HTTP(S) target. A remote file with no
    usable target receives an explicit unsupported-content notice.
23. Slack's legacy `attachments` field and provider-generated unfurls are not
    user-authored message parts. The canonicalizer uses the authored text or
    rich-text representation that contains the originating link.
24. Message edits remain Cue observations and do not start agent turns. Adding
    edit-driven execution later requires an explicit immutable supersession
    contract.
25. The top-level Slack `file_shared` event does not create or hydrate Case
    input because it lacks message and thread identity. The addressed message
    event is authoritative.
26. No new Actor kind, queue, media service, retrieval vendor, or functional
    runtime is introduced.
27. There is one current runtime shape after cutover. Compatibility code lives
    only in the bounded persistence migration and is removed after the Actor
    registry migration inventory reaches zero old-schema objects.

## Canonical domain model

The following TypeScript is a semantic sketch. Rust remains authoritative.
String and number identities that cross into TypeScript are generated as
brands, and only boundary parsers/builders can create them.

```ts
type UserMessage = {
  readonly firstPart: UserMessagePart;
  readonly remainingParts: readonly UserMessagePart[];
};

type UserMessagePart =
  | {
      readonly kind: "text";
      readonly text: NonEmptyText;
    }
  | {
      readonly kind: "link";
      readonly link: MessageLink;
    }
  | {
      readonly kind: "attachment";
      readonly attachment: StoredMessageAttachment;
    };

type MessageLink = {
  readonly url: HttpUrl;
  readonly presentation:
    | { readonly kind: "url" }
    | { readonly kind: "label"; readonly label: NonEmptyText };
};

type MediaEvidence<TMediaType> =
  | {
      readonly kind: "signature_verified";
      readonly mediaType: TMediaType;
      readonly method: "magic_bytes" | "container_structure";
    }
  | {
      readonly kind: "provider_declared";
      readonly mediaType: TMediaType;
      readonly provider: "slack";
    };

type AttachmentDescriptor =
  | {
      readonly kind: "image";
      readonly media: MediaEvidence<ImageMediaType>;
    }
  | {
      readonly kind: "document";
      readonly media: MediaEvidence<DocumentMediaType>;
    }
  | {
      readonly kind: "audio";
      readonly media: MediaEvidence<AudioMediaType>;
    }
  | {
      readonly kind: "video";
      readonly media: MediaEvidence<VideoMediaType>;
    }
  | {
      readonly kind: "opaque";
      readonly media:
        | MediaEvidence<OpaqueMediaType>
        | {
            readonly kind: "unknown";
            readonly mediaType: "application/octet-stream";
          };
      readonly formatHint: OpaqueFormatHint;
    };

type AttachmentSource = {
  readonly kind: "slack";
  readonly integrationAccountId: IntegrationAccountId;
  readonly workspaceId: WorkspaceId;
  readonly channelId: ChannelId;
  readonly messageTs: SlackMessageTimestamp;
  readonly fileId: SlackFileId;
  readonly revision: SlackFileRevision;
};

type StoredMessageAttachment = {
  readonly id: AttachmentId;
  readonly displayName: DisplayFilename;
  readonly extensionHint: FileExtensionHint;
  readonly descriptor: AttachmentDescriptor;
  readonly byteLength: ByteLength;
  readonly sha256: Sha256Digest;
  readonly objectKey: OrganisationAttachmentObjectKey;
  readonly source: AttachmentSource;
  readonly retention: "session";
  readonly storedAt: Timestamp;
};
```

`ImageMediaType`, `DocumentMediaType`, `AudioMediaType`, and `VideoMediaType`
are distinct branded types. An image descriptor cannot contain a video media
type through ordinary TypeScript construction. `OpaqueMediaType` accepts any
validated IANA-shaped media type. `OpaqueFormatHint` is diagnostic and cannot
select execution.

`CaseContent` gains a `user_message` branch. The existing `text` branch remains
for generated Case entries and terminal summaries. `ConnectorIngress`,
`CaseTriggerRecord`, the Case walking path, and canonical session input delete
their parallel attachment arrays. A user message owns its attachments through
its ordered parts.

Attachment acquisition has an explicit owner and settlement:

```ts
type AttachmentAcquisition =
  | {
      readonly state: "staged";
      readonly batchId: AttachmentBatchId;
      readonly candidate: ResolvedRemoteFile;
      readonly expiresAt: Timestamp;
    }
  | {
      readonly state: "committed";
      readonly attachment: StoredMessageAttachment;
    }
  | {
      readonly state: "retryable_failure";
      readonly failure: AttachmentFailure;
    }
  | {
      readonly state: "rejected";
      readonly rejection: AttachmentRejection;
    };
```

Preparation results carry all outputs required by their branch:

```ts
type AttachmentPreparation =
  | {
      readonly state: "prepared";
      readonly result: PreparedAttachment;
      readonly receipt: AttachmentPreparationReceipt;
    }
  | {
      readonly state: "unavailable";
      readonly attachmentId: AttachmentId;
      readonly reason: AttachmentPreparationFailure;
    };

type PreparedAttachment =
  | {
      readonly kind: "image";
      readonly attachmentId: AttachmentId;
      readonly image: VerifiedImageInput;
    }
  | {
      readonly kind: "document";
      readonly attachmentId: AttachmentId;
      readonly text: ExtractedAttachmentText;
    }
  | {
      readonly kind: "video";
      readonly attachmentId: AttachmentId;
      readonly metadata: VideoMetadata;
      readonly frames: NonEmptyVideoFrames;
    }
  | {
      readonly kind: "audio";
      readonly attachmentId: AttachmentId;
      readonly metadata: AudioMetadata;
    }
  | {
      readonly kind: "opaque";
      readonly attachmentId: AttachmentId;
      readonly manifest: OpaqueFileManifest;
    };
```

An empty or image-only document produces `unavailable` with a precise reason.
The model still receives its stored attachment manifest and the limitation.
Switches over message parts, media classes, acquisition states, preparation
states, and preparation results are exhaustive and end in `assertNever`.

## Slack boundary normalization

`services/platform/src/slack/events.ts` remains the sole raw Slack message
parser. It produces a Slack-specific candidate. Provider-specific shapes end
there.

```ts
type SlackFileCandidate =
  | {
      readonly kind: "hosted";
      readonly file: SlackHostedFileMetadata;
    }
  | {
      readonly kind: "needs_info";
      readonly fileId: SlackFileId;
    }
  | {
      readonly kind: "remote_link";
      readonly fileId: SlackFileId;
      readonly url: HttpUrl;
      readonly label: DisplayFilename;
    };
```

The canonicalization precedence is fixed:

1. If all user-visible `rich_text` blocks are supported, traverse those blocks
   and their elements in provider order.
2. Otherwise use the non-empty top-level `text` fallback as one parsed authored
   representation.
3. If neither representation can faithfully preserve user-visible content,
   reject the candidate as `unsupported_message_content`.
4. Parse text and HTTP(S) links from the selected representation without
   duplicating either.
5. Append hosted files in Slack's `files[]` order. Slack exposes files
   separately and does not define a visual interleaving with text blocks.
6. Convert an admissible remote-file URL into a link part. Do not treat a
   remote file block as Slack-hosted bytes.
7. Ignore provider-generated unfurl previews and legacy secondary
   `attachments`; their originating authored link remains in text or rich
   text.

The parser accepts `app_mention`, ordinary `message`, and `file_share` through
one message path. `file_share` is an allowed subtype, not a parallel lifecycle.
Slack Connect placeholders containing `file_access: "check_file_info"` become
`needs_info` candidates.

`message_changed` continues to produce a Cue observation and is ineligible for
Case routing. The top-level `file_shared` event is ignored for Case admission.
Bot-authored messages remain excluded for loop prevention.

The normalized event derives the same Case and thread identities for text and
file-only roots. Connector deduplication uses the Slack event ID for delivery
identity and workspace/channel/message timestamp for source identity. Different
payloads under the same identity are conflicts. Message edits do not enter this
deduplication path.

The Slack connection and readiness path must use one authoritative scope set.
Plan 37 adds `files:read` to the D1 provider manifest and verifies parity with
the compiled Slack adapter and OAuth request. The initial conversation scope is
public channels, private channels, and one-to-one DMs. MPIM remains unsupported
unless `mpim:history` is added deliberately with matching onboarding and
production acceptance.

## Derived message views

The canonical message is authoritative. Four standalone functions derive the
text views required by the existing Actor path:

```ts
renderMessageForModel(message): NonEmptyText
deriveContextQuery(message): ContextQuery
deriveCasePurpose(message): NonEmptyText
digestUserMessage(message): Sha256Digest
```

`renderMessageForModel` preserves text and links, renders one provenance-marked
manifest entry per attachment, and incorporates prepared document text, video
frames, or audio metadata when available. `deriveContextQuery` uses bounded
authored text, link labels or hostnames, and attachment display names. A
message with no useful semantic query receives the empty-query context path;
context assembly must accept that state explicitly.

`deriveCasePurpose` produces a bounded purpose from the first authored text or
link label. A file-only root uses a deterministic description such as
`Review attached file: menu.pdf`. `digestUserMessage` covers ordered parts,
source identities, attachment content digests, and link values. The accepted
input digest therefore binds every model-visible input part.

## Secure attachment acquisition and batch commit

`services/platform/src/slack/attachments.ts` becomes the provider adapter from
`SlackFileCandidate` to `AttachmentAcquisition`.

The adapter must:

1. hydrate placeholders with `files.info` and retrieve the exact addressed
   message only when inline metadata is incomplete;
2. remove the early empty-file return in `case-processing.ts` so hydration is
   reachable;
3. bind every provider request to the resolved Slack integration account and
   current credential generation;
4. enforce file-count, declared per-file, and declared aggregate limits before
   transfer when provider metadata permits;
5. stream each download to a short-lived organisation-scoped staging key while
   hashing and enforcing the actual-byte limit;
6. send the Slack token only to Slack API and approved Slack file hosts and
   revalidate every redirect;
7. retain the provider filename as display data and generate storage and
   executor paths independently;
8. identify known formats from signature or container evidence first,
   provider-declared media type second, and extension hint only as diagnostic
   input;
9. place unidentified or specialist formats in the opaque branch;
10. reuse an existing verified source-revision acquisition record on retry;
11. return typed retryable and permanent outcomes; and
12. settle and clean up through Plan 36 finalizers or native single-resource
    cleanup where it is smaller.

The batch commit protocol is:

```text
Connector case-work claim owns batch
  -> stage and verify every hosted file
  -> derive organisation-scoped sha256 object keys
  -> publish or verify every content object
  -> transactionally record the complete committed batch
  -> admit one canonical UserMessage to CaseActor
  -> transfer primary reference ownership to the Case trigger
  -> delete staging objects and settle the Connector batch
```

R2 has no multi-object transaction. Batch atomicity applies to Case and agent
admission. A crash after publishing one content object is recovered through the
Connector acquisition record and reachability cleanup. A rejected or exhausted
batch deletes its staging references and emits one Connector-owned rejection
notice. The agent never sees a partial batch.

Final content objects use an organisation-scoped content-addressed key. Metadata
records organisation identity, content digest, byte length, media identification,
encryption binding, retention class, and creating source. Reads verify the
organisation prefix, object length, digest, expected source reference, and live
owning reference before returning bytes.

## Attachment preparation

Preparation happens before the first model call for document, video, and audio
attachments. Images use the existing Worker-side integrity read. Opaque files
need no executor call for the initial delivery and become bounded manifests.

| Media class | Initial preparation                    | Harness projection                            |
| ----------- | -------------------------------------- | --------------------------------------------- |
| Image       | Worker R2 integrity and signature read | Native image input                            |
| Document    | Bounded deterministic extraction       | Provenanced text or explicit limitation       |
| Video       | Container metadata and sampled frames  | Provenanced metadata plus native image inputs |
| Audio       | Container and signal metadata          | Provenanced metadata text                     |
| Opaque      | No byte interpretation                 | Provenanced file manifest                     |

Common document extraction covers plain text, Markdown, JSON, bounded CSV,
PDF, DOCX, and ODT. Legacy DOC and other office formats remain opaque until a
deterministic handler is proven. Extracted content is untrusted message input
and cannot grant tools, capabilities, or authority.

The existing executor request becomes an exhaustive operation union. The
product-folder branch keeps its current fields. A new
`prepare_message_attachment` branch requires organisation, Case, session, turn,
attachment, digest, media class, handler revision, operation, deadline, and
maximum output limits. Product-workspace revision fields cannot appear in the
attachment branch.

The platform reads the exact verified R2 object and streams it to the
network-disabled container. The executor materializes the bytes below a fresh
read-only input root using an attachment-ID-derived path. Provider display
names never become paths. The executor runs a compiled handler selected from
the trusted media class and handler revision, returns a bounded typed result,
removes temporary files, and is destroyed after settlement.

Document and media parsers run with wall-time, CPU, memory, output-byte,
decompressed-byte, archive-entry, document-page, frame-count, frame-dimension,
and generated-file limits. Encrypted documents, recursive archives, active
content, macros, external entity resolution, filesystem escape, and parser
network access are rejected. Opaque archives are never expanded by the initial
delivery.

Video preparation samples visual frames deterministically from the attachment
digest and handler revision. Audio streams inside videos produce technical
metadata only. Audio preparation reports technical metadata and bounded signal
facts without semantic speech claims.

AgentSessionActor persists an immutable preparation receipt before starting
the model. The receipt binds input digest, handler revision, limits, result
digest, derived object keys, measured usage, and terminal outcome. Restore and
replay reuse the accepted result rather than rerunning the parser. Derived
frames are content-addressed R2 objects covered by the same reachability and
retention rules as the source attachment.

The current derived object cache reuses successful decodes by source digest
and sampling policy revision. The tool writes each verified still and a manifest under
`attachments/<organisation>/derived/<sha256>/<policy>/`
(`services/platform/src/messages/derived-stills.ts`). Re-inspecting or
materializing the same attachment reads there first and takes no allocation.
A later turn without that attachment does not automatically receive the
frames. The active inspection delivers verified images before returning its
textual result. A digest failure aborts persistence without publishing a
completed manifest. Cache misses and crashes can cause another decode; this
cache does not establish exactly-once preparation or immutable replay receipts.
The canonical harness projection remains text plus native images for the
initial delivery:

- authored text, links, manifests, extracted document text, audio metadata,
  video metadata, and explicit limitations render into provenance-marked text;
- image attachments and sampled video frames become native image inputs; and
- harness history retains the original attachment reference and preparation
  receipt so restoration cannot silently change the input.

Codex and Pi receive the same canonical projection. Provider-specific fields
never enter either adapter. A future native-audio model input extends the
prepared projection and its exhaustive adapter mappings without changing the
stored message contract.

## Public link reading

Slack text and supported rich-text elements normalize HTTP(S) links into
ordered link parts. Fetching requires an explicit `read_message_link` tool
call under the current request authority and immutable harness catalog.

The trusted reader:

- accepts HTTP and HTTPS only;
- rejects URL user information, private, link-local, loopback, and cloud
  metadata destinations;
- admits only standard HTTP/HTTPS ports;
- resolves and validates the destination at the trusted egress boundary and
  prevents DNS rebinding;
- revalidates every redirect with a maximum of three;
- sends no ambient credential, cookie, Slack token, or provider token;
- enforces owned deadlines and compressed and decoded byte limits;
- extracts bounded text from explicitly supported textual responses;
- returns a typed binary-content result rather than decoding binary bytes as
  text; and
- records redacted origins, path digests, final media type, byte counts,
  content digest, and tool receipt.

The exact URL remains inside request-authorized message content because query
strings and fragments may contain secrets. Logs, metrics, audit records,
support references, and ordinary receipts never record complete URLs. Redirect
targets receive the same treatment.

The capability remains absent from production catalogs until SSRF, redirect,
DNS, compressed-body, timeout, secret-redaction, and information-flow tests
pass. Binary link content is not converted into an attachment automatically.

## Actor ownership and rejection delivery

The Actor chain retains its current owners:

```text
Slack parser and attachment adapter
  -> ConnectorActor: durable ingress, staging, retry, and rejection notice
  -> CaseActor: canonical UserMessage and primary attachment references
  -> AgentSessionActor: preparation receipts and private harness history
  -> Codex/Pi adapter: canonical text/image projection
  -> Case output outbox
  -> ConnectorActor: addressed Slack response and receipt
```

ConnectorActor adds one idempotent `ingress_notice` delivery branch for input
that cannot become a Case trigger. It is keyed by Slack event ID, addressed to
the exact channel/thread, contains only bounded safe reason text and a support
reference, and stores the Slack receipt. Permanent policy, size, unsafe-file,
unsupported-remote-file, and retry-exhaustion outcomes use this path. It cannot
execute a provider mutation or create an AgentSession.

Commerce proposal, approval, action-ledger, and provider-receipt contracts do
not gain attachment fields. Agents consume `UserMessage` as input and emit the
existing typed commerce proposals.

## Retention and reachability

The Case trigger is the primary owning reference for committed message
attachments. Connector staged work owns only staging references. Session
history, preparation receipts, and derived objects are secondary references.

Attachment cleanup joins the existing organisation/session reachability inventory:

1. each Connector, Case, and Session export reports exact source and derived
   object keys plus digests;
2. staged objects whose batch expired or settled without admission are
   candidates for immediate deletion;
3. committed source and derived objects remain while any retained authority
   references them;
4. Case archival alone does not prove unreachability;
5. accepted Case/session erasure and organisation erasure compute the complete
   reference inventory before deletion; and
6. cleanup records object identity, digest, owning reference disposition, and
   terminal deletion receipt without retaining message content.

The implementation adds an explicit expiry for Connector acquisition records
and preparation failures. It does not depend on R2 lifecycle deletion that can
run without Actor reachability evidence.

As implemented, CaseActor and AgentSessionActor each expose
`listReachableAttachmentObjectKeys()` — the source keys their triggers and
turns still name. `collectMessageAttachments`
(`services/platform/src/messages/attachment-reachability.ts`) lists the
organisation's attachment prefix, treats a derived object as reachable exactly when
a reachable source shares its digest, deletes the rest, and returns a
`plan37.attachment-collection.v1` receipt naming every deleted key. It lists
the whole prefix before deleting anything and aborts, deleting nothing, if
the listing cursor fails to advance. Organisation erasure still purges the prefix
outright.

The collector runs from the Worker's cron
(`services/platform/src/messages/attachment-collection.ts`). Each pass takes
up to four active organisations whose last collection is older than a day, asks
every live Case and Session actor for its key set, and collects with a
one-day grace window so an in-flight staging object or a trigger still being
written is never a candidate. A Slack source pointer follows the content key
in its metadata; a pointer whose metadata cannot be read is kept. An organisation
whose registry holds a reserved, exporting, or quarantined actor, or whose
actor does not answer, is skipped whole — deletion needs a complete
inventory, and silence is not one. Every pass writes its record, collected or
skipped-with-reason, to `attachment-collection/<organisation>/<collectedAt>.json`
and `…/latest.json` in the same bucket; the latest record paces the next
pass.

The latest collector check found exactly one reserved Case entry among 139
registry entries. The supported `reconcile_reserved` operation returned
`skipped=138`, `quarantined=1`; read-back showed
`activation_conflict_during_orphan_repair`, `stateVersion=0`, and no activation
timestamp. The skipped receipt remains unchanged at `03:45:23Z`, with no data
deleted. Registry schema version 1 differs from current Case schema version 2,
and the final read-only HTTP 200 activation check confirmed
`registrySchema=1`, `state=0`, and
`activationVerification={kind:mismatch,reason:identity,schemaVersion:1,stateVersion:1}`.
The earlier schema-only hypothesis is superseded: the identity mismatch is
confirmed. No repair or unquarantine write was made. Collection for this Case is
explicitly deferred until a dedicated credential-reconciliation procedure
proves the replacement identity or an operator authorizes retirement. The
quarantined entry remains the safety boundary and continues to block deletion.

Production resolution (2026-09-08): the operator authorized retiring this
synthetic Case. Normal `retired` was rejected as the implementation model
because that lifecycle requires a previously active, exported Actor. The
deployed `discard_quarantined_case` command instead requires the exact organisation,
Case, registry ID, fence, quarantine timestamp, and quarantine reason. The Case
itself permits deletion only when schema and durable identity still match and
the mismatches are exactly `registryId`, `activationToken`, and `fenceToken`.
The command returned `quarantined_case_discarded`, actor state version 1, and
zero reachable attachments. Exact HTTP readback now returns `actor_not_found`;
D1 reports zero rows for the registry ID and 146 active / zero quarantined rows
for the organisation. The previous skipped attachment-collection audit receipt remains
the latest until normal 24-hour pacing permits the next pass after
2026-09-08T03:45:23Z.

## Migration and deletion

This is a breaking internal cutover with one persistence-boundary migration.

Before implementation, inventory every persisted occurrence of the old
attachment shape, including:

- Connector pending case-work payloads and accepted ingress rows;
- Case trigger payloads and journal entries;
- Agent Session `session_turn_attachment` rows;
- canonical harness history attachment entries;
- checkpoint, export, relocation, and erasure reference inventories; and
- rejected, expired, and stored attachment references.

2026-09-06 exception: all three production organisation sweeps completed across 100
actors with no quarantine or unreachable state. Historical old/new digests were
never recorded and original Case payloads were overwritten. The user explicitly
accepted this evidence gap and authorized reader removal, preserving existing
receipt and quarantine data. No historical digests are claimed.

The production cutover is complete: pending Slack work was drained, the three
organisation registries were swept, active callers use `UserMessage`, and no
quarantined or unreachable Actor was found. The migration readers, obsolete
operator sweep route, image-only attachment shape, and old sidecar paths were
removed and deployed. Existing receipt, quarantine, and content-free audit
evidence remain; no database deletion was performed.

No runtime dual-read, dual-write, feature flag, legacy request parser, or
unbounded lazy migration remains after the zero-old-schema gate.

## Implementation phases

The checklists below preserve the original phase acceptance scope. The summary
table above is the current status ledger; these boxes remain unchecked until
the corresponding closure evidence is recorded and should not be read as a
claim that the completed phases have no implementation.

### P37-0 — Contract and boundary lock

- [ ] Inventory every production and persisted use of `StoredAttachmentRef`,
      `AttachmentRef`, attachment arrays, Slack text, and harness attachment
      history.
- [ ] Add Rust `UserMessage`, message-part, link, media-evidence, descriptor,
      source, stored attachment, acquisition, preparation, and receipt
      contracts.
- [ ] Generate branded TypeScript bindings and add boundary parsers/builders.
- [ ] Update Specs 1, 3, and 10 for ownership, retention, preparation, link
      reads, and rejection notices.
- [ ] Add type fixtures proving empty messages, cross-media descriptor
      mismatches, unvalidated URLs, wrong lifecycle fields, broad spreads, and
      direct branded-value construction are rejected.
- [ ] Add Rust/TypeScript round-trip fixtures for text, file-only, mixed parts,
      image, PDF, audio, video, `.3ds`, CAD, and unknown files.

Exit gate: contracts compile across Rust and TypeScript; every domain switch is
exhaustive; the persistence inventory is complete; and unknown formats have
one valid opaque representation.

### P37-1 — Slack normalization and scope parity

- [ ] Implement rich-text-first, text-fallback canonicalization.
- [ ] Parse file-only and link-only messages without duplicating authored
      content.
- [ ] Route ordinary `files[]` and `file_share` through one parser path.
- [ ] Resolve Slack Connect placeholders and normalize remote files to links.
- [ ] Keep edits and top-level `file_shared` events outside Case admission.
- [ ] Add `files:read` to the D1 provider manifest and prove parity with the
      compiled adapter, OAuth request, readiness, and deployment documentation.
- [ ] Preserve current mention/thread routing and bot-loop prevention.
- [ ] Implement message rendering, context query, Case purpose, and canonical
      digest derivation for text, link-only, and file-only inputs.

Exit gate: representative raw Slack fixtures produce one deterministic,
non-empty candidate without raw Slack objects entering core logic.

### P37-2 — General storage and first vertical Actor slice

- [ ] Implement staged, bounded, source-revision-idempotent acquisition.
- [ ] Fix attachment hydration reachability.
- [ ] Add signature/container evidence and opaque fallback classification.
- [ ] Implement organisation-scoped content-addressed R2 publication and batch
      settlement.
- [ ] Carry `UserMessage` through Connector, Case, Session, accepted digest,
      journal, history, restore, replay, export, and erasure.
- [ ] Keep native image input working under the generalized contract.
- [ ] Render opaque attachment manifests for both harnesses.
- [ ] Add Connector-owned idempotent rejection notices.
- [ ] Migrate active Actor state and delete the old runtime shape after the
      zero-old-schema gate.

Exit gate: text, links, images, documents, audio, video, CAD/3D, and unknown
files are securely admitted and preserved end to end. Images are visible to
the model; every other file has an accurate manifest and explicit preparation
status. Rejected batches produce one addressed receipt and never start an
agent turn.

### P37-3 — Document preparation

- [ ] Add the branch-specific binary-streaming executor protocol.
- [ ] Add bounded plain-text, Markdown, JSON, CSV, PDF, DOCX, and ODT handlers.
- [ ] Store immutable preparation receipts and reuse them across restore.
- [ ] Render extracted text or a precise limitation with attachment
      provenance.
- [ ] Cover parser isolation, decompression limits, active-content rejection,
      cancellation, and temporary-file cleanup.

Exit gate: supported document fixtures reach Codex and Pi as identical bounded,
provenanced text; unsupported or empty documents remain valid stored inputs
with explicit limitations.

### P37-4 — Video and audio preparation

- [ ] Add deterministic video metadata and visual-frame sampling.
- [ ] Add deterministic audio technical metadata and signal inspection.
- [ ] Prove that neither path invokes or embeds transcription code.
- [ ] Bound frame bytes, dimensions, parser resources, and derived-object
      retention.
- [ ] Pass sampled frames through the existing native image projection and
      technical metadata through provenance-marked text.

Exit gate: video reaches both harnesses as metadata plus sampled frames; audio
reaches both as technical metadata; cancellation and restore reuse exact
accepted preparation receipts.

### P37-5 — Governed public-link reading

- [ ] Add `read_message_link` to the immutable harness tool catalog.
- [ ] Add the trusted SSRF-resistant HTTP(S) reader and redirect validation.
- [ ] Add bounded static HTML and text extraction.
- [ ] Bind reads to session policy, request authority, tool budget, and
      cumulative information flow.
- [ ] Redact complete URLs from operational evidence and expose explicit
      unavailable/binary outcomes to the model.

Exit gate: both harnesses can read an admitted public link through one governed
tool, and the capability stays absent when any egress safety gate is unmet.

### P37-6 — End-to-end closure

- [ ] Stabilize the local Miniflare/workerd Slack Actor journey so it executes
      reliably.
- [ ] Add one parameterized signed-webhook-to-Slack-receipt matrix covering
      text-only, file-only, link-only, mixed content, image, PDF/DOCX, video,
      audio, CAD/3D, and unknown files.
- [ ] Cover transient retry, retry exhaustion, permanent rejection, partial-
      batch prevention, duplicate delivery, restore, cancellation, staged
      expiry, reachability cleanup, and information-flow denial.
- [ ] Run one Slack sandbox canary with small synthetic text, PDF, image, video,
      audio, and opaque CAD/3D fixtures.
- [ ] Record production acceptance with non-sensitive disposable fixtures and
      measured Worker, R2, executor, model, and Slack receipts.

Exit gate: each supported behavior has one literal Actor journey and one
addressed Slack receipt. No modality relies solely on a parser or unit test.

## Verification

Run the narrowest phase suite first, followed by applicable repository gates:

```bash
cargo test -p satyr-contracts
pnpm --filter @satyr/contracts build
pnpm --filter satyr-edge check:types
pnpm --filter satyr-edge check:test-types
pnpm --filter satyr-edge test
pnpm --filter satyr-edge test:onboarding-closure
pnpm --filter satyr-edge test:commerce-lab
cargo test -p workspace-executor
pnpm portal:build
git diff --check
```

The focused suite must prove:

- rich-text/text fallback precedence and deterministic message order;
- message non-emptiness and file-only derived views;
- source-revision deduplication and batch-atomic agent admission;
- media evidence, declared/verified distinction, and opaque fallback;
- count, byte, redirect, signature, hash, organisation-isolation, and cleanup limits;
- Connector rejection delivery and exact receipts;
- Connector/Case/Session persistence, migration, restore, replay, export, and
  erasure;
- document/media executor isolation and owned cancellation;
- Codex/Pi canonical projection parity;
- public-link SSRF, redirect, DNS, decompression, deadline, and URL-redaction
  controls; and
- type-level rejection of invalid message, media, lifecycle, and preparation
  combinations.

## Completion criteria

Plan 37 is complete when:

1. addressed Slack text, file-only, link-only, and mixed messages enter one
   provider-neutral, ordered, non-empty message contract;
2. rich text, fallback text, links, hosted files, remote-file links, edits, and
   file notifications have one explicit canonical disposition;
3. images, documents, video, audio, CAD/3D, archives, and unknown files are
   securely admitted without an image-only gate;
4. media identity distinguishes verified evidence, provider declarations, and
   unknown content;
5. common documents reach both harnesses as bounded, provenanced text or an
   explicit limitation;
6. video reaches both harnesses as bounded metadata and sampled visual frames;
7. audio reaches both harnesses as bounded technical metadata with no
   transcription or semantic speech claim;
8. specialist and unknown formats remain exact inert objects with a bounded
   model-visible manifest and can gain handlers without changing message
   ingress;
9. links are typed, preserved, and readable only through the governed public
   link tool;
10. Connector, Case, Session, history, restoration, export, erasure, and both
    harness projections preserve every message part or return an explicit
    typed failure;
11. rejected, oversized, or exhausted batches produce one addressed notice and
    never run an agent over partial input;
12. source and derived objects have explicit owners, retention, reachability,
    and deletion receipts;
13. the old image-only union, parallel attachment sidecars, and persistence
    migration readers are deleted after the zero-old-schema gate; and
14. local and production evidence demonstrate the complete Actor journey for
    each supported behavior.

## Explicit exclusions

- speech-to-text, speaker identification, diarization, and audio transcription;
- automatic transcription of video audio tracks;
- Deepgram, VoxTerm, or any other transcription provider;
- semantic understanding of opaque CAD, 3D, archive, executable, or unknown
  formats without an explicit future handler;
- automatic archive extraction or execution of attached programs;
- automatic persistence of message attachments as Dropbox/Drive-style
  organizational context;
- automatic public-link fetching during ingress;
- authenticated website browsing with user cookies or provider credentials;
- edit-driven re-execution or mutation of accepted history;
- outbound Slack file generation or upload;
- MPIM support without an explicit scope and acceptance decision; and
- WhatsApp media ingestion. Plan 32 keeps WhatsApp media deferred until a
  separate provider-boundary delivery adopts the canonical Plan 37 contract.

## Retained acceptance notes

Consolidated on 2026-10-06 from the September handoff. This edit performs no new
production verification. The remaining non-deferred gate is the scheduled
attachment-collection audit receipt after the recorded quarantined-Case cleanup.
Its 2026-09-08 due time is historical; elapsed time does not prove collection.

Preserve these implementation boundaries:

- `bounded_text` is authored search text. `model_text` contains the canonical
  message, including attachments needed on later turns.
- The credential-free fetch container validates and pins the selected address
  while preserving Host/SNI and TLS verification. Redirects return to the Worker.
  It has no workspace mounts or provider secrets. Compressed bodies are refused.
- Media inspection verifies the complete object's digest. Oversized content is
  described through its limitation branch rather than trusted from a ranged read.
- Slack `message_changed` does not admit a new turn without defined revision semantics.
- Historical preparation records normalize only at the persistence boundary.
- The attachment restore journey remains isolated from the ordinary journey fixture
  because eviction changes activation state.

The scoped production evidence proves heavy-preparation interruption, executor
destruction, settled budgets, saved-result reuse, same-session continuation, and
sanitized denial receipts. These results do not certify every media format or a
later deployment. The owning phase table retains broader deferred scope.

### Historical Slack evidence

These links preserve the original handoff's provider evidence. Access remains
subject to the Slack workspace's permissions.

- [text
  probe](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788685602021859)
- [p1788687051051599](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788687051051599)
- [reply p1788687062585009](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788687062585009?thread_ts=1788687051.051599&cid=C0BP9ASA6UR)
- [p1788687172939409](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788687172939409)
- [reply p1788687183883789](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788687183883789?thread_ts=1788687172.939409&cid=C0BP9ASA6UR)
- [p1788687308483839](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788687308483839)
- [reply p1788687322880239](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788687322880239?thread_ts=1788687308.483839&cid=C0BP9ASA6UR)
- [p1788687456013839](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788687456013839)
- [reply p1788687470340649](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788687470340649?thread_ts=1788687456.013839&cid=C0BP9ASA6UR)
- [p1788753891063059](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788753891063059)
- [p1788754348521119](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788754348521119)
- [p1788754387015059](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788754387015059)
- [p1788765392824949](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788765392824949)
- [p1788765498921739](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788765498921739)
- [p1788765611837049](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788765611837049)
- [fresh link canary](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788766666346429)
- [fresh video canary](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788766751597609)
- [diagnostic video canary](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788767564572479)
- [post-reopening video canary](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788768352638809)
- [final visual canary](https://cafeos.slack.com/archives/C0BP9ASA6UR/p1788769078536439)
