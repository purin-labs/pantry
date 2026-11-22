import type {
  VaultHandle,
  VaultRootRotationId,
  VaultRotationBatchLimit,
  VaultSecret,
} from "@purin-labs/authority/credential-vault/index";
import type { VaultKeyRing } from "@purin-labs/authority/credential-vault/keyring";

// @ts-expect-error VaultHandle must cross the parser boundary.
const handle: VaultHandle = "vault:stripe:acct_1";
// @ts-expect-error A header secret requires its header identity.
const headerSecret: VaultSecret = { kind: "header", value: "secret" };
const opaqueSecret: VaultSecret = {
  kind: "opaque_profile",
  // @ts-expect-error Opaque profiles accept only named, versioned formats.
  format: "arbitrary",
  value: "secret",
};

const keyRingShape = {
  active: { version: "v1" as const, key: null as unknown as CryptoKey },
  readable: [] as unknown as readonly [
    {
      readonly version: "v1";
      readonly key: CryptoKey;
    },
  ],
};

// @ts-expect-error VaultKeyRing is opaque and must come from the async boundary loader.
const directKeyRing: VaultKeyRing = keyRingShape;
// @ts-expect-error A broad spread cannot bypass the opaque keyring brand.
const spreadKeyRing: VaultKeyRing = { ...keyRingShape };

// @ts-expect-error Rotation IDs must cross the parser boundary.
const rotationId: VaultRootRotationId = "vrot_direct_0001";
// @ts-expect-error Batch limits must cross the bounded parser.
const batchLimit: VaultRotationBatchLimit = 1;

void handle;
void headerSecret;
void opaqueSecret;
void directKeyRing;
void spreadKeyRing;
void rotationId;
void batchLimit;
