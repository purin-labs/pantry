import type { PunterCafePatisserieScenario } from "./pickup-scenario.ts";
import type { PunterOnlineCookieScenario } from "./shipping-scenario.ts";

export const CAFE_PATISSERIE_SCENARIO = {
  kind: "cafe_patisserie",
  sesameCookieVariantId: "variant_sesame_cookie",
  menuId: "menu_cafe_main",
  sesameLatteMenuEntryId: "menu_entry_sesame_latte",
  oatMilkModifierOptionId: "modifier_option_oat_milk",
  expectedTotals: {
    subtotal: { amountMinor: 1_250, currency: "JPY" },
    tax: { amountMinor: 125, currency: "JPY" },
    duty: { amountMinor: 0, currency: "JPY" },
    shipping: { amountMinor: 0, currency: "JPY" },
    total: { amountMinor: 1_375, currency: "JPY" },
  },
  expectedQuote: {
    initialQuoteDigest: "quote_digest",
    initialExpiresAt: "2026-08-14T09:40:00.000Z",
    quoteDigest: "refreshed_quote_digest",
    expiresAt: "2026-08-14T09:40:00.000Z",
    pickupLocationId: "location_cafe",
    readyAt: "2026-08-14T09:45:00.000Z",
  },
} satisfies PunterCafePatisserieScenario;

export const ONLINE_COOKIE_SCENARIO = {
  kind: "online_cookie_store",
  variantId: "variant_cookie_box_6",
  unitPrice: { amountMinor: 3_600, currency: "JPY" },
  shippingServiceCode: "ems_test",
  initialQuantity: 1,
  quantity: 2,
  additionalLine: {
    variantId: "variant_ginger_box_6",
    initialQuantity: 1,
    quantity: 2,
    unitPrice: { amountMinor: 3_600, currency: "JPY" },
  },
  initialShippingAddress: {
    countryCode: "SG",
    recipientName: "Nuki Demo Buyer",
    addressLine1: "1 Raffles Quay",
    locality: "Singapore",
    postalCode: "018956",
  },
  shippingAddress: {
    countryCode: "SG",
    recipientName: "Nuki Demo Buyer",
    addressLine1: "8 Marina View",
    locality: "Singapore",
    postalCode: "018960",
  },
  expectedDutyIncoterm: "ddp",
  initialTotals: {
    subtotal: { amountMinor: 7_200, currency: "JPY" },
    tax: { amountMinor: 846, currency: "JPY" },
    duty: { amountMinor: 360, currency: "JPY" },
    shipping: { amountMinor: 2_200, currency: "JPY" },
    total: { amountMinor: 10_606, currency: "JPY" },
  },
  expectedTotals: {
    subtotal: { amountMinor: 14_400, currency: "JPY" },
    tax: { amountMinor: 1_494, currency: "JPY" },
    duty: { amountMinor: 720, currency: "JPY" },
    shipping: { amountMinor: 2_200, currency: "JPY" },
    total: { amountMinor: 18_814, currency: "JPY" },
  },
  expectedQuote: {
    initialQuoteDigest: "cookie_shipping_quote_digest",
    initialExpiresAt: "2026-08-14T10:15:00.000Z",
    quoteDigest: "refreshed_cookie_shipping_quote_digest",
    expiresAt: "2026-08-14T10:15:00.000Z",
    serviceName: "Japan Post EMS Test",
    estimatedDelivery: {
      earliest: "2026-08-18T00:00:00.000Z",
      latest: "2026-08-20T00:00:00.000Z",
    },
    packagePlanDigest:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    packageId: "package_cookie_box_six_1",
    dimensions: {
      lengthMillimeters: 280,
      widthMillimeters: 220,
      heightMillimeters: 400,
    },
    initialCarrierQuote: {
      reference: "rate_cookie_shipping_initial",
      amount: { amountMinor: 2_200, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 1_100, currency: "JPY" },
        { amountMinor: 1_100, currency: "JPY" },
      ],
    },
    initialTaxQuote: {
      registrationPolicyReference: "tax_registration_singapore_fixture",
      reference: "tax_cookie_shipping_initial",
      amount: { amountMinor: 846, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 423, currency: "JPY" },
        { amountMinor: 423, currency: "JPY" },
      ],
    },
    initialDutyQuote: {
      reference: "duty_cookie_shipping_initial",
      amount: { amountMinor: 360, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 180, currency: "JPY" },
        { amountMinor: 180, currency: "JPY" },
      ],
    },
    carrierQuote: {
      reference: "rate_cookie_shipping_refreshed",
      amount: { amountMinor: 2_200, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 1_100, currency: "JPY" },
        { amountMinor: 1_100, currency: "JPY" },
      ],
    },
    taxQuote: {
      registrationPolicyReference: "tax_registration_singapore_fixture",
      reference: "tax_cookie_shipping_refreshed",
      amount: { amountMinor: 1_494, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 747, currency: "JPY" },
        { amountMinor: 747, currency: "JPY" },
      ],
    },
    dutyQuote: {
      reference: "duty_cookie_shipping_refreshed",
      amount: { amountMinor: 720, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 360, currency: "JPY" },
        { amountMinor: 360, currency: "JPY" },
      ],
    },
  },
  expectedPackagePlan: {
    package: {
      weight: { grams: 4_840 },
      customsLines: [
        {
          description: "Six baked cookies in one retail box",
          quantity: 2,
          weight: { grams: 2_400 },
          declaredValue: { amountMinor: 7_200, currency: "JPY" },
          countryOfOrigin: "JP",
          hsCode: "190531",
        },
        {
          description: "Six ginger cookies in one retail box",
          quantity: 2,
          weight: { grams: 2_440 },
          declaredValue: { amountMinor: 7_200, currency: "JPY" },
          countryOfOrigin: "JP",
          hsCode: "190531",
        },
      ],
    },
  },
} satisfies PunterOnlineCookieScenario;

export const DOMESTIC_JAPAN_SCENARIO = {
  kind: "domestic_japan_store",
  variantId: "variant_cookie_box_6",
  unitPrice: { amountMinor: 3_600, currency: "JPY" },
  shippingServiceCode: "takkyubin_test",
  initialQuantity: 1,
  quantity: 2,
  additionalLine: {
    variantId: "variant_ginger_box_6",
    initialQuantity: 1,
    quantity: 2,
    unitPrice: { amountMinor: 3_600, currency: "JPY" },
  },
  initialShippingAddress: {
    countryCode: "JP",
    recipientName: "Punter Domestic Buyer",
    addressLine1: "丸の内1-1-1",
    locality: "千代田区",
    administrativeArea: "東京都",
    postalCode: "100-0005",
  },
  shippingAddress: {
    countryCode: "JP",
    recipientName: "Punter Domestic Buyer",
    addressLine1: "渋谷2-24-1",
    locality: "渋谷区",
    administrativeArea: "東京都",
    postalCode: "150-0002",
  },
  expectedDutyIncoterm: "not_applicable",
  initialTotals: {
    subtotal: { amountMinor: 7_200, currency: "JPY" },
    tax: { amountMinor: 810, currency: "JPY" },
    duty: { amountMinor: 0, currency: "JPY" },
    shipping: { amountMinor: 900, currency: "JPY" },
    total: { amountMinor: 8_910, currency: "JPY" },
  },
  expectedTotals: {
    subtotal: { amountMinor: 14_400, currency: "JPY" },
    tax: { amountMinor: 1_620, currency: "JPY" },
    duty: { amountMinor: 0, currency: "JPY" },
    shipping: { amountMinor: 900, currency: "JPY" },
    total: { amountMinor: 16_920, currency: "JPY" },
  },
  expectedQuote: {
    initialQuoteDigest: "domestic_japan_quote_digest",
    initialExpiresAt: "2026-08-14T10:15:00.000Z",
    quoteDigest: "refreshed_domestic_japan_quote_digest",
    expiresAt: "2026-08-14T10:15:00.000Z",
    serviceName: "Yamato Takkyubin Test",
    estimatedDelivery: {
      earliest: "2026-08-15T00:00:00.000Z",
      latest: "2026-08-16T00:00:00.000Z",
    },
    packagePlanDigest:
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    packageId: "package_domestic_cookie_box_1",
    dimensions: {
      lengthMillimeters: 280,
      widthMillimeters: 220,
      heightMillimeters: 100,
    },
    initialCarrierQuote: {
      reference: "rate_domestic_shipping_initial",
      amount: { amountMinor: 900, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 450, currency: "JPY" },
        { amountMinor: 450, currency: "JPY" },
      ],
    },
    initialTaxQuote: {
      registrationPolicyReference: "tax_registration_domestic_fixture",
      reference: "tax_domestic_shipping_initial",
      amount: { amountMinor: 810, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 405, currency: "JPY" },
        { amountMinor: 405, currency: "JPY" },
      ],
    },
    initialDutyQuote: {
      reference: "duty_domestic_shipping_initial",
      amount: { amountMinor: 0, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 0, currency: "JPY" },
        { amountMinor: 0, currency: "JPY" },
      ],
    },
    carrierQuote: {
      reference: "rate_domestic_shipping_refreshed",
      amount: { amountMinor: 900, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 450, currency: "JPY" },
        { amountMinor: 450, currency: "JPY" },
      ],
    },
    taxQuote: {
      registrationPolicyReference: "tax_registration_domestic_fixture",
      reference: "tax_domestic_shipping_refreshed",
      amount: { amountMinor: 1_620, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 810, currency: "JPY" },
        { amountMinor: 810, currency: "JPY" },
      ],
    },
    dutyQuote: {
      reference: "duty_domestic_shipping_refreshed",
      amount: { amountMinor: 0, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 0, currency: "JPY" },
        { amountMinor: 0, currency: "JPY" },
      ],
    },
  },
  expectedPackagePlan: {
    package: {
      weight: { grams: 4_840 },
      customsLines: [],
    },
  },
} satisfies PunterOnlineCookieScenario;

export const MATCHA_EXPORT_SCENARIO = {
  kind: "online_cookie_store",
  variantId: "variant_matcha_box_6",
  unitPrice: { amountMinor: 4_200, currency: "JPY" },
  shippingServiceCode: "ems_test",
  initialQuantity: 1,
  quantity: 2,
  additionalLine: {
    variantId: "variant_ginger_box_6",
    initialQuantity: 1,
    quantity: 2,
    unitPrice: { amountMinor: 3_600, currency: "JPY" },
  },
  initialShippingAddress: {
    countryCode: "SG",
    recipientName: "Nuki Demo Buyer",
    addressLine1: "1 Raffles Quay",
    locality: "Singapore",
    postalCode: "018956",
  },
  shippingAddress: {
    countryCode: "SG",
    recipientName: "Nuki Demo Buyer",
    addressLine1: "8 Marina View",
    locality: "Singapore",
    postalCode: "018960",
  },
  expectedDutyIncoterm: "ddp",
  initialTotals: {
    subtotal: { amountMinor: 7_800, currency: "JPY" },
    tax: { amountMinor: 900, currency: "JPY" },
    duty: { amountMinor: 390, currency: "JPY" },
    shipping: { amountMinor: 2_200, currency: "JPY" },
    total: { amountMinor: 11_290, currency: "JPY" },
  },
  expectedTotals: {
    subtotal: { amountMinor: 15_600, currency: "JPY" },
    tax: { amountMinor: 1_602, currency: "JPY" },
    duty: { amountMinor: 780, currency: "JPY" },
    shipping: { amountMinor: 2_200, currency: "JPY" },
    total: { amountMinor: 20_182, currency: "JPY" },
  },
  expectedQuote: {
    initialQuoteDigest: "matcha_quote_digest",
    initialExpiresAt: "2026-08-14T10:15:00.000Z",
    quoteDigest: "refreshed_matcha_quote_digest",
    expiresAt: "2026-08-14T10:15:00.000Z",
    serviceName: "Japan Post EMS Test",
    estimatedDelivery: {
      earliest: "2026-08-18T00:00:00.000Z",
      latest: "2026-08-20T00:00:00.000Z",
    },
    packagePlanDigest:
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    packageId: "package_matcha_box_six_1",
    dimensions: {
      lengthMillimeters: 280,
      widthMillimeters: 220,
      heightMillimeters: 400,
    },
    initialCarrierQuote: {
      reference: "rate_matcha_shipping_initial",
      amount: { amountMinor: 2_200, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 1_184, currency: "JPY" },
        { amountMinor: 1_016, currency: "JPY" },
      ],
    },
    initialTaxQuote: {
      registrationPolicyReference: "tax_registration_singapore_fixture",
      reference: "tax_matcha_shipping_initial",
      amount: { amountMinor: 900, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 484, currency: "JPY" },
        { amountMinor: 416, currency: "JPY" },
      ],
    },
    initialDutyQuote: {
      reference: "duty_matcha_shipping_initial",
      amount: { amountMinor: 390, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 210, currency: "JPY" },
        { amountMinor: 180, currency: "JPY" },
      ],
    },
    carrierQuote: {
      reference: "rate_matcha_shipping_refreshed",
      amount: { amountMinor: 2_200, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 1_184, currency: "JPY" },
        { amountMinor: 1_016, currency: "JPY" },
      ],
    },
    taxQuote: {
      registrationPolicyReference: "tax_registration_singapore_fixture",
      reference: "tax_matcha_shipping_refreshed",
      amount: { amountMinor: 1_602, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 862, currency: "JPY" },
        { amountMinor: 740, currency: "JPY" },
      ],
    },
    dutyQuote: {
      reference: "duty_matcha_shipping_refreshed",
      amount: { amountMinor: 780, currency: "JPY" },
      lineAllocations: [
        { amountMinor: 420, currency: "JPY" },
        { amountMinor: 360, currency: "JPY" },
      ],
    },
  },
  expectedPackagePlan: {
    package: {
      weight: { grams: 4_860 },
      customsLines: [
        {
          description: "Six matcha cookies in one retail box",
          quantity: 2,
          weight: { grams: 2_420 },
          declaredValue: { amountMinor: 8_400, currency: "JPY" },
          countryOfOrigin: "JP",
          hsCode: "190531",
        },
        {
          description: "Six ginger cookies in one retail box",
          quantity: 2,
          weight: { grams: 2_440 },
          declaredValue: { amountMinor: 7_200, currency: "JPY" },
          countryOfOrigin: "JP",
          hsCode: "190531",
        },
      ],
    },
  },
} satisfies PunterOnlineCookieScenario;

// Expectations for the disposable Commerce backend in
// services/commerce/tests/punter-acceptance.test.ts: the local seed quoted
// at 2026-08-14T10:00Z with deterministic payment and Japan carrier stubs.
// Digests and references are that backend's own values.
export const LOCAL_CAFE_PATISSERIE_SCENARIO = {
  ...CAFE_PATISSERIE_SCENARIO,
  expectedQuote: {
    ...CAFE_PATISSERIE_SCENARIO.expectedQuote,
    initialQuoteDigest:
      "quote_9dfb8b9b00fcdfff737d0e86aa3bce30633d018290f2571447f4d4ddefec222b",
    initialExpiresAt: "2026-08-14T10:10:00.000Z",
    quoteDigest:
      "quote_3a8e2a198f2243ee23302377dc4fe1bf22a7ac9fcd1373bef4a1fcb190a08767",
    expiresAt: "2026-08-14T10:10:00.000Z",
    readyAt: "2026-08-14T10:15:00.000Z",
  },
} satisfies PunterCafePatisserieScenario;

// The delivery window follows the backend's 10:00Z clock.
export const LOCAL_ONLINE_COOKIE_SCENARIO = {
  ...ONLINE_COOKIE_SCENARIO,
  expectedQuote: {
    ...ONLINE_COOKIE_SCENARIO.expectedQuote,
    initialQuoteDigest:
      "quote_740eb295722332093cb5ed25778d2c3ede421b989881209bc109b666012d26bf",
    quoteDigest:
      "quote_c875af9f493f8f49f7600505bdc3671860b8604f0453a376bf50836a2d948150",
    estimatedDelivery: {
      earliest: "2026-08-17T10:00:00.000Z",
      latest: "2026-08-19T10:00:00.000Z",
    },
    packagePlanDigest:
      "d95a8fa8d3a33c07e2b492e9134271278b105a7f6535a8b3cebaa36169db10aa",
    packageId:
      "package_15779fde077f6489ac7cd2ef510e2eb618fa3c106bc0fb52f7028339198800eb",
    initialCarrierQuote: {
      ...ONLINE_COOKIE_SCENARIO.expectedQuote.initialCarrierQuote,
      reference:
        "rate_d8696bcaf839189509481de76ffd494ce41537ea1e3a8c56d6c90c27310a6679",
    },
    initialTaxQuote: {
      ...ONLINE_COOKIE_SCENARIO.expectedQuote.initialTaxQuote,
      registrationPolicyReference:
        "tax_registration_storefront_cookie_store_sg",
      reference:
        "tax_1d82ba435e9b9212e9ab8b274289418388ec607c96c1c985889c4ad3e744ba27",
    },
    initialDutyQuote: {
      ...ONLINE_COOKIE_SCENARIO.expectedQuote.initialDutyQuote,
      reference:
        "duty_511c9d716e4d2830f209607a520e9537f53244c866d77cd948fd313606ae58d6",
    },
    carrierQuote: {
      ...ONLINE_COOKIE_SCENARIO.expectedQuote.carrierQuote,
      reference:
        "rate_2ce62e536808890ad6e001eb4d83a30550556cbba791692d6b59d1322255345f",
    },
    taxQuote: {
      ...ONLINE_COOKIE_SCENARIO.expectedQuote.taxQuote,
      registrationPolicyReference:
        "tax_registration_storefront_cookie_store_sg",
      reference:
        "tax_efc726d3bee3747ff02c748742d7ccf6dc14213c6bf49bd47bf8fb2a3f9aba5d",
    },
    dutyQuote: {
      ...ONLINE_COOKIE_SCENARIO.expectedQuote.dutyQuote,
      reference:
        "duty_60ad44349c5e6ffe8a2bfaa78e51d3d20c5ec32be6600ac58ede1ccce012ff7a",
    },
  },
} satisfies PunterOnlineCookieScenario;
