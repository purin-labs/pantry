import { typeSafeMonth } from "@purin-labs/agent/typesafe/usage-store";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { fetchConnectorMail, type MailConnectorContext } from "./execution";
import { isActorExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { GMAIL_MAILBOX } from "../mail/gmail-mail-adapter";
import type {
  MailOrganizationView,
  MailClassification,
} from "@purin-labs/control-api";
import {
  requireActiveOrganisationActor,
  requireActiveOrganisationActorAtPlacement,
} from "@purin-labs/actor-runtime/actors/actor-router";
import type { InboxOrganisationActor } from "../actors/organisation/organisation-inbox-rpc";
import {
  resolveConnectorGmailAccess,
  establishConnectorEmailWatch,
} from "../actors/connector-email-evaluation";
import type { GmailHistoryMessage } from "../mail/gmail-adapter";
import type { Env } from "@purin-labs/kernel/env";
import { digestCanonical } from "@purin-labs/authority/policy/information-flow/digest";
import { authorizeMailSource } from "@purin-labs/area-inbox-contract/server/mail-source-authorization";
import { mailInferenceEligible } from "@purin-labs/area-inbox-contract/server/mail-inference-eligibility";
import type { MailOrganizationHead, MailWork } from "./types";
import {
  claimMailWork,
  deferMailObservation,
  deferDueMailWork,
  finishMailWork,
  mailObservationDue,
  mailPendingCount,
  projectMailClassifications,
  queueMailWork,
  readMailHead,
  pauseMailWorkBudget,
  pauseMailWorkUntil,
  retryMailWork,
  writeMailHead,
  listMailClassifications,
} from "./store";
import type { MailEvaluationInput } from "./evaluation";
import {
  claimMailResponseOwner,
  decideInboxResponse,
  recoverInterruptedInboxResponses,
} from "./response-store";
import { runInboxResponses } from "./actions";

export function mailEvaluationInput(
  head: MailOrganizationHead,
  work: MailWork,
): MailEvaluationInput {
  return {
    organisationId: head.organisationId,
    integrationAccountId: head.integrationAccountId,
    evaluationId: work.workId,
    revision: work.revision,
    messageId: work.messageId,
    rules: head.view.rules,
    authority: head.authority,
    sourcePin: head.sourcePin,
  };
}
export async function mailOrganizationReadiness(
  env: Env,
  head: MailOrganizationHead,
): Promise<MailOrganizationView["readiness"]> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    head.organisationId,
  );
  if (!execution.ok) return "eligibility_required";
  const source = await authorizeMailSource(
    env,
    head.authority,
    head.integrationAccountId,
  );
  if (source === null || source.sourcePin !== head.sourcePin)
    return "eligibility_required";
  if (head.observation.kind === "history_expired") return "history_expired";
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId: head.organisationId,
    placement: execution.value.placement,
    now: Date.now(),
  });
  const connection = await organisation.readTypeSafeConnectionConfiguration({
    organisationId: head.organisationId,
  });
  if (!connection.ok || connection.value.authority === null)
    return "typesafe_unavailable";
  return (await mailInferenceEligible({
    db: execution.value.database,
    organisationId: head.organisationId,
    integrationAccountId: head.integrationAccountId,
    sourcePin: head.sourcePin,
    typesafe: connection.value.authority,
    now: Date.now(),
  }))
    ? "ready"
    : "eligibility_required";
}
export async function queueSelectedMail(
  input: MailConnectorContext &
    Readonly<{
      head: MailOrganizationHead;
      messageIds: readonly string[];
    }>,
): Promise<boolean> {
  if (
    input.scope.organisationId !== input.head.organisationId ||
    !(await isActorExecutionActive(input.storage.sql, input.scope))
  )
    return false;
  const fetcher = fetchConnectorMail.bind(
    null,
    input.storage.sql,
    input.scope,
    input.fetcher ?? runtimeFetch,
  );
  const mailOperations = GMAIL_MAILBOX;
  if (mailPendingCount(input.storage.sql) + input.messageIds.length > 250)
    return false;
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: input.head.organisationId,
    integrationAccountId: input.head.integrationAccountId,
    now: Date.now(),
    fetcher,
  });
  if (!access.ok) return false;
  const works: MailWork[] = [];
  for (const messageId of input.messageIds) {
    const metadata = await mailOperations.reads.readMessageMetadata({
      accessToken: access.value,
      messageId,
      fetcher,
    });
    if (!metadata.ok || !metadata.value.labelIds.includes("INBOX"))
      return false;
    const work = await classificationWork(
      input.head,
      messageId,
      metadata.value.threadId,
      "historical",
    );
    works.push({
      workId: `${work.workId}_${crypto.randomUUID().replaceAll("-", "")}`,
      messageId: work.messageId,
      threadId: work.threadId,
      revision: work.revision,
      origin: "historical",
    });
  }
  if (!(await isActorExecutionActive(input.storage.sql, input.scope)))
    return false;
  if (!samePublishedHead(readMailHead(input.storage.sql), input.head))
    return false;
  input.storage.transactionSync(
    queueWorks.bind(null, input.storage.sql, works, Date.now()),
  );
  return true;
}
function queueWorks(
  sql: SqlStorage,
  works: readonly MailWork[],
  now: number,
): void {
  for (const work of works) queueMailWork(sql, work, now);
}
async function classificationWork(
  head: MailOrganizationHead,
  messageId: string,
  threadId: string,
  origin: MailWork["origin"],
): Promise<MailWork> {
  const digest = await digestCanonical({
    organisationId: head.organisationId,
    integrationAccountId: head.integrationAccountId,
    revision: head.view.revision,
    origin,
    messageId,
  });
  return {
    workId: `mail_${digest}`,
    messageId,
    threadId,
    revision: head.view.revision,
    origin,
  };
}
export async function runMailOrganization(
  input: MailConnectorContext,
): Promise<void> {
  if (!(await isActorExecutionActive(input.storage.sql, input.scope))) return;
  recoverInterruptedInboxResponses(input.storage.sql, Date.now());
  const head = readMailHead(input.storage.sql);
  if (
    head === null ||
    head.organisationId !== input.scope.organisationId ||
    head.view.kind !== "published" ||
    head.observation.kind === "history_expired"
  )
    return;
  const readiness = await mailOrganizationReadiness(input.env, head);
  if (!(await isActorExecutionActive(input.storage.sql, input.scope))) return;
  if (readiness !== "ready") {
    input.storage.transactionSync(
      deferMailObservation.bind(null, input.storage.sql, Date.now()),
    );
    input.storage.transactionSync(
      deferDueMailWork.bind(null, input.storage.sql, Date.now()),
    );
    return;
  }
  if (mailObservationDue(input.storage.sql, Date.now()))
    await observeMail(input, head);
  for (let index = 0; index < 5; index++) {
    if (!(await isActorExecutionActive(input.storage.sql, input.scope))) return;
    const current = readMailHead(input.storage.sql);
    if (!samePublishedHead(current, head)) return;
    const work = input.storage.transactionSync(
      claimMailWork.bind(null, input.storage.sql, Date.now()),
    );
    if (work === null) break;
    if (work.revision !== head.view.revision) {
      finishMailWork(input.storage.sql, work, "blocked");
      continue;
    }
    try {
      const organisation =
        await requireActiveOrganisationActor<InboxOrganisationActor>({
          env: input.env,
          organisationId: head.organisationId,
          now: Date.now(),
        });
      if (!(await isActorExecutionActive(input.storage.sql, input.scope)))
        return;
      const evaluated = await organisation.evaluateMailClassification(
        mailEvaluationInput(head, work),
      );
      if (!(await isActorExecutionActive(input.storage.sql, input.scope)))
        return;
      if (!evaluated.ok) {
        if (evaluated.error.code === "budget_exhausted")
          pauseMailWorkBudget(input.storage.sql, work, Date.now());
        else if (evaluated.error.code === "allowance_reached")
          pauseMailWorkUntil(
            input.storage.sql,
            work,
            typeSafeMonth(Date.now()).next,
          );
        else if (
          evaluated.error.code === "rate_limited" ||
          evaluated.error.code === "mail_classification_source_unavailable" ||
          evaluated.error.code === "organisation_placement_conflict"
        )
          retryMailWork(
            input.storage.sql,
            work,
            Date.now(),
            evaluated.error.retryAfterMs,
          );
        else finishMailWork(input.storage.sql, work, "blocked");
        continue;
      }
      const currentReadiness = await mailOrganizationReadiness(input.env, head);
      if (!(await isActorExecutionActive(input.storage.sql, input.scope)))
        return;
      if (
        !samePublishedHead(readMailHead(input.storage.sql), head) ||
        currentReadiness !== "ready"
      ) {
        finishMailWork(input.storage.sql, work, "blocked");
        continue;
      }
      await projectMailClassifications({
        scope: input.scope,
        head,
        work,
        classifications: evaluated.value.classifications,
        contentDigest: evaluated.value.contentDigest,
      });
      const outcomes = await listMailClassifications(
        input.scope.database,
        head,
        [work.messageId],
      );
      if (!(await isActorExecutionActive(input.storage.sql, input.scope)))
        return;
      input.storage.transactionSync(
        finishClassification.bind(
          null,
          input.storage.sql,
          head,
          work,
          outcomes,
        ),
      );
    } catch {
      if (!(await isActorExecutionActive(input.storage.sql, input.scope)))
        return;
      retryMailWork(input.storage.sql, work, Date.now());
    }
  }
  if (!(await isActorExecutionActive(input.storage.sql, input.scope))) return;
  const current = readMailHead(input.storage.sql);
  if (current !== null && samePublishedHead(current, head))
    await runInboxResponses(input, current);
}
function finishClassification(
  sql: SqlStorage,
  head: MailOrganizationHead,
  work: MailWork,
  outcomes: readonly MailClassification[],
): void {
  finishMailWork(sql, work, "done");
  if (work.origin !== "arrival" || head.action.kind !== "supplier_delay")
    return;
  const current = readMailHead(sql);
  if (!samePublishedHead(current, head)) return;
  for (const classification of outcomes)
    if (classification.ruleId === head.action.ruleId)
      decideInboxResponse(
        sql,
        work.messageId,
        work.revision,
        classification.outcome,
      );
}
function claimHistoryOwners(
  sql: SqlStorage,
  head: MailOrganizationHead,
  messages: readonly GmailHistoryMessage[],
): void {
  for (const message of messages) claimMailResponseOwner(sql, head, message);
}
async function observeMail(
  input: MailConnectorContext,
  head: MailOrganizationHead,
): Promise<void> {
  const mailOperations = GMAIL_MAILBOX;
  if (head.observation.kind !== "watching") return;
  const fetcher = fetchConnectorMail.bind(
    null,
    input.storage.sql,
    input.scope,
    input.fetcher ?? runtimeFetch,
  );
  const observation = head.observation;
  deferMailObservation(input.storage.sql, Date.now());
  if (mailPendingCount(input.storage.sql) >= 200) return;
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: head.organisationId,
    integrationAccountId: head.integrationAccountId,
    now: Date.now(),
    fetcher,
  });
  if (!access.ok) return;
  let watchExpiresAt = observation.watchExpiresAt;
  if (watchExpiresAt <= Date.now() + 3_600_000) {
    const renewed = await establishConnectorEmailWatch({
      env: input.env,
      storage: input.storage,
      scope: input.scope,
      integrationAccountId: head.integrationAccountId,
      now: Date.now(),
      fetcher,
    });
    if (
      renewed.ok &&
      samePublishedHead(readMailHead(input.storage.sql), head)
    ) {
      watchExpiresAt = renewed.value.watchExpiresAt;
    }
  }
  const history = await mailOperations.observation.readInboxHistoryPage({
    accessToken: access.value,
    startHistoryId: observation.historyId,
    pageToken: observation.historyPageToken,
    fetcher,
  });
  if (!(await isActorExecutionActive(input.storage.sql, input.scope))) return;
  if (!history.ok) {
    if (
      history.error.code === "gmail_history_expired" &&
      samePublishedHead(readMailHead(input.storage.sql), head)
    ) {
      const expired: MailOrganizationHead = {
        organisationId: head.organisationId,
        integrationAccountId: head.integrationAccountId,
        view: head.view,
        authority: head.authority,
        sourcePin: head.sourcePin,
        classificationRevision: head.classificationRevision,
        observation: { kind: "history_expired" },
        action: head.action,
      };
      writeMailHead(input.storage.sql, expired, Date.now());
    }
    return;
  }
  const works: MailWork[] = [];
  if (!samePublishedHead(readMailHead(input.storage.sql), head)) return;
  input.storage.transactionSync(
    claimHistoryOwners.bind(
      null,
      input.storage.sql,
      head,
      history.value.messages,
    ),
  );
  for (const ref of history.value.messages) {
    const metadata = await mailOperations.reads.readMessageMetadata({
      accessToken: access.value,
      messageId: ref.messageId,
      fetcher,
    });
    if (!metadata.ok) {
      if (metadata.error.code === "gmail_not_found") continue;
      return;
    }
    if (metadata.value.labelIds.includes("INBOX"))
      works.push(
        await classificationWork(
          head,
          ref.messageId,
          metadata.value.threadId,
          "arrival",
        ),
      );
  }
  if (!(await isActorExecutionActive(input.storage.sql, input.scope))) return;
  if (
    !samePublishedHead(readMailHead(input.storage.sql), head) ||
    mailPendingCount(input.storage.sql) + works.length > 250
  )
    return;
  const advanced: MailOrganizationHead = {
    organisationId: head.organisationId,
    integrationAccountId: head.integrationAccountId,
    view: head.view,
    authority: head.authority,
    sourcePin: head.sourcePin,
    classificationRevision: head.classificationRevision,
    action: head.action,
    observation: {
      kind: "watching",
      historyId:
        history.value.nextPageToken === null
          ? history.value.latestHistoryId
          : observation.historyId,
      historyPageToken: history.value.nextPageToken,
      watchExpiresAt,
    },
  };
  input.storage.transactionSync(
    commitObservation.bind(
      null,
      input.storage.sql,
      advanced,
      works,
      Date.now(),
    ),
  );
}
function commitObservation(
  sql: SqlStorage,
  head: MailOrganizationHead,
  works: readonly MailWork[],
  now: number,
): void {
  queueWorks(sql, works, now);
  writeMailHead(sql, head, now);
  deferMailObservation(sql, now);
}
function samePublishedHead(
  current: MailOrganizationHead | null,
  expected: MailOrganizationHead,
): boolean {
  return (
    current !== null &&
    current.view.kind === "published" &&
    current.observation.kind === "watching" &&
    current.view.revision === expected.view.revision &&
    current.sourcePin === expected.sourcePin
  );
}
