import { resolveCollaborationAgent } from "../../actors/collaboration-agent";
import { acceptedExecutionAccountAuthority } from "../../account-platform/access";
import { workflowCanvasDocumentId } from "@purin-labs/bakery-model/bakery-canvas-source";
import type {
  WorkflowCanvasReadRequest,
  WorkflowCanvasMoveRequest,
} from "../../actors/workflow-canvas-tools";
import {
  authorizeCanvasTurnDocument,
  sessionTurnExecution,
} from "../../chat/turn-access";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "../../env";
import { newRequestId } from "../../ids";
import { traceWarn } from "../../observability";
import { requireActiveOrganisationActorAtPlacement } from "../../actors/actor-router";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "../../actors/session-execution-admission";
import { preflightHarnessTurnLease } from "../../actors/agent-session-harness-authority";
import type { CatalogExecutionContext } from "../catalog/execute";
import { authorizeCapabilityUse } from "../../authorization/access-grants/turn-authority";
import { admitSessionInformationFlowObservation } from "../../actors/agent-session-information-flow";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  ObservationEvidence,
  type FlowLabel,
} from "../../policy";
import { digestCanonical } from "../../policy";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { sha256Hex } from "@purin-labs/std";
import {
  collaborationEditDeadline,
  collaborationMember,
  requireLiveBakeryReadAuthority,
  type ToolEffect,
} from "../session-support";
import type { SessionToolContext } from "../context";

type PreparedWorkflowCanvasRead = Readonly<{
  kind: "saved-run";
  snapshotId: string;
  label: FlowLabel;
  execution: SessionExecutionAdmission;
}>;

async function prepareWorkflowCanvasRead(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  request: WorkflowCanvasReadRequest,
): Promise<PreparedWorkflowCanvasRead> {
  if (
    !(await authorizeCanvasTurnDocument(
      execution.scope.database,
      execution.scope.organisationId,
      sessionTurnExecution(lease),
      workflowCanvasDocumentId(request.reference),
    ))
  ) {
    throw new Error(
      "Workflow canvas is outside this conversation's document scope",
    );
  }
  await requireLiveBakeryReadAuthority(execution, lease);
  if (
    assignment.sessionId !== lease.session.sessionId ||
    assignment.caseId.length === 0
  ) {
    throw new Error("Workflow canvas information-flow identity unavailable");
  }
  const allowed = await authorizeCapabilityUse({
    db: execution.scope.database,
    accountAccess: execution.scope.accountAccess,
    userAuthority: acceptedExecutionAccountAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    action: "execute",
    organisationId: execution.scope.organisationId,
    authority: lease.requestAuthority,
    authorityPartition: assignment.authorityPartition,
    request: {
      capabilities: [
        {
          kind: "platform_capability",
          capabilityId: CAPABILITY_KEYS.commerceEntityPlaneContext,
          capabilityVersion: 1,
        },
      ],
    },
  });
  if (!allowed.ok) {
    throw new Error(`Workflow canvas read denied: ${allowed.error.code}`);
  }
  const label = await createCurrentSourceFlowLabel({
    kind: "saved_bakery_run",
    db: execution.scope.database,
    authority: lease.requestAuthority,
  });
  if (!label.ok) {
    throw new Error("Saved-run canvas source policy unavailable");
  }
  const admission = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: lease.requestAuthority,
      caseId: String(assignment.caseId),
    },
    inputLabel: label.value,
  });
  if (admission.kind !== "admit") {
    throw new Error("Saved-run canvas context admission denied");
  }
  await requireLiveBakeryReadAuthority(execution, lease);
  return {
    kind: "saved-run",
    snapshotId: request.reference.snapshotId,
    label: label.value,
    execution,
  };
}

async function admitWorkflowCanvasObservation(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  prepared: PreparedWorkflowCanvasRead,
  value: unknown,
  revision: number,
  description: string,
): Promise<void> {
  const { execution } = prepared;
  await requireLiveBakeryReadAuthority(execution, lease);
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "organisation_record",
      organisationId: execution.scope.organisationId,
      recordId: `bakery-run:${prepared.snapshotId}:canvas`,
    },
    sourceRevision: revision,
    contentDigest: await digestCanonical(value),
    inputLabel: prepared.label,
    observedAt: Date.now(),
  });
  if (!evidence.ok) {
    throw new Error("Saved-run canvas observation is invalid");
  }
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireLiveBakeryReadAuthority.bind(
      null,
      execution,
      lease,
    ),
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId: execution.scope.organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    authorityPartitionDigest: lease.authorityPartitionDigest,
    inputLabel: prepared.label,
    observation: evidence.value,
    observedAt: evidence.value.observedAt,
  });
  if (!admitted.ok) {
    throw new Error("Saved-run canvas observation admission failed");
  }
  await requireLiveBakeryReadAuthority(execution, lease);
}

export async function readWorkflowCanvasForEmbeddedHarness(
  context: SessionToolContext,
  request: WorkflowCanvasReadRequest,
) {
  const { env, storage, execution, lease, assignment } = context;
  const organisationId = execution.scope.organisationId;
  const prepared = await prepareWorkflowCanvasRead(
    env,
    execution,
    lease,
    assignment,
    request,
  );
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "read",
  );
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const result = await organisation.readWorkflowCanvas({
    organisationId,
    reference: request.reference,
    userId: member.userId,
    agentRequest: {
      sessionId: lease.session.sessionId,
      turnId: lease.turn.turnId,
    },
  });
  if (!result.ok) {
    throw new Error(`Workflow canvas unavailable: ${result.error.code}`);
  }
  await admitWorkflowCanvasObservation(
    storage,
    lease,
    prepared,
    result.value,
    result.value.documentRevision,
    "workflow canvas",
  );
  return result.value;
}

export async function moveWorkflowCanvasForEmbeddedHarness(
  context: SessionToolContext,
  request: WorkflowCanvasMoveRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
): Promise<ToolEffect> {
  const { env, storage, execution, lease, assignment } = context;
  const deadlineAt = collaborationEditDeadline(
    storage,
    lease,
    boundary,
    Date.now(),
  );
  const organisationId = execution.scope.organisationId;
  const prepared = await prepareWorkflowCanvasRead(
    env,
    execution,
    lease,
    assignment,
    request,
  );
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "edit",
  );
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const before = await organisation.readWorkflowCanvas({
    organisationId,
    reference: request.reference,
    userId: member.userId,
    agentRequest: {
      sessionId: lease.session.sessionId,
      turnId: lease.turn.turnId,
    },
  });
  if (!before.ok) {
    throw new Error(`Workflow canvas unavailable: ${before.error.code}`);
  }
  await admitWorkflowCanvasObservation(
    storage,
    lease,
    prepared,
    before.value,
    before.value.documentRevision,
    "workflow canvas move",
  );
  return {
    kind: "shared_draft",
    member,
    unavailable: "Workflow canvas information-flow authority unavailable",
    draft: {
      shared: "every_member",
      edit: {
        draft: "Workflow canvas",
        capabilityId: CAPABILITY_KEYS.commerceWorkflowCanvasMove,
        integrationAccountId: "platform",
        resourceScope: `bakery-run:${prepared.snapshotId}:canvas`,
      },
      refused: (decision) => {
        traceWarn("session.workflow_canvas_disclosure_denied", {
          requestId: newRequestId(),
          organisation_id: organisationId,
          session_id: lease.session.sessionId,
          turn_id: lease.turn.turnId,
          decision_kind: decision.kind,
          reason_code: "reason" in decision ? decision.reason.code : null,
          restriction_rule_id:
            "reason" in decision ? decision.reason.ruleId : null,
        });
      },
    },
    run: async () => {
      const logicalOperationId = await sha256Hex(
        JSON.stringify([
          lease.session.sessionId,
          lease.turn.turnId,
          operationId,
        ]),
      );
      const active = preflightHarnessTurnLease(storage, lease, Date.now());
      if (!active.ok) {
        throw new Error(
          `Workflow canvas move authority expired: ${active.error.code}`,
        );
      }
      await requireSessionExecution(execution, lease);
      const result = await organisation.moveWorkflowCanvasObject({
        agent: await resolveCollaborationAgent(execution.scope, assignment),
        organisationId,
        reference: request.reference,
        userId: member.userId,
        deadlineAt,
        execution: sessionTurnExecution(lease),
        request: {
          documentId: workflowCanvasDocumentId(request.reference),
          operationId: logicalOperationId,
          expectedRevision: request.expectedRevision,
          objectId: request.destination.objectId,
          x: request.destination.x,
          y: request.destination.y,
        },
      });
      if (!result.ok) {
        throw new Error(`Workflow canvas move denied: ${result.error.code}`);
      }
      const revision =
        result.value.kind === "accepted"
          ? result.value.receipt.documentRevision
          : before.value.documentRevision;
      await admitWorkflowCanvasObservation(
        storage,
        lease,
        prepared,
        result.value,
        revision,
        "workflow canvas move",
      );
      return result.value;
    },
  };
}
