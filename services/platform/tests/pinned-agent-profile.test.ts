import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { proposalFixtureAuthority } from "./agent-operations-database";
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  applyAgentOperation,
  type AgentOperationCommand,
} from "@purin-labs/agent/data/agent-operations";
import {
  composeAgentInstructions,
  parseAgentProfileSelection,
  resolveCaseTurnAgentProfile,
  resolvePinnedAgentProfile,
} from "@purin-labs/agent/data/pinned-agent-profile";
import { createAgentOperationsDatabase } from "./agent-operations-database";
import { requireOrganisationId } from "./test-ids";

const ORGANISATION = requireOrganisationId("organisation_urk");
const HARNESS = "You are Sous Chef, a governed commerce agent in Purin Pantry.";

describe("pinned agent profile", () => {
  it("composes the harness rules, published instructions, and pinned skills", async () => {
    const db = createDatabase();
    await seedAgent(db);

    const profile = await resolvePinnedAgentProfile(
      db,
      ORGANISATION,
      "installation_urk",
      [
        { skillId: "skill_insights", revision: 1 },
        { skillId: "skill_pricing", revision: 1 },
      ],
      null,
    );
    if (!profile.ok) {
      throw new Error(`profile unavailable: ${profile.error.code}`);
    }

    expect(profile.value.instructions).toBe(
      "Ground every claim in returned evidence.",
    );
    expect(profile.value.skills.map((skill) => skill.skillId)).toEqual([
      "skill_insights",
      "skill_pricing",
    ]);

    const composed = composeAgentInstructions(HARNESS, profile.value);
    expect(composed.startsWith(HARNESS)).toBe(true);
    expect(composed).toContain("Ground every claim in returned evidence.");
    expect(composed).toContain(
      "Report the operating window with every number.",
    );
    expect(composed).toContain("Show the price change in minor units.");
    // The definition revision's order is the prompt's order.
    expect(composed.indexOf("Report the operating window")).toBeLessThan(
      composed.indexOf("Show the price change"),
    );
  });

  it("keeps the platform rules alone when no agent is installed", async () => {
    const db = createDatabase();
    expect(
      await resolveCaseTurnAgentProfile(
        (await proposalFixtureAuthority(db, ORGANISATION)).scope,
        {
          caseId: "case_1",
          assignmentId: "assignment_1",
          assignment: "new",
          selection: parseAgentProfileSelection(""),
          now: 500,
        },
      ),
    ).toEqual({ kind: "unselected" });
    expect(composeAgentInstructions(HARNESS, null)).toBe(HARNESS);
  });

  it("refuses a profile whose pinned skill revision no longer resolves", async () => {
    const db = createDatabase();
    await seedAgent(db);
    const profile = await resolvePinnedAgentProfile(
      db,
      ORGANISATION,
      "installation_urk",
      [{ skillId: "skill_insights", revision: 4 }],
      null,
    );
    expect(profile).toEqual({
      ok: false,
      error: { code: "pinned_agent_skill_missing" },
    });
  });

  it("distinguishes an unavailable recorded profile from no selected agent", async () => {
    const db = createDatabase();
    await seedAgent(db);
    const input = {
      caseId: "case_missing",
      assignmentId: "assignment_missing",
      assignment: "new" as const,
      selection: parseAgentProfileSelection(""),
      now: 500,
    };
    const initial = await resolveCaseTurnAgentProfile(
      (await proposalFixtureAuthority(db, ORGANISATION)).scope,
      input,
    );
    expect(initial.kind).toBe("resolved");
    await db
      .prepare("DELETE FROM skill_revision WHERE skill_id = ?")
      .bind("skill_insights")
      .run();
    expect(
      await resolveCaseTurnAgentProfile(
        (await proposalFixtureAuthority(db, ORGANISATION)).scope,
        input,
      ),
    ).toEqual({
      kind: "unavailable",
      error: { code: "pinned_agent_skill_missing" },
    });
  });

  it("runs the revision an installation activated, not the newest published one", async () => {
    const db = createDatabase();
    await seedAgent(db);
    await apply(db, {
      kind: "publish_agent_definition_revision",
      agentDefinitionId: "agent_urk",
      expectedRevision: 1,
      instructions: "Never answer without a source record.",
      requestedCapabilities: ["commerce.entity_plane.context"],
      skillRefs: [{ skillId: "skill_insights", revision: 1 }],
      operationId: "agent_urk_revision_2",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 200,
    });

    const beforeActivation = await resolvePinnedAgentProfile(
      db,
      ORGANISATION,
      "installation_urk",
      [],
      null,
    );
    if (!beforeActivation.ok) {
      throw new Error("profile unavailable");
    }
    expect(beforeActivation.value.definitionRevision).toBe(1);
    expect(beforeActivation.value.instructions).toBe(
      "Ground every claim in returned evidence.",
    );

    await apply(db, {
      kind: "activate_agent_definition_revision",
      installationId: "installation_urk",
      expectedDefinitionRevision: 1,
      definitionRevision: 2,
      skillRefs: [{ skillId: "skill_insights", revision: 1 }],
      operationId: "activation_urk",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 201,
    });

    const afterActivation = await resolvePinnedAgentProfile(
      db,
      ORGANISATION,
      "installation_urk",
      [],
      null,
    );
    if (!afterActivation.ok) {
      throw new Error("profile unavailable");
    }
    expect(afterActivation.value.definitionRevision).toBe(2);
    expect(afterActivation.value.instructions).toBe(
      "Never answer without a source record.",
    );
  });

  it("keeps a conversation pin and selects an addressed agent after activation with two installations", async () => {
    const db = createDatabase();
    await seedAgent(db);
    const first = await resolveCaseTurnAgentProfile(
      (await proposalFixtureAuthority(db, ORGANISATION)).scope,
      {
        caseId: "case_new",
        assignmentId: "assignment_new",
        assignment: "new",
        selection: parseAgentProfileSelection(""),
        now: 500,
      },
    );
    if (first.kind !== "resolved") {
      throw new Error("Profile unavailable");
    }
    expect(first.profile.installationId).toBe("installation_urk");
    expect(first.profile.definitionRevision).toBe(1);
    expect(first.profile.skills.map((skill) => skill.skillId)).toEqual([
      "skill_insights",
      "skill_pricing",
    ]);

    // A later activation must not re-point the Case that already pinned.
    await apply(db, {
      kind: "publish_agent_definition_revision",
      agentDefinitionId: "agent_urk",
      expectedRevision: 1,
      instructions: "Never answer without a source record.",
      requestedCapabilities: ["commerce.entity_plane.context"],
      skillRefs: [{ skillId: "skill_insights", revision: 1 }],
      operationId: "agent_urk_revision_2",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 501,
    });
    await apply(db, {
      kind: "activate_agent_definition_revision",
      installationId: "installation_urk",
      expectedDefinitionRevision: 1,
      definitionRevision: 2,
      skillRefs: [{ skillId: "skill_insights", revision: 1 }],
      operationId: "activation_urk_later",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 502,
    });

    await seedSupportAgent(db);

    const later = await resolveCaseTurnAgentProfile(
      (await proposalFixtureAuthority(db, ORGANISATION)).scope,
      {
        caseId: "case_new",
        assignmentId: "assignment_new",
        assignment: "existing",
        selection: parseAgentProfileSelection(""),
        now: 503,
      },
    );
    if (later.kind !== "resolved") {
      throw new Error("Profile unavailable");
    }
    expect(later.profile.skills.map((skill) => skill.skillId)).toEqual([
      "skill_insights",
      "skill_pricing",
    ]);
    // The instructions must not move either. Keeping the old skills while
    // adopting the new instructions would compose a prompt that mixes
    // revisions, which is worse than either revision on its own.
    expect(later.profile.definitionRevision).toBe(1);
    expect(later.profile.instructions).toBe(
      "Ground every claim in returned evidence.",
    );

    // A new assignment adopts the activated configuration.
    const fresh = await resolveCaseTurnAgentProfile(
      (await proposalFixtureAuthority(db, ORGANISATION)).scope,
      {
        caseId: "case_after",
        assignmentId: "assignment_after",
        assignment: "new",
        selection: parseAgentProfileSelection(
          "<@U012345> Agent Urk: Which orders need attention?",
        ),
        now: 504,
      },
    );
    if (fresh.kind !== "resolved") {
      throw new Error("Profile unavailable");
    }
    expect(fresh.profile.definitionRevision).toBe(2);
    expect(fresh.profile.instructions).toBe(
      "Never answer without a source record.",
    );
    expect(fresh.profile.installationId).toBe("installation_urk");
    const followUp = await resolveCaseTurnAgentProfile(
      (await proposalFixtureAuthority(db, ORGANISATION)).scope,
      {
        caseId: "case_after",
        assignmentId: "assignment_after",
        assignment: "existing",
        selection: parseAgentProfileSelection("What happened with this order?"),
        now: 505,
      },
    );
    expect(followUp).toEqual(fresh);
    const unavailable = await resolveCaseTurnAgentProfile(
      (await proposalFixtureAuthority(db, ORGANISATION)).scope,
      {
        caseId: "case_unknown",
        assignmentId: "assignment_unknown",
        assignment: "new",
        selection: parseAgentProfileSelection(
          "Agent Missing: Which orders need attention?",
        ),
        now: 506,
      },
    );
    expect(unavailable).toEqual({
      kind: "unavailable",
      error: { code: "pinned_agent_installation_not_found" },
    });
    const directory = resolve(
      import.meta.dirname,
      "../../../output/acceptance/plan39-agent-selection",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "selection.json"),
      JSON.stringify(
        {
          scenario:
            "Explicit Slack agent selection with two active installations and a later activation",
          first,
          fresh,
          followUp,
          unavailable,
        },
        null,
        2,
      ),
    );
  });
});

async function seedSupportAgent(db: SingleDatabase): Promise<void> {
  await apply(db, {
    kind: "create_agent_definition",
    displayName: "WhatsApp support agent",
    role: "customer_support",
    purpose: "Review customer support messages.",
    instructions: "Review incoming support messages.",
    requestedCapabilities: [],
    skillRefs: [],
    operationId: "agent_support",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: 502,
  });
  await apply(db, {
    kind: "install_agent",
    agentDefinitionId: "agent_support",
    definitionRevision: 1,
    areaId: "area_urk",
    responsibility: "Review incoming support messages.",
    scopeIds: [],
    policyRevision: 1,
    grantedCapabilities: [],
    operationId: "installation_support",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: 502,
  });
}

async function apply(
  db: SingleDatabase,
  command: AgentOperationCommand,
): Promise<void> {
  const result = await applyAgentOperation(db, ORGANISATION, command);
  if (!result.ok) {
    throw new Error(`agent operation failed: ${result.error.code}`);
  }
}

async function seedAgent(db: SingleDatabase): Promise<void> {
  await apply(db, {
    kind: "create_area",
    name: "Merchant operations",
    purpose: "Operate the merchant's day.",
    operationId: "area_urk",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: 100,
  });
  await apply(db, {
    kind: "create_skill",
    title: "Performance insights",
    sensitivity: "ordinary",
    markdownBody: "Report the operating window with every number.",
    operationId: "skill_insights",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: 101,
  });
  await apply(db, {
    kind: "create_skill",
    title: "Pricing and promotions",
    sensitivity: "ordinary",
    markdownBody: "Show the price change in minor units.",
    operationId: "skill_pricing",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: 102,
  });
  await apply(db, {
    kind: "create_agent_definition",
    displayName: "Urk",
    role: "merchant_operator",
    purpose: "Answer merchant questions and stage governed changes.",
    instructions: "Ground every claim in returned evidence.",
    requestedCapabilities: ["commerce.entity_plane.context"],
    skillRefs: [
      { skillId: "skill_insights", revision: 1 },
      { skillId: "skill_pricing", revision: 1 },
    ],
    operationId: "agent_urk",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: 103,
  });
  await apply(db, {
    kind: "install_agent",
    agentDefinitionId: "agent_urk",
    definitionRevision: 1,
    areaId: "area_urk",
    responsibility: "Own merchant operations.",
    scopeIds: [],
    policyRevision: 1,
    grantedCapabilities: ["commerce.entity_plane.context"],
    operationId: "installation_urk",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: 104,
  });
}

function createDatabase(): SingleDatabase {
  return createAgentOperationsDatabase(ORGANISATION);
}
