import { readActiveCaseOperations } from "../actors/case-operations";
import { requireActiveOrganisationActor } from "../actors/actor-router";
import {
  isCommerceLedgerAction,
  type ActionLedgerActivity,
} from "../actors/action-ledger";
import type { AgentOperationsSnapshot } from "../data/agent-operations";
import type { Env, OrganisationActorStub } from "../env";
import type { OrganisationId } from "../ids";
import { definePort } from "../port";
import type { CommerceExceptionInbox } from "@purin-labs/control-api";

/**
 * The commerce exceptions of an Organisation, which the agent operations
 * page shows beside its agents. Commerce reads them, and the Worker registers
 * the reader (`worker-ports.ts`).
 */
export const commerceExceptionInbox = definePort<
  (env: Env, organisationId: OrganisationId) => Promise<CommerceExceptionInbox>
>("commerce_exception_inbox");

type AgentOperationsWithActivity = AgentOperationsSnapshot & {
  readonly actionLedger: readonly ActionLedgerActivity[];
  readonly commerceExceptions: CommerceExceptionInbox;
};

export async function readAgentOperationsWithActivity(
  env: Env,
  organisationId: OrganisationId,
  operations: AgentOperationsSnapshot,
): Promise<AgentOperationsWithActivity | null> {
  const now = Date.now();
  let organisation: OrganisationActorStub;
  try {
    organisation = await requireActiveOrganisationActor({
      env,
      organisationId,
      now,
    });
  } catch {
    return null;
  }
  return readAgentOperationsWithActivityFromOrganisation(
    env,
    organisationId,
    operations,
    organisation,
  );
}

async function readAgentOperationsWithActivityFromOrganisation(
  env: Env,
  organisationId: OrganisationId,
  operations: AgentOperationsSnapshot,
  organisation: OrganisationActorStub,
): Promise<AgentOperationsWithActivity | null> {
  const now = Date.now();
  const activity = await readRecentActionActivity(organisation, organisationId);
  const activeCases = await readActiveCaseOperations({
    env,
    organisationId,
    now,
  });
  const commerceExceptions = await commerceExceptionInbox.use()(
    env,
    organisationId,
  );
  return {
    ...operations,
    // Activity is supplemental; unreadable legacy state must not hide agent configuration.
    activeCases: activeCases.ok ? activeCases.value : [],
    actionLedger: commerceActionLedger(activity),
    commerceExceptions,
  };
}

type RecentActionActivity = Awaited<
  ReturnType<OrganisationActorStub["readActionActivity"]>
>;

function readRecentActionActivity(
  organisation: OrganisationActorStub,
  organisationId: OrganisationId,
): Promise<RecentActionActivity> {
  return organisation.readActionActivity({
    organisationId,
    resourceKey: null,
    limit: 50,
  });
}

function commerceActionLedger(
  activity: RecentActionActivity,
): readonly ActionLedgerActivity[] {
  // Activity is supplemental; unreadable legacy state must not hide the rest.
  return activity.ok ? activity.value.filter(isCommerceActivity) : [];
}

/** The commerce actions of the ledger alone, for a page that shows only them. */
export async function readCommerceActionLedger(
  organisation: OrganisationActorStub,
  organisationId: OrganisationId,
): Promise<readonly ActionLedgerActivity[]> {
  return commerceActionLedger(
    await readRecentActionActivity(organisation, organisationId),
  );
}

function isCommerceActivity(item: ActionLedgerActivity): boolean {
  return isCommerceLedgerAction(item.action);
}
