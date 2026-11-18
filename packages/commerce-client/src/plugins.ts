// Plugins (Plan 77 step 3). A merchant's plugins are Commerce's built-in
// features, each with its state for that merchant. An agent lists them,
// previews a change, and pauses or resumes a plugin; a paused plugin's routes
// answer 404 and its checkout steps are skipped, and its data stays.
import type {
  CheckoutStage,
  PluginDefinition,
  PluginState,
} from "@seams/commerce-contracts";

import { type CommerceEngineTimestamp } from "./commerce-resources.ts";
import { type CommerceMutationErrorV1 } from "./mutations.ts";
import {
  parseConfigureCommercePluginV1 as parseConfigureCommercePluginV1Record,
  parseInstallCommerceMerchantPluginV1 as parseInstallCommerceMerchantPluginV1Record,
  parsePreviewCommerceMerchantPluginV1 as parsePreviewCommerceMerchantPluginV1Record,
  parsePreviewCommercePluginChangeV1 as parsePreviewCommercePluginChangeV1Record,
  parseRunCommercePluginActionV1 as parseRunCommercePluginActionV1Record,
  parseRunCommercePluginFunctionV1 as parseRunCommercePluginFunctionV1Record,
  parseSetCommercePluginFieldValuesV1 as parseSetCommercePluginFieldValuesV1Record,
  parseCommerceMerchantPluginPreviewV1 as parseCommerceMerchantPluginPreviewV1Record,
  parseCommercePluginCommandV1 as parseCommercePluginCommandV1Record,
  parseCommercePluginFieldValueListV1 as parseCommercePluginFieldValueListV1Record,
  parseCommercePluginFunctionRunV1 as parseCommercePluginFunctionRunV1Record,
  parseCommercePluginListV1 as parseCommercePluginListV1Record,
  parseCommercePluginPreviewV1 as parseCommercePluginPreviewV1Record,
  parseWirePluginActions,
  parseWirePluginDefinition,
  parseWirePluginFields,
  parseWirePluginHandlers,
} from "@seams/commerce-contracts/records/api-plugins";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;

/** A plugin as a merchant has it: its definition, state and revision. */
/** A merchant plugin function that failed and was skipped at a checkout. */
export type CommercePluginFailureV1 = Readonly<{
  version: number;
  /** `checkout.validate` and the other hooks, or `machine.guard`. */
  hookPoint: string;
  functionId: string;
  /** `refused`: the core refused the command that a handler returned. */
  reason:
    | "threw"
    | "budget"
    | "memory"
    | "invalid_output"
    | "unavailable"
    | "refused";
  message: string;
  /** The checkout, or the record of a guarded move. */
  subjectId: string;
  /** The plugin's failures in a row with this one; three pause it. */
  failuresInARow: number;
  occurredAt: CommerceEngineTimestamp;
}>;

/**
 * A field that a merchant plugin adds to a product, a variant or a customer
 * (an integer or a boolean only). Staff and agents set its values; only that
 * plugin's functions read them. A customer's values go when the customer is
 * erased.
 */
export type CommercePluginFieldV1 = Readonly<{
  entityType: "product" | "sellable_variant" | "customer";
  key: string;
  valueKind: "integer" | "text" | "boolean" | "text_list";
  description: string;
}>;

/**
 * An entity type that a merchant plugin adds to the entity plane. Commerce
 * publishes it at the installation; staff and agents add its records through
 * the entity plane, and the plugin's functions read the active ones as
 * `records`. The type and its records stay when the plugin is removed.
 */
export type CommercePluginEntityTypeV1 = Readonly<{
  typeId: string;
  label: string;
  description: string;
  attributes: readonly CommercePluginAttributeV1[];
}>;

export type CommercePluginAttributeV1 = Readonly<{
  key: string;
  label: string;
  valueKind: "short_text" | "integer" | "boolean" | "date" | "timestamp";
  required: boolean;
}>;

/**
 * A merchant plugin's event handler (step 5): a function that runs once for
 * each new event of the named kinds, after its commit, and returns at most
 * five commands, which the core applies all or none.
 */
export type CommercePluginHandlerV1 = Readonly<{
  handlerId: string;
  /** Event kinds, or a resource with `*`, such as `order.*`. */
  eventKinds: readonly string[];
  source: string;
}>;

/** An input of an action: a value kind, or `order` for an order's id. */
export type CommercePluginActionInputV1 = Readonly<{
  key: string;
  valueKind: "integer" | "text" | "boolean" | "text_list" | "order";
  description: string;
}>;

/**
 * A merchant plugin's action (step 5): staff or an agent run it with typed
 * inputs; its function returns refusals or at most five commands, which the
 * core applies all or none.
 */
export type CommercePluginActionV1 = Readonly<{
  actionId: string;
  title: string;
  inputs: readonly CommercePluginActionInputV1[];
  source: string;
}>;

export type CommercePluginV1 = PluginDefinition &
  Readonly<{
    state: PluginState;
    revision: number;
    /**
     * A built-in plugin's settings with its defaults for those that staff
     * did not set; a merchant plugin's settings as installed.
     */
    settings: CommercePluginSettingsV1;
    /** The fields that the plugin adds; none for a built-in plugin. */
    fields: readonly CommercePluginFieldV1[];
    handlers: readonly CommercePluginHandlerV1[];
    actions: readonly CommercePluginActionV1[];
    /** The newest failure of one of its functions, or null. */
    lastFailure: CommercePluginFailureV1 | null;
  }>;

export type CommercePluginListV1 = Readonly<{
  schemaVersion: "underclerk.plugins.v1";
  plugins: readonly CommercePluginV1[];
}>;

export type CommercePluginChangeV1 = "pause" | "resume";

/** What a plugin change would do, so that an agent can show it first. */
export type CommercePluginEffectV1 =
  | Readonly<{
      kind: "routes";
      /** After a pause the routes answer 404; after a resume they answer. */
      available: boolean;
      routes: readonly string[];
    }>
  | Readonly<{
      kind: "pipeline_steps";
      available: boolean;
      steps: readonly CheckoutStage[];
    }>
  | Readonly<{
      /** Gift card and store credit value that stays owed while paused. */
      kind: "open_balances";
      accounts: number;
      balances: readonly Money[];
    }>
  | Readonly<{ kind: "held_checkouts"; checkouts: number }>
  | Readonly<{ kind: "active_discounts"; discounts: number }>;

export type CommercePluginPreviewV1 = Readonly<{
  schemaVersion: "underclerk.plugin-preview.v1";
  pluginId: string;
  change: CommercePluginChangeV1;
  /** Why the change would be refused, or null when it would apply. */
  refusal: CommerceMutationErrorV1 | null;
  effects: readonly CommercePluginEffectV1[];
}>;

export type PreviewCommercePluginChangeV1 = Readonly<{
  schemaVersion: "underclerk.preview-plugin-change.v1";
  change: CommercePluginChangeV1;
}>;

type PluginCommandBase = Readonly<{
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  pluginId: string;
  expectedRevision: number;
}>;

export type PauseCommercePluginV1 = PluginCommandBase &
  Readonly<{ schemaVersion: "underclerk.pause-plugin.v1" }>;

export type ResumeCommercePluginV1 = PluginCommandBase &
  Readonly<{ schemaVersion: "underclerk.resume-plugin.v1" }>;

export type RemoveCommercePluginV1 = PluginCommandBase &
  Readonly<{ schemaVersion: "underclerk.remove-plugin.v1" }>;

export type CommercePluginCommandV1 =
  PauseCommercePluginV1 | ResumeCommercePluginV1 | RemoveCommercePluginV1;

/**
 * Sets a built-in plugin's settings: all of them, so that a setting that the
 * command leaves out goes back to the plugin's default.
 */
export type ConfigureCommercePluginV1 = PluginCommandBase &
  Readonly<{
    schemaVersion: "underclerk.configure-plugin.v1";
    settings: CommercePluginSettingsV1;
  }>;

/** A merchant plugin's setting: a number, text, a yes or no, or a text list. */
export type CommercePluginSettingValueV1 =
  number | string | boolean | readonly string[];

export type CommercePluginSettingsV1 = Readonly<
  Record<string, CommercePluginSettingValueV1>
>;

/**
 * Installs a merchant plugin, or a new version of one (step 4). A version
 * does not change after it is created; `expectedRevision` is null for a
 * plugin that the merchant does not have yet.
 */
export type InstallCommerceMerchantPluginV1 = Readonly<{
  schemaVersion: "underclerk.install-merchant-plugin.v1";
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  definition: PluginDefinition;
  settings: CommercePluginSettingsV1;
  /** The fields that this version adds; it replaces an earlier list. */
  fields?: readonly CommercePluginFieldV1[];
  /**
   * The entity types that this version adds, as `contributions.entityTypes`
   * names them. A version without the list keeps the types it had.
   */
  entityTypes?: readonly CommercePluginEntityTypeV1[];
  /** Its event handlers and actions; each list replaces an earlier one. */
  handlers?: readonly CommercePluginHandlerV1[];
  actions?: readonly CommercePluginActionV1[];
  expectedRevision: number | null;
}>;

/**
 * Sets a merchant plugin's field values on one product, variant or customer. A null
 * value removes the field's value; `expectedRevision` is null when the
 * record has no values yet.
 */
export type SetCommercePluginFieldValuesV1 = Readonly<{
  schemaVersion: "underclerk.set-plugin-field-values.v1";
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  pluginId: string;
  entityType: CommercePluginFieldV1["entityType"];
  entityId: string;
  values: Readonly<Record<string, CommercePluginSettingValueV1 | null>>;
  expectedRevision: number | null;
}>;

export type CommercePluginFieldValuesV1 = Readonly<{
  entityType: CommercePluginFieldV1["entityType"];
  entityId: string;
  revision: number;
  values: CommercePluginSettingsV1;
}>;

export type CommercePluginFieldValueListV1 = Readonly<{
  schemaVersion: "underclerk.plugin-field-values.v1";
  pluginId: string;
  fields: readonly CommercePluginFieldV1[];
  records: readonly CommercePluginFieldValuesV1[];
}>;

/** Runs a merchant plugin's action with its inputs. */
export type RunCommercePluginActionV1 = Readonly<{
  schemaVersion: "underclerk.run-plugin-action.v1";
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  pluginId: string;
  actionId: string;
  input: CommercePluginSettingsV1;
}>;

/** Runs one function of a draft definition on an input; it changes nothing. */
export type RunCommercePluginFunctionV1 = Readonly<{
  schemaVersion: "underclerk.run-plugin-function.v1";
  definition: PluginDefinition;
  /** A hook function, or a draft handler or action of the lists below. */
  functionId: string;
  settings: CommercePluginSettingsV1;
  /** The hook point's input without the settings, which the core adds. */
  input: unknown;
  /** Draft handlers and actions that a dry run may name (step 5). */
  handlers?: readonly CommercePluginHandlerV1[];
  actions?: readonly CommercePluginActionV1[];
}>;

/** A command that a dry run of a handler or an action would submit. */
export type CommercePluginCommandCheckV1 = Readonly<{
  kind: string;
  /** False when the requirements do not name it or its fields are wrong. */
  accepted: boolean;
  reason: string | null;
}>;

export type CommercePluginFunctionRunV1 = Readonly<{
  schemaVersion: "underclerk.plugin-function-run.v1";
  outcome:
    | Readonly<{ kind: "returned"; output: unknown }>
    | Readonly<{
        kind: "failed";
        reason:
          "threw" | "budget" | "memory" | "invalid_output" | "unavailable";
        message: string;
      }>;
  /** The interrupt checks that the run used (about 10,000 steps each). */
  polls: number;
  /** For a handler or an action: the commands that it would submit. */
  commands?: readonly CommercePluginCommandCheckV1[];
}>;

/** Runs a draft definition over the merchant's recent checkouts. */
export type PreviewCommerceMerchantPluginV1 = Readonly<{
  schemaVersion: "underclerk.preview-merchant-plugin.v1";
  definition: PluginDefinition;
  settings: CommercePluginSettingsV1;
}>;

export type CommerceMerchantPluginPreviewV1 = Readonly<{
  schemaVersion: "underclerk.merchant-plugin-preview.v1";
  pluginId: string;
  /** How many recent checkouts the functions ran on. */
  checkouts: number;
  refused: readonly Readonly<{
    checkoutId: string;
    functionId: string;
    messages: readonly string[];
  }>[];
  failed: readonly Readonly<{
    checkoutId: string;
    functionId: string;
    reason: string;
  }>[];
}>;

export function parsePluginCommand(value: unknown): CommercePluginCommandV1 {
  return decodeRecord(parseCommercePluginCommandV1Record, value);
}

export function parseConfigurePluginCommand(
  value: unknown,
): ConfigureCommercePluginV1 {
  return decodeRecord(parseConfigureCommercePluginV1Record, value);
}

export function parsePreviewPluginChangeCommand(
  value: unknown,
): PreviewCommercePluginChangeV1 {
  return decodeRecord(parsePreviewCommercePluginChangeV1Record, value);
}

export function parsePluginList(value: unknown): CommercePluginListV1 {
  return decodeRecord(parseCommercePluginListV1Record, value);
}

export function parsePluginPreview(value: unknown): CommercePluginPreviewV1 {
  return decodeRecord(parseCommercePluginPreviewV1Record, value);
}

/** At most 10 handlers with different ids. */
export function parsePluginHandlers(
  value: unknown,
  field = "handlers",
): readonly CommercePluginHandlerV1[] {
  return decodeRecord(parseWirePluginHandlers, value);
}

/** At most 10 actions with different ids and at most 10 inputs each. */
export function parsePluginActions(
  value: unknown,
  field = "actions",
): readonly CommercePluginActionV1[] {
  return decodeRecord(parseWirePluginActions, value);
}

export function parseRunPluginActionCommand(
  value: unknown,
): RunCommercePluginActionV1 {
  return decodeRecord(parseRunCommercePluginActionV1Record, value);
}

/** At most 20 fields with unique keys for each entity type. */
export function parsePluginFields(
  value: unknown,
  field = "fields",
): readonly CommercePluginFieldV1[] {
  return decodeRecord(parseWirePluginFields, value);
}

export function parseSetPluginFieldValuesCommand(
  value: unknown,
): SetCommercePluginFieldValuesV1 {
  return decodeRecord(parseSetCommercePluginFieldValuesV1Record, value);
}

export function parsePluginFieldValueList(
  value: unknown,
): CommercePluginFieldValueListV1 {
  return decodeRecord(parseCommercePluginFieldValueListV1Record, value);
}

/** A plugin definition, as an agent writes it for a merchant plugin. */
export function parsePluginDefinition(
  value: unknown,
  field = "definition",
): PluginDefinition {
  return decodeRecord(parseWirePluginDefinition, value);
}

export function parseInstallMerchantPluginCommand(
  value: unknown,
): InstallCommerceMerchantPluginV1 {
  return decodeRecord(parseInstallCommerceMerchantPluginV1Record, value);
}

export function parseRunPluginFunctionCommand(
  value: unknown,
): RunCommercePluginFunctionV1 {
  return decodeRecord(parseRunCommercePluginFunctionV1Record, value);
}

export function parsePreviewMerchantPluginCommand(
  value: unknown,
): PreviewCommerceMerchantPluginV1 {
  return decodeRecord(parsePreviewCommerceMerchantPluginV1Record, value);
}

export function parsePluginFunctionRun(
  value: unknown,
): CommercePluginFunctionRunV1 {
  return decodeRecord(parseCommercePluginFunctionRunV1Record, value);
}

export function parseMerchantPluginPreview(
  value: unknown,
): CommerceMerchantPluginPreviewV1 {
  return decodeRecord(parseCommerceMerchantPluginPreviewV1Record, value);
}
