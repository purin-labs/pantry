import { pantryCommerceAccess } from "../commerce/app-access";
import type { CommerceGraphQuery, CommerceSensitivity } from "@seams/contracts";
import { CommerceEntityPlaneClient } from "@seams/commerce-client";

import { requireActiveOrganisationActor } from "../actors/actor-router";
import { buildSavedSelectorCommerceReadAuthority } from "../commerce/entity-plane/authority";
import { BlotterSource } from "../commerce/entity-plane/blotter-source";
import { CommerceGraphReader } from "../commerce/entity-plane/graph-reader";
import { CommerceEngineSource } from "../commerce/entity-plane/commerce-source";
import {
  resolveOrganisationCommerceSystem,
  type CommerceSystemError,
} from "../data/organisation-commerce-system";
import { resolveOrganisationCommerceMerchantBinding } from "../data/commerce-merchant-binding";
import type { Env } from "../env";
import { newRequestId, type OrganisationId } from "../ids";
import type { Result } from "../result";
import type { AuthorizedOrganisationRequest } from "./authorization";
import { readOrganisationEnvironment } from "./organisation-runtime";

type ControlCommerceGraph = Readonly<{
  reader: CommerceGraphReader;
  merchantId: string;
}>;

type ControlCommerceGraphError = Readonly<{
  code:
    | CommerceSystemError["code"]
    | "organisation_not_found"
    | "underclerk_binding_missing"
    | "underclerk_binding_mismatch"
    | "underclerk_unavailable";
  status: 404 | 503;
}>;

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
  if (!binding.ok) return failure("underclerk_binding_missing", 503);
  if (
    commerceSystem.value.kind === "satyr_commerce" &&
    commerceSystem.value.merchantId !== binding.value.merchantId
  ) {
    return failure("underclerk_binding_mismatch", 503);
  }
  if (
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  ) {
    return failure("underclerk_unavailable", 503);
  }
  let client: CommerceEntityPlaneClient;
  try {
    client = new CommerceEntityPlaneClient({
      baseUrl: env.UNDERCLERK_BASE_URL,
      ...pantryCommerceAccess(
        env.UNDERCLERK_SERVICE_TOKEN,
        String(authorized.organisationId),
        env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
        String(authorized.membership.personId),
      ),
    });
  } catch {
    return failure("underclerk_unavailable", 503);
  }
  const commerceEngine = new CommerceEngineSource({
    organisationId: authorized.organisationId,
    merchantId: binding.value.merchantId,
    integrationAccountId: binding.value.integrationAccountId,
    client,
  });
  const reader =
    commerceSystem.value.kind === "shopify"
      ? new CommerceGraphReader({
          organisationId: authorized.organisationId,
          merchantId: binding.value.merchantId,
          commerceSystem: commerceSystem.value,
          underclerk: commerceEngine,
          blotter: new BlotterSource({
            organisationId: authorized.organisationId,
            merchantId: binding.value.merchantId,
            integrationAccountId: commerceSystem.value.integrationAccountId,
            organisation: await requireActiveOrganisationActor({
              env,
              organisationId: authorized.organisationId,
              now: Date.now(),
            }),
          }),
        })
      : new CommerceGraphReader({
          organisationId: authorized.organisationId,
          merchantId: binding.value.merchantId,
          commerceSystem: commerceSystem.value,
          underclerk: commerceEngine,
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
