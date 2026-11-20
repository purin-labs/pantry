// The Worker registers each port of a lower module here, once, when its
// entry module loads (Refactor 17). A port reads its implementation at the
// call, so each part names its function when it runs.
import { listVerifiedContactEndpoints } from "./data/contact-verification";
import {
  readEmailMailboxIdentityClaimant,
  registerEmailMailboxAccount,
} from "./data/email-mailbox";
import {
  readEmailSenderIdentityClaimant,
  registerEmailSenderAccount,
} from "./data/email-operational";
import {
  registerWhatsAppPhoneNumberAccount,
  setWhatsAppProviderHealth,
} from "./data/whatsapp";
import { proposeEvalFromCorrection } from "./evals/access";
import { commerceAccessTargets } from "./access-control/commerce-access-targets";
import { actionLedgerCommerce } from "./actors/action-ledger";
import { slackMayApproveAction } from "./commerce/action-model";
import { parseCommerceEntityPlaneEffect } from "./commerce/entity-plane/proposals";
import { commerceGrantSelection } from "./authorization/access-grants/commerce-grant-selection";
import { COMMERCE_ACCESS_TARGETS } from "./commerce/entity-plane/access-targets";
import { RESPONSIBILITY_SCOPE_COMMERCE } from "./commerce/entity-plane/responsibility-scopes";
import { responsibilityScopeCommerce } from "./data/agent-operations/scope-commerce";
import { commerceGrantTargets } from "./authorization/access-grants/commerce-grant-targets";
import { COMMERCE_GRANT_TARGETS } from "./commerce/entity-plane/grant-targets";
import { connectedCommerceProviders } from "./commerce/contract/commerce-provider";
import { COMMERCE_GRANT_SELECTION } from "./commerce/entity-plane/grant-selection";
import { commerceGraphReads } from "./commerce/contract/graph-reads";
import { CommerceEngineSource } from "./commerce/entity-plane/commerce-source";
import { readCommerceExceptionInbox } from "./commerce/operations-workbench";
import { commerceExceptionInbox } from "./control/agent-operation-activity";
import { onboardingProjection } from "./control/admission/control-mutation";
import { buildOnboardingProjection } from "./data/onboarding-projection";
import {
  bakeryRunSnapshotPrefix,
  bakeryRunSnapshotSummary,
} from "./commerce/bakery/saved-runs";
import { bakeryRunSnapshots } from "./projects/references";
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
import { connectionParts } from "./integrations/contract/connection-parts";
import { providerModules } from "./integrations/contract/provider-modules";
import { providerServices } from "./integrations/contract/provider-services";
import { readProviderCleanupContext } from "./provider-adapters/catalogue";
import { reconcileProviderManifestObservations } from "./provider-lifecycle/observation";
import { shopifyCommerceProvider } from "./shopify/commerce-provider";
import { SHOPIFY_PROVIDER_MODULE } from "./shopify/provider-module";
import { tearDownAgentMailboxForRemoval } from "./mail-inbox/agent-mailbox-teardown";
import { verifiedContacts } from "./mail-inbox/contract/verified-contacts";
import {
  createTurnMemoryReader,
  proposeMemoryFromCorrection,
  readMemoryViews,
  readShownMemoryStanding,
} from "./memory/access";
import { memoryService } from "./memory/contract/memory-service";
import { CARD_ONLY_REPLY_INSTRUCTION } from "./slack/card-only-reply";
import {
  readSlackConversationFact,
  slackConversationReachesOutside,
} from "./slack/conversation-facts";
import {
  heldEffectNoticeText,
  heldOutputNoticeText,
} from "./slack/held-output-notice";
import { releaseHeldOutputDecision } from "./slack/held-output-release";
import { slackDmSelection } from "./slack/installation-store";
import { permissionRequestNoticeText } from "./slack/permission-request-notice";
import { releaseAgentPermissionDecision } from "./slack/permission-request-release";
import { slackSurfaceParts } from "./slack/surface-parts";
import {
  prepareRevokedDmSelectionRelease,
  selectSlackDmOrganisation,
} from "./slack/organisation-routing";

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
