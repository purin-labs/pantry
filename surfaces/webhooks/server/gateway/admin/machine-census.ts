import type { Env } from "@purin-labs/kernel/env";
import {
  jsonResponse,
  methodNotAllowed,
  notFound,
} from "@purin-labs/kernel/http";
import { configuredOrganisationDatabases } from "@purin-labs/tenancy/organisation-execution-scope";
import type {
  MachineCensus,
  MachineStateAge,
} from "@purin-labs/actor-runtime/actors/lifecycle/machine-census";
import { isAuthorizedOrganisationAdminRequest } from "@purin-labs/control/worker/gateway/request-helpers";

/** The most Actors that one census request reads. */
const CENSUS_ACTOR_LIMIT = 2_000;

type CensusActorKind = "organisation" | "session" | "case" | "connector";

type CensusActor = { machineCensus(): Promise<readonly MachineCensus[]> };

/**
 * The census of the machine states that live in Actor storage (Refactor 15,
 * S5). It reads each active Organisation, Session, Case and Connector Actor
 * in the registry of every configured regional database, and sums the rows
 * in each state that is not terminal. For each state that holds a row, it
 * also gives the oldest age, the rows past their exit, the rows past their
 * exit in an Actor with no alarm, and the rows with no time. It returns
 * counts and ages only, never content.
 */
export async function handleMachineCensus(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  if (!isAuthorizedOrganisationAdminRequest(request, env)) return notFound();
  const totals = new Map<string, Map<string, number>>();
  const ages = new Map<string, Map<string, MachineStateAge>>();
  let read = 0;
  let failed = 0;
  let truncated = false;
  for (const database of configuredOrganisationDatabases(env)) {
    const rows = await database
      .prepare(
        `SELECT object_kind AS kind, physical_object_name AS name
         FROM durable_object_registry
         WHERE lifecycle_status = 'active'
           AND object_kind IN ('organisation', 'session', 'case', 'connector')
         ORDER BY object_kind, physical_object_name
         LIMIT ?`,
      )
      .bind(CENSUS_ACTOR_LIMIT - read - failed + 1)
      .all<{ kind: CensusActorKind; name: string }>();
    for (const row of rows.results) {
      if (read + failed >= CENSUS_ACTOR_LIMIT) {
        truncated = true;
        break;
      }
      try {
        const census = await actorFor(env, row.kind, row.name).machineCensus();
        read += 1;
        for (const entry of census) {
          const states = totals.get(entry.machine) ?? new Map<string, number>();
          for (const [state, count] of Object.entries(entry.states))
            states.set(state, (states.get(state) ?? 0) + count);
          totals.set(entry.machine, states);
          addAges(ages, entry);
        }
      } catch {
        failed += 1;
      }
    }
  }
  const takenAt = Date.now();
  return jsonResponse({
    ok: true,
    takenAt: new Date(takenAt).toISOString(),
    actors: { read, failed, truncated },
    machines: Object.fromEntries(
      [...totals].map(([machine, states]) => [
        machine,
        Object.fromEntries(states),
      ]),
    ),
    ages: Object.fromEntries(
      [...ages].map(([machine, states]) => [
        machine,
        Object.fromEntries(
          [...states].map(([state, age]) => [
            state,
            {
              oldestAgeMs:
                age.oldestSince === null ? null : takenAt - age.oldestSince,
              pastExit: age.pastExit,
              pastExitNoAlarm: age.pastExitNoAlarm,
              untimed: age.untimed,
            },
          ]),
        ),
      ]),
    ),
  });
}

/** Adds one Actor's row ages to the totals of the census. */
function addAges(
  ages: Map<string, Map<string, MachineStateAge>>,
  entry: MachineCensus,
): void {
  if (entry.ages === undefined) return;
  const states = ages.get(entry.machine) ?? new Map<string, MachineStateAge>();
  for (const [state, age] of Object.entries(entry.ages)) {
    const total = states.get(state);
    states.set(
      state,
      total === undefined
        ? age
        : {
            oldestSince:
              total.oldestSince === null || age.oldestSince === null
                ? (total.oldestSince ?? age.oldestSince)
                : Math.min(total.oldestSince, age.oldestSince),
            untimed: total.untimed + age.untimed,
            pastExit: total.pastExit + age.pastExit,
            pastExitNoAlarm: total.pastExitNoAlarm + age.pastExitNoAlarm,
          },
    );
  }
  ages.set(entry.machine, states);
}

function actorFor(env: Env, kind: CensusActorKind, name: string): CensusActor {
  switch (kind) {
    case "organisation":
      return env.ORGANISATION.getByName(name);
    case "session":
      return env.SESSION.getByName(name);
    case "case":
      return env.CASE.getByName(name);
    case "connector":
      return env.CONNECTOR.getByName(name);
  }
}
