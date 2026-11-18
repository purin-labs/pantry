// The checkout hook points of merchant plugins other than `checkout.validate`
// (Plan 77 step 4). A function returns a typed output; the core checks it and
// applies it, so a plugin never writes the quote itself:
//
// - `checkout.lines`: `{ prices: [{ checkoutLineId, unitPriceMinor }] }`
//   lowers the unit price of catalog lines.
// - `checkout.discount`: `{ discounts: [{ checkoutLineId?, amountMinor }] }`
//   takes an amount off one line, or without a line off the whole order.
// - `checkout.tenders`: `{ refusals: [{ tender, message }] }` refuses gift
//   cards or store credit for this checkout.
// - `checkout.delivery`: `{ refusals?, earliestReadyAt?, message? }` refuses
//   the delivery, or makes a pickup ready no earlier than a time.
//
// An output that does not have this shape is a failure: the function is
// skipped, or the checkout is refused when the function is required.
import type { CommerceMutationErrorV1 } from "@seams/commerce-client";
import type { CheckoutPluginRun } from "@seams/commerce-contracts";

import { sha256 } from "../commerce-authority/checkout-shared.ts";
import type { CommerceDatabase } from "../database.ts";
import {
  listMerchantPlugins,
  runPluginFunction,
  withPluginFields,
  type CheckoutValidationInput,
  type PluginFunctionFailure,
} from "./merchant-plugins.ts";

export type CheckoutHookPoint =
  | "checkout.lines"
  | "checkout.discount"
  | "checkout.tenders"
  | "checkout.delivery";

/** Every hook point that the runner serves; validate keeps its own stage. */
export type HookPoint = CheckoutHookPoint | "machine.guard";

export type HookResult<T> =
  | Readonly<{
      kind: "ran";
      outputs: readonly Readonly<{ pluginId: string; output: T }>[];
      runs: readonly CheckoutPluginRun[];
      failures: readonly PluginFunctionFailure[];
    }>
  | Readonly<{ kind: "refused"; error: CommerceMutationErrorV1 }>;

/** What every hook reads of the checkout, plus the hook's own facts. */
export type HookInput = Readonly<{
  checkout: Omit<CheckoutValidationInput, "readyBy" | "totalMinor"> &
    Readonly<{ readyBy: string | null; totalMinor: number | null }>;
}> &
  Readonly<Record<string, unknown>>;

/**
 * Runs the functions of one hook point of the merchant's active plugins, in
 * plugin order, and parses each output.
 */
export function runCheckoutHook<T>(
  database: CommerceDatabase,
  merchantId: string,
  hookPoint: CheckoutHookPoint,
  input: HookInput,
  parse: (output: unknown) => T | undefined,
): HookResult<T> {
  return runHook(
    database,
    merchantId,
    hookPoint,
    input,
    input.checkout.quotedAt,
    parse,
  );
}

/**
 * Runs the functions of one hook point with `at` as their clock. A required
 * function that fails refuses with a message that names no reason.
 */
export function runHook<T>(
  database: CommerceDatabase,
  merchantId: string,
  hookPoint: HookPoint,
  input: Readonly<Record<string, unknown>>,
  at: string,
  parse: (output: unknown) => T | undefined,
): HookResult<T> {
  const outputs: { pluginId: string; output: T }[] = [];
  const runs: CheckoutPluginRun[] = [];
  const failures: PluginFunctionFailure[] = [];
  for (const plugin of listMerchantPlugins(database, merchantId)) {
    if (plugin.state !== "active" || plugin.definition.limits === undefined)
      continue;
    for (const fn of plugin.definition.contributions.functions) {
      if (fn.hookPoint !== hookPoint) continue;
      const hookInput = withPluginFields(
        database,
        merchantId,
        plugin.definition.pluginId,
        { hookPoint, ...input },
      );
      const outcome = runPluginFunction(
        fn,
        plugin.definition.limits,
        plugin.settings,
        hookInput,
        at,
      );
      const parsed =
        outcome.kind === "returned" ? parse(outcome.output) : undefined;
      if (parsed === undefined && fn.required)
        return {
          kind: "refused",
          error: {
            code: "checkout_refused",
            pluginId: plugin.definition.pluginId,
            message:
              hookPoint === "machine.guard"
                ? "This change cannot be checked now. Try again later."
                : "This checkout cannot be checked now. Try again later.",
          },
        };
      if (parsed === undefined)
        failures.push({
          hookPoint,
          pluginId: plugin.definition.pluginId,
          version: plugin.version,
          functionId: fn.functionId,
          reason: outcome.kind === "failed" ? outcome.reason : "invalid_output",
          message:
            outcome.kind === "failed"
              ? outcome.message
              : `The output does not have the ${hookPoint} shape`,
        });
      else
        outputs.push({ pluginId: plugin.definition.pluginId, output: parsed });
      runs.push({
        pluginId: plugin.definition.pluginId,
        version: plugin.version,
        functionId: fn.functionId,
        codeDigest: sha256(fn.source),
        inputDigest: sha256(
          JSON.stringify({ ...hookInput, settings: plugin.settings }),
        ),
        outcome: parsed === undefined ? "skipped" : "passed",
      });
    }
  }
  return { kind: "ran", outputs, runs, failures };
}

// The schemas of plugin outputs (Plan 78) check each output and give the
// value that the core applies.
export {
  parseDeliveryOutput,
  parseDiscountOutput,
  parseLinesOutput,
  parseTendersOutput,
  type DeliveryOutput,
  type LinePrice,
  type PluginDiscount,
  type TenderRefusal,
} from "@seams/commerce-contracts/records/plugin-outputs";
