async function storeEmptyFixture(page) {
  page.__emptyShippingCatalog = true;
  await page.route("**/v1/public/merchants/**", (route) => {
    const request = route.request();
    const requestUrl = request.url();
    const pathname = requestUrl
      .slice(requestUrl.indexOf("/", requestUrl.indexOf("://") + 3))
      .split("?")[0];
    if (
      !pathname.includes("/storefronts/storefront_cookie_store_sg/") ||
      !pathname.endsWith("/catalog") ||
      page.__emptyShippingCatalog !== true
    ) {
      return route.fallback();
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "commerce.buyer-catalog.v1",
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
        listings: [],
        menus: [],
      }),
    });
  });
  return true;
}
