import type { ConversationId } from "@seams/control-api";
import type { OrganisationId } from "../src/ids";
import type { CaseExecutionRoute } from "../src/control/routes/case-execution";

declare const organisationId: OrganisationId;
declare const conversationId: ConversationId;

export const chatExecutionRoute: CaseExecutionRoute = {
  kind: "case_execution",
  operation: "chat",
  organisationId,
  conversationId,
};
// @ts-expect-error A chat read must identify the conversation.
export const missingChatIdentity: CaseExecutionRoute = {
  kind: "case_execution",
  operation: "chat",
  organisationId,
};
// @ts-expect-error A caller cannot override a chat's persisted Case association.
export const mixedChatIdentity: CaseExecutionRoute = {
  kind: "case_execution",
  operation: "chat",
  organisationId,
  conversationId,
  caseId: "case_other",
};
const unrelatedCase = { caseId: "case_other" };
// @ts-expect-error A spread cannot add a second identity to a chat route.
export const spreadChatIdentity: CaseExecutionRoute = {
  ...chatExecutionRoute,
  ...unrelatedCase,
};
