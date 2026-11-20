import type { BakeryWorkflowDocument } from "@purin-labs/bakery-workflow";
import {
  draftSeed,
  stepExecutorKind,
  stepSeconds,
  stepWorkers,
} from "@purin-labs/bakery-workflow/draft";
import { listOpenWorkflowProposals } from "../../commerce/bakery/workflow-proposals";
import {
  listAppliedWorkflows,
  readCurrentWorkflow,
  readWorkflowFindings,
} from "../../commerce/bakery/workflow-revisions";
import { supplierIdFromName } from "@purin-labs/control-api";
import { StaffPageRequestError } from "../errors";
import {
  RecipeWorkflowRequestError,
  type RecipeWorkflowReadRequest,
  type RecipeSaveRequest,
  type RecipeToolRead,
  type SupplierCreateRequest,
  type SupplierToolRead,
} from "./services";
import type { StaffPageToolReceipt } from "../catalog/types";
import { parseIntegrationAccountId } from "../../ids";
import {
  requireSessionExecution,
  admittedSessionOperation,
} from "../../actors/session-execution-admission";
import { createCommerceEntityPlaneClient } from "../../commerce/outbox-worker";
import {
  recipeCollectionOf,
  saveRecipeDraft,
  type RecipeSaveResult,
} from "../../commerce/recipe-commands";
import {
  parseSupplierCreation,
  registerSupplier,
  type SupplierRegistrationError,
} from "../../commerce/purchasing/supplier-creation";
import { admitSessionInformationFlowObservation } from "../../actors/agent-session-information-flow";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  ObservationEvidence,
} from "../../policy";
import { digestCanonical } from "../../policy";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import {
  CommerceReadRequestError,
  readNamedCommerceQuery,
} from "../../context/assembly/commerce";
import { assertNever } from "@purin-labs/std";
import {
  admitCommerceReadObservation,
  liveDeviceMember,
  prepareStaffPageWork,
  refreshRecipeProjection,
  requestableReportRead,
  supplierDirectoryQuery,
  untrustedDeviceText,
  type ToolEffect,
} from "../session-support";
import type { SessionToolContext } from "../context";

function stepFacts(document: BakeryWorkflowDocument) {
  const steps = [];
  const arrows = [];
  const seed = draftSeed(document);
  for (const node of seed.nodes) {
    steps.push({
      workflow: node.workflow,
      key: node.key,
      label: untrustedDeviceText(node.label),
      kind: stepExecutorKind(node.body),
      seconds: stepSeconds(node.body),
      workers: stepWorkers(node.body),
    });
  }
  for (const edge of seed.edges) {
    arrows.push({
      workflow: edge.workflow,
      from: edge.from,
      to: edge.to,
      outcome: edge.branch,
    });
  }
  return { steps, arrows };
}

/** Plan 84: the recipe as the Workflow page shows it, after the same boundary as a page read. */
export async function readRecipeWorkflowForEmbeddedHarness(
  context: SessionToolContext,
  request: RecipeWorkflowReadRequest,
): Promise<unknown> {
  const { env, storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const { scope } = execution;
  const member = await liveDeviceMember(
    scope.database,
    scope.organisationId,
    lease,
  );
  if (member === null) {
    throw new RecipeWorkflowRequestError(
      "Only a member of this workspace can read its recipes. Nothing was read. Tell the person.",
    );
  }
  const label = await createCurrentSourceFlowLabel({
    kind: "recipe_workflow",
    db: scope.database,
    authority: lease.requestAuthority,
  });
  if (!label.ok) {
    throw new Error("Recipe workflow source policy unavailable");
  }
  const admission = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: lease.requestAuthority,
      caseId: String(assignment.caseId),
    },
    inputLabel: label.value,
  });
  if (admission.kind !== "admit") {
    throw new Error("Recipe workflow context admission denied");
  }
  const now = Date.now();
  let value: unknown;
  if (request.workflowId === null) {
    value = {
      recipes: (
        await listAppliedWorkflows(scope.database, scope.organisationId)
      ).map((entry) => ({ ...entry, title: untrustedDeviceText(entry.title) })),
    };
  } else {
    const current = await readCurrentWorkflow(
      env,
      scope.database,
      scope.organisationId,
      request.workflowId,
    );
    if (current === null) {
      throw new RecipeWorkflowRequestError(
        "That recipe has no applied workflow. Nothing was read. Call this tool with null for the list.",
      );
    }
    const findings = await readWorkflowFindings(
      env,
      scope.organisationId,
      request.workflowId,
      current.receipt.digest,
    );
    const open = await listOpenWorkflowProposals(
      scope.database,
      scope.organisationId,
      request.workflowId,
      member.userId,
      now,
    );
    value = {
      workflowId: request.workflowId,
      title: untrustedDeviceText(current.document.title),
      revision: current.receipt.revision,
      digest: current.receipt.digest,
      ...stepFacts(current.document),
      lastRun:
        findings === null
          ? { kind: "not_run_yet" }
          : {
              kind: "ran",
              ranAt: findings.ranAt,
              findings: findings.findings,
            },
      proposalsWaiting: open.length,
    };
  }
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "organisation_record",
      organisationId: scope.organisationId,
      recordId: "recipe_workflows",
    },
    sourceRevision: now,
    contentDigest: await digestCanonical(value),
    inputLabel: label.value,
    observedAt: now,
  });
  if (!evidence.ok) {
    throw new Error("Recipe workflow observation is invalid");
  }
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireSessionExecution.bind(null, execution, lease),
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId: scope.organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    authorityPartitionDigest: lease.authorityPartitionDigest,
    inputLabel: label.value,
    observation: evidence.value,
    observedAt: evidence.value.observedAt,
  });
  if (!admitted.ok) {
    throw new Error("Recipe workflow observation admission failed");
  }
  await requireSessionExecution(execution, lease);
  return value;
}

const RECIPE_LIBRARY_SCOPE = "recipe-library:shop";

const SUPPLIER_DIRECTORY_SCOPE = "supplier-directory:shop";

/** The Suppliers page shows this many, and so does the agent's read. */
const SUPPLIER_READ_LIMIT = 100;

export async function readRecipesForEmbeddedHarness(
  context: SessionToolContext,
): Promise<RecipeToolRead> {
  const { env, storage, execution, lease, assignment } = context;
  const work = await prepareStaffPageWork(
    env,
    execution,
    lease,
    assignment,
    "recipe_revision",
    "recipe",
  );
  await requireSessionExecution(execution, lease);
  const snapshot = await work.context.client.readStockSnapshot(
    work.context.merchantId,
  );
  await requireSessionExecution(execution, lease);
  if (!snapshot.ok) {
    throw new Error("recipes unavailable");
  }
  const collection = recipeCollectionOf(snapshot.value);
  const value: RecipeToolRead = {
    recipes: collection.recipes.map((recipe) => ({
      recipeId: recipe.recipeId,
      revision: recipe.revision,
      name: recipe.name,
      inputs: recipe.inputs,
      output: recipe.output,
      state: recipe.lifecycle.state,
    })),
    items: collection.items,
  };
  await admitCommerceReadObservation(
    storage,
    lease,
    work.prepared,
    value,
    collection.merchantRevision,
    "recipe",
  );
  return value;
}

export async function saveRecipeForEmbeddedHarness(
  context: SessionToolContext,
  request: RecipeSaveRequest,
  operationId: string,
): Promise<ToolEffect<StaffPageToolReceipt>> {
  const { env, execution, lease, assignment } = context;
  const work = await prepareStaffPageWork(
    env,
    execution,
    lease,
    assignment,
    "recipe_revision",
    "recipe",
  );
  const sink = {
    kind: "tool_effect" as const,
    destinationAuthority: lease.requestAuthority,
    capabilityId: CAPABILITY_KEYS.commerceRecipeSave,
    integrationAccountId: "platform",
    resourceScope: RECIPE_LIBRARY_SCOPE,
    approvalSatisfied: false,
  };
  return {
    kind: "staff_page",
    work,
    unavailable: "recipe information-flow authority unavailable",
    effect: {
      sink,
      route: `/v1/control/organisations/${execution.scope.organisationId}/commerce/recipes`,
      operation: request.recipeId === null ? "recipe.create" : "recipe.edit",
      body: request,
      operationId,
      result:
        "The recipe is saved as a new revision. Earlier production keeps its revision. Call recipe_read to see it.",
      run: async (key) =>
        recipeSaveRefusal(
          await saveRecipeDraft(
            work.context,
            // A new recipe's id comes from the call, so a repeat finds it.
            { ...request, recipeId: request.recipeId ?? `recipe_${key}` },
            key,
          ),
        ),
      settled: refreshRecipeProjection.bind(null, env, execution, work),
    },
    content: {
      member: work.member,
      edit: {
        draft: "Recipe",
        capabilityId: CAPABILITY_KEYS.commerceRecipeSave,
        integrationAccountId: "platform",
        resourceScope: RECIPE_LIBRARY_SCOPE,
      },
    },
  };
}

export async function readSuppliersForEmbeddedHarness(
  context: SessionToolContext,
): Promise<SupplierToolRead> {
  const { env, storage, execution, lease, assignment } = context;
  const work = await prepareStaffPageWork(
    env,
    execution,
    lease,
    assignment,
    "supplier_directory",
    "supplier",
  );
  const query = supplierDirectoryQuery(SUPPLIER_READ_LIMIT);
  if (!query.ok) {
    throw new Error("supplier query invalid");
  }
  const read = await readNamedCommerceQuery({
    organisationId: String(execution.scope.organisationId),
    merchantId: work.prepared.merchantId,
    grants: work.prepared.grants,
    requestAuthority: lease.requestAuthority,
    causationId: String(lease.turn.turnId),
    query: query.value,
    allowedSensitivity: "internal",
    reader: work.prepared.reader,
    now: work.prepared.now,
  });
  if (!read.ok) {
    requestableReportRead(
      "supplier_directory",
      new CommerceReadRequestError(read.error),
    );
  }
  const names = new Map<string, string>();
  for (const entity of read.value.entities) {
    names.set(String(entity.reference.entityId), entity.displayName);
  }
  const value: SupplierToolRead = {
    suppliers: read.value.listEntries.map((entry) => {
      const supplierId = String(entry.entityRef.entityId);
      const text = supplierEntryText.bind(null, entry.attributeValues);
      const days = entry.attributeValues.find(
        (attribute) => attribute.attributeId === "lead_time_days",
      )?.value;
      return {
        supplierId,
        name: names.get(supplierId) ?? supplierId,
        leadTimeDays: days?.kind === "integer" ? Number(days.value) : null,
        contactName: text("contact_name"),
        email: text("email"),
        phone: text("phone"),
        minimumOrderQuantity: supplierEntryDecimal(entry.attributeValues),
        minimumOrderUnit: text("minimum_order_unit"),
        purchasingNotes: text("purchasing_notes"),
      };
    }),
    more: read.value.nextCursor !== null,
  };
  await admitCommerceReadObservation(
    storage,
    lease,
    work.prepared,
    value,
    Number(read.value.merchantRevision),
    "supplier",
  );
  return value;
}

type SupplierAttributes =
  Awaited<ReturnType<typeof readNamedCommerceQuery>> extends infer Read
    ? Read extends {
        ok: true;
        value: { listEntries: readonly (infer Entry)[] };
      }
      ? Entry extends { attributeValues: infer Attributes }
        ? Attributes
        : never
      : never
    : never;

function supplierEntryText(
  attributes: SupplierAttributes,
  attributeId: string,
): string | null {
  const value = attributes.find(
    (attribute) => attribute.attributeId === attributeId,
  )?.value;
  return value?.kind === "short_text" || value?.kind === "long_text"
    ? String(value.value)
    : null;
}

function supplierEntryDecimal(attributes: SupplierAttributes): string | null {
  const value = attributes.find(
    (attribute) => attribute.attributeId === "minimum_order_quantity",
  )?.value;
  if (value?.kind !== "decimal") {
    return null;
  }
  return String(Number(value.value.unscaled) / 10 ** Number(value.value.scale));
}

export async function createSupplierForEmbeddedHarness(
  context: SessionToolContext,
  request: SupplierCreateRequest,
  operationId: string,
): Promise<ToolEffect<StaffPageToolReceipt>> {
  const { env, execution, lease, assignment } = context;
  const supplierId =
    typeof request.displayName === "string"
      ? supplierIdFromName(request.displayName)
      : null;
  if (supplierId === null) {
    throw new StaffPageRequestError(
      "A supplier's name needs at least one Latin letter or digit, as on the Suppliers page. Nothing changed. Ask the person for a name that has one.",
    );
  }
  const parsed = parseSupplierCreation({ ...request, supplierId });
  if (!parsed.ok) {
    throw new StaffPageRequestError(
      `${parsed.error.detail ?? "The supplier fields are invalid"}. Nothing changed. Correct the fields, or ask the person.`,
    );
  }
  const work = await prepareStaffPageWork(
    env,
    execution,
    lease,
    assignment,
    "supplier_directory",
    "supplier",
  );
  const sink = {
    kind: "tool_effect" as const,
    destinationAuthority: lease.requestAuthority,
    capabilityId: CAPABILITY_KEYS.commerceSupplierCreate,
    integrationAccountId: "platform",
    resourceScope: SUPPLIER_DIRECTORY_SCOPE,
    approvalSatisfied: false,
  };
  const client = createCommerceEntityPlaneClient(
    env,
    admittedSessionOperation(
      execution,
      lease,
      env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
    ),
    {
      kind: "organisation",
      organisationId: String(execution.scope.organisationId),
      actor: String(work.member.personId),
    },
  );
  if (client === null) {
    throw new Error("supplier Underclerk unavailable");
  }
  const integrationAccountId = parseIntegrationAccountId(
    work.prepared.integrationAccountId,
  );
  if (!integrationAccountId.ok) {
    throw new Error("supplier integration account invalid");
  }
  return {
    kind: "staff_page",
    work,
    unavailable: "supplier information-flow authority unavailable",
    effect: {
      sink,
      route: `/v1/control/organisations/${execution.scope.organisationId}/commerce/suppliers`,
      operation: "commerce.supplier.create",
      body: parsed.value,
      operationId,
      result: `The supplier ${parsed.value.displayName} is in the directory, with id ${supplierId}. Purchasing work opens for the items that it provides.`,
      run: async (key) => {
        const registered = await registerSupplier({
          client,
          db: execution.scope.database,
          queue: env.EVENT_Q,
          organisationId: execution.scope.organisationId,
          merchantId: work.context.merchantId,
          integrationAccountId: integrationAccountId.value,
          principalId: work.member.userId,
          idempotencyKey: key,
          supplier: parsed.value,
          now: Date.now(),
        });
        return registered.ok ? null : supplierRefusal(registered.error);
      },
      // Registration already refreshed the projection.
      settled: () => Promise.resolve(),
    },
    content: {
      member: work.member,
      edit: {
        draft: "Supplier",
        capabilityId: CAPABILITY_KEYS.commerceSupplierCreate,
        integrationAccountId: "platform",
        resourceScope: SUPPLIER_DIRECTORY_SCOPE,
      },
    },
  };
}

function recipeSaveRefusal(saved: RecipeSaveResult): string | null {
  if (saved.ok) {
    return null;
  }
  switch (saved.code) {
    case "underclerk_unavailable":
      throw new Error("recipes unavailable");
    case "recipe_changed":
      return "That recipe changed after you read it, so this save would lose the other change. Nothing changed. Call recipe_read, and tell the person what you see before you save again.";
    case "recipe_invalid":
      return `${saved.detail} Nothing changed. Correct the recipe, or ask the person.`;
    case "recipe_refused":
      return `The shop refused this recipe (${saved.detail}${saved.field === null ? "" : `: ${saved.field}`}). Each item must be an active stock item from recipe_read, and each quantity must use that item's base unit. Nothing changed. Correct the recipe, or tell the person.`;
    case "recipe_busy":
      return "The shop is too busy to take this save now. Try again in a moment.";
    default:
      return assertNever(saved);
  }
}

function supplierRefusal(error: SupplierRegistrationError): string {
  switch (error.code) {
    case "invalid":
      return `${error.detail ?? "The supplier fields are invalid"}. Nothing changed. Correct the fields, or ask the person.`;
    case "purchasing_inactive":
      return "Purchasing is not on in this shop, so it has no supplier directory. An admin turns it on with Activate purchasing on the Suppliers page. Nothing changed. Tell the person.";
    case "command_rejected":
      return `The shop refused this supplier (${error.detail ?? "refused"}). A supplier with this name may exist, or an item may not. Call supplier_read and recipe_read, and tell the person what you see. Do not retry with the same details.`;
    case "unavailable":
    case "email_operational_contact_sync_failed":
    case "underclerk_scope_mismatch":
    case "underclerk_projection_refresh_unavailable":
      // The directory may hold the supplier. A repeat of this call finishes it.
      throw new Error(`supplier registration: ${error.code}`);
    default:
      return assertNever(error);
  }
}
