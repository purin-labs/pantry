import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { fetchConnectorMail, type MailConnectorContext } from "./execution";
import { isActorExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { GMAIL_MAILBOX } from "../mail/gmail-mail-adapter";
import { assertNever } from "@purin-labs/std";
import type { MailDecision } from "@purin-labs/control-api";
import { resolveConnectorGmailAccess } from "../actors/connector-email-evaluation";
import { gmailConnectorIdValue } from "./contract/connector-ids";
import type { Result } from "@purin-labs/kernel/result";
import { digestCanonical } from "../policy/information-flow/digest";
import { authorizeMailSource } from "./contract/mail-source-authorization";
import type {
  MailClassifiedPageInput,
  MailDecisionInput,
  MailOrganizationActorInput,
} from "./commands";
import { mailClassificationEvidence } from "./evidence";
import {
  listMailClassifications,
  listMailClassifiedReferences,
  readMailClassificationDigest,
  readMailHead,
  type MailClassifiedReferences,
} from "./store";
import type { MailOrganizationHead } from "./types";

type ReadError = Readonly<{ code: string }>;

async function authorizedHead(
  context: MailConnectorContext,
  input: MailOrganizationActorInput & Readonly<{ expectedRevision: number }>,
): Promise<Result<MailOrganizationHead | null, ReadError>> {
  if (
    context.scope.organisationId !== input.identity.organisationId ||
    !(await isActorExecutionActive(context.storage.sql, context.scope))
  )
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (
    input.identity.connectorId !==
      gmailConnectorIdValue(input.integrationAccountId) ||
    input.authority.organisationId !== input.identity.organisationId
  )
    return { ok: false, error: { code: "mail_inbox_not_found" } };
  const source = await authorizeMailSource(
    context.env,
    input.authority,
    input.integrationAccountId,
  );
  if (!(await isActorExecutionActive(context.storage.sql, context.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const head = readMailHead(context.storage.sql);
  if (
    source === null ||
    (head !== null &&
      (head.organisationId !== input.identity.organisationId ||
        head.integrationAccountId !== input.integrationAccountId ||
        head.sourcePin !== source.sourcePin))
  )
    return { ok: false, error: { code: "mail_inbox_not_found" } };
  if ((head?.view.revision ?? 0) !== input.expectedRevision)
    return { ok: false, error: { code: "mail_rule_revision_conflict" } };
  return { ok: true, value: head };
}

export async function readClassifiedPage(
  context: MailConnectorContext,
  input: MailClassifiedPageInput,
): Promise<Result<MailClassifiedReferences, ReadError>> {
  const authorized = await authorizedHead(context, input);
  if (!authorized.ok) return authorized;
  const head = authorized.value;
  if (head === null)
    return { ok: true, value: { references: [], nextAfter: null } };
  const ruleIds: string[] = [];
  switch (input.filter.kind) {
    case "important":
      for (const rule of head.view.rules)
        if (rule.kind === "prioritize") ruleIds.push(rule.ruleId);
      break;
    case "category":
      for (const rule of head.view.rules)
        if (rule.kind === "categorize" && rule.ruleId === input.filter.ruleId)
          ruleIds.push(rule.ruleId);
      if (ruleIds.length === 0)
        return { ok: false, error: { code: "mail_rule_revision_conflict" } };
      break;
    default:
      assertNever(input.filter);
  }
  const references = await listMailClassifiedReferences(
    context.scope.database,
    head,
    ruleIds,
    input.after,
  );
  if (!(await isActorExecutionActive(context.storage.sql, context.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  return { ok: true, value: references };
}

export async function readDecision(
  context: MailConnectorContext,
  input: MailDecisionInput,
): Promise<Result<MailDecision, ReadError>> {
  const fetcher = fetchConnectorMail.bind(
    null,
    context.storage.sql,
    context.scope,
    context.fetcher ?? runtimeFetch,
  );
  const mailOperations = GMAIL_MAILBOX;
  const authorized = await authorizedHead(context, input);
  if (!authorized.ok) return authorized;
  const head = authorized.value;
  if (head === null)
    return { ok: false, error: { code: "mail_inbox_not_found" } };
  const classifications = await listMailClassifications(
    context.scope.database,
    head,
    [input.messageId],
  );
  const classification = classifications.find(
    matchesDecisionRule.bind(null, input.ruleId),
  );
  const rule = head.view.rules.find(
    matchesDecisionRule.bind(null, input.ruleId),
  );
  const digest = await readMailClassificationDigest(
    context.scope.database,
    head,
    input.messageId,
    input.ruleId,
  );
  if (classification === undefined || rule === undefined || digest === null)
    return { ok: false, error: { code: "mail_inbox_not_found" } };
  const access = await resolveConnectorGmailAccess({
    env: context.env,
    organisationId: head.organisationId,
    integrationAccountId: head.integrationAccountId,
    now: Date.now(),
    fetcher,
  });
  if (!access.ok)
    return { ok: false, error: { code: "mail_inbox_unavailable" } };
  const content = await mailOperations.reads.readMessage({
    accessToken: access.value,
    messageId: input.messageId,
    fetcher,
  });
  if (!content.ok)
    return {
      ok: false,
      error: {
        code:
          content.error.code === "gmail_not_found"
            ? "mail_inbox_not_found"
            : "mail_inbox_unavailable",
      },
    };
  if (
    content.value.messageId !== classification.messageId ||
    content.value.threadId !== classification.threadId
  )
    return { ok: false, error: { code: "mail_inbox_unavailable" } };
  const currentDigest = await digestCanonical(
    mailClassificationEvidence(content.value),
  );
  // A rule edit or mailbox reconnect during hydration invalidates the result.
  const live = await authorizedHead(context, input);
  if (!live.ok) return live;
  return {
    ok: true,
    value: {
      classification,
      rule,
      evidence: currentDigest === digest ? "current" : "changed",
    },
  };
}

function matchesDecisionRule(
  ruleId: string,
  value: Readonly<{ ruleId: string }>,
): boolean {
  return value.ruleId === ruleId;
}
