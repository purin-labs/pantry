async (page) => {
  const heading = page.locator("h1").first();
  await heading.waitFor({ state: "visible", timeout: 10_000 });
  await page
    .waitForFunction(
      () => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || active.tagName !== "H1")
          return false;
        const box = active.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.height > 0 &&
          box.bottom > 0 &&
          box.top < innerHeight
        );
      },
      undefined,
      { timeout: 2_000 },
    )
    .catch(() => {});
  const button = page.locator("a.signin-button");
  const buttonBox =
    (await button.count()) === 0 ? null : await button.boundingBox();
  const navigation = page
    .locator('nav[aria-label="Workspace pages"]:visible')
    .first();
  const navigationLabels =
    (await navigation.count()) === 0
      ? []
      : await navigation.locator("a").allTextContents();
  const main = page.getByRole("main");
  const invalidFields = page.locator('[aria-invalid="true"]');
  const describedField = invalidFields.first();
  const describedBy =
    (await describedField.count()) === 0
      ? null
      : await describedField.getAttribute("aria-describedby");
  const describedError =
    describedBy === null ? null : page.locator(`#${describedBy}`);
  const semanticLandmarks = await page
    .locator("nav:visible")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.getAttribute("aria-label") ?? "",
        labelledBy: node.getAttribute("aria-labelledby") ?? "",
      })),
    );
  const headingLevels = await page
    .locator("h1:visible, h2:visible, h3:visible, h4:visible")
    .evaluateAll((nodes) =>
      nodes.map((node) => Number.parseInt(node.tagName.slice(1), 10)),
    );
  const semanticLists = await page
    .locator("ul, ol, [role='list']")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        role: node.getAttribute("role") ?? node.tagName.toLowerCase(),
        itemCount: node.matches("ul, ol")
          ? node.querySelectorAll(":scope > li").length
          : node.querySelectorAll(":scope > [role='listitem']").length,
      })),
    );
  const touchTargets = await page
    .locator(
      ":is(main a, main button, main summary, nav[aria-label='Workspace pages'] a, aside.console-sidebar a, aside.console-sidebar button, aside.console-sidebar summary, [data-workspace-search]):visible",
    )
    .evaluateAll((nodes) => {
      const sizes = nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
        };
      });
      return {
        count: sizes.length,
        minimumWidth:
          sizes.length === 0
            ? null
            : Math.min(...sizes.map((size) => size.width)),
        minimumHeight:
          sizes.length === 0
            ? null
            : Math.min(...sizes.map((size) => size.height)),
        violations: sizes.filter((size) => size.width < 44 || size.height < 44)
          .length,
      };
    });
  const describedFieldIds = await invalidFields.evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.id,
      describedBy: node.getAttribute("aria-describedby") ?? "",
    })),
  );
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    activeElementId: document.activeElement?.id ?? "",
    focusedHeadingVisible: (() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active.tagName !== "H1")
        return false;
      const style = getComputedStyle(active);
      const box = active.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.top < innerHeight
      );
    })(),
  }));
  return {
    path: page
      .url()
      .replace(/^https?:\/\/[^/]+/u, "")
      .split("?")[0],
    title: await page.title(),
    heading: ((await heading.textContent()) ?? "").trim(),
    googleLabel:
      (await button.count()) === 0
        ? null
        : ((await button.textContent()) ?? "").trim(),
    googleHref:
      (await button.count()) === 0 ? null : await button.getAttribute("href"),
    googleHeight: buttonBox?.height ?? null,
    navigationLabels,
    mainCount: await main.count(),
    h1Count: await page.locator("h1").count(),
    semanticLandmarks,
    headingLevels,
    semanticLists,
    touchTargets,
    alertCount: await page.getByRole("alert").count(),
    invalidFieldCount: await invalidFields.count(),
    describedFieldIds,
    describedError:
      describedError === null || (await describedError.count()) === 0
        ? null
        : ((await describedError.textContent()) ?? "").trim(),
    focusedId: viewport.activeElementId,
    focusedHeadingVisible: viewport.focusedHeadingVisible,
    viewportWidth: viewport.width,
    scrollWidth: viewport.scrollWidth,
    noHorizontalOverflow: viewport.scrollWidth <= viewport.width,
  };
};
