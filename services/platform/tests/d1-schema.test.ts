import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import {
  describe,
  expect,
  it,
} from "vitest";

import { SLACK_INSTALL_SCOPES } from "../src/slack-ingress/install";
import { SLACK_SCOPES as SLACK_ADAPTER_SCOPES } from "../src/provider-adapters/slack";

const baselineSql = singleDatabaseSchema();

describe("current D1 schema baseline", () => {
  it("enforces the closed responsibility-scope payload branches", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(baselineSql);
    database.exec(`
      INSERT INTO organisation (organisation_id, organisation_handle, name, created_at)
      VALUES ('organisation_scope', 'scope-org', 'Scope organisation', 10);
      INSERT INTO operational_area (
        area_id, organisation_id, name, purpose, lifecycle,
        created_by_user_id, created_at, updated_at
      ) VALUES ('area_scope', 'organisation_scope', 'Scope area', 'Scope test', 'active', 'control', 10, 10);
    `);

    const insert = database.prepare(
      `INSERT INTO agent_responsibility_scope (
         scope_id, organisation_id, area_id, scope_kind,
         entity_type_origin, entity_type_id, commerce_list_id,
         selector_id, selector_revision, selector_query_json,
         lifecycle, revision, published_at
       ) VALUES (?, 'organisation_scope', 'area_scope', ?, ?, ?, ?, ?, ?, ?, 'published', 1, 10)`,
    );
    insert.run(
      "scope_entity",
      "entity_type",
      "system",
      "product",
      null,
      null,
      null,
      null,
    );
    insert.run(
      "scope_list",
      "commerce_list",
      null,
      null,
      "list_products",
      null,
      null,
      null,
    );
    insert.run(
      "scope_selector",
      "saved_selector",
      null,
      null,
      null,
      "selector_stock",
      1,
      "{}",
    );

    expect(() =>
      insert.run(
        "scope_cross_branch",
        "entity_type",
        "system",
        "product",
        "list_products",
        null,
        null,
        null,
      ),
    ).toThrow(/constraint failed/iu);
    expect(() =>
      insert.run(
        "scope_invalid_selector",
        "saved_selector",
        null,
        null,
        null,
        "selector_stock",
        1,
        "not-json",
      ),
    ).toThrow(/constraint failed/iu);
    database.close();
  });

  it("enforces closed access-grant target branches in D1", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(baselineSql);
    database.exec(`
      INSERT INTO organisation (organisation_id, organisation_handle, name, created_at)
      VALUES ('organisation_grant', 'grant-org', 'Grant organisation', 10);
    `);
    const insert = database.prepare(
      `INSERT INTO access_grant (
         organisation_id, grant_id, subject_json, target_json,
         lifecycle, revision, reason, provenance_json, changed_at
       ) VALUES ('organisation_grant', ?, '{"kind":"organisation_role","role":"operator"}', ?, 'active', 1, NULL,
         '{"kind":"cutover","migrationId":"schema_test","originalChangedAt":10}', 10)`,
    );
    insert.run(
      "grant_read",
      JSON.stringify({
        kind: "commerce_read",
        capabilityId: "commerce.entity.read",
        capabilityVersion: 1,
        scope: { kind: "commerce_list", listId: "export_coordination" },
      }),
    );
    expect(() =>
      insert.run(
        "grant_read_cross_branch",
        JSON.stringify({
          kind: "commerce_read",
          capabilityId: "commerce.entity.read",
          capabilityVersion: 1,
          scope: { kind: "commerce_list", listId: "export_coordination" },
          target: {
            kind: "commerce_list",
            listId: "export_coordination",
            revision: 1,
          },
        }),
      ),
    ).toThrow(/constraint failed/iu);
    expect(() =>
      insert.run(
        "grant_command_missing_target",
        JSON.stringify({
          kind: "commerce_command",
          capabilityId: "commerce.entity.command",
          capabilityVersion: 1,
          scope: { kind: "commerce_list", listId: "export_coordination" },
        }),
      ),
    ).toThrow(/constraint failed/iu);
    expect(() =>
      insert.run(
        "grant_command_invalid_target",
        JSON.stringify({
          kind: "commerce_command",
          capabilityId: "commerce.entity.command",
          capabilityVersion: 1,
          scope: { kind: "commerce_list", listId: "export_coordination" },
          target: { kind: "provider_resource" },
        }),
      ),
    ).toThrow(/constraint failed/iu);
    database.close();
  });

  it("seeds a Slack manifest whose scopes match the compiled adapter and install request", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(baselineSql);

    // The manifest drives readiness by version, so a scope correction only
    // reaches connected accounts when the version moves with it.
    const rows = database
      .prepare(
        `SELECT environment, manifest_version AS manifestVersion, required_scopes AS requiredScopes
         FROM provider_manifest
        WHERE provider = 'slack'
          AND manifest_version = (
            SELECT MAX(manifest_version) FROM provider_manifest WHERE provider = 'slack'
          )
        ORDER BY environment`,
      )
      .all();

    expect(rows.map((row) => String(row.environment))).toEqual([
      "development",
      "production",
    ]);

    for (const row of rows) {
      const seeded = JSON.parse(
        String(row.requiredScopes),
      ) as readonly string[];
      // Slack file hydration cannot run without files:read, and the adapter
      // already demands it. Parity here is what keeps the seed honest.
      expect(seeded).toContain("files:read");
      expect([...seeded].sort()).toEqual([...SLACK_ADAPTER_SCOPES].sort());
      expect([...seeded].sort()).toEqual([...SLACK_INSTALL_SCOPES].sort());
      // MPIM stays out until it is added deliberately with its own acceptance.
      expect(seeded).not.toContain("mpim:history");
    }

    database.close();
  });
});
