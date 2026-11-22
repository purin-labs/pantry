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
  setWhatsAppProviderHealth,
} from "@purin-labs/area-inbox/server/data/whatsapp";
import { proposeEvalFromCorrection } from "@purin-labs/area-brain/server/evals/access";
import { commerceAccessTargets } from "@purin-labs/authority/access-control/commerce-access-targets";
import { actionLedgerCommerce } from "@purin-labs/authority/actors/action-ledger";
import { slackMayApproveAction } from "./commerce/action-model";
import { parseCommerceEntityPlaneEffect } from "./commerce/entity-plane/proposals";
import { commerceGrantSelection } from "@purin-labs/authority/authorization/access-grants/commerce-grant-selection";
import { COMMERCE_ACCESS_TARGETS } from "./commerce/entity-plane/access-targets";
import { RESPONSIBILITY_SCOPE_COMMERCE } from "./commerce/entity-plane/responsibility-scopes";
import { responsibilityScopeCommerce } from "@purin-labs/agent/data/agent-operations/scope-commerce";
import { commerceGrantTargets } from "@purin-labs/authority/authorization/access-grants/commerce-grant-targets";
import { COMMERCE_GRANT_TARGETS } from "./commerce/entity-plane/grant-targets";
import { connectedCommerceProviders } from "./commerce/contract/commerce-provider";
import { COMMERCE_GRANT_SELECTION } from "./commerce/entity-plane/grant-selection";
import { commerceGraphReads } from "./commerce/contract/graph-reads";
import { parseEntityPlaneObservation } from "@purin-labs/commerce-client";
import { entityPlaneObservationParser } from "@purin-labs/agent/cues/engine";
import { CommerceEngineSource } from "./commerce/entity-plane/commerce-source";
import { readCommerceExceptionInbox } from "./commerce/operations-workbench";
import { commerceExceptionInbox } from "@purin-labs/agent/control/agent-operation-activity";
import { onboardingProjection } from "@purin-labs/control/worker/admission/control-mutation";
import { buildOnboardingProjection } from "@purin-labs/area-organisation/server/data/onboarding-projection";
import {
  bakeryRunSnapshotPrefix,
  bakeryRunSnapshotSummary,
} from "./commerce/bakery/saved-runs";
import { bakeryRunSnapshots } from "@purin-labs/conversation/projects/references";
import {
  readNamedCommerceQuery,
  selectNamedCommerceQuerySourceGrant,
} from "./commerce/entity-plane/context-read";
import { createCommerceGraphReader } from "./commerce/entity-plane/selected-graph-reader";
import {
  commerceGraphControlAuthority,
  controlCommerceSensitivityCeiling,
  openControlCommerceGraph,
} from "./control/commerce-graph";
import { commerceDeliveryIntake } from "./commerce/contract/delivery-intake";
import { applyCommerceDelivery } from "./actors/commerce-projection";
import { normalizeCommerceDelivery } from "./commerce/commerce-wasm";
import { connectionParts } from "@purin-labs/area-integrations/server/contract/connection-parts";
import { providerModules } from "@purin-labs/area-integrations/server/contract/provider-modules";
import { providerServices } from "@purin-labs/area-integrations/server/contract/provider-services";
import { readProviderCleanupContext } from "@purin-labs/area-integrations/server/provider-adapters/catalogue";
import { reconcileProviderManifestObservations } from "@purin-labs/area-integrations/server/provider-lifecycle/observation";
import { shopifyCommerceProvider } from "./shopify/commerce-provider";
import { SHOPIFY_PROVIDER_MODULE } from "./shopify/provider-module";
import { tearDownAgentMailboxForRemoval } from "@purin-labs/area-inbox/server/mail-inbox/agent-mailbox-teardown";
import { verifiedContacts } from "@purin-labs/area-inbox/server/mail-inbox/contract/verified-contacts";
import {
  createTurnMemoryReader,
  proposeMemoryFromCorrection,
  readMemoryViews,
  readShownMemoryStanding,
} from "@purin-labs/area-brain/server/memory/access";
import { memoryService } from "@purin-labs/area-brain/server/memory/contract/memory-service";
import { CARD_ONLY_REPLY_INSTRUCTION } from "@purin-labs/tool-handlers/slack/card-only-reply";
import {
  readSlackConversationFact,
  slackConversationReachesOutside,
} from "./slack/conversation-facts";
import {
  heldEffectNoticeText,
  heldOutputNoticeText,
} from "./slack/held-output-notice";
import { releaseHeldOutputDecision } from "./slack/held-output-release";
import { slackDmSelection } from "@purin-labs/authority/slack/installation-store";
import { permissionRequestNoticeText } from "./slack/permission-request-notice";
import { releaseAgentPermissionDecision } from "./slack/permission-request-release";
import { slackSurfaceParts } from "@purin-labs/authority/slack/surface-parts";
import { shopMacDevices } from "@purin-labs/area-devices/server/contract/shop-mac-devices";
import { readShopMacDevices } from "./voice/mac-devices";
import { commerceApprovalCardTexts } from "./commerce/contract/approval-card-texts";
import {
  commerceActionCardText,
  commerceActionPortalUrl,
  commerceActionSummary,
  commerceCardSummary,
  commerceChangeSummary,
  commerceWaitingCardText,
} from "./slack/commerce-approval-card";
import { cafeServices } from "@purin-labs/area-cafe/server/contract/cafe-services";
import { readCounterSaleView } from "@purin-labs/area-cafe/server/counter-register";
import { readMenuScreenList } from "@purin-labs/area-cafe/server/control/routes/menu-boards";
import { readTerminalOperations } from "@purin-labs/area-cafe/server/data/terminal-operations-readback";
import { inboxServices } from "@purin-labs/area-inbox/server/mail-inbox/contract/inbox-services";
import { readGmailPilotBudget } from "@purin-labs/area-inbox/server/data/email-mailbox";
import { registerSupplierOperationalEmailContact } from "@purin-labs/area-inbox/server/data/email-operational";
import { organisationServices } from "@purin-labs/area-organisation/server/contract/organisation-services";
import { removeIntegrationAccount } from "@purin-labs/area-organisation/server/data/account-removal";
import {
  cancelOperatorConfigurationDraft,
  confirmOperatorConfigurationDraft,
  previewCode,
  readOperatorDraft,
} from "@purin-labs/area-organisation/server/data/operator-configuration-draft";
import { workflowChanges } from "./kitchen/contract/workflow-changes";
import { applyApprovedWorkflowChange } from "./commerce/bakery/workflow-proposals";
import { deviceCommands } from "@purin-labs/area-devices/server/contract/device-commands";
import { runDeviceCommand } from "@purin-labs/area-devices/server/commands";
import { connectionFlowParts } from "@purin-labs/connections/data/connection-flow-parts";
import { prepareCredentialRefReplacement } from "@purin-labs/authority/credential-vault/service";
import { prepareCommunicationDestinationAccount } from "@purin-labs/area-organisation/server/data/onboarding";
import {
  prepareProviderAttemptSupportReference,
  prepareResolveOpenSupportReferences,
} from "@purin-labs/area-organisation/server/contract/provider-support-references";
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
} from "./slack/organisation-routing";
import { chatSurfaces } from "@purin-labs/conversation/chat/surface-registry";
import { KITCHEN_CHAT_SURFACES } from "./chat/kitchen-observation";

memoryService.register({
  readMemoryViews: (...input) => readMemoryViews(...input),
  readShownMemoryStanding: (...input) => readShownMemoryStanding(...input),
  createTurnMemoryReader: (...input) => createTurnMemoryReader(...input),
  proposeMemoryFromCorrection: (...input) =>
    proposeMemoryFromCorrection(...input),
  proposeEvalFromCorrection: (...input) => proposeEvalFromCorrection(...input),
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
});

inboxServices.register({
  readGmailPilotBudget: (...input) => readGmailPilotBudget(...input),
  registerSupplierOperationalEmailContact: (...input) =>
    registerSupplierOperationalEmailContact(...input),
});

organisationServices.register({
  removeIntegrationAccount: (...input) => removeIntegrationAccount(...input),
  readOperatorDraft: (...input) => readOperatorDraft(...input),
  cancelOperatorConfigurationDraft: (...input) =>
    cancelOperatorConfigurationDraft(...input),
  confirmOperatorConfigurationDraft: (...input) =>
    confirmOperatorConfigurationDraft(...input),
  previewCode: (...input) => previewCode(...input),
});

workflowChanges.register({
  applyApprovedWorkflowChange: (...input) =>
    applyApprovedWorkflowChange(...input),
});

deviceCommands.register({
  runDeviceCommand: (...input) => runDeviceCommand(...input),
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
