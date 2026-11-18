import {
  JevRelationshipRequest,
  CASE_CONTEXT_DISCOVERY_JEV_MODEL,
  type JevComparison,
} from "../../src/case-context-discovery/jev";

export async function evaluateFixtureJevRelationships(
  input: Readonly<{
    apiKey: string;
    comparison: JevComparison;
    timeoutMs: number;
    signal: AbortSignal;
    fetcher: typeof fetch;
  }>,
) {
  const prepared = await JevRelationshipRequest.prepare({
    comparison: input.comparison,
    sink: {
      kind: "typesafe_system_one",
      organisationId: "organisation_jev_fixture",
      purpose: "case_context_discovery_relationship",
      funding: { kind: "organisation_byo", connectionRevision: 1 },
      model: CASE_CONTEXT_DISCOVERY_JEV_MODEL,
      processing: { kind: "public_fixture", fixtureRevision: 1 },
    },
    labels: [],
  });
  if (!prepared.ok) return prepared;
  return prepared.value.evaluate({
    credential: { provider: "typesafe", apiKey: input.apiKey,
      authority: { kind: "organisation_byo", connectionRevision: 1 },
    },
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    fetcher: input.fetcher,
  });
}
