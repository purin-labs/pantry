import type { StoredMessageAttachment } from "@purin-labs/contracts";

import { derivedSourceSha256 } from "./derived-stills";
import type { OrganisationId } from "../ids";

/**
 * Attachment reachability and collection.
 *
 * An attachment object is reachable when some live message still names it:
 * a Case trigger, or a Session turn. Everything else under the organisation's
 * prefix follows from those source keys:
 *
 * - a derived object (a decoded still) is reachable exactly when its source
 *   is — it carries the source digest in its key, so no index is needed;
 * - a Slack source pointer (`slackref/`) is reachable exactly when the content
 *   key it points at is, read from its metadata; a pointer whose metadata
 *   cannot be read is kept, because deletion needs proof and absence is none;
 * - a staging object is never reachable by reference. The grace window is
 *   what protects an in-flight batch.
 *
 * The collector lists the organisation's prefix, keeps every reachable key and
 * every object uploaded inside the grace window, deletes the rest, and returns
 * a receipt naming what it deleted. It never deletes on a partial listing: a
 * cursor that fails to advance aborts the pass, and the receipt says so. If a
 * delete call fails, the error retains the completed batches and the batch
 * whose result is uncertain.
 */

const ATTACHMENT_COLLECTION_RECEIPT_SCHEMA = "plan37.attachment-collection.v1";

export type AttachmentCollectionReceipt = {
  readonly schemaVersion: typeof ATTACHMENT_COLLECTION_RECEIPT_SCHEMA;
  readonly organisationId: OrganisationId;
  readonly scanned: number;
  readonly retained: number;
  readonly deleted: readonly string[];
  readonly collectedAt: number;
};

export type AttachmentCollectionUncertainReceipt = {
  readonly schemaVersion: typeof ATTACHMENT_COLLECTION_RECEIPT_SCHEMA;
  readonly organisationId: OrganisationId;
  readonly scanned: number;
  readonly retained: number;
  /** Keys deleted by batches whose calls completed successfully. */
  readonly deleted: readonly string[];
  /** Keys in the batch whose deletion result could not be established. */
  readonly uncertain: readonly string[];
  /** Candidate keys after the failed batch; no delete call was made for them. */
  readonly notAttempted: readonly string[];
  readonly collectedAt: number;
};

export type AttachmentCollectionError =
  | { readonly code: "attachment_collection_listing_stalled" }
  | { readonly code: "attachment_collection_failed"; readonly reason: string }
  | {
      readonly code: "attachment_collection_deletion_uncertain";
      readonly reason: string;
      readonly receipt: AttachmentCollectionUncertainReceipt;
    };

/** What the collector needs to know about one listed object. */
type ListedAttachmentObject = {
  readonly key: string;
  readonly uploaded?: Date;
  readonly customMetadata?: Record<string, string>;
};

/** The reachable key set implied by a message's attachments. */
export function reachableAttachmentObjectKeys(
  attachments: readonly StoredMessageAttachment[],
): readonly string[] {
  return attachments.map(function keyOf(attachment) {
    return String(attachment.objectKey);
  });
}

/** Whether one stored object is reachable from a set of reachable source keys. */
export function attachmentObjectReachable(
  object: ListedAttachmentObject,
  organisationId: OrganisationId,
  reachableSourceKeys: ReadonlySet<string>,
): boolean {
  if (reachableSourceKeys.has(object.key)) {
    return true;
  }

  const sourceSha256 = derivedSourceSha256(object.key, organisationId);

  if (sourceSha256 !== null) {
    // A derived object is reachable iff a reachable source shares its digest.
    for (const key of reachableSourceKeys) {
      if (key.endsWith(`/${sourceSha256}`)) {
        return true;
      }
    }

    return false;
  }

  if (object.key.startsWith(`attachments/${organisationId}/slackref/`)) {
    const contentKey = object.customMetadata?.contentKey;

    return (
      typeof contentKey !== "string" || reachableSourceKeys.has(contentKey)
    );
  }

  return false;
}

export async function collectMessageAttachments(input: {
  readonly archive: R2Bucket;
  readonly organisationId: OrganisationId;
  readonly reachableSourceKeys: readonly string[];
  /** Objects uploaded after this instant are kept whatever they reference. */
  readonly retainUploadedAfter?: number;
  readonly now: number;
}): Promise<
  | { readonly ok: true; readonly value: AttachmentCollectionReceipt }
  | { readonly ok: false; readonly error: AttachmentCollectionError }
> {
  const prefix = `attachments/${input.organisationId}/`;
  const reachable = new Set(input.reachableSourceKeys);
  const unreachable: string[] = [];
  let scanned = 0;
  let cursor: string | undefined;

  try {
    // The whole prefix is listed before anything is deleted, so an abort
    // part-way leaves every object where it was.
    while (true) {
      const page = await input.archive.list({
        prefix,
        cursor,
        limit: 1_000,
        include: ["customMetadata"],
      });

      for (const object of page.objects) {
        scanned += 1;

        if (insideGrace(object, input.retainUploadedAfter)) {
          continue;
        }

        if (
          !attachmentObjectReachable(object, input.organisationId, reachable)
        ) {
          unreachable.push(object.key);
        }
      }

      if (!page.truncated) {
        break;
      }

      if (page.cursor === undefined || page.cursor === cursor) {
        return {
          ok: false,
          error: { code: "attachment_collection_listing_stalled" },
        };
      }

      cursor = page.cursor;
    }

    const deleted: string[] = [];

    for (let offset = 0; offset < unreachable.length; offset += 1_000) {
      const batch = unreachable.slice(offset, offset + 1_000);

      try {
        await input.archive.delete(batch);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "attachment_collection_deletion_uncertain",
            reason: error instanceof Error ? error.message : "unknown",
            receipt: {
              schemaVersion: ATTACHMENT_COLLECTION_RECEIPT_SCHEMA,
              organisationId: input.organisationId,
              scanned,
              retained: scanned - unreachable.length,
              deleted,
              uncertain: batch,
              notAttempted: unreachable.slice(offset + batch.length),
              collectedAt: input.now,
            },
          },
        };
      }

      deleted.push(...batch);
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "attachment_collection_failed",
        reason: error instanceof Error ? error.message : "unknown",
      },
    };
  }

  return {
    ok: true,
    value: {
      schemaVersion: ATTACHMENT_COLLECTION_RECEIPT_SCHEMA,
      organisationId: input.organisationId,
      scanned,
      retained: scanned - unreachable.length,
      deleted: unreachable,
      collectedAt: input.now,
    },
  };
}

function insideGrace(
  object: ListedAttachmentObject,
  retainUploadedAfter: number | undefined,
): boolean {
  if (retainUploadedAfter === undefined) {
    return false;
  }

  if (object.uploaded === undefined) {
    return true;
  }

  // An object with no readable upload time is treated as recent: the cost of
  // keeping it another day is nothing, the cost of deleting a live one is not.
  const uploaded = object.uploaded.getTime();

  return Number.isNaN(uploaded) || uploaded > retainUploadedAfter;
}
