import { env, exports } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import {
  parseVaultHandle,
  storeVaultSecret,
} from "@purin-labs/authority/credential-vault/index";
import { registerEmailMailboxAccount } from "../../src/data/email-mailbox";
import { registerEmailSenderAccount } from "../../src/data/email-operational";
import { createActiveConnectedIntegration } from "@purin-labs/connections/data/integration-account";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceClient, commerceWorkspace } from "./commerce-support";
import { network } from "./network";
import {
  archiveAsOwner,
  configurationVersion,
  purgeArchivedOrganisation,
  purgeOrganisation,
  readHeaders,
  type PurgeOwner,
} from "./purge-support";
import { googleIdToken } from "./gmail-mailbox-support";

declare module "vitest" {
  interface TaskMeta {
    gmailAfterDeletion?: Record<string, unknown>;
  }
}

const PUBLIC_ORIGIN = "https://localhost";
const MAILBOX_ADDRESS = "support@cafe.example";
const GOOGLE_SUBJECT = "google-subject-after-deletion";
const GRANTED_SCOPES =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/userinfo.email openid";

type Owner = PurgeOwner;

type Attempt = Readonly<{
  terminalState: string;
  failureReason: string | null;
}>;

it(
  "keeps a Google account with its Organisation until the purge, then lets a new Organisation connect it, also after a second purge of the same account",
  gmailAfterDeletionJourney,
  120_000,
);

async function gmailAfterDeletionJourney({ task }: TestContext) {
  network.use(
    http.post("https://oauth2.googleapis.com/token", () =>
      HttpResponse.json({
        access_token: "gmail-access-after-deletion",
        refresh_token: "gmail-refresh-after-deletion",
        expires_in: 3_600,
        scope: GRANTED_SCOPES,
        id_token: googleIdToken(GOOGLE_SUBJECT, MAILBOX_ADDRESS),
      }),
    ),
    http.post("https://oauth2.googleapis.com/revoke", () =>
      HttpResponse.json({}),
    ),
  );

  // The Organisation that its owner deleted first gave up the account.
  const first = await nativeOwner("first");
  await holdGoogleAccount(first);
  await purgeOrganisation(first);
  expect(await heldIdentities(first)).toEqual([]);

  // The next one can hold the same account. Its purge must not collide with
  // what the first purge left.
  const second = await nativeOwner("second");
  await holdGoogleAccount(second);

  const fresh = await nativeOwner("fresh");

  // An Organisation in use holds the account against every other one.
  const refusedWhileLive = await connectGmail(fresh, "refused-live");
  expect(refusedWhileLive.failureReason).toBe(
    "provider_account_already_claimed",
  );

  // An archived Organisation can still be restored, so it holds the account.
  await archiveAsOwner(second);
  const refusedWhileArchived = await connectGmail(fresh, "refused-archived");
  expect(refusedWhileArchived.failureReason).toBe(
    "provider_account_already_claimed",
  );

  // Deleted and purged, it holds nothing, and it keeps no address.
  await purgeArchivedOrganisation(second);
  expect(await heldIdentities(second)).toEqual([]);

  const connected = await connectGmail(fresh, "connected");
  expect(connected).toEqual({
    terminalState: "connected",
    failureReason: null,
  });
  expect(await mailboxes(fresh)).toEqual([MAILBOX_ADDRESS]);

  task.meta.gmailAfterDeletion = {
    whileOwnerIsInUse: refusedWhileLive.failureReason,
    whileOwnerIsArchived: refusedWhileArchived.failureReason,
    afterTwoPurgesOfTheAccount: `connected ${MAILBOX_ADDRESS}`,
  };
}

async function nativeOwner(label: string): Promise<Owner> {
  const client = await commerceClient(`gmail-after-deletion-${label}`);
  const organisationId = await commerceWorkspace(client, `${label} cafe`);
  return { client, organisationId };
}

/** The records that a finished Gmail connection leaves. */
async function holdGoogleAccount(owner: Owner): Promise<void> {
  const now = Date.now() - 10_000;
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  const handle = parseVaultHandle(
    `vault:${owner.organisationId}:gmail:after-deletion`,
  );
  if (!handle.ok) throw new Error("The Gmail token handle is invalid");
  const stored = await storeVaultSecret({
    db: scope.database,
    keys: env,
    organisationId: owner.organisationId,
    handle: handle.value,
    secret: {
      kind: "oauth_tokens",
      accessToken: "gmail-access-held",
      refreshToken: "gmail-refresh-held",
      expiry: { kind: "expires", expiresAt: now + 3_600_000 },
    },
    now,
  });
  if (!stored.ok) throw new Error(stored.error.code);
  const connected = await createActiveConnectedIntegration(scope.database, {
    organisationId: owner.organisationId,
    provider: "gmail",
    providerSubjectId: GOOGLE_SUBJECT,
    environment: "development",
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef: handle.value },
    grantedScopes: GRANTED_SCOPES.split(" "),
    createdByUserId: owner.client.identity.userId,
    providerAccountId: GOOGLE_SUBJECT,
    accountKind: "mailbox",
    displayName: MAILBOX_ADDRESS,
    capabilities: ["mailbox.ingress", "email.operational.propose"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const claim = {
    db: scope.database,
    organisationId: owner.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    environment: "development",
    googleSubject: GOOGLE_SUBJECT,
    observedAddress: MAILBOX_ADDRESS,
    now,
  } as const;
  const sender = await registerEmailSenderAccount(claim);
  if (!sender.ok) throw new Error(sender.error.code);
  const mailbox = await registerEmailMailboxAccount(claim);
  if (!mailbox.ok) throw new Error(mailbox.error.code);
}

async function connectGmail(owner: Owner, label: string): Promise<Attempt> {
  const started = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${owner.organisationId}/providers/gmail/start`,
    {
      method: "POST",
      headers: mutationHeaders(
        owner,
        `start-${label}`,
        await configurationVersion(owner.organisationId),
      ),
      body: JSON.stringify({ returnPath: `/portal/${owner.organisationId}` }),
    },
  );
  expect(started.status, await started.clone().text()).toBe(201);
  const body = await started.json();
  if (!isRecord(body) || typeof body.authorization_url !== "string")
    throw new Error("Gmail start returned no authorization address");
  const state = new URL(body.authorization_url).searchParams.get("state");
  if (state === null) throw new Error("Gmail authorization has no state");
  const callback = new URL(
    `${PUBLIC_ORIGIN}/v1/control/providers/gmail/callback`,
  );
  callback.searchParams.set("code", `gmail-code-${label}`);
  callback.searchParams.set("state", state);
  // The window reports this message to the Portal.
  const completed = await exports.default.fetch(callback.toString());
  const report =
    /"terminal_state":"(\w+)","failure_reason_code":(?:"(\w+)"|null)/u.exec(
      await completed.text(),
    );
  if (report === null) throw new Error("The window reports no result");
  return { terminalState: report[1] ?? "", failureReason: report[2] ?? null };
}

/** The rows of an Organisation that still name the Google account. */
async function heldIdentities(owner: Owner): Promise<readonly unknown[]> {
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  const rows = await scope.database
    .prepare(
      `SELECT observed_address FROM email_sender_account
       WHERE organisation_id = ?1 AND (google_subject = ?2 OR observed_address = ?3)
       UNION ALL
       SELECT observed_address FROM email_mailbox_account
       WHERE organisation_id = ?1 AND (google_subject = ?2 OR observed_address = ?3)`,
    )
    .bind(owner.organisationId, GOOGLE_SUBJECT, MAILBOX_ADDRESS)
    .all();
  return rows.results;
}

async function mailboxes(owner: Owner): Promise<readonly unknown[]> {
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  const rows = await scope.database
    .prepare(
      "SELECT observed_address AS address FROM email_mailbox_account WHERE organisation_id = ?",
    )
    .bind(owner.organisationId)
    .all<{ address: string }>();
  return rows.results.map(function address(row) {
    return row.address;
  });
}

function mutationHeaders(
  owner: Owner,
  idempotencyKey: string,
  version: number,
): HeadersInit {
  return {
    ...readHeaders(owner),
    origin: PUBLIC_ORIGIN,
    "content-type": "application/json",
    "idempotency-key": `gmail-after-deletion-${owner.organisationId}-${idempotencyKey}`,
    "x-pantry-configuration-version": String(version),
    "x-pantry-csrf": owner.client.session.csrfToken,
  };
}
