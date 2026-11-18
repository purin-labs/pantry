# Plan 21 — CafeOS UX Foundation

Status: complete · Closed: 2026-08-12 · Owner: Satyr portal

## Outcome

Plan 21 established one coherent merchant portal for café and restaurant
operations. The completed portal has:

- one canonical route descriptor for parsing, links, navigation, headings, and
  document titles;
- a persistent workspace shell with a collapsible desktop rail, compact drawer,
  workspace switcher, identity menu, and command palette;
- a server-owned Home brief for attention items, current operating facts, and
  workspace blockers;
- shared list, queue, detail, form, status, error, and technical-disclosure
  patterns;
- route-owned loading, refresh, failure, permission, and mutation state;
- merchant-readable Commerce, Operations, Agents, Integrations,
  and Workspace settings pages; and
- keyboard, responsive, reduced-motion, zoom, direct-load, and browser-history
  behavior across the workspace.

The implementation evidence is recorded in
[Plan 21 browser acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-21-browser-acceptance-2026-08-11.md).
Future interface changes follow [the portal style guide](./style-guide.md)
without reopening this plan.

## Ownership

Plan 21 owns merchant-facing navigation, labels, layout, shared page patterns,
and interaction behavior. It does not own domain lifecycle or provider effects.

| Boundary                                | Authority                     |
| --------------------------------------- | ----------------------------- |
| Agent and Case operations               | Plan 16                       |
| Commerce authority and provider effects | Plan 19                       |
| Capability-specific commerce operations | Plan 22                       |
| Portal presentation                     | Style guide and portal source |

## Product language

Use **Satyr CafeOS** for the merchant product and **SATYR** for the compact
mark. Use **workspace** in the interface and **organisation** only in code, routes,
APIs, diagnostics, and domain documentation.

| Interface term     | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| Home               | Daily operating brief                                          |
| Commerce           | Products, inventory, and customer orders                       |
| Operations         | Decisions, exceptions, and governed work                       |
| Agents             | Agent assignments, activity, and configuration                 |
| Integrations       | Commerce, payment, and communication connections               |
| Workspace settings | Members, roles, lifecycle, and administration                  |
| Customer order     | An order placed by a customer                                  |
| Technical details  | IDs, revisions, provider references, receipts, and diagnostics |

**Operations** is the route and page label. **Needs attention** names its active
queue. **Action center** is retired.

## Canonical information architecture

```text
Global
  Sign in                 /sign-in
  Workspaces              /portal

Workspace
  Home                    /portal/:organisationId

  Commerce
    Commerce overview     /portal/:organisationId/commerce
    Products              /portal/:organisationId/products
    Product detail        /portal/:organisationId/products/:productId
    Inventory             /portal/:organisationId/inventory
    Customer orders       /portal/:organisationId/orders
    Customer order detail /portal/:organisationId/orders/:orderId

  Automation
    Operations            /portal/:organisationId/operations
    Agents                /portal/:organisationId/agents

  Settings
    Integrations          /portal/:organisationId/integrations
    Workspace settings    /portal/:organisationId/settings
```

Plan 22 capability routes join Commerce navigation only when their capability
is active and the page has a useful operating path. Unknown workspace routes
render an in-shell not-found page.

## Interaction contract

- Stable workspace context remains mounted during child navigation.
- Home shows work before metrics.
- Merchant state and the next action appear before technical evidence.
- IDs, provider references, revisions, and receipts stay under **Technical
  details**.
- The browser renders typed server-owned views and available actions instead of
  inferring lifecycle or provider outcomes.
- Loading, failures, and mutation feedback stay beside the route or control
  that caused them.
- Each region has one primary action; destructive actions state their
  consequence.
- Navigation, forms, disclosures, and overlays remain keyboard-operable and
  preserve useful focus.
- Content reflows without losing navigation or primary actions.

## Source ownership

- `apps/portal/src/route.ts` owns workspace route metadata.
- `apps/portal/src/shell.tsx` and `console-sidebar.tsx` own the persistent shell.
- `apps/portal/src/page-content.ts` and `page-components.tsx` own shared page
  state and interaction contracts.
- `apps/portal/src/pages/` owns route-specific reads, mutations, and
  presentation.
- `apps/portal/src/styles.css` and `docs/style-guide.md` are the portal design
  contract.

## Deferred product scope

- configurable dashboards and analytics;
- merchant themes and dark mode;
- native desktop or mobile applications;
- role-specific route trees;
- scheduling, returns, and export navigation without an active domain plan;
  and
- end-user layout customization.
