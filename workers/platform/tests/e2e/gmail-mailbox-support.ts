import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";
import { decodeBase64, encodeBase64Url, isRecord } from "@purin-labs/std";
import { resolveActiveConnectorActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { ConnectorDO } from "../../src/actors/connector";
import {
  readEmailRuntime,
  type EmailProcessingState,
} from "@purin-labs/area-inbox/server/actors/connector-email";
import { runConnectorEmailEvaluation } from "@purin-labs/area-inbox/server/actors/connector-email-evaluation";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
} from "@purin-labs/authority/authorization/capability-catalogue";
import { storeVaultSecret } from "@purin-labs/authority/credential-vault/index";
import { parseVaultHandle } from "@purin-labs/authority/credential-vault/domain";
import { registerEmailMailboxAccount } from "@purin-labs/area-inbox/server/data/email-mailbox";
import { gmailConnectorId } from "@purin-labs/area-inbox-contract/server/connector-ids";
import { createActiveConnectedIntegration } from "@purin-labs/connections/data/integration-account";
import { persistProviderResourceSnapshot } from "@purin-labs/connections/data/provider-resource";
import { GMAIL_FULL_MAILBOX_SCOPES } from "@purin-labs/connections/mail/gmail-authorization";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  runMailboxSetup,
  type MailboxSetupTransport,
} from "@purin-labs/area-inbox/ui/features/mail-setup/run";
import { acceptMailboxModelTerms } from "../mailbox-model-consent-fixture";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceHeaders } from "./commerce-support";
import { runAlarmHandler } from "./durable-object-alarm-support";
import type { Member } from "./memory-support";
import { network } from "./network";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";
import { fixtureDatabase } from "./organisation-database";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The Connector Actor of a mailbox. */
export type MailboxConnector = DurableObjectStub<ConnectorDO>;

/**
 * A Gmail mailbox as the connection leaves it: the account, its credential,
 * the mailbox resource and the mailbox record. No agent, no grant, no policy.
 * `label` names the Google account and the tokens of the journey.
 */
export async function connectGmailMailbox(
  organisationId: OrganisationId,
  owner: Pick<Member, "userId">,
  mailbox: Readonly<{
    label: string;
    address: string;
    capabilities?: readonly string[];
    /** When the stored access token ends. A past time makes a read refresh it. */
    accessExpiresAt?: number;
  }>,
): Promise<IntegrationAccountId> {
  const now = Date.now();
  const { label, address } = mailbox;
  const handle = parseVaultHandle(
    `vault:${organisationId.toLowerCase()}:gmail:${label}:oauth:g1`,
  );
  if (!handle.ok) throw new Error("Vault handle invalid");
  const stored = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId,
    handle: handle.value,
    now,
    secret: {
      kind: "oauth_tokens",
      accessToken: `${label}-e2e-token`,
      refreshToken: `${label}-e2e-refresh`,
      expiry: {
        kind: "expires",
        expiresAt: mailbox.accessExpiresAt ?? now + 3_600_000,
      },
    },
  });
  if (!stored.ok) throw new Error(stored.error.code);
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId,
    provider: "gmail",
    authorizationProduct: "full_mailbox_pilot",
    providerSubjectId: label,
    environment: "development",
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef: handle.value },
    grantedScopes: GMAIL_FULL_MAILBOX_SCOPES,
    createdByUserId: owner.userId,
    providerAccountId: label,
    accountKind: "mailbox",
    displayName: address,
    capabilities: mailbox.capabilities ?? [CAPABILITY_KEYS.emailMailboxRead],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const account = parseIntegrationAccountId(
    connected.account.integrationAccountId,
  );
  if (!account.ok) throw new Error(account.error.code);
  await persistProviderResourceSnapshot({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: account.value,
    provider: "gmail",
    environment: "development",
    resources: [
      {
        canonicalResourceId: EMAIL_MAILBOX_RESOURCE_SCOPE,
        providerResourceId: label,
        providerAccountId: label,
        displayLabel: address,
        accessState: "accessible",
        providerRevision: "credential:1",
        resourceKind: "gmail_mailbox",
      },
      {
        canonicalResourceId: EMAIL_OPERATIONAL_RESOURCE_SCOPE,
        providerResourceId: label,
        providerAccountId: label,
        displayLabel: "Operational email proposals",
        accessState: "accessible",
        providerRevision: "credential:1",
        resourceKind: "gmail_operational",
      },
    ],
    now,
  });
  const registered = await registerEmailMailboxAccount({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: account.value,
    environment: "development",
    googleSubject: label,
    observedAddress: address,
    now,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  return account.value;
}

/**
 * The Portal's mailbox setup transport, with the session of one person. A
 * refused read or change throws, as the Portal's control client does.
 * `made` hears each change that succeeded.
 */
export function portalSetupTransport(
  person: Member,
  made: (path: string, body: unknown) => void = () => {},
): MailboxSetupTransport {
  return {
    read: async (path) => {
      const response = await exports.default.fetch(`https://localhost${path}`, {
        headers: commerceHeaders(person.session),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(body));
      return body;
    },
    mutate: async (path, _method, body) => {
      const sent = await sendAs(person, path, body);
      if (sent.status !== 200 && sent.status !== 201)
        throw new Error(JSON.stringify(sent));
      made(path, body);
      return sent.body;
    },
  };
}

/** One press of the setup action with the Portal's own runner. */
export async function setUpMailbox(
  person: Member,
  organisationId: OrganisationId,
  account: IntegrationAccountId,
): Promise<void> {
  const plan = await runMailboxSetup(
    portalSetupTransport(person),
    { organisationId, integrationAccountId: account },
    { kind: "automatic" },
  );
  expect(plan.next).toBeNull();
}

/** One POST of one person, with its own idempotency key unless one is given. */
export async function sendAs(
  person: Member,
  path: string,
  body: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<Readonly<{ status: number; body: unknown }>> {
  const headers = commerceHeaders(person.session);
  headers.set("idempotency-key", idempotencyKey);
  const response = await exports.default.fetch(`https://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** The active Connector Actor of one mailbox account. */
export async function mailboxConnector(
  organisationId: OrganisationId,
  account: IntegrationAccountId,
): Promise<MailboxConnector> {
  const connectorId = gmailConnectorId(account);
  if (!connectorId.ok) throw new Error("Invalid connector");
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  if (!connector.ok) throw new Error(connector.error.code);
  return connector.value;
}

/** The mail runtime that a mailbox's Connector stores. */
export async function mailRuntime(connector: MailboxConnector) {
  const stored = await runInDurableObject(connector, readRuntime);
  if (stored === null) throw new Error("The mailbox has no mail runtime");
  return stored;
}

/** Where the Connector's mail processing stands. */
export async function mailProcessing(
  connector: MailboxConnector,
): Promise<EmailProcessingState> {
  return (await mailRuntime(connector)).processing;
}

function readRuntime(_actor: unknown, state: DurableObjectState) {
  return readEmailRuntime(state.storage.sql);
}

/** The Connector's own evaluation, on a clock at the given time. */
export async function evaluateAt(
  organisationId: OrganisationId,
  now: number,
  _actor: unknown,
  state: DurableObjectState,
) {
  return runConnectorEmailEvaluation({
    scope: await requireOrganisationExecutionScope(env, organisationId),
    env,
    storage: state.storage,
    now,
    fetcher: fetch,
  });
}

/** The time of the evaluation that a check scheduled. */
export function scheduledAt(
  checked: Readonly<{ status: number; body: unknown }>,
): number {
  const body = checked.body;
  if (
    checked.status !== 200 ||
    !isRecord(body) ||
    body.kind !== "scheduled" ||
    typeof body.at !== "number"
  )
    throw new Error(`Not a scheduled check: ${JSON.stringify(checked)}`);
  return body.at;
}

/** The Case of each mail that the Connector gave a reply turn. */
export function readReplyTurns(_actor: unknown, state: DurableObjectState) {
  return state.storage.sql
    .exec<{ messageId: string; caseId: string }>(
      `SELECT provider_message_id AS messageId, case_id AS caseId
       FROM connector_email_reply_turn ORDER BY provider_message_id`,
    )
    .toArray();
}

/** How many self-tests of its mailboxes the Organisation holds. */
export async function selfTestCount(
  organisationId: OrganisationId,
): Promise<number> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS total FROM email_self_test WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** The text of a base64url raw message, as Gmail takes it. */
export function decodeRaw(encoded: string): string {
  return new TextDecoder().decode(
    decodeBase64(encoded.replaceAll("-", "+").replaceAll("_", "/")) ??
      new Uint8Array(),
  );
}

/** One header of a raw message, or null when it has none. */
export function header(encoded: string, name: string): string | null {
  const head = decodeRaw(encoded).split("\r\n\r\n")[0] ?? "";
  return (
    head
      .split("\r\n")
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2) ?? null
  );
}

/** The decoded body of a raw message whose body is base64. */
export function draftBody(encoded: string): string {
  return new TextDecoder().decode(
    decodeBase64(
      (decodeRaw(encoded).split("\r\n\r\n")[1] ?? "").replaceAll(/\s+/gu, ""),
    ) ?? new Uint8Array(),
  );
}

/**
 * The ID token of Google's token answer for one account. Pantry checks its
 * claims only, because the answer comes over its own TLS request.
 */
export function googleIdToken(subject: string, email: string): string {
  const now = Math.floor(Date.now() / 1_000);
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson({
      iss: "https://accounts.google.com",
      aud: env.GMAIL_OAUTH_CLIENT_ID,
      exp: now + 3_600,
      iat: now - 30,
      sub: subject,
      email,
    }),
    "signature",
  ].join(".");
}

function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/**
 * The owner accepts the data terms of the workspace's reviewed model for
 * new mail, as the checkbox beside Turn on does. The product's own consent
 * writes the record.
 */
export async function acceptMailboxModel(
  organisationId: OrganisationId,
  owner: Pick<Member, "userId">,
): Promise<void> {
  await acceptMailboxModelTerms({
    env,
    scope: await requireOrganisationExecutionScope(env, organisationId),
    userId: owner.userId,
  });
}

/**
 * Makes the Connector's held reply turns due now and runs one alarm of the
 * Connector to its end.
 */
export async function runDueMailWork(
  connector: MailboxConnector,
): Promise<void> {
  await runInDurableObject(connector, (_actor, state) => {
    state.storage.sql.exec(
      "UPDATE connector_email_reply_turn SET available_at = 0",
    );
  });
  await runAlarmHandler(connector);
}

/** The one kind of mail that arrives in a fake Gmail mailbox. */
export type FakeGmailMail = Readonly<{
  /** The mailbox's own address. */
  address: string;
  /** The address of the person who writes each arriving mail. */
  sender: string;
  subject: string;
  text: string;
}>;

/**
 * Gmail for one mailbox: its Inbox history, its messages and its drafts.
 * Each arriving mail comes from the same sender with the same text. A call
 * that the fake does not serve is recorded in `unexpected`.
 */
export class FakeGmailMailbox {
  historyId = 1000;
  arrivals: { id: string; threadId: string; historyId: number }[] = [];
  drafts = new Map<string, { raw: string; threadId: string }>();
  sent = 0;
  unexpected: string[] = [];

  constructor(private readonly mail: FakeGmailMail) {}

  arrive(id: string, threadId: string): void {
    this.historyId += 5;
    this.arrivals.push({ id, threadId, historyId: this.historyId });
  }

  serve(): void {
    network.use(
      http.get(`${GMAIL}/profile`, () =>
        HttpResponse.json({
          emailAddress: this.mail.address,
          historyId: String(this.historyId),
        }),
      ),
      http.post(`${GMAIL}/watch`, () =>
        HttpResponse.json({
          historyId: String(this.historyId),
          expiration: String(Date.now() + 2 * 86_400_000),
        }),
      ),
      http.post(`${GMAIL}/stop`, () => new HttpResponse(null, { status: 204 })),
      http.get(`${GMAIL}/history`, ({ request }) => {
        const start = Number(
          new URL(request.url).searchParams.get("startHistoryId"),
        );
        return HttpResponse.json({
          historyId: String(this.historyId),
          history: this.arrivals
            .filter((arrival) => arrival.historyId > start)
            .map((arrival) => ({
              id: String(arrival.historyId),
              messages: [{ id: arrival.id, threadId: arrival.threadId }],
              messagesAdded: [
                {
                  message: {
                    id: arrival.id,
                    threadId: arrival.threadId,
                    labelIds: ["INBOX", "UNREAD"],
                  },
                },
              ],
            })),
        });
      }),
      http.get(`${GMAIL}/messages`, () => HttpResponse.json({ messages: [] })),
      http.get(`${GMAIL}/messages/:messageId`, ({ params }) => {
        const arrival = this.arrivals.find(
          (candidate) => candidate.id === params.messageId,
        );
        if (arrival === undefined)
          return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
        return HttpResponse.json({
          id: arrival.id,
          threadId: arrival.threadId,
          labelIds: ["INBOX", "UNREAD"],
          sizeEstimate: 2_048,
          internalDate: String(Date.now() - 60_000),
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: this.mail.sender },
              { name: "To", value: this.mail.address },
              { name: "Subject", value: this.mail.subject },
              { name: "Message-ID", value: `<${arrival.id}@example.test>` },
            ],
            body: {
              data: encodeBase64Url(new TextEncoder().encode(this.mail.text)),
            },
          },
        });
      }),
      http.get(`${GMAIL}/drafts`, ({ request }) => {
        const query = new URL(request.url).searchParams.get("q");
        const drafts: { id: string }[] = [];
        for (const [id, draft] of this.drafts)
          if (query === `rfc822msgid:${header(draft.raw, "Message-ID")}`)
            drafts.push({ id });
        return HttpResponse.json({ drafts });
      }),
      http.get(`${GMAIL}/drafts/:draftId`, ({ params }) => {
        const id = String(params.draftId);
        const draft = this.drafts.get(id);
        if (draft === undefined)
          return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
        return HttpResponse.json({
          id,
          message: {
            id: `message_${id}`,
            threadId: draft.threadId,
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: this.mail.address },
                {
                  name: "To",
                  value: header(draft.raw, "To") ?? this.mail.sender,
                },
                {
                  name: "Subject",
                  value:
                    header(draft.raw, "Subject") ?? `Re: ${this.mail.subject}`,
                },
              ],
              body: {
                data: encodeBase64Url(
                  new TextEncoder().encode(draftBody(draft.raw)),
                ),
              },
            },
          },
        });
      }),
      http.post(`${GMAIL}/drafts`, async ({ request }) => {
        const raw: unknown = await request.json();
        if (
          !isRecord(raw) ||
          !isRecord(raw.message) ||
          typeof raw.message.raw !== "string"
        )
          throw new Error("Invalid Gmail draft");
        const id = `draft_${this.drafts.size + 1}`;
        const threadId =
          typeof raw.message.threadId === "string" ? raw.message.threadId : "";
        this.drafts.set(id, { raw: raw.message.raw, threadId });
        return HttpResponse.json({
          id,
          message: { id: `message_${id}`, threadId },
        });
      }),
      http.put(`${GMAIL}/drafts/:draftId`, async ({ request, params }) => {
        const id = String(params.draftId);
        const raw: unknown = await request.json();
        const draft = this.drafts.get(id);
        if (
          draft === undefined ||
          !isRecord(raw) ||
          !isRecord(raw.message) ||
          typeof raw.message.raw !== "string"
        )
          throw new Error("Invalid Gmail draft update");
        this.drafts.set(id, { ...draft, raw: raw.message.raw });
        return HttpResponse.json({
          id,
          message: { id: `message_${id}_${Date.now()}` },
        });
      }),
      http.delete(`${GMAIL}/drafts/:draftId`, ({ params }) => {
        this.drafts.delete(String(params.draftId));
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${GMAIL}/messages/send`, async ({ request }) => {
        const raw: unknown = await request.json();
        this.sent += 1;
        return HttpResponse.json({
          id: `sent_${this.sent}`,
          threadId:
            isRecord(raw) && typeof raw.threadId === "string"
              ? raw.threadId
              : "",
        });
      }),
      http.all(`${GMAIL}/*`, ({ request }) => {
        this.unexpected.push(`${request.method} ${request.url}`);
        return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
      }),
    );
  }
}

/**
 * One model answer in a mailbox agent's reply turn, by the count of tool
 * results so far: read the Case, draft `body` for approval, then stop.
 */
export function draftReplyTurn(results: number, body: string): Response {
  if (results === 0)
    return openRouterToolCall("read_email_case", {}, "reply_case");
  return results === 1
    ? openRouterToolCall(
        "email_reply_for_approval",
        { body, sources: null },
        "reply_draft",
      )
    : openRouterText("Prepared for review.", "reply_done");
}
