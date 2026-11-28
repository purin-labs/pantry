import {
  PATISSERIE_PRODUCTS,
  patisserieProductId,
  patisserieIsMadeToOrder,
  patisserieThumbnail,
} from "./patisserie.tsx";
import type { CafeLanguage } from "./checkout-errors.ts";
import type {
  CafeFlavorMenuCopy,
  CafeInterfaceCopy,
  CafeProductConfiguration,
  CafeProductCopy,
  CafeProductId,
  NukiCafeProductId,
} from "./storefront-types.ts";

export const CAFE_INTERFACE_COPY: Readonly<Record<CafeLanguage, CafeInterfaceCopy>> = {
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

export const CAFE_FLAVOR_MENU_COPY: Readonly<
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

/** The demo products, with their own art and copy. */
export const CAFE_PRODUCT_CONFIGURATIONS: readonly (CafeProductConfiguration &
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

export const CAFE_PRODUCT_COPY: Readonly<
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
