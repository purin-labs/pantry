import { requireActiveOrganisationActorAtPlacement } from "../actors/actor-router";
import {
  activateCredentialRevocationPolicy,
  type CredentialRevocationCommit,
} from "../credential-vault";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { compilePublishAndActivateOrganisationPolicy } from "../policy-snapshot";

export async function activateRevocationPolicy(
  env: Env,
  scope: OrganisationExecutionScope,
  committed: CredentialRevocationCommit,
  now: number,
): Promise<{ readonly ok: boolean }> {
  const organisationId = scope.organisationId;
  try {
    const organisation = await requireActiveOrganisationActorAtPlacement({
      env,
      organisationId,
      placement: scope.placement,
      now,
    });
    const published = await compilePublishAndActivateOrganisationPolicy({
      bindings: { db: scope.database, kv: env.POLICY_KV },
      organisationId,
      organisation,
      now,
    });
    if (!published.ok) return { ok: false };

    await activateCredentialRevocationPolicy({
      db: scope.database,
      commit: committed,
      policyVersion: published.value.activation.head.activeVersion,
      restrictionVersion: published.value.activation.head.restrictionVersion,
      targetConsumerCount: published.value.activation.consumers,
      acknowledgedConsumerCount: published.value.activation.delivered,
      pendingConsumerCount: published.value.activation.pending,
      activatedAt: now,
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
