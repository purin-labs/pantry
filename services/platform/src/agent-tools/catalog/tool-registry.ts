import type { AnyRegisteredTool } from "../define-tool";

/**
 * The tools that the Worker registers, in the order of the catalog. The
 * session pins a digest of the model definitions in this order, so a new
 * tool goes where its family's list puts it, and no tool moves.
 */
export type ToolRegistry = {
  readonly tools: readonly AnyRegisteredTool[];
  readonly find: (name: string) => AnyRegisteredTool | undefined;
};

export function createToolRegistry(
  tools: readonly AnyRegisteredTool[],
): ToolRegistry {
  const byName = new Map<string, AnyRegisteredTool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`${tool.name} is registered twice`);
    }
    byName.set(tool.name, tool);
  }
  return { tools, find: (name) => byName.get(name) };
}

/**
 * A tool that one turn adds to the catalog from data, for example one
 * operation of a custom connector. The pin enters the catalog digest: it
 * names the revisions that the definition came from.
 */
export type TurnTool = Readonly<{
  tool: AnyRegisteredTool;
  pin: Readonly<Record<string, unknown>>;
}>;

/**
 * The services that one turn gives to the tools, by family name. Each
 * family's area declares the type of its services; the registry file gives
 * the type of the whole set.
 */
export type ToolServiceSet = Readonly<Record<string, object | undefined>>;

/** The handler of a tool for one turn, or undefined when the turn has none. */
export function toolHandler(tool: AnyRegisteredTool, services: ToolServiceSet) {
  // Each tool reads only the services of its own family, and each field of
  // them may be absent, so an absent family is an empty one.
  return tool.handler((services[tool.family] ?? {}) as never);
}
