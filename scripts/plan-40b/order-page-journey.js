async (opener) => {
  // Plan 40B phase 2: two QR order pages on one shop Worker.
  //
  // nuki-cafe.menu.localhost is the café demo merchant; petit-four is a
  // second merchant with the pâtisserie menu. Each page shows its own shop's
  // published menu, in the menu's own sections, and none of the demo copy.
  // A buyer adds two items on the café page and asks for a quote; Commerce
  // prices it, and the journey stops before payment. The second page never
  // shows the café's items. On a phone the page has no sideways scroll.
  //
  // Run: python3 scripts/plan-40b/run-order-page-journey.py
  const CAFE_SITE = JOURNEY_CAFE_SITE;
  const PATISSERIE_SITE = JOURNEY_PATISSERIE_SITE;
  const ARTIFACTS = JOURNEY_ARTIFACTS;
  const DEMO_COPY = [
    "French–Taiwanese tea & pâtisserie",
    "French pâtisserie, Taiwanese comfort",
    "four flavor families",
    "Today’s pickup menu",
    "Milk choice",
  ];
  const page = await opener.context().newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const failedResponses = [];
  const requestedMerchants = new Set();
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    const merchant = /^\/v1\/public\/merchants\/([^/]+)\//u.exec(path);
    if (merchant !== null)
      requestedMerchants.add(decodeURIComponent(merchant[1]));
    if (path.startsWith("/v1/") && response.status() >= 400) {
      failedResponses.push(
        `${response.status()} ${path} ${(await response.text()).slice(0, 300)}`,
      );
    }
  });
  const checks = [];
  const captures = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
  };
  const capture = async (target, name) => {
    await target.screenshot({ path: `${ARTIFACTS}/${name}.png` });
    captures.push(`${name}.png`);
  };
  const texts = async (target, selector) =>
    (await target.locator(selector).allInnerTexts()).map((value) =>
      value.trim(),
    );

  try {
    return await journey();
  } catch (error) {
    await page.screenshot({ path: `${ARTIFACTS}/failure.png` });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${failedResponses.join("\n")}\n${(await page.locator("body").innerText()).slice(0, 800)}`,
    );
  }

  async function openMenu(target, site) {
    await target.goto(site);
    await target.evaluate(() => localStorage.clear());
    await target.reload();
    await target
      .locator(".cafe-menu-item")
      .first()
      .waitFor({ timeout: 30_000 });
  }

  async function journey() {
    // 1. The café's page: its name, its sections and items, no demo copy.
    await openMenu(page, CAFE_SITE);
    const cafeName = (await page.locator("h1").first().innerText()).trim();
    const cafeSections = await texts(page, ".cafe-menu-group h3");
    const cafeItems = await texts(page, ".cafe-menu-item h4");
    const cafeText = await page.locator("body").innerText();
    check(
      "the café page names the shop",
      cafeName.length > 0 && cafeName !== "Café",
      cafeName,
    );
    check(
      "the café page shows the published menu's sections",
      cafeSections.length > 0,
      cafeSections,
    );
    check(
      "the café page shows twelve published items",
      cafeItems.length === 12,
      cafeItems,
    );
    check(
      "the café page shows no demo copy",
      DEMO_COPY.every((line) => !cafeText.includes(line)) &&
        (await page.locator(".cafe-flavor-menu").count()) === 0,
      DEMO_COPY.filter((line) => cafeText.includes(line)),
    );
    check(
      "the page reads only the café's storefront",
      [...requestedMerchants].join() === "merchant_nuki_cafe_demo",
      [...requestedMerchants],
    );
    await capture(page, "01-cafe-menu-desktop");

    // 2. The buyer adds two items; Commerce quotes them.
    const firstItem = page.locator(".cafe-menu-item-available").first();
    const firstTitle = (await firstItem.locator("h4").innerText()).trim();
    const secondItem = page.locator(".cafe-menu-item-available").nth(1);
    const secondTitle = (await secondItem.locator("h4").innerText()).trim();
    await page
      .getByRole("button", { name: `Add one ${firstTitle}` })
      .first()
      .click();
    await page
      .getByRole("button", { name: `Add one ${secondTitle}` })
      .first()
      .click();
    const basket = page.locator(".cafe-basket");
    await basket.getByText(secondTitle).waitFor();
    check(
      "the cart lists both items",
      (await basket.innerText()).includes(firstTitle) &&
        (await basket.innerText()).includes(secondTitle),
      await basket.innerText(),
    );
    await capture(page, "02-cafe-cart");
    await basket.getByPlaceholder("name@example.com").fill("buyer@example.com");
    await basket.getByRole("button", { name: "Checkout", exact: true }).click();
    await page
      .getByText("Ready to send", { exact: false })
      .waitFor({ timeout: 30_000 });
    const review = await page.locator("main").innerText();
    check(
      "the quote lists both items by their published titles",
      review.includes(firstTitle) && review.includes(secondTitle),
      review.slice(0, 800),
    );
    check(
      "the quote shows a total",
      /Total\s+[¥$]/u.test(review),
      review.slice(0, 800),
    );
    await page.waitForTimeout(600); // the review card fades in
    await capture(page, "03-cafe-quote");

    // 3. The second shop's page: its own items, none of the café's.
    requestedMerchants.clear();
    const second = await opener.context().newPage();
    second.on("response", (response) => {
      const merchant = /^\/v1\/public\/merchants\/([^/]+)\//u.exec(
        new URL(response.url()).pathname,
      );
      if (merchant !== null)
        requestedMerchants.add(decodeURIComponent(merchant[1]));
    });
    await second.setViewportSize({ width: 1440, height: 1000 });
    await openMenu(second, PATISSERIE_SITE);
    const patisserieItems = await texts(second, ".cafe-menu-item h4");
    const patisserieSections = await texts(second, ".cafe-menu-group h3");
    check(
      "the second page shows its twenty-four pâtisserie items",
      patisserieItems.length === 24,
      patisserieItems,
    );
    check(
      "the second page shows none of the café's items",
      patisserieItems.every((title) => !cafeItems.includes(title)),
      patisserieItems.filter((title) => cafeItems.includes(title)),
    );
    const secondText = await second.locator("body").innerText();
    check(
      "the second page shows no demo copy",
      DEMO_COPY.every((line) => !secondText.includes(line)),
      DEMO_COPY.filter((line) => secondText.includes(line)),
    );
    check(
      "the second page shows its menu's sections",
      patisserieSections.length > 0,
      patisserieSections,
    );
    check(
      "the second page reads only its own storefront",
      [...requestedMerchants].join() === "merchant_order_page_patisserie",
      [...requestedMerchants],
    );
    await capture(second, "04-second-shop-desktop");

    // 4. On a phone the café page fits the screen.
    const phone = await opener.context().newPage();
    await phone.setViewportSize({ width: 375, height: 812 });
    await openMenu(phone, CAFE_SITE);
    const widths = await phone.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      screen: window.innerWidth,
    }));
    check(
      "the phone page has no sideways scroll",
      widths.scroll <= widths.screen,
      widths,
    );
    await capture(phone, "05-cafe-menu-phone");

    return {
      result: "passed",
      shops: {
        cafe: { name: cafeName, sections: cafeSections, items: cafeItems },
        second: { sections: patisserieSections, items: patisserieItems },
      },
      checks,
      captures,
    };
  }
};
