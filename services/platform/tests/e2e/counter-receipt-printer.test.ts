import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  counterPrinterJobMessage,
  parseCounterReceiptPrintResponse,
  parseCounterSaleReceipt,
  type CounterPrinterJob,
  type GatewayMessage,
  type PlatformGatewayMessage,
} from "@purin-labs/control-api";
import { parseEnvelope as parseCounterSaleEnvelope } from "@purin-labs/control-api/portal/counter-sale";
import { isRecord } from "@purin-labs/std";

import type { IssuedControlSession } from "../../src/data/control-plane";
import {
  COOKIE_ENTRY,
  DRINK_ENTRY,
  OAT_MILK_MOD,
  menuLine,
  setupRegisterShop,
} from "./counter-register-support";
import {
  connectGateway,
  credentialOf,
  enrollGateway,
  found,
  helloAndWait,
  readDeviceList,
  requireKitchenDevice,
  send,
  type SimulatedGateway,
} from "./device-fleet-support";

/**
 * Plan 90 Phase 5: the receipt printer and the cash drawer of a café counter.
 * The socket of this journey only carries messages. Each print or drawer
 * task goes to the real gateway program (`shop-gateway answer`, through
 * `tests/shop-gateway-adapters.ts`), whose journal and simulated printer
 * decide what prints. The printer's plain-text rendering stays in
 * output/e2e/shop-gateway/receipt-printer/printer/printer-1.txt.
 */

const HOME = "receipt-printer";
const PRINTER = "printer-1";
const PRINTER_NAME = "Counter printer";
const REGISTRATION = "T1234567890123";
const RECEIPT_END = "- - - - cut - - - -";
const DRAWER_OPENED = "[ cash drawer opened ]";

type PrinterStatus = "ready" | "offline" | "paper_out" | "cover_open";

it(
  "prints one receipt and opens the drawer once for a cash sale, survives a socket drop without a second print, shows paper out while the sale stays complete, and refuses a viewer",
  { timeout: 180_000 },
  receiptPrinterJourney,
);

async function receiptPrinterJourney(): Promise<void> {
  const { organisationId, locationId, base, owner, staff, viewer } =
    await setupRegisterShop("reg-print");
  await adapters("/reset", {});

  // 1. A gateway at this counter reports a receipt printer with a drawer, and
  //    the owner confirms it on the Devices page.
  const started = await send(
    `${base}/devices/gateways`,
    owner.session,
    "POST",
    {
      name: "Counter gateway",
      locationId,
    },
  );
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const { gatewayId, code } = started.body as {
    gatewayId: string;
    code: string;
  };
  const credential = await credentialOf(
    await enrollGateway(organisationId, gatewayId, code),
  );
  const printerDevice = found(PRINTER, PRINTER_NAME, {
    kind: "receipt_printer",
    model: "Simulated mC-Print3",
    capabilities: [
      { id: "print_receipt", label: "Print a receipt", revision: 1 },
      { id: "cash_drawer", label: "Open the cash drawer", revision: 1 },
    ],
  });
  const relay = new GatewayRelay(await connectGateway(credential));
  await helloAndWait(relay.gateway, [printerDevice]);
  const pending = requireKitchenDevice(
    await readDeviceList(organisationId, owner.session),
    PRINTER_NAME,
  );
  expect(pending.hardware).toBe("receipt_printer");
  const confirmed = await send(
    `${base}/devices/${pending.deviceId}/confirm`,
    owner.session,
    "POST",
    { name: PRINTER_NAME, stationId: "station_bar" },
  );
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);

  // 2. The owner sets the Qualified Invoice registration number; an operator
  //    may not change it.
  const operatorSettings = await send(
    `${base}/commerce/counter-receipt-settings`,
    staff.session,
    "PUT",
    { pantryLocationId: locationId, invoiceRegistrationNumber: REGISTRATION },
  );
  expect(operatorSettings.status).toBe(404);
  const ownerSettings = await send(
    `${base}/commerce/counter-receipt-settings`,
    owner.session,
    "PUT",
    { pantryLocationId: locationId, invoiceRegistrationNumber: REGISTRATION },
  );
  expect(ownerSettings.status, JSON.stringify(ownerSettings.body)).toBe(200);

  // 3. A cash sale with ¥2,000 completes and opens the drawer one time.
  const checkoutId = `chk_print_${crypto.randomUUID().slice(0, 8)}`;
  const opened = await send(
    `${base}/commerce/counter-sales`,
    staff.session,
    "POST",
    {
      pantryLocationId: locationId,
      checkoutId,
      tenderMode: "cash",
      lines: [
        menuLine("p_cookie", COOKIE_ENTRY, [], 2),
        menuLine("p_drink", DRINK_ENTRY, [OAT_MILK_MOD], 1),
      ],
    },
  );
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const quote = parseCounterSaleEnvelope(
    (
      await send(
        `${base}/commerce/counter-sales/${checkoutId}`,
        staff.session,
        "GET",
      )
    ).body,
  ).quote!;
  const cashBody = {
    checkoutRevision: quote.checkoutRevision,
    quoteDigest: quote.quoteDigest,
    cashReceived: { amountMinor: 2_000, currency: "JPY" },
  };
  const cash = await send(
    `${base}/commerce/counter-sales/${checkoutId}/cash`,
    staff.session,
    "POST",
    cashBody,
    `cash_${checkoutId}`,
  );
  expect(cash.status, JSON.stringify(cash.body)).toBe(200);
  const sale = parseCounterSaleEnvelope(cash.body);
  expect(sale.state).toBe("complete");
  expect(drawerOf(cash.body)).toMatchObject({
    task: "cash_drawer_kick",
    state: "done",
  });
  // The repeated request answers the same sale and opens nothing.
  const cashAgain = await send(
    `${base}/commerce/counter-sales/${checkoutId}/cash`,
    staff.session,
    "POST",
    cashBody,
    `cash_${checkoutId}`,
  );
  expect(parseCounterSaleEnvelope(cashAgain.body).orderId).toBe(sale.orderId);
  expect(count(await printed(), DRAWER_OPENED)).toBe(1);

  // 4. A viewer may not read the printer or print.
  const viewerRead = await send(
    `${base}/commerce/counter-sales/${checkoutId}/receipt`,
    viewer.session,
    "GET",
  );
  expect(viewerRead.status).toBe(404);
  expect(viewerRead.body).toMatchObject({
    error: "organisation_role_insufficient",
  });
  const viewerPrint = await print(base, checkoutId, viewer.session);
  expect(viewerPrint.status).toBe(404);
  expect(count(await printed(), RECEIPT_END)).toBe(0);

  // 5. The operator prints the receipt: one receipt, with the sale's figures.
  const first = await print(base, checkoutId, staff.session);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(jobOf(first.body)).toMatchObject({ state: "done", replayed: false });
  const receipt = await printed();
  expect(count(receipt, RECEIPT_END)).toBe(1);
  const total = quote.amount.amountMinor;
  for (const expected of [
    "Seams Patisserie",
    `登録番号 ${REGISTRATION}`,
    spaced(sale.pickupCode!),
    "Taro Cookie x2",
    "Oat",
    "合計",
    "10%対象",
    "内消費税",
  ])
    expect(receipt, expected).toContain(expected);
  expect(receipt).toMatch(new RegExp(`合計 +${yen(total)}`, "u"));
  expect(receipt).toMatch(new RegExp(`お預かり +${yen(2_000)}`, "u"));
  expect(receipt).toMatch(new RegExp(`お釣り +${yen(2_000 - total)}`, "u"));

  // 6. The socket drops after the printer printed and before the answer
  //    came back. The task stays open, and the gateway's next hello settles
  //    it from the gateway's journal with no second print.
  relay.dropAfterNextPrint = true;
  const dropped = await print(base, checkoutId, staff.session, "reprint");
  expect(dropped.status, JSON.stringify(dropped.body)).toBe(200);
  const droppedJob = jobOf(dropped.body);
  expect(droppedJob.state).toBe("sent");
  expect(count(await printed(), RECEIPT_END)).toBe(2);
  const reconnected = new GatewayRelay(await connectGateway(credential));
  await helloAndWait(reconnected.gateway, [printerDevice]);
  await expect
    .poll(async () => (await saleReceipt(base, checkoutId, staff.session)).jobs)
    .toContainEqual(
      expect.objectContaining({
        requestId: droppedJob.requestId,
        state: "done",
        replayed: true,
      }),
    );
  expect(count(await printed(), RECEIPT_END)).toBe(2);

  // 7. A printer with no paper prints nothing. The Register says why, the
  //    Devices page shows the fault, and the sale stays complete.
  reconnected.status = "paper_out";
  const empty = await print(base, checkoutId, staff.session, "reprint");
  expect(empty.status, JSON.stringify(empty.body)).toBe(200);
  const emptyJob = jobOf(empty.body);
  expect(emptyJob.state).toBe("paper_out");
  expect(counterPrinterJobMessage(emptyJob)).toBe(
    "The printer has no paper. Put in a new roll, then print again.",
  );
  await expect
    .poll(async () =>
      requireKitchenDevice(
        await readDeviceList(organisationId, owner.session),
        PRINTER_NAME,
      ),
    )
    .toMatchObject({ health: "fault", faultCode: "PAPER_OUT" });
  const afterPaperOut = parseCounterSaleEnvelope(
    (
      await send(
        `${base}/commerce/counter-sales/${checkoutId}`,
        staff.session,
        "GET",
      )
    ).body,
  );
  expect(afterPaperOut).toMatchObject({
    state: "complete",
    orderId: sale.orderId,
  });
  expect(count(await printed(), RECEIPT_END)).toBe(2);

  // 8. The paper is back. A print works again and the Devices page clears.
  reconnected.status = "ready";
  const refilled = await print(base, checkoutId, staff.session, "reprint");
  expect(jobOf(refilled.body)).toMatchObject({ state: "done" });
  await expect
    .poll(async () =>
      requireKitchenDevice(
        await readDeviceList(organisationId, owner.session),
        PRINTER_NAME,
      ),
    )
    .toMatchObject({ health: "ok", faultCode: null });

  const final = await printed();
  expect(count(final, RECEIPT_END)).toBe(3);
  expect(count(final, DRAWER_OPENED)).toBe(1);
  expect(count(final, "[ 再発行 ]")).toBe(2);
  console.log(
    "COUNTER_RECEIPT_PRINTER_EVIDENCE",
    JSON.stringify({ textFile: final.length > 0 ? artifactFile : null }),
  );
  console.log(final);
  await reconnected.gateway.close();
}

let artifactFile = "";

/**
 * Carries the Platform's printer tasks to the real gateway program and its
 * answers back. With `dropAfterNextPrint`, the socket closes after the
 * program printed, before its answer reaches the Platform.
 */
class GatewayRelay {
  status: PrinterStatus = "ready";
  dropAfterNextPrint = false;

  constructor(readonly gateway: SimulatedGateway) {
    gateway.socket.addEventListener("message", (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as PlatformGatewayMessage;
      if (
        message.type === "receipt_print" ||
        message.type === "cash_drawer_kick"
      )
        void this.#answer(message);
    });
  }

  async #answer(message: PlatformGatewayMessage): Promise<void> {
    const answered = await adapters("/answer", {
      printers: [{ sourceKey: PRINTER, drawer: true, status: this.status }],
      message,
    });
    if (!Array.isArray(answered.answers))
      throw new Error(JSON.stringify(answered));
    if (message.type === "receipt_print" && this.dropAfterNextPrint) {
      this.dropAfterNextPrint = false;
      await this.gateway.close();
      return;
    }
    for (const answer of answered.answers)
      this.gateway.send(answer as GatewayMessage);
  }
}

async function adapters(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await env.SHOP_GATEWAY_ADAPTERS.fetch(
    `http://adapters${path}`,
    {
      method: "POST",
      body: JSON.stringify({ home: HOME, ...body }),
    },
  );
  const answer: unknown = await response.json();
  if (!response.ok || !isRecord(answer))
    throw new Error(JSON.stringify(answer));
  return answer;
}

async function printed(): Promise<string> {
  const answer = await adapters("/printed", { sourceKey: PRINTER });
  artifactFile = String(answer.textFile);
  return String(answer.text);
}

function print(
  base: string,
  checkoutId: string,
  session: IssuedControlSession,
  copy: "original" | "reprint" = "original",
) {
  return send(
    `${base}/commerce/counter-sales/${checkoutId}/receipt-print`,
    session,
    "POST",
    { timeZone: "Asia/Tokyo", copy },
  );
}

async function saleReceipt(
  base: string,
  checkoutId: string,
  session: IssuedControlSession,
) {
  const read = await send(
    `${base}/commerce/counter-sales/${checkoutId}/receipt`,
    session,
    "GET",
  );
  const receipt = parseCounterSaleReceipt(read.body);
  if (receipt === null) throw new Error(JSON.stringify(read.body));
  return receipt;
}

function jobOf(body: unknown): CounterPrinterJob {
  const parsed = parseCounterReceiptPrintResponse(body);
  if (parsed === null) throw new Error(JSON.stringify(body));
  return parsed.job;
}

function drawerOf(body: unknown): unknown {
  return isRecord(body) ? body.drawer : null;
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

function yen(minor: number): string {
  return `¥${minor.toLocaleString("en-US")}`;
}

/** The text rendering shows a double-size letter with a space after it. */
function spaced(text: string): string {
  return [...text]
    .map((letter) => `${letter} `)
    .join("")
    .trimEnd();
}
