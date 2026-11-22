import { modelToolDefinition } from "../define-tool";
import { sha256Hex } from "@purin-labs/std";
import {
  missingRequestableCapabilities,
  permissionRequestDefinition,
} from "./permission";
import type { ToolRegistry } from "./tool-registry";
import type {
  HarnessCapabilityName,
  HarnessCatalogSelection,
  HarnessToolDefinition,
} from "./types";

export type JsonSchema = Readonly<Record<string, unknown>>;

export function catalogHarnessToolCatalogDigest(
  registry: ToolRegistry,
  selection: HarnessCatalogSelection = {
    allowedCapabilities: harnessBaseCapabilities(registry),
  },
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      definitions: selectCatalogDefinitions(registry, selection),
      // The key keeps its name: it is part of the pinned digest. The first
      // turn tools were the operations of custom connectors.
      customConnectorPins: (selection.turnTools ?? []).map(({ pin }) => pin),
    }),
  );
}

/** The capabilities of the registered tools, each one time, in catalog order. */
export function harnessBaseCapabilities(
  registry: ToolRegistry,
): readonly HarnessCapabilityName[] {
  const capabilities = new Set<HarnessCapabilityName>();
  for (const tool of registry.tools) {
    if (tool.selection.kind === "capability") {
      capabilities.add(tool.selection.capability);
    }
  }
  return Object.freeze([...capabilities]);
}

export function isSelectedCatalogToolName(
  definitions: readonly HarnessToolDefinition[],
  name: string,
): name is HarnessToolDefinition["name"] {
  return definitions.some((definition) => definition.name === name);
}

/**
 * The model definitions of one turn: the capability tools that the turn
 * holds, then the surface tools whose command the attached page installs,
 * then the tools of the turn's origin, the permission request and the turn
 * tools. Each group keeps the order of the registry.
 */
export function selectCatalogDefinitions(
  registry: ToolRegistry,
  selection: HarnessCatalogSelection,
): readonly HarnessToolDefinition[] {
  const allowed = new Set(selection.allowedCapabilities);
  const definitions: HarnessToolDefinition[] = [];
  for (const tool of registry.tools) {
    if (
      tool.selection.kind === "capability" &&
      allowed.has(tool.selection.capability)
    ) {
      definitions.push(modelToolDefinition(tool));
    }
  }
  const surfaceCommands = new Set(selection.bakerySurfaceCommands ?? []);
  for (const tool of registry.tools) {
    if (
      tool.selection.kind === "surface" &&
      surfaceCommands.has(tool.selection.command)
    ) {
      definitions.push(modelToolDefinition(tool));
    }
  }
  for (const tool of registry.tools) {
    if (
      tool.selection.kind === "turn" &&
      selection[tool.selection.flag] === true
    ) {
      definitions.push(modelToolDefinition(tool));
    }
  }
  if (selection.permissionRequest === true) {
    const missing = missingRequestableCapabilities(
      selection.allowedCapabilities,
    );
    if (missing.length > 0) {
      definitions.push(permissionRequestDefinition(missing));
    }
  }
  for (const { tool } of selection.turnTools ?? []) {
    definitions.push(modelToolDefinition(tool));
  }
  return Object.freeze(definitions);
}
