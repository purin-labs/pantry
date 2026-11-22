import {
  prepareCustomConnectorDraftDocument,
  createCustomConnectorDraft,
  validateCustomConnectorRevision,
  approveCustomConnectorRevision,
  startCustomConnectorSetup,
  attachCustomConnectorCandidateCredential,
  testCustomConnectorCandidate,
  createCustomConnectorIdentityTestExecutor,
  authorizeCustomConnectorSetupCommit,
  commitNewCustomConnectorAccount,
  compileCustomConnectorReadCatalog,
  authorizeCustomConnectorRead,
  executeAuthorizedCustomConnectorRead,
} from "../../areas/integrations/server/custom-connectors/index.ts";
import { customConnectorResourceScope } from "../../areas/integrations/server/custom-connectors/execution.ts";
import { createAccessGrant } from "../../foundation/authority/data/access-grants.ts";
import {
  compileTrialTurnAuthority,
  trialAccountAccess,
} from "./account-authority.mjs";
import { admitSessionInformationFlowObservation } from "../../foundation/agent/actors/agent-session-information-flow.ts";
import { ObservationEvidence } from "../../foundation/authority/policy/information-flow/index.ts";
import { digestCanonical } from "../../foundation/authority/policy/information-flow/digest.ts";
import { preflightHarnessTurnLease } from "../../foundation/agent/actors/agent-session-harness-authority.ts";
import {
  organisationId,
  sessionId,
  userId,
  authorizeTrialObservationCommit,
} from "./proposal-worker.mjs";

const origin = "https://mcp.example.net";
const schema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
const subject = {
  kind: "workflow",
  workflowKind: "cue_subscription",
  workflowId: "workflow_plan50_seams",
  workflowRevision: 1,
};
const nativeFetch = globalThis.fetch;

// Only DNS is controlled here; the production egress validator and MCP client run unchanged.
globalThis.fetch = fixtureFetch;
function fixtureFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (
    url.hostname === "cloudflare-dns.com" &&
    url.searchParams.get("name") === "mcp.example.net"
  ) {
    const type = url.searchParams.get("type");
    const answer =
      type === "A" || type === "1"
        ? [{ name: "mcp.example.net", type: 1, TTL: 60, data: "93.184.216.34" }]
        : [];
    return Promise.resolve(Response.json({ Status: 0, Answer: answer }));
  }
  return nativeFetch(input, init);
}

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
async function vaultRoot() {
  return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
}
export const vaultKeys = {
  PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
  VAULT_ROOT_V1: { get: vaultRoot },
};
export const cursorKey = "native-mcp-trial-cursor-signing-key-00000000";

export class McpFixture {
  constructor(env, scenario) {
    this.env = env;
    this.scenario = scenario;
  }
  containerOf(name) {
    if (name !== organisationId) throw new Error("Unexpected MCP organisation");
    return { fetch: this.fetch.bind(this) };
  }
  async fetch(url, init) {
    if (String(url) !== "http://container/v1/fetch")
      throw new Error("Unexpected MCP egress endpoint");
    const target = new URL("/mcp-egress", this.env.PROVIDER_URL);
    target.searchParams.set("scenario", this.scenario);
    return nativeFetch(target, init);
  }
}

export async function installMcpFixture(env, scenario) {
  const present = await env.DB.prepare(
    "SELECT connector_id FROM custom_connector WHERE organisation_id = ? LIMIT 1",
  )
    .bind(organisationId)
    .first();
  if (present !== null) return;
  const document = required(
    await prepareCustomConnectorDraftDocument({
      schemaVersion: 1,
      name: "Supplier MCP",
      description: "Reviewed supplier inventory.",
      origin,
      authentication: { kind: "bearer" },
      documentation: [{ url: `${origin}/docs`, sha256: "3".repeat(64) }],
      operations: [
        operation("account", {
          id: { type: "string", minLength: 1, maxLength: 128 },
          name: { type: "string", minLength: 1, maxLength: 128 },
        }),
        operation("inventory_read", {
          count: { type: "integer", minimum: 0, maximum: 100 },
        }),
      ],
      identity: {
        operationId: "account",
        arguments: {},
        accountIdPointer: "/id",
        displayNamePointer: "/name",
      },
      limits: {},
    }),
  );
  const draft = await createCustomConnectorDraft({
    db: env.DB,
    organisationId,
    createdByUserId: userId,
    document,
    now: Date.now(),
  });
  const validated = required(
    await validateCustomConnectorRevision({
      db: env.DB,
      organisationId,
      connectorId: draft.connectorId,
      revision: draft.revision,
      authoringDigest: draft.authoringDigest,
      now: Date.now(),
    }),
  );
  const approved = required(
    await approveCustomConnectorRevision({
      db: env.DB,
      organisationId,
      connectorId: draft.connectorId,
      revision: draft.revision,
      definitionDigest: validated.definitionDigest,
      approvedByUserId: userId,
      review: {
        origin,
        effects: [
          { operationId: "account", effect: "read" },
          { operationId: "inventory_read", effect: "read" },
        ],
      },
      now: Date.now(),
    }),
  );
  const started = required(
    await startCustomConnectorSetup({
      db: env.DB,
      organisationId,
      connectorId: draft.connectorId,
      connectorRevision: draft.revision,
      definitionDigest: approved.definitionDigest,
      target: { kind: "new_account", environment: "development" },
      createdByUserId: userId,
      now: Date.now(),
    }),
  );
  const attached = required(
    await attachCustomConnectorCandidateCredential({
      db: env.DB,
      keys: vaultKeys,
      organisationId,
      attemptId: started.attemptId,
      expectedAttemptRevision: started.attemptRevision,
      credentialValue: "native-mcp-synthetic-secret",
      now: Date.now(),
    }),
  );
  const tested = required(
    await testCustomConnectorCandidate({
      db: env.DB,
      keys: vaultKeys,
      organisationId,
      attemptId: attached.attemptId,
      expectedAttemptRevision: attached.attemptRevision,
      executor: createCustomConnectorIdentityTestExecutor(
        new McpFixture(env, scenario),
      ),
      now: Date.now(),
    }),
  );
  const authorization = required(
    await authorizeCustomConnectorSetupCommit({
      db: env.DB,
      keys: vaultKeys,
      organisationId,
      attemptId: tested.attempt.attemptId,
      expectedAttemptRevision: tested.attempt.attemptRevision,
      now: Date.now(),
    }),
  );
  const config = await env.DB.prepare(
    "SELECT configuration_version AS version FROM organisation_onboarding WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .first();
  const committed = required(
    await commitNewCustomConnectorAccount({
      db: env.DB,
      authorization,
      committedByUserId: userId,
      expectedConfigurationVersion: config.version,
      now: Date.now(),
    }),
  );
  const targets = [
    {
      kind: "platform_capability",
      capabilityId: "custom_connector.read",
      capabilityVersion: 1,
    },
    {
      kind: "custom_connector_operation",
      capabilityId: "custom_connector.read",
      capabilityVersion: 1,
      integrationAccountId: committed.integrationAccountId,
      connectorId: draft.connectorId,
      definitionRevision: draft.revision,
      definitionDigest: approved.definitionDigest,
      operationId: "inventory_read",
    },
  ];
  for (const target of targets)
    required(
      await createAccessGrant({
        db: env.DB,
        organisationId,
        grantId: `grant_native_mcp_${target.kind}`,
        subject,
        target,
        provenance: {
          kind: "operator",
          userId,
          mutationReceiptId: "native_mcp_grant",
        },
        now: Date.now(),
      }),
    );
  const row = await env.DB.prepare(
    "SELECT body FROM policy_snapshot WHERE organisation_id = ? AND version = 1",
  )
    .bind(organisationId)
    .first();
  const policy = JSON.parse(row.body);
  policy.authz.allowedTools.push("custom_connector.read");
  await env.DB.prepare(
    "UPDATE policy_snapshot SET body = ? WHERE organisation_id = ? AND version = 1",
  )
    .bind(JSON.stringify(policy), organisationId)
    .run();
}

function operation(id, properties) {
  return {
    id,
    description: `Read ${id}.`,
    effect: { kind: "read" },
    inputSchema: schema,
    transport: { kind: "mcp", endpointPath: "/mcp", toolName: id },
    response: {
      successStatuses: [200],
      resultPointer: "/structuredContent",
      outputSchema: {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
      classification: "internal",
    },
    pagination: { kind: "none" },
  };
}

export async function mcpCatalog(env, requestAuthority) {
  const compiled = required(
    await compileTrialTurnAuthority(env, {
      organisationId,
      sessionId,
      turnId: "turn_plan50_seams",
      requestAuthority,
      policy: { version: 1 },
    }),
  );
  const entries = required(
    await compileCustomConnectorReadCatalog({
      db: env.DB,
      effectiveGrants: compiled.effectiveGrantSet,
    }),
  );
  if (entries.length !== 1) throw new Error("Expected one admitted MCP read");
  return { entries, effectiveGrants: compiled.effectiveGrantSet };
}

export async function readMcp(
  actor,
  lease,
  binding,
  catalog,
  entry,
  rawArguments,
  operationId,
) {
  await actor.preflight(lease);
  const authorization = required(
    await authorizeCustomConnectorRead({
      db: actor.env.DB,
      accountAccess: await trialAccountAccess(actor.env, organisationId),
      effectiveGrants: catalog.effectiveGrants,
      acceptedEntry: entry,
      rawArguments,
      flowBinding: binding,
      destinationAuthority: lease.requestAuthority,
      execution: {
        executionId: `custom_connector:${lease.turn.turnId}:${operationId}`,
        leaseId: lease.leaseId,
        deadlineAtUnixMs: Math.min(
          lease.expiresAt,
          Date.now() + entry.limits.invocationTimeoutMs,
        ),
      },
      cursorSigningKey: cursorKey,
      now: Date.now(),
    }),
  );
  const scenario = await actor.ctx.storage.get("evaluation_scenario");
  const result = required(
    await executeAuthorizedCustomConnectorRead({
      db: actor.env.DB,
      keys: vaultKeys,
      namespace: new McpFixture(actor.env, scenario),
      authorization,
      effectiveGrants: catalog.effectiveGrants,
      isExecutionActive: executionActive.bind(null, actor, lease),
      cursorSigningKey: cursorKey,
      now: Date.now(),
    }),
  );
  const observedAt = Date.now();
  const evidence = required(
    await ObservationEvidence.create({
      source: {
        kind: "integration_resource",
        organisationId,
        integrationAccountId: entry.integrationAccountId,
        resourceScope: customConnectorResourceScope(entry),
      },
      sourceRevision: entry.bindingRevision,
      contentDigest: await digestCanonical(result.data),
      inputLabel: result.sourceLabel,
      observedAt,
    }),
  );
  required(
    await admitSessionInformationFlowObservation({
      authorizeCommit: authorizeTrialObservationCommit.bind(null, actor, lease),
      sql: actor.ctx.storage.sql,
      transactionSync: actor.ctx.storage.transactionSync.bind(
        actor.ctx.storage,
      ),
      organisationId,
      sessionId: lease.session.sessionId,
      turnId: lease.turn.turnId,
      authorityPartitionDigest: lease.authorityPartitionDigest,
      inputLabel: result.sourceLabel,
      observation: evidence,
      observedAt,
    }),
  );
  await actor.preflight(lease);
  return result.data;
}
function executionActive(actor, lease) {
  return preflightHarnessTurnLease(actor.ctx.storage, lease, Date.now()).ok;
}
