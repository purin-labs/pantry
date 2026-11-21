import React from "react";

type PublicDocument = "privacy" | "terms" | "deletion" | "contact";

type PublicDocumentDescriptor = {
  readonly document: PublicDocument;
  readonly title: string;
  readonly description: string;
};

const SUPPORT_EMAIL = "peita@protonmail.com";
const LAST_UPDATED = "August 27, 2026";

export function PublicDocumentsApp(props: {
  readonly pathname: string;
}): React.ReactNode {
  const descriptor = publicDocumentFromPath(props.pathname);
  if (descriptor === null) throw new Error("Public document route is invalid");
  document.title = `${descriptor.title} · Seams Pantry`;

  return (
    <div className="public-doc-shell">
      <a className="public-doc-skip" href="#document-content">
        Skip to content
      </a>
      <PublicDocumentHeader document={descriptor.document} />
      <main id="document-content" className="public-doc-main">
        <header className="public-doc-heading">
          <p className="public-doc-eyebrow">Seams Pantry policies</p>
          <h1>{descriptor.title}</h1>
          <p className="public-doc-summary">{descriptor.description}</p>
          <p className="public-doc-updated">Last updated {LAST_UPDATED}</p>
        </header>
        <article className="public-doc-article">
          {renderPublicDocument(descriptor.document)}
        </article>
      </main>
      <PublicDocumentFooter />
    </div>
  );
}

function publicDocumentFromPath(
  pathname: string,
): PublicDocumentDescriptor | null {
  switch (pathname.replace(/\/$/u, "")) {
    case "/docs/privacy":
      return {
        document: "privacy",
        title: "Privacy policy",
        description:
          "How Seams handles account, integration, and customer-support data.",
      };
    case "/docs/terms":
      return {
        document: "terms",
        title: "Terms of service",
        description:
          "The terms that apply when you access or use Seams Pantry.",
      };
    case "/docs/deletion":
      return {
        document: "deletion",
        title: "User-data deletion",
        description:
          "How to disconnect a service or ask us to delete your Seams Pantry data.",
      };
    case "/docs/contact":
      return {
        document: "contact",
        title: "Support and contact",
        description:
          "How to reach Seams about support, privacy, deletion, or security.",
      };
    default:
      return null;
  }
}

function PublicDocumentHeader(props: {
  readonly document: PublicDocument;
}): React.ReactNode {
  return (
    <header className="public-doc-header">
      <a
        className="public-doc-brand"
        href="/docs/privacy"
        aria-label="Seams Pantry policies home"
      >
        <img
          src="/brand/pantry-mark-dark-32.png"
          width="28"
          height="28"
          alt=""
        />
        <span>Seams Pantry</span>
      </a>
      <nav className="public-doc-nav" aria-label="Policies">
        <PublicDocumentLink
          href="/docs/privacy"
          label="Privacy"
          current={props.document === "privacy"}
        />
        <PublicDocumentLink
          href="/docs/terms"
          label="Terms"
          current={props.document === "terms"}
        />
        <PublicDocumentLink
          href="/docs/deletion"
          label="Deletion"
          current={props.document === "deletion"}
        />
        <PublicDocumentLink
          href="/docs/contact"
          label="Contact"
          current={props.document === "contact"}
        />
      </nav>
    </header>
  );
}

function PublicDocumentLink(props: {
  readonly href: string;
  readonly label: string;
  readonly current: boolean;
}): React.ReactNode {
  return (
    <a href={props.href} aria-current={props.current ? "page" : undefined}>
      {props.label}
    </a>
  );
}

function PublicDocumentFooter(): React.ReactNode {
  return (
    <footer className="public-doc-footer">
      <p>Seams Pantry is a software service that Seams operates from Japan.</p>
      <nav aria-label="Policy links">
        <a href="/docs/privacy">Privacy</a>
        <a href="/docs/terms">Terms</a>
        <a href="/docs/deletion">Deletion</a>
        <a href="/docs/contact">Contact</a>
      </nav>
    </footer>
  );
}

function renderPublicDocument(document: PublicDocument): React.ReactNode {
  switch (document) {
    case "privacy":
      return <PrivacyPolicy />;
    case "terms":
      return <TermsOfService />;
    case "deletion":
      return <DeletionInstructions />;
    case "contact":
      return <ContactPage />;
  }
}

function PrivacyPolicy(): React.ReactNode {
  return (
    <>
      <section>
        <h2>1. About this policy</h2>
        <p>
          This policy explains how Seams collects, uses, shares, retains, and
          deletes personal information when you visit the Seams Pantry portal,
          create a workspace, connect another service, or communicate with a
          business that uses Seams Pantry.
        </p>
        <p>
          A business using Seams Pantry controls the customer information it
          sends to the service. Seams processes that information for the
          business under its instructions. This policy also covers information
          Seams handles directly for portal users, support contacts, and website
          visitors.
        </p>
      </section>

      <section>
        <h2>2. Information we handle</h2>
        <ul>
          <li>
            <strong>Account and workspace information:</strong> names, email
            addresses, organisation details, roles, preferences, and sign-in
            records.
          </li>
          <li>
            <strong>Connected-service information:</strong> account identifiers,
            phone-number identifiers, permission grants, connection status, and
            encrypted credentials for services you choose to connect.
          </li>
          <li>
            <strong>Business and customer content:</strong> messages, orders,
            products, files, and other records that a workspace admits for an
            enabled Seams Pantry workflow.
          </li>
          <li>
            <strong>Usage and technical information:</strong> IP address,
            browser and device information, request metadata, security events,
            audit records, and diagnostic logs.
          </li>
          <li>
            <strong>Support information:</strong> the details you include when
            you contact us, along with the steps taken to investigate and
            resolve the request.
          </li>
        </ul>
        <p>
          We receive this information from you, your workspace administrator,
          connected services, and the devices or browsers used to access Seams
          Pantry.
        </p>
      </section>

      <section>
        <h2>3. WhatsApp customer-support data</h2>
        <p>
          When a business enables the WhatsApp integration, Seams receives new
          webhook-delivered text messages for the connected WhatsApp Business
          Platform number. Seams does not import earlier chats or browse the
          business&apos;s WhatsApp inbox.
        </p>
        <p>
          Seams temporarily stores the text needed for an open support Case for
          up to 24 hours after the customer&apos;s latest message. A proposed
          reply is deleted sooner after it is sent, rejected, replaced, or
          expires. WhatsApp continues to hold messages under Meta&apos;s own
          terms and policies.
        </p>
      </section>

      <section>
        <h2>4. How we use information</h2>
        <ul>
          <li>Provide, secure, maintain, and troubleshoot Seams Pantry.</li>
          <li>Authenticate users and enforce workspace permissions.</li>
          <li>Connect services and run the workflows a workspace enables.</li>
          <li>
            Create agent proposals and present them for human review where the
            workflow requires approval.
          </li>
          <li>
            Send service notices and respond to support, privacy, deletion, and
            security requests.
          </li>
          <li>
            Detect abuse, protect the service, meet legal obligations, and
            establish or defend legal claims.
          </li>
          <li>
            Understand reliability and improve Seams Pantry using aggregate or
            de-identified information where practical.
          </li>
        </ul>
        <p>
          Depending on the context and applicable law, we rely on performing our
          agreement with you, your consent, legal obligations, and legitimate
          interests such as service security and reliability.
        </p>
      </section>

      <section>
        <h2>5. Agent and inference processing</h2>
        <p>
          A workspace can assign an agent and an inference provider to an
          enabled workflow. Seams sends the minimum admitted content needed to
          that selected provider to produce a result. The provider may process
          information in other countries and under the workspace&apos;s
          agreement with that provider. Where Seams Pantry requires human
          approval, an agent proposal is not sent to a customer until an
          authorised person approves it.
        </p>
      </section>

      <section>
        <h2>6. When information is shared</h2>
        <p>
          We disclose information only as needed for the purposes in this
          policy, including to:
        </p>
        <ul>
          <li>
            Cloudflare, which provides hosting, network, database, storage, and
            security infrastructure.
          </li>
          <li>
            Services a workspace connects, such as Meta and WhatsApp, Slack,
            Google, Shopify, or Stripe.
          </li>
          <li>The inference provider selected for a workflow.</li>
          <li>
            Professional advisers, authorities, or other parties when required
            by law or needed to protect rights and safety.
          </li>
          <li>
            A successor in a merger, financing, reorganisation, or transfer of
            the service, subject to appropriate safeguards.
          </li>
        </ul>
        <p>We do not sell personal information.</p>
      </section>

      <section>
        <h2>7. Retention and deletion</h2>
        <p>
          Retention depends on the information and why it is needed. We keep
          account, configuration, transaction, security, and audit records while
          they are needed to provide the service, meet legal obligations,
          resolve disputes, and prevent abuse. Temporary workflow content is
          deleted under the shorter limits shown in the product and in this
          policy.
        </p>
        <p>
          You can disconnect a connected service or request deletion by
          following our{" "}
          <a href="/docs/deletion">user-data deletion instructions</a>. We may
          retain narrowly limited records when required by law, for security, or
          to document a completed transaction or deletion request.
        </p>
      </section>

      <section>
        <h2>8. Security</h2>
        <p>
          Seams uses technical and organisational safeguards designed to protect
          information, including encrypted transport, encrypted credentials and
          sensitive application data, access controls, organisation isolation,
          and audit records. No online service can guarantee absolute security.
          Please report suspected security issues through our{" "}
          <a href="/docs/contact">contact page</a>.
        </p>
      </section>

      <section>
        <h2>9. International processing</h2>
        <p>
          Seams and its service providers may process information in Japan, the
          United States, and other countries where they operate. Those countries
          may have different data-protection laws. We use contractual and
          technical safeguards where applicable.
        </p>
      </section>

      <section>
        <h2>10. Your choices and rights</h2>
        <p>
          Depending on where you live, you may have rights to access, correct,
          delete, restrict, or object to processing of personal information, and
          to receive a portable copy. You may also withdraw consent where
          processing relies on consent. Workspace users should first contact
          their workspace administrator. Anyone may contact us using the details
          below.
        </p>
        <p>
          We do not knowingly offer Seams Pantry directly to children under 18.
        </p>
      </section>

      <section>
        <h2>11. Changes and contact</h2>
        <p>
          We may update this policy as Seams Pantry changes. We will change the
          date above and provide additional notice when required by law.
          Questions and requests can be sent to{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </section>
    </>
  );
}

function TermsOfService(): React.ReactNode {
  return (
    <>
      <section>
        <h2>1. Agreement</h2>
        <p>
          These terms govern access to and use of Seams Pantry. By creating an
          account, accepting an invitation, connecting a service, or using Seams
          Pantry, you agree to these terms and the{" "}
          <a href="/docs/privacy">privacy policy</a>. If you use Seams Pantry
          for an organisation, you confirm that you have authority to bind that
          organisation.
        </p>
        <p>
          You must be at least 18 years old and legally able to enter this
          agreement.
        </p>
      </section>

      <section>
        <h2>2. The service</h2>
        <p>
          Seams Pantry helps businesses coordinate connected services, business
          records, agents, approvals, and customer-support workflows. Features
          may be experimental, limited, or changed as the service develops. The
          portal identifies controls and approval steps that apply to each
          enabled workflow.
        </p>
      </section>

      <section>
        <h2>3. Accounts and administrators</h2>
        <p>
          You must provide accurate information, protect your sign-in methods,
          and promptly tell us about suspected unauthorised access. Workspace
          owners and administrators control member access, connected services,
          agents, and workflow settings. You are responsible for actions taken
          through your account unless caused by a breach of these terms by
          $1Seams.
        </p>
      </section>

      <section>
        <h2>4. Connected services</h2>
        <p>
          Seams Pantry can interact with services you choose to connect. Your
          use of those services remains subject to their own terms, policies,
          availability, permissions, and charges. You authorise Seams to access
          and act on connected-service data only as needed to provide the
          workflows you enable. You can revoke that authority by disconnecting
          the service.
        </p>
        <p>
          Seams is not responsible for a connected service&apos;s content,
          decisions, outages, account restrictions, or changes to its APIs.
        </p>
      </section>

      <section>
        <h2>5. Agents and approvals</h2>
        <p>
          Agent outputs can be incomplete, inaccurate, or inappropriate. You
          must review outputs before relying on them or approving an external
          action. A visible approval control is a request for your judgement,
          not a guarantee that the proposed action is correct, lawful, or
          suitable for your business.
        </p>
        <p>
          You remain responsible for instructions, connected data, approved
          actions, customer communications, and decisions made using Seams
          Pantry.
        </p>
      </section>

      <section>
        <h2>6. Acceptable use</h2>
        <p>You may not use Seams Pantry to:</p>
        <ul>
          <li>
            Break the law, infringe rights, deceive people, or facilitate fraud
            or abuse.
          </li>
          <li>
            Send spam, unlawful marketing, harassment, or content prohibited by
            a connected service.
          </li>
          <li>
            Access data or systems without authority, bypass safeguards, or
            interfere with the service.
          </li>
          <li>
            Upload malware, exploit vulnerabilities, probe other organisations,
            or expose credentials.
          </li>
          <li>
            Use Seams Pantry for high-risk decisions where errors could cause
            death, serious injury, or denial of essential rights without
            qualified human oversight.
          </li>
        </ul>
        <p>
          You must have all notices, consents, and lawful authority needed for
          data you provide to Seams Pantry.
        </p>
      </section>

      <section>
        <h2>7. Content and intellectual property</h2>
        <p>
          You retain ownership of content you submit. You grant Seams a limited
          right to host, process, transmit, and display that content only to
          operate, secure, and support the service. You are responsible for
          ensuring that you have the rights needed to provide it.
        </p>
        <p>
          Seams Pantry and its software, branding, and documentation remain
          protected by applicable intellectual-property laws. These terms do not
          transfer ownership of Seams Pantry to you.
        </p>
      </section>

      <section>
        <h2>8. Fees</h2>
        <p>
          Pricing, usage limits, and payment terms shown in an order, plan, or
          workspace apply to the service you purchase. Connected services may
          charge you separately. Except where required by law or stated in an
          order, paid charges are non-refundable.
        </p>
      </section>

      <section>
        <h2>9. Availability and changes</h2>
        <p>
          We work to keep Seams Pantry available and secure, but the service may
          be interrupted. We may add, remove, or change features and limits.
          When a change materially reduces a paid service, we will provide
          reasonable notice where practical.
        </p>
      </section>

      <section>
        <h2>10. Suspension and termination</h2>
        <p>
          You may stop using Seams Pantry and request account deletion. We may
          restrict or suspend access when reasonably needed to protect Seams
          Pantry or others, respond to unlawful conduct, prevent abuse, address
          non-payment, or enforce these terms. We may terminate the service with
          reasonable notice unless urgent action is required.
        </p>
        <p>
          Provisions that by their nature should continue will survive
          termination, including payment obligations, ownership, disclaimers,
          liability limits, and dispute terms.
        </p>
      </section>

      <section>
        <h2>11. Disclaimers</h2>
        <p>
          To the extent permitted by law, Seams Pantry is provided “as is” and
          “as available.” We disclaim implied warranties of merchantability,
          fitness for a particular purpose, non-infringement, and uninterrupted
          or error-free operation. Nothing in these terms excludes a warranty or
          right that cannot lawfully be excluded.
        </p>
      </section>

      <section>
        <h2>12. Limitation of liability</h2>
        <p>
          To the extent permitted by law, Seams will not be liable for indirect,
          incidental, special, exemplary, or consequential loss, or for lost
          profits, revenue, goodwill, or data. The total liability of Seams
          arising from the service will not exceed the amount you paid for Seams
          Pantry in the 12 months before the event giving rise to the claim.
          These limits do not apply where liability cannot lawfully be limited.
        </p>
      </section>

      <section>
        <h2>13. Governing law</h2>
        <p>
          These terms are governed by the laws of Japan, without regard to
          conflict-of-law rules. The Tokyo District Court has exclusive
          jurisdiction as the court of first instance, except where applicable
          consumer law requires another forum.
        </p>
      </section>

      <section>
        <h2>14. Changes and contact</h2>
        <p>
          We may update these terms. We will change the date above and give
          additional notice for material changes when required. Continued use
          after an update takes effect means you accept the revised terms.
          Questions can be sent to{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </section>
    </>
  );
}

function DeletionInstructions(): React.ReactNode {
  return (
    <>
      <section>
        <h2>Request deletion</h2>
        <p>
          A Seams Pantry workspace owner or authorised administrator can request
          deletion of a workspace, connected-service data, or a specific
          integration. An individual can also ask about personal information
          Seams handles about them.
        </p>
        <ol>
          <li>
            Email{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}?subject=Seams%20data%20deletion%20request`}
            >
              {SUPPORT_EMAIL}
            </a>{" "}
            with the subject <strong>Seams data deletion request</strong>.
          </li>
          <li>
            Include your name, sign-in email, organisation and workspace name,
            and the data or connection you want deleted.
          </li>
          <li>
            For a WhatsApp request, include the business phone number or its
            last four digits. Never send an access token, password, app secret,
            or verification code.
          </li>
          <li>
            We will verify your identity and authority using the account or
            workspace records before acting on the request.
          </li>
        </ol>
        <p>
          We will acknowledge the request, explain its scope, and provide the
          expected completion timeline. If Seams processes the information for a
          business, we may direct the request to that business or confirm its
          instructions before deleting it.
        </p>
      </section>

      <section>
        <h2>Disconnect first when appropriate</h2>
        <p>
          A workspace administrator can use the Seams Pantry portal to disable
          or disconnect an integration. This stops new workflow processing and
          begins credential revocation or cleanup. Deleting a Seams Pantry
          connection does not delete the account or content held by the
          connected service.
        </p>
      </section>

      <section>
        <h2>What deletion covers</h2>
        <p>Depending on the verified request, deletion may include:</p>
        <ul>
          <li>Seams Pantry account and workspace profile information.</li>
          <li>
            Connected-service credentials, grants, identifiers, and
            configuration.
          </li>
          <li>Temporary Case content and agent proposals held by Seams.</li>
          <li>
            Workspace projections and other customer content held for the
            deleted service.
          </li>
          <li>
            Support materials that are no longer needed to complete the request.
          </li>
        </ul>
        <p>
          Seams may retain narrowly limited security, transaction, audit, or
          legal records when required by law, needed to prevent abuse, or
          necessary to document that a deletion was completed. Those records are
          restricted to their remaining purpose.
        </p>
      </section>

      <section>
        <h2>WhatsApp message data</h2>
        <p>
          Seams holds text for an open WhatsApp support Case for no longer than
          24 hours after the customer&apos;s latest message. A proposal is
          removed sooner after it is sent, rejected, replaced, or expires. A
          verified deletion request can trigger earlier cleanup when no security
          or legal obligation requires retention.
        </p>
        <p>
          This process removes data held by Seams. Messages and account
          information retained by Meta, WhatsApp, or another connected service
          remain subject to that provider&apos;s deletion tools and policies.
        </p>
      </section>

      <section>
        <h2>After completion</h2>
        <p>
          We will confirm when the request is complete or explain any
          information that must be kept and why. Deletion is irreversible after
          the applicable recovery and verification steps finish.
        </p>
      </section>
    </>
  );
}

function ContactPage(): React.ReactNode {
  return (
    <>
      <section>
        <h2>Contact Seams</h2>
        <p>
          Email{" "}
          <a className="public-doc-contact" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>{" "}
          for product support, privacy questions, data-deletion requests, legal
          notices, or security reports. Seams operates from Japan, and messages
          are handled in Japan Standard Time.
        </p>
      </section>

      <section>
        <h2>Help us respond</h2>
        <p>Please include:</p>
        <ul>
          <li>Your name and the email used with Seams Pantry.</li>
          <li>Your organisation and workspace name.</li>
          <li>A concise description of the issue and when it occurred.</li>
          <li>Any support reference shown in the portal.</li>
        </ul>
        <p>
          You may include screenshots after removing customer content and
          secrets. Never email access tokens, passwords, app secrets, recovery
          codes, or one-time verification codes.
        </p>
      </section>

      <section>
        <h2>Privacy and deletion</h2>
        <p>
          Put <strong>Privacy request</strong> or{" "}
          <strong>Seams data deletion request</strong> in the subject line. Read
          the <a href="/docs/privacy">privacy policy</a> and{" "}
          <a href="/docs/deletion">deletion instructions</a> for the information
          we need to verify and complete a request.
        </p>
      </section>

      <section>
        <h2>Security reports</h2>
        <p>
          Put <strong>Security report</strong> in the subject line. Describe the
          affected Seams Pantry URL or feature, the observed behaviour, and safe
          reproduction steps. Do not access another person&apos;s data, disrupt
          the service, or include live credentials in your report.
        </p>
      </section>
    </>
  );
}
