import { withToolContext } from "@purin-labs/agent/agent-tools/context";
import type { ToolTurnContext } from "@purin-labs/agent/actors/session/tool-wiring";
import { readBillingAccountForEmbeddedHarness } from "./billing-handlers";
import { changeLogoForEmbeddedHarness } from "./logo-handlers";
import type { OrganisationToolServices } from "./services";

/** What the Organisation area gives to one turn: the logo change and the billing read. */
export function organisationToolServices(
  turn: ToolTurnContext,
): OrganisationToolServices {
  return {
    changeLogo: (request) => changeLogoForEmbeddedHarness(turn, request),
    readBillingAccount: withToolContext(turn)(
      readBillingAccountForEmbeddedHarness,
    ),
  };
}
