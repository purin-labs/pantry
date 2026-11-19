import type { OrganisationDatabase } from "../../src/database-handles";
import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { createEmbeddedHarnessModelRouteLease } from "../../src/actors/session/model-route";
import { resolveClaudeAccessToken } from "../../src/models/claude-connection";
import { parseVaultHandle, storeVaultSecret } from "../../src/credential-vault";
import { resolveVaultHandle } from "../../src/credential-vault/service";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { parseSessionId, parseUserId } from "../../src/ids";
import { resolveOrganisationModelRouteAtScope } from "../../src/models/route";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { network } from "./network";
import {
  RecordingBoundary,
  sdkInput,
  restoredInput,
  runSdkTurn,
} from "./pi-sdk-support";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
} from "./slack-journey-support";

it(
  "connects Claude through Portal, restores Pi after token refresh, and fences replay, reconnect and disconnect",
  claudeOAuthJourney,
  120_000,
);

async function claudeOAuthJourney({ task }: TestContext): Promise<void> {
  await installSlackActorFixture();
  const user = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!user.ok) throw new Error(user.error.code);
  const session = await issueControlSession({
    db: env.DB,
    userId: user.value,
    now: Date.now(),
    ttlMs: 600_000,
  });
  const provider = new ClaudeProvider();
  network.use(
    http.post(
      "https://platform.claude.com/v1/oauth/token",
      provider.tokens.bind(provider),
    ),
    http.post(
      "https://api.anthropic.com/v1/messages",
      provider.messages.bind(provider),
    ),
    http.post("https://openrouter.ai/api/v1/chat/completions", rejectFallback),
  );
  const denied = await request(session, "POST", { kind: "start" });
  expect(denied.status).toBe(404);
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, user.value)
    .run();
  const noCsrf = await exports.default.fetch(
    new Request(connectionUrl(), {
      method: "POST",
      headers: {
        cookie: `satyr_control_session=${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "start" }),
    }),
  );
  expect(noCsrf.status).toBe(403);

  const authorization = await start(session);
  provider.state =
    new URL(authorization.authorizationUrl).searchParams.get("state") ?? "";
  expect(provider.state).not.toBe("");
  const resumed = await exports.default.fetch(
    new Request(connectionUrl(), { headers: headers(session) }),
  );
  expect(await resumed.json()).toMatchObject({
    authorization: {
      kind: "authorizing",
      authorization: { attemptId: authorization.attemptId },
    },
  });
  const wrongState = await request(session, "POST", {
    kind: "complete",
    attemptId: authorization.attemptId,
    code: "code#wrong-state",
  });
  expect(wrongState.status).toBe(409);
  expect(provider.exchanges).toBe(0);
  const completion = {
    kind: "complete",
    attemptId: authorization.attemptId,
    code: `code#${provider.state}`,
  };
  const completed = await request(session, "POST", completion);
  expect(
    completed.status,
    JSON.stringify({
      body: await completed.json(),
      exchanges: provider.exchanges,
    }),
  ).toBe(200);
  expect((await request(session, "POST", completion)).status).toBe(409);
  expect(provider.exchanges).toBe(1);
  const inferenceUrl = connectionUrl().replace("/claude", "");
  const source = await exports.default.fetch(
    new Request(inferenceUrl, { headers: headers(session) }),
  );
  const sourceBody = await source.json<{ configurationVersion: number }>();
  const selectionHeaders = headers(session);
  selectionHeaders.set(
    "x-satyr-configuration-version",
    String(sourceBody.configurationVersion),
  );
  selectionHeaders.set("idempotency-key", "claude-oauth-e2e-select");
  const selected = await exports.default.fetch(
    new Request(inferenceUrl, {
      method: "PUT",
      headers: selectionHeaders,
      body: JSON.stringify({ selection: { kind: "claude_oauth" } }),
    }),
  );
  expect(selected.status).toBe(200);

  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const route = await resolveOrganisationModelRouteAtScope({
    env,
    scope,
    now: Date.now(),
  });
  if (!route.ok || route.value.keySource !== "organisation_oauth")
    throw new Error("Missing Claude route");
  const boundary = new RecordingBoundary();
  const base = sdkInput(boundary, [], "direct");
  const sessionId = parseSessionId(base.sessionId);
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const lease = await createEmbeddedHarnessModelRouteLease({
    env,
    scope,
    sessionId: sessionId.value,
    modelRoute: route.value,
  });
  if (!lease.ok) throw new Error(lease.error.code);
  const input = {
    ...base,
    model: route.value.model,
    modelRouteLease: lease.value,
  };
  const first = await runSdkTurn(input, "Return CLAUDE_OAUTH_READY.");
  expect(first.finalMessage).toBe("CLAUDE_OAUTH_READY");
  expect(first.modelUsage.totalTokens).toBe(15);

  await expireTokens(scope.database);
  const [second, concurrentToken] = await Promise.all([
    runSdkTurn(
      restoredInput(input, first, boundary, "claude_refresh"),
      "Use the previous answer and return CLAUDE_OAUTH_RESTORED.",
    ),
    resolveClaudeAccessToken({ scope, keys: env }, route.value),
  ]);
  expect(concurrentToken.ok).toBe(true);
  expect(second.finalMessage).toBe("CLAUDE_OAUTH_RESTORED");
  expect(second.modelUsage.totalTokens).toBe(15);
  expect(provider.refreshes).toBe(1);
  expect(provider.messageCount).toBe(2);
  expect(JSON.stringify(provider.lastMessage)).toContain("CLAUDE_OAUTH_READY");
  expect(JSON.stringify(boundary.entries)).not.toContain("sk-ant-oat");
  expect(JSON.stringify(boundary.entries)).not.toContain("refresh-token");
  const retained = await resolveOrganisationModelRouteAtScope({
    env,
    scope,
    now: Date.now(),
  });
  expect(retained).toEqual(route);

  const reconnect = await start(session);
  provider.state =
    new URL(reconnect.authorizationUrl).searchParams.get("state") ?? "";
  expect(
    (
      await request(session, "POST", {
        kind: "complete",
        attemptId: reconnect.attemptId,
        code: `code#${provider.state}`,
      })
    ).status,
  ).toBe(200);
  expect(
    (await resolveClaudeAccessToken({ scope, keys: env }, route.value)).ok,
  ).toBe(false);
  const replacement = await resolveOrganisationModelRouteAtScope({
    env,
    scope,
    now: Date.now(),
  });
  if (!replacement.ok || replacement.value.keySource !== "organisation_oauth")
    throw new Error("Missing replacement route");
  expect(replacement.value.connectionId).not.toBe(route.value.connectionId);
  expect((await request(session, "DELETE", {})).status).toBe(200);
  expect(
    (await resolveClaudeAccessToken({ scope, keys: env }, replacement.value))
      .ok,
  ).toBe(false);
  expect(
    (
      await resolveOrganisationModelRouteAtScope({
        env,
        scope,
        now: Date.now(),
      })
    ).ok,
  ).toBe(false);
  expect(provider.messageCount).toBe(2);
  Object.assign(task.meta, {
    claudeOAuth: {
      deniedOperator: denied.status,
      deniedCsrf: noCsrf.status,
      codeReplayRejected: true,
      sourceSelected: selected.status,
      exchanges: provider.exchanges,
      refreshes: provider.refreshes,
      nativeTurns: provider.messageCount,
      usage: [first.modelUsage, second.modelUsage],
      checkpointBytes: second.checkpoint.byteLength,
      concurrentRefreshShared: concurrentToken.ok,
      resumedSignIn: resumed.status,
      reconnectFenced: true,
      disconnectFenced: true,
      credentialLeak: false,
    },
  });
}

class ClaudeProvider {
  state = "";
  exchanges = 0;
  refreshes = 0;
  messageCount = 0;
  lastMessage: unknown = null;

  async tokens({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Invalid token request");
    if (body.grant_type === "authorization_code") {
      expect(body.state).toBe(this.state);
      expect(body.code_verifier).toBe(this.state);
      expect(body.redirect_uri).toBe(
        "https://platform.claude.com/oauth/code/callback",
      );
      this.exchanges += 1;
    } else {
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("refresh-token-1-0");
      this.refreshes += 1;
      await scheduler.wait(300);
    }
    return HttpResponse.json({
      access_token: this.accessToken(),
      refresh_token: `refresh-token-${this.exchanges}-${this.refreshes}`,
      expires_in: 3600,
    });
  }

  async messages({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    expect(request.headers.get("authorization")).toBe(
      `Bearer ${this.accessToken()}`,
    );
    expect(request.headers.get("x-api-key")).toBeNull();
    this.lastMessage = await request.json();
    this.messageCount += 1;
    const text =
      this.messageCount === 1 ? "CLAUDE_OAUTH_READY" : "CLAUDE_OAUTH_RESTORED";
    const events = [
      {
        type: "message_start",
        message: {
          id: `msg_${this.messageCount}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ];
    return new HttpResponse(events.map(sse).join(""), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  accessToken(): string {
    return `sk-ant-oat01-test-${this.exchanges}-${this.refreshes}`;
  }
}

async function expireTokens(db: OrganisationDatabase): Promise<void> {
  const row = await db
    .prepare(
      "SELECT credential_handle AS handle FROM organisation_claude_connection WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first<{ handle: string }>();
  if (row === null) throw new Error("Missing tokens");
  const handle = parseVaultHandle(row.handle);
  if (!handle.ok) throw new Error(handle.error.code);
  const secret = await resolveVaultHandle({
    db,
    keys: env,
    organisationId: ORGANISATION_ID,
    handle: handle.value,
  });
  if (!secret.ok || secret.value.kind !== "oauth_tokens")
    throw new Error("Missing OAuth tokens");
  const stored = await storeVaultSecret({
    db,
    keys: env,
    organisationId: ORGANISATION_ID,
    handle: handle.value,
    secret: {
      kind: "oauth_tokens",
      accessToken: secret.value.accessToken,
      refreshToken: secret.value.refreshToken,
      expiry: { kind: "expires", expiresAt: 0 },
    },
    now: Date.now(),
  });
  if (!stored.ok) throw new Error(stored.error.code);
}

async function start(
  session: IssuedControlSession,
): Promise<{ attemptId: string; authorizationUrl: string }> {
  const response = await request(session, "POST", { kind: "start" });
  expect(response.status).toBe(200);
  return (
    await response.json<{
      authorization: { attemptId: string; authorizationUrl: string };
    }>()
  ).authorization;
}

function request(
  session: IssuedControlSession,
  method: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(
    new Request(connectionUrl(), {
      method,
      headers: headers(session),
      body: JSON.stringify(body),
    }),
  );
}

function connectionUrl(): string {
  return `https://localhost/v1/control/organisations/${ORGANISATION_ID}/inference/claude`;
}

function headers(session: IssuedControlSession): Headers {
  return new Headers({
    origin: "https://localhost",
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
    "x-satyr-csrf": session.csrfToken,
    "content-type": "application/json",
  });
}

function sse(event: { type: string }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function rejectFallback(): Response {
  throw new Error("Claude OAuth must never fall back to platform funding");
}
