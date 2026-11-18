import type { VoiceGrantClaims } from "@seams/control-api";
import { encodeBase64Url } from "@seams/std";

const textEncoder = new TextEncoder();

/**
 * The key of one Mac's grants. The Platform derives it from the root, and the
 * Mac receives it once at enrollment. A Mac can then sign grants only for
 * itself, and a grant has no authority at the Platform.
 */
async function voiceMacGrantKeyBytes(
  root: SecretsStoreSecret,
  macId: string,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode((await root.get()).trim()),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: textEncoder.encode(`satyr.voice-grant.v1:${macId}`),
    },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export async function voiceMacGrantKey(
  root: SecretsStoreSecret,
  macId: string,
): Promise<string> {
  return encodeBase64Url(await voiceMacGrantKeyBytes(root, macId));
}

export async function signVoiceGrant(
  root: SecretsStoreSecret,
  claims: VoiceGrantClaims,
): Promise<string> {
  const payload = encodeBase64Url(textEncoder.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    "raw",
    await voiceMacGrantKeyBytes(root, claims.macId),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`vg1.${payload}`),
  );
  return `vg1.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}
