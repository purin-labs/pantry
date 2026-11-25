import type * as React from "react";

import "./identity-tile.css";

export type IdentityTileProps = Readonly<{
  /**
   * The organisation or workspace id. A tile with no logo takes its gradient
   * from it, so a rename keeps the colours.
   */
  seed: string;
  /** The uploaded logo, or null for the gradient. */
  logoUrl: string | null;
  size?: "md" | "sm";
  className?: string;
}>;

/**
 * The tile of an organisation or a workspace: its own logo, or a gradient
 * that comes from its id. The same id gives the same gradient on every
 * screen, and two ids almost always give two different gradients.
 */
export function IdentityTile(props: IdentityTileProps): React.ReactNode {
  const className = [
    "identity-tile",
    props.size === "sm" ? "identity-tile-sm" : null,
    props.className ?? null,
  ]
    .filter((part) => part !== null)
    .join(" ");
  if (props.logoUrl !== null)
    return (
      <span className={className} data-kind="logo" aria-hidden="true">
        <img src={props.logoUrl} alt="" loading="lazy" decoding="async" />
      </span>
    );
  return (
    <span
      className={className}
      data-kind="gradient"
      aria-hidden="true"
      style={identityGradient(props.seed)}
    />
  );
}

/** Two hues and an angle from the seed, as CSS custom properties. */
function identityGradient(seed: string): React.CSSProperties {
  const hash = fnv1a(seed);
  const first = hash % 360;
  // The second hue sits 40 to 110 degrees away, so the two never clash.
  const second = (first + 40 + ((hash >>> 9) % 71)) % 360;
  const angle = 100 + ((hash >>> 17) % 120);
  return {
    "--identity-hue-a": String(first),
    "--identity-hue-b": String(second),
    "--identity-angle": `${angle}deg`,
  } as React.CSSProperties;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
