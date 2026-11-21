// The D1 seeds that the Plan 50 trials share: the Organisation, its people
// and placement, its Commerce binding and the Session registry entry.
import {
  baseProjectId,
  prepareBaseProject,
} from "../../services/platform/src/projects/default-project.ts";
import { ORGANISATION_ACTOR_SCHEMA_VERSION } from "../../services/platform/src/actors/actor-schema-versions.ts";
import {
  parseOrganisationId,
  parseUserId,
} from "../../services/platform/src/ids.ts";
import { ownerUser } from "./account-authority.mjs";

const organisationId = required(
  parseOrganisationId("organisation_plan50_seams"),
);
export const agentUser = required(
  parseUserId("user_11111111-1111-5111-8111-111111111111"),
);
export const humanUser = required(
  parseUserId("user_22222222-2222-5222-8222-222222222222"),
);
const merchantId = "merchant_plan50_draft";
const accountId = "integration_plan50_draft";

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export async function registerSession(db, sql) {
  const row = sql
    .exec("SELECT * FROM state_object_activation WHERE singleton = 1")
    .one();
  await db
    .prepare(
      `INSERT INTO durable_object_registry (
      registry_id, activation_token, organisation_id, object_kind, logical_object_id,
      physical_object_name, placement_epoch, placement_cell_id, schema_version,
      state_version, lifecycle_status, fence_token, reserved_at, activated_at
    ) VALUES (?, ?, ?, 'session', ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(registry_id) DO NOTHING`,
    )
    .bind(
      row.registry_id,
      row.activation_token,
      organisationId,
      row.logical_object_id,
      row.physical_object_name,
      row.placement_epoch,
      row.placement_cell_id,
      row.schema_version,
      row.state_version,
      row.fence_token,
      row.activated_at,
      row.activated_at,
    )
    .run();
}

export async function seedDraftAuthority(db) {
  const now = Date.now();
  const projectId = await baseProjectId(organisationId);
  await db.batch(
    [
      db
        .prepare(
          "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, 'Pi draft trial', ?)",
        )
        .bind(organisationId, now),
      db
        .prepare(
          "INSERT INTO organisation_onboarding (organisation_id, environment, lifecycle, capability_profile, configuration_version, projection_revision, updated_at) VALUES (?, 'development', 'configuring', 'read_and_propose', 1, 1, ?)",
        )
        .bind(organisationId, now),
      db
        .prepare(
          "INSERT INTO organisation_placement (organisation_id, placement_epoch, placement_kind, placement_cell_id, location_hint, residency_jurisdiction, status, fence_token, created_at, activated_at) VALUES (?, 1, 'affinity', 'cell-trial', 'wnam', NULL, 'active', 'dof_placement', ?, ?)",
        )
        .bind(organisationId, now, now),
      ...seedMember(db, now, ownerUser, "owner"),
      ...seedMember(db, now, agentUser, "operator"),
      ...seedMember(db, now, humanUser, "operator"),
      // Chats without a named Project join the default Project.
      ...prepareBaseProject(db, {
        organisationId,
        projectId,
        ownerUserId: ownerUser,
        now,
      }),
      ...[agentUser, humanUser].map(
        baseProjectEditor.bind(null, db, projectId),
      ),
      db
        .prepare(
          "INSERT INTO underclerk_merchant_binding (binding_id, organisation_id, integration_account_id, merchant_id, environment, delivery_signing_key_id, delivery_signing_public_key_b64, revision, created_at, updated_at) VALUES ('underclerk_binding_plan50_draft', ?, ?, ?, 'development', 'fixture-key', 'AA==', 1, ?, ?)",
        )
        .bind(organisationId, accountId, merchantId, now, now),
      db
        .prepare(
          "INSERT INTO organisation_commerce_system (organisation_id, system_kind, underclerk_binding_id, shopify_integration_account_id, revision, selected_at, selected_by_user_id) VALUES (?, 'satyr_commerce', 'underclerk_binding_plan50_draft', NULL, 1, ?, ?)",
        )
        .bind(organisationId, now, agentUser),
      db
        .prepare(
          "INSERT INTO durable_object_registry (registry_id, activation_token, organisation_id, object_kind, logical_object_id, physical_object_name, placement_epoch, placement_cell_id, schema_version, state_version, lifecycle_status, fence_token, reserved_at, activated_at) VALUES ('dor_draft', 'doa_draft', ?, 'organisation', ?, ?, 1, 'cell-trial', ?, 1, 'active', 'dof_draft', ?, ?)",
        )
        .bind(
          organisationId,
          organisationId,
          organisationId,
          ORGANISATION_ACTOR_SCHEMA_VERSION,
          now,
          now,
        ),
    ].flat(),
  );
  return now;
}

function seedMember(db, now, userId, role) {
  return [
    db
      .prepare(
        "INSERT INTO app_user (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at) VALUES (?, 'https://accounts.google.com', ?, ?, 'Trial operator', 1, ?, ?)",
      )
      .bind(userId, userId, `${userId}@fixture.test`, now, now),
    db
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Trial operator')",
      )
      .bind(organisationId, `person_${userId}`),
    db
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
      )
      .bind(organisationId, userId, `person_${userId}`, role, now),
  ];
}

function baseProjectEditor(db, projectId, userId) {
  return db
    .prepare(
      "INSERT INTO project_member (organisation_id, project_id, user_id, role) VALUES (?, ?, ?, 'editor')",
    )
    .bind(organisationId, projectId, userId);
}
