/**
 * The purge catalogue of the Worker (Refactor 17): the purge entries of each
 * table owner, joined in the order of `order`. The lifecycle port gives it
 * to tenancy (`organisation-lifecycle-parts.ts`), and `pnpm
 * lint:purge-catalogue` reads it. It holds the entries of the Worker's own
 * tables too.
 */
import { ACTOR_RUNTIME_PURGE_ENTRIES } from "@purin-labs/actor-runtime/data/purge-entries";
import { AGENT_PURGE_ENTRIES } from "@purin-labs/agent/data/purge-entries";
import { CAFE_PURGE_ENTRIES } from "@purin-labs/area-cafe/server/data/purge-entries";
import { COMMERCE_PURGE_ENTRIES } from "@purin-labs/area-commerce/server/data/purge-entries";
import { DEVICES_PURGE_ENTRIES } from "@purin-labs/area-devices/server/purge-entries";
import { INBOX_PURGE_ENTRIES } from "@purin-labs/area-inbox/server/data/purge-entries";
import { INTEGRATIONS_PURGE_ENTRIES } from "@purin-labs/area-integrations/server/data/purge-entries";
import { KITCHEN_PURGE_ENTRIES } from "@purin-labs/area-kitchen/server/data/purge-entries";
import { ORGANISATION_PURGE_ENTRIES } from "@purin-labs/area-organisation/server/data/purge-entries";
import { AUTHORITY_PURGE_ENTRIES } from "@purin-labs/authority/data/purge-entries";
import { CONNECTIONS_PURGE_ENTRIES } from "@purin-labs/connections/data/purge-entries";
import { CONVERSATION_PURGE_ENTRIES } from "@purin-labs/conversation/data/purge-entries";
import { SLACK_PURGE_ENTRIES } from "@purin-labs/surface-slack/server/data/purge-entries";
import { VOICE_PURGE_ENTRIES } from "@purin-labs/surface-voice/server/purge-entries";
import {
  joinPurgeCatalogue,
  TENANCY_PURGE_ENTRIES,
  type PurgeCatalogueEntry,
} from "@purin-labs/tenancy/data/purge-catalogue";

/** The entries of the tables of the Worker. */
const WORKER_PURGE_ENTRIES = [
  {
    order: 900,
    table: "thread_binding",
    action: "erase",
    statement: "DELETE FROM thread_binding",
  },
  {
    order: 910,
    table: "thread_file_watch",
    action: "erase",
    statement: "DELETE FROM thread_file_watch",
  },
  {
    order: 920,
    table: "tool_call",
    action: "erase",
    statement: "DELETE FROM tool_call",
  },
] as const satisfies readonly PurgeCatalogueEntry[];

export const PURGE_CATALOGUE = joinPurgeCatalogue(
  TENANCY_PURGE_ENTRIES,
  ACTOR_RUNTIME_PURGE_ENTRIES,
  CONNECTIONS_PURGE_ENTRIES,
  AUTHORITY_PURGE_ENTRIES,
  AGENT_PURGE_ENTRIES,
  CONVERSATION_PURGE_ENTRIES,
  CAFE_PURGE_ENTRIES,
  COMMERCE_PURGE_ENTRIES,
  DEVICES_PURGE_ENTRIES,
  INBOX_PURGE_ENTRIES,
  INTEGRATIONS_PURGE_ENTRIES,
  KITCHEN_PURGE_ENTRIES,
  ORGANISATION_PURGE_ENTRIES,
  SLACK_PURGE_ENTRIES,
  VOICE_PURGE_ENTRIES,
  WORKER_PURGE_ENTRIES,
);
