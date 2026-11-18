import type { OrganisationId } from "../ids";
import type { Result } from "../result";
import type { VaultKeyVersion } from "./keyring";
import type { Variant } from "@seams/type-utils";

const vaultHandleBrand: unique symbol = Symbol("VaultHandle");
const VAULT_HANDLE_PATTERN = /^vault:[a-z0-9][a-z0-9:_-]*$/;

export type VaultHandle = string & {
  readonly [vaultHandleBrand]: "VaultHandle";
};

/**
 * The formats of an opaque profile: the Codex sign-in and its device code
 * (Plan 72), and the "Sign in with ChatGPT" tokens and their open sign-in
 * (Plan 74B).
 */
export type VaultOpaqueProfileFormat =
  | "codex_auth_json_v1"
  | "codex_device_authorization_v1"
  | "chatgpt_agent_profile_v1"
  | "chatgpt_agent_sign_in_v1"
  /** A Square connection that Underclerk holds; no token (Plan 80 step 4). */
  | "underclerk_square_connection_v1";

const VAULT_OPAQUE_PROFILE_FORMATS: Readonly<
  Record<VaultOpaqueProfileFormat, true>
> = {
  codex_auth_json_v1: true,
  codex_device_authorization_v1: true,
  chatgpt_agent_profile_v1: true,
  chatgpt_agent_sign_in_v1: true,
  underclerk_square_connection_v1: true,
};

export function isVaultOpaqueProfileFormat(
  raw: unknown,
): raw is VaultOpaqueProfileFormat {
  return (
    typeof raw === "string" && Object.hasOwn(VAULT_OPAQUE_PROFILE_FORMATS, raw)
  );
}

export type VaultSecret =
  | { readonly kind: "bearer"; readonly value: string }
  | {
      readonly kind: "expiring_bearer";
      readonly value: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "header"; readonly header: string; readonly value: string }
  | {
      readonly kind: "opaque_profile";
      readonly format: VaultOpaqueProfileFormat;
      readonly value: string;
    }
  | {
      readonly kind: "oauth_tokens";
      readonly accessToken: string;
      readonly refreshToken: string;
      readonly expiry:
        | { readonly kind: "expires"; readonly expiresAt: number }
        | { readonly kind: "provider_managed" };
    }
  | {
      readonly kind: "oauth_client_credentials";
      readonly clientId: string;
      readonly clientSecret: string;
    }
  /** A saved website sign-in of a Vault item (Plan 79). */
  | {
      readonly kind: "website_login";
      readonly username: string;
      readonly password: string;
    };

export type VaultOAuthTokens = Variant<VaultSecret, "oauth_tokens">;
export type VaultWebsiteLogin = Variant<VaultSecret, "website_login">;

export type VaultResolveError =
  | { readonly code: "vault_handle_unknown"; readonly handle: string }
  | {
      readonly code: "credential_rule_inactive";
      readonly handle: string;
      readonly ruleId: string;
    }
  | { readonly code: "vault_secret_revoked"; readonly handle: string }
  | { readonly code: "vault_root_unavailable" }
  | { readonly code: "vault_root_invalid" }
  | { readonly code: "vault_ciphertext_invalid"; readonly handle: string }
  | { readonly code: "vault_plaintext_invalid"; readonly handle: string };

export type VaultStoreError =
  | { readonly code: "vault_root_unavailable" }
  | { readonly code: "vault_root_invalid" }
  | { readonly code: "vault_secret_invalid" }
  | { readonly code: "vault_candidate_unverifiable" }
  | { readonly code: "vault_secret_revoked" };

export type VaultStoredSecret = {
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
  readonly keyVersion: VaultKeyVersion;
  readonly createdAt: number;
};

export function parseVaultHandle(
  raw: string,
): Result<VaultHandle, { readonly code: "invalid_vault_handle" }> {
  const value = raw.trim();

  if (!VAULT_HANDLE_PATTERN.test(value)) {
    return { ok: false, error: { code: "invalid_vault_handle" } };
  }

  return { ok: true, value: value as VaultHandle };
}
