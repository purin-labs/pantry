import type { BillingView } from "@purin-labs/control-api/portal/billing";
import { defineToolFamily } from "@purin-labs/agent-tools/define-tool";
import { ToolRequestError } from "@purin-labs/agent-tools/errors";
import type { PreparedEffect } from "@purin-labs/agent-tools/tool-effect";

/** The logo change that the agent asks for. */
export type LogoChangeRequest = Readonly<{
  subject: "organisation" | "workspace";
  /** Null for the organisation itself. */
  workspaceId: string | null;
  /** The one image of the current message, or no logo. */
  logo: "attached_image" | "remove";
}>;

/** A logo change that was refused, in words that the agent can act on. */
export class LogoRequestError extends ToolRequestError {}

/** A billing read that was refused, in words that the agent can act on. */
export class BillingRequestError extends ToolRequestError {}

/** What a turn gives to the organisation tools. */
export type OrganisationToolServices = {
  readonly changeLogo: (
    request: LogoChangeRequest,
    operationId: string,
  ) => Promise<PreparedEffect>;
  /** The billing state, as Settings › Billing shows it (Plan 95 step 6). */
  readonly readBillingAccount: () => Promise<BillingView>;
};

export const defineOrganisationTool =
  defineToolFamily<OrganisationToolServices>()("organisation");
