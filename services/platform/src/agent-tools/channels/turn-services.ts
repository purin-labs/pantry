import type { ToolTurnContext } from "../../actors/session/tool-wiring";
import { withToolContext } from "../context";
import {
  editEmailDraftForEmbeddedHarness,
  readEmailDraftForEmbeddedHarness,
} from "./email-draft-handlers";
import {
  editEmailReplyDraftForEmbeddedHarness,
  proposeEmailOperationalForEmbeddedHarness,
  proposeEmailReplyForEmbeddedHarness,
  readEmailReplyDraftForEmbeddedHarness,
  readWhatsAppSupportForEmbeddedHarness,
  searchEmailMailboxForEmbeddedHarness,
  sendWhatsAppSupportReplyForEmbeddedHarness,
} from "./handlers";
import type { ChannelToolServices } from "./services";

/** What the Inbox gives to one turn: the services of the channel tools. */
export function channelToolServices(
  turn: ToolTurnContext,
): ChannelToolServices {
  const tool = withToolContext(turn);
  return {
    readEmailDraft: tool(readEmailDraftForEmbeddedHarness),
    editEmailDraft: tool(editEmailDraftForEmbeddedHarness),
    searchEmailMailbox: tool(searchEmailMailboxForEmbeddedHarness),
    proposeEmailReply: tool(proposeEmailReplyForEmbeddedHarness),
    readEmailReplyDraft: tool(readEmailReplyDraftForEmbeddedHarness),
    editEmailReplyDraft: tool(editEmailReplyDraftForEmbeddedHarness),
    proposeEmailOperational: tool(proposeEmailOperationalForEmbeddedHarness),
    readWhatsAppSupport: tool(readWhatsAppSupportForEmbeddedHarness),
    sendWhatsAppSupportReply: sendWhatsAppSupportReplyForEmbeddedHarness.bind(
      null,
      turn.env,
      turn.execution,
      turn.lease,
      turn.assignment,
      turn.turnPrompt,
    ),
  };
}
