import type { ToolTurnContext } from "@purin-labs/agent/actors/session/tool-wiring";
import { changeLogoForEmbeddedHarness } from "./logo-handlers";
import type { OrganisationToolServices } from "./logo";

/** What the Organisation area gives to one turn: the logo change. */
export function organisationToolServices(
  turn: ToolTurnContext,
): OrganisationToolServices {
  return {
    changeLogo: (request) => changeLogoForEmbeddedHarness(turn, request),
  };
}
