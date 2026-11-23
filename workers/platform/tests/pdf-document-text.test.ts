import { describe, expect, it } from "vitest";

import {
  extractPdfText,
  extractTextOperators,
  legibleRatio,
  PDF_EXTRACTION_LIMITS,
} from "@purin-labs/agent/messages/pdf-document-text";

describe("PDF text extraction", function pdfExtractionSuite() {
  it("extracts text from an uncompressed content stream", async function extractsPlainStream() {
    const pdf = await pdfWith(
      "BT /F1 12 Tf 72 720 Td (Quote for 200 units) Tj ET",
      { deflate: false },
    );

    expect(await extractPdfText(pdf)).toEqual({
      ok: true,
      value: "Quote for 200 units",
    });
  });

  it("inflates a FlateDecode content stream", async function extractsDeflatedStream() {
    const pdf = await pdfWith(
      "BT (Espresso 3.50) Tj T* (Delivery in March) Tj ET",
      { deflate: true },
    );

    expect(await extractPdfText(pdf)).toEqual({
      ok: true,
      value: "Espresso 3.50\nDelivery in March",
    });
  });

  it("reads hex strings and array-shown text", async function readsHexAndArrays() {
    // <48656c6c6f> is "Hello"; the TJ array shows two runs.
    const pdf = await pdfWith("BT <48656c6c6f> Tj T* [(wor) (ld)] TJ ET", {
      deflate: false,
    });

    expect(await extractPdfText(pdf)).toEqual({
      ok: true,
      value: "Hello\nworld",
    });
  });

  it("decodes escapes inside literal strings", async function decodesEscapes() {
    const pdf = await pdfWith(String.raw`BT (Tea \( 2 \) \\ caf\351) Tj ET`, {
      deflate: false,
    });

    expect(await extractPdfText(pdf)).toEqual({
      ok: true,
      value: "Tea ( 2 ) \\ café",
    });
  });

  it("refuses bytes that are not a PDF", async function refusesNonPdf() {
    expect(await extractPdfText(new TextEncoder().encode("PK"))).toEqual({
      ok: false,
      error: { code: "not_a_pdf" },
    });
  });

  it("refuses a document beyond the inspection limit", async function refusesLarge() {
    const oversized = new Uint8Array(
      PDF_EXTRACTION_LIMITS.maxDocumentBytes + 1,
    );

    oversized.set(new TextEncoder().encode("%PDF-1.7"), 0);

    expect(await extractPdfText(oversized)).toEqual({
      ok: false,
      error: { code: "document_too_large" },
    });
  });

  it("reports no extractable text for a scanned page", async function refusesImageOnly() {
    // A DCTDecode stream is a photograph, not text; decoding it as text would
    // be nonsense, so the stream is skipped entirely.
    const pdf = await pdfWith("ÿØÿà jpeg bytes", {
      deflate: false,
      filter: "/DCTDecode",
    });

    expect(await extractPdfText(pdf)).toEqual({
      ok: false,
      error: { code: "no_extractable_text" },
    });
  });

  it("refuses text that does not read as text", async function refusesIllegible() {
    // A subset font with a custom CMap yields byte values with no standard
    // meaning. Emitting them would look like a successful extraction.
    const gibberish = Array.from(
      { length: 40 },
      function control(_unused, index) {
        return `\\${((index % 8) + 1).toString(8).padStart(3, "0")}`;
      },
    ).join("");
    const pdf = await pdfWith(`BT (${gibberish}) Tj ET`, { deflate: false });
    const result = await extractPdfText(pdf);

    if (result.ok) {
      throw new Error(
        `expected a refusal, got ${JSON.stringify(result.value)}`,
      );
    }

    expect(result.error.code).toBe("text_not_legible");
  });

  it("scores legibility by ordinary text characters", function scoresLegibility() {
    expect(legibleRatio("Quote for 200 units")).toBe(1);
    expect(legibleRatio("café — naïve")).toBeGreaterThan(0.85);
    expect(legibleRatio("")).toBe(0);
    expect(legibleRatio("")).toBe(0);
  });

  it("honours only the text-showing operators", function honoursOperators() {
    // A string that is never shown produces no text.
    expect(extractTextOperators("BT (never shown) 0 g ET")).toBe("\n");
    expect(extractTextOperators("BT (shown) Tj ET")).toBe("shown\n");
    // Comments are skipped rather than read as content.
    expect(extractTextOperators("% (commented) Tj\nBT (real) Tj ET")).toBe(
      "real\n",
    );
  });
});

type PdfOptions = {
  readonly deflate: boolean;
  readonly filter?: string;
};

async function pdfWith(
  content: string,
  options: PdfOptions,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const raw = encoder.encode(content);
  const body = options.deflate ? await deflate(raw) : raw;
  const filter = options.filter ?? (options.deflate ? "/FlateDecode" : null);
  const dictionary =
    filter === null
      ? `<< /Length ${body.byteLength} >>`
      : `<< /Filter ${filter} /Length ${body.byteLength} >>`;
  const head = encoder.encode(`%PDF-1.7\n1 0 obj\n${dictionary}\nstream\n`);
  const tail = encoder.encode("\nendstream\nendobj\n%%EOF\n");
  const pdf = new Uint8Array(
    head.byteLength + body.byteLength + tail.byteLength,
  );

  pdf.set(head, 0);
  pdf.set(body, head.byteLength);
  pdf.set(tail, head.byteLength + body.byteLength);

  return pdf;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new Response(bytes).body;

  if (source === null) {
    throw new Error("no body for the deflate fixture");
  }

  return new Uint8Array(
    await new Response(
      source.pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
}
