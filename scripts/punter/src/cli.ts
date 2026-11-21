import { setTimeout as wait } from "node:timers/promises";

import { keepStdoutForResult, requiredEnvironment } from "./cli-environment.ts";
import { runPunterPickupScenario } from "./pickup-scenario.ts";
import {
  CAFE_PATISSERIE_SCENARIO,
  LOCAL_CAFE_PATISSERIE_SCENARIO,
} from "./scenario-fixtures.ts";

keepStdoutForResult();
const result = await runPunterPickupScenario({
  baseUrl: requiredEnvironment("PUNTER_COMMERCE_BASE_URL"),
  merchantId: requiredEnvironment("PUNTER_MERCHANT_ID"),
  storefrontId: requiredEnvironment("PUNTER_STOREFRONT_ID"),
  scenario: selectScenario(process.env.PUNTER_PICKUP_SCENARIO),
  runId: requiredEnvironment("PUNTER_RUN_ID"),
  fetch: globalThis.fetch,
  orderPolling: { maxAttempts: 30, intervalMs: 2_000, wait },
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) {
  process.exitCode = 1;
}

function selectScenario(name: string | undefined) {
  if (name === undefined || name === "cafe_patisserie")
    return CAFE_PATISSERIE_SCENARIO;
  if (name === "local_cafe") return LOCAL_CAFE_PATISSERIE_SCENARIO;
  throw new Error(
    "PUNTER_PICKUP_SCENARIO must be cafe_patisserie or local_cafe",
  );
}
