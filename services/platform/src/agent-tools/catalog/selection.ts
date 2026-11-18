import { BAKERY_DIRECT_CALL_GUIDANCE } from "../bakery/surface";
import { isPageViewCommandName } from "@seams/control-api";
import { modelToolDefinition, type RegisteredTool } from "../define-tool";
import {
  CHANNEL_TOOLS,
  COMMERCE_TOOLS,
  DEVICE_TOOLS,
  DRAFT_TOOLS,
  FILE_TOOLS,
  INTEGRATION_TOOLS,
  JEV_TOOLS,
  MESSAGE_TOOLS,
  PROPOSAL_TOOLS,
  REPORT_TOOLS,
  SAVED_RUN_TOOLS,
  isRegisteredToolName,
  registeredModelDefinitions,
  registeredTool,
  type RegisteredToolName,
  TURN_TOOLS,
  SURFACE_TOOLS,
} from "../registry";
import { COMMERCE_SENSITIVITIES } from "../../commerce/sensitivity";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { sha256Hex } from "@seams/std";
import {
  customConnectorCatalogPin,
  customConnectorToolDefinition,
} from "./custom-connectors";
import {
  missingRequestableCapabilities,
  permissionRequestDefinition,
} from "./permission";
import type {
  HarnessCapabilityName,
  HarnessCatalogSelection,
  HarnessToolDefinition,
} from "./types";

export type JsonSchema = Readonly<Record<string, unknown>>;

export type StaticHarnessToolName =
  | RegisteredToolName
  | "commerce_entity_context"
  | "workspace_product_folder_update";

export type StaticHarnessToolDefinition = HarnessToolDefinition & {
  readonly name: StaticHarnessToolName;
};

export const CATALOG_DEFINITIONS = [
  // Refactor 10, step 1: defined in agent-tools/kitchen.
  ...registeredModelDefinitions(SAVED_RUN_TOOLS),
  // Refactor 10, step 1: defined in agent-tools/integrations.
  ...registeredModelDefinitions(INTEGRATION_TOOLS),
  // Refactor 10, step 1: defined in agent-tools/channels.
  ...registeredModelDefinitions(CHANNEL_TOOLS),
  {
    type: "function",
    name: "commerce_entity_context",
    description:
      "Read a bounded, scoped commerce entity subgraph for the current Case. " +
      "Call as tools.commerce_entity_context({ request: { selection, traversal, " +
      "allowedSensitivity, allowedAttributeIds, freshnessRequirement } }). " +
      "For an exact record, selection is { kind: 'entity_seeds', seeds: [{ origin: 'system', " +
      "typeId: 'order', entityId: '<observed order ID>' }] }; omit selector. " +
      "All seeds in one request must have the same origin and typeId, with at most 64 seeds. " +
      "Read orders, payments and fulfillments in separate calls; issue independent calls together. " +
      "For a system-type page, selection is { kind: 'selector', selector: { " +
      "selectorId: 'type:fulfillment', revision: 1, query: { kind: 'entity_type_page', " +
      "entityTypeId: { origin: 'system', typeId: 'fulfillment' }, filter: { kind: 'all' }, sorts: [], " +
      "pagination: { limit: 10, cursor: null }, traversal: { maxDepth: 0, resultLimit: 10 } } } }. " +
      "The selector has exactly selectorId, revision and query. For entity_type_page, " +
      "traversal belongs inside selector.query and also at request.traversal. " +
      "Use the desired typeId and retain the query structure; selectorId names this local selector. " +
      "Use maxDepth: 0 for a scoped record read. allowedAttributeIds is an exact field allowlist, " +
      "but each record's 'lifecycle' status (for an order, such as confirmed, fulfilled or cancelled) always comes back, " +
      "as the Portal lists show it. Follow nextCursor for additional selector pages. " +
      "For an offer's price, name 'price', 'price_policy', 'price_policy_revision', " +
      "'price_minimum' and 'price_maximum'. A money value is { amountMinor, currency }, " +
      "in the currency's minor unit; JPY has no minor unit. " +
      "Use freshnessRequirement: 'current_only' for current shop reads. " +
      "The result is {ok:true,result:{entities,relationships,listEntries,aggregations,nextCursor,merchantRevision,provenance,freshness},truncated:false}. " +
      "Each entity is { reference, displayName, attributes }, and attributes is an array of { attributeId, value }, not an object keyed by field. " +
      "In a script, read a field as entity.attributes.find((a) => a.attributeId === 'lifecycle')?.value; " +
      "a status value is { kind: 'status', value: 'fulfilled' }, so group orders by that inner value. " +
      "Empty reads keep all arrays. Integer attribute and aggregation values are decimal strings. " +
      "Failures are {ok:false,error:{code,message}}. Results over 100 entities or 24576 bytes fail with result_too_large; request fewer rows or attributes. " +
      "The private context assembler validates the selector, sensitivity, and limits.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "object",
          properties: {
            selection: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["selector"] },
                    selector: {
                      type: "object",
                      properties: {
                        selectorId: { type: "string", minLength: 1 },
                        revision: { type: "integer", minimum: 1 },
                        query: { type: "object" },
                      },
                      required: ["selectorId", "revision", "query"],
                      additionalProperties: false,
                    },
                  },
                  required: ["kind", "selector"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["entity_seeds"] },
                    seeds: {
                      type: "array",
                      minItems: 1,
                      maxItems: 64,
                      items: {
                        type: "object",
                        properties: {
                          origin: {
                            type: "string",
                            enum: ["system", "custom"],
                          },
                          typeId: { type: "string", minLength: 1 },
                          entityId: { type: "string", minLength: 1 },
                        },
                        required: ["origin", "typeId", "entityId"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["kind", "seeds"],
                  additionalProperties: false,
                },
              ],
            },
            traversal: {
              type: "object",
              properties: {
                maxDepth: { type: "integer", minimum: 0, maximum: 4 },
                resultLimit: { type: "integer", minimum: 1, maximum: 100 },
              },
              required: ["maxDepth", "resultLimit"],
              additionalProperties: false,
            },
            allowedSensitivity: {
              type: "string",
              enum: [...COMMERCE_SENSITIVITIES],
            },
            allowedAttributeIds: {
              type: "array",
              items: { type: "string", minLength: 1 },
              maxItems: 100,
            },
            freshnessRequirement: { type: ["string", "object"] },
          },
          required: [
            "selection",
            "traversal",
            "allowedSensitivity",
            "allowedAttributeIds",
            "freshnessRequirement",
          ],
          additionalProperties: false,
        },
      },
      required: ["request"],
      additionalProperties: false,
    },
  },
  // Refactor 10, step 1: defined in agent-tools/.
  ...registeredModelDefinitions(COMMERCE_TOOLS),
  // Refactor 10, step 1: defined in agent-tools/devices.
  ...registeredModelDefinitions(DEVICE_TOOLS),
  // Plan 88: defined in agent-tools/jev.
  ...registeredModelDefinitions(JEV_TOOLS),
  // Refactor 10, step 1: defined in agent-tools/commerce.
  ...registeredModelDefinitions(REPORT_TOOLS),
  // Refactor 10, step 1: defined in agent-tools/drafts.
  ...registeredModelDefinitions(DRAFT_TOOLS),
  // Refactor 10, step 1: defined in agent-tools/commerce.
  ...registeredModelDefinitions(PROPOSAL_TOOLS),
  // Refactor 10, step 1: defined in agent-tools/files.
  ...registeredModelDefinitions(FILE_TOOLS),
  {
    type: "function",
    name: "workspace_product_folder_update",
    description:
      "Validate and commit a product.md and variants.yaml replacement against the " +
      "current immutable workspace revision in a short-lived Linux executor.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        productRoot: { type: "string", pattern: "^products/[A-Za-z0-9._-]+$" },
        candidate: {
          type: "object",
          properties: {
            productMarkdown: { type: "string", maxLength: 262144 },
            variantsYaml: { type: "string", maxLength: 262144 },
          },
          required: ["productMarkdown", "variantsYaml"],
          additionalProperties: false,
        },
        claimedChangeset: {
          type: "object",
          properties: {
            schemaVersion: {
              type: "string",
              const: "satyr.product-folder-changeset.v1",
            },
            organisationId: { type: "string", minLength: 1 },
            workspaceId: {
              type: "string",
              pattern: "^workspace_[A-Za-z0-9._:-]+$",
            },
            baseRevision: { type: "string", minLength: 1 },
            resultingSemanticHash: {
              type: "string",
              pattern: "^[0-9a-f]{64}$",
            },
            diff: {
              type: "object",
              properties: {
                productId: { type: "string", minLength: 1 },
                fields: {
                  type: "array",
                  items: {
                    enum: ["slug", "title", "description", "currency"],
                  },
                },
                variantIds: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
              },
              required: ["productId", "fields", "variantIds"],
              additionalProperties: false,
            },
            changesetDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
          required: [
            "schemaVersion",
            "organisationId",
            "workspaceId",
            "baseRevision",
            "resultingSemanticHash",
            "diff",
            "changesetDigest",
          ],
          additionalProperties: false,
        },
      },
      required: ["productRoot", "candidate", "claimedChangeset"],
      additionalProperties: false,
    },
  },
  // Refactor 10, step 1: defined in agent-tools/messages.
  ...registeredModelDefinitions(MESSAGE_TOOLS),
] as const satisfies readonly StaticHarnessToolDefinition[];

export function catalogHarnessToolCatalogDigest(
  selection: HarnessCatalogSelection = {
    allowedCapabilities: harnessBaseCapabilities(),
  },
): Promise<string> {
  const normalized = normalizeCatalogSelection(selection);
  return sha256Hex(
    JSON.stringify({
      definitions: selectCatalogDefinitions(normalized),
      customConnectorPins: normalized.customConnectorOperations.map(
        customConnectorCatalogPin,
      ),
    }),
  );
}

export function harnessBaseCapabilities(): readonly HarnessCapabilityName[] {
  return Object.freeze([
    ...new Set(CATALOG_DEFINITIONS.map(definitionCapability)),
  ]);
}

export function requireRegisteredTool(name: string): RegisteredTool {
  const tool = registeredTool(name);
  if (tool === undefined) {
    throw new Error(`${name} is not registered`);
  }
  return tool;
}

export function isStaticHarnessToolName(
  name: string,
): name is StaticHarnessToolName {
  return CATALOG_DEFINITIONS.some(matchesToolName.bind(null, name));
}

export function isSelectedCatalogToolName(
  definitions: readonly HarnessToolDefinition[],
  name: string,
): name is HarnessToolDefinition["name"] {
  return definitions.some(matchesToolName.bind(null, name));
}

export function matchesToolName(
  name: string,
  definition: HarnessToolDefinition,
): boolean {
  return definition.name === name;
}

export function selectCatalogDefinitions(
  selection: HarnessCatalogSelection,
): readonly HarnessToolDefinition[] {
  const allowed = new Set(selection.allowedCapabilities);
  const definitions: HarnessToolDefinition[] = CATALOG_DEFINITIONS.filter(
    definitionAllowed.bind(null, allowed),
  );
  const surfaceCommands = new Set(selection.bakerySurfaceCommands ?? []);
  for (const tool of SURFACE_TOOLS) {
    if (
      tool.selection.kind === "surface" &&
      surfaceCommands.has(tool.selection.command)
    ) {
      definitions.push(
        isPageViewCommandName(tool.selection.command)
          ? modelToolDefinition(tool)
          : {
              ...modelToolDefinition(tool),
              description: `${tool.description} ${BAKERY_DIRECT_CALL_GUIDANCE}`,
            },
      );
    }
  }
  for (const tool of TURN_TOOLS) {
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
  const customConnectorOperations = selection.customConnectorOperations ?? [];
  for (const entry of customConnectorOperations) {
    definitions.push(customConnectorToolDefinition(entry));
  }
  return Object.freeze(definitions);
}

export function definitionAllowed(
  allowed: ReadonlySet<HarnessCapabilityName>,
  definition: StaticHarnessToolDefinition,
): boolean {
  return allowed.has(definitionCapability(definition));
}

export function definitionCapability(
  definition: StaticHarnessToolDefinition,
): HarnessCapabilityName {
  const name = definition.name;
  if (isRegisteredToolName(name)) {
    const { selection } = requireRegisteredTool(name);
    if (selection.kind !== "capability") {
      throw new Error(`${name} is offered by the turn, not by a capability`);
    }
    return selection.capability;
  }
  switch (name) {
    case "commerce_entity_context":
      return CAPABILITY_KEYS.commerceEntityPlaneContext;
    case "workspace_product_folder_update":
      return CAPABILITY_KEYS.workspaceProductFolderUpdate;
  }
}

export function normalizeCatalogSelection(
  selection: HarnessCatalogSelection,
): Required<HarnessCatalogSelection> {
  return {
    allowedCapabilities: selection.allowedCapabilities,
    customConnectorOperations: selection.customConnectorOperations ?? [],
    bakerySurfaceCommands: selection.bakerySurfaceCommands ?? [],
    memoryProposal: selection.memoryProposal ?? false,
    followUp: selection.followUp ?? false,
    sideCaseProposal: selection.sideCaseProposal ?? false,
    permissionRequest: selection.permissionRequest ?? false,
  };
}
