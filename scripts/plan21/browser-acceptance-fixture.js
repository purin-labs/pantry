async function browserAcceptanceFixture(page) {
  const organisationId = "organisation_browser";
  const secondOrganisationId = "organisation_browser_second";
  const workspaceHandle = "cafe-browser-lab";
  const secondWorkspaceHandle = "riverside-cafe";
  const generatedAt = "2026-08-11T00:00:00.000Z";

  const inventoryRows = [];
  for (const item of [
    {
      id: "flour",
      name: "北海道産 薄力粉 · Hokkaido pastry flour",
      kind: "supply",
      category: "ingredient",
      available: "8 kg",
      status: "low",
    },
    {
      id: "cups",
      name: "Compostable takeaway cups · 8 oz",
      kind: "supply",
      category: "packaging",
      available: "320 pieces",
      status: "healthy",
    },
    {
      id: "financier",
      name: "Brown butter financier · 焦がしバター",
      kind: "product",
      category: "finished_good",
      available: "24 pieces",
      status: "low",
    },
  ]) {
    inventoryRows.push({
      id: `stock_${item.id}`,
      inventoryItemId: `item_${item.id}`,
      positionId: `position_${item.id}`,
      recipeCount: item.kind === "product" ? 1 : 0,
      locationId: "location_atelier",
      name: item.name,
      location: "Atelier · Tokyo",
      kind: item.kind,
      category: item.category,
      product:
        item.kind === "product"
          ? {
              productId: "product_financier",
              productTitle: "Financier",
              productRevision: 1,
              deleteBlock: null,
              variantId: "variant_financier",
              variantTitle: "Financier",
              variantRevision: 1,
              offerId: "offer_financier",
              offerRevision: 1,
              price: { amountMinor: 450, currency: "JPY" },
              description: "A brown butter financier.",
              image: null,
              photos: { revision: 0, items: [] },
            }
          : null,
      onHand: item.available,
      allocated: "0",
      available: item.available,
      reorderPoint: item.kind === "product" ? "36 pieces" : "10 kg",
      target: item.kind === "product" ? "96 pieces" : "25 kg",
      status: item.status,
      lots: [
        {
          id: `lot_${item.id}`,
          code: "LOT-2026-1023",
          remaining: item.available,
          expiresAt: "2026-11-15T00:00:00Z",
          status: "available",
        },
      ],
      movements: [
        {
          id: `movement_${item.id}`,
          direction: "increase",
          quantity: item.available,
          reason: "Supplier delivery received",
          occurredAt: "2026-10-23T01:00:00Z",
        },
      ],
      reservations: [],
    });
  }
  const productionRequests = [];
  for (const [index, status] of [
    "requested",
    "accepted",
    "scheduled",
  ].entries()) {
    productionRequests.push({
      id: `request_${index}`,
      revision: 1,
      itemId: "item_financier",
      name: [
        "Brown butter financiers · Morning service",
        "Matcha gift assortment · Online orders",
        "Seasonal pâtisserie selection · Boutique Saint-Honoré",
      ][index],
      locationId: "location_atelier",
      recipeId: "recipe_financier",
      recipeRevision: 1,
      quantity: { amount: 96, scale: 0, unit: "each" },
      neededBy: "2026-10-24T02:00:00Z",
      status,
      batches: [],
    });
  }
  const terminalCounters = [];
  for (const location of ["boutique_tokyo", "cafe_kyoto"]) {
    terminalCounters.push({
      pantryLocationId: location,
      blockedReason: location === "cafe_kyoto" ? "assignment_retired" : null,
      assignment: {
        assignmentId: `terminal_${location}`,
        revision: 2,
        merchantId: "merchant_browser",
        integrationAccountId: "square_browser",
        capabilityRevision: 1,
        capabilityCurrent: true,
        providerLocationId: `square_${location}`,
        targetKind: "paired_physical",
        deviceId: `device_${location}`,
        adapterVersion: "square_terminal@2026-08-19",
        environment: "production",
        healthIsObservable: true,
      },
      credentialHealth: "active",
      webhook: {
        kind: "configured",
        lifecycle: "live",
        credentialCurrent: true,
        lastVerifiedAt: 1792717200000,
        updatedAt: 1792717200000,
      },
      // A retired assignment has no binding, so it is not linked for payments.
      paymentsLinked: location !== "cafe_kyoto",
    });
  }

  function json(route, body, status = 200) {
    return route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  }

  function isAuthenticated() {
    const currentUrl = page.url();
    return (
      currentUrl.includes("p21_auth=1") ||
      currentUrl.includes(`/portal/${workspaceHandle}`) ||
      currentUrl.includes(`/portal/${secondWorkspaceHandle}`)
    );
  }

  const snapshot = {
    schema_version: 1,
    projection_revision: 1,
    configuration_version: 1,
    organisation: {
      organisation_id: organisationId,
      name: "Café browser lab",
      plan: "beta",
      lifecycle: {
        kind: "active",
        organisation_id: organisationId,
        activation_receipt_id: "receipt_browser_acceptance",
        activated_at: 1_800_000_000_000,
        environment: "development",
      },
      capability_profile: "read_and_propose",
      created_at: 1_800_000_000_000,
    },
    steps: [
      {
        kind: "complete",
        step: "workspace",
        completed_at: 1_800_000_000_000,
        receipt_id: "receipt_workspace",
      },
      {
        kind: "complete",
        step: "commerce",
        completed_at: 1_800_000_000_001,
        receipt_id: "receipt_commerce",
      },
      {
        kind: "complete",
        step: "conversations",
        completed_at: 1_800_000_000_002,
        receipt_id: "receipt_conversations",
      },
      {
        kind: "complete",
        step: "operating_profile",
        completed_at: 1_800_000_000_003,
        receipt_id: "receipt_profile",
      },
      {
        kind: "complete",
        step: "review_activation",
        completed_at: 1_800_000_000_004,
        receipt_id: "receipt_activation",
      },
    ],
    provider_accounts: [],
    operating_profile: { kind: "unconfigured" },
    readiness: {
      kind: "ready",
      readiness_version: 1,
      readiness_hash: "readiness_browser_acceptance",
    },
    activation: {
      kind: "succeeded",
      activation_attempt_id: "activation_attempt_browser",
      activation_receipt_id: "activation_receipt_browser",
      activated_at: 1_800_000_000_000,
    },
    next_action: {
      kind: "done",
      action_code: "onboarding_complete",
      label: "Onboarding complete",
    },
    first_task: null,
    support_reference: { kind: "none" },
    updated_at: 1_800_000_000_000,
  };

  const home = {
    ok: true,
    schemaVersion: "pantry.cafeos.home.v1",
    generatedAt: 1_800_000_000_000,
    home: {
      workspace: {
        organisationId,
        name: "Café browser lab",
        lifecycle: "active",
        environment: "development",
      },
      attention: [
        {
          kind: "commerce_exception",
          urgency: "urgent",
          status: "failed",
          title: "Customer order needs review",
          reason:
            "Payment capture failed and the order needs an operator decision.",
          resource: { kind: "customer_order", label: "Customer order" },
          observedAt: "2026-08-11T00:00:00.000Z",
          assignee: { kind: "unassigned" },
          nextAction: {
            kind: "open_commerce",
            label: "Open customer order",
            destination: {
              kind: "customer_order",
              resourceId: "order_plan21_attention",
            },
          },
        },
      ],
      today: [],
      blockers: [],
      permissions: {
        role: "owner",
        canApproveCommerceActions: true,
        canConfigureIntegrations: true,
        canManageWorkspace: true,
      },
      availableActions: [],
      sourceObservations: [],
    },
  };

  const secondSnapshot = {
    ...snapshot,
    organisation: {
      ...snapshot.organisation,
      organisation_id: secondOrganisationId,
      name: "Riverside Cafe",
      lifecycle: {
        kind: "active",
        organisation_id: secondOrganisationId,
        activation_receipt_id: "receipt_browser_acceptance_second",
        activated_at: 1_800_000_000_000,
        environment: "development",
      },
    },
  };

  const secondHome = {
    ...home,
    home: {
      ...home.home,
      workspace: {
        ...home.home.workspace,
        organisationId: secondOrganisationId,
        name: "Riverside Cafe",
      },
      attention: [],
    },
  };

  const slackRecoveryAccount = {
    integration_account_id: "account_slack_recovery",
    provider: "slack",
    provider_account_id: "T_PLAN21_RECOVERY",
    environment: "development",
    account_kind: "workspace",
    display_name: "Café acceptance Slack",
    lifecycle: { kind: "reauth_required", reason_code: "oauth_scope_revoked" },
    is_default_for_provider: true,
    capabilities: ["chat:write"],
    scopes: ["chat:write"],
    selected_resources: [],
    credential_health: { kind: "degraded" },
    webhook_health: { kind: "degraded" },
    event_recency: { kind: "unavailable" },
  };
  const slackRecoveredAccount = {
    ...slackRecoveryAccount,
    lifecycle: { kind: "active" },
    selected_resources: [
      {
        resource_kind: "workspace",
        canonical_resource_id: "T_PLAN21_RECOVERY",
        display_label: "Café acceptance Slack",
      },
      {
        resource_kind: "channel",
        canonical_resource_id: "C_PLAN21_OPERATIONS",
        display_label: "#operations",
      },
    ],
    credential_health: { kind: "healthy" },
    webhook_health: { kind: "healthy" },
    event_recency: { kind: "available", at: 1_800_000_000_000 },
  };
  const providerSnapshot = {
    ...snapshot,
    provider_accounts: [slackRecoveryAccount],
  };
  const providerRecoveredSnapshot = {
    ...snapshot,
    provider_accounts: [slackRecoveredAccount],
  };

  const commerceSource = {
    source: "lab",
    provider: "Commerce Lab",
    integrationAccountId: "account_browser_lab",
    accountName: "Café browser lab",
    providerAccountId: "merchant_browser_lab",
    environment: "development",
    accountLifecycle: "active",
  };
  const commerceFreshness = {
    observedAt: generatedAt,
    projectedAt: 1,
    ageMs: 0,
    status: "fresh",
  };
  const croissant = {
    productId: "product_croissant",
    title: "Butter Croissant",
    description: "Frozen butter croissant case for morning service.",
    variants: [
      {
        variantId: "variant_croissant_case",
        revision: 1,
        sku: "CAFE-CROISSANT-48",
        title: "48 pack",
        options: [{ name: "Pack size", value: "48" }],
        media: [],
      },
    ],
    offers: [
      {
        offerId: "offer_croissant",
        variantId: "variant_croissant_case",
        salesChannelId: "channel_cafe",
        salesChannelRevision: 1,
        price: { amountMinor: 4800, currency: "USD" },
        availability: { state: "available" },
        lifecycle: { state: "prepared", preparedAt: generatedAt },
        revision: 1,
        source: commerceSource,
        freshness: commerceFreshness,
      },
    ],
    listing: { state: "prepared", preparedAt: generatedAt },
    lifecycle: "prepared",
    revision: 1,
    source: commerceSource,
    freshness: commerceFreshness,
    inventory: [
      {
        inventoryId: "inventory_croissant_case",
        variantId: "variant_croissant_case",
        sku: "CAFE-CROISSANT-48",
        locationId: "main_stockroom",
        available: 14,
        lifecycle: "in_stock",
        revision: 1,
        source: commerceSource,
        freshness: commerceFreshness,
      },
    ],
    activeExceptions: [],
    availableActions: [{ kind: "publish_catalog_listing" }],
    activity: {
      projectionEvents: [
        {
          eventId: "event_croissant_created",
          disposition: "applied",
          revision: 1,
          occurredAt: generatedAt,
          processedAt: 1,
          deliveryCount: 1,
        },
      ],
      caseActions: [],
    },
  };

  function productEnvelope(products) {
    return {
      ok: true,
      schemaVersion: "pantry.commerce.query.v1",
      organisationId,
      organisationEnvironment: "development",
      projectionSnapshot: { generatedAt: 1, maxRevision: 1 },
      generatedAt: 1,
      sources: [commerceSource],
      freshness: {
        status: "fresh",
        oldestAgeMs: 0,
        newestObservedAt: generatedAt,
      },
      continuation: { kind: "end" },
      data: { products },
    };
  }

  const providerActionDetails = {
    kind: "publish_catalog_listing",
    productId: croissant.productId,
    productRevision: croissant.revision,
    variantId: croissant.variants[0].variantId,
    variantRevision: croissant.variants[0].revision,
    offerId: croissant.offers[0].offerId,
    offerRevision: croissant.offers[0].revision,
    salesChannelId: croissant.offers[0].salesChannelId,
    salesChannelRevision: croissant.offers[0].salesChannelRevision,
  };
  const providerActions = new Map([
    ["action_plan21_approval", "approval_requested"],
    ["action_plan21_rejection", "approval_requested"],
  ]);

  function providerAction(actionNonce) {
    const state = providerActions.get(actionNonce);
    if (state === undefined) return null;
    return {
      nonce: { value: actionNonce },
      caseId: `case_${actionNonce}`,
      proposalId: `proposal_${actionNonce}`,
      state,
      verb: "commerce.catalog.publish",
      resourceKey: providerActionDetails.offerId,
      commerceSystem: {
        kind: "commerce_system",
        system: "builtin_commerce",
        revision: 1,
      },
      amount: null,
      details: providerActionDetails,
      providerResult: null,
    };
  }

  function providerOperations() {
    return {
      ok: true,
      operations: {
        areas: [],
        definitions: [],
        installations: [],
        skills: [],
        bindings: [],
        activeCases: [],
        responsibilityScopes: [],
        cueBindings: [],
        scheduleBindings: [],
        governance: [],
        escalationPolicies: [],
        configurationProposals: [],
        merchantMemories: [],
        commerceExceptions: {
          kind: "unavailable",
          reason: "commerce_system_unavailable",
        },
        actionLedger: [...providerActions.entries()].map(
          ([actionNonce, state]) => ({
            action: {
              nonce: { value: actionNonce },
              host: "pantry.commerce",
              verb: "commerce.catalog.publish",
              resourceKey: providerActionDetails.offerId,
              amount: null,
            },
            caseId: `case_${actionNonce}`,
            proposalId: `proposal_${actionNonce}`,
            state,
            createdAt: 1_800_000_000_000,
            updatedAt: 1_800_000_000_000,
            providerResult: null,
            commerceEffect: null,
          }),
        ),
      },
    };
  }

  function providerApprovalResponse(action) {
    return {
      ok: true,
      action,
      state: "signed",
      approval: {
        kind: "google_oidc_step_up",
        authenticated_at: 1_800_000_000_000,
      },
      case: { caseId: action.caseId, revision: 2 },
    };
  }

  function providerRejectionResponse(action) {
    return {
      ok: true,
      action,
      state: "rejected",
      decision: { kind: "rejected", reason: "merchant_declined" },
      case: { caseId: action.caseId, revision: 2 },
      case_output: { kind: "merchant_rejection", delivered: false },
    };
  }

  let providerFixtureEnabled = false;
  let providerRecoveryComplete = false;
  let trackingFixtureEnabled = false;
  let trackingPreviewFailed = false;
  const trackingItems = [];
  for (const number of [1041, 1042, 1043]) {
    trackingItems.push({
      kind: "missing_tracking",
      exceptionId: `missing_tracking_${number}`,
      reason:
        "The carrier has a tracking number, but the order does not show it.",
      owner: { kind: "unassigned" },
      dueAt: "2026-10-23T09:00:00.000Z",
      recommendedAction: { kind: "attach_tracking", label: "Attach tracking" },
      resolution: {
        kind: "fulfillment_lifecycle",
        expectedState: "handed_to_carrier",
      },
      freshness: "current",
      target: {
        merchantRevision: 1,
        orderId: `order_${number}`,
        fulfillmentId: `fulfillment_${number}`,
        fulfillmentRevision: 1,
        shipmentId: `shipment_${number}`,
        shipmentRevision: 1,
        trackingNumber: `JP-AUTUMN-DELIVERY-${number}`,
      },
    });
  }
  await page.context().route("**/*", async (route) => {
    const requestUrl = route.request().url();
    const pathname = requestUrl.replace(/^https?:\/\/[^/]+/u, "").split("?")[0];
    if (requestUrl.includes("p21_provider=1")) providerFixtureEnabled = true;
    if (requestUrl.includes("p21_tracking=1")) {
      providerFixtureEnabled = true;
      trackingFixtureEnabled = true;
    }
    const providerFixture = providerFixtureEnabled;
    if (
      trackingFixtureEnabled &&
      pathname.endsWith("/commerce/operations/tracking-batches/preview")
    ) {
      if (!trackingPreviewFailed) {
        trackingPreviewFailed = true;
        return json(route, { ok: false, error: "preview_unavailable" }, 503);
      }
      const selected = route.request().postDataJSON().exceptionIds;
      const batchId = `tracking_batch_${"a".repeat(64)}`;
      const items = [];
      for (const item of trackingItems) {
        if (!selected.includes(item.exceptionId)) continue;
        if (item.exceptionId === "missing_tracking_1042")
          items.push({
            exceptionId: item.exceptionId,
            validation: { kind: "invalid", reason: "closed_or_changed" },
            action: null,
          });
        else
          items.push({
            exceptionId: item.exceptionId,
            validation: { kind: "valid" },
            action: { kind: "attach_tracking", batchId, ...item.target },
          });
      }
      return json(route, {
        ok: true,
        preview: {
          kind: "tracking_batch_preview",
          batchId,
          frozenAt: "2026-10-23T09:00:00.000Z",
          items,
        },
      });
    }
    if (
      trackingFixtureEnabled &&
      pathname.endsWith("/commerce/actions") &&
      route.request().method() === "POST"
    ) {
      return json(route, { ok: false, error: "preview_write_refused" }, 503);
    }
    if (pathname === "/v1/identity-links/ui-review") {
      return json(route, {
        ok: true,
        challengeId: "challenge_review",
        kind: "slack",
        workspaceId: "workspace_browser",
        externalUserId: "slack_aiko",
        expiresAt: 1793322000000,
      });
    }
    if (
      pathname === `/v1/control/organisations/${organisationId}/commerce/graph`
    ) {
      const body = route.request().postDataJSON();
      if (Array.isArray(body.queries)) {
        const results = [];
        for (const query of body.queries) {
          const counts = {
            order: "12",
            stock_policy: "3",
            payment: "1",
            shipment: "2",
          };
          results.push({
            merchantRevision: 12,
            entities: [],
            relationships: [],
            listEntries: [],
            aggregations: [
              {
                kind: "count",
                value: counts[query.source.entityTypeId.typeId],
              },
            ],
            nextCursor: null,
            provenance: [],
            freshness: [],
          });
        }
        return json(route, { ok: true, results });
      }
      if (body.query?.entityTypeId?.typeId === "order") {
        return json(route, {
          ok: true,
          result: {
            merchantRevision: 12,
            entities: [
              {
                reference: {
                  origin: "system",
                  typeId: "order",
                  entityId: "order_1041",
                },
                revision: 1,
                displayName: "Order #1041 · Aiko Sato",
                attributes: [
                  {
                    attributeId: "lifecycle",
                    scope: {
                      kind: "system",
                      entityTypeId: "order",
                      schemaRevision: 1,
                    },
                    definitionRevision: 1,
                    sensitivity: "internal",
                    value: { kind: "status", value: "confirmed" },
                  },
                ],
                provenance: {
                  organisationId,
                  integrationAccountId: "intacc_commerce",
                  source: "commerce",
                  resourceType: "commerce_order",
                  resourceId: "order_1041",
                  revision: 1,
                  occurredAt: generatedAt,
                  observedAt: generatedAt,
                },
                freshness: { state: "current", observedAt: generatedAt },
              },
            ],
            relationships: [],
            listEntries: [],
            aggregations: [],
            nextCursor: null,
            provenance: [],
            freshness: [],
          },
        });
      }
    }
    if (
      (pathname ===
        `/v1/control/organisations/${organisationId}/commerce/inventory/receipts` ||
        pathname ===
          `/v1/control/organisations/${organisationId}/commerce/inventory/reconciliations`) &&
      route.request().method() === "GET"
    ) {
      const position = new URL(requestUrl).searchParams.get("position");
      let row = null;
      for (const candidate of inventoryRows) {
        if (candidate.positionId === position) row = candidate;
      }
      if (row === null) return json(route, { ok: false }, 404);
      const unit = row.category === "ingredient" ? "kilogram" : "each";
      return json(route, {
        ok: true,
        context: {
          merchantRevision: 12,
          inventoryItemId: row.inventoryItemId,
          inventoryItemRevision: 1,
          inventoryPositionId: row.positionId,
          inventoryPositionRevision: 1,
          locationId: row.locationId,
          itemName: row.name,
          locationName: row.location,
          unit,
          tracking: { kind: "aggregate" },
          onHand: row.onHand,
          available: row.available,
          allocated: row.allocated,
          onHandQuantity: {
            amount: Number.parseInt(row.onHand, 10),
            scale: 0,
            unit,
          },
          lots: [],
          purchases: {
            kind: "ready",
            entries: [
              {
                id: "purchase_flour",
                revision: 1,
                supplier: "Hokkaido Flour Mill",
                required: "25 kg",
                received: "0 kg",
              },
            ],
          },
        },
      });
    }
    if (
      pathname.startsWith("/v1/control/user/preferences/") &&
      route.request().method() === "GET"
    ) {
      const area = pathname.split("/").at(-1);
      const values = {
        appearance: { mode: "system", palette: "sage" },
        chat: { dockedPanelWidthPx: 600, fullscreenSidebarWidthPx: 360 },
        bakeryos: {
          appearance: { kind: "inherit" },
          scene: { labels: "auto", minimap: false },
        },
      };
      return json(route, {
        userId: "user_00000000-0000-4000-8000-000000000001",
        area,
        schemaVersion: 1,
        revision: 1,
        updatedAt: 1792717200000,
        values: values[area],
      });
    }
    if (
      pathname.startsWith(
        `/v1/control/organisations/${organisationId}/members/`,
      ) ||
      (pathname.startsWith(
        `/v1/control/organisations/${organisationId}/invitations`,
      ) &&
        route.request().method() !== "GET")
    ) {
      return json(route, { ok: false, error: "preview_write_refused" }, 503);
    }
    if (
      pathname === `/v1/control/organisations/${organisationId}/members` &&
      route.request().method() === "GET"
    ) {
      return json(route, {
        ok: true,
        members: [
          {
            kind: "active",
            userId: "user_owner",
            personId: "person_owner",
            role: "owner",
            email: "aiko@example.test",
            displayName: "Aiko Sato",
            createdAt: 1792717200000,
          },
          {
            kind: "active",
            userId: "user_operator",
            personId: "person_operator",
            role: "operator",
            email: "camille.boulangerie.saint-honore@example.test",
            displayName: "Camille Boulangerie Saint-Honoré",
            createdAt: 1792717200000,
          },
        ],
      });
    }
    if (
      pathname === `/v1/control/organisations/${organisationId}/invitations` &&
      route.request().method() === "GET"
    ) {
      return json(route, {
        ok: true,
        invitations: [
          {
            kind: "pending",
            organisationInvitationId: "invitation_pastry",
            invitedEmail: "pastry-team@example.test",
            role: "operator",
            createdAt: 1792717200000,
            expiresAt: 1793322000000,
          },
        ],
      });
    }
    if (
      pathname ===
      `/v1/control/organisations/${organisationId}/commerce/inventory`
    ) {
      return json(route, {
        ok: true,
        rows: inventoryRows,
        untrackedProducts: [
          {
            productId: "product_gift",
            productTitle: "Autumn gift box",
            productRevision: 1,
            deleteBlock: null,
            variantId: "variant_gift",
            variantTitle: "12 pieces",
            variantRevision: 1,
            offerId: "offer_gift",
            offerRevision: 1,
            price: { amountMinor: 3200, currency: "JPY" },
            description: "Twelve pieces in a gift box.",
            image: null,
            photos: { revision: 0, items: [] },
            name: "Autumn gift box · 12 pieces",
            madeToOrder: false,
          },
        ],
        archivedProducts: [],
      });
    }
    if (
      pathname ===
        `/v1/control/organisations/${organisationId}/commerce/inventory/production-requests` &&
      route.request().method() === "GET"
    ) {
      const position = new URL(requestUrl).searchParams.get("position");
      if (position !== null) {
        if (position !== "position_financier")
          return json(route, { ok: false }, 404);
        return json(route, {
          ok: true,
          context: {
            merchantRevision: 12,
            inventoryItemId: "item_financier",
            inventoryPositionId: "position_financier",
            inventoryPositionRevision: 1,
            locationId: "location_atelier",
            itemName: "Brown butter financier · 焦がしバター",
            recipes: [
              {
                id: "recipe_financier",
                revision: 1,
                name: "Brown butter financiers",
                yield: { amount: 96, scale: 0, unit: "each" },
                inputs: [
                  {
                    name: "Pastry flour",
                    quantity: { amount: 500, scale: 0, unit: "gram" },
                    available: { amount: 8000, scale: 0, unit: "gram" },
                  },
                ],
              },
            ],
            linkableRecipes: [],
            demand: {
              kind: "ready",
              merchantRevision: 12,
              listRevision: 1,
              requests: productionRequests,
              invalidRequests: [],
              nextCursor: null,
            },
          },
        });
      }
      return json(route, {
        ok: true,
        demand: {
          kind: "ready",
          merchantRevision: 12,
          listRevision: 1,
          requests: productionRequests,
          invalidRequests: [],
          nextCursor: null,
        },
      });
    }
    if (
      pathname ===
      `/v1/control/organisations/${organisationId}/commerce/terminal-operations`
    ) {
      return json(route, {
        ok: true,
        terminalOperations: {
          schemaVersion: "pantry.terminal-operations.v2",
          organisationId,
          generatedAt: "2026-10-23T01:00:00Z",
          counters: terminalCounters,
          unreadableAssignments: 0,
        },
        configuration: {
          kind: "ready",
          merchantId: "merchant_browser",
          environment: "development",
          pantryLocations: [
            {
              pantryLocationId: "boutique_tokyo",
              currency: "JPY",
              supportedItems: [
                { variantId: "variant_financier", maxQuantityPerLine: 24 },
              ],
            },
          ],
          squareAccounts: [
            {
              integrationAccountId: "square_browser",
              providerAccountId: "square_merchant_browser",
              displayName: "Cafe Browser Lab · Square Sandbox",
              locations: [
                {
                  providerLocationId: "square_boutique_tokyo",
                  displayName: "Tokyo boutique",
                  country: "JP",
                  currency: "JPY",
                },
              ],
            },
          ],
          testDevices: [
            {
              testDeviceId: "test_success",
              label: "Successful payment",
              expectedOutcome: "success",
            },
            {
              testDeviceId: "test_buyer_cancel",
              label: "Buyer cancels payment",
              expectedOutcome: "buyer_cancel",
            },
          ],
        },
      });
    }
    if (
      pathname === `/v1/control/organisations/${organisationId}/brain/summary`
    ) {
      return json(route, {
        ok: true,
        summary: { memoriesToReview: 0, evalsToReview: 0 },
      });
    }
    if (pathname === "/v1/identity/config") {
      return json(route, {
        ok: true,
        walletOrigin: "https://wallet.example.test",
        relayerUrl: "https://relayer.example.test",
        nearNetwork: "near-testnet",
        nearRpcUrl: "https://rpc.testnet.near.org",
        nearExplorerUrl: "https://testnet.nearblocks.io",
      });
    }
    if (
      pathname ===
        `/v1/control/organisations/${organisationId}/inference/codex` &&
      isAuthenticated()
    ) {
      return json(route, {
        ok: true,
        connection: { kind: "disconnected", revision: 0 },
      });
    }
    if (
      pathname === `/v1/control/organisations/${organisationId}/inference` &&
      isAuthenticated()
    ) {
      return json(route, { ok: true, selection: { kind: "pantry_platform" } });
    }
    if (
      pathname ===
        `/v1/control/organisations/${organisationId}/custom-connectors` &&
      isAuthenticated()
    ) {
      return json(route, { kind: "custom_connector_catalog", items: [] });
    }
    if (pathname === "/v1/control/session") {
      if (!isAuthenticated()) {
        return json(
          route,
          { ok: false, error: "control_session_required" },
          401,
        );
      }
      return json(route, {
        ok: true,
        identity: {
          userId: "user_00000000-0000-4000-8000-000000000001",
          email: "plan21@example.test",
          displayName: "Plan 21 Browser",
        },
        supportRole: null,
        membershipAvailability: "complete",
        memberships: [
          {
            organisationId,
            organisationHandle: workspaceHandle,
            role: "owner",
            workspaces: [
              {
                workspaceId: "workspace_browser",
                workspaceHandle: "main",
                name: "Main",
                createdAt: 1800000000000,
              },
            ],
          },
          {
            organisationId: secondOrganisationId,
            organisationHandle: secondWorkspaceHandle,
            workspaces: [
              {
                workspaceId: "workspace_browser_second",
                workspaceHandle: "main",
                name: "Main",
                createdAt: 1800000000000,
              },
            ],
            role: "owner",
          },
        ],
      });
    }
    if (
      pathname === "/v1/control/organisations" &&
      route.request().method() === "POST" &&
      isAuthenticated()
    ) {
      return json(
        route,
        {
          ok: false,
          error: {
            code: "control_api_unavailable",
            message: "provider database details must stay private",
          },
        },
        503,
      );
    }
    if (
      pathname === `/v1/control/organisations/${organisationId}` &&
      isAuthenticated()
    ) {
      return json(
        route,
        providerFixture
          ? providerRecoveryComplete
            ? providerRecoveredSnapshot
            : providerSnapshot
          : snapshot,
      );
    }
    if (
      pathname === `/v1/control/organisations/${secondOrganisationId}` &&
      isAuthenticated()
    ) {
      return json(route, secondSnapshot);
    }
    if (
      pathname === `/v1/control/organisations/${organisationId}/home` &&
      isAuthenticated()
    ) {
      return json(route, home);
    }
    if (
      pathname ===
        `/v1/control/organisations/${organisationId}/commerce-system` &&
      isAuthenticated() &&
      providerFixture
    ) {
      return json(route, { ok: true, commerceSystem: null, sync: null });
    }
    if (
      pathname === `/v1/control/organisations/${organisationId}/operations` &&
      isAuthenticated() &&
      providerFixture
    ) {
      const snapshot = providerOperations();
      if (trackingFixtureEnabled)
        snapshot.operations.commerceExceptions = {
          kind: "ready",
          observedAt: "2026-10-23T09:00:00.000Z",
          items: trackingItems,
        };
      return json(route, snapshot);
    }
    if (
      pathname ===
        `/v1/control/organisations/${organisationId}/accounts/account_slack_recovery/reconnect` &&
      route.request().method() === "POST" &&
      isAuthenticated() &&
      providerFixture
    ) {
      providerRecoveryComplete = true;
      return json(route, {
        kind: "success",
        attempt: { attempt_id: "attempt_plan21_reconnect" },
        authorization_url: `${requestUrl.match(/^(?:https?:\/\/[^/]+)/u)?.[0] ?? "http://localhost:7700"}/portal/cafe-browser-lab/integrations?p21_auth=1&p21_provider=1&p21_recovered=1`,
      });
    }
    if (
      pathname ===
        `/v1/control/organisations/${organisationId}/accounts/account_slack_recovery/resources` &&
      isAuthenticated() &&
      providerFixture &&
      providerRecoveryComplete
    ) {
      return json(route, {
        kind: "success",
        page: {
          resources: [
            {
              canonical_resource_id: "C_PLAN21_OPERATIONS",
              display_label: "#operations",
              access_state: "accessible",
            },
          ],
          next_cursor: "end",
        },
      });
    }
    const providerActionRoute = new RegExp(
      `^/v1/control/organisations/${organisationId}/commerce/actions/([^/]+)$`,
      "u",
    ).exec(pathname);
    if (
      providerFixture &&
      providerActionRoute?.[1] !== undefined &&
      isAuthenticated()
    ) {
      const action = providerAction(providerActionRoute[1]);
      return action === null
        ? json(route, { ok: false, error: "commerce_action_not_found" }, 404)
        : json(route, { ok: true, action });
    }
    const providerApprovalRoute = new RegExp(
      `^/v1/control/organisations/${organisationId}/commerce/actions/([^/]+)/(approval|rejection)$`,
      "u",
    ).exec(pathname);
    if (
      providerFixture &&
      providerApprovalRoute?.[1] !== undefined &&
      providerApprovalRoute[2] !== undefined &&
      route.request().method() === "POST" &&
      isAuthenticated()
    ) {
      const actionNonce = providerApprovalRoute[1];
      const action = providerAction(actionNonce);
      if (action === null)
        return json(
          route,
          { ok: false, error: "commerce_action_not_found" },
          404,
        );
      const nextState =
        providerApprovalRoute[2] === "approval" ? "signed" : "rejected";
      providerActions.set(actionNonce, nextState);
      const updated = providerAction(actionNonce);
      if (updated === null)
        return json(
          route,
          { ok: false, error: "commerce_action_not_found" },
          404,
        );
      return providerApprovalRoute[2] === "approval"
        ? json(route, providerApprovalResponse(updated))
        : json(route, providerRejectionResponse(updated));
    }
    if (
      pathname === `/v1/control/organisations/${secondOrganisationId}/home` &&
      isAuthenticated()
    ) {
      return json(route, secondHome);
    }
    if (
      pathname === `/v1/control/organisations/${organisationId}/products` &&
      isAuthenticated()
    ) {
      return json(route, productEnvelope([croissant]));
    }
    if (
      pathname ===
        `/v1/control/organisations/${organisationId}/products/${croissant.productId}` &&
      isAuthenticated()
    ) {
      return json(route, productEnvelope([croissant]));
    }
    if (
      pathname ===
        `/v1/control/organisations/${organisationId}/commerce/actions` &&
      route.request().method() === "POST" &&
      isAuthenticated()
    ) {
      return json(
        route,
        {
          ok: true,
          action: {
            nonce: { value: "action_publish_croissant" },
            caseId: "case_publish_croissant",
            proposalId: "proposal_publish_croissant",
            state: "proposed",
            verb: "commerce.catalog.publish",
            resourceKey: croissant.productId,
            commerceSystem: {
              kind: "commerce_system",
              system: "builtin_commerce",
              revision: 1,
            },
            details: {
              kind: "publish_catalog_listing",
              productId: croissant.productId,
              productRevision: croissant.revision,
              variantId: croissant.variants[0].variantId,
              variantRevision: croissant.variants[0].revision,
              offerId: croissant.offers[0].offerId,
              offerRevision: croissant.offers[0].revision,
              salesChannelId: croissant.offers[0].salesChannelId,
              salesChannelRevision: croissant.offers[0].salesChannelRevision,
            },
            providerResult: null,
          },
        },
        201,
      );
    }
    return route.continue();
  });
}
