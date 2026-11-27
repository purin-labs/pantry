import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { BakeryBrowserBinding } from "@purin-labs/bakery-model/bakery-context";
import type {
  BakerySurfaceAttachmentV1,
  BakerySurfaceEffectV1,
  BakerySurfaceReceiptV1,
} from "@purin-labs/bakery-model/bakery-surface";

/** One step of a Kitchen effect in the chat timeline of a turn. */
export type BakerySurfaceTimelineEvent = Readonly<{
  sequence: number;
  requestId: string;
  sessionId: string;
  turnId: string;
  createdAt: number;
  effect: BakerySurfaceEffectV1;
  terminal:
    | Readonly<{ kind: "started" }>
    | Readonly<{ kind: "settled"; receipt: BakerySurfaceReceiptV1 }>
    | Readonly<{ kind: "indeterminate" }>;
}>;

/** A Kitchen effect that waits for the browser of its user. */
export type PendingBakerySurfaceEffect = Readonly<{
  effect: BakerySurfaceEffectV1;
}>;

/**
 * The reads of the Kitchen effect records that the Portal chat makes. The
 * Kitchen area owns the delivery and the timeline tables, and the Worker
 * registers the implementation (`worker-ports.ts`).
 */
export type BakerySurfaceReads = Readonly<{
  /** The effects that the browser of the user must run now. */
  listPendingEffects(input: {
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly userId: string;
    readonly browserBinding: BakeryBrowserBinding;
    readonly now?: number;
  }): Promise<readonly PendingBakerySurfaceEffect[]>;
  /** The timeline steps of the requests after a sequence number. */
  listTimelineEvents(input: {
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly userId: string;
    readonly requestIds: readonly string[];
    readonly afterSequence: number;
  }): Promise<readonly BakerySurfaceTimelineEvent[]>;
  /** The last Kitchen surface that an earlier session of the requests saw. */
  readLatestSurfaceOfRequests(input: {
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly userId: string;
    readonly requestIds: readonly string[];
    readonly currentSessionId: string;
  }): Promise<BakerySurfaceAttachmentV1 | null>;
  /** The session that waits for the receipt of an effect. */
  readDeliveryTarget(input: {
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly userId: string;
    readonly effectId: string;
  }): Promise<{ readonly sessionId: string } | null>;
}>;

export const bakerySurfaceReads = definePort<BakerySurfaceReads>(
  "bakery_surface_reads",
);
