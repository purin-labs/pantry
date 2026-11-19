# Plan 92 — A new pantry repository

Status: phase 1 and the cutover done on 18 November 2026 (owner: "Yes, start", with the default decisions); phase 2: unused and legacy code done on 18 November 2026 (see "Phase 2 results"); tests done on 19 November 2026 (see "Phase 2 results: tests" and "the fold of the E2E fault cases"); duplicate code done on 19 November 2026 (see "Phase 2 results: duplicate code").
Owner: the whole repository.
Touches: [Plan 91 — names](plan-91-seams-atelier-rename.md),
[Refactor 16 — Kitchen physics](refactor-16.md), the deploy procedure and
every open branch.

## Goal

`seams-tech/pantry` starts again with a new history. Its first commit imports
the current code, without the bloat, the centaur leftovers and the legacy
code. The current history moves to an archive repository and stays readable.
Production, the deployed names and the stored values do not change.

## Why

- The history has 4,131 commits and 7 root commits: a fork import of the
  "centaur" project (`22419e4d6`, 7 July 2026), five scaffold roots and an
  older "Cue realtime harness" project (April 2026). It holds commits of
  other people and work that is not this product.
- The tracked tree is about 1.5 GB in 12,155 files. Large binaries are most
  of it, and every clone and CI checkout pays for them.
- The owner decided on 18 November 2026: a new repository, with the code
  copied in and cleaned.

## Facts (dev `0d6553123`, 18 November 2026)

| Folder | Size | Files | What it is |
|---|---|---|---|
| `assets/` | 1,078 MB | 2,930 | Kitchen models: MuJoCo (862 MB), robots (114 MB), rooms (101 MB). The code names 855 MB of it. |
| `docs/` | 181 MB | 3,062 | Evidence 130 MB (2,526 files), equipment 45 MB, 141 plan and refactor docs |
| `apps/` | 169 MB | 1,162 | Portal 165 MB, of which `public/bakery-physics` is 143 MB |
| `services/` | 33 MB | 2,442 | Platform 28 MB, commerce 5 MB |
| `packages/` | 15 MB | 1,128 | |
| `output/` | 13 MB | 160 | Generated files; the Portal imports 3.6 MB of models from `output/bakery-assets` |
| `scripts/` | 11 MB | 760 | 46 folders; many serve one finished plan or refactor |
| `tools/` | 2 MB | 393 | Python agent tools from the centaur fork |
| `crates/` | 1 MB | 60 | |

- 204 files have the same content as in the centaur import; 199 are in
  `tools/`. Of the 416 centaur paths that still exist, 390 are in `tools/`.
  The Cue project left no file.
- R2 (`satyr-repo-binaries-apac`, `repo-binaries.json`) already holds 504
  large files. A Portal build already fetches the old Kitchen bundles from it.
- The native Kitchen crate reads about 85 asset paths when it builds and runs,
  and CI builds it. CI has no R2 access today.

## Phase 1: the import

One import commit builds the new tree from `dev`. The commit message names the
source commit in the archive. These rules choose what the tree holds:

| Item | Size | Rule | Why |
|---|---|---|---|
| `assets/` | 1,078 MB | Move to R2 (`repo-binaries.json`) | Build and simulation input. The code names 855 MB of it. |
| `apps/portal/public/bakery-physics` | 143 MB | Move to R2 | Built Kitchen bundles. R2 already holds the old ones. |
| `docs/equipment` | 45 MB | Move to R2 | Vendor manuals and photos |
| `docs/evidence` | 130 MB, 2,526 files | Leave in the archive | Records of finished work |
| Plan and refactor docs | 141 files | Keep the 63 that AGENTS.md or the code links; leave the rest in the archive | Closed plans |
| `tools/`, `satyr_sdk/` | 400 files | Leave in the archive | Python agent tools from the centaur fork. No product code uses them. |
| Centaur leftovers | about 800 lines | Leave in the archive | 3 skills (`improve-gap-task`, `learning-synthesis`, `dogfood`), `authors.txt`, `.github/actionlint.yaml`, `agent-session-token.ts`, centaur lines in `.gitignore` and `.dockerignore` |
| One-off scripts | about 40,000 lines | Leave in the archive | `scripts/refactor-10` to `-14`, `services/platform/scripts/plan55*`, applied D1 patches (after the remote schema check is clean), the July M6–M8 Slack scripts and their `package.json` keys, `plan-42H`, `plan16`, `plan31A`, `plan47`, `cafe`, `lab/square-terminal-sandbox.ts`, `fixtures`, `portal-latency` |
| `output/` | 13 MB | Keep only the 3.6 MB of models that the Portal imports, in `apps/portal` | Generated files |
| Dead files | 85 files, 5,023 lines | Delete | The unused-code scan is sure of them |
| `benchmarks/`, `business/`, `vendor/pi` | small | Leave in the archive | Results of a closed experiment, strategy drafts, a stale note |

The new tree is about 100 MB in about 5,500 files (an estimate). The checks of
Plan 91 (28 checks, the unit suite, the E2E suite, the Portal and docs builds)
must give the same results on the new tree as on `dev`.

## Phase 2: the code cleanup

Phase 2 runs in the new repository, as normal commits, one workstream at a
time. Four scans on `dev` `0d6553123` give the scope.

**Unused code.** Knip and an import check found 297 unused files (63,947
lines): 90 dead files and 207 hand-run tools of finished plans. 2,157 values
and 1,783 types are exported but not used outside their file; remove the
`export`. The false-positive rate was 10–15 %, so check each file before you
delete it.

**Duplicate code.** jscpd found 1,654 clones in product code (2.5 % of the
lines, 60,739 lines inside a copy) and 743 clones in tests. One shared copy
for each clone family saves about 32,000 product lines and 12,900 test lines.
The largest merges:
1. Browser journey helpers in 95 scripts (about 3,090 lines) into
   `scripts/lib/browser-journey.mjs`.
2. The recipe workspace shell in 12 Portal views (about 2,960 lines) into
   `production-run/shared/recipe-workspace.tsx`.
3. The recipe three.js scenes (about 1,580 lines) into
   `appliance-sample-three.ts` and a new `shared/cobot-rig.ts`.
4. The Commerce command prologue in 27 files (about 1,355 lines) into
   `commerce-authority/merchant-command.ts`.
5. The control route mutation boilerplate in 55 files (about 1,110 lines) into
   `control/admission/control-mutation.ts`.

Helper copies: 24 renamed `assertNever`, 17 `isRecord`, 23 SHA-256 helpers, 9
`decodeBase64Url`, 16 `sleep` and 17 backoff formulas. Add `isSha256Hex`,
`decodeBase64Url`, `sleep` and `backoffDelay` to `@seams/std`. Extend
`scripts/check-shared-helpers.mjs` to `.mjs` files and to renamed copies, so
that the lint catches them.

**Legacy code.** Few files say "legacy". The legacy is in whole subsystems:
- File-native product folders (AD-041 deferred them, AD-048 deleted their
  plans): the tool `workspace_product_folder_update`, its capability,
  `crates/workspace-executor/src/file_native.rs` and its binary, about 1,500
  lines and 2 tests.
- The Plan 13 runtime cutover: `authoritative-runtime-cutover.ts` and 175
  lines in 19 files. Plan 13 closed on 27 July 2026. It needs a D1 patch.
- Dormant Plan 33B supplier payouts: 6,291 lines in 18 files.
- The Plan 46 synthetic evaluation API, the retired harness backends
  `picocodex` and `codex`, the `SurfaceActor` and `ThreadActor` relics.
- About 45 adapters in 14 files that read rows from before a plan, and the
  Commerce schema chain from 66 to 90. The owner's rule is "no adapters for
  damaged legacy data". A read-only production census first shows which old
  rows still exist.
- The `SATYR_WARM_ACTOR_SLOTS` switch of a released feature.

**Tests.** 1,134 test files and 443,652 lines. The policy in AGENTS.md
classes 19–27 % of the lines (85,000–118,000) as tautological, change
detectors, unit tests of internal detail, retired, or E2E fault cases that
run once for each internal step.
- The Platform unit suite fails 58 tests in 20 files. The Plan 91 codemod
  (`d241e969d`) caused 49 of them: it renamed the mocked functions but not the
  keys in `vi.mock` factories. Nobody saw it, because the suite could not
  start. Triage: fix 29 tests, delete 29 tests (about 1,500 lines).
- The Plan 88 E2E failures (J4, J7) come from an old account Worker artifact
  (27 October). Rebuild it from seams-monorepo `aee87e9a` or later.
- Clearest deletions: `code-mode-admission`, `workspace-execution-coordinator`,
  `optimization-1-benchmark`, `portal-access-route`,
  `agent-session-commerce-cancellation`, `commerce-outbox-worker`,
  `case-context-discovery-route` and `actor-journal-transaction` (after a
  check that two E2E journeys cover its quarantine case).
- Fold the E2E fault cases to one case per outcome (about 25,000 lines).

## Cutover

1. **Build.** Build the phase 1 tree in a scratch repository. Upload the R2
   files (about 1.27 GB). Add an R2 fetch to the CI jobs that need assets.
   Run the checks.
2. **Freeze.** Tell every session: land or park open work. `dev` stays still
   for about one hour.
3. **Archive.** Rename `seams-tech/pantry` to `seams-tech/pantry-history`.
   GitHub keeps its pull requests and Actions history.
4. **Create.** Create `seams-tech/pantry` (private). Push the import commit to
   `main` and `dev`. Add the `run-ci` label and the draft pull request.
   Archive `pantry-history`.
5. **Local.** Clone to `~/Dev/lowerarchy/pantry` and copy the Claude memory to
   its project folder. Point `~/Dev/lowerarchy/seams-atelier` and its
   worktrees at `pantry-history`, so that no old branch can push the old
   history into the new repository.
6. **Port.** Move open branches with a port script: the diff of the branch
   against its old base, without the paths that the import left out, applied
   to the new `dev`.
7. **Release.** The next production release comes from the new repository.
   Worker names and bindings do not change.

## Risks

- **The old history can come back.** A clone of the old history that pushes a
  new branch to the new repository uploads all 4,131 commits. GitHub cannot
  refuse it on the free plan. Step 5 points every old clone at the archive.
- **Old commit hashes.** Plans, memory and evidence name commits of the old
  history. They resolve in `pantry-history`.
- **R2 for every build.** A Portal build and the native Kitchen build need an
  R2 fetch, with a Wrangler sign-in or a token. CI needs a read-only R2 token
  as a secret.
- **The GitHub rename to `purin-io`** comes later and moves the new repository
  with the organisation. It does not change this plan.

## Decisions for the owner

1. The archive name. Default: `seams-tech/pantry-history`.
2. Large files in R2, and a read-only R2 token as a CI secret. Default: yes.
   The owner makes the token in Cloudflare, or lets me make it.
3. Closed plans and evidence stay in the archive only. Default: yes.
4. Legacy subsystems in phase 2: delete file-native product folders and the
   Plan 13 cutover (default: delete); Plan 33B payouts and the Plan 46
   synthetic evaluation (default: ask again in phase 2); Plan 61B stays on hold.
5. A read-only production census for the old-row adapters. Default: yes.

## Cost

- Phase 1 and the cutover: about one day of my work, mostly the R2 upload and
  the checks. About 15 minutes for the owner: the R2 token and two approvals.
- Phase 2: about 4 to 6 days of work, in parallel sessions after the cutover.
  Duplicate merges and test cleanup are the largest parts.
- Done before the cutover: the Platform unit suite passes (old `dev`
  `b920dc575`: 28 cases fixed, 30 weak cases deleted, no product change).

## Built (18 November 2026)

- **R2.** 3,341 files (1.16 GiB) are in R2: the Kitchen models in `assets/` and
  the equipment manuals. The pinned Kitchen bundles stay in git, because
  `pnpm lint:physics-bundle` requires it for the bundles that tests name.
  `scripts/repo-binaries.mjs` runs 8 transfers at a time (`--jobs`) and keeps
  a local cache by SHA-256 (`~/.cache/repo-binaries`).
- **The import.** 5,446 files and 224 MB, from 12,154 files. 591 Markdown links
  to files that the import left out point to `seams-tech/pantry-history` at the
  source commit. Four E2E helpers moved from `services/platform/scripts/plan55*`
  to `services/platform/tests/e2e/`, and four Portal models from `output/` to
  `apps/portal/src/features/production-run/models/`.
- **Porting.** `bash scripts/plan-92-port.sh <old checkout> <branch> [<old
  base>]` moves open work from the archive as one patch. It follows the moved
  files and lists the changes to paths that the import left out.
- **CI.** Both jobs fetch the R2 files with a read-only key. The owner adds the
  secrets `R2_READ_ACCESS_KEY_ID`, `R2_READ_SECRET_ACCESS_KEY` and
  `R2_ENDPOINT`. Until then, and until the Actions budget allows a run, CI
  cannot run.

## Phase 2 results: unused and legacy code (18 November 2026)

Seven workstream commits on `dev` remove 37,459 lines and add 3,768 outside
`docs/` (net 33,691 fewer lines) in 1,068 files; 111 files are gone.
Production did not change: no deploy and no write. A read-only census (`wrangler d1 execute --remote`,
SELECT only) of the production global and regional databases decided each
legacy removal.

| Workstream | Commit | Files | Lines removed (net) | What went |
|---|---|---|---|---|
| Unused files | `af06012` | 98 (88 deleted) | 18,701 | Knip and an import check on the new tree found 207 unused files; a hand check kept the ones that a plan, runbook or type check names. Deleted: browser journeys and probes of finished plans, the Plan 53 identity cutover tools, `scripts/plan-54`, 23 unused package subpath exports, the Plan 70C contract example and an unused dependency. |
| Plan 13 runtime cutover | `4d04bd2` | 30 | 1,662 | The cutover module and every gate (Slack ingress, Connector, queues, provider routes, identity links, webhooks, reconciliation). Every Organisation was forward-only. The seven `organisation` cutover columns and their index left both baselines. |
| Warm actor slots switch | `816a0a3` | 7 | 5 | `SATYR_WARM_ACTOR_SLOTS`; every Connector keeps its warm slots. |
| File-native product folders | `4ebf423` | 56 (17 deleted) | 9,138 | The tool, its capability, `file_native.rs` and its binary, the executor's JSON product path, the workspace execution coordinator (2,706 lines), the product changeset revision kind and the Plan 50 "workspace" group. |
| Old-row adapters | `aff2272` | 23 | 556 | Chat rows from before the timeline, the old Gmail product mapping, the costs plan runtime ALTER, the pre-Plan 89 held output id, and the SurfaceActor and ThreadActor relics. |
| Unused exports | `23d1f2f` | 877 | 2,183 | `export` removed from 3,539 values and types that only their own file used; declarations that no file used are deleted. |
| Plan 46 synthetic evaluation | `ab8335f` | 13 (3 deleted) | 1,470 | The owner's answer of 18 November 2026: the `synthetic-evaluation` route operation, its Organisation Actor command and module, the hand-run evaluation script, its unit test and eight synthetic placement journeys. Configuration, screen observations and the operational evaluation stay. |

**Proof.** Each commit passed the platform, test and E2E type checks, the
lints, the unit suites and the E2E files near its change. After all of them,
the full E2E suite passed 533 tests in 247 files. It failed the three known
Plan 88 journeys (J4, J7: an old account Worker artifact) and the placement
move journey, whose fixture relied on the cutover gate; the next commit gives
that fixture's second Organisation a policy, and the journey passes.

**Applied with the release of 19 November 2026** (`satyr-edge` `fd4df928`,
from `dev` `15c32c9`; each patch names its databases):
1. `services/platform/scripts/plan-92-product-folder-capability-d1-data-patch.sql`
   on the regional database, right after the release: the Access read refuses
   the two old policy rows of the removed capability. The two rows are gone.
2. `services/platform/scripts/plan-92-runtime-cutover-drop-d1-patch.sql` on the
   global and the regional database. The seven cutover columns and their
   index are gone, and the remote schema check passes.

**Kept, with the reason.**
- Plan 33B supplier payouts: the owner decided on 18 November 2026 to keep
  them ("Delete 46 only").
- Adapters whose old rows exist: chat Kitchen context v1 (12 parts), chat voice
  parts with no engine (9), Square OAuth credentials (3 accounts), the `codex`
  backend id (removed 18 October, after the actor storage restart of
  9 October). The context projection `model_text` fallback is not an adapter:
  the file projection writer still leaves the column empty.
- Adapters that D1 cannot count: every Durable Object storage upgrade
  (Organisation, Session, Case, Connector, DeviceFleet), the Commerce schema
  chain 66 to 90 and the other Commerce storage readers, and the R2 saved-run
  chains. Each needs an in-actor read, or the Commerce admin endpoint
  `GET /v1/admin/merchants/{id}/migration-inventory`, which is outside the
  approved D1 census.
- Client-compatibility readers (old Portal tabs, shop Macs, TV players,
  bookmarks): they read wire messages, not stored rows.
- The D1 CHECK lists still name the actor kinds `surface` and `thread`; a CHECK
  change needs a table rebuild in production.
- The Code Mode receipt keeps its workspace fields (always unused and null),
  because the receipt shape is signed.
- 147 type re-exports in `packages/contracts/src/index.ts` that no package
  imports, and 332 re-export lines that knip reports: they need a decision on
  the public surface of each package.

## Phase 2 results: tests (19 November 2026)

Five commits on `dev` remove 13,637 lines and add 2,568 in
`services/platform/tests` (net 11,069 fewer). Outside the tests, 784 lines
go (the benchmark runner, its two root scripts and CI step, and the `export`
of four functions that only deleted tests imported), and 21 lines come (16 of
them the account Worker check). No product behavior changed. No deploy.

| Workstream | Commit | Test lines removed (added) | What changed |
|---|---|---|---|
| Clearest weak tests | `95f4acf` | 4,878 (74) | `code-mode-admission`, `optimization-1-benchmark`, `portal-access-route`, `case-context-discovery-route` and `actor-journal-transaction` are gone. The new allowed/denied journey `e2e/case-context-discovery-access` replaces the route test. `e2e/session-quarantine-end` and `e2e/pi-sdk-actor` cover the journal test's quarantine case: a Session with an unknown effect stays quarantined and asks the model nothing more, and a recorded result reconciles once. |
| Account Worker check | `69a8378` | 0 (16 config lines) | `vitest.e2e.config.ts` refuses an account Worker that does not know both Jev prices, and tells how to rebuild it. |
| Board and WhatsApp journeys | `b96e879` | 776 (143) | `pi-menu-board-price` and `pi-menu-board-together` call `installBoardJourney`; `inbox-whatsapp` calls `whatsapp-connector-support`'s `installFixture({ inbox: true })`. |
| Mock-heavy unit tests | `f14a6fe` | 3,637 (78) | 49 files reviewed case by case; 47 cases and 2 files deleted (product mock calls, tautologies, or outcomes that a named journey asserts); mock-call checks removed from kept cases. The commit message names the journey for each deletion. |
| E2E helper copies | `7065a53` | 4,346 (2,273) | 105 groups of copied helper functions now import one home; 4 new support modules (`link-fetch`, `placement-move`, `commerce-journey`, `vault`). Some added lines are Prettier rewraps of old lines. |

**Proof.** The unit suite passes 314 files and 1,816 tests (1 skipped), with
no failure. The test and E2E type checks are clean. Each changed E2E journey
passed (about 120 files, in batches of at most eight).

**The account Worker.** The artifact at
`~/Dev/rust/seams-monorepo/.artifacts/shared-account-platform/account-worker/index.mjs`
is rebuilt from seams-monorepo `dev` `cb0b80eb` (after `aee87e9a`; it holds
nine unpushed console-server commits that only fail closed), SHA-256
`87403b7d…`. `e2e/plan-88-jev-features` passes 6 of 6 with it. The old
artifact (27 October) failed J4 and J7 (3 tests); the config now refuses it.

**Outcomes with no test now.** Their only cases asserted calls on product
mocks, so they proved nothing. Each needed a journey or a decision:
1. An Organisation's erasure empties every WhatsApp Connector before its rows
   go. Done on 19 November 2026: `e2e/whatsapp-erasure` purges an
   Organisation whose number holds a customer message, a reply draft and an
   open Case, and finds the Connector empty and no erased row left. With the
   Connector purge skipped, it fails.
2. An attachment preparation settles or cancels its executor allocation.
   Closed without a test on 19 November 2026, by the owner's decision. The
   risk is too small for a new fake executor in the E2E pool:
   - Each allocation reserves a fixed 250 micros ($0.00025), and the actual
     cost is always the reserved amount. The daily cap of an Organisation is
     25,000,000 micros.
   - An allocation that no code closes expires at its deadline plus 5 s
     (35 s at most), in the Organisation actor and in the platform governor.
   - The ledger counts a `turn_cancelled` cancel and an expiry at the full
     reserved amount. Only `admission_compensated` counts 0. So a missed
     cancel changes the state, not the charged amount.
   - A missed cancel holds one of the 4 platform executor slots until the
     allocation expires.

**Kitchen journeys (19 November 2026).** 22 rows of
`scripts/production-simulation/journeys.json` said "repaired on branch
ci-browser", but that branch is gone. A run on `dev` gave their real state:
one passes, 21 fail with a recorded reason. The index now holds 102 passing,
46 failing and 4 not-run journeys. Each failing row needs a repair or a
deletion, by the rule in `AGENTS.md`: keep it only if its outcome still
matters.

Done on 19 November 2026: every row passes. Of the 50 rows that did not
pass, 25 were repaired and 25 were deleted, and one row was added
(`tray-layout-drag-fallback-browser`). The index holds 128 journeys, all
passing; each commit message names the cover of a deleted row. A full run
of every tier on the same day passed all 128 rows (`arm-python` in a
checkout outside the main clone: a worktree nested in it cannot build
`bakery-native`). The run also showed that `oven-authoring-browser` passed
only with a fixture server started by hand; its row now starts the server
(`run.server` may name `tool: "tsx"`).

- Deleted, because a passing journey proves the same outcome: the Plan 42F
  rows `device-browser`, `ingredient-editor-browser` and `-artifacts`,
  `native-import-browser` and `-artifacts`, `production-browser` and
  `-artifacts`, `rehearsal-browser` and `-artifacts`; the Plan 42D row
  `spatial-inspection-browser` (two of its checks moved into
  `spatial-events-browser`); the Plan 61 and 70 rows `bakery-shift-browser`,
  `factory-overview-browser`, `ginger-tea-browser`,
  `material-history-browser`, `physical-recovery-browser`,
  `recording-pages-evidence` and `recording-pages-browser`,
  `recurring-logistics-browser` and `recurring-artifacts`.
- Deleted, because the outcome no longer matters or its input is gone:
  `financier-decision-browser` (its form is gone; the recurring financier
  code that no route could open went with it), `hosted-deployment-artifacts`
  (a manual hosted run), `recording-equivalence` (no journey wrote its
  inputs), `container-recovery` (a Docker image that no product path uses),
  `isaac-lab-import` (NVIDIA Newton) and `browser-chain-artifacts` (files of
  the old multi-tray engine).
- Repaired: `test-models`, `native-cli` (without the frozen Python
  recordings of the port to Rust, which it no longer needed),
  `timeout-recovery`, `ur5e-rack`, `cell-robot-bindings`,
  `automatic-context-browser`, `chat-production-browser`,
  `floor-plan-geometry-browser`, `operating-defaults-browser`,
  `recording-rehearsal-browser`, `rehearsal-faults-browser` and
  `-artifacts`, `spatial-events-browser`, `ur5e-rack-browser` and
  `-artifacts`, `tray-layout-drag-artifacts`, `artifact-import-browser`,
  `ginger-milk-tea-browser`, `pour-over-browser`, `recipe-split-browser`,
  `siphon-browser`, `six-hour-shift-browser`, `factory-canvas-browser`,
  `factory-controls-browser` and `morning-shift-browser`. Most followed
  moved Portal controls through the shared prelude; the others now read
  their inputs from the output of the journey that writes them.

The journeys found seven product faults, each fixed in its own commit:

1. `bakery-native resume` of a paused `load` wrote a plain recording, not
   the loading handoff, so an interrupted oven loading could not continue.
   It also caused the 20 GB run of `cell-robot-bindings`: a failed
   `deepEqual` of two recordings of several MB made Node build a diff of
   many GB. That journey now compares the native files by their bytes.
2. The simulator's "More simulator tools" menu, the only entry to
   Scenarios, Compare, the robot rehearsal examples and the shift finish
   time, had a 1-pixel trigger that a mouse could not hit and the Tab key
   skipped. It is a normal top-bar button now.
3. Without WebGL, a compact floor plan (the rack placement preview, a
   phone) showed its inspection card over the map, and the rack under it
   could not take a drag.
4. The recording viewer's plan measured a station differently from the
   simulator's plan, so the oven was 1.10 × 0.93 m in one and 1.10 × 0.85 m
   in the other. Both now measure the same footprint.
5. The factory toolbar ended 5 px under the Portal's top-end actions in the
   Split view.
6. The Factory view placed its canvas bar at a fixed 76 px for a one-row
   toolbar; the toolbar now has two rows and covered the Floor plan, 3D
   view and Split tabs. The bars now follow the measured toolbar.
7. The recurring financier comparison could never show: no route made its
   scenario. Its code is removed.

Open, for the owner (not changed here):
- A destination out of reach is refused with `actuator-limit` (FR10) or
  `joint-speed` (UR5e rack), not `unreachable`, since the limit checks of
  Refactor 16 step 7. A person sees a load or speed fault for a reach
  problem. The journeys expect the current reasons.
- The FR10 cannot hold the tray in every start pose of the combined cell,
  so its rack cycle stops at step 0; the UR5e, CR10 and CRX-10iA complete
  it. The combined-cell journeys use the UR5e.
- Other native journeys (`native-cli`, `ur5e-rack`) still compare whole
  recordings with `deepEqual`; a future mismatch there can use many GB of
  memory before it fails.
- `rehearsal-conversion.ts` still converts files of the previous
  multi-tray engine. It is also the Portal's current file opener, so its
  old-format branch needs a separate look.

**Product exports that only deleted tests used.** I did not change them,
because the duplicate-code workstream owns product code; that workstream
removed them (see "Phase 2 results: duplicate code"):
- `apps/portal/src/features/commerce/index.ts` re-exports
  `entityDossierQuery`, `readCommerceChanges`, `systemEntityRef` and
  `publishCommerceSavedViewPresentation`, and nothing imports them from there.
- `apps/portal/src/portal.tsx` re-exports `fetchWhatsAppSurface`, and nothing
  imports it from there.

**Copies left.** `observeProviders` (the copies bind different fakes), generic
helpers of six lines or less (`required`), the Portal session cookie header
that 54 journeys build, and small steering helpers (`readSteeringStates`,
`messageList`).

## Phase 2 results: the fold of the E2E fault cases (19 November 2026)

The owner said "do the fold" on 19 November 2026. Five commits fold the
fault families of 14 journeys from 170 cases to 130 (40 cases fewer). They
remove 971 lines and add 207 (net 764 fewer). No product code changed.

The rule (AGENTS.md, "Testing"): keep one case per distinct outcome, not one
case per internal timing window. For each family, the steps were grouped by
the outcome that a person or an operator sees, and each group keeps its
latest step before the effect, because that step crosses every fence before
it. A step stays when it has its own outcome, its own refusal code, or the
only check of its own operation.

| Journey | Commit | Cases | Lines removed (added) | What went |
|---|---|---|---|---|
| `mail-inbox` | `9e3df7d` | 48 → 41 | 289 (116) | Supplier draft preparation 7 → 4, mailbox watch steps 7 → 4, supplier proposal steps 7 → 6 |
| `organisation-case-context-collection-placement` | `cfe349d` | 26 → 14 | 210 (30) | TypeSafe configuration 7 → 4, operational discovery 7 → 4, Connector hydration 3 → 2, Organisation evidence 7 → 2 |
| `mail-operational-placement` | `cfe349d` | 12 → 9 | 42 (12) | Compose steps 11 → 8: edit, review and projection end like preflight |
| `portal-chat-finalization` | `dae338f` | 17 → 14 | 105 (6) | Attachment inspection 2 → 1, captured read authority 5 → 3 |
| `remote-mcp` | `dae338f` | 13 → 10 | 52 (8) | Connector origin 4 → 2, write control origin 4 → 3 |
| Origin journeys (`file`, `mail`, `airtable`, `case-proposal`, `message-link`, `action-mutation`) | `2d0f7e0` | 29 → 20 | 149 (24) | The credential decrypt points fold into the later commit point; `action-mutation-origin` keeps its 3 steps |
| `whatsapp-placement`, `projects`, `checkpoint-restart` | `7795573` | 25 → 22 | 124 (11) | The support read 2 → 1, two Projects share freezes, checkpoint admission 6 → 4 |

**Proof.** Each folded file passes in full. After the further folds below:
`mail-inbox` 37 tests (190 seconds),
`organisation-case-context-collection-placement` 14,
`mail-operational-placement` 9, `portal-chat-finalization` 13,
`remote-mcp` 10, the origin journeys 2 to 5 each, `whatsapp-placement` 8,
`projects` 7 and `checkpoint-restart` 4. The E2E type check is clean.

**The estimate was wrong.** The proposal expected 149 cases to become 34 and
about 25,000 lines to go. The real result is 40 cases and 764 lines. Two
reasons:
1. A parameterised family runs one journey function. A removed step frees
   only its own branch, its pause and its seed, not the shared setup and
   assertions, which are most of the lines.
2. Most steps are not timing windows of one operation. They guard different
   operations (an edit, a compose, a send, a credential refresh) or end with
   their own refusal code, so each is a distinct outcome and stays.

**What lost its own case.** The kept later step still crosses each of these
fences, and the evicted source still refuses each operation, but no case now
pauses at these points:
- a revocation at the credential decrypt (Airtable, mail and file origin
  journeys), the redirect follow of a message link, and the file search
  observation;
- the mailbox watch activation, renewal and reconnect (the reset stays), and
  the frozen `watchExpiresAt` that only activation and renewal asserted;
- the in-flight prepare, validate, readiness and review checks of the
  Organisation evidence commit, and the active check after the policy
  request digest;
- the supplier draft's frozen Gmail read and Case ensure.

**Further folds.** The first fold kept each step that was the only test of a
separate product check. The owner then said "do the further folds too" (19
November 2026), and accepted the loss of those checks. Four commits remove
543 lines and add 97, and 8 cases and 4 steps go:

| Journey | Commit | Cases | Lines removed (added) | What went |
|---|---|---|---|---|
| `portal-chat-finalization` | `3f2879e` | 14 → 13 | 50 (3) | `catalog_commit` folds into `saved_commit`, whose commit crosses more checks |
| `whatsapp-placement` | `550e1d0` | 11 → 8 | 210 (34) | The edit and compose commit steps fold into `credential`; the preview freeze folds into the panel freeze |
| `projects` | `22cc1c2` | 7 → 7 | 174 (40) | The rename, draft and read freezes fold into the pin freeze; the move freeze folds into the create freeze |
| `mail-inbox` | `7e5d1db` | 41 → 37 | 109 (20) | Five stale-evidence causes fold into `provider_erasure`, which passes every send check before the Gmail read |

No case now covers these points:
- a revocation at the integration catalog commit;
- the revoked-origin refusal of a WhatsApp proposal edit or of a human
  compose, and the WhatsApp preview read during a freeze;
- a freeze of a chat rename, a draft save, a read advance or a chat move;
- a stale reply after a relationship detach, a direct source erasure, a
  contact verification revoke or a TypeSafe disconnect (unit tests and the
  TypeSafe journeys still cover the revoke and the disconnect themselves).

**Both folds together.** 14 journeys go from 170 fault cases to 122, and
1,514 lines go and 304 come (net 1,210 fewer). No product code changed.

## Phase 2 results: duplicate code (19 November 2026)

26 commits on `dev` remove 25,944 lines and add 16,046 outside `docs/` (net
9,898 fewer) in 566 files. jscpd 4 (`--min-tokens 70`, product code apart
from tests) found 885 clones with 18,610 duplicated lines (2.3 %) on `dev`
`f94fc5e`; it now finds 491 clones with 8,010 lines (1.0 %). The scan
excludes generated code, bundles and `apps/portal/public`, so its numbers
are lower than the first scan of the old tree. No API, wire frame, stored
shape, status code or error text changed. No deploy.

| Merge | Commit | Lines removed (added) | Where the shared code is |
|---|---|---|---|
| Browser journey helpers (about 90 scripts) | `2375b81` | 4,123 (1,590) | `scripts/lib/browser-journey.mjs`, `fixture-worker.mjs`, `side-worker.mjs`, `cli.mjs`; the bakery prelude `simulator-navigation.js`; `production-simulation/execution-journey.mjs` |
| Recipe workspace shell (9 workspaces, 14 authors) | `24eba23` | 6,008 (3,529) | `production-run/shared/recipe-workspace.tsx`, `recipe-station.tsx`, `recipe-form.tsx`, `induction-hob.ts` |
| Recipe three.js scenes | `871b7ca` | 1,901 (1,434) | `production-run/appliance-sample-three.ts`, new `shared/cobot-rig.ts`, `scene-host.ts` |
| Commerce command prologue (about 60 sites) | `024413c` | 4,578 (2,883) | `commerce-authority/merchant-command.ts`, `http/buyer-access.ts`, `scripts/merchant-script.ts` |
| Control route mutations (38 routes) | `3205be6` | 3,980 (2,293) | `control/admission/control-mutation.ts`, `control/commerce-merchant.ts`, `admission/organisation-socket.ts`, `routes/integrations/account-request.ts` |
| Portal CRDT socket clients (6 clients) | `b12678e` | 2,452 (2,394) | `features/collaboration/document-client.ts`, `commerce/stock-dialog.tsx` |
| Canvas and draft sync protocols | `589c36a` | 690 (271) | `createSyncProtocol` in `@seams/collaboration` |
| Copies of exports | `5961bd7`, `e0b58d5`, `bbf9775`, `9c180e0`, `1b82009` | 457 (184) | The address and currency tables of `commerce-contracts`; one `ArchiveConfirm`; one `readCookie`; the agent operation commands of `control-api`; five re-exports that nothing imports |
| `Extract<U, { kind }>` to `Variant` (389 sites) | `1b0b70d`, `b1bd2b1`, `03da1d6` | 868 (674) | `@seams/type-utils` |
| Helper copies | `4c9f1a1`, `6d205c2`, `c2ddfae`, `c94d892`, `7936cca`, `3060c87`, `c93e2c9`, `a4e9d56`, `c769959` | 814 (500) | `@seams/std` gains `sleep`, `backoffDelay`, `isSha256Hex` and `decodeBase64Url`. Replaced: 21 renamed `assertNever`, 9 SHA-256 hex checks, 20 SHA-256 hex digests, the strict base64url decoders, 3 `sleep`, 5 Platform backoff formulas and 3 `isRecord` (the script and CRDT client merges replace 7 more `sleep`, 3 more `isRecord` and the Portal backoff formulas). The lenient Gmail, Pub/Sub and JWT decoders share `services/platform/src/lenient-base64.ts`. |
| The lint | `15f41be` | 32 (246) | `scripts/check-shared-helpers.mjs` |
| File-size cap | `e4d45e4` | 49 (56) | `production-run/draft-placement.ts` |

**The lint.** `node scripts/check-shared-helpers.mjs` now reads `.mjs`,
`.js` and `.cjs` files too. It finds a renamed copy of `assertNever`,
`isRecord`, `sha256Hex`, `isSha256Hex`, `decodeBase64Url` or `sleep` by its
form, an inline backoff formula, and `Extract<U, { kind: K }>`. The name rule
covers tests; the new rules cover product code. `--list` prints every finding.
One `Extract` is allowed with its reason: the generic sync protocol factory.

**Proof.** After the rebase on the test cleanup, every lint, the Platform,
test, E2E, Portal, Commerce and package type checks, the Platform unit suite
(1,816 tests), the Commerce suite (202 tests), the Commerce lab (54 tests)
and the Portal build pass. Each merge also passed the E2E files near it
(about 80 files: the control routes, the canvas and draft rooms, Gmail,
ChatGPT sign-in, approvals, WhatsApp, custom connectors, merchant binding).
Byte-for-byte or fuzz comparisons of old and new code cover the sync frames,
the decoders and digests, the cobot kinematics and the pastry meshes. The
bakery browser journeys (16) and the Plan 84 and Plan 40B harness journeys
pass, apart from the failures below. `mail-inbox` and `remote-mcp` each
failed one timing step while other runs loaded the machine; on a quiet
machine both pass (51 tests).

**Failures that `origin/dev` has too.** `workflow-edit-browser` (the "pour"
stage never becomes current), `engine-visits-browser` (an empty JSON
response) and the Plan 74 side Case harness journey (the simulated model gets
no call, and the reply never shows) fail the same way on `origin/dev`
`f14a6fe`. The Portal unit test
`schedule.test.mjs` fails because `packages/control-api` imports relative
paths without `.ts` (for example `./surface-observation` in
`surface-command.ts`), which `node --test` refuses. Later commits fixed all
four: `3424f12` (a scrub shows the stages at the scrubbed time again),
`89facfb` and `38c684c` (the runner serves the built Portal), `c9fd14e`
(fixture Workers refuse Commerce calls by default) and `fea24f8` (`.ts`
imports in `control-api`).

**Kept, with the reason.**
- The Commerce digest branches in `ledger.ts`: their JSON key order is part
  of stored digests.
- Copies whose behaviour differs: the generic control route head (about 100
  routes, a mass rewrite), Commerce commands with their own replay
  (`adjustOfferPrice`, `observePaymentDispute`, `quoteShipmentLabelRate`,
  `refundOrderTenders`), the siphon, café shift and pastry engines, the TV
  player socket (another protocol), the Python-run `run-code` journeys (no
  prelude), and small pairs under 20 lines.

**Done after the merges.**
- `messages/derived-stills.ts` decodes with the `decodeBase64` of
  `@seams/std`. A frame that does not decode fails with
  `derived_still_integrity_failed`, as a frame with a wrong digest does.
- The generated action registry imports `isRecord` and `assertNever` from
  `@seams/std`, and the helper lint now reads generated sources. Fix a
  finding there in its generator.
- `showOnEachUpdate` is removed. In five recipe views (black sesame, ginger
  tea, financier batter, bake and pack), each render sent the last frame
  batch again, so each camera click replayed that batch from its first
  frame. A probe on `recipe-playback-preview.html` counted 4 replays for 4
  clicks after a completed financier pack run before the change, and none
  after it. Each of the five scenes applies its stored frame when it loads,
  so no view needs the re-send. `RecipeSampleStation` still sends its
  samples on each update, but the pour-over and espresso scenes ignore a
  batch that does not move forward.

## Phase 2 results: the low-impact test sweep (19 November 2026)

The owner asked for a sweep of tests whose value is low for their cost.
Five reviewers read all 676 test files at `bee3ced` and sorted the
candidates into batches A to E. The owner said "Remove those low impact
tests, and dead product paths", then "Remove batches A to D". 16 commits on
`dev` remove 23,260 lines and add 1,715 (net 21,545 fewer): tests 19,155
(1,693 added), product code 4,087 (8 added). No deploy: the product
removals ship with the next release.

| Batch | Commits | Lines removed (added) | What went |
|---|---|---|---|
| B: dead product paths | `e19ff60`, `d9053b0`, `6fee58a`, `6324415` | 6,570 (18) | The one-time credential closure audit (script, admin route, Actor code, 4 test files); the café and shipping operations control routes; the bakery oven `assignment` mutation; the unread history budget warning list and `gmailProcessingDescription` |
| A: tests only, high confidence | `03fc4ba`, `c95aadb`, parts of `561ca10` and `87865d8` | A and D together: 14,519 (1,480) | `control-route-budget` (asserted only HTTP 200), `linea-shared-run`, `machine-census-ages`, `slack-file-batch-archive`, `pi-menu-board-prompt`, the JP-to-Singapore case of `commerce-authority`, the storefront copy cases, and duplicate Portal and WhatsApp unit cases |
| C: repairs of old stored states | `4187415` | 1,990 (113) | `case-assignment-wake`, `case-old-rows-wake`, `purged-organisation`, `chat-origin`, the old cases of `session-quarantine-end` and `chat-kitchen-observation`, Square step 5, the `public-links` erase, the Codex device sign-in cases |
| D: medium confidence | `4d964a7`, `5ba5132`, `4713add`, `30af8bf`, parts of `561ca10` and `87865d8` | (with A) | Latency and counter journeys (`slack-new-thread-actors`, `slack-answer-before-projection`, `slack-conversation-residency`, `session-cutover-continuation`), the 1,500-line fake Underclerk of `commerce-entity-plane-parity`, the wiring cases of `harness-tool-catalog`, `vault-onepassword-reconnect`, `home-page-state`, `vault-alert-signals`, the Kitchen and menu board peers |
| Merges | `9d9d244`, `0af011c`, `b39c5e7` | 199 (122) | Three exports made private; `gmail-after-deletion` uses the shared purge steps; one page command reader for the chat journeys |

Before a delete, each check that only the deleted test had moved into the
kept test: for example the five shipping checks into
`plan33-core-acceptance`, the offer price limits into
`offer-price-commands`, and the erased tables of `purge-catalogue-erasure`
into `purged-organisation-reclaim`.

**Proof.** On the final tree: the Platform, test and E2E type checks, the
commerce engine type check, `pnpm lint` and `git diff --check` pass. The
Platform unit suite passes 302 files and 1,732 tests (1 skipped; it was 314
files and 1,816 tests), the commerce engine suite 84 files and 174 tests,
the storefront 17 tests, the simulator 6 tests, and `cargo test` for
`media-inspect` and `workspace-executor` 30 tests. Each changed E2E journey,
and each journey that received a moved check, passed in batches of at most
eight.

**Kept against the sweep, with the reason.** Each removal checked its
claim first. These parts were the only check of an authorization, money or
data outcome, so they stay:
- the GMO `stera` case of `counter-register-journey`: the busy-terminal
  refusal, the `result_unknown` lock and the owner-only manual cash refund
  that Square FeliCa sales use;
- the bakery `operation` mutation (`bakery-runs` and the oven authoring
  server call it);
- the expiry and requester cases of `operator-configuration-draft` (the
  Portal routes reach those checks only through `confirm`);
- the lost-lease fences of `durable-codemode-recovery`, the newer-version
  guard of `user-preferences`, the cross-merchant guard of
  `product-sales-http`, the foreign-currency refund threshold, the demo
  provisioning replay, the canonical shipment ids of `commerce-low-stock`
  and the manual dispatch grants of `schedule-dispatch`.
Batch E (large shrinks of money-path files) was not done, and the Plan 33B
payouts stay by the owner's decision of 18 November.

**Product code with no test now.**
- Adapters for old stored states, for the Plan 93 cutover: the purged
  Connector erase (`erase_purged_connector`, `canErasePurgedConnector`,
  `erasePurgedOrganisationState`, the `tenant_id` read), whose
  `organisation_purge_not_due` refusal lost its only test; the lapse of an
  old approval wait (`case-alarm.ts`); the quarantine end with no Code Mode
  settlement (`session-turn-recovery.ts`); the old Kitchen observation, v1
  page view and `surfaceContext` paths; the Square token hand-over; the
  `public-links` erase; the menu board `style` key for an old TV player;
  the `codex_device` allowance, pause and refresh paths.
- Current code, small harm accepted: `reserveDeviceWork` and its task alert
  cards (no caller until Plan 24 dispatch), the 1Password item-list cache
  key, the residency Actor stop on a freeze, the suggested home region, the
  wording of `connectionAttentionMessage` and `renderOperatorNotice`.

**Open items.**
- Done on 19 November 2026, by the owner's decision: the history budget
  warning rows are gone. A Session that passes its history warning level
  now only writes the `session.harness_history_budget_warning` trace line,
  with no call to the Organisation Actor and no Durable Object row. The
  Organisation Actor drops the old table when it starts.
- `DeviceFleetActor.clearTerminalResultUnknown` has no caller. Plan 90
  decides if an operator action needs it.
