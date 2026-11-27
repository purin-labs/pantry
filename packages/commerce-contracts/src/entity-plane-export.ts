import {
  customRelationshipDefinitionSchema,
  parseRelationshipDefinition,
  type RelationshipDefinition,
} from "./relationships.ts";
import {
  customEntityTypeSchema,
  parseCommerceEntityType,
  type CommerceEntityType,
} from "./entity-type.ts";
import {
  StrictObject,
  OpenObject,
  contractRefusal,
  checkContract,
  parseContractArray,
  type ContractDecodeResult,
  type ContractRejection,
} from "@purin-labs/contract-schema";
import { Type, type Static } from "typebox";
import { canonicalJson } from "@purin-labs/std";

import {
  commerceListSchema,
  parseCommerceList,
  type CommerceList,
} from "./list-records.ts";
import {
  savedCommerceViewSchema,
  parseSavedCommerceView,
  type SavedCommerceView,
} from "./view-records.ts";
import { javascriptTrimmedTextSchema } from "./identity-text.ts";
import { commerceSnapshotRevisionSchema } from "./query-metadata.ts";
import { queryIdentitySchema } from "./query-parts.ts";

export const EXPORT_COORDINATION_PRESET_ID = "export_coordination" as const;
export const EXPORT_COORDINATION_PRESET_VERSION = 1 as const;
const preset = {
  presetId: Type.Literal(EXPORT_COORDINATION_PRESET_ID),
  presetVersion: Type.Literal(EXPORT_COORDINATION_PRESET_VERSION),
};
const entityPlaneExportPresetPublishRequestSchema = StrictObject({
  organisationId: javascriptTrimmedTextSchema,
  merchantId: javascriptTrimmedTextSchema,
  ...preset,
});
export type CommerceEntityPlaneExportPresetPublishRequest = Readonly<
  Static<typeof entityPlaneExportPresetPublishRequestSchema>
>;
type CustomEntityType = Extract<CommerceEntityType, { origin: "custom" }>;
type CustomRelationshipDefinition = Extract<
  RelationshipDefinition,
  { origin: "custom" }
>;
const entityPlaneExportPresetEvidenceSchema = StrictObject({
  customEntityTypes: Type.Unsafe<readonly CustomEntityType[]>(
    Type.Array(customEntityTypeSchema),
  ),
  relationshipDefinitions: Type.Unsafe<readonly CustomRelationshipDefinition[]>(
    Type.Array(customRelationshipDefinitionSchema),
  ),
  lists: Type.Unsafe<readonly CommerceList[]>(Type.Array(commerceListSchema)),
  views: Type.Unsafe<readonly SavedCommerceView[]>(
    Type.Array(savedCommerceViewSchema),
  ),
});
export type CommerceEntityPlaneExportPresetEvidence = Readonly<
  Static<typeof entityPlaneExportPresetEvidenceSchema>
>;
const merchantIdSchema = queryIdentitySchema<"CommerceMerchantId">();
const digestSchema = Type.String({ pattern: "^[a-f0-9]{64}(?![\\s\\S])" });
const entityPlaneExportPresetPublishResponseSchema = StrictObject({
  kind: Type.Literal("published"),
  organisationId: javascriptTrimmedTextSchema,
  merchantId: Type.Unsafe<Static<typeof merchantIdSchema>>(
    javascriptTrimmedTextSchema,
  ),
  ...preset,
  merchantRevision: commerceSnapshotRevisionSchema,
  evidence: entityPlaneExportPresetEvidenceSchema,
  digest: digestSchema,
});
export type CommerceEntityPlaneExportPresetPublishResponse = Readonly<
  Static<typeof entityPlaneExportPresetPublishResponseSchema>
>;
const responseWire = StrictObject({
  ...entityPlaneExportPresetPublishResponseSchema.properties,
  evidence: Type.Optional(Type.Unknown()),
  digest: Type.Optional(Type.Unknown()),
});
const evidenceWire = StrictObject({
  customEntityTypes: Type.Optional(Type.Unknown()),
  relationshipDefinitions: Type.Optional(Type.Unknown()),
  lists: Type.Optional(Type.Unknown()),
  views: Type.Optional(Type.Unknown()),
});
const arrayWire = Type.Array(Type.Unknown());
const digestWire = OpenObject({
  ...preset,
  evidence: Type.Optional(Type.Unknown()),
});

export function parseEntityPlaneExportPresetPublishRequest(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneExportPresetPublishRequest> {
  return checkContract(
    entityPlaneExportPresetPublishRequestSchema,
    input,
    invalidExportPreset,
  );
}
export function parseEntityPlaneExportPresetPublishResponse(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneExportPresetPublishResponse> {
  const parsed = checkContract(responseWire, input, invalidExportPreset);
  if (!parsed.ok) return parsed;
  const response = parsed.value;
  const evidence = parseEntityPlaneExportPresetEvidence(response.evidence);
  if (!evidence.ok) return evidence;
  const digest = checkContract(
    digestSchema,
    response.digest,
    invalidExportPreset,
  );
  if (!digest.ok) return digest;
  return {
    ok: true,
    value: {
      kind: "published",
      organisationId: response.organisationId,
      merchantId: response.merchantId,
      presetId: response.presetId,
      presetVersion: response.presetVersion,
      merchantRevision: response.merchantRevision,
      evidence: evidence.value,
      digest: digest.value,
    },
  };
}
function parseEntityPlaneExportPresetEvidence(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneExportPresetEvidence> {
  const parsed = checkContract(evidenceWire, input, invalidExportPreset);
  if (!parsed.ok) return parsed;
  const evidence = parsed.value;
  const rawEntityTypes = checkContract(
    arrayWire,
    evidence.customEntityTypes,
    invalidExportPreset,
  );
  if (!rawEntityTypes.ok) return rawEntityTypes;
  const customEntityTypes = parseContractArray(
    rawEntityTypes.value,
    parseCustomEntityType,
  );
  if (!customEntityTypes.ok) return customEntityTypes;
  const rawDefinitions = checkContract(
    arrayWire,
    evidence.relationshipDefinitions,
    invalidExportPreset,
  );
  if (!rawDefinitions.ok) return rawDefinitions;
  const relationshipDefinitions = parseContractArray(
    rawDefinitions.value,
    parseCustomDefinition,
  );
  if (!relationshipDefinitions.ok) return relationshipDefinitions;
  const rawLists = checkContract(
    arrayWire,
    evidence.lists,
    invalidExportPreset,
  );
  if (!rawLists.ok) return rawLists;
  const lists = parseContractArray(rawLists.value, parseCommerceList);
  if (!lists.ok) return lists;
  const rawViews = checkContract(
    arrayWire,
    evidence.views,
    invalidExportPreset,
  );
  if (!rawViews.ok) return rawViews;
  const views = parseContractArray(rawViews.value, parseSavedCommerceView);
  if (!views.ok) return views;
  const typeIds = customEntityTypes.value.map(entityTypeId);
  const definitionIds = relationshipDefinitions.value.map(
    relationshipDefinitionId,
  );
  const listIds = lists.value.map(listId);
  const viewIds = views.value.map(viewId);
  if (
    !hasIdentities(typeIds, ["export_document", "trade_partner"]) ||
    !hasIdentities(definitionIds, [
      "shipment_export_document",
      "trade_partner_order",
    ]) ||
    !hasIdentities(listIds, ["export_coordination"]) ||
    !hasIdentities(viewIds, [
      "export_board",
      "handoff_due",
      "missing_documents",
      "trade_partner_follow_up",
    ])
  )
    return exportPresetRefusal();
  return {
    ok: true,
    value: {
      customEntityTypes: customEntityTypes.value,
      relationshipDefinitions: relationshipDefinitions.value,
      lists: lists.value,
      views: views.value,
    },
  };
}

/** Preserve the existing JavaScript canonical digest format and normalized evidence. */
export function parseCommerceExportPresetDigestPayload(
  input: unknown,
): ContractDecodeResult<string> {
  const parsed = checkContract(digestWire, input, invalidExportPreset);
  if (!parsed.ok) return parsed;
  const evidence = parseEntityPlaneExportPresetEvidence(parsed.value.evidence);
  if (!evidence.ok) return evidence;
  return {
    ok: true,
    value: canonicalJson({
      presetId: parsed.value.presetId,
      presetVersion: parsed.value.presetVersion,
      evidence: evidence.value,
    }),
  };
}
function parseCustomEntityType(
  input: unknown,
): ContractDecodeResult<CustomEntityType> {
  const parsed = parseCommerceEntityType(input);
  if (!parsed.ok) return parsed;
  if (parsed.value.origin !== "custom") return exportPresetRefusal();
  return { ok: true, value: parsed.value };
}
function parseCustomDefinition(
  input: unknown,
): ContractDecodeResult<CustomRelationshipDefinition> {
  const parsed = parseRelationshipDefinition(input);
  if (!parsed.ok) return parsed;
  if (parsed.value.origin !== "custom") return exportPresetRefusal();
  return { ok: true, value: parsed.value };
}
function hasIdentities(
  values: readonly string[],
  expected: readonly string[],
): boolean {
  const actual = new Set(values);
  if (values.length !== actual.size || values.length !== expected.length)
    return false;
  for (const identity of expected) if (!actual.has(identity)) return false;
  return true;
}
function entityTypeId(value: CustomEntityType): string {
  return value.typeId;
}
function relationshipDefinitionId(value: CustomRelationshipDefinition): string {
  return value.definitionId;
}
function listId(value: CommerceList): string {
  return value.listId;
}
function viewId(value: SavedCommerceView): string {
  return value.viewId;
}
function invalidExportPreset(): ContractRejection {
  return { code: "parse", reason: "invalid export preset", details: null };
}
function exportPresetRefusal(): ContractDecodeResult<never> {
  return contractRefusal({ ...invalidExportPreset() });
}
