import { CandidateActor as RecoveryActor } from "./recovery-worker.mjs";
import { registerSession, seedDraftAuthority } from "./draft-seed.mjs";
import { OrganisationDO } from "../../services/platform/src/actors/organisation.ts";
import { CaseDO } from "../../services/platform/src/actors/case.ts";
import { proposeCommerceActionForHarness } from "../../services/platform/src/actors/harness-commerce-proposal.ts";
import { createActorActivationSchema } from "../../services/platform/src/actors/actor-activation.ts";
import { createActorExecutionBarrierSchema } from "../../services/platform/src/actors/actor-execution-quiescence.ts";
import {
  CASE_ACTOR_SCHEMA_VERSION,
  ORGANISATION_ACTOR_SCHEMA_VERSION,
} from "../../services/platform/src/actors/actor-schema-versions.ts";
import {
  SessionExecutionAdmission,
  admittedSessionToolHost,
  requireSessionExecution,
} from "../../services/platform/src/actors/session-execution-admission.ts";
import { authorizeCapabilityUse } from "../../services/platform/src/authorization/access-grants/turn-authority.ts";
import {
  admitTrialWorkflow,
  attachTrialOrganisation,
  compileTrialTurnAuthority,
  ownerUser,
  trialAccountAccess,
} from "./account-authority.mjs";
import { acceptedExecutionAccountAuthority } from "../../services/platform/src/account-platform/access.ts";
import { CAPABILITY_KEYS } from "../../services/platform/src/authorization/capability-catalogue.ts";
import { catalogHarnessToolCatalogDigest } from "../../services/platform/src/agent-tools/catalog/selection.ts";
import { createCatalogHarnessCodeMode } from "../../services/platform/src/agent-tools/catalog/code-mode.ts";
import { TOOL_REGISTRY } from "../../services/platform/src/agent-tools/registry.ts";
import {
  createAccessGrant,
  revokeAccessGrant,
} from "../../services/platform/src/data/access-grants.ts";
import { parseOrganisationPolicySnapshot } from "../../services/platform/src/policy-snapshot.ts";
import { parseOrganisationId } from "../../services/platform/src/ids.ts";
import { commerceCanonicalResourceId } from "../../services/platform/src/commerce/provider.ts";
import { preflightHarnessTurnLease } from "../../services/platform/src/actors/agent-session-harness-authority.ts";
import {
  admitSessionInformationFlowObservation,
  recordCommerceObservationEntities,
} from "../../services/platform/src/actors/agent-session-information-flow.ts";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  ObservationEvidence,
} from "../../services/platform/src/policy/index.ts";
import { sha256Hex } from "../../packages/std/src/index.ts";
import { createHarnessCodeModeAdmission } from "../../services/platform/src/actors/code-mode-admission.ts";
import { codeModeSandbox } from "../../services/platform/src/actors/embedded-harness-tool-host.ts";

export const organisationId = required(
  parseOrganisationId("organisation_plan50_seams"),
);
export const caseId = "case_plan50_seams";
export const sessionId = "session_plan50_seams";
export const accountId = "integration_plan50_draft";
export const userId = "user_11111111-1111-5111-8111-111111111111";
export const offerId = commerceCanonicalResourceId(
  "merchant_plan50_draft",
  "offer_financier",
);
const authority = {
  kind: "workflow",
  organisationId,
  workflowId: "workflow_plan50_seams",
  workflowRevision: 1,
};

function platformCapability(capabilityId) {
  return { kind: "platform_capability", capabilityId, capabilityVersion: 1 };
}

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export class ProposalOrganisation extends OrganisationDO {
  async install() {
    if (await this.ctx.storage.get("proposal_fixture_installed")) return;
    await this.env.DB.batch(
      JSON.parse(this.env.FIXTURE_QUERIES).map(
        prepareStatement.bind(null, this.env.DB),
      ),
    );
    const now = await seedDraftAuthority(this.env.DB);
    await seedProposalAuthority(this.env.DB, now);
    writeOwnerActivation(
      this.ctx.storage.sql,
      "organisation",
      organisationId,
      "dor_draft",
      "doa_draft",
      "dof_draft",
      ORGANISATION_ACTOR_SCHEMA_VERSION,
      now,
    );
    await this.ensureOrganisation({
      organisationId,
      name: "Pi governed proposal trial",
      plan: "beta",
      status: "active",
      createdAt: now,
    });
    const occurredAt = new Date(now).toISOString();
    const offer = {
      kind: "offer",
      projection: {
        provenance: {
          organisationId,
          integrationAccountId: accountId,
          source: "underclerk",
          resourceType: "offer",
          resourceId: offerId,
          revision: 1,
          occurredAt,
          observedAt: occurredAt,
        },
        variantId: commerceCanonicalResourceId(
          "merchant_plan50_draft",
          "variant_financier",
        ),
        salesChannelId: commerceCanonicalResourceId(
          "merchant_plan50_draft",
          "channel_financier",
        ),
        price: { amountMinor: 2400, currency: "JPY" },
        availability: { state: "available" },
        lifecycle: { state: "prepared", preparedAt: occurredAt },
      },
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO commerce_projection (organisation_id, projection_kind, canonical_id, integration_account_id, revision, lifecycle, projection_json, updated_at, validated_at, lab_run_id)
       VALUES (?, 'offer', ?, ?, 1, 'active', ?, ?, ?, NULL)`,
      organisationId,
      offerId,
      accountId,
      JSON.stringify(offer),
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO commerce_projection_relation_text (organisation_id, projection_kind, canonical_id, integration_account_id, display_name_folded, search_text_folded)
       VALUES (?, 'offer', ?, ?, 'financier', 'financier')`,
      organisationId,
      offerId,
      accountId,
    );
    await this.attachTrialAccount();
    await this.ctx.storage.put("proposal_fixture_installed", true);
  }

  // The account Worker admits the trial's workflow turns.
  async attachTrialAccount() {
    const owner = await attachTrialOrganisation(this.env, {
      organisationId,
      ownerUserId: ownerUser,
      members: {
        operator: userId,
        privateMember: "user_22222222-2222-5222-8222-222222222222",
      },
    });
    await admitTrialWorkflow(this.env, organisationId, owner, {
      nativeId: authority.workflowId,
      revision: authority.workflowRevision,
    });
  }

  evidence() {
    return this.ctx.storage.sql
      .exec("SELECT * FROM action_ledger ORDER BY created_at")
      .toArray();
  }
}

export class ProposalCase extends CaseDO {
  async install(assignment) {
    if (await this.ctx.storage.get("proposal_fixture_installed")) return;
    const now = Date.now();
    createActorActivationSchema(this.ctx.storage.sql);
    writeOwnerActivation(
      this.ctx.storage.sql,
      "case",
      caseId,
      "dor_proposal_case",
      "doa_proposal_case",
      "dof_proposal_case",
      CASE_ACTOR_SCHEMA_VERSION,
      now,
    );
    await registerCase(this.env.DB, now);
    required(
      await this.ensure({
        identity: { organisationId, caseId },
        purpose: "Review the financier price",
        workspaceRevision: "workspace_plan50_seams",
        lifecycle: { kind: "open", openedAt: now },
      }),
    );
    required(await this.assignSession(assignment));
    required(
      await this.beginAssignment({
        caseId,
        assignmentId: assignment.assignmentId,
        sessionId,
        expectedCaseRevision: assignment.caseRevision,
        start: {
          startId: "start_turn_plan50_seams",
          sessionId,
          acceptedAt: now,
        },
      }),
    );
    await this.ctx.storage.put("proposal_fixture_installed", true);
  }

  evidence() {
    return {
      proposals: this.ctx.storage.sql
        .exec(
          "SELECT proposal_id, payload, acceptance_json FROM case_commerce_proposal ORDER BY rowid",
        )
        .toArray(),
      waits: this.ctx.storage.sql
        .exec("SELECT * FROM case_commerce_approval ORDER BY rowid")
        .toArray(),
    };
  }
}

export class CandidateActor extends RecoveryActor {
  tokenLimit = 10000;

  initializeAdmission() {
    createActorExecutionBarrierSchema(this.ctx.storage.sql);
    super.initializeAdmission();
  }

  authority() {
    const assignment = this.assignment;
    if (assignment === undefined)
      throw new Error("Proposal assignment is unavailable");
    return {
      requestAuthority: this.requestAuthority(),
      authorityPartitionDigest: assignment.authorityPartition.digest,
    };
  }

  requestAuthority() {
    return authority;
  }

  // The one context object that Platform's tool handlers take.
  toolContext(execution, lease) {
    return {
      env: this.env,
      storage: this.ctx.storage,
      execution,
      lease,
      assignment: this.assignment,
    };
  }

  offerGrantIds() {
    return ["grant_native_offer_read"];
  }

  initialState() {
    const current = super.initialState();
    current.state.contract.policyVersion = "policy_1";
    return current;
  }

  turnRequest(now, startId, nextTurnId, generation) {
    const request = super.turnRequest(now, startId, nextTurnId, generation);
    request.startId = `start_${nextTurnId}`;
    request.input.caseRevision = this.assignment.caseRevision;
    return request;
  }

  inputContent() {
    return `Propose a price of JPY 2500 for this observed offer. ${JSON.stringify(this.observedOffer)}`;
  }

  holdToolIntent() {
    return false;
  }

  catalogCapabilities() {
    return [CAPABILITY_KEYS.commerceActionPropose];
  }

  toolDefinitions(host) {
    const tool = host.definitions.find(isCommerceProposal);
    if (tool === undefined)
      throw new Error("Published catalog has no commerce proposal");
    return [tool];
  }

  toolReplay(name) {
    if (name === "commerce_propose_action") return "safe";
    throw new Error("Proposal trial has no replay contract for this tool");
  }

  validateRecoverableTools(sql, generation) {
    const tool = JSON.parse(
      sql
        .exec(
          "SELECT record FROM tasks WHERE json_extract(record, '$.kind') = 'pi.tool' AND json_extract(record, '$.owner') = ?",
          generation.id,
        )
        .one().record,
    );
    if (
      tool.input.callId !== "proposal_original" ||
      tool.state.status !== "running" ||
      tool.state.checkpoint.phase !== "execute" ||
      tool.state.checkpoint.replay !== "safe"
    )
      throw new Error("Saved proposal has no receipt-backed replay contract");
  }

  async toolHost(lease) {
    await registerSession(this.env.DB, this.ctx.storage.sql);
    const admission = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      organisationId,
    );
    if (admission === null || !(await admission.isActive()))
      throw new Error("Proposal Session placement admission denied");
    const selection = await this.catalogSelection();
    const catalogDigest = await catalogHarnessToolCatalogDigest(
      TOOL_REGISTRY,
      selection,
    );
    const host = required(
      await createCatalogHarnessCodeMode({
        registry: TOOL_REGISTRY,
        expectedCatalogDigest: catalogDigest,
        catalogSelection: selection,
        admission: createHarnessCodeModeAdmission({
          env: this.env,
          storage: this.ctx.storage,
          organisationId,
          lease,
          catalogDigest,
        }),
        nativeSandbox: codeModeSandbox(this.env),
        services: {
          integrations: {
            listIntegrations: unavailableTool,
            readCustomConnector: this.readCustomConnector.bind(this, lease),
          },
          commerce: {
            readEntityContext: unavailableTool,
            readMerchantReport: unavailableTool,
            proposeCommerceAction: this.propose.bind(this, lease),
            readProductDescriptionDraft: this.readProductDescriptionDraft.bind(
              this,
              lease,
            ),
            editProductDescriptionDraft: this.editProductDescriptionDraft.bind(
              this,
              lease,
            ),
          },
          kitchen: {
            readWorkflowCanvas: this.readWorkflowCanvas.bind(this, lease),
            moveWorkflowCanvasObject: this.moveWorkflowCanvas.bind(this, lease),
          },
          menu: { readMenuDraft: unavailableTool },
          channels: {
            readEmailDraft: unavailableTool,
            editEmailDraft: unavailableTool,
          },
          files: { queryWorkspace: unavailableTool },
        },
        claimCapability: this.claimToolCapability.bind(this, lease),
        authorizeSources: this.authorizeToolSources.bind(this, lease),
      }),
    );
    return admittedSessionToolHost(
      { kind: "canonical", admission, lease },
      host,
    );
  }

  async catalogSelection() {
    return { allowedCapabilities: this.catalogCapabilities() };
  }

  async readWorkflowCanvas() {
    return rejectWorkflowCanvasTool();
  }

  async readProductDescriptionDraft() {
    return unavailableTool();
  }

  async editProductDescriptionDraft() {
    return unavailableTool();
  }

  async moveWorkflowCanvas() {
    return rejectWorkflowCanvasTool();
  }

  async readCustomConnector() {
    return unavailableTool();
  }

  async authorizeCapabilities(lease, capabilities) {
    return authorizeCapabilityUse({
      db: this.env.DB,
      accountAccess: await trialAccountAccess(this.env, organisationId),
      userAuthority: acceptedExecutionAccountAuthority(
        lease.session.sessionId,
        lease.turn.turnId,
      ),
      action: "execute",
      organisationId,
      authority: lease.requestAuthority,
      authorityPartition: this.assignment.authorityPartition,
      request: { capabilities: capabilities.map(platformCapability) },
    });
  }

  async claimToolCapability(lease, claim) {
    required(await this.authorizeCapabilities(lease, [claim.capability]));
    return super.claimToolCapability(lease, claim);
  }

  // Code Mode asks before each result reaches a script, recorded or new.
  // Like Platform, a result with no recorded capability needs only the lease.
  async authorizeToolSources(lease, capabilities) {
    for (const capability of capabilities) {
      const authorized = await this.authorizeCapabilities(lease, [capability]);
      if (!authorized.ok)
        return { ok: false, error: { detail: authorized.error.code } };
    }
    const active = preflightHarnessTurnLease(
      this.ctx.storage,
      lease,
      Date.now(),
    );
    return active.ok
      ? { ok: true, value: null }
      : { ok: false, error: { detail: active.error.code } };
  }

  async propose(lease, request) {
    const execution = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      organisationId,
    );
    if (execution === null)
      throw new Error("Proposal execution admission denied");
    const result = await proposeCommerceActionForHarness(
      {
        env: this.env,
        storage: this.ctx.storage,
        execution,
        lease,
        assignment: this.assignment,
      },
      request,
    );
    if (lease.runtimeLease.generation === 1)
      await this.provider("/proposal-result-held", { result });
    return result;
  }

  async submit() {
    // Session admission reads the registry before the offer is observed.
    await registerSession(this.env.DB, this.ctx.storage.sql);
    await this.observeOffer();
    return super.submit();
  }

  async observeOffer() {
    const lease = this.currentLease();
    required(preflightHarnessTurnLease(this.ctx.storage, lease, Date.now()));
    const current = required(
      await this.env.ORGANISATION.getByName(
        organisationId,
      ).readCurrentCommerceProjection({
        organisationId,
        kind: "offer",
        canonicalId: offerId,
      }),
    );
    if (current === null) throw new Error("Trial offer is missing");
    this.observedOffer = current;
  }

  async acceptOfferObservation() {
    const lease = this.currentLease();
    const label = required(
      await createCurrentSourceFlowLabel({
        kind: "integration_resource",
        db: this.env.DB,
        organisationId,
        integrationAccountId: accountId,
        capabilityId: "commerce.entity_plane.context",
        resourceScope: "commerce:offers",
        grantIds: this.offerGrantIds(),
      }),
    );
    const admitted = await decideContextAdmission({
      subject: {
        kind: "authority_derived",
        requestAuthority: this.requestAuthority(),
        caseId,
      },
      inputLabel: label,
    });
    if (admitted.kind !== "admit")
      throw new Error("Offer information-flow admission denied");
    const observedAt = Date.now();
    const evidence = required(
      await ObservationEvidence.create({
        source: {
          kind: "integration_resource",
          organisationId,
          integrationAccountId: accountId,
          resourceScope: "commerce:offers",
        },
        sourceRevision: this.observedOffer.projection.provenance.revision,
        contentDigest: await sha256Hex(JSON.stringify(this.observedOffer)),
        inputLabel: label,
        observedAt,
      }),
    );
    required(
      await admitSessionInformationFlowObservation({
        authorizeCommit: authorizeTrialObservationCommit.bind(
          null,
          this,
          lease,
        ),
        sql: this.ctx.storage.sql,
        transactionSync: this.ctx.storage.transactionSync.bind(
          this.ctx.storage,
        ),
        organisationId,
        sessionId,
        turnId: lease.turn.turnId,
        authorityPartitionDigest: lease.authorityPartitionDigest,
        inputLabel: label,
        observation: evidence,
        observedAt,
      }),
    );
    recordCommerceObservationEntities({
      sql: this.ctx.storage.sql,
      organisationId,
      sessionId,
      evidenceDigest: evidence.evidenceDigest,
      entities: [
        {
          entityType: "offer",
          entityId: offerId,
          revision: this.observedOffer.projection.provenance.revision,
        },
      ],
      observedAt,
    });
  }

  async registry() {
    if (this.observedOffer !== undefined) await this.acceptOfferObservation();
    return super.registry();
  }

  async admitProposalRecoveryAuthority() {
    const current = await compileTrialTurnAuthority(this.env, {
      organisationId,
      sessionId,
      turnId: "turn_plan50_seams",
      requestAuthority: this.requestAuthority(),
      policy: { version: 1 },
    });
    if (
      !current.ok ||
      current.value.authorityPartition.digest !==
        this.assignment.authorityPartition.digest
    ) {
      this.updateAction({ kind: "blocked", reason: "authorization" });
      await this.ctx.storage.deleteAlarm();
      return false;
    }
    return true;
  }

  async admitRecovery() {
    if (!(await this.admitProposalRecoveryAuthority())) return;
    return super.admitRecovery();
  }

  async fetch(request) {
    this.assignment = await this.ctx.storage.get("proposal_assignment");
    if (
      new URL(request.url).pathname === "/start" &&
      this.assignment === undefined
    ) {
      const compiled = required(
        await compileTrialTurnAuthority(this.env, {
          organisationId,
          sessionId,
          turnId: "turn_plan50_seams",
          requestAuthority: this.requestAuthority(),
          policy: { version: 1 },
        }),
      );
      this.assignment = proposalAssignment(compiled.authorityPartition);
      await this.env.CASE.getByName(`${organisationId}:${caseId}`).install(
        this.assignment,
      );
      await this.ctx.storage.put("proposal_assignment", this.assignment);
    }
    return super.fetch(request);
  }

  async alarm() {
    this.assignment = await this.ctx.storage.get("proposal_assignment");
    return super.alarm();
  }

  async snapshot() {
    return {
      ...(await super.snapshot()),
      owners: {
        organisation:
          await this.env.ORGANISATION.getByName(organisationId).evidence(),
        case: await this.env.CASE.getByName(
          `${organisationId}:${caseId}`,
        ).evidence(),
      },
    };
  }
}

export async function authorizeTrialObservationCommit(actor, lease) {
  const admission = await SessionExecutionAdmission.resolve(
    actor.env,
    actor.ctx.storage,
    organisationId,
  );
  if (admission === null)
    throw new Error("Observation Session admission denied");
  await requireSessionExecution(admission, lease);
}

function proposalAssignment(authorityPartition) {
  return {
    assignmentId: "assignment_plan50_seams",
    caseId,
    caseRevision: 0,
    sessionId,
    role: "specialist",
    objective: { instruction: "Review the financier price" },
    authority: {
      capabilityProfile: "read_and_propose",
      authorityPartitionDigest: authorityPartition.digest,
    },
    authorityPartition,
    budget: {
      budgetRevision: "budget_plan50_seams",
      maxTokens: 10000,
      maxWallMs: 60000,
      maxToolCalls: 10,
    },
    context: {
      caseId,
      revision: 0,
      journalCursor: { kind: "before_first" },
      workspaceRevision: "workspace_plan50_seams",
      entries: [],
      evidenceDependency: { kind: "source_only" },
    },
  };
}

async function seedProposalAuthority(db, now) {
  const snapshot = required(
    parseOrganisationPolicySnapshot({
      version: 1,
      egress: {
        allowedHosts: [],
        injections: [],
        modelRoute: {
          baseUrl: "https://model.fixture.invalid",
        },
      },
      authz: {
        allowedTools: [
          "commerce.action.propose",
          "commerce.entity_plane.context",
        ],
        deniedTools: [],
        approvalRequired: ["commerce.action.propose"],
        maxBudget: null,
      },
      conversationRisk: { outputScreeningMode: "hold" },
      createdAt: now,
    }),
  );
  await db.batch([
    db
      .prepare(
        "UPDATE organisation SET status = 'active' WHERE organisation_id = ?",
      )
      .bind(organisationId),
    db
      .prepare(
        "INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by) VALUES (?, 1, ?, ?, 'trial')",
      )
      .bind(organisationId, JSON.stringify(snapshot), now),
    db
      .prepare(
        "INSERT INTO cue_subscription (organisation_id, subscription_id, version, surface_scope, source, event_type, action, enabled) VALUES (?, ?, 1, '{}', 'trial', 'price_review', '{}', 1)",
      )
      .bind(organisationId, authority.workflowId),
  ]);
  const grants = [
    {
      grantId: "grant_native_offer_read",
      target: {
        kind: "provider_resource",
        capabilityId: "commerce.entity_plane.context",
        capabilityVersion: 1,
        integrationAccountId: accountId,
        resourceScope: "commerce:offers",
      },
    },
    {
      grantId: "grant_native_proposal",
      target: {
        kind: "provider_resource",
        capabilityId: "commerce.action.propose",
        capabilityVersion: 1,
        integrationAccountId: accountId,
        resourceScope: "*",
      },
    },
    {
      grantId: "grant_native_proposal_tool",
      target: {
        kind: "platform_capability",
        capabilityId: "commerce.action.propose",
        capabilityVersion: 1,
      },
    },
  ];
  for (const grant of grants)
    required(
      await createAccessGrant({
        db,
        organisationId,
        grantId: grant.grantId,
        target: grant.target,
        subject: {
          kind: "workflow",
          workflowKind: "cue_subscription",
          workflowId: authority.workflowId,
          workflowRevision: 1,
        },
        provenance: {
          kind: "operator",
          userId,
          mutationReceiptId: "receipt_trial_grants",
        },
        now,
      }),
    );
}

function writeOwnerActivation(
  sql,
  kind,
  logicalId,
  registryId,
  activationToken,
  fenceToken,
  schemaVersion,
  now,
) {
  const physicalName =
    kind === "organisation" ? organisationId : `${organisationId}:${logicalId}`;
  sql.exec(
    `INSERT INTO state_object_activation (singleton, registry_id, activation_token, organisation_id, object_kind, logical_object_id, physical_object_name, placement_kind, placement_epoch, placement_cell_id, location_hint, residency_jurisdiction, schema_version, state_version, fence_token, activated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, 'affinity', 1, 'cell-trial', 'wnam', NULL, ?, 1, ?, ?)`,
    registryId,
    activationToken,
    organisationId,
    kind,
    logicalId,
    physicalName,
    schemaVersion,
    fenceToken,
    now,
  );
}

async function registerCase(db, now) {
  await db
    .prepare(
      `INSERT INTO durable_object_registry (registry_id, activation_token, organisation_id, object_kind, logical_object_id, physical_object_name, placement_epoch, placement_cell_id, schema_version, state_version, lifecycle_status, fence_token, reserved_at, activated_at)
    VALUES ('dor_proposal_case', 'doa_proposal_case', ?, 'case', ?, ?, 1, 'cell-trial', ?, 1, 'active', 'dof_proposal_case', ?, ?)`,
    )
    .bind(
      organisationId,
      caseId,
      `${organisationId}:${caseId}`,
      CASE_ACTOR_SCHEMA_VERSION,
      now,
      now,
    )
    .run();
}

function isCommerceProposal(definition) {
  return definition.name === "commerce_propose_action";
}

function prepareStatement(db, sql) {
  return db.prepare(sql);
}

async function unavailableTool() {
  throw new Error("Tool is outside the proposal trial");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/start")
      await env.ORGANISATION.getByName(organisationId).install();
    if (url.pathname === "/revoke-proposal") {
      required(
        await revokeAccessGrant({
          db: env.DB,
          organisationId,
          grantId: "grant_native_proposal",
          expectedRevision: 1,
          reason: "Trial operator revoked the proposal grant",
          now: Date.now(),
        }),
      );
      return Response.json({ revoked: true });
    }
    return env.CANDIDATE.getByName(url.searchParams.get("scenario")).fetch(
      request,
    );
  },
};

async function rejectWorkflowCanvasTool() {
  throw new Error("Workflow canvas is outside this fixture");
}
