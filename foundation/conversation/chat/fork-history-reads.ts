import type { ChatForkHistoryReads } from "@purin-labs/agent/chat/fork-history";

// The read of the chat forks that the agent module makes when it collects
// the attachments that a fork still holds (Refactor 17). The Worker
// registers it (`worker-ports.ts`). It is one D1 read and writes nothing.

export const CHAT_FORK_HISTORY_READS: ChatForkHistoryReads = {
  async listOpenChatForkHistories(db, organisationId) {
    const rows = await db
      .prepare(
        "SELECT history_json, digest FROM portal_chat_fork WHERE organisation_id = ? AND status IN ('prepared', 'ready')",
      )
      .bind(organisationId)
      .all<{ history_json: string; digest: string }>();
    return rows.results.map((row) => ({
      historyJson: row.history_json,
      digest: row.digest,
    }));
  },
};
