import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import {
  ProductDescriptionDoc,
  type ProductDescriptionUpdate,
  type ProductDescriptionStateVector,
} from "@purin-labs/product-description-crdt";
import {
  encodeDraftClientMessage,
  parseDraftServerMessage,
  type DraftServerMessage,
} from "@purin-labs/product-description-crdt/protocol";
import {
  bootstrapOrganisation,
  issueControlSession,
  upsertUser,
  type User,
  type IssuedControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import {
  newControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "@purin-labs/tenancy/data/control-mutation";
import { ensureCreatedOrganisationActor } from "@purin-labs/agent/control/organisation-runtime";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { OrganisationDO } from "../../src/actors/organisation";
import { commerceCanonicalResourceId } from "@purin-labs/area-commerce-contract/server/resource-ids";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Variant } from "@purin-labs/type-utils";
import { requiredPlacement } from "./slack-journey-support";
import { admitOperatorControlTurnFixture } from "../organisation-execution-fixture";

const PUBLIC_ORIGIN = "https://localhost";
const PRODUCT_ID = "product_description_e2e";
const INTEGRATION_ACCOUNT_ID = "integration_description_e2e";
const PROVIDER_CONNECTION_ID = "provider_description_e2e";
const COMMERCE_BINDING_ID = "commerce_binding_description_e2e";
const COMMERCE_MERCHANT_ID = "merchant_description_e2e";
const INITIAL_DESCRIPTION = "Freshly baked croissant.";
/** More pointer frames than a socket may have waiting in the room. */
const POINTER_BURST = 40;
const TEST_PLACEMENT = requiredPlacement();
type ControlClient = Readonly<{
  identity: User;
  session: IssuedControlSession;
}>;

type DraftScenario = Readonly<{
  organisationId: OrganisationId;
  owner: ControlClient;
  editor: ControlClient;
  viewer: ControlClient;
  organisation: DurableObjectStub<OrganisationDO>;
}>;

it(
  "walks two authenticated draft clients through edit, reconnect, duplicate delivery, and actor eviction",
  walkingDraftJourney,
);
it(
  "enforces origin, organisation, viewer, revocation, and persistence-failure boundaries",
  draftSafetyJourney,
);
it(
  "answers a retried agent edit from its receipt for 7 days, then runs it as a new edit",
  agentReceiptJourney,
);
async function walkingDraftJourney(): Promise<void> {
  const scenario = await installDraftScenario("walking");
  const ownerSocket = await openDraftSocket(
    scenario.organisationId,
    scenario.owner.session,
    PRODUCT_ID,
  );
  const editorSocket = await openDraftSocket(
    scenario.organisationId,
    scenario.editor.session,
    PRODUCT_ID,
  );
  const ownerDoc = emptyDescriptionDocument();
  const editorDoc = emptyDescriptionDocument();
  let expectedFinalText = "";

  try {
    const ownerSync = await requestSync(ownerSocket, ownerDoc);
    const editorSync = await requestSync(editorSocket, editorDoc);
    expect(ownerSync).toMatchObject({
      initializedFromProductRevision: 1,
      currentProductRevision: 1,
      access: "edit",
    });
    expect(editorSync).toMatchObject({
      initializedFromProductRevision: 1,
      currentProductRevision: 1,
      access: "edit",
    });
    applyRemoteUpdate(ownerDoc, ownerSync.missingUpdate);
    applyRemoteUpdate(editorDoc, editorSync.missingUpdate);
    expect(ownerDoc.read()).toBe(INITIAL_DESCRIPTION);
    expect(editorDoc.read()).toBe(INITIAL_DESCRIPTION);

    const presencePromise = nextServerMessage(ownerSocket, isEditingPresence);
    const selection = ownerDoc.capturePresenceSelection(0, 7, "forward");
    ownerSocket.send(
      encodeDraftClientMessage({
        kind: "presence_update",
        state: "editing",
        selection,
      }),
    );
    const presence = await presencePromise;
    expect(presence.kind).toBe("presence_changed");
    if (presence.kind !== "presence_changed")
      throw new Error("presence response was not a presence change");
    expect(presence.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: ownerSync.sessionId,
          displayName: scenario.owner.identity.displayName,
          state: "editing",
          selection,
        }),
        expect.objectContaining({
          displayName: scenario.editor.identity.displayName,
          state: "viewing",
        }),
      ]),
    );

    const pointerMessage = nextServerMessage(editorSocket, hasMousePointer);
    ownerSocket.send(
      encodeDraftClientMessage({
        kind: "pointer_update",
        position: { x: 0.25, y: 0.75 },
      }),
    );
    const pointerPresence = await pointerMessage;
    expect(pointerPresence).toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({
          sessionId: ownerSync.sessionId,
          pointer: {
            position: { x: 0.25, y: 0.75 },
            updatedAt: expect.any(Number),
          },
        }),
      ]),
    });
    // The owner moves the pointer faster than the room checks access, as a
    // slow database makes it: the frames wait, and the editor gets the last
    // position. The owner's socket stays open.
    const ownerFailures: DraftServerMessage[] = [];
    const watchOwner = (event: MessageEvent): void => {
      const parsed = parseDraftServerMessage(event.data);
      if (parsed.ok && parsed.value.kind === "failure")
        ownerFailures.push(parsed.value);
    };
    ownerSocket.addEventListener("message", watchOwner);
    const lastPosition = { x: 0.9, y: 0.1 };
    const lastPointer = nextServerMessage(
      editorSocket,
      hasPointerAt.bind(null, lastPosition),
    );
    for (let step = 1; step <= POINTER_BURST; step += 1)
      ownerSocket.send(
        encodeDraftClientMessage({
          kind: "pointer_update",
          position:
            step === POINTER_BURST
              ? lastPosition
              : { x: step / (POINTER_BURST * 2), y: 0.5 },
        }),
      );
    await lastPointer;
    ownerSocket.removeEventListener("message", watchOwner);
    expect(ownerFailures).toEqual([]);

    const hiddenPointer = nextServerMessage(editorSocket, hasNoMousePointers);
    ownerSocket.send(
      encodeDraftClientMessage({ kind: "pointer_update", position: null }),
    );
    await hiddenPointer;
    expect(ownerDoc.read()).toBe(INITIAL_DESCRIPTION);
    expect(editorDoc.read()).toBe(INITIAL_DESCRIPTION);

    // Both operators edit from the same accepted base before either imports a
    // peer frame. Yjs must merge the independent updates deterministically.
    const ownerUpdate = requiredUpdate(
      ownerDoc.edit("Freshly baked croissant with orange zest."),
    );
    const editorUpdate = requiredUpdate(
      editorDoc.edit("Freshly baked croissant with vanilla glaze."),
    );
    const ownerAck = nextServerMessage(ownerSocket, isUpdateAccepted);
    const editorAck = nextServerMessage(editorSocket, isUpdateAccepted);
    const ownerBroadcast = nextServerMessage(ownerSocket, isUpdateBroadcast);
    const editorBroadcast = nextServerMessage(editorSocket, isUpdateBroadcast);
    ownerSocket.send(encodeSubmitUpdate("owner-first", ownerUpdate));
    editorSocket.send(encodeSubmitUpdate("editor-first", editorUpdate));
    const [
      ownerAckMessage,
      editorAckMessage,
      ownerPeerMessage,
      editorPeerMessage,
    ] = await Promise.all([
      ownerAck,
      editorAck,
      ownerBroadcast,
      editorBroadcast,
    ]);
    expect(ownerAckMessage).toMatchObject({
      kind: "update_accepted",
      updateId: "owner-first",
    });
    expect(editorAckMessage).toMatchObject({
      kind: "update_accepted",
      updateId: "editor-first",
    });
    if (
      ownerPeerMessage.kind !== "update_broadcast" ||
      editorPeerMessage.kind !== "update_broadcast"
    ) {
      throw new Error("concurrent updates were not broadcast");
    }
    applyRemoteUpdate(ownerDoc, ownerPeerMessage.update);
    applyRemoteUpdate(editorDoc, editorPeerMessage.update);
    expect(ownerDoc.read()).toBe(editorDoc.read());
    expect(ownerDoc.read()).not.toBe(INITIAL_DESCRIPTION);

    const duplicateAck = nextServerMessage(ownerSocket, isUpdateAccepted);
    const noDuplicateBroadcast = expectNoServerMessage(editorSocket, 100);
    ownerSocket.send(encodeSubmitUpdate("owner-duplicate", ownerUpdate));
    expect(await duplicateAck).toMatchObject({
      kind: "update_accepted",
      updateId: "owner-duplicate",
    });
    await noDuplicateBroadcast;
    expect(editorDoc.read()).toBe(ownerDoc.read());

    await closeSocket(editorSocket);
    const beforeDeletionVector = requiredStateVector(ownerDoc).encode();
    const deletion = requiredUpdate(
      ownerDoc.edit(ownerDoc.read().slice(0, -1)),
    );
    expect(requiredStateVector(ownerDoc).encode()).toEqual(
      beforeDeletionVector,
    );
    const deletionAck = nextServerMessage(ownerSocket, isUpdateAccepted);
    ownerSocket.send(encodeSubmitUpdate("owner-deletion", deletion));
    expect(await deletionAck).toMatchObject({
      kind: "update_accepted",
      updateId: "owner-deletion",
    });

    const reconnectedSocket = await openDraftSocket(
      scenario.organisationId,
      scenario.editor.session,
      PRODUCT_ID,
    );
    try {
      const reconnectSync = await requestSync(reconnectedSocket, editorDoc);
      expect(reconnectSync.missingUpdate.encode().byteLength).toBeGreaterThan(
        0,
      );
      applyRemoteUpdate(editorDoc, reconnectSync.missingUpdate);
      expect(editorDoc.read()).toBe(ownerDoc.read());
      expectedFinalText = ownerDoc.read();
    } finally {
      await closeSocket(reconnectedSocket);
    }
  } finally {
    ownerDoc.destroy();
    editorDoc.destroy();
    await closeSocket(ownerSocket);
  }

  await evictDurableObject(scenario.organisation);
  const restoredSocket = await openDraftSocket(
    scenario.organisationId,
    scenario.owner.session,
    PRODUCT_ID,
  );
  const restoredDoc = emptyDescriptionDocument();
  try {
    const restored = await requestSync(restoredSocket, restoredDoc);
    expect(restored.initializedFromProductRevision).toBe(1);
    applyRemoteUpdate(restoredDoc, restored.missingUpdate);
    expect(restoredDoc.read()).toBe(expectedFinalText);
  } finally {
    restoredDoc.destroy();
    await closeSocket(restoredSocket);
  }
}

async function draftSafetyJourney(): Promise<void> {
  const scenario = await installDraftScenario("safety");
  const viewer = scenario.viewer;

  const wrongOrigin = await exports.default.fetch(
    draftUrl(scenario.organisationId, PRODUCT_ID),
    {
      headers: draftHeaders(scenario.owner.session, "https://evil.example"),
    },
  );
  expect(wrongOrigin.status).toBe(403);
  await expect(wrongOrigin.json()).resolves.toMatchObject({
    ok: false,
    error: "origin_invalid",
  });

  const otherOrganisation = await installDraftScenario("cross-organisation");
  const crossOrganisation = await exports.default.fetch(
    draftUrl(otherOrganisation.organisationId, PRODUCT_ID),
    {
      headers: draftHeaders(scenario.owner.session, PUBLIC_ORIGIN),
    },
  );
  expect(crossOrganisation.status).toBe(404);

  const viewerSocket = await openDraftSocket(
    scenario.organisationId,
    viewer.session,
    PRODUCT_ID,
  );
  const viewerDoc = emptyDescriptionDocument();
  try {
    const synced = await requestSync(viewerSocket, viewerDoc);
    expect(synced.access).toBe("read");
    applyRemoteUpdate(viewerDoc, synced.missingUpdate);
    const attempted = requiredUpdate(
      viewerDoc.edit("Viewer must remain read-only."),
    );
    const failure = nextServerMessage(viewerSocket, isFailure);
    viewerSocket.send(encodeSubmitUpdate("viewer-write", attempted));
    await expect(failure).resolves.toMatchObject({
      kind: "failure",
      code: "access_revoked",
    });
  } finally {
    viewerDoc.destroy();
    await closeSocket(viewerSocket);
  }

  const editorSocket = await openDraftSocket(
    scenario.organisationId,
    scenario.editor.session,
    PRODUCT_ID,
  );
  const editorDoc = emptyDescriptionDocument();
  try {
    const synced = await requestSync(editorSocket, editorDoc);
    applyRemoteUpdate(editorDoc, synced.missingUpdate);
    await revokeMembership(
      scenario.organisationId,
      scenario.editor.identity.userId,
    );
    const attempted = requiredUpdate(
      editorDoc.edit("Revoked operator must not persist."),
    );
    const failure = nextServerMessage(editorSocket, isFailure);
    editorSocket.send(encodeSubmitUpdate("revoked-write", attempted));
    await expect(failure).resolves.toMatchObject({
      kind: "failure",
      code: "access_revoked",
    });
  } finally {
    editorDoc.destroy();
    await closeSocket(editorSocket);
  }

  const ownerSocket = await openDraftSocket(
    scenario.organisationId,
    scenario.owner.session,
    PRODUCT_ID,
  );
  const peerSocket = await openDraftSocket(
    scenario.organisationId,
    scenario.owner.session,
    PRODUCT_ID,
  );
  const ownerDoc = emptyDescriptionDocument();
  try {
    const ownerSync = await requestSync(ownerSocket, ownerDoc);
    const peerDoc = emptyDescriptionDocument();
    await requestSync(peerSocket, peerDoc);
    applyRemoteUpdate(ownerDoc, ownerSync.missingUpdate);
    await runInDurableObject(
      scenario.organisation,
      installStorageFailureTrigger,
    );
    const attempted = requiredUpdate(
      ownerDoc.edit("Storage failure must not acknowledge."),
    );
    const failure = nextServerMessage(ownerSocket, isFailure);
    ownerSocket.send(encodeSubmitUpdate("storage-failure", attempted));
    await expect(failure).resolves.toMatchObject({
      kind: "failure",
      code: "storage_unavailable",
    });
    await expectNoServerMessage(peerSocket, 100);
    expect(ownerDoc.read()).toBe("Storage failure must not acknowledge.");
    peerDoc.destroy();
  } finally {
    ownerDoc.destroy();
    await closeSocket(ownerSocket);
    await closeSocket(peerSocket);
  }
}

/**
 * An agent edits the description, and a retry of the same operation returns
 * the first answer. Eight days later the same retry runs as a new edit: its
 * passage is gone, so it is refused and the draft does not change. The next
 * edit deletes the old receipt and keeps its own.
 */
async function agentReceiptJourney(): Promise<void> {
  const scenario = await installDraftScenario("receipts");
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'description-receipt-fixture', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), scenario.organisationId)
    .run();
  const execution = await admitOperatorControlTurnFixture(
    env,
    scenario.organisationId,
    scenario.editor.identity.userId,
    scenario.editor.session.session.controlSessionId,
  );
  const edit = (operationId: string, oldText: string, newText: string) => ({
    agent: { sessionId: execution.sessionId, displayName: "Copy editor" },
    execution,
    organisationId: scenario.organisationId,
    request: { productId: PRODUCT_ID, oldText, newText },
    operationId,
    userId: scenario.editor.identity.userId,
    deadlineAt: Date.now() + 60_000,
  });
  const first = edit("description-agent-first", "Freshly baked", "Warm");
  const edited = await scenario.organisation.editProductDescriptionDraft(first);
  expect(edited).toMatchObject({
    ok: true,
    value: { draft: { kind: "active", description: "Warm croissant." } },
  });
  await expect(
    scenario.organisation.editProductDescriptionDraft(first),
  ).resolves.toEqual(edited);

  await runInDurableObject(
    scenario.organisation,
    (_actor: OrganisationDO, state: DurableObjectState) => {
      state.storage.sql.exec(
        "UPDATE product_description_draft_operation SET created_at = ? WHERE operation_id = ?",
        Date.now() - 8 * 24 * 60 * 60 * 1_000,
        first.operationId,
      );
    },
  );
  await expect(
    scenario.organisation.editProductDescriptionDraft({
      ...first,
      deadlineAt: Date.now() + 60_000,
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "passage_conflict" },
  });

  const later = edit("description-agent-later", "Warm", "Golden");
  await expect(
    scenario.organisation.editProductDescriptionDraft(later),
  ).resolves.toMatchObject({
    ok: true,
    value: { draft: { kind: "active", description: "Golden croissant." } },
  });
  const receipts = await runInDurableObject(
    scenario.organisation,
    (_actor: OrganisationDO, state: DurableObjectState) =>
      state.storage.sql
        .exec<{ id: string }>(
          "SELECT operation_id AS id FROM product_description_draft_operation",
        )
        .toArray()
        .map((row) => row.id),
  );
  expect(receipts).toEqual([later.operationId]);
}

async function installDraftScenario(label: string): Promise<DraftScenario> {
  const now = Date.now() - 1_000;
  const owner = await createControlClient(
    `description-draft-${label}-owner`,
    `Description ${label} Owner`,
  );
  const editor = await createControlClient(
    `description-draft-${label}-editor`,
    `Description ${label} Editor`,
  );
  const viewer = await createControlClient(
    `description-draft-${label}-viewer`,
    `Description ${label} Viewer`,
  );
  const bootstrapped = await bootstrapOrganisation({
    env,
    owner: owner.identity,
    organisationName: `Description draft ${label}`,
    environment: "development",
    placement: TEST_PLACEMENT,
    mutation: organisationBootstrapMutation(owner.identity, label, now),
    now,
  });
  if (!bootstrapped.ok) throw new Error(bootstrapped.error.code);
  const organisation = bootstrapped.value;
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO person (organisation_id, person_id, display_name)
       VALUES (?, ?, ?)`,
      )
      .bind(
        organisation.organisationId,
        `person_description_${label}`,
        editor.identity.displayName,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant (
         organisation_id, user_id, person_id, role, status, created_at, revoked_at
       ) VALUES (?, ?, ?, 'operator', 'active', ?, NULL)`,
      )
      .bind(
        organisation.organisationId,
        editor.identity.userId,
        `person_description_${label}`,
        now,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO person (organisation_id, person_id, display_name)
       VALUES (?, ?, ?)`,
      )
      .bind(
        organisation.organisationId,
        `person_description_${label}_viewer`,
        viewer.identity.displayName,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant (
         organisation_id, user_id, person_id, role, status, created_at, revoked_at
       ) VALUES (?, ?, ?, 'viewer', 'active', ?, NULL)`,
      )
      .bind(
        organisation.organisationId,
        viewer.identity.userId,
        `person_description_${label}_viewer`,
        now,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO provider_connection (
         provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
         credential_generation, credential_ref, provider_application,
         application_credential_generation, asset_grant_revision, lifecycle,
         granted_scopes, created_by_user_id, created_at, updated_at,
         disabled_at, revoked_at, environment, provider_subject_id
       ) VALUES (?, ?, 'commerce', 'api_key', 'connection_credential',
         1, ?, NULL, NULL, NULL, 'active', '[]', ?, ?, ?, NULL, NULL, 'development', '')`,
      )
      .bind(
        PROVIDER_CONNECTION_ID + label,
        organisation.organisationId,
        `vault:description:${label}`,
        owner.identity.userId,
        now,
        now,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO integration_account (
         integration_account_id, organisation_id, provider_connection_id, provider,
         provider_account_id, account_kind, display_name, lifecycle,
         lifecycle_reason_code, capability_set, audience_policy, retention_policy,
         created_at, updated_at, disabled_by_user_id, disabled_at,
         revoked_at, environment, is_default_for_provider
       ) VALUES (?, ?, ?, 'commerce', ?, 'merchant', ?, 'active', NULL,
         '[]', '{}', '{}', ?, ?, NULL, NULL, NULL, 'development', 0)`,
      )
      .bind(
        INTEGRATION_ACCOUNT_ID + label,
        organisation.organisationId,
        PROVIDER_CONNECTION_ID + label,
        COMMERCE_MERCHANT_ID + label,
        `Commerce ${label}`,
        now,
        now,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO commerce_merchant_binding (
         binding_id, organisation_id, integration_account_id, merchant_id,
         environment, delivery_signing_key_id, delivery_signing_public_key_b64,
         revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'development', ?, ?, 1, ?, ?)`,
      )
      .bind(
        COMMERCE_BINDING_ID + label,
        organisation.organisationId,
        INTEGRATION_ACCOUNT_ID + label,
        COMMERCE_MERCHANT_ID + label,
        `commerce-key-${label}`,
        "AA==",
        now,
        now,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_commerce_system (
         organisation_id, system_kind, commerce_binding_id,
         shopify_integration_account_id, revision, selected_at,
         selected_by_user_id
       ) VALUES (?, 'builtin_commerce', ?, NULL, 1, ?, ?)`,
      )
      .bind(
        organisation.organisationId,
        COMMERCE_BINDING_ID + label,
        now,
        owner.identity.userId,
      ),
  ]);
  await ensureCreatedOrganisationActor({
    env,
    organisationId: organisation.organisationId,
    now,
  });
  const actor = await requireActiveOrganisationActor({
    env,
    organisationId: organisation.organisationId,
    now,
  });
  await runInDurableObject(
    actor,
    seedProductProjection.bind(
      null,
      organisation.organisationId,
      INTEGRATION_ACCOUNT_ID + label,
      COMMERCE_MERCHANT_ID + label,
    ),
  );
  return {
    organisationId: organisation.organisationId,
    owner,
    editor,
    viewer,
    organisation: actor,
  };
}

async function createControlClient(
  subject: string,
  displayName: string,
): Promise<ControlClient> {
  const now = Date.now() - 1_000;
  const identity = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject,
      email: `${subject}@description-draft.example`,
      displayName,
      emailVerified: true,
    },
    now,
  });
  const session = await issueControlSession({
    db: env.DB,
    userId: identity.userId,
    now,
    ttlMs: 30 * 60 * 1_000,
  });
  return { identity, session };
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

function seedProductProjection(
  organisationId: OrganisationId,
  integrationAccountId: string,
  merchantId: string,
  _actor: OrganisationDO,
  state: DurableObjectState,
): void {
  const occurredAt = new Date(Date.now() - 1_000).toISOString();
  const projection = {
    kind: "product",
    projection: {
      provenance: {
        organisationId,
        integrationAccountId,
        source: "commerce",
        resourceType: "product",
        resourceId: commerceCanonicalResourceId(merchantId, PRODUCT_ID),
        revision: 1,
        occurredAt,
        observedAt: occurredAt,
      },
      title: "E2E Croissant",
      description: INITIAL_DESCRIPTION,
    },
  };
  state.storage.sql.exec(
    `INSERT INTO commerce_projection (
       organisation_id, projection_kind, canonical_id, integration_account_id,
       revision, lifecycle, projection_json, updated_at, validated_at, lab_run_id
     ) VALUES (?, 'product', ?, ?, 1, 'active', ?, ?, ?, NULL)`,
    organisationId,
    commerceCanonicalResourceId(merchantId, PRODUCT_ID),
    integrationAccountId,
    JSON.stringify(projection),
    Date.now(),
    Date.now(),
  );
  state.storage.sql.exec(
    `INSERT INTO commerce_projection_relation_text (
       organisation_id, projection_kind, canonical_id, integration_account_id,
       display_name_folded, search_text_folded
     ) VALUES (?, 'product', ?, ?, ?, ?)`,
    organisationId,
    commerceCanonicalResourceId(merchantId, PRODUCT_ID),
    integrationAccountId,
    "e2e croissant",
    "e2e croissant",
  );
}

function installStorageFailureTrigger(
  _actor: OrganisationDO,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    `CREATE TRIGGER product_description_draft_fail_update
     BEFORE UPDATE OF encoded_state ON product_description_draft
     BEGIN SELECT RAISE(ABORT, 'forced product description storage failure'); END`,
  );
}

async function openDraftSocket(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  productId: string,
): Promise<WebSocket> {
  const response = await exports.default.fetch(
    draftUrl(organisationId, productId),
    {
      headers: draftHeaders(session, PUBLIC_ORIGIN),
    },
  );
  expect(response.status).toBe(101);
  if (response.webSocket === null)
    throw new Error("draft upgrade did not return a WebSocket");
  response.webSocket.accept();
  return response.webSocket;
}

function draftUrl(organisationId: OrganisationId, productId: string): string {
  return `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/commerce/products/${productId}/description-draft/socket`;
}

function draftHeaders(
  session: IssuedControlSession,
  origin: string,
): HeadersInit {
  return {
    Upgrade: "websocket",
    Origin: origin,
    Cookie: `pantry_session=${encodeURIComponent(session.token)}`,
  };
}

function requestSync(
  socket: WebSocket,
  document: ProductDescriptionDoc,
): Promise<Variant<DraftServerMessage, "sync_response">> {
  const stateVector = requiredStateVector(document);
  const response = nextServerMessage(socket, isSyncResponse);
  socket.send(encodeDraftClientMessage({ kind: "sync_request", stateVector }));
  return response.then(requireSyncResponse);
}

function requireSyncResponse(
  message: DraftServerMessage,
): Variant<DraftServerMessage, "sync_response"> {
  if (!isSyncResponse(message))
    throw new Error("draft response was not a sync response");
  return message;
}

function encodeSubmitUpdate(
  updateId: string,
  update: ProductDescriptionUpdate,
): string {
  return encodeDraftClientMessage({ kind: "submit_update", updateId, update });
}

function nextServerMessage(
  socket: WebSocket,
  accept: (message: DraftServerMessage) => boolean,
): Promise<DraftServerMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      const parsed = parseDraftServerMessage(event.data);
      if (!parsed.ok) return;
      if (!accept(parsed.value)) return;
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      resolve(parsed.value);
    };
    const onClose = (): void => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("draft socket closed before expected message"));
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
  });
}

async function expectNoServerMessage(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  let received = false;
  const onMessage = (event: MessageEvent): void => {
    const parsed = parseDraftServerMessage(event.data);
    if (
      parsed.ok &&
      (isUpdateAccepted(parsed.value) || isUpdateBroadcast(parsed.value))
    )
      received = true;
  };
  socket.addEventListener("message", onMessage);
  await delay(timeoutMs);
  socket.removeEventListener("message", onMessage);
  expect(received).toBe(false);
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
  });
  socket.close();
  await Promise.race([closed, delay(100)]);
}

function applyRemoteUpdate(
  document: ProductDescriptionDoc,
  update: ProductDescriptionUpdate,
): void {
  const applied = document.apply(update);
  if (!applied.ok) throw new Error(applied.error.code);
}

function emptyDescriptionDocument(): ProductDescriptionDoc {
  const document = ProductDescriptionDoc.create("");
  if (!document.ok) throw new Error(document.error.code);
  return document.value;
}

function requiredUpdate(
  result: ReturnType<ProductDescriptionDoc["edit"]>,
): ProductDescriptionUpdate {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function requiredStateVector(
  document: ProductDescriptionDoc,
): ProductDescriptionStateVector {
  const result = document.stateVector();
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function isSyncResponse(
  message: DraftServerMessage,
): message is Variant<DraftServerMessage, "sync_response"> {
  return message.kind === "sync_response";
}

function isUpdateAccepted(
  message: DraftServerMessage,
): message is Variant<DraftServerMessage, "update_accepted"> {
  return message.kind === "update_accepted";
}

function isUpdateBroadcast(
  message: DraftServerMessage,
): message is Variant<DraftServerMessage, "update_broadcast"> {
  return message.kind === "update_broadcast";
}

function isPresenceChanged(
  message: DraftServerMessage,
): message is Variant<DraftServerMessage, "presence_changed"> {
  return message.kind === "presence_changed";
}

function hasMousePointer(message: DraftServerMessage): boolean {
  return (
    isPresenceChanged(message) &&
    message.participants.some(participantHasPointer)
  );
}

function hasPointerAt(
  position: Readonly<{ x: number; y: number }>,
  message: DraftServerMessage,
): boolean {
  return (
    isPresenceChanged(message) &&
    message.participants.some(
      (participant) =>
        participant.pointer?.position.x === position.x &&
        participant.pointer.position.y === position.y,
    )
  );
}

function hasNoMousePointers(message: DraftServerMessage): boolean {
  return (
    isPresenceChanged(message) &&
    !message.participants.some(participantHasPointer)
  );
}

function participantHasPointer(
  participant: Variant<
    DraftServerMessage,
    "presence_changed"
  >["participants"][number],
): boolean {
  return participant.pointer !== null;
}

function isEditingPresence(
  message: DraftServerMessage,
): message is Variant<DraftServerMessage, "presence_changed"> {
  return (
    isPresenceChanged(message) &&
    message.participants.some((participant) => participant.state === "editing")
  );
}

function isFailure(
  message: DraftServerMessage,
): message is Variant<DraftServerMessage, "failure"> {
  return message.kind === "failure";
}

function organisationBootstrapMutation(
  owner: User,
  label: string,
  now: number,
) {
  const scope: ControlMutationReceiptScope = {
    userId: owner.userId,
    organisationScope: "organisation:create",
    route: "/v1/control/organisations",
    operation: "organisation.create",
  };
  return {
    scope,
    boundary: {
      kind: "unversioned" as const,
      idempotencyKey: `description-draft-${label}-${crypto.randomUUID()}`,
      requestHash: `description-draft-${label}`,
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: `description-draft-${label}`,
      causationId: `description-draft-${label}-${crypto.randomUUID()}`,
      now,
    }),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
