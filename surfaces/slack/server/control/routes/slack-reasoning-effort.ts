import { hasExactKeys } from "@purin-labs/std";
import { isChatEffort, type ChatEffort } from "@purin-labs/control-api";

import type { Env } from "@purin-labs/kernel/env";
import {
  admitUserMutation,
  controlMutationIdentity,
} from "@purin-labs/control/worker/admission/control-mutation";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import { organisationPath } from "@purin-labs/control/worker/path-match";
import {
  controlError,
  controlJson,
  readJsonRecord,
} from "@purin-labs/control/worker/http";
import { prepareControlMutationReceipt } from "@purin-labs/tenancy/data/control-mutation";
import {
  prepareOrganisationSlackReasoningEffortWrite,
  readOrganisationInferenceSelection,
} from "@purin-labs/agent/data/organisation-inference-selection";

/** The route of the level of Slack answers of one Organisation. */
export type SlackReasoningEffortRoute = Readonly<{ organisationIdRaw: string }>;

export function matchSlackReasoningEffortRoute(
  pathname: string,
): SlackReasoningEffortRoute | null {
  const organisationIdRaw = organisationPath(
    pathname,
    "inference/slack-reasoning-effort",
  );
  return organisationIdRaw === null ? null : { organisationIdRaw };
}

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
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "after_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/inference/slack-reasoning-effort`,
    operation: "organisation.inference.slack_reasoning_effort",
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const now = Date.now();
  const mutationIdentity = await controlMutationIdentity(
    request,
    identity,
    now,
  );
  const responseBody = {
    ok: true,
    effort,
    receipt: {
      receipt_id: mutationIdentity.receiptId,
      organisation_id: authorized.organisationId,
    },
  };
  const session =
    authorized.executionScope.database.withSession("first-primary");
  await session.batch([
    prepareOrganisationSlackReasoningEffortWrite(session, {
      organisationId: authorized.organisationId,
      effort,
      selectedByUserId: identity.userId,
      now,
    }),
    prepareControlMutationReceipt(session, {
      scope,
      boundary,
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
