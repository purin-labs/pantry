---
title: Local development
description: Run the docs, portal, platform Worker, commerce authority, and local acceptance surfaces.
---

# Local development

## Bootstrap

```bash
corepack enable
pnpm install
cargo check --workspace
```

Build the portal and start the docs app:

```bash
pnpm portal:build
pnpm --filter @seams/docs dev
```

Start the platform Worker in another terminal:

```bash
pnpm --filter @seams/platform dev
```

The docs app runs at `http://docs.localhost:3005`. The portal is available through
the local site setup described in the repository README.

## Local commerce path

When a commerce change needs a durable local authority and lab:

```bash
pnpm --filter @seams/platform d1:migrate:local
pnpm lab:reset
pnpm lab:seed
pnpm lab:scenario
pnpm lab:verify
```

The lab commands use local environment files when present. Keep credentials in
`.env.local`, Wrangler secrets, or the configured vault. Never commit them.

## Named local sites

The Caddy proxy exposes stable local names for the buyer storefronts, portal,
and the commerce engine (`services/commerce`). Add the repository's documented
hosts to `/etc/hosts` once, then run:

```bash
pnpm backend
pnpm site
```

`pnpm site` starts foreground Caddy on ports 3001–3005 without administrator
access. Ctrl+C stops Caddy and releases those ports.

## Docs-only loop

For content or theme changes, use the shorter loop:

```bash
pnpm --filter @seams/docs type-check
pnpm --filter @seams/docs check:links
pnpm --filter @seams/docs check:fences
pnpm --filter @seams/docs build
```
