import type {
  CapabilityDefinition,
  CapabilityProviderDependency,
} from "@seams/contracts";

export const CAPABILITY_KEYS = {
  airtableApiRead: "airtable.api.read",
  airtableApiWrite: "airtable.api.write",
  contextCaseRead: "context.case.read",
  caseContextCollectionMetadataRead:
    "context.case_context_collection_metadata.read",
  integrationDiscoveryRead: "integration.discovery.read",
  customConnectorDraft: "custom_connector.draft",
  customConnectorRead: "custom_connector.read",
  customConnectorWrite: "custom_connector.write",
  fileRead: "file.read",
  messageAttachmentInspect: "message.attachment.inspect",
  messageLinkRead: "message.link.read",
  emailMailboxRead: "email.mailbox.read",
  emailReplyPropose: "email.reply.propose",
  emailOperationalPropose: "email.operational.propose",
  slackMessagePropose: "slack.message.propose",
  whatsappSupportRead: "whatsapp.support.read",
  whatsappSupportReplySend: "whatsapp.support.reply.send",
  commerceEntityPlaneContext: "commerce.entity_plane.context",
  commerceEntityRead: "commerce.entity.read",
  commerceProductDescriptionDraftEdit:
    "commerce.product_description_draft.edit",
  marketingEmailDraftEdit: "marketing.email_draft.edit",
  commerceMenuDraftRead: "commerce.menu_draft.read",
  commerceMenuDraftEdit: "commerce.menu_draft.edit",
  commerceProductionPlanEdit: "commerce.production_plan.edit",
  commerceOrderQueueAdvance: "commerce.order_queue.advance",
  commerceSoldOutMark: "commerce.sold_out.mark",
  commerceRecipeSave: "commerce.recipe.save",
  commerceSupplyCostSave: "commerce.supply_cost.save",
  commerceSupplierCreate: "commerce.supplier.create",
  commerceWorkflowCanvasMove: "commerce.workflow_canvas.move",
  commerceActionPropose: "commerce.action.propose",
  commerceCatalogPublish: "commerce.catalog.publish",
  commerceCatalogUpdateDescription: "commerce.catalog.update_description",
  commerceOrderCancel: "commerce.order.cancel",
  commerceFulfillmentAttachTracking: "commerce.fulfillment.attach_tracking",
  commerceOfferAdjustPrice: "commerce.offer.adjust_price",
  commercePluginInstall: "commerce.plugin.install",
  commerceEntityPatch: "commerce.entity.patch",
  commerceRelationshipCreate: "commerce.relationship.create",
  commerceRelationshipDelete: "commerce.relationship.delete",
  commerceRelationshipReplace: "commerce.relationship.replace",
  commerceListEntryAdd: "commerce.list_entry.add",
  commerceListEntryPatch: "commerce.list_entry.patch",
  commerceListEntryRemove: "commerce.list_entry.remove",
  commerceSavedViewPublish: "commerce.saved_view.publish",
  commerceSupplierPayoutRead: "commerce.supplier_payout.read",
  commerceSupplierPayoutPropose: "commerce.supplier_payout.propose",
  commerceSupplierPayoutSubmit: "commerce.supplier_payout.submit",
  commerceSupplierDestinationPropose: "commerce.supplier_destination.propose",
  commerceSupplierDestinationActivate: "commerce.supplier_destination.activate",
  workspaceQuery: "workspace.query",
  workspaceProductFolderUpdate: "workspace.product_folder.update",
  stripeChargeCreate: "stripe.charge.create",
  stripeRefundCreate: "stripe.refund.create",
  stripeSubscriptionCancel: "stripe.subscription.cancel",
  stripePayoutCreate: "stripe.payout.create",
  stripeTransferCreate: "stripe.transfer.create",
  stripePaymentIntentCapture: "stripe.payment_intent.capture",
  stripePaymentIntentConfirm: "stripe.payment_intent.confirm",
  stripeSubscriptionUpdate: "stripe.subscription.update",
  shopifyOrderCancel: "shopify.order.cancel",
  voiceTranscription: "voice.transcription",
  deviceRead: "device.read",
  devicePause: "device.pause",
  recipeWorkflowRead: "commerce.recipe_workflow.read",
  recipeWorkflowPropose: "commerce.recipe_workflow.propose",
  deviceCameraRead: "device.camera.read",
  jevFeaturesRead: "jev.features.read",
  jevFeaturesManage: "jev.features.manage",
} as const;

export const WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE = "active_cases";
export const EMAIL_MAILBOX_RESOURCE_SCOPE = "mailbox";
export const EMAIL_OPERATIONAL_RESOURCE_SCOPE = "operational";
/** The connected channels of one Slack workspace, as one grant target. */
export const SLACK_MESSAGE_RESOURCE_SCOPE = "channel_message";

export type ActiveCapabilityId =
  (typeof CAPABILITY_KEYS)[keyof typeof CAPABILITY_KEYS];

type CapabilitySeed = Omit<
  CapabilityDefinition,
  "capabilityId" | "capabilityVersion"
>;

const NONE: CapabilityProviderDependency = { kind: "none" };
const COMMERCE_SYSTEMS: CapabilityProviderDependency = {
  kind: "commerce_system",
  systems: ["satyr_commerce", "shopify"],
};
const SHOPIFY: CapabilityProviderDependency = {
  kind: "provider",
  providers: ["shopify"],
};
/**
 * Commerce-owned commerce. Shopify has no equivalent command, so a
 * capability declaring this is unavailable on a Shopify-backed merchant
 * rather than silently mapping to something close.
 */
const SATYR_COMMERCE: CapabilityProviderDependency = {
  kind: "commerce_system",
  systems: ["satyr_commerce"],
};
const STRIPE: CapabilityProviderDependency = {
  kind: "provider",
  providers: ["stripe"],
};
const CONNECTED_FILES: CapabilityProviderDependency = {
  kind: "provider",
  providers: ["dropbox", "google_drive"],
};
const WHATSAPP: CapabilityProviderDependency = {
  kind: "provider",
  providers: ["whatsapp"],
};
const GMAIL: CapabilityProviderDependency = {
  kind: "provider",
  providers: ["gmail"],
};
const SLACK: CapabilityProviderDependency = {
  kind: "provider",
  providers: ["slack"],
};

const CAPABILITY_SEEDS = {
  [CAPABILITY_KEYS.customConnectorDraft]: {
    label: "Draft custom connectors",
    description:
      "Create or revise a bounded custom API connector draft for operator review.",
    category: "agent_operations",
    risk: "propose",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.customConnectorRead]: {
    label: "Read through custom connectors",
    description:
      "Run one approved read operation against an exact custom connector account and revision.",
    category: "customer_data",
    risk: "read",
    target: "custom_connector_operation",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.customConnectorWrite]: {
    label: "Write through custom connectors",
    description:
      "Propose one approved external record create or update through an exact custom connector account and revision.",
    category: "customer_data",
    risk: "external_effect",
    target: "custom_connector_operation",
    providerDependency: NONE,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.airtableApiRead]: {
    label: "Read Airtable bases",
    description:
      "Discover schema and read records throughout an explicitly granted Airtable base.",
    category: "customer_data",
    risk: "read",
    target: "provider_resource",
    providerDependency: { kind: "provider", providers: ["airtable"] },
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.airtableApiWrite]: {
    label: "Manage Airtable bases",
    description:
      "Create, update, and delete records and manage tables, fields, and other API resources throughout an explicitly granted base, including new tables.",
    category: "customer_data",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: { kind: "provider", providers: ["airtable"] },
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.contextCaseRead]: {
    label: "Read Case context",
    description:
      "View accepted Case context available to the current authority.",
    category: "context",
    risk: "read",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.caseContextCollectionMetadataRead]: {
    label: "Read context collection metadata",
    description:
      "View authorized related-Case references and relationship metadata without source content.",
    category: "context",
    risk: "read",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.integrationDiscoveryRead]: {
    label: "Discover connected integrations",
    description:
      "View bounded connection metadata and the data classes readable by the current authority.",
    category: "context",
    risk: "read",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.fileRead]: {
    label: "Read connected files",
    description:
      "Read approved files from an exact connected account and file or folder scope.",
    category: "customer_data",
    risk: "read",
    target: "file_resource",
    providerDependency: CONNECTED_FILES,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.messageAttachmentInspect]: {
    label: "Inspect a message attachment",
    description:
      "Read bounded text or technical metadata from a file attached to the current message, " +
      "after re-verifying its digest.",
    category: "customer_data",
    risk: "read",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.messageLinkRead]: {
    label: "Read a public link from a message",
    description:
      "Fetch a bounded, credential-free read of one public HTTP(S) link carried by the current " +
      "message. Private and metadata destinations are refused.",
    category: "external_data",
    risk: "read",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.emailMailboxRead]: {
    label: "Read a connected mailbox",
    description:
      "Search and read a bounded page of messages from an exact connected Gmail mailbox.",
    category: "customer_data",
    risk: "read",
    target: "provider_resource",
    providerDependency: GMAIL,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.emailReplyPropose]: {
    label: "Propose an email reply",
    description:
      "Create a visible Gmail reply draft for an exact message and queue it for human approval.",
    category: "customer_data",
    risk: "propose",
    target: "provider_resource",
    providerDependency: GMAIL,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.emailOperationalPropose]: {
    label: "Propose an operational email",
    description:
      "Prepare one plain-text email to an exact Customer or Supplier contact for human approval.",
    category: "customer_data",
    risk: "propose",
    target: "provider_resource",
    providerDependency: GMAIL,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.slackMessagePropose]: {
    label: "Draft a Slack message",
    description:
      "Prepare one plain-text message for a connected Slack channel. A person sends it from the chat card.",
    category: "customer_data",
    risk: "propose",
    target: "provider_resource",
    providerDependency: SLACK,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.whatsappSupportRead]: {
    label: "Read active WhatsApp support Cases",
    description:
      "Read bounded active WhatsApp support messages from an exact connected phone-number account.",
    category: "customer_data",
    risk: "read",
    target: "provider_resource",
    providerDependency: WHATSAPP,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.whatsappSupportReplySend]: {
    label: "Send WhatsApp support replies",
    description:
      "Send an exact requester-authorized reply to an active WhatsApp support Case.",
    category: "customer_data",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: WHATSAPP,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceEntityPlaneContext]: {
    label: "Read scoped commerce context",
    description: "Read the scoped commerce graph assembled for an agent.",
    category: "commerce",
    risk: "read",
    target: "platform",
    providerDependency: COMMERCE_SYSTEMS,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceEntityRead]: {
    label: "Read commerce records",
    description: "Read commerce records within an exact commerce-read scope.",
    category: "commerce",
    risk: "read",
    target: "commerce_read",
    providerDependency: COMMERCE_SYSTEMS,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceProductDescriptionDraftEdit]: {
    label: "Edit a product description draft",
    description: "Replace one exact passage in a product description draft.",
    category: "commerce",
    risk: "external_effect",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceMenuDraftRead]: {
    label: "Read the shared menu draft",
    description:
      "Read the current shared menu, its item positions and document revision, and the drafts of its screen boards.",
    category: "commerce",
    risk: "read",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceMenuDraftEdit]: {
    label: "Edit the shared menu draft",
    description:
      "Change the shared menu's title, sections and items, and the drafts of its screen boards. Publishing the menu or a board stays a separate action, and a price change needs an owner's approval.",
    category: "commerce",
    risk: "external_effect",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceOrderQueueAdvance]: {
    label: "Move orders through the shop's order queue",
    description:
      "Start an order, mark it ready and hand it over, as staff do on the order queue page. Only for a person who may do this on the page.",
    category: "commerce",
    risk: "external_effect",
    target: "platform",
    providerDependency: SATYR_COMMERCE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceSoldOutMark]: {
    label: "Mark menu items sold out today",
    description:
      "Mark a menu item sold out until the shop's next midnight, or clear the mark, as staff do on the order queue page. Only for a person who may do this on the page.",
    category: "commerce",
    risk: "external_effect",
    target: "platform",
    providerDependency: SATYR_COMMERCE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceRecipeSave]: {
    label: "Create and edit recipes",
    description:
      "Add a recipe, or save a new revision of one, as staff do on the Recipes page. Earlier production keeps its revision. Only for a person who may do this on the page.",
    category: "commerce",
    risk: "external_effect",
    target: "platform",
    providerDependency: SATYR_COMMERCE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceSupplyCostSave]: {
    label: "Save supplier pack prices and cost plan",
    description:
      "Save a stock item's supplier pack price, unit or 7-day bulk tier, or save fixed daily labor, rent and Mon-Sun product unit plans, as staff do on the Costs & margins page. It moves no stock, changes no menu prices and pays nothing. Only for a person who may do this on the page.",
    category: "commerce",
    risk: "external_effect",
    target: "platform",
    providerDependency: SATYR_COMMERCE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceSupplierCreate]: {
    label: "Add suppliers",
    description:
      "Add a supplier to the supplier directory, as staff do on the Suppliers page. It gives no bank details and pays nothing. Only for a person who may do this on the page.",
    category: "commerce",
    risk: "external_effect",
    target: "platform",
    providerDependency: SATYR_COMMERCE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.deviceRead]: {
    label: "Read shop devices",
    description:
      "Read the shop's gateways and kitchen devices: if each one can take the next task, its connection, its health and its current work. An agent can also propose a restriction or a resume, which a person confirms.",
    category: "commerce",
    risk: "read",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.recipeWorkflowRead]: {
    label: "Read recipe workflows",
    description:
      "Read a recipe's applied workflow in Kitchen: its steps, arrows, revision, the findings of its last run and the proposals that wait for a person.",
    category: "commerce",
    risk: "read",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.recipeWorkflowPropose]: {
    label: "Propose a recipe workflow change",
    description:
      "Store a proposed change to a recipe's workflow for an owner or administrator to approve. It changes nothing that a person or a run uses until they approve it.",
    category: "commerce",
    risk: "external_effect",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.devicePause]: {
    label: "Pause work on a shop device",
    description:
      "Stop new work on one kitchen device and ask its gateway to pause, as staff do on the Devices page. A person resumes it. Only for a person who may do this on the page.",
    category: "commerce",
    risk: "external_effect",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.deviceCameraRead]: {
    label: "See camera snapshots",
    description:
      "See when a shop camera took a still image. A person with this access sees the image on the Devices page. An agent reads only the time and the reason, and the image never reaches a model.",
    category: "commerce",
    risk: "read",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.jevFeaturesRead]: {
    label: "Read the Jev settings",
    description:
      "Read who pays for Jev, if its key works, each Jev switch and the mailboxes that Jev sorts, as on the Settings › Jev page.",
    category: "agent_operations",
    risk: "read",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.jevFeaturesManage]: {
    label: "Propose a change to a Jev switch",
    description:
      "Propose to turn a Jev switch on or off. An admin approves each change on a card, because a switch that is on sends new data to TypeSafe.",
    category: "agent_operations",
    risk: "propose",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceProductionPlanEdit]: {
    label: "Plan production in the shared plan",
    description:
      "Read a location's shared production plan and change the planned quantity of one production request. A person accepts the plan.",
    category: "commerce",
    risk: "external_effect",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceWorkflowCanvasMove]: {
    label: "Move a workflow canvas object",
    description:
      "Change one existing workflow object's shared position within the canvas bounds.",
    category: "commerce",
    risk: "external_effect",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.marketingEmailDraftEdit]: {
    label: "Edit the shared email draft",
    description:
      "Read and replace one exact passage in the organisation's shared email draft.",
    category: "customer_data",
    risk: "external_effect",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceActionPropose]: {
    label: "Propose governed commerce actions",
    description:
      "Prepare a governed commerce action without executing its effect.",
    category: "commerce",
    risk: "propose",
    target: "provider_resource",
    providerDependency: COMMERCE_SYSTEMS,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.commerceCatalogPublish]: {
    label: "Publish a catalogue listing",
    description:
      "Publish an approved catalogue listing to its selected sales channel.",
    category: "commerce",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: SHOPIFY,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceCatalogUpdateDescription]: {
    label: "Update a product description",
    description:
      "Apply one approved reviewed description to an exact Seams Checkout product.",
    category: "commerce",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: SATYR_COMMERCE,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceOrderCancel]: {
    label: "Cancel a customer order",
    description:
      "Cancel an approved customer order at its connected commerce provider.",
    category: "commerce",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: SHOPIFY,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceFulfillmentAttachTracking]: {
    label: "Attach fulfillment tracking",
    description: "Attach approved tracking details to a fulfillment.",
    category: "commerce",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: SHOPIFY,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceOfferAdjustPrice]: {
    label: "Change a listed price",
    description:
      "Change the price of one listed offer, within the movement the merchant allowed.",
    category: "commerce",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: SATYR_COMMERCE,
    // Money changes hands at this price, so it is never a standing permission:
    // an approval is required whenever the capability is on at all.
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.commercePluginInstall]: {
    label: "Install a merchant plugin",
    description:
      "Install a plugin that checks the merchant's checkouts with code and settings that an agent wrote.",
    category: "commerce",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: SATYR_COMMERCE,
    // The plugin runs code on every checkout, so each version needs an
    // approval whenever the capability is on at all.
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceEntityPatch]: {
    label: "Update a commerce record",
    description: "Update approved fields on an exact commerce record.",
    category: "commerce",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: SHOPIFY,
    policyModes: "enabled_approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceRelationshipCreate]: {
    label: "Create a commerce relationship",
    description:
      "Connect exact commerce records through an approved relationship.",
    category: "commerce",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: SHOPIFY,
    policyModes: "enabled_approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceRelationshipDelete]: {
    label: "Delete a commerce relationship",
    description:
      "Remove an approved relationship between exact commerce records.",
    category: "commerce",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: SHOPIFY,
    policyModes: "enabled_approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceRelationshipReplace]: {
    label: "Replace a commerce relationship endpoint",
    description:
      "Replace one endpoint of an exact commerce relationship in one governed mutation.",
    category: "commerce",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: SATYR_COMMERCE,
    policyModes: "enabled_approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceListEntryAdd]: {
    label: "Add a commerce-list entry",
    description: "Add an approved record to an exact commerce list.",
    category: "commerce",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: SHOPIFY,
    policyModes: "enabled_approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceListEntryPatch]: {
    label: "Update a commerce-list entry",
    description: "Update approved fields on an exact commerce-list entry.",
    category: "commerce",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: COMMERCE_SYSTEMS,
    policyModes: "enabled_approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceListEntryRemove]: {
    label: "Remove a commerce-list entry",
    description: "Remove an exact record from an approved commerce list.",
    category: "commerce",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: SHOPIFY,
    policyModes: "enabled_approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceSavedViewPublish]: {
    label: "Publish a saved commerce view",
    description:
      "Publish the current presentation of an exact saved commerce view.",
    category: "commerce",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: SHOPIFY,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.workspaceQuery]: {
    label: "Read the agent workspace",
    description:
      "Query the immutable workspace revision assigned to the agent turn.",
    category: "agent_operations",
    risk: "read",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.workspaceProductFolderUpdate]: {
    label: "Update a product workspace folder",
    description:
      "Apply an approved product-folder update to the agent workspace.",
    category: "agent_operations",
    risk: "external_effect",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
  [CAPABILITY_KEYS.stripeChargeCreate]: {
    label: "Create a Stripe charge",
    description:
      "Create an approved charge on the exact connected Stripe account.",
    category: "payments",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: STRIPE,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.stripeRefundCreate]: {
    label: "Create a Stripe refund",
    description: "Create an approved refund for an exact Stripe charge.",
    category: "payments",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: STRIPE,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.stripeSubscriptionCancel]: {
    label: "Cancel a Stripe subscription",
    description:
      "Cancel an approved subscription on the exact connected Stripe account.",
    category: "payments",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: STRIPE,
    policyModes: "approval_required_disabled",
  },
  /**
   * Supplier payouts are money leaving the merchant, not money arriving. They
   * are catalogued apart from customer payments because the blast radius
   * differs: a wrong customer refund returns money to the person who paid it,
   * while a wrong supplier transfer sends it to a third party under no
   * obligation to give it back.
   *
   * Only the Pantry-native four are here. Submitting a transfer at GMO Aozora or
   * Wise is a separate capability that cannot be catalogued until an adapter
   * exists to execute it — a capability nothing can carry out is a promise the
   * catalogue should not make.
   *
   * Payouts are Pantry's own records, not commerce graph records, so a payout
   * read grant names the capability alone and no record type.
   */
  [CAPABILITY_KEYS.commerceSupplierPayoutRead]: {
    label: "Read supplier payouts",
    description:
      "Read supplier payables, payouts, and their masked destinations.",
    category: "payments",
    risk: "read",
    target: "platform",
    providerDependency: SATYR_COMMERCE,
    policyModes: "enabled_disabled",
  },
  /**
   * Proposing is deliberately not executing. An agent may prepare a payout for
   * a person to approve; nothing here submits one.
   */
  [CAPABILITY_KEYS.commerceSupplierPayoutPropose]: {
    label: "Propose a supplier payout",
    description:
      "Prepare a supplier payout plan for approval without submitting it.",
    category: "payments",
    risk: "propose",
    target: "commerce_command",
    providerDependency: SATYR_COMMERCE,
    policyModes: "enabled_disabled",
  },
  /**
   * Causing an approved payout to be sent.
   *
   * Distinct from proposing one, because they are different acts: a proposal
   * asks a person to look at some economics, and this moves the money they
   * looked at. Approval-required and disabled by default.
   *
   * Pantry-native even though a provider ultimately carries it out — what this
   * authorizes is Pantry acting on an approval. The rail-specific execute
   * capabilities stay uncatalogued until adapters exist to perform them.
   */
  [CAPABILITY_KEYS.commerceSupplierPayoutSubmit]: {
    label: "Submit an approved supplier payout",
    description:
      "Send an approved supplier payout to its certified provider rail.",
    category: "payments",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: SATYR_COMMERCE,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.commerceSupplierDestinationPropose]: {
    label: "Propose supplier bank details",
    description:
      "Record proposed bank details for a supplier without activating them.",
    category: "payments",
    risk: "propose",
    target: "commerce_command",
    providerDependency: SATYR_COMMERCE,
    policyModes: "enabled_disabled",
  },
  /**
   * Activation is the moment a bank account becomes payable to. Approval-
   * required and disabled by default, because whoever proposed the details must
   * not be the one who puts them into force — the maker-checker separation the
   * schema enforces has to hold at the capability boundary too.
   */
  [CAPABILITY_KEYS.commerceSupplierDestinationActivate]: {
    label: "Activate supplier bank details",
    description:
      "Put proposed supplier bank details into force as the account payouts reach.",
    category: "payments",
    risk: "external_effect",
    target: "commerce_command",
    providerDependency: SATYR_COMMERCE,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.stripePayoutCreate]: {
    label: "Create a Stripe payout",
    description:
      "Create an approved payout from the exact connected Stripe account.",
    category: "payments",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: STRIPE,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.stripeTransferCreate]: {
    label: "Create a Stripe transfer",
    description:
      "Create an approved transfer to an exact connected account destination.",
    category: "payments",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: STRIPE,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.stripePaymentIntentCapture]: {
    label: "Capture a Stripe payment",
    description: "Capture an approved Stripe payment intent.",
    category: "payments",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: STRIPE,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.stripePaymentIntentConfirm]: {
    label: "Confirm a Stripe payment",
    description: "Confirm an approved Stripe payment intent.",
    category: "payments",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: STRIPE,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.stripeSubscriptionUpdate]: {
    label: "Update a Stripe subscription",
    description: "Apply an approved update to an exact Stripe subscription.",
    category: "payments",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: STRIPE,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.shopifyOrderCancel]: {
    label: "Cancel a Shopify order",
    description:
      "Cancel an approved order in the exact connected Shopify shop.",
    category: "commerce",
    risk: "external_effect",
    target: "provider_resource",
    providerDependency: SHOPIFY,
    policyModes: "approval_required_disabled",
  },
  [CAPABILITY_KEYS.voiceTranscription]: {
    label: "Transcribe spoken commands",
    description:
      "Turn a member's spoken command into chat text, on the shop's Mac or on Workers AI.",
    category: "agent_operations",
    risk: "read",
    target: "platform",
    providerDependency: NONE,
    policyModes: "enabled_disabled",
  },
} satisfies { readonly [K in ActiveCapabilityId]: CapabilitySeed };

export const CAPABILITY_CATALOGUE = compileCapabilityCatalogue(
  buildCapabilityDefinitions(),
);

export function compileCapabilityCatalogue(
  definitions: readonly CapabilityDefinition[],
): readonly CapabilityDefinition[] {
  const keys = new Set<string>();
  for (const definition of definitions) {
    validateDefinition(definition);
    const key = capabilityDefinitionKey(definition);
    if (keys.has(key)) {
      throw new Error(`Duplicate capability catalogue key: ${key}`);
    }
    keys.add(key);
  }
  return Object.freeze([...definitions]);
}

export function capabilityDefinitionById(
  capabilityId: ActiveCapabilityId,
): CapabilityDefinition {
  for (const definition of CAPABILITY_CATALOGUE) {
    if (definition.capabilityId === capabilityId) return definition;
  }
  throw new Error(`Capability definition is missing: ${capabilityId}`);
}

function buildCapabilityDefinitions(): CapabilityDefinition[] {
  const definitions: CapabilityDefinition[] = [];
  for (const capabilityId of Object.values(CAPABILITY_KEYS)) {
    definitions.push({
      capabilityId,
      capabilityVersion: 1,
      ...CAPABILITY_SEEDS[capabilityId],
    });
  }
  return definitions;
}

function capabilityDefinitionKey(definition: CapabilityDefinition): string {
  return `${definition.capabilityId}@${definition.capabilityVersion}`;
}

function validateDefinition(definition: CapabilityDefinition): void {
  if (
    !isNonEmptyText(definition.capabilityId) ||
    definition.capabilityVersion < 1
  ) {
    throw new Error("Capability catalogue identity is invalid.");
  }
  if (
    !isNonEmptyText(definition.label) ||
    !isNonEmptyText(definition.description)
  ) {
    throw new Error(
      `Capability presentation is missing: ${definition.capabilityId}`,
    );
  }
  if (
    definition.target === "platform" &&
    definition.providerDependency.kind !== "commerce_system"
  ) {
    if (definition.providerDependency.kind !== "none") {
      throw new Error(
        `Platform capability has a provider dependency: ${definition.capabilityId}`,
      );
    }
    return;
  }
  if (definition.target === "custom_connector_operation") {
    if (definition.providerDependency.kind !== "none") {
      throw new Error(
        `Custom connector capability has a provider dependency: ${definition.capabilityId}`,
      );
    }
    return;
  }
  if (
    definition.target === "commerce_read" ||
    ((definition.target === "platform" ||
      definition.target === "provider_resource" ||
      definition.target === "commerce_command") &&
      definition.providerDependency.kind === "commerce_system")
  ) {
    if (
      definition.providerDependency.kind !== "commerce_system" ||
      definition.providerDependency.systems.length === 0
    ) {
      throw new Error(
        `Commerce capability lacks a commerce-system dependency: ${definition.capabilityId}`,
      );
    }
    const systems = new Set(definition.providerDependency.systems);
    if (systems.size !== definition.providerDependency.systems.length) {
      throw new Error(
        `Capability repeats a commerce-system dependency: ${definition.capabilityId}`,
      );
    }
    return;
  }
  if (
    definition.providerDependency.kind !== "provider" ||
    definition.providerDependency.providers.length === 0
  ) {
    throw new Error(
      `Resource capability lacks a provider dependency: ${definition.capabilityId}`,
    );
  }
  const providers = new Set(definition.providerDependency.providers);
  if (providers.size !== definition.providerDependency.providers.length) {
    throw new Error(
      `Capability repeats a provider dependency: ${definition.capabilityId}`,
    );
  }
}

function isNonEmptyText(value: string): boolean {
  return value.trim().length > 0;
}
