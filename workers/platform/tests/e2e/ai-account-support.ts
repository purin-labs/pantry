import { exports } from "cloudflare:workers";
import { isRecord } from "@purin-labs/std";

import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { commerceHeaders } from "./commerce-support";

/**
 * The `PUT` of the AI account drawer: a person changes the AI source of the
 * Organisation, or saves a key, with the version that the page read.
 */
export async function changeAiAccount(
  session: IssuedControlSession,
  organisationId: OrganisationId,
  idempotencyKey: string,
  body: Readonly<Record<string, unknown>>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const inference = `https://localhost/v1/control/organisations/${organisationId}/inference`;
  const read = await exports.default.fetch(inference, {
    headers: commerceHeaders(session),
  });
  const current: unknown = await read.json();
  const headers = commerceHeaders(session);
  headers.set(
    "x-pantry-configuration-version",
    String(isRecord(current) ? current.configurationVersion : ""),
  );
  headers.set("idempotency-key", idempotencyKey);
  const response = await exports.default.fetch(inference, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
