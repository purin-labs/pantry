import type { CommerceAdminClient } from "@purin-labs/commerce-client";
import { createCommerceClient } from "../commerce/outbox-worker";
import {
  resolveOrganisationCommerceMerchantBinding,
  type CommerceMerchantBinding,
} from "../data/commerce-merchant-binding";
import type { Env } from "../env";
import type { IntegrationAccountId } from "../ids";
import type { AuthorizedOrganisationRequest } from "./authorization";
import { controlError } from "./http";
import { readOrganisationEnvironment } from "./organisation-runtime";

export type MerchantControlContext = Readonly<{
  merchantId: string;
  integrationAccountId: IntegrationAccountId;
  client: CommerceAdminClient;
}>;

/**
 * The Organisation's commerce merchant: 404 when the Organisation has no
 * environment, 503 when it has no merchant binding.
 */
export async function resolveMerchantBinding(
  authorized: AuthorizedOrganisationRequest,
): Promise<CommerceMerchantBinding | Response> {
  const environment = await readOrganisationEnvironment(
    authorized.executionScope.database,
    authorized.organisationId,
  );
  if (environment === null) return controlError("organisation_not_found", 404);
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    environment,
  });
  return binding.ok
    ? binding.value
    : controlError("underclerk_binding_missing", 503);
}

/** The organisation's merchant, reached as the member who asked. */
export async function resolveMerchantControlContext(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<MerchantControlContext | Response> {
  const binding = await resolveMerchantBinding(authorized);
  if (binding instanceof Response) return binding;
  const client = createCommerceClient(env, undefined, {
    kind: "organisation",
    organisationId: String(authorized.organisationId),
    actor: String(authorized.membership.personId),
  });
  if (client === null) return controlError("underclerk_unavailable", 503);
  return {
    merchantId: binding.merchantId,
    integrationAccountId: binding.integrationAccountId,
    client,
  };
}
