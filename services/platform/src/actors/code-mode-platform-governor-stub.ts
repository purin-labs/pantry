import type { Env } from "@purin-labs/kernel/env";
import type { CodeModePlatformGovernorActor } from "./code-mode-platform-governor";

// v3 starts empty. Cloudflare created the v2 object in the United States, and
// it is never read.
const GOVERNOR_OBJECT_NAME = "code-mode-platform-governor:v3";

/**
 * The region of the one governor object. Production runs in Tokyo. Cloudflare
 * has no hint for one city, and Northeast Asia-Pacific is the smallest region
 * with Tokyo in it.
 *
 * A Durable Object stays in the region where Cloudflare creates it, and the
 * hint counts only on the first call of a name. To move the governor, change
 * the name and the region together. The new object starts empty with
 * admission open, so drain Code Mode through the cutover route before that
 * release.
 */
const GOVERNOR_REGION = "apac-ne" satisfies DurableObjectLocationHint;

/**
 * The stub of the platform governor. Each caller uses this one address, so a
 * reservation and its settlement reach the same object. This module imports
 * types only.
 */
export function codeModePlatformGovernor(
  env: Pick<Env, "CODE_MODE_PLATFORM_GOVERNOR_ACTOR">,
): DurableObjectStub<CodeModePlatformGovernorActor> {
  const namespace = env.CODE_MODE_PLATFORM_GOVERNOR_ACTOR;
  return namespace.get(namespace.idFromName(GOVERNOR_OBJECT_NAME), {
    locationHint: GOVERNOR_REGION,
  });
}
