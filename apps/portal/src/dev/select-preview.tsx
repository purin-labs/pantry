import React from "react";
import { Select } from "../ui/select";

const PASTRIES = [
  { value: "financier", label: "Brown butter financier · Tokyo boutique" },
  {
    value: "madeleine",
    label: "Lemon madeleine · Saint-Honoré boutique · afternoon collection",
  },
  { value: "sold-out", label: "Chocolate éclair · sold out" },
];
const LOCATIONS = [
  { value: "tokyo", label: "Tokyo boutique" },
  { value: "paris", label: "Paris boutique" },
];
const RTL_LOCATIONS = [
  { value: "tokyo", label: "طوكيو" },
  { value: "paris", label: "باريس" },
];
const SHIFTS = [
  { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
  { value: "evening", label: "Evening" },
];
const LAYOUTS = [
  { value: "grid", label: "Grid of sections" },
  { value: "columns", label: "Two columns" },
];
const ADDITIONS = [
  { value: "", label: "Add an element…" },
  { value: "text", label: "Text" },
];

/** Keyboard behavior, long text, validation and form values. */
export function SelectPreview(): React.ReactNode {
  const [item, setItem] = React.useState("financier");
  const [submitted, setSubmitted] = React.useState<string | null>(null);
  return (
    <section className="select-preview" aria-label="Select preview">
      <h2>Shared selects</h2>
      <p>
        The Base UI Select: one caret, keyboard controls, and room
        for long names.
      </p>
      <form onSubmit={submitSelection.bind(null, setSubmitted)}>
        <label>
          First item
          <Select.Root
            name="item"
            items={PASTRIES}
            value={item}
            onValueChange={(value) => setItem(value ?? "financier")}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              <Select.Group>
                <Select.GroupLabel>Pastries</Select.GroupLabel>
                {PASTRIES.map((pastry) => (
                  <Select.Item
                    key={pastry.value}
                    value={pastry.value}
                    disabled={pastry.value === "sold-out"}
                  >
                    {pastry.label}
                  </Select.Item>
                ))}
              </Select.Group>
            </Select.Popup>
          </Select.Root>
        </label>
        <label>
          Pickup location
          <Select.Root name="location" required items={LOCATIONS}>
            <Select.Trigger>
              <Select.Value placeholder="Choose a location" />
            </Select.Trigger>
            <Select.Popup>{LOCATIONS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          Unavailable location
          <Select.Root
            name="unavailable"
            disabled
            defaultValue="closed"
            items={[
              { value: "closed", label: "Location closed for maintenance" },
            ]}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              <Select.Item value="closed">
                Location closed for maintenance
              </Select.Item>
            </Select.Popup>
          </Select.Root>
        </label>
        <label dir="rtl">
          موقع الاستلام
          <Select.Root name="rtlLocation" defaultValue="tokyo" items={RTL_LOCATIONS}>
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{RTL_LOCATIONS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          Included shifts
          <Select.Root
            name="shifts"
            multiple
            defaultValue={["morning"]}
            items={SHIFTS}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{SHIFTS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <button type="submit">Review selection</button>
      </form>
      <output aria-live="polite">
        {submitted ?? "No selection submitted."}
      </output>
      <div
        className="select-preview-toolbar"
        role="toolbar"
        aria-label="Ghost selects"
      >
        <Select.Root defaultValue="grid" items={LAYOUTS}>
          <Select.Trigger variant="ghost" aria-label="Layout">
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{LAYOUTS.map(renderItem)}</Select.Popup>
        </Select.Root>
        <Select.Root defaultValue="" items={ADDITIONS}>
          <Select.Trigger variant="ghost" aria-label="Add">
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{ADDITIONS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </div>
    </section>
  );
}

function renderItem(
  item: Readonly<{ value: string; label: string }>,
): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}

function submitSelection(
  setSubmitted: React.Dispatch<React.SetStateAction<string | null>>,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  const values = new URLSearchParams();
  for (const [name, value] of new FormData(event.currentTarget)) {
    if (typeof value === "string") values.append(name, value);
  }
  setSubmitted(values.toString());
}
