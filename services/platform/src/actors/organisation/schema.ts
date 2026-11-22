import { createMailEvaluationSchema } from "@purin-labs/area-inbox/server/mail-inbox/evaluation";
import { createActionLedgerSchema } from "@purin-labs/authority/actors/action-ledger";
import { createCueDeliverySchema } from "@purin-labs/agent/actors/cue-delivery";
import { createCommerceProjectionSchema } from "../commerce-projection";
import { createShopifyLocationObservationSchema } from "../../shopify/location-observation";
import type { SchemaTransaction } from "@purin-labs/actor-runtime/actors/schema-migrations";
import { createCaseContextDiscoveryEvaluationSchema } from "@purin-labs/agent/case-context-discovery/evaluation-store";
import { createEvalSchema } from "@purin-labs/area-brain/server/evals/store";
import { createMemorySchema } from "@purin-labs/area-brain/server/memory/store";
import { createCaseContextCollectionEvidenceSchema } from "@purin-labs/agent/case-context-discovery/evidence";
import { createTypeSafeConnectionSchema } from "@purin-labs/agent/integrations/typesafe/connection";
import { createJevScreenRelevanceSchema } from "../../jev-features/screen-relevance";
import { createJevUsageRecordSchema } from "../../jev-features/usage-records";
import { createJevPaidUseSchema } from "@purin-labs/agent/jev-features/paid-use";
import { createCaseContextCollectionRelationshipSchema } from "@purin-labs/agent/case-context-discovery/relationships";

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
