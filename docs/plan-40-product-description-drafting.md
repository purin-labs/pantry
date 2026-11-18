# Plan 40 — Minimal Multiplayer Product-Description Drafting

Status: complete on `dev`; multiplayer authoring, live Slack read/edit, and sandbox approval/apply accepted · Updated: 2026-09-13 · Owners: Satyr platform and CafeOS Portal

Merged into `dev` through `a0f62375`, with post-merge reconciliation in
`c398d5ce` and the final closeout recorded in
[the implementation evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40-drafting-20260908.md).

Depends on:
[Plan 16 — Merchant Console and Commerce Operations](./plan-16-merchant-console-commerce-operations.md),
[Plan 21 — CafeOS UX Foundation](./plan-21-cafeos-ux-foundation.md),
[Plan 31-A — Commerce Entity Plane](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-31A-commerce-entity-plane-lists-and-views.md),
and the shared merchant-agent foundations recorded in
[Plan 39 — Urk: Failed Payments and Delayed Orders](./plan-39-urk-merchant-agent-parity.md).

Upstream implementation references:
[Yjs shared types and editor bindings](https://github.com/yjs/yjs),
[Yjs document updates](https://docs.yjs.dev/api/document-updates),
[Yjs browser persistence](https://github.com/yjs/y-indexeddb),
and [Yrs interoperability](https://github.com/y-crdt/y-crdt).

## Decision summary

Add one collaborative draft to the CafeOS Portal: the plain-text description
for one Underclerk Product. Two authenticated merchant operators can open the
same Product, type concurrently, see who else is present, disconnect briefly,
reconnect, and converge on the same draft.

The accepted CRDT choice is Yjs for both the Portal and the TypeScript
platform. Use exactly one `Y.Doc` with one `Y.Text` named `description`. A small
workspace package, `@satyr/product-description-crdt`, owns this document shape and
the bounded operations used by the Portal and `OrganisationActor`. Satyr does not
implement its own sequence CRDT, Lamport-ID scheme, merge algorithm, generic
document model, or network provider.

`OrganisationActor` stores one merged Yjs state per Product and hosts the live
socket room. The Portal uses its existing plain-text control with a
feature-specific Yjs binding. The server persists an accepted update before
acknowledging or broadcasting it.

Ordinary draft edits only change the shared document. An explicit review/apply
flow freezes a saved snapshot and uses the existing governed ActionLedger path
to update the authoritative Product description. Browser persistence remains
outside this slice. Plan 40C subsequently extracted the proven collaboration
mechanics into the reusable multiplayer module without changing this
Product-specific document or publication contract.

## Outcome

An authorized operator opens an Underclerk Product and selects **Edit
description draft**. The Portal initializes the draft from the Product's
current description the first time it is opened. Later opens restore the
durable shared draft.

A second operator can open the same Product. Each operator sees the other's
display name and viewing or editing state. Concurrent insertions and deletions
arrive without a page refresh. Delivery order and duplicate delivery do not
change the converged text.

If a socket disconnects while the page remains open, local edits continue in
the in-memory Yjs document. Reconnection exchanges state vectors so the
client and `OrganisationActor` send each other their missing updates. Reloading an
offline page and retaining unsent edits across browser restarts are outside
this plan.

The current authoritative Product description stays visible beside the draft.
It changes only when a reviewed snapshot is approved and applied.

## Complexity budget

The first slice introduces only four concepts:

1. one feature-specific Yjs wrapper package;
2. one `OrganisationActor` storage record per Product;
3. one authenticated WebSocket protocol; and
4. one collaborative plain-text editor in the existing Product detail view.

Yjs already supplies peer identifiers, logical clocks, update encoding, merge
behavior, state vectors, and duplicate-update handling. Lamport timestamps
alone would order operations without defining how concurrent insertions and
deletions affect a text sequence. Building that missing behavior inside Satyr
would add risk without improving the merchant experience.

There is no reusable `CollaborativeDocument`, document registry, schema DSL,
transport abstraction, sync engine, event log, snapshot service, or new Actor
kind. If a second real drafting feature arrives, it can first reuse the small
pieces that genuinely match. Plan 40 does not predict that abstraction.

Email drafts now reuse the [Plan 40C multiplayer module](./plan-40C-multiplayer-module.md). The bakery workflow
canvas is scoped by
[Plan 42 — Bakery Orchestration Canvas, Timeline and Simulator](./plan-42-bakery-workflow-simulator.md):
canvas, resource timeline and Three.js bakery are synchronized views of one run.
Concurrent canvas editing and comments are a later Plan 42 increment using the
same multiplayer module with stable operation/resource IDs and a bounded bakery
draft schema. That schema remains outside this product-description package.
Ordinary canvas dragging does not require native list moves or a movable tree.

Browser offline editing is an exploratory follow-up using persistent document
updates and a cached application. A future Rust-owned desktop document engine
may use Yrs after the selected versions and shared features pass an
interoperability test. This slice adds neither Yrs nor an interchangeable-engine
abstraction.

## Product boundary

### Included

- one active description draft per organisation and Underclerk Product;
- one plain-text `Y.Text` stored under the key `description`;
- concurrent editing from authenticated Portal sessions;
- authorized Satyr agent reads and exact-passage edits of the same draft;
- viewing and editing presence with a display name;
- colored remote text carets, lightly tinted selections, idle-fading name
  labels, and matching participant colors (implemented in P40.3);
- ephemeral mouse pointers and name labels within the drafting workspace;
- durable server state in the Product's existing `OrganisationActor`;
- reconnect and missed-update repair while the Portal page remains loaded;
- initialization from the current Underclerk Product description on first open;
- a fixed-snapshot comparison and governed description-only review/apply flow;
- an explicit indication when the authoritative Product has changed since the
  draft was initialized;
- exact size and connection limits;
- typed boundary failures; and
- a two-browser walking test.

### Excluded

- publishing any field beyond the reviewed Product description;
- Product title, variants, options, media, offers, prices, inventory, menus,
  SEO, translations, metafields, and every other field;
- Shopify-authored Products and products unavailable from Underclerk;
- rich text, HTML, Markdown semantics, embedded media, and attachments;
- comments, suggestions, tracked changes, history UI, named versions, rollback,
  branching, and per-character attribution;
- durable browser persistence, service workers, and cold-start offline use;
- public API-client and provider writes to the draft;
- email drafts, campaign drafts, playbooks, Cases, and general documents;
- generic Portal presence or replacement of commerce-board polling;
- peer-to-peer sync, desktop sync, filesystem sync, worktrees, and Git;
- a CRDT update log, compaction service, and epoch rollover; and
- compatibility paths for alternate encodings or retired draft shapes.

## Current boundary

The canonical `Product` already has a `description`. Product projections carry
provider provenance and revision. Underclerk owns the authoritative Product;
Blotter and the Portal consume its signed projection.

The Portal already exposes exact commerce records. It also has ephemeral
commerce-board presence held by `OrganisationActor`, with a ten-second Portal
heartbeat. Plan 40 reuses the same organisation membership, control identity, display
conventions, and Actor ownership. The existing board presence endpoint and
polling behavior remain unchanged.

Before Plan 40, the repository had no Yjs dependency, collaborative document
shape, authoring WebSocket, or Product-description draft storage. Plan 39 excludes
broad Product editing. Plan 40 narrows that exclusion for one separate draft;
it still adds no Product mutation.

[AD-041](./plan-3-decisions.md#ad-041--defer-file-native-commerce-and-file-synchronization-2026-08-03)
continues to govern desktop and file synchronization. An in-browser draft does
not activate that deferred scope.

## Fixed design decisions

1. **One feature package.** `packages/product-description-crdt` is the only new
   package. Its only direct runtime dependency is `yjs`, a JavaScript library
   with bundled TypeScript declarations. It contains no organisation, authorization,
   HTTP, React, Cloudflare, commerce, or persistence logic. The Portal loads it
   only when a collaborative editor opens. No CRDT Wasm is introduced.
2. **One pinned release.** Both runtimes use the same pinned stable Yjs 13
   release and V1 update encoding. Review advisories for that release before
   integration; retain reproductions relevant to the decode paths we use.
   Decode failures become typed results. Plan 40 adds no home-grown binary
   decoder, production sandbox, or fallback implementation.
3. **One document shape.** The Yjs document contains exactly one `Y.Text` named
   `description`. Its schema identity is `product_description_crdt.v1`.
   Additional roots, embedded values, formatting attributes, and nested shared
   types fail validation. A plain-text rendering alone does not validate the
   stored document shape.
4. **Plain text.** The CRDT stores Unicode plain text. Line endings are
   normalized to `\n` when a local text edit enters the document. Rich-text
   structure and markup interpretation remain absent.
5. **Yjs identities are mechanical.** Yjs client IDs and logical clocks never
   grant Satyr identity, authority, attribution, or presence. The
   authenticated control session supplies those facts.
6. **One durable authority.** The organisation's existing `OrganisationActor` owns the
   stored merged state. Browser documents are live replicas and cannot replace
   or delete accepted server state.
7. **Persist before broadcast.** The Actor acknowledges and broadcasts an
   update only after the merged state is durable. Validation or storage failure
   discards the mutated in-memory document and reloads the last stored state;
   Yjs transactions do not provide rollback. Serialize each room's
   apply/validate/persist sequence so concurrent handlers cannot acknowledge
   an unpersisted state.
8. **One state blob.** The Actor stores `Y.encodeStateAsUpdate(doc)` after an
   accepted update. Restore into a fresh `Y.Doc` using `Y.applyUpdate`.
   This is complete encoded CRDT state, including pending updates; it is not
   the historical-version marker returned by `Y.snapshot`. No separate
   operation log or plain-text reconstruction is used.
9. **No state reset in V1.** The encoded state has a hard limit. Keep Yjs's
   normal garbage collection, while preserving identities and synchronization
   metadata. Plan 40 does not invent epochs or recreate a document from its
   rendered text. Hitting the limit produces a visible typed failure.
10. **No commerce effect.** Opening, editing, synchronizing, and observing a
    draft never creates a Case proposal, approval, ActionLedger record,
    Underclerk command, or provider request.
11. **No implicit reset.** A later change to the authoritative Product does not
    overwrite the draft. The Portal shows that the source Product revision has
    advanced. Reset, merge into Product, and publication require a later plan.
12. **Existing roles.** Active `operator`, `admin`, and `owner` memberships may
    edit. Active viewers may read the draft and presence. Every submitted update
    rechecks the current membership and role.
13. **One forward format.** There is no existing draft data to migrate. The
    first open creates the V1 state. No raw-text fallback, dual writer, V2
    negotiation, or alternate CRDT implementation is added.

## Ownership and data flow

| Fact                                                | Authority                      |
| --------------------------------------------------- | ------------------------------ |
| Authoritative Product description and revision      | Underclerk                     |
| Projected Product provenance and freshness          | Blotter in `OrganisationActor` |
| Accepted description-draft CRDT state               | `OrganisationActor` storage    |
| Connected participants and presence                 | `OrganisationActor` memory     |
| Control identity, organisation membership, and role | Existing control plane         |
| Unsent edits during a live disconnect               | The loaded Portal Yjs document |

```text
Underclerk Product projection
  -> first open creates one Product-description Yjs state
  -> authenticated Portal replicas connect to OrganisationActor
  -> state-vector exchange repairs missing updates
  -> local text edit produces a bounded Yjs update
  -> OrganisationActor rechecks authority and merges the update
  -> OrganisationActor persists the merged state
  -> acknowledgement to sender and broadcast to peers
```

## CRDT module

`@satyr/product-description-crdt` exposes feature names throughout its public
API. It does not export a general document wrapper. Its `ProductDescriptionDoc`
handle is opaque outside the package, so callers cannot add arbitrary Yjs
shared types.

The package owns these operations:

- create a document from a validated initial description;
- restore a document from untrusted bounded state bytes;
- read the current description;
- translate one native plain-text input change into one Yjs transaction;
- subscribe to description changes and locally generated update bytes;
- apply one untrusted bounded remote update;
- encode complete state with `Y.encodeStateAsUpdate` and the state vector with
  `Y.encodeStateVector`; and
- export a synchronization update using
  `Y.encodeStateAsUpdate(doc, remoteStateVector)`.

Use `Y.applyUpdate` for V1 imports. Local edits run in `doc.transact`; origins
distinguish local input from remote imports so received updates are not echoed
as new local edits. Origins have no authorization meaning.

Recoverable operations return a closed result union:

```ts
type ProductDescriptionCrdtError =
  | { readonly code: "invalid_state" }
  | { readonly code: "invalid_update" }
  | { readonly code: "invalid_state_vector" }
  | { readonly code: "invalid_document_shape" }
  | { readonly code: "description_too_long" }
  | { readonly code: "update_too_large" }
  | { readonly code: "state_too_large" }
  | { readonly code: "state_vector_too_large" };

type ProductDescriptionCrdtResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProductDescriptionCrdtError };
```

Untrusted bytes become validated package-owned values at the package boundary.
Yjs exceptions do not cross that boundary. Exhaustive switches cover every
error branch, and type fixtures reject raw bytes where validated state, update,
or state-vector values are required. Structural validity of update bytes does
not establish the resulting document's shape: apply against the current state,
then check the plain-text invariants before accepting it. Encoded-state limits
include retained updates whose dependencies have not arrived yet.

The plain-text binding captures the native `beforeinput` selection and uses
that replacement range when the resulting text preserves its surrounding
prefix and suffix. This preserves the identities of explicitly inserted
characters, including select-all replacements and insertion among repeated
characters. Input without usable range information falls back to the unchanged
prefix/suffix splice. Each edit is one Yjs transaction, with surrogate pairs
preserved at splice boundaries. IME composition completes before that translation. Capture a bounded
document at composition start, apply remote updates to the live replica while
leaving the composing textarea alone, then merge the completed composition's
update. Yjs relative positions adjust the local selection without replacing the
React component or stealing focus.

## Durable Actor state

The Organisation Actor schema adds one table:

```text
product_description_draft
  product_id                         primary key
  schema_version                     required
  encoded_state                      required bounded blob
  initialized_from_product_revision  required
  updated_by_control_identity        required
  created_at                         required
  updated_at                         required
```

Organisation identity is already fixed by the `OrganisationActor` instance, so it is not
duplicated in the table. `product_id` is parsed from the route and checked
against the fresh Underclerk projection before use. A missing or stale projection
is refreshed for this read from Underclerk's merchant snapshot. The Product ID
used by the entity plane is mapped to Blotter's merchant-qualified projection ID
only at that persistence boundary.

The first open creates the Yjs state from the projected Product description and
records that Product revision in one Actor transaction. Concurrent first opens
serialize through the Actor and return the same stored state. Later opens never
reinitialize an existing row from projection data.

Each serialized room operation restores a `ProductDescriptionDoc` from the
bounded stored blob and discards it afterward. This keeps SQLite as the single
accepted state and avoids cache rollback. Actor eviction loses only sockets
and presence; the next open restores `encoded_state`.

## Authenticated synchronization protocol

### Agent entry points

`product_description_draft_read({productId})` returns the current Product and
the saved draft without creating one. `product_description_draft_edit({productId,
oldText,newText})` replaces one exact, unique passage in the current shared
document. Missing or ambiguous passages fail and require a fresh read. Empty
`oldText` is accepted only for an empty description. Other text remains intact,
and the accepted Yjs update is broadcast to connected Portal editors.

Both tools use the existing Satyr tool host, including Code Mode. Reads retain
Product-source grants and information-flow admission. Edits additionally require
the explicit `commerce.product_description_draft.edit` capability, a current
merchant editor, and context permitted for every Portal role. Private or
channel-restricted information cannot silently become an organisation-wide draft.
Agent edits are attributed to the requesting merchant identity.

The Actor atomically stores each edit and its receipt, keyed by the session,
turn, and tool operation. Replaying the same operation returns its original
result; changing its payload fails. Slack receives draft read/edit results
through the existing Case response path. No separate Slack sender is added.
The edit capability is disabled by default. The isolated P40 organisation demonstrated
a live Slack read and an agent edit arriving in the Portal while a human edited a
separate passage. The edit was applied to the shared draft, though its final
reply reached the session work limit. Follow-up turns now settle against the
original assignment start, terminal budget outcomes stop delivery retries, and
failure messages require results review before another attempt. A later
read-only Slack verification confirmed the applied Product and matching saved
draft.

### Portal transport

The Portal opens a WebSocket at the Product-specific control route:

```text
/v1/control/organisations/:organisationId/commerce/products/:productId/description-draft/socket
```

The Worker authenticates the control session and verifies organisation membership,
Product identity, Underclerk provenance, and projection freshness before
accepting a room member. `OrganisationActor` owns the room after that boundary.
Origin and authentication failures reject the HTTP upgrade. An authenticated
source, capacity, or stored-state failure opens a short-lived socket carrying
the typed failure and immediately closes it without joining the room. Browser
WebSocket APIs cannot expose a rejected upgrade's HTTP response body.

Client messages form one closed V1 union:

```text
sync_request     { stateVector }
submit_update    { updateId, update }
presence_update  { state: viewing | editing, selection: relative anchors | null }
pointer_update   { position: { x, y } | null }
```

Server messages form one closed V1 union:

```text
sync_response    { serverStateVector, missingUpdate,
                   initializedFromProductRevision, currentProductRevision,
                   access: read | edit, sessionId }
update_accepted  { updateId }
update_broadcast { update }
presence_changed { participants }
failure          { code }
```

The exact JSON envelope includes `protocolVersion:
"product_description_sync.v1"` and one discriminant. Binary fields use
base64url. The client imports `missingUpdate`, generates its own synchronization
update from `serverStateVector`, and submits it through the normal acknowledged
update path. Viewers only receive updates. This repairs both directions after a
live disconnect.

Always generate and exchange the synchronization updates, even when the state
vectors are equal. Yjs state vectors track inserted structures; deletion-only
changes can leave them unchanged. Yjs's update encoder includes the deletion
information required for convergence. Do not use vector equality or raw byte
length as a shortcut for deciding that synchronization is complete.

`updateId` correlates an acknowledgement with a pending client update. It does
not order edits or grant idempotency to a commerce action. Importing a duplicate
Yjs update is safe. Reconnect always uses state vectors instead of assuming
all broadcasts arrived.

The Portal keeps one update in flight. Further local edits remain immediate in
the live document; after acknowledgement it encodes the missing update against
the acknowledged document's state vector. This coalesces typing on slow links
without presenting unacknowledged edits as durable.

For every `submit_update`, the Actor:

1. revalidates the socket's current membership and edit role;
2. decodes the exact protocol branch and bounded update once;
3. applies the update through `@satyr/product-description-crdt`;
4. verifies the resulting text invariants and state limits;
5. persists the merged state and accepting control identity;
6. acknowledges the sender; and
7. broadcasts the update to the other room members.

Live messages and presence sweeps also verify the existing active placement,
registry entry, and local Actor activation fence. A frozen or replaced Actor
closes its rooms. The socket path adds no placement migration mechanism.

Current presence contains server-issued session identity, control identity,
display name, `viewing` or `editing`, bounded Yjs relative selection anchors,
normalized workspace pointer coordinates, and server activity timestamps.
It is removed on socket close or heartbeat
expiry and is never persisted. Arbitrary metadata, organisation ID, role,
and client-supplied display names remain outside the client presence payload.

## Limits

V1 fixes these limits in the feature package or the boundary that owns them:

- normalized description: 10,000 UTF-16 code units, matching the browser
  textarea and Yjs's JavaScript text index model;
- one submitted Yjs update, including a reconnect update: 256 KiB before
  base64url encoding;
- one merged encoded state: 256 KiB;
- one state vector: 16 KiB;
- one UTF-8 JSON socket frame: 384 KiB; and
- concurrent sockets for one Product draft: 20.

The update limit admits a complete bounded state during reconnect. The frame
limit also covers its base64url expansion and the state vector. Byte limits
bound accepted input and persisted state; they do not guarantee a fixed decoder
CPU or memory cost. These are fixed constants, not organisation configuration.
Compression, chunking, large-document storage, and background maintenance remain
outside Plan 40.

## Portal experience

The existing Product detail shows the authoritative description and an **Edit
description draft** action. The editor is a labelled plain-text textarea with:

- the durable shared draft;
- participant names and viewing/editing state;
- **Synced**, **Syncing**, or **Reconnecting** connection status;
- character count and the 10,000-character limit;
- the Product revision used on first initialization; and
- a warning when the current authoritative Product revision differs.

There is no Save button. Accepted edits become durable after the Actor's
acknowledgement. While an update is pending, the status remains **Syncing**.
Closing the page with unacknowledged edits uses the ordinary browser leave
warning. The UI makes no claim that an in-memory edit survived a reload.

Internal Portal navigation uses React Router's supported blocker and the
existing native-dialog helpers. The confirmation defaults to **Keep editing**;
**Leave without waiting** explicitly accepts the risk of losing unconfirmed
text. If an acknowledgement arrives while the dialog is open, the copy changes
to confirm that leaving is safe. The existing route tree uses `RouterProvider`
so links, programmatic navigation, and browser Back share this boundary.

Remote edits preserve focus and adjust the local selection.

Viewers receive a read-only textarea and presence. A user whose editing role is
revoked receives a typed `access_revoked` failure, retains a selectable local
copy on screen, and can no longer submit updates.

## Failure and recovery

| Failure                                 | Required behavior                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| Duplicate or reordered update           | Apply safely and converge                                                    |
| Socket disconnect with page open        | Keep local in-memory edits and exchange missing updates on reconnect         |
| Page reload after acknowledged edits    | Restore the durable Actor state                                              |
| Page reload with unacknowledged edits   | Do not claim recovery; unsent in-memory edits may be lost                    |
| Actor eviction                          | Restore durable state; rebuild sockets and presence through reconnect        |
| Actor storage failure                   | Acknowledge and broadcast nothing; discard the mutated cache                 |
| Invalid or oversized update             | Reject it without changing the durable state or other sessions               |
| Product projection unavailable or stale | Refuse first open and explain that the source Product cannot be verified     |
| Membership or role revoked              | Reject the next update and close that participant's editing authority        |
| Product changes after initialization    | Preserve the draft and show the source-revision warning                      |
| CRDT state reaches its limit            | Make the field read-only, preserve copy access, and report `state_too_large` |

## Implementation sequence

### P40.0 — Prove the module

1. Pin the same stable Yjs 13 release for both runtimes and review applicable
   advisories. Add `packages/product-description-crdt` with `yjs` as its only
   direct runtime dependency.
2. Demonstrate two independent `Y.Doc` replicas editing one `Y.Text`, exchanging
   V1 updates, and restoring from encoded state.
3. Implement the feature handle, boundary parsing, native input binding,
   state-vector synchronization, exact limits, and result errors.
4. Prove the package loads through a lazy Portal chunk and the platform Worker.
   Record the optimized artifact size and confirm the initial Portal bundle
   excludes the editor dependency.
5. Test concurrent edits, deletion-only reconnect with equal state vectors,
   duplicate/reversed delivery, and persistence of dependency-pending updates.
   Include Unicode, IME composition with a remote edit, malformed input,
   alternate document shapes, and limits. Run malformed decode cases with a
   bounded test timeout; retain relevant upstream regression cases.
6. Add type fixtures for raw-byte inputs, invalid result handling, and attempts
   to create an alternate shared type.

Exit condition: independent replicas converge and restore the same plain text.
Malformed, alternate-shape, or oversized input cannot become accepted state.
There is no Yrs dependency, CRDT Wasm, or alternate engine path.

### P40.1 — Add the Actor room

1. Add the single Organisation Actor table and restoration path.
2. Add first-open initialization, authenticated socket upgrade, closed V1
   messages, update persistence, acknowledgement, broadcast, and presence.
3. Test cross-organisation access, viewer writes, role revocation, malformed frames,
   size limits, storage failure, Actor eviction, and reconnect.

Exit condition: two protocol clients converge through a real `OrganisationActor`,
including one live disconnect and Actor eviction.

### P40.2 — Ship the Portal slice

1. Add the action and editor to the existing Underclerk Product detail.
2. Bind the native textarea to the feature module and socket protocol.
3. Add presence, connection state, source-revision warning, limits, and typed
   recovery UI.
4. Demonstrate the two-browser walking path with a seeded Product.
5. Confirm the implementation contains no publication path, browser database,
   generic collaboration layer, second document shape, or provider mutation.

Exit condition: two real Portal sessions can concurrently edit one durable
Product-description draft and converge after one session reconnects.

### P40.3 — Multiplayer cursors and colors (implemented locally)

- [x] Show a colored text caret at each remote participant's insertion point.
- [x] Show lightly tinted highlights over each remote participant's selected
      text, using the same color as their caret.
- [x] Show a small name label near active carets. Fade the label when idle and
      reveal it again when the participant moves their selection or types.
- [x] Apply matching colors to the participant list, with a consistent color
      per authenticated person across connected clients and reconnects.
- [x] Show remote mouse pointers with matching colors and small name labels
      within the drafting workspace. Send normalized workspace coordinates at most
      every 50 ms; hide pointers after five seconds idle, on leaving, scrolling,
      resizing, or disconnecting. Pointer updates remain separate from text carets
      and never change saved content.

Keep this within the existing product-description editor and socket room.
Represent selection anchors with Yjs relative positions so concurrent human
and agent edits move the indicators with the text. Extend ephemeral presence;
cursor motion must not modify the document, create durable receipts, or enter
undo history. Derive names and participant identity from authenticated room
membership, and bound and throttle incoming position updates.

Preserve the native textarea binding. Align the visual overlay with its text
wrapping and scrolling, and keep it from intercepting editing interactions.
Clear a participant's text indicators when they leave the editor or disconnect;
retain the existing heartbeat-expiry cleanup for lost connections. Agent tool
edits move anchored selections naturally; this slice adds no simulated agent
pointer or caret.

Exit condition: demonstrate two browser sessions with matching participant
colors, moving carets, forward/backward and multiline selections, idle label
fading, and cleanup after leaving. Concurrent edits, wrapping, scrolling, and
reconnect must keep indicators attached to the intended text without changing
draft contents.

## Required verification

Run the narrowest affected checks first:

```bash
pnpm --filter @satyr/product-description-crdt test
pnpm --filter @satyr/product-description-crdt check:types
pnpm --filter satyr-edge check:types
pnpm --filter satyr-edge check:test-types
pnpm --filter satyr-edge test
pnpm portal:build
git diff --check
```

Required behavioral evidence:

- concurrent insertions at the same position converge;
- overlapping insertion and deletion converge;
- duplicate and reversed update delivery converge;
- a live disconnected client edits and catches up in both directions;
- deletion-only changes synchronize even when state vectors are equal;
- a complete bounded state fits in a reconnect update and socket frame;
- dependency-pending updates survive persistence and merge when dependencies
  arrive;
- Unicode edits and IME composition remain intact during remote changes;
- acknowledged edits survive Actor eviction and page reload;
- an unacknowledged edit is never presented as durable;
- a viewer can read and cannot edit;
- a revoked operator cannot submit another update;
- a cross-organisation socket is denied;
- malformed, oversized, and alternate-shape updates leave state unchanged;
- malformed-input fixtures and relevant upstream regressions terminate within
  the test timeout;
- an Actor storage failure produces no acknowledgement or broadcast;
- a later authoritative Product revision does not overwrite the draft;
- draft activity creates no Case, ActionLedger entry, Underclerk command, or
  provider request.

## Deferred follow-ups

The collaborative menu editor, including menu boards, a free canvas,
comments, and concurrent people and agents, is scoped in
[Plan 40B — Collaborative Menu Editor](./plan-40B-collaborative-menu-editor.md).
It builds on this slice without expanding the product-description document.
The bakery workflow canvas now belongs to
[Plan 42](./plan-42-bakery-workflow-simulator.md); its implementation sequence
starts with simulated orchestration and the three synchronized views. Shared
revision-checked authoring precedes concurrent canvas editing and comments.
Physical workflow execution remains governed by
[Plan 24](./plan-24-cafeos-bakery-automation.md).

Each item needs observed demand and its own product boundary:

- durable browser offline editing with `y-indexeddb`, cached editor assets,
  restart recovery, and organisation/account-specific storage and sign-out handling;
- explicit reconnect behavior for revoked access, deleted drafts, and changed
  schemas, with local-save status distinguished from server acknowledgement;
- offline listing drafts, email drafts, and workflow drafts, with publication,
  email sending, and workflow execution remaining governed online actions;
- a Rust-owned desktop document core using Yrs, conditional on a pinned
  cross-language edit/persist/reconnect proof for the chosen types and encoding;
- draft reset, archive, deletion, or history;
- further collaborative fields or document types beyond the product, email and
  menu surfaces already delivered through Plan 40C.

### Description review and apply

Review freezes the saved description and the authoritative Product revision
shown alongside it. Applying that snapshot uses the existing policy, approval,
ActionLedger, receipt, and replay path through a description-only Underclerk
command. A stale Product revision requires a fresh review. The command changes
only the Product description and its revision/timestamp.

Applying never resets or replaces the shared Yjs document. Concurrent edits
made after review remain available for the next review. CRDT updates themselves
remain free of commerce effects.

The review UI and description command are implemented locally. The isolated P40
sandbox completed proposal creation, Google identity confirmation, approval,
and an accepted Underclerk description update to Ginger Cookie revision 2.
The current description matches the reviewed text and the shared draft remains
intact. Execute responses now separate the authoritative action/receipt from
required `follow_up` state: `complete`, `pending` with `retryAt`, or `unavailable`
with an error code. Reporting failure cannot turn a confirmed provider result
into an execution error. The Portal displays the reporting status independently.

Control-origin approval context is requester-private. Its automatic delivery to
a shared Slack channel remains blocked by the existing disclosure check, and its
pending Case output is retained. An authorized Slack agent can report the current
Product and saved draft through its normal read tool. This slice does not grant
shared channels access to private Portal approval context.

## Done means

Plan 40 is complete when:

- one Underclerk Product has one durable shared description draft;
- two authenticated Portal users can edit it concurrently and see presence;
- remote carets, selections, name labels, and participant colors satisfy P40.3;
- duplicate, reordered, and missed update delivery converges;
- bounded invalid input cannot alter accepted state;
- a live disconnected tab catches up after reconnect;
- acknowledged edits survive Actor eviction and page reload;
- viewers and revoked operators cannot submit accepted updates;
- the authoritative Product changes only through explicit reviewed application;
- a reviewed snapshot applies once and preserves newer shared edits;
- ordinary draft edits stay outside the commerce action path; and
- the Product adapter contains one document shape and one publication path, while
  synchronization, presence, receipts, and the socket protocol use the shared
  Plan 40C multiplayer module.
