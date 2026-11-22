import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  readStringField,
  readOrganisationIdField,
} from "@purin-labs/contracts/boundary";
import {
  parseDiscordApplicationId,
  parseDiscordGuildId,
  readActiveDiscordInteractionInstall,
  writeDiscordInteractionInstall,
} from "../data/discord-install";
import {
  discordEphemeralResponse,
  discordPongResponse,
  parseDiscordInteraction,
  parseDiscordPublicKey,
  verifyDiscordInteractionSignature,
  type DiscordInteractionError,
} from "./discord-interactions";
import type { Env } from "@purin-labs/kernel/env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from "@purin-labs/kernel/http";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceLog } from "@purin-labs/kernel/observability";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseVaultHandle,
  resolveDiscordInteractionVerificationCredential,
  storeVaultSecret,
} from "@purin-labs/authority/credential-vault/index";
import { assertNever } from "@purin-labs/std";
import { fieldErrorResponse, isAuthorizedOrganisationAdminRequest, isLocalDebugRequest, jsonBodyErrorResponse, parseOrganisationPath } from "./request-helpers";

export async function handleConfigureDiscordInteraction(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  if (
    !isLocalDebugRequest(request) &&
    !isAuthorizedOrganisationAdminRequest(request, env)
  ) {
    return notFound();
  }

  const body = await readJsonObject(request);
  const requestId = newRequestId();

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const organisationId = readOrganisationIdField(body.value);
  const applicationIdRaw = readStringField(body.value, "applicationId");
  const guildIdRaw = readStringField(body.value, "guildId");
  const publicKeyRaw = readStringField(body.value, "publicKey");

  if (!organisationId.ok) {
    return fieldErrorResponse(organisationId.error);
  }

  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }
  const scope = execution.value;

  if (!applicationIdRaw.ok) {
    return fieldErrorResponse(applicationIdRaw.error);
  }

  if (!guildIdRaw.ok) {
    return fieldErrorResponse(guildIdRaw.error);
  }

  if (!publicKeyRaw.ok) {
    return fieldErrorResponse(publicKeyRaw.error);
  }

  const applicationId = parseDiscordApplicationId(applicationIdRaw.value);
  const guildId = parseDiscordGuildId(guildIdRaw.value);
  const publicKey = parseDiscordPublicKey(publicKeyRaw.value);
  const publicKeyRef = parseVaultHandle("vault:discord:interaction-public-key");

  if (!applicationId.ok) {
    return errorResponse(
      applicationId.error.code,
      "Discord application id is invalid.",
      422,
    );
  }

  if (!guildId.ok) {
    return errorResponse(
      guildId.error.code,
      "Discord guild id is invalid.",
      422,
    );
  }

  if (!publicKey.ok) {
    return discordInteractionErrorResponse(publicKey.error);
  }

  if (!publicKeyRef.ok) {
    return errorResponse(
      "discord_install_invalid",
      "Discord public key handle is invalid.",
      500,
    );
  }

  const stored = await storeVaultSecret({
    db: scope.database,
    keys: env,
    organisationId: organisationId.value,
    handle: publicKeyRef.value,
    secret: {
      kind: "header",
      header: "discord-interaction-public-key",
      value: publicKeyRaw.value.toLowerCase(),
    },
    now: Date.now(),
  });

  if (!stored.ok) {
    return errorResponse(
      stored.error.code,
      "Discord public key was not stored.",
      503,
    );
  }

  const installedAt = Date.now();
  await writeDiscordInteractionInstall(scope.database, {
    organisationId: organisationId.value,
    applicationId: applicationId.value,
    guildId: guildId.value,
    publicKeyRef: publicKeyRef.value,
    status: "active",
    installedAt,
  });
  const endpointUrl = `${env.PANTRY_PUBLIC_ORIGIN.replace(/\/$/u, "")}/hook/discord/${organisationId.value}`;

  traceLog("discord.interaction_configured", {
    requestId,
    organisation_id: organisationId.value,
    application_id: applicationId.value,
    guild_id: guildId.value,
    installed_at: installedAt,
  });
  return jsonResponse(
    {
      ok: true,
      organisationId: organisationId.value,
      applicationId: applicationId.value,
      guildId: guildId.value,
      endpointUrl,
    },
    201,
  );
}

export async function handleDiscordInteraction(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const organisationId = parseOrganisationPath(organisationIdRaw);

  if (!organisationId.ok) {
    return notFound();
  }

  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }
  const scope = execution.value;

  const install = await readActiveDiscordInteractionInstall(
    scope.database,
    organisationId.value,
  );

  if (!install.ok) {
    return notFound();
  }

  const keySecret = await resolveDiscordInteractionVerificationCredential({
    db: scope.database,
    keys: env,
    install: install.value,
  });
  const publicKey =
    keySecret.ok && keySecret.value.kind === "header"
      ? parseDiscordPublicKey(keySecret.value.value)
      : null;

  if (publicKey === null || !publicKey.ok) {
    return errorResponse(
      "discord_install_invalid",
      "Discord interaction install is invalid.",
      503,
    );
  }

  const rawBody = await request.text();
  const verified = await verifyDiscordInteractionSignature({
    publicKey: publicKey.value,
    signature: request.headers.get("x-signature-ed25519"),
    timestamp: request.headers.get("x-signature-timestamp"),
    body: rawBody,
  });

  if (!verified.ok) {
    return discordInteractionErrorResponse(verified.error);
  }

  const parsedBody = parseDiscordJsonBody(rawBody);

  if (!parsedBody.ok) {
    return discordInteractionErrorResponse(parsedBody.error);
  }

  const interaction = parseDiscordInteraction(
    parsedBody.value,
    install.value.applicationId,
    install.value.guildId,
  );

  if (!interaction.ok) {
    return discordInteractionErrorResponse(interaction.error);
  }

  if (interaction.value.kind === "ping") {
    return discordPongResponse();
  }

  return discordEphemeralResponse(
    "Identity linking is available from an organisation-owned Slack workspace.",
  );
}

function parseDiscordJsonBody(
  rawBody: string,
): Result<unknown, DiscordInteractionError> {
  try {
    return { ok: true, value: JSON.parse(rawBody) as unknown };
  } catch {
    return {
      ok: false,
      error: { code: "discord_payload_invalid", field: "body" },
    };
  }
}

function discordInteractionErrorResponse(
  error: DiscordInteractionError,
): Response {
  switch (error.code) {
    case "discord_signature_missing":
    case "discord_signature_invalid":
      return errorResponse(
        error.code,
        "Discord interaction signature is invalid.",
        401,
      );
    case "discord_payload_invalid":
      return errorResponse(
        error.code,
        `Discord interaction field is invalid: ${error.field}.`,
        400,
      );
    case "discord_command_unsupported":
      return discordEphemeralResponse("This Purin Pantry command is unsupported.");
    default:
      return assertNever(error);
  }
}
