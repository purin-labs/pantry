# Plan 94 — Pantry moves to the GitHub organisation `purin-labs`

Status: draft, 19 November 2026. The folder move is done (see "Done"). The
repository transfers wait for the owner.

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
| `seams-tech` (stays) | Seams | `seams-wallet`, `seams-monorepo` (site, Console, wallet deploy), `speak-to-sign`, `seams-sdk` (archived) | `~/Dev/rust` |
| `purin-labs` (new) | Purin | `pantry`, `pantry-history` (archived), `satyr` | `~/Dev/purin-labs` |

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
  and `say-so`. A symlink `~/Dev/purin-io` → `purin-labs` stays, because two
  other Claude sessions, the `say-so` dev servers and a Python process ran
  in the old path at the move. Remove the symlink when they stop.
- `git worktree repair` fixed the worktree of the clone. The clone has no
  stash.
- The memory folders of the old paths are copied to
  `~/.claude/projects/-Users-pta-Dev-purin-labs/memory` and
  `-Users-pta-Dev-purin-labs-pantry/memory`. The old folders stay for the
  sessions that still run in the old path.
- The pantry docs that named `~/Dev/purin-io` name `~/Dev/purin-labs`.

## Steps

### The owner

1. Check the apps on `seams-tech` (Settings → GitHub Apps) and install the
   ones that Pantry needs on `purin-labs`.
2. In `purin-labs`: set the base permission and the Actions budget. Default:
   $0, so only the free minutes run.
3. Transfer `pantry`: https://github.com/seams-tech/pantry/settings →
   Danger Zone → Transfer → `purin-labs`. Then `pantry-history` and `satyr`.

### Me, after the owner says the transfers are done

1. Check: `gh api repos/purin-labs/pantry`, `git ls-remote` on the old
   address (redirect), the three secret names, and pull request #1.
2. Run `git remote set-url origin https://github.com/purin-labs/<repo>.git`
   in `~/Dev/purin-labs/pantry` and `~/Dev/lowerarchy/satyr`.
3. Archive `purin-labs/satyr` (decision 3).
4. One pantry commit: links `seams-tech/(pantry|pantry-history|satyr)` →
   `purin-labs/...`, the footer link → `https://github.com/purin-labs`, and
   the billing commands in the docs.
5. Run Pantry CI once in the new organisation: add the label `run-ci` to
   pull request #1 (`gh api repos/purin-labs/pantry/issues/1/labels`). It
   uses free minutes.
6. Run `pnpm install --prefer-offline` in the clone when the symlink goes, so
   that the pnpm shims name the new path.

### The wallet side

This does not wait for the transfers. In seams-wallet: delete the
organisation-rename checklist and its script, and change Refactor 251 (D11,
D22, D23 and the package table) to keep `seams-wallet`, `seams-monorepo` and
the `@seams` scope.

## Decisions for the owner

1. **The brand rule:** the brand follows the code owner (see "The split").
   Default: yes.
2. **Pantry sign-in shows Seams for now.** People sign in through the Seams
   Console. Default: yes. A Purin sign-in page is a later plan.
3. **Archive `satyr` after the move.** Default: yes. All its commits are in
   pantry.
4. **The npm organisation `purin-io`:** delete it, or keep it unused.
   Default: keep it until you decide.

## Cost

- The owner: about 15 minutes (the apps, the settings, three transfers).
- Me: about one hour (checks, remotes, one link commit, one CI run).
