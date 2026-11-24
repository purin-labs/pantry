import {
  configuredValue,
  exactScopeIsGranted,
  parseProviderOnlyStartContext,
  SHORT_PROVIDER_STATE_TTL_MS,
} from "@purin-labs/connections/provider-adapters/authorization";
import {
  type ProviderCleanupAdapter,
  type ProviderCleanupResult,
  type ProviderOnboardingAdapter,
  type SquareApplication,
} from "../contract/provider-adapter";
import type { DiscoveredProviderResource } from "@purin-labs/connections/data/provider-resource";
import type {
  SquareDelegation,
  CommerceMerchant,
} from "@purin-labs/area-commerce/server/contract/square-link";
import { createCommerceClient } from "@purin-labs/area-commerce/server/contract/client";

const MANUAL_INSTRUCTION = "revoke_square_access_in_square" as const;

/**
 * Plan 33C's exact first-release scopes. Orders, Catalog, Inventory,
 * Customers, Loyalty, and Workforce are deliberately absent: Pantry is the only
 * commerce authority, so the connection has no commercial-data scope.
 */
const SQUARE_SCOPES = [
  "DEVICE_CREDENTIAL_MANAGEMENT",
  // Device discovery and diagnostic readback. Without it ListDevices and
  // GetDevice are unauthorized, so a connection missing this scope must go
  // through the shared reconnect path rather than silently losing health.
  "DEVICES_READ",
  "MERCHANT_PROFILE_READ",
  "PAYMENTS_READ",
  "PAYMENTS_WRITE",
  // The money that Square sends to the seller's bank, for the Payouts page. A
  // connection made before this scope connects again to read it.
  "PAYOUTS_READ",
] as const;

const squareApplication = Symbol("SquareApplication");
declare module "../contract/provider-adapter" {
  interface SquareApplication {
    readonly [squareApplication]: true;
  }
}
export type { SquareApplication } from "../contract/provider-adapter";

type SquareConfiguration =
  | { readonly kind: "unconfigured" }
  | {
      readonly kind: "invalid";
      readonly setting:
        | "SQUARE_OAUTH_ENVIRONMENT"
        | "SQUARE_OAUTH_CLIENT_ID"
        | "SQUARE_OAUTH_CLIENT_SECRET";
    }
  | { readonly kind: "configured"; readonly application: SquareApplication };

export function readSquareConfiguration(
  env: Readonly<{
    SQUARE_OAUTH_ENVIRONMENT?: string;
    SQUARE_OAUTH_CLIENT_ID?: string;
    SQUARE_OAUTH_CLIENT_SECRET?: string;
  }>,
): SquareConfiguration {
  const clientId = configuredValue(env.SQUARE_OAUTH_CLIENT_ID);
  const clientSecret = configuredValue(env.SQUARE_OAUTH_CLIENT_SECRET);
  if (clientId === null && clientSecret === null)
    return { kind: "unconfigured" };
  if (clientId === null)
    return { kind: "invalid", setting: "SQUARE_OAUTH_CLIENT_ID" };
  if (clientSecret === null)
    return { kind: "invalid", setting: "SQUARE_OAUTH_CLIENT_SECRET" };
  const environment = env.SQUARE_OAUTH_ENVIRONMENT;
  if (environment !== "development" && environment !== "production") {
    return { kind: "invalid", setting: "SQUARE_OAUTH_ENVIRONMENT" };
  }
  if (
    (clientId.startsWith("sandbox-") && environment !== "development") ||
    (clientId.startsWith("sq0idp-") && environment !== "production")
  ) {
    return { kind: "invalid", setting: "SQUARE_OAUTH_CLIENT_ID" };
  }
  return {
    kind: "configured",
    application: {
      [squareApplication]: true,
      environment,
      clientId,
      clientSecret,
    },
  };
}

type SquareProtocolError =
  | { readonly code: "provider_configuration_missing" }
  | { readonly code: "provider_oauth_response_invalid" }
  | { readonly code: "provider_account_ineligible" }
  | {
      readonly code: "provider_oauth_exchange_failed";
      readonly status: number;
    };

export const squareCleanupAdapter: ProviderCleanupAdapter<"square"> = {
  provider: "square",
  manualActionInstruction: MANUAL_INSTRUCTION,
  remove: revokeSquareConnection,
};

export const squareOnboardingAdapter: ProviderOnboardingAdapter<"square"> = {
  provider: "square",
  requiredScopes: SQUARE_SCOPES,
  stateTtlMs: SHORT_PROVIDER_STATE_TTL_MS,
  parseStartContext: parseSquareStartContext,
  configurationIsValid: squareConfigurationIsValid,
  authorizationSecret: squareAuthorizationSecret,
  authorizationUrl: squareAuthorizationUrl,
  scopeIsGranted: exactScopeIsGranted,
};

function parseSquareStartContext(
  raw: unknown,
): { readonly provider: "square" } | null {
  return parseProviderOnlyStartContext("square", raw);
}

function squareConfigurationIsValid(
  env: Parameters<typeof squareAuthorizationSecret>[0],
): boolean {
  return readSquareConfiguration(env).kind === "configured";
}

function squareAuthorizationSecret(
  env: Parameters<
    ProviderOnboardingAdapter<"square">["configurationIsValid"]
  >[0],
): string | null {
  const configuration = readSquareConfiguration(env);
  return configuration.kind === "configured"
    ? configuration.application.clientSecret
    : null;
}

async function squareAuthorizationUrl(
  input: Parameters<ProviderOnboardingAdapter<"square">["authorizationUrl"]>[0],
): Promise<string> {
  const url = new URL(
    `${squareConnectOrigin(input.configuration.environment)}/oauth2/authorize`,
  );
  url.searchParams.set("client_id", input.configuration.clientId);
  url.searchParams.set("scope", SQUARE_SCOPES.join(" "));
  if (input.configuration.environment === "production") {
    url.searchParams.set("session", "false");
  }
  url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * Square Sandbox and production are separate seller populations with separate
 * credentials, so the environment selects the origin rather than a flag on one
 * shared host.
 */
function squareConnectOrigin(
  environment: "development" | "production",
): string {
  return environment === "development"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

type SquareLocationSummary = {
  readonly providerLocationId: string;
  readonly displayName: string;
  readonly country: string;
  readonly currency: string;
  /** Whether Square reports this location as able to take payments. */
  readonly acceptsPayments: boolean;
};

type SquareDeviceStatus = "available" | "unavailable" | "unknown";

type SquareDeviceReadback = {
  readonly providerDeviceId: string;
  readonly status: SquareDeviceStatus;
  readonly providerLocationId: string | null;
  readonly observedAt: string;
};

/**
 * The locations and devices of the connected account, as Commerce reads
 * them with the connection it holds (Plan 80 step 4).
 */
export async function discoverSquareTerminalResources(
  input: Readonly<{
    square: CommerceMerchant;
    providerAccountId: string;
    observedAt: string;
  }>,
): Promise<
  | { readonly ok: true; readonly value: readonly DiscoveredProviderResource[] }
  | { readonly ok: false; readonly error: SquareProtocolError }
> {
  const [locations, devices] = await Promise.all([
    input.square.client.listSquareLocations(input.square.merchantId),
    input.square.client.listSquareDevices(input.square.merchantId),
  ]);
  if (!locations.ok || !devices.ok)
    return {
      ok: false,
      error: { code: "provider_oauth_exchange_failed", status: 0 },
    };
  return {
    ok: true,
    value: [
      ...locations.value.locations.map((location) =>
        squareLocationResource(input.providerAccountId, {
          providerLocationId: location.locationId,
          displayName: location.name,
          country: location.country,
          currency: location.currency,
          acceptsPayments: location.cardPayments,
        }),
      ),
      ...devices.value.devices.map((device) =>
        squareDeviceResource(input.providerAccountId, {
          providerDeviceId: device.deviceId,
          status: squareDeviceStatus(device.status),
          providerLocationId: device.locationId,
          observedAt: input.observedAt,
        }),
      ),
    ],
  };
}

function squareLocationResource(
  providerAccountId: string,
  location: SquareLocationSummary,
): DiscoveredProviderResource {
  return {
    canonicalResourceId: location.providerLocationId,
    providerResourceId: location.providerLocationId,
    providerAccountId,
    displayLabel: location.displayName,
    accessState: location.acceptsPayments ? "accessible" : "inaccessible",
    providerRevision: [
      "square-location",
      location.providerLocationId,
      location.country,
      location.currency,
      location.acceptsPayments ? "payments-enabled" : "payments-disabled",
    ].join(":"),
    resourceKind: "payment_location",
  };
}

function squareDeviceResource(
  providerAccountId: string,
  device: SquareDeviceReadback,
): DiscoveredProviderResource {
  return {
    canonicalResourceId: device.providerDeviceId,
    providerResourceId: device.providerDeviceId,
    providerAccountId,
    displayLabel: `Square device ${device.providerDeviceId}`,
    accessState: "accessible",
    providerRevision: [
      "square-device",
      device.providerDeviceId,
      device.providerLocationId ?? "unassigned",
      device.status,
    ].join(":"),
    resourceKind: "terminal_device",
  };
}

function squareDeviceStatus(raw: unknown): SquareDeviceStatus {
  // Anything Square does not report as a state we recognize stays unknown.
  // Guessing "unavailable" would read as evidence a terminal cannot take money.
  switch (raw) {
    case "AVAILABLE":
      return "available";
    case "NEEDS_ATTENTION":
    case "OFFLINE":
      return "unavailable";
    default:
      return "unknown";
  }
}

async function revokeSquareConnection(
  input: Parameters<ProviderCleanupAdapter<"square">["remove"]>[0],
): Promise<ProviderCleanupResult> {
  return input.credentials.squareDelegation === null
    ? permanentFailure("provider_cleanup_credential_missing")
    : disconnectCommerceSquare(input, input.credentials.squareDelegation);
}

/** Commerce revokes the tokens at Square and forgets the connection. */
async function disconnectCommerceSquare(
  input: Parameters<ProviderCleanupAdapter<"square">["remove"]>[0],
  delegation: SquareDelegation,
): Promise<ProviderCleanupResult> {
  const commerceEngine = input.env.COMMERCE;
  const client =
    commerceEngine === undefined
      ? null
      : createCommerceClient(
          { ...input.env, COMMERCE: commerceEngine },
          undefined,
          {
            kind: "organisation",
            organisationId: String(input.cleanup.organisationId),
          },
        );
  if (client === null)
    return permanentFailure("provider_cleanup_configuration_missing");
  const disconnected = await client.disconnectSquare(delegation.merchantId);
  if (disconnected.ok) return { kind: "removed" };
  if (disconnected.error.kind === "http" && disconnected.error.status === 404)
    return { kind: "removed" };
  return disconnected.error.kind === "http" &&
    disconnected.error.status === 409
    ? {
        kind: "permanent_failure",
        reason: "provider_cleanup_provider_rejected",
        instruction: MANUAL_INSTRUCTION,
      }
    : {
        kind: "retryable_failure",
        reason: "provider_cleanup_http_unavailable",
      };
}

function permanentFailure(
  reason:
    | "provider_cleanup_configuration_missing"
    | "provider_cleanup_credential_missing"
    | "provider_cleanup_response_invalid",
): ProviderCleanupResult {
  return { kind: "permanent_failure", reason, instruction: MANUAL_INSTRUCTION };
}
