import { mutateChatDirectory } from "../src/chat/projects";
import type { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import type { ConversationScope } from "../src/chat/store";
import type { ChatDirectoryCommand } from "@seams/control-api";

declare const placement: OrganisationExecutionScope;
declare const conversation: ConversationScope;
declare const command: ChatDirectoryCommand;

// @ts-expect-error Organisation/user identity alone cannot authorize a directory write.
mutateChatDirectory(conversation, conversation.userId, command, 1);
mutateChatDirectory(
  // @ts-expect-error A spread cannot copy the private execution-scope identity.
  { ...placement },
  conversation.userId,
  command,
  1,
);
