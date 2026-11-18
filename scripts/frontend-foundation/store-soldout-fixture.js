async function storeSoldoutFixture(page) {
  await page.route("**/v1/public/merchants/**", (route) => {
    const request = route.request();
    const requestUrl = request.url();
    const pathname = requestUrl
      .slice(requestUrl.indexOf("/", requestUrl.indexOf("://") + 3))
      .split("?")[0];
    if (
      !pathname.includes("/storefronts/storefront_cookie_store_sg/") ||
      !pathname.endsWith("/catalog")
    ) {
      return route.fallback();
    }
    const money = (amountMinor) => ({ amountMinor, currency: "JPY" });
    const listing = (
      productId,
      variantId,
      offerId,
      sku,
      title,
      description,
      amountMinor,
      availability,
    ) => ({
      productId,
      productRevision: 1,
      title,
      description,
      variantId,
      variantRevision: 1,
      variantTitle: "Box of six",
      sku,
      offerId,
      offerRevision: 1,
      price: money(amountMinor),
      availability,
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
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
        listings: [
          listing(
            "product_cookie_box",
            "variant_cookie_box_6",
            "offer_cookie_box_sg",
            "COOKIE-BOX-6-SG",
            "Six-cookie box",
            "Six assorted cookies shipped from Japan.",
            3600,
            "available",
          ),
          listing(
            "product_ginger_box",
            "variant_ginger_box_6",
            "offer_ginger_box_sg",
            "GINGER-BOX-6-SG",
            "Ginger cookie box",
            "Six ginger cookies shipped from Japan.",
            3600,
            "available",
          ),
          listing(
            "product_matcha_box",
            "variant_matcha_box_6",
            "offer_matcha_box_sg",
            "MATCHA-BOX-6-SG",
            "Matcha cookie box",
            "Six matcha cookies shipped from Japan.",
            4200,
            "unavailable",
          ),
        ],
        menus: [],
      }),
    });
  });
  return true;
}
