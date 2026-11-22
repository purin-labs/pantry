import type { ControlRole } from "@purin-labs/tenancy/data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "@purin-labs/control/worker/authorization";
import { controlError } from "@purin-labs/control/worker/http";

/**
 * The method, the authority and the account of a request about one
 * integration account. Every method but GET is a mutation.
 */
export async function authorizeAccountRequest(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
  method: "GET" | "POST" | "DELETE",
  role: ControlRole,
): Promise<
  | Readonly<{
      authorized: AuthorizedOrganisationRequest;
      integrationAccountId: IntegrationAccountId;
    }>
  | Response
> {
  if (request.method !== method) {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    role,
    method !== "GET",
  );
  if (!authorized.ok) return authorized.response;
  const integrationAccountId = parseIntegrationAccountId(
    integrationAccountIdRaw,
  );
  if (!integrationAccountId.ok) {
    return controlError("integration_account_not_found", 404);
  }
  return { authorized, integrationAccountId: integrationAccountId.value };
}

/**
 * The account that takes over as the provider's default, or null for none;
 * undefined when the body names one that is not an account id.
 */
export function parseReplacementAccountId(
  raw: unknown,
): IntegrationAccountId | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const parsed = parseIntegrationAccountId(raw);
  return parsed.ok ? parsed.value : undefined;
}
