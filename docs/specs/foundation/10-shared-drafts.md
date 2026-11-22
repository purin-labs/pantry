# FND-10 — Shared drafts

A shared draft is a document that several people and Sous Chef agents change at the same
time in Purin Pantry. The multiplayer module gives each shared document one room in the
`OrganisationActor`, one sync protocol and one set of Portal parts. A document is a Yjs
document with a fixed shape. The room stores an accepted change before it confirms the
change or sends it to other people. This spec gives the module and two drafts: the
product description draft and the email draft. A change to one of these two drafts has
no effect on the business. For a description, a person reviews the draft and approves a
governed action before the product record changes. Each other shared document belongs
to the spec of its area.

## What it does

### The room of one document

- A feature defines its document with `defineSharedDoc` or `definePlainTextDoc`: the
  schema name, the roots, the size limits and a shape check. The module gives the
  checked encodings, the document base class and the sync protocol.
- The workflow canvas and the workflow draft use `defineSharedEncoding`. The module
  gives them the checked encodings and the sync protocol, and each one has its own
  document class (KIT-01, KIT-03).
- A document from the base class runs each change on a copy. The copy must pass the
  shape check before it replaces the document. A refused change leaves the accepted
  state as it was. The two other classes check a received update on a copy in the same
  way.
- A room belongs to one Organisation, one kind of document and one key, for example a
  product id. The set of kinds is closed (`CollaborationRoomKind`). The key comes from
  the route, after the admission checks.
- One serial queue runs the work of a room: each open, message, agent edit and sweep.
- For a `submit_update`, the room restores the document from the stored state, applies
  the update and checks the result. It stores the merged state. Then it sends
  `update_accepted` to the sender and `update_broadcast` to each other socket.
- An update that changes nothing gets `update_accepted`, with no write and no
  broadcast. A second delivery of one update is thus safe.
- The room keeps no document in memory. The Actor SQLite of the Organisation holds the
  only accepted state: one encoded Yjs state for each document.
- A browser cannot read the body of a refused WebSocket upgrade. When the room refuses
  an open, it opens a socket, sends one `failure` frame and closes it. The causes are a
  full room, a draft that cannot start, an Organisation that is not active in this
  Actor and an access that the feature refuses.
- A refusal before the room is a plain HTTP error with no socket: each admission check,
  `organisation_placement_conflict` (409) and an absent Organisation record (404). The
  two drafts of this spec also answer `access_revoked` (403) for an absent user record
  or a display name of more than 256 characters.
- A feature can also change a document on the server for a person
  (`CollaborationRoom.mutate` with the origin `control_session`). The room then checks
  the control session of the person and the operator role. A feature can add its own
  check of a participant (`participantAccess`): it lowers `edit` to `read` or refuses
  the participant. A feature can end each socket of a room with a last `failure` frame
  (`end`). The two drafts of this spec use none of these.

### Sockets that sleep

- The sockets use the hibernation API of the Actor runtime (FND-02). An open socket
  with no traffic costs no Actor time.
- The socket attachment holds all that the room knows about a participant. It has the
  route, a session id from the server, the control session id, the user and the display
  name. It also has the access at the open, the presence and the time of the last
  message. It holds no bearer token, and no table stores presence.
- The client sends `pantry.ping` every 30 s. The runtime answers `pantry.pong` and does
  not wake the Actor. On the same 30 s timer, the client treats a socket as lost when
  the last frame is more than 75 s old.
- The Organisation alarm runs the sweep of each room. The sweep closes a socket that is
  silent for more than 90 s. It checks the access of each socket again, and it ends a
  revoked socket with `access_revoked`.
- The sweep runs every 90 s while two sockets share a room, and every 5 minutes
  otherwise. With no open socket, no sweep runs.
- The room also checks access for each `sync_request` and `submit_update`, and for each
  receiver before a broadcast. Each presence or pointer frame runs the check for each
  socket of the room. A person who had edit access and now has the viewer role gets
  `access_revoked`.
- If an access check cannot run, the room closes the socket with no failure frame. The
  client connects again and keeps its unsent changes.
- When the Organisation moves or its state is erased, the Actor closes each socket with
  code 1012 (`organisation_moved`). Each client connects again.

### Sync in the browser

- On each open and each reconnect, the client sends its state vector in a
  `sync_request`. The room answers with its state vector and the update that the client
  lacks. A client with edit access then submits the update that the room lacks.
- Both sides always exchange these updates, also when the state vectors are equal. A
  delete changes the content and can leave a state vector unchanged.
- The client keeps one update in flight. Later local changes stay in the local
  document. After the `update_accepted`, the client submits the difference.
- "Synced" means that the server accepted each change of this client. The status values
  are `connecting`, `syncing`, `synced`, `reconnecting` and `failed`.
- After a lost socket, the client connects again after 2, 4, 8 and then 10 s. Changes
  stay in the memory of the open page. A reload loses each change that the server did
  not accept.
- With changes that the server did not accept, the page shows the leave warning of the
  browser. For navigation in the Portal, a dialog asks first. Its default is **Keep
  editing**.
- A `failure` frame ends the connection of a text draft. The field becomes read-only,
  the text stays on the page for a copy, and the client submits nothing more.
- A room can name a document generation in its `sync_response`. When the generation
  changes, the client drops its copy and starts again from the copy of the room. Only
  the costs sheet uses it (KIT-04).

### Presence

- A participant has a session id, a user id, a display name, the state `viewing` or
  `editing`, a selection, a pointer and the time of the last activity.
- The server sets the identity from the control session. A client cannot send a name.
  Two tabs of one person are two sessions.
- A viewer is always `viewing` and has no selection.
- A text selection is two Yjs relative positions and a direction. The positions move
  with the text when other people or agents change it.
- A pointer is a position from 0 to 1 on each axis of the draft workspace. The client
  sends it at most every 50 ms, and not for a touch. It clears the pointer after 5 s
  with no motion, and on blur, scroll, resize and a lost socket.
- The Portal draws a caret, a tinted selection and a name label for each other person.
  The label fades after 5 s with no activity. A hash of the user id selects one of
  eight colours, so a person has the same colour on each client.

### Agents in a room

- An agent edit goes through the same room and the same stored state as the change of a
  person (`CollaborationRoom.mutate`).
- The room admits the edit only for a current member with a role above viewer, who is
  the requester of the turn. The Organisation must be active in this Actor, the turn
  must still be authorized and the deadline must not be past.
- After the write, the room checks the Organisation, the turn and the deadline again.
  If a check fails then, the tool gets an error and the stored change stays.
- One transaction of Actor storage holds the change and its receipt. The receipt key is
  the Session, the turn and the tool operation. The same operation again returns the
  first result and changes nothing. The same key with other input fails with
  `operation_conflict`.
- A text edit replaces one exact passage that occurs one time. A passage that is absent
  or occurs more than one time fails with `passage_conflict`, and the agent reads the
  draft again. An empty `oldText` is correct only for an empty text. No tool replaces a
  full document.
- While an edit runs, each participant sees the agent: its name, the operation and the
  target (`CollaborationAgentActivity`). The name comes from the agent definition of
  the Case assignment. The default is "Sous Chef". After an accepted edit, the label
  stays on the target for 5 s.
- The agent label is in memory only and grants nothing. The room shows no pointer
  travel and no click that did not occur.
- A canvas room adds an action, a colour and a preview of an edit to this activity
  (CAFE-01).

### The product description draft

- Each product of the commerce engine has at most one description draft in an
  Organisation. The commerce system of the Organisation must be `builtin_commerce`.
- The draft is one plain text of at most 10,000 UTF-16 code units, in the `Y.Text` root
  `description`. A line end is `\n`. A format, an embed or a second root fails the
  shape check.
- The product detail in the Commerce area has the section **Description draft** and the
  button **Edit description draft**. The button is off while the product record is not
  current. The Portal loads the editor as a separate chunk.
- The first open of the socket creates the draft from the current product description
  and records that product revision. Each role does this, also a viewer. An agent edit
  also starts a draft that does not exist. A later open restores the stored draft and
  never starts it again from the product.
- The room reads the product from the projection in the Organisation Actor, if that
  record is at most 15 minutes old. If not, it reads the merchant snapshot of the
  commerce engine. If no source answers, the open fails with `source_unavailable`. The
  room never makes an empty draft in its place.
- The room reads the product again for each `sync_request` and for each agent edit. A
  reconnect thus fails with `source_unavailable` while no source answers. A product
  that the shop does not have also shows on the socket as `source_unavailable`.
- The page shows the current product description beside the draft, the character
  count, the sync status and the participants. It has no Save button.
- When the product revision differs from the revision at the start of the draft, the
  page shows a warning. The draft stays as it is.

### Review and apply of a description

- **Review draft** is available when the draft is synced, the person has edit access
  and the current product is loaded. The page then freezes the draft text and the
  product revision, and shows them beside the current product description.
- A later change to the shared draft does not change the frozen text. The page says
  that the draft changed after the review.
- **Send for approval** proposes the governed commerce action
  `update_product_description` with the product id, the frozen revision and the frozen
  text. The Portal offers it to an owner or an admin. The approval, the apply and the
  receipt belong to the commerce action path (COM-05).
- The action names the frozen revision as the expected product revision. If the send
  fails, the page loads the product again, keeps the frozen review and shows **Try
  again**. **Try again** sends the same frozen text with the same revision. **Review
  current text again** makes a new review. If a permission is missing, the permission
  prompt shows (FND-06).
- The apply sends one `updateProductDescription` command to the commerce engine, with
  the expected product revision and the description (COM-05). It does not change or
  reset the shared draft: only `product-description-draft.ts` writes the draft tables.
- An agent proposes the same action with `commerce_propose_action`, with the full text
  from its last draft read.

### The email draft

- An Organisation has one email draft (`singleton_id = 'active'`). It has three plain
  texts: `subject`, `preview` and `body`. It has no recipients, no schedule and no send.
- The draft has a revision, which increases by 1 with each stored change. A read
  returns the document id, the revision, the time of the read and the three texts.
  Before the draft starts, a read returns `not_started` with revision 0 and no texts.
- The first open of the socket creates an empty draft at revision 1. Each role does
  this, also a viewer.
- An agent edit names a field, a passage, the new text and `expectedRevision`. A
  revision that is not current fails with `revision_conflict`. Revision 0 with an empty
  passage starts the draft, only while no draft exists.
- An operator freezes a review snapshot through the review route. Pantry stores the
  snapshot with its revision. A review gives no approval and no right to send. Before
  the draft starts, the route answers `email_draft_not_started` (409).
- The agent tools read and change the email draft only in the Slack thread that an
  owner or an admin connected to it.

## Contracts

- **Packages.** `packages/collaboration` (`@purin-labs/collaboration`) is the module:
  `shared-doc.ts`, `plain-text-doc.ts`, `yjs-encoding.ts`, `sync-protocol.ts`,
  `wire.ts`, `text-selection.ts`, `text-collaboration.ts`, `plain-text.ts` and
  `agent-presence.ts`. Each document has its own package, but the workflow canvas and
  the workflow draft share one package. All of them pin `yjs` 13.6.32 and the V1
  update encoding.
- **Server.** In `services/platform/src/actors/`: `collaboration-room.ts` (the room),
  `collaboration-room-dispatch.ts` (the route and socket dispatch),
  `collaboration-agent.ts` (the agent name) and `collaboration-slack-thread.ts` (the
  Slack thread link). `commerce-collaboration-rooms.ts` and
  `inbox-collaboration-rooms.ts` join the two drafts of this spec to the dispatch.
  `product-description-draft.ts` and `email-draft.ts` hold their storage and rules.
- **Portal.** `apps/portal/src/features/collaboration/`: `document-client.ts`,
  `text-client.ts`, `socket-liveness.ts`, `draft-presence.tsx`, `agent-cursors.tsx`,
  `slack-thread-control.tsx` and `draft-leave-dialog.tsx`. The description editor is in
  `apps/portal/src/features/commerce/description-draft/`.
- **Layers.** In `scripts/layers.json`, the module is `foundation/collaboration`:
  `packages/collaboration`, `collaboration-room.ts`, `collaboration-room-dispatch.ts`,
  `collaboration-agent.ts`, `collaboration-slack-thread.ts` and the Portal folder
  `features/collaboration/`. The code of the description draft is in `areas/commerce`.
  The code of the email draft is in `areas/inbox`.
- **D1.** None. All draft state is in the Actor SQLite of the `OrganisationActor`. Its
  class is `OrganisationDO` (FND-02).
- **Events.** None. The room writes the trace `collaboration.socket_refused` for a
  frame that it refuses.

| Room kind             | Package                                | Schema                        | Protocol                      | Owner                    |
| --------------------- | -------------------------------------- | ----------------------------- | ----------------------------- | ------------------------ |
| `product_description` | `@purin-labs/product-description-crdt` | `product_description_crdt.v1` | `product_description_sync.v2` | This spec                |
| `email_draft`         | `@purin-labs/email-draft-crdt`         | `email_draft_crdt.v1`         | `email_draft_sync.v2`         | This spec                |
| `mail_reply_draft`    | `@purin-labs/mail-reply-crdt`          | `mail_reply_crdt.v1`          | `mail_reply_sync.v1`          | INB-01                   |
| `menu_draft`          | `@purin-labs/menu-draft-crdt`          | `menu_draft_crdt.v2`          | `menu_draft_sync.v3`          | CAFE-01                  |
| `menu_board`          | `@purin-labs/menu-board-crdt`          | `menu_board_crdt.v1`          | `menu_board_sync.v1`          | CAFE-01                  |
| `production_plan`     | `@purin-labs/production-plan-crdt`     | `production_plan_crdt.v1`     | `production_plan_sync.v1`     | Plan 40D, in the archive |
| `costs_sheet`         | `@purin-labs/costs-sheet-crdt`         | `costs_sheet_crdt.v1`         | `costs_sheet_sync.v1`         | KIT-04                   |
| `workflow_canvas`     | `@purin-labs/workflow-canvas-crdt`     | `workflow_canvas_crdt.v1`     | `workflow_canvas_sync.v2`     | KIT-01                   |
| `workflow_draft`      | `@purin-labs/workflow-canvas-crdt`     | `workflow_canvas_crdt.v2`     | `workflow_draft_sync.v1`      | KIT-03                   |

The sync protocol has nine message kinds by default. A frame is JSON with
`protocolVersion`, `kind` and the exact fields of its kind. Bytes are base64url. Another
field or another version fails with `invalid_message`.

| From   | Kind               | Fields                                                                                        |
| ------ | ------------------ | --------------------------------------------------------------------------------------------- |
| Client | `sync_request`     | `stateVector`                                                                                 |
| Client | `submit_update`    | `updateId` (1 to 64 of `A-Z a-z 0-9 _ -`), `update`                                           |
| Client | `presence_update`  | `state`, `selection`                                                                          |
| Client | `pointer_update`   | `position` (`x`, `y`) or null                                                                 |
| Server | `sync_response`    | `serverStateVector`, `missingUpdate`, the room fields, `access` (`read`, `edit`), `sessionId` |
| Server | `update_accepted`  | `updateId`                                                                                    |
| Server | `update_broadcast` | `update`                                                                                      |
| Server | `presence_changed` | `participants`, `agents`                                                                      |
| Server | `failure`          | `code`                                                                                        |

- The room fields of a `sync_response` are `documentRevision` by default. The product
  description room sends `initializedFromProductRevision` and `currentProductRevision`.
- A package can add fields to `sync_response`, `update_accepted`, `update_broadcast`
  and `presence_changed`. It can also add server kinds with no fields. The workflow
  canvas adds `lastChange` and the kind `chat_changed` (KIT-01). The workflow draft
  sends no `agents` and adds the kind `revision_changed` (KIT-03).
- Failure codes of each room: `invalid_message`, `access_revoked`,
  `storage_unavailable`, `room_full`, `invalid_state`, `invalid_update`,
  `invalid_state_vector`, `update_too_large`, `state_too_large` and
  `state_vector_too_large`. A text document adds `invalid_document_shape`.
- The description adds `description_too_long` and `source_unavailable`. The email draft
  adds `field_too_long` and `draft_too_long`.

The routes are under `/v1/control/organisations/:id`. A socket must come from the exact
Portal origin (`PANTRY_PUBLIC_ORIGIN`). The role "Admin" includes the owner.

| Route                                                           | Method                 | Role     | Purpose                                                                        |
| --------------------------------------------------------------- | ---------------------- | -------- | ------------------------------------------------------------------------------ |
| `/commerce/products/:productId/description-draft`               | `GET`                  | Viewer   | The product from the commerce engine, and the draft: `not_started` or `active` |
| `/commerce/products/:productId/description-draft/socket`        | `GET`                  | Viewer   | The room socket                                                                |
| `/commerce/products/:productId/description-draft/shared-thread` | `GET`, `PUT`, `DELETE` | Admin    | Read, connect or disconnect one Slack thread                                   |
| `/collaboration/email-draft`                                    | `GET`                  | Viewer   | The email draft and its revision                                               |
| `/collaboration/email-draft/socket`                             | `GET`                  | Viewer   | The room socket                                                                |
| `/collaboration/email-draft/review`                             | `POST`                 | Operator | Freeze a review snapshot                                                       |
| `/collaboration/email-draft/shared-thread`                      | `GET`, `PUT`, `DELETE` | Admin    | Read, connect or disconnect one Slack thread                                   |

- A `PUT` or a `DELETE` of a shared thread and the review `POST` are mutations. They
  need the Portal origin and the CSRF header (FND-06).
- The body of a `PUT` is `threadUrl`. The link must be
  `https://<workspace>.slack.com/archives/C…/p<16 digits>`. Another form answers
  `draft_thread_link_invalid` (422). A thread that Pantry cannot find in the
  Organisation answers `draft_thread_unavailable` (409). A connect for a description
  also fails with 409 if the product source does not answer.
- A draft `GET` answers 503 with the failure code if the draft cannot be read. For a
  description, this includes a product source that does not answer.

| Actor SQLite table                    | Holds                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_description_draft`           | One row for each product: `schema_version`, `encoded_state`, `initialized_from_product_revision`, `updated_by_app_user` and the times          |
| `product_description_draft_operation` | The receipt of each agent edit: the request, the product at the edit and the draft text after it                                               |
| `product_description_draft_thread`    | The connected Slack thread of a product: the Case, the Slack account, the channel, the link, `approved_by` and the state `shared` or `revoked` |
| `email_draft`                         | The one row: `schema_version`, `encoded_state`, `revision`, `updated_by_app_user` and the times                                                |
| `email_draft_operation`               | The receipt of each agent edit: the request, the revision and the result                                                                       |
| `email_draft_review`                  | Each frozen review: the revision, the three texts, the person and the time                                                                     |
| `email_draft_thread`                  | The connected Slack thread, as for a product                                                                                                   |

`hibernatable_socket_sweep` holds the time of the next sweep (FND-02).

| Agent tool                       | A turn offers it with                     | Effect | What it does                                                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_description_draft_read` | `commerce.entity_plane.context`           | Read   | Returns the product and the saved draft. It makes no draft. `productId: null` reads the draft that is connected to the Slack thread of the turn. It fails if the thread has no connected draft, or the drafts of more than one product |
| `product_description_draft_edit` | `commerce.product_description_draft.edit` | Draft  | Replaces one exact passage of the description. It starts the draft if none exists                                                                                                                                                      |
| `email_draft_read`               | `marketing.email_draft.edit`              | Read   | Returns the email draft and its revision                                                                                                                                                                                               |
| `email_draft_edit`               | `marketing.email_draft.edit`              | Draft  | Replaces one exact passage of one field, at `expectedRevision`                                                                                                                                                                         |

The tools are in `services/platform/src/agent-tools/commerce/description-draft.ts` and
`agent-tools/channels/email-draft.ts`, and Code Mode can call them. The two edit
capabilities are in `foundation/authority/authorization/capability-catalogue.ts`. A new
Organisation has both switched off. An agent can ask for each one in the permission
prompt (`PERMISSION_REQUESTABLE`).

## Rules and limits

| Action                                         | Viewer | Operator | Admin and owner | Agent                                                    |
| ---------------------------------------------- | ------ | -------- | --------------- | -------------------------------------------------------- |
| Read a draft and see presence                  | Yes    | Yes      | Yes             | The read tool                                            |
| Change a draft                                 | No     | Yes      | Yes             | The edit tool, for a person who is an operator or higher |
| Freeze an email review snapshot                | No     | Yes      | Yes             | No                                                       |
| Send a description for approval, in the Portal | No     | No       | Yes             | `commerce_propose_action`                                |
| Connect or disconnect a Slack thread           | No     | No       | Yes             | No                                                       |
| Change a product record with a draft change    | No     | No       | No              | No                                                       |

| Limit                                                           | Value                                                                                        | Constant                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Description text                                                | 10,000 UTF-16 code units                                                                     | `DESCRIPTION_LIMIT`                                                                       |
| Description update, state, state vector                         | 256 KiB, 256 KiB, 16 KiB                                                                     | `UPDATE_LIMIT`, `STATE_LIMIT`, `STATE_VECTOR_LIMIT`                                       |
| Email subject, preview, body, all three                         | 200, 300, 50,000, 50,500                                                                     | `EMAIL_SUBJECT_LIMIT`, `EMAIL_PREVIEW_LIMIT`, `EMAIL_BODY_LIMIT`, `EMAIL_AGGREGATE_LIMIT` |
| Email update, state, state vector                               | 256 KiB, 512 KiB, 64 KiB                                                                     | `EMAIL_UPDATE_LIMIT`, `EMAIL_STATE_LIMIT`, `EMAIL_STATE_VECTOR_LIMIT`                     |
| One socket frame                                                | 384 KiB                                                                                      | `COLLABORATION_FRAME_LIMIT`                                                               |
| Sockets in one room (`room_full`); agent operations in one room | 20; 20                                                                                       | `COLLABORATION_SOCKET_LIMIT`                                                              |
| Messages of one socket that wait in the queue                   | 8                                                                                            | A number in `CollaborationRoom.receive`                                                   |
| Socket attachment                                               | 16,384 bytes                                                                                 | `ATTACHMENT_LIMIT_BYTES`                                                                  |
| Client ping; lost socket                                        | 30 s; 75 s                                                                                   | `COLLABORATION_PING_INTERVAL_MS`, `COLLABORATION_PONG_TIMEOUT_MS`                         |
| Silent socket; sweep                                            | 90 s; 300 s                                                                                  | `SOCKET_SILENCE_LIMIT_MS`, `SOCKET_SWEEP_INTERVAL_MS`                                     |
| Pointer idle; caret label idle                                  | 5 s; 5 s                                                                                     | `COLLABORATION_POINTER_IDLE_MS`, `IDLE_AFTER_MS`                                          |
| Agent label after an edit                                       | 5 s                                                                                          | `AGENT_ACTIVITY_HOLD_MS`                                                                  |
| Preview of an agent edit: life, new admission                   | 6 s, 2 s                                                                                     | `AGENT_PREVIEW_LIFETIME_MS`, `AGENT_PREVIEW_ADMISSION_MS`                                 |
| Product projection as the draft source                          | 15 minutes                                                                                   | `COMMERCE_PROJECTION_STALE_AFTER_MS`                                                      |
| Agent edit                                                      | The turn lease, or 30 s if that is sooner. In a Code Mode script: the deadline of the script | `CODE_MODE_PILOT_BUDGET.maxDurationMs`                                                    |

- The limits are constants, not Organisation settings. A document that reaches a limit
  fails with its code, for example `state_too_large`. No code resets or compacts a
  description draft or an email draft. The costs sheet room has a reset route and a
  compaction (KIT-04).
- **Retention.** No code deletes a draft, an operation receipt or a review snapshot.
  They stay in the Actor storage of the Organisation until that storage is erased
  (FND-02).
- **Identity.** A Yjs client id and a Yjs clock give no identity, right or author. The
  control session gives them. A stored change names the user who made it. An agent edit
  names the person who asked.
- **No business effect.** An open, a change, a sync or a presence frame makes no Case
  proposal, no approval, no action ledger record, no engine command and no provider
  request.
- **Agent read.** The description read and the description edit need a read grant for
  the product. The room result enters the turn as a commerce observation with its
  label. A refused product read can start a permission request (FND-06). A permission
  request for the description edit capability also asks for the read of product
  records.
- **Agent edit.** The edit is a `tool_effect` with `readByEveryMember`: its audience is
  each role, not the person who asked (FND-07). A description edit needs no link if
  each role may read the label of the turn. If not, the turn must run in the Slack
  thread that an owner or an admin connected to this draft. That thread then joins the
  audience. The email draft tools always need the connected thread: they check the
  turn and the thread link before they read the label. The exit check can still ask
  the person who asked.
- **Slack thread link.** The link must be a thread of a Slack channel of the
  Organisation, and the Case of that thread must exist. One draft has one connected
  thread. The link counts only while the person who made it is an owner or an admin.
- **Outside text.** After a turn reads text that a person outside the Organisation
  wrote, an email draft edit passes and a description draft edit asks (FND-07).
- **Request authority.** A turn with the authority `control`, `direct_conversation` or
  `shared_conversation` can change a description draft. A `workflow`, `agent_mailbox`
  or `whatsapp_support` turn cannot. The email draft tools work only for
  `shared_conversation`. The description edit and the email draft tools also need a
  current member whose role is the same as at the start of the turn.
- **Plain text.** A text draft holds no markup. The Portal shows it as text.

Out of scope: rich text, HTML, Markdown rules and media in a text draft; comments,
history, named versions and tracked changes in a text draft; product fields other than
the description; products of Shopify; public API writes to a draft; peer-to-peer,
desktop and file sync (ENG-01 keeps that decision).

Boundaries:

- **FND-02** owns the hibernation helpers, the socket sweep and the alarm. **FND-01**
  owns the placement check that each room step makes.
- **FND-06** owns roles, capability policy, the permission request and the approval
  prompt. **FND-07** owns the labels and the exit check. **FND-09** owns the tool
  catalogue.
- **COM-05** owns the governed commerce action and its receipt. **COM-02** owns the
  commerce engine that applies the description.
- **CAFE-01** owns menu drafts, boards and agent previews. **INB-01** owns mail reply
  drafts. **KIT-01**, **KIT-03** and **KIT-04** own the canvas, the workflow draft and
  the costs sheet.
- Plan 40C also records the information-flow rules of the Slack message draft
  (`slack_message_propose`, the table `slack_message_proposal`) and of
  `request_permission`. They are not shared drafts. FND-06 owns the permission request.
  The Slack message draft is in the layer `surfaces/slack`.

## Open work

- No Portal page shows the email draft. The room, the routes and the agent tools exist.
  Recipients, a list of drafts, a schedule and a send are not built.
- The description review freezes in the page, not on the server. Of the two drafts,
  only the email draft has a server review snapshot.
- The description tools have no draft revision: the exact passage is the only check
  against a stale edit. Of the two drafts, only the email draft tools use
  `expectedRevision`.
- A browser store for unsent changes, a cached Portal and an offline start are not
  built. A reload loses each change that the server did not accept.
- The description draft and the email draft have no reset, archive or delete, and no
  retention time for receipts.
- A draft with another `schema_version` fails with `invalid_state`. No upgrade path for
  a stored draft exists.
- A Rust document core with Yrs is not built. The sources name it as a later option.

## Sources

- [Plan 40](../../history/plan-40-product-description-drafting.md), the product description
  draft. Its evidence in the archive:
  [the implementation record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40-drafting-20260908.md).
- [Plan 40C](../../history/plan-40C-multiplayer-module.md), the multiplayer module. Its
  evidence in the archive:
  [the agent cursor record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/README.md),
  [the live acceptance record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40C-live-acceptance-2026-10-01.md),
  [the end of menu schema v1](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40C-menu-v1-retirement-2026-10-01.md),
  [the Slack draft record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/production-slack-draft.json),
  [gate 1](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/production-gate-1.json),
  [gate 2](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/production-gate-2.json),
  [the propose permission journey](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/propose-permission-journey.json)
  and
  [the unbound channel journey](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/unbound-channel-journey.json).
  The hibernation decision is in
  [Plan 57](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-57-live-delivery.md).
- Where a source differs from the code, this spec follows the code.
- E2E journeys in `services/platform/tests/e2e/`: `product-description-draft.test.ts`,
  `description-draft-reconnect.test.ts`, `collaboration-drafts.test.ts`,
  `slack-draft-permission.test.ts`, `slack-email-draft-label.test.ts`,
  `pi-commerce-description.test.ts`, `commerce-propose-permission.test.ts` and
  `commerce-propose-unbound-channel.test.ts`.
- Scripts: `scripts/plan40/` (a protocol peer, a browser fixture and a local Worker)
  and `scripts/plan-50/draft-collaboration-worker.mjs` with
  `scripts/plan-50/draft-browser-acceptance.js`.
