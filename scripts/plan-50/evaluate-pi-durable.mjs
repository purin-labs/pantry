import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const scripts = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scripts, "../..");
const portability = process.argv[4] === "portability";
const draft = process.argv[4] === "draft";
const proposal = process.argv[4] === "proposal";
const effectCancellation = process.argv[4] === "effect-cancel";
const codeModeTrial = process.argv[4] === "codemode" || effectCancellation;
const draftBrowser = process.argv[4] === "draft-browser";
// The draft trial runs the draft collaboration Worker on the provider stack.
const providerTrial =
  process.argv[4] === "provider" || codeModeTrial || draftBrowser || draft;
const recoveryPortability = process.argv[4] === "recovery-portability";
const recovery =
  process.argv[4] === "recovery" ||
  draft ||
  proposal ||
  providerTrial ||
  recoveryPortability;
const canonical = process.argv[4] === "canonical" || portability || recovery;
const integration = process.argv[4] === "integration" || canonical;
assert(
  process.argv[4] === undefined || integration,
  "The optional scenario group must be integration, canonical, portability, recovery, recovery-portability, draft, draft-browser, proposal, provider, codemode, or effect-cancel",
);
const output = resolve(
  process.argv[3] ??
    join(
      repository,
      "docs/evidence/plan-50-durable-execution/candidate-results.json",
    ),
);
const runtimeDirectory =
  process.argv[2] === undefined || process.argv[2] === "-"
    ? await prepareRuntime()
    : process.argv[2];
const pinnedLock = JSON.parse(
  await readFile(join(scripts, "runtime/package-lock.json"), "utf8"),
);
const installedLock = JSON.parse(
  await readFile(join(runtimeDirectory, "package-lock.json"), "utf8"),
);
assert.deepEqual(
  installedLock,
  pinnedLock,
  "Runtime dependency graph differs from the pinned trial graph",
);
const require = createRequire(join(resolve(runtimeDirectory), "package.json"));
const { build } = require("esbuild");
const artifacts = await mkdtemp(join(tmpdir(), "pantry-plan50-run-"));
const worker = join(artifacts, "candidate-worker.mjs");
let browserBuild = null;
if (draftBrowser) {
  browserBuild = await build({
    entryPoints: [join(scripts, "draft-browser-entry.jsx")],
    outfile: join(artifacts, "browser.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    metafile: true,
    nodePaths: [join(repository, "apps/portal/node_modules")],
  });
}
const buildResult = await build({
  ...(proposal
    ? {
        stdin: {
          contents:
            'export { default, CandidateActor, ProposalOrganisation, ProposalCase } from "./proposal-worker.mjs";',
          resolveDir: scripts,
          sourcefile: "<proposal-entry>",
        },
      }
    : { entryPoints: [join(scripts, trialWorkerFile())] }),
  outfile: worker,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  banner: providerTrial
    ? {
        js: 'import { createRequire as createTrialRequire } from "node:module"; const require = createTrialRequire("/candidate-worker.mjs");',
      }
    : {},
  define: {
    ...(providerTrial
      ? { "import.meta.url": JSON.stringify("file:///candidate-worker.mjs") }
      : {}),
  },
  nodePaths: [join(resolve(runtimeDirectory), "node_modules")],
  external: ["cloudflare:workers", "node:*"],
  plugins: [
    ...(integration ? [{ name: "media-wasm", setup: configureWasm }] : []),
    ...(proposal || providerTrial
      ? [{ name: "node-builtins", setup: configureNodeBuiltins }]
      : []),
  ],
  metafile: true,
  logLevel: "warning",
});
if (integration) {
  await copyFile(
    join(repository, "packages/contracts/media-wasm-pkg/media_inspect_bg.wasm"),
    join(artifacts, "media.wasm"),
  );
}
// A Pi script runs in the Code Mode sandbox Worker, as in production. The
// runtime adds it as a Worker of its own; its directory keeps its QuickJS
// module apart from the trial Worker's modules.
const sandboxDirectory = join(artifacts, "code-mode-sandbox");
if (codeModeTrial || draftBrowser || draft) {
  await mkdir(sandboxDirectory);
  await build({
    entryPoints: [
      join(repository, "services/platform/src/code-mode-sandbox/worker.ts"),
    ],
    outfile: join(sandboxDirectory, "worker.mjs"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
    plugins: [{ name: "quickjs-wasm", setup: configureQuickJsWasm }],
    logLevel: "warning",
  });
}
const fixtures = new Map();
const commerceSources = new Set();
const createCommerce =
  providerTrial || proposal ? await loadCommerceFixture() : null;
const provider = createServer(handleProvider.bind(null, fixtures));
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const providerUrl = `http://127.0.0.1:${provider.address().port}`;
const candidateScenarios = [
  "receipt_recovery",
  "unsafe_default",
  "revoked_authority",
  "model_interruption",
  "cancelled",
  "no_alarm",
  "hook_denial",
  "transport_denial",
];
const integrationScenarios = [
  "atomic_rollback",
  "publication_gap",
  "restart_admission",
  "cancelled_restart",
];
const checkpointScenarios = [
  "checkpoint_publication_gap",
  "checkpoint_write_rollback",
  "checkpoint_revoked_authority",
  "checkpoint_upload_gap",
];
const scenarios = trialScenarios();
const evidence = {
  kind: trialEvidenceKind(),
  startedAt: new Date().toISOString(),
  environment: providerTrial
    ? "Local workerd with SQLite-backed Durable Objects and actual Commerce HTTP API over SQLite; controlled model and OIDC issuer responses; no paid calls"
    : "Local workerd with SQLite-backed Durable Objects; simulated model and provider; no paid calls",
  interruption:
    "SIGKILL of the Node runtime host and workerd process group without Harness.close, followed by a fresh host over the same SQLite and R2 directory",
  runtimeDirectory,
  artifactDirectory: artifacts,
  packages: await packageEvidence(),
  sources: await sourceEvidence(),
  workerBytes: (await readFile(worker)).byteLength,
  workerSha256: createHash("sha256")
    .update(await readFile(worker))
    .digest("hex"),
  bundleInputCount: Object.keys(buildResult.metafile.inputs).length,
  scenarios: [],
};
try {
  for (const scenario of scenarios) {
    console.log(`Evaluating ${scenario}`);
    const result = await evaluateTrialScenario(scenario);
    if (fixtures.get(scenario)?.taskInspection !== undefined)
      result.taskInspection = fixtures.get(scenario).taskInspection;
    evidence.scenarios.push(result);
    await saveEvidence();
    console.log(`${scenario}: ${result.status}`);
    if (result.status === "failed") console.error(result.error);
  }
} finally {
  evidence.finishedAt = new Date().toISOString();
  await saveEvidence();
  provider.closeAllConnections();
  provider.close();
}
assert(
  evidence.scenarios.every(passed),
  "One or more candidate scenarios failed",
);
console.log(`Evidence: ${output}`);

function trialWorkerFile() {
  if (effectCancellation) return "effect-cancellation-worker.mjs";
  if (draftBrowser) return "draft-collaboration-worker.mjs";
  if (draft) return "draft-worker.mjs";
  if (codeModeTrial) return "codemode-worker.mjs";
  if (providerTrial) return "provider-worker.mjs";
  if (proposal) return "proposal-worker.mjs";
  if (recovery) return "recovery-worker.mjs";
  if (canonical) return "canonical-worker.mjs";
  if (integration) return "seam-worker.mjs";
  return "candidate-worker.mjs";
}

function trialScenarios() {
  if (effectCancellation) return ["provider_codemode_effect_cancel"];
  if (draftBrowser) return ["draft_browser_restricted", "draft_browser"];
  if (draft)
    return [
      "draft_response_loss",
      "draft_member_revoked",
      "draft_receipt_wait",
      "draft_placement_frozen",
    ];
  if (codeModeTrial)
    return [
      "provider_codemode_restart",
      "provider_codemode_settlement",
      "provider_codemode_organisation_settlement",
      "provider_codemode_queue",
      "provider_codemode_cancel",
    ];
  if (providerTrial)
    return [
      "provider_response_loss",
      "provider_receipt_wait",
      "provider_revoked_model",
      "provider_extension_missing",
      "provider_extension_incompatible",
    ];
  if (proposal) return ["proposal_response_loss", "proposal_grant_revoked"];
  if (recoveryPortability)
    return [
      "recovery_portable_tools",
      "recovery_portable_revoked",
      "recovery_portable_unknown_usage",
    ];
  if (recovery)
    return [
      "recovery_tools",
      "recovery_revoked",
      "recovery_budget_exhausted",
      "recovery_cancelled",
      "recovery_unknown_usage",
      "recovery_schema_upgrade",
      "recovery_tool_denied",
      "recovery_tool_cancelled",
      "recovery_read_restart",
      "recovery_read_expired",
      "recovery_read_revoked",
    ];
  if (portability) return ["portable_completion"];
  if (canonical)
    return [
      "atomic_rollback",
      "canonical_interruption",
      "model_usage_rollback",
      "publication_gap",
      "completion_commit",
      ...checkpointScenarios,
    ];
  if (integration) return integrationScenarios;
  return candidateScenarios;
}

function trialEvidenceKind() {
  if (draftBrowser) return "plan50-native-pi-draft-collaboration.v1";
  if (draft) return "plan50-native-pi-draft-receipt.v1";
  if (providerTrial) return "plan50-native-pi-provider-receipt.v1";
  if (proposal) return "plan50-native-pi-governed-proposal.v1";
  if (recoveryPortability) return "plan50-native-pi-unfinished-portability.v1";
  if (recovery) return "plan50-native-pi-unfinished-recovery.v1";
  if (portability) return "plan50-native-pi-portability.v1";
  if (canonical) return "plan50-canonical-admission.v1";
  if (integration) return "plan50-pi-durable-integration-seams.v1";
  return "plan50-pi-durable-evaluation.v1";
}

async function evaluateTrialScenario(scenario) {
  if (draftBrowser) return evaluateDraftBrowserScenario(scenario);
  if (draft) return evaluateDraftScenario(scenario);
  if (codeModeTrial) return evaluateCodeModeScenario(scenario);
  if (providerTrial) return evaluateProviderScenario(scenario);
  if (proposal) return evaluateProposalScenario(scenario);
  if (recoveryPortability) return evaluateUnfinishedPortableScenario(scenario);
  if (recovery) return evaluateRecoveryScenario(scenario);
  if (portability) return evaluatePortableScenario(scenario);
  if (checkpointScenarios.includes(scenario))
    return evaluateCheckpointScenario(scenario);
  if (canonical && scenario !== "atomic_rollback")
    return evaluateCanonicalScenario(scenario);
  if (integration) return evaluateIntegrationScenario(scenario);
  return evaluateScenario(scenario);
}

function configureWasm(builder) {
  builder.onResolve(
    { filter: /media_inspect_bg\.wasm\?module$/ },
    resolveMediaWasm,
  );
}

function resolveMediaWasm() {
  return { path: "./media.wasm", external: true };
}

function configureQuickJsWasm(builder) {
  builder.onResolve(
    { filter: /^quickjs-wasi\/quickjs\.wasm$/ },
    resolveQuickJsWasm,
  );
}

async function resolveQuickJsWasm(args) {
  const wasm = createRequire(join(args.resolveDir, "package.json")).resolve(
    args.path,
  );
  await copyFile(wasm, join(sandboxDirectory, "quickjs.wasm"));
  return { path: "./quickjs.wasm", external: true };
}

function configureNodeBuiltins(builder) {
  builder.onResolve({ filter: /^[a-z_][a-z_\d/]*$/ }, resolveNodeBuiltin);
}

function resolveNodeBuiltin(args) {
  if (!builtinModules.includes(args.path)) return;
  return { path: `node:${args.path}`, external: true };
}

async function prepareRuntime() {
  const directory = await mkdtemp(join(tmpdir(), "pantry-plan50-dependencies-"));
  await copyFile(
    join(scripts, "runtime/package.json"),
    join(directory, "package.json"),
  );
  await copyFile(
    join(scripts, "runtime/package-lock.json"),
    join(directory, "package-lock.json"),
  );
  const installed = spawnSync(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: directory,
      stdio: "inherit",
    },
  );
  assert.equal(installed.status, 0, "Isolated dependency installation failed");
  return directory;
}

async function packageEvidence() {
  const lock = JSON.parse(
    await readFile(join(runtimeDirectory, "package-lock.json"), "utf8"),
  );
  const packages = [];
  for (const name of [
    "@earendil-works/pi-durable",
    "@earendil-works/pi-ai",
    "@earendil-works/chord",
    "miniflare",
    "workerd",
    "esbuild",
  ]) {
    const entry = lock.packages[`node_modules/${name}`];
    packages.push({
      name,
      version: entry.version,
      license: entry.license,
      integrity: entry.integrity,
    });
  }
  return packages;
}

async function sourceEvidence() {
  const files = [
    "scripts/plan-50/evaluate-pi-durable.mjs",
    "scripts/plan-50/runtime-process.mjs",
    "scripts/plan-50/candidate-worker.mjs",
    "scripts/plan-50/runtime/package.json",
    "scripts/plan-50/runtime/package-lock.json",
  ];
  if (integration)
    files.push(
      "scripts/plan-50/seam-worker.mjs",
      "services/platform/src/actors/agent-session-harness-authority.ts",
      "services/platform/src/actors/harness-history.ts",
      "packages/contracts/media-wasm-pkg/media_inspect_bg.wasm",
    );
  if (canonical)
    files.push(
      "scripts/plan-50/canonical-worker.mjs",
      "services/platform/src/actors/actor-journal.ts",
      "services/platform/src/actors/agent-session-budget.ts",
      "services/platform/src/actors/agent-session-turn-start.ts",
      "services/platform/src/actors/agent-session-schema.ts",
      "services/platform/src/actors/agent-session-harness-checkpoint.ts",
      "services/platform/src/actors/agent-session-finalization.ts",
      "services/platform/src/actors/agent-session-text-turn.ts",
      "services/platform/src/actors/agent-session-turn-stream.ts",
      "services/platform/src/actors/agent-session-information-flow.ts",
      "services/platform/src/harness-checkpoint.ts",
      "foundation/actor-runtime/actors/actor-export.ts",
      "foundation/actor-runtime/actors/actor-registry.ts",
    );
  if (recovery)
    files.push(
      "scripts/plan-50/recovery-worker.mjs",
      "services/platform/src/actors/agent-session-recovery.ts",
      "services/platform/src/actors/agent-session-canonical.ts",
      "packages/contracts/src/session-reducer.ts",
      "packages/contracts/src/session-schemas.ts",
      "packages/contracts/src/session-recovery.ts",
      "services/platform/src/agent-tools/catalog/selection.ts",
      "services/platform/src/agent-tools/catalog/code-mode.ts",
      "services/platform/src/actors/airtable-tool-input.ts",
      "services/platform/src/authorization/capability-catalogue.ts",
    );
  if (draft || proposal || providerTrial)
    files.push(
      "scripts/plan-50/draft-worker.mjs",
      "scripts/plan-50/draft-seed.mjs",
      "services/platform/src/actors/product-description-draft.ts",
      "services/platform/src/actors/collaboration-room.ts",
      "services/platform/src/actors/commerce-projection.ts",
      "services/platform/src/actors/session-execution-admission.ts",
      "foundation/actor-runtime/actors/actor-activation.ts",
      "foundation/tenancy/organisation-execution-scope.ts",
      "services/platform/migrations-global/0001_current_schema.sql",
      "services/platform/migrations-regional/0001_current_schema.sql",
      "services/platform/scripts/single-database-schema.mjs",
      "services/platform/package.json",
      "pnpm-lock.yaml",
    );
  if (proposal || providerTrial)
    files.push(
      "scripts/plan-50/proposal-worker.mjs",
      "services/platform/src/actors/harness-commerce-proposal.ts",
      "services/platform/src/actors/case.ts",
      "services/platform/src/actors/action-ledger.ts",
      "services/platform/src/actors/organisation.ts",
      "services/platform/src/authorization/access-grants/turn-authority.ts",
      "services/platform/src/data/access-grants.ts",
      "services/platform/src/policy/information-flow/source-labels.ts",
    );
  const sourcePaths = new Set(files);
  if (draftBrowser)
    sourcePaths.add("scripts/plan-50/draft-browser-acceptance.js");
  for (const path of commerceSources) sourcePaths.add(path);
  for (const input of [
    ...Object.keys(buildResult.metafile.inputs),
    ...Object.keys(browserBuild?.metafile.inputs ?? {}),
  ]) {
    if (input.endsWith("<proposal-entry>")) continue;
    const path = relative(repository, resolve(input));
    if (path.startsWith("..") || path.split(sep).includes("node_modules"))
      continue;
    sourcePaths.add(path);
  }
  const sources = [];
  for (const path of [...sourcePaths].sort()) {
    const content = await readFile(join(repository, path));
    sources.push({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return sources;
}

async function saveEvidence() {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
}

function passed(result) {
  return result.status === "passed";
}

function createFixture(scenario) {
  return {
    scenario,
    modelRequests: 0,
    beforeTool: [],
    authorizations: [],
    effectAttempts: [],
    receipts: new Map(),
    receiptReads: [],
    mutations: 0,
    productReads: 0,
    transportDenials: 0,
    revoked: false,
    heldCommit: null,
    rejectedUsage: null,
    rejectedCheckpoint: false,
    heldUpload: null,
    heldReadResponse: null,
    rejectedToolResults: [],
    draftCommits: [],
    heldProposal: null,
    mcpCalls: [],
    mcpSessions: new Set(),
    draftOwnerAvailable: true,
    holdRecovery: recoveryPortability,
    events: [],
    organisationSettlementAttempts: [],
  };
}

async function handleProvider(fixtures, request, response) {
  try {
    if (request.url.startsWith("/commerce/"))
      return await handleCommerce(fixtures, request, response);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const url = new URL(request.url, "http://fixture.test");
    const fixture = fixtures.get(
      body.scenario ?? url.searchParams.get("scenario"),
    );
    if (fixture === undefined) throw new Error("Unknown provider scenario");
    if (url.pathname === "/mcp-egress")
      return respondMcp(fixture, body, response);
    fixture.events.push({ path: request.url, body, at: Date.now() });
    if (url.pathname === "/openrouter")
      return respondOpenRouter(fixture, body, request, response);
    switch (request.url) {
      case "/draft-browser":
        if (body.stage === "begin") fixture.browserReady = true;
        else if (body.stage === "human") {
          fixture.browserHuman = true;
          sendJson(fixture.codeResponse, { acknowledged: true });
        } else if (body.stage === "override") fixture.draftOverride = true;
        else if (body.stage === "observed")
          fixture.browserEvidence = body.evidence;
        else if (body.stage === "delivered")
          fixture.browserDelivery = body.evidence;
        else if (body.stage === "approval_observed")
          fixture.browserApproval = body.evidence;
        else assert.equal(body.stage, "status");
        return sendJson(response, {
          readComplete:
            fixture.codeResult !== undefined &&
            fixture.sharedExecution === true,
          editAccepted: fixture.draftAccepted !== undefined,
          complete: fixture.browserComplete === true,
          recovered: fixture.browserRecovered === true,
          publicationNonce: fixture.publicationNonce ?? null,
          proposalNonce: fixture.browserEvidence?.proposal.nonce ?? null,
        });
      case "/draft-collaboration-held":
        fixture.draftAccepted = body.result;
        return;
      case "/draft-collaboration-denied":
        fixture.draftDenial = body;
        return sendJson(response, { acknowledged: true });
      case "/before-tool":
      case "/recovery-error":
        fixture.beforeTool.push(body);
        return sendJson(response, { ok: true });
      case "/transport-denied":
        fixture.transportDenials += 1;
        return sendJson(response, { denied: true });
      case "/authorize":
        fixture.authorizations.push(body);
        if (fixture.holdRecovery && body.operation === "resume_execution")
          return;
        if (
          fixture.scenario === "revoked_authority" &&
          fixture.authorizations.length === 1
        )
          return;
        if (
          fixture.scenario === "recovery_cancelled" &&
          body.operation === "resume_execution"
        )
          return;
        if (
          fixture.scenario === "recovery_tool_denied" &&
          body.operation === "product_description_draft_read"
        )
          return sendJson(response, { allowed: false });
        return sendJson(response, { allowed: !fixture.revoked });
      case "/receipt":
        fixture.receiptReads.push(body.operationId);
        return sendJson(response, {
          receipt: fixture.receipts.get(body.operationId) ?? null,
        });
      case "/effect": {
        fixture.effectAttempts.push(body.operationId);
        if (!fixture.receipts.has(body.operationId)) {
          fixture.mutations += 1;
          fixture.receipts.set(body.operationId, {
            receiptId: `receipt-${body.operationId}`,
            revision: 2,
          });
        }
        if (
          ["receipt_recovery", "unsafe_default", "no_alarm"].includes(
            fixture.scenario,
          ) &&
          fixture.effectAttempts.length === 1
        )
          return;
        return sendJson(response, {
          receipt: fixture.receipts.get(body.operationId),
        });
      }
      case "/read":
        fixture.productReads += 1;
        if (
          fixture.scenario === "recovery_tool_cancelled" ||
          ([
            "recovery_read_restart",
            "recovery_read_revoked",
            "recovery_read_expired",
          ].includes(fixture.scenario) &&
            fixture.productReads === 1)
        ) {
          fixture.heldReadResponse = response;
          return;
        }
        return sendJson(response, { revision: 2, product: "financier" });
      case "/draft-committed":
        fixture.draftCommits.push(body);
        if (fixture.draftCommits.length === 1) return;
        return sendJson(response, { acknowledged: true });
      case "/draft-owner-availability":
        return sendJson(response, { available: fixture.draftOwnerAvailable });
      case "/code-result-held":
        if (fixture.scenario === "draft_browser_restricted")
          return sendJson(response, { acknowledged: true });
        if (fixture.codeResult !== undefined)
          return sendJson(response, { acknowledged: true });
        fixture.codeResult = body;
        fixture.codeResponse = response;
        if (fixture.scenario === "provider_codemode_organisation_settlement")
          return sendJson(response, { acknowledged: true });
        return;
      case "/organisation-settlement-held":
        fixture.organisationSettlementAttempts.push(body);
        if (fixture.organisationSettlement !== undefined)
          return sendJson(response, { acknowledged: true });
        fixture.organisationSettlement = body;
        return;
      case "/extension-blocked":
        return sendJson(response, { acknowledged: true });
      case "/partial-model-observed":
        fixture.partialModelObserved = body;
        fixture.steeringModelHeld = true;
        return sendJson(response, { acknowledged: true });
      case "/model-usage-evidence":
        return sendJson(
          response,
          fixture.modelUsageReceipt ?? { kind: "pending" },
        );
      case "/rejected-tool-result":
        fixture.rejectedToolResults.push(body);
        if (fixture.scenario === "recovery_read_expired") return;
        return sendJson(response, { ok: true });
      case "/model":
        fixture.modelRequests += 1;
        if (
          fixture.scenario.startsWith("proposal_") ||
          fixture.scenario.startsWith("provider_")
        )
          return sendJson(
            response,
            proposalModelResponse(fixture, body.messages),
          );
        if (
          [
            "canonical_interruption",
            "model_interruption",
            "cancelled",
            "restart_admission",
            "cancelled_restart",
            "recovery_unknown_usage",
            "recovery_portable_unknown_usage",
          ].includes(fixture.scenario) &&
          fixture.modelRequests === 1
        )
          return;
        if (fixture.scenario.startsWith("recovery_"))
          return sendJson(
            response,
            body.messages.some(isToolResult)
              ? {
                  content:
                    fixture.scenario === "recovery_tool_denied"
                      ? "Draft access was denied."
                      : "COMPLETE",
                  stopReason: "stop",
                }
              : {
                  content: [
                    {
                      type: "toolCall",
                      id: "draft_read_1",
                      name: "product_description_draft_read",
                      arguments: { productId: "product_financier" },
                    },
                  ],
                  stopReason: "toolUse",
                },
          );
        if (
          integrationScenarios.includes(fixture.scenario) ||
          fixture.scenario === "model_usage_rollback" ||
          fixture.scenario === "completion_commit" ||
          fixture.scenario === "portable_completion" ||
          checkpointScenarios.includes(fixture.scenario)
        )
          return sendJson(response, { content: "COMPLETE" });
        return sendJson(response, modelResponse(fixture, body.messages));
      case "/commit-held":
        fixture.heldCommit = body.seq;
        if (
          fixture.scenario === "recovery_unknown_usage" &&
          fixture.modelRequests > 1
        )
          return sendJson(response, { acknowledged: true });
        return;
      case "/proposal-result-held":
        fixture.heldProposal = body.result;
        if (codeModeTrial) fixture.proposalResponse = response;
        return;
      case "/rollback-held":
        fixture.rejectedUsage = body.tokens;
        return;
      case "/steering-held":
        fixture.steeringHandoff = body;
        // The held call ends with a tool call, so the run takes the steer.
        if (fixture.steeringModel !== undefined) {
          writeModelResult(
            fixture.steeringModel.response,
            fixture.steeringModel.model,
            "native_9",
            modelToolCall(
              "draft_steered_read",
              "product_description_draft_read",
              { productId: "product_financier" },
            ),
          );
          fixture.steeringModel = undefined;
        }
        return sendJson(response, { acknowledged: true });
      case "/cancellation-held":
        fixture.cancellationHeld = body;
        return;
      case "/input-admission-held":
        fixture.inputAdmissionResponse = response;
        return;
      case "/portal-settled-held":
        if (fixture.portalSettlement !== undefined)
          return sendJson(response, { acknowledged: true });
        fixture.portalSettlement = body;
        return;
      case "/checkpoint-rollback-held":
        fixture.rejectedCheckpoint = true;
        return;
      case "/upload-held":
        fixture.heldUpload = body.checkpointSha256;
        return;
      default:
        throw new Error(`Unknown provider path ${request.url}`);
    }
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
    console.error("Trial provider failed:", String(error));
    const scenario = new URL(
      request.url,
      "http://fixture.test",
    ).searchParams.get("scenario");
    const fixture = fixtures.get(scenario);
    if (fixture !== undefined) fixture.providerFailure = String(error);
  }
}

function sendJson(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function respondOpenRouter(fixture, body, request, response) {
  assert.equal(
    request.headers.authorization,
    "Bearer native-model-fixture-key",
  );
  assert.equal(body.model, "qwen/qwen3.7-flash");
  assert(body.max_tokens > 0 && body.max_tokens <= 10000);
  fixture.modelRequests += 1;
  // The queued follow-up's second model call waits for the native steer;
  // the steering input joins this run after the call's tool result.
  if (fixture.scenario === "draft_browser" && fixture.modelRequests === 9) {
    assert(
      body.messages
        .at(-1)
        .content.includes("Golden toasted almond financier. Serve with tea."),
    );
    fixture.steeringModel = { response, model: body.model };
    fixture.steeringModelHeld = true;
    return;
  }
  if (
    isModelCancellationScenario(fixture.scenario) &&
    fixture.modelRequests === 3
  ) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.write(
      `data: ${JSON.stringify({
        id: "native_partial_cancel",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: "R50_PARTIAL_RESPONSE_UNACCEPTED",
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    return;
  }
  const messages = body.messages.map(nativeModelMessage);
  const compaction = body.messages.some(isCompactionPrompt);
  const result = compaction
    ? {
        content:
          "The operator requested a price proposal. Preserve the pending governed action.",
      }
    : draftBrowser
      ? draftBrowserModelResponse(fixture, body)
      : draft
        ? draftModelResponse(fixture, body)
        : codeModeTrial
          ? codeModeModelResponse(fixture, body)
          : proposalModelResponse(fixture, messages);
  writeModelResult(
    response,
    body.model,
    `native_${fixture.modelRequests}`,
    result,
  );
}

function writeModelResult(response, model, id, result) {
  let delta;
  let reason;
  if (typeof result.content === "string") {
    delta = { role: "assistant", content: result.content };
    reason = "stop";
  } else {
    const tool = result.content[0];
    delta = {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: tool.id,
          type: "function",
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.arguments),
          },
        },
      ],
    };
    reason = "tool_calls";
  }
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const chunk of chunks)
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function providerToolName(tool) {
  return tool.function.name;
}

function draftBrowserModelResponse(fixture, body) {
  const productId = "product_financier";
  const last = body.messages.at(-1);
  if (
    fixture.scenario === "draft_browser_restricted" &&
    fixture.modelRequests >= 3
  ) {
    if (fixture.modelRequests === 3)
      return modelToolCall(
        "draft_restricted",
        "product_description_draft_edit",
        {
          productId,
          oldText: "Almond financier.",
          newText: "Restricted source edit.",
        },
      );
    assert.equal(fixture.modelRequests, 4);
    assert.equal(JSON.parse(last.content).success, false);
    assert(
      fixture.draftDenial.reason.includes("Connect this Slack thread"),
      fixture.draftDenial.reason,
    );
    return {
      content: JSON.stringify({
        kind: "reply",
        text: "The source restrictions prevent sharing this edit with the draft room.",
      }),
    };
  }
  switch (fixture.modelRequests) {
    case 1:
      return modelToolCall("discover_draft", "tool_search", {
        query: "product_description_draft_read product_description_draft_edit",
        limit: 2,
      });
    case 2:
      return modelToolCall("draft_code_read", "codemode", {
        code: 'const value = await tools.product_description_draft_read({productId:"product_financier"}); store("originalDraft", value); text(value);',
      });
    case 3:
      assert(last.content.includes("Almond financier."), last.content);
      assert(fixture.browserHuman);
      return modelToolCall("draft_stale", "product_description_draft_edit", {
        productId,
        oldText: "Almond financier.",
        newText: "Golden almond financier.",
      });
    case 4:
      assert.equal(JSON.parse(last.content).success, false, last.content);
      assert(
        fixture.draftDenial.reason.includes("passage_conflict"),
        fixture.draftDenial.reason,
      );
      return modelToolCall("draft_reread", "product_description_draft_read", {
        productId,
      });
    case 5:
      assert(last.content.includes("Toasted almond financier."), last.content);
      return modelToolCall(
        "draft_edit_original",
        "product_description_draft_edit",
        {
          productId,
          oldText: "Toasted almond financier.",
          newText: "Golden toasted almond financier.",
        },
      );
    case 6:
      assert(
        last.content.includes("Golden toasted almond financier."),
        last.content,
      );
      assert(!last.content.includes("Serve with tea."), last.content);
      return modelToolCall(
        "draft_read_recovered",
        "product_description_draft_read",
        { productId },
      );
    case 7:
      assert(
        last.content.includes(
          "Golden toasted almond financier. Serve with tea.",
        ),
        last.content,
      );
      return {
        content: JSON.stringify({
          kind: "reply",
          text: "The saved draft keeps the toasted almond wording and the operator’s serving note. Review it before publication.",
        }),
      };
    case 8:
      assert(
        last.content.includes("Read the saved draft again after recovery."),
        last.content,
      );
      return modelToolCall(
        "draft_queued_read",
        "product_description_draft_read",
        { productId },
      );
    case 10:
      // The steering message follows the held call's tool result.
      assert(
        last.content.includes(
          "Keep the serving note. Give a short review summary.",
        ),
        last.content,
      );
      assert(
        body.messages
          .at(-2)
          .content.includes("Golden toasted almond financier. Serve with tea."),
      );
      return {
        content: JSON.stringify({
          kind: "reply",
          text: "The serving note is preserved. The draft is ready for review.",
        }),
      };
    default:
      throw new Error(
        `Unexpected draft model request ${fixture.modelRequests}`,
      );
  }
}

function draftBrowserHeld(fixture) {
  if (fixture.providerFailure !== undefined)
    throw new Error(fixture.providerFailure);
  return fixture.draftAccepted !== undefined && fixture.draftOverride === true;
}

async function evaluateDraftBrowserScenario(scenario) {
  const fixture = createFixture(scenario);
  fixture.commerce = await createCommerce();
  fixture.providerAttempts = 0;
  fixture.providerCommands = [];
  fixture.providerCommitted = null;
  fixture.receiptAvailable = false;
  fixtures.set(scenario, fixture);
  const persistence = join(artifacts, scenario);
  const logs = [];
  let runtime = null;
  try {
    runtime = await launch(persistence);
    await request(runtime, scenario, "/prepare-draft");
    if (scenario === "draft_browser_restricted") {
      assert.equal((await request(runtime, scenario, "/start")).accepted, true);
      const after = await waitFor(
        proposalRecovered.bind(null, runtime, scenario),
        "restricted draft effect denial",
      );
      const receipts = await request(runtime, scenario, "/draft-evidence");
      assert.equal(receipts.length, 0);
      assert.equal(fixture.modelRequests, 4);
      return {
        scenario,
        status: "passed",
        after,
        receipts,
        denial: fixture.draftDenial,
        trace: fixture.events,
        logs: runtime.logs,
      };
    }
    console.log(`Browser ready: ${runtime.url}fixture/user/1`);
    await waitFor(
      browserReady.bind(null, fixture),
      "two draft browser clients",
      180_000,
    );
    assert.equal((await request(runtime, scenario, "/start")).accepted, true);
    await waitFor(
      codeResultHeld.bind(null, fixture),
      "draft initial Code Mode read",
    );
    await request(runtime, scenario, "/share-trial");
    await request(runtime, scenario, "/promote-contributor");
    fixture.sharedExecution = true;
    await waitFor(
      draftBrowserHeld.bind(null, fixture),
      "accepted draft and later human edit",
      120_000,
    );
    const before = await request(runtime, scenario, "/snapshot");
    const receipts = await request(runtime, scenario, "/draft-evidence");
    const queuedBefore = before.submissions.filter(isDraftQueuedSubmission);
    assert.equal(queuedBefore.length, 1);
    assert.equal(queuedBefore[0].status, "queued");
    assert.equal(receipts.length, 1, JSON.stringify(receipts));
    assert.equal(
      receipts[0].draft_description,
      "Golden toasted almond financier.",
    );
    assert.equal(fixture.modelRequests, 5);
    assert(before.codeStore.values.originalDraft);
    await stop(runtime, true);
    logs.push(...runtime.logs);
    runtime = await launch(persistence);
    await waitFor(
      steeringModelHeld.bind(null, fixture),
      "queued follow-up ready for steering",
    );
    fixture.browserRecovered = true;
    const after = await waitFor(
      proposalRecovered.bind(null, runtime, scenario),
      "recovered collaborative draft",
    );
    // The steer joins the queued follow-up's run, which answers both.
    assert.equal(fixture.modelRequests, 10);
    const queuedAfter = after.submissions.filter(isDraftQueuedSubmission);
    assert.equal(queuedAfter.length, 1);
    assert.equal(queuedAfter[0].id, queuedBefore[0].id);
    assert.equal(queuedAfter[0].status, "done");
    assert.equal(after.inputControl.phase, "complete");
    assert.deepEqual(
      await request(runtime, scenario, "/draft-evidence"),
      receipts,
    );
    assert.deepEqual(after.codeStore, before.codeStore);
    fixture.browserComplete = true;
    await waitFor(
      browserObserved.bind(null, fixture),
      "both browsers after draft recovery",
      120_000,
    );
    const nonce = fixture.browserEvidence.proposal.nonce;
    await waitFor(
      draftApprovalObserved.bind(null, fixture),
      "both operators observe the pending governed action",
      60_000,
    );
    assert.equal(fixture.browserApproval.action.state, "proposed");
    assert.equal(fixture.browserApproval.action.nonce, nonce);
    assert.equal(fixture.browserApproval.action.receipt, null);
    const session = await request(runtime, scenario, "/operator-session");
    const unsigned = await postProviderControl(
      runtime,
      nonce,
      "execute",
      session,
      "draft-before-approval",
    );
    assert.equal(unsigned.status, 409, JSON.stringify(unsigned));
    const approval = await request(
      runtime,
      scenario,
      `/approval-fixture?nonce=${nonce}`,
    );
    const approved = await postProviderControl(
      runtime,
      nonce,
      "approval",
      session,
      "draft-approve",
      approval.grant,
    );
    assert.equal(approved.status, 200, JSON.stringify(approved));
    const lost = await postProviderControl(
      runtime,
      nonce,
      "execute",
      session,
      "draft-execute",
    );
    assert.equal(lost.status, 503, JSON.stringify(lost));
    assert.equal(fixture.mutations, 1);
    await stop(runtime, true);
    logs.push(...runtime.logs);
    runtime = await launch(persistence);
    fixture.receiptAvailable = true;
    const settled = await postProviderControl(
      runtime,
      nonce,
      "execute",
      session,
      "draft-reconcile",
    );
    assert.equal(settled.status, 200, JSON.stringify(settled));
    assert.equal(
      settled.body.receipt.receiptId,
      fixture.providerCommitted.receiptId,
    );
    assert.equal(fixture.mutations, 1);
    const product = (await commerceRecords(fixture, ["product"])).product.find(
      (row) => row.resource_id === "product_financier",
    );
    assert.equal(
      product.description,
      fixture.browserEvidence.recovered.draft.description,
    );
    assert.equal(product.revision, 2);
    fixture.publicationNonce = nonce;
    await waitFor(
      draftPublicationDelivered.bind(null, fixture),
      "both operators read the confirmed publication",
      120_000,
    );
    assert.equal(
      fixture.browserDelivery.publication.receipt.receiptId,
      settled.body.receipt.receiptId,
    );
    assert.equal(fixture.browserDelivery.publication.nonce, nonce);
    assert.equal(fixture.mutations, 1);
    return {
      scenario,
      status: "passed",
      before,
      after,
      receipts,
      queuedRecovery: { before: queuedBefore[0], after: queuedAfter[0] },
      publication: {
        unsigned,
        approved,
        lost,
        settled,
        product,
        mutations: fixture.mutations,
        commands: fixture.providerCommands,
      },
      browser: fixture.browserEvidence,
      delivery: fixture.browserDelivery,
      attention: fixture.browserApproval,
      trace: fixture.events,
      logs: [...logs, ...runtime.logs],
    };
  } catch (error) {
    return {
      scenario,
      status: "failed",
      error: String(error),
      trace: fixture.events,
      snapshot:
        runtime === null
          ? null
          : await request(runtime, scenario, "/snapshot").catch(failedSnapshot),
      logs: [...logs, ...(runtime?.logs ?? [])],
    };
  } finally {
    await stop(runtime, false);
    await fixture.commerce?.dispose();
  }
}

function draftPublicationDelivered(fixture) {
  return fixture.browserDelivery !== undefined;
}

function draftApprovalObserved(fixture) {
  return fixture.browserApproval !== undefined;
}

function isDraftQueuedSubmission(submission) {
  return submission.requestId.includes(
    ":next:request_draft_followup:input_draft_followup:",
  );
}

function modelToolCall(id, name, args) {
  return { content: [{ type: "toolCall", id, name, arguments: args }] };
}

function browserReady(fixture) {
  return fixture.browserReady === true;
}

function browserObserved(fixture) {
  return fixture.browserEvidence !== undefined;
}

// Commerce's records for the trial merchant, read through the fixture
// Worker; the evaluation compares them before and after each fault.
async function commerceRecords(fixture, tables) {
  return fixture.commerce.fixture("merchant_plan50_draft", {
    kind: "merchant_records",
    tables,
  });
}

function codeModeModelResponse(fixture, body) {
  const names = body.tools.map(providerToolName);
  if (fixture.modelRequests === 1) {
    assert.deepEqual(names.sort(), ["codemode", "tool_search"]);
    const input = body.messages.find(isUserMessage);
    assert.equal(input.content[1].type, "image_url");
    assert(input.content[1].image_url.url.startsWith("data:image/png;base64,"));
    return {
      content: [
        {
          type: "toolCall",
          id: "discover_original",
          name: "tool_search",
          arguments: {
            query: "commerce_propose_action inventory_read",
            limit: 2,
          },
        },
      ],
    };
  }
  if (fixture.modelRequests === 2) {
    assert(names.includes("commerce_propose_action"));
    const remote = body.tools.find(isInventoryTool).function.name;
    const proposal = proposalToolCall(fixture.scenario).content[0].arguments;
    return {
      content: [
        {
          type: "toolCall",
          id: "code_original",
          name: "codemode",
          arguments: {
            code: `const reads = await Promise.all([tools.${remote}({}), tools.${remote}({})]); store("inventory", JSON.parse(reads[0]).count + JSON.parse(reads[1]).count); const value = JSON.parse(await tools.commerce_propose_action(${JSON.stringify(proposal)})); store("proposal", value); text(load("proposal"));`,
          },
        },
      ],
    };
  }
  if (fixture.modelRequests === 4) {
    assert(names.includes("codemode"));
    return {
      content: [
        {
          type: "toolCall",
          id: "code_followup",
          name: "codemode",
          arguments: {
            code: 'text(load("proposal")); text(load("inventory"));',
          },
        },
      ],
    };
  }
  if (fixture.modelRequests === 5) {
    const last = body.messages[body.messages.length - 1];
    assert.equal(last.tool_call_id, "code_followup");
    assert(last.content.includes(fixture.heldProposal.proposalId));
    assert(last.content.includes("14"));
  }
  assert(!names.includes("codemode"));
  assert(names.includes("commerce_propose_action"));
  return {
    content: JSON.stringify(
      fixture.modelRequests === 5
        ? {
            kind: "question",
            question: {
              title: "Review the saved proposal?",
              description: "The price change still needs operator approval.",
              allowCustom: true,
              options: [
                {
                  id: "review",
                  label: "Review",
                  description: "Inspect the saved proposal.",
                },
              ],
            },
          }
        : {
            kind: "reply",
            text: "The saved proposal and Code Mode result were recovered.",
          },
    ),
  };
}

function isModelCancellationScenario(scenario) {
  return (
    scenario === "provider_codemode_cancel" ||
    scenario === "provider_codemode_effect_cancel"
  );
}

async function readTaskProjection(runtime, scenario, turnId, requester = null) {
  const url = new URL("/portal-tasks", runtime.url);
  url.searchParams.set("scenario", scenario);
  url.searchParams.set("turn", turnId);
  const response = await fetch(url, {
    headers: requester === null ? {} : { "x-trial-user-id": requester },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const projection = await response.json();
  assert(projection.items.length > 0);
  for (const item of projection.items) {
    assert.deepEqual(Object.keys(item).sort(), ["id", "label", "state"]);
    assert(
      [
        "Response",
        "Tool call",
        "Prepare context",
        "Background work",
        "Task",
      ].includes(item.label),
    );
  }
  return projection;
}

function isRunningResponseTask(item) {
  return item.label === "Response" && item.state.kind === "running";
}

function isCompletedTaskItem(item) {
  return item.state.kind === "completed";
}

async function prepareCancelledEffect(runtime, scenario, fixture) {
  const nonce = fixture.heldProposal.nonce;
  const session = await request(runtime, scenario, "/operator-session");
  const approval = await request(
    runtime,
    scenario,
    `/approval-fixture?nonce=${nonce}`,
  );
  const approved = await postProviderControl(
    runtime,
    nonce,
    "approval",
    session,
    "cancel-effect-approve",
    approval.grant,
  );
  assert.equal(approved.status, 200, JSON.stringify(approved));
  const lost = await postProviderControl(
    runtime,
    nonce,
    "execute",
    session,
    "cancel-effect-execute",
  );
  assert.equal(lost.status, 503, JSON.stringify(lost));
  assert.equal(fixture.mutations, 1);
  const deferred = await request(runtime, scenario, "/defer-effect");
  assert.equal(deferred.nonce, nonce);
  return { nonce, session, taskId: deferred.taskId };
}

async function waitingEffectCancellation(runtime, scenario, taskId) {
  const snapshot = await request(runtime, scenario, "/snapshot");
  const task = snapshot.tasks.find(matchesTask.bind(null, taskId));
  if (snapshot.lifecycle.kind !== "cancelling" || task?.abortRequested !== true)
    return null;
  assert.notEqual(task.state.status, "terminal");
  assert.equal(snapshot.inputControl.phase, "queued");
  assert.equal(snapshot.owners.organisation[0].state, "indeterminate");
  assert.equal(snapshot.oldLease.ok, false);
  return snapshot;
}

async function evaluateCodeModeScenario(scenario) {
  const fixture = createFixture(scenario);
  fixture.commerce = await createCommerce();
  fixture.providerAttempts = 0;
  fixture.providerCommands = [];
  fixture.providerCommitted = null;
  fixture.receiptAvailable = false;
  fixtures.set(scenario, fixture);
  let runtime = null;
  const logs = [];
  try {
    const persistence = join(artifacts, scenario);
    runtime = await launch(persistence);
    const accepted = await request(runtime, scenario, "/start");
    assert.equal(accepted.accepted, true, accepted.error);
    await waitFor(proposalHeld.bind(null, fixture), "nested proposal result");
    const deniedCommands = await verifyDeniedPortalCommands(runtime, scenario);
    const watch =
      scenario === "provider_codemode_restart"
        ? await request(runtime, scenario, "/watch-probe")
        : null;
    const ownership =
      scenario === "provider_codemode_restart"
        ? await request(runtime, scenario, "/ownership-probe")
        : null;
    if (ownership !== null) {
      assert.equal(ownership.ordinary.parent.state.outcome.status, "aborted");
      assert.equal(ownership.ordinary.child.state.outcome.status, "aborted");
      assert.notEqual(ownership.ordinary.background.state.status, "terminal");
      assert.equal(ownership.all.background.state.outcome.status, "aborted");
      assert.deepEqual(ownership.abortOrder, ["child", "parent", "background"]);
    }
    const alarmSchedule =
      scenario === "provider_codemode_restart"
        ? await request(runtime, scenario, "/alarm-schedule-probe")
        : null;
    if (alarmSchedule !== null) {
      assert.equal(alarmSchedule.afterLater, alarmSchedule.initial);
      assert.equal(alarmSchedule.afterEarlier, alarmSchedule.earlier);
    }
    let steering = null;
    let withdrawal = null;
    let sharedContributor = null;
    let commandRevocation = null;
    let queuedIdentity = null;
    if (scenario === "provider_codemode_queue") {
      sharedContributor = await request(runtime, scenario, "/share-trial");
      const deniedUrl = new URL("/queue", runtime.url);
      deniedUrl.searchParams.set("scenario", scenario);
      const viewerDenied = await fetch(deniedUrl, {
        headers: { "x-trial-user-id": sharedContributor.contributorId },
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(viewerDenied.status, 403);
      await request(runtime, scenario, "/promote-contributor");
      commandRevocation = await verifyCommandRevocation(
        runtime,
        scenario,
        fixture,
        sharedContributor.contributorId,
      );
      const command = "/queue";
      steering = await requestJson(
        runtime,
        scenario,
        command,
        queuedPortalCommand("retained"),
        sharedContributor.contributorId,
      );
      assert.equal(steering.status, "queued");
      assert.deepEqual(
        await requestJson(
          runtime,
          scenario,
          command,
          queuedPortalCommand("retained"),
          sharedContributor.contributorId,
        ),
        steering,
      );
      assert(steering.requestId.includes(sharedContributor.contributorId));
      queuedIdentity = await verifyQueuedCommandIdentity(
        runtime,
        scenario,
        sharedContributor.contributorId,
        steering,
      );
      const discarded = await requestJson(
        runtime,
        scenario,
        "/queue",
        queuedPortalCommand("discard"),
      );
      assert.equal(discarded.status, "queued");
      const withdrawn = await requestJson(
        runtime,
        scenario,
        "/withdraw",
        withdrawalPortalCommand("discard"),
      );
      assert.deepEqual(withdrawn, { outcome: "aborted" });
      assert.deepEqual(
        await requestJson(
          runtime,
          scenario,
          "/withdraw",
          withdrawalPortalCommand("discard"),
        ),
        { outcome: "settled" },
      );
      withdrawal = { submissionId: discarded.id, outcome: withdrawn.outcome };
    }
    sendJson(fixture.proposalResponse, { acknowledged: true });
    await waitFor(codeResultHeld.bind(null, fixture), "saved Code Mode result");
    const before = await request(runtime, scenario, "/snapshot");
    const initialInput = JSON.parse(before.history[0].payload).entry;
    if (
      scenario === "provider_codemode_restart" ||
      scenario === "provider_codemode_queue"
    ) {
      fixture.taskInspection = {
        before: await readTaskProjection(
          runtime,
          scenario,
          before.lease.turn.turnId,
        ),
      };
      assert(fixture.taskInspection.before.items.some(isRunningResponseTask));
      if (scenario === "provider_codemode_queue") {
        const pending = fixture.taskInspection.before.pendingInputs;
        assert.equal(pending.length, 1);
        assert.equal(pending[0].inputId, "input_retained");
        assert.equal(pending[0].requestId, "request_retained");
        assert.equal(pending[0].mode, "next");
        assert.deepEqual(pending[0].parts, [
          { kind: "text", text: queuedPortalCommand("retained").text },
        ]);
        assert(Number.isSafeInteger(pending[0].acceptedAt));
        assert.deepEqual(Object.keys(pending[0]).sort(), [
          "acceptedAt",
          "inputId",
          "mode",
          "parts",
          "requestId",
        ]);
      }
      if (sharedContributor !== null) {
        fixture.taskInspection.shared = await readTaskProjection(
          runtime,
          scenario,
          before.lease.turn.turnId,
          sharedContributor.contributorId,
        );
        assert.deepEqual(
          fixture.taskInspection.shared,
          fixture.taskInspection.before,
        );
      }
    }
    assert.equal(initialInput.content[1].kind, "attachment");
    assert.equal(
      initialInput.content[1].attachment.displayName,
      "inventory.png",
    );
    if (isSettlementScenario(scenario)) {
      assert.equal(fixture.codeResult.taskResult.kind, "pending_settlement");
      assert.equal(fixture.codeResult.taskResult.outcome, "succeeded");
      assert.equal(
        before.lifecycle.state.activeTurn.kind,
        "awaiting_execution",
      );
    } else {
      assert(before.codeStore.values.proposal);
      assert.equal(before.codeStore.values.inventory, 14);
    }
    assert.equal(fixture.modelRequests, 2);
    let observers = [];
    let portalObservers = [];
    if (steering === null || sharedContributor !== null) {
      observers = await Promise.all([
        observeAcceptedProgress(runtime, scenario),
        observeAcceptedProgress(runtime, scenario),
      ]);
      assert.deepEqual(observers[0], observers[1]);
      assert.deepEqual(observers[0].map(eventTool), [
        "tool_search",
        "codemode",
      ]);
      portalObservers = await Promise.all([
        observeAcceptedProgress(
          runtime,
          scenario,
          "/portal-replay",
          "progress",
          sharedContributor?.contributorId ?? null,
        ),
        observeAcceptedProgress(
          runtime,
          scenario,
          "/portal-replay",
          "progress",
        ),
      ]);
      assert.deepEqual(portalObservers[0], portalObservers[1]);
      assert.deepEqual(portalObservers[0].map(progressLabel), [
        "Using tool_search.",
        "Using codemode.",
      ]);
      assert.equal(
        (await request(runtime, scenario, "/snapshot")).lifecycle.kind,
        "processing",
      );
    }
    const modelRequestsBeforeRestart = fixture.modelRequests;
    await stop(runtime, true);
    logs.push(...runtime.logs);
    runtime = await launch(persistence);
    await waitFor(
      nativeModelResumed.bind(null, fixture),
      "alarm-driven model dispatch before any Actor request",
    );
    const alarmRecovery = {
      modelRequestsBeforeRestart,
      modelRequestsBeforeActorRead: fixture.modelRequests,
      clientRequestsAfterRestart: 0,
    };
    if (isModelCancellationScenario(scenario)) {
      await waitFor(
        steeringModelHeld.bind(null, fixture),
        "partial model response delivered before cancellation",
      );
      assert.deepEqual(fixture.partialModelObserved, {
        scenario,
        type: "text_delta",
        delta: "R50_PARTIAL_RESPONSE_UNACCEPTED",
      });
      const externalEffect = effectCancellation
        ? await prepareCancelledEffect(runtime, scenario, fixture)
        : null;
      const queued = await requestJson(
        runtime,
        scenario,
        "/queue",
        queuedPortalCommand("cancelled"),
      );
      const cancellation = request(runtime, scenario, "/cancel").catch(
        expectedInterruptedCommand,
      );
      await waitFor(
        cancellationHeld.bind(null, fixture),
        "durable cancellation admission",
      );
      await stop(runtime, true);
      logs.push(...runtime.logs);
      await cancellation;
      runtime = await launch(persistence);
      let effectSettlement = null;
      if (externalEffect !== null) {
        const waiting = await waitFor(
          waitingEffectCancellation.bind(
            null,
            runtime,
            scenario,
            externalEffect.taskId,
          ),
          "external effect cancellation waits for receipt",
        );
        const pending = await postProviderControl(
          runtime,
          externalEffect.nonce,
          "execute",
          externalEffect.session,
          "cancel-effect-reconcile-pending",
        );
        assert.equal(pending.status, 202, JSON.stringify(pending));
        assert.equal(fixture.mutations, 1);
        await stop(runtime, true);
        logs.push(...runtime.logs);
        runtime = await launch(persistence);
        const cold = await waitFor(
          waitingEffectCancellation.bind(
            null,
            runtime,
            scenario,
            externalEffect.taskId,
          ),
          "external receipt wait survives another restart",
        );
        assert.deepEqual(cold.history, waiting.history);
        assert.equal(fixture.modelRequests, 3);
        fixture.receiptAvailable = true;
        const recovered = await postProviderControl(
          runtime,
          externalEffect.nonce,
          "execute",
          externalEffect.session,
          "cancel-effect-reconcile-known",
        );
        assert.equal(recovered.status, 200, JSON.stringify(recovered));
        effectSettlement = {
          taskId: externalEffect.taskId,
          waiting,
          cold,
          pending,
          recovered,
        };
      }
      const after = await waitFor(
        completedCancellationState.bind(null, runtime, scenario),
        "assignment cancellation recovery",
      );
      assert.equal(fixture.modelRequests, 3);
      assert.equal(after.budget.usage.tokens, 300);
      assert.equal(after.budget.reservation.kind, "indeterminate");
      assert.equal(after.budget.reservation.reason, "model_receipt_missing");
      assert(after.tasks.every(terminalTask));
      if (effectSettlement !== null) {
        const effectTask = after.tasks.find(
          matchesTask.bind(null, effectSettlement.taskId),
        );
        assert.equal(effectTask.state.outcome.status, "aborted");
        assert.equal(
          effectTask.state.outcome.result.nonce,
          externalEffect.nonce,
        );
        assert.equal(effectTask.state.outcome.result.state, "confirmed");
        assert.equal(after.owners.organisation[0].state, "confirmed");
        assert.equal(fixture.mutations, 1);
        effectSettlement.owner = await providerOwnerEvidence(fixture);
        assert.equal(effectSettlement.owner.receipts.length, 1);
        assert.equal(effectSettlement.owner.offer.amount_minor, 2500);
        const settledReceipt = JSON.parse(
          effectTask.state.outcome.result.providerResult,
        );
        assert.equal(
          settledReceipt.receiptId,
          effectSettlement.owner.committed.receiptId,
        );
        assert.equal(
          settledReceipt.effectId,
          effectSettlement.owner.committed.effectId,
        );
        assert.equal(settledReceipt.actionNonce, externalEffect.nonce);
        for (const command of effectSettlement.owner.commands)
          assert.deepEqual(command, effectSettlement.owner.commands[0]);
      }

      assert(after.submissions.every(unansweredSubmission));
      assert.equal(after.inputControl.phase, "complete");
      // Pi 1.5 stores a streamed partial up to a second late, so the restart
      // can drop it; a partial that was stored stays an aborted entry.
      const abortedPartials = after.entries.filter(isCancelledPartialEntry);
      assert(abortedPartials.length <= 1);
      for (const partial of abortedPartials)
        assert.equal(partial.model[0].stopReason, "aborted");
      assert(
        !JSON.stringify(after.history).includes(
          "R50_PARTIAL_RESPONSE_UNACCEPTED",
        ),
      );
      const replay = await readCompletedReplay(runtime, scenario, -1);
      assert.equal(replay.at(-1).detail, "Stopped by operator.");
      const repeated = await request(runtime, scenario, "/cancel");
      assert.equal(
        repeated.cancellationId,
        fixture.cancellationHeld.cancellationId,
      );
      const repeatedState = await request(runtime, scenario, "/snapshot");
      assert.deepEqual(repeatedState.budget, after.budget);
      assert.deepEqual(
        await request(runtime, scenario, "/reconcile-model-usage"),
        {
          reconciled: false,
          reason: "pending",
        },
      );
      const expectedUsage = after.inputControl.command.modelUsage;
      const receipt = {
        kind: "known",
        modelRequestId: expectedUsage.modelRequestId,
        runId: expectedUsage.runId,
        reservationId: expectedUsage.reservationId,
        tokens: 37,
      };
      fixture.modelUsageReceipt = {
        ...receipt,
        modelRequestId: "unrelated_model_request",
      };
      assert.deepEqual(
        await request(runtime, scenario, "/reconcile-model-usage"),
        {
          reconciled: false,
          reason: "evidence_mismatch",
        },
      );
      assert.deepEqual(
        (await request(runtime, scenario, "/snapshot")).budget,
        after.budget,
      );
      fixture.modelUsageReceipt = receipt;
      assert.deepEqual(
        await request(runtime, scenario, "/reconcile-model-usage"),
        { reconciled: true },
      );
      const reconciled = await request(runtime, scenario, "/snapshot");
      assert.equal(reconciled.budget.usage.tokens, 337);
      assert.equal(reconciled.budget.reservation.kind, "none");
      assert.deepEqual(reconciled.lifecycle, after.lifecycle);
      assert.deepEqual(reconciled.tasks, after.tasks);
      assert.deepEqual(reconciled.history, after.history);
      await stop(runtime, true);
      logs.push(...runtime.logs);
      runtime = await launch(persistence);
      assert.deepEqual(
        await request(runtime, scenario, "/reconcile-model-usage"),
        {
          reconciled: false,
          reason: "not_waiting",
        },
      );
      const reconciledAfterRestart = await request(
        runtime,
        scenario,
        "/snapshot",
      );
      assert.deepEqual(reconciledAfterRestart.budget, reconciled.budget);
      assert.deepEqual(reconciledAfterRestart.lifecycle, after.lifecycle);
      assert.deepEqual(reconciledAfterRestart.tasks, after.tasks);
      assert.equal(fixture.modelRequests, 3);
      return {
        scenario,
        status: "passed",
        before,
        after,
        queued,
        partialResponse: fixture.partialModelObserved,
        alarmRecovery,
        repeated,
        usageReconciliation: { receipt, reconciled, reconciledAfterRestart },
        effectSettlement,
        replay,
        deniedCommands,
        trace: fixture.events,
        logs: [...logs, ...runtime.logs],
      };
    }
    if (scenario === "provider_codemode_queue") {
      const after = await waitFor(
        completedQueuedState.bind(null, runtime, scenario),
        "completed queued input",
      );
      fixture.taskInspection.after = await readTaskProjection(
        runtime,
        scenario,
        after.checkpoint.turn.turnId,
      );
      assert(fixture.taskInspection.after.items.every(isCompletedTaskItem));
      assert.deepEqual(fixture.taskInspection.after.pendingInputs, []);
      assert.equal(fixture.modelRequests, 5);
      assert.equal(after.owners.case.proposals.length, 1);
      assert.equal(after.budget.usage.tokens, 750);
      assert.equal(after.codeStore.execution.turnId, "turn_plan50_followup_3");
      assert.deepEqual(after.executionAuthority, before.executionAuthority);
      assert.notEqual(
        after.executionAuthority.userId,
        sharedContributor.contributorId,
      );
      const sharedCompletion = await request(
        runtime,
        scenario,
        "/portal-conversation",
      );
      assert.equal(sharedCompletion.conversation.completedRequests.length, 2);
      const discarded = after.submissions.find(
        submissionHasId.bind(null, withdrawal.submissionId),
      );
      assert.equal(discarded.status, "unanswered");
      assert.equal(discarded.reason, "aborted");
      const followupInput = after.history.filter(isSteeringFact);
      assert.equal(followupInput.length, 1);
      assert.deepEqual(JSON.parse(followupInput[0].payload).entry.content, [
        { kind: "text", text: queuedPortalCommand("retained").text },
      ]);
      assert.equal(
        JSON.parse(followupInput[0].payload).entry.input.inputId,
        after.submissions[1].requestId,
      );
      await stop(runtime, true);
      logs.push(...runtime.logs);
      runtime = await launch(persistence);
      const reopened = await request(runtime, scenario, "/snapshot");
      assert.deepEqual(reopened.history, after.history);
      assert.deepEqual(reopened.submissions, after.submissions);
      assert.equal(fixture.modelRequests, 5);
      const completedSubmission = reopened.submissions.find(
        submissionHasId.bind(null, steering.id),
      );
      const reopenedIdentity = await verifyQueuedCommandIdentity(
        runtime,
        scenario,
        sharedContributor.contributorId,
        completedSubmission,
      );
      assert.deepEqual(
        await requestJson(
          runtime,
          scenario,
          "/withdraw",
          withdrawalPortalCommand("discard"),
        ),
        { outcome: "settled" },
      );
      assert.equal(fixture.modelRequests, 5);
      const sharedReconnect = await Promise.all([
        readCompletedReplay(
          runtime,
          scenario,
          portalObservers[0].at(-1).sequence,
          "/portal-replay",
          sharedContributor.contributorId,
        ),
        readCompletedReplay(
          runtime,
          scenario,
          portalObservers[1].at(-1).sequence,
          "/portal-replay",
        ),
      ]);
      assert.deepEqual(sharedReconnect[0], sharedReconnect[1]);
      assert.deepEqual(sharedReconnect[0].map(recordKind), [
        "assistant_text_delta",
      ]);
      return {
        scenario,
        status: "passed",
        before,
        after,
        reopened,
        deniedCommands,
        withdrawal,
        sharedContributor,
        commandRevocation,
        queuedIdentity,
        reopenedIdentity,
        sharedCompletion,
        sharedReconnect,
        portalObservers,
        alarmRecovery,
        trace: fixture.events,
        logs: [...logs, ...runtime.logs],
      };
    }
    if (isSettlementScenario(scenario)) {
      const after = await waitFor(
        completedPortableState.bind(null, runtime, scenario),
        "saved Code Mode output settled after restart",
      );
      assert.equal(after.owners.case.proposals.length, 1);
      assert.equal(after.codeStore.values.inventory, 14);
      assert.equal(
        after.codeStore.values.proposal.proposalId,
        fixture.heldProposal.proposalId,
      );
      assert.equal(fixture.modelRequests, 3);
      assert.deepEqual(fixture.mcpCalls, [
        "account",
        "inventory_read",
        "inventory_read",
      ]);
      assert(after.tasks.every(terminalTask));
      if (scenario === "provider_codemode_organisation_settlement") {
        assert.equal(fixture.organisationSettlementAttempts.length, 2);
        const [original, recovered] = fixture.organisationSettlementAttempts;
        assert.equal(original.result.value.kind, "settled");
        assert.equal(recovered.result.value.kind, "settled");
        assert.deepEqual(recovered.input, original.input);
        assert.deepEqual(recovered.result, original.result);
      }
      return {
        scenario,
        status: "passed",
        before,
        after,
        pendingSettlement: fixture.codeResult.taskResult,
        organisationSettlement: fixture.organisationSettlement ?? null,
        organisationSettlementAttempts: fixture.organisationSettlementAttempts,
        alarmRecovery,
        trace: fixture.events,
        logs: [...logs, ...runtime.logs],
      };
    }
    await waitFor(
      portalSettlementHeld.bind(null, fixture),
      "saved Portal completion before checkpoint finalization",
    );
    const savedPortal = await request(
      runtime,
      scenario,
      "/portal-conversation",
    );
    assert.equal(savedPortal.revision, fixture.portalSettlement.revision);
    await stop(runtime, true);
    logs.push(...runtime.logs);
    runtime = await launch(persistence);
    const after = await waitFor(
      completedPortableState.bind(null, runtime, scenario),
      "recovered Code Mode result",
    );
    assert.deepEqual(after.codeStore, before.codeStore);
    assert.deepEqual(after.history[0], before.history[0]);
    assert.equal(after.owners.case.proposals.length, 1);
    assert.equal(fixture.modelRequests, 3);
    const reconnected = await readCompletedReplay(
      runtime,
      scenario,
      observers[0].at(-1).sequence,
    );
    assert.deepEqual(
      reconnected.filter(isReplayEvent).map(replayEnvelope),
      after.replay.envelopes.slice(observers[0].length),
    );
    assert.equal(reconnected.at(-1).kind, "complete");
    const portalReconnected = await readCompletedReplay(
      runtime,
      scenario,
      portalObservers[0].at(-1).sequence,
      "/portal-replay",
    );
    assert.deepEqual(portalReconnected.map(recordKind), [
      "assistant_text_delta",
    ]);
    assert.equal(
      portalReconnected[0].text,
      "The saved proposal and Code Mode result were recovered.",
    );
    const portalCompletion = await request(
      runtime,
      scenario,
      "/portal-conversation",
    );
    assert.deepEqual(portalCompletion, savedPortal);
    assert.equal(portalCompletion.conversation.work.kind, "ready");
    assert.equal(
      portalCompletion.conversation.timeline.at(-1).kind,
      "assistant",
    );
    assert.equal(portalCompletion.conversation.historyBindings.length, 1);
    assert.deepEqual(
      await request(runtime, scenario, "/portal-completion"),
      portalCompletion,
    );
    const completionRecords = await readCompletedReplay(
      runtime,
      scenario,
      -1,
      "/portal-completion-stream",
    );
    assert.equal(completionRecords.at(-1).kind, "complete");
    assert.equal(
      completionRecords.at(-1).conversationRevision,
      portalCompletion.revision,
    );
    await stop(runtime, true);
    logs.push(...runtime.logs);
    runtime = await launch(persistence);
    const next = await request(runtime, scenario, "/followup");
    assert.equal(next.accepted, true);
    assert.notEqual(next.submissionId, accepted.submissionId);
    const followup = await waitFor(
      completedPortableState.bind(null, runtime, scenario),
      "load in a later accepted turn",
    );
    assert.equal(fixture.modelRequests, 5);
    assert.equal(followup.owners.case.proposals.length, 1);
    assert.deepEqual(followup.codeStore.values, before.codeStore.values);
    assert.equal(followup.codeStore.execution.turnId, "turn_plan50_followup_3");
    assert.equal(followup.history.length, after.history.length + 4);
    assert.equal(followup.budget.usage.tokens, 750);
    assert.deepEqual(followup.history[0], before.history[0]);
    assert.deepEqual(fixture.mcpCalls, [
      "account",
      "inventory_read",
      "inventory_read",
    ]);
    assert.equal(fixture.mcpSessions.size, 0);
    const portalAttention = await request(
      runtime,
      scenario,
      "/portal-conversation",
    );
    assert.equal(
      portalAttention.conversation.timeline.at(-1).question.title,
      "Review the saved proposal?",
    );
    assert.equal(portalAttention.conversation.historyBindings.length, 2);
    assert.equal(portalAttention.conversation.completedRequests.length, 2);
    fixture.taskInspection.after = await readTaskProjection(
      runtime,
      scenario,
      followup.checkpoint.turn.turnId,
    );
    assert(fixture.taskInspection.after.items.every(isCompletedTaskItem));
    assert.deepEqual(fixture.taskInspection.after.pendingInputs, []);
    const taskHistory = await request(runtime, scenario, "/task-history-probe");
    const boundedTasks = await readTaskProjection(
      runtime,
      scenario,
      followup.checkpoint.turn.turnId,
    );
    assert.equal(boundedTasks.tasksTruncated, true);
    assert.equal(boundedTasks.items.length, 101);
    assert.equal(boundedTasks.items[0].id, `task_${taskHistory.active}`);
    assert.deepEqual(
      boundedTasks.items.slice(1).map(taskItemId),
      taskHistory.completed.slice(-100).reverse().map(nativeTaskItemId),
    );
    fixture.taskInspection.after = boundedTasks;
    await stop(runtime, true);
    logs.push(...runtime.logs);
    runtime = await launch(persistence);
    fixture.taskInspection.reconnected = await readTaskProjection(
      runtime,
      scenario,
      followup.checkpoint.turn.turnId,
    );
    assert.deepEqual(
      fixture.taskInspection.reconnected,
      fixture.taskInspection.after,
    );
    assert.deepEqual(
      await request(runtime, scenario, "/portal-completion"),
      portalAttention,
    );
    assert(
      !JSON.stringify(fixture.events).includes("native-mcp-synthetic-secret"),
    );
    return {
      scenario,
      status: "passed",
      before,
      after,
      followup,
      observers,
      reconnected,
      portalObservers,
      portalReconnected,
      portalCompletion,
      completionRecords,
      portalAttention,
      savedPortal,
      deniedCommands,
      mcpCalls: fixture.mcpCalls,
      discovery: discoveryEvidence(fixture),
      watch,
      alarmRecovery,
      ownership,
      alarmSchedule,
      trace: fixture.events,
      logs: [...logs, ...runtime.logs],
    };
  } catch (error) {
    const snapshot =
      runtime === null
        ? null
        : await request(runtime, scenario, "/snapshot").catch(failedSnapshot);
    return {
      scenario,
      status: "failed",
      error: String(error),
      stack: error.stack,
      snapshot,
      trace: fixture.events,
      logs: [...logs, ...(runtime?.logs ?? [])],
    };
  } finally {
    if (runtime !== null) await stop(runtime, false);
    await fixture.commerce?.dispose();
  }
}
function codeResultHeld(fixture) {
  if (
    fixture.scenario === "provider_codemode_organisation_settlement" &&
    fixture.organisationSettlement === undefined
  )
    return null;
  return fixture.codeResult ?? null;
}

function isSettlementScenario(scenario) {
  return (
    scenario === "provider_codemode_settlement" ||
    scenario === "provider_codemode_organisation_settlement"
  );
}

function portalSettlementHeld(fixture) {
  return fixture.portalSettlement ?? null;
}

function cancellationHeld(fixture) {
  return fixture.cancellationHeld ?? null;
}

function expectedInterruptedCommand() {
  return null;
}

function terminalTask(task) {
  return task.state.status === "terminal";
}

function unansweredSubmission(submission) {
  return submission.status === "unanswered" && submission.reason === "aborted";
}

async function completedCancellationState(runtime, scenario) {
  const snapshot = await request(runtime, scenario, "/snapshot");
  return snapshot.lifecycle.kind === "sleeping" &&
    snapshot.inputControl?.phase === "complete"
    ? snapshot
    : null;
}

function submissionHasId(id, submission) {
  return submission.id === id;
}

function inputAdmissionHeld(fixture) {
  return fixture.inputAdmissionResponse !== undefined;
}

function nativeModelResumed(fixture) {
  return fixture.modelRequests >= 3;
}

function queuedPortalCommand(name) {
  return {
    kind: "next",
    conversationId: "conv_aaaaaaaa-1111-4111-8111-111111111111",
    requestId: `request_${name}`,
    inputId: `input_${name}`,
    model: "qwen/qwen3.7-flash",
    text: `Report the saved inventory total. Keep the proposal pending for approval. Queue reference: ${name}.`,
  };
}

async function verifyQueuedCommandIdentity(
  runtime,
  scenario,
  requester,
  saved,
) {
  const before = await request(runtime, scenario, "/snapshot");
  const retry = await requestJson(
    runtime,
    scenario,
    "/queue",
    queuedPortalCommand("retained"),
    requester,
  );
  assert.deepEqual(retry, saved);
  const rejected = [];
  for (const field of ["text", "requestId", "inputId"]) {
    const changed = queuedPortalCommand("retained");
    changed[field] += "_changed";
    const url = new URL("/queue", runtime.url);
    url.searchParams.set("scenario", scenario);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-trial-user-id": requester,
        "content-type": "application/json",
      },
      body: JSON.stringify(changed),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 409, await response.clone().text());
    assert.deepEqual(await response.json(), {
      error: "idempotency_key_conflict",
    });
    rejected.push(field);
  }
  const after = await request(runtime, scenario, "/snapshot");
  assert.deepEqual(after.submissions, before.submissions);
  assert.deepEqual(after.history, before.history);
  return {
    submissionId: saved.id,
    status: saved.status,
    exactRetryPreserved: true,
    rejectedChanges: rejected,
    submissionsUnchanged: true,
    historyUnchanged: true,
  };
}

function withdrawalPortalCommand(name) {
  return {
    kind: "withdraw",
    conversationId: "conv_aaaaaaaa-1111-4111-8111-111111111111",
    inputId: `input_${name}`,
  };
}

async function verifyCommandRevocation(
  runtime,
  scenario,
  fixture,
  contributorId,
) {
  const before = await request(runtime, scenario, "/snapshot");
  const url = new URL("/queue?hold=admission", runtime.url);
  url.searchParams.set("scenario", scenario);
  const pending = fetch(url, {
    method: "POST",
    headers: {
      "x-trial-user-id": contributorId,
      "content-type": "application/json",
    },
    body: JSON.stringify(queuedPortalCommand("revoked")),
    signal: AbortSignal.timeout(15000),
  });
  await waitFor(
    inputAdmissionHeld.bind(null, fixture),
    "input admission before revocation",
  );
  const demoted = await request(runtime, scenario, "/demote-contributor");
  sendJson(fixture.inputAdmissionResponse, { acknowledged: true });
  const response = await pending;
  assert.equal(response.status, 403);
  const after = await request(runtime, scenario, "/snapshot");
  assert.deepEqual(after.submissions, before.submissions);
  assert.deepEqual(after.history, before.history);
  await request(runtime, scenario, "/restore-contributor");
  return {
    status: response.status,
    accessRevision: demoted.accessRevision,
    historyUnchanged: true,
    submissionsUnchanged: true,
  };
}

async function verifyDeniedPortalCommands(runtime, scenario) {
  const before = await request(runtime, scenario, "/snapshot");
  const taskDeniedUrl = new URL("/portal-tasks", runtime.url);
  taskDeniedUrl.searchParams.set("scenario", scenario);
  taskDeniedUrl.searchParams.set("turn", "turn_plan50_seams");
  const taskDenied = await fetch(taskDeniedUrl, {
    headers: { "x-trial-user-id": "user_22222222-2222-5222-8222-222222222222" },
  });
  assert.equal(taskDenied.status, 403, await taskDenied.clone().text());
  const denied = [];
  for (const path of [
    "/queue",
    "/steer",
    "/followup",
    "/withdraw",
    "/cancel",
  ]) {
    const url = new URL(path, runtime.url);
    url.searchParams.set("scenario", scenario);
    const response = await fetch(url, {
      headers: {
        "x-trial-user-id": "user_22222222-2222-5222-8222-222222222222",
      },
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 403, await response.clone().text());
    assert.deepEqual(await response.json(), { error: "chat_not_found" });
    denied.push(path);
  }
  const replayUrl = new URL("/portal-replay", runtime.url);
  replayUrl.searchParams.set("scenario", scenario);
  replayUrl.searchParams.set("turn", "turn_plan50_seams");
  const replayDenied = await fetch(replayUrl, {
    headers: { "x-trial-user-id": "user_22222222-2222-5222-8222-222222222222" },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(replayDenied.status, 403, await replayDenied.clone().text());
  assert.equal(await replayDenied.text(), "Conversation unavailable.");
  denied.push("/portal-replay");
  const after = await request(runtime, scenario, "/snapshot");
  assert.deepEqual(after.submissions, before.submissions);
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.inputControl, before.inputControl);
  return { denied, submissionsUnchanged: true, historyUnchanged: true };
}

function isSystemMessage(message) {
  return message.role === "system";
}

function isCompactionPrompt(message) {
  return (
    message.role === "system" &&
    message.content.includes("You are a context summarization assistant.")
  );
}

async function settledCompaction(runtime, scenario, taskId, outcome) {
  const snapshot = await request(runtime, scenario, "/snapshot");
  const task = snapshot.tasks.find(matchesTask.bind(null, taskId));
  if (task?.state.status !== "terminal") return null;
  assert.equal(task.state.outcome.status, outcome, JSON.stringify(task));
  return snapshot;
}

function matchesTask(taskId, task) {
  return task.id === taskId;
}

function nativeModelMessage(message) {
  if (message.role !== "tool") return message;
  return {
    role: "toolResult",
    content: [{ type: "text", text: message.content }],
    isError: false,
  };
}

function isToolResult(message) {
  return message.role === "toolResult";
}

function modelResponse(fixture, messages) {
  if (fixture.scenario === "hook_denial")
    return { content: "HOOK_DID_NOT_BLOCK", stopReason: "stop" };
  const results = messages.filter(isToolResult);
  const latest = results.at(-1);
  if (latest?.isError) return { content: "TOOL_ERROR", stopReason: "stop" };
  if (results.length >= 2) return { content: "COMPLETE", stopReason: "stop" };
  const name = results.length === 0 ? "publish_product" : "read_product";
  return {
    content: [{ type: "toolCall", id: `${name}-1`, name, arguments: {} }],
    stopReason: "toolUse",
  };
}

function proposalModelResponse(fixture, messages) {
  const result = messages.find(isToolResult);
  if (result !== undefined)
    return {
      content: result.isError
        ? "PROPOSAL_FAILED"
        : fixture.scenario.startsWith("provider_")
          ? providerCompletion(result)
          : "AWAITING_OPERATOR_APPROVAL",
      stopReason: "stop",
    };
  assert.equal(
    fixture.modelRequests,
    1,
    "Recovery repeated the accepted proposal model call",
  );
  return proposalToolCall(fixture.scenario);
}

function proposalToolCall(scenario) {
  return {
    content: [
      {
        type: "toolCall",
        id: "proposal_original",
        name: "commerce_propose_action",
        arguments: {
          request: {
            kind: "adjust_offer_price",
            offerId: "commerce:merchant_plan50_draft:offer_financier",
            expectedOfferRevision: scenario.startsWith("provider_") ? 2 : 1,
            expectedPolicyRevision: 1,
            proposedPriceMinor: 2500,
            currency: "JPY",
            productId: null,
            productRevision: null,
            variantId: null,
            variantRevision: null,
            offerRevision: null,
            salesChannelId: null,
            salesChannelRevision: null,
            resourceId: null,
            expectedRevision: null,
            reason: null,
            refund: null,
            restock: null,
            notifyCustomer: null,
            note: null,
            description: null,
            fulfillmentId: null,
            fulfillmentRevision: null,
            shipmentId: null,
            shipmentRevision: null,
            trackingNumber: null,
          },
        },
      },
    ],
    stopReason: "toolUse",
  };
}

async function evaluateProposalScenario(scenario) {
  const fixture = createFixture(scenario);
  // A Commerce with no merchant: the proposal finds no price allowance.
  fixture.commerce = await createCommerce();
  fixtures.set(scenario, fixture);
  let runtime = null;
  let before = null;
  let after = null;
  const logs = [];
  try {
    const persistence = join(artifacts, scenario);
    runtime = await launch(persistence);
    const accepted = await request(runtime, scenario, "/start");
    assert.equal(accepted.accepted, true, accepted.error);
    await waitFor(
      proposalHeld.bind(null, fixture),
      "native proposal committed before response loss",
    );
    before = await request(runtime, scenario, "/snapshot");
    assert.equal(before.lifecycle.kind, "processing");
    assert.equal(before.history.length, 2);
    assert.equal(before.owners.organisation.length, 1);
    assert.equal(before.owners.case.proposals.length, 1);
    assert.equal(before.owners.case.waits.length, 1);
    assert.equal(before.owners.organisation[0].state, "proposed");
    assert.equal(
      before.owners.organisation[0].nonce,
      fixture.heldProposal.nonce,
    );
    assert.equal(
      before.lease.authorityPartitionDigest,
      JSON.parse(before.owners.organisation[0].action_json).authorityPartition
        .digest,
    );
    if (scenario === "proposal_grant_revoked")
      assert.deepEqual(await request(runtime, scenario, "/revoke-proposal"), {
        revoked: true,
      });
    logs.push(...runtime.logs);
    await stop(runtime, true);
    runtime = await launch(persistence);
    after = await waitFor(
      proposalRecovered.bind(null, runtime, scenario),
      "native proposal recovery settles or blocks",
    );
    assert.deepEqual(after.owners, before.owners);
    assert.equal(after.budget.reservation.kind, "none");
    assert.equal(fixture.mutations, 0);
    assert.equal(after.alarm, null);
    if (scenario === "proposal_grant_revoked") {
      assert.equal(fixture.modelRequests, 1);
      assert.deepEqual(after.lifecycle.state.action, {
        kind: "blocked",
        reason: "authorization",
      });
      assert.deepEqual(after.history, before.history);
    } else {
      assert.equal(fixture.modelRequests, 2);
      assert.equal(after.history.length, 4);
      const result = JSON.parse(after.history[2].payload).entry;
      assert.equal(result.kind, "tool_result");
      assert.equal(result.authority.kind, "read");
      assert(JSON.stringify(result).includes(fixture.heldProposal.nonce));
      assert.equal(after.submissions[0].status, "done");
    }
    logs.push(...runtime.logs);
    await stop(runtime, true);
    runtime = await launch(persistence);
    const cold = await request(runtime, scenario, "/snapshot");
    assert.deepEqual(cold.owners, before.owners);
    assert.deepEqual(cold.history, after.history);
    assert.deepEqual(cold.lifecycle, after.lifecycle);
    return {
      scenario,
      status: "passed",
      before,
      after,
      cold,
      originalProposal: fixture.heldProposal,
      modelRequests: fixture.modelRequests,
      providerMutations: fixture.mutations,
      trace: fixture.events,
      logs,
    };
  } catch (error) {
    if (runtime !== null) {
      logs.push(...runtime.logs);
      try {
        after = await request(runtime, scenario, "/snapshot");
      } catch {}
    }
    return {
      scenario,
      status: "failed",
      error: String(error),
      before,
      after,
      trace: fixture.events,
      logs,
    };
  } finally {
    await stop(runtime, false);
    await fixture.commerce.dispose();
  }
}

function proposalHeld(fixture) {
  return fixture.heldProposal !== null;
}

function providerCompletion(result) {
  const value = JSON.parse(
    result.content.find(isTextContent).text,
  ).code_mode_value;
  assert.equal(
    value.state,
    "confirmed",
    "Native inference resumed before provider settlement",
  );
  return "PRICE_CONFIRMED";
}

function isTextContent(content) {
  return content.type === "text";
}

// Each trial runs its own built Commerce fixture Worker (Plan 76 phase 1)
// and reaches it over HTTP, as Platform reaches production.
async function loadCommerceFixture() {
  const helper = "services/platform/tests/commerce-fixture-worker.ts";
  const { startCommerceWorker } = await import(
    pathToFileURL(join(repository, helper)).href
  );
  for (const source of [
    helper,
    "services/commerce/tests/fixture-worker/worker.ts",
    "services/commerce/tests/fixture-worker/scenarios.ts",
  ])
    commerceSources.add(source);
  return () => startCommerceWorker({ serviceToken: "commerce-e2e-token" });
}

async function handleCommerce(fixtures, request, response) {
  const url = new URL(request.url, "http://commerce.test");
  const fixture = fixtures.get(url.searchParams.get("scenario"));
  assert(
    fixture?.commerce !== undefined,
    "Missing isolated Commerce runtime",
  );
  url.searchParams.delete("scenario");
  url.pathname = url.pathname.slice("/commerce".length);
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const receiptPrefix =
    "/v1/admin/merchants/merchant_plan50_draft/command-receipts/";
  // The receipt read fails while the provider response is lost; then the
  // real Commerce answers it, under Pantry's own app token.
  if (
    draftBrowser &&
    request.method === "GET" &&
    url.pathname.startsWith(receiptPrefix) &&
    !fixture.receiptAvailable
  ) {
    response.writeHead(503);
    response.end("Provider receipt is temporarily unavailable");
    return;
  }
  const price =
    request.method === "POST" &&
    url.pathname ===
      "/v1/admin/merchants/merchant_plan50_draft/offers/offer_financier/price";
  const description =
    draftBrowser &&
    request.method === "PUT" &&
    url.pathname ===
      "/v1/admin/merchants/merchant_plan50_draft/products/product_financier/description";
  if (price || description) {
    fixture.providerAttempts += 1;
    fixture.providerCommands.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (fixture.providerCommitted !== null && !fixture.receiptAvailable) {
      response.writeHead(503);
      response.end("Provider receipt is temporarily unavailable");
      return;
    }
  }
  const original = new Request(url, {
    method: request.method,
    headers,
    body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
  });
  const result = await fixture.commerce.fetch(
    `${fixture.commerce.baseUrl}${url.pathname}${url.search}`,
    {
      method: original.method,
      headers: original.headers,
      body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
    },
  );
  const body = await result.text();
  if (price || description) {
    const operation = JSON.parse(body);
    assert.equal(result.status, 200, body);
    assert(
      operation.outcome === "applied" || operation.outcome === "replayed",
      body,
    );
    if (operation.outcome === "applied") fixture.mutations += 1;
    if (fixture.providerCommitted === null) {
      assert.equal(operation.outcome, "applied");
      fixture.providerCommitted = operation.receipt;
      response.writeHead(503);
      response.end("Provider change committed; response lost");
      return;
    }
    assert.equal(operation.outcome, "replayed");
    assert.deepEqual(operation.receipt, fixture.providerCommitted);
  }
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(body);
}

async function postProviderControl(
  runtime,
  nonce,
  operation,
  session,
  key,
  grant = null,
) {
  const cookies = [
    `pantry_session=${session.token}`,
    `pantry_csrf=${session.csrfToken}`,
  ];
  if (grant !== null) cookies.push(`pantry_approval=${grant}`);
  const response = await fetch(
    new URL(
      `/v1/control/organisations/organisation_plan50_seams/commerce/actions/${nonce}/${operation}`,
      runtime.url,
    ),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: draftBrowser
          ? new URL(runtime.url).origin
          : "https://fixture.test",
        cookie: cookies.join("; "),
        "x-pantry-csrf": session.csrfToken,
        "idempotency-key": key,
      },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) };
}

async function providerOwnerEvidence(fixture) {
  const records = await commerceRecords(fixture, ["offer", "command_receipt"]);
  const offer = records.offer
    .filter((row) => row.resource_id === "offer_financier")
    .map((row) => ({
      revision: row.revision,
      amount_minor: row.amount_minor,
      currency: row.currency,
      lifecycle_state: row.lifecycle_state,
    }))[0];
  const receipts = records.command_receipt
    .filter(
      (row) =>
        JSON.parse(row.receipt_json).commandKind === "adjust_offer_price",
    )
    .map((row) => ({
      idempotency_key: row.idempotency_key,
      receipt_json: row.receipt_json,
    }));
  return {
    offer,
    receipts,
    attempts: fixture.providerAttempts,
    commands: fixture.providerCommands,
    committed: fixture.providerCommitted,
  };
}

async function evaluateProviderScenario(scenario) {
  const fixture = createFixture(scenario);
  fixture.commerce = await createCommerce();
  fixture.providerAttempts = 0;
  fixture.providerCommands = [];
  fixture.providerCommitted = null;
  fixture.receiptAvailable = false;
  fixtures.set(scenario, fixture);
  let runtime = null;
  let before = null;
  let after = null;
  const logs = [];
  try {
    const persistence = join(artifacts, scenario);
    runtime = await launch(persistence);
    const accepted = await request(runtime, scenario, "/start");
    assert.equal(accepted.accepted, true, accepted.error);
    await waitFor(
      proposalHeld.bind(null, fixture),
      "native proposal before operator approval",
    );
    before = await request(runtime, scenario, "/snapshot");
    assert.equal(before.profilePin.definitionRevision, 1);
    assert.deepEqual(before.profilePin.skillRefs, [
      { skillId: "skill_plan50_native", revision: 1 },
    ]);
    if (scenario.startsWith("provider_extension_")) {
      const fault = scenario.endsWith("missing") ? "missing" : "incompatible";
      await request(runtime, scenario, `/extension-change?kind=${fault}`);
      await stop(runtime, true);
      logs.push(...runtime.logs);
      runtime = await launch(persistence);
      const blocked = await waitFor(
        stoppedRecoveryState.bind(null, runtime, scenario),
        "incompatible native extension blocked",
      );
      assert.deepEqual(blocked.lifecycle.state.action, {
        kind: "blocked",
        reason: "implementation",
      });
      assert.deepEqual(blocked.history, before.history);
      assert.deepEqual(blocked.tasks, before.tasks);
      assert.deepEqual(blocked.profilePin, before.profilePin);
      assert.equal(fixture.modelRequests, 1);
      assert.equal(fixture.mutations, 0);
      await stop(runtime, true);
      logs.push(...runtime.logs);
      runtime = await launch(persistence);
      const cold = await request(runtime, scenario, "/snapshot");
      assert.deepEqual(cold.lifecycle, blocked.lifecycle);
      assert.deepEqual(cold.history, before.history);
      return {
        scenario,
        status: "passed",
        before,
        blocked,
        cold,
        modelRequests: fixture.modelRequests,
        trace: fixture.events,
        logs,
      };
    }
    if (scenario === "provider_revoked_model") {
      await request(runtime, scenario, "/revoke-proposal");
      const compaction = await request(runtime, scenario, "/compact");
      const denied = await waitFor(
        settledCompaction.bind(
          null,
          runtime,
          scenario,
          compaction.taskId,
          "failed",
        ),
        "compaction denied after grant revocation",
      );
      assert.equal(fixture.modelRequests, 1);
      assert.equal(denied.budget.reservation.acceptedUsage.tokens, 150);
      assert.deepEqual(denied.history, before.history);
      await stop(runtime, true);
      logs.push(...runtime.logs);
      runtime = await launch(persistence);
      const cold = await waitFor(
        stoppedRecoveryState.bind(null, runtime, scenario),
        "revoked model recovery blocked",
      );
      assert.deepEqual(cold.lifecycle.state.action, {
        kind: "blocked",
        reason: "authorization",
      });
      assert.deepEqual(cold.history, before.history);
      assert.equal(fixture.modelRequests, 1);
      assert.equal(fixture.mutations, 0);
      return {
        scenario,
        status: "passed",
        before,
        denied,
        cold,
        modelRequests: fixture.modelRequests,
        trace: fixture.events,
        logs,
      };
    }
    let compacted = null;
    if (scenario === "provider_receipt_wait") {
      await request(runtime, scenario, "/profile-update");
      const task = await request(runtime, scenario, "/compact");
      compacted = await waitFor(
        settledCompaction.bind(
          null,
          runtime,
          scenario,
          task.taskId,
          "completed",
        ),
        "admitted native compaction",
      );
      assert.deepEqual(compacted.history, before.history);
      assert.equal(compacted.budget.reservation.acceptedUsage.tokens, 300);
    }
    const initialModelRequests = compacted === null ? 1 : 2;
    const nonce = fixture.heldProposal.nonce;
    assert.equal(before.history.length, 2);
    assert.equal(before.owners.organisation.length, 1);
    assert.equal(before.owners.case.proposals.length, 1);
    const session = await request(runtime, scenario, "/operator-session");
    const denied = await postProviderControl(
      runtime,
      nonce,
      "execute",
      session,
      "provider-before-approval",
    );
    assert.equal(denied.status, 409, JSON.stringify(denied));
    assert.equal(fixture.providerAttempts, 0);
    const approval = await request(
      runtime,
      scenario,
      `/approval-fixture?nonce=${nonce}`,
    );
    const approved = await postProviderControl(
      runtime,
      nonce,
      "approval",
      session,
      "provider-approve",
      approval.grant,
    );
    assert.equal(approved.status, 200, JSON.stringify(approved));
    assert.equal(approved.body.state, "signed");
    const lost = await postProviderControl(
      runtime,
      nonce,
      "execute",
      session,
      "provider-execute",
    );
    assert.equal(lost.status, 503, JSON.stringify(lost));
    assert.equal(fixture.mutations, 1);
    const unknown = await request(runtime, scenario, "/snapshot");
    assert.equal(unknown.owners.organisation[0].state, "indeterminate");
    await stop(runtime, true);
    logs.push(...runtime.logs);
    runtime = await launch(persistence);
    const waiting = await waitFor(
      stoppedRecoveryState.bind(null, runtime, scenario),
      "saved provider receipt wait",
    );
    assert.deepEqual(waiting.history, before.history);
    assert.deepEqual(waiting.lifecycle.state.action, {
      kind: "await_evidence",
      evidence: {
        kind: "effect_receipt",
        effectId: `effect_provider_${nonce}`,
      },
    });
    assert.equal(waiting.lease, null);
    assert.equal(waiting.budget.reservation.kind, "none");
    assert.equal(fixture.modelRequests, initialModelRequests);
    assert.deepEqual(await request(runtime, scenario, "/release-provider"), {
      kind: "await_receipt",
    });
    let pending = null;
    let coldWait = null;
    if (scenario === "provider_receipt_wait") {
      pending = await postProviderControl(
        runtime,
        nonce,
        "execute",
        session,
        "provider-reconcile",
      );
      assert.equal(pending.status, 202, JSON.stringify(pending));
      assert.equal(
        pending.body.error,
        "commerce_action_reconciliation_pending",
      );
      assert.equal(fixture.mutations, 1);
      await stop(runtime, true);
      logs.push(...runtime.logs);
      runtime = await launch(persistence);
      coldWait = await request(runtime, scenario, "/snapshot");
      assert.deepEqual(coldWait.lifecycle, waiting.lifecycle);
      assert.deepEqual(coldWait.history, before.history);
      assert.equal(coldWait.owners.organisation[0].state, "indeterminate");
      assert.equal(fixture.modelRequests, initialModelRequests);
    }
    fixture.receiptAvailable = true;
    const settled = await postProviderControl(
      runtime,
      nonce,
      "execute",
      session,
      "provider-reconcile",
    );
    assert.equal(settled.status, 200, JSON.stringify(settled));
    assert.equal(
      settled.body.receipt.receiptId,
      fixture.providerCommitted.receiptId,
    );
    assert.equal(
      settled.body.receipt.effectId,
      fixture.providerCommitted.effectId,
    );
    assert.equal(settled.body.receipt.actionNonce, nonce);
    const attempts = fixture.providerAttempts;
    const replay = await postProviderControl(
      runtime,
      nonce,
      "execute",
      session,
      "provider-reconcile",
    );
    assert.deepEqual(replay, settled);
    assert.equal(fixture.providerAttempts, attempts);
    const released = await request(runtime, scenario, "/release-provider");
    assert.equal(released.kind, "resolved");
    assert.equal(released.nonce, nonce);
    after = await waitFor(
      completedPortableState.bind(null, runtime, scenario),
      "native continuation after verified receipt",
    );
    assert.equal(after.owners.organisation[0].state, "confirmed");
    assert.equal(
      after.owners.organisation[0].action_json,
      before.owners.organisation[0].action_json,
    );
    assert.equal(after.owners.case.proposals.length, 1);
    assert.equal(after.owners.case.waits.length, 1);
    assert.equal(
      JSON.parse(after.owners.case.waits[0].payload).kind,
      "decided",
    );
    assert.equal(after.history.length, 4);
    assert.deepEqual(after.profilePin, before.profilePin);
    for (const event of fixture.events) {
      if (!event.path.startsWith("/openrouter")) continue;
      const system = event.body.messages.find(isSystemMessage);
      if (isCompactionPrompt(system)) continue;
      assert(
        system.content.includes(
          "Propose price changes through the governed commerce tool.",
        ),
      );
      assert(
        system.content.includes(
          "Keep the original offer revision and wait for operator approval.",
        ),
      );
      assert(!system.content.includes("New assignments use"));
    }
    assert.equal(fixture.modelRequests, initialModelRequests + 1);
    assert.equal(after.budget.usage.tokens, (initialModelRequests + 1) * 150);
    assert.equal(after.budget.reservation.kind, "none");
    assert.equal(after.submissions[0].id, accepted.submissionId);
    assert.equal(after.submissions[0].status, "done");
    const owner = await providerOwnerEvidence(fixture);
    assert.equal(owner.offer.amount_minor, 2500);
    assert.equal(owner.offer.revision, 3);
    assert.equal(owner.receipts.length, 1);
    assert.deepEqual(
      JSON.parse(owner.receipts[0].receipt_json),
      fixture.providerCommitted,
    );
    assert.equal(fixture.mutations, 1);
    const command = fixture.providerCommands[0];
    for (const attempt of fixture.providerCommands)
      assert.deepEqual(attempt, command);
    await stop(runtime, true);
    logs.push(...runtime.logs);
    runtime = await launch(persistence);
    const cold = await request(runtime, scenario, "/snapshot");
    assert.deepEqual(cold.history, after.history);
    assert.deepEqual(cold.lifecycle, after.lifecycle);
    assert.deepEqual(cold.owners, after.owners);
    return {
      scenario,
      status: "passed",
      before,
      unknown,
      compacted,
      waiting,
      pending,
      coldWait,
      settled,
      released,
      after,
      cold,
      provider: owner,
      denied,
      approved,
      modelRequests: fixture.modelRequests,
      providerMutations: fixture.mutations,
      trace: fixture.events,
      logs,
    };
  } catch (error) {
    if (runtime !== null) {
      logs.push(...runtime.logs);
      after = await request(runtime, scenario, "/snapshot").catch(
        failedSnapshot,
      );
    }
    return {
      scenario,
      status: "failed",
      error: String(error),
      stack: error.stack,
      before,
      after,
      provider: await providerOwnerEvidence(fixture),
      trace: fixture.events,
      logs,
    };
  } finally {
    await stop(runtime, false);
    await fixture.commerce?.dispose();
  }
}

function runtimeGroup() {
  if (draftBrowser) return "draft-browser";
  if (draft) return "draft";
  if (codeModeTrial) return "codemode";
  if (providerTrial) return "provider";
  if (proposal) return "proposal";
  return "default";
}

async function proposalRecovered(runtime, scenario) {
  const state = await request(runtime, scenario, "/snapshot");
  const expected =
    scenario === "proposal_grant_revoked" ? "recovering" : "sleeping";
  return state.lifecycle.kind === expected && state.alarm === null
    ? state
    : null;
}

async function launch(persistenceDirectory) {
  const child = fork(
    join(scripts, "runtime-process.mjs"),
    [
      runtimeDirectory,
      worker,
      persistenceDirectory,
      providerUrl,
      runtimeGroup(),
    ],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: true,
    },
  );
  const logs = [];
  child.stdout.on("data", recordOutput.bind(null, logs));
  child.stderr.on("data", recordOutput.bind(null, logs));
  const ready = once(child, "message");
  const exited = once(child, "exit").then(failedStartup.bind(null, logs));
  const result = await Promise.race([ready, exited, startupDeadline()]);
  return { child, url: result[0].ready, logs };
}

function recordOutput(logs, data) {
  logs.push(String(data));
}

function failedStartup(logs) {
  throw new Error(`Runtime exited: ${logs.join("")}`);
}

async function startupDeadline() {
  await delay(20_000, undefined, { ref: false });
  throw new Error("Runtime startup deadline exceeded");
}

async function stop(runtime, abrupt) {
  if (
    runtime === null ||
    runtime.child.exitCode !== null ||
    runtime.child.signalCode !== null
  )
    return;
  const exited = once(runtime.child, "exit");
  if (abrupt) process.kill(-runtime.child.pid, "SIGKILL");
  else runtime.child.send("close");
  await exited;
}

async function request(runtime, scenario, path, requester = null) {
  const url = new URL(path, runtime.url);
  url.searchParams.set("scenario", scenario);
  const response = await fetch(url, {
    headers: requester === null ? {} : { "x-trial-user-id": requester },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  assert(response.ok, `${scenario}${path}: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function requestJson(runtime, scenario, path, body, requester = null) {
  const url = new URL(path, runtime.url);
  url.searchParams.set("scenario", scenario);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(requester === null ? {} : { "x-trial-user-id": requester }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.text();
  assert(response.ok, `${scenario}${path}: ${response.status} ${result}`);
  return JSON.parse(result);
}

async function completedPortableState(runtime, scenario) {
  const snapshot = await request(runtime, scenario, "/snapshot");
  return snapshot.lifecycle?.kind === "sleeping" &&
    snapshot.replay?.state.kind === "complete"
    ? snapshot
    : null;
}

function assertPortableState(actual, expected) {
  assert.deepEqual(actual.nativeTables, expected.nativeTables);
  assert.deepEqual(actual.history, expected.history);
  assert.deepEqual(actual.usage, expected.usage);
  assert.deepEqual(actual.budget, expected.budget);
  assert.deepEqual(actual.lifecycle, expected.lifecycle);
  assert.deepEqual(actual.checkpoint, expected.checkpoint);
  assert.deepEqual(
    actual.checkpointPublication,
    expected.checkpointPublication,
  );
  assert.deepEqual(actual.replay, expected.replay);
  assert.equal(actual.lease, null);
  assert.equal(actual.alarm, null);
}

function assertEmptyPortableTarget(snapshot) {
  assert.equal(snapshot.lifecycle, null);
  assert(snapshot.nativeTables.every(emptyNativeTable));
  assert.equal(snapshot.history.length, 0);
  assert.equal(snapshot.checkpoint, null);
}

function recoveryCrashBoundary(fixture) {
  return ["recovery_unknown_usage", "recovery_portable_unknown_usage"].includes(
    fixture.scenario,
  )
    ? fixture.modelRequests === 1
    : fixture.heldCommit !== null;
}

// The agent finds the draft tools, reads the draft and edits it. After
// recovery it reads the saved draft again, which holds the person's note.
function draftModelResponse(fixture, body) {
  const productId = "product_financier";
  const last = body.messages.at(-1);
  switch (fixture.modelRequests) {
    case 1:
      return modelToolCall("discover_draft", "tool_search", {
        query: "product_description_draft_read product_description_draft_edit",
        limit: 2,
      });
    case 2:
      return modelToolCall(
        "draft_read_initial",
        "product_description_draft_read",
        { productId },
      );
    case 3:
      assert(last.content.includes("Almond financier."), last.content);
      return modelToolCall(
        "draft_edit_original",
        "product_description_draft_edit",
        { productId, oldText: "Almond", newText: "Brown butter" },
      );
    case 4:
      assert(last.content.includes("Brown butter financier."), last.content);
      return modelToolCall(
        "draft_read_current",
        "product_description_draft_read",
        { productId },
      );
    case 5:
      assert(
        last.content.includes("Brown butter financier. Serve with tea."),
        last.content,
      );
      return {
        content: JSON.stringify({
          kind: "reply",
          text: "The draft keeps the brown butter wording and the operator's serving note.",
        }),
      };
    default:
      throw new Error("Draft trial made an unexpected model request");
  }
}

async function evaluateDraftScenario(scenario) {
  const fixture = createFixture(scenario);
  fixture.commerce = await createCommerce();
  fixtures.set(scenario, fixture);
  let runtime = null;
  const logs = [];
  try {
    const persistence = join(artifacts, scenario);
    runtime = await launch(persistence);
    await request(runtime, scenario, "/prepare-draft");
    const accepted = await request(runtime, scenario, "/start");
    assert.equal(accepted.accepted, true, accepted.error);
    await waitFor(
      draftCommitHeld.bind(null, fixture),
      "accepted draft edit before response loss",
    );
    const before = await request(runtime, scenario, "/snapshot");
    assert.equal(before.lifecycle.kind, "processing");
    assert.equal(before.history.length, 6);
    assert.equal(fixture.modelRequests, 3);
    const original = fixture.draftCommits[0];
    assert.equal(
      original.operationId,
      JSON.stringify(["direct_tool", "draft_edit_original"]),
    );
    assert.equal(original.value.draft.description, "Brown butter financier.");
    const human = await request(runtime, scenario, "/human-edit");
    assert.equal(human.ok, true);
    assert.equal(
      human.value.draft.description,
      "Brown butter financier. Serve with tea.",
    );
    if (scenario === "draft_member_revoked")
      assert.equal(
        (await request(runtime, scenario, "/revoke-agent")).revoked,
        true,
      );
    if (scenario === "draft_placement_frozen")
      assert.equal(
        (await request(runtime, scenario, "/freeze-placement")).frozen,
        true,
      );
    if (scenario === "draft_receipt_wait") fixture.draftOwnerAvailable = false;
    await stop(runtime, true);
    logs.push(...runtime.logs);
    runtime = await launch(persistence);
    let waiting = null;
    if (scenario !== "draft_response_loss") {
      waiting = await waitFor(
        stoppedRecoveryState.bind(null, runtime, scenario),
        "held draft receipt recovery",
      );
      assert.deepEqual(waiting.history, before.history);
      assert.equal(waiting.lease, null);
      assert.equal(fixture.modelRequests, 3);
      assert.equal(fixture.draftCommits.length, 1);
      assert.equal(waiting.budget.reservation.kind, "none");
      assert.equal(
        waiting.budget.usage.tokens,
        before.budget.reservation.acceptedUsage.tokens,
      );
      if (scenario === "draft_receipt_wait") {
        assert.equal(waiting.lifecycle.state.action.kind, "await_evidence");
        assert.equal(
          waiting.lifecycle.state.action.evidence.kind,
          "effect_receipt",
        );
        assert.equal(
          (await request(runtime, scenario, "/try-resume")).ok,
          false,
        );
      } else
        assert.deepEqual(waiting.lifecycle.state.action, {
          kind: "blocked",
          reason: "authorization",
        });
      await stop(runtime, true);
      logs.push(...runtime.logs);
      runtime = await launch(persistence);
      const cold = await request(runtime, scenario, "/snapshot");
      assert.deepEqual(cold.lifecycle, waiting.lifecycle);
      assert.deepEqual(cold.budget, waiting.budget);
      if (scenario !== "draft_receipt_wait") {
        const owner = await request(runtime, scenario, "/draft");
        assert.equal(owner.description, human.value.draft.description);
        assert.equal(owner.receipts.length, 1);
        assert.equal(fixture.modelRequests, 3);
        return {
          ...scenarioEvidence("passed", fixture, before, cold, null, [
            ...logs,
            ...runtime.logs,
          ]),
          originalReceipt: original,
          human,
          owner,
          guarantees: [
            "current authority denies receipt recovery",
            "dependent model work stopped",
            "one agent mutation",
            "later human edit preserved",
            "block survives restart",
          ],
        };
      }
      fixture.draftOwnerAvailable = true;
      const resolved = await request(runtime, scenario, "/reconcile-draft");
      assert.equal(resolved.kind, "resolved");
      assert.equal(resolved.draftDescription, original.value.draft.description);
    }
    const after = await waitFor(
      completedPortableState.bind(null, runtime, scenario),
      "receipt recovery and draft reread",
    );
    const owner = await request(runtime, scenario, "/draft");
    assert.equal(owner.description, human.value.draft.description);
    assert.equal(owner.receipts.length, 1);
    assert.equal(fixture.draftCommits.length, 2);
    assert.deepEqual(fixture.draftCommits[1], original);
    assert.equal(fixture.modelRequests, 5);
    assert.equal(after.history.length, 10);
    assert.equal(
      after.checkpoint.runtimeLease.generation,
      scenario === "draft_receipt_wait" ? 3 : 2,
    );
    assert.equal(after.submissions[0].id, accepted.submissionId);
    assert.equal(
      after.budget.usage.capabilityCalls,
      scenario === "draft_receipt_wait" ? 5 : 4,
    );

    assert.equal(
      after.budget.usage.tokens,
      after.history.map(historyReportedTokens).reduce(sum, 0),
    );
    const editResult = after.history
      .map((row) => JSON.parse(row.payload).entry)
      .find((entry) => entry.callId === "draft_edit_original");
    assert.equal(editResult.callId, "draft_edit_original");
    assert.equal(editResult.outcome.kind, "succeeded");
    assert.equal((await request(runtime, scenario, "/stale")).ok, false);
    return {
      ...scenarioEvidence("passed", fixture, before, after, null, [
        ...logs,
        ...runtime.logs,
      ]),
      originalReceipt: original,
      waiting,
      human,
      owner,
      guarantees: [
        "original draft operation replayed",
        "one agent mutation",
        "later human edit preserved",
        "fresh execution placement admission",
        "known usage retained",
      ],
    };
  } catch (error) {
    return {
      scenario,
      status: "failed",
      error: String(error),
      trace: fixture.events,
      snapshot:
        runtime === null
          ? null
          : await request(runtime, scenario, "/snapshot").catch(failedSnapshot),
      logs: [...logs, ...(runtime?.logs ?? [])],
    };
  } finally {
    await stop(runtime, false);
    await fixture.commerce.dispose();
  }
}

function draftCommitHeld(fixture) {
  return fixture.draftCommits.length === 1;
}

async function stoppedRecoveryState(runtime, scenario) {
  const snapshot = await request(runtime, scenario, "/snapshot");
  if (snapshot.lifecycle?.kind !== "recovering" || snapshot.alarm !== null)
    return null;
  return snapshot.lifecycle.state.action.kind === "resume_task"
    ? null
    : snapshot;
}

async function evaluateRecoveryScenario(scenario) {
  const fixture = createFixture(scenario);
  fixtures.set(scenario, fixture);
  let runtime = null;
  const logs = [];
  try {
    const persistence = join(artifacts, scenario);
    runtime = await launch(persistence);
    const accepted = await request(runtime, scenario, "/start");
    assert.equal(accepted.accepted, true, accepted.error);
    await waitFor(
      recoveryCrashBoundary.bind(null, fixture),
      "saved unfinished native generation",
    );
    const before = await request(runtime, scenario, "/snapshot");
    const knownResponse = scenario !== "recovery_unknown_usage";
    assert.equal(before.lifecycle.kind, "processing");
    assert.equal(before.history.length, knownResponse ? 2 : 1);
    assert.equal(
      before.tasks[0].state.checkpoint.phase,
      knownResponse ? "tools" : "request",
    );
    assert.equal(fixture.modelRequests, 1);
    assert.equal(fixture.productReads, 0);
    assert.notEqual(before.alarm, null);
    if (scenario === "recovery_revoked") fixture.revoked = true;
    if (scenario === "recovery_schema_upgrade") {
      assert.equal(
        (await request(runtime, scenario, "/stage-schema32")).staged,
        true,
      );
      const staged = await request(runtime, scenario, "/snapshot");
      assert.equal(staged.hotSchemaVersion, 32);
      assert.deepEqual(staged.lifecycle, before.lifecycle);
      assert.deepEqual(staged.history, before.history);
      assert.deepEqual(staged.tasks, before.tasks);
    }
    await stop(runtime, true);
    logs.push(...runtime.logs);
    runtime = await launch(persistence);
    let after;
    if (scenario === "recovery_cancelled") {
      await waitFor(
        recoveryAuthorityHeld.bind(null, fixture),
        "fresh recovery authority request",
      );
      const cancelled = await request(runtime, scenario, "/cancel-recovery");
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.state.kind, "cancelling");
      assert.equal(cancelled.state.state.plan.lease.kind, "none");
      assert.equal(cancelled.state.state.plan.turnId, before.lease.turn.turnId);
      await stop(runtime, true);
      logs.push(...runtime.logs);
      runtime = await launch(persistence);
      after = await request(runtime, scenario, "/snapshot");
      assert.deepEqual(after.lifecycle, cancelled.state);
      assert.equal(after.lease, null);
      assert.deepEqual(after.history, before.history);
      assert.equal(
        after.budget.usage.tokens,
        before.budget.reservation.acceptedUsage.tokens,
      );
      assert.equal(fixture.productReads, 0);
      assert.equal(fixture.modelRequests, 1);
    } else if (
      scenario === "recovery_read_restart" ||
      scenario === "recovery_read_expired" ||
      scenario === "recovery_read_revoked"
    ) {
      await waitFor(
        readResponseHeld.bind(null, fixture),
        "admitted read before loss",
      );
      const interrupted = await request(runtime, scenario, "/snapshot");
      assert.equal(interrupted.lease.runtimeLease.generation, 2);
      assert.equal(interrupted.tasks[1].state.checkpoint.phase, "execute");
      assert.equal(interrupted.tasks[1].state.checkpoint.replay, "safe");
      assert.equal(
        interrupted.budget.reservation.acceptedUsage.capabilityCalls,
        1,
      );
      if (scenario === "recovery_read_revoked") fixture.revoked = true;
      if (scenario === "recovery_read_expired") {
        await delay(
          Math.max(0, interrupted.lease.expiresAt - Date.now() + 100),
        );
        const recovery = await request(runtime, scenario, "/recover-expired");
        assert.equal(recovery.state.kind, "recovering");
        sendJson(fixture.heldReadResponse, {
          revision: 2,
          product: "financier",
        });
        await waitFor(
          toolResultRejected.bind(null, fixture),
          "expired executor result rejected before acceptance",
        );
        assert.equal(
          fixture.rejectedToolResults[0].reason,
          "harness_lease_missing",
        );
        const fenced = await request(runtime, scenario, "/snapshot");
        assert.deepEqual(fenced.history, interrupted.history);
        assert.equal(fixture.modelRequests, 1);
        fixture.expiredExecutor = {
          lease: interrupted.lease,
          recovery,
          rejected: fixture.rejectedToolResults[0],
          unchangedHistory: fenced.history,
        };
      }
      await stop(runtime, true);
      logs.push(...runtime.logs);
      runtime = await launch(persistence);
      if (
        scenario === "recovery_read_restart" ||
        scenario === "recovery_read_expired"
      ) {
        after = await waitFor(
          completedPortableState.bind(null, runtime, scenario),
          "retried read under fresh authority",
        );
        assert.equal(after.checkpoint.runtimeLease.generation, 3);
        assert.equal(after.budget.usage.capabilityCalls, 2);
        assert.equal(fixture.productReads, 2);
        assert.equal(fixture.modelRequests, 2);
        assert.equal(after.history.length, 4);
        assert.equal(
          after.budget.usage.tokens,
          after.history.map(historyReportedTokens).reduce(sum, 0),
        );
        assert.equal(after.tasks[0].id, before.tasks[0].id);
        assert.equal(after.tasks[1].id, interrupted.tasks[1].id);
        assert.equal(after.submissions[0].id, accepted.submissionId);
        const admissions = fixture.authorizations.filter(
          isDraftReadAuthorization,
        );
        assert.deepEqual(admissions.map(readToolGeneration), [2, 3]);
        assert(admissions.every(hasOriginalReadCall));
      } else {
        after = await waitFor(
          stoppedRecoveryState.bind(null, runtime, scenario),
          "revoked read recovery",
        );
        assert.equal(after.lifecycle.state.action.kind, "blocked");
        assert.equal(after.lifecycle.state.action.reason, "authorization");
        assert.deepEqual(after.history, before.history);
        assert.equal(after.budget.usage.capabilityCalls, 1);
        assert.equal(after.budget.reservation.kind, "none");
        assert.equal(after.lease, null);
        assert.equal(fixture.productReads, 1);
        assert.equal(fixture.modelRequests, 1);
      }
    } else if (scenario === "recovery_tool_cancelled") {
      await waitFor(
        readResponseHeld.bind(null, fixture),
        "admitted read response",
      );
      const duringRead = await request(runtime, scenario, "/snapshot");
      assert.equal(duringRead.lifecycle.kind, "processing");
      assert.equal(duringRead.lease.runtimeLease.generation, 2);
      const cancelled = await request(runtime, scenario, "/cancel-running");
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.state.kind, "cancelling");
      sendJson(fixture.heldReadResponse, { revision: 2, product: "financier" });
      await waitFor(
        toolResultRejected.bind(null, fixture),
        "fenced read result",
      );
      await stop(runtime, true);
      logs.push(...runtime.logs);
      runtime = await launch(persistence);
      after = await request(runtime, scenario, "/snapshot");
      assert.deepEqual(after.lifecycle, cancelled.state);
      assert.equal(after.lease, null);
      assert.deepEqual(after.history, before.history);
      assert.equal(after.budget.reservation.kind, "none");
      assert.equal(
        after.budget.usage.tokens,
        before.budget.reservation.acceptedUsage.tokens,
      );
      assert.equal(after.budget.usage.capabilityCalls, 1);
      assert.equal(fixture.modelRequests, 1);
      assert.equal(fixture.productReads, 1);
      assert.equal(fixture.rejectedToolResults.length, 1);
    } else if (
      scenario === "recovery_tools" ||
      scenario === "recovery_schema_upgrade" ||
      scenario === "recovery_tool_denied"
    ) {
      after = await waitFor(
        completedPortableState.bind(null, runtime, scenario),
        "resumed tool and completed turn",
      );
      assert.equal(after.submissions[0].id, accepted.submissionId);
      assert.equal(after.submissions[0].status, "done");
      assert.equal(fixture.modelRequests, 2);
      assert.equal(
        fixture.productReads,
        scenario === "recovery_tool_denied" ? 0 : 1,
      );
      assert.equal(after.history.length, 4);
      assert.equal(
        JSON.parse(after.history[2].payload).entry.kind,
        "tool_result",
      );
      assert.equal(after.checkpoint.runtimeLease.generation, 2);
      assert.deepEqual(after.checkpoint.turn, before.lease.turn);
      assert.equal(after.budget.reservation.kind, "none");
      const totalTokens = after.history
        .map(historyReportedTokens)
        .reduce(sum, 0);
      assert.equal(after.budget.usage.tokens, totalTokens);
      assert(totalTokens > before.budget.reservation.acceptedUsage.tokens);
      assert.equal(
        after.budget.usage.capabilityCalls,
        scenario === "recovery_tool_denied" ? 0 : 1,
      );
      const toolAdmission = fixture.authorizations.find(
        isDraftReadAuthorization,
      );
      assert.equal(toolAdmission.callId, "draft_read_1");
      assert.equal(toolAdmission.capability, "commerce.entity_plane.context");
      assert.equal(toolAdmission.boundary, "direct_tool");
      assert.equal(toolAdmission.generation, 2);
      if (scenario === "recovery_tool_denied") {
        const result = JSON.parse(after.history[2].payload).entry;
        assert.equal(result.outcome.kind, "failed");
        assert.equal(result.authority.kind, "read");
      } else
        assert.deepEqual(fixture.events.find(isProductRead).body, {
          scenario,
          productId: "product_financier",
        });
      assert.equal(after.hotSchemaVersion, 33);
      assert.deepEqual(after.migrationTables, []);
    } else {
      after = await waitFor(
        stoppedRecoveryState.bind(null, runtime, scenario),
        "saved blocked recovery",
      );
      assert.equal(after.lease, null);
      assert.deepEqual(after.history, before.history);
      assert.deepEqual(after.tasks, before.tasks);
      assert.equal(fixture.modelRequests, 1);
      assert.equal(fixture.productReads, 0);
      assert.equal(
        after.lifecycle.state.continuation.harnessTaskId,
        String(before.tasks[0].id),
      );
      assert.equal(
        after.lifecycle.state.continuation.submissionId,
        String(accepted.submissionId),
      );
      assert.deepEqual(
        after.lifecycle.state.activeTurn,
        before.lifecycle.state.activeTurn,
      );
      if (knownResponse) {
        assert.deepEqual(after.lifecycle.state.action, {
          kind: "blocked",
          reason:
            scenario === "recovery_budget_exhausted"
              ? "budget"
              : "authorization",
        });
        assert.equal(
          after.budget.usage.tokens,
          before.budget.reservation.acceptedUsage.tokens,
        );
        if (scenario === "recovery_budget_exhausted") {
          assert.equal(after.budget.kind, "exhausted");
          assert.equal(after.budget.exhaustion.dimension, "tokens");
          assert.equal(
            after.budget.usage.tokens,
            after.budget.budget.maxTokens,
          );
        } else assert.equal(after.budget.reservation.kind, "none");
      } else {
        assert.equal(after.lifecycle.state.action.kind, "await_evidence");
        assert.equal(after.lifecycle.state.action.evidence.kind, "model_usage");
        assert.equal(after.budget.reservation.kind, "indeterminate");
        assert.equal(
          after.lifecycle.state.action.evidence.reservationId,
          after.budget.reservation.reservation.reservationId,
        );
      }
      const denied = await request(runtime, scenario, "/try-resume");
      assert.equal(denied.ok, false);
      await stop(runtime, true);
      logs.push(...runtime.logs);
      runtime = await launch(persistence);
      const cold = await request(runtime, scenario, "/snapshot");
      assert.deepEqual(cold.lifecycle, after.lifecycle);
      assert.deepEqual(cold.budget, after.budget);
      assert.equal(fixture.modelRequests, 1);
      if (!knownResponse) {
        assert.deepEqual(
          await request(runtime, scenario, "/reconcile-model-usage"),
          { reconciled: false, reason: "pending" },
        );
        const receipt = {
          kind: "known",
          modelRequestId: cold.lifecycle.state.action.evidence.modelRequestId,
          runId: cold.lifecycle.state.action.evidence.runId,
          reservationId: cold.lifecycle.state.action.evidence.reservationId,
          tokens: 37,
        };
        fixture.modelUsageReceipt = {
          ...receipt,
          modelRequestId: "unrelated_model_request",
        };
        assert.deepEqual(
          await request(runtime, scenario, "/reconcile-model-usage"),
          { reconciled: false, reason: "evidence_mismatch" },
        );
        const stillBlocked = await request(runtime, scenario, "/snapshot");
        assert.deepEqual(stillBlocked.budget, cold.budget);
        assert.deepEqual(stillBlocked.lifecycle, cold.lifecycle);
        fixture.modelUsageReceipt = receipt;
        assert.deepEqual(
          await request(runtime, scenario, "/reconcile-model-usage"),
          { reconciled: true },
        );
        // Pi 1.5 does not send a model request again after its process is
        // lost. With the usage known, the run ends interrupted, and the turn
        // completes with the notice that the answer is unfinished.
        after = await waitFor(
          completedPortableState.bind(null, runtime, scenario),
          "completed turn after trusted usage reconciliation",
        );
        assert.equal(fixture.modelRequests, 1);
        assert.equal(fixture.productReads, 0);
        assert.equal(after.submissions[0].id, accepted.submissionId);
        assert.equal(after.submissions[0].reason, "interrupted");
        assert.equal(after.tasks[0].id, before.tasks[0].id);
        assert.deepEqual(after.history.slice(0, -1), cold.history);
        const notice = JSON.parse(after.history.at(-1).payload).entry;
        assert.equal(
          notice.content[0].text,
          "Sous Chef could not finish this answer. Ask again to continue.",
        );
        assert.equal(after.budget.usage.tokens, 37);
        assert.equal(after.budget.reservation.kind, "none");
        const retry = await request(
          runtime,
          scenario,
          "/reconcile-model-usage",
        );
        assert.deepEqual(retry, { reconciled: false, reason: "not_waiting" });
        const repeated = await request(runtime, scenario, "/snapshot");
        assert.deepEqual(repeated.budget, after.budget);
        fixture.usageReconciliation = {
          blocked: cold,
          receipt,
          repeatedBudget: repeated.budget,
        };
      }
    }
    const stale = await request(runtime, scenario, "/stale");
    assert.equal(stale.ok, false);
    return {
      ...(fixture.usageReconciliation === undefined
        ? {}
        : { usageReconciliation: fixture.usageReconciliation }),
      ...(fixture.expiredExecutor === undefined
        ? {}
        : { expiredExecutor: fixture.expiredExecutor }),
      ...scenarioEvidence("passed", fixture, before, after, null, [
        ...logs,
        ...runtime.logs,
      ]),
      guarantees: [
        "stable logical turn and native task",
        "fresh runtime generation",
        "known usage retained",
        knownResponse
          ? "accepted response reused"
          : "unknown usage blocks retry",
        "stale results rejected",
      ],
    };
  } catch (error) {
    return {
      scenario,
      status: "failed",
      error: String(error),
      modelRequests: fixture.modelRequests,
      productReads: fixture.productReads,
      trace: fixture.events,
      snapshot:
        runtime === null
          ? null
          : await request(runtime, scenario, "/snapshot").catch(failedSnapshot),
      logs: [...logs, ...(runtime?.logs ?? [])],
    };
  } finally {
    await stop(runtime, false);
  }
}

function historyReportedTokens(row) {
  const entry = JSON.parse(row.payload).entry;
  return entry.kind === "assistant_message" ? entry.usage.totalTokens : 0;
}

function isDraftReadAuthorization(authorization) {
  return authorization.operation === "product_description_draft_read";
}

function isProductRead(event) {
  return event.path === "/read";
}

function readResponseHeld(fixture) {
  return fixture.heldReadResponse !== null;
}

function toolResultRejected(fixture) {
  return fixture.rejectedToolResults.length > 0;
}

function readToolGeneration(authorization) {
  return authorization.generation;
}

function hasOriginalReadCall(authorization) {
  return authorization.callId === "draft_read_1";
}

function recoveryAuthorityHeld(fixture) {
  return fixture.authorizations.some(isRecoveryAuthorization);
}

function isRecoveryAuthorization(authorization) {
  return authorization.operation === "resume_execution";
}

function sum(left, right) {
  return left + right;
}

function failedSnapshot(error) {
  return { error: String(error) };
}

async function evaluatePortableScenario(scenario) {
  const fixture = createFixture(scenario);
  fixtures.set(scenario, fixture);
  let runtime = null;
  const logs = [];
  try {
    const persistence = join(artifacts, scenario);
    runtime = await launch(persistence);
    const accepted = await request(runtime, scenario, "/start");
    assert.equal(accepted.accepted, true, accepted.error);
    const before = await waitFor(
      completedPortableState.bind(null, runtime, scenario),
      "completed portable Pi turn",
    );
    assert.equal(before.nativeTables.length, 9);
    assert.equal(before.submissions[0].status, "done");
    assert.equal(fixture.modelRequests, 1);
    const exportRef = await request(runtime, scenario, "/export");
    assert.equal(
      (await request(runtime, scenario, "/discard-source")).discarded,
      true,
    );
    logs.push(...runtime.logs);
    await stop(runtime, true);
    runtime = await launch(persistence);
    const sourceAfterLoss = await request(runtime, scenario, "/snapshot");
    assert.equal(sourceAfterLoss.lifecycle, null);
    assert(sourceAfterLoss.nativeTables.every(emptyNativeTable));
    assert(
      !sourceAfterLoss.checkpointObjects.some(
        checkpointObjectMatches.bind(null, before.checkpoint.blob.objectKey),
      ),
    );

    const target = scenario + "_replacement";
    const denials = await verifyPortableImportDenials(
      runtime,
      scenario,
      exportRef,
    );

    const body = { exportRef, expectedFenceToken: "dof_replacement" };
    const imported = await requestJson(runtime, target, "/import", body);
    assert.deepEqual(imported, { ok: true, value: { stateVersion: 1 } });
    const after = await request(runtime, target, "/snapshot");
    assertPortableState(after, before);
    assert.deepEqual(after.activation.identity, before.activation.identity);
    assert.equal(after.activation.physicalObjectName, target);
    assert.equal(after.activation.placementEpoch, 2);
    assert.equal(after.activation.fenceToken, "dof_replacement");
    assert(
      after.checkpointObjects.some(
        checkpointObjectMatches.bind(null, before.checkpoint.blob.objectKey),
      ),
    );
    const retried = await requestJson(runtime, target, "/import", body);
    assert.deepEqual(retried, { ok: true, value: { stateVersion: 1 } });
    assertPortableState(await request(runtime, target, "/snapshot"), before);
    const reopened = await request(runtime, target, "/reopen");
    assert.equal(typeof reopened.rootId, "number");
    assertPortableState(reopened.snapshot, before);
    assert.equal(fixture.modelRequests, 1);
    logs.push(...runtime.logs);
    await stop(runtime, true);
    runtime = await launch(persistence);
    const coldReopened = await request(runtime, target, "/reopen");
    assertPortableState(coldReopened.snapshot, before);
    assert.equal(coldReopened.rootId, reopened.rootId);
    assert.equal(fixture.modelRequests, 1);
    return {
      scenario,
      status: "passed",
      modelRequests: fixture.modelRequests,
      exportRef,
      before,
      sourceAfterLoss,
      ...denials,
      imported,
      retried,
      after,
      reopened,
      coldReopened,
      logs: [...logs, ...runtime.logs],
    };
  } catch (error) {
    return {
      scenario,
      status: "failed",
      error: String(error),
      modelRequests: fixture.modelRequests,
      logs: [...logs, ...(runtime?.logs ?? [])],
    };
  } finally {
    await stop(runtime, false);
  }
}

async function verifyPortableImportDenials(runtime, scenario, exportRef) {
  const foreign = scenario + "_foreign";
  assert.deepEqual(
    await requestJson(runtime, foreign, "/prepare-import", {
      organisationId: "organisation_plan50_foreign",
    }),
    { prepared: true },
  );
  const organisationDenied = await requestJson(runtime, foreign, "/import", {
    exportRef,
    expectedFenceToken: "dof_replacement",
  });
  assert.equal(organisationDenied.ok, false);
  assert.equal(organisationDenied.error.code, "import_conflict");
  const foreignAfterDenial = await request(runtime, foreign, "/snapshot");
  assertEmptyPortableTarget(foreignAfterDenial);

  const target = scenario + "_replacement";
  assert.deepEqual(
    await requestJson(runtime, target, "/prepare-import", {
      organisationId: "organisation_plan50_seams",
    }),
    { prepared: true },
  );
  const fenceDenied = await requestJson(runtime, target, "/import", {
    exportRef,
    expectedFenceToken: "dof_stale",
  });
  assert.equal(fenceDenied.ok, false);
  assert.equal(fenceDenied.error.code, "actor_fence_mismatch");
  const corruptRef = { ...exportRef, payloadDigestB64: "A".repeat(43) + "=" };
  const integrityDenied = await requestJson(runtime, target, "/import", {
    exportRef: corruptRef,
    expectedFenceToken: "dof_replacement",
  });
  assert.equal(integrityDenied.ok, false);
  assert.equal(integrityDenied.error.code, "export_manifest_corrupt");
  const targetAfterDenial = await request(runtime, target, "/snapshot");
  assertEmptyPortableTarget(targetAfterDenial);
  return {
    organisationDenied,
    foreignAfterDenial,
    fenceDenied,
    integrityDenied,
    targetAfterDenial,
  };
}

async function evaluateUnfinishedPortableScenario(scenario) {
  const fixture = createFixture(scenario);
  fixtures.set(scenario, fixture);
  const unknownUsage = scenario === "recovery_portable_unknown_usage";
  let runtime = null;
  const logs = [];
  try {
    const persistence = join(artifacts, scenario);
    runtime = await launch(persistence);
    const accepted = await request(runtime, scenario, "/start");
    assert.equal(accepted.accepted, true, accepted.error);
    await waitFor(
      recoveryCrashBoundary.bind(null, fixture),
      "unfinished portable execution",
    );
    const interrupted = await request(runtime, scenario, "/snapshot");
    assert.equal(interrupted.lifecycle.kind, "processing");
    assert.equal(interrupted.history.length, unknownUsage ? 1 : 2);
    assert.equal(fixture.modelRequests, 1);
    assert.equal(fixture.productReads, 0);
    await assert.rejects(request(runtime, scenario, "/export"));
    assert.deepEqual(
      (await request(runtime, scenario, "/snapshot")).nativeTables,
      interrupted.nativeTables,
    );
    logs.push(...runtime.logs);
    await stop(runtime, true);
    runtime = await launch(persistence);
    const fenced = await request(runtime, scenario, "/snapshot");
    assert.equal(fenced.lifecycle.kind, "recovering");
    assert.equal(fenced.lease, null);
    assert.deepEqual(fenced.history, interrupted.history);
    assert.deepEqual(fenced.nativeTables, interrupted.nativeTables);
    const exportRef = await request(runtime, scenario, "/export");
    const before = await request(runtime, scenario, "/snapshot");
    assert.equal(before.alarm, null);
    assert.equal(before.nativeTables.length, 9);
    assert.equal(before.checkpoint, null);
    assert.equal(before.submissions[0].status, "placed");
    assert.equal(
      (await request(runtime, scenario, "/discard-source")).discarded,
      true,
    );
    logs.push(...runtime.logs);
    await stop(runtime, true);
    runtime = await launch(persistence);
    const sourceAfterLoss = await request(runtime, scenario, "/snapshot");
    assertEmptyPortableTarget(sourceAfterLoss);
    const target = scenario + "_replacement";
    const denials = await verifyPortableImportDenials(
      runtime,
      scenario,
      exportRef,
    );
    const body = { exportRef, expectedFenceToken: "dof_replacement" };
    const imported = await requestJson(runtime, target, "/import", body);
    assert.deepEqual(imported, { ok: true, value: { stateVersion: 1 } });
    const afterImport = await request(runtime, target, "/snapshot");
    assertPortableState(afterImport, before);
    assert.deepEqual(
      afterImport.activation.identity,
      before.activation.identity,
    );
    assert.equal(afterImport.activation.physicalObjectName, target);
    assert.equal(afterImport.activation.placementEpoch, 2);
    assert.equal(afterImport.activation.fenceToken, "dof_replacement");
    const retried = await requestJson(runtime, target, "/import", body);
    assert.deepEqual(retried, { ok: true, value: { stateVersion: 1 } });
    assertPortableState(await request(runtime, target, "/snapshot"), before);
    assert.equal(fixture.modelRequests, 1);
    assert.equal(fixture.productReads, 0);
    const oldLease = await request(runtime, target, "/stale");
    assert.equal(oldLease.ok, false);
    logs.push(...runtime.logs);
    await stop(runtime, true);
    fixture.holdRecovery = false;
    fixture.revoked = scenario === "recovery_portable_revoked";
    runtime = await launch(persistence);
    let resumed;
    if (unknownUsage || fixture.revoked) {
      resumed = await waitFor(
        stoppedRecoveryState.bind(null, runtime, target),
        "restored recovery stop",
      );
      assert.equal(resumed.lease, null);
      assert.deepEqual(resumed.history, before.history);
      assert.deepEqual(resumed.nativeTables, before.nativeTables);
      assert.deepEqual(resumed.budget, before.budget);
      if (unknownUsage) {
        assert.deepEqual(resumed.lifecycle, before.lifecycle);
        assert.equal(resumed.budget.reservation.kind, "indeterminate");
        assert.equal(
          resumed.lifecycle.state.action.evidence.kind,
          "model_usage",
        );
        const refused = await request(runtime, target, "/try-resume");
        assert.equal(refused.ok, false);
      } else {
        assert.deepEqual(resumed.lifecycle.state.action, {
          kind: "blocked",
          reason: "authorization",
        });
        assert.equal(resumed.budget.reservation.kind, "none");
      }
      assert.equal(fixture.modelRequests, 1);
      assert.equal(fixture.productReads, 0);
    } else {
      resumed = await waitFor(
        completedPortableState.bind(null, runtime, target),
        "replacement Actor continuation",
      );
      assert.equal(resumed.submissions[0].id, accepted.submissionId);
      assert.equal(resumed.tasks[0].id, before.tasks[0].id);
      assert.equal(resumed.tasks[1].id, before.tasks[1].id);
      assert.equal(resumed.checkpoint.runtimeLease.generation, 2);
      assert.deepEqual(resumed.checkpoint.turn, interrupted.lease.turn);
      assert.equal(resumed.history.length, 4);
      assert.deepEqual(resumed.history.slice(0, 2), before.history);
      assert.equal(resumed.budget.reservation.kind, "none");
      assert.equal(
        resumed.budget.usage.tokens,
        resumed.history.map(historyReportedTokens).reduce(sum, 0),
      );
      assert.equal(resumed.budget.usage.capabilityCalls, 1);
      assert.equal(fixture.modelRequests, 2);
      assert.equal(fixture.productReads, 1);
    }
    logs.push(...runtime.logs);
    await stop(runtime, true);
    runtime = await launch(persistence);
    const coldReopened = await request(runtime, target, "/snapshot");
    assertPortableState(coldReopened, resumed);
    assert.equal(
      fixture.modelRequests,
      unknownUsage || fixture.revoked ? 1 : 2,
    );
    assert.equal(fixture.productReads, unknownUsage || fixture.revoked ? 0 : 1);
    return {
      ...scenarioEvidence("passed", fixture, before, resumed, null, [
        ...logs,
        ...runtime.logs,
      ]),
      interrupted,
      fenced,
      exportRef,
      sourceAfterLoss,
      ...denials,
      imported,
      retried,
      afterImport,
      oldLease,
      coldReopened,
    };
  } catch (error) {
    return {
      scenario,
      status: "failed",
      error: String(error),
      trace: fixture.events,
      snapshot:
        runtime === null
          ? null
          : await request(runtime, scenario, "/snapshot").catch(failedSnapshot),
      logs: [...logs, ...(runtime?.logs ?? [])],
    };
  } finally {
    await stop(runtime, false);
  }
}

function emptyNativeTable(table) {
  return table.rows.length === 0;
}

function checkpointObjectMatches(key, object) {
  return object.key === key;
}

async function waitFor(predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

function atCrashBoundary(fixture) {
  switch (fixture.scenario) {
    case "model_interruption":
    case "cancelled":
      return fixture.modelRequests === 1;
    case "revoked_authority":
      return fixture.authorizations.length === 1;
    default:
      return fixture.mutations === 1;
  }
}

async function completedSnapshot(runtime, scenario) {
  const snapshot = await request(runtime, scenario, "/snapshot");
  const submission = snapshot.submissions[0];
  if (submission?.status === "done" || submission?.status === "unanswered")
    return snapshot;
  return false;
}

async function evaluateScenario(scenario) {
  const fixture = createFixture(scenario);
  fixtures.set(scenario, fixture);
  const persistence = join(artifacts, scenario);
  let runtime = null;
  let before = null;
  let after = null;
  let noAlarmObservation = null;
  const logs = [];
  try {
    runtime = await launch(persistence);
    const accepted = await request(runtime, scenario, "/start");
    if (!["hook_denial", "transport_denial"].includes(scenario)) {
      await waitFor(
        atCrashBoundary.bind(null, fixture),
        "in-flight interruption boundary",
      );
      before = await request(runtime, scenario, "/snapshot");
      if (scenario === "revoked_authority") fixture.revoked = true;
      if (scenario === "cancelled") await request(runtime, scenario, "/cancel");
      await stop(runtime, true);
      logs.push(...runtime.logs);
      await delay(200);
      runtime = await launch(persistence);
      if (scenario === "no_alarm") {
        await delay(2_000);
        noAlarmObservation = await request(runtime, scenario, "/snapshot");
        assert.equal(fixture.modelRequests, 1);
        assert.equal(fixture.receiptReads.length, 1);
        await request(runtime, scenario, "/resume");
      }
    }
    after = await waitFor(
      completedSnapshot.bind(null, runtime, scenario),
      "settled submission",
    );
    const duplicate = await request(runtime, scenario, "/start");
    assert.equal(duplicate.submissionId, accepted.submissionId);
    assert.equal(after.submissions.length, 1);
    verifyScenario(scenario, fixture, after);
    return scenarioEvidence(
      "passed",
      fixture,
      before,
      after,
      noAlarmObservation,
      logs,
    );
  } catch (error) {
    if (runtime !== null) logs.push(...runtime.logs);
    return {
      ...scenarioEvidence(
        "failed",
        fixture,
        before,
        after,
        noAlarmObservation,
        logs,
      ),
      error: String(error),
    };
  } finally {
    await stop(runtime, false);
  }
}

async function evaluateIntegrationScenario(scenario) {
  const fixture = createFixture(scenario);
  fixtures.set(scenario, fixture);
  const persistence = join(artifacts, scenario);
  let runtime = null;
  let before = null;
  let after = null;
  let rejection = null;
  let stale = null;
  const logs = [];
  try {
    runtime = await launch(persistence);
    if (scenario === "atomic_rollback") {
      const beforeAcceptance = await request(
        runtime,
        scenario,
        "/start?reject=before_acceptance",
      );
      assert.equal(beforeAcceptance.accepted, false);
      const untouched = await request(runtime, scenario, "/snapshot");
      assert.equal(untouched.history.length, 0);
      assert.equal(untouched.submissions.length, 0);
      assert.equal(untouched.tasks.length, 0);
      assert.equal(untouched.entries.length, 0);
      assert.equal(untouched.usage.length, 0);
      assert.equal(untouched.alarm, null);
      assert.equal(fixture.modelRequests, 0);
      const denied = await request(
        runtime,
        scenario,
        "/start?reject=after_writes",
      );
      assert.equal(denied.accepted, false);
      rejection = await request(runtime, scenario, "/snapshot");
      assert.equal(rejection.history.length, 0);
      assert.equal(rejection.submissions.length, 0);
      assert.equal(rejection.tasks.length, 0);
      assert.equal(rejection.entries.length, 0);
      assert.equal(rejection.usage.length, 0);
      assert.equal(rejection.materialization.ok, true);
      assert.equal(rejection.materialization.value.kind, "empty");
      assert(!rejection.publications.includes(rejection.nextSeq));
      assert.equal(rejection.alarm, null);
      assert.equal(fixture.modelRequests, 0);
      assert.deepEqual(rejection.history, untouched.history);
      assert.deepEqual(rejection.entries, untouched.entries);
      assert.deepEqual(rejection.submissions, untouched.submissions);
      assert.deepEqual(rejection.tasks, untouched.tasks);
      assert.deepEqual(rejection.usage, untouched.usage);
      rejection = { ...rejection, beforeAcceptance: untouched };
    }
    const accepted = await request(runtime, scenario, "/start");
    assert.equal(accepted.accepted, true, accepted.error);
    if (scenario !== "atomic_rollback") {
      await waitFor(
        integrationCrashBoundary.bind(null, fixture),
        "integration crash boundary",
      );
      if (scenario === "cancelled_restart")
        await request(runtime, scenario, "/cancel");
      before = await request(runtime, scenario, "/snapshot");
      if (scenario === "publication_gap") {
        assert.equal(before.history.length, 2);
        assert.equal(before.submissions[0].status, "done");
        assert(!before.publications.includes(fixture.heldCommit));
      } else {
        assert.equal(before.history.length, 1);
      }
      await stop(runtime, true);
      logs.push(...runtime.logs);
      await delay(200);
      runtime = await launch(persistence);
    }
    after = await waitFor(
      completedSnapshot.bind(null, runtime, scenario),
      "recovered integrated submission",
    );
    const duplicate = await request(runtime, scenario, "/start");
    assert.equal(duplicate.submissionId, accepted.submissionId);
    assert.equal(after.submissions.length, 1);
    verifyIntegrationScenario(scenario, fixture, after);
    if (canonical) {
      assert.equal(rejection.budget.reservation.acceptedUsage.tokens, 0);
      const usage = JSON.parse(after.history.at(-1).payload).entry.usage;
      assert(usage.totalTokens > 0);
      assert.equal(
        after.budget.reservation.acceptedUsage.tokens,
        usage.totalTokens,
      );
    }
    if (scenario === "restart_admission") {
      stale = await request(runtime, scenario, "/stale");
      assert.equal(stale.ok, false);
      assert.equal(stale.error.code, "harness_lease_stale");
      const unchanged = await request(runtime, scenario, "/snapshot");
      assert.deepEqual(unchanged.history, after.history);
    }
    return integrationEvidence(
      "passed",
      fixture,
      before,
      after,
      rejection,
      stale,
      logs,
    );
  } catch (error) {
    if (runtime !== null) {
      logs.push(...runtime.logs);
      try {
        after = await request(runtime, scenario, "/snapshot");
      } catch {}
    }
    return {
      ...integrationEvidence(
        "failed",
        fixture,
        before,
        after,
        rejection,
        stale,
        logs,
      ),
      error: String(error),
    };
  } finally {
    await stop(runtime, false);
  }
}

function integrationCrashBoundary(fixture) {
  if (fixture.scenario === "publication_gap")
    return fixture.heldCommit !== null;
  return fixture.modelRequests === 1;
}

function verifyIntegrationScenario(scenario, fixture, snapshot) {
  const submission = snapshot.submissions[0];
  assert.equal(snapshot.materialization.ok, true);
  assert.equal(
    snapshot.materialization.value.throughSequence,
    snapshot.history.length,
  );
  assert.equal(snapshot.usage[0].entry_count, snapshot.history.length);
  assert.equal(snapshot.usage[0].through_sequence, snapshot.history.length);
  if (scenario === "cancelled_restart") {
    assert.equal(fixture.modelRequests, 1);
    assert.equal(submission.status, "unanswered");
    assert.equal(submission.reason, "aborted");
    assert.equal(snapshot.history.length, 1);
    assert.equal(snapshot.admission.status, "cancelled");
    assert.equal(snapshot.admission.generation, 1);
    return;
  }
  // Pi 1.5 does not send a model request again after its process is lost.
  // With no retry, the run ends interrupted and the input stays unanswered.
  if (scenario === "restart_admission") {
    assert.equal(fixture.modelRequests, 1);
    assert.equal(submission.status, "unanswered");
    assert.equal(submission.reason, "interrupted");
    assert.equal(snapshot.history.length, 1);
    assert.equal(snapshot.admission.generation, 2);
    return;
  }
  assert.equal(submission.status, "done");
  assert.equal(snapshot.history.length, 2);
  const input = JSON.parse(snapshot.history[0].payload).entry;
  const result = JSON.parse(snapshot.history[1].payload).entry;
  assert.equal(input.kind, "user_input");
  assert.equal(result.kind, "assistant_message");
  assert.equal(result.content[0].text, "COMPLETE");
  assert.equal(fixture.modelRequests, 1);
}

function integrationEvidence(
  status,
  fixture,
  before,
  after,
  rejection,
  stale,
  logs,
) {
  return {
    scenario: fixture.scenario,
    status,
    modelRequests: fixture.modelRequests,
    heldCommit: fixture.heldCommit,
    trace: fixture.events,
    before,
    after,
    rejection,
    stale,
    runtimeLogs: logs,
  };
}

function verifyScenario(scenario, fixture, snapshot) {
  const submission = snapshot.submissions[0];
  switch (scenario) {
    case "receipt_recovery":
    case "no_alarm":
      assert.equal(fixture.mutations, 1);
      assert.equal(fixture.effectAttempts.length, 1);
      assert.equal(fixture.receiptReads.length, 2);
      assert.equal(fixture.productReads, 1);
      assert.equal(fixture.modelRequests, 3);
      assert.equal(fixture.beforeTool.length, 2);
      assert.equal(fixture.authorizations.length, 3);
      assert.equal(submission.status, "done");
      break;
    // Pi 1.5 does not send a model request again after its process is lost.
    // With no retry, the run ends interrupted before any tool runs.
    case "model_interruption":
      assert.equal(fixture.modelRequests, 1);
      assert.equal(fixture.mutations, 0);
      assert.equal(fixture.productReads, 0);
      assert.equal(submission.status, "unanswered");
      assert.equal(submission.reason, "interrupted");
      break;
    case "unsafe_default":
      assert.equal(fixture.mutations, 1);
      assert.equal(fixture.receiptReads.length, 1);
      assert.equal(fixture.productReads, 0);
      assert.equal(fixture.modelRequests, 2);
      assert.equal(submission.status, "done");
      break;
    case "revoked_authority":
      assert.equal(fixture.mutations, 0);
      assert.equal(fixture.authorizations.length, 2);
      assert.equal(fixture.beforeTool.length, 1);
      assert.equal(submission.status, "done");
      break;
    case "cancelled":
      assert.equal(fixture.mutations, 0);
      assert.equal(fixture.modelRequests, 1);
      assert.equal(submission.status, "unanswered");
      assert.equal(submission.reason, "aborted");
      break;
    case "hook_denial":
      assert.equal(fixture.modelRequests, 1);
      assert.equal(submission.status, "done");
      assert(snapshot.reports.some(isHookDenial));
      break;
    case "transport_denial":
      assert.equal(fixture.modelRequests, 0);
      assert.equal(fixture.transportDenials, 1);
      assert.equal(submission.status, "unanswered");
      break;
    default:
      throw new Error(`Unverified scenario: ${scenario}`);
  }
}

function isHookDenial(report) {
  return report.message.includes("denied in hook");
}

function scenarioEvidence(
  status,
  fixture,
  before,
  after,
  noAlarmObservation,
  logs,
) {
  return {
    scenario: fixture.scenario,
    status,
    modelRequests: fixture.modelRequests,
    mutations: fixture.mutations,
    effectAttempts: fixture.effectAttempts,
    receiptReads: fixture.receiptReads,
    productReads: fixture.productReads,
    beforeToolCalls: fixture.beforeTool.length,
    executionAuthorizations: fixture.authorizations.length,
    transportDenials: fixture.transportDenials,
    receipts: [...fixture.receipts.values()],
    trace: fixture.events,
    before,
    after,
    noAlarmObservation,
    runtimeLogs: logs,
    fixtureDigest: createHash("sha256")
      .update(fixture.scenario + ":approved-product-v1")
      .digest("hex"),
  };
}

async function evaluateCheckpointScenario(scenario) {
  const fixture = createFixture(scenario);
  fixtures.set(scenario, fixture);
  const rollback = scenario === "checkpoint_write_rollback";
  let runtime = null;
  let before = null;
  let after = null;
  let denied = null;
  const logs = [];
  try {
    const persistence = join(artifacts, scenario);
    runtime = await launch(persistence);
    const accepted = await request(runtime, scenario, "/start");
    assert.equal(accepted.accepted, true, accepted.error);
    await waitFor(
      checkpointCrashBoundary.bind(null, fixture),
      "checkpoint acceptance boundary",
    );
    before = await request(runtime, scenario, "/snapshot");
    assert.equal(
      before.lifecycle.kind,
      rollback ? "processing" : "checkpointing",
    );
    assert.equal(before.budget.reservation.kind, rollback ? "active" : "none");
    assert.equal(before.history.length, rollback ? 1 : 2);
    assert.equal(before.replay.state.kind, "running");
    assert.equal(before.replay.envelopes.length, rollback ? 0 : 2);
    assert.equal(
      before.checkpointObjects.length,
      scenario === "checkpoint_upload_gap" ? 1 : 0,
    );
    if (rollback) {
      assert.equal(before.checkpoint, null);
      assert.equal(before.checkpointPublication, null);
      assert.notEqual(before.lease, null);
      assert.equal(before.budget.reservation.acceptedUsage.tokens, 0);
      assert.notEqual(before.submissions[0].status, "done");
      assert(!before.publications.includes(before.nextSeq));
    } else {
      assert.equal(before.submissions[0].status, "done");
      assert.equal(before.replay.envelopes[0].event.text, "COMPLETE");
      assert.equal(before.replay.envelopes[1].event.type, "done");
      assert.notEqual(before.checkpoint, null);
      assert.equal(before.lease, null);
      assert.equal(before.oldLease.ok, false);
      assert.equal(before.oldLease.error.code, "harness_lease_missing");
      assert.equal(before.checkpointPublication.kind, "upload_pending");
      assert.equal(
        before.checkpointPublication.sha256,
        before.checkpoint.blob.sha256,
      );
      assert.equal(
        before.checkpointPublication.byteLength,
        before.checkpoint.blob.byteLength,
      );
      const usage = JSON.parse(before.history.at(-1).payload).entry.usage;
      assert(usage.totalTokens > 0);
      assert.equal(before.budget.usage.tokens, usage.totalTokens);
      if (scenario === "checkpoint_upload_gap") {
        assert(before.publications.includes(before.nextSeq - 1));
        assert.equal(
          before.checkpointObjects[0].key,
          before.checkpoint.blob.objectKey,
        );
      } else assert(!before.publications.includes(fixture.heldCommit));
    }
    if (scenario === "checkpoint_revoked_authority") fixture.revoked = true;
    await stop(runtime, true);
    logs.push(...runtime.logs);
    await delay(200);
    runtime = await launch(persistence);
    if (scenario === "checkpoint_revoked_authority") {
      denied = await waitFor(
        stoppedCanonicalSnapshot.bind(null, runtime, scenario),
        "denied finalization stops",
      );
      assert.equal(denied.lifecycle.kind, "checkpointing");
      assert.equal(denied.replay.state.kind, "running");
      assert.deepEqual(denied.checkpoint, before.checkpoint);
      assert.deepEqual(denied.history, before.history);
      assert.deepEqual(denied.budget, before.budget);
      assert.equal(fixture.authorizations.length, 1);
      fixture.revoked = false;
      const wake = await request(runtime, scenario, "/wake");
      assert.equal(wake.scheduled, true);
    }
    after = await waitFor(
      checkpointRecoveredSnapshot.bind(null, runtime, scenario, rollback),
      "checkpoint recovery",
    );
    assert.equal(after.lease, null);
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.submissions, before.submissions);
    assert.deepEqual(after.history, before.history);
    assert.deepEqual(after.budget.usage, before.budget.usage);
    if (rollback) {
      assert(after.budget.usageCursor > before.budget.usageCursor);
      assert.deepEqual(
        after.budget.reservation.reservation,
        before.budget.reservation.reservation,
      );
      assert.deepEqual(
        after.budget.reservation.acceptedUsage,
        before.budget.reservation.acceptedUsage,
      );
    } else assert.equal(after.budget.usageCursor, before.budget.usageCursor);
    assert.deepEqual(after.checkpoint, before.checkpoint);
    assert.deepEqual(after.replay.envelopes, before.replay.envelopes);
    assert.equal(
      after.replay.state.lastSequence,
      before.replay.state.lastSequence,
    );
    assert.equal(fixture.modelRequests, 1);
    if (rollback) {
      assert.equal(after.lifecycle.state.recovery.kind, "terminate_only");
      assert.equal(after.checkpoint, null);
      assert.equal(after.checkpointPublication, null);
      assert.equal(after.checkpointObjects.length, 0);
      assert.equal(after.budget.reservation.kind, "indeterminate");
      assert.equal(after.replay.state.kind, "failed");
      assert.equal(after.replay.state.errorDetail, "session_interrupted");
      assert.equal(fixture.authorizations.length, 0);
    } else {
      assert.equal(after.replay.state.kind, "complete");
      assert.deepEqual(after.budget, before.budget);
      assert.equal(after.checkpointPublication.kind, "published");
      assert.equal(after.checkpointObjects.length, 1);
      assert.equal(
        after.checkpointObjects[0].key,
        after.checkpoint.blob.objectKey,
      );
      if (scenario === "checkpoint_upload_gap")
        assert.deepEqual(after.checkpointObjects, before.checkpointObjects);
      assert.equal(after.lifecycle.state.resumePoint.kind, "checkpoint");
      assert.equal(
        after.lifecycle.state.resumePoint.checkpoint.stateDigest,
        before.checkpoint.blob.sha256,
      );
      assert.equal(
        fixture.authorizations.length,
        scenario === "checkpoint_revoked_authority" ||
          scenario === "checkpoint_upload_gap"
          ? 3
          : 2,
      );
    }
    const repeated = await request(runtime, scenario, "/snapshot");
    assert.deepEqual(repeated, after);
    return {
      scenario,
      status: "passed",
      conclusion: rollback
        ? "Pi completion, terminal output, settled usage and pending checkpoint payload roll back together; interrupted usage remains indeterminate."
        : "An accepted Pi completion uploads its saved payload and finalizes after SIGKILL before R2 publication with one model request.",
      modelRequests: fixture.modelRequests,
      heldCommit: fixture.heldCommit,
      heldUpload: fixture.heldUpload,
      rejectedCheckpoint: fixture.rejectedCheckpoint,
      trace: fixture.events,
      before,
      denied,
      after,
      logs,
    };
  } catch (error) {
    if (runtime !== null) {
      logs.push(...runtime.logs);
      try {
        after = await request(runtime, scenario, "/snapshot");
      } catch {}
    }
    return {
      scenario,
      status: "failed",
      error: String(error),
      before,
      denied,
      after,
      trace: fixture.events,
      logs,
    };
  } finally {
    await stop(runtime, false);
  }
}

function checkpointCrashBoundary(fixture) {
  return (
    fixture.heldCommit !== null ||
    fixture.rejectedCheckpoint ||
    fixture.heldUpload !== null
  );
}

async function checkpointRecoveredSnapshot(runtime, scenario, rollback) {
  const snapshot = await request(runtime, scenario, "/snapshot");
  const expected = rollback ? "quarantined" : "sleeping";
  return snapshot.lifecycle.kind === expected && snapshot.alarm === null
    ? snapshot
    : null;
}

async function evaluateCanonicalScenario(scenario) {
  const fixture = createFixture(scenario);
  fixtures.set(scenario, fixture);
  let runtime = null;
  let before = null;
  let after = null;
  const logs = [];
  try {
    const persistence = join(artifacts, scenario);
    runtime = await launch(persistence);
    const accepted = await request(runtime, scenario, "/start");
    assert.equal(accepted.accepted, true, accepted.error);
    await waitFor(
      canonicalCrashBoundary.bind(null, fixture),
      "canonical interruption boundary",
    );
    before = await request(runtime, scenario, "/snapshot");
    const completed = scenario === "completion_commit";
    assert.equal(
      before.lifecycle.kind,
      completed ? "checkpointing" : "processing",
    );
    assert.equal(before.budget.reservation.kind, completed ? "none" : "active");
    assert.equal(
      before.history.length,
      scenario === "publication_gap" || completed ? 2 : 1,
    );
    if (scenario === "publication_gap" || completed) {
      const usage = JSON.parse(before.history.at(-1).payload).entry.usage;
      assert(usage.totalTokens > 0);
      assert.equal(before.budget.usage.tokens, usage.totalTokens);
      assert.equal(before.submissions[0].status, "done");
      assert(!before.publications.includes(fixture.heldCommit));
    }
    if (scenario === "model_usage_rollback") {
      assert(fixture.rejectedUsage > 0);
      assert.equal(before.budget.reservation.acceptedUsage.tokens, 0);
      assert.equal(before.usage[0].entry_count, 1);
      assert.equal(before.entries.length, 1);
      assert.notEqual(before.submissions[0].status, "done");
      assert(!before.publications.includes(before.nextSeq));
    }
    await stop(runtime, true);
    logs.push(...runtime.logs);
    await delay(200);
    runtime = await launch(persistence);
    after = await request(runtime, scenario, "/snapshot");
    assert.equal(after.lifecycle.kind, "quarantined");
    assert.equal(after.lifecycle.state.recovery.kind, "terminate_only");
    assert.equal(
      after.budget.reservation.kind,
      completed ? "none" : "indeterminate",
    );
    assert.equal(after.lease, null);
    assert.deepEqual(after.history, before.history);
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.submissions, before.submissions);
    assert.equal(after.budget.usage.tokens, before.budget.usage.tokens);
    const denied = await request(runtime, scenario, "/start");
    assert.equal(denied.accepted, false);
    const repeated = await waitFor(
      stoppedCanonicalSnapshot.bind(null, runtime, scenario),
      "quarantined recovery alarm cleared",
    );
    assert.equal(fixture.modelRequests, 1);
    assert.deepEqual(repeated.history, before.history);
    assert.deepEqual(repeated.lifecycle, after.lifecycle);
    assert.equal(repeated.alarm, null);
    return {
      scenario,
      status: "passed",
      conclusion:
        "Current canonical recovery blocks Pi resume; recovery and budget reconciliation remain adoption gates.",
      before,
      after: repeated,
      denied,
      modelRequests: fixture.modelRequests,
      rejectedUsage: fixture.rejectedUsage,
      logs,
    };
  } catch (error) {
    if (runtime !== null) logs.push(...runtime.logs);
    return {
      scenario,
      status: "failed",
      error: String(error),
      before,
      after,
      logs,
    };
  } finally {
    await stop(runtime, false);
  }
}

function canonicalCrashBoundary(fixture) {
  if (
    fixture.scenario === "publication_gap" ||
    fixture.scenario === "completion_commit"
  )
    return fixture.heldCommit !== null;
  return fixture.scenario === "model_usage_rollback"
    ? fixture.rejectedUsage !== null
    : integrationCrashBoundary(fixture);
}

async function stoppedCanonicalSnapshot(runtime, scenario) {
  const snapshot = await request(runtime, scenario, "/snapshot");
  return snapshot.alarm === null ? snapshot : null;
}

function isInventoryTool(tool) {
  return tool.function.description.includes("inventory_read");
}

function discoveryEvidence(fixture) {
  const requests = fixture.events.filter(isNativeModelRequest);
  const discovered = requests[1].body.messages.find(isDiscoveryResult);
  const definitions = JSON.parse(discovered.content);
  assert.equal(definitions.length, 2);
  assert(!JSON.stringify(requests).includes("unreviewed_write"));
  return {
    catalogSize: 2,
    selectedTools: definitions.map(discoveredToolName),
    resultBytes: Buffer.byteLength(discovered.content),
    modelRequestToNextRequestMs: requests[1].at - requests[0].at,
    ranking:
      "exact name, name substring, matching query words, stable name tie-break",
  };
}

function isNativeModelRequest(event) {
  return event.path.startsWith("/openrouter");
}

function isDiscoveryResult(message) {
  return (
    message.role === "tool" && message.tool_call_id === "discover_original"
  );
}

function discoveredToolName(definition) {
  return definition.name;
}

function respondMcp(fixture, envelope, response) {
  assert.deepEqual(envelope.authentication, {
    kind: "bearer",
    value: "native-mcp-synthetic-secret",
  });
  assert.equal(envelope.address, "93.184.216.34");
  const operation = envelope.operation;
  assert.equal(operation.url, "https://mcp.example.net/mcp");
  if (operation.kind === "mcp_delete") {
    assert(fixture.mcpSessions.delete(operation.sessionId));
    return sendJson(response, {
      status: 204,
      contentType: null,
      bodyBase64: "",
    });
  }
  assert.equal(operation.kind, "mcp_post");
  const message = JSON.parse(
    Buffer.from(operation.bodyBase64, "base64").toString(),
  );
  const sessionId =
    operation.sessionId ??
    `mcp_${fixture.mcpSessions.size}_${fixture.events.length}`;
  if (message.method === "initialize") fixture.mcpSessions.add(sessionId);
  else assert(fixture.mcpSessions.has(sessionId));
  fixture.events.push({ path: "/mcp", body: message, at: Date.now() });
  let result;
  switch (message.method) {
    case "initialize":
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "supplier", version: "1" },
      };
      break;
    case "notifications/initialized":
      return sendJson(response, {
        status: 202,
        contentType: null,
        bodyBase64: "",
        sessionId,
      });
    case "tools/list":
      result = {
        tools: [
          { name: "account", inputSchema: { type: "object", properties: {} } },
          {
            name: "inventory_read",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "unreviewed_write",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
      break;
    case "tools/call":
      assert(["account", "inventory_read"].includes(message.params.name));
      fixture.mcpCalls.push(message.params.name);
      result = {
        content: [],
        structuredContent:
          message.params.name === "account"
            ? { id: "supplier_1", name: "Supplier" }
            : { count: 7 },
      };
      break;
    default:
      throw new Error(`Unexpected MCP method ${message.method}`);
  }
  return sendJson(response, {
    status: 200,
    contentType: "application/json",
    bodyBase64: Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
    ).toString("base64"),
    sessionId,
  });
}

function isSteeringFact(row) {
  const entry = JSON.parse(row.payload).entry;
  return (
    entry.kind === "user_input" &&
    JSON.stringify(entry.content).includes("Report the saved inventory total.")
  );
}

function isUserMessage(message) {
  return message.role === "user";
}
async function completedQueuedState(runtime, scenario) {
  const snapshot = await request(runtime, scenario, "/snapshot");
  if (
    snapshot.lifecycle.kind !== "sleeping" ||
    snapshot.submissions[1]?.status !== "done"
  )
    return null;
  assert.equal(snapshot.submissions[0].status, "done");
  return snapshot;
}
function isCancelledPartialEntry(entry) {
  return (
    entry.kind === "pi.assistant" &&
    JSON.stringify(entry.model).includes("R50_PARTIAL_RESPONSE_UNACCEPTED")
  );
}

function steeringModelHeld(fixture) {
  return fixture.steeringModelHeld === true;
}

async function openReplay(
  runtime,
  scenario,
  after,
  path = "/replay",
  requester = null,
) {
  const url = new URL(path, runtime.url);
  url.searchParams.set("scenario", scenario);
  url.searchParams.set("after", String(after));
  if (path === "/portal-replay")
    url.searchParams.set("turn", "turn_plan50_seams");
  const response = await fetch(url, {
    headers: requester === null ? {} : { "x-trial-user-id": requester },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(await response.text());
  return response;
}

async function observeAcceptedProgress(
  runtime,
  scenario,
  path = "/replay",
  kind = "event",
  requester = null,
) {
  const response = await openReplay(runtime, scenario, -1, path, requester);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const events = [];
  try {
    while (events.length < 2) {
      const chunk = await reader.read();
      assert(!chunk.done, "Replay closed before accepted tool progress");
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (line.length === 0) continue;
        const record = JSON.parse(line);
        if (record.kind !== kind) continue;
        if (kind === "event") events.push(record.envelope);
        else events.push(record);
      }
    }
    return events;
  } finally {
    await reader.cancel();
  }
}
async function readCompletedReplay(
  runtime,
  scenario,
  after,
  path = "/replay",
  requester = null,
) {
  const response = await openReplay(runtime, scenario, after, path, requester);
  return (await response.text()).trim().split("\n").map(parseReplayLine);
}
function parseReplayLine(line) {
  return JSON.parse(line);
}
function isReplayEvent(record) {
  return record.kind === "event";
}
function replayEnvelope(record) {
  return record.envelope;
}
function eventTool(envelope) {
  return envelope.event.tool;
}
function progressLabel(record) {
  return record.label;
}
function recordKind(record) {
  return record.kind;
}

function taskItemId(item) {
  return item.id;
}
function nativeTaskItemId(id) {
  return `task_${id}`;
}
