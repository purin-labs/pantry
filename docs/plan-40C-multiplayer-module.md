# Plan 40C — Reusable Multiplayer Drafting Module

Status: complete and in production. The agent permission request passed on 2026-10-18, gate 2 (governed review, approval and apply) on 2026-10-20 and gate 1 (a Slack agent edit of a connected draft) on 2026-10-21, all in the Satyr workspace. The follow-up fixes are in production since 2026-10-22: a connected draft read without a product id, Allow during a Slack outage, and the AI time limit per request · Plan reviewed: 2026-09-21 · Updated: 2026-10-22 · Owners: Satyr platform and CafeOS Portal

Implementation progress: all three delivery phases are merged into `dev` through
`a0f62375`, `c398d5ce`, and `b1d6b866`. Product and email text surfaces share
the browser client, presence primitives, protocol utilities, and OrganisationActor
room. The structured menu uses the same room and presence transport with a
feature-owned collection binding. Product storage and publication remain
unchanged.

Builds on [Plan 40 — Product-Description Drafting](./plan-40-product-description-drafting.md).
Provides shared authoring infrastructure for
[Plan 40B — Collaborative Menu Editor](./plan-40B-collaborative-menu-editor.md).
Plan 40B remains separate and owns the board documents, the free canvas,
screens, board releases and the QR order page. Plan 40C owns the reusable
module.

[Plan 42 — Bakery Orchestration Canvas, Timeline and Simulator](./plan-42-bakery-workflow-simulator.md)
owns the bakery canvas, resource timeline and Three.js views of one orchestration
run. Its later concurrent authoring/comments increment reuses this module with
a bounded bakery draft schema and stable operation/resource identities. The
entity plane retains canonical workflow revisions; accepting a draft uses the
existing validated command path. CRDT updates and presence never dispatch robot
tasks or modify accepted run history.

## Decision

Extract the working P40 collaboration mechanics into a small shared module.
Make that module the default foundation for new authoring features. Existing
features adopt it explicitly by defining a document shape, binding their
controls, and retaining their domain-specific validation and publication rules.

Use Yjs in the browser and TypeScript platform. Keep rooms and durable draft
state in the existing OrganisationActor. Reuse existing authorization, agent tools,
operation receipts, and governed actions. Introduce no CRDT engine, database,
Actor kind, schema language, plugin registry, or universal form generator.

Prove reuse with product descriptions and a small email-draft editor before
adding structured café-menu editing. Do not convert the entire dashboard in
one change.

## Outcome and scope

A feature developer defines the content, access rules, editor, and review/apply
behavior. Shared infrastructure supplies synchronization, durable saving,
reconnect, participant identity and colors, presence, and bounded agent access.

Humans and agents can contribute to the same saved draft. Other participants
see accepted changes. Publishing or executing the result remains an explicit
domain operation.

| State                  | Examples                                               | Treatment                                               |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| Shared working content | Text, proposed settings, canvas records, comments      | Persisted Yjs document                                  |
| Temporary presence     | Carets, selections, pointers, active field             | Ephemeral room state                                    |
| Authoritative state    | Actual prices, inventory, payments, approval decisions | Existing server-validated commands and live projections |

Adoption is page-by-page: give an authoring page one coherent shared document
and participant experience. Avoid independently multiplayer dashboard widgets.
Within that page, authority follows each operation. An operational checklist
may contain shared notes alongside completion actions that require receipts.
Prices can be proposed in a draft; accepting a price change requires the
commerce action path.

### Integration review — 21 September 2026

Subsequent bakery and operational-email work leaves this module's completed
scope and Yjs decision unchanged. Plan 42 O3 must finish validated assignment
mutation and save/readback before collaborative bakery assignment editing is
added. Three.js playback and presence do not provide scene-authoring semantics.

The governed Gmail canary in [Plan 29E](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-29E-gmail-self-test.md) uses its
own proposal, approval and provider-receipt path. Content studio's shared email
draft remains draft-only; connecting its frozen snapshot to that send path
requires a separately scoped integration and explicit review.

## Starting implementation

Reuse these P40 sources:

- `packages/product-description-crdt/src/index.ts`: bounded Yjs state and
  updates, text operations, relative selection positions.
- `packages/product-description-crdt/src/protocol.ts`: authenticated room
  messages, synchronization acknowledgments, presence and pointer messages.
- `services/platform/src/actors/product-description-draft.ts`: room lifecycle,
  durable acceptance, authorized agent reads/edits, and operation receipts.
- `apps/portal/src/features/commerce/description-draft/`: browser connection,
  text binding, participant list, carets, selections, pointers, and review UI.

The current update validator accepts only the description text structure.
Keep that protection as a product-specific validator. Supporting another
document shape requires its own bounded validator; removing shape validation
is not an extraction strategy.

P40 supports disconnected editing while the page stays open. Browser restart
recovery and persistent offline editing remain deferred.

## Module boundaries

### Shared document primitives

Create `packages/collaboration` for genuinely shared Yjs encoding, protocol,
and text/selection primitives. Keep product document construction and product
limits with the product feature. Move existing implementations directly and
remove replaced copies and obsolete exports.

Use ordinary TypeScript functions and precise types. A feature provides its
document constructor, boundary parser, limits, and snapshot projection.
Define only the shared interface required by the first two consumers.

The dependency direction is feature code to shared code. The shared package
imports neither Underclerk nor Portal/server code. React bindings live in the
Portal; storage and authorization stay on the server. Feature selection occurs
at the server boundary with an exhaustive discriminated union. Do not move
product commerce knowledge into a shared callback framework.

Each supported feature must supply these concrete contracts:

- Required document identity and schema version, resolved from the route and
  authenticated organisation; field names form a feature-specific closed union.
- Deterministic initial content, bounded update/candidate-state validation, and
  a typed snapshot projection.
- Read/edit authorization, storage initialization, and source revision handling.
- Typed agent operations and any explicit review/apply operation.

Parse raw route, storage, and wire values once at their owning boundaries.
Core operations accept validated types and return discriminated success/failure
results. Connection and save state must distinguish loading, synchronized,
pending edits, disconnected, and blocked states without optional identity bags.

### Server rooms

Extract reusable room mechanics within `services/platform/src/actors/`.
Feature code supplies authorized document identity, storage access, validation,
and initialization from its source. Keep existing product storage usable;
any necessary conversion belongs at its persistence boundary.

- Scope every room by organisation, feature kind, and resource identity, resolved
  through trusted server authority. Browser-supplied IDs grant no access.
- Persist an accepted update before acknowledging or broadcasting it.
- Validate candidate state before committing it, including reconnect updates.
- Reuse existing room serialization and receipt handling for concurrent edits.
- Keep authorization checks on reads, updates, reconnects, and agent operations.
- Apply explicit feature limits for document size, update size, and collections.
- Preserve existing information-flow restrictions on Slack reporting.

Use a closed set of supported feature kinds. Avoid dynamically registered
document handlers and arbitrary client-chosen schema names.

### Initialization, saving, and failure behavior

Initialize once under the room's serialized storage path. Simultaneous first
opens must restore the same persisted genesis document; clients must not seed
independent Yjs copies of the initial text. Missing or unavailable product source
data is an error, never a reason to overwrite an existing draft with empty text.

Retain product document bytes, IDs, schema version, and operation receipts during
extraction. A code move alone does not require a storage migration. New feature
schemas are explicit and versioned. Unsupported versions block editing with a
reload/upgrade explanation; they never reset content or reinterpret stored bytes.

“Saved” means the server has durably accepted all this client's submitted edits.
Receiving another participant's update or opening a socket is insufficient.
If an acknowledgment is lost after persistence, resynchronization must settle
the pending state without duplicating edits. Never silently discard unsent text
on disconnect, storage failure, or rejected updates.

Validate updates against an isolated candidate, leaving accepted room state
unchanged on rejection. Retain the user's local text for copying, show the
reason, and stop automatic resubmission of a rejected update. Recovery restores
the authoritative document explicitly before editing resumes; it must not merge
the rejected Yjs state straight back into the room. Durable local recovery is
outside this MVP, so warn before navigating away with unsaved edits.

Revoked access closes the session and stops delivery as well as editing.
Rooms use hibernatable sockets
([Plan 57](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-57-live-delivery.md), Decision 4), so no room timer runs. A
room checks access on each message. While the room sleeps, the socket sweep
rechecks each socket and closes a revoked one with `access_revoked`: within
90 s when two sockets share the room, otherwise within 5 minutes. A recheck
that cannot run, such as a failed account check write, refuses nobody: the
room closes the socket without a failure, and the client reconnects with its
unsent edits. Reconnection reauthorizes; a blocked client must not retry
indefinitely. Source
deletion or organisation deactivation blocks access without recreating the resource.
Draft deletion, reset, and archive controls are deferred; no tombstone protocol
is needed until those operations are introduced.

Retain P40's bounded update/state/vector sizes, room participant caps, and
presence throttling. Specify new feature field limits alongside its schema.
Room eviction keeps the hibernated sockets and the presence in their
attachments. It clears agent activity, which is in memory. It never discards
acknowledged content or durable agent receipts. An Organisation move or erase
closes every socket with code 1012, and clients reconnect.

### Portal bindings and presence

Extract browser connection and reusable editing controls under a shared Portal
collaboration directory. Features retain their page layout and preview.

Supply text bindings, save/reconnect status, participant colors and names,
carets, lightly tinted selections, idle labels, and workspace pointers. Track
the active field so a caret appears in the correct control. Preserve IME input
behavior and relative selection anchoring during concurrent changes.

Presence remains ephemeral. Authenticate identity on the server and clear stale
sessions. A client sends presence only when it changes, and a ping every 30 s.
The runtime answers the ping without a wake. The sweep closes a socket that
was silent for 90 s. A canvas supplies its coordinate conversion for pan and zoom; ordinary
form pages can reuse P40's workspace-relative pointer representation.

Identify presence by connection/session and color by authenticated participant.
Two tabs belonging to one person must not overwrite each other's active field.
Validate selection anchors against the named field. Show an agent cursor beside
the current authorized action target, with an agent label and a short action
label. Anchor canvas cursors to objects and editor cursors to fields or passages.
The cursor follows the target through viewport changes. It must not intercept
human input or move the human's viewport.

Use actual pointer coordinates when an agent controls the UI directly. For tool
operations, the cursor marks the action target. Do not invent pointer travel or
clicks. Clear active cursors when an operation completes, fails, is cancelled,
or loses its current activity signal. Saved receipts remain separate from live
presence. Rendering an email preview must escape plain text.

The canvas and product-description editor render independent named agent
cursors at the current authorized target. The server resolves each name from
the admitted assignment. Default agents appear as Satyr. Duplicate active
calls share one cursor, and completion clears only the matching operation.
Email rooms carry field-specific activity; the current Portal has no mounted
shared-email editor. The menu remains human-authored with agent reads.

The [completion evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/README.md) records
custom procedure grants, concurrent named cursors, terminal cleanup, denied
edits, human override, and exact receipt replay after actor eviction. A slow
model journey verifies direct edits after the first 30 seconds of a turn.
These local journeys use controlled provider responses. Live results are
recorded separately in the same evidence directory. On 17 October an exact
duplicate canvas operation in production returned its original receipt and
changed nothing. The same ID with different input, or the reuse of an accepted
agent operation ID, returned `operation_conflict`.

Preserve local editing history behavior during extraction. If undo is exposed,
scope it to local user operations; it must not reverse another user's or an
agent's accepted changes. A new shared history UI remains deferred.

### Agent and review integration

Reuse the same durable acceptance path for humans and agents. Expose typed,
feature-scoped reads and bounded edits through existing tools. Preserve operation
identity and receipts so replay cannot apply the same logical edit twice.

Keep P40's exact-passage editing behavior for text. Reject ambiguous or stale
targets with a request to reread. Later structured edits address stable record
IDs. Do not give agents an unrestricted whole-document replacement operation.

A reviewed snapshot contains the exact saved content and source revision needed
by its feature. Continued collaboration cannot silently change an already
reviewed proposal. Apply validates the proposal through the existing domain
path and reports application separately from notification delivery.

The module does not grant publishing rights, weaken Slack destination checks,
automatically retry interrupted assignments, or infer authority from presence.

Agent reads return document identity, a server-issued snapshot revision,
observation time, and saved content. Edit inputs identify the field, exact
passage, replacement, expected snapshot revision, and existing operation ID.
Authorize the caller, then check the receipt before checking the revision under
the serialized mutation path. A repeated ID with different input fails. A stale revision asks
the agent to reread; it never overwrites intervening human edits. Use the existing
revision mechanism where available; a Yjs state vector alone is insufficient to
identify content because deletions can change content without advancing it.

An empty target passage is allowed only to initialize an empty field against the
expected revision. All other replacements require exactly one matching passage.
This makes a newly created email editable by an agent without granting arbitrary
document replacement. Interrupted or late operations retain existing lease,
deadline, and recovery checks before committing.

Freeze review snapshots on the server from durably accepted content, after the
requesting client's pending edits settle. Return the exact snapshot for display.
The snapshot may include another participant's newly accepted changes; the user
reviews that returned content. A failed source-revision check requires a fresh
review. Email review is an ephemeral inspection of a saved snapshot and carries
no approval or sending authority.

## Content modeling

| Content         | Initial representation                    | Feature responsibility                   |
| --------------- | ----------------------------------------- | ---------------------------------------- |
| Editable prose  | A named `Y.Text` per field                | Text limits and editor behavior          |
| Scalar settings | Fields in a `Y.Map`                       | Allowed values and conflict expectations |
| Items or blocks | Records keyed by stable IDs               | Deletion and reference validity          |
| Images          | Asset references and crop settings        | Upload/storage and valid crop geometry   |
| Ordered content | Explicit order associated with stable IDs | Concurrent reorder semantics             |

Mutate individual fields and records. Avoid serializing and replacing the entire
document after each form edit. Yjs convergence does not guarantee a valid graph,
a unique menu ordering, or a safe publishable result.

Do not assume array delete/insert operations provide intention-preserving moves.
Choose the simplest ordering representation when implementing the menu slice
and demonstrate simultaneous moves of the same item. Each live item must render
once, with a deterministic result. Document the chosen behavior before shipping.

## Delivery sequence

### 1. Extract and preserve product drafting

- [x] Extract shared primitives, room mechanics, and Portal bindings from P40.
- [x] Keep product schema, initialization, Slack tools, and governed apply owned
      by the product feature.
- [x] Preserve existing saved product drafts and receipt replay behavior.
- [x] Demonstrate the migrated product editor with two browser sessions and an
      authorized agent edit. Show reconnect, persistence, and unchanged review/apply.

Acceptance: the existing P40 operating path works through shared code with no
duplicate legacy implementation. No new product capability is required here.

### 2. Prove reuse with email drafts

The first email surface is one active draft per organisation at a stable Portal entry
point. Resolve its singleton resource identity on the server. Initialize three
empty text fields on the first authorized edit/open; read-only access reports
that no draft exists until then. Persist it in feature-owned OrganisationActor storage.
Multiple campaigns, a draft list, recipients, scheduling, and sending are deferred.

Use the existing merchant operator read/edit permissions with an explicit mapping
for this surface. Slack access requires explicit sharing with the destination
Case/thread through the existing authorization and information-flow mechanism.
Organisation membership alone must not make email content readable from any channel.
Generalize the product-specific sharing path only as needed for this consumer.

- [x] Add one organisation-scoped email draft containing plain-text subject, preview
      text, and body. Use existing access patterns and keep recipients outside it.
- [x] Add an editor and simple preview using shared bindings and presence.
- [x] Define field and aggregate limits, persist the email record, and provide
      the stable Portal entry point and authorized Slack sharing control.
- [x] Add authorized agent read and exact-passage edit operations for these fields.
- [x] Show two users editing different fields and the same field concurrently,
      with one agent contribution visible to both users.
- [x] Reload and verify the accepted draft is restored. Reconnect an open page
      with unsent edits and verify convergence.
- [x] Support a frozen review snapshot. Sending email remains outside this slice;
      no fake send action or new campaign delivery integration is needed.

Acceptance: the email feature defines its shape, UI, access, and operations
without copying the product transport, room persistence, or presence code.
This completes the first reusable-module MVP and is a user testing checkpoint.

### 3. Add the smallest structured menu draft

- [x] Add one café-menu page with shallow sections, stable item IDs, product
      references, display text, and ordering.
- [x] Reuse shared synchronization and presence; introduce collection bindings
      only where this editor demonstrates a need.
- [x] Demonstrate concurrent edits to different items, simultaneous reorder,
      and an item deletion racing with an edit. Record the visible outcome.
- [x] Keep authoritative product data separate from presentation overrides.
- [x] Export validated builder-handoff snapshots. The board and release
      consumer remains proposed in Plan 40B, the collaborative menu editor.

Acceptance: the same module supports both text forms and structured authoring.
This follow-up does not block shipping the email/product MVP.

## Later consumers

Product titles, tags, ingredients, marketing copy, support reply drafts,
operational notes, agent plans, and analytical narratives can adopt the text
and record bindings. Dashboards and workflows add feature-specific structures.
Comments need stable targets and deletion behavior when first introduced.

Agent-generated code needs its own isolated execution, checked changesets, and
revision-specific previews; Plan 40B runs no generated code. Shared source text
alone does not make concurrent code changes correct or executable.

Persistent offline storage, application caching, rich-text editing, history UI,
branching, mobile/desktop clients, and Rust/Yrs integration remain separate
follow-ups. Do not create abstractions for them in this implementation.

## Verification and completion

Make each operating path work and demonstrate it before expanding tests.
Retain relevant existing P40 tests. Add focused behavioral coverage for the
second document shape and the explicit acceptance conditions below. Avoid
source-text policy tests and generic test frameworks.

After the live path works, demonstrate these cases using focused existing test
helpers; combine cases where practical:

- Simultaneous first opens produce one initial document without duplicate text.
- Lost acknowledgment followed by reconnect restores saved status without loss.
- Rejected or oversized updates leave accepted content unchanged and expose a
  usable recovery path without endless resubmission.
- Cross-organisation, wrong-feature, revoked-session, and unshared Slack reads/edits
  cannot access the document; unknown schemas cannot silently reset it.
- A stale agent edit fails safely; identical receipt replay changes nothing;
  conflicting input under the same operation ID is rejected.
- Review with pending edits waits for durable state; later edits leave the
  reviewed snapshot unchanged and stale product publication requires rereview.

Use targeted static fixtures for invalid feature/field and lifecycle combinations
introduced by shared types. Keep existing storage/replay fixtures that protect
saved P40 documents. These checks validate the explicit contracts above rather
than creating a general collaboration certification suite.

Run the narrow affected package tests, platform source/test type checks, Portal
build, relevant draft end-to-end tests, and `git diff --check`. Governed-action
changes require the repository's commerce lifecycle checks; keep those changes
out of the extraction unless needed to preserve the operating path.

The module MVP is done when product and email drafting share synchronization,
persistence, presence, and agent mechanics; both are demonstrated live; P40
review/apply still works; and no obsolete duplicate path remains. Record actual
verification and remaining limitations in implementation evidence. Merge,
deployment, and additional feature conversions are separate release decisions.

## Implementation evidence

Implemented and merged into `dev`:

- `packages/collaboration` owns bounded Yjs encodings, wire primitives, plain-text
  changes, and relative selections.
- Product descriptions and the three-field email editor use one Portal text
  collaboration client and one server room implementation. Both render
  authenticated participant colors, carets, selections, and workspace pointers.
- Email drafts persist in OrganisationActor storage, expose revisioned exact-passage
  agent reads/edits with replay receipts, require an explicitly connected Slack
  Case/thread, and freeze saved review snapshots without granting send authority.
- Café menus use shallow stable records, atomic `sectionId@order` placement,
  deterministic rendering, shared presence, native drag/drop, and a frozen
  builder-handoff snapshot. Product IDs remain references rather than copied
  authoritative product data.

The review fixes use one Content Studio navigation blocker for both editors.
Menu item names and descriptions use nested `Y.Text` with passage-level edits.
Menu schema v2 and protocol v3 can synchronize any accepted 768 KiB state, including
base64 and state-vector overhead. The v1 storage migration was retired after
the 2026-10-01 stored-draft audit found no remaining legacy menu state; see the
[retirement evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40C-menu-v1-retirement-2026-10-01.md). Slack assignments
are message-scoped within the shared thread Case, so a settled assignment does
not prevent a new read/edit request and delivery retries retain their identity.

Targeted verification completed on 2026-09-11:

- Shared, product, email, and menu CRDT suites: 42 tests passed, including
  same-description passage merging and a full-size menu sync frame.
- Harness tool catalogue: 20 tests passed, including direct and Code Mode email
  draft reads/edits and deterministic operation IDs.
- Product-description worker journey: 7 tests passed after extraction.
- Email/menu worker journey: 3 tests passed, covering concurrent email fields,
  agent replay/conflict/stale-revision behavior, frozen snapshots, structured
  menu persistence, 200-item reconnect after eviction, and the v1 storage upgrade.
- Isolated Chrome checks passed for email-only, menu-only, and both-editor
  unsaved navigation, keeping local text, and leaving with fully saved drafts.
- Full platform unit suite: 2,273 tests passed with 3 skipped; 2 files were
  intentionally skipped by the existing suite.
- Platform source/test TypeScript checks, Portal production build, documentation
  checks, and whitespace checks passed. The collaboration editor remains a lazy
  Portal chunk, so Yjs is not added to the initial dashboard bundle.

Persistent browser storage, application-shell offline caching, rich text,
history UI, comments, email delivery, generated storefront code, and public
menu/storefront release remain intentionally outside this module. Release live
acceptance remains open. The [1 October repeat](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40C-live-acceptance-2026-10-01.md)
verified local two-connection convergence and reload persistence after a supported
organisation schema upgrade. A same-revision observation comparison defect was fixed
and 11 rejected catalog deliveries were recovered, restoring the missing product
projections. Local product approval still reports unavailable action authority.
The deployed Plan 39 lab repeat reached Urk through real Slack ingress and
connected the acceptance thread, but draft reads failed. Its organisation registry
remains at schema 7 while collaboration requires schema 10; the supported
upgrade is blocked by the unavailable production admin credential. Live
human/agent concurrency and draft receipt replay remain unverified.
Repeat the full two-window human/agent, reconnect, receipt replay, and governed
product apply journey against the selected sandbox before deployment.

The 17 October production repeat in Nini Corp is partial; see the
[Slack draft record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/production-slack-draft.json).
The Ginger Cookie draft synced, Slack replied once, and the owner connected
the thread. The agent edit failed because the organisation policy disables the
draft-edit capability and no grant gives a Slack turn the draft tools. The
agent had no way to ask for that permission. The owner stopped the journey;
access settings, approval and apply were not changed or attempted.

An agent without a needed permission now asks for it instead. A Slack turn is
offered `request_permission` for the Satyr reads and draft edits it lacks. The
thread gets one notice with a Portal link; an owner allows it on the Access
page, and the request continues in the same thread with the requester's current
authority. Send for approval offers the propose grant in the same dialog. The
local journey passed; the production repeat of the product journey is next.

On 18 October the permission request passed in production for the draft edit
capability. The continued turn still could not read the draft: a Slack
channel turn reads commerce records only under a grant for that channel. A
request can now also ask for the Product read. In a channel it asks for a
channel grant and a grant for the requester's role, because the edit writes
product text into the member's draft. A denied draft read raises the request
by itself. The local journey passed.
Production gates 1 and 2 wait for the Slack route that failed after the
Plan 72 release; see the
[evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/README.md).

A Portal chat agent now asks in place too. The chat pauses on the request,
the owner or an admin allows it in the same modal, and the step runs again
with the new tools. A member who cannot allow gets a link to send. The local
journey passed; the release needs a rebuild of the request table.

On 20 October, gate 2 in the Satyr workspace found a gap. A new workspace
keeps "Propose governed commerce actions" switched off, and Send for approval
then answered with a bare refusal instead of the prompt. The policy reports a
switched-off capability as outside its allowed tools, and only a missing
grant raised the prompt. Now both raise it, and the prompt switches the
capability on before it adds the grant. Journey
`tests/e2e/commerce-propose-permission.test.ts` (evidence
[`propose-permission-journey.json`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/propose-permission-journey.json))
fails with the bare refusal on the earlier code.

The next try of gate 2 failed with `commerce_action_connector_unavailable`.
The Satyr workspace saved its setup before setup saves bound the Slack
channel, so #cafe-ops was in its setup but bound to no connection, and the
approval had no channel to wait in. Send for approval now binds the setup's
channel to the workspace's own active Slack connection when no active
connection holds it, as a setup save does, and records the binding in the
Slack routing audit. Journey
`tests/e2e/commerce-propose-unbound-channel.test.ts` (evidence
[`unbound-channel-journey.json`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/unbound-channel-journey.json))
fails with that refusal on the earlier code.

With both fixes released, gate 2 passed in production on 20 October: the
owner allowed the prompt, approved with Google, and the applied description
reads back at product revision 2 with an Underclerk receipt
([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/production-gate-2.json)).

Gate 1 passed in production on 21 October in the Satyr workspace. In a new
#cafe-ops thread, the agent asked for the draft permissions, the owner allowed
them in the Portal dialog and connected the thread to the Ginger Cookie draft.
The agent then replaced one passage. The open Portal editor showed the named
cursor "Satyr · Edit description", then the new text, then no cursor, and the
thread got the receipt reply. The published description stayed at revision 2
([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/agent-cursor-completion/production-gate-1.json)).
The run found one fault, fixed and released the same day: a degraded Slack
account could never pass its health check, so Slack replies stayed refused
until a reconnect. It also left two gaps: a connected thread did not tell the
agent its draft's product id, and an unknown id read as "Authoritative data is
unavailable". Both are closed: the draft read takes no product id in a
connected thread, and an unknown id gets a message that says how to correct
it. The change is live since 21 October, and a new connected thread read its
draft without a product id in production on 22 October.

The gate 1 Allow came while Slack was degraded. The decision was stored, but
the route answered 503 and the asking thread never got it, so the Portal
dialog kept spinning. Nothing continued it when Slack recovered; a repeated
Allow released it about two hours later. Now an Allow that Slack cannot take
succeeds in the Portal and says that the request waits for Slack. The
decision keeps `released_at` empty, and the scheduled reconciliation hands it
to the thread right after the Slack check that finds Slack working again.
It is in production since 2026-10-22 05:22 UTC (`satyr-edge` `08851340`
from `9207632f2`). `scripts/agent-permission-request-released-at-d1-patch.sql`
ran on `satyr-organisation-apac` first and marked the three decided requests
as released.

The Workers Logs show why the late resumed turn failed. The Portal posted
the Allow at 11:06:18 and 11:06:55 UTC; both answered 503. At 13:13:51 UTC a
repeated Allow released the request, and the turn ran in the thread's
Session for the owner's refreshed authority. That Session had already run the
gate 1 retries, and the workspace AI budget gives a Session 180 seconds of
active model time in total (`maxWallMs`). The turn stopped after 23 seconds
with `session_budget_exhausted:active_wall_ms`, and Slack showed only the
generic failure text. A raised budget does not reach a Session that exists,
so that thread could not run another turn.

Since 2026-10-22 08:39 UTC (`satyr-edge` `7b800347`) the time limit applies
to each request, a thread that used its tokens gets a notice with a link to
raise the budget, and a failed request no longer stops its thread. See
[Plan 35B](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-35B-workspace-ai-session-budgets.md).

## Information-flow contracts

Moved from the IFC integration guide
(`services/platform/src/policy/information-flow/README.md`) on 2026-10-19.
Code paths are under `services/platform/src/`, and test paths are under
`services/platform/tests/`. Record this plan's information-flow contracts here.
Change the guide only when the kernel, a sink, a rule for every surface or an
entry point changes.

A Portal chat agent drafts a Slack message with `slack_message_propose`. The
tool needs the `slack.message.propose` grant on the exact Slack account, scope
`channel_message`, and its turn label must pass the `tool_effect` sink of that
capability with approval not satisfied, as for an operational email
(`authorizeToolEffectInformationFlow` in `actors/agent-session.ts`). The draft
goes only to a channel that the Organisation connected
(`slack_channel_default`). An unknown channel is refused without naming the
connected ones, because their names have not entered the turn. The draft row
(`slack_message_proposal`, regional) holds the text with the chat's Case, as
the chat timeline holds the turn's reply. `control/routes/chat-slack-messages.ts`
reads, edits, discards and sends a draft only through a conversation that the
person can open (`conversationCaseIdentity`); a draft of another Case answers
as a missing one. Send posts the exact version and text that the person saw,
through the Connector's `slack_channel` delivery, which checks the connected
destination again. The delivery key is the draft, its version and its channel,
so a repeated Send posts at most once; a Slack refusal advances the version.
The allowed and denied journey is `e2e/slack-message-draft.test.ts`.

A Slack permission request (`request_permission`) creates no new source and
stores no model text. The request row holds catalogue capability ids, closed
record-type ids, the requester's role and request authority, and the Slack
thread identity. The model names capabilities and record types from closed
lists. Satyr adds a record-type read when a draft tool's source read is
denied, or when a requested capability edits a draft of that type, and keeps
only the reads that the requester lacks. In a Slack channel a record-type read
asks for two grants: one for the channel, because a channel turn's commerce
reads admit only conversation grants, and one for the requester's role,
because a draft edit discloses the record to the editing member. The thread
notice is fixed platform text with catalogue labels and a Portal link, and so
is the decision notice. The Portal view reads the same fields. An allow is
checked with the existing grant compiler and the draft tools' source-grant
selector against the stored authority, not with feature-local grant matching.
A Portal chat step may ask too, under the member's `control` authority; the
chat binds the step's Session in `session_turn_access` first, and only such a
Session is offered the tool. The chat then pauses on the stored request, and
the step's answer is not delivered. After an owner or admin allows the
request, the step runs again under a new lease and compiles its authority
again. The continued turn is the asking turn's
Case work again, with the person's own authored text after a fixed preface; it
compiles its authority and checks the live requester again when it runs, so a
policy or grant change in between applies to it.

A Portal chat step that only a disabled capability denies pauses the run in
`awaiting_permission` with a `ChatPermissionRequest`. The Portal opens a permission
dialog. Allow enables the capability through the Access route and resumes the run;
Deny stops it. The resume runs the paused step again under a new lease, because
the old lease's completion was accepted under the old authority. Source and
audience denials still fail the run.
