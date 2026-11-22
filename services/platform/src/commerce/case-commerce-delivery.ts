// The delivery of a Case's commerce outputs to its thread: the outcome of an
// approved or rejected action, and the notice that an agent's proposal waits
// for approval. Each delivery checks the action's request authority again,
// as it stands now, before the connector posts.
import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import type { CaseActor } from "../actors/case/case-actor";
import type { CaseOutput } from "../actors/case/types";
import { sinkRefusalAsksPerson } from "@purin-labs/authority/policy/index";
import { holdCaseOutput } from "../actors/case-output-hold";
import { authorizeCaseConversationOutput } from "../actors/case-walking-path";
import { resolveActiveConnectorActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import { prepareTurnAuthority } from "../context/turn-context";
import type { Env } from "@purin-labs/kernel/env";
import { parseConnectorId, type OrganisationId } from "@purin-labs/kernel/ids";
import { resolveOrganisationModelRoute } from "../models/route";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { loadOrganisationPolicyOrDefaultDeny } from "@purin-labs/authority/policy-snapshot";
import type { RequestAuthority } from "@purin-labs/contracts";

type CommerceCaseOutputDelivery =
  | {
      readonly kind: "delivered" | "already_settled";
      readonly deliveryReceiptId: string;
    }
  | { readonly kind: "pending"; readonly retryAt: number }
  /** The exit check stopped the output, and it waits for a person. */
  | { readonly kind: "held" };

/** Who asked for the work that the output reports, as the ledger keeps it. */
type CommerceOutputAuthority = Readonly<{
  organisationId: OrganisationId;
  /** The two parts of the accepted execution: a session and a turn or nonce. */
  sessionId: string;
  executionId: string;
  requestAuthority: RequestAuthority;
  authorityPartitionDigest: string;
}>;

/**
 * Posts a pending commerce output of a Case and settles its receipt, when
 * the request's authority still holds and the flow check allows the thread.
 */
export async function deliverCommerceCaseOutput(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    caseActor: Pick<
      CaseActor,
      "acceptDeliveryReceipt" | "holdOutput" | "rejectOutput"
    >;
    output: CaseOutput;
    authority: CommerceOutputAuthority;
    now: number;
  }>,
): Promise<
  | { readonly ok: true; readonly value: CommerceCaseOutputDelivery }
  | { readonly ok: false; readonly error: { readonly code: string } }
> {
  const { env, scope, authority, output } = input;
  const modelRoute = await resolveOrganisationModelRoute({
    env,
    organisationId: authority.organisationId,
    now: input.now,
  });
  if (!modelRoute.ok)
    return {
      ok: false,
      error: { code: "commerce_case_authority_unavailable" },
    };
  const loadedPolicy = await loadOrganisationPolicyOrDefaultDeny({
    bindings: { db: scope.database, kv: env.POLICY_KV },
    organisationId: authority.organisationId,
    now: input.now,
  });
  const liveAuthority = await prepareTurnAuthority({
    db: scope.database,
    accountAccess: scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      authority.sessionId,
      authority.executionId,
    ),
    action: "execute",
    organisationId: authority.organisationId,
    requestAuthority: authority.requestAuthority,
    policy: { version: loadedPolicy.snapshot.version },
  });
  if (
    !liveAuthority.ok ||
    liveAuthority.value.authorityPartition.digest !==
      authority.authorityPartitionDigest
  )
    return { ok: false, error: { code: "commerce_case_authority_superseded" } };
  const flowDecision = await authorizeCaseConversationOutput(
    liveAuthority.value,
    output,
    env,
  );
  if (!flowDecision.ok && !sinkRefusalAsksPerson(flowDecision.error.code))
    return { ok: false, error: { code: flowDecision.error.code } };
  const connectorId = parseConnectorId(output.connectorId);
  if (!connectorId.ok)
    return { ok: false, error: { code: "commerce_case_connector_invalid" } };
  const connector = await resolveActiveConnectorActorAtPlacement({
    placement: scope.placement,
    env,
    namespace: env.CONNECTOR,
    organisationId: authority.organisationId,
    connectorId: connectorId.value,
    now: input.now,
  });
  if (!connector.ok)
    return { ok: false, error: { code: connector.error.code } };
  if (!flowDecision.ok) {
    const held = await holdCaseOutput({
      env,
      organisationId: authority.organisationId,
      connector: connector.value,
      connectorIdentity: {
        organisationId: authority.organisationId,
        connectorId: connectorId.value,
      },
      caseActor: input.caseActor,
      output,
      refusal: flowDecision.error.code,
      requestAuthority: authority.requestAuthority,
    });
    return held.ok ? { ok: true, value: { kind: "held" } } : held;
  }
  const delivered = await connector.value.deliver({
    identity: {
      organisationId: authority.organisationId,
      connectorId: connectorId.value,
    },
    delivery: output.delivery,
    requestedAt: input.now,
  });
  if (!delivered.ok) return delivered;
  if (delivered.value.kind === "retry")
    return {
      ok: true,
      value: { kind: "pending", retryAt: delivered.value.retryAt },
    };
  if (delivered.value.kind === "rejected") {
    await input.caseActor.rejectOutput({
      outputId: output.outputId,
      reason: delivered.value.reason,
    });
    return {
      ok: false,
      error: {
        code: `commerce_case_delivery_rejected:${delivered.value.reason}`,
      },
    };
  }
  const settled = await input.caseActor.acceptDeliveryReceipt({
    outputId: output.outputId,
    receipt: {
      ...delivered.value.receipt,
      flowBindingDigest: flowDecision.value.flowBindingDigest,
      decisionDigest: flowDecision.value.decisionDigest,
    },
  });
  if (settled.ok !== true) return settled;
  return {
    ok: true,
    value: {
      kind:
        settled.value.kind === "already_settled"
          ? "already_settled"
          : "delivered",
      deliveryReceiptId: delivered.value.receipt.nativeReceiptId,
    },
  };
}
