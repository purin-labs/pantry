import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { DatabaseSync } from "node:sqlite";

import { d1Database } from "./sqlite-d1";
/**
 * The agent-operations tables one test needs, seeded with one active organisation.
 * Mirrors the shape of the D1 baseline for these tables so the data module
 * runs its real statements.
 */
const RAW_DATABASES = new WeakMap<object, DatabaseSync>();

/**
 * The underlying SQLite handle, for tests that assert a schema constraint
 * rejects a write the data module would never issue.
 */
export function rawAgentOperationsDatabase(db: SingleDatabase): DatabaseSync {
  const raw = RAW_DATABASES.get(db);
  if (raw === undefined) throw new Error("missing raw database");
  return raw;
}

export function createAgentOperationsDatabase(
  organisationId: string,
  extraOrganisationIds: readonly string[] = [],
): SingleDatabase {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organisation (
      organisation_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `);
  sqlite.exec(
    `INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES ('${organisationId}', 'Plan 16', 'beta', 1, 'active')`,
  );
  for (const extra of extraOrganisationIds) {
    sqlite.exec(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES ('${extra}', 'Plan 16', 'beta', 1, 'active')`,
    );
  }
  sqlite.exec(`
CREATE TABLE organisation_placement (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  placement_epoch INTEGER NOT NULL CHECK (placement_epoch > 0),
  placement_kind TEXT NOT NULL CHECK (placement_kind IN ('affinity', 'residency')),
  placement_cell_id TEXT NOT NULL,
  location_hint TEXT NOT NULL,
  residency_jurisdiction TEXT CHECK (
    (placement_kind = 'affinity' AND residency_jurisdiction IS NULL) OR
    (placement_kind = 'residency' AND residency_jurisdiction IN ('eu', 'fedramp'))
  ),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'active', 'frozen', 'retired')),
  fence_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  frozen_at INTEGER,
  abandoned_at INTEGER,
  retired_at INTEGER, environment TEXT NOT NULL DEFAULT 'development'
CHECK (environment IN ('development', 'production')),
  PRIMARY KEY (organisation_id, placement_epoch),
  CHECK (
    (status = 'reserved' AND activated_at IS NULL AND frozen_at IS NULL AND retired_at IS NULL) OR
    (status = 'active' AND activated_at IS NOT NULL AND frozen_at IS NULL AND retired_at IS NULL) OR
    (status = 'frozen' AND activated_at IS NOT NULL AND frozen_at IS NOT NULL AND retired_at IS NULL) OR
    (status = 'retired' AND activated_at IS NOT NULL AND frozen_at IS NOT NULL AND retired_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_organisation_placement_active
  ON organisation_placement (organisation_id)
  WHERE status = 'active';
  `);
  for (const placedOrganisationId of [
    organisationId,
    ...extraOrganisationIds,
  ]) {
    sqlite
      .prepare(
        `INSERT INTO organisation_placement (
      organisation_id, placement_epoch, placement_kind, placement_cell_id, location_hint,
      status, fence_token, created_at, activated_at
    ) VALUES (?, 1, 'affinity', 'test', 'wnam', 'active', 'fixture-fence', 1, 1)`,
      )
      .run(placedOrganisationId);
  }
  sqlite.exec(`
    CREATE TABLE operational_area (
      area_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
      name TEXT NOT NULL,
      purpose TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (organisation_id, name)
    );
    CREATE TABLE agent_responsibility_scope (
      scope_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL,
      area_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      entity_type_origin TEXT,
      entity_type_id TEXT,
      commerce_list_id TEXT,
      relationship_json TEXT,
      list_entry_json TEXT,
      selector_id TEXT,
      selector_revision INTEGER,
      selector_query_json TEXT,
      lifecycle TEXT NOT NULL,
      revision INTEGER NOT NULL,
      published_at INTEGER NOT NULL
    );
    CREATE TABLE agent_definition (
      agent_definition_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      purpose TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_definition_revision (
      agent_definition_id TEXT NOT NULL,
      organisation_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      instructions TEXT NOT NULL,
      requested_capabilities_json TEXT NOT NULL,
      skill_refs_json TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      authored_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (agent_definition_id, revision)
    );
    CREATE TABLE agent_installation (
      installation_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
      agent_definition_id TEXT NOT NULL,
      definition_revision INTEGER NOT NULL,
      policy_revision INTEGER NOT NULL,
      granted_capabilities_json TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_area_assignment (
      installation_id TEXT NOT NULL,
      area_id TEXT NOT NULL,
      responsibility TEXT NOT NULL,
      scope_ids_json TEXT NOT NULL DEFAULT '[]',
      assigned_at INTEGER NOT NULL,
      PRIMARY KEY (installation_id, area_id)
    );
    CREATE TABLE skill (
      skill_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
      title TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE skill_revision (
      skill_id TEXT NOT NULL,
      organisation_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      markdown_body TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      authored_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (skill_id, revision)
    );
    CREATE TABLE skill_binding (
      binding_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      skill_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE cue_binding (
      binding_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL,
      area_id TEXT NOT NULL,
      scope_ids_json TEXT NOT NULL DEFAULT '[]',
      installation_id TEXT NOT NULL,
      cue_source TEXT NOT NULL,
      cue_event_type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      instruction_body TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (organisation_id, cue_source, cue_event_type)
    );
    CREATE TABLE schedule_binding (
      binding_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL,
      area_id TEXT NOT NULL,
      scope_ids_json TEXT NOT NULL DEFAULT '[]',
      installation_id TEXT NOT NULL,
      cadence TEXT NOT NULL CHECK (cadence IN ('hourly', 'daily', 'weekly')),
      minute_of_hour INTEGER,
      time_of_day TEXT,
      weekday TEXT,
      timezone TEXT,
      schedule_time_key TEXT NOT NULL,
      instruction_body TEXT,
      last_dispatched_window TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (cadence = 'hourly' AND minute_of_hour IS NOT NULL
          AND minute_of_hour BETWEEN 0 AND 59
          AND time_of_day IS NULL AND weekday IS NULL AND timezone IS NULL)
        OR (cadence = 'daily' AND minute_of_hour IS NULL
          AND time_of_day IS NOT NULL AND weekday IS NULL AND timezone IS NOT NULL)
        OR (cadence = 'weekly' AND minute_of_hour IS NULL
          AND time_of_day IS NOT NULL AND weekday IS NOT NULL AND timezone IS NOT NULL)
      ),
      CHECK (weekday IS NULL OR weekday IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
      UNIQUE (organisation_id, installation_id, cadence, schedule_time_key)
    );
    CREATE TABLE schedule_dispatch_receipt (
      binding_id TEXT NOT NULL,
      window_key TEXT NOT NULL,
      organisation_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      dispatched_at INTEGER NOT NULL,
      PRIMARY KEY (binding_id, window_key)
    );
    CREATE TABLE agent_installation_governance (
      installation_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL,
      max_session_budget_tokens INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_by_user_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE escalation_policy (
      area_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL,
      scope_ids_json TEXT NOT NULL DEFAULT '[]',
      approval_reminder_after_ms INTEGER NOT NULL,
      escalate_after_ms INTEGER NOT NULL,
      escalate_to TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_by_user_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_configuration_proposal (
      proposal_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      proposed_body TEXT NOT NULL,
      rationale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by_user_id TEXT,
      published_revision INTEGER
    );
    CREATE TABLE campaign_brief (
      brief_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL,
      merchant_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      objective TEXT NOT NULL CHECK (length(objective) > 0),
      targets_json TEXT NOT NULL CHECK (json_valid(targets_json)),
      channel TEXT NOT NULL CHECK (length(channel) > 0),
      audience_description TEXT NOT NULL CHECK (length(audience_description) > 0),
      message_variants_json TEXT NOT NULL CHECK (json_valid(message_variants_json)),
      requested_budget_minor INTEGER NOT NULL CHECK (requested_budget_minor >= 0),
      currency TEXT NOT NULL CHECK (length(currency) = 3),
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      disclosures_json TEXT NOT NULL CHECK (json_valid(disclosures_json)),
      supporting_evidence TEXT NOT NULL CHECK (length(supporting_evidence) > 0),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'accepted', 'dismissed', 'expired')),
      proposed_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by_person_id TEXT,
      expires_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      CHECK ((lifecycle = 'draft') = (decided_at IS NULL)),
      CHECK ((decided_at IS NULL) = (decided_by_person_id IS NULL))
    );
    CREATE INDEX idx_campaign_brief_case
      ON campaign_brief (organisation_id, case_id, proposed_at);
    -- The receipt a confirmation writes in the same commit as its effect, so a
    -- retry after an interruption reads the outcome instead of re-applying.
    -- The foreign key on app_user is dropped here; these fixtures do
    -- not carry the control-plane tables.
    -- Memory admission builds a flow label from the organisation's current policy,
    -- so the snapshot has to be present for anything to be admitted at all.
    CREATE TABLE policy_snapshot (
      organisation_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (organisation_id, version)
    );
    CREATE TABLE control_mutation_receipt (
      receipt_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      organisation_scope TEXT NOT NULL,
      route TEXT NOT NULL,
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_status INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 599),
      response_body TEXT NOT NULL CHECK (json_valid(response_body)),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE (user_id, organisation_scope, route, operation, idempotency_key),
      CHECK (expires_at >= created_at + 86400000)
    );
    CREATE TABLE operator_configuration_draft (
      draft_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      actor_person_id TEXT NOT NULL,
      command_json TEXT NOT NULL CHECK (json_valid(command_json)),
      command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
      -- One stable mutation identity, so a retry reads the recorded outcome
      -- instead of applying the change a second time.
      mutation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('pending', 'confirmed', 'settled', 'cancelled', 'expired')
      ),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_at INTEGER,
      receipt_code TEXT,
      UNIQUE (organisation_id, mutation_id),
      CHECK ((state = 'pending') = (decided_at IS NULL)),
      CHECK ((state = 'settled') = (receipt_code IS NOT NULL))
    );
    -- At most one draft awaits confirmation per Case, so a bare confirmation is
    -- never ambiguous about which change it accepts.
    CREATE UNIQUE INDEX idx_operator_draft_pending
      ON operator_configuration_draft (organisation_id, case_id)
      WHERE state = 'pending';
    CREATE TABLE case_assignment_pin (
      organisation_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      agent_definition_id TEXT NOT NULL,
      definition_revision INTEGER NOT NULL,
      policy_revision INTEGER NOT NULL,
      skill_refs_json TEXT NOT NULL,
      granted_capabilities_json TEXT NOT NULL,
      max_session_budget_tokens INTEGER,
      pinned_at INTEGER NOT NULL,
      PRIMARY KEY (organisation_id, assignment_id)
    );
  `);
  // One permissive policy snapshot, so admission has a label to build from.
  const policyBody = JSON.stringify({
    version: 1,
    egress: {
      allowedHosts: [],
      injections: [],
      modelRoute: { baseUrl: "https://model-gateway.test" },
    },
    authz: {
      allowedTools: [],
      deniedTools: [],
      approvalRequired: [],
      maxBudget: null,
    },
    conversationRisk: { outputScreeningMode: "stream" },
    createdAt: 1,
  }).replaceAll("'", "''");
  for (const id of [organisationId, ...extraOrganisationIds]) {
    sqlite.exec(
      `INSERT INTO policy_snapshot (organisation_id, version, body) VALUES ('${id}', 1, '${policyBody}')`,
    );
  }
  const database = d1Database(sqlite);
  RAW_DATABASES.set(database, sqlite);
  return database;
}

export async function proposalFixtureAuthority(
  db: SingleDatabase,
  organisationId: OrganisationId,
) {
  const scope = await requireOrganisationExecutionScope(
    {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
        databaseBinding: "DB",
        kind: "affinity",
        placementCellId: "test",
        locationHint: "wnam",
      }),
    },
    organisationId,
  );
  return {
    scope,
    authorizeCommit: requireProposalFixtureScope.bind(null, scope),
  };
}

async function requireProposalFixtureScope(
  scope: OrganisationExecutionScope,
): Promise<void> {
  if (!(await scope.isActive())) throw new Error("fixture placement inactive");
}
