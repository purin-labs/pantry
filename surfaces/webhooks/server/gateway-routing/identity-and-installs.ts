import type { GatewayIdentityRoute } from "./domain";

export function matchIdentityRoute(
  pathname: string,
): GatewayIdentityRoute | null {
  const segments = pathname.split("/");
  if (segments[0] !== "" || segments[1] !== "v1") {
    return null;
  }

  if (segments[2] === "identity-links") {
    return matchIdentityLinkRoute(segments);
  }

  if (segments.length === 5 && segments[2] === "installs") {
    const surfaceKindRaw = segments[3];
    const workspaceIdRaw = segments[4];
    if (surfaceKindRaw === undefined || workspaceIdRaw === undefined) {
      return null;
    }
    return { kind: "resolveInstall", surfaceKindRaw, workspaceIdRaw };
  }

  if (segments[2] !== "organisations") {
    return null;
  }

  const organisationIdRaw = segments[3];
  if (organisationIdRaw === undefined) {
    return null;
  }

  if (segments.length === 5 && segments[4] === "ping") {
    return { kind: "organisationPing", organisationIdRaw };
  }

  if (
    segments.length === 6 &&
    segments[4] === "onboarding" &&
    segments[5] === "activation-acceptance"
  ) {
    return { kind: "onboardingActivationAcceptance", organisationIdRaw };
  }

  return null;
}

function matchIdentityLinkRoute(
  segments: readonly string[],
): GatewayIdentityRoute | null {
  const tokenRaw = segments[3];
  if (tokenRaw === undefined) {
    return null;
  }

  if (segments.length === 4) {
    return { kind: "identityLinkChallenge", tokenRaw };
  }

  if (segments.length === 5 && segments[4] === "complete") {
    return { kind: "completeIdentityLink", tokenRaw };
  }

  return null;
}
