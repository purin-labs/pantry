import type { SquareDelegation } from "@purin-labs/area-commerce/server/contract/square-link";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type {
  VaultHandle,
  VaultSecret,
  VaultOAuthTokens,
} from "@purin-labs/authority/credential-vault/index";
import type { Env } from "@purin-labs/kernel/env";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { ActiveIntegrationProvider } from "@purin-labs/connections/data/integration-provider-directory";
import type {
  ProvisioningProviderConnectionAttempt,
  ProviderManifestEvidence,
} from "@purin-labs/connections/data/provider-attempt";
import type {
  CompleteProviderInput,
  ProviderCompletion,
  ProviderOAuthAttempt,
  ProviderOnboardingError,
} from "./provider-lifecycle";
import type { Result } from "@purin-labs/kernel/result";
import type { ActiveCapabilityId } from "@purin-labs/authority/authorization/capability-catalogue";
import type { IntegrationDiscoveryDataClass } from "@purin-labs/contracts";
import type { GmailAuthorizationProduct } from "@purin-labs/connections/mail/gmail-authorization";
import type { Variant } from "@purin-labs/type-utils";
import type { SquareApplication } from "../provider-adapters/square";
import type {
  MailIntegrationProvider,
  MailProviderAdapter,
} from "@purin-labs/connections/mail/provider-adapter";

type ProviderCleanupBase<P extends ActiveIntegrationProvider> = {
  readonly cleanupId: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: P;
  readonly environment: "development" | "production";
  readonly providerAccountId: string;
  readonly providerConnectionId: string;
  readonly credentialHandles: readonly string[];
};

export type ProviderCleanupByProvider = {
  readonly airtable: ProviderCleanupBase<"airtable">;
  readonly dropbox: ProviderCleanupBase<"dropbox">;
  readonly gmail: ProviderCleanupBase<"gmail">;
  readonly google_drive: ProviderCleanupBase<"google_drive">;
  readonly notion: ProviderCleanupBase<"notion">;
  readonly shopify: ProviderCleanupBase<"shopify">;
  readonly slack: ProviderCleanupBase<"slack">;
  readonly square: ProviderCleanupBase<"square">;
  readonly stripe: ProviderCleanupBase<"stripe">;
  readonly whatsapp: ProviderCleanupBase<"whatsapp"> & {
    readonly wabaId: string;
    readonly removeApplicationSubscription: boolean;
  };
};

export type ProviderCleanup =
  ProviderCleanupByProvider[ActiveIntegrationProvider];

type BearerSecret = Variant<VaultSecret, "bearer">;
type ExpiringBearerSecret = Variant<VaultSecret, "expiring_bearer">;

export type ProviderCleanupCredentials = {
  readonly bearer: BearerSecret | null;
  readonly expiringBearer: ExpiringBearerSecret | null;
  readonly oauthTokens: VaultOAuthTokens | null;
  /** A Square connection that Commerce holds (Plan 80 step 4). */
  readonly squareDelegation: SquareDelegation | null;
};

export type ProviderAdapterBindings = Pick<
  Env,
  | "PANTRY_DEPLOYMENT_PROFILE"
  | "SLACK_APP_ID"
  | "AIRTABLE_OAUTH_CLIENT_ID"
  | "AIRTABLE_OAUTH_CLIENT_SECRET"
  | "DROPBOX_OAUTH_CLIENT_ID"
  | "DROPBOX_OAUTH_CLIENT_SECRET"
  | "GMAIL_OAUTH_CLIENT_ID"
  | "GMAIL_OAUTH_CLIENT_SECRET"
  | "GDRIVE_OAUTH_CLIENT_ID"
  | "GDRIVE_OAUTH_CLIENT_SECRET"
  | "SHOPIFY_CLIENT_ID"
  | "SHOPIFY_CLIENT_SECRET"
  | "SLACK_CLIENT_ID"
  | "SLACK_CLIENT_SECRET"
  | "SQUARE_OAUTH_ENVIRONMENT"
  | "SQUARE_OAUTH_CLIENT_ID"
  | "SQUARE_OAUTH_CLIENT_SECRET"
  | "STRIPE_CONNECT_CLIENT_ID"
  | "STRIPE_CONNECT_CLIENT_SECRET"
  | "STRIPE_CONNECT_WEBHOOK_ID"
  | "STRIPE_CONNECT_WEBHOOK_SECRET"
  | "NOTION_OAUTH_CLIENT_ID"
  | "NOTION_OAUTH_CLIENT_SECRET"
  | "WHATSAPP_APP_ID"
  | "WHATSAPP_APP_SECRET"
  | "WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID"
>;

export type ProviderStartContextByProvider = {
  readonly airtable: { readonly provider: "airtable" };
  readonly dropbox: { readonly provider: "dropbox" };
  readonly gmail: {
    readonly provider: "gmail";
    readonly authorizationProduct: GmailAuthorizationProduct;
  };
  readonly google_drive: { readonly provider: "google_drive" };
  readonly notion: { readonly provider: "notion" };
  readonly shopify: {
    readonly provider: "shopify";
    readonly shopDomain: string;
  };
  readonly slack: { readonly provider: "slack" };
  readonly square: { readonly provider: "square" };
  readonly stripe: { readonly provider: "stripe" };
  readonly whatsapp: { readonly provider: "whatsapp" };
};

export type ProviderStartContext =
  ProviderStartContextByProvider[ActiveIntegrationProvider];

export type ProviderAuthorizationConfigurationByProvider = {
  readonly airtable: { readonly clientId: string };
  readonly dropbox: { readonly clientId: string };
  readonly gmail: { readonly clientId: string };
  readonly google_drive: { readonly clientId: string };
  readonly notion: { readonly clientId: string };
  readonly shopify: { readonly clientId: string };
  readonly slack: { readonly clientId: string };
  readonly square: SquareApplication;
  readonly stripe: { readonly clientId: string };
  readonly whatsapp: {
    readonly appId: string;
    readonly embeddedSignupConfigurationId: string;
  };
};

export type ProviderAuthorizationInput<P extends ActiveIntegrationProvider> = {
  readonly configuration: ProviderAuthorizationConfigurationByProvider[P];
  readonly context: ProviderStartContextByProvider[P];
  readonly state: string;
  readonly redirectUri: string;
  readonly pkceVerifier: string | null;
};

export type ProviderOnboardingAdapter<P extends ActiveIntegrationProvider> = {
  readonly provider: P;
  readonly requiredScopes: readonly string[];
  readonly stateTtlMs: number;
  readonly parseStartContext: (
    raw: unknown,
  ) => ProviderStartContextByProvider[P] | null;
  readonly configurationIsValid: (env: ProviderAdapterBindings) => boolean;
  readonly authorizationSecret: (env: ProviderAdapterBindings) => string | null;
  readonly authorizationUrl: (
    input: ProviderAuthorizationInput<P>,
  ) => Promise<string>;
  readonly scopeIsGranted: (
    requiredScope: string,
    grantedScopes: ReadonlySet<string>,
  ) => boolean;
};

type ProviderConnectionFamilyByProvider = {
  readonly airtable: {
    readonly kind: "oauth_connection";
    readonly pkce: "required";
  };
  readonly dropbox: {
    readonly kind: "oauth_connection";
    readonly pkce: "required";
  };
  readonly gmail: {
    readonly kind: "oauth_connection";
    readonly pkce: "required";
  };
  readonly google_drive: {
    readonly kind: "oauth_connection";
    readonly pkce: "required";
  };
  readonly notion: { readonly kind: "oauth_connection"; readonly pkce: "none" };
  readonly shopify: {
    readonly kind: "oauth_connection";
    readonly pkce: "none";
  };
  readonly slack: { readonly kind: "oauth_connection"; readonly pkce: "none" };
  readonly square: { readonly kind: "oauth_connection"; readonly pkce: "none" };
  readonly stripe: { readonly kind: "oauth_connection"; readonly pkce: "none" };
  readonly whatsapp: {
    readonly kind: "embedded_signup";
    readonly authority: "connection_credential";
  };
};

type ProviderMailFacet<P extends ActiveIntegrationProvider> =
  P extends MailIntegrationProvider
    ? { readonly mail: MailProviderAdapter<P> }
    : { readonly mail?: never };

type ProviderConnectionAdapter<P extends ActiveIntegrationProvider> = {
  readonly provider: P;
  readonly dataClasses: readonly IntegrationDiscoveryDataClass[];
  readonly capabilityIds: readonly ActiveCapabilityId[];
  readonly connectionFamily: ProviderConnectionFamilyByProvider[P];
  readonly onboarding: ProviderOnboardingAdapter<P>;
  readonly completeConnection: (
    input: CompleteProviderInput,
    authorization: ProviderOAuthAttempt,
    provisioning: ProvisioningProviderConnectionAttempt,
    code: string,
  ) => Promise<Result<ProviderCompletion, ProviderOnboardingError>>;
  readonly observe: (
    input: ProviderObservationRequest,
  ) => Promise<ProviderManifestEvidence>;
  readonly remove: ProviderCleanupAdapter<P>["remove"];
  readonly manualActionInstruction: ProviderManualActionInstruction;
};

export type ProviderAdapter<P extends ActiveIntegrationProvider> = {
  readonly [Provider in P]: ProviderConnectionAdapter<Provider> &
    ProviderMailFacet<Provider>;
}[P];

export type ProviderAdapterByProvider = {
  readonly [P in ActiveIntegrationProvider]: ProviderAdapter<P>;
};

export type ProviderCleanupReason =
  | "provider_cleanup_configuration_missing"
  | "provider_cleanup_credential_missing"
  | "provider_cleanup_http_unavailable"
  | "provider_cleanup_provider_rejected"
  | "provider_cleanup_response_invalid";

export type ProviderManualActionInstruction =
  | "revoke_airtable_access_in_airtable"
  | "revoke_dropbox_access_in_dropbox"
  | "revoke_gmail_access_in_google"
  | "revoke_google_drive_access_in_google"
  | "revoke_notion_access_in_notion"
  | "remove_shopify_app_in_shopify"
  | "remove_slack_app_in_slack"
  | "revoke_square_access_in_square"
  | "revoke_stripe_access_in_stripe"
  | "remove_whatsapp_access_in_meta";

export type ProviderCleanupResult =
  | { readonly kind: "removed" }
  | {
      readonly kind: "retryable_failure";
      readonly reason: ProviderCleanupReason;
    }
  | {
      readonly kind: "manual_action_required";
      readonly reason: ProviderCleanupReason;
      readonly instruction: ProviderManualActionInstruction;
    }
  | {
      readonly kind: "permanent_failure";
      readonly reason: ProviderCleanupReason;
      readonly instruction: ProviderManualActionInstruction;
    };

/** Cleanup also reaches Commerce, which holds Square connections. */
export type ProviderCleanupBindings = ProviderAdapterBindings &
  Partial<
    Pick<Env, "COMMERCE" | "COMMERCE_BASE_URL" | "COMMERCE_SERVICE_TOKEN">
  >;

type ProviderCleanupAdapterInput<P extends ActiveIntegrationProvider> = {
  readonly cleanup: ProviderCleanupByProvider[P];
  readonly env: ProviderCleanupBindings;
  readonly credentials: ProviderCleanupCredentials;
  readonly fetcher: typeof fetch;
};

export type ProviderCleanupAdapter<P extends ActiveIntegrationProvider> = {
  readonly provider: P;
  readonly manualActionInstruction: ProviderManualActionInstruction;
  readonly remove: (
    input: ProviderCleanupAdapterInput<P>,
  ) => Promise<ProviderCleanupResult>;
};

export type ProviderObservationRequest = {
  readonly scope: OrganisationExecutionScope;
  readonly env: Env;
  readonly integrationAccountId: IntegrationAccountId;
  readonly environment: "development" | "production";
  readonly providerAccountId: string;
  readonly credentialRef: VaultHandle | null;
  readonly organisationId: OrganisationId;
  readonly fetcher: typeof fetch;
};

function retryableProviderFailure(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function providerHttpFailure(
  status: number,
  instruction: ProviderManualActionInstruction,
): ProviderCleanupResult {
  return retryableProviderFailure(status)
    ? { kind: "retryable_failure", reason: "provider_cleanup_http_unavailable" }
    : {
        kind: "permanent_failure",
        reason: "provider_cleanup_provider_rejected",
        instruction,
      };
}
