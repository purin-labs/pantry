import type { ConversationMetadata } from "../src/chat/store";

const active: ConversationMetadata = {
  lifecycle: "active",
  pinnedAt: null,
};
const archived: ConversationMetadata = {
  lifecycle: "archived",
  pinnedAt: null,
  archivedAt: 1,
};

// @ts-expect-error Archived chats require the time they were archived.
const archivedWithoutTimestamp: ConversationMetadata = { lifecycle: "archived", pinnedAt: null };
const archivedAndPinned: ConversationMetadata = { lifecycle: "archived", pinnedAt: 1, archivedAt: 1 };
// @ts-expect-error Active chats cannot carry archived metadata.
const activeWithArchiveTimestamp: ConversationMetadata = { lifecycle: "active", pinnedAt: null, archivedAt: 1 };

void active;
void archived;
void archivedWithoutTimestamp;
void archivedAndPinned;
void activeWithArchiveTimestamp;
