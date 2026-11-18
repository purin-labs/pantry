import type { OrganisationDatabase } from "../database-handles";
import { resolveActorExecutionAdmission } from "./actor-placement-admission";
import {
  activateActorRegistryEntry,
  listOrganisationActorRegistryEntries,
  quarantineActorRegistryEntry,
  actorActivationRequest,
  type ActorRegistryEntry,
  type ActorRegistryError,
  type ActorRegistryId,
} from "./actor-registry";
import type { OrganisationId } from "../ids";
import type { Result } from "../result";
import {
  actorStubForRegistryEntry,
  type ActorNamespaces,
} from "./actor-router";
import type { VariantBy } from "@seams/type-utils";
import { assertNever } from "@seams/std";

type ReservedRegistryEntry = VariantBy<
  ActorRegistryEntry,
  "lifecycleStatus",
  "reserved"
>;

type ActorRegistryInventoryBase = {
  readonly registryId: ActorRegistryId;
  readonly identity: ActorRegistryEntry["identity"];
  readonly physicalObjectName: string;
  readonly placement: ActorRegistryEntry["placement"];
  readonly schemaVersion: number;
  readonly stateVersion: number;
  readonly reservedAt: number;
};

export type ActorRegistryInventoryEntry = ActorRegistryInventoryBase &
  (
    | {
        readonly lifecycleStatus: "reserved";
        readonly activatedAt: null;
        readonly exportingAt: null;
        readonly retiredAt: null;
        readonly quarantinedAt: null;
        readonly quarantineReason: null;
      }
    | {
        readonly lifecycleStatus: "active";
        readonly activatedAt: number;
        readonly exportingAt: null;
        readonly retiredAt: null;
        readonly quarantinedAt: null;
        readonly quarantineReason: null;
      }
    | {
        readonly lifecycleStatus: "exporting";
        readonly activatedAt: number;
        readonly exportingAt: number;
        readonly retiredAt: null;
        readonly quarantinedAt: null;
        readonly quarantineReason: null;
      }
    | {
        readonly lifecycleStatus: "retired";
        readonly activatedAt: number;
        readonly exportingAt: number;
        readonly retiredAt: number;
        readonly quarantinedAt: null;
        readonly quarantineReason: null;
      }
    | {
        readonly lifecycleStatus: "quarantined";
        readonly activatedAt: number | null;
        readonly exportingAt: number | null;
        readonly retiredAt: null;
        readonly quarantinedAt: number;
        readonly quarantineReason: string;
      }
  );

type ActorRegistryReconciliationOutcome =
  | {
      readonly kind: "skipped";
      readonly registryId: ActorRegistryId;
      readonly lifecycleStatus: Exclude<
        ActorRegistryEntry["lifecycleStatus"],
        "reserved"
      >;
      readonly reason: "terminal_or_active";
    }
  | {
      readonly kind: "skipped";
      readonly registryId: ActorRegistryId;
      readonly lifecycleStatus: "reserved";
      readonly reason: "reservation_fresh";
    }
  | {
      readonly kind: "activated";
      readonly registryId: ActorRegistryId;
      readonly stateVersion: number;
    }
  | {
      readonly kind: "quarantined";
      readonly registryId: ActorRegistryId;
      readonly reason: "activation_conflict_during_orphan_repair";
    };

type ActorRegistryReconciliationReport = {
  readonly organisationId: OrganisationId;
  readonly inspectedAt: number;
  readonly staleReservationAgeMs: number;
  readonly inventory: readonly ActorRegistryInventoryEntry[];
  readonly outcomes: readonly ActorRegistryReconciliationOutcome[];
};

export type ActorRegistryReconciliationError =
  | ActorRegistryError
  | {
      readonly code: "registry_activation_unreachable";
      readonly registryId: ActorRegistryId;
    };

export async function inspectOrganisationActorRegistry(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
}): Promise<
  Result<readonly ActorRegistryInventoryEntry[], ActorRegistryError>
> {
  const entries = await listOrganisationActorRegistryEntries(input);

  return entries.ok
    ? { ok: true, value: entries.value.map(actorRegistryInventoryEntry) }
    : entries;
}

export async function reconcileOrganisationActorRegistry(input: {
  readonly db: OrganisationDatabase;
  readonly namespaces: ActorNamespaces;
  readonly organisationId: OrganisationId;
  readonly now: number;
  readonly staleReservationAgeMs: number;
}): Promise<
  Result<ActorRegistryReconciliationReport, ActorRegistryReconciliationError>
> {
  const entries = await listOrganisationActorRegistryEntries({
    db: input.db,
    organisationId: input.organisationId,
  });

  if (!entries.ok) {
    return entries;
  }

  const outcomes: ActorRegistryReconciliationOutcome[] = [];

  for (const entry of entries.value) {
    const outcome = await reconcileRegistryEntry({
      db: input.db,
      namespaces: input.namespaces,
      entry,
      now: input.now,
      staleReservationAgeMs: input.staleReservationAgeMs,
    });

    if (!outcome.ok) {
      return outcome;
    }

    outcomes.push(outcome.value);
  }

  const inventory = await inspectOrganisationActorRegistry({
    db: input.db,
    organisationId: input.organisationId,
  });

  return inventory.ok
    ? {
        ok: true,
        value: {
          organisationId: input.organisationId,
          inspectedAt: input.now,
          staleReservationAgeMs: input.staleReservationAgeMs,
          inventory: inventory.value,
          outcomes,
        },
      }
    : inventory;
}

async function reconcileRegistryEntry(input: {
  readonly db: OrganisationDatabase;
  readonly namespaces: ActorNamespaces;
  readonly entry: ActorRegistryEntry;
  readonly now: number;
  readonly staleReservationAgeMs: number;
}): Promise<
  Result<ActorRegistryReconciliationOutcome, ActorRegistryReconciliationError>
> {
  switch (input.entry.lifecycleStatus) {
    case "reserved":
      return reconcileReservedRegistryEntry({
        db: input.db,
        namespaces: input.namespaces,
        entry: input.entry,
        now: input.now,
        staleReservationAgeMs: input.staleReservationAgeMs,
      });
    case "active":
    case "exporting":
    case "retired":
    case "quarantined":
      return {
        ok: true,
        value: {
          kind: "skipped",
          registryId: input.entry.registryId,
          lifecycleStatus: input.entry.lifecycleStatus,
          reason: "terminal_or_active",
        },
      };
    default:
      return assertNever(input.entry);
  }
}

async function reconcileReservedRegistryEntry(input: {
  readonly db: OrganisationDatabase;
  readonly namespaces: ActorNamespaces;
  readonly entry: ReservedRegistryEntry;
  readonly now: number;
  readonly staleReservationAgeMs: number;
}): Promise<
  Result<ActorRegistryReconciliationOutcome, ActorRegistryReconciliationError>
> {
  if (input.now - input.entry.reservedAt < input.staleReservationAgeMs) {
    return {
      ok: true,
      value: {
        kind: "skipped",
        registryId: input.entry.registryId,
        lifecycleStatus: "reserved",
        reason: "reservation_fresh",
      },
    };
  }

  const admission = await resolveActorExecutionAdmission(
    input.db,
    input.entry.identity.organisationId,
    input.entry.placement,
  );
  if (!admission.ok) return admission;
  const object = actorStubForRegistryEntry({
    namespaces: input.namespaces,
    entry: input.entry,
  });
  let activated;

  try {
    activated = await object.activate(
      actorActivationRequest(input.entry, input.now, admission.value),
    );
  } catch {
    return {
      ok: false,
      error: {
        code: "registry_activation_unreachable",
        registryId: input.entry.registryId,
      },
    };
  }

  if (!activated.ok) {
    if (activated.error.code === "activation_placement_conflict")
      return { ok: false, error: { code: "registry_placement_conflict" } };
    const quarantined = await quarantineActorRegistryEntry({
      db: input.db,
      registryId: input.entry.registryId,
      expectedFenceToken: input.entry.fenceToken,
      reason: "activation_conflict_during_orphan_repair",
      now: input.now,
    });

    return quarantined.ok
      ? {
          ok: true,
          value: {
            kind: "quarantined",
            registryId: input.entry.registryId,
            reason: "activation_conflict_during_orphan_repair",
          },
        }
      : quarantined;
  }

  const published = await activateActorRegistryEntry({
    db: input.db,
    admission: admission.value,
    registryId: input.entry.registryId,
    activationToken: input.entry.activationToken,
    stateVersion: activated.value.stateVersion,
    now: input.now,
  });

  return published.ok
    ? {
        ok: true,
        value: {
          kind: "activated",
          registryId: published.value.registryId,
          stateVersion: published.value.stateVersion,
        },
      }
    : published;
}

function actorRegistryInventoryEntry(
  entry: ActorRegistryEntry,
): ActorRegistryInventoryEntry {
  switch (entry.lifecycleStatus) {
    case "reserved":
      return {
        registryId: entry.registryId,
        identity: entry.identity,
        physicalObjectName: entry.physicalObjectName,
        placement: entry.placement,
        schemaVersion: entry.schemaVersion,
        stateVersion: entry.stateVersion,
        lifecycleStatus: "reserved",
        reservedAt: entry.reservedAt,
        activatedAt: null,
        exportingAt: null,
        retiredAt: null,
        quarantinedAt: null,
        quarantineReason: null,
      };
    case "active":
      return {
        registryId: entry.registryId,
        identity: entry.identity,
        physicalObjectName: entry.physicalObjectName,
        placement: entry.placement,
        schemaVersion: entry.schemaVersion,
        stateVersion: entry.stateVersion,
        lifecycleStatus: "active",
        reservedAt: entry.reservedAt,
        activatedAt: entry.activatedAt,
        exportingAt: null,
        retiredAt: null,
        quarantinedAt: null,
        quarantineReason: null,
      };
    case "exporting":
      return {
        registryId: entry.registryId,
        identity: entry.identity,
        physicalObjectName: entry.physicalObjectName,
        placement: entry.placement,
        schemaVersion: entry.schemaVersion,
        stateVersion: entry.stateVersion,
        lifecycleStatus: "exporting",
        reservedAt: entry.reservedAt,
        activatedAt: entry.activatedAt,
        exportingAt: entry.exportingAt,
        retiredAt: null,
        quarantinedAt: null,
        quarantineReason: null,
      };
    case "retired":
      return {
        registryId: entry.registryId,
        identity: entry.identity,
        physicalObjectName: entry.physicalObjectName,
        placement: entry.placement,
        schemaVersion: entry.schemaVersion,
        stateVersion: entry.stateVersion,
        lifecycleStatus: "retired",
        reservedAt: entry.reservedAt,
        activatedAt: entry.activatedAt,
        exportingAt: entry.exportingAt,
        retiredAt: entry.retiredAt,
        quarantinedAt: null,
        quarantineReason: null,
      };
    case "quarantined":
      return {
        registryId: entry.registryId,
        identity: entry.identity,
        physicalObjectName: entry.physicalObjectName,
        placement: entry.placement,
        schemaVersion: entry.schemaVersion,
        stateVersion: entry.stateVersion,
        lifecycleStatus: "quarantined",
        reservedAt: entry.reservedAt,
        activatedAt: entry.activatedAt,
        exportingAt: entry.exportingAt,
        retiredAt: null,
        quarantinedAt: entry.quarantinedAt,
        quarantineReason: entry.quarantineReason,
      };
    default:
      return assertNever(entry);
  }
}
