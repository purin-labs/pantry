import { pantryCommerceAccess } from "@purin-labs/area-commerce-contract/server/client";
import type {
  CommerceGraphQuery,
  CommerceSensitivity,
} from "@purin-labs/commerce-contracts";
import { CommerceEntityPlaneClient } from "@purin-labs/commerce-client";

import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { buildSavedSelectorCommerceReadAuthority } from "../entity-plane/authority";
import { createCommerceGraphReader } from "../entity-plane/selected-graph-reader";
import { CommerceEngineSource } from "../entity-plane/commerce-source";
import { resolveOrganisationCommerceSystem } from "@purin-labs/connections/data/organisation-commerce-system";
import { resolveOrganisationCommerceMerchantBinding } from "@purin-labs/connections/data/commerce-merchant-binding";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { AuthorizedOrganisationRequest } from "@purin-labs/control/worker/authorization";
import { readOrganisationEnvironment } from "@purin-labs/agent/control/organisation-runtime";
import type {
  ControlCommerceGraph,
  ControlCommerceGraphError,
} from "@purin-labs/area-commerce-contract/server/graph-reads";

/**
 * The commerce graph of one Organisation, as a person's control request reads
 * it. Each query still needs its own authority from
 * `commerceGraphControlAuthority`, which carries the person's sensitivity
 * ceiling.
 */
export async function openControlCommerceGraph(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<Result<ControlCommerceGraph, ControlCommerceGraphError>> {
  // The two reads need only the Organisation.
  const [commerceSystem, environment] = await Promise.all([
    resolveOrganisationCommerceSystem({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
    }),
    readOrganisationEnvironment(
      authorized.executionScope.database,
      authorized.organisationId,
    ),
  ]);
  if (!commerceSystem.ok) return failure(commerceSystem.error.code, 404);
  if (environment === null) return failure("organisation_not_found", 404);
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    environment,
  });
  if (!binding.ok) return failure("commerce_binding_missing", 503);
  if (
    commerceSystem.value.kind === "builtin_commerce" &&
    commerceSystem.value.merchantId !== binding.value.merchantId
  ) {
    return failure("commerce_binding_mismatch", 503);
  }
  if (
    env.COMMERCE_BASE_URL === undefined ||
    env.COMMERCE_SERVICE_TOKEN === undefined
  ) {
    return failure("commerce_unavailable", 503);
  }
  let client: CommerceEntityPlaneClient;
  try {
    client = new CommerceEntityPlaneClient({
      baseUrl: env.COMMERCE_BASE_URL,
      ...pantryCommerceAccess(
        env.COMMERCE_SERVICE_TOKEN,
        String(authorized.organisationId),
        env.COMMERCE.fetch.bind(env.COMMERCE),
        String(authorized.membership.personId),
      ),
    });
  } catch {
    return failure("commerce_unavailable", 503);
  }
  const commerceEngine = new CommerceEngineSource({
    organisationId: authorized.organisationId,
    merchantId: binding.value.merchantId,
    integrationAccountId: binding.value.integrationAccountId,
    client,
  });
  const reader = await createCommerceGraphReader({
    commerceSystem: commerceSystem.value,
    organisationId: authorized.organisationId,
    merchantId: binding.value.merchantId,
    commerce: commerceEngine,
    organisation: () =>
      requireActiveOrganisationActor({
        env,
        organisationId: authorized.organisationId,
        now: Date.now(),
      }),
  });
  return { ok: true, value: { reader, merchantId: binding.value.merchantId } };
}

/** The read authority of one graph query that a person's request asks. */
export function commerceGraphControlAuthority(
  input: Readonly<{
    organisationId: OrganisationId;
    merchantId: string;
    principalId: string;
    sensitivityCeiling: CommerceSensitivity;
    query: CommerceGraphQuery;
    now: number;
  }>,
) {
  return buildSavedSelectorCommerceReadAuthority({
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    principalId: input.principalId,
    sensitivityCeiling: input.sensitivityCeiling,
    expiresAt: new Date(input.now + 60_000).toISOString(),
    commandId: newRequestId(),
    selectorId: `control_${input.organisationId}_${input.now}`,
    selectorRevision: 1,
    query: input.query,
  });
}

/** The ceiling a control read of commerce data has for a person's role. */
export function controlCommerceSensitivityCeiling(
  authorized: AuthorizedOrganisationRequest,
): CommerceSensitivity {
  return authorized.membership.role === "viewer" ? "internal" : "restricted";
}

function failure(
  code: ControlCommerceGraphError["code"],
  status: ControlCommerceGraphError["status"],
): Result<never, ControlCommerceGraphError> {
  return { ok: false, error: { code, status } };
}
