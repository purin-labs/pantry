import {
  type CommerceMutationResultV1,
  type CommercePluginListV1,
  type CommercePluginPreviewV1,
  type CommerceWebhookSubscriptionV1,
} from "@purin-labs/commerce-client";
import {
  PluginAuthority,
  HANDLER_RUNS,
} from "../../plugins/plugin-authority.ts";
import { type BuiltInPlugin } from "../../plugins/registry.ts";
import type { PreparedFunctionVms } from "../../plugins/function-runtime.ts";
import { activeFunctionCount } from "../../plugins/merchant-plugins.ts";
import { WebhookAuthority, type WebhookSender } from "../../webhooks.ts";
import type { ApiAccess } from "../../api-access.ts";
import {
  closeMerchant,
  type MerchantClosureResult,
} from "../../merchant-closure.ts";
import type { SquareConnections } from "../../payments/square/square-connection.ts";
import { PromotionFamily } from "./promotions.ts";

/**
 * Plugins, plugin functions and webhook subscriptions.
 */
export abstract class IntegrationFamily extends PromotionFamily {
  /**
   * Closes a merchant whose Organisation ended: its credentials, webhook
   * subscriptions and provider links end (Refactor 15, refactor 11).
   */
  closeMerchant(
    merchantId: string,
    access: ApiAccess,
    squareConnections: SquareConnections | undefined,
  ): Promise<MerchantClosureResult> {
    return closeMerchant(
      { database: this.database, access, squareConnections, now: this.now },
      merchantId,
    );
  }

  listPlugins(merchantId: string): CommercePluginListV1 {
    return this.plugins.listPlugins(merchantId);
  }

  previewPluginChange(
    merchantId: string,
    pluginId: string,
    rawCommand: unknown,
  ): CommercePluginPreviewV1 | undefined {
    return this.plugins.previewPluginChange(merchantId, pluginId, rawCommand);
  }

  changePlugin(rawCommand: unknown): CommerceMutationResultV1 {
    return this.plugins.changePlugin(rawCommand);
  }

  configurePlugin(rawCommand: unknown): CommerceMutationResultV1 {
    return this.plugins.configurePlugin(rawCommand);
  }

  installMerchantPlugin(rawCommand: unknown): CommerceMutationResultV1 {
    return this.plugins.installMerchantPlugin(rawCommand);
  }

  setPluginFieldValues(rawCommand: unknown): CommerceMutationResultV1 {
    return this.plugins.setFieldValues(rawCommand);
  }

  listPluginFieldValues(
    merchantId: string,
    pluginId: string,
  ): ReturnType<PluginAuthority["listFieldValues"]> {
    return this.plugins.listFieldValues(merchantId, pluginId);
  }

  runPluginFunction(
    rawCommand: unknown,
  ): ReturnType<PluginAuthority["runPluginFunction"]> {
    return this.plugins.runPluginFunction(rawCommand);
  }

  previewMerchantPlugin(
    merchantId: string,
    rawCommand: unknown,
  ): ReturnType<PluginAuthority["previewMerchantPlugin"]> {
    return this.plugins.previewMerchantPlugin(merchantId, rawCommand);
  }

  /**
   * Clean VMs for the merchant plugin functions that one request may run,
   * or undefined when the merchant has none (Plan 77 step 4).
   */
  async prepareFunctionVms(
    merchantId: string,
  ): Promise<PreparedFunctionVms | undefined> {
    const count = activeFunctionCount(this.database, merchantId);
    return count === 0 || this.functionRuntime === undefined
      ? undefined
      : this.functionRuntime.prepare(count * 2);
  }

  /** The paused plugin that owns a route, so that the route answers 404. */
  inactivePluginOfRoute(
    merchantId: string,
    routeKind: string,
  ): BuiltInPlugin | undefined {
    return this.plugins.inactivePluginOfRoute(merchantId, routeKind);
  }

  createWebhookSubscription(
    rawCommand: unknown,
  ): ReturnType<WebhookAuthority["createSubscription"]> {
    return this.webhooks.createSubscription(rawCommand);
  }

  /** Restarts a failing subscription, or deletes a subscription. */
  changeWebhookSubscription(rawCommand: unknown): CommerceMutationResultV1 {
    return this.webhooks.changeSubscription(rawCommand);
  }

  rotateWebhookSecret(
    rawCommand: unknown,
  ): ReturnType<WebhookAuthority["rotateSecret"]> {
    return this.webhooks.rotateSecret(rawCommand);
  }

  listWebhookSubscriptions(
    merchantId: string,
  ): readonly CommerceWebhookSubscriptionV1[] {
    return this.webhooks.listSubscriptions(merchantId);
  }

  /** Posts due webhook deliveries; run after commands and from the alarm. */
  dispatchWebhooks(
    sender: WebhookSender,
  ): ReturnType<WebhookAuthority["dispatch"]> {
    return this.webhooks.dispatch(sender);
  }

  /** Reports plugin function failures; returns how many it reported. */
  reportPluginFailures(): number {
    return this.plugins.reportFailures();
  }

  /**
   * Runs merchant plugin event handlers; returns now when events wait for
   * another pass, else null.
   */
  async runPluginHandlers(): Promise<string | null> {
    return (await this.plugins.runHandlers()) >= HANDLER_RUNS
      ? this.now()
      : null;
  }

  runPluginAction(rawCommand: unknown): CommerceMutationResultV1 {
    return this.plugins.runAction(rawCommand);
  }
}
