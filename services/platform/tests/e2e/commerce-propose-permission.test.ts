import { expect, it, type TestContext } from "vitest";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { commerceCanonicalResourceId } from "@purin-labs/area-commerce/server/contract/resource-ids";
import {
  PROPOSE,
  accessCapability,
  accessMutation,
  propose,
} from "./commerce-propose-support";
import {
  MERCHANT,
  PRODUCT,
  installEffectAuthority,
} from "./pi-sdk-effect-support";
import { installSlackActorFixture } from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    commerceProposePermission?: Record<string, unknown>;
  }
}

it(
  "offers the propose permission while proposals are switched off, and sends the description once the owner allows it",
  { timeout: 180_000 },
  proposePermissionJourney,
);

/**
 * An owner switches "Propose governed commerce actions" off for the
 * workspace, then sends a reviewed product description for approval. Pantry
 * must answer with the permission that the prompt offers, not a bare
 * refusal, so that the owner can switch the capability on and grant it in
 * place. After the prompt's own Access changes, the same request creates the
 * action that waits for approval.
 */
async function proposePermissionJourney({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const session = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "listing",
  );

  // 0. The owner switches proposals off on the Access page.
  const on = await accessCapability(session);
  expect(on.mode).toBe("enabled");
  await accessMutation(session, `/capabilities/${PROPOSE}`, (revision) => ({
    expectedRevision: revision,
    capabilityRevision: on.revision,
    capabilityVersion: 1,
    mode: "disabled",
  }));
  const off = await accessCapability(session);
  expect(off.mode).toBe("disabled");

  // 1. Send for approval returns the permission that the prompt offers:
  //    switch the capability on, and grant it for this product.
  const refused = await sendForApproval(session, "first");
  expect(refused.status).toBe(403);
  expect(refused.body).toMatchObject({
    ok: false,
    error: "commerce_action_permission_required",
    permission: {
      capabilityId: PROPOSE,
      mode: "disabled",
      grant: { target: { kind: "published_commerce_target" } },
    },
  });

  // 2. The owner allows it, through the prompt's two Access changes.
  const permission = (refused.body as { permission: { grant: object } })
    .permission;
  await accessMutation(session, `/capabilities/${PROPOSE}`, (revision) => ({
    expectedRevision: revision,
    capabilityRevision: off.revision,
    capabilityVersion: 1,
    mode: "enabled",
  }));
  await accessMutation(session, "/grants", (revision) => ({
    expectedRevision: revision,
    ...permission.grant,
  }));

  // 3. The same description now waits for approval.
  const proposed = await sendForApproval(session, "second");
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
  expect(proposed.body).toMatchObject({
    ok: true,
    action: { state: "proposed" },
  });

  task.meta.commerceProposePermission = {
    refusedWhileSwitchedOff: refused,
    afterAllow: {
      status: proposed.status,
      state: (proposed.body as { action: { state: string } }).action.state,
    },
  };
}

function sendForApproval(
  session: IssuedControlSession,
  attempt: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  return propose(
    session,
    {
      kind: "update_product_description",
      productId: commerceCanonicalResourceId(MERCHANT, PRODUCT),
      productRevision: 1,
      description: "Six assorted cookies, baked each morning in our café.",
    },
    attempt,
  );
}
