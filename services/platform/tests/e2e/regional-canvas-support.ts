import interrupted from "../../../../assets/bakery-mujoco/combined-bakery/rust-evidence/shared-run-interrupted.json";
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { http } from "msw";
import { isRecord, sha256Hex } from "@purin-labs/std";
import { parseRunSnapshot } from "@purin-labs/bakery-model/bakery-run-snapshot";
import { network } from "./network";
import { openRouterText } from "./slack-journey-support";
import { commerceHeaders } from "./commerce-support";
import {
  issueControlSession,
  type IssuedControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import { createAccessGrant } from "@purin-labs/authority/data/access-grants";
import { parseUserId } from "@purin-labs/control-api/ids";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import { bakeryRunSnapshotPrefix } from "@purin-labs/area-kitchen/server/bakery/saved-runs";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { PLATFORM_DEFAULT_PI_MODEL } from "@purin-labs/agent/actors/pi-model-transport";

export type RegionalCanvas = Readonly<{
  url: string;
  session: IssuedControlSession;
  generations: readonly string[];
}>;

export async function seedRegionalCanvas(
  scope: OrganisationExecutionScope,
): Promise<RegionalCanvas> {
  const owner = await scope.database
    .prepare(
      "SELECT user_id FROM service_role_grant WHERE organisation_id = ? AND role = 'owner'",
    )
    .bind(scope.organisationId)
    .first("user_id");
  if (typeof owner !== "string") throw new Error("Missing regional owner");
  const user = parseUserId(owner);
  if (!user.ok) throw new Error(user.error.code);
  await scope.database.batch([
    scope.database
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'canvas_recovery', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(Date.now(), scope.organisationId),
    scope.database
      .prepare(
        "INSERT INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at) VALUES (?, 'pantry_platform', ?, ?)",
      )
      .bind(scope.organisationId, user.value, Date.now()),
  ]);
  const grant = await createAccessGrant({
    db: scope.database,
    organisationId: scope.organisationId,
    grantId: "grant_canvas_recovery",
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "platform_capability",
      capabilityId: "context.case.read",
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_canvas_recovery",
    },
    now: Date.now(),
  });
  if (!grant.ok) throw new Error(grant.error.code);
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: scope.organisationId,
    now: Date.now(),
  });
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: scope.database, kv: env.POLICY_KV },
    organisationId: scope.organisationId,
    organisation,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(policy.error.code);
  const snapshot = parseRunSnapshot({
    name: "Regional canvas history",
    document: interrupted,
  });
  if (snapshot === null) throw new Error("Invalid regional canvas fixture");
  const id = await sha256Hex(snapshot.content);
  await env.ARCHIVE.put(
    bakeryRunSnapshotPrefix(scope.organisationId) + id,
    snapshot.content,
    {
      customMetadata: { name: snapshot.name, kind: snapshot.kind },
      httpMetadata: { contentType: "application/json" },
    },
  );
  const session = await issueControlSession({
    db: env.DB,
    userId: user.value,
    now: Date.now(),
    ttlMs: 600_000,
  });
  const url = `https://localhost/v1/control/organisations/${scope.organisationId}/collaboration/workflow-canvas/${encodeURIComponent(`run:${id}`)}/chat`;
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", regionalReply),
  );
  const opened = await exports.default.fetch(url, {
    method: "POST",
    headers: commerceHeaders(session),
  });
  const first = conversationId(await opened.json());
  await completeCanvasTurn(
    scope,
    session,
    url,
    id,
    first,
    "First generation retained reply",
  );
  const continued = await exports.default.fetch(`${url}/continue`, {
    method: "POST",
    headers: commerceHeaders(session),
    body: JSON.stringify({ conversationId: first }),
  });
  const second = conversationId(await continued.json());
  await completeCanvasTurn(
    scope,
    session,
    url,
    id,
    second,
    "Second generation retained reply",
  );
  const fixture = { url, session, generations: [first, second] };
  await verifyRegionalCanvas(fixture);
  return fixture;
}
function regionalReply(): Response {
  return openRouterText(
    JSON.stringify({
      kind: "reply",
      text: "The canvas history survives recovery.",
    }),
    "regional_canvas_reply",
  );
}
function conversationId(raw: unknown): string {
  if (!isRecord(raw) || typeof raw.conversationId !== "string")
    throw new Error(`Missing canvas conversation: ${JSON.stringify(raw)}`);
  return raw.conversationId;
}
async function completeCanvasTurn(
  scope: OrganisationExecutionScope,
  session: IssuedControlSession,
  url: string,
  snapshotId: string,
  id: string,
  text: string,
): Promise<void> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${scope.organisationId}/chat?canvas=${encodeURIComponent(`run:${snapshotId}`)}`,
    {
      method: "POST",
      headers: commerceHeaders(session),
      body: JSON.stringify({
        kind: "message",
        conversationId: id,
        requestId: `request_${id}`,
        model: PLATFORM_DEFAULT_PI_MODEL,
        text,
        browserContext: { kind: "unavailable" },
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  await response.body?.cancel();
  await expect
    .poll(readCanvas.bind(null, url, session), { timeout: 20_000 })
    .toMatchObject({
      kind: "ready",
      conversation: { work: { kind: "ready" } },
    });
}
async function readCanvas(
  url: string,
  session: IssuedControlSession,
): Promise<unknown> {
  const response = await exports.default.fetch(url, {
    headers: commerceHeaders(session),
  });
  expect(response.status).toBe(200);
  return response.json();
}
export async function verifyRegionalCanvas(
  fixture: RegionalCanvas,
): Promise<void> {
  const current = await readCanvas(fixture.url, fixture.session);
  expect(current).toMatchObject({
    kind: "ready",
    currentConversationId: fixture.generations[1],
    conversations: [
      { id: fixture.generations[1], generation: 2 },
      { id: fixture.generations[0], generation: 1 },
    ],
  });
  for (const id of fixture.generations) {
    const history = await readCanvas(
      `${fixture.url}?conversation=${id}`,
      fixture.session,
    );
    expect(history).toMatchObject({
      kind: "ready",
      conversation: { id, work: { kind: "ready" } },
    });
    expect(JSON.stringify(history)).toContain(
      "The canvas history survives recovery.",
    );
  }
}

export async function continueRecoveredCanvas(
  scope: OrganisationExecutionScope,
  fixture: RegionalCanvas,
): Promise<void> {
  const continued = await exports.default.fetch(`${fixture.url}/continue`, {
    method: "POST",
    headers: commerceHeaders(fixture.session),
    body: JSON.stringify({ conversationId: fixture.generations[1] }),
  });
  const third = conversationId(await continued.json());
  const documentId = decodeURIComponent(
    new URL(fixture.url).pathname.split("/").at(-2) ?? "",
  );
  await completeCanvasTurn(
    scope,
    fixture.session,
    fixture.url,
    documentId.slice(4),
    third,
    "Continue after regional recovery",
  );
  expect(await readCanvas(fixture.url, fixture.session)).toMatchObject({
    kind: "ready",
    currentConversationId: third,
    conversations: [
      { id: third, generation: 3 },
      { id: fixture.generations[1], generation: 2 },
      { id: fixture.generations[0], generation: 1 },
    ],
  });
  expect(
    JSON.stringify(
      await readCanvas(
        `${fixture.url}?conversation=${fixture.generations[0]}`,
        fixture.session,
      ),
    ),
  ).toContain("The canvas history survives recovery.");
}
