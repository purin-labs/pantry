// The draft trial runs the Portal agent of the draft collaboration trial
// without a browser. A person's turn edits the shared description draft
// through the Organisation actor, the response is lost, and a second person
// edits the same draft through the draft socket before the Session recovers.
import collaboration, {
  CandidateActor as CollaborationActor,
  ProposalOrganisation as CollaborationOrganisation,
} from "./draft-collaboration-worker.mjs";
export { ProposalCase } from "./provider-worker.mjs";
export { CodeModePlatformGovernorActor } from "./codemode-worker.mjs";
import { organisationId, userId } from "./proposal-worker.mjs";
import { humanUser } from "./draft-seed.mjs";
import { editProductDescriptionDraftForEmbeddedHarness } from "../../services/platform/src/agent-tools/commerce/description-draft-handlers.ts";
import { settleToolEffect } from "../../services/platform/src/agent-tools/session-support.ts";
import { uncheckedEffect } from "../../services/platform/src/agent-tools/tool-effect.ts";
import { SessionExecutionAdmission } from "../../services/platform/src/actors/session-execution-admission.ts";
import { issueControlSession } from "../../services/platform/src/data/control-plane.ts";
import { matchProductDescriptionDraftRoute } from "../../services/platform/src/control/admission/product-description-draft.ts";
import { handleProductDescriptionDraftRoute } from "../../services/platform/src/control/routes/product-description-draft.ts";
import {
  ProductDescriptionDoc,
  parseProductDescriptionState,
} from "../../packages/product-description-crdt/src/index.ts";
import {
  encodeDraftClientMessage,
  parseDraftServerMessage,
} from "../../packages/product-description-crdt/src/protocol.ts";
import { sha256Hex } from "../../packages/std/src/index.ts";

const productId = "product_financier";
const humanNote = " Serve with tea.";

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export class ProposalOrganisation extends CollaborationOrganisation {
  /** The saved draft text and receipts, read from the actor's own storage. */
  savedDraft() {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT encoded_state FROM product_description_draft WHERE product_id = ?",
        productId,
      )
      .toArray()[0];
    if (row === undefined) return { description: null, receipts: [] };
    const state = required(
      parseProductDescriptionState(new Uint8Array(row.encoded_state)),
    );
    return {
      description: required(ProductDescriptionDoc.restore(state)).read(),
      receipts: this.draftEvidence(),
    };
  }
}

export class CandidateActor extends CollaborationActor {
  // A frozen placement stops recovery before the saved edit runs again; the
  // Code Mode actor then checks the turn's current authority.
  async admitRecovery() {
    // A wait for the draft receipt resumes only after reconciliation.
    if (this.lifecycle()?.state.action.kind === "await_evidence") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const admission = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      organisationId,
    );
    if (admission === null || !(await admission.isActive())) {
      this.updateAction({ kind: "blocked", reason: "authorization" });
      await this.ctx.storage.deleteAlarm();
      return;
    }
    return super.admitRecovery();
  }

  // The tool gives its effect. This trial holds the receipt owner around the
  // whole edit, so the edit and its exit check run inside the effect.
  async editProductDescriptionDraft(lease, request, operationId) {
    return uncheckedEffect(() =>
      this.editProductDescriptionDraftNow(lease, request, operationId),
    );
  }

  async editProductDescriptionDraftNow(lease, request, operationId) {
    const available = await this.provider("/draft-owner-availability", {
      operationId,
    });
    if (!available.available) {
      const effectId = `effect_draft_${await sha256Hex(operationId)}`;
      this.ctx.storage.transactionSync(
        this.holdDraftRecovery.bind(this, {
          kind: "await_evidence",
          evidence: { kind: "effect_receipt", effectId },
        }),
      );
      throw new Error("Draft receipt owner unavailable");
    }
    const admission = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      organisationId,
    );
    if (admission === null) throw new Error("Draft execution admission denied");
    const context = this.toolContext(admission, lease);
    const value = await settleToolEffect(
      context,
      await editProductDescriptionDraftForEmbeddedHarness(
        context,
        request,
        operationId,
        { kind: "direct" },
      ),
    );
    await this.provider("/draft-committed", { operationId, value });
    return value;
  }

  holdDraftRecovery(action) {
    this.recoverNativeExecution();
    this.updateAction(action);
  }

  async fetch(request) {
    if (new URL(request.url).pathname !== "/reconcile-draft")
      return super.fetch(request);
    const current = this.lifecycle();
    if (
      current?.kind !== "recovering" ||
      current.state.action.kind !== "await_evidence" ||
      current.state.action.evidence.kind !== "effect_receipt"
    )
      throw new Error(
        "Draft reconciliation requires its receipt evidence wait",
      );
    // The Organisation actor's receipt of the saved edit, as the replayed
    // tool will read it.
    const receipts =
      await this.env.ORGANISATION.getByName(organisationId).draftEvidence();
    if (receipts.length === 0) return Response.json({ kind: "await_receipt" });
    const admission = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      organisationId,
    );
    if (admission === null || !(await admission.isActive()))
      return Response.json({ kind: "blocked", reason: "authorization" });
    if (
      this.lifecycle()?.state.contract.lastEventSequence !==
      current.state.contract.lastEventSequence
    )
      return Response.json({ kind: "changed" });
    this.updateAction({ kind: "resume_task" });
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return Response.json({
      kind: "resolved",
      draftDescription: receipts[0].draft_description,
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const organisation = env.ORGANISATION.getByName(organisationId);
    if (url.pathname === "/human-edit")
      return Response.json(await editAsPerson(env, humanUser));
    if (url.pathname === "/draft")
      return Response.json(await organisation.savedDraft());
    if (url.pathname === "/revoke-agent") {
      await env.DB.prepare(
        "UPDATE service_role_grant SET status = 'revoked', revoked_at = ? WHERE organisation_id = ? AND user_id = ?",
      )
        .bind(Date.now(), organisationId, userId)
        .run();
      return Response.json({ revoked: true });
    }
    if (url.pathname === "/freeze-placement") {
      await env.DB.prepare(
        "UPDATE organisation_placement SET status = 'frozen', frozen_at = ? WHERE organisation_id = ? AND status = 'active'",
      )
        .bind(Date.now(), organisationId)
        .run();
      return Response.json({ frozen: true });
    }
    return collaboration.fetch(request, env);
  },
};

// A person edits as the Portal editor does: over the draft socket, with a
// control session cookie, from the shared document state.
async function editAsPerson(env, personUserId) {
  const { token } = await issueControlSession({
    db: env.DB,
    userId: personUserId,
    now: Date.now(),
    ttlMs: 3_600_000,
  });
  const path = `/v1/control/organisations/${organisationId}/commerce/products/${productId}/description-draft/socket`;
  const response = await handleProductDescriptionDraftRoute(
    new Request(new URL(path, env.PANTRY_PUBLIC_ORIGIN), {
      headers: {
        Upgrade: "websocket",
        Origin: env.PANTRY_PUBLIC_ORIGIN,
        Cookie: `pantry_session=${encodeURIComponent(token)}`,
      },
    }),
    env,
    matchProductDescriptionDraftRoute(path),
  );
  if (response.status !== 101 || response.webSocket === null)
    throw new Error(
      `Draft socket refused: ${response.status} ${await response.text()}`,
    );
  const socket = response.webSocket;
  socket.accept();
  try {
    const document = required(ProductDescriptionDoc.create(""));
    const synced = nextMessage(socket, "sync_response");
    socket.send(
      encodeDraftClientMessage({
        kind: "sync_request",
        stateVector: required(document.stateVector()),
      }),
    );
    required(document.apply((await synced).missingUpdate));
    const update = required(document.edit(`${document.read()}${humanNote}`));
    const accepted = nextMessage(socket, "update_accepted");
    socket.send(
      encodeDraftClientMessage({
        kind: "submit_update",
        updateId: "human_after_agent",
        update,
      }),
    );
    await accepted;
    return { ok: true, value: { draft: { description: document.read() } } };
  } finally {
    socket.close(1000, "done");
  }
}

function nextMessage(socket, kind) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const parsed = parseDraftServerMessage(event.data);
      if (!parsed.ok) return;
      if (parsed.value.kind === "failure") {
        stop();
        reject(new Error(`Draft socket failure: ${parsed.value.code}`));
        return;
      }
      if (parsed.value.kind !== kind) return;
      stop();
      resolve(parsed.value);
    };
    const onClose = () => {
      stop();
      reject(new Error(`Draft socket closed before ${kind}`));
    };
    function stop() {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    }
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}
