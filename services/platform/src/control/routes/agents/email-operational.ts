import type { Env } from "../../../env";
import {
  parseOperationalEmailTarget,
  recordOperationalEmailAttestation,
  registerOperationalEmailContact,
  readEmailOperationalProposalProjection,
} from "../../../data/email-operational";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
} from "../../../ids";
import { admitUserMutation } from "../../admission/control-mutation";
import { authorizeOrganisationRequest } from "../../authorization";
import {
  controlError,
  controlJson,
  noStoreJson,
  readJsonRecord,
  type JsonRecord,
} from "../../http";
import { recordCommerceMutationReceipt } from "../../mutation-receipt";
import { hasExactKeys, isPositiveInteger } from "@purin-labs/std";
import { agentMailboxConnector } from "../../../mail-inbox/agent-mailbox-connector";
import {
  emailApprovalChallenge,
  emailApprovalSecret,
  verifyEmailApprovalChallenge,
} from "../../../mail-inbox/email-approval-challenge";
import {
  syncOperationalCaseEdit,
  syncOperationalCaseLifecycle,
} from "../../../mail-inbox/email-operational-lifecycle";

export async function handleEmailOperationalContactSync(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (
    !body.ok ||
    !hasExactKeys(body.value, [
      "target",
      "address",
      "displayName",
      "state",
      "relationshipState",
    ])
  ) {
    return controlError("email_operational_contact_request_invalid", 422);
  }
  const target = parseOperationalEmailTarget(body.value.target);
  if (
    target === null ||
    typeof body.value.address !== "string" ||
    (body.value.displayName !== null &&
      typeof body.value.displayName !== "string") ||
    (body.value.state !== "active" && body.value.state !== "suppressed") ||
    (body.value.relationshipState !== "active" &&
      body.value.relationshipState !== "inactive")
  ) {
    return controlError("email_operational_contact_request_invalid", 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/email-operational-contacts`,
    operation: "email_operational.contact_sync",
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const now = Date.now();
  const registered = await registerOperationalEmailContact({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    target,
    address: body.value.address,
    displayName: body.value.displayName,
    state: body.value.state,
    relationshipState: body.value.relationshipState,
    now,
  });
  if (!registered.ok) return operationalControlError(registered.error.code);
  const responseBody = {
    ok: true,
    kind: "contact_synchronized",
    target,
  };
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

export async function handleEmailOperational(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  proposalIdRaw: string,
  action:
    "approve" | "reject" | "edit" | "attest-present" | "attest-absent" | null,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    action === null ? "viewer" : "admin",
    action !== null,
  );
  if (!authorized.ok) return authorized.response;
  const projection = await readEmailOperationalProposalProjection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    proposalId: proposalIdRaw,
  });
  if (projection === null) {
    return controlError("email_operational_not_found", 404);
  }
  const accountId = parseIntegrationAccountId(projection.integrationAccountId);
  if (!accountId.ok) return controlError("email_operational_not_found", 404);
  const connector = await agentMailboxConnector(
    env,
    authorized.organisationId,
    accountId.value,
  );
  if (!connector.ok) {
    return controlError("email_operational_connector_unavailable", 502);
  }
  const now = Date.now();

  if (action === null) {
    if (request.method !== "GET") {
      return controlError("method_not_allowed", 405);
    }
    const secret = emailApprovalSecret(env);
    if (secret === null) return controlError("email_reply_secret_missing", 500);
    const preview = await connector.value.stub.previewEmailOperationalProposal({
      identity: connector.value.identity,
      integrationAccountId: accountId.value,
      proposalId: projection.proposalId,
      now,
    });
    if (!preview.ok) return operationalControlError(preview.error.code);
    switch (preview.value.kind) {
      case "current": {
        const current = preview.value.preview;
        return noStoreJson({
          ok: true,
          kind: "current",
          proposal: operationalProposalPreviewWire(current),
          challenge: await emailApprovalChallenge({
            secret,
            proposalId: current.proposalId,
            version: current.version,
            snapshotDigest: current.snapshotDigest,
            userId: authorized.authenticated.session.userId,
          }),
        });
      }
      case "proposal_missing":
        await syncOperationalCaseLifecycle({
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: { kind: "proposal_missing" },
          now,
        });
        return noStoreJson({ ok: true, kind: "proposal_missing" });
      case "expired":
        await syncOperationalCaseLifecycle({
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: {
            kind: "expired",
            expiredAt: now,
            disposal: { kind: "cleaned", deletedAt: now },
          },
          now,
        });
        return noStoreJson({ ok: true, kind: "expired" });
      case "target_changed":
        await syncOperationalCaseLifecycle({
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: {
            kind: "invalidated",
            reason: "target_changed",
            disposal: { kind: "cleaned", deletedAt: now },
          },
          now,
        });
        return noStoreJson({ ok: true, kind: "target_changed" });
      case "content_unavailable":
        return noStoreJson({ ok: true, kind: "content_unavailable" });
    }
  }

  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("email_operational_request_invalid", 422);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "after_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/email-operational/${projection.proposalId}/${action}`,
    operation: `email_operational.${action}`,
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;

  let responseBody: Record<string, unknown>;
  if (action === "attest-present" || action === "attest-absent") {
    if (
      Object.keys(body.value).length !== 0 ||
      projection.lifecycleKind !== "send_indeterminate"
    ) {
      return controlError("email_operational_attestation_invalid", 409);
    }
    const attestation = action === "attest-present" ? "present" : "absent";
    const recorded = await recordOperationalEmailAttestation({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      proposalId: projection.proposalId,
      attestation,
      attestedBy: authorized.authenticated.session.userId,
      attestedAt: now,
    });
    if (!recorded.ok) return operationalControlError(recorded.error.code);
    await syncOperationalCaseLifecycle({
      env,
      organisationId: authorized.organisationId,
      projection,
      lifecycle: {
        kind:
          attestation === "present"
            ? "operator_attested_present"
            : "operator_attested_absent",
        attestedBy: authorized.authenticated.session.userId,
        attestedAt: now,
      },
      now,
    });
    responseBody = { ok: true, kind: `operator_attested_${attestation}` };
  } else if (action === "edit") {
    if (!validOperationalEditBody(body.value)) {
      return controlError("email_operational_request_invalid", 422);
    }
    const edited = await connector.value.stub.editEmailOperationalProposal({
      identity: connector.value.identity,
      integrationAccountId: accountId.value,
      proposalId: projection.proposalId,
      subject: body.value.subject,
      body: body.value.body,
      ...(body.value.version === undefined
        ? {}
        : { expectedVersion: body.value.version }),
      now,
    });
    if (!edited.ok) return operationalControlError(edited.error.code);
    const updatedProjection = await readEmailOperationalProposalProjection({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      proposalId: projection.proposalId,
    });
    if (updatedProjection === null) {
      return controlError("email_operational_projection_missing", 502);
    }
    await syncOperationalCaseEdit({
      env,
      organisationId: authorized.organisationId,
      projection: updatedProjection,
      now,
    });
    responseBody = {
      ok: true,
      kind: "edited",
      version: edited.value.version,
      snapshot_digest: edited.value.snapshotDigest,
    };
  } else if (action === "reject") {
    if (Object.keys(body.value).length !== 0) {
      return controlError("email_operational_request_invalid", 422);
    }
    const rejected = await connector.value.stub.rejectEmailOperational({
      identity: connector.value.identity,
      integrationAccountId: accountId.value,
      proposalId: projection.proposalId,
      approvedVersion: projection.currentVersion,
      approvedSnapshotDigest: projection.snapshotDigest,
      now,
    });
    if (!rejected.ok) return operationalControlError(rejected.error.code);
    await syncOperationalCaseLifecycle({
      env,
      organisationId: authorized.organisationId,
      projection,
      lifecycle: {
        kind: "rejected",
        rejectedBy: authorized.authenticated.session.userId,
        rejectedAt: now,
        disposal: { kind: "cleaned", deletedAt: now },
      },
      now,
    });
    responseBody = { ok: true, kind: "rejected" };
  } else {
    const secret = emailApprovalSecret(env);
    if (secret === null) return controlError("email_reply_secret_missing", 500);
    if (
      !validOperationalApprovalBody(
        body.value,
        projection.target.kind === "self_test",
      )
    ) {
      return controlError("email_operational_request_invalid", 422);
    }
    const challengeValid = await verifyEmailApprovalChallenge({
      secret,
      proposalId: projection.proposalId,
      version: body.value.version,
      snapshotDigest: body.value.snapshotDigest,
      userId: authorized.authenticated.session.userId,
      challenge: body.value.challenge,
    });
    if (!challengeValid)
      return controlError("email_reply_challenge_stale", 409);
    const dispatched = await connector.value.stub.dispatchEmailOperational({
      identity: connector.value.identity,
      integrationAccountId: accountId.value,
      proposalId: projection.proposalId,
      approvedVersion: body.value.version,
      approvedSnapshotDigest: body.value.snapshotDigest,
      now,
    });
    if (!dispatched.ok) return operationalControlError(dispatched.error.code);
    switch (dispatched.value.kind) {
      case "sent":
        await syncOperationalCaseLifecycle({
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: {
            kind: "sent",
            providerMessageId: dispatched.value.providerMessageId,
            sentAt: now,
          },
          now,
        });
        responseBody = {
          ok: true,
          kind: "sent",
          provider_message_id: dispatched.value.providerMessageId,
          provider_thread_id: dispatched.value.providerThreadId,
          version: dispatched.value.version,
          self_test_ownership_confirmed: projection.target.kind === "self_test",
        };
        break;
      case "send_indeterminate":
        await syncOperationalCaseLifecycle({
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: {
            kind: "send_indeterminate",
            rfcMessageId: dispatched.value.rfcMessageId,
          },
          now,
        });
        responseBody = {
          ok: true,
          kind: "send_indeterminate",
          rfc_message_id: dispatched.value.rfcMessageId,
          self_test_ownership_confirmed: projection.target.kind === "self_test",
        };
        break;
      case "stale_approval":
        return controlError("email_operational_approval_stale", 409);
      case "expired":
        await syncOperationalCaseLifecycle({
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: {
            kind: "expired",
            expiredAt: now,
            disposal: { kind: "cleaned", deletedAt: now },
          },
          now,
        });
        return controlError("email_operational_expired", 410);
      case "proposal_missing":
        await syncOperationalCaseLifecycle({
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: { kind: "proposal_missing" },
          now,
        });
        return controlError("email_operational_proposal_missing", 410);
      case "target_changed":
        await syncOperationalCaseLifecycle({
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: {
            kind: "invalidated",
            reason: "target_changed",
            disposal: { kind: "cleaned", deletedAt: now },
          },
          now,
        });
        return controlError("email_operational_target_changed", 409);
    }
  }
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

function operationalProposalPreviewWire(preview: {
  readonly proposalId: string;
  readonly version: number;
  readonly caseId: string;
  readonly integrationAccountId: IntegrationAccountId;
  readonly target: unknown;
  readonly sender: string;
  readonly recipient: string;
  readonly recipientDisplayName: string | null;
  readonly subject: string;
  readonly body: string;
  readonly targetDigest: string;
  readonly snapshotDigest: string;
  readonly expiresAt: number;
}): Record<string, unknown> {
  return {
    proposal_id: preview.proposalId,
    version: preview.version,
    case_id: preview.caseId,
    integration_account_id: preview.integrationAccountId,
    target: preview.target,
    from: preview.sender,
    to: preview.recipient,
    recipient_display_name: preview.recipientDisplayName,
    subject: preview.subject,
    body: preview.body,
    target_digest: preview.targetDigest,
    snapshot_digest: preview.snapshotDigest,
    expires_at: preview.expiresAt,
  };
}

function validOperationalApprovalBody(
  body: JsonRecord,
  selfTest: boolean,
): body is JsonRecord & {
  readonly version: number;
  readonly snapshotDigest: string;
  readonly challenge: string;
} {
  return (
    hasExactKeys(
      body,
      selfTest
        ? [
            "version",
            "snapshotDigest",
            "challenge",
            "selfTestOwnershipConfirmed",
          ]
        : ["version", "snapshotDigest", "challenge"],
    ) &&
    (!selfTest || body.selfTestOwnershipConfirmed === true) &&
    isPositiveInteger(body.version) &&
    typeof body.snapshotDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(body.snapshotDigest) &&
    typeof body.challenge === "string" &&
    body.challenge.length > 0
  );
}

function validOperationalEditBody(body: JsonRecord): body is JsonRecord & {
  readonly subject: string;
  readonly body: string;
  readonly version?: number;
} {
  return (
    (hasExactKeys(body, ["subject", "body"]) ||
      (hasExactKeys(body, ["subject", "body", "version"]) &&
        isPositiveInteger(body.version))) &&
    typeof body.subject === "string" &&
    body.subject.trim().length > 0 &&
    body.subject.length <= 998 &&
    typeof body.body === "string" &&
    body.body.trim().length > 0 &&
    body.body.length <= 20_000
  );
}

function operationalControlError(code: string): Response {
  if (code.includes("not_found") || code.includes("missing")) {
    return controlError(code, 404);
  }
  if (
    code.includes("expired") ||
    code.includes("immutable") ||
    code.includes("stale") ||
    code.includes("changed") ||
    code.includes("conflict")
  ) {
    return controlError(code, 409);
  }
  return controlError(code, 502);
}
