import { expect, it, type TestContext } from "vitest";
import {
  PROPOSE,
  accessCapability,
  accessMutation,
  propose,
} from "./commerce-propose-support";
import {
  installEffectAuthority,
  listingProposalRequest,
} from "./pi-sdk-effect-support";
import { installSlackActorFixture } from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    commerceProposeSwitchOn?: Record<string, unknown>;
  }
}

it(
  "offers to switch proposals on when a listing has no grant target, and sends the same proposal again once the owner allows it",
  { timeout: 180_000 },
  proposeSwitchOnJourney,
);

/**
 * An owner proposes to publish a catalogue listing while "Propose governed
 * commerce actions" is switched off. A listing names an offer, which has no
 * published target to grant, so the prompt can only switch the capability
 * on; the owner's role already holds the grant. The Portal then sends the
 * same proposal again with the same idempotency key, and it waits for
 * approval.
 */
async function proposeSwitchOnJourney({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const session = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "listing",
  );
  const on = await accessCapability(session);
  await accessMutation(session, `/capabilities/${PROPOSE}`, (revision) => ({
    expectedRevision: revision,
    capabilityRevision: on.revision,
    capabilityVersion: 1,
    mode: "disabled",
  }));
  const off = await accessCapability(session);

  // 1. The proposal answers with the switch, and no grant.
  const refused = await propose(session, listingProposalRequest(), "listing");
  expect(refused.status).toBe(403);
  expect(refused.body).toMatchObject({
    ok: false,
    error: "commerce_action_permission_required",
    permission: { capabilityId: PROPOSE, mode: "disabled", grant: null },
  });

  // 2. Allow switches the capability on, as the prompt does.
  await accessMutation(session, `/capabilities/${PROPOSE}`, (revision) => ({
    expectedRevision: revision,
    capabilityRevision: off.revision,
    capabilityVersion: 1,
    mode: "enabled",
  }));

  // 3. The same request, with the same key, now waits for approval.
  const proposed = await propose(session, listingProposalRequest(), "listing");
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
  expect(proposed.body).toMatchObject({
    ok: true,
    action: { state: "proposed" },
  });
  task.meta.commerceProposeSwitchOn = {
    refusedWhileSwitchedOff: refused,
    afterAllow: {
      status: proposed.status,
      state: (proposed.body as { action: { state: string } }).action.state,
    },
  };
}
