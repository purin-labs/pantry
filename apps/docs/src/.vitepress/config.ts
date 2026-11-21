import { defineConfig, type DefaultTheme } from "vitepress";

const docsOrigin = (
  process.env.VITE_DOCS_ORIGIN || "http://docs.localhost:3005"
).replace(/\/$/, "");
const siteOrigin = (
  process.env.VITE_SITE_ORIGIN || "http://portal.localhost"
).replace(/\/$/, "");

function pageUrl(page: string): string {
  const route = page.replace(/(?:^|\/)index\.md$/, "").replace(/\.md$/, "");
  return route ? `${docsOrigin}/${route}` : docsOrigin;
}

const startHereSection: DefaultTheme.SidebarItem = {
  text: "Start here",
  items: [
    { text: "Overview", link: "/" },
    { text: "Architecture", link: "/concepts/architecture" },
    { text: "First operating path", link: "/guides/first-operating-path" },
    { text: "Run Pantry locally", link: "/operate/local-development" },
  ],
};

const guidesSection: DefaultTheme.SidebarItem = {
  text: "Guides",
  items: [
    { text: "Overview", link: "/guides/" },
    { text: "Merchant onboarding", link: "/guides/merchant-onboarding" },
    { text: "Commerce operations", link: "/guides/commerce-operations" },
    { text: "Integrations", link: "/guides/integrations" },
    {
      text: "WhatsApp customer support",
      link: "/guides/whatsapp-customer-support",
    },
    { text: "Bakery automation", link: "/guides/bakery-automation" },
  ],
};

const conceptsSection: DefaultTheme.SidebarItem = {
  text: "Concepts",
  items: [
    { text: "Overview", link: "/concepts/" },
    { text: "Architecture", link: "/concepts/architecture" },
    { text: "Runtime request flow", link: "/concepts/runtime-request-flow" },
    { text: "Commerce domain", link: "/concepts/commerce-domain" },
    {
      text: "Authority and boundaries",
      link: "/concepts/authority-and-boundaries",
    },
    { text: "Module vocabulary", link: "/concepts/module-vocabulary" },
    { text: "Glossary", link: "/concepts/glossary" },
  ],
};

const operateSection: DefaultTheme.SidebarItem = {
  text: "Operate",
  items: [
    { text: "Overview", link: "/operate/" },
    { text: "Local development", link: "/operate/local-development" },
    { text: "Testing and evidence", link: "/operate/testing-and-evidence" },
    { text: "Onboarding operations", link: "/operate/onboarding" },
    { text: "Slack liveness", link: "/operate/slack-liveness" },
    { text: "Vault operations", link: "/operate/vault" },
  ],
};

const referenceSection: DefaultTheme.SidebarItem = {
  text: "Reference",
  items: [
    { text: "Overview", link: "/reference/" },
    { text: "Service map", link: "/reference/service-map" },
    { text: "Contracts and bindings", link: "/reference/contracts" },
    { text: "Vault API", link: "/reference/vault-api" },
    { text: "Plans and decisions", link: "/reference/plans" },
  ],
};

const documentationSidebar: DefaultTheme.SidebarItem[] = [
  startHereSection,
  guidesSection,
  conceptsSection,
  operateSection,
  referenceSection,
];

export default defineConfig({
  base: "/",
  cleanUrls: true,
  appearance: true,
  lastUpdated: true,
  title: "Seams Pantry",
  titleTemplate: ":title · Seams Pantry",
  description:
    "Seams Pantry: the operating system for modern bakeries & cafés.",
  sitemap: {
    hostname: docsOrigin,
    transformItems: (items) =>
      items.filter((item) => item.url.replace(/^\//, "") !== "404"),
  },
  head: [
    [
      "link",
      { rel: "icon", href: "/brand/pantry-mark-dark-64.png", type: "image/png" },
    ],
    ["meta", { property: "og:site_name", content: "Seams Pantry docs" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { name: "twitter:card", content: "summary" }],
  ],
  transformHead({ page, title, description }) {
    const canonicalUrl = pageUrl(page);
    return [
      ["link", { rel: "canonical", href: canonicalUrl }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { property: "og:url", content: canonicalUrl }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
    ];
  },
  markdown: {
    theme: {
      light: "github-light",
      dark: "github-dark",
    },
    languageAlias: {
      caddy: "nginx",
    },
  },
  themeConfig: {
    siteTitle: "Seams Pantry docs",
    logo: {
      light: "/brand/pantry-mark-dark-64.png",
      dark: "/brand/pantry-mark-light-64.png",
      alt: "Seams Pantry",
    },
    logoLink: siteOrigin,
    lastUpdated: { text: "Last updated" },
    outline: [2, 3],
    search: { provider: "local" },
    nav: [
      { text: "Documentation", link: "/", activeMatch: "^/(?!reference)" },
      { text: "Reference", link: "/reference/", activeMatch: "^/reference/" },
    ],
    sidebar: documentationSidebar,
  },
  vite: {
    clearScreen: false,
    logLevel: "info",
    server: {
      host: "127.0.0.1",
      port: 3105,
      allowedHosts: [
        "docs.pantry.localhost",
        "localhost",
        "portal.localhost",
        "pta-m4.local",
      ],
    },
  },
});
