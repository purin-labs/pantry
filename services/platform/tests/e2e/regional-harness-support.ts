import { newConversationId } from "@purin-labs/control-api";
import { readConversation, saveConversation } from "../../src/chat/store";
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import { network } from "./network";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";
import {
  issueControlSession,
  revokeControlSession,
} from "../../src/data/control-plane";
import { createAccessGrant } from "../../src/data/access-grants";
import { parseUserId } from "@purin-labs/control-api/ids";
import { requireActiveOrganisationActorAtPlacement } from "../../src/actors/actor-router";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import type { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

const CONVERSATION = "conv_c55af3e2-19c2-446a-9f44-e00000000055";

export async function regionalHarnessJourney(
  scope: OrganisationExecutionScope,
  other: OrganisationExecutionScope,
  stage: "initial" | "relocated" | "cleaned",
): Promise<void> {
  const owner = await scope.database
    .prepare(
      "SELECT user_id AS userId FROM service_role_grant WHERE organisation_id = ? AND role = 'owner'",
    )
    .bind(scope.organisationId)
    .first<{ userId: string }>();
  if (owner === null) throw new Error("Missing owner");
  const userId = parseUserId(owner.userId);
  if (!userId.ok) throw new Error(userId.error.code);
  if (stage === "initial") {
    await scope.database
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'regional_harness', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(Date.now(), scope.organisationId)
      .run();
    await scope.database
      .prepare(
        "INSERT INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at) VALUES (?, 'satyr_platform', ?, ?) ON CONFLICT (organisation_id) DO UPDATE SET selection_kind = excluded.selection_kind",
      )
      .bind(scope.organisationId, userId.value, Date.now())
      .run();
    for (const capabilityId of [
      "context.case.read",
      "integration.discovery.read",
    ]) {
      const grant = await createAccessGrant({
        db: scope.database,
        organisationId: scope.organisationId,
        grantId: `grant_${scope.organisationId}_${capabilityId}`,
        subject: { kind: "organisation_role", role: "owner" },
        target: {
          kind: "platform_capability",
          capabilityId,
          capabilityVersion: 1,
        },
        provenance: {
          kind: "baseline",
          profile: "read_and_propose",
          profileVersion: 1,
          materializationReceiptId: `regional_${scope.organisationId}`,
        },
        now: Date.now(),
      });
      if (!grant.ok) throw new Error(grant.error.code);
    }
    const organisation = await requireActiveOrganisationActorAtPlacement({
      env,
      organisationId: scope.organisationId,
      placement: scope.placement,
      now: Date.now(),
    });
    const published = await compilePublishAndActivateOrganisationPolicy({
      bindings: { db: scope.database, kv: env.POLICY_KV },
      organisationId: scope.organisationId,
      organisation,
      now: Date.now(),
    });
    if (!published.ok) throw new Error(published.error.code);
  }
  const conversations = {
    initial: CONVERSATION,
    relocated: "conv_c55af3e2-19c2-446a-9f44-e00000000056",
    cleaned: "conv_c55af3e2-19c2-446a-9f44-e00000000057",
  };
  const conversationId = conversations[stage];
  const session = await issueControlSession({
    db: env.DB,
    userId: userId.value,
    now: Date.now(),
    ttlMs: 600_000,
  });
  const model = new RegionalModel();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );
  const headers = {
    origin: "https://localhost",
    "content-type": "application/json",
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
    "x-satyr-csrf": session.csrfToken,
  };
  const command = JSON.stringify({
    kind: "message",
    conversationId,
    requestId: `request_${conversationId}`,
    model: PLATFORM_DEFAULT_PI_MODEL,
    text: "List connected integrations.",
    surfaceContext: null,
    browserContext: {
      kind: "available",
      binding: {
        browserInstanceId: "browser_regional",
        conversationId,
      },
    },
  });
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${scope.organisationId}/chat`,
    { method: "POST", headers, body: command },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  await response.text();
  try {
    await expect
      .poll(
        readRegionalConversation.bind(null, scope, headers, conversationId),
        {
          timeout: 25_000,
        },
      )
      .toContain("Regional tool turn completed");
  } catch (error) {
    throw new Error(
      `Harness ${stage}, requests=${model.requests}: ${await readRegionalConversation(scope, headers, conversationId)}`,
      { cause: error },
    );
  }
  expect(model.requests).toBe(3);
  const foreign = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${other.organisationId}/chat`,
    { method: "POST", headers, body: command },
  );
  expect(foreign.status).toBe(404);
  expect(model.requests).toBe(3);
  await revokeControlSession({
    db: env.DB,
    session: session.session,
    now: Date.now(),
  });
  const revoked = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${scope.organisationId}/chat?conversation=${conversationId}`,
    { headers },
  );
  expect(revoked.status).toBe(401);
}

class RegionalModel {
  requests = 0;
  respond(_request: Parameters<HttpResponseResolver>[0]): Response {
    this.requests += 1;
    if (this.requests === 1)
      return openRouterToolCall(
        "tool_search",
        { query: "integration_list", limit: 1 },
        "regional_discovery",
      );
    if (this.requests === 2)
      return openRouterToolCall(
        "integration_list",
        {},
        "regional_integrations",
      );
    return openRouterText(
      JSON.stringify({ kind: "reply", text: "Regional tool turn completed" }),
      "regional_complete",
    );
  }
}

async function readRegionalConversation(
  scope: OrganisationExecutionScope,
  headers: Record<string, string>,
  conversationId: string,
): Promise<string> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${scope.organisationId}/chat?conversation=${conversationId}`,
    { headers },
  );
  return response.text();
}

export async function verifyConversationWriteFence(
  execution: OrganisationExecutionScope,
  placementState: "active" | "frozen",
): Promise<void> {
  const owner = await execution.database
    .prepare(
      "SELECT user_id AS userId FROM service_role_grant WHERE organisation_id = ? AND role = 'owner'",
    )
    .bind(execution.organisationId)
    .first<{ userId: string }>();
  if (owner === null) throw new Error("Missing conversation owner");
  const userId = parseUserId(owner.userId);
  if (!userId.ok) throw new Error(userId.error.code);
  const scope = {
    organisationId: execution.organisationId,
    userId: userId.value,
  };
  const stored = await readConversation(
    execution.database,
    scope,
    CONVERSATION,
  );
  if (stored === null) throw new Error("Missing regional conversation");
  const result = await saveConversation(
    execution,
    userId.value,
    stored.conversation,
    stored.revision,
  );
  if (placementState === "active") {
    expect(result).toEqual({ kind: "saved" });
    return;
  }
  expect(result).toEqual({ kind: "conflict" });
  const destinationId = newConversationId();
  expect(
    await saveConversation(
      execution,
      userId.value,
      { ...stored.conversation, id: destinationId },
      0,
    ),
  ).toEqual({ kind: "conflict" });
  expect(
    await readConversation(execution.database, scope, destinationId),
  ).toBeNull();
  expect(
    await readConversation(execution.database, scope, CONVERSATION),
  ).toEqual(stored);
}
