import { Select } from "@purin-labs/ui/select";
import {
  COMMERCE_TABLE_DENSITIES,
  renderCommerceSelectParts,
  type CommerceSelectItem,
} from "./select-items";
import React from "react";
import { toast } from "sonner";
import type {
  AttributeDefinitionId,
  CommerceTableDensity,
  CommerceViewPresentation,
  ListEntryAttributeDefinition,
} from "@purin-labs/commerce-contracts";
import { ControlApiError } from "@purin-labs/control/portal/control-client";
import {
  PermissionRequiredPrompt,
  permissionRequiredOf,
} from "@purin-labs/area-organisation-contract/ui/features/access/permission-required-prompt";
import { Notice } from "@purin-labs/ui/page-components";
import { publishCommerceSavedViewPresentation } from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import type {
  CommerceSavedViewEditEvidence,
  CommerceSavedViewEditIntent,
  CommerceSavedViewEditorProps,
} from "./entity-plane-types";
import { incrementCommerceRefreshRevision } from "./entity-plane-shared";

export function CommerceSavedViewEditor(
  props: CommerceSavedViewEditorProps,
): React.ReactNode {
  const [intent, setIntent] = React.useState<CommerceSavedViewEditIntent>({
    kind: "idle",
  });
  const view = props.model.view;
  if (
    view === null ||
    !props.interaction.canAdminister ||
    props.interaction.mutate === undefined
  )
    return null;
  return (
    <details className="commerce-display-options">
      <summary>Display options</summary>
      <div className="commerce-display-options-body">
        <p>Changes apply for everyone in this workspace.</p>
        {view.presentation.kind === "table"
          ? renderCommerceTableViewEditor(props, intent, setIntent)
          : renderCommerceBoardViewEditor(props, intent, setIntent)}
        {renderCommerceSavedViewEditIntent(props, intent, setIntent)}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {commerceSavedViewEditAnnouncement(intent)}
      </p>
    </details>
  );
}

function renderCommerceTableViewEditor(
  props: CommerceSavedViewEditorProps,
  intent: CommerceSavedViewEditIntent,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
): React.ReactNode {
  const view = props.model.view;
  if (view === null || view.presentation.kind !== "table") return null;
  return (
    <div className="commerce-view-editor-fields">
      <label>
        <span>Table density</span>
        <Select.Root
          items={COMMERCE_TABLE_DENSITIES}
          value={view.presentation.configuration.density}
          disabled={intent.kind === "saving"}
          onValueChange={changeCommerceTableDensity.bind(
            null,
            props,
            setIntent,
          )}
        >
          {renderCommerceSelectParts(COMMERCE_TABLE_DENSITIES)}
        </Select.Root>
      </label>
      <label className="commerce-view-editor-checkbox">
        <input
          type="checkbox"
          checked={view.presentation.configuration.showRowNumbers}
          disabled={intent.kind === "saving"}
          onChange={changeCommerceTableRowNumbers.bind(null, props, setIntent)}
        />
        <span>Show row numbers</span>
      </label>
    </div>
  );
}

function renderCommerceBoardViewEditor(
  props: CommerceSavedViewEditorProps,
  intent: CommerceSavedViewEditIntent,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
): React.ReactNode {
  const view = props.model.view;
  const list = props.model.list;
  if (view === null || view.presentation.kind !== "board" || list === null)
    return null;
  const laneFields = commerceBoardStatusDefinitions(
    list.entryAttributeDefinitions,
  ).map(commerceBoardStatusDefinitionItem);
  return (
    <div className="commerce-view-editor-fields">
      <label>
        <span>Lane field</span>
        <Select.Root
          items={laneFields}
          value={String(view.presentation.configuration.laneAttributeId)}
          disabled={intent.kind === "saving"}
          onValueChange={changeCommerceBoardLaneField.bind(
            null,
            props,
            setIntent,
          )}
        >
          {renderCommerceSelectParts(laneFields)}
        </Select.Root>
      </label>
      <fieldset disabled={intent.kind === "saving"}>
        <legend>Card fields</legend>
        {list.entryAttributeDefinitions.map(
          renderCommerceBoardCardAttributeControl.bind(null, props, setIntent),
        )}
      </fieldset>
    </div>
  );
}

function commerceBoardStatusDefinitions(
  definitions: readonly ListEntryAttributeDefinition[],
): readonly ListEntryAttributeDefinition[] {
  const statusDefinitions: ListEntryAttributeDefinition[] = [];
  for (const definition of definitions) {
    if (definition.definition.kind.kind === "status")
      statusDefinitions.push(definition);
  }
  return statusDefinitions;
}

function commerceBoardStatusDefinitionItem(
  definition: ListEntryAttributeDefinition,
): CommerceSelectItem {
  return {
    value: String(definition.attributeId),
    label: definition.definition.label,
  };
}

function renderCommerceBoardCardAttributeControl(
  props: CommerceSavedViewEditorProps,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
  definition: ListEntryAttributeDefinition,
): React.ReactNode {
  const view = props.model.view;
  if (view === null || view.presentation.kind !== "board") return null;
  const selected = includesAttributeId(
    view.presentation.configuration.cardAttributeIds,
    definition.attributeId,
  );
  const lastSelected =
    selected && view.presentation.configuration.cardAttributeIds.length === 1;
  return (
    <label
      className="commerce-view-editor-checkbox"
      key={String(definition.attributeId)}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={lastSelected}
        onChange={changeCommerceBoardCardAttribute.bind(
          null,
          props,
          setIntent,
          definition.attributeId,
        )}
      />
      <span>{definition.definition.label}</span>
    </label>
  );
}

function includesAttributeId(
  attributeIds: readonly AttributeDefinitionId[],
  attributeId: AttributeDefinitionId,
): boolean {
  return attributeIds.includes(attributeId);
}

function changeCommerceTableDensity(
  props: CommerceSavedViewEditorProps,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
  value: string | null,
): void {
  const view = props.model.view;
  if (value === null || view === null || view.presentation.kind !== "table")
    return;
  const density = parseCommerceTableDensity(value);
  void saveCommerceViewPresentation(props, setIntent, {
    kind: "table",
    configuration: {
      density,
      showRowNumbers: view.presentation.configuration.showRowNumbers,
    },
  });
}

function changeCommerceTableRowNumbers(
  props: CommerceSavedViewEditorProps,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const view = props.model.view;
  if (view === null || view.presentation.kind !== "table") return;
  void saveCommerceViewPresentation(props, setIntent, {
    kind: "table",
    configuration: {
      density: view.presentation.configuration.density,
      showRowNumbers: event.currentTarget.checked,
    },
  });
}

function changeCommerceBoardLaneField(
  props: CommerceSavedViewEditorProps,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
  value: string | null,
): void {
  const view = props.model.view;
  const list = props.model.list;
  if (view === null || view.presentation.kind !== "board" || list === null)
    return;
  if (value === null) return;
  const laneAttributeId = findCommerceBoardLaneAttributeId(
    list.entryAttributeDefinitions,
    value,
  );
  if (laneAttributeId === undefined) return;
  void saveCommerceViewPresentation(props, setIntent, {
    kind: "board",
    configuration: {
      laneAttributeId,
      cardAttributeIds: view.presentation.configuration.cardAttributeIds,
    },
  });
}

function changeCommerceBoardCardAttribute(
  props: CommerceSavedViewEditorProps,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
  attributeId: AttributeDefinitionId,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const view = props.model.view;
  if (view === null || view.presentation.kind !== "board") return;
  const cardAttributeIds = event.currentTarget.checked
    ? [...view.presentation.configuration.cardAttributeIds, attributeId]
    : view.presentation.configuration.cardAttributeIds.filter(
        attributeIdDoesNotEqual.bind(null, attributeId),
      );
  void saveCommerceViewPresentation(props, setIntent, {
    kind: "board",
    configuration: {
      laneAttributeId: view.presentation.configuration.laneAttributeId,
      cardAttributeIds,
    },
  });
}

function attributeIdDoesNotEqual(
  expected: AttributeDefinitionId,
  candidate: AttributeDefinitionId,
): boolean {
  return candidate !== expected;
}

function parseCommerceTableDensity(value: string): CommerceTableDensity {
  switch (value) {
    case "compact":
    case "comfortable":
    case "spacious":
      return value;
    default:
      throw new Error("The selected table density is invalid.");
  }
}

function findCommerceBoardLaneAttributeId(
  definitions: readonly ListEntryAttributeDefinition[],
  value: string,
): AttributeDefinitionId | undefined {
  for (const definition of definitions) {
    if (
      definition.attributeId === value &&
      definition.definition.kind.kind === "status"
    ) {
      return definition.attributeId;
    }
  }
  return undefined;
}

async function saveCommerceViewPresentation(
  props: CommerceSavedViewEditorProps,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
  presentation: CommerceViewPresentation,
): Promise<void> {
  const view = props.model.view;
  const mutate = props.interaction.mutate;
  if (view === null || mutate === undefined || !props.interaction.canAdminister)
    return;
  const evidence: CommerceSavedViewEditEvidence = {
    viewId: String(view.viewId),
    viewRevision: Number(view.revision),
    merchantRevision: props.model.merchantRevision,
    presentation,
  };
  setIntent({ kind: "saving", ...evidence });
  try {
    await publishCommerceSavedViewPresentation(
      props.interaction.organisationId,
      view,
      presentation,
      mutate,
    );
    setIntent({ kind: "idle" });
    toast.success("Display updated for everyone.");
    props.interaction.refresh(incrementCommerceRefreshRevision);
  } catch (error) {
    if (
      error instanceof ControlApiError &&
      error.kind === "commerce_revision_conflict"
    ) {
      setIntent({ kind: "stale", ...evidence });
      props.interaction.refresh(incrementCommerceRefreshRevision);
      return;
    }
    const permission = permissionRequiredOf(error);
    setIntent({
      kind: "failed",
      ...evidence,
      message:
        permission !== null
          ? "Updating this view needs a permission that was not allowed."
          : error instanceof Error
            ? error.message
            : "Unable to publish the view. Check your connection and retry the update.",
      permission,
    });
  }
}

function renderCommerceSavedViewEditIntent(
  props: CommerceSavedViewEditorProps,
  intent: CommerceSavedViewEditIntent,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
): React.ReactNode {
  if (intent.kind === "stale") {
    return (
      <Notice tone="warning" announcement="none">
        This view changed in another session. Review the latest presentation,
        then retry your update.
        <span className="commerce-board-intent-actions">
          <button
            type="button"
            onClick={retryCommerceSavedViewEdit.bind(
              null,
              props,
              intent,
              setIntent,
            )}
          >
            Retry view update
          </button>
          <button
            type="button"
            onClick={discardCommerceSavedViewEdit.bind(null, setIntent)}
          >
            Discard view update
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
            organisationId={props.interaction.organisationId}
            permission={intent.permission}
            action="Updating this view"
            grantScope="for this view only"
            onAllowed={retryCommerceSavedViewEdit.bind(
              null,
              props,
              intent,
              setIntent,
            )}
            onClose={setIntent.bind(null, { ...intent, permission: null })}
          />
        )}
        <span className="commerce-board-intent-actions">
          <button
            type="button"
            onClick={retryCommerceSavedViewEdit.bind(
              null,
              props,
              intent,
              setIntent,
            )}
          >
            Retry view update
          </button>
          <button
            type="button"
            onClick={discardCommerceSavedViewEdit.bind(null, setIntent)}
          >
            Discard view update
          </button>
        </span>
      </Notice>
    );
  }
  return null;
}

function retryCommerceSavedViewEdit(
  props: CommerceSavedViewEditorProps,
  intent: Variant<CommerceSavedViewEditIntent, "stale" | "failed">,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
): void {
  void saveCommerceViewPresentation(props, setIntent, intent.presentation);
}

function discardCommerceSavedViewEdit(
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
): void {
  setIntent({ kind: "idle" });
}

function commerceSavedViewEditAnnouncement(
  intent: CommerceSavedViewEditIntent,
): string {
  switch (intent.kind) {
    case "idle":
      return "";
    case "saving":
      return "Publishing the saved-view presentation.";
    case "stale":
      return "The saved view changed in another session. The presentation update is preserved.";
    case "failed":
      return intent.message;
    default:
      return assertNever(intent, "Unhandled commerce graph value");
  }
}
