import { Select } from "@purin-labs/ui/select";
import { commerceOptionItem } from "./select-items";
import React from "react";
import { toast } from "sonner";
import type {
  AttributeDefinitionId,
  CommerceListEntry,
} from "@purin-labs/commerce-contracts";
import { REPLENISHMENT_QUEUE_LIST_ID } from "@purin-labs/commerce-client";
import { ControlApiError } from "@purin-labs/control/portal/control-client";
import {
  PermissionRequiredPrompt,
  permissionRequiredOf,
} from "@purin-labs/area-organisation-contract/ui/features/access/permission-required-prompt";
import { Notice, StatusChip } from "@purin-labs/ui/page-components";
import type {
  CommerceCollectionRow,
  CommercePublishedCollectionModel,
} from "./models";
import {
  patchCommerceListEntryStatus,
  updateCommerceBoardPresence,
  type CommercePresenceTransport,
} from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";
import {
  PurchaseRequestDrawer,
  purchaseRequestRowSummary,
} from "./purchasing-controls";
import {
  CommerceBoardEntryDrawer,
  CommerceBoardList,
  type CommerceBoardListFact,
  type CommerceBoardListRow,
} from "./board-list";
import {
  boardRowSummary,
  commerceBoardFact,
  commerceBoardFactText,
  commerceBoardLaneChip,
  commerceBoardLaneOptions,
  commerceBoardListLane,
  findListEntryDefinition,
  renderCommerceBoardLaneOption,
  type CommerceBoardLaneOption,
} from "./board-rows";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import type {
  CommerceBoardDragPreview,
  CommerceBoardPresenceEntry,
  CommerceBoardPresenceSelection,
} from "@purin-labs/commerce-control-api";
import type {
  CommerceBoardInteraction,
  CommerceBoardMoveIntent,
  CommerceEntityPlaneRouteProps,
} from "./entity-plane-types";
import { entityResourceLink } from "./entity-dossier";
import {
  incrementCommerceRefreshRevision,
  unchangedCommerceWatchCleanup,
} from "./entity-plane-shared";

export function renderCommerceCollectionBoard(
  model: CommercePublishedCollectionModel,
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  interaction: CommerceBoardInteraction,
): React.ReactNode {
  const board = model.board;
  if (board === null)
    return (
      <p className="empty-state commerce-empty">
        This published view has no board configuration.
      </p>
    );
  const laneOptions = commerceBoardLaneOptions(model);
  if (laneOptions.length === 0)
    return (
      <p className="empty-state commerce-empty">
        This board lane is not a published status field.
      </p>
    );
  const cardAttributeIds = board.configuration.cardAttributeIds;
  return (
    <>
      <CommerceBoardPresence model={model} interaction={interaction} />
      <CommerceBoardList
        label={model.view?.name ?? "Commerce board"}
        lanes={laneOptions.map(commerceBoardListLane)}
        rows={laneOptions.flatMap(
          commerceBoardListRows.bind(
            null,
            model,
            resourceHref,
            interaction,
            laneOptions,
            cardAttributeIds,
          ),
        )}
      />
    </>
  );
}

function commerceBoardListRows(
  model: CommercePublishedCollectionModel,
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  interaction: CommerceBoardInteraction,
  laneOptions: readonly CommerceBoardLaneOption[],
  cardAttributeIds: readonly AttributeDefinitionId[],
  lane: CommerceBoardLaneOption,
): readonly CommerceBoardListRow[] {
  return lane.rows.map(
    commerceBoardListRow.bind(
      null,
      model,
      resourceHref,
      interaction,
      laneOptions,
      cardAttributeIds,
      lane,
    ),
  );
}

/**
 * One entry of a board view as a list row. A purchase request shows its
 * supplier, amount, due day and owner; another board shows its first card
 * fact under the name and the next three as columns.
 */
function commerceBoardListRow(
  model: CommercePublishedCollectionModel,
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  interaction: CommerceBoardInteraction,
  laneOptions: readonly CommerceBoardLaneOption[],
  cardAttributeIds: readonly AttributeDefinitionId[],
  lane: CommerceBoardLaneOption,
  row: CommerceCollectionRow,
): CommerceBoardListRow {
  const text = commerceBoardFactText.bind(null, model, interaction.names, row);
  const purchasing = model.list?.listId === REPLENISHMENT_QUEUE_LIST_ID;
  const summary = purchasing
    ? purchaseRequestRowSummary(row.entry, text)
    : boardRowSummary(cardAttributeIds, text);
  return {
    key: `${String(row.entry.listId)}:${String(row.entry.entryId)}`,
    laneId: lane.id,
    name: row.entity.displayName,
    secondary: summary.secondary,
    columns: summary.columns,
    laneTag: <StatusChip status={commerceBoardLaneChip(model, row, lane)} />,
    drawer: renderCommerceBoardEntryDrawer.bind(
      null,
      model,
      resourceHref,
      interaction,
      laneOptions,
      cardAttributeIds.map(
        commerceBoardFact.bind(null, model, interaction.names, row),
      ),
      purchasing,
      lane.id,
      row,
    ),
  };
}

function renderCommerceBoardEntryDrawer(
  model: CommercePublishedCollectionModel,
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  interaction: CommerceBoardInteraction,
  laneOptions: readonly CommerceBoardLaneOption[],
  facts: readonly CommerceBoardListFact[],
  purchasing: boolean,
  laneId: string,
  row: CommerceCollectionRow,
  open: boolean,
  close: () => void,
): React.ReactNode {
  const href = entityResourceLink(resourceHref, row.entity);
  const laneControl =
    interaction.canOperate && interaction.mutate !== undefined ? (
      <Select.Root
        items={laneOptions.map(commerceOptionItem)}
        value={laneId}
        disabled={commerceBoardIntentBlocksMutation(interaction.intent)}
        onValueChange={moveCommerceBoardEntryFromDrawer.bind(
          null,
          close,
          model,
          interaction,
          row.entry,
          row.entity.displayName,
        )}
      >
        <Select.Trigger aria-label={`Move ${row.entity.displayName} to lane`}>
          <Select.Value />
        </Select.Trigger>
        <Select.Popup>{laneOptions.map(renderCommerceBoardLaneOption)}</Select.Popup>
      </Select.Root>
    ) : null;
  return purchasing ? (
    <PurchaseRequestDrawer
      open={open}
      close={close}
      model={model}
      row={row}
      href={href}
      facts={facts}
      laneControl={laneControl}
      organisationId={interaction.organisationId}
      canOperate={interaction.canOperate}
      mutate={interaction.mutate}
      refresh={interaction.refresh}
    />
  ) : (
    <CommerceBoardEntryDrawer
      open={open}
      close={close}
      title={row.entity.displayName}
      href={href}
      facts={facts}
      laneControl={laneControl}
    />
  );
}

/** A lane change closes the drawer, so its outcome shows above the list. */
function moveCommerceBoardEntryFromDrawer(
  close: () => void,
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  entry: CommerceListEntry,
  label: string,
  value: string | null,
): void {
  if (value === null) return;
  close();
  selectCommerceBoardLane(model, interaction, entry, label, value);
}

function CommerceBoardPresence(
  props: Readonly<{
    model: CommercePublishedCollectionModel;
    interaction: CommerceBoardInteraction;
  }>,
): React.ReactNode {
  const [entries, setEntries] = React.useState<
    readonly CommerceBoardPresenceEntry[]
  >([]);
  React.useEffect(
    commerceBoardPresenceEffect.bind(
      null,
      props.model,
      props.interaction,
      setEntries,
    ),
    [
      props.model.list?.listId,
      props.model.view?.viewId,
      props.interaction.organisationId,
      props.interaction.presence,
      props.interaction.intent,
    ],
  );
  if (props.interaction.presence === undefined || entries.length === 0)
    return null;
  return (
    <aside className="commerce-board-presence" aria-label="Connected operators">
      <span>Connected</span>
      <ul>{entries.map(renderCommerceBoardPresenceEntry)}</ul>
    </aside>
  );
}

function commerceBoardPresenceEffect(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  setEntries: React.Dispatch<
    React.SetStateAction<readonly CommerceBoardPresenceEntry[]>
  >,
): () => void {
  const transport = interaction.presence;
  if (transport === undefined) return unchangedCommerceWatchCleanup;
  const resourceKey = commerceBoardPresenceResourceKey(model);
  const selection = commerceBoardPresenceSelection(interaction.intent);
  const dragPreview = commerceBoardDragPreview(interaction.intent);
  const update = updateCommerceBoardPresenceState.bind(
    null,
    interaction.organisationId,
    resourceKey,
    selection,
    dragPreview,
    transport,
    setEntries,
  );
  void update();
  const interval = setInterval(update, 10_000);
  return clearCommerceBoardPresenceInterval.bind(null, interval);
}

async function updateCommerceBoardPresenceState(
  organisationId: string,
  resourceKey: string,
  selection: CommerceBoardPresenceSelection,
  dragPreview: CommerceBoardDragPreview,
  transport: CommercePresenceTransport,
  setEntries: React.Dispatch<
    React.SetStateAction<readonly CommerceBoardPresenceEntry[]>
  >,
): Promise<void> {
  try {
    setEntries(
      await updateCommerceBoardPresence(
        organisationId,
        resourceKey,
        selection,
        dragPreview,
        transport,
      ),
    );
  } catch {
    setEntries([]);
  }
}

function clearCommerceBoardPresenceInterval(
  interval: ReturnType<typeof setInterval>,
): void {
  clearInterval(interval);
}

function commerceBoardPresenceResourceKey(
  model: CommercePublishedCollectionModel,
): string {
  return model.view === null
    ? `commerce_list:${String(model.list?.listId ?? "unknown")}`
    : `saved_commerce_view:${String(model.view.viewId)}`;
}

function commerceBoardPresenceSelection(
  intent: CommerceBoardMoveIntent,
): CommerceBoardPresenceSelection {
  switch (intent.kind) {
    case "dragging":
    case "saving":
    case "approval_requested":
    case "stale":
    case "failed":
      return {
        kind: "list_entry",
        entryId: intent.entryId,
        listId: intent.listId,
      };
    case "idle":
    case "saved":
      return { kind: "none" };
    default:
      return assertNever(intent, "Unhandled commerce graph value");
  }
}

function commerceBoardDragPreview(
  intent: CommerceBoardMoveIntent,
): CommerceBoardDragPreview {
  switch (intent.kind) {
    case "dragging":
      return { kind: "moving", entryId: intent.entryId, desiredStatusId: null };
    case "saving":
    case "stale":
    case "failed":
      return {
        kind: "moving",
        entryId: intent.entryId,
        desiredStatusId: intent.desiredStatus,
      };
    case "approval_requested":
      return { kind: "idle" };
    case "idle":
    case "saved":
      return { kind: "idle" };
    default:
      return assertNever(intent, "Unhandled commerce graph value");
  }
}

function renderCommerceBoardPresenceEntry(
  entry: CommerceBoardPresenceEntry,
): React.ReactNode {
  const activity =
    entry.dragPreview.kind === "moving" ? "changing a lane" : "viewing";
  return (
    <li key={entry.userId}>
      <span aria-hidden="true">
        {commercePresenceInitial(entry.displayName)}
      </span>
      {entry.displayName} · {activity}
    </li>
  );
}

function commercePresenceInitial(displayName: string): string {
  return Array.from(displayName)[0]?.toUpperCase() ?? "?";
}

function commerceStatusOptionLabel(
  model: CommercePublishedCollectionModel,
  statusAttributeId: AttributeDefinitionId,
  statusOptionId: string,
): string {
  if (model.list === null) return statusOptionId;
  const definition = findListEntryDefinition(
    model.list.entryAttributeDefinitions,
    statusAttributeId,
  );
  if (definition?.definition.kind.kind !== "status") return statusOptionId;
  for (const option of definition.definition.kind.options) {
    if (option.id === statusOptionId) return option.label;
  }
  return statusOptionId;
}

export function selectCommerceTableStatus(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  entry: CommerceListEntry,
  label: string,
  statusAttributeId: AttributeDefinitionId,
  value: string | null,
): void {
  if (value === null) return;
  void moveCommerceListEntryStatus(
    model,
    interaction,
    entry,
    label,
    statusAttributeId,
    value,
    false,
  );
}

function selectCommerceBoardLane(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  entry: CommerceListEntry,
  label: string,
  value: string | null,
): void {
  if (value === null) return;
  void moveCommerceBoardEntry(model, interaction, entry, label, value, false);
}

async function moveCommerceBoardEntry(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  entry: CommerceListEntry,
  label: string,
  desiredStatus: string,
  allowPendingIntent: boolean,
): Promise<void> {
  if (model.board === null) return;
  await moveCommerceListEntryStatus(
    model,
    interaction,
    entry,
    label,
    model.board.configuration.laneAttributeId,
    desiredStatus,
    allowPendingIntent,
  );
}

async function moveCommerceListEntryStatus(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  entry: CommerceListEntry,
  label: string,
  statusAttributeId: AttributeDefinitionId,
  desiredStatus: string,
  allowPendingIntent: boolean,
): Promise<void> {
  if (
    model.list === null ||
    interaction.mutate === undefined ||
    !interaction.canOperate ||
    (!allowPendingIntent &&
      commerceBoardIntentBlocksMutation(interaction.intent))
  )
    return;
  const desiredStatusLabel = commerceStatusOptionLabel(
    model,
    statusAttributeId,
    desiredStatus,
  );
  interaction.setIntent({
    kind: "saving",
    entryId: String(entry.entryId),
    listId: String(entry.listId),
    entryRevision: entry.revision,
    merchantRevision: model.merchantRevision,
    statusAttributeId,
    desiredStatus,
    desiredStatusLabel,
    label,
  });
  try {
    const outcome = await patchCommerceListEntryStatus(
      interaction.organisationId,
      model.list,
      entry,
      statusAttributeId,
      desiredStatus,
      interaction.mutate,
    );
    switch (outcome.kind) {
      case "executed":
        interaction.setIntent({ kind: "saved", label, desiredStatusLabel });
        toast.success(`${label} moved to ${desiredStatusLabel}.`);
        interaction.refresh(incrementCommerceRefreshRevision);
        return;
      case "approval_requested":
        interaction.setIntent({
          kind: "approval_requested",
          entryId: String(entry.entryId),
          listId: String(entry.listId),
          entryRevision: entry.revision,
          merchantRevision: model.merchantRevision,
          statusAttributeId,
          desiredStatus,
          desiredStatusLabel,
          label,
          action: outcome.action,
        });
        return;
      default:
        return assertNever(outcome, "Unhandled commerce graph value");
    }
  } catch (error) {
    const intent = {
      entryId: String(entry.entryId),
      listId: String(entry.listId),
      entryRevision: entry.revision,
      merchantRevision: model.merchantRevision,
      statusAttributeId,
      desiredStatus,
      desiredStatusLabel,
      label,
    } as const;
    if (
      error instanceof ControlApiError &&
      error.kind === "commerce_revision_conflict"
    ) {
      interaction.setIntent({ kind: "stale", ...intent });
      interaction.refresh(incrementCommerceRefreshRevision);
      return;
    }
    const permission = permissionRequiredOf(error);
    interaction.setIntent({
      kind: "failed",
      ...intent,
      message:
        permission !== null
          ? `Moving ${label} needs a permission that was not allowed.`
          : error instanceof Error
            ? error.message
            : "The list entry could not be changed.",
      permission,
    });
  }
}

export function renderCommerceListEntryStatusIntent(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
): React.ReactNode {
  const intent = interaction.intent;
  if (intent.kind === "approval_requested") {
    return (
      <Notice tone="neutral" announcement="none">
        Approval requested for {intent.label} to change to{" "}
        {intent.desiredStatusLabel}. Review the change in Operations. The
        connected commerce system has not changed.
      </Notice>
    );
  }
  if (intent.kind === "stale") {
    return (
      <Notice tone="warning" announcement="none">
        {intent.label} changed in another session. Review its latest values,
        then retry the change to {intent.desiredStatusLabel}.
        <span className="commerce-board-intent-actions">
          <button
            type="button"
            onClick={retryCommerceListEntryStatus.bind(
              null,
              model,
              interaction,
            )}
          >
            Retry change
          </button>
          <button
            type="button"
            onClick={discardCommerceListEntryStatus.bind(null, interaction)}
          >
            Discard change
          </button>
        </span>
      </Notice>
    );
  }
  if (intent.kind === "failed") {
    return (
      <Notice tone="warning" announcement="none">
        {intent.message}
        {intent.permission != null && (
          <PermissionRequiredPrompt
            organisationId={interaction.organisationId}
            permission={intent.permission}
            action={`Moving ${intent.label}`}
            grantScope="for this entry only"
            onAllowed={retryCommerceListEntryStatus.bind(
              null,
              model,
              interaction,
            )}
            onClose={closeCommerceListEntryPermission.bind(
              null,
              interaction,
              intent,
            )}
          />
        )}
        <span className="commerce-board-intent-actions">
          <button
            type="button"
            onClick={retryCommerceListEntryStatus.bind(
              null,
              model,
              interaction,
            )}
          >
            Retry change
          </button>
          <button
            type="button"
            onClick={discardCommerceListEntryStatus.bind(null, interaction)}
          >
            Discard change
          </button>
        </span>
      </Notice>
    );
  }
  return null;
}

function retryCommerceListEntryStatus(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
): void {
  const intent = interaction.intent;
  if (intent.kind !== "stale" && intent.kind !== "failed") return;
  const row = model.rows.find(
    (candidate) =>
      String(candidate.entry.entryId) === intent.entryId &&
      String(candidate.entry.listId) === intent.listId,
  );
  if (row === undefined) {
    interaction.setIntent({
      ...intent,
      kind: "failed",
      message: "This list entry is no longer available.",
    });
    return;
  }
  void moveCommerceListEntryStatus(
    model,
    interaction,
    row.entry,
    intent.label,
    intent.statusAttributeId,
    intent.desiredStatus,
    true,
  );
}

function discardCommerceListEntryStatus(
  interaction: CommerceBoardInteraction,
): void {
  interaction.setIntent({ kind: "idle" });
}

/** Keeps the failed move, so that Retry change stays, without the prompt. */
function closeCommerceListEntryPermission(
  interaction: CommerceBoardInteraction,
  intent: Variant<CommerceBoardMoveIntent, "failed">,
): void {
  interaction.setIntent({ ...intent, permission: null });
}

export function commerceListEntryStatusAnnouncement(
  intent: CommerceBoardMoveIntent,
): string {
  switch (intent.kind) {
    case "idle":
      return "";
    case "saved":
      return `${intent.label} changed to ${intent.desiredStatusLabel}.`;
    case "dragging":
      return `Moving ${intent.label}. Choose a destination lane.`;
    case "saving":
      return `Changing ${intent.label} to ${intent.desiredStatusLabel}.`;
    case "approval_requested":
      return `Approval requested for ${intent.label} to change to ${intent.desiredStatusLabel}.`;
    case "stale":
      return `${intent.label} changed in another session. The intended change to ${intent.desiredStatusLabel} is preserved.`;
    case "failed":
      return intent.message;
    default:
      return assertNever(intent, "Unhandled commerce graph value");
  }
}

export function commerceBoardIntentBlocksMutation(
  intent: CommerceBoardMoveIntent,
): boolean {
  switch (intent.kind) {
    case "idle":
    case "saved":
      return false;
    case "dragging":
    case "saving":
    case "approval_requested":
    case "stale":
    case "failed":
      return true;
    default:
      return assertNever(intent, "Unhandled commerce graph value");
  }
}
