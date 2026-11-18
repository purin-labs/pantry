# Plan 42G — Automatic agent context loading

Status: **Complete; production Pi and Codex acceptance passed.**
The Actor and browser gates pass, including Pi/Codex interruption recovery and
preservation of chat and unsaved page work. Both real routes pass signed-in local
reads and automatic reveal/control. Production Pi acceptance passes in two
existing workspaces. The canary Access projection has been repaired, and a real
local Codex saved-context read succeeds at 0% included allowance with credits.
Representative synthetic demand acceptance now passes with quantities, partial
fulfillment, cancelled demand and an explicit recipe assumption. The production
ChatGPT workspace is active after receipt-replay and
credential-recovery fixes. After the operator refreshed authorization and approved
Pta's workspace read access, production Codex reads the exact saved run while
Integrations stays visible. Automatic reveal passes with one preparation, three
commands and both unsaved drafts preserved. The confirmed context chip reports
the saved source and revision. The authorized saved-read takes 1,354 ms; the full
Codex turn takes 42,021 ms at 0% included allowance with credits available. See the
[implementation evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01.md).
The preparation follow-up reuses fresh command-confirmed readiness within a request.
Pi/Codex recovery and refresh E2Es pass; a real connected local Codex request
performs three browser commands with one preparation while preserving unsaved work.
Updated: 2 October 2026.

## User outcome

Start chat from any page in the current workspace. Ask a question once. The agent
loads the authorized AgentCommerce, CafeOS or BakeryOS information it needs and
continues the same task. The compact context chip explains its working context.
The user need not know which screen exposes a particular tool.

Example: “Check tomorrow's orders against bakery capacity.” The agent reads
orders, loads the relevant production definition or run, compares the two and
identifies assumptions. Inspecting this data should not require opening a camera
or launching physics. “Show that batch and simulate its transfer” can require the
browser workspace. Loading a context never executes that simulation by itself.

## Constraints recorded before implementation

- The conversation submits an optional BakeryOS attachment with the user input
  (`services/platform/src/chat/application.ts`). It is a browser observation,
  not authorization.
- `AgentSessionActor` selects BakeryOS commands from that attachment's supported
  commands. Catalog selection also participates in the harness checkpoint binding
  (`services/platform/src/actors/agent-session.ts`).
- The portal registry holds a mounted surface per organisation, and the effect bridge
  polls while that surface exists (`apps/portal/src/features/bakery-surface-registry.ts`
  and `bakery-surface-effect-bridge.tsx`). An absent view cannot currently be
  activated by the agent through this bridge.
- The new chip displays current view/attachment state and pending tool destination.
  It is not yet a durable model of loaded contexts. Tool activity is evidence of
  tool use, not proof that a whole product context has been loaded.
- AgentCommerce, CafeOS and BakeryOS are product areas within a workspace. Their
  labels must not become new authorization boundaries or separate agent runtimes.

## Architecture decision

| Approach                                                           | Benefit                                                                           | Cost / limitation                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Attach every context and mount every surface at chat startup       | Few activation transitions                                                        | Prompt growth, unnecessary data reads, browser/physics cost, stale observations         |
| Classify each message before the main agent runs                   | Simple initial routing                                                            | Extra model call or brittle keyword rules; poor fit for multi-area tasks and follow-ups |
| Let the existing agent discover and load bounded context on demand | Uses task understanding, supports multiple areas, loads only relevant information | Needs a typed activation/continuation path and confirmed browser readiness              |

**Selected direction: on-demand loading by the existing agent.** Reuse the
current tool catalog, authorization and delivery mechanisms. Do not introduce a
router agent, another inference service, a generic plugin framework or a second
context store.

## Design boundaries

### Workspace scope stays fixed

The server supplies organisation/workspace/operator scope from the accepted request.
The model selects a product area and, when necessary, an observed record/run ID.
It cannot supply another organisation, impersonate an operator or widen grants. Ask for
clarification when the shop or target run is ambiguous. A product-area change
within the same workspace is distinct from changing organizations.

### Discovery, data and browser activation are different operations

Expose a small availability summary through the existing discovery path. It names
supported areas and what they can do without reading all their records. Availability
must come from installed capabilities and current grants, not a new hand-maintained
manifest that can drift from the tool host.

Reuse the existing domain read tools first. Do not add `workspace_context_load`
as a generic dispatcher: commerce queries, granted-file reads and versioned
workspace-file queries already have distinct authority and provenance boundaries.
Add a narrowly scoped saved-bakery-data read only where an existing tool cannot
express it. Browser activation needs an explicit protocol, separate from data reads.

- **Server data:** use existing authorized queries for records, saved definitions
  and accepted results. Return bounded summaries with source IDs/revisions and
  provenance. Do not read all customer orders or embed entire recordings.
- **Browser surface:** request activation only for unsaved browser state, visual
  navigation, camera control or browser simulation. Reuse the existing view and
  effect delivery; do not create a hidden duplicate simulator.
- **Execution:** the actual requested edit/simulation/save remains a separate
  governed command after context is ready. Approval requirements remain intact.

A task may retain both commerce and bakery findings. “Active context” means the
current operation; “loaded sources” means the bounded observations retained for
this task. Switching the active area must not erase relevant accepted findings.

### Continue the same accepted request

Model context preparation as an explicit lifecycle in the current conversation /
Actor workflow: requested → preparing → ready, failed or cancelled. Successful
preparation carries exact source identity and revision; browser readiness also
carries the initiating browser binding, surface session and epoch. Non-ready
states must not carry an executable surface target.

Preparation owner: `AgentSessionActor`, through its existing tool/effect lifecycle.
The chat application projects progress and preserves its request/lease; the portal
executes the requested view activation and reports readiness. Neither adds an
independent retry controller. The browser reports readiness, never authority.
Recovery through an interrupted provider tool call remains an implementation proof
gate; an in-memory wait alone is insufficient.

Suspend/resume through the existing checkpoint/continuation machinery. Do not
resubmit the user's message, replay completed writes or manufacture an assistant
message to trigger another turn. Keep the pinned Pi/Codex funding authority.
G1 must prove continuation with a stable authorized catalog on both harnesses.
If a catalog transition is unavoidable, prove its checkpoint binding and explicit
durable step boundary before proceeding; never bypass digest validation.

### Browser ownership and recovery

The organisation-keyed registry alone is insufficient to target a particular initiating
tab. Bind activation to the conversation/request and browser instance; never let
another tab acknowledge it accidentally. Fence late readiness and results when
chat closes, the workspace changes, the request is cancelled or access is revoked.

On refresh, reconcile the existing activation identity and recapture the actual
surface. Never restore an executable attachment solely from a historical chat
snapshot. Use existing receipt/idempotency machinery; no duplicate simulation or
save may result from delivery retries. A missing browser should produce a bounded,
recoverable result rather than waiting forever.

Respect context the user explicitly excluded. Clarify or offer a contextual
“Open BakeryOS” action if the requested operation cannot proceed under that choice.
Such actions appear only for a specific blocked request, never on chat startup.

### UI follows confirmed state

Keep the selected compact workspace chip and fixed shop identity. Show preparation
as “Loading BakeryOS…”, ready as the active area, and expandable source details.
Record context changes in the existing activity timeline. Report stale, unavailable
and excluded sources explicitly. Never infer successful loading from prose, URL
navigation, a tool label or the mere presence of a component.

**Confirmed product decision:** server data reads leave the current page alone.
When browser controls require BakeryOS, automatically reveal its existing view,
preserving chat, its draft and unsaved work. If activating a requested run would
replace unsaved work, use existing operator review. Revealing a view does not
authorize starting simulation, accepting a candidate or saving changes.

Preservation must include the page being left as well as BakeryOS. Audit component
unmount behavior before wiring navigation. Prefer existing draft ownership; if a
page cannot safely survive the transition, pause that activation for recovery
instead of silently discarding its state or mounting a duplicate application.

## Architecture sweep — 1 October 2026

This is a source review of the current shared checkout, including concurrent
uncommitted work. It establishes ownership and design constraints; it is not live
acceptance of automatic loading.

### Existing owners and storage

| Concern                             | Existing implementation                                                                                                                                                 | P42G responsibility                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Agent identity and instructions     | `data/pinned-agent-profile.ts` resolves pinned definition/skill revisions and composes instructions                                                                     | Keep the same installed agent and pinned profile when changing product area                                                      |
| Shared work and evidence            | `actors/case.ts` owns the Case journal, assignments and accepted content; `context/projection/index.ts` builds searchable D1 projections                                | Reuse canonical sources and their visibility; avoid a chat-only evidence store                                                   |
| Initial retrieved context           | `context/turn-context.ts` compiles authority and assembles a bounded bundle; `context/assembly/types.ts` carries revisions, digests, freshness and observation evidence | Reuse provenance and budgets; do not interpret the initial bundle as all data available to the agent                             |
| Context persisted for a turn        | `actors/actor-journal.ts` stores `session_turn_context`; `actors/model-context-prompt.ts` renders bounded evidence                                                      | Preserve the accepted turn input; new tool observations enter accepted history rather than silently rewriting the initial bundle |
| On-demand business reads            | `context/assembly/commerce.ts`, `context/files/tools.ts`, `actors/harness-tool-catalog.ts`                                                                              | Use existing commerce/file authority and observation paths; add only missing domain reads                                        |
| Execution and recovery              | `actors/agent-session.ts`, `agent-session-harness-authority.ts`, `agent-session-harness-checkpoint.ts`                                                                  | Actor owns tool execution, accepted history, budget, cancellation and checkpoint recovery                                        |
| Provider state                      | `actors/pi-embedded-adapter.ts`, `actors/codex-embedded-adapter.ts`                                                                                                     | Keep provider state subordinate to Actor-owned history and the pinned model/funding route                                        |
| Chat presentation and orchestration | `chat/store.ts`, `chat/application.ts`, `chat/execution.ts`                                                                                                             | Preserve conversation/draft/request identity; project activation progress without a second agent loop                            |
| Browser operations                  | `actors/bakery-surface-effect.ts`, portal surface registry and effect bridge                                                                                            | Extend existing dispatch, deadlines, receipts and reconciliation to preparation before mount                                     |
| Versioned files                     | `workspace-revision-store.ts` and `workspace_query`                                                                                                                     | These are immutable file revisions, separate from the visible product area                                                       |
| Durable merchant memory             | `data/merchant-memory.ts` retains persisted shapes while runtime access is deferred                                                                                     | Do not revive memory as a prerequisite for context loading                                                                       |

Source paths above are relative to `services/platform/src`, except the portal
registry/bridge in `apps/portal/src/features`.

The turn assembler currently limits retrieval to 12 items, 2,048 estimated tokens
and 250 ms, with a freshness bound. Its source union covers Case entries and
integration-file segments. Business records already have a separate typed query
path. Avoid forcing every domain record into the retrieval index just to support
the context chip.

### Findings that change the implementation direction

1. **Context loading already exists for server data.** `commerce_entity_context`,
   `commerce_merchant_report`, `file_search`, `file_read` and `workspace_query`
   are selected through the shared harness catalog. The last tool reads/searches
   versioned files; it is not an area-switching API. Product labels should remain
   presentation metadata over real capabilities.
2. **Browser readiness currently determines tool visibility.**
   `selectCatalogDefinitions` selects BakeryOS tools from attachment-supported
   commands. `executeBakerySurfaceForHarness` also captures the original surface
   in its authority binding. Mounting a component later cannot update either by
   itself. Both selection and execution binding need deliberate changes.
3. **Catalog changes already have a recovery behavior.**
   `selectRuntimeForHarnessCatalog` selects `fresh_lineage` when the restored
   catalog digest differs. Accepted history is materialized for the adapters.
   This is a start/restore path, not evidence that a running provider call can
   hot-swap tools. Do not build P42G around that assumption.
4. **Effect delivery has useful durability already.** Bakery effects persist
   dispatch/settlement, publish a delivery projection, reconcile receipts and
   enforce deadlines. The browser bridge requires a mounted surface and polls by
   surface session. Preparation must reach the initiating portal before mount;
   retain existing session/epoch fencing for subsequent commands. The in-memory
   browser ledger alone does not guarantee exactly-once work across reloads.
5. **Chat has an existing multi-step loop.** `runConversation` maintains a user
   request/lease and derives step-specific Case request IDs. This is not a free
   resume API: starting another step re-enters Case processing with the current
   user input. Prefer the pending Actor tool/effect path; prove recovery instead
   of adding a hidden resend through this loop.
6. **Saved bakery data has server storage already.** `control/routes/bakery-runs.ts`
   lists/reads snapshots from R2. Reuse its storage/parsing boundary through an
   authorized domain read callable by the Tool Host. Do not invoke portal HTTP
   routes with synthetic control credentials, duplicate the store, or require a
   browser just to read a saved run.
7. **The chip currently infers its label.** `features/chat/context.tsx` uses a
   pending tool destination or page area. Replace that inference for loaded-state
   claims with a projection of accepted observations and readiness receipts.
   Retain “Current view” as separate navigation information.

### Preferred small change

Expose a bounded set of authorized BakeryOS operations independently of whether
its view is mounted. A browser command resolves an Actor-owned preparation effect
when necessary, waits for the exact portal readiness receipt, then validates the
current supported command and surface target before executing through the existing
effect path. Availability never grants execution authority. Keep preparation and
command receipts separate so “view ready” cannot mean “simulation completed”.

This stable-catalog approach is a recommendation to prove on both harnesses. If
it requires catalog changes, use a durable supported boundary and accepted history;
never weaken checkpoint digest validation to make continuation work.

Only these additions appear necessary: a missing bounded saved-data read, typed
browser preparation and target binding, portal activation handling, and confirmed
state projection for the chip. Reuse existing lifecycle owners. No ContextActor,
product-specific agent runtime, global context database, or generic router is
proposed. Extract small cohesive functions where touched code is hard to follow;
avoid bundling an unrelated Actor rewrite into this work.

## Scope and defaults

- Operate within the accepted organisation, workspace, operator and grants. Cross-shop
  switching and delegation to another agent are outside this plan.
- Load specific records, saved runs and bounded observations using existing tools.
  Keep accepted findings in existing history; re-read changing data when freshness
  matters. Do not introduce a separate retention or memory subsystem.
- Prefer an explicitly named run or the confirmed attached selection. Ask when
  multiple candidates remain; never pick an arbitrary latest run for a mutation.
- Automatically reveal the existing BakeryOS view only when browser operations
  require it. Preserve chat, composer text, attachments and unsaved page work.
- Explicit context exclusion persists until the user changes that choice. A
  relevant blocked operation may offer a contextual action; startup shows none.
- A request without an eligible browser can still perform authorized server reads.
  Browser operations return a bounded actionable unavailable result.
- Physical execution/calibration, standalone recording attachment parity, combined
  two-cell spatial rendering, new schedulers and provider fallback are outside 42G.

## Implementation sequence

G1–G4 are implemented and verified through deterministic runtime/browser journeys.
G5 remains the completion gate for the real operator journeys listed below.

### G1 — Prove shared ownership and continuation

Primary files: `services/platform/src/actors/agent-session.ts`,
`harness-tool-catalog.ts`, `bakery-surface-effect.ts`, both harness adapters,
`services/platform/src/chat/application.ts`, and the portal surface bridge.

- [x] Trace one portal request through Case admission, Actor tool execution,
      accepted history, cancellation and recovery; record the concrete extension points.
- [x] Select authorized BakeryOS capabilities independently of mounted-view state.
      Revalidate permissions and actual supported commands at execution time.
- [x] Prove a pending tool call can prepare a browser and receive its result within
      the same accepted request on Pi and Codex, including interruption/recovery.
- [x] Define the exact browser binding and refresh reconciliation rules. Bind
      preparation to accepted request/lease, initiating browser and workspace; bind
      readiness to surface session/epoch and the selected source identity.
- [x] Audit unsaved state ownership in the departing page, chat and BakeryOS.
      Record which existing owners survive navigation and the smallest required fix.

Exit: a recorded request/tool/receipt trace demonstrates the continuation contract.
If either harness cannot recover it, resolve that gap in the shared Actor/harness
boundary before building UI around it. Do not add a second request runner.

### G2 — Read saved context without navigation

Primary files: existing commerce/file tools in
`services/platform/src/actors/harness-tool-catalog.ts`,
`services/platform/src/context/assembly/commerce.ts`,
`services/platform/src/context/files/tools.ts`, and
`services/platform/src/control/routes/bakery-runs.ts`.

- [x] Reuse commerce queries for the selected orders and existing file reads where
      appropriate. Derive available capabilities from the authorized catalog.
- [x] Expose the missing bounded saved-bakery read through the same Tool Host.
      Extract shared snapshot storage/parsing from the HTTP route only as needed;
      preserve independent authorization at each entry boundary.
- [x] Return source identity, revision/digest, observed time and a bounded useful
      summary. Keep saved evidence distinguishable from unsaved live browser state.
- [x] Record observations using existing accepted-history and information-flow
      mechanisms. Preserve cumulative source restrictions through final delivery.
- [x] Keep capability descriptions and required behavioral guidance small; do not
      replace the pinned agent profile with a product-specific prompt.

Implemented exit: an identified 1.3 MB saved rehearsal yields a bounded summary
and confirmed source digest before browser preparation. Its settings and saved
recorded-step count remain distinct from physical capacity. The combined selected
orders/capacity comparison on both real routes remains in G5.

### G3 — Activate and control the existing browser workspace

Primary files: `services/platform/src/actors/bakery-surface-effect.ts`, existing
control delivery routes, shared surface contracts, and
`apps/portal/src/features/bakery-surface-effect-bridge.tsx`,
`bakery-surface-registry.ts`, `apps/portal/src/portal.tsx`.

- [x] Extend the Actor-owned effect lifecycle with typed preparation states:
      requested, preparing, ready, failed or cancelled. Only ready carries an
      executable surface target. Use precise unions and exhaustive handling.
- [x] Deliver preparation to the initiating portal while BakeryOS is unmounted.
      Extend the existing delivery path; keep one durable retry/reconciliation owner.
- [x] Reveal the existing BakeryOS view automatically, preserving conversation,
      composer and unsaved work. Reuse mounted state when available; do not instantiate
      a second simulator. Route destructive run replacement through existing review.
- [x] Submit readiness only after capturing the actual surface and validating its
      source/session/epoch against the preparation request.
- [x] Resolve subsequent commands from confirmed current readiness rather than
      the attachment captured at message submission. Retain all command authority,
      candidate, fingerprint and approval checks.
- [x] Reuse existing deadlines, cancellation and receipt reconciliation. Fence
      wrong-tab, old-epoch and late acknowledgements. Reconcile uncertain execution
      before retrying any simulation or save.
- [x] Handle unavailable browser, excluded context and unsafe page departure with
      explicit recoverable outcomes and no silent loss of work.

Exit: a browser-control request from commerce reveals BakeryOS, executes the
requested operation and completes once, without another user-message submission.

### G4 — Show confirmed context in the compact chip

Primary files: existing shared chat timeline/control API, chat projection code,
`apps/portal/src/features/chat/context.tsx` and `activity.tsx`.

- [x] Project preparation and accepted observation state into the existing chat
      stream. Keep it reconstructible from canonical state; avoid a second context DB.
- [x] Show “Loading BakeryOS…” during preparation, the confirmed active area after
      readiness, and a useful failed/unavailable state when preparation cannot finish.
- [x] Keep shop identity and current page distinct from active work. Expand the chip
      to show bounded source details and freshness, including multiple product areas.
- [x] Replace tool-name/page inference wherever it claims context is loaded.
      Reconcile the chip after reconnect; historical readiness cannot imply a live view.
- [x] Keep the existing compact popover, keyboard behavior and activity timeline.
      Show intervention controls only when a specific operation needs them.

Exit: the chip accurately reflects preparation, confirmed reads, active browser
work and failure/recovery without suggesting broader access than the agent has.

### G5 — Acceptance and cleanup

Extend existing E2E journeys. Prefer a few substantial scenarios with fault
injection over many isolated checks. Add no unit-test suite. When shared domain
unions change, add focused compile-time fixtures for invalid state combinations.

| Journey                      | Required evidence                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-area data read         | Selected orders + saved run; unchanged page; no simulator mount; bounded sources and provenance                                              |
| Automatic reveal and control | Unsaved departing-page work and chat draft preserved; exact browser readiness; inspect/playback/camera command completes in the same request |
| Governed simulation          | Existing review/acceptance boundaries preserved; requested simulation and accepted result remain distinct                                    |
| Stop and recovery            | Cancel during preparation; refresh or interrupt delivery; no late execution or duplicated user input, simulation or save                     |
| Two tabs and stale state     | Wrong browser cannot acknowledge preparation; stale session/epoch is rejected; fresh binding recaptured safely                               |
| Authority and exclusion      | Revocation is enforced before execution; excluded context stays excluded; missing browser terminates within its deadline                     |
| Chip reconstruction          | Loading, ready, failed and reconnect states match accepted observations and receipts                                                         |

- [x] Run deterministic E2E scenarios against the shared runtime and portal.
- [x] Repeat the cross-area read and automatic reveal/control flow with real
      signed-in Pi and Codex routes. Preserve each route's funding authority.
      Production acceptance passed on 2 October; see
      [the final acceptance record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01.md#production-acceptance-complete).
- [x] Produce a repeatable artifact in `docs/evidence/`: commands/environment,
      scenario results, request/turn/tool/effect IDs, source revisions, receipt outcomes
      and screenshot references. Exclude credentials and private payloads.
- [x] Run relevant types, changed lifecycle fixtures, portal build and diff checks.
      Run repository-required lifecycle suites where touched behavior requires them.
- [x] Remove replaced attachment-only catalog/binding paths and obsolete fixtures.
      Keep explicit attachments/exclusion as user choices. Avoid parallel old/new modes.
- [x] Review the diff for duplicate stores, retry loops, generic wrappers and
      unnecessary tests. Update this plan with actual results and remaining blockers.

## Implemented ownership and recovery

One portal admission retains its browser binding through the existing Case,
accepted input, harness history, lease and pinned funding route. Installed browser
commands remain in the authorized catalog before mount; actual command support
comes from fresh readiness. Saved reads use `workspace.query` grants and the
existing R2 snapshot boundary. Their observation enters the existing information-flow
journal and accepted tool history, and final delivery retains cumulative restrictions.

`AgentSessionActor` records a continuation obligation in its existing outbox for
browser-capable requests. A direct accepted browser call marks the recoverable
boundary and schedules the Actor's existing alarm. Recovery validates the lease,
canonical history and instruction/catalog/model/workspace/policy bindings, settles
only outstanding calls by their original IDs, and resumes the provider from accepted
history. Pi uses its existing history materialization and continuation operation;
Codex creates an ephemeral native thread from canonical history with no additional
user input. Completed writes are never replayed. Unsupported interrupted programs
retain the existing fail-closed recovery behavior. Browser commands called within
Code Mode return guidance to use a direct call; replaying arbitrary composition is
outside this continuation contract. Server data reads remain available to composition.

The portal owns one lazy BakeryOS view per workspace. Automatic reveal hides the
departing page while retaining its component and draft ownership; the chat stays in
its existing underlay. Returning restores the departing control's focus when needed.
Closing chat hides an automatically revealed view while retaining its unsaved state.
Explicit workspace changes release that view. A session-storage browser identity
survives refresh, and a Web Lock fences cloned tabs. A fresh surface is recaptured;
historical attachments cannot supply an executable target. The browser's existing
receipt ledger now retains settled receipts and uncertain-execution tombstones
across refresh. Preparation and executable-command receipts remain distinct.

The chip reconstructs its loading, confirmed, failed, cancelled and stale states
from existing effect receipts and accepted observations. Product-area labels stay
presentation metadata; shop, workspace and authorization remain fixed.

Implementation review fixed concurrent duplicate delivery, executable-command
conversation fencing, modal-safe reveal, hidden-view shortcuts, immediate epoch
staleness and future-dated readiness. Live acceptance also fixed person grants
being ignored by control authority and generic Case history selecting product
context. The recovery E2Es now include person grants and prior chat history.
Expanded Actor/browser journeys, a fresh real Pi run and signed-in Codex reads and
control pass. Findings and repeatable evidence are recorded in the linked evidence.
Signed-in Pi acceptance subsequently exposed retry admission clearing a separately
saved chat draft. Retry now preserves the draft text and timestamp. The existing
Pi recovery journey injects a provider failure, saves a draft, retries, interrupts
browser preparation and verifies the final draft and single accepted input. Both
provider recovery E2Es pass; the live Pi draft also survives subsequent failures.

## Acceptance history

- Real organisation Codex reveal, inspection and camera control pass through the
  authenticated local operator portal and connected harness. Unsaved departing-page
  work and the chat draft survive. Exact receipts, draft values and unchanged
  persisted budget are retained in the expanded evidence artifact.
- Real Pi selected-order/saved-run comparison and subsequent browser inspection
  pass in 21.2 seconds against synthetic authorized local organisation data. There are no
  browser effects during the comparison, both source observations and exact order
  revisions are committed, cancelled demand is excluded, and native state is
  unchanged. Missing order quantities and recipe mapping remain explicit gaps.
- Local operator read policies and person grants are active. Signed-in Codex
  successfully reads an exact saved rehearsal and current orders while Home stays
  visible, with two confirmed sources and no browser effects. A follow-up in the
  same chat reveals, inspects and sets the camera overhead under one request,
  preserving the unsent draft. The order result is empty, so a representative
  numerical demand/capacity comparison remains open.
- Local catalogue repair is complete: three valid snapshots received missing
  `kind` metadata after hash/schema validation and a reversible backup. Contents,
  sizes, timestamps and object versions are unchanged. The Worker now uses the
  existing dedicated local Codex harness configuration. Two fresh requests list
  all 13 saved runs and read a repaired snapshot without retry, navigation or
  browser effects. Deployed Cloudflare container startup remains a release check.
- A separate signed-in local Pi workspace now contains seven synthetic orders and
  one saved rehearsal. Its comparison reads one active and one cancelled order,
  reports 72 nominal pieces and one recorded tray, retains source revisions, and
  leaves Home visible with zero browser effects. A follow-up automatically reveals
  the sample, inspects it and sets the camera overhead under one Actor turn.
  Existing E2E activation fixtures were used; Slack onboarding was not exercised.
- That live attempt exposed and fixed loss of a separately saved draft during
  manual retry. Both provider recovery E2Es and source/test types pass. The final
  live retry preserves the exact draft timestamp and the unsaved page value
  64,001; the persisted budget remains 64,000 at revision 1. The repeat reveal is
  still open because Kimi/Relace failed before browser dispatch. A fresh chat
  also failed before browser effects after about 92 seconds; its log lacks the
  precise terminal cause. The fresh chat draft and unsaved page value survived.
  Both test-only page edits were cancelled without saving. The subsequent isolated
  candidate Pi 0.99.1 journey closes this narrow gate: its request finishes in
  14.0 seconds, visibly reveals overhead, returns to the unsaved 64,001 page field,
  and preserves the chat draft timestamp. Persisted tokens remain 64,000 at
  revision `1`. Its live preview exposed omitted workflow layout selectors in the
  release assembly; restoring the existing selectors fixes the revealed and retained
  views. Exact evidence is in
  [the candidate live artifact](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/live-pi-candidate.json).
- Production now runs Platform version
  `78ae673e-0e90-4214-bd6b-ac18f7cea2fc`, deployed from release source commit
  `17ec0966cf39a6eed974888fa94f41b66c496921` on 2 October 2026. The isolated worktree
  is based on preceding production commit
  `20a843917d0d4174cfbc98fc27573a712f976ecc`, preserving
  deployed inventory work and Pi 0.99.1 while excluding unrelated concurrent
  changes. The full platform suite (2,424 tests), onboarding closure (51 tests),
  Pi/Codex recovery, real-Pi journey (17.8 seconds), source/test types, portal build
  and Worker production dry-run pass. The
  [candidate artifact](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/release-candidate.json)
  records source hashes, build hashes, receipts and the completed live repeat.
  The shared local primary portal uses the concurrent Pi 1.0 upgrade; the release
  candidate and deployed Worker use Pi 0.99.1.
- Signed-in production Pi acceptance passes in two existing workspaces under one
  Actor request each. Both reveal BakeryOS automatically and confirm overhead
  camera without changing the paused sample or draft. In Nuki, the hidden Access
  field retains 64,001 and returns visibly with that value; its persisted budget
  remains 64,000 at revision 1. The separate chat draft and timestamp survive.
  The test page edit is cancelled without saving. Durable receipts, deployment
  identity and screenshots are in
  [the production artifact](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/production-release.json).
- The deployed Codex container application reports ready with the updated image.
  Both inspected active workspaces use Pi and show ChatGPT as unconnected. Organisation
  Codex startup remains unverified until an eligible account is connected. The
  canary Access aggregate originally returned HTTP 503. Its stored policies included
  one disabled retired capability and omitted five current capabilities. Removing
  the retired record and inserting the missing records as disabled restores HTTP
  200, with all 19 grants and existing policies preserved. The repair does not
  enable an action or change the saved 64,000-token budget.
- The follow-up release preserves credit-funded Codex requests after included
  allowance reaches 0%. Provider credit availability is parsed and persisted at
  the boundary, and the portal labels the meter as included allowance. A real
  connected local Codex request reads two saved sources and completes once in
  20.6 seconds, retaining Integrations with no browser effects. Credit continuation
  and Pi/Codex interruption E2Es pass; account failure still fences the pinned
  connection. The full suite passes after increasing the existing large graph
  fixture's deadline to 60 seconds with its assertions retained. The
  [follow-up artifact](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/credits-and-access-followup.json)
  records the deployed identity, Access repair, live acceptance and measured
  performance observations. Token volume, repeated browser preparation and large
  portal chunks remain profiling leads.
- The saved-read latency follow-up adds `id="latest", cursor=null` to the existing
  `bakery_saved_run_read` tool. The server selects by organisation-scoped R2 save time
  and reads one hash-validated snapshot in one tool call. Identical real local
  Codex prompts complete in 13.2 and 15.5 seconds against a fresh 22.0-second
  baseline; the earlier request took 20.6 seconds. Source resolution/read/validation
  takes 8–10 ms and the authorized read takes 12–15 ms. One catalogue/inference
  round trip is removed, and cumulative input tokens fall by about 37% in these
  trials. Pi/Codex recovery and authorization fences pass. The
  [latency artifact](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/saved-read-latency.json)
  retains timestamps, accepted tool calls, source revisions, tracing and repeat
  instructions. Provider variability and large metadata catalogues remain
  measurement limits; these local trials establish no production latency guarantee.
- The token-usage follow-up bounds retrieved context by UTF-8 size, removes
  repeated Case excerpts and includes connector authoring guidance after fetched
  documentation exists. Native Codex now exposes authorized Satyr tools directly
  and disables unrelated account app/plugin catalogs and native orchestration.
  Its bridge rejects foreign tool namespaces. A fresh real connected local Codex
  saved read uses 20,884 cumulative input tokens, 43% below the post-latency
  average and 64% below the original baseline, with one read and the same source
  revision. An unavailable-tool request completes once with zero calls. These
  counts include cached input; the complete authorized catalog and model base
  context still contribute cost. Recovery, credit continuation, bridge E2Es,
  source/test types and the full suite pass. Source
  `1e6b532f1baa810edd099a593004278259e1a777` is deployed at 100% as version
  `6f4b3f92-b0ef-4695-9b94-43aa5d09af68`. The
  [token artifact](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/saved-read-token-usage.json)
  contains usage, accepted history, native call metadata, byte metrics and repeat
  instructions. Production organisation Codex activation remains an acceptance gate.
- The quantitative follow-up fixes integer attribute serialization at the Actor's
  tool boundary, reusing the commerce API's exact decimal-string representation.
  The existing real-Pi E2E reads three synthetic orders, subtracts fulfilled boxes,
  excludes cancelled demand and reports 120 required pieces, 72 nominal planned
  pieces, five trays and a 48-piece shortfall. It retains both source observations,
  changes no merchant state and performs zero browser effects during comparison.
  Its separate browser follow-up prepares and inspects once. The saved recipe
  mapping is an operator-supplied assumption; physical shop capacity remains
  unverified. The setup checklist also now counts active Slack accounts and fences
  channels belonging to inactive accounts. See the
  [quantitative evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/numerical-demand-followup.json).
- Production organisation Codex acceptance was attempted on 2 October 2026. The
  workspace is active at configuration version 57 with readiness version 15,
  zero blockers and activation receipt
  `activation_receipt_cb6ce0a6-d0fb-4dfc-b6a0-5b5f2ce3ec79`. Queue retry timestamps
  had caused an immutable delivery conflict; the Connector now compares delivery
  intent and reuses its original stored payload. Credential availability failures
  remain recoverable and recheck current authority before sending. Nine commerce
  deliveries settled, with no rejected deliveries. The recovery E2E proves actor
  eviction, inactive-connection fencing, one delivery after restoration, receipt
  reuse and rejection of changed content/destinations. All 2,424 platform tests,
  platform/test/E2E types, portal build and production schema checks pass. Source
  `83a85af4` is deployed at 100% as Worker version
  `f85b1fae-c28c-49ef-833a-8a39e357c2ef`.
- A named paused sample is saved and verified as run
  `19b799e531b51530110223c8b80e8b4385d8c7ddfdd33f4e93da06cdd076ca1b`.
  The production conversation pins `organisation_subscription` + `openai` +
  `gpt-5.6-luna`. Its first request failed with `account_unavailable` before tool
  execution; Integrations remained visible and zero browser effects were created.
  After the operator refreshed authorization, connection revision 2 admits
  production Codex at 0% included allowance with credits available. Automatic
  reveal/control passes in one request with one preparation, three commands,
  confirmed overhead and both drafts preserved on return to Access. The saved-read
  correctly reports its missing `workspace.query` capability. The Pta member grant
  was approved and saved, and the corresponding read policy is enabled. The
  successful latest saved-source read confirms the exact fixture, three batches,
  six configured trays and zero native evidence with no browser effects. The
  [production Codex artifact](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42G-automatic-context-2026-10-01/production-codex-acceptance.json)
  records deployment, activation, recovery, failed attempts, both passing production
  journeys, source revisions, timings and screenshots. Physical robot acceptance
  remains deferred outside this plan’s accepted software scope.

## Completion criteria

42G is complete when one request can read authorized cross-area data, activate the
existing browser view when needed, continue through the same Actor-owned execution,
and show confirmed context in the chip. Chat and unsaved work survive automatic
reveal, and recovery does not repeat accepted operations. Both real provider routes
must pass the core journey; unavailable credentials leave that acceptance gate open.

[42E](plan-42E-chat-canvas-parity.md) and
[42F](plan-42F-general-orchestration.md) remain closed at their reduced software scope.
This plan does not reopen their deferred physical or exhaustive-parity work.
