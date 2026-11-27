// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { SafeInteger, StrictObject } from "@purin-labs/contract-schema";

/**
 * A stage of the checkout pipeline (step 2) that a built-in plugin adds a
 * step to.
 */
const checkoutStageSchema = Type.Union([
  Type.Literal("lines"),
  Type.Literal("market"),
  Type.Literal("discounts"),
  Type.Literal("tax"),
  Type.Literal("shipping"),
  Type.Literal("total"),
  Type.Literal("stored_value"),
  Type.Literal("amount_due"),
]);
export type CheckoutStage = Static<typeof checkoutStageSchema>;

const pluginSettingSchema = StrictObject({
  key: Type.String() /**
   * An entity plane value kind, such as `integer` or `text`.
   */,
  valueKind: Type.String(),
  description: Type.String(),
});

/**
 * Where a merchant plugin's function runs.
 */
const pluginHookPointSchema = Type.Union([
  Type.Literal("checkout.validate"),
  Type.Literal("checkout.discount"),
  Type.Literal("checkout.delivery"),
  Type.Literal("checkout.tenders"),
  Type.Literal("checkout.lines"),
  Type.Literal("machine.guard"),
]);

const pluginFunctionSchema = StrictObject({
  functionId: Type.String(),
  hookPoint: pluginHookPointSchema /**
   * A required validation function refuses the checkout when it fails;
   * any other failing function is skipped.
   */,
  required: Type.Boolean() /**
   * The JavaScript source.
   */,
  source: Type.String(),
});
export type PluginFunction = Static<typeof pluginFunctionSchema>;

const pluginContributionsSchema = StrictObject({
  /**
   * The route kinds that a built-in plugin owns.
   */
  routes: Type.Array(Type.String()) /**
   * The checkout stages that a built-in plugin adds a step to.
   */,
  pipelineSteps: Type.Array(checkoutStageSchema) /**
   * The entity plane types that the plugin adds.
   */,
  entityTypes: Type.Array(Type.String()),
  settings: Type.Array(pluginSettingSchema),
  functions: Type.Array(pluginFunctionSchema),
});

const pluginKindSchema = Type.Union([
  Type.Literal("built_in"),
  Type.Literal("merchant"),
]);

const pluginRequirementsSchema = StrictObject({
  /**
   * The hook points that the plugin's functions use.
   */
  hookPoints: Type.Array(pluginHookPointSchema) /**
   * The entity plane graph queries that its functions read, by name.
   */,
  reads: Type.Array(Type.String()) /**
   * The command kinds that its handlers and actions may submit.
   */,
  commands: Type.Array(Type.String()) /**
   * The plugins that must be active while this one is active.
   */,
  dependsOn: Type.Array(Type.String()),
});

const pluginLimitsSchema = StrictObject({
  /**
   * How many times QuickJS may check for an interrupt during one run. It
   * checks about every 10,000 bytecode steps, and the count is the same
   * for the same code and input.
   */
  instructionBudget: SafeInteger,
  memoryBytes: SafeInteger /**
   * The largest JSON output, in bytes.
   */,
  outputBytes: SafeInteger,
});
export type PluginLimits = Static<typeof pluginLimitsSchema>;

const pluginDefinitionSchema = StrictObject({
  /**
   * Lower case letters, digits and underscores; unique in a merchant.
   */
  pluginId: Type.String() /**
   * A version does not change after it is created.
   */,
  version: SafeInteger,
  kind: pluginKindSchema,
  title: Type.String() /**
   * One sentence for the approval card.
   */,
  purpose: Type.String() /**
   * The section of the Commerce spec that describes the plugin.
   */,
  specSection: Type.Optional(SafeInteger),
  requirements: pluginRequirementsSchema,
  contributions: pluginContributionsSchema /**
   * The caps of a merchant plugin's functions; none for a built-in plugin.
   */,
  limits: Type.Optional(pluginLimitsSchema),
});
export type PluginDefinition = Static<typeof pluginDefinitionSchema>;

/**
 * A merchant's state of one plugin. A paused or removed plugin keeps its
 * data; its routes answer 404 and its pipeline steps are skipped.
 */
const pluginStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("removed"),
]);
export type PluginState = Static<typeof pluginStateSchema>;
