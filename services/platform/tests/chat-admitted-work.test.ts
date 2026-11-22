import { expect, it } from "vitest";
import {
  holdsAdmittedWork,
  type ConversationStream,
  type ConversationWork,
} from "../src/chat/conversation";
import { parseSessionId } from "@purin-labs/kernel/ids";

it("keeps a chat in its Project while a retryable turn or a queued message remains", function admittedWork() {
  const sessionId = parseSessionId("session_admitted_work");
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const stream: ConversationStream = {
    step: 0,
    sessionId: sessionId.value,
    turnId: "turn_admitted_work",
  };

  expect(holdsAdmittedWork({ kind: "ready" }, 0)).toBe(false);
  expect(holdsAdmittedWork({ kind: "ready" }, 1)).toBe(true);
  expect(holdsAdmittedWork(failed(null), 0)).toBe(true);
  expect(
    holdsAdmittedWork(
      failed({ kind: "interrupted", lease: "lease", stream }),
      0,
    ),
  ).toBe(true);
  // A turn stopped at the storage limit cannot run again.
  expect(
    holdsAdmittedWork(
      failed({ kind: "projection_capacity", lease: "lease", stream }),
      0,
    ),
  ).toBe(false);
});

type FailedWork = Extract<ConversationWork, { kind: "failed" }>;

function failed(recovery: FailedWork["recovery"]): FailedWork {
  return { kind: "failed", requestId: "request", error: "Stopped.", recovery };
}
