import createBakeryModule from "../bakery-native.js";

// One transfer through the host protocol, as the Portal's engine worker
// runs it: prepare, open the program, then advance in bounded calls.
try {
  const module = await createBakeryModule({ locateFile: locatePackageFile });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const command = (value) => {
    const bytes = encoder.encode(JSON.stringify(value));
    const pointer = module._bakery_alloc(bytes.length);
    module.HEAPU8.set(bytes, pointer);
    const code = module._bakery_cell_command(pointer, bytes.length);
    module._bakery_free(pointer, bytes.length);
    const start = module._bakery_response_pointer();
    const text = decoder.decode(
      module.HEAPU8.subarray(start, start + module._bakery_response_length()),
    );
    if (code !== 0) throw new Error(text);
    const reply = JSON.parse(text);
    if (reply.kind !== "program") throw new Error(text);
    return reply.reply;
  };
  const { request } = command({
    op: "program",
    command: { op: "prepare", preparation: {} },
  });
  let reply = command({
    op: "program",
    command: { op: "open", job: "smoke", program: { kind: "run", request } },
  });
  while (reply.kind === "running")
    reply = command({
      op: "program",
      command: { op: "advance", job: "smoke", steps: 2000 },
    });
  const text = reply.output;
  const recording = JSON.parse(text);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  postMessage({
    kind: recording.kind,
    outcome: recording.outcome.kind,
    samples: recording.samples.length,
    requestIdentity: request.execution,
    recordingIdentity: recording.provenance,
    recordingBytes: text.length,
    recordingSha256: sha256,
  });
} catch (error) {
  postMessage({ error: String(error) });
}

function locatePackageFile(file) {
  return new URL(`../${file}`, import.meta.url).href;
}
