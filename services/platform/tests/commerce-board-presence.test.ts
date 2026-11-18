/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";
import { createActiveOrganisationFixture } from "./fixtures/organisation-activation";
import { parseOrganisationId } from "../src/ids";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

describe("ephemeral commerce board presence", () => {
  it("shares two operators on one board, isolates resources, and expires heartbeats", async () => {
    const parsedOrganisationId = parseOrganisationId(
      "organisation_board_presence",
    );
    if (!parsedOrganisationId.ok)
      throw new Error("organisation fixture is invalid");
    const organisationId = parsedOrganisationId.value;
    const fixture = emptySqliteFixture();
    const storage = new PresenceOrganisationStorage(
      sqlStorage(fixture.storage),
    );
    const organisation = await createActiveOrganisationFixture(
      { storage } as unknown as DurableObjectState,
      organisationId,
    );
    await organisation.ensureOrganisation({
      organisationId,
      name: "Board presence",
      plan: "beta",
      status: "active",
      createdAt: 1,
    });

    await organisation.updateCommerceBoardPresence({
      organisationId,
      userId: "user_a8dfe71a-75c9-5356-b230-29eb246a2fbc",
      displayName: "Operator Two",
      resourceKey: "commerce_list:export_coordination",
      selection: { kind: "none" },
      dragPreview: { kind: "idle" },
      now: 1_000,
    });
    const shared = await organisation.updateCommerceBoardPresence({
      organisationId,
      userId: "user_42d8499b-4f02-53e2-a0bc-6af86a5b4eb3",
      displayName: "Operator One",
      resourceKey: "commerce_list:export_coordination",
      selection: {
        kind: "list_entry",
        entryId: "entry_1",
        listId: "export_coordination",
      },
      dragPreview: {
        kind: "moving",
        entryId: "entry_1",
        desiredStatusId: "documents_ready",
      },
      now: 2_000,
    });

    expect(shared).toMatchObject({
      ok: true,
      value: [
        {
          userId: "user_42d8499b-4f02-53e2-a0bc-6af86a5b4eb3",
          dragPreview: { kind: "moving" },
        },
        {
          userId: "user_a8dfe71a-75c9-5356-b230-29eb246a2fbc",
          dragPreview: { kind: "idle" },
        },
      ],
    });
    await organisation.updateCommerceBoardPresence({
      organisationId,
      userId: "user_dd1c1c5a-6cf3-569a-a715-42df0ca10bef",
      displayName: "Other Board",
      resourceKey: "commerce_list:another_list",
      selection: { kind: "none" },
      dragPreview: { kind: "idle" },
      now: 3_000,
    });
    await expect(
      organisation.readCommerceBoardPresence({
        organisationId,
        resourceKey: "commerce_list:export_coordination",
        now: 3_000,
      }),
    ).resolves.toMatchObject({ ok: true, value: [{}, {}] });
    await expect(
      organisation.readCommerceBoardPresence({
        organisationId,
        resourceKey: "commerce_list:export_coordination",
        now: 32_000,
      }),
    ).resolves.toEqual({ ok: true, value: [] });
  });
});

class PresenceOrganisationStorage {
  constructor(readonly sql: SqlStorage) {}

  transactionSync<Value>(callback: () => Value): Value {
    return callback();
  }

  async getAlarm(): Promise<number | null> {
    return null;
  }

  async setAlarm(): Promise<void> {}

  async deleteAlarm(): Promise<void> {}
}
