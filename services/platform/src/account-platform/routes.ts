import type { Env } from "../env";
import { parseOrganisationId } from "../ids";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { accountObject, accountText } from "./types";
import {
  readPantryProvisionEnvelope,
  verifyPantryProvisionOwner,
} from "./provisioning-boundary";
import { provisionPantryAccount, readRetainedBinding } from "./provisioning";

export async function handleAccountPlatformRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/account-platform/")) return null;
  if (request.method !== "POST")
    return response(
      { kind: "rejected", error: { code: "method_not_allowed" } },
      405,
    );
  if (!(await authenticateProvisionProducer(request, env)))
    return response(
      { kind: "rejected", error: { code: "scope_forbidden" } },
      403,
    );
  try {
    const text = await request.text();
    if (text.length > 64_000)
      return response(
        { kind: "rejected", error: { code: "invalid_body" } },
        400,
      );
    const raw: unknown = JSON.parse(text);
    switch (path) {
      case "/account-platform/v1/provision": {
        const envelope = readPantryProvisionEnvelope(raw);
        if (!(await verifyPantryProvisionOwner(env, envelope)))
          return response(
            { kind: "rejected", error: { code: "scope_forbidden" } },
            403,
          );
        const result = await provisionPantryAccount(env, envelope);
        return response(
          result,
          result.kind === "accepted"
            ? 200
            : result.error.code === "unavailable"
              ? 503
              : 409,
        );
      }
      case "/account-platform/v1/status": {
        const body = accountObject(raw, ["version", "instanceId"]);
        if (body.version !== 1) throw new Error("Invalid status version");
        const retained = await readRetainedBinding(
          env.DB,
          accountText(body.instanceId),
        );
        if (
          retained === null ||
          retained.binding.nativeScope.deploymentId !==
            env.ACCOUNT_PLATFORM_DEPLOYMENT_ID
        )
          return response(
            { kind: "rejected", error: { code: "scope_forbidden" } },
            403,
          );
        const organisationId = parseOrganisationId(
          retained.binding.nativeScope.nativeOrganizationId,
        );
        if (!organisationId.ok)
          throw new Error("Invalid retained native tenant");
        const scope = await OrganisationExecutionScope.resolve(
          env,
          organisationId.value,
        );
        if (!scope.ok) return unavailable();
        const row = await scope.value.database
          .prepare(
            `SELECT lifecycle FROM organisation_onboarding WHERE organisation_id = ?`,
          )
          .bind(organisationId.value)
          .first<unknown>();
        const lifecycle = accountObject(row, ["lifecycle"]).lifecycle;
        if (
          lifecycle !== "configuring" &&
          lifecycle !== "activating" &&
          lifecycle !== "active" &&
          lifecycle !== "archived" &&
          lifecycle !== "purging" &&
          lifecycle !== "purged"
        )
          throw new Error("Invalid native lifecycle");
        return response({
          kind: "accepted",
          value: {
            version: 1,
            instanceId: retained.binding.instanceId,
            binding: retained.binding,
            accountState: retained.accountState,
            desiredRevision: retained.desiredRevision,
            operationId: retained.operationId,
            // The account platform knows four states; an ended purge reads as archived.
            nativeOperationalReadiness: {
              kind:
                lifecycle === "purging" || lifecycle === "purged"
                  ? "archived"
                  : lifecycle,
            },
          },
        });
      }
      default:
        return response(
          { kind: "rejected", error: { code: "operation_unsupported" } },
          404,
        );
    }
  } catch {
    return unavailable();
  }
}

async function authenticateProvisionProducer(
  request: Request,
  env: Env,
): Promise<boolean> {
  if (!env.ACCOUNT_PLATFORM_PROVISION_TOKEN) return false;
  const match = request.headers
    .get("Authorization")
    ?.match(/^Bearer ([^\s]+)$/);
  if (!match) return false;
  const supplied = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1])),
  );
  const expected = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(env.ACCOUNT_PLATFORM_PROVISION_TOKEN),
    ),
  );
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1)
    difference |= (supplied[i] ?? 0) ^ (expected[i] ?? 0);
  return difference === 0;
}
function response(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
function unavailable(): Response {
  return response({ kind: "rejected", error: { code: "unavailable" } }, 503);
}
