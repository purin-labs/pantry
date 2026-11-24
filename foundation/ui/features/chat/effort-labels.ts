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

/**
 * The hint under each effort. A new Portal chat starts on Balanced, so its
 * hint says that. Slack answers start on "Standard", the level of the
 * source, so the Slack hint for Balanced does not claim the default.
 */
export function effortDescription(
  effort: ChatEffort,
  surface: "chat" | "slack",
): string {
  switch (effort) {
    case "low":
      return "Use less time for simple tasks.";
    case "medium":
      return surface === "chat"
        ? "The default for most tasks."
        : "A balanced speed and depth.";
    case "high":
      return "Spend more time on complex work.";
  }
}
