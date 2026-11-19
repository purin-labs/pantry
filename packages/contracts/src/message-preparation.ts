import type { MessageAttachmentPreparationStateValue as GeneratedMessageAttachmentPreparationState } from "./attachment-preparation.ts";
import type { StrictUnion } from "@purin-labs/type-utils";

/**
 * Keeps pending and completed preparation fields exclusive for object-literal
 * construction and broad spreads at the TypeScript boundary.
 */
export type MessageAttachmentPreparationState =
  StrictUnion<GeneratedMessageAttachmentPreparationState>;
