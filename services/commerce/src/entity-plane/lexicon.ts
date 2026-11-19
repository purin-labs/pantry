import { parseCommerceEntityPlaneCommand } from "@purin-labs/commerce-contracts/entity-plane-commands";
import { validateCommerceEntityPlaneCommandAuthority } from "@purin-labs/commerce-contracts/entity-plane-command-authority";
import {
  parseCommerceList,
  parseCommerceListEntry,
} from "@purin-labs/commerce-contracts/list-records";
import { parseSavedCommerceView } from "@purin-labs/commerce-contracts/view-records";
import { parseCommerceMutationReceipt } from "@purin-labs/commerce-contracts/entity-plane-receipts";
import type { ContractDecodeResult } from "@purin-labs/commerce-contracts/schema";
import { parseCommerceEntityAuthority } from "@purin-labs/commerce-contracts/command-authority";
import {
  parseRelationshipDefinition,
  parseCommerceRelationship,
} from "@purin-labs/commerce-contracts/relationships";
import { planCommerceGraphQuery } from "@purin-labs/commerce-contracts/query-planner";
import { parseCommerceCursorPayload } from "@purin-labs/commerce-contracts/cursor-payload";
import { encodeCommerceCursor } from "@purin-labs/commerce-contracts/query-encoders";
import { parseCommerceQueryPlan } from "@purin-labs/commerce-contracts/query-plan";
import { normalizeCommerceUnicodeV1 } from "@purin-labs/commerce-contracts/unicode";
import { parseCommerceGraphQuery } from "@purin-labs/commerce-contracts/graph-query";
import { parseCommerceEntity } from "@purin-labs/commerce-contracts/entity-definition";
import type {
  AttributeDefinition,
  CommerceCursorPayload,
  CommerceEntity,
  CommerceEntityAuthority,
  CommerceEntityPlaneCommand,
  CommerceGraphQuery,
  CommerceList,
  CommerceListEntry,
  CommerceMerchantId,
  CommerceCommandId,
  CommerceQueryPlan,
  CommerceRelationship,
  RelationshipDefinition,
  SavedCommerceView,
  CommerceTimestamp,
  CommerceCursor,
  CommerceGraphQueryPlanRequest,
  CommerceQueryPlanOutcome,
  CommerceMutationReceiptV1,
} from "@purin-labs/commerce-contracts";
import { parseCommerceCursorValue } from "@purin-labs/commerce-client";
import { isRecord } from "@purin-labs/std";

type LexiconBoundaryError = Readonly<{
  kind: "wasm_rejected" | "wasm_response_invalid";
  reason: string;
}>;

/** The parser decides; a refusal throws with the label and the refusal code. */
function decideContract(
  label: string,
  parse: (input: unknown) => ContractDecodeResult<unknown>,
  input: unknown,
): void {
  const parsed = parse(input);
  if (!parsed.ok)
    throw new Error(`${label} rejected by Lexicon: ${parsed.error.code}`);
}

/** The parser's result as a Lexicon outcome. */
function decideResult<T>(parsed: ContractDecodeResult<T>): LexiconResult<T> {
  if (parsed.ok) return { kind: "ok", value: parsed.value };
  return {
    kind: "error",
    error: { kind: "wasm_rejected", reason: parsed.error.code },
  };
}

type LexiconResult<T> =
  | Readonly<{ kind: "ok"; value: T }>
  | Readonly<{ kind: "error"; error: LexiconBoundaryError }>;

export function validateCommerceGraphQueryWithLexicon(
  value: unknown,
): asserts value is CommerceGraphQuery {
  decideContract("commerce graph query", parseCommerceGraphQuery, value);
}

export function validateCommerceEntityPlaneCommandWithLexicon(
  value: unknown,
): asserts value is CommerceEntityPlaneCommand {
  decideContract(
    "commerce entity-plane command",
    parseCommerceEntityPlaneCommand,
    value,
  );
}

export function validateCommerceEntityAuthorityWithLexicon(
  value: unknown,
  now: CommerceTimestamp,
): asserts value is CommerceEntityAuthority {
  decideContract("commerce entity authority", parseCommerceEntityAuthority, {
    authority: value,
    now,
  });
}

export function validateCommerceQueryPlanWithLexicon(
  value: unknown,
): asserts value is CommerceQueryPlan {
  decideContract("commerce query plan", parseCommerceQueryPlan, value);
}

export function validateCommerceEntityWithLexicon(
  value: unknown,
  attributeDefinitions: readonly AttributeDefinition[],
): asserts value is CommerceEntity {
  decideContract("commerce entity", parseDefinedEntity, {
    entity: value,
    attributeDefinitions,
  });
}

function parseDefinedEntity(input: unknown): ContractDecodeResult<unknown> {
  if (!isRecord(input)) throw new Error("Invalid entity validation envelope");
  return parseCommerceEntity(input.entity, input.attributeDefinitions);
}

export function validateCommerceRelationshipWithLexicon(
  value: unknown,
  definition: RelationshipDefinition,
): asserts value is CommerceRelationship {
  decideContract("commerce relationship", parseCommerceRelationship, {
    relationship: value,
    definition,
  });
}

export function validateRelationshipDefinitionWithLexicon(
  value: unknown,
): asserts value is RelationshipDefinition {
  decideContract("relationship definition", parseRelationshipDefinition, value);
}

export function validateCommerceListWithLexicon(
  value: unknown,
): asserts value is CommerceList {
  decideContract("commerce list", parseCommerceList, value);
}

export function validateCommerceListEntryWithLexicon(
  value: unknown,
  list: CommerceList,
): asserts value is CommerceListEntry {
  decideContract("commerce list entry", parseCommerceListEntry, {
    entry: value,
    list,
  });
}

export function validateSavedCommerceViewWithLexicon(
  value: unknown,
): asserts value is SavedCommerceView {
  decideContract("saved commerce view", parseSavedCommerceView, value);
}

export function validateCommerceMutationReceiptWithLexicon(
  value: unknown,
): asserts value is CommerceMutationReceiptV1 {
  decideContract(
    "Underclerk mutation receipt",
    parseCommerceMutationReceipt,
    value,
  );
}

export function validateCommandAuthorityWithLexicon(
  request: Readonly<{
    authority: CommerceEntityAuthority;
    command: CommerceEntityPlaneCommand;
    organisationId: string;
    merchantId: CommerceMerchantId;
    commandId: CommerceCommandId;
    now: CommerceTimestamp;
  }>,
):
  | Readonly<{ kind: "ok" }>
  | Readonly<{ kind: "error"; error: LexiconBoundaryError }> {
  const result = decideResult(
    validateCommerceEntityPlaneCommandAuthority(request),
  );
  return result.kind === "error" ? result : { kind: "ok" };
}

export function planWithLexicon(
  request: CommerceGraphQueryPlanRequest,
): LexiconResult<CommerceQueryPlanOutcome> {
  return decideResult(planCommerceGraphQuery(request));
}

export function encodeCursorWithLexicon(
  payload: CommerceCursorPayload,
): LexiconResult<CommerceCursor> {
  return decideResult(typescriptCursor(payload));
}

function typescriptCursor(
  payload: CommerceCursorPayload,
): ContractDecodeResult<CommerceCursor> {
  const parsed = parseCommerceCursorPayload(payload);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: parseCommerceCursorValue(encodeCommerceCursor(parsed.value)),
  };
}

export function foldCommerceUnicodeV1(value: string): LexiconResult<string> {
  return decideResult(typescriptFold(value));
}

function typescriptFold(value: string): ContractDecodeResult<string> {
  return { ok: true, value: normalizeCommerceUnicodeV1(value) };
}
