import type { RequestAuthority } from "@purin-labs/contracts";
import { sha256Hex } from "@purin-labs/std";

import {
  insertHeldOutputRequest,
  type HeldOutputReason,
} from "../data/held-output-request";
import type { Env } from "../env";
import { newRequestId, parseOrganisationId } from "../ids";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { heldOutputNoticeText } from "../slack/held-output-notice";
import type { CaseOutput } from "./case/types";
import type { ConnectorIdentity } from "@purin-labs/contracts";
import type { ConnectorDO } from "./connector";
import type { CaseActor } from "./case/case-actor";
import { traceWarn } from "../observability";

/**
 * Hold an output that the exit check stopped, and ask for approval (Plan 27C).
 * The Case marks the output held (Refactor 15), so no resume path sends it
 * before the decision. The request is stored first: a Case mark with no
 * request would leave the output with no exit. The request tells a person
 * in the audience, or the person who started the work. The thread gets fixed
 * text with a Portal link, and no word of the answer. A repeated call keeps
 * the first request and the first notice.
 */
export async function holdCaseOutput(
  input: Readonly<{
    env: Env;
    organisationId: string;
    connector: Pick<ConnectorDO, "deliver">;
    connectorIdentity: ConnectorIdentity;
    caseActor: Pick<CaseActor, "holdOutput">;
    output: CaseOutput;
    refusal: string;
    requestAuthority: RequestAuthority;
  }>,
): Promise<
  | { readonly ok: true; readonly requestId: string }
  | { readonly ok: false; readonly error: { readonly code: string } }
> {
  const { env, output } = input;
  const address = output.delivery.address;
  if (address.kind !== "slack" && address.kind !== "slack_channel")
    return { ok: false, error: { code: "case_output_address_unsupported" } };
  const organisationId = parseOrganisationId(input.organisationId);
  if (!organisationId.ok)
    return { ok: false, error: { code: "case_output_organisation_invalid" } };
  const scope = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!scope.ok) return { ok: false, error: { code: scope.error.code } };
  const requestId = (
    await sha256Hex(`${input.organisationId}:${output.outputId}`)
  ).slice(0, 32);
  const reason: HeldOutputReason =
    input.refusal === "case_flow_sink_deny"
      ? "private_source"
      : "outside_organisation";
  const authority = input.requestAuthority;
  const stored = await insertHeldOutputRequest(scope.value, {
    requestId,
    subject: "output",
    caseId: output.delivery.caseId,
    connectorId: output.connectorId,
    outputId: output.outputId,
    channelId: address.channelId,
    effect: null,
    reason,
    requesterPersonId:
      authority.kind === "direct_conversation" ||
      authority.kind === "shared_conversation"
        ? authority.requesterPersonId
        : null,
    requestAuthority: authority,
    flowLabelJson: JSON.stringify(output.flowBinding.flowLabel),
    createdAt: Date.now(),
  });
  if (!stored.ok) return { ok: false, error: stored.error };
  const marked = await input.caseActor.holdOutput({
    outputId: output.outputId,
    requestId,
  });
  if (!marked.ok) return { ok: false, error: { code: marked.error.code } };
  const notice = await input.connector
    .deliver({
      identity: input.connectorIdentity,
      delivery: {
        ...output.delivery,
        deliveryId: `delivery_held_${requestId}`,
        content: {
          kind: "text",
          text: heldOutputNoticeText(reason),
        },
        idempotencyKey: `held_output_notice_${requestId}`,
      },
      requestedAt: Date.now(),
    })
    .catch(() => ({ ok: false }));
  // The request waits in the pending list, whether the thread holds its card
  // or not.
  if (!notice.ok)
    traceWarn("case.held_output_notice_failed", {
      requestId: newRequestId(),
      organisation_id: input.organisationId,
      request_id: requestId,
    });
  return { ok: true, requestId };
}
