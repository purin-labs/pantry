import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { GMAIL_MAILBOX } from "../../mail/gmail-mail-adapter";
import {
  authorizeMailSource,
  mailboxAwaitsReconnect,
} from "@purin-labs/area-inbox-contract/server/mail-source-authorization";
import { readMailThreadWork, readMailThreadReply } from "../../mail-inbox/work";
import {
  parseMailInboxCommand,
  type MailInboxAccount,
  type MailInboxResult,
  mailIdentifier,
  type MailClassifiedFilter,
  type MailOrganizationView,
  parseMailOrganizationView,
} from "@purin-labs/control-api";
import { listIntegrationAccounts } from "@purin-labs/connections/data/integration-account";
import { resolveConnectorGmailAccess } from "../../actors/connector-email-evaluation";
import { resolveActiveConnectorActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { gmailConnectorId } from "@purin-labs/area-inbox-contract/server/connector-ids";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { mailControlAuthority } from "@purin-labs/area-inbox-contract/server/control-authority";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "@purin-labs/control/worker/authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "@purin-labs/control/worker/http";
import { openMailInboxCursor, sealMailInboxCursor } from "../mail-inbox-cursor";

export type MailInboxRoute = Readonly<{
  kind: "mailInbox";
  organisationId: OrganisationId;
}>;

export function matchMailInboxRoute(pathname: string): MailInboxRoute | null {
  const match = /^\/v1\/control\/organisations\/([^/]+)\/mail-inbox$/.exec(
    pathname,
  );
  if (match === null) return null;
  const organisationId = parseOrganisationId(match[1] ?? "");
  return organisationId.ok
    ? { kind: "mailInbox", organisationId: organisationId.value }
    : null;
}

export async function handleMailInboxRoute(
  request: Request,
  env: Env,
  route: MailInboxRoute,
): Promise<Response> {
  const mailOperations = GMAIL_MAILBOX;
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "viewer",
    request.method === "POST",
  );
  if (!authorized.ok) return authorized.response;
  try {
    if (request.method === "GET") return await listMailboxes(env, authorized);
    const command = parseMailInboxCommand(
      await readBoundedJsonRecord(request, 16_384),
    );
    if (command === null)
      return controlError("mail_inbox_request_invalid", 422);
    const accountId = parseIntegrationAccountId(command.integrationAccountId);
    if (!accountId.ok) return controlError("mail_inbox_not_found", 404);
    const authority = await mailControlAuthority(authorized);
    if (authority === null) return controlError("mail_inbox_not_found", 404);
    const source = await authorizeMailSource(env, authority, accountId.value);
    if (source === null)
      return (await mailboxAwaitsReconnect(env, authority, accountId.value))
        ? mailAuthorizationExpired()
        : controlError("mail_inbox_not_found", 404);
    let result: MailInboxResult;
    if (command.kind === "work" || command.kind === "reply") {
      const input = {
        organisationId: route.organisationId,
        integrationAccountId: accountId.value,
        threadId: command.threadId,
      };
      if (command.kind === "work") {
        const work = await readMailThreadWork(env, input);
        if (!work.ok) return mailReadError(work.error.code);
        result = { kind: "work", threadId: command.threadId, work: work.value };
      } else {
        const reply = await readMailThreadReply(env, {
          ...input,
          proposalId: command.proposalId,
          authority,
        });
        if (!reply.ok) return mailReadError(reply.error.code);
        result = reply.value;
      }
    } else {
      const access = await resolveConnectorGmailAccess({
        env,
        organisationId: route.organisationId,
        integrationAccountId: accountId.value,
        now: Date.now(),
        fetcher: runtimeFetch,
      });
      if (!access.ok)
        return access.error.authorizationExpired === true
          ? mailAuthorizationExpired()
          : controlError("mail_inbox_unavailable", 503);
      if (command.kind === "decision" || command.kind === "classifiedPage") {
        const connectorId = gmailConnectorId(accountId.value);
        if (!connectorId.ok) return controlError("mail_inbox_not_found", 404);
        const connector = await resolveActiveConnectorActor({
          env: env,
          namespace: env.CONNECTOR,
          organisationId: route.organisationId,
          connectorId: connectorId.value,
          now: Date.now(),
        });
        if (!connector.ok) return controlError("mail_inbox_unavailable", 503);
        const input = {
          identity: {
            organisationId: route.organisationId,
            connectorId: connectorId.value,
          },
          integrationAccountId: accountId.value,
          authority,
          expectedRevision: command.expectedRevision,
        };
        if (command.kind === "decision") {
          const decision = await connector.value.readMailDecision({
            ...input,
            messageId: command.messageId,
            ruleId: command.ruleId,
          });
          if (!decision.ok) return mailReadError(decision.error.code);
          result = { kind: "decision", decision: decision.value };
        } else {
          const binding = {
            sessionToken: authorized.authenticated.token,
            organisationId: route.organisationId,
            integrationAccountId: accountId.value,
            query: JSON.stringify([
              "classified",
              command.filter,
              command.expectedRevision,
              source.sourcePin,
            ]),
          };
          const after =
            command.cursor === null
              ? null
              : await openMailInboxCursor(binding, command.cursor);
          if (command.cursor !== null && !mailIdentifier(after))
            return controlError("mail_inbox_cursor_invalid", 422);
          const pageInput = { ...input, filter: command.filter, after };
          const page = await connector.value.readMailClassifiedPage(pageInput);
          if (!page.ok) return mailReadError(page.error.code);
          const hydrated = await mailOperations.reads.readInboxReferences({
            accessToken: access.value,
            label: "INBOX",
            references: page.value.references,
            fetcher: runtimeFetch,
          });
          if (!hydrated.ok) return controlError("mail_inbox_unavailable", 502);
          const liveView = await connector.value.readMailOrganization({
            identity: input.identity,
            integrationAccountId: input.integrationAccountId,
            authority: input.authority,
            messageIds: page.value.references.map(classifiedMessageId),
          });
          if (!liveView.ok) return mailReadError(liveView.error.code);
          const view = parseMailOrganizationView(liveView.value);
          if (view === null) return controlError("mail_inbox_unavailable", 503);
          if (view.rules.revision !== command.expectedRevision)
            return controlError("mail_rule_revision_conflict", 409);
          result = {
            kind: "page",
            messages: hydrated.value.filter(
              stillClassified.bind(null, command.filter, view),
            ),
            nextCursor:
              page.value.nextAfter === null
                ? null
                : await sealMailInboxCursor(binding, page.value.nextAfter),
          };
        }
      } else if (command.kind === "thread") {
        const thread = await mailOperations.reads.readConversation({
          accessToken: access.value,
          threadId: command.threadId,
          fetcher: runtimeFetch,
        });
        if (!thread.ok)
          return controlError(
            "mail_inbox_thread_unavailable",
            thread.error.code === "gmail_not_found" ? 404 : 502,
          );
        result = {
          kind: "thread",
          threadId: command.threadId,
          messages: thread.value,
        };
      } else {
        // Spam is listed for the person only: no agent, rule or model reads it.
        const spam = command.kind === "spamPage";
        const query = spam ? "" : command.query;
        const binding = {
          sessionToken: authorized.authenticated.token,
          organisationId: route.organisationId,
          integrationAccountId: accountId.value,
          // A Spam cursor opens no Inbox page, and an Inbox cursor no Spam page.
          query: spam ? JSON.stringify(["spam"]) : query,
        };
        const pageToken =
          command.cursor === null
            ? null
            : await openMailInboxCursor(binding, command.cursor);
        if (command.cursor !== null && pageToken === null)
          return controlError("mail_inbox_cursor_invalid", 422);
        const page = await mailOperations.reads.browseInbox({
          accessToken: access.value,
          label: spam ? "SPAM" : "INBOX",
          query,
          pageToken,
          fetcher: runtimeFetch,
        });
        if (!page.ok) return controlError("mail_inbox_unavailable", 502);
        const nextCursor =
          page.value.nextPageToken === null
            ? null
            : await sealMailInboxCursor(binding, page.value.nextPageToken);
        result = { kind: "page", messages: page.value.messages, nextCursor };
      }
    }
    // Provider reads may outlive a grant or connection change.
    const current = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "viewer",
      false,
    );
    if (!current.ok) return controlError("mail_inbox_not_found", 404);
    const liveAuthority = await mailControlAuthority(current);
    const liveSource =
      liveAuthority === null
        ? null
        : await authorizeMailSource(env, liveAuthority, accountId.value);
    if (liveSource === null || liveSource.sourcePin !== source.sourcePin)
      return controlError("mail_inbox_not_found", 404);
    return controlJson(result);
  } catch {
    return controlError("mail_inbox_unavailable", 503);
  }
}

/**
 * Google refused the mailbox's sign-in. No read can succeed until a person
 * reconnects the mailbox, so the Inbox asks for that and does not retry.
 */
function mailAuthorizationExpired(): Response {
  return controlError("mail_authorization_expired", 409);
}

function mailReadError(code: string): Response {
  return controlError(
    code,
    code === "mail_inbox_not_found"
      ? 404
      : code === "mail_rule_revision_conflict" || code === "mail_reply_changed"
        ? 409
        : 503,
  );
}

function stillClassified(
  filter: MailClassifiedFilter,
  view: MailOrganizationView,
  message: Readonly<{ messageId: string }>,
): boolean {
  for (const result of view.classifications) {
    if (result.messageId !== message.messageId || result.outcome !== "matched")
      continue;
    for (const rule of view.rules.rules) {
      if (rule.ruleId !== result.ruleId) continue;
      if (
        filter.kind === "important"
          ? rule.kind === "prioritize"
          : rule.kind === "categorize" && rule.ruleId === filter.ruleId
      )
        return true;
    }
  }
  return false;
}

function classifiedMessageId(
  reference: Readonly<{ messageId: string }>,
): string {
  return reference.messageId;
}

async function listMailboxes(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const accounts: MailInboxAccount[] = [];
  const connected = await listIntegrationAccounts({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  const authority = await mailControlAuthority(authorized);
  for (const account of connected) {
    if (account.provider !== "gmail" || authority === null) continue;
    const access =
      (await authorizeMailSource(
        env,
        authority,
        account.integrationAccountId,
      )) !== null
        ? "readable"
        : account.lifecycle.kind === "reauth_required" &&
            (await mailboxAwaitsReconnect(
              env,
              authority,
              account.integrationAccountId,
            ))
          ? "reconnect_required"
          : null;
    if (access === null) continue;
    accounts.push({
      integrationAccountId: account.integrationAccountId,
      displayName: account.displayName,
      access,
    });
  }
  return controlJson({ kind: "accounts", accounts } satisfies MailInboxResult);
}

