import { ensureCaseProject } from "../projects/case-project";
import { whatsappConnectorIdValue } from "../data/whatsapp";
import { ensureOrganisationDefaultWorkspace } from "../data/organisation-workspace";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  parseCaseId,
  parseIntegrationAccountId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import { buildWhatsAppSupportAuthority } from "../request-authority";
import type { Result } from "@purin-labs/kernel/result";
import { resolveActiveCaseActorAtPlacement } from "./actor-router";
import { sha256Hex } from "@purin-labs/std";

/**
 * System-origin WhatsApp Case admission. One support conversationWindow maps to one
 * stable Case; several admitted messages in the conversationWindow become one trigger
 * carrying an ordered list of exact provider message identifiers. The trigger
 * content holds identifiers only — customer text stays in the encrypted
 * active envelope and reaches the agent through the purpose-bound Case tools.
 */

type WhatsAppCaseAdmissionInput = Readonly<{
  scope: OrganisationExecutionScope;
  organisationId: string;
  integrationAccountId: string;
  customerWaId: string;
  caseId: string;
  providerMessageIds: readonly string[];
  supportBindingId: string;
  bindingRevision: number;
  policyVersion: number;
  receivedAt: number;
}>;

type WhatsAppCaseAdmissionError = { readonly code: string };

export async function admitWhatsAppSupportCase(
  env: Env,
  input: WhatsAppCaseAdmissionInput,
): Promise<
  Result<
    { readonly kind: "accepted" | "duplicate" },
    WhatsAppCaseAdmissionError
  >
> {
  const organisationId = parseOrganisationId(input.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    input.integrationAccountId,
  );
  const caseId = parseCaseId(input.caseId);
  const newest = input.providerMessageIds.at(-1);
  if (
    !organisationId.ok ||
    !integrationAccountId.ok ||
    !caseId.ok ||
    newest === undefined
  ) {
    return { ok: false, error: { code: "whatsapp_case_identity_invalid" } };
  }
  const authority = buildWhatsAppSupportAuthority({
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    supportBindingId: input.supportBindingId,
    bindingRevision: input.bindingRevision,
    ingressPolicyVersion: input.policyVersion,
  }).requestAuthority;
  const scope = input.scope;
  if (
    scope.organisationId !== organisationId.value ||
    !(await scope.isActive())
  )
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const workspace = await ensureOrganisationDefaultWorkspace({
    scope,
    archive: env.ARCHIVE,
    now: input.receivedAt,
  });
  if (!workspace.ok)
    return { ok: false, error: { code: workspace.error.code } };
  const placed = await ensureCaseProject({
    scope,
    caseId: caseId.value,
    origin: "whatsapp",
    now: input.receivedAt,
  });
  if (!placed.ok) return { ok: false, error: { code: placed.error.code } };
  const caseActor = await resolveActiveCaseActorAtPlacement({
    env: env,
    namespace: env.CASE,
    placement: scope.placement,
    organisationId: organisationId.value,
    caseId: caseId.value,
    now: input.receivedAt,
  });
  if (!caseActor.ok)
    return { ok: false, error: { code: caseActor.error.code } };
  const triggerId = await createWhatsAppTriggerId(newest);
  const ensured = await caseActor.value.ensure({
    identity: { organisationId: organisationId.value, caseId: caseId.value },
    purpose: `WhatsApp support ${input.customerWaId}`,
    workspaceRevision: workspace.value.revision,
    lifecycle: { kind: "open", openedAt: input.receivedAt },
  });
  if (!ensured.ok) return { ok: false, error: { code: ensured.error.code } };
  const connectorId = whatsappConnectorIdValue(input.integrationAccountId);
  const triggered = await caseActor.value.acceptTrigger({
    triggerId,
    caseId: caseId.value,
    source: {
      kind: "connector",
      connectorId,
      ingressId: `whatsapp_${input.customerWaId}_${newest}`,
    },
    requestAuthority: authority,
    content: { kind: "text", text: whatsappTriggerManifest(input) },
    acceptedAt: input.receivedAt,
    attachments: [],
  });
  if (!triggered.ok)
    return { ok: false, error: { code: triggered.error.code } };
  const bound = await caseActor.value.attachBinding({
    bindingId: `binding_${caseId.value}`,
    caseId: caseId.value,
    connectorId,
    address: {
      kind: "whatsapp_conversation",
      integrationAccountId: input.integrationAccountId,
      waId: input.customerWaId,
    },
  });
  return bound.ok
    ? { ok: true, value: { kind: triggered.value.kind } }
    : { ok: false, error: { code: bound.error.code } };
}

function whatsappTriggerManifest(input: WhatsAppCaseAdmissionInput): string {
  return [
    "New WhatsApp customer messages were admitted to this Case.",
    `Customer: ${input.customerWaId}`,
    `Messages (oldest first): ${input.providerMessageIds.join(", ")}`,
    "Read the exact message text through the trusted WhatsApp Case tools.",
  ].join("\n");
}

async function createWhatsAppTriggerId(
  providerMessageId: string,
): Promise<string> {
  return `trigger_whatsapp_${await sha256Hex(providerMessageId)}`;
}
