import React from "react";
import { Navigation } from "./navigation";
import { ArrowRightAnim, pageHref } from "./shared";
import { H2Bento, H2Cases } from "./sections";
import { H2Footer } from "./footer";
import { BakeryMotion } from "./bakery-motion";
import "./fonts.css";
import "./navigation.css";
import "./styles.css";

function EcommerceHero(): React.JSX.Element {
  return (
    <header className="h2-hero-simple" aria-labelledby="h2-eco-hero-title">
      <div className="h2-shell">
        <p className="h2-kicker">Seams · Ecommerce Agents</p>
        <h1 id="h2-eco-hero-title" className="h2-display h2-hero-simple__title">
          AI agents that run your store, inside policy
        </h1>
        <p className="h2-hero-simple__sub">
          The Seams Harness gives every agent its own identity and scoped
          credentials: limits, approvals, and expiry checked before anything
          executes, with an evidence trail for every decision.
        </p>
        <div className="h2-hero-simple__ctas">
          <a
            className="h2-btn h2-btn--primary h2-btn--lg"
            href={pageHref("/docs/concepts/policy/mandates")}
          >
            Start building
          </a>
          <a
            className="h2-btn h2-btn--outline h2-btn--lg"
            href={pageHref("/contact/")}
          >
            Talk to us
          </a>
        </div>
        {/* div, not p: ArrowRightAnim renders a div, which can't nest in a p */}
        <div className="h2-hero-simple__cross">
          Need the wallet layer?{" "}
          <a className="h2-fork" href={pageHref("/wallet")}>
            Embedded Wallet
            <ArrowRightAnim size={12} />
          </a>
        </div>
      </div>
    </header>
  );
}

export function EcommercePage(): React.JSX.Element {
  return (
    <div className="h2-page">
      <Navigation />
      <main className="h2-col">
        <EcommerceHero />
        <BakeryMotion />
        <H2Cases />
        <H2Bento />
        <H2Footer />
      </main>
    </div>
  );
}
