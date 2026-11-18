// The commands and reads of a merchant's plugins (Plan 77 steps 3 and 4):
// the list, a preview of a pause or a resume, the change itself, and for a
// merchant plugin the installation, a dry run of one function and a run over
// recent checkouts. A pause is refused while an active plugin depends on the
// plugin; a resume is refused while a plugin that it depends on is paused.
// A merchant plugin function that fails is reported by a system commit after
// the checkout that ran it, and the third failure in a row pauses the plugin
// in a second one. A merchant plugin's event handlers run after the commit,
// from the alarm and after each request; its actions run when a caller names
// them (step 5). Staff set a built-in plugin's settings by a command of their
// own; a merchant plugin's settings come with its installation.
import {
  parseConfigurePluginCommand,
  parseInstallMerchantPluginCommand,
  parsePluginCommand,
  parsePreviewMerchantPluginCommand,
  parsePreviewPluginChangeCommand,
  parseRunPluginActionCommand,
  parseRunPluginFunctionCommand,
  parseSetPluginFieldValuesCommand,
  type ConfigureCommercePluginV1,
  type InstallCommerceMerchantPluginV1,
  type CommerceResourcesV1,
  type CommerceEventV1,
  type CommerceMerchantPluginPreviewV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
  type CommercePluginChangeV1,
  type CommercePluginCommandV1,
  type CommercePluginEffectV1,
  type CommercePluginCommandCheckV1,
  type CommercePluginFunctionRunV1,
  type CommercePluginListV1,
  type CommercePluginFieldValueListV1,
  type CommercePluginPreviewV1,
  type CommercePluginActionV1,
  type CommercePluginSettingsV1,
  type RunCommercePluginActionV1,
  type SetCommercePluginFieldValuesV1,
} from "@seams/commerce-client";
import {
  BUILT_IN_PLUGINS,
  commerceTransition,
  type PluginDefinition,
  type PluginState,
} from "@seams/commerce-contracts";

import {
  listRecentCheckoutIds,
  readCheckout,
} from "../checkout-persistence.ts";
import { checkoutValidationInput } from "../commerce-authority/checkout-pipeline.ts";
import type { CommerceDatabase } from "../database.ts";
import {
  headCursor,
  readEventPage,
  receiptsByDelivery,
} from "../event-feed.ts";
import { commandPrincipal } from "./command-principal.ts";
import {
  FUNCTION_CAPS,
  functionScope,
  type PreparedFunctionVms,
} from "./function-runtime.ts";
import {
  FAILURES_BEFORE_PAUSE,
  fieldValueMatches,
  lastFailure,
  listMerchantPlugins,
  listPluginFieldValues,
  withPluginFields,
  listPluginFields,
  markFailureReported,
  merchantPluginProblem,
  readMerchantPluginVersion,
  refusalMessages,
  recordFunctionRuns,
  runPluginFunction,
  runPluginSource,
  unreportedFailures,
  writeMerchantPluginInstallation,
  writePluginFieldValues,
  writePluginFields,
  type MerchantPluginInstallation,
  type PluginFunctionFailure,
  type StoredPluginFailure,
} from "./merchant-plugins.ts";
import {
  handlerMerchantIds,
  listPluginActions,
  moveHandlerCursor,
  namesEventKind,
  operationCommand,
  parseRunOutput,
  PLUGIN_COMMANDS,
  storedHandlers,
  writePluginActions,
  writePluginHandlers,
  type PluginOperation,
  type StoredHandler,
} from "./plugin-commands.ts";
import {
  entityTypeOwner,
  planPluginEntityTypes,
  writePluginEntityTypes,
} from "./plugin-entity-types.ts";
import { readPluginState, writePluginState } from "./plugin-state.ts";
import {
  builtInPlugin,
  builtInPluginSettings,
  builtInSettingsProblem,
  pluginOfRoute,
  type BuiltInPlugin,
} from "./registry.ts";

/** The most function runs that one preview over recent checkouts makes. */
const PREVIEW_RUNS = 200;

/** The most handler runs of one pass; the rest wait for the next pass. */
export const HANDLER_RUNS = 50;

export type PluginMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

/**
 * The system commands of a function failure: its report, and the pause at
 * the third failure in a row. Commerce makes them; no route takes them.
 */
export type PluginFailureCommand = Readonly<{
  schemaVersion:
    | "underclerk.report-plugin-function-failure.internal.v1"
    | "underclerk.pause-failing-plugin.internal.v1";
  merchantId: string;
  idempotencyKey: string;
  requestedAt: string;
  pluginId: string;
  failureId: string;
}>;

export type PluginCommand =
  | CommercePluginCommandV1
  | ConfigureCommercePluginV1
  | RunCommercePluginActionV1
  | InstallCommerceMerchantPluginV1
  | PluginFailureCommand
  | SetCommercePluginFieldValuesV1;

export type PluginCommitRequest = Readonly<{
  command: PluginCommand;
  merchant: PluginMerchantRow;
  pluginId: string;
  revision: number;
  /** The receipt's resource, when it is not the plugin itself. */
  resource?: Readonly<{
    kind: "plugin_field_values";
    id: string;
    revision: number;
  }>;
  write: () => void;
}>;

export type PluginAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  readMerchant: (merchantId: string) => PluginMerchantRow | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: PluginCommand,
  ) => CommerceMutationResultV1 | undefined;
  validateMerchant: (
    merchantId: string,
    merchant: PluginMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
  commit: (request: PluginCommitRequest) => CommerceMutationResultV1;
  /** What pausing a plugin leaves behind, from the plugin's own records. */
  dataEffects: (
    merchantId: string,
    pluginId: string,
  ) => readonly CommercePluginEffectV1[];
  /** Clean function VMs, or undefined when the host runs no functions. */
  prepareVms: (count: number) => Promise<PreparedFunctionVms> | undefined;
  readVariants: (
    merchantId: string,
  ) => CommerceResourcesV1["variants"];
  readProductIds: (merchantId: string) => readonly string[];
  /** Whether a customer of the merchant exists, for its plugin fields. */
  customerExists: (merchantId: string, customerId: string) => boolean;
  /** The result stored under an idempotency key, whatever its command. */
  readReceipt: (
    merchantId: string,
    idempotencyKey: string,
  ) => CommerceMutationResultV1 | undefined;
  /** Applies a command that a plugin returned, as a staff call would. */
  applyCommand: (command: unknown) => CommerceMutationResultV1;
  /**
   * An order as a handler or an action reads it, by its id or the id of its
   * fulfillment, or undefined.
   */
  readOrder: (
    merchantId: string,
    id: string,
  ) => Readonly<Record<string, unknown>> | undefined;
  /** An order's customer and its currency, or undefined. */
  readOrderBuyer: (
    merchantId: string,
    orderId: string,
  ) => Readonly<{ customerId: string; currency: string }> | undefined;
}>;

type KnownPlugin = Readonly<{
  definition: PluginDefinition;
  state: PluginState;
  revision: number;
  /** What staff set for a built-in plugin; a merchant plugin's as installed. */
  settings: CommercePluginSettingsV1;
}>;

type PlannedChange = Readonly<{ revision: number; to: PluginState }>;

export class PluginAuthority {
  readonly #options: PluginAuthorityOptions;

  constructor(options: PluginAuthorityOptions) {
    this.#options = options;
  }

  listPlugins(merchantId: string): CommercePluginListV1 {
    return {
      schemaVersion: "underclerk.plugins.v1",
      plugins: this.#all(merchantId).map((plugin) => {
        const failure = lastFailure(
          this.#options.database,
          merchantId,
          plugin.definition.pluginId,
        );
        return {
          ...plugin.definition,
          state: plugin.state,
          revision: plugin.revision,
          settings: isBuiltIn(plugin.definition)
            ? builtInPluginSettings(plugin.definition.pluginId, plugin.settings)
            : plugin.settings,
          fields:
            plugin.definition.kind === "merchant"
              ? listPluginFields(
                  this.#options.database,
                  merchantId,
                  plugin.definition.pluginId,
                )
              : [],
          handlers: storedHandlers(
            this.#options.database,
            merchantId,
            plugin.definition.pluginId,
          ).map(({ handlerId, eventKinds, source }) => ({
            handlerId,
            eventKinds,
            source,
          })),
          actions: listPluginActions(
            this.#options.database,
            merchantId,
            plugin.definition.pluginId,
          ),
          lastFailure:
            failure === undefined
              ? null
              : {
                  version: failure.version,
                  functionId: failure.functionId,
                  reason: failure.reason,
                  message: failure.message,
                  hookPoint: failure.hookPoint,
                  subjectId: failure.subjectId,
                  failuresInARow: failure.failuresInARow,
                  occurredAt: failure.occurredAt,
                },
        };
      }),
    };
  }

  /**
   * Reports the function failures that no event names yet: one system
   * commit for each (`plugin.function_failed`), and at the third failure in a
   * row of an active plugin one more that pauses it (`plugin.paused`).
   * Returns the number of failures reported. Runs after each request and
   * from the alarm; a repeat after a lost write finds the receipts.
   */
  reportFailures(): number {
    const { database } = this.#options;
    let reported = 0;
    for (const failure of unreportedFailures(database, 20)) {
      const merchant = this.#options.readMerchant(failure.merchantId);
      if (merchant === undefined) continue;
      // The pause is the machine's `auto_pause`, with the guards of a staff
      // pause; a plugin that is not active, or that an active plugin needs,
      // keeps its state and the failure is only reported.
      const pause =
        failure.failuresInARow >= FAILURES_BEFORE_PAUSE &&
        !(
          "code" in
          this.#plan(failure.merchantId, failure.pluginId, "auto_pause")
        );
      const report = this.#failureCommand(
        failure,
        merchant,
        "underclerk.report-plugin-function-failure.internal.v1",
      );
      if (
        this.#options.readReplay(
          failure.merchantId,
          report.idempotencyKey,
          report,
        ) === undefined
      )
        this.#options.commit({
          command: report,
          merchant,
          pluginId: failure.pluginId,
          revision: readPluginState(
            database,
            failure.merchantId,
            failure.pluginId,
          ).revision,
          write: () => {
            if (!pause)
              markFailureReported(
                database,
                failure.merchantId,
                failure.failureId,
                report.requestedAt,
              );
          },
        });
      if (pause) {
        const planned = this.#plan(
          failure.merchantId,
          failure.pluginId,
          "auto_pause",
        );
        const after = this.#options.readMerchant(failure.merchantId);
        if ("code" in planned || after === undefined) continue;
        this.#options.commit({
          command: this.#failureCommand(
            failure,
            after,
            "underclerk.pause-failing-plugin.internal.v1",
          ),
          merchant: after,
          pluginId: failure.pluginId,
          revision: planned.revision,
          write: () => {
            writePluginState(
              database,
              failure.merchantId,
              failure.pluginId,
              { state: planned.to, revision: planned.revision },
              report.requestedAt,
            );
            markFailureReported(
              database,
              failure.merchantId,
              failure.failureId,
              report.requestedAt,
            );
          },
        });
      }
      reported += 1;
    }
    return reported;
  }

  #failureCommand(
    failure: StoredPluginFailure,
    merchant: PluginMerchantRow,
    schemaVersion: PluginFailureCommand["schemaVersion"],
  ): PluginFailureCommand {
    const key = `${schemaVersion === "underclerk.pause-failing-plugin.internal.v1" ? "plugin_pause" : "plugin_failure_report"}_${failure.failureId}`;
    return {
      schemaVersion,
      merchantId: failure.merchantId,
      idempotencyKey: key,
      requestedAt: failure.occurredAt,
      pluginId: failure.pluginId,
      failureId: failure.failureId,
    };
  }

  /** The plugin that owns a route, when it is not active for the merchant. */
  inactivePluginOfRoute(
    merchantId: string,
    routeKind: string,
  ): BuiltInPlugin | undefined {
    const plugin = pluginOfRoute(routeKind);
    return plugin === undefined ||
      readPluginState(this.#options.database, merchantId, plugin.pluginId)
        .state === "active"
      ? undefined
      : plugin;
  }

  /** Undefined when the merchant has no such plugin. */
  previewPluginChange(
    merchantId: string,
    pluginId: string,
    rawCommand: unknown,
  ): CommercePluginPreviewV1 | undefined {
    const plugin = this.#known(merchantId, pluginId);
    if (plugin === undefined) return undefined;
    const { change } = parsePreviewPluginChangeCommand(rawCommand);
    const planned = this.#plan(merchantId, pluginId, change);
    const available = change === "resume";
    const { routes, pipelineSteps } = plugin.definition.contributions;
    return {
      schemaVersion: "underclerk.plugin-preview.v1",
      pluginId,
      change,
      refusal: "code" in planned ? planned : null,
      effects: [
        ...(routes.length === 0
          ? []
          : [{ kind: "routes" as const, available, routes }]),
        ...(pipelineSteps.length === 0
          ? []
          : [
              {
                kind: "pipeline_steps" as const,
                available,
                steps: pipelineSteps,
              },
            ]),
        ...this.#options.dataEffects(merchantId, pluginId),
      ],
    };
  }

  changePlugin(rawCommand: unknown): CommerceMutationResultV1 {
    let command: CommercePluginCommandV1;
    try {
      command = parsePluginCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const admitted = this.#admit(command);
    if ("outcome" in admitted) return admitted;
    const plugin = this.#known(command.merchantId, command.pluginId);
    if (plugin !== undefined && plugin.revision !== command.expectedRevision)
      return this.#options.rejected({
        code: "stale_resource_revision",
        kind: "plugin",
        id: command.pluginId,
        expected: command.expectedRevision,
        actual: plugin.revision,
      });
    const planned = this.#plan(
      command.merchantId,
      command.pluginId,
      command.schemaVersion === "underclerk.pause-plugin.v1"
        ? "pause"
        : command.schemaVersion === "underclerk.resume-plugin.v1"
          ? "resume"
          : "remove",
    );
    if ("code" in planned) return this.#options.rejected(planned);
    return this.#options.commit({
      command,
      merchant: admitted,
      pluginId: command.pluginId,
      revision: planned.revision,
      write: () =>
        writePluginState(
          this.#options.database,
          command.merchantId,
          command.pluginId,
          { state: planned.to, revision: planned.revision },
          command.requestedAt,
        ),
    });
  }

  /**
   * Sets all of a built-in plugin's settings; one that the command leaves
   * out goes back to the plugin's default. The plugin keeps its state.
   */
  configurePlugin(rawCommand: unknown): CommerceMutationResultV1 {
    let command: ConfigureCommercePluginV1;
    try {
      command = parseConfigurePluginCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const admitted = this.#admit(command);
    if ("outcome" in admitted) return admitted;
    const plugin = this.#known(command.merchantId, command.pluginId);
    if (plugin === undefined)
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "plugin",
        id: command.pluginId,
      });
    if (plugin.revision !== command.expectedRevision)
      return this.#options.rejected({
        code: "stale_resource_revision",
        kind: "plugin",
        id: command.pluginId,
        expected: command.expectedRevision,
        actual: plugin.revision,
      });
    const problem = !isBuiltIn(plugin.definition)
      ? "kind"
      : plugin.state === "removed"
        ? "removed"
        : builtInSettingsProblem(plugin.definition, command.settings);
    if (problem !== undefined)
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: `plugin.${problem}`,
      });
    const revision = plugin.revision + 1;
    return this.#options.commit({
      command,
      merchant: admitted,
      pluginId: command.pluginId,
      revision,
      write: () =>
        writePluginState(
          this.#options.database,
          command.merchantId,
          command.pluginId,
          { state: plugin.state, revision, settings: command.settings },
          command.requestedAt,
        ),
    });
  }

  /**
   * Installs a merchant plugin, or a version or settings of one. A first
   * install is active; a later one keeps the plugin's state, so a paused
   * plugin stays paused until staff resume it.
   */
  installMerchantPlugin(rawCommand: unknown): CommerceMutationResultV1 {
    let command: InstallCommerceMerchantPluginV1;
    try {
      command = parseInstallMerchantPluginCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const admitted = this.#admit(command);
    if ("outcome" in admitted) return admitted;
    const { database } = this.#options;
    const { definition, settings, merchantId } = command;
    const invalid = (field: string) =>
      this.#options.rejected({
        code: "resource_relationship_invalid",
        field: `plugin.${field}`,
      });
    if (this.#options.prepareVms(0) === undefined) return invalid("runtime");
    // A version without a handler or action list keeps the one it had.
    const handlers =
      command.handlers ??
      storedHandlers(database, merchantId, definition.pluginId);
    const actions =
      command.actions ??
      listPluginActions(database, merchantId, definition.pluginId);
    const problem = merchantPluginProblem(
      definition,
      settings,
      handlers.length + actions.length,
    );
    if (problem !== undefined) return this.#options.rejected(problem);
    if (
      [...handlers, ...actions].some(
        (part) => part.source.length > FUNCTION_CAPS.sourceBytes,
      )
    )
      return invalid("functions");
    const installed = this.#known(merchantId, definition.pluginId);
    if (installed === undefined && command.expectedRevision !== null)
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "plugin",
        id: definition.pluginId,
      });
    if (installed !== undefined) {
      if (command.expectedRevision !== installed.revision)
        return this.#options.rejected({
          code: "stale_resource_revision",
          kind: "plugin",
          id: definition.pluginId,
          expected: command.expectedRevision ?? 0,
          actual: installed.revision,
        });
      if (installed.state === "removed") return invalid("removed");
      if (definition.version < installed.definition.version)
        return invalid("version");
    }
    // A version never changes after it is created.
    const stored = readMerchantPluginVersion(
      database,
      merchantId,
      definition.pluginId,
      definition.version,
    );
    if (
      stored !== undefined &&
      JSON.stringify(stored) !== JSON.stringify(definition)
    )
      return invalid("version");
    if (
      definition.requirements.dependsOn.some(
        (dependency) =>
          readPluginState(database, merchantId, dependency).state !== "active",
      )
    )
      return invalid("dependencies");
    // The types that the version names come with it, or are the plugin's
    // own already.
    const namedTypes = definition.contributions.entityTypes;
    if (
      command.entityTypes === undefined
        ? namedTypes.some(
            (typeId) =>
              entityTypeOwner(database, merchantId, typeId) !==
              definition.pluginId,
          )
        : JSON.stringify(command.entityTypes.map((type) => type.typeId)) !==
          JSON.stringify(namedTypes)
    )
      return invalid("entityTypes");
    const typeWrites = planPluginEntityTypes(
      database,
      merchantId,
      definition.pluginId,
      command.entityTypes ?? [],
    );
    if (typeWrites === "entityTypes") return invalid(typeWrites);
    const revision = (installed?.revision ?? 1) + 1;
    return this.#options.commit({
      command,
      merchant: admitted,
      pluginId: definition.pluginId,
      revision,
      write: () => {
        writePluginEntityTypes(
          database,
          merchantId,
          definition.pluginId,
          typeWrites,
          admitted.revision + 1,
          command.requestedAt,
        );
        writeMerchantPluginInstallation(
          database,
          merchantId,
          definition,
          settings,
          installed?.state ?? "active",
          revision,
          command.requestedAt,
        );
        // A version without a field list keeps the fields it had.
        if (command.fields !== undefined)
          writePluginFields(
            database,
            merchantId,
            definition.pluginId,
            command.fields,
          );
        // A new handler reads the events after this installation.
        if (command.handlers !== undefined)
          writePluginHandlers(
            database,
            merchantId,
            definition.pluginId,
            command.handlers,
            headCursor(database, merchantId),
          );
        if (command.actions !== undefined)
          writePluginActions(
            database,
            merchantId,
            definition.pluginId,
            command.actions,
          );
      },
    });
  }

  /**
   * Runs the event handlers of active merchant plugins on the events after
   * each handler's cursor, at most HANDLER_RUNS in one pass, and returns the
   * number of runs. A handler skips the events of commands that a handler
   * submitted, so no handler starts a chain. A command keeps the key of its
   * event and plugin version: a pass after a lost cursor finds its receipt.
   */
  async runHandlers(): Promise<number> {
    if (this.#handlerWork(HANDLER_RUNS).length === 0) return 0;
    const vms = await this.#options.prepareVms(HANDLER_RUNS);
    if (vms === undefined) return 0;
    try {
      // The cursors are read again: another pass may have moved them.
      return functionScope.run(vms, () => {
        let runs = 0;
        for (const work of this.#handlerWork(HANDLER_RUNS)) {
          this.#handle(work);
          if (work.matches) runs += 1;
        }
        return runs;
      });
    } finally {
      vms.dispose();
    }
  }

  /** The next events of each handler, in order, up to `limit` runs. */
  #handlerWork(limit: number): readonly HandlerWork[] {
    const { database } = this.#options;
    const work: HandlerWork[] = [];
    let runs = 0;
    for (const merchantId of handlerMerchantIds(database)) {
      const plugins = listMerchantPlugins(database, merchantId);
      for (const handler of storedHandlers(database, merchantId)) {
        const plugin = plugins.find(
          (candidate) => candidate.definition.pluginId === handler.pluginId,
        );
        // A paused plugin's handlers wait at their cursor.
        if (plugin?.state !== "active") continue;
        const { events } = readEventPage(
          database,
          merchantId,
          handler.cursor,
          limit,
        );
        const receipts = receiptsByDelivery(
          database,
          merchantId,
          events.map((event) => event.eventId),
        );
        for (const event of events) {
          const matches =
            namesEventKind(handler.eventKinds, event.kind) &&
            receipts.get(event.eventId)?.principal?.source !== "handler";
          if (matches && runs >= limit) break;
          if (matches) runs += 1;
          work.push({ merchantId, plugin, handler, event, matches });
        }
      }
    }
    return work;
  }

  #handle(work: HandlerWork): void {
    const { database } = this.#options;
    const { merchantId, plugin, handler, event } = work;
    const { pluginId } = plugin.definition;
    const limits = plugin.definition.limits;
    if (work.matches && limits !== undefined) {
      // The order of the event, or of its fulfillment.
      const order =
        event.resources.find((resource) => resource.kind === "order") ??
        event.resources.find((resource) => resource.kind === "fulfillment");
      const input = {
        hookPoint: "event.handler",
        event: {
          eventId: event.eventId,
          kind: event.kind,
          occurredAt: event.occurredAt,
          resources: event.resources,
        },
        order:
          order === undefined
            ? null
            : (this.#options.readOrder(merchantId, order.id) ?? null),
      };
      const outcome = runPluginSource(
        handler.source,
        limits,
        plugin.settings,
        withPluginFields(
          database,
          merchantId,
          pluginId,
          input,
          this.#customerOfOrder.bind(this, merchantId),
        ),
        event.occurredAt,
      );
      const output =
        outcome.kind === "returned"
          ? parseRunOutput(outcome.output)
          : undefined;
      const operations = output?.commands ?? [];
      const merchant = this.#options.readMerchant(merchantId);
      const applied =
        operations.length === 0 || merchant === undefined
          ? undefined
          : this.#applyAll(
              merchant,
              plugin,
              { source: "handler", sourceId: handler.handlerId },
              operations,
              `plugin_${pluginId}_v${plugin.version}_${handler.handlerId}_${event.eventId}`,
              event.occurredAt,
            );
      const refusal = refusalOf(applied);
      const failure: PluginFunctionFailure | undefined =
        output === undefined
          ? {
              hookPoint: "event.handler",
              pluginId,
              version: plugin.version,
              functionId: handler.handlerId,
              reason:
                outcome.kind === "failed" ? outcome.reason : "invalid_output",
              message:
                outcome.kind === "failed"
                  ? outcome.message
                  : "The output does not have the handler shape",
            }
          : refusal === undefined
            ? undefined
            : {
                hookPoint: "event.handler",
                pluginId,
                version: plugin.version,
                functionId: handler.handlerId,
                reason: "refused",
                message: refusal,
              };
      recordFunctionRuns(
        database,
        merchantId,
        { id: event.eventId, attempt: handler.handlerId },
        [
          {
            pluginId,
            version: plugin.version,
            functionId: handler.handlerId,
            codeDigest: "",
            inputDigest: "",
            outcome: failure === undefined ? "passed" : "skipped",
          },
        ],
        failure === undefined ? [] : [failure],
        event.occurredAt,
      );
    }
    moveHandlerCursor(
      database,
      merchantId,
      pluginId,
      handler.handlerId,
      event.cursor,
    );
  }

  /**
   * Runs a merchant plugin's action with typed inputs. Its function's
   * refusal refuses the call (`action_refused`). Its commands are applied
   * all or none, each with its own receipt that names the action as the
   * principal, and in the same transaction the call gets one receipt of its
   * own (`run_plugin_action`, with the same principal) under the caller's
   * key, which it answers with.
   * A retry of the call answers with that receipt and runs nothing.
   */
  runAction(rawCommand: unknown): CommerceMutationResultV1 {
    let command: RunCommercePluginActionV1;
    try {
      command = parseRunPluginActionCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined || merchant === undefined)
      return this.#options.rejected(
        merchantError ?? {
          code: "merchant_not_found",
          merchantId: command.merchantId,
        },
      );
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    const { database } = this.#options;
    const { merchantId, pluginId, actionId } = command;
    const plugin = listMerchantPlugins(database, merchantId).find(
      (candidate) => candidate.definition.pluginId === pluginId,
    );
    const action = listPluginActions(database, merchantId, pluginId).find(
      (candidate) => candidate.actionId === actionId,
    );
    if (plugin === undefined || action === undefined)
      return this.#options.rejected({
        code: "resource_not_found",
        kind: plugin === undefined ? "plugin" : "plugin_action",
        id: plugin === undefined ? pluginId : actionId,
      });
    const limits = plugin.definition.limits;
    if (plugin.state !== "active" || limits === undefined)
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "plugin.state",
      });
    const read = this.#actionInput(merchantId, pluginId, action, command.input);
    if (read.kind === "refused") return this.#options.rejected(read.error);
    const { input } = read;
    const outcome = runPluginSource(
      action.source,
      limits,
      plugin.settings,
      withPluginFields(this.#options.database, merchantId, pluginId, {
        hookPoint: "action",
        actionId,
        input,
      }),
      command.requestedAt,
    );
    const output =
      outcome.kind === "returned" ? parseRunOutput(outcome.output) : undefined;
    const refuse = (message: string): CommerceMutationResultV1 =>
      this.#options.rejected({
        code: "action_refused",
        pluginId,
        actionId,
        message,
      });
    const record = (failure: PluginFunctionFailure | undefined) =>
      recordFunctionRuns(
        database,
        merchantId,
        { id: command.idempotencyKey, attempt: actionId },
        [
          {
            pluginId,
            version: plugin.version,
            functionId: actionId,
            codeDigest: "",
            inputDigest: "",
            outcome: failure === undefined ? "passed" : "skipped",
          },
        ],
        failure === undefined ? [] : [failure],
        command.requestedAt,
      );
    const failure = (
      reason: PluginFunctionFailure["reason"],
      message: string,
    ): PluginFunctionFailure => ({
      hookPoint: "action",
      pluginId,
      version: plugin.version,
      functionId: actionId,
      reason,
      message,
    });
    const operations = output?.commands ?? [];
    if (
      output === undefined ||
      (output.refusals.length === 0 && operations.length === 0)
    ) {
      record(
        outcome.kind === "failed"
          ? failure(outcome.reason, outcome.message)
          : failure("invalid_output", "The output names no refusal or command"),
      );
      return refuse("This action cannot run now. Try again later.");
    }
    const message = output.refusals[0];
    if (message !== undefined || operations.length === 0) {
      record(undefined);
      return refuse(message ?? "This action cannot run now. Try again later.");
    }
    const applied = this.#applyAll(
      merchant,
      plugin,
      { source: "action", sourceId: actionId },
      operations,
      `plugin_${pluginId}_action_${actionId}_${command.idempotencyKey}`,
      command.requestedAt,
      () => {
        // The commands moved the merchant on; the call's receipt is next,
        // and it names the action, as theirs do.
        const after = this.#options.readMerchant(merchantId) ?? merchant;
        return commandPrincipal.run(
          {
            kind: "plugin",
            pluginId,
            version: plugin.version,
            source: "action",
            sourceId: actionId,
          },
          () =>
            this.#options.commit({
              command,
              merchant: after,
              pluginId,
              revision: plugin.revision,
              write: () => undefined,
            }),
        );
      },
    );
    const refusal = refusalOf(applied);
    record(refusal === undefined ? undefined : failure("refused", refusal));
    return typeof applied === "string" ? refuse(applied) : applied;
  }

  /** The inputs of an action call, with each order read, or a refusal. */
  #actionInput(
    merchantId: string,
    pluginId: string,
    action: CommercePluginActionV1,
    values: CommercePluginSettingsV1,
  ):
    | Readonly<{ kind: "read"; input: Readonly<Record<string, unknown>> }>
    | Readonly<{ kind: "refused"; error: CommerceMutationErrorV1 }> {
    const invalid = (field: string) =>
      ({
        kind: "refused",
        error: {
          code: "resource_relationship_invalid",
          field: `input.${field}`,
        },
      }) as const;
    const unknown = Object.keys(values).find(
      (key) => !action.inputs.some((input) => input.key === key),
    );
    if (unknown !== undefined) return invalid(unknown);
    const resolved: Record<string, unknown> = {};
    for (const input of action.inputs) {
      const value = values[input.key];
      if (value === undefined) return invalid(input.key);
      if (input.valueKind !== "order") {
        if (!fieldValueMatches(input.valueKind, value))
          return invalid(`${input.key}.valueKind`);
        resolved[input.key] = value;
        continue;
      }
      if (typeof value !== "string") return invalid(`${input.key}.valueKind`);
      const order = this.#options.readOrder(merchantId, value);
      if (order === undefined)
        return {
          kind: "refused",
          error: { code: "resource_not_found", kind: "order", id: value },
        };
      // The plugin reads its own field values on the order's lines.
      resolved[input.key] = withPluginFields(
        this.#options.database,
        merchantId,
        pluginId,
        { order },
        this.#customerOfOrder.bind(this, merchantId),
      ).order;
    }
    return { kind: "read", input: resolved };
  }

  /**
   * Applies the commands that one run returned, all or none, with the plugin
   * as their principal. The first command keeps the run's key and each later
   * one adds its place (`_2`, `_3`, …), so a run of one command keeps the key
   * that it had before runs could hold more. Answers with the last result,
   * or with `finish`'s when it is given (it commits in the same
   * transaction), or why nothing was applied.
   */
  #applyAll(
    merchant: PluginMerchantRow,
    plugin: Readonly<{ definition: PluginDefinition; version: number }>,
    from: Readonly<{ source: "handler" | "action"; sourceId: string }>,
    operations: readonly PluginOperation[],
    idempotencyKey: string,
    at: string,
    finish?: () => CommerceMutationResultV1,
  ): CommerceMutationResultV1 | string {
    for (const operation of operations) {
      if (!plugin.definition.requirements.commands.includes(operation.kind))
        return `The plugin's requirements do not name ${operation.kind}`;
      if (this.inactivePluginOfRoute(merchant.merchantId, operation.kind))
        return `The plugin that owns ${operation.kind} is paused`;
    }
    // A handler's key is its own: a retry answers with the first result,
    // also when the record has moved on since. The commands committed
    // together, so the last key answers for the run.
    const keys = operations.map((_, place) =>
      place === 0 ? idempotencyKey : `${idempotencyKey}_${place + 1}`,
    );
    const lastKey = keys[keys.length - 1] ?? idempotencyKey;
    const earlier =
      from.source === "handler"
        ? this.#options.readReceipt(merchant.merchantId, lastKey)
        : undefined;
    if (earlier !== undefined) return earlier;
    try {
      return this.#options.database.transaction(() => {
        let last: CommerceMutationResultV1 | undefined;
        operations.forEach((operation, place) => {
          const applied = this.#applyOne(
            merchant,
            plugin,
            from,
            operation,
            keys[place] ?? idempotencyKey,
            at,
          );
          const refusal = refusalOf(applied);
          // Throwing rolls back the commands that this run applied before.
          if (refusal !== undefined || typeof applied === "string")
            throw new RefusedRun(
              operations.length === 1
                ? (refusal ?? "")
                : `Command ${place + 1} (${operation.kind}): ${refusal ?? ""}`,
              operations.length === 1 && typeof applied !== "string"
                ? applied
                : undefined,
            );
          last = applied;
        });
        if (last === undefined) throw new Error("A plugin run had no command");
        if (finish === undefined) return last;
        const finished = finish();
        const refusal = refusalOf(finished);
        if (refusal !== undefined) throw new RefusedRun(refusal, finished);
        return finished;
      });
    } catch (error) {
      if (!(error instanceof RefusedRun)) throw error;
      return error.result ?? error.message;
    }
  }

  /** The customer of an order, or null for an order with none. */
  #customerOfOrder(merchantId: string, orderId: string): string | null {
    return (
      this.#options.readOrderBuyer(merchantId, orderId)?.customerId ?? null
    );
  }

  /** One command of a run: its result, or why the core did not submit it. */
  #applyOne(
    merchant: PluginMerchantRow,
    plugin: Readonly<{ definition: PluginDefinition; version: number }>,
    from: Readonly<{ source: "handler" | "action"; sourceId: string }>,
    operation: PluginOperation,
    idempotencyKey: string,
    at: string,
  ): CommerceMutationResultV1 | string {
    const { pluginId } = plugin.definition;
    const command = operationCommand(operation, {
      organisationId: merchant.organisationId,
      merchantId: merchant.merchantId,
      pluginId,
      idempotencyKey,
      at,
      fieldRevision: (entityType, entityId) =>
        listPluginFieldValues(
          this.#options.database,
          merchant.merchantId,
          pluginId,
        ).find(
          (record) =>
            record.entityType === entityType && record.entityId === entityId,
        )?.revision ?? null,
      orderBuyer: (orderId) =>
        this.#options.readOrderBuyer(merchant.merchantId, orderId),
    });
    if (command === undefined)
      return operation.kind === "credit_store_credit"
        ? "The credit_store_credit command names unknown fields or an order with no customer"
        : `The ${operation.kind} command names unknown fields`;
    return commandPrincipal.run(
      { kind: "plugin", pluginId, version: plugin.version, ...from },
      () =>
        operation.kind === "set_plugin_field_values"
          ? this.setFieldValues(command)
          : this.#options.applyCommand(command),
    );
  }

  /** A merchant plugin's fields and their values, or undefined. */
  listFieldValues(
    merchantId: string,
    pluginId: string,
  ): CommercePluginFieldValueListV1 | undefined {
    const plugin = this.#known(merchantId, pluginId);
    if (plugin === undefined || plugin.definition.kind !== "merchant")
      return undefined;
    return {
      schemaVersion: "underclerk.plugin-field-values.v1",
      pluginId,
      fields: listPluginFields(this.#options.database, merchantId, pluginId),
      records: listPluginFieldValues(
        this.#options.database,
        merchantId,
        pluginId,
      ),
    };
  }

  /**
   * Sets a merchant plugin's field values on one product or variant. Each
   * key is a field of that entity type, and each value has its kind; null
   * removes a value.
   */
  setFieldValues(rawCommand: unknown): CommerceMutationResultV1 {
    let command: SetCommercePluginFieldValuesV1;
    try {
      command = parseSetPluginFieldValuesCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const admitted = this.#admit(command);
    if ("outcome" in admitted) return admitted;
    const { database } = this.#options;
    const { merchantId, pluginId, entityType, entityId } = command;
    const invalid = (field: string) =>
      this.#options.rejected({
        code: "resource_relationship_invalid",
        field: `pluginFields.${field}`,
      });
    const plugin = this.#known(merchantId, pluginId);
    if (plugin === undefined || plugin.definition.kind !== "merchant")
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "plugin",
        id: pluginId,
      });
    if (plugin.state === "removed") return invalid("removed");
    const exists =
      entityType === "product"
        ? this.#options.readProductIds(merchantId).includes(entityId)
        : entityType === "customer"
          ? this.#options.customerExists(merchantId, entityId)
          : this.#options
              .readVariants(merchantId)
              .some((variant) => variant.id === entityId);
    if (!exists)
      return this.#options.rejected({
        code: "resource_not_found",
        kind: entityType,
        id: entityId,
      });
    const fields = listPluginFields(database, merchantId, pluginId).filter(
      (field) => field.entityType === entityType,
    );
    for (const [key, value] of Object.entries(command.values)) {
      const field = fields.find((candidate) => candidate.key === key);
      if (field === undefined) return invalid(key);
      if (value !== null && !fieldValueMatches(field.valueKind, value))
        return invalid(`${key}.valueKind`);
    }
    const current = listPluginFieldValues(database, merchantId, pluginId).find(
      (record) =>
        record.entityType === entityType && record.entityId === entityId,
    );
    if ((current?.revision ?? null) !== command.expectedRevision)
      return this.#options.rejected({
        code: "stale_resource_revision",
        kind: "plugin_field_values",
        id: `${pluginId}:${entityType}:${entityId}`,
        expected: command.expectedRevision ?? 0,
        actual: current?.revision ?? 0,
      });
    const values = Object.fromEntries(
      Object.entries({ ...current?.values, ...command.values }).filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
          entry[1] !== null,
      ),
    );
    const revision = (current?.revision ?? 0) + 1;
    return this.#options.commit({
      command,
      merchant: admitted,
      pluginId,
      revision: plugin.revision,
      resource: {
        kind: "plugin_field_values",
        id: `${pluginId}:${entityType}:${entityId}`,
        revision,
      },
      write: () =>
        writePluginFieldValues(
          database,
          merchantId,
          pluginId,
          { entityType, entityId, revision, values },
          command.requestedAt,
        ),
    });
  }

  /** Runs one function of a draft definition on an input; it changes nothing. */
  async runPluginFunction(
    rawCommand: unknown,
  ): Promise<
    | CommercePluginFunctionRunV1
    | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>
  > {
    const command = parseRunPluginFunctionCommand(rawCommand);
    const { definition, settings } = command;
    const parts = [...(command.handlers ?? []), ...(command.actions ?? [])];
    const problem = merchantPluginProblem(definition, settings, parts.length);
    if (problem !== undefined) return { kind: "rejected", error: problem };
    const handler = command.handlers?.find(
      (candidate) => candidate.handlerId === command.functionId,
    );
    const action = command.actions?.find(
      (candidate) => candidate.actionId === command.functionId,
    );
    const part = handler ?? action;
    if (part !== undefined && definition.limits !== undefined) {
      const limits = definition.limits;
      const outcome = await this.#withVms(1, () =>
        runPluginSource(
          part.source,
          limits,
          settings,
          command.input,
          this.#options.now(),
        ),
      );
      if (outcome.kind !== "returned")
        return {
          schemaVersion: "underclerk.plugin-function-run.v1",
          outcome: {
            kind: "failed",
            reason: outcome.reason,
            message: outcome.message,
          },
          polls: outcome.polls,
        };
      const output = parseRunOutput(outcome.output);
      return {
        schemaVersion: "underclerk.plugin-function-run.v1",
        outcome:
          output === undefined
            ? {
                kind: "failed",
                reason: "invalid_output",
                message: "The output is not { refusals?, commands? }",
              }
            : { kind: "returned", output: outcome.output },
        polls: outcome.polls,
        ...(output === undefined
          ? {}
          : {
              commands: output.commands.map((operation) =>
                dryRunCheck(definition, operation),
              ),
            }),
      };
    }
    const fn = definition.contributions.functions.find(
      (candidate) => candidate.functionId === command.functionId,
    );
    const limits = definition.limits;
    if (fn === undefined || limits === undefined)
      return {
        kind: "rejected",
        error: {
          code: "resource_not_found",
          kind: "plugin_function",
          id: command.functionId,
        },
      };
    const outcome = await this.#withVms(1, () =>
      runPluginFunction(
        fn,
        limits,
        settings,
        command.input,
        this.#options.now(),
      ),
    );
    return {
      schemaVersion: "underclerk.plugin-function-run.v1",
      outcome:
        outcome.kind === "returned"
          ? { kind: "returned", output: outcome.output }
          : {
              kind: "failed",
              reason: outcome.reason,
              message: outcome.message,
            },
      polls: outcome.polls,
    };
  }

  /**
   * Runs a draft definition's `checkout.validate` functions over the
   * merchant's recent checkouts, as their quotes stand; it changes nothing.
   */
  async previewMerchantPlugin(
    merchantId: string,
    rawCommand: unknown,
  ): Promise<
    | CommerceMerchantPluginPreviewV1
    | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>
  > {
    const command = parsePreviewMerchantPluginCommand(rawCommand);
    const { definition, settings } = command;
    const problem = merchantPluginProblem(definition, settings);
    const limits = definition.limits;
    if (problem !== undefined || limits === undefined)
      return {
        kind: "rejected",
        error: problem ?? {
          code: "resource_relationship_invalid",
          field: "plugin.limits",
        },
      };
    const { database } = this.#options;
    const functions = definition.contributions.functions.filter(
      (fn) => fn.hookPoint === "checkout.validate",
    );
    const checkoutIds = listRecentCheckoutIds(
      database,
      merchantId,
      Math.floor(PREVIEW_RUNS / Math.max(1, functions.length)),
    );
    const variants = this.#options.readVariants(merchantId);
    const refused: Array<CommerceMerchantPluginPreviewV1["refused"][number]> =
      [];
    const failed: Array<CommerceMerchantPluginPreviewV1["failed"][number]> =
      [];
    await this.#withVms(checkoutIds.length * functions.length, () => {
      for (const checkoutId of checkoutIds) {
        const quote = readCheckout(database, merchantId, checkoutId)?.lifecycle
          .quote;
        if (quote === undefined) continue;
        const fulfillment = quote.fulfillment;
        const input = {
          hookPoint: "checkout.validate",
          checkout: checkoutValidationInput({
            checkoutId,
            kind: fulfillment.kind,
            quotedAt: quote.quotedAt,
            currency: quote.totals.total.currency,
            readyBy:
              fulfillment.kind === "pickup"
                ? fulfillment.promise.readyAt
                : fulfillment.quote.estimatedDelivery.kind === "window"
                  ? fulfillment.quote.estimatedDelivery.latest
                  : quote.expiresAt,
            lines: quote.lines,
            variants,
            subtotalMinor: quote.totals.subtotal.amountMinor,
            totalMinor: quote.totals.total.amountMinor,
          }),
        };
        // A draft has no values on any buyer yet.
        const draftInput = {
          ...input,
          checkout: { ...input.checkout, customerFields: {} },
        };
        for (const fn of functions) {
          const outcome = runPluginFunction(
            fn,
            limits,
            settings,
            draftInput,
            quote.quotedAt,
          );
          const messages =
            outcome.kind === "returned"
              ? refusalMessages(outcome.output)
              : undefined;
          if (messages === undefined)
            failed.push({
              checkoutId,
              functionId: fn.functionId,
              reason:
                outcome.kind === "failed" ? outcome.reason : "invalid_output",
            });
          else if (messages.length > 0)
            refused.push({ checkoutId, functionId: fn.functionId, messages });
        }
      }
    });
    return {
      schemaVersion: "underclerk.merchant-plugin-preview.v1",
      pluginId: definition.pluginId,
      checkouts: checkoutIds.length,
      refused,
      failed,
    };
  }

  async #withVms<T>(count: number, run: () => T): Promise<T> {
    const vms = await this.#options.prepareVms(count);
    if (vms === undefined) return run();
    try {
      return functionScope.run(vms, run);
    } finally {
      vms.dispose();
    }
  }

  #admit(
    command: PluginCommand,
  ): PluginMerchantRow | CommerceMutationResultV1 {
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    return (
      merchant ??
      this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      })
    );
  }

  #all(merchantId: string): readonly KnownPlugin[] {
    const { database } = this.#options;
    return [
      ...BUILT_IN_PLUGINS.map((definition) => ({
        definition,
        ...readPluginState(database, merchantId, definition.pluginId),
      })),
      ...listMerchantPlugins(database, merchantId),
    ];
  }

  #known(merchantId: string, pluginId: string): KnownPlugin | undefined {
    const builtIn = builtInPlugin(pluginId);
    if (builtIn !== undefined)
      return {
        definition: builtIn,
        ...readPluginState(this.#options.database, merchantId, pluginId),
      };
    return listMerchantPlugins(this.#options.database, merchantId).find(
      (plugin) => plugin.definition.pluginId === pluginId,
    );
  }

  #plan(
    merchantId: string,
    pluginId: string,
    change: CommercePluginChangeV1 | "remove" | "auto_pause",
  ): PlannedChange | CommerceMutationErrorV1 {
    const plugin = this.#known(merchantId, pluginId);
    if (plugin === undefined)
      return { code: "resource_not_found", kind: "plugin", id: pluginId };
    const move = commerceTransition("plugin", { state: plugin.state }, change);
    if (!move.allowed) return move.refusal;
    const invalid = (field: string): CommerceMutationErrorV1 => ({
      code: "resource_relationship_invalid",
      field: `plugin.${field}`,
    });
    if (change === "remove" && plugin.definition.kind === "built_in")
      return invalid("builtIn");
    // A pause or a removal leaves no active plugin without what it needs,
    // and a resume needs every plugin that this one depends on.
    const all = this.#all(merchantId);
    if (
      change !== "resume" &&
      all.some(
        (other) =>
          other.state === "active" &&
          other.definition.requirements.dependsOn.includes(pluginId),
      )
    )
      return invalid("dependents");
    if (
      change === "resume" &&
      plugin.definition.requirements.dependsOn.some(
        (dependency) =>
          all.find((other) => other.definition.pluginId === dependency)
            ?.state !== "active",
      )
    )
      return invalid("dependencies");
    return { revision: plugin.revision + 1, to: move.to };
  }
}

type HandlerWork = Readonly<{
  merchantId: string;
  plugin: MerchantPluginInstallation;
  handler: StoredHandler;
  event: CommerceEventV1;
  /** Whether the handler runs on the event, or only passes it. */
  matches: boolean;
}>;

/**
 * Ends a plugin run's transaction when one of its commands is refused. A run
 * of one command keeps the core's own refusal, as before runs held more.
 */
class RefusedRun extends Error {
  readonly result: CommerceMutationResultV1 | undefined;

  constructor(message: string, result: CommerceMutationResultV1 | undefined) {
    super(message);
    this.result = result;
  }
}

/** Why a plugin's command did not apply, or undefined when it applied. */
function refusalOf(
  applied: CommerceMutationResultV1 | string | undefined,
): string | undefined {
  if (applied === undefined || typeof applied === "string") return applied;
  return applied.outcome === "rejected"
    ? `The core refused the command: ${applied.error.code}`
    : undefined;
}

/**
 * Whether the core would accept a command that a dry run returned: its kind
 * is one that plugins may submit and that the requirements name, and its
 * fields have the right shape. A dry run reads no record, so an order is
 * taken to have a customer.
 */
function dryRunCheck(
  definition: PluginDefinition,
  operation: PluginOperation,
): CommercePluginCommandCheckV1 {
  const refused = (reason: string) => ({
    kind: operation.kind,
    accepted: false,
    reason,
  });
  if (!PLUGIN_COMMANDS.includes(operation.kind))
    return refused(`A plugin cannot submit ${operation.kind}`);
  if (!definition.requirements.commands.includes(operation.kind))
    return refused(`The plugin's requirements do not name ${operation.kind}`);
  const command = operationCommand(operation, {
    organisationId: "dry_run",
    merchantId: "dry_run",
    pluginId: definition.pluginId,
    idempotencyKey: "dry_run",
    at: "1970-01-01T00:00:00.000Z",
    fieldRevision: () => null,
    orderBuyer: () => ({ customerId: "dry_run", currency: "JPY" }),
  });
  return command === undefined
    ? refused(`The ${operation.kind} command names unknown fields`)
    : { kind: operation.kind, accepted: true, reason: null };
}

function isBuiltIn(definition: PluginDefinition): definition is BuiltInPlugin {
  return (
    definition.kind === "built_in" &&
    builtInPlugin(definition.pluginId) !== undefined
  );
}
