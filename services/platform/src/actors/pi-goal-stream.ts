import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  GoalModelCallControl,
  GoalModelCallTicket,
} from "./goal-model-calls";
import type { Variant } from "@seams/type-utils";
import type { PiModelResponse } from "./pi-model-transport";
import { errorStatusWithoutTokens } from "./pi-durable-stream";

type Tracked = Variant<GoalModelCallControl, "tracked">;

export function accountPiGoalStream(
  source: AssistantMessageEventStream,
  control: Tracked,
  ticket: GoalModelCallTicket,
  model: Model<Api>,
  response: PiModelResponse,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void forwardGoalStream(source, output, control, ticket, response).catch(
    failGoalStream.bind(null, output, model),
  );
  return output;
}

async function forwardGoalStream(
  source: AssistantMessageEventStream,
  output: AssistantMessageEventStream,
  control: Tracked,
  ticket: GoalModelCallTicket,
  response: PiModelResponse,
): Promise<void> {
  for await (const event of source) {
    if (event.type === "done") {
      if (
        !Number.isSafeInteger(event.message.usage.totalTokens) ||
        event.message.usage.totalTokens <= 0
      ) {
        await control.settle(ticket, { kind: "unknown" });
        throw new Error("goal_model_usage_missing");
      }
      try {
        await control.settle(ticket, {
          kind: "reported",
          tokens: event.message.usage.totalTokens,
          activeTimeMs: Math.max(0, Date.now() - ticket.startedAt),
        });
      } catch {
        throw new GoalUsagePersistenceError(event.message);
      }
      output.push(event);
      output.end(event.message);
      return;
    }
    if (event.type === "error") {
      await control.settle(
        ticket,
        errorStatusWithoutTokens(response, event.error)
          ? {
              kind: "reported",
              tokens: 0,
              activeTimeMs: Math.max(0, Date.now() - ticket.startedAt),
            }
          : { kind: "unknown" },
      );
      output.push(event);
      output.end(event.error);
      return;
    }
    output.push(event);
  }
  await control.settle(ticket, { kind: "unknown" });
  throw new Error("goal_model_response_missing");
}

class GoalUsagePersistenceError extends Error {
  constructor(readonly response: AssistantMessage) {
    super("goal_usage_settlement_failed");
  }
}

function failGoalStream(
  output: AssistantMessageEventStream,
  model: Model<Api>,
  error: unknown,
): void {
  const message: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    stopReason: "error",
    errorMessage: "goal_usage_settlement_failed",
    timestamp: Date.now(),
    usage:
      error instanceof GoalUsagePersistenceError
        ? error.response.usage
        : {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
  };
  output.push({ type: "error", reason: "error", error: message });
  output.end(message);
}
