
export type ConnectorAddress =
  | { kind: "slack"; workspaceId: string; channelId: string; threadTs: string }
  | { kind: "slack_channel"; workspaceId: string; channelId: string }
  | {
      kind: "email_thread";
      integrationAccountId: string;
      gmailThreadId: string;
    }
  | {
      kind: "whatsapp_conversation";
      integrationAccountId: string;
      waId: string;
    };
