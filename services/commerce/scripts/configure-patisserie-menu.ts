// The pâtisserie menu, recipes and supplier pack cost baseline of the demo shop
// at shop.seams.tokyo. Each bake is a finished good with its own stock and
// batch recipe; each drink is made to order from a recipe whose ingredients and
// cups are stocked at the café. Every item has a listed offer on the café sales
// channel and one entry on the café menu.
import {
  PATISSERIE_ITEMS,
  PATISSERIE_SUPPLIES,
  CommerceAdminClient,
  CommerceEntityPlaneClient,
  CommerceStorefrontClient,
  configurePatisserieMenu,
  includeStorefrontTax,
  patisserieRecipeId,
  patisserieVariantId,
  seedPatisserieSupplyCosts,
  type PatisserieItem,
  type PatisserieMenuSetupResult,
} from "@seams/commerce-client";
import { isMainModule } from "./merchant-script.ts";

export {
  PATISSERIE_ITEMS,
  PATISSERIE_SUPPLIES,
  configurePatisserieMenu,
  includeStorefrontTax,
  patisserieRecipeId,
  patisserieVariantId,
  seedPatisserieSupplyCosts,
  type PatisserieItem,
  type PatisserieMenuSetupResult,
};

type SetupArguments = Readonly<{
  merchantId: string;
  organisationId: string | undefined;
  stockDays: number;
  /** Basis points of a tax that the listed prices include, such as 800. */
  includedTax: number | undefined;
  baseUrl: string;
  serviceToken: string;
}>;

if (isMainModule(import.meta.url)) await main();

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2), process.env);
  const client = new CommerceAdminClient({
    baseUrl: arguments_.baseUrl,
    serviceToken: arguments_.serviceToken,
  });
  const entityPlane =
    arguments_.organisationId === undefined
      ? undefined
      : {
          client: new CommerceEntityPlaneClient({
            baseUrl: arguments_.baseUrl,
            serviceToken: arguments_.serviceToken,
          }),
          organisationId: arguments_.organisationId,
        };
  const menu = await configurePatisserieMenu(
    client,
    arguments_.merchantId,
    new Date(),
    arguments_.stockDays,
    entityPlane === undefined ? undefined : { entityPlane },
  );
  const tax =
    arguments_.includedTax === undefined
      ? undefined
      : await includeStorefrontTax(
          client,
          new CommerceStorefrontClient({ baseUrl: arguments_.baseUrl }),
          arguments_.merchantId,
          arguments_.includedTax,
        );
  process.stdout.write(`${JSON.stringify({ ...menu, tax }, null, 2)}\n`);
}

function parseArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): SetupArguments {
  const values = new Map<string, string>();
  const start = argv[0] === "--" ? 1 : 0;
  for (let index = start; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error(
        "Usage: configure:patisserie-menu --merchant <merchant_id> [--organisation <organisation_id>] [--stock-days <days>] [--included-tax <basis points>]",
      );
    }
    values.set(flag, value);
  }
  const merchantId = values.get("--merchant");
  if (
    merchantId === undefined ||
    !/^merchant_[A-Za-z0-9_]+$/u.test(merchantId)
  ) {
    throw new Error("--merchant must be a merchant_ identity");
  }
  const organisationId = values.get("--organisation");
  if (organisationId !== undefined && organisationId.trim().length === 0) {
    throw new Error("--organisation must not be empty");
  }
  const stockDays = Number(values.get("--stock-days") ?? "14");
  if (!Number.isInteger(stockDays) || stockDays < 1 || stockDays > 90) {
    throw new Error("--stock-days must be a whole number from 1 to 90");
  }
  const includedTaxText = values.get("--included-tax");
  const includedTax =
    includedTaxText === undefined ? undefined : Number(includedTaxText);
  if (
    includedTax !== undefined &&
    (!Number.isInteger(includedTax) || includedTax < 0 || includedTax > 10_000)
  ) {
    throw new Error("--included-tax must be basis points from 0 to 10000");
  }
  const baseUrl = env.UNDERCLERK_BASE_URL;
  if (baseUrl === undefined) throw new Error("UNDERCLERK_BASE_URL is required");
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("UNDERCLERK_BASE_URL must use http or https");
  }
  const serviceToken = env.UNDERCLERK_SERVICE_TOKEN;
  if (serviceToken === undefined || serviceToken.length === 0) {
    throw new Error("UNDERCLERK_SERVICE_TOKEN is required");
  }
  return {
    merchantId,
    organisationId,
    stockDays,
    includedTax,
    baseUrl: parsed.toString(),
    serviceToken,
  };
}
