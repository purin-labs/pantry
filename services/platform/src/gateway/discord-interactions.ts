import type {
  DiscordApplicationId,
  DiscordGuildId,
} from "../data/discord-install";
import type { Result } from "../result";
import { isRecord } from "@seams/std";

export type DiscordPublicKey = Uint8Array & { readonly length: 32 };

export type DiscordLinkCommand = {
  applicationId: DiscordApplicationId;
  guildId: DiscordGuildId;
  userId: string;
  displayName: string;
};

export type DiscordInteraction =
  { kind: "ping" } | { kind: "link"; command: DiscordLinkCommand };

export type DiscordInteractionError =
  | { code: "discord_signature_missing" }
  | { code: "discord_signature_invalid" }
  | { code: "discord_payload_invalid"; field: string }
  | { code: "discord_command_unsupported" };

type JsonObject = Record<string, unknown>;

const PUBLIC_KEY_HEX_LENGTH = 64;
const SIGNATURE_HEX_LENGTH = 128;
const DISCORD_USER_ID_PATTERN = /^[1-9][0-9]{5,24}$/u;

export function parseDiscordPublicKey(
  raw: string,
): Result<DiscordPublicKey, DiscordInteractionError> {
  const bytes = decodeHex(raw, PUBLIC_KEY_HEX_LENGTH);
  return bytes === null
    ? invalidPayload("publicKey")
    : { ok: true, value: bytes as DiscordPublicKey };
}

export async function verifyDiscordInteractionSignature(input: {
  publicKey: DiscordPublicKey;
  signature: string | null;
  timestamp: string | null;
  body: string;
}): Promise<Result<true, DiscordInteractionError>> {
  if (input.signature === null || input.timestamp === null) {
    return { ok: false, error: { code: "discord_signature_missing" } };
  }

  const signature = decodeHex(input.signature, SIGNATURE_HEX_LENGTH);

  if (
    signature === null ||
    input.timestamp.length < 1 ||
    input.timestamp.length > 32
  ) {
    return { ok: false, error: { code: "discord_signature_invalid" } };
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      input.publicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const payload = new TextEncoder().encode(`${input.timestamp}${input.body}`);
    const valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      signature,
      payload,
    );
    return valid
      ? { ok: true, value: true }
      : { ok: false, error: { code: "discord_signature_invalid" } };
  } catch {
    return { ok: false, error: { code: "discord_signature_invalid" } };
  }
}

export function parseDiscordInteraction(
  raw: unknown,
  expectedApplicationId: DiscordApplicationId,
  expectedGuildId: DiscordGuildId,
): Result<DiscordInteraction, DiscordInteractionError> {
  if (!isRecord(raw) || typeof raw.type !== "number") {
    return invalidPayload("type");
  }

  if (raw.type === 1) {
    return { ok: true, value: { kind: "ping" } };
  }

  if (raw.type !== 2) {
    return { ok: false, error: { code: "discord_command_unsupported" } };
  }

  if (raw.application_id !== expectedApplicationId) {
    return invalidPayload("application_id");
  }

  if (raw.guild_id !== expectedGuildId) {
    return invalidPayload("guild_id");
  }

  if (!isRecord(raw.data) || raw.data.name !== "satyr") {
    return { ok: false, error: { code: "discord_command_unsupported" } };
  }

  if (!isLinkSubcommand(raw.data.options)) {
    return { ok: false, error: { code: "discord_command_unsupported" } };
  }

  const user = interactionUser(raw);

  if (user === null || !DISCORD_USER_ID_PATTERN.test(user.id)) {
    return invalidPayload("user.id");
  }

  return {
    ok: true,
    value: {
      kind: "link",
      command: {
        applicationId: expectedApplicationId,
        guildId: expectedGuildId,
        userId: user.id,
        displayName: user.displayName,
      },
    },
  };
}

export function discordPongResponse(): Response {
  return discordInteractionResponse({ type: 1 });
}

export function discordEphemeralResponse(content: string): Response {
  return discordInteractionResponse({
    type: 4,
    data: { content, flags: 64, allowed_mentions: { parse: [] } },
  });
}

function interactionUser(
  raw: JsonObject,
): { id: string; displayName: string } | null {
  const memberUser =
    isRecord(raw.member) && isRecord(raw.member.user) ? raw.member.user : null;
  const directUser = isRecord(raw.user) ? raw.user : null;
  const user = memberUser ?? directUser;

  if (
    user === null ||
    typeof user.id !== "string" ||
    typeof user.username !== "string"
  ) {
    return null;
  }

  const displayName =
    typeof user.global_name === "string" && user.global_name.trim().length > 0
      ? user.global_name.trim()
      : user.username.trim();
  return displayName.length > 0 ? { id: user.id, displayName } : null;
}

function isLinkSubcommand(raw: unknown): boolean {
  return (
    Array.isArray(raw) &&
    raw.length === 1 &&
    isRecord(raw[0]) &&
    raw[0].type === 1 &&
    raw[0].name === "link"
  );
}

function discordInteractionResponse(body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function decodeHex(raw: string, expectedLength: number): Uint8Array | null {
  if (raw.length !== expectedLength || !/^[0-9a-f]+$/iu.test(raw)) {
    return null;
  }

  const bytes = new Uint8Array(raw.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    const value = Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16);

    if (!Number.isSafeInteger(value)) {
      return null;
    }

    bytes[index] = value;
  }

  return bytes;
}

function invalidPayload(field: string): Result<never, DiscordInteractionError> {
  return { ok: false, error: { code: "discord_payload_invalid", field } };
}
