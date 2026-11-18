# Commerce lab test guide

This folder protects the deterministic commerce-lifecycle boundary described in
Plan 9. The commerce contract schemas remain the lifecycle source of truth. These
edge tests cover only the TypeScript scenario catalog, lab marker/reset fence,
signed ingress, projection convergence, cue deduplication, and administrative
evidence routes that surround those contracts.

Keep the CL4 acceptance catalog to exactly these six scenarios:

1. `product-listing`
2. `happy-order`
3. `payment-failed`
4. `inventory-shortage`
5. `shipment-delayed`
6. `cancellation-refund`

`shipment-delayed` owns the terminal delivery-exception branch for this suite.
Returned-shipment behavior belongs in a focused transition journey until it
becomes a separately approved acceptance scenario.

Before changing a fixture, read `docs/plan-9-commerce-lifecycle-lab.md` and the
repository-root `AGENTS.md` testing guidance, then inspect the canonical contract
type or transition it exercises. Preserve these safety properties:

- scenario IDs, source revisions, and idempotency keys are deterministic;
- reset requires the exact organisation lab marker and namespace;
- raw lab/provider payloads stop at the boundary parser;
- duplicate and out-of-order events converge without duplicate cues or writes;
- money-moving actions require typed authorization and approval;
- `/verify` derives receipts from server state and never accepts caller-authored
  pass/fail claims.

Prefer one fixture for each distinct lifecycle or security boundary. Delete
fixtures that only preserve superseded field names, exact SQL ordering, display
copy, or provider-specific implementation details.

Run this folder with:

```bash
pnpm --filter @seams/platform exec vitest run tests/commerce-lab
pnpm --filter @seams/platform check:test-types
```
