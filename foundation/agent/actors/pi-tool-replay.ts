import { assertNever } from "@purin-labs/std";
import type { TSchema } from "typebox";
import type { ToolRegistry } from "@purin-labs/agent-tools/catalog/tool-registry";

/**
 * Who may run a tool call again after a lost process left it in flight.
 *
 * - `any_caller`: the call changes nothing, or its owner repeats it safely.
 * - `script`: the receipt owner answers a repeated call from its first
 *   receipt. Only a script may repeat it: a direct call keeps the rule that
 *   an operator resolves it.
 * - `none`: the outcome of a repeated call is not proven. The turn waits.
 */
type ToolRerun = "any_caller" | "script" | "none";

/** Who issued a tool call: the model, or a Code Mode script. */
export type ToolCaller = "model" | "script";

function toolRerun(registry: ToolRegistry, name: string): ToolRerun {
  const registered = registry.find(name);
  if (registered !== undefined) return registered.rerun.kind;
  return RERUN_BY_ANY_CALLER.has(name) ? "any_caller" : "none";
}

/**
 * The replay rule that Pi holds for a tool. Pi holds one rule for each tool
 * name, so a tool that only a script may repeat is `safe` here.
 * `mayRerunToolCall` keeps a direct call of such a tool stopped.
 */
function piToolReplay(registry: ToolRegistry, name: string): "safe" | "unsafe" {
  return toolRerun(registry, name) === "none" ? "unsafe" : "safe";
}

/** What the Pi harness needs to know of one tool, by its name. */
export type PiToolRules = Readonly<{
  replay: "safe" | "unsafe";
  /** A script does not get the tool. */
  modelOnly: boolean;
  /** The schema of the value that a script receives, when the tool has one. */
  structuredOutput: TSchema | undefined;
}>;

/** The rules of a tool, from the one list of the agent tools. */
export function piToolRules(registry: ToolRegistry, name: string): PiToolRules {
  const registered = registry.find(name);
  return {
    replay: piToolReplay(registry, name),
    modelOnly: registered?.modelOnly === true,
    structuredOutput: registered?.structuredOutput,
  };
}

export function mayRerunToolCall(
  registry: ToolRegistry,
  name: string,
  caller: ToolCaller,
): boolean {
  const rerun = toolRerun(registry, name);
  switch (rerun) {
    case "any_caller":
      return true;
    case "script":
      return caller === "script";
    case "none":
      return false;
    default:
      return assertNever(rerun);
  }
}

const RERUN_BY_ANY_CALLER = new Set([
  "tool_search",
  "codemode",
  // A permission request is named by its turn and its capabilities, so a
  // repeated call returns the first request and posts no second notice.
  "request_permission",
]);
