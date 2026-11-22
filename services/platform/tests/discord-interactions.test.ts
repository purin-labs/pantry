/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  parseDiscordApplicationId,
  parseDiscordGuildId,
} from "@purin-labs/area-integrations/server/data/discord-install";
import {
  parseDiscordInteraction,
  parseDiscordPublicKey,
  verifyDiscordInteractionSignature,
} from "@purin-labs/area-integrations/server/gateway/discord-interactions";
import { bytesToHex } from "@purin-labs/std";

describe("Discord interactions boundary", function discordInteractionSuite() {
  it("parses the explicit /pantry link command", function parsesLinkCommand() {
    const interaction = parseDiscordInteraction(
      {
        type: 2,
        application_id: "11568910548192",
        guild_id: "11539475695701",
        data: {
          name: "pantry",
          options: [{ type: 1, name: "link" }],
        },
        member: {
          user: {
            id: "11540859491174",
            username: "peita",
            global_name: "Peita",
          },
        },
      },
      requireApplicationId(),
      requireGuildId(),
    );

    expect(interaction).toEqual({
      ok: true,
      value: {
        kind: "link",
        command: {
          applicationId: "11568910548192",
          guildId: "11539475695701",
          userId: "11540859491174",
          displayName: "Peita",
        },
      },
    });
  });

  it("rejects a command from another application", function rejectsOtherApplication() {
    expect(
      parseDiscordInteraction(
        {
          type: 2,
          application_id: "99999999999999",
          guild_id: "11539475695701",
          data: { name: "pantry", options: [{ type: 1, name: "link" }] },
          member: { user: { id: "11540859491174", username: "peita" } },
        },
        requireApplicationId(),
        requireGuildId(),
      ),
    ).toEqual({
      ok: false,
      error: { code: "discord_payload_invalid", field: "application_id" },
    });
  });

  it("verifies the exact timestamp plus body signature", async function verifiesSignature() {
    const generated = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);

    if (!("publicKey" in generated)) {
      throw new Error("generated Ed25519 key is not a key pair");
    }

    const exportedPublicKey = await crypto.subtle.exportKey(
      "raw",
      generated.publicKey,
    );

    if (!(exportedPublicKey instanceof ArrayBuffer)) {
      throw new Error("generated Ed25519 public key is not raw bytes");
    }

    const publicKeyBytes = new Uint8Array(exportedPublicKey);
    const publicKey = parseDiscordPublicKey(bytesToHex(publicKeyBytes));
    const timestamp = "1783900000";
    const body = JSON.stringify({ type: 1 });
    const payload = new TextEncoder().encode(`${timestamp}${body}`);
    const signature = new Uint8Array(
      await crypto.subtle.sign("Ed25519", generated.privateKey, payload),
    );

    if (!publicKey.ok) {
      throw new Error("generated public key is invalid");
    }

    expect(
      await verifyDiscordInteractionSignature({
        publicKey: publicKey.value,
        signature: bytesToHex(signature),
        timestamp,
        body,
      }),
    ).toEqual({ ok: true, value: true });
    expect(
      await verifyDiscordInteractionSignature({
        publicKey: publicKey.value,
        signature: bytesToHex(signature),
        timestamp,
        body: `${body} `,
      }),
    ).toEqual({ ok: false, error: { code: "discord_signature_invalid" } });
  });
});

function requireApplicationId() {
  const parsed = parseDiscordApplicationId("11568910548192");

  if (!parsed.ok) {
    throw new Error("application id fixture is invalid");
  }

  return parsed.value;
}

function requireGuildId() {
  const parsed = parseDiscordGuildId("11539475695701");

  if (!parsed.ok) {
    throw new Error("guild id fixture is invalid");
  }

  return parsed.value;
}
