import React from "react";
import {
  Bot,
  Building2,
  Fingerprint,
  LifeBuoy,
  ListChecks,
  Menu,
  PenLine,
  Rocket,
  Sprout,
  TrendingUp,
  Wallet,
  Wrench,
} from "lucide-react";
import { ArrowRightAnim, pageHref, Wordmark } from "./shared";

type DropdownId = "products" | "documentation" | "about" | "pricing";

type MenuRow = {
  title: string;
  description: string;
  to: string;
  icon: React.ComponentType<{
    size?: number;
    strokeWidth?: number;
    "aria-hidden"?: boolean;
  }>;
  /** Small right-aligned annotation, e.g. a plan's price basis. */
  meta?: string;
};

/** Which gradient asset backs the pane's highlight card (see navigation.css). */
type MenuHighlightTone = "aqua" | "bluegreen" | "ember";

type MenuHighlight = {
  title: string;
  description: string;
  to: string;
  tone: MenuHighlightTone;
};

type MenuFooterLink = {
  label: string;
  to: string;
};

type DropdownPane = {
  id: DropdownId;
  label: string;
  kicker: string;
  rows: MenuRow[];
  /** Optional gradient promo card on the pane's right side. */
  highlight?: MenuHighlight;
  footerLinks: MenuFooterLink[];
};

const productMenu: DropdownPane = {
  id: "products",
  label: "Products",
  kicker: "Products",
  rows: [
    {
      title: "Embedded Wallet",
      description: "Non-custodial wallets with policy-bound keys and sessions",
      to: "/wallet",
      icon: Wallet,
    },
    {
      title: "Ecommerce Agents",
      description: "AI agents with scoped credentials, acting inside policy",
      to: "/ecommerce",
      icon: Bot,
    },
    {
      title: "Biometric Authentication",
      description: "Passkey and VoiceID flows for owner presence",
      to: "/docs/concepts/auth-methods/passkeys",
      icon: Fingerprint,
    },
  ],
  highlight: {
    title: "Live demo",
    description: "Create a passkey wallet on the Embedded Wallet page",
    to: "/wallet",
    tone: "aqua",
  },
  footerLinks: [{ label: "Plan pricing", to: "/pricing/" }],
};

const documentationMenu: DropdownPane = {
  id: "documentation",
  label: "Documentation",
  kicker: "Documentation",
  rows: [
    {
      title: "Get Started",
      description: "Install the SDK, create a wallet, and sign with policy",
      to: "/docs/",
      icon: Rocket,
    },
    {
      title: "Tools and Guides",
      description: "Auth, sessions, wallet UI, policy, and the SDK reference",
      to: "/docs/guides/",
      icon: Wrench,
    },
    {
      title: "Use cases",
      description: "Mandates, delegated agents, and agent-driven commerce",
      to: "/docs/use-cases/",
      icon: ListChecks,
    },
  ],
  highlight: {
    title: "Architecture",
    description: "How passkeys, policy, and signing fit together",
    to: "/docs/concepts/architecture",
    tone: "bluegreen",
  },
  footerLinks: [{ label: "Read the docs", to: "/docs/" }],
};

const pricingMenu: DropdownPane = {
  id: "pricing",
  label: "Pricing",
  kicker: "Plans",
  rows: [
    {
      title: "Starter",
      description: "Up to 5K monthly active wallets",
      to: "/pricing/#starter",
      icon: Sprout,
      meta: "Included",
    },
    {
      title: "Growth",
      description: "5K–100K monthly active wallets",
      to: "/pricing/#growth",
      icon: TrendingUp,
      meta: "Usage-based",
    },
    {
      title: "Scale",
      description: "100K+ monthly active wallets, SLA, and advanced controls",
      to: "/pricing/#scale",
      icon: Rocket,
      meta: "Volume",
    },
  ],
  footerLinks: [
    { label: "Compare plans", to: "/pricing/" },
    { label: "Contact sales", to: "/contact/" },
  ],
};

const aboutMenu: DropdownPane = {
  id: "about",
  label: "About Us",
  kicker: "Company",
  rows: [
    {
      title: "Company",
      description: "Who we are and what we are building",
      to: "/company/",
      icon: Building2,
    },
    {
      title: "Blog",
      description: "Writing from the Seams team",
      to: "/company/#blog",
      icon: PenLine,
    },
    {
      title: "Support",
      description: "Get help from the team",
      to: "/contact/",
      icon: LifeBuoy,
    },
  ],
  highlight: {
    title: "Plan a rollout",
    description: "Talk through marketplaces and merchant fleets",
    to: "/contact/",
    tone: "ember",
  },
  footerLinks: [{ label: "Contact sales", to: "/contact/" }],
};

const panes = [productMenu, documentationMenu, pricingMenu, aboutMenu];

function MenuPane({ pane }: { pane: DropdownPane }): React.ReactNode {
  const rows: React.ReactNode[] = [];
  const footer: React.ReactNode[] = [];
  for (const row of pane.rows) {
    const Icon = row.icon;
    rows.push(
      <a
        key={row.title}
        className="navbar-static__menu-row"
        href={pageHref(row.to)}
      >
        <span className="navbar-static__menu-row-icon" aria-hidden="true">
          <Icon size={16} strokeWidth={1.7} />
        </span>
        <span className="navbar-static__menu-row-text">
          <span className="navbar-static__menu-row-title">{row.title}</span>
          <span className="navbar-static__menu-row-description">
            {row.description}
          </span>
        </span>
        {row.meta && (
          <span className="navbar-static__menu-row-meta">{row.meta}</span>
        )}
      </a>,
    );
  }
  for (const link of pane.footerLinks) {
    footer.push(
      <a
        key={link.label}
        className="navbar-static__menu-footer-link"
        href={pageHref(link.to)}
      >
        {link.label}
        <ArrowRightAnim size={12} />
      </a>,
    );
  }
  return (
    <div className="navbar-static__menu">
      <div className="navbar-static__menu-body">
        <div className="navbar-static__menu-col">
          <p className="navbar-static__menu-kicker">{pane.kicker}</p>
          {rows}
        </div>
        {pane.highlight && (
          <div className="navbar-static__menu-side">
            <a
              className={`navbar-static__menu-highlight navbar-static__menu-highlight--${pane.highlight.tone}`}
              href={pageHref(pane.highlight.to)}
            >
              <span className="navbar-static__menu-highlight-title">
                {pane.highlight.title}
              </span>
              <span className="navbar-static__menu-highlight-description">
                {pane.highlight.description}
              </span>
            </a>
          </div>
        )}
      </div>
      <div className="navbar-static__menu-footer">{footer}</div>
    </div>
  );
}

function MenuGroup({
  pane,
  mobile,
}: {
  pane: DropdownPane;
  mobile: boolean;
}): React.ReactNode {
  return (
    <details
      name={mobile ? "ecommerce-mobile" : "ecommerce-desktop"}
      className={mobile ? "ecommerce-mobile-group" : "navbar-static__group"}
      onPointerEnter={mobile ? undefined : openMenuOnHover}
      onPointerLeave={mobile ? undefined : closeMenuOnLeave}
      onBlur={closeMenuOnBlur}
    >
      <summary className="navbar-static__link">{pane.label}</summary>
      <div
        className={mobile ? "ecommerce-mobile-pane" : "ecommerce-menu-popup"}
      >
        <MenuPane pane={pane} />
      </div>
    </details>
  );
}

export function Navigation(): React.ReactNode {
  const root = React.useRef<HTMLElement>(null);
  React.useEffect(registerOutsideDismissal.bind(null, root), [root]);
  const desktop: React.ReactNode[] = [];
  const mobile: React.ReactNode[] = [];
  for (const pane of panes) {
    desktop.push(<MenuGroup key={pane.id} pane={pane} mobile={false} />);
    mobile.push(<MenuGroup key={pane.id} pane={pane} mobile />);
  }
  return (
    <nav
      ref={root}
      className="navbar-static navbar-static--compact"
      aria-label="Primary"
      onKeyDown={closeNavigationOnEscape}
    >
      <div className="navbar-static__shell">
        <div className="navbar-static__left">
          <a
            className="navbar-static__brand"
            href={pageHref("/")}
            aria-label="Seams home"
          >
            <Wordmark height={17} />
          </a>
        </div>
        <div className="navbar-static__center">
          <div className="navbar-static__links">{desktop}</div>
        </div>
        <div className="navbar-static__right">
          <div className="navbar-static__actions">
            <a
              className="navbar-static__pill navbar-static__pill--solid"
              href="/portal"
            >
              Dashboard
              <ArrowRightAnim size={14} />
            </a>
            <a
              className="navbar-static__pill navbar-static__pill--ghost"
              href={pageHref("/contact/")}
            >
              Contact Sales
              <ArrowRightAnim size={14} />
            </a>
            <details className="ecommerce-mobile-navigation">
              <summary
                className="navbar-static__mobile-toggle"
                aria-label="Navigation menu"
              >
                <Menu size={20} aria-hidden="true" />
              </summary>
              <div className="ecommerce-mobile-panel">
                {mobile}
                <a
                  className="navbar-static__menu-footer-link"
                  href={pageHref("/contact/")}
                >
                  Contact Sales
                  <ArrowRightAnim size={14} />
                </a>
              </div>
            </details>
          </div>
        </div>
      </div>
    </nav>
  );
}

function openMenuOnHover(event: React.PointerEvent<HTMLDetailsElement>): void {
  if (
    event.pointerType === "mouse" &&
    matchMedia("(hover: hover) and (pointer: fine)").matches
  )
    event.currentTarget.open = true;
}

function closeMenuOnLeave(event: React.PointerEvent<HTMLDetailsElement>): void {
  if (!event.currentTarget.contains(document.activeElement))
    event.currentTarget.open = false;
}

function closeMenuOnBlur(event: React.FocusEvent<HTMLDetailsElement>): void {
  if (
    !(event.relatedTarget instanceof Node) ||
    !event.currentTarget.contains(event.relatedTarget)
  )
    event.currentTarget.open = false;
}

function closeNavigation(root: HTMLElement): void {
  for (const detail of root.querySelectorAll("details")) detail.open = false;
}

function closeNavigationOnEscape(
  event: React.KeyboardEvent<HTMLElement>,
): void {
  if (event.key !== "Escape") return;
  const detail =
    event.target instanceof Element ? event.target.closest("details") : null;
  closeNavigation(event.currentTarget);
  detail?.querySelector("summary")?.focus();
  event.preventDefault();
}

function dismissOutside(
  root: React.RefObject<HTMLElement | null>,
  event: PointerEvent,
): void {
  if (
    root.current &&
    event.target instanceof Node &&
    !root.current.contains(event.target)
  )
    closeNavigation(root.current);
}

function registerOutsideDismissal(
  root: React.RefObject<HTMLElement | null>,
): () => void {
  const listener = dismissOutside.bind(null, root);
  window.addEventListener("pointerdown", listener);
  return removeOutsideDismissal.bind(null, listener);
}

function removeOutsideDismissal(listener: (event: PointerEvent) => void): void {
  window.removeEventListener("pointerdown", listener);
}
