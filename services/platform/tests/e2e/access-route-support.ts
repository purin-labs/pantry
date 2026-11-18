import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import { isRecord } from "@seams/std";

import type { IssuedControlSession } from "../../src/data/control-plane";
import { commerceHeaders } from "./commerce-support";

/** The Access routes as the Portal calls them, for an owner's session. */
export function accessControlPath(organisationId: string): string {
  return `https://localhost/v1/control/organisations/${organisationId}/access-control`;
}

/** The Portal's capability change: the Access revision and the capability's. */
export async function enableCapability(
  organisationId: string,
  session: IssuedControlSession,
  capabilityId: string,
  mode: "enabled" | "disabled" = "enabled",
): Promise<void> {
  const view = await readAccess(organisationId, session);
  const capability = Array.isArray(view.capabilities)
    ? view.capabilities.find(
        (candidate: unknown) =>
          isRecord(candidate) &&
          isRecord(candidate.definition) &&
          candidate.definition.capabilityId === capabilityId,
      )
    : undefined;
  if (!isRecord(capability)) throw new Error("Capability missing in Access");
  const response = await exports.default.fetch(
    `${accessControlPath(organisationId)}/capabilities/${capabilityId}`,
    {
      method: "POST",
      headers: mutationHeaders(session),
      body: JSON.stringify({
        expectedRevision: view.revision,
        capabilityRevision: capability.revision,
        capabilityVersion: 1,
        mode,
      }),
    },
  );
  expect(response.status).toBe(200);
}

/** The Portal's grant creation, with the grant that the request view names. */
export async function createGrant(
  organisationId: string,
  session: IssuedControlSession,
  grant: Record<string, unknown>,
): Promise<void> {
  const view = await readAccess(organisationId, session);
  const response = await exports.default.fetch(`${accessControlPath(organisationId)}/grants`, {
    method: "POST",
    headers: mutationHeaders(session),
    body: JSON.stringify({
      expectedRevision: view.revision,
      subjectRef: grant.subjectRef,
      target: grant.target,
    }),
  });
  expect(response.status).toBe(200);
}

/**
 * The Portal's revoke of the active Product read grant whose subject has
 * this kind, as an owner does it on the Access page.
 */
export function revokeProductRead(
  organisationId: string,
  session: IssuedControlSession,
  subjectKind: "organisation_role" | "conversation",
): Promise<void> {
  return revokeGrant(
    organisationId,
    session,
    "commerce.entity.read",
    subjectKind,
  );
}

/**
 * The Portal's revoke of the active grant of this capability whose subject
 * has this kind, as an owner does it on the Access page.
 */
export async function revokeGrant(
  organisationId: string,
  session: IssuedControlSession,
  capabilityId: string,
  subjectKind: "organisation_role" | "conversation",
): Promise<void> {
  const view = await readAccess(organisationId, session);
  const grants =
    isRecord(view.grants) && Array.isArray(view.grants.items)
      ? view.grants.items
      : [];
  const grant = grants.find(
    (candidate: unknown) =>
      isRecord(candidate) &&
      isRecord(candidate.capability) &&
      candidate.capability.capabilityId === capabilityId &&
      isRecord(candidate.subject) &&
      candidate.subject.kind === subjectKind &&
      isRecord(candidate.actions) &&
      candidate.actions.kind === "revoke_grant",
  );
  if (!isRecord(grant) || typeof grant.grantId !== "string")
    throw new Error(`${capabilityId} grant missing`);
  const response = await exports.default.fetch(
    `${accessControlPath(organisationId)}/grants/${encodeURIComponent(grant.grantId)}/revoke`,
    {
      method: "POST",
      headers: mutationHeaders(session),
      body: JSON.stringify({
        expectedRevision: view.revision,
        grantRevision: grant.revision,
        reason: `The journey takes ${capabilityId} away.`,
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

export async function readAccess(
  organisationId: string,
  session: IssuedControlSession,
): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(accessControlPath(organisationId), {
    headers: commerceHeaders(session),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Access view invalid");
  if (!isRecord(body.accessControl)) throw new Error("Access view invalid");
  return body.accessControl;
}

export function mutationHeaders(session: IssuedControlSession): Headers {
  const headers = commerceHeaders(session);
  headers.set("idempotency-key", `e2e-${crypto.randomUUID()}`);
  return headers;
}

