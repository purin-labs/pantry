import { http, type HttpResponseResolver } from "msw";
import { expect, it } from "vitest";
import {
  REGISTER_SURFACE,
  REGISTER_VIEW_COMMANDS,
  newConversationId,
  newProjectId,
  type ConversationId,
  type SurfaceObservationV2,
  parseOrderQueueEntries,
  type PlatformGatewayMessage,
} from "@purin-labs/control-api";
import { parseEnvelope as parseCounterSaleEnvelope } from "@purin-labs/control-api/portal/counter-sale";
import { parseTerminalAssignment } from "@purin-labs/commerce-contracts";
import { isRecord } from "@purin-labs/std";

import { activateTerminalAssignment } from "@purin-labs/area-cafe/server/data/terminal-assignment-store";
import type { ModelRoute } from "@purin-labs/contracts";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { TOOLS } from "../../src/agent-tools/registry";
import {
  COOKIE_ENTRY,
  DRINK_ENTRY,
  MENU_ID,
  OAT_MILK_MOD,
  SQUARE_SANDBOX_APPROVING_DEVICE,
  connectSquareSandbox,
  extractRegister,
  menuLine,
  setupRegisterShop,
} from "./counter-register-support";
import {
  connectGateway,
  credentialOf,
  enrollGateway,
  found,
  helloAndWait,
  send,
} from "./device-fleet-support";
import { organisationDatabase } from "./organisation-database";
import { createBakerySurfaceReceipt } from "@purin-labs/bakery-model/bakery-surface";
import {
  finished,
  lastToolCallName,
  pendingPageCommand,
} from "./chat-journey-support";
import {
  createConversation,
  installMemoryFixture,
  joinMember,
  post,
  storedConversation,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";

it(
  "runs Café › Register as an operator for cash + modifiers + order queue handover, refuses viewer, and keeps Sous Chef free of money movement",
  { timeout: 180_000 },
  operatorCashAndRbacJourney,
);

it(
  "lets an operator stage the Register basket from a private Portal chat, and refuses a viewer and a chat without the Register page",
  { timeout: 240_000 },
  operatorRegisterChatJourney,
);

it(
  "collects FeliCa over GMO stera LAN gateway via DeviceFleetActor, enforces terminal exclusivity and result_unknown lock across socket drop/reconnect, refuses to retire or replace the counter until the sale records the payment, and settles manual cash refund",
  { timeout: 180_000 },
  gmoSteraLanGatewayEndToEndJourney,
);

const REGISTER_BROWSER = "browser-register-operator";
const REGISTER_SESSION = "register-session-1";

/** Café › Register as the operator's browser sends it with a message. */
function registerObservation(basket: string): SurfaceObservationV2 {
  return {
    kind: "surface-observation",
    schemaVersion: 2,
    surface: REGISTER_SURFACE,
    area: "cafe",
    instance: {
      browserInstanceId: REGISTER_BROWSER,
      surfaceSessionId: REGISTER_SESSION,
      epoch: 0,
    },
    title: "Register",
    path: "/portal/shop/cafe/register",
    record: null,
    capturedAt: Date.now(),
    view: [
      {
        title: "Current basket",
        facts: [{ label: "Lines", value: basket }],
        table: null,
      },
    ],
    state: null,
    commands: [...REGISTER_VIEW_COMMANDS],
    sources: [],
  };
}

/**
 * Plan 90 D9: a barista at the counter asks the Portal chat to stage an
 * order, with no grant from the owner. The operator's private chat message
 * carries the Register page, the agent stages two financiers, and the command
 * reaches the operator's Register page, which answers with its receipt. The
 * operator reads the agent's answer through the poll of the chat. A viewer's
 * message is refused, and so is an operator's message that carries no
 * Register page. The operator reads no other person's chat, no shared chat
 * and no list of the chats.
 */
async function operatorRegisterChatJourney(): Promise<void> {
  const { organisationId, author, route, paths } = await installMemoryFixture();
  const operator = await joinMember(
    organisationId,
    "register-barista",
    "operator",
  );
  const viewer = await joinMember(organisationId, "register-viewer", "viewer");
  const offered: string[][] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      stageFinanciers.bind(null, offered),
    ),
  );
  const message = (
    person: Member,
    conversationId: ConversationId,
    observation: SurfaceObservationV2 | undefined,
  ) =>
    post(person, paths.chat, {
      kind: "message",
      conversationId,
      requestId: `request_${conversationId}`,
      model: route.model,
      text: "Two plain financiers, please.",
      browserContext: {
        kind: "available",
        binding: { browserInstanceId: REGISTER_BROWSER, conversationId },
      },
      ...(observation === undefined ? {} : { surfaceObservation: observation }),
    });

  // A viewer cannot use the chat, also from the Register page.
  const refusedViewer = await message(
    viewer,
    newConversationId(),
    registerObservation("Empty"),
  );
  expect(refusedViewer.status).toBe(404);
  expect(await refusedViewer.json()).toMatchObject({
    error: "organisation_role_insufficient",
  });
  // An operator's message with no Register page is refused.
  const refusedOperator = await message(
    operator,
    newConversationId(),
    undefined,
  );
  expect(refusedOperator.status).toBe(404);
  expect(offered).toEqual([]);

  // The operator's private chat message carries the Register page. The agent
  // stages two financiers, and the command reaches the operator's page.
  const chat = newConversationId();
  const sent = await message(operator, chat, registerObservation("Empty"));
  expect(sent.status, await sent.clone().text()).toBe(200);
  const effect = await pendingPageCommand(
    operator,
    paths.chat,
    chat,
    REGISTER_BROWSER,
  );
  expect(effect.command).toMatchObject({
    kind: "page_command",
    surface: REGISTER_SURFACE,
    target: { surfaceSessionId: REGISTER_SESSION, epoch: 0 },
    command: {
      name: "register_add_item",
      menuEntryId: "menu_entry_plain_financier",
      quantity: 2,
    },
    binding: { browserInstanceId: REGISTER_BROWSER, conversationId: chat },
  });
  // The operator's turn offers the four Register commands and no other page
  // command.
  const pageTools = (offered[0] ?? []).filter(
    (name) => name.startsWith("register_") || name.startsWith("costs_"),
  );
  expect(pageTools.sort()).toEqual([...REGISTER_VIEW_COMMANDS].sort());

  // The Register page answers, and the turn ends.
  const receipt = await createBakerySurfaceReceipt(effect, {
    kind: "page_completed",
    observation: registerObservation("2 × Plain financier"),
  });
  const settled = await post(
    operator,
    `${paths.chat}/surface-effects/${effect.effectId}/receipt`,
    { receipt },
  );
  expect(settled.status, await settled.clone().text()).toBe(200);
  await finished(operator, chat);

  // The operator's page polls the chat and reads the agent's answer.
  const state = await post(
    operator,
    `${paths.chat}?view=state&conversation=${chat}`,
    null,
  );
  expect(state.status, await state.clone().text()).toBe(200);
  expect(await state.json()).toMatchObject({ work: { kind: "ready" } });
  const read = await post(operator, `${paths.chat}?conversation=${chat}`, null);
  expect(read.status, await read.clone().text()).toBe(200);
  const thread = (await read.json()) as {
    conversation: { timeline: readonly Record<string, unknown>[] };
    conversations: readonly { id: string }[];
    projectDirectory: readonly unknown[];
  };
  expect(
    thread.conversation.timeline.flatMap((event) =>
      event.kind === "assistant" ? [event.text] : [],
    ),
  ).toEqual([FINANCIERS_STAGED]);
  // The read holds this one chat and no list of the workspace.
  expect(thread.conversations.map((summary) => summary.id)).toEqual([chat]);
  expect(thread.projectDirectory).toEqual([]);

  // The operator reads no other person's chat, no shared chat and no list.
  const ownerChat = newConversationId();
  await createConversation(author, ownerChat, route);
  const shared = await sharedChat(author, operator, route, paths.chat);
  for (const path of [
    `${paths.chat}?conversation=${ownerChat}`,
    `${paths.chat}?view=state&conversation=${ownerChat}`,
    `${paths.chat}?conversation=${shared}`,
    paths.chat,
  ]) {
    const refused = await post(operator, path, null);
    expect(refused.status, path).toBe(404);
  }
  // The owner's shared chat is open to the operator as a Project member, so
  // only the operator rule closes it.
  const ownerRead = await post(
    author,
    `${paths.chat}?conversation=${shared}`,
    null,
  );
  expect(ownerRead.status).toBe(200);
  const viewerRead = await post(
    viewer,
    `${paths.chat}?conversation=${chat}`,
    null,
  );
  expect(viewerRead.status).toBe(404);
}

const FINANCIERS_STAGED = "Two plain financiers are in the basket.";

/**
 * A chat of the owner, shared with a Project of which the operator is an
 * editor: the operator may open it as a member of that Project.
 */
async function sharedChat(
  owner: Member,
  member: Member,
  route: ModelRoute,
  chatPath: string,
): Promise<ConversationId> {
  const projectId = newProjectId();
  const projects = `/v1/control/organisations/${owner.organisationId}/projects`;
  const created = await post(owner, projects, {
    kind: "create_project",
    operationId: crypto.randomUUID(),
    projectId,
    content: { name: "Counter", brief: "The counter team.", references: [] },
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const sharedProject = await post(owner, `${projects}/${projectId}/access`, {
    kind: "share_project",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 0,
    members: [{ userId: member.userId, role: "editor" }],
  });
  expect(sharedProject.status, await sharedProject.clone().text()).toBe(200);
  const conversationId = newConversationId();
  await createConversation(owner, conversationId, route);
  const stored = await storedConversation(owner, conversationId);
  if (stored === null) throw new Error("The shared chat is missing");
  const sharedChat = await post(
    owner,
    `${chatPath}/conversations/${conversationId}/access`,
    {
      kind: "share_conversation",
      operationId: crypto.randomUUID(),
      expectedRevision: stored.revision,
      projectId,
      expectedProjectAccessRevision: 1,
    },
  );
  expect(sharedChat.status, await sharedChat.clone().text()).toBe(200);
  expect(await sharedChat.json()).toMatchObject({ kind: "accepted" });
  return conversationId;
}

/** The scripted model: it stages two financiers in the Register basket. */
async function stageFinanciers(
  offered: string[][],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body) || !Array.isArray(body.messages))
    throw new Error("Invalid model request");
  const names = Array.isArray(body.tools)
    ? body.tools.flatMap((tool: unknown) =>
        isRecord(tool) &&
        isRecord(tool.function) &&
        typeof tool.function.name === "string"
          ? [tool.function.name]
          : [],
      )
    : [];
  offered.push(names);
  const last: unknown = body.messages.at(-1);
  if (
    isRecord(last) &&
    last.role === "tool" &&
    lastToolCallName(body.messages) === "register_add_item"
  )
    return openRouterText(
      FINANCIERS_STAGED,
      `register_reply_${crypto.randomUUID()}`,
    );
  return names.includes("register_add_item")
    ? openRouterToolCall(
        "register_add_item",
        { menuEntryId: "menu_entry_plain_financier", quantity: 2 },
        `register_call_${crypto.randomUUID()}`,
      )
    : openRouterToolCall(
        "tool_search",
        { query: "register_add_item", limit: 4 },
        `register_discover_${crypto.randomUUID()}`,
      );
}

async function operatorCashAndRbacJourney(): Promise<void> {
  const { merchantId, locationId, base, owner, staff, viewer } =
    await setupRegisterShop("reg-cash");

  // 1. Viewer is refused on Register read and mutations.
  const viewerRead = await send(
    `${base}/commerce/counter-register`,
    viewer.session,
    "GET",
  );
  expect(viewerRead.status).toBe(404);
  expect(viewerRead.body).toMatchObject({
    error: "organisation_role_insufficient",
  });

  const viewerOpen = await send(
    `${base}/commerce/counter-sales`,
    viewer.session,
    "POST",
    {
      pantryLocationId: locationId,
      checkoutId: "chk_viewer_blocked",
      tenderMode: "cash",
      lines: [menuLine("l1", COOKIE_ENTRY, [], 1)],
    },
  );
  expect(viewerOpen.status).toBe(404);
  expect(viewerOpen.body).toMatchObject({
    error: "organisation_role_insufficient",
  });

  // 2. Operator loads Café › Register snapshot with published menu, modifiers, and cash enabled.
  const registerResponse = await send(
    `${base}/commerce/counter-register`,
    staff.session,
    "GET",
  );
  expect(registerResponse.status, JSON.stringify(registerResponse.body)).toBe(
    200,
  );
  const register = extractRegister(registerResponse.body);
  expect(register.pantryLocationId).toBe(locationId);
  expect(register.policy?.cashEnabled).toBe(true);
  expect(register.policy?.catalogScope).toMatchObject({
    kind: "published_menu",
    menuId: MENU_ID,
  });
  expect(register.terminal.assigned).toBe(false);
  const allEntries = register.menu?.sections.flatMap((s) => s.entries) ?? [];
  const drink = allEntries.find((e) => e.menuEntryId === DRINK_ENTRY);
  const cookie = allEntries.find((e) => e.menuEntryId === COOKIE_ENTRY);
  expect(drink).toBeDefined();
  expect(cookie).toBeDefined();
  expect(
    drink?.modifierGroups
      .flatMap((g) => g.options)
      .some((o) => o.modifierOptionId === OAT_MILK_MOD),
  ).toBe(true);

  // 3. Operator opens a cash counter sale with cookie + drink + Oat Milk modifier (no terminal bound).
  const checkoutId = `chk_cash_${crypto.randomUUID().slice(0, 8)}`;
  const opened = await send(
    `${base}/commerce/counter-sales`,
    staff.session,
    "POST",
    {
      pantryLocationId: locationId,
      checkoutId,
      tenderMode: "cash",
      lines: [
        menuLine("l_cookie", COOKIE_ENTRY, [], 1),
        menuLine("l_drink", DRINK_ENTRY, [OAT_MILK_MOD], 1),
      ],
    },
  );
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);

  const saleBeforeCash = parseCounterSaleEnvelope(
    (
      await send(
        `${base}/commerce/counter-sales/${checkoutId}`,
        staff.session,
        "GET",
      )
    ).body,
  );
  expect(saleBeforeCash.state).toBe("awaiting_collection");
  expect(saleBeforeCash.quote).not.toBeNull();
  const quote = saleBeforeCash.quote!;
  const totalMinor = quote.amount.amountMinor;
  expect(totalMinor).toBeGreaterThan(0);

  // Viewer is refused on cash settlement.
  const viewerCash = await send(
    `${base}/commerce/counter-sales/${checkoutId}/cash`,
    viewer.session,
    "POST",
    {
      checkoutRevision: quote.checkoutRevision,
      quoteDigest: quote.quoteDigest,
      cashReceived: { amountMinor: 2_000, currency: "JPY" },
    },
  );
  expect(viewerCash.status).toBe(404);
  expect(viewerCash.body).toMatchObject({
    error: "organisation_role_insufficient",
  });

  // 4. Operator settles in cash with ¥2,000; replay with same key returns same receipt.
  const cashIdemp = `cash_${checkoutId}`;
  const cashRes = await send(
    `${base}/commerce/counter-sales/${checkoutId}/cash`,
    staff.session,
    "POST",
    {
      checkoutRevision: quote.checkoutRevision,
      quoteDigest: quote.quoteDigest,
      cashReceived: { amountMinor: 2_000, currency: "JPY" },
    },
    cashIdemp,
  );
  expect(cashRes.status, JSON.stringify(cashRes.body)).toBe(200);
  const paidSale = parseCounterSaleEnvelope(cashRes.body);
  expect(paidSale.state).toBe("complete");
  expect(paidSale.orderId).not.toBeNull();
  expect(paidSale.pickupCode).toMatch(/^[A-Z]-\d{3}$/u);
  expect(paidSale.manualTender).toEqual({
    cashReceivedMinor: 2_000,
    changeDueMinor: 2_000 - totalMinor,
    currency: "JPY",
  });

  const replayCash = await send(
    `${base}/commerce/counter-sales/${checkoutId}/cash`,
    staff.session,
    "POST",
    {
      checkoutRevision: quote.checkoutRevision,
      quoteDigest: quote.quoteDigest,
      cashReceived: { amountMinor: 2_000, currency: "JPY" },
    },
    cashIdemp,
  );
  expect(replayCash.status).toBe(200);
  expect(parseCounterSaleEnvelope(replayCash.body).orderId).toBe(
    paidSale.orderId,
  );

  // 5. Order appears on Café › Order queue with the same pickup code and operator hands it over.
  const queueRes = await send(
    `${base}/commerce/order-queue`,
    staff.session,
    "GET",
  );
  expect(queueRes.status).toBe(200);
  const queueEntries = parseOrderQueueEntries(
    isRecord(queueRes.body) ? queueRes.body.entries : null,
  );
  const matching = queueEntries?.find((e) => e.orderId === paidSale.orderId);
  expect(matching).toBeDefined();
  expect(matching?.code).toBe(paidSale.pickupCode);

  const readyRes = await send(
    `${base}/commerce/order-queue/${matching!.fulfillmentId}/advance`,
    staff.session,
    "POST",
    { action: "ready" },
  );
  expect(readyRes.status, JSON.stringify(readyRes.body)).toBe(200);

  const handoverRes = await send(
    `${base}/commerce/order-queue/${matching!.fulfillmentId}/advance`,
    staff.session,
    "POST",
    { action: "hand_over" },
  );
  expect(handoverRes.status, JSON.stringify(handoverRes.body)).toBe(200);

  const queueAfter = parseOrderQueueEntries(
    isRecord(
      (await send(`${base}/commerce/order-queue`, staff.session, "GET")).body,
    )
      ? (
          (await send(`${base}/commerce/order-queue`, staff.session, "GET"))
            .body as Record<string, unknown>
        ).entries
      : null,
  );
  expect(queueAfter?.some((e) => e.orderId === paidSale.orderId)).toBe(false);

  // 6. Sous Chef safety invariant: read + basket staging only, ZERO money movement tools.
  const toolNames = TOOLS.map((t) => t.name);
  expect(toolNames).toContain("counter_sale_read");
  for (const cmd of REGISTER_VIEW_COMMANDS) {
    expect(toolNames).toContain(cmd);
  }
  const forbiddenMoneyTool = TOOLS.find((t) =>
    /counter_sale_(collect|cash|charge|drawer|refund)|terminal_collect|cash_drawer/u.test(
      t.name,
    ),
  );
  expect(forbiddenMoneyTool).toBeUndefined();

  // Keep owner / merchantId referenced so fixtures stay explicit.
  expect(owner.identity.userId.length).toBeGreaterThan(0);
  expect(merchantId.length).toBeGreaterThan(0);
}

async function gmoSteraLanGatewayEndToEndJourney(): Promise<void> {
  const { organisationId, merchantId, locationId, base, owner, staff } =
    await setupRegisterShop("reg-stera");

  // 1. Enroll a shop gateway for this exact café location and announce a payment_terminal.
  const startedRes = await send(
    `${base}/devices/gateways`,
    owner.session,
    "POST",
    { name: "Counter Gateway", locationId },
  );
  expect(startedRes.status, JSON.stringify(startedRes.body)).toBe(201);
  const startedBody = startedRes.body as { gatewayId: string; code: string };
  const enrolled = await enrollGateway(
    organisationId,
    startedBody.gatewayId,
    startedBody.code,
  );
  const credential = await credentialOf(enrolled);

  const steraDevice = found("stera_lan_1", "Counter stera", {
    kind: "payment_terminal",
    model: "stera terminal",
    capabilities: [
      { id: "collect_payment", label: "Collect payment", revision: 1 },
    ],
  });
  const gateway1 = await connectGateway(credential);
  await helloAndWait(gateway1, [steraDevice]);

  // 2. Bind this café location to the LAN gateway stera terminal in D1.
  const parsedOrgId = parseOrganisationId(organisationId);
  if (!parsedOrgId.ok) throw new Error("Invalid org id");
  const parsedAssignment = parseTerminalAssignment({
    assignmentId: `assign_stera_${crypto.randomUUID().slice(0, 8)}`,
    organisationId,
    merchantId,
    pantryLocationId: locationId,
    providerLocationId: "GMO_STERA_LOC_TOKYO",
    account: {
      integrationAccountId: "gmo_stera_account_1",
      providerAccountId: "gmo_merchant_1",
      environment: "development",
      capabilityRevision: 1,
      country: "JP",
      currency: "JPY",
    },
    target: {
      kind: "lan_gateway_device",
      gatewayId: startedBody.gatewayId,
      deviceSourceKey: "stera_lan_1",
    },
    transport: "lan_gateway",
    adapterVersion: "gmo_stera_lan_v1",
    revision: 1,
    state: { kind: "active" },
  });
  if (!parsedAssignment.ok) {
    throw new Error(
      `Invalid assignment: ${JSON.stringify(parsedAssignment.error)}`,
    );
  }
  const saved = await activateTerminalAssignment({
    db: organisationDatabase(organisationId),
    organisationId: parsedOrgId.value,
    assignment: parsedAssignment.value,
    now: Date.now(),
  });
  expect(saved.ok).toBe(true);
  // Input: the café also connected a Square sandbox account.
  const square = await connectSquareSandbox(
    parsedOrgId.value,
    owner.identity.userId,
  );

  // Verify Register snapshot exposes the gmo_stera LAN terminal.
  const register = extractRegister(
    (await send(`${base}/commerce/counter-register`, staff.session, "GET"))
      .body,
  );
  expect(register.terminal).toMatchObject({
    assigned: true,
    provider: "gmo_stera",
    targetKind: "lan_gateway_device",
    gatewayId: startedBody.gatewayId,
    deviceSourceKey: "stera_lan_1",
    ready: true,
    supportedMethods: ["card", "felica", "qr_code"],
  });

  // 3. Operator opens Sale #1 and dispatches a FeliCa payment to the LAN gateway.
  const checkout1 = `chk_stera_1_${crypto.randomUUID().slice(0, 8)}`;
  const open1 = await send(
    `${base}/commerce/counter-sales`,
    staff.session,
    "POST",
    {
      pantryLocationId: locationId,
      checkoutId: checkout1,
      tenderMode: "terminal",
      lines: [menuLine("l1", COOKIE_ENTRY, [], 1)],
    },
  );
  expect(open1.status, JSON.stringify(open1.body)).toBe(200);
  const sale1 = parseCounterSaleEnvelope(
    (
      await send(
        `${base}/commerce/counter-sales/${checkout1}`,
        staff.session,
        "GET",
      )
    ).body,
  );
  const quote1 = sale1.quote!;

  const collect1 = await send(
    `${base}/commerce/counter-sales/${checkout1}/collection`,
    staff.session,
    "POST",
    {
      pantryLocationId: locationId,
      checkoutRevision: quote1.checkoutRevision,
      quoteDigest: quote1.quoteDigest,
      amount: quote1.amount,
      paymentMethod: "felica",
    },
  );
  expect(collect1.status, JSON.stringify(collect1.body)).toBe(200);

  // Gateway socket receives the real terminal_collect frame!
  await expect
    .poll(() => gateway1.received.some((m) => m.type === "terminal_collect"))
    .toBe(true);
  const collectFrame = gateway1.received.find(
    (m): m is Extract<PlatformGatewayMessage, { type: "terminal_collect" }> =>
      m.type === "terminal_collect",
  )!;
  expect(collectFrame).toMatchObject({
    sourceKey: "stera_lan_1",
    paymentMethod: "felica",
    amountMinor: quote1.amount.amountMinor,
    currency: "JPY",
  });

  // The operator cannot retire the counter while the terminal collects.
  const retirement = `${base}/commerce/terminal-operations/${encodeURIComponent(locationId)}/retirement`;
  const retiredWhileCollecting = await send(
    retirement,
    staff.session,
    "POST",
    {},
  );
  expect(retiredWhileCollecting.status).toBe(409);
  expect(retiredWhileCollecting.body).toMatchObject({
    error: "terminal_collection_unresolved",
  });

  // Nor can the owner replace it with a Square sandbox terminal: the new
  // assignment would retire the stera one, and the capture would never
  // reach the sale. The Register keeps the stera terminal.
  const squareTerminal = {
    pantryLocationId: locationId,
    integrationAccountId: square.integrationAccountId,
    providerLocationId: square.providerLocationId,
    testDeviceId: SQUARE_SANDBOX_APPROVING_DEVICE,
  };
  const replacedWhileCollecting = await send(
    `${base}/commerce/terminal-operations`,
    owner.session,
    "POST",
    squareTerminal,
  );
  expect(replacedWhileCollecting.status).toBe(409);
  expect(replacedWhileCollecting.body).toMatchObject({
    error: "terminal_collection_unresolved",
  });
  expect(
    extractRegister(
      (await send(`${base}/commerce/counter-register`, staff.session, "GET"))
        .body,
    ).terminal,
  ).toMatchObject({ assigned: true, targetKind: "lan_gateway_device" });

  // 4. Exclusivity: second concurrent sale on the same terminal is refused with 409 terminal_busy!
  const checkout2 = `chk_stera_2_${crypto.randomUUID().slice(0, 8)}`;
  await send(`${base}/commerce/counter-sales`, staff.session, "POST", {
    pantryLocationId: locationId,
    checkoutId: checkout2,
    tenderMode: "terminal",
    lines: [menuLine("l2", COOKIE_ENTRY, [], 1)],
  });
  const sale2 = parseCounterSaleEnvelope(
    (
      await send(
        `${base}/commerce/counter-sales/${checkout2}`,
        staff.session,
        "GET",
      )
    ).body,
  );
  const busyRes = await send(
    `${base}/commerce/counter-sales/${checkout2}/collection`,
    staff.session,
    "POST",
    {
      pantryLocationId: locationId,
      checkoutRevision: sale2.quote!.checkoutRevision,
      quoteDigest: sale2.quote!.quoteDigest,
      amount: sale2.quote!.amount,
      paymentMethod: "card",
    },
  );
  expect(busyRes.status).toBe(409);
  expect(busyRes.body).toMatchObject({ error: "terminal_busy" });

  // 5. Socket drops before result -> DeviceFleetActor marks result_unknown and blocks new collections!
  await gateway1.close();
  const gateway2 = await connectGateway(credential);
  await helloAndWait(gateway2, [steraDevice]);

  // On reconnect hello, DeviceFleetActor automatically sends terminal_inquire!
  await expect
    .poll(() =>
      gateway2.received.some(
        (m) =>
          m.type === "terminal_inquire" &&
          m.paymentAttemptId === collectFrame.paymentAttemptId,
      ),
    )
    .toBe(true);

  // While still in result_unknown (before terminal_result arrives), a new sale is STILL blocked!
  const checkout3 = `chk_stera_3_${crypto.randomUUID().slice(0, 8)}`;
  await send(`${base}/commerce/counter-sales`, staff.session, "POST", {
    pantryLocationId: locationId,
    checkoutId: checkout3,
    tenderMode: "terminal",
    lines: [menuLine("l3", COOKIE_ENTRY, [], 1)],
  });
  const sale3 = parseCounterSaleEnvelope(
    (
      await send(
        `${base}/commerce/counter-sales/${checkout3}`,
        staff.session,
        "GET",
      )
    ).body,
  );
  const lockedRes = await send(
    `${base}/commerce/counter-sales/${checkout3}/collection`,
    staff.session,
    "POST",
    {
      pantryLocationId: locationId,
      checkoutRevision: sale3.quote!.checkoutRevision,
      quoteDigest: sale3.quote!.quoteDigest,
      amount: sale3.quote!.amount,
      paymentMethod: "card",
    },
  );
  expect(lockedRes.status).toBe(409);
  expect(lockedRes.body).toMatchObject({ error: "result_unknown" });

  // 6. Gateway answers terminal_inquire with terminal_result (captured FeliCa SUICA, non-refundable via provider).
  gateway2.send({
    type: "terminal_result",
    requestId: collectFrame.requestId,
    sourceKey: "stera_lan_1",
    paymentAttemptId: collectFrame.paymentAttemptId,
    outcome: "captured",
    providerPaymentReference: "stera_tx_felica_99",
    paymentMethod: "felica",
    tenderBrand: "SUICA",
    providerRefundable: false,
    reasonCode: null,
  });

  // The terminal captured the card, but the sale does not record the payment
  // yet: the counter still cannot be retired.
  const retiredBeforeRecord = await send(retirement, staff.session, "POST", {});
  expect(retiredBeforeRecord.status).toBe(409);
  expect(retiredBeforeRecord.body).toMatchObject({
    error: "terminal_collection_unresolved",
  });

  // Give DeviceFleetActor a moment to persist terminal_result, then operator reconciles sale #1.
  let reconciledSale = parseCounterSaleEnvelope(
    (
      await send(
        `${base}/commerce/counter-sales/${checkout1}`,
        staff.session,
        "GET",
      )
    ).body,
  );
  await expect
    .poll(async () => {
      const rec = await send(
        `${base}/commerce/counter-sales/${checkout1}/reconciliation`,
        staff.session,
        "POST",
        {},
      );
      if (rec.status !== 200) return "retry";
      reconciledSale = parseCounterSaleEnvelope(rec.body);
      return reconciledSale.state;
    })
    .toBe("complete");

  expect(reconciledSale.paymentMethod).toBe("felica");
  expect(reconciledSale.tenderBrand).toBe("SUICA");
  expect(reconciledSale.providerRefundable).toBe(false);
  expect(reconciledSale.pickupCode).toMatch(/^[A-Z]-\d{3}$/u);

  // 7. FeliCa refund guard: normal provider refund is refused; operator cannot run manual cash refund; owner succeeds!
  const refusedProviderRefund = await send(
    `${base}/commerce/counter-sales/${checkout1}/refund`,
    owner.session,
    "POST",
    {},
  );
  expect(refusedProviderRefund.status).toBe(409);

  const operatorManualRefund = await send(
    `${base}/commerce/counter-sales/${checkout1}/manual-cash-refund`,
    staff.session,
    "POST",
    { reason: "Operator should not be allowed" },
  );
  expect(operatorManualRefund.status).toBe(404);
  expect(operatorManualRefund.body).toMatchObject({
    error: "organisation_role_insufficient",
  });

  const ownerManualRefund = await send(
    `${base}/commerce/counter-sales/${checkout1}/manual-cash-refund`,
    owner.session,
    "POST",
    { reason: "Refunded Suica payment in cash at counter" },
  );
  expect(ownerManualRefund.status, JSON.stringify(ownerManualRefund.body)).toBe(
    200,
  );
  const refundedSale = parseCounterSaleEnvelope(ownerManualRefund.body);
  expect(refundedSale.afterSale?.refundState).toBe("completed");

  // 8. The sale records the payment, so the owner moves the counter to the
  // Square sandbox terminal. The operator then retires the counter, and the
  // Register shows no terminal.
  const replaced = await send(
    `${base}/commerce/terminal-operations`,
    owner.session,
    "POST",
    squareTerminal,
  );
  expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
  expect(
    extractRegister(
      (await send(`${base}/commerce/counter-register`, staff.session, "GET"))
        .body,
    ).terminal,
  ).toMatchObject({ assigned: true, targetKind: "sandbox_simulated" });
  const retired = await send(retirement, staff.session, "POST", {});
  expect(retired.status, JSON.stringify(retired.body)).toBe(200);
  const afterRetirement = extractRegister(
    (await send(`${base}/commerce/counter-register`, staff.session, "GET"))
      .body,
  );
  expect(afterRetirement.terminal).toMatchObject({ assigned: false });

  await gateway2.close();
}
