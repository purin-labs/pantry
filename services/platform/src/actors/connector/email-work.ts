import { runtimeFetch } from "../../runtime-fetch";
import { fetchConnectorMail } from "../../mail-inbox/execution";
import type { Env } from "../../env";
import {
  parseCaseId,
  parseIntegrationAccountId,
  type CaseId,
  type IntegrationAccountId,
} from "../../ids";
import { recordEmailMessageReceipt } from "../../data/email-mailbox";
import { projectEmailOperationalProposal } from "../../data/email-operational";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { isActorExecutionActive } from "../actor-execution-quiescence";
import { requireActiveOrganisationActor } from "../actor-router";
import {
  completeEmailCaseContextDiscovery,
  retryEmailCaseContextDiscovery,
  readEmailRuntime,
  type EmailCaseContextDiscoveryWork,
  type EmailRuntimeSnapshot,
} from "../connector-email";
import { resolveConnectorGmailAccess } from "../connector-email-evaluation";
import {
  discoverAdmittedEmailCaseContext,
  type EmailCaseContextDiscoveryOutcome,
} from "../connector-email-case-context-discovery";
import {
  expireOperationalEmailProposals,
  latestOperationalEmailProposal,
  pendingOperationalEmailProjections,
  readOperationalEmailDispatchId,
  settleOperationalEmailProjection,
  rejectOperationalEmailProposal,
  type OperationalEmailProposalRecord,
} from "../connector-email-operational";
import type { Result } from "../../result";
import { assertNever } from "@purin-labs/std";
import { invalid } from "./support";
import type { ConnectorResult } from "./types";

type EmailCaseContextCollectionAccess =
  | Readonly<{ kind: "ready"; accessToken: string }>
  | Readonly<{ kind: "inactive"; reason: string }>
  | Readonly<{ kind: "retry"; reason: string }>;

export function finalizeEmailCaseContextDiscovery(
  sql: SqlStorage,
  work: EmailCaseContextDiscoveryWork,
  outcome: EmailCaseContextDiscoveryOutcome,
  now: number,
): "completed" | "scheduled" | "exhausted" {
  if (outcome.kind !== "retry") {
    completeEmailCaseContextDiscovery(sql, work);
    return "completed";
  }
  return retryEmailCaseContextDiscovery(sql, { work, now });
}

export async function runEmailCaseContextDiscoveryWork(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    env: Env;
    sql: SqlStorage;
    work: EmailCaseContextDiscoveryWork;
    now: number;
  }>,
): Promise<EmailCaseContextDiscoveryOutcome> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { kind: "retry", reason: "connector_placement_conflict" };
  const runtime = readEmailRuntime(input.sql);
  if (
    runtime === null ||
    runtime.disabledAt !== null ||
    runtime.organisationId !== input.scope.organisationId ||
    runtime.organisationId !== input.work.organisationId ||
    runtime.integrationAccountId !== input.work.integrationAccountId
  ) {
    return {
      kind: "terminal",
      reason: "case_context_collection_email_runtime_inactive",
    };
  }
  const integrationAccountId = parseIntegrationAccountId(
    input.work.integrationAccountId,
  );
  const caseId = parseCaseId(input.work.caseId);
  if (!integrationAccountId.ok || !caseId.ok)
    return {
      kind: "terminal",
      reason: "case_context_collection_email_identity_invalid",
    };
  const receipts = await ensureEmailCaseContextCollectionReceipts({
    scope: input.scope,
    sql: input.sql,
    work: input.work,
    integrationAccountId: integrationAccountId.value,
    caseId: caseId.value,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { kind: "retry", reason: "connector_placement_conflict" };
  if (receipts.kind !== "ready") return receipts;
  const access = await resolveEmailCaseContextCollectionAccess(input, runtime);
  switch (access.kind) {
    case "inactive":
      return { kind: "terminal", reason: access.reason };
    case "retry":
      return access;
    case "ready":
      try {
        return await discoverAdmittedEmailCaseContext({
          env: input.env,
          scope: input.scope,
          sql: input.sql,
          integrationAccountId: integrationAccountId.value,
          caseId: caseId.value,
          messageIds: input.work.messageIds,
          accessToken: access.accessToken,
          now: input.now,
          fetcher: runtimeFetch,
        });
      } catch {
        return { kind: "retry", reason: "case_context_discovery_exception" };
      }
    default:
      return assertNever(access);
  }
}

async function ensureEmailCaseContextCollectionReceipts(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    sql: SqlStorage;
    work: EmailCaseContextDiscoveryWork;
    integrationAccountId: IntegrationAccountId;
    caseId: CaseId;
  }>,
): Promise<
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "terminal" | "retry"; reason: string }>
> {
  for (const providerMessageId of input.work.messageIds) {
    if (!(await isActorExecutionActive(input.sql, input.scope)))
      return { kind: "retry", reason: "connector_placement_conflict" };
    const recorded = await recordEmailMessageReceipt({
      scope: input.scope,
      integrationAccountId: input.integrationAccountId,
      providerMessageId,
      gmailThreadId: input.work.threadId,
      caseId: input.caseId,
      policyVersion: input.work.policyVersion,
      now: input.work.admittedAt,
    });
    if (!recorded.ok) {
      return { kind: "retry", reason: recorded.error.code };
    }
  }
  return { kind: "ready" };
}

async function resolveEmailCaseContextCollectionAccess(
  input: Readonly<{
    env: Env;
    sql: SqlStorage;
    scope: OrganisationExecutionScope;
    now: number;
  }>,
  runtime: EmailRuntimeSnapshot,
): Promise<EmailCaseContextCollectionAccess> {
  try {
    if (!(await isActorExecutionActive(input.sql, input.scope)))
      return { kind: "retry", reason: "connector_placement_conflict" };
    const organisation = await requireActiveOrganisationActor({
      env: input.env,
      organisationId: input.scope.organisationId,
      now: input.now,
    });
    if (!(await isActorExecutionActive(input.sql, input.scope)))
      return { kind: "retry", reason: "connector_placement_conflict" };
    const readiness =
      await organisation.readCaseContextDiscoverySourceReadiness({
        organisationId: input.scope.organisationId,
        source: "gmail",
        integrationAccountId: runtime.integrationAccountId,
      });
    if (!(await isActorExecutionActive(input.sql, input.scope)))
      return { kind: "retry", reason: "connector_placement_conflict" };
    if (!readiness.ok) {
      return { kind: "retry", reason: readiness.error.code };
    }
    if (readiness.value.kind !== "ready") {
      return { kind: "inactive", reason: "case_context_collection_inactive" };
    }
    const access = await resolveConnectorGmailAccess({
      env: input.env,
      organisationId: input.scope.organisationId,
      integrationAccountId: runtime.integrationAccountId,
      now: input.now,
      fetcher: fetchConnectorMail.bind(
        null,
        input.sql,
        input.scope,
        runtimeFetch,
      ),
    });
    if (!(await isActorExecutionActive(input.sql, input.scope)))
      return { kind: "retry", reason: "connector_placement_conflict" };
    return access.ok
      ? { kind: "ready", accessToken: access.value }
      : { kind: "retry", reason: access.error.code };
  } catch {
    return {
      kind: "retry",
      reason: "case_context_collection_access_exception",
    };
  }
}

export async function maintainOperationalEmail(
  storage: DurableObjectStorage,
  scope: OrganisationExecutionScope,
): Promise<void> {
  if (!(await isActorExecutionActive(storage.sql, scope))) return;
  storage.transactionSync(
    expireOperationalEmailProposals.bind(null, storage.sql, Date.now()),
  );
  for (const record of pendingOperationalEmailProjections(storage.sql)) {
    const projected = await projectOperationalEmailRecord(
      storage.sql,
      scope,
      record,
      Date.now(),
    );
    if (!projected.ok) break;
  }
}

export async function executeOperationalEmailCommand<Value>(
  storage: DurableObjectStorage,
  armAlarm: () => Promise<unknown>,
  scope: OrganisationExecutionScope,
  proposalId: string,
  now: number,
  start: () => Promise<Result<Value, { readonly code: string }>>,
): Promise<ConnectorResult<Value>> {
  if (!(await isActorExecutionActive(storage.sql, scope)))
    return invalid("connector_placement_conflict");
  const result = await start();
  await armAlarm();
  if (!(await isActorExecutionActive(storage.sql, scope)))
    return invalid("connector_placement_conflict");
  const current = latestOperationalEmailProposal(storage.sql, proposalId);
  if (current !== null) {
    const projected = await projectOperationalEmailRecord(
      storage.sql,
      scope,
      current,
      now,
    );
    if (!projected.ok) return projected;
  }
  if (!(await isActorExecutionActive(storage.sql, scope)))
    return invalid("connector_placement_conflict");
  return result;
}

export async function rejectAdmittedOperationalEmail(
  sql: SqlStorage,
  scope: OrganisationExecutionScope,
  integrationAccountId: IntegrationAccountId,
  proposalId: string,
  version: number,
  now: number,
): Promise<Result<null, { readonly code: string }>> {
  if (!(await isActorExecutionActive(sql, scope)))
    return invalid("connector_placement_conflict");
  const current = latestOperationalEmailProposal(sql, proposalId);
  if (current !== null && current.integrationAccountId !== integrationAccountId)
    return invalid("operational_email_identity_invalid");
  return rejectOperationalEmailProposal(sql, proposalId, version, now);
}

export async function projectOperationalEmailRecord(
  sql: SqlStorage,
  scope: OrganisationExecutionScope,
  record: OperationalEmailProposalRecord,
  now: number,
): Promise<ConnectorResult<null>> {
  if (!(await isActorExecutionActive(sql, scope)))
    return invalid("connector_placement_conflict");
  const indeterminateRfcMessageId =
    record.state === "send_indeterminate"
      ? readOperationalEmailDispatchId(sql, record)
      : null;
  if (
    record.state === "send_indeterminate" &&
    indeterminateRfcMessageId === null
  )
    return invalid("operational_email_dispatch_receipt_missing");
  const projected = await projectEmailOperationalProposal({
    scope,
    integrationAccountId: record.integrationAccountId,
    proposalId: record.proposalId,
    caseId: record.caseId,
    target: record.target,
    currentVersion: record.version,
    targetDigest: record.targetDigest,
    subjectDigest: record.subjectDigest,
    bodyDigest: record.bodyDigest,
    snapshotDigest: record.snapshotDigest,
    lifecycleKind: record.state,
    providerMessageId: record.sentMessageId,
    providerThreadId: record.sentThreadId,
    indeterminateRfcMessageId,
    createdAt: record.createdAt,
    now,
  });
  if (!projected.ok)
    return invalid(
      projected.error.code === "organisation_placement_conflict"
        ? "connector_placement_conflict"
        : projected.error.code,
    );
  if (!(await isActorExecutionActive(sql, scope)))
    return invalid("connector_placement_conflict");
  settleOperationalEmailProjection(sql, record);
  return { ok: true, value: null };
}
