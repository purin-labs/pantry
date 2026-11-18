import React from "react";
import { KeyRound, ListChecks, ScrollText } from "lucide-react";

/* ---------- bento band (control plane) ---------- */

function PreflightMock(): React.JSX.Element {
  return (
    <div
      className="h2-mockcard"
      role="img"
      aria-label="Preflight checks before an agent action"
    >
      <p className="h2-mockcard__title">
        Preflight checks: send discount offer
      </p>
      <div className="h2-mockrow">
        <span className="h2-mockrow__main">Credentials valid</span>
        <span className="h2-chip h2-chip--green">Pass</span>
      </div>
      <div className="h2-mockrow">
        <span className="h2-mockrow__main">Agent identity verified</span>
        <span className="h2-chip h2-chip--green">Pass</span>
      </div>
      <div className="h2-mockrow">
        <span className="h2-mockrow__main">Discount permission</span>
        <span className="h2-chip h2-chip--amber">Admin approval</span>
      </div>
      <div className="h2-mockbtns" aria-hidden>
        <span className="h2-mockbtn h2-mockbtn--approve">Approve</span>
        <span className="h2-mockbtn h2-mockbtn--cancel">Cancel</span>
      </div>
    </div>
  );
}

function ApprovalGateMock(): React.JSX.Element {
  return (
    <div
      className="h2-mockcard"
      role="img"
      aria-label="Approval gate requiring passkey"
    >
      <p className="h2-mockcard__title">Approval gate</p>
      <div className="h2-mockrow">
        <span className="h2-mockrow__main">
          Order inventory restock
          <small>¥180,000 · supplier: Kyoto Craft Co.</small>
        </span>
        <span className="h2-chip h2-chip--amber">Held</span>
      </div>
      <div className="h2-mockrow">
        <span className="h2-mockrow__main">
          Confirm with passkey
          <small>owner presence required</small>
        </span>
        <span className="h2-chip h2-chip--plain">Waiting</span>
      </div>
      <div className="h2-mockrow">
        <span className="h2-mockrow__main">
          Decision logged to audit trail
          <small>evidence retained</small>
        </span>
        <span className="h2-chip h2-chip--plain">Auto</span>
      </div>
    </div>
  );
}

export function H2Bento(): React.JSX.Element {
  return (
    <section
      className="h2-section h2-section--bento h2-rule"
      aria-labelledby="h2-bento-title"
    >
      <div className="h2-shell">
        <div className="h2-split-head">
          <p className="h2-kicker">Control plane</p>
          <h2 id="h2-bento-title" className="h2-display">
            Agents act only inside policy
          </h2>
          <p className="h2-split-head__copy">
            Every action from an agent or staff member runs through the same
            checks: permissions, limits, thresholds, expiry. Risky actions route
            to a human.
          </p>
        </div>
        <div className="h2-bento">
          <div className="h2-bento__card h2-bento__card--lg">
            <div className="h2-bento__visual">
              <PreflightMock />
            </div>
            <div>
              <h3 className="h2-bento__title">Checks before execution</h3>
              <p className="h2-bento__copy">
                The Seams harness verifies credentials, identity, and
                permissions before an action runs and emits a log either way.
              </p>
            </div>
          </div>
          <div className="h2-bento__card h2-bento__card--lg">
            <div className="h2-bento__visual">
              <ApprovalGateMock />
            </div>
            <div>
              <h3 className="h2-bento__title">
                Human approval where it matters
              </h3>
              <p className="h2-bento__copy">
                Funds, pricing, and public actions can require passkey or
                biometric confirmation from the owner before they go through.
              </p>
            </div>
          </div>
          <div className="h2-bento__card h2-bento__card--sm">
            <span
              className="h2-bento__icon h2-bento__icon--blue-red"
              aria-hidden
            >
              <ListChecks />
            </span>
            <div>
              <h3 className="h2-bento__title">Roles &amp; limits</h3>
              <p className="h2-bento__copy">
                Scope what support, ops, and agents can each do: amounts,
                actions, expiry.
              </p>
            </div>
          </div>
          <div className="h2-bento__card h2-bento__card--sm">
            <span
              className="h2-bento__icon h2-bento__icon--ember-moss"
              aria-hidden
            >
              <ScrollText />
            </span>
            <div>
              <h3 className="h2-bento__title">Audit trail</h3>
              <p className="h2-bento__copy">
                Every decision, allowed, held, or blocked, lands in an evidence
                trail you can export.
              </p>
            </div>
          </div>
          <div className="h2-bento__card h2-bento__card--sm">
            <span
              className="h2-bento__icon h2-bento__icon--sage-charcoal"
              aria-hidden
            >
              <KeyRound />
            </span>
            <div>
              <h3 className="h2-bento__title">Recovery built in</h3>
              <p className="h2-bento__copy">
                Accounts recover through email and linked devices: no seed
                phrases, no lockouts.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- workflows (canvas + use-case covers) ---------- */

const useCases = [
  {
    title: "Automate storefront ops",
    coverClass: "h2-case__cover--ops",
    coverLabel: "Storefront ops",
    copy: "Let an agent watch cart abandonment, inventory alerts, and support tickets, then follow up, prepare refunds, and update listings inside the limits you set.",
  },
  {
    title: "Delegate to staff safely",
    coverClass: "h2-case__cover--staff",
    coverLabel: "Staff delegation",
    copy: "Give part-time staff and contractors scoped credentials instead of shared logins. Limits and roles apply automatically; access expires on schedule.",
  },
  {
    title: "Agent checkout with mandates",
    coverClass: "h2-case__cover--checkout",
    coverLabel: "Agent checkout",
    copy: "Buyer-side agents purchase under signed mandates with per-week budgets: merchants see verified identity and a clean audit trail on every order.",
  },
];

export function H2WorkflowCanvas(): React.JSX.Element {
  return (
    <div className="h2-flow">
      <div
        className="h2-flow__canvas"
        role="img"
        aria-label="A storefront event flowing through preflight checks into a signed action"
      >
        <span className="h2-flow__tag">
          Seams Harness &middot; cart-recovery flow
        </span>
        <div className="h2-flow__row">
          <div className="h2-mockcard h2-flow__node h2-flow__node--first">
            <p className="h2-mockcard__title">Storefront event</p>
            <div className="h2-mockrow">
              <span className="h2-mockrow__main">
                Cart abandoned
                <small>3 items &middot; ¥12,400</small>
              </span>
              <span className="h2-chip h2-chip--plain">New</span>
            </div>
          </div>
          <span className="h2-flow__link" aria-hidden />
          <div className="h2-mockcard h2-flow__node">
            <p className="h2-mockcard__title">Preflight checks</p>
            <div className="h2-mockrow">
              <span className="h2-mockrow__main">Credentials valid</span>
              <span className="h2-chip h2-chip--green">Pass</span>
            </div>
            <div className="h2-mockrow">
              <span className="h2-mockrow__main">Agent identity</span>
              <span className="h2-chip h2-chip--green">Pass</span>
            </div>
            <div className="h2-mockrow">
              <span className="h2-mockrow__main">Discount 10%</span>
              <span className="h2-chip h2-chip--amber">Owner approval</span>
            </div>
          </div>
          <span className="h2-flow__link" aria-hidden />
          <div className="h2-mockcard h2-flow__node h2-flow__node--last">
            <p className="h2-mockcard__title">Action</p>
            <div className="h2-mockrow">
              <span className="h2-mockrow__main">
                Offer email sent
                <small>sig 0x8c31…f27</small>
              </span>
              <span className="h2-chip h2-chip--green">Signed</span>
            </div>
            <div className="h2-mockrow">
              <span className="h2-mockrow__main">Logged to audit trail</span>
              <span className="h2-chip h2-chip--plain">Auto</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function H2Cases(): React.JSX.Element {
  return (
    <section className="h2-section h2-rule" aria-labelledby="h2-cases-title">
      <div className="h2-shell">
        <div className="h2-split-head">
          <p className="h2-kicker">Workflows</p>
          <h2 id="h2-cases-title" className="h2-display">
            Turn store operations into governed workflows
          </h2>
          <p className="h2-split-head__copy">
            The Seams harness turns commerce events into policy-checked actions:
            agents watch the store, prepare responses, and act inside the limits
            you set, with human approval where it matters.
          </p>
        </div>

        <H2WorkflowCanvas />

        <div className="h2-cases">{useCases.map(renderUseCase)}</div>
      </div>
    </section>
  );
}

function renderUseCase(c: (typeof useCases)[number]): React.ReactNode {
  return (
    <div className="h2-case" key={c.title}>
      <div className={`h2-case__cover ${c.coverClass}`} aria-hidden="true">
        <span>{c.coverLabel}</span>
      </div>
      <h3 className="h2-case__title">{c.title}</h3>
      <p className="h2-case__copy">{c.copy}</p>
    </div>
  );
}
