import type { Result } from "../result";
import type { TypeSafeCredential } from "../integrations/typesafe/credential";
import type { TypeSafeUsageLimits } from "../integrations/typesafe/evaluation-ledger";
import { parseTypeSafeUsageLimits } from "../integrations/typesafe/evaluation-ledger";
import { isRecord } from "@purin-labs/std";
import {
  sameTypeSafeAuthority,
  type TypeSafeAuthority,
} from "../integrations/typesafe/authority";

type CaseContextCollectionSource = "commerce" | "gmail" | "whatsapp";

export type CaseContextDiscoveryPolicy =
  | Readonly<{
      mode: "disabled";
      route?: never;
      limits?: never;
      sources?: never;
    }>
  | Readonly<{
      mode: "shadow" | "metadata_only" | "party_context";
      route: CaseContextDiscoveryRoute;
      sources: readonly Readonly<{
        source: CaseContextCollectionSource;
        integrationAccountId: string;
      }>[];
      limits: TypeSafeUsageLimits;
    }>;

/** The pinned TypeSafe authority of the policy (Plan 88 D6). */
export type CaseContextDiscoveryRoute =
  | Readonly<{
      provider: "typesafe";
      connectionRevision: number;
      funding: "organisation_byo";
      credentialRef: "organisation_typesafe";
    }>
  | Readonly<{
      provider: "typesafe";
      connectionRevision?: never;
      funding: "satyr_platform";
      credentialRef: "satyr_typesafe";
    }>;

export function caseContextDiscoveryRouteAuthority(
  route: CaseContextDiscoveryRoute,
): TypeSafeAuthority {
  return route.funding === "satyr_platform"
    ? { kind: "satyr_platform" }
    : {
        kind: "organisation_byo",
        connectionRevision: route.connectionRevision,
      };
}

export function caseContextDiscoveryRoute(
  authority: TypeSafeAuthority,
): CaseContextDiscoveryRoute {
  return authority.kind === "satyr_platform"
    ? {
        provider: "typesafe",
        funding: "satyr_platform",
        credentialRef: "satyr_typesafe",
      }
    : {
        provider: "typesafe",
        connectionRevision: authority.connectionRevision,
        funding: "organisation_byo",
        credentialRef: "organisation_typesafe",
      };
}

function parseCaseContextDiscoveryRoute(
  raw: unknown,
): CaseContextDiscoveryRoute | null {
  if (!isRecord(raw) || raw.provider !== "typesafe") return null;
  if (raw.funding === "satyr_platform")
    return raw.credentialRef === "satyr_typesafe" &&
      Object.keys(raw).length === 3
      ? caseContextDiscoveryRoute({ kind: "satyr_platform" })
      : null;
  if (
    raw.funding !== "organisation_byo" ||
    raw.credentialRef !== "organisation_typesafe" ||
    !integerIn(raw.connectionRevision, 1, Number.MAX_SAFE_INTEGER) ||
    Object.keys(raw).length !== 4
  )
    return null;
  return caseContextDiscoveryRoute({
    kind: "organisation_byo",
    connectionRevision: raw.connectionRevision,
  });
}

export type EnabledCaseContextDiscoveryPolicy = Exclude<
  CaseContextDiscoveryPolicy,
  { mode: "disabled" }
>;

type CaseContextCollectionInactiveReason =
  | "disabled"
  | "credential_unavailable"
  | "source_not_enabled"
  | "recipient_isolation_unavailable";

type CaseContextDiscoveryReadiness =
  | Readonly<{ kind: "inactive"; reason: CaseContextCollectionInactiveReason }>
  | Readonly<{
      kind: "ready";
      policy: EnabledCaseContextDiscoveryPolicy;
    }>;

export function parseCaseContextDiscoveryPolicy(
  raw: unknown,
): Result<
  CaseContextDiscoveryPolicy,
  { code: "case_context_discovery_policy_invalid" }
> {
  if (!isRecord(raw)) return invalidPolicy();
  if (raw.mode === "disabled") {
    return Object.keys(raw).length === 1
      ? { ok: true, value: { mode: "disabled" } }
      : invalidPolicy();
  }
  const limits = parseTypeSafeUsageLimits(raw.limits);
  const route = parseCaseContextDiscoveryRoute(raw.route);
  if (
    (raw.mode !== "shadow" &&
      raw.mode !== "metadata_only" &&
      raw.mode !== "party_context") ||
    route === null ||
    Object.keys(raw).length !== 4 ||
    limits === null ||
    !Array.isArray(raw.sources) ||
    raw.sources.length === 0 ||
    raw.sources.length > 20
  )
    return invalidPolicy();
  const sources: {
    source: CaseContextCollectionSource;
    integrationAccountId: string;
  }[] = [];
  const seen = new Set<string>();
  for (const source of raw.sources) {
    if (
      !isRecord(source) ||
      Object.keys(source).length !== 2 ||
      (source.source !== "commerce" &&
        source.source !== "gmail" &&
        source.source !== "whatsapp") ||
      !identifier(source.integrationAccountId)
    )
      return invalidPolicy();
    const key = JSON.stringify([source.source, source.integrationAccountId]);
    if (seen.has(key)) return invalidPolicy();
    seen.add(key);
    sources.push({
      source: source.source,
      integrationAccountId: source.integrationAccountId,
    });
  }
  return {
    ok: true,
    value: {
      mode: raw.mode,
      route,
      sources,
      limits,
    },
  };
}

export function caseContextDiscoveryReadiness(input: {
  readonly policy: CaseContextDiscoveryPolicy;
  readonly credential: TypeSafeCredential | null;
  readonly source: CaseContextCollectionSource;
  readonly integrationAccountId: string;
}): CaseContextDiscoveryReadiness {
  if (input.policy.mode === "disabled")
    return { kind: "inactive", reason: "disabled" };
  if (
    input.credential === null ||
    input.credential.provider !== input.policy.route.provider ||
    !sameTypeSafeAuthority(
      input.credential.authority,
      caseContextDiscoveryRouteAuthority(input.policy.route),
    )
  ) {
    return { kind: "inactive", reason: "credential_unavailable" };
  }
  if (!input.policy.sources.some(matchesSource.bind(null, input))) {
    return { kind: "inactive", reason: "source_not_enabled" };
  }
  if (input.policy.mode === "party_context" && input.source !== "gmail") {
    return { kind: "inactive", reason: "recipient_isolation_unavailable" };
  }
  return { kind: "ready", policy: input.policy };
}

function matchesSource(
  expected: {
    source: CaseContextCollectionSource;
    integrationAccountId: string;
  },
  actual: { source: CaseContextCollectionSource; integrationAccountId: string },
): boolean {
  return (
    actual.source === expected.source &&
    actual.integrationAccountId === expected.integrationAccountId
  );
}

export function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9:_.\/-]{0,199}$/.test(value)
  );
}

export function integerIn(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function invalidPolicy(): Result<
  never,
  { code: "case_context_discovery_policy_invalid" }
> {
  return {
    ok: false,
    error: { code: "case_context_discovery_policy_invalid" },
  };
}
