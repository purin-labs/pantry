import createBakeryModule from "../bakery-native.js";

try {
  const module = await createBakeryModule({ locateFile: locatePackageFile });
  module.callMain(["--root", "/", "--output", "/request.json", "prepare"]);
  const request = JSON.parse(
    module.FS.readFile("/request.json", { encoding: "utf8" }),
  );
  module.callMain([
    "--root",
    "/",
    "--output",
    "/recording.json",
    "run",
    "/request.json",
  ]);
  const text = module.FS.readFile("/recording.json", { encoding: "utf8" });
  const recording = JSON.parse(text);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
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
