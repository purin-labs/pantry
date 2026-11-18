import type { SurfaceKind } from "./SurfaceKind";

export type SurfaceRef = {
  kind: SurfaceKind;
  workspaceId: string;
  channelId: string;
  threadKey: string;
};
