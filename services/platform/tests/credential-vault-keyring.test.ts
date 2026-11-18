/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  activeVaultRoot,
  loadCredentialVaultKeyRing,
  loadVaultKeyRing,
  vaultRootForVersion,
} from "../src/credential-vault/keyring";
import { TestSecretsStoreSecret } from "./secrets-store";

describe("Credential Vault root keyring", vaultRootKeyRingSuite);

function vaultRootKeyRingSuite(): void {
  it(
    "loads the configured active write root and both readable roots",
    loadsConfiguredRoots,
  );
  it(
    "rejects invalid and missing active versions",
    rejectsInvalidActiveVersions,
  );
  it("rejects invalid and duplicate root bindings", rejectsInvalidRootBindings);
  it(
    "rejects unavailable, empty, and incorrectly sized root material",
    rejectsInvalidMaterial,
  );
  it(
    "fails closed for invalid and unavailable read versions",
    rejectsUnreadableVersions,
  );
}

async function loadsConfiguredRoots(): Promise<void> {
  const v1 = testRoot(1);
  const v2 = testRoot(2);
  const loaded = await loadCredentialVaultKeyRing({
    SATYR_VAULT_ACTIVE_KEY_VERSION: "v2",
    VAULT_ROOT_V1: v1,
    VAULT_ROOT_V2: v2,
  });

  expect(loaded.ok).toBe(true);

  if (!loaded.ok) {
    return;
  }

  expect(activeVaultRoot(loaded.value).version).toBe("v2");
  expect(vaultRootForVersion(loaded.value, "v1").ok).toBe(true);
  expect(vaultRootForVersion(loaded.value, "v2").ok).toBe(true);
  expect(Object.isFrozen(loaded.value.readable)).toBe(true);
  expect(loaded.value.active.key.algorithm).toEqual({
    name: "AES-GCM",
    length: 256,
  });
}

async function rejectsInvalidActiveVersions(): Promise<void> {
  await expect(
    loadVaultKeyRing({ activeVersion: "v1", bindings: [] }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "vault_active_root_unavailable", version: "v1" },
  });
  await expect(
    loadVaultKeyRing({
      activeVersion: "v3",
      bindings: [{ version: "v1", root: testRoot(1) }],
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "vault_active_key_version_invalid" },
  });
  await expect(
    loadVaultKeyRing({
      activeVersion: "v2",
      bindings: [{ version: "v1", root: testRoot(1) }],
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "vault_active_root_unavailable", version: "v2" },
  });
}

async function rejectsInvalidRootBindings(): Promise<void> {
  const v1 = testRoot(1);

  await expect(
    loadVaultKeyRing({
      activeVersion: "v1",
      bindings: [{ version: "unknown", root: v1 }],
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "vault_root_key_version_invalid", index: 0 },
  });
  await expect(
    loadVaultKeyRing({
      activeVersion: "v1",
      bindings: [{ version: "v1", root: { get: "not-a-function" } }],
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "vault_root_binding_invalid", version: "v1" },
  });
  await expect(
    loadVaultKeyRing({
      activeVersion: "v1",
      bindings: [
        { version: "v1", root: v1 },
        { version: "v1", root: v1 },
      ],
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "vault_root_version_duplicate", version: "v1" },
  });
}

async function rejectsInvalidMaterial(): Promise<void> {
  await expect(
    loadVaultKeyRing({
      activeVersion: "v1",
      bindings: [{ version: "v1", root: new TestSecretsStoreSecret("") }],
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "vault_root_invalid", version: "v1" },
  });
  await expect(
    loadVaultKeyRing({
      activeVersion: "v1",
      bindings: [
        { version: "v1", root: new TestSecretsStoreSecret(encodeKey(31, 1)) },
      ],
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "vault_root_invalid", version: "v1" },
  });
  await expect(
    loadVaultKeyRing({
      activeVersion: "v1",
      bindings: [{ version: "v1", root: new UnavailableSecretsStoreSecret() }],
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "vault_root_unavailable", version: "v1" },
  });
}

async function rejectsUnreadableVersions(): Promise<void> {
  const loaded = await loadVaultKeyRing({
    activeVersion: "v1",
    bindings: [{ version: "v1", root: testRoot(1) }],
  });

  expect(loaded.ok).toBe(true);

  if (!loaded.ok) {
    return;
  }

  expect(vaultRootForVersion(loaded.value, "v3")).toEqual({
    ok: false,
    error: { code: "vault_key_version_invalid" },
  });
  expect(vaultRootForVersion(loaded.value, "v2")).toEqual({
    ok: false,
    error: { code: "vault_root_version_unavailable", version: "v2" },
  });
}

class UnavailableSecretsStoreSecret {
  async get(): Promise<string> {
    throw new Error("unavailable");
  }
}

function testRoot(fill: number): SecretsStoreSecret {
  return new TestSecretsStoreSecret(encodeKey(32, fill));
}

function encodeKey(length: number, fill: number): string {
  const bytes = new Uint8Array(length);
  bytes.fill(fill);

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
