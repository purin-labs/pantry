import type { GoogleOidcConfig } from "./oidc";
import type { Env } from "../env";
import { requirePublicOrigin } from "../public-origin";

export function googleConfig(env: Env): GoogleOidcConfig | null {
  if (
    env.GOOGLE_OIDC_CLIENT_ID === undefined ||
    env.GOOGLE_OIDC_CLIENT_SECRET === undefined
  ) {
    return null;
  }
  return {
    clientId: env.GOOGLE_OIDC_CLIENT_ID,
    clientSecret: env.GOOGLE_OIDC_CLIENT_SECRET,
    redirectUri: `${requirePublicOrigin(env.SATYR_PUBLIC_ORIGIN)}/v1/control/auth/google/callback`,
  };
}
