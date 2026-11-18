import type { Env } from "../env";
import { authorizeMailSource } from "./authorization";
import { readMailHead } from "./store";
import { readMailResponseOwner } from "./response-store";

type MailResponseScope = Readonly<{
  organisationId: string;
  integrationAccountId: string;
  threadId: string;
  caseId: string;
  messageIds: readonly string[];
  mailboxBindingId: string;
  bindingRevision: number;
  policyVersion: number;
}>;

export function cueOwnsResponse(
  sql: SqlStorage,
  scope: MailResponseScope,
): boolean {
  for (const messageId of scope.messageIds) {
    const owner = readMailResponseOwner(sql, messageId);
    if (
      owner === null ||
      owner.kind !== "cue" ||
      owner.threadId !== scope.threadId
    )
      return false;
  }
  return true;
}

export async function inboxOwnsResponse(
  env: Env,
  sql: SqlStorage,
  scope: MailResponseScope,
): Promise<boolean> {
  const head = readMailHead(sql);
  if (
    head === null ||
    head.view.kind !== "published" ||
    head.action.kind !== "supplier_delay" ||
    head.organisationId !== scope.organisationId ||
    head.integrationAccountId !== scope.integrationAccountId ||
    head.action.mailboxBindingId !== scope.mailboxBindingId ||
    head.action.bindingRevision !== scope.bindingRevision ||
    head.action.policyVersion !== scope.policyVersion
  )
    return false;
  for (const messageId of scope.messageIds) {
    const owner = readMailResponseOwner(sql, messageId);
    if (
      owner === null ||
      owner.kind !== "inbox" ||
      owner.threadId !== scope.threadId ||
      owner.ruleRevision !== head.view.revision ||
      owner.ruleId !== head.action.ruleId ||
      owner.state.kind !== "processing" ||
      owner.state.caseId !== scope.caseId
    )
      return false;
  }
  const source = await authorizeMailSource(
    env,
    head.authority,
    head.integrationAccountId,
  );
  const current = readMailHead(sql);
  return (
    source !== null &&
    source.sourcePin === head.sourcePin &&
    current !== null &&
    current.view.kind === "published" &&
    current.view.revision === head.view.revision
  );
}
