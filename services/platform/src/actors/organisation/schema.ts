import { createMailEvaluationSchema } from "../../mail-inbox/evaluation";
import { createActionLedgerSchema } from "../action-ledger";
import { createCueDeliverySchema } from "../cue-delivery";
import { createCommerceProjectionSchema } from "../commerce-projection";
import { createShopifyLocationObservationSchema } from "../shopify-location-observation";
import type { SchemaTransaction } from "../schema-migrations";
import { createCaseContextDiscoveryEvaluationSchema } from "../../case-context-discovery/evaluation-store";
import { createEvalSchema } from "../../evals/store";
import { createMemorySchema } from "../../memory/store";
import { createCaseContextCollectionEvidenceSchema } from "../../case-context-discovery/evidence";
import { createTypeSafeConnectionSchema } from "../../integrations/typesafe/connection";
import { createJevScreenRelevanceSchema } from "../../jev-features/screen-relevance";
import { createJevUsageRecordSchema } from "../../jev-features/usage-records";
import { createJevPaidUseSchema } from "../../jev-features/paid-use";
import { createCaseContextCollectionRelationshipSchema } from "../../case-context-discovery/relationships";

export function createOrganisationSchema(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS state_object_policy_export_barrier (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
  )`);
  const transaction = schemaTransaction(storage, sql);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS organisation_meta (
      organisation_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS organisation_policy_head (
      organisation_id TEXT PRIMARY KEY,
      active_version INTEGER NOT NULL,
      restriction_version INTEGER NOT NULL,
      digest TEXT NOT NULL,
      body TEXT NOT NULL,
      activated_at INTEGER NOT NULL
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS organisation_harness_history_budget_warning (
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
      inline_bytes INTEGER NOT NULL CHECK (inline_bytes >= 0),
      hard_limit INTEGER NOT NULL CHECK (hard_limit IN (0, 1)),
      warning_at INTEGER NOT NULL CHECK (warning_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= warning_at),
      PRIMARY KEY (organisation_id, session_id)
    )`,
  );
  createActionLedgerSchema(sql);
  createCueDeliverySchema(sql, transaction);
  transaction(createCaseContextDiscoveryEvaluationSchema.bind(null, sql));
  transaction(createTypeSafeConnectionSchema.bind(null, sql));
  transaction(createJevScreenRelevanceSchema.bind(null, sql));
  transaction(createJevUsageRecordSchema.bind(null, sql));
  transaction(createJevPaidUseSchema.bind(null, sql));
  transaction(createMailEvaluationSchema.bind(null, sql));
  transaction(createCaseContextCollectionRelationshipSchema.bind(null, sql));
  transaction(createCaseContextCollectionEvidenceSchema.bind(null, sql));
  transaction(createMemorySchema.bind(null, sql));
  transaction(createEvalSchema.bind(null, sql));
  createCommerceProjectionSchema(sql, transaction);
  createShopifyLocationObservationSchema(sql);
}

export function schemaTransaction(
  storage: DurableObjectStorage,
  sql: SqlStorage,
): SchemaTransaction {
  if (typeof storage.transactionSync === "function") {
    return storage.transactionSync.bind(storage);
  }
  if ("transactionSync" in sql && typeof sql.transactionSync === "function") {
    return sql.transactionSync.bind(sql);
  }
  throw new Error("organisation_schema_transaction_missing");
}
