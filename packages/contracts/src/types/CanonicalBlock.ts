import type { BlockOrigin } from "./BlockOrigin";
import type { CanonicalBody } from "./CanonicalBody";
import type { Hlc } from "./Hlc";

export type CanonicalBlock = {
  blockId: string;
  threadId: string;
  author: string;
  origin: BlockOrigin;
  hlc: Hlc;
  contentHash: string;
  body: CanonicalBody;
  version: number;
  deleted: boolean;
};
