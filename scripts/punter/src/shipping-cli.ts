import { setTimeout as wait } from "node:timers/promises";

import { keepStdoutForResult, requiredEnvironment } from "./cli-environment.ts";
import {
  ONLINE_COOKIE_SCENARIO,
  DOMESTIC_JAPAN_SCENARIO,
  MATCHA_EXPORT_SCENARIO,
  LOCAL_ONLINE_COOKIE_SCENARIO,
} from "./scenario-fixtures.ts";
import { runPunterShippingScenario } from "./shipping-scenario.ts";

keepStdoutForResult();
const result = await runPunterShippingScenario({
  baseUrl: requiredEnvironment("PUNTER_UNDERCLERK_BASE_URL"),
  merchantId: requiredEnvironment("PUNTER_MERCHANT_ID"),
  storefrontId: requiredEnvironment("PUNTER_STOREFRONT_ID"),
  scenario: selectScenario(process.env.PUNTER_SHIPPING_SCENARIO),
  runId: requiredEnvironment("PUNTER_RUN_ID"),
  fetch: globalThis.fetch,
  orderPolling: { maxAttempts: 60, intervalMs: 2_000, wait },
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) {
  process.exitCode = 1;
}

function selectScenario(name: string | undefined) {
  if (name === undefined || name === "online_cookie")
    return ONLINE_COOKIE_SCENARIO;
  if (name === "matcha_export") return MATCHA_EXPORT_SCENARIO;
  if (name === "domestic_japan") return DOMESTIC_JAPAN_SCENARIO;
  if (name === "local_online_cookie") return LOCAL_ONLINE_COOKIE_SCENARIO;
  throw new Error(
    "PUNTER_SHIPPING_SCENARIO must be online_cookie, domestic_japan, matcha_export, or local_online_cookie",
  );
}
