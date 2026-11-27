import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { MenuBoardOrganisationActor } from "@purin-labs/area-cafe-contract/server/menu-board-commands";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";

/**
 * Tells the shop's screens to read their feed again after a committed
 * change. A lost signal costs the screens their next timed read, so a
 * failure to reach the Organisation Actor or to signal is ignored.
 */
export async function signalShopScreens(
  env: Env,
  organisationId: OrganisationId,
): Promise<void> {
  const organisation =
    await requireActiveOrganisationActor<MenuBoardOrganisationActor>({
      env,
      organisationId,
      now: Date.now(),
    }).catch(ignoreFailure);
  await organisation
    ?.signalMenuScreens({ organisationId })
    .catch(ignoreFailure);
}

function ignoreFailure(): null {
  return null;
}
