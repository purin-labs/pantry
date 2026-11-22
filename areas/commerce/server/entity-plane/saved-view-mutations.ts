import type {
  CommerceCommandId,
  CommerceEntityAuthority,
  CommerceEntityPlaneCommand,
  CommerceEntityPlaneError,
  SavedCommerceView,
  SavedCommerceViewRevision,
  CommerceMutationReceiptV1,
} from "@purin-labs/commerce-contracts";
import {
  parseSavedCommerceViewRevision,
  type CommerceEntityPlaneClient,
} from "@purin-labs/commerce-client";

import type { Result } from "@purin-labs/kernel/result";
import { enumeratePublishedResources } from "./published-resources";
import { type PublishedResourceBoundaryError } from "../contract/types";
import type { SavedCommerceViewPresentationPatch } from "./routes";
import type { Variant } from "@purin-labs/type-utils";

type SavedViewMutationClient = Pick<
  CommerceEntityPlaneClient,
  "command" | "publishedResourceMetadata"
>;

export type SavedCommerceViewPresentationPatchError =
  | PublishedResourceBoundaryError
  | Readonly<{
      code: "revision_conflict";
      expected: SavedCommerceViewRevision;
      actual: SavedCommerceViewRevision;
    }>
  | Readonly<{ code: "command_rejected"; error: CommerceEntityPlaneError }>
  | Readonly<{ code: "receipt_mismatch" }>;

export async function publishSavedCommerceViewPresentation(
  input: Readonly<{
    client: SavedViewMutationClient;
    organisationId: string;
    merchantId: string;
    commandId: CommerceCommandId;
    authority: Variant<CommerceEntityAuthority, "saved_view_administration">;
    patch: SavedCommerceViewPresentationPatch;
  }>,
): Promise<
  Result<CommerceMutationReceiptV1, SavedCommerceViewPresentationPatchError>
> {
  const published = await enumeratePublishedResources(input);
  if (!published.ok) return published;
  const current = findSavedCommerceView(
    published.value.views,
    input.patch.viewId,
  );
  if (current === undefined)
    return { ok: false, error: { code: "not_published" } };
  if (current.revision !== input.patch.expectedRevision) {
    return {
      ok: false,
      error: {
        code: "revision_conflict",
        expected: current.revision,
        actual: input.patch.expectedRevision,
      },
    };
  }
  const nextRevision = parseSavedCommerceViewRevision(
    Number(current.revision) + 1,
  );
  const command = buildSavedCommerceViewPresentationCommand(
    current,
    input.patch,
    nextRevision,
  );
  let result: Awaited<ReturnType<CommerceEntityPlaneClient["command"]>>;
  try {
    result = await input.client.command({
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      commandId: input.commandId,
      expectedMerchantRevision: published.value.merchantRevision,
      authority: input.authority,
      command,
    });
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
  return receiptMatchesSavedViewPublication(
    input.commandId,
    input.patch,
    nextRevision,
    result.value.receipt,
  )
    ? { ok: true, value: result.value.receipt }
    : { ok: false, error: { code: "receipt_mismatch" } };
}

function findSavedCommerceView(
  views: readonly SavedCommerceView[],
  viewId: SavedCommerceViewPresentationPatch["viewId"],
): SavedCommerceView | undefined {
  for (const view of views) {
    if (view.viewId === viewId) return view;
  }
  return undefined;
}

function buildSavedCommerceViewPresentationCommand(
  current: SavedCommerceView,
  patch: SavedCommerceViewPresentationPatch,
  revision: SavedCommerceViewRevision,
): Variant<CommerceEntityPlaneCommand, "publish_saved_commerce_view"> {
  return {
    kind: "publish_saved_commerce_view",
    command: {
      view: {
        viewId: current.viewId,
        name: current.name,
        source: current.source,
        filter: current.filter,
        sorts: current.sorts,
        visibleAttributeIds: current.visibleAttributeIds,
        relationshipColumns: current.relationshipColumns,
        grouping: current.grouping,
        presentation: patch.presentation,
        revision,
      },
    },
  };
}

function receiptMatchesSavedViewPublication(
  commandId: CommerceCommandId,
  patch: SavedCommerceViewPresentationPatch,
  revision: SavedCommerceViewRevision,
  receipt: CommerceMutationReceiptV1,
): boolean {
  return (
    receipt.commandId === commandId &&
    receipt.target.kind === "saved_commerce_view" &&
    receipt.target.viewId === patch.viewId &&
    receipt.target.revision === revision
  );
}
