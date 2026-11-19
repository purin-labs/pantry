import { exports } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { GMAIL_FULL_MAILBOX_SCOPES } from "../../src/mail/gmail-authorization";
import type { IntegrationAccountId, OrganisationId } from "../../src/ids";
import { commerceHeaders } from "./commerce-support";
import {
  connectGmailMailbox,
  googleIdToken,
  sendAs,
  setUpMailbox,
} from "./gmail-mailbox-support";
import { installMemoryFixture, type Member } from "./memory-support";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";

declare module "vitest" {
  interface TaskMeta {
    mailInboxReconnect?: Record<string, unknown>;
  }
}

const ADDRESS = "orders@example.test";
const LABEL = "reconnect";
const ORIGIN = "https://localhost";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

it(
  "asks the people who read a mailbox to reconnect it when Google refuses its sign-in, asks Google one time, and reads the mail again after the reconnect",
  { timeout: 120_000 },
  reconnectJourney,
);

/** What the fake Google saw. */
type Google = {
  refreshes: number;
  codeExchanges: number;
  /** The access token of each Gmail list request. */
  listTokens: string[];
};

async function reconnectJourney({ task }: TestContext): Promise<void> {
  const {
    organisationId,
    author: owner,
    reviewer: admin,
    viewer,
  } = await installMemoryFixture();
  const google = serveGoogle();

  // 1. The owner connected the mailbox and set it up. Its access token has
  //    ended, so the next read asks Google for a new one.
  const account = await connectGmailMailbox(organisationId, owner, {
    label: LABEL,
    address: ADDRESS,
    accessExpiresAt: Date.now() - 60_000,
  });
  await setUpMailbox(owner, organisationId, account);
  expect(await mailboxes(owner)).toEqual([
    { integrationAccountId: account, displayName: ADDRESS, access: "readable" },
  ]);

  // 2. Google refuses the sign-in (`invalid_grant`). The Inbox answers that
  //    the mailbox needs a reconnect, not that the network failed.
  const refused = await readPage(owner, account);
  expect(refused).toEqual({
    status: 409,
    body: { ok: false, error: "mail_authorization_expired" },
  });
  expect(google.refreshes).toBe(1);

  // 3. Each person who reads the mailbox sees that it needs a reconnect. A
  //    member who cannot read it sees no mailbox. The Integrations page
  //    names the cause beside the account.
  const reconnectRequired = {
    integrationAccountId: account,
    displayName: ADDRESS,
    access: "reconnect_required",
  };
  expect(await mailboxes(owner)).toEqual([reconnectRequired]);
  expect(await mailboxes(admin)).toEqual([reconnectRequired]);
  expect(await mailboxes(viewer)).toEqual([]);
  expect(await integrationLifecycle(owner, account)).toEqual({
    kind: "reauth_required",
    reasonCode: "provider_grant_refused",
  });

  // 4. Later reads give the same answer and do not ask Google again.
  expect(await readPage(owner, account)).toEqual(refused);
  expect(await readPage(admin, account)).toEqual(refused);
  expect(google.refreshes).toBe(1);
  expect(google.listTokens).toEqual([]);

  // 5. A member who may not reconnect accounts gets the answer of an absent
  //    record. The owner reconnects Gmail in a popup.
  expect((await startReconnect(viewer, organisationId, account)).status).toBe(
    404,
  );
  const reconnected = await reconnect(owner, organisationId, account);
  expect(reconnected).toEqual({
    terminalState: "connected",
    failureReason: null,
  });
  expect(await integrationLifecycle(owner, account)).toEqual({
    kind: "active",
  });

  // 6. The Inbox reads the mail again, with the new sign-in.
  expect(await mailboxes(owner)).toEqual([
    { integrationAccountId: account, displayName: ADDRESS, access: "readable" },
  ]);
  const page = await readPage(owner, account);
  expect(page).toEqual({
    status: 200,
    body: { kind: "page", messages: [], nextCursor: null },
  });
  expect(google.listTokens).toEqual(["reconnected-access"]);

  task.meta.mailInboxReconnect = {
    firstRead: refused.body,
    googleRefreshesForFourReads: google.refreshes,
    ownerAfterRefusal: reconnectRequired.access,
    viewerMailboxes: 0,
    integrationsAfterRefusal: "reauth_required provider_grant_refused",
    reconnect: reconnected.terminalState,
    readAfterReconnect: page.status,
  };
}

/**
 * Google's token endpoint refuses the stored refresh token and accepts a
 * new authorization code. Gmail lists an empty Inbox.
 */
function serveGoogle(): Google {
  const google: Google = { refreshes: 0, codeExchanges: 0, listTokens: [] };
  network.use(
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get("grant_type") === "refresh_token") {
        google.refreshes += 1;
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          },
          { status: 400 },
        );
      }
      google.codeExchanges += 1;
      return HttpResponse.json({
        access_token: "reconnected-access",
        refresh_token: "reconnected-refresh",
        expires_in: 3_600,
        scope: GMAIL_FULL_MAILBOX_SCOPES.join(" "),
        id_token: googleIdToken(LABEL, ADDRESS),
      });
    }),
    http.post("https://oauth2.googleapis.com/revoke", () =>
      HttpResponse.json({}),
    ),
    http.get(`${GMAIL}/profile`, () =>
      HttpResponse.json({ emailAddress: ADDRESS, historyId: "1000" }),
    ),
    http.get(`${GMAIL}/messages`, ({ request }) => {
      google.listTokens.push(
        (request.headers.get("authorization") ?? "").replace(/^Bearer /u, ""),
      );
      return HttpResponse.json({ resultSizeEstimate: 0 });
    }),
  );
  return google;
}

/** The mailboxes of the Inbox for one person. */
async function mailboxes(person: Member): Promise<unknown> {
  const response = await exports.default.fetch(
    `${ORIGIN}/v1/control/organisations/${person.organisationId}/mail-inbox`,
    { headers: commerceHeaders(person.session) },
  );
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return isRecord(body) ? body.accounts : body;
}

/** The first page of the Inbox, as the Portal reads it. */
async function readPage(
  person: Member,
  account: IntegrationAccountId,
): Promise<Readonly<{ status: number; body: unknown }>> {
  return sendAs(
    person,
    `/v1/control/organisations/${person.organisationId}/mail-inbox`,
    { kind: "page", integrationAccountId: account, query: "", cursor: null },
  );
}

/** The account's state as the Integrations page reads it. */
async function integrationLifecycle(
  person: Member,
  account: IntegrationAccountId,
): Promise<unknown> {
  const response = await exports.default.fetch(
    `${ORIGIN}/v1/control/organisations/${person.organisationId}/accounts`,
    { headers: commerceHeaders(person.session) },
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.accounts))
    throw new Error(`No account list: ${JSON.stringify(body)}`);
  const found: unknown = body.accounts.find(
    (entry: unknown) =>
      isRecord(entry) && entry.integrationAccountId === account,
  );
  return isRecord(found) ? found.lifecycle : found;
}

async function startReconnect(
  person: Member,
  organisationId: OrganisationId,
  account: IntegrationAccountId,
): Promise<Response> {
  const headers = commerceHeaders(person.session);
  headers.set("idempotency-key", crypto.randomUUID());
  headers.set(
    "x-satyr-configuration-version",
    String(await configurationVersion(organisationId)),
  );
  return exports.default.fetch(
    `${ORIGIN}/v1/control/organisations/${organisationId}/accounts/${account}/reconnect`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ returnPath: `/portal/${organisationId}` }),
    },
  );
}

/** The Portal's reconnect: the start, then Google's callback in the popup. */
async function reconnect(
  person: Member,
  organisationId: OrganisationId,
  account: IntegrationAccountId,
): Promise<Readonly<{ terminalState: string; failureReason: string | null }>> {
  const started = await startReconnect(person, organisationId, account);
  const body: unknown = await started.json();
  expect(started.status, JSON.stringify(body)).toBe(201);
  if (!isRecord(body) || typeof body.authorization_url !== "string")
    throw new Error("The reconnect returned no authorization address");
  const state = new URL(body.authorization_url).searchParams.get("state");
  if (state === null) throw new Error("The authorization has no state");
  const callback = new URL(`${ORIGIN}/v1/control/providers/gmail/callback`);
  callback.searchParams.set("code", "gmail-reconnect-code");
  callback.searchParams.set("state", state);
  // The popup reports this message to the Portal.
  const completed = await exports.default.fetch(callback.toString());
  const report =
    /"terminal_state":"(\w+)","failure_reason_code":(?:"(\w+)"|null)/u.exec(
      await completed.text(),
    );
  if (report === null) throw new Error("The popup reports no result");
  return { terminalState: report[1] ?? "", failureReason: report[2] ?? null };
}

async function configurationVersion(
  organisationId: OrganisationId,
): Promise<number> {
  const version = await fixtureDatabase()
    .prepare(
      "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first("configuration_version");
  if (typeof version !== "number")
    throw new Error("The Organisation has no configuration version");
  return version;
}
