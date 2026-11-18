# Plan 92 — A new pantry repository

Status: phase 1 and the cutover done on 18 November 2026 (owner: "Yes, start", with the default decisions); phase 2: unused and legacy code done on 18 November 2026 (see "Phase 2 results"); duplicate code and tests open.
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

**Apply after the next release** (each patch names its databases):
1. `services/platform/scripts/plan-92-product-folder-capability-d1-data-patch.sql`
   on each regional database, right after the release: the Access read refuses
   the two old policy rows of the removed capability.
2. `services/platform/scripts/plan-92-runtime-cutover-drop-d1-patch.sql` on the
   global and each regional database. The patched schema equals the new
   baseline (tested on the old baselines).

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
