import { encodeBase64 } from "@seams/std";

/** A Secrets Store binding that returns a fixed value. */
export class TestSecretsStoreSecret {
  constructor(private readonly value: string) {}

  async get(): Promise<string> {
    return this.value;
  }
}

/** A 32-byte vault root of one repeated byte, as the vault reads it. */
export function testRoot(fill: number): TestSecretsStoreSecret {
  return new TestSecretsStoreSecret(
    encodeBase64(new Uint8Array(32).fill(fill)),
  );
}
