// Keys for customer data (Plan 76A step 3). Each customer's fields are sealed
// with AES-GCM under a key that belongs to that customer alone. That key is
// stored wrapped by a merchant key, and the merchant key comes from the
// Worker's root secret through HKDF. Erasure deletes the wrapped customer key,
// so every sealed copy, in SQLite or an archive, can no longer be opened.
// Lookups use HMAC with a merchant lookup key: one email gives one value for
// the merchant, and the value does not reveal the email.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const KEY_VERSION = 1;
const SALT = "commerce.customer-data";

export type SealedCustomerKey = Readonly<{ version: number; wrapped: string }>;

export class CustomerVault {
  readonly #root: Buffer;

  constructor(rootSecret: string) {
    if (rootSecret.length < 32)
      throw new Error("Customer data root secret must have 32 or more characters");
    this.#root = Buffer.from(rootSecret, "utf8");
  }

  /** The merchant's value for an email or phone, for lookup only. */
  lookup(merchantId: string, field: "email", value: string): string {
    return createHmac("sha256", this.#derive(`lookup-key.v1:${merchantId}`))
      .update(`${field}:${value}`)
      .digest("hex");
  }

  /** A keyed digest of a one-time code; codes are never stored. */
  codeDigest(merchantId: string, challengeId: string, code: string): string {
    return createHmac("sha256", this.#derive(`sign-in-code.v1:${merchantId}`))
      .update(`${challengeId}:${code}`)
      .digest("hex");
  }

  newCustomerKey(merchantId: string, customerId: string): SealedCustomerKey {
    const key = randomBytes(32);
    return {
      version: KEY_VERSION,
      wrapped: seal(
        this.#merchantKey(merchantId),
        aad([merchantId, customerId, "customer_key", String(KEY_VERSION)]),
        key,
      ),
    };
  }

  sealForCustomer(
    merchantId: string,
    customerId: string,
    customerKey: SealedCustomerKey,
    field: string,
    value: unknown,
  ): string {
    return seal(
      this.#unwrap(merchantId, customerId, customerKey),
      aad([merchantId, customerId, field, String(customerKey.version)]),
      Buffer.from(JSON.stringify(value), "utf8"),
    );
  }

  openForCustomer(
    merchantId: string,
    customerId: string,
    customerKey: SealedCustomerKey,
    field: string,
    sealed: string,
  ): unknown {
    return JSON.parse(
      open(
        this.#unwrap(merchantId, customerId, customerKey),
        aad([merchantId, customerId, field, String(customerKey.version)]),
        sealed,
      ).toString("utf8"),
    );
  }

  /** Seals short-lived merchant data, such as a sign-in code in flight. */
  sealForMerchant(merchantId: string, field: string, value: unknown): string {
    return seal(
      this.#merchantKey(merchantId),
      aad([merchantId, field, String(KEY_VERSION)]),
      Buffer.from(JSON.stringify(value), "utf8"),
    );
  }

  openForMerchant(merchantId: string, field: string, sealed: string): unknown {
    return JSON.parse(
      open(
        this.#merchantKey(merchantId),
        aad([merchantId, field, String(KEY_VERSION)]),
        sealed,
      ).toString("utf8"),
    );
  }

  #unwrap(
    merchantId: string,
    customerId: string,
    customerKey: SealedCustomerKey,
  ): Buffer {
    return open(
      this.#merchantKey(merchantId),
      aad([merchantId, customerId, "customer_key", String(customerKey.version)]),
      customerKey.wrapped,
    );
  }

  #merchantKey(merchantId: string): Buffer {
    return this.#derive(`merchant-key.v${KEY_VERSION}:${merchantId}`);
  }

  #derive(info: string): Buffer {
    return Buffer.from(hkdfSync("sha256", this.#root, SALT, info, 32));
  }
}

function aad(parts: readonly string[]): Buffer {
  return Buffer.from(parts.join("\u0000"), "utf8");
}

function seal(key: Buffer, additionalData: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64url",
  );
}

function open(key: Buffer, additionalData: Buffer, sealed: string): Buffer {
  const bytes = Buffer.from(sealed, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(additionalData);
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}
