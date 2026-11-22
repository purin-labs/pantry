import type { Env } from "@purin-labs/kernel/env";
import { requirePublicOrigin } from "@purin-labs/kernel/public-origin";

type ProviderIngressOriginEnv = Pick<
  Env,
  | "PANTRY_OAUTH_CALLBACK_ORIGIN"
  | "PANTRY_PROVIDER_INGRESS_ORIGIN"
  | "PANTRY_PUBLIC_ORIGIN"
>;

/** The origin where a provider sends its webhooks and its callbacks. */
export function providerIngressOrigin(env: ProviderIngressOriginEnv): string {
  return requirePublicOrigin(
    env.PANTRY_PROVIDER_INGRESS_ORIGIN ??
      env.PANTRY_OAUTH_CALLBACK_ORIGIN ??
      env.PANTRY_PUBLIC_ORIGIN,
  );
}
