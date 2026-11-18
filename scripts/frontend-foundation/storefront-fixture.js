async function storefrontFixture(page) {
  const future = "2099-08-14T10:00:00.000Z";
  const money = (amountMinor) => ({ amountMinor, currency: "JPY" });
  const listing = (productId, variantId, offerId, title, amountMinor) => ({
    productId,
    productRevision: 1,
    title,
    description: title,
    variantId,
    variantRevision: 1,
    variantTitle: title,
    sku: variantId.toUpperCase(),
    offerId,
    offerRevision: 1,
    price: money(amountMinor),
    availability: "available",
  });

  const milkModifierGroups = () => [
    {
      modifierGroupId: "modifier_group_milk",
      revision: 1,
      name: "Milk",
      minimumSelections: 0,
      maximumSelections: 1,
      options: [
        {
          modifierOptionId: "modifier_option_oat_milk",
          name: "Oat milk",
          priceDelta: money(100),
        },
      ],
    },
  ];
  const cafeProducts = [
    {
      productId: "product_sesame_latte",
      menuEntryId: "menu_entry_sesame_latte",
      variantId: "variant_sesame_latte",
      offerId: "offer_sesame_latte_cafe",
      title: "Sesame latte",
      amountMinor: 700,
      sectionId: "section_drinks",
      modifierGroups: milkModifierGroups(),
    },
    {
      productId: "product_sesame_cookie",
      menuEntryId: "menu_entry_sesame_cookie",
      variantId: "variant_sesame_cookie",
      offerId: "offer_sesame_cookie_cafe",
      title: "Sesame cookie",
      amountMinor: 450,
      sectionId: "section_bakes",
      modifierGroups: [],
    },
    {
      productId: "product_sesame_financier",
      menuEntryId: "menu_entry_sesame_financier",
      variantId: "variant_sesame_financier",
      offerId: "offer_sesame_financier_cafe",
      title: "Sesame financier",
      amountMinor: 500,
      sectionId: "section_bakes",
      modifierGroups: [],
    },
    {
      productId: "product_ginger_milk_tea",
      menuEntryId: "menu_entry_ginger_milk_tea",
      variantId: "variant_ginger_milk_tea",
      offerId: "offer_ginger_milk_tea_cafe",
      title: "Ginger milk tea",
      amountMinor: 650,
      sectionId: "section_drinks",
      modifierGroups: [],
    },
    {
      productId: "product_ginger_cookie",
      menuEntryId: "menu_entry_ginger_cookie",
      variantId: "variant_ginger_cookie",
      offerId: "offer_ginger_cookie_cafe",
      title: "Ginger cookie",
      amountMinor: 450,
      sectionId: "section_bakes",
      modifierGroups: [],
    },
    {
      productId: "product_ginger_financier",
      menuEntryId: "menu_entry_ginger_financier",
      variantId: "variant_ginger_financier",
      offerId: "offer_ginger_financier_cafe",
      title: "Ginger financier",
      amountMinor: 500,
      sectionId: "section_bakes",
      modifierGroups: [],
    },
    {
      productId: "product_taro_milk_tea",
      menuEntryId: "menu_entry_taro_milk_tea",
      variantId: "variant_taro_milk_tea",
      offerId: "offer_taro_milk_tea_cafe",
      title: "Taro milk tea",
      amountMinor: 700,
      sectionId: "section_drinks",
      modifierGroups: [],
    },
    {
      productId: "product_taro_cookie",
      menuEntryId: "menu_entry_taro_cookie",
      variantId: "variant_taro_cookie",
      offerId: "offer_taro_cookie_cafe",
      title: "Taro cookie",
      amountMinor: 450,
      sectionId: "section_bakes",
      modifierGroups: [],
    },
    {
      productId: "product_taro_financier",
      menuEntryId: "menu_entry_taro_financier",
      variantId: "variant_taro_financier",
      offerId: "offer_taro_financier_cafe",
      title: "Taro financier",
      amountMinor: 500,
      sectionId: "section_bakes",
      modifierGroups: [],
    },
    {
      productId: "product_matcha_tea",
      menuEntryId: "menu_entry_matcha_tea",
      variantId: "variant_matcha_tea",
      offerId: "offer_matcha_tea_cafe",
      title: "Matcha tea",
      amountMinor: 650,
      sectionId: "section_drinks",
      modifierGroups: [],
    },
    {
      productId: "product_matcha_cookie",
      menuEntryId: "menu_entry_matcha_cookie",
      variantId: "variant_matcha_cookie",
      offerId: "offer_matcha_cookie_cafe",
      title: "Matcha cookie",
      amountMinor: 450,
      sectionId: "section_bakes",
      modifierGroups: [],
    },
    {
      productId: "product_matcha_financier",
      menuEntryId: "menu_entry_matcha_financier",
      variantId: "variant_matcha_financier",
      offerId: "offer_matcha_financier_cafe",
      title: "Matcha financier",
      amountMinor: 500,
      sectionId: "section_bakes",
      modifierGroups: [],
    },
  ];
  const cafeCatalog = {
    schemaVersion: "underclerk.buyer-catalog.v1",
    storefront: {
      storefrontId: "storefront_cafe",
      revision: 1,
      name: "Nuki Café",
      fulfillment: "pickup",
    },
    listings: cafeProducts.map((product) =>
      listing(
        product.productId,
        product.variantId,
        product.offerId,
        product.title,
        product.amountMinor,
      ),
    ),
    menus: [
      {
        menuId: "menu_cafe_main",
        revision: 1,
        name: "Café menu",
        sections: [
          { sectionId: "section_drinks", name: "Drinks", position: 0 },
          { sectionId: "section_bakes", name: "Bakes", position: 1 },
        ],
        entries: cafeProducts.map((product) => ({
          menuEntryId: product.menuEntryId,
          sectionId: product.sectionId,
          revision: 1,
          variantId: product.variantId,
          variantRevision: 1,
          offerId: product.offerId,
          offerRevision: 1,
          price: money(product.amountMinor),
          availability: "available",
          consumptionPlanId: `consumption_plan_${product.menuEntryId.replace("menu_entry_", "")}`,
          consumptionPlanRevision: 1,
          modifierGroups: product.modifierGroups,
        })),
      },
    ],
  };

  const shippingProducts = [
    {
      productId: "product_cookie_box",
      variantId: "variant_cookie_box_6",
      offerId: "offer_cookie_box_sg",
      sku: "COOKIE-BOX-6-SG",
      title: "Six-cookie box",
      description: "Six assorted cookies shipped from Japan.",
      amountMinor: 3600,
      weightGrams: 1200,
      customsDescription: "Six baked cookies in one retail box",
    },
    {
      productId: "product_sesame_box",
      variantId: "variant_sesame_box_6",
      offerId: "offer_sesame_box_sg",
      sku: "SESAME-BOX-6-SG",
      title: "Black sesame cookie box",
      description: "Six black sesame cookies shipped from Japan.",
      amountMinor: 3600,
      weightGrams: 1250,
      customsDescription: "Six black sesame cookies in one retail box",
    },
    {
      productId: "product_ginger_box",
      variantId: "variant_ginger_box_6",
      offerId: "offer_ginger_box_sg",
      sku: "GINGER-BOX-6-SG",
      title: "Ginger cookie box",
      description: "Six ginger cookies shipped from Japan.",
      amountMinor: 3600,
      weightGrams: 1220,
      customsDescription: "Six ginger cookies in one retail box",
    },
    {
      productId: "product_taro_box",
      variantId: "variant_taro_box_6",
      offerId: "offer_taro_box_sg",
      sku: "TARO-BOX-6-SG",
      title: "Taro cookie box",
      description: "Six taro cookies shipped from Japan.",
      amountMinor: 3800,
      weightGrams: 1240,
      customsDescription: "Six taro cookies in one retail box",
    },
    {
      productId: "product_matcha_box",
      variantId: "variant_matcha_box_6",
      offerId: "offer_matcha_box_sg",
      sku: "MATCHA-BOX-6-SG",
      title: "Matcha cookie box",
      description: "Six matcha cookies shipped from Japan.",
      amountMinor: 4200,
      weightGrams: 1210,
      customsDescription: "Six matcha cookies in one retail box",
    },
  ];
  const shippingListing = (product) => ({
    productId: product.productId,
    productRevision: 1,
    title: product.title,
    description: product.description,
    variantId: product.variantId,
    variantRevision: 1,
    variantTitle: "Box of six",
    sku: product.sku,
    offerId: product.offerId,
    offerRevision: 1,
    price: money(product.amountMinor),
    availability: "available",
  });
  const shippingCatalog = {
    schemaVersion: "underclerk.buyer-catalog.v1",
    storefront: {
      storefrontId: "storefront_cookie_store_sg",
      revision: 1,
      name: "Nuki Cookie Post",
      fulfillment: "shipping",
      shippingServices: [
        {
          destinationCountry: "SG",
          service: { code: "ems_test", name: "Japan Post EMS Test" },
          availability: { state: "available" },
        },
      ],
    },
    listings: shippingProducts.map(shippingListing),
    menus: [],
  };

  const pickupQuote = (lines) => {
    const quoteLines = lines.map((line) => {
      const product = cafeProducts.find(
        (candidate) => candidate.menuEntryId === line.menuEntryId,
      );
      if (product === undefined) throw new Error("Unknown café cart line");
      const basePrice = product.amountMinor;
      const modifierAmount = line.modifierOptionIds.includes(
        "modifier_option_oat_milk",
      )
        ? 100
        : 0;
      const unitPrice = basePrice + modifierAmount;
      return {
        kind: "menu",
        checkoutLineId: `line_${line.menuEntryId}`,
        menuId: "menu_cafe_main",
        variantId: product.variantId,
        menuEntryId: line.menuEntryId,
        modifierOptionIds: line.modifierOptionIds,
        quantity: line.quantity,
        unitPrice: money(unitPrice),
        lineTotal: money(unitPrice * line.quantity),
      };
    });
    const subtotal = quoteLines.reduce(
      (total, line) => total + line.lineTotal.amountMinor,
      0,
    );
    const tax = Math.round(subtotal * 0.1);
    return {
      schemaVersion: "underclerk.buyer-quoted-checkout.v1",
      checkoutId: "checkout_browser_cafe",
      revision: 1,
      state: "quoted",
      quote: {
        quoteDigest: `quote_browser_cafe_${subtotal}`,
        lines: quoteLines,
        totals: {
          subtotal: money(subtotal),
          tax: money(tax),
          duty: money(0),
          shipping: money(0),
          total: money(subtotal + tax),
        },
        pickup: { locationId: "location_cafe", readyAt: future },
        expiresAt: future,
      },
    };
  };
  const shippingQuote = (line) => {
    const product = shippingProducts.find(
      (candidate) => candidate.variantId === line.variantId,
    );
    if (product === undefined) throw new Error("Unknown shipping cart line");
    const safeQuantity = Number.isInteger(line.quantity)
      ? Math.max(1, Math.min(12, line.quantity))
      : 1;
    const subtotal = product.amountMinor * safeQuantity;
    const duty = Math.floor((subtotal * 500 + 5000) / 10000);
    const shipping = 2200;
    const tax = Math.floor(((subtotal + shipping) * 900 + 5000) / 10000);
    const weight = product.weightGrams * safeQuantity;
    return {
      schemaVersion: "underclerk.buyer-quoted-shipping-checkout.v1",
      checkoutId: "checkout_browser_shipping",
      revision: 1,
      state: "quoted",
      quote: {
        quoteDigest: `quote_browser_shipping_${product.variantId}_${safeQuantity}_1`,
        lines: [
          {
            kind: "catalog",
            checkoutLineId: "checkout_line_cookie_box",
            variantId: product.variantId,
            quantity: safeQuantity,
            unitPrice: money(product.amountMinor),
            lineTotal: money(subtotal),
          },
        ],
        totals: {
          subtotal: money(subtotal),
          tax: money(tax),
          duty: money(duty),
          shipping: money(shipping),
          total: money(subtotal + tax + duty + shipping),
        },
        shipping: {
          addressValidationReference: "address_browser",
          dutyTerms: { incoterm: "ddp" },
          carrierQuote: {
            rateReference: "rate_browser",
            shippingAmount: money(shipping),
            lineAllocations: [
              {
                checkoutLineId: "checkout_line_cookie_box",
                amount: money(shipping),
              },
            ],
          },
          taxQuote: {
            registrationPolicyReference: "tax_jp",
            quoteReference: "tax_browser",
            taxAmount: money(tax),
            lineAllocations: [
              {
                checkoutLineId: "checkout_line_cookie_box",
                amount: money(tax),
              },
            ],
          },
          dutyQuote: {
            quoteReference: "duty_browser",
            incoterm: "ddp",
            dutyAmount: money(duty),
            lineAllocations: [
              {
                checkoutLineId: "checkout_line_cookie_box",
                amount: money(duty),
              },
            ],
          },
          service: { code: "ems_test", name: "Japan Post EMS Test" },
          destinationCountry: "SG",
          estimatedDelivery: {
            kind: "window",
            earliest: "2099-08-18T00:00:00.000Z",
            latest: "2099-08-20T00:00:00.000Z",
          },
          packagePlan: {
            packagePlanDigest: `${"a".repeat(63)}${safeQuantity.toString(16)}`,
            package: {
              packageId: `package_${product.variantId}_${safeQuantity}`,
              weight: { grams: weight },
              dimensions: {
                lengthMillimeters: 280,
                widthMillimeters: 220,
                heightMillimeters: 100,
              },
              lineQuantities: [
                {
                  checkoutLineId: "checkout_line_cookie_box",
                  quantity: { amount: safeQuantity, scale: 0, unit: "each" },
                },
              ],
              customsLines: [
                {
                  checkoutLineId: "checkout_line_cookie_box",
                  description: product.customsDescription,
                  quantity: { amount: safeQuantity, scale: 0, unit: "each" },
                  weight: { grams: weight },
                  declaredValue: money(subtotal),
                  countryOfOrigin: "JP",
                  hsCode: "190531",
                },
              ],
            },
          },
        },
        expiresAt: future,
      },
    };
  };
  const carts = new Map();
  const profile = {
    checkoutProfileId: "checkout_profile_browser",
    revision: 1,
  };
  const configuration = {
    currencyPolicy: { kind: "fixed", currency: "JPY" },
    buyerPolicy: { kind: "guest", requiredContact: "email_required" },
    cartPolicy: {
      kind: "single_fulfillment",
      minimumLines: 1,
      maximumLines: 50,
      maximumTotalQuantity: 100,
    },
    pricingPolicy: {
      kind: "published_offers",
      salesChannelId: "sales_channel_browser",
    },
    taxPolicy: {
      kind: "merchant_inclusive",
      jurisdictionPolicyId: "tax_policy_jp",
    },
    paymentPolicy: {
      kind: "external_provider",
      paymentProviderBindingId: "payment_binding_browser",
    },
    afterSalePolicy: {
      cancellationPolicyId: "cancellation_policy_browser",
      refundPolicyId: "refund_policy_browser",
      refundGovernance: { kind: "approval_required" },
    },
    presentationPolicy: {
      locale: "en-JP",
      merchantDisplayName: "Nuki Café",
      termsPolicyId: "terms_browser",
      privacyPolicyId: "privacy_browser",
      supportContact: "support@example.test",
    },
  };

  await page.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.route("**/v1/public/merchants/**", (route) => {
    const request = route.request();
    const requestUrl = request.url();
    const pathname = requestUrl
      .slice(requestUrl.indexOf("/", requestUrl.indexOf("://") + 3))
      .split("?")[0];
    const cafe = pathname.includes("/storefronts/storefront_cafe/");
    const shipping = pathname.includes(
      "/storefronts/storefront_cookie_store_sg/",
    );
    const storefrontId = cafe
      ? "storefront_cafe"
      : "storefront_cookie_store_sg";
    let body;
    if (pathname.endsWith("/sessions")) {
      body = {
        schemaVersion: "underclerk.buyer-session.v4",
        buyer: { kind: "guest" },
        checkoutProfile: profile,
        checkoutProfileConfiguration: {
          ...configuration,
          fulfillmentPolicy: cafe
            ? { kind: "pickup_only", pickupPolicyId: "pickup_browser" }
            : { kind: "shipping_only", shippingPolicyId: "shipping_browser" },
        },
        token: cafe ? "cafe_browser_session" : "shipping_browser_session",
        expiresAt: future,
        storefrontRevision: 1,
      };
    } else if (pathname.includes("/carts")) {
      const payload = request.postDataJSON();
      if (request.method() === "GET") {
        body = carts.get(storefrontId);
      } else {
        body = {
          schemaVersion: "underclerk.buyer-cart.v1",
          cartId: `cart_${storefrontId}`,
          revision:
            payload.cartRevision === undefined ? 1 : payload.cartRevision + 1,
          checkoutProfile: profile,
          fulfillment: cafe ? "pickup" : "shipping",
          lines: payload.lines,
          state: "active",
        };
        carts.set(storefrontId, body);
      }
    } else if (pathname.endsWith("/address-validations")) {
      body = {
        schemaVersion: "underclerk.buyer-shipping-address-validation.v1",
        validationReference: "address_browser",
        expiresAt: future,
        state: "accepted",
        address: request.postDataJSON().address,
      };
    } else if (pathname.endsWith("/catalog")) {
      body = cafe ? cafeCatalog : shippingCatalog;
    } else if (pathname.endsWith("/checkouts") && request.method() === "POST") {
      const cart = carts.get(storefrontId);
      const payload = request.postDataJSON();
      if (
        cart === undefined ||
        payload.cartId !== cart.cartId ||
        payload.cartRevision !== cart.revision
      )
        throw new Error("Checkout must bind the current cart");
      if (!cafe && cart.lines.length !== 1)
        throw new Error(
          "This shipping journey must quote exactly one cart line",
        );
      body = cafe ? pickupQuote(cart.lines) : shippingQuote(cart.lines[0]);
    } else {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          message: `Unmocked storefront route: ${pathname}`,
        }),
      });
    }
    if (!cafe && !shipping) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return true;
}
