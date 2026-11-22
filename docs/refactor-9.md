# Refactor 9 — General Projects with Cases

Date: 2026-10-05.
Status: released on 2026-10-08. Implementation started on 2026-10-07 at the user's instruction.
Every Organisation has a default Project, every Case is filed in one Project, the ungrouped
state is gone, and Projects and Case moves have a general API (steps 1 to 5 below). All of it
is released. Step 6 is done except for two P5 journeys that have nothing to exercise yet
(provider replies and provider continuity after a move). The browser journeys with separate
owner, editor and viewer sessions pass locally. A chat with a failed turn or queued messages
stays in its Project (released 2026-10-08). Step 7, the commerce lab sequence, passes
locally and could not run against production.
The [evidence report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-9/README.md) records the inventory, baseline and results.

The [shared preparation record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/refactor-8-9-preparation.md) contains the regional
ownership map, extraction map, acceptance scenarios, and migration requirements.

## Implementation steps and status

| Step | Scope                                                                                                                                                                               | Status                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1    | Rename ChatProject to Project in types, identifiers, tables, source kinds, errors and interface classes. Move general modules to `src/projects/`.                                   | Implemented, 2026-10-07                                                                               |
| 2    | Separate general Project commands and their receipts from portal directory commands. Publish the `/projects` route family, including the command that replaces the default Project. | Implemented, 2026-10-08                                                                               |
| 3    | Default Project: pointer per Organisation, Base provisioning on both creation paths, Base membership, typed error when a Case is admitted without one.                              | Implemented                                                                                           |
| 4    | Canonical `case_project` association written at every Case admission. Portal placement becomes a read of it. Remove the ungrouped state.                                            | Implemented, 2026-10-08                                                                               |
| 5    | Movement under Case execution serialization, with the handling agent following the Case. Deletion and revocation rules.                                                             | Implemented, 2026-10-08; see the decisions below                                                      |
| 6    | Portal, tools and documentation (P4), acceptance journeys and evidence (P5), release (P6).                                                                                          | Implemented, 2026-10-08, browser journeys included; see the evidence report for the two journeys left |
| 7    | Run the commerce lab sequence against the released system. A separate task at the user's request, after steps 1 to 6 and the Refactor 8 leftovers.                                  | Run locally, 2026-10-08. Not run against production: it has no lab Organisation                       |

Decisions, 2026-10-07:

- **Base membership.** Every active member of an Organisation is a member of its Base Project.
  Organisation owners and admins are Base owners, operators are editors, and viewers are viewers.
  An Organisation created by a Slack install has no member, so its Base starts without one.
- **Joining reveals nothing.** A member is added to Base automatically only while Base holds no
  shared Case and no reference. After that, an owner adds the member through the ordinary access
  command, which runs the retained-history disclosure check. A Case shared into Base is shared
  with the whole Organisation.
- **Agents and Project context.** Filing a Case in a Project gives the agent that handles it
  nothing. An agent reads a Project's brief or references only under access that a team member
  or admin granted to that agent beforehand, at fine grain. The expected order is to grant the
  agent access to the Project and then hand it Cases. A mailbox, WhatsApp line or cue is where a
  Case comes from; it does not hold access. This refactor builds no such grant, so Cases from
  Slack, mail, WhatsApp and cues run without Project context. A portal chat keeps inheriting the
  brief through the acting member's own Project membership. This supersedes the parts of
  "Context, RBAC, and IFC" and "Admission across surfaces" below that admit Project context for
  provider-originated work.
- **A moved Case takes its agent with it.** After a move, the agent handling the Case works under
  the destination Project. It no longer reads the source Project's context for that Case, and it
  reads the destination's only with access there. A move never grants access by itself. When the
  agent has no access to the destination, the move says so and the person moving chooses one:
  grant the agent access there, which only someone allowed to grant it can do; move anyway, and
  the agent works without that Project's context; or hand the Case to an agent that already has
  access. The agent keeps its access to the source Project, because it may handle other Cases
  there. The choice applies once agent access to Projects exists; this refactor builds none.
- **A chat is one presentation of a Case.** The chat row names its Case and keeps no Project
  of its own. Its Project and that association's revision are read from `case_project`. A
  new chat joins the Project its first input was admitted under, or the default.
- **What a member inherits.** A member's chat inherits a Project's brief and references only
  under that member's own access to the Project. Any active member may keep private chats in
  the default Project without being its member; those chats inherit nothing, and their turns
  do not depend on its membership. A canvas chat is filed in the default Project and inherits
  nothing, because its audience is the document's.
- **Leaving a Project.** Deleting a Project, removing a member from one, or revoking an
  Organisation member returns the affected private chats to the default Project.
- **Chats reset.** Existing portal chats are test data (user, 2026-10-08). The chat table is
  replaced by `scripts/refactor-9-d1-chat-placement-patch.sql`, which refuses to run while
  any chat exists.
- **Two command families.** Project content, deletion and the default Project are general
  commands at `/v1/control/organisations/:id/projects`, fenced by the Project's own revisions
  and answered from `project_operation` receipts. A member's sidebar ordering and the
  position of their chats stay chat directory commands at `.../chat/projects`. Project access
  moved to `.../projects/:projectId/access`.
- **Moving a Case.** `.../cases/:caseId/project` reads and moves one Case's association. A
  private chat's Case moves under its owner while the chat is idle. A shared chat's Case moves
  only through the sharing command and its disclosure review. A Case a source admitted
  (Slack, email, WhatsApp, a cue, the API) moves under an Organisation administrator, into a
  shared Project they own or edit, or back to the default; a personal Project would hide it.
  The move is one D1 batch with its receipt, so nothing is left half done. It does not go
  through the Case Actor: no turn outside the portal reads Project context yet, so a running
  turn cannot mix an old and a new Project. That step returns with agent access to Projects.
- **Unfinished work holds a chat.** Decided by the user on 2026-10-08. A failed turn can be
  retried and a queued message is sent later, and each runs with the Project context bound
  when it was accepted. So a chat whose last turn failed and can still be retried, or that
  holds queued messages, does not change Project. The sidebar move, the Case move and sharing
  into another Project are refused (`chat_work_unfinished`, `case_work_unfinished`) until the
  retry succeeds or the queued messages are removed. A turn stopped at the storage limit
  cannot run again and does not hold the chat. Deleting a Project and leaving the
  Organisation are not held back by this: they still return private chats to the default.
- **Deleting a Project.** Private chats return to the default Project. Shared chats and Cases
  a source admitted block deletion until someone moves them. The default Project is deleted
  only after another replaces it.
- **Replacing the default.** An Organisation owner or administrator names a shared Project
  they own. Later work with no named Project goes there. Cases already filed stay, and a
  retried admission reads the Project it was first filed in.
- **Leaving the Organisation.** A revoked member's private chats return to the default
  Project and their memberships in shared Projects are removed, so returning does not restore
  access to history added while they were away. Where they were a shared Project's only owner,
  the remaining member with the highest role becomes its owner. That succession rule was the
  implementer's choice, made to keep every shared Project owned without blocking a
  revocation; the user agreed to it on 2026-10-08.
- **Reset.** The Refactor 8 reset rule covers this refactor. Step 1 renamed tables and changed the
  identifier prefix from `chat_project_` to `project_` with no conversion, and no step adds one.
  An Organisation created before step 3 has no Base. `scripts/refactor-9-d1-patch.sql` in
  `services/platform` creates one for every such Organisation, so a deployed database needs
  that patch or a reset before the release that requires a default Project. A database that
  still has the portal-chat table names takes `scripts/refactor-9-d1-schema-patch.sql` first.
  Both ran on the production organisation databases on 2026-10-08, before the first release
  of this refactor.

## Outcome

Extend ChatProject into one general Project domain within an Organisation.
Projects group Cases across Portal, Slack, email, WhatsApp, cues, and direct APIs.
CaseActor continues to own each Case's execution and accepted history.
Portal conversations become one presentation of Case work.

```text
Organisation
├── Base Project — designated default
│   ├── Case — CaseActor
│   └── Case — CaseActor
└── Named Project
    ├── Case — CaseActor
    └── Case — CaseActor
```

Each Project belongs to exactly one Organisation.
Each Case belongs to exactly one Project within its Organisation.
A Project can contain many Cases.
Each active Organisation has one required defaultProjectId and can contain many Projects.
Work without an explicit destination enters that default Project.
Remove ungrouped state from the current domain model after migration.
Project association remains separate from permission to share a Case.

Use the existing Project implementation as the foundation.
Preserve its personal/shared access model, role checks, context admission,
membership management, and accepted disclosure behavior.
Remove the assumption that project membership requires a portal conversation.
Create no parallel ChatProject implementation or generic project framework.

## Relationship to other plans

- [Refactor 8](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/refactor-8.md) owns Organisation naming, Case context naming, and qualified bakery/harness task names.
- [Plan 52](plan-52-chat-projects-and-context.md) supplies project briefs, references, personal ordering, and inherited context.
- [Plan 54](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-54-chat-shared-projects.md) supplies shared membership, conversation access, directory separation, and lifecycle behavior.
- [Plan 54B](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-54B-shared-project-ifc.md) supplies protected context admission and disclosure enforcement.
- [Plan 27](plan-27-ifc.md) owns the information-flow model.
- [Plan 53](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-53-user-preferences.md) and its accepted migration evidence own canonical identity and retained Actor addressing.

This plan owns the structural generalisation and the ChatProject-to-Project rename.
Use Refactor 8's final Organisation names in the resulting contracts.
Implement against its accepted contract changes, or integrate both changes together before release.
Keep one current schema and one current API after conversion.

Paths below identify the current implementation before these refactors.
Resolve renamed paths when implementation starts.
Existing local acceptance does not establish that production data completed either migration.

## Current architecture and the gap

| Current component                                   | What exists                                                                                      | Required change                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `packages/control-api/src/chat-projects.ts`         | Project content, references, placement, and directory commands.                                  | Separate general Project and Case association contracts from portal ordering commands.    |
| `packages/control-api/src/chat-access.ts`           | Personal/shared projects and private/shared conversations.                                       | Reuse roles and access rules at the general Project and Case boundaries.                  |
| `services/platform/src/chat/projects.ts`            | D1-backed Project reads and mutations.                                                           | Move domain ownership into `src/projects/` and remove conversation-specific dependencies. |
| `portal_chat_project` and member tables             | Canonical Project records scoped to the tenant.                                                  | Migrate to general Project tables scoped to Organisation.                                 |
| `portal_conversation.project_id`                    | Project association stored on the portal conversation.                                           | Replace with one canonical association addressed by Case identity.                        |
| `CaseIdentity` in `packages/contracts/src/actor.rs` | Tenant and Case IDs.                                                                             | Keep stable Case identity and represent mutable Project association separately.           |
| `chat/conversation-actor-identity.ts`               | Persisted portal address used to reach accepted Actor history.                                   | Preserve the address and its mapping to the same Case.                                    |
| `chat/project-context.ts`                           | Project context selected from a stored portal conversation.                                      | Resolve and admit Project context from the Case association for every supported ingress.  |
| Project sharing and IFC adapters                    | Current membership, source permissions, retained-history disclosure checks, and live revocation. | Generalise their inputs while preserving the same enforcement boundaries.                 |

The existing Project concept already has useful business semantics.
Its coupling to chat storage, identity, routes, and directory commands creates the architectural limitation.
Extract those domain responsibilities while retaining portal presentation and personal preferences.

## Ownership and scope

| Owner                              | Responsibility                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| OrganisationActor                  | Existing organisation lifecycle, shared configuration, and organisation-owned coordination state.               |
| General Project domain in Platform | Project records, membership, content, Case association, and revisioned commands through existing D1 boundaries. |
| CaseActor                          | Case journal, assignments, accepted proposals, execution serialization, and output receipts.                    |
| AgentSessionActor                  | Pinned acting authority, inference, tools, accepted observations, and cumulative information-flow restrictions. |
| ConnectorActor                     | Provider admission, bindings, delivery, provider audience, and receipt settlement.                              |
| Portal conversation and directory  | Conversation presentation, input drafts, personal ordering, pinning, archive, and read state.                   |

Keep Project records in D1 under the existing organisation execution scope.
Create no ProjectActor solely to hold the hierarchy.
OrganisationActor need not ingest every Project operation or store a second Project catalogue.
Actors receive validated Project references and admitted snapshots when their operation requires them.

A Project does not own provider credentials or replace source authorization.
A CaseContextCollection links relevant evidence and remains distinct from Project grouping.
Collections can relate Cases from different Projects within one Organisation when all existing permissions allow it.
Project membership alone cannot reveal those relationships.

Do not add nested Projects, multiple Project memberships per Case, cross-organisation moves,
external guests, automatic semantic placement, or new workflow execution in this refactor.
Do not convert supplier contacts or external senders into Project members.

## Canonical domain model

### Project

Rename `ChatProject` to `Project` and `ChatProjectId` to `ProjectId`.
Rename corresponding content, role, member, reference, access, command, result,
snapshot, and parser types according to their actual responsibility.
Keep Project content as its name, brief, and bounded reference list.
Preserve the existing reference kinds and source checks.

Preserve these access branches:

- Personal Project: Organisation, Project identity, owner user, content, and required revisions.
- Shared Project: Organisation, Project identity, content, required revisions, and explicit member roles.

Shared Projects require at least one active owner.
Preserve owner, editor, and viewer semantics and atomic ownership transfer.
Project membership requires active membership in the same Organisation.
The creator remains attribution data and does not supply another user's execution authority.

### Case association

Introduce one canonical `CaseProjectPlacement` addressed by OrganisationId and CaseId.
Require ProjectId and association revision on every instance.
Use one record shape without an ungrouped branch, nullable ProjectId, or redundant single-value discriminant.

Resolve Project existence, Organisation identity, access, and lifecycle at the boundary.
Pass the validated association to core code.
Do not accept an optional ProjectId or a default-selection marker in core admission or context functions.

Keep ProjectId out of Case identity, deterministic Actor addresses, and provider binding identities.
A move changes association and its revision while preserving the same Case and Actor.
Shared context in an assignment is an immutable snapshot of the admitted association.
It is not a second writable source of Project membership.

### Base Project and default admission

Base is the initial display name of an ordinary shared Project designated as the Organisation's default.
Use the same Project type, storage, membership roles, API, context admission, and Case operations as other Projects.
Add no BaseProject subtype, separate storage, or special Case lifecycle.
Identify the default through Organisation.defaultProjectId rather than its name or a flag copied onto every Project.

Create the Base Project once through the existing Organisation provisioning command and idempotent receipt.
Establish its shared ownership and defaultProjectId before the Organisation becomes ready to admit Cases.
Interrupted provisioning must recover the same Project and pointer without creating duplicates.
Existing Organisations receive their Base Project during retained-state migration before the new admission path runs.

Start Base with an empty brief and reference list.
Use the ordinary revisioned Project editor and IFC checks for later context changes.
An empty Project yields empty inherited content through the normal snapshot path.
Default placement grants no membership, metadata access, source access, or shared-history permission.
Configure required ordinary Project roles and admission grants explicitly during provisioning and migration.
Do not widen existing source permissions or automatically share migrated private Cases.

Resolve an omitted external destination to the current defaultProjectId at the admission boundary.
Validate the same-Organisation Project and record the resolved destination in the accepted command.
Core logic receives a required validated ProjectId and uses the normal association path.
An existing Case with a missing association fails as invalid state and does not silently acquire the current default during a read.
Default selection uses the existing admitted Organisation authority and does not borrow the Project owner's credentials.
An explicitly selected invalid or inaccessible Project returns its ordinary error and never falls back to Base.
An absent or invalid default is a typed readiness error, never a request to create an ungrouped Case.

An authorized Organisation administrator can change defaultProjectId through the existing revisioned configuration path.
Require a live shared Project in the same Organisation and the relevant Project authority.
Preserve roles, Case privacy, and source restrictions when changing the pointer.
A default change affects subsequent admissions without moving existing Cases.
Retries of an accepted admission use its pinned ProjectId even if the default changes.
Coordinate deletion with the same revision checks so no admission can select a deleted default.

Prevent deletion of the configured default Project until another eligible Project replaces it.
After replacement, the former default follows ordinary Project deletion rules.
Project renaming and personal sidebar ordering do not change its default designation.

### Case visibility and authority

Association and disclosure remain separate decisions.
Reuse existing private/shared portal semantics and existing provider authority adapters.
The general boundary must distinguish:

| Access branch       | Required behavior                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Private user Case   | Only its authorized owner can see its private history. Association with a shared Project does not publish it.             |
| Project-shared Case | Require a shared Project and current membership. Apply role limits and retained-history disclosure checks.                |
| Source-bound Case   | Retain the originating Connector or source access rules and exact audience. Project placement supplies no provider grant. |

Use required, branch-specific fields and `never` exclusions for incompatible combinations.
Reject missing Project associations and shared Cases associated with a personal Project.
Provider authority must remain a precise reference to its owning boundary.
Create no general-purpose copy of provider grants in Project storage.

Only the existing portal sharing path may initially change a private user Case into a project-shared Case.
Provider Cases remain source-bound when grouped.
Widening provider history to a new audience requires separate, supported disclosure behavior.
This plan does not infer that permission from a Project role.

### Personal presentation

Keep conversation identity distinct from Case identity.
Resolve the existing portal conversation-to-Case mapping through its canonical boundary.
Do not replace ConversationId with CaseId by text substitution.

A portal conversation's Project placement is a read projection of its Case association.
Remove independent mutable placement from the conversation record after migration.
Keep user-specific order, collapsed state, pin, archive, draft, and read cursor in presentation records.
Reordering a sidebar must not revise Project content or Case association.

Show source-bound Cases in the Project view only through authorized metadata projections.
Use existing source links and reply surfaces for provider work.
Create no dummy portal conversation merely to include a provider Case in a Project.

## Persistence and mutation contract

Reuse the existing project tables through schema migration:

| Record                             | Canonical purpose                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `project`                          | Organisation scope, Project identity, access branch, content, and revisions.                                           |
| `project_member`                   | Shared Project membership and roles.                                                                                   |
| `project_access_operation`         | Exact accepted membership/access command and disclosure evidence.                                                      |
| Organisation configuration         | Required defaultProjectId for every active Organisation, validated against a live shared Project in that Organisation. |
| `case_project`                     | One revisioned association with a required project_id per registered Case.                                             |
| Existing Case access boundary      | Canonical private/shared access or a required source authority reference.                                              |
| Existing portal preference records | Personal directory state with references to Project and conversation identities.                                       |

Enforce Organisation-consistent references and uniqueness in the owning database.
Require non-null Project identity on every canonical Case association.
Prevent default Project deletion and enforce same-Organisation foreign keys through the owning mutation and persistence boundaries.
Keep separate content, access, association, and personal-directory revisions.
Do not add a second mutable Project catalogue or keep dual writable association fields.
Use explicit migration boundaries for old rows and delete obsolete paths after conversion.

### Assignment and movement

Use existing operation IDs, expected revisions, accepted receipts, and typed conflict results.
Create, assign, move, share, and delete operations must be retryable without duplicate effects.
Returning a Case to Base is an ordinary Project move with the resolved defaultProjectId.
All commands derive Organisation and acting authority from authenticated or admitted execution scope.

CaseActor serializes an association change against turn admission through its existing execution boundary.
Persist the accepted mutation intent before changing the canonical D1 association.
Commit D1 changes with the expected association and relevant Project access revisions.
Recover an interrupted operation from the same receipt and durable intent.
Release the Case for new turns only after the association outcome is known.
Adapt existing receipts and lifecycle mechanisms rather than adding a distributed transaction framework.

Return a typed busy result for association or audience changes during active execution.
An admission racing with a move must use one accepted association revision or retry.
Do not run against a mixture of old membership and new Project context.
Membership revocation must still take effect during active execution through existing live authority checks.

For private Cases, preserve owner-controlled placement and private visibility.
For shared Cases, require the existing source/destination ownership checks and an explicit proposed-audience review.
For source-bound Cases, require both existing source authority and permission to associate work with the destination Project.
Changing Project must not change the provider recipient or Connector binding.
Preserve current restrictions on moving shared Cases to personal Projects.
A shared Case moving to Base requires the same audience review as any other shared Project move.

### Deletion and revocation

Project deletion never silently deletes Case history or provider records.
Move surviving private Cases to the current default Project without exposing them to the source or destination Project owners.
Block deletion while shared or source-bound Cases remain.
Require explicit authorized movement to another Project or existing deletion commands for those Cases first.
Replacing defaultProjectId is a prerequisite to deleting the current default Project.
Commit replacement associations before removing the old Project so no surviving Case becomes orphaned.
Fence concurrent association and turn admission during final Project deletion.
Reuse the existing durable cleanup inventory and retry behavior for interruption recovery.

On access revocation from a non-default Project, move the user's private associated Cases to the current default Project.
The user retains private ownership, while future turns lose the former Project's inherited context.
Apply the destination's ordinary PAC checks before admitting any new inherited context.
If the Case already belongs to the default Project, retain its association and enforce the revoked Project permissions.
Do not restore revoked membership or repeat default movement as a recovery loop.
Organisation-level revocation blocks admission and access regardless of the default Project.
Shared Cases become inaccessible to the revoked member.
Source-bound Cases retain their source authority and never acquire access from past Project membership.
Preserve accepted-history restrictions, terminate unauthorized subscriptions, and purge inaccessible cached content.

## Context, RBAC, and IFC

Reuse [the IFC integration guide](../foundation/authority/policy/information-flow/README.md) for every source and output.
Role-based access control (RBAC) governs operations alongside existing grants and approvals.
Permission-Aware Context (PAC) controls source admission.
Observation-Aware Context (OAC) retains restrictions from admitted information.
Every destination must satisfy the cumulative restrictions before release.

Generalise `prepareChatProjectSnapshot` into Case-addressed Project context preparation.
Resolve Project placement from the canonical Case association, never a portal directory row.
Bind the snapshot to Organisation, Case, Project, association revision, content revision,
access revision, exact acting authority, and the existing observation evidence.
Every snapshot retains its required Project identity and revisions, including snapshots with an empty inherited context.

Read Project briefs and reference metadata through their existing protected source adapters.
Keep source labels, source revisions, content digests, and disclosure proofs through admission and restore.
Project references do not authorize the source bodies they identify.
Admit context once through the shared bundle rather than repeating it in a chat-specific prompt block.

For provider-originated work, check Project access under that operation's existing authority.
Do not substitute the Project owner's user authority or credentials.
If Project context is unavailable, use the existing typed unavailable/denied path.
Do not silently retry with wider authority or fabricate historical admission evidence.

Check metadata as well as bodies: names, titles, counts, previews, references, and relationships.
Private Cases must remain absent from other members' listings, counts, notifications, and pagination metadata.
Adding a Project member requires disclosure checks for all newly visible retained shared history.
Use current revisions and existing mutation fencing to prevent admission races.

Project association and source discovery cannot grant access.
Cross-Project CaseContextCollections retain restrictions from every contributor.
Case and session outputs, inference, tools, previews, streams, replay, and provider delivery use current authorization and sink checks.
Approvals authorize exact actions and do not remove information-flow restrictions.

At the next admitted turn after a move, replace future inherited context with the destination's authorized context.
Retain restrictions from all accepted observations in earlier turns.
Moving to Base or another Project, forking, summarising, archiving, exporting, and restoring must not clear those restrictions.
Revocation blocks future protected access and release but cannot retract previously delivered information.

## Admission across surfaces

| Surface         | Project behavior                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Portal          | Resolve existing conversation identity to its Case and use the general Project commands. Preserve private-by-default creation.                  |
| Slack           | Continue the same admitted Case and provider audience. Allow explicit authorized Project assignment without changing the Slack binding.         |
| Gmail           | Continue the source-owned email Case. Admit Project context only under its actual mailbox and acting authority.                                 |
| WhatsApp        | Preserve conversation windows, support ownership, contact identity, and reply eligibility. Association does not extend a provider window.       |
| Cue or schedule | Resolve the Organisation's default Project unless an explicit target is configured. Validate and pin the resolved association before admission. |
| Direct API      | Resolve an omitted destination at the request boundary. Validate an explicit Project and pass a required ProjectId to core admission.           |

All surfaces use the same default resolution at initial admission.
Existing non-portal and previously ungrouped portal Cases migrate to their Organisation's Base Project.
Preserve every existing valid Project association, private owner, source authority, and provider destination.
Do not infer Project membership from text, titles, sender identity, or model output.
Project selection resolves once into a typed required destination before core work starts.
Keep follow-up ingress tied to the same Case despite later Project moves.

## Target code and API boundaries

- Move general Project functions from `services/platform/src/chat/` into `services/platform/src/projects/`.
- Move general Project contracts to `packages/control-api/src/projects.ts`, `project-access.ts`, and `project-context.ts` as needed.
- Place canonical ProjectId in the established shared identity owner and import its parser everywhere.
- Keep portal directory commands, drafts, conversation rendering, and browser session handling under `chat/`.
- Generalise existing Case access adapters so project commands do not require ConversationId.
- Replace Project source discriminants such as `chat_project` with `project` through the versioned IFC boundary.
- Preserve genuine conversation source identities and native audience semantics.
- Remove old ChatProject exports and imports after consumer conversion.

Use the general route family `/v1/control/organisations/:organisationId/projects` for Project operations.
Use Case identity for project membership listing and association commands.
Use the existing route style for `.../cases/:caseId/project` and its revisioned command body.
Keep chat-specific presentation APIs under their existing conversation routes.
Remove obsolete chat-project routes after boundary conversion and client rollout.

Existing external callbacks, provider APIs, and historical signed payloads retain their required encoding.
Do not create compatibility aliases in core code.
Keep any necessary old-format decoding at persistence or request boundaries with an explicit removal condition.

## P0 — Inventory and establish the baseline

- [x] Record current working-tree edits and preserve unrelated work.
- [x] Inspect current schema, Project contracts, Case access, Actor addressing, IFC adapters, and all ingress paths.
- [x] Read local AGENTS.md instructions for each affected area.
- [x] Inventory project association, directory state, references, sharing, deletion, fork, restore, and pending commands.
- [x] Inventory previously ungrouped Cases and all defaults, unlink actions, and null Project assumptions across admission and lifecycle paths.
- [x] Identify the exact existing Case access owner for each provider and Portal.
- [x] Record all identity and digest inputs that include ChatProject, conversation, or tenant naming.
- [x] Run the existing Project, IFC, onboarding, and Case recovery journeys before editing.
- [ ] Record baseline failures and production migration state without treating local acceptance as deployed evidence.

Exit: every current responsibility has one retained owner and an identified conversion path.

## P1 — Extract the Project domain and precise contracts

- [x] Rename ChatProject domain types and identifiers to Project forms.
- [ ] Separate general commands from personal portal directory commands.
- [ ] Define CaseProjectPlacement and validated access branches with required fields.
- [ ] Add required defaultProjectId to the active Organisation contract and remove ungrouped/optional Project branches from core types.
- [ ] Define default resolution only at admission and lifecycle boundaries, with the resolved destination pinned in accepted commands.
- [ ] Preserve owner/editor/viewer roles and existing private/shared disclosure rules.
- [ ] Extract existing Project storage and authority functions into the general module. Access, membership, context, references and record reads are moved; mutations still live in `chat/projects.ts`.
- [ ] Reuse existing Result unions, parsers, shared guards, and branch-specific builders.
- [ ] Add targeted type fixtures for missing ProjectId, invalid shared placement, foreign-Organisation identities, broad spreads, and incompatible authority branches.

Do not widen types, use domain casts, or create a raw optional ProjectId escape path.
Foreign-Organisation equality remains a runtime boundary check even when IDs have branded types.
Use standalone functions and exhaustive switches with assertNever.

Exit: general Project logic accepts Case-scoped input without a portal conversation dependency.

## P2 — Migrate storage and preserve identity

- [ ] Rename general Project tables and convert owned Organisation fields with Refactor 8.
- [ ] Preserve existing Project IDs, members, roles, content, revisions, and accepted command receipts.
- [ ] Create one empty Base Project per existing Organisation and establish its defaultProjectId idempotently.
- [ ] Resolve every existing portal conversation to its exact current Case and migrate its Project association.
- [ ] Reject inconsistent mappings without choosing an arbitrary Project or inventing a new Case.
- [ ] Associate previously ungrouped portal Cases and unassociated non-portal Cases with their Organisation's Base Project.
- [ ] Preserve private/source-bound access and validate every Case has one live same-Organisation Project before enabling the new model.
- [ ] Keep personal directory and draft state attached to its existing user and conversation identities.
- [ ] Replace portal placement writes with reads from canonical Case association.
- [ ] Remove obsolete association columns and duplicate current write paths after conversion.
- [ ] Convert checkpoints, context snapshots, exports, forks, and pending mutations through versioned boundaries.
- [ ] Resolve pending old-format admissions to Base once during conversion and persist that accepted destination for retries.
- [ ] Update the D1 baseline, schema verification script, and existing Actor migrations where needed.

Retain historical `chat_project_*` identity values when already issued.
New Project generators may use `project_*` while boundary parsers normalize both into ProjectId.
Preserve Actor object IDs, stored portal actor addresses, source bindings, and exactly-once receipt behavior.
Project movement must not reconstruct an address from the Project or current user.

Validate signed historical evidence under its recorded representation before normalization.
Missing historical observation evidence must remain unavailable.
Do not reconstruct it from current permissions or recompute accepted signatures.
Do not reinterpret historical ungrouped snapshots as prior observations of Base.
Preserve their original proof at the migration boundary and create Project-scoped snapshots for new turns.
Test retained data conversion, interruption recovery, and a second startup.

Exit: every Case has one required canonical Project association with no lost history, membership, or private directory state.

## P3 — Integrate admission, execution, and lifecycle

- [ ] Resolve canonical association for each supported ingress before Project context admission.
- [ ] Establish Base during Organisation provisioning and normalize omitted destinations through one default-resolution boundary.
- [ ] Implement revisioned assignment, movement, default replacement, and retry through existing command and Case execution boundaries.
- [ ] Preserve source-bound Case authority and exact provider recipients.
- [ ] Generalise Project context admission for Pi and Codex through the existing admitted bundle.
- [ ] Revalidate Project and source authority during execution and at each disclosure boundary.
- [ ] Extend membership, deletion, private movement to Base, and restoration through Case identity.
- [ ] Preserve accepted observations and provider receipts through moves and recovery.
- [ ] Remove the requirement to create a portal conversation for non-portal Project membership.

Exit: Cases from supported surfaces use one Project model and one authority path.

## P4 — Update Portal, tools, and documentation

- [ ] Replace chat-only Project clients with the general Project API.
- [ ] Show authorized Cases from all supported sources with their source and existing destination links.
- [ ] Preserve private defaults, explicit sharing, keyboard operation, focus, and personal directory state.
- [ ] Separate Case association commands from sidebar reorder operations.
- [ ] Replace Ungrouped and unlink actions with the ordinary Base Project destination and normal move operations.
- [ ] Show the configured default consistently without using the display name as identity or authority.
- [ ] Keep hidden private and source-bound Cases out of counts, titles, activity, and notifications for unauthorized users.
- [ ] Update tools to accept parsed Project and Case identities without manufacturing conversations.
- [ ] Update root guides, architecture, Plans 52/54/54B, the IFC integration guide, runbooks, and published documentation.
- [ ] Replace current ChatProject terminology while preserving factual historical evidence and external protocol terms.
- [ ] Remove old routes, exports, and duplicated implementations after their boundary conversion is complete.

Exit: the interface and APIs express Organisation → Project → Case consistently.

## P5 — E2E acceptance and repeatable evidence

Use existing native Worker and authenticated browser journeys as the foundation.
Extend behavioral gaps with medium-to-hard E2E scenarios.
Add no unit tests or source-text change detectors.

| Journey                        | Required evidence                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed-source Project           | Place a private Portal Case, a shared Portal Case, and a source-bound supplier Case in one Project. Each reader sees only authorized metadata and history.                                          |
| Context and provider reply     | Admit Project references for supplier work, produce a permitted reply, and deny release when protected internal context is incompatible with the supplier audience.                                 |
| Movement race and recovery     | Race turn admission with a Project move, interrupt after accepted mutation or D1 commit, restart, and recover one association with exact receipts.                                                  |
| Membership and live revocation | Give members different roles and source permissions. Deny unsafe member admission, revoke access during a turn, and block tools, replay, and final delivery.                                        |
| Private movement and deletion  | Revoke Project access or delete an eligible non-default Project. Move surviving private Cases to Base without widening visibility. Block deletion with shared/source-bound Cases.                   |
| Base admission and replacement | Provision Base once, admit Cases from different sources without explicit destinations, change the default during a retry, and verify pinned associations. Block deletion of the configured default. |
| Fork and restoration           | Fork work that observed protected Project context, change its placement, restart both harness paths, and verify that restrictions remain attached.                                                  |
| Organisation isolation         | Attempt cross-Organisation assignment, reference resolution, membership, and replay. Reject every unauthorized path without revealing foreign metadata.                                             |
| Retained-data migration        | Upgrade personal/shared Projects with pending turns, operation receipts, private drafts, memberships, forks, and encrypted history. Restart twice and recover original identities.                  |
| Provider continuity            | Verify Slack follow-ups, Gmail reply ownership, and WhatsApp window constraints after assignment and movement. Repeat ingress produces no duplicate work or effects.                                |
| Browser operation              | Use independent owner/editor/viewer contexts. Verify mixed-source listing, private counts, assignment, sharing, movement, revocation, and stale-response cache handling.                            |

Use existing provider stubs where live access is unavailable and label their scope explicitly.
Retained-data migration must use state produced by the prior implementation.
A fresh database or simple Actor eviction cannot prove that migration.
Include previously ungrouped Cases and interrupted Base creation in that migration evidence.
Verify private histories and source-bound metadata remain hidden from unauthorized Base members.
Verify no current core association, snapshot, or creation result contains a missing ProjectId.
Exercise both Pi and Codex restore paths without requiring live inference where existing fixtures suffice.

Start with existing journeys under `services/platform/tests/e2e/chat-projects.test.ts`,
`chat-project-ifc.test.ts`, shared runtime, fork retention, Portal finalization,
mail inbox, Slack, WhatsApp, and Actor recovery.
Use the existing authenticated browser tooling under `scripts/plan-54/` and related acceptance scripts.
Record exact final paths and commands after extraction.

Run focused E2E journeys first, then the shared-contract gates:

```bash
pnpm --filter @satyr/contracts typegen
pnpm --filter @satyr/contracts check:types
pnpm --filter satyr-edge check:types
pnpm --filter satyr-edge check:test-types
pnpm --filter satyr-edge test
pnpm --filter satyr-edge test:onboarding-closure
pnpm --filter satyr-edge test:commerce-lab
pnpm portal:build
pnpm docs:check
pnpm docs:build
pnpm lint:ifc-boundaries
cargo check --workspace
cargo test --workspace
git diff --check
```

Run `lab:reset`, `lab:seed`, `lab:scenario`, and `lab:verify` against a verified disposable commerce lab when changing its lifecycle integration.
Never reset a populated application environment as migration verification.
Fix failures caused by this change and report unrelated baseline failures separately.

Produce `docs/evidence/refactor-9/README.md` and machine-readable journey results.
Include revision, environment, repeat commands, migration checkpoints, operation receipts,
allowed/denied outcomes, and authenticated browser captures.
Use synthetic or redacted records and preserve factual prior evidence.
Record provider simulation, live skips, and unresolved release checks explicitly.

## P6 — Release and completion

- [ ] Verify Refactor 8 naming and identity prerequisites against the actual deployment state.
- [ ] Complete retained-state migration acceptance before releasing the structural change.
- [ ] Coordinate schema, Worker, Portal, contract, and client changes in one release sequence.
- [ ] Drain or convert pending old-format commands using the owning boundary and exact accepted receipts.
- [ ] Preserve public service names, OAuth callbacks, provider destinations, and existing Actor addresses.
- [ ] Verify continuity and authorized/denied paths after release.
- [ ] Remove temporary boundary adapters when no retained data or requests require them.
- [ ] Record implementation, local acceptance, and production release status separately.

Define recovery before release using tested restore or a compatible forward correction.
An older binary may be unable to read the converted schema.
Writing this plan does not deploy changes or authorize data deletion.

Completion requires one Project domain and one required canonical Case association across supported surfaces.
Every active Organisation has a valid defaultProjectId, and every Case belongs to one Project in that Organisation.
No current ungrouped branch, nullable core ProjectId, or separate Base Project implementation remains.
CaseActor still owns each Case, and no ProjectActor is required by this plan.
No parallel ChatProject model, duplicate placement write path, or permanent compatibility alias remains.
All access, source restrictions, funding, approvals, history, and receipts survive the change.
The E2E artifacts must prove migration, mixed-source behavior, and IFC enforcement.
