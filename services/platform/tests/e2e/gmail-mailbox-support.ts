import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
} from "../../src/authorization/capability-catalogue";
import { storeVaultSecret } from "../../src/credential-vault";
import { parseVaultHandle } from "../../src/credential-vault/domain";
import { registerEmailMailboxAccount } from "../../src/data/email-mailbox";
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
import { commerceHeaders } from "./commerce-support";
import type { Member } from "./memory-support";
import { fixtureDatabase } from "./organisation-database";

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
