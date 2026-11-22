import type {
  CommerceContextRequest,
  CommerceGraphQueryResult,
} from "@purin-labs/commerce-contracts";
import { isRecord } from "@purin-labs/std";
import {
  CommerceContextToolResult,
  commerceContextOutputSchema,
} from "../../actors/commerce-context-tool-result";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { parseCommerceGraphQuery } from "../../entity-plane/routes";
import { COMMERCE_SENSITIVITIES } from "../../contract/sensitivity";
import { jsonSchema } from "@purin-labs/agent-tools/define-tool";
import { ToolRequestError } from "@purin-labs/agent-tools/errors";
import { defineCommerceTool } from "./services";

/** A context request that the model can correct. Its message reaches the model. */
class CommerceContextRequestError extends ToolRequestError {}

/**
 * The parameters as the catalog pinned them before this tool had a
 * definition here: an object schema with no properties names no `required`.
 */
const PARAMETERS = {
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
} as const;

/**
 * The scoped read of the commerce entity graph. Its result keeps the envelope
 * `{ ok, result | error }` that the accepted history holds, also for a
 * refused call.
 */
export const commerceEntityContext = defineCommerceTool({
  name: "commerce_entity_context",
  // A script receives the graph as a value, not as text.
  structuredOutput: commerceContextOutputSchema,
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
  input: jsonSchema(PARAMETERS),
  parameters: PARAMETERS,
  decodeOnly: true,
  decode: (input) => parseEntityContextArgs([input]),
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceEntityPlaneContext,
  },
  unavailable: "commerce entity context is unavailable",
  handler: ({ readEntityContext }) =>
    readEntityContext === undefined
      ? undefined
      : (request) => readEntityContext(request),
  result: {
    // The executor gives the value that this tool's handler returned.
    success: (value) =>
      CommerceContextToolResult.success(value as CommerceGraphQueryResult),
    failure: (detail) => CommerceContextToolResult.failure(detail),
  },
});

function parseEntityContextArgs(
  args: readonly unknown[],
): CommerceContextRequest {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    Object.keys(args[0]).length !== 1 ||
    !Object.hasOwn(args[0], "request")
  ) {
    throw new CommerceContextRequestError(
      "commerce_entity_context requires one request object. Correct the arguments before retrying.",
    );
  }
  const request = args[0].request;
  const parsed = parseCommerceGraphQuery({
    kind: "commerce_context",
    ...(isRecord(request) ? withRecordLifecycle(request) : {}),
  });
  if (!parsed.ok || parsed.value.kind !== "commerce_context") {
    throw new CommerceContextRequestError(
      "Invalid commerce_entity_context request. Follow the tool's request schema. A selector has exactly selectorId, revision and query; for entity_type_page, place traversal inside selector.query and at request.traversal. Correct the request before retrying; this is an input error.",
    );
  }
  if (parsed.value.selection.kind === "entity_seeds") {
    const first = parsed.value.selection.seeds[0];
    for (const seed of parsed.value.selection.seeds) {
      if (seed.origin !== first?.origin || seed.typeId !== first?.typeId) {
        throw new CommerceContextRequestError(
          "commerce_entity_context requires seeds of one origin and typeId per request. Read orders, payments and fulfillments in separate calls. Issue independent calls together; do not retry the mixed request.",
        );
      }
    }
  }
  if (
    parsed.value.traversal.maxDepth > 4 ||
    parsed.value.traversal.resultLimit > 100
  ) {
    throw new CommerceContextRequestError(
      "commerce_entity_context requires maxDepth at most 4 and resultLimit at most 100. Correct the limits before retrying.",
    );
  }
  return parsed.value;
}

/**
 * The state of a record, such as an order's "fulfilled", is the `lifecycle`
 * attribute that the Portal lists show. A request that leaves it out of its
 * allowlist still gets it, so the agent can say what a person sees. The
 * sensitivity ceiling and the person's grants still apply to it.
 */
const RECORD_LIFECYCLE_ATTRIBUTE_ID = "lifecycle";

function withRecordLifecycle(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = request.allowedAttributeIds;
  if (
    !Array.isArray(allowed) ||
    allowed.includes(RECORD_LIFECYCLE_ATTRIBUTE_ID)
  )
    return request;
  return {
    ...request,
    allowedAttributeIds: [...allowed, RECORD_LIFECYCLE_ATTRIBUTE_ID],
  };
}
