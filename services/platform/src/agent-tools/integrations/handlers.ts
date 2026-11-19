import { acceptedExecutionAccountAuthority } from "../../account-platform/access";
import {
  airtableBaseScope,
  type AirtableAccountRequest,
  type AirtableReadInput,
  type AirtableWriteInput,
} from "../../actors/airtable-tool-input";
import { callAirtableApi } from "../../integrations/airtable-api";
import { resolveAirtableAccountToken } from "../../external-records/oauth";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "../../env";
import {
  parseCaseId,
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../ids";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "../../actors/session-execution-admission";
import { preflightHarnessTurnLease } from "../../actors/agent-session-harness-authority";
import type { HarnessIntegrationListRequest } from "../catalog/types";
import {
  readIntegrationDiscovery,
  type IntegrationDiscoveryObservation,
} from "../../access-control/integration-discovery";
import { authorizeCapabilityUse } from "../../authorization/access-grants/turn-authority";
import {
  authorizeCustomConnectorRead,
  customConnectorResourceScope,
  executeAuthorizedCustomConnectorRead,
  type CustomConnectorReadCatalogEntry,
} from "../../custom-connectors";
import { customConnectorFetchOf } from "../../custom-connectors/egress";
import type { CapabilityDefinition } from "../../authorization/access-grants/capability-key";
import {
  admitSessionInformationFlowObservation,
  readSessionInformationFlow,
  readSessionTurnFlowBinding as readPersistedSessionTurnFlowBinding,
} from "../../actors/agent-session-information-flow";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  ObservationEvidence,
} from "../../policy";
import { digestCanonical } from "../../policy";
import { listAccessGrants } from "../../data/access-grants";
import { selectActiveGrants } from "../../authorization/access-grants/compiler";
import type { EffectiveGrantSet } from "../../authorization/access-grants";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import type { Variant } from "@purin-labs/type-utils";
import {
  type EmailMailboxReadScope,
  evaluateHarnessFlowSink,
  readAccessGrantId,
  requireCurrentEmailToolLease,
  selectProviderResourceGrants,
  toolEffectPassesExit,
} from "../session-support";
import type { SessionToolContext } from "../context";

async function isCustomConnectorTurnActive(
  execution: SessionExecutionAdmission,
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
): Promise<boolean> {
  if (!preflightHarnessTurnLease(storage, lease, Date.now()).ok) {
    return false;
  }
  const active = await execution.isTurnActive(lease);
  return active && preflightHarnessTurnLease(storage, lease, Date.now()).ok;
}

export async function readCustomConnectorForEmbeddedHarness(
  env: Env,
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  effectiveGrantSet: EffectiveGrantSet,
  entry: CustomConnectorReadCatalogEntry,
  rawArguments: unknown,
  operationId: string,
): Promise<unknown> {
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const invocationStartedAt = Date.now();
  const deadlineAtUnixMs = Math.min(
    lease.expiresAt,
    invocationStartedAt + entry.limits.invocationTimeoutMs,
  );
  const active = preflightHarnessTurnLease(storage, lease, invocationStartedAt);
  if (
    !active.ok ||
    assignment.sessionId !== lease.session.sessionId ||
    assignment.authorityPartition.digest !== lease.authorityPartitionDigest
  ) {
    throw new Error("custom connector read authority unavailable");
  }
  const flowBinding = await readPersistedSessionTurnFlowBinding(storage.sql, {
    organisationId: String(organisationId),
    sessionId: String(lease.session.sessionId),
    turnId: String(lease.turn.turnId),
  });
  if (
    !flowBinding.ok ||
    flowBinding.value === null ||
    flowBinding.value.authorityPartitionDigest !==
      lease.authorityPartitionDigest
  ) {
    throw new Error("custom connector information-flow authority unavailable");
  }
  const signingKey = env.SESSION_TOKEN_SECRET?.trim() ?? "";
  const authorizedAt = Date.now();
  const authorization = await authorizeCustomConnectorRead({
    db: execution.scope.database,
    accountAccess: execution.scope.accountAccess,
    effectiveGrants: effectiveGrantSet,
    acceptedEntry: entry,
    rawArguments,
    flowBinding: flowBinding.value.binding,
    destinationAuthority: lease.requestAuthority,
    execution: {
      executionId: `custom_connector:${lease.turn.turnId}:${operationId}`,
      leaseId: lease.leaseId,
      deadlineAtUnixMs,
    },
    cursorSigningKey: signingKey,
    now: authorizedAt,
  });
  if (!authorization.ok) {
    throw new Error(
      `custom connector read rejected: ${authorization.error.code}`,
    );
  }
  const result = await executeAuthorizedCustomConnectorRead({
    db: execution.scope.database,
    keys: env,
    namespace: customConnectorFetchOf(
      env.CUSTOM_CONNECTOR_FETCH,
      execution.scope.placement,
    ),
    authorization: authorization.value,
    effectiveGrants: effectiveGrantSet,
    isExecutionActive: isCustomConnectorTurnActive.bind(
      null,
      execution,
      storage,
      lease,
    ),
    cursorSigningKey: signingKey,
    now: Date.now(),
  });
  if (!result.ok) {
    const reason =
      result.error.code === "custom_connector_transport_failed"
        ? result.error.reason
        : result.error.code;
    throw new Error(`custom connector read failed: ${reason}`);
  }
  const observedAt = Date.now();
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "integration_resource",
      organisationId: String(organisationId),
      integrationAccountId: String(entry.integrationAccountId),
      resourceScope: customConnectorResourceScope(entry),
    },
    sourceRevision: entry.bindingRevision,
    contentDigest: await digestCanonical(result.value.data),
    inputLabel: result.value.sourceLabel,
    observedAt,
  });
  if (!evidence.ok) {
    throw new Error(
      `custom connector observation invalid: ${evidence.error.code}`,
    );
  }
  await requireSessionExecution(execution, lease);
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireSessionExecution.bind(null, execution, lease),
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId: String(organisationId),
    sessionId: String(lease.session.sessionId),
    turnId: String(lease.turn.turnId),
    authorityPartitionDigest: String(lease.authorityPartitionDigest),
    inputLabel: result.value.sourceLabel,
    observation: evidence.value,
    observedAt,
  });
  if (!admitted.ok) {
    throw new Error(
      `custom connector observation failed: ${admitted.error.code}`,
    );
  }
  const stillActive = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!stillActive.ok) {
    throw new Error(
      `custom connector authority expired: ${stillActive.error.code}`,
    );
  }
  await requireSessionExecution(execution, lease);
  return result.value.data;
}

export async function listIntegrationsForEmbeddedHarness(
  context: SessionToolContext,
  request: HarnessIntegrationListRequest,
): Promise<import("@purin-labs/contracts").IntegrationDiscoveryView> {
  const { storage, execution, lease, assignment } = context;
  const organisationId = execution.scope.organisationId;
  await requireSessionExecution(execution, lease);
  if (request.kind !== "list") {
    throw new Error("integration discovery request invalid");
  }
  if (assignment.sessionId !== lease.session.sessionId) {
    throw new Error("integration discovery authority unavailable");
  }
  const caseId = parseCaseId(assignment.caseId);
  if (!caseId.ok) {
    throw new Error("integration discovery Case identity unavailable");
  }
  const discovered = await readIntegrationDiscovery({
    db: execution.scope.database,
    accountAccess: execution.scope.accountAccess,
    userAuthority: acceptedExecutionAccountAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    organisationId,
    requestAuthority: lease.requestAuthority,
    authorityPartition: assignment.authorityPartition,
    caseId: caseId.value,
    observedAt: Date.now(),
    observe: commitIntegrationDiscoveryObservation.bind(
      null,
      storage,
      execution,
      lease,
    ),
  });
  if (!discovered.ok) {
    throw new Error(
      `integration discovery unavailable: ${discovered.error.stage}`,
    );
  }
  await requireSessionExecution(execution, lease);
  return discovered.value;
}

async function commitIntegrationDiscoveryObservation(
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  observation: IntegrationDiscoveryObservation,
): Promise<void> {
  const organisationId = execution.scope.organisationId;
  await requireSessionExecution(execution, lease);
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireSessionExecution.bind(null, execution, lease),
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    authorityPartitionDigest: lease.authorityPartitionDigest,
    inputLabel: observation.inputLabel,
    observation: observation.evidence,
    observedAt: observation.evidence.observedAt,
  });
  if (!admitted.ok) {
    throw new Error(
      `integration discovery information-flow commit failed: ${admitted.error.code}`,
    );
  }
}

async function authorizeAirtableTool(
  execution: SessionExecutionAdmission,
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  input: AirtableAccountRequest,
  capabilityId:
    | typeof CAPABILITY_KEYS.airtableApiRead
    | typeof CAPABILITY_KEYS.airtableApiWrite,
): Promise<EmailMailboxReadScope> {
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const database = execution.scope.database;
  const caseId = requireCurrentEmailToolLease(storage, lease, assignment);
  const capability: Variant<CapabilityDefinition, "provider_resource"> = {
    kind: "provider_resource",
    capabilityId,
    capabilityVersion: 1,
    integrationAccountId: input.integrationAccountId,
    resourceScope: airtableBaseScope(input),
  };
  const authorized = await authorizeCapabilityUse({
    db: database,
    accountAccess: execution.scope.accountAccess,
    userAuthority: acceptedExecutionAccountAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    action: "execute",
    organisationId,
    authority: lease.requestAuthority,
    authorityPartition: assignment.authorityPartition,
    request: { capabilities: [capability] },
  });
  if (!authorized.ok) {
    throw new Error(`Airtable permission denied: ${authorized.error.code}`);
  }
  const grants = await listAccessGrants({
    db: database,
    organisationId,
    lifecycle: "active",
  });
  if (!grants.ok) {
    throw new Error("Airtable grants unavailable");
  }
  const selected = selectActiveGrants({
    organisationId,
    authority: lease.requestAuthority,
    grants: grants.value,
  });
  if (!selected.ok) {
    throw new Error("Airtable authority unavailable");
  }
  const matching = selectProviderResourceGrants(selected.value, capability);
  const label = await createCurrentSourceFlowLabel({
    kind: "integration_resource",
    db: database,
    organisationId,
    integrationAccountId: input.integrationAccountId,
    capabilityId,
    resourceScope: capability.resourceScope,
    grantIds: matching.map(readAccessGrantId),
  });
  if (!label.ok) {
    throw new Error(`Airtable source policy unavailable: ${label.error.code}`);
  }
  const admission = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: lease.requestAuthority,
      caseId,
    },
    inputLabel: label.value,
  });
  if (admission.kind !== "admit") {
    throw new Error("Airtable context admission denied");
  }
  await requireSessionExecution(execution, lease);
  return { capability, inputLabel: label.value };
}

export async function readAirtableForHarness(
  context: SessionToolContext,
  input: AirtableReadInput,
): Promise<unknown> {
  const { env, storage, execution, lease, assignment } = context;
  if (input.kind === "discover") {
    return discoverAirtableForHarness(execution, storage, lease, assignment);
  }
  const scope = await authorizeAirtableTool(
    execution,
    storage,
    lease,
    assignment,
    input,
    CAPABILITY_KEYS.airtableApiRead,
  );
  const credential = await resolveAirtableAccountToken(
    env,
    execution.scope.organisationId,
    input.integrationAccountId,
    "read",
  );
  await requireSessionExecution(execution, lease);
  const output = await callAirtableApi(credential, input.request);
  await authorizeAirtableTool(
    execution,
    storage,
    lease,
    assignment,
    input,
    CAPABILITY_KEYS.airtableApiRead,
  );
  await commitAirtableObservation(storage, execution, lease, scope, output);
  return output;
}

async function discoverAirtableForHarness(
  execution: SessionExecutionAdmission,
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
): Promise<unknown> {
  const bases: {
    integrationAccountId: IntegrationAccountId;
    baseId: string;
  }[] = [];
  for (const key of assignment.authorityPartition.capabilityKeys) {
    const prefix = `provider:${CAPABILITY_KEYS.airtableApiRead}:1:`;
    if (!key.startsWith(prefix)) {
      continue;
    }
    const match = /^([^:]+):base:(app[A-Za-z0-9]{8,32})$/u.exec(
      key.slice(prefix.length),
    );
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const account = parseIntegrationAccountId(match[1]);
    if (!account.ok) {
      continue;
    }
    const input: AirtableAccountRequest = {
      integrationAccountId: account.value,
      request: {
        baseId: match[2],
        url: `https://api.airtable.com/v0/meta/bases/${match[2]}/tables`,
        method: "GET",
        body: null,
      },
    };
    const scope = await authorizeAirtableTool(
      execution,
      storage,
      lease,
      assignment,
      input,
      CAPABILITY_KEYS.airtableApiRead,
    );
    const base = { integrationAccountId: account.value, baseId: match[2] };
    await commitAirtableObservation(storage, execution, lease, scope, base);
    bases.push(base);
  }
  return { bases };
}

export async function writeAirtableForHarness(
  context: SessionToolContext,
  input: AirtableWriteInput,
): Promise<unknown> {
  const { env, storage, execution, lease, assignment } = context;
  const organisationId = execution.scope.organisationId;
  const scope = await authorizeAirtableTool(
    execution,
    storage,
    lease,
    assignment,
    input,
    CAPABILITY_KEYS.airtableApiWrite,
  );
  const credential = await resolveAirtableAccountToken(
    env,
    organisationId,
    input.integrationAccountId,
    "write",
  );
  const flow = await readSessionInformationFlow(storage.sql, {
    organisationId,
    sessionId: lease.session.sessionId,
  });
  if (
    !flow.ok ||
    flow.value === null ||
    flow.value.context.authorityPartitionDigest !==
      lease.authorityPartitionDigest
  ) {
    throw new Error("Airtable effect context unavailable");
  }
  const sink = {
    kind: "tool_effect",
    destinationAuthority: lease.requestAuthority,
    capabilityId: CAPABILITY_KEYS.airtableApiWrite,
    integrationAccountId: input.integrationAccountId,
    resourceScope: airtableBaseScope(input),
    approvalSatisfied: false,
  } as const;
  const decision = await evaluateHarnessFlowSink(
    execution.scope.database,
    execution.scope.accountAccess,
    acceptedExecutionAccountAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    { flowLabel: flow.value.context.workLabel, sink },
  );
  if (
    !(await toolEffectPassesExit(env, execution, lease, {
      decision,
      flowLabel: flow.value.context.workLabel,
      sink,
      action: { operation: "airtable.write", arguments: input },
    }))
  ) {
    throw new Error(
      `Airtable write requires policy resolution: ${decision.kind}`,
    );
  }
  await authorizeAirtableTool(
    execution,
    storage,
    lease,
    assignment,
    input,
    CAPABILITY_KEYS.airtableApiWrite,
  );
  const receiptId = `airtable_write_${await digestCanonical({ turnId: lease.turn.turnId, input })}`;
  await storage.transaction(
    claimAirtableWrite.bind(null, receiptId, organisationId, input),
  );
  try {
    await requireSessionExecution(execution, lease);
  } catch (error) {
    // This attempt has no provider request to reconcile.
    await storage.delete(receiptId);
    throw error;
  }
  const result = await callAirtableApi(credential, input.request);
  await storage.put(receiptId, {
    kind: "completed",
    organisationId,
    result,
    completedAt: Date.now(),
  });
  await authorizeAirtableTool(
    execution,
    storage,
    lease,
    assignment,
    input,
    CAPABILITY_KEYS.airtableApiWrite,
  );
  await commitAirtableObservation(storage, execution, lease, scope, result);
  return { receiptId, result };
}

async function claimAirtableWrite(
  receiptId: string,
  organisationId: OrganisationId,
  input: AirtableWriteInput,
  transaction: DurableObjectTransaction,
): Promise<void> {
  const previous: unknown = await transaction.get(receiptId);
  if (previous !== undefined) {
    throw new Error(
      "Airtable write already attempted in this turn; read the table before issuing another write",
    );
  }
  await transaction.put(receiptId, {
    kind: "pending",
    organisationId,
    input,
    attemptedAt: Date.now(),
  });
}

async function commitAirtableObservation(
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  scope: EmailMailboxReadScope,
  result: unknown,
): Promise<void> {
  const organisationId = execution.scope.organisationId;
  const now = Date.now();
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "integration_resource",
      organisationId,
      integrationAccountId: scope.capability.integrationAccountId,
      resourceScope: scope.capability.resourceScope,
    },
    sourceRevision: now,
    contentDigest: await digestCanonical(result),
    inputLabel: scope.inputLabel,
    observedAt: now,
  });
  if (!evidence.ok) {
    throw new Error("Airtable observation invalid");
  }
  await requireSessionExecution(execution, lease);
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireSessionExecution.bind(null, execution, lease),
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    authorityPartitionDigest: lease.authorityPartitionDigest,
    inputLabel: scope.inputLabel,
    observation: evidence.value,
    observedAt: now,
  });
  if (!admitted.ok) {
    throw new Error("Airtable observation rejected");
  }
}
