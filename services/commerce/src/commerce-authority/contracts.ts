export interface CommerceSigner {
  readonly keyId: string;
  readonly publicKeyB64: string;
  sign(payload: Uint8Array): string;
}
