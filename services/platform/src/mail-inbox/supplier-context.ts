import type { OrganisationDatabase } from "../database-handles";
import { pantryCommerceAccess } from "../commerce/app-access";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type {
  CommerceGraphQuery,
  CommerceGraphQueryResult,
  AttributeValue,
  RequestAuthority,
} from "@purin-labs/contracts";
import {
  CommerceEntityPlaneClient,
  SUPPLIER_DIRECTORY_LIST_ID,
  SUPPLIER_ENTITY_TYPE_ID,
  REPLENISHMENT_QUEUE_LIST_ID,
  parseCommerceGraphQuery,
} from "@purin-labs/commerce-client";
import { assertNever, isPositiveInteger, isRecord, isSha256Hex } from "@purin-labs/std";
import type { Env } from "../env";
import { parseOrganisationId, type OrganisationId } from "../ids";
import { listAccessGrants } from "../data/access-grants";
import { selectActiveGrants } from "../authorization/access-grants/compiler";
import { resolveCurrentOrganisationCommerceMerchantBinding } from "../data/commerce-merchant-binding";
import { resolveOrganisationCommerceSystemAuthority } from "../data/organisation-commerce-system";
import {
  readNamedCommerceQuery,
  selectNamedCommerceQuerySourceGrant,
} from "../context/assembly/commerce";
import { CommerceGraphReader } from "../commerce/entity-plane/graph-reader";
import { CommerceEngineSource } from "../commerce/entity-plane/commerce-source";
import { BlotterSource } from "../commerce/entity-plane/blotter-source";
import { requireActiveOrganisationActor } from "../actors/actor-router";
import {
  validateLiveRequestAuthority,
  validateLiveAutomationAuthority,
  validateNativeRequestAuthority,
} from "../request-authority";
import { extractMailbox, type GmailMessageContent } from "../mail/gmail-adapter";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
} from "../authorization/capability-catalogue";
import {
  createCurrentSourceFlowLabel,
  currentFlowSinkCheck,
  decideContextAdmission,
  evaluateFlowLabelSink,
  integrationResourceScopeForGrant,
  type FlowLabel,
} from "../policy";
import {
  digestCanonical,
} from "../policy/information-flow/digest";
import type { Result } from "../result";
import type {
  MailRelationshipLookup,
  MailSupplierCandidate,
} from "@purin-labs/control-api";
import type { Variant } from "@purin-labs/type-utils";

type MailboxAuthority = Variant<RequestAuthority, "agent_mailbox">;
export type EmailCommerceEvidence = Readonly<{
  integrationAccountId: string;
  merchantId: string;
  merchantRevision: number;
  grantId: string;
  resourceScope: string;
  labelDigest: string;
  mailboxAuthority: MailboxAuthority;
}>;

type ContextError = Readonly<{
  code:
    | "email_commerce_unavailable"
    | "email_commerce_changed"
    | "email_supplier_needs_review";
}>;

/** The purchase request that one supplier read found, by identity. */
type EmailPurchaseRequestRead = Readonly<{
  purchaseRequestId: string;
  supplierId: string;
  evidence: readonly EmailCommerceEvidence[];
}>;
type ReadResult = Readonly<{
  value: CommerceGraphQueryResult;
  evidence: EmailCommerceEvidence;
}>;

export class EmailSupplierContext {
  private evidence: readonly EmailCommerceEvidence[] = [];
  private request: EmailPurchaseRequestRead | null = null;
  constructor(
    private readonly env: Env,
    private readonly authority: MailboxAuthority,
    private readonly caseId: string,
  ) {}

  receipts(): readonly EmailCommerceEvidence[] {
    return this.evidence;
  }

  /** The purchase request this turn read, or null. */
  purchaseRequest(): EmailPurchaseRequestRead | null {
    return this.request;
  }

  async read(
    message: GmailMessageContent,
    inputJson: string,
  ): Promise<Result<string, ContextError>> {
    const requestId = purchaseRequestArgument(inputJson);
    const sender =
      message.headers.from === null
        ? null
        : extractMailbox(message.headers.from);
    if (
      sender === null ||
      requestId === null ||
      !message.bodyText.includes(requestId)
    )
      return needsReview();
    const directory = await readMailboxCommerceQuery(
      this.env,
      this.authority,
      this.caseId,
      purchasingQuery(SUPPLIER_DIRECTORY_LIST_ID, "email", sender),
    );
    if (!directory.ok) return directory;
    const suppliers = directory.value.value.listEntries;
    if (directory.value.value.nextCursor !== null || suppliers.length !== 1)
      return needsReview();
    const supplier = suppliers[0];
    if (
      supplier === undefined ||
      supplier.entityRef.origin !== "custom" ||
      supplier.entityRef.typeId !== SUPPLIER_ENTITY_TYPE_ID
    )
      return needsReview();
    const requests = await readMailboxCommerceQuery(
      this.env,
      this.authority,
      this.caseId,
      purchasingQuery(
        REPLENISHMENT_QUEUE_LIST_ID,
        "purchase_request_id",
        requestId,
        supplier.entityRef.entityId,
      ),
    );
    if (!requests.ok) return requests;
    if (
      requests.value.value.nextCursor !== null ||
      requests.value.value.listEntries.length !== 1
    )
      return needsReview();
    if (
      directory.value.evidence.merchantRevision !==
      requests.value.evidence.merchantRevision
    )
      return changed();
    const request = requests.value.value.listEntries[0];
    if (request === undefined) return needsReview();
    const evidence = [directory.value.evidence, requests.value.evidence];
    if (
      this.evidence.length > 0 &&
      (await digestCanonical(this.evidence)) !==
        (await digestCanonical(evidence))
    )
      return changed();
    if (
      !(
        await validateEmailCommerceEvidence(
          this.env,
          this.authority.organisationId,
          evidence,
        )
      ).ok
    )
      return changed();
    this.evidence = evidence;
    this.request = {
      purchaseRequestId: requestId,
      supplierId: supplier.entityRef.entityId,
      evidence,
    };
    return {
      ok: true,
      value: JSON.stringify({
        kind: "supplier_purchase_request",
        source: `purchase_request:${requestId}`,
        supplier: supplier.entityRef,
        supplierEntry: supplier.entryId,
        purchaseRequestEntry: request.entryId,
        merchantRevision: requests.value.evidence.merchantRevision,
        facts: request.attributeValues.filter(isReplyFact),
      }),
    };
  }
}

export function isReplyFact(value: Readonly<{ attributeId: string }>): boolean {
  return [
    "purchase_request_id",
    "status",
    "expected_delivery_at",
    "required_quantity",
    "received_quantity",
    "quantity_unit",
  ].includes(value.attributeId);
}
function purchaseRequestArgument(inputJson: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(inputJson);
  } catch {
    return null;
  }
  return isRecord(raw) &&
    Object.keys(raw).length === 1 &&
    typeof raw.purchaseRequestId === "string" &&
    raw.purchaseRequestId.trim() === raw.purchaseRequestId &&
    raw.purchaseRequestId.length > 0 &&
    raw.purchaseRequestId.length <= 256
    ? raw.purchaseRequestId
    : null;
}
export function purchasingQuery(
  listId: string,
  attributeId: string,
  value: string,
  supplierId: string | null = null,
  limit = 2,
): CommerceGraphQuery {
  const filter = {
    kind: "attribute",
    filter: {
      attributeId,
      operator: "equals",
      value: { kind: "short_text", value },
    },
  };
  return parseCommerceGraphQuery({
    kind: "commerce_list_page",
    listId,
    // Commerce filters express conjunction through De Morgan's law.
    filter:
      supplierId === null
        ? filter
        : {
            kind: "not",
            filter: {
              kind: "any",
              filters: [
                { kind: "not", filter },
                {
                  kind: "not",
                  filter: {
                    kind: "attribute",
                    filter: {
                      attributeId: "supplier_id",
                      operator: "equals",
                      value: { kind: "short_text", value: supplierId },
                    },
                  },
                },
              ],
            },
          },
    sorts: [],
    pagination: { limit, cursor: null },
  });
}

export type EmailRelationshipRead =
  | Readonly<{ kind: "suppliers"; suppliers: readonly MailSupplierCandidate[] }>
  | Readonly<{
      kind: "purchase_request";
      supplierEntryId: string;
      supplierId: string;
      supplierName: string;
      purchaseRequestEntryId: string;
      purchaseRequestId: string;
      merchantRevision: number;
      facts: readonly Readonly<{ label: string; value: string }>[];
      relationshipDigest: string;
      evidence: readonly EmailCommerceEvidence[];
    }>;

export async function readEmailRelationship(
  env: Env,
  mailboxAuthority: MailboxAuthority,
  operatorAuthority: Variant<RequestAuthority, "control">,
  caseId: string,
  message: GmailMessageContent,
  lookup: MailRelationshipLookup,
): Promise<Result<EmailRelationshipRead, ContextError>> {
  const sender =
    message.headers.from === null ? null : extractMailbox(message.headers.from);
  if (sender === null) return needsReview();
  const directory = await readMailboxCommerceQuery(
    env,
    mailboxAuthority,
    caseId,
    purchasingQuery(SUPPLIER_DIRECTORY_LIST_ID, "email", sender, null, 20),
  );
  if (!directory.ok) return directory;
  const directoryAccess = await authorizeEmailCommerceDelivery(
    env,
    operatorAuthority,
    [directory.value.evidence],
  );
  if (!directoryAccess.ok) return directoryAccess;
  if (directory.value.value.nextCursor !== null) return needsReview();
  const suppliers: MailSupplierCandidate[] = [];
  for (const entry of directory.value.value.listEntries) {
    if (
      entry.entityRef.origin === "custom" &&
      entry.entityRef.typeId === SUPPLIER_ENTITY_TYPE_ID
    )
      suppliers.push({
        entryId: entry.entryId,
        supplierId: entry.entityRef.entityId,
        displayName: supplierDisplayName(
          directory.value.value.entities,
          entry.entityRef.entityId,
        ),
      });
  }
  if (lookup.kind === "suppliers")
    return { ok: true, value: { kind: "suppliers", suppliers } };
  const supplier = suppliers.find(
    candidateMatches.bind(null, lookup.supplierEntryId),
  );
  if (supplier === undefined) return needsReview();
  const requests = await readMailboxCommerceQuery(
    env,
    mailboxAuthority,
    caseId,
    purchasingQuery(
      REPLENISHMENT_QUEUE_LIST_ID,
      "purchase_request_id",
      lookup.purchaseRequestId,
      supplier.supplierId,
    ),
  );
  if (!requests.ok) return requests;
  const evidence = [directory.value.evidence, requests.value.evidence];
  const access = await authorizeEmailCommerceDelivery(
    env,
    operatorAuthority,
    evidence,
  );
  if (!access.ok) return access;
  if (
    requests.value.value.nextCursor !== null ||
    requests.value.value.listEntries.length !== 1
  )
    return needsReview();
  const request = requests.value.value.listEntries[0];
  if (request === undefined) return needsReview();
  const references = {
    supplierEntryId: supplier.entryId,
    supplierId: supplier.supplierId,
    purchaseRequestEntryId: request.entryId,
    purchaseRequestId: lookup.purchaseRequestId,
    merchantRevision: requests.value.evidence.merchantRevision,
  };
  const facts = request.attributeValues
    .filter(isReplyFact)
    .map(replyFactDisplay);
  return {
    ok: true,
    value: {
      kind: "purchase_request",
      ...references,
      supplierName: supplier.displayName,
      facts,
      evidence,
      relationshipDigest: await digestCanonical({
        references,
        facts,
        evidence,
      }),
    },
  };
}

function candidateMatches(
  entryId: string,
  candidate: MailSupplierCandidate,
): boolean {
  return candidate.entryId === entryId;
}
function supplierDisplayName(
  entities: CommerceGraphQueryResult["entities"],
  supplierId: string,
): string {
  for (const entity of entities) {
    if (
      entity.reference.origin === "custom" &&
      entity.reference.typeId === SUPPLIER_ENTITY_TYPE_ID &&
      entity.reference.entityId === supplierId
    )
      return entity.displayName;
  }
  return supplierId;
}

/** One commerce attribute as a person reads it: a label and a value. */
export function replyFactDisplay(
  fact: Readonly<{ attributeId: string; value: AttributeValue }>,
): Readonly<{ label: string; value: string }> {
  return {
    label: fact.attributeId.replaceAll("_", " "),
    value: replyFactValue(fact.value),
  };
}

function replyFactValue(value: AttributeValue): string {
  switch (value.kind) {
    case "short_text":
    case "long_text":
    case "date":
    case "timestamp":
    case "status":
      return value.value;
    case "integer":
    case "boolean":
      return String(value.value);
    case "decimal":
      return String(value.value.unscaled / 10 ** value.value.scale);
    case "choice":
      return value.values.join(", ");
    case "money":
    case "merchant_operator_reference":
    case "external_resource_reference":
      return JSON.stringify(value.value);
    default:
      return assertNever(value);
  }
}

/**
 * One commerce read of a mailbox turn, under the mailbox agent's own grant.
 * The read is refused unless the reply may carry the source's label. The
 * evidence names the grant, the source and its label digest, so each later
 * surface can check that the source still stands.
 */
export async function readMailboxCommerceQuery(
  env: Env,
  authority: MailboxAuthority,
  caseId: string,
  query: CommerceGraphQuery,
): Promise<Result<ReadResult, ContextError>> {
  const organisationId = parseOrganisationId(authority.organisationId);
  if (!organisationId.ok) return unavailable();
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) return unavailable();
  if (
    !(
      await validateLiveAutomationAuthority({
        db: execution.value.database,
        accountAccess: execution.value.accountAccess,
        action: "execute",
        authority,
      })
    ).ok
  )
    return unavailable();
  const read = await readGrantedCommerceQuery(
    env,
    execution.value,
    organisationId.value,
    authority,
    caseId,
    query,
    replyMayReceive.bind(null, execution.value.database, authority),
  );
  if (!read.ok) return read;
  const evidence: EmailCommerceEvidence = {
    integrationAccountId: read.value.integrationAccountId,
    merchantId: read.value.merchantId,
    merchantRevision: Number(read.value.value.merchantRevision),
    grantId: read.value.grantId,
    resourceScope: read.value.resourceScope,
    labelDigest: read.value.labelDigest,
    mailboxAuthority: authority,
  };
  return { ok: true, value: { value: read.value.value, evidence } };
}

/**
 * One commerce read for a person who reviews a reply, under their own grant.
 * The read is refused unless the source's label reaches that person.
 */
export async function readReviewerCommerceQuery(
  env: Env,
  authority: Variant<RequestAuthority, "control">,
  caseId: string,
  query: CommerceGraphQuery,
): Promise<Result<CommerceGraphQueryResult, ContextError>> {
  const organisationId = parseOrganisationId(authority.organisationId);
  if (!organisationId.ok) return unavailable();
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (
    !execution.ok ||
    !(
      await validateNativeRequestAuthority({
        db: execution.value.database,
        authority,
      })
    ).ok
  )
    return unavailable();
  const read = await readGrantedCommerceQuery(
    env,
    execution.value,
    organisationId.value,
    authority,
    caseId,
    query,
    reviewerMayReceive.bind(null, authority),
  );
  return read.ok ? { ok: true, value: read.value.value } : read;
}

/**
 * One named commerce read under the grant that the reader's own authority
 * selects. The read happens only when the reader's Case admits the source's
 * label and `mayReceive` lets the label reach where the read goes.
 */
async function readGrantedCommerceQuery(
  env: Env,
  execution: OrganisationExecutionScope,
  organisationId: OrganisationId,
  authority: RequestAuthority,
  caseId: string,
  query: CommerceGraphQuery,
  mayReceive: (label: FlowLabel) => Promise<boolean>,
): Promise<
  Result<
    Readonly<{
      value: CommerceGraphQueryResult;
      integrationAccountId: string;
      merchantId: string;
      grantId: string;
      resourceScope: string;
      labelDigest: string;
    }>,
    ContextError
  >
> {
  const binding = await resolveCurrentOrganisationCommerceMerchantBinding({
    db: execution.database,
    organisationId,
  });
  const system = await resolveOrganisationCommerceSystemAuthority({
    db: execution.database,
    organisationId,
  });
  const grants = await listAccessGrants({
    db: execution.database,
    organisationId,
    lifecycle: "active",
  });
  if (
    !binding.ok ||
    !system.ok ||
    !grants.ok ||
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  )
    return unavailable();
  const scope = {
    organisationId: authority.organisationId,
    merchantId: String(binding.value.merchantId),
    grants: grants.value,
    requestAuthority: authority,
    causationId: caseId,
    query,
    allowedSensitivity: "internal" as const,
    now: new Date().toISOString(),
  };
  const grant = selectNamedCommerceQuerySourceGrant(scope);
  if (!grant.ok) return unavailable();
  const resourceScope = integrationResourceScopeForGrant(grant.value);
  if (resourceScope === null) return unavailable();
  const label = await createCurrentSourceFlowLabel({
    kind: "integration_resource",
    db: execution.database,
    organisationId,
    integrationAccountId: system.value.integrationAccountId,
    resourceScope,
    capabilityId: CAPABILITY_KEYS.commerceEntityRead,
    grantIds: [grant.value.grantId],
  });
  if (
    !label.ok ||
    (
      await decideContextAdmission({
        subject: {
          kind: "authority_derived",
          requestAuthority: authority,
          caseId,
        },
        inputLabel: label.value,
      })
    ).kind !== "admit" ||
    !(await mayReceive(label.value))
  )
    return unavailable();
  const client = new CommerceEntityPlaneClient({
    baseUrl: env.UNDERCLERK_BASE_URL,
    ...pantryCommerceAccess(
      env.UNDERCLERK_SERVICE_TOKEN,
      String(organisationId),
      env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
    ),
  });
  const commerceEngine = new CommerceEngineSource({
    organisationId: authority.organisationId,
    merchantId: String(binding.value.merchantId),
    integrationAccountId: binding.value.integrationAccountId,
    client,
  });
  const reader =
    system.value.commerceSystem.kind === "shopify"
      ? new CommerceGraphReader({
          organisationId: authority.organisationId,
          merchantId: String(binding.value.merchantId),
          commerceSystem: system.value.commerceSystem,
          underclerk: commerceEngine,
          blotter: new BlotterSource({
            organisation: await requireActiveOrganisationActor({
              env,
              organisationId,
              now: Date.now(),
            }),
            organisationId,
            merchantId: String(binding.value.merchantId),
            integrationAccountId: system.value.integrationAccountId,
          }),
        })
      : new CommerceGraphReader({
          organisationId: authority.organisationId,
          merchantId: String(binding.value.merchantId),
          commerceSystem: system.value.commerceSystem,
          underclerk: commerceEngine,
        });
  const result = await readNamedCommerceQuery({ ...scope, reader });
  if (!result.ok) return unavailable();
  return {
    ok: true,
    value: {
      value: result.value,
      integrationAccountId: system.value.integrationAccountId,
      merchantId: String(binding.value.merchantId),
      grantId: grant.value.grantId,
      resourceScope,
      labelDigest: label.value.digest,
    },
  };
}

/** Whether a source's label may reach a person as a delivery to them. */
async function reviewerMayReceive(
  authority: Variant<RequestAuthority, "control">,
  label: FlowLabel,
): Promise<boolean> {
  return (
    evaluateFlowLabelSink({
      flowLabel: label,
      organisationAuthz: null,
      sink: { kind: "conversation_delivery", destinationAuthority: authority },
    }).kind === "allow"
  );
}

async function replyMayReceive(
  db: OrganisationDatabase,
  authority: MailboxAuthority,
  label: FlowLabel,
): Promise<boolean> {
  const check = await currentFlowSinkCheck({
    db,
    flowLabel: label,
    sink: replySink(authority),
  });
  return check.ok && evaluateFlowLabelSink(check.value).kind === "allow";
}

function replySink(authority: MailboxAuthority) {
  return {
    kind: "tool_effect" as const,
    destinationAuthority: authority,
    capabilityId: CAPABILITY_KEYS.emailReplyPropose,
    integrationAccountId: authority.integrationAccountId,
    resourceScope: EMAIL_MAILBOX_RESOURCE_SCOPE,
    approvalSatisfied: false,
  };
}

export async function validateEmailCommerceEvidence(
  env: Env,
  organisationIdRaw: string,
  evidence: readonly EmailCommerceEvidence[],
): Promise<Result<null, ContextError>> {
  if (evidence.length === 0) return { ok: true, value: null };
  const organisationId = parseOrganisationId(organisationIdRaw);
  if (
    !organisationId.ok ||
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  )
    return changed();
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) return changed();
  const binding = await resolveCurrentOrganisationCommerceMerchantBinding({
    db: execution.value.database,
    organisationId: organisationId.value,
  });
  const system = await resolveOrganisationCommerceSystemAuthority({
    db: execution.value.database,
    organisationId: organisationId.value,
  });
  if (!binding.ok || !system.ok) return changed();
  const source = new CommerceEngineSource({
    organisationId: organisationIdRaw,
    merchantId: String(binding.value.merchantId),
    integrationAccountId: binding.value.integrationAccountId,
    client: new CommerceEntityPlaneClient({
      baseUrl: env.UNDERCLERK_BASE_URL,
      ...pantryCommerceAccess(
        env.UNDERCLERK_SERVICE_TOKEN,
        String(organisationId.value),
        env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
      ),
    }),
  });
  const revision = await source.readSnapshotRevision();
  if (!revision.ok) return changed();
  for (const receipt of evidence) {
    if (
      receipt.mailboxAuthority.organisationId !== organisationIdRaw ||
      receipt.integrationAccountId !== system.value.integrationAccountId ||
      receipt.merchantId !== String(binding.value.merchantId) ||
      receipt.merchantRevision !== Number(revision.value) ||
      !(
        await validateLiveAutomationAuthority({
          db: execution.value.database,
          accountAccess: execution.value.accountAccess,
          action: "disclose",
          authority: receipt.mailboxAuthority,
        })
      ).ok
    )
      return changed();
    const label = await createCurrentSourceFlowLabel({
      kind: "integration_resource",
      db: execution.value.database,
      organisationId: organisationId.value,
      integrationAccountId: receipt.integrationAccountId,
      resourceScope: receipt.resourceScope,
      capabilityId: CAPABILITY_KEYS.commerceEntityRead,
      grantIds: [receipt.grantId],
    });
    if (
      !label.ok ||
      label.value.digest !== receipt.labelDigest ||
      !(await replyMayReceive(
        execution.value.database,
        receipt.mailboxAuthority,
        label.value,
      ))
    )
      return changed();
  }
  return { ok: true, value: null };
}

/**
 * Whether this person may be shown what a mailbox turn's commerce reads
 * gave. The evidence must still stand. For each source the person needs
 * their own grant to it, and the label that their grants derive must reach
 * them. The sources that a Portal chat read pass
 * `authorizeEmailChatSourceDelivery` instead.
 */
export async function authorizeEmailCommerceDelivery(
  env: Env,
  authority: Variant<RequestAuthority, "control">,
  evidence: readonly EmailCommerceEvidence[],
): Promise<Result<null, ContextError>> {
  const organisationId = parseOrganisationId(authority.organisationId);
  if (!organisationId.ok) return unavailable();
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) return unavailable();
  if (
    !(
      await validateLiveRequestAuthority({
        db: execution.value.database,
        accountAccess: execution.value.accountAccess,
        userAuthority: {
          kind: "disclosure_recipient",
          disclosureEvidenceId: await digestCanonical(evidence),
        },
        action: "disclose",
        authority,
      })
    ).ok
  )
    return unavailable();
  const valid = await validateEmailCommerceEvidence(
    env,
    authority.organisationId,
    evidence,
  );
  if (!valid.ok || evidence.length === 0) return valid;
  const grants = await listAccessGrants({
    db: execution.value.database,
    organisationId: organisationId.value,
    lifecycle: "active",
  });
  if (!grants.ok) return unavailable();
  const selected = selectActiveGrants({
    organisationId: organisationId.value,
    authority,
    grants: grants.value,
  });
  if (!selected.ok) return unavailable();
  for (const receipt of evidence) {
    const grantIds: string[] = [];
    for (const grant of selected.value) {
      if (
        grant.target.kind === "commerce_read" &&
        grant.target.capabilityId === CAPABILITY_KEYS.commerceEntityRead &&
        grant.target.capabilityVersion === 1 &&
        integrationResourceScopeForGrant(grant) === receipt.resourceScope
      )
        grantIds.push(grant.grantId);
    }
    if (grantIds.length === 0) return unavailable();
    // Review derives an audience label from the operator's grants to the same source.
    const label = await createCurrentSourceFlowLabel({
      kind: "integration_resource",
      db: execution.value.database,
      organisationId: organisationId.value,
      integrationAccountId: receipt.integrationAccountId,
      resourceScope: receipt.resourceScope,
      capabilityId: CAPABILITY_KEYS.commerceEntityRead,
      grantIds,
    });
    if (
      !label.ok ||
      evaluateFlowLabelSink({
        flowLabel: label.value,
        organisationAuthz: null,
        sink: {
          kind: "conversation_delivery",
          destinationAuthority: authority,
        },
      }).kind !== "allow"
    )
      return unavailable();
  }
  return { ok: true, value: null };
}

export function createEmailCommerceSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS connector_email_commerce_evidence (proposal_id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS connector_email_relationship_correction (proposal_id TEXT NOT NULL, version INTEGER NOT NULL, user_id TEXT NOT NULL, supplier_entry_id TEXT NOT NULL, supplier_id TEXT NOT NULL, purchase_request_entry_id TEXT NOT NULL, merchant_revision INTEGER NOT NULL, relationship_digest TEXT NOT NULL, PRIMARY KEY (proposal_id, version))",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS connector_email_relationship_verification (proposal_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (proposal_id, version))",
  );
}

export function recordPendingEmailRelationshipVerification(
  sql: SqlStorage,
  proposalId: string,
  version: number,
): void {
  sql.exec(
    "INSERT INTO connector_email_relationship_verification (proposal_id, version) VALUES (?, ?)",
    proposalId,
    version,
  );
}

export function hasPendingEmailRelationshipVerification(
  sql: SqlStorage,
  proposalId: string,
  version: number,
): boolean {
  return (
    sql
      .exec(
        "SELECT 1 FROM connector_email_relationship_verification WHERE proposal_id = ? AND version = ?",
        proposalId,
        version,
      )
      .toArray().length === 1
  );
}

export function settleEmailRelationshipVerification(
  sql: SqlStorage,
  proposalId: string,
  version: number,
): void {
  sql.exec(
    "DELETE FROM connector_email_relationship_verification WHERE proposal_id = ? AND version = ?",
    proposalId,
    version,
  );
}

export function recordEmailRelationshipCorrection(
  sql: SqlStorage,
  proposalId: string,
  version: number,
  userId: string,
  relationship: Variant<EmailRelationshipRead, "purchase_request">,
): void {
  // The correction replaces the purchasing evidence. Evidence of another
  // source the turn read, such as an order, still covers the reply.
  const scopes = new Set(relationship.evidence.map(evidenceScope));
  const kept = readEmailCommerceEvidence(sql, proposalId).filter(
    (receipt) => !scopes.has(receipt.resourceScope),
  );
  sql.exec(
    "UPDATE connector_email_commerce_evidence SET body = ? WHERE proposal_id = ?",
    JSON.stringify([...relationship.evidence, ...kept]),
    proposalId,
  );
  sql.exec(
    "INSERT INTO connector_email_relationship_correction (proposal_id, version, user_id, supplier_entry_id, supplier_id, purchase_request_entry_id, merchant_revision, relationship_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    proposalId,
    version,
    userId,
    relationship.supplierEntryId,
    relationship.supplierId,
    relationship.purchaseRequestEntryId,
    relationship.merchantRevision,
    relationship.relationshipDigest,
  );
}
/** The most orders that one mailbox turn may read. */
export const MAX_EMAIL_ORDER_READS = 3;

/**
 * The most reads one reply keeps evidence of: the supplier and its purchase
 * request, and the orders the turn read.
 */
export const MAX_EMAIL_COMMERCE_EVIDENCE = 2 + MAX_EMAIL_ORDER_READS;

function evidenceScope(receipt: EmailCommerceEvidence): string {
  return receipt.resourceScope;
}

export function recordEmailCommerceEvidence(
  sql: SqlStorage,
  proposalId: string,
  evidence: readonly EmailCommerceEvidence[],
): void {
  sql.exec(
    "INSERT INTO connector_email_commerce_evidence (proposal_id, body) VALUES (?, ?) ON CONFLICT (proposal_id) DO NOTHING",
    proposalId,
    JSON.stringify(evidence),
  );
}
export function readEmailCommerceEvidence(
  sql: SqlStorage,
  proposalId: string,
): readonly EmailCommerceEvidence[] {
  const row = sql
    .exec<{ body: string }>(
      "SELECT body FROM connector_email_commerce_evidence WHERE proposal_id = ?",
      proposalId,
    )
    .toArray()[0];
  if (row === undefined) return [];
  const raw: unknown = JSON.parse(row.body);
  if (!Array.isArray(raw) || raw.length > MAX_EMAIL_COMMERCE_EVIDENCE)
    throw new Error("email_commerce_evidence_corrupt");
  return raw.map(parseEmailCommerceEvidence);
}

/** One stored receipt. A malformed one means the store is corrupt. */
export function parseEmailCommerceEvidence(
  raw: unknown,
): EmailCommerceEvidence {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 7 ||
    !isPositiveInteger(raw.merchantRevision) ||
    !isSha256Hex(raw.labelDigest) ||
    !text(raw.integrationAccountId) ||
    !text(raw.merchantId) ||
    !text(raw.grantId) ||
    !text(raw.resourceScope)
  )
    throw new Error("email_commerce_evidence_corrupt");
  const authority = raw.mailboxAuthority;
  if (
    !isRecord(authority) ||
    Object.keys(authority).length !== 6 ||
    authority.kind !== "agent_mailbox" ||
    !text(authority.organisationId) ||
    !text(authority.integrationAccountId) ||
    !text(authority.mailboxBindingId) ||
    !isPositiveInteger(authority.bindingRevision) ||
    !isPositiveInteger(authority.mailboxPolicyVersion)
  )
    throw new Error("email_commerce_evidence_corrupt");
  return {
    integrationAccountId: raw.integrationAccountId,
    merchantId: raw.merchantId,
    merchantRevision: raw.merchantRevision,
    grantId: raw.grantId,
    resourceScope: raw.resourceScope,
    labelDigest: raw.labelDigest,
    mailboxAuthority: {
      kind: "agent_mailbox",
      organisationId: authority.organisationId,
      integrationAccountId: authority.integrationAccountId,
      mailboxBindingId: authority.mailboxBindingId,
      bindingRevision: authority.bindingRevision,
      mailboxPolicyVersion: authority.mailboxPolicyVersion,
    },
  };
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}
function needsReview(): Result<never, ContextError> {
  return { ok: false, error: { code: "email_supplier_needs_review" } };
}
function unavailable(): Result<never, ContextError> {
  return { ok: false, error: { code: "email_commerce_unavailable" } };
}
function changed(): Result<never, ContextError> {
  return { ok: false, error: { code: "email_commerce_changed" } };
}
