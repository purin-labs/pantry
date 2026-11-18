// Plan 77 step 4: a merchant plugin adds its own entity types. "Pickup
// closures" adds a `pickup_closure` type (a day and a reason) and a
// `pickup_notice` type to the entity plane; both are published at the
// installation's revision, and a change page of one revision holds both. Its
// checkout rule refuses a pickup on a closed day. Staff close
// the shop on the day of a buyer's pickup through the entity plane: the next
// checkout is refused with the closure's reason, and archiving the closure
// lets it through. Version 2 adds a note to the type: the type gets its next
// revision, and the closure written at revision 1 still refuses the pickup,
// also for the version's new action.
// A type that the merchant made, or that another plugin owns, cannot be taken
// over, and removing the plugin keeps the type and its records. Set
// PLUGIN_ENTITY_TYPES_ARTIFACT_DIR to keep the run's evidence; the file
// repeats byte for byte for the same commit.
import {
  CommerceEntityPlaneClient,
  parseCommerceEntityPlaneCommand,
  parseEntityPlaneCommand,
  type CommerceAdminClient,
  type CommercePluginEntityTypeV1,
} from "@seams/commerce-client";
import type { PluginDefinition } from "@seams/commerce-contracts";
import { expect, it } from "vitest";

import {
  BASE_URL,
  Buyer,
  NOW,
  SERVICE_TOKEN,
  catalogLine,
  merchantId,
  organisationId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const CLOSURES = `
function run(input) {
  const day = input.checkout.readyBy.slice(0, 10);
  const refusals = [];
  for (const closure of input.records.pickup_closure)
    if (closure.values.day === day)
      refusals.push({ message: "The shop is closed on " + day + ": " +
        closure.values.reason + "." });
  return { refusals };
}`;

// Staff ask why a day is closed; the action reads the same records.
const REASON = `
function run(input) {
  const closure = input.records.pickup_closure.find((item) =>
    item.values.day === input.input.day);
  return closure === undefined ? {} :
    { refusals: [{ message: "Closed: " + closure.values.reason }] };
}`;

function closureType(note: boolean): CommercePluginEntityTypeV1 {
  return {
    typeId: "pickup_closure",
    label: "Pickup closure",
    description: "A day on which the shop hands out no pickups.",
    attributes: [
      { key: "day", label: "Day", valueKind: "date", required: true },
      {
        key: "reason",
        label: "Reason",
        valueKind: "short_text",
        required: true,
      },
      ...(note
        ? [
            {
              key: "note",
              label: "Note for staff",
              valueKind: "short_text" as const,
              required: false,
            },
          ]
        : []),
    ],
  };
}

function noticeType(): CommercePluginEntityTypeV1 {
  return {
    typeId: "pickup_notice",
    label: "Pickup notice",
    description: "A note that buyers see for pickups on a day.",
    attributes: [
      { key: "day", label: "Day", valueKind: "date", required: true },
      {
        key: "message",
        label: "Message",
        valueKind: "short_text",
        required: true,
      },
    ],
  };
}

const BOTH_TYPES = ["pickup_closure", "pickup_notice"];

function plugin(
  pluginId: string,
  version: number,
  entityTypes: readonly string[],
): PluginDefinition {
  return {
    pluginId,
    version,
    kind: "merchant",
    title: "Pickup closures",
    purpose: "No pickup on a day that staff close the shop.",
    requirements: {
      hookPoints: ["checkout.validate"],
      reads: [],
      commands: [],
      dependsOn: [],
    },
    contributions: {
      routes: [],
      pipelineSteps: [],
      entityTypes: [...entityTypes],
      settings: [],
      functions: [
        {
          functionId: "closed_days",
          hookPoint: "checkout.validate",
          required: false,
          source: CLOSURES,
        },
      ],
    },
    limits: {
      instructionBudget: 100,
      memoryBytes: 8 * 1024 * 1024,
      outputBytes: 16 * 1024,
    },
  };
}

it(
  "lets a plugin add an entity type whose records staff write and its rule reads",
  { timeout: 90_000 },
  pluginEntityTypes,
);

async function pluginEntityTypes(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new ClosureDesk(admin);
    const plane = new EntityPlane(
      new CommerceEntityPlaneClient({
        baseUrl: BASE_URL,
        serviceToken: SERVICE_TOKEN,
        fetch: backend.fetch,
      }),
    );
    await staff.createTea();
    // The merchant has its own type already.
    await plane.apply("own_type", {
      kind: "create_custom_entity_type",
      command: {
        draft: {
          typeId: "staff_note",
          revision: 1,
          label: "Staff note",
          description: "A note that staff keep.",
          attributes: [],
        },
      },
    });

    // A plugin cannot take over the merchant's type, and a version names
    // exactly the types that the installation brings.
    const takeOver = {
      ...closureType(false),
      typeId: "staff_note",
    };
    const refusedInstalls = {
      merchantType: await staff.install(
        plugin("pickup_closures", 1, ["staff_note"]),
        [takeOver],
        null,
      ),
      unnamed: await staff.install(
        plugin("pickup_closures", 1, ["pickup_closure"]),
        undefined,
        null,
      ),
      mismatched: await staff.install(
        plugin("pickup_closures", 1, []),
        [closureType(false)],
        null,
      ),
    };
    expect(refusedInstalls).toMatchObject({
      merchantType: rejectedWith({ field: "plugin.entityTypes" }),
      unnamed: rejectedWith({ field: "plugin.entityTypes" }),
      mismatched: rejectedWith({ field: "plugin.entityTypes" }),
    });

    const before = await plane.revision();
    const installed = await staff.install(
      plugin("pickup_closures", 1, BOTH_TYPES),
      [closureType(false), noticeType()],
      null,
    );
    expect(installed).toMatchObject({ outcome: "applied" });
    // The entity plane publishes both types at the installation's revision;
    // a page of one revision holds both.
    const typeChanges = await plane.changesAfter(before, 1);
    expect(typeChanges).toEqual(
      BOTH_TYPES.map((typeId) => ({
        resource: {
          kind: "entity_type",
          typeId: { origin: "custom", typeId },
        },
        operation: "published",
      })),
    );

    const checkout = async (name: string) =>
      Buyer.start(buyer, `closures_${name}`).then((shopper) =>
        shopper.tryQuote([catalogLine(SMALL_SENCHA)]),
      );
    const open = await checkout("open");
    if (open.kind !== "quoted") throw new Error("The open day was refused");
    const day = open.checkout.quote.pickup.readyAt.slice(0, 10);

    // Staff close the shop on that day through the entity plane.
    await plane.apply("close_day", closure("closure_1", 1, day, "Stocktake"));
    const closed = await checkout("closed");
    expect(closed).toEqual({
      kind: "refused",
      error: {
        code: "checkout_refused",
        pluginId: "pickup_closures",
        message: `The shop is closed on ${day}: Stocktake.`,
      },
    });

    // Version 2 adds a note: the type's next revision, and the closure
    // written at revision 1 still closes the day.
    const upgraded = await staff.install(
      plugin("pickup_closures", 2, BOTH_TYPES),
      [closureType(true), noticeType()],
      installedRevision(installed),
    );
    expect(upgraded).toMatchObject({ outcome: "applied" });
    expect((await checkout("after_upgrade")).kind).toBe("refused");
    const asked = await staff.askWhy(day);
    expect(asked).toMatchObject(
      rejectedWith({
        code: "action_refused",
        actionId: "closure_reason",
        message: "Closed: Stocktake",
      }),
    );
    const revisionTwo = await plane.apply(
      "close_next_day",
      closure("closure_2", 2, "2099-01-01", "New year"),
    );
    // The same types again publish nothing new.
    const again = await plane.revision();
    expect(
      await staff.install(
        plugin("pickup_closures", 2, BOTH_TYPES),
        [closureType(true), noticeType()],
        installedRevision(upgraded),
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(await plane.changesAfter(again)).toEqual([]);

    // Archiving the closure opens the day again.
    await plane.apply("open_day", {
      kind: "archive_custom_entity",
      command: {
        entityRef: {
          origin: "custom",
          typeId: "pickup_closure",
          entityId: "closure_1",
        },
        expectedRevision: 1,
        archivedAt: NOW,
      },
    });
    expect((await checkout("reopened")).kind).toBe("quoted");

    // Another plugin cannot take the type over.
    expect(
      await staff.install(
        plugin("closure_copy", 1, ["pickup_closure"]),
        [closureType(true)],
        null,
      ),
    ).toMatchObject(rejectedWith({ field: "plugin.entityTypes" }));

    // Removing the plugin keeps the type and its records.
    const listed = (await required(admin.listPlugins(merchantId))).plugins;
    const current = listed.find((item) => item.pluginId === "pickup_closures");
    if (current === undefined) throw new Error("The plugin is missing");
    expect(current.contributions.entityTypes).toEqual(BOTH_TYPES);
    expect(await staff.remove(current.revision)).toMatchObject({
      outcome: "applied",
    });
    expect(
      await plane.apply(
        "close_after_removal",
        closure("closure_3", 2, "2099-01-02", "Holiday"),
      ),
    ).toMatchObject({ result: { status: "accepted" } });
    expect((await checkout("removed")).kind).toBe("quoted");

    Object.assign(evidence, {
      receipts: staff.receipts,
      refusedInstalls,
      typeChanges,
      day,
      closed,
      asked,
      revisionTwo: revisionTwo.result,
    });
  } finally {
    writeEvidence(
      "PLUGIN_ENTITY_TYPES_ARTIFACT_DIR",
      "plugin-entity-types",
      evidence,
    );
    backend.close();
  }
}

function installedRevision(result: unknown): number {
  const revision = (
    result as { receipt?: { resource?: { revision?: number } } }
  ).receipt?.resource?.revision;
  if (revision === undefined) throw new Error("The install has no revision");
  return revision;
}

function closure(
  entityId: string,
  typeRevision: number,
  day: string,
  reason: string,
) {
  const scope = {
    kind: "custom",
    entityTypeId: "pickup_closure",
    typeRevision,
  };
  return {
    kind: "create_custom_entity",
    command: {
      entityId,
      typeId: "pickup_closure",
      typeRevision,
      displayName: `Closed ${day}`,
      sensitivity: "internal",
      attributes: [
        {
          attributeId: "day",
          scope,
          definitionRevision: typeRevision,
          sensitivity: "internal",
          value: { kind: "date", value: day },
        },
        {
          attributeId: "reason",
          scope,
          definitionRevision: typeRevision,
          sensitivity: "internal",
          value: { kind: "short_text", value: reason },
        },
      ],
    },
  };
}

class ClosureDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "plugin_entity_types");
  }

  install(
    definition: PluginDefinition,
    entityTypes: readonly CommercePluginEntityTypeV1[] | undefined,
    expectedRevision: number | null,
  ) {
    return this.edit(
      this.admin.installMerchantPlugin({
        ...this.editBase(`install_${definition.pluginId}_${this.step}`),
        definition,
        settings: {},
        ...(entityTypes === undefined ? {} : { entityTypes }),
        ...(definition.version === 2
          ? {
              actions: [
                {
                  actionId: "closure_reason",
                  title: "Why is a day closed?",
                  inputs: [
                    { key: "day", valueKind: "text", description: "The day" },
                  ],
                  source: REASON,
                },
              ],
            }
          : {}),
        expectedRevision,
      }),
    );
  }

  askWhy(day: string) {
    return this.edit(
      this.admin.runPluginAction({
        ...this.editBase(`ask_${day}`),
        pluginId: "pickup_closures",
        actionId: "closure_reason",
        input: { day },
      }),
    );
  }

  remove(expectedRevision: number) {
    return this.edit(
      this.admin.removePlugin({
        ...this.editBase("remove_closures"),
        pluginId: "pickup_closures",
        expectedRevision,
      }),
    );
  }
}

/** Staff's entity plane commands, as an operator with full authority. */
class EntityPlane {
  readonly #client: CommerceEntityPlaneClient;

  constructor(client: CommerceEntityPlaneClient) {
    this.#client = client;
  }

  async revision(): Promise<number> {
    const result = await this.#client.publishedResourceMetadata({
      kind: "enumerate",
      organisationId,
      merchantId,
    });
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.kind !== "enumerated")
      throw new Error("Expected enumerated metadata");
    return Number(result.value.merchantRevision);
  }

  async changesAfter(revision: number, limit?: number) {
    const result = await this.#client.changes(
      merchantId,
      revision as Parameters<CommerceEntityPlaneClient["changes"]>[1],
      limit,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value.changes.map(({ resource, operation }) => ({
      resource,
      operation,
    }));
  }

  async apply(commandId: string, raw: unknown) {
    const command = parseCommerceEntityPlaneCommand(raw);
    const context = {
      organisationId,
      merchantId,
      principalId: "operator",
      sensitivityCeiling: "restricted",
      expiresAt: "2099-01-01T00:00:00Z",
      causation: { kind: "command", commandId },
    };
    const authority = (() => {
      switch (command.kind) {
        case "create_custom_entity_type":
          return {
            kind: "custom_entity_type_create",
            context,
            scope: {
              kind: "entity_type",
              entityTypeId: {
                origin: "custom",
                typeId: command.command.draft.typeId,
              },
            },
            target: { typeId: command.command.draft.typeId },
          };
        case "create_custom_entity":
          return {
            kind: "entity_create",
            context,
            scope: {
              kind: "entity_type",
              entityTypeId: {
                origin: "custom",
                typeId: command.command.typeId,
              },
            },
            target: {
              entityId: command.command.entityId,
              typeId: command.command.typeId,
            },
          };
        case "archive_custom_entity": {
          const target = {
            entityRef: command.command.entityRef,
            expectedRevision: command.command.expectedRevision,
          };
          return {
            kind: "entity_command",
            context,
            scope: { kind: "entity", entityRef: target.entityRef },
            target,
          };
        }
        default:
          throw new Error(`Unexpected entity plane command ${command.kind}`);
      }
    })();
    const request = parseEntityPlaneCommand({
      organisationId,
      merchantId,
      commandId,
      expectedMerchantRevision: await this.revision(),
      authority,
      command,
    });
    const result = await this.#client.command(request);
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.status !== "accepted")
      throw new Error(`${commandId} refused: ${result.value.error.code}`);
    return { result: result.value };
  }
}
