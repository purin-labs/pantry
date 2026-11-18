/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  attachmentObjectReachable,
  collectMessageAttachments,
} from "../src/messages/attachment-reachability";
import { requireOrganisationId } from "./test-ids";

const ORGANISATION = requireOrganisationId("organisation_reach");
const LIVE = "a".repeat(64);
const DEAD = "b".repeat(64);

describe("attachment reachability", function reachabilitySuite() {
  it("treats a derived object as reachable exactly when its source is", function derivedFollowsSource() {
    const reachable = new Set([`attachments/${ORGANISATION}/slack/${LIVE}`]);

    expect(
      attachmentObjectReachable(
        { key: `attachments/${ORGANISATION}/slack/${LIVE}` },
        ORGANISATION,
        reachable,
      ),
    ).toBe(true);
    expect(
      attachmentObjectReachable(
        {
          key: `attachments/${ORGANISATION}/derived/${LIVE}/plan37.frames.v1/0.jpg`,
        },
        ORGANISATION,
        reachable,
      ),
    ).toBe(true);
    expect(
      attachmentObjectReachable(
        { key: `attachments/${ORGANISATION}/slack/${DEAD}` },
        ORGANISATION,
        reachable,
      ),
    ).toBe(false);
    expect(
      attachmentObjectReachable(
        {
          key: `attachments/${ORGANISATION}/derived/${DEAD}/plan37.frames.v1/0.jpg`,
        },
        ORGANISATION,
        reachable,
      ),
    ).toBe(false);
  });

  it("follows a Slack source pointer to its content, and keeps one it cannot read", function pointerFollowsContent() {
    const reachable = new Set([`attachments/${ORGANISATION}/slack/${LIVE}`]);
    const pointer = `attachments/${ORGANISATION}/slackref/${"c".repeat(64)}`;

    expect(
      attachmentObjectReachable(
        {
          key: pointer,
          customMetadata: {
            contentKey: `attachments/${ORGANISATION}/slack/${LIVE}`,
          },
        },
        ORGANISATION,
        reachable,
      ),
    ).toBe(true);
    expect(
      attachmentObjectReachable(
        {
          key: pointer,
          customMetadata: {
            contentKey: `attachments/${ORGANISATION}/slack/${DEAD}`,
          },
        },
        ORGANISATION,
        reachable,
      ),
    ).toBe(false);
    // No metadata is no proof of anything; the pointer stays.
    expect(
      attachmentObjectReachable({ key: pointer }, ORGANISATION, reachable),
    ).toBe(true);
    // Staging is never reachable by reference.
    expect(
      attachmentObjectReachable(
        { key: `attachments/${ORGANISATION}/staging/abc` },
        ORGANISATION,
        reachable,
      ),
    ).toBe(false);
  });

  it("keeps anything uploaded inside the grace window", async function keepsRecent() {
    const now = 1_700_000_000_000;
    const bucket = new ListingBucket(
      [
        `attachments/${ORGANISATION}/staging/in-flight`,
        `attachments/${ORGANISATION}/staging/abandoned`,
        `attachments/${ORGANISATION}/staging/upload-time-unavailable`,
      ],
      10,
      {
        uploadedAt: new Map([
          [`attachments/${ORGANISATION}/staging/in-flight`, now - 1_000],
          [
            `attachments/${ORGANISATION}/staging/abandoned`,
            now - 3 * 24 * 60 * 60 * 1_000,
          ],
        ]),
      },
    );

    const receipt = await collectMessageAttachments({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      reachableSourceKeys: [],
      retainUploadedAfter: now - 24 * 60 * 60 * 1_000,
      now,
    });

    expect(receipt).toMatchObject({
      ok: true,
      value: {
        retained: 2,
        deleted: [`attachments/${ORGANISATION}/staging/abandoned`],
      },
    });
  });

  it("deletes only what no message names and receipts every deletion", async function collects() {
    const bucket = new ListingBucket(
      [
        `attachments/${ORGANISATION}/slack/${LIVE}`,
        `attachments/${ORGANISATION}/derived/${LIVE}/plan37.frames.v1/0.jpg`,
        `attachments/${ORGANISATION}/derived/${LIVE}/plan37.frames.v1/manifest.json`,
        `attachments/${ORGANISATION}/slack/${DEAD}`,
        `attachments/${ORGANISATION}/derived/${DEAD}/plan37.frames.v1/0.jpg`,
      ],
      2,
    );

    const receipt = await collectMessageAttachments({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      reachableSourceKeys: [`attachments/${ORGANISATION}/slack/${LIVE}`],
      now: 1_700_000_000,
    });

    expect(receipt).toEqual({
      ok: true,
      value: {
        schemaVersion: "plan37.attachment-collection.v1",
        organisationId: ORGANISATION,
        scanned: 5,
        retained: 3,
        deleted: [
          `attachments/${ORGANISATION}/slack/${DEAD}`,
          `attachments/${ORGANISATION}/derived/${DEAD}/plan37.frames.v1/0.jpg`,
        ],
        collectedAt: 1_700_000_000,
      },
    });
    expect(bucket.keys()).toEqual([
      `attachments/${ORGANISATION}/derived/${LIVE}/plan37.frames.v1/0.jpg`,
      `attachments/${ORGANISATION}/derived/${LIVE}/plan37.frames.v1/manifest.json`,
      `attachments/${ORGANISATION}/slack/${LIVE}`,
    ]);
  });

  it("deletes nothing when the listing cannot be completed", async function refusesPartial() {
    const bucket = new ListingBucket(
      [
        `attachments/${ORGANISATION}/slack/${DEAD}`,
        `attachments/${ORGANISATION}/slack/${LIVE}`,
      ],
      1,
      { stallCursor: true },
    );

    const receipt = await collectMessageAttachments({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      reachableSourceKeys: [],
      now: 1,
    });

    expect(receipt).toEqual({
      ok: false,
      error: { code: "attachment_collection_listing_stalled" },
    });
    expect(bucket.keys()).toHaveLength(2);
  });
});

/** A bucket that lists in pages, so the cursor loop is exercised. */
class ListingBucket {
  private readonly objects: Set<string>;

  constructor(
    keys: readonly string[],
    private readonly pageSize: number,
    private readonly options: {
      readonly stallCursor?: boolean;
      readonly uploadedAt?: ReadonlyMap<string, number>;
    } = {},
  ) {
    this.objects = new Set(keys);
  }

  binding(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  keys(): readonly string[] {
    return [...this.objects].sort();
  }

  async list(input: {
    readonly prefix: string;
    readonly cursor?: string;
  }): Promise<unknown> {
    const all = [...this.objects].filter(function underPrefix(key) {
      return key.startsWith(input.prefix);
    });
    const start = input.cursor === undefined ? 0 : Number(input.cursor);
    const page = all.slice(start, start + this.pageSize);
    const truncated = start + this.pageSize < all.length;

    const uploadedAt = this.options.uploadedAt;

    return {
      objects: page.map(function asObject(key) {
        const at = uploadedAt?.get(key);
        return at === undefined ? { key } : { key, uploaded: new Date(at) };
      }),
      truncated,
      cursor: truncated
        ? this.options.stallCursor === true
          ? input.cursor
          : String(start + this.pageSize)
        : undefined,
    };
  }

  async delete(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.objects.delete(key);
    }
  }
}
