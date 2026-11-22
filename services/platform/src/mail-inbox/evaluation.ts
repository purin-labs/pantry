import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { isOrganisationExecutionActive } from "../actors/actor-execution-quiescence";
import { GMAIL_MAILBOX } from "../mail/gmail-mail-adapter";
import type { RequestAuthority } from "@purin-labs/contracts";
import {
  parseMailClassifications,
  type MailClassification,
  type MailRule,
} from "@purin-labs/control-api";
import { resolveConnectorGmailAccess } from "../actors/connector-email-evaluation";
import type { Env } from "@purin-labs/kernel/env";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { TypeSafeCredential } from "../integrations/typesafe/credential";
import {
  reserveTypeSafeEvaluation,
  settleTypeSafeEvaluation,
  type TypeSafeUsageAuthority,
} from "../integrations/typesafe/evaluation-ledger";
import { digestCanonical } from "../policy/information-flow/digest";
import { authorizeMailSource } from "./contract/mail-source-authorization";
import { mailInferenceEligible } from "./contract/mail-inference-eligibility";
import { JevMailRequest } from "./jev";
import { mailClassificationEvidence } from "./evidence";
import type { SchemaTransaction } from "../actors/schema-migrations";
import type { Result } from "@purin-labs/kernel/result";
import type { Variant } from "@purin-labs/type-utils";

export type MailEvaluationInput = Readonly<{
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  evaluationId: string;
  revision: number;
  messageId: string;
  rules: readonly MailRule[];
  authority: Variant<RequestAuthority, "control">;
  sourcePin: string;
}>;
type MailEvaluationResult = Readonly<{
  classifications: readonly MailClassification[];
  contentDigest: string;
}>;
type MailEvaluationError = Readonly<{ code: string }>;
const MAIL_USAGE_LIMITS = {
  maxEvaluations: 100,
  maxConcurrentEvaluations: 4,
  maxInputBytes: 2_457_600,
  maxInputTokens: 6_553_600,
  maxWallMs: 1_000_000,
  maxCostMicrousd: 300_000,
  reservationMicrousd: 3000,
  requestTimeoutMs: 10_000,
};
export function createMailEvaluationSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS mail_evaluation_result (
    organisation_id TEXT NOT NULL, evaluation_id TEXT NOT NULL, scope_digest TEXT NOT NULL,
    request_digest TEXT NOT NULL, content_digest TEXT NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY (organisation_id, evaluation_id)
  )`);
}
export async function evaluateMail(
  input: Readonly<{
    env: Env;
    sql: SqlStorage;
    scope: OrganisationExecutionScope;
    transaction: SchemaTransaction;
    credential: TypeSafeCredential | null;
    request: MailEvaluationInput;
    fetcher: typeof fetch;
  }>,
): Promise<Result<MailEvaluationResult, MailEvaluationError>> {
  if (
    input.scope.organisationId !== input.request.organisationId ||
    !(await isOrganisationExecutionActive(input.sql, input.scope))
  )
    return failure("organisation_placement_conflict");
  const fetcher = fetchMailEvaluation.bind(null, input);
  const mailOperations = GMAIL_MAILBOX;
  const request = input.request;
  if (
    request.authority.kind !== "control" ||
    request.authority.organisationId !== request.organisationId
  )
    return failure("mail_classification_ineligible");
  const source = await authorizeMailSource(
    input.env,
    request.authority,
    request.integrationAccountId,
  );
  if (
    source === null ||
    source.sourcePin !== request.sourcePin ||
    input.credential === null ||
    !(await mailInferenceEligible({
      db: input.scope.database,
      organisationId: request.organisationId,
      integrationAccountId: request.integrationAccountId,
      sourcePin: source.sourcePin,
      typesafe: input.credential.authority,
      now: Date.now(),
    }))
  )
    return failure("mail_classification_ineligible");
  // The current authority funds the call; the ledger fences it if the key changes in flight.
  const typesafe = input.credential.authority;
  const scopeDigest = await digestCanonical(request);
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return failure("organisation_placement_conflict");
  const stored = input.sql
    .exec<{ scope_digest: string; content_digest: string; result: string }>(
      "SELECT scope_digest, content_digest, result FROM mail_evaluation_result WHERE organisation_id = ? AND evaluation_id = ?",
      request.organisationId,
      request.evaluationId,
    )
    .toArray()[0];
  if (stored !== undefined) {
    if (stored.scope_digest !== scopeDigest)
      return failure("mail_classification_conflict");
    const classifications = parseMailClassifications(JSON.parse(stored.result));
    if (classifications === null)
      throw new Error("mail_evaluation_result_corrupt");
    return {
      ok: true,
      value: { classifications, contentDigest: stored.content_digest },
    };
  }
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: request.organisationId,
    integrationAccountId: request.integrationAccountId,
    now: Date.now(),
    fetcher,
  });
  if (!access.ok) return failure("mail_classification_source_unavailable");
  const content = await mailOperations.reads.readMessage({
    accessToken: access.value,
    messageId: request.messageId,
    fetcher,
  });
  if (!content.ok) return failure(content.error.code);
  if (content.value.messageId !== request.messageId)
    return failure("mail_classification_source_mismatch");
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return failure("organisation_placement_conflict");
  const evidence = mailClassificationEvidence(content.value);
  if (evidence.length > 8192)
    return failure("mail_classification_evidence_too_large");
  const contentDigest = await digestCanonical(evidence);
  const prepared = await JevMailRequest.prepare({
    rules: request.rules,
    evidence,
    label: source.label,
    sink: {
      kind: "typesafe_system_one",
      organisationId: request.organisationId,
      purpose: "mail_classification",
      funding: typesafe,
      model: "jev-1.13.0",
      processing: { kind: "authorized_source", authority: request.authority },
    },
  });
  if (!prepared.ok) return failure("mail_classification_disclosure_denied");
  const requestDigest = await digestCanonical({
    scopeDigest,
    contentDigest,
    disclosure: prepared.value.disclosure.decisionDigest,
  });
  const key = {
    organisationId: request.organisationId,
    purpose: "mail_classification" as const,
    evaluationId: request.evaluationId,
    requestDigest,
  };
  const authority: TypeSafeUsageAuthority = {
    kind: "active",
    revision: request.revision,
    funding: typesafe,
    limits: MAIL_USAGE_LIMITS,
  };
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return failure("organisation_placement_conflict");
  const reserved = input.transaction(
    reserveTypeSafeEvaluation.bind(
      null,
      input.sql,
      {
        ...key,
        policyRevision: request.revision,
        inputBytes: 24_576,
        reservedInputTokens: 65_536,
        disclosureDecisionDigest: prepared.value.disclosure.decisionDigest,
        now: Date.now(),
      },
      authority,
    ),
  );
  if (!reserved.ok) return failure(reserved.error.code);
  if (reserved.value.kind === "replayed")
    return failure(`mail_evaluation_${reserved.value.receipt.kind}`);
  const evaluated = await prepared.value.evaluate({
    credential: input.credential,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    fetcher,
  });
  const current = await authorizeMailSource(
    input.env,
    request.authority,
    request.integrationAccountId,
  );
  const eligible =
    current !== null &&
    current.sourcePin === request.sourcePin &&
    (await mailInferenceEligible({
      db: input.scope.database,
      organisationId: request.organisationId,
      integrationAccountId: request.integrationAccountId,
      sourcePin: request.sourcePin,
      typesafe: typesafe,
      now: Date.now(),
    }));
  const active = await isOrganisationExecutionActive(input.sql, input.scope);
  const settlementAuthority: TypeSafeUsageAuthority =
    eligible && active
      ? authority
      : { kind: "inactive", revision: request.revision };
  const classifications: MailClassification[] = [];
  if (evaluated.ok)
    for (const decision of evaluated.value.decisions)
      classifications.push({
        messageId: request.messageId,
        threadId: content.value.threadId,
        ruleId: decision.ruleId,
        outcome: decision.outcome,
        source: "jev",
        evaluatedAt: Date.now(),
      });
  const committed = input.transaction(
    commitMailEvaluation.bind(null, {
      sql: input.sql,
      key,
      authority: settlementAuthority,
      evaluated,
      scopeDigest,
      contentDigest,
      classifications,
    }),
  );
  return active ? committed : failure("organisation_placement_conflict");
}

async function fetchMailEvaluation(
  input: {
    readonly sql: SqlStorage;
    readonly scope: OrganisationExecutionScope;
    readonly fetcher: typeof fetch;
  },
  request: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    throw new Error("organisation_placement_conflict");
  // The runtime's fetch throws "Illegal invocation" when it is called as a
  // property of another object, so the call does not go through `input`.
  const fetcher = input.fetcher;
  return fetcher(request, init);
}

function commitMailEvaluation(
  input: Readonly<{
    sql: SqlStorage;
    key: Parameters<typeof settleTypeSafeEvaluation>[1];
    authority: TypeSafeUsageAuthority;
    evaluated: Awaited<ReturnType<JevMailRequest["evaluate"]>>;
    scopeDigest: string;
    contentDigest: string;
    classifications: readonly MailClassification[];
  }>,
): Result<MailEvaluationResult, MailEvaluationError> {
  const result = input.evaluated.ok
    ? { ok: true as const, value: input.evaluated.value.usage }
    : input.evaluated;
  const settled = settleTypeSafeEvaluation(
    input.sql,
    input.key,
    input.authority,
    result,
    Date.now(),
  );
  if (!settled.ok) return failure(settled.error.code);
  if (settled.value.receipt.kind !== "evaluated")
    return failure(`mail_evaluation_${settled.value.receipt.kind}`);
  input.sql.exec(
    "INSERT INTO mail_evaluation_result (organisation_id, evaluation_id, scope_digest, request_digest, content_digest, result) VALUES (?, ?, ?, ?, ?, ?)",
    input.key.organisationId,
    input.key.evaluationId,
    input.scopeDigest,
    input.key.requestDigest,
    input.contentDigest,
    JSON.stringify(input.classifications),
  );
  return {
    ok: true,
    value: {
      classifications: input.classifications,
      contentDigest: input.contentDigest,
    },
  };
}
function failure(code: string): Result<never, MailEvaluationError> {
  return { ok: false, error: { code } };
}
