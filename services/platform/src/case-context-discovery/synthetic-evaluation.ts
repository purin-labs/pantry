import type { TypeSafeEvaluationReceipt } from "../integrations/typesafe/evaluation-ledger";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { isOrganisationExecutionActive } from "../actors/actor-execution-quiescence";
import { digestCanonical } from "../policy/information-flow/digest";
import type { Result } from "../result";
import type { SchemaTransaction } from "../actors/schema-migrations";
import {
  JevRelationshipRequest,
  CASE_CONTEXT_DISCOVERY_JEV_MODEL,
  type JevEvaluation,
} from "./jev";
import type { TypeSafeCredential } from "../integrations/typesafe/credential";
import {
  caseContextDiscoveryReadiness,
  identifier,
  type CaseContextCollectionSource,
} from "./policy";
import {
  disableCaseContextDiscoveryPolicy,
  fetchCaseContextDiscoveryEvaluation,
  releaseUnissuedCaseContextDiscoveryEvaluation,
  type CaseContextDiscoveryEvaluationDispatch,
  readCaseContextDiscoveryPolicy,
  replayCaseContextDiscoveryEvaluation,
  reserveCaseContextDiscoveryEvaluation,
  settleCaseContextDiscoveryEvaluation,
  type CaseContextCollectionStoreError,
} from "./evaluation-store";

// This evaluator accepts only the fixed public fixture.
const SYNTHETIC_CASE_CONTEXT_DISCOVERY_COMPARISON = {
  evidence:
    "Synthetic supplier S-1 reports flour delivery PR-842, shipment 1, is delayed today.",
  candidates: [
    {
      candidateId: "same-delivery",
      evidence:
        "Synthetic purchase request PR-842, shipment 1: flour from supplier S-1 has not arrived today.",
    },
    {
      candidateId: "different-issue",
      evidence:
        "Synthetic supplier S-1 requests an invoice address correction for purchase request PR-842.",
    },
    {
      candidateId: "different-instance",
      evidence:
        "Synthetic PR-842 shipment 2 had a flour delay last month; it was resolved.",
    },
  ],
} as const;

type CaseContextDiscoverySyntheticResult = Readonly<{
  receipt: TypeSafeEvaluationReceipt;
  evaluation: JevEvaluation | null;
}>;

/** This entry point cannot read customer data or produce relationships or context. */
export async function evaluateSyntheticCaseContextDiscovery(input: {
  readonly sql: SqlStorage;
  readonly transaction: SchemaTransaction;
  readonly credential: TypeSafeCredential | null;
  readonly scope: OrganisationExecutionScope;
  readonly evaluationId: string;
  readonly expectedRevision: number;
  readonly source: CaseContextCollectionSource;
  readonly integrationAccountId: string;
  readonly signal: AbortSignal;
  readonly fetcher: typeof fetch;
  readonly now: () => number;
}): Promise<
  Result<
    CaseContextDiscoverySyntheticResult,
    | CaseContextCollectionStoreError
    | { readonly code: "organisation_placement_conflict" }
  >
> {
  const organisationId = input.scope.organisationId;
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return syntheticPlacementConflict();
  if (!identifier(input.evaluationId))
    return {
      ok: false,
      error: { code: "case_context_collection_store_invalid" },
    };
  const requestDigest = await digestCanonical({
    fixtureRevision: 1,
    policyRevision: input.expectedRevision,
    source: input.source,
    integrationAccountId: input.integrationAccountId,
    comparison: SYNTHETIC_CASE_CONTEXT_DISCOVERY_COMPARISON,
  });
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return syntheticPlacementConflict();
  const replayed = replayCaseContextDiscoveryEvaluation(
    input.sql,
    input.transaction,
    {
      organisationId,
      evaluationId: input.evaluationId,
      requestDigest,
      now: input.now(),
    },
  );
  if (!replayed.ok) return replayed;
  if (replayed.value !== null) {
    return { ok: true, value: { receipt: replayed.value, evaluation: null } };
  }
  const head = readCaseContextDiscoveryPolicy(input.sql, organisationId);
  if (head.revision !== input.expectedRevision)
    return {
      ok: false,
      error: { code: "case_context_collection_revision_conflict" },
    };
  const readiness = caseContextDiscoveryReadiness({
    policy: head.policy,
    credential: input.credential,
    source: input.source,
    integrationAccountId: input.integrationAccountId,
  });
  if (readiness.kind === "inactive" || input.credential === null) {
    if (
      readiness.kind === "inactive" &&
      readiness.reason === "credential_unavailable"
    ) {
      input.transaction(
        disableCaseContextDiscoveryPolicy.bind(
          null,
          input.sql,
          organisationId,
          head.revision,
          input.now(),
        ),
      );
    }
    return { ok: false, error: { code: "case_context_collection_inactive" } };
  }
  const prepared = await JevRelationshipRequest.prepare({
    comparison: SYNTHETIC_CASE_CONTEXT_DISCOVERY_COMPARISON,
    sink: {
      kind: "typesafe_system_one",
      organisationId,
      purpose: "case_context_discovery_relationship",
      funding: input.credential.authority,
      model: CASE_CONTEXT_DISCOVERY_JEV_MODEL,
      processing: { kind: "public_fixture", fixtureRevision: 1 },
    },
    labels: [],
  });
  if (!prepared.ok)
    return { ok: false, error: { code: "case_context_collection_inactive" } };
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return syntheticPlacementConflict();
  const reserved = reserveCaseContextDiscoveryEvaluation(
    input.sql,
    input.transaction,
    {
      organisationId,
      evaluationId: input.evaluationId,
      requestDigest,
      policyRevision: head.revision,
      disclosureDecisionDigest: prepared.value.disclosure.decisionDigest,
      // Reserve the client's entire input bound, including its question/schema overhead.
      inputBytes: 24_576,
      now: input.now(),
    },
  );
  if (!reserved.ok) return reserved;
  if (reserved.value.kind === "replayed") {
    return {
      ok: true,
      value: { receipt: reserved.value.receipt, evaluation: null },
    };
  }
  const dispatch: { state: CaseContextDiscoveryEvaluationDispatch } = {
    state: { kind: "unissued" },
  };
  const evaluated = await prepared.value.evaluate({
    credential: input.credential,
    timeoutMs: readiness.policy.limits.requestTimeoutMs,
    signal: input.signal,
    fetcher: fetchCaseContextDiscoveryEvaluation.bind(null, input, dispatch),
  });
  if (
    dispatch.state.kind === "unissued" &&
    !(await isOrganisationExecutionActive(input.sql, input.scope))
  ) {
    input.transaction(
      releaseUnissuedCaseContextDiscoveryEvaluation.bind(null, {
        sql: input.sql,
        scope: input.scope,
        evaluationId: input.evaluationId,
        requestDigest,
        dispatch: dispatch.state,
      }),
    );
    return syntheticPlacementConflict();
  }
  const settled = settleCaseContextDiscoveryEvaluation({
    sql: input.sql,
    transaction: input.transaction,
    organisationId,
    evaluationId: input.evaluationId,
    requestDigest,
    result: evaluated,
    now: input.now(),
  });
  if (!settled.ok) return settled;
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return syntheticPlacementConflict();
  const accepted = settled.value.kind === "evaluated";
  return {
    ok: true,
    value: {
      receipt: settled.value,
      evaluation: accepted && evaluated.ok ? evaluated.value : null,
    },
  };
}

function syntheticPlacementConflict(): Result<
  never,
  { readonly code: "organisation_placement_conflict" }
> {
  return { ok: false, error: { code: "organisation_placement_conflict" } };
}
