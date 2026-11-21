import { CandidateActor as CodeModeActor } from "./codemode-worker.mjs";
export {
  default,
  ProposalOrganisation,
  ProposalCase,
  CodeModePlatformGovernorActor,
} from "./codemode-worker.mjs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTask, defineExtension } from "@earendil-works/pi-durable";
import { organisationId } from "./proposal-worker.mjs";

export class CandidateActor extends CodeModeActor {
  effectExtension() {
    const task = defineTask({
      name: "pantry.trial.provider-receipt",
      version: 1,
      initial: initialWait,
      phases: { waiting: waitForReceipt.bind(null, this, false) },
      abort: waitForReceipt.bind(null, this, true),
    });
    return {
      task,
      extension: defineExtension({
        name: "pantry.trial.provider-receipt",
        tasks: [task],
      }),
    };
  }

  async registry() {
    const registry = await super.registry();
    registry.install(this.effectExtension().extension);
    return registry;
  }

  cancellationRegistry() {
    const registry = super.cancellationRegistry();
    registry.install(this.effectExtension().extension);
    return registry;
  }

  async fetch(request) {
    if (new URL(request.url).pathname !== "/defer-effect")
      return super.fetch(request);
    await this.preflight(this.currentLease());
    const action = await this.pendingAction();
    if (action.state !== "indeterminate")
      throw new Error("Expected an unresolved governed effect");
    const { harness } = await this.getRuntime();
    const taskId = await harness.commit(
      createReceiptWait.bind(
        null,
        this.effectExtension().task,
        action.action.nonce.value,
      ),
      BACKGROUND_CONTEXT,
    );
    return Response.json({ taskId, nonce: action.action.nonce.value });
  }
}

function initialWait() {
  return { phase: "waiting" };
}

async function createReceiptWait(definition, nonce, tx) {
  return tx.createTask(
    definition,
    { nonce },
    {
      conversationId: 1,
      ownership: { kind: "conversation" },
      background: true,
    },
  );
}

async function waitForReceipt(actor, cancelled, task, runtime, context) {
  while (true) {
    const result = await actor.env.ORGANISATION.getByName(
      organisationId,
    ).getAction({
      organisationId,
      nonce: task.input.nonce,
      now: Date.now(),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const action = result.value;
    if (action.state === "confirmed" || action.state === "failed") {
      await runtime.commit(
        finishReceiptWait.bind(null, cancelled, {
          nonce: task.input.nonce,
          state: action.state,
          providerResult: action.providerResult,
        }),
        context,
      );
      return;
    }
    await new Promise((resolve) => runtime.setTimer(resolve, 500));
  }
}

function finishReceiptWait(cancelled, result) {
  return {
    status: "terminal",
    outcome: { status: cancelled ? "aborted" : "completed", result },
  };
}
