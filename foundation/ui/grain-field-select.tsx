import React from "react";
import {
  GRAIN_FIELD_NAMES,
  grainFieldLabel,
  grainFieldSource,
  type GrainFieldName,
} from "./grain-field-data";
import { Select } from "./select";
import "./grain-field-select.css";

// The grain field picker: the Portal Select with a swatch trigger that shows
// a picture of the chosen field, and a dark glass popup that lists every field
// with its picture, a check on the chosen one and an optional tag. Ported from
// the Speak-to-Sign hero picker and GrainFieldPicker in seams-monorepo
// (packages/grain-field-ts). Place it on a coloured ground, for example over a
// GrainField. The arrow keys move the highlight and Enter chooses, as in every
// Portal select.
//
//   <GrainFieldSelect
//     value={field}
//     onValueChange={setField}
//     label="Hero gradient"
//     tags={{ "teal-peach-wisp": "Seams home" }}
//   />

export type GrainFieldSelectProps = {
  readonly value: GrainFieldName;
  readonly onValueChange: (field: GrainFieldName) => void;
  /** The fields of the menu, in order. Every named field by default. */
  readonly fields?: readonly GrainFieldName[];
  /** The menu heading, and the trigger's name with the chosen field. */
  readonly label?: string;
  /** A short tag after a field's name, e.g. `{ "teal-peach-wisp": "Seams home" }`. */
  readonly tags?: Partial<Record<GrainFieldName, string>>;
  /** The Root's name, for a form and for browser journeys. */
  readonly name?: string;
};

const thumbs = new Map<GrainFieldName, string>();

/**
 * A picture of a field: its colour grid as a small PNG data URL. The browser
 * smooths it when it scales it up, so a swatch shows the field's soft
 * gradient. Empty when the browser has no 2D canvas.
 */
function grainFieldThumb(field: GrainFieldName): string {
  const kept = thumbs.get(field);
  if (kept !== undefined) return kept;
  const { grid } = grainFieldSource(field);
  const size = Math.round(Math.sqrt(grid.length / 3));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context === null) return "";
  const image = context.createImageData(size, size);
  for (let cell = 0; cell < size * size; cell += 1) {
    image.data[cell * 4] = grid[cell * 3] ?? 0;
    image.data[cell * 4 + 1] = grid[cell * 3 + 1] ?? 0;
    image.data[cell * 4 + 2] = grid[cell * 3 + 2] ?? 0;
    image.data[cell * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const url = canvas.toDataURL();
  thumbs.set(field, url);
  return url;
}

function Swatch({
  field,
  className,
}: {
  readonly field: GrainFieldName;
  readonly className: string;
}): React.ReactNode {
  const thumb = grainFieldThumb(field);
  return (
    <span
      className={className}
      style={{
        backgroundColor: grainFieldSource(field).base,
        backgroundImage: thumb === "" ? undefined : `url(${thumb})`,
      }}
      aria-hidden="true"
    />
  );
}

export function GrainFieldSelect({
  value,
  onValueChange,
  fields = GRAIN_FIELD_NAMES,
  label = "Gradient",
  tags,
  name,
}: GrainFieldSelectProps): React.ReactNode {
  const items = React.useMemo(
    () =>
      fields.map((field) => ({ value: field, label: grainFieldLabel(field) })),
    [fields],
  );
  return (
    <Select.Root
      items={items}
      value={value}
      name={name}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
    >
      <Select.Trigger
        variant="swatch"
        className="pantry-grain-select-trigger"
        aria-label={`${label}: ${grainFieldLabel(value)}`}
        title={grainFieldLabel(value)}
      >
        <Swatch field={value} className="pantry-grain-select-swatch" />
      </Select.Trigger>
      <Select.Popup
        className="pantry-grain-select-popup"
        align="end"
        alignItemWithTrigger={false}
        sideOffset={8}
      >
        <Select.Group>
          <Select.GroupLabel className="pantry-grain-select-label">
            {label}
          </Select.GroupLabel>
          {fields.map((field) => {
            const tag = tags?.[field];
            return (
              <Select.Item
                key={field}
                value={field}
                className="pantry-grain-select-item"
              >
                <Swatch field={field} className="pantry-grain-select-thumb" />
                <span className="pantry-grain-select-name">
                  {grainFieldLabel(field)}
                </span>
                {tag === undefined ? null : (
                  <span className="pantry-grain-select-tag">{tag}</span>
                )}
              </Select.Item>
            );
          })}
        </Select.Group>
      </Select.Popup>
    </Select.Root>
  );
}
