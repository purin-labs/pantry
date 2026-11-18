// Run with portal-mail-reply-room.mjs installed, after mount-browser-fixture.js
// (build the run with scripts/mail-inbox/build-claim-trace-run.sh).
// Peita's draft cites an order twice and a Memory once, and it promises a
// free card that no record supports. The draft marks that sentence and the
// summary asks the reviewer to check it. The trace joins each claim to its
// record with one line, and pointing at either end lights the other. Ken's
// draft has no source at all. Mika's shared draft gains a claim while the
// person edits it, and the trace selects its words in the editor. A narrow
// pane stacks the trace. Screenshots go to output/playwright/
// mail-claim-trace-*.png; the result is the run's record.
async function verifyClaimTrace(page) {
  const needs = page.getByRole("list", {
    name: "Waiting for you",
    exact: true,
  });
  const conversation = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  const draft = conversation.locator("section.mail-draft");
  const summary = draft.locator(".mail-claim-summary");
  const trace = draft.locator(".mail-trace");
  const claims = trace.getByRole("list", {
    name: "Claims in the draft",
    exact: true,
  });
  const records = trace.getByRole("list", {
    name: "Records behind the claims",
    exact: true,
  });
  const bar = conversation.locator(".mail-draft-bar");
  async function showDraft() {
    await conversation
      .locator("#mail-draft-title")
      .evaluate(function top(element) {
        element.scrollIntoView({ block: "start" });
      });
    await page.waitForTimeout(300);
  }
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
  async function bodyMarks() {
    return draft.locator(".mail-draft-body").evaluate(function read(body) {
      return {
        active: [...body.querySelectorAll("mark[data-active]")].map(
          function text(mark) {
            return mark.firstChild.textContent;
          },
        ),
        unsourced: [...body.querySelectorAll("mark.mail-draft-unsourced")].map(
          function state(mark) {
            return {
              text: mark.textContent,
              underline: getComputedStyle(mark).textDecorationStyle,
            };
          },
        ),
      };
    });
  }

  await page.evaluate(function threeDrafts() {
    window.mailFixtureDrafts = "three";
    window.mailInboxRender({ key: "claim-trace" });
  });

  // Peita: three cited claims and one that no record supports.
  await needs.getByRole("button", { name: /Peita Lin/ }).click();
  await summary.waitFor();
  const peitaSummary = await summary.locator("p").innerText();
  if (
    peitaSummary !==
    "3 of 4 claims have a source. Check the one without a source."
  )
    throw new Error(`Peita's summary reads: ${peitaSummary}`);
  const closed = await bodyMarks();
  if (
    JSON.stringify(closed.unsourced) !==
    JSON.stringify([
      {
        text: "We include a free handwritten card with every box.",
        underline: "dashed",
      },
    ])
  )
    throw new Error(`The draft marks other claims: ${JSON.stringify(closed)}`);
  if ((await trace.count()) !== 0)
    throw new Error("The trace shows before the person asks for it");
  await summary.getByRole("button", { name: "Show sources" }).click();
  await records.waitFor();
  if (
    (await summary
      .getByRole("button", { name: "Hide sources" })
      .getAttribute("aria-expanded")) !== "true"
  )
    throw new Error("The trace button does not report that it is open");
  const claimed = await claims
    .getByRole("listitem")
    .evaluateAll(function read(items) {
      return items.map(function item(element) {
        return [
          element.querySelector("q").textContent,
          element.querySelector(".mail-trace-claim-refs").textContent,
        ];
      });
    });
  if (
    JSON.stringify(claimed) !==
    JSON.stringify([
      ["your order of 60 ginger financiers", "1"],
      ["We ship online orders on Tuesdays and Fridays", "2"],
      ["your box leaves our kitchen on Friday", "1"],
      ["We include a free handwritten card with every box.", "No source"],
    ])
  )
    throw new Error(`The trace lists other claims: ${JSON.stringify(claimed)}`);
  // The Memory that the agent was shown and did not cite is not a record of
  // any claim.
  const recordTitles = await records
    .getByRole("listitem")
    .locator("strong")
    .allInnerTexts();
  if (
    JSON.stringify(recordTitles) !==
    JSON.stringify(["Order #1042", "Fact", "No record supports this claim"])
  )
    throw new Error(`The trace shows other records: ${recordTitles}`);
  // Each line runs from the right edge of its claim to the left edge of its
  // record.
  const joined = await trace.evaluate(function joins(element) {
    const frame = element.getBoundingClientRect();
    const claimRects = [...element.querySelectorAll("[data-trace-claim]")].map(
      function rect(item) {
        return item.getBoundingClientRect();
      },
    );
    const recordRects = new Map(
      [...element.querySelectorAll("[data-trace-record]")].map(
        function rect(item) {
          return [item.dataset.traceRecord, item.getBoundingClientRect()];
        },
      ),
    );
    const claimKeys = [...element.querySelectorAll("[data-trace-claim]")].map(
      function key(item) {
        return item.dataset.traceClaim;
      },
    );
    return [...element.querySelectorAll(".mail-trace-line path")].map(
      function ends(path) {
        const length = path.getTotalLength();
        const start = path.getPointAtLength(0);
        const end = path.getPointAtLength(length);
        const from = claimRects.findIndex(function right(rect) {
          return (
            Math.abs(rect.right - frame.left - start.x) < 2 &&
            start.y > rect.top - frame.top &&
            start.y < rect.bottom - frame.top
          );
        });
        let to = null;
        for (const [key, rect] of recordRects)
          if (
            Math.abs(rect.left - frame.left - end.x) < 2 &&
            end.y > rect.top - frame.top &&
            end.y < rect.bottom - frame.top
          )
            to = key;
        return [from, to === null ? null : to.startsWith("u:") ? "none" : to];
      },
    );
  });
  if (
    JSON.stringify(joined) !==
    JSON.stringify([
      [0, "n:1"],
      [1, "n:2"],
      [2, "n:1"],
      [3, "none"],
    ])
  )
    throw new Error(`The lines join other ends: ${JSON.stringify(joined)}`);
  await showDraft();
  await page.screenshot({
    path: "output/playwright/mail-claim-trace-open.png",
  });

  // Pointing at a claim lights its record and the record's words.
  await claims.getByRole("listitem").nth(2).hover();
  await page.waitForTimeout(200);
  const fromClaim = await lit();
  if (
    JSON.stringify(fromClaim.records) !== '["n:1"]' ||
    fromClaim.lines !== 1 ||
    JSON.stringify((await bodyMarks()).active) !==
      JSON.stringify([
        "your order of 60 ginger financiers",
        "your box leaves our kitchen on Friday",
      ])
  )
    throw new Error(`Pointing at a claim lit: ${JSON.stringify(fromClaim)}`);
  await page.screenshot({
    path: "output/playwright/mail-claim-trace-pointed.png",
  });
  // Pointing at a record lights each of its claims.
  await records.getByRole("listitem").nth(0).hover();
  await page.waitForTimeout(200);
  const fromRecord = await lit();
  if (
    JSON.stringify(fromRecord.claims) !==
      JSON.stringify([
        "your order of 60 ginger financiers",
        "your box leaves our kitchen on Friday",
      ]) ||
    fromRecord.lines !== 2
  )
    throw new Error(`Pointing at a record lit: ${JSON.stringify(fromRecord)}`);
  await page.mouse.move(2, 2);
  // Keyboard focus on the claim with no source lights its card and its words.
  await claims.getByRole("listitem").nth(3).focus();
  const focused = await lit();
  if (
    JSON.stringify(focused.records) !==
      JSON.stringify([
        `u:${await claims
          .getByRole("listitem")
          .nth(3)
          .getAttribute("data-trace-claim")}`,
      ]) ||
    JSON.stringify((await bodyMarks()).active) !==
      JSON.stringify(["We include a free handwritten card with every box."])
  )
    throw new Error(
      `Focus on the unsourced claim lit: ${JSON.stringify(focused)}`,
    );
  await page.keyboard.press("Tab");

  await page.evaluate(function dark() {
    document.documentElement.dataset.portalTheme = "dark";
    document.documentElement.style.colorScheme = "dark";
  });
  await showDraft();
  await page.screenshot({
    path: "output/playwright/mail-claim-trace-dark.png",
  });
  await page.evaluate(function light() {
    document.documentElement.dataset.portalTheme = "light";
    document.documentElement.style.colorScheme = "light";
  });

  // A narrow pane stacks the records under the claims, with no lines.
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(300);
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
    path: "output/playwright/mail-claim-trace-narrow.png",
  });
  await page.setViewportSize(size);

  // Ken: a draft with no source at all.
  await needs.getByRole("button", { name: /Ken/ }).click();
  await draft.getByText(/120 croissants/).waitFor();
  const kenSummary = await summary.locator("p").innerText();
  if (kenSummary !== "The claim has no source. Check it before you approve.")
    throw new Error(`Ken's summary reads: ${kenSummary}`);

  // Mika: a request states no claim, so no summary shows.
  await needs.getByRole("button", { name: /Mika/ }).click();
  await draft.getByText(/Please confirm Friday arrival/).waitFor();
  if ((await summary.count()) !== 0)
    throw new Error("A request was counted as a claim");
  // While Mika's shared draft is edited, a new claim shows at once, and the
  // trace selects its words in the editor.
  await bar.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = draft.getByRole("textbox", {
    name: "Reply message",
    exact: true,
  });
  await draft
    .locator('.mail-reply-draft-status [data-state="synced"]')
    .waitFor();
  const promise = "Your 40 boxes leave our kitchen on Thursday.";
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.pressSequentially(promise);
  await summary.waitFor();
  const edited = await summary.locator("p").innerText();
  if (edited !== "The claim has no source. Check it before you approve.")
    throw new Error(`The edited draft's summary reads: ${edited}`);
  await summary.getByRole("button", { name: "Show sources" }).click();
  await records.getByRole("button", { name: "Select it" }).click();
  const selection = await editor.evaluate(function selected(element) {
    return {
      text: element.value.slice(element.selectionStart, element.selectionEnd),
      focused: document.activeElement === element,
    };
  });
  if (selection.text !== promise || !selection.focused)
    throw new Error(`Select it chose: ${JSON.stringify(selection)}`);
  await showDraft();
  await page.screenshot({
    path: "output/playwright/mail-claim-trace-editing.png",
  });
  await bar.getByRole("button", { name: "Close", exact: true }).click();

  return {
    artifact: "MAIL_CLAIM_TRACE_BROWSER",
    passed: true,
    summaries: { peita: peitaSummary, ken: kenSummary, edited },
    claims: claimed,
    lines: joined,
    stacked,
    screenshots: [
      "output/playwright/mail-claim-trace-open.png",
      "output/playwright/mail-claim-trace-pointed.png",
      "output/playwright/mail-claim-trace-dark.png",
      "output/playwright/mail-claim-trace-narrow.png",
      "output/playwright/mail-claim-trace-editing.png",
    ],
  };
}
