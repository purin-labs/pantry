import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { describe, expect, it } from "vitest";

import {
  applyAgentOperation,
  readAgentOperations,
} from "../src/data/agent-operations";
import {
  merchantAgentInstallationId,
  MERCHANT_AGENT_READ_CAPABILITY,
  installMerchantAgent,
  merchantAgentDefaultSkills,
  merchantAgentSkillId,
} from "../src/data/merchant-agent-preset";
import { merchantAgentAgentId } from "../src/data/merchant-agent-ids";
import { merchantAgentSkill } from "../src/data/merchant-agent-skills";
import { merchantAgentAreaId } from "../src/data/merchant-agent-preset";
import { createAgentOperationsDatabase } from "./agent-operations-database";
import { requireOrganisationId } from "./test-ids";

const ORGANISATION = requireOrganisationId("organisation_urk_install");

describe("Urk installation", () => {
  it("installs Urk as an ordinary agent through the configuration commands", async () => {
    const db = createDatabase();
    const installed = await install(db);

    const snapshot = await readAgentOperations(db, ORGANISATION);
    const definition = snapshot.definitions.find(
      (entry) => entry.agentDefinitionId === merchantAgentAgentId(ORGANISATION),
    );
    expect(definition?.displayName).toBe("Sous Chef");
    expect(definition?.currentRevision.requestedCapabilities).toEqual([
      MERCHANT_AGENT_READ_CAPABILITY,
    ]);
    expect(definition?.currentRevision.skillRefs).toEqual(installed.skillRefs);
    expect(installed.skillRefs.map((ref) => ref.skillId)).toEqual(
      merchantAgentDefaultSkills().map((name) => merchantAgentSkillId(ORGANISATION, name)),
    );

    const installation = snapshot.installations.find(
      (entry) => entry.installationId === merchantAgentInstallationId(ORGANISATION),
    );
    expect(installation?.definitionRevision).toBe(1);
    expect(installation?.grantedCapabilities).toEqual([MERCHANT_AGENT_READ_CAPABILITY]);
  });

  it("finishes an install that was interrupted after its first steps", async () => {
    const db = createDatabase();
    // A crash between steps leaves exactly the rows of the steps that ran:
    // each step commits in one batch, so present means done. Stand that state
    // up by running the first two steps for real.
    const areaId = merchantAgentAreaId(ORGANISATION);
    const area = await applyAgentOperation(db, ORGANISATION, {
      kind: "create_area",
      name: "Merchant operations",
      purpose:
        "Answer merchant operating questions and stage governed changes.",
      operationId: areaId,
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 100,
    });
    if (!area.ok) {
      throw new Error(`seed area failed: ${area.error.code}`);
    }
    const firstSkill = merchantAgentDefaultSkills()[0];
    if (firstSkill === undefined) {
      throw new Error("no default skills");
    }
    const skill = await applyAgentOperation(db, ORGANISATION, {
      kind: "create_skill",
      title: merchantAgentSkill(firstSkill).title,
      sensitivity: "ordinary",
      markdownBody: merchantAgentSkill(firstSkill).markdownBody,
      operationId: merchantAgentSkillId(ORGANISATION, firstSkill),
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 100,
    });
    if (!skill.ok) {
      throw new Error(`seed skill failed: ${skill.error.code}`);
    }

    // Every id is derived from the organisation, so the rows already present are
    // this install's own progress. Refusing them as conflicts made a partial
    // install impossible to finish.
    const resumed = await installMerchantAgent({
      db,
      organisationId: ORGANISATION,
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      policyRevision: 1,
      skills: merchantAgentDefaultSkills(),
      now: 200,
    });
    if (!resumed.ok) {
      throw new Error(`resume failed: ${resumed.error.code}`);
    }
    const snapshot = await readAgentOperations(db, ORGANISATION);
    expect(snapshot.areas.map((entry) => entry.areaId)).toEqual([areaId]);
    expect(snapshot.skills).toHaveLength(merchantAgentDefaultSkills().length);
    expect(snapshot.installations.map((entry) => entry.installationId)).toEqual(
      [merchantAgentInstallationId(ORGANISATION)],
    );
  });

  it("installs for a second organisation without colliding with the first", async () => {
    const other = requireOrganisationId("organisation_second_merchant");
    const db = createAgentOperationsDatabase(ORGANISATION, [other]);
    await install(db);

    // Every id Sous Chef writes is a bare primary key, so a fixed constant made the
    // second organisation's very first command fail with a bare record conflict.
    const second = await installMerchantAgent({
      db,
      organisationId: other,
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      policyRevision: 1,
      skills: merchantAgentDefaultSkills(),
      now: 100,
    });
    if (!second.ok) {
      throw new Error(`second install failed: ${second.error.code}`);
    }
    expect(second.value.installationId).toBe(merchantAgentInstallationId(other));
    expect(second.value.installationId).not.toBe(
      merchantAgentInstallationId(ORGANISATION),
    );

    const snapshot = await readAgentOperations(db, other);
    expect(
      snapshot.definitions.map((entry) => entry.agentDefinitionId),
    ).toEqual([merchantAgentAgentId(other)]);
    // The first organisation's Sous Chef is untouched and still its own.
    const first = await readAgentOperations(db, ORGANISATION);
    expect(first.definitions.map((entry) => entry.agentDefinitionId)).toEqual([
      merchantAgentAgentId(ORGANISATION),
    ]);
  });
});

async function install(db: SingleDatabase) {
  const installed = await installMerchantAgent({
    db,
    organisationId: ORGANISATION,
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    policyRevision: 1,
    skills: merchantAgentDefaultSkills(),
    now: 100,
  });
  if (!installed.ok) {
    throw new Error(`Urk install failed: ${installed.error.code}`);
  }
  return installed.value;
}

function createDatabase(): SingleDatabase {
  return createAgentOperationsDatabase(ORGANISATION);
}
