import type { MachineDefinition } from "@purin-labs/std/state-machine";

/**
 * A merchant's Square connection (Refactor 15, small fixes). Square tells why
 * a connection stops working, and each cause asks the operator for a
 * different step, so the connection keeps the cause. Only a new connection
 * (`grant`) leaves a state that is not `connected`; the operator connects
 * Square again on the Integrations page.
 */
export const SQUARE_CONNECTION_MACHINE = {
  name: "square_connection",
  owner: "services/commerce/src/payments/square/square-connection.ts",
  store: { table: "square_connection", key: "merchant_id", column: "state" },
  states: {
    connected: {
      kind: "initial",
      meaning:
        "Square accepts the token, and it holds every scope that Commerce uses.",
      exit: { kind: "person", surface: "portal_integrations" },
    },
    scope_missing: {
      kind: "intermediate",
      meaning:
        "Square accepts the token, but it lacks a scope that Commerce uses, for example PAYOUTS_READ.",
      exit: { kind: "person", surface: "portal_integrations" },
    },
    refresh_failed: {
      kind: "intermediate",
      meaning:
        "Square refused to refresh the token. The token works until it expires.",
      exit: { kind: "person", surface: "portal_integrations" },
    },
    revoked: {
      kind: "intermediate",
      meaning:
        "Square refuses the token: the seller removed the application in Square.",
      exit: { kind: "person", surface: "portal_integrations" },
    },
  },
  transitions: [
    {
      // A connection or a refresh with every scope, or with a scope list
      // that Square did not show.
      event: "grant",
      from: ["connected", "scope_missing", "refresh_failed", "revoked"],
      to: "connected",
      by: ["partner", "system"],
      guards: [],
    },
    {
      // A connection or a refresh whose scope list lacks a scope.
      event: "grant_without_scope",
      from: ["connected", "scope_missing", "refresh_failed", "revoked"],
      to: "scope_missing",
      by: ["partner", "system"],
      guards: [],
    },
    {
      // A call that Square refused with INSUFFICIENT_SCOPES. A token that
      // Square will not refresh keeps that cause, which is the worse one.
      event: "scope_refused",
      from: ["connected", "scope_missing"],
      to: "scope_missing",
      by: ["provider"],
      guards: [],
    },
    {
      event: "refresh_refused",
      from: ["connected", "scope_missing", "refresh_failed"],
      to: "refresh_failed",
      by: ["provider"],
      guards: [],
    },
    {
      event: "token_refused",
      from: ["connected", "scope_missing", "refresh_failed", "revoked"],
      to: "revoked",
      by: ["provider"],
      guards: [],
    },
  ],
} as const satisfies MachineDefinition;

export type SquareConnectionState =
  keyof typeof SQUARE_CONNECTION_MACHINE.states;
export type SquareConnectionEvent =
  (typeof SQUARE_CONNECTION_MACHINE.transitions)[number]["event"];
