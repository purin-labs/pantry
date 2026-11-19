import { ServiceProvisionOwnerAssertionV1 } from "@seams-internal/console-shared/accountPlatform";
import type { SatyrProvisionEnvelopeV1 as PantryProvisionEnvelope } from "@seams-internal/console-shared/accountPlatform";
export {
  readSatyrNativeScopeV1 as readPantryNativeScope,
  readSatyrServiceTenantBindingV1 as readPantryServiceTenantBinding,
  readSatyrProvisionDeliveryV1 as readPantryProvisionDelivery,
  readSatyrProvisionOwnerV1 as readPantryProvisionOwner,
  readSatyrProvisionEnvelopeV1 as readPantryProvisionEnvelope,
  readSatyrProvisionAppliedV1 as readPantryProvisionApplied,
} from "@seams-internal/console-shared/accountPlatform";
export type {
  SatyrTenantScopeV1 as PantryNativeScope,
  SatyrServiceTenantBindingV1 as PantryServiceTenantBinding,
  SatyrProvisionBindingV1 as PantryProvisionBinding,
  SatyrProvisionCommandV1 as PantryProvisionCommand,
  SatyrProvisionDeliveryV1 as PantryProvisionDelivery,
  SatyrProvisionOwnerV1 as PantryProvisionOwner,
  SatyrProvisionEnvelopeV1 as PantryProvisionEnvelope,
  SatyrProvisionReceiptV1 as PantryProvisionReceipt,
  AccountProvisionedServiceOwnerV1 as PantryProvisionOwnerMapping,
  SatyrProvisionAppliedV1 as PantryProvisionApplied,
} from "@seams-internal/console-shared/accountPlatform";
import {
  canonicalJson,
  decodeBase64Url,
  encodeBase64Url,
  isRecord,
  sha256Hex,
} from "@purin-labs/std";
import type { Env } from "../env";
import { accountObject, accountText } from "./types";

/** This signature has a separate purpose, issuer, audience and key from user admission. */
export async function verifyPantryProvisionOwner(
  env: Env,
  envelope: PantryProvisionEnvelope,
): Promise<boolean> {
  try {
    const [headerText, payloadText, signatureText, extra] =
      envelope.ownerAssertion.split(".");
    if (!headerText || !payloadText || !signatureText || extra !== undefined)
      return false;
    const h = accountObject(
      JSON.parse(new TextDecoder().decode(decodeSegment(headerText))),
      ["alg", "typ", "kid"],
    );
    if (
      h.alg !== "EdDSA" ||
      h.typ !== "JWT" ||
      h.kid !== accountText(env.ACCOUNT_PLATFORM_PROVISION_ASSERTION_KEY_ID)
    )
      return false;
    const parsed = ServiceProvisionOwnerAssertionV1.parse(
      JSON.parse(new TextDecoder().decode(decodeSegment(payloadText))),
    );
    if (parsed.kind === "rejected") return false;
    const c = parsed.value;
    if (
      c.issuer !==
        accountText(env.ACCOUNT_PLATFORM_PROVISION_ASSERTION_ISSUER) ||
      c.audience !==
        accountText(env.ACCOUNT_PLATFORM_PROVISION_ASSERTION_AUDIENCE)
    )
      return false;
    const delivery = envelope.delivery;
    if (
      c.operationId !== delivery.command.operationId ||
      c.instanceId !== delivery.command.instanceId ||
      c.requestedByUserId !== delivery.requestedByUserId ||
      c.requestedByUserId !== envelope.owner.platformUserId ||
      c.providerIssuer !== envelope.owner.issuer ||
      c.providerSubject !== envelope.owner.subject
    )
      return false;
    const expiresAt = Date.parse(c.expiresAt);
    if (expiresAt <= Date.now() || expiresAt > Date.now() + 60_000)
      return false;
    if (
      c.bodyDigest !==
      (await sha256Hex(
        canonicalJson({ version: 1, delivery, owner: envelope.owner }),
      ))
    )
      return false;
    const raw: unknown = JSON.parse(
      accountText(env.ACCOUNT_PLATFORM_PROVISION_ASSERTION_JWK),
    );
    if (
      !isRecord(raw) ||
      raw.kty !== "OKP" ||
      raw.crv !== "Ed25519" ||
      typeof raw.x !== "string" ||
      raw.d !== undefined
    )
      return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: raw.x },
      "Ed25519",
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "Ed25519",
      key,
      copyBuffer(decodeSegment(signatureText)),
      new TextEncoder().encode(`${headerText}.${payloadText}`),
    );
  } catch {
    return false;
  }
}
function decodeSegment(value: string): Uint8Array {
  const bytes = decodeBase64Url(value);
  if (bytes === null) throw new Error("Invalid signed segment");
  if (encodeBase64Url(bytes) !== value)
    throw new Error("Noncanonical signed segment");
  return bytes;
}
function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
