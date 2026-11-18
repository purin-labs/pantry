import React from "react";

// Only the ecommerce page lives here. Other product pages stay on Seams;
// the Dashboard entry opens this frontend's existing operator portal.
export function pageHref(target: string): string {
  if (target === "/ecommerce") return "/ecommerce";
  if (target === "/dashboard") return "/portal";
  if (target === "/wallet") return "https://wallet.seams.sh";
  if (target.startsWith("/docs/")) {
    return new URL(target.slice(5), "https://docs.seams.sh").href;
  }
  return new URL(target, "https://seams.sh").href;
}

export function Wordmark({ height }: { height: number }): React.ReactNode {
  return (
    <img
      src="/ecommerce/seams-wordmark.svg"
      alt="Seams"
      width={(height * 1428) / 285}
      height={height}
    />
  );
}

export function ArrowRightAnim({ size }: { size: number }): React.ReactNode {
  return (
    <span className="ecommerce-arrow" aria-hidden="true">
      <svg
        width={size}
        height={size}
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path className="ecommerce-arrow-line" d="M0 5h7" />
        <path className="ecommerce-arrow-tip" d="M1 1l4 4-4 4" />
      </svg>
    </span>
  );
}
