import {
  CommerceContextToolResult,
  type CommerceContextValue,
} from "../src/actors/commerce-context-tool-result";

declare function accept(value: CommerceContextValue): void;
const emptyGraph = {
  merchantRevision: 1,
  entities: [],
  relationships: [],
  listEntries: [],
  aggregations: [],
  nextCursor: null,
  provenance: [],
  freshness: [],
};

// @ts-expect-error Structured reads require a validated domain result and factory.
new CommerceContextToolResult(
  {},
  { ok: true, result: emptyGraph, truncated: false },
);

const failedWithData = {
  ok: false as const,
  error: { code: "read_failed" as const, message: "Unavailable" },
  result: emptyGraph,
};
// @ts-expect-error A failed read cannot carry source data.
accept(failedWithData);

const failed = {
  ok: false as const,
  error: { code: "read_failed" as const, message: "Unavailable" },
};
const spreadFailure = { ...failed, result: emptyGraph };
// @ts-expect-error Broad spreads cannot combine failure and source data.
accept(spreadFailure);

const truncated = {
  ok: true as const,
  result: emptyGraph,
  truncated: true as const,
};
// @ts-expect-error Successful pages cannot claim silent truncation.
accept(truncated);

const incomplete = { ok: true as const, result: {}, truncated: false as const };
// @ts-expect-error Successful reads must contain the complete graph shape.
accept(incomplete);
