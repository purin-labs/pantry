import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { describe, expect, it } from "vitest";

import { readAgentOperations } from "@purin-labs/agent/data/agent-operations";
import {
  createOperatorConfigurationDraft,
  readPendingOperatorDraft,
} from "@purin-labs/area-organisation/server/data/operator-configuration-draft";
import { renderConfigurationPreview } from "@purin-labs/surface-slack/server/configuration-presentation";
import {
  resolveSlackConfigurationReply,
  type SlackOperatorIdentity,
} from "@purin-labs/surface-slack/server/configuration-reply";
import {
  createAgentOperationsDatabase,
  proposalFixtureAuthority,
} from "./agent-operations-database";
import { requireOrganisationId } from "./test-ids";

const ORGANISATION = requireOrganisationId("organisation_slack_reply");
const CASE = "case_slack";
const PORTAL = "https://portal.example/agents";
const NOW = 1_000;
const EXPIRES = 100_000;

const OWNER: SlackOperatorIdentity = {
  userId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
  personId: "person_owner",
  commandPermitted: true,
  role: "admin",
};

describe("Slack configuration replies", () => {
  it("leaves ordinary conversation to the agent", async () => {
    const db = createDatabase();
    await stageDraft(db);
    for (const text of [
      "what needs attention today?",
      "yes",
      "thanks",
      "go ahead",
    ]) {
      expect(await resolve(db, text), text).toEqual({
        kind: "not_a_configuration_reply",
      });
    }
    // Nothing was applied by any of them.
    expect((await readAgentOperations(db, ORGANISATION)).areas).toEqual([]);
  });

  it("applies the change when the operator repeats the action words", async () => {
    const db = createDatabase();
    await stageDraft(db);
    const outcome = await resolve(db, await acceptWords(db));
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    expect(outcome.message.text).toContain("Merchant operations");
    expect(outcome.message.text).toContain(PORTAL);
    expect(
      (await readAgentOperations(db, ORGANISATION)).areas.map((area) => area.name),
    ).toEqual(["Merchant operations"]);
  });

  it("reports the recorded outcome when a confirmation is repeated", async () => {
    const db = createDatabase();
    await stageDraft(db);
    const words = await acceptWords(db);
    expect((await resolve(db, words)).kind).toBe("applied");

    // An operator whose answer was lost repeats it. Telling them the change
    // was already made beats silence, and must not apply it a second time.
    const again = await resolve(db, words);
    expect(again.kind).toBe("applied");
    if (again.kind !== "applied") return;
    expect(again.message.text).toContain("Merchant operations");
    expect((await readAgentOperations(db, ORGANISATION)).areas).toHaveLength(1);
  });

  it("re-drives a change that was confirmed but never applied", async () => {
    const db = createDatabase();
    await stageDraft(db);
    const words = await acceptWords(db);
    // An interruption between claiming the draft and applying it leaves the
    // operator having confirmed a change that never happened.
    await db
      .prepare(
        `UPDATE operator_configuration_draft SET state = 'confirmed', decided_at = ?
        WHERE organisation_id = ? AND state = 'pending'`,
      )
      .bind(NOW + 5, ORGANISATION)
      .run();
    expect((await readAgentOperations(db, ORGANISATION)).areas).toEqual([]);

    const retried = await resolve(db, words);
    expect(retried.kind).toBe("applied");
    expect(
      (await readAgentOperations(db, ORGANISATION)).areas.map((area) => area.name),
    ).toEqual(["Merchant operations"]);
  });

  it("refuses a colleague who did not ask for the change", async () => {
    const db = createDatabase();
    await stageDraft(db);
    const outcome = await resolve(db, await acceptWords(db), {
      userId: "user_b6440965-c6be-5c35-9d89-51941587f453",
      personId: "person_colleague",
      commandPermitted: true,
      role: "admin",
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.message.text).toContain("person_owner");
    expect((await readAgentOperations(db, ORGANISATION)).areas).toEqual([]);
  });

  it("refuses someone whose membership cannot change configuration", async () => {
    const db = createDatabase();
    await stageDraft(db);
    const outcome = await resolve(db, await acceptWords(db), {
      ...OWNER,
      commandPermitted: false,
      role: "operator",
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.message.text).toContain("owner or admin");
    expect((await readAgentOperations(db, ORGANISATION)).areas).toEqual([]);
  });

  it("refuses a confirmation after the change timed out", async () => {
    const db = createDatabase();
    await stageDraft(db);
    const words = await acceptWords(db);
    const outcome = await resolve(db, words, OWNER, EXPIRES + 1);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.message.text).toContain("timed out");
    expect((await readAgentOperations(db, ORGANISATION)).areas).toEqual([]);
  });

  it("lets the operator drop the change", async () => {
    const db = createDatabase();
    await stageDraft(db);
    const outcome = await resolve(db, "Cancel");
    expect(outcome.kind).toBe("cancelled");
    expect((await readAgentOperations(db, ORGANISATION)).areas).toEqual([]);
    // With nothing pending, later messages go back to the agent.
    expect(await resolve(db, "Create area ABC123")).toEqual({
      kind: "not_a_configuration_reply",
    });
  });

  it("does not treat another change's words as a confirmation", async () => {
    const db = createDatabase();
    await stageDraft(db);
    expect(await resolve(db, "Publish instructions")).toEqual({
      kind: "not_a_configuration_reply",
    });
    // The right action with some other preview's code is a confirmation of
    // something else, not chat, and must not silently apply this one.
    expect((await resolve(db, "Create area ABC123")).kind).toBe("refused");
    expect((await readAgentOperations(db, ORGANISATION)).areas).toEqual([]);
  });

  it("has nothing to confirm when no change is waiting", async () => {
    const db = createDatabase();
    expect(await resolve(db, "Create area ABC123")).toEqual({
      kind: "not_a_configuration_reply",
    });
  });
});

/** The words a preview tells the operator to reply with. */
async function acceptWords(db: SingleDatabase): Promise<string> {
  const draft = await readPendingOperatorDraft({
    db,
    organisationId: ORGANISATION,
    caseId: CASE,
    now: NOW,
  });
  if (draft === null) throw new Error("no pending draft");
  const preview = renderConfigurationPreview(draft);
  if (preview.kind !== "preview") throw new Error("expected a preview");
  return preview.actionLabel;
}

async function stageDraft(db: SingleDatabase): Promise<void> {
  const draft = await createOperatorConfigurationDraft({
    ...(await proposalFixtureAuthority(db, ORGANISATION)),
    draftId: "draft_slack",
    caseId: CASE,
    actorUserId: OWNER.userId,
    actorPersonId: OWNER.personId,
    rawCommand: {
      kind: "create_area",
      name: "Merchant operations",
      purpose: "Answer merchant questions and stage governed changes.",
    },
    mutationId: "mutation_slack",
    now: NOW,
    expiresAt: EXPIRES,
  });
  if (!draft.ok)
    throw new Error(`draft staging failed: ${JSON.stringify(draft.error)}`);
}

function resolve(
  db: SingleDatabase,
  text: string,
  operator: SlackOperatorIdentity = OWNER,
  now: number = NOW + 10,
) {
  return resolveSlackConfigurationReply({
    db,
    env: { DB: db, PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({ databaseBinding: "DB", kind: "affinity", placementCellId: "test", locationHint: "wnam" }) } as unknown as import("@purin-labs/kernel/env").Env,
    organisationId: ORGANISATION,
    caseId: CASE,
    operator,
    text,
    portalUrl: PORTAL,
    now,
  });
}

function createDatabase(): SingleDatabase {
  return createAgentOperationsDatabase(ORGANISATION);
}
