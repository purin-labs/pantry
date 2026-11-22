import type { RequestAuthority } from "@purin-labs/contracts";
import { isProjectId, isUserId } from "@purin-labs/control-api";
import { selectActiveGrants } from "@purin-labs/authority/authorization/access-grants/compiler";
import { listAccessGrants } from "@purin-labs/authority/data/access-grants";
import type { Env } from "@purin-labs/kernel/env";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { memoryService } from "@purin-labs/area-brain/server/memory/contract/memory-service";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  createCurrentObservedSourceFlowLabel,
  evaluateFlowLabelSink,
} from "@purin-labs/authority/policy/index";
import { digestCanonical } from "@purin-labs/authority/policy/information-flow/digest";
import { authorizeProject } from "@purin-labs/conversation/projects/access";
import { validateLiveRequestAuthority } from "@purin-labs/authority/request-authority/index";
import type { Result } from "@purin-labs/kernel/result";
import type { EmailChatContext, EmailChatSource } from "./reply-sources";
import type { Variant } from "@purin-labs/type-utils";

/** The resource scope of every commerce grant (`integrationResourceScopeForGrant`). */
const COMMERCE_READ_SCOPE_PREFIX = "commerce_read:";

const NO_CHAT_CONTEXT: EmailChatContext = { memory: [], projects: [] };

type EmailChatSourceError = Readonly<{
  code: "email_commerce_unavailable" | "email_source_unavailable";
}>;

/**
 * Whether this person may be shown what a Portal chat read before it
 * drafted a reply. For every connector, file and commerce source the person
 * needs their own grant to it, and the label that their grants derive must
 * reach them. Every Memory that the chat's context showed must be one that
 * they may inspect in full, at a revision that it still holds, and every
 * Project one that they may read. A refused commerce source answers
 * `email_commerce_unavailable`; anything else that is refused answers
 * `email_source_unavailable`.
 */
export async function authorizeEmailChatSourceDelivery(
  env: Env,
  authority: Variant<RequestAuthority, "control">,
  sources: readonly EmailChatSource[],
  context: EmailChatContext = NO_CHAT_CONTEXT,
): Promise<Result<null, EmailChatSourceError>> {
  if (
    sources.length === 0 &&
    context.memory.length === 0 &&
    context.projects.length === 0
  )
    return { ok: true, value: null };
  const [first] = sources;
  const organisationId = parseOrganisationId(authority.organisationId);
  if (!organisationId.ok || !isUserId(authority.userId)) return refused(first);
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) return refused(first);
  const disclosureEvidenceId = await digestCanonical(
    context === NO_CHAT_CONTEXT ? sources : { sources, context },
  );
  if (
    !(
      await validateLiveRequestAuthority({
        db: execution.value.database,
        accountAccess: execution.value.accountAccess,
        userAuthority: { kind: "disclosure_recipient", disclosureEvidenceId },
        action: "disclose",
        authority,
      })
    ).ok
  )
    return refused(first);
  if (sources.length > 0) {
    const grants = await listAccessGrants({
      db: execution.value.database,
      organisationId: organisationId.value,
      lifecycle: "active",
    });
    if (!grants.ok) return refused(first);
    const selected = selectActiveGrants({
      organisationId: organisationId.value,
      authority,
      grants: grants.value,
    });
    if (!selected.ok) return refused(first);
    for (const source of sources) {
      // The label comes from the person's own grants to the same source.
      const label = await createCurrentObservedSourceFlowLabel(
        execution.value.database,
        {
          kind: "integration_resource",
          organisationId: organisationId.value,
          integrationAccountId: source.integrationAccountId,
          resourceScope: source.resourceScope,
        },
        selected.value,
      );
      if (
        !label.ok ||
        evaluateFlowLabelSink({
          flowLabel: label.value,
          organisationAuthz: null,
          sink: {
            kind: "conversation_delivery",
            destinationAuthority: authority,
          },
        }).kind !== "allow"
      )
        return refused(source);
    }
  }
  const person = {
    organisationId: organisationId.value,
    userId: authority.userId,
  };
  for (const projectId of context.projects) {
    if (
      !isProjectId(projectId) ||
      (await authorizeProject(
        execution.value.database,
        person,
        projectId,
        "read",
      )) === null
    )
      return refused(undefined);
  }
  if (context.memory.length === 0) return { ok: true, value: null };
  // A Memory with anything hidden from this person is absent from their
  // views, as one that no longer exists is.
  const views = await memoryService.use().readMemoryViews(
    env,
    {
      ...person,
      accountAuthority: { kind: "disclosure_recipient", disclosureEvidenceId },
    },
    execution.value,
  );
  if (!views.ok) return refused(undefined);
  for (const shown of context.memory) {
    const view = views.value.find((one) => one.memoryId === shown.memoryId);
    if (
      view === undefined ||
      !view.revisions.some((revision) => revision.revision === shown.revision)
    )
      return refused(undefined);
  }
  return { ok: true, value: null };
}

function refused(
  source: EmailChatSource | undefined,
): Result<never, EmailChatSourceError> {
  return {
    ok: false,
    error: {
      code:
        source?.resourceScope.startsWith(COMMERCE_READ_SCOPE_PREFIX) === true
          ? "email_commerce_unavailable"
          : "email_source_unavailable",
    },
  };
}
