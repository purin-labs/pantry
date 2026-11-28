import React from "react";
import {
  CommerceStorefrontClient,
  type CommerceBuyerSessionV4,
  type CommercePaymentClientConfirmationV1,
} from "@purin-labs/commerce-client";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isRecord } from "@purin-labs/std";
import {
  CatalogSkeleton,
  CheckoutSkeleton,
  PatisserieMenuSkeleton,
} from "./skeletons.tsx";
import type {
  BuyerBasket,
  BuyerContactDraft,
  BuyerContext,
  CafeConfiguration,
  ShippingBasket,
  ShippingConfiguration,
  SquarePayments,
  StorefrontAppProps,
  StorefrontConfiguration,
  StorefrontState,
  StripeClient,
} from "./storefront-types.ts";
import {
  clearOrderStatusUrl,
  locationHasOrderAccessIntent,
  parseCafeLanguage,
  readCafeLanguage,
  readKioskMode,
  recoveryFromLocation,
  saveCafeLanguage,
  saveStoredCheckoutContext,
} from "./checkout-recovery.ts";
import {
  buyerContactPolicy,
  buyerPhoneIsVisible,
  failureViewCopy,
  focusPageHeading,
  formatDate,
  languageFromLocale,
  orderNeedsPolling,
  scrollToLocationAnchor,
  statePresentsPageHeading,
  statusMessage,
} from "./order-presentation.ts";
import {
  boundedQuantity,
  cafeBasketHasItems,
  cafeBasketQuantity,
  cafeInterfaceCopy,
  cafeSelection,
  hasCafeProductSelectionId,
  initialShippingAddress,
  resolvedShippingServiceCode,
  shippingBasketItem,
  shippingBasketWithQuantity,
  shippingSelection,
  shippingServiceSelection,
  uniqueListing,
  uniqueShippingService,
  withCafeModifier,
  withCafeQuantity,
} from "./storefront-basket.tsx";
import { storefrontRecovery } from "./storefront-recovery.tsx";
import {
  focusFirstInvalidField,
  newRunId,
  parseShippingCountry,
  quoteHasExpired,
  shippingAddressForCountry,
  shippingAddressWithField,
} from "./shipping-address.ts";
import type { ShippingAddressField } from "./shipping-address.ts";
import { storefrontCheckoutFlow } from "./storefront-checkout-flow.tsx";
import { storefrontOrderViews } from "./storefront-order-views.tsx";
import { StatusView } from "./storefront-views.tsx";
import { ProviderPaymentView } from "./provider-payment.tsx";
import { storefrontCatalogViews } from "./storefront-catalog-views.tsx";
export {
  orderNeedsPolling,
  profileAllowsFulfillment,
} from "./order-presentation.ts";
export { parseStoredCheckoutRecovery } from "./checkout-recovery.ts";
export { normalizedBuyerContact } from "./shipping-address.ts";

declare global {
  interface Window {
    Stripe?: (
      publishableKey: string,
      options: Readonly<{ stripeAccount: string }>,
    ) => StripeClient;
    Square?: Readonly<{
      payments: (applicationId: string, locationId: string) => SquarePayments;
    }>;
  }
}

const MERCHANT_ID = "merchant_nuki_cafe_demo";

const CAFE_CONFIGURATION: CafeConfiguration = {
  kind: "cafe",
  merchantId: MERCHANT_ID,
  storefrontId: "storefront_cafe",
  name: "Nuki Café",
  showcase: true,
  presentation: "nuki",
};

const SHIPPING_CONFIGURATION: ShippingConfiguration = {
  kind: "shipping",
  merchantId: MERCHANT_ID,
  storefrontId: "storefront_cookie_store_sg",
  name: "Nuki Cookie Post",
};

/**
 * The shop of a page. `orderPageMeta` is the content of the
 * `commerce-shop` meta tag, which the shop Worker adds to an order page
 * after it looks up the shop name in the page's path.
 */
export function storefrontConfiguration(
  pathname: string,
  orderPageMeta: string | null = null,
): StorefrontConfiguration {
  // An order page names its storefront; the path cannot open another.
  const orderPage = orderPageShop(orderPageMeta);
  if (orderPage !== undefined)
    return shopConfiguration(
      orderPage.merchantId,
      orderPage.storefrontId,
      "menu",
    );
  if (pathname === "/store/shipping") return SHIPPING_CONFIGURATION;
  const shop = /^\/shops\/([A-Za-z0-9_-]+)\/?$/u.exec(pathname);
  if (shop !== null)
    return shopConfiguration(shop[1] ?? "", CAFE_STOREFRONT_ID, "menu");
  // A site built for one shop, such as shop.purin.io, opens that shop.
  const homeShop: unknown = import.meta.env.VITE_SHOP_MERCHANT_ID;
  return typeof homeShop === "string" && homeShop.length > 0
    ? shopConfiguration(homeShop, CAFE_STOREFRONT_ID, "patisserie")
    : CAFE_CONFIGURATION;
}

const CAFE_STOREFRONT_ID = "storefront_cafe";

function orderPageShop(
  content: string | null,
): Readonly<{ merchantId: string; storefrontId: string }> | undefined {
  if (content === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  return isRecord(value) &&
    typeof value.merchantId === "string" &&
    value.merchantId.length > 0 &&
    typeof value.storefrontId === "string" &&
    value.storefrontId.length > 0
    ? { merchantId: value.merchantId, storefrontId: value.storefrontId }
    : undefined;
}

function shopConfiguration(
  merchantId: string,
  storefrontId: string,
  presentation: CafeConfiguration["presentation"],
): CafeConfiguration {
  return {
    kind: "cafe",
    merchantId,
    storefrontId,
    name: "Café",
    showcase: false,
    presentation,
  };
}

export class StorefrontApp extends React.Component<
  StorefrontAppProps,
  StorefrontState
> {
  state: StorefrontState = { kind: "booting" };
  readonly client = new CommerceStorefrontClient({
    baseUrl: window.location.origin,
  });
  cafeLanguage = readCafeLanguage();
  kioskMode = false;
  cafeContactSubmitted = false;
  /** The pâtisserie site's cart drawer. */
  cartOpen = false;
  shippingFormSubmitted = false;
  private hasPresentedPage = false;
  private pollTimer: number | undefined;
  private quoteTimer: number | undefined;

  applySessionPresentation = (session: CommerceBuyerSessionV4): void => {
    const presentation =
      session.checkoutProfileConfiguration.presentationPolicy;
    this.cafeLanguage = languageFromLocale(presentation.locale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = presentation.locale;
      document.title = `${presentation.merchantDisplayName} · Purin Checkout`;
    }
  };

  componentDidMount(): void {
    document.title = `${this.props.config.name} · Purin Checkout`;
    document.documentElement.lang =
      this.props.config.kind === "cafe"
        ? cafeInterfaceCopy(this.cafeLanguage).htmlLanguage
        : "en";
    this.kioskMode = readKioskMode(
      this.props.config,
      window.location,
    );
    window.addEventListener("hashchange", this.handleHashChange);
    void this.bootstrap();
  }

  handleHashChange = (): void => {
    const current = this.state;
    const recovery = recoveryFromLocation(window.location);
    if (
      recovery === undefined &&
      !locationHasOrderAccessIntent(window.location)
    ) {
      if (window.location.hash.length > 0 || current.kind === "catalog") return;
    }
    if (
      (current.kind === "pickup_order" || current.kind === "shipping_order") &&
      recovery !== undefined &&
      recovery.checkoutId === current.access.checkoutId
    ) {
      return;
    }
    if (
      current.kind === "booting" ||
      current.kind === "quoting" ||
      current.kind === "paying_pickup" ||
      current.kind === "paying_shipping"
    ) {
      return;
    }
    this.cancelPoll();
    this.cancelQuoteTimer();
    void this.bootstrap();
  };

  componentDidUpdate(
    previousProps: StorefrontAppProps,
    previousState: StorefrontState,
  ): void {
    if (previousProps.config !== this.props.config) {
      this.cancelPoll();
      void this.bootstrap();
      return;
    }
    if (
      previousState.kind !== this.state.kind &&
      statePresentsPageHeading(this.state)
    ) {
      if (this.hasPresentedPage) {
        focusPageHeading();
      } else {
        scrollToLocationAnchor();
      }
      this.hasPresentedPage = true;
    }
    if (previousState !== this.state) {
      this.schedulePoll();
      this.scheduleQuoteExpiry();
    }
  }

  componentWillUnmount(): void {
    window.removeEventListener("hashchange", this.handleHashChange);
    this.cancelPoll();
    this.cancelQuoteTimer();
  }

  bootstrap(...args: Parameters<typeof storefrontRecovery.bootstrap>) {
    return storefrontRecovery.bootstrap.apply(this, args);
  }

  recoverBuyerContext(
    ...args: Parameters<typeof storefrontRecovery.recoverBuyerContext>
  ) {
    return storefrontRecovery.recoverBuyerContext.apply(this, args);
  }

  recoverSubmittedCheckout(
    ...args: Parameters<typeof storefrontRecovery.recoverSubmittedCheckout>
  ) {
    return storefrontRecovery.recoverSubmittedCheckout.apply(this, args);
  }

  recoverPendingPaymentSession(
    ...args: Parameters<typeof storefrontRecovery.recoverPendingPaymentSession>
  ) {
    return storefrontRecovery.recoverPendingPaymentSession.apply(this, args);
  }

  createCafeQuote = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const current = this.state;
    if (current.kind !== "catalog" || this.props.config.kind !== "cafe") return;
    if (!event.currentTarget.checkValidity()) {
      this.cafeContactSubmitted = true;
      focusFirstInvalidField(event.currentTarget);
      this.setState({ ...current, feedback: { kind: "none" } });
      return;
    }
    this.cafeContactSubmitted = false;
    const selection = cafeSelection(current.context.catalog, this.props.config);
    if (!selection.ok) {
      this.setState({
        ...current,
        feedback: { kind: "error", message: selection.message },
      });
      return;
    }
    if (
      current.context.basket.kind !== "cafe" ||
      !cafeBasketHasItems(current.context.basket)
    ) {
      this.setState({
        ...current,
        feedback: {
          kind: "error",
          message: "Add at least one item to review your order.",
        },
      });
      return;
    }
    if (current.continuation.kind === "pickup") {
      void this.refreshPickupQuote({
        kind: "pickup_quote",
        context: current.context,
        quote: current.continuation.quote,
        expired: quoteHasExpired(current.continuation.quote),
        feedback: { kind: "none" },
      });
      return;
    }
    void this.submitCafeQuote(current.context, selection.value);
  };

  updateCafeQuantity = (menuEntryId: string, quantity: number): void => {
    const current = this.state;
    if (current.kind !== "catalog" || current.context.basket.kind !== "cafe")
      return;
    const basket = withCafeQuantity(
      current.context.basket,
      menuEntryId,
      boundedQuantity(quantity),
    );
    this.updateBasket(current, basket);
  };

  decreaseCafeQuantity = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const current = this.state;
    if (current.kind !== "catalog" || current.context.basket.kind !== "cafe")
      return;
    const menuEntryId = this.cafeItemKey(event.currentTarget.dataset.itemKey);
    if (menuEntryId === undefined) return;
    this.updateCafeQuantity(
      menuEntryId,
      cafeBasketQuantity(current.context.basket, menuEntryId) - 1,
    );
  };

  increaseCafeQuantity = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const current = this.state;
    if (current.kind !== "catalog" || current.context.basket.kind !== "cafe")
      return;
    const menuEntryId = this.cafeItemKey(event.currentTarget.dataset.itemKey);
    if (menuEntryId === undefined) return;
    this.updateCafeQuantity(
      menuEntryId,
      cafeBasketQuantity(current.context.basket, menuEntryId) + 1,
    );
  };

  changeCafeModifier = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const menuEntryId = this.cafeItemKey(
      event.currentTarget.dataset.menuEntryId,
    );
    if (menuEntryId === undefined) return;
    this.toggleCafeModifier(menuEntryId, event.currentTarget.value);
  };

  /** The basket key of an item that the current menu shows. */
  cafeItemKey(value: string | undefined): string | undefined {
    const current = this.state;
    if (
      value === undefined ||
      current.kind !== "catalog" ||
      this.props.config.kind !== "cafe"
    )
      return undefined;
    const selection = cafeSelection(current.context.catalog, this.props.config);
    return selection.ok &&
      selection.value.products.some(
        hasCafeProductSelectionId.bind(undefined, value),
      )
      ? value
      : undefined;
  }

  changeCafeLanguage = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    if (this.props.config.kind !== "cafe") return;
    const language = parseCafeLanguage(event.currentTarget.value);
    if (language === undefined) return;
    this.cafeLanguage = language;
    saveCafeLanguage(language);
    document.documentElement.lang = cafeInterfaceCopy(language).htmlLanguage;
    this.forceUpdate();
  };

  toggleCafeModifier = (
    menuEntryId: string,
    modifierOptionId: string,
  ): void => {
    const current = this.state;
    if (current.kind !== "catalog" || current.context.basket.kind !== "cafe")
      return;
    const basket = withCafeModifier(
      current.context.basket,
      menuEntryId,
      modifierOptionId,
    );
    this.updateBasket(current, basket);
  };

  updateBuyerContact = (
    field: keyof BuyerContactDraft,
    value: string,
  ): void => {
    const current = this.state;
    if (current.kind !== "catalog") return;
    if (
      field === "phone" &&
      !buyerPhoneIsVisible(buyerContactPolicy(current.context.session))
    )
      return;
    const basket: BuyerBasket = {
      ...current.context.basket,
      buyerContact: { ...current.context.basket.buyerContact, [field]: value },
    };
    this.updateBasket(current, basket);
  };

  changeBuyerEmail = (event: React.ChangeEvent<HTMLInputElement>): void => {
    this.updateBuyerContact("email", event.currentTarget.value);
  };

  changeBuyerPhone = (event: React.ChangeEvent<HTMLInputElement>): void => {
    this.updateBuyerContact("phone", event.currentTarget.value);
  };

  updateShippingSelection = (variantId: string, quantity: number): void => {
    const current = this.state;
    if (
      current.kind !== "catalog" ||
      current.context.basket.kind !== "shipping"
    )
      return;
    const listing = uniqueListing(current.context.catalog.listings, variantId);
    if (listing === undefined || listing.availability !== "available") return;
    const basket = shippingBasketWithQuantity(
      current.context.basket,
      variantId,
      quantity,
    );
    this.updateBasket(current, basket);
  };

  decreaseShippingQuantity = (
    event: React.MouseEvent<HTMLButtonElement>,
  ): void => {
    const current = this.state;
    if (
      current.kind !== "catalog" ||
      current.context.basket.kind !== "shipping"
    )
      return;
    const variantId = event.currentTarget.dataset.itemKey;
    if (variantId === undefined) return;
    const item = shippingBasketItem(current.context.basket, variantId);
    if (item === undefined) return;
    this.updateShippingSelection(variantId, item.quantity - 1);
  };

  increaseShippingQuantity = (
    event: React.MouseEvent<HTMLButtonElement>,
  ): void => {
    const current = this.state;
    if (
      current.kind !== "catalog" ||
      current.context.basket.kind !== "shipping"
    )
      return;
    const variantId = event.currentTarget.dataset.itemKey;
    if (variantId === undefined) return;
    const basket = current.context.basket;
    const item = shippingBasketItem(basket, variantId);
    this.updateShippingSelection(
      variantId,
      item === undefined ? 1 : item.quantity + 1,
    );
  };

  updateShippingAddress = (
    field: ShippingAddressField,
    value: string,
  ): void => {
    const current = this.state;
    if (
      current.kind !== "catalog" ||
      current.context.basket.kind !== "shipping"
    )
      return;
    const address = shippingAddressWithField(
      current.context.basket.address,
      field,
      value,
    );
    if (address === undefined) return;
    const basket: ShippingBasket = {
      ...current.context.basket,
      address,
    };
    this.updateBasket(current, basket);
  };

  updateBasket(
    current: Variant<StorefrontState, "catalog">,
    basket: BuyerBasket,
  ): void {
    const context: BuyerContext = {
      ...current.context,
      basket,
      runId: newRunId(),
    };
    saveStoredCheckoutContext(this.props.config, context);
    this.setState({ ...current, context, feedback: { kind: "none" } });
  }

  changeRecipientName = (event: React.ChangeEvent<HTMLInputElement>): void => {
    this.updateShippingAddress("recipientName", event.currentTarget.value);
  };

  changeAddressLine1 = (event: React.ChangeEvent<HTMLInputElement>): void => {
    this.updateShippingAddress("addressLine1", event.currentTarget.value);
  };

  changePostalCode = (event: React.ChangeEvent<HTMLInputElement>): void => {
    this.updateShippingAddress("postalCode", event.currentTarget.value);
  };

  changeShippingLocality = (
    event: React.ChangeEvent<HTMLInputElement>,
  ): void => {
    this.updateShippingAddress("locality", event.currentTarget.value);
  };

  changeShippingAdministrativeArea = (
    event: React.ChangeEvent<HTMLInputElement>,
  ): void => {
    this.updateShippingAddress("administrativeArea", event.currentTarget.value);
  };

  changeShippingCountry = (
    event: React.ChangeEvent<HTMLSelectElement>,
  ): void => {
    const current = this.state;
    if (
      current.kind !== "catalog" ||
      current.context.basket.kind !== "shipping"
    )
      return;
    const countryCode = parseShippingCountry(event.currentTarget.value);
    if (countryCode === undefined) return;
    const basket: ShippingBasket = {
      ...current.context.basket,
      address: initialShippingAddress(countryCode),
      shippingServiceCode: resolvedShippingServiceCode(
        current.context.catalog,
        countryCode,
        undefined,
      ),
    };
    this.updateBasket(current, basket);
  };

  changeShippingService = (
    event: React.ChangeEvent<HTMLInputElement>,
  ): void => {
    const current = this.state;
    if (
      current.kind !== "catalog" ||
      current.context.basket.kind !== "shipping"
    )
      return;
    const service = uniqueShippingService(
      current.context.catalog,
      current.context.basket.address.countryCode,
      event.currentTarget.value,
    );
    if (service === undefined) return;
    const basket: ShippingBasket = {
      ...current.context.basket,
      shippingServiceCode: service.service.code,
    };
    this.updateBasket(current, basket);
  };

  retryBootstrap = (): void => {
    void this.bootstrap();
  };

  returnToStore = (): void => {
    clearOrderStatusUrl(this.props.config);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    void this.bootstrap();
  };

  editBasket = (): void => {
    const current = this.state;
    if (current.kind !== "pickup_quote" && current.kind !== "shipping_quote")
      return;
    this.cancelQuoteTimer();
    this.setState({
      kind: "catalog",
      context: current.context,
      continuation:
        current.kind === "pickup_quote"
          ? { kind: "pickup", quote: current.quote }
          : { kind: "shipping", quote: current.quote },
      feedback: { kind: "none" },
    });
  };

  refreshQuote = (): void => {
    const current = this.state;
    if (current.kind === "pickup_quote") void this.refreshPickupQuote(current);
    if (current.kind === "shipping_quote")
      void this.refreshShippingQuote(current);
  };

  refreshPickupQuote(
    ...args: Parameters<typeof storefrontCheckoutFlow.refreshPickupQuote>
  ) {
    return storefrontCheckoutFlow.refreshPickupQuote.apply(this, args);
  }

  refreshShippingQuote(
    ...args: Parameters<typeof storefrontCheckoutFlow.refreshShippingQuote>
  ) {
    return storefrontCheckoutFlow.refreshShippingQuote.apply(this, args);
  }

  submitShippingRefresh(
    ...args: Parameters<typeof storefrontCheckoutFlow.submitShippingRefresh>
  ) {
    return storefrontCheckoutFlow.submitShippingRefresh.apply(this, args);
  }

  submitCafeQuote(
    ...args: Parameters<typeof storefrontCheckoutFlow.submitCafeQuote>
  ) {
    return storefrontCheckoutFlow.submitCafeQuote.apply(this, args);
  }

  prepareBuyerCart(
    ...args: Parameters<typeof storefrontCheckoutFlow.prepareBuyerCart>
  ) {
    return storefrontCheckoutFlow.prepareBuyerCart.apply(this, args);
  }

  createShippingQuote = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const current = this.state;
    if (current.kind !== "catalog" || this.props.config.kind !== "shipping")
      return;
    if (current.context.basket.kind !== "shipping") return;
    const form = event.currentTarget;
    if (!form.checkValidity()) {
      this.shippingFormSubmitted = true;
      focusFirstInvalidField(form);
      this.setState({ ...current, feedback: { kind: "none" } });
      return;
    }
    this.shippingFormSubmitted = false;
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
    const serviceSelection = shippingServiceSelection(
      current.context.catalog,
      current.context.basket,
    );
    if (!serviceSelection.ok) {
      this.setState({
        ...current,
        feedback: { kind: "error", message: serviceSelection.message },
      });
      return;
    }
    if (current.continuation.kind === "shipping") {
      void this.refreshShippingQuote({
        kind: "shipping_quote",
        context: current.context,
        quote: current.continuation.quote,
        expired: quoteHasExpired(current.continuation.quote),
        feedback: { kind: "none" },
      });
      return;
    }
    void this.validateShippingAddress(current.context, {
      kind: "new",
      operationId: current.context.runId,
    });
  };

  validateShippingAddress(
    ...args: Parameters<typeof storefrontCheckoutFlow.validateShippingAddress>
  ) {
    return storefrontCheckoutFlow.validateShippingAddress.apply(this, args);
  }

  acceptShippingAddressCorrection = (): void => {
    const current = this.state;
    if (current.kind !== "shipping_address_correction") return;
    if (current.context.basket.kind !== "shipping") return;
    const address = shippingAddressForCountry(
      current.validation.proposedAddress,
      current.context.basket.address.countryCode,
    );
    if (address === undefined) {
      this.restoreShippingCatalog(current.context, current.continuation, {
        kind: "error",
        message: "Address validation returned another destination.",
      });
      return;
    }
    this.continueWithValidatedShippingAddress(
      current.context,
      current.continuation,
      address,
      {
        kind: "accepted_correction",
        addressValidationReference: current.validation.validationReference,
      },
    );
  };

  editShippingAddressCorrection = (): void => {
    const current = this.state;
    if (current.kind !== "shipping_address_correction") return;
    this.restoreShippingCatalog(current.context, current.continuation, {
      kind: "none",
    });
  };

  continueWithValidatedShippingAddress(
    ...args: Parameters<
      typeof storefrontCheckoutFlow.continueWithValidatedShippingAddress
    >
  ) {
    return storefrontCheckoutFlow.continueWithValidatedShippingAddress.apply(
      this,
      args,
    );
  }

  restoreShippingCatalog(
    ...args: Parameters<typeof storefrontCheckoutFlow.restoreShippingCatalog>
  ) {
    return storefrontCheckoutFlow.restoreShippingCatalog.apply(this, args);
  }

  submitShippingQuote(
    ...args: Parameters<typeof storefrontCheckoutFlow.submitShippingQuote>
  ) {
    return storefrontCheckoutFlow.submitShippingQuote.apply(this, args);
  }

  pay = (): void => {
    const current = this.state;
    if (current.kind === "pickup_quote" && !current.expired)
      void this.submitPickupPayment(current.context, current.quote);
    if (current.kind === "shipping_quote" && !current.expired)
      void this.submitShippingPayment(current.context, current.quote);
    if (current.kind === "indeterminate_pickup")
      void this.reconcilePickupPayment(current.context, current.quote, {
        kind: "provider_ui_completed",
      });
    if (current.kind === "indeterminate_shipping")
      void this.reconcileShippingPayment(current.context, current.quote, {
        kind: "provider_ui_completed",
      });
  };

  submitPickupPayment(
    ...args: Parameters<typeof storefrontCheckoutFlow.submitPickupPayment>
  ) {
    return storefrontCheckoutFlow.submitPickupPayment.apply(this, args);
  }

  submitShippingPayment(
    ...args: Parameters<typeof storefrontCheckoutFlow.submitShippingPayment>
  ) {
    return storefrontCheckoutFlow.submitShippingPayment.apply(this, args);
  }

  createPaymentSession(
    ...args: Parameters<typeof storefrontCheckoutFlow.createPaymentSession>
  ) {
    return storefrontCheckoutFlow.createPaymentSession.apply(this, args);
  }

  confirmProviderPayment = (
    confirmation: CommercePaymentClientConfirmationV1,
  ): void => {
    const current = this.state;
    if (current.kind === "payment_pickup")
      void this.reconcilePickupPayment(
        current.context,
        current.quote,
        confirmation,
      );
    if (current.kind === "payment_shipping")
      void this.reconcileShippingPayment(
        current.context,
        current.quote,
        confirmation,
      );
  };

  reconcilePickupPayment(
    ...args: Parameters<typeof storefrontCheckoutFlow.reconcilePickupPayment>
  ) {
    return storefrontCheckoutFlow.reconcilePickupPayment.apply(this, args);
  }

  reconcileShippingPayment(
    ...args: Parameters<typeof storefrontCheckoutFlow.reconcileShippingPayment>
  ) {
    return storefrontCheckoutFlow.reconcileShippingPayment.apply(this, args);
  }

  reconcileQuote(
    ...args: Parameters<typeof storefrontCheckoutFlow.reconcileQuote>
  ) {
    return storefrontCheckoutFlow.reconcileQuote.apply(this, args);
  }

  restoreQuoteWithError(
    ...args: Parameters<typeof storefrontCheckoutFlow.restoreQuoteWithError>
  ) {
    return storefrontCheckoutFlow.restoreQuoteWithError.apply(this, args);
  }

  restoreExpiredQuote(
    ...args: Parameters<typeof storefrontCheckoutFlow.restoreExpiredQuote>
  ) {
    return storefrontCheckoutFlow.restoreExpiredQuote.apply(this, args);
  }

  readPlacedOrder(
    ...args: Parameters<typeof storefrontCheckoutFlow.readPlacedOrder>
  ) {
    return storefrontCheckoutFlow.readPlacedOrder.apply(this, args);
  }

  showOrder(...args: Parameters<typeof storefrontCheckoutFlow.showOrder>) {
    return storefrontCheckoutFlow.showOrder.apply(this, args);
  }

  startNewOrder = (): void => {
    const current = this.state;
    if (current.kind !== "declined") return;
    const context: BuyerContext = {
      ...current.context,
      runId: newRunId(),
      cart: { kind: "absent" },
    };
    saveStoredCheckoutContext(this.props.config, context);
    this.setState({
      kind: "catalog",
      context,
      continuation: { kind: "new" },
      feedback: { kind: "none" },
    });
  };

  copyOrderLink = (): void => {
    const current = this.state;
    if (current.kind !== "pickup_order" && current.kind !== "shipping_order")
      return;
    void this.writeOrderLink(current);
  };

  writeOrderLink(
    ...args: Parameters<typeof storefrontCheckoutFlow.writeOrderLink>
  ) {
    return storefrontCheckoutFlow.writeOrderLink.apply(this, args);
  }

  clearPickupKiosk = (): void => {
    if (this.state.kind !== "pickup_order" || this.props.config.kind !== "cafe")
      return;
    this.cancelPoll();
    clearOrderStatusUrl(this.props.config);
    window.history.replaceState(null, "", window.location.pathname);
    void this.bootstrap();
  };

  refreshOrder = (): void => {
    const current = this.state;
    if (current.kind !== "pickup_order" && current.kind !== "shipping_order")
      return;
    void this.pollOrder(current);
  };

  pollOrder(...args: Parameters<typeof storefrontCheckoutFlow.pollOrder>) {
    return storefrontCheckoutFlow.pollOrder.apply(this, args);
  }

  schedulePoll(): void {
    this.cancelPoll();
    if (
      this.state.kind !== "pickup_order" &&
      this.state.kind !== "shipping_order"
    )
      return;
    if (!orderNeedsPolling(this.state.order)) return;
    this.pollTimer = window.setTimeout(this.refreshOrder, 4_000);
  }

  cancelPoll(): void {
    if (this.pollTimer !== undefined) window.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  scheduleQuoteExpiry(): void {
    this.cancelQuoteTimer();
    const current = this.state;
    if (
      (current.kind !== "pickup_quote" && current.kind !== "shipping_quote") ||
      current.expired
    )
      return;
    const delay = Date.parse(current.quote.quote.expiresAt) - Date.now();
    if (delay <= 0) {
      this.markQuoteExpired();
      return;
    }
    this.quoteTimer = window.setTimeout(this.markQuoteExpired, delay);
  }

  markQuoteExpired = (): void => {
    const current = this.state;
    if (current.kind === "pickup_quote" || current.kind === "shipping_quote") {
      this.setState({ ...current, expired: true, feedback: { kind: "none" } });
    }
  };

  cancelQuoteTimer(): void {
    if (this.quoteTimer !== undefined) window.clearTimeout(this.quoteTimer);
    this.quoteTimer = undefined;
  }

  render(): React.ReactNode {
    const orderStatusHref = this.orderStatusHref();
    const cafeCopy = cafeInterfaceCopy(this.cafeLanguage);
    const showingOrderStatus =
      this.state.kind === "pickup_order" ||
      this.state.kind === "shipping_order";
    const context = "context" in this.state ? this.state.context : undefined;
    const merchantDisplayName =
      context === undefined
        ? this.props.config.name
        : context.session.checkoutProfileConfiguration.presentationPolicy
            .merchantDisplayName;
    const patisserie =
      this.props.config.kind === "cafe" &&
      this.props.config.presentation === "patisserie";
    // An order page shows only the shop's own name: no demo tagline or mark.
    const orderPage =
      this.props.config.kind === "cafe" &&
      this.props.config.presentation === "menu";
    // The cart drawer belongs to the menu; a checkout or an order closes it.
    if (this.state.kind !== "catalog") this.cartOpen = false;
    // An order page (`menu.<domain>/<shop name>/` or `/shops/<merchantId>`)
    // links to its own path.
    const homeHref = orderPage
      ? window.location.pathname
      : patisserie
        ? "/"
        : this.props.config.kind === "cafe"
          ? "/store/cafe"
          : "/store/shipping";
    return (
      <div
        className={`storefront storefront-${this.props.config.kind}${patisserie ? " storefront-patisserie" : ""}`}
      >
        <a className="skip-link" href="#main">
          {this.props.config.kind === "cafe"
            ? cafeCopy.skipLink
            : "Skip to shopping"}
        </a>
        <header className="site-header">
          <a className="wordmark" href={homeHref}>
            {patisserie ? null : (
              <span aria-hidden="true" className="wordmark-mark">
                {orderPage ? merchantDisplayName.slice(0, 1) : "N"}
              </span>
            )}
            <span className="wordmark-copy">
              <strong>{merchantDisplayName}</strong>
              {orderPage ? null : (
                <small>
                  {this.props.config.kind === "cafe"
                    ? cafeCopy.headerDetail
                    : "Baked in Tokyo · Delivered abroad"}
                </small>
              )}
            </span>
          </a>
          <div className="site-actions">
            {this.props.config.kind === "cafe" ? (
              <label className="language-select">
                <span className="sr-only">{cafeCopy.languageLabel}</span>
                <select
                  aria-label={cafeCopy.languageLabel}
                  value={this.cafeLanguage}
                  onChange={this.changeCafeLanguage}
                >
                  <option value="en">English</option>
                  <option value="ja">日本語</option>
                </select>
              </label>
            ) : null}
            {/* On the pâtisserie menu the section bar holds these links. */}
            {patisserie && this.state.kind === "catalog" ? null : (
              <nav aria-label="Store" className="store-nav">
                <a
                  aria-current={showingOrderStatus ? undefined : "page"}
                  href={homeHref}
                >
                  {this.props.config.kind === "cafe"
                    ? cafeCopy.menuNav
                    : "Shop"}
                </a>
                {orderStatusHref === undefined ? null : (
                  <a
                    aria-current={showingOrderStatus ? "page" : undefined}
                    href={orderStatusHref}
                  >
                    {this.props.config.kind === "cafe"
                      ? cafeCopy.orderStatusNav
                      : "Order status"}
                  </a>
                )}
              </nav>
            )}
          </div>
        </header>
        <main
          id="main"
          className={`store-main store-main-${this.props.config.kind}`}
          tabIndex={-1}
        >
          {this.renderState()}
        </main>
        <footer className="site-footer">
          <div className="site-footer-brand">
            <strong>{merchantDisplayName}</strong>
            <p>
              {this.props.config.kind === "cafe"
                ? cafeCopy.footerPickup
                : "Carrier service and estimated delivery dates are confirmed in your quote."}
            </p>
          </div>
          <div className="site-footer-meta">
            <p>
              {this.props.config.kind === "cafe"
                ? cafeCopy.footerTrust
                : "Shipping, duty, and tax shown before payment · Prices in JPY"}
            </p>
            <a href="#main">
              {this.props.config.kind === "cafe" && this.cafeLanguage === "ja"
                ? "ページ上部へ"
                : "Back to top"}
            </a>
          </div>
        </footer>
        <div className="sr-only" role="status">
          {statusMessage(this.state)}
        </div>
      </div>
    );
  }

  orderStatusHref(
    ...args: Parameters<typeof storefrontOrderViews.orderStatusHref>
  ) {
    return storefrontOrderViews.orderStatusHref.apply(this, args);
  }

  renderState(): React.ReactNode {
    switch (this.state.kind) {
      case "booting": {
        const label =
          this.cafeLanguage === "ja"
            ? "本日のメニューを読み込んでいます"
            : "Loading today’s menu";
        return this.props.config.kind === "cafe" &&
          this.props.config.presentation === "patisserie" ? (
          <PatisserieMenuSkeleton label={label} />
        ) : (
          <CatalogSkeleton label={label} />
        );
      }
      case "failed": {
        const copy = failureViewCopy(
          this.props.config.kind,
          this.cafeLanguage,
          this.state.failure.kind,
        );
        return (
          <StatusView
            title={copy.title}
            detail={this.state.failure.message}
            actionLabel={copy.action}
            onAction={
              this.state.failure.kind === "order_access"
                ? this.returnToStore
                : this.retryBootstrap
            }
          />
        );
      }
      case "catalog":
        return this.props.config.kind === "cafe"
          ? this.renderCafeCatalog(this.state, this.props.config)
          : this.renderShippingCatalog(this.state);
      case "quoting":
        return (
          <CheckoutSkeleton
            label={
              this.cafeLanguage === "ja"
                ? "ご注文の内容を準備しています"
                : "Preparing your order"
            }
          />
        );
      case "shipping_address_correction":
        return this.renderShippingAddressCorrection(this.state);
      case "pickup_quote":
        return this.renderPickupQuote(this.state);
      case "shipping_quote":
        return this.renderShippingQuote(this.state);
      case "paying_pickup":
      case "paying_shipping":
        return (
          <StatusView
            title="Placing your order"
            detail="Confirming payment securely and reserving stock."
            busy
          />
        );
      case "payment_pickup":
        return (
          <ProviderPaymentView
            session={this.state.payment.session}
            total={this.state.quote.quote.totals.total}
            onConfirmed={this.confirmProviderPayment}
          />
        );
      case "payment_shipping":
        return (
          <ProviderPaymentView
            session={this.state.payment.session}
            total={this.state.quote.quote.totals.total}
            onConfirmed={this.confirmProviderPayment}
          />
        );
      case "declined":
        return (
          <StatusView
            title="The payment was declined"
            detail={`Reason: ${this.state.reasonCode}. Start a new order to try again.`}
            actionLabel="Start a new order"
            onAction={this.startNewOrder}
          />
        );
      case "indeterminate_pickup":
      case "indeterminate_shipping":
        return (
          <StatusView
            title="Payment is still being checked"
            detail={`Try again after ${formatDate(this.state.reconcileAfter, this.props.config.kind, this.cafeLanguage)}. The same payment request will be reconciled safely.`}
            actionLabel="Check payment again"
            onAction={this.pay}
          />
        );
      case "pickup_order":
        return this.renderPickupOrder(this.state);
      case "shipping_order":
        return this.renderShippingOrder(this.state);
      default:
        return assertNever(this.state, "Unhandled storefront state");
    }
  }

  renderCafeCatalog(
    ...args: Parameters<typeof storefrontCatalogViews.renderCafeCatalog>
  ) {
    return storefrontCatalogViews.renderCafeCatalog.apply(this, args);
  }

  placeBasket(...args: Parameters<typeof storefrontCatalogViews.placeBasket>) {
    return storefrontCatalogViews.placeBasket.apply(this, args);
  }

  openCart = (): void => {
    this.cartOpen = true;
    this.forceUpdate();
  };

  closeCart = (): void => {
    this.cartOpen = false;
    this.forceUpdate();
  };

  renderPatisserieMenu(
    ...args: Parameters<typeof storefrontCatalogViews.renderPatisserieMenu>
  ) {
    return storefrontCatalogViews.renderPatisserieMenu.apply(this, args);
  }

  renderPublishedMenu(
    ...args: Parameters<typeof storefrontCatalogViews.renderPublishedMenu>
  ) {
    return storefrontCatalogViews.renderPublishedMenu.apply(this, args);
  }

  renderCafeProducts(
    ...args: Parameters<typeof storefrontCatalogViews.renderCafeProducts>
  ) {
    return storefrontCatalogViews.renderCafeProducts.apply(this, args);
  }

  renderCafeProduct(
    ...args: Parameters<typeof storefrontCatalogViews.renderCafeProduct>
  ) {
    return storefrontCatalogViews.renderCafeProduct.apply(this, args);
  }

  renderShippingCatalog(
    ...args: Parameters<typeof storefrontCatalogViews.renderShippingCatalog>
  ) {
    return storefrontCatalogViews.renderShippingCatalog.apply(this, args);
  }

  renderShippingAddressCorrection(
    ...args: Parameters<
      typeof storefrontCatalogViews.renderShippingAddressCorrection
    >
  ) {
    return storefrontCatalogViews.renderShippingAddressCorrection.apply(
      this,
      args,
    );
  }

  renderShippingListings(
    ...args: Parameters<typeof storefrontCatalogViews.renderShippingListings>
  ) {
    return storefrontCatalogViews.renderShippingListings.apply(this, args);
  }

  renderShippingServiceOptions(
    ...args: Parameters<
      typeof storefrontCatalogViews.renderShippingServiceOptions
    >
  ) {
    return storefrontCatalogViews.renderShippingServiceOptions.apply(
      this,
      args,
    );
  }

  renderShippingListing(
    ...args: Parameters<typeof storefrontCatalogViews.renderShippingListing>
  ) {
    return storefrontCatalogViews.renderShippingListing.apply(this, args);
  }

  renderPickupQuote(
    ...args: Parameters<typeof storefrontOrderViews.renderPickupQuote>
  ) {
    return storefrontOrderViews.renderPickupQuote.apply(this, args);
  }

  renderShippingQuote(
    ...args: Parameters<typeof storefrontOrderViews.renderShippingQuote>
  ) {
    return storefrontOrderViews.renderShippingQuote.apply(this, args);
  }

  renderPickupOrder(
    ...args: Parameters<typeof storefrontOrderViews.renderPickupOrder>
  ) {
    return storefrontOrderViews.renderPickupOrder.apply(this, args);
  }

  renderShippingOrder(
    ...args: Parameters<typeof storefrontOrderViews.renderShippingOrder>
  ) {
    return storefrontOrderViews.renderShippingOrder.apply(this, args);
  }
}
