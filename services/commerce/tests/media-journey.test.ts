// Plan 76A step 1, product media: staff upload two images (a PNG twice, so
// one object), make media records, and give the tea one image for every
// variant plus one for each leaf. The buyer catalog lists each variant's
// images in order, and a browser fetches them without a session, with a
// revalidation. Wrong types, oversize uploads and unknown digests are
// refused. An image still shown cannot be deleted; the last record of some
// bytes removes them from the bucket. An archived product's images are no
// longer served.
// Set MEDIA_ARTIFACT_DIR to keep the run's evidence; the file repeats byte
// for byte for the same commit.
import {
  MEDIA_MAX_BYTES,
  type CommerceAdminClient,
  type CommerceMutationResultV1,
  type CommerceProductMediaItemV1,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import type { MediaStore, StoredMedia } from "../src/plugins/media/index.ts";
import {
  PRODUCT,
  StaffDesk,
  catalogFor,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  teaListings,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

// A 1×1 PNG and a 1×1 WebP.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

it(
  "uploads, orders and serves product images, and keeps bytes only while a record names them",
  { timeout: 60_000 },
  productMedia,
);

async function productMedia(): Promise<void> {
  const bucket = new MemoryBucket();
  const backend = await startBackend({ media: bucket });
  const evidence: Evidence = { merchantId };
  try {
    const { admin, buyer, fetch } = backend;
    const staff = new MediaStaff(admin);
    await staff.createTea();

    // Uploads: a PNG twice is one object; wrong or oversize bytes are refused.
    const png = await required(admin.uploadMedia(merchantId, PNG, "image/png"));
    expect(await required(admin.uploadMedia(merchantId, PNG, "image/png"))).toEqual(png);
    const webp = await required(admin.uploadMedia(merchantId, WEBP, "image/webp"));
    const refusals = {
      svg: await uploadStatus(admin, Buffer.from("<svg/>"), "image/svg+xml"),
      mislabelled: await uploadStatus(admin, WEBP, "image/png"),
      oversize: await uploadStatus(admin, Buffer.alloc(MEDIA_MAX_BYTES + 1, 0), "image/png"),
    };
    expect(refusals).toEqual({ svg: 415, mislabelled: 415, oversize: 413 });
    expect(bucket.puts).toEqual([
      `merchants/${merchantId}/media/${png.sha256}`,
      `merchants/${merchantId}/media/${webp.sha256}`,
    ]);

    // Records. A digest that was never uploaded is refused.
    expect(await staff.create("media_tin", png.sha256, "A tea tin")).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "create_media", resource: { kind: "media", id: "media_tin" } },
    });
    await staff.create("media_sencha", png.sha256, "Sencha leaves");
    await staff.create("media_hojicha", webp.sha256, "Hojicha leaves");
    await staff.create("media_unused", webp.sha256, "Not shown");
    expect(await staff.create("media_ghost", "a".repeat(64), "Ghost")).toMatchObject(
      rejectedWith({ code: "resource_not_found" }),
    );

    // The tin for every variant, then one image for each leaf.
    const layout: CommerceProductMediaItemV1[] = [
      { mediaId: "media_tin", variantIds: [] },
      { mediaId: "media_sencha", variantIds: ["variant_tea_small_sencha", "variant_tea_large_sencha"] },
      { mediaId: "media_hojicha", variantIds: ["variant_tea_small_hojicha", "variant_tea_large_hojicha"] },
    ];
    expect(
      await staff.setMedia(0, [{ mediaId: "media_tin", variantIds: ["variant_missing"] }]),
    ).toMatchObject(rejectedWith({ field: "media.variantIds" }));
    expect(await staff.setMedia(0, layout)).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "set_product_media", resource: { kind: "product_media", revision: 1 } },
    });
    expect(await staff.setMedia(0, layout)).toMatchObject(
      rejectedWith({ code: "stale_resource_revision" }),
    );
    expect(await staff.rename("media_sencha", 1, "Sencha leaves, 100 g")).toMatchObject({
      outcome: "applied",
    });

    // The buyer catalog shows each variant's images in the product's order.
    const listings = teaListings(await catalogFor(buyer));
    const shown = listings.map((listing) => [
      listing.variantId,
      listing.media.map((media) => media.altText),
    ]);
    expect(shown).toEqual([
      ["variant_tea_large_hojicha", ["A tea tin", "Hojicha leaves"]],
      ["variant_tea_large_sencha", ["A tea tin", "Sencha leaves, 100 g"]],
      ["variant_tea_small_hojicha", ["A tea tin", "Hojicha leaves"]],
      ["variant_tea_small_sencha", ["A tea tin", "Sencha leaves, 100 g"]],
    ]);

    // A browser loads an image with no session, then revalidates it.
    const senchaUrl = listings[3]?.media[1]?.url;
    if (senchaUrl === undefined) throw new Error("The catalog has no sencha image");
    const first = await fetch(senchaUrl);
    expect([first.status, first.headers.get("content-type"), first.headers.get("etag")]).toEqual([
      200,
      "image/png",
      `"${png.sha256}"`,
    ]);
    expect(Buffer.from(await first.arrayBuffer()).equals(PNG)).toBe(true);
    const again = await fetch(senchaUrl, { headers: { "if-none-match": `"${png.sha256}"` } });
    expect(again.status).toBe(304);
    // An image no product shows is not served.
    expect((await fetch(senchaUrl.replace("media_sencha", "media_unused"))).status).toBe(404);

    // An image still shown cannot be deleted. After it comes off the product,
    // its record goes, but the bytes stay while the tin record names them.
    expect(await staff.delete("media_sencha", 2)).toMatchObject(
      rejectedWith({ field: "media.products" }),
    );
    await staff.setMedia(1, [layout[0], layout[2]].filter((item) => item !== undefined));
    expect(await staff.delete("media_sencha", 2)).toMatchObject({ outcome: "applied" });
    expect(bucket.deletes).toEqual([]);
    expect((await fetch(senchaUrl)).status).toBe(404);
    // The last record of the PNG takes it out of the bucket.
    await staff.setMedia(2, [layout[2]].filter((item) => item !== undefined));
    await staff.delete("media_tin", 1);
    expect(bucket.deletes).toEqual([`merchants/${merchantId}/media/${png.sha256}`]);

    // An archived product's images are no longer served.
    const hojichaUrl = teaListings(await catalogFor(buyer))[0]?.media[0]?.url;
    if (hojichaUrl === undefined) throw new Error("The catalog has no hojicha image");
    expect((await fetch(hojichaUrl)).status).toBe(200);
    await staff.archiveTea();
    expect((await fetch(hojichaUrl)).status).toBe(404);

    const library = await required(admin.listMedia(merchantId));
    expect(library.media.map((media) => media.id)).toEqual(["media_hojicha", "media_unused"]);
    Object.assign(evidence, {
      uploads: { png, webp },
      refusals,
      receipts: staff.receipts,
      catalog: shown,
      bucket: { puts: bucket.puts, deletes: bucket.deletes, keys: [...bucket.objects.keys()] },
      library,
    });
  } finally {
    writeEvidence("MEDIA_ARTIFACT_DIR", "media", evidence);
    backend.close();
  }
}

async function uploadStatus(
  admin: CommerceAdminClient,
  bytes: Uint8Array,
  contentType: string,
): Promise<number | "stored"> {
  const result = await admin.uploadMedia(merchantId, bytes, contentType);
  if (result.ok) return "stored";
  return result.error.kind === "http" ? result.error.status : 0;
}

/** A fake R2 bucket: it only keeps and returns what it is given. */
class MemoryBucket implements MediaStore {
  readonly objects = new Map<string, StoredMedia & { bytes: Uint8Array<ArrayBuffer> }>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];

  async head(key: string): Promise<StoredMedia | null> {
    const object = this.objects.get(key);
    return object === undefined
      ? null
      : { size: object.size, contentType: object.contentType, sha256: object.sha256 };
  }

  async put(key: string, body: Uint8Array, media: Omit<StoredMedia, "size">): Promise<void> {
    this.puts.push(key);
    this.objects.set(key, { ...media, size: body.byteLength, bytes: body.slice() });
  }

  async get(key: string) {
    const object = this.objects.get(key);
    return object === undefined ? null : { ...object, body: object.bytes };
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
  }
}

class MediaStaff extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "media");
  }

  create(mediaId: string, sha256: string, altText: string): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.createMedia({
        ...this.editBase(`create_${mediaId}`),
        mediaId,
        sha256,
        altText,
      }),
    );
  }

  rename(mediaId: string, expectedRevision: number, altText: string) {
    return this.edit(
      this.admin.updateMedia({
        ...this.editBase(`rename_${mediaId}_${expectedRevision}`),
        mediaId,
        expectedRevision,
        altText,
      }),
    );
  }

  delete(mediaId: string, expectedRevision: number) {
    return this.edit(
      this.admin.deleteMedia({
        ...this.editBase(`delete_${mediaId}_${this.step}`),
        mediaId,
        expectedRevision,
      }),
    );
  }

  setMedia(expectedRevision: number, media: readonly CommerceProductMediaItemV1[]) {
    return this.edit(
      this.admin.setProductMedia({
        ...this.editBase(`set_media_${expectedRevision}_${this.step}`),
        productId: PRODUCT,
        expectedRevision,
        media,
      }),
    );
  }

  async archiveTea(): Promise<void> {
    const product = (await this.snapshot()).products.find((item) => item.id === PRODUCT);
    if (product === undefined) throw new Error("The tea is missing");
    await this.apply(
      this.admin.updateProduct({
        ...this.editBase("archive_tea"),
        productId: PRODUCT,
        expectedProductRevision: product.revision,
        changes: { status: "archived" },
      }),
    );
  }
}
