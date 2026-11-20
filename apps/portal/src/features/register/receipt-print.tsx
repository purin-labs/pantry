import React from "react";
import {
  counterPrinterJobMessage,
  parseCounterReceiptPrintResponse,
  parseCounterSaleReceipt,
  type CounterPrinterJob,
  type CounterSaleReceipt,
} from "@purin-labs/control-api";

import { controlMutation, controlRead } from "../../control-client";

/**
 * "Print receipt" on the Register (Plan 90 Phase 5). With a bound receipt
 * printer that is online, the printer prints the receipt. With no printer, or
 * with a printer that cannot print now, the browser prints it. A print error
 * never changes the sale; this control only says what happened.
 */
export function ReceiptPrintControl(
  props: Readonly<{ organisationId: string; checkoutId: string }>,
): React.ReactNode {
  const [receipt, setReceipt] = React.useState<CounterSaleReceipt | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Readonly<{
    text: string;
    fallback: boolean;
    error: boolean;
  }> | null>(null);

  React.useEffect(() => {
    let current = true;
    void readSaleReceipt(props.organisationId, props.checkoutId)
      .then((read) => {
        if (!current) return;
        setReceipt(read);
        // The drawer opened with the cash sale. Say so only when it did not.
        const drawer = read.jobs
          .filter((job) => job.task === "cash_drawer_kick")
          .at(-1);
        if (drawer !== undefined && drawer.state !== "done")
          setNotice({
            text: counterPrinterJobMessage(drawer),
            fallback: false,
            error: true,
          });
      })
      .catch(() => {
        if (current) setReceipt({ ok: true, printer: null, jobs: [] });
      });
    return () => {
      current = false;
    };
  }, [props.organisationId, props.checkoutId]);

  const print = async () => {
    const printer = receipt?.printer ?? null;
    if (printer === null) {
      window.print();
      return;
    }
    if (!printer.connected) {
      setNotice({
        text: "The receipt printer is offline. The browser prints the receipt.",
        fallback: false,
        error: true,
      });
      window.print();
      return;
    }
    setBusy(true);
    try {
      const printedBefore = (receipt?.jobs ?? []).some(
        (job) => job.task === "receipt_print" && job.state === "done",
      );
      const job = await printOnPrinter(
        props.organisationId,
        props.checkoutId,
        printedBefore ? "reprint" : "original",
      );
      setReceipt((read) =>
        read === null ? read : { ...read, jobs: [...read.jobs, job] },
      );
      if (job.state === "offline" || job.state === "gateway_offline") {
        setNotice({
          text: counterPrinterJobMessage(job),
          fallback: false,
          error: true,
        });
        window.print();
      } else {
        setNotice({
          text: counterPrinterJobMessage(job),
          fallback: job.state !== "done",
          error: job.state !== "done",
        });
      }
    } catch {
      setNotice({
        text: "Seams Pantry could not reach the printer. You can print in the browser.",
        fallback: true,
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="register-secondary-btn"
        disabled={busy}
        onClick={() => void print()}
      >
        {busy ? "Printing…" : "Print receipt"}
      </button>
      {notice !== null ? (
        <div
          className={
            notice.error
              ? "register-error register-receipt-note"
              : "register-receipt-note"
          }
          role="status"
        >
          <span>{notice.text}</span>
          {notice.fallback ? (
            <button
              type="button"
              className="register-secondary-btn"
              onClick={() => window.print()}
            >
              Print in the browser
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

async function readSaleReceipt(
  organisationId: string,
  checkoutId: string,
): Promise<CounterSaleReceipt> {
  const read = parseCounterSaleReceipt(
    await controlRead(`${salePath(organisationId, checkoutId)}/receipt`),
  );
  if (read === null) throw new Error("The receipt printer could not be read.");
  return read;
}

async function printOnPrinter(
  organisationId: string,
  checkoutId: string,
  copy: "original" | "reprint",
): Promise<CounterPrinterJob> {
  const printed = parseCounterReceiptPrintResponse(
    await controlMutation(
      `${salePath(organisationId, checkoutId)}/receipt-print`,
      "POST",
      { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, copy },
      undefined,
      // Each press is one print. A retry of the same press prints nothing more.
      {
        kind: "prepared",
        idempotencyKey: `counter-receipt:${checkoutId}:${crypto.randomUUID()}`,
      },
    ),
  );
  if (printed === null) throw new Error("The print answer could not be read.");
  return printed.job;
}

function salePath(organisationId: string, checkoutId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/counter-sales/${encodeURIComponent(checkoutId)}`;
}
