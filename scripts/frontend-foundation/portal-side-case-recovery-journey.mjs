// Bundle to an IIFE, then run reviewSideCaseRecovery(page) with the browser CLI.
// The preview answers requests. The real Portal chooses when and what to send.
export async function reviewSideCaseRecovery(page) {
  const origin = new URL(page.url()).origin;
  const base = `${origin}/chat-preview.html?scenario=side-cases&conversation=conv_00000000-0000-0000-0000-000000000001`;
  const artifacts = "output/playwright/ui-side-case-recovery";
  await page.setViewportSize({ width: 320, height: 1000 });
  const outcomes = [];
  for (const fault of ["reload", "crash", "lost-response"]) {
    await page.goto(base);
    await page.evaluate(resetPreview);
    await page.goto(`${base}&sideFault=once`);
    await page.getByRole("link", { name: "Ask", exact: true }).click();
    let card = page.getByRole("article", {
      name: "Restock butter",
      exact: true,
    });
    await card.waitFor();
    await recordMessages(page, fault === "lost-response");
    const draft = page.getByRole("textbox", { name: "Message" });
    await draft.fill("Keep my separate supplier question.");
    await page.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "separate-question.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("This file belongs to the separate composer draft."),
    });
    await card.getByRole("button", { name: "Do it here", exact: true }).click();
    await card.getByRole("alert").waitFor();
    await card
      .getByRole("button", { name: "Finish here", exact: true })
      .waitFor();
    await card.getByText("In this chat", { exact: true }).waitFor();
    if ((await draft.inputValue()) !== "Keep my separate supplier question.")
      throw new Error("The side Case changed the composer draft.");
    await page
      .getByRole("button", {
        name: "Remove separate-question.txt",
        exact: true,
      })
      .waitFor();
    await card.screenshot({ path: `${artifacts}/${fault}-interrupted.png` });
    const acceptedRequests = await page.evaluate(readRequests);
    if (fault === "crash") {
      const context = page.context();
      const devtools = await context.newCDPSession(page);
      const crashed = page.waitForEvent("crash", { timeout: 10_000 });
      void devtools.send("Page.crash").catch(ignoreCrashDisconnect);
      await crashed;
      await page.close();
      page = await context.newPage();
      await page.setViewportSize({ width: 320, height: 1000 });
      // Restore the preview's accepted server message in a fresh tab.
      // No Portal component state survives the renderer crash.
      await page.addInitScript(restorePreviewMessage, acceptedRequests);
      await page.goto(`${base}&sideFault=once`);
    } else {
      await page.reload();
    }
    card = page.getByRole("article", { name: "Restock butter", exact: true });
    await page.getByRole("link", { name: "Ask", exact: true }).click();
    await card
      .getByRole("button", { name: "Finish here", exact: true })
      .waitFor();
    if (
      await card
        .getByRole("button", { name: "Start in a subthread", exact: true })
        .count()
    )
      throw new Error(
        `${fault}: accepted work can start a duplicate subthread.`,
      );
    await recordMessages(page, false);
    // The local failure fixture resets on reload. Finish still sends no brief.
    await card
      .getByRole("button", { name: "Finish here", exact: true })
      .click();
    await card.getByRole("alert").waitFor();
    await card
      .getByRole("button", { name: "Finish here", exact: true })
      .click();
    await card.getByText("In this chat", { exact: true }).waitFor();
    const requests = await page.evaluate(readRequests);
    await card
      .getByRole("button", { name: "Finish here", exact: true })
      .waitFor({ state: "hidden" });
    if (requests.length !== 1)
      throw new Error(`${fault}: sent the brief ${requests.length} times.`);
    const request = requests[0];
    if (
      request.requestId !== `side_case_here_${"b".repeat(32)}` ||
      request.browserContext.kind !== "unavailable" ||
      request.surfaceContext !== null
    )
      throw new Error(`${fault}: the retry payload depends on browser state.`);
    await card.screenshot({ path: `${artifacts}/${fault}-recovered.png` });
    outcomes.push({
      fault,
      messages: requests.length,
      requestId: request.requestId,
    });
  }
  await page.evaluate(resetPreview);
  return { status: "passed", outcomes, artifacts };
}

function resetPreview() {
  sessionStorage.removeItem("chat-preview-regenerate");
  sessionStorage.removeItem("chat-preview-request-id");
  sessionStorage.removeItem("side-case-recovery-requests");
}

function readRequests() {
  return JSON.parse(
    sessionStorage.getItem("side-case-recovery-requests") ?? "[]",
  );
}

function ignoreCrashDisconnect() {}

function restorePreviewMessage(requests) {
  // Seed once. Later scenarios use this tab with their own fixture data.
  if (sessionStorage.getItem("side-case-recovery-restored") !== null) return;
  sessionStorage.setItem("side-case-recovery-restored", "true");
  const [request] = requests;
  sessionStorage.setItem("chat-preview-regenerate", request.text);
  sessionStorage.setItem("chat-preview-request-id", request.requestId);
  sessionStorage.setItem(
    "side-case-recovery-requests",
    JSON.stringify(requests),
  );
}

async function recordMessages(page, loseResponse) {
  await page.evaluate(`
    window.sideCaseOriginalFetch = window.fetch;
    window.sideCaseLoseResponse = ${loseResponse};
    async function recordSideCaseRequest(input, init) {
      let message = false;
      if (init?.method === 'POST' && typeof init.body === 'string') {
        const command = JSON.parse(init.body);
        if (command.kind === 'message') {
          message = true;
          const requests = JSON.parse(sessionStorage.getItem('side-case-recovery-requests') ?? '[]');
          requests.push(command);
          sessionStorage.setItem('side-case-recovery-requests', JSON.stringify(requests));
        }
      }
      const response = await window.sideCaseOriginalFetch(input, init);
      if (message && window.sideCaseLoseResponse) {
        window.sideCaseLoseResponse = false;
        throw new TypeError('The connection closed after message acceptance.');
      }
      return response;
    }
    window.fetch = recordSideCaseRequest;
  `);
}
