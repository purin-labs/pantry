import type * as React from "react";

import "./identity-tile.css";

export type IdentityTileProps = Readonly<{
  /**
   * The organisation or workspace id. A tile with no logo takes its gradient
   * from it, so a rename keeps the colours.
   */
  seed: string;
  /**
   * The name of the organisation or workspace. A gradient tile shows its
   * initials, so two tiles in one colour family still look different.
   */
  name: string;
  /** The uploaded logo, or null for the gradient. */
  logoUrl: string | null;
  size?: "md" | "sm";
  className?: string;
}>;

/**
 * The tile of an organisation or a workspace: its own logo, or a gradient
 * that comes from its id. The same id gives the same gradient on every
 * screen. Two ids get one colour family each, from eight that are 45
 * degrees apart, and the gradient carries the initials of the name, so two
 * different tiles never look almost the same.
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
    >
      <span className="identity-tile-initials">
        {identityInitials(props.name)}
      </span>
    </span>
  );
}

/**
 * The first letter of the first two words of a name, in capitals: "Nuki
 * Inc." gives "NI" and "Atelier" gives "A". A word with no letter or digit,
 * such as "&", gives nothing.
 */
function identityInitials(name: string): string {
  return name
    .split(/\s+/u)
    .map(firstLetter)
    .filter((letter) => letter !== "")
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase();
}

function firstLetter(word: string): string {
  return /[\p{L}\p{N}]/u.exec(word)?.[0] ?? "";
}

/**
 * The colour families of the gradient tiles: coral, gold, lime, emerald,
 * cyan, blue, violet and pink. A free hue from the hash let two
 * organisations land 11 degrees apart and look the same; a family is
 * either the same or at least 45 degrees away.
 */
const IDENTITY_FAMILIES = 8;
const IDENTITY_FIRST_CENTRE = 40;
const IDENTITY_FAMILY_STEP = 360 / IDENTITY_FAMILIES;
/** Half the hue spread inside one tile, so a tile reads as one family. */
const IDENTITY_HALF_SPREAD = 18;

/** Two hues and an angle from the seed, as CSS custom properties. */
function identityGradient(seed: string): React.CSSProperties {
  const hash = fnv1a(seed);
  const centre =
    IDENTITY_FIRST_CENTRE + (hash % IDENTITY_FAMILIES) * IDENTITY_FAMILY_STEP;
  const first = (centre - IDENTITY_HALF_SPREAD + 360) % 360;
  const second = (centre + IDENTITY_HALF_SPREAD) % 360;
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
