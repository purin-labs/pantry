import { controlRead } from "../../control-client";
import type {
  TerminalConfigurationRequest,
  TerminalCounterReadback,
  TerminalPairingReadback,
  TerminalPairingRequest,
} from "@seams/control-api";
import {
  type TerminalOperations,
  type TerminalOperationsView,
  parseOperationsEnvelope,
  parseOperationsOnlyEnvelope,
  parsePairingEnvelope,
} from "@seams/control-api/portal/terminals";

export type TerminalMutationTransport = (
  path: string,
  method: "POST",
  body: unknown,
  intent: string,
) => Promise<unknown>;

export type TerminalReadTransport = (path: string) => Promise<unknown>;

export async function readTerminalOperations(
  organisationId: string,
  read: TerminalReadTransport = controlRead,
): Promise<TerminalOperationsView> {
  return parseOperationsEnvelope(
    await read(terminalOperationsPath(organisationId)),
  );
}

export async function configureSandboxTerminal(
  organisationId: string,
  selection: TerminalConfigurationRequest,
  mutate: TerminalMutationTransport,
): Promise<TerminalOperationsView> {
  return parseOperationsEnvelope(
    await mutate(
      terminalOperationsPath(organisationId),
      "POST",
      selection,
      `terminal-configure:${selection.satyrLocationId}:${selection.integrationAccountId}:${selection.providerLocationId}:${selection.testDeviceId}`,
    ),
  );
}

/** Asks Square for a code that pairs a physical Terminal (production). */
export async function startTerminalPairing(
  organisationId: string,
  request: TerminalPairingRequest,
  mutate: TerminalMutationTransport,
): Promise<TerminalPairingReadback> {
  const raw = await mutate(
    `${terminalOperationsPath(organisationId)}/pairings`,
    "POST",
    request,
    `terminal-pairing:${request.satyrLocationId}:${request.providerLocationId}:${Date.now()}`,
  );
  return parsePairingEnvelope(raw);
}

/** The pairing code as Square has it now. */
export async function readTerminalPairing(
  organisationId: string,
  deviceCodeId: string,
  integrationAccountId: string,
  read: TerminalReadTransport = controlRead,
): Promise<TerminalPairingReadback> {
  return parsePairingEnvelope(
    await read(
      `${terminalOperationsPath(organisationId)}/pairings/${encodeURIComponent(deviceCodeId)}?integrationAccountId=${encodeURIComponent(integrationAccountId)}`,
    ),
  );
}

/** Gives the counter the device that Square paired with the code. */
export async function activateTerminalPairing(
  organisationId: string,
  deviceCodeId: string,
  selection: Readonly<{
    satyrLocationId: string;
    integrationAccountId: string;
  }>,
  mutate: TerminalMutationTransport,
): Promise<TerminalOperationsView> {
  return parseOperationsEnvelope(
    await mutate(
      `${terminalOperationsPath(organisationId)}/pairings/${encodeURIComponent(deviceCodeId)}/activation`,
      "POST",
      selection,
      `terminal-pairing-activation:${deviceCodeId}:${selection.satyrLocationId}`,
    ),
  );
}

/**
 * Stop a counter taking further payments.
 *
 * The platform refuses while a collection is still unresolved, and that refusal
 * is surfaced rather than retried: the operator has to settle the payment
 * before the counter can be stood down.
 */
export async function retireTerminalCounter(
  organisationId: string,
  counter: TerminalCounterReadback,
  mutate: TerminalMutationTransport,
): Promise<TerminalOperations> {
  return parseOperationsOnlyEnvelope(
    await mutate(
      `${terminalOperationsPath(organisationId)}/${encodeURIComponent(counter.satyrLocationId)}/retirement`,
      "POST",
      {},
      `terminal-retire:${counter.assignment.assignmentId}:${counter.assignment.revision}`,
    ),
  );
}

function terminalOperationsPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/terminal-operations`;
}
