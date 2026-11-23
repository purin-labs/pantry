import { parseRunFindings } from "@purin-labs/bakery-workflow/findings";
import { isRecord } from "@purin-labs/std";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { listOpenWorkflowProposals } from "../../bakery/workflow-proposals";
import {
  MAX_WORKFLOW_DOCUMENT_BYTES,
  applyWorkflowRevision,
  readCurrentWorkflow,
  readWorkflowDocument,
  readWorkflowFindings,
  signalBakeryWorkflowApplied,
  writeWorkflowFindings,
} from "../../bakery/workflow-revisions";
import { organisationServices } from "@purin-labs/area-organisation/server/contract/organisation-services";
import type { Env } from "@purin-labs/kernel/env";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readBoundedJsonRecord,
} from "@purin-labs/control/worker/http";
import {
  type BakeryWorkflowRoute,
  authorizeBakeryWorkflowSocket,
} from "../admission/bakery-workflows";

export async function handleBakeryWorkflowRoute(
  request: Request,
  env: Env,
  route: BakeryWorkflowRoute,
): Promise<Response> {
  switch (route.transport) {
    case "socket": {
      const authorized = await authorizeBakeryWorkflowSocket(
        request,
        env,
        route,
      );
      if (!authorized.ok) return authorized.response;
      try {
        const organisation = await requireActiveOrganisationActor({
          env,
          organisationId: authorized.organisationId,
          now: Date.now(),
        });
        return organisation.fetch(request);
      } catch {
        return controlError("bakery_workflow_unavailable", 503);
      }
    }
    case "current":
      return readCurrent(request, env, route);
    case "apply":
      return apply(request, env, route);
    case "findings":
      return recordFindings(request, env, route);
    default:
      return route.transport.action === "read"
        ? readProposal(request, env, route, route.transport.proposal)
        : decideProposal(
            request,
            env,
            route,
            route.transport.proposal,
            route.transport.action,
          );
  }
}

/** A page sends the findings of a run on the applied revision, for the agent to read. */
async function recordFindings(
  request: Request,
  env: Env,
  route: BakeryWorkflowRoute,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "operator",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readBoundedJsonRecord(request, 64 * 1024);
  const findings = parseRunFindings(body?.findings);
  if (body === null || findings === null || typeof body.digest !== "string")
    return controlError("bakery_workflow_invalid", 422);
  try {
    const current = await readCurrentWorkflow(
      env,
      authorized.executionScope.database,
      authorized.organisationId,
      route.workflowId,
    );
    if (current?.receipt.digest !== body.digest)
      return controlError("bakery_workflow_stale", 409);
    await writeWorkflowFindings(
      env,
      authorized.organisationId,
      route.workflowId,
      { digest: body.digest, ranAt: Date.now(), findings },
    );
    return controlJson({ recorded: findings.length });
  } catch {
    return controlError("bakery_workflow_unavailable", 503);
  }
}

async function readProposal(
  request: Request,
  env: Env,
  route: BakeryWorkflowRoute,
  draftId: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  try {
    const stored = await organisationServices
      .use()
      .readOperatorDraft(
        authorized.executionScope.database,
        authorized.organisationId,
        draftId,
      );
    // Only the person who asked reads it, and for another person it does not exist.
    if (
      stored === null ||
      stored.command.family !== "workflow_change" ||
      stored.command.change.workflowId !== route.workflowId ||
      stored.actorUserId !== authorized.authenticated.session.userId
    )
      return controlError("bakery_workflow_not_found", 404);
    const document = await readWorkflowDocument(
      env,
      authorized.organisationId,
      stored.command.change.proposedDigest,
    );
    if (document === null)
      return controlError("bakery_workflow_not_found", 404);
    return controlJson({
      proposal: {
        draftId: stored.draftId,
        state: stored.state,
        expiresAt: stored.expiresAt,
        ...stored.command.change,
      },
      document,
    });
  } catch {
    return controlError("bakery_workflow_unavailable", 503);
  }
}

/** Approve binds the digests that the proposal holds. A repeat returns the first result. */
async function decideProposal(
  request: Request,
  env: Env,
  route: BakeryWorkflowRoute,
  draftId: string,
  action: "approve" | "decline",
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const db = authorized.executionScope.database;
  const organisationId = authorized.organisationId;
  try {
    const stored = await organisationServices
      .use()
      .readOperatorDraft(db, organisationId, draftId);
    const userId = authorized.authenticated.session.userId;
    if (
      stored === null ||
      stored.command.family !== "workflow_change" ||
      stored.command.change.workflowId !== route.workflowId ||
      stored.actorUserId !== userId
    )
      return controlError("bakery_workflow_not_found", 404);
    const now = Date.now();
    if (action === "decline") {
      const cancelled = await organisationServices
        .use()
        .cancelOperatorConfigurationDraft({
          db,
          organisationId,
          draftId,
          actorUserId: userId,
          now,
        });
      return cancelled.ok
        ? controlJson({ declined: true })
        : controlError("bakery_workflow_proposal_closed", 409);
    }
    const confirmed = await organisationServices
      .use()
      .confirmOperatorConfigurationDraft({
        db,
        env,
        organisationId,
        draftId,
        actorUserId: userId,
        actorRole: authorized.membership.role,
        controlSessionId: authorized.authenticated.session.controlSessionId,
        previewCode: organisationServices
          .use()
          .previewCode(stored.commandDigest),
        now,
      });
    if (!confirmed.ok)
      switch (confirmed.error.code) {
        case "workflow_revision_conflict":
          return controlError("bakery_workflow_stale", 409);
        case "workflow_human_intervention":
          return controlError("bakery_workflow_human_intervention", 409);
        case "operator_draft_not_pending":
        case "operator_draft_expired":
          return controlError("bakery_workflow_proposal_closed", 409);
        default:
          return controlError(confirmed.error.code, 409);
      }
    const current = await readCurrentWorkflow(
      env,
      db,
      organisationId,
      route.workflowId,
    );
    if (current === null) return controlError("bakery_workflow_not_found", 404);
    return controlJson({ receipt: current.receipt });
  } catch {
    return controlError("bakery_workflow_unavailable", 503);
  }
}

async function readCurrent(
  request: Request,
  env: Env,
  route: BakeryWorkflowRoute,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  try {
    const current = await readCurrentWorkflow(
      env,
      authorized.executionScope.database,
      authorized.organisationId,
      route.workflowId,
    );
    if (current === null) return controlJson({ current, proposals: [] });
    return controlJson({
      current,
      // The revision before an approved proposal, so its badges stay until the next one.
      replaced:
        current.receipt.proposalId === null ||
        current.receipt.baseDigest === null
          ? null
          : await readWorkflowDocument(
              env,
              authorized.organisationId,
              current.receipt.baseDigest,
            ),
      findings: await readWorkflowFindings(
        env,
        authorized.organisationId,
        route.workflowId,
        current.receipt.digest,
      ),
      proposals: await listOpenWorkflowProposals(
        authorized.executionScope.database,
        authorized.organisationId,
        route.workflowId,
        authorized.authenticated.session.userId,
        Date.now(),
      ),
    });
  } catch {
    return controlError("bakery_workflow_unavailable", 503);
  }
}

async function apply(
  request: Request,
  env: Env,
  route: BakeryWorkflowRoute,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readBoundedJsonRecord(
    request,
    MAX_WORKFLOW_DOCUMENT_BYTES + 256,
  );
  if (
    body === null ||
    !isRecord(body.document) ||
    (body.baseDigest !== null && typeof body.baseDigest !== "string")
  )
    return controlError("bakery_workflow_invalid", 422);
  try {
    const outcome = await applyWorkflowRevision(
      env,
      authorized.executionScope.database,
      authorized.organisationId,
      route.workflowId,
      authorized.authenticated.session.userId,
      body.document,
      body.baseDigest,
    );
    switch (outcome.kind) {
      case "applied":
        await signalBakeryWorkflowApplied(
          env,
          authorized.organisationId,
          route.workflowId,
        );
        return controlJson({ receipt: outcome.receipt });
      case "stale":
        return controlJson(
          {
            error: "bakery_workflow_stale",
            currentDigest: outcome.currentDigest,
          },
          409,
        );
      case "invalid":
        return controlJson(
          { error: "bakery_workflow_invalid", message: outcome.message },
          422,
        );
      case "refused":
        return controlJson(
          { error: "bakery_workflow_refused", problems: outcome.problems },
          422,
        );
    }
  } catch {
    return controlError("bakery_workflow_unavailable", 503);
  }
}
