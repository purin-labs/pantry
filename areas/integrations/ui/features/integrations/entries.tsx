import type { ClaudeConnectionState } from "./claude-connection";
import React from "react";
import { Button } from "@purin-labs/ui/index";
import {
  TypeSafeConnectionPanel,
  type TypeSafeConnectionState,
} from "./typesafe-connection";
import { workspacePagePath } from "@purin-labs/ui/route";
import { PROVIDER_PRESENTATION } from "@purin-labs/area-integrations-contract/ui/integration-catalogue";
import {
  onePasswordStatusLabel,
  type OnePasswordStatus,
} from "../vault/onepassword-status";
import { renderIntegrationAccounts } from "./accounts";
import { renderCommerceSystemCard } from "./commerce-system";
import { GmailIntegrationPanel } from "./gmail";
import { InferenceIntegrationPanel } from "./inference";
import { SlackReasoningEffortPanel } from "./slack-reasoning-effort";
import {
  type IntegrationEntry,
  type IntegrationRailStatus,
  inferenceIntegrationStatus,
  typesafeConnectionStatus,
} from "./integrations-page";
import {
  OnePasswordIntegrationPanel,
  integrationAccountIsConnected,
  isActiveIntegrationAccount,
  isAirtableAccount,
  isDropboxAccount,
  isGmailAccount,
  isGoogleDriveAccount,
  isNotionAccount,
  isShopifyAccount,
  isSlackAccount,
  isSquareAccount,
  isStripeAccount,
  isWhatsAppAccount,
  mutationBlocked,
  mutationFeedbackMessage,
  providerConnectionBusy,
  renderCommerceConfigurationFeedback,
  renderMutationFeedback,
  renderShopifyCommerceChoice,
  whatsappConnectionActionState,
} from "./settings-support";
import type { IntegrationAccount } from "@purin-labs/control-api/portal/settings";
import type { IntegrationsPageProps } from "@purin-labs/area-integrations-contract/ui/features/integrations/settings-types";
import {
  FileStorageIntegrationPanel,
  IntegrationSetup,
  ProviderConnectButton,
  providerAttemptDiagnostics,
} from "./setup";
import {
  SlackSetup,
  renderSlackConnectAction,
  renderSlackFirstConnection,
} from "./slack";
import { InstalledAgentsWhatsAppPanel } from "./whatsapp";

export function buildIntegrationEntries(
  props: IntegrationsPageProps,
  claudeState: ClaudeConnectionState,
  setClaudeState: React.Dispatch<React.SetStateAction<ClaudeConnectionState>>,
  typesafeState: TypeSafeConnectionState,
  setTypeSafeState: React.Dispatch<
    React.SetStateAction<TypeSafeConnectionState>
  >,
  onePassword: OnePasswordStatus,
): readonly IntegrationEntry[] {
  return integrationEntries(
    props,
    claudeState,
    setClaudeState,
    typesafeState,
    setTypeSafeState,
    onePassword,
  ).filter(
    (entry) =>
      entry.id !== "whatsapp" ||
      props.whatsappConfigurationKnown === false ||
      props.whatsapp.applicationConfigured ||
      props.whatsapp.accounts.length > 0 ||
      entry.accounts.length > 0,
  );
}

function integrationEntries(
  props: IntegrationsPageProps,
  claudeState: ClaudeConnectionState,
  setClaudeState: React.Dispatch<React.SetStateAction<ClaudeConnectionState>>,
  typesafeState: TypeSafeConnectionState,
  setTypeSafeState: React.Dispatch<
    React.SetStateAction<TypeSafeConnectionState>
  >,
  onePassword: OnePasswordStatus,
): readonly IntegrationEntry[] {
  const shopify = props.accounts.filter(isShopifyAccount);
  const stripe = props.accounts.filter(isStripeAccount);
  const square = props.accounts.filter(isSquareAccount);
  const slack = props.accounts.filter(isSlackAccount);
  const airtable = props.accounts.filter(isAirtableAccount);
  const gmail = props.accounts.filter(isGmailAccount);
  const dropbox = props.accounts.filter(isDropboxAccount);
  const googleDrive = props.accounts.filter(isGoogleDriveAccount);
  const notion = props.accounts.filter(isNotionAccount);
  const whatsapp = props.accounts.filter(isWhatsAppAccount);
  const whatsappConnectionAction = whatsappConnectionActionState(
    props.mutations,
    props.pendingAuthorization,
    props.feedback,
  );
  const activeShopify = shopify.filter(isActiveIntegrationAccount);
  const activeSlack = slack.filter(isActiveIntegrationAccount);
  const shopifyError = mutationFeedbackMessage(props.feedback, {
    kind: "connect_provider",
    provider: "shopify",
  });
  const accountList = renderIntegrationAccounts.bind(null);
  const list = (accounts: readonly IntegrationAccount[]): React.ReactNode =>
    accounts.length === 0 ? null : (
      <div className="account-list">
        {accountList(
          accounts,
          props.credentialInventory,
          props.actions,
          props.mutations,
          props.pendingAuthorization,
          props.pendingConfirm,
          props.requestConfirm,
          props.canManage,
          props.feedback,
        )}
      </div>
    );

  return [
    {
      id: "typesafe",
      label: "TypeSafe AI",
      description: "Helps agents find records that belong together.",
      optional: true,
      tile: "typesafe",
      accounts: [],
      connected:
        typesafeState.kind === "ready" &&
        typesafeState.configuration.connection.kind === "connected",
      status: typesafeConnectionStatus(typesafeState, props.canManage),
      panel: (
        <TypeSafeConnectionPanel
          key={props.organisationId}
          organisationId={props.organisationId}
          canManage={props.canManage}
          state={typesafeState}
          setState={setTypeSafeState}
        />
      ),
    },
    {
      id: "codex",
      label: "AI account",
      description: "Choose the AI that runs your agents.",
      tile:
        props.inferenceSelection.kind === "pantry_platform"
          ? "builtin_commerce"
          : "codex",
      accounts: [],
      connected:
        props.inferenceSelection.kind === "claude_oauth"
          ? claudeState.kind === "ready" &&
            claudeState.view.connection.kind === "connected"
          : props.inferenceSelection.kind !== "codex_subscription" ||
            props.codexConnection.kind === "connected",
      status: inferenceIntegrationStatus(
        props.inferenceSelection,
        props.codexConnection,
        claudeState,
      ),
      panel: (
        <InferenceIntegrationPanel
          key={props.inferenceSelection.kind}
          claudeState={claudeState}
          setClaudeState={setClaudeState}
          organisationId={props.organisationId}
          connection={props.codexConnection}
          selection={props.inferenceSelection}
          canManage={props.canManage}
          canConnect={props.canConnectCodex}
          busy={mutationBlocked(props.mutations, { kind: "codex_connection" })}
          selectionBusy={mutationBlocked(props.mutations, {
            kind: "inference_selection",
          })}
          actions={props.actions}
          feedback={props.feedback}
        />
      ),
    },
    {
      id: "onepassword",
      label: "1Password",
      description: "Keep agent logins in your own 1Password vault.",
      tile: "onepassword",
      accounts: [],
      connected:
        onePassword.state.kind === "ready" &&
        onePassword.state.store.kind === "onepassword",
      status: props.canManage
        ? onePasswordStatusLabel(onePassword.state)
        : { kind: "idle", label: "Admins only" },
      // The panel lists items through 1Password, so it loads only when the
      // card opens.
      panel: (
        <React.Suspense fallback={<p>Loading 1Password…</p>}>
          <OnePasswordIntegrationPanel
            key={props.organisationId}
            organisationId={props.organisationId}
            canManage={props.canManage}
            vaultHref={workspacePagePath(
              props.organisationHandle,
              props.workspaceHandle,
              "vault",
            )}
            onChanged={() => void onePassword.reload()}
          />
        </React.Suspense>
      ),
    },
    {
      id: "commerce",
      label: "Purin Checkout",
      description: "Your built-in products, stock and orders.",
      tile: "builtin_commerce",
      accounts: [],
      connected: props.commerceSystem !== null,
      panel: (
        <>
          {renderCommerceSystemCard(
            props.commerceSystem,
            props.actions.syncCommerceSystem,
            mutationBlocked(props.mutations, { kind: "sync_commerce" }),
            props.canManage,
            props.commerceSyncProblem,
          )}
          {props.canManage &&
          props.commerceSystem?.kind === "builtin_commerce" ? (
            <IntegrationSetup title="Export tools (optional)">
              <p className="notice-text">
                Add these only if you ship goods to other countries. They add an
                export agent, a shipment list and views for export documents.
              </p>
              <div className="connection-actions">
                <Button
                  onClick={props.actions.publishExportCoordination}
                  disabled={mutationBlocked(props.mutations, {
                    kind: "provision_commerce",
                  })}
                >
                  Add export tools
                </Button>
              </div>
              {renderCommerceConfigurationFeedback(props.feedback)}
            </IntegrationSetup>
          ) : null}
          {/* A chosen system offers no change here, so the choice shows only
              while no system is chosen. */}
          {props.canManage && props.commerceSystem === null ? (
            <IntegrationSetup title="Choose a commerce system">
              <p className="notice-text">
                Purin Checkout starts with a demo café and patisserie catalogue.
                You can edit or replace its sample products and orders.
              </p>
              <div className="connection-actions">
                <Button
                  variant="primary"
                  onClick={props.actions.setupBuiltInCommerce}
                  disabled={mutationBlocked(props.mutations, {
                    kind: "provision_commerce",
                  })}
                >
                  Set up Purin Checkout
                </Button>
                {activeShopify.map(
                  renderShopifyCommerceChoice.bind(
                    null,
                    props.actions.selectShopifyCommerce,
                    props.mutations,
                  ),
                )}
              </div>
              {renderCommerceConfigurationFeedback(props.feedback)}
            </IntegrationSetup>
          ) : null}
        </>
      ),
    },
    {
      id: "shopify",
      label: PROVIDER_PRESENTATION.shopify.label,
      description: PROVIDER_PRESENTATION.shopify.description,
      tile: PROVIDER_PRESENTATION.shopify.tile,
      accounts: shopify,
      connected: shopify.some(integrationAccountIsConnected),
      panel: (
        <>
          {list(shopify)}
          {props.canManage ? (
            <IntegrationSetup
              title={
                shopify.length === 0 ? null : "Connect another Shopify store"
              }
            >
              <form
                className="provider-connect"
                onSubmit={props.actions.connectShopify}
                noValidate
              >
                <label>
                  <span>Your Shopify address</span>
                  <input
                    name="shopDomain"
                    placeholder="your-store.myshopify.com"
                    required
                    aria-invalid={shopifyError === null ? undefined : true}
                    aria-describedby={
                      shopifyError === null ? undefined : "shopify-store-error"
                    }
                  />
                </label>
                <Button
                  type="submit"
                  variant="primary"
                  aria-label="Connect Shopify in a popup"
                  disabled={providerConnectionBusy(
                    props.mutations,
                    props.pendingAuthorization,
                    "shopify",
                  )}
                >
                  Connect Shopify
                </Button>
                {shopifyError === null ? null : (
                  <p
                    id="shopify-store-error"
                    className="error-text"
                    role="alert"
                  >
                    {shopifyError}
                  </p>
                )}
              </form>
            </IntegrationSetup>
          ) : null}
        </>
      ),
    },
    {
      id: "stripe",
      label: PROVIDER_PRESENTATION.stripe.label,
      description: PROVIDER_PRESENTATION.stripe.description,
      tile: PROVIDER_PRESENTATION.stripe.tile,
      accounts: stripe,
      connected: stripe.some(integrationAccountIsConnected),
      panel: (
        <>
          {list(stripe)}
          {props.canManage &&
          props.commerceSystem?.kind === "builtin_commerce" ? (
            // One section: the shop's payments. A new account is the main
            // path; an owner who already uses Stripe connects it instead.
            <IntegrationSetup title={null}>
              <props.stripeSetup
                organisationId={props.organisationId}
                connectExisting={
                  stripe.some(integrationAccountIsConnected)
                    ? null
                    : props.actions.connectStripe
                }
                connectBusy={providerConnectionBusy(
                  props.mutations,
                  props.pendingAuthorization,
                  "stripe",
                )}
                connectFeedback={renderMutationFeedback(props.feedback, {
                  kind: "connect_provider",
                  provider: "stripe",
                })}
              />
            </IntegrationSetup>
          ) : props.canManage ? (
            <IntegrationSetup title={null}>
              <div className="connection-actions">
                <Button
                  variant="primary"
                  aria-label="Connect Stripe in a popup"
                  onClick={props.actions.connectStripe}
                  disabled={providerConnectionBusy(
                    props.mutations,
                    props.pendingAuthorization,
                    "stripe",
                  )}
                >
                  Connect Stripe
                </Button>
                {renderMutationFeedback(props.feedback, {
                  kind: "connect_provider",
                  provider: "stripe",
                })}
              </div>
            </IntegrationSetup>
          ) : null}
        </>
      ),
    },
    {
      id: "square",
      label: PROVIDER_PRESENTATION.square.label,
      description: PROVIDER_PRESENTATION.square.description,
      tile: PROVIDER_PRESENTATION.square.tile,
      accounts: square,
      connected: square.some(integrationAccountIsConnected),
      panel: (
        <>
          {list(square)}
          {props.canManage ? (
            <IntegrationSetup
              title={
                square.length === 0 ? null : "Connect another Square account"
              }
            >
              <div className="connection-actions">
                <Button
                  variant="primary"
                  aria-label="Connect Square in a popup"
                  onClick={props.actions.connectSquare}
                  disabled={providerConnectionBusy(
                    props.mutations,
                    props.pendingAuthorization,
                    "square",
                  )}
                >
                  Connect Square
                </Button>
                {renderMutationFeedback(props.feedback, {
                  kind: "connect_provider",
                  provider: "square",
                })}
              </div>
            </IntegrationSetup>
          ) : null}
        </>
      ),
    },
    {
      id: "slack",
      label: PROVIDER_PRESENTATION.slack.label,
      description: PROVIDER_PRESENTATION.slack.description,
      tile: PROVIDER_PRESENTATION.slack.tile,
      accounts: slack,
      connected: slack.some(integrationAccountIsConnected),
      // Before a workspace is connected the panel offers the connection. After
      // that the channel is the task, so it comes first and adding another
      // workspace comes last.
      panel: (
        <>
          {slack.length === 0 ? renderSlackFirstConnection(props) : null}
          <SlackSetup
            defaults={props.setupDefaults}
            accounts={activeSlack}
            connecting={providerConnectionBusy(
              props.mutations,
              props.pendingAuthorization,
              "slack",
            )}
            destinations={props.destinations}
            routing={props.slackRouting}
            organisationName={props.organisationHandle}
            setupFeedback={props.setupFeedback}
            organisationIsActive={props.organisationIsActive}
            canManage={props.canManage}
            mutations={props.mutations}
            actions={props.actions}
            mutationFeedback={props.feedback}
          />
          {slack.length === 0 ? null : (
            <SlackReasoningEffortPanel
              organisationId={props.organisationId}
              source={props.inferenceSelection.kind}
              canManage={props.canManage}
            />
          )}
          {list(slack)}
          {slack.length === 0 ? null : renderSlackConnectAction(props)}
        </>
      ),
    },
    {
      id: "airtable",
      label: PROVIDER_PRESENTATION.airtable.label,
      description: PROVIDER_PRESENTATION.airtable.description,
      tile: PROVIDER_PRESENTATION.airtable.tile,
      accounts: airtable,
      connected: airtable.some(integrationAccountIsConnected),
      panel: (
        <>
          {list(airtable)}
          {props.canManage ? (
            <IntegrationSetup
              title={
                airtable.length === 0
                  ? null
                  : "Connect another Airtable account"
              }
            >
              <ProviderConnectButton
                provider="airtable"
                label="Connect Airtable"
                onClick={props.actions.connectAirtable}
                busy={providerConnectionBusy(
                  props.mutations,
                  props.pendingAuthorization,
                  "airtable",
                )}
                feedback={props.feedback}
              />
            </IntegrationSetup>
          ) : null}
        </>
      ),
    },
    {
      id: "gmail",
      label: "Gmail",
      description: PROVIDER_PRESENTATION.gmail.description,
      tile: PROVIDER_PRESENTATION.gmail.tile,
      accounts: gmail,
      connected: gmail.some(integrationAccountIsConnected),
      panel: (
        <GmailIntegrationPanel
          accounts={gmail}
          selectedAccountId={props.initialAccountId ?? null}
          agentMailboxes={props.agentMailboxes}
          emailReplies={props.emailReplies}
          emailOperational={props.emailOperational}
          installations={props.mailboxInstallations}
          canManage={props.canManage}
          mutations={props.mutations}
          pendingAuthorization={props.pendingAuthorization}
          pendingConfirm={props.pendingConfirm}
          requestConfirm={props.requestConfirm}
          lastAttempt={providerAttemptDiagnostics(props.supportDiagnostics, [
            "gmail",
          ])}
          actions={props.actions}
          feedback={props.feedback}
        />
      ),
    },
    {
      id: "dropbox",
      label: PROVIDER_PRESENTATION.dropbox.label,
      description: PROVIDER_PRESENTATION.dropbox.description,
      tile: PROVIDER_PRESENTATION.dropbox.tile,
      accounts: dropbox,
      connected: dropbox.some(integrationAccountIsConnected),
      panel: (
        <FileStorageIntegrationPanel
          provider="dropbox"
          accounts={dropbox}
          accountList={list}
          canManage={props.canManage}
          mutations={props.mutations}
          pendingAuthorization={props.pendingAuthorization}
          lastAttempt={providerAttemptDiagnostics(props.supportDiagnostics, [
            "dropbox",
          ])}
          actions={props.actions}
          feedback={props.feedback}
        />
      ),
    },
    {
      id: "google_drive",
      label: PROVIDER_PRESENTATION.google_drive.label,
      description: PROVIDER_PRESENTATION.google_drive.description,
      tile: PROVIDER_PRESENTATION.google_drive.tile,
      accounts: googleDrive,
      connected: googleDrive.some(integrationAccountIsConnected),
      panel: (
        <FileStorageIntegrationPanel
          provider="google_drive"
          accounts={googleDrive}
          accountList={list}
          canManage={props.canManage}
          mutations={props.mutations}
          pendingAuthorization={props.pendingAuthorization}
          lastAttempt={providerAttemptDiagnostics(props.supportDiagnostics, [
            "google_drive",
          ])}
          actions={props.actions}
          feedback={props.feedback}
        />
      ),
    },
    {
      id: "whatsapp",
      label: PROVIDER_PRESENTATION.whatsapp.label,
      description: PROVIDER_PRESENTATION.whatsapp.description,
      tile: PROVIDER_PRESENTATION.whatsapp.tile,
      accounts: whatsapp,
      connected: whatsapp.some(integrationAccountIsConnected),
      status: whatsappIntegrationStatus(
        props.whatsappConfigurationKnown,
        whatsapp,
      ),
      panel: (
        <>
          <InstalledAgentsWhatsAppPanel
            surface={props.whatsapp}
            agents={props.mailboxInstallations}
            inferenceSelection={props.inferenceSelection}
            connectionAction={whatsappConnectionAction}
            lastAttempt={providerAttemptDiagnostics(props.supportDiagnostics, [
              "whatsapp",
            ])}
            canManage={props.canManage}
            actions={props.whatsappActions}
          />
        </>
      ),
    },
    {
      id: "notion",
      label: PROVIDER_PRESENTATION.notion.label,
      description: PROVIDER_PRESENTATION.notion.description,
      tile: PROVIDER_PRESENTATION.notion.tile,
      accounts: notion,
      connected: notion.some(integrationAccountIsConnected),
      panel: (
        <>
          {list(notion)}
          {props.canManage ? (
            <IntegrationSetup
              title={
                notion.length === 0 ? null : "Connect another Notion workspace"
              }
            >
              <ProviderConnectButton
                provider="notion"
                label="Connect Notion"
                onClick={props.actions.connectNotion}
                busy={providerConnectionBusy(
                  props.mutations,
                  props.pendingAuthorization,
                  "notion",
                )}
                feedback={props.feedback}
              />
            </IntegrationSetup>
          ) : null}
        </>
      ),
    },
  ];
}

function whatsappIntegrationStatus(
  configurationKnown: boolean | undefined,
  accounts: readonly IntegrationAccount[],
): IntegrationRailStatus | undefined {
  return configurationKnown === false && accounts.length === 0
    ? { kind: "attention", label: "Unable to check" }
    : undefined;
}
