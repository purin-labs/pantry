import type { ChatEffort } from "@purin-labs/control-api";

/** The names of the reasoning efforts in Portal chat and for Slack answers. */
export function effortLabel(effort: ChatEffort): string {
  switch (effort) {
    case "low":
      return "Fast";
    case "medium":
      return "Balanced";
    case "high":
      return "Deep reasoning";
  }
}

export function effortDescription(effort: ChatEffort): string {
  switch (effort) {
    case "low":
      return "Use less time for simple tasks.";
    case "medium":
      return "A balanced speed and depth.";
    case "high":
      return "Spend more time on complex work.";
  }
}
