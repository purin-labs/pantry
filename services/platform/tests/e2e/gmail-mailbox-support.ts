import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { decodeBase64, isRecord } from "@purin-labs/std";
import { resolveActiveConnectorActor } from "../../src/actors/actor-router";
import type { ConnectorDO } from "../../src/actors/connector";
import {
  readEmailRuntime,
  type EmailProcessingState,
} from "../../src/actors/connector-email";
import { runConnectorEmailEvaluation } from "../../src/actors/connector-email-evaluation";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
} from "../../src/authorization/capability-catalogue";
import { storeVaultSecret } from "../../src/credential-vault";
import { parseVaultHandle } from "../../src/credential-vault/domain";
import {
  gmailConnectorId,
  registerEmailMailboxAccount,
} from "../../src/data/email-mailbox";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import { persistProviderResourceSnapshot } from "../../src/data/provider-resource";
import { GMAIL_FULL_MAILBOX_SCOPES } from "../../src/mail/gmail-authorization";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../src/ids";
import {
  runMailboxSetup,
  type MailboxSetupTransport,
} from "../../../../apps/portal/src/features/mail-setup/run";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceHeaders } from "./commerce-support";
import type { Member } from "./memory-support";
import { fixtureDatabase } from "./organisation-database";

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
    authMode: "shared_satyr_app",
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

/** One press of the setup action with the Portal's own runner. */
export async function setUpMailbox(
  person: Member,
  organisationId: OrganisationId,
  account: IntegrationAccountId,
): Promise<void> {
  const transport: MailboxSetupTransport = {
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
      return sent.body;
    },
  };
  const plan = await runMailboxSetup(
    transport,
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
