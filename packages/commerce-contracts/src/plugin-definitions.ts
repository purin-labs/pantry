// The rules of a plugin definition and of a plugin set (Plan 77 step 3).
// Each problem is one sentence that names the plugin.
import type { PluginDefinition } from "./records/plugins.ts";

const PLUGIN_ID = /^[a-z0-9_]{2,64}$/u;

/** The problems of one definition, without the other plugins of its set. */
export function pluginProblems(plugin: PluginDefinition): string[] {
  const id = plugin.pluginId;
  const problems: string[] = [];
  if (!PLUGIN_ID.test(id))
    problems.push(`${id}: the identifier is not lower snake case`);
  if (plugin.version === 0) problems.push(`${id}: versions start at 1`);
  if (plugin.title.trim() === "" || plugin.purpose.trim() === "")
    problems.push(`${id}: the title and purpose must not be empty`);
  const contributions = plugin.contributions;
  switch (plugin.kind) {
    case "built_in":
      if (contributions.functions.length > 0 || plugin.limits !== undefined)
        problems.push(`${id}: a built-in plugin has no functions or limits`);
      break;
    case "merchant":
      if (
        contributions.routes.length > 0 ||
        contributions.pipelineSteps.length > 0
      )
        problems.push(
          `${id}: a merchant plugin owns no routes or pipeline steps`,
        );
      if (plugin.limits === undefined)
        problems.push(`${id}: a merchant plugin needs limits`);
      break;
  }
  for (const definition of contributions.functions)
    if (!plugin.requirements.hookPoints.includes(definition.hookPoint))
      problems.push(
        `${id}.${definition.functionId}: its hook point is not in the requirements`,
      );
  if (plugin.requirements.dependsOn.includes(id))
    problems.push(`${id}: a plugin cannot depend on itself`);
  return problems;
}

/**
 * The problems of a set of plugins: each definition's own, a repeated
 * identifier, a route that two plugins own, and a dependency that is missing
 * or circular.
 */
export function pluginSetProblems(
  plugins: readonly PluginDefinition[],
): string[] {
  const problems = plugins.flatMap(pluginProblems);
  const ids = new Set<string>();
  const routes = new Map<string, string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.pluginId))
      problems.push(`${plugin.pluginId}: the identifier is used twice`);
    ids.add(plugin.pluginId);
    for (const route of plugin.contributions.routes) {
      const owner = routes.get(route);
      if (owner !== undefined)
        problems.push(
          `${route}: owned by both ${owner} and ${plugin.pluginId}`,
        );
      routes.set(route, plugin.pluginId);
    }
  }
  for (const plugin of plugins) {
    for (const dependency of plugin.requirements.dependsOn)
      if (!ids.has(dependency))
        problems.push(
          `${plugin.pluginId}: depends on ${dependency}, which does not exist`,
        );
    // A plugin that reaches itself through its dependencies is circular.
    const pending = [...plugin.requirements.dependsOn];
    const visited = new Set<string>();
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (next === plugin.pluginId) {
        problems.push(`${plugin.pluginId}: its dependencies are circular`);
        break;
      }
      if (visited.has(next)) continue;
      visited.add(next);
      const found = plugins.find((candidate) => candidate.pluginId === next);
      if (found !== undefined) pending.push(...found.requirements.dependsOn);
    }
  }
  return problems;
}
