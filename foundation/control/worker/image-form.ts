import { sha256Hex } from "@purin-labs/std";

/** Room for the form's other fields and boundaries around one image. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

/** One image of a multipart form, with its digest. */
type FormImage<TContentType extends string> = Readonly<{
  contentType: TContentType;
  bytes: Uint8Array;
  sha256: string;
}>;

export type ImageFormRead<TContentType extends string> = Readonly<{
  /** The other fields of the form, for the route to read. */
  form: FormData;
  image: FormImage<TContentType>;
}>;

/**
 * Reads a multipart form that carries one image in `field`. The body stops
 * at `maxBytes` and the form overhead, so a large upload never fills the
 * Worker's memory. Null when the body is not such a form, the image is
 * missing or empty, too large, or of a type outside `contentTypes`.
 */
export async function readImageForm<TContentType extends string>(
  request: Request,
  rules: Readonly<{
    field: string;
    maxBytes: number;
    contentTypes: readonly TContentType[];
  }>,
): Promise<ImageFormRead<TContentType> | null> {
  if (
    request.body === null ||
    !request.headers.get("content-type")?.startsWith("multipart/form-data")
  )
    return null;
  const limit = new BodyLimit(rules.maxBytes + FORM_OVERHEAD_BYTES);
  let form: FormData;
  try {
    form = await new Response(
      request.body.pipeThrough(
        new TransformStream({ transform: limit.transform.bind(limit) }),
      ),
      { headers: request.headers },
    ).formData();
  } catch {
    return null;
  }
  const file = form.get(rules.field);
  if (
    file === null ||
    typeof file === "string" ||
    !isAllowedType(rules.contentTypes, file.type) ||
    file.size === 0 ||
    file.size > rules.maxBytes
  )
    return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    form,
    image: { contentType: file.type, bytes, sha256: await sha256Hex(bytes) },
  };
}

function isAllowedType<TContentType extends string>(
  allowed: readonly TContentType[],
  value: string,
): value is TContentType {
  return (allowed as readonly string[]).includes(value);
}

class BodyLimit {
  private bytes = 0;

  constructor(private readonly limit: number) {}

  transform(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.limit) throw new Error("image_form_too_large");
    controller.enqueue(chunk);
  }
}
