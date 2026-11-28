# FND-05 — Messages, attachments and context

A message of a person reaches a Sous Chef agent of Purin Pantry as one ordered, typed
`UserMessage`: text parts, link parts and stored files. Slack and the Portal chat make
the same contract. Pantry stores each file in R2 under its SHA-256, identifies it from
its bytes and prepares it before the model starts. Pantry never fetches a link at
ingress. Two agent tools read a file or a link of the message of the current turn, and
of no other message. Each turn also gets a bounded context bundle. The agent loads more
context when the task needs it. It reads saved Kitchen data with no navigation. It
opens the Kitchen page in the person's browser only when a command needs that page.

## What it does

### The typed message

- A `UserMessage` has a first part and a list of remaining parts, so it is never empty.
  A part is `text`, `link` or `attachment`. A message with only files or only links is
  valid. A link has an HTTP or HTTPS URL and a presentation: `url`, or `label` and text.
- An attachment (`StoredMessageAttachment`) has an id (`att_…`), a display name, an
  extension hint, a descriptor, a byte length and a SHA-256. It also has an R2 object
  key, a source (`slack` or `portal`), the retention class `session` and a stored time.
- The descriptor gives one of five media classes: `image`, `document`, `audio`, `video`
  or `opaque`. Its evidence says how Pantry knows the media type. It is
  `signature_verified` (`magic_bytes` or `container_structure`), `provider_declared`
  (`slack` or `portal`), or `unknown` for an opaque file with no usable claim.
- `buildStoredMessageAttachment` classifies a file from its first 64 bytes. A signature
  wins over the declared type. A ZIP signature with a declared DOCX or ODT type gives a
  `provider_declared` document. With no signature, the declared type decides. With no
  type, the file is opaque `application/octet-stream`.
- `image/*` is an image. `text/*`, PDF, JSON, XML, DOCX and ODT are documents. `audio/*`
  is audio and `video/*` is video. Each other type is opaque: archives, CAD files, 3D
  models, spreadsheets and unknown formats. An opaque file keeps its declared type as a
  hint.
- A file name is display data. It is never a path, an object key or an authority.

`userMessageViews` derives four views from one message, so the views cannot disagree:

| View            | Content                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `modelPrompt`   | One line for each part: the text, `[link] …`, or the manifest line of a file, with no claim about a read of its content       |
| `casePurpose`   | The first text or link label. With files only: `Review attached file: <names>`. With links only: `Review link: <url>`         |
| `contextQuery`  | The texts, the link labels and the file names, or null when there are none                                                    |
| `contentDigest` | SHA-256 of the ordered parts: each text, each link and label, and for each file its id, digest, media type, length and source |

A Case entry holds the message as `user_message` content. A `record_message` is the same
message with a commerce source provenance.

### Slack messages

- `slack/events.ts` is the only parser of a Slack event. It admits the events
  `app_mention` and `message`, with no subtype or with the subtype `file_share`.
- It ignores each other subtype, a message of a bot or an app, and the top-level
  `file_shared` event. It also ignores a message with no text, link or file.
  `message_changed` gives the trigger `edit`. An edit starts no Case and no agent turn.
- The parser selects one authored form. If each block is a supported `rich_text` block,
  it reads the blocks in order. If not, it reads the top-level `text`. It never joins
  the two. With blocks that it cannot read and no text, the message is ignored
  (`unsupported_message_content`).
- It never reads the legacy `attachments` field, so a link preview of Slack is no part.
- A file of the message is `hosted`, `needs_info` or `remote_link`. A file that Slack
  does not host becomes a link part with the file name as its label. A Slack Connect
  placeholder (`file_access: "check_file_info"`) and a file with incomplete metadata are
  `needs_info`. The adapter reads the exact message again to complete them.
- `buildSlackUserMessage` gives the order of the parts. The authored text and links come
  first, then the links of remote files, then the stored files in `files[]` order.
- A Portal chat message (`chatUserMessage`) is the person's text, then a link part for
  each distinct http(s) URL in that text, at most 10, then the files. A URL that the
  message contract refuses stays text only. The link read then reads these links as it
  reads the links of a Slack message.
- A reply with a file does not steer a running turn. It waits for the next turn
  (FND-03).

### Files from Slack

`acquireSlackAttachmentBatch` (`slack/attachments.ts`) turns the hosted files of one
message into stored attachments. The agent gets each hosted file that the adapter
resolved, or none.

If one file of the event is `needs_info`, the adapter reads the exact message again
with one `conversations.replies` call. The files of that read replace the whole file
list. This second parser keeps each file that has an id, a name, a type and a size above 0. It leaves out each other file, with no rejection and no notice, and it does not apply
the `remote_link` rule. If the read does not return the message, the message has no
stored file.

1. It checks the declared sizes against the policy before a transfer.
2. For each file, it looks for the pointer of the same Slack file revision. If the
   pointer and its content object exist, it classifies the first 64 bytes of the stored
   object again and downloads nothing.
3. If not, it reads `files.info`, downloads the file and compares the byte count with
   `files.info`. The bearer token goes only to `slack.com` and `files.slack.com`. Each
   redirect must stay on `files.slack.com`.
4. It computes the SHA-256 and writes two objects: the content object and the pointer.
5. A failed call of Slack (`conversations.replies` or `files.info`), a download status
   that is not OK, a failed read of the body and a failure of R2 are
   `retryable_failure`. The Connector then tries the same batch again.
6. A file that breaks a rule is `rejected`: `file_count_exceeded`, `file_too_large`,
   `batch_too_large`, `declared_size_invalid`, `byte_length_mismatch`,
   `contract_rejected` or `download_rejected`. A download request that throws is also
   `download_rejected`: a network error, the 15 s deadline before the response starts, a
   fourth redirect or a redirect to another host. The thread gets one fixed notice with
   the rule, its limit and the file name (`tellAttachmentsRefused`). The Connector then
   settles the work as rejected with the rule and the observed value, and no agent turn
   starts.

The adapter downloads the files in groups. A group closes before the file that takes
its declared bytes above 16 MiB, so a larger file is a group of its own, of at most
25 MiB. A group stays in the memory of the Worker until it is stored.

A Slack file has the id `att_` and the first 32 hex digits of its SHA-256, so the same
bytes have the same id in each message. The key of its pointer is a digest of the
Organisation, the workspace, the file id and the revision: the `timestamp` of the file,
or the time of the message.

### Files from the Portal chat

The Portal sends a chat message with files as a multipart form: one `command` field and
`files` fields. The same policy applies, and an empty file is refused. The body stops at
50 MiB and 64 KiB. A Portal message needs text, of at most 8,000 characters. The
commands `retry`, `withdraw` and `steer_queued` refuse files.

`retainChatFiles` (`chat/attachments.ts`) stores the bytes and a pointer that holds the
attachment record. A Portal file has the id `att_` and 32 hex digits of a digest of the
Organisation, the person, the conversation, the file name, the declared type and the
content digest. The message of a Portal turn is one text part and then its files. FND-03
owns the chat commands, the conversation record and the files of a fork.

### Preparation before the model starts

The Session Actor prepares each file of the accepted message before it starts the model
(`actors/session/attachments.ts`). It also prepares each file of the earlier user inputs
in the inherited history of a fork, under the lease of the new turn. Each read first
proves the Organisation prefix of the key, the object length and the SHA-256.

| Class                                                             | Preparation                                                                 | What the model gets                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Image with a verified signature                                   | The verified bytes                                                          | A native image input                                                                                             |
| Document: plain text, Markdown, CSV, TSV, JSON, XML               | UTF-8 text in the Worker, at most 1 MiB. A larger file goes to the executor | The manifest line and at most 32,768 characters, with `[truncated]` when cut                                     |
| Document: PDF, DOCX, ODT                                          | Extraction in the Worker, at most 1 MiB                                     | The same, or the manifest with "contents not read" and `preparation=handler_not_available` or `source_too_large` |
| Audio                                                             | Container facts from the first 64 KiB                                       | The manifest and one line: container, duration, codec, channels, sample rate, "contents not interpreted"         |
| Video                                                             | The same facts and at most 12 still frames                                  | The manifest, the facts and the frames as native image inputs                                                    |
| Opaque, an image with only a declared type, another document type | No interpretation of the bytes                                              | The manifest with "contents not read" and `preparation=handler_not_available`                                    |

- The Worker takes the frames of an intra-frame video from the bytes of the file. For
  H.264, the `WorkspaceExecutorContainer` decodes the selected keyframes to JPEG. Each
  other codec gives `frames=decoder_required` in the facts and no frame, with no
  executor call.
- The executor has no network and gets the bytes of one file. It reads only plain text
  and H.264. The Session reserves an allocation with the parent `attachment_preparation`
  from the run budget of the turn, and claims `message.attachment.inspect` for it.
- The decoded frames go to R2 beside the source, with a manifest
  (`messages/derived-stills.ts`). A later preparation of the same bytes reads them and
  takes no allocation.
- `session_message_preparation` holds one record for each turn and file: `pending`, then
  `completed` with a receipt. The Session writes the result to R2 before it accepts the
  receipt. After a restart, it accepts the saved result. With no saved result, a new
  lease can prepare again before the first deadline, with no call of the executor.
- A stop of the turn cancels the preparation and destroys its executor. Files that can
  call the executor are prepared one at a time. The others are prepared in groups with
  the 16 MiB rule of the Slack download: a larger file is a group of its own.
- If one preparation fails, the turn does not start. The error is
  `embedded_harness_attachment_preparation_failed` with a reason: a missing object or a
  wrong object size (`attachment_unavailable`), a wrong digest
  (`attachment_integrity_failed`), no active budget reservation
  (`preparation_budget_unavailable`), `preparation_deadline_exceeded`, more than 12
  images (`too_many_prepared_images`), a result above 36 MiB (`output_too_large`) or
  the same lease after an interruption (`preparation_interrupted`).

### The message tools

| Tool                         | Capability                   | What it does                                                                                                                                                                                 |
| ---------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_message_attachment` | `message.attachment.inspect` | Gives the prepared result of one file of the current message again: text, facts or the manifest. An image is named, with no data. An id of another message gives `attachment_not_in_message` |
| `read_message_link`          | `message.link.read`          | Reads one link of the current message. A URL that the message does not hold gives `link_not_in_message`                                                                                      |

The link reader (`messages/link-reader.ts`) works as follows:

- It accepts HTTP and HTTPS on ports 80 and 443, with no user information in the URL.
- It resolves the host name through DNS over HTTPS and checks each address. One address
  that is not public refuses the read: a private, loopback, link-local (with the cloud
  metadata address), carrier NAT or reserved address. It also refuses the names
  `localhost`, `*.localhost`, `*.internal` and `*.local`. Each lookup has at most 5 s
  inside the 10 s limit of the read.
- The `MessageLinkFetchContainer` connects to the checked address and keeps the host
  name for HTTP and TLS. It holds no credential and sends no cookie. It refuses a body
  with a content encoding. A redirect goes back to the Worker for the same checks.
- One container serves all Organisations of a location hint and runs at most 4 fetches
  at the same time. It uses HTTP/1.1 with no proxy and no retry, and it stops after 30 s
  without work.
- A text response becomes plain text: HTML loses its markup and keeps the targets of its
  links. Each other media type gives `binary` with no content. A binary response never
  becomes an attachment.
- The receipt holds the two origins, a digest of the path, the count of redirects and
  the media type. It also holds the byte count and the digest of the content. It never
  holds the full URL.

### Storage and collection

| Object                            | R2 key in `ARCHIVE`                                                              |
| --------------------------------- | -------------------------------------------------------------------------------- |
| Slack file content                | `attachments/<organisationId>/slack/<sha256>`                                    |
| Pointer of a Slack file revision  | `attachments/<organisationId>/slackref/<digest>`                                 |
| Portal file content               | `attachments/<organisationId>/portal/<sha256>`                                   |
| Pointer of a Portal upload        | `attachments/<organisationId>/portalref/<attachmentId>`                          |
| Decoded frames and their manifest | `attachments/<organisationId>/derived/<sha256>/<policy>/`                        |
| Preparation result                | `attachments/<organisationId>/derived/<sha256>/preparation/<preparationId>.json` |
| Collection record                 | `attachment-collection/<organisationId>/<collectedAt>.json` and `…/latest.json`  |

- A content object is reachable when a Case trigger, a Session turn, a Portal
  conversation or a retained fork names its key. A derived object is reachable when a
  reachable source has its digest. A Slack pointer is reachable when its content is.
- `runAttachmentCollection` runs on the `*/15 * * * *` cron. One run takes at most four
  active Organisations whose last record is older than one day. For each, one list of
  the prefix comes first (`hasAttachmentsPastGrace`). If it finds no object older than
  one day and no second page, the outcome is `nothing_old`, and no Actor is asked.
  Otherwise the run asks each Case and Session Actor for its keys
  (`listReachableAttachmentObjectKeys`) and reads the Portal conversations and the
  forks. It lists the whole prefix, keeps each reachable object and each object younger
  than one day, and deletes the others.
- It deletes nothing without a complete inventory. A `retired` Actor is left out of the
  inventory and causes no skip. The run skips the Organisation when another Case or
  Session Actor is not `active` (`actor_not_active`) or does not answer
  (`actor_unreachable`). It also skips when the placement of the Organisation is not
  the active one (`organisation_placement_conflict`), when the registry or the fork
  history cannot be read, when the list of R2 does not advance, or when the collection
  fails (`attachment_collection_failed`).
- The record gives one outcome: `collected`, `nothing_old`, `skipped` with its reason,
  or `uncertain`.
  The outcome is `uncertain` when an R2 delete call fails. The record then lists the
  deleted, the uncertain and the not attempted keys.
- The collection and its record are the daily pass of the Organisation
  (`runOrganisationDailyPass`). After the record, while the placement of the
  Organisation is active, the pass runs the other daily steps of the Worker
  (`ORGANISATION_DAILY_STEPS`): the retention of the page effects and of the relevance
  records (FND-09). A step that fails does not stop the others. No other cron wakes an
  idle Organisation each day.
- The erasure of an Organisation deletes each R2 prefix of `PURGE_R2_PREFIXES`
  (`data/purge-catalogue.ts`). Two of them are `attachments/<organisationId>/` and
  `attachment-collection/<organisationId>/`.

### The context of a turn

- `prepareTurnContext` (`context/turn-context.ts`) compiles the authority of the turn
  and needs the capability `context.case.read`. The assembler gets only this permit.
- A step of the requester's own private Portal chat needs no grant of
  `context.case.read` (`ownChatCase`, `isOwnPrivateChatTurn`): the person started the
  turn, and the chat was private to that person at the turn and is private now. Such a
  permit reads the tail of its own Case only (scope `case`): no Memory and no workspace
  search. The Session's check before inference and the read of the chat's own history
  (`authorizeForkHistoryAccess`, `own_private_chat`) take the same rule. The history
  read asks one more thing: each source that the chat's Sessions observed is the chat's
  own Case, the chat itself or the chat's Project (`readsOnlyOwnCase`,
  `readSessionObservedSources`); the Project's flow label names its readers, and the
  flow check reads it again. A chat that read Memory, a saved record, a connected
  resource, another Case or another chat while the person held the grant needs the
  grant to show that history again. An inherited
  history of a fork still needs the grant. An owner and an admin hold the grant, so the
  rule matters for an operator's Register chat (Plan 90 D9).
- The assembler reads the tail of the Case, the searchable projections (Case entries and
  file segments) and the accepted Memory. It admits a candidate only when its
  visibility and its flow label let this turn read it.
- Each Case entry names its replay authority. A message of a person is
  `partition_independent`. An answer of the agent, the note of a dropped output and the
  note of a refused effect name the authority partition of their turn
  (`authority_partition`). The tail and the projection search give a turn the
  independent entries and the entries of its own partition.
- The tail also gives an entry of another partition when the same conversation
  requester wrote it (`isSameConversationRequester` in `turn-authority.ts`): the same
  Slack conversation and the same role, and in a DM the same person, at another
  membership revision. A change of the configuration (FND-04), the policy or the grants
  of the Organisation moves an open Slack thread to a new partition and a new Session
  (FND-03). The thread then keeps the earlier answers of the agent. Such an entry keeps
  its flow label, and the assembler admits it against the authority of the new turn, as
  it does for each entry (FND-07).
- A requester with another role is another requester, so that Session does not read
  the answers of the first one. A Portal chat, a mailbox, a WhatsApp line and a workflow
  have no requester rule: an entry replays into its own partition only.
- If the tail of the Case cannot be read, the assembly fails (`tail_unavailable`).
  Memory that fails verification also fails it (`memory_state_invalid`). A projection
  search that fails is ignored.
- The candidates rank by exact phrase, then by token overlap, then by recency. The
  assembler selects at most 12 items and 2,048 estimated tokens. A projection that comes
  after 250 ms is left out, but the tail of the Case always counts. It drops a second
  Case entry with the same text. Each item is `fresh` or `stale` against a bound of
  24 hours.
- The bundle says if it is `complete` or `truncated` by `items`, `tokens` or `time`, and
  what became of Memory: `none`, `admitted`, `limited` or `unavailable`.
- The Session stores the bundle and its digest in `session_turn_context`. The accepted
  input names the same digest, and the Session checks it before the turn starts.
- `renderModelContext` writes the accepted Memory first, then the selected excerpts,
  then the request. The request always stays. Memory and excerpts stay only while the
  prompt fits its byte budget. If Memory was withheld, one notice says so.
- The bundle can also hold Project context items (`project_observation`) and native
  chat input. The same renderer writes the Project items into a separate
  `project_context` input, apart from the text of the request. Native chat input is
  left out of the model context.
- A projection keeps two texts for a message. `bounded_text` is for search and holds the
  authored text only. `model_text` also holds the links and the manifest of each file.

### Context on demand

The agent loads more context with its tools, when the task needs it.

- **Saved data without navigation.** `bakery_saved_run_read` reads a saved Kitchen run
  from R2: `id="latest"`, one exact id, or a list of at most eight runs. It opens no
  page and starts no physics. Commerce and file reads use their own tools.
- **Observations.** A read records an observation with its source, its revision, its
  digest and its time in the information-flow record of the Session. The chat shows the
  newest 12 as `observed` context events. The area of a saved Kitchen run is Kitchen, of
  a commerce record Commerce, and of a connected file or another resource Workspace.
- **The Kitchen page.** A Portal turn of an owner or an admin offers the Kitchen page
  commands before the page is open. The first command sends a `prepare_context` effect
  to the browser tab that sent the message. The Portal shows the Kitchen view, captures
  its real state and returns a `prepared` receipt. The command then runs against that
  state, in the same request and with no second message from the person.
- **What stays.** The Portal hides the page that the person leaves and keeps its
  component, so unsaved work stays. The reveal changes no route and swaps only the page
  region. The chat is a separate part of the layout. A **Return to current page** button
  goes back. If the page has an open dialog, or the chat is closed, the Portal refuses
  and the agent gets the reason.
- **One tab.** A tab has a browser id in `sessionStorage`, and a Web Lock gives a copy
  of the tab a new id. The effect names the browser id and the conversation. The list
  route gives the effect only to that browser id and conversation, and a `prepared`
  receipt must carry the same binding.
- **No browser.** A message that the person sent with the screen chip off on the Kitchen
  page is `excluded`. The saved read and the page commands then tell the agent to ask
  the person. A Slack turn is offered no page command. A Portal request with no eligible
  browser gets a refusal that says so. An effect that no browser answers ends at its
  deadline.
- **Readiness.** A command uses a captured state for at most 20 s. After that time, a
  failure or a new request, the next command prepares again. The description of each
  page tool tells the agent to call it directly, outside Code Mode. The continuation of
  a running turn keeps its browser context. When the Session recovers the turn, it
  restores this context and moves each waiting page effect to the new lease (FND-04).
- **The context chip.** The chat timeline gets a `context` event for each step:
  `preparing`, `ready`, `failed`, `cancelled`, or `observed` for a confirmed read. The
  chip in the chat header shows "Workspace", "Loading Kitchen…", "Kitchen", "Kitchen
  stale", "Kitchen unavailable", "Kitchen cancelled", "Kitchen excluded" or the area of
  the last read. Its popup lists the newest eight sources of the request.

## Contracts

- **Packages.** `packages/contracts/src/message.ts` (`UserMessage`, the parsers, the
  classification and the views), `attachment-preparation.ts` (the preparation state and
  receipt) and `media-inspect.ts` (media facts and frame outcomes) are TypeBox schemas
  with parsers (FND-11). `page-browser-context.ts` holds `PageBrowserContext`
  (`unavailable`, `excluded`, `available`) as a TypeScript union with a hand-written
  parser. `packages/control-api/src/message-attachments.ts` holds
  `MESSAGE_ATTACHMENT_POLICY`, and `chat.ts` holds `ChatContextDetails`.
- **Rust.** `crates/media-inspect` (media facts and frame selection, also built to Wasm
  for the Worker), `crates/workspace-executor` (the `prepare_message_attachment`
  operation) and `crates/message-link-fetch` (the pinned fetch).
- **Platform files** in `workers/platform/src/`: `slack/events.ts`,
  `slack/user-message.ts`, `slack/attachments.ts`, `chat/attachments.ts`, `messages/`
  (inspection, text of PDF and office files, frames, link reader, collection),
  `actors/message-preparation.ts`, `actors/message-attachment-preparation.ts`,
  `actors/session/attachments.ts`, `actors/message-tools.ts` and `context/`.
- **Session Actor SQLite.** `session_turn_attachment` (the files and the links of each
  turn), `session_message_preparation` (the key is the turn and the file),
  `session_turn_context` (the bundle and its digest). The Case Actor keeps the message
  in `case_trigger`. `session_turn_continuation` keeps the browser context of the
  running turn (FND-04).
- **Regional D1.** `context_projection` and `context_projection_fts` (source kinds
  `case_entry` and `file_segment`), `portal_conversation` (the file parts of a Portal
  message) and `bakery_surface_effect_delivery` (the page effects, KIT-01).
- **Global D1.** The Slack rows of `provider_manifest` (version 3) require `files:read`.
- **Containers.** `MessageLinkFetchContainer` (binding `MESSAGE_LINK_FETCH`, one object
  for each location hint, named `public-links:<hint>`) and `WorkspaceExecutorContainer`
  (FND-02).
- **Routes.** `POST /v1/control/organisations/:id/chat` takes the multipart message. It
  needs the admin role, or the operator role with the `canvas` query parameter. An
  operator may also send a message of a private chat that carries Café › Register
  (`operatorChatPage`, Plan 90 D9); the turn runs while that holds for the latest
  message (`authorizeConversationExecution`). `GET …/chat` needs the admin role, except
  that an operator reads one private chat of their own whose latest message carries
  Café › Register, with `view=state` or the whole chat (`operatorMayReadChat`). That
  read holds this chat and no list of chats or Projects. Another person's chat, a
  shared chat and the list stay refused (`organisation_role_insufficient`).
  `GET /v1/control/organisations/:id/chat/surface-effects` lists the pending effects of
  one browser id and conversation, and `POST …/chat/surface-effects/:effectId/receipt`
  returns a receipt. These two routes need the operator role. The receipt route checks
  the person and the effect id.
- **Capabilities** (`authorization/capability-catalogue.ts`):
  `message.attachment.inspect`, `message.link.read`, `context.case.read` and
  `workspace.query`. The first three are on in the baseline policy. A Slack channel
  holds a baseline grant of the first three, and the owner and admin roles hold one of
  `message.link.read`, so a Portal chat reads a pasted link.
- **Agent tools.** The two message tools are in `agent-tools/messages/messages.ts`, and
  `bakery_saved_run_read` is in `agent-tools/kitchen/saved-runs.ts`.
- **Versions.** `plan37.m1.v1` (file policy), `plan37.link.v1` (link policy),
  `plan37.frames.v1` (frame policy), `message-preparation.v1` (handler),
  `plan37.attachment-collection.v1` (receipt), `context_assembly_v1` (assembler).

## Rules and limits

| Action                               | Who                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Send files in Slack                  | A person whose message the Connector admits (FND-03)                                            |
| Send files in the Portal chat        | An owner or an admin. An operator, in a canvas chat only. A viewer of a shared chat cannot send |
| Read a file or a link of the message | An agent turn with the capability. The baseline grant of a Slack channel gives both             |
| Read a saved Kitchen run             | An agent turn with `workspace.query`, while the authority of the request is live                |
| Run a Kitchen page command           | A Portal turn of an owner or an admin                                                           |
| Answer a page effect                 | The same person. Only the browser tab that sent the message gets the effect from the list route |

| Limit                                                      | Value                                                                         | Constant                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Files, file size, message size                             | 10, 25 MiB, 50 MiB                                                            | `MESSAGE_ATTACHMENT_POLICY`                                                                                           |
| Slack download: redirects, time                            | 3, 15 s                                                                       | `MESSAGE_ATTACHMENT_POLICY`                                                                                           |
| Tries of one Slack message                                 | 5                                                                             | `CASE_WORK_MAX_ATTEMPTS`                                                                                              |
| Text, URL, file name of a message                          | 65,536 characters, 2,048 bytes, 255 characters                                | `NON_EMPTY_TEXT_MAX_CHARS`, `HTTP_URL_MAX_BYTES`, `DISPLAY_FILENAME_MAX_CHARS`                                        |
| Text of a Portal message, multipart body                   | 8,000 characters, 50 MiB and 64 KiB                                           | Literals in `parseChatCommand` and `ChatUploadBodyLimit`                                                              |
| Case purpose, context query                                | 160, 512 characters                                                           | `CASE_PURPOSE_MAX_CHARS`, `CONTEXT_QUERY_MAX_CHARS`                                                                   |
| Text of a document                                         | 1 MiB source, 32,768 characters                                               | `ATTACHMENT_TEXT_LIMITS`                                                                                              |
| PDF, DOCX and ODT                                          | 1 MiB source, 4 MiB decoded                                                   | `PDF_EXTRACTION_LIMITS`, `OFFICE_EXTRACTION_LIMITS`                                                                   |
| Media source, frames                                       | 25 MiB, 12                                                                    | `MAX_MEDIA_SOURCE_BYTES`, `MAX_SAMPLED_FRAMES`                                                                        |
| Decoded frame: picture, all frames                         | 1920 × 1080, 640 KiB                                                          | `MAX_DECODE_PIXELS`, `MAX_FRAME_RESPONSE_BYTES`                                                                       |
| One preparation: input, result, time                       | 25 MiB, 36 MiB, 30 s                                                          | `MESSAGE_PREPARATION_LIMITS`                                                                                          |
| Link read: transfer, text, time, redirects                 | 5 MiB, 32,768 characters, 10 s, 3                                             | `MESSAGE_LINK_POLICY`                                                                                                 |
| Link read: DNS lookup, fetches of one container, idle stop | 5 s, 4, 30 s                                                                  | `DOH_TIMEOUT_MS`, `MAX_CONCURRENT_FETCHES`, `sleepAfter`                                                              |
| Text of connector documentation (INT-01)                   | 65,536 characters                                                             | Literal in `readConnectorDocumentation`                                                                               |
| Collection: interval, grace, Organisations in one run      | 24 h, 24 h, 4                                                                 | `ATTACHMENT_COLLECTION_INTERVAL_MS`, `ATTACHMENT_COLLECTION_GRACE_MS`, `ATTACHMENT_COLLECTION_ORGANISATIONS_PER_PASS` |
| Context bundle: items, tokens, time, freshness             | 12, 2,048, 250 ms, 24 h                                                       | Literals in `buildContextReadFields`                                                                                  |
| Memory read: a person waits, no person waits               | 250 ms, 5 s                                                                   | `INTERACTIVE_MEMORY_DEADLINE_MS`, `BACKGROUND_MEMORY_DEADLINE_MS`                                                     |
| Use of a captured state                                    | 20 s                                                                          | `SURFACE_EFFECT_TTL_MS`                                                                                               |
| Deadline of a page effect                                  | 20 s, or 150 s for `simulate_workcell`. Never after the end of the turn lease | `SURFACE_EFFECT_TTL_MS`, `SURFACE_SIMULATION_TTL_MS`                                                                  |

- **Retention.** A stored file has the class `session`. It stays while a retained
  record names it and goes at the next collection after that. No code deletes a
  collection record. Each daily collection writes two R2 objects, the record and
  `latest.json`, which pace the next pass. An Organisation with no file older than one
  day costs one R2 list and these two writes a day and wakes no Actor. Otherwise one
  collection calls each of its Case and Session Actors that is not retired.
- **Untrusted content.** The text of a file, a frame, the facts of a media file and the
  text of a link are message input. They give no tool, no capability and no authority.
  Pantry never runs a file. It reads one entry of a DOCX or ODT file and expands no
  other archive.
- **Information flow.** A tool read of a file records an observation under the `ingress`
  label of the conversation that carried it. The Session admits the observation into
  its information-flow record, and FND-07 owns the exit check that reads this record.
  `message.link.read` is an inside capability that
  passes after outside-written text, because it fetches only a link that the message of
  the person holds. A link read records the page text under the message's `ingress`
  label with the writer `outside` (FND-07). A saved Kitchen read enters under the
  `saved_bakery_run` label.
- **No full URL in a record.** A link receipt holds no path and no query. The exact URL
  stays in the message. A collection record holds object keys and no message text.
- **Scope of the browser.** The saved read takes the Organisation from the admitted
  execution of the Session, and its tool input holds only `id` and `cursor`. A page
  effect takes the Organisation from the turn, the person from the request authority of
  the lease and the browser from the browser context of the message.
  `PageBrowserContext` names no page and no product area.
- **Out of scope:** speech to text and each transcription service; a read of the audio
  track of a video; an interpretation of opaque formats; the run of an attached
  program; a message file that becomes shared file context; a fetch of a link at
  ingress; a read of a site with the cookies of a person; a turn from an edited message;
  a file that Pantry posts to Slack; group direct messages (the Slack app has no
  `mpim:history`).
- **Boundaries.** FND-02 owns the executor container, its allocation and the Actor
  registry. FND-03 owns the route of a message to its Case, the Portal conversation, its
  forks and the retries of the Connector. FND-04 owns the harness, the turn lease, the
  native model input and the continuation of a turn. FND-06 owns the capability policy
  and FND-07 the labels and the exit check. FND-09 owns the tool catalogue, the screen
  chip and the page effect protocol. KIT-01 owns the Kitchen page and its saved runs.
  BRN-01 owns Memory. INT-01 owns connected files, and its read of connector
  documentation also uses the link reader. INB-01 owns the files of email and WhatsApp,
  which do not use this contract.

## Open work

- The Worker holds a whole file in memory to compute its digest. Plan 37 makes a larger
  file limit wait for a streamed write and measured evidence. The code has no staged
  object and no expiry of one.
- The executor has no handler for PDF, DOCX or ODT, so these files are read only up to
  1 MiB. A larger one gets `source_too_large` with no executor call. A PDF of scanned
  pages gives no text. DOC, spreadsheets and slides are opaque.
- Video frames come only from intra-frame video and H.264. VP9 and AV1 have no decoder.
  Audio gives technical facts only.
- A person cannot download a stored file. A file part of the Portal chat holds the id,
  the name, the media type and the preparation state of the file, and no link to its
  bytes. The preparation, the reuse check of a Slack file and the check of a fork are
  the code that reads the bytes of a content object.
- The text of a file does not set the writer `outside` of Plan 89 (FND-07).
- In one Slack thread, the Session of a requester with another role does not read the
  answers that the agent gave to the first requester, and a person whose role changed
  loses the earlier answers. The people of the thread read those answers in Slack.
- The projection search has no requester rule. An answer of an earlier partition
  reaches the new Session only while it is one of the 12 newest entries of the tail.
- Only the Kitchen page has a `prepare_context` effect. The `preparing` and `ready`
  events have the area `kitchen` only.
- The `latest` read lists each saved run of the Organisation to find the newest. Plan
  42G names the token volume of a turn, repeated preparation and large Portal chunks as
  open measurements.
- Plan 42G leaves these to other work: physical execution and calibration, and a
  recording as a chat attachment. It also leaves out one view of two cells, a new
  scheduler and a provider fallback.

## Sources

- [Plan 37](../../history/plan-37-typed-messages-and-attachments.md). It depends on three plans
  of the archive:
  [Plan 34](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-34-drive-dropbox-file-context.md),
  [Plan 35](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-35-access-and-data-flow-controls.md) and
  [Plan 36](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-36-async-control-primitives.md).
  Its journey on real Slack is `pnpm --filter @purin-labs/platform canary:plan37`
  (`workers/platform/scripts/plan37-attachment-canary.ts`).
- [Plan 42G](../../history/plan-42G-automatic-context-loading.md), with its
  [implementation evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01.md)
  and the records in the same folder of the archive:
  [candidate](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/live-pi-candidate.json),
  [release candidate](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/release-candidate.json),
  [production release](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/production-release.json),
  [credits and access](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/credits-and-access-followup.json),
  [saved read latency](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/saved-read-latency.json),
  [saved read tokens](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/saved-read-token-usage.json),
  [numerical demand](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/numerical-demand-followup.json) and
  [production acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/production-codex-acceptance.json).
- Where a source differs from the code, this spec follows the code. Plan 37 names Rust
  contracts, and both plans name a second harness. The code keeps the contracts in
  TypeScript (FND-11) and runs Pi on each route (FND-04).
- E2E journeys in `workers/platform/tests/e2e/`: `slack-attachment-journey.test.ts`,
  `slack-attachment-restore.test.ts`, `slack-thread-new-session.test.ts` (the answers
  of the agent in a new Session of a thread), `message-link-fetch-placement.test.ts`,
  `message-link-session-origin.test.ts`, `chat-fork-retention.test.ts`,
  `portal-chat-finalization.test.ts` (saved context, interrupted Kitchen preparation, an
  excluded or absent browser, late readiness, and a file read after revocation) and
  `bakery-runs.test.ts`. The browser journey of the automatic reveal is
  `scripts/bakery-robots/verify-automatic-context-browser.js`.
