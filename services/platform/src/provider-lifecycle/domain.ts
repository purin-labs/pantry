import type {
  OrganisationExecutionScope,
  OrganisationExecutionScopeError,
  OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import type {
  ProviderAttemptWire,
  ProviderAuthorizationContext,
} from "../data/provider-attempt";
import type { Env } from "../env";
import type { WorkspaceId } from "../ids";
import type { ProviderCredentialCutoverError } from "./credential-cutover";
import type {
  ActiveIntegrationProvider,
  ProviderStartContext,
} from "../provider-adapters/domain";

export type OnboardingProvider = ActiveIntegrationProvider;

export type ProviderOAuthAttempt = {
  readonly state: ProviderAuthorizationContext;
  readonly context: ProviderStartContext;
};

export type ProviderCompletion = {
  readonly provider: OnboardingProvider;
  readonly attempt: ProviderAttemptWire;
  readonly returnPath: string;
};

export type ProviderOnboardingError =
  | OrganisationExecutionScopeError
  | { readonly code: "provider_configuration_missing" }
  | { readonly code: "provider_context_invalid" }
  | { readonly code: "provider_attempt_open" }
  | { readonly code: "provider_attempt_not_found" }
  | { readonly code: "provider_attempt_terminal" }
  | { readonly code: "provider_attempt_state_conflict" }
  | { readonly code: "provider_state_invalid" }
  | { readonly code: "provider_state_replayed" }
  | { readonly code: "authorization_expired" }
  | { readonly code: "configuration_version_conflict" }
  | { readonly code: "provider_oauth_denied" }
  | {
      readonly code: "provider_oauth_exchange_failed";
      readonly status: number;
      readonly requestId: string | null;
    }
  | { readonly code: "provider_oauth_response_invalid" }
  | { readonly code: "provider_scope_missing" }
  | { readonly code: "provider_environment_mismatch" }
  | { readonly code: "provider_account_ineligible" }
  | { readonly code: "provider_asset_missing" }
  | { readonly code: "provider_callback_signature_invalid" }
  | { readonly code: "provider_credential_store_failed" }
  | ProviderCredentialCutoverError
  | { readonly code: "provider_webhook_registration_failed" }
  | { readonly code: "provider_initial_sync_failed" }
  | { readonly code: "provider_identity_unverified" }
  | { readonly code: "provider_mailbox_identity_claimed" }
  | {
      readonly code: "provider_account_already_assigned";
      readonly provider: "slack";
      readonly providerAccountId: WorkspaceId;
    };

export type ProviderOAuthStartEnv = OrganisationPlacementBindings &
  Pick<
    Env,
    | "DB"
    | "SQUARE_OAUTH_ENVIRONMENT"
    | "SQUARE_OAUTH_CLIENT_ID"
    | "SQUARE_OAUTH_CLIENT_SECRET"
    | "SATYR_OAUTH_CALLBACK_ORIGIN"
    | "SATYR_PROVIDER_INGRESS_ORIGIN"
    | "SATYR_PUBLIC_ORIGIN"
    | "SHOPIFY_CLIENT_ID"
    | "SHOPIFY_CLIENT_SECRET"
    | "SLACK_CLIENT_ID"
    | "SLACK_CLIENT_SECRET"
    | "STRIPE_CONNECT_CLIENT_ID"
    | "STRIPE_CONNECT_CLIENT_SECRET"
    | "STRIPE_CONNECT_WEBHOOK_ID"
    | "STRIPE_CONNECT_WEBHOOK_SECRET"
    | "AIRTABLE_OAUTH_CLIENT_ID"
    | "AIRTABLE_OAUTH_CLIENT_SECRET"
    | "DROPBOX_OAUTH_CLIENT_ID"
    | "DROPBOX_OAUTH_CLIENT_SECRET"
    | "NOTION_OAUTH_CLIENT_ID"
    | "NOTION_OAUTH_CLIENT_SECRET"
    | "GMAIL_OAUTH_CLIENT_ID"
    | "GMAIL_OAUTH_CLIENT_SECRET"
    | "GDRIVE_OAUTH_CLIENT_ID"
    | "GDRIVE_OAUTH_CLIENT_SECRET"
    | "WHATSAPP_APP_ID"
    | "WHATSAPP_APP_SECRET"
    | "WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID"
  >;

export type CompleteProviderInput = {
  readonly scope: OrganisationExecutionScope;
  readonly env: Env;
  readonly provider: OnboardingProvider;
  readonly url: URL;
  readonly now: number;
  readonly fetcher: typeof fetch;
};
