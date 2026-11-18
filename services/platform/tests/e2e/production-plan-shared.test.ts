import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import {
  parseInventoryProductionPlanResult,
  type InventoryProductionRequest,
} from "@seams/control-api";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import {
  commerceClient,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import { openSocket } from "./hibernatable-socket-support";
import {
  LOCATION,
  PRODUCTION,
  PlanJourney,
  PlanRoomClient,
  planPath,
} from "./production-plan-support";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";

declare module "vitest" {
  interface TaskMeta {
    sharedProductionPlan?: Record<string, unknown>;
  }
}

it(
  "lets two operators plan one location's production together, shows a viewer the plan without edits, revises and accepts each line once, refuses only the request that changed in Underclerk, and replays a repeated accept",
  { timeout: 180_000 },
  sharedProductionPlanJourney,
);

/**
 * Plan 40D Phase B1. Two operators change different lines of the café's plan
 * at the same time; a viewer sees both changes and cannot edit. Meanwhile a
 * request changes in Commerce. "Accept plan" revises and accepts the other
 * lines, refuses the changed one, and removes the accepted lines from every
 * open page. A repeated accept changes nothing.
 */
async function sharedProductionPlanJourney({
  task,
}: TestContext): Promise<void> {
  const owner = await commerceClient(`plan-owner-${crypto.randomUUID()}`);
  const operator = await commerceClient(`plan-operator-${crypto.randomUUID()}`);
  const viewer = await commerceClient(`plan-viewer-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Shared plan journey");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_bakery_c3_shared_plan_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  await fixtureDatabase().batch([
    ...member(organisationId, operator.identity.userId, "operator"),
    ...member(organisationId, viewer.identity.userId, "viewer"),
  ]);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: { operator, privateMember: viewer },
  });
  const shop = new PlanJourney(organisationId, merchantId, owner.session);
  const provisioned = await shop.native.provisionDemo({
    schemaVersion: "underclerk.provision-demo.v2",
    externalReference: organisationId,
    merchantId,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  expect(provisioned.ok, JSON.stringify(provisioned)).toBe(true);

  // 1. The café has four production requests that wait for acceptance.
  await shop.write(PRODUCTION, { kind: "setup" });
  const created = await shop.createRequests(4);
  const [first, second, third, fourth] = created;
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined
  )
    throw new Error("Production requests missing");
  const opened = await shop.requested();
  expect(opened.map(requestIdentity).sort()).toEqual(
    [first, second, third, fourth].sort(),
  );
  const before = new Map(opened.map(requestEntry));
  const original = requireRequest(before, first).quantity;
  // Cookies are counted in whole pieces.
  expect(original).toMatchObject({ unit: "each", scale: 0 });
  const whole = original.amount;

  // 2. Two operators and a viewer open the café's plan.
  const socketUrl = `https://localhost/v1/control/organisations/${organisationId}/commerce/inventory/production-plan/${LOCATION}/socket`;
  const ownerRoom = new PlanRoomClient(
    await openSocket(socketUrl, owner.session),
  );
  const operatorRoom = new PlanRoomClient(
    await openSocket(socketUrl, operator.session),
  );
  const viewerRoom = new PlanRoomClient(
    await openSocket(socketUrl, viewer.session),
  );
  expect(await ownerRoom.sync()).toMatchObject({ access: "edit" });
  expect(await operatorRoom.sync()).toMatchObject({ access: "edit" });
  expect(await viewerRoom.sync()).toMatchObject({ access: "read" });

  // 3. Each operator changes a different line at the same time; the operator
  //    also plans the third line.
  const ownerQuantity = String(whole * 3);
  const operatorQuantity = String(whole * 2);
  const thirdQuantity = String(whole * 4);
  await Promise.all([
    ownerRoom.submit("owner-first", ownerRoom.set(first, ownerQuantity)),
    operatorRoom
      .submit("operator-second", operatorRoom.set(second, operatorQuantity))
      .then(() =>
        operatorRoom.submit(
          "operator-third",
          operatorRoom.set(third, thirdQuantity),
        ),
      ),
  ]);
  const planned = {
    [first]: ownerQuantity,
    [second]: operatorQuantity,
    [third]: thirdQuantity,
  };
  for (const room of [ownerRoom, operatorRoom, viewerRoom])
    await expect.poll(() => room.lines()).toEqual(planned);

  // 4. Meanwhile the third request changes in Commerce.
  const changedInCommerce = await shop.reviseInUnderclerk(third, whole * 5);

  // 5. The owner accepts the plan that the page shows.
  const acceptance = {
    kind: "accept_plan",
    lines: opened.map((request) => ({
      requestId: request.id,
      requestRevision: request.revision,
      quantity:
        planned[request.id] ??
        String(request.quantity.amount / 10 ** request.quantity.scale),
    })),
  };
  const revisionBefore = await shop.merchantRevision();
  const acceptKey = `production_plan:${crypto.randomUUID()}`;
  const accepted = parseInventoryProductionPlanResult(
    await shop.write(planPath("accept"), acceptance, acceptKey),
  );
  const outcomes = new Map(
    accepted.lines.map((line) => [line.requestId, line]),
  );
  expect(outcomes.get(first)).toMatchObject({
    outcome: "accepted",
    revised: true,
    quantity: { amount: whole * 3 },
  });
  expect(outcomes.get(second)).toMatchObject({
    outcome: "accepted",
    revised: true,
  });
  expect(outcomes.get(fourth)).toMatchObject({
    outcome: "accepted",
    revised: false,
  });
  expect(outcomes.get(third)).toEqual({
    requestId: third,
    revised: false,
    outcome: "refused",
    reason: "request_changed",
  });
  // Revise and accept for two lines, accept for one: five merchant writes.
  expect(await shop.merchantRevision()).toBe(revisionBefore + 5);

  // 6. Commerce holds the planned quantities on the accepted requests and
  //    the other writer's change on the refused one.
  const after = await shop.requestFields([first, second, third, fourth]);
  expect(after.get(first)).toMatchObject({
    status: "accepted",
    quantity: { amount: whole * 3 },
  });
  expect(after.get(second)).toMatchObject({
    status: "accepted",
    quantity: { amount: whole * 2 },
  });
  expect(after.get(fourth)).toMatchObject({
    status: "accepted",
    quantity: requireRequest(before, fourth).quantity,
  });
  expect(after.get(third)).toMatchObject({
    status: "requested",
    quantity: { amount: whole * 5 },
  });

  // 7. Every open page loses the accepted lines; the refused line stays for
  //    the operators to review.
  for (const room of [ownerRoom, operatorRoom, viewerRoom])
    await expect.poll(() => room.lines()).toEqual({ [third]: thirdQuantity });

  // 8. A repeated accept replays its receipt and changes nothing.
  const revisionAfter = await shop.merchantRevision();
  const repeated = await shop.write(planPath("accept"), acceptance, acceptKey);
  expect(parseInventoryProductionPlanResult(repeated)).toEqual(accepted);
  expect(await shop.merchantRevision()).toBe(revisionAfter);

  // 9. A viewer cannot change the plan, and cannot accept it.
  const viewerEdit = await viewerRoom.refused(
    "viewer-edit",
    viewerRoom.set(third, "1"),
  );
  const viewerAccept = await shop.send(
    planPath("accept"),
    acceptance,
    viewer.session,
  );
  // A role below operator is refused as if the route did not exist.
  expect(viewerAccept.status).toBe(404);
  expect(await operatorRoom.lines()).toEqual({ [third]: thirdQuantity });

  const stored = await runInDurableObject(
    await requireActiveOrganisationActor({
      env,
      organisationId,
      now: Date.now(),
    }),
    (_actor: unknown, durable: DurableObjectState) =>
      durable.storage.sql
        .exec("SELECT location_id, generation, revision FROM production_plan")
        .toArray(),
  );
  expect(stored).toEqual([
    { location_id: LOCATION, generation: 1, revision: expect.any(Number) },
  ]);
  for (const room of [ownerRoom, operatorRoom, viewerRoom]) await room.close();

  task.meta.sharedProductionPlan = {
    location: LOCATION,
    requests: { first, second, third, fourth },
    originalQuantity: original,
    planned,
    changedInUnderclerk: changedInCommerce,
    accept: accepted,
    merchantWrites: revisionAfter - revisionBefore,
    underclerkAfter: Object.fromEntries(after),
    planAfterAccept: { [third]: thirdQuantity },
    repeatedAcceptReplayed: true,
    viewer: { edit: viewerEdit, acceptStatus: viewerAccept.status },
    storedPlans: stored,
  };
}

function member(
  organisationId: string,
  userId: string,
  role: "operator" | "viewer",
): D1PreparedStatement[] {
  const personId = `person_plan_${role}`;
  return [
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisationId, personId, role),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, ?, 'active', ?, NULL)",
      )
      .bind(organisationId, userId, personId, role, Date.now()),
  ];
}

function requestIdentity(request: InventoryProductionRequest): string {
  return request.id;
}

function requestEntry(
  request: InventoryProductionRequest,
): [string, InventoryProductionRequest] {
  return [request.id, request];
}

function requireRequest(
  requests: ReadonlyMap<string, InventoryProductionRequest>,
  id: string,
): InventoryProductionRequest {
  const request = requests.get(id);
  if (request === undefined) throw new Error(`Request missing: ${id}`);
  return request;
}
