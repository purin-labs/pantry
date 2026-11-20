import { runtimeFetch } from "../runtime-fetch";
import { GMAIL_MAILBOX } from "../mail/gmail-mail-adapter";
import { isActorExecutionActive } from "../actors/actor-execution-quiescence";
import { fetchConnectorMail, type MailConnectorContext } from "./execution";
import type { MailRule } from "@purin-labs/control-api";
import { readAgentMailboxBinding } from "../data/email-mailbox";
import { admitEmailThreadCase } from "../actors/email-case-admission";
import { processEmailThreadTurn } from "../actors/email-case-processing";
import {
  readEmailRuntime,
  recordEmailAdmissions,
  pauseEmailRuntime,
} from "../actors/connector-email";
import {
  decideEmailAdmissions,
  admittedThreadSubject,
  groupAdmissionsByThread,
  admittedSenders,
  projectThreadAdmissions,
  resolveConnectorGmailAccess,
} from "../actors/connector-email-evaluation";
import type { GmailMessageMetadata } from "../mail/gmail-adapter";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { digestCanonical } from "../policy/information-flow/digest";
import { mailClassificationEvidence } from "./evidence";
import {
  listMailClassifications,
  readMailClassificationDigest,
  readMailHead,
} from "./store";
import {
  readyInboxResponses,
  startInboxResponse,
  settleInboxResponse,
  type InboxResponseSettlement,
  decideInboxResponse,
  type InboxResponseOwner,
} from "./response-store";
import type { MailAction, MailOrganizationHead } from "./types";

export async function publishedMailAction(
  scope: OrganisationExecutionScope,
  sql: SqlStorage,
  headIdentity: Pick<
    MailOrganizationHead,
    "organisationId" | "integrationAccountId"
  >,
  rules: readonly MailRule[],
  historyFloor: string,
): Promise<MailAction | null> {
  const rule = rules.find(isInvestigationRule);
  if (rule === undefined) return { kind: "none" };
  const runtime = readEmailRuntime(sql);
  if (
    runtime === null ||
    runtime.disabledAt !== null ||
    runtime.organisationId !== headIdentity.organisationId ||
    runtime.integrationAccountId !== headIdentity.integrationAccountId
  )
    return null;
  const binding = await readAgentMailboxBinding({
    db: scope.database,
    organisationId: headIdentity.organisationId,
    integrationAccountId: headIdentity.integrationAccountId,
  });
  if (!binding.ok) return null;
  return {
    kind: "supplier_delay",
    ruleId: rule.ruleId,
    historyFloor,
    mailboxBindingId: binding.value.binding.mailboxBindingId,
    bindingRevision: binding.value.binding.currentRevision,
    policyVersion: runtime.policyVersion,
  };
}
function isInvestigationRule(rule: MailRule): boolean {
  return rule.kind === "investigate_supplier_delay";
}

export async function runInboxResponses(
  input: MailConnectorContext,
  head: MailOrganizationHead,
): Promise<void> {
  if (
    input.scope.organisationId !== head.organisationId ||
    !(await isActorExecutionActive(input.storage.sql, input.scope))
  )
    return;
  if (
    head.action.kind !== "supplier_delay" ||
    head.observation.kind !== "watching" ||
    head.observation.historyPageToken !== null
  )
    return;
  const runtime = readEmailRuntime(input.storage.sql);
  if (
    runtime === null ||
    runtime.disabledAt !== null ||
    runtime.processing.kind === "paused" ||
    runtime.policyVersion !== head.action.policyVersion
  )
    return;
  const binding = await readAgentMailboxBinding({
    db: input.scope.database,
    organisationId: head.organisationId,
    integrationAccountId: head.integrationAccountId,
  });
  if (
    !binding.ok ||
    binding.value.binding.mailboxBindingId !== head.action.mailboxBindingId ||
    binding.value.binding.currentRevision !== head.action.bindingRevision
  )
    return;
  if (!(await isActorExecutionActive(input.storage.sql, input.scope))) return;
  const owners = readyInboxResponses(input.storage.sql, head.view.revision);
  if (owners.length === 0) return;
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: head.organisationId,
    integrationAccountId: head.integrationAccountId,
    now: Date.now(),
    fetcher: fetchConnectorMail.bind(
      null,
      input.storage.sql,
      input.scope,
      input.fetcher ?? runtimeFetch,
    ),
  });
  if (!access.ok) return;
  const messages: GmailMessageMetadata[] = [];
  for (const owner of owners) {
    const current = await currentActionMessage(
      input,
      access.value,
      head,
      owner,
    );
    if (!(await isActorExecutionActive(input.storage.sql, input.scope))) return;
    if (current.kind === "unavailable") return;
    if (current.kind === "stale") {
      decideInboxResponse(
        input.storage.sql,
        owner.messageId,
        owner.ruleRevision,
        "needs_review",
      );
      continue;
    }
    messages.push(current.message);
  }
  messages.sort(compareMessages);
  const decision = decideEmailAdmissions({
    sql: input.storage.sql,
    runtime,
    limits: runtime.limits,
    messages,
    now: Date.now(),
  });
  if (decision.pause !== null)
    pauseEmailRuntime(input.storage.sql, {
      reason: decision.pause,
      now: Date.now(),
    });
  for (const thread of groupAdmissionsByThread(runtime, decision.admitted)) {
    if (!(await isActorExecutionActive(input.storage.sql, input.scope))) return;
    const selected = owners.filter(ownerInThread.bind(null, thread.messageIds));
    const current = readMailHead(input.storage.sql);
    if (
      current === null ||
      current.view.kind !== "published" ||
      current.view.revision !== head.view.revision
    )
      return;
    const started = input.storage.transactionSync(
      startInboxResponse.bind(
        null,
        input.storage.sql,
        selected,
        thread.caseId,
        Date.now(),
      ),
    );
    if (!started) continue;
    let completion:
      | Readonly<{ kind: "admitting"; outcome?: never }>
      | Readonly<{ kind: "deferred"; outcome?: never }>
      | Readonly<{
          kind: "processing";
          outcome: "draft" | "no_reply" | "failed";
        }> = { kind: "admitting" };
    try {
      const admitted = await admitEmailThreadCase(input.env, {
        scope: input.scope,
        organisationId: head.organisationId,
        integrationAccountId: head.integrationAccountId,
        gmailThreadId: thread.threadId,
        caseId: thread.caseId,
        messageIds: thread.messageIds,
        mailboxBindingId: head.action.mailboxBindingId,
        bindingRevision: head.action.bindingRevision,
        policyVersion: head.action.policyVersion,
        receivedAt: Date.now(),
        subject: admittedThreadSubject(messages, thread),
      });
      if (!admitted.ok) continue;
      if (!(await isActorExecutionActive(input.storage.sql, input.scope)))
        return;
      const projected = await projectThreadAdmissions(
        input.scope,
        runtime,
        {
          mailboxBindingId: head.action.mailboxBindingId,
          currentRevision: head.action.bindingRevision,
        },
        thread,
        Date.now(),
        admittedSenders(messages),
      );
      if (!(await isActorExecutionActive(input.storage.sql, input.scope)))
        return;
      if (!projected.ok) continue;
      input.storage.transactionSync(
        recordActionAdmissions.bind(
          null,
          input.storage.sql,
          thread.admissions,
          runtime.policyVersion,
          Date.now(),
        ),
      );
      completion = { kind: "processing", outcome: "failed" };
      const turn = await processEmailThreadTurn(input.env, {
        scope: input.scope,
        connectorSql: input.storage.sql,
        organisationId: head.organisationId,
        integrationAccountId: head.integrationAccountId,
        threadId: thread.threadId,
        caseId: thread.caseId,
        messageIds: thread.messageIds,
        mailboxBindingId: head.action.mailboxBindingId,
        bindingRevision: head.action.bindingRevision,
        policyVersion: head.action.policyVersion,
        limits: runtime.limits,
        responsePolicy: "draft_only",
        now: Date.now(),
      });
      if (turn.ok && turn.value.kind === "deferred")
        completion = { kind: "deferred" };
      else if (turn.ok)
        completion = {
          kind: "processing",
          outcome: turn.value.kind === "proposed" ? "draft" : "no_reply",
        };
    } finally {
      let settlement: InboxResponseSettlement;
      if (
        completion.kind === "deferred" ||
        (completion.kind === "admitting" &&
          !(await isActorExecutionActive(input.storage.sql, input.scope)))
      )
        settlement = { kind: "retry" };
      else if (completion.kind === "processing")
        settlement = { kind: "complete", outcome: completion.outcome };
      else settlement = { kind: "complete", outcome: "failed" };
      input.storage.transactionSync(
        settleInboxResponse.bind(
          null,
          input.storage.sql,
          selected,
          thread.caseId,
          settlement,
        ),
      );
    }
  }
}
function recordActionAdmissions(
  sql: SqlStorage,
  admitted: Parameters<typeof recordEmailAdmissions>[1]["admitted"],
  policyVersion: number,
  now: number,
): void {
  recordEmailAdmissions(sql, { admitted, policyVersion, now });
}
function ownerInThread(
  messageIds: readonly string[],
  owner: InboxResponseOwner,
): boolean {
  return messageIds.includes(owner.messageId);
}
function compareMessages(
  left: GmailMessageMetadata,
  right: GmailMessageMetadata,
): number {
  if (left.internalDate !== right.internalDate)
    return left.internalDate - right.internalDate;
  return left.messageId.localeCompare(right.messageId);
}
async function currentActionMessage(
  input: MailConnectorContext,
  accessToken: string,
  head: MailOrganizationHead,
  owner: InboxResponseOwner,
): Promise<
  | Readonly<{ kind: "current"; message: GmailMessageMetadata }>
  | Readonly<{ kind: "stale"; message?: never }>
  | Readonly<{ kind: "unavailable"; message?: never }>
> {
  const mailOperations = GMAIL_MAILBOX;
  const classifications = await listMailClassifications(
    input.scope.database,
    head,
    [owner.messageId],
  );
  const result = classifications.find(
    classificationForRule.bind(null, owner.ruleId),
  );
  if (result?.outcome !== "matched") return { kind: "stale" };
  const metadata = await mailOperations.reads.readMessageMetadata({
    accessToken,
    messageId: owner.messageId,
    fetcher: fetchConnectorMail.bind(
      null,
      input.storage.sql,
      input.scope,
      input.fetcher ?? runtimeFetch,
    ),
  });
  const content = await mailOperations.reads.readMessage({
    accessToken,
    messageId: owner.messageId,
    fetcher: fetchConnectorMail.bind(
      null,
      input.storage.sql,
      input.scope,
      input.fetcher ?? runtimeFetch,
    ),
  });
  if (!metadata.ok || !content.ok) return { kind: "unavailable" };
  if (
    !metadata.value.labelIds.includes("INBOX") ||
    content.value.threadId !== owner.threadId ||
    metadata.value.threadId !== owner.threadId ||
    metadata.value.messageId !== owner.messageId ||
    content.value.messageId !== owner.messageId
  )
    return { kind: "stale" };
  const digest = await readMailClassificationDigest(
    input.scope.database,
    head,
    owner.messageId,
    owner.ruleId,
  );
  if (
    digest !==
    (await digestCanonical(mailClassificationEvidence(content.value)))
  )
    return { kind: "stale" };
  return { kind: "current", message: metadata.value };
}
function classificationForRule(
  ruleId: string,
  classification: Readonly<{ ruleId: string }>,
): boolean {
  return classification.ruleId === ruleId;
}
