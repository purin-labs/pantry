import {
  parseOrderTimes,
  type OrderTimesWindow,
} from "@purin-labs/control-api";

import { controlRead } from "@purin-labs/control/portal/control-client";
import { periodPath } from "@purin-labs/control/portal/control-paths";
import type { PeriodWindow } from "../../ui";

/** The Orders page's reads of the Platform. */

export async function readOrderTimes(
  organisationId: string,
  window: PeriodWindow,
  signal: AbortSignal,
): Promise<OrderTimesWindow> {
  return parseOrderTimes(
    await controlRead(
      periodPath(organisationId, "commerce/order-times", window),
      signal,
    ),
  );
}
