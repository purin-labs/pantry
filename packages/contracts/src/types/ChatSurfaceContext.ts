import type { ChatFileDelivery } from "./ChatFileDelivery";

export type ChatSurfaceContext = {
  kind: "slack";
  workspaceId: string;
  channelId: string;
  threadTs: string;
  threadKey: string;
  automaticReplyDelivery: boolean;
  fileDelivery: ChatFileDelivery;
};
