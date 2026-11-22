# Purin Pantry documentation app

The docs are a VitePress application for the Purin Pantry runtime, commerce
boundaries, governed agent work, and operator workflows. The repository's
authoritative design records remain under the top-level `docs/` directory;
this app turns the stable parts of that corpus into a navigable public-facing
guide.

## Local checks

```bash
pnpm --filter @purin-labs/docs type-check
pnpm --filter @purin-labs/docs check:links
pnpm --filter @purin-labs/docs check:fences
pnpm --filter @purin-labs/docs build
```

Run the site locally with:

```bash
pnpm --filter @purin-labs/docs dev
```

The site is available at `http://docs.localhost:3005`.
