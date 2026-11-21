// Square for a Pantry commerce merchant runs in Commerce (Plan 80 step 4).
// Commerce exchanges the authorization code, keeps and refreshes the
// tokens, revokes them, reads locations and devices and pairs Terminals.
// Pantry keeps only a delegation record in its vault: the Commerce merchant
// that holds the connection, never a Square token.
import type {
  CommerceAdminClient,
  CommerceClientError,
  CommerceSquareConnectionV1,
} from "@purin-labs/commerce-client";
import { isRecord } from "@purin-labs/std";

import type { VaultSecret } from "../../credential-vault/domain";
import { resolveOrganisationCommerceSystem } from "../../data/organisation-commerce-system";
import type { Env } from "../../env";
import { newRequestId, type OrganisationId } from "../../ids";
import { traceWarn } from "../../observability";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { createCommerceClient } from "./client";

/** The organisation's Commerce merchant, reached with Pantry's app token. */
export type CommerceMerchant = Readonly<{
  merchantId: string;
  client: CommerceAdminClient;
}>;

export type SquareDelegation = Readonly<{
  merchantId: string;
  providerAccountId: string;
}>;

const SQUARE_DELEGATION_FORMAT = "commerce_square_connection_v1";

/** Square runs only for an organisation whose commerce system is Pantry's. */
export async function resolveCommerceMerchant(
  env: Env,
  scope: OrganisationExecutionScope,
  organisationId: OrganisationId,
): Promise<CommerceMerchant | null> {
  const system = await resolveOrganisationCommerceSystem({
    db: scope.database,
    organisationId,
  });
  if (!system.ok || system.value.kind !== "builtin_commerce") return null;
  const client = createCommerceClient(env, undefined, {
    kind: "organisation",
    organisationId: String(organisationId),
  });
  return client === null
    ? null
    : { merchantId: String(system.value.merchantId), client };
}

/** The vault record of a connection that Commerce holds. */
export function squareDelegationSecret(
  delegation: SquareDelegation,
): VaultSecret {
  return {
    kind: "opaque_profile",
    format: SQUARE_DELEGATION_FORMAT,
    value: JSON.stringify(delegation),
  };
}

export function readSquareDelegation(
  secret: VaultSecret,
): SquareDelegation | null {
  if (
    secret.kind !== "opaque_profile" ||
    secret.format !== SQUARE_DELEGATION_FORMAT
  )
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret.value);
  } catch {
    return null;
  }
  return isRecord(parsed) &&
    typeof parsed.merchantId === "string" &&
    typeof parsed.providerAccountId === "string"
    ? {
        merchantId: parsed.merchantId,
        providerAccountId: parsed.providerAccountId,
      }
    : null;
}

type SquareLinkOutcome =
  | Readonly<{ kind: "linked"; locations: number }>
  | Readonly<{ kind: "skipped"; reason: string }>;

/**
 * Lets each location of the connected account that takes card payments take
 * Pantry's Square payments. Never fails: the next provider check tries again.
 */
export async function linkSquarePaymentLocations(
  square: CommerceMerchant,
  organisationId: OrganisationId,
): Promise<SquareLinkOutcome> {
  try {
    const locations = await square.client.listSquareLocations(
      square.merchantId,
    );
    if (!locations.ok) {
      warn(organisationId, locations.error.kind);
      return { kind: "skipped", reason: "locations_unreadable" };
    }
    let linked = 0;
    for (const location of locations.value.locations) {
      if (!location.cardPayments) continue;
      const result = await square.client.linkSquareAccount(square.merchantId, {
        paymentProviderBindingId: squareBindingId(location.locationId),
        locationId: location.locationId,
      });
      if (result.ok) linked += 1;
      else warn(organisationId, result.error.kind);
    }
    return { kind: "linked", locations: linked };
  } catch {
    warn(organisationId, "exception");
    return { kind: "skipped", reason: "link_failed" };
  }
}

/** The connection, or why Commerce cannot show it. */
export async function readCommerceSquareConnection(
  square: CommerceMerchant,
): Promise<
  | Readonly<{ kind: "connected"; connection: CommerceSquareConnectionV1 }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unavailable"; error: CommerceClientError }>
> {
  const read = await square.client.readSquareConnection(square.merchantId);
  if (!read.ok) return { kind: "unavailable", error: read.error };
  return read.value === null
    ? { kind: "missing" }
    : { kind: "connected", connection: read.value };
}

/** The payment binding id of a Square location in Commerce. */
function squareBindingId(locationId: string): string {
  return `square_${locationId.replace(/[^A-Za-z0-9_-]/gu, "_")}`.slice(0, 128);
}

function warn(organisationId: OrganisationId, kind: string): void {
  traceWarn("commerce.square_link_failed", {
    requestId: newRequestId(),
    organisation_id: organisationId,
    kind,
  });
}
