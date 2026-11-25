async (opener) => {
  // The pâtisserie site (shop.purin.io) against a local Commerce.
  //
  // A buyer opens the menu that the setup script published: eight financiers,
  // the hotcake financier, five pies, three pastries and seven drinks, with
  // the prices that Commerce sells them at and the allergens of each item, as
  // the footer promises. The buyer adds two black sesame
  // financiers, a steak and pepper pie and a caffè latte, reads the menu in
  // Japanese, and asks for a quote. The latte is made to order: Commerce
  // can quote it only from its recipe's stocked ingredients. Commerce
  // prices the order with 8% tax inside the listed prices; the journey stops
  // before payment. On a phone the page has no sideways scroll, and on a
  // 320px phone every item name stays on the screen.
  //
  // Run: python3 scripts/patisserie/run-storefront-journey.py
  const SITE = JOURNEY_SITE;
  const ARTIFACTS = JOURNEY_ARTIFACTS;
  const page = await opener.context().newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const failedResponses = [];
  page.on("response", async (response) => {
    if (response.url().includes("/v1/") && response.status() >= 400) {
      failedResponses.push(
        `${response.status()} ${new URL(response.url()).pathname} ${(await response.text()).slice(0, 300)}`,
      );
    }
  });
  const checks = [];
  const captures = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
  };
  const capture = async (name) => {
    await page.screenshot({ path: `${ARTIFACTS}/${name}.png` });
    captures.push(`${name}.png`);
  };
  // The pastry showcase as one image, after its lazy photographs arrive.
  const capturePastries = async (target, name) => {
    const section = target.locator("#patisserie-pastries");
    await section.scrollIntoViewIfNeeded();
    for (const image of await section.locator("img").all()) {
      await image.evaluate((node) =>
        node.complete ? null : node.decode().catch(() => null),
      );
    }
    // A section taller than the screen is drawn past the screen's bottom,
    // where the closed cart drawer waits, so the capture hides the drawer.
    await section.screenshot({
      path: `${ARTIFACTS}/${name}.png`,
      style: ".patisserie-drawer { display: none; }",
    });
    captures.push(`${name}.png`);
  };
  const captureSection = async (target, selector, name) => {
    const section = target.locator(selector);
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({
      path: `${ARTIFACTS}/${name}.png`,
      style: ".patisserie-drawer { display: none; }",
    });
    captures.push(`${name}.png`);
  };
  const text = async (selector) =>
    (await page.locator(selector).allInnerTexts()).map((value) => value.trim());

  try {
    return await journey();
  } catch (error) {
    await page.screenshot({ path: `${ARTIFACTS}/failure.png` });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${failedResponses.join("\n")}\n${(await page.locator("body").innerText()).slice(0, 800)}`,
    );
  }

  async function journey() {
    await page.goto(SITE);
    // A new buyer: no cart saved from an earlier run. A new tab also has no
    // saved checkout, which the storefront keeps in session storage.
    await page.evaluate(() => localStorage.clear());
    // Commerce answers slowly for a moment, so the page shows what a
    // buyer sees while the menu loads.
    let slowCommerce = true;
    await page.route("**/v1/**", async (route) => {
      if (slowCommerce) await new Promise((done) => setTimeout(done, 1500));
      await route.continue();
    });
    await page.reload();
    await page.locator(".skeleton[aria-busy='true']").waitFor();
    check(
      "a skeleton of the menu holds the page while the menu loads",
      (await page.locator(".skeleton .patisserie-chart-item").count()) === 8,
    );
    await capture("00-menu-skeleton");
    slowCommerce = false;
    await page
      .locator(".patisserie-chart-item:not(.skeleton *)")
      .first()
      .waitFor({ timeout: 20_000 });

    // 1. The menu shows every published item at its Commerce price.
    const financiers = await text(".patisserie-chart-item h3");
    check(
      "the chart shows the eight financiers",
      financiers.length === 8,
      financiers,
    );
    check(
      "coffee and houjicha are on the chart",
      financiers.includes("coffee") && financiers.includes("houjicha"),
      financiers,
    );
    const prices = await text(".patisserie-price");
    check("twenty-four items carry a price", prices.length === 24, prices);
    check(
      "each section shows its price",
      prices[0] === "¥300" &&
        prices[8] === "¥1,200" &&
        prices[9] === "¥1,600" &&
        prices[16] === "¥780" &&
        prices[17] === "¥680" &&
        prices[23] === "¥620",
      prices,
    );
    const drinkGroups = await text(".patisserie-drink-group h3");
    const drinks = await text(".patisserie-drink h4");
    check(
      "the drinks board lists the coffees beside the milk drinks",
      drinkGroups.join("|") === "COFFEE|TEA AND LATTES" &&
        drinks.length === 7 &&
        drinks.includes("MATCHA LATTE") &&
        drinks.includes("GINGER LATTE"),
      { drinkGroups, drinks },
    );
    check(
      "five pies show a cross-section",
      (await page.locator(".patisserie-cross-section").count()) === 5,
    );
    const allergenLines = await text(".patisserie-allergens");
    check(
      "each item lists its allergens, as the footer says",
      allergenLines.length === 24 &&
        allergenLines.every((line) => /^Allergens: \S/u.test(line)),
      allergenLines,
    );
    await capture("01-menu-desktop");

    // 2. The buyer adds two black sesame financiers and one steak pie.
    await page
      .getByRole("button", { name: "Add Black sesame financier" })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Add Black sesame financier" })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Add Steak and pepper" })
      .first()
      .click();
    await page.getByRole("button", { name: "Add Caffè latte" }).click();
    check(
      "the page has no cart column",
      (await page.locator(".patisserie-shell > aside").count()) === 0,
    );
    const cartButton = page.getByRole("button", { name: "Cart (4)" });
    await cartButton.waitFor();
    await page.locator("#patisserie-pies").scrollIntoViewIfNeeded();
    const bar = await page.locator(".patisserie-sections").evaluate((node) => {
      const box = node.getBoundingClientRect();
      return {
        top: box.top,
        width: box.width,
        screen: document.documentElement.clientWidth,
        text: node.innerText,
      };
    });
    check(
      "the section bar stays at the top of the screen, full width, with the cart",
      bar.top === 0 &&
        Math.abs(bar.width - bar.screen) < 1 &&
        bar.text.includes("CART (4)"),
      bar,
    );
    await capture("02-pies-with-cart");
    await capturePastries(page, "02b-pastries-desktop");
    // The drink photographs load lazily; each one must arrive whole.
    const drinkImages = page.locator("#patisserie-drinks img");
    await page.locator("#patisserie-drinks").scrollIntoViewIfNeeded();
    for (const image of await drinkImages.all()) {
      await image.scrollIntoViewIfNeeded();
      await image.evaluate((node) =>
        node.complete ? null : node.decode().catch(() => null),
      );
    }
    const brokenDrinks = await drinkImages.evaluateAll((nodes) =>
      nodes.filter((node) => node.naturalWidth === 0).map((node) => node.src),
    );
    check(
      "each of the seven drinks shows a photograph",
      (await drinkImages.count()) === 7 && brokenDrinks.length === 0,
      { images: await drinkImages.count(), broken: brokenDrinks },
    );
    await captureSection(page, "#patisserie-drinks", "02c-drinks-desktop");
    // The language menu opens as a list in the site's style.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(".language-select select").click();
    await page.waitForTimeout(300); // the list fades in
    await capture("02-language-menu");
    await page.keyboard.press("Escape");

    // 3. The menu reads in Japanese.
    await page.getByRole("combobox").first().selectOption("ja");
    await page
      .locator(".patisserie-chart-heading h2", { hasText: "8種の" })
      .waitFor();
    const pieTitles = await text(".patisserie-pie-copy h3");
    check(
      "pie names are in Japanese",
      pieTitles[0] === "ステーキ＆ペッパーパイ",
      pieTitles,
    );
    await page.getByRole("combobox").first().selectOption("en");
    await page
      .locator(".patisserie-chart-heading h2", { hasText: "Eight flavours" })
      .waitFor();

    // 4. The navbar cart opens a drawer with the order and its total.
    await cartButton.click();
    const drawer = page.getByRole("dialog", { name: "Cart" });
    await drawer.getByText("¥2,800").waitFor();
    check(
      "the cart drawer totals ¥2,800",
      (await drawer.innerText()).includes("¥2,800"),
    );
    // The panel slides in for 320 ms; the capture waits until it rests.
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector(".patisserie-drawer-panel"))
          .transform === "none",
    );
    await capture("03-cart-drawer");
    // A keyboard buyer stays in the open drawer: Tab never reaches the menu
    // behind the shade. (Past the last field focus may leave the page for
    // the browser, where the active element is <body>.)
    const outside = [];
    for (let press = 0; press < 25; press += 1) {
      await page.keyboard.press("Tab");
      const escaped = await page.evaluate(() => {
        const active = document.activeElement;
        return active === null ||
          active === document.body ||
          active.closest(".patisserie-drawer-panel") !== null
          ? null
          : active.outerHTML.slice(0, 80);
      });
      if (escaped !== null) outside.push(escaped);
    }
    check(
      "Tab stays inside the open cart drawer",
      outside.length === 0,
      outside,
    );
    // 5. Commerce quotes the order.
    await drawer.getByPlaceholder("name@example.com").fill("buyer@example.com");
    slowCommerce = true;
    await drawer.getByRole("button", { name: "Checkout", exact: true }).click();
    await page.locator(".checkout-card.skeleton").waitFor();
    await capture("04-quote-skeleton");
    slowCommerce = false;
    await page
      .getByText("Ready to send", { exact: false })
      .waitFor({ timeout: 20_000 });
    const review = await page.locator("main").innerText();
    check(
      "the quote lists the three items",
      review.includes("Black sesame financier") &&
        review.includes("Steak and pepper") &&
        review.includes("Caffè latte"),
    );
    check(
      "the quote prices the items at ¥2,800",
      /Items\s+¥2,800/u.test(review),
      review.slice(0, 600),
    );
    // 8% inside ¥2,800 is ¥2,800 × 8 / 108 = ¥207.41, so ¥207.
    check(
      "the listed prices include 8% tax, so the total stays ¥2,800",
      /Includes tax\s+¥207/u.test(review) && /Total\s+¥2,800/u.test(review),
      review.slice(0, 600),
    );
    await capture("04-quote");

    // 6. On a phone (a new tab, so no open checkout) the page fits the screen.
    const phone = await opener.context().newPage();
    await phone.setViewportSize({ width: 375, height: 812 });
    await phone.goto(SITE);
    await phone
      .locator(".patisserie-chart-item")
      .first()
      .waitFor({ timeout: 20_000 });
    const widths = await phone.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      screen: window.innerWidth,
    }));
    check(
      "the phone page has no sideways scroll",
      widths.scroll <= widths.screen,
      widths,
    );
    await phone.screenshot({ path: `${ARTIFACTS}/05-menu-phone.png` });
    captures.push("05-menu-phone.png");
    await phone.locator("#patisserie-pies").scrollIntoViewIfNeeded();
    // The pie photographs load lazily; each one must arrive whole.
    const pieImages = phone.locator("#patisserie-pies img");
    for (const image of await pieImages.all()) {
      await image.scrollIntoViewIfNeeded();
      await image.evaluate((node) =>
        node.complete ? null : node.decode().catch(() => null),
      );
    }
    const broken = await pieImages.evaluateAll((nodes) =>
      nodes.filter((node) => node.naturalWidth === 0).map((node) => node.src),
    );
    check("every pie photograph loads on the phone", broken.length === 0, {
      images: await pieImages.count(),
      broken,
    });
    await phone.locator("#patisserie-pies").scrollIntoViewIfNeeded();
    await phone.screenshot({ path: `${ARTIFACTS}/06-pies-phone.png` });
    captures.push("06-pies-phone.png");
    await capturePastries(phone, "06b-pastries-phone");
    await captureSection(phone, "#patisserie-drinks", "06c-drinks-phone");

    // 7. The page keeps "overflow-x: clip", so a name too wide for a small
    // phone is cut off without a sideways scroll. On a 320px phone every
    // item name stays on the screen.
    await phone.setViewportSize({ width: 320, height: 700 });
    const cutOff = await phone.evaluate(() =>
      [...document.querySelectorAll(".patisserie-menu :is(h3, h4)")]
        .filter(
          (node) => node.getBoundingClientRect().right > window.innerWidth,
        )
        .map((node) => node.textContent),
    );
    check("every item name fits a 320px screen", cutOff.length === 0, cutOff);
    await captureSection(phone, "#patisserie-pies", "07-pies-320");

    return { result: "passed", checks, captures };
  }
};
