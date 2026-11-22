import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { fetchConnectorMail, type MailConnectorContext } from "./execution";
import { isActorExecutionActive } from "../actors/actor-execution-quiescence";
import type { RequestAuthority } from "@purin-labs/contracts";
import type {
  MailOrganizationCommand,
  MailOrganizationView,
  MailClassifiedFilter,
  MailRule,
} from "@purin-labs/control-api";
import type {
  IntegrationAccountId,
  OrganisationId,
  ConnectorId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { requireActiveOrganisationActor } from "../actors/actor-router";
import { establishConnectorEmailWatch } from "../actors/connector-email-evaluation";
import { readEmailMailboxAccount } from "../data/email-mailbox";
import { gmailConnectorIdValue } from "./contract/connector-ids";
import { digestCanonical } from "../policy/information-flow/digest";
import { authorizeMailSource } from "./contract/mail-source-authorization";
import { mailInferenceEligible } from "./contract/mail-inference-eligibility";
import {
  mailOrganizationReadiness,
  queueSelectedMail,
} from "./connector-runtime";
import { publishedMailAction } from "./actions";
import { pendingInboxResponseCount } from "./response-store";
import {
  listMailClassifications,
  mailPendingCount,
  mailFailedCount,
  mailBudgetPausedCount,
  readMailHead,
  writeMailHead,
} from "./store";
import type { MailOrganizationHead } from "./types";
import type { Variant } from "@purin-labs/type-utils";

export type MailOrganizationActorInput = Readonly<{
  identity: Readonly<{
    organisationId: OrganisationId;
    connectorId: ConnectorId;
  }>;
  integrationAccountId: IntegrationAccountId;
  authority: Variant<RequestAuthority, "control">;
}>;
export type MailOrganizationReadInput = MailOrganizationActorInput &
  Readonly<{ messageIds: readonly string[] }>;
export type MailClassifiedPageInput = MailOrganizationActorInput &
  Readonly<{
    expectedRevision: number;
    filter: MailClassifiedFilter;
    after: string | null;
  }>;
export type MailDecisionInput = MailOrganizationActorInput &
  Readonly<{
    expectedRevision: number;
    messageId: string;
    ruleId: string;
  }>;
type CommandInput = MailOrganizationActorInput &
  Readonly<{ command: MailOrganizationCommand }>;
type MailCommandError = Readonly<{ code: string }>;
export async function readOrganization(
  context: MailConnectorContext,
  input: MailOrganizationReadInput,
): Promise<Result<MailOrganizationView, MailCommandError>> {
  if (
    context.scope.organisationId !== input.identity.organisationId ||
    !(await isActorExecutionActive(context.storage.sql, context.scope))
  )
    return failure("connector_placement_conflict");
  if (
    input.identity.connectorId !==
      gmailConnectorIdValue(input.integrationAccountId) ||
    input.authority.organisationId !== input.identity.organisationId
  )
    return failure("mail_inbox_not_found");
  const source = await authorizeMailSource(
    context.env,
    input.authority,
    input.integrationAccountId,
  );
  if (source === null) return failure("mail_inbox_not_found");
  const head = readMailHead(context.storage.sql);
  if (head === null) {
    const organisation = await requireActiveOrganisationActor({
      env: context.env,
      organisationId: input.identity.organisationId,
      now: Date.now(),
    });
    const connection = await organisation.readTypeSafeConnectionConfiguration({
      organisationId: input.identity.organisationId,
    });
    let readiness: MailOrganizationView["readiness"] = "typesafe_unavailable";
    if (connection.ok && connection.value.authority !== null)
      readiness = (await mailInferenceEligible({
        db: context.scope.database,
        organisationId: input.identity.organisationId,
        integrationAccountId: input.integrationAccountId,
        sourcePin: source.sourcePin,
        typesafe: connection.value.authority,
        now: Date.now(),
      }))
        ? "ready"
        : "eligibility_required";
    if (!(await isActorExecutionActive(context.storage.sql, context.scope)))
      return failure("connector_placement_conflict");
    return {
      ok: true,
      value: {
        rules: { kind: "empty", revision: 0, rules: [] },
        pending: 0,
        failed: 0,
        budgetPaused: 0,
        classifications: [],
        readiness,
      },
    };
  }
  if (
    head.organisationId !== input.identity.organisationId ||
    head.integrationAccountId !== input.integrationAccountId
  )
    return failure("mail_inbox_not_found");
  const classifications =
    source.sourcePin === head.sourcePin
      ? await listMailClassifications(
          context.scope.database,
          head,
          input.messageIds,
        )
      : [];
  const readiness = await mailOrganizationReadiness(context.env, head);
  if (!(await isActorExecutionActive(context.storage.sql, context.scope)))
    return failure("connector_placement_conflict");
  return {
    ok: true,
    value: {
      rules: head.view,
      pending:
        mailPendingCount(context.storage.sql) +
        pendingInboxResponseCount(context.storage.sql),
      failed: mailFailedCount(context.storage.sql, head.classificationRevision),
      budgetPaused: mailBudgetPausedCount(context.storage.sql),
      classifications,
      readiness,
    },
  };
}
export async function manageOrganization(
  context: MailConnectorContext,
  input: CommandInput,
): Promise<Result<unknown, MailCommandError>> {
  if (
    context.scope.organisationId !== input.identity.organisationId ||
    !(await isActorExecutionActive(context.storage.sql, context.scope))
  )
    return failure("connector_placement_conflict");
  const fetcher = fetchConnectorMail.bind(
    null,
    context.storage.sql,
    context.scope,
    context.fetcher ?? runtimeFetch,
  );
  if (
    input.identity.connectorId !==
      gmailConnectorIdValue(input.integrationAccountId) ||
    input.authority.organisationId !== input.identity.organisationId
  )
    return failure("mail_inbox_not_found");
  const source = await authorizeMailSource(
    context.env,
    input.authority,
    input.integrationAccountId,
  );
  if (
    source === null ||
    input.authority.kind !== "control" ||
    (input.authority.role !== "admin" && input.authority.role !== "owner")
  )
    return failure("mail_inbox_not_found");
  if (!(await isActorExecutionActive(context.storage.sql, context.scope)))
    return failure("connector_placement_conflict");
  const head = readMailHead(context.storage.sql);
  const command = input.command;
  if (
    command.kind !== "preview" &&
    (head?.view.revision ?? 0) !== command.expectedRevision
  )
    return failure("mail_rule_revision_conflict");
  if (command.kind === "pause") {
    if (head === null || head.view.kind !== "published")
      return failure("mail_rules_inactive");
    const paused: MailOrganizationHead = {
      organisationId: head.organisationId,
      integrationAccountId: head.integrationAccountId,
      view: {
        kind: "paused",
        revision: head.view.revision + 1,
        rules: head.view.rules,
        activatedAt: head.view.activatedAt,
      },
      authority: head.authority,
      sourcePin: head.sourcePin,
      classificationRevision: head.classificationRevision,
      observation: head.observation,
      action: head.action,
    };
    context.storage.transactionSync(
      writeMailHead.bind(null, context.storage.sql, paused, Date.now()),
    );
    return { ok: true, value: paused.view };
  }
  if (command.kind === "correct") {
    if (head === null) return failure("mail_rules_inactive");
    const changed = await context.scope.database
      .prepare(
        `UPDATE mail_classification
         SET outcome = ?, source = 'operator', evaluated_at = ?
         WHERE organisation_id = ? AND integration_account_id = ?
           AND rule_revision = ? AND message_id = ? AND rule_id = ?
           AND EXISTS (
             SELECT 1 FROM organisation_placement
             WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
               AND fence_token = ? AND status = 'active'
           )`,
      )
      .bind(
        command.outcome,
        Date.now(),
        head.organisationId,
        head.integrationAccountId,
        head.classificationRevision,
        command.messageId,
        command.ruleId,
        context.scope.organisationId,
        context.scope.placement.placementEpoch,
        context.scope.placement.placementCellId,
        context.scope.fenceToken,
      )
      .run();
    return changed.meta.changes === 1
      ? { ok: true, value: { kind: "corrected" } }
      : failure("mail_classification_not_found");
  }
  if (command.kind === "classify") {
    if (head === null || head.view.kind !== "published")
      return failure("mail_rules_inactive");
    if ((await mailOrganizationReadiness(context.env, head)) !== "ready")
      return failure("mail_classification_ineligible");
    return (await queueSelectedMail({
      env: context.env,
      storage: context.storage,
      scope: context.scope,
      head,
      messageIds: command.messageIds,
    }))
      ? { ok: true, value: { kind: "queued" } }
      : failure("mail_classification_queue_unavailable");
  }
  const organisation = await requireActiveOrganisationActor({
    env: context.env,
    organisationId: input.identity.organisationId,
    now: Date.now(),
  });
  const connection = await organisation.readTypeSafeConnectionConfiguration({
    organisationId: input.identity.organisationId,
  });
  if (!connection.ok || connection.value.authority === null)
    return failure("mail_typesafe_unavailable");
  const typesafe = connection.value.authority;
  if (
    !(await mailInferenceEligible({
      db: context.scope.database,
      organisationId: input.identity.organisationId,
      integrationAccountId: input.integrationAccountId,
      sourcePin: source.sourcePin,
      typesafe,
      now: Date.now(),
    }))
  )
    return failure("mail_classification_ineligible");
  if (command.kind === "preview") {
    const classifications = [];
    const previewDigest = await digestCanonical({
      rules: command.rules,
      authority: input.authority,
      sourcePin: source.sourcePin,
      typesafe,
    });
    for (const messageId of command.messageIds) {
      const evaluationId = `preview_${await digestCanonical({ previewDigest, messageId })}`;
      if (!(await isActorExecutionActive(context.storage.sql, context.scope)))
        return failure("connector_placement_conflict");
      const result = await organisation.evaluateMailClassification({
        organisationId: input.identity.organisationId,
        integrationAccountId: input.integrationAccountId,
        evaluationId,
        revision: 1,
        messageId,
        rules: command.rules,
        authority: input.authority,
        sourcePin: source.sourcePin,
      });
      if (!(await isActorExecutionActive(context.storage.sql, context.scope)))
        return failure("connector_placement_conflict");
      if (!result.ok) return result;
      classifications.push(...result.value.classifications);
    }
    return { ok: true, value: { kind: "preview", classifications } };
  }
  let rules: readonly MailRule[];
  let classificationRevision: number;
  if (command.kind === "resume") {
    if (head === null || head.view.kind !== "paused")
      return failure("mail_rules_inactive");
    if (head.sourcePin !== source.sourcePin)
      return failure("mail_rules_republish_required");
    rules = head.view.rules;
    classificationRevision = head.classificationRevision;
  } else {
    rules = command.rules;
    classificationRevision = command.expectedRevision + 1;
  }
  const mailbox = await readEmailMailboxAccount({
    db: context.scope.database,
    organisationId: input.identity.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!mailbox.ok) return failure("mailbox_identity_required");
  const watch = await establishConnectorEmailWatch({
    env: context.env,
    storage: context.storage,
    scope: context.scope,
    integrationAccountId: input.integrationAccountId,
    now: Date.now(),
    fetcher,
  });
  if (!watch.ok) return failure("mail_watch_unavailable");
  const action = await publishedMailAction(
    context.scope,
    context.storage.sql,
    {
      organisationId: input.identity.organisationId,
      integrationAccountId: input.integrationAccountId,
    },
    rules,
    watch.value.activationFloor,
  );
  if (action === null) return failure("mail_action_mailbox_inactive");
  if (
    (readMailHead(context.storage.sql)?.view.revision ?? 0) !==
    command.expectedRevision
  )
    return failure("mail_rule_revision_conflict");
  const live = await authorizeMailSource(
    context.env,
    input.authority,
    input.integrationAccountId,
  );
  if (live === null || live.sourcePin !== source.sourcePin)
    return failure("mail_inbox_not_found");
  if (!(await isActorExecutionActive(context.storage.sql, context.scope)))
    return failure("connector_placement_conflict");
  const published: MailOrganizationHead = {
    organisationId: input.identity.organisationId,
    integrationAccountId: input.integrationAccountId,
    view: {
      kind: "published",
      revision: command.expectedRevision + 1,
      rules,
      activatedAt: Date.now(),
    },
    authority: input.authority,
    sourcePin: source.sourcePin,
    classificationRevision,
    action,
    observation: {
      kind: "watching",
      historyId: watch.value.activationFloor,
      historyPageToken: null,
      watchExpiresAt: watch.value.watchExpiresAt,
    },
  };
  context.storage.transactionSync(
    writeMailHead.bind(null, context.storage.sql, published, Date.now()),
  );
  return { ok: true, value: published.view };
}
function failure(code: string): Result<never, MailCommandError> {
  return { ok: false, error: { code } };
}
