import React from "react";
import { createRoot } from "react-dom/client";
import { GrainField, GrainFieldSelect, type GrainFieldName } from "../ui";
import "../styles.css";
import "./gradients-preview.css";

// Development preview of GrainField and GrainFieldSelect: a hero panel on a
// moving grain field, with the field picker at its top right.

function GradientsPreview(): React.ReactNode {
  const [field, setField] = React.useState<GrainFieldName>("apricot-beam");
  return (
    <main className="gradients-preview">
      <section
        className="gradients-preview-hero"
        aria-labelledby="gradients-preview-title"
      >
        <GrainField field={field} pace={0.5} />
        <header className="gradients-preview-bar">
          <strong>Purin Pantry</strong>
          <GrainFieldSelect
            name="hero-field"
            value={field}
            onValueChange={setField}
            label="Hero gradient"
            tags={{ "teal-peach-wisp": "Seams home" }}
          />
        </header>
        <h1 id="gradients-preview-title">Grain fields</h1>
        <p>
          Open the picker at the top right. The arrow keys move the highlight,
          and Enter chooses a field.
        </p>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("The grain field preview is development-only.");
createRoot(root).render(<GradientsPreview />);
