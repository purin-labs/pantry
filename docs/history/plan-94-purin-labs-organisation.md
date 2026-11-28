# Plan 94 — Pantry moves to the GitHub organisation `purin-labs`

Status: closed on 28 November 2026. Each step is done or is not needed for
Pantry (see "Steps", checked on 28 November 2026 at dev `f6dd43ff`). The
repository is `purin-labs/pantry` (public on 28 November 2026), all
workspace packages use `@purin-labs/*`, the old `satyr` repository is
archived and the old clone is deleted (see "Done").

Changes after 20 November 2026:

- [Plan 95](../plan-95-pantry-own-accounts.md) step 4 (21 November 2026,
  dev `396278ef`): Pantry no longer binds the Console. Pantry CI, the E2E
  suite and the Platform need no Console Worker, no
  `PANTRY_ACCOUNT_WORKER_ARTIFACT` and no checkout of the Console
  repository. "What crosses the line" below is history.
- Refactor 260 of the Console moved `purin-labs/monorepo` to
  `seams-tech/seams-console` on 21 November 2026, with the same repository id
  `1366871528`. The Console is a Seams product, apart from Purin. The Purin
  company site is now `purin-labs/purin-monorepo`.
- [Plan 93](plan-93-clean-cutover.md) step 2 (21 November 2026) renamed
  the group B names, and the old stack is deleted since 22 November 2026.

The owner decided on 19 November 2026:

- "I'm thinking we keep Seams Wallet related stuff on the github seams-tech
  org. Then the Purin Pantry, and related products move to the purin-io
  orgnisations on github." Then: "Yes, plan the split".
- "rename our current folder from purin-io to purin-labs. I've secured github
  org: purin-labs, and npmjs org purin-labs."

This plan replaces the organisation rename `seams-tech` → `purin-io` that was
set for 20 November 2026. That rename did not happen, so nothing needs to be
undone. The organisation `purin-io` was never made on GitHub.

## The split

| Organisation         | Brand | Repositories                                                                                                               | Local folder       |
| -------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `seams-tech` (stays) | Seams | `seams-wallet`, `speak-to-sign`, `seams-sdk` (archived). Also the archived history of Pantry: `pantry-history` and `satyr` | `~/Dev/rust`       |
| `purin-labs` (new)   | Purin | `pantry`, `monorepo` (moved from `seams-tech/seams-monorepo`: site, Console, wallet deploy)                                | `~/Dev/purin-labs` |

The npm organisations follow the same line. The wallet packages keep the
`@seams` scope. `@purin-labs` is for Purin packages; Pantry publishes none
today. The npm organisation `purin-io` (made on 18 November) is not needed.

**The brand rule (decision 1).** The brand follows the code owner. Code in a
`seams-tech` repository uses Seams names. Code in a `purin-labs` repository
uses Purin names after the brand rename. So:

- Seams keeps the wallet products: Seams Auth, the MPC wallet, Seams Pay
  (signed payment approvals), VoiceID and Voice Hanko (`@seams/voiceid`,
  speak-to-sign), and the `@seams/checkout` package of Refactor 250.
- Purin gets what Pantry builds: Pantry, Sous Chef, Gantry, Regi, the
  built-in checkout of Pantry (today "Seams Checkout", which also clashes
  with the wallet's `@seams/checkout`), and the Vault store of Plan 79.

### What crosses the line

Pantry uses Seams as an outside platform. None of these needs a change for
the move:

- The Console (`seams-sdk-d1-console`) creates organisations and members for
  Pantry. People sign in to Pantry through it (decision 2).
- Pantry CI checks out `purin-labs/monorepo`. That repository is public, so
  the workflow needs no token.
- Local E2E runs need `PANTRY_ACCOUNT_WORKER_ARTIFACT`, built from
  `~/Dev/purin-labs/monorepo`, and `PLAYWRIGHT_MODULE` from seams-wallet.
- [Plan 93](plan-93-clean-cutover.md) still renames the Console service id
  `satyr` in `purin-labs/monorepo`.

## Facts (19–20 November 2026)

**The new organisations.** The GitHub organisation `purin-labs` exists (Free
plan, made on 19 November; org id `358632792`). The npm organisation
`purin-labs` exists.

**What stays the same.** Nothing in `seams-wallet` or `speak-to-sign` changes:
the npm packages and their trusted publishers, the wallet links, the
speak-to-sign hackathon links and the `seams.sh` site stay in `seams-tech`.
`seams-tech/seams-monorepo` moved to `purin-labs/monorepo` on 20 November
2026 (public, repo id `1366871528`, immutable OIDC subject prefix
`repo:purin-labs@358632792/monorepo@1366871528`).

**The pantry repository** (private, on the Free plan):

- 3 repository secrets: `R2_ENDPOINT`, `R2_READ_ACCESS_KEY_ID` and
  `R2_READ_SECRET_ACCESS_KEY`. Secrets move with a transferred repository.
- No webhooks, deploy keys, environments, branch protection, rulesets, Pages
  or OIDC.
- One open pull request, #1 (`dev` to `main`, the CI gate). It moves with the
  repository.

**The other two repositories.** `pantry-history` is archived (1.3 GB).
`satyr` is not archived (1.4 GB). The owner unarchived it on 18 November;
all its commits are in pantry.

**GitHub transfer rules** ([GitHub docs](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository)):

- Web links and `git clone`, `fetch` and `push` on the old address
  redirect.
- The docs say nothing about API calls on the old name. Scripts must use the
  new name.
- A new repository at the old address deletes the redirect. Never make a new
  `seams-tech/pantry`.
- Secrets, webhooks and deploy keys stay with the repository. The rules of
  the new organisation apply to members and their rights.
- The docs say nothing about archived repositories. If GitHub refuses one,
  unarchive it, transfer it and archive it again.

**GitHub Actions.** `seams-tech` is on the Free plan, has a $0 budget, and
`seams-tech/satyr` used all private minutes of November. A Free organisation
gets its own 2,000 private minutes each month. So in `purin-labs`, Pantry CI
can run before 1 December.

**Links in pantry.** 10 files outside `docs/` and 75 files in `docs/` link to
`seams-tech/pantry-history` (most are pinned links to evidence files). The
Portal shop footer links to the organisation page `https://github.com/seams-tech`
(`apps/portal/src/features/ecommerce/footer.tsx`).

**Not checked.** The GitHub token here cannot list the apps that are
installed on `seams-tech`. The owner checks them.

## Done (19 November 2026)

- The folder `~/Dev/purin-io` is now `~/Dev/purin-labs`. It holds `pantry`
  and `say-so`. A symlink `~/Dev/purin-io` → `purin-labs` stayed for some
  hours, for the sessions and dev servers that ran in the old path. It is
  gone now.
- `git worktree repair` fixed the worktree of the clone. The clone has no
  stash.
- The memory folders of the old paths are copied to
  `~/.claude/projects/-Users-pta-Dev-purin-labs/memory` and
  `-Users-pta-Dev-purin-labs-pantry/memory`. The old folders stay for the
  sessions that still run in the old path.
- The pantry docs that named `~/Dev/purin-io` name `~/Dev/purin-labs`.

### The transfer (19 November 2026)

The owner said: "let's focus just on migrating satyr to purin-labs/pantry,
and cleaning up the legacy code from satyr". So only `pantry` moved.

- `seams-tech/pantry` is now `purin-labs/pantry` (transfer through the
  GitHub API). The old web, git and API addresses redirect. The three R2
  secrets and pull request #1 moved with it. Actions is on.
- The clone `~/Dev/purin-labs/pantry` has the new `origin`. The symlink
  `~/Dev/purin-io` is gone, so the pnpm links were installed again.
- `seams-tech/satyr` is archived again. It stays in `seams-tech`, with
  `pantry-history` (decision 3).
- All 27 workspace packages in `purin-labs/pantry` are renamed from
  `@seams/*` to `@purin-labs/*` (`scripts/rename/plan-94-package-scope.mjs`),
  and `pnpm-lock.yaml` is regenerated. The vendored Seams Console package
  `@seams-internal/console-shared` stays in its Seams scope.

### The old `satyr` repository and clone (19 November 2026)

Checked, so that nothing is lost:

- Each commit of `seams-tech/satyr` after the last port base (`80b2bd9f0`),
  and each commit of its local branch `refactor-16`, is in pantry by
  content. The step 13 evidence is in `pantry-history` (branch `dev`).
- The old clone `~/Dev/lowerarchy/satyr` held two edits that no commit had:
  the drawer rule in AGENTS.md and the Side drawer section of the Portal
  `ui/README.md`. Both are in pantry now.
- The pantry clone had no local secret file, so local development still ran
  from the old clone. Nine git-ignored files are copied to the pantry clone
  (`.env`, `.env.local`, `.env.local.production`, `.env.local.slack`,
  `.env.local.whatsapp`, two `services/platform/.dev.vars.local*` files and
  two `services/commerce/.dev.vars.*` files). Their `SATYR_*` keys are now
  `PANTRY_*`, as the code reads them. The local secret check of the
  Platform passes in the pantry clone.
- The session handoffs of `.artifacts/handoffs` are copied to the
  git-ignored `.claude/handoffs` of the pantry clone.

The old clone is deleted (19 November 2026, owner: "Yes delete and keep
empty folder"):

- Before the delete, 16 MB of small files that existed only there went to
  the git-ignored `.claude/handoffs/satyr-artifacts` of the pantry clone:
  the JFEX 2026 notes, the Plan 87 handoff, the stale journey inputs of
  6 November, the Plan 61E Wasm reports and the untracked `scripts/plan-52`.
- 76 dev server processes (node, workerd, esbuild) and the clone's own Caddy
  (`~/Dev/lowerarchy/satyr/Caddyfile`, ports 3001 to 3005) were stopped by
  PID. They were started by old sessions between 3 and 17 November. The
  seams-site Caddy runs on.
- Deleted: 64 GB, with `output/` (35 GB of old results), `.artifacts/`
  (2.4 GB of journey captures), `docs/evidence/plan-55c` (276 MB, never
  committed), the two stashes "plan55c candidate" and
  "p32-whatsapp-message-read", two detached worktrees and the build output.
- Kept: the empty folder `~/Dev/lowerarchy/satyr` with
  `.claude/settings.local.json` and `.claude/launch.json`. Five Claude
  sessions that are not Pantry work (an external drive, a Dropbox move,
  course links, a hover translation app, a pastry syllabus) use the folder
  as their working folder.

### The monorepo relocation (20 November 2026)

- `seams-tech/seams-monorepo` is now `purin-labs/monorepo` (public, repo id
  `1366871528`, owner `purin-labs` id `358632792`). All 26 GitHub
  Environments (including `production-console` and `staging-console` with
  their 10 `SATYR_*` fallback secrets) moved with it.
- Live GitHub OIDC customization confirmed:
  `sub_claim_prefix: "repo:purin-labs@358632792/monorepo@1366871528"`.
- `purin-labs/monorepo` commit `079aebc1` (on `main` and `dev`) updated the
  Console tenant-cutover OIDC pin (`automationRoute.ts`,
  `githubDeploymentOidc.ts`), the deployment scripts and the docs to
  `purin-labs/monorepo`. The local clone moved to `~/Dev/purin-labs/monorepo`
  (`d82ded62`).
- Pantry updated `.github/workflows/pantry.yml`, `README.md`,
  `vendor/seams/README.md`, `scripts/plan-82-g06/run-server.sh` and
  `scripts/shop-voice/run-journey.py` to `purin-labs/monorepo`.

## Steps

Each step was checked on 28 November 2026 with a read-only `gh` call or a
`git grep` on dev `f6dd43ff`.

1. **The GitHub Apps: not needed.** Pantry uses only GitHub Actions, which
   is part of GitHub and needs no installation.
   `gh api orgs/purin-labs/installations` and
   `gh api orgs/seams-tech/installations` both return `total_count: 0` (the token is an admin of both
   organisations). So no app was on `seams-tech` to move. The repository has
   no webhook (`gh api repos/purin-labs/pantry/hooks` returns 0), and each
   pull request so far is by a person.
2. **Deploy the Console backend: not needed for Pantry.** Since Plan 95 step
   4, no Pantry code, workflow or Worker binds the Console.
   `git grep -E "ACCOUNT_PLATFORM|PANTRY_ACCOUNT_WORKER_ARTIFACT|seams-console"`
   outside `docs/` finds nothing, and `.github/workflows/pantry.yml` checks out only
   this repository. The Console repository is now `seams-tech/seams-console`.
   Its OIDC subject is
   `repo:seams-tech@282445520/seams-console@1366871528`
   (`gh api repos/seams-tech/seams-console/actions/oidc/customization/sub`),
   and its source `automationRoute.ts` on `main` pins the same value. The last
   run of its `deploy-console-backend.yml` is from 29 October 2026, so the
   live Console Workers can still hold an older pin. That deploy belongs to
   the Console (Refactor 260), not to Pantry.
3. **Run Pantry CI once: done.** The workflow "Pantry" has 248 runs in
   `purin-labs/pantry`. The first success was run `45082677761`
   (22 November 2026, pull request to `main`). The last success on `dev` was
   run `46081154523` (27 November 2026, `b2fd98c5`).
4. **The legacy `satyr` names: done.** Group A was done on 19 November 2026
   (dev `d7f37b9f`). Plan 93 step 2 renamed group B with
   `scripts/rename/plan-93-cutover.mjs` (dev `10847e8a`, 21 November 2026).
   On dev `f6dd43ff`, `git grep -i satyr` outside `docs/` and the Markdown
   files finds 154 lines in 49 files, against 2,356 lines in 745 files before
   step 2. Each line is in the list "Values that keep an old name on purpose"
   of [ENG-03](../specs/engineering/03-names.md), and no product code reads an
   old name:

   | Lines | Where                                                     | Layer and reason                                                 |
   | ----: | --------------------------------------------------------- | ---------------------------------------------------------------- |
   |    49 | `scripts/plan-82-g04/`                                    | Code. The wake training compares "Hey Satyr" and "Hey Sous Chef" |
   |    42 | `scripts/rename/plan-93-cutover.mjs`                      | Code. The search patterns of the codemod                         |
   |    24 | Applied D1 patch scripts in `workers/platform/scripts/`   | Records of the deleted stack (old D1 names, old CHECK values)    |
   |    18 | Pinned Kitchen physics bundles in `apps/portal/public/`   | The old build path. A saved run names its bundle by hash         |
   |    17 | `scripts/bakery-mujoco/` and `repo-binaries.json`         | Model text and R2 file names. Inputs of the pinned builds        |
   |     2 | `satyr-physics-results` in `areas/kitchen/ui/`            | Wire (browser OPFS folder). The pinned execution bundle names it |
   |     1 | `crates/bakery-native/src/station_reply.rs`               | A code comment. The bundles hash this source                     |
   |     1 | `workers/platform/tests/e2e/plan-88-jev-features.test.ts` | A link to the file name of Plan 88                               |

5. **The Portal shop footer: done.** The public `/ecommerce` page and its
   footer are deleted. `apps/portal/src/features/ecommerce/` does not exist,
   and `git grep "github.com/seams-tech"` outside `docs/` and the Markdown
   files finds nothing.

### The wallet side (done)

seams-wallet dev `8c5c0e6ba`: the organisation-rename checklist and its
script are deleted, and Refactor 251 (D11, D22, D23 and the package table)
keeps `seams-wallet`, `seams-monorepo` and the `@seams` scope.

## Decisions for the owner

State on 28 November 2026:

1. **The brand rule. Done:** the brand follows the code owner (see "The
   split"). Pantry uses the Purin names
   ([ENG-03](../specs/engineering/03-names.md)), and only Seams Pay keeps
   the Seams name.
2. **Pantry sign-in shows Seams for now. Replaced:** since
   [Plan 95](../plan-95-pantry-own-accounts.md) step 4, Pantry has its own
   sign-in, and no Pantry request calls the Seams Console.
3. **`pantry-history` and `satyr` stay archived. Done, in another
   place:** both are archived, private repositories of the owner's own
   account now (`peitalin/pantry-history`, `peitalin/satyr`). Links to
   `seams-tech/pantry-history` redirect, but only a person with access to
   the private repository can open them.
4. **The npm organisation `purin-io`. Open, with the owner:** delete it, or
   keep it unused. Pantry publishes no npm package, so it costs nothing.
   Default: keep it until you decide.
5. **Delete the old clone `~/Dev/lowerarchy/satyr`. Done** on 19 November
   2026: contents deleted, empty folder kept.

## Cost

- Done: the transfer, the remotes, the secrets, the handoffs and the delete
  of the old clone.
- Open: nothing for Pantry. The Console backend deploy is Console work, and
  decision 4 (the npm organisation `purin-io`) stays with the owner.
