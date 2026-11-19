import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import { isRecord } from "@purin-labs/std";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { commerceHeaders } from "./commerce-support";
import { ORGANISATION_ID } from "./slack-journey-support";

export const PROPOSE = "commerce.action.propose";

export async function propose(
  session: IssuedControlSession,
  action: object,
  attempt: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const headers = commerceHeaders(session);
  headers.set("idempotency-key", `propose-permission-${attempt}`);
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/commerce/actions`,
    { method: "POST", headers, body: JSON.stringify(action) },
  );
  return { status: response.status, body: await response.json() };
}

async function accessRead(
  session: IssuedControlSession,
): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/access-control`,
    { headers: commerceHeaders(session) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Access view missing");
  return isRecord(body.accessControl) ? body.accessControl : body;
}

export async function accessCapability(
  session: IssuedControlSession,
): Promise<Readonly<{ mode: string; revision: number }>> {
  const view = await accessRead(session);
  const capabilities = Array.isArray(view.capabilities)
    ? view.capabilities
    : [];
  for (const capability of capabilities) {
    if (
      isRecord(capability) &&
      isRecord(capability.definition) &&
      capability.definition.capabilityId === PROPOSE
    )
      return {
        mode: String(capability.mode),
        revision: Number(capability.revision),
      };
  }
  throw new Error(`${PROPOSE} missing from Access`);
}

export async function accessMutation(
  session: IssuedControlSession,
  suffix: string,
  body: (revision: number) => object,
): Promise<void> {
  const revision = Number((await accessRead(session)).revision);
  const headers = commerceHeaders(session);
  headers.set("idempotency-key", crypto.randomUUID());
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/access-control${suffix}`,
    { method: "POST", headers, body: JSON.stringify(body(revision)) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}
