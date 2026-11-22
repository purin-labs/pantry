import React from "react";
import { Check } from "lucide-react";
import type { ChatEffort } from "@purin-labs/control-api";
import type { Chat } from "@purin-labs/control-api/portal/chat";
import type { ChatPageData } from "@purin-labs/control-api/portal/chat";
import {
  effortDescription,
  effortLabel,
} from "@purin-labs/ui/features/chat/effort-labels";

export function selectedModelFromData(data: ChatPageData): string | null {
  if (data.conversation !== null) return data.conversation.model;
  return data.model.kind === "ready" ? data.model.selected : null;
}

export function selectedModelFromState(
  selectedModel: string | null,
  data: ChatPageData,
): string | null {
  return selectedModel ?? selectedModelFromData(data);
}

export function selectedEffortFromData(data: ChatPageData): ChatEffort {
  if (data.conversation !== null)
    return selectedEffortFromConversation(data.conversation, data);
  if (data.model.kind !== "ready") return "medium";
  const option = data.model.options.find(
    modelOptionHasId.bind(null, data.model.selected),
  );
  return chooseSupportedEffort(null, option?.capabilities.effortOptions ?? []);
}

export function selectedEffortFromConversation(
  conversation: Chat,
  data: ChatPageData,
): ChatEffort {
  if (conversation.effort !== null) return conversation.effort;
  return selectedEffortFromModel(data, conversation.model);
}

export function selectedEffortFromState(
  selectedEffort: ChatEffort | null,
  data: ChatPageData,
): ChatEffort {
  if (selectedEffort !== null) return selectedEffort;
  return selectedEffortFromData(data);
}

function selectedEffortFromModel(
  data: ChatPageData,
  model: string,
): ChatEffort {
  if (data.model.kind !== "ready") return "medium";
  const option = data.model.options.find(modelOptionHasId.bind(null, model));
  return chooseSupportedEffort(null, option?.capabilities.effortOptions ?? []);
}

export function chooseSupportedEffort(
  preferred: ChatEffort | null,
  options: readonly ChatEffort[],
): ChatEffort {
  if (preferred !== null && options.includes(preferred)) return preferred;
  if (options.includes("medium")) return "medium";
  return options[0] ?? "medium";
}

export function renderEffortOption(
  selected: ChatEffort,
  choose: (
    effort: ChatEffort,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void,
  effort: ChatEffort,
  index: number,
): React.ReactNode {
  const selectedOption = selected === effort;
  return (
    <button
      key={effort}
      type="button"
      className="chat-model-option"
      data-selected={selectedOption ? "true" : "false"}
      aria-pressed={selectedOption}
      onClick={choose.bind(null, effort)}
    >
      <span>
        {effortLabel(effort)}
        <small>{effortDescription(effort)}</small>
      </span>
      {selectedOption ? <Check size={17} aria-hidden="true" /> : null}
      <span className="sr-only">Option {index + 1}</span>
    </button>
  );
}

export function modelName(
  data: ChatPageData,
  selectedModel: string | null,
): string | null {
  if (data.model.kind !== "ready" || selectedModel === null) return null;
  return (
    data.model.options.find(modelOptionHasId.bind(null, selectedModel))?.name ??
    null
  );
}

export function modelOptionHasId(
  id: string,
  option: { readonly id: string },
): boolean {
  return option.id === id;
}
