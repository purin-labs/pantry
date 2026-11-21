import type { D1Migration } from "@cloudflare/vitest-plugin";

import type { Env as PantryEnv } from "../../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends PantryEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_REGIONAL_MIGRATIONS: D1Migration[];
      /** The cron triggers of the production Worker. */
      TEST_PRODUCTION_CRONS: string[];
      VAULT_ROOT_V1: SecretsStoreSecret;
      VAULT_ROOT_V2: SecretsStoreSecret;
      /** `tests/shop-gateway-adapters.ts`: the real gateway's device adapters. */
      SHOP_GATEWAY_ADAPTERS: Fetcher;
      JOURNEY_ARTIFACTS: Fetcher;
    }

    interface GlobalProps {
      mainModule: typeof import("./runtime-worker");
      durableNamespaces:
        "CaseDO" | "ConnectorDO" | "SessionDO" | "OrganisationDO";
    }
  }
}

export {};
