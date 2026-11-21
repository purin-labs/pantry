# Platform production deploy

This runbook gives the steps of a production deploy of the Platform Worker and
the Portal. `AGENTS.md` (Deployment) gives the order of the six Workers.

## Production deploy

1. Use a clean worktree at the release commit. Do not deploy from a checkout
   that holds work that is not committed.
2. Install the packages:

   ```bash
   pnpm install --prefer-offline --frozen-lockfile
   ```

3. Fetch the files that the Portal serves from R2. The Kitchen physics bundles
   that no pin names are in the R2 bucket `pantry-repo-binaries-apac`, not in
   git. A saved run can name any of them, so the Portal build must hold all of
   them. The fetch needs a Wrangler sign-in, or `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY` and `R2_ENDPOINT`:

   ```bash
   node scripts/repo-binaries.mjs fetch apps/portal/public/bakery-physics
   ```

4. Deploy:

   ```bash
   pnpm --filter @purin-labs/platform run deploy
   ```

## Guards before the upload

`scripts/run-worker.mjs` refuses a production upload of the Platform in two
cases:

- `apps/portal/dist/shop-gateway` lacks a shop gateway build (Plan 85). Run
  `bash services/shop-gateway/build.sh`, then `pnpm portal:build`.
- `apps/portal/dist/bakery-physics` lacks a Kitchen physics bundle that a
  manifest names, or a file differs from its SHA-256 (Refactor 16, step 9B).
  The manifests are the pins in `packages/production-simulation`, the bundle
  folders in `apps/portal/public/bakery-physics`, `repo-binaries.json`, and
  the descriptor of each bundle. Run the fetch of step 3, then
  `pnpm portal:build`.

To run the physics check alone, with no upload:

```bash
node scripts/check-physics-dist.mjs apps/portal/dist
```

A deploy of the Platform alone (not the whole `run deploy`) needs the same
fetch, `bash services/shop-gateway/build.sh` and `pnpm portal:build` first.
