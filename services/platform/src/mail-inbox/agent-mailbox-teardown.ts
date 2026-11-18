import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Env } from "../env";
import { readEmailMailboxAccount } from "../data/email-mailbox";
import { resolveEmailSenderAccount } from "../data/email-operational";
import type { IntegrationAccountId } from "../ids";
import { agentMailboxConnector } from "./agent-mailbox-connector";

type AgentMailboxTeardown =
  | { readonly kind: "not_a_mailbox" }
  | { readonly kind: "connector_unavailable" }
  | {
      readonly kind: "torn_down";
      readonly watchStopped: boolean;
      readonly cleanupNeeded: readonly {
        readonly proposalId: string;
        readonly version: number;
        readonly state: string;
      }[];
    };

/**
 * Stands a Gmail mailbox down before its connection is removed.
 *
 * Removal revokes the organisation's Google grant, and a revoked grant cannot delete
 * anything: every Pantry-created draft still sitting in the mailbox would be
 * stranded there with no way to clean it up, and the Gmail watch would keep
 * publishing until it expired. So the teardown has to run while the credential
 * still works, and it reports the drafts it could not remove rather than
 * letting them disappear from view.
 */
export async function tearDownAgentMailboxForRemoval(
  env: Env,
  scope: OrganisationExecutionScope,
  integrationAccountId: IntegrationAccountId,
  kind: "stand_down" | "erase",
): Promise<AgentMailboxTeardown> {
  const organisationId = scope.organisationId;
  const sender = await resolveEmailSenderAccount({
    db: scope.database,
    organisationId,
    integrationAccountId,
  });
  const mailbox = await readEmailMailboxAccount({
    db: scope.database,
    organisationId,
    integrationAccountId,
  });
  if (!sender.ok && !mailbox.ok) return { kind: "not_a_mailbox" };
  const connector = await agentMailboxConnector(
    env,
    organisationId,
    integrationAccountId,
  );
  if (!connector.ok) return { kind: "connector_unavailable" };
  const operational =
    await connector.value.stub.revokeEmailOperationalProposals({
      identity: connector.value.identity,
      integrationAccountId,
      now: Date.now(),
    });
  if (!operational.ok) return { kind: "connector_unavailable" };
  if (!mailbox.ok) {
    return { kind: "torn_down", watchStopped: false, cleanupNeeded: [] };
  }
  const revoked = await connector.value.stub.revokeEmailMailbox({
    identity: connector.value.identity,
    kind,
    integrationAccountId,
    now: Date.now(),
  });
  if (!revoked.ok) return { kind: "connector_unavailable" };
  return {
    kind: "torn_down",
    watchStopped: revoked.value.watchStopped,
    cleanupNeeded: revoked.value.disposals
      .filter((disposal) => disposal.kind !== "deleted")
      .map((disposal) => ({
        proposalId: disposal.proposalId,
        version: disposal.version,
        state: disposal.kind,
      })),
  };
}
