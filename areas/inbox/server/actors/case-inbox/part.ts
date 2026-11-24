import { gmailConnectorIdValue } from "@purin-labs/area-inbox-contract/server/connector-ids";
import { whatsappConnectorIdValue } from "../../data/whatsapp";
import type { CaseInboxPart } from "@purin-labs/conversation/actors/case/parts";

/** The Inbox part of the Case: the Connector of a mailbox or a WhatsApp number. */
export const caseInboxPart: CaseInboxPart = {
  triggerConnectorId(authority) {
    return authority.kind === "agent_mailbox"
      ? gmailConnectorIdValue(authority.integrationAccountId)
      : whatsappConnectorIdValue(authority.integrationAccountId);
  },
};
