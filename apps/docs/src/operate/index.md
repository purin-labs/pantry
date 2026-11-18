---
title: Operate
description: Local development, verification, recovery, and production operating guidance.
---

# Operate

The Seams Pantry operating workflow keeps the narrowest relevant check close to each
change, then proves the full path with durable evidence.

## Start locally

1. Follow [Local development](/operate/local-development).
2. Build the portal and start the platform Worker.
3. Seed the commerce lab when a commerce lifecycle change requires it.
4. Use the focused checks below before broad workspace verification.

## Focused checks

| Change                       | First check                                        |
| ---------------------------- | -------------------------------------------------- |
| TypeScript platform code     | `pnpm --filter @seams/platform check:types`             |
| Test-only TypeScript changes | `pnpm --filter @seams/platform check:test-types`        |
| Onboarding or lifecycle      | `pnpm --filter @seams/platform test:onboarding-closure` |
| Commerce lifecycle           | `pnpm --filter @seams/platform test:commerce-lab`       |
| Portal behavior              | `pnpm portal:build`                                |
| Rust crates                  | `cargo test --workspace`                           |

Use the [testing and evidence](/operate/testing-and-evidence) guide for the
full closure sequence and the incident guides for recovery.
