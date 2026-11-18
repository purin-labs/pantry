import type { Env } from "../env";
import type { Result } from "../result";
import {
  accountText,
  accountUnavailable,
  type AccountPlatformError,
} from "./types";

export type AccountPlatformBindings = Pick<
  Env,
  | "DB"
  | "ACCOUNT_PLATFORM"
  | "ACCOUNT_PLATFORM_DEPLOYMENT_ID"
  | "ACCOUNT_PLATFORM_USER_ASSERTION_KEY_ID"
  | "ACCOUNT_PLATFORM_USER_ASSERTION_PKCS8_B64U"
  | "ACCOUNT_PLATFORM_ASSERTION_ISSUER"
  | "ACCOUNT_PLATFORM_ASSERTION_AUDIENCE"
>;
export type AccountPlatformConfiguration = Readonly<{
  deploymentId: string;
  transport: Fetcher;
  assertion: Readonly<{
    keyId: string;
    pkcs8: string;
    issuer: string;
    audience: string;
  }>;
}>;

export function parseAccountPlatformConfiguration(
  env: AccountPlatformBindings,
): Result<AccountPlatformConfiguration, AccountPlatformError> {
  try {
    if (!env.ACCOUNT_PLATFORM)
      throw new Error("Account Platform service binding is required");
    return {
      ok: true,
      value: {
        deploymentId: accountText(env.ACCOUNT_PLATFORM_DEPLOYMENT_ID),
        transport: env.ACCOUNT_PLATFORM,
        assertion: {
          keyId: accountText(env.ACCOUNT_PLATFORM_USER_ASSERTION_KEY_ID),
          pkcs8: accountText(env.ACCOUNT_PLATFORM_USER_ASSERTION_PKCS8_B64U),
          issuer: accountText(env.ACCOUNT_PLATFORM_ASSERTION_ISSUER),
          audience: accountText(env.ACCOUNT_PLATFORM_ASSERTION_AUDIENCE),
        },
      },
    };
  } catch {
    return accountUnavailable();
  }
}
