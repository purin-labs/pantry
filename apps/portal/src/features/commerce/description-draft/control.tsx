import React from "react";
import type { CommerceEntity } from "@purin-labs/commerce-contracts";
import { ControlApiError, controlRead } from "../../../control-client";
import type { CommerceActionRecord } from "@purin-labs/control-api/portal/commerce-actions";
import { SlackThreadControl } from "../../collaboration/slack-thread-control";
import type { ProductDescriptionActionTransport, ProductDescriptionSnapshot } from "./editor";
import "./styles.css";
import { type ProductDescriptionResponse, parseProductDescriptionResponse } from "@purin-labs/control-api/portal/description-draft";

const DescriptionEditor = React.lazy(loadEditor);

function loadEditor() { return import("./editor"); }

type ProductDescriptionSnapshotState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; value: ProductDescriptionResponse }>
  | Readonly<{ kind: "failed"; message: string }>;

type DraftControlState =
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "open"; productRevision: number; snapshot: ProductDescriptionSnapshotState }>;

type ProductDescriptionLoad = {
  kind: "active" | "cancelled";
  organisationId: string;
  productId: string;
  setState: React.Dispatch<React.SetStateAction<DraftControlState>>;
};

export function ProductDescriptionDraftControl(props: Readonly<{
  organisationId: string;
  entity: CommerceEntity;
  canPropose?: boolean;
  actionTransport?: ProductDescriptionActionTransport;
  onActionProposed?: (action: CommerceActionRecord) => void;
  actionBusy?: boolean;
}>): React.ReactNode {
  const [state, setState] = React.useState<DraftControlState>({ kind: "closed" });
  const sourceRevision = React.useRef<number | null>(null);
  const entity = props.entity;
  const productId = entity.reference.entityId;
  const source = entity.reference.origin === "system" && entity.reference.typeId === "product" &&
    entity.provenance !== undefined && entity.freshness !== undefined && entity.provenance.source === "underclerk"
    ? { revision: entity.provenance.revision, freshness: entity.freshness.state } : null;
  const snapshotKind = state.kind === "open" ? state.snapshot.kind : "idle";

  React.useEffect(
    loadProductDescriptionEffect.bind(null, props.organisationId, productId, state, setState),
    [props.organisationId, productId, state.kind, snapshotKind],
  );
  React.useEffect(
    refreshProductDescriptionOnSourceChange.bind(null, source?.revision, sourceRevision, setState),
    [source?.revision],
  );

  if (state.kind === "closed" && source === null) return null;
  return <section className="commerce-dossier-section description-draft-section" aria-labelledby="description-draft-title">
    <div className="description-draft-heading">
      <div>
        <h3 id="description-draft-title">Description draft</h3>
        <p>Shape the next version together. The current product description stays unchanged.</p>
      </div>
      {state.kind === "closed" && source !== null &&
        <button type="button" className="secondary" disabled={source.freshness !== "current"}
          onClick={openDescriptionEditor.bind(null, source.revision, setState)}>
          Edit description draft
        </button>}
    </div>
    {state.kind === "open"
      ? <div className="description-draft-workspace">
          <div className="description-draft-editor-column">
            <React.Suspense fallback={<p className="description-draft-loading" role="status">Loading shared editor…</p>}>
              {source === null && <p className="description-draft-source-warning">The product’s source is unavailable. Keep this page open to copy any unsynced draft text.</p>}
              <DescriptionEditor key={`${props.organisationId}:${productId}`} organisationId={props.organisationId}
                productId={productId} currentProductRevision={source?.revision ?? state.productRevision}
                currentProduct={currentProductSnapshot(state.snapshot)} canPropose={props.canPropose === true}
                actionBusy={props.actionBusy === true} actionTransport={props.actionTransport}
                onActionProposed={props.onActionProposed === undefined
                  ? undefined
                  : handleProductDescriptionAction.bind(null, setState, props.onActionProposed)}
                onReviewRefresh={refreshProductDescription.bind(null, setState)} />
            </React.Suspense>
          </div>
          <ProductDescriptionReference state={state.snapshot} onRetry={retryProductDescription.bind(null, state, setState)} />
          <SlackThreadControl
            path={`${productDescriptionPath(props.organisationId, productId)}/shared-thread`}
            description="Owners and admins can connect one Slack thread to this draft. Its conversation and product-catalogue context may contribute to draft text visible to every portal collaborator. Other threads and sources stay restricted."
          />
        </div>
      : source !== null && source.freshness !== "current" &&
        <p className="description-draft-source-warning">Refresh the product’s source before opening its draft.</p>}
  </section>;
}

function openDescriptionEditor(productRevision: number, setState: React.Dispatch<React.SetStateAction<DraftControlState>>): void {
  setState({ kind: "open", productRevision, snapshot: { kind: "loading" } });
}

function retryProductDescription(state: DraftControlState, setState: React.Dispatch<React.SetStateAction<DraftControlState>>): void {
  if (state.kind !== "open") return;
  setState({ kind: "open", productRevision: state.productRevision, snapshot: { kind: "loading" } });
}

function loadProductDescriptionEffect(
  organisationId: string,
  productId: string,
  state: DraftControlState,
  setState: React.Dispatch<React.SetStateAction<DraftControlState>>,
): () => void {
  if (state.kind !== "open" || state.snapshot.kind !== "loading") return noCleanup;
  const request: ProductDescriptionLoad = { kind: "active", organisationId, productId, setState };
  void loadProductDescription(request);
  return cancelProductDescriptionLoad.bind(null, request);
}

async function loadProductDescription(request: ProductDescriptionLoad): Promise<void> {
  try {
    const response = await controlRead(productDescriptionPath(request.organisationId, request.productId));
    const value = parseProductDescriptionResponse(response, request.productId);
    if (request.kind === "active") request.setState(updateProductDescriptionSnapshot.bind(null, value));
  } catch (error) {
    if (request.kind === "active") request.setState(failProductDescriptionSnapshot.bind(null, productDescriptionError(error)));
  }
}

function cancelProductDescriptionLoad(request: ProductDescriptionLoad): void {
  request.kind = "cancelled";
}

function updateProductDescriptionSnapshot(
  value: ProductDescriptionResponse,
  state: DraftControlState,
): DraftControlState {
  return state.kind === "open" && state.snapshot.kind === "loading"
    ? { kind: "open", productRevision: state.productRevision, snapshot: { kind: "ready", value } }
    : state;
}

function failProductDescriptionSnapshot(message: string, state: DraftControlState): DraftControlState {
  return state.kind === "open" && state.snapshot.kind === "loading"
    ? { kind: "open", productRevision: state.productRevision, snapshot: { kind: "failed", message } }
    : state;
}

function productDescriptionPath(organisationId: string, productId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/products/${encodeURIComponent(productId)}/description-draft`;
}

function currentProductSnapshot(state: ProductDescriptionSnapshotState): ProductDescriptionSnapshot | null {
  return state.kind === "ready"
    ? { productId: state.value.canonicalProductId, title: state.value.product.title, description: state.value.product.description, revision: state.value.product.revision }
    : null;
}

function handleProductDescriptionAction(
  setState: React.Dispatch<React.SetStateAction<DraftControlState>>,
  onActionProposed: ((action: CommerceActionRecord) => void) | undefined,
  action: CommerceActionRecord,
): void {
  onActionProposed?.(action);
  setState(refreshProductDescriptionSnapshot);
}

function refreshProductDescription(setState: React.Dispatch<React.SetStateAction<DraftControlState>>): void {
  setState(refreshProductDescriptionSnapshot);
}

function refreshProductDescriptionOnSourceChange(
  revision: number | undefined,
  previousRevision: React.MutableRefObject<number | null>,
  setState: React.Dispatch<React.SetStateAction<DraftControlState>>,
): void {
  if (revision === undefined) return;
  const prior = previousRevision.current;
  previousRevision.current = revision;
  if (prior === null || prior === revision) return;
  setState(refreshProductDescriptionSnapshot);
}

function refreshProductDescriptionSnapshot(state: DraftControlState): DraftControlState {
  return state.kind === "open"
    ? { kind: "open", productRevision: state.productRevision, snapshot: { kind: "loading" } }
    : state;
}

function productDescriptionError(error: unknown): string {
  if (error instanceof ControlApiError) return error.message;
  return "Unable to load the current product description. Try again.";
}

function ProductDescriptionReference(props: Readonly<{
  state: ProductDescriptionSnapshotState;
  onRetry: () => void;
}>): React.ReactNode {
  return <aside className="description-draft-reference" aria-labelledby="description-draft-reference-title">
    <p className="description-draft-eyebrow">Current product</p>
    <h4 id="description-draft-reference-title">Product description</h4>
    {props.state.kind === "loading" && <p className="description-draft-muted" role="status">Loading current description…</p>}
    {props.state.kind === "failed" && <>
      <p className="description-draft-error" role="status">{props.state.message}</p>
      <button type="button" className="secondary description-draft-retry" onClick={props.onRetry}>Retry</button>
    </>}
    {props.state.kind === "ready" && <>
      <p className="description-draft-product-title">{props.state.value.product.title}</p>
      <p className="description-draft-current-copy">
        {props.state.value.product.description || "This product does not have a description yet."}
      </p>
      <p className="description-draft-reference-note">Draft edits do not change this product description.</p>
    </>}
  </aside>;
}

function noCleanup(): void {}
