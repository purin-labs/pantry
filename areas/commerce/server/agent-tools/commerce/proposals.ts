import { type OrderRefundLineRequest } from "../../order-refund-action";
import type { StockProposalRequest } from "../../../../../services/platform/src/kitchen/contract/stock-action-plan";
import {
  parseCommerceActionRequest,
  type CommerceActionRequest,
} from "../../action-model";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import {
  parseMerchantPluginDraft,
  type MerchantPluginDraft,
} from "../../merchant-plugin-action";
import type {
  HarnessCampaignBriefRequest,
  HarnessConfigurationProposalRequest,
} from "./services";
import { jsonSchema } from "@purin-labs/agent-tools/define-tool";
import { defineCommerceTool } from "./services";
import type { CommerceActionProposalOrigin } from "@purin-labs/agent-tools/catalog/types";
import { ProposalArgumentError } from "@purin-labs/agent-tools/errors";

export type StockActionProposal = (
  request: StockProposalRequest,
  origin?: CommerceActionProposalOrigin,
) => Promise<unknown>;

export const campaignBriefProposal = defineCommerceTool({
  name: "commerce_propose_campaign_brief",
  description:
    "Draft one campaign brief for a person to review. This writes a draft and nothing else: " +
    "it sends no message, selects no audience, and spends no budget. Every target must name a " +
    "product, variant, or offer you read in this Case, at the revision you saw. " +
    "Call as tools.commerce_propose_campaign_brief({ request: { ... } }).",
  input: jsonSchema({
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          objective: { type: "string", minLength: 1, maxLength: 4000 },
          targets: {
            type: "array",
            maxItems: 25,
            items: {
              type: "object",
              properties: {
                entityType: {
                  type: "string",
                  enum: ["product", "sellable_variant", "offer"],
                },
                entityId: { type: "string", minLength: 1 },
                revision: { type: "integer", minimum: 1 },
              },
              required: ["entityType", "entityId", "revision"],
              additionalProperties: false,
            },
          },
          channel: { type: "string", minLength: 1, maxLength: 4000 },
          audienceDescription: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
          },
          messageVariants: {
            type: "array",
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                variantId: { type: "string", minLength: 1 },
                headline: { type: "string", minLength: 1, maxLength: 4000 },
                body: { type: "string", minLength: 1, maxLength: 4000 },
              },
              required: ["variantId", "headline", "body"],
              additionalProperties: false,
            },
          },
          requestedBudgetMinor: { type: "integer", minimum: 0 },
          currency: { type: "string", minLength: 3, maxLength: 3 },
          windowStart: { type: "string", minLength: 1 },
          windowEnd: { type: "string", minLength: 1 },
          disclosures: {
            type: "array",
            maxItems: 10,
            items: { type: "string", minLength: 1 },
          },
          supportingEvidence: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
          },
        },
        required: [
          "objective",
          "targets",
          "channel",
          "audienceDescription",
          "messageVariants",
          "requestedBudgetMinor",
          "currency",
          "windowStart",
          "windowEnd",
          "disclosures",
          "supportingEvidence",
        ],
        additionalProperties: false,
      },
    },
    required: ["request"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseCampaignBriefArgs([input]),
  effect: "proposal",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceActionPropose,
  },
  unavailable: "campaign brief proposal is unavailable",
  handler: ({ proposeCampaignBrief }) =>
    proposeCampaignBrief === undefined
      ? undefined
      : (request) => proposeCampaignBrief(request),
});

export const configurationProposal = defineCommerceTool({
  name: "configuration_propose",
  description:
    "Stage one setup change the operator asked for, so they can confirm it. " +
    "Use it only when the operator directly asked to change this workspace's setup. " +
    "It applies nothing: it writes a draft. In a Portal chat the person who asked confirms it on a card; in Slack they confirm it in their own words. " +
    "Pass the command exactly as the Portal would submit it. " +
    "For a price allowance, pass { kind: 'set_offer_price_allowance', offerId, expectedRevision, maxMovementBps } or { kind: 'withdraw_offer_price_allowance', offerId, expectedRevision }, with the canonical offer id. expectedRevision is the offer's price_policy_revision from commerce_entity_context, and is null or left out when no allowance exists. maxMovementBps is the band in basis points, up to 10000. " +
    "Call as tools.configuration_propose({ request: { command } }).",
  input: jsonSchema({
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          command: {
            type: "object",
            properties: { kind: { type: "string", minLength: 1 } },
            required: ["kind"],
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    required: ["request"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseConfigurationProposalArgs([input]),
  effect: "proposal",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceActionPropose,
  },
  unavailable: "configuration proposal is unavailable",
  handler: ({ proposeConfiguration }) =>
    proposeConfiguration === undefined
      ? undefined
      : (request) => proposeConfiguration(request),
});

export const commerceActionProposal = defineCommerceTool({
  name: "commerce_propose_action",
  description:
    "Propose one governed commerce action for the current Case. " +
    "This records a proposal and never writes to a provider. " +
    "Every resource you name must be one you read in this Case, at the revision you saw. " +
    "For adjust_offer_price, give offerId, expectedOfferRevision, expectedPolicyRevision, " +
    "proposedPriceMinor and currency. Set every other field to null, including reason and note: " +
    "productId, productRevision, variantId, variantRevision, offerRevision, salesChannelId, " +
    "salesChannelRevision, resourceId, expectedRevision, reason, refund, restock, notifyCustomer and note. " +
    "Read the offer with commerce_entity_context first: its revision is expectedOfferRevision, " +
    "and its price_policy_revision attribute is expectedPolicyRevision. " +
    "Propose a price from price_minimum to price_maximum only. " +
    "If the offer has no price_policy_revision, or price_policy is disabled, do not propose a price; " +
    "use configuration_propose to stage a price allowance for an owner or admin to confirm. " +
    "For update_product_description, give productId, productRevision and description: the full new text, from your latest product_description_draft_read when a draft exists. " +
    "For attach_tracking, give fulfillmentId, fulfillmentRevision, shipmentId, shipmentRevision and trackingNumber from commerce_entity_context. The shipment must already hold that tracking number from its label. " +
    "Set every field that the kind does not use to null. " +
    "Call as tools.commerce_propose_action({ request: { ... } }).",
  input: jsonSchema({
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "publish_catalog_listing",
              "cancel_order",
              "adjust_offer_price",
              "update_product_description",
              "attach_tracking",
            ],
          },
          productId: { type: ["string", "null"], minLength: 1 },
          productRevision: { type: ["integer", "null"], minimum: 1 },
          variantId: { type: ["string", "null"], minLength: 1 },
          variantRevision: { type: ["integer", "null"], minimum: 1 },
          offerId: { type: ["string", "null"], minLength: 1 },
          offerRevision: { type: ["integer", "null"], minimum: 1 },
          expectedOfferRevision: { type: ["integer", "null"], minimum: 1 },
          expectedPolicyRevision: { type: ["integer", "null"], minimum: 1 },
          proposedPriceMinor: { type: ["integer", "null"], minimum: 1 },
          currency: { type: ["string", "null"], minLength: 3, maxLength: 3 },
          salesChannelId: { type: ["string", "null"], minLength: 1 },
          salesChannelRevision: { type: ["integer", "null"], minimum: 1 },
          resourceId: { type: ["string", "null"], minLength: 1 },
          expectedRevision: { type: ["integer", "null"], minimum: 1 },
          reason: { type: ["string", "null"], minLength: 1, maxLength: 256 },
          refund: { type: ["string", "null"], enum: ["none", "full", null] },
          restock: { type: ["boolean", "null"] },
          notifyCustomer: { type: ["boolean", "null"] },
          note: { type: ["string", "null"], maxLength: 256 },
          description: { type: ["string", "null"], maxLength: 10000 },
          fulfillmentId: { type: ["string", "null"], minLength: 1 },
          fulfillmentRevision: { type: ["integer", "null"], minimum: 1 },
          shipmentId: { type: ["string", "null"], minLength: 1 },
          shipmentRevision: { type: ["integer", "null"], minimum: 1 },
          trackingNumber: { type: ["string", "null"], minLength: 1 },
        },
        required: [
          "kind",
          "productId",
          "productRevision",
          "variantId",
          "variantRevision",
          "offerId",
          "offerRevision",
          "expectedOfferRevision",
          "expectedPolicyRevision",
          "proposedPriceMinor",
          "currency",
          "salesChannelId",
          "salesChannelRevision",
          "resourceId",
          "expectedRevision",
          "reason",
          "refund",
          "restock",
          "notifyCustomer",
          "note",
          "description",
          "fulfillmentId",
          "fulfillmentRevision",
          "shipmentId",
          "shipmentRevision",
          "trackingNumber",
        ],
        additionalProperties: false,
      },
    },
    required: ["request"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseCommerceProposalArgs([input]),
  effect: "proposal",
  rerun: {
    kind: "script",
    reason:
      "A proposal has one identity for one assignment and one request, so a repeated call gets the first proposal.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceActionPropose,
  },
  unavailable: "commerce action proposal is unavailable",
  handler: ({ proposeCommerceAction }) =>
    proposeCommerceAction === undefined
      ? undefined
      : (request, call) =>
          proposeCommerceAction(request, { toolCallId: call.callId }),
});

export const menuPublicationProposal = defineCommerceTool({
  name: "commerce_propose_menu_publication",
  description:
    "Propose that the shared menu draft goes live on the shop's screens and order page. " +
    "Give documentRevision from your latest menu_draft_read or menu_draft_edit result. The revision must still be current. " +
    "Each item is checked against the shop's stock now, and the result names any item that the café cannot sell. " +
    "This records a proposal for approval and publishes nothing. An owner or admin approves the exact menu on its card, and later draft edits stay in the draft. " +
    "Never say that the menu is live before the approval.",
  input: jsonSchema({
    type: "object",
    properties: {
      documentRevision: { type: "integer", minimum: 1 },
    },
    required: ["documentRevision"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMenuPublicationProposalArgs([input]),
  effect: "proposal",
  rerun: {
    kind: "script",
    reason:
      "The request names the draft revision, so a rerun before the approval gets the first proposal.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceActionPropose,
  },
  unavailable: "menu publication proposal is unavailable",
  handler: ({ proposeCafeMenuPublication }) =>
    proposeCafeMenuPublication === undefined
      ? undefined
      : (request, call) =>
          proposeCafeMenuPublication(request, { toolCallId: call.callId }),
});

export const orderRefundProposal = defineCommerceTool({
  name: "commerce_propose_refund",
  description:
    "Propose a refund of a customer's order, for the whole order or for named lines. " +
    "Read the order with commerce_entity_context first. orderId and expectedRevision come from that read. " +
    "To refund the whole order, set refundLines to null. To refund part, name each line; amountMinor is the money back for that line, tax included, or null for the whole line. " +
    "reason is a short sentence that the approver reads. " +
    "This records a proposal for approval and moves no money. An owner or admin approves the exact amount on its card, with a step-up sign-in. " +
    "Never say that the money went back before the approval.",
  input: jsonSchema({
    type: "object",
    properties: {
      orderId: { type: "string", minLength: 1 },
      expectedRevision: { type: "integer", minimum: 1 },
      reason: { type: "string", minLength: 1, maxLength: 256 },
      refundLines: {
        type: ["array", "null"],
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            orderLineId: { type: "string", minLength: 1 },
            amountMinor: { type: ["integer", "null"], minimum: 1 },
          },
          required: ["orderLineId", "amountMinor"],
          additionalProperties: false,
        },
      },
    },
    required: ["orderId", "expectedRevision", "reason", "refundLines"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseOrderRefundProposalArgs([input]),
  effect: "proposal",
  rerun: {
    kind: "script",
    reason:
      "A proposal has one identity for one assignment and one request, so a repeated call gets the first proposal.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceActionPropose,
  },
  unavailable: "order refund proposal is unavailable",
  handler: ({ proposeOrderRefund }) =>
    proposeOrderRefund === undefined
      ? undefined
      : (request, call) =>
          proposeOrderRefund(request, { toolCallId: call.callId }),
});

export const stockActionProposal = defineCommerceTool({
  name: "commerce_propose_stock_action",
  description:
    "Propose one change to stock, a production request or a purchase request, with the person's words as the reason. " +
    "Read the record with commerce_entity_context first. For a stock position, read system type inventory_position. " +
    "For a list entry, use a selector with query { kind: 'commerce_list_page', listId, filter: { kind: 'all' }, sorts: [], pagination: { limit: 10, cursor: null } }; " +
    "listId is production_requests or replenishment_queue. expectedRevision is the revision that you read. " +
    "receive_stock records a delivery: give inventoryPositionId and quantity; lotCode and lotExpiresAt if the item tracks them; purchaseRequestEntryId if it answers a purchase request; receivedAt only if the person named a time. " +
    "count_stock records a physical count: give inventoryPositionId, quantity, and lotId if the item tracks lots. " +
    "adjust_stock changes stock by an amount: also give direction and adjustmentReason (correction, waste or damage; an increase is a correction only). " +
    "request_production asks the kitchen to make a finished good: give inventoryPositionId, quantity and neededBy; recipeId only if the person named one. " +
    "advance_production_request moves a request from requested to accepted, or from accepted to scheduled: give entryId and status. " +
    "update_purchase_request records a purchase: give entryId, owner and purchaseRequestId; expectedDeliveryAt and notes if known. " +
    "quantity is a decimal number in the item's base unit, as text. Times are ISO 8601. Set every field that the kind does not use to null. " +
    "This records a proposal for approval and changes nothing. An owner or admin approves the exact change on a card under Operations in the Portal. " +
    "Never say that the stock changed before the approval.",
  input: jsonSchema({
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "receive_stock",
              "count_stock",
              "adjust_stock",
              "request_production",
              "advance_production_request",
              "update_purchase_request",
            ],
          },
          reason: { type: "string", minLength: 1, maxLength: 256 },
          expectedRevision: { type: "integer", minimum: 1 },
          inventoryPositionId: { type: ["string", "null"], minLength: 1 },
          entryId: { type: ["string", "null"], minLength: 1 },
          quantity: { type: ["string", "null"], minLength: 1, maxLength: 32 },
          lotId: { type: ["string", "null"], minLength: 1 },
          lotCode: { type: ["string", "null"], minLength: 1, maxLength: 128 },
          lotExpiresAt: { type: ["string", "null"], minLength: 1 },
          receivedAt: { type: ["string", "null"], minLength: 1 },
          purchaseRequestEntryId: { type: ["string", "null"], minLength: 1 },
          direction: {
            type: ["string", "null"],
            enum: ["increase", "decrease", null],
          },
          adjustmentReason: {
            type: ["string", "null"],
            enum: ["correction", "waste", "damage", null],
          },
          recipeId: { type: ["string", "null"], minLength: 1 },
          neededBy: { type: ["string", "null"], minLength: 1 },
          status: {
            type: ["string", "null"],
            enum: ["accepted", "scheduled", null],
          },
          owner: { type: ["string", "null"], minLength: 1, maxLength: 256 },
          purchaseRequestId: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 256,
          },
          expectedDeliveryAt: { type: ["string", "null"], minLength: 1 },
          notes: { type: ["string", "null"], maxLength: 1000 },
        },
        required: [
          "kind",
          "reason",
          "expectedRevision",
          "inventoryPositionId",
          "entryId",
          "quantity",
          "lotId",
          "lotCode",
          "lotExpiresAt",
          "receivedAt",
          "purchaseRequestEntryId",
          "direction",
          "adjustmentReason",
          "recipeId",
          "neededBy",
          "status",
          "owner",
          "purchaseRequestId",
          "expectedDeliveryAt",
          "notes",
        ],
        additionalProperties: false,
      },
    },
    required: ["request"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseStockActionProposalArgs([input]),
  effect: "proposal",
  rerun: {
    kind: "script",
    reason:
      "A proposal has one identity for one assignment and one request, so a repeated call gets the first proposal.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceActionPropose,
  },
  unavailable: "stock action proposal is unavailable",
  handler: ({ proposeStockAction }) =>
    proposeStockAction === undefined
      ? undefined
      : (request, call) =>
          proposeStockAction(request, { toolCallId: call.callId }),
});

export const merchantPluginProposal = defineCommerceTool({
  name: "commerce_propose_plugin",
  description:
    "Propose a merchant plugin for one requirement of the merchant's shop: a checkout rule (notice for a whole cake, a limit per buyer), an event handler (store credit at every third order), or an action that staff run (a goodwill credit). " +
    "This records a proposal for approval and never installs anything. " +
    "Each part is JavaScript that defines run(input); input.settings holds the settings by key. It has no network, clock, random source or database, and a small instruction budget. " +
    "functionSource, or null: the checkout rule. It returns { refusals: [{ message }] }; an empty list lets the checkout through. input.checkout holds kind (pickup or shipping), quotedAt, readyBy (ISO times; null when unknown), currency, subtotalMinor, totalMinor and lines, each with variantId, productId, sku, title, quantity, unitPriceMinor and lineTotalMinor. With entityTypes, input.records holds each type's active records by type id: [{ entityId, displayName, values }]. With customer fields, input.checkout.customerFields holds the plugin's values on the signed-in buyer ({} for a guest), so a rule can sell an item to regulars only. " +
    "handlers: each runs once for each new event of its eventKinds (such as order.created or order.*) and reads input.event and input.order (id, lines, total, fulfillment, and buyer: { kind: identified, customerReference, placedOrders } or { kind: guest }). " +
    "actions: staff run each with typed inputs (integer, text, boolean, text_list, or order, which gives the order as for a handler) in input.input. " +
    "A handler or an action returns { refusals?, commands? } with at most five commands, applied all or none, each of a kind listed in commands: create_discount { key, title, code, percentOff or amountOff, usageLimit?, oncePerCustomer?, endsAt? }, set_plugin_field_values { entityType, entityId, values } (for a customer field, orderId in place of entityId; the function reads it as order.customerFields), or credit_store_credit { orderId, amountMinor, note? } for the order's customer. " +
    "entityTypes: up to 8 record types that staff fill in (such as closure days and pickup notices), each with a different typeId and up to 20 attributes of kind short_text, integer, boolean, date or timestamp; an empty list adds none. " +
    "fields: up to 20 values that the plugin keeps on a product, a sellable_variant or a customer (such as a regular buyer mark or a visit count), each entityType and key once; a customer field is an integer or a boolean only, never text about a person. A handler or an action sets them with set_plugin_field_values; an empty list keeps the plugin's earlier fields. " +
    "Put values the merchant may change, such as variant IDs, hours or amounts, in settings rather than in the code. " +
    "Use the same pluginId to propose a new version of a plugin; each version replaces the earlier handlers and actions. With a checkout rule, the result counts the recent checkouts that it would refuse. " +
    "Call as tools.commerce_propose_plugin({ request: { ... } }).",
  input: jsonSchema({
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          pluginId: {
            type: "string",
            description:
              "Lower-case letters, digits and underscores, starting with a letter.",
          },
          title: { type: "string", description: "At most 80 characters." },
          purpose: {
            type: "string",
            description:
              "One sentence for the approval card, at most 280 characters.",
          },
          settings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                valueKind: {
                  type: "string",
                  enum: ["integer", "text", "boolean", "text_list"],
                },
                description: { type: "string" },
                value: {
                  anyOf: [
                    { type: "integer" },
                    { type: "string" },
                    { type: "boolean" },
                    { type: "array", items: { type: "string" } },
                  ],
                },
              },
              required: ["key", "valueKind", "description", "value"],
              additionalProperties: false,
            },
          },
          functionSource: { type: ["string", "null"] },
          commands: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "create_discount",
                "set_plugin_field_values",
                "credit_store_credit",
              ],
            },
          },
          handlers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                handlerId: { type: "string" },
                eventKinds: { type: "array", items: { type: "string" } },
                source: { type: "string" },
              },
              required: ["handlerId", "eventKinds", "source"],
              additionalProperties: false,
            },
          },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                actionId: { type: "string" },
                title: { type: "string" },
                inputs: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      valueKind: {
                        type: "string",
                        enum: [
                          "integer",
                          "text",
                          "boolean",
                          "text_list",
                          "order",
                        ],
                      },
                      description: { type: "string" },
                    },
                    required: ["key", "valueKind", "description"],
                    additionalProperties: false,
                  },
                },
                source: { type: "string" },
              },
              required: ["actionId", "title", "inputs", "source"],
              additionalProperties: false,
            },
          },
          entityTypes: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                typeId: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
                attributes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      label: { type: "string" },
                      valueKind: {
                        type: "string",
                        enum: [
                          "short_text",
                          "integer",
                          "boolean",
                          "date",
                          "timestamp",
                        ],
                      },
                      required: { type: "boolean" },
                    },
                    required: ["key", "label", "valueKind", "required"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["typeId", "label", "description", "attributes"],
              additionalProperties: false,
            },
          },
          fields: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                entityType: {
                  type: "string",
                  enum: ["product", "sellable_variant", "customer"],
                },
                key: { type: "string" },
                valueKind: {
                  type: "string",
                  enum: ["integer", "text", "boolean", "text_list"],
                },
                description: { type: "string" },
              },
              required: ["entityType", "key", "valueKind", "description"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "pluginId",
          "title",
          "purpose",
          "settings",
          "functionSource",
          "commands",
          "handlers",
          "actions",
          "entityTypes",
          "fields",
        ],
        additionalProperties: false,
      },
    },
    required: ["request"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMerchantPluginProposalArgs([input]),
  effect: "proposal",
  rerun: {
    kind: "script",
    reason:
      "The plugin request names the version and revision it read, so a rerun before the approval gets the first proposal.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceActionPropose,
  },
  unavailable: "merchant plugin proposal is unavailable",
  handler: ({ proposeMerchantPlugin }) =>
    proposeMerchantPlugin === undefined
      ? undefined
      : (request, call) =>
          proposeMerchantPlugin(request, { toolCallId: call.callId }),
});

function parseMenuPublicationProposalArgs(
  args: readonly unknown[],
): Readonly<{ documentRevision: number }> {
  const raw = args[0];
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    !hasExactKeys(raw, ["documentRevision"]) ||
    typeof raw.documentRevision !== "number" ||
    !Number.isSafeInteger(raw.documentRevision) ||
    raw.documentRevision < 1
  ) {
    throw new TypeError(
      "commerce_propose_menu_publication arguments are invalid",
    );
  }
  return { documentRevision: raw.documentRevision };
}

const STOCK_ACTION_KINDS: readonly StockProposalRequest["kind"][] = [
  "receive_stock",
  "count_stock",
  "adjust_stock",
  "request_production",
  "advance_production_request",
  "update_purchase_request",
];

const STOCK_ACTION_TEXT_FIELDS = [
  "inventoryPositionId",
  "entryId",
  "quantity",
  "lotId",
  "lotCode",
  "lotExpiresAt",
  "receivedAt",
  "purchaseRequestEntryId",
  "recipeId",
  "neededBy",
  "owner",
  "purchaseRequestId",
  "expectedDeliveryAt",
  "notes",
] as const;

function parseStockActionProposalArgs(
  args: readonly unknown[],
): StockProposalRequest {
  const raw = args[0];
  const invalid = () =>
    new TypeError("commerce_propose_stock_action arguments are invalid");
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    !isRecord(raw.request) ||
    !hasExactKeys(raw, ["request"])
  ) {
    throw invalid();
  }
  const request = raw.request;
  if (
    !hasExactKeys(request, [
      "kind",
      "reason",
      "expectedRevision",
      "direction",
      "adjustmentReason",
      "status",
      ...STOCK_ACTION_TEXT_FIELDS,
    ]) ||
    !STOCK_ACTION_KINDS.includes(
      request.kind as StockProposalRequest["kind"],
    ) ||
    typeof request.reason !== "string" ||
    request.reason.trim().length === 0 ||
    request.reason.length > 256 ||
    typeof request.expectedRevision !== "number" ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 1 ||
    (request.direction !== null &&
      request.direction !== "increase" &&
      request.direction !== "decrease") ||
    (request.adjustmentReason !== null &&
      request.adjustmentReason !== "correction" &&
      request.adjustmentReason !== "waste" &&
      request.adjustmentReason !== "damage") ||
    (request.status !== null &&
      request.status !== "accepted" &&
      request.status !== "scheduled") ||
    STOCK_ACTION_TEXT_FIELDS.some(
      (field) => request[field] !== null && typeof request[field] !== "string",
    )
  ) {
    throw invalid();
  }
  return request as unknown as StockProposalRequest;
}

function parseOrderRefundProposalArgs(args: readonly unknown[]) {
  const raw = args[0];
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "orderId",
      "expectedRevision",
      "reason",
      "refundLines",
    ]) ||
    typeof raw.orderId !== "string" ||
    raw.orderId.length === 0 ||
    typeof raw.expectedRevision !== "number" ||
    !Number.isSafeInteger(raw.expectedRevision) ||
    raw.expectedRevision < 1 ||
    typeof raw.reason !== "string" ||
    raw.reason.trim().length === 0 ||
    raw.reason.length > 256
  ) {
    throw new TypeError("commerce_propose_refund arguments are invalid");
  }
  if (raw.refundLines === null) {
    return {
      orderId: raw.orderId,
      expectedRevision: raw.expectedRevision,
      reason: raw.reason,
      refundLines: null,
    };
  }
  if (
    !Array.isArray(raw.refundLines) ||
    raw.refundLines.length === 0 ||
    raw.refundLines.length > 100
  ) {
    throw new TypeError("commerce_propose_refund arguments are invalid");
  }
  const refundLines: OrderRefundLineRequest[] = [];
  for (const line of raw.refundLines as unknown[]) {
    if (
      !isRecord(line) ||
      !hasExactKeys(line, ["orderLineId", "amountMinor"]) ||
      typeof line.orderLineId !== "string" ||
      line.orderLineId.length === 0 ||
      (line.amountMinor !== null &&
        (typeof line.amountMinor !== "number" ||
          !Number.isSafeInteger(line.amountMinor) ||
          line.amountMinor < 1))
    ) {
      throw new TypeError("commerce_propose_refund arguments are invalid");
    }
    refundLines.push({
      orderLineId: line.orderLineId,
      amountMinor: line.amountMinor as number | null,
    });
  }
  return {
    orderId: raw.orderId,
    expectedRevision: raw.expectedRevision,
    reason: raw.reason,
    refundLines,
  };
}

function parseCampaignBriefArgs(
  args: readonly unknown[],
): HarnessCampaignBriefRequest {
  const request = singleRequestArgument(
    args,
    "commerce_propose_campaign_brief",
  );
  if (
    !hasExactKeys(request, [
      "objective",
      "targets",
      "channel",
      "audienceDescription",
      "messageVariants",
      "requestedBudgetMinor",
      "currency",
      "windowStart",
      "windowEnd",
      "disclosures",
      "supportingEvidence",
    ])
  ) {
    throw new TypeError(
      "commerce_propose_campaign_brief arguments are invalid",
    );
  }
  const targets = parseBriefTargets(request.targets);
  const messageVariants = parseBriefVariants(request.messageVariants);
  const disclosures = parseBoundedStrings(request.disclosures, 10);
  if (
    !isBoundedText(request.objective) ||
    !isBoundedText(request.channel) ||
    !isBoundedText(request.audienceDescription) ||
    !isBoundedText(request.supportingEvidence) ||
    typeof request.requestedBudgetMinor !== "number" ||
    !Number.isSafeInteger(request.requestedBudgetMinor) ||
    request.requestedBudgetMinor < 0 ||
    typeof request.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(request.currency) ||
    typeof request.windowStart !== "string" ||
    typeof request.windowEnd !== "string" ||
    targets === null ||
    messageVariants === null ||
    disclosures === null
  ) {
    throw new TypeError(
      "commerce_propose_campaign_brief arguments are invalid",
    );
  }
  return {
    objective: request.objective,
    targets,
    channel: request.channel,
    audienceDescription: request.audienceDescription,
    messageVariants,
    requestedBudgetMinor: request.requestedBudgetMinor,
    currency: request.currency,
    windowStart: request.windowStart,
    windowEnd: request.windowEnd,
    disclosures,
    supportingEvidence: request.supportingEvidence,
  };
}

function parseBriefTargets(
  value: unknown,
): HarnessCampaignBriefRequest["targets"] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 25) {
    return null;
  }
  const targets: HarnessCampaignBriefRequest["targets"][number][] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["entityType", "entityId", "revision"])
    ) {
      return null;
    }
    const entityType = entry.entityType;
    if (
      entityType !== "product" &&
      entityType !== "sellable_variant" &&
      entityType !== "offer"
    ) {
      return null;
    }
    if (typeof entry.entityId !== "string" || entry.entityId.length === 0) {
      return null;
    }
    if (
      typeof entry.revision !== "number" ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision <= 0
    ) {
      return null;
    }
    targets.push({
      entityType,
      entityId: entry.entityId,
      revision: entry.revision,
    });
  }
  return targets;
}

function parseBriefVariants(
  value: unknown,
): HarnessCampaignBriefRequest["messageVariants"] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5) {
    return null;
  }
  const variants: HarnessCampaignBriefRequest["messageVariants"][number][] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["variantId", "headline", "body"])
    ) {
      return null;
    }
    if (typeof entry.variantId !== "string" || entry.variantId.length === 0) {
      return null;
    }
    if (!isBoundedText(entry.headline) || !isBoundedText(entry.body)) {
      return null;
    }
    variants.push({
      variantId: entry.variantId,
      headline: entry.headline,
      body: entry.body,
    });
  }
  return variants;
}

function parseBoundedStrings(
  value: unknown,
  maxItems: number,
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) {
    return null;
  }
  return value.every(isBoundedText) ? (value as string[]) : null;
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 4_000
  );
}

/** The single `{ request }` wrapper every commerce tool takes. */
function singleRequestArgument(
  args: readonly unknown[],
  toolName: string,
): Readonly<Record<string, unknown>> {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    Object.keys(args[0]).length !== 1 ||
    !Object.hasOwn(args[0], "request")
  ) {
    throw new TypeError(`${toolName} requires one request object`);
  }
  const request = args[0].request;
  if (!isRecord(request)) {
    throw new TypeError(`${toolName} arguments are invalid`);
  }
  return request;
}

function parseConfigurationProposalArgs(
  args: readonly unknown[],
): HarnessConfigurationProposalRequest {
  const request = singleRequestArgument(args, "configuration_propose");
  if (
    !hasExactKeys(request, ["command"]) ||
    !isRecord(request.command) ||
    typeof request.command.kind !== "string" ||
    request.command.kind.length === 0
  ) {
    throw new TypeError("configuration_propose arguments are invalid");
  }
  return { command: request.command };
}

function parseMerchantPluginProposalArgs(
  args: readonly unknown[],
): MerchantPluginDraft {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    Object.keys(args[0]).length !== 1 ||
    !isRecord(args[0].request)
  ) {
    throw new TypeError("commerce_propose_plugin requires one request object");
  }
  const parsed = parseMerchantPluginDraft(args[0].request);
  if (!parsed.ok) {
    throw new ProposalArgumentError(
      `commerce_action_invalid: the plugin draft's ${parsed.error.field} breaks a rule of this tool. Nothing was proposed. Correct ${parsed.error.field} as the tool description says and propose again.`,
    );
  }
  return parsed.value;
}

function parseCommerceProposalArgs(
  args: readonly unknown[],
): CommerceActionRequest {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    Object.keys(args[0]).length !== 1 ||
    !Object.hasOwn(args[0], "request")
  ) {
    throw new TypeError("commerce_propose_action requires one request object");
  }
  const parsed = parseCommerceActionRequest(
    agentTrackingArguments(args[0].request),
  );
  // A plugin goes through commerce_propose_plugin, which reads its version and
  // revision from Commerce instead of taking them from the model.
  if (parsed.ok && parsed.value.kind === "install_merchant_plugin") {
    throw new TypeError("use commerce_propose_plugin to propose a plugin");
  }
  if (!parsed.ok) {
    if (parsed.error.code !== "commerce_action_invalid") {
      throw new TypeError(
        `commerce action arguments are invalid: ${parsed.error.code}`,
      );
    }
    throw new ProposalArgumentError(
      `commerce_action_invalid: the request's ${parsed.error.field} breaks a rule of this tool. Nothing was proposed. Correct ${parsed.error.field} as the tool description says and propose again.`,
    );
  }
  return parsed.value;
}

/**
 * The proposal replaces these three fields from current records. They only
 * pass the request's shape here, so the agent never has to name them.
 */
function agentTrackingArguments(raw: unknown): unknown {
  if (!isRecord(raw) || raw.kind !== "attach_tracking") {
    return raw;
  }
  return {
    ...raw,
    batchId: `tracking_batch_${"0".repeat(64)}`,
    merchantRevision: 1,
    orderId: "order_from_fulfillment",
  };
}
