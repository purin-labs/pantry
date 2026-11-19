import { readAccountOnboardingRequest } from "@purin-labs/control-api";
import type { Env } from "../env";
import {
  authenticateControlMutation,
  authenticateControlRead,
} from "../control/authorization";
import {
  controlError,
  controlJson,
  readBoundedJsonRecord,
} from "../control/http";
import { resolveUser } from "../data/control-plane";
import { parseOrganisationId } from "../ids";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { createAccountPlatformClient } from "./client";
import { resolveLinkedPantryAccountUser } from "./identity";

export async function handlePantryOnboarding(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  const authenticated =
    request.method === "POST"
      ? await authenticateControlMutation(request, env)
      : await authenticateControlRead(request, env);
  if (!authenticated.ok) return authenticated.response;
  const session = authenticated.value.session;
  const user = await resolveUser({ db: env.DB, userId: session.userId });
  if (!user) return controlError("session_invalid", 401);
  const linked = await resolveLinkedPantryAccountUser(env, session.userId);
  if (!linked.ok) return controlError("account_sign_in_required", 401);
  if (
    linked.value.subject !== user.subject ||
    linked.value.issuer !== user.issuer
  )
    return controlError("scope_forbidden", 403);
  const client = createAccountPlatformClient(env);
  if (!client.ok) return controlError(client.error.code, 503);
  if (request.method === "GET") {
    const options = await client.value.onboardingOptions(user, session);
    return options.ok
      ? controlJson({ ok: true, value: options.value })
      : controlError(options.error.code, 503);
  }
  let input;
  try {
    input = readAccountOnboardingRequest(
      await readBoundedJsonRecord(request, 4096),
    );
  } catch {
    return controlError("onboarding_request_invalid", 400);
  }
  const result = await client.value.startOnboarding(user, session, input);
  if (!result.ok) {
    if (result.error.code === "authority_unavailable")
      return controlError(result.error.code, 503);
    return controlError("account_setup_blocked", 403);
  }
  if (result.value.kind === "ready") {
    const opens = await organisationOpensForUser(
      env,
      result.value.nativeOrganizationId,
      user.userId,
    );
    if (opens === "unavailable")
      return controlError("authority_unavailable", 503);
    if (opens === "refused") return controlError("account_setup_blocked", 403);
  }
  return controlJson({ ok: true, value: result.value });
}

/**
 * Whether the person can open the organisation that the account platform
 * names as ready. The account platform keeps a project's Pantry instance after
 * Pantry deletes the organisation, so its answer can name a deleted
 * organisation; setup then refuses that project instead of opening nothing.
 */
async function organisationOpensForUser(
  env: Env,
  nativeOrganizationId: string,
  userId: string,
): Promise<"opens" | "refused" | "unavailable"> {
  const organisationId = parseOrganisationId(nativeOrganizationId);
  if (!organisationId.ok) return "refused";
  try {
    const organisation = await env.DB.prepare(
      "SELECT status FROM organisation WHERE organisation_id = ?",
    )
      .bind(organisationId.value)
      .first<{ status: unknown }>();
    if (organisation?.status !== "active") return "refused";
    const scope = await OrganisationExecutionScope.resolve(
      env,
      organisationId.value,
    );
    if (!scope.ok) return "unavailable";
    const role = await scope.value.database
      .prepare(
        "SELECT 1 AS present FROM service_role_grant WHERE organisation_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
      )
      .bind(organisationId.value, userId)
      .first();
    return role === null ? "refused" : "opens";
  } catch {
    return "unavailable";
  }
}
