import type { OrganisationDatabaseSession } from "@purin-labs/kernel/database-handles";
import { airtableCleanupAdapter, airtableOnboardingAdapter } from "./airtable";
import {
  gmailAuthorizationClientId,
  gmailAuthorizationSecretForProduct,
  gmailCleanupAdapter,
  gmailConfigurationIsValidForProduct,
  gmailOnboardingAdapter,
} from "./gmail";
import { gmailMailAdapter } from "@purin-labs/connections/mail/gmail-mail-adapter";
import { notionCleanupAdapter, notionOnboardingAdapter } from "./notion";
import { slackCleanupAdapter, slackOnboardingAdapter } from "./slack";
import {
  readSquareConfiguration,
  squareCleanupAdapter,
  squareOnboardingAdapter,
} from "./square";
import { stripeCleanupAdapter, stripeOnboardingAdapter } from "./stripe";
import { whatsappCleanupAdapter, whatsappOnboardingAdapter } from "./whatsapp";
import {
  observeUnsupportedConnection,
  observeSlackConnection,
  observeStripeConnection,
  type ProviderObservationRequest,
} from "../provider-workflows/observation";
import {
  parseProviderOnlyCleanup,
  parseWhatsAppCleanup,
  readProviderOnlyCleanupContext,
  readWhatsAppCleanupContext,
  type ProviderCleanupBaseInput,
} from "../provider-workflows/cleanup-context";
import type { ProviderManifestEvidence } from "@purin-labs/connections/data/provider-attempt";
import type { IntegrationAccountId } from "@purin-labs/kernel/ids";
import type { VaultHandle } from "@purin-labs/authority/credential-vault/index";
import { connectExternalRecordsOAuth } from "../provider-workflows/external-records-connection";
import { connectGmail } from "../provider-workflows/gmail-connection";
import {
  connectDropbox,
  dropboxCleanupAdapter,
  dropboxOnboardingAdapter,
  observeDropboxConnection,
} from "../provider-workflows/dropbox-connection";
import {
  connectGoogleDrive,
  googleDriveCleanupAdapter,
  googleDriveOnboardingAdapter,
  observeGoogleDriveConnection,
} from "../provider-workflows/google-drive-connection";
import { connectSlack } from "../provider-workflows/slack-connection";
import {
  connectSquare,
  observeSquareConnection,
} from "../provider-workflows/square-connection";
import { connectStripe } from "../provider-workflows/stripe-connection";
import { connectWhatsApp } from "../provider-workflows/whatsapp-connection";
import type { ProvisioningProviderConnectionAttempt } from "@purin-labs/connections/data/provider-attempt";
import type {
  CompleteProviderInput,
  ProviderCompletion,
  ProviderOAuthAttempt,
  ProviderOnboardingError,
} from "../integrations/contract/provider-lifecycle";
import type { Result } from "@purin-labs/kernel/result";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import {
  type ProviderAuthorizationInput,
  type ProviderAuthorizationConfigurationByProvider,
  type ProviderAdapterByProvider,
  type ProviderCleanup,
  type ProviderAdapterBindings,
  type ProviderCleanupBindings,
  type ProviderCleanupCredentials,
  type ProviderCleanupResult,
  type ProviderManualActionInstruction,
  type ProviderStartContext,
  type ProviderStartContextByProvider,
} from "../integrations/contract/provider-adapter";
import { providerModules } from "../integrations/contract/provider-modules";
import {
  PROVIDER_DATA_CLASSES,
  type ActiveIntegrationProvider,
} from "@purin-labs/connections/data/integration-provider-directory";
import type { VariantBy } from "@purin-labs/type-utils";

export const PROVIDER_ADAPTERS = {
  airtable: {
    provider: "airtable",
    dataClasses: PROVIDER_DATA_CLASSES.airtable,
    capabilityIds: [
      CAPABILITY_KEYS.airtableApiRead,
      CAPABILITY_KEYS.airtableApiWrite,
    ],
    connectionFamily: { kind: "oauth_connection", pkce: "required" },
    onboarding: airtableOnboardingAdapter,
    completeConnection: connectExternalRecordsOAuth,
    observe: observeUnsupportedConnection,
    remove: airtableCleanupAdapter.remove,
    manualActionInstruction: airtableCleanupAdapter.manualActionInstruction,
  },
  dropbox: {
    provider: "dropbox",
    dataClasses: PROVIDER_DATA_CLASSES.dropbox,
    capabilityIds: [CAPABILITY_KEYS.fileRead],
    connectionFamily: { kind: "oauth_connection", pkce: "required" },
    onboarding: dropboxOnboardingAdapter,
    completeConnection: connectDropbox,
    observe: observeDropboxConnection,
    remove: dropboxCleanupAdapter.remove,
    manualActionInstruction: dropboxCleanupAdapter.manualActionInstruction,
  },
  gmail: {
    provider: "gmail",
    mail: gmailMailAdapter,
    dataClasses: PROVIDER_DATA_CLASSES.gmail,
    capabilityIds: [
      CAPABILITY_KEYS.emailMailboxRead,
      CAPABILITY_KEYS.emailReplyPropose,
      CAPABILITY_KEYS.emailOperationalPropose,
    ],
    connectionFamily: { kind: "oauth_connection", pkce: "required" },
    onboarding: gmailOnboardingAdapter,
    completeConnection: connectGmail,
    observe: observeUnsupportedConnection,
    remove: gmailCleanupAdapter.remove,
    manualActionInstruction: gmailCleanupAdapter.manualActionInstruction,
  },
  google_drive: {
    provider: "google_drive",
    dataClasses: PROVIDER_DATA_CLASSES.google_drive,
    capabilityIds: [CAPABILITY_KEYS.fileRead],
    connectionFamily: { kind: "oauth_connection", pkce: "required" },
    onboarding: googleDriveOnboardingAdapter,
    completeConnection: connectGoogleDrive,
    observe: observeGoogleDriveConnection,
    remove: googleDriveCleanupAdapter.remove,
    manualActionInstruction: googleDriveCleanupAdapter.manualActionInstruction,
  },
  notion: {
    provider: "notion",
    dataClasses: PROVIDER_DATA_CLASSES.notion,
    capabilityIds: [],
    connectionFamily: { kind: "oauth_connection", pkce: "none" },
    onboarding: notionOnboardingAdapter,
    completeConnection: connectExternalRecordsOAuth,
    observe: observeUnsupportedConnection,
    remove: notionCleanupAdapter.remove,
    manualActionInstruction: notionCleanupAdapter.manualActionInstruction,
  },
  // The Shopify module gives its entry, and the Worker registers it.
  get shopify() {
    return providerModules.use().shopify.adapter;
  },
  slack: {
    provider: "slack",
    dataClasses: PROVIDER_DATA_CLASSES.slack,
    capabilityIds: [CAPABILITY_KEYS.slackMessagePropose],
    connectionFamily: { kind: "oauth_connection", pkce: "none" },
    onboarding: slackOnboardingAdapter,
    completeConnection: connectSlack,
    observe: observeSlackConnection,
    remove: slackCleanupAdapter.remove,
    manualActionInstruction: slackCleanupAdapter.manualActionInstruction,
  },
  square: {
    provider: "square",
    dataClasses: PROVIDER_DATA_CLASSES.square,
    capabilityIds: [],
    connectionFamily: { kind: "oauth_connection", pkce: "none" },
    onboarding: squareOnboardingAdapter,
    completeConnection: connectSquare,
    observe: observeSquareConnection,
    remove: squareCleanupAdapter.remove,
    manualActionInstruction: squareCleanupAdapter.manualActionInstruction,
  },
  stripe: {
    provider: "stripe",
    dataClasses: PROVIDER_DATA_CLASSES.stripe,
    capabilityIds: [
      CAPABILITY_KEYS.stripeChargeCreate,
      CAPABILITY_KEYS.stripeRefundCreate,
      CAPABILITY_KEYS.stripeSubscriptionCancel,
      CAPABILITY_KEYS.stripePayoutCreate,
      CAPABILITY_KEYS.stripeTransferCreate,
      CAPABILITY_KEYS.stripePaymentIntentCapture,
      CAPABILITY_KEYS.stripePaymentIntentConfirm,
      CAPABILITY_KEYS.stripeSubscriptionUpdate,
    ],
    connectionFamily: { kind: "oauth_connection", pkce: "none" },
    onboarding: stripeOnboardingAdapter,
    completeConnection: connectStripe,
    observe: observeStripeConnection,
    remove: stripeCleanupAdapter.remove,
    manualActionInstruction: stripeCleanupAdapter.manualActionInstruction,
  },
  whatsapp: {
    provider: "whatsapp",
    dataClasses: PROVIDER_DATA_CLASSES.whatsapp,
    capabilityIds: [
      CAPABILITY_KEYS.whatsappSupportRead,
      CAPABILITY_KEYS.whatsappSupportReplySend,
    ],
    connectionFamily: {
      kind: "embedded_signup",
      authority: "connection_credential",
    },
    onboarding: whatsappOnboardingAdapter,
    completeConnection: connectWhatsApp,
    observe: observeUnsupportedConnection,
    remove: whatsappCleanupAdapter.remove,
    manualActionInstruction: whatsappCleanupAdapter.manualActionInstruction,
  },
} satisfies ProviderAdapterByProvider;

export function providerConfigurationIsValid(
  env: ProviderAdapterBindings,
  provider: ActiveIntegrationProvider,
  context?: ProviderStartContext,
): boolean {
  if (provider === "gmail" && context?.provider === "gmail") {
    return gmailConfigurationIsValidForProduct(
      env,
      context.authorizationProduct,
    );
  }
  return PROVIDER_ADAPTERS[provider].onboarding.configurationIsValid(env);
}

export function providerAuthorizationSecret(
  env: ProviderAdapterBindings,
  provider: ActiveIntegrationProvider,
  context?: ProviderStartContext,
): string | null {
  if (provider === "gmail" && context?.provider === "gmail") {
    return gmailAuthorizationSecretForProduct(
      env,
      context.authorizationProduct,
    );
  }
  return PROVIDER_ADAPTERS[provider].onboarding.authorizationSecret(env);
}

export function providerStateTtlMs(
  provider: ActiveIntegrationProvider,
): number {
  return PROVIDER_ADAPTERS[provider].onboarding.stateTtlMs;
}

export function providerUsesPkce(provider: ActiveIntegrationProvider): boolean {
  const family = PROVIDER_ADAPTERS[provider].connectionFamily;
  return family.kind === "oauth_connection" && family.pkce === "required";
}

export function parseProviderStartContext(
  provider: ActiveIntegrationProvider,
  raw: unknown,
): ProviderStartContext | null {
  switch (provider) {
    case "airtable":
      return PROVIDER_ADAPTERS.airtable.onboarding.parseStartContext(raw);
    case "dropbox":
      return PROVIDER_ADAPTERS.dropbox.onboarding.parseStartContext(raw);
    case "gmail":
      return PROVIDER_ADAPTERS.gmail.onboarding.parseStartContext(raw);
    case "google_drive":
      return PROVIDER_ADAPTERS.google_drive.onboarding.parseStartContext(raw);
    case "notion":
      return PROVIDER_ADAPTERS.notion.onboarding.parseStartContext(raw);
    case "shopify":
      return PROVIDER_ADAPTERS.shopify.onboarding.parseStartContext(raw);
    case "slack":
      return PROVIDER_ADAPTERS.slack.onboarding.parseStartContext(raw);
    case "square":
      return PROVIDER_ADAPTERS.square.onboarding.parseStartContext(raw);
    case "stripe":
      return PROVIDER_ADAPTERS.stripe.onboarding.parseStartContext(raw);
    case "whatsapp":
      return PROVIDER_ADAPTERS.whatsapp.onboarding.parseStartContext(raw);
  }
}

export function providerAuthorizationUrl(
  input: Readonly<{
    env: ProviderAdapterBindings;
    context: ProviderStartContext;
    state: string;
    redirectUri: string;
    pkceVerifier: string | null;
  }>,
): Promise<string> {
  switch (input.context.provider) {
    case "airtable":
      return PROVIDER_ADAPTERS.airtable.onboarding.authorizationUrl(
        providerAuthorizationInput(input, input.context, {
          clientId: requiredProviderConfiguration(
            input.env.AIRTABLE_OAUTH_CLIENT_ID,
          ),
        }),
      );
    case "dropbox":
      return PROVIDER_ADAPTERS.dropbox.onboarding.authorizationUrl(
        providerAuthorizationInput(input, input.context, {
          clientId: requiredProviderConfiguration(
            input.env.DROPBOX_OAUTH_CLIENT_ID,
          ),
        }),
      );
    case "gmail":
      return PROVIDER_ADAPTERS.gmail.onboarding.authorizationUrl(
        providerAuthorizationInput(input, input.context, {
          clientId: requiredProviderConfiguration(
            gmailAuthorizationClientId(
              input.env,
              input.context.authorizationProduct,
            ) ?? undefined,
          ),
        }),
      );
    case "google_drive":
      return PROVIDER_ADAPTERS.google_drive.onboarding.authorizationUrl(
        providerAuthorizationInput(input, input.context, {
          clientId: requiredProviderConfiguration(
            input.env.GDRIVE_OAUTH_CLIENT_ID,
          ),
        }),
      );
    case "notion":
      return PROVIDER_ADAPTERS.notion.onboarding.authorizationUrl(
        providerAuthorizationInput(input, input.context, {
          clientId: requiredProviderConfiguration(
            input.env.NOTION_OAUTH_CLIENT_ID,
          ),
        }),
      );
    case "shopify":
      return PROVIDER_ADAPTERS.shopify.onboarding.authorizationUrl(
        providerAuthorizationInput(input, input.context, {
          clientId: requiredProviderConfiguration(input.env.SHOPIFY_CLIENT_ID),
        }),
      );
    case "slack":
      return PROVIDER_ADAPTERS.slack.onboarding.authorizationUrl(
        providerAuthorizationInput(input, input.context, {
          clientId: requiredProviderConfiguration(input.env.SLACK_CLIENT_ID),
        }),
      );
    case "square":
      return PROVIDER_ADAPTERS.square.onboarding.authorizationUrl(
        providerAuthorizationInput(
          input,
          input.context,
          requiredSquareConfiguration(input.env),
        ),
      );
    case "stripe":
      return PROVIDER_ADAPTERS.stripe.onboarding.authorizationUrl(
        providerAuthorizationInput(input, input.context, {
          clientId: requiredProviderConfiguration(
            input.env.STRIPE_CONNECT_CLIENT_ID,
          ),
        }),
      );
    case "whatsapp":
      return PROVIDER_ADAPTERS.whatsapp.onboarding.authorizationUrl(
        providerAuthorizationInput(input, input.context, {
          appId: requiredProviderConfiguration(input.env.WHATSAPP_APP_ID),
          embeddedSignupConfigurationId: requiredProviderConfiguration(
            input.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID,
          ),
        }),
      );
  }
}

export async function removeProviderConnection(
  input: Readonly<{
    cleanup: ProviderCleanup;
    env: ProviderCleanupBindings;
    credentials: ProviderCleanupCredentials;
    fetcher: typeof fetch;
  }>,
): Promise<ProviderCleanupResult> {
  switch (input.cleanup.provider) {
    case "airtable":
      return PROVIDER_ADAPTERS.airtable.remove(
        adapterInput(input, input.cleanup),
      );
    case "dropbox":
      return PROVIDER_ADAPTERS.dropbox.remove(
        adapterInput(input, input.cleanup),
      );
    case "gmail":
      return PROVIDER_ADAPTERS.gmail.remove(adapterInput(input, input.cleanup));
    case "google_drive":
      return PROVIDER_ADAPTERS.google_drive.remove(
        adapterInput(input, input.cleanup),
      );
    case "notion":
      return PROVIDER_ADAPTERS.notion.remove(
        adapterInput(input, input.cleanup),
      );
    case "shopify":
      return PROVIDER_ADAPTERS.shopify.remove(
        adapterInput(input, input.cleanup),
      );
    case "slack":
      return PROVIDER_ADAPTERS.slack.remove(adapterInput(input, input.cleanup));
    case "square":
      return PROVIDER_ADAPTERS.square.remove(
        adapterInput(input, input.cleanup),
      );
    case "stripe":
      return PROVIDER_ADAPTERS.stripe.remove(
        adapterInput(input, input.cleanup),
      );
    case "whatsapp":
      return PROVIDER_ADAPTERS.whatsapp.remove(
        adapterInput(input, input.cleanup),
      );
  }
}

export function manualInstructionForProvider(
  provider: ActiveIntegrationProvider,
): ProviderManualActionInstruction {
  return PROVIDER_ADAPTERS[provider].manualActionInstruction;
}

export function observeProviderConnection(
  provider: ActiveIntegrationProvider,
  input: ProviderObservationRequest,
): Promise<ProviderManifestEvidence> {
  return PROVIDER_ADAPTERS[provider].observe(input);
}

export function readProviderCleanupContext(
  input: Readonly<{
    db: Pick<OrganisationDatabaseSession, "prepare">;
    integrationAccountId: IntegrationAccountId;
    provider: ActiveIntegrationProvider;
    removeApplicationSubscription: boolean;
  }>,
): Promise<string | null> {
  switch (input.provider) {
    case "airtable":
    case "dropbox":
    case "gmail":
    case "google_drive":
    case "notion":
    case "shopify":
    case "slack":
    case "square":
    case "stripe":
      return readProviderOnlyCleanupContext(input.provider);
    case "whatsapp":
      return readWhatsAppCleanupContext({
        db: input.db,
        integrationAccountId: input.integrationAccountId,
        removeApplicationSubscription: input.removeApplicationSubscription,
      });
  }
}

export function parseProviderCleanup(
  input: Readonly<{
    cleanupId: string;
    organisationId: ProviderCleanup["organisationId"];
    integrationAccountId: ProviderCleanup["integrationAccountId"];
    provider: ActiveIntegrationProvider;
    environment: ProviderCleanup["environment"];
    providerAccountId: string;
    providerConnectionId: string;
    credentialHandles: readonly VaultHandle[];
    rawContext: string;
  }>,
): ProviderCleanup | null {
  switch (input.provider) {
    case "airtable":
      return parseProviderOnlyCleanup(
        "airtable",
        cleanupBase("airtable", input),
        input.rawContext,
      );
    case "dropbox":
      return parseProviderOnlyCleanup(
        "dropbox",
        cleanupBase("dropbox", input),
        input.rawContext,
      );
    case "gmail":
      return parseProviderOnlyCleanup(
        "gmail",
        cleanupBase("gmail", input),
        input.rawContext,
      );
    case "google_drive":
      return parseProviderOnlyCleanup(
        "google_drive",
        cleanupBase("google_drive", input),
        input.rawContext,
      );
    case "notion":
      return parseProviderOnlyCleanup(
        "notion",
        cleanupBase("notion", input),
        input.rawContext,
      );
    case "shopify":
      return parseProviderOnlyCleanup(
        "shopify",
        cleanupBase("shopify", input),
        input.rawContext,
      );
    case "slack":
      return parseProviderOnlyCleanup(
        "slack",
        cleanupBase("slack", input),
        input.rawContext,
      );
    case "square":
      return parseProviderOnlyCleanup(
        "square",
        cleanupBase("square", input),
        input.rawContext,
      );
    case "stripe":
      return parseProviderOnlyCleanup(
        "stripe",
        cleanupBase("stripe", input),
        input.rawContext,
      );
    case "whatsapp":
      return parseWhatsAppCleanup(
        cleanupBase("whatsapp", input),
        input.rawContext,
      );
  }
}

export function completeProviderConnection(
  input: CompleteProviderInput,
  authorization: ProviderOAuthAttempt,
  provisioning: ProvisioningProviderConnectionAttempt,
  code: string,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  switch (authorization.context.provider) {
    case "airtable":
    case "notion":
      return PROVIDER_ADAPTERS[
        authorization.context.provider
      ].completeConnection(input, authorization, provisioning, code);
    case "gmail":
      return PROVIDER_ADAPTERS.gmail.completeConnection(
        input,
        authorization,
        provisioning,
        code,
      );
    case "dropbox":
      return PROVIDER_ADAPTERS.dropbox.completeConnection(
        input,
        authorization,
        provisioning,
        code,
      );
    case "google_drive":
      return PROVIDER_ADAPTERS.google_drive.completeConnection(
        input,
        authorization,
        provisioning,
        code,
      );
    case "shopify":
      return PROVIDER_ADAPTERS.shopify.completeConnection(
        input,
        authorization,
        provisioning,
        code,
      );
    case "slack":
      return PROVIDER_ADAPTERS.slack.completeConnection(
        input,
        authorization,
        provisioning,
        code,
      );
    case "square":
      return PROVIDER_ADAPTERS.square.completeConnection(
        input,
        authorization,
        provisioning,
        code,
      );
    case "stripe":
      return PROVIDER_ADAPTERS.stripe.completeConnection(
        input,
        authorization,
        provisioning,
        code,
      );
    case "whatsapp":
      return PROVIDER_ADAPTERS.whatsapp.completeConnection(
        input,
        authorization,
        provisioning,
        code,
      );
  }
}

function adapterInput<P extends ActiveIntegrationProvider>(
  input: Readonly<{
    cleanup: ProviderCleanup;
    env: ProviderCleanupBindings;
    credentials: ProviderCleanupCredentials;
    fetcher: typeof fetch;
  }>,
  cleanup: VariantBy<ProviderCleanup, "provider", P>,
): {
  readonly cleanup: VariantBy<ProviderCleanup, "provider", P>;
  readonly env: ProviderCleanupBindings;
  readonly credentials: ProviderCleanupCredentials;
  readonly fetcher: typeof fetch;
} {
  return {
    cleanup,
    env: input.env,
    credentials: input.credentials,
    fetcher: input.fetcher,
  };
}

function cleanupBase<P extends ActiveIntegrationProvider>(
  provider: P,
  input: Readonly<{
    cleanupId: string;
    organisationId: ProviderCleanup["organisationId"];
    integrationAccountId: ProviderCleanup["integrationAccountId"];
    environment: ProviderCleanup["environment"];
    providerAccountId: string;
    providerConnectionId: string;
    credentialHandles: readonly VaultHandle[];
  }>,
): ProviderCleanupBaseInput<P> {
  return {
    cleanupId: input.cleanupId,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    provider,
    environment: input.environment,
    providerAccountId: input.providerAccountId,
    providerConnectionId: input.providerConnectionId,
    credentialHandles: input.credentialHandles,
  };
}

function providerAuthorizationInput<P extends ActiveIntegrationProvider>(
  input: Readonly<{
    env: ProviderAdapterBindings;
    context: ProviderStartContext;
    state: string;
    redirectUri: string;
    pkceVerifier: string | null;
  }>,
  context: ProviderStartContextByProvider[P],
  configuration: ProviderAuthorizationConfigurationByProvider[P],
): ProviderAuthorizationInput<P> {
  return {
    configuration,
    context,
    state: input.state,
    redirectUri: input.redirectUri,
    pkceVerifier: input.pkceVerifier,
  };
}

function requiredSquareConfiguration(env: ProviderAdapterBindings) {
  const configuration = readSquareConfiguration(env);
  if (configuration.kind !== "configured") {
    throw new Error(
      configuration.kind === "invalid"
        ? `Invalid Square configuration: ${configuration.setting}`
        : "Square is unconfigured",
    );
  }
  return configuration.application;
}

function requiredProviderConfiguration(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error("provider configuration missing");
  }
  return value;
}
