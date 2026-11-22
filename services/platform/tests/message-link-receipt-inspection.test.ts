/// <reference types="@cloudflare/workers-types" />

import { describe, expect, test } from "vitest";

import { inspectLatestMessageLinkReceipt } from "@purin-labs/agent/actors/message-link-receipt-inspection";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

const RESULT_DIGEST = "a".repeat(64);
const ENTRY_DIGEST = "b".repeat(64);

describe("message link receipt inspection", function messageLinkReceiptInspectionSuite() {
  test("returns the latest digest-bound refusal without exposing its URL", function inspectsRefusal() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createHistoryTable(sql);

    expect(inspectLatestMessageLinkReceipt(sql, "session_receipt")).toEqual({
      kind: "none",
    });

    const payload = JSON.stringify({
      version: 1,
      entry: {
        kind: "tool_result",
        turn: {
          turnId: "turn_receipt",
          inputId: "input_receipt",
          turnLeaseGeneration: 1,
          budgetRevision: "budget_receipt",
        },
        callId: "call_receipt",
        tool: "read_message_link",
        outcome: {
          kind: "succeeded",
          output: {
            kind: "inline",
            content: [
              {
                kind: "text",
                text: JSON.stringify({
                  output: "redacted",
                  success: true,
                  code_mode_value: {
                    outcome: "refused",
                    reason: {
                      code: "destination_not_public",
                      reason: "loopback",
                    },
                    url: "http://127.0.0.1/private",
                  },
                  metadata: null,
                  process_trace: null,
                }),
              },
            ],
            digest: RESULT_DIGEST,
          },
        },
        authority: { kind: "read", resultDigest: RESULT_DIGEST },
        acceptedAt: 40,
      },
    });
    sql.exec(
      `INSERT INTO session_harness_history (
         session_id, sequence, entry_digest, payload, accepted_at
       ) VALUES (?, ?, ?, ?, ?)`,
      "session_receipt",
      7,
      ENTRY_DIGEST,
      payload,
      40,
    );

    const inspected = inspectLatestMessageLinkReceipt(sql, "session_receipt");
    expect(inspected).toEqual({
      kind: "accepted",
      turnId: "turn_receipt",
      callId: "call_receipt",
      sequence: 7,
      entryDigest: ENTRY_DIGEST,
      acceptedAt: 40,
      toolStatus: "succeeded",
      authority: { kind: "read", resultDigest: RESULT_DIGEST },
      result: {
        kind: "refused",
        code: "destination_not_public",
        reason: "loopback",
      },
    });
    expect(JSON.stringify(inspected)).not.toContain("127.0.0.1");
  });
});

function createHistoryTable(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE session_harness_history (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      entry_digest TEXT NOT NULL,
      payload TEXT NOT NULL,
      accepted_at INTEGER NOT NULL
    )`,
  );
}
