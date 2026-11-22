import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import {
  parseListEntryReadRequest,
  parseProductionRequestFields,
  productionRequestAttributes,
} from "@purin-labs/commerce-client";
import { ensureCreatedOrganisationActor } from "@purin-labs/agent/control/organisation-runtime";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import {
  accessControlPath,
  mutationHeaders,
  readAccess,
} from "./access-route-support";
import {
  commerceClient,
  commerceHeaders,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import { PRODUCTION, PlanJourney } from "./production-plan-support";

declare module "vitest" {
  interface TaskMeta {
    commerceWritePermission?: Record<string, unknown>;
  }
}

const LIST_ENTRY_PATCH = "commerce.list_entry.patch";

it(
  "offers the list-entry permission when a card move is refused while the workspace keeps it switched off, and moves the card once the owner allows it",
  { timeout: 180_000 },
  listEntryPermissionJourney,
);

/**
 * An owner moves a production request on the café's board. A new workspace
 * keeps "Update a commerce-list entry" switched off. Pantry must answer
 * with the permission that the Portal prompt offers, not a bare refusal.
 * After the prompt's own Access change, the Portal sends the same move again
 * with the same idempotency key; the entry changes in Commerce once.
 */
async function listEntryPermissionJourney({
  task,
}: TestContext): Promise<void> {
  const owner = await commerceClient(`board-owner-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Board permission");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_bakery_c3_board_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  const shop = new PlanJourney(organisationId, merchantId, owner.session);
  const provisioned = await shop.native.provisionDemo({
    schemaVersion: "commerce.provision-demo.v2",
    externalReference: organisationId,
    merchantId,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  expect(provisioned.ok, JSON.stringify(provisioned)).toBe(true);
  await shop.write(PRODUCTION, { kind: "setup" });
  const [requestId] = await shop.createRequests(1);
  if (requestId === undefined) throw new Error("Request missing");

  // 0. A new workspace keeps list-entry updates switched off.
  expect(await currentMode(organisationId, owner.session)).toBe("disabled");

  // 1. The card move answers with the permission that the prompt offers.
  const move = await cardMove(shop, requestId, 3);
  const key = `board-move-${crypto.randomUUID()}`;
  const refused = await patchEntry(
    organisationId,
    owner.session,
    requestId,
    move,
    key,
  );
  expect(refused.status).toBe(403);
  expect(refused.body).toMatchObject({
    ok: false,
    error: "commerce_list_entry_patch_permission_required",
    permission: {
      capabilityId: LIST_ENTRY_PATCH,
      label: "Update a commerce-list entry",
      mode: "disabled",
      grant: null,
    },
  });
  const before = await quantity(shop, requestId);

  // 2. Allow in the prompt switches the capability on, as the Access page does.
  await changeMode(organisationId, owner.session, LIST_ENTRY_PATCH, "enabled");

  // 3. The Portal sends the same move again, with the same key.
  const moved = await patchEntry(
    organisationId,
    owner.session,
    requestId,
    move,
    key,
  );
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body).toMatchObject({ ok: true, receipt: {} });
  const after = await quantity(shop, requestId);
  expect(after.amount).toBe(3 * 10 ** after.scale);
  expect(after.amount).not.toBe(before.amount);

  task.meta.commerceWritePermission = {
    refusedWhileSwitchedOff: refused,
    afterAllow: {
      status: moved.status,
      quantityBefore: before,
      quantityAfter: after,
    },
  };
}

type CardMove = Record<string, unknown>;

/** The Portal's list-entry patch command for one production request. */
async function cardMove(
  shop: PlanJourney,
  requestId: string,
  whole: number,
): Promise<CardMove> {
  const read = await shop.entities.readListEntry(
    parseListEntryReadRequest({
      merchantId: shop.merchantId,
      listId: "production_requests",
      entryId: requestId,
    }),
  );
  if (!read.ok || read.value.kind !== "found")
    throw new Error("Request read failed");
  const fields = parseProductionRequestFields(read.value.entry.attributeValues);
  const revision = Number(read.value.entry.revision);
  return {
    kind: "patch_commerce_list_entry",
    command: {
      target: {
        entry: { entryId: requestId, listId: "production_requests", revision },
        expectedRevision: revision,
      },
      expectedListRevision: Number(read.value.listRevision),
      attributeValues: productionRequestAttributes({
        ...fields,
        quantity: {
          ...fields.quantity,
          amount: whole * 10 ** fields.quantity.scale,
        },
      }),
    },
  };
}

async function quantity(
  shop: PlanJourney,
  requestId: string,
): Promise<Readonly<{ amount: number; scale: number }>> {
  const fields = (await shop.requestFields([requestId])).get(requestId);
  if (fields === undefined) throw new Error("Request missing");
  return {
    amount: Number(fields.quantity.amount),
    scale: fields.quantity.scale,
  };
}

async function patchEntry(
  organisationId: string,
  session: IssuedControlSession,
  entryId: string,
  move: CardMove,
  key: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const headers = commerceHeaders(session);
  headers.set("idempotency-key", key);
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}/commerce/list-entries/${encodeURIComponent(entryId)}/patch`,
    { method: "POST", headers, body: JSON.stringify(move, bigintAsNumber) },
  );
  return { status: response.status, body: await response.json() };
}

async function currentMode(
  organisationId: string,
  session: IssuedControlSession,
): Promise<unknown> {
  const found = await capabilityOf(organisationId, session, LIST_ENTRY_PATCH);
  return found.capability.mode;
}

async function capabilityOf(
  organisationId: string,
  session: IssuedControlSession,
  capabilityId: string,
): Promise<
  Readonly<{
    view: Record<string, unknown>;
    capability: Record<string, unknown>;
  }>
> {
  const view = await readAccess(organisationId, session);
  const capability = Array.isArray(view.capabilities)
    ? view.capabilities.find(
        (candidate: unknown) =>
          isRecord(candidate) &&
          isRecord(candidate.definition) &&
          candidate.definition.capabilityId === capabilityId,
      )
    : undefined;
  if (!isRecord(capability)) throw new Error("Capability missing in Access");
  return { view, capability };
}

/** The Access page's capability change, which the prompt's Allow also sends. */
async function changeMode(
  organisationId: string,
  session: IssuedControlSession,
  capabilityId: string,
  mode: "enabled",
): Promise<void> {
  const { view, capability } = await capabilityOf(
    organisationId,
    session,
    capabilityId,
  );
  if (capability.mode === mode) return;
  const response = await exports.default.fetch(
    `${accessControlPath(organisationId)}/capabilities/${capabilityId}`,
    {
      method: "POST",
      headers: mutationHeaders(session),
      body: JSON.stringify({
        expectedRevision: view.revision,
        capabilityRevision: capability.revision,
        capabilityVersion: 1,
        mode,
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

/** The Portal sends entity-plane integers as JSON numbers. */
function bigintAsNumber(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}
