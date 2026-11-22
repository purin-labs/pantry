import { hasExactKeys } from "@purin-labs/std";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  completeClaudeAuthorization,
  disconnectClaude,
  readClaudeAuthorization,
  readClaudeConnection,
  startClaudeAuthorization,
} from "../../models/claude-connection";
import { parseClaudeAuthorizationCode } from "../../models/claude-oauth";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "../http";
import { readOnboardingRow } from "@purin-labs/tenancy/data/organisation-onboarding-row";

export type ClaudeConnectionRoute = Readonly<{
  kind: "claudeConnection";
  organisationId: OrganisationId;
}>;

export function matchClaudeConnectionRoute(
  pathname: string,
): ClaudeConnectionRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/inference\/claude$/.exec(pathname);
  if (match === null) return null;
  try {
    const id = parseOrganisationId(decodeURIComponent(match[1] ?? ""));
    return id.ok
      ? { kind: "claudeConnection", organisationId: id.value }
      : null;
  } catch {
    return null;
  }
}

export async function handleClaudeConnectionRoute(
  request: Request,
  env: Env,
  route: ClaudeConnectionRoute,
): Promise<Response> {
  if (
    request.method !== "GET" &&
    request.method !== "POST" &&
    request.method !== "DELETE"
  )
    return controlError("method_not_allowed", 405);
  if (request.headers.has("authorization"))
    return controlError("not_found", 404);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    request.method === "GET" ? "viewer" : "admin",
    request.method !== "GET",
  );
  if (!authorized.ok) return authorized.response;
  const context = { scope: authorized.executionScope, keys: env };
  try {
    if (request.method === "GET")
      return controlJson({
        ok: true,
        connection: await readClaudeConnection(context),
        authorization: await readClaudeAuthorization(
          context,
          authorized.authenticated.session.userId,
        ),
      });
    const organisation = await readOnboardingRow(
      context.scope.database,
      context.scope.organisationId,
    );
    if (
      organisation === null ||
      organisation.lifecycle === "activating" ||
      organisation.lifecycle === "suspended" ||
      organisation.lifecycle === "archived" ||
      organisation.lifecycle === "purging" ||
      organisation.lifecycle === "purged"
    )
      return controlError("organisation_lifecycle_conflict", 409);
    if (request.method === "DELETE")
      return controlJson({
        ok: true,
        connection: await disconnectClaude(context),
      });
    const body = await readBoundedJsonRecord(request, 8192);
    if (body === null) return controlError("claude_request_invalid", 422);
    if (body.kind === "start" && hasExactKeys(body, ["kind"])) {
      const result = await startClaudeAuthorization(
        context,
        authorized.authenticated.session.userId,
      );
      return result.ok
        ? controlJson({ ok: true, authorization: result.value })
        : controlError(result.error.code, 409);
    }
    if (
      body.kind !== "complete" ||
      !hasExactKeys(body, ["kind", "attemptId", "code"]) ||
      typeof body.attemptId !== "string"
    )
      return controlError("claude_request_invalid", 422);
    const code = parseClaudeAuthorizationCode(body.code);
    if (!code.ok) return controlError(code.error.code, 422);
    const result = await completeClaudeAuthorization(context, {
      userId: authorized.authenticated.session.userId,
      attemptId: body.attemptId,
      code: code.value,
    });
    return result.ok
      ? controlJson({ ok: true, connection: result.value })
      : controlError(result.error.code, 409);
  } catch {
    return controlError("claude_connection_unavailable", 503);
  }
}
