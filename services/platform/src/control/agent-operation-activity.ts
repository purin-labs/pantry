import { readActiveCaseOperations } from "../actors/case-operations";
import { requireActiveOrganisationActor } from "../actors/actor-router";
import type { ActionLedgerActivity } from "../actors/action-ledger";
import type { OrganisationDO } from "../actors/organisation";
import type { AgentOperationsSnapshot } from "../data/agent-operations";
import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import { readCommerceExceptionInbox } from "../commerce/operations-workbench";
import type { CommerceExceptionInbox } from "@seams/control-api";

export type AgentOperationsWithActivity = AgentOperationsSnapshot & {
  readonly actionLedger: readonly ActionLedgerActivity[];
  readonly commerceExceptions: CommerceExceptionInbox;
};

export async function readAgentOperationsWithActivity(
  env: Env,
  organisationId: OrganisationId,
  operations: AgentOperationsSnapshot,
): Promise<AgentOperationsWithActivity | null> {
  const now = Date.now();
  let organisation: Awaited<ReturnType<typeof requireActiveOrganisationActor>>;
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

export async function readAgentOperationsWithActivityFromOrganisation(
  env: Env,
  organisationId: OrganisationId,
  operations: AgentOperationsSnapshot,
  organisation: DurableObjectStub<OrganisationDO>,
): Promise<AgentOperationsWithActivity | null> {
  const now = Date.now();
  const activity = await readRecentActionActivity(organisation, organisationId);
  const activeCases = await readActiveCaseOperations({
    env,
    organisationId,
    now,
  });
  const commerceExceptions = await readCommerceExceptionInbox(
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
  ReturnType<DurableObjectStub<OrganisationDO>["readActionActivity"]>
>;

function readRecentActionActivity(
  organisation: DurableObjectStub<OrganisationDO>,
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
  organisation: DurableObjectStub<OrganisationDO>,
  organisationId: OrganisationId,
): Promise<readonly ActionLedgerActivity[]> {
  return commerceActionLedger(
    await readRecentActionActivity(organisation, organisationId),
  );
}

function isCommerceActivity(item: ActionLedgerActivity): boolean {
  return item.action.host === "satyr.commerce";
}
