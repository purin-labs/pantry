import {
  parseBankPayouts,
  type BankPayoutsWindow,
} from "@purin-labs/control-api";

import { controlRead } from "@purin-labs/control/portal/control-client";
import { controlPath } from "@purin-labs/control/portal/control-paths";

/** The Payouts page's reads of the Platform. */

/** The bank payouts that arrive from `from` to `to`, two local days. */
export async function readBankPayouts(
  organisationId: string,
  days: Readonly<{ from: string; to: string }>,
  signal: AbortSignal,
): Promise<BankPayoutsWindow> {
  const params = new URLSearchParams(days);
  return parseBankPayouts(
    await controlRead(
      `${controlPath(organisationId, "commerce/bank-payouts")}?${params.toString()}`,
      signal,
    ),
  );
}
