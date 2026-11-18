import type {
  ChatConversationAccess,
  ProjectAccess,
} from "../../../packages/control-api/src/project-access";
import type {
  ProjectId,
  ConversationId,
  UserId,
} from "../../../packages/control-api/src/ids";

declare const userId: UserId;
declare const projectId: ProjectId;
declare const conversationId: ConversationId;

const personal: ProjectAccess = {
  kind: "personal",
  ownerUserId: userId,
  accessRevision: 0,
};
const shared: ProjectAccess = {
  kind: "shared",
  role: "viewer",
  accessRevision: 1,
};
const sharedChat: ChatConversationAccess = {
  kind: "shared",
  sharedProjectId: projectId,
};

// @ts-expect-error Shared projects derive ownership from memberships.
const contradictoryProject: ProjectAccess = {
  ...shared,
  ownerUserId: userId,
};
// @ts-expect-error A shared conversation requires a project.
const ungroupedShared: ChatConversationAccess = { kind: "shared" };
// @ts-expect-error Shared conversations cannot also have a private owner.
const contradictoryChat: ChatConversationAccess = {
  ...sharedChat,
  ownerUserId: userId,
};
const wrongProject: ChatConversationAccess = {
  kind: "shared",
  // @ts-expect-error Conversation IDs cannot identify projects.
  sharedProjectId: conversationId,
};
const rawOwner: ChatConversationAccess = {
  kind: "private",
  // @ts-expect-error Raw strings cannot identify users.
  ownerUserId: "user_unvalidated",
};

void [
  personal,
  shared,
  sharedChat,
  contradictoryProject,
  ungroupedShared,
  contradictoryChat,
  wrongProject,
  rawOwner,
];
