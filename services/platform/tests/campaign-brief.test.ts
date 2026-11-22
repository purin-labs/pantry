import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { describe, expect, it } from "vitest";

import {
  decideCampaignBrief,
  listCaseCampaignBriefs,
  proposeCampaignBrief,
  type CampaignMessageVariant,
  type ProposeCampaignBriefInput,
} from "../src/data/campaign-brief";
import {
  createAgentOperationsDatabase,
  proposalFixtureAuthority,
} from "./agent-operations-database";
import { requireOrganisationId } from "./test-ids";

const ORGANISATION = requireOrganisationId("organisation_campaign");
const MERCHANT = "merchant_cafe";
const CASE = "case_autumn_markdown";
const NOW = 1_000;
const EXPIRES = 100_000;

describe("campaign briefs", () => {
  it("stages a brief for review with its targets, copy, budget, and window", async () => {
    const db = createDatabase();
    const proposed = await propose(db, {});
    expect(proposed.lifecycle).toBe("draft");
    expect(proposed.decidedAt).toBeNull();
    expect(proposed.decidedByPersonId).toBeNull();
    expect(proposed.targets).toEqual([
      { entityType: "offer", entityId: "offer_autumn_box", revision: 4 },
    ]);
    expect(proposed.requestedBudgetMinor).toBe(30_000);
    expect(proposed.currency).toBe("JPY");

    const listed = await listCaseCampaignBriefs({
      db,
      organisationId: ORGANISATION,
      caseId: CASE,
      now: NOW,
    });
    expect(listed.map((brief) => brief.briefId)).toEqual(["brief_autumn"]);
  });

  it("records a reviewer's edit when they accept", async () => {
    const db = createDatabase();
    await propose(db, {});
    const edited: CampaignMessageVariant[] = [
      {
        variantId: "v1",
        headline: "Autumn box, one week only",
        body: "Reviewed copy.",
      },
    ];
    const decided = await decideCampaignBrief({
      db,
      organisationId: ORGANISATION,
      briefId: "brief_autumn",
      expectedRevision: 1,
      decision: "accepted",
      decidedByPersonId: "person_owner",
      editedObjective: "Clear autumn boxes before the seasonal changeover.",
      editedMessageVariants: edited,
      now: NOW + 10,
    });
    expect(decided.ok).toBe(true);

    const listed = await listCaseCampaignBriefs({
      db,
      organisationId: ORGANISATION,
      caseId: CASE,
      now: NOW + 10,
    });
    const brief = listed[0];
    expect(brief?.lifecycle).toBe("accepted");
    expect(brief?.decidedByPersonId).toBe("person_owner");
    expect(brief?.objective).toBe(
      "Clear autumn boxes before the seasonal changeover.",
    );
    expect(brief?.messageVariants).toEqual(edited);
    // Acceptance changes the brief and nothing else: the targets it named are
    // untouched, because no path from here reaches commerce state.
    expect(brief?.targets).toEqual([
      { entityType: "offer", entityId: "offer_autumn_box", revision: 4 },
    ]);
  });

  it("refuses a second decision on a brief already decided", async () => {
    const db = createDatabase();
    await propose(db, {});
    await decide(db, 1, NOW + 10);
    const again = await decideCampaignBrief({
      db,
      organisationId: ORGANISATION,
      briefId: "brief_autumn",
      expectedRevision: 2,
      decision: "dismissed",
      decidedByPersonId: "person_owner",
      editedObjective: null,
      editedMessageVariants: null,
      now: NOW + 20,
    });
    expect(again).toEqual({
      ok: false,
      error: { code: "campaign_brief_conflict", field: "lifecycle" },
    });
  });

  it("refuses a decision on a brief past its window and shows it as expired", async () => {
    const db = createDatabase();
    await propose(db, {});
    const late = await decideCampaignBrief({
      db,
      organisationId: ORGANISATION,
      briefId: "brief_autumn",
      expectedRevision: 1,
      decision: "accepted",
      decidedByPersonId: "person_owner",
      editedObjective: null,
      editedMessageVariants: null,
      now: EXPIRES + 1,
    });
    expect(late).toEqual({
      ok: false,
      error: { code: "campaign_brief_conflict", field: "expiresAt" },
    });
    const listed = await listCaseCampaignBriefs({
      db,
      organisationId: ORGANISATION,
      caseId: CASE,
      now: EXPIRES + 1,
    });
    expect(listed[0]?.lifecycle).toBe("expired");
  });

  it("refuses a brief with no target, no copy, or no evidence", async () => {
    const db = createDatabase();
    expect(await proposeRaw(db, { targets: [] })).toMatchObject({
      ok: false,
      error: { code: "campaign_brief_invalid", field: "targets" },
    });
    expect(await proposeRaw(db, { messageVariants: [] })).toMatchObject({
      ok: false,
      error: { code: "campaign_brief_invalid", field: "messageVariants" },
    });
    expect(await proposeRaw(db, { supportingEvidence: "  " })).toMatchObject({
      ok: false,
      error: { code: "campaign_brief_invalid", field: "supportingEvidence" },
    });
  });

  it("refuses an operating window that ends before it starts", async () => {
    const db = createDatabase();
    expect(
      await proposeRaw(db, {
        windowStart: "2026-10-10T00:00:00.000Z",
        windowEnd: "2026-10-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "campaign_brief_invalid", field: "window" },
    });
  });

  it("refuses a decision with no deciding person", async () => {
    const db = createDatabase();
    await propose(db, {});
    expect(
      await decideCampaignBrief({
        db,
        organisationId: ORGANISATION,
        briefId: "brief_autumn",
        expectedRevision: 1,
        decision: "accepted",
        decidedByPersonId: "",
        editedObjective: null,
        editedMessageVariants: null,
        now: NOW + 10,
      }),
    ).toEqual({
      ok: false,
      error: { code: "campaign_brief_invalid", field: "decidedByPersonId" },
    });
  });
});

async function propose(
  db: SingleDatabase,
  overrides: Partial<ProposeCampaignBriefInput>,
) {
  const result = await proposeRaw(db, overrides);
  if (!result.ok)
    throw new Error(`brief proposal failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function proposeRaw(
  db: SingleDatabase,
  overrides: Partial<ProposeCampaignBriefInput>,
) {
  return proposeCampaignBrief({
    ...(await proposalFixtureAuthority(db, ORGANISATION)),
    briefId: "brief_autumn",
    merchantId: MERCHANT,
    caseId: CASE,
    objective: "Clear autumn boxes.",
    targets: [
      { entityType: "offer", entityId: "offer_autumn_box", revision: 4 },
    ],
    channel: "Storefront banner and the shop mailing list.",
    audienceDescription:
      "Customers who bought a seasonal box in the last year.",
    messageVariants: [
      { variantId: "v1", headline: "Autumn box", body: "Draft copy." },
    ],
    requestedBudgetMinor: 30_000,
    currency: "JPY",
    windowStart: "2026-10-01T00:00:00.000Z",
    windowEnd: "2026-10-08T00:00:00.000Z",
    disclosures: ["Prices include tax."],
    supportingEvidence:
      "Seven-day sales fell while available stock stayed flat.",
    expiresAt: EXPIRES,
    now: NOW,
    ...overrides,
  });
}

async function decide(
  db: SingleDatabase,
  expectedRevision: number,
  now: number,
): Promise<void> {
  const decided = await decideCampaignBrief({
    db,
    organisationId: ORGANISATION,
    briefId: "brief_autumn",
    expectedRevision,
    decision: "accepted",
    decidedByPersonId: "person_owner",
    editedObjective: null,
    editedMessageVariants: null,
    now,
  });
  if (!decided.ok)
    throw new Error(`brief decision failed: ${JSON.stringify(decided.error)}`);
}

function createDatabase(): SingleDatabase {
  return createAgentOperationsDatabase(ORGANISATION);
}
