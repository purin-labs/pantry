import "./pantry-mark.css";

/**
 * The goat mark for an avatar that stands for Pantry or Sous Chef. The
 * dark mark shows on light surfaces and the light mark on dark surfaces; the
 * Portal theme on the document element picks one, so a theme change needs
 * no render.
 */
export function PantryMark() {
  return (
    <>
      <img
        className="pantry-mark pantry-mark-on-light"
        src="/brand/satyr-mark-dark-128.png"
        alt=""
      />
      <img
        className="pantry-mark pantry-mark-on-dark"
        src="/brand/satyr-mark-light-128.png"
        alt=""
      />
    </>
  );
}
