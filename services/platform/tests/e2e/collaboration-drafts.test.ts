import { requireOrganisationBootstrap } from "../organisation-execution-fixture";
import { fixtureDatabase } from "./organisation-database";
import { admitOperatorControlTurnFixture } from "../organisation-execution-fixture";
import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import {
  EmailDraftDoc,
  type EmailDraftStateVector,
  type EmailDraftUpdate,
} from "@seams/email-draft-crdt";
import {
  encodeEmailDraftClientMessage,
  parseEmailDraftServerMessage,
  type EmailDraftServerMessage,
} from "@seams/email-draft-crdt/protocol";
import {
  MenuDraftDoc,
  type MenuDraftStateVector,
  type MenuDraftUpdate,
} from "@seams/menu-draft-crdt";
import {
  encodeMenuDraftClientMessage,
  parseMenuDraftServerMessage,
  type MenuDraftParticipant,
  type MenuDraftServerMessage,
} from "@seams/menu-draft-crdt/protocol";

import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import type { OrganisationDO } from "../../src/actors/organisation";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import type { OrganisationId } from "../../src/ids";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";
import { organisationBootstrapMutation } from "../control-mutation-fixture";
import {
  PUBLIC_ORIGIN,
  closeSocket,
  controlReadHeaders,
  createControlClient,
  dueSocketSweepNow,
  expectPong,
  nextCloseCode,
  openSocket,
  type ControlClient,
} from "./hibernatable-socket-support";
import { requiredPlacement } from "./slack-journey-support";
import type { Variant } from "@seams/type-utils";

const TEST_PLACEMENT = requiredPlacement();

type CollaborationScenario = Readonly<{
  organisationId: OrganisationId;
  owner: ControlClient;
  editor: ControlClient;
  organisation: DurableObjectStub<OrganisationDO>;
}>;

it(
  "persists concurrent email drafting, agent receipts, and frozen review snapshots",
  emailDraftJourney,
);
it(
  "persists a structured menu snapshot after synchronized editing",
  menuDraftJourney,
);
it(
  "keeps menu sockets open while the Organisation sleeps, and sweeps revoked and silent sockets",
  menuRoomHibernationJourney,
);

async function emailDraftJourney({ task }: TestContext): Promise<void> {
  const scenario = await installCollaborationScenario("email");
  await expectSharedThreadFailure(
    scenario,
    "not a URL",
    422,
    "draft_thread_link_invalid",
  );
  await expectSharedThreadFailure(
    scenario,
    "https://example.slack.com/archives/C1234567890/p1789012345123456",
    409,
    "draft_thread_unavailable",
  );
  await expect(
    scenario.organisation.readEmailDraft({
      organisationId: scenario.organisationId,
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: { kind: "not_started", revision: 0 },
  });
  const ownerSocket = await openSocket(
    emailSocketUrl(scenario.organisationId),
    scenario.owner.session,
  );
  let editorSocket = await openSocket(
    emailSocketUrl(scenario.organisationId),
    scenario.editor.session,
  );
  const ownerDoc = requiredEmailDocument();
  const editorDoc = requiredEmailDocument();
  try {
    const [ownerSync, editorSync] = await Promise.all([
      requestEmailSync(ownerSocket, ownerDoc),
      requestEmailSync(editorSocket, editorDoc),
    ]);
    applyEmailUpdate(ownerDoc, ownerSync.missingUpdate);
    applyEmailUpdate(editorDoc, editorSync.missingUpdate);
    const beforeNoOp = await scenario.organisation.readEmailDraft({
      organisationId: scenario.organisationId,
    });
    if (!beforeNoOp.ok || beforeNoOp.value.kind !== "active") {
      throw new Error("email draft was not initialized");
    }
    const noOp = ownerDoc.syncUpdate(ownerSync.serverStateVector);
    if (!noOp.ok) throw new Error(noOp.error.code);
    const noOpAck = nextEmailMessage(ownerSocket, isEmailAccepted);
    ownerSocket.send(
      encodeEmailDraftClientMessage({
        kind: "submit_update",
        updateId: "email-no-op-sync",
        update: noOp.value,
      }),
    );
    await noOpAck;
    await expect(
      scenario.organisation.readEmailDraft({
        organisationId: scenario.organisationId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: "active", revision: beforeNoOp.value.revision },
    });
    const ownerUpdate = requiredEmailUpdate(
      ownerDoc.edit("subject", "Friday menu"),
    );
    const editorUpdate = requiredEmailUpdate(
      editorDoc.edit("body", "Fresh pastries are ready."),
    );
    const ownerAck = nextEmailMessage(ownerSocket, isEmailAccepted);
    const editorAck = nextEmailMessage(editorSocket, isEmailAccepted);
    const ownerBroadcast = nextEmailMessage(ownerSocket, isEmailBroadcast);
    const editorBroadcast = nextEmailMessage(editorSocket, isEmailBroadcast);
    ownerSocket.send(
      encodeEmailDraftClientMessage({
        kind: "submit_update",
        updateId: "email-owner",
        update: ownerUpdate,
      }),
    );
    editorSocket.send(
      encodeEmailDraftClientMessage({
        kind: "submit_update",
        updateId: "email-editor",
        update: editorUpdate,
      }),
    );
    await Promise.all([ownerAck, editorAck]);
    const [ownerRemote, editorRemote] = await Promise.all([
      ownerBroadcast,
      editorBroadcast,
    ]);
    if (
      ownerRemote.kind !== "update_broadcast" ||
      editorRemote.kind !== "update_broadcast"
    ) {
      throw new Error("email updates were not broadcast");
    }
    applyEmailUpdate(ownerDoc, ownerRemote.update);
    applyEmailUpdate(editorDoc, editorRemote.update);
    expect(ownerDoc.read()).toEqual(editorDoc.read());

    await closeSocket(editorSocket);
    requiredEmailUpdate(editorDoc.edit("preview", "Order for Saturday pickup"));
    editorSocket = await openSocket(
      emailSocketUrl(scenario.organisationId),
      scenario.editor.session,
    );
    const reconnect = await requestEmailSync(editorSocket, editorDoc);
    applyEmailUpdate(editorDoc, reconnect.missingUpdate);
    const offlineUpdate = editorDoc.syncUpdate(reconnect.serverStateVector);
    if (!offlineUpdate.ok) throw new Error(offlineUpdate.error.code);
    const offlineAck = nextEmailMessage(editorSocket, isEmailAccepted);
    const ownerOfflineBroadcast = nextEmailMessage(
      ownerSocket,
      isEmailBroadcast,
    );
    editorSocket.send(
      encodeEmailDraftClientMessage({
        kind: "submit_update",
        updateId: "email-offline-reconnect",
        update: offlineUpdate.value,
      }),
    );
    await Promise.all([offlineAck, ownerOfflineBroadcast]);

    const current = await scenario.organisation.readEmailDraft({
      organisationId: scenario.organisationId,
    });
    if (!current.ok || current.value.kind !== "active")
      throw new Error("email draft was not active");
    await fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'draft-origin-fixture', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(Date.now(), scenario.organisationId)
      .run();
    const execution = await admitOperatorControlTurnFixture(
      env,
      scenario.organisationId,
      scenario.editor.identity.userId,
      scenario.editor.session.session.controlSessionId,
    );
    const editRequest = {
      agent: { sessionId: execution.sessionId, displayName: "Menu editor" },
      organisationId: scenario.organisationId,
      request: {
        field: "subject" as const,
        oldText: "Friday",
        newText: "Weekend",
        expectedRevision: current.value.revision,
      },
      operationId: "email-agent-operation",
      execution,
      userId: scenario.editor.identity.userId,
      deadlineAt: Date.now() + 60_000,
    };
    const ownerAgentBroadcast = nextEmailMessage(ownerSocket, isEmailBroadcast);
    const editorAgentBroadcast = nextEmailMessage(
      editorSocket,
      isEmailBroadcast,
    );
    await expect(
      scenario.organisation.editEmailDraft({
        ...editRequest,
        agent: { sessionId: "wrong-session", displayName: "Other agent" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "access_revoked" } });
    const edited = await scenario.organisation.editEmailDraft(editRequest);
    expect(edited).toMatchObject({
      ok: true,
      value: {
        kind: "active",
        draft: {
          subject: "Weekend menu",
          preview: "Order for Saturday pickup",
          body: "Fresh pastries are ready.",
        },
      },
    });
    await Promise.all([ownerAgentBroadcast, editorAgentBroadcast]);
    await expect(
      scenario.organisation.editEmailDraft(editRequest),
    ).resolves.toEqual(edited);
    await expect(
      scenario.organisation.editEmailDraft({
        ...editRequest,
        request: { ...editRequest.request, newText: "Monday" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "operation_conflict" },
    });
    await expect(
      scenario.organisation.editEmailDraft({
        ...editRequest,
        operationId: "email-agent-stale",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "revision_conflict" },
    });

    const concurrent = await concurrentEmailAgents(scenario, ownerSocket);
    Object.assign(task.meta, { concurrentEmailAgents: concurrent });
    const review = await postReview(
      emailReviewUrl(scenario.organisationId),
      scenario.owner.session,
    );
    expect(review).toMatchObject({
      ok: true,
      value: {
        documentId: "active",
        draft: {
          subject: "Weekend menu",
          preview: "Order for Sunday pickup",
          body: "Warm pastries are ready.",
        },
      },
    });
    await evictDurableObject(scenario.organisation);
    const restored = await requireActiveOrganisationActor({
      env,
      organisationId: scenario.organisationId,
      now: Date.now(),
    });
    await expect(restored.editEmailDraft(editRequest)).resolves.toEqual(edited);
    Object.assign(task.meta, {
      receiptAfterEviction: "same original receipt; later edits preserved",
    });
    await expect(
      restored.readEmailDraft({ organisationId: scenario.organisationId }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "active",
        draft: {
          subject: "Weekend menu",
          preview: "Order for Sunday pickup",
          body: "Warm pastries are ready.",
        },
      },
    });
  } finally {
    ownerDoc.destroy();
    editorDoc.destroy();
    await closeSocket(ownerSocket);
    await closeSocket(editorSocket);
  }
}

async function expectSharedThreadFailure(
  scenario: CollaborationScenario,
  threadUrl: string,
  status: number,
  code: string,
): Promise<void> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${scenario.organisationId}/collaboration/email-draft/shared-thread`,
    {
      method: "PUT",
      headers: {
        ...controlReadHeaders(scenario.owner.session),
        Origin: PUBLIC_ORIGIN,
        "content-type": "application/json",
        "x-satyr-csrf": scenario.owner.session.csrfToken,
      },
      body: JSON.stringify({ threadUrl }),
    },
  );
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: code,
  });
}

async function menuDraftJourney(): Promise<void> {
  const scenario = await installCollaborationScenario("menu");
  const socket = await openSocket(
    menuSocketUrl(scenario.organisationId),
    scenario.owner.session,
  );
  const document = requiredMenuDocument();
  try {
    const sync = await requestMenuSync(socket, document);
    applyMenuUpdate(document, sync.missingUpdate);
    expect(document.read().sections).toEqual([
      { id: "section_main", title: "Menu", order: 0 },
    ]);
    const sectionUpdate = requiredMenuUpdate(
      document.addSection({
        id: "section_pastries",
        title: "Pastries",
        order: 1,
      }),
    );
    await submitMenuUpdate(socket, "menu-section", sectionUpdate);
    const itemUpdate = requiredMenuUpdate(
      document.addItem({
        id: "item_croissant",
        productId: "product_croissant",
        displayName: "Butter croissant",
        description: "Flaky and warm",
        placement: { sectionId: "section_pastries", order: 0 },
      }),
    );
    await submitMenuUpdate(socket, "menu-item", itemUpdate);
    const review = await postReview(
      menuReviewUrl(scenario.organisationId),
      scenario.owner.session,
    );
    expect(review).toMatchObject({
      ok: true,
      value: {
        documentId: "cafe-menu",
        draft: {
          sections: expect.arrayContaining([
            { id: "section_pastries", title: "Pastries", order: 1 },
          ]),
          items: [{ id: "item_croissant", productId: "product_croissant" }],
        },
      },
    });
    const savedVector = document.stateVector();
    if (!savedVector.ok) throw new Error(savedVector.error.code);
    for (let index = 1; index < 200; index++) {
      requiredMenuUpdate(
        document.addItem({
          id: `item_${index}`,
          productId: `product_${index}`,
          displayName: "Name ".repeat(200),
          description: "Description ".repeat(83),
          placement: { sectionId: "section_main", order: index },
        }),
      );
    }
    await submitMenuUpdate(
      socket,
      "large-menu",
      requiredMenuUpdate(document.syncUpdate(savedVector.value)),
    );
  } finally {
    document.destroy();
    await closeSocket(socket);
  }

  await evictDurableObject(scenario.organisation);
  const response = await exports.default.fetch(
    menuSnapshotUrl(scenario.organisationId),
    {
      headers: controlReadHeaders(scenario.owner.session),
    },
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    value: {
      draft: {
        items: expect.arrayContaining([
          {
            id: "item_croissant",
            productId: "product_croissant",
            displayName: "Butter croissant",
            description: "Flaky and warm",
            placement: { sectionId: "section_pastries", order: 0 },
          },
        ]),
      },
    },
  });
  const reconnected = await openSocket(
    menuSocketUrl(scenario.organisationId),
    scenario.owner.session,
  );
  const replica = requiredMenuDocument();
  try {
    const sync = await requestMenuSync(reconnected, replica);
    applyMenuUpdate(replica, sync.missingUpdate);
    expect(replica.read().items).toHaveLength(200);
    expect(replica.read().items[0]?.description).toBe(
      "Description ".repeat(83),
    );
  } finally {
    replica.destroy();
    await closeSocket(reconnected);
  }
}

async function menuRoomHibernationJourney(): Promise<void> {
  const scenario = await installCollaborationScenario("sleep");
  const url = menuSocketUrl(scenario.organisationId);
  const owner = await openSocket(url, scenario.owner.session);
  const editor = await openSocket(url, scenario.editor.session);
  const silent = await openSocket(url, scenario.owner.session);
  const ownerDoc = requiredMenuDocument();
  const editorDoc = requiredMenuDocument();
  const silentDoc = requiredMenuDocument();
  try {
    const ownerSync = await requestMenuSync(owner, ownerDoc);
    applyMenuUpdate(ownerDoc, ownerSync.missingUpdate);
    const editorSync = await requestMenuSync(editor, editorDoc);
    applyMenuUpdate(editorDoc, editorSync.missingUpdate);
    const silentSync = await requestMenuSync(silent, silentDoc);

    // An open room keeps one sweep due, and the Organisation's alarm holds it.
    const opened = await runInDurableObject(
      scenario.organisation,
      readSocketSweep,
    );
    expect(opened.dueAt).not.toBeNull();
    expect(opened.dueAt).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(opened.alarmAt).not.toBeNull();
    expect(opened.alarmAt).toBeLessThanOrEqual(opened.dueAt ?? 0);

    const selected = nextMenuMessage(editor, (message) =>
      hasSelection(message, ownerSync.sessionId, "section_main"),
    );
    owner.send(
      encodeMenuDraftClientMessage({
        kind: "presence_update",
        state: "editing",
        selection: { kind: "section", sectionId: "section_main" },
      }),
    );
    await selected;

    // The Organisation leaves memory. Its sockets stay open.
    await evictDurableObject(scenario.organisation);
    expect([owner, editor, silent].map(socketState)).toEqual([
      WebSocket.OPEN,
      WebSocket.OPEN,
      WebSocket.OPEN,
    ]);
    await expectPong(editor);

    // The first edit after the wake reaches the other editor.
    const broadcast = nextMenuMessage(editor, isMenuBroadcast);
    await submitMenuUpdate(
      owner,
      "after-wake",
      requiredMenuUpdate(
        ownerDoc.addSection({
          id: "section_drinks",
          title: "Drinks",
          order: 1,
        }),
      ),
    );
    const received = await broadcast;
    if (received.kind !== "update_broadcast")
      throw new Error("menu edit was not broadcast");
    applyMenuUpdate(editorDoc, received.update);
    expect(editorDoc.read().sections).toContainEqual({
      id: "section_drinks",
      title: "Drinks",
      order: 1,
    });

    // Presence after the wake comes from the socket attachments.
    const restored = nextMenuMessage(editor, (message) =>
      hasPointer(message, ownerSync.sessionId),
    );
    owner.send(
      encodeMenuDraftClientMessage({
        kind: "pointer_update",
        position: { x: 0.5, y: 0.25 },
      }),
    );
    const presence = await restored;
    expect(participant(presence, ownerSync.sessionId)).toMatchObject({
      state: "editing",
      selection: { kind: "section", sectionId: "section_main" },
      pointer: { position: { x: 0.5, y: 0.25 } },
    });

    // While the room sleeps, the editor loses access and the second owner tab
    // stops sending. The sweep closes both and keeps the answering owner.
    await evictDurableObject(scenario.organisation);
    await revokeMembership(
      scenario.organisationId,
      scenario.editor.identity.userId,
    );
    await expectPong(owner);
    await runInDurableObject(
      scenario.organisation,
      ageSocket.bind(null, silentSync.sessionId),
    );
    const revoked = nextMenuMessage(editor, isMenuFailure);
    const silentClosed = nextCloseCode(silent);
    const remaining = nextMenuMessage(
      owner,
      (message) =>
        message.kind === "presence_changed" &&
        message.participants.length === 1,
    );
    expect(await runDurableObjectAlarm(scenario.organisation)).toBe(true);
    await expect(revoked).resolves.toMatchObject({
      kind: "failure",
      code: "access_revoked",
    });
    await silentClosed;
    const alone = await remaining;
    expect(
      alone.kind === "presence_changed"
        ? alone.participants.map((entry) => entry.sessionId)
        : [],
    ).toEqual([ownerSync.sessionId]);
    const swept = await runInDurableObject(
      scenario.organisation,
      readSocketSweep,
    );
    expect(swept.dueAt).toBeGreaterThan(Date.now() + 290_000);

    // With no socket open, the next sweep ends the sweeps.
    await closeSocket(owner);
    await runInDurableObject(scenario.organisation, dueSocketSweepNow);
    expect(await runDurableObjectAlarm(scenario.organisation)).toBe(true);
    await expect(
      runInDurableObject(scenario.organisation, readSocketSweep),
    ).resolves.toMatchObject({ dueAt: null });
  } finally {
    ownerDoc.destroy();
    editorDoc.destroy();
    silentDoc.destroy();
    await Promise.all([owner, editor, silent].map(closeSocket));
  }
}

async function readSocketSweep(
  _instance: OrganisationDO,
  state: DurableObjectState,
): Promise<Readonly<{ dueAt: number | null; alarmAt: number | null }>> {
  const row = state.storage.sql
    .exec<{ due_at: number }>(
      "SELECT due_at FROM hibernatable_socket_sweep WHERE singleton = 1",
    )
    .toArray()[0];
  return {
    dueAt: row?.due_at ?? null,
    alarmAt: await state.storage.getAlarm(),
  };
}

// The time that passes while a client stays silent: its last message becomes
// old, and it never pinged. The sweep then sees it as lost.
async function ageSocket(
  sessionId: string,
  _instance: OrganisationDO,
  state: DurableObjectState,
): Promise<void> {
  for (const socket of state.getWebSockets()) {
    const attachment: unknown = socket.deserializeAttachment();
    if (
      typeof attachment === "object" &&
      attachment !== null &&
      "sessionId" in attachment &&
      attachment.sessionId === sessionId
    )
      socket.serializeAttachment({
        ...attachment,
        lastMessageAt: Date.now() - 100_000,
      });
  }
  await dueSocketSweepNow(_instance, state);
}

function socketState(socket: WebSocket): number {
  return socket.readyState;
}

function participant(
  message: MenuDraftServerMessage,
  sessionId: string,
): MenuDraftParticipant | undefined {
  return message.kind === "presence_changed"
    ? message.participants.find((entry) => entry.sessionId === sessionId)
    : undefined;
}

function hasSelection(
  message: MenuDraftServerMessage,
  sessionId: string,
  sectionId: string,
): boolean {
  const selection = participant(message, sessionId)?.selection;
  return selection?.kind === "section" && selection.sectionId === sectionId;
}

function hasPointer(
  message: MenuDraftServerMessage,
  sessionId: string,
): boolean {
  return (participant(message, sessionId)?.pointer ?? null) !== null;
}

function isMenuBroadcast(message: MenuDraftServerMessage): boolean {
  return message.kind === "update_broadcast";
}

function isMenuFailure(message: MenuDraftServerMessage): boolean {
  return message.kind === "failure";
}

async function revokeMembership(
  organisationId: OrganisationId,
  userId: string,
): Promise<void> {
  await fixtureDatabase()
    .prepare(
      `UPDATE service_role_grant
        SET status = 'revoked', revoked_at = ?
      WHERE organisation_id = ? AND user_id = ?`,
    )
    .bind(Date.now(), organisationId, userId)
    .run();
}

async function installCollaborationScenario(
  label: string,
): Promise<CollaborationScenario> {
  const now = Date.now() - 1_000;
  const owner = await createControlClient(
    `collaboration-${label}-owner`,
    `${label} Owner`,
  );
  const editor = await createControlClient(
    `collaboration-${label}-editor`,
    `${label} Editor`,
  );
  const created = await requireOrganisationBootstrap({
    env,
    owner: owner.identity,
    organisationName: `Collaboration ${label}`,
    environment: "development",
    placement: TEST_PLACEMENT,
    mutation: organisationBootstrapMutation(owner.identity, now),
    now,
  });
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(
        created.organisationId,
        `person_collaboration_${label}`,
        editor.identity.displayName,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant
        (organisation_id, user_id, person_id, role, status, created_at, revoked_at)
       VALUES (?, ?, ?, 'operator', 'active', ?, NULL)`,
      )
      .bind(
        created.organisationId,
        editor.identity.userId,
        `person_collaboration_${label}`,
        now,
      ),
  ]);
  await attachSharedAccountNativeOrganisation({
    organisationId: created.organisationId,
    owner,
    members: { operator: editor },
  });
  await ensureCreatedOrganisationActor({
    env,
    organisationId: created.organisationId,
    now,
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: created.organisationId,
    now,
  });
  return {
    organisationId: created.organisationId,
    owner,
    editor,
    organisation,
  };
}

function requestEmailSync(
  socket: WebSocket,
  document: EmailDraftDoc,
): Promise<Variant<EmailDraftServerMessage, "sync_response">> {
  const response = nextEmailMessage(socket, isEmailSync);
  socket.send(
    encodeEmailDraftClientMessage({
      kind: "sync_request",
      stateVector: requiredEmailVector(document),
    }),
  );
  return response.then(requireEmailSync);
}

function requestMenuSync(
  socket: WebSocket,
  document: MenuDraftDoc,
): Promise<Variant<MenuDraftServerMessage, "sync_response">> {
  const response = nextMenuMessage(socket, isMenuSync);
  socket.send(
    encodeMenuDraftClientMessage({
      kind: "sync_request",
      stateVector: requiredMenuVector(document),
    }),
  );
  return response.then(requireMenuSync);
}

async function submitMenuUpdate(
  socket: WebSocket,
  updateId: string,
  update: MenuDraftUpdate,
): Promise<void> {
  const accepted = nextMenuMessage(socket, isMenuAccepted);
  socket.send(
    encodeMenuDraftClientMessage({ kind: "submit_update", updateId, update }),
  );
  await expect(accepted).resolves.toMatchObject({
    kind: "update_accepted",
    updateId,
  });
}

function nextEmailMessage(
  socket: WebSocket,
  accept: (message: EmailDraftServerMessage) => boolean,
): Promise<EmailDraftServerMessage> {
  return nextMessage(socket, parseEmailDraftServerMessage, accept);
}

function nextMenuMessage(
  socket: WebSocket,
  accept: (message: MenuDraftServerMessage) => boolean,
): Promise<MenuDraftServerMessage> {
  return nextMessage(socket, parseMenuDraftServerMessage, accept);
}

function nextMessage<Message>(
  socket: WebSocket,
  parse: (
    frame: unknown,
  ) => Readonly<{ ok: true; value: Message }> | Readonly<{ ok: false }>,
  accept: (message: Message) => boolean,
): Promise<Message> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      const parsed = parse(event.data);
      if (!parsed.ok || !accept(parsed.value)) return;
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      resolve(parsed.value);
    };
    const onClose = (): void => {
      socket.removeEventListener("message", onMessage);
      reject(
        new Error("collaboration socket closed before its expected message"),
      );
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
  });
}

async function postReview(
  url: string,
  session: IssuedControlSession,
): Promise<unknown> {
  const response = await exports.default.fetch(url, {
    method: "POST",
    headers: {
      ...controlReadHeaders(session),
      Origin: PUBLIC_ORIGIN,
      "content-type": "application/json",
      "x-satyr-csrf": session.csrfToken,
    },
    body: "{}",
  });
  expect(response.status).toBe(200);
  return response.json();
}

function requiredEmailDocument(): EmailDraftDoc {
  const result = EmailDraftDoc.create();
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function requiredMenuDocument(): MenuDraftDoc {
  return MenuDraftDoc.createReplica();
}

function requiredEmailUpdate(
  result: ReturnType<EmailDraftDoc["edit"]>,
): EmailDraftUpdate {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function requiredMenuUpdate(
  result:
    | ReturnType<MenuDraftDoc["addSection"]>
    | ReturnType<MenuDraftDoc["addItem"]>,
): MenuDraftUpdate {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function requiredEmailVector(document: EmailDraftDoc): EmailDraftStateVector {
  const result = document.stateVector();
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function requiredMenuVector(document: MenuDraftDoc): MenuDraftStateVector {
  const result = document.stateVector();
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function applyEmailUpdate(
  document: EmailDraftDoc,
  update: EmailDraftUpdate,
): void {
  const result = document.apply(update);
  if (!result.ok) throw new Error(result.error.code);
}

function applyMenuUpdate(
  document: MenuDraftDoc,
  update: MenuDraftUpdate,
): void {
  const result = document.apply(update);
  if (!result.ok) throw new Error(result.error.code);
}

function requireEmailSync(
  message: EmailDraftServerMessage,
): Variant<EmailDraftServerMessage, "sync_response"> {
  if (message.kind !== "sync_response")
    throw new Error("email sync response missing");
  return message;
}

function requireMenuSync(
  message: MenuDraftServerMessage,
): Variant<MenuDraftServerMessage, "sync_response"> {
  if (message.kind !== "sync_response")
    throw new Error("menu sync response missing");
  return message;
}

function isEmailSync(message: EmailDraftServerMessage): boolean {
  return message.kind === "sync_response";
}
function isEmailAccepted(message: EmailDraftServerMessage): boolean {
  return message.kind === "update_accepted";
}
function isEmailBroadcast(message: EmailDraftServerMessage): boolean {
  return message.kind === "update_broadcast";
}
function isMenuSync(message: MenuDraftServerMessage): boolean {
  return message.kind === "sync_response";
}
function isMenuAccepted(message: MenuDraftServerMessage): boolean {
  return message.kind === "update_accepted";
}

function emailSocketUrl(organisationId: OrganisationId): string {
  return `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/collaboration/email-draft/socket`;
}

function emailReviewUrl(organisationId: OrganisationId): string {
  return `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/collaboration/email-draft/review`;
}

function menuSocketUrl(organisationId: OrganisationId): string {
  return `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/collaboration/menu-draft/socket`;
}

function menuReviewUrl(organisationId: OrganisationId): string {
  return `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/collaboration/menu-draft/review`;
}

function menuSnapshotUrl(organisationId: OrganisationId): string {
  return `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/collaboration/menu-draft`;
}

async function concurrentEmailAgents(
  scenario: CollaborationScenario,
  socket: WebSocket,
) {
  const [firstSession, secondSession] = await Promise.all([
    issueControlSession({
      db: env.DB,
      userId: scenario.editor.identity.userId,
      now: Date.now(),
      ttlMs: 60000,
    }),
    issueControlSession({
      db: env.DB,
      userId: scenario.editor.identity.userId,
      now: Date.now(),
      ttlMs: 60000,
    }),
  ]);
  const [firstExecution, secondExecution] = await Promise.all([
    admitEmailAgent(scenario, firstSession),
    admitEmailAgent(scenario, secondSession),
  ]);
  const current = await scenario.organisation.readEmailDraft({
    organisationId: scenario.organisationId,
  });
  if (!current.ok || current.value.kind !== "active")
    throw new Error("Missing concurrent draft");
  const first = emailAgentRequest(
    scenario,
    firstExecution,
    "Pickup editor",
    "preview",
    "Saturday",
    "Sunday",
    current.value.revision,
  );
  const second = emailAgentRequest(
    scenario,
    secondExecution,
    "Copy editor",
    "body",
    "Fresh",
    "Warm",
    current.value.revision,
  );
  const observer = new EmailAgentObserver(socket);
  try {
    const results = await Promise.all([
      scenario.organisation.editEmailDraft(first),
      scenario.organisation.editEmailDraft(second),
    ]);
    expect(results.filter(successfulEmailEdit)).toHaveLength(1);
    const latest = await scenario.organisation.readEmailDraft({
      organisationId: scenario.organisationId,
    });
    if (!latest.ok || latest.value.kind !== "active")
      throw new Error("Missing accepted concurrent draft");
    const refused = results[0].ok ? second : first;
    const retry = emailAgentRequest(
      scenario,
      refused.execution,
      refused.agent.displayName,
      refused.request.field,
      refused.request.oldText,
      refused.request.newText,
      latest.value.revision,
    );
    const accepted = await scenario.organisation.editEmailDraft(retry);
    expect(accepted).toMatchObject({
      ok: true,
      value: {
        draft: {
          preview: "Order for Sunday pickup",
          body: "Warm pastries are ready.",
        },
      },
    });
    const replays = await Promise.all([
      scenario.organisation.editEmailDraft(retry),
      scenario.organisation.editEmailDraft(retry),
    ]);
    expect(replays).toEqual([accepted, accepted]);
    expect(observer.invalidFrames).toBe(0);
    const visibleNames = observer.frames.flat().map(agentName);
    expect(visibleNames).toContain("Pickup editor");
    expect(visibleNames).toContain("Copy editor");
    await expect
      .poll(() => observer.frames.at(-1), { timeout: 15_000 })
      .toEqual([]);
    return {
      actors: [first.agent.displayName, second.agent.displayName],
      concurrentRequests: true,
      maximumVisibleCursors: Math.max(...observer.frames.map(agentCount)),
      staleEdit: "refused then reread",
      replay: "same receipt",
      final: accepted,
    };
  } finally {
    observer.close();
  }
}

function admitEmailAgent(
  scenario: CollaborationScenario,
  session: IssuedControlSession,
) {
  return admitOperatorControlTurnFixture(
    env,
    scenario.organisationId,
    scenario.editor.identity.userId,
    session.session.controlSessionId,
  );
}

function emailAgentRequest(
  scenario: CollaborationScenario,
  execution: Awaited<ReturnType<typeof admitEmailAgent>>,
  displayName: string,
  field: "subject" | "preview" | "body",
  oldText: string,
  newText: string,
  expectedRevision: number,
): import("../../src/actors/email-draft").EmailDraftAgentEdit {
  return {
    agent: { sessionId: execution.sessionId, displayName },
    organisationId: scenario.organisationId,
    execution,
    operationId: `concurrent-${field}`,
    userId: scenario.editor.identity.userId,
    deadlineAt: Date.now() + 60000,
    request: { field, oldText, newText, expectedRevision },
  };
}

function successfulEmailEdit(
  result: Awaited<
    ReturnType<DurableObjectStub<OrganisationDO>["editEmailDraft"]>
  >,
): boolean {
  return result.ok;
}
function agentName(
  activity: import("@seams/collaboration").CollaborationAgentActivity,
): string {
  return activity.agent.displayName;
}
function agentCount(
  agents: readonly import("@seams/collaboration").CollaborationAgentActivity[],
): number {
  return agents.length;
}

class EmailAgentObserver {
  invalidFrames = 0;
  readonly frames: (readonly import("@seams/collaboration").CollaborationAgentActivity[])[] =
    [];
  readonly receive = this.message.bind(this);
  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", this.receive);
  }
  message(event: MessageEvent): void {
    const parsed = parseEmailDraftServerMessage(event.data);
    if (!parsed.ok) this.invalidFrames++;
    if (parsed.ok && parsed.value.kind === "presence_changed")
      this.frames.push(parsed.value.agents);
  }
  close(): void {
    this.socket.removeEventListener("message", this.receive);
  }
}
