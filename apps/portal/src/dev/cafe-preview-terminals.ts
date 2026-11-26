/*
 * The Counters & payments page of the Café preview. One in-memory store
 * answers the page's reads and changes, so the "Add a counter" drawer, a
 * pairing and "Stop taking payments" work without a Worker. Choices:
 *   &scenario=empty     no counter yet
 *   &scenario=sandbox   development: Square Sandbox test devices
 *   &scenario=blocked   no Purin Checkout
 *   &scenario=locations two Square locations, so the drawer asks for one
 *   &pairing=expired    a pairing code runs out at its first check
 */

type TargetKind = "paired_physical" | "square_pos_app" | "sandbox_simulated";

type PreviewCounter = {
  pantryLocationId: string;
  targetKind: TargetKind;
  revision: number;
  retired: boolean;
  paymentsLinked: boolean;
};

const query = new URLSearchParams(window.location.search);
const scenario = query.get("scenario");
const environment = scenario === "sandbox" ? "development" : "production";
const pairingEnds = query.get("pairing") === "expired" ? "expired" : "paired";

const counters: PreviewCounter[] =
  scenario === "empty" || scenario === "blocked"
    ? []
    : [
        {
          pantryLocationId: "Front counter",
          targetKind:
            environment === "production"
              ? "paired_physical"
              : "sandbox_simulated",
          revision: 1,
          retired: false,
          paymentsLinked: true,
        },
        {
          pantryLocationId: "Window counter",
          targetKind:
            environment === "production"
              ? "square_pos_app"
              : "sandbox_simulated",
          revision: 1,
          retired: false,
          paymentsLinked: false,
        },
      ];

const SQUARE_LOCATIONS = [
  {
    providerLocationId: "square_location_tokyo",
    displayName: "Kissa Purin Tokyo",
    country: "JP",
    currency: "JPY",
  },
  ...(scenario === "locations"
    ? [
        {
          providerLocationId: "square_location_kyoto",
          displayName: "Kissa Purin Kyoto",
          country: "JP",
          currency: "JPY",
        },
      ]
    : []),
];

/** The open pairing code, and when Square names its device. */
let pairing: { deviceCodeId: string; pairedAt: number } | null = null;

export function terminalPreviewRead(path: string): unknown {
  const code = /\/terminal-operations\/pairings\/([^/?]+)/u.exec(path)?.[1];
  if (code !== undefined)
    return pairingEnvelope(decodeURIComponent(code), true);
  if (/\/terminal-operations$/u.test(path)) return operationsEnvelope(true);
  return undefined;
}

export function terminalPreviewMutation(
  path: string,
  _method: "POST",
  body: unknown,
): Promise<unknown> {
  const request = (body ?? {}) as Record<string, unknown>;
  if (/\/pairings$/u.test(path)) {
    pairing = {
      deviceCodeId: "device_code_preview",
      pairedAt: Date.now() + 9_000,
    };
    return Promise.resolve(pairingEnvelope(pairing.deviceCodeId, false));
  }
  if (/\/pairings\/[^/]+\/activation$/u.test(path)) {
    pairing = null;
    assign(String(request.pantryLocationId), "paired_physical");
    return Promise.resolve(operationsEnvelope(true));
  }
  if (/\/square-pos-app$/u.test(path)) {
    assign(String(request.pantryLocationId), "square_pos_app");
    return Promise.resolve(operationsEnvelope(true));
  }
  const retired = /\/terminal-operations\/([^/]+)\/retirement$/u.exec(
    path,
  )?.[1];
  if (retired !== undefined) {
    const counter = counters.find(
      (candidate) => candidate.pantryLocationId === decodeURIComponent(retired),
    );
    if (counter !== undefined) counter.retired = true;
    return Promise.resolve(operationsEnvelope(false));
  }
  if (/\/terminal-operations$/u.test(path)) {
    assign(String(request.pantryLocationId), "sandbox_simulated");
    return Promise.resolve(operationsEnvelope(true));
  }
  return Promise.reject(new Error("Changes are off in this preview."));
}

function assign(pantryLocationId: string, targetKind: TargetKind): void {
  const counter = counters.find(
    (candidate) => candidate.pantryLocationId === pantryLocationId,
  );
  if (counter === undefined) {
    counters.push({
      pantryLocationId,
      targetKind,
      revision: 1,
      retired: false,
      paymentsLinked: true,
    });
    return;
  }
  counter.targetKind = targetKind;
  counter.revision += 1;
  counter.retired = false;
}

/** A read by the page's check; a new code is always open. */
function pairingEnvelope(deviceCodeId: string, read: boolean): unknown {
  const status =
    pairing === null || pairing.deviceCodeId !== deviceCodeId
      ? "expired"
      : !read
        ? "open"
        : pairingEnds === "expired" || Date.now() >= pairing.pairedAt
          ? pairingEnds
          : "open";
  return {
    ok: true,
    pairing: {
      deviceCodeId,
      code: "KQ7XPM",
      providerLocationId: "square_location_tokyo",
      pairBy: new Date(Date.now() + 5 * 60_000).toISOString(),
      status,
    },
  };
}

function operationsEnvelope(withConfiguration: boolean): unknown {
  const terminalOperations = {
    schemaVersion: "pantry.terminal-operations.v2",
    organisationId: "organisation_cafe_preview",
    generatedAt: new Date().toISOString(),
    counters: counters.map(counterReadback),
    unreadableAssignments: 0,
  };
  return withConfiguration
    ? { ok: true, terminalOperations, configuration: configuration() }
    : { ok: true, terminalOperations };
}

function counterReadback(counter: PreviewCounter): unknown {
  return {
    pantryLocationId: counter.pantryLocationId,
    blockedReason: counter.retired ? "assignment_retired" : null,
    assignment: {
      assignmentId: `assignment_${counter.pantryLocationId.replace(/\W/gu, "_")}`,
      revision: counter.revision,
      merchantId: "merchant_preview",
      integrationAccountId: "integration_square",
      capabilityRevision: 1,
      capabilityCurrent: true,
      providerLocationId: "square_location_tokyo",
      targetKind: counter.targetKind,
      deviceId: `device_${counter.targetKind}`,
      adapterVersion: "1",
      environment,
      healthIsObservable: counter.targetKind === "paired_physical",
    },
    credentialHealth: "active",
    paymentsLinked: counter.paymentsLinked,
  };
}

function configuration(): unknown {
  if (scenario === "blocked")
    return { kind: "blocked", reason: "commerce_system_missing" };
  return {
    kind: "ready",
    merchantId: "merchant_preview",
    environment,
    pantryLocations: ["Front counter", "Window counter", "Terrace"].map(
      (pantryLocationId) => ({
        pantryLocationId,
        currency: "JPY",
        supportedItems: [],
      }),
    ),
    squareAccounts: [
      {
        integrationAccountId: "integration_square",
        providerAccountId: "square_merchant",
        displayName: "Kissa Purin",
        locations: SQUARE_LOCATIONS,
      },
    ],
    testDevices:
      environment === "development"
        ? [
            {
              testDeviceId: "sandbox_success",
              label: "Successful payment",
              expectedOutcome: "success",
            },
            {
              testDeviceId: "sandbox_cancel",
              label: "Buyer cancels",
              expectedOutcome: "buyer_cancel",
            },
            {
              testDeviceId: "sandbox_timeout",
              label: "Checkout times out",
              expectedOutcome: "timeout",
            },
          ]
        : [],
  };
}
