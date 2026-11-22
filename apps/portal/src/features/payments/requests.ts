import { parsePaymentsDay, type PaymentsDay } from "@purin-labs/control-api";

import { controlRead } from "@purin-labs/control/portal/control-client";
import { periodPath } from "@purin-labs/control/portal/control-paths";
import type { PeriodWindow } from "../../ui";

/** The Payments page's reads of the Platform. */

export async function readPayments(
  organisationId: string,
  window: PeriodWindow,
  signal: AbortSignal,
): Promise<PaymentsDay> {
  return parsePaymentsDay(
    await controlRead(
      periodPath(organisationId, "commerce/payments", window),
      signal,
    ),
  );
}
