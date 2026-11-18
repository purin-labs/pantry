import { floorPlanWorkspace } from "../floor-plan-workspace";
import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Armchair, Check, RotateCcw } from "lucide-react";
import {
  FIXTURE_FINISH_CHOICES,
  FLOOR_MATERIAL_CHOICES,
  LIGHTING_STYLE_CHOICES,
  STORE_INTERIOR_PRESETS,
  STORE_INTERIOR_PRESET_ORDER,
  WALL_HEIGHT_CHOICES,
  WALL_MATERIAL_CHOICES,
  applyStoreInteriorPreset,
  getStoreInteriorDesign,
  subscribeStoreInteriorDesign,
  updateStoreInteriorDesign,
  type FixtureFinishId,
  type FloorMaterialId,
  type InteriorChoice,
  type LightingStyleId,
  type WallHeightMode,
  type WallMaterialId,
} from "../store-interior-design";

function Swatch(props: Readonly<{ hex: string }>): React.ReactNode {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        borderRadius: 3,
        backgroundColor: props.hex,
        border: "1px solid rgba(0, 0, 0, 0.22)",
        flexShrink: 0,
      }}
    />
  );
}

function renderChoiceItem<T extends string>(
  onSelect: (id: T) => void,
  choice: InteriorChoice<T>,
): React.ReactNode {
  return (
    <DropdownMenu.RadioItem
      key={choice.id}
      value={choice.id}
      onSelect={() => onSelect(choice.id)}
    >
      <span className="workflow-speed-indicator">
        <DropdownMenu.ItemIndicator>
          <Check size={15} aria-hidden="true" />
        </DropdownMenu.ItemIndicator>
      </span>
      <Swatch hex={choice.swatchHex} />
      <span className="workflow-labels-choice">
        <span>{choice.label}</span>
        <small>{choice.detail}</small>
      </span>
    </DropdownMenu.RadioItem>
  );
}

export function StoreInteriorDesignControl(
  props: Readonly<{ disabled?: boolean }>,
): React.ReactNode {
  const design = React.useSyncExternalStore(
    subscribeStoreInteriorDesign,
    getStoreInteriorDesign,
    getStoreInteriorDesign,
  );

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="workflow-labels-trigger"
          disabled={props.disabled}
          aria-label="Store interior design & materials"
          data-tooltip="Store interior design"
        >
          <Armchair aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="workflow-more-menu workflow-labels-menu"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Store interior design"
          style={{
            maxHeight: "min(78vh, 560px)",
            overflowY: "auto",
            minWidth: 300,
          }}
        >
          <DropdownMenu.Label className="preference-appearance-label">
            Store interior theme
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={design.preset}>
            {STORE_INTERIOR_PRESET_ORDER.map((presetId) => {
              const preset = STORE_INTERIOR_PRESETS[presetId];
              return (
                <DropdownMenu.RadioItem
                  key={presetId}
                  value={presetId}
                  onSelect={() => applyStoreInteriorPreset(presetId)}
                >
                  <span className="workflow-speed-indicator">
                    <DropdownMenu.ItemIndicator>
                      <Check size={15} aria-hidden="true" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <span className="workflow-labels-choice">
                    <span>{preset.label}</span>
                    <small>{preset.detail}</small>
                  </span>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator />
          <DropdownMenu.Label className="preference-appearance-label">
            Floor material
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={design.floorMaterial}>
            {FLOOR_MATERIAL_CHOICES.map((choice) =>
              renderChoiceItem(
                (floorMaterial: FloorMaterialId) =>
                  updateStoreInteriorDesign({ floorMaterial }),
                choice,
              ),
            )}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator />
          <DropdownMenu.Label className="preference-appearance-label">
            Wall & wainscot material
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={design.wallMaterial}>
            {WALL_MATERIAL_CHOICES.map((choice) =>
              renderChoiceItem(
                (wallMaterial: WallMaterialId) =>
                  updateStoreInteriorDesign({ wallMaterial }),
                choice,
              ),
            )}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator />
          <DropdownMenu.Label className="preference-appearance-label">
            Storefront & fixture metal
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={design.fixtureFinish}>
            {FIXTURE_FINISH_CHOICES.map((choice) =>
              renderChoiceItem(
                (fixtureFinish: FixtureFinishId) =>
                  updateStoreInteriorDesign({ fixtureFinish }),
                choice,
              ),
            )}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator />
          <DropdownMenu.Label className="preference-appearance-label">
            Overhead lighting fixtures
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={design.lightingStyle}>
            {LIGHTING_STYLE_CHOICES.map((choice) =>
              renderChoiceItem(
                (lightingStyle: LightingStyleId) =>
                  updateStoreInteriorDesign({ lightingStyle }),
                choice,
              ),
            )}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator />
          <DropdownMenu.Label className="preference-appearance-label">
            Wall cutaway height
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={design.wallHeightMode}>
            {WALL_HEIGHT_CHOICES.map((choice) =>
              renderChoiceItem(
                (wallHeightMode: WallHeightMode) =>
                  updateStoreInteriorDesign({ wallHeightMode }),
                choice,
              ),
            )}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator />
          <DropdownMenu.CheckboxItem
            checked={design.showFurnishings}
            onCheckedChange={(checked) =>
              updateStoreInteriorDesign({
                showFurnishings: Boolean(checked),
              })
            }
          >
            <span className="workflow-speed-indicator">
              <DropdownMenu.ItemIndicator>
                <Check size={15} aria-hidden="true" />
              </DropdownMenu.ItemIndicator>
            </span>
            <span className="workflow-labels-choice">
              <span>Show bench, pastry vitrine & planter</span>
              <small>Drag any furniture piece in 3D to rearrange</small>
            </span>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Item
            onSelect={() =>
              floorPlanWorkspace.resetPlacements(
                floorPlanWorkspace.getActivePlan(),
              )
            }
          >
            <span className="workflow-speed-indicator">
              <RotateCcw size={15} aria-hidden="true" />
            </span>
            <span className="workflow-labels-choice">
              <span>Reset room & furniture layout</span>
              <small>Restore default positions for this floor plan</small>
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
