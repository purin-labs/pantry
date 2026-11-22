import { ensureCaseProject } from "../projects/case-project";
import { gmailConnectorIdValue } from "../mail-inbox/contract/connector-ids";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseCaseId,
  parseIntegrationAccountId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import { buildAgentMailboxAuthority } from "@purin-labs/authority/request-authority/index";
import type { Result } from "@purin-labs/kernel/result";
import { ensureOrganisationDefaultWorkspace } from "../data/organisation-workspace";
import { resolveActiveCaseActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

/**
 * System-origin email Case admission. One Gmail thread maps to one stable
 * Case; several admitted messages in a thread become one trigger carrying an
 * ordered list of exact message identifiers. The trigger content holds
 * identifiers only — subjects, senders, and bodies stay in Gmail and reach
 * the agent later through the purpose-bound read tools.
 */

type EmailCaseAdmissionInput = Readonly<{
  scope: OrganisationExecutionScope;
  organisationId: string;
  integrationAccountId: string;
  gmailThreadId: string;
  caseId: string;
  messageIds: readonly string[];
  mailboxBindingId: string;
  bindingRevision: number;
  policyVersion: number;
  receivedAt: number;
  /** The Subject header of the thread's first admitted message. */
  subject: string | null;
}>;

type EmailCaseAdmissionError = { readonly code: string };

export async function admitEmailThreadCase(
  env: Env,
  input: EmailCaseAdmissionInput,
): Promise<
  Result<{ readonly kind: "accepted" | "duplicate" }, EmailCaseAdmissionError>
> {
  const organisationId = parseOrganisationId(input.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    input.integrationAccountId,
  );
  const caseId = parseCaseId(input.caseId);
  const newest = input.messageIds.at(-1);
  if (
    !organisationId.ok ||
    !integrationAccountId.ok ||
    !caseId.ok ||
    newest === undefined
  ) {
    return { ok: false, error: { code: "email_case_identity_invalid" } };
  }
  if (
    input.scope.organisationId !== organisationId.value ||
    !(await input.scope.isActive())
  )
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const authority = buildAgentMailboxAuthority({
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    mailboxBindingId: input.mailboxBindingId,
    bindingRevision: input.bindingRevision,
    mailboxPolicyVersion: input.policyVersion,
  }).requestAuthority;
  const workspace = await ensureOrganisationDefaultWorkspace({
    scope: input.scope,
    archive: env.ARCHIVE,
    now: input.receivedAt,
  });
  if (!workspace.ok)
    return { ok: false, error: { code: workspace.error.code } };
  const placed = await ensureCaseProject({
    scope: input.scope,
    caseId: caseId.value,
    origin: "email",
    now: input.receivedAt,
  });
  if (!placed.ok) return { ok: false, error: { code: placed.error.code } };
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const caseActor = await resolveActiveCaseActor({
    env: env,
    namespace: env.CASE,
    organisationId: organisationId.value,
    caseId: caseId.value,
    now: input.receivedAt,
  });
  if (!caseActor.ok)
    return { ok: false, error: { code: caseActor.error.code } };
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const ensured = await caseActor.value.ensure({
    identity: { organisationId: organisationId.value, caseId: caseId.value },
    purpose: `Email thread ${input.gmailThreadId}`,
    workspaceRevision: workspace.value.revision,
    lifecycle: { kind: "open", openedAt: input.receivedAt },
  });
  if (!ensured.ok) return { ok: false, error: { code: ensured.error.code } };
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const connectorId = gmailConnectorIdValue(input.integrationAccountId);
  const triggered = await caseActor.value.acceptTrigger({
    triggerId: `trigger_email_${newest}`,
    caseId: caseId.value,
    source: {
      kind: "connector",
      connectorId,
      ingressId: `email_${input.gmailThreadId}_${newest}`,
    },
    requestAuthority: authority,
    content: { kind: "text", text: emailTriggerManifest(input) },
    acceptedAt: input.receivedAt,
    attachments: [],
    ...subjectTitle(input.subject),
  });
  if (!triggered.ok)
    return { ok: false, error: { code: triggered.error.code } };
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const bound = await caseActor.value.attachBinding({
    bindingId: `binding_${caseId.value}`,
    caseId: caseId.value,
    connectorId,
    address: {
      kind: "email_thread",
      integrationAccountId: input.integrationAccountId,
      gmailThreadId: input.gmailThreadId,
    },
  });
  if (!bound.ok) return { ok: false, error: { code: bound.error.code } };
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  return { ok: true, value: { kind: triggered.value.kind } };
}

/** The thread's subject as the Case title: one line, at most 120 characters. */
function subjectTitle(subject: string | null): Readonly<{ title?: string }> {
  const line = subject?.replace(/\s+/gu, " ").trim() ?? "";
  if (line.length === 0) return {};
  return { title: line.length > 120 ? `${line.slice(0, 119)}…` : line };
}

function emailTriggerManifest(input: EmailCaseAdmissionInput): string {
  return [
    "New Gmail Inbox messages were admitted to this Case.",
    `Thread: ${input.gmailThreadId}`,
    `Messages (oldest first): ${input.messageIds.join(", ")}`,
    "Read exact message content through the trusted email tools.",
  ].join("\n");
}
