# Plan 94 — Pantry moves to the GitHub organisation `purin-labs`

Status: 19 November 2026. The repository is `purin-labs/pantry`, the folder
move is done, the old `satyr` repository is archived and the old clone is
deleted (see "Done"). Open: the GitHub Apps, the first CI run and the
group B legacy names (see "Steps").

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

| Organisation | Brand | Repositories | Local folder |
|---|---|---|---|
| `seams-tech` (stays) | Seams | `seams-wallet`, `seams-monorepo` (site, Console, wallet deploy), `speak-to-sign`, `seams-sdk` (archived). Also the archived history of Pantry: `pantry-history` and `satyr` | `~/Dev/rust` |
| `purin-labs` (new) | Purin | `pantry` | `~/Dev/purin-labs` |

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
- Pantry CI checks out `seams-tech/seams-monorepo`. That repository is
  public, so a workflow in another organisation needs no token.
- Local E2E runs need `PANTRY_ACCOUNT_WORKER_ARTIFACT`, built from
  seams-monorepo, and `PLAYWRIGHT_MODULE` from seams-wallet.
- [Plan 93](plan-93-clean-cutover.md) still renames the Console service id
  `satyr` in seams-monorepo. That change lands in `seams-tech`.

## Facts (19 November 2026)

**The new organisations.** The GitHub organisation `purin-labs` exists (Free
plan, made on 19 November). The npm organisation `purin-labs` exists.

**What stays the same.** Nothing in `seams-tech` changes: the npm packages and
their trusted publishers, the Console OIDC pin to
`seams-tech/seams-monorepo`, the wallet links, the speak-to-sign hackathon
links and the `seams.sh` site. The organisation rename would have changed
links in 22 files of seams-wallet, 17 of seams-monorepo and 15 of
speak-to-sign, and 6 npm trusted publishers. The split changes none of them.

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

## Steps

1. **The owner: the GitHub Apps.** Check the apps on `seams-tech`
   (Settings → GitHub Apps) and install the ones that Pantry needs on
   `purin-labs`.
2. **Run Pantry CI once** in the new organisation: add the label `run-ci` to
   pull request #1 (`gh api repos/purin-labs/pantry/issues/1/labels`). It
   uses the free minutes of `purin-labs`.
3. **The legacy `satyr` names in the code:** group A is done; group B
   waits for [Plan 93](plan-93-clean-cutover.md) step 2.
4. **The Portal shop footer** links to `https://github.com/seams-tech`
   (`apps/portal/src/features/ecommerce/footer.tsx`). Change it with the
   brand rename.

### The wallet side (done)

seams-wallet dev `8c5c0e6ba`: the organisation-rename checklist and its
script are deleted, and Refactor 251 (D11, D22, D23 and the package table)
keeps `seams-wallet`, `seams-monorepo` and the `@seams` scope.

## Decisions for the owner

1. **The brand rule:** the brand follows the code owner (see "The split").
   Default: yes.
2. **Pantry sign-in shows Seams for now.** People sign in through the Seams
   Console. Default: yes. A Purin sign-in page is a later plan.
3. **`pantry-history` and `satyr` stay in `seams-tech`, archived.** Default:
   yes. About 85 pantry files link to `seams-tech/pantry-history`, and the
   links stay valid. A later transfer keeps them valid too (redirect).
4. **The npm organisation `purin-io`:** delete it, or keep it unused.
   Default: keep it until you decide.
5. **Delete the old clone `~/Dev/lowerarchy/satyr`.** Decided and done on
   19 November 2026: contents deleted, empty folder kept.

## Cost

- Done: the transfer, the remotes, the secrets, the handoffs and the delete
  of the old clone.
- Open: the apps (the owner, about 5 minutes) and one CI run.
