import type {
  CommerceBuyerCatalogListingV1,
  CommerceBuyerCatalogV1,
  CommerceBuyerCartV1,
  CommerceBuyerMenuEntryV1,
  CommerceBuyerMenuV1,
  CommerceBuyerOrderV1,
  CommerceBuyerPaymentSessionV1,
  CommerceBuyerQuotedCheckoutV1,
  CommerceBuyerQuotedShippingCheckoutV1,
  CommerceBuyerSessionV4,
  CommerceBuyerShippingAddressV1,
  CommerceBuyerShippingAddressValidationV1,
} from "@purin-labs/commerce-client";
import type { VariantBy } from "@purin-labs/type-utils";
import type { PatisserieProductId } from "./patisserie.tsx";

export type ProviderUiError = Readonly<{ message?: string }>;

export type StripePaymentElement = Readonly<{
  mount: (selector: string) => void;
  unmount: () => void;
}>;

export type StripeElements = Readonly<{
  create: (kind: "payment") => StripePaymentElement;
  submit: () => Promise<Readonly<{ error?: ProviderUiError }>>;
}>;

export type StripeClient = Readonly<{
  elements: (options: Readonly<{ clientSecret: string }>) => StripeElements;
  confirmPayment: (
    options: Readonly<{
      elements: StripeElements;
      clientSecret: string;
      confirmParams: Readonly<{ return_url: string }>;
      redirect: "if_required";
    }>,
  ) => Promise<Readonly<{ error?: ProviderUiError }>>;
}>;

export type SquareCard = Readonly<{
  attach: (selector: string) => Promise<void>;
  destroy: () => Promise<void>;
  tokenize: (
    details: Readonly<{
      amount: string;
      currencyCode: string;
      intent: "CHARGE";
    }>,
  ) => Promise<
    | Readonly<{ status: "OK"; token: string }>
    | Readonly<{ status: string; errors?: readonly ProviderUiError[] }>
  >;
}>;

export type SquarePayments = Readonly<{ card: () => Promise<SquareCard> }>;

export type ShippingListingImage = Readonly<{ imageUrl: string; imageAlt: string }>;


export type NukiCafeProductId =
  | "menu_entry_sesame_latte"
  | "menu_entry_sesame_cookie"
  | "menu_entry_sesame_financier"
  | "menu_entry_ginger_milk_tea"
  | "menu_entry_ginger_cookie"
  | "menu_entry_ginger_financier"
  | "menu_entry_taro_milk_tea"
  | "menu_entry_taro_cookie"
  | "menu_entry_taro_financier"
  | "menu_entry_matcha_tea"
  | "menu_entry_matcha_cookie"
  | "menu_entry_matcha_financier";

export type CafeProductId = NukiCafeProductId | PatisserieProductId;

type CafeFlavorId = "sesame" | "ginger" | "taro" | "matcha";

export type CafeFlavorMenuGroup = Readonly<{
  id: CafeFlavorId;
  name: string;
  items: readonly [drink: string, cookie: string, financier: string];
  productIds: readonly [
    drink: CafeProductId,
    cookie: CafeProductId,
    financier: CafeProductId,
  ];
}>;

export type CafeFlavorMenuCopy = Readonly<{
  eyebrow: string;
  heading: string;
  detail: string;
  packagingDetail: string;
  imageAlt: string;
  groups: readonly [
    CafeFlavorMenuGroup,
    CafeFlavorMenuGroup,
    CafeFlavorMenuGroup,
    CafeFlavorMenuGroup,
  ];
}>;

export type CafeInterfaceCopy = Readonly<{
  htmlLanguage: "en" | "ja";
  skipLink: string;
  languageLabel: string;
  headerDetail: string;
  menuNav: string;
  orderStatusNav: string;
  categoryMenu: string;
  categoryDrinks: string;
  categoryBakes: string;
  categoryNavigationLabel: string;
  welcome: (shopName: string) => string;
  title: string;
  introduction: string;
  pickupOpen: string;
  pickupDetail: string;
  menuEyebrow: string;
  menuHeading: string;
  madeToOrder: string;
  readyInMinutes: string;
  bakedToday: string;
  readyNow: string;
  milkChoice: string;
  oatMilk: string;
  dairyMilk: string;
  available: string;
  soldOut: string;
  addAction: string;
  addOne: string;
  removeOne: string;
  selected: string;
  orderEyebrow: string;
  basketHeading: string;
  emptyBasket: string;
  estimatedTotal: string;
  checkout: string;
  checkoutDetail: string;
  reviewEyebrow: string;
  reviewHeading: string;
  reviewDetail: string;
  quoteExpired: string;
  items: string;
  tax: string;
  taxIncluded: string;
  total: string;
  refreshQuote: string;
  pay: string;
  editOrder: string;
  paymentNote: string;
  pickupEyebrow: string;
  preparingOrder: string;
  readyForPickup: string;
  pickedUp: string;
  orderCancelled: string;
  paid: string;
  nextAction: string;
  lastUpdated: string;
  orderProgress: string;
  returnUrl: string;
  returnUrlDetail: string;
  copyLink: string;
  linkCopied: string;
  refreshStatus: string;
  kioskHeading: string;
  kioskDetail: string;
  clearKiosk: string;
  kioskConfirmHeading: string;
  kioskConfirmDetail: string;
  kioskConfirmClear: string;
  kioskConfirmKeep: string;
  pickupCodeLabel: string;
  orderSummary: string;
  pickupAt: string;
  quoteHold: string;
  qrDetail: string;
  containsLabel: string;
  todayAt: string;
  footerPickup: string;
  footerTrust: string;
}>;

export type CafeProductConfiguration = Readonly<{
  /** The basket key: a demo product's id, or a shop's own menu entry id. */
  menuEntryId: string;
  category: "drink" | "bake";
  flavor: CafeFlavorId | "patisserie" | "menu";
  imageUrl: string | undefined;
  imageAlt: string;
  /** A shop's own item states no preparation. */
  preparation: "made_to_order" | "baked_today" | "unstated";
  /** A shop's own item: the copy of its published listing. */
  copy?: CafeProductCopy;
}>;

export type CafeProductCopy = Readonly<{
  title: string;
  description: string;
  allergens: string;
}>;

/**
 * A café storefront. The Nuki Café demo is the showcase, with its own name
 * and menu art. A QR order page (`menu.<domain>/<shop name>/`, or
 * `/shops/<merchantId>`) shows the shop's published menu under the name
 * that its checkout profile presents.
 */
export type CafeConfiguration = Readonly<{
  kind: "cafe";
  merchantId: string;
  storefrontId: string;
  name: string;
  showcase: boolean;
  /**
   * The Nuki Café demo has its own menu art; the pâtisserie site at
   * shop.purin.io has its own menu and look; any other shop shows its
   * published menu as it is.
   */
  presentation: "nuki" | "patisserie" | "menu";
}>;

export type ShippingConfiguration = Readonly<{
  kind: "shipping";
  merchantId: string;
  storefrontId: "storefront_cookie_store_sg";
  name: "Nuki Cookie Post";
}>;

export type StorefrontConfiguration = CafeConfiguration | ShippingConfiguration;

export type BuyerContext = Readonly<{
  session: CommerceBuyerSessionV4;
  catalog: CommerceBuyerCatalogV1;
  runId: string;
  basket: BuyerBasket;
  cart: BuyerCartState;
}>;

export type ActiveBuyerCart = VariantBy<CommerceBuyerCartV1, "state", "active">;

export type BuyerCartState =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "active"; cart: ActiveBuyerCart }>
  | Readonly<{
      kind: "submitted";
      cartId: string;
      revision: number;
      checkoutId: string;
    }>;

export type StoredCartReference =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "active"; cartId: string; revision: number }>
  | Readonly<{
      kind: "submitted";
      cartId: string;
      revision: number;
      checkoutId: string;
    }>;

export type StoredCheckoutRecovery = Readonly<{
  session: CommerceBuyerSessionV4;
  operationId: string;
  cart: StoredCartReference;
  basket: unknown;
}>;

export type BuyerContextRecovery =
  | Readonly<{ kind: "recovered"; context: BuyerContext }>
  | Readonly<{
      kind: "recovered_pickup_quote";
      context: BuyerContext;
      quote: CommerceBuyerQuotedCheckoutV1;
    }>
  | Readonly<{
      kind: "recovered_shipping_quote";
      context: BuyerContext;
      quote: CommerceBuyerQuotedShippingCheckoutV1;
    }>
  | Readonly<{
      kind: "recovered_pickup_payment";
      context: BuyerContext;
      quote: CommerceBuyerQuotedCheckoutV1;
      payment: VariantBy<CommerceBuyerPaymentSessionV1, "state", "ready">;
    }>
  | Readonly<{
      kind: "recovered_shipping_payment";
      context: BuyerContext;
      quote: CommerceBuyerQuotedShippingCheckoutV1;
      payment: VariantBy<CommerceBuyerPaymentSessionV1, "state", "ready">;
    }>
  | Readonly<{
      kind: "recovered_declined";
      context: BuyerContext;
      reasonCode: string;
    }>
  | Readonly<{
      kind: "recovered_pickup_indeterminate";
      context: BuyerContext;
      quote: CommerceBuyerQuotedCheckoutV1;
      reconcileAfter: string;
    }>
  | Readonly<{
      kind: "recovered_shipping_indeterminate";
      context: BuyerContext;
      quote: CommerceBuyerQuotedShippingCheckoutV1;
      reconcileAfter: string;
    }>
  | Readonly<{ kind: "new_session" }>
  | Readonly<{ kind: "failed"; message: string }>;

export type PreparedBuyerCart =
  | Readonly<{ ok: true; context: BuyerContext; cart: ActiveBuyerCart }>
  | Readonly<{ ok: false; message: string }>;

export type BuyerBasket = CafeBasket | ShippingBasket;

export type BuyerContactDraft = Readonly<{
  email: string;
  phone: string;
}>;

export type CafeBasket = Readonly<{
  kind: "cafe";
  buyerContact: BuyerContactDraft;
  items: readonly CafeBasketItem[];
}>;

export type CafeBasketItem = Readonly<{
  menuEntryId: string;
  quantity: number;
  modifierOptionIds: readonly string[];
}>;

export type ShippingCountryCode = CommerceBuyerShippingAddressV1["countryCode"];

export type ShippingAddressDraft = CommerceBuyerShippingAddressV1;

export type ShippingBasket = Readonly<{
  kind: "shipping";
  buyerContact: BuyerContactDraft;
  items: readonly ShippingBasketItem[];
  shippingServiceCode: string | undefined;
  address: ShippingAddressDraft;
}>;

export type ShippingBasketItem = Readonly<{
  variantId: string;
  quantity: number;
}>;

export type BuyerOrderAccess = Readonly<{
  checkoutId: string;
  token: string;
  returnUrl: string;
}>;

export type Feedback =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "notice"; message: string }>;

export type StorefrontFailure =
  | Readonly<{ kind: "storefront"; message: string }>
  | Readonly<{ kind: "order_access"; message: string }>;

type BuyerQuoteContinuation =
  | Readonly<{ kind: "new" }>
  | Readonly<{ kind: "pickup"; quote: CommerceBuyerQuotedCheckoutV1 }>
  | Readonly<{
      kind: "shipping";
      quote: CommerceBuyerQuotedShippingCheckoutV1;
    }>;

export type ShippingAddressCorrectionContinuation =
  | Readonly<{
      kind: "new";
      operationId: string;
    }>
  | Readonly<{
      kind: "refresh";
      quote: CommerceBuyerQuotedShippingCheckoutV1;
      operationId: string;
    }>;

export type StorefrontState =
  | Readonly<{ kind: "booting" }>
  | Readonly<{
      kind: "catalog";
      context: BuyerContext;
      continuation: BuyerQuoteContinuation;
      feedback: Feedback;
    }>
  | Readonly<{ kind: "quoting"; context: BuyerContext }>
  | Readonly<{
      kind: "shipping_address_correction";
      context: BuyerContext;
      validation: VariantBy<
        CommerceBuyerShippingAddressValidationV1,
        "state",
        "correction_required"
      >;
      continuation: ShippingAddressCorrectionContinuation;
    }>
  | Readonly<{
      kind: "pickup_quote";
      context: BuyerContext;
      quote: CommerceBuyerQuotedCheckoutV1;
      expired: boolean;
      feedback: Feedback;
    }>
  | Readonly<{
      kind: "shipping_quote";
      context: BuyerContext;
      quote: CommerceBuyerQuotedShippingCheckoutV1;
      expired: boolean;
      feedback: Feedback;
    }>
  | Readonly<{
      kind: "paying_pickup";
      context: BuyerContext;
      quote: CommerceBuyerQuotedCheckoutV1;
    }>
  | Readonly<{
      kind: "paying_shipping";
      context: BuyerContext;
      quote: CommerceBuyerQuotedShippingCheckoutV1;
    }>
  | Readonly<{
      kind: "payment_pickup";
      context: BuyerContext;
      quote: CommerceBuyerQuotedCheckoutV1;
      payment: VariantBy<CommerceBuyerPaymentSessionV1, "state", "ready">;
    }>
  | Readonly<{
      kind: "payment_shipping";
      context: BuyerContext;
      quote: CommerceBuyerQuotedShippingCheckoutV1;
      payment: VariantBy<CommerceBuyerPaymentSessionV1, "state", "ready">;
    }>
  | Readonly<{
      kind: "declined";
      context: BuyerContext;
      reasonCode: string;
    }>
  | Readonly<{
      kind: "indeterminate_pickup";
      context: BuyerContext;
      quote: CommerceBuyerQuotedCheckoutV1;
      reconcileAfter: string;
    }>
  | Readonly<{
      kind: "indeterminate_shipping";
      context: BuyerContext;
      quote: CommerceBuyerQuotedShippingCheckoutV1;
      reconcileAfter: string;
    }>
  | Readonly<{
      kind: "pickup_order";
      access: BuyerOrderAccess;
      order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">;
      feedback: Feedback;
    }>
  | Readonly<{
      kind: "shipping_order";
      access: BuyerOrderAccess;
      order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "shipping">;
      feedback: Feedback;
    }>
  | Readonly<{ kind: "failed"; failure: StorefrontFailure }>;

export type CafeProductSelection = Readonly<{
  config: CafeProductConfiguration;
  menu: CommerceBuyerMenuV1;
  entry: CommerceBuyerMenuEntryV1;
  listing: CommerceBuyerCatalogListingV1;
}>;

export type CafeSelection = Readonly<{
  products: readonly [CafeProductSelection, ...CafeProductSelection[]];
}>;

export type CafeSelectionResult =
  | Readonly<{ ok: true; value: CafeSelection }>
  | Readonly<{ ok: false; message: string }>;

export type ShippingSelectionResult =
  | Readonly<{
      ok: true;
      value: readonly [
        CommerceBuyerCatalogListingV1,
        ...CommerceBuyerCatalogListingV1[],
      ];
    }>
  | Readonly<{ ok: false; message: string }>;

export type BuyerTimelineItem = Readonly<{
  state: "complete" | "current" | "upcoming";
  label: string;
}>;

export type StorefrontAppProps = Readonly<{ config: StorefrontConfiguration }>;

export type BuyerContactPolicy =
  CommerceBuyerSessionV4["checkoutProfileConfiguration"]["buyerPolicy"]["requiredContact"];
export type BuyerFulfillment = CommerceBuyerCatalogV1["storefront"]["fulfillment"];
