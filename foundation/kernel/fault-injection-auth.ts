type BearerAuthInput = {
  authorization: string | null;
  configuredToken: string | undefined;
};

type FaultInjectionConfig =
  { kind: "disabled" } | { kind: "enabled"; token: string };

type FaultInjectionCredential =
  { kind: "missing" } | { kind: "bearer"; token: string };

const MINIMUM_FAULT_TOKEN_LENGTH = 32;
const BEARER_PREFIX = "Bearer ";

export function authorizeFaultInjectionBearer(input: BearerAuthInput): boolean {
  return authorizeConfiguredBearer(input);
}

/**
 * Whether a fault point may act: the Worker has a fault injection token that
 * the fault routes would accept. Each fault point and each route uses this
 * one rule.
 */
export function faultInjectionEnabled(
  configuredToken: string | undefined,
): boolean {
  return parseFaultInjectionConfig(configuredToken).kind === "enabled";
}

export function authorizeConfiguredBearer(input: BearerAuthInput): boolean {
  const config = parseFaultInjectionConfig(input.configuredToken);
  const credential = parseFaultInjectionCredential(input.authorization);

  if (config.kind === "disabled" || credential.kind === "missing") {
    return false;
  }

  return timingSafeEqual(config.token, credential.token);
}

function parseFaultInjectionConfig(
  raw: string | undefined,
): FaultInjectionConfig {
  const token = raw?.trim() ?? "";

  if (token.length < MINIMUM_FAULT_TOKEN_LENGTH) {
    return { kind: "disabled" };
  }

  return { kind: "enabled", token };
}

function parseFaultInjectionCredential(
  raw: string | null,
): FaultInjectionCredential {
  if (raw === null || !raw.startsWith(BEARER_PREFIX)) {
    return { kind: "missing" };
  }

  const token = raw.slice(BEARER_PREFIX.length);

  if (token.length === 0 || token.trim() !== token) {
    return { kind: "missing" };
  }

  return { kind: "bearer", token };
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}
