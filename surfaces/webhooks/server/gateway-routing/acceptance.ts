import type { GatewayAcceptanceRoute } from "./domain";

export function matchAcceptanceRoute(
  pathname: string,
): GatewayAcceptanceRoute | null {
  const segments = pathname.split("/");
  if (segments[0] !== "" || segments[1] !== "v1") {
    return null;
  }

  if (
    segments.length === 6 &&
    segments[2] === "acceptance" &&
    segments[3] === "organisations" &&
    segments[5] === "cafe-commerce-fault"
  ) {
    const organisationIdRaw = segments[4];
    if (organisationIdRaw === undefined) {
      return null;
    }
    return { kind: "cafeCommerceAcceptance", organisationIdRaw };
  }

  return null;
}
