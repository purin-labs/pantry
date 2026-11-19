import type {
  CommerceCommandId,
  CommerceEntityAuthority,
  CommerceEntityPlaneError,
  CommerceMutationReceiptV1,
} from "@purin-labs/contracts";
import type { CommerceEntityPlaneClient } from "@purin-labs/commerce-client";

import type { Result } from "../../result";
import {
  resolvePublishedResponsibilityScope,
  type PublishedResourceBoundaryError,
} from "./published-resources";
import type { CommerceListEntryPatchCommand } from "./routes";
import type { Variant } from "@purin-labs/type-utils";

type ListEntryMutationClient = Pick<
  CommerceEntityPlaneClient,
  "command" | "publishedResourceMetadata"
>;

export type CommerceListEntryPatchError =
  | PublishedResourceBoundaryError
  | Readonly<{ code: "command_rejected"; error: CommerceEntityPlaneError }>
  | Readonly<{ code: "receipt_mismatch" }>
  | Readonly<{ code: "unavailable" }>;

export async function patchPublishedCommerceListEntry(
  input: Readonly<{
    client: ListEntryMutationClient;
    organisationId: string;
    merchantId: string;
    commandId: CommerceCommandId;
    authority: Variant<CommerceEntityAuthority, "commerce_list_entry_command">;
    command: CommerceListEntryPatchCommand;
  }>,
): Promise<Result<CommerceMutationReceiptV1, CommerceListEntryPatchError>> {
  const target = input.command.command.target;
  const published = await resolvePublishedResponsibilityScope({
    client: input.client,
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    scope: { kind: "commerce_list_entry", entry: target.entry },
  });
  if (!published.ok) return published;

  const request: Parameters<CommerceEntityPlaneClient["command"]>[0] = {
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    commandId: input.commandId,
    expectedMerchantRevision: published.value.merchantRevision,
    authority: input.authority,
    command: input.command,
  };

  let result: Awaited<ReturnType<CommerceEntityPlaneClient["command"]>>;
  try {
    result = await input.client.command(request);
  } catch {
    return { ok: false, error: { code: "unavailable" } };
  }
  if (!result.ok) return { ok: false, error: { code: "unavailable" } };
  if (result.value.status === "rejected") {
    return {
      ok: false,
      error: { code: "command_rejected", error: result.value.error },
    };
  }
  return receiptMatchesPatch(input, result.value.receipt)
    ? { ok: true, value: result.value.receipt }
    : { ok: false, error: { code: "receipt_mismatch" } };
}

function receiptMatchesPatch(
  input: Readonly<{
    commandId: CommerceCommandId;
    command: CommerceListEntryPatchCommand;
  }>,
  receipt: CommerceMutationReceiptV1,
): boolean {
  const target = input.command.command.target.entry;
  return (
    receipt.commandId === input.commandId &&
    receipt.target.kind === "commerce_list_entry" &&
    receipt.target.entry.entryId === target.entryId &&
    receipt.target.entry.listId === target.listId &&
    Number(receipt.target.entry.revision) === Number(target.revision) + 1 &&
    receipt.target.revision === receipt.target.entry.revision
  );
}
