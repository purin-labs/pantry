// Merchant plugins (Plan 77 step 4): definitions that an agent writes for one
// merchant, with settings and `checkout.validate` functions that run in
// QuickJS inside the checkout commit. A function returns refusals; only the
// core refuses the checkout. A function that fails is skipped unless it is
// required. The checkout's commit keeps each failure; a system commit after it
// reports the failure as an event, and the third failure in a row pauses the
// plugin in one more.
import type {
  CommerceMutationErrorV1,
  CommercePluginFieldV1,
  CommercePluginFieldValuesV1,
  CommercePluginSettingValueV1,
  CommercePluginSettingsV1,
} from "@purin-labs/commerce-client";
import {
  BUILT_IN_PLUGIN_IDS,
  type CheckoutPluginRun,
  type PluginDefinition,
  type PluginFunction,
  type PluginLimits,
  type PluginState,
} from "@purin-labs/commerce-contracts";

import { parseValidationOutput } from "@purin-labs/commerce-contracts/records/plugin-outputs";

import { sha256 } from "../commerce-authority/checkout-shared.ts";
import type { CommerceDatabase } from "../database.ts";
import {
  FUNCTION_CAPS,
  functionScope,
  type FunctionFailureReason,
  type FunctionRunOutcome,
} from "./function-runtime.ts";
import { PLUGIN_COMMANDS } from "./plugin-commands.ts";
import { readPluginRecords } from "./plugin-entity-types.ts";
import { readPluginState, writePluginState } from "./plugin-state.ts";

/** Failures in a row after which a merchant plugin pauses. */
export const FAILURES_BEFORE_PAUSE = 3;

const SUPPORTED_HOOK_POINTS = new Set([
  "machine.guard",
  "checkout.validate",
  "checkout.lines",
  "checkout.discount",
  "checkout.tenders",
  "checkout.delivery",
]);
const SETTING_KINDS = new Set(["integer", "text", "boolean", "text_list"]);
const MESSAGE_LENGTH = 300;

export type MerchantPluginInstallation = Readonly<{
  definition: PluginDefinition;
  version: number;
  settings: CommercePluginSettingsV1;
  failuresInARow: number;
  state: PluginState;
  revision: number;
}>;

/** What a `checkout.validate` function reads besides its settings. */
export type CheckoutValidationInput = Readonly<{
  checkoutId: string;
  kind: "pickup" | "shipping";
  quotedAt: string;
  currency: string;
  /** When a pickup is ready, or the latest delivery of a shipment. */
  readyBy: string;
  lines: readonly Readonly<{
    checkoutLineId: string;
    variantId: string | null;
    productId: string | null;
    sku: string | null;
    title: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }>[];
  subtotalMinor: number;
  totalMinor: number;
}>;

/** `refused`: the core refused the command that a handler or action returned. */
type PluginFailureReason = FunctionFailureReason | "refused";

/** A function that failed and was skipped, with why. */
export type PluginFunctionFailure = Readonly<{
  hookPoint: string;
  pluginId: string;
  version: number;
  functionId: string;
  reason: PluginFailureReason;
  message: string;
}>;

export type ValidationResult =
  | Readonly<{
      kind: "passed";
      runs: readonly CheckoutPluginRun[];
      failures: readonly PluginFunctionFailure[];
    }>
  | Readonly<{ kind: "refused"; error: CommerceMutationErrorV1 }>;

/**
 * Why a definition or its settings cannot be installed, or undefined.
 * `parts` counts the handlers and actions that the installation adds; a
 * plugin needs at least one function, handler or action.
 */
export function merchantPluginProblem(
  definition: PluginDefinition,
  settings: CommercePluginSettingsV1,
  parts = 0,
): CommerceMutationErrorV1 | undefined {
  const invalid = (field: string): CommerceMutationErrorV1 => ({
    code: "resource_relationship_invalid",
    field: `plugin.${field}`,
  });
  const { contributions, requirements, limits } = definition;
  if (
    definition.kind !== "merchant" ||
    !/^[a-z][a-z0-9_]{1,63}$/u.test(definition.pluginId) ||
    (BUILT_IN_PLUGIN_IDS as readonly string[]).includes(definition.pluginId)
  )
    return invalid("pluginId");
  if (
    limits === undefined ||
    limits.instructionBudget > FUNCTION_CAPS.instructionBudget ||
    limits.memoryBytes > FUNCTION_CAPS.memoryBytes ||
    limits.outputBytes > FUNCTION_CAPS.outputBytes
  )
    return invalid("limits");
  if (
    contributions.routes.length > 0 ||
    contributions.pipelineSteps.length > 0 ||
    contributions.entityTypes.length > 8 ||
    requirements.reads.length > 0 ||
    requirements.commands.some((command) => !PLUGIN_COMMANDS.includes(command))
  )
    return invalid("contributions");
  if (
    requirements.dependsOn.some(
      (dependency) =>
        !(BUILT_IN_PLUGIN_IDS as readonly string[]).includes(dependency),
    )
  )
    return invalid("dependsOn");
  const functionIds = new Set<string>();
  for (const fn of contributions.functions) {
    if (
      !SUPPORTED_HOOK_POINTS.has(fn.hookPoint) ||
      !requirements.hookPoints.includes(fn.hookPoint) ||
      functionIds.has(fn.functionId) ||
      fn.source.length > FUNCTION_CAPS.sourceBytes
    )
      return invalid("functions");
    functionIds.add(fn.functionId);
  }
  if (functionIds.size + parts === 0) return invalid("functions");
  const keys = new Set(contributions.settings.map((setting) => setting.key));
  if (
    keys.size !== contributions.settings.length ||
    Object.keys(settings).length !== keys.size ||
    contributions.settings.some(
      (setting) =>
        !SETTING_KINDS.has(setting.valueKind) ||
        !settingMatches(setting.valueKind, settings[setting.key]),
    )
  )
    return invalid("settings");
  return undefined;
}

export function settingMatches(kind: string, value: unknown): boolean {
  switch (kind) {
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "text":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "text_list":
      return (
        Array.isArray(value) && value.every((item) => typeof item === "string")
      );
    default:
      return false;
  }
}

export function readMerchantPluginVersion(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
  version: number,
): PluginDefinition | undefined {
  const row = database
    .prepare(
      `SELECT definition_json AS definitionJson FROM merchant_plugin_version
       WHERE merchant_id = ? AND plugin_id = ? AND version = ?`,
    )
    .get<Readonly<{ definitionJson: string }>>(merchantId, pluginId, version);
  return row === undefined
    ? undefined
    : (JSON.parse(row.definitionJson) as PluginDefinition);
}

export function listMerchantPlugins(
  database: CommerceDatabase,
  merchantId: string,
): readonly MerchantPluginInstallation[] {
  return database
    .prepare(
      `SELECT installation.plugin_id AS pluginId, installation.version AS version,
              installation.settings_json AS settingsJson,
              installation.failures_in_a_row AS failuresInARow,
              version.definition_json AS definitionJson
       FROM merchant_plugin_installation AS installation
       JOIN merchant_plugin_version AS version
         ON version.merchant_id = installation.merchant_id
        AND version.plugin_id = installation.plugin_id
        AND version.version = installation.version
       WHERE installation.merchant_id = ?
       ORDER BY installation.plugin_id`,
    )
    .all<
      Readonly<{
        pluginId: string;
        version: number;
        settingsJson: string;
        failuresInARow: number;
        definitionJson: string;
      }>
    >(merchantId)
    .map((row) => ({
      ...readPluginState(database, merchantId, row.pluginId),
      definition: JSON.parse(row.definitionJson) as PluginDefinition,
      version: row.version,
      // A merchant plugin's settings are its installation's.
      settings: JSON.parse(row.settingsJson) as CommercePluginSettingsV1,
      failuresInARow: row.failuresInARow,
    }));
}

/**
 * Writes an installation: the version (kept if it exists with the same
 * definition), the settings, and the next state revision. A first install is
 * active; a new version or settings keep the state that the plugin has, so
 * an upgrade does not resume a plugin that staff or its failures paused. A
 * paused plugin also keeps its failures in a row.
 */
export function writeMerchantPluginInstallation(
  database: CommerceDatabase,
  merchantId: string,
  definition: PluginDefinition,
  settings: CommercePluginSettingsV1,
  state: PluginState,
  revision: number,
  at: string,
): void {
  database
    .prepare(
      `INSERT INTO merchant_plugin_version (
         merchant_id, plugin_id, version, definition_json, created_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (merchant_id, plugin_id, version) DO NOTHING`,
    )
    .run(
      merchantId,
      definition.pluginId,
      definition.version,
      JSON.stringify(definition),
      at,
    );
  database
    .prepare(
      `INSERT INTO merchant_plugin_installation (
         merchant_id, plugin_id, version, settings_json, failures_in_a_row,
         installed_at
       ) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT (merchant_id, plugin_id) DO UPDATE SET
         version = excluded.version,
         settings_json = excluded.settings_json,
         failures_in_a_row = CASE WHEN ? = 'paused' THEN failures_in_a_row ELSE 0 END,
         installed_at = excluded.installed_at`,
    )
    .run(
      merchantId,
      definition.pluginId,
      definition.version,
      JSON.stringify(settings),
      at,
      state,
    );
  writePluginState(
    database,
    merchantId,
    definition.pluginId,
    { state, revision },
    at,
  );
}

/** How many function runs one request may need for this merchant. */
export function activeFunctionCount(
  database: CommerceDatabase,
  merchantId: string,
): number {
  return listMerchantPlugins(database, merchantId)
    .filter((plugin) => plugin.state === "active")
    .reduce(
      (sum, plugin) =>
        sum +
        plugin.definition.contributions.functions.length +
        // A request runs at most one action.
        Math.min(
          1,
          database
            .prepare(
              `SELECT COUNT(*) AS actions FROM merchant_plugin_action
               WHERE merchant_id = ? AND plugin_id = ?`,
            )
            .get<Readonly<{ actions: number }>>(
              merchantId,
              plugin.definition.pluginId,
            )?.actions ?? 0,
        ),
      0,
    );
}

/** Runs one function on the hook's input and the plugin's settings. */
export function runPluginFunction(
  fn: PluginFunction,
  limits: PluginLimits,
  settings: CommercePluginSettingsV1,
  input: unknown,
  at: string,
): FunctionRunOutcome {
  return runPluginSource(fn.source, limits, settings, input, at);
}

/** Runs one function source, such as a handler's or an action's. */
export function runPluginSource(
  source: string,
  limits: PluginLimits,
  settings: CommercePluginSettingsV1,
  input: unknown,
  at: string,
): FunctionRunOutcome {
  const vms = functionScope.getStore();
  return vms === undefined
    ? {
        kind: "failed",
        reason: "unavailable",
        message: "No function VM was prepared for this request",
        polls: 0,
      }
    : vms.run(source, { ...(input as object), settings }, limits, at);
}

/** The refusal messages of a `checkout.validate` output, or undefined. */
export const refusalMessages = parseValidationOutput;

/**
 * The `checkout.validate` stage: every active merchant plugin's functions
 * check the quote. The first refusal refuses the checkout; a function that
 * fails is skipped, or refuses the checkout when it is required.
 */
export function validateStage(
  database: CommerceDatabase,
  merchantId: string,
  checkout: CheckoutValidationInput,
  customerId: string | null,
): ValidationResult {
  const runs: CheckoutPluginRun[] = [];
  const failures: PluginFunctionFailure[] = [];
  for (const plugin of listMerchantPlugins(database, merchantId)) {
    if (plugin.state !== "active" || plugin.definition.limits === undefined)
      continue;
    for (const fn of plugin.definition.contributions.functions) {
      if (fn.hookPoint !== "checkout.validate") continue;
      const input = withPluginFields(
        database,
        merchantId,
        plugin.definition.pluginId,
        { hookPoint: fn.hookPoint, checkout },
        undefined,
        customerId,
      );
      const outcome = runPluginFunction(
        fn,
        plugin.definition.limits,
        plugin.settings,
        input,
        checkout.quotedAt,
      );
      const messages =
        outcome.kind === "returned"
          ? refusalMessages(outcome.output)
          : undefined;
      const refusal: CommerceMutationErrorV1 = {
        code: "checkout_refused",
        pluginId: plugin.definition.pluginId,
        message: "This checkout cannot be checked now. Try again later.",
      };
      if (messages !== undefined && messages.length > 0)
        return {
          kind: "refused",
          error: { ...refusal, message: messages[0] ?? refusal.message },
        };
      if (messages === undefined && fn.required)
        return { kind: "refused", error: refusal };
      if (messages === undefined)
        failures.push({
          hookPoint: fn.hookPoint,
          pluginId: plugin.definition.pluginId,
          version: plugin.version,
          functionId: fn.functionId,
          reason: outcome.kind === "failed" ? outcome.reason : "invalid_output",
          message:
            outcome.kind === "failed"
              ? outcome.message
              : "The output names no refusals list",
        });
      runs.push({
        pluginId: plugin.definition.pluginId,
        version: plugin.version,
        functionId: fn.functionId,
        codeDigest: sha256(fn.source),
        inputDigest: sha256(
          JSON.stringify({ ...input, settings: plugin.settings }),
        ),
        outcome: messages === undefined ? "skipped" : "passed",
      });
    }
  }
  return { kind: "passed", runs, failures };
}

/**
 * Counts each plugin's failures in a row from the runs on one subject (a
 * committed quote, in its transaction, or a guarded move), and keeps each
 * failure for its report. `attempt` tells apart two runs on one subject.
 */
export function recordFunctionRuns(
  database: CommerceDatabase,
  merchantId: string,
  subject: Readonly<{ id: string; attempt: string }>,
  runs: readonly CheckoutPluginRun[],
  failures: readonly PluginFunctionFailure[],
  at: string,
): void {
  const byPlugin = new Map<string, boolean>();
  for (const run of runs)
    byPlugin.set(
      run.pluginId,
      (byPlugin.get(run.pluginId) ?? false) || run.outcome === "skipped",
    );
  for (const [pluginId, failed] of byPlugin)
    database
      .prepare(
        `UPDATE merchant_plugin_installation
         SET failures_in_a_row = CASE WHEN ? THEN failures_in_a_row + 1 ELSE 0 END
         WHERE merchant_id = ? AND plugin_id = ?`,
      )
      .run(failed ? 1 : 0, merchantId, pluginId);
  for (const failure of failures) {
    const inARow =
      database
        .prepare(
          `SELECT failures_in_a_row AS failures FROM merchant_plugin_installation
           WHERE merchant_id = ? AND plugin_id = ?`,
        )
        .get<Readonly<{ failures: number }>>(merchantId, failure.pluginId)
        ?.failures ?? 0;
    database
      .prepare(
        `INSERT OR IGNORE INTO plugin_failure (
           merchant_id, failure_id, plugin_id, version, hook_point,
           function_id, reason, message, subject_id, failures_in_a_row,
           occurred_at, reported_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        merchantId,
        `plugin_failure_${sha256(
          `${subject.id}:${subject.attempt}:${failure.pluginId}:${failure.functionId}`,
        )}`,
        failure.pluginId,
        failure.version,
        failure.hookPoint,
        failure.functionId,
        failure.reason,
        failure.message.slice(0, 500),
        subject.id,
        inARow,
        at,
      );
  }
}

export type StoredPluginFailure = Readonly<{
  merchantId: string;
  failureId: string;
  pluginId: string;
  version: number;
  functionId: string;
  reason: PluginFailureReason;
  message: string;
  hookPoint: string;
  subjectId: string;
  failuresInARow: number;
  occurredAt: string;
}>;

const FAILURE_COLUMNS = `SELECT merchant_id AS merchantId, failure_id AS failureId,
  plugin_id AS pluginId, version, function_id AS functionId, reason, message,
  hook_point AS hookPoint, subject_id AS subjectId,
  failures_in_a_row AS failuresInARow,
  occurred_at AS occurredAt FROM plugin_failure`;

/** Failures that no event reports yet, oldest first. */
export function unreportedFailures(
  database: CommerceDatabase,
  limit: number,
): readonly StoredPluginFailure[] {
  return database
    .prepare(
      `${FAILURE_COLUMNS} WHERE reported_at IS NULL
       ORDER BY occurred_at, rowid LIMIT ?`,
    )
    .all<StoredPluginFailure>(limit);
}

export function markFailureReported(
  database: CommerceDatabase,
  merchantId: string,
  failureId: string,
  at: string,
): void {
  database
    .prepare(
      `UPDATE plugin_failure SET reported_at = ?
       WHERE merchant_id = ? AND failure_id = ?`,
    )
    .run(at, merchantId, failureId);
}

/** A plugin's newest failure, or undefined. */
export function lastFailure(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
): StoredPluginFailure | undefined {
  return database
    .prepare(
      `${FAILURE_COLUMNS} WHERE merchant_id = ? AND plugin_id = ?
       ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
    )
    .get<StoredPluginFailure>(merchantId, pluginId);
}

/** The fields that a merchant plugin adds, in declaration order. */
export function listPluginFields(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
): readonly CommercePluginFieldV1[] {
  return database
    .prepare(
      `SELECT entity_type AS entityType, field_key AS key,
              value_kind AS valueKind, description
       FROM merchant_plugin_field
       WHERE merchant_id = ? AND plugin_id = ? ORDER BY position`,
    )
    .all<CommercePluginFieldV1>(merchantId, pluginId);
}

/** Replaces a plugin's fields; values of a dropped field stay stored. */
export function writePluginFields(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
  fields: readonly CommercePluginFieldV1[],
): void {
  database
    .prepare(
      "DELETE FROM merchant_plugin_field WHERE merchant_id = ? AND plugin_id = ?",
    )
    .run(merchantId, pluginId);
  fields.forEach((field, position) =>
    database
      .prepare(
        `INSERT INTO merchant_plugin_field (
           merchant_id, plugin_id, entity_type, field_key, value_kind,
           description, position
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        pluginId,
        field.entityType,
        field.key,
        field.valueKind,
        field.description,
        position,
      ),
  );
}

export function listPluginFieldValues(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
): readonly CommercePluginFieldValuesV1[] {
  return database
    .prepare(
      `SELECT entity_type AS entityType, entity_id AS entityId, revision,
              values_json AS valuesJson
       FROM merchant_plugin_field_values
       WHERE merchant_id = ? AND plugin_id = ?
       ORDER BY entity_type, entity_id`,
    )
    .all<
      Readonly<{
        entityType: CommercePluginFieldV1["entityType"];
        entityId: string;
        revision: number;
        valuesJson: string;
      }>
    >(merchantId, pluginId)
    .map(({ valuesJson, ...row }) => ({
      ...row,
      values: JSON.parse(valuesJson) as CommercePluginSettingsV1,
    }));
}

export function writePluginFieldValues(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
  record: CommercePluginFieldValuesV1,
  at: string,
): void {
  database
    .prepare(
      `INSERT INTO merchant_plugin_field_values (
         merchant_id, plugin_id, entity_type, entity_id, revision,
         values_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (merchant_id, plugin_id, entity_type, entity_id) DO UPDATE
       SET revision = excluded.revision, values_json = excluded.values_json,
           updated_at = excluded.updated_at`,
    )
    .run(
      merchantId,
      pluginId,
      record.entityType,
      record.entityId,
      record.revision,
      JSON.stringify(record.values),
      at,
    );
}

/** Whether a value has a field's kind. */
export function fieldValueMatches(
  kind: CommercePluginFieldV1["valueKind"],
  value: CommercePluginSettingValueV1,
): boolean {
  switch (kind) {
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "text":
      return typeof value === "string" && value.length <= MESSAGE_LENGTH;
    case "boolean":
      return typeof value === "boolean";
    case "text_list":
      return (
        Array.isArray(value) &&
        value.length <= 50 &&
        value.every((item) => item.length <= MESSAGE_LENGTH)
      );
  }
}

/**
 * Adds a plugin's own data to a hook input: its field values on the lines, as
 * `productFields` and `variantFields`, on an order's customer, as the
 * order's `customerFields` (when the caller can name an order's customer),
 * on a checkout's buyer, as the checkout's `customerFields` (when the caller
 * passes the buyer: a guest has none), and the records of its entity types,
 * as `records`. An input stays as it
 * is for a plugin that adds neither, so its runs and digests do not change.
 */
export function withPluginFields(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
  input: Readonly<Record<string, unknown>>,
  customerOfOrder?: (orderId: string) => string | null,
  checkoutCustomer?: string | null,
): Readonly<Record<string, unknown>> {
  const records = readPluginRecords(database, merchantId, pluginId);
  const withRecords = records === undefined ? input : { ...input, records };
  if (listPluginFields(database, merchantId, pluginId).length === 0)
    return withRecords;
  const values = new Map(
    listPluginFieldValues(database, merchantId, pluginId).map((record) => [
      `${record.entityType}:${record.entityId}`,
      record.values,
    ]),
  );
  const lines = (raw: unknown) =>
    Array.isArray(raw)
      ? raw.map((line: Record<string, unknown>) => ({
          ...line,
          productFields:
            typeof line.productId === "string"
              ? (values.get(`product:${line.productId}`) ?? {})
              : {},
          variantFields:
            typeof line.variantId === "string"
              ? (values.get(`sellable_variant:${line.variantId}`) ?? {})
              : {},
        }))
      : raw;
  const withLines = (part: unknown) =>
    typeof part === "object" && part !== null && "lines" in part
      ? { ...part, lines: lines((part as { lines: unknown }).lines) }
      : part;
  // A plugin reads its values on an order's customer, never the customer.
  const withCustomer = (order: unknown) => {
    const withOrderLines = withLines(order);
    if (
      customerOfOrder === undefined ||
      typeof withOrderLines !== "object" ||
      withOrderLines === null ||
      !("id" in withOrderLines) ||
      typeof withOrderLines.id !== "string"
    )
      return withOrderLines;
    const customerId = customerOfOrder(withOrderLines.id);
    return {
      ...withOrderLines,
      customerFields:
        customerId === null ? {} : (values.get(`customer:${customerId}`) ?? {}),
    };
  };
  return {
    ...withRecords,
    ...("checkout" in input
      ? {
          checkout:
            checkoutCustomer === undefined
              ? withLines(input.checkout)
              : {
                  ...(withLines(input.checkout) as object),
                  customerFields:
                    checkoutCustomer === null
                      ? {}
                      : (values.get(`customer:${checkoutCustomer}`) ?? {}),
                },
        }
      : {}),
    ...("subject" in input ? { subject: withLines(input.subject) } : {}),
    ...("order" in input ? { order: withCustomer(input.order) } : {}),
  };
}

/** Removes every plugin's values on one record, as an erasure does. */
export function deletePluginFieldValuesOf(
  database: CommerceDatabase,
  merchantId: string,
  entityType: CommercePluginFieldV1["entityType"],
  entityId: string,
): void {
  database
    .prepare(
      `DELETE FROM merchant_plugin_field_values
       WHERE merchant_id = ? AND entity_type = ? AND entity_id = ?`,
    )
    .run(merchantId, entityType, entityId);
}
