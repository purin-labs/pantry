import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { http, type HttpResponseResolver } from "msw";

import { createPiDurableAdapter } from "../../src/actors/pi-durable-runtime";
import {
  admitSteeringInput,
  readSteeringInput,
} from "../../src/actors/harness-steering";
import type {
  EmbeddedHarnessConstructionInput,
  EmbeddedHarnessUserInput,
} from "../../src/actors/embedded-harness";
import { toHistoryContent } from "../../src/actors/pi-user-input";
import type { UserMessage } from "@seams/contracts";
import { RecordingBoundary, sdkInput } from "./pi-sdk-support";
import { openRouterText } from "./slack-journey-support";
import { network } from "./network";

/**
 * A steering input that reaches Pi after the run ended must not start a new
 * run outside the turn's lease (Plan 71).
 *
 * The turn finishes, and the Session has admitted a steering input that it
 * gives to Pi only now. Pi would place the input at once and start a new run.
 * The acceptance hook refuses that commit: the steer is refused, no model
 * request follows, and the transcript keeps one user input.
 */
it("refuses a steering input that reaches Pi after the run ended", async ({
  task,
}) => {
  const boundary = new RecordingBoundary();
  const input = sdkInput(boundary, [], "direct");
  const requests: unknown[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      reply.bind(null, requests),
    ),
  );
  const result = await runInDurableObject(
    env.SESSION.getByName("pi-native-steering-after-run"),
    steerAfterRun.bind(null, input, boundary),
  );
  expect(result.steered).toEqual({
    ok: true,
    value: { kind: "refused", reason: "turn_not_running" },
  });
  expect(requests).toHaveLength(1);
  expect(result.state).toBe("admitted");
  expect(result.userInputs).toBe(1);
  Object.assign(task.meta, { piNativeSteeringAfterRun: result });
});

const LATE_TEXT = "Also check the dairy supplier.";
const LATE: readonly EmbeddedHarnessUserInput[] = [
  { kind: "text", text: LATE_TEXT },
];
// The surface builds this message; the brand only marks the text as checked.
const LATE_MESSAGE = {
  firstPart: { kind: "text", text: LATE_TEXT },
  remainingParts: [],
} as unknown as UserMessage;

async function steerAfterRun(
  input: EmbeddedHarnessConstructionInput,
  boundary: RecordingBoundary,
  _actor: unknown,
  state: DurableObjectState,
) {
  const runtime = createPiDurableAdapter(input.model).construct({
    ...input,
    persistence: {
      kind: "actor",
      storage: state.storage,
      preflight: acceptedFixtureLease,
    },
  });
  if (!runtime.ok) throw new Error(runtime.error.code);
  try {
    const started = await runtime.value.startTurn([
      { kind: "text", text: "Check the flour supplier." },
    ]).completion;
    if (!started.ok) throw new Error(started.error.code);
    const completed = await started.value.complete();
    if (!completed.ok) throw new Error(completed.error.code);
    // The Session admits the input as it does before it calls the harness.
    admitSteeringInput(state.storage.sql, {
      sessionId: String(input.sessionId),
      turnId: String(input.turnLease.turn.turnId),
      inputId: "steer_after_run",
      requestId: "request_after_run",
      inputRef: { ...input.acceptedInput, inputId: "steer_after_run" },
      content: LATE.map(toHistoryContent),
      message: LATE_MESSAGE,
      admittedAt: Date.now(),
    });
    const steered = await started.value.steer({
      inputId: "steer_after_run",
      input: LATE,
    });
    // A run that had started would send its model request in this time.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      steered,
      state:
        readSteeringInput(
          state.storage.sql,
          String(input.sessionId),
          "steer_after_run",
        )?.state ?? null,
      userInputs: boundary.entries.filter(isUserInput).length,
    };
  } finally {
    await runtime.value.close();
  }
}

function acceptedFixtureLease(): void {}

function isUserInput(entry: RecordingBoundary["entries"][number]): boolean {
  return entry.kind === "user_input";
}

async function reply(
  requests: unknown[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  requests.push(await request.json());
  if (requests.length > 1) throw new Error("A run started after the turn");
  return openRouterText("RUN_FINISHED", "run_finished");
}
