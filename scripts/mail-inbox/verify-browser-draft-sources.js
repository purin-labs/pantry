// Run after mount-browser-fixture.js in the same Playwright CLI session.
// Peita's draft cites an order twice and a Memory once, and the agent was
// shown one more Memory that it did not cite. The drawer underlines the cited
// words; the Sources section lists the sources with their links; pointing
// at a source, or focusing its link, marks its words.
// the result is the run's record.
async function verifyMailDraftSources(page) {
  const needs = page.getByRole("list", {
    name: "Waiting for you",
    exact: true,
  });
  const conversation = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  const body = conversation.locator(".mail-draft-body");
  const marks = body.locator("mark.mail-draft-claim");
  const numbers = body.locator("sup.mail-draft-claim-number");
  const sources = conversation.getByRole("list", {
    name: "Sources",
    exact: true,
  });
  async function markState() {
    return marks.evaluateAll(function read(elements) {
      return elements.map(function state(element) {
        return {
          text: element.firstChild?.textContent ?? "",
          sources: element.dataset.sources,
          active: element.dataset.active === "true",
          underline: getComputedStyle(element).textDecorationStyle,
          background: getComputedStyle(element).backgroundColor,
        };
      });
    });
  }
  function activeMarks(state) {
    return state
      .filter(function active(mark) {
        return mark.active;
      })
      .map(function text(mark) {
        return mark.text;
      });
  }
  // Shows the draft and its sources together, after the marking settles.
  async function showDraft() {
    await conversation
      .locator("#mail-draft-title")
      .evaluate(function top(element) {
        element.scrollIntoView({ block: "start" });
      });
    await page.waitForTimeout(300);
  }
  await page.evaluate(function threeDrafts() {
    window.mailFixtureDrafts = "three";
    window.mailInboxRender({ key: "draft-sources" });
  });
  await needs.getByRole("button", { name: /Peita Lin/ }).click();
  await marks.nth(2).waitFor();
  // The cited words are underlined, quietly: a dotted line and no fill.
  const drafted = await markState();
  if (
    JSON.stringify(
      drafted.map(function words(mark) {
        return [mark.text, mark.sources];
      }),
    ) !==
    JSON.stringify([
      ["your order of 60 ginger financiers", "1"],
      ["We ship online orders on Tuesdays and Fridays", "2"],
      ["your box leaves our kitchen on Friday", "1"],
    ])
  )
    throw new Error(`The draft marks other words: ${JSON.stringify(drafted)}`);
  if (
    drafted.some(function loud(mark) {
      return (
        mark.underline !== "dotted" ||
        mark.active ||
        mark.background !== "rgba(0, 0, 0, 0)"
      );
    })
  )
    throw new Error("A cited run is not a quiet dotted underline");
  // The numbers and the sources stay folded until the person asks.
  await sources.waitFor();
  await numbers.nth(2).waitFor();
  const numbered = await numbers.allInnerTexts();
  if (JSON.stringify(numbered) !== '["1","2","1"]')
    throw new Error(`The marks carry other numbers: ${numbered}`);
  const listed = await sources
    .getByRole("listitem")
    .evaluateAll(function read(items) {
      return items.map(function item(element) {
        const link = element.querySelector("a");
        return {
          number: element.querySelector(".mail-source-number")?.textContent,
          kind: element.dataset.sourceKind,
          text: element.querySelector(".mail-source-text strong")?.textContent,
          detail: element.querySelector(".mail-source-detail")?.textContent,
          link: link?.textContent,
          href: link?.getAttribute("href"),
        };
      });
    });
  const expected = [
    {
      number: "1",
      kind: "order",
      text: "Order #1042",
      detail: "60 × Ginger financier, placed Sun 11 Oct.",
      link: "Open order",
      href: "/orders/order_1042",
    },
    {
      number: "2",
      kind: "memory",
      text: "Fact",
      detail: "Online orders ship on Tuesday and Friday.",
      link: "Open in Brain",
      href: "/brain?memory=memory_shipping_days",
    },
    {
      number: "",
      kind: "memory",
      text: "Preference",
      detail: "Wrap gift boxes in the autumn paper until November.",
      link: "Open in Brain",
      href: "/brain?memory=memory_gift_wrap",
    },
  ];
  if (JSON.stringify(listed) !== JSON.stringify(expected))
    throw new Error(`The sources list differs: ${JSON.stringify(listed)}`);
  // Pointing at the order marks both of its runs, and only those.
  const orderSource = sources.getByRole("listitem").nth(0);
  await showDraft();
  await orderSource.hover();
  await page.waitForTimeout(300);
  const pointed = await markState();
  if (
    JSON.stringify(activeMarks(pointed)) !==
      JSON.stringify([
        "your order of 60 ginger financiers",
        "your box leaves our kitchen on Friday",
      ]) ||
    pointed[0].background === "rgba(0, 0, 0, 0)" ||
    (await orderSource.getAttribute("data-active")) !== "true"
  )
    throw new Error(`Pointing at the order marked: ${JSON.stringify(pointed)}`);
  await page.screenshot({
    path: "output/playwright/mail-draft-sources-pointed.png",
  });
  // An uncited Memory marks nothing.
  await sources.getByRole("listitem").nth(2).hover();
  if (activeMarks(await markState()).length !== 0)
    throw new Error("A Memory that the draft does not cite marked words");
  await page.mouse.move(2, 2);
  // Focus on the Memory's link marks the Memory's words.
  await sources
    .getByRole("listitem")
    .nth(1)
    .getByRole("link", { name: "Open in Brain" })
    .focus();
  const focused = await markState();
  if (
    JSON.stringify(activeMarks(focused)) !==
    JSON.stringify(["We ship online orders on Tuesdays and Fridays"])
  )
    throw new Error(`Focus marked: ${JSON.stringify(focused)}`);
  await showDraft();
  await page.screenshot({
    path: "output/playwright/mail-draft-sources-light.png",
  });
  await page.evaluate(function dark() {
    document.documentElement.dataset.portalTheme = "dark";
    document.documentElement.style.colorScheme = "dark";
  });
  await showDraft();
  await page.screenshot({
    path: "output/playwright/mail-draft-sources-dark.png",
  });
  await page.evaluate(function light() {
    document.documentElement.dataset.portalTheme = "light";
    document.documentElement.style.colorScheme = "light";
  });
  await page.keyboard.press("Tab");
  console.log(
    "MAIL_DRAFT_SOURCES_BROWSER: cited words carry a quiet dotted underline; numbers and sources stay folded until Sources opens; the list names each source by number, title, kind, one line and a link (the order opens its order page, Memory the Brain page); an uncited Memory has no number and marks nothing; pointing at a source and focusing its link mark its words",
  );
  return {
    artifact: "MAIL_DRAFT_SOURCES_BROWSER",
    passed: true,
    marks: drafted.map(function words(mark) {
      return { words: mark.text, source: mark.sources };
    }),
    numbers: numbered,
    sources: listed,
    pointedAtOrder: activeMarks(pointed),
    focusedMemory: activeMarks(focused),
    screenshots: [
      "output/playwright/mail-draft-sources-closed.png",
      "output/playwright/mail-draft-sources-pointed.png",
      "output/playwright/mail-draft-sources-light.png",
      "output/playwright/mail-draft-sources-dark.png",
    ],
  };
}
