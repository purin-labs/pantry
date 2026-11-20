// Plan 78 step 2: the plugin records that packages/commerce-client
// reads in src/plugins.ts. Each schema follows its hand-written reader: exact
// keys, the id patterns and list limits of the plugin readers, and settings
// whose keys are normalized text.
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import {
  NonNegativeInteger,
  PositiveInteger,
  ReadonlyRecord,
  SafeInteger,
} from "@purin-labs/contract-schema";
import type { PluginDefinition } from "./plugins.ts";
import {
  boundedTextSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import { Nullable, wireMoneySchema } from "./client-wire-fields.ts";
import { commerceMutationErrorV1Schema } from "./api-mutations.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;

/** Text that matches `pattern` (`requireText` and a pattern test). */
function textMatching(pattern: string) {
  return Type.String({ ...normalizedTextSchema, pattern });
}

/** `PART_ID` and `FIELD_KEY` of plugins.ts. */
const partIdSchema = textMatching("^[a-z][a-z0-9_]{0,39}$");
const eventKindSchema = textMatching("^[a-z_]+\\.(\\*|[a-z_]+)$");
const entityTypeIdSchema = textMatching("^[a-z][a-z0-9_]{1,63}$");

/** A list whose items name different values of `key`, at most `maxItems`. */
function distinctList<Item extends TSchema>(
  item: Item,
  key: (item: never) => string,
  maxItems: number,
  minItems = 0,
) {
  return Type.Refine(
    ImmutableArray(item),
    isDistinctList.bind(null, key, maxItems, minItems),
    distinctListError,
  );
}

function isDistinctList(
  key: (item: never) => string,
  maxItems: number,
  minItems: number,
  items: readonly unknown[],
): boolean {
  return (
    items.length >= minItems &&
    items.length <= maxItems &&
    new Set(items.map((item) => key(item as never))).size === items.length
  );
}

function distinctListError(): string {
  return "must name different items within the limit";
}

function handlerIdOf(item: Readonly<{ handlerId: string }>): string {
  return item.handlerId;
}

function actionIdOf(item: Readonly<{ actionId: string }>): string {
  return item.actionId;
}

function keyOf(item: Readonly<{ key: string }>): string {
  return item.key;
}

function fieldNameOf(
  item: Readonly<{ entityType: string; key: string }>,
): string {
  return `${item.entityType}:${item.key}`;
}

const stageSchema = Type.Union([
  Type.Literal("lines"),
  Type.Literal("market"),
  Type.Literal("discounts"),
  Type.Literal("tax"),
  Type.Literal("shipping"),
  Type.Literal("total"),
  Type.Literal("stored_value"),
  Type.Literal("amount_due"),
]);

const hookPointSchema = Type.Union([
  Type.Literal("checkout.validate"),
  Type.Literal("checkout.discount"),
  Type.Literal("checkout.delivery"),
  Type.Literal("checkout.tenders"),
  Type.Literal("checkout.lines"),
  Type.Literal("machine.guard"),
]);

export const commercePluginSettingValueV1Schema = Type.Union([
  SafeInteger,
  Type.String(),
  Type.Boolean(),
  ImmutableArray(Type.String()),
]);
export type CommercePluginSettingValueV1 = Static<
  typeof commercePluginSettingValueV1Schema
>;

/** `parsePluginSettings`: each key is normalized text. */
export const commercePluginSettingsV1Schema = Type.Refine(
  ReadonlyRecord(Type.String(), commercePluginSettingValueV1Schema),
  hasNormalizedKeys,
  settingKeyError,
);
export type CommercePluginSettingsV1 = Static<
  typeof commercePluginSettingsV1Schema
>;

function isNormalizedKey(key: string): boolean {
  return key.length > 0 && key === key.trim();
}

function hasNormalizedKeys(settings: Readonly<Record<string, unknown>>) {
  return Object.keys(settings).every(isNormalizedKey);
}

function settingKeyError(): string {
  return "a settings key must be normalized text";
}

/** `parsePluginDefinition`: the definition an agent writes. */
const definitionProperties = {
  pluginId: text,
  version: PositiveInteger,
  kind: Type.Union([Type.Literal("built_in"), Type.Literal("merchant")]),
  title: boundedTextSchema(200),
  purpose: boundedTextSchema(500),
  specSection: Type.Optional(PositiveInteger),
  requirements: ReadonlyStrictObject({
    hookPoints: ImmutableArray(hookPointSchema),
    reads: ImmutableArray(text),
    commands: ImmutableArray(text),
    dependsOn: ImmutableArray(text),
  }),
  contributions: ReadonlyStrictObject({
    routes: ImmutableArray(text),
    pipelineSteps: ImmutableArray(stageSchema),
    entityTypes: ImmutableArray(text),
    settings: ImmutableArray(
      ReadonlyStrictObject({
        key: text,
        valueKind: text,
        description: Type.String(),
      }),
    ),
    functions: ImmutableArray(
      ReadonlyStrictObject({
        functionId: text,
        hookPoint: hookPointSchema,
        required: Type.Boolean(),
        source: Type.String(),
      }),
    ),
  }),
  limits: Type.Optional(
    ReadonlyStrictObject({
      instructionBudget: PositiveInteger,
      memoryBytes: PositiveInteger,
      outputBytes: PositiveInteger,
    }),
  ),
} satisfies TProperties;

export const wirePluginDefinitionSchema = Type.Unsafe<PluginDefinition>(
  ReadonlyStrictObject(definitionProperties),
);

/** The records that a merchant plugin can add fields to. */
const pluginFieldEntityTypeSchema = Type.Union([
  Type.Literal("product"),
  Type.Literal("sellable_variant"),
  Type.Literal("customer"),
]);

/**
 * A field on a product, a variant or a customer. A customer field holds an
 * integer or a boolean only, so a plugin keeps no free text about a person.
 */
export const commercePluginFieldV1Schema = Type.Refine(
  ReadonlyStrictObject({
    entityType: pluginFieldEntityTypeSchema,
    key: partIdSchema,
    valueKind: Type.Union([
      Type.Literal("integer"),
      Type.Literal("text"),
      Type.Literal("boolean"),
      Type.Literal("text_list"),
    ]),
    description: text,
  }),
  customerFieldHasNoText,
  customerFieldError,
);

function customerFieldHasNoText(
  field: Readonly<{ entityType: string; valueKind: string }>,
): boolean {
  return (
    field.entityType !== "customer" ||
    field.valueKind === "integer" ||
    field.valueKind === "boolean"
  );
}

function customerFieldError(): string {
  return "a customer field must be an integer or a boolean";
}
export type CommercePluginFieldV1 = Static<
  typeof commercePluginFieldV1Schema
>;

/** `parsePluginFields`: at most 20 fields, each entity type and key once. */
const pluginFieldsSchema = distinctList(
  commercePluginFieldV1Schema,
  fieldNameOf,
  20,
);

export const commercePluginAttributeV1Schema = ReadonlyStrictObject({
  key: partIdSchema,
  label: boundedTextSchema(120),
  valueKind: Type.Union([
    Type.Literal("short_text"),
    Type.Literal("integer"),
    Type.Literal("boolean"),
    Type.Literal("date"),
    Type.Literal("timestamp"),
  ]),
  required: Type.Boolean(),
});
export type CommercePluginAttributeV1 = Static<
  typeof commercePluginAttributeV1Schema
>;

export const commercePluginEntityTypeV1Schema = ReadonlyStrictObject({
  typeId: entityTypeIdSchema,
  label: boundedTextSchema(120),
  description: boundedTextSchema(1000),
  attributes: distinctList(commercePluginAttributeV1Schema, keyOf, 20, 1),
});
export type CommercePluginEntityTypeV1 = Static<
  typeof commercePluginEntityTypeV1Schema
>;

export const commercePluginHandlerV1Schema = ReadonlyStrictObject({
  handlerId: partIdSchema,
  eventKinds: ImmutableArray(eventKindSchema, { minItems: 1 }),
  source: Type.String(),
});
export type CommercePluginHandlerV1 = Static<
  typeof commercePluginHandlerV1Schema
>;

/** `parsePluginHandlers`: at most 10 handlers with different ids. */
const pluginHandlersSchema = distinctList(
  commercePluginHandlerV1Schema,
  handlerIdOf,
  10,
);

export const commercePluginActionInputV1Schema = ReadonlyStrictObject({
  key: partIdSchema,
  valueKind: Type.Union([
    Type.Literal("integer"),
    Type.Literal("text"),
    Type.Literal("boolean"),
    Type.Literal("text_list"),
    Type.Literal("order"),
  ]),
  description: text,
});
export type CommercePluginActionInputV1 = Static<
  typeof commercePluginActionInputV1Schema
>;

export const commercePluginActionV1Schema = ReadonlyStrictObject({
  actionId: partIdSchema,
  title: text,
  inputs: distinctList(commercePluginActionInputV1Schema, keyOf, 10),
  source: Type.String(),
});
export type CommercePluginActionV1 = Static<
  typeof commercePluginActionV1Schema
>;

/** `parsePluginActions`: at most 10 actions with different ids. */
const pluginActionsSchema = distinctList(
  commercePluginActionV1Schema,
  actionIdOf,
  10,
);

export const commercePluginFailureV1Schema = ReadonlyStrictObject({
  version: PositiveInteger,
  hookPoint: text,
  functionId: text,
  reason: Type.Union([
    Type.Literal("threw"),
    Type.Literal("budget"),
    Type.Literal("memory"),
    Type.Literal("invalid_output"),
    Type.Literal("unavailable"),
    Type.Literal("refused"),
  ]),
  message: text,
  subjectId: text,
  failuresInARow: PositiveInteger,
  occurredAt: utcTimestampSchema,
});
export type CommercePluginFailureV1 = Static<
  typeof commercePluginFailureV1Schema
>;

/** `parsePlugin`: the definition's fields and the merchant's, no others. */
export const commercePluginV1Schema = Type.Intersect(
  [
    Type.Unsafe<PluginDefinition>(ReadonlyOpenObject(definitionProperties)),
    ReadonlyOpenObject({
      state: Type.Union([
        Type.Literal("active"),
        Type.Literal("paused"),
        Type.Literal("removed"),
      ]),
      revision: PositiveInteger,
      settings: commercePluginSettingsV1Schema,
      fields: pluginFieldsSchema,
      handlers: pluginHandlersSchema,
      actions: pluginActionsSchema,
      lastFailure: Nullable(commercePluginFailureV1Schema),
    }),
  ],
  { unevaluatedProperties: false },
);
export type CommercePluginV1 = Static<typeof commercePluginV1Schema>;

export const commercePluginListV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.plugins.v1"),
  plugins: ImmutableArray(commercePluginV1Schema),
});
export type CommercePluginListV1 = Static<
  typeof commercePluginListV1Schema
>;

export const commercePluginChangeV1Schema = Type.Union([
  Type.Literal("pause"),
  Type.Literal("resume"),
]);
export type CommercePluginChangeV1 = Static<
  typeof commercePluginChangeV1Schema
>;

export const pluginsMoneySchema = wireMoneySchema;
export type PluginsMoney = Static<typeof pluginsMoneySchema>;

export const commercePluginEffectV1Schema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("routes"),
    available: Type.Boolean(),
    routes: ImmutableArray(text),
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("pipeline_steps"),
    available: Type.Boolean(),
    steps: ImmutableArray(stageSchema),
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("open_balances"),
    accounts: NonNegativeInteger,
    balances: ImmutableArray(wireMoneySchema),
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("held_checkouts"),
    checkouts: NonNegativeInteger,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("active_discounts"),
    discounts: NonNegativeInteger,
  }),
]);
export type CommercePluginEffectV1 = Static<
  typeof commercePluginEffectV1Schema
>;

export const commercePluginPreviewV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.plugin-preview.v1"),
  pluginId: text,
  change: commercePluginChangeV1Schema,
  refusal: Nullable(commerceMutationErrorV1Schema),
  effects: ImmutableArray(commercePluginEffectV1Schema),
});
export type CommercePluginPreviewV1 = Static<
  typeof commercePluginPreviewV1Schema
>;

export const previewCommercePluginChangeV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.preview-plugin-change.v1"),
  change: commercePluginChangeV1Schema,
});
export type PreviewCommercePluginChangeV1 = Static<
  typeof previewCommercePluginChangeV1Schema
>;

const commandBase = {
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
};

export const pluginCommandBaseSchema = ReadonlyOpenObject({
  ...commandBase,
  pluginId: text,
  expectedRevision: PositiveInteger,
});
export type PluginCommandBase = Static<typeof pluginCommandBaseSchema>;

function pluginCommand<Version extends string>(schemaVersion: Version) {
  return Type.Intersect(
    [
      pluginCommandBaseSchema,
      ReadonlyOpenObject({ schemaVersion: Type.Literal(schemaVersion) }),
    ],
    { unevaluatedProperties: false },
  );
}

export const pauseCommercePluginV1Schema = pluginCommand(
  "underclerk.pause-plugin.v1",
);
export type PauseCommercePluginV1 = Static<
  typeof pauseCommercePluginV1Schema
>;

export const resumeCommercePluginV1Schema = pluginCommand(
  "underclerk.resume-plugin.v1",
);
export type ResumeCommercePluginV1 = Static<
  typeof resumeCommercePluginV1Schema
>;

export const removeCommercePluginV1Schema = pluginCommand(
  "underclerk.remove-plugin.v1",
);
export type RemoveCommercePluginV1 = Static<
  typeof removeCommercePluginV1Schema
>;

/** `parseConfigurePluginCommand`: a built-in plugin's settings, all of them. */
export const configureCommercePluginV1Schema = Type.Intersect(
  [
    pluginCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.configure-plugin.v1"),
      settings: commercePluginSettingsV1Schema,
    }),
  ],
  { unevaluatedProperties: false },
);
export type ConfigureCommercePluginV1 = Static<
  typeof configureCommercePluginV1Schema
>;

export const commercePluginCommandV1Schema = Type.Union([
  pauseCommercePluginV1Schema,
  resumeCommercePluginV1Schema,
  removeCommercePluginV1Schema,
]);
export type CommercePluginCommandV1 = Static<
  typeof commercePluginCommandV1Schema
>;

/** At most eight entity types, each with a different type id. */
const pluginEntityTypesSchema = distinctList(
  commercePluginEntityTypeV1Schema,
  typeIdOf,
  8,
);

function typeIdOf(item: Readonly<{ typeId: string }>): string {
  return item.typeId;
}

export const installCommerceMerchantPluginV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.install-merchant-plugin.v1"),
  ...commandBase,
  definition: wirePluginDefinitionSchema,
  settings: commercePluginSettingsV1Schema,
  fields: Type.Optional(pluginFieldsSchema),
  entityTypes: Type.Optional(pluginEntityTypesSchema),
  handlers: Type.Optional(pluginHandlersSchema),
  actions: Type.Optional(pluginActionsSchema),
  expectedRevision: Nullable(PositiveInteger),
});
export type InstallCommerceMerchantPluginV1 = Static<
  typeof installCommerceMerchantPluginV1Schema
>;

/**
 * `parseSetPluginFieldValuesCommand`: at least one field; a value that is not
 * null has a normalized key, as `parsePluginSettings` reads it.
 */
const fieldValuesSchema = Type.Refine(
  ReadonlyRecord(Type.String(), Nullable(commercePluginSettingValueV1Schema)),
  hasFieldValues,
  fieldValuesError,
);

function hasFieldValues(values: Readonly<Record<string, unknown>>): boolean {
  const entries = Object.entries(values);
  return (
    entries.length > 0 &&
    entries.every(([key, value]) => value === null || isNormalizedKey(key))
  );
}

function fieldValuesError(): string {
  return "values must name at least one field by normalized keys";
}

export const setCommercePluginFieldValuesV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.set-plugin-field-values.v1"),
  ...commandBase,
  pluginId: text,
  entityType: pluginFieldEntityTypeSchema,
  entityId: text,
  values: fieldValuesSchema,
  expectedRevision: Nullable(PositiveInteger),
});
export type SetCommercePluginFieldValuesV1 = Static<
  typeof setCommercePluginFieldValuesV1Schema
>;

export const commercePluginFieldValuesV1Schema = ReadonlyStrictObject({
  entityType: pluginFieldEntityTypeSchema,
  entityId: text,
  revision: PositiveInteger,
  values: commercePluginSettingsV1Schema,
});
export type CommercePluginFieldValuesV1 = Static<
  typeof commercePluginFieldValuesV1Schema
>;

export const commercePluginFieldValueListV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.plugin-field-values.v1"),
  pluginId: text,
  fields: pluginFieldsSchema,
  records: ImmutableArray(commercePluginFieldValuesV1Schema),
});
export type CommercePluginFieldValueListV1 = Static<
  typeof commercePluginFieldValueListV1Schema
>;

export const runCommercePluginActionV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.run-plugin-action.v1"),
  ...commandBase,
  pluginId: text,
  actionId: text,
  input: commercePluginSettingsV1Schema,
});
export type RunCommercePluginActionV1 = Static<
  typeof runCommercePluginActionV1Schema
>;

export const runCommercePluginFunctionV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.run-plugin-function.v1"),
  definition: wirePluginDefinitionSchema,
  functionId: text,
  settings: commercePluginSettingsV1Schema,
  input: Type.Unknown(),
  handlers: Type.Optional(pluginHandlersSchema),
  actions: Type.Optional(pluginActionsSchema),
});
export type RunCommercePluginFunctionV1 = Static<
  typeof runCommercePluginFunctionV1Schema
>;

export const commercePluginCommandCheckV1Schema = ReadonlyStrictObject({
  kind: text,
  accepted: Type.Boolean(),
  reason: Nullable(text),
});
export type CommercePluginCommandCheckV1 = Static<
  typeof commercePluginCommandCheckV1Schema
>;

const pluginFunctionRunShape = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.plugin-function-run.v1"),
  outcome: Type.Union([
    ReadonlyStrictObject({
      kind: Type.Literal("returned"),
      output: Type.Unknown(),
    }),
    ReadonlyStrictObject({
      kind: Type.Literal("failed"),
      reason: Type.Union([
        Type.Literal("threw"),
        Type.Literal("budget"),
        Type.Literal("memory"),
        Type.Literal("invalid_output"),
        Type.Literal("unavailable"),
      ]),
      message: Type.String(),
    }),
  ]),
  polls: NonNegativeInteger,
  commands: Type.Optional(ImmutableArray(commercePluginCommandCheckV1Schema)),
});
type PluginFunctionRun = Static<typeof pluginFunctionRunShape>;

/** `parsePluginFunctionRun` keeps the command checks of a returned run only. */
export const commercePluginFunctionRunV1Schema = Type.Codec(
  pluginFunctionRunShape,
)
  .Decode(withoutFailedRunCommands)
  .Encode(sameRun);
export type CommercePluginFunctionRunV1 = Static<
  typeof commercePluginFunctionRunV1Schema
>;

function withoutFailedRunCommands(run: PluginFunctionRun): PluginFunctionRun {
  if (run.outcome.kind === "returned" || run.commands === undefined) return run;
  const { commands: _dropped, ...failed } = run;
  return failed;
}

function sameRun(run: PluginFunctionRun): PluginFunctionRun {
  return run;
}

export const previewCommerceMerchantPluginV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.preview-merchant-plugin.v1"),
  definition: wirePluginDefinitionSchema,
  settings: commercePluginSettingsV1Schema,
});
export type PreviewCommerceMerchantPluginV1 = Static<
  typeof previewCommerceMerchantPluginV1Schema
>;

export const commerceMerchantPluginPreviewV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.merchant-plugin-preview.v1"),
  pluginId: text,
  checkouts: NonNegativeInteger,
  refused: ImmutableArray(
    ReadonlyStrictObject({
      checkoutId: text,
      functionId: text,
      messages: ImmutableArray(text),
    }),
  ),
  failed: ImmutableArray(
    ReadonlyStrictObject({
      checkoutId: text,
      functionId: text,
      reason: text,
    }),
  ),
});
export type CommerceMerchantPluginPreviewV1 = Static<
  typeof commerceMerchantPluginPreviewV1Schema
>;

// Parsers of the client API types (Plan 78 step 2).
export const parseInstallCommerceMerchantPluginV1 = wireRecordParser(
  installCommerceMerchantPluginV1Schema,
);
export const parsePreviewCommerceMerchantPluginV1 = wireRecordParser(
  previewCommerceMerchantPluginV1Schema,
);
export const parsePreviewCommercePluginChangeV1 = wireRecordParser(
  previewCommercePluginChangeV1Schema,
);
export const parseRunCommercePluginActionV1 = wireRecordParser(
  runCommercePluginActionV1Schema,
);
export const parseRunCommercePluginFunctionV1 = wireRecordParser(
  runCommercePluginFunctionV1Schema,
);
export const parseSetCommercePluginFieldValuesV1 = wireRecordParser(
  setCommercePluginFieldValuesV1Schema,
);
export const parseCommerceMerchantPluginPreviewV1 = wireRecordParser(
  commerceMerchantPluginPreviewV1Schema,
);
export const parseConfigureCommercePluginV1 = wireRecordParser(
  configureCommercePluginV1Schema,
);
export const parseCommercePluginCommandV1 = wireRecordParser(
  commercePluginCommandV1Schema,
);
export const parseCommercePluginFieldValueListV1 = wireRecordParser(
  commercePluginFieldValueListV1Schema,
);
export const parseCommercePluginFunctionRunV1 = wireRecordParser(
  commercePluginFunctionRunV1Schema,
);
export const parseCommercePluginListV1 = wireRecordParser(
  commercePluginListV1Schema,
);
export const parseCommercePluginPreviewV1 = wireRecordParser(
  commercePluginPreviewV1Schema,
);
export const parseWirePluginDefinition = wireRecordParser(
  wirePluginDefinitionSchema,
);
export const parseWirePluginFields = wireRecordParser(pluginFieldsSchema);
export const parseWirePluginEntityTypes = wireRecordParser(
  pluginEntityTypesSchema,
);
export const parseWirePluginHandlers = wireRecordParser(pluginHandlersSchema);
export const parseWirePluginActions = wireRecordParser(pluginActionsSchema);
