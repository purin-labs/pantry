import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import {
  ProductDescriptionDoc,
  type ProductDescriptionUpdate,
} from "@purin-labs/product-description-crdt";
import {
  encodeDraftClientMessage,
  parseDraftServerMessage,
  type DraftServerMessage,
} from "@purin-labs/product-description-crdt/protocol";

import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { opaqueSubjectReference } from "../../src/access-control/references";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import { createGrant, enableCapability } from "./access-route-support";
import { installMemoryFixture, type Member } from "./memory-support";
import { installProductSource } from "./product-source-support";

declare module "vitest" {
  interface TaskMeta {
    descriptionDraftReconnect?: Record<string, unknown>;
  }
}

/**
 * The product description editor stays live through Access changes and
 * comes back after an access check that could not run.
 *
 * The owner and an admin have a product's description draft open. The owner
 * turns a capability on and adds two grants, as Allow in a permission prompt
 * does; the owner's next edit is accepted and reaches the admin. Then one
 * access check of the owner's socket cannot run, as when a database write
 * fails. The room closes the socket without a final failure, so the editor
 * does not stop. The owner's client reconnects, syncs and sends its unsent
 * edit again; the edit is accepted, and the draft holds both edits. A refused
 * access check still ends a socket with a final failure; the draft safety
 * journey covers that.
 */
it(
  "keeps the description editor live through Access changes and reconnects it after an access check that could not run",
  draftReconnectJourney,
  180_000,
);

const PRODUCT_ID = "product_draft_reconnect_e2e";
const MERCHANT_ID = "merchant_bakery_c3_draft_reconnect";
const INITIAL = "Freshly baked croissant.";
const AFTER_ACCESS = "Freshly baked croissant. Baked at dawn.";
const UNSENT = "Freshly baked croissant. Baked at dawn with cultured butter.";

type Editor = {
  socket: WebSocket;
  readonly doc: ProductDescriptionDoc;
  readonly received: DraftServerMessage[];
  closed: boolean;
};

async function draftReconnectJourney({ task }: TestContext): Promise<void> {
  const { author, reviewer } = await installMemoryFixture();
  await installProductSource({
    organisationId: author.organisationId,
    ownerUserId: author.userId,
    merchantId: MERCHANT_ID,
    productId: PRODUCT_ID,
    description: INITIAL,
  });
  const owner = await openEditor(author, newDocument());
  const admin = await openEditor(reviewer, newDocument());
  expect(owner.doc.read()).toBe(INITIAL);

  // 1. Access changes as Allow makes them; the editor stays live.
  await allowLikeAPrompt(author);
  await submit(owner, edit(owner.doc, AFTER_ACCESS));
  await expect.poll(admin.doc.read.bind(admin.doc)).toBe(AFTER_ACCESS);

  // 2. One access check cannot run: the socket closes without a failure.
  const unsent = edit(owner.doc, UNSENT);
  await failAccessChecks(author.organisationId);
  owner.socket.send(
    encodeDraftClientMessage({
      kind: "submit_update",
      updateId: crypto.randomUUID(),
      update: unsent,
    }),
  );
  await expect.poll(() => owner.closed, { timeout: 15_000 }).toBe(true);
  await restoreAccessChecks(author.organisationId);
  expect(owner.received.filter(isFailure)).toEqual([]);
  expect(owner.doc.read()).toBe(UNSENT);

  // 3. The client reconnects and sends its unsent edit again.
  const reconnected = await openEditor(author, owner.doc);
  expect(reconnected.received.filter(isFailure)).toEqual([]);
  const draft = await readDraft(author.organisationId);
  expect(draft).toMatchObject({
    ok: true,
    value: { draft: { kind: "active", description: UNSENT } },
  });
  // The admin's editor reaches the same text, live or after its own reconnect.
  if (admin.closed) await openEditor(reviewer, admin.doc);
  await expect
    .poll(admin.doc.read.bind(admin.doc), { timeout: 15_000 })
    .toBe(UNSENT);
  expect(admin.received.filter(isFailure)).toEqual([]);

  task.meta.descriptionDraftReconnect = {
    ownerFirstSocket: owner.received.map(kindOf),
    ownerReconnected: reconnected.received.map(kindOf),
    adminClosedByUnavailableCheck: admin.closed,
    draft,
  };
}

/**
 * Opens the editor's socket and syncs it as the Portal client does: the
 * client's state vector goes out, the missing update comes back, and any
 * local change the server lacks is sent as one update.
 */
async function openEditor(
  person: Member,
  doc: ProductDescriptionDoc,
): Promise<Editor> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${person.organisationId}/commerce/products/${PRODUCT_ID}/description-draft/socket`,
    {
      headers: {
        Upgrade: "websocket",
        Origin: "https://localhost",
        Cookie: `pantry_session=${encodeURIComponent(person.session.token)}`,
      },
    },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("The draft upgrade returned no socket");
  socket.accept();
  const editor: Editor = { socket, doc, received: [], closed: false };
  socket.addEventListener("message", receive.bind(null, editor));
  socket.addEventListener("close", markClosed.bind(null, editor));
  const synced = nextMessage(editor, "sync_response");
  socket.send(
    encodeDraftClientMessage({
      kind: "sync_request",
      stateVector: required(doc.stateVector()),
    }),
  );
  const sync = await synced;
  if (sync.kind !== "sync_response") throw new Error("No sync response");
  const missing = doc.apply(sync.missingUpdate);
  if (!missing.ok) throw new Error(missing.error.code);
  if (sync.access === "edit") {
    const local = required(doc.syncUpdate(sync.serverStateVector));
    await submit(editor, local);
  }
  return editor;
}

function receive(editor: Editor, event: MessageEvent): void {
  const parsed = parseDraftServerMessage(event.data);
  if (!parsed.ok) return;
  editor.received.push(parsed.value);
  if (parsed.value.kind === "update_broadcast") {
    const applied = editor.doc.apply(parsed.value.update);
    if (!applied.ok) throw new Error(applied.error.code);
  }
}

function markClosed(editor: Editor): void {
  editor.closed = true;
}

async function submit(
  editor: Editor,
  update: ProductDescriptionUpdate,
): Promise<void> {
  const updateId = crypto.randomUUID();
  const accepted = nextMessage(editor, "update_accepted");
  editor.socket.send(
    encodeDraftClientMessage({ kind: "submit_update", updateId, update }),
  );
  const message = await accepted;
  expect(message).toMatchObject({ kind: "update_accepted", updateId });
}

function nextMessage(
  editor: Editor,
  kind: DraftServerMessage["kind"],
): Promise<DraftServerMessage> {
  const seen = editor.received.length;
  return expect
    .poll(
      () =>
        editor.received
          .slice(seen)
          .find(
            (message) => message.kind === kind || message.kind === "failure",
          ),
      { timeout: 15_000 },
    )
    .toBeDefined()
    .then(() => {
      const message = editor.received
        .slice(seen)
        .find(
          (candidate) =>
            candidate.kind === kind || candidate.kind === "failure",
        );
      if (message === undefined || message.kind === "failure")
        throw new Error(`The draft room answered ${JSON.stringify(message)}`);
      return message;
    });
}

/** Turns a capability on and adds two grants, as Allow in a prompt does. */
async function allowLikeAPrompt(owner: Member): Promise<void> {
  await enableCapability(
    owner.organisationId,
    owner.session,
    "commerce.product_description_draft.edit",
  );
  const subjectRefId = await opaqueSubjectReference(owner.organisationId, {
    kind: "organisation_role",
    firstId: "owner",
    secondId: null,
    revision: 1,
  });
  const subjectRef = { subjectRefId, revision: 1 };
  await createGrant(owner.organisationId, owner.session, {
    subjectRef,
    target: {
      kind: "platform",
      capabilityRef: {
        capabilityId: "commerce.product_description_draft.edit",
        capabilityVersion: 1,
      },
    },
  });
  await createGrant(owner.organisationId, owner.session, {
    subjectRef,
    target: {
      kind: "commerce_entity_type",
      capabilityRef: {
        capabilityId: "commerce.entity.read",
        capabilityVersion: 1,
      },
      entityTypeId: { origin: "system", typeId: "product" },
    },
  });
}

/**
 * Makes each access check fail in its read, as a failed database read would:
 * the check reads the lifecycle of the Organisation, so it cannot run, and it
 * refuses nobody.
 */
async function failAccessChecks(organisationId: OrganisationId): Promise<void> {
  for (const db of await databases(organisationId))
    await db
      .prepare(
        "ALTER TABLE organisation_onboarding RENAME TO e2e_access_check_unavailable",
      )
      .run();
}

async function restoreAccessChecks(
  organisationId: OrganisationId,
): Promise<void> {
  for (const db of await databases(organisationId))
    await db
      .prepare(
        "ALTER TABLE e2e_access_check_unavailable RENAME TO organisation_onboarding",
      )
      .run();
}

async function databases(
  organisationId: OrganisationId,
): Promise<ReadonlySet<D1Database>> {
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) throw new Error("E2E organisation scope missing");
  return new Set([scope.value.database]);
}

async function readDraft(organisationId: OrganisationId) {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  return organisation.readProductDescriptionDraft({
    organisationId,
    request: { productId: PRODUCT_ID },
  });
}

function newDocument(): ProductDescriptionDoc {
  return required(ProductDescriptionDoc.create(""));
}

function edit(
  doc: ProductDescriptionDoc,
  text: string,
): ProductDescriptionUpdate {
  return required(doc.edit(text));
}

function required<T>(
  result:
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: { code: string } }>,
): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function isFailure(message: DraftServerMessage): boolean {
  return message.kind === "failure";
}

function kindOf(message: DraftServerMessage): string {
  return message.kind === "failure" ? `failure:${message.code}` : message.kind;
}
