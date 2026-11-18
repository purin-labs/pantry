import type { Result } from "../result";
import { parseBase64 } from "./crypto";

const vaultKeyRingBrand: unique symbol = Symbol("VaultKeyRing");

export type VaultKeyVersion = "v1" | "v2";

export type CredentialVaultBindings = {
  readonly VAULT_ROOT_V1?: SecretsStoreSecret;
  readonly VAULT_ROOT_V2?: SecretsStoreSecret;
  readonly SATYR_VAULT_ACTIVE_KEY_VERSION: string;
};

export type VaultRootBinding = {
  readonly version: VaultKeyVersion;
  readonly key: CryptoKey;
};

export type VaultKeyRing = {
  readonly [vaultKeyRingBrand]: "VaultKeyRing";
  readonly active: VaultRootBinding;
  readonly readable: readonly [VaultRootBinding, ...VaultRootBinding[]];
};

type VaultKeyRingCandidate = {
  readonly activeVersion: unknown;
  readonly bindings: readonly VaultRootBindingCandidate[];
};

type VaultRootBindingCandidate = {
  readonly version: unknown;
  readonly root: unknown;
};

export type VaultKeyRingError =
  | { readonly code: "vault_active_key_version_invalid" }
  | { readonly code: "vault_root_key_version_invalid"; readonly index: number }
  | {
      readonly code: "vault_root_binding_invalid";
      readonly version: VaultKeyVersion;
    }
  | {
      readonly code: "vault_root_version_duplicate";
      readonly version: VaultKeyVersion;
    }
  | {
      readonly code: "vault_active_root_unavailable";
      readonly version: VaultKeyVersion;
    }
  | {
      readonly code: "vault_root_unavailable";
      readonly version: VaultKeyVersion;
    }
  | { readonly code: "vault_root_invalid"; readonly version: VaultKeyVersion };

type VaultRootSelectionError =
  | { readonly code: "vault_key_version_invalid" }
  | {
      readonly code: "vault_root_version_unavailable";
      readonly version: VaultKeyVersion;
    };

type ValidatedRootBinding = {
  readonly version: VaultKeyVersion;
  readonly root: SecretsStoreSecret;
};

const AES_256_KEY_BYTES = 32;

export async function loadCredentialVaultKeyRing(
  bindings: CredentialVaultBindings,
): Promise<Result<VaultKeyRing, VaultKeyRingError>> {
  const candidates: VaultRootBindingCandidate[] = [];

  appendConfiguredRoot(candidates, "v1", bindings.VAULT_ROOT_V1);
  appendConfiguredRoot(candidates, "v2", bindings.VAULT_ROOT_V2);

  return loadVaultKeyRing({
    activeVersion: bindings.SATYR_VAULT_ACTIVE_KEY_VERSION,
    bindings: candidates,
  });
}

export async function loadVaultKeyRing(
  candidate: VaultKeyRingCandidate,
): Promise<Result<VaultKeyRing, VaultKeyRingError>> {
  const activeVersion = parseVaultKeyVersion(candidate.activeVersion);

  if (!activeVersion.ok) {
    return { ok: false, error: { code: "vault_active_key_version_invalid" } };
  }

  const validated: ValidatedRootBinding[] = [];

  for (let index = 0; index < candidate.bindings.length; index += 1) {
    const candidateBinding = candidate.bindings[index];

    if (candidateBinding === undefined) {
      return {
        ok: false,
        error: { code: "vault_root_key_version_invalid", index },
      };
    }

    const version = parseVaultKeyVersion(candidateBinding.version);

    if (!version.ok) {
      return {
        ok: false,
        error: { code: "vault_root_key_version_invalid", index },
      };
    }

    if (!isSecretsStoreSecret(candidateBinding.root)) {
      return {
        ok: false,
        error: { code: "vault_root_binding_invalid", version: version.value },
      };
    }

    if (hasValidatedRootVersion(validated, version.value)) {
      return {
        ok: false,
        error: { code: "vault_root_version_duplicate", version: version.value },
      };
    }

    validated.push({ version: version.value, root: candidateBinding.root });
  }

  if (findValidatedRoot(validated, activeVersion.value) === null) {
    return {
      ok: false,
      error: {
        code: "vault_active_root_unavailable",
        version: activeVersion.value,
      },
    };
  }

  const readable: VaultRootBinding[] = [];

  for (const binding of validated) {
    const loaded = await loadVaultRoot(binding);

    if (!loaded.ok) {
      return loaded;
    }

    readable.push(loaded.value);
  }

  const active = findVaultRoot(readable, activeVersion.value);
  const readableRoots = nonEmptyVaultRoots(readable);

  if (active === null || readableRoots === null) {
    return {
      ok: false,
      error: {
        code: "vault_active_root_unavailable",
        version: activeVersion.value,
      },
    };
  }

  return {
    ok: true,
    value: {
      [vaultKeyRingBrand]: "VaultKeyRing",
      active,
      readable: readableRoots,
    },
  };
}

export function activeVaultRoot(keyRing: VaultKeyRing): VaultRootBinding {
  return keyRing.active;
}

export function vaultRootForVersion(
  keyRing: VaultKeyRing,
  rawVersion: unknown,
): Result<VaultRootBinding, VaultRootSelectionError> {
  const version = parseVaultKeyVersion(rawVersion);

  if (!version.ok) {
    return version;
  }

  const binding = findVaultRoot(keyRing.readable, version.value);

  if (binding === null) {
    return {
      ok: false,
      error: { code: "vault_root_version_unavailable", version: version.value },
    };
  }

  return { ok: true, value: binding };
}

async function loadVaultRoot(
  binding: ValidatedRootBinding,
): Promise<Result<VaultRootBinding, VaultKeyRingError>> {
  let value: string;

  try {
    value = await binding.root.get();
  } catch {
    return {
      ok: false,
      error: { code: "vault_root_unavailable", version: binding.version },
    };
  }

  const decoded = parseBase64(value.trim());

  if (!decoded.ok || decoded.value.byteLength !== AES_256_KEY_BYTES) {
    return {
      ok: false,
      error: { code: "vault_root_invalid", version: binding.version },
    };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    decoded.value,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

  return { ok: true, value: { version: binding.version, key } };
}

function parseVaultKeyVersion(
  raw: unknown,
): Result<VaultKeyVersion, { readonly code: "vault_key_version_invalid" }> {
  if (raw === "v1" || raw === "v2") {
    return { ok: true, value: raw };
  }

  return { ok: false, error: { code: "vault_key_version_invalid" } };
}

function isSecretsStoreSecret(raw: unknown): raw is SecretsStoreSecret {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "get" in raw &&
    typeof raw.get === "function"
  );
}

function appendConfiguredRoot(
  candidates: VaultRootBindingCandidate[],
  version: VaultKeyVersion,
  root: SecretsStoreSecret | undefined,
): void {
  if (root !== undefined) {
    candidates.push({ version, root });
  }
}

function hasValidatedRootVersion(
  bindings: readonly ValidatedRootBinding[],
  version: VaultKeyVersion,
): boolean {
  return findValidatedRoot(bindings, version) !== null;
}

function findValidatedRoot(
  bindings: readonly ValidatedRootBinding[],
  version: VaultKeyVersion,
): ValidatedRootBinding | null {
  for (const binding of bindings) {
    if (binding.version === version) {
      return binding;
    }
  }

  return null;
}

function findVaultRoot(
  bindings: readonly VaultRootBinding[],
  version: VaultKeyVersion,
): VaultRootBinding | null {
  for (const binding of bindings) {
    if (binding.version === version) {
      return binding;
    }
  }

  return null;
}

function nonEmptyVaultRoots(
  bindings: readonly VaultRootBinding[],
): readonly [VaultRootBinding, ...VaultRootBinding[]] | null {
  const first = bindings[0];

  if (first === undefined) {
    return null;
  }

  return Object.freeze([first, ...bindings.slice(1)]);
}
