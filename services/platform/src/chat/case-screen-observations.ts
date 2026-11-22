import type { CaseScreenObservationView } from "@purin-labs/control-api";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { VISIBLE_CONVERSATIONS_SQL } from "./conversation-access";
import { parseConversation } from "./conversation";
import type { ConversationScope } from "./store";

const MAX_OBSERVATIONS = 200;

/**
 * The pages that the agent of one Case received from a person's screen
 * (Plan 87 phase 5), newest first. It reads the Portal chats of the Case
 * that the reader may see, and each message's observation as the message
 * stored it after its admission, so a page that the chat's readers could not
 * receive is not there. It returns no value from the page.
 */
export async function readCaseScreenObservations(
  db: OrganisationDatabase,
  scope: ConversationScope,
  caseId: string,
): Promise<readonly CaseScreenObservationView[]> {
  const rows = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL} SELECT state_json FROM visible_conversation WHERE case_id = ?`,
    )
    .bind(scope.organisationId, scope.userId, caseId)
    .all<{ state_json: unknown }>();
  const observations: CaseScreenObservationView[] = [];
  for (const row of rows.results) {
    if (typeof row.state_json !== "string") continue;
    const conversation = parseConversation(JSON.parse(row.state_json));
    for (const event of conversation.timeline) {
      if (event.kind !== "user") continue;
      for (const part of event.parts) {
        if (part.kind !== "surface_observation") continue;
        const observation = part.observation;
        observations.push({
          page: observation.title,
          area: observation.area,
          record: observation.record?.label ?? null,
          capturedAt: observation.capturedAt,
          sentAt: event.createdAt,
          sources: observation.sources,
        });
      }
    }
  }
  return observations
    .sort((left, right) => right.sentAt - left.sentAt)
    .slice(0, MAX_OBSERVATIONS);
}
