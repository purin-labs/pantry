import type { PendingGovernedAction } from "@purin-labs/control-api";
import { isCommerceLedgerAction } from "@purin-labs/authority/actors/action-ledger";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationReader } from "./authorization";

/** The most ledger entries that one read looks at. */
const ACTION_READ_LIMIT = 50;

/**
 * The ledger actions that wait for a person: the reader of the action ledger
 * for `listPendingDecisions`. The Operations page reads the same 50 newest
 * entries of the ledger. Each entry follows the rule of its own read: a
 * commerce action shows as on the Operations page, and a custom connector
 * write shows only to an owner or an admin, who decide it. An entry of
 * another kind has no read here. A ledger that does not answer gives null,
 * so the route answers 503 and not an empty list.
 */
export async function readPendingGovernedActions(
  env: Env,
  authorized: OrganisationReader,
): Promise<readonly PendingGovernedAction[] | null> {
  let activity;
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: authorized.organisationId,
      now: Date.now(),
    });
    activity = await organisation.readActionActivity({
      organisationId: authorized.organisationId,
      resourceKey: null,
      limit: ACTION_READ_LIMIT,
    });
  } catch {
    return null;
  }
  if (!activity.ok) return null;
  const decides =
    authorized.membership.role === "owner" ||
    authorized.membership.role === "admin";
  const waiting: PendingGovernedAction[] = [];
  for (const item of activity.value) {
    if (item.state !== "proposed" && item.state !== "approval_requested")
      continue;
    const visible =
      item.action.authority.kind === "custom_connector"
        ? decides
        : isCommerceLedgerAction(item.action);
    if (!visible) continue;
    waiting.push({
      kind: "governed_action",
      id: item.action.nonce.value,
      host: item.action.host,
      verb: item.action.verb,
      resourceKey: item.action.resourceKey,
      caseId: String(item.caseId),
      state: item.state,
      createdAt: item.createdAt,
    });
  }
  return waiting;
}
