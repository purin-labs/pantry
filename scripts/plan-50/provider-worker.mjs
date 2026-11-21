import { failNativeStream } from "../../services/platform/src/actors/pi-durable-stream.ts";
import { armAlarmBy } from "../../services/platform/src/actors/lifecycle/actor-alarm.ts";
import proposalTrial, {
  CandidateActor as ProposalActor,
  ProposalOrganisation as ProposalOrganisationOwner,
  organisationId,
  caseId,
  sessionId,
  accountId,
  userId,
  offerId,
} from "./proposal-worker.mjs";
export { ProposalCase } from "./proposal-worker.mjs";
import { CommerceAdminClient } from "../../packages/commerce-client/src/index.ts";
import { issueControlSession } from "../../services/platform/src/data/control-plane.ts";
import { googleConfig } from "../../services/platform/src/control/google-oidc-config.ts";
import { completeCommerceApprovalFixture } from "../../services/platform/tests/e2e/commerce-approval-fixture.ts";
import {
  handleCommerceControlRoute,
  matchCommerceControlRoute,
} from "../../services/platform/src/control/routes/commerce.ts";
import { readSessionTurnFlowBinding } from "../../services/platform/src/actors/agent-session-information-flow.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  resolvePiInferenceRoute,
  dispatchPiModel,
} from "../../services/platform/src/actors/pi-model-transport.ts";
import { createEmbeddedHarnessModelRouteLease } from "../../services/platform/src/actors/session/model-route.ts";
import {
  SessionExecutionAdmission,
  admittedSessionModelRoute,
} from "../../services/platform/src/actors/session-execution-admission.ts";
import { preflightHarnessTurnLease } from "../../services/platform/src/actors/agent-session-harness-authority.ts";
import { readSessionBudgetAccount } from "../../services/platform/src/actors/agent-session-budget.ts";
import { compileTrialTurnAuthority } from "./account-authority.mjs";
import { registerSession } from "./draft-seed.mjs";
import { createSessionGoalExecution } from "../../services/platform/src/actors/session-goal-usage.ts";
import { newRequestId } from "../../services/platform/src/ids.ts";
import { bindOperatorTurnAccess } from "../../services/platform/src/chat/turn-access.ts";
import { OrganisationExecutionScope } from "../../services/platform/src/organisation-execution-scope.ts";

import {
  installProfile,
  resolveProfileBinding,
  publishProfileUpdate,
} from "./profile-binding.mjs";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { ActorSqliteDatabase } from "../../services/platform/src/actors/pi-durable-database.ts";
import { readCaseAssignmentPin } from "../../services/platform/src/data/agent-operations/case-assignment-pins.ts";

const merchantId = "merchant_plan50_draft";

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export class ProposalOrganisation extends ProposalOrganisationOwner {
  async install() {
    await super.install();
    if (await this.ctx.storage.get("provider_fixture_installed")) return;
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE app_user SET issuer = 'https://accounts.google.com', subject = 'native-provider-operator', email = 'native-provider-operator@example.invalid' WHERE user_id = ?",
      ).bind(userId),
      this.env.DB.prepare(
        "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
      ).bind(organisationId, userId),
      this.env.DB.prepare(
        "UPDATE commerce_merchant_binding SET delivery_signing_key_id = 'key_native_provider', delivery_signing_public_key_b64 = ? WHERE organisation_id = ? AND integration_account_id = ?",
      ).bind(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        organisationId,
        accountId,
      ),
      this.env.DB.prepare(
        "INSERT INTO organisation_activation_attempt (activation_attempt_id, organisation_id, readiness_version, readiness_hash, status, started_at, updated_at, completed_at) VALUES ('activation_native_provider', ?, 1, 'native-provider-ready', 'completed', ?, ?, ?)",
      ).bind(organisationId, now, now, now),
      this.env.DB.prepare(
        "INSERT INTO organisation_activation_receipt (activation_receipt_id, activation_attempt_id, organisation_id, readiness_hash, policy_snapshot_id, cue_snapshot_id, capability_profile, activated_at) VALUES ('receipt_native_provider_activation', 'activation_native_provider', ?, 'native-provider-ready', 'policy_1', 'cue_native_provider', 'approved_provider_writes', ?)",
      ).bind(organisationId, now),
      this.env.DB.prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', capability_profile = 'approved_provider_writes', activation_receipt_id = 'receipt_native_provider_activation', activated_at = ? WHERE organisation_id = ?",
      ).bind(now, organisationId),
    ]);
    const client = new CommerceAdminClient({
      baseUrl: this.env.COMMERCE_BASE_URL,
      serviceToken: this.env.COMMERCE_SERVICE_TOKEN,
      fetch: this.env.COMMERCE.fetch.bind(this.env.COMMERCE),
    });
    const offer = await prepareProviderOffer(client);
    const current = required(
      await this.readCurrentCommerceProjection({
        organisationId,
        kind: "offer",
        canonicalId: offerId,
      }),
    );
    current.projection.provenance.revision = offer.revision;
    current.projection.provenance.occurredAt = offer.occurredAt;
    current.projection.provenance.observedAt = new Date().toISOString();
    current.projection.lifecycle = offer.lifecycle;
    this.ctx.storage.sql.exec(
      "UPDATE commerce_projection SET revision = ?, projection_json = ? WHERE organisation_id = ? AND canonical_id = ? AND integration_account_id = ?",
      offer.revision,
      JSON.stringify(current),
      organisationId,
      offerId,
      accountId,
    );
    await this.ctx.storage.put("provider_fixture_installed", true);
  }
}

export class CandidateActor extends ProposalActor {
  harnessSettings() {
    return {
      retry: { maxRetries: 0 },
      compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1000 },
    };
  }

  catalogCapabilities() {
    if (this.profileBinding?.kind !== "resolved")
      throw new Error("Trusted tools require the pinned agent profile");
    return this.profileBinding.profile.grantedCapabilities;
  }

  extensionName() {
    return this.profileBinding.extensionName;
  }

  rootAgent(model) {
    return {
      model: { provider: model.provider, modelId: model.id },
      extensions: [this.trustedExtension],
      instructions: this.profileBinding.instructions,
    };
  }

  async resolveProfileBinding() {
    const artifact = await this.ctx.storage.get("extension_artifact");
    const version = artifact === "incompatible" ? 2 : 1;
    const binding = await resolveProfileBinding(
      this.env,
      organisationId,
      this.assignment,
      version,
    );
    if (binding.kind !== "resolved")
      return { kind: "blocked", reason: "profile_unavailable" };
    if (artifact === "missing")
      return { kind: "blocked", reason: "implementation_missing" };
    return binding;
  }

  async admitExtensionRecovery() {
    const binding = await this.resolveProfileBinding();
    let reason = binding.kind === "blocked" ? binding.reason : null;
    if (binding.kind === "resolved") {
      const storage = await SqliteStorage.open(
        new ActorSqliteDatabase(this.ctx.storage),
      );
      try {
        const task = await storage.task(
          Number(this.lifecycle().state.continuation.harnessTaskId),
          BACKGROUND_CONTEXT,
        );
        if (task === undefined) throw new Error("Missing saved native task");
        const document = await storage.findDocument(
          {
            kind: "pi.agent",
            scope: {
              kind: "conversation",
              conversationId: task.conversationId,
            },
          },
          "current",
          BACKGROUND_CONTEXT,
        );
        const saved =
          document === undefined
            ? undefined
            : await storage.document(
                document.id,
                "current",
                BACKGROUND_CONTEXT,
              );
        if (
          saved?.value.instructions !== binding.instructions ||
          !Array.isArray(saved?.value.extensions) ||
          saved.value.extensions.length !== 1 ||
          saved.value.extensions[0] !== binding.extensionName
        )
          reason = "implementation_incompatible";
      } finally {
        await storage.close(BACKGROUND_CONTEXT);
      }
    }
    if (reason === null) return true;
    this.updateAction({ kind: "blocked", reason: "implementation" });
    await this.ctx.storage.deleteAlarm();
    await this.provider("/extension-blocked", { reason });
    return false;
  }

  async createModelRegistry() {
    await installProfile(
      this.env.DB,
      organisationId,
      userId,
      this.profileCapabilities(),
    );
    this.profileBinding = await this.resolveProfileBinding();
    if (this.profileBinding.kind !== "resolved")
      throw new Error(this.profileBinding.reason);
    await registerSession(this.env.DB, this.ctx.storage.sql);
    const route = await this.resolveNativeRoute(this.currentLease());
    await this.prepareGoalExecution();
    const models = createModels();
    models.setProvider({
      id: route.provider.id,
      name: route.provider.name,
      auth: {
        apiKey: {
          name: "Pantry admission",
          resolve: this.nativeModelAuth.bind(this),
        },
      },
      getModels: nativeModels.bind(null, route),
      stream: unsupportedNativeStream,
      streamSimple: this.streamNativeModel.bind(this),
    });
    return { models, model: route.model };
  }

  async resolveNativeRoute(lease) {
    const admission = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      organisationId,
    );
    if (admission === null)
      throw new Error("Native model placement admission denied");
    const current = this.lifecycle();
    const routeLease = required(
      await createEmbeddedHarnessModelRouteLease({
        env: this.env,
        scope: admission.scope,
        sessionId,
        modelRoute: current.state.contract.modelRoute,
      }),
    );
    return required(
      resolvePiInferenceRoute({
        model: current.state.contract.modelRoute.model,
        modelTokenAllowance: this.tokenLimit,
        modelRouteLease: admittedSessionModelRoute(
          { kind: "canonical", admission, lease },
          routeLease,
        ),
      }),
    );
  }

  async nativeModelAuth() {
    const route = await this.resolveNativeRoute(this.currentLease());
    const apiKey = await route.resolveModelApiKey();
    return { auth: { apiKey } };
  }

  profileCapabilities() {
    return super.catalogCapabilities();
  }

  async prepareSubmittedTurn() {
    await super.prepareSubmittedTurn();
    const scope = required(
      await OrganisationExecutionScope.resolve(this.env, organisationId),
    );
    await this.bindFixtureTurnOrigin(scope, this.currentLease());
  }

  async bindFixtureTurnOrigin(scope, lease) {
    const authority = lease.requestAuthority;
    if (authority.kind !== "control") return;
    const key = `evaluation_control_origin:${authority.userId}`;
    let origin = await this.ctx.storage.get(key);
    if (origin === undefined) {
      const issued = await issueControlSession({
        db: this.env.DB,
        userId: authority.userId,
        now: Date.now(),
        ttlMs: 60 * 60_000,
      });
      origin = {
        kind: "control_session",
        controlSessionId: issued.session.controlSessionId,
      };
      await this.ctx.storage.put(key, origin);
    }
    if (
      !(await bindOperatorTurnAccess(
        scope,
        sessionId,
        lease.turn.turnId,
        authority,
        origin,
      ))
    )
      throw new Error("Native trial operator origin binding failed");
  }

  async prepareGoalExecution() {
    this.goalExecution = await createSessionGoalExecution(
      { env: this.env, storage: this.ctx.storage, liveRuns: new Set() },
      this.currentLease(),
      this.assignment,
      newRequestId(),
    );
  }

  streamNativeModel(model, context, options) {
    const output = createAssistantMessageEventStream();
    const lease = this.currentLease();
    void this.forwardNativeModel(model, context, options, lease, output).catch(
      failNativeStream.bind(null, output, model),
    );
    return output;
  }

  async admitNativeModel(route, model, lease) {
    required(preflightHarnessTurnLease(this.ctx.storage, lease, Date.now()));
    const authority = required(
      await compileTrialTurnAuthority(this.env, {
        organisationId,
        sessionId: lease.session.sessionId,
        turnId: lease.turn.turnId,
        requestAuthority: lease.requestAuthority,
        policy: { version: 1 },
      }),
    );
    if (authority.authorityPartition.digest !== lease.authorityPartitionDigest)
      throw new Error("Native model policy or grants changed");
    const current = this.lifecycle();
    if (
      current.kind !== "processing" ||
      model.provider !== route.model.provider ||
      model.id !== current.state.contract.modelRoute.model
    )
      throw new Error("Native model differs from the pinned route");
    const budget = required(
      readSessionBudgetAccount(this.ctx.storage.sql, {
        organisationId,
        sessionId,
      }),
    );
    if (
      budget.kind !== "open" ||
      budget.reservation.kind !== "active" ||
      budget.reservation.reservation.deadlineAt <= Date.now()
    )
      throw new Error("Native model budget admission denied");
    const tokenAllowance =
      budget.reservation.reservation.allowance.tokens -
      budget.reservation.acceptedUsage.tokens;
    if (tokenAllowance <= 0)
      throw new Error("Native model token budget exhausted");
    required(preflightHarnessTurnLease(this.ctx.storage, lease, Date.now()));
    return tokenAllowance;
  }

  async forwardNativeModel(model, context, options, lease, output) {
    const currentRoute = await this.resolveNativeRoute(lease);
    const tokenAllowance = await this.admitNativeModel(
      currentRoute,
      model,
      lease,
    );
    const apiKey = await currentRoute.resolveModelApiKey();
    const dispatched = required(
      await dispatchPiModel({
        route: currentRoute,
        apiKey,
        response: { refused: null },
        context,
        sessionId,
        tokenAllowance,
        goalModelCalls: this.goalExecution.control,
        options,
      }),
    );
    for await (const event of dispatched) {
      required(preflightHarnessTurnLease(this.ctx.storage, lease, Date.now()));
      if (event.type === "done")
        await this.admitNativeModel(currentRoute, model, lease);
      output.push(event);
      if (
        event.type === "text_delta" &&
        event.delta.includes("R50_PARTIAL_RESPONSE_UNACCEPTED")
      ) {
        await this.provider("/partial-model-observed", {
          type: event.type,
          delta: event.delta,
        });
      }
    }
    output.end(await dispatched.result());
  }

  async admitRecovery() {
    if (!(await this.admitExtensionRecovery())) return;
    if (!(await this.admitProposalRecoveryAuthority())) return;
    const current = this.lifecycle();
    const entry = await this.pendingAction();
    switch (entry.state) {
      case "indeterminate":
      case "executing":
        if (current.state.action.kind !== "await_evidence")
          this.updateAction({
            kind: "await_evidence",
            evidence: {
              kind: "effect_receipt",
              effectId: `effect_provider_${entry.action.nonce.value}`,
            },
          });
        await this.ctx.storage.deleteAlarm();
        return;
      case "confirmed":
      case "failed":
        if (current.state.action.kind === "await_evidence") {
          await this.ctx.storage.deleteAlarm();
          return;
        }
        return super.admitRecovery();
      default:
        throw new Error(
          "Provider trial requires its accepted execution or terminal receipt",
        );
    }
  }

  async pendingAction() {
    const owners =
      await this.env.ORGANISATION.getByName(organisationId).evidence();
    if (owners.length !== 1)
      throw new Error("Native provider continuation requires one proposal");
    return required(
      await this.env.ORGANISATION.getByName(organisationId).getAction({
        organisationId,
        nonce: owners[0].nonce,
        now: Date.now(),
      }),
    );
  }

  async fetch(request) {
    const profilePath = new URL(request.url);
    if (profilePath.pathname === "/extension-change") {
      const kind = profilePath.searchParams.get("kind");
      if (kind !== "missing" && kind !== "incompatible")
        throw new Error("Invalid extension fault");
      await this.ctx.storage.put("extension_artifact", kind);
      return Response.json({ kind });
    }
    if (profilePath.pathname === "/profile-update") {
      await publishProfileUpdate(
        this.env.DB,
        organisationId,
        userId,
        this.catalogCapabilities(),
      );
      return Response.json({ published: true });
    }
    if (new URL(request.url).pathname === "/compact") {
      const { root } = await this.getRuntime();
      const taskId = await root.compact(undefined, BACKGROUND_CONTEXT);
      return Response.json({ taskId });
    }
    if (new URL(request.url).pathname !== "/release-provider")
      return super.fetch(request);
    this.assignment = await this.ctx.storage.get("proposal_assignment");
    const current = this.lifecycle();
    const action = await this.pendingAction();
    if (
      current?.kind !== "recovering" ||
      current.state.action.kind !== "await_evidence" ||
      current.state.action.evidence.kind !== "effect_receipt" ||
      current.state.action.evidence.effectId !==
        `effect_provider_${action.action.nonce.value}`
    )
      throw new Error(
        "Receipt release requires the original saved provider evidence wait",
      );
    if (action.state !== "confirmed" && action.state !== "failed")
      return Response.json({ kind: "await_receipt" });
    const flow = required(
      await readSessionTurnFlowBinding(this.ctx.storage.sql, {
        organisationId,
        sessionId: this.assignment.sessionId,
        turnId: current.state.activeTurn.state.identity.turnId,
      }),
    );
    if (
      flow === null ||
      flow.authorityPartitionDigest !== action.action.authorityPartition.digest
    )
      throw new Error(
        "Provider receipt differs from the native turn authority",
      );
    this.updateAction({ kind: "resume_task" });
    await armAlarmBy(this.ctx.storage, Date.now() + 1_000);
    return Response.json({
      kind: "resolved",
      nonce: action.action.nonce.value,
      providerResult: action.providerResult,
    });
  }

  async snapshot() {
    const snapshot = await super.snapshot();
    return {
      ...snapshot,
      profilePin: await readCaseAssignmentPin(
        this.env.DB,
        organisationId,
        "assignment_plan50_seams",
      ),
      providerCase: required(
        await this.env.CASE.getByName(`${organisationId}:${caseId}`).inspect(),
      ),
    };
  }
}

function nativeModels(route) {
  return [route.model];
}

function unsupportedNativeStream() {
  throw new Error("Native harness uses admitted simple requests");
}

async function prepareProviderOffer(client) {
  const now = new Date().toISOString();
  const provisioned = required(
    await client.provisionMerchant({
      schemaVersion: "commerce.provision-merchant.v2",
      externalReference: organisationId,
      merchantId,
      createdAt: now,
    }),
  );
  if (provisioned.outcome !== "provisioned")
    throw new Error("Merchant provision failed");
  const prepared = required(
    await client.prepareCatalogListing({
      merchantId,
      expectedMerchantRevision: 0,
      idempotencyKey: "native_provider_prepare",
      salesChannel: {
        id: "channel_financier",
        revision: 1,
        name: "Online",
        kind: "online",
        lifecycle: { state: "active", activeAt: now },
        occurredAt: now,
      },
      product: {
        id: "product_financier",
        revision: 1,
        title: "Financier",
        description: "Almond financier.",
        occurredAt: now,
      },
      variant: {
        id: "variant_financier",
        revision: 1,
        productId: "product_financier",
        sku: "NATIVE-FINANCIER",
        title: "Financier",
        options: [],
        media: [],
        occurredAt: now,
      },
      offer: {
        id: "offer_financier",
        revision: 1,
        variantId: "variant_financier",
        salesChannelId: "channel_financier",
        price: { amountMinor: 2400, currency: "JPY" },
        availability: { state: "available" },
        lifecycle: { state: "prepared", preparedAt: now },
        occurredAt: now,
      },
      consumptionPlan: {
        consumptionPlanId: "plan_native_financier",
        variantId: "variant_financier",
        revision: 1,
        scope: { kind: "organisation" },
        mode: { kind: "untracked" },
        lifecycle: "active",
      },
    }),
  );
  if (prepared.outcome !== "applied") throw new Error(JSON.stringify(prepared));
  const published = required(
    await client.publishCatalogListing({
      merchantId,
      idempotencyKey: "native_provider_publish",
      productId: "product_financier",
      productRevision: 1,
      variantId: "variant_financier",
      variantRevision: 1,
      offerId: "offer_financier",
      offerRevision: 1,
      salesChannelId: "channel_financier",
      salesChannelRevision: 1,
    }),
  );
  if (published.outcome !== "applied")
    throw new Error(JSON.stringify(published));
  const policy = required(
    await client.setOfferPricePolicy({
      merchantId,
      offerId: "offer_financier",
      expectedRevision: null,
      maxMovementBps: 1000,
      occurredAt: now,
    }),
  );
  if (policy.outcome !== "accepted") throw new Error(JSON.stringify(policy));
  const snapshot = required(await client.readSnapshot(merchantId));
  const offer = snapshot.resources.offers.find(isTrialOffer);
  if (offer === undefined || offer.lifecycle.state !== "listed")
    throw new Error("Provider fixture requires the listed offer");
  return offer;
}

function isTrialOffer(offer) {
  return offer.id === "offer_financier";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/control/")) {
      const route = matchCommerceControlRoute(url.pathname);
      if (route === null)
        throw new Error(
          "Provider trial uses only existing commerce control routes",
        );
      return handleCommerceControlRoute(request, env, route);
    }
    if (url.pathname === "/operator-session")
      return Response.json(
        await issueControlSession({
          db: env.DB,
          userId,
          now: Date.now(),
          ttlMs: 30 * 60_000,
        }),
      );
    if (url.pathname === "/approval-fixture") {
      const config = googleConfig(env);
      if (config === null)
        throw new Error("Missing native approval fixture configuration");
      const action = required(
        await env.ORGANISATION.getByName(organisationId).getAction({
          organisationId,
          nonce: url.searchParams.get("nonce"),
          now: Date.now(),
        }),
      );
      return Response.json({
        grant: await completeCommerceApprovalFixture({
          db: env.DB,
          config,
          action: action.action,
          userId,
          subject: "native-provider-operator",
          email: "native-provider-operator@example.invalid",
          stepUpId: "native-provider-step-up",
        }),
      });
    }
    return proposalTrial.fetch(request, env);
  },
};
