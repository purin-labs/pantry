import type { OrganisationDatabase } from "../../database-handles";
import type { CredentialVaultBindings } from "../../credential-vault/keyring";
import type { OrganisationId } from "../../ids";
import type { TypeSafeAuthority } from "../../policy/information-flow/types";
import type { TypeSafeCredential } from "./credential";
import {
  readTypeSafeConnection,
  resolveTypeSafeConnectionKey,
} from "./connection";
import { validJevApiKey } from "./system-one-client";

/**
 * Who funds one TypeSafe call (Plan 88 section 1). An Organisation with its own
 * connected key keeps it; every other Organisation uses Pantry's key.
 */
export type { TypeSafeAuthority };

const SATYR_TYPESAFE_AUTHORITY: TypeSafeAuthority = Object.freeze({
  kind: "satyr_platform",
});

type TypeSafePlatformBindings = Readonly<{
  TYPESAFE_API_KEY?: string;
}>;

/** The authority that a new call or a new pin uses now. */
export function currentTypeSafeAuthority(
  sql: SqlStorage,
  organisationId: OrganisationId,
): TypeSafeAuthority {
  const connection = readTypeSafeConnection(sql, organisationId);
  return connection.kind === "connected"
    ? { kind: "organisation_byo", connectionRevision: connection.revision }
    : SATYR_TYPESAFE_AUTHORITY;
}

/** A pinned authority stays current until the Organisation's key changes. */
export function typeSafeAuthorityIsCurrent(
  sql: SqlStorage,
  organisationId: OrganisationId,
  authority: TypeSafeAuthority,
): boolean {
  return sameTypeSafeAuthority(
    currentTypeSafeAuthority(sql, organisationId),
    authority,
  );
}

export function sameTypeSafeAuthority(
  left: TypeSafeAuthority,
  right: TypeSafeAuthority,
): boolean {
  if (left.kind === "satyr_platform") return right.kind === "satyr_platform";
  return (
    right.kind === "organisation_byo" &&
    right.connectionRevision === left.connectionRevision
  );
}

/** The stored revision: 0 for Pantry's key, the connection revision otherwise. */
export function typeSafeAuthorityRevision(
  authority: TypeSafeAuthority,
): number {
  return authority.kind === "satyr_platform" ? 0 : authority.connectionRevision;
}

export function typeSafeAuthorityFromStored(
  funding: unknown,
  revision: unknown,
): TypeSafeAuthority | null {
  if (funding === "satyr_platform")
    return revision === 0 || revision === null || revision === undefined
      ? SATYR_TYPESAFE_AUTHORITY
      : null;
  if (
    funding === "organisation_byo" &&
    typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision >= 1
  )
    return { kind: "organisation_byo", connectionRevision: revision };
  return null;
}

/**
 * Resolves the key for the current authority. Pantry's key is the Wrangler
 * secret `TYPESAFE_API_KEY`; the Organisation's key comes from the Vault and is
 * read only when the Organisation connected one.
 */
export async function resolveTypeSafeCredential(
  input: Readonly<{
    sql: SqlStorage;
    db: OrganisationDatabase;
    keys: CredentialVaultBindings & TypeSafePlatformBindings;
    organisationId: OrganisationId;
  }>,
): Promise<TypeSafeCredential | null> {
  const authority = currentTypeSafeAuthority(input.sql, input.organisationId);
  if (authority.kind === "organisation_byo") {
    const key = await resolveTypeSafeConnectionKey(input);
    if (key === null || key.revision !== authority.connectionRevision)
      return null;
    return { provider: "typesafe", apiKey: key.apiKey, authority };
  }
  const apiKey = resolvePantryTypeSafeKey(input.keys);
  if (apiKey === null) return null;
  return { provider: "typesafe", apiKey, authority };
}

/** Pantry's own key, or null when the Worker has no valid `TYPESAFE_API_KEY`. */
export function resolvePantryTypeSafeKey(
  keys: TypeSafePlatformBindings,
): string | null {
  const apiKey = keys.TYPESAFE_API_KEY;
  return apiKey !== undefined && validJevApiKey(apiKey) ? apiKey : null;
}
