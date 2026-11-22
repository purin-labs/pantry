import { fixtureDatabase } from "./organisation-database";
import { zstdDecompressSync } from "node:zlib";
import { env, exports } from "cloudflare:workers";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect } from "vitest";
import { encodeBase64Url, isRecord } from "@purin-labs/std";

import {
  completeOrganisationChatGptSignIn,
  readOrganisationCodexConnection,
  startOrganisationCodexAuthorization,
} from "../../src/models/codex-connection";
import {
  parseModelApiKey,
  storeOrganisationModelCredential,
  type ModelKeyProvider,
} from "../../src/credential-vault";
import {
  readOrganisationInferenceSelection,
  selectOrganisationInferenceSelection,
  type OrganisationInferenceSelection,
} from "../../src/data/organisation-inference-selection";
import { type OrganisationId } from "@purin-labs/kernel/ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import {
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
  signedSlackRequest,
  slackEnvelope,
} from "./slack-journey-support";
import {
  CHATGPT_EXIT_EGRESS_HEADER,
  MODEL_EXIT_EGRESS_HEADER,
} from "./model-exit-network";
import { network } from "./network";

/**
 * A fake ChatGPT: the OpenAI authorization server that signs a person in
 * with a device code, and the ChatGPT backend that answers the Codex
 * Responses requests of pi-ai's `openai-codex` provider. It only records
 * each request and answers it. Like the real servers, it refuses a token
 * that it did not issue or that has expired. Like OpenAI for a request from
 * Hong Kong, it refuses each request that did not leave through the model
 * exit Worker (Plan 73).
 */

const CHATGPT_ACCOUNT_ID = "acct_e2e_chatgpt";
const DEVICE_AUTH_ID = "deviceauth_e2e";
const USER_CODE = "E2E-CODE";
/** How long each access token of the Codex sign-in lives. */
const CODEX_ACCESS_TOKEN_LIFETIME_SECONDS = 3_600;
/** The share of the weekly allowance that the backend reports as used. */
const CODEX_USED_PERCENT = 25;

export type ChatGptModelRequest = {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
};

/** What the backend answers to one model request. */
export type ChatGptAnswer =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool_call";
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly callId: string;
    };

type ChatGptTokenRequest = Readonly<Record<string, string>>;

export class FakeChatGpt {
  readonly modelRequests: ChatGptModelRequest[] = [];
  /** Answers the model request at `index` of all model requests. */
  answer: (
    request: ChatGptModelRequest,
    index: number,
  ) => ChatGptAnswer | Promise<ChatGptAnswer> = textAnswer.bind(null, "Done.");
  approved = false;
  readonly #accessTokens = new Map<string, number>();
  #issued = 0;

  install(): void {
    network.use(
      http.post(
        "https://auth.openai.com/api/accounts/deviceauth/usercode",
        this.fromExit(this.startDevice),
      ),
      http.post(
        "https://auth.openai.com/api/accounts/deviceauth/token",
        this.fromExit(this.pollDevice),
      ),
      http.post(
        "https://auth.openai.com/oauth/token",
        this.fromExit(this.exchange),
      ),
      http.post(
        "https://chatgpt.com/backend-api/codex/responses",
        this.fromContainer(this.respond),
      ),
    );
  }

  /**
   * OpenAI answers a request from a region that it does not serve with this
   * refusal. Here it is the answer to each request that reached the network
   * without the model exit Worker.
   */
  private fromExit(
    resolver: (
      info: Parameters<HttpResponseResolver>[0],
    ) => Response | Promise<Response>,
  ): HttpResponseResolver {
    return (info) => {
      if (info.request.headers.has(MODEL_EXIT_EGRESS_HEADER))
        return resolver.call(this, info);
      return HttpResponse.json(
        {
          error: {
            code: "unsupported_country_region_territory",
            message: "Country, region, or territory not supported",
            param: null,
            type: "request_forbidden",
          },
        },
        { status: 403 },
      );
    };
  }

  /**
   * chatgpt.com answers a request that leaves Cloudflare from a Worker with
   * an HTML block page (seen in production on 2026-10-19). It accepts the
   * request from a container: here, the ChatGPT exit (Plan 75).
   */
  private fromContainer(
    resolver: (
      info: Parameters<HttpResponseResolver>[0],
    ) => Response | Promise<Response>,
  ): HttpResponseResolver {
    const outsideTheContainer = this.fromExit(resolver);
    return (info) => {
      if (info.request.headers.has(CHATGPT_EXIT_EGRESS_HEADER))
        return resolver.call(this, info);
      if (!info.request.headers.has(MODEL_EXIT_EGRESS_HEADER))
        return outsideTheContainer(info);
      return new HttpResponse(
        "<html><head><title>Attention Required!</title></head><body>Sorry, you have been blocked</body></html>",
        {
          status: 403,
          headers: { "content-type": "text/html; charset=UTF-8" },
        },
      );
    };
  }

  /** The person enters the code at OpenAI and approves the sign-in. */
  approve(): void {
    this.approved = true;
  }

  modelRequestCount(): number {
    return this.modelRequests.length;
  }

  /** Whether the access token is one this server issued and still valid. */
  accepts(authorization: string | undefined): boolean {
    const token = authorization?.replace(/^Bearer /u, "");
    const expiresAt =
      token === undefined ? undefined : this.#accessTokens.get(token);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  private async startDevice({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await request.json();
    if (!isRecord(body) || body.client_id !== "app_EMoamEEZ73f0CkXaXp7hrann")
      return HttpResponse.json({ error: "invalid_client" }, { status: 400 });
    return HttpResponse.json({
      device_auth_id: DEVICE_AUTH_ID,
      user_code: USER_CODE,
      interval: "5",
    });
  }

  private async pollDevice({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      body.device_auth_id !== DEVICE_AUTH_ID ||
      body.user_code !== USER_CODE
    )
      return HttpResponse.json({ error: "invalid_request" }, { status: 400 });
    if (!this.approved)
      return HttpResponse.json(
        { error: { code: "deviceauth_authorization_pending" } },
        { status: 403 },
      );
    return HttpResponse.json({
      authorization_code: "authcode_e2e",
      code_verifier: "verifier_e2e",
      code_challenge: "challenge_e2e",
    });
  }

  private async exchange({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const form = Object.fromEntries(
      new URLSearchParams(
        new TextDecoder().decode(await request.arrayBuffer()),
      ).entries(),
    );
    if (form.client_id !== "app_EMoamEEZ73f0CkXaXp7hrann")
      return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
    if (form.grant_type !== "authorization_code")
      return HttpResponse.json({ error: "unsupported" }, { status: 400 });
    return form.code === "authcode_e2e" &&
      form.code_verifier === "verifier_e2e" &&
      form.redirect_uri === "https://auth.openai.com/deviceauth/callback"
      ? HttpResponse.json(this.issueTokens())
      : HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
  }

  private async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const headers = Object.fromEntries(request.headers.entries());
    if (!this.accepts(headers.authorization))
      return HttpResponse.json(
        { error: { code: "token_expired", message: "token expired" } },
        { status: 401 },
      );
    // pi-ai sends the Codex request body as zstd, as the Codex client does.
    const raw = new Uint8Array(await request.arrayBuffer());
    const text = new TextDecoder().decode(
      headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw,
    );
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) throw new Error("Codex request body is invalid");
    const recorded = { headers, body };
    const index = this.modelRequests.push(recorded) - 1;
    const answer = await this.answer(recorded, index);
    const id = `resp_e2e_${String(index + 1)}`;
    return new HttpResponse(
      answerEvents(id, String(body.model), answer).map(sseEvent).join(""),
      {
        headers: {
          "content-type": "text/event-stream",
          ...this.allowanceHeaders(),
        },
      },
    );
  }

  private allowanceHeaders(): Record<string, string> {
    return {
      "x-codex-plan-type": "pro",
      "x-codex-active-limit": "premium",
      "x-codex-primary-used-percent": String(CODEX_USED_PERCENT),
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": String(
        Math.floor(Date.now() / 1_000) + 3_600,
      ),
      "x-codex-primary-reset-after-seconds": "3600",
      "x-codex-secondary-used-percent": "0",
      "x-codex-secondary-window-minutes": "0",
      "x-codex-secondary-reset-at": "",
      "x-codex-credits-has-credits": "True",
      "x-codex-credits-unlimited": "False",
      "x-codex-turn-state": "opaque-e2e",
    };
  }

  private issueTokens(): Record<string, unknown> {
    this.#issued += 1;
    const expiresAt = Date.now() + CODEX_ACCESS_TOKEN_LIFETIME_SECONDS * 1_000;
    const accessToken = jwt({
      exp: Math.floor(expiresAt / 1_000),
      issued: this.#issued,
      "https://api.openai.com/auth": {
        chatgpt_account_id: CHATGPT_ACCOUNT_ID,
        chatgpt_plan_type: "pro",
      },
    });
    const refreshToken = `rt_e2e_${String(this.#issued)}`;
    this.#accessTokens.set(accessToken, expiresAt);
    return {
      id_token: jwt({
        issued: this.#issued,
        "https://api.openai.com/auth": {
          chatgpt_account_id: CHATGPT_ACCOUNT_ID,
          chatgpt_plan_type: "pro",
        },
      }),
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: CODEX_ACCESS_TOKEN_LIFETIME_SECONDS,
    };
  }
}

export function textAnswer(text: string): ChatGptAnswer {
  return { kind: "text", text };
}

/** The text of each tool output that a model request carries, in order. */
export function toolOutputs(request: ChatGptModelRequest): string[] {
  const input = Array.isArray(request.body.input) ? request.body.input : [];
  return input.flatMap((item: unknown) =>
    isRecord(item) && item.type === "function_call_output"
      ? [
          typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output),
        ]
      : [],
  );
}

/** The text of the last tool output that a model request carries. */
export function lastToolOutput(request: ChatGptModelRequest): string | null {
  return toolOutputs(request).at(-1) ?? null;
}

export function offeredTools(request: ChatGptModelRequest): string[] {
  const tools = Array.isArray(request.body.tools) ? request.body.tools : [];
  return tools
    .map((tool: unknown) =>
      isRecord(tool) && typeof tool.name === "string" ? tool.name : "",
    )
    .sort();
}

export function fixtureUser(): UserId {
  const user = parseUserId(SLACK_ACTOR_USER_ID);
  if (!user.ok) throw new Error("Invalid fixture user");
  return user.value;
}

/**
 * Sign the organisation in to ChatGPT with the device code, as an owner does
 * in Portal, and make the subscription its inference route.
 */
export async function connectChatGptSubscription(
  chatgpt: FakeChatGpt,
  options: Readonly<{ reconnect: boolean }> = { reconnect: false },
): Promise<void> {
  await signInToChatGpt(chatgpt, {
    organisationId: ORGANISATION_ID,
    userId: fixtureUser(),
    reconnect: options.reconnect,
  });
  await selectInference({ kind: "codex_subscription" });
}

/** The device-code sign-in alone; the inference selection stays as it is. */
export async function signInToChatGpt(
  chatgpt: FakeChatGpt,
  input: Readonly<{
    organisationId: OrganisationId;
    userId: UserId;
    reconnect: boolean;
  }>,
): Promise<void> {
  const started = await startOrganisationCodexAuthorization({
    env,
    organisationId: input.organisationId,
    userId: input.userId,
    now: Date.now(),
    reconnect: input.reconnect,
    signIn: "codex_device",
  });
  if (!started.ok) throw new Error(started.error.code);
  chatgpt.approve();
  expect(
    await readOrganisationCodexConnection({
      env,
      organisationId: input.organisationId,
      now: Date.now(),
      reconcile: true,
    }),
  ).toMatchObject({ ok: true, value: { kind: "connected" } });
  chatgpt.approved = false;
}

export async function selectInference(
  selection: OrganisationInferenceSelection,
): Promise<void> {
  const current = await readOrganisationInferenceSelection({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
  });
  if (current === null) throw new Error("Missing inference selection");
  if (current.selection.kind === selection.kind) return;
  const selected = await selectOrganisationInferenceSelection({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    selection,
    expectedConfigurationVersion: current.configurationVersion,
    selectedByUserId: fixtureUser(),
    now: Date.now(),
  });
  if (!selected.ok) throw new Error(selected.error.code);
}

function isRefresh(request: ChatGptTokenRequest): boolean {
  return request.grant_type === "refresh_token";
}

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  return [encode({ alg: "none", typ: "JWT" }), encode(claims), "e2e"].join(".");
}

function answerEvents(
  id: string,
  model: string,
  answer: ChatGptAnswer,
): Record<string, unknown>[] {
  const item =
    answer.kind === "tool_call"
      ? {
          type: "function_call",
          id: `fc_${id}`,
          call_id: answer.callId,
          name: answer.name,
          arguments: JSON.stringify(answer.arguments),
          status: "completed",
        }
      : {
          type: "message",
          id: `msg_${id}`,
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: answer.text, annotations: [] },
          ],
        };
  const added =
    item.type === "function_call"
      ? { ...item, arguments: "", status: "in_progress" }
      : { ...item, status: "in_progress", content: [] };
  const deltas =
    answer.kind === "tool_call"
      ? [
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: item.id,
            delta: JSON.stringify(answer.arguments),
          },
          {
            type: "response.function_call_arguments.done",
            output_index: 0,
            item_id: item.id,
            arguments: JSON.stringify(answer.arguments),
          },
        ]
      : [
          {
            type: "response.content_part.added",
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            delta: answer.text,
          },
        ];
  return [
    {
      type: "response.created",
      response: { id, model, status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item: added },
    ...deltas,
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        model,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
}

function sseEvent(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * A fake OpenAI for "Sign in with ChatGPT" (Plan 74B): the authorization
 * server that registers an agent client, issues codes and tokens and
 * rotates refresh tokens, and the Responses API on api.openai.com that
 * takes the user access token. It only records each request and answers
 * it. Like the real servers, it checks the PKCE verifier against the
 * challenge of the code, refuses a token that it did not issue, accepts
 * each code and refresh token one time, and refuses the request fields that
 * this route does not support. Like OpenAI for a request from Hong Kong, it
 * refuses each request that did not leave through the model exit Worker.
 */
export class FakeOpenAiSignIn {
  /** Each authorize address that the person's browser opened. */
  readonly authorizeRequests: URL[] = [];
  readonly tokenRequests: ChatGptTokenRequest[] = [];
  readonly modelRequests: ChatGptModelRequest[] = [];
  readonly directRequests: string[] = [];
  answer: (
    request: ChatGptModelRequest,
    index: number,
  ) => ChatGptAnswer | Promise<ChatGptAnswer> = textAnswer.bind(null, "Done.");
  accessTokenLifetimeSeconds = 3_600;
  refuseRefresh = false;
  refreshGate: Promise<void> = Promise.resolve();
  /** Whether the person allows the agent to use the ChatGPT plan. */
  allowPlanUsage = true;
  /** The next this many model requests are refused at the usage limit. */
  usageLimitRefusals = 0;
  refusedRequests = 0;
  readonly #clients = new Map<string, string>();
  readonly #codes = new Map<string, IssuedCode>();
  readonly #accessTokens = new Map<string, number>();
  readonly #refreshTokens = new Map<string, string>();
  #issued = 0;

  install(): void {
    network.use(
      http.post(
        "https://auth.openai.com/api/accounts/oauth/token",
        fromModelExit(this.directRequests, this.exchange.bind(this)),
      ),
      http.post(
        "https://api.openai.com/v1/responses",
        fromModelExit(this.directRequests, this.respond.bind(this)),
      ),
    );
  }

  /**
   * The person opens the address, signs in and allows Pantry. For a first
   * sign-in OpenAI registers a client for the agent. OpenAI then sends the
   * browser to the callback address, which this returns: what the address
   * bar shows on the page that does not load.
   */
  approve(authorizationUrl: string): string {
    const url = new URL(authorizationUrl);
    this.authorizeRequests.push(url);
    const query = url.searchParams;
    const hostId = query.get("ext_agent_host_id") ?? "";
    const redirectUri = query.get("redirect_uri") ?? "";
    const challenge = query.get("code_challenge") ?? "";
    if (
      `${url.origin}${url.pathname}` !==
        "https://auth.openai.com/api/accounts/authorize" ||
      query.get("response_type") !== "code" ||
      query.get("resource") !== "https://api.openai.com/v1" ||
      !(query.get("scope") ?? "").split(" ").includes(DIRECT_SCOPE) ||
      query.get("code_challenge_method") !== "S256" ||
      challenge.length === 0 ||
      !/^urn:uuid:[0-9a-f-]{36}$/u.test(hostId) ||
      !redirectUri.startsWith("http://127.0.0.1:")
    )
      throw new Error(`OpenAI refuses this authorize request: ${url.search}`);
    let clientId = query.get("client_id") ?? "";
    const registered = clientId === "dynamic_agent_client";
    if (registered) {
      clientId = `oaiapp_e2e_${String(this.#clients.size + 1)}`;
      this.#clients.set(clientId, hostId);
    } else if (!this.#clients.has(clientId))
      throw new Error(`OpenAI knows no client ${clientId}`);
    this.#issued += 1;
    const code = `code_e2e_${String(this.#issued)}`;
    this.#codes.set(code, {
      clientId,
      challenge,
      redirectUri,
      nonce: query.get("nonce") ?? "",
    });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", query.get("state") ?? "");
    callback.searchParams.set("scope", this.grantedScope());
    // A later sign-in of the same client may leave the client out.
    if (registered) callback.searchParams.set("client_id", clientId);
    return callback.toString();
  }

  refreshCount(): number {
    return this.tokenRequests.filter(isRefresh).length;
  }

  modelRequestCount(): number {
    return this.modelRequests.length;
  }

  accepts(authorization: string | undefined): boolean {
    const token = authorization?.replace(/^Bearer /u, "");
    const expiresAt =
      token === undefined ? undefined : this.#accessTokens.get(token);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  private grantedScope(): string {
    return this.allowPlanUsage
      ? `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`
      : "openid profile email offline_access";
  }

  private async exchange({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const form = Object.fromEntries(
      new URLSearchParams(await request.text()).entries(),
    );
    this.tokenRequests.push(form);
    const clientId = form.client_id ?? "";
    if (!this.#clients.has(clientId))
      return HttpResponse.json({ error: "invalid_client" }, { status: 400 });
    if (form.resource !== "https://api.openai.com/v1")
      return HttpResponse.json({ error: "invalid_target" }, { status: 400 });
    if (form.grant_type === "authorization_code") {
      const issued = this.#codes.get(form.code ?? "");
      this.#codes.delete(form.code ?? "");
      const verified =
        issued !== undefined &&
        issued.clientId === clientId &&
        issued.redirectUri === form.redirect_uri &&
        (await pkceChallenge(form.code_verifier ?? "")) === issued.challenge;
      return verified
        ? HttpResponse.json(this.issueTokens(clientId, issued.nonce))
        : HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (form.grant_type !== "refresh_token")
      return HttpResponse.json(
        { error: "unsupported_grant_type" },
        { status: 400 },
      );
    await this.refreshGate;
    const owner = this.#refreshTokens.get(form.refresh_token ?? "");
    // OpenAI rotates refresh tokens: each one works once.
    this.#refreshTokens.delete(form.refresh_token ?? "");
    if (this.refuseRefresh || owner !== clientId)
      return HttpResponse.json(
        { error: "invalid_grant", error_description: "refresh_token_reused" },
        { status: 400 },
      );
    return HttpResponse.json(this.issueTokens(clientId, null));
  }

  private async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const headers = Object.fromEntries(request.headers.entries());
    if (!this.accepts(headers.authorization))
      return HttpResponse.json(
        {
          error: {
            message: "The access token is not valid.",
            type: "invalid_request_error",
            code: "subscription_sharing_invalid_user",
          },
        },
        { status: 401 },
      );
    if (this.usageLimitRefusals > 0) {
      this.usageLimitRefusals -= 1;
      this.refusedRequests += 1;
      return HttpResponse.json(
        {
          error: {
            message: "You have reached the ChatGPT usage limit for this app.",
            type: "usage_limit_reached",
            param: null,
            code: "subscription_sharing_usage_limit_exceeded",
          },
        },
        { status: 429 },
      );
    }
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Responses request body is invalid");
    const refused = UNSUPPORTED_FIELDS.filter((field) => field in body);
    if (body.store !== false || body.stream !== true || refused.length > 0)
      return HttpResponse.json(
        {
          error: {
            message: `Unsupported: ${refused.join(", ") || "store or stream"}`,
            type: "invalid_request_error",
            param: refused[0] ?? null,
            code: "subscription_sharing_unsupported_capability",
          },
        },
        { status: 400 },
      );
    const recorded = { headers, body };
    const index = this.modelRequests.push(recorded) - 1;
    const answer = await this.answer(recorded, index);
    return new HttpResponse(
      answerEvents(`resp_e2e_${String(index + 1)}`, String(body.model), answer)
        .map(sseEvent)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }

  private issueTokens(
    clientId: string,
    nonce: string | null,
  ): Record<string, unknown> {
    this.#issued += 1;
    const expiresAt = Date.now() + this.accessTokenLifetimeSeconds * 1_000;
    const accessToken = jwt({
      exp: Math.floor(expiresAt / 1_000),
      client_id: clientId,
      issued: this.#issued,
    });
    const refreshToken = `rt_e2e_${String(this.#issued)}`;
    this.#accessTokens.set(accessToken, expiresAt);
    this.#refreshTokens.set(refreshToken, clientId);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: jwt({
        aud: clientId,
        ...(nonce === null ? {} : { nonce }),
        email: "owner@example.test",
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
      }),
      token_type: "Bearer",
      expires_in: this.accessTokenLifetimeSeconds,
      scope: this.grantedScope(),
    };
  }
}

type IssuedCode = Readonly<{
  clientId: string;
  challenge: string;
  redirectUri: string;
  nonce: string;
}>;

const DIRECT_SCOPE = "chatgpt.tokens.use.direct";

/** Request fields that "Sign in with ChatGPT" refuses on /v1/responses. */
const UNSUPPORTED_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "previous_response_id",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_p",
  "truncation",
  "user",
] as const;

/**
 * A resolver that answers only requests that left through the model exit
 * Worker, as OpenAI refuses a request from a region that it does not serve.
 */
function fromModelExit(
  direct: string[],
  resolver: (
    info: Parameters<HttpResponseResolver>[0],
  ) => Response | Promise<Response>,
): HttpResponseResolver {
  return (info) => {
    if (info.request.headers.has(MODEL_EXIT_EGRESS_HEADER))
      return resolver(info);
    direct.push(new URL(info.request.url).pathname);
    return HttpResponse.json(
      {
        error: {
          code: "unsupported_country_region_territory",
          message: "Country, region, or territory not supported",
          param: null,
          type: "request_forbidden",
        },
      },
      { status: 403 },
    );
  };
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

/**
 * "Sign in with ChatGPT" as an owner does it in Portal: start, approve at
 * OpenAI, paste the callback address. Returns the address that was pasted.
 */
async function signInWithChatGpt(
  openai: FakeOpenAiSignIn,
  input: Readonly<{
    organisationId: OrganisationId;
    userId: UserId;
    reconnect: boolean;
  }>,
): Promise<string> {
  const started = await startOrganisationCodexAuthorization({
    env,
    organisationId: input.organisationId,
    userId: input.userId,
    now: Date.now(),
    reconnect: input.reconnect,
    signIn: "chatgpt_agent",
  });
  if (!started.ok || started.value.kind !== "authorizing")
    throw new Error("Sign in with ChatGPT did not start");
  const address = openai.approve(started.value.attempt.verificationUrl);
  expect(
    await completeOrganisationChatGptSignIn({
      env,
      organisationId: input.organisationId,
      attemptId: started.value.attempt.attemptId,
      callbackUrl: address,
      now: Date.now(),
    }),
  ).toMatchObject({
    ok: true,
    value: { kind: "connected", signIn: "chatgpt_agent" },
  });
  return address;
}

/** Sign in with ChatGPT and make the subscription the inference route. */
export async function connectChatGptSignIn(
  openai: FakeOpenAiSignIn,
  options: Readonly<{ reconnect: boolean }> = { reconnect: false },
): Promise<void> {
  await signInWithChatGpt(openai, {
    organisationId: ORGANISATION_ID,
    userId: fixtureUser(),
    reconnect: options.reconnect,
  });
  await selectInference({ kind: "codex_subscription" });
}

/**
 * A fake OpenAI Responses API for the organisation's own API key. It only
 * records each request and answers it. Like OpenAI, it refuses a key that
 * it did not issue, and it refuses each request that did not leave through
 * the model exit Worker.
 */
export class FakeOpenAiApi {
  readonly modelRequests: ChatGptModelRequest[] = [];
  readonly directRequests: string[] = [];
  answer: (
    request: ChatGptModelRequest,
    index: number,
  ) => ChatGptAnswer | Promise<ChatGptAnswer> = textAnswer.bind(null, "Done.");
  /** The next this many model requests are refused at the rate limit. */
  rateLimitRefusals = 0;
  refusedRequests = 0;

  constructor(readonly apiKey: string) {}

  install(): void {
    network.use(
      http.post(
        "https://api.openai.com/v1/responses",
        fromModelExit(this.directRequests, this.respond.bind(this)),
      ),
    );
  }

  modelRequestCount(): number {
    return this.modelRequests.length;
  }

  private async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const headers = Object.fromEntries(request.headers.entries());
    if (headers.authorization !== `Bearer ${this.apiKey}`)
      return HttpResponse.json(
        {
          error: {
            message: "Incorrect API key provided.",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        },
        { status: 401 },
      );
    if (this.rateLimitRefusals > 0) {
      this.rateLimitRefusals -= 1;
      this.refusedRequests += 1;
      return HttpResponse.json(
        {
          error: {
            message: "Rate limit reached for requests per min (RPM).",
            type: "requests",
            param: null,
            code: "rate_limit_exceeded",
          },
        },
        { status: 429, headers: { "retry-after": "1" } },
      );
    }
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Responses request body is invalid");
    const recorded = { headers, body };
    const index = this.modelRequests.push(recorded) - 1;
    const answer = await this.answer(recorded, index);
    return new HttpResponse(
      answerEvents(`resp_key_${String(index + 1)}`, String(body.model), answer)
        .map(sseEvent)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
}

/** The key selection of each provider whose key an Organisation stores. */
const API_KEY_SELECTION = {
  openai: "organisation_openai_api_key",
  anthropic: "organisation_anthropic_api_key",
  google: "organisation_google_api_key",
} as const satisfies Record<ModelKeyProvider, string>;

/**
 * Store the organisation's own API key of `provider`, as an owner does in
 * Portal, and make it the inference route.
 */
export async function connectModelApiKey(
  provider: ModelKeyProvider,
  apiKey: string,
): Promise<void> {
  const key = parseModelApiKey(provider, apiKey);
  if (!key.ok) throw new Error(key.error.code);
  const stored = await storeOrganisationModelCredential({
    provider,
    db: fixtureDatabase(),
    keys: env,
    organisationId: ORGANISATION_ID,
    apiKey: key.value,
    now: Date.now(),
  });
  if (!stored.ok) throw new Error(stored.error.code);
  await selectInference({ kind: API_KEY_SELECTION[provider] });
}

/** The organisation's own OpenAI API key as its inference route. */
export function connectOpenAiApiKey(apiKey: string): Promise<void> {
  return connectModelApiKey("openai", apiKey);
}

/** The organisation's own Anthropic API key as its inference route. */
export function connectAnthropicApiKey(apiKey: string): Promise<void> {
  return connectModelApiKey("anthropic", apiKey);
}

/**
 * Slack sends a mention that asks which integrations are connected, and
 * starts the thread. Returns the durable mode of the ingress.
 */
export function sendMention(
  eventId: string,
  threadTs: string,
): Promise<unknown> {
  return sendIntegrationQuestion(eventId, threadTs, threadTs, "app_mention");
}

/** Slack sends a reply that asks again in the thread. */
export function sendReply(
  eventId: string,
  messageTs: string,
  threadTs: string,
): Promise<unknown> {
  return sendIntegrationQuestion(eventId, messageTs, threadTs, "message");
}

async function sendIntegrationQuestion(
  eventId: string,
  messageTs: string,
  threadTs: string,
  eventType: "app_mention" | "message",
): Promise<unknown> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType,
        eventId,
        messageTs,
        threadTs,
        text:
          eventType === "app_mention"
            ? "<@U0PANTRY> Which integrations are connected?"
            : "Try again, please.",
      }),
    ),
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return isRecord(body) ? body.durableMode : null;
}
