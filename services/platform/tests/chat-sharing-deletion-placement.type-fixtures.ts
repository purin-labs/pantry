import type { UnitTestEnv } from "./worker-fakes";
import {
  shareConversation,
  type ConversationSharingCommand,
} from "../src/chat/conversation-sharing";
import { mutateProjectAccess } from "../src/projects/membership";
import {
  deleteArchivedChat,
  type ChatDeletionCommand,
} from "../src/chat/deletion";
import type {
  ProjectAccessCommand,
  ProjectId,
  ConversationId,
} from "@seams/control-api";
import type { ConversationScope } from "../src/chat/store";
import type { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import { forkChat, type ChatForkCommand } from "../src/chat/forks";
import type { RequestAuthority } from "@seams/contracts";
import type { Variant } from "@seams/type-utils";

declare const env: UnitTestEnv;
declare const identity: ConversationScope;
declare const placement: OrganisationExecutionScope;
declare const conversationId: ConversationId;
declare const projectId: ProjectId;
declare const sharing: ConversationSharingCommand;
declare const membership: ProjectAccessCommand;
declare const deletion: ChatDeletionCommand;
declare const fork: ChatForkCommand;
declare const authority: Variant<RequestAuthority, "control">;

// @ts-expect-error Fork journals require captured execution authority.
forkChat(env, identity, identity.userId, authority, conversationId, fork);
forkChat(
  env,
  // @ts-expect-error A spread cannot carry the captured placement authority.
  { ...placement },
  identity.userId,
  authority,
  conversationId,
  fork,
);

// @ts-expect-error Identity alone cannot authorize a sharing transaction.
shareConversation(env, identity, identity.userId, conversationId, sharing);
// @ts-expect-error Identity alone cannot authorize a membership transaction.
mutateProjectAccess(env, identity, identity.userId, projectId, membership);
// @ts-expect-error Deletion must retain its captured placement through cleanup.
deleteArchivedChat(env, identity, identity.userId, conversationId, deletion);
deleteArchivedChat(
  env,
  // @ts-expect-error A spread loses private execution authority.
  { ...placement },
  identity.userId,
  conversationId,
  deletion,
);
