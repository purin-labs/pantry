# Plan 43 — Luna Max onboarding checklist

Use this checklist to execute [Plan 43](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-43-clean-onboarding-integration-baseline.md)
with one Luna Max worker. [Plan 41](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-41-explicit-environment-configuration.md)
and the [environment runbook](environment-configuration.md) own startup and
configuration. Read the current repository instructions before execution.

**Objective:** prove that a clean development environment becomes usable through
normal onboarding, with one useful task per required integration. Fix demonstrated
local defects and leave the recreated environment ready for development.

The first controlled execution is recorded in
[`docs/evidence/plan-43-luna-onboarding-2026-09-13.md`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-43-luna-onboarding-2026-09-13.md).
Writing this checklist authorizes no reset or external messages. During
execution, use the campaign's confirmed development target and explicitly
authorized test accounts, destinations, messages, and transactions. Keep
existing user work and other tasks' processes intact.

## Current execution update — 2026-09-14

The disposable `Financier Factory` / `Cafe operations` workspace is the tested
local `dev` candidate. OAuth and connection checks are complete for the live
Notion, Square, Shopify, Stripe, Slack, Dropbox, Google Drive, Airtable, and
Gmail accounts recorded in the evidence note. Airtable's exact row read and
Dropbox's empty-folder listing are **PASS**. The browser Gmail marker read and
Gmail policy activation are **PASS**: the local adapter now binds Workerd's
`fetch` receiver correctly, the profile and `users.watch` calls complete, and
the policy records a history point and seven-day watch. Processing was disabled
again after the check.

The Gmail integration and the useful Gmail agent read are now **PASS**. The
local Codex harness was rebuilt and reauthorized; the completed Inbox triage
turn returned the exact marker subject, sender, received time, and nonce line.
Processing remains disabled under policy version 13. The authorized Slack
request was replayed and delivered with a settled receipt; Slack transport and
guardrails pass, while its combined Airtable/Gmail provider read is partial
because those local connector calls returned unavailable.

The current matrix is C08 **PASS for the two exercised live provider
resources**, C10 **PASS for the Notion and Square consent/recovery slice and
PARTIAL for the campaign aggregate**, C11 **PASS for the exercised Square
disable/remove/reattach path and PARTIAL for the campaign aggregate**, C12
**PASS for the exercised isolation boundary**, and C13 **PARTIAL**. Keep the
campaign status **INCOMPLETE** until the remaining provider-specific
recovery/removal coverage and authenticated fresh-session checks are complete.

Work one journey at a time. Read only the owning source/test files when a check
fails. Reuse existing scripts and tests, retain compact evidence, and rerun passed
checks only when a change affects them. Report material scope or behavior decisions
to the parent agent. Branch integration, production deployment, the full Urk
behavioral evaluation, live payment certification, and new product features remain
separate tasks. Do not spawn additional agents.

## Final execution update — 2026-09-14

The local Luna/Codex harness was rebuilt and reauthorized. The Inbox triage
agent completed the Gmail marker search and returned the exact subject, sender,
received time, and nonce line; Gmail processing remains off. The authorized
Slack request at `p1789318160822749` was replayed through signed local ingress
and settled in `#cafe-ops` with native receipt `1789318698.051509`. Its reply
preserved the nonce, reported the Dropbox marker folder as empty, and reported
the local Airtable/Gmail connector reads as unavailable. Slack transport and
guardrails pass; the combined provider read is partial.

C08 is **PASS for the two exercised live provider resources**: Airtable and
Gmail each passed allow, revoke/deny, and restore/allow data-flow checks. C10 is
**PASS for the Notion and Square consent/recovery slice**: Notion reused one
active connection and completed an explicit refresh rotation to generation 3;
Square's launched `Seams KK` sandbox seller produced one active account beside
the revoked removed account and completed an explicit refresh rotation to
generation 2. C10 remains **PARTIAL for the campaign aggregate** until the
remaining providers receive their own recovery cycles. C11 is
**PASS for the exercised Square disable/remove/reattach path** and **PARTIAL
for the campaign aggregate** while the remaining provider cleanup receipts are
collected. C12 remains **PASS for the exercised isolation boundary** and C13
**PARTIAL**. The dated evidence note records the provider attempt and callback
receipts, account/connection IDs, stale Notion-attempt cancellation receipt,
cleanup settlement, case/session IDs, D1 isolation observation, focused 31-test
suite, desktop keyboard result, and 390px sign-in render. Remaining work is
provider-specific C10/C11 completion and an authenticated fresh-session
useful-operation replay at 390px.

## 1. Record the run and prepare its prerequisites

- [ ] Record the checkout path, commit, working-tree changes, date/time, selected
      profile, Portal/Platform/Commerce origins, schema/configuration revision,
      and the processes serving those origins. Identify the actual tested code;
      a build from another checkout is a different candidate.
- [ ] Name the owner/test identity, selected development environment, exact storage
      bindings or local persistence paths, and reset authorization. Resolve the
      real reset command and show its affected stores before deletion. Record
      provider registration cleanup and any human consent needed before wiping.
- [ ] Fill the recreation table below from current accepted plans. Resolve accounts,
      callback URLs, credential availability, resource selections, destinations,
      grants, inference authority, and expected task results. Record secret locations
      or availability only; never copy their values into evidence.
- [ ] Inventory the current Portal catalogue, provider adapters, and manual-key/
      inference routes. Classify every entry as required or explicitly excluded
      with its source-plan reason. Missing credentials for a required connection
      mean BLOCKED. An advertised supported flow missing its implementation is FAIL.

| Source plans              | Scenario to recreate                | Required setup and first result                                                                                                                                     |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22, 23, 33                | Café/patisserie and export commerce | Native commerce, product/inventory data, selected storefront/profile, required sandbox payment account; read known commerce facts and open the intended storefront. |
| 16, 28, 30, 39            | Merchant agent                      | Installed agent, published instructions/skills, chosen inference authority, exact Slack destination and read grants; obtain a grounded answer in that destination.  |
| 34, 35                    | Connected files                     | Dropbox/Drive test resources and explicit destination grants; return each allowed file's unique marker.                                                             |
| 29, 32, current catalogue | Mail, messaging, and records        | Required Gmail/WhatsApp/Airtable/Notion and other supported accounts; complete the operation in section 3.                                                          |
| 42                        | Implemented bakery example          | Shared procedure/scenario through supported setup; run and reopen the saved example. Robot execution remains unimplemented.                                         |
| 35, 43                    | Organisation isolation                    | A second disposable organisation with distinct synthetic resource markers and grants; prove cross-organisation reads fail.                                                      |

Add columns to the run note for the actual owner, workspace, provider test account,
selected resources, destination, and setup inputs. Share a workspace between
compatible scenarios; a plan number alone does not require another organisation.
Respect [blocked/deferred work](../blocked-deferred-tasks.md), including existing
WhatsApp credentials and deferred Square distinct-seller/live certification.

**Preparation passes** when every required scenario has a reproducible recipe,
the exact development target is confirmed, and each external prerequisite is
available or explicitly recorded as a blocker. A blocker must remain visible in
the campaign result. Continue independent checks while awaiting it.

## 2. Execute the merchant journey

Check a box only after its PASS condition is evidenced. For every unmet condition,
record FAIL, BLOCKED, or NOT RUN according to section 5. Complete section 3's useful
operations after C07 activation and before C10–C11 alter the connections.

| Check                                   | Action                                                                                                                                                                                                                                                                                 | PASS requires                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ] C01 — Startup                       | Start the chosen stack using the environment runbook's existing commands.                                                                                                                                                                                                              | Portal and both Workers use the intended configuration and matching code. No handwritten runtime-variable overrides or accidental production bindings. Verify Docker is running: the commerce launcher enables the configured containers for agent work. Owner OAuth and provider readback are checked in C06 and section 3.                                                                                      |
| [ ] C02 — Full reset                    | Execute the resolved, authorized development reset through existing cleanup paths. Stop admission/work, clean up test registrations, reset organisation-owned state, and apply the current schema.                                                                                           | The Portal lists zero old workspaces; old workspace routes no longer resolve; organisation-owned Actor/queue/cache/artifact state is accounted for; a controlled delayed test event cannot recreate deleted state. Configuration/secrets are preserved. `pnpm lab:reset` alone fails this gate because it resets one commerce lab. A missing full-reset implementation is a concrete FAIL; fresh-state dependents remain BLOCKED. |
| [ ] C03 — Workspace creation            | Use a fresh browser session to sign in and create the first organisation/workspace through the UI. Reload after a completed setup step and resume.                                                                                                                                     | Exactly one intended workspace exists, the correct owner is a member, and saved progress survives reload. Capture IDs from actual responses. No SQL seeds or administrative record patches supply the state under test.                                                                                                                                                                                                     |
| [ ] C04 — Defaults and access           | Open onboarding, Integrations, Access, and Agents on the new workspace before repairs or custom grants.                                                                                                                                                                                | Every page loads; required baseline policies/grants exist through normal creation; incomplete setup has an actionable next step. Protected content remains unavailable until its intended grant is added. Missing-default errors or an empty/broken access projection fail.                                                                                                                                                 |
| [ ] C05 — Integration discovery         | Inspect an empty catalogue, search a known provider, open its setup, then return. After C06 connects two accounts of one supported provider, finish the account-discovery assertions.                                                                                                  | Search finds the provider; Back preserves the search and restores usable focus; account count, names, and detail links identify the correct accounts. No other workspace's accounts appear. Provider-detail failure does not erase the connected-account overview. Use the current Plan 44 UI if present in the candidate.                                                                                                  |
| [ ] C06 — Connect and select resources  | Complete each required connection in section 3 using its normal UI. Finish resource selection and access setup, then reload.                                                                                                                                                           | OAuth returns to the intended environment/account. The expected provider account/environment, selected resources, and intended grants persist. Complete useful operations after C07 activation; a provider cannot pass on an OAuth redirect, Connected badge, or account metadata alone.                                                                                                                                    |
| [ ] C07 — Readiness and activation      | Select commerce, inference, agent, destination, and intended grants; assess readiness and activate. Exercise a stale-readiness request and an exact activation retry through existing deterministic tests.                                                                             | Readiness reflects the selected operating profile. A stale assessment cannot activate it. Valid activation produces one activation result/receipt and one first-task admission; exact retries add neither another activation nor another first task. An intentionally unlinked read-and-propose profile follows its existing supported contract.                                                                            |
| [ ] C08 — Granted and ungranted content | Create one allowed synthetic resource and one ungranted resource with different unique markers. Read them from the intended agent destination. Grant, revoke, and repeat the protected read; then restore the intended grant.                                                          | Only the allowed marker is returned. Revocation blocks the next protected read before provider access; evidence uses the actual authorization outcome/trace, not the agent's assertion. Restoration enables only the intended scope. Use existing deterministic tests for boundary observations unavailable in the UI and label them accordingly.                                                                           |
| [ ] C09 — First useful merchant task    | Provision one known Product and inventory position through supported product/API commands. Ask Urk, “What is the on-hand and available inventory for this product?” using its supported record context. Send one authorized nonce-bearing Slack request and one same-thread follow-up. | The answer agrees with independently read fixture identity, quantities, units, and revisions; missing evidence is stated explicitly. Each accepted Slack request gets one result in the selected thread, with the matching nonce on the nonce request. Record Case/session/delivery receipt and pinned route. “Tools unavailable,” invented quantities, duplicate replies, or a UI-only result fail the intended task.      |
| [ ] C10 — Connection recovery           | For each required provider, cancel or deny setup once, retry, then reconnect/rotate an established test connection. Exercise expired/duplicate callbacks once per shared protocol family in the existing tests.                                                                        | Retry works without duplicate accounts; reconnect uses the intended account and current credential generation; expired/duplicate callbacks cannot create extra authority. Selections/grants are preserved or explicitly require reselection according to the supported lifecycle. No silent broadening of access.                                                                                                           |
| [ ] C11 — Disable and removal           | On disposable test connections, disable and attempt the protected operation; remove and read cleanup status. Complete any provider-required manual revocation, then reconnect through onboarding if needed for handoff.                                                                | Disabled/removed authority cannot perform new protected work. Required provider cleanup has its real receipt or an explicit pending/manual step. Pending cleanup cannot pass as removed. The final environment retains every required usable connection.                                                                                                                                                                    |
| [ ] C12 — Organisation isolation              | Create organisation B through onboarding. As B, try organisation A's known resource/account reference through normal endpoints, and inspect discovery. Verify B's own allowed marker still works.                                                                                                  | A's protected marker/content never appears, no A-backed effect occurs, and discovery is organisation-scoped. B's own positive read succeeds. Use distinct resources/accounts appropriate to the provider; keep deferred Square distinct-seller certification outside this check.                                                                                                                                                  |
| [ ] C13 — Persistence and usability     | Sign out/in, reopen the workspace in a fresh browser session, and repeat the useful operation. Walk setup using only the keyboard and at a 390px viewport.                                                                                                                             | Completed setup, account/resource selection, grants, and activation survive. No connection is duplicated or consent unexpectedly restarted. Required controls remain reachable with visible focus; errors identify a next action; no clipped control or modal blocks completion. Record elapsed time, backtracks, and interventions without inventing a time target.                                                        |

For C08, C10, C11, and C12, instantiate results per provider or shared boundary.
A single checked aggregate row cannot conceal a failed or unrun required provider.

## 3. One useful task per integration

Give each required row its own status and evidence mode. “Live provider” includes
a real provider sandbox; it never means a locally mocked provider response.
Use unique synthetic markers and independently known expected results.

| Surface                         | Minimum PASS evidence after setup                                                                                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native commerce                 | Known Product and inventory position read through the selected commerce authority; corresponding Portal record and intended café/export storefront load.                                                                                                  |
| Slack                           | Selected destination, one accepted nonce-bearing request, one same-thread follow-up, and exactly one settled result per request.                                                                                                                          |
| Dropbox                         | Selected file/folder and destination grant; agent returns the exact allowed file marker with a source reference.                                                                                                                                          |
| Google Drive                    | Picker/resource selection and destination grant; agent returns the exact selected document marker with a source reference.                                                                                                                                |
| Gmail                           | Correct mailbox and supported processing policy; read synthetic mail and create/read back a proposed reply through the supported draft path. Processing remains off until explicitly enabled; no send is implied by this check.                           |
| Airtable                        | Correct base/table; read a known row and its exact synthetic field value through the advertised tool.                                                                                                                                                     |
| Notion                          | Correct page/database selection; read a known authorized text/property marker through the advertised operation.                                                                                                                                           |
| Shopify                         | Correct test shop and commerce authority; a known Product or Order projects with source identity and revision.                                                                                                                                            |
| Square                          | Sandbox account/location read and a controlled sandbox event accepted/reconciled once through the supported path. Physical Terminal and distinct-seller certification remain deferred.                                                                    |
| Stripe                          | Test account, applicable profile/webhook configuration, and a controlled sandbox payment/event whose accepted receipt matches account and amount. Missing required certification is BLOCKED or FAIL according to its cause, never a fabricated pass.      |
| WhatsApp                        | Supported owned test signup/account, approved synthetic inbound message, correct Case route and one authorized reply. External customer onboarding remains subject to the blocked register.                                                               |
| Other advertised connections    | Name the actual service, credential setup, selected resource, and one advertised useful operation before testing it. Respect Plan 44/Spec 14's custom-connector transport gate; no speculative adapter implementation.                                    |
| Each advertised inference route | Connect/select the route through its owner flow; complete one task and inspect the pinned funding/provider/harness identity. Existing negative tests prove unavailable authority fails without fallback. Missing owner consent leaves that route BLOCKED. |
| Bakery example                  | Create/load the implemented shared procedure through supported setup, run its scenario, save where supported, and reopen the same saved input. This checks recreation, not physical timing calibration or robot execution.                                |

## 4. Fix failures, automate, and finish

- [ ] For each FAIL, preserve the minimal reproduction, expected/observed result,
      failing response/reason, and owning code path. Fix confirmed localized bugs
      using existing patterns. Establish whether a failing test protects current
      behavior before changing or deleting it. Escalate material unresolved scope
      or behavior decisions with the smallest concrete proposed change.
- [ ] Add a focused regression for each distinct defect. If direct database repair
      was used during diagnosis, invalidate that journey and recreate its state
      through onboarding before claiming PASS.
- [ ] Automate the working creation/recreation journey against real Pantry routes
      using the existing browser/e2e tooling and returned IDs. The current
      `frontend:journeys` runner installs mocked Portal responses. Its results are
      UI-fixture evidence until an actual-backend mode is implemented and verified.
      Provider stubs belong only at external API boundaries.
- [ ] Run the relevant checks below on the tested candidate, record exit statuses,
      and account for every required skipped test. Fix failures caused by changes;
      retain unrelated failures as explicit candidate limitations.
- [ ] After fixes, complete the recreation flow from empty state on the final
      candidate. Repeat the required useful tasks, reopen the Portal, and leave
      the required workspaces/integrations usable. Refresh any evidence affected
      by code/configuration changes during the run.

Run each applicable command once per unchanged candidate; rerun affected checks
after a fix. Save full logs locally and put only outcomes and evidence paths in
the run note.

```sh
pnpm test:environments
pnpm --filter @purin-labs/platform test:onboarding-closure
pnpm --filter @purin-labs/platform check:types
pnpm --filter @purin-labs/platform check:test-types
pnpm --filter @purin-labs/platform test:e2e
pnpm portal:build
git diff --check
```

Use `pnpm frontend:journeys` for relevant UI regression coverage, labeled as
fixture-backed. Shared domain, parser, schema, configuration, or routing changes
also require the full platform suite under the local test instructions. Commerce
lifecycle changes require `test:commerce-lab`, `lab:reset`, `lab:seed`,
`lab:scenario`, and `lab:verify` as specified in AGENTS.md; resolve their target
as the designated development lab before execution. Those lab commands do not
replace C02. Run Commerce/storefront/Rust checks when their code changes.

## 5. Report and decide

Use one dated file under `docs/evidence/`. Keep successful rows short; attach
screenshots/traces for failures and the key fresh-workspace/first-task results.
No secrets, OAuth codes, cookies, or private provider content belong in the note.

| Check/provider | Status  | Evidence mode  | Expected → observed     | Evidence reference | Blocker/fix/next action |
| -------------- | ------- | -------------- | ----------------------- | ------------------ | ----------------------- |
| C06 / Square   | NOT RUN | To be recorded | Sandbox owner OAuth → — | —                  | —                       |

- **PASS:** every required condition was observed on the identified candidate;
  evidence establishes the claimed scope.
- **FAIL:** actual behavior contradicts a required condition, a required check
  fails, or the supported path is missing. Name the defect.
- **BLOCKED:** an external prerequisite/authorization is unavailable, or an earlier
  failure prevents this dependent check. Name the prerequisite or failed check.
- **NOT RUN:** no attempt/evidence yet. It remains incomplete.
- **EXCLUDED:** an owning plan or explicit campaign decision places this operation
  outside scope. Cite that decision. Never relabel a broken supported flow.

Evidence modes: **real backend + live provider**, **real backend + provider stub**,
or **UI fixture**. A deterministic PASS supplies automated evidence only. It cannot
replace a required live-provider result or real-backend onboarding.

**Campaign PASS** requires all required checks and provider operations to pass,
the real-backend recreation journey and applicable automated checks to succeed,
and the final environment to be usable without manual record repair. Report
FAIL if any required defect remains; otherwise report BLOCKED if prerequisites
remain, or INCOMPLETE if checks were not run. Never average away failed providers.
An agreed subset can pass only as that named subset; Plan 43 stays incomplete
while a required integration is blocked.

Final response: candidate/environment; overall status and counts; recreated
workspaces and usable integrations; confirmed defects/fixes; blockers with one
concrete next action each; link to the evidence note. Scheduling the recurring
campaign is a separate step after the first run establishes its prerequisites.
