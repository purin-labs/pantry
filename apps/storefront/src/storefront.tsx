import React from "react";
import qrcode from "qrcode-generator";
import {
  CommerceStorefrontClient,
  isCommerceInternationalShippingCountry,
  isCommercePostalCode,
  parseCommerceBuyerSessionV4,
  commerceAddressNeedsState,
  type CommerceInternationalShippingCountry,
  type CommerceClientError,
  type CommerceBuyerCatalogListingV1,
  type CommerceBuyerCatalogV1,
  type CommerceBuyerCartLineV1,
  type CommerceBuyerCartV1,
  type CommerceBuyerContactV1,
  type CommerceBuyerMenuEntryV1,
  type CommerceBuyerMenuV1,
  type CommerceBuyerModifierGroupV1,
  type CommerceBuyerOrderV1,
  type CommerceBuyerOrderRecoveryV1,
  type CommerceBuyerPaymentDisputeStatusV1,
  type CommerceBuyerPaymentSessionV1,
  type CommerceBuyerPickupCheckoutLineV1,
  type CommerceBuyerQuotedCheckoutV1,
  type CommerceBuyerQuotedShippingCheckoutV1,
  type CommerceBuyerSessionV4,
  type CommerceBuyerShippingAddressAcceptanceV1,
  type CommerceBuyerShippingAddressV1,
  type CommerceBuyerShippingAddressValidationV1,
  type CommerceBuyerShippingCheckoutLineV1,
  type CommerceBuyerShippingServiceV1,
  type CommercePaymentClientConfirmationV1,
  type CommercePaymentPublicSessionV1,
  CURRENCY_MINOR_UNITS,
  commercePickupCode,
} from "@purin-labs/commerce-client";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import { assertNever, isRecord } from "@purin-labs/std";
import {
  CartDrawer,
  PATISSERIE_PRODUCTS,
  PatisserieMenu,
  patisserieProduct,
  patisserieProductId,
  patisserieMastheadDetail,
  patisserieIsMadeToOrder,
  patisserieThumbnail,
  type PatisserieMenuItem,
  type PatisserieProductId,
} from "./patisserie.tsx";
import {
  CatalogSkeleton,
  CheckoutSkeleton,
  PatisserieMenuSkeleton,
} from "./skeletons.tsx";

type ProviderUiError = Readonly<{ message?: string }>;

type StripePaymentElement = Readonly<{
  mount: (selector: string) => void;
  unmount: () => void;
}>;

type StripeElements = Readonly<{
  create: (kind: "payment") => StripePaymentElement;
  submit: () => Promise<Readonly<{ error?: ProviderUiError }>>;
}>;

type StripeClient = Readonly<{
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

type SquareCard = Readonly<{
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

type SquarePayments = Readonly<{ card: () => Promise<SquareCard> }>;

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
const CAFE_LANGUAGE_STORAGE_KEY = "satyr.storefront.cafe.language";

type ShippingListingImage = Readonly<{ imageUrl: string; imageAlt: string }>;

const SHIPPING_LISTING_IMAGES: Readonly<Record<string, ShippingListingImage>> =
  {
    "COOKIE-BOX-6-SG": {
      imageUrl: "/products/nuki-neko-gift-box.webp",
      imageAlt:
        "Open kraft gift box with three cat-shaped madeleines and three cat-face cookies",
    },
    "SESAME-BOX-6-SG": {
      imageUrl: "/products/nuki-cookies-sesame.webp",
      imageAlt: "Black sesame cat-face cookies arranged on a baking tray",
    },
    "GINGER-BOX-6-SG": {
      imageUrl: "/products/nuki-cookies-ginger.webp",
      imageAlt: "Golden ginger cat-face cookies arranged on a baking tray",
    },
    "TARO-BOX-6-SG": {
      imageUrl: "/products/nuki-financier-taro.webp",
      imageAlt: "Taro cat-shaped madeleines on a cream ceramic plate",
    },
    "MATCHA-BOX-6-SG": {
      imageUrl: "/products/nuki-cookies-matcha.webp",
      imageAlt: "Matcha cat-face cookies arranged on a baking tray",
    },
  };

const DEFAULT_SHIPPING_LISTING_IMAGE: ShippingListingImage = {
  imageUrl: "/products/nuki-cookie-box.webp",
  imageAlt: "Open kraft box of six square butter cookies",
};

type CafeLanguage = "en" | "ja";

type NukiCafeProductId =
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

type CafeProductId = NukiCafeProductId | PatisserieProductId;

type CafeFlavorId = "sesame" | "ginger" | "taro" | "matcha";

type CafeFlavorMenuGroup = Readonly<{
  id: CafeFlavorId;
  name: string;
  items: readonly [drink: string, cookie: string, financier: string];
  productIds: readonly [
    drink: CafeProductId,
    cookie: CafeProductId,
    financier: CafeProductId,
  ];
}>;

type CafeFlavorMenuCopy = Readonly<{
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

type CafeInterfaceCopy = Readonly<{
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

const CAFE_INTERFACE_COPY: Readonly<Record<CafeLanguage, CafeInterfaceCopy>> = {
  en: {
    htmlLanguage: "en",
    skipLink: "Skip to shopping",
    languageLabel: "Language",
    headerDetail: "French–Taiwanese tea & pâtisserie",
    menuNav: "Menu",
    orderStatusNav: "Order status",
    categoryMenu: "Menu",
    categoryDrinks: "Drinks",
    categoryBakes: "Bakes",
    categoryNavigationLabel: "Menu categories",
    welcome: (shopName) => `Welcome to ${shopName}`,
    title: "French pâtisserie, Taiwanese comfort",
    introduction:
      "Choose from four flavor families across tea, cookies, and financiers.",
    pickupOpen: "Open for pickup",
    pickupDetail: "We’ll show you when your order is ready.",
    menuEyebrow: "Available now",
    menuHeading: "Today’s pickup menu",
    madeToOrder: "Made to order",
    readyInMinutes: "Ready in 10–15 min",
    bakedToday: "Baked today",
    readyNow: "Ready now",
    milkChoice: "Milk choice",
    oatMilk: "Oat milk",
    dairyMilk: "Dairy milk",
    available: "Available",
    soldOut: "Sold out",
    addAction: "Add",
    addOne: "Add one",
    removeOne: "Remove one",
    selected: "selected",
    orderEyebrow: "Your order",
    basketHeading: "Cart",
    emptyBasket: "Your cart is empty. Add something from the menu to begin.",
    estimatedTotal: "Estimated total",
    checkout: "Checkout",
    checkoutDetail: "Inventory and pickup time are confirmed next.",
    reviewEyebrow: "Review order",
    reviewHeading: "Ready to send to the café",
    reviewDetail: "Check your order, then place it to send it to the café.",
    quoteExpired:
      "This quote expired. Refresh it to confirm current stock and pricing.",
    items: "Items",
    tax: "Tax",
    taxIncluded: "Includes tax",
    total: "Total",
    refreshQuote: "Refresh quote",
    pay: "Pay securely",
    editOrder: "Edit order",
    paymentNote:
      "Payment details are collected securely by the payment provider selected by this café.",
    pickupEyebrow: "Café pickup",
    preparingOrder: "The café is making your order",
    readyForPickup: "Ready at the counter",
    pickedUp: "Order complete",
    orderCancelled: "Order cancelled",
    paid: "Paid",
    nextAction: "Next action",
    lastUpdated: "Last updated",
    orderProgress: "Order progress",
    returnUrl: "Private order link",
    returnUrlDetail:
      "Save this link to check the order from this device or another one.",
    copyLink: "Copy order link",
    linkCopied: "Order link copied.",
    refreshStatus: "Refresh status",
    kioskHeading: "Finished with this tablet?",
    kioskDetail:
      "Scan the QR code or copy the private link first, then clear this order for the next customer.",
    clearKiosk: "Finish and clear screen",
    kioskConfirmHeading: "Clear this order from the screen?",
    kioskConfirmDetail:
      "This tablet loses access to the order. Make sure the QR code has been scanned or the link saved.",
    kioskConfirmClear: "Yes, clear the screen",
    kioskConfirmKeep: "Keep showing the order",
    pickupCodeLabel: "Pickup code",
    orderSummary: "Order summary",
    pickupAt: "Pickup at {name}",
    quoteHold: "Price and stock held",
    qrDetail: "Scan with your phone to keep your order status with you.",
    containsLabel: "Contains",
    todayAt: "today at {time}",
    footerPickup:
      "Stock and pickup timing are confirmed before you place the order.",
    footerTrust: "Allergens listed by item · Prices in JPY",
  },
  ja: {
    htmlLanguage: "ja",
    skipLink: "商品一覧へ移動",
    languageLabel: "言語",
    headerDetail: "フレンチと台湾のティー＆パティスリー",
    menuNav: "メニュー",
    orderStatusNav: "注文状況",
    categoryMenu: "メニュー",
    categoryDrinks: "ドリンク",
    categoryBakes: "焼き菓子",
    categoryNavigationLabel: "メニューカテゴリー",
    welcome: (shopName) => `${shopName}へようこそ`,
    title: "フランス菓子と台湾のやさしい味",
    introduction:
      "お茶・クッキー・フィナンシェで展開する、4つの味からお選びください。",
    pickupOpen: "受け取り注文受付中",
    pickupDetail: "準備ができたら画面でお知らせします。",
    menuEyebrow: "本日のご用意",
    menuHeading: "本日の店内受け取りメニュー",
    madeToOrder: "ご注文後に調理",
    readyInMinutes: "10〜15分でご用意",
    bakedToday: "本日焼き上げ",
    readyNow: "すぐにご用意できます",
    milkChoice: "ミルクを選ぶ",
    oatMilk: "オーツミルク",
    dairyMilk: "ミルク",
    available: "注文できます",
    soldOut: "売り切れ",
    addAction: "追加",
    addOne: "1つ追加",
    removeOne: "1つ減らす",
    selected: "点選択中",
    orderEyebrow: "ご注文",
    basketHeading: "カート",
    emptyBasket: "カートは空です。メニューから商品を追加してください。",
    estimatedTotal: "予定合計",
    checkout: "注文内容を確認",
    checkoutDetail: "次の画面で在庫と受け取り時間を確認します。",
    reviewEyebrow: "注文内容の確認",
    reviewHeading: "カフェへ送信する準備ができました",
    reviewDetail: "ご注文内容を確認して、カフェへ送信してください。",
    quoteExpired:
      "見積もりの有効期限が切れました。現在の在庫と価格を更新してください。",
    items: "商品",
    tax: "税",
    taxIncluded: "うち消費税",
    total: "合計",
    refreshQuote: "見積もりを更新",
    pay: "安全に支払う",
    editOrder: "注文内容を変更",
    paymentNote:
      "お支払い情報は、このカフェが選択した決済サービスにより安全に収集されます。",
    pickupEyebrow: "カフェ受け取り",
    preparingOrder: "ご注文をお作りしています",
    readyForPickup: "カウンターでお受け取りください",
    pickedUp: "お受け取り完了",
    orderCancelled: "注文キャンセル済み",
    paid: "お支払い済み",
    nextAction: "次にすること",
    lastUpdated: "最終更新",
    orderProgress: "注文の進行状況",
    returnUrl: "注文専用リンク",
    returnUrlDetail:
      "この端末または別の端末から注文状況を確認できるよう、リンクを保存してください。",
    copyLink: "注文リンクをコピー",
    linkCopied: "注文リンクをコピーしました。",
    refreshStatus: "状況を更新",
    kioskHeading: "このタブレットの操作を終了しますか？",
    kioskDetail:
      "先にQRコードを読み取るかリンクを保存してから、次のお客様のために画面をクリアしてください。",
    clearKiosk: "終了して画面をクリア",
    kioskConfirmHeading: "この注文を画面からクリアしますか？",
    kioskConfirmDetail:
      "このタブレットから注文を確認できなくなります。QRコードの読み取りやリンクの保存がお済みかご確認ください。",
    kioskConfirmClear: "はい、クリアします",
    kioskConfirmKeep: "注文を表示したままにする",
    pickupCodeLabel: "受け取り番号",
    orderSummary: "注文内容",
    pickupAt: "{name}で受け取り",
    quoteHold: "価格と在庫を確保中",
    qrDetail: "スマートフォンで読み取ると、注文状況をお手元で確認できます。",
    containsLabel: "アレルギー",
    todayAt: "本日{time}",
    footerPickup: "在庫と受け取り時間は、注文確定前にご案内します。",
    footerTrust: "アレルギー情報は商品ごとに表示 · 価格は日本円",
  },
};

const CAFE_FLAVOR_MENU_COPY: Readonly<
  Record<CafeLanguage, CafeFlavorMenuCopy>
> = {
  en: {
    eyebrow: "Today's menu",
    heading: "Four flavors, three ways",
    detail:
      "Taiwanese tea-house flavors shaped through the quiet craft of a French pâtisserie.",
    packagingDetail:
      "Cookies and financiers are available for café service, gifting, and overseas delivery.",
    imageAlt:
      "Nuki Café menu showing sesame, ginger, taro, and matcha drinks with matching cookies and financiers",
    groups: [
      {
        id: "sesame",
        name: "Sesame",
        items: ["Sesame latte", "Sesame cookie", "Sesame financier"],
        productIds: [
          "menu_entry_sesame_latte",
          "menu_entry_sesame_cookie",
          "menu_entry_sesame_financier",
        ],
      },
      {
        id: "ginger",
        name: "Ginger",
        items: ["Ginger milk tea", "Ginger cookie", "Ginger financier"],
        productIds: [
          "menu_entry_ginger_milk_tea",
          "menu_entry_ginger_cookie",
          "menu_entry_ginger_financier",
        ],
      },
      {
        id: "taro",
        name: "Taro",
        items: ["Taro milk tea", "Taro cookie", "Taro financier"],
        productIds: [
          "menu_entry_taro_milk_tea",
          "menu_entry_taro_cookie",
          "menu_entry_taro_financier",
        ],
      },
      {
        id: "matcha",
        name: "Matcha",
        items: ["Matcha tea", "Matcha cookie", "Matcha financier"],
        productIds: [
          "menu_entry_matcha_tea",
          "menu_entry_matcha_cookie",
          "menu_entry_matcha_financier",
        ],
      },
    ],
  },
  ja: {
    eyebrow: "本日のメニュー",
    heading: "4つの味、3つの楽しみ方",
    detail:
      "台湾のティーハウスの味わいを、フランス菓子の丁寧な手仕事で仕上げました。",
    packagingDetail:
      "クッキーとフィナンシェは、カフェ・ギフト・海外配送でお楽しみいただけます。",
    imageAlt:
      "黒ごま、生姜、タロイモ、抹茶のドリンクとクッキー、フィナンシェを紹介するNuki Caféのメニュー",
    groups: [
      {
        id: "sesame",
        name: "黒ごま",
        items: ["黒ごまラテ", "黒ごまクッキー", "黒ごまフィナンシェ"],
        productIds: [
          "menu_entry_sesame_latte",
          "menu_entry_sesame_cookie",
          "menu_entry_sesame_financier",
        ],
      },
      {
        id: "ginger",
        name: "生姜",
        items: ["生姜ミルクティー", "生姜クッキー", "生姜フィナンシェ"],
        productIds: [
          "menu_entry_ginger_milk_tea",
          "menu_entry_ginger_cookie",
          "menu_entry_ginger_financier",
        ],
      },
      {
        id: "taro",
        name: "タロイモ",
        items: [
          "タロイモミルクティー",
          "タロイモクッキー",
          "タロイモフィナンシェ",
        ],
        productIds: [
          "menu_entry_taro_milk_tea",
          "menu_entry_taro_cookie",
          "menu_entry_taro_financier",
        ],
      },
      {
        id: "matcha",
        name: "抹茶",
        items: ["抹茶", "抹茶クッキー", "抹茶フィナンシェ"],
        productIds: [
          "menu_entry_matcha_tea",
          "menu_entry_matcha_cookie",
          "menu_entry_matcha_financier",
        ],
      },
    ],
  },
};

type CafeProductConfiguration = Readonly<{
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

type CafeProductCopy = Readonly<{
  title: string;
  description: string;
  allergens: string;
}>;

/** The demo products, with their own art and copy. */
const CAFE_PRODUCT_CONFIGURATIONS: readonly (CafeProductConfiguration &
  Readonly<{ menuEntryId: CafeProductId }>)[] = [
  {
    menuEntryId: "menu_entry_sesame_latte",
    category: "drink",
    flavor: "sesame",
    imageUrl: "/products/nuki-latte-sesame.webp",
    imageAlt: "Black sesame latte served in a handmade ceramic cup",
    preparation: "made_to_order",
  },
  {
    menuEntryId: "menu_entry_sesame_cookie",
    category: "bake",
    flavor: "sesame",
    imageUrl: "/products/nuki-cookies-sesame.webp",
    imageAlt: "Black sesame cat-face cookies arranged on a baking tray",
    preparation: "baked_today",
  },
  {
    menuEntryId: "menu_entry_sesame_financier",
    category: "bake",
    flavor: "sesame",
    imageUrl: "/products/nuki-financier-sesame.webp",
    imageAlt: "Black sesame financiers on a cream ceramic plate",
    preparation: "baked_today",
  },
  {
    menuEntryId: "menu_entry_ginger_milk_tea",
    category: "drink",
    flavor: "ginger",
    imageUrl: "/products/nuki-latte-ginger.webp",
    imageAlt: "Ginger milk tea served in a handmade ceramic cup",
    preparation: "made_to_order",
  },
  {
    menuEntryId: "menu_entry_ginger_cookie",
    category: "bake",
    flavor: "ginger",
    imageUrl: "/products/nuki-cookies-ginger.webp",
    imageAlt: "Ginger cookies arranged on a baking tray",
    preparation: "baked_today",
  },
  {
    menuEntryId: "menu_entry_ginger_financier",
    category: "bake",
    flavor: "ginger",
    imageUrl: "/products/nuki-financier-ginger.webp",
    imageAlt: "Ginger financiers on a cream ceramic plate",
    preparation: "baked_today",
  },
  {
    menuEntryId: "menu_entry_taro_milk_tea",
    category: "drink",
    flavor: "taro",
    imageUrl: "/products/nuki-latte-taro.webp",
    imageAlt: "Taro milk tea served in a handmade ceramic cup",
    preparation: "made_to_order",
  },
  {
    menuEntryId: "menu_entry_taro_cookie",
    category: "bake",
    flavor: "taro",
    imageUrl: "/products/nuki-cookies-taro.webp",
    imageAlt: "Taro cookies arranged on a baking tray",
    preparation: "baked_today",
  },
  {
    menuEntryId: "menu_entry_taro_financier",
    category: "bake",
    flavor: "taro",
    imageUrl: "/products/nuki-financier-taro.webp",
    imageAlt: "Taro financiers on a cream ceramic plate",
    preparation: "baked_today",
  },
  {
    menuEntryId: "menu_entry_matcha_tea",
    category: "drink",
    flavor: "matcha",
    imageUrl: "/products/nuki-latte-matcha.webp",
    imageAlt: "Matcha tea served in a handmade ceramic cup",
    preparation: "made_to_order",
  },
  {
    menuEntryId: "menu_entry_matcha_cookie",
    category: "bake",
    flavor: "matcha",
    imageUrl: "/products/nuki-cookies-matcha.webp",
    imageAlt: "Matcha cookies arranged on a baking tray",
    preparation: "baked_today",
  },
  {
    menuEntryId: "menu_entry_matcha_financier",
    category: "bake",
    flavor: "matcha",
    imageUrl: "/products/nuki-financier-matcha.webp",
    imageAlt: "Matcha financiers on a cream ceramic plate",
    preparation: "baked_today",
  },
  ...PATISSERIE_PRODUCTS.map(
    (
      product,
    ): CafeProductConfiguration & Readonly<{ menuEntryId: CafeProductId }> => ({
      menuEntryId: patisserieProductId(product.slug),
      category: "bake",
      flavor: "patisserie",
      imageUrl: patisserieThumbnail(product.slug),
      imageAlt: product.copy.en.title,
      preparation: patisserieIsMadeToOrder(product.slug)
        ? "made_to_order"
        : "baked_today",
    }),
  ),
];

const CAFE_PRODUCT_COPY: Readonly<
  Record<CafeLanguage, Readonly<Record<NukiCafeProductId, CafeProductCopy>>>
> = {
  en: {
    menu_entry_sesame_latte: {
      title: "Sesame latte",
      description: "Roasted black sesame, milk, and a softly toasted finish.",
      allergens: "sesame, dairy",
    },
    menu_entry_sesame_cookie: {
      title: "Sesame cookie",
      description: "A crisp butter cookie folded with roasted black sesame.",
      allergens: "wheat, dairy, egg, sesame",
    },
    menu_entry_sesame_financier: {
      title: "Sesame financier",
      description:
        "Brown butter, almond, and black sesame in a tender French cake.",
      allergens: "almond, wheat, dairy, egg, sesame",
    },
    menu_entry_ginger_milk_tea: {
      title: "Ginger milk tea",
      description:
        "Fresh ginger and Assam tea with a warm, gently spiced finish.",
      allergens: "dairy",
    },
    menu_entry_ginger_cookie: {
      title: "Ginger cookie",
      description:
        "A crisp butter cookie with bright ginger and a soft caramel edge.",
      allergens: "wheat, dairy, egg",
    },
    menu_entry_ginger_financier: {
      title: "Ginger financier",
      description: "Brown butter and almond cake with a warm ginger finish.",
      allergens: "almond, wheat, dairy, egg",
    },
    menu_entry_taro_milk_tea: {
      title: "Taro milk tea",
      description: "Creamy taro and fragrant tea with a softly sweet finish.",
      allergens: "dairy",
    },
    menu_entry_taro_cookie: {
      title: "Taro cookie",
      description: "A tender butter cookie with mellow taro and toasted notes.",
      allergens: "wheat, dairy, egg",
    },
    menu_entry_taro_financier: {
      title: "Taro financier",
      description: "Almond, brown butter, and taro in a tender French cake.",
      allergens: "almond, wheat, dairy, egg",
    },
    menu_entry_matcha_tea: {
      title: "Matcha tea",
      description: "Stone-ground matcha with a clean, grassy finish.",
      allergens: "",
    },
    menu_entry_matcha_cookie: {
      title: "Matcha cookie",
      description: "A crisp butter cookie folded with fragrant matcha.",
      allergens: "wheat, dairy, egg",
    },
    menu_entry_matcha_financier: {
      title: "Matcha financier",
      description: "Brown butter and almond cake with a vivid matcha finish.",
      allergens: "almond, wheat, dairy, egg",
    },
  },
  ja: {
    menu_entry_sesame_latte: {
      title: "黒ごまラテ",
      description:
        "香ばしい黒ごまとミルクを合わせ、やさしい余韻に仕上げました。",
      allergens: "ごま・乳",
    },
    menu_entry_sesame_cookie: {
      title: "黒ごまクッキー",
      description: "ローストした黒ごまを練り込んだ、さくさくのバタークッキー。",
      allergens: "小麦・乳・卵・ごま",
    },
    menu_entry_sesame_financier: {
      title: "黒ごまフィナンシェ",
      description:
        "焦がしバターとアーモンド、黒ごまが香るしっとりとした焼き菓子。",
      allergens: "アーモンド・小麦・乳・卵・ごま",
    },
    menu_entry_ginger_milk_tea: {
      title: "生姜ミルクティー",
      description:
        "生姜の香りとアッサム茶を合わせた、温かくやさしいミルクティー。",
      allergens: "乳",
    },
    menu_entry_ginger_cookie: {
      title: "生姜クッキー",
      description: "生姜の香りをアクセントにした、さくさくのバタークッキー。",
      allergens: "小麦・乳・卵",
    },
    menu_entry_ginger_financier: {
      title: "生姜フィナンシェ",
      description:
        "焦がしバターとアーモンドに生姜を合わせた、しっとりした焼き菓子。",
      allergens: "アーモンド・小麦・乳・卵",
    },
    menu_entry_taro_milk_tea: {
      title: "タロイモミルクティー",
      description: "タロイモのまろやかな甘みと香り高いお茶を合わせました。",
      allergens: "乳",
    },
    menu_entry_taro_cookie: {
      title: "タロイモクッキー",
      description:
        "タロイモのやさしい風味を練り込んだ、ほろりとしたバタークッキー。",
      allergens: "小麦・乳・卵",
    },
    menu_entry_taro_financier: {
      title: "タロイモフィナンシェ",
      description: "アーモンドと焦がしバターにタロイモを合わせたフランス菓子。",
      allergens: "アーモンド・小麦・乳・卵",
    },
    menu_entry_matcha_tea: {
      title: "抹茶",
      description: "すっきりとした香りと余韻を楽しむ、石臼挽き抹茶。",
      allergens: "",
    },
    menu_entry_matcha_cookie: {
      title: "抹茶クッキー",
      description: "香り高い抹茶を練り込んだ、さくさくのバタークッキー。",
      allergens: "小麦・乳・卵",
    },
    menu_entry_matcha_financier: {
      title: "抹茶フィナンシェ",
      description: "焦がしバターとアーモンドに抹茶を合わせた、濃厚な焼き菓子。",
      allergens: "アーモンド・小麦・乳・卵",
    },
  },
};

/**
 * A café storefront. The Nuki Café demo is the showcase, with its own name
 * and menu art. A QR order page (`<shop name>.menu.<domain>`, or
 * `/shops/<merchantId>`) shows the shop's published menu under the name
 * that its checkout profile presents.
 */
type CafeConfiguration = Readonly<{
  kind: "cafe";
  merchantId: string;
  storefrontId: string;
  name: string;
  showcase: boolean;
  /**
   * The Nuki Café demo has its own menu art; the pâtisserie site at
   * shop.seams.tokyo has its own menu and look; any other shop shows its
   * published menu as it is.
   */
  presentation: "nuki" | "patisserie" | "menu";
}>;

type ShippingConfiguration = Readonly<{
  kind: "shipping";
  merchantId: string;
  storefrontId: "storefront_cookie_store_sg";
  name: "Nuki Cookie Post";
}>;

type StorefrontConfiguration = CafeConfiguration | ShippingConfiguration;

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

type BuyerContext = Readonly<{
  session: CommerceBuyerSessionV4;
  catalog: CommerceBuyerCatalogV1;
  runId: string;
  basket: BuyerBasket;
  cart: BuyerCartState;
}>;

type ActiveBuyerCart = VariantBy<CommerceBuyerCartV1, "state", "active">;

type BuyerCartState =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "active"; cart: ActiveBuyerCart }>
  | Readonly<{
      kind: "submitted";
      cartId: string;
      revision: number;
      checkoutId: string;
    }>;

type StoredCartReference =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "active"; cartId: string; revision: number }>
  | Readonly<{
      kind: "submitted";
      cartId: string;
      revision: number;
      checkoutId: string;
    }>;

type StoredCheckoutRecovery = Readonly<{
  session: CommerceBuyerSessionV4;
  operationId: string;
  cart: StoredCartReference;
  basket: unknown;
}>;

type BuyerContextRecovery =
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

type PreparedBuyerCart =
  | Readonly<{ ok: true; context: BuyerContext; cart: ActiveBuyerCart }>
  | Readonly<{ ok: false; message: string }>;

type BuyerBasket = CafeBasket | ShippingBasket;

type BuyerContactDraft = Readonly<{
  email: string;
  phone: string;
}>;

type CafeBasket = Readonly<{
  kind: "cafe";
  buyerContact: BuyerContactDraft;
  items: readonly CafeBasketItem[];
}>;

type CafeBasketItem = Readonly<{
  menuEntryId: string;
  quantity: number;
  modifierOptionIds: readonly string[];
}>;

type ShippingCountryCode = CommerceBuyerShippingAddressV1["countryCode"];

type ShippingAddressDraft = CommerceBuyerShippingAddressV1;

type ShippingBasket = Readonly<{
  kind: "shipping";
  buyerContact: BuyerContactDraft;
  items: readonly ShippingBasketItem[];
  shippingServiceCode: string | undefined;
  address: ShippingAddressDraft;
}>;

type ShippingBasketItem = Readonly<{
  variantId: string;
  quantity: number;
}>;

type BuyerOrderAccess = Readonly<{
  checkoutId: string;
  token: string;
  returnUrl: string;
}>;

type Feedback =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "notice"; message: string }>;

type StorefrontFailure =
  | Readonly<{ kind: "storefront"; message: string }>
  | Readonly<{ kind: "order_access"; message: string }>;

type BuyerQuoteContinuation =
  | Readonly<{ kind: "new" }>
  | Readonly<{ kind: "pickup"; quote: CommerceBuyerQuotedCheckoutV1 }>
  | Readonly<{
      kind: "shipping";
      quote: CommerceBuyerQuotedShippingCheckoutV1;
    }>;

type ShippingAddressCorrectionContinuation =
  | Readonly<{
      kind: "new";
      operationId: string;
    }>
  | Readonly<{
      kind: "refresh";
      quote: CommerceBuyerQuotedShippingCheckoutV1;
      operationId: string;
    }>;

type StorefrontState =
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

type CafeProductSelection = Readonly<{
  config: CafeProductConfiguration;
  menu: CommerceBuyerMenuV1;
  entry: CommerceBuyerMenuEntryV1;
  listing: CommerceBuyerCatalogListingV1;
}>;

type CafeSelection = Readonly<{
  products: readonly [CafeProductSelection, ...CafeProductSelection[]];
}>;

type CafeSelectionResult =
  | Readonly<{ ok: true; value: CafeSelection }>
  | Readonly<{ ok: false; message: string }>;

type ShippingSelectionResult =
  | Readonly<{
      ok: true;
      value: readonly [
        CommerceBuyerCatalogListingV1,
        ...CommerceBuyerCatalogListingV1[],
      ];
    }>
  | Readonly<{ ok: false; message: string }>;

type BuyerTimelineItem = Readonly<{
  state: "complete" | "current" | "upcoming";
  label: string;
}>;

type StorefrontAppProps = Readonly<{ config: StorefrontConfiguration }>;

type BuyerContactPolicy =
  CommerceBuyerSessionV4["checkoutProfileConfiguration"]["buyerPolicy"]["requiredContact"];
type BuyerFulfillment = CommerceBuyerCatalogV1["storefront"]["fulfillment"];

/**
 * The shop of a page. `orderPageMeta` is the content of the
 * `commerce-shop` meta tag, which the shop Worker adds to an order page
 * after it looks up the host's shop name.
 */
export function storefrontConfiguration(
  pathname: string,
  orderPageMeta: string | null = null,
): StorefrontConfiguration {
  // An order page host names its storefront; the path cannot open another.
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
  // A site built for one shop, such as shop.seams.tokyo, opens that shop.
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
  readonly #client = new CommerceStorefrontClient({
    baseUrl: window.location.origin,
  });
  #cafeLanguage = readCafeLanguage();
  #kioskMode = false;
  #cafeContactSubmitted = false;
  /** The pâtisserie site's cart drawer. */
  #cartOpen = false;
  #shippingFormSubmitted = false;
  #hasPresentedPage = false;
  #pollTimer: number | undefined;
  #quoteTimer: number | undefined;

  applySessionPresentation = (session: CommerceBuyerSessionV4): void => {
    const presentation =
      session.checkoutProfileConfiguration.presentationPolicy;
    this.#cafeLanguage = languageFromLocale(presentation.locale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = presentation.locale;
      document.title = `${presentation.merchantDisplayName} · Seams Checkout`;
    }
  };

  componentDidMount(): void {
    document.title = `${this.props.config.name} · Seams Checkout`;
    document.documentElement.lang =
      this.props.config.kind === "cafe"
        ? cafeInterfaceCopy(this.#cafeLanguage).htmlLanguage
        : "en";
    this.#kioskMode = readKioskMode(
      this.props.config.storefrontId,
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
      if (this.#hasPresentedPage) {
        focusPageHeading();
      } else {
        scrollToLocationAnchor();
      }
      this.#hasPresentedPage = true;
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

  async bootstrap(): Promise<void> {
    this.#cafeContactSubmitted = false;
    this.#shippingFormSubmitted = false;
    this.setState({ kind: "booting" });
    const config = this.props.config;
    const recovery = recoveryFromLocation(window.location);
    if (
      recovery === undefined &&
      locationHasOrderAccessIntent(window.location)
    ) {
      clearOrderStatusUrl(config.storefrontId);
      this.setState({
        kind: "failed",
        failure: {
          kind: "order_access",
          message: invalidOrderAccessMessage(
            config.kind,
            this.#cafeLanguage,
            false,
          ),
        },
      });
      return;
    }
    if (recovery !== undefined) {
      const order = await this.#client.recoverOrder(
        config.merchantId,
        config.storefrontId,
        recovery.checkoutId,
        recovery.token,
      );
      if (!order.ok) {
        if (isTerminalOrderAccessError(order.error)) {
          clearOrderStatusUrl(config.storefrontId);
          this.setState({
            kind: "failed",
            failure: {
              kind: "order_access",
              message: invalidOrderAccessMessage(
                config.kind,
                this.#cafeLanguage,
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
        clearOrderStatusUrl(config.storefrontId);
        this.setState({
          kind: "failed",
          failure: {
            kind: "order_access",
            message: invalidOrderAccessMessage(
              config.kind,
              this.#cafeLanguage,
              true,
            ),
          },
        });
        return;
      }
      saveOrderStatusUrl(config.storefrontId, recovery.returnUrl);
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
    const session = await this.#client.createSession(
      config.merchantId,
      config.storefrontId,
      {
        schemaVersion: "underclerk.create-buyer-session.v1",
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
    const catalog = await this.#client.readCatalog(
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
  }

  async recoverBuyerContext(
    config: StorefrontConfiguration,
  ): Promise<BuyerContextRecovery> {
    const stored = readStoredCheckoutRecovery(config);
    if (stored === undefined) return { kind: "new_session" };
    this.applySessionPresentation(stored.session);
    const catalog = await this.#client.readCatalog(
      config.merchantId,
      config.storefrontId,
      stored.session.token,
    );
    if (!catalog.ok) {
      if (isUnavailableBuyerSession(catalog.error)) {
        clearStoredCheckoutContext(config.storefrontId);
        return { kind: "new_session" };
      }
      return { kind: "failed", message: buyerClientError(catalog.error) };
    }
    if (
      catalog.value.storefront.storefrontId !== config.storefrontId ||
      catalog.value.storefront.fulfillment !== configurationFulfillment(config)
    ) {
      clearStoredCheckoutContext(config.storefrontId);
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
      const recoveredCart = await this.#client.readCart(
        config.merchantId,
        config.storefrontId,
        stored.cart.cartId,
        stored.session.token,
      );
      if (!recoveredCart.ok && isUnavailableBuyerSession(recoveredCart.error)) {
        clearStoredCheckoutContext(config.storefrontId);
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
            clearStoredCheckoutContext(config.storefrontId);
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
  }

  async recoverSubmittedCheckout(
    config: StorefrontConfiguration,
    stored: StoredCheckoutRecovery,
    catalog: CommerceBuyerCatalogV1,
    cart: Variant<BuyerCartState, "submitted">,
  ): Promise<BuyerContextRecovery> {
    const checkout = await this.#client.readCheckout(
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
        clearStoredCheckoutContext(config.storefrontId);
        return { kind: "new_session" };
      }
      return { kind: "failed", message: buyerClientError(checkout.error) };
    }
    const quote = checkout.value.checkout;
    if (quote.checkoutId !== cart.checkoutId) {
      clearStoredCheckoutContext(config.storefrontId);
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
        quote.schemaVersion !== "underclerk.buyer-quoted-checkout.v1") ||
      (config.kind === "shipping" &&
        quote.schemaVersion !== "underclerk.buyer-quoted-shipping-checkout.v1")
    ) {
      clearStoredCheckoutContext(config.storefrontId);
      return { kind: "new_session" };
    }
    saveStoredCheckoutContext(config, context);
    if (checkout.value.progress.state === "quoted") {
      return quote.schemaVersion === "underclerk.buyer-quoted-checkout.v1"
        ? { kind: "recovered_pickup_quote", context, quote }
        : { kind: "recovered_shipping_quote", context, quote };
    }
    switch (checkout.value.progress.payment.state) {
      case "pending":
        return this.recoverPendingPaymentSession(config, context, quote);
      case "captured":
        return quote.schemaVersion === "underclerk.buyer-quoted-checkout.v1"
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
        return quote.schemaVersion === "underclerk.buyer-quoted-checkout.v1"
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
  }

  async recoverPendingPaymentSession(
    config: StorefrontConfiguration,
    context: BuyerContext,
    quote:
      CommerceBuyerQuotedCheckoutV1 | CommerceBuyerQuotedShippingCheckoutV1,
  ): Promise<BuyerContextRecovery> {
    const result = await this.#client.createPaymentSession(
      config.merchantId,
      config.storefrontId,
      quote.checkoutId,
      context.session.token,
      {
        schemaVersion: "underclerk.create-buyer-payment-session.v1",
        idempotencyKey: `${context.runId}_payment`,
        checkoutRevision: quote.revision,
        quoteDigest: quote.quote.quoteDigest,
        returnUrl: window.location.href,
      },
    );
    if (!result.ok) {
      if (isQuoteExpiredError(result.error)) {
        return quote.schemaVersion === "underclerk.buyer-quoted-checkout.v1"
          ? { kind: "recovered_pickup_quote", context, quote }
          : { kind: "recovered_shipping_quote", context, quote };
      }
      return { kind: "failed", message: buyerClientError(result.error) };
    }
    if (result.value.state === "unavailable") {
      return {
        kind: "failed",
        message: `Payment collection is temporarily unavailable. Try again after ${formatDate(result.value.retryAfter, config.kind, this.#cafeLanguage)}.`,
      };
    }
    return quote.schemaVersion === "underclerk.buyer-quoted-checkout.v1"
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
  }

  createCafeQuote = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const current = this.state;
    if (current.kind !== "catalog" || this.props.config.kind !== "cafe") return;
    if (!event.currentTarget.checkValidity()) {
      this.#cafeContactSubmitted = true;
      focusFirstInvalidField(event.currentTarget);
      this.setState({ ...current, feedback: { kind: "none" } });
      return;
    }
    this.#cafeContactSubmitted = false;
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
    this.#cafeLanguage = language;
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
    clearOrderStatusUrl(this.props.config.storefrontId);
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

  async refreshPickupQuote(
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
    const result = await this.#client.refreshPickupCheckout(
      config.merchantId,
      config.storefrontId,
      current.quote.checkoutId,
      current.context.session.token,
      {
        schemaVersion: "underclerk.refresh-buyer-pickup-checkout.v1",
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
  }

  async refreshShippingQuote(
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
  }

  async submitShippingRefresh(
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
    const result = await this.#client.refreshShippingCheckout(
      config.merchantId,
      config.storefrontId,
      quote.checkoutId,
      context.session.token,
      {
        schemaVersion: "underclerk.refresh-buyer-shipping-checkout.v1",
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
  }

  async submitCafeQuote(
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
    const result = await this.#client.createPickupCheckout(
      config.merchantId,
      config.storefrontId,
      prepared.context.session.token,
      {
        schemaVersion: "underclerk.create-buyer-pickup-checkout.v1",
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
  }

  async prepareBuyerCart(
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
        ? await this.#client.replaceCart(
            config.merchantId,
            config.storefrontId,
            context.cart.cart.cartId,
            context.session.token,
            {
              schemaVersion: "underclerk.replace-buyer-cart.v1",
              idempotencyKey: `${context.runId}_cart_replace`,
              cartRevision: context.cart.cart.revision,
              lines,
            },
          )
        : await this.#client.createCart(
            config.merchantId,
            config.storefrontId,
            context.session.token,
            {
              schemaVersion: "underclerk.create-buyer-cart.v1",
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
  }

  createShippingQuote = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const current = this.state;
    if (current.kind !== "catalog" || this.props.config.kind !== "shipping")
      return;
    if (current.context.basket.kind !== "shipping") return;
    const form = event.currentTarget;
    if (!form.checkValidity()) {
      this.#shippingFormSubmitted = true;
      focusFirstInvalidField(form);
      this.setState({ ...current, feedback: { kind: "none" } });
      return;
    }
    this.#shippingFormSubmitted = false;
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

  async validateShippingAddress(
    context: BuyerContext,
    continuation: ShippingAddressCorrectionContinuation,
  ): Promise<void> {
    const config = this.props.config;
    if (config.kind !== "shipping" || context.basket.kind !== "shipping")
      return;
    this.setState({ kind: "quoting", context });
    const result = await this.#client.validateShippingAddress(
      config.merchantId,
      config.storefrontId,
      context.session.token,
      {
        schemaVersion: "underclerk.validate-buyer-shipping-address.v1",
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
            this.#cafeLanguage,
          )}.`,
        });
        return;
      default:
        return assertNever(result.value, "Unhandled storefront state");
    }
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
  }

  restoreShippingCatalog(
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
  }

  async submitShippingQuote(
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
    const result = await this.#client.createShippingCheckout(
      config.merchantId,
      config.storefrontId,
      prepared.context.session.token,
      {
        schemaVersion: "underclerk.create-buyer-shipping-checkout.v1",
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

  async submitPickupPayment(
    context: BuyerContext,
    quote: CommerceBuyerQuotedCheckoutV1,
  ): Promise<void> {
    this.setState({ kind: "paying_pickup", context, quote });
    saveOrderReceipt(
      pickupReceipt(quote, context, this.props.config, this.#cafeLanguage),
    );
    const payment = await this.createPaymentSession(
      context,
      quote.checkoutId,
      quote.revision,
      quote.quote.quoteDigest,
    );
    if (payment === undefined) return;
    this.setState({ kind: "payment_pickup", context, quote, payment });
  }

  async submitShippingPayment(
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
  }

  async createPaymentSession(
    context: BuyerContext,
    checkoutId: string,
    checkoutRevision: number,
    quoteDigest: string,
  ): Promise<
    VariantBy<CommerceBuyerPaymentSessionV1, "state", "ready"> | undefined
  > {
    const config = this.props.config;
    const result = await this.#client.createPaymentSession(
      config.merchantId,
      config.storefrontId,
      checkoutId,
      context.session.token,
      {
        schemaVersion: "underclerk.create-buyer-payment-session.v1",
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
      this.restoreQuoteWithError(context, buyerClientError(result.error));
      return undefined;
    }
    if (result.value.state === "unavailable") {
      this.restoreQuoteWithError(
        context,
        `Payment collection is temporarily unavailable. Try again after ${formatDate(result.value.retryAfter, this.props.config.kind, this.#cafeLanguage)}.`,
      );
      return undefined;
    }
    return result.value;
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

  async reconcilePickupPayment(
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
  }

  async reconcileShippingPayment(
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
  }

  async reconcileQuote(
    context: BuyerContext,
    checkoutId: string,
    checkoutRevision: number,
    quoteDigest: string,
    confirmation: CommercePaymentClientConfirmationV1,
  ): Promise<CommerceBuyerOrderRecoveryV1 | undefined> {
    const config = this.props.config;
    const result = await this.#client.reconcilePayment(
      config.merchantId,
      config.storefrontId,
      checkoutId,
      context.session.token,
      {
        schemaVersion: "underclerk.reconcile-buyer-payment.v1",
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
  }

  restoreQuoteWithError(context: BuyerContext, message: string): void {
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
  }

  restoreExpiredQuote(context: BuyerContext): void {
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
  }

  async readPlacedOrder(
    checkoutId: string,
    recovery: CommerceBuyerOrderRecoveryV1,
    fulfillment: "pickup" | "shipping",
  ): Promise<void> {
    const config = this.props.config;
    const access = createOrderAccess(checkoutId, recovery.token);
    const result = await this.#client.recoverOrder(
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
    saveOrderStatusUrl(config.storefrontId, access.returnUrl);
    clearStoredCheckoutContext(config.storefrontId);
    this.showOrder(access, result.value);
  }

  showOrder(access: BuyerOrderAccess, order: CommerceBuyerOrderV1): void {
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

  async writeOrderLink(
    current: Variant<StorefrontState, "pickup_order" | "shipping_order">,
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(current.access.returnUrl);
      const message =
        current.kind === "pickup_order"
          ? cafeInterfaceCopy(this.#cafeLanguage).linkCopied
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
  }

  clearPickupKiosk = (): void => {
    if (this.state.kind !== "pickup_order" || this.props.config.kind !== "cafe")
      return;
    this.cancelPoll();
    clearOrderStatusUrl(this.props.config.storefrontId);
    window.history.replaceState(null, "", window.location.pathname);
    void this.bootstrap();
  };

  refreshOrder = (): void => {
    const current = this.state;
    if (current.kind !== "pickup_order" && current.kind !== "shipping_order")
      return;
    void this.pollOrder(current);
  };

  async pollOrder(
    current: Variant<StorefrontState, "pickup_order" | "shipping_order">,
  ): Promise<void> {
    const config = this.props.config;
    const result = await this.#client.recoverOrder(
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
  }

  schedulePoll(): void {
    this.cancelPoll();
    if (
      this.state.kind !== "pickup_order" &&
      this.state.kind !== "shipping_order"
    )
      return;
    if (!orderNeedsPolling(this.state.order)) return;
    this.#pollTimer = window.setTimeout(this.refreshOrder, 4_000);
  }

  cancelPoll(): void {
    if (this.#pollTimer !== undefined) window.clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
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
    this.#quoteTimer = window.setTimeout(this.markQuoteExpired, delay);
  }

  markQuoteExpired = (): void => {
    const current = this.state;
    if (current.kind === "pickup_quote" || current.kind === "shipping_quote") {
      this.setState({ ...current, expired: true, feedback: { kind: "none" } });
    }
  };

  cancelQuoteTimer(): void {
    if (this.#quoteTimer !== undefined) window.clearTimeout(this.#quoteTimer);
    this.#quoteTimer = undefined;
  }

  render(): React.ReactNode {
    const orderStatusHref = this.orderStatusHref();
    const cafeCopy = cafeInterfaceCopy(this.#cafeLanguage);
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
    if (this.state.kind !== "catalog") this.#cartOpen = false;
    const homeHref =
      patisserie || orderPage
        ? window.location.pathname.startsWith("/shops/")
          ? window.location.pathname
          : "/"
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
                  value={this.#cafeLanguage}
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
              {this.props.config.kind === "cafe" && this.#cafeLanguage === "ja"
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

  orderStatusHref(): string | undefined {
    const current = this.state;
    if (current.kind === "pickup_order" || current.kind === "shipping_order") {
      return current.access.returnUrl;
    }
    return readOrderStatusUrl(this.props.config.storefrontId);
  }

  renderState(): React.ReactNode {
    switch (this.state.kind) {
      case "booting": {
        const label =
          this.#cafeLanguage === "ja"
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
          this.#cafeLanguage,
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
              this.#cafeLanguage === "ja"
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
            detail={`Try again after ${formatDate(this.state.reconcileAfter, this.props.config.kind, this.#cafeLanguage)}. The same payment request will be reconciled safely.`}
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
    state: Variant<StorefrontState, "catalog">,
    config: CafeConfiguration,
  ): React.ReactNode {
    const selection = cafeSelection(state.context.catalog, config);
    const basket =
      state.context.basket.kind === "cafe"
        ? state.context.basket
        : initialCafeBasket();
    const hasItems = cafeBasketHasItems(basket);
    const copy = cafeInterfaceCopy(this.#cafeLanguage);
    const contactPolicy = buyerContactPolicy(state.context.session);
    const shopName = config.showcase
      ? config.name
      : state.context.session.checkoutProfileConfiguration.presentationPolicy
          .merchantDisplayName;
    return (
      <div
        className={
          config.presentation === "patisserie"
            ? "cafe-app-shell patisserie-shell"
            : "cafe-app-shell"
        }
      >
        {selection.ok ? (
          <>
            {config.presentation === "patisserie" ? (
              this.renderPatisserieMenu(selection.value, basket, shopName)
            ) : config.presentation === "menu" ? (
              this.renderPublishedMenu(selection.value, basket, copy, shopName)
            ) : (
              <>
                <nav
                  className="cafe-category-rail"
                  aria-label={copy.categoryNavigationLabel}
                >
                  <a aria-current="page" href="#cafe-order-heading">
                    <span aria-hidden="true">⌂</span>
                    {copy.categoryMenu}
                  </a>
                  <a href="#cafe-drinks">
                    <span aria-hidden="true">○</span>
                    {copy.categoryDrinks}
                  </a>
                  <a href="#cafe-bakes">
                    <span aria-hidden="true">◇</span>
                    {copy.categoryBakes}
                  </a>
                  <a
                    className="cafe-cart-shortcut"
                    href="#pickup-summary-heading"
                  >
                    <span aria-hidden="true">□</span>
                    {copy.basketHeading}
                    <b>{cafeBasketItemCount(basket)}</b>
                  </a>
                </nav>
                <section
                  aria-labelledby="cafe-order-heading"
                  className="cafe-menu"
                >
                  <header className="cafe-app-intro">
                    <div>
                      <p className="eyebrow">{copy.welcome(shopName)}</p>
                      <h1 id="cafe-order-heading" tabIndex={-1}>
                        {copy.title}
                      </h1>
                      <p>{copy.introduction}</p>
                    </div>
                    <div className="pickup-note">
                      <span aria-hidden="true">●</span>
                      <strong>{copy.pickupOpen}</strong>
                      <small>{copy.pickupDetail}</small>
                    </div>
                  </header>
                  <div className="cafe-menu-heading">
                    <div>
                      <p className="eyebrow">{copy.menuEyebrow}</p>
                      <h2>{copy.menuHeading}</h2>
                    </div>
                    <span>
                      {cafeMenuItemCount(copy, selection.value.products.length)}
                    </span>
                  </div>
                  <section
                    className="cafe-menu-group"
                    id="cafe-drinks"
                    aria-labelledby="cafe-drinks-heading"
                  >
                    <div className="cafe-menu-group-heading">
                      <h3 id="cafe-drinks-heading">{copy.categoryDrinks}</h3>
                      <span>
                        {cafeCategoryItemCount(
                          copy,
                          selection.value.products,
                          "drink",
                        )}
                      </span>
                    </div>
                    <div className="cafe-product-grid">
                      {this.renderCafeProducts(
                        selection.value,
                        basket,
                        copy,
                        "drink",
                      )}
                    </div>
                  </section>
                  <section
                    className="cafe-menu-group"
                    id="cafe-bakes"
                    aria-labelledby="cafe-bakes-heading"
                  >
                    <div className="cafe-menu-group-heading">
                      <h3 id="cafe-bakes-heading">{copy.categoryBakes}</h3>
                      <span>
                        {cafeCategoryItemCount(
                          copy,
                          selection.value.products,
                          "bake",
                        )}
                      </span>
                    </div>
                    <div className="cafe-product-grid">
                      {this.renderCafeProducts(
                        selection.value,
                        basket,
                        copy,
                        "bake",
                      )}
                    </div>
                  </section>
                  <CafeFlavorMenu
                    copy={CAFE_FLAVOR_MENU_COPY[this.#cafeLanguage]}
                    showcase={config.showcase}
                  />
                </section>
              </>
            )}
            {this.placeBasket(
              config,
              <aside
                className="cafe-basket"
                aria-labelledby="pickup-summary-heading"
              >
                <div className="cafe-basket-heading">
                  <div>
                    <p className="eyebrow">{copy.orderEyebrow}</p>
                    <h2 id="pickup-summary-heading">{copy.basketHeading}</h2>
                  </div>
                  <span className="basket-count">
                    {cafeBasketItemCount(basket)}
                  </span>
                </div>
                {hasItems ? (
                  <ul className="basket-summary">
                    {cafeBasketLines(
                      basket,
                      selection.value,
                      this.#cafeLanguage,
                      copy,
                      this.decreaseCafeQuantity,
                      this.increaseCafeQuantity,
                    )}
                  </ul>
                ) : (
                  <p className="empty-basket">{copy.emptyBasket}</p>
                )}
                {hasItems ? (
                  <div className="basket-total">
                    <span>{copy.estimatedTotal}</span>
                    <strong>
                      {money(cafeBasketTotal(basket, selection.value))}
                    </strong>
                  </div>
                ) : null}
                <form
                  id="cafe-checkout-contact"
                  noValidate
                  onSubmit={this.createCafeQuote}
                >
                  <p className="basket-footnote">
                    {buyerContactPolicyCopy(contactPolicy, this.#cafeLanguage)}
                  </p>
                  <FormField
                    id="cafeEmail"
                    label="Email"
                    type="email"
                    autoComplete="email"
                    placeholder="name@example.com"
                    error={contactFieldError(
                      this.#cafeContactSubmitted,
                      "email",
                      basket.buyerContact.email,
                      contactPolicy,
                    )}
                    value={basket.buyerContact.email}
                    onChange={this.changeBuyerEmail}
                  />
                  {buyerPhoneIsVisible(contactPolicy) ? (
                    <FormField
                      id="cafePhone"
                      label={
                        buyerPhoneIsRequired(contactPolicy)
                          ? "Phone"
                          : "Phone (optional)"
                      }
                      type="tel"
                      autoComplete="tel"
                      pattern="\+[1-9][0-9]{7,14}"
                      placeholder="+819012345678"
                      hint="Include + and the country code."
                      error={contactFieldError(
                        this.#cafeContactSubmitted,
                        "phone",
                        basket.buyerContact.phone,
                        contactPolicy,
                      )}
                      value={basket.buyerContact.phone}
                      onChange={this.changeBuyerPhone}
                      required={buyerPhoneIsRequired(contactPolicy)}
                    />
                  ) : null}
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={!hasItems}
                  >
                    {copy.checkout}
                  </button>
                  <p className="basket-footnote">{copy.checkoutDetail}</p>
                </form>
              </aside>,
            )}
            {hasItems && !this.#cartOpen ? (
              <MobileCheckoutBar
                count={cafeBasketItemCount(basket)}
                label={copy.basketHeading}
                total={money(cafeBasketTotal(basket, selection.value))}
                onOpen={
                  config.presentation === "patisserie"
                    ? this.openCart
                    : undefined
                }
              />
            ) : null}
          </>
        ) : (
          <EmptyCatalog message={selection.message} />
        )}
        <FeedbackView feedback={state.feedback} />
      </div>
    );
  }

  /** The basket: a column on the café page, a drawer on the pâtisserie site. */
  placeBasket(
    config: CafeConfiguration,
    basket: React.ReactNode,
  ): React.ReactNode {
    if (config.presentation !== "patisserie") return basket;
    const copy = cafeInterfaceCopy(this.#cafeLanguage);
    return (
      <CartDrawer
        open={this.#cartOpen}
        label={copy.basketHeading}
        closeLabel={this.#cafeLanguage === "ja" ? "閉じる" : "Close"}
        onClose={this.closeCart}
      >
        {basket}
      </CartDrawer>
    );
  }

  openCart = (): void => {
    this.#cartOpen = true;
    this.forceUpdate();
  };

  closeCart = (): void => {
    this.#cartOpen = false;
    this.forceUpdate();
  };

  renderPatisserieMenu(
    selection: CafeSelection,
    basket: CafeBasket,
    shopName: string,
  ): React.ReactNode {
    const items: PatisserieMenuItem[] = [];
    for (const product of selection.products) {
      const patisserie = patisserieProduct(product.config.menuEntryId);
      if (patisserie === undefined) continue;
      items.push({
        slug: patisserie.slug,
        price: money(product.entry.price),
        available: product.entry.availability === "available",
        quantity: cafeBasketQuantity(basket, product.config.menuEntryId),
      });
    }
    const copy = cafeInterfaceCopy(this.#cafeLanguage);
    const orderStatusHref = this.orderStatusHref();
    return (
      <section
        aria-label={copy.menuHeading}
        className="cafe-menu patisserie-page"
      >
        <header className="patisserie-masthead">
          <h1 id="cafe-order-heading" tabIndex={-1}>
            {shopName}
          </h1>
          <p>{patisserieMastheadDetail(this.#cafeLanguage)}</p>
        </header>
        <PatisserieMenu
          language={this.#cafeLanguage}
          items={items}
          shopNav={{
            cartLabel: copy.basketHeading,
            cartCount: cafeBasketItemCount(basket),
            cartOpen: this.#cartOpen,
            onOpenCart: this.openCart,
            ...(orderStatusHref === undefined
              ? {}
              : {
                  orderStatus: {
                    href: orderStatusHref,
                    label: copy.orderStatusNav,
                  },
                }),
          }}
          onIncrease={this.increaseCafeQuantity}
          onDecrease={this.decreaseCafeQuantity}
        />
      </section>
    );
  }

  /**
   * A shop's QR order page: its name, then each section of its published
   * menu with the section's items. No demo copy shows.
   */
  renderPublishedMenu(
    selection: CafeSelection,
    basket: CafeBasket,
    copy: CafeInterfaceCopy,
    shopName: string,
  ): React.ReactNode {
    const sections = publishedMenuSections(selection, copy.categoryMenu);
    const menuNames = [
      ...new Set(selection.products.map((product) => product.menu.name)),
    ];
    return (
      <>
        <nav
          className="cafe-category-rail"
          aria-label={copy.categoryNavigationLabel}
        >
          <a aria-current="page" href="#cafe-order-heading">
            <span aria-hidden="true">⌂</span>
            {copy.categoryMenu}
          </a>
          {sections.map((section) => (
            <a key={section.anchor} href={`#${section.anchor}`}>
              <span aria-hidden="true">○</span>
              {section.name}
            </a>
          ))}
          <a className="cafe-cart-shortcut" href="#pickup-summary-heading">
            <span aria-hidden="true">□</span>
            {copy.basketHeading}
            <b>{cafeBasketItemCount(basket)}</b>
          </a>
        </nav>
        <section aria-labelledby="cafe-order-heading" className="cafe-menu">
          <header className="cafe-app-intro">
            <div>
              <h1 id="cafe-order-heading" tabIndex={-1}>
                {shopName}
              </h1>
            </div>
            <div className="pickup-note">
              <span aria-hidden="true">●</span>
              <strong>{copy.pickupOpen}</strong>
              <small>{copy.pickupDetail}</small>
            </div>
          </header>
          <div className="cafe-menu-heading">
            <div>
              <p className="eyebrow">{copy.menuEyebrow}</p>
              <h2>{menuNames.join(" · ")}</h2>
            </div>
            <span>{cafeMenuItemCount(copy, selection.products.length)}</span>
          </div>
          {sections.map((section) => (
            <section
              className="cafe-menu-group"
              id={section.anchor}
              key={section.anchor}
              aria-labelledby={`${section.anchor}-heading`}
            >
              <div className="cafe-menu-group-heading">
                <h3 id={`${section.anchor}-heading`}>{section.name}</h3>
                <span>{cafeMenuItemCount(copy, section.products.length)}</span>
              </div>
              <div className="cafe-product-grid">
                {section.products.map((product) =>
                  this.renderCafeProduct(product, basket, copy, section.name),
                )}
              </div>
            </section>
          ))}
        </section>
      </>
    );
  }

  renderCafeProducts(
    selection: CafeSelection,
    basket: CafeBasket,
    copy: CafeInterfaceCopy,
    category: CafeProductConfiguration["category"],
  ): readonly React.ReactNode[] {
    const products: React.ReactNode[] = [];
    for (const product of selection.products) {
      if (product.config.category === category)
        products.push(this.renderCafeProduct(product, basket, copy));
    }
    return products;
  }

  renderCafeProduct(
    product: CafeProductSelection,
    basket: CafeBasket,
    copy: CafeInterfaceCopy,
    /** The menu section's name; the demo shows drinks or bakes. */
    category?: string,
  ): React.ReactNode {
    const productCopy = cafeItemCopy(this.#cafeLanguage, product.config);
    const quantity = cafeBasketQuantity(basket, product.config.menuEntryId);
    const preparation = cafeProductPreparation(
      copy,
      product.config.preparation,
    );
    return (
      <CafeMenuItem
        key={product.config.menuEntryId}
        id={product.config.menuEntryId}
        itemKey={product.config.menuEntryId}
        flavor={product.config.flavor}
        imageUrl={product.config.imageUrl}
        imageAlt={product.config.imageAlt}
        category={
          category ??
          (product.config.category === "drink"
            ? copy.categoryDrinks
            : copy.categoryBakes)
        }
        title={productCopy.title}
        description={productCopy.description}
        allergenLine={
          productCopy.allergens.length === 0
            ? undefined
            : `${copy.containsLabel}: ${productCopy.allergens}`
        }
        preparationLabel={preparation.label}
        timingLabel={preparation.timing}
        price={product.entry.price}
        availability={product.entry.availability}
        soldOutLabel={copy.soldOut}
        addVisibleLabel={copy.addAction}
        addLabel={`${copy.addOne} ${productCopy.title}`}
        removeLabel={`${copy.removeOne} ${productCopy.title}`}
        selectedLabel={copy.selected}
        quantity={quantity}
        onDecrease={this.decreaseCafeQuantity}
        onIncrease={this.increaseCafeQuantity}
      >
        <CafeModifierControls
          menuEntryId={product.config.menuEntryId}
          groups={product.entry.modifierGroups}
          selectedOptionIds={cafeBasketModifiers(
            basket,
            product.config.menuEntryId,
          )}
          disabled={product.entry.availability === "unavailable"}
          language={this.#cafeLanguage}
          label={
            product.config.flavor === "menu"
              ? product.entry.modifierGroups
                  .map((group) => group.name)
                  .join(" · ")
              : copy.milkChoice
          }
          onChange={this.changeCafeModifier}
        />
      </CafeMenuItem>
    );
  }

  renderShippingCatalog(
    state: Variant<StorefrontState, "catalog">,
  ): React.ReactNode {
    const catalog = state.context.catalog;
    const basket =
      state.context.basket.kind === "shipping"
        ? state.context.basket
        : initialShippingBasket(catalog);
    const selection = shippingSelection(catalog, basket);
    const serviceSelection = shippingServiceSelection(catalog, basket);
    const shippingServices = shippingServicesForCountry(
      catalog,
      basket.address.countryCode,
    );
    const deliveryAvailable = shippingServices.some(isAvailableShippingService);
    const orderLines = selection.ok
      ? shippingOrderLines(selection.value, basket)
      : [];
    const countryCopy = shippingCountryCopy(basket.address.countryCode);
    const contactPolicy = buyerContactPolicy(state.context.session);
    return (
      <div className="shipping-store">
        <section className="shipping-hero">
          <div>
            <p className="eyebrow">From Tokyo, with care</p>
            <h1 tabIndex={-1}>Small-batch treats, ready to travel</h1>
            <p>{countryCopy.heroDetail}</p>
            <div className="shipping-hero-actions">
              <a
                className="primary-button shipping-hero-cta"
                href="#shipping-catalog-heading"
              >
                Shop gift boxes
              </a>
            </div>
          </div>
          <img
            src="/products/nuki-neko-madeleines.webp"
            alt="Five golden cat-shaped madeleines on a cream ceramic plate"
            width={1448}
            height={1086}
          />
        </section>
        {catalog.listings.length === 0 ? (
          <EmptyCatalog
            message="No gift boxes are published right now."
            actionLabel="Check again"
            onAction={this.retryBootstrap}
          />
        ) : (
          <div className="shipping-layout">
            <section
              className="shipping-catalog"
              aria-labelledby="shipping-catalog-heading"
            >
              <div className="shipping-catalog-heading">
                <div>
                  <p className="eyebrow">Baked in Japan</p>
                  <h2 id="shipping-catalog-heading">Choose your gift box</h2>
                </div>
                <span>{shippingListingCount(catalog.listings.length)}</span>
              </div>
              <p className="shipping-selection-guide">
                Select gift boxes for this delivery. You can order up to 12
                boxes of each selected style.
              </p>
              <div className="shipping-catalog-grid">
                {this.renderShippingListings(catalog, basket)}
              </div>
              <ul className="shipping-benefits">
                <li>Six handmade cookies in every box</li>
                <li>
                  Carrier service and estimated delivery dates confirmed in your
                  quote
                </li>
                <li>Shipping, duty, and tax shown before payment</li>
                <li>All prices shown in Japanese yen</li>
                <li>Contains wheat, dairy, egg, and almond</li>
              </ul>
            </section>
            <form
              className="address-form"
              id="shipping-delivery"
              aria-labelledby="shipping-delivery-heading"
              noValidate
              onSubmit={this.createShippingQuote}
            >
              <div>
                <p className="eyebrow">Checkout</p>
                <h2 id="shipping-delivery-heading">
                  {countryCopy.deliveryHeading}
                </h2>
                <p>{countryCopy.deliveryDetail}</p>
              </div>
              {selection.ok ? (
                <div className="shipping-order-lines">{orderLines}</div>
              ) : (
                <p className="shipping-order-empty">{selection.message}</p>
              )}
              <div className="shipping-destination-summary">
                <label htmlFor="shippingCountry">Delivery country</label>
                <select
                  id="shippingCountry"
                  name="shippingCountry"
                  value={basket.address.countryCode}
                  onChange={this.changeShippingCountry}
                >
                  {shippingCountryOptions(
                    catalog,
                    basket.address.countryCode,
                  ).map((country) => (
                    <option key={country} value={country}>
                      {shippingCountryCopy(country).name}
                    </option>
                  ))}
                </select>
                <small>{countryCopy.destinationDetail}</small>
              </div>
              {shippingServices.length > 0 ? (
                <fieldset className="shipping-service-options">
                  <legend>Delivery service</legend>
                  <p>
                    {deliveryAvailable
                      ? "Select how this order should ship. Your quote confirms the price and delivery dates."
                      : "Delivery is temporarily unavailable. Try again later."}
                  </p>
                  <div>
                    {this.renderShippingServiceOptions(
                      shippingServices,
                      basket.shippingServiceCode,
                    )}
                  </div>
                </fieldset>
              ) : (
                <p className="shipping-order-empty">{countryCopy.noServices}</p>
              )}
              {deliveryAvailable ? (
                <>
                  <p className="basket-footnote">
                    {buyerContactPolicyCopy(contactPolicy, this.#cafeLanguage)}
                  </p>
                  <FormField
                    id="shippingEmail"
                    label="Email"
                    type="email"
                    autoComplete="email"
                    placeholder="name@example.com"
                    error={contactFieldError(
                      this.#shippingFormSubmitted,
                      "email",
                      basket.buyerContact.email,
                      contactPolicy,
                    )}
                    value={basket.buyerContact.email}
                    onChange={this.changeBuyerEmail}
                  />
                  {buyerPhoneIsVisible(contactPolicy) ? (
                    <FormField
                      id="shippingPhone"
                      label={
                        buyerPhoneIsRequired(contactPolicy)
                          ? "Phone"
                          : "Phone (optional)"
                      }
                      type="tel"
                      autoComplete="tel"
                      pattern="\+[1-9][0-9]{7,14}"
                      placeholder="+819012345678"
                      hint="Include + and the country code."
                      error={contactFieldError(
                        this.#shippingFormSubmitted,
                        "phone",
                        basket.buyerContact.phone,
                        contactPolicy,
                      )}
                      value={basket.buyerContact.phone}
                      onChange={this.changeBuyerPhone}
                      required={buyerPhoneIsRequired(contactPolicy)}
                    />
                  ) : null}
                  <FormField
                    id="recipientName"
                    label="Recipient name"
                    autoComplete="shipping name"
                    error={shippingFieldError(
                      this.#shippingFormSubmitted,
                      "recipientName",
                      basket.address,
                    )}
                    value={basket.address.recipientName}
                    onChange={this.changeRecipientName}
                  />
                  <FormField
                    id="addressLine1"
                    label="Street address"
                    autoComplete="shipping address-line1"
                    error={shippingFieldError(
                      this.#shippingFormSubmitted,
                      "addressLine1",
                      basket.address,
                    )}
                    value={basket.address.addressLine1}
                    onChange={this.changeAddressLine1}
                  />
                  {basket.address.countryCode !== "SG" ? (
                    <FormField
                      id="shippingLocality"
                      label={countryCopy.localityLabel}
                      autoComplete="shipping address-level2"
                      error={shippingFieldError(
                        this.#shippingFormSubmitted,
                        "locality",
                        basket.address,
                      )}
                      value={basket.address.locality}
                      onChange={this.changeShippingLocality}
                    />
                  ) : null}
                  {basket.address.administrativeArea !== undefined ? (
                    <FormField
                      id="shippingAdministrativeArea"
                      label={countryCopy.areaLabel}
                      autoComplete="shipping address-level1"
                      error={shippingFieldError(
                        this.#shippingFormSubmitted,
                        "administrativeArea",
                        basket.address,
                      )}
                      value={basket.address.administrativeArea}
                      onChange={this.changeShippingAdministrativeArea}
                    />
                  ) : null}
                  <FormField
                    id="postalCode"
                    label={countryCopy.postalLabel}
                    autoComplete="shipping postal-code"
                    inputMode={countryCopy.postalInputMode}
                    pattern={countryCopy.postalPattern}
                    hint={countryCopy.postalHint}
                    error={shippingFieldError(
                      this.#shippingFormSubmitted,
                      "postalCode",
                      basket.address,
                    )}
                    value={basket.address.postalCode}
                    onChange={this.changePostalCode}
                  />
                  <button className="primary-button" type="submit">
                    Continue to delivery quote
                  </button>
                </>
              ) : null}
            </form>
          </div>
        )}
        {selection.ok && serviceSelection.ok ? (
          <aside
            className="shipping-mobile-summary"
            aria-label="Selected gift boxes"
          >
            <div>
              <ul className="shipping-mobile-summary-lines">
                {shippingOrderSummaryLines(selection.value, basket)}
              </ul>
              <small>
                Items subtotal{" "}
                {money(shippingBasketSubtotal(selection.value, basket))}
              </small>
            </div>
            <button
              className="primary-button"
              type="submit"
              form="shipping-delivery"
            >
              Continue
            </button>
          </aside>
        ) : null}
        <FeedbackView feedback={state.feedback} />
      </div>
    );
  }

  renderShippingAddressCorrection(
    state: Variant<StorefrontState, "shipping_address_correction">,
  ): React.ReactNode {
    if (state.context.basket.kind !== "shipping") return null;
    const entered = normalizedShippingAddress(state.context.basket.address);
    const proposed = shippingAddressForCountry(
      state.validation.proposedAddress,
      state.context.basket.address.countryCode,
    );
    if (proposed === undefined) return null;
    const countryCopy = shippingCountryCopy(
      state.context.basket.address.countryCode,
    );
    return (
      <section
        className="status-card"
        aria-labelledby="address-correction-heading"
      >
        <p className="eyebrow">Review delivery address</p>
        <h1 id="address-correction-heading" tabIndex={-1}>
          Use the suggested address?
        </h1>
        <p>{countryCopy.correctionDetail}</p>
        <div className="address-correction-comparison">
          <section aria-labelledby="entered-address-heading">
            <h2 id="entered-address-heading">As entered</h2>
            <address>{shippingAddressSummary(entered)}</address>
          </section>
          <section aria-labelledby="suggested-address-heading">
            <h2 id="suggested-address-heading">Suggested address</h2>
            <address>{shippingAddressSummary(proposed)}</address>
          </section>
        </div>
        <div className="status-actions">
          <button
            className="primary-button"
            type="button"
            onClick={this.acceptShippingAddressCorrection}
          >
            Use suggested address
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={this.editShippingAddressCorrection}
          >
            Edit address
          </button>
        </div>
      </section>
    );
  }

  renderShippingListings(
    catalog: CommerceBuyerCatalogV1,
    basket: ShippingBasket,
  ): readonly React.ReactNode[] {
    const items: React.ReactNode[] = [];
    for (const listing of catalog.listings)
      items.push(this.renderShippingListing(listing, basket));
    return items;
  }

  renderShippingServiceOptions(
    services: readonly CommerceBuyerShippingServiceV1[],
    selectedServiceCode: string | undefined,
  ): readonly React.ReactNode[] {
    const options: React.ReactNode[] = [];
    for (const service of services) {
      const available = isAvailableShippingService(service);
      options.push(
        <label key={`${service.destinationCountry}:${service.service.code}`}>
          <input
            type="radio"
            name="shippingServiceCode"
            value={service.service.code}
            checked={service.service.code === selectedServiceCode}
            onChange={this.changeShippingService}
            disabled={!available}
          />
          <span>
            {available
              ? service.service.name
              : `${service.service.name} — Temporarily unavailable`}
          </span>
        </label>,
      );
    }
    return options;
  }

  renderShippingListing(
    listing: CommerceBuyerCatalogListingV1,
    basket: ShippingBasket,
  ): React.ReactNode {
    const image = shippingListingImage(listing);
    const available = listing.availability === "available";
    const item = shippingBasketItem(basket, listing.variantId);
    const selected = available && item !== undefined;
    return (
      <article
        key={listing.variantId}
        className={`shipping-product shipping-catalog-item shipping-catalog-item-${listing.availability}${selected ? " shipping-catalog-item-selected" : ""}`}
      >
        <div className="shipping-catalog-media">
          <img
            src={image.imageUrl}
            alt={image.imageAlt}
            width={1448}
            height={1086}
            loading="lazy"
          />
          {available ? (
            selected ? (
              <span className="shipping-selected-badge">✓ Selected</span>
            ) : null
          ) : (
            <span>Sold out</span>
          )}
        </div>
        <div className="shipping-product-copy">
          <p className="eyebrow">Baked in Japan</p>
          <h3>{listing.title}</h3>
          <p>{listing.description}</p>
          <div className="shipping-price">
            <strong>{money(listing.price)}</strong>
            {available ? <span>In stock</span> : null}
          </div>
          <QuantityStepper
            itemKey={listing.variantId}
            label={listing.title}
            addVisibleLabel="Select box"
            addLabel={`Choose the ${listing.title}`}
            removeLabel={`Remove one ${listing.title}`}
            selectedLabel="selected"
            value={selected && item !== undefined ? item.quantity : 0}
            minimum={0}
            maximum={available ? 12 : 0}
            onDecrease={this.decreaseShippingQuantity}
            onIncrease={this.increaseShippingQuantity}
          />
        </div>
      </article>
    );
  }

  renderPickupQuote(
    state: Variant<StorefrontState, "pickup_quote">,
  ): React.ReactNode {
    const copy = cafeInterfaceCopy(this.#cafeLanguage);
    const merchantDisplayName =
      state.context.session.checkoutProfileConfiguration.presentationPolicy
        .merchantDisplayName;
    const selection =
      this.props.config.kind === "cafe"
        ? cafeSelection(state.context.catalog, this.props.config)
        : { ok: false as const, message: "The café set is unavailable." };
    if (!selection.ok || state.context.basket.kind !== "cafe") {
      return (
        <StatusView
          title="The order could not be reviewed"
          detail={
            selection.ok ? "The café basket is unavailable." : selection.message
          }
          actionLabel={copy.editOrder}
          onAction={this.editBasket}
        />
      );
    }
    return (
      <CheckoutView
        eyebrow={copy.reviewEyebrow}
        title={copy.reviewHeading}
        detail={copy.reviewDetail}
        facts={[
          {
            label: copy.pickupAt.replace("{name}", merchantDisplayName),
            value: formatPickupMoment(
              state.quote.quote.pickup.readyAt,
              this.#cafeLanguage,
            ),
          },
        ]}
        reviewLines={cafeCheckoutReviewLines(
          state.quote,
          state.context.catalog,
          this.props.config,
          copy,
          this.#cafeLanguage,
        )}
        totals={state.quote.quote.totals}
        expired={state.expired}
        expiresAt={state.quote.quote.expiresAt}
        holdLabel={copy.quoteHold}
        copy={cafeCheckoutCopy(copy, state.quote.quote.totals.total)}
        feedback={state.feedback}
        onEdit={this.editBasket}
        onRefresh={this.refreshQuote}
        onPay={this.pay}
      />
    );
  }

  renderShippingQuote(
    state: Variant<StorefrontState, "shipping_quote">,
  ): React.ReactNode {
    const quote = state.quote.quote;
    const countryCode = parseShippingCountry(quote.shipping.destinationCountry);
    if (countryCode === undefined) return null;
    const address =
      state.context.basket.kind === "shipping"
        ? shippingAddressForCountry(
            normalizedShippingAddress(state.context.basket.address),
            countryCode,
          )
        : undefined;
    const countryCopy = shippingCountryCopy(countryCode);
    const facts = [
      ...(address === undefined
        ? []
        : [
            {
              label: "Deliver to",
              value: shippingAddressSummary(address),
            },
          ]),
      {
        label: "Estimated delivery",
        value: formatDateRange(
          quote.shipping.estimatedDelivery.earliest,
          quote.shipping.estimatedDelivery.latest,
          countryCode,
        ),
      },
      {
        label: "Import duties",
        value: shippingDutyMessage(quote.shipping.dutyTerms.incoterm),
      },
    ];
    return (
      <CheckoutView
        eyebrow={countryCopy.quoteEyebrow}
        title={countryCopy.quoteTitle}
        detail={`${quote.shipping.service.name} · ${countryCopy.quoteDetail}`}
        facts={facts}
        evidence={<ShippingQuoteEvidence quote={state.quote} />}
        reviewLines={shippingCheckoutReviewLines(
          state.quote,
          state.context.catalog.listings,
        )}
        totals={quote.totals}
        expired={state.expired}
        expiresAt={quote.expiresAt}
        holdLabel="Price and stock held"
        copy={shippingCheckoutCopy(quote.totals.total)}
        feedback={state.feedback}
        onEdit={this.editBasket}
        onRefresh={this.refreshQuote}
        onPay={this.pay}
      />
    );
  }

  renderPickupOrder(
    state: Variant<StorefrontState, "pickup_order">,
  ): React.ReactNode {
    const copy = cafeInterfaceCopy(this.#cafeLanguage);
    const basePresentation: OrderStatusPresentation = {
      title: cafeOrderTitle(state.order.state, copy),
      detail: pickupOrderDetail(state.order, this.#cafeLanguage),
      nextAction: pickupOrderNextAction(state.order, this.#cafeLanguage),
      timeline: pickupOrderTimeline(state.order, this.#cafeLanguage),
      complete: state.order.state === "completed",
    };
    const paymentReview = paymentReviewPresentation(
      state.order.paymentDisputes,
      this.#cafeLanguage,
    );
    return (
      <OrderView
        eyebrow={copy.pickupEyebrow}
        title={basePresentation.title}
        detail={basePresentation.detail}
        orderCode={{
          label: copy.pickupCodeLabel,
          value: commercePickupCode(state.order.orderId),
        }}
        total={state.order.total}
        complete={
          basePresentation.complete && !(paymentReview?.active ?? false)
        }
        lastUpdated={
          basePresentation.lastUpdated ??
          buyerOrderLastUpdated(state.order, this.#cafeLanguage)
        }
        nextAction={basePresentation.nextAction}
        timeline={orderTimelineWithPaymentReview(
          basePresentation,
          paymentReview,
          this.#cafeLanguage,
        )}
        paymentReview={paymentReview}
        receipt={readOrderReceipt(state.access.checkoutId)}
        receiptHeading={copy.orderSummary}
        returnUrl={state.access.returnUrl}
        qrDetail={copy.qrDetail}
        feedback={state.feedback}
        onRefresh={this.refreshOrder}
        onCopyLink={this.copyOrderLink}
        copy={cafeOrderViewCopy(copy)}
        handoff={
          this.#kioskMode
            ? {
                kind: "pickup_kiosk",
                heading: copy.kioskHeading,
                detail: copy.kioskDetail,
                clearLabel: copy.clearKiosk,
                confirmHeading: copy.kioskConfirmHeading,
                confirmDetail: copy.kioskConfirmDetail,
                confirmClear: copy.kioskConfirmClear,
                confirmKeep: copy.kioskConfirmKeep,
                onClear: this.clearPickupKiosk,
              }
            : { kind: "standard" }
        }
      />
    );
  }

  renderShippingOrder(
    state: Variant<StorefrontState, "shipping_order">,
  ): React.ReactNode {
    const order = state.order;
    const countryCode = parseShippingCountry(order.shipping.destinationCountry);
    if (countryCode === undefined) return null;
    const countryCopy = shippingCountryCopy(countryCode);
    const receipt = readOrderReceipt(state.access.checkoutId);
    const facts = [
      ...(order.shipping.estimatedDelivery.kind === "window"
        ? [
            {
              label: "Estimated delivery",
              value: formatDateRange(
                order.shipping.estimatedDelivery.earliest,
                order.shipping.estimatedDelivery.latest,
                countryCode,
              ),
            },
          ]
        : []),
      ...(order.state === "ready"
        ? []
        : [{ label: "Tracking number", value: order.trackingNumber }]),
    ];
    const basePresentation: OrderStatusPresentation = {
      title: shippingOrderTitle(order.state, countryCopy.name),
      detail: shippingOrderDetail(order),
      nextAction: shippingOrderNextAction(order),
      timeline: shippingOrderTimeline(order),
      complete: order.state === "delivered",
    };
    const paymentReview = paymentReviewPresentation(
      order.paymentDisputes,
      this.#cafeLanguage,
    );
    return (
      <OrderView
        eyebrow={countryCopy.orderEyebrow}
        title={basePresentation.title}
        detail={basePresentation.detail}
        orderCode={{
          label: "Order reference",
          value: commercePickupCode(order.orderId),
        }}
        total={order.total}
        complete={
          basePresentation.complete && !(paymentReview?.active ?? false)
        }
        lastUpdated={buyerOrderLastUpdated(order, this.#cafeLanguage)}
        nextAction={basePresentation.nextAction}
        timeline={orderTimelineWithPaymentReview(
          basePresentation,
          paymentReview,
          this.#cafeLanguage,
        )}
        paymentReview={paymentReview}
        facts={facts}
        receipt={receipt}
        receiptHeading="Order summary"
        returnUrl={state.access.returnUrl}
        qrDetail="Scan with your phone to keep your order status with you."
        feedback={state.feedback}
        onRefresh={this.refreshOrder}
        onCopyLink={this.copyOrderLink}
        copy={shippingOrderViewCopy()}
        handoff={{ kind: "standard" }}
      />
    );
  }
}

function shippingDutyMessage(
  incoterm: "not_applicable" | "ddp" | "dap",
): string {
  switch (incoterm) {
    case "not_applicable":
      return "No import duties";
    case "ddp":
      return "Included in the checkout total";
    case "dap":
      return "Pay the carrier when the shipment arrives";
  }
}

type ProviderPaymentViewProps = Readonly<{
  session: CommercePaymentPublicSessionV1;
  total: Readonly<{ amountMinor: number; currency: string }>;
  onConfirmed: (confirmation: CommercePaymentClientConfirmationV1) => void;
}>;

type ProviderPaymentViewState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; message: string | null }>
  | Readonly<{ kind: "submitting" }>
  | Readonly<{ kind: "failed"; message: string }>;

class ProviderPaymentView extends React.Component<
  ProviderPaymentViewProps,
  ProviderPaymentViewState
> {
  state: ProviderPaymentViewState = { kind: "loading" };
  #stripe: StripeClient | undefined;
  #stripeElements: StripeElements | undefined;
  #stripePaymentElement: StripePaymentElement | undefined;
  #squareCard: SquareCard | undefined;

  componentDidMount(): void {
    void this.mountProvider();
  }

  componentWillUnmount(): void {
    this.#stripePaymentElement?.unmount();
    if (this.#squareCard !== undefined) void this.#squareCard.destroy();
  }

  async mountProvider(): Promise<void> {
    const session = this.props.session;
    if (session.kind === "hosted_redirect") {
      this.setState({ kind: "ready", message: null });
      return;
    }
    switch (session.publicConfiguration.provider) {
      case "stripe_online":
        await this.mountStripe(session.publicConfiguration);
        return;
      case "square_online":
        await this.mountSquare(session.publicConfiguration);
        return;
      case "gmo_pg_online":
        this.setState({
          kind: "failed",
          message:
            "This payment collection method is not published for this storefront.",
        });
        return;
      default:
        return assertNever(
          session.publicConfiguration,
          "Unhandled storefront state",
        );
    }
  }

  async mountStripe(
    configuration: VariantBy<
      Variant<
        CommercePaymentPublicSessionV1,
        "embedded_public_session"
      >["publicConfiguration"],
      "provider",
      "stripe_online"
    >,
  ): Promise<void> {
    try {
      await loadProviderScript(
        "stripe-payment-sdk",
        "https://js.stripe.com/clover/stripe.js",
      );
      if (window.Stripe === undefined)
        throw new Error("Stripe payment collection did not load.");
      this.#stripe = window.Stripe(configuration.publishableKey, {
        stripeAccount: configuration.connectedAccountId,
      });
      this.#stripeElements = this.#stripe.elements({
        clientSecret: configuration.clientSecret,
      });
      this.#stripePaymentElement = this.#stripeElements.create("payment");
      this.#stripePaymentElement.mount("#stripe-payment-element");
      this.setState({ kind: "ready", message: null });
    } catch (error) {
      this.setState({ kind: "failed", message: paymentUiError(error) });
    }
  }

  async mountSquare(
    configuration: VariantBy<
      Variant<
        CommercePaymentPublicSessionV1,
        "embedded_public_session"
      >["publicConfiguration"],
      "provider",
      "square_online"
    >,
  ): Promise<void> {
    try {
      const source =
        configuration.environment === "production"
          ? "https://web.squarecdn.com/v1/square.js"
          : "https://sandbox.web.squarecdn.com/v1/square.js";
      await loadProviderScript("square-payment-sdk", source);
      if (window.Square === undefined)
        throw new Error("Square payment collection did not load.");
      const payments = window.Square.payments(
        configuration.applicationId,
        configuration.locationId,
      );
      this.#squareCard = await payments.card();
      await this.#squareCard.attach("#square-card-element");
      this.setState({ kind: "ready", message: null });
    } catch (error) {
      this.setState({ kind: "failed", message: paymentUiError(error) });
    }
  }

  submitPayment = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const session = this.props.session;
    if (this.state.kind !== "ready") return;
    if (session.kind === "hosted_redirect") {
      window.location.assign(session.redirectUrl);
      return;
    }
    switch (session.publicConfiguration.provider) {
      case "stripe_online":
        void this.submitStripe(session.publicConfiguration.clientSecret);
        return;
      case "square_online":
        void this.submitSquare();
        return;
      case "gmo_pg_online":
        return;
      default:
        return assertNever(
          session.publicConfiguration,
          "Unhandled storefront state",
        );
    }
  };

  async submitStripe(clientSecret: string): Promise<void> {
    if (this.#stripe === undefined || this.#stripeElements === undefined)
      return;
    this.setState({ kind: "submitting" });
    try {
      const submission = await this.#stripeElements.submit();
      if (submission.error !== undefined) {
        this.setState({
          kind: "ready",
          message: providerErrorMessage(submission.error),
        });
        return;
      }
      const confirmation = await this.#stripe.confirmPayment({
        elements: this.#stripeElements,
        clientSecret,
        confirmParams: { return_url: window.location.href },
        redirect: "if_required",
      });
      if (confirmation.error !== undefined) {
        this.setState({
          kind: "ready",
          message: providerErrorMessage(confirmation.error),
        });
        return;
      }
      this.props.onConfirmed({ kind: "provider_ui_completed" });
    } catch (error) {
      this.setState({ kind: "ready", message: paymentUiError(error) });
    }
  }

  async submitSquare(): Promise<void> {
    if (this.#squareCard === undefined) return;
    this.setState({ kind: "submitting" });
    try {
      const tokenization = await this.#squareCard.tokenize({
        amount: (this.props.total.amountMinor / 100).toFixed(2),
        currencyCode: this.props.total.currency,
        intent: "CHARGE",
      });
      if (tokenization.status === "OK" && "token" in tokenization) {
        this.props.onConfirmed({
          kind: "square_source_token",
          sourceToken: tokenization.token,
        });
        return;
      }
      const error =
        "errors" in tokenization ? tokenization.errors?.[0] : undefined;
      this.setState({ kind: "ready", message: providerErrorMessage(error) });
    } catch (error) {
      this.setState({ kind: "ready", message: paymentUiError(error) });
    }
  }

  render(): React.ReactNode {
    const session = this.props.session;
    const hosted = session.kind === "hosted_redirect";
    return (
      <section
        className="checkout-card payment-collection-card"
        aria-labelledby="payment-heading"
      >
        <p className="eyebrow">Secure checkout</p>
        <h1 id="payment-heading" tabIndex={-1}>
          Complete payment
        </h1>
        <p>
          Your payment details are handled directly by the selected payment
          provider.
        </p>
        <form className="provider-payment-form" onSubmit={this.submitPayment}>
          {hosted ? (
            <p>
              You’ll continue to the provider’s secure page and return here when
              payment is complete.
            </p>
          ) : (
            this.renderEmbeddedProvider(session)
          )}
          {paymentFormError(this.state) === null ? null : (
            <p className="form-error" role="alert">
              {paymentFormError(this.state)}
            </p>
          )}
          <button type="submit" disabled={this.state.kind !== "ready"}>
            {this.state.kind === "loading"
              ? "Loading secure payment…"
              : this.state.kind === "submitting"
                ? "Confirming payment…"
                : hosted
                  ? "Continue to secure payment"
                  : `Pay ${money(this.props.total)}`}
          </button>
        </form>
      </section>
    );
  }

  renderEmbeddedProvider(
    session: Variant<
      CommercePaymentPublicSessionV1,
      "embedded_public_session"
    >,
  ): React.ReactNode {
    switch (session.publicConfiguration.provider) {
      case "stripe_online":
        return (
          <div
            id="stripe-payment-element"
            className="provider-payment-element"
            aria-label="Payment details"
          />
        );
      case "square_online":
        return (
          <div
            id="square-card-element"
            className="provider-payment-element"
            aria-label="Card details"
          />
        );
      case "gmo_pg_online":
        return <p>This payment collection method is unavailable.</p>;
      default:
        return assertNever(
          session.publicConfiguration,
          "Unhandled storefront state",
        );
    }
  }
}

async function loadProviderScript(id: string, source: string): Promise<void> {
  const existing = document.getElementById(id);
  if (existing instanceof HTMLScriptElement) {
    if (existing.dataset.loaded === "true") return;
    await waitForProviderScript(existing);
    return;
  }
  const script = document.createElement("script");
  script.id = id;
  script.src = source;
  script.async = true;
  document.head.append(script);
  await waitForProviderScript(script);
}

function waitForProviderScript(script: HTMLScriptElement): Promise<void> {
  return new Promise((resolve, reject) => {
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => reject(new Error("The secure payment service could not load.")),
      { once: true },
    );
  });
}

function providerErrorMessage(error: ProviderUiError | undefined): string {
  return (
    error?.message?.trim() ||
    "Payment details could not be confirmed. Check them and try again."
  );
}

function paymentFormError(state: ProviderPaymentViewState): string | null {
  return state.kind === "failed" || state.kind === "ready"
    ? state.message
    : null;
}

function paymentUiError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The secure payment service is temporarily unavailable.";
}

class MobileCheckoutBar extends React.Component<
  Readonly<{
    count: number;
    label: string;
    total: string;
    /** Opens the cart drawer instead of scrolling to the basket. */
    onOpen?: () => void;
  }>,
  Readonly<{ basketVisible: boolean }>
> {
  state = { basketVisible: false };
  #observer: IntersectionObserver | undefined;

  componentDidMount(): void {
    const basket = document.querySelector(".cafe-basket");
    if (basket === null || typeof IntersectionObserver === "undefined") return;
    this.#observer = new IntersectionObserver(this.handleIntersection, {
      threshold: 0.25,
    });
    this.#observer.observe(basket);
  }

  componentWillUnmount(): void {
    this.#observer?.disconnect();
  }

  handleIntersection = (
    entries: readonly IntersectionObserverEntry[],
  ): void => {
    const entry = entries[0];
    if (entry !== undefined)
      this.setState({ basketVisible: entry.isIntersecting });
  };

  render(): React.ReactNode {
    const className = this.state.basketVisible
      ? "mobile-checkout-bar mobile-checkout-bar-hidden"
      : "mobile-checkout-bar";
    const contents = (
      <>
        <span className="mobile-checkout-count" aria-hidden="true">
          {this.props.count}
        </span>
        <strong>{this.props.label}</strong>
        <span className="mobile-checkout-total">{this.props.total}</span>
      </>
    );
    return this.props.onOpen === undefined ? (
      <a className={className} href="#pickup-summary-heading">
        {contents}
      </a>
    ) : (
      <button
        className="mobile-checkout-bar"
        type="button"
        onClick={this.props.onOpen}
      >
        {contents}
      </button>
    );
  }
}

function CafeFlavorMenu(
  props: Readonly<{ copy: CafeFlavorMenuCopy; showcase: boolean }>,
): React.ReactNode {
  // The menu art carries the Nuki Café name, so only the showcase shows it.
  return (
    <section
      className={
        props.showcase
          ? "cafe-flavor-menu"
          : "cafe-flavor-menu cafe-flavor-menu-plain"
      }
      aria-labelledby="cafe-flavor-menu-heading"
    >
      {props.showcase ? (
        <figure className="cafe-flavor-menu-art">
          <img
            src="/products/nuki-french-taiwanese-menu.webp"
            alt={props.copy.imageAlt}
            width={1024}
            height={1536}
          />
        </figure>
      ) : null}
      <div className="cafe-flavor-menu-copy">
        <p className="eyebrow">{props.copy.eyebrow}</p>
        <h2 id="cafe-flavor-menu-heading">{props.copy.heading}</h2>
        <p>{props.copy.detail}</p>
        <div className="cafe-flavor-grid">
          {props.copy.groups.map(renderCafeFlavorGroup)}
        </div>
        <p className="cafe-packaging-note">{props.copy.packagingDetail}</p>
      </div>
    </section>
  );
}

function renderCafeFlavorGroup(group: CafeFlavorMenuGroup): React.ReactNode {
  return (
    <section
      className={`cafe-flavor-group cafe-flavor-${group.id}`}
      key={group.id}
    >
      <h3>
        <span aria-hidden="true" />
        {group.name}
      </h3>
      <ul>
        <li>
          <a href={`#${group.productIds[0]}`}>{group.items[0]}</a>
        </li>
        <li>
          <a href={`#${group.productIds[1]}`}>{group.items[1]}</a>
        </li>
        <li>
          <a href={`#${group.productIds[2]}`}>{group.items[2]}</a>
        </li>
      </ul>
    </section>
  );
}

function CafeMenuItem(
  props: Readonly<{
    id: string;
    itemKey: string;
    flavor: CafeProductConfiguration["flavor"];
    imageUrl: string | undefined;
    imageAlt: string;
    category: string;
    title: string;
    description: string;
    allergenLine?: string;
    preparationLabel: string;
    timingLabel: string;
    price: Readonly<{ amountMinor: number; currency: string }>;
    availability: "available" | "unavailable";
    soldOutLabel: string;
    addVisibleLabel: string;
    addLabel: string;
    removeLabel: string;
    selectedLabel: string;
    quantity: number;
    onDecrease: React.MouseEventHandler<HTMLButtonElement>;
    onIncrease: React.MouseEventHandler<HTMLButtonElement>;
    children?: React.ReactNode;
  }>,
): React.ReactNode {
  return (
    <article
      className={`cafe-menu-item cafe-menu-item-${props.availability} cafe-menu-item-${props.flavor}`}
      id={props.id}
    >
      <div className="cafe-menu-item-media">
        {props.imageUrl === undefined ? (
          <div className="cafe-menu-item-mark" aria-hidden="true">
            {props.title.slice(0, 1)}
          </div>
        ) : (
          <img
            src={props.imageUrl}
            alt={props.imageAlt}
            width={1448}
            height={1086}
            loading="lazy"
          />
        )}
        {props.availability === "unavailable" ? (
          <span>{props.soldOutLabel}</span>
        ) : null}
      </div>
      <div className="cafe-menu-item-copy">
        <div>
          <p className="eyebrow">{props.category}</p>
          <h4>{props.title}</h4>
          <p>{props.description}</p>
          {props.preparationLabel.length === 0 ? null : (
            <div className="menu-item-details">
              <span>{props.preparationLabel}</span>
              <span>{props.timingLabel}</span>
            </div>
          )}
          {props.allergenLine === undefined ? null : (
            <p className="menu-item-allergens">{props.allergenLine}</p>
          )}
        </div>
        {props.children}
        <strong className="menu-item-price">{money(props.price)}</strong>
        <QuantityStepper
          itemKey={props.itemKey}
          label={props.title}
          addVisibleLabel={props.addVisibleLabel}
          addLabel={props.addLabel}
          removeLabel={props.removeLabel}
          selectedLabel={props.selectedLabel}
          value={props.quantity}
          minimum={0}
          maximum={props.availability === "available" ? 12 : 0}
          onDecrease={props.onDecrease}
          onIncrease={props.onIncrease}
        />
      </div>
    </article>
  );
}

function CafeModifierControls(
  props: Readonly<{
    menuEntryId: string;
    groups: readonly CommerceBuyerModifierGroupV1[];
    selectedOptionIds: readonly string[];
    disabled: boolean;
    language: CafeLanguage;
    label: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
  }>,
): React.ReactNode {
  if (props.groups.length === 0) return null;
  const controls: React.ReactNode[] = [];
  for (const group of props.groups) {
    for (const option of group.options) {
      controls.push(
        <label className="modifier-control" key={option.modifierOptionId}>
          <input
            type="checkbox"
            data-menu-entry-id={props.menuEntryId}
            value={option.modifierOptionId}
            checked={props.selectedOptionIds.includes(option.modifierOptionId)}
            disabled={props.disabled}
            onChange={props.onChange}
          />
          <span>
            <strong>
              {cafeModifierName(
                props.language,
                option.modifierOptionId,
                option.name,
              )}
            </strong>
            <small>+{money(option.priceDelta)}</small>
          </span>
        </label>,
      );
    }
  }
  return (
    <fieldset className="modifier-group">
      <legend>{props.label}</legend>
      {controls}
    </fieldset>
  );
}

function CafeBasketLine(
  props: Readonly<{
    itemKey: string;
    imageUrl: string | undefined;
    label: string;
    quantity: number;
    total: Readonly<{ amountMinor: number; currency: string }>;
    detail?: string;
    addVisibleLabel: string;
    addLabel: string;
    removeLabel: string;
    selectedLabel: string;
    maximum: 0 | 12;
    onDecrease: React.MouseEventHandler<HTMLButtonElement>;
    onIncrease: React.MouseEventHandler<HTMLButtonElement>;
  }>,
): React.ReactNode {
  return (
    <li>
      {props.imageUrl === undefined ? (
        <span className="basket-line-mark" aria-hidden="true">
          {props.label.slice(0, 1)}
        </span>
      ) : (
        <img src={props.imageUrl} alt="" width={1448} height={1086} />
      )}
      <div>
        <strong>{props.label}</strong>
        {props.detail === undefined ? null : <small>{props.detail}</small>}
        <div className="basket-line-stepper">
          <QuantityStepper
            itemKey={props.itemKey}
            label={props.label}
            addVisibleLabel={props.addVisibleLabel}
            addLabel={props.addLabel}
            removeLabel={props.removeLabel}
            selectedLabel={props.selectedLabel}
            value={props.quantity}
            minimum={0}
            maximum={props.maximum}
            onDecrease={props.onDecrease}
            onIncrease={props.onIncrease}
          />
        </div>
      </div>
      <div className="basket-line-meta">
        <strong>{money(props.total)}</strong>
      </div>
    </li>
  );
}

function FormField(
  props: Readonly<{
    id: string;
    label: string;
    type?: "text" | "email" | "tel";
    autoComplete: string;
    placeholder?: string;
    value: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
    inputMode?: "numeric";
    pattern?: string;
    hint?: string;
    error?: string;
    required?: boolean;
  }>,
): React.ReactNode {
  const hintId = props.hint === undefined ? undefined : `${props.id}-hint`;
  const errorId = props.error === undefined ? undefined : `${props.id}-error`;
  const describedBy = [hintId, errorId].filter(hasText).join(" ");
  return (
    <label className="field" htmlFor={props.id}>
      <span>{props.label}</span>
      <input
        id={props.id}
        name={props.id}
        type={props.type ?? "text"}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        pattern={props.pattern}
        placeholder={props.placeholder}
        spellCheck={props.type === "email" ? false : undefined}
        aria-describedby={describedBy.length === 0 ? undefined : describedBy}
        aria-invalid={props.error === undefined ? undefined : "true"}
        value={props.value}
        onChange={props.onChange}
        required={props.required ?? true}
      />
      {props.hint === undefined ? null : (
        <small id={hintId}>{props.hint}</small>
      )}
      {props.error === undefined ? null : (
        <small className="field-error" id={errorId} role="alert">
          {props.error}
        </small>
      )}
    </label>
  );
}

type QuantityStepperProps = Readonly<{
  itemKey: string;
  label: string;
  addVisibleLabel: string;
  addLabel: string;
  removeLabel: string;
  selectedLabel: string;
  value: number;
  minimum: 0 | 1;
  maximum: 0 | 12;
  onDecrease: React.MouseEventHandler<HTMLButtonElement>;
  onIncrease: React.MouseEventHandler<HTMLButtonElement>;
}>;

class QuantityStepper extends React.PureComponent<QuantityStepperProps> {
  render(): React.ReactNode {
    if (this.props.value === 0) {
      return (
        <button
          className="quantity-add quantity-add-text"
          type="button"
          data-item-key={this.props.itemKey}
          aria-label={this.props.addLabel}
          disabled={this.props.maximum === 0}
          onClick={this.props.onIncrease}
        >
          {this.props.addVisibleLabel}
        </button>
      );
    }
    return (
      <div
        className="quantity-stepper"
        role="group"
        aria-label={`${this.props.label} quantity`}
      >
        <button
          type="button"
          data-item-key={this.props.itemKey}
          aria-label={this.props.removeLabel}
          disabled={this.props.value <= this.props.minimum}
          onClick={this.props.onDecrease}
        >
          −
        </button>
        <output
          aria-live="polite"
          aria-label={`${this.props.value} ${this.props.selectedLabel}`}
        >
          {this.props.value}
        </output>
        <button
          type="button"
          data-item-key={this.props.itemKey}
          aria-label={this.props.addLabel}
          disabled={this.props.value >= this.props.maximum}
          onClick={this.props.onIncrease}
        >
          +
        </button>
      </div>
    );
  }
}

type CheckoutReviewLine = Readonly<{
  key: string;
  label: string;
  detail: string;
  quantity: number;
  total: Readonly<{ amountMinor: number; currency: string }>;
  imageUrl?: string;
}>;

type CheckoutFact = Readonly<{ label: string; value: string }>;

type CheckoutViewCopy = Readonly<{
  items: string;
  shipping: string;
  duty: string;
  tax: string;
  taxIncluded: string;
  total: string;
  expired: string;
  refresh: string;
  pay: string;
  edit: string;
  paymentNote: string;
}>;

function CheckoutView(
  props: Readonly<{
    eyebrow: string;
    title: string;
    detail: string;
    facts?: readonly CheckoutFact[];
    evidence?: React.ReactNode;
    reviewLines: readonly CheckoutReviewLine[];
    totals: CommerceBuyerQuotedCheckoutV1["quote"]["totals"];
    expired: boolean;
    expiresAt: string;
    holdLabel: string;
    copy: CheckoutViewCopy;
    feedback: Feedback;
    onEdit: () => void;
    onRefresh: () => void;
    onPay: () => void;
  }>,
): React.ReactNode {
  return (
    <div className="checkout-shell">
      <section className="checkout-card">
        <p className="eyebrow">{props.eyebrow}</p>
        <h1 tabIndex={-1}>{props.title}</h1>
        <p>{props.expired ? props.copy.expired : props.detail}</p>
        <ul className="checkout-review" aria-label={props.copy.items}>
          {props.reviewLines.map(renderCheckoutReviewLine)}
        </ul>
        {props.facts === undefined || props.facts.length === 0 ? null : (
          <dl className="checkout-facts">
            {props.facts.map(renderCheckoutFact)}
          </dl>
        )}
        {props.evidence}
        <dl className="totals">
          <MoneyRow label={props.copy.items} value={props.totals.subtotal} />
          {props.totals.shipping.amountMinor === 0 ? null : (
            <MoneyRow
              label={props.copy.shipping}
              value={props.totals.shipping}
            />
          )}
          {props.totals.duty.amountMinor === 0 ? null : (
            <MoneyRow label={props.copy.duty} value={props.totals.duty} />
          )}
          <MoneyRow
            label={
              taxIsIncluded(props.totals)
                ? props.copy.taxIncluded
                : props.copy.tax
            }
            value={props.totals.tax}
          />
          <MoneyRow label={props.copy.total} value={props.totals.total} total />
        </dl>
        {props.expired ? (
          <button
            className="primary-button"
            type="button"
            onClick={props.onRefresh}
          >
            {props.copy.refresh}
          </button>
        ) : (
          <button
            className="primary-button"
            type="button"
            onClick={props.onPay}
          >
            {props.copy.pay}
          </button>
        )}
        {props.expired ? null : (
          <QuoteCountdown expiresAt={props.expiresAt} label={props.holdLabel} />
        )}
        <button className="text-button" type="button" onClick={props.onEdit}>
          {props.copy.edit}
        </button>
        <p className="payment-note">{props.copy.paymentNote}</p>
        <FeedbackView feedback={props.feedback} />
      </section>
    </div>
  );
}

type ShippingQuoteEvidenceProps = Readonly<{
  quote: CommerceBuyerQuotedShippingCheckoutV1;
}>;

function ShippingQuoteEvidence(
  props: ShippingQuoteEvidenceProps,
): React.ReactNode {
  const shipping = props.quote.quote.shipping;
  const packageDetails = shipping.packagePlan.package;
  const domestic = shipping.destinationCountry === "JP";
  return (
    <section
      className="shipping-quote-evidence"
      aria-labelledby="shipping-quote-evidence-heading"
    >
      <h2 id="shipping-quote-evidence-heading">Quote evidence</h2>
      <dl className="checkout-facts">
        <div>
          <dt>Address validation reference</dt>
          <dd>{shipping.addressValidationReference}</dd>
        </div>
        <div>
          <dt>Carrier service</dt>
          <dd>
            {shipping.service.name} ({shipping.service.code})
          </dd>
        </div>
        <div>
          <dt>Carrier rate reference</dt>
          <dd>{shipping.carrierQuote.rateReference}</dd>
        </div>
        <div>
          <dt>Carrier amount</dt>
          <dd>{money(shipping.carrierQuote.shippingAmount)}</dd>
        </div>
        <div>
          <dt>Tax quote reference</dt>
          <dd>{shipping.taxQuote.quoteReference}</dd>
        </div>
        <div>
          <dt>Tax amount</dt>
          <dd>{money(shipping.taxQuote.taxAmount)}</dd>
        </div>
        <div>
          <dt>Delivery estimate</dt>
          <dd>
            {formatDateRange(
              shipping.estimatedDelivery.earliest,
              shipping.estimatedDelivery.latest,
              shipping.destinationCountry,
            )}
          </dd>
        </div>
        <div>
          <dt>Quote expires</dt>
          <dd>{formatDate(props.quote.quote.expiresAt, "shipping")}</dd>
        </div>
        {domestic ? (
          <div>
            <dt>Duty</dt>
            <dd>N/A (domestic delivery)</dd>
          </div>
        ) : (
          <>
            <div>
              <dt>Duty quote reference</dt>
              <dd>{shipping.dutyQuote.quoteReference}</dd>
            </div>
            <div>
              <dt>Duty incoterm</dt>
              <dd>{shipping.dutyQuote.incoterm.toUpperCase()}</dd>
            </div>
            <div>
              <dt>Duty amount</dt>
              <dd>{money(shipping.dutyQuote.dutyAmount)}</dd>
            </div>
          </>
        )}
      </dl>
      <h3>Carrier allocations</h3>
      <ul>
        {shipping.carrierQuote.lineAllocations.map(renderShippingAllocation)}
      </ul>
      <h3>Tax allocations</h3>
      <ul>{shipping.taxQuote.lineAllocations.map(renderShippingAllocation)}</ul>
      {domestic ? null : (
        <>
          <h3>Duty allocations</h3>
          <ul>
            {shipping.dutyQuote.lineAllocations.map(renderShippingAllocation)}
          </ul>
        </>
      )}
      <h3>Package</h3>
      <dl className="checkout-facts">
        <div>
          <dt>Package digest</dt>
          <dd>{shipping.packagePlan.packagePlanDigest}</dd>
        </div>
        <div>
          <dt>Package ID</dt>
          <dd>{packageDetails.packageId}</dd>
        </div>
        <div>
          <dt>Package weight</dt>
          <dd>{packageDetails.weight.grams} g</dd>
        </div>
        <div>
          <dt>Package dimensions</dt>
          <dd>
            {packageDetails.dimensions.lengthMillimeters} ×{" "}
            {packageDetails.dimensions.widthMillimeters} ×{" "}
            {packageDetails.dimensions.heightMillimeters} mm
          </dd>
        </div>
      </dl>
      <h3>Line quantities</h3>
      <ul>{packageDetails.lineQuantities.map(renderPackageLineQuantity)}</ul>
      <h3>Customs lines</h3>
      {packageDetails.customsLines.length === 0 ? (
        <p>None required for domestic delivery.</p>
      ) : (
        <ul>{packageDetails.customsLines.map(renderCustomsLine)}</ul>
      )}
    </section>
  );
}

function renderShippingAllocation(
  allocation: CommerceBuyerQuotedShippingCheckoutV1["quote"]["shipping"]["carrierQuote"]["lineAllocations"][number],
): React.ReactNode {
  return (
    <li key={allocation.checkoutLineId}>
      {allocation.checkoutLineId}: {money(allocation.amount)}
    </li>
  );
}

function renderPackageLineQuantity(
  line: CommerceBuyerQuotedShippingCheckoutV1["quote"]["shipping"]["packagePlan"]["package"]["lineQuantities"][number],
): React.ReactNode {
  return (
    <li key={line.checkoutLineId}>
      {line.checkoutLineId}: {packageQuantityLabel(line.quantity)}
    </li>
  );
}

function renderCustomsLine(
  line: CommerceBuyerQuotedShippingCheckoutV1["quote"]["shipping"]["packagePlan"]["package"]["customsLines"][number],
): React.ReactNode {
  return (
    <li key={line.checkoutLineId}>
      {line.checkoutLineId}: {line.description};{" "}
      {packageQuantityLabel(line.quantity)}; {line.weight.grams} g;{" "}
      {line.countryOfOrigin}; HS {line.hsCode}; {money(line.declaredValue)}
    </li>
  );
}

function packageQuantityLabel(
  quantity: Readonly<{ amount: number; scale: number; unit: string }>,
): string {
  return `${quantity.amount / 10 ** quantity.scale} ${quantity.unit}`;
}

class QuoteCountdown extends React.Component<
  Readonly<{ expiresAt: string; label: string }>,
  Readonly<{ now: number }>
> {
  state = { now: Date.now() };
  #timer: number | undefined;

  componentDidMount(): void {
    this.#timer = window.setInterval(this.tick, 1_000);
  }

  componentWillUnmount(): void {
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
  }

  tick = (): void => {
    this.setState({ now: Date.now() });
  };

  render(): React.ReactNode {
    const remaining = Math.max(
      0,
      Date.parse(this.props.expiresAt) - this.state.now,
    );
    if (remaining === 0) return null;
    const totalSeconds = Math.round(remaining / 1_000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return (
      <p className="quote-countdown" aria-hidden="true">
        <span className="quote-countdown-dot" />
        {this.props.label} · {minutes}:{seconds}
      </p>
    );
  }
}

/**
 * A shop whose listed prices include tax (as Japan requires) charges the
 * items, shipping and duty only; its tax is a part of them, not added.
 */
function taxIsIncluded(totals: Readonly<{ taxIncluded?: true }>): boolean {
  return totals.taxIncluded === true;
}

function MoneyRow(
  props: Readonly<{
    label: string;
    value: Readonly<{ amountMinor: number; currency: string }>;
    total?: boolean;
    subtract?: boolean;
  }>,
): React.ReactNode {
  const value =
    props.subtract === true ? `−${money(props.value)}` : money(props.value);
  return (
    <div className={props.total === true ? "total-row" : undefined}>
      <dt>{props.label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function renderCheckoutFact(fact: CheckoutFact): React.ReactNode {
  return (
    <div key={fact.label}>
      <dt>{fact.label}</dt>
      <dd>{fact.value}</dd>
    </div>
  );
}

function renderCheckoutReviewLine(line: CheckoutReviewLine): React.ReactNode {
  return (
    <li key={line.key}>
      {line.imageUrl === undefined ? null : (
        <img src={line.imageUrl} alt="" width={1448} height={1086} />
      )}
      <div>
        <strong>{line.label}</strong>
        <small>{line.detail}</small>
      </div>
      <span>×{line.quantity}</span>
      <strong>{money(line.total)}</strong>
    </li>
  );
}

type OrderViewCopy = Readonly<{
  paid: string;
  nextAction: string;
  lastUpdated: string;
  progress: string;
  returnUrl: string;
  returnUrlDetail: string;
  copyLink: string;
  refresh: string;
}>;

type OrderStatusPresentation = Readonly<{
  title: string;
  detail: string;
  nextAction: string;
  timeline: readonly BuyerTimelineItem[];
  complete: boolean;
  lastUpdated?: string;
}>;

type OrderHandoff =
  | Readonly<{ kind: "standard" }>
  | Readonly<{
      kind: "pickup_kiosk";
      heading: string;
      detail: string;
      clearLabel: string;
      confirmHeading: string;
      confirmDetail: string;
      confirmClear: string;
      confirmKeep: string;
      onClear: () => void;
    }>;

function OrderView(
  props: Readonly<{
    eyebrow: string;
    title: string;
    detail: string;
    orderCode?: Readonly<{ label: string; value: string }>;
    total: Readonly<{ amountMinor: number; currency: string }>;
    complete: boolean;
    lastUpdated: string;
    nextAction: string;
    timeline: readonly BuyerTimelineItem[];
    paymentReview?: PaymentReviewPresentation;
    facts?: readonly CheckoutFact[];
    receipt?: StoredReceiptV1;
    receiptHeading: string;
    returnUrl: string;
    qrDetail: string;
    feedback: Feedback;
    onRefresh: () => void;
    onCopyLink: () => void;
    copy: OrderViewCopy;
    handoff: OrderHandoff;
  }>,
): React.ReactNode {
  return (
    <div className="checkout-shell">
      <section className="order-card">
        <div
          className={props.complete ? "status-orb complete" : "status-orb"}
          aria-hidden="true"
        >
          <span>{props.complete ? "✓" : "…"}</span>
        </div>
        <p className="eyebrow">{props.eyebrow}</p>
        <h1 tabIndex={-1}>{props.title}</h1>
        <p>{props.detail}</p>
        <section
          aria-atomic="true"
          aria-labelledby={
            props.paymentReview === undefined
              ? undefined
              : "payment-review-status-heading"
          }
          aria-live="polite"
          className="payment-review-status"
          role="status"
        >
          {props.paymentReview === undefined ? null : (
            <>
              <h2 id="payment-review-status-heading">
                {props.paymentReview.title}
              </h2>
              <p>{props.paymentReview.detail}</p>
              <p>{props.paymentReview.nextAction}</p>
            </>
          )}
        </section>
        {props.orderCode === undefined ? null : (
          <div className="order-code">
            <span>{props.orderCode.label}</span>
            <strong>{props.orderCode.value}</strong>
          </div>
        )}
        <p className="order-total">
          {props.copy.paid} {money(props.total)}
        </p>
        <div className="next-action">
          <span>{props.copy.nextAction}</span>
          <strong>{props.nextAction}</strong>
          <small>
            {props.copy.lastUpdated} {props.lastUpdated}
          </small>
        </div>
        <ol className="order-timeline" aria-label={props.copy.progress}>
          {props.timeline.map(renderBuyerTimelineItem)}
        </ol>
        {props.facts === undefined || props.facts.length === 0 ? null : (
          <dl className="checkout-facts order-facts">
            {props.facts.map(renderCheckoutFact)}
          </dl>
        )}
        {props.receipt === undefined ||
        props.receipt.lines.length === 0 ? null : (
          <section className="order-receipt" aria-label={props.receiptHeading}>
            <h2>{props.receiptHeading}</h2>
            <ul className="checkout-review">
              {props.receipt.lines.map(renderReceiptLine)}
            </ul>
          </section>
        )}
        <div className="return-link">
          <span className="return-link-label" id="return-order-url-label">
            {props.copy.returnUrl}
          </span>
          <div className="order-link-share">
            <div
              className="order-qr"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: orderQrSvg(props.returnUrl) }}
            />
            <div className="order-link-copy">
              <p>{props.qrDetail}</p>
              <input
                aria-labelledby="return-order-url-label"
                id="return-order-url"
                readOnly
                value={props.returnUrl}
                onFocus={selectReturnUrl}
              />
              <button
                className="secondary-button order-copy-button"
                type="button"
                onClick={props.onCopyLink}
              >
                {props.copy.copyLink}
              </button>
            </div>
          </div>
          <p>{props.copy.returnUrlDetail}</p>
        </div>
        <KioskHandoffView handoff={props.handoff} />
        {props.complete ? null : (
          <button
            className="secondary-button"
            type="button"
            onClick={props.onRefresh}
          >
            {props.copy.refresh}
          </button>
        )}
        <FeedbackView feedback={props.feedback} />
      </section>
    </div>
  );
}

function renderReceiptLine(
  line: StoredReceiptLineV1,
  index: number,
): React.ReactNode {
  return renderCheckoutReviewLine({
    key: `receipt_${index}`,
    label: line.label,
    detail: line.detail ?? "",
    quantity: line.quantity,
    total: { amountMinor: line.totalMinor, currency: line.currency },
    imageUrl: line.imageUrl,
  });
}

function selectReturnUrl(event: React.FocusEvent<HTMLInputElement>): void {
  event.currentTarget.select();
}

class KioskHandoffView extends React.Component<
  Readonly<{ handoff: OrderHandoff }>,
  Readonly<{ confirming: boolean }>
> {
  state = { confirming: false };

  requestClear = (): void => {
    this.setState({ confirming: true });
  };

  keepOrder = (): void => {
    this.setState({ confirming: false });
  };

  confirmClear = (): void => {
    const handoff = this.props.handoff;
    if (handoff.kind !== "pickup_kiosk") return;
    this.setState({ confirming: false });
    handoff.onClear();
  };

  render(): React.ReactNode {
    const handoff = this.props.handoff;
    switch (handoff.kind) {
      case "standard":
        return null;
      case "pickup_kiosk":
        if (this.state.confirming) {
          return (
            <section className="kiosk-handoff kiosk-handoff-confirming">
              <div>
                <h2>{handoff.confirmHeading}</h2>
                <p>{handoff.confirmDetail}</p>
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={this.confirmClear}
              >
                {handoff.confirmClear}
              </button>
              <button
                className="text-button"
                type="button"
                onClick={this.keepOrder}
              >
                {handoff.confirmKeep}
              </button>
            </section>
          );
        }
        return (
          <section className="kiosk-handoff">
            <div>
              <h2>{handoff.heading}</h2>
              <p>{handoff.detail}</p>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={this.requestClear}
            >
              {handoff.clearLabel}
            </button>
          </section>
        );
      default:
        return assertNever(handoff, "Unhandled storefront state");
    }
  }
}

function StatusView(
  props: Readonly<{
    title: string;
    detail: string;
    busy?: boolean;
    actionLabel?: string;
    onAction?: () => void;
  }>,
): React.ReactNode {
  return (
    <div className="checkout-shell">
      <section className="status-card" aria-busy={props.busy === true}>
        {props.busy === true ? (
          <div className="progress-line" aria-hidden="true" />
        ) : null}
        <h1 tabIndex={-1}>{props.title}</h1>
        <p>{props.detail}</p>
        {props.actionLabel === undefined ||
        props.onAction === undefined ? null : (
          <button
            className="primary-button"
            type="button"
            onClick={props.onAction}
          >
            {props.actionLabel}
          </button>
        )}
      </section>
    </div>
  );
}

function EmptyCatalog(
  props: Readonly<{
    message: string;
    actionLabel?: string;
    onAction?: () => void;
  }>,
): React.ReactNode {
  return (
    <section className="empty-card">
      <h2>Today’s selection is unavailable</h2>
      <p>{props.message} Try again when the café has replenished stock.</p>
      {props.actionLabel === undefined ||
      props.onAction === undefined ? null : (
        <button
          className="secondary-button"
          type="button"
          onClick={props.onAction}
        >
          {props.actionLabel}
        </button>
      )}
    </section>
  );
}

function FeedbackView(
  props: Readonly<{ feedback: Feedback }>,
): React.ReactNode {
  switch (props.feedback.kind) {
    case "none":
      return null;
    case "error":
      return (
        <p className="error-message" role="alert">
          {props.feedback.message}
        </p>
      );
    case "notice":
      return (
        <p className="notice-message" role="status">
          {props.feedback.message}
        </p>
      );
    default:
      return assertNever(props.feedback, "Unhandled storefront state");
  }
}

function renderBuyerTimelineItem(item: BuyerTimelineItem): React.ReactNode {
  return (
    <li
      className={`timeline-${item.state}`}
      key={item.label}
      aria-current={item.state === "current" ? "step" : undefined}
    >
      <span aria-hidden="true">{item.state === "complete" ? "✓" : ""}</span>
      <strong>{item.label}</strong>
    </li>
  );
}

function cafeSelection(
  catalog: CommerceBuyerCatalogV1,
  config: CafeConfiguration,
): CafeSelectionResult {
  if (config.storefrontId !== catalog.storefront.storefrontId) {
    return {
      ok: false,
      message: "The café catalog belongs to another storefront.",
    };
  }
  const products: CafeProductSelection[] = [];
  if (config.presentation === "menu") {
    products.push(...publishedMenuProducts(catalog));
  } else {
    for (const productConfig of CAFE_PRODUCT_CONFIGURATIONS) {
      const product = cafeProductSelection(catalog, productConfig);
      if (product !== undefined) products.push(product);
    }
  }
  const first = products[0];
  if (first === undefined)
    return { ok: false, message: "The café menu is not serving now. Check the shop’s hours and try again." };
  return { ok: true, value: { products: [first, ...products.slice(1)] } };
}

type PublishedMenuSection = Readonly<{
  anchor: string;
  name: string;
  products: readonly CafeProductSelection[];
}>;

/**
 * The sections of the published menus in their order, each with its items.
 * An item whose section the menu does not list goes under `fallbackName`.
 */
function publishedMenuSections(
  selection: CafeSelection,
  fallbackName: string,
): readonly PublishedMenuSection[] {
  const sections: PublishedMenuSection[] = [];
  const placed = new Set<CafeProductSelection>();
  const menus = [...new Set(selection.products.map((product) => product.menu))];
  for (const menu of menus) {
    const ordered = [...menu.sections].sort((a, b) => a.position - b.position);
    for (const section of ordered) {
      const products = selection.products.filter(
        (product) =>
          product.menu === menu &&
          product.entry.sectionId === section.sectionId,
      );
      if (products.length === 0) continue;
      for (const product of products) placed.add(product);
      sections.push({
        anchor: `menu-section-${sections.length + 1}`,
        name: section.name,
        products,
      });
    }
  }
  const unplaced = selection.products.filter((product) => !placed.has(product));
  if (unplaced.length > 0)
    sections.push({
      anchor: `menu-section-${sections.length + 1}`,
      name: fallbackName,
      products: unplaced,
    });
  return sections;
}

/**
 * Every item of a shop's published menus, in menu order. An item shows its
 * listing's title, description and first image.
 */
function publishedMenuProducts(
  catalog: CommerceBuyerCatalogV1,
): readonly CafeProductSelection[] {
  const products: CafeProductSelection[] = [];
  const seen = new Set<string>();
  for (const menu of catalog.menus) {
    for (const entry of menu.entries) {
      if (seen.has(entry.menuEntryId)) continue;
      const listing = uniqueListing(catalog.listings, entry.variantId);
      if (listing === undefined) continue;
      seen.add(entry.menuEntryId);
      products.push({
        config: publishedMenuConfiguration(entry, listing),
        menu,
        entry,
        listing,
      });
    }
  }
  return products;
}

function publishedMenuConfiguration(
  entry: Readonly<{ menuEntryId: string }>,
  listing: CommerceBuyerCatalogListingV1,
): CafeProductConfiguration {
  const image = listing.media.find((item) => item.kind === "image");
  return {
    menuEntryId: entry.menuEntryId,
    category: "bake",
    flavor: "menu",
    imageUrl: image?.url,
    imageAlt: image?.altText ?? "",
    preparation: "unstated",
    copy: {
      title: listing.title,
      description: listing.description,
      allergens: "",
    },
  };
}

function cafeProductSelection(
  catalog: CommerceBuyerCatalogV1,
  config: CafeProductConfiguration,
): CafeProductSelection | undefined {
  let matchedMenu: CommerceBuyerMenuV1 | undefined;
  let matchedEntry: CommerceBuyerMenuEntryV1 | undefined;
  // A menu published from the Portal names its own entries, so an entry
  // also matches by the variant of the café product it sells.
  const variantId = config.menuEntryId.replace(/^menu_entry_/u, "variant_");
  for (const menu of catalog.menus) {
    for (const entry of menu.entries) {
      if (
        entry.menuEntryId !== config.menuEntryId &&
        entry.variantId !== variantId
      )
        continue;
      if (matchedEntry !== undefined) return undefined;
      matchedMenu = menu;
      matchedEntry = entry;
    }
  }
  if (matchedMenu === undefined || matchedEntry === undefined) return undefined;
  const listing = uniqueListing(catalog.listings, matchedEntry.variantId);
  return listing === undefined
    ? undefined
    : { config, menu: matchedMenu, entry: matchedEntry, listing };
}

function shippingSelection(
  catalog: CommerceBuyerCatalogV1,
  basket: ShippingBasket,
): ShippingSelectionResult {
  if (catalog.listings.length === 0)
    return { ok: false, message: "No gift boxes are published right now." };
  if (basket.items.length === 0)
    return { ok: false, message: "Choose at least one gift box." };
  const listings: CommerceBuyerCatalogListingV1[] = [];
  for (const item of basket.items) {
    if (
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 12
    ) {
      return {
        ok: false,
        message: "Choose between 1 and 12 boxes of each selected style.",
      };
    }
    if (listings.some(hasListingVariantId.bind(undefined, item.variantId))) {
      return { ok: false, message: "Choose each gift box style once." };
    }
    const listing = uniqueListing(catalog.listings, item.variantId);
    if (listing === undefined)
      return {
        ok: false,
        message: "That gift box is no longer listed. Choose another gift box.",
      };
    if (listing.availability !== "available") {
      return {
        ok: false,
        message: `${listing.title} is sold out right now. Choose another gift box.`,
      };
    }
    listings.push(listing);
  }
  const first = listings[0];
  if (first === undefined)
    return { ok: false, message: "Choose at least one gift box." };
  return { ok: true, value: [first, ...listings.slice(1)] };
}

function hasListingVariantId(
  variantId: string,
  listing: CommerceBuyerCatalogListingV1,
): boolean {
  return listing.variantId === variantId;
}

function shippingBasketItem(
  basket: ShippingBasket,
  variantId: string,
): ShippingBasketItem | undefined {
  return basket.items.find(
    hasShippingBasketItemVariantId.bind(undefined, variantId),
  );
}

function hasShippingBasketItemVariantId(
  variantId: string,
  item: ShippingBasketItem,
): boolean {
  return item.variantId === variantId;
}

function shippingBasketWithQuantity(
  basket: ShippingBasket,
  variantId: string,
  quantity: number,
): ShippingBasket {
  const nextQuantity = quantity <= 0 ? 0 : boundedPositiveQuantity(quantity);
  const items: ShippingBasketItem[] = [];
  let found = false;
  for (const item of basket.items) {
    if (item.variantId !== variantId) {
      items.push(item);
      continue;
    }
    found = true;
    if (nextQuantity > 0) items.push({ variantId, quantity: nextQuantity });
  }
  if (!found && nextQuantity > 0)
    items.push({ variantId, quantity: nextQuantity });
  return { ...basket, items };
}

function shippingBasketCartLines(
  basket: ShippingBasket,
): readonly CommerceBuyerCartLineV1[] {
  return basket.items.map(shippingBasketCartLine);
}

function shippingBasketCartLine(
  item: ShippingBasketItem,
): CommerceBuyerCartLineV1 {
  return {
    kind: "catalog",
    variantId: item.variantId,
    quantity: item.quantity,
  };
}

function shippingBasketCheckoutLines(
  basket: ShippingBasket,
): readonly CommerceBuyerShippingCheckoutLineV1[] {
  return basket.items.map(shippingBasketCheckoutLine);
}

function shippingBasketCheckoutLine(
  item: ShippingBasketItem,
): CommerceBuyerShippingCheckoutLineV1 {
  return { variantId: item.variantId, quantity: item.quantity };
}

function shippingBasketSubtotal(
  listings: readonly CommerceBuyerCatalogListingV1[],
  basket: ShippingBasket,
): Readonly<{ amountMinor: number; currency: string }> {
  const first = listings[0];
  if (first === undefined) return { amountMinor: 0, currency: "JPY" };
  let amountMinor = 0;
  for (const listing of listings) {
    const item = shippingBasketItem(basket, listing.variantId);
    if (item !== undefined)
      amountMinor += listing.price.amountMinor * item.quantity;
  }
  return { amountMinor, currency: first.price.currency };
}

function shippingOrderLines(
  listings: readonly CommerceBuyerCatalogListingV1[],
  basket: ShippingBasket,
): readonly React.ReactNode[] {
  const lines: React.ReactNode[] = [];
  for (const listing of listings)
    lines.push(shippingOrderLine(listing, basket));
  return lines;
}

function shippingOrderLine(
  listing: CommerceBuyerCatalogListingV1,
  basket: ShippingBasket,
): React.ReactNode {
  const item = shippingBasketItem(basket, listing.variantId);
  if (item === undefined) return null;
  return (
    <div className="shipping-order-line" key={listing.variantId}>
      <img
        src={shippingListingImage(listing).imageUrl}
        alt=""
        width={1448}
        height={1086}
      />
      <div>
        <strong>{listing.title}</strong>
        <small>
          {item.quantity} × {money(listing.price)}
        </small>
      </div>
      <strong>{money(shippingLineSubtotal(listing, item.quantity))}</strong>
    </div>
  );
}

function shippingOrderSummaryLines(
  listings: readonly CommerceBuyerCatalogListingV1[],
  basket: ShippingBasket,
): readonly React.ReactNode[] {
  const lines: React.ReactNode[] = [];
  for (const listing of listings) {
    const item = shippingBasketItem(basket, listing.variantId);
    if (item === undefined) continue;
    lines.push(
      <li key={listing.variantId}>
        {item.quantity} × {listing.title}
      </li>,
    );
  }
  return lines;
}

function shippingServiceSelection(
  catalog: CommerceBuyerCatalogV1,
  basket: ShippingBasket,
):
  | Readonly<{ ok: true; value: CommerceBuyerShippingServiceV1 }>
  | Readonly<{ ok: false; message: string }> {
  if (catalog.storefront.fulfillment !== "shipping") {
    return {
      ok: false,
      message: "This storefront does not publish delivery services.",
    };
  }
  if (basket.shippingServiceCode === undefined) {
    return shippingServicesForCountry(catalog, basket.address.countryCode)
      .length === 0
      ? {
          ok: false,
          message: shippingCountryCopy(basket.address.countryCode).noServices,
        }
      : {
          ok: false,
          message: "Delivery is temporarily unavailable. Try again later.",
        };
  }
  const service = uniqueShippingService(
    catalog,
    basket.address.countryCode,
    basket.shippingServiceCode,
  );
  return service === undefined
    ? {
        ok: false,
        message:
          "That delivery service is no longer available. Select another service.",
      }
    : { ok: true, value: service };
}

function shippingServicesForCountry(
  catalog: CommerceBuyerCatalogV1,
  destinationCountry: ShippingCountryCode,
): readonly CommerceBuyerShippingServiceV1[] {
  return catalog.storefront.fulfillment === "shipping"
    ? catalog.storefront.shippingServices.filter(
        (service) => service.destinationCountry === destinationCountry,
      )
    : [];
}

function uniqueShippingService(
  catalog: CommerceBuyerCatalogV1,
  destinationCountry: ShippingCountryCode,
  serviceCode: string,
): CommerceBuyerShippingServiceV1 | undefined {
  const matches = shippingServicesForCountry(
    catalog,
    destinationCountry,
  ).filter(
    (service) =>
      service.service.code === serviceCode &&
      isAvailableShippingService(service),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function isAvailableShippingService(
  service: CommerceBuyerShippingServiceV1,
): boolean {
  return service.availability.state === "available";
}

// The merchant's first uploaded image, else the built-in picture for the SKU.
function shippingListingImage(
  listing: CommerceBuyerCatalogListingV1 | undefined,
): ShippingListingImage {
  const media = listing?.media.find((item) => item.kind === "image");
  if (media !== undefined) return { imageUrl: media.url, imageAlt: media.altText };
  return (
    (listing === undefined ? undefined : SHIPPING_LISTING_IMAGES[listing.sku]) ??
    DEFAULT_SHIPPING_LISTING_IMAGE
  );
}

function shippingListingCount(count: number): string {
  return `${count} gift ${count === 1 ? "box" : "boxes"}`;
}

function shippingLineSubtotal(
  listing: CommerceBuyerCatalogListingV1,
  quantity: number,
): Readonly<{ amountMinor: number; currency: string }> {
  return {
    amountMinor: listing.price.amountMinor * quantity,
    currency: listing.price.currency,
  };
}

function uniqueListing(
  listings: readonly CommerceBuyerCatalogListingV1[],
  variantId: string,
): CommerceBuyerCatalogListingV1 | undefined {
  const matches = listings.filter((listing) => listing.variantId === variantId);
  return matches.length === 1 ? matches[0] : undefined;
}

function initialBasket(
  config: StorefrontConfiguration,
  catalog: CommerceBuyerCatalogV1,
): BuyerBasket {
  return config.kind === "cafe"
    ? initialCafeBasket()
    : initialShippingBasket(catalog);
}

function initialCafeBasket(): CafeBasket {
  return { kind: "cafe", buyerContact: emptyBuyerContact(), items: [] };
}

function initialShippingBasket(
  catalog: CommerceBuyerCatalogV1,
): ShippingBasket {
  const countryCode: ShippingCountryCode = "SG";
  return {
    kind: "shipping",
    buyerContact: emptyBuyerContact(),
    items: initialShippingItems(catalog),
    shippingServiceCode: resolvedShippingServiceCode(
      catalog,
      countryCode,
      undefined,
    ),
    address: initialShippingAddress(countryCode),
  };
}

function initialShippingItems(
  catalog: CommerceBuyerCatalogV1,
): readonly ShippingBasketItem[] {
  const listing = catalog.listings.find(isAvailableShippingListing);
  return listing === undefined
    ? []
    : [{ variantId: listing.variantId, quantity: 1 }];
}

function resolvedShippingServiceCode(
  catalog: CommerceBuyerCatalogV1,
  destinationCountry: ShippingCountryCode,
  serviceCode: string | undefined,
): string | undefined {
  if (
    serviceCode !== undefined &&
    uniqueShippingService(catalog, destinationCountry, serviceCode) !==
      undefined
  ) {
    return serviceCode;
  }
  return shippingServicesForCountry(catalog, destinationCountry).find(
    isAvailableShippingService,
  )?.service.code;
}

function emptyBuyerContact(): BuyerContactDraft {
  return { email: "", phone: "" };
}

function isAvailableShippingListing(
  listing: CommerceBuyerCatalogListingV1,
): boolean {
  return listing.availability === "available";
}

function boundedQuantity(value: number): number {
  return Number.isInteger(value) ? Math.max(0, Math.min(12, value)) : 0;
}

function boundedPositiveQuantity(value: number): number {
  return Number.isInteger(value) ? Math.max(1, Math.min(12, value)) : 1;
}

function cafeBasketHasItems(basket: CafeBasket): boolean {
  return basket.items.length > 0;
}

function cafeBasketItemCount(basket: CafeBasket): number {
  return basket.items.reduce(sumCafeBasketQuantity, 0);
}

function sumCafeBasketQuantity(total: number, item: CafeBasketItem): number {
  return total + item.quantity;
}

function cafeBasketQuantity(basket: CafeBasket, menuEntryId: string): number {
  return (
    basket.items.find(hasCafeBasketItemId.bind(undefined, menuEntryId))
      ?.quantity ?? 0
  );
}

function cafeBasketModifiers(
  basket: CafeBasket,
  menuEntryId: string,
): readonly string[] {
  return (
    basket.items.find(hasCafeBasketItemId.bind(undefined, menuEntryId))
      ?.modifierOptionIds ?? []
  );
}

function hasCafeBasketItemId(
  menuEntryId: string,
  item: CafeBasketItem,
): boolean {
  return item.menuEntryId === menuEntryId;
}

function withCafeQuantity(
  basket: CafeBasket,
  menuEntryId: string,
  quantity: number,
): CafeBasket {
  const existing = basket.items.find(
    hasCafeBasketItemId.bind(undefined, menuEntryId),
  );
  const remaining = basket.items.filter(
    notCafeBasketItemId.bind(undefined, menuEntryId),
  );
  if (quantity === 0) return { ...basket, items: remaining };
  const item: CafeBasketItem = {
    menuEntryId,
    quantity,
    modifierOptionIds: existing?.modifierOptionIds ?? [],
  };
  return { ...basket, items: [...remaining, item] };
}

function notCafeBasketItemId(
  menuEntryId: string,
  item: CafeBasketItem,
): boolean {
  return item.menuEntryId !== menuEntryId;
}

function withCafeModifier(
  basket: CafeBasket,
  menuEntryId: string,
  modifierOptionId: string,
): CafeBasket {
  const existing = basket.items.find(
    hasCafeBasketItemId.bind(undefined, menuEntryId),
  );
  if (existing === undefined) {
    const added: CafeBasketItem = {
      menuEntryId,
      quantity: 1,
      modifierOptionIds: [modifierOptionId],
    };
    return { ...basket, items: [...basket.items, added] };
  }
  const modifierOptionIds = existing.modifierOptionIds.includes(
    modifierOptionId,
  )
    ? []
    : [modifierOptionId];
  const next: CafeBasketItem = { ...existing, modifierOptionIds };
  return {
    ...basket,
    items: basket.items.map(replaceCafeBasketItem.bind(undefined, next)),
  };
}

function replaceCafeBasketItem(
  next: CafeBasketItem,
  item: CafeBasketItem,
): CafeBasketItem {
  return item.menuEntryId === next.menuEntryId ? next : item;
}

function cafeBasketTotal(
  basket: CafeBasket,
  selection: CafeSelection,
): Readonly<{ amountMinor: number; currency: string }> {
  let amountMinor = 0;
  for (const item of basket.items) {
    const product = selection.products.find(
      hasCafeProductSelectionId.bind(undefined, item.menuEntryId),
    );
    if (product !== undefined)
      amountMinor += cafeLineTotal(item, product).amountMinor;
  }
  return {
    amountMinor,
    currency: selection.products[0].entry.price.currency,
  };
}

function cafeLineTotal(
  item: CafeBasketItem,
  product: CafeProductSelection,
): Readonly<{ amountMinor: number; currency: string }> {
  let modifierAmount = 0;
  for (const group of product.entry.modifierGroups) {
    for (const option of group.options) {
      if (item.modifierOptionIds.includes(option.modifierOptionId))
        modifierAmount += option.priceDelta.amountMinor;
    }
  }
  return {
    amountMinor:
      (product.entry.price.amountMinor + modifierAmount) * item.quantity,
    currency: product.entry.price.currency,
  };
}

function hasCafeProductSelectionId(
  menuEntryId: string,
  product: CafeProductSelection,
): boolean {
  return product.config.menuEntryId === menuEntryId;
}

function cafeCheckoutLines(
  basket: CafeBasket,
  selection: CafeSelection,
): readonly CommerceBuyerPickupCheckoutLineV1[] {
  const lines: CommerceBuyerPickupCheckoutLineV1[] = [];
  for (const item of basket.items) {
    const product = selection.products.find(
      hasCafeProductSelectionId.bind(undefined, item.menuEntryId),
    );
    if (product === undefined) continue;
    lines.push({
      kind: "menu",
      menuId: product.menu.menuId,
      menuEntryId: product.entry.menuEntryId,
      quantity: item.quantity,
      modifierOptionIds: item.modifierOptionIds,
    });
  }
  return lines;
}

function cafeCheckoutReviewLines(
  quote: CommerceBuyerQuotedCheckoutV1,
  catalog: CommerceBuyerCatalogV1,
  config: StorefrontConfiguration,
  copy: CafeInterfaceCopy,
  language: CafeLanguage,
): readonly CheckoutReviewLine[] {
  return quote.quote.lines.map((line) => {
    switch (line.kind) {
      case "catalog":
        return {
          key: `catalog:${line.variantId}`,
          label: language === "ja" ? "カフェ商品" : "Café item",
          detail: copy.readyNow,
          quantity: line.quantity,
          total: line.lineTotal,
        };
      case "menu": {
        const item = menuLineItem(line, catalog, config, language);
        return {
          key: `menu:${line.menuId}:${line.menuEntryId}`,
          label: item.title,
          detail: cafeReviewLineDetail(
            line.modifierOptionIds,
            item.preparation,
            copy,
            language,
          ),
          quantity: line.quantity,
          total: line.lineTotal,
          imageUrl: item.imageUrl,
        };
      }
      case "order_balance":
        return {
          key: `order_balance:${line.orderId}`,
          label: language === "ja" ? "ご注文の差額" : "Order balance",
          detail: "",
          quantity: line.quantity,
          total: line.lineTotal,
        };
      default:
        return assertNever(line, "Unhandled storefront state");
    }
  });
}

function cafeReviewLineDetail(
  modifierOptionIds: readonly string[],
  preparation: CafeProductConfiguration["preparation"],
  copy: CafeInterfaceCopy,
  language: CafeLanguage,
): string {
  const names = modifierOptionIds
    .map((modifierOptionId) => cafeModifierName(language, modifierOptionId, ""))
    .filter(hasText);
  return [names.join(", "), cafeProductPreparation(copy, preparation).label]
    .filter(hasText)
    .join(" · ");
}

/**
 * What a quote's menu line shows. On a shop's order page it is the item's
 * listing; the demo shops show their own products' copy and art.
 */
function menuLineItem(
  line: Readonly<{ menuEntryId: string; variantId: string }>,
  catalog: CommerceBuyerCatalogV1,
  config: StorefrontConfiguration,
  language: CafeLanguage,
): Readonly<{
  title: string;
  imageUrl: string | undefined;
  preparation: CafeProductConfiguration["preparation"];
}> {
  const menuEntryId =
    config.kind === "cafe" && config.presentation === "menu"
      ? undefined
      : cafeProductIdOfLine(line);
  const demo =
    menuEntryId === undefined
      ? undefined
      : cafeProductConfiguration(menuEntryId);
  if (menuEntryId !== undefined && demo !== undefined)
    return {
      title: cafeProductCopy(language, menuEntryId).title,
      imageUrl: demo.imageUrl,
      preparation: demo.preparation,
    };
  const listing = uniqueListing(catalog.listings, line.variantId);
  if (listing !== undefined) {
    const item = publishedMenuConfiguration(
      { menuEntryId: line.menuEntryId },
      listing,
    );
    return {
      title: listing.title,
      imageUrl: item.imageUrl,
      preparation: item.preparation,
    };
  }
  return {
    title: language === "ja" ? "メニュー商品" : "Menu item",
    imageUrl: undefined,
    preparation: "made_to_order",
  };
}

function cafeProductConfiguration(
  menuEntryId: CafeProductId,
): CafeProductConfiguration | undefined {
  return CAFE_PRODUCT_CONFIGURATIONS.find(
    hasCafeProductConfigurationId.bind(undefined, menuEntryId),
  );
}

function cafeBasketLines(
  basket: CafeBasket,
  selection: CafeSelection,
  language: CafeLanguage,
  interfaceCopy: CafeInterfaceCopy,
  onDecrease: React.MouseEventHandler<HTMLButtonElement>,
  onIncrease: React.MouseEventHandler<HTMLButtonElement>,
): readonly React.ReactNode[] {
  const lines: React.ReactNode[] = [];
  for (const product of selection.products) {
    const item = basket.items.find(
      hasCafeBasketItemId.bind(undefined, product.config.menuEntryId),
    );
    if (item === undefined) continue;
    const copy = cafeItemCopy(language, product.config);
    lines.push(
      <CafeBasketLine
        key={product.config.menuEntryId}
        itemKey={product.config.menuEntryId}
        imageUrl={product.config.imageUrl}
        label={copy.title}
        quantity={item.quantity}
        detail={cafeBasketItemDetail(item, product, language)}
        total={cafeLineTotal(item, product)}
        addVisibleLabel={interfaceCopy.addAction}
        addLabel={`${interfaceCopy.addOne} ${copy.title}`}
        removeLabel={`${interfaceCopy.removeOne} ${copy.title}`}
        selectedLabel={interfaceCopy.selected}
        maximum={product.entry.availability === "available" ? 12 : 0}
        onDecrease={onDecrease}
        onIncrease={onIncrease}
      />,
    );
  }
  return lines;
}

function cafeBasketItemDetail(
  item: CafeBasketItem,
  product: CafeProductSelection,
  language: CafeLanguage,
): string | undefined {
  if (product.entry.modifierGroups.length === 0) return undefined;
  // The demo's one modifier is oat milk, so no choice means dairy milk.
  if (item.modifierOptionIds.length === 0)
    return product.config.flavor === "menu"
      ? undefined
      : cafeInterfaceCopy(language).dairyMilk;
  const names: string[] = [];
  for (const group of product.entry.modifierGroups) {
    for (const option of group.options) {
      if (item.modifierOptionIds.includes(option.modifierOptionId)) {
        names.push(
          cafeModifierName(language, option.modifierOptionId, option.name),
        );
      }
    }
  }
  return names.join(", ");
}

/** A shop's own item has its listing's copy; a demo product has its own. */
function cafeItemCopy(
  language: CafeLanguage,
  config: CafeProductConfiguration,
): CafeProductCopy {
  if (config.copy !== undefined) return config.copy;
  const menuEntryId = parseCafeProductId(config.menuEntryId);
  if (menuEntryId === undefined) throw new Error("Unknown café item");
  return cafeProductCopy(language, menuEntryId);
}

function cafeProductCopy(
  language: CafeLanguage,
  menuEntryId: CafeProductId,
): CafeProductCopy {
  if (isPatisserieProductId(menuEntryId)) {
    const product = patisserieProduct(menuEntryId);
    if (product === undefined) throw new Error("Unknown pâtisserie item");
    return product.copy[language];
  }
  return CAFE_PRODUCT_COPY[language][menuEntryId];
}

function isPatisserieProductId(
  menuEntryId: CafeProductId,
): menuEntryId is PatisserieProductId {
  return menuEntryId.startsWith("menu_entry_patisserie_");
}

function cafeProductPreparation(
  copy: CafeInterfaceCopy,
  preparation: CafeProductConfiguration["preparation"],
): Readonly<{ label: string; timing: string }> {
  switch (preparation) {
    case "made_to_order":
      return { label: copy.madeToOrder, timing: copy.readyInMinutes };
    case "baked_today":
      return { label: copy.bakedToday, timing: copy.readyNow };
    case "unstated":
      return { label: "", timing: "" };
    default:
      return assertNever(preparation, "Unhandled storefront state");
  }
}

function cafeMenuItemCount(copy: CafeInterfaceCopy, count: number): string {
  return copy.htmlLanguage === "ja"
    ? `${count}商品`
    : `${count} menu ${count === 1 ? "item" : "items"}`;
}

function cafeCategoryItemCount(
  copy: CafeInterfaceCopy,
  products: readonly CafeProductSelection[],
  category: CafeProductConfiguration["category"],
): string {
  let count = 0;
  for (const product of products)
    if (product.config.category === category) count += 1;
  return cafeMenuItemCount(copy, count);
}

function cafeModifierName(
  language: CafeLanguage,
  modifierOptionId: string,
  fallback: string,
): string {
  return modifierOptionId === "modifier_option_oat_milk"
    ? cafeInterfaceCopy(language).oatMilk
    : fallback;
}

function parseCafeProductId(
  value: string | undefined,
): CafeProductId | undefined {
  if (value === undefined) return undefined;
  return CAFE_PRODUCT_CONFIGURATIONS.find(
    hasCafeProductConfigurationId.bind(undefined, value),
  )?.menuEntryId;
}

/**
 * The café product of a menu line. A menu published from the Portal names its
 * own entries, so the line also matches by the variant that it sells.
 */
function cafeProductIdOfLine(
  line: Readonly<{ menuEntryId: string; variantId: string }>,
): CafeProductId | undefined {
  return (
    parseCafeProductId(line.menuEntryId) ??
    parseCafeProductId(line.variantId.replace(/^variant_/u, "menu_entry_"))
  );
}

function hasCafeProductConfigurationId(
  value: string,
  config: CafeProductConfiguration,
): boolean {
  return config.menuEntryId === value;
}

function shippingCheckoutReviewLines(
  quote: CommerceBuyerQuotedShippingCheckoutV1,
  listings: readonly CommerceBuyerCatalogListingV1[],
): readonly CheckoutReviewLine[] {
  const lines: CheckoutReviewLine[] = [];
  let lineNumber = 0;
  for (const line of quote.quote.lines) {
    lineNumber += 1;
    const listing = uniqueListing(listings, line.variantId);
    lines.push({
      key: `catalog:${line.variantId}:${lineNumber}`,
      label: listing?.title ?? "Cookie gift box",
      detail: listing?.description ?? "Baked in Japan",
      quantity: line.quantity,
      total: line.lineTotal,
      imageUrl: shippingListingImage(listing).imageUrl,
    });
  }
  return lines;
}

function cafeCheckoutCopy(
  copy: CafeInterfaceCopy,
  total: Readonly<{ amountMinor: number; currency: string }>,
): CheckoutViewCopy {
  return {
    items: copy.items,
    shipping: "Shipping",
    duty: "Duty",
    tax: copy.tax,
    taxIncluded: copy.taxIncluded,
    total: copy.total,
    expired: copy.quoteExpired,
    refresh: copy.refreshQuote,
    pay: `${copy.pay} · ${money(total)}`,
    edit: copy.editOrder,
    paymentNote: copy.paymentNote,
  };
}

function shippingCheckoutCopy(
  total: Readonly<{ amountMinor: number; currency: string }>,
): CheckoutViewCopy {
  return {
    items: "Items",
    shipping: "Shipping",
    duty: "Duty",
    tax: "Tax",
    taxIncluded: "Includes tax",
    total: "Total",
    expired:
      "This quote expired. Refresh it to confirm current stock, shipping, duty, and tax.",
    refresh: "Refresh quote",
    pay: `Pay securely · ${money(total)}`,
    edit: "Edit basket and address",
    paymentNote:
      "Payment details are collected securely by the payment provider selected by this store.",
  };
}

function cafeOrderViewCopy(copy: CafeInterfaceCopy): OrderViewCopy {
  return {
    paid: copy.paid,
    nextAction: copy.nextAction,
    lastUpdated: copy.lastUpdated,
    progress: copy.orderProgress,
    returnUrl: copy.returnUrl,
    returnUrlDetail: copy.returnUrlDetail,
    copyLink: copy.copyLink,
    refresh: copy.refreshStatus,
  };
}

function shippingOrderViewCopy(): OrderViewCopy {
  return {
    paid: "Paid",
    nextAction: "Next action",
    lastUpdated: "Last updated",
    progress: "Order progress",
    returnUrl: "Private order link",
    returnUrlDetail:
      "Save this link to check the order from this device or another one.",
    copyLink: "Copy order link",
    refresh: "Refresh status",
  };
}

type ShippingCountryCopy = Readonly<{
  name: string;
  heroDetail: string;
  deliveryHeading: string;
  deliveryDetail: string;
  destinationDetail: string;
  noServices: string;
  correctionDetail: string;
  localityLabel: string;
  areaLabel: string;
  postalLabel: string;
  postalInputMode: "numeric" | undefined;
  /** An HTML pattern; absent where postal codes have letters. */
  postalPattern: string | undefined;
  postalHint: string;
  quoteEyebrow: string;
  quoteTitle: string;
  quoteDetail: string;
  orderEyebrow: string;
}>;

const SHIPPING_COUNTRY_COPY: Readonly<
  Record<"JP" | "SG", ShippingCountryCopy>
> = {
  JP: {
    name: "Japan",
    heroDetail:
      "Our neko cookies are baked in Japan and packed for delivery within Japan.",
    deliveryHeading: "Delivery to Japan",
    deliveryDetail: "Enter the address to calculate a domestic carrier quote.",
    destinationDetail: "Delivery quotes are calculated for Japan addresses.",
    noServices:
      "No delivery services are published for Japan. Check again later.",
    correctionDetail:
      "The address provider found a formatting correction for Japan. Review both versions before continuing.",
    localityLabel: "City or ward",
    areaLabel: "Prefecture",
    postalLabel: "Postal code",
    postalInputMode: "numeric",
    postalPattern: "[0-9]{3}-?[0-9]{4}",
    postalHint: "Use a seven-digit Japanese postal code.",
    quoteEyebrow: "Domestic delivery quote",
    quoteTitle: "Ready to send within Japan",
    quoteDetail: "tracked delivery within Japan from Tokyo.",
    orderEyebrow: "Japan domestic delivery",
  },
  SG: {
    name: "Singapore",
    heroDetail:
      "Our neko cookies are baked in Japan and packed for international delivery to Singapore.",
    deliveryHeading: "Delivery to Singapore",
    deliveryDetail:
      "Enter the address to calculate an international carrier quote.",
    destinationDetail:
      "Delivery quotes are calculated for Singapore addresses.",
    noServices:
      "No delivery services are published for Singapore. Check again later.",
    correctionDetail:
      "The address provider found a formatting correction for Singapore. Review both versions before continuing.",
    localityLabel: "City",
    areaLabel: "Region",
    postalLabel: "Postal code",
    postalInputMode: "numeric",
    postalPattern: "[0-9]{6}",
    postalHint: "Use a six-digit Singapore postal code.",
    quoteEyebrow: "International delivery quote",
    quoteTitle: "Ready to send to Singapore",
    quoteDetail: "tracked delivery from Tokyo.",
    orderEyebrow: "Japan to Singapore",
  },
};

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

/** Copy for a destination of a general international route. */
function internationalCountryCopy(
  countryCode: CommerceInternationalShippingCountry,
): ShippingCountryCopy {
  const name = REGION_NAMES.of(countryCode) ?? countryCode;
  const unitedStates = countryCode === "US";
  const australia = countryCode === "AU";
  return {
    name,
    heroDetail: `Our neko cookies are baked in Japan and packed for international delivery to ${name}.`,
    deliveryHeading: `Delivery to ${name}`,
    deliveryDetail:
      "Enter the address to calculate an international carrier quote.",
    destinationDetail: `Delivery quotes are calculated for ${name} addresses.`,
    noServices: `No delivery services are published for ${name}. Check again later.`,
    correctionDetail: `The address provider found a formatting correction for ${name}. Review both versions before continuing.`,
    localityLabel: australia ? "Suburb or city" : "City",
    areaLabel: "State",
    postalLabel: unitedStates
      ? "ZIP code"
      : australia
        ? "Postcode"
        : "Postal code",
    postalInputMode: unitedStates || australia ? "numeric" : undefined,
    postalPattern: unitedStates
      ? "[0-9]{5}(-[0-9]{4})?"
      : australia
        ? "[0-9]{4}"
        : undefined,
    postalHint: unitedStates
      ? "Use a five-digit ZIP code."
      : australia
        ? "Use a four-digit postcode."
        : `Use the postal code of ${name}.`,
    quoteEyebrow: "International delivery quote",
    quoteTitle: `Ready to send to ${name}`,
    quoteDetail: "tracked delivery from Tokyo.",
    orderEyebrow: `Japan to ${name}`,
  };
}

function shippingCountryCopy(
  countryCode: ShippingCountryCode,
): ShippingCountryCopy {
  return countryCode === "JP" || countryCode === "SG"
    ? SHIPPING_COUNTRY_COPY[countryCode]
    : internationalCountryCopy(countryCode);
}

function parseShippingCountry(value: string): ShippingCountryCode | undefined {
  return value === "JP" ||
    value === "SG" ||
    isCommerceInternationalShippingCountry(value)
    ? value
    : undefined;
}

/**
 * The delivery countries to offer: Japan and Singapore first, then every
 * country with a published service, by name, and the current choice.
 */
function shippingCountryOptions(
  catalog: CommerceBuyerCatalogV1,
  current: ShippingCountryCode,
): readonly ShippingCountryCode[] {
  const published = new Set<ShippingCountryCode>([current]);
  if (catalog.storefront.fulfillment === "shipping")
    for (const service of catalog.storefront.shippingServices) {
      const country = parseShippingCountry(service.destinationCountry);
      if (country !== undefined) published.add(country);
    }
  const others = [...published]
    .filter((country) => country !== "JP" && country !== "SG")
    .sort((left, right) =>
      shippingCountryCopy(left).name.localeCompare(
        shippingCountryCopy(right).name,
      ),
    );
  return ["JP", "SG", ...others];
}

function initialShippingAddress(
  countryCode: ShippingCountryCode,
): ShippingAddressDraft {
  switch (countryCode) {
    case "JP":
      return {
        countryCode,
        recipientName: "",
        addressLine1: "",
        locality: "",
        administrativeArea: "",
        postalCode: "",
      };
    case "SG":
      return {
        countryCode,
        recipientName: "",
        addressLine1: "",
        locality: "Singapore",
        postalCode: "",
      };
    default:
      return {
        countryCode,
        recipientName: "",
        addressLine1: "",
        locality: "",
        ...(commerceAddressNeedsState(countryCode)
          ? { administrativeArea: "" }
          : {}),
        postalCode: "",
      };
  }
}

function shippingAddressWithField(
  address: ShippingAddressDraft,
  field: ShippingAddressField,
  value: string,
): ShippingAddressDraft | undefined {
  switch (address.countryCode) {
    case "JP":
      switch (field) {
        case "recipientName":
          return { ...address, recipientName: value };
        case "addressLine1":
          return { ...address, addressLine1: value };
        case "locality":
          return { ...address, locality: value };
        case "administrativeArea":
          return { ...address, administrativeArea: value };
        case "postalCode":
          return { ...address, postalCode: value };
        default:
          return assertNever(field, "Unhandled storefront state");
      }
    case "SG":
      switch (field) {
        case "recipientName":
          return { ...address, recipientName: value };
        case "addressLine1":
          return { ...address, addressLine1: value };
        case "postalCode":
          return { ...address, postalCode: value };
        case "locality":
        case "administrativeArea":
          return undefined;
        default:
          return assertNever(field, "Unhandled storefront state");
      }
    default:
      switch (field) {
        case "recipientName":
          return { ...address, recipientName: value };
        case "addressLine1":
          return { ...address, addressLine1: value };
        case "locality":
          return { ...address, locality: value };
        case "administrativeArea":
          return commerceAddressNeedsState(address.countryCode)
            ? { ...address, administrativeArea: value }
            : undefined;
        case "postalCode":
          return { ...address, postalCode: value };
        default:
          return assertNever(field, "Unhandled storefront state");
      }
  }
}

function normalizedShippingAddress(
  address: ShippingAddressDraft,
): CommerceBuyerShippingAddressV1 {
  switch (address.countryCode) {
    case "JP":
      return {
        countryCode: "JP",
        recipientName: address.recipientName.trim(),
        addressLine1: address.addressLine1.trim(),
        locality: address.locality.trim(),
        administrativeArea: address.administrativeArea.trim(),
        postalCode: normalizedJapanesePostalCode(address.postalCode),
      };
    case "SG":
      return {
        countryCode: "SG",
        recipientName: address.recipientName.trim(),
        addressLine1: address.addressLine1.trim(),
        locality: "Singapore",
        postalCode: address.postalCode.trim(),
      };
    default:
      return {
        countryCode: address.countryCode,
        recipientName: address.recipientName.trim(),
        addressLine1: address.addressLine1.trim(),
        locality: address.locality.trim(),
        ...(address.administrativeArea === undefined
          ? {}
          : {
              administrativeArea: address.administrativeArea
                .trim()
                .toUpperCase(),
            }),
        postalCode: address.postalCode.trim().toUpperCase(),
      };
  }
}

function normalizedJapanesePostalCode(value: string): string {
  const digits = value.trim().replace("-", "");
  return /^\d{7}$/u.test(digits)
    ? `${digits.slice(0, 3)}-${digits.slice(3)}`
    : value.trim();
}

function shippingAddressForCountry(
  address: CommerceBuyerShippingAddressV1,
  countryCode: ShippingCountryCode,
): ShippingAddressDraft | undefined {
  switch (countryCode) {
    case "JP":
      return address.countryCode === "JP" ? address : undefined;
    case "SG":
      return address.countryCode === "SG" ? address : undefined;
    default:
      return address.countryCode === countryCode ? address : undefined;
  }
}

function shippingAddressSummary(address: ShippingAddressDraft): string {
  switch (address.countryCode) {
    case "JP":
      return `${address.recipientName}, ${address.addressLine1}, ${address.locality}, ${address.administrativeArea} ${address.postalCode}`;
    case "SG":
      return `${address.recipientName}, ${address.addressLine1}, ${address.locality} ${address.postalCode}`;
    default:
      return [
        address.recipientName,
        address.addressLine1,
        address.locality,
        [address.administrativeArea, address.postalCode]
          .filter(hasText)
          .join(" "),
      ].join(", ");
  }
}

export function normalizedBuyerContact(
  contact: BuyerContactDraft,
  policy: BuyerContactPolicy,
): CommerceBuyerContactV1 {
  const email = contact.email.trim();
  const phone = contact.phone.trim();
  switch (policy) {
    case "email_required":
    case "email_required_phone_optional":
      return policy === "email_required" || phone.length === 0
        ? { kind: "email", email }
        : { kind: "email_and_phone", email, phone };
    case "email_and_phone_required":
      return { kind: "email_and_phone", email, phone };
    default:
      return assertNever(policy, "Unhandled storefront state");
  }
}

function contactFieldError(
  submitted: boolean,
  field: keyof BuyerContactDraft,
  value: string,
  policy: BuyerContactPolicy,
): string | undefined {
  if (!submitted) return undefined;
  const normalized = value.trim();
  if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    return "Enter an email address.";
  }
  if (field === "phone") {
    if (policy === "email_and_phone_required" && normalized.length === 0)
      return "Enter a phone number.";
    if (normalized.length > 0 && !/^\+[1-9]\d{7,14}$/u.test(normalized)) {
      return "Use international format, such as +819012345678.";
    }
  }
  return undefined;
}

type ShippingAddressField =
  | "recipientName"
  | "addressLine1"
  | "locality"
  | "administrativeArea"
  | "postalCode";

function shippingFieldError(
  submitted: boolean,
  field: ShippingAddressField,
  address: ShippingAddressDraft,
): string | undefined {
  if (!submitted) return undefined;
  if (field === "recipientName" && address.recipientName.trim().length === 0)
    return "Enter a recipient name.";
  if (field === "addressLine1" && address.addressLine1.trim().length === 0)
    return "Enter a street address.";
  switch (address.countryCode) {
    case "JP":
      if (field === "locality" && address.locality.trim().length === 0)
        return "Enter a city or ward.";
      if (
        field === "administrativeArea" &&
        address.administrativeArea.trim().length === 0
      )
        return "Enter a prefecture.";
      if (
        field === "postalCode" &&
        !/^\d{3}-?\d{4}$/u.test(address.postalCode.trim())
      )
        return "Enter a seven-digit Japanese postal code.";
      return undefined;
    case "SG":
      if (field === "postalCode" && !/^\d{6}$/u.test(address.postalCode.trim()))
        return "Enter a six-digit Singapore postal code.";
      return undefined;
    default:
      if (field === "locality" && address.locality.trim().length === 0)
        return "Enter a city.";
      if (
        field === "administrativeArea" &&
        commerceAddressNeedsState(address.countryCode) &&
        (address.administrativeArea ?? "").trim().length === 0
      )
        return "Enter a state.";
      if (
        field === "postalCode" &&
        !isCommercePostalCode(address.countryCode, address.postalCode)
      )
        return shippingCountryCopy(address.countryCode).postalHint;
      return undefined;
  }
}

function focusFirstInvalidField(form: HTMLFormElement): void {
  form.querySelector<HTMLInputElement>(":invalid")?.focus();
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function quoteHasExpired(
  quote:
    CommerceBuyerQuotedCheckoutV1 | CommerceBuyerQuotedShippingCheckoutV1,
): boolean {
  return Date.parse(quote.quote.expiresAt) <= Date.now();
}

function newRunId(): string {
  return `storefront_${crypto.randomUUID()}`;
}

function createOrderAccess(
  checkoutId: string,
  token: string,
): BuyerOrderAccess {
  const fragment = new URLSearchParams({ order: checkoutId, access: token });
  const returnUrl = `${window.location.origin}${window.location.pathname}#${fragment.toString()}`;
  return { checkoutId, token, returnUrl };
}

type StorefrontLocation = Readonly<{
  hash: string;
  origin: string;
  pathname: string;
}>;

function recoveryFromLocation(
  location: StorefrontLocation,
): BuyerOrderAccess | undefined {
  const fragment = new URLSearchParams(
    location.hash.startsWith("#") ? location.hash.slice(1) : location.hash,
  );
  const checkoutId = normalizedText(fragment.get("order"));
  const token = normalizedText(fragment.get("access"));
  return checkoutId === undefined || token === undefined
    ? undefined
    : {
        checkoutId,
        token,
        returnUrl: `${location.origin}${location.pathname}#${fragment.toString()}`,
      };
}

function locationHasOrderAccessIntent(
  location: Readonly<{ hash: string }>,
): boolean {
  const fragment = new URLSearchParams(
    location.hash.startsWith("#") ? location.hash.slice(1) : location.hash,
  );
  return fragment.has("order") || fragment.has("access");
}

function normalizedText(value: string | null): string | undefined {
  return value === null || value.length === 0 || value !== value.trim()
    ? undefined
    : value;
}

function orderStatusStorageKey(storefrontId: string): string {
  return `satyr.order-status.${storefrontId}`;
}

const ORDER_QR_SVG_CACHE = new Map<string, string>();

function orderQrSvg(url: string): string {
  const cached = ORDER_QR_SVG_CACHE.get(url);
  if (cached !== undefined) return cached;
  const qr = qrcode(0, "L");
  qr.addData(url);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  ORDER_QR_SVG_CACHE.set(url, svg);
  return svg;
}

type StoredReceiptLineV1 = Readonly<{
  label: string;
  detail?: string;
  quantity: number;
  totalMinor: number;
  currency: string;
  imageUrl?: string;
}>;

type StoredReceiptV1 = Readonly<{
  version: 1;
  checkoutId: string;
  fulfillment: "pickup" | "shipping";
  savedAt: string;
  lines: readonly StoredReceiptLineV1[];
}>;

const RECEIPT_STORAGE_PREFIX = "satyr.order-receipt.";
const RECEIPT_STORAGE_LIMIT = 12;

function receiptStorageKey(checkoutId: string): string {
  return `${RECEIPT_STORAGE_PREFIX}${checkoutId}`;
}

function saveOrderReceipt(receipt: StoredReceiptV1): void {
  try {
    pruneOrderReceipts();
    window.localStorage.setItem(
      receiptStorageKey(receipt.checkoutId),
      JSON.stringify(receipt),
    );
  } catch {
    // The order page degrades to totals-only when storage is unavailable.
  }
}

function readOrderReceipt(checkoutId: string): StoredReceiptV1 | undefined {
  try {
    const raw = window.localStorage.getItem(receiptStorageKey(checkoutId));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const receipt = parsed as StoredReceiptV1;
    if (
      receipt.version !== 1 ||
      receipt.checkoutId !== checkoutId ||
      !Array.isArray(receipt.lines)
    )
      return undefined;
    return receipt;
  } catch {
    return undefined;
  }
}

function pruneOrderReceipts(): void {
  const stored: Array<{ key: string; savedAt: string }> = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key === null || !key.startsWith(RECEIPT_STORAGE_PREFIX)) continue;
    try {
      const parsed: unknown = JSON.parse(
        window.localStorage.getItem(key) ?? "",
      );
      const savedAt =
        typeof parsed === "object" &&
        parsed !== null &&
        "savedAt" in parsed &&
        typeof parsed.savedAt === "string"
          ? parsed.savedAt
          : "";
      stored.push({ key, savedAt });
    } catch {
      stored.push({ key, savedAt: "" });
    }
  }
  if (stored.length < RECEIPT_STORAGE_LIMIT) return;
  stored.sort(compareBySavedAt);
  for (const entry of stored.slice(
    0,
    stored.length - RECEIPT_STORAGE_LIMIT + 1,
  )) {
    window.localStorage.removeItem(entry.key);
  }
}

function compareBySavedAt(
  a: Readonly<{ savedAt: string }>,
  b: Readonly<{ savedAt: string }>,
): number {
  return a.savedAt < b.savedAt ? -1 : a.savedAt > b.savedAt ? 1 : 0;
}

function pickupReceipt(
  quote: CommerceBuyerQuotedCheckoutV1,
  context: BuyerContext,
  config: StorefrontConfiguration,
  language: CafeLanguage,
): StoredReceiptV1 {
  const copy = cafeInterfaceCopy(language);
  const lines = quote.quote.lines.map((line): StoredReceiptLineV1 => {
    if (line.kind === "menu") {
      const item = menuLineItem(line, context.catalog, config, language);
      return {
        label: item.title,
        detail: cafeReviewLineDetail(
          line.modifierOptionIds,
          item.preparation,
          copy,
          language,
        ),
        quantity: line.quantity,
        totalMinor: line.lineTotal.amountMinor,
        currency: line.lineTotal.currency,
        imageUrl: item.imageUrl,
      };
    }
    return {
      label: language === "ja" ? "カフェ商品" : "Café item",
      quantity: line.quantity,
      totalMinor: line.lineTotal.amountMinor,
      currency: line.lineTotal.currency,
    };
  });
  return {
    version: 1,
    checkoutId: quote.checkoutId,
    fulfillment: "pickup",
    savedAt: new Date().toISOString(),
    lines,
  };
}

function shippingReceipt(
  quote: CommerceBuyerQuotedShippingCheckoutV1,
  context: BuyerContext,
): StoredReceiptV1 {
  const lines: StoredReceiptLineV1[] = [];
  for (const line of quote.quote.lines) {
    const listing = uniqueListing(context.catalog.listings, line.variantId);
    lines.push({
      label: listing?.title ?? "Cookie gift box",
      detail: listing?.description,
      quantity: line.quantity,
      totalMinor: line.lineTotal.amountMinor,
      currency: line.lineTotal.currency,
      imageUrl: shippingListingImage(listing).imageUrl,
    });
  }
  return {
    version: 1,
    checkoutId: quote.checkoutId,
    fulfillment: "shipping",
    savedAt: new Date().toISOString(),
    lines,
  };
}

function activeCartForSession(
  cart: CommerceBuyerCartV1,
  session: CommerceBuyerSessionV4,
  fulfillment: "pickup" | "shipping",
  expectedCartId: string | undefined,
  minimumRevision: number,
): ActiveBuyerCart | undefined {
  if (
    cart.state !== "active" ||
    cart.fulfillment !== fulfillment ||
    cart.revision < minimumRevision ||
    (expectedCartId !== undefined && cart.cartId !== expectedCartId) ||
    cart.checkoutProfile.checkoutProfileId !==
      session.checkoutProfile.checkoutProfileId ||
    cart.checkoutProfile.revision !== session.checkoutProfile.revision
  ) {
    return undefined;
  }
  return cart;
}

function submittedCartForSession(
  cart: CommerceBuyerCartV1,
  session: CommerceBuyerSessionV4,
  fulfillment: "pickup" | "shipping",
  expectedCartId: string,
  minimumRevision: number,
): Variant<BuyerCartState, "submitted"> | undefined {
  if (
    cart.state !== "submitted" ||
    cart.fulfillment !== fulfillment ||
    cart.cartId !== expectedCartId ||
    cart.revision < minimumRevision ||
    cart.checkoutProfile.checkoutProfileId !==
      session.checkoutProfile.checkoutProfileId ||
    cart.checkoutProfile.revision !== session.checkoutProfile.revision
  ) {
    return undefined;
  }
  return {
    kind: "submitted",
    cartId: cart.cartId,
    revision: cart.revision,
    checkoutId: cart.checkoutId,
  };
}

function contextWithSubmittedCart(
  context: BuyerContext,
  cart: ActiveBuyerCart,
  checkoutId: string,
): BuyerContext {
  return {
    ...context,
    cart: {
      kind: "submitted",
      cartId: cart.cartId,
      revision: cart.revision + 1,
      checkoutId,
    },
  };
}

function sameBuyerCartLines(
  left: readonly CommerceBuyerCartLineV1[],
  right: readonly CommerceBuyerCartLineV1[],
): boolean {
  if (left.length !== right.length) return false;
  for (const [index, leftLine] of left.entries()) {
    const rightLine = right[index];
    if (
      rightLine === undefined ||
      leftLine.kind !== rightLine.kind ||
      leftLine.quantity !== rightLine.quantity
    )
      return false;
    if (leftLine.kind === "catalog") {
      if (
        rightLine.kind !== "catalog" ||
        leftLine.variantId !== rightLine.variantId
      )
        return false;
      continue;
    }
    if (
      rightLine.kind !== "menu" ||
      leftLine.menuId !== rightLine.menuId ||
      leftLine.menuEntryId !== rightLine.menuEntryId ||
      !sameStrings(leftLine.modifierOptionIds, rightLine.modifierOptionIds)
    )
      return false;
  }
  return true;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (const [index, value] of left.entries()) {
    if (right[index] !== value) return false;
  }
  return true;
}

function isUnavailableBuyerSession(error: CommerceClientError): boolean {
  return error.kind === "http" && error.status === 401;
}

function isMissingBuyerCart(error: CommerceClientError): boolean {
  return error.kind === "http" && error.status === 404;
}

function isMissingBuyerCheckout(error: CommerceClientError): boolean {
  return error.kind === "http" && error.status === 404;
}

type StoredCafeBasket = Readonly<{
  kind: "cafe";
  buyerContact: BuyerContactDraft;
  items: readonly Readonly<{
    menuEntryId: string;
    quantity: number;
    modifierOptionIds: readonly string[];
  }>[];
}>;

type StoredShippingBasket = Readonly<{
  kind: "shipping";
  buyerContact: BuyerContactDraft;
  items: readonly Readonly<{ variantId: string; quantity: number }>[];
  shippingServiceCode: string | undefined;
  address: ShippingAddressDraft;
}>;

function checkoutStorageKey(storefrontId: string): string {
  return `satyr.checkout.${storefrontId}`;
}

function saveStoredCheckoutContext(
  config: StorefrontConfiguration,
  context: BuyerContext,
): void {
  try {
    window.sessionStorage.setItem(
      checkoutStorageKey(config.storefrontId),
      JSON.stringify({
        schemaVersion: "satyr.storefront-checkout-session.v7",
        merchantId: config.merchantId,
        storefrontId: config.storefrontId,
        session: context.session,
        operationId: context.runId,
        cart: storedCartReference(context.cart),
        basket: storedBasket(context.basket),
      }),
    );
  } catch {
    // The in-memory checkout keeps working when storage is unavailable.
  }
}

function storedCartReference(cart: BuyerCartState): StoredCartReference {
  switch (cart.kind) {
    case "absent":
      return { kind: "absent" };
    case "active":
      return {
        kind: "active",
        cartId: cart.cart.cartId,
        revision: cart.cart.revision,
      };
    case "submitted":
      return {
        kind: "submitted",
        cartId: cart.cartId,
        revision: cart.revision,
        checkoutId: cart.checkoutId,
      };
    default:
      return assertNever(cart, "Unhandled storefront state");
  }
}

function storedBasket(
  basket: BuyerBasket,
): StoredCafeBasket | StoredShippingBasket {
  if (basket.kind === "cafe") {
    return {
      kind: "cafe",
      buyerContact: basket.buyerContact,
      items: basket.items,
    };
  }
  return {
    kind: "shipping",
    buyerContact: basket.buyerContact,
    items: basket.items,
    shippingServiceCode: basket.shippingServiceCode,
    address: basket.address,
  };
}

function clearStoredCheckoutContext(storefrontId: string): void {
  try {
    window.sessionStorage.removeItem(checkoutStorageKey(storefrontId));
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

function readStoredCheckoutRecovery(
  config: StorefrontConfiguration,
): StoredCheckoutRecovery | undefined {
  try {
    const raw = window.sessionStorage.getItem(
      checkoutStorageKey(config.storefrontId),
    );
    if (raw === null) return undefined;
    const parsed = parseStoredCheckoutRecovery(JSON.parse(raw), config);
    if (parsed !== undefined) return parsed;
    clearStoredCheckoutContext(config.storefrontId);
    return undefined;
  } catch {
    clearStoredCheckoutContext(config.storefrontId);
    return undefined;
  }
}

export function parseStoredCheckoutRecovery(
  value: unknown,
  config: StorefrontConfiguration,
): StoredCheckoutRecovery | undefined {
  if (
    !isRecord(value) ||
    !hasExactFields(value, [
      "schemaVersion",
      "merchantId",
      "storefrontId",
      "session",
      "operationId",
      "cart",
      "basket",
    ]) ||
    value.schemaVersion !== "satyr.storefront-checkout-session.v7" ||
    value.merchantId !== config.merchantId ||
    value.storefrontId !== config.storefrontId
  ) {
    return undefined;
  }
  let session: CommerceBuyerSessionV4;
  try {
    session = parseCommerceBuyerSessionV4(value.session);
  } catch {
    return undefined;
  }
  if (Date.parse(session.expiresAt) <= Date.now()) return undefined;
  const operationId =
    typeof value.operationId === "string"
      ? normalizedText(value.operationId)
      : undefined;
  if (operationId === undefined) return undefined;
  const cart = parseStoredCartReference(value.cart);
  if (cart === undefined) return undefined;
  return { session, operationId, cart, basket: value.basket };
}

function parseStoredCartReference(
  value: unknown,
): StoredCartReference | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "absent") {
    return hasExactFields(value, ["kind"]) ? { kind: "absent" } : undefined;
  }
  if (
    typeof value.cartId !== "string" ||
    value.cartId.length === 0 ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    return undefined;
  if (
    value.kind === "active" &&
    hasExactFields(value, ["kind", "cartId", "revision"])
  ) {
    return { kind: "active", cartId: value.cartId, revision: value.revision };
  }
  if (
    value.kind === "submitted" &&
    hasExactFields(value, ["kind", "cartId", "revision", "checkoutId"]) &&
    typeof value.checkoutId === "string" &&
    value.checkoutId.length > 0
  ) {
    return {
      kind: "submitted",
      cartId: value.cartId,
      revision: value.revision,
      checkoutId: value.checkoutId,
    };
  }
  return undefined;
}

function restoredBasket(
  config: StorefrontConfiguration,
  catalog: CommerceBuyerCatalogV1,
  stored: unknown,
  contactPolicy: BuyerContactPolicy,
): BuyerBasket {
  const fallback = initialBasket(config, catalog);
  if (config.kind === "cafe")
    return (
      restoredCafeBasket(stored, catalog, config, contactPolicy) ?? fallback
    );
  return restoredShippingBasket(stored, catalog, contactPolicy) ?? fallback;
}

function restoredCafeBasket(
  stored: unknown,
  catalog: CommerceBuyerCatalogV1,
  config: CafeConfiguration,
  contactPolicy: BuyerContactPolicy,
): CafeBasket | undefined {
  if (
    !isRecord(stored) ||
    !hasExactFields(stored, ["kind", "buyerContact", "items"]) ||
    stored.kind !== "cafe" ||
    !Array.isArray(stored.items)
  )
    return undefined;
  const buyerContact = restoredBuyerContact(stored.buyerContact, contactPolicy);
  if (buyerContact === undefined) return undefined;
  const selection = cafeSelection(catalog, config);
  if (!selection.ok) return undefined;
  const items: CafeBasketItem[] = [];
  for (const item of stored.items) {
    if (
      !isRecord(item) ||
      !hasExactFields(item, ["menuEntryId", "quantity", "modifierOptionIds"])
    )
      continue;
    const menuEntryId =
      typeof item.menuEntryId === "string" ? item.menuEntryId : undefined;
    if (menuEntryId === undefined) continue;
    const product = selection.value.products.find(
      hasCafeProductSelectionId.bind(undefined, menuEntryId),
    );
    if (product === undefined || product.entry.availability !== "available")
      continue;
    const quantity = boundedQuantity(
      typeof item.quantity === "number" ? item.quantity : 0,
    );
    if (quantity === 0) continue;
    const knownOptionIds = product.entry.modifierGroups.flatMap(
      modifierGroupOptionIds,
    );
    const modifierOptionIds = Array.isArray(item.modifierOptionIds)
      ? item.modifierOptionIds.filter(
          (optionId: unknown): optionId is string =>
            typeof optionId === "string" && knownOptionIds.includes(optionId),
        )
      : [];
    if (items.some(hasCafeBasketItemId.bind(undefined, menuEntryId))) continue;
    items.push({ menuEntryId, quantity, modifierOptionIds });
  }
  return { kind: "cafe", buyerContact, items };
}

function modifierGroupOptionIds(
  group: CommerceBuyerModifierGroupV1,
): readonly string[] {
  return group.options.map(readModifierOptionId);
}

function readModifierOptionId(
  option: Readonly<{ modifierOptionId: string }>,
): string {
  return option.modifierOptionId;
}

function restoredShippingBasket(
  stored: unknown,
  catalog: CommerceBuyerCatalogV1,
  contactPolicy: BuyerContactPolicy,
): ShippingBasket | undefined {
  if (
    !isRecord(stored) ||
    stored.kind !== "shipping" ||
    !hasExactFields(stored, [
      "kind",
      "buyerContact",
      "items",
      "shippingServiceCode",
      "address",
    ])
  )
    return undefined;
  const address = restoredShippingAddress(stored.address);
  const buyerContact = restoredBuyerContact(stored.buyerContact, contactPolicy);
  const items = restoredShippingItems(stored.items, catalog);
  if (
    address === undefined ||
    buyerContact === undefined ||
    items === undefined
  )
    return undefined;
  const shippingServiceCode = resolvedShippingServiceCode(
    catalog,
    address.countryCode,
    typeof stored.shippingServiceCode === "string"
      ? stored.shippingServiceCode
      : undefined,
  );
  if (
    shippingServiceCode === undefined ||
    shippingServiceCode !== stored.shippingServiceCode
  ) {
    return undefined;
  }
  return {
    kind: "shipping",
    buyerContact,
    items,
    shippingServiceCode,
    address,
  };
}

function restoredShippingAddress(
  value: unknown,
): ShippingAddressDraft | undefined {
  if (!isRecord(value) || typeof value.countryCode !== "string")
    return undefined;
  const countryCode = parseShippingCountry(value.countryCode);
  if (countryCode === undefined) return undefined;
  switch (countryCode) {
    case "JP":
      if (
        !hasExactFields(value, [
          "countryCode",
          "recipientName",
          "addressLine1",
          "locality",
          "administrativeArea",
          "postalCode",
        ]) ||
        typeof value.recipientName !== "string" ||
        typeof value.addressLine1 !== "string" ||
        typeof value.locality !== "string" ||
        typeof value.administrativeArea !== "string" ||
        typeof value.postalCode !== "string"
      )
        return undefined;
      return {
        countryCode,
        recipientName: value.recipientName,
        addressLine1: value.addressLine1,
        locality: value.locality,
        administrativeArea: value.administrativeArea,
        postalCode: value.postalCode,
      };
    case "SG":
      if (
        !hasExactFields(value, [
          "countryCode",
          "recipientName",
          "addressLine1",
          "locality",
          "postalCode",
        ]) ||
        typeof value.recipientName !== "string" ||
        typeof value.addressLine1 !== "string" ||
        value.locality !== "Singapore" ||
        typeof value.postalCode !== "string"
      )
        return undefined;
      return {
        countryCode,
        recipientName: value.recipientName,
        addressLine1: value.addressLine1,
        locality: "Singapore",
        postalCode: value.postalCode,
      };
  }
}

function restoredShippingItems(
  value: unknown,
  catalog: CommerceBuyerCatalogV1,
): readonly ShippingBasketItem[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const items: ShippingBasketItem[] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasExactFields(item, ["variantId", "quantity"]))
      return undefined;
    const variantId =
      typeof item.variantId === "string" && item.variantId.length > 0
        ? item.variantId
        : undefined;
    const quantity =
      typeof item.quantity === "number" &&
      Number.isSafeInteger(item.quantity) &&
      item.quantity >= 1 &&
      item.quantity <= 12
        ? item.quantity
        : undefined;
    if (variantId === undefined || quantity === undefined) {
      return undefined;
    }
    if (items.some(hasShippingBasketItemVariantId.bind(undefined, variantId)))
      return undefined;
    const listing = uniqueListing(catalog.listings, variantId);
    if (listing === undefined || listing.availability !== "available")
      return undefined;
    items.push({ variantId, quantity });
  }
  return items;
}

function restoredBuyerContact(
  value: unknown,
  policy: BuyerContactPolicy,
): BuyerContactDraft | undefined {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["email", "phone"]) ||
    typeof value.email !== "string" ||
    typeof value.phone !== "string"
  ) {
    return undefined;
  }
  return {
    email: value.email,
    phone: policy === "email_required" ? "" : value.phone,
  };
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every(recordHasKey.bind(undefined, keys))
  );
}

function recordHasKey(keys: readonly string[], field: string): boolean {
  return keys.includes(field);
}

function kioskStorageKey(storefrontId: string): string {
  return `satyr.kiosk.${storefrontId}`;
}

function readKioskMode(storefrontId: string, location: Location): boolean {
  const requested = new URLSearchParams(location.search).get("kiosk");
  try {
    if (requested === "1") {
      window.localStorage.setItem(kioskStorageKey(storefrontId), "1");
      return true;
    }
    if (requested === "0") {
      window.localStorage.removeItem(kioskStorageKey(storefrontId));
      return false;
    }
    return window.localStorage.getItem(kioskStorageKey(storefrontId)) === "1";
  } catch {
    return requested === "1";
  }
}

function cafeInterfaceCopy(language: CafeLanguage): CafeInterfaceCopy {
  return CAFE_INTERFACE_COPY[language];
}

function parseCafeLanguage(value: string | null): CafeLanguage | undefined {
  if (value === "en" || value === "ja") return value;
  return undefined;
}

function readCafeLanguage(): CafeLanguage {
  try {
    return (
      parseCafeLanguage(
        window.localStorage.getItem(CAFE_LANGUAGE_STORAGE_KEY),
      ) ?? "en"
    );
  } catch {
    return "en";
  }
}

function saveCafeLanguage(language: CafeLanguage): void {
  try {
    window.localStorage.setItem(CAFE_LANGUAGE_STORAGE_KEY, language);
  } catch {
    // The selected language remains active until the page is reloaded.
  }
}

function saveOrderStatusUrl(storefrontId: string, returnUrl: string): void {
  try {
    window.localStorage.setItem(orderStatusStorageKey(storefrontId), returnUrl);
  } catch {
    // The return URL remains usable when browser storage is unavailable.
  }
}

function readOrderStatusUrl(storefrontId: string): string | undefined {
  try {
    const stored = normalizedText(
      window.localStorage.getItem(orderStatusStorageKey(storefrontId)),
    );
    if (stored === undefined) return undefined;
    const url = new URL(stored);
    const access = recoveryFromLocation(url);
    if (
      url.origin === window.location.origin &&
      url.pathname === window.location.pathname &&
      access !== undefined
    ) {
      return access.returnUrl;
    }
    clearOrderStatusUrl(storefrontId);
    return undefined;
  } catch {
    clearOrderStatusUrl(storefrontId);
    return undefined;
  }
}

function clearOrderStatusUrl(storefrontId: string): void {
  try {
    window.localStorage.removeItem(orderStatusStorageKey(storefrontId));
  } catch {
    // The URL fragment is still cleared when browser storage is unavailable.
  }
}

function configurationFulfillment(
  config: StorefrontConfiguration,
): BuyerFulfillment {
  switch (config.kind) {
    case "cafe":
      return "pickup";
    case "shipping":
      return "shipping";
  }
}

export function profileAllowsFulfillment(
  session: CommerceBuyerSessionV4,
  fulfillment: BuyerFulfillment,
): boolean {
  switch (session.checkoutProfileConfiguration.fulfillmentPolicy.kind) {
    case "pickup_only":
      return fulfillment === "pickup";
    case "shipping_only":
      return fulfillment === "shipping";
    case "buyer_choice":
      return true;
    default:
      return assertNever(
        session.checkoutProfileConfiguration.fulfillmentPolicy,
        "Unhandled storefront state",
      );
  }
}

function buyerContactPolicy(
  session: CommerceBuyerSessionV4,
): BuyerContactPolicy {
  return session.checkoutProfileConfiguration.buyerPolicy.requiredContact;
}

function languageFromLocale(locale: string): CafeLanguage {
  return locale.toLowerCase().startsWith("ja") ? "ja" : "en";
}

function buyerContactPolicyCopy(
  policy: BuyerContactPolicy,
  language: CafeLanguage,
): string {
  if (language === "ja") {
    switch (policy) {
      case "email_required":
        return "メールアドレスは必須です。電話番号は収集しません。";
      case "email_required_phone_optional":
        return "メールアドレスは必須です。電話番号は任意です。";
      case "email_and_phone_required":
        return "メールアドレスと電話番号は必須です。";
      default:
        return assertNever(policy, "Unhandled storefront state");
    }
  }
  switch (policy) {
    case "email_required":
      return "Email is required. Phone is not collected.";
    case "email_required_phone_optional":
      return "Email is required. Phone is optional.";
    case "email_and_phone_required":
      return "Email and phone are required.";
    default:
      return assertNever(policy, "Unhandled storefront state");
  }
}

function buyerPhoneIsVisible(policy: BuyerContactPolicy): boolean {
  return policy !== "email_required";
}

function buyerPhoneIsRequired(policy: BuyerContactPolicy): boolean {
  return policy === "email_and_phone_required";
}

type FailureViewCopy = Readonly<{ title: string; action: string }>;

function failureViewCopy(
  kind: StorefrontConfiguration["kind"],
  language: CafeLanguage,
  failure: StorefrontFailure["kind"],
): FailureViewCopy {
  if (kind === "cafe" && language === "ja") {
    return failure === "order_access"
      ? { title: "注文状況を開けませんでした", action: "メニューに戻る" }
      : { title: "ストアを開けませんでした", action: "もう一度試す" };
  }
  return failure === "order_access"
    ? {
        title: "This order status link isn’t available",
        action: "Return to the store",
      }
    : { title: "The storefront didn’t open", action: "Try again" };
}

function invalidOrderAccessMessage(
  kind: StorefrontConfiguration["kind"],
  language: CafeLanguage,
  belongsToAnotherStorefront: boolean,
): string {
  if (kind === "cafe" && language === "ja") {
    return belongsToAnotherStorefront
      ? "この注文は別のストアのものです。"
      : "注文リンクが無効か、有効期限が切れています。";
  }
  return belongsToAnotherStorefront
    ? "This order belongs to another storefront."
    : "This order link is invalid or has expired.";
}

function isTerminalOrderAccessError(error: CommerceClientError): boolean {
  switch (error.kind) {
    case "http":
      return error.status >= 400 && error.status < 500;
    case "rejected":
      return true;
    case "network":
    case "invalid_response":
      return false;
    default:
      return assertNever(error, "Unhandled storefront state");
  }
}

function statePresentsPageHeading(state: StorefrontState): boolean {
  switch (state.kind) {
    case "booting":
    case "quoting":
    case "paying_pickup":
    case "paying_shipping":
      return false;
    case "catalog":
    case "shipping_address_correction":
    case "pickup_quote":
    case "shipping_quote":
    case "payment_pickup":
    case "payment_shipping":
    case "declined":
    case "indeterminate_pickup":
    case "indeterminate_shipping":
    case "pickup_order":
    case "shipping_order":
    case "failed":
      return true;
    default:
      return assertNever(state, "Unhandled storefront state");
  }
}

function focusPageHeading(): void {
  window.requestAnimationFrame(focusRenderedHeading);
}

function scrollToLocationAnchor(): void {
  if (
    window.location.hash.length <= 1 ||
    locationHasOrderAccessIntent(window.location)
  )
    return;
  window.requestAnimationFrame(scrollToRenderedAnchor);
}

function scrollToRenderedAnchor(): void {
  try {
    const id = decodeURIComponent(window.location.hash.slice(1));
    document.getElementById(id)?.scrollIntoView();
  } catch {
    // Ignore malformed non-order fragments and keep the storefront usable.
  }
}

function focusRenderedHeading(): void {
  window.scrollTo(0, 0);
  document
    .querySelector<HTMLElement>("main h1")
    ?.focus({ preventScroll: true });
}

function money(
  value: Readonly<{ amountMinor: number; currency: string }>,
): string {
  const digits = CURRENCY_MINOR_UNITS[value.currency] ?? 2;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value.amountMinor / 10 ** digits);
}

function dateTimeLocale(
  kind: StorefrontConfiguration["kind"],
  language: CafeLanguage,
): string {
  if (kind === "shipping") return "en-SG";
  return language === "ja" ? "ja-JP" : "en-JP";
}

function storefrontTimeZone(kind: StorefrontConfiguration["kind"]): string {
  return kind === "cafe" ? "Asia/Tokyo" : "Asia/Singapore";
}

function formatDate(
  value: string,
  kind: StorefrontConfiguration["kind"],
  language: CafeLanguage = "en",
): string {
  return new Intl.DateTimeFormat(dateTimeLocale(kind, language), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: storefrontTimeZone(kind),
  }).format(new Date(value));
}

function formatTimeOnly(
  value: string,
  kind: StorefrontConfiguration["kind"],
  language: CafeLanguage,
): string {
  return new Intl.DateTimeFormat(dateTimeLocale(kind, language), {
    timeStyle: "short",
    timeZone: storefrontTimeZone(kind),
  }).format(new Date(value));
}

function formatDateRange(
  earliest: string,
  latest: string,
  countryCode: ShippingCountryCode,
): string {
  return new Intl.DateTimeFormat(`en-${countryCode}`, {
    dateStyle: "medium",
    timeZone: destinationTimeZone(countryCode),
  }).formatRange(new Date(earliest), new Date(latest));
}

/** A time zone of the destination, for delivery dates. */
function destinationTimeZone(countryCode: ShippingCountryCode): string {
  switch (countryCode) {
    case "JP":
      return "Asia/Tokyo";
    case "SG":
      return "Asia/Singapore";
    case "AU":
      return "Australia/Sydney";
    case "US":
      return "America/New_York";
    case "IE":
    case "PT":
      return "Europe/Lisbon";
    case "BG":
    case "CY":
    case "EE":
    case "FI":
    case "GR":
    case "LT":
    case "LV":
    case "RO":
      return "Europe/Helsinki";
    default:
      return "Europe/Paris";
  }
}

function calendarDayInTokyo(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(value);
}

function formatPickupMoment(value: string, language: CafeLanguage): string {
  const moment = new Date(value);
  if (calendarDayInTokyo(moment) === calendarDayInTokyo(new Date())) {
    return cafeInterfaceCopy(language).todayAt.replace(
      "{time}",
      formatTimeOnly(value, "cafe", language),
    );
  }
  return formatDate(value, "cafe", language);
}

function cafeOrderTitle(
  state: VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">["state"],
  copy: CafeInterfaceCopy,
): string {
  switch (state) {
    case "placed":
      return copy.preparingOrder;
    case "ready_for_pickup":
      return copy.readyForPickup;
    case "completed":
      return copy.pickedUp;
    case "cancelled":
      return copy.orderCancelled;
  }
}

function pickupOrderDetail(
  order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">,
  language: CafeLanguage,
): string {
  switch (order.state) {
    case "placed":
      return language === "ja"
        ? `${formatPickupMoment(order.pickup.expectedBy, language)}までにご用意します。`
        : `Expected ${formatPickupMoment(order.pickup.expectedBy, language)}.`;
    case "ready_for_pickup":
      return language === "ja"
        ? `${formatPickupMoment(order.readyAt, language)}にご用意できました。この画面をカウンターでお見せください。`
        : `Ready since ${formatPickupMoment(order.readyAt, language)}. Show this page at the counter.`;
    case "completed":
      return language === "ja"
        ? `${formatPickupMoment(order.completedAt, language)}にお受け取りいただきました。ありがとうございます。`
        : `Collected ${formatPickupMoment(order.completedAt, language)}. Thank you.`;
    case "cancelled":
      return cancelledPickupOrderDetail(order, language);
  }
}

function cancelledPickupOrderDetail(
  order: VariantBy<
    VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">,
    "state",
    "cancelled"
  >,
  language: CafeLanguage,
): string {
  const cancelledAt = formatPickupMoment(order.cancelledAt, language);
  switch (order.refund.state) {
    case "pending":
      return language === "ja"
        ? `${cancelledAt}にキャンセルしました。返金を処理しています。`
        : `Cancelled ${cancelledAt}. The refund is processing.`;
    case "refunded":
      return language === "ja"
        ? `${cancelledAt}にキャンセルしました。${money(order.refund.amount)}を返金しました。`
        : `Cancelled ${cancelledAt}. ${money(order.refund.amount)} was refunded.`;
    case "failed":
      return language === "ja"
        ? `${cancelledAt}にキャンセルしました。カフェが返金状況を確認しています。`
        : `Cancelled ${cancelledAt}. The café is reviewing the refund.`;
    default:
      return assertNever(order.refund, "Unhandled storefront state");
  }
}

function shippingOrderTitle(
  state: VariantBy<CommerceBuyerOrderV1, "fulfillment", "shipping">["state"],
  destinationName: string,
): string {
  switch (state) {
    case "ready":
      return "Preparing the shipment";
    case "label_purchased":
      return "Waiting for carrier pickup";
    case "in_transit":
      return `On the way to ${destinationName}`;
    case "delivered":
      return "Delivered";
  }
}

function shippingOrderDetail(
  order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "shipping">,
): string {
  switch (order.state) {
    case "ready":
      return "The cookie box is packed. Carrier booking is next.";
    case "label_purchased":
      return "The shipping label is ready. The carrier collects the package next.";
    case "in_transit":
      return `Handed to the carrier ${formatDate(order.handedOverAt, "shipping")}.`;
    case "delivered":
      return `Delivered ${formatDate(order.deliveredAt, "shipping")}.`;
  }
}

function buyerOrderLastUpdated(
  order: CommerceBuyerOrderV1,
  language: CafeLanguage,
): string {
  switch (order.fulfillment) {
    case "pickup":
      switch (order.state) {
        case "placed":
          return formatPickupMoment(order.placedAt, language);
        case "ready_for_pickup":
          return formatPickupMoment(order.readyAt, language);
        case "completed":
          return formatPickupMoment(order.completedAt, language);
        case "cancelled":
          return formatPickupMoment(order.cancelledAt, language);
      }
    case "shipping":
      switch (order.state) {
        case "ready":
          return formatDate(order.placedAt, "shipping");
        case "label_purchased":
          return formatDate(order.purchasedAt, "shipping");
        case "in_transit":
          return formatDate(order.handedOverAt, "shipping");
        case "delivered":
          return formatDate(order.deliveredAt, "shipping");
      }
  }
}

function shippingOrderNextAction(
  order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "shipping">,
): string {
  switch (order.state) {
    case "ready":
      return "Wait for the merchant to book the carrier.";
    case "label_purchased":
      return "Wait for the carrier to collect the package.";
    case "in_transit":
      return "Follow the tracking number for delivery updates.";
    case "delivered":
      return "No action needed. Delivery is complete.";
  }
}

function pickupOrderNextAction(
  order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">,
  language: CafeLanguage,
): string {
  switch (order.state) {
    case "placed":
      return language === "ja"
        ? "カフェでご注文をお作りしています。そのままお待ちください。"
        : "Wait while the café makes your order.";
    case "ready_for_pickup":
      return language === "ja"
        ? "この画面をカフェのカウンターでお見せください。"
        : "Show this page at the café counter.";
    case "completed":
      return language === "ja"
        ? "お受け取りは完了しました。"
        : "Your pickup is complete.";
    case "cancelled":
      return cancelledPickupOrderNextAction(order, language);
  }
}

function cancelledPickupOrderNextAction(
  order: VariantBy<
    VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">,
    "state",
    "cancelled"
  >,
  language: CafeLanguage,
): string {
  switch (order.refund.state) {
    case "pending":
      return language === "ja"
        ? "返金が完了するまでお待ちください。"
        : "Wait for the refund to complete.";
    case "refunded":
      return language === "ja"
        ? "返金は完了しました。"
        : "The refund is complete. No action is needed.";
    case "failed":
      return language === "ja"
        ? "カフェからの返金に関するご連絡をお待ちください。"
        : "Wait for the café to contact you about the refund.";
    default:
      return assertNever(order.refund, "Unhandled storefront state");
  }
}

function pickupOrderTimeline(
  order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">,
  language: CafeLanguage,
): readonly BuyerTimelineItem[] {
  if (order.state === "cancelled") {
    return timelineItems(
      language === "ja"
        ? ["注文を受け付けました", "キャンセル済み"]
        : ["Order placed", "Cancelled"],
      1,
    );
  }
  const currentIndex =
    order.state === "placed" ? 0 : order.state === "ready_for_pickup" ? 1 : 2;
  const labels =
    language === "ja"
      ? ["注文を受け付けました", "受け取り準備完了", "お受け取り済み"]
      : ["Order placed", "Ready for pickup", "Collected"];
  return timelineItems(labels, currentIndex);
}

type PaymentReviewPresentation = Readonly<{
  title: string;
  detail: string;
  nextAction: string;
  timeline: readonly BuyerTimelineItem[];
  active: boolean;
}>;

type PaymentReviewCopy = Readonly<{
  activeTitle: string;
  activeTitlePlural: string;
  completeTitle: string;
  completeTitlePlural: string;
  activeDetail: string;
  completeDetail: string;
  multipleActiveDetail: string;
  multipleMixedDetail: string;
  multipleCompleteDetail: string;
  activeNextAction: string;
  activeNextActionPlural: string;
  completeNextAction: string;
  completeNextActionPlural: string;
  activeTimeline: string;
  completeTimeline: string;
}>;

const PAYMENT_REVIEW_COPY: Readonly<Record<CafeLanguage, PaymentReviewCopy>> = {
  en: {
    activeTitle: "Payment review in progress",
    activeTitlePlural: "Payment reviews in progress",
    completeTitle: "Payment review complete",
    completeTitlePlural: "Payment reviews complete",
    activeDetail: "Your payment review is in progress.",
    completeDetail: "The payment review is complete.",
    multipleActiveDetail: "{total} payment reviews are in progress.",
    multipleMixedDetail:
      "{total} payment reviews: {active} in progress, {complete} complete.",
    multipleCompleteDetail: "{total} payment reviews are complete.",
    activeNextAction:
      "Keep checking this page while the payment review is in progress.",
    activeNextActionPlural:
      "Keep checking this page while payment reviews are in progress.",
    completeNextAction: "The payment review is complete. No action is needed.",
    completeNextActionPlural:
      "The payment reviews are complete. No action is needed.",
    activeTimeline: "Payment review in progress",
    completeTimeline: "Payment review complete",
  },
  ja: {
    activeTitle: "お支払いを確認しています",
    activeTitlePlural: "お支払いを確認しています",
    completeTitle: "お支払いの確認が完了しました",
    completeTitlePlural: "お支払いの確認が完了しました",
    activeDetail: "お支払いの確認を進めています。",
    completeDetail: "お支払いの確認が完了しました。",
    multipleActiveDetail: "お支払いの確認中のものが{total}件あります。",
    multipleMixedDetail:
      "お支払いの確認は{total}件です。確認中{active}件、完了{complete}件。",
    multipleCompleteDetail: "お支払いの確認は{total}件すべて完了しました。",
    activeNextAction:
      "お支払いの確認が完了するまで、この画面をご確認ください。",
    activeNextActionPlural:
      "お支払いの確認が完了するまで、この画面をご確認ください。",
    completeNextAction:
      "お支払いの確認は完了しています。お手続きはありません。",
    completeNextActionPlural:
      "お支払いの確認は完了しています。お手続きはありません。",
    activeTimeline: "お支払いを確認中",
    completeTimeline: "お支払いの確認完了",
  },
};

type PaymentReviewCounts = Readonly<{
  total: number;
  active: number;
  complete: number;
}>;

function paymentReviewPresentation(
  disputes: readonly CommerceBuyerPaymentDisputeStatusV1[],
  language: CafeLanguage,
): PaymentReviewPresentation | undefined {
  if (disputes.length === 0) return undefined;
  const counts = paymentReviewCounts(disputes);
  const copy = PAYMENT_REVIEW_COPY[language];
  const plural = counts.total > 1;
  const active = counts.active > 0;
  return {
    title: paymentReviewTitle(counts, copy, plural),
    detail: paymentReviewDetail(counts, copy),
    nextAction: paymentReviewNextAction(counts, copy, plural),
    timeline: timelineItems([paymentReviewTimelineLabel(counts, copy)], 0),
    active,
  };
}

function paymentReviewCounts(
  disputes: readonly CommerceBuyerPaymentDisputeStatusV1[],
): PaymentReviewCounts {
  let active = 0;
  let complete = 0;
  for (const dispute of disputes) {
    switch (dispute.state) {
      case "action_required":
      case "under_review":
        active += 1;
        break;
      case "won":
      case "lost":
        complete += 1;
        break;
      default:
        assertNever(dispute, "Unhandled storefront state");
    }
  }
  return { total: disputes.length, active, complete };
}

function paymentReviewTitle(
  counts: PaymentReviewCounts,
  copy: PaymentReviewCopy,
  plural: boolean,
): string {
  if (counts.active > 0)
    return plural ? copy.activeTitlePlural : copy.activeTitle;
  return plural ? copy.completeTitlePlural : copy.completeTitle;
}

function paymentReviewDetail(
  counts: PaymentReviewCounts,
  copy: PaymentReviewCopy,
): string {
  if (counts.total === 1) {
    if (counts.active > 0) return copy.activeDetail;
    return copy.completeDetail;
  }
  if (counts.active === counts.total) {
    return copy.multipleActiveDetail.replace("{total}", String(counts.total));
  }
  if (counts.complete === counts.total) {
    return copy.multipleCompleteDetail.replace("{total}", String(counts.total));
  }
  return copy.multipleMixedDetail
    .replace("{total}", String(counts.total))
    .replace("{active}", String(counts.active))
    .replace("{complete}", String(counts.complete));
}

function paymentReviewNextAction(
  counts: PaymentReviewCounts,
  copy: PaymentReviewCopy,
  plural: boolean,
): string {
  if (counts.active > 0) {
    return plural ? copy.activeNextActionPlural : copy.activeNextAction;
  }
  return plural ? copy.completeNextActionPlural : copy.completeNextAction;
}

function paymentReviewTimelineLabel(
  counts: PaymentReviewCounts,
  copy: PaymentReviewCopy,
): string {
  if (counts.active > 0) return copy.activeTimeline;
  return copy.completeTimeline;
}

function orderTimelineWithPaymentReview(
  base: OrderStatusPresentation,
  paymentReview: PaymentReviewPresentation | undefined,
  language: CafeLanguage,
): readonly BuyerTimelineItem[] {
  if (paymentReview === undefined) return base.timeline;
  const reviewItem = currentTimelineItem(paymentReview.timeline);
  if (reviewItem === undefined) return base.timeline;
  if (!base.complete) {
    if (!paymentReview.active) return base.timeline;
    return (
      combineActivePaymentReviewTimeline(base.timeline, reviewItem, language) ??
      base.timeline
    );
  }
  const timeline = completeTimelineItems(base.timeline);
  timeline.push({
    label: reviewItem.label,
    state: "current",
  });
  return timeline;
}

function currentTimelineItem(
  timeline: readonly BuyerTimelineItem[],
): BuyerTimelineItem | undefined {
  for (const item of timeline) if (item.state === "current") return item;
  return undefined;
}

function combineActivePaymentReviewTimeline(
  timeline: readonly BuyerTimelineItem[],
  reviewItem: BuyerTimelineItem,
  language: CafeLanguage,
): readonly BuyerTimelineItem[] | undefined {
  const combined: BuyerTimelineItem[] = [];
  let foundCurrent = false;
  for (const item of timeline) {
    if (item.state !== "current") {
      combined.push(item);
      continue;
    }
    combined.push({
      ...item,
      label:
        language === "ja"
          ? `${item.label}・${reviewItem.label}`
          : `${item.label} · ${reviewItem.label}`,
    });
    foundCurrent = true;
  }
  return foundCurrent ? combined : undefined;
}

function completeTimelineItems(
  timeline: readonly BuyerTimelineItem[],
): BuyerTimelineItem[] {
  const completed: BuyerTimelineItem[] = [];
  for (const item of timeline) completed.push({ ...item, state: "complete" });
  return completed;
}

function shippingOrderTimeline(
  order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "shipping">,
): readonly BuyerTimelineItem[] {
  const currentIndex =
    order.state === "ready"
      ? 0
      : order.state === "label_purchased"
        ? 1
        : order.state === "in_transit"
          ? 2
          : 3;
  return timelineItems(
    ["Order placed", "Shipping label ready", "In transit", "Delivered"],
    currentIndex,
  );
}

function timelineItems(
  labels: readonly string[],
  currentIndex: number,
): readonly BuyerTimelineItem[] {
  const items: BuyerTimelineItem[] = [];
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];
    if (label === undefined) continue;
    items.push({
      label,
      state:
        index < currentIndex
          ? "complete"
          : index === currentIndex
            ? "current"
            : "upcoming",
    });
  }
  return items;
}

export function orderNeedsPolling(order: CommerceBuyerOrderV1): boolean {
  if (paymentReviewIsActive(order.paymentDisputes)) return true;
  switch (order.fulfillment) {
    case "pickup":
      return order.state !== "completed";
    case "shipping":
      return order.state !== "delivered";
    default:
      return assertNever(order, "Unhandled storefront state");
  }
}

function paymentReviewIsActive(
  disputes: readonly CommerceBuyerPaymentDisputeStatusV1[],
): boolean {
  for (const dispute of disputes) {
    switch (dispute.state) {
      case "action_required":
      case "under_review":
        return true;
      case "won":
      case "lost":
        break;
      default:
        return assertNever(dispute, "Unhandled storefront state");
    }
  }
  return false;
}

function statusMessage(state: StorefrontState): string {
  switch (state.kind) {
    case "booting":
      return "Loading storefront.";
    case "quoting":
      return "Preparing your quote.";
    case "paying_pickup":
    case "paying_shipping":
      return "Placing your order.";
    case "payment_pickup":
    case "payment_shipping":
      return "Secure payment details ready.";
    case "pickup_quote":
    case "shipping_quote":
      return "Quote ready.";
    case "shipping_address_correction":
      return "Address correction ready for review.";
    case "pickup_order":
      return `Pickup status: ${state.order.state.replaceAll("_", " ")}.`;
    case "shipping_order":
      return `Delivery status: ${state.order.state.replaceAll("_", " ")}.`;
    case "declined":
      return "Payment declined.";
    case "indeterminate_pickup":
    case "indeterminate_shipping":
      return "Payment status is still being checked.";
    case "catalog":
      return "Storefront loaded.";
    case "failed":
      return state.failure.message;
  }
}

/** An unreadable reply shows a fixed sentence, not the parser's reason. */
function buyerClientError(error: CommerceClientError): string {
  if (error.kind === "invalid_response")
    return "The store's reply could not be read. Try again.";
  return error.message.length === 0
    ? "Something went wrong. Try again."
    : `${error.message} Try again.`;
}

function shippingCheckoutError(error: CommerceClientError): string {
  return error.kind === "rejected" &&
    error.error.code === "resource_relationship_invalid" &&
    error.error.field === "buyerCheckout.shippingServiceAvailability"
    ? "Delivery is temporarily unavailable. Try again later."
    : buyerClientError(error);
}

function isQuoteExpiredError(error: CommerceClientError): boolean {
  return (
    error.kind === "rejected" && error.error.code === "checkout_quote_expired"
  );
}
