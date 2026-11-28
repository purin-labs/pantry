import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { jsonSchema } from "@purin-labs/agent-tools/define-tool";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import {
  defineOrganisationTool,
  LogoRequestError,
  type LogoChangeRequest,
} from "./services";

/**
 * The owner's ··· › Change logo of the Organisations page, for the Portal
 * chat agent (Portal round 9).
 */
export const organisationLogoChange = defineOrganisationTool({
  name: "organisation_logo_change",
  description:
    "Set or remove the logo of this organisation, or of one of its workspaces, as the owner does with ··· › Change logo on the Organisations page. " +
    "logo attached_image sets the one image that the person attached to the current message: a PNG, JPEG or WebP image of 1 MB or less. logo remove takes the logo away, so that the gradient tile shows again. " +
    "subject is organisation (workspaceId null) or workspace (a workspaceId of this organisation). Only when the person asks. Only the owner can change a logo.",
  input: jsonSchema({
    type: "object",
    properties: {
      subject: { type: "string", enum: ["organisation", "workspace"] },
      workspaceId: {
        type: ["string", "null"],
        pattern: "^workspace_[A-Za-z0-9_-]{1,96}$",
      },
      logo: { type: "string", enum: ["attached_image", "remove"] },
    },
    required: ["subject", "workspaceId", "logo"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: parseLogoChangeArgs,
  effect: "receipt",
  rerun: {
    kind: "any_caller",
    reason:
      "The same image again changes nothing, and a removed logo stays removed.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.organisationLogoChange,
  },
  unavailable: "logo change is unavailable",
  prepare: ({ changeLogo }) =>
    changeLogo === undefined
      ? undefined
      : (request, call) => changeLogo(request, call.operationId),
});

function parseLogoChangeArgs(input: unknown): LogoChangeRequest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["subject", "workspaceId", "logo"]) ||
    (input.subject !== "organisation" && input.subject !== "workspace") ||
    (input.workspaceId !== null && typeof input.workspaceId !== "string") ||
    (input.logo !== "attached_image" && input.logo !== "remove")
  )
    throw new TypeError("organisation_logo_change arguments are invalid");
  if ((input.subject === "workspace") !== (input.workspaceId !== null))
    throw new LogoRequestError(
      "organisation_logo_change takes a workspaceId only with subject workspace, and needs one there. Nothing changed.",
    );
  return {
    subject: input.subject,
    workspaceId: input.workspaceId,
    logo: input.logo,
  };
}
