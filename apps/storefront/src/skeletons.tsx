// Skeleton blocks hold the shape of a page while its data loads, so the
// layout does not jump when the menu or the quote arrives. They use the
// same layout classes as the real page; only the bones are new. The live
// region in the page announces what loads, so every bone is hidden from
// assistive technology.
import type React from "react";

type BoneProps = Readonly<{
  className?: string;
  width?: string;
  height?: string;
}>;

/** One grey block in the shape of the content that will replace it. */
function Bone(props: BoneProps): React.ReactNode {
  return (
    <span
      className={
        props.className === undefined
          ? "skeleton-bone"
          : `skeleton-bone ${props.className}`
      }
      style={{ width: props.width, height: props.height }}
    />
  );
}

function repeat(count: number, render: (index: number) => React.ReactNode) {
  return Array.from({ length: count }, (_, index) => render(index));
}

/**
 * The pâtisserie menu before it loads: the masthead, the section tabs, the
 * flavour chart of eight financiers, the hotcake band and two pies.
 */
export function PatisserieMenuSkeleton(
  props: Readonly<{ label: string }>,
): React.ReactNode {
  return (
    <div className="cafe-app-shell patisserie-shell">
      <section
        className="cafe-menu patisserie-page skeleton"
        aria-busy="true"
        aria-label={props.label}
      >
        <div aria-hidden="true">
          <header className="patisserie-masthead">
            <Bone width="min(18rem, 70%)" height="2.8rem" />
            <Bone width="min(24rem, 85%)" height="0.7rem" />
          </header>
          <div className="patisserie-menu">
            <div className="patisserie-sections">
              {repeat(3, (index) => (
                <span key={index} className="skeleton-tab">
                  <Bone width="5rem" height="0.6rem" />
                </span>
              ))}
            </div>
            <div className="patisserie-chart">
              <div className="patisserie-chart-heading">
                <Bone width="5rem" height="0.8rem" />
                <Bone width="min(34rem, 80vw)" height="3.6rem" />
                <Bone width="min(20rem, 55vw)" height="3.6rem" />
              </div>
              <div className="patisserie-chart-grid">
                {repeat(8, (index) => (
                  <div key={index} className="patisserie-chart-item">
                    <Bone className="patisserie-chart-art" />
                    <div className="patisserie-chart-copy">
                      <Bone width="6rem" height="1.6rem" />
                      <Bone width="3.5rem" height="0.7rem" />
                      <Bone width="5rem" height="0.9rem" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="patisserie-hotcake">
              <Bone className="patisserie-hotcake-arch" />
              <div className="patisserie-hotcake-copy">
                <Bone width="6rem" height="0.8rem" />
                <Bone width="min(20rem, 90%)" height="2.6rem" />
                <Bone width="100%" height="0.8rem" />
                <Bone width="80%" height="0.8rem" />
                <Bone width="9rem" height="2.75rem" className="skeleton-pill" />
              </div>
            </div>
            <div className="patisserie-pies">
              <div className="patisserie-section-heading">
                <Bone width="9rem" height="3.2rem" />
              </div>
              {repeat(2, (index) => (
                <div key={index} className="patisserie-pie">
                  <span className="patisserie-pie-japanese">
                    <Bone width="1.2rem" height="7rem" />
                  </span>
                  <Bone className="patisserie-pie-disc" />
                  <div className="patisserie-cross-section">
                    <Bone className="patisserie-cross-section-cut" />
                    <div className="skeleton-labels">
                      <Bone width="5rem" height="0.65rem" />
                      <Bone width="8rem" height="0.65rem" />
                      <Bone width="6rem" height="0.65rem" />
                    </div>
                  </div>
                  <div className="patisserie-pie-copy">
                    <Bone width="min(16rem, 100%)" height="2rem" />
                    <Bone
                      width="9rem"
                      height="2.75rem"
                      className="skeleton-pill"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Any other storefront menu before it loads: a heading and product cards. */
export function CatalogSkeleton(
  props: Readonly<{ label: string }>,
): React.ReactNode {
  return (
    <section
      className="skeleton skeleton-catalog"
      aria-busy="true"
      aria-label={props.label}
    >
      <div aria-hidden="true">
        <div className="skeleton-catalog-heading">
          <Bone width="7rem" height="0.75rem" />
          <Bone width="min(26rem, 90%)" height="2.6rem" />
          <Bone width="min(34rem, 100%)" height="0.85rem" />
        </div>
        <div className="skeleton-catalog-grid">
          {repeat(6, (index) => (
            <div key={index} className="skeleton-card">
              <Bone className="skeleton-card-media" />
              <Bone width="70%" height="1.1rem" />
              <Bone width="45%" height="0.8rem" />
              <Bone width="100%" height="2.75rem" className="skeleton-pill" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The order review before the quote arrives: the heading, the item lines,
 * the totals and the pay button of the checkout card.
 */
export function CheckoutSkeleton(
  props: Readonly<{ label: string }>,
): React.ReactNode {
  return (
    <div className="checkout-shell">
      <section
        className="checkout-card skeleton"
        aria-busy="true"
        aria-label={props.label}
      >
        <div aria-hidden="true" className="skeleton-checkout">
          <Bone width="6rem" height="0.7rem" />
          <Bone width="min(18rem, 80%)" height="2.8rem" />
          <Bone width="min(28rem, 100%)" height="0.85rem" />
          <div className="skeleton-review">
            {repeat(3, (index) => (
              <div key={index} className="skeleton-review-line">
                <Bone className="skeleton-thumb" />
                <div className="skeleton-review-copy">
                  <Bone width="60%" height="0.95rem" />
                  <Bone width="35%" height="0.7rem" />
                </div>
                <Bone width="3.5rem" height="0.95rem" />
              </div>
            ))}
          </div>
          <div className="skeleton-totals">
            <Bone width="40%" height="0.8rem" />
            <Bone width="30%" height="0.8rem" />
            <Bone width="50%" height="1.2rem" />
          </div>
          <Bone width="100%" height="3rem" className="skeleton-pill" />
        </div>
      </section>
    </div>
  );
}
