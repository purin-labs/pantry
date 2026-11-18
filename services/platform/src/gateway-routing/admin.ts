import type { GatewayAdminRoute } from "./domain";

const ADMIN_ROUTES: Readonly<Record<string, GatewayAdminRoute>> = {
  "/v1/admin/active-policy-credential-closure": {
    kind: "inspectActivePolicyCredentialClosure",
  },
  "/v1/admin/code-mode-platform-cutover": {
    kind: "administerCodeModePlatformCutover",
  },
  "/v1/admin/cue-status": { kind: "cueStatus" },
  "/v1/admin/discord-interactions": {
    kind: "configureDiscordInteraction",
  },
  "/v1/admin/external-records-credential": {
    kind: "configureExternalRecordsCredential",
  },
  "/v1/admin/external-records-read": { kind: "readExternalRecords" },
  "/v1/admin/identity-links": { kind: "issueIdentityLink" },
  "/v1/admin/integration-accounts": { kind: "listIntegrationAccounts" },
  "/v1/admin/machine-census": { kind: "machineCensus" },
  "/v1/admin/person-roles": { kind: "administerPersonRoles" },
  "/v1/admin/shopify-connector": { kind: "configureShopifyConnector" },
  "/v1/admin/shopify-credential": { kind: "configureShopifyCredential" },
  "/v1/admin/shopify-cues": { kind: "configureShopifyCues" },
  "/v1/admin/shopify-test-order": { kind: "triggerShopifyTestOrder" },
  "/v1/admin/state-object-registry": { kind: "administerActorRegistry" },
  "/v1/admin/state-object-relocation": { kind: "administerActorRelocation" },
  "/v1/admin/state-object-restore": { kind: "administerActorRestore" },
  "/v1/admin/stripe-connector": { kind: "configureStripeConnector" },
  "/v1/admin/stripe-failure-cues": { kind: "configureStripeFailureCues" },
  "/v1/admin/stripe-test-credential": {
    kind: "configureStripeTestCredential",
  },
  "/v1/admin/stripe-test-failure": { kind: "triggerStripeTestFailure" },
  "/v1/admin/organisation-installs": { kind: "createOrganisationInstall" },
  "/v1/admin/vault-root-closure": { kind: "inspectRetainedVaultRootClosure" },
};

export function matchAdminRoute(pathname: string): GatewayAdminRoute | null {
  return ADMIN_ROUTES[pathname] ?? null;
}
