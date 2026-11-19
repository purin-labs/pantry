// The start that every merchant command shares, in the core and in the
// plugins: parse the raw command, check the merchant, answer a replay of the
// idempotency key, and refuse a missing merchant, a stale merchant revision
// or a missing snapshot. The checks run in this order, and the order decides
// which refusal a request gets.
import type {
  CommerceMerchantSnapshotV1,
  CommerceMutationErrorV1,
  CommerceMutationResultV1,
} from "@purin-labs/commerce-client";

import type { MerchantRow } from "./ledger.ts";

/** What every command authority takes from the ledger. */
export type MerchantCommandPorts<TCommand> = Readonly<{
  readMerchant: (merchantId: string) => MerchantRow | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: TCommand,
  ) => CommerceMutationResultV1 | undefined;
  validateMerchant: (
    merchantId: string,
    merchant: MerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
}>;

type SnapshotReader = Readonly<{
  readSnapshot: (merchantId: string) => CommerceMerchantSnapshotV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
}>;

type KeyedCommand = Readonly<{ merchantId: string; idempotencyKey: string }>;

/** A command planned against one merchant revision. */
type RevisionedCommand = Readonly<{ expectedMerchantRevision: number }>;

type MerchantCommandChecks<TCommand> = Readonly<{
  /** Refuses the command when the merchant is not at its expected revision. */
  merchantRevision?: [TCommand] extends [RevisionedCommand] ? boolean : never;
}>;

type SnapshotState = Readonly<{ snapshot: CommerceMerchantSnapshotV1 }>;

/**
 * Where the start of a command ended: refused, replayed with the result that
 * its idempotency key stored, or ready to plan.
 */
type MerchantCommandStart<TCommand, TReady = unknown> =
  | Readonly<{ kind: "refused"; result: CommerceMutationResultV1 }>
  | Readonly<{
      kind: "replayed";
      command: TCommand;
      result: CommerceMutationResultV1;
    }>
  | (Readonly<{ kind: "ready"; command: TCommand; merchant: MerchantRow }> &
      TReady);

/** Parses a raw command and admits it (`admitMerchantCommand`). */
export function beginMerchantCommand<TCommand extends KeyedCommand>(
  ports: MerchantCommandPorts<NoInfer<TCommand>>,
  rawCommand: unknown,
  parse: (value: unknown) => TCommand,
  checks: MerchantCommandChecks<TCommand> = {},
): MerchantCommandStart<TCommand> {
  let command: TCommand;
  try {
    command = parse(rawCommand);
  } catch (error) {
    return refused(ports.rejected(ports.invalidCommand(error)));
  }
  return admitMerchantCommand(ports, command, checks);
}

/** Begins a command, and then reads the merchant's snapshot. */
export function beginSnapshotCommand<TCommand extends KeyedCommand>(
  ports: MerchantCommandPorts<NoInfer<TCommand>> & SnapshotReader,
  rawCommand: unknown,
  parse: (value: unknown) => TCommand,
  checks: MerchantCommandChecks<TCommand> = {},
): MerchantCommandStart<TCommand, SnapshotState> {
  return withSnapshot(
    ports,
    beginMerchantCommand(ports, rawCommand, parse, checks),
  );
}

/**
 * Checks a parsed command against its merchant. The merchant's own check
 * comes first, then a replay of the idempotency key, then a missing merchant
 * and, when asked, a stale merchant revision.
 */
export function admitMerchantCommand<TCommand extends KeyedCommand>(
  ports: MerchantCommandPorts<NoInfer<TCommand>>,
  command: TCommand,
  checks: MerchantCommandChecks<TCommand> = {},
): MerchantCommandStart<TCommand> {
  const merchant = ports.readMerchant(command.merchantId);
  const merchantError = ports.validateMerchant(command.merchantId, merchant);
  if (merchantError !== undefined) {
    return refused(ports.rejected(merchantError));
  }
  const replay = ports.readReplay(
    command.merchantId,
    command.idempotencyKey,
    command,
  );
  if (replay !== undefined) {
    return { kind: "replayed", command, result: replay };
  }
  if (merchant === undefined) {
    return refused(ports.rejected(merchantNotFound(command.merchantId)));
  }
  const stale =
    checks.merchantRevision === true && revisioned(command)
      ? staleMerchantRevision(merchant, command)
      : undefined;
  if (stale !== undefined) {
    return refused(ports.rejected(stale));
  }
  return { kind: "ready", command, merchant };
}

/** Admits a parsed command, and then reads the merchant's snapshot. */
export function admitSnapshotCommand<TCommand extends KeyedCommand>(
  ports: MerchantCommandPorts<NoInfer<TCommand>> & SnapshotReader,
  command: TCommand,
  checks: MerchantCommandChecks<TCommand> = {},
): MerchantCommandStart<TCommand, SnapshotState> {
  return withSnapshot(ports, admitMerchantCommand(ports, command, checks));
}

/**
 * Begins a command, plans it, and commits the plan with the command and its
 * merchant; a plan that is a refusal is refused.
 */
export function commitPlannedCommand<
  TCommand extends KeyedCommand,
  TPlanned extends object,
>(
  ports: MerchantCommandPorts<NoInfer<TCommand>> &
    Readonly<{
      commit: (
        request: Readonly<{ command: TCommand; merchant: MerchantRow }> &
          TPlanned,
      ) => CommerceMutationResultV1;
    }>,
  rawCommand: unknown,
  parse: (value: unknown) => TCommand,
  plan: (command: TCommand) => TPlanned | CommerceMutationErrorV1,
): CommerceMutationResultV1 {
  const start = beginMerchantCommand(ports, rawCommand, parse);
  if (start.kind !== "ready") {
    return start.result;
  }
  const planned = plan(start.command);
  if (isRefusal(planned)) {
    return ports.rejected(planned);
  }
  return ports.commit({
    command: start.command,
    merchant: start.merchant,
    ...planned,
  });
}

/** The refusal of a command planned against another merchant revision. */
export function staleMerchantRevision(
  merchant: MerchantRow,
  command: RevisionedCommand,
): CommerceMutationErrorV1 | undefined {
  return merchant.revision === command.expectedMerchantRevision
    ? undefined
    : {
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      };
}

export function merchantNotFound(merchantId: string): CommerceMutationErrorV1 {
  return { code: "merchant_not_found", merchantId };
}

function withSnapshot<TCommand extends KeyedCommand>(
  ports: SnapshotReader,
  start: MerchantCommandStart<TCommand>,
): MerchantCommandStart<TCommand, SnapshotState> {
  if (start.kind !== "ready") {
    return start;
  }
  const snapshot = ports.readSnapshot(start.command.merchantId);
  return snapshot === undefined
    ? refused(ports.rejected(merchantNotFound(start.command.merchantId)))
    : { ...start, snapshot };
}

function refused(
  result: CommerceMutationResultV1,
): Readonly<{ kind: "refused"; result: CommerceMutationResultV1 }> {
  return { kind: "refused", result };
}

function isRefusal(value: object): value is CommerceMutationErrorV1 {
  return "code" in value;
}

// `merchantRevision` is only true for a command type with the field.
function revisioned(
  command: KeyedCommand,
): command is KeyedCommand & RevisionedCommand {
  return "expectedMerchantRevision" in command;
}
