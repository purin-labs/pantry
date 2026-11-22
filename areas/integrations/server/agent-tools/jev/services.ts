import type {
  JevFeatureCommand,
  JevFeaturesView,
} from "@purin-labs/control-api/portal/jev-features";
import { defineToolFamily } from "@purin-labs/agent-tools/define-tool";
import { ToolRequestError } from "@purin-labs/agent-tools/errors";

/** The Jev settings, as Settings › Jev shows them (Plan 88). */
type JevFeaturesReadTool = () => Promise<JevFeaturesView>;

/** Turns one Jev switch on or off, after a person approves the card. */
type JevFeatureProposeTool = (request: JevFeatureCommand) => Promise<unknown>;

/** A Jev request that was refused, in words that the agent can act on. */
export class JevFeatureRequestError extends ToolRequestError {}

/** What a turn gives to the Jev settings tools. */
export type JevToolServices = {
  readonly readJevFeatures: JevFeaturesReadTool;
  readonly proposeJevFeature: JevFeatureProposeTool;
};

export const defineJevTool = defineToolFamily<JevToolServices>()("jev");
