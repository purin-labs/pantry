type GatewayStaticRoute =
  | Readonly<{ kind: "health" }>
  | Readonly<{ kind: "control" }>
  | Readonly<{ kind: "menuScreen" }>
  | Readonly<{ kind: "voiceMac" }>
  | Readonly<{ kind: "deviceGateway" }>
  | Readonly<{ kind: "notFound" }>;

export type GatewaySlackRoute =
  | Readonly<{ kind: "slackEvents" }>
  | Readonly<{ kind: "slackInteractions" }>
  | Readonly<{ kind: "slackInstallStart" }>
  | Readonly<{ kind: "slackInstall" }>
  | Readonly<{ kind: "slackInstallLiveness" }>;

export type GatewayAdminRoute =
  | Readonly<{ kind: "createOrganisationInstall" }>
  | Readonly<{ kind: "issueIdentityLink" }>
  | Readonly<{ kind: "administerPersonRoles" }>
  | Readonly<{ kind: "administerCodeModePlatformCutover" }>
  | Readonly<{ kind: "administerActorRegistry" }>
  | Readonly<{ kind: "machineCensus" }>
  | Readonly<{ kind: "inspectRetainedVaultRootClosure" }>
  | Readonly<{ kind: "administerActorRelocation" }>
  | Readonly<{ kind: "administerActorRestore" }>
  | Readonly<{ kind: "configureStripeTestCredential" }>
  | Readonly<{ kind: "triggerStripeTestFailure" }>
  | Readonly<{ kind: "cueStatus" }>
  | Readonly<{ kind: "configureShopifyCredential" }>
  | Readonly<{ kind: "configureExternalRecordsCredential" }>
  | Readonly<{ kind: "readExternalRecords" }>
  | Readonly<{ kind: "configureShopifyConnector" }>
  | Readonly<{ kind: "configureShopifyCues" }>
  | Readonly<{ kind: "triggerShopifyTestOrder" }>
  | Readonly<{ kind: "configureStripeConnector" }>
  | Readonly<{ kind: "configureStripeFailureCues" }>
  | Readonly<{ kind: "listIntegrationAccounts" }>
  | Readonly<{ kind: "configureDiscordInteraction" }>;

export type GatewayWebhookRoute =
  | Readonly<{ kind: "stripeConnectWebhook" }>
  | Readonly<{ kind: "stripeWebhook"; organisationIdRaw: string }>
  | Readonly<{ kind: "emailGoogleWebhook" }>
  | Readonly<{ kind: "whatsappWebhook" }>
  | Readonly<{ kind: "shopifyWebhook"; organisationIdRaw: string }>
  | Readonly<{ kind: "underclerkWebhook"; organisationIdRaw: string }>
  | Readonly<{ kind: "dropboxWebhook" }>
  | Readonly<{ kind: "discordInteraction"; organisationIdRaw: string }>;

export type GatewayIdentityRoute =
  | Readonly<{ kind: "identityUiConfig" }>
  | Readonly<{ kind: "identityLinkChallenge"; tokenRaw: string }>
  | Readonly<{ kind: "completeIdentityLink"; tokenRaw: string }>
  | Readonly<{
      kind: "resolveInstall";
      surfaceKindRaw: string;
      workspaceIdRaw: string;
    }>
  | Readonly<{ kind: "organisationPing"; organisationIdRaw: string }>
  | Readonly<{
      kind: "onboardingActivationAcceptance";
      organisationIdRaw: string;
    }>;

export type GatewayAcceptanceRoute = Readonly<{
  kind: "cafeCommerceAcceptance";
  organisationIdRaw: string;
}>;

export type GatewayRoute =
  | GatewayStaticRoute
  | GatewaySlackRoute
  | GatewayAdminRoute
  | GatewayWebhookRoute
  | GatewayIdentityRoute
  | GatewayAcceptanceRoute;
