import type {
  ApplianceOperationState,
  ApplianceOperation,
} from "@seams/bakery-model/bakery-appliance-workflow";

declare const operation: ApplianceOperation;
// @ts-expect-error An accepted operation requires its validated recording and times.
export const missingEvidence: ApplianceOperationState = {
  kind: "accepted",
  operation,
};
// @ts-expect-error Pending operations cannot carry running-attempt state.
export const pendingTime: ApplianceOperationState = {
  kind: "pending",
  operation,
  start: 0,
};

import type { ChatConversationAccess } from "@seams/control-api";
declare const userId: import("@seams/control-api").UserId;
// @ts-expect-error Workspace chats require a bound canvas identity.
export const missingCanvasChat: ChatConversationAccess = {
  kind: "workspace_canvas",
};
// @ts-expect-error A workspace chat cannot also have private ownership.
export const privateWorkspaceChat: ChatConversationAccess = {
  kind: "workspace_canvas",
  documentId: "run:test",
  ownerUserId: userId,
};
const privateFields = { ownerUserId: userId };
// @ts-expect-error Spreads cannot mix private and workspace access.
export const spreadWorkspaceChat: ChatConversationAccess = {
  ...privateFields,
  kind: "workspace_canvas",
  documentId: "run:test",
};

import type { CanvasChatSelection } from "../src/chat/workspace-canvas";
declare const conversationId: import("@seams/control-api").ConversationId;
// @ts-expect-error Historical reads require an exact conversation identity.
export const missingHistoryIdentity: CanvasChatSelection = { kind: "history" };
// @ts-expect-error Current and historical selection cannot be combined.
export const mixedCanvasSelection: CanvasChatSelection = {
  kind: "current",
  conversationId,
};
