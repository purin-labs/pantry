import type {
  CounterPrinterJob,
  CounterReceiptSettings,
  CounterSaleReceipt,
  PrinterTask,
} from "@purin-labs/control-api";

import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import {
  renderCounterReceipt,
  type CounterReceiptLine,
} from "./counter-receipt";
import {
  counterLocationFleet,
  executeCounterSaleAfterSale,
  readCounterSaleView,
  recordCounterSaleCash,
  type CounterSaleAfterSaleAction,
} from "./counter-register";
import type {
  CounterRegisterDeps,
  CounterRegisterResult,
  CounterSaleView,
} from "./contract/counter-sale";

/**
 * The receipt printer and the cash drawer of a café counter (Plan 90 Phase
 * 5, decision D8). The counter location's DeviceFleetActor holds the task and
 * the printer's gateway answers it. A print or drawer error never changes the
 * sale: the sale is recorded first, and the error comes back beside it.
 *
 * The drawer opens on a cash sale and on a manual cash refund, one time for
 * each: its request id comes from the sale, so a repeated request opens
 * nothing. The agent has no tool for the drawer or for a print (D9).
 *
 * A shop with no receipt printer pays nothing for this: one D1 read finds no
 * printer, and no Durable Object starts.
 */

type OrderRecord = Extract<
  Awaited<ReturnType<CounterRegisterDeps["client"]["readOrderRecord"]>>,
  Readonly<{ ok: true }>
>["value"];
type OrderLine = OrderRecord["order"]["lineItems"][number];

const DEFAULT_TIME_ZONE = "Asia/Tokyo";

export type CounterSaleWithDrawer = Readonly<{
  counterSale: CounterSaleView;
  /** Null when the sale did not move cash, so the drawer stays shut. */
  drawer: CounterPrinterJob | null;
}>;

/** Records a cash sale, then opens the drawer of the counter's printer. */
export async function recordCounterCashAndOpenDrawer(
  deps: CounterRegisterDeps,
  input: Parameters<typeof recordCounterSaleCash>[1],
): Promise<CounterRegisterResult<CounterSaleWithDrawer>> {
  const settled = await recordCounterSaleCash(deps, input);
  if (!settled.ok) return settled;
  const drawer =
    settled.value.state === "complete"
      ? await runPrinterTask(deps, {
          locationId: settled.value.pantryLocationId,
          checkoutId: input.checkoutId,
          task: "cash_drawer_kick",
          requestId: `drawer_sale_${input.checkoutId}`,
          receipt: null,
        })
      : null;
  return { ok: true, value: { counterSale: settled.value, drawer } };
}

/**
 * Runs one after-sale action. A manual cash refund that completed opens the
 * drawer, so the person can hand the cash back.
 */
export async function runCounterAfterSaleWithDrawer(
  deps: CounterRegisterDeps,
  input: Readonly<{
    checkoutId: string;
    action: CounterSaleAfterSaleAction;
    idempotencyKey: string;
    reason?: string;
  }>,
): Promise<CounterRegisterResult<CounterSaleWithDrawer>> {
  const done = await executeCounterSaleAfterSale(deps, input);
  if (!done.ok) return done;
  const drawer =
    input.action === "manual_cash_refund" &&
    done.value.afterSale?.refundState === "completed"
      ? await runPrinterTask(deps, {
          locationId: done.value.pantryLocationId,
          checkoutId: input.checkoutId,
          task: "cash_drawer_kick",
          requestId: `drawer_refund_${input.checkoutId}`,
          receipt: null,
        })
      : null;
  return { ok: true, value: { counterSale: done.value, drawer } };
}

/** Prints the receipt of one completed sale on the counter's printer. */
export async function printCounterSaleReceipt(
  deps: CounterRegisterDeps,
  input: Readonly<{
    checkoutId: string;
    requestId: string;
    timeZone: string | null;
    copy: "original" | "reprint";
  }>,
): Promise<CounterRegisterResult<CounterPrinterJob>> {
  const sale = await readCounterSaleView(deps, input.checkoutId);
  if (!sale.ok) return sale;
  if (sale.value.orderId === null)
    return failure("counter_sale_not_complete", 409);
  const record = await deps.client.readOrderRecord(
    deps.merchantId,
    sale.value.orderId,
  );
  if (!record.ok)
    return { ok: false, failure: { kind: "commerce", error: record.error } };
  const configuration = await deps.client.readPointOfSaleConfiguration(
    deps.merchantId,
    sale.value.pantryLocationId,
  );
  if (!configuration.ok)
    return {
      ok: false,
      failure: { kind: "commerce", error: configuration.error },
    };
  const settings = await readCounterReceiptSettings(
    deps.scope.database,
    deps.organisationId,
    sale.value.pantryLocationId,
  );
  const order = record.value.order;
  const cash = sale.value.manualTender ?? null;
  const receipt = renderCounterReceipt({
    shopName: configuration.value.presentationPolicy.merchantDisplayName,
    locale: configuration.value.presentationPolicy.locale,
    issuedAt: order.occurredAt,
    timeZone: input.timeZone ?? DEFAULT_TIME_ZONE,
    pickupCode: sale.value.pickupCode ?? null,
    orderId: order.id,
    currency: order.totals.total.currency,
    lines: order.lineItems.map(receiptLine),
    totalMinor: order.totals.total.amountMinor,
    taxIncluded: order.totals.taxIncluded === true,
    configuredRateBasisPoints:
      configuration.value.tax.kind === "percentage"
        ? configuration.value.tax.basisPoints
        : null,
    invoiceRegistrationNumber: settings.invoiceRegistrationNumber,
    tender:
      cash !== null && cash.cashReceivedMinor !== null
        ? {
            kind: "cash",
            receivedMinor: cash.cashReceivedMinor,
            changeMinor: cash.changeDueMinor ?? 0,
          }
        : {
            kind: "electronic",
            method: sale.value.paymentMethod ?? null,
            brand: sale.value.tenderBrand ?? null,
          },
    copy: input.copy,
  });
  const job = await runPrinterTask(deps, {
    locationId: sale.value.pantryLocationId,
    checkoutId: input.checkoutId,
    task: "receipt_print",
    requestId: input.requestId,
    receipt,
  });
  return { ok: true, value: job };
}

/** The counter's printer and the print and drawer tasks of one sale. */
export async function readCounterSaleReceipt(
  deps: CounterRegisterDeps,
  checkoutId: string,
): Promise<CounterRegisterResult<CounterSaleReceipt>> {
  const sale = await readCounterSaleView(deps, checkoutId);
  if (!sale.ok) return sale;
  const locationId = sale.value.pantryLocationId;
  const fleet = (await locationHasReceiptPrinter(deps, locationId))
    ? counterLocationFleet(deps, locationId)
    : null;
  if (fleet === null)
    return { ok: true, value: { ok: true, printer: null, jobs: [] } };
  const [printer, jobs] = await Promise.all([
    fleet.counterPrinter(),
    fleet.printerJobs(checkoutId),
  ]);
  return { ok: true, value: { ok: true, printer, jobs: [...jobs] } };
}

export async function readCounterReceiptSettings(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  pantryLocationId: string,
): Promise<CounterReceiptSettings> {
  const row = await db
    .prepare(
      `SELECT invoice_registration_number FROM cafe_counter_receipt_setting
        WHERE organisation_id = ? AND pantry_location_id = ?`,
    )
    .bind(organisationId, pantryLocationId)
    .first<{ invoice_registration_number: string | null }>();
  return {
    pantryLocationId,
    invoiceRegistrationNumber: row?.invoice_registration_number ?? null,
  };
}

/** Saves the receipt settings of one counter. An unchanged value writes nothing. */
export async function writeCounterReceiptSettings(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    settings: CounterReceiptSettings;
    userId: string;
    now: number;
  }>,
): Promise<CounterReceiptSettings> {
  const current = await readCounterReceiptSettings(
    db,
    input.organisationId,
    input.settings.pantryLocationId,
  );
  if (
    current.invoiceRegistrationNumber ===
    input.settings.invoiceRegistrationNumber
  )
    return current;
  await db
    .prepare(
      `INSERT INTO cafe_counter_receipt_setting (
         organisation_id, pantry_location_id, invoice_registration_number,
         updated_by_user_id, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (organisation_id, pantry_location_id) DO UPDATE SET
         invoice_registration_number = excluded.invoice_registration_number,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.organisationId,
      input.settings.pantryLocationId,
      input.settings.invoiceRegistrationNumber,
      input.userId,
      input.now,
    )
    .run();
  return input.settings;
}

async function runPrinterTask(
  deps: CounterRegisterDeps,
  input: Readonly<{
    locationId: string;
    checkoutId: string;
    task: PrinterTask;
    requestId: string;
    receipt: Parameters<
      NonNullable<ReturnType<typeof counterLocationFleet>>["runPrinterTask"]
    >[0]["receipt"];
  }>,
): Promise<CounterPrinterJob> {
  const unsent = (
    state: "no_printer" | "result_unknown",
  ): CounterPrinterJob => ({
    requestId: input.requestId,
    task: input.task,
    state,
    replayed: false,
    createdAt: null,
    updatedAt: null,
  });
  const fleet = (await locationHasReceiptPrinter(deps, input.locationId))
    ? counterLocationFleet(deps, input.locationId)
    : null;
  if (fleet === null) return unsent("no_printer");
  try {
    return await fleet.runPrinterTask({
      task: input.task,
      requestId: input.requestId,
      checkoutId: input.checkoutId,
      receipt: input.receipt,
    });
  } catch {
    // The task's fate is unknown, and the sale is already recorded.
    return unsent("result_unknown");
  }
}

/**
 * Whether an active receipt printer stands on an active gateway of this
 * location. It reads the Devices records and writes nothing.
 */
async function locationHasReceiptPrinter(
  deps: CounterRegisterDeps,
  locationId: string,
): Promise<boolean> {
  const row = await deps.scope.database
    .prepare(
      `SELECT 1 AS found FROM device_enrollment AS device
         JOIN device_gateway AS gateway ON gateway.gateway_id = device.gateway_id
        WHERE device.organisation_id = ? AND device.device_kind = 'receipt_printer'
          AND device.state = 'active' AND gateway.state = 'active'
          AND gateway.organisation_id = ? AND gateway.location_id = ?
        LIMIT 1`,
    )
    .bind(deps.organisationId, deps.organisationId, locationId)
    .first<{ found: number }>();
  return row !== null;
}

function receiptLine(line: OrderLine): CounterReceiptLine {
  const quantity = line.quantity.amount / 10 ** line.quantity.scale;
  return {
    title: line.title,
    quantity,
    modifiers:
      line.source.kind === "food_service"
        ? line.source.modifiers.map((modifier) => modifier.name)
        : [],
    lineTotalMinor: line.lineTotal.amountMinor,
    taxMinor: line.tax.amountMinor,
  };
}

function failure(code: string, status: number): CounterRegisterResult<never> {
  return { ok: false, failure: { kind: "error", code, status } };
}
