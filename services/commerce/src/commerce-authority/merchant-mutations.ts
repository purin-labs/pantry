// The mutations of media, markets, discounts, collections, webhook
// subscriptions, customers and plugins, as the ledger commits them.
import type { CommerceMediaCommandV1 } from "@purin-labs/commerce-client";
import { type WebhookCommitRequest } from "../webhooks.ts";
import { type CollectionCommitRequest } from "../plugins/collections/index.ts";
import { type CustomerCommitRequest } from "../plugins/customers/index.ts";
import { type DiscountCommitRequest } from "../plugins/discounts/index.ts";
import { type StoredValueCommitRequest } from "../plugins/stored-value/index.ts";
import {
  type MarketCommitRequest,
  writeMarket,
} from "../plugins/markets/index.ts";
import { type MediaCommitRequest } from "../plugins/media/index.ts";
import {
  type CompanyCommitRequest,
  type InvoiceCommitRequest,
  writeCompany,
  writeInvoice,
} from "../plugins/companies/index.ts";
import { type PluginCommitRequest } from "../plugins/plugin-authority.ts";
import type { CommerceMutation } from "./ledger.ts";

const MEDIA_COMMAND_KINDS = {
  "underclerk.create-media.v1": "create_media",
  "underclerk.update-media.v1": "update_media",
  "underclerk.delete-media.v1": "delete_media",
  "underclerk.set-product-media.v1": "set_product_media",
} as const satisfies Record<CommerceMediaCommandV1["schemaVersion"], string>;

export function mediaMutation(
  request: MediaCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  const commandKind = MEDIA_COMMAND_KINDS[command.schemaVersion];
  return {
    command,
    merchant,
    committedAt,
    commandKind,
    resource: request.resource,
    observations: [],
    write: (database) => {
      request.write();
    },
  };
}

const PLUGIN_COMMAND_KINDS = {
  "underclerk.pause-plugin.v1": "pause_plugin",
  "underclerk.resume-plugin.v1": "resume_plugin",
  "underclerk.configure-plugin.v1": "configure_plugin",
  "underclerk.remove-plugin.v1": "remove_plugin",
  "underclerk.install-merchant-plugin.v1": "install_merchant_plugin",
  "underclerk.report-plugin-function-failure.internal.v1":
    "report_plugin_function_failure",
  "underclerk.pause-failing-plugin.internal.v1": "pause_failing_plugin",
  "underclerk.set-plugin-field-values.v1": "set_plugin_field_values",
  "underclerk.run-plugin-action.v1": "run_plugin_action",
} as const satisfies Record<
  PluginCommitRequest["command"]["schemaVersion"],
  string
>;

export function pluginMutation(
  request: PluginCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  return {
    command,
    merchant,
    committedAt,
    commandKind: PLUGIN_COMMAND_KINDS[command.schemaVersion],
    resource: request.resource ?? {
      kind: "plugin",
      id: request.pluginId,
      revision: request.revision,
    },
    observations: [],
    write: () => {
      request.write();
    },
  };
}

export function marketMutation(
  request: MarketCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  const commandKind =
    command.schemaVersion === "underclerk.create-market.v1"
      ? ("create_market" as const)
      : ("update_market" as const);
  return {
    command,
    merchant,
    committedAt,
    commandKind,
    resource: {
      kind: "market",
      id: request.market.id,
      revision: request.market.revision,
    },
    observations: [],
    write: (database) => {
      writeMarket(
        database,
        command.merchantId,
        request.market,
        request.previousRevision,
      );
    },
  };
}

export function companyMutation(
  request: CompanyCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  return {
    command,
    merchant,
    committedAt,
    commandKind:
      command.schemaVersion === "underclerk.create-company.v1"
        ? "create_company"
        : "update_company",
    resource: {
      kind: "company",
      id: request.company.id,
      revision: request.company.revision,
    },
    observations: [],
    write: (database) => {
      writeCompany(
        database,
        command.merchantId,
        request.company,
        request.previousRevision,
      );
    },
  };
}

export function invoiceMutation(
  request: InvoiceCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  return {
    command,
    merchant,
    committedAt,
    commandKind:
      command.schemaVersion === "underclerk.record-invoice-payment.v1"
        ? "record_invoice_payment"
        : "mark_invoice_overdue",
    resource: {
      kind: "company_invoice",
      id: request.invoice.id,
      revision: request.invoice.revision,
    },
    observations: [],
    write: (database) => {
      writeInvoice(
        database,
        command.merchantId,
        request.invoice,
        request.previousRevision,
      );
    },
  };
}

export function discountMutation(
  request: DiscountCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  const commandKind =
    command.schemaVersion === "underclerk.create-discount.v1"
      ? ("create_discount" as const)
      : ("deactivate_discount" as const);
  return {
    command,
    merchant,
    committedAt,
    commandKind,
    resource: {
      kind: "discount",
      id: request.discountId,
      revision: request.revision,
    },
    observations: [],
    write: (database) => {
      request.write();
    },
  };
}

const STORED_VALUE_COMMAND_KINDS = {
  "underclerk.issue-gift-card.v1": "issue_gift_card",
  "underclerk.credit-store-credit.v1": "credit_store_credit",
  "underclerk.disable-stored-value-account.v1": "disable_stored_value_account",
} as const;

export function storedValueMutation(
  request: StoredValueCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  return {
    command,
    merchant,
    committedAt,
    commandKind: STORED_VALUE_COMMAND_KINDS[command.schemaVersion],
    resource: {
      kind: "stored_value_account",
      id: request.accountId,
      revision: request.revision,
    },
    observations: [],
    write: () => {
      request.write();
    },
  };
}

export function collectionMutation(
  request: CollectionCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  const commandKind =
    command.schemaVersion === "underclerk.create-collection.v1"
      ? ("create_collection" as const)
      : command.schemaVersion === "underclerk.update-collection.v1"
        ? ("update_collection" as const)
        : ("delete_collection" as const);
  return {
    command,
    merchant,
    committedAt,
    commandKind,
    resource: {
      kind: "collection",
      id: request.collectionId,
      revision: request.revision,
    },
    observations: [],
    write: (database) => {
      request.write();
    },
  };
}

const WEBHOOK_COMMAND_KINDS = {
  "underclerk.create-webhook-subscription.v1": "create_webhook_subscription",
  "underclerk.restart-webhook-subscription.v1": "restart_webhook_subscription",
  "underclerk.rotate-webhook-secret.v1": "rotate_webhook_secret",
  "underclerk.delete-webhook-subscription.v1": "delete_webhook_subscription",
} as const satisfies Record<
  WebhookCommitRequest["command"]["schemaVersion"],
  string
>;

export function webhookSubscriptionMutation(
  request: WebhookCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  return {
    command,
    merchant,
    committedAt,
    commandKind: WEBHOOK_COMMAND_KINDS[command.schemaVersion],
    resource: {
      kind: "webhook_subscription",
      id: command.subscriptionId,
      revision: request.revision,
    },
    observations: [],
    write: (database) => {
      request.write();
    },
  };
}

export function customerMutation(
  request: CustomerCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  const commandKind =
    command.schemaVersion === "underclerk.create-customer.v1"
      ? ("create_customer" as const)
      : command.schemaVersion === "underclerk.update-customer.v1"
        ? ("update_customer" as const)
        : ("erase_customer" as const);
  return {
    command,
    merchant,
    committedAt,
    commandKind,
    resource: {
      kind: "customer",
      id: request.customerId,
      revision: request.revision,
    },
    observations: [],
    write: (database) => {
      request.write();
    },
  };
}
