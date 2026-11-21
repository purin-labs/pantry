import React from "react";
import type {
  BakeAuthorityMode,
  BakeAuthorityView,
} from "@purin-labs/kitchen-control-api";

import { useMutation } from "../../ui";
import { Select } from "../../ui/select";
import { refusalText, saveBakeAuthority } from "./requests";

/**
 * The authority of the bake runs at each kitchen location (Plan 24 S5). In
 * shadow mode, the default, an approved bake only watches the cobots: the
 * controller runs the bake from its own script, and the run shows the planned
 * and the observed times. In approval mode an approved bake sends its tasks.
 * An admin or the owner changes the mode; every other member reads it.
 */

const MODES: readonly Readonly<{ value: BakeAuthorityMode; label: string }>[] =
  [
    { value: "shadow", label: "Shadow: watch only" },
    { value: "approval", label: "Approval: send the tasks" },
  ];

export function BakeAuthorityList(
  props: Readonly<{
    organisationId: string;
    authority: readonly BakeAuthorityView[];
    mayEdit: boolean;
    saved: () => void;
  }>,
): React.ReactNode {
  const { organisationId, authority, mayEdit, saved } = props;
  const save = useMutation(
    (
      input: Readonly<{ location: BakeAuthorityView; mode: BakeAuthorityMode }>,
      idempotencyKey: string,
    ) =>
      saveBakeAuthority(
        organisationId,
        {
          kitchenLocation: input.location.kitchenLocation,
          mode: input.mode,
          expectedRevision: input.location.revision,
        },
        idempotencyKey,
      ),
    () => saved(),
  );
  if (authority.length === 0)
    return (
      <p className="bakes-note">
        A kitchen shows here when its gateway is on the Devices page.
      </p>
    );
  return (
    <ul className="bakes-authority" aria-label="Authority of each kitchen">
      {authority.map((location) => {
        const state = save.state(location.kitchenLocation);
        return (
          <li key={location.kitchenLocation} className="bakes-authority-row">
            <span className="bakes-authority-name">
              {location.kitchenLocation}
            </span>
            {mayEdit ? (
              <Select.Root
                items={MODES}
                value={location.mode}
                disabled={state.kind === "running"}
                onValueChange={(mode) => {
                  if (mode === "shadow" || mode === "approval")
                    void save.run(location.kitchenLocation, { location, mode });
                }}
              >
                <Select.Trigger
                  variant="ghost"
                  size="sm"
                  aria-label={`Authority of ${location.kitchenLocation}`}
                >
                  <Select.Value />
                </Select.Trigger>
                <Select.Popup>
                  {MODES.map((mode) => (
                    <Select.Item key={mode.value} value={mode.value}>
                      {mode.label}
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Root>
            ) : (
              <span>
                {MODES.find((mode) => mode.value === location.mode)?.label}
              </span>
            )}
            {state.kind === "failed" ? (
              <span className="bakes-refusal" role="alert">
                {refusalText(state.error)}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
