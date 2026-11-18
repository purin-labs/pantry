# Plan 84 release

Each step needs the owner's approval for this release. Follow the production deploy procedure:
build from a clean worktree, and read the live version inside the deploy command.

## Before the deploy

Plan 85's patches and backfill come first if they are not applied. The schema gate refuses a deploy
until each regional database matches its baseline.

1. Apply the patch to each regional database:

   ```bash
   pnpm --filter @seams/platform exec wrangler d1 execute <binding> --env production --remote --file scripts/bakery-workflow-d1-patch.sql
   ```

2. Add the capability rows for `commerce.recipe_workflow.read` and
   `commerce.recipe_workflow.propose`:

   ```bash
   node scripts/capability-policy-backfill-sql.mjs > /tmp/backfill.sql
   ```

   ```bash
   pnpm --filter @seams/platform exec wrangler d1 execute <binding> --env production --remote --file /tmp/backfill.sql
   ```

3. Check each database:

   ```bash
   pnpm --filter @seams/platform d1:schema:remote:check
   ```

## After the deploy: Journey J8

The owner signs in, in the owner's own browser, with a real model on the Portal chat.

1. Open Satyr Kitchen, a recipe, and the Workflow surface. The first open applies revision 1.
2. Select Run draft. If the run has findings, select Ask the agent and send the words. If it has none,
   ask the chat to propose a change to one step.
3. Allow the two prompts. The Workflow page shows the proposal with no reload.
4. Select Review, then Run proposal, then Approve.
5. Select Run draft. The applied run must end at the proposal's time.

Record the result in `docs/evidence/plan-42-release-readiness.md` and in a Phase 5 evidence note. After
J8, D7 decides if `ProcedureCanvas`, `schedule.ts` and `bakery_procedure` go, in a new task.
Decided 2026-11-14: `ProcedureCanvas` is removed; `schedule.ts` and `bakery_procedure` stay.

## If it fails

The tables and the two capabilities are additive. Roll back with `wrangler rollback`, and leave the
schema in place. The old Worker does not read the new tables.
