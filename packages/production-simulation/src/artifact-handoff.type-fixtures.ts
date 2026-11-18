import type { HostRequest } from "./execution-host.ts";

// @ts-expect-error Artifact transfer requires an explicit acknowledgement state.
export const missingAcknowledgement: HostRequest = { kind: "artifact" };
export const numericAcknowledgement: HostRequest = {
  kind: "artifact",
  // @ts-expect-error A transfer acknowledgement names a digest, never a sequence number.
  acknowledged: 1,
};
