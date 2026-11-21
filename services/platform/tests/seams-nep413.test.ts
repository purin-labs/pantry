import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildNep413Digest,
  parseNep413Proof,
  verifyNep413Proof,
  type Nep413Challenge,
} from "../src/seams/nep413";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

describe("Seams NEP-413 identity proof", function seamsNep413Suite() {
  it("verifies a proof over the exact invitation challenge", async function verifiesProof() {
    const challenge = identityChallenge();
    const signed = await signChallenge(challenge);
    const parsed = parseNep413Proof(signed.rawProof);

    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      throw new Error("proof fixture did not parse");
    }

    const verified = await verifyNep413Proof(challenge, parsed.value);

    expect(verified).toEqual({
      ok: true,
      value: {
        id: `seams:near:alice.near:${signed.publicKeyBase58}`,
        accountId: "alice.near",
        publicKey: `ed25519:${signed.publicKeyBase58}`,
      },
    });
  });

  it("rejects a proof replayed against another invitation state", async function rejectsStateReplay() {
    const challenge = identityChallenge();
    const signed = await signChallenge(challenge);
    const parsed = parseNep413Proof(signed.rawProof);

    if (!parsed.ok) {
      throw new Error("proof fixture did not parse");
    }

    const verified = await verifyNep413Proof(
      { ...challenge, state: "link_another" },
      parsed.value,
    );

    expect(verified).toEqual({ ok: false, error: { code: "invalid_state" } });
  });

  it("rejects a malformed public key at the request boundary", function rejectsMalformedKey() {
    const parsed = parseNep413Proof({
      accountId: "alice.near",
      publicKey: "ed25519:not-base58-0",
      signature: Buffer.alloc(64).toString("base64"),
      nonce: Buffer.alloc(32).toString("base64"),
      state: "link_fixture",
    });

    expect(parsed).toEqual({
      ok: false,
      error: { code: "invalid_public_key" },
    });
  });
});

function identityChallenge(): Nep413Challenge {
  return {
    message:
      "Link Slack user U0BFUGSC6BY to Pantry organisation organisation_T0BGQSSG45N.",
    recipient: "pantry.identity",
    state: "link_fixture",
  };
}

async function signChallenge(challenge: Nep413Challenge) {
  const keyPair = generateKeyPairSync("ed25519");
  const nonce = new Uint8Array(32).fill(7);
  const digest = await buildNep413Digest(challenge, nonce);
  const signature = sign(null, digest, keyPair.privateKey);
  const spki = keyPair.publicKey.export({ format: "der", type: "spki" });
  const publicKey = new Uint8Array(spki.subarray(spki.byteLength - 32));
  const publicKeyBase58 = encodeBase58(publicKey);

  return {
    publicKeyBase58,
    rawProof: {
      accountId: "alice.near",
      publicKey: `ed25519:${publicKeyBase58}`,
      signature: signature.toString("base64"),
      nonce: Buffer.from(nonce).toString("base64"),
      state: challenge.state,
    },
  };
}

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;

  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let encoded = "";

  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = `${BASE58_ALPHABET[remainder]}${encoded}`;
    value /= 58n;
  }

  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }

    encoded = `1${encoded}`;
  }

  return encoded;
}
