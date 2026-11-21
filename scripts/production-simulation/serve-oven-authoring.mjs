// Controlled local HTTP fixture. Production save/read functions run against
// Commerce's built fixture Worker in Miniflare (Plan 76 phase 1).
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  CommerceAdminClient,
  CommerceEntityPlaneClient,
} from "../../packages/commerce-client/src/index.ts";
import {
  commerceGraphResponseBody,
  parseCommerceGraphRouteBody,
} from "../../services/platform/src/commerce/entity-plane/routes.ts";
import { buildSavedSelectorCommerceReadAuthority } from "../../services/platform/src/commerce/entity-plane/authority.ts";
import { CommerceGraphReader } from "../../services/platform/src/commerce/entity-plane/graph-reader.ts";
import { CommerceEngineSource } from "../../services/platform/src/commerce/entity-plane/commerce-source.ts";
import { sampleSettings } from "../../packages/bakery-model/src/bakery.ts";
import { readBakeryProcedure } from "../../packages/bakery-model/src/bakery-procedure.ts";
import { parseProductionScenario } from "../../packages/bakery-model/src/bakery-production-scenario.ts";
import {
  createFinancierSample,
  FINANCIER_SAMPLE_ID,
} from "../../services/platform/src/commerce/bakery/sample.ts";
import {
  parseOperationEdit,
  saveOperationDuration,
} from "../../services/platform/src/commerce/bakery/operation.ts";
import { saveProductionScenario } from "../../services/platform/src/commerce/bakery/production-scenario.ts";
import { canonicalJson } from "../../packages/std/src/index.ts";
import { startCommerceWorker } from "../../services/platform/tests/commerce-fixture-worker.ts";

const output = resolve(
  process.argv[2] ?? "output/acceptance/plan-70/oven-authoring-storage",
);
const port = Number(process.argv[3] ?? 5197);
mkdirSync(output, { recursive: true });
const now = "2026-10-10T00:00:00.000Z";
const organisationId = "oven-authoring-acceptance";
const merchantId = "oven-authoring-merchant";
const commerceEngine = await startCommerceWorker({
  now,
  serviceToken: "local-oven-fixture",
});
const config = {
  baseUrl: commerceEngine.baseUrl,
  serviceToken: commerceEngine.serviceToken,
  fetch: commerceEngine.fetch,
};
const provisioned = await new CommerceAdminClient(config).provisionMerchant({
  schemaVersion: "commerce.provision-merchant.v2",
  externalReference: organisationId,
  merchantId,
  createdAt: now,
});
if (!provisioned.ok) throw new Error(JSON.stringify(provisioned.error));
const client = new CommerceEntityPlaneClient(config);
const input = {
  client,
  organisationId,
  merchantId,
  principalId: "fixture-admin",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const created = await createFinancierSample(input);
if (!created.ok) throw new Error(JSON.stringify(created));
// Short recipe durations keep the browser journey bounded while using native physics.
for (const operation of [
  "stage",
  "portion",
  "bake",
  "cool",
  "demould",
  "finishCooling",
  "pack",
]) {
  const source = await readBakeryProcedure(
    readGraph,
    {
      origin: "custom",
      typeId: "bakery_procedure",
      entityId: FINANCIER_SAMPLE_ID,
    },
    sampleSettings(),
  );
  if (source.kind !== "ready") throw new Error(source.message);
  const item = source.procedure.operations.find(
    matchesOperation.bind(null, operation),
  );
  if (item === undefined) throw new Error(operation);
  const edit = parseOperationEdit({
    entityId: item.reference.entityId,
    expectedRevision: Number(item.revision),
    snapshot: Number(source.procedure.snapshotRevision),
    minutes: 1,
  });
  if (edit === null) throw new Error("Invalid duration edit");
  const result = await saveOperationDuration({
    ...input,
    commandId: `fixture-duration-${operation}`,
    edit,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}
const writes = [];
let reads = 0;
const server = createServer(receive);
server.listen(port, "127.0.0.1", ready);
process.once("SIGTERM", close);
process.once("SIGINT", close);

function matchesOperation(operation, item) {
  return item.operation === operation;
}
// The Portal's graph route as the Platform answers it: the same body parser,
// graph reader and read authority, for the fixture's administrator.
const graphReader = new CommerceGraphReader({
  organisationId,
  merchantId,
  commerceSystem: {
    kind: "builtin_commerce",
    organisationId,
    bindingId: "oven-authoring-binding",
    merchantId,
    revision: 1,
  },
  commerce: new CommerceEngineSource({
    organisationId,
    merchantId,
    integrationAccountId: "oven-authoring-account",
    client,
  }),
});
async function answerGraph(body) {
  const parsed = parseCommerceGraphRouteBody(body);
  if (!parsed.ok) return { status: 422, body: { error: parsed.error.code } };
  const now = Date.now();
  const authority = buildSavedSelectorCommerceReadAuthority({
    organisationId,
    merchantId,
    principalId: input.principalId,
    sensitivityCeiling: "restricted",
    expiresAt: new Date(now + 60_000).toISOString(),
    commandId: `fixture_read_${now}`,
    selectorId: `control_${organisationId}_${now}`,
    selectorRevision: 1,
    query: parsed.value,
  });
  if (!authority.ok)
    return { status: 403, body: { error: authority.error.code } };
  const result = await graphReader.query({
    query: parsed.value,
    authority: authority.value,
    now: new Date(now).toISOString(),
  });
  return result.ok
    ? { status: 200, body: commerceGraphResponseBody(result.value) }
    : { status: 500, body: { error: result.error.code } };
}
async function readGraph(query) {
  const result = await client.query(merchantId, query);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function ready() {
  console.log(`Oven authoring fixture: http://127.0.0.1:${port}`);
}
function close() {
  server.close(closed);
}
function closed() {
  void commerceEngine.dispose();
}
function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body, jsonValue));
}
async function receive(request, response) {
  try {
    const path = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
    if (request.method === "GET" && path === "/fixture.json") {
      send(response, 200, { organisationId, procedureId: FINANCIER_SAMPLE_ID });
      return;
    }
    if (request.method === "GET" && path === "/evidence.json") {
      send(response, 200, { reads, writes });
      return;
    }
    const root = `/v1/control/organisations/${organisationId}/commerce/`;
    if (request.method === "GET" && path === `${root}published-resources`) {
      const result = await client.publishedResourceMetadata({
        kind: "enumerate",
        organisationId,
        merchantId,
      });
      if (!result.ok) throw new Error(result.error.message);
      // The Platform route wraps the enumeration as the Portal reads it.
      send(response, 200, { ok: true, metadata: result.value });
      return;
    }
    if (request.method !== "POST" || !path.startsWith(root)) {
      send(response, 403, { error: "fixture_scope_denied" });
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (path === `${root}graph`) {
      const answer = await answerGraph(body);
      reads++;
      send(response, answer.status, answer.body);
      return;
    }
    if (path === `${root}bakery/production-scenario`) {
      const copy = parseProductionScenario(body);
      if (copy === null) {
        send(response, 400, { error: "invalid_scenario" });
        return;
      }
      const result = await saveProductionScenario({ ...input, copy });
      if (result.ok) {
        writes.push(copy);
        writeFileSync(join(output, `${copy.id}.json`), canonicalJson(copy));
        writeFileSync(
          join(output, "report.json"),
          canonicalJson({ reads, writes }),
        );
      }
      send(response, result.ok ? 200 : 400, result);
      return;
    }
    send(response, 404, { error: "unknown_fixture_route" });
  } catch (error) {
    send(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function jsonValue(key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}
