// Claim Trace on an email reply card in Portal chat. Run it against the
// Portal Vite server, on any page of it:
//   P=$HOME/.codex/skills/playwright/scripts/playwright_cli.sh
//   bash $P -s=chat-claims open http://127.0.0.1:3103/chat-preview.html
//   bash $P -s=chat-claims --json run-code --filename scripts/mail-inbox/verify-browser-chat-claim-trace.js
// The chat preview's drafts scenario holds a reply to Aiko that cites one
// order twice. Its second sentence also promises free gift wrap, which no
// record supports. The card marks those words and the summary asks the
// reviewer to check them. The trace joins each claim to its record, "Change
// it" opens the editor with the words selected, and the summary follows the
// text while the person edits and after the save. Screenshots go to
// output/playwright/chat-claim-trace-*.png; the result is the run's record.
async function verifyChatClaimTrace(page) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${origin}/chat-preview.html?scenario=drafts&conversation=conv_00000000-0000-0000-0000-000000000001`,
  );
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  const card = page
    .locator("article.draft-message")
    .filter({ hasText: "Hi Aiko" });
  await card.waitFor();
  const summary = card.locator(".mail-claim-summary");
  const trace = card.locator(".mail-trace");
  const claims = trace.getByRole("list", {
    name: "Claims in the draft",
    exact: true,
  });
  const records = trace.getByRole("list", {
    name: "Records behind the claims",
    exact: true,
  });
  const free = "gift wrap is free for every order this month.";
  async function lit() {
    return trace.evaluate(function read(element) {
      return {
        claims: [
          ...element.querySelectorAll("[data-trace-claim][data-lit]"),
        ].map(function text(item) {
          return item.querySelector("q").textContent;
        }),
        records: [
          ...element.querySelectorAll("[data-trace-record][data-lit]"),
        ].map(function key(item) {
          return item.dataset.traceRecord;
        }),
        lines: element.querySelectorAll(".mail-trace-line[data-lit]").length,
      };
    });
  }
  async function show() {
    await card.evaluate(function top(element) {
      element.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(300);
  }

  await summary.waitFor();
  const first = await summary.locator("p").innerText();
  if (first !== "2 of 3 claims have a source. Check the one without a source.")
    throw new Error(`The card's summary reads: ${first}`);
  // Only the uncited words of the sentence are marked, with a dashed line.
  const marked = await card
    .locator("mark.mail-draft-unsourced")
    .evaluateAll(function state(marks) {
      return marks.map(function one(mark) {
        return [mark.textContent, getComputedStyle(mark).textDecorationStyle];
      });
    });
  if (JSON.stringify(marked) !== JSON.stringify([[free, "dashed"]]))
    throw new Error(`The card marks: ${JSON.stringify(marked)}`);
  if ((await trace.count()) !== 0)
    throw new Error("The trace shows before the person opens it");

  await summary.getByRole("button", { name: "Show sources" }).click();
  await trace.waitFor();
  const claimed = await claims
    .getByRole("listitem")
    .evaluateAll(function read(items) {
      return items.map(function one(item) {
        return [
          item.querySelector("q").textContent,
          item.querySelector(".mail-trace-claim-refs").textContent,
        ];
      });
    });
  if (
    JSON.stringify(claimed) !==
    JSON.stringify([
      ["your order of 24 hazelnut financiers", "1"],
      ["Your box leaves our kitchen on Thursday", "1"],
      [free, "No source"],
    ])
  )
    throw new Error(`The trace lists other claims: ${JSON.stringify(claimed)}`);
  // The Memory that the agent read and did not cite is not a record of any
  // claim. The order opens its page in the workspace.
  const recordTitles = await records
    .getByRole("listitem")
    .locator("strong")
    .allInnerTexts();
  if (
    JSON.stringify(recordTitles) !==
    JSON.stringify(["Order #2207", "No record supports this claim"])
  )
    throw new Error(`The trace shows other records: ${recordTitles}`);
  const orderLink = await records
    .getByRole("link", { name: "Open order" })
    .getAttribute("href");
  if (orderLink !== "/portal/noix/cafe/customer_order/order_2207")
    throw new Error(`The order opens ${orderLink}`);
  // Each line runs from the right edge of its claim to the left edge of its
  // record.
  const joined = await trace.evaluate(function joins(element) {
    const frame = element.getBoundingClientRect();
    const claimRects = [...element.querySelectorAll("[data-trace-claim]")].map(
      function rect(item) {
        return item.getBoundingClientRect();
      },
    );
    const recordRects = [...element.querySelectorAll("[data-trace-record]")];
    return [...element.querySelectorAll(".mail-trace-line path")].map(
      function ends(path) {
        const start = path.getPointAtLength(0);
        const end = path.getPointAtLength(path.getTotalLength());
        const from = claimRects.findIndex(function right(rect) {
          return (
            Math.abs(rect.right - frame.left - start.x) < 2 &&
            start.y > rect.top - frame.top &&
            start.y < rect.bottom - frame.top
          );
        });
        const to = recordRects.find(function left(item) {
          const rect = item.getBoundingClientRect();
          return (
            Math.abs(rect.left - frame.left - end.x) < 2 &&
            end.y > rect.top - frame.top &&
            end.y < rect.bottom - frame.top
          );
        });
        const key = to === undefined ? null : to.dataset.traceRecord;
        return [from, key !== null && key.startsWith("u:") ? "none" : key];
      },
    );
  });
  if (
    JSON.stringify(joined) !==
    JSON.stringify([
      [0, "n:1"],
      [1, "n:1"],
      [2, "none"],
    ])
  )
    throw new Error(`The lines join other ends: ${JSON.stringify(joined)}`);
  // Pointing at the order lights both of its claims and their words.
  await records.getByRole("listitem").nth(0).hover();
  await page.waitForTimeout(200);
  const fromRecord = await lit();
  const activeWords = await card
    .locator(".draft-message-body mark[data-active]")
    .evaluateAll(function text(marks) {
      return marks.map(function one(mark) {
        return mark.firstChild.textContent;
      });
    });
  if (
    fromRecord.claims.length !== 2 ||
    fromRecord.lines !== 2 ||
    JSON.stringify(activeWords) !==
      JSON.stringify([
        "your order of 24 hazelnut financiers",
        "Your box leaves our kitchen on Thursday",
      ])
  )
    throw new Error(
      `Pointing at the order lit: ${JSON.stringify({ fromRecord, activeWords })}`,
    );
  await show();
  await page.screenshot({
    path: "output/playwright/chat-claim-trace-open.png",
  });
  await page.mouse.move(2, 2);

  await page.evaluate(function dark() {
    document.documentElement.dataset.portalTheme = "dark";
    document.documentElement.style.colorScheme = "dark";
  });
  await show();
  await page.screenshot({
    path: "output/playwright/chat-claim-trace-dark.png",
  });
  await page.evaluate(function light() {
    document.documentElement.dataset.portalTheme = "light";
    document.documentElement.style.colorScheme = "light";
  });

  // A phone-width chat stacks the records under the claims, with no lines.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(400);
  const stacked = await trace.evaluate(function layout(element) {
    const claimList = element.querySelector(".mail-trace-claims");
    const recordList = element.querySelector(".mail-trace-records");
    return {
      lines: getComputedStyle(element.querySelector(".mail-trace-lines"))
        .display,
      below:
        recordList.getBoundingClientRect().top >=
        claimList.getBoundingClientRect().bottom,
      overflow: element.scrollWidth > element.clientWidth + 1,
    };
  });
  if (stacked.lines !== "none" || !stacked.below || stacked.overflow)
    throw new Error(`The narrow trace is laid out: ${JSON.stringify(stacked)}`);
  await trace.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "output/playwright/chat-claim-trace-narrow.png",
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);

  // "Change it" opens the editor with the words selected.
  await records.getByRole("button", { name: "Change it" }).click();
  const editor = card.getByRole("textbox", { name: "Message", exact: true });
  await editor.waitFor();
  const selection = await editor.evaluate(function selected(element) {
    return {
      text: element.value.slice(element.selectionStart, element.selectionEnd),
      focused: document.activeElement === element,
    };
  });
  if (selection.text !== free || !selection.focused)
    throw new Error(`Change it chose: ${JSON.stringify(selection)}`);
  if ((await records.getByRole("button", { name: "Select it" }).count()) !== 1)
    throw new Error("The editor's trace does not offer Select it");
  // The summary follows the text in the editor before any save.
  await page.keyboard.type("we wrap every box in the autumn paper.");
  const typed = await summary.locator("p").innerText();
  if (typed !== "All 2 claims have a source.")
    throw new Error(`While editing, the summary reads: ${typed}`);
  await show();
  await page.screenshot({
    path: "output/playwright/chat-claim-trace-editing.png",
  });
  // After the save, the card reads the draft again and keeps the result.
  await card.getByRole("button", { name: "Save changes" }).click();
  await editor.waitFor({ state: "detached" });
  await card.getByText("in the autumn paper").waitFor();
  await page.waitForTimeout(800);
  const saved = await summary.locator("p").innerText();
  const savedMarks = await card.locator("mark.mail-draft-unsourced").count();
  if (saved !== "All 2 claims have a source." || savedMarks !== 0)
    throw new Error(`After the save: ${JSON.stringify({ saved, savedMarks })}`);

  return {
    artifact: "CHAT_CLAIM_TRACE_BROWSER",
    passed: true,
    summaries: { first, typed, saved },
    marked,
    claims: claimed,
    lines: joined,
    stacked,
    screenshots: [
      "output/playwright/chat-claim-trace-open.png",
      "output/playwright/chat-claim-trace-dark.png",
      "output/playwright/chat-claim-trace-narrow.png",
      "output/playwright/chat-claim-trace-editing.png",
    ],
  };
}
