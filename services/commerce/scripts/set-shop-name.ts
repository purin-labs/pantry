// Sets a storefront's shop name (Plan 40B phase 2), so that its QR order page
// opens at `<name>.menu.<domain>`. Without --name it reads the current name.
//
//   pnpm --filter @purin-labs/commerce-worker set:shop-name --merchant <merchant_id> \
//     [--storefront storefront_cafe] [--name <name>]
//
// COMMERCE_BASE_URL and COMMERCE_SERVICE_TOKEN name the Commerce. The
// script prints Commerce's answer as JSON; a refused name exits with 2.
import { CommerceAdminClient } from "@purin-labs/commerce-client";

const usage =
  "Usage: set:shop-name --merchant <merchant_id> [--storefront <storefront_id>] [--name <name>]";

const values = new Map<string, string>();
const argv = process.argv.slice(2);
for (let index = argv[0] === "--" ? 1 : 0; index < argv.length; index += 2) {
  const flag = argv[index];
  const value = argv[index + 1];
  if (flag === undefined || value === undefined || !flag.startsWith("--"))
    throw new Error(usage);
  values.set(flag, value);
}
const merchantId = values.get("--merchant");
if (merchantId === undefined || !/^merchant_[A-Za-z0-9_]+$/u.test(merchantId))
  throw new Error("--merchant must be a merchant_ identity");
const storefrontId = values.get("--storefront") ?? "storefront_cafe";
const name = values.get("--name");
const baseUrl = process.env.COMMERCE_BASE_URL;
const serviceToken = process.env.COMMERCE_SERVICE_TOKEN;
if (baseUrl === undefined || serviceToken === undefined || serviceToken === "")
  throw new Error(
    "COMMERCE_BASE_URL and COMMERCE_SERVICE_TOKEN are required",
  );

const client = new CommerceAdminClient({ baseUrl, serviceToken });
const result =
  name === undefined
    ? await client.readStorefrontShopName(merchantId, storefrontId)
    : await client.setStorefrontShopName(merchantId, storefrontId, name);
if (!result.ok) {
  throw new Error(
    `The shop name request failed: ${result.error.kind}: ${result.error.message}`,
  );
}
process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
if ("outcome" in result.value && result.value.outcome === "refused")
  process.exitCode = 2;
