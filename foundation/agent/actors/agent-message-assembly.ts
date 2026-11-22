import type { Result } from "@purin-labs/kernel/result";

type AgentMessageAssemblyState = {
  readonly canonicalText: string;
  readonly currentMessageText: string;
};

type AgentMessageAssemblyEvent =
  | { readonly kind: "delta"; readonly text: string }
  | { readonly kind: "completed"; readonly text: string };

type AgentMessageAssemblyUpdate = {
  readonly state: AgentMessageAssemblyState;
  readonly appendedText: string;
};

export function applyAgentMessageAssemblyEvent(
  state: AgentMessageAssemblyState,
  event: AgentMessageAssemblyEvent,
): Result<
  AgentMessageAssemblyUpdate,
  { readonly code: "provider_message_text_mismatch" }
> {
  switch (event.kind) {
    case "delta":
      return {
        ok: true,
        value: {
          state: {
            canonicalText: `${state.canonicalText}${event.text}`,
            currentMessageText: `${state.currentMessageText}${event.text}`,
          },
          appendedText: event.text,
        },
      };
    case "completed":
      return completeAgentMessage(state, event.text);
  }
}

function completeAgentMessage(
  state: AgentMessageAssemblyState,
  text: string,
): Result<
  AgentMessageAssemblyUpdate,
  { readonly code: "provider_message_text_mismatch" }
> {
  if (state.currentMessageText === "") {
    return {
      ok: true,
      value: {
        state: {
          canonicalText: `${state.canonicalText}${text}`,
          currentMessageText: "",
        },
        appendedText: text,
      },
    };
  }
  return state.currentMessageText === text
    ? {
        ok: true,
        value: {
          state: { canonicalText: state.canonicalText, currentMessageText: "" },
          appendedText: "",
        },
      }
    : { ok: false, error: { code: "provider_message_text_mismatch" } };
}
