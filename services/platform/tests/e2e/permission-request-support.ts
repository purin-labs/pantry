import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { isRecord } from "@seams/std";

import type { IssuedControlSession } from "../../src/data/control-plane";
import type { OrganisationId } from "../../src/ids";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import {
  accessControlPath,
  createGrant,
  enableCapability,
} from "./access-route-support";
import { commerceHeaders } from "./commerce-support";

/** The permission request that a Slack notice links to. */
export function requestIdIn(
  messages: readonly Record<string, string>[],
): string {
  for (const message of messages) {
    const match = /permissionRequest=([0-9a-f]{32})/u.exec(
      message.blocks ?? "",
    );
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error("Permission notice missing");
}

export async function readRequest(
  organisationId: string,
  session: IssuedControlSession,
  requestId: string,
): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(
    `${accessControlPath(organisationId)}/permission-requests/${requestId}`,
    { headers: commerceHeaders(session) },
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Permission request view invalid");
  return body;
}

/** The requests that wait, as the Portal's pending list reads them. */
export async function readPendingRequests(
  organisationId: string,
  session: IssuedControlSession,
): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(
    `${accessControlPath(organisationId)}/permission-requests`,
    { headers: commerceHeaders(session) },
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Pending request list invalid");
  return body;
}

export function decide(
  organisationId: string,
  session: IssuedControlSession,
  requestId: string,
  decision: "allow" | "deny",
): Promise<Response> {
  return exports.default.fetch(
    `${accessControlPath(organisationId)}/permission-requests/${requestId}/decision`,
    {
      method: "POST",
      headers: commerceHeaders(session),
      body: JSON.stringify({ decision }),
    },
  );
}

/**
 * Allow as the Portal prompt does: turn on each item's capability that is
 * off, read the request again, add the grant of each item that is not
 * granted, then decide.
 */
export async function allowAsPortal(
  organisationId: string,
  session: IssuedControlSession,
  requestId: string,
): Promise<Response> {
  for (const item of requestItems(
    await readRequest(organisationId, session, requestId),
  ))
    if (item.mode !== "enabled")
      await enableCapability(organisationId, session, item.capabilityId);
  for (const item of requestItems(
    await readRequest(organisationId, session, requestId),
  ))
    if (!item.granted) await createGrant(organisationId, session, item.grant);
  return decide(organisationId, session, requestId, "allow");
}

type RequestItem = Readonly<{
  capabilityId: string;
  mode: unknown;
  granted: unknown;
  grant: Record<string, unknown>;
}>;

export function requestItems(view: Record<string, unknown>): RequestItem[] {
  if (!Array.isArray(view.items))
    throw new Error("Permission request items invalid");
  return view.items.map(requestItem);
}

function requestItem(raw: unknown): RequestItem {
  if (
    !isRecord(raw) ||
    typeof raw.capabilityId !== "string" ||
    !isRecord(raw.grant)
  )
    throw new Error("Permission request item invalid");
  return {
    capabilityId: raw.capabilityId,
    mode: raw.mode,
    granted: raw.granted,
    grant: raw.grant,
  };
}

/**
 * The notice links to the Portal by the Organisation's and its default
 * workspace's handles. The Slack fixture's identifiers are not valid handles,
 * so a journey gives them handles, as onboarding does.
 */
export async function givePortalHandles(
  organisationId: OrganisationId,
): Promise<void> {
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) throw new Error("E2E organisation scope missing");
  for (const db of new Set([env.DB, scope.value.database]))
    await db
      .prepare(
        "UPDATE organisation SET organisation_handle = 'e2e-slack-actor' WHERE organisation_id = ?",
      )
      .bind(organisationId)
      .run();
  await scope.value.database
    .prepare(
      `UPDATE organisation_workspace SET workspace_handle = 'cafe'
       WHERE workspace_id IN (
         SELECT workspace_id FROM organisation_default_workspace
         WHERE organisation_id = ?
       )`,
    )
    .bind(organisationId)
    .run();
}
