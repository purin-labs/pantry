import {
  parseStockOperationDetails,
  type StockOperationDetails,
} from "./stock-operation.ts";
import { DESCRIPTION_LIMIT } from "@seams/product-description-crdt/limits";
import type { Variant } from "@seams/type-utils";
import {
  assertNever,
  hasExactKeys,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from "@seams/std";
import type {
  CommerceActionFollowUp,
  CommerceProviderReceipt,
  CommerceShopifyProviderReceipt,
  CommerceEngineProviderReceipt,
} from "../index.ts";
import type { ActionState } from "@seams/contracts";
import {
  parseMenuPriceDetails,
  type MenuPriceDetails,
} from "./menu-price-details.ts";

type CommerceActionAuthority =
  | {
      readonly kind: "commerce_system";
      readonly system: "satyr_commerce" | "shopify";
      readonly revision: number;
    }
  | {
      readonly kind: "integration_account";
      readonly integrationAccountId: string;
    };

export type CommerceActionRecord = {
  readonly nonce: string;
  readonly caseId: string;
  readonly proposalId: string;
  readonly state: ActionState;
  readonly verb: string;
  readonly resourceKey: string;
  readonly amount: CommerceActionAmount;
  readonly commerceSystem: CommerceActionAuthority;
  readonly details: CommerceActionDetails;
  readonly receipt: CommerceProviderReceipt | null;
};

type CafeMenuEntryName = Readonly<{
  menuEntryId: string;
  displayName: string;
}>;

/** What the approval card shows of the menu that the approval signs. */
type CafeMenuDetails = Readonly<{
  menuId: string;
  name: string;
  sections: readonly Readonly<{
    sectionId: string;
    name: string;
    position: number;
  }>[];
  entries: readonly Readonly<{ menuEntryId: string; sectionId: string }>[];
}>;

export type CommerceActionDetails =
  | {
      readonly kind: "publish_catalog_listing";
      readonly productId: string;
      readonly productRevision: number;
      readonly variantId: string;
      readonly variantRevision: number;
      readonly offerId: string;
      readonly offerRevision: number;
      readonly salesChannelId: string;
      readonly salesChannelRevision: number;
    }
  | {
      readonly kind: "update_product_description";
      readonly productId: string;
      readonly productRevision: number;
      readonly description: string;
    }
  | {
      readonly kind: "cancel_order";
      readonly resourceId: string;
      readonly expectedRevision: number;
      readonly reason:
        "customer_requested" | "fraud_suspected" | "inventory_unavailable";
      readonly refund: "none" | "full";
      readonly restock: boolean;
      readonly notifyCustomer: boolean;
      readonly note: string | null;
      readonly execution: CommerceCancellationExecution;
    }
  | {
      readonly kind: "attach_tracking";
      readonly batchId: string;
      readonly merchantRevision: number;
      readonly orderId: string;
      readonly fulfillmentId: string;
      readonly fulfillmentRevision: number;
      readonly shipmentId: string;
      readonly shipmentRevision: number;
      readonly trackingNumber: string;
    }
  | {
      readonly kind: "patch_commerce_list_entry";
      readonly entryId: string;
      readonly listId: string;
      readonly expectedRevision: number;
      readonly expectedListRevision: number;
    }
  | {
      readonly kind: "adjust_offer_price";
      readonly offerId: string;
      readonly expectedOfferRevision: number;
      readonly expectedPolicyRevision: number;
      readonly proposedPriceMinor: number;
      readonly currency: string;
    }
  | {
      readonly kind: "refund_order";
      readonly orderId: string;
      readonly reason: string;
      readonly amountMinor: number;
      readonly currency: string;
      readonly wholeOrder: boolean;
      readonly lines: readonly {
        readonly orderLineId: string;
        readonly title: string;
        readonly amountMinor: number;
      }[];
      readonly taxes: readonly {
        readonly orderLineId: string;
        readonly amountMinor: number;
      }[];
      readonly shippingMinor: number;
    }
  | StockOperationDetails
  | MenuPriceDetails
  | {
      readonly kind: "publish_cafe_menu";
      readonly documentRevision: number;
      readonly expectedMenuRevision: number | null;
      readonly menu: CafeMenuDetails;
      readonly entryNames: readonly CafeMenuEntryName[];
      readonly addedEntryIds: readonly string[];
      readonly removedNames: readonly string[];
    }
  | {
      readonly kind: "install_merchant_plugin";
      readonly pluginId: string;
      readonly version: number;
      readonly expectedRevision: number | null;
      readonly title: string;
      readonly purpose: string;
      readonly settings: readonly MerchantPluginSettingDetails[];
      readonly functionSource: string | null;
      readonly commands: readonly string[];
      readonly handlers: readonly MerchantPluginHandlerDetails[];
      readonly actions: readonly MerchantPluginActionDetails[];
      readonly entityTypes: readonly MerchantPluginEntityTypeDetails[];
      readonly fields: readonly MerchantPluginFieldDetails[];
    };

type MerchantPluginFieldDetails = Readonly<{
  entityType: string;
  key: string;
  valueKind: string;
  description: string;
}>;

type MerchantPluginHandlerDetails = Readonly<{
  handlerId: string;
  eventKinds: readonly string[];
  source: string;
}>;

type MerchantPluginActionDetails = Readonly<{
  actionId: string;
  title: string;
  inputs: readonly Readonly<{
    key: string;
    valueKind: string;
    description: string;
  }>[];
  source: string;
}>;

type MerchantPluginEntityTypeDetails = Readonly<{
  typeId: string;
  label: string;
  description: string;
  attributes: readonly Readonly<{
    key: string;
    label: string;
    valueKind: string;
    required: boolean;
  }>[];
}>;

export type MerchantPluginSettingDetails = Readonly<{
  key: string;
  valueKind: "integer" | "text" | "boolean" | "text_list";
  description: string;
  value: number | string | boolean | readonly string[];
}>;

export type CommerceActionAmount = Readonly<{
  readonly value: number;
  readonly currency: string;
}> | null;

type CommerceCancellationExecution =
  | Readonly<{ readonly kind: "provider_managed" }>
  | Readonly<{
      readonly kind: "underclerk_full_refund";
      readonly merchantRevision: number;
      readonly paymentId: string;
      readonly paymentRevision: number;
      readonly fulfillmentId: string;
      readonly fulfillmentRevision: number;
      readonly checkoutProfileId: string;
      readonly checkoutProfileRevision: number;
      readonly refundPolicyId: string;
      readonly refundAmountMinor: number;
      readonly refundCurrency: string;
      readonly refundGovernance: "automatic_eligible" | "approval_required";
    }>;

export function parseCommerceActionFollowUpResponse(
  raw: unknown,
): CommerceActionFollowUp {
  const followUp = isRecord(raw) ? raw.follow_up : null;
  if (isRecord(followUp)) {
    switch (followUp.kind) {
      case "complete":
        if (Object.keys(followUp).length === 1) return { kind: "complete" };
        break;
      case "pending":
        if (
          Object.keys(followUp).length === 2 &&
          typeof followUp.retryAt === "number" &&
          Number.isSafeInteger(followUp.retryAt) &&
          followUp.retryAt >= 0
        ) {
          return { kind: "pending", retryAt: followUp.retryAt };
        }
        break;
      case "unavailable":
        if (
          Object.keys(followUp).length === 2 &&
          typeof followUp.code === "string" &&
          followUp.code.length > 0
        ) {
          return { kind: "unavailable", code: followUp.code };
        }
        break;
    }
  }
  throw new Error("Commerce action follow-up response is invalid.");
}

export function parseCommerceActionRecordResponse(
  raw: unknown,
): CommerceActionRecord {
  const providerResult =
    isRecord(raw) && isRecord(raw.action)
      ? raw.action.providerResult
      : undefined;
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !isRecord(raw.action) ||
    !isRecord(raw.action.nonce) ||
    typeof raw.action.nonce.value !== "string" ||
    typeof raw.action.caseId !== "string" ||
    typeof raw.action.proposalId !== "string" ||
    typeof raw.action.state !== "string" ||
    typeof raw.action.verb !== "string" ||
    typeof raw.action.resourceKey !== "string" ||
    !isCommerceActionAuthority(raw.action.commerceSystem) ||
    (providerResult !== undefined &&
      providerResult !== null &&
      typeof providerResult !== "string") ||
    !isCommerceActionState(raw.action.state)
  ) {
    throw new Error("Commerce action response is invalid.");
  }
  const amount = parseCommerceActionAmount(raw.action.amount);
  return {
    nonce: raw.action.nonce.value,
    caseId: raw.action.caseId,
    proposalId: raw.action.proposalId,
    state: raw.action.state,
    verb: raw.action.verb,
    resourceKey: raw.action.resourceKey,
    amount,
    commerceSystem: parseCommerceActionAuthority(raw.action.commerceSystem),
    details: parseCommerceActionDetails(raw.action.details),
    receipt: parseCommerceProviderReceipt(providerResult ?? null),
  };
}

/** A proposed plugin's run over the merchant's recent checkouts, read now. */
export type MerchantPluginPreview =
  | Readonly<{ kind: "no_checkout_function" }>
  | Readonly<{
      kind: "previewed";
      checkouts: number;
      refusals: readonly Readonly<{ message: string; checkouts: number }>[];
      failures: readonly Readonly<{ reason: string; checkouts: number }>[];
    }>;

export function parseMerchantPluginPreviewResponse(
  raw: unknown,
): MerchantPluginPreview {
  const preview = isRecord(raw) && raw.ok === true ? raw.preview : undefined;
  if (isRecord(preview) && preview.kind === "no_checkout_function")
    return { kind: "no_checkout_function" };
  if (
    !isRecord(preview) ||
    preview.kind !== "previewed" ||
    !isNonNegativeInteger(preview.checkouts) ||
    !Array.isArray(preview.refusals) ||
    !Array.isArray(preview.failures)
  )
    throw new Error("Merchant plugin preview is invalid.");
  return {
    kind: "previewed",
    checkouts: preview.checkouts,
    refusals: preview.refusals.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.message !== "string" ||
        !isPositiveInteger(item.checkouts)
      )
        throw new Error("Merchant plugin preview is invalid.");
      return { message: item.message, checkouts: item.checkouts };
    }),
    failures: preview.failures.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.reason !== "string" ||
        !isPositiveInteger(item.checkouts)
      )
        throw new Error("Merchant plugin preview is invalid.");
      return { reason: item.reason, checkouts: item.checkouts };
    }),
  };
}

/** A pending reconciliation keeps the same indeterminate action and can be checked again. */
export function parseCommerceActionExecutionResponse(
  raw: unknown,
): CommerceActionRecord {
  if (
    isRecord(raw) &&
    raw.ok === false &&
    raw.error === "commerce_action_reconciliation_pending"
  ) {
    const action = parseCommerceActionRecordResponse({
      ok: true,
      action: raw.action,
    });
    if (action.state !== "indeterminate")
      throw new Error("Pending reconciliation must retain an unknown outcome.");
    return action;
  }
  return parseCommerceActionRecordResponse(raw);
}

function parseCommerceActionDetails(raw: unknown): CommerceActionDetails {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    throw new Error("Commerce action details are invalid.");
  }
  switch (raw.kind) {
    case "cancel_order":
      if (
        !hasExactKeys(raw, [
          "kind",
          "resourceId",
          "expectedRevision",
          "reason",
          "refund",
          "restock",
          "notifyCustomer",
          "note",
          "execution",
        ]) ||
        typeof raw.resourceId !== "string" ||
        !isPositiveInteger(raw.expectedRevision) ||
        !isCancellationReason(raw.reason) ||
        (raw.refund !== "none" && raw.refund !== "full") ||
        typeof raw.restock !== "boolean" ||
        typeof raw.notifyCustomer !== "boolean" ||
        (raw.note !== null && typeof raw.note !== "string")
      ) {
        throw new Error("Order cancellation details are invalid.");
      }
      return {
        kind: raw.kind,
        resourceId: raw.resourceId,
        expectedRevision: raw.expectedRevision,
        reason: raw.reason,
        refund: raw.refund,
        restock: raw.restock,
        notifyCustomer: raw.notifyCustomer,
        note: raw.note,
        execution: parseCommerceCancellationExecution(raw.execution),
      };
    case "publish_catalog_listing":
      if (
        typeof raw.productId !== "string" ||
        !isPositiveInteger(raw.productRevision) ||
        typeof raw.variantId !== "string" ||
        !isPositiveInteger(raw.variantRevision) ||
        typeof raw.offerId !== "string" ||
        !isPositiveInteger(raw.offerRevision) ||
        typeof raw.salesChannelId !== "string" ||
        !isPositiveInteger(raw.salesChannelRevision)
      ) {
        throw new Error("Catalog listing details are invalid.");
      }
      return {
        kind: raw.kind,
        productId: raw.productId,
        productRevision: raw.productRevision,
        variantId: raw.variantId,
        variantRevision: raw.variantRevision,
        offerId: raw.offerId,
        offerRevision: raw.offerRevision,
        salesChannelId: raw.salesChannelId,
        salesChannelRevision: raw.salesChannelRevision,
      };
    case "update_product_description":
      if (
        !nonEmptyText(raw.productId) ||
        !isPositiveInteger(raw.productRevision) ||
        typeof raw.description !== "string" ||
        raw.description.length > DESCRIPTION_LIMIT
      ) {
        throw new Error("Product description details are invalid.");
      }
      return {
        kind: raw.kind,
        productId: raw.productId,
        productRevision: raw.productRevision,
        description: raw.description,
      };
    case "attach_tracking":
      if (
        typeof raw.batchId !== "string" ||
        !/^tracking_batch_[0-9a-f]{64}$/u.test(raw.batchId) ||
        !isPositiveInteger(raw.merchantRevision) ||
        typeof raw.orderId !== "string" ||
        typeof raw.fulfillmentId !== "string" ||
        !isPositiveInteger(raw.fulfillmentRevision) ||
        typeof raw.shipmentId !== "string" ||
        !isPositiveInteger(raw.shipmentRevision) ||
        typeof raw.trackingNumber !== "string"
      ) {
        throw new Error("Tracking attachment details are invalid.");
      }
      return {
        kind: raw.kind,
        batchId: raw.batchId,
        merchantRevision: raw.merchantRevision,
        orderId: raw.orderId,
        fulfillmentId: raw.fulfillmentId,
        fulfillmentRevision: raw.fulfillmentRevision,
        shipmentId: raw.shipmentId,
        shipmentRevision: raw.shipmentRevision,
        trackingNumber: raw.trackingNumber,
      };
    case "patch_commerce_list_entry":
      if (
        !hasExactKeys(raw, [
          "kind",
          "entryId",
          "listId",
          "expectedRevision",
          "expectedListRevision",
        ]) ||
        !nonEmptyText(raw.entryId) ||
        !nonEmptyText(raw.listId) ||
        !isPositiveInteger(raw.expectedRevision) ||
        !isPositiveInteger(raw.expectedListRevision)
      ) {
        throw new Error("Commerce list-entry patch details are invalid.");
      }
      return {
        kind: raw.kind,
        entryId: raw.entryId,
        listId: raw.listId,
        expectedRevision: raw.expectedRevision,
        expectedListRevision: raw.expectedListRevision,
      };
    case "adjust_offer_price":
      if (
        !nonEmptyText(raw.offerId) ||
        !isPositiveInteger(raw.expectedOfferRevision) ||
        !isPositiveInteger(raw.expectedPolicyRevision) ||
        !isPositiveInteger(raw.proposedPriceMinor) ||
        typeof raw.currency !== "string" ||
        !/^[A-Z]{3}$/u.test(raw.currency)
      ) {
        throw new Error("Offer price change details are invalid.");
      }
      return {
        kind: raw.kind,
        offerId: raw.offerId,
        expectedOfferRevision: raw.expectedOfferRevision,
        expectedPolicyRevision: raw.expectedPolicyRevision,
        proposedPriceMinor: raw.proposedPriceMinor,
        currency: raw.currency,
      };
    case "publish_cafe_menu":
      return parseCafeMenuDetails(raw);
    case "change_menu_price":
      return parseMenuPriceDetails(raw);
    case "refund_order":
      return parseOrderRefundDetails(raw);
    case "stock_operation":
      return parseStockOperationDetails(raw);
    case "install_merchant_plugin": {
      if (
        !hasExactKeys(raw, [
          "kind",
          "pluginId",
          "version",
          "expectedRevision",
          "title",
          "purpose",
          "settings",
          "functionSource",
          "commands",
          "handlers",
          "actions",
          "entityTypes",
          "fields",
        ]) ||
        !nonEmptyText(raw.pluginId) ||
        !isPositiveInteger(raw.version) ||
        (raw.expectedRevision !== null &&
          !isPositiveInteger(raw.expectedRevision)) ||
        !nonEmptyText(raw.title) ||
        !nonEmptyText(raw.purpose) ||
        (raw.functionSource !== null &&
          typeof raw.functionSource !== "string") ||
        !Array.isArray(raw.settings) ||
        !Array.isArray(raw.commands) ||
        !raw.commands.every(nonEmptyText) ||
        !Array.isArray(raw.handlers) ||
        !Array.isArray(raw.actions) ||
        !Array.isArray(raw.entityTypes) ||
        !Array.isArray(raw.fields)
      ) {
        throw new Error("Merchant plugin details are invalid.");
      }
      return {
        kind: raw.kind,
        pluginId: raw.pluginId,
        version: raw.version,
        expectedRevision: raw.expectedRevision,
        title: raw.title,
        purpose: raw.purpose,
        settings: raw.settings.map(parseMerchantPluginSetting),
        functionSource: raw.functionSource,
        commands: raw.commands,
        handlers: raw.handlers.map(parseMerchantPluginHandler),
        actions: raw.actions.map(parseMerchantPluginAction),
        entityTypes: raw.entityTypes.map(parseMerchantPluginEntityType),
        fields: raw.fields.map(parseMerchantPluginField),
      };
    }
    default:
      throw new Error("Commerce action details are invalid.");
  }
}

function parseOrderRefundDetails(
  raw: Record<string, unknown>,
): Variant<CommerceActionDetails, "refund_order"> {
  if (
    !nonEmptyText(raw.orderId) ||
    !nonEmptyText(raw.reason) ||
    !isPositiveInteger(raw.amountMinor) ||
    !nonEmptyText(raw.currency) ||
    typeof raw.wholeOrder !== "boolean" ||
    typeof raw.shippingMinor !== "number" ||
    !Array.isArray(raw.lines) ||
    !Array.isArray(raw.taxes)
  )
    throw new Error("Refund details are invalid.");
  return {
    kind: "refund_order",
    orderId: raw.orderId,
    reason: raw.reason,
    amountMinor: raw.amountMinor,
    currency: raw.currency,
    wholeOrder: raw.wholeOrder,
    shippingMinor: raw.shippingMinor,
    lines: raw.lines.map((line: unknown) => {
      if (
        !isRecord(line) ||
        !nonEmptyText(line.orderLineId) ||
        typeof line.title !== "string" ||
        typeof line.amountMinor !== "number"
      )
        throw new Error("Refund line is invalid.");
      return {
        orderLineId: line.orderLineId,
        title: line.title,
        amountMinor: line.amountMinor,
      };
    }),
    taxes: raw.taxes.map((tax: unknown) => {
      if (
        !isRecord(tax) ||
        !nonEmptyText(tax.orderLineId) ||
        typeof tax.amountMinor !== "number"
      )
        throw new Error("Refund tax is invalid.");
      return { orderLineId: tax.orderLineId, amountMinor: tax.amountMinor };
    }),
  };
}

function parseCafeMenuDetails(
  raw: Record<string, unknown>,
): Variant<CommerceActionDetails, "publish_cafe_menu"> {
  const menu = raw.menu;
  if (
    !hasExactKeys(raw, [
      "kind",
      "documentRevision",
      "expectedMenuRevision",
      "menu",
      "entryNames",
      "addedEntryIds",
      "removedNames",
    ]) ||
    !isPositiveInteger(raw.documentRevision) ||
    (raw.expectedMenuRevision !== null &&
      !isPositiveInteger(raw.expectedMenuRevision)) ||
    !isRecord(menu) ||
    !nonEmptyText(menu.menuId) ||
    !nonEmptyText(menu.name) ||
    !Array.isArray(menu.sections) ||
    !Array.isArray(menu.entries) ||
    !Array.isArray(raw.entryNames) ||
    !Array.isArray(raw.addedEntryIds) ||
    !raw.addedEntryIds.every(nonEmptyText) ||
    !Array.isArray(raw.removedNames) ||
    !raw.removedNames.every((name) => typeof name === "string")
  )
    throw new Error("Menu publication details are invalid.");
  return {
    kind: "publish_cafe_menu",
    documentRevision: raw.documentRevision,
    expectedMenuRevision: raw.expectedMenuRevision,
    menu: {
      menuId: menu.menuId,
      name: menu.name,
      sections: menu.sections.map((section: unknown) => {
        if (
          !isRecord(section) ||
          !nonEmptyText(section.sectionId) ||
          !nonEmptyText(section.name) ||
          typeof section.position !== "number"
        )
          throw new Error("Menu section is invalid.");
        return {
          sectionId: section.sectionId,
          name: section.name,
          position: section.position,
        };
      }),
      entries: menu.entries.map((entry: unknown) => {
        if (
          !isRecord(entry) ||
          !nonEmptyText(entry.menuEntryId) ||
          !nonEmptyText(entry.sectionId)
        )
          throw new Error("Menu entry is invalid.");
        return { menuEntryId: entry.menuEntryId, sectionId: entry.sectionId };
      }),
    },
    entryNames: raw.entryNames.map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        !nonEmptyText(entry.menuEntryId) ||
        typeof entry.displayName !== "string"
      )
        throw new Error("Menu entry name is invalid.");
      return {
        menuEntryId: entry.menuEntryId,
        displayName: entry.displayName,
      };
    }),
    addedEntryIds: raw.addedEntryIds,
    removedNames: raw.removedNames,
  };
}

function parseMerchantPluginHandler(
  raw: unknown,
): MerchantPluginHandlerDetails {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["handlerId", "eventKinds", "source"]) ||
    !nonEmptyText(raw.handlerId) ||
    !Array.isArray(raw.eventKinds) ||
    !raw.eventKinds.every(nonEmptyText) ||
    !nonEmptyText(raw.source)
  )
    throw new Error("Merchant plugin handler is invalid.");
  return {
    handlerId: raw.handlerId,
    eventKinds: raw.eventKinds,
    source: raw.source,
  };
}

function parseMerchantPluginAction(raw: unknown): MerchantPluginActionDetails {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["actionId", "title", "inputs", "source"]) ||
    !nonEmptyText(raw.actionId) ||
    !nonEmptyText(raw.title) ||
    !Array.isArray(raw.inputs) ||
    !nonEmptyText(raw.source)
  )
    throw new Error("Merchant plugin action is invalid.");
  return {
    actionId: raw.actionId,
    title: raw.title,
    inputs: raw.inputs.map((input: unknown) => {
      if (
        !isRecord(input) ||
        !hasExactKeys(input, ["key", "valueKind", "description"]) ||
        !nonEmptyText(input.key) ||
        !nonEmptyText(input.valueKind) ||
        !nonEmptyText(input.description)
      )
        throw new Error("Merchant plugin action input is invalid.");
      return {
        key: input.key,
        valueKind: input.valueKind,
        description: input.description,
      };
    }),
    source: raw.source,
  };
}

function parseMerchantPluginField(raw: unknown): MerchantPluginFieldDetails {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["entityType", "key", "valueKind", "description"]) ||
    !nonEmptyText(raw.entityType) ||
    !nonEmptyText(raw.key) ||
    !nonEmptyText(raw.valueKind) ||
    !nonEmptyText(raw.description)
  )
    throw new Error("Merchant plugin field is invalid.");
  return {
    entityType: raw.entityType,
    key: raw.key,
    valueKind: raw.valueKind,
    description: raw.description,
  };
}

function parseMerchantPluginEntityType(
  raw: unknown,
): MerchantPluginEntityTypeDetails {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["typeId", "label", "description", "attributes"]) ||
    !nonEmptyText(raw.typeId) ||
    !nonEmptyText(raw.label) ||
    !nonEmptyText(raw.description) ||
    !Array.isArray(raw.attributes)
  )
    throw new Error("Merchant plugin entity type is invalid.");
  return {
    typeId: raw.typeId,
    label: raw.label,
    description: raw.description,
    attributes: raw.attributes.map((attribute: unknown) => {
      if (
        !isRecord(attribute) ||
        !hasExactKeys(attribute, ["key", "label", "valueKind", "required"]) ||
        !nonEmptyText(attribute.key) ||
        !nonEmptyText(attribute.label) ||
        !nonEmptyText(attribute.valueKind) ||
        typeof attribute.required !== "boolean"
      )
        throw new Error("Merchant plugin entity attribute is invalid.");
      return {
        key: attribute.key,
        label: attribute.label,
        valueKind: attribute.valueKind,
        required: attribute.required,
      };
    }),
  };
}

function parseMerchantPluginSetting(
  raw: unknown,
): MerchantPluginSettingDetails {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["key", "valueKind", "description", "value"]) ||
    !nonEmptyText(raw.key) ||
    typeof raw.description !== "string"
  )
    throw new Error("Merchant plugin setting is invalid.");
  const value = raw.value;
  switch (raw.valueKind) {
    case "integer":
      if (typeof value === "number" && Number.isSafeInteger(value))
        return {
          key: raw.key,
          valueKind: "integer",
          description: raw.description,
          value,
        };
      break;
    case "text":
      if (typeof value === "string")
        return {
          key: raw.key,
          valueKind: "text",
          description: raw.description,
          value,
        };
      break;
    case "boolean":
      if (typeof value === "boolean")
        return {
          key: raw.key,
          valueKind: "boolean",
          description: raw.description,
          value,
        };
      break;
    case "text_list":
      if (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string")
      )
        return {
          key: raw.key,
          valueKind: "text_list",
          description: raw.description,
          value: value as string[],
        };
      break;
  }
  throw new Error("Merchant plugin setting is invalid.");
}

function parseCommerceActionAuthority(raw: unknown): CommerceActionAuthority {
  if (!isCommerceActionAuthority(raw)) {
    throw new Error("Commerce action authority is invalid.");
  }
  switch (raw.kind) {
    case "commerce_system":
      return {
        kind: raw.kind,
        system: raw.system,
        revision: raw.revision,
      };
    case "integration_account":
      return {
        kind: raw.kind,
        integrationAccountId: raw.integrationAccountId,
      };
    default:
      return assertNever(raw, "Unexpected commerce action value");
  }
}

function isCommerceActionAuthority(
  raw: unknown,
): raw is CommerceActionAuthority {
  if (!isRecord(raw) || typeof raw.kind !== "string") return false;
  switch (raw.kind) {
    case "commerce_system":
      return (
        hasExactKeys(raw, ["kind", "system", "revision"]) &&
        (raw.system === "satyr_commerce" || raw.system === "shopify") &&
        isPositiveInteger(raw.revision)
      );
    case "integration_account":
      return (
        hasExactKeys(raw, ["kind", "integrationAccountId"]) &&
        nonEmptyText(raw.integrationAccountId)
      );
    default:
      return false;
  }
}

function nonEmptyText(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 256
  );
}

export function parseCommerceActionAmount(raw: unknown): CommerceActionAmount {
  if (raw === null) return null;
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["value", "currency"]) ||
    typeof raw.value !== "number" ||
    !Number.isFinite(raw.value) ||
    typeof raw.currency !== "string" ||
    raw.currency.length === 0
  ) {
    throw new Error("Commerce action amount is invalid.");
  }
  return { value: raw.value, currency: raw.currency };
}

function parseCommerceCancellationExecution(
  raw: unknown,
): CommerceCancellationExecution {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    throw new Error("Order cancellation execution is invalid.");
  }
  switch (raw.kind) {
    case "provider_managed":
      if (!hasExactKeys(raw, ["kind"])) {
        throw new Error("Order cancellation execution is invalid.");
      }
      return { kind: raw.kind };
    case "underclerk_full_refund":
      if (
        !hasExactKeys(raw, [
          "kind",
          "merchantRevision",
          "paymentId",
          "paymentRevision",
          "fulfillmentId",
          "fulfillmentRevision",
          "checkoutProfileId",
          "checkoutProfileRevision",
          "refundPolicyId",
          "refundAmountMinor",
          "refundCurrency",
          "refundGovernance",
        ]) ||
        typeof raw.paymentId !== "string" ||
        raw.paymentId.length === 0 ||
        typeof raw.fulfillmentId !== "string" ||
        raw.fulfillmentId.length === 0 ||
        typeof raw.checkoutProfileId !== "string" ||
        raw.checkoutProfileId.length === 0 ||
        typeof raw.refundPolicyId !== "string" ||
        raw.refundPolicyId.length === 0 ||
        !isPositiveInteger(raw.merchantRevision) ||
        !isPositiveInteger(raw.paymentRevision) ||
        !isPositiveInteger(raw.fulfillmentRevision) ||
        !isPositiveInteger(raw.checkoutProfileRevision) ||
        !isPositiveInteger(raw.refundAmountMinor) ||
        typeof raw.refundCurrency !== "string" ||
        raw.refundCurrency.length === 0 ||
        (raw.refundGovernance !== "automatic_eligible" &&
          raw.refundGovernance !== "approval_required")
      ) {
        throw new Error("Order cancellation execution is invalid.");
      }
      return {
        kind: raw.kind,
        merchantRevision: raw.merchantRevision,
        paymentId: raw.paymentId,
        paymentRevision: raw.paymentRevision,
        fulfillmentId: raw.fulfillmentId,
        fulfillmentRevision: raw.fulfillmentRevision,
        checkoutProfileId: raw.checkoutProfileId,
        checkoutProfileRevision: raw.checkoutProfileRevision,
        refundPolicyId: raw.refundPolicyId,
        refundAmountMinor: raw.refundAmountMinor,
        refundCurrency: raw.refundCurrency,
        refundGovernance: raw.refundGovernance,
      };
    default:
      throw new Error("Order cancellation execution is invalid.");
  }
}

function isCancellationReason(
  value: unknown,
): value is Variant<CommerceActionDetails, "cancel_order">["reason"] {
  return (
    value === "customer_requested" ||
    value === "fraud_suspected" ||
    value === "inventory_unavailable"
  );
}

function parseCommerceProviderReceipt(
  raw: unknown,
): CommerceProviderReceipt | null {
  if (raw === null || typeof raw !== "string") return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(decoded) ||
    decoded.kind !== "commerce_provider_receipt" ||
    typeof decoded.provider !== "string" ||
    typeof decoded.receiptId !== "string" ||
    typeof decoded.effectId !== "string" ||
    typeof decoded.actionNonce !== "string" ||
    typeof decoded.resourceId !== "string" ||
    typeof decoded.revision !== "number" ||
    !Number.isSafeInteger(decoded.revision) ||
    decoded.revision < 1 ||
    typeof decoded.observedAt !== "string" ||
    typeof decoded.flowBindingDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(decoded.flowBindingDigest) ||
    typeof decoded.decisionDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(decoded.decisionDigest)
  ) {
    return null;
  }
  if (
    decoded.provider === "lab" &&
    hasExactKeys(decoded, [
      "kind",
      "provider",
      "receiptId",
      "effectId",
      "actionNonce",
      "flowBindingDigest",
      "decisionDigest",
      "eventId",
      "resourceId",
      "projectionKind",
      "revision",
      "status",
      "observedAt",
    ]) &&
    typeof decoded.eventId === "string" &&
    (decoded.projectionKind === "offer" ||
      decoded.projectionKind === "commerce_order" ||
      decoded.projectionKind === "fulfillment") &&
    decoded.status === "settled"
  ) {
    return {
      kind: "commerce_provider_receipt",
      provider: "lab",
      receiptId: decoded.receiptId,
      effectId: decoded.effectId,
      actionNonce: decoded.actionNonce,
      flowBindingDigest: decoded.flowBindingDigest,
      decisionDigest: decoded.decisionDigest,
      eventId: decoded.eventId,
      resourceId: decoded.resourceId,
      projectionKind: decoded.projectionKind,
      revision: decoded.revision,
      status: "settled",
      observedAt: decoded.observedAt,
    };
  }
  if (
    decoded.provider === "shopify" &&
    hasExactKeys(decoded, [
      "kind",
      "provider",
      "receiptId",
      "effectId",
      "actionNonce",
      "flowBindingDigest",
      "decisionDigest",
      "eventId",
      "resourceId",
      "projectionKind",
      "revision",
      "status",
      "jobId",
      "jobDone",
      "errors",
      "observedAt",
    ]) &&
    decoded.eventId === null &&
    decoded.projectionKind === "commerce_order" &&
    (decoded.status === "accepted" ||
      decoded.status === "failed" ||
      decoded.status === "indeterminate") &&
    (typeof decoded.jobId === "string" || decoded.jobId === null) &&
    (typeof decoded.jobDone === "boolean" || decoded.jobDone === null) &&
    Array.isArray(decoded.errors) &&
    decoded.errors.every(isCommerceProviderError)
  ) {
    return {
      kind: "commerce_provider_receipt",
      provider: "shopify",
      receiptId: decoded.receiptId,
      effectId: decoded.effectId,
      actionNonce: decoded.actionNonce,
      flowBindingDigest: decoded.flowBindingDigest,
      decisionDigest: decoded.decisionDigest,
      eventId: null,
      resourceId: decoded.resourceId,
      projectionKind: "commerce_order",
      revision: decoded.revision,
      status: decoded.status,
      jobId: decoded.jobId,
      jobDone: decoded.jobDone,
      errors: decoded.errors,
      observedAt: decoded.observedAt,
    };
  }
  if (
    decoded.provider === "underclerk" &&
    hasExactKeys(decoded, [
      "kind",
      "provider",
      "receiptId",
      "effectId",
      "actionNonce",
      "flowBindingDigest",
      "decisionDigest",
      "eventId",
      "resourceId",
      "projectionKind",
      "revision",
      "status",
      "merchantId",
      "merchantRevision",
      "observedAt",
    ]) &&
    typeof decoded.eventId === "string" &&
    (decoded.projectionKind === "offer" ||
      decoded.projectionKind === "fulfillment" ||
      decoded.projectionKind === "product" ||
      decoded.projectionKind === "merchant_plugin" ||
      decoded.projectionKind === "cafe_menu" ||
      decoded.projectionKind === "order_refund" ||
      decoded.projectionKind === "stock_operation") &&
    decoded.status === "accepted" &&
    typeof decoded.merchantId === "string" &&
    typeof decoded.merchantRevision === "number" &&
    Number.isSafeInteger(decoded.merchantRevision) &&
    decoded.merchantRevision > 0
  ) {
    return {
      kind: "commerce_provider_receipt",
      provider: "underclerk",
      receiptId: decoded.receiptId,
      effectId: decoded.effectId,
      actionNonce: decoded.actionNonce,
      flowBindingDigest: decoded.flowBindingDigest,
      decisionDigest: decoded.decisionDigest,
      eventId: decoded.eventId,
      resourceId: decoded.resourceId,
      projectionKind: decoded.projectionKind,
      revision: decoded.revision,
      status: "accepted",
      merchantId: decoded.merchantId,
      merchantRevision: decoded.merchantRevision,
      observedAt: decoded.observedAt,
    };
  }
  if (
    decoded.provider === "underclerk" &&
    hasExactKeys(decoded, [
      "kind",
      "provider",
      "receiptId",
      "effectId",
      "actionNonce",
      "flowBindingDigest",
      "decisionDigest",
      "eventId",
      "resourceId",
      "projectionKind",
      "revision",
      "status",
      "merchantId",
      "merchantRevision",
      "providerResource",
      "observedAt",
    ]) &&
    typeof decoded.eventId === "string" &&
    decoded.projectionKind === "commerce_order" &&
    decoded.status === "accepted" &&
    typeof decoded.merchantId === "string" &&
    typeof decoded.merchantRevision === "number" &&
    Number.isSafeInteger(decoded.merchantRevision) &&
    decoded.merchantRevision > 0 &&
    isCommerceProviderResource(decoded.providerResource)
  ) {
    return {
      kind: "commerce_provider_receipt",
      provider: "underclerk",
      receiptId: decoded.receiptId,
      effectId: decoded.effectId,
      actionNonce: decoded.actionNonce,
      flowBindingDigest: decoded.flowBindingDigest,
      decisionDigest: decoded.decisionDigest,
      eventId: decoded.eventId,
      resourceId: decoded.resourceId,
      projectionKind: "commerce_order",
      revision: decoded.revision,
      status: "accepted",
      merchantId: decoded.merchantId,
      merchantRevision: decoded.merchantRevision,
      providerResource: decoded.providerResource,
      observedAt: decoded.observedAt,
    };
  }
  return null;
}

function isCommerceProviderResource(
  raw: unknown,
): raw is NonNullable<CommerceEngineProviderReceipt["providerResource"]> {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, ["kind", "id", "revision"]) &&
    raw.kind === "refund_attempt" &&
    typeof raw.id === "string" &&
    raw.id.length > 0 &&
    isPositiveInteger(raw.revision)
  );
}

function isCommerceActionState(
  raw: string,
): raw is CommerceActionRecord["state"] {
  switch (raw) {
    case "proposed":
    case "approval_requested":
    case "signed":
    case "executing":
    case "confirmed":
    case "failed":
    case "rejected":
    case "expired":
    case "indeterminate":
      return true;
    default:
      return false;
  }
}

function isCommerceProviderError(
  raw: unknown,
): raw is CommerceShopifyProviderReceipt["errors"][number] {
  if (!isRecord(raw)) return false;
  return (
    (raw.field === null || typeof raw.field === "string") &&
    (raw.code === null || typeof raw.code === "string") &&
    typeof raw.message === "string"
  );
}
