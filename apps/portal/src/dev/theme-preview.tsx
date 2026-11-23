import { Select } from "@purin-labs/ui/select";
import React from "react";
import { createRoot } from "react-dom/client";
import { usePortalTheme } from "@purin-labs/ui/use-portal-theme";
import "@purin-labs/surface-portal/ui/styles.css";
import "./theme-preview.css";

const SHADES = [
  50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800,
];
const TONES = [
  "success",
  "info",
  "warning",
  "danger",
  "category-accent",
  "category-neutral",
];

type Anchor = { name: string; detail: string; token: string };
type ThemeSpec = {
  label: string;
  title: string;
  summary: string;
  reference: string;
  accent: string;
  families: readonly string[];
  anchors: readonly Anchor[];
};

// Keys match the data-pantry-theme values in packages/frontend-themes.
const THEMES = {
  "slate-coral": {
    label: "Slate and coral",
    title: "Slate and coral.",
    summary:
      "Cool slate surfaces, actions, and selection. Coral for focus and accents.",
    reference:
      "The six reference colors, preserved as OKLCH anchors. Slate carries " +
      "the interface and selection; coral marks links, focus, and small accents.",
    accent: "Coral accent",
    families: ["slate", "coral"],
    anchors: [
      { name: "Blush", detail: "#F6E8E3", token: "--pantry-coral-100" },
      { name: "Peach", detail: "#F0B1A1", token: "--pantry-coral-300" },
      { name: "Coral", detail: "#C96357", token: "--pantry-coral-500" },
      { name: "Slate gray", detail: "#8B9BA7", token: "--pantry-slate-450" },
      { name: "Light slate", detail: "#778899", token: "--pantry-slate-500" },
      { name: "Dark slate", detail: "#3C4552", token: "--pantry-slate-700" },
    ],
  },
  espresso: {
    label: "Espresso",
    title: "Espresso and caramel.",
    summary:
      "White cards on a warm canvas. Espresso actions. Caramel for focus and accents.",
    reference:
      "Warm neutrals carry the interface, with pure white cards and espresso " +
      "ink; caramel marks links, focus, and small accents.",
    accent: "Caramel accent",
    families: ["espresso", "caramel"],
    anchors: [
      { name: "Canvas", detail: "#F8F6F4", token: "--pantry-espresso-100" },
      { name: "Hairline", detail: "#8B857F", token: "--pantry-espresso-450" },
      { name: "Espresso", detail: "#2A2522", token: "--pantry-espresso-750" },
      { name: "Cream", detail: "#FEEFDC", token: "--pantry-caramel-100" },
      { name: "Caramel", detail: "#D0792A", token: "--pantry-caramel-500" },
      {
        name: "Burnt caramel",
        detail: "#91450D",
        token: "--pantry-caramel-650",
      },
    ],
  },
  paper: {
    label: "Paper",
    title: "Paper and white.",
    summary:
      "White cards on a near-white canvas. Near-black actions. Blue for hover, focus and accents.",
    reference:
      "Light neutrals after elevenlabs.io, preserved as OKLCH anchors. Gray " +
      "neutrals carry the interface; a strong blue marks hover, links, " +
      "focus, and small accents.",
    accent: "Blue accent",
    families: ["linen", "blue"],
    anchors: [
      { name: "Paper", detail: "#FFFFFF", token: "--pantry-linen-50" },
      { name: "Canvas", detail: "#FAFAF9", token: "--pantry-linen-100" },
      { name: "Surface", detail: "#F5F5F4", token: "--pantry-linen-150" },
      { name: "Border", detail: "#E5E5E4", token: "--pantry-linen-300" },
      { name: "Ink", detail: "#111111", token: "--pantry-linen-800" },
      { name: "Light blue", detail: "#CDE5FF", token: "--pantry-blue-150" },
      { name: "Focus blue", detail: "#000CE1", token: "--pantry-blue-600" },
      { name: "Core blue", detail: "#0007CB", token: "--pantry-blue-650" },
    ],
  },
  sageberry: {
    label: "Sageberry",
    title: "Chiffon and sage.",
    summary: "Soft, warm surfaces. Botanical greens. A small spark of lilac.",
    reference:
      "The five Sageberry Bliss reference colors, preserved as OKLCH anchors. " +
      "Chiffon and sage carry the interface; purple and lilac are reserved " +
      "for animations, focus rings, and small accents.",
    accent: "Lilac accent",
    families: ["chiffon", "sage", "sage-muted", "lilac"],
    anchors: [
      { name: "Purple", detail: "#B296CA", token: "--pantry-lilac-400" },
      { name: "Lilac", detail: "#CEB7D7", token: "--pantry-lilac-300" },
      { name: "Chiffon", detail: "#E0DCD1", token: "--pantry-chiffon-200" },
      { name: "Soft sage", detail: "#ACB9AD", token: "--pantry-sage-300" },
      { name: "Sage", detail: "#81987F", token: "--pantry-sage-400" },
    ],
  },
} as const satisfies Record<string, ThemeSpec>;

type PantryTheme = keyof typeof THEMES;

function isPantryTheme(value: string): value is PantryTheme {
  return Object.hasOwn(THEMES, value);
}

const THEME_KEYS = Object.keys(THEMES) as PantryTheme[];
const THEME_ITEMS = THEME_KEYS.map((theme) => ({
  value: theme,
  label: THEMES[theme].label,
}));

function Shade(family: string, shade: number): React.ReactNode {
  const token = `--pantry-${family}-${shade}`;
  return (
    <li key={shade}>
      <span
        className="theme-swatch"
        style={{ background: `var(${token})` }}
        aria-label={token}
      />
      <span>{shade}</span>
    </li>
  );
}

function Family(family: string): React.ReactNode {
  return (
    <section
      className="theme-ramp"
      key={family}
      aria-label={`${family} shades`}
    >
      <h3>{family.replaceAll("-", " ")}</h3>
      <ol>{SHADES.map(Shade.bind(null, family))}</ol>
    </section>
  );
}

function Tone(tone: string): React.ReactNode {
  return (
    <span
      className="theme-tone"
      key={tone}
      style={{
        color: `var(--pantry-${tone}-text)`,
        background: `var(--pantry-${tone}-surface)`,
      }}
    >
      {tone.replace("category-", "")}
    </span>
  );
}

function AnchorSwatch(anchor: Anchor): React.ReactNode {
  return (
    <li key={anchor.token}>
      <span
        className="theme-anchor-swatch"
        style={{ background: `var(${anchor.token})` }}
      />
      <strong>{anchor.name}</strong>
      <span>{anchor.detail}</span>
    </li>
  );
}

function ThemeOption(theme: PantryTheme): React.ReactNode {
  return (
    <Select.Item key={theme} value={theme}>
      {THEMES[theme].label}
    </Select.Item>
  );
}

function ThemePreview(): React.ReactNode {
  const { theme: appearance, toggleTheme } = usePortalTheme();
  const [colorTheme, setColorTheme] = React.useState<PantryTheme>("slate-coral");
  const [saved, setSaved] = React.useState(false);
  // The account hook applies its own theme on every mode change; the choice
  // here wins after it.
  React.useEffect(() => {
    document.documentElement.dataset.pantryTheme = colorTheme;
  }, [colorTheme, appearance]);
  const spec: ThemeSpec = THEMES[colorTheme];
  const selectTheme = (value: string | null) => {
    if (value !== null && isPantryTheme(value)) setColorTheme(value);
  };
  return (
    <main className="theme-preview">
      <header className="theme-preview-heading">
        <div>
          <p className="theme-eyebrow">Purin Pantry / Design system</p>
          <h1>{spec.title}</h1>
          <p>{spec.summary}</p>
        </div>
        <div className="theme-preview-controls">
          <label htmlFor="theme-select">Theme</label>
          <Select.Root
            items={THEME_ITEMS}
            value={colorTheme}
            onValueChange={selectTheme}
          >
            <Select.Trigger id="theme-select">
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{THEME_KEYS.map(ThemeOption)}</Select.Popup>
          </Select.Root>
          <button type="button" className="secondary" onClick={toggleTheme}>
            Switch to {appearance === "light" ? "dark" : "light"} mode
          </button>
        </div>
      </header>

      <section className="theme-specimen" aria-label="Component examples">
        <div className="theme-sample-sidebar">
          <strong>Purin Pantry</strong>
          <span className="theme-sample-selected">Menu draft</span>
          <span>Products</span>
          <span>Orders</span>
        </div>
        <div className="theme-sample-body">
          <h2>Weekend pastry menu</h2>
          <p>Every surface, control, and label below uses a semantic role.</p>
          <label htmlFor="sample-menu">Menu name</label>
          <input id="sample-menu" defaultValue="Saturday pastries" />
          <div className="theme-tones">{TONES.map(Tone)}</div>
          <div className="theme-actions">
            <button
              type="button"
              className="primary-button"
              onClick={setSaved.bind(null, true)}
            >
              Save sample
            </button>
            <button
              type="button"
              className="secondary"
              onClick={setSaved.bind(null, false)}
            >
              Reset status
            </button>
            <button type="button" className="secondary" disabled>
              Unavailable
            </button>
          </div>
          <p className="theme-sample-status" role="status">
            {saved
              ? "Sample saved. No workspace data changed."
              : "Preview only. Ready to save."}{" "}
            <a href="#theme-reference">View palette anchors</a>
          </p>
          <div className="theme-accent-example">
            <span className="theme-activity" aria-hidden="true" />
            <span>Activity animation preview</span>
            <span className="theme-accent-label">{spec.accent}</span>
          </div>
        </div>
      </section>

      <section
        className="theme-reference"
        id="theme-reference"
        aria-label="Reference palette"
      >
        <h2>Palette anchors</h2>
        <p>{spec.reference}</p>
        <ul className="theme-anchor-swatches">
          {spec.anchors.map(AnchorSwatch)}
        </ul>
      </section>
      <div className="theme-ramps">{spec.families.map(Family)}</div>
      <footer>
        Use <code>--pantry-primary</code> for actions and{" "}
        <code>--pantry-ink</code> for text. Semantic tokens adapt to the selected
        theme and appearance.
      </footer>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV) {
  throw new Error("Theme preview is development-only.");
}
createRoot(root).render(<ThemePreview />);
