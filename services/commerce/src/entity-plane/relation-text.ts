import type { CommerceDatabase } from "../database.ts";
import { foldCommerceUnicodeV1 } from "./lexicon.ts";

export function writeCommerceEntityRelationText(
  database: CommerceDatabase,
  merchantId: string,
  entityOrigin: "system" | "custom",
  entityType: string,
  entityId: string,
  revision: number,
  updatedAt: string,
  displayName: string,
): void {
  const folded = foldCommerceUnicodeV1(displayName);
  if (folded.kind === "error") {
    throw new Error(
      `commerce_unicode_v1 folding failed: ${folded.error.reason}`,
    );
  }
  database
    .prepare(
      `INSERT INTO commerce_entity_relation_index (
       merchant_id, entity_origin, entity_type, entity_id,
       revision, updated_at, display_name, display_name_folded,
       search_text_folded, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (merchant_id, entity_origin, entity_type, entity_id) DO UPDATE SET
       revision = excluded.revision,
       updated_at = excluded.updated_at,
       display_name = excluded.display_name,
       display_name_folded = excluded.display_name_folded,
       search_text_folded = excluded.search_text_folded`,
    )
    .run(
      merchantId,
      entityOrigin,
      entityType,
      entityId,
      revision,
      timestampMillis(updatedAt),
      displayName,
      folded.value,
      folded.value,
    );
}

export function deleteCommerceEntityRelationText(
  database: CommerceDatabase,
  merchantId: string,
  entityOrigin: "system" | "custom",
  entityType: string,
  entityId: string,
): void {
  database
    .prepare(
      `DELETE FROM commerce_entity_relation_index
     WHERE merchant_id = ? AND entity_origin = ? AND entity_type = ? AND entity_id = ?`,
    )
    .run(merchantId, entityOrigin, entityType, entityId);
}

function timestampMillis(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("commerce entity relation timestamp is invalid");
  }
  return parsed;
}
