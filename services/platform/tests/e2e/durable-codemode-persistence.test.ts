import { http, type HttpResponseResolver } from "msw";
import { expect, it } from "vitest";
import { isRecord } from "@purin-labs/std";
import type { AuthorizedHarnessToolResult } from "@purin-labs/contracts";
import type { HarnessCodeModeAdmittedExecution, HarnessCodeModeExecutionLease } from "../../src/agent-tools/catalog/types";
import { network } from "./network";
import {
  RecordingBoundary,
  freshForkInput,
  restoredInput,
  runSdkTurn,
  sdkInput,
} from "./pi-sdk-support";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";

// Plan 50A, Phase D. This journey runs the Pi harness and the sandbox Worker
// against the storage of a Session Actor. The model responses are controlled. The Tool Host and the
// budget owners are fixtures here: the Actor journeys of Phase D are in
// durable-codemode-persistence-actor.test.ts.

const INVENTORY_TOOL = {
  type: "function",
  name: "inventory_read",
  description: "Read the accepted bakery inventory revision.",
  strict: true,
  parameters: { type: "object", properties: {}, additionalProperties: false },
} as const;

const STORE_SCRIPT =
  "const read = JSON.parse(await tools.inventory_read({})); store('batch', { count: read.items.length, revision: read.revision }); text('stored');";
it("gives a thread fork a fresh store and its own script, while a script of its parent is running", async ({
  task,
}) => {
  const parent = new HeldBoundary();
  const parentInput = sdkInput(parent, [INVENTORY_TOOL], "native");
  const fork = new HeldBoundary();
  const requests: Record<string, unknown>[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToFork.bind(null, requests),
    ),
  );
  const first = await runSdkTurn(parentInput, "PARENT_FIRST store the batch.");
  expect(first.finalMessage).toBe("PARENT_STORED");
  // A fork starts from a completed turn of its parent.
  const inherited = [...parent.entries];

  // The next script of the parent waits on a read.
  parent.hold();
  const second = runSdkTurn(
    restoredInput(parentInput, first, parent, "second"),
    "PARENT_SECOND read once more.",
  );
  await parent.reading.promise;
  expect(parent.begun).toHaveLength(2);
  expect(parent.settlements).toEqual(["succeeded"]);

  // The fork runs its own script to its end. It finds no value of the
  // parent, and it reads under its own execution.
  const forked = await runSdkTurn(
    freshForkInput(sdkInput(fork, [INVENTORY_TOOL], "native"), inherited),
    "FORK_TURN report what the store holds.",
  );
  expect(forked.finalMessage).toBe("FORK_REPORTED");
  const forkResult = lastToolText(requests.findLast(isForkRequest));
  expect(forkResult).toContain('{"batch":true,"later":true,"items":2}');
  expect(fork.begun).toHaveLength(1);
  expect(fork.settlements).toEqual(["succeeded"]);
  expect(fork.capabilityCalls).toBe(1);
  expect(parent.begun).not.toContain(fork.begun[0]);
  // The script of the parent is as it was: one read in flight, not settled.
  expect(parent.settlements).toEqual(["succeeded"]);
  expect(parent.capabilityCalls).toBe(1);

  parent.release();
  expect((await second).finalMessage).toBe("PARENT_FINISHED");
  expect(parent.settlements).toEqual(["succeeded", "succeeded"]);
  expect(parent.capabilityCalls).toBe(2);
  // The fork inherited the accepted history, and none of the stored values.
  expect(JSON.stringify(requests.find(isForkRequest))).toContain(
    "PARENT_FIRST",
  );

  Object.assign(task.meta, {
    evidence: {
      parentExecutions: parent.begun,
      forkExecutions: fork.begun,
      forkResult,
      parentSettlements: parent.settlements,
      forkSettlements: fork.settlements,
      inheritedEntries: inherited.length,
    },
  });
}, 60_000);

/** A boundary that records each admitted execution and can hold its reads. */
class HeldBoundary extends RecordingBoundary {
  readonly begun: string[] = [];
  readonly reading = Promise.withResolvers<void>();
  private held: PromiseWithResolvers<void> | null = null;

  hold(): void {
    this.held = Promise.withResolvers<void>();
  }

  release(): void {
    this.held?.resolve();
    this.held = null;
  }

  override async begin(
    source: string,
    callId: string,
  ): Promise<HarnessCodeModeAdmittedExecution> {
    const admitted = await super.begin(source, callId);
    this.begun.push(admitted.executionId);
    return admitted;
  }

  override async claim(
    lease: HarnessCodeModeExecutionLease,
    callId: string,
  ): Promise<void> {
    await super.claim(lease, callId);
    // Each call names the execution that this boundary admitted.
    expect(this.begun).toContain(lease.executionId);
  }

  override async executeTool(
    name: string,
    input: string,
  ): Promise<AuthorizedHarnessToolResult> {
    if (this.held !== null) {
      this.reading.resolve();
      await this.held.promise;
    }
    return super.executeTool(name, input);
  }
}

async function respondToFork(
  requests: Record<string, unknown>[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  requests.push(body);
  const scripted = lastRole(body) === "tool";
  if (isForkRequest(body))
    return scripted
      ? openRouterText("FORK_REPORTED", "fork_reported")
      : openRouterToolCall(
          "codemode",
          {
            code: "const read = JSON.parse(await tools.inventory_read({})); text({ batch: load('batch') === undefined, later: load('later') === undefined, items: read.items.length });",
          },
          "fork_script",
        );
  if (JSON.stringify(body).includes("PARENT_SECOND"))
    return scripted
      ? openRouterText("PARENT_FINISHED", "parent_finished")
      : openRouterToolCall(
          "codemode",
          {
            code: "await tools.inventory_read({}); store('later', 1); text('later');",
          },
          "parent_second_script",
        );
  return scripted
    ? openRouterText("PARENT_STORED", "parent_stored")
    : openRouterToolCall("codemode", { code: STORE_SCRIPT }, "parent_script");
}

function isForkRequest(body: Record<string, unknown>): boolean {
  return JSON.stringify(body).includes("FORK_TURN");
}

function lastRole(body: Record<string, unknown>): unknown {
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : null;
  return isRecord(last) ? last.role : null;
}

function lastToolText(body: Record<string, unknown> | undefined): string {
  if (body === undefined || !Array.isArray(body.messages))
    throw new Error("Missing model messages");
  for (const message of [...body.messages].reverse()) {
    if (!isRecord(message) || message.role !== "tool") continue;
    if (typeof message.content === "string") return message.content;
  }
  throw new Error("Missing tool result");
}
