import type {
  CommerceEntityPlaneCommand,
  CommerceEntityPlaneError,
  CommerceCommandResult,
  MerchantRevision,
  CommerceEntityPlaneDeliveryId,
  CommerceEntityPlaneObservationV1,
  CommerceMutationReceiptKeyId,
  CommerceMutationReceiptSignature,
  CommerceMutationReceiptSigner,
  CommerceMutationReceiptV1,
} from "@purin-labs/commerce-contracts";
import {
  commerceDeliverySignaturePayload,
  parseEntityPlaneObservation,
  type CommerceDeliveryV1,
} from "@purin-labs/commerce-client";
import type { CommerceSigner } from "../commerce-authority/contracts.ts";
import type { CommerceDatabase } from "../database.ts";
import type {
  EntityPlaneChangeOperation,
  EntityPlaneChangeResource,
  EntityPlaneCommandRequest,
} from "./entity-types.ts";
import { parsePositiveRevision, parsePositiveText } from "./parsers.ts";
import { refreshCommerceRelationshipRelation } from "./commerce-relationship-relation.ts";
import { validateCommerceMutationReceiptWithLexicon } from "./lexicon.ts";
import type { Variant } from "@purin-labs/type-utils";

export type EntityPlaneMutationRequest = Omit<
  EntityPlaneCommandRequest,
  "authority"
>;
type MutationTarget = CommerceMutationReceiptV1["target"];
export type CommandKind = CommerceEntityPlaneCommand["kind"];
export type CommandRequest<K extends CommandKind> = Omit<
  EntityPlaneMutationRequest,
  "command"
> & {
  command: Variant<CommerceEntityPlaneCommand, K>;
};

type StoredReceiptRow = Readonly<{
  commandDigest: string;
  receiptJson: string;
}>;
type EntityPlaneSigner = CommerceMutationReceiptSigner;
type SignedEntityPlaneReceipt = CommerceMutationReceiptV1 &
  Readonly<{
    deliveryId: CommerceEntityPlaneDeliveryId | null;
    signer: EntityPlaneSigner;
  }>;
type EntityPlaneDelivery = Omit<
  Extract<
    CommerceDeliveryV1,
    { schemaVersion: "underclerk.commerce-delivery.v2" }
  >,
  "observations"
> &
  Readonly<{
    observations: readonly CommerceEntityPlaneObservationV1[];
  }>;
type UnsignedMutationReceipt = Omit<
  CommerceMutationReceiptV1,
  "deliveryId" | "signer"
>;
type UnsignedEntityPlaneReceipt = UnsignedMutationReceipt &
  Readonly<{
    deliveryId: CommerceEntityPlaneDeliveryId | null;
  }>;

type EntityPlaneSettlementOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  signer: CommerceSigner;
}>;

export class EntityPlaneSettlement {
  readonly #database: CommerceDatabase;
  readonly #now: () => string;
  readonly #signer: CommerceSigner;

  constructor(options: EntityPlaneSettlementOptions) {
    this.#database = options.database;
    this.#now = options.now;
    this.#signer = options.signer;
  }

  readReplay(
    request: EntityPlaneMutationRequest,
  ): CommerceCommandResult | undefined {
    const row = this.#database
      .prepare(
        `SELECT command_digest AS commandDigest, receipt_json AS receiptJson
       FROM command_receipt WHERE merchant_id = ? AND idempotency_key = ?`,
      )
      .get<StoredReceiptRow>(request.merchantId, request.commandId);
    if (row === undefined) return undefined;
    if (row.commandDigest !== commandDigest(request.command))
      return rejected({ code: "duplicate_identity" });
    const receipt = parseStoredReceipt(row.receiptJson);
    return {
      status: "accepted",
      receipt: signEntityPlaneReceipt(
        {
          commandId: receipt.commandId,
          outcome: "already_applied",
          target: receipt.target,
          merchantRevision: receipt.merchantRevision,
          committedAt: receipt.committedAt,
        },
        receipt.deliveryId,
        this.#signer,
      ),
    };
  }

  commit(
    request: EntityPlaneMutationRequest,
    previousRevision: number,
    target: MutationTarget,
    resource: EntityPlaneChangeResource,
    operation: EntityPlaneChangeOperation,
    observation: CommerceEntityPlaneObservationV1 | undefined,
    write: () => void | CommerceEntityPlaneError,
  ): CommerceCommandResult {
    const committedAt = this.#now();
    const merchantRevision = previousRevision + 1;
    const unsignedReceipt: UnsignedMutationReceipt = {
      commandId: request.commandId,
      outcome: "applied",
      target,
      merchantRevision: parsePositiveRevision<MerchantRevision>(
        merchantRevision,
        "merchantRevision",
      ),
      committedAt,
    };
    const delivery =
      observation === undefined
        ? undefined
        : signObservationDelivery(
            {
              schemaVersion: "underclerk.commerce-delivery.v2",
              deliveryId: entityPlaneDeliveryId(
                request.merchantId,
                request.commandId,
                merchantRevision,
              ),
              merchantId: request.merchantId,
              merchantRevision,
              observedAt: committedAt,
              observations: [observation],
            },
            this.#signer,
          );
    const receipt = signEntityPlaneReceipt(
      unsignedReceipt,
      delivery === undefined
        ? null
        : parsePositiveText<CommerceEntityPlaneDeliveryId>(
            delivery.deliveryId,
            "deliveryId",
          ),
      this.#signer,
    );
    const changeId = `${request.merchantId}:${request.commandId}`;
    try {
      this.#database.transaction(() => {
        const writeError = write();
        if (writeError !== undefined)
          throw new EntityPlaneCommitRejection(writeError);
        refreshCommerceRelationshipRelation(this.#database, request.merchantId);
        const updated = this.#database
          .prepare(
            `UPDATE merchant SET revision = ?, updated_at = ?
           WHERE merchant_id = ? AND revision = ?`,
          )
          .run(
            merchantRevision,
            committedAt,
            request.merchantId,
            previousRevision,
          );
        if (updated.changes !== 1)
          throw new Error(
            "Merchant revision changed while committing entity-plane command",
          );
        this.#database
          .prepare(
            `INSERT INTO entity_plane_change (
             merchant_id, change_id, merchant_revision, change_kind,
             resource_id, metadata_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            request.merchantId,
            changeId,
            merchantRevision,
            resource.kind,
            resourceId(resource),
            JSON.stringify({ operation, resource }),
            committedAt,
          );
        this.#database
          .prepare(
            `INSERT INTO command_receipt (
             merchant_id, idempotency_key, command_digest, receipt_json, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            request.merchantId,
            request.commandId,
            commandDigest(request.command),
            commandJson(receipt),
            committedAt,
          );
        if (delivery !== undefined)
          insertEntityPlaneDelivery(this.#database, delivery);
      });
    } catch (error) {
      if (error instanceof EntityPlaneCommitRejection)
        return rejected(error.error);
      throw error;
    }
    return { status: "accepted", receipt };
  }
}

export function commandJson(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}

function insertEntityPlaneDelivery(
  database: CommerceDatabase,
  delivery: EntityPlaneDelivery,
): void {
  database
    .prepare(
      `INSERT INTO observation_outbox (
       delivery_id, merchant_id, merchant_revision, delivery_json, status, created_at
     ) VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      delivery.deliveryId,
      delivery.merchantId,
      delivery.merchantRevision,
      commandJson(delivery),
      delivery.observedAt,
    );
}

function entityPlaneDeliveryId(
  merchantId: string,
  commandId: string,
  merchantRevision: number,
): CommerceEntityPlaneDeliveryId {
  return parsePositiveText<CommerceEntityPlaneDeliveryId>(
    `entity_plane:${merchantId}:${merchantRevision}:${commandId}`,
    "deliveryId",
  );
}

function signEntityPlaneReceipt(
  receipt: UnsignedMutationReceipt,
  deliveryId: CommerceEntityPlaneDeliveryId | null,
  signer: CommerceSigner,
): SignedEntityPlaneReceipt {
  const unsigned: UnsignedEntityPlaneReceipt = { ...receipt, deliveryId };
  return {
    ...unsigned,
    signer: {
      keyId: parsePositiveText<CommerceMutationReceiptKeyId>(
        signer.keyId,
        "receipt.signer.keyId",
      ),
      algorithm: "ed25519",
      signature: parsePositiveText<CommerceMutationReceiptSignature>(
        signer.sign(entityPlaneReceiptSignaturePayload(unsigned)),
        "receipt.signer.signature",
      ),
    },
  };
}

function entityPlaneReceiptSignaturePayload(
  receipt: UnsignedEntityPlaneReceipt,
): Uint8Array {
  const envelope = {
    commandId: receipt.commandId,
    outcome: receipt.outcome,
    target: receipt.target,
    merchantRevision: receipt.merchantRevision,
    committedAt: receipt.committedAt,
    deliveryId: receipt.deliveryId,
  };
  return new TextEncoder().encode(JSON.stringify(envelope, jsonReplacer));
}

function signObservationDelivery(
  delivery: Omit<EntityPlaneDelivery, "signer">,
  signer: CommerceSigner,
): EntityPlaneDelivery {
  // Reader validation normalizes field order before verifying the signed JSON bytes.
  const unsigned: EntityPlaneDelivery = {
    schemaVersion: delivery.schemaVersion,
    deliveryId: delivery.deliveryId,
    merchantId: delivery.merchantId,
    merchantRevision: delivery.merchantRevision,
    observedAt: delivery.observedAt,
    observations: delivery.observations.map(parseEntityPlaneObservation),
    signer: {
      keyId: signer.keyId,
      algorithm: "ed25519",
      signature: "pending",
    },
  };
  return {
    schemaVersion: unsigned.schemaVersion,
    deliveryId: unsigned.deliveryId,
    merchantId: unsigned.merchantId,
    merchantRevision: unsigned.merchantRevision,
    observedAt: unsigned.observedAt,
    observations: unsigned.observations,
    signer: {
      keyId: signer.keyId,
      algorithm: "ed25519",
      signature: signer.sign(commerceDeliverySignaturePayload(unsigned)),
    },
  };
}

function parseStoredReceipt(value: string): SignedEntityPlaneReceipt {
  const parsed: unknown = JSON.parse(value);
  validateCommerceMutationReceiptWithLexicon(parsed);
  return parsed;
}

function resourceId(resource: EntityPlaneChangeResource): string {
  switch (resource.kind) {
    case "entity_type":
      return resource.typeId.typeId;
    case "entity":
      return resource.ref.entityId;
    case "relationship_definition":
      return resource.definitionId;
    case "custom_relationship":
      return resource.ref.relationshipId;
    case "commerce_list":
      return resource.listId;
    case "commerce_list_entry":
      return resource.ref.entryId;
    case "saved_view":
      return resource.viewId;
  }
}

function commandDigest(command: CommerceEntityPlaneCommand): string {
  return commandJson(command);
}

export function rejected(
  error: CommerceEntityPlaneError,
): CommerceCommandResult {
  return { status: "rejected", error };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

class EntityPlaneCommitRejection extends Error {
  readonly error: CommerceEntityPlaneError;

  constructor(error: CommerceEntityPlaneError) {
    super(error.code);
    this.name = "EntityPlaneCommitRejection";
    this.error = error;
  }
}
