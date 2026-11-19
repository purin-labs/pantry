---
title: Testing and evidence
description: The verification sequence for platform, commerce, onboarding, and documentation changes.
---

# Testing and evidence

Seams Pantry uses focused tests to prove the changed boundary and scenario runs to
prove the operating path. Evidence should identify the exact revision,
receipt, provider observation, and terminal disposition that were checked.

## Repository checks

```bash
pnpm --filter @purin-labs/platform check:types
pnpm --filter @purin-labs/platform check:test-types
pnpm --filter @purin-labs/platform test
pnpm portal:build
cargo test --workspace
git diff --check
```

Run only the checks relevant to the change first. The full workspace sequence
belongs at the end of a cross-boundary change.

## Lifecycle checks

Onboarding and lifecycle work must include:

```bash
pnpm --filter @purin-labs/platform test:onboarding-closure
```

Commerce lifecycle work must include:

```bash
pnpm --filter @purin-labs/platform test:commerce-lab
pnpm lab:reset
pnpm lab:seed
pnpm lab:scenario
pnpm lab:verify
```

The lab proves provider actions, projections, receipts, replay, and duplicate
delivery against a controlled authority.

## Evidence rules

- Record success and failure branches, including indeterminate external
  outcomes.
- Keep credentials, private customer data, and raw provider secrets out of
  evidence artifacts.
- Prefer one behavioral proof for a real path over source-text checks.
- Delete fixtures and assertions that protect retired behavior.
- Preserve only compatibility coverage at an intentional persistence or
  request boundary, with a deletion condition.
