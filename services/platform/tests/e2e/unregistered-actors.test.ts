import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import {
  requireActiveOrganisationActor,
  resolveActiveConnectorActor,
} from "../../src/actors/actor-router";
import { listOrganisationActorRegistryEntries } from "../../src/actors/actor-registry";
import { codeModePlatformGovernor } from "../../src/actors/code-mode-platform-governor-stub";
import type { ConnectorDO } from "../../src/actors/connector";
import {
  conversationResidencyStub,
  type ConversationResidencyActor,
} from "../../src/actors/conversation-residency";
import { messageLinkFetchObjectName } from "../../src/messages/link-egress";
import { parseConnectorId } from "../../src/ids";
import {
  ORGANISATION_ID,
  installSlackActorFixture,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    unregisteredActors?: Record<string, unknown>;
  }
}

const REGISTRY_ROUTE = "https://localhost/v1/admin/state-object-registry";
const GONE_ORGANISATION = "tenant_11111111-2222-4333-8444-555555555555";

it(
  "empties an Actor no registry names, and refuses a registered Actor and one whose Organisation exists",
  unregisteredActorJourney,
  120_000,
);

async function unregisteredActorJourney({ task }: TestContext) {
  await installSlackActorFixture();
  const liveOrganisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const registeredId = required(parseConnectorId("connector_slack_registered"));
  const registered = required(
    await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: ORGANISATION_ID,
      connectorId: registeredId,
      now: Date.now(),
    }),
  );
  await storeConnector(registered, {
    owner: ORGANISATION_ID,
    connectorId: registeredId,
    earlierFormat: false,
  });

  // Left by an Organisation the directory no longer has, in the earlier format.
  const earlier = env.CONNECTOR.get(
    env.CONNECTOR.idFromName(`${GONE_ORGANISATION}:connector_whatsapp_gone`),
  );
  await storeConnector(earlier, {
    owner: GONE_ORGANISATION,
    connectorId: "connector_whatsapp_gone",
    earlierFormat: true,
  });
  const earlierOrganisation = env.ORGANISATION.get(
    env.ORGANISATION.idFromName(`${GONE_ORGANISATION}:p5`),
  );
  await runInDurableObject(
    earlierOrganisation,
    async function storeMarker(_actor, state) {
      await state.storage.put("journey-marker", "kept until erased");
    },
  );
  // Unregistered, but what it holds names an Organisation that exists.
  const stray = env.CONNECTOR.get(
    env.CONNECTOR.idFromName("stray:connector_whatsapp_stray"),
  );
  await storeConnector(stray, {
    owner: ORGANISATION_ID,
    connectorId: "connector_whatsapp_stray",
    earlierFormat: false,
  });

  const unauthorised = await exports.default.fetch(
    new Request(REGISTRY_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "erase_unregistered_actor",
        objectKind: "connector",
        objectId: earlier.id.toString(),
      }),
    }),
  );
  expect(unauthorised.status).toBe(404);
  expect((await erase("connector", "not-an-object-id")).status).toBe(422);
  expect(await ingressRows(earlier)).toBe(1);

  const refusedRegistered = await erase("connector", registered.id.toString());
  expect(refusedRegistered.status).toBe(409);
  expect(await refusedRegistered.json()).toMatchObject({
    error: { code: "actor_registered" },
  });
  const refusedOrganisation = await erase(
    "organisation",
    liveOrganisation.id.toString(),
  );
  expect(refusedOrganisation.status).toBe(409);
  expect(await refusedOrganisation.json()).toMatchObject({
    error: { code: "actor_registered" },
  });
  const refusedStray = await erase("connector", stray.id.toString());
  expect(refusedStray.status).toBe(409);
  expect(await refusedStray.json()).toMatchObject({
    error: { code: "actor_owner_exists" },
  });
  expect(await ingressRows(registered)).toBe(1);
  expect(await ingressRows(stray)).toBe(1);

  const erasedConnector = await erase("connector", earlier.id.toString());
  expect(erasedConnector.status, await erasedConnector.clone().text()).toBe(
    200,
  );
  expect(await erasedConnector.json()).toMatchObject({
    ok: true,
    report: { kind: "unregistered_actor_erased", objectKind: "connector" },
  });
  expect(await ingressRows(earlier)).toBeNull();
  const erasedOrganisation = await erase(
    "organisation",
    earlierOrganisation.id.toString(),
  );
  expect(erasedOrganisation.status).toBe(200);
  expect(
    await runInDurableObject(
      earlierOrganisation,
      function readMarker(_actor, state) {
        return state.storage.get("journey-marker");
      },
    ),
  ).toBeUndefined();

  // What serves an Organisation is not one of the four kinds. The residency
  // Actor of a Connector names its Organisation.
  const residency = requiredNamespace(env.CONVERSATION_RESIDENCY);
  const entries = required(
    await listOrganisationActorRegistryEntries({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
    }),
  );
  const connectorEntry = entries.find(isConnectorEntry);
  if (connectorEntry === undefined) throw new Error("No registered Connector");
  const liveResidency = conversationResidencyStub(
    residency,
    connectorEntry.physicalObjectName,
    connectorEntry.placement,
  );
  await storeResidency(liveResidency, ORGANISATION_ID);
  const strayResidency = residency.get(residency.idFromName("residency:stray"));
  await storeResidency(strayResidency, ORGANISATION_ID);
  const goneResidency = residency.get(residency.idFromName("residency:gone"));
  await storeResidency(goneResidency, GONE_ORGANISATION);
  // One link-fetch Actor serves the region of the live Organisation.
  const liveLinkFetch = env.MESSAGE_LINK_FETCH.idFromName(
    messageLinkFetchObjectName(connectorEntry.placement),
  );

  const earlierGovernor = env.CODE_MODE_PLATFORM_GOVERNOR_ACTOR.get(
    env.CODE_MODE_PLATFORM_GOVERNOR_ACTOR.idFromName(
      "code-mode-platform-governor:earlier",
    ),
  );
  await runInDurableObject(
    earlierGovernor,
    async function storeLedgerMarker(_actor, state) {
      await state.storage.put("journey-marker", "an earlier ledger");
    },
  );

  const served = {
    liveResidency: await outcome(
      erase("conversation_residency", liveResidency.id.toString()),
    ),
    strayResidency: await outcome(
      erase("conversation_residency", strayResidency.id.toString()),
    ),
    goneResidency: await outcome(
      erase("conversation_residency", goneResidency.id.toString()),
    ),
    liveLinkFetch: await outcome(
      erase("message_link_fetch", liveLinkFetch.toString()),
    ),
    linkFetchOfNoClass: await outcome(
      erase("message_link_fetch", goneResidency.id.toString()),
    ),
    // The governor of this build keeps the budget; one of an earlier name
    // holds a ledger that nothing reads.
    liveGovernor: await outcome(
      erase("code_mode_governor", codeModePlatformGovernor(env).id.toString()),
    ),
    earlierGovernor: await outcome(
      erase("code_mode_governor", earlierGovernor.id.toString()),
    ),
  };
  expect(served).toEqual({
    liveResidency: { status: 409, code: "actor_registered" },
    strayResidency: { status: 409, code: "actor_owner_exists" },
    goneResidency: { status: 200, code: null },
    liveLinkFetch: { status: 409, code: "actor_registered" },
    linkFetchOfNoClass: { status: 404, code: "actor_not_found" },
    liveGovernor: { status: 409, code: "actor_registered" },
    earlierGovernor: { status: 200, code: null },
  });
  expect({
    live: await residents(liveResidency),
    stray: await residents(strayResidency),
    gone: await residents(goneResidency),
  }).toEqual({
    live: { residents: 1, alarm: true },
    stray: { residents: 1, alarm: true },
    gone: { residents: null, alarm: false },
  });

  expect(
    await runInDurableObject(
      earlierGovernor,
      function readLedgerMarker(_actor, state) {
        return state.storage.get("journey-marker");
      },
    ),
  ).toBeUndefined();
  expect(await codeModePlatformGovernor(env).ping()).toMatchObject({
    ok: true,
  });

  // The live Organisation's Actors still answer.
  expect(await ingressRows(registered)).toBe(1);
  await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });

  task.meta.unregisteredActors = {
    withoutToken: "404",
    malformedIdentifier: "422",
    registeredConnector: "refused: actor_registered, storage intact",
    registeredOrganisationActor: "refused: actor_registered",
    unregisteredWithLiveOwner: "refused: actor_owner_exists, storage intact",
    earlierFormatConnector: "erased, no tables left",
    earlierOrganisationActor: "erased",
    served,
  };
}

type RegistryEntry =
  Awaited<ReturnType<typeof listOrganisationActorRegistryEntries>> extends
    { ok: true; value: readonly (infer Entry)[] } | { ok: false }
    ? Entry
    : never;

function isConnectorEntry(entry: RegistryEntry): boolean {
  return entry.identity.objectKind === "connector";
}

function requiredNamespace<T>(namespace: T | undefined): T {
  if (namespace === undefined) throw new Error("The namespace is not bound");
  return namespace;
}

/** The status of an erase, and the code of its refusal. */
async function outcome(
  response: Promise<Response>,
): Promise<{ status: number; code: unknown }> {
  const answered = await response;
  const body: { error?: { code?: unknown } } = await answered.json();
  return { status: answered.status, code: body.error?.code ?? null };
}

/** Gives a residency Actor its Organisation, one kept Actor and an alarm. */
async function storeResidency(
  stub: DurableObjectStub<ConversationResidencyActor>,
  owner: string,
): Promise<void> {
  await runInDurableObject(stub, async function storeRows(_actor, state) {
    const sql = state.storage.sql;
    sql.exec(
      "INSERT OR REPLACE INTO residency_scope (singleton, organisation_id, placement_json) VALUES (1, ?, '{}')",
      owner,
    );
    sql.exec(
      "INSERT OR REPLACE INTO resident_actor (physical_object_name, resident_until) VALUES ('journey', ?)",
      Date.now() + 3_600_000,
    );
    await state.storage.setAlarm(Date.now() + 3_600_000);
  });
}

/** The Actors that a residency Actor keeps, or null once its tables are gone. */
function residents(
  stub: DurableObjectStub<ConversationResidencyActor>,
): Promise<{ residents: number | null; alarm: boolean }> {
  return runInDurableObject(stub, async function read(_actor, state) {
    const sql = state.storage.sql;
    const present = sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'resident_actor'",
      )
      .toArray();
    return {
      residents:
        present.length === 0
          ? null
          : (sql.exec("SELECT COUNT(*) AS count FROM resident_actor").one()
              .count as number),
      alarm: (await state.storage.getAlarm()) !== null,
    };
  });
}

function erase(objectKind: string, objectId: string): Promise<Response> {
  return exports.default.fetch(
    new Request(REGISTRY_ROUTE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ORGANISATION_ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "erase_unregistered_actor",
        objectKind,
        objectId,
      }),
    }),
  );
}

async function storeConnector(
  stub: DurableObjectStub<ConnectorDO>,
  input: {
    readonly owner: string;
    readonly connectorId: string;
    readonly earlierFormat: boolean;
  },
): Promise<void> {
  await runInDurableObject(stub, function storeRows(_actor, state) {
    const sql = state.storage.sql;
    sql.exec(
      "INSERT OR REPLACE INTO connector_meta (singleton, organisation_id, connector_id) VALUES (1, ?, ?)",
      input.owner,
      input.connectorId,
    );
    sql.exec(
      "INSERT INTO connector_ingress (ingress_id, native_event_id, payload) VALUES ('ingress_journey', 'event_journey', ?)",
      JSON.stringify({ text: "A customer message" }),
    );
    if (input.earlierFormat)
      sql.exec(
        "ALTER TABLE connector_meta RENAME COLUMN organisation_id TO tenant_id",
      );
  });
}

/** The Connector's stored messages, or null once its tables are gone. */
function ingressRows(
  stub: DurableObjectStub<ConnectorDO>,
): Promise<number | null> {
  return runInDurableObject(stub, function countIngress(_actor, state) {
    const sql = state.storage.sql;
    const present = sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connector_ingress'",
      )
      .toArray();
    if (present.length === 0) return null;
    return sql.exec("SELECT COUNT(*) AS count FROM connector_ingress").one()
      .count as number;
  });
}

function required<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
