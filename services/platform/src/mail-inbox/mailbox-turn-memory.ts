import type { MemoryApplicability } from "@purin-labs/control-api";
import {
  parseEntityRef,
  SUPPLIER_ENTITY_TYPE_ID,
} from "@purin-labs/commerce-client";

import type {
  TurnMemoryRead,
  TurnMemoryReader,
  TurnMemoryReadRequest,
} from "../context/assembly";
import { readVerifiedMessageSender } from "./verified-sender";
import type { Env } from "@purin-labs/kernel/env";
import type {
  CaseId,
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  memoryService,
  type TurnMemoryDestination,
} from "../memory/contract/memory-service";

/**
 * The Memory reader for one mailbox turn.
 *
 * The turn concerns the skills its pinned agent loaded and, when the admitted
 * message is bound to a current verified supplier contact, that supplier. The
 * subject lookup is part of the read: if it fails, the read is unavailable,
 * and it runs inside the read's deadline.
 */
export function createMailboxTurnMemoryReader(
  input: Readonly<{
    env: Env;
    execution: OrganisationExecutionScope;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    caseId: CaseId;
    /** The newest admitted message, whose sender the reply answers. */
    messageId: string;
    skillIds: readonly string[];
    destinationMayReceive: TurnMemoryDestination;
    now: number;
  }>,
): TurnMemoryReader {
  return { read: readMailboxTurnMemory.bind(null, input) };
}

async function readMailboxTurnMemory(
  input: Parameters<typeof createMailboxTurnMemoryReader>[0],
  request: TurnMemoryReadRequest,
): Promise<TurnMemoryRead> {
  const applicability: MemoryApplicability[] = input.skillIds.map(
    (skillId) => ({ kind: "skill", skillId }),
  );
  const supplier = await readMailboxSupplierScope(input);
  // The supplier could not be established either way, so nothing is known
  // about what Memory applies to this turn.
  if (supplier.kind === "unreadable") return { kind: "unavailable" };
  if (supplier.kind === "supplier") applicability.push(supplier.scope);
  return memoryService
    .use()
    .createTurnMemoryReader({
      env: input.env,
      execution: input.execution,
      organisationId: input.organisationId,
      subjects: { applicability },
      destinationMayReceive: input.destinationMayReceive,
      now: input.now,
    })
    .read(request);
}

type VerifiedSupplier =
  | Readonly<{
      kind: "supplier";
      scope: MemoryApplicability;
      /** The verification that establishes the sender, at its revision. */
      verification: Readonly<{ verificationId: string; revision: number }>;
    }>
  | Readonly<{
      kind: "none" | "unreadable";
      scope?: never;
      verification?: never;
    }>;

/**
 * The supplier an admitted message comes from, as a Memory subject. It is the
 * message's verified sender. A supplier whose record cannot be named as an
 * entity leaves the supplier unknown.
 */
export async function readMailboxSupplierScope(
  input: Pick<
    Parameters<typeof createMailboxTurnMemoryReader>[0],
    | "execution"
    | "organisationId"
    | "integrationAccountId"
    | "caseId"
    | "messageId"
  >,
): Promise<VerifiedSupplier> {
  const sender = await readVerifiedMessageSender({
    db: input.execution.database,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    caseId: input.caseId,
    messageId: input.messageId,
  });
  if (sender.kind !== "supplier") return { kind: sender.kind };
  let entity;
  try {
    entity = parseEntityRef({
      origin: "custom",
      typeId: SUPPLIER_ENTITY_TYPE_ID,
      entityId: sender.endpoint.target.supplierId,
    });
  } catch {
    return { kind: "unreadable" };
  }
  return {
    kind: "supplier",
    scope: {
      kind: "commerce_entity",
      merchantId: sender.endpoint.merchantId,
      entity,
    },
    verification: {
      verificationId: sender.endpoint.verificationId,
      revision: sender.endpoint.revision,
    },
  };
}
