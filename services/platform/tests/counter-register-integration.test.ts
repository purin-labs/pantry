import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseTerminalAssignment } from "@purin-labs/commerce-contracts";

import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { createOrganisationExecutionFixture } from "./organisation-execution-fixture";
import { d1Database } from "./sqlite-d1";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import {
  activateTerminalAssignment,
  readActiveTerminalAssignment,
} from "@purin-labs/area-cafe/server/data/terminal-assignment-store";

const ORG_ID = "org_11111111-1111-4111-8111-111111111111";

describe("Plan 90 counter register & GMO stera LAN gateway integration", () => {
  it("stores payment_terminal device enrollments and lan_gateway_device assignments in the D1 schema", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(singleDatabaseSchema());
    const db = d1Database(sqlite);
    const now = Date.now();
    const parsedOrg = parseOrganisationId(ORG_ID);
    if (!parsedOrg.ok) throw new Error("Invalid org id");

    // Seed org + gateway + payment_terminal enrollment directly against real CHECK constraints.
    sqlite.exec(`
      INSERT INTO organisation (organisation_id, name, created_at)
      VALUES ('${ORG_ID}', 'Tokyo Cafe', ${now});
      INSERT INTO device_gateway (
        gateway_id, organisation_id, location_id, name, state,
        credential_sha256, created_by_user_id, created_at, enrolled_at, service_version
      ) VALUES (
        'gw_tokyo_1', '${ORG_ID}', 'loc_tokyo', 'Counter Gateway', 'active',
        'hash_gw_1', 'user_owner', ${now}, ${now}, '0.1.0'
      );
      INSERT INTO device_enrollment (
        device_id, organisation_id, gateway_id, source_key, name,
        device_kind, model, capabilities_json, revision, state,
        verified_at, health, work_state, created_at
      ) VALUES (
        'dev_stera_1', '${ORG_ID}', 'gw_tokyo_1', 'stera_lan_1', 'Counter stera',
        'payment_terminal', 'stera terminal', '[]', 1, 'active',
        ${now}, 'ok', 'idle', ${now}
      );
    `);

    const assignment = parseTerminalAssignment({
      assignmentId: "assign_stera_1",
      organisationId: ORG_ID,
      merchantId: "merchant_tokyo",
      pantryLocationId: "loc_tokyo",
      providerLocationId: "GMO_STERA_LOC_TOKYO",
      account: {
        integrationAccountId: "gmo_account_1",
        providerAccountId: "gmo_merchant_1",
        environment: "development",
        capabilityRevision: 1,
        country: "JP",
        currency: "JPY",
      },
      target: {
        kind: "lan_gateway_device",
        gatewayId: "gw_tokyo_1",
        deviceSourceKey: "stera_lan_1",
      },
      transport: "lan_gateway",
      adapterVersion: "gmo_stera_lan_v1",
      revision: 1,
      state: { kind: "active" },
    });
    if (!assignment.ok) throw new Error(JSON.stringify(assignment.error));

    const scope = await createOrganisationExecutionFixture(db, parsedOrg.value);
    const recorded = await activateTerminalAssignment({
      db: scope.database,
      organisationId: parsedOrg.value,
      assignment: assignment.value,
      now,
    });
    expect(recorded.ok).toBe(true);

    const loaded = await readActiveTerminalAssignment(
      scope.database,
      parsedOrg.value,
      "loc_tokyo",
    );
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.target).toEqual({
        kind: "lan_gateway_device",
        gatewayId: "gw_tokyo_1",
        deviceSourceKey: "stera_lan_1",
      });
      expect(loaded.value.transport).toBe("lan_gateway");
    }
  });
});
