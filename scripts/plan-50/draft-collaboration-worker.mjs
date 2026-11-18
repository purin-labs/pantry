import { CandidateActor as CodeModeActor } from "./codemode-worker.mjs";
import provider, {
  ProposalOrganisation as ProviderOrganisation,
} from "./provider-worker.mjs";
export { ProposalCase } from "./provider-worker.mjs";
export { CodeModePlatformGovernorActor } from "./codemode-worker.mjs";
import { organisationId, userId, accountId } from "./proposal-worker.mjs";
import {
  readProductDescriptionDraftForEmbeddedHarness,
  editProductDescriptionDraftForEmbeddedHarness,
} from "../../services/platform/src/agent-tools/drafts/handlers.ts";
import { createCommerceClient } from "../../services/platform/src/commerce/outbox-worker.ts";
import { commerceCanonicalResourceId } from "../../services/platform/src/commerce/provider.ts";
import { createAccessGrant } from "../../services/platform/src/data/access-grants.ts";
import { SessionExecutionAdmission } from "../../services/platform/src/actors/session-execution-admission.ts";
import { createOrganisationInstall } from "../../services/platform/src/data/organisation.ts";
import {
  parseVaultHandle,
  storeVaultSecret,
} from "../../services/platform/src/credential-vault/index.ts";
import { parseWorkspaceId } from "../../services/platform/src/ids.ts";
import { parseInitialOrganisationPlacement } from "../../services/platform/src/placement.ts";
import { browserFixture } from "./browser-fixture.mjs";
import { authorizeOrganisationRequest } from "../../services/platform/src/control/authorization.ts";
import { matchProductDescriptionDraftRoute } from "../../services/platform/src/control/admission/product-description-draft.ts";
import { handleProductDescriptionDraftRoute } from "../../services/platform/src/control/routes/product-description-draft.ts";

const productId = "product_financier";
const merchantId = "merchant_plan50_draft";

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export class ProposalOrganisation extends ProviderOrganisation {
  async install() {
    await super.install();
    if (await this.ctx.storage.get("draft_collaboration_installed")) return;
    const client = createCommerceClient(this.env, undefined, {
      kind: "organisation",
      organisationId,
    });
    const snapshot = required(await client.readSnapshot(merchantId));
    const product = snapshot.resources.products.find(isTrialProduct);
    if (product === undefined) throw new Error("Missing trial product");
    const now = Date.now();
    const occurredAt = new Date(now).toISOString();
    const canonicalId = commerceCanonicalResourceId(merchantId, productId);
    const projection = {
      kind: "product",
      projection: {
        provenance: {
          organisationId,
          integrationAccountId: accountId,
          source: "underclerk",
          resourceType: "product",
          resourceId: canonicalId,
          revision: product.revision,
          occurredAt,
          observedAt: occurredAt,
        },
        title: product.title,
        description: product.description,
      },
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO commerce_projection (
        organisation_id, projection_kind, canonical_id, integration_account_id,
        revision, lifecycle, projection_json, updated_at, validated_at, lab_run_id
      ) VALUES (?, 'product', ?, ?, ?, 'active', ?, ?, ?, NULL)`,
      organisationId,
      canonicalId,
      accountId,
      product.revision,
      JSON.stringify(projection),
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO commerce_projection_relation_text (
        organisation_id, projection_kind, canonical_id, integration_account_id,
        display_name_folded, search_text_folded
      ) VALUES (?, 'product', ?, ?, 'financier', 'financier')`,
      organisationId,
      canonicalId,
      accountId,
    );
    await installDraftReviewDestination(this.env.DB);
    await installDraftGrants(
      this.env.DB,
      this.env.DRAFT_SCENARIO === "draft_browser_restricted",
    );
    const policy = await this.env.DB.prepare(
      "SELECT body FROM policy_snapshot WHERE organisation_id = ? AND version = 1",
    )
      .bind(organisationId)
      .first();
    await this.env.POLICY_KV.put(
      `policy:${organisationId}:latest`,
      policy.body,
    );
    await this.env.POLICY_KV.put(`policy:${organisationId}:v1`, policy.body);
    await this.ctx.storage.put("draft_collaboration_installed", true);
  }

  draftEvidence() {
    return this.ctx.storage.sql
      .exec(
        "SELECT operation_id, request_json, draft_description FROM product_description_draft_operation ORDER BY operation_id",
      )
      .toArray();
  }
}

export class CandidateActor extends CodeModeActor {
  async fetch(request) {
    const response = await super.fetch(request);
    if (new URL(request.url).pathname === "/start") {
      const policy = await this.env.DB.prepare(
        "SELECT body FROM policy_snapshot WHERE organisation_id = ? AND version = 1",
      )
        .bind(organisationId)
        .first();
      await this.env.POLICY_KV.put(
        `policy:${organisationId}:latest`,
        policy.body,
      );
      await this.env.POLICY_KV.put(`policy:${organisationId}:v1`, policy.body);
    }
    return response;
  }

  inputContent() {
    return "Improve the financier description draft. Preserve operator edits and wait for review before publication.";
  }

  async observeOffer() {}

  profileCapabilities() {
    return [
      "commerce.entity_plane.context",
      "commerce.product_description_draft.edit",
    ];
  }

  async catalogSelection() {
    return { allowedCapabilities: this.catalogCapabilities() };
  }

  toolDefinitions(host) {
    return host.definitions.filter(isDraftTool);
  }

  toolReplay(name) {
    if (isDraftTool({ name })) return "safe";
    throw new Error(`Unsupported draft trial tool: ${name}`);
  }

  async readProductDescriptionDraft(lease, request) {
    const execution = await draftExecutionAdmission(this);
    return readProductDescriptionDraftForEmbeddedHarness(
      this.toolContext(execution, lease),
      request,
    );
  }

  async editProductDescriptionDraft(lease, request, operationId) {
    let result;
    try {
      const execution = await draftExecutionAdmission(this);
      result = await editProductDescriptionDraftForEmbeddedHarness(
        this.toolContext(execution, lease),
        request,
        operationId,
        { kind: "direct" },
      );
    } catch (error) {
      await this.provider("/draft-collaboration-denied", {
        operationId,
        reason: String(error),
      });
      throw error;
    }
    if (!(await this.ctx.storage.get("draft_result_held"))) {
      await this.ctx.storage.put("draft_result_held", true);
      await this.provider("/draft-collaboration-held", { result });
    }
    return result;
  }

  validateRecoverableTools(sql, generation) {
    const rows = sql
      .exec(
        "SELECT record FROM tasks WHERE json_extract(record, '$.kind') = 'pi.tool' AND json_extract(record, '$.owner') = ?",
        generation.id,
      )
      .toArray();
    if (rows.length !== 1)
      throw new Error("Expected one interrupted draft edit");
    const task = JSON.parse(rows[0].record);
    if (
      task.input.callId !== "draft_edit_original" ||
      task.state.checkpoint.phase !== "execute" ||
      task.state.checkpoint.replay !== "safe"
    )
      throw new Error(
        "Draft recovery requires the original receipt-backed edit",
      );
  }
}

function isTrialProduct(product) {
  return product.id === productId;
}

function isDraftTool(tool) {
  return (
    tool.name === "product_description_draft_read" ||
    tool.name === "product_description_draft_edit"
  );
}

async function trialVaultRoot() {
  return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
}

async function draftExecutionAdmission(actor) {
  const admission = await SessionExecutionAdmission.resolve(
    actor.env,
    actor.ctx.storage,
    organisationId,
  );
  if (admission === null) throw new Error("Draft execution admission denied");
  return admission;
}

async function installDraftReviewDestination(db) {
  const now = Date.now();
  const workspaceId = required(parseWorkspaceId("T50DRAFT"));
  const handle = required(parseVaultHandle("vault:slack:plan50-draft"));
  required(
    await storeVaultSecret({
      db,
      organisationId,
      handle,
      now,
      keys: {
        SATYR_VAULT_ACTIVE_KEY_VERSION: "v1",
        VAULT_ROOT_V1: { get: trialVaultRoot },
      },
      secret: { kind: "bearer", value: "xoxb-local-draft-fixture" },
    }),
  );
  // The trial's one D1 database holds the global and regional schemas.
  const install = await createOrganisationInstall(db, db, {
    organisationId,
    name: "R50 draft trial",
    surfaceKind: "slack",
    workspaceId,
    installModel: "unlisted",
    botTokenRef: handle,
    scopes: ["chat:write"],
    placement: required(
      parseInitialOrganisationPlacement({
        kind: "affinity",
        placementEpoch: 1,
        placementCellId: "cell-trial",
        locationHint: "wnam",
      }),
    ),
    createdAt: now,
    installedAt: now,
  });
  await db.batch([
    db
      .prepare(
        "INSERT INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at) VALUES (?, 'satyr_platform', ?, ?)",
      )
      .bind(organisationId, userId, now),
    db
      .prepare(
        "INSERT INTO organisation_onboarding_selection (organisation_id, policy_template_id, policy_template_version, cue_preset_id, cue_preset_version, cue_workspace_id, cue_channel_id, selected_by_user_id, selected_at) VALUES (?, 'commerce_operator', 1, 'commerce_operator', 1, ?, 'C50DRAFT', ?, ?)",
      )
      .bind(organisationId, workspaceId, userId, now),
    db
      .prepare(
        "INSERT INTO organisation_communication_destination (organisation_id, integration_account_id, workspace_id, channel_id, provider_revision, selected_at) VALUES (?, ?, ?, 'C50DRAFT', 'draft-trial', ?)",
      )
      .bind(organisationId, install.integrationAccountId, workspaceId, now),
    db
      .prepare(
        "INSERT INTO slack_installation (installation_id, environment, app_id, workspace_id, credential_organisation_id, bot_token_ref, install_model, scopes_json, lifecycle, installed_at, updated_at) VALUES ('installation_draft_trial', 'development', 'A12345678', ?, ?, ?, 'unlisted', '[\"chat:write\"]', 'active', ?, ?)",
      )
      .bind(workspaceId, organisationId, handle, now, now),
    db
      .prepare(
        "INSERT INTO slack_organisation_connection (connection_id, installation_id, organisation_id, integration_account_id, lifecycle, revision, connected_at, updated_at) VALUES ('connection_draft_trial', 'installation_draft_trial', ?, ?, 'active', 1, ?, ?)",
      )
      .bind(organisationId, install.integrationAccountId, now, now),
    db
      .prepare(
        "INSERT INTO slack_channel_default (installation_id, channel_id, connection_id, revision, bound_by_user_id, bound_at) VALUES ('installation_draft_trial', 'C50DRAFT', 'connection_draft_trial', 1, ?, ?)",
      )
      .bind(userId, now),
  ]);
}

async function installDraftGrants(db, restricted) {
  for (const [id, role] of [
    ["user_33333333-3333-5333-8333-333333333333", "admin"],
    ["user_44444444-4444-5444-8444-444444444444", "viewer"],
  ]) {
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO app_user (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at) VALUES (?, 'https://fixture.test', ?, ?, 'Draft reader', 1, ?, ?)",
        )
        .bind(id, id, `${id}@example.invalid`, now, now),
      db
        .prepare(
          "INSERT OR IGNORE INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Draft reader')",
        )
        .bind(organisationId, `person_${id}`),
      db
        .prepare(
          "INSERT OR IGNORE INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
        )
        .bind(organisationId, id, `person_${id}`, role, now),
    ]);
  }
  const capabilities = [
    "commerce.entity_plane.context",
    "commerce.product_description_draft.edit",
    "commerce.action.propose",
  ];
  const row = await db
    .prepare(
      "SELECT body FROM policy_snapshot WHERE organisation_id = ? AND version = 1",
    )
    .bind(organisationId)
    .first();
  const policy = JSON.parse(row.body);
  for (const capability of [...capabilities, "commerce.entity.read"]) {
    if (!policy.authz.allowedTools.includes(capability))
      policy.authz.allowedTools.push(capability);
  }
  await db
    .prepare(
      "UPDATE policy_snapshot SET body = ? WHERE organisation_id = ? AND version = 1",
    )
    .bind(JSON.stringify(policy), organisationId)
    .run();
  for (const role of restricted
    ? ["owner"]
    : ["owner", "admin", "operator", "viewer"]) {
    required(
      await createAccessGrant({
        db,
        organisationId,
        grantId: `grant_draft_read_${role}`,
        subject: { kind: "organisation_role", role },
        target: {
          kind: "commerce_read",
          capabilityId: "commerce.entity.read",
          capabilityVersion: 1,
          scope: {
            kind: "entity_type",
            entityTypeId: { origin: "system", typeId: "product" },
          },
        },
        provenance: {
          kind: "operator",
          userId,
          mutationReceiptId: "draft_collaboration_grants",
        },
        now: Date.now(),
      }),
    );
  }
  for (const capabilityId of capabilities) {
    required(
      await createAccessGrant({
        db,
        organisationId,
        grantId: `grant_draft_tool_${capabilityId}`,
        subject: { kind: "organisation_role", role: "owner" },
        target: {
          kind: "platform_capability",
          capabilityId,
          capabilityVersion: 1,
        },
        provenance: {
          kind: "operator",
          userId,
          mutationReceiptId: "draft_collaboration_grants",
        },
        now: Date.now(),
      }),
    );
  }
  required(
    await createAccessGrant({
      db,
      organisationId,
      grantId: "grant_draft_owner_proposal",
      subject: { kind: "organisation_role", role: "owner" },
      target: {
        kind: "provider_resource",
        capabilityId: "commerce.action.propose",
        capabilityVersion: 1,
        integrationAccountId: accountId,
        resourceScope: "*",
      },
      provenance: {
        kind: "operator",
        userId,
        mutationReceiptId: "draft_collaboration_grants",
      },
      now: Date.now(),
    }),
  );
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/prepare-draft") {
      await env.ORGANISATION.getByName(organisationId).install();
      return Response.json({ ready: true });
    }
    if (path === "/draft-evidence")
      return Response.json(
        await env.ORGANISATION.getByName(organisationId).draftEvidence(),
      );
    if (
      path === "/fixture/execution" ||
      path === "/fixture/tasks" ||
      path === "/fixture/queue" ||
      path === "/fixture/steer"
    ) {
      const mutation = path === "/fixture/queue" || path === "/fixture/steer";
      const authorized = await authorizeOrganisationRequest(
        request,
        env,
        organisationId,
        "viewer",
        mutation,
      );
      if (!authorized.ok) return authorized.response;
      const url = new URL(request.url);
      if (mutation) url.pathname = path.slice("/fixture".length);
      else if (path === "/fixture/tasks") url.pathname = "/portal-tasks";
      else url.pathname = "/portal-replay";
      url.searchParams.set("scenario", env.DRAFT_SCENARIO);
      const headers = new Headers();
      if (mutation) headers.set("content-type", "application/json");
      headers.set("x-trial-user-id", authorized.authenticated.session.userId);
      return provider.fetch(
        new Request(url, {
          method: mutation ? "POST" : "GET",
          headers,
          body: mutation ? await request.text() : undefined,
        }),
        env,
      );
    }
    if (path === "/fixture/draft") {
      const event =
        request.method === "POST" ? await request.json() : { stage: "status" };
      return fetch(`${env.PROVIDER_URL}/draft-browser`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: env.DRAFT_SCENARIO, ...event }),
      });
    }
    if (path.startsWith("/fixture/")) return browserFixture(request, env, path);
    const route = matchProductDescriptionDraftRoute(path);
    if (route !== null)
      return handleProductDescriptionDraftRoute(request, env, route);
    return provider.fetch(request, env);
  },
};
