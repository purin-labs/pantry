// Local Chat fixtures only. This journey sends no message to an external service.
async function reviewChatDecisions(page) {
  const origin = new URL(page.url()).origin;
  const base = `${origin}/chat-preview.html?scenario=drafts&conversation=conv_00000000-0000-0000-0000-000000000001`;
  const artifacts = "output/playwright/ui-chat-decisions";
  await page.setViewportSize({ width: 320, height: 1000 });
  for (const fault of ["email-read", "slack-read"]) {
    await page.goto(`${base}&draftFault=${fault}`);
    await page.getByRole("link", { name: "Ask", exact: true }).click();
    const card = page.getByRole("article", {
      name: fault === "email-read" ? "Email" : "Slack message",
      exact: true,
    });
    await card
      .getByRole("button", { name: "Try again", exact: true })
      .waitFor();
    await card.screenshot({ path: `${artifacts}/${fault}-recovery.png` });
    await card.getByRole("button", { name: "Try again", exact: true }).click();
    await card.getByRole("button", { name: "Edit", exact: true }).waitFor();
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await card.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    const focused = await page.evaluate(
      "document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.closest('.draft-message-edit') !== null",
    );
    if (!focused)
      throw new Error("Opening the draft editor did not focus its message.");
    await card
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Unsaved local draft that Cancel must discard.");
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    const restored = await page.evaluate(
      "document.activeElement?.textContent?.trim() === 'Edit'",
    );
    if (!restored)
      throw new Error("Cancelling the draft did not restore Edit focus.");
    if ((await card.innerText()).includes("Unsaved local draft"))
      throw new Error("Cancelled edits replaced the draft body.");
  }

  await page.goto(`${base}&draftFault=write`);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  for (const title of ["Email", "Slack message"]) {
    const card = page.getByRole("article", { name: title, exact: true });
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    const text = `Local ${title} revision with a long supplier reference: autumn-butter-delivery-confirmation-2026.`;
    await card
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(text);
    await card
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await card.getByRole("alert").waitFor();
    const errorFocused = await page.evaluate(
      "document.activeElement?.getAttribute('role') === 'alert' && document.activeElement.getBoundingClientRect().top >= 0 && document.activeElement.getBoundingClientRect().bottom <= innerHeight",
    );
    if (!errorFocused)
      throw new Error(`${title} failure did not focus its visible error.`);
    if (
      (await card
        .getByRole("textbox", { name: "Message", exact: true })
        .inputValue()) !== text
    )
      throw new Error(`${title} lost edits after a refused save.`);
    const within = await page.evaluate(
      "Array.from(document.querySelectorAll('.draft-message-edit textarea, .draft-message-edit button')).every(e => e.getBoundingClientRect().right <= e.closest('.draft-message').getBoundingClientRect().right && e.getBoundingClientRect().left >= e.closest('.draft-message').getBoundingClientRect().left)",
    );
    if (!within) throw new Error(`${title} editor exceeds the narrow card.`);
    await card
      .getByRole("button", { name: "Save changes", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${artifacts}/${title.toLowerCase().replaceAll(" ", "-")}-failed-edit.png`,
    });
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
  }

  await page.goto(base);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  for (const title of ["Email", "Slack message"]) {
    const card = page.getByRole("article", { name: title, exact: true });
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    const updated = `Please confirm Thursday delivery at 15:00. Saved ${title} revision.`;
    await card
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(updated);
    await card
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await card.getByRole("button", { name: "Edit", exact: true }).waitFor();
    await card.getByText(updated, { exact: true }).waitFor();
    await page.waitForFunction(
      "document.activeElement?.matches('article.draft-message')",
    );
    await card.screenshot({
      path: `${artifacts}/${title.toLowerCase().replaceAll(" ", "-")}-saved.png`,
    });
  }

  const cases = [
    { name: "sending", query: "slackState=sending" },
    { name: "sent", query: "slackState=sent&emailState=sent" },
    { name: "expired", query: "slackState=expired&emailState=expired" },
    { name: "rejected", query: "slackState=rejected&emailState=rejected" },
    { name: "send-failed", query: "slackState=send_failed" },
    { name: "target-changed", query: "emailPreview=target_changed" },
    { name: "revoked", query: "emailState=revoked" },
    {
      name: "unconfirmed",
      query: "emailState=send_indeterminate&draftFault=write",
    },
    { name: "attested-absent", query: "emailState=operator_attested_absent" },
    { name: "viewer", query: "chatRole=viewer" },
  ];
  const reviewed = [];
  for (const state of cases) {
    await page.goto(`${base}&${state.query}`);
    await page.getByRole("link", { name: "Ask", exact: true }).click();
    const slack = page.getByRole("article", {
      name: "Slack message",
      exact: true,
    });
    const email = page.getByRole("article", { name: "Email", exact: true });
    await slack.waitFor();
    await page.waitForTimeout(800);
    if (
      ["sending", "sent", "expired", "rejected", "viewer"].includes(
        state.name,
      ) &&
      (await slack.getByRole("button", { name: "Send", exact: true }).count())
    )
      throw new Error(`${state.name} still offers Slack Send.`);
    if (
      state.name === "sending" &&
      (await slack.getByRole("status").first().textContent()) !== "Sending"
    )
      throw new Error("In-flight Slack draft is not labeled Sending.");
    if (
      state.name === "viewer" &&
      (await email.getByRole("button", { name: "Send", exact: true }).count())
    )
      throw new Error("Chat viewer can send email.");
    if (state.name === "unconfirmed") {
      await email
        .getByRole("button", { name: "Found in Sent Mail", exact: true })
        .click();
      await email.getByRole("alert").waitFor();
      if (
        await email.getByRole("button", { name: "Send", exact: true }).count()
      )
        throw new Error("An uncertain email send offers Send again.");
    }
    await slack.screenshot({ path: `${artifacts}/slack-${state.name}.png` });
    await email.screenshot({ path: `${artifacts}/email-${state.name}.png` });
    reviewed.push(state.name);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  const slack = page.getByRole("article", {
    name: "Slack message",
    exact: true,
  });
  await slack.getByRole("button", { name: "Show more", exact: true }).click();
  await page.evaluate("document.documentElement.dataset.portalTheme = 'dark'");
  await slack.screenshot({ path: `${artifacts}/slack-expanded-dark.png` });
  await slack.getByRole("button", { name: "Show less", exact: true }).click();
  return {
    status: "passed",
    draftReadRecovery: "passed",
    editorFocusAndCancel: "passed",
    successfulSaveAndFocus: "passed",
    failedEditPreservesInput: "passed",
    sendingAndViewerActions: "passed",
    states: reviewed,
    artifacts,
  };
}
