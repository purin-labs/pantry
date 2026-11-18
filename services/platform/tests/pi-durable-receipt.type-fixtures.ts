import type { CodeModeReceipt } from "../src/actors/pi-durable-code-receipt";

// @ts-expect-error A completed receipt requires its result.
const missingResult: CodeModeReceipt = { kind: "completed" };
// @ts-expect-error A started receipt cannot contain a settlement lease.
const prematureLease: CodeModeReceipt = {
  kind: "started",
  lease: { executionId: "execution", leaseId: "lease" },
};
const staleFields = { lease: { executionId: "execution", leaseId: "lease" } };
// @ts-expect-error Spreads cannot carry obsolete settlement fields into an empty state.
const invalidSpread: CodeModeReceipt = { ...staleFields, kind: "unstarted" };
void [missingResult, prematureLease, invalidSpread];
