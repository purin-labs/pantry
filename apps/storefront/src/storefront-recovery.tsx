import type {
  CommerceBuyerCatalogV1,
  CommerceBuyerQuotedCheckoutV1,
  CommerceBuyerQuotedShippingCheckoutV1,
} from "@purin-labs/commerce-client";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import { buyerClientError, isQuoteExpiredError } from "./checkout-errors.ts";
import type { StorefrontApp } from "./storefront.tsx";
import {
  activeCartForSession,
  clearOrderStatusUrl,
  clearStoredCheckoutContext,
  isMissingBuyerCart,
  isMissingBuyerCheckout,
  isUnavailableBuyerSession,
  locationHasOrderAccessIntent,
  readStoredCheckoutRecovery,
  recoveryFromLocation,
  restoredBasket,
  saveOrderStatusUrl,
  saveStoredCheckoutContext,
  submittedCartForSession,
} from "./checkout-recovery.ts";
import {
  buyerContactPolicy,
  configurationFulfillment,
  formatDate,
  invalidOrderAccessMessage,
  isTerminalOrderAccessError,
  profileAllowsFulfillment,
} from "./order-presentation.ts";
import { newRunId, quoteHasExpired } from "./shipping-address.ts";
import type {
  BuyerCartState,
  BuyerContext,
  BuyerContextRecovery,
  StoredCheckoutRecovery,
  StorefrontConfiguration,
} from "./storefront-types.ts";
import { initialBasket } from "./storefront-basket.tsx";

export const storefrontRecovery = {
  async bootstrap(this: StorefrontApp): Promise<void> {
    this.cafeContactSubmitted = false;
    this.shippingFormSubmitted = false;
    this.setState({ kind: "booting" });
    const config = this.props.config;
    const recovery = recoveryFromLocation(window.location);
    if (
      recovery === undefined &&
      locationHasOrderAccessIntent(window.location)
    ) {
      clearOrderStatusUrl(config);
      this.setState({
        kind: "failed",
        failure: {
          kind: "order_access",
          message: invalidOrderAccessMessage(
            config.kind,
            this.cafeLanguage,
            false,
          ),
        },
      });
      return;
    }
    if (recovery !== undefined) {
      const order = await this.client.recoverOrder(
        config.merchantId,
        config.storefrontId,
        recovery.checkoutId,
        recovery.token,
      );
      if (!order.ok) {
        if (isTerminalOrderAccessError(order.error)) {
          clearOrderStatusUrl(config);
          this.setState({
            kind: "failed",
            failure: {
              kind: "order_access",
              message: invalidOrderAccessMessage(
                config.kind,
                this.cafeLanguage,
                false,
              ),
            },
          });
        } else {
          this.setState({
            kind: "failed",
            failure: {
              kind: "storefront",
              message: buyerClientError(order.error),
            },
          });
        }
        return;
      }
      if (order.value.fulfillment !== configurationFulfillment(config)) {
        clearOrderStatusUrl(config);
        this.setState({
          kind: "failed",
          failure: {
            kind: "order_access",
            message: invalidOrderAccessMessage(
              config.kind,
              this.cafeLanguage,
              true,
            ),
          },
        });
        return;
      }
      saveOrderStatusUrl(config, recovery.returnUrl);
      this.showOrder(recovery, order.value);
      return;
    }
    const recovered = await this.recoverBuyerContext(config);
    if (recovered.kind === "failed") {
      this.setState({
        kind: "failed",
        failure: { kind: "storefront", message: recovered.message },
      });
      return;
    }
    if (recovered.kind === "recovered") {
      this.setState({
        kind: "catalog",
        context: recovered.context,
        continuation: { kind: "new" },
        feedback: { kind: "none" },
      });
      return;
    }
    if (recovered.kind === "recovered_pickup_quote") {
      this.setState({
        kind: "pickup_quote",
        context: recovered.context,
        quote: recovered.quote,
        expired: quoteHasExpired(recovered.quote),
        feedback: { kind: "none" },
      });
      return;
    }
    if (recovered.kind === "recovered_shipping_quote") {
      this.setState({
        kind: "shipping_quote",
        context: recovered.context,
        quote: recovered.quote,
        expired: quoteHasExpired(recovered.quote),
        feedback: { kind: "none" },
      });
      return;
    }
    if (recovered.kind === "recovered_pickup_payment") {
      this.setState({
        kind: "payment_pickup",
        context: recovered.context,
        quote: recovered.quote,
        payment: recovered.payment,
      });
      return;
    }
    if (recovered.kind === "recovered_shipping_payment") {
      this.setState({
        kind: "payment_shipping",
        context: recovered.context,
        quote: recovered.quote,
        payment: recovered.payment,
      });
      return;
    }
    if (recovered.kind === "recovered_declined") {
      this.setState({
        kind: "declined",
        context: recovered.context,
        reasonCode: recovered.reasonCode,
      });
      return;
    }
    if (recovered.kind === "recovered_pickup_indeterminate") {
      this.setState({
        kind: "indeterminate_pickup",
        context: recovered.context,
        quote: recovered.quote,
        reconcileAfter: recovered.reconcileAfter,
      });
      return;
    }
    if (recovered.kind === "recovered_shipping_indeterminate") {
      this.setState({
        kind: "indeterminate_shipping",
        context: recovered.context,
        quote: recovered.quote,
        reconcileAfter: recovered.reconcileAfter,
      });
      return;
    }
    const session = await this.client.createSession(
      config.merchantId,
      config.storefrontId,
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok) {
      this.setState({
        kind: "failed",
        failure: {
          kind: "storefront",
          message: buyerClientError(session.error),
        },
      });
      return;
    }
    const catalog = await this.client.readCatalog(
      config.merchantId,
      config.storefrontId,
      session.value.token,
    );
    if (!catalog.ok) {
      this.setState({
        kind: "failed",
        failure: {
          kind: "storefront",
          message: buyerClientError(catalog.error),
        },
      });
      return;
    }
    if (
      catalog.value.storefront.storefrontId !== config.storefrontId ||
      catalog.value.storefront.fulfillment !== configurationFulfillment(config)
    ) {
      this.setState({
        kind: "failed",
        failure: {
          kind: "storefront",
          message: "This storefront configuration is unavailable.",
        },
      });
      return;
    }
    if (
      !profileAllowsFulfillment(
        session.value,
        catalog.value.storefront.fulfillment,
      )
    ) {
      this.setState({
        kind: "failed",
        failure: {
          kind: "storefront",
          message:
            "This checkout profile does not allow this storefront's fulfillment.",
        },
      });
      return;
    }
    this.applySessionPresentation(session.value);
    const context: BuyerContext = {
      session: session.value,
      catalog: catalog.value,
      runId: newRunId(),
      basket: initialBasket(config, catalog.value),
      cart: { kind: "absent" },
    };
    saveStoredCheckoutContext(config, context);
    this.setState({
      kind: "catalog",
      context,
      continuation: { kind: "new" },
      feedback: { kind: "none" },
    });
  },

  async recoverBuyerContext(
    this: StorefrontApp,
    config: StorefrontConfiguration,
  ): Promise<BuyerContextRecovery> {
    const stored = readStoredCheckoutRecovery(config);
    if (stored === undefined) return { kind: "new_session" };
    this.applySessionPresentation(stored.session);
    const catalog = await this.client.readCatalog(
      config.merchantId,
      config.storefrontId,
      stored.session.token,
    );
    if (!catalog.ok) {
      if (isUnavailableBuyerSession(catalog.error)) {
        clearStoredCheckoutContext(config);
        return { kind: "new_session" };
      }
      return { kind: "failed", message: buyerClientError(catalog.error) };
    }
    if (
      catalog.value.storefront.storefrontId !== config.storefrontId ||
      catalog.value.storefront.fulfillment !== configurationFulfillment(config)
    ) {
      clearStoredCheckoutContext(config);
      return { kind: "new_session" };
    }
    if (
      !profileAllowsFulfillment(
        stored.session,
        catalog.value.storefront.fulfillment,
      )
    ) {
      return {
        kind: "failed",
        message:
          "This checkout profile does not allow this storefront's fulfillment.",
      };
    }
    if (stored.cart.kind === "submitted") {
      return this.recoverSubmittedCheckout(
        config,
        stored,
        catalog.value,
        stored.cart,
      );
    }
    let cart: BuyerCartState = { kind: "absent" };
    if (stored.cart.kind === "active") {
      const recoveredCart = await this.client.readCart(
        config.merchantId,
        config.storefrontId,
        stored.cart.cartId,
        stored.session.token,
      );
      if (!recoveredCart.ok && isUnavailableBuyerSession(recoveredCart.error)) {
        clearStoredCheckoutContext(config);
        return { kind: "new_session" };
      }
      if (!recoveredCart.ok && !isMissingBuyerCart(recoveredCart.error)) {
        return {
          kind: "failed",
          message: buyerClientError(recoveredCart.error),
        };
      }
      if (recoveredCart.ok) {
        if (recoveredCart.value.state === "submitted") {
          const submitted = submittedCartForSession(
            recoveredCart.value,
            stored.session,
            configurationFulfillment(config),
            stored.cart.cartId,
            stored.cart.revision,
          );
          if (submitted === undefined) {
            clearStoredCheckoutContext(config);
            return { kind: "new_session" };
          }
          return this.recoverSubmittedCheckout(
            config,
            stored,
            catalog.value,
            submitted,
          );
        }
        const active = activeCartForSession(
          recoveredCart.value,
          stored.session,
          configurationFulfillment(config),
          stored.cart.cartId,
          stored.cart.revision,
        );
        if (active !== undefined) cart = { kind: "active", cart: active };
      }
    }
    const context: BuyerContext = {
      session: stored.session,
      catalog: catalog.value,
      runId: stored.operationId,
      basket: restoredBasket(
        config,
        catalog.value,
        stored.basket,
        buyerContactPolicy(stored.session),
      ),
      cart,
    };
    saveStoredCheckoutContext(config, context);
    return { kind: "recovered", context };
  },

  async recoverSubmittedCheckout(
    this: StorefrontApp,
    config: StorefrontConfiguration,
    stored: StoredCheckoutRecovery,
    catalog: CommerceBuyerCatalogV1,
    cart: Variant<BuyerCartState, "submitted">,
  ): Promise<BuyerContextRecovery> {
    const checkout = await this.client.readCheckout(
      config.merchantId,
      config.storefrontId,
      cart.checkoutId,
      stored.session.token,
    );
    if (!checkout.ok) {
      if (
        isUnavailableBuyerSession(checkout.error) ||
        isMissingBuyerCheckout(checkout.error)
      ) {
        clearStoredCheckoutContext(config);
        return { kind: "new_session" };
      }
      return { kind: "failed", message: buyerClientError(checkout.error) };
    }
    const quote = checkout.value.checkout;
    if (quote.checkoutId !== cart.checkoutId) {
      clearStoredCheckoutContext(config);
      return { kind: "new_session" };
    }
    const context: BuyerContext = {
      session: stored.session,
      catalog,
      runId: stored.operationId,
      basket: restoredBasket(
        config,
        catalog,
        stored.basket,
        buyerContactPolicy(stored.session),
      ),
      cart,
    };
    if (
      (config.kind === "cafe" &&
        quote.schemaVersion !== "commerce.buyer-quoted-checkout.v1") ||
      (config.kind === "shipping" &&
        quote.schemaVersion !== "commerce.buyer-quoted-shipping-checkout.v1")
    ) {
      clearStoredCheckoutContext(config);
      return { kind: "new_session" };
    }
    saveStoredCheckoutContext(config, context);
    if (checkout.value.progress.state === "quoted") {
      return quote.schemaVersion === "commerce.buyer-quoted-checkout.v1"
        ? { kind: "recovered_pickup_quote", context, quote }
        : { kind: "recovered_shipping_quote", context, quote };
    }
    switch (checkout.value.progress.payment.state) {
      case "pending":
        return this.recoverPendingPaymentSession(config, context, quote);
      case "captured":
        return quote.schemaVersion === "commerce.buyer-quoted-checkout.v1"
          ? {
              kind: "recovered_pickup_indeterminate",
              context,
              quote,
              reconcileAfter: new Date().toISOString(),
            }
          : {
              kind: "recovered_shipping_indeterminate",
              context,
              quote,
              reconcileAfter: new Date().toISOString(),
            };
      case "declined":
        return {
          kind: "recovered_declined",
          context,
          reasonCode: checkout.value.progress.payment.reasonCode,
        };
      case "processing":
      case "indeterminate":
        return quote.schemaVersion === "commerce.buyer-quoted-checkout.v1"
          ? {
              kind: "recovered_pickup_indeterminate",
              context,
              quote,
              reconcileAfter: checkout.value.progress.payment.reconcileAfter,
            }
          : {
              kind: "recovered_shipping_indeterminate",
              context,
              quote,
              reconcileAfter: checkout.value.progress.payment.reconcileAfter,
            };
      default:
        return assertNever(
          checkout.value.progress.payment,
          "Unhandled storefront state",
        );
    }
  },

  async recoverPendingPaymentSession(
    this: StorefrontApp,
    config: StorefrontConfiguration,
    context: BuyerContext,
    quote:
      CommerceBuyerQuotedCheckoutV1 | CommerceBuyerQuotedShippingCheckoutV1,
  ): Promise<BuyerContextRecovery> {
    const result = await this.client.createPaymentSession(
      config.merchantId,
      config.storefrontId,
      quote.checkoutId,
      context.session.token,
      {
        schemaVersion: "commerce.create-buyer-payment-session.v1",
        idempotencyKey: `${context.runId}_payment`,
        checkoutRevision: quote.revision,
        quoteDigest: quote.quote.quoteDigest,
        returnUrl: window.location.href,
      },
    );
    if (!result.ok) {
      if (isQuoteExpiredError(result.error)) {
        return quote.schemaVersion === "commerce.buyer-quoted-checkout.v1"
          ? { kind: "recovered_pickup_quote", context, quote }
          : { kind: "recovered_shipping_quote", context, quote };
      }
      return { kind: "failed", message: buyerClientError(result.error) };
    }
    if (result.value.state === "unavailable") {
      return {
        kind: "failed",
        message: `Payment collection is temporarily unavailable. Try again after ${formatDate(result.value.retryAfter, config.kind, this.cafeLanguage)}.`,
      };
    }
    return quote.schemaVersion === "commerce.buyer-quoted-checkout.v1"
      ? {
          kind: "recovered_pickup_payment",
          context,
          quote,
          payment: result.value,
        }
      : {
          kind: "recovered_shipping_payment",
          context,
          quote,
          payment: result.value,
        };
  },
};
