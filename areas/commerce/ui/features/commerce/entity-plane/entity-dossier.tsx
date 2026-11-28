import React from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { workspacePageDescriptor } from "@purin-labs/ui/route";
import { ProductDescriptionDraftControl } from "../description-draft/control";
import { ProductSaleDetails } from "./product-sale-details";
import type { ProductDescriptionActionTransport } from "@purin-labs/area-commerce-contract/ui/features/commerce/description-draft/action";
import { Link } from "react-router";
import type {
  CommerceEntity,
  CommerceEntityRef,
  CommerceGraphQueryResult,
  CommerceListEntry,
  CommerceRelationship,
} from "@purin-labs/commerce-contracts";
import { SUPPLIER_ENTITY_TYPE_ID } from "@purin-labs/commerce-client";
import { EmptyState, Notice, StatusChip } from "@purin-labs/ui/page-components";
import {
  commerceAttributeLabel,
  commerceRelationshipLabel,
  commerceSourceLabel,
  commerceStatusChip,
  formatCommerceAttributeValue,
  formatCommerceTimestamp,
  isNumericCommerceValue,
} from "./presentation";
import {
  buildCommerceEntityDossierModel,
  type CommerceEntityDossierModel,
} from "./models";
import type { CommerceGraphFetch } from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";
import { SupplierRecordDetails } from "./supplier-directory";
import type { CommerceOperationsTransport } from "@purin-labs/area-commerce-contract/ui/features/commerce/operations";
import type { CommerceActionRecord } from "@purin-labs/commerce-control-api/portal/commerce-actions";
import { assertNever } from "@purin-labs/std";
import { useDossierSurface } from "./dossier-surface";
import {
  CommerceActivityPanel,
  type CommerceActivityRouteState,
} from "./activity-panel";
import type { CommerceEntityPlaneRouteProps } from "./entity-plane-types";
import {
  backToCommerceCollection,
  commerceEntityName,
} from "./entity-plane-shared";
import { OrderCancellationControl } from "./order-cancellation";

export function CommerceEntityDossier(
  props: Readonly<{
    props: CommerceEntityPlaneRouteProps;
    page: "products" | "orders" | "suppliers";
    result: CommerceGraphQueryResult;
    activity: CommerceActivityRouteState;
  }>,
): React.ReactNode {
  const typeId =
    props.page === "products"
      ? "product"
      : props.page === "orders"
        ? "order"
        : SUPPLIER_ENTITY_TYPE_ID;
  const origin = props.page === "suppliers" ? "custom" : "system";
  const entity = props.result.entities.find(
    (candidate) =>
      candidate.reference.origin === origin &&
      candidate.reference.typeId === typeId,
  );
  if (entity === undefined) {
    return (
      <EmptyState
        title="Record not found"
        detail="This commerce record is no longer available."
        action={
          <button
            type="button"
            onClick={backToCommerceCollection.bind(
              null,
              props.props.onBack,
              props.page,
            )}
          >
            Back
          </button>
        }
      />
    );
  }
  const dossier = buildCommerceEntityDossierModel(
    props.result,
    entity.reference,
  );
  if (!dossier.ok)
    return (
      <Notice tone="warning" announcement="polite">
        The commerce dossier could not be assembled.
      </Notice>
    );
  return (
    <CommerceEntityDossierView
      model={dossier.value}
      page={props.page}
      activity={props.activity}
      resourceHref={props.props.resourceHref}
      onBack={backToCommerceCollection.bind(
        null,
        props.props.onBack,
        props.page,
      )}
      organisationId={props.props.organisationId}
      fetcher={props.props.fetcher}
      canPropose={props.props.canManage === true}
      commerceOperations={props.props.commerceOperations}
      descriptionDraftActions={props.props.descriptionDraftActions}
      onActionProposed={props.props.onActionProposed}
      actionBusy={props.props.actionBusy === true}
    />
  );
}

function CommerceEntityDossierView(
  props: Readonly<{
    model: CommerceEntityDossierModel;
    page: "products" | "orders" | "suppliers";
    activity: CommerceActivityRouteState;
    resourceHref: CommerceEntityPlaneRouteProps["resourceHref"];
    onBack: () => void;
    organisationId: string;
    fetcher: CommerceGraphFetch | undefined;
    canPropose: boolean;
    commerceOperations: CommerceOperationsTransport | undefined;
    descriptionDraftActions: ProductDescriptionActionTransport | undefined;
    onActionProposed: ((action: CommerceActionRecord) => void) | undefined;
    actionBusy: boolean;
  }>,
): React.ReactNode {
  const label = commerceEntityName(props.model.entity);
  useDossierSurface(props.page, props.model, label);
  const noAttributes = props.model.entity.attributes.length === 0;
  const labelIsDisplayName = label === props.model.entity.displayName;
  // A supplier is a record of its own with no source; the first source would
  // be that of a linked item.
  const supplier = props.page === "suppliers";
  const source = supplier ? null : commerceDossierSource(props.model);
  const relationships = seedIncidentRelationships(props.model);
  // A section with nothing in it is left out.
  const items =
    relationships.length === 0 ? null : (
      <section
        className="commerce-dossier-section"
        aria-labelledby="commerce-relationships-title"
      >
        <h3 id="commerce-relationships-title">
          {supplier ? "Items they supply" : "Related records"}
        </h3>
        <ul className="commerce-relationship-list">
          {relationships.map(
            renderRelationship.bind(
              null,
              props.model.traversal.entities,
              props.model.entity.reference,
              props.resourceHref,
              !supplier,
            ),
          )}
        </ul>
      </section>
    );
  const history = (
    <>
      {props.model.contextualListEntries.length === 0 ? null : (
        <section
          className="commerce-dossier-section"
          aria-labelledby="commerce-list-context-title"
        >
          <h3 id="commerce-list-context-title">Operational details</h3>
          <dl className="commerce-facts">
            {props.model.contextualListEntries.flatMap(
              renderContextualListEntry,
            )}
          </dl>
        </section>
      )}
      <CommerceActivityPanel activity={props.activity} />
    </>
  );
  // A record heads its own page: the record's name is the page title.
  return (
    <section
      className="portal-band commerce-panel commerce-dossier commerce-record"
      aria-labelledby="portal-page-title"
    >
      <button type="button" className="commerce-back" onClick={props.onBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        Back to {workspacePageDescriptor(props.page).navigationLabel}
      </button>
      <div className="section-heading">
        <h1 id="portal-page-title" tabIndex={-1}>
          {label}
        </h1>
        {source === null ? null : <p>{source}</p>}
      </div>
      <DossierFreshnessNotice entity={props.model.entity} />
      <OrderCancellationControl
        organisationId={props.organisationId}
        page={props.page}
        entity={props.model.entity}
        canPropose={props.canPropose}
        commerceOperations={props.commerceOperations}
        onActionProposed={props.onActionProposed}
        actionBusy={props.actionBusy}
      />
      {supplier ? (
        <SupplierRecordDetails
          organisationId={props.organisationId}
          fetcher={props.fetcher}
          entity={props.model.entity}
          items={items}
          history={history}
        />
      ) : (
        <>
          <section
            className="commerce-dossier-section"
            aria-labelledby="commerce-attributes-title"
          >
            <h3 id="commerce-attributes-title">Details</h3>
            {props.page === "products" ? (
              <ProductSaleDetails
                organisationId={props.organisationId}
                productId={props.model.entity.reference.entityId}
                canEdit={props.canPropose}
              />
            ) : null}
            {props.page === "products" && noAttributes ? null : noAttributes &&
              labelIsDisplayName ? (
              <p className="empty-state commerce-empty">
                This record has no details yet.
              </p>
            ) : (
              <dl className="commerce-facts">
                {props.model.entity.attributes.map(renderEntityAttribute)}
                {labelIsDisplayName ? null : (
                  <div className="commerce-fact-prose">
                    <dt>ID</dt>
                    <dd>{props.model.entity.displayName}</dd>
                  </div>
                )}
              </dl>
            )}
          </section>
          <ProductDescriptionDraftControl
            key={`${props.organisationId}:${props.model.entity.reference.entityId}`}
            organisationId={props.organisationId}
            entity={props.model.entity}
            canPropose={props.canPropose}
            actionTransport={props.descriptionDraftActions}
            onActionProposed={props.onActionProposed}
            actionBusy={props.actionBusy}
          />
          {items}
          {history}
        </>
      )}
    </section>
  );
}

/** One line when the record may be out of date; nothing when it is current. */
function DossierFreshnessNotice(props: {
  readonly entity: CommerceEntity;
}): React.ReactNode {
  const freshness =
    "freshness" in props.entity ? props.entity.freshness : undefined;
  if (freshness === undefined) return null;
  switch (freshness.state) {
    case "current":
      return null;
    case "stale":
      return (
        <Notice tone="warning" announcement="none">
          This record may be out of date. Last checked{" "}
          {formatCommerceTimestamp(freshness.observedAt)}.
        </Notice>
      );
    case "unavailable":
      return (
        <Notice tone="warning" announcement="none">
          Purin Pantry cannot confirm that this record is current.
        </Notice>
      );
    default:
      return assertNever(freshness, "Unhandled commerce graph value");
  }
}

/**
 * A linked record; `showKind` adds what the link is, when no heading says it.
 * Without it, as under "Items they supply", a link row ends in a chevron.
 */
function renderRelationship(
  entities: readonly CommerceEntity[],
  seed: CommerceEntityRef,
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  showKind: boolean,
  relationship: CommerceRelationship,
): React.ReactNode {
  const related = sameEntityRef(relationship.source, seed)
    ? relationship.target
    : relationship.source;
  const entity = entities.find((candidate) =>
    sameEntityRef(candidate.reference, related),
  );
  const link =
    entity === undefined ? null : entityResourceLink(resourceHref, entity);
  const label =
    entity === undefined
      ? entityReferenceLabel(related)
      : commerceEntityName(entity);
  return (
    <li key={`${relationship.origin}:${relationship.relationshipId}`}>
      {link === null ? (
        <strong>{label}</strong>
      ) : (
        <Link to={link}>
          <strong>{label}</strong>
        </Link>
      )}
      {showKind ? (
        <span>
          {commerceRelationshipLabel(
            String(relationship.definition.definitionId),
          )}
        </span>
      ) : link === null ? null : (
        <ChevronRight size={16} aria-hidden="true" />
      )}
    </li>
  );
}

function renderEntityAttribute(
  attribute: CommerceEntity["attributes"][number],
): React.ReactNode {
  // System entity attributes arrive without their definitions, so the label is
  // humanized from the identifier and a status renders as humanized text.
  const chip = commerceStatusChip(attribute.value, undefined);
  return (
    <div
      key={attribute.attributeId}
      className={
        attribute.value.kind === "long_text" ? "commerce-fact-prose" : undefined
      }
    >
      <dt>
        {commerceAttributeLabel(String(attribute.attributeId), undefined)}
      </dt>
      <dd
        className={
          isNumericCommerceValue(attribute.value)
            ? "commerce-numeric"
            : undefined
        }
      >
        {chip === null ? (
          formatCommerceAttributeValue(attribute.value, undefined)
        ) : (
          <StatusChip status={chip} />
        )}
      </dd>
    </div>
  );
}

function renderContextualListEntry(
  entry: CommerceListEntry,
): readonly React.ReactNode[] {
  return entry.attributeValues.map(
    renderContextualListAttribute.bind(null, entry),
  );
}

function renderContextualListAttribute(
  entry: CommerceListEntry,
  attribute: CommerceListEntry["attributeValues"][number],
): React.ReactNode {
  const chip = commerceStatusChip(attribute.value, undefined);
  return (
    <div key={`${entry.listId}:${entry.entryId}:${attribute.attributeId}`}>
      <dt>
        {commerceAttributeLabel(String(attribute.attributeId), undefined)}
      </dt>
      <dd
        className={
          isNumericCommerceValue(attribute.value)
            ? "commerce-numeric"
            : undefined
        }
      >
        {chip === null ? (
          formatCommerceAttributeValue(attribute.value, undefined)
        ) : (
          <StatusChip status={chip} />
        )}
      </dd>
    </div>
  );
}

export function entityResourceLink(
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  entity: CommerceEntity,
): string | null {
  if (
    entity.reference.origin === "custom" &&
    entity.reference.typeId === SUPPLIER_ENTITY_TYPE_ID
  ) {
    return resourceHref(entity.reference.entityId, "supplier");
  }
  if (entity.reference.origin !== "system") return null;
  if (entity.reference.typeId === "product")
    return resourceHref(entity.reference.entityId, "product");
  if (entity.reference.typeId === "order")
    return resourceHref(entity.reference.entityId, "order");
  return null;
}

function entityReferenceLabel(reference: CommerceEntityRef): string {
  return `${reference.typeId}:${reference.entityId}`;
}

/**
 * Only the records linked directly to this one. A two-hop traversal also
 * returns edges between two of those neighbours, which would list a neighbour a
 * second time under the label of a relationship this record is not part of.
 */
function seedIncidentRelationships(
  model: CommerceEntityDossierModel,
): readonly CommerceRelationship[] {
  const seed = model.entity.reference;
  return model.traversal.relationships.filter(
    (relationship) =>
      sameEntityRef(relationship.source, seed) ||
      sameEntityRef(relationship.target, seed),
  );
}

/** Where the record's facts come from, or null when nothing says. */
function commerceDossierSource(model: CommerceEntityDossierModel): string | null {
  const provenance = model.provenance[0];
  return provenance === undefined
    ? null
    : `From ${commerceSourceLabel(String(provenance.source))}`;
}

function sameEntityRef(
  left: CommerceEntityRef,
  right: CommerceEntityRef,
): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}
