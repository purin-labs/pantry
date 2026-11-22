import type { ConversationId } from "@purin-labs/control-api";
import {
  parseControlSessionId,
  parseOrganisationId,
  type ControlSessionId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import type { ConversationScope } from "./store";
import { isConversationId } from "@purin-labs/control-api";

export type ConversationExecution = {
  readonly scope: ConversationScope;
  readonly conversationId: ConversationId;
  readonly controlSessionId: ControlSessionId;
};

export function createConversationExecutionSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS portal_conversation_execution (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    wake_id TEXT NOT NULL, organisation_id TEXT NOT NULL, user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL, control_session_id TEXT NOT NULL
  )`);
}

export function persistConversationExecution(
  sql: SqlStorage,
  input: ConversationExecution,
): void {
  sql.exec(
    `INSERT OR REPLACE INTO portal_conversation_execution
    (singleton, wake_id, organisation_id, user_id, conversation_id, control_session_id)
    VALUES (1, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    input.scope.organisationId,
    input.scope.userId,
    input.conversationId,
    input.controlSessionId,
  );
}

export function readConversationExecution(
  sql: SqlStorage,
): (ConversationExecution & { readonly wakeId: string }) | null {
  const row = sql
    .exec(`SELECT * FROM portal_conversation_execution WHERE singleton = 1`)
    .toArray()[0];
  if (row === undefined) return null;
  const organisationId =
    typeof row.organisation_id === "string" ? parseOrganisationId(row.organisation_id) : null;
  const identity =
    typeof row.user_id === "string"
      ? parseUserId(row.user_id)
      : null;
  const session =
    typeof row.control_session_id === "string"
      ? parseControlSessionId(row.control_session_id)
      : null;
  if (
    !organisationId?.ok ||
    !identity?.ok ||
    !session?.ok ||
    typeof row.wake_id !== "string" ||
    typeof row.conversation_id !== "string" ||
    !isConversationId(row.conversation_id)
  )
    throw new Error("chat_execution_invalid");
  return {
    wakeId: row.wake_id,
    conversationId: row.conversation_id,
    controlSessionId: session.value,
    scope: { organisationId: organisationId.value, userId: identity.value },
  };
}
