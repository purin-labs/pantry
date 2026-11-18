import { hasExactKeys } from "@seams/std";
import { isChatEffort, type ChatEffort } from "@seams/control-api";

import type { Env } from "../../env";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";
import { controlCausationId } from "../mutation";
import { resolveUser } from "../../data/control-plane";
import {
  hashPortalSubject,
  newControlMutationIdentity,
  parseControlMutationBoundary,
  prepareControlMutationReceipt,
  readControlMutationReplay,
  type ControlMutationReceiptScope,
} from "../../data/control-mutation";
import {
  prepareOrganisationSlackReasoningEffortWrite,
  readOrganisationInferenceSelection,
} from "../../data/organisation-inference-selection";

/**
 * `/v1/control/organisations/:id/inference/slack-reasoning-effort`: the level
 * of Slack answers. Every member may read it, because it decides how the
 * agent answers them. Only an owner or admin may change it, as with the
 * inference source. A new level applies to the next Slack turn, also in a
 * thread that is open.
 */
export async function handleOrganisationSlackReasoningEffort(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method === "GET") {
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      organisationIdRaw,
      "viewer",
      false,
    );
    if (!authorized.ok) return authorized.response;
    const selection = await readOrganisationInferenceSelection({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
    });
    return selection === null
      ? controlError("organisation_not_found", 404)
      : controlJson({ ok: true, effort: selection.slackReasoningEffort });
  }
  if (request.method !== "PUT") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("slack_reasoning_effort_invalid", 422);
  const effort = parseSlackReasoningEffortMutation(body.value);
  if (effort === undefined)
    return controlError("slack_reasoning_effort_invalid", 422);
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: false,
  });
  if (!boundary.ok || boundary.value.kind !== "unversioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const scope: ControlMutationReceiptScope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/inference/slack-reasoning-effort`,
    operation: "organisation.inference.slack_reasoning_effort",
  };
  const database = authorized.executionScope.database;
  const replay = await readControlMutationReplay({
    db: database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict")
    return controlError("idempotency_key_conflict", 409);
  if (replay.kind === "replay")
    return controlJson(
      replay.receipt.responseBody,
      replay.receipt.responseStatus,
    );
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const now = Date.now();
  const mutationIdentity = newControlMutationIdentity({
    portalSubjectHash: await hashPortalSubject(
      identity.issuer,
      identity.subject,
    ),
    causationId: controlCausationId(request),
    now,
  });
  const responseBody = {
    ok: true,
    effort,
    receipt: {
      receipt_id: mutationIdentity.receiptId,
      organisation_id: authorized.organisationId,
    },
  };
  const session = database.withSession("first-primary");
  await session.batch([
    prepareOrganisationSlackReasoningEffortWrite(session, {
      organisationId: authorized.organisationId,
      effort,
      selectedByUserId: identity.userId,
      now,
    }),
    prepareControlMutationReceipt(session, {
      scope,
      boundary: boundary.value,
      identity: mutationIdentity,
      responseStatus: 200,
      responseBody,
    }),
  ]);
  return controlJson(responseBody);
}

/** `{ effort: "low" | "medium" | "high" | null }`; undefined when invalid. */
function parseSlackReasoningEffortMutation(
  body: Readonly<Record<string, unknown>>,
): ChatEffort | null | undefined {
  if (!hasExactKeys(body, ["effort"])) return undefined;
  if (body.effort === null) return null;
  return isChatEffort(body.effort) ? body.effort : undefined;
}
