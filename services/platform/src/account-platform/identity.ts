import { canonicalJson, sha256Hex } from "@purin-labs/std";
import type { UserId } from "../ids";
import type { Result } from "../result";
import { resolveUser } from "../data/control-plane";
import type { ActiveControlSession } from "../data/control-plane";
import { createAccountPlatformClient } from "./client";
import type { AccountPlatformBindings } from "./config";
import {
  readLinkedUser,
  accountUnavailable,
  type AccountPlatformError,
  type LinkedPantryAccountUser,
  type PantryAccountBinding,
} from "./types";

export async function resolveLinkedPantryAccountUser(
  env: AccountPlatformBindings,
  userId: UserId,
): Promise<Result<LinkedPantryAccountUser, AccountPlatformError>> {
  try {
    const row = await env.DB.prepare(
      `SELECT native_user_id AS nativeUserId, platform_user_id AS platformUserId, provider_issuer AS issuer, provider_subject AS subject, verification_receipt_id AS verificationReceiptId FROM account_identity_link WHERE native_user_id = ?`,
    )
      .bind(userId)
      .first<unknown>();
    if (row === null)
      return { ok: false, error: { code: "membership_ineligible" } };
    return { ok: true, value: readLinkedUser(row) };
  } catch {
    return accountUnavailable();
  }
}

/** Register the verified login before the user selects or creates a Platform project. */
export async function registerPantryOnboardingIdentity(
  env: AccountPlatformBindings,
  session: ActiveControlSession,
  googleIdToken: string,
): Promise<Result<LinkedPantryAccountUser, AccountPlatformError>> {
  const client = createAccountPlatformClient(env);
  if (!client.ok) return client;
  const user = await resolveUser({ db: env.DB, userId: session.userId });
  if (!user) return { ok: false, error: { code: "scope_forbidden" } };
  const registered = await client.value.registerOnboardingIdentity(
    user,
    session,
    googleIdToken,
  );
  if (!registered.ok) return registered;
  if (
    registered.value.nativeUserId !== user.userId ||
    registered.value.subject !== user.subject ||
    registered.value.platformUserId !== `google:${user.subject}`
  )
    return { ok: false, error: { code: "scope_forbidden" } };
  const identity = registered.value;
  await env.DB.prepare(
    `INSERT INTO account_identity_link (native_user_id, platform_user_id, provider_issuer, provider_subject, verification_receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (native_user_id) DO NOTHING`,
  )
    .bind(
      user.userId,
      identity.platformUserId,
      identity.issuer,
      identity.subject,
      identity.verificationReceiptId,
      Date.now(),
    )
    .run();
  const stored = await resolveLinkedPantryAccountUser(env, user.userId);
  if (!stored.ok) return stored;
  if (canonicalJson(stored.value) !== canonicalJson(identity))
    return { ok: false, error: { code: "scope_forbidden" } };
  return stored;
}
/** The Google token is transient. Only the account's verified identity receipt is retained. */
export async function linkPantryAccountUser(
  env: AccountPlatformBindings,
  input: Readonly<{
    binding: PantryAccountBinding;
    userId: UserId;
    nativeSessionId: string;
    googleIdToken: string;
  }>,
): Promise<Result<LinkedPantryAccountUser, AccountPlatformError>> {
  const client = createAccountPlatformClient(env);
  if (!client.ok) return client;
  try {
    const native = await resolveUser({ db: env.DB, userId: input.userId });
    if (
      native === null ||
      native.issuer !== "https://accounts.google.com" ||
      !native.emailVerified
    )
      return { ok: false, error: { code: "scope_forbidden" } };
    const candidate: LinkedPantryAccountUser = {
      nativeUserId: native.userId,
      platformUserId: `google:${native.subject}`,
      issuer: "https://accounts.google.com",
      subject: native.subject,
      verificationReceiptId: `google:${await sha256Hex(canonicalJson(input.googleIdToken))}`,
    };
    const linked = await client.value.linkUser({
      binding: input.binding,
      user: candidate,
      authority: {
        kind: "authenticated_session",
        nativeSessionId: input.nativeSessionId,
      },
      action: "execute",
      googleIdToken: input.googleIdToken,
    });
    if (!linked.ok) return linked;
    if (
      linked.value.nativePrincipalId !== native.userId ||
      linked.value.instanceId !== input.binding.instanceId ||
      linked.value.principal.kind !== "user" ||
      linked.value.principal.identity.issuer !== native.issuer ||
      linked.value.principal.identity.subject !== native.subject ||
      linked.value.principal.identity.userId !== candidate.platformUserId
    )
      return { ok: false, error: { code: "scope_forbidden" } };
    const identity = linked.value.principal.identity;
    await env.DB.prepare(
      `INSERT INTO account_identity_link (native_user_id, platform_user_id, provider_issuer, provider_subject, verification_receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (native_user_id) DO NOTHING`,
    )
      .bind(
        native.userId,
        identity.userId,
        identity.issuer,
        identity.subject,
        identity.verificationReceiptId,
        Date.now(),
      )
      .run();
    return resolveLinkedPantryAccountUser(env, input.userId);
  } catch {
    return accountUnavailable();
  }
}
