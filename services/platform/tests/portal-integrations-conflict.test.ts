import { describe, expect, it } from "vitest";

import { ControlApiError } from "../../../apps/portal/src/control-client";
// @ts-expect-error Platform test TypeScript excludes portal JSX; the portal build validates it.
import { executeIntegrationsCommand } from "../../../apps/portal/src/features/integrations/settings-routes";

describe("integrations command configuration conflicts", conflictSuite);

function conflictSuite(): void {
  it("re-reads and retries once when the cached version is stale", retryTest);
  it("gives up when the retry conflicts again", secondConflictTest);
  it("does not re-read for unrelated failures", unrelatedErrorTest);
}

type Attempt = { readonly configurationVersion: number };

function harness(outcomes: readonly ("conflict" | "ok")[]): {
  readonly attempts: Attempt[];
  readonly reads: number[];
  readonly context: Parameters<typeof executeIntegrationsCommand>[0];
} {
  const attempts: Attempt[] = [];
  const reads: number[] = [];
  let index = 0;
  const context = {
    props: {
      organisationId: "organisation_1",
      organisationHandle: "org",
      workspaceHandle: "main",
      transport: {
        readOverview: async () => {
          reads.push(1);
          // The refreshed page reports the version the server actually holds.
          return { configurationVersion: 42 };
        },
        execute: async (
          _organisationId: string,
          _organisation: string,
          _workspace: string,
          configurationVersion: number,
        ) => {
          attempts.push({ configurationVersion });
          const outcome = outcomes[index] ?? "ok";
          index += 1;
          if (outcome === "conflict") {
            throw new ControlApiError("stale", "configuration_conflict");
          }
          return { kind: "completed" as const };
        },
      },
    },
  };
  return {
    attempts,
    reads,
    context: context as unknown as Parameters<
      typeof executeIntegrationsCommand
    >[0],
  };
}

const COMMAND = { kind: "connect_gmail" } as Parameters<
  typeof executeIntegrationsCommand
>[2];

/**
 * A background change to any connection bumps the organisation's configuration
 * version, which strands every page already open. The operator did nothing
 * wrong, so the command re-reads and retries rather than making them reload.
 */
async function retryTest(): Promise<void> {
  const { attempts, reads, context } = harness(["conflict", "ok"]);
  await expect(
    executeIntegrationsCommand(context, 7, COMMAND),
  ).resolves.toBeUndefined();
  expect(reads).toHaveLength(1);
  expect(attempts.map((attempt) => attempt.configurationVersion)).toEqual([
    7, 42,
  ]);
}

async function secondConflictTest(): Promise<void> {
  // Two conflicts in a row is a real race, not a stale page, so it surfaces.
  const { attempts, reads, context } = harness(["conflict", "conflict"]);
  await expect(executeIntegrationsCommand(context, 7, COMMAND)).rejects.toThrow(
    ControlApiError,
  );
  expect(reads).toHaveLength(1);
  expect(attempts).toHaveLength(2);
}

async function unrelatedErrorTest(): Promise<void> {
  const attempts: number[] = [];
  const reads: number[] = [];
  const context = {
    props: {
      organisationId: "organisation_1",
      organisationHandle: "org",
      workspaceHandle: "main",
      transport: {
        readOverview: async () => {
          reads.push(1);
          return { configurationVersion: 42 };
        },
        execute: async () => {
          attempts.push(1);
          throw new ControlApiError("nope", "agent_mailbox_unassigned");
        },
      },
    },
  } as unknown as Parameters<typeof executeIntegrationsCommand>[0];
  await expect(executeIntegrationsCommand(context, 7, COMMAND)).rejects.toThrow(
    "nope",
  );
  expect(attempts).toHaveLength(1);
  expect(reads).toHaveLength(0);
}
