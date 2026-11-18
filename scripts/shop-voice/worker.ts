// The Worker of the shop Mac journey (Plan 82 Phase 1B). Every /v1 request uses
// production routing, through the Plan 81 fixture Worker, which also builds the
// Organisation and signs a person in.
import kitchen from "../plan-81/kitchen-worker";
import { CAPABILITY_KEYS } from "../../services/platform/src/authorization/capability-catalogue";
import { createAccessGrant } from "../../services/platform/src/data/access-grants";
import type { Env } from "../../services/platform/src/env";
import type { OrganisationId } from "../../services/platform/src/ids";

export {
  OrganisationDO,
  SessionDO,
  CaseDO,
  ConnectorDO,
  CodeModePlatformGovernorActor,
} from "../plan-81/kitchen-worker";

/** This fixture has no shop catalogue. voice-control.test.ts covers those names. */
const SHOP_TERMS = ["Kouign-amann", "Financier", "Canelé"];

/** The stand-in for Workers AI: the provider process records each call and answers. */
const FIXTURE_WORKERS_AI: NonNullable<Env["AI"]> = {
  async run(_model, inputs) {
    const response = await fetch("https://shop-voice-fixture.internal/ai", {
      method: "POST",
      body: JSON.stringify({
        audioBase64Length: inputs.audio.length,
        language: inputs.language,
      }),
    });
    return (await response.json()) as Readonly<{ text?: unknown }>;
  },
};

/** Owners may let the agent stage a setup change, for a spoken approval's card. */
async function allowProposals(
  env: Env,
  seeded: Readonly<{ organisationId: OrganisationId }>,
) {
  const granted = await createAccessGrant({
    db: env.DB,
    organisationId: seeded.organisationId,
    grantId: "grant_voice_proposals",
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "platform_capability",
      capabilityId: CAPABILITY_KEYS.commerceActionPropose,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "shop-voice-journey",
    },
    now: Date.now(),
  });
  if (!granted.ok) throw new Error(granted.error.code);
  return seeded;
}

/** The full Portal reads the receipt of the activation that the fixture names. */
async function recordActivation(
  env: Env,
  seeded: Readonly<{ organisationId: OrganisationId }>,
) {
  const now = Date.now();
  const attemptId = "shop-voice-activation";
  const hash = "shop-voice-journey";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organisation_activation_attempt
         (activation_attempt_id, organisation_id, readiness_version, readiness_hash,
          status, started_at, updated_at, completed_at)
       VALUES (?, ?, 1, ?, 'completed', ?, ?, ?)`,
    ).bind(attemptId, seeded.organisationId, hash, now, now, now),
    env.DB.prepare(
      `INSERT INTO organisation_activation_receipt
         (activation_receipt_id, activation_attempt_id, organisation_id, readiness_hash,
          policy_snapshot_id, cue_snapshot_id, capability_profile, activated_at)
       VALUES ('plan81-browser', ?, ?, ?, ?, ?, 'read_and_propose', ?)`,
    ).bind(attemptId, seeded.organisationId, hash, hash, hash, now),
  ]);
  return seeded;
}

export default {
  queue: kitchen.queue,
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/test/dns" || url.pathname === "/test/state")
      return fetch("https://shop-voice-fixture.internal/dns");
    const response = await kitchen.fetch(
      request,
      { ...env, AI: FIXTURE_WORKERS_AI },
      context,
    );
    if (url.pathname === "/test/setup" && response.ok)
      return Response.json(
        await allowProposals(
          env,
          await recordActivation(env, await response.json()),
        ),
      );
    // The Mac's prompt and the Portal's text check read the same names (Plan 82C D1).
    const readsVocabulary =
      url.pathname === "/v1/voice-macs/vocabulary" ||
      /^\/v1\/control\/organisations\/[^/]+\/voice\/vocabulary$/u.test(
        url.pathname,
      );
    return readsVocabulary && response.status === 503
      ? Response.json({ terms: SHOP_TERMS })
      : response;
  },
};
