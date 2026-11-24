// Run after mount-browser-fixture.js in the same Playwright CLI session.
// Plan 83: email and WhatsApp in one list. A member reads what waits for an
// owner or an admin. A person approves a WhatsApp draft, a send that the
// window or a change of owner stops says why,
// the next conversation opens, a composer reply takes the Case, the agent's
// section and a closed Case in Done show, a refused number asks for a grant, the agent setting
// saves, and with no agent a person writes the email reply.
// Screenshots go to output/playwright/one-inbox-*.png; the result is the record.
async function verifyOneInbox(page) {
  const inbox = page.getByRole("region", { name: "Mail inbox", exact: true });
  const needs = page.getByRole("list", {
    name: "Waiting for you",
    exact: true,
  });
  const conversation = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  const title = conversation.locator("#mail-case-title");
  const bar = conversation.getByRole("group", {
    name: "Draft reply actions",
    exact: true,
  });
  async function names() {
    return needs.locator(".mail-case-row-name").allInnerTexts();
  }
  async function actions() {
    return page.evaluate("window.mailFixtureWhatsAppState.actions");
  }
  // The Portal Select (foundation/ui/select.tsx) is a button with role
  // combobox that opens a listbox popup. Choose by { value }, { label } or
  // { index }. { values } sets the items of a multiple Select, then Escape
  // closes its popup.
  async function chooseOption(page, trigger, choice) {
    await trigger.click();
    const popup = page.locator('.pantry-select-popup[data-open]');
    await popup.waitFor();
    const items = popup.locator('.pantry-select-item');
    if ("values" in choice) {
      const wanted = choice.values.map(String);
      for (const item of await items.all()) {
        const chosen = wanted.includes(await item.getAttribute("data-value"));
        const selected = (await item.getAttribute("aria-selected")) === "true";
        if (chosen !== selected) await item.click();
      }
      await page.keyboard.press("Escape");
    } else if ("value" in choice) {
      await popup
        .locator(
          `.pantry-select-item[data-value=${JSON.stringify(String(choice.value))}]`,
        )
        .click();
    } else if ("label" in choice) {
      await popup.getByRole("option", { name: choice.label, exact: true }).click();
    } else {
      await items.nth(choice.index).click();
    }
    await popup.waitFor({ state: "hidden" });
  }

  await page.evaluate(function seed() {
    const now = Date.now();
    const hour = 3_600_000;
    const open = now + 20 * hour;
    const conversation = (
      caseId,
      customerWaId,
      state,
      preview,
      since,
      extra,
    ) => ({
      integrationAccountId: "wa-account-1",
      caseId,
      customerWaId,
      proposalId: null,
      preview,
      ownership: "agent_active",
      state,
      waitingSince: since,
      serviceWindowExpiresAt: open,
      ...extra,
    });
    const message = (id, direction, text, at) => ({
      providerMessageId: id,
      direction,
      text,
      occurredAt: at,
    });
    const openCase = (caseId, customerWaId, messages, extra) => ({
      caseId,
      customerWaId,
      ownership: { kind: "agent_active" },
      handoffRequestedAt: null,
      handoffReason: null,
      serviceWindowExpiresAt: open,
      messages,
      ...extra,
    });
    window.mailFixtureDrafts = "three";
    window.mailFixtureWhatsApp = {
      kind: "read",
      truncated: false,
      refused: null,
      conversations: [
        conversation(
          "case-pickup",
          "+819000004412",
          "reply_waiting",
          "Can I move my Saturday pickup to 4 pm?",
          now - 3 * hour,
          { proposalId: "proposal-pickup" },
        ),
        conversation(
          "case-allergy",
          "+818000002087",
          "handoff_requested",
          "Does the gift box contain nuts?",
          now - 1 * hour,
        ),
        conversation(
          "case-hours",
          "+817000009931",
          "agent_handled",
          "Are you open on Monday?",
          now - hour / 2,
        ),
        conversation(
          "case-old",
          "+819000007720",
          "closed",
          null,
          now - 40 * hour,
          {
            serviceWindowExpiresAt: now - hour,
          },
        ),
      ],
    };
    window.mailFixtureWhatsAppState = {
      actions: [],
      cases: {
        "case-pickup": openCase("case-pickup", "+819000004412", [
          message(
            "wamid.1",
            "inbound",
            "Can I move my Saturday pickup to 4 pm?",
            now - 3 * hour,
          ),
        ]),
        "case-allergy": openCase(
          "case-allergy",
          "+818000002087",
          [
            message(
              "wamid.2",
              "inbound",
              "Does the gift box contain nuts?",
              now - hour,
            ),
          ],
          {
            handoffRequestedAt: now - hour,
            handoffReason: "An allergy question needs a person.",
          },
        ),
        "case-hours": openCase("case-hours", "+817000009931", [
          message(
            "wamid.3",
            "inbound",
            "Are you open on Monday?",
            now - hour / 2,
          ),
          message("wamid.4", "outbound", "Yes, from 8:00.", now - hour / 3),
        ]),
      },
      proposals: {
        "proposal-pickup": {
          version: 1,
          caseId: "case-pickup",
          customerWaId: "+819000004412",
          body: "Hi, yes. We moved your pickup to Saturday at 4 pm.",
          serviceWindowExpiresAt: open,
        },
      },
      account: {
        integration_account_id: "wa-account-1",
        waba_id: "4100",
        phone_number_id: "5100",
        display_phone_number: "+15550001111",
        verified_name: "Shop",
        selected_at: now - 1000,
        provider_health: { kind: "healthy" },
        policy: {
          kind: "enabled",
          policyVersion: 1,
          maxActiveCases: 5,
          maxMessagesPerHour: 60,
          dailyAgentTokenBudget: 200000,
          maxMessageBytes: 4096,
          maxActiveCaseMessages: 40,
          maxActiveCaseBytes: 65536,
          debounceSeconds: 15,
          relevantMessageTopics: "orders",
          automaticAcknowledgementText: "Thanks.",
          agentMode: "answer",
          alwaysWaitTopics: "allergy",
        },
        binding: null,
        runtime: null,
      },
    };
    window.mailInboxRender({ key: "one-inbox" });
  });
  await needs.getByRole("button").nth(4).waitFor();

  // Both channels stand in one list, the longest wait first.
  const merged = await names();
  if (
    merged[0] !== "Mika · Packaging supplier" ||
    !merged.includes("+819000004412") ||
    !merged.includes("+818000002087") ||
    merged.includes("+817000009931") ||
    merged.includes("+819000007720")
  )
    throw new Error(`The list does not merge the channels: ${merged}`);
  await inbox.getByText(/^5 decisions need you\./).waitFor();
  await page.screenshot({ path: "output/playwright/one-inbox-list.png" });

  // A member who is not an owner or admin reads the same count. It names
  // what waits: drafts, WhatsApp conversations and mail with no reply.
  await page.evaluate(function asMember() {
    window.mailInboxRender({ key: "one-inbox-member", canManage: false });
  });
  await inbox
    .getByText("5 conversations wait for an owner or an admin.", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({ path: "output/playwright/one-inbox-member.png" });
  await page.evaluate(function asOwner() {
    window.mailInboxRender({ key: "one-inbox" });
  });
  await needs.getByRole("button").nth(4).waitFor();

  // The channel filter narrows the same list.
  const channel = page.getByRole("combobox", { name: "Channel", exact: true });
  await chooseOption(page, channel, { value: "whatsapp" });
  if ((await names()).length !== 2)
    throw new Error("The WhatsApp filter did not narrow the list");
  await chooseOption(page, channel, { value: "email" });
  if ((await names()).some((name) => name.startsWith("+")))
    throw new Error("The email filter shows WhatsApp");
  await chooseOption(page, channel, { value: "all" });

  // A WhatsApp row opens beside the list with the limits that it must state.
  await needs.getByRole("button", { name: /\+819000004412/ }).click();
  await title.getByText("+819000004412", { exact: true }).waitFor();
  await conversation
    .getByText("Can I move my Saturday pickup to 4 pm?", { exact: true })
    .waitFor();
  await conversation
    .getByText(/Purin keeps WhatsApp text for up to 24 hours/)
    .waitFor();
  if ((await page.evaluate("location.search")) !== "?case=case-pickup")
    throw new Error("The address does not name the open Case");
  await bar.waitFor();
  await page.screenshot({ path: "output/playwright/one-inbox-whatsapp.png" });

  // The arrows follow the list across the channels.
  await conversation
    .getByRole("button", { name: "Next conversation", exact: true })
    .click();
  await title.getByText("40 more croissants on Tuesday").waitFor();
  await conversation
    .getByRole("button", { name: "Previous conversation", exact: true })
    .click();
  await title.getByText("+819000004412", { exact: true }).waitFor();
  await bar.waitFor();

  // Edit makes a new version. Approval names the version that the person saw.
  await bar.getByRole("button", { name: "Edit", exact: true }).click();
  await conversation
    .getByRole("textbox", { name: "Reply message", exact: true })
    .fill("Yes. Your pickup is at 4 pm on Saturday.");
  await bar.getByRole("button", { name: "Save draft", exact: true }).click();
  await conversation
    .getByText("Yes. Your pickup is at 4 pm on Saturday.", { exact: true })
    .waitFor();
  await bar
    .getByRole("button", { name: "Approve and send", exact: true })
    .click();
  // The next conversation that needs a person opens.
  await title.getByText("+818000002087", { exact: true }).waitFor();
  const afterApprove = await actions();
  if (
    !afterApprove.includes("edit:proposal-pickup:") ||
    !afterApprove.includes("approve:proposal-pickup:2")
  )
    throw new Error(`The approval did not name version 2: ${afterApprove}`);
  await conversation
    .getByText(
      "The agent asked for a person: An allergy question needs a person.",
    )
    .waitFor();

  // The composer is one person action: it takes the Case, then sends.
  await conversation
    .getByRole("textbox", { name: "Your reply" })
    .fill("This box contains hazelnuts.");
  await conversation.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(function sent() {
    return window.mailFixtureWhatsAppState.actions.includes(
      "human-reply:case-allergy",
    );
  });
  const afterReply = await actions();
  if (
    afterReply.indexOf("take-over:case-allergy") === -1 ||
    afterReply.indexOf("take-over:case-allergy") >
      afterReply.indexOf("human-reply:case-allergy")
  )
    throw new Error(`The composer did not take the Case first: ${afterReply}`);

  // A section lists what the agent answered, below what waits.
  const views = page.getByRole("group", { name: "Other views", exact: true });
  await page
    .getByRole("list", {
      name: "The agent answered",
      exact: true,
    })
    .getByRole("button", { name: /\+817000009931/ })
    .click();
  await title.getByText("+817000009931", { exact: true }).waitFor();

  // The conversation's menu takes the Case and says what closing it costs.
  await conversation
    .getByRole("button", { name: "Conversation options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: /^Close Case.*Purin deletes its text/ })
    .waitFor();
  await page.getByRole("menuitem", { name: /^Take over/ }).click();
  await page.waitForFunction(function tookOver() {
    return window.mailFixtureWhatsAppState.actions.includes(
      "take-over:case-hours",
    );
  });
  await conversation
    .getByRole("button", { name: "Conversation options", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /^Return to agent/ }).click();
  await page.waitForFunction(function returned() {
    return window.mailFixtureWhatsAppState.actions.includes(
      "return-to-agent:case-hours",
    );
  });

  // A closed Case is done. It has no text, and the pane says why.
  await views.getByRole("button", { name: "Done", exact: true }).click();
  const handled = page.getByRole("list", {
    name: "WhatsApp conversations that are done",
    exact: true,
  });
  await handled.getByRole("button", { name: /\+819000007720/ }).click();
  await conversation
    .getByText(/This conversation is closed\. Purin deleted its text\./)
    .waitFor();

  // A failed source names itself, and the other source stays.
  await page.evaluate(function failEmail() {
    window.mailFixtureEmailFailed = true;
    window.mailInboxRender({ key: "one-inbox-email-failed" });
  });
  await page
    .getByText("Email could not load. Other channels still show here.", {
      exact: true,
    })
    .waitFor();
  // The page renders again, so it opens on the Inbox.
  await page
    .getByRole("list", { name: "The agent answered", exact: true })
    .getByText("+817000009931")
    .waitFor();
  await page.evaluate(function restoreEmail() {
    window.mailFixtureEmailFailed = false;
  });

  // A number that the person may not read asks for the grant in the page.
  await page.evaluate(function refuse() {
    window.mailFixtureWhatsApp = {
      ...window.mailFixtureWhatsApp,
      conversations: [],
      refused: {
        capabilityId: "whatsapp.support.read",
        capabilityVersion: 1,
        label: "Read active WhatsApp support Cases",
        description: "Read bounded active WhatsApp support messages.",
        mode: "enabled",
        grant: null,
      },
    };
    window.mailInboxRender({ key: "one-inbox-refused" });
  });
  await page
    .getByText("You cannot read this WhatsApp number yet.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Request access", exact: true })
    .click();
  await page.getByRole("dialog").first().waitFor();
  await page.keyboard.press("Escape");

  // The agent setting: email cannot answer alone, WhatsApp can hold each reply.
  await page.evaluate(function restore() {
    window.mailFixtureWhatsApp = {
      ...window.mailFixtureWhatsApp,
      refused: null,
    };
    window.mailInboxRender({ key: "one-inbox-setting" });
  });
  await page
    .getByRole("button", { name: "Agent setting", exact: true })
    .click();
  const sheet = page.getByRole("dialog", {
    name: "How should the agent help?",
  });
  await sheet.waitFor();
  const emailAnswers = sheet.getByRole("button", { name: /^Agent answers/ });
  if (!(await emailAnswers.isDisabled()))
    throw new Error("Agent answers is not locked for email");
  await sheet.getByRole("button", { name: "WhatsApp", exact: true }).click();
  await sheet.getByRole("button", { name: /^Agent drafts/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "output/playwright/one-inbox-setting.png" });
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(function saved() {
    return window.mailFixtureWhatsAppState.actions.includes("agent:draft");
  });

  // With no agent, new mail lists itself, and a person writes the reply.
  await page.evaluate(function noAgent() {
    window.mailReplyState = "rejected";
    window.mailFixtureDrafts = undefined;
    window.mailFixtureUnanswered = [
      {
        integrationAccountId: "mailbox-a",
        threadId: "thread-1",
        senderName: "Mika",
        subject: "Packaging delivery delayed",
        receivedAt: Date.now() - 3_600_000,
      },
    ];
    window.mailFixtureWhatsApp = { kind: "none" };
    window.mailInboxRender({ key: "one-inbox-no-agent" });
  });
  await needs.getByRole("button", { name: /Mika/ }).click();
  // The reply stands open as an email composer. Escape there keeps the
  // reply, and the toolbar's formats reach the sent document.
  const reply = conversation.getByRole("textbox", { name: "Your reply" });
  await reply.click();
  await page.keyboard.type("Friday is fine, ");
  const toolbar = conversation.getByRole("toolbar", { name: "Formatting" });
  await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
  await page.keyboard.type("thank you");
  await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
  await page.keyboard.type(".");
  await page.keyboard.press("Enter");
  await toolbar.getByRole("button", { name: "Bulleted list" }).click();
  await page.keyboard.type("Pastry boxes");
  await page.keyboard.press("Escape");
  await reply.waitFor();
  // A file goes with the reply; a program file stays out and says why.
  const files = conversation.locator('input[type="file"]');
  await files.setInputFiles([
    {
      name: "delivery-note.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 delivery note"),
    },
    {
      name: "tool.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("MZ"),
    },
  ]);
  await conversation
    .getByRole("list", { name: "Attachments" })
    .getByText("delivery-note.pdf", { exact: true })
    .waitFor();
  await conversation
    .getByText("Gmail does not send this type of file: tool.exe.", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({
    path: "output/playwright/one-inbox-person-reply.png",
  });
  await conversation.getByRole("button", { name: "Send", exact: true }).click();
  await inbox
    .locator(".mail-case-empty")
    .getByText("Nothing waits for you.", { exact: true })
    .waitFor();
  const personReplies = await page.evaluate("window.mailPersonReplies");
  const blocks = personReplies[0]?.document?.blocks ?? [];
  if (
    personReplies.length !== 1 ||
    personReplies[0].threadId !== "thread-1" ||
    personReplies[0].body !== "Friday is fine, thank you.\n- Pastry boxes" ||
    !blocks[0]?.runs?.some(
      (run) => run.text === "thank you" && run.bold === true,
    ) ||
    blocks[1]?.kind !== "list" ||
    blocks[1]?.ordered !== false ||
    personReplies[0].attachments?.length !== 1 ||
    personReplies[0].attachments[0].name !== "delivery-note.pdf" ||
    personReplies[0].attachments[0].type !== "application/pdf" ||
    atob(personReplies[0].attachments[0].data) !== "%PDF-1.4 delivery note"
  )
    throw new Error(
      `The person reply is wrong: ${JSON.stringify(personReplies)}`,
    );

  // Mail that waits for nobody shows under Other mail. A no-reply sender gets
  // no reply box, and a long tracking address shows as its host.
  const tracking =
    "https://c.gle/AGSJxQx7SXRvhVEXu02ErhDGzlKKJDAmdlH4TV3O-L-coijrbFnV1_uzRJD4Xepz";
  await page.evaluate(function otherMail(address) {
    window.mailFixtureOtherMail = [
      {
        messageId: "message-billing",
        threadId: "thread-billing",
        from: "Google Payments <payments-noreply@google.com>",
        subject: "Your billing account is moving to threshold billing",
        receivedAt: Date.now() - 600_000,
        unread: true,
        body: `Your account is on a monthly billing cycle.\n\nRead the Terms of Service<${address}> before the change.`,
      },
    ];
    window.mailInboxRender({ key: "one-inbox-other-mail" });
  }, tracking);
  const other = page.getByRole("list", { name: "Other mail", exact: true });
  await other.getByRole("button", { name: /Google Payments/ }).click();
  await title.getByText(/threshold billing/).waitFor();
  const link = conversation.getByRole("link", { name: "c.gle", exact: true });
  await link.waitFor();
  await conversation
    .getByText("This sender does not take replies.", { exact: true })
    .waitFor();
  if (
    (await link.getAttribute("href")) !== tracking ||
    (await conversation.getByText(/AGSJxQx7/).count()) !== 0 ||
    (await conversation
      .getByRole("textbox", { name: "Your reply" })
      .count()) !== 0
  )
    throw new Error("A no-reply sender shows a reply box or a long address");
  // Mika's thread has a decided draft and no newer mail, so it is done.
  if (
    (await other.getByRole("button").count()) !== 1 ||
    (await other.getByRole("button", { name: /Mika/ }).count()) !== 0
  )
    throw new Error("A decided thread shows again in Other mail");
  await page.screenshot({ path: "output/playwright/one-inbox-other-mail.png" });

  // A send that Pantry stops says why: the 24-hour window ended, or the
  // conversation changed owner. Neither asks for a retry that cannot work.
  await page.evaluate(function stoppedSends() {
    const now = Date.now();
    const open = now + 20 * 3_600_000;
    const state = window.mailFixtureWhatsAppState;
    window.mailFixtureWhatsApp = {
      kind: "read",
      truncated: false,
      refused: null,
      conversations: [],
    };
    const stopped = [
      ["case-late", "+819000003301", { kind: "service_window_closed" }],
      [
        "case-moved",
        "+819000003302",
        { kind: "refused", reason: "ownership_conflict" },
      ],
    ];
    for (const [caseId, customerWaId, answer] of stopped) {
      const text = `Is my order ready? (${caseId})`;
      window.mailFixtureWhatsApp.conversations.push({
        integrationAccountId: "wa-account-1",
        caseId,
        customerWaId,
        proposalId: `proposal-${caseId}`,
        preview: text,
        ownership: "agent_active",
        state: "reply_waiting",
        waitingSince: now - 60_000,
        serviceWindowExpiresAt: open,
      });
      state.cases[caseId] = {
        caseId,
        customerWaId,
        ownership: { kind: "agent_active" },
        handoffRequestedAt: null,
        handoffReason: null,
        serviceWindowExpiresAt: open,
        messages: [
          {
            providerMessageId: `wamid.${caseId}`,
            direction: "inbound",
            text,
            occurredAt: now - 60_000,
          },
        ],
      };
      state.proposals[`proposal-${caseId}`] = {
        version: 1,
        caseId,
        customerWaId,
        body: "Yes, it is ready.",
        serviceWindowExpiresAt: open,
        answer,
      };
    }
    window.mailInboxRender({ key: "one-inbox-stopped" });
  });
  for (const [customer, reason] of [
    [
      "+819000003301",
      "The 24-hour window has ended, so this reply was not sent.",
    ],
    [
      "+819000003302",
      "This conversation changed owner, so the reply was not sent.",
    ],
  ]) {
    await needs
      .getByRole("button", { name: new RegExp(`\\${customer}`) })
      .click();
    await title.getByText(customer, { exact: true }).waitFor();
    await bar
      .getByRole("button", { name: "Approve and send", exact: true })
      .click();
    await conversation.getByRole("alert").filter({ hasText: reason }).waitFor();
    if ((await conversation.getByText(/Try again/).count()) !== 0)
      throw new Error(`A stopped send asks for a retry: ${customer}`);
  }
  await page.screenshot({
    path: "output/playwright/one-inbox-stopped-send.png",
  });

  return {
    artifact: "ONE_INBOX_BROWSER",
    passed: true,
    merged,
    actions: await actions(),
    personReplies,
    screenshots: [
      "output/playwright/one-inbox-list.png",
      "output/playwright/one-inbox-member.png",
      "output/playwright/one-inbox-whatsapp.png",
      "output/playwright/one-inbox-setting.png",
      "output/playwright/one-inbox-person-reply.png",
      "output/playwright/one-inbox-other-mail.png",
      "output/playwright/one-inbox-stopped-send.png",
    ],
  };
}
