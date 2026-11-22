import {
  handleClaudeConnectionRoute,
  matchClaudeConnectionRoute,
  type ClaudeConnectionRoute,
} from "@purin-labs/agent/control/routes/claude";
import {
  handleChatGoalRoute,
  matchChatGoalRoute,
  type ChatGoalRoute,
} from "@purin-labs/conversation/control/routes/chat-goal";
import { handleWorkflowCanvasRoute } from "./control/routes/workflow-canvas";
import {
  matchWorkflowCanvasRoute,
  type WorkflowCanvasRoute,
} from "./control/admission/workflow-canvas";
import {
  handleChatSharingRoute,
  matchChatSharingRoute,
  type ChatSharingRoute,
} from "@purin-labs/conversation/control/routes/chat-sharing";
import {
  handleProjectAccessRoute,
  matchProjectAccessRoute,
  type ProjectAccessRoute,
} from "@purin-labs/conversation/control/routes/project-access";
import {
  handleUserPreferencesRoute,
  matchUserPreferencesRoute,
  type UserPreferencesRoute,
} from "@purin-labs/area-organisation/server/control/routes/user-preferences";
import {
  handleMailAssistantRoute,
  matchMailAssistantRoute,
  type MailAssistantRoute,
} from "@purin-labs/area-inbox/server/control/routes/mail-assistant";
import {
  handleMailOrganizationRoute,
  matchMailOrganizationRoute,
  type MailOrganizationRoute,
} from "@purin-labs/area-inbox/server/control/routes/mail-organization";
import type { Env } from "@purin-labs/kernel/env";
import {
  handleProjectsRoute,
  matchProjectsRoute,
  type ProjectsRoute,
} from "@purin-labs/conversation/control/routes/projects";
import {
  handleChatDirectoryRoute,
  matchChatDirectoryRoute,
  type ChatDirectoryRoute,
} from "@purin-labs/conversation/control/routes/chat-directory";
import {
  handleMailInboxRoute,
  matchMailInboxRoute,
  type MailInboxRoute,
} from "@purin-labs/area-inbox/server/control/routes/mail-inbox";
import {
  handleInboxConversationsRoute,
  matchInboxConversationsRoute,
  type InboxConversationsRoute,
} from "@purin-labs/area-inbox/server/control/routes/inbox-conversations";
import {
  handleMailPersonReplyRoute,
  matchMailPersonReplyRoute,
  type MailPersonReplyRoute,
} from "@purin-labs/area-inbox/server/control/routes/mail-person-reply";
import { handleBakeryWorkflowRoute } from "./control/routes/bakery-workflows";
import {
  matchBakeryWorkflowRoute,
  type BakeryWorkflowRoute,
} from "./control/admission/bakery-workflows";
import {
  handleBakeryRunRoute,
  matchBakeryRunRoute,
  type BakeryRunRoute,
} from "./control/routes/bakery-runs";
import {
  handleBakeryRunArtifactRoute,
  matchBakeryRunArtifactRoute,
  type BakeryRunArtifactRoute,
} from "./control/routes/bakery-run-artifacts";
import {
  handleJevFeaturesRoute,
  matchJevFeaturesRoute,
  type JevFeaturesRoute,
} from "@purin-labs/area-integrations/server/control/routes/jev-features";
import {
  handleTypeSafeConnectionRoute,
  matchTypeSafeConnectionRoute,
  type TypeSafeConnectionRoute,
} from "@purin-labs/area-integrations/server/control/routes/typesafe";
import {
  handleCaseContextDiscoveryRoute,
  matchCaseContextDiscoveryRoute,
  type CaseContextDiscoveryRoute,
} from "@purin-labs/conversation/control/routes/case-context-discovery";
import { resolveCaseContextCollectionSelectionVerification } from "@purin-labs/area-inbox/server/case-context-discovery/source";
import { handleCaseScreenObservationsRoute } from "./control/routes/case-screen-observations";
import {
  handleMemoryRoute,
  matchMemoryRoute,
  type MemoryRoute,
} from "@purin-labs/area-brain/server/control/routes/memories";
import {
  handleVaultRoute,
  matchVaultRoute,
  type VaultRoute,
} from "@purin-labs/control/worker/routes/vault";
import {
  handleEvalRoute,
  matchEvalRoute,
  type EvalRoute,
} from "@purin-labs/area-brain/server/control/routes/evals";
import {
  handleBrainRoute,
  matchBrainRoute,
  type BrainRoute,
} from "@purin-labs/area-brain/server/control/routes/brain";
import {
  handleCaseExecutionRoute,
  matchCaseExecutionRoute,
  type CaseExecutionRoute,
} from "@purin-labs/area-brain/server/control/routes/case-execution";
import { handleProductDescriptionDraftRoute } from "@purin-labs/area-commerce/server/control/routes/product-description-draft";
import {
  matchProductDescriptionDraftRoute,
  type ProductDescriptionDraftRoute,
} from "@purin-labs/area-commerce/server/control/admission/product-description-draft";
import { handleMailReplyDraftRoute } from "@purin-labs/area-inbox/server/control/routes/mail-reply-draft";
import {
  matchMailReplyDraftRoute,
  type MailReplyDraftRoute,
} from "@purin-labs/area-inbox/server/control/admission/mail-reply-draft";
import { handleProductionPlanRoute } from "./control/routes/production-plan";
import {
  matchProductionPlanRoute,
  type ProductionPlanRoute,
} from "./control/admission/production-plan";
import { handleCostsSheetRoute } from "./control/routes/costs-sheet";
import {
  matchCostsSheetRoute,
  type CostsSheetRoute,
} from "./control/admission/costs-sheet";
import { handleEmailDraftRoute } from "@purin-labs/area-inbox/server/control/routes/email-draft";
import {
  matchEmailDraftRoute,
  type EmailDraftRoute,
} from "@purin-labs/area-inbox/server/control/admission/email-draft";
import {
  handleVoiceRoute,
  matchVoiceRoute,
  type VoiceRoute,
} from "./voice/routes";
import { handleMenuDraftRoute } from "@purin-labs/area-cafe/server/control/routes/menu-draft";
import {
  matchMenuDraftRoute,
  type MenuDraftRoute,
} from "@purin-labs/area-cafe/server/control/admission/menu-draft";
import {
  handleMenuBoardControlRoute,
  handleMenuBoardSocketRoute,
  matchMenuBoardControlRoute,
  type MenuBoardControlRoute,
} from "@purin-labs/area-cafe/server/control/routes/menu-boards";
import {
  matchMenuBoardSocketRoute,
  type MenuBoardSocketRoute,
} from "@purin-labs/area-cafe/server/control/admission/menu-boards";
import {
  handleDeviceControlRoute,
  matchDeviceControlRoute,
  type DeviceControlRoute,
} from "@purin-labs/area-devices/server/control/routes/devices";
import {
  handleBakeControlRoute,
  matchBakeControlRoute,
  type BakeControlRoute,
} from "./control/routes/bakes";
import { handleChatSignalRoute } from "@purin-labs/conversation/control/routes/chat-signals";
import {
  matchChatSignalRoute,
  type ChatSignalRoute,
} from "@purin-labs/conversation/control/admission/chat-signals";
import { controlError } from "@purin-labs/control/worker/http";
import {
  handleAccessControlRoute,
  matchAccessControlRoute,
  type AccessControlRoute,
} from "@purin-labs/control/worker/routes/access-control";
import {
  handleHeldOutputRequestRoute,
  matchHeldOutputRequestRoute,
  type HeldOutputRequestRoute,
} from "@purin-labs/conversation/control/routes/held-output-requests";
import {
  handleAgentPermissionRequestRoute,
  matchAgentPermissionRequestRoute,
  type AgentPermissionRequestRoute,
} from "@purin-labs/conversation/control/routes/agent-permission-requests";
import {
  handleAgentControlRoute,
  matchAgentControlRoute,
  type AgentControlRoute,
} from "./control/routes/agents";
import {
  handleCommerceControlRoute,
  matchCommerceControlRoute,
  type CommerceControlRoute,
} from "./control/routes/commerce";
import {
  handleIntegrationControlRoute,
  matchIntegrationControlRoute,
  type IntegrationControlRoute,
} from "@purin-labs/area-integrations/server/control/routes/integrations";
import {
  handleCustomConnectorControlRoute,
  matchCustomConnectorControlRoute,
  type CustomConnectorControlRoute,
} from "@purin-labs/area-integrations/server/control/routes/custom-connectors";
import {
  handlePortalChatControlRoute,
  matchPortalChatControlRoute,
  type PortalChatControlRoute,
} from "./control/routes/chat/router";
import {
  handleOnboardingControlRoute,
  matchOnboardingControlRoute,
  type OnboardingControlRoute,
} from "@purin-labs/area-organisation/server/control/routes/onboarding";
import {
  handleOperatorControlRoute,
  matchOperatorControlRoute,
  type OperatorControlRoute,
} from "@purin-labs/area-organisation/server/control/routes/operators";
import {
  handleSessionControlRoute,
  matchSessionControlRoute,
  type SessionControlRoute,
} from "@purin-labs/agent/control/routes/sessions";
import { resolveControlSupportRole } from "@purin-labs/area-organisation/server/data/onboarding-support";
import {
  handleWorkspaceControlRoute,
  matchWorkspaceControlRoute,
  type WorkspaceControlRoute,
} from "@purin-labs/area-organisation/server/control/routes/workspace";
import { assertNever } from "@purin-labs/std";
import { ACCESS_CONTROL_PARTS } from "./control/access-control-parts";
import {
  decidePendingDecisionWith,
  pendingDecisionSources,
} from "./control/pending-decision-parts";
import {
  handlePendingDecisionsRoute,
  matchPendingDecisionsRoute,
  type PendingDecisionsRoute,
} from "@purin-labs/control/worker/routes/pending-decisions";

type ControlRoute =
  | ChatGoalRoute
  | AgentPermissionRequestRoute
  | PendingDecisionsRoute
  | HeldOutputRequestRoute
  | ChatSharingRoute
  | UserPreferencesRoute
  | ProjectAccessRoute
  | ProjectsRoute
  | ChatDirectoryRoute
  | MailAssistantRoute
  | MailOrganizationRoute
  | MailInboxRoute
  | InboxConversationsRoute
  | MailPersonReplyRoute
  | BakeryRunRoute
  | BakeryWorkflowRoute
  | BakeryRunArtifactRoute
  | ClaudeConnectionRoute
  | TypeSafeConnectionRoute
  | JevFeaturesRoute
  | CaseContextDiscoveryRoute
  | MemoryRoute
  | VaultRoute
  | EvalRoute
  | BrainRoute
  | CaseExecutionRoute
  | ProductDescriptionDraftRoute
  | MailReplyDraftRoute
  | ProductionPlanRoute
  | CostsSheetRoute
  | EmailDraftRoute
  | MenuDraftRoute
  | VoiceRoute
  | MenuBoardControlRoute
  | (MenuBoardSocketRoute & Readonly<{ kind: "menuBoardSocket" }>)
  | DeviceControlRoute
  | BakeControlRoute
  | ChatSignalRoute
  | WorkflowCanvasRoute
  | AccessControlRoute
  | AgentControlRoute
  | CommerceControlRoute
  | IntegrationControlRoute
  | CustomConnectorControlRoute
  | PortalChatControlRoute
  | OnboardingControlRoute
  | OperatorControlRoute
  | SessionControlRoute
  | WorkspaceControlRoute
  | Readonly<{ kind: "notFound" }>;

export async function handleControlRequest(
  request: Request,
  env: Env,
  execution: ExecutionContext | null = null,
): Promise<Response> {
  const url = new URL(request.url);
  const route = matchControlRoute(url.pathname);

  switch (route.kind) {
    case "userPreferences":
      return handleUserPreferencesRoute(request, env, route);
    case "chatGoal":
      return handleChatGoalRoute(request, env, route);
    case "chatSharing":
      return handleChatSharingRoute(request, env, route);
    case "projectAccess":
      return handleProjectAccessRoute(request, env, route);
    case "projects":
      return handleProjectsRoute(request, env, route);
    case "chatDirectory":
      return handleChatDirectoryRoute(request, env, route);
    case "mailAssistant":
      return handleMailAssistantRoute(request, env, route);
    case "mailOrganization":
      return handleMailOrganizationRoute(request, env, route);
    case "mailInbox":
      return handleMailInboxRoute(request, env, route);
    case "inboxConversations":
      return handleInboxConversationsRoute(request, env, route);
    case "mailPersonReply":
      return handleMailPersonReplyRoute(request, env, route);
    case "bakeryRuns":
      return handleBakeryRunRoute(request, env, route);
    case "bakeryWorkflow":
      return handleBakeryWorkflowRoute(request, env, route);
    case "bakeryRunArtifacts":
      return handleBakeryRunArtifactRoute(request, env, route);
    case "claudeConnection":
      return handleClaudeConnectionRoute(request, env, route);
    case "typesafeConnection":
      return handleTypeSafeConnectionRoute(request, env, route);
    case "jevFeatures":
      return handleJevFeaturesRoute(request, env, route);
    case "caseContextCollections":
      return handleCaseContextDiscoveryRoute(request, env, route, {
        verifySelection: resolveCaseContextCollectionSelectionVerification,
        screenObservations: handleCaseScreenObservationsRoute,
      });
    case "memories":
      return handleMemoryRoute(request, env, route);
    case "vaultItems":
    case "vaultItemCommands":
    case "vaultStore":
    case "vaultEvents":
      return handleVaultRoute(request, env, route);
    case "evals":
      return handleEvalRoute(request, env, route);
    case "brain":
      return handleBrainRoute(request, env, route);
    case "case_execution":
      return handleCaseExecutionRoute(request, env, route);
    case "voice":
      return handleVoiceRoute(request, env, route);
    case "menuDraft":
      return handleMenuDraftRoute(request, env, route);
    case "menuBoards":
      return handleMenuBoardControlRoute(request, env, route);
    case "menuBoardSocket":
      return handleMenuBoardSocketRoute(request, env, route);
    case "devices":
      return handleDeviceControlRoute(request, env, route);
    case "bakes":
      return handleBakeControlRoute(request, env, route);
    case "chatSignals":
      return handleChatSignalRoute(request, env, route);
    case "workflowCanvas":
      return handleWorkflowCanvasRoute(request, env, route);
    case "emailDraft":
      return handleEmailDraftRoute(request, env, route);
    case "productDescriptionDraft":
      return handleProductDescriptionDraftRoute(request, env, route);
    case "mailReplyDraft":
      return handleMailReplyDraftRoute(request, env, route);
    case "productionPlan":
      return handleProductionPlanRoute(request, env, route);
    case "costsSheet":
      return handleCostsSheetRoute(request, env, route);
    case "agentPermissionRequest":
      return handleAgentPermissionRequestRoute(
        request,
        env,
        route,
        decidePendingDecisionWith(env),
      );
    case "pendingDecisions":
      return handlePendingDecisionsRoute(
        request,
        env,
        route,
        pendingDecisionSources(env),
      );
    case "heldOutputRequest":
      return handleHeldOutputRequestRoute(
        request,
        env,
        route,
        decidePendingDecisionWith(env),
      );
    case "accessControl":
    case "accessControlOptions":
    case "accessControlExplain":
    case "accessControlGrantCreate":
    case "accessControlGrantRevoke":
    case "accessControlCapabilityChange":
    case "accessControlDefaultsApply":
    case "accessControlBudget":
      return handleAccessControlRoute(
        request,
        env,
        route,
        url,
        ACCESS_CONTROL_PARTS,
      );
    case "googleStart":
    case "googleCallback":
    case "session":
    case "rotateSession":
    case "logout":
      return handleSessionControlRoute(request, env, route, url, {
        resolveSupportRole: resolveControlSupportRole,
      });
    case "organisations":
    case "organisation":
    case "members":
    case "member":
    case "invitations":
    case "acceptInvitation":
    case "revokeInvitation":
    case "setupCatalog":
    case "homeRegions":
      return handleOnboardingControlRoute(request, env, route);
    case "accounts":
    case "slackRouting":
    case "slackChannelDefault":
    case "slackDmSelection":
    case "disconnectSlackInstallation":
    case "credentialInventory":
    case "revokeAccountCredential":
    case "rotateAccountCredentialSupplied":
    case "disableAccount":
    case "reconnectAccount":
    case "rotateAccount":
    case "defaultAccount":
    case "accountResources":
    case "accountFileResources":
    case "accountDrivePickerConfig":
    case "refreshAccountResources":
    case "removeAccount":
      return handleIntegrationControlRoute(request, env, route, url);
    case "portalChat":
    case "portalChatCancel":
    case "portalChatConversation":
    case "portalChatDraft":
    case "portalChatPermission":
    case "portalChatRead":
    case "portalChatSlackMessage":
    case "portalChatConfigurationDraft":
    case "portalChatSideCase":
    case "portalChatScreenRelevance":
    case "portalChatStream":
    case "portalChatSurfaceEffects":
    case "portalChatSurfaceReceipt":
      return handlePortalChatControlRoute(request, env, route, execution);
    case "customConnectors":
    case "customConnector":
    case "customConnectorAction":
    case "customConnectorRevisions":
    case "customConnectorRevisionAction":
    case "customConnectorSetupAttempts":
    case "customConnectorSetupAttempt":
    case "customConnectorSetupAction":
    case "customConnectorWriteAction":
      return handleCustomConnectorControlRoute(
        request,
        env,
        route,
        decidePendingDecisionWith(env),
      );
    case "setup":
    case "stageViewed":
    case "readiness":
    case "activate":
    case "archive":
    case "restore":
      return handleOnboardingControlRoute(request, env, route);
    case "caseCommand":
    case "urkInstallation":
    case "campaignBriefQueue":
    case "campaignBrief":
    case "organisationInference":
    case "organisationSlackReasoningEffort":
    case "organisationCodex":
    case "organisationCodexAuthorizations":
    case "cancelOrganisationCodexAuthorization":
    case "completeOrganisationChatGptSignIn":
    case "reconnectOrganisationCodex":
    case "agentMailbox":
    case "agentMailboxSetup":
    case "agentMailboxCheck":
    case "agentMailboxSenderLinks":
    case "contactEndpointVerification":
    case "whatsappAccounts":
    case "whatsappAccount":
    case "whatsappReplyQueue":
    case "whatsappReply":
    case "whatsappCase":
    case "emailReply":
    case "emailReviewQueue":
    case "emailOperational":
    case "emailOperationalContacts":
      return handleAgentControlRoute(request, env, route);
    case "commerceActions":
    case "commerceActionApproval":
    case "commerceActionRejection":
    case "commerceActionExecution":
    case "commerceActionPluginPreview":
      return handleCommerceControlRoute(
        request,
        env,
        route,
        decidePendingDecisionWith(env),
      );
    case "agentOperations":
    case "agentOperationRevisions":
      return handleAgentControlRoute(request, env, route);
    case "commerceSystem":
    case "commerceCapabilities":
    case "commerceSystemSync":
    case "builtInCommerceDemo":
    case "commerceCueRefresh":
      return handleCommerceControlRoute(
        request,
        env,
        route,
        decidePendingDecisionWith(env),
      );
    case "home":
      return handleWorkspaceControlRoute(request, env, route);
    case "commercePublishedResources":
    case "checkoutProfiles":
    case "checkoutProfileRevision":
    case "checkoutProfileDraft":
    case "checkoutProfilePublication":
    case "checkoutProfileRetirement":
    case "checkoutProfileActivation":
    case "commerceExportPreset":
    case "commercePurchasing":
    case "commerceBakery":
    case "commerceGraph":
    case "commerceGraphChanges":
    case "commerceGraphActivity":
    case "commerceListEntryPatch":
    case "commerceSavedViewPresentationPatch":
    case "commerceBoardPresence":
    case "terminalOperations":
    case "terminalRetirement":
    case "counterPolicies":
    case "counterPolicy":
    case "commerceApiKeys":
    case "commerceApiKeyRevocation":
    case "commercePaymentAccounts":
    case "commerceStripeOnboarding":
    case "commerceMenuPublication":
    case "commerceShopName":
    case "counterRegister":
    case "counterSales":
    case "counterSale":
    case "counterSaleCash":
    case "counterSaleCollection":
    case "counterSaleCancel":
    case "counterSaleReconciliation":
    case "counterSaleHandoffResult":
    case "counterSalePickupReady":
    case "counterSaleHandover":
    case "counterSaleRefund":
    case "counterSaleManualCashRefund":
    case "counterReceipt":
    case "failedPayments":
    case "commercePayments":
    case "bankPayouts":
    case "orderTimes":
    case "orderQueue":
    case "orderQueueAdvance":
    case "soldOutItems":
    case "soldOutItem":
    case "terminalPairings":
    case "terminalPairing":
    case "terminalPairingActivation":
    case "terminalSquarePosApp":
    case "supplierPayouts":
    case "supplierPayout":
    case "supplierPayoutAudit":
    case "supplierDestinations":
    case "supplierDestinationActivation":
    case "commerceTrackingBatchPreview":
    case "commerceOfferPricePolicy":
    case "commercePricedOffers":
    case "recipes":
    case "costs":
    case "inventoryDeliveries":
    case "inventoryStockBalances":
    case "inventoryProduction":
    case "inventoryReceipt":
    case "productCatalog":
    case "productPhotos":
    case "libraryImage":
      return handleCommerceControlRoute(
        request,
        env,
        route,
        decidePendingDecisionWith(env),
      );
    case "merchantSupport":
    case "operatorOnboarding":
    case "operatorGmailPilotBudget":
    case "operatorVaultRootRotations":
    case "operatorVaultRootRotation":
    case "operatorVaultRootRotationAction":
    case "operatorReconcile":
    case "operatorAction":
    case "operatorHarnessHistory":
    case "operatorHarnessErasure":
      return handleOperatorControlRoute(request, env, route, url);
    case "providerStart":
    case "providerAttempt":
    case "cancelProviderAttempt":
    case "providerCallback":
      return handleIntegrationControlRoute(request, env, route, url);
    case "notFound":
      return controlError("not_found", 404);
    default:
      return assertNever(route);
  }
}

function matchControlRoute(pathname: string): ControlRoute {
  const preferences = matchUserPreferencesRoute(pathname);
  if (preferences !== null) return preferences;
  const projectAccessRoute = matchProjectAccessRoute(pathname);
  if (projectAccessRoute !== null) return projectAccessRoute;
  const chatGoalRoute = matchChatGoalRoute(pathname);
  if (chatGoalRoute !== null) return chatGoalRoute;
  const chatSharingRoute = matchChatSharingRoute(pathname);
  if (chatSharingRoute !== null) return chatSharingRoute;
  const projectsRoute = matchProjectsRoute(pathname);
  if (projectsRoute !== null) return projectsRoute;
  const chatDirectoryRoute = matchChatDirectoryRoute(pathname);
  if (chatDirectoryRoute !== null) return chatDirectoryRoute;
  const bakeryWorkflowRoute = matchBakeryWorkflowRoute(pathname);
  if (bakeryWorkflowRoute !== null) return bakeryWorkflowRoute;
  const bakeryRunRoute = matchBakeryRunRoute(pathname);
  if (bakeryRunRoute !== null) return bakeryRunRoute;
  const bakeryRunArtifactRoute = matchBakeryRunArtifactRoute(pathname);
  if (bakeryRunArtifactRoute !== null) return bakeryRunArtifactRoute;
  const claudeRoute = matchClaudeConnectionRoute(pathname);
  if (claudeRoute !== null) return claudeRoute;
  const typesafeRoute = matchTypeSafeConnectionRoute(pathname);
  if (typesafeRoute !== null) return typesafeRoute;
  const jevFeaturesRoute = matchJevFeaturesRoute(pathname);
  if (jevFeaturesRoute !== null) return jevFeaturesRoute;
  const caseContextDiscoveryRoute = matchCaseContextDiscoveryRoute(pathname);
  if (caseContextDiscoveryRoute !== null) return caseContextDiscoveryRoute;
  const memoryRoute = matchMemoryRoute(pathname);
  if (memoryRoute !== null) return memoryRoute;
  const vaultRoute = matchVaultRoute(pathname);
  if (vaultRoute !== null) return vaultRoute;
  const evalRoute = matchEvalRoute(pathname);
  if (evalRoute !== null) return evalRoute;
  const brainRoute = matchBrainRoute(pathname);
  if (brainRoute !== null) return brainRoute;
  const caseExecutionRoute = matchCaseExecutionRoute(pathname);
  if (caseExecutionRoute !== null) return caseExecutionRoute;
  const voiceRoute = matchVoiceRoute(pathname);
  if (voiceRoute !== null) return voiceRoute;
  const menuDraftRoute = matchMenuDraftRoute(pathname);
  if (menuDraftRoute !== null) return menuDraftRoute;
  const menuBoardSocketRoute = matchMenuBoardSocketRoute(pathname);
  if (menuBoardSocketRoute !== null)
    return { kind: "menuBoardSocket", ...menuBoardSocketRoute };
  const menuBoardRoute = matchMenuBoardControlRoute(pathname);
  if (menuBoardRoute !== null) return menuBoardRoute;
  const deviceRoute = matchDeviceControlRoute(pathname);
  if (deviceRoute !== null) return deviceRoute;
  const bakeRoute = matchBakeControlRoute(pathname);
  if (bakeRoute !== null) return bakeRoute;
  const chatSignalRoute = matchChatSignalRoute(pathname);
  if (chatSignalRoute !== null) return chatSignalRoute;
  const workflowCanvasRoute = matchWorkflowCanvasRoute(pathname);
  if (workflowCanvasRoute !== null) return workflowCanvasRoute;
  const emailDraftRoute = matchEmailDraftRoute(pathname);
  if (emailDraftRoute !== null) return emailDraftRoute;
  const descriptionDraftRoute = matchProductDescriptionDraftRoute(pathname);
  if (descriptionDraftRoute !== null) return descriptionDraftRoute;
  const mailReplyDraftRoute = matchMailReplyDraftRoute(pathname);
  if (mailReplyDraftRoute !== null) return mailReplyDraftRoute;
  const productionPlanRoute = matchProductionPlanRoute(pathname);
  if (productionPlanRoute !== null) return productionPlanRoute;
  const costsSheetRoute = matchCostsSheetRoute(pathname);
  if (costsSheetRoute !== null) return costsSheetRoute;
  const sessionRoute = matchSessionControlRoute(pathname);
  if (sessionRoute !== null) return sessionRoute;
  const operatorRoute = matchOperatorControlRoute(pathname);
  if (operatorRoute !== null) return operatorRoute;
  const heldOutputRoute = matchHeldOutputRequestRoute(pathname);
  if (heldOutputRoute !== null) return heldOutputRoute;
  const agentPermissionRoute = matchAgentPermissionRequestRoute(pathname);
  if (agentPermissionRoute !== null) return agentPermissionRoute;
  const pendingDecisionsRoute = matchPendingDecisionsRoute(pathname);
  if (pendingDecisionsRoute !== null) return pendingDecisionsRoute;
  const accessControlRoute = matchAccessControlRoute(pathname);
  if (accessControlRoute !== null) return accessControlRoute;
  const mailAssistantRoute = matchMailAssistantRoute(pathname);
  if (mailAssistantRoute !== null) return mailAssistantRoute;
  const mailOrganizationRoute = matchMailOrganizationRoute(pathname);
  if (mailOrganizationRoute !== null) return mailOrganizationRoute;
  const mailInboxRoute = matchMailInboxRoute(pathname);
  if (mailInboxRoute !== null) return mailInboxRoute;
  const inboxConversationsRoute = matchInboxConversationsRoute(pathname);
  if (inboxConversationsRoute !== null) return inboxConversationsRoute;
  const mailPersonReplyRoute = matchMailPersonReplyRoute(pathname);
  if (mailPersonReplyRoute !== null) return mailPersonReplyRoute;
  const agentRoute = matchAgentControlRoute(pathname);
  if (agentRoute !== null) return agentRoute;
  const integrationRoute = matchIntegrationControlRoute(pathname);
  if (integrationRoute !== null) return integrationRoute;
  const portalChatRoute = matchPortalChatControlRoute(pathname);
  if (portalChatRoute !== null) return portalChatRoute;
  const customConnectorRoute = matchCustomConnectorControlRoute(pathname);
  if (customConnectorRoute !== null) return customConnectorRoute;
  const commerceRoute = matchCommerceControlRoute(pathname);
  if (commerceRoute !== null) return commerceRoute;
  const workspaceRoute = matchWorkspaceControlRoute(pathname);
  if (workspaceRoute !== null) return workspaceRoute;
  const onboardingRoute = matchOnboardingControlRoute(pathname);
  if (onboardingRoute !== null) return onboardingRoute;
  return { kind: "notFound" };
}
