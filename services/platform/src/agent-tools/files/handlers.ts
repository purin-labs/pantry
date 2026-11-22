import type {
  AgentSessionLifecycle,
  CaseAssignment,
  HarnessTurnLease,
  WorkspaceRevisionReceipt,
} from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import { parseCaseId, type CaseId } from "@purin-labs/kernel/ids";
import {
  readWorkspaceRevision,
  verifyWorkspaceRevisionReceipt,
  type WorkspaceRevisionMaterialization,
} from "../../workspace-revision-store";
import type { AgentSessionPersistence } from "../../actors/agent-session-schema";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "../../actors/session-execution-admission";
import { storeSessionExecutionVaultSecret } from "@purin-labs/authority/credential-vault/service";
import type { FileProviderCredentialStore } from "../../provider-workflows/file-context-credential";
import { readCanonicalSessionForPersistence } from "../../actors/agent-session-canonical";
import { preflightHarnessTurnLease } from "../../actors/agent-session-harness-authority";
import type {
  HarnessFileRead,
  HarnessFileSearch,
  HarnessWorkspaceQuery,
  HarnessWorkspaceQueryResult,
} from "../catalog/types";
import {
  readGrantedFile,
  searchGrantedFiles,
  type FileReadToolResult,
  type FileSearchToolResult,
  type FileToolObservation,
} from "../../context/files";
import { admitSessionInformationFlowObservation } from "../../actors/agent-session-information-flow";
import { audiencesForAdmission } from "@purin-labs/authority/policy/index";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import type { SessionToolContext } from "../context";

export async function searchFilesForEmbeddedHarness(
  context: SessionToolContext,
  input: HarnessFileSearch,
): Promise<readonly FileSearchToolResult[]> {
  const { storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const caseId = authorizedFileToolCaseId(storage, lease, assignment);
  const results = await searchGrantedFiles({
    db: execution.scope.database,
    organisationId: execution.scope.organisationId,
    caseId,
    requestAuthority: lease.requestAuthority,
    visibility: audiencesForAdmission(lease.requestAuthority, caseId),
    query: input.query,
    limit: input.limit,
    observe: commitFileToolObservation.bind(null, storage, execution, lease),
  });
  await requireSessionExecution(execution, lease);
  requireCurrentHarnessToolLease(storage, lease);
  return results;
}

export async function readFileForEmbeddedHarness(
  context: SessionToolContext,
  input: HarnessFileRead,
): Promise<FileReadToolResult> {
  const { env, storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const caseId = authorizedFileToolCaseId(storage, lease, assignment);
  const result = await readGrantedFile({
    env,
    scope: execution.scope,
    authorizeExecution: requireSessionExecution.bind(null, execution, lease),
    storeCredential: storeSessionFileCredential.bind(
      null,
      env,
      execution,
      lease,
    ),
    caseId,
    requestAuthority: lease.requestAuthority,
    visibility: audiencesForAdmission(lease.requestAuthority, caseId),
    reference: input.reference,
    startSegment: input.startSegment,
    fetcher: fetchSessionFile.bind(null, storage, execution, lease),
    now: Date.now(),
    observe: commitFileToolObservation.bind(null, storage, execution, lease),
  });
  await requireSessionExecution(execution, lease);
  requireCurrentHarnessToolLease(storage, lease);
  return result;
}

function authorizedFileToolCaseId(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
): CaseId {
  requireCurrentHarnessToolLease(storage, lease);
  if (assignment.sessionId !== lease.session.sessionId) {
    throw new Error("file tool session binding invalid");
  }
  const caseId = parseCaseId(assignment.caseId);
  if (!caseId.ok) {
    throw new Error("file tool Case identity invalid");
  }
  return caseId.value;
}

function requireCurrentHarnessToolLease(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
): void {
  const authorized = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!authorized.ok) {
    throw new Error(
      `harness tool authority unavailable: ${authorized.error.code}`,
    );
  }
}

async function commitFileToolObservation(
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  observation: FileToolObservation,
): Promise<void> {
  await requireSessionExecution(execution, lease);
  requireCurrentHarnessToolLease(storage, lease);
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireSessionExecution.bind(null, execution, lease),
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId: execution.scope.organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    authorityPartitionDigest: lease.authorityPartitionDigest,
    inputLabel: observation.inputLabel,
    observation: observation.evidence,
    observedAt: observation.evidence.observedAt,
  });
  if (!admitted.ok) {
    throw new Error(
      `file tool information-flow commit failed: ${admitted.error.code}`,
    );
  }
}

async function fetchSessionFile(
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  await requireSessionExecution(execution, lease);
  requireCurrentHarnessToolLease(storage, lease);
  return fetch(input, init);
}

async function storeSessionFileCredential(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  input: Parameters<FileProviderCredentialStore>[0],
): Promise<boolean> {
  const result = await storeSessionExecutionVaultSecret({
    admission: execution,
    lease,
    keys: env,
    handle: input.credentialRef,
    secret: input.tokens,
    now: input.now,
  });
  return result.ok;
}

export async function queryWorkspaceForEmbeddedHarness(
  env: Env,
  persistence: AgentSessionPersistence,
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  query: HarnessWorkspaceQuery,
): Promise<HarnessWorkspaceQueryResult> {
  await requireSessionExecution(execution, lease);
  const materialized = await materializeWorkspaceForEmbeddedHarness(
    env,
    persistence,
    storage,
    execution,
    lease,
  );
  await requireSessionExecution(execution, lease);
  switch (query.kind) {
    case "read":
      return readHarnessWorkspaceFile(materialized, query.path);
    case "search":
      return searchHarnessWorkspace(materialized, query.query, query.limit);
    default:
      return assertNever(query);
  }
}

async function materializeWorkspaceForEmbeddedHarness(
  env: Env,
  persistence: AgentSessionPersistence,
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
): Promise<WorkspaceRevisionMaterialization> {
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const session = await readCanonicalSessionForPersistence(
    persistence,
    storage.sql,
    organisationId,
  );
  if (!session.ok || session.value.lifecycle.kind !== "processing") {
    throw new Error("workspace authority requires a processing session");
  }
  const receipt = workspaceReceiptForProcessingSession(session.value.lifecycle);
  const verified = await verifyWorkspaceRevisionReceipt(
    execution.scope,
    organisationId,
    receipt,
  );
  if (!verified.ok) {
    throw new Error(`workspace receipt unavailable: ${verified.error.code}`);
  }
  await requireSessionExecution(execution, lease);
  const materialized = await readWorkspaceRevision(
    execution.scope.database,
    env.ARCHIVE,
    {
      organisationId,
      workspaceId: receipt.workspaceId,
      revision: receipt.revision,
    },
  );
  if (!materialized.ok) {
    throw new Error(
      `workspace revision unavailable: ${materialized.error.code}`,
    );
  }
  if (materialized.value.canonicalHead !== receipt.canonicalHead) {
    throw new Error("workspace revision authority mismatch");
  }
  const current = await readCanonicalSessionForPersistence(
    persistence,
    storage.sql,
    organisationId,
  );
  if (
    !current.ok ||
    JSON.stringify(current.value.lifecycle) !==
      JSON.stringify(session.value.lifecycle)
  ) {
    throw new Error("workspace session changed during read");
  }
  await requireSessionExecution(execution, lease);
  return materialized.value;
}

function workspaceReceiptForProcessingSession(
  state: Variant<AgentSessionLifecycle, "processing">,
): WorkspaceRevisionReceipt {
  const resumePoint = state.state.resumePoint;
  return resumePoint.kind === "new"
    ? resumePoint.workspaceRevisionReceipt
    : resumePoint.checkpoint.workspaceRevisionReceipt;
}

function readHarnessWorkspaceFile(
  workspace: WorkspaceRevisionMaterialization,
  path: string,
): HarnessWorkspaceQueryResult {
  for (const file of workspace.manifest.files) {
    if (file.path !== path) {
      continue;
    }
    return {
      kind: "file",
      revision: workspace.revision,
      path: file.path,
      mediaType: file.mediaType,
      sha256: file.sha256,
      content: file.content,
    };
  }
  throw new Error(`workspace file does not exist: ${path}`);
}

function searchHarnessWorkspace(
  workspace: WorkspaceRevisionMaterialization,
  query: string,
  limit: number,
): HarnessWorkspaceQueryResult {
  const normalizedQuery = query.toLowerCase();
  const matches: Array<{ path: string; line: number; excerpt: string }> = [];
  let truncated = false;
  for (const file of workspace.manifest.files) {
    const lines = file.content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line.toLowerCase().includes(normalizedQuery)) {
        continue;
      }
      if (matches.length === limit) {
        truncated = true;
        break;
      }
      matches.push({
        path: file.path,
        line: index + 1,
        excerpt: line.slice(0, 512),
      });
    }
    if (truncated) {
      break;
    }
  }
  return {
    kind: "matches",
    revision: workspace.revision,
    matches,
    truncated,
  };
}
