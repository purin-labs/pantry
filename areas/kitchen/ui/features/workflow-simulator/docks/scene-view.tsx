import { floorPlanWorkspace } from "../floor-plan-workspace";
import { BakeryAppearanceControl } from "@purin-labs/ui/preferences/appearance-controls";
import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Building2,
  Check,
  LocateFixed,
  Map,
  PictureInPicture2,
  RotateCcw,
  RotateCw,
  Tags,
} from "lucide-react";
import { GlideHighlight } from "@purin-labs/ui/glide-highlight";
import type { SceneLabelMode } from "../simulator-state";
import type { WorkflowSimulatorActions } from "../simulator-actions";
import type { SceneControlsView } from "../simulator-state";
import { BAKERY_FLOOR_PLANS, BAKERY_FLOOR_PLAN_ORDER } from "@purin-labs/production-simulation/floor/bakery-room";

import { StoreInteriorDesignControl } from "./store-interior-control";

type Props = Readonly<{
  view: SceneControlsView;
  actions: Pick<
    WorkflowSimulatorActions,
    "toggleCamera" | "resetCamera" | "setLabels" | "toggleMinimap"
  >;
}>;

type LabelChoice = Readonly<{
  mode: SceneLabelMode;
  name: string;
  detail: string;
}>;

/** Focus returns here when the overview hides itself. */
export const overviewToggleId = "workflow-overview-toggle";

const labelChoices: readonly [LabelChoice, ...LabelChoice[]] = [
  {
    mode: "auto",
    name: "Auto",
    detail: "Names, with details when something needs attention",
  },
  { mode: "all", name: "All details", detail: "Every label, fully expanded" },
  { mode: "off", name: "Off", detail: "Only what you hover or select" },
];

/**
 * Camera and label controls for the 3D view, kept apart from time controls.
 * Like the floor plan's they are icons on one surface, and Recenter joins
 * them only once the camera has left its home view.
 */
export function SceneViewControls(props: Props): React.ReactNode {
  const ready = props.view.scene === "ready";
  const topView = React.useRef<HTMLButtonElement>(null);
  const floorPlanId = React.useSyncExternalStore(
    floorPlanWorkspace.subscribePlan,
    floorPlanWorkspace.getActivePlan,
    floorPlanWorkspace.getActivePlan,
  );
  const currentFloorPlan = BAKERY_FLOOR_PLANS[floorPlanId];
  const current =
    labelChoices.find(matchesMode.bind(null, props.view.labels)) ??
    labelChoices[0];
  return (
    <div className="workflow-scene-controls" role="group" aria-label="3D view">
      {props.view.cameraMoved ? (
        <button
          type="button"
          aria-label="Recenter camera"
          data-tooltip="Recenter camera"
          disabled={!ready}
          onClick={recenter.bind(null, props.actions, topView)}
        >
          <LocateFixed aria-hidden="true" />
        </button>
      ) : null}
      <div className="workflow-scene-control-group">
        <BakeryAppearanceControl />
        <StoreInteriorDesignControl disabled={!ready} />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="workflow-labels-trigger"
              disabled={!ready}
              aria-label={`Floor plan room: ${currentFloorPlan.shortLabel}`}
              data-tooltip={`Floor plan: ${currentFloorPlan.shortLabel}`}
            >
              <Building2 aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="workflow-more-menu workflow-labels-menu"
              side="top"
              align="end"
              sideOffset={8}
              collisionPadding={12}
              aria-label="Floor plan room model"
            >
              <GlideHighlight target="[data-highlighted]" />
              <DropdownMenu.RadioGroup value={floorPlanId}>
                {BAKERY_FLOOR_PLAN_ORDER.map((id) => {
                  const spec = BAKERY_FLOOR_PLANS[id];
                  return (
                    <DropdownMenu.RadioItem
                      key={id}
                      value={id}
                      onSelect={() => floorPlanWorkspace.setActivePlan(id)}
                    >
                      <span className="workflow-speed-indicator">
                        <DropdownMenu.ItemIndicator>
                          <Check size={16} aria-hidden="true" />
                        </DropdownMenu.ItemIndicator>
                      </span>
                      <span className="workflow-labels-choice">
                        <span>{spec.shortLabel}</span>
                        <small>{spec.location}</small>
                      </span>
                    </DropdownMenu.RadioItem>
                  );
                })}
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                onSelect={() => {
                  window.dispatchEvent(
                    new KeyboardEvent("keydown", { key: "r" }),
                  );
                }}
              >
                <span className="workflow-speed-indicator">
                  <RotateCw size={15} aria-hidden="true" />
                </span>
                <span className="workflow-labels-choice">
                  <span>Rotate selected 90° (R)</span>
                  <small>Press R or double-click any station to rotate</small>
                </span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => floorPlanWorkspace.resetPlacements(floorPlanId)}
              >
                <span className="workflow-speed-indicator">
                  <RotateCcw size={15} aria-hidden="true" />
                </span>
                <span className="workflow-labels-choice">
                  <span>Reset appliance layout</span>
                  <small>Drag any station in 3D or Floor plan to move</small>
                </span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          aria-label="Rotate selected 90° (R)"
          data-tooltip="Rotate 90° (R)"
          disabled={!ready}
          onClick={() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
          }}
        >
          <RotateCw aria-hidden="true" />
        </button>
        <button
          ref={topView}
          type="button"
          aria-label="Top view"
          data-tooltip="Top view"
          aria-pressed={props.view.top}
          disabled={!ready}
          onClick={props.actions.toggleCamera}
        >
          <Map aria-hidden="true" />
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="workflow-labels-trigger"
              disabled={!ready}
              aria-label={`Labels: ${current.name}`}
              data-tooltip={`Labels: ${current.name} (L)`}
            >
              <Tags aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="workflow-more-menu workflow-labels-menu"
              side="top"
              align="end"
              sideOffset={8}
              collisionPadding={12}
              aria-label="Label detail"
            >
              <GlideHighlight target="[data-highlighted]" />
              <DropdownMenu.RadioGroup value={props.view.labels}>
                {labelChoices.map(renderLabelChoice.bind(null, props.actions))}
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator />
              <DropdownMenu.Label className="workflow-more-summary">
                <kbd>L</kbd> cycles labels · <kbd>H</kbd> hides the interface
              </DropdownMenu.Label>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        {props.view.overviewAvailable ? (
          <button
            id={overviewToggleId}
            type="button"
            aria-label="Floor plan overview"
            data-tooltip="Floor plan overview"
            aria-pressed={props.view.minimap}
            disabled={!ready}
            onClick={props.actions.toggleMinimap}
          >
            <PictureInPicture2 aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Recenter hides once the camera is home, so focus moves on to Top view. */
function recenter(
  actions: Props["actions"],
  topView: React.RefObject<HTMLButtonElement | null>,
  event: React.MouseEvent<HTMLButtonElement>,
): void {
  const focused = document.activeElement === event.currentTarget;
  actions.resetCamera();
  if (focused) topView.current?.focus();
}

function renderLabelChoice(
  actions: Props["actions"],
  choice: LabelChoice,
): React.ReactNode {
  return (
    <DropdownMenu.RadioItem
      key={choice.mode}
      value={choice.mode}
      onSelect={actions.setLabels.bind(null, choice.mode)}
    >
      <span className="workflow-speed-indicator">
        <DropdownMenu.ItemIndicator>
          <Check size={16} aria-hidden="true" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className="workflow-labels-choice">
        <span>{choice.name}</span>
        <small>{choice.detail}</small>
      </span>
    </DropdownMenu.RadioItem>
  );
}

/** The L shortcut steps through the same order as the menu. */
export function nextLabelMode(mode: SceneLabelMode): SceneLabelMode {
  const index = labelChoices.findIndex(matchesMode.bind(null, mode));
  return (labelChoices[(index + 1) % labelChoices.length] ?? labelChoices[0])
    .mode;
}

function matchesMode(mode: SceneLabelMode, choice: LabelChoice): boolean {
  return choice.mode === mode;
}
