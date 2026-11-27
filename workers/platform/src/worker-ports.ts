// The Worker registers each port of a lower module here, once, when its
// entry module loads (Refactor 17). A port reads its implementation at the
// call, so each part names its function when it runs.
import { listVerifiedContactEndpoints } from "@purin-labs/area-inbox/server/data/contact-verification";
import { provideOrganisationLifecycleParts } from "@purin-labs/tenancy/data/organisation-lifecycle-port";
import { ORGANISATION_LIFECYCLE_PARTS } from "./organisation-lifecycle-parts";
import {
  readEmailMailboxIdentityClaimant,
  registerEmailMailboxAccount,
} from "@purin-labs/area-inbox/server/data/email-mailbox";
import {
  readEmailSenderIdentityClaimant,
  registerEmailSenderAccount,
} from "@purin-labs/area-inbox/server/data/email-operational";
import {
  registerWhatsAppPhoneNumberAccount,
  routeWhatsAppWebhookAccount,
  setWhatsAppProviderHealth,
} from "@purin-labs/area-inbox/server/data/whatsapp";
import { proposeEvalFromCorrection } from "@purin-labs/area-brain/server/evals/access";
import { commerceAccessTargets } from "@purin-labs/authority/access-control/commerce-access-targets";
import { actionLedgerCommerce } from "@purin-labs/authority/actors/action-ledger";
import {
  parseCommerceActionPath,
  slackMayApproveAction,
} from "@purin-labs/area-commerce/server/action-model";
import { commerceActionApprovals } from "@purin-labs/area-commerce-contract/server/action-approvals";
import {
  acceptAndDeliverCommerceOutcome,
  executeCommerceAction,
} from "@purin-labs/area-commerce/server/actions";
import { syncCaseApprovalWait } from "@purin-labs/area-commerce/server/case-approval-sync";
import { supplierPayoutReads } from "@purin-labs/area-commerce-contract/server/supplier-payouts";
import {
  listSupplierPayoutsForSupplier,
  listUnresolvedSupplierPayouts,
} from "@purin-labs/area-commerce/server/data/supplier-payout-store";
import { supplierPayoutLabel } from "@purin-labs/area-commerce/server/payouts/supplier-payout-access";
import {
  failCommerceLabRun,
  listCommerceLabRuns,
} from "@purin-labs/area-commerce/server/commerce-lab/lab-metadata";
import { reconcileCommerceOutbox } from "@purin-labs/area-commerce/server/outbox-worker";
import { parseCommerceEntityPlaneEffect } from "@purin-labs/area-commerce/server/entity-plane/proposals";
import { commerceGrantSelection } from "@purin-labs/authority/authorization/access-grants/commerce-grant-selection";
import { COMMERCE_ACCESS_TARGETS } from "@purin-labs/area-commerce/server/entity-plane/access-targets";
import { RESPONSIBILITY_SCOPE_COMMERCE } from "@purin-labs/area-commerce/server/entity-plane/responsibility-scopes";
import { responsibilityScopeCommerce } from "@purin-labs/agent/data/agent-operations/scope-commerce";
import { commerceGrantTargets } from "@purin-labs/authority/authorization/access-grants/commerce-grant-targets";
import { COMMERCE_GRANT_TARGETS } from "@purin-labs/area-commerce/server/entity-plane/grant-targets";
import { connectedCommerceProviders } from "@purin-labs/area-commerce-contract/server/commerce-provider";
import { COMMERCE_GRANT_SELECTION } from "@purin-labs/area-commerce/server/entity-plane/grant-selection";
import { commerceGraphReads } from "@purin-labs/area-commerce-contract/server/graph-reads";
import { parseEntityPlaneObservation } from "@purin-labs/commerce-client";
import { entityPlaneObservationParser } from "@purin-labs/agent/cues/engine";
import { CommerceEngineSource } from "@purin-labs/area-commerce/server/entity-plane/commerce-source";
import { readCommerceExceptionInbox } from "@purin-labs/area-commerce/server/operations-workbench";
import { commerceExceptionInbox } from "@purin-labs/agent/control/agent-operation-activity";
import { onboardingProjection } from "@purin-labs/control/worker/admission/control-mutation";
import { buildOnboardingProjection } from "@purin-labs/area-organisation/server/data/onboarding-projection";
import {
  bakeryRunSnapshotPrefix,
  bakeryRunSnapshotSummary,
} from "@purin-labs/area-kitchen/server/bakery/saved-runs";
import { bakeryRunSnapshots } from "@purin-labs/conversation/projects/references";
import {
  readNamedCommerceQuery,
  selectNamedCommerceQuerySourceGrant,
} from "@purin-labs/area-commerce/server/entity-plane/context-read";
import { createCommerceGraphReader } from "@purin-labs/area-commerce/server/entity-plane/selected-graph-reader";
import {
  commerceGraphControlAuthority,
  controlCommerceSensitivityCeiling,
  openControlCommerceGraph,
} from "@purin-labs/area-commerce/server/control/commerce-graph";
import { commerceDeliveryIntake } from "@purin-labs/area-commerce-contract/server/delivery-intake";
import {
  applyCommerceDelivery,
  parseCanonicalCommerceDelivery,
  parseCommerceCueFacts,
} from "@purin-labs/area-commerce/server/actors/commerce-projection";
import { buildSavedSelectorCommerceReadAuthority } from "@purin-labs/area-commerce/server/entity-plane/authority";
import { normalizeCommerceDelivery } from "@purin-labs/area-commerce/server/commerce-wasm";
import { connectionParts } from "@purin-labs/area-integrations/server/contract/connection-parts";
import { providerModules } from "@purin-labs/area-integrations/server/contract/provider-modules";
import { providerServices } from "@purin-labs/area-integrations-contract/server/provider-services";
import { readProviderCleanupContext } from "@purin-labs/area-integrations/server/provider-adapters/catalogue";
import { reconcileProviderManifestObservations } from "@purin-labs/area-integrations/server/provider-lifecycle/observation";
import { shopifyCommerceProvider } from "@purin-labs/area-integrations/shopify/commerce-provider";
import { SHOPIFY_PROVIDER_MODULE } from "@purin-labs/area-integrations/shopify/provider-module";
import { tearDownAgentMailboxForRemoval } from "@purin-labs/area-inbox/server/mail-inbox/agent-mailbox-teardown";
import { verifiedContacts } from "@purin-labs/area-inbox-contract/server/verified-contacts";
import {
  createTurnMemoryReader,
  proposeMemoryFromCorrection,
  readMemoryViews,
  readShownMemoryStanding,
} from "@purin-labs/area-brain/server/memory/access";
import { memoryService } from "@purin-labs/area-brain-contract/server/memory/memory-service";
import { connectorEvalStore } from "@purin-labs/area-brain-contract/server/evals/connector-eval-store";
import {
  createConnectorEvalSchema,
  nextEvalWorkAt,
} from "@purin-labs/area-brain/server/actors/connector-eval";
import { CARD_ONLY_REPLY_INSTRUCTION } from "@purin-labs/surface-slack/server/card-only-reply";
import {
  readSlackConversationFact,
  slackConversationReachesOutside,
} from "@purin-labs/surface-slack/server/conversation-facts";
import {
  heldEffectNoticeText,
  heldOutputNoticeText,
} from "@purin-labs/surface-slack/server/held-output-notice";
import { releaseHeldOutputDecision } from "@purin-labs/surface-slack/server/held-output-release";
import { slackDmSelection } from "@purin-labs/authority/slack/installation-store";
import { permissionRequestNoticeText } from "@purin-labs/surface-slack/server/permission-request-notice";
import { releaseAgentPermissionDecision } from "@purin-labs/surface-slack/server/permission-request-release";
import { slackSurfaceParts } from "@purin-labs/authority/slack/surface-parts";
import { shopMacDevices } from "@purin-labs/area-devices/server/contract/shop-mac-devices";
import { readShopMacDevices } from "@purin-labs/surface-voice/server/mac-devices";
import { commerceApprovalCardTexts } from "@purin-labs/area-commerce/server/contract/approval-card-texts";
import {
  commerceActionCardText,
  commerceActionPortalUrl,
  commerceActionSummary,
  commerceCardSummary,
  commerceChangeSummary,
  commerceWaitingCardText,
} from "@purin-labs/surface-slack/server/commerce-approval-card";
import { cafeServices } from "@purin-labs/area-cafe-contract/server/cafe-services";
import { resolveCafeBuyer } from "@purin-labs/area-cafe/server/control/routes/menu-screens";
import { readCounterSaleView } from "@purin-labs/area-cafe/server/counter-register";
import { readMenuScreenList } from "@purin-labs/area-cafe/server/control/routes/menu-boards";
import { readTerminalOperations } from "@purin-labs/area-cafe/server/data/terminal-operations-readback";
import { inboxServices } from "@purin-labs/area-inbox-contract/server/inbox-services";
import {
  findEmailMailboxByAddress,
  readGmailPilotBudget,
} from "@purin-labs/area-inbox/server/data/email-mailbox";
import { channelIngress } from "@purin-labs/area-inbox-contract/server/channel-ingress";
import {
  whatsAppOperatorNoticeRecords,
  whatsAppOperatorNotices,
} from "@purin-labs/area-inbox-contract/server/whatsapp-operator-notices";
import {
  markWhatsAppNoticeDelivered,
  readWhatsAppOperatorNotice,
} from "@purin-labs/area-inbox/server/actors/connector-whatsapp";
import { readLatestEmailReviewProjectionForCase } from "@purin-labs/area-inbox/server/data/email-review";
import { deliverWhatsAppOperatorNotice } from "@purin-labs/surface-slack/server/actors/whatsapp-operator-notice";
import { registerSupplierOperationalEmailContact } from "@purin-labs/area-inbox/server/data/email-operational";
import { organisationServices } from "@purin-labs/area-organisation-contract/server/organisation-services";
import { removeIntegrationAccount } from "@purin-labs/area-organisation/server/data/account-removal";
import { readOrganisationOperationsDestination } from "@purin-labs/area-organisation/server/data/operations-destination";
import { operationsDestinationRead } from "@purin-labs/tenancy/data/operations-destination";
import { prepareEmailWatchReconciliationRun } from "@purin-labs/area-organisation/server/data/onboarding-reconciliation-run";
import {
  cancelOperatorConfigurationDraft,
  confirmOperatorConfigurationDraft,
  readLatestDecidedOperatorDraft,
  readOperatorDraft,
  readPendingOperatorDraft,
} from "@purin-labs/area-organisation/server/data/operator-configuration-draft";
import { previewCode } from "@purin-labs/area-organisation-contract/server/operator-drafts";
import { workflowChanges } from "@purin-labs/area-kitchen-contract/server/workflow-changes";
import {
  applyApprovedWorkflowChange,
  parseWorkflowChangeCommand,
} from "@purin-labs/area-kitchen/server/bakery/workflow-proposals";
import { deviceCommands } from "@purin-labs/area-devices-contract/server/device-commands";
import { runDeviceCommand } from "@purin-labs/area-devices/server/commands";
import { bakeParts } from "@purin-labs/area-kitchen/server/bakes/parts";
import {
  findActiveDeviceWithCapability,
  listDevices,
  listGateways,
} from "@purin-labs/area-devices/server/store";
import { readKitchenDeviceViews } from "@purin-labs/area-devices/server/views";
import {
  changeDeviceWork,
  reserveDeviceWork,
} from "@purin-labs/area-devices/server/work";
import {
  listCountedProducts,
  pieceCount,
  readInventoryItemStock,
} from "@purin-labs/area-commerce/server/actors/commerce-projection/stock-changes";
import { announceBakeProposal } from "@purin-labs/surface-slack/server/bake-proposal-announce";
import {
  announceBakeRun,
  tellBakeRunOverBake,
} from "@purin-labs/surface-slack/server/bake-run-announce";
import { bakeProposalRecords } from "@purin-labs/area-kitchen-contract/server/bake-proposals";
import {
  markBakeProposalAnnounced,
  readBakeProposal,
  readBakeProposalCardTs,
} from "@purin-labs/area-kitchen/server/bakes/records";
import { deviceReads } from "@purin-labs/area-devices-contract/server/device-reads";
import { connectionFlowParts } from "@purin-labs/connections/data/connection-flow-parts";
import { prepareCredentialRefReplacement } from "@purin-labs/authority/credential-vault/service";
import { prepareCommunicationDestinationAccount } from "@purin-labs/area-organisation/server/data/onboarding";
import {
  prepareProviderAttemptSupportReference,
  prepareResolveOpenSupportReferences,
} from "@purin-labs/area-organisation-contract/server/provider-support-references";
import { fileGrantParts } from "@purin-labs/authority/authorization/access-grants/file-grant-parts";
import {
  prepareChangedFileGrantSync,
  prepareNewFileGrantSync,
  prepareRevokedFileGrantCleanup,
  prepareRevokedFileGrantRows,
  supersedeUnadmittedFileProjectionsStatement,
} from "@purin-labs/agent/context/files/persistence";
import { validateFileGrantTarget } from "@purin-labs/agent/context/files/grant-validation";
import { nativeChatAudience } from "@purin-labs/agent/context/assembly/native-chat-audience";
import { resolveNativeChatAudience } from "@purin-labs/conversation/chat/information-flow";
import {
  prepareRevokedDmSelectionRelease,
  selectSlackDmOrganisation,
} from "@purin-labs/surface-slack/server/organisation-routing";
import { chatSurfaces } from "@purin-labs/conversation/chat/surface-registry";
import { KITCHEN_CHAT_SURFACES } from "@purin-labs/surface-portal/server/chat/kitchen-observation";
import {
  inboxSubjectReads,
  workflowSubjectReads,
} from "@purin-labs/authority/access-control/subject-reads";
import { INBOX_SUBJECT_READS } from "@purin-labs/area-inbox/server/data/authority-subject-reads";
import { WORKFLOW_SUBJECT_READS } from "@purin-labs/agent/data/workflow-subject-reads";
import { providerWorkReads } from "@purin-labs/actor-runtime/data/provider-work-reads";
import { PROVIDER_WORK_READS } from "@purin-labs/area-integrations/server/provider-lifecycle/provider-work";
import { integrationCredentialReads } from "@purin-labs/authority/credential-vault/integration-reads";
import { INTEGRATION_CREDENTIAL_READS } from "@purin-labs/area-integrations/server/data/vault-reads";
import { externalRecordsDiscovery } from "@purin-labs/connections/external-records/records";
import { discoverAirtableBases } from "@purin-labs/area-integrations/server/external-records/records";
import { organisationConnectionReads } from "@purin-labs/connections/data/organisation-reads";
import { ORGANISATION_CONNECTION_READS } from "@purin-labs/area-organisation/server/data/connection-reads";
import { agentInstallationPinReads } from "@purin-labs/control/worker/installation-pins";
import { AGENT_INSTALLATION_PIN_READS } from "@purin-labs/agent/data/installation-pin-reads";
import { slackIdentityLinks } from "@purin-labs/conversation/actors/action-mutation-execution";
import { SLACK_IDENTITY_LINKS } from "@purin-labs/surface-slack/server/data/identity-link-reads";
import { chatForkHistoryReads } from "@purin-labs/agent/chat/fork-history";
import { CHAT_FORK_HISTORY_READS } from "@purin-labs/conversation/chat/fork-history-reads";
import { organisationSlackChannels } from "@purin-labs/collaboration/worker/collaboration-slack-thread";
import { ORGANISATION_SLACK_CHANNELS } from "@purin-labs/area-organisation/server/data/slack-channel-reads";

memoryService.register({
  readMemoryViews: (...input) => readMemoryViews(...input),
  readShownMemoryStanding: (...input) => readShownMemoryStanding(...input),
  createTurnMemoryReader: (...input) => createTurnMemoryReader(...input),
  proposeMemoryFromCorrection: (...input) =>
    proposeMemoryFromCorrection(...input),
  proposeEvalFromCorrection: (...input) => proposeEvalFromCorrection(...input),
});

connectorEvalStore.register({
  createSchema: (sql) => createConnectorEvalSchema(sql),
  nextWorkAt: (sql) => nextEvalWorkAt(sql),
});

verifiedContacts.register({
  listVerifiedContactEndpoints: (...input) =>
    listVerifiedContactEndpoints(...input),
});

connectionParts.register({
  mailbox: {
    readEmailSenderIdentityClaimant: (...input) =>
      readEmailSenderIdentityClaimant(...input),
    readEmailMailboxIdentityClaimant: (...input) =>
      readEmailMailboxIdentityClaimant(...input),
    registerEmailSenderAccount: (...input) =>
      registerEmailSenderAccount(...input),
    registerEmailMailboxAccount: (...input) =>
      registerEmailMailboxAccount(...input),
    tearDownAgentMailboxForRemoval: (...input) =>
      tearDownAgentMailboxForRemoval(...input),
  },
  whatsapp: {
    registerWhatsAppPhoneNumberAccount: (...input) =>
      registerWhatsAppPhoneNumberAccount(...input),
    setWhatsAppProviderHealth: (...input) =>
      setWhatsAppProviderHealth(...input),
  },
});

slackDmSelection.register({
  prepareRevokedSelectionRelease: (...input) =>
    prepareRevokedDmSelectionRelease(...input),
  selectOrganisation: (...input) => selectSlackDmOrganisation(...input),
});

// The Shopify module: its commerce provider and its provider catalogue
// entry. A removal of Shopify deletes these two lines and the folder
// `shopify/`.
connectedCommerceProviders.register({ shopify: shopifyCommerceProvider });
providerModules.register({ shopify: SHOPIFY_PROVIDER_MODULE });

commerceDeliveryIntake.register({
  normalizeCommerceDelivery: (...input) => normalizeCommerceDelivery(...input),
  applyCommerceDelivery: (...input) => applyCommerceDelivery(...input),
  parseCanonicalCommerceDelivery: (raw) => parseCanonicalCommerceDelivery(raw),
  parseCommerceCueFacts: (raw) => parseCommerceCueFacts(raw),
  listCommerceLabRuns: (input) => listCommerceLabRuns(input),
  failCommerceLabRun: (input) => failCommerceLabRun(input),
  reconcileCommerceOutbox: (input) => reconcileCommerceOutbox(input),
});

commerceGrantSelection.register(COMMERCE_GRANT_SELECTION);
commerceGrantTargets.register(COMMERCE_GRANT_TARGETS);
commerceAccessTargets.register(COMMERCE_ACCESS_TARGETS);
responsibilityScopeCommerce.register(RESPONSIBILITY_SCOPE_COMMERCE);

commerceGraphReads.register({
  selectNamedCommerceQuerySourceGrant: (...input) =>
    selectNamedCommerceQuerySourceGrant(...input),
  readNamedCommerceQuery: (...input) => readNamedCommerceQuery(...input),
  createCommerceEngineSource: (options) => new CommerceEngineSource(options),
  createCommerceGraphReader: (...input) => createCommerceGraphReader(...input),
  openControlCommerceGraph: (...input) => openControlCommerceGraph(...input),
  commerceGraphControlAuthority: (...input) =>
    commerceGraphControlAuthority(...input),
  buildSavedSelectorCommerceReadAuthority: (input) =>
    buildSavedSelectorCommerceReadAuthority(input),
  controlCommerceSensitivityCeiling: (...input) =>
    controlCommerceSensitivityCeiling(...input),
});

commerceExceptionInbox.register((...input) =>
  readCommerceExceptionInbox(...input),
);

actionLedgerCommerce.register({
  parseEffect: (raw) => parseCommerceEntityPlaneEffect(raw),
  slackMayApprove: (action) => slackMayApproveAction(action),
});

commerceActionApprovals.register({
  parseActionPath: (action) => parseCommerceActionPath(action),
  syncCaseApprovalWait: (...input) => syncCaseApprovalWait(...input),
  executeCommerceAction: (input) => executeCommerceAction(input),
  acceptAndDeliverCommerceOutcome: (input) =>
    acceptAndDeliverCommerceOutcome(input),
});

supplierPayoutReads.register({
  supplierPayoutLabel: (input) => supplierPayoutLabel(input),
  listSupplierPayoutsForSupplier: (...input) =>
    listSupplierPayoutsForSupplier(...input),
  listUnresolvedSupplierPayouts: (...input) =>
    listUnresolvedSupplierPayouts(...input),
});

slackSurfaceParts.register({
  heldOutputNoticeText: (reason) => heldOutputNoticeText(reason),
  heldEffectNoticeText: (reason) => heldEffectNoticeText(reason),
  permissionRequestNoticeText: (...input) =>
    permissionRequestNoticeText(...input),
  cardOnlyReplyInstruction: CARD_ONLY_REPLY_INSTRUCTION,
  readConversationFact: (...input) => readSlackConversationFact(...input),
  conversationReachesOutside: (...input) =>
    slackConversationReachesOutside(...input),
  releaseAgentPermissionDecision: (...input) =>
    releaseAgentPermissionDecision(...input),
  releaseHeldOutputDecision: (...input) => releaseHeldOutputDecision(...input),
});

onboardingProjection.register((input) => buildOnboardingProjection(input));

bakeryRunSnapshots.register({
  prefix: (organisationId) => bakeryRunSnapshotPrefix(organisationId),
  summary: (prefix, object) => bakeryRunSnapshotSummary(prefix, object),
});

providerServices.register({
  reconcileProviderManifestObservations: (...input) =>
    reconcileProviderManifestObservations(...input),
  readProviderCleanupContext: (...input) =>
    readProviderCleanupContext(...input),
});

entityPlaneObservationParser.register((raw) =>
  parseEntityPlaneObservation(raw),
);

nativeChatAudience.register((db, accountAccess, authority, label) =>
  resolveNativeChatAudience(db, accountAccess, authority, label, {
    kind: "current",
  }),
);

fileGrantParts.register({
  prepareNewFileGrantSync: (...input) => prepareNewFileGrantSync(...input),
  prepareChangedFileGrantSync: (...input) =>
    prepareChangedFileGrantSync(...input),
  prepareRevokedFileGrantRows: (...input) =>
    prepareRevokedFileGrantRows(...input),
  prepareRevokedFileGrantCleanup: (...input) =>
    prepareRevokedFileGrantCleanup(...input),
  supersedeUnadmittedFileProjectionsStatement: (...input) =>
    supersedeUnadmittedFileProjectionsStatement(...input),
  validateFileGrantTarget: (...input) => validateFileGrantTarget(...input),
});

connectionFlowParts.register({
  prepareResolveOpenSupportReferences: (...input) =>
    prepareResolveOpenSupportReferences(...input),
  prepareProviderAttemptSupportReference: (...input) =>
    prepareProviderAttemptSupportReference(...input),
  prepareCommunicationDestinationAccount: (...input) =>
    prepareCommunicationDestinationAccount(...input),
  prepareCredentialRefReplacement: (...input) =>
    prepareCredentialRefReplacement(...input),
});

cafeServices.register({
  readMenuScreenList: (...input) => readMenuScreenList(...input),
  readTerminalOperations: (...input) => readTerminalOperations(...input),
  readCounterSaleView: (...input) => readCounterSaleView(...input),
  resolveCafeBuyer: (...input) => resolveCafeBuyer(...input),
});

inboxServices.register({
  readGmailPilotBudget: (...input) => readGmailPilotBudget(...input),
  registerSupplierOperationalEmailContact: (...input) =>
    registerSupplierOperationalEmailContact(...input),
  readLatestEmailReviewProjectionForCase: (input) =>
    readLatestEmailReviewProjectionForCase(input),
});

channelIngress.register({
  findEmailMailboxByAddress: (...input) => findEmailMailboxByAddress(...input),
  routeWhatsAppWebhookAccount: (...input) =>
    routeWhatsAppWebhookAccount(...input),
});

whatsAppOperatorNotices.register({
  deliver: (input) => deliverWhatsAppOperatorNotice(input),
});

whatsAppOperatorNoticeRecords.register({
  read: (...input) => readWhatsAppOperatorNotice(...input),
  markDelivered: (...input) => markWhatsAppNoticeDelivered(...input),
});

organisationServices.register({
  removeIntegrationAccount: (...input) => removeIntegrationAccount(...input),
  readOperatorDraft: (...input) => readOperatorDraft(...input),
  readPendingOperatorDraft: (input) => readPendingOperatorDraft(input),
  readLatestDecidedOperatorDraft: (input) =>
    readLatestDecidedOperatorDraft(input),
  cancelOperatorConfigurationDraft: (...input) =>
    cancelOperatorConfigurationDraft(...input),
  confirmOperatorConfigurationDraft: (...input) =>
    confirmOperatorConfigurationDraft(...input),
  previewCode: (...input) => previewCode(...input),
  prepareEmailWatchReconciliationRun: (...input) =>
    prepareEmailWatchReconciliationRun(...input),
});

operationsDestinationRead.register((...input) =>
  readOrganisationOperationsDestination(...input),
);

workflowChanges.register({
  applyApprovedWorkflowChange: (...input) =>
    applyApprovedWorkflowChange(...input),
  parseWorkflowChangeCommand: (raw) => parseWorkflowChangeCommand(raw),
});

bakeProposalRecords.register({
  readBakeProposal: (...input) => readBakeProposal(...input),
  readBakeProposalCardTs: (...input) => readBakeProposalCardTs(...input),
  markBakeProposalAnnounced: (...input) => markBakeProposalAnnounced(...input),
});

deviceCommands.register({
  runDeviceCommand: (...input) => runDeviceCommand(...input),
});

// A bake (Plan 24) reads the Devices records, the counter stock of the
// commerce projection, and posts its Slack cards.
bakeParts.register({
  devices: {
    listGateways: (...input) => listGateways(...input),
    listDevices: (...input) => listDevices(...input),
    readKitchenDeviceViews: (...input) => readKitchenDeviceViews(...input),
    findActiveDeviceWithCapability: (...input) =>
      findActiveDeviceWithCapability(...input),
    reserveDeviceWork: (...input) => reserveDeviceWork(...input),
    changeDeviceWork: (...input) => changeDeviceWork(...input),
  },
  counterStock: {
    readInventoryItemStock: (...input) => readInventoryItemStock(...input),
    listCountedProducts: (...input) => listCountedProducts(...input),
    pieceCount: (quantity) => pieceCount(quantity),
  },
  notices: {
    announceProposal: (...input) => announceBakeProposal(...input),
    announceRun: (...input) => announceBakeRun(...input),
    tellOverBake: (...input) => tellBakeRunOverBake(...input),
  },
});

deviceReads.register({
  listDevices: (...input) => listDevices(...input),
});

commerceApprovalCardTexts.register({
  portalUrl: (...input) => commerceActionPortalUrl(...input),
  changeSummary: (...input) => commerceChangeSummary(...input),
  actionSummary: (...input) => commerceActionSummary(...input),
  cardSummary: (...input) => commerceCardSummary(...input),
  waitingCardText: (...input) => commerceWaitingCardText(...input),
  actionCardText: (...input) => commerceActionCardText(...input),
});

shopMacDevices.register({
  readShopMacDevices: (...input) => readShopMacDevices(...input),
});

// The lifecycle batches of tenancy get the parts of the table owners.
provideOrganisationLifecycleParts(ORGANISATION_LIFECYCLE_PARTS);

// The page states that a chat message can carry (Plan 87): only the Kitchen
// page has one now.
chatSurfaces.register(KITCHEN_CHAT_SURFACES);

// The reads of the table owners that a lower module makes (Refactor 17):
// each owner gives the same SQL, so no request makes one more D1 query.
inboxSubjectReads.register(INBOX_SUBJECT_READS);
workflowSubjectReads.register(WORKFLOW_SUBJECT_READS);
integrationCredentialReads.register(INTEGRATION_CREDENTIAL_READS);
organisationConnectionReads.register(ORGANISATION_CONNECTION_READS);
agentInstallationPinReads.register(AGENT_INSTALLATION_PIN_READS);
slackIdentityLinks.register(SLACK_IDENTITY_LINKS);
chatForkHistoryReads.register(CHAT_FORK_HISTORY_READS);
organisationSlackChannels.register(ORGANISATION_SLACK_CHANNELS);
providerWorkReads.register(PROVIDER_WORK_READS);

// The access model of the control module lists the Airtable bases of an
// account through the external records client of the integrations area.
externalRecordsDiscovery.register({
  discoverAirtableBases: (...input) => discoverAirtableBases(...input),
});
