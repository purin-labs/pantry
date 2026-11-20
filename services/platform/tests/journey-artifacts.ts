// The writer of the E2E journeys' artifacts. A journey runs inside workerd,
// which has no file system; it posts its artifact to the `JOURNEY_ARTIFACTS`
// service binding, and this function, in the Vitest process, writes it under
// output/ in the repository. The path names one JSON file, for example
// `plan-24/bake-proposal.json`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Response, type Request } from "miniflare";

const OUTPUT = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  "output",
);
const ARTIFACT_PATH = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\.json$/u;

export async function writeJourneyArtifact(
  request: Request,
): Promise<Response> {
  const path = new URL(request.url).pathname.slice(1);
  if (request.method !== "PUT" || !ARTIFACT_PATH.test(path))
    return new Response("An artifact is a PUT of one JSON file.", {
      status: 400,
    });
  const file = normalize(join(OUTPUT, path));
  if (!file.startsWith(`${OUTPUT}/`))
    return new Response("The artifact path leaves output/.", { status: 400 });
  const value: unknown = await request.json();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return new Response(JSON.stringify({ file }), {
    headers: { "content-type": "application/json" },
  });
}
