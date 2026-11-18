import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
} from "../organisation-execution-scope";
import type { Env } from "../env";
import {
  errorResponse,
  methodNotAllowed,
} from "../http";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
} from "../ids";
import { scheduleFileReconciliationHint } from "../context/files";
import { verifyDropboxWebhookSignature } from "../provider-adapters/dropbox";
import { isRecord } from "@seams/std";

export async function handleDropboxWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === "GET") {
    const challenge = new URL(request.url).searchParams.get("challenge");
    return challenge !== null && challenge.length > 0 && challenge.length <= 256
      ? new Response(challenge, {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        })
      : errorResponse(
          "dropbox_webhook_challenge_invalid",
          "Invalid challenge.",
          400,
        );
  }
  if (request.method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }
  const appSecret = env.DROPBOX_OAUTH_CLIENT_SECRET?.trim() ?? "";
  const signatureHex = request.headers.get("x-dropbox-signature") ?? "";
  if (appSecret.length === 0) {
    return errorResponse(
      "dropbox_webhook_configuration_missing",
      "Dropbox webhook verification is unavailable.",
      503,
    );
  }
  const rawBody = await request.text();
  const verified = await verifyDropboxWebhookSignature({
    appSecret,
    rawBody,
    signatureHex,
  });
  if (!verified) {
    return errorResponse(
      "dropbox_webhook_signature_invalid",
      "Invalid signature.",
      401,
    );
  }
  const accountIds = parseDropboxWebhookAccountIds(rawBody);
  if (accountIds === null) {
    return errorResponse(
      "dropbox_webhook_payload_invalid",
      "Invalid payload.",
      400,
    );
  }
  const now = Date.now();
  for (const database of configuredOrganisationDatabases(env)) {
    for (const providerAccountId of accountIds) {
      const rows = await database
        .prepare(
          `SELECT account.organisation_id AS organisationId,
              account.integration_account_id AS integrationAccountId
         FROM integration_account AS account
         JOIN organisation ON organisation.organisation_id = account.organisation_id AND organisation.status = 'active'
        WHERE account.provider = 'dropbox'
          AND account.provider_account_id = ?
          AND account.lifecycle = 'active'`,
        )
        .bind(providerAccountId)
        .all<{
          readonly organisationId: unknown;
          readonly integrationAccountId: unknown;
        }>();
      for (const row of rows.results ?? []) {
        if (
          typeof row.organisationId !== "string" ||
          typeof row.integrationAccountId !== "string"
        ) {
          continue;
        }
        const organisationId = parseOrganisationId(row.organisationId);
        const integrationAccountId = parseIntegrationAccountId(
          row.integrationAccountId,
        );
        if (!organisationId.ok || !integrationAccountId.ok) {
          continue;
        }
        const execution = await OrganisationExecutionScope.resolve(
          env,
          organisationId.value,
        );
        if (!execution.ok) {
          return errorResponse(
            execution.error.code,
            "Organisation placement is unavailable.",
            503,
          );
        }
        if (execution.value.database !== database) continue;
        await scheduleFileReconciliationHint({
          scope: execution.value,
          integrationAccountId: integrationAccountId.value,
          nextRunAt: now,
        });
        if (!(await execution.value.isActive())) {
          return errorResponse(
            "organisation_placement_unavailable",
            "Organisation placement is unavailable.",
            503,
          );
        }
      }
    }
  }
  return new Response(null, { status: 200 });
}

export function parseDropboxWebhookAccountIds(
  rawBody: string,
): readonly string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (
    !isRecord(raw) ||
    !isRecord(raw.list_folder) ||
    !Array.isArray(raw.list_folder.accounts) ||
    raw.list_folder.accounts.length > 100
  ) {
    return null;
  }
  const accounts: string[] = [];
  for (const value of raw.list_folder.accounts) {
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }
    accounts.push(value);
  }
  return [...new Set(accounts)];
}
