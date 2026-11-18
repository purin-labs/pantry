import type { OrganisationEnvironment } from "../data/control-plane";
import { parseSlackAppId, type SlackAppId } from "../ids";
import type { Result } from "../result";

export type SlackInstallationIdentity = {
  readonly environment: OrganisationEnvironment;
  readonly appId: SlackAppId;
};

type SlackInstallationIdentityError = {
  readonly code: "slack_installation_identity_unconfigured";
};

export function resolveConfiguredSlackInstallationIdentity(input: {
  readonly deploymentProfile: string | undefined;
  readonly appId: string | undefined;
}): Result<SlackInstallationIdentity, SlackInstallationIdentityError> {
  const appId = parseSlackAppId(input.appId ?? "");
  const environment = deploymentSlackEnvironment(input.deploymentProfile);
  return appId.ok && environment !== null
    ? { ok: true, value: { appId: appId.value, environment } }
    : {
        ok: false,
        error: { code: "slack_installation_identity_unconfigured" },
      };
}

function deploymentSlackEnvironment(
  deploymentProfile: string | undefined,
): OrganisationEnvironment | null {
  switch (deploymentProfile) {
    case "local":
      return "development";
    case "production":
      return "production";
    default:
      return null;
  }
}
