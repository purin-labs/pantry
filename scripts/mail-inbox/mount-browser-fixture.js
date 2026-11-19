// Run with playwright-cli run-code against the Portal Vite server.
async function mountMailInbox(page) {
  await page.goto(new URL("/theme-preview.html", page.url()).href);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async function mount() {
    let reactUrl = null;
    let reactDomUrl = null;
    for (const resource of performance.getEntriesByType("resource")) {
      if (resource.name.includes("/deps/react.js?")) reactUrl = resource.name;
      if (resource.name.includes("/deps/react-dom_client.js?"))
        reactDomUrl = resource.name;
    }
    if (reactUrl === null || reactDomUrl === null) {
      throw new Error("The theme preview did not load React.");
    }
    const { default: React } = await import(reactUrl);
    const { default: ReactDOM } = await import(reactDomUrl);
    const { MailInboxRoute } =
      await import("/src/features/mail-inbox/route.tsx");
    // The Inbox renders in the Portal's own frame, as on the real page.
    const { PortalFrame } = await import("/src/shell.tsx");
    // The frame's router context must come from the same module instance.
    const router = performance
      .getEntriesByType("resource")
      .map(function name(entry) {
        return entry.name;
      })
      .find(function isRouter(name) {
        return name.includes("/node_modules/.vite/deps/react-router.js");
      });
    const { BrowserRouter } = await import(
      router ?? "/node_modules/.vite/deps/react-router.js"
    );
    // The Portal starts its commerce validators before any page, as here.
    const { initializeBrowserValidators } =
      await import("/@id/@purin-labs/commerce-contracts/browser-validators");
    await initializeBrowserValidators();
    const originalFetch = window.fetch.bind(window);
    document.cookie = "satyr_control_csrf=inbox-fixture; path=/";
    const draftBody =
      "Hi Mika,\n\nPlease confirm Friday arrival and the quantity. We need to check the impact on our pastry orders.\n\nCafeOS";
    const MAIL_SUPPLIERS = [
      { supplierId: "supplier_flour", name: "Hokkaido Flour Mill" },
      { supplierId: "supplier_packaging", name: "Packaging supplier" },
    ];
    // With `window.mailFixtureDrafts = "three"`, two more drafts wait: the
    // queue names each one, and each thread holds its mail and its draft.
    const EXTRA_DRAFTS = [
      {
        proposalId: "proposal_peita_reply",
        threadId: "thread-5",
        from: "Peita Lin <peita_lin@example.test>",
        sender: "Peita Lin",
        subject: "When will the 60 ginger financiers arrive?",
        receivedAt: Date.now() - 2 * 86_400_000,
        body: "Hello, when can I expect delivery of the 60 ginger financiers we purchased last weekend?",
        draft:
          "Hi Peita,\n\nThank you for your order of 60 ginger financiers. We ship online orders on Tuesdays and Fridays, and your box leaves our kitchen on Friday. We include a free handwritten card with every box.\n\nNini Patisserie order desk",
        // Sample sources. Each names the words of the draft it supports.
        sources: [
          {
            record: { kind: "order", orderId: "order_1042" },
            title: "Order #1042",
            detail: "60 × Ginger financier, placed Sun 11 Oct.",
            words: [
              "your order of 60 ginger financiers",
              "your box leaves our kitchen on Friday",
            ],
          },
          {
            record: {
              kind: "memory",
              memoryId: "memory_shipping_days",
              revision: 1,
            },
            title: "Fact",
            detail: "Online orders ship on Tuesday and Friday.",
            words: ["We ship online orders on Tuesdays and Fridays"],
          },
          {
            record: {
              kind: "memory",
              memoryId: "memory_gift_wrap",
              revision: 2,
            },
            title: "Preference",
            detail: "Wrap gift boxes in the autumn paper until November.",
            words: [],
          },
        ],
      },
      {
        proposalId: "proposal_mori_reply",
        threadId: "thread-6",
        from: "Ken · Café Mori <ken@cafe-mori.example>",
        sender: "Ken · Café Mori",
        subject: "40 more croissants on Tuesday",
        receivedAt: Date.now() - 2 * 3_600_000,
        body: "Morning! Could we go from 80 to 120 croissants on Tuesday? We have a group of 40 coming in.",
        draft:
          "Hi Ken,\n\nWe can do 120 croissants on Tuesday, on the usual 07:10 van.\n\nNini Patisserie",
      },
    ];
    /** The wire sources of a draft: each cited one numbered, with its spans. */
    function wireSources(draft) {
      let number = 0;
      return (draft.sources ?? []).map(function wire(source) {
        const cited = source.words.length > 0;
        if (cited) number += 1;
        return {
          number: cited ? number : null,
          record: source.record,
          title: source.title,
          detail: source.detail,
          spans: source.words.map(function span(words) {
            const start = draft.draft.indexOf(words);
            return { start, end: start + words.length };
          }),
        };
      });
    }
    function extraDrafts() {
      return window.mailFixtureDrafts === "three" ? EXTRA_DRAFTS : [];
    }
    function extraDraft(key, value) {
      return extraDrafts().find(function named(draft) {
        return draft[key] === value;
      });
    }
    function extraState(draft) {
      return (
        (window.mailExtraStates ?? {})[draft.proposalId] ?? "awaiting_approval"
      );
    }
    const organization = {
      rules: { kind: "empty", revision: 0, rules: [] },
      readiness: "ready",
      pending: 0,
      failed: 0,
      budgetPaused: 0,
      classifications: [],
    };
    /** The WhatsApp routes of a journey that sets `mailFixtureWhatsApp`. */
    function whatsappFixtureAnswer(url, init) {
      const state = window.mailFixtureWhatsAppState;
      if (state === undefined) return null;
      const list = window.mailFixtureWhatsApp;
      const update = function update(caseId, change) {
        list.conversations = list.conversations.map(function row(entry) {
          return entry.caseId === caseId ? { ...entry, ...change } : entry;
        });
      };
      const cases = url.pathname.match(
        /\/whatsapp-cases\/([^/]+)(?:\/([a-z-]+))?$/,
      );
      if (cases !== null) {
        const [, caseId, action] = cases;
        const current = state.cases[caseId];
        if (action === undefined)
          return Response.json({ ok: true, case: current });
        state.actions.push(`${action}:${caseId}`);
        if (action === "take-over") {
          current.ownership = { kind: "human_owned" };
          update(caseId, {
            ownership: "human_owned",
            state: "no_reply_yet",
            proposalId: null,
          });
        }
        if (action === "return-to-agent") {
          current.ownership = { kind: "agent_active" };
          update(caseId, { ownership: "agent_active", state: "agent_handled" });
        }
        if (action === "human-reply") {
          const body = JSON.parse(init.body);
          current.messages.push({
            direction: "outbound",
            occurredAt: Date.now(),
            providerMessageId: `wamid.person.${state.actions.length}`,
            text: body.body,
          });
          update(caseId, { state: "person_replied" });
          return Response.json({ ok: true, result: { kind: "sent" } });
        }
        return Response.json({ ok: true, result: { kind: "done" } });
      }
      const replies = url.pathname.match(
        /\/whatsapp-replies\/([^/]+)(?:\/([a-z-]+))?$/,
      );
      if (replies !== null) {
        const [, proposalId, action] = replies;
        const proposal = state.proposals[proposalId];
        if (action === undefined)
          return Response.json({
            ok: true,
            kind: "current",
            proposal: {
              proposal_id: proposalId,
              version: proposal.version,
              case_id: proposal.caseId,
              customer_wa_id: proposal.customerWaId,
              author: "agent",
              body: proposal.body,
              body_digest: "a".repeat(64),
              service_window_expires_at: proposal.serviceWindowExpiresAt,
              expires_at: proposal.serviceWindowExpiresAt,
            },
          });
        const body = JSON.parse(init.body);
        state.actions.push(`${action}:${proposalId}:${body.version ?? ""}`);
        if (action === "edit") {
          proposal.body = body.body;
          proposal.version += 1;
          return Response.json({ ok: true, result: { kind: "versioned" } });
        }
        if (action === "approve") {
          state.cases[proposal.caseId].messages.push({
            direction: "outbound",
            occurredAt: Date.now(),
            providerMessageId: `wamid.sent.${state.actions.length}`,
            text: proposal.body,
          });
          update(proposal.caseId, { proposalId: null, state: "agent_handled" });
          return Response.json({ ok: true, result: { kind: "sent" } });
        }
        update(proposal.caseId, { proposalId: null, state: "no_reply_yet" });
        return Response.json({ ok: true, result: { kind: "done" } });
      }
      if (
        url.pathname.endsWith("/whatsapp-accounts") &&
        (init?.method ?? "GET") === "GET"
      )
        return Response.json({
          ok: true,
          application_configured: true,
          accounts: [state.account],
        });
      if (url.pathname.match(/\/whatsapp-accounts\/[^/]+\/policy$/)) {
        const body = JSON.parse(init.body);
        state.actions.push(`agent:${body.agent.agentMode}`);
        state.account.policy = { ...state.account.policy, ...body.agent };
        return Response.json({ ok: true });
      }
      return null;
    }
    window.fetch = async function transport(input, given) {
      // The Portal's reads send no method: fetch then uses GET.
      const init = { method: "GET", ...given };
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.endsWith("/assistant")) {
        if (init.method === "GET")
          return Response.json({
            kind: "ready",
            model: "Workspace model",
            recipient: "openrouter",
            modelRouteDigest: "0".repeat(64),
          });
        const command = JSON.parse(init.body);
        window.mailAssistantCommands = [
          ...(window.mailAssistantCommands ?? []),
          command,
        ];
        if (window.mailAssistantBlock)
          await new Promise(function delay(resolve) {
            window.releaseMailAssistant = resolve;
          });
        if (command.kind === "proposeRule")
          return Response.json({
            kind: "ruleProposal",
            rule: {
              kind: "categorize",
              ruleId: "rule_assistant_fixture",
              category: "Suppliers",
              instruction:
                "Suppliers reporting delivery delays that may affect planned orders",
            },
          });
        return Response.json({
          kind: "explanation",
          text: "The supplier reports a delivery delay. That relates to the saved criterion; this is a reconstruction using current evidence.",
          evidence: "current",
        });
      }
      if (url.pathname.endsWith("/organization")) {
        if (init.method === "GET") {
          if (url.pathname.includes("/mailbox-b/"))
            return Response.json({
              ...organization,
              rules: { kind: "empty", revision: 0, rules: [] },
              classifications: [],
            });
          const selected = url.searchParams.getAll("messageId");
          return Response.json({
            ...organization,
            classifications: organization.classifications.filter(
              function selectedResult(result) {
                return selected.includes(result.messageId);
              },
            ),
          });
        }
        const command = JSON.parse(init.body);
        window.mailOrganizationCommands = [
          ...(window.mailOrganizationCommands ?? []),
          command,
        ];
        if (command.kind === "preview")
          return Response.json({
            kind: "preview",
            classifications: command.rules.map(function result(rule) {
              return {
                messageId: "message-1",
                threadId: "thread-1",
                ruleId: rule.ruleId,
                outcome: "matched",
                source: "jev",
                evaluatedAt: Date.now(),
              };
            }),
          });
        if (command.kind === "publish")
          organization.rules = {
            kind: "published",
            revision: organization.rules.revision + 1,
            rules: command.rules,
            activatedAt: Date.now(),
          };
        if (command.kind === "classify")
          // Seed a second existing projection outside the loaded Gmail page.
          organization.classifications = organization.rules.rules.flatMap(
            function result(rule) {
              const current = {
                messageId: "message-1",
                threadId: "thread-1",
                ruleId: rule.ruleId,
                outcome: "matched",
                source: "jev",
                evaluatedAt: Date.now(),
              };
              return [
                current,
                { ...current, messageId: "message-2", threadId: "thread-2" },
              ];
            },
          );
        if (command.kind === "pause")
          organization.rules = {
            kind: "paused",
            revision: organization.rules.revision + 1,
            rules: organization.rules.rules,
            activatedAt: organization.rules.activatedAt,
          };
        if (command.kind === "correct")
          for (const result of organization.classifications)
            if (
              result.ruleId === command.ruleId &&
              result.messageId === command.messageId
            ) {
              result.outcome = command.outcome;
              result.source = "operator";
            }
        return Response.json({ kind: "accepted" });
      }
      const extraReply = url.pathname.includes("/email-replies/")
        ? extraDraft(
            "proposalId",
            url.pathname.split("/email-replies/")[1].split("/")[0],
          )
        : undefined;
      if (extraReply !== undefined) {
        if (init?.method !== "POST")
          return Response.json({
            ok: true,
            kind: "current",
            proposal: {
              proposal_id: extraReply.proposalId,
              version: 1,
              body_edited: false,
              to: extraReply.from.replace(/^.*<|>$/g, ""),
              subject: `Re: ${extraReply.subject}`,
              gmail_thread_id: extraReply.threadId,
              body: extraReply.draft,
              snapshot_digest: "e".repeat(64),
              expires_at: Date.now() + 86_400_000,
            },
            challenge: "review-fixture-challenge",
            memory: [],
            sources: wireSources(extraReply),
          });
        const action = url.pathname.split("/").at(-1);
        window.mailReviewCommands = [
          ...(window.mailReviewCommands ?? []),
          {
            action,
            body: JSON.parse(init.body),
            proposalId: extraReply.proposalId,
          },
        ];
        window.mailExtraStates = {
          ...(window.mailExtraStates ?? {}),
          [extraReply.proposalId]: action === "approve" ? "sent" : "rejected",
        };
        return Response.json({
          ok: true,
          kind: window.mailExtraStates[extraReply.proposalId],
        });
      }
      if (url.pathname.includes("/email-replies/")) {
        if (window.mailWorkBlock)
          await new Promise(function delay(resolve) {
            window.releaseMailWork = resolve;
          });
        if (window.mailWorkDenied)
          return Response.json(
            { error: "email_reply_not_found" },
            { status: 404 },
          );
        if (init.method !== "POST") {
          window.mailDraftReads = (window.mailDraftReads ?? 0) + 1;
          return Response.json({
            ok: true,
            kind: "current",
            proposal: {
              proposal_id: "proposal_supplier_reply",
              version: window.mailDraftVersion ?? 2,
              body_edited: window.mailDraftVersion === undefined,
              to: "mika@packaging.example",
              subject: "Re: Packaging delivery delayed — Friday arrival",
              gmail_thread_id: "thread-1",
              body: window.mailDraftBody ?? draftBody,
              snapshot_digest: (window.mailDraftDigest ?? "b").repeat(64),
              expires_at: 1790730000000,
            },
            challenge: "review-fixture-challenge",
            memory: [
              {
                memory_id: "memory_packaging_notice",
                revision: 1,
                statement: "Packaging orders need two working days of notice.",
              },
            ],
            sources: [
              {
                number: null,
                record: {
                  kind: "memory",
                  memoryId: "memory_packaging_notice",
                  revision: 1,
                },
                title: "Fact",
                detail: "Packaging orders need two working days of notice.",
                spans: [],
              },
            ],
          });
        }
        const action = url.pathname.split("/").at(-1);
        window.mailReviewCommands = [
          ...(window.mailReviewCommands ?? []),
          { action, body: JSON.parse(init.body) },
        ];
        if (window.mailReviewStale)
          return Response.json(
            { error: "email_reply_approval_stale" },
            { status: 409 },
          );
        const command = JSON.parse(init.body);
        if (action === "draft-save") {
          if (typeof window.saveMailReplyDraft !== "function")
            return Response.json(
              { error: "shared_draft_fixture_unavailable" },
              { status: 503 },
            );
          const saved = await window.saveMailReplyDraft();
          window.mailDraftBody = saved.body;
          window.mailDraftVersion = saved.version;
          window.mailDraftDigest = "c";
          window.mailReplyState = "awaiting_approval";
          return Response.json({ ok: true, kind: "saved" });
        }
        if (action === "relationship") {
          if (window.mailCorrectionUnavailable)
            return Response.json(
              { error: "email_relationship_unavailable" },
              { status: 409 },
            );
          if (command.kind === "suppliers")
            return Response.json({
              kind: "suppliers",
              suppliers: [
                {
                  entryId: "supplier-entry",
                  supplierId: "supplier_packaging",
                  displayName: "Packaging supplier",
                },
              ],
            });
          return Response.json({
            kind: "purchase_request",
            supplierEntryId: command.supplierEntryId,
            supplierId: "supplier_packaging",
            supplierName: "Packaging supplier",
            purchaseRequestEntryId: "request-entry",
            purchaseRequestId: command.purchaseRequestId,
            merchantRevision: 7,
            facts: [
              { label: "status", value: "late" },
              { label: "required quantity", value: "20" },
            ],
            version: window.mailDraftVersion ?? 2,
            snapshotDigest: (window.mailDraftDigest ?? "b").repeat(64),
            relationshipDigest: "a".repeat(64),
            challenge: "correction-fixture-challenge",
          });
        }
        if (action === "correct" && window.mailCorrectionUnconfirmed)
          return Response.json(
            { error: "email_relationship_save_unconfirmed" },
            { status: 409 },
          );
        if (action === "edit" || action === "correct") {
          window.mailDraftVersion = (window.mailDraftVersion ?? 2) + 1;
          window.mailDraftBody = command.body;
          window.mailDraftDigest = action === "edit" ? "c" : "d";
          window.mailReplyState = "awaiting_approval";
          return Response.json({
            ok: true,
            kind: action === "edit" ? "edited" : "corrected",
            version: window.mailDraftVersion,
          });
        }
        if (action === "approve") window.mailReplyState = "send_indeterminate";
        if (action === "reject") window.mailReplyState = "rejected";
        if (action === "resolve" && window.mailReviewFound)
          window.mailReplyState = "sent";
        return Response.json({
          ok: true,
          kind:
            action === "resolve" && !window.mailReviewFound
              ? "unresolved"
              : window.mailReplyState,
        });
      }
      // Plan 83: the WhatsApp reads and actions, on a journey's own state.
      const whatsappAnswer = whatsappFixtureAnswer(url, init);
      if (whatsappAnswer !== null) return whatsappAnswer;
      if (url.pathname.endsWith("/person-reply")) {
        const sent = JSON.parse(init.body);
        window.mailPersonReplies = [...(window.mailPersonReplies ?? []), sent];
        window.mailFixtureUnanswered = (
          window.mailFixtureUnanswered ?? []
        ).filter(function other(thread) {
          return thread.threadId !== sent.threadId;
        });
        return Response.json({
          ok: true,
          result: { kind: "sent", providerMessageId: "person-sent-1" },
        });
      }
      // The one Inbox reads both sources from one route. Email is the same
      // queue, and a journey sets `window.mailFixtureWhatsApp` for WhatsApp.
      if (url.pathname.endsWith("/inbox-conversations")) {
        const queue = await window.fetch(
          url.href.replace("/inbox-conversations", "/email-reviews"),
          { credentials: "same-origin" },
        );
        const { reviews } = await queue.json();
        return Response.json({
          ok: true,
          email: window.mailFixtureEmailFailed
            ? { kind: "failed" }
            : {
                kind: "read",
                reviews,
                unanswered: window.mailFixtureUnanswered ?? [],
              },
          whatsapp: window.mailFixtureWhatsApp ?? { kind: "none" },
        });
      }
      if (url.pathname.endsWith("/email-reviews")) {
        // The queue names the proposal, its thread and, while it waits, the
        // mail that it answers. It stores no content.
        const waits =
          (window.mailReplyState ?? "awaiting_approval") ===
          "awaiting_approval";
        return Response.json({
          ok: true,
          reviews: [
            {
              kind: "gmail_reply",
              proposal_id: "proposal_supplier_reply",
              integration_account_id: "mailbox-a",
              case_id: "case_supplier_delivery",
              version:
                window.mailDraftVersion ?? (window.mailReplyState ? 2 : 1),
              lifecycle_kind: window.mailReplyState ?? "awaiting_approval",
              created_at: 1790726400000,
              updated_at: 1790726400000,
              backing: { kind: "gmail_draft", gmail_thread_id: "thread-1" },
              headline:
                waits && window.mailQueueHeadlines !== false
                  ? {
                      sender_name: "Mika · Packaging supplier",
                      subject: "Packaging delivery delayed — Friday arrival",
                      received_at: 1790726400000,
                    }
                  : null,
            },
            ...extraDrafts().map(function review(draft) {
              const state = extraState(draft);
              return {
                kind: "gmail_reply",
                proposal_id: draft.proposalId,
                integration_account_id: "mailbox-a",
                case_id: `case_${draft.proposalId}`,
                version: 1,
                lifecycle_kind: state,
                created_at: draft.receivedAt + 60_000,
                updated_at: draft.receivedAt + 60_000,
                backing: {
                  kind: "gmail_draft",
                  gmail_thread_id: draft.threadId,
                },
                headline:
                  state === "awaiting_approval"
                    ? {
                        sender_name: draft.sender,
                        subject: draft.subject,
                        received_at: draft.receivedAt,
                      }
                    : null,
              };
            }),
          ],
        });
      }
      // The Inbox turn-on sheet reads the mailbox's setup. Everything is in
      // place, so its one action turns the mailbox on.
      if (url.pathname.endsWith("/setup") && (init?.method ?? "GET") === "GET")
        return Response.json({
          ok: true,
          setup: {
            agent: {
              choice: {
                kind: "installation",
                installationId: "installation_fixture",
              },
              name: "Purchasing agent",
              state: "assigned",
            },
            requirements: [
              "agent",
              "reply_drafts",
              "agent_context",
              "review",
              "model",
            ].map(function met(id) {
              return { id, state: "met" };
            }),
            next: null,
            model: { kind: "approved" },
          },
        });
      // The supplier that a sender of the mailbox is linked to.
      if (url.pathname.endsWith("/sender-links/read")) {
        window.mailSenderLinkReads = [
          ...(window.mailSenderLinkReads ?? []),
          JSON.parse(init.body).address,
        ];
        if (window.mailSenderLinkUnreadable)
          return Response.json(
            { ok: false, error: "mailbox_sender_link_unavailable" },
            { status: 503 },
          );
        return Response.json({
          ok: true,
          link: window.mailSenderLink ?? { supplier: null, revision: 0 },
        });
      }
      if (url.pathname.endsWith("/sender-links")) {
        const command = JSON.parse(init.body);
        window.mailSenderLinkCommands = [
          ...(window.mailSenderLinkCommands ?? []),
          command,
        ];
        const current = window.mailSenderLink ?? {
          supplier: null,
          revision: 0,
        };
        if (command.expectedRevision !== current.revision)
          return Response.json(
            { ok: false, error: "mailbox_sender_link_changed" },
            { status: 409 },
          );
        const supplier = MAIL_SUPPLIERS.find(function chosen(entry) {
          return entry.supplierId === command.supplierId;
        });
        if (supplier === undefined)
          return Response.json(
            { ok: false, error: "mailbox_sender_supplier_missing" },
            { status: 404 },
          );
        window.mailSenderLink = {
          supplier: { supplierId: supplier.supplierId, name: supplier.name },
          revision: current.revision + 1,
        };
        return Response.json({ ok: true, link: window.mailSenderLink });
      }
      // The Suppliers page's directory, read for the supplier choice.
      if (url.pathname.endsWith("/commerce/graph")) {
        window.mailSupplierReads = (window.mailSupplierReads ?? 0) + 1;
        if (window.mailSupplierReadDelay)
          await new Promise(function waitForSuppliers(resolve) {
            window.releaseMailSuppliers = resolve;
          });
        if (window.mailSupplierReadFailure)
          return Response.json(
            { ok: false, error: "supplier_read_unavailable" },
            { status: 503 },
          );
        // A workspace without purchasing has no supplier directory to read.
        if (window.mailPurchasingOff)
          return Response.json(
            { ok: false, error: "commerce_query_surface_unsupported" },
            { status: 422 },
          );
        const suppliers = window.mailNoSuppliers ? [] : MAIL_SUPPLIERS;
        const scope = {
          kind: "custom",
          entityTypeId: "trade_partner",
          typeRevision: 1,
        };
        return Response.json({
          ok: true,
          result: {
            merchantRevision: 12,
            entities: suppliers.map(function entity(supplier) {
              return {
                reference: {
                  origin: "custom",
                  typeId: "trade_partner",
                  entityId: supplier.supplierId,
                },
                revision: 1,
                displayName: supplier.name,
                attributes: [
                  {
                    attributeId: "legal_name",
                    scope,
                    definitionRevision: 1,
                    sensitivity: "internal",
                    value: { kind: "short_text", value: supplier.name },
                  },
                ],
                typeRevision: 1,
                state: { state: "active" },
                sensitivity: "internal",
              };
            }),
            relationships: [],
            listEntries: suppliers.map(function entry(supplier) {
              return {
                entryId: `entry_${supplier.supplierId}`,
                listId: "supplier_directory",
                listRevision: 1,
                entityRef: {
                  origin: "custom",
                  typeId: "trade_partner",
                  entityId: supplier.supplierId,
                },
                attributeValues: [],
                revision: 1,
              };
            }),
            aggregations: [],
            nextCursor: null,
            provenance: [],
            freshness: [],
          },
        });
      }
      // Refresh asks Gmail for new mail while the agent is on.
      if (url.pathname.endsWith("/check") && init?.method === "POST") {
        window.mailChecks = (window.mailChecks ?? 0) + 1;
        return Response.json({ kind: "scheduled", at: Date.now() + 30_000 });
      }
      if (url.pathname.includes("/agent-mailboxes/")) {
        if (init.method === "POST") {
          window.mailAgentCommands = [
            ...(window.mailAgentCommands ?? []),
            url.pathname.split("/").at(-1),
          ];
          window.mailAgentFixture = "on";
          return Response.json({ ok: true });
        }
        if (window.mailAgentFixture === "unreadable")
          return Response.json(
            { error: "agent_mailbox_not_connected" },
            { status: 404 },
          );
        const off = window.mailAgentFixture === "off";
        const paused = window.mailAgentFixture === "paused";
        return Response.json({
          ok: true,
          mailbox: {
            integration_account_id: url.pathname.split("/").at(-1),
            observed_address: "purchasing@cafeos.example",
            connection_lifecycle: "active",
            authorization: null,
            binding: off
              ? null
              : {
                  mailbox_binding_id: "binding_fixture",
                  current_revision: 1,
                  installation_id: "installation_fixture",
                  response_policy: "cue_routed",
                },
            policy: off
              ? { kind: "disabled_by_default" }
              : {
                  kind: "enabled",
                  policyVersion: 1,
                  maxActiveCases: 5,
                  maxMessagesPerHour: 30,
                  dailyTokenBudget: 200000,
                  maxMessageBytes: 1000000,
                  maxAttachmentBytes: 5000000,
                },
            runtime: off
              ? null
              : {
                  policy_version: 1,
                  processing: paused
                    ? {
                        kind: "paused",
                        reason: {
                          kind: "active_case_limit",
                          observed: 5,
                          limit: 5,
                        },
                        pausedAt: 1790726400000,
                      }
                    : { kind: "waiting" },
                  accepted_history_id: "1001",
                  watch_expires_at: null,
                  usage: {
                    active_cases: paused ? 5 : 1,
                    admitted_last_hour: 1,
                    tokens_reserved: 0,
                    tokens_consumed: 0,
                    next_evaluation_at: null,
                  },
                },
          },
        });
      }
      if (!url.pathname.endsWith("/mail-inbox"))
        return originalFetch(input, init);
      if (init.method === "GET")
        return Response.json({
          kind: "accounts",
          accounts: [
            {
              integrationAccountId: "mailbox-a",
              displayName: "Purchasing · CafeOS",
              access: "readable",
            },
            {
              integrationAccountId: "mailbox-b",
              displayName: "Events · CafeOS",
              access: "readable",
            },
          ],
        });
      const command = JSON.parse(init.body);
      const extraThread =
        command.threadId === undefined
          ? undefined
          : extraDraft("threadId", command.threadId);
      if (extraThread !== undefined && command.kind === "work")
        return Response.json({
          kind: "work",
          threadId: command.threadId,
          work: {
            kind: "linked",
            caseId: `case_${extraThread.proposalId}`,
            revision: 1,
            state: { kind: "waiting", reason: "approval" },
            assignments: [],
            replies: [
              {
                proposalId: extraThread.proposalId,
                version: 1,
                createdAt: extraThread.receivedAt + 60_000,
                expiresAt: Date.now() + 86_400_000,
                state:
                  extraState(extraThread) === "sent"
                    ? {
                        kind: "sent",
                        providerMessageId: `gmail_${extraThread.proposalId}`,
                        sentAt: Date.now(),
                      }
                    : { kind: extraState(extraThread) },
              },
            ],
            moreAssignments: false,
            moreReplies: false,
          },
        });
      if (extraThread !== undefined && command.kind === "thread") {
        const received = {
          messageId: `${extraThread.threadId}-message`,
          threadId: extraThread.threadId,
          from: extraThread.from,
          subject: extraThread.subject,
          receivedAt: extraThread.receivedAt,
          unread: true,
          body: extraThread.body,
          attachmentNames: [],
        };
        const messages = [received];
        if (extraState(extraThread) !== "rejected")
          messages.push({
            ...received,
            messageId: `${extraThread.threadId}-draft`,
            from: "CafeOS purchasing <purchasing@cafeos.example>",
            subject: `Re: ${extraThread.subject}`,
            receivedAt: extraThread.receivedAt + 60_000,
            unread: false,
            body: `${extraThread.draft}\r\n`,
          });
        return Response.json({
          kind: "thread",
          threadId: command.threadId,
          messages,
        });
      }
      if (command.kind === "work") {
        if (window.mailWorkDenied)
          return Response.json(
            { error: "mail_inbox_not_found" },
            { status: 404 },
          );
        return Response.json({
          kind: "work",
          threadId: command.threadId,
          work:
            command.threadId === "thread-1"
              ? {
                  kind: "linked",
                  caseId: "case_supplier_delivery",
                  revision: 4,
                  state: { kind: "waiting", reason: "approval" },
                  assignments: [
                    {
                      kind: "failed",
                      assignmentId: "assignment_supplier_investigation",
                      startedAt: 1790726400000,
                      settledAt: 1790726460000,
                    },
                  ],
                  replies: [
                    {
                      proposalId: "proposal_supplier_reply",
                      version:
                        window.mailDraftVersion ??
                        (window.mailReplyState ? 2 : 1),
                      createdAt: 1790726400000,
                      expiresAt: 1790730000000,
                      state:
                        window.mailReplyState === "sent"
                          ? {
                              kind: "sent",
                              providerMessageId: "gmail_reviewed_receipt",
                              sentAt: Date.now(),
                            }
                          : window.mailReplyState === "send_indeterminate"
                            ? {
                                kind: "send_indeterminate",
                                rfcMessageId:
                                  "<fixture-version-2@example.test>",
                              }
                            : {
                                kind:
                                  window.mailReplyState ?? "awaiting_approval",
                              },
                    },
                    {
                      proposalId: "proposal_prior_reply",
                      version: 1,
                      createdAt: 1790640000000,
                      expiresAt: 1790643600000,
                      state: {
                        kind: "sent",
                        providerMessageId: "gmail_confirmed_prior_reply",
                        sentAt: 1790640060000,
                      },
                    },
                  ],
                  moreAssignments: false,
                  moreReplies: false,
                }
              : { kind: "unlinked" },
        });
      }
      if (command.integrationAccountId === "mailbox-b")
        return Response.json({ kind: "page", messages: [], nextCursor: null });
      // Gmail's Spam holds one order that Gmail took for spam.
      if (command.kind === "spamPage") {
        window.mailSpamReads = (window.mailSpamReads ?? 0) + 1;
        return Response.json({
          kind: "page",
          messages:
            command.cursor === null
              ? [
                  {
                    messageId: "spam-message-1",
                    threadId: "18f2a9c0d1e2f3a4",
                    from: "Ana Ruiz <ana@hotel-example.test>",
                    subject: "Order for 40 gift boxes",
                    receivedAt: 1790726400000,
                    unread: true,
                  },
                ]
              : [],
          nextCursor: null,
        });
      }
      if (command.query === "error")
        return Response.json(
          { error: "mail_inbox_unavailable" },
          { status: 503 },
        );
      const message = {
        messageId: "message-1",
        threadId: "thread-1",
        from: "Mika · Packaging supplier <orders@packaging.example>",
        subject: "Packaging delivery delayed — Friday arrival",
        receivedAt: 1790726400000,
        unread: true,
      };
      const older = {
        ...message,
        messageId: "message-2",
        threadId: "thread-2",
        subject: "Bakery ingredients delivery — confirmed",
        receivedAt: message.receivedAt - 86_400_000,
      };
      if (command.kind === "classifiedPage") {
        const selected = command.cursor === null ? message : older;
        const matches = organization.classifications.some(
          function matchesFilter(result) {
            if (
              result.messageId !== selected.messageId ||
              result.outcome !== "matched"
            )
              return false;
            return organization.rules.rules.some(function matchesRule(rule) {
              return (
                rule.ruleId === result.ruleId &&
                (command.filter.kind === "important"
                  ? rule.kind === "prioritize"
                  : rule.ruleId === command.filter.ruleId)
              );
            });
          },
        );
        return Response.json({
          kind: "page",
          messages: matches ? [selected] : [],
          nextCursor: command.cursor === null ? "classified-next" : null,
        });
      }
      if (command.kind === "decision") {
        const classification = organization.classifications.find(
          function selectedResult(result) {
            return (
              result.messageId === command.messageId &&
              result.ruleId === command.ruleId
            );
          },
        );
        const rule = organization.rules.rules.find(function selectedRule(rule) {
          return rule.ruleId === command.ruleId;
        });
        return Response.json({
          kind: "decision",
          decision: {
            classification,
            rule,
            evidence: command.messageId === "message-2" ? "changed" : "current",
          },
        });
      }
      // With `window.mailFixtureOtherMail`, more mail is on the first page.
      // Each message holds its own body and opens as a thread of one.
      const otherMail = window.mailFixtureOtherMail ?? [];
      const otherThread = otherMail.find(function isThread(other) {
        return other.threadId === command.threadId;
      });
      if (command.kind === "thread" && otherThread !== undefined)
        return Response.json({
          kind: "thread",
          threadId: command.threadId,
          messages: [{ ...otherThread, attachmentNames: [] }],
        });
      if (command.kind === "thread") {
        const received = {
          ...(command.threadId === "thread-1" ? message : older),
          body: 'Hello CafeOS,\n\nYour pastry boxes will arrive on Friday instead of Thursday. Can you confirm the revised delivery window?\n\nMika\n\n<img src="https://example.test/tracker">',
          attachmentNames: ["delivery-note.pdf"],
        };
        if (command.threadId !== "thread-1")
          return Response.json({
            kind: "thread",
            threadId: command.threadId,
            messages: [received],
          });
        window.mailThreadReads = (window.mailThreadReads ?? 0) + 1;
        // Gmail lists the mailbox's own mail in a thread, and its draft too.
        // The read carries no label that tells them apart.
        const own = {
          ...message,
          from: "CafeOS purchasing <purchasing@cafeos.example>",
          subject: "Re: Packaging delivery delayed — Friday arrival",
          unread: false,
          attachmentNames: [],
        };
        const messages = [
          received,
          {
            ...own,
            messageId: "message-acknowledgement",
            receivedAt: message.receivedAt + 60_000,
            body: "Thanks for your email. We've received your message and will get back to you shortly.\r\n",
          },
        ];
        if (window.mailReplyState !== "rejected")
          messages.push({
            ...own,
            messageId:
              window.mailReplyState === "sent"
                ? "gmail_reviewed_receipt"
                : `draft-version-${window.mailDraftVersion ?? 2}`,
            receivedAt: message.receivedAt + 120_000,
            body: `${window.mailDraftBody ?? draftBody}\r\n`,
          });
        return Response.json({
          kind: "thread",
          threadId: command.threadId,
          messages,
        });
      }
      if (command.cursor !== null || command.query === "empty")
        return Response.json({ kind: "page", messages: [], nextCursor: null });
      return Response.json({
        kind: "page",
        messages: [
          message,
          ...otherMail.map(function listed(other) {
            const { body, ...summary } = other;
            return summary;
          }),
        ],
        nextCursor: "fixture-next",
      });
    };
    document.getElementById("root").remove();
    const host = document.createElement("div");
    document.body.append(host);
    window.mailInboxFixtureRoot = ReactDOM.createRoot(host);
    // Mounts the Inbox again, for another person or another fixture. A new
    // key starts it fresh.
    window.mailInboxRender = function render(options) {
      window.mailInboxFixtureRoot.render(
        React.createElement(
          BrowserRouter,
          null,
          React.createElement(
            PortalFrame,
            {
              identity: {
                kind: "ready",
                displayName: "Inbox fixture",
                logout: async function logout() {},
              },
              organisation: {
                organisationHandle: "fixture",
                name: "Fixture organisation",
                choices: [],
              },
              workspace: {
                organisationHandle: "fixture",
                workspaceHandle: "cafe",
                name: "Cafe operations",
                choices: [],
              },
              sidebar: { activePage: "inbox", chatOpen: false, footer: null },
            },
            React.createElement(MailInboxRoute, {
              key: options?.key ?? "inbox",
              organisationId: "inbox-fixture",
              integrationsPath: "/integrations",
              // The Portal's settings page needs the Integrations route; this
              // stand-in shows where the Inbox puts it and its way back.
              mailboxSettings: function mailboxSettings(accountId, backHref) {
                return React.createElement(
                  "section",
                  { "aria-label": "Mailbox settings" },
                  React.createElement("a", { href: backHref }, "Inbox"),
                  React.createElement("h1", null, accountId),
                );
              },
              canManage: options?.canManage ?? !window.mailReviewViewer,
              supplierHref: String.prototype.concat.bind("/suppliers/"),
              orderHref: String.prototype.concat.bind("/orders/"),
              memoryHref: String.prototype.concat.bind("/brain?memory="),
              suppliersPath: "/suppliers",
            }),
          ),
        ),
      );
    };
    window.mailInboxRender();
  });
}
