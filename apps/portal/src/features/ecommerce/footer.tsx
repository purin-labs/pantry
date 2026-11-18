import React from "react";
import { pageHref, Wordmark } from "./shared";

/* ---------- footer ---------- */

type H2FooterLink = {
  label: string;
  to: string;
  external?: boolean;
};

const footerGroups: { heading: string; links: H2FooterLink[] }[] = [
  {
    heading: "Products",
    links: [
      { label: "Embedded Wallet", to: "/wallet" },
      { label: "Ecommerce Agents", to: "/ecommerce" },
      { label: "Custody Model", to: "/docs/concepts/custody/" },
      {
        label: "Wallet Sessions",
        to: "/docs/concepts/sessions/wallet-sessions",
      },
    ],
  },
  {
    heading: "Platform",
    links: [
      { label: "Authentication", to: "/docs/concepts/auth-methods/" },
      { label: "Passkeys", to: "/docs/concepts/auth-methods/passkeys" },
      {
        label: "Wallets & Signatures",
        to: "/docs/concepts/threshold-signing/",
      },
      { label: "Permissions & Policy", to: "/docs/concepts/policy/mandates" },
    ],
  },
  {
    heading: "Developers",
    links: [
      { label: "Documentation", to: "/docs/concepts/" },
      { label: "Architecture", to: "/docs/concepts/architecture" },
      { label: "Wallet Iframe", to: "/docs/concepts/custody/wallet-iframe" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Guides", to: "/docs/guides/" },
      { label: "Use Cases", to: "/docs/use-cases/" },
      { label: "Pricing", to: "/pricing/" },
    ],
  },
  {
    heading: "Socials",
    links: [
      { label: "X", to: "https://x.com/lowerarchy", external: true },
      { label: "GitHub", to: "https://github.com/seams-tech", external: true },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", to: "/company/" },
      { label: "Blog", to: "/company/#blog" },
      { label: "Contact", to: "/contact/" },
    ],
  },
];

function FooterLink({ link }: { link: H2FooterLink }): React.ReactNode {
  return (
    <a
      href={pageHref(link.to)}
      target={link.external ? "_blank" : undefined}
      rel={link.external ? "noopener noreferrer" : undefined}
    >
      {link.label}
    </a>
  );
}

export function H2Footer(): React.ReactNode {
  const groups: React.ReactNode[] = [];
  for (const group of footerGroups) {
    const links: React.ReactNode[] = [];
    for (const link of group.links)
      links.push(<FooterLink key={link.label} link={link} />);
    groups.push(
      <div className="h2-footer__col" key={group.heading}>
        <h3>{group.heading}</h3>
        {links}
      </div>,
    );
  }
  return (
    <footer className="h2-footer h2-rule" aria-label="Site footer">
      <div className="h2-footer__inner">
        <div className="h2-footer__grid">
          <div className="h2-footer__brand">
            <a href={pageHref("/")} aria-label="Seams home">
              <Wordmark height={20} />
            </a>
          </div>
          <div className="h2-footer__links">{groups}</div>
        </div>
      </div>
    </footer>
  );
}
