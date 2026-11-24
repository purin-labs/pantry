import type { SavedBakeryRunQuery } from "../../contract/saved-bakery-runs";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import { jsonSchema } from "@purin-labs/agent-tools/define-tool";
import { defineKitchenTool } from "./services";

export const savedBakeryRunRead = defineKitchenTool({
  name: "bakery_saved_run_read",
  description:
    'Read saved Kitchen simulation assumptions with source identity and content revision, without navigation or physics. For the most recently saved run, use id="latest", cursor=null: this resolves and reads it in one call; no catalogue read is needed. For an identified run, use its exact ID and cursor=null. Ask which run when ambiguous. Use id=null to list up to eight runs, cursor=null for the first page. Compare selected orders with saved assumptions; real capacity remains unverified.',
  input: jsonSchema({
    type: "object",
    properties: {
      id: { type: ["string", "null"] },
      cursor: { type: ["string", "null"] },
    },
    required: ["id", "cursor"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseSavedBakeryRunArgs([input]),
  effect: "read",
  rerun: { kind: "none" },
  selection: { kind: "capability", capability: CAPABILITY_KEYS.workspaceQuery },
  unavailable: "Saved Kitchen reads are unavailable",
  handler: ({ readSavedBakeryRun }) =>
    readSavedBakeryRun === undefined
      ? undefined
      : (request) => readSavedBakeryRun(request),
  strictFirst: true,
});

function parseSavedBakeryRunArgs(
  args: readonly unknown[],
): SavedBakeryRunQuery {
  const raw = args[0];
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    !hasExactKeys(raw, ["id", "cursor"])
  ) {
    throw new TypeError("Saved run query requires id and cursor.");
  }
  if (
    raw.id === null &&
    (raw.cursor === null ||
      (typeof raw.cursor === "string" &&
        raw.cursor.length > 0 &&
        raw.cursor.length <= 2048))
  ) {
    return { kind: "list", cursor: raw.cursor };
  }
  if (raw.id === "latest" && raw.cursor === null) {
    return { kind: "latest" };
  }
  if (
    typeof raw.id === "string" &&
    /^[0-9a-f]{64}$/u.test(raw.id) &&
    raw.cursor === null
  ) {
    return { kind: "read", id: raw.id };
  }
  throw new TypeError(
    "Select the latest or one exact saved run with cursor=null, or list with a bounded cursor.",
  );
}
