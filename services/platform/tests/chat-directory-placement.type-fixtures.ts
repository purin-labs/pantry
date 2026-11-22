import { mutateChatDirectory } from "../src/chat/projects";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { ConversationScope } from "../src/chat/store";
import type { ChatDirectoryCommand } from "@purin-labs/control-api";

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
