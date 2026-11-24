import { textLimit } from "@purin-labs/contract-schema";
import type {
  DraftAgentEditRequest,
  DraftAgentReadArgs,
} from "../../actors/product-description-draft";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { jsonSchema } from "@purin-labs/agent-tools/define-tool";
import { STORED_ACCESS_ENDED_NOTE } from "@purin-labs/agent-tools/tool-effect";
import { defineCommerceTool } from "./services";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_:-]{1,256}$/;

export const productDescriptionDraftRead = defineCommerceTool({
  name: "product_description_draft_read",
  description:
    "Read the current Product projection and its description draft for one exact product. " +
    "The result includes the product id, source revision and draft state used for a subsequent edit. " +
    "In a Slack thread that an owner connected to a draft, pass productId null to read that draft.",
  input: jsonSchema({
    type: "object",
    properties: {
      productId: {
        type: ["string", "null"],
        pattern: "^[A-Za-z0-9_:-]{1,256}$",
        description:
          "The shop's plain product id, or null for the draft connected to this Slack thread.",
      },
    },
    required: ["productId"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseProductDescriptionDraftReadArgs([input]),
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceEntityPlaneContext,
  },
  unavailable: "product description draft read is unavailable",
  handler: ({ readProductDescriptionDraft }) =>
    readProductDescriptionDraft === undefined ? undefined : (request) => readProductDescriptionDraft(request),
});

export const productDescriptionDraftEdit = defineCommerceTool({
  name: "product_description_draft_edit",
  description:
    "Replace one exact, unique passage in a product description draft. " +
    "Use the exact text returned by product_description_draft_read; the draft actor rejects " +
    "missing or ambiguous passages and preserves all other text." +
    STORED_ACCESS_ENDED_NOTE,
  input: jsonSchema({
    type: "object",
    properties: {
      productId: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,256}$" },
      oldText: textLimit({ type: "string", maxLength: 10000 }),
      newText: textLimit({ type: "string", maxLength: 10000 }),
    },
    required: ["productId", "oldText", "newText"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseProductDescriptionDraftEditArgs([input]),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceProductDescriptionDraftEdit,
  },
  unavailable: "product description draft edit is unavailable",
  prepare: ({ editProductDescriptionDraft }) =>
    editProductDescriptionDraft === undefined
      ? undefined
      : (request, call) =>
          editProductDescriptionDraft(request, call.operationId, call.execution),
});

function parseProductDescriptionDraftReadArgs(
  args: readonly unknown[],
): DraftAgentReadArgs {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["productId"]) ||
    (args[0].productId !== null &&
      (typeof args[0].productId !== "string" ||
        !PRODUCT_ID_PATTERN.test(args[0].productId)))
  ) {
    throw new TypeError("product_description_draft_read arguments are invalid");
  }
  return { productId: args[0].productId };
}

function parseProductDescriptionDraftEditArgs(
  args: readonly unknown[],
): DraftAgentEditRequest {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["productId", "oldText", "newText"]) ||
    typeof args[0].productId !== "string" ||
    !PRODUCT_ID_PATTERN.test(args[0].productId) ||
    typeof args[0].oldText !== "string" ||
    args[0].oldText.length > 10_000 ||
    typeof args[0].newText !== "string" ||
    args[0].newText.length > 10_000
  ) {
    throw new TypeError("product_description_draft_edit arguments are invalid");
  }
  return {
    productId: args[0].productId,
    oldText: args[0].oldText,
    newText: args[0].newText,
  };
}
