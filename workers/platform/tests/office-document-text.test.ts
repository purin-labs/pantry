import { describe, expect, it } from "vitest";

import {
  extractOfficeDocumentText,
  officeXmlToText,
  OFFICE_EXTRACTION_LIMITS,
  supportsOfficeExtraction,
} from "@purin-labs/agent/messages/office-document-text";

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ODT = "application/vnd.oasis.opendocument.text";

describe("office document text extraction", function officeExtractionSuite() {
  it("extracts paragraphs from a deflated DOCX", async function extractsDocx() {
    const archive = await zipArchive([
      { name: "[Content_Types].xml", body: "<Types/>", deflate: true },
      {
        name: "word/document.xml",
        body:
          "<w:document><w:body><w:p><w:r><w:t>Quote for</w:t>" +
          '<w:t xml:space="preserve"> 200 units</w:t></w:r></w:p>' +
          "<w:p><w:r><w:t>Delivery in March</w:t></w:r></w:p></w:body></w:document>",
        deflate: true,
      },
    ]);

    const result = await extractOfficeDocumentText(archive, DOCX);

    expect(result).toEqual({
      ok: true,
      value: "Quote for 200 units\nDelivery in March",
    });
  });

  it("extracts an ODT body from its own entry", async function extractsOdt() {
    const archive = await zipArchive([
      {
        name: "mimetype",
        body: "application/vnd.oasis.opendocument.text",
        deflate: false,
      },
      {
        name: "content.xml",
        body: "<office:body><text:p>Menu update</text:p><text:p>Espresso 3.50</text:p></office:body>",
        deflate: true,
      },
    ]);

    const result = await extractOfficeDocumentText(archive, ODT);

    expect(result).toEqual({ ok: true, value: "Menu update\nEspresso 3.50" });
  });

  it("reads a stored entry that was never compressed", async function readsStoredEntry() {
    const archive = await zipArchive([
      {
        name: "word/document.xml",
        body: "<w:p><w:t>Plain stored</w:t></w:p>",
        deflate: false,
      },
    ]);

    expect(await extractOfficeDocumentText(archive, DOCX)).toEqual({
      ok: true,
      value: "Plain stored",
    });
  });

  it("refuses an archive without the document entry", async function refusesMissingEntry() {
    const archive = await zipArchive([
      { name: "word/settings.xml", body: "<settings/>", deflate: true },
    ]);

    expect(await extractOfficeDocumentText(archive, DOCX)).toEqual({
      ok: false,
      error: { code: "document_entry_missing" },
    });
  });

  it("refuses bytes that are not an archive at all", async function refusesNonArchive() {
    expect(
      await extractOfficeDocumentText(
        new TextEncoder().encode("%PDF-1.7"),
        DOCX,
      ),
    ).toEqual({
      ok: false,
      error: { code: "not_an_archive" },
    });
  });

  it("refuses an archive beyond the inspection limit", async function refusesLargeArchive() {
    const oversized = new Uint8Array(
      OFFICE_EXTRACTION_LIMITS.maxArchiveBytes + 1,
    );

    expect(await extractOfficeDocumentText(oversized, DOCX)).toEqual({
      ok: false,
      error: { code: "archive_too_large" },
    });
  });

  it("refuses an entry whose declared size exceeds the limit", async function refusesZipBomb() {
    const archive = await zipArchive([
      {
        name: "word/document.xml",
        body: "<w:p><w:t>small</w:t></w:p>",
        deflate: true,
      },
    ]);
    // A zip bomb declares a vast uncompressed size from a tiny compressed one.
    const tampered = withDeclaredUncompressedSize(archive, 0x7fff_ffff);

    expect(await extractOfficeDocumentText(tampered, DOCX)).toEqual({
      ok: false,
      error: { code: "entry_too_large" },
    });
  });

  it("refuses a compression method it cannot decode", async function refusesUnknownMethod() {
    const archive = await zipArchive([
      {
        name: "word/document.xml",
        body: "<w:p><w:t>x</w:t></w:p>",
        deflate: true,
      },
    ]);
    const tampered = withCompressionMethod(archive, 99);
    const result = await extractOfficeDocumentText(tampered, DOCX);

    expect(result).toEqual({
      ok: false,
      error: { code: "unsupported_compression", method: 99 },
    });
  });

  it("names the formats it supports", function namesSupported() {
    expect(supportsOfficeExtraction(DOCX)).toBe(true);
    expect(supportsOfficeExtraction(ODT)).toBe(true);
    expect(supportsOfficeExtraction("application/pdf")).toBe(false);
    expect(supportsOfficeExtraction("application/msword")).toBe(false);
  });

  it("keeps paragraph shape and decodes entities", function normalizesXml() {
    expect(
      officeXmlToText(
        "<w:p><w:t>Tea &amp; coffee</w:t></w:p><w:p><w:t>&lt;30 units</w:t></w:p>",
      ),
    ).toBe("Tea & coffee\n<30 units");
    // Markup is dropped, never interpreted.
    expect(officeXmlToText("<w:p><w:t>a</w:t><w:br/><w:t>b</w:t></w:p>")).toBe(
      "a b",
    );
  });
});

type ArchiveEntry = {
  readonly name: string;
  readonly body: string;
  readonly deflate: boolean;
};

async function zipArchive(
  entries: readonly ArchiveEntry[],
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const offsets: number[] = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = encoder.encode(entry.body);
    const stored = entry.deflate ? await deflateRaw(raw) : raw;

    offsets.push(local.length);
    pushU32(local, 0x04034b50);
    pushU16(local, 20);
    pushU16(local, 0);
    pushU16(local, entry.deflate ? 8 : 0);
    pushU16(local, 0);
    pushU16(local, 0);
    pushU32(local, 0);
    pushU32(local, stored.byteLength);
    pushU32(local, raw.byteLength);
    pushU16(local, name.byteLength);
    pushU16(local, 0);
    local.push(...name, ...stored);
  }

  entries.forEach(function centralEntry(entry, index) {
    const name = encoder.encode(entry.name);
    const raw = encoder.encode(entry.body);
    const offset = offsets[index] ?? 0;
    const view = new DataView(new Uint8Array(local).buffer);
    const compressedSize = view.getUint32(offset + 18, true);

    pushU32(central, 0x02014b50);
    pushU16(central, 20);
    pushU16(central, 20);
    pushU16(central, 0);
    pushU16(central, entry.deflate ? 8 : 0);
    pushU16(central, 0);
    pushU16(central, 0);
    pushU32(central, 0);
    pushU32(central, compressedSize);
    pushU32(central, raw.byteLength);
    pushU16(central, name.byteLength);
    pushU16(central, 0);
    pushU16(central, 0);
    pushU16(central, 0);
    pushU16(central, 0);
    pushU32(central, 0);
    pushU32(central, offset);
    central.push(...name);
  });

  const eocd: number[] = [];

  pushU32(eocd, 0x06054b50);
  pushU16(eocd, 0);
  pushU16(eocd, 0);
  pushU16(eocd, entries.length);
  pushU16(eocd, entries.length);
  pushU32(eocd, central.length);
  pushU32(eocd, local.length);
  pushU16(eocd, 0);

  return new Uint8Array([...local, ...central, ...eocd]);
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new Response(bytes).body;

  if (source === null) {
    throw new Error("no body for the deflate fixture");
  }

  return new Uint8Array(
    await new Response(
      source.pipeThrough(new CompressionStream("deflate-raw")),
    ).arrayBuffer(),
  );
}

/** Rewrites the central-directory uncompressed size for one entry. */
function withDeclaredUncompressedSize(
  archive: Uint8Array,
  size: number,
): Uint8Array {
  const copy = archive.slice();
  const view = new DataView(copy.buffer);
  const central = findCentralDirectory(copy);

  view.setUint32(central + 24, size, true);

  return copy;
}

function withCompressionMethod(
  archive: Uint8Array,
  method: number,
): Uint8Array {
  const copy = archive.slice();
  const view = new DataView(copy.buffer);
  const central = findCentralDirectory(copy);

  view.setUint16(central + 10, method, true);

  return copy;
}

function findCentralDirectory(archive: Uint8Array): number {
  const view = new DataView(archive.buffer);

  for (let offset = archive.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      return view.getUint32(offset + 16, true);
    }
  }

  throw new Error("no central directory in fixture");
}

function pushU16(target: number[], value: number): void {
  target.push(value & 0xff, (value >> 8) & 0xff);
}

function pushU32(target: number[], value: number): void {
  target.push(
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}
