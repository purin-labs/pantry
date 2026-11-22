import type { StoredConversation } from "@purin-labs/conversation/chat/store";

declare const stored: StoredConversation;

// A wire projection cannot construct a durable conversation without its address.
// @ts-expect-error StoredConversation requires the persisted Actor identity.
const missingAddress: StoredConversation = {
  conversation: stored.conversation,
  sharing: stored.sharing,
  revision: stored.revision,
  metadata: stored.metadata,
  placement: stored.placement,
};

const { actorIdentity, ...projection } = stored;
// @ts-expect-error Spreading a projection cannot discard the durable address.
const spreadWithoutAddress: StoredConversation = { ...projection };

void [actorIdentity, missingAddress, spreadWithoutAddress];
