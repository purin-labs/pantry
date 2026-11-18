import { DurableObject } from "cloudflare:workers";
import { CandidateActor as CodeModeActor } from "./codemode-worker.mjs";
export {
  default,
  ProposalOrganisation,
  ProposalCase,
  CodeModePlatformGovernorActor,
} from "./codemode-worker.mjs";
import { organisationId, userId } from "./proposal-worker.mjs";
import { OrganisationExecutionScope } from "../../services/platform/src/organisation-execution-scope.ts";
import {
  prepareWorkspaceRevisionMutation,
  commitWorkspaceRevision,
  readWorkspaceRevision,
  readCurrentWorkspaceRevisionReceipt,
} from "../../services/platform/src/workspace-revision-store.ts";
import { createAccessGrant } from "../../services/platform/src/data/access-grants.ts";
import { updateWorkspaceProductFolderForEmbeddedHarness } from "../../services/platform/src/agent-tools/files/handlers.ts";
import {
  authorizeWorkspaceExecutorDispatch,
  dispatchWorkspaceExecution,
  executeRecordedWorkspaceOperation,
  recoverRecordedWorkspaceOperation,
  releaseRecordedWorkspaceOperation,
} from "../../services/platform/src/workspace-executor-container.ts";
import { SessionExecutionAdmission } from "../../services/platform/src/actors/session-execution-admission.ts";

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export class WorkspaceExecutor extends DurableObject {
  executeWorkspaceOperation(request, authority) {
    return executeRecordedWorkspaceOperation(
      this.ctx.storage.sql,
      request,
      authorizeWorkspaceExecutorDispatch.bind(
        null,
        this.env,
        authority,
        request,
      ),
      dispatchWorkspaceExecution.bind(
        null,
        { containerFetch: this.forward.bind(this) },
        request,
      ),
      retainSharedExecutor,
    );
  }

  recoverWorkspaceOperation(request) {
    return recoverRecordedWorkspaceOperation(
      this.ctx.storage.sql,
      request,
      retainSharedExecutor,
    );
  }

  releaseWorkspaceOperation(request) {
    return releaseRecordedWorkspaceOperation(
      this.ctx.storage.sql,
      request,
      retainSharedExecutor,
    );
  }

  forward(_url, init) {
    return fetch(`${this.env.PROVIDER_URL}/workspace-execute`, {
      method: "POST",
      body: JSON.stringify({
        scenario: this.env.TRIAL_SCENARIO,
        request: JSON.parse(init.body),
      }),
      signal: init.signal,
    });
  }
}

// The harness owns the shared native server and stops it after all actors finish.
async function retainSharedExecutor() {}

export class CandidateActor extends CodeModeActor {
  toolReplay(name) {
    if (name === "workspace_product_folder_update") return "safe";
    return super.toolReplay(name);
  }
  profileCapabilities() {
    return [...super.profileCapabilities(), "workspace.product_folder.update"];
  }

  toolDefinitions(host) {
    return [
      ...super.toolDefinitions(host),
      ...host.definitions.filter(isWorkspaceUpdate),
    ];
  }

  initialState() {
    const initial = super.initialState();
    return {
      kind: initial.kind,
      state: {
        identity: initial.state.identity,
        contract: initial.state.contract,
        resumePoint: {
          kind: "new",
          workspaceRevisionReceipt: this.workspaceReceipt,
        },
      },
    };
  }

  async fetch(request) {
    if (new URL(request.url).pathname === "/workspace-direct-probe") {
      const host = await this.toolHost(this.currentLease());
      return Response.json(
        await host.executeTool(
          "workspace_product_folder_update",
          JSON.stringify(await request.json()),
          "workspace_direct_probe",
        ),
      );
    }
    if (new URL(request.url).pathname === "/start") {
      const fixture = JSON.parse(this.env.WORKSPACE_FIXTURE);
      this.workspaceReceipt = await this.ctx.storage.get(
        "workspace_initial_receipt",
      );
      if (this.workspaceReceipt === undefined) {
        const row = await this.env.DB.prepare(
          "SELECT body FROM policy_snapshot WHERE organisation_id = ? AND version = 1",
        )
          .bind(organisationId)
          .first();
        const policy = JSON.parse(row.body);
        policy.authz.allowedTools.push("workspace.product_folder.update");
        await this.env.DB.prepare(
          "UPDATE policy_snapshot SET body = ? WHERE organisation_id = ? AND version = 1",
        )
          .bind(JSON.stringify(policy), organisationId)
          .run();
        const scope = required(
          await OrganisationExecutionScope.resolve(this.env, organisationId),
        );
        const prepared = required(
          await prepareWorkspaceRevisionMutation(
            scope,
            { kind: "placement" },
            this.env.ARCHIVE,
            {
              kind: "genesis",
              organisationId,
              workspaceId: fixture.workspaceId,
              files: fixture.files,
              idempotencyKey: "workspace_trial_genesis",
              correlationId: "trial",
              causation: {
                kind: "command",
                commandId: "workspace_trial_genesis",
              },
              committedAt: 1800000000000,
            },
          ),
        );
        this.workspaceReceipt = required(
          await commitWorkspaceRevision(this.env.ARCHIVE, prepared),
        ).receipt;
        await this.ctx.storage.put(
          "workspace_initial_receipt",
          this.workspaceReceipt,
        );
        required(
          await createAccessGrant({
            db: this.env.DB,
            organisationId,
            grantId: "grant_native_workspace_update",
            target: {
              kind: "platform_capability",
              capabilityId: "workspace.product_folder.update",
              capabilityVersion: 1,
            },
            subject: {
              kind: "person",
              personId: `person_${userId}`,
            },
            provenance: {
              kind: "operator",
              userId,
              mutationReceiptId: "receipt_trial_grants",
            },
            now: Date.now(),
          }),
        );
      }
      await fetch(`${this.env.PROVIDER_URL}/workspace-initialized`, {
        method: "POST",
        body: JSON.stringify({
          scenario: this.env.TRIAL_SCENARIO,
          receipt: this.workspaceReceipt,
        }),
      });
    }
    return super.fetch(request);
  }

  async updateWorkspaceProductFolder(lease, input, executionLease) {
    const admission = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      organisationId,
    );
    if (admission === null)
      throw new Error("Workspace execution admission denied");
    return updateWorkspaceProductFolderForEmbeddedHarness(
      this.toolContext(admission, lease),
      input,
      executionLease,
    );
  }

  turnRequest(now, startId, nextTurnId, generation) {
    const request = super.turnRequest(now, startId, nextTurnId, generation);
    const current = this.lifecycle();
    let receipt;
    if (current === null) receipt = this.workspaceReceipt;
    else if (current.kind === "checkpointing")
      receipt = current.state.workspaceRevisionReceipt;
    else if (current.state.resumePoint.kind === "new")
      receipt = current.state.resumePoint.workspaceRevisionReceipt;
    else
      receipt = current.state.resumePoint.checkpoint.workspaceRevisionReceipt;
    request.input.workspaceRevision = receipt.revision;
    return request;
  }

  async snapshot() {
    const snapshot = await super.snapshot();
    const fixture = JSON.parse(this.env.WORKSPACE_FIXTURE);
    const receipt = required(
      await readCurrentWorkspaceRevisionReceipt(
        this.env.DB,
        organisationId,
        fixture.workspaceId,
      ),
    );
    const materialized = required(
      await readWorkspaceRevision(this.env.DB, this.env.ARCHIVE, {
        organisationId,
        workspaceId: fixture.workspaceId,
        revision: receipt.revision,
      }),
    );
    const counts = await this.env.DB.prepare(
      "SELECT COUNT(*) AS revisions FROM workspace_revision WHERE organisation_id = ? AND workspace_id = ?",
    )
      .bind(organisationId, fixture.workspaceId)
      .first();
    const executionRows = this.ctx.storage.sql
      .exec(
        "SELECT effect_id, request_envelope, state_kind, state_projection FROM actor_outbox WHERE effect_id LIKE 'execution-%'",
      )
      .toArray();
    return {
      ...snapshot,
      workspace: { receipt, materialized, counts },
      executionRows,
    };
  }
}

function isWorkspaceUpdate(tool) {
  return tool.name === "workspace_product_folder_update";
}
