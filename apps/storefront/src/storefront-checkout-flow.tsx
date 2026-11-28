import type {
  CommerceBuyerCartLineV1,
  CommerceBuyerOrderV1,
  CommerceBuyerOrderRecoveryV1,
  CommerceBuyerPaymentSessionV1,
  CommerceBuyerQuotedCheckoutV1,
  CommerceBuyerQuotedShippingCheckoutV1,
  CommerceBuyerShippingAddressAcceptanceV1,
  CommercePaymentClientConfirmationV1,
} from "@purin-labs/commerce-client";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import {
  buyerClientError,
  isQuoteExpiredError,
  paymentSessionError,
  shippingCheckoutError,
} from "./checkout-errors.ts";
import type { StorefrontApp } from "./storefront.tsx";
import type {
  BuyerContext,
  BuyerOrderAccess,
  CafeSelection,
  Feedback,
  PreparedBuyerCart,
  ShippingAddressCorrectionContinuation,
  ShippingAddressDraft,
  StorefrontState,
} from "./storefront-types.ts";
import {
  cafeCheckoutLines,
  cafeInterfaceCopy,
  cafeSelection,
  shippingBasketCartLines,
  shippingBasketCheckoutLines,
  shippingSelection,
  shippingServiceSelection,
} from "./storefront-basket.tsx";
import {
  createOrderAccess,
  newRunId,
  normalizedBuyerContact,
  normalizedShippingAddress,
  quoteHasExpired,
  shippingAddressForCountry,
} from "./shipping-address.ts";
import {
  buyerContactPolicy,
  configurationFulfillment,
  formatDate,
} from "./order-presentation.ts";
import {
  activeCartForSession,
  clearStoredCheckoutContext,
  contextWithSubmittedCart,
  pickupReceipt,
  sameBuyerCartLines,
  saveOrderReceipt,
  saveOrderStatusUrl,
  saveStoredCheckoutContext,
  shippingReceipt,
} from "./checkout-recovery.ts";

export const storefrontCheckoutFlow = {
  async refreshPickupQuote(
    this: StorefrontApp,
    current: Variant<StorefrontState, "pickup_quote">,
  ): Promise<void> {
    const config = this.props.config;
    if (config.kind !== "cafe" || current.context.basket.kind !== "cafe")
      return;
    const selection = cafeSelection(current.context.catalog, config);
    if (!selection.ok) {
      this.setState({
        ...current,
        feedback: { kind: "error", message: selection.message },
      });
      return;
    }
    this.setState({ kind: "quoting", context: current.context });
    const result = await this.client.refreshPickupCheckout(
      config.merchantId,
      config.storefrontId,
      current.quote.checkoutId,
      current.context.session.token,
      {
        schemaVersion: "commerce.refresh-buyer-pickup-checkout.v1",
        idempotencyKey: `${newRunId()}_checkout`,
        checkoutRevision: current.quote.revision,
        quoteDigest: current.quote.quote.quoteDigest,
        lines: cafeCheckoutLines(current.context.basket, selection.value),
      },
    );
    if (!result.ok) {
      if (isQuoteExpiredError(result.error)) {
        this.setState({
          ...current,
          expired: true,
          feedback: { kind: "none" },
        });
        return;
      }
      this.setState({
        ...current,
        feedback: {
          kind: "error",
          message: buyerClientError(result.error),
        },
      });
      return;
    }
    this.setState({
      ...current,
      quote: result.value,
      expired: false,
      feedback: { kind: "none" },
    });
  },

  async refreshShippingQuote(
    this: StorefrontApp,
    current: Variant<StorefrontState, "shipping_quote">,
  ): Promise<void> {
    const config = this.props.config;
    if (
      config.kind !== "shipping" ||
      current.context.basket.kind !== "shipping"
    )
      return;
    const selection = shippingSelection(
      current.context.catalog,
      current.context.basket,
    );
    if (!selection.ok) {
      this.setState({
        ...current,
        feedback: { kind: "error", message: selection.message },
      });
      return;
    }
    await this.validateShippingAddress(current.context, {
      kind: "refresh",
      quote: current.quote,
      operationId: newRunId(),
    });
  },

  async submitShippingRefresh(
    this: StorefrontApp,
    context: BuyerContext,
    quote: CommerceBuyerQuotedShippingCheckoutV1,
    operationId: string,
    address: ShippingAddressDraft,
    acceptance: CommerceBuyerShippingAddressAcceptanceV1,
  ): Promise<void> {
    const config = this.props.config;
    if (config.kind !== "shipping" || context.basket.kind !== "shipping")
      return;
    const selection = shippingSelection(context.catalog, context.basket);
    const serviceSelection = shippingServiceSelection(
      context.catalog,
      context.basket,
    );
    if (!selection.ok) {
      this.setState({
        kind: "catalog",
        context,
        continuation: { kind: "shipping", quote },
        feedback: { kind: "error", message: selection.message },
      });
      return;
    }
    if (!serviceSelection.ok) {
      this.setState({
        kind: "catalog",
        context,
        continuation: { kind: "shipping", quote },
        feedback: { kind: "error", message: serviceSelection.message },
      });
      return;
    }
    this.setState({ kind: "quoting", context });
    const result = await this.client.refreshShippingCheckout(
      config.merchantId,
      config.storefrontId,
      quote.checkoutId,
      context.session.token,
      {
        schemaVersion: "commerce.refresh-buyer-shipping-checkout.v1",
        idempotencyKey: `${operationId}_checkout`,
        checkoutRevision: quote.revision,
        quoteDigest: quote.quote.quoteDigest,
        lines: shippingBasketCheckoutLines(context.basket),
        shippingServiceCode: serviceSelection.value.service.code,
        shippingDestination: {
          kind: "provided_address",
          address: normalizedShippingAddress(address),
          acceptance,
        },
      },
    );
    if (!result.ok) {
      if (isQuoteExpiredError(result.error)) {
        this.setState({
          kind: "shipping_quote",
          context,
          quote,
          expired: true,
          feedback: { kind: "none" },
        });
        return;
      }
      this.setState({
        kind: "shipping_quote",
        context,
        quote,
        expired: quoteHasExpired(quote),
        feedback: {
          kind: "error",
          message: shippingCheckoutError(result.error),
        },
      });
      return;
    }
    this.setState({
      kind: "shipping_quote",
      context,
      quote: result.value,
      expired: false,
      feedback: { kind: "none" },
    });
  },

  async submitCafeQuote(
    this: StorefrontApp,
    context: BuyerContext,
    selection: CafeSelection,
  ): Promise<void> {
    const config = this.props.config;
    if (config.kind !== "cafe") return;
    if (context.basket.kind !== "cafe") return;
    this.setState({ kind: "quoting", context });
    const lines = cafeCheckoutLines(context.basket, selection);
    const prepared = await this.prepareBuyerCart(context, lines);
    if (!prepared.ok) {
      this.setState({
        kind: "catalog",
        context,
        continuation: { kind: "new" },
        feedback: { kind: "error", message: prepared.message },
      });
      return;
    }
    const result = await this.client.createPickupCheckout(
      config.merchantId,
      config.storefrontId,
      prepared.context.session.token,
      {
        schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
        idempotencyKey: `${prepared.context.runId}_checkout`,
        cartId: prepared.cart.cartId,
        cartRevision: prepared.cart.revision,
        buyer: {
          kind: "guest",
          contact: normalizedBuyerContact(
            prepared.context.basket.buyerContact,
            buyerContactPolicy(prepared.context.session),
          ),
        },
      },
    );
    if (!result.ok) {
      this.setState({
        kind: "catalog",
        context: prepared.context,
        continuation: { kind: "new" },
        feedback: {
          kind: "error",
          message: buyerClientError(result.error),
        },
      });
      return;
    }
    const submittedContext = contextWithSubmittedCart(
      prepared.context,
      prepared.cart,
      result.value.checkoutId,
    );
    saveStoredCheckoutContext(config, submittedContext);
    this.setState({
      kind: "pickup_quote",
      context: submittedContext,
      quote: result.value,
      expired: false,
      feedback: { kind: "none" },
    });
  },

  async prepareBuyerCart(
    this: StorefrontApp,
    context: BuyerContext,
    lines: readonly CommerceBuyerCartLineV1[],
  ): Promise<PreparedBuyerCart> {
    const config = this.props.config;
    if (context.cart.kind === "submitted") {
      return { ok: false, message: "This cart has already been submitted." };
    }
    if (
      context.cart.kind === "active" &&
      sameBuyerCartLines(context.cart.cart.lines, lines)
    ) {
      return { ok: true, context, cart: context.cart.cart };
    }
    const result =
      context.cart.kind === "active"
        ? await this.client.replaceCart(
            config.merchantId,
            config.storefrontId,
            context.cart.cart.cartId,
            context.session.token,
            {
              schemaVersion: "commerce.replace-buyer-cart.v1",
              idempotencyKey: `${context.runId}_cart_replace`,
              cartRevision: context.cart.cart.revision,
              lines,
            },
          )
        : await this.client.createCart(
            config.merchantId,
            config.storefrontId,
            context.session.token,
            {
              schemaVersion: "commerce.create-buyer-cart.v1",
              idempotencyKey: `${context.runId}_cart_create`,
              lines,
            },
          );
    if (!result.ok)
      return { ok: false, message: buyerClientError(result.error) };
    const cart = activeCartForSession(
      result.value,
      context.session,
      configurationFulfillment(config),
      context.cart.kind === "active" ? context.cart.cart.cartId : undefined,
      context.cart.kind === "active" ? context.cart.cart.revision + 1 : 1,
    );
    const expectedRevision =
      context.cart.kind === "active" ? context.cart.cart.revision + 1 : 1;
    if (cart === undefined || cart.revision !== expectedRevision) {
      return {
        ok: false,
        message: "This cart is no longer available for checkout.",
      };
    }
    const nextContext: BuyerContext = {
      ...context,
      cart: { kind: "active", cart },
    };
    saveStoredCheckoutContext(config, nextContext);
    return { ok: true, context: nextContext, cart };
  },

  async validateShippingAddress(
    this: StorefrontApp,
    context: BuyerContext,
    continuation: ShippingAddressCorrectionContinuation,
  ): Promise<void> {
    const config = this.props.config;
    if (config.kind !== "shipping" || context.basket.kind !== "shipping")
      return;
    this.setState({ kind: "quoting", context });
    const result = await this.client.validateShippingAddress(
      config.merchantId,
      config.storefrontId,
      context.session.token,
      {
        schemaVersion: "commerce.validate-buyer-shipping-address.v1",
        idempotencyKey: `${continuation.operationId}_address_validation`,
        address: normalizedShippingAddress(context.basket.address),
      },
    );
    if (!result.ok) {
      this.restoreShippingCatalog(context, continuation, {
        kind: "error",
        message: buyerClientError(result.error),
      });
      return;
    }
    switch (result.value.state) {
      case "accepted": {
        const address = shippingAddressForCountry(
          result.value.address,
          context.basket.address.countryCode,
        );
        if (address === undefined) {
          this.restoreShippingCatalog(context, continuation, {
            kind: "error",
            message: "Address validation returned another destination.",
          });
          return;
        }
        this.continueWithValidatedShippingAddress(
          context,
          continuation,
          address,
          {
            kind: "accepted_as_entered",
            addressValidationReference: result.value.validationReference,
          },
        );
        return;
      }
      case "correction_required":
        if (
          shippingAddressForCountry(
            result.value.proposedAddress,
            context.basket.address.countryCode,
          ) === undefined
        ) {
          this.restoreShippingCatalog(context, continuation, {
            kind: "error",
            message: "Address validation returned another destination.",
          });
          return;
        }
        this.setState({
          kind: "shipping_address_correction",
          context,
          validation: result.value,
          continuation,
        });
        return;
      case "unserviceable":
        this.restoreShippingCatalog(context, continuation, {
          kind: "error",
          message: result.value.reason,
        });
        return;
      case "indeterminate":
        this.restoreShippingCatalog(context, continuation, {
          kind: "notice",
          message: `Address validation is still being checked. Try again after ${formatDate(
            result.value.retryAfter,
            "shipping",
            this.cafeLanguage,
          )}.`,
        });
        return;
      default:
        return assertNever(result.value, "Unhandled storefront state");
    }
  },

  continueWithValidatedShippingAddress(
    this: StorefrontApp,
    context: BuyerContext,
    continuation: ShippingAddressCorrectionContinuation,
    address: ShippingAddressDraft,
    acceptance: CommerceBuyerShippingAddressAcceptanceV1,
  ): void {
    if (context.basket.kind !== "shipping") return;
    const selectedAddress = shippingAddressForCountry(
      address,
      context.basket.address.countryCode,
    );
    if (selectedAddress === undefined) {
      this.restoreShippingCatalog(context, continuation, {
        kind: "error",
        message: "Address validation returned another destination.",
      });
      return;
    }
    const nextContext: BuyerContext = {
      ...context,
      basket: {
        ...context.basket,
        address: normalizedShippingAddress(selectedAddress),
      },
    };
    saveStoredCheckoutContext(this.props.config, nextContext);
    switch (continuation.kind) {
      case "new":
        void this.submitShippingQuote(
          nextContext,
          continuation.operationId,
          selectedAddress,
          acceptance,
        );
        return;
      case "refresh":
        void this.submitShippingRefresh(
          nextContext,
          continuation.quote,
          continuation.operationId,
          selectedAddress,
          acceptance,
        );
        return;
      default:
        return assertNever(continuation, "Unhandled storefront state");
    }
  },

  restoreShippingCatalog(
    this: StorefrontApp,
    context: BuyerContext,
    continuation: ShippingAddressCorrectionContinuation,
    feedback: Feedback,
  ): void {
    this.setState({
      kind: "catalog",
      context,
      continuation:
        continuation.kind === "refresh"
          ? { kind: "shipping", quote: continuation.quote }
          : { kind: "new" },
      feedback,
    });
  },

  async submitShippingQuote(
    this: StorefrontApp,
    context: BuyerContext,
    operationId: string,
    address: ShippingAddressDraft,
    acceptance: CommerceBuyerShippingAddressAcceptanceV1,
  ): Promise<void> {
    const config = this.props.config;
    if (config.kind !== "shipping") return;
    if (context.basket.kind !== "shipping") return;
    const serviceSelection = shippingServiceSelection(
      context.catalog,
      context.basket,
    );
    const selection = shippingSelection(context.catalog, context.basket);
    if (!selection.ok) {
      this.setState({
        kind: "catalog",
        context,
        continuation: { kind: "new" },
        feedback: { kind: "error", message: selection.message },
      });
      return;
    }
    if (!serviceSelection.ok) {
      this.setState({
        kind: "catalog",
        context,
        continuation: { kind: "new" },
        feedback: { kind: "error", message: serviceSelection.message },
      });
      return;
    }
    this.setState({ kind: "quoting", context });
    const prepared = await this.prepareBuyerCart(
      context,
      shippingBasketCartLines(context.basket),
    );
    if (!prepared.ok) {
      this.setState({
        kind: "catalog",
        context,
        continuation: { kind: "new" },
        feedback: { kind: "error", message: prepared.message },
      });
      return;
    }
    const result = await this.client.createShippingCheckout(
      config.merchantId,
      config.storefrontId,
      prepared.context.session.token,
      {
        schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
        idempotencyKey: `${operationId}_checkout`,
        cartId: prepared.cart.cartId,
        cartRevision: prepared.cart.revision,
        shippingServiceCode: serviceSelection.value.service.code,
        buyer: {
          kind: "guest",
          contact: normalizedBuyerContact(
            prepared.context.basket.buyerContact,
            buyerContactPolicy(prepared.context.session),
          ),
        },
        shippingDestination: {
          kind: "provided_address",
          address: normalizedShippingAddress(address),
          acceptance,
        },
      },
    );
    if (!result.ok) {
      this.setState({
        kind: "catalog",
        context: prepared.context,
        continuation: { kind: "new" },
        feedback: {
          kind: "error",
          message: shippingCheckoutError(result.error),
        },
      });
      return;
    }
    const submittedContext = contextWithSubmittedCart(
      prepared.context,
      prepared.cart,
      result.value.checkoutId,
    );
    saveStoredCheckoutContext(config, submittedContext);
    this.setState({
      kind: "shipping_quote",
      context: submittedContext,
      quote: result.value,
      expired: false,
      feedback: { kind: "none" },
    });
  },

  async submitPickupPayment(
    this: StorefrontApp,
    context: BuyerContext,
    quote: CommerceBuyerQuotedCheckoutV1,
  ): Promise<void> {
    this.setState({ kind: "paying_pickup", context, quote });
    saveOrderReceipt(
      pickupReceipt(quote, context, this.props.config, this.cafeLanguage),
    );
    const payment = await this.createPaymentSession(
      context,
      quote.checkoutId,
      quote.revision,
      quote.quote.quoteDigest,
    );
    if (payment === undefined) return;
    this.setState({ kind: "payment_pickup", context, quote, payment });
  },

  async submitShippingPayment(
    this: StorefrontApp,
    context: BuyerContext,
    quote: CommerceBuyerQuotedShippingCheckoutV1,
  ): Promise<void> {
    this.setState({ kind: "paying_shipping", context, quote });
    saveOrderReceipt(shippingReceipt(quote, context));
    const payment = await this.createPaymentSession(
      context,
      quote.checkoutId,
      quote.revision,
      quote.quote.quoteDigest,
    );
    if (payment === undefined) return;
    this.setState({ kind: "payment_shipping", context, quote, payment });
  },

  async createPaymentSession(
    this: StorefrontApp,
    context: BuyerContext,
    checkoutId: string,
    checkoutRevision: number,
    quoteDigest: string,
  ): Promise<
    VariantBy<CommerceBuyerPaymentSessionV1, "state", "ready"> | undefined
  > {
    const config = this.props.config;
    const result = await this.client.createPaymentSession(
      config.merchantId,
      config.storefrontId,
      checkoutId,
      context.session.token,
      {
        schemaVersion: "commerce.create-buyer-payment-session.v1",
        idempotencyKey: `${context.runId}_payment`,
        checkoutRevision,
        quoteDigest,
        returnUrl: window.location.href,
      },
    );
    if (!result.ok) {
      if (isQuoteExpiredError(result.error)) {
        this.restoreExpiredQuote(context);
        return undefined;
      }
      this.restoreQuoteWithError(
        context,
        paymentSessionError(result.error, this.cafeLanguage),
      );
      return undefined;
    }
    if (result.value.state === "unavailable") {
      this.restoreQuoteWithError(
        context,
        `Payment collection is temporarily unavailable. Try again after ${formatDate(result.value.retryAfter, this.props.config.kind, this.cafeLanguage)}.`,
      );
      return undefined;
    }
    return result.value;
  },

  async reconcilePickupPayment(
    this: StorefrontApp,
    context: BuyerContext,
    quote: CommerceBuyerQuotedCheckoutV1,
    confirmation: CommercePaymentClientConfirmationV1,
  ): Promise<void> {
    this.setState({ kind: "paying_pickup", context, quote });
    const recovery = await this.reconcileQuote(
      context,
      quote.checkoutId,
      quote.revision,
      quote.quote.quoteDigest,
      confirmation,
    );
    if (recovery !== undefined)
      await this.readPlacedOrder(quote.checkoutId, recovery, "pickup");
  },

  async reconcileShippingPayment(
    this: StorefrontApp,
    context: BuyerContext,
    quote: CommerceBuyerQuotedShippingCheckoutV1,
    confirmation: CommercePaymentClientConfirmationV1,
  ): Promise<void> {
    this.setState({ kind: "paying_shipping", context, quote });
    const recovery = await this.reconcileQuote(
      context,
      quote.checkoutId,
      quote.revision,
      quote.quote.quoteDigest,
      confirmation,
    );
    if (recovery !== undefined)
      await this.readPlacedOrder(quote.checkoutId, recovery, "shipping");
  },

  async reconcileQuote(
    this: StorefrontApp,
    context: BuyerContext,
    checkoutId: string,
    checkoutRevision: number,
    quoteDigest: string,
    confirmation: CommercePaymentClientConfirmationV1,
  ): Promise<CommerceBuyerOrderRecoveryV1 | undefined> {
    const config = this.props.config;
    const result = await this.client.reconcilePayment(
      config.merchantId,
      config.storefrontId,
      checkoutId,
      context.session.token,
      {
        schemaVersion: "commerce.reconcile-buyer-payment.v1",
        idempotencyKey: `${context.runId}_payment`,
        checkoutRevision,
        quoteDigest,
        confirmation,
      },
    );
    if (!result.ok) {
      if (isQuoteExpiredError(result.error)) {
        this.restoreExpiredQuote(context);
        return undefined;
      }
      this.restoreQuoteWithError(context, buyerClientError(result.error));
      return undefined;
    }
    switch (result.value.state) {
      case "declined":
        this.setState({
          kind: "declined",
          context,
          reasonCode: result.value.reasonCode,
        });
        return undefined;
      case "processing":
      case "indeterminate": {
        const current = this.state;
        if (current.kind === "paying_pickup") {
          this.setState({
            kind: "indeterminate_pickup",
            context,
            quote: current.quote,
            reconcileAfter: result.value.reconcileAfter,
          });
        } else if (current.kind === "paying_shipping") {
          this.setState({
            kind: "indeterminate_shipping",
            context,
            quote: current.quote,
            reconcileAfter: result.value.reconcileAfter,
          });
        }
        return undefined;
      }
      case "placed":
        return result.value.orderRecovery;
      default:
        return assertNever(result.value, "Unhandled storefront state");
    }
  },

  restoreQuoteWithError(
    this: StorefrontApp,
    context: BuyerContext,
    message: string,
  ): void {
    const current = this.state;
    if (current.kind === "paying_pickup") {
      this.setState({
        kind: "pickup_quote",
        context,
        quote: current.quote,
        expired: quoteHasExpired(current.quote),
        feedback: { kind: "error", message },
      });
    } else if (current.kind === "paying_shipping") {
      this.setState({
        kind: "shipping_quote",
        context,
        quote: current.quote,
        expired: quoteHasExpired(current.quote),
        feedback: { kind: "error", message },
      });
    }
  },

  restoreExpiredQuote(this: StorefrontApp, context: BuyerContext): void {
    const current = this.state;
    if (current.kind === "paying_pickup") {
      this.setState({
        kind: "pickup_quote",
        context,
        quote: current.quote,
        expired: true,
        feedback: { kind: "none" },
      });
    } else if (current.kind === "paying_shipping") {
      this.setState({
        kind: "shipping_quote",
        context,
        quote: current.quote,
        expired: true,
        feedback: { kind: "none" },
      });
    }
  },

  async readPlacedOrder(
    this: StorefrontApp,
    checkoutId: string,
    recovery: CommerceBuyerOrderRecoveryV1,
    fulfillment: "pickup" | "shipping",
  ): Promise<void> {
    const config = this.props.config;
    const access = createOrderAccess(checkoutId, recovery.token);
    const result = await this.client.recoverOrder(
      config.merchantId,
      config.storefrontId,
      checkoutId,
      access.token,
    );
    if (!result.ok || result.value.fulfillment !== fulfillment) {
      const current = this.state;
      const context =
        current.kind === "paying_pickup" || current.kind === "paying_shipping"
          ? current.context
          : undefined;
      if (context === undefined) return;
      this.restoreQuoteWithError(
        context,
        result.ok
          ? "The order response did not match this storefront."
          : buyerClientError(result.error),
      );
      return;
    }
    window.history.replaceState(null, "", access.returnUrl);
    saveOrderStatusUrl(config, access.returnUrl);
    clearStoredCheckoutContext(config);
    this.showOrder(access, result.value);
  },

  showOrder(
    this: StorefrontApp,
    access: BuyerOrderAccess,
    order: CommerceBuyerOrderV1,
  ): void {
    if (order.fulfillment === "pickup") {
      this.setState({
        kind: "pickup_order",
        access,
        order,
        feedback: { kind: "none" },
      });
      return;
    }
    this.setState({
      kind: "shipping_order",
      access,
      order,
      feedback: { kind: "none" },
    });
  },

  async writeOrderLink(
    this: StorefrontApp,
    current: Variant<StorefrontState, "pickup_order" | "shipping_order">,
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(current.access.returnUrl);
      const message =
        current.kind === "pickup_order"
          ? cafeInterfaceCopy(this.cafeLanguage).linkCopied
          : "Order link copied.";
      this.setState({ ...current, feedback: { kind: "notice", message } });
    } catch {
      this.setState({
        ...current,
        feedback: {
          kind: "error",
          message:
            "Copying failed. Select the private link and copy it manually.",
        },
      });
    }
  },

  async pollOrder(
    this: StorefrontApp,
    current: Variant<StorefrontState, "pickup_order" | "shipping_order">,
  ): Promise<void> {
    const config = this.props.config;
    const result = await this.client.recoverOrder(
      config.merchantId,
      config.storefrontId,
      current.access.checkoutId,
      current.access.token,
    );
    if (!result.ok) {
      this.setState({
        ...current,
        feedback: { kind: "error", message: buyerClientError(result.error) },
      });
      return;
    }
    if (
      current.kind === "pickup_order" &&
      result.value.fulfillment === "pickup"
    ) {
      this.setState({
        ...current,
        order: result.value,
        feedback: { kind: "none" },
      });
      return;
    }
    if (
      current.kind === "shipping_order" &&
      result.value.fulfillment === "shipping"
    ) {
      this.setState({
        ...current,
        order: result.value,
        feedback: { kind: "none" },
      });
      return;
    }
    this.setState({
      ...current,
      feedback: {
        kind: "error",
        message: "The order response did not match this storefront.",
      },
    });
  },
};
