import * as React from "react";
import { cancelDialog, DialogHeading, syncDialog } from "../../dialog";
import { formatOfferPrice } from "../governed-actions/commerce";
import { isRecord } from "@purin-labs/std";
import { type OfferPriceAllowanceView, type PricedOffer, parseOfferPriceAllowanceView, parsePricedOffers } from "@purin-labs/control-api/portal/price-allowance";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type OfferPriceAllowanceTransport = Readonly<{
  save: (
    organisationId: string,
    offerId: string,
    body: Readonly<{
      expectedRevision: number | null;
      maxMovementBps: number;
      expectedOfferRevision?: number;
    }>,
  ) => Promise<unknown>;
  withdraw: (
    organisationId: string,
    offerId: string,
    expectedRevision: number,
  ) => Promise<unknown>;
}>;

type AllowanceControlState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "saving" }>
  | Readonly<{ kind: "saved" }>
  | Readonly<{ kind: "failed"; message: string }>;

/**
 * Reads and sets how far one Offer's price may move without a fresh decision.
 *
 * Enabling an allowance is what makes unattended repricing possible at all, so
 * only an owner may write one; anyone who can see the Offer can read what band
 * a proposed change was judged against, which is what makes a price proposal
 * reviewable.
 */
export function OfferPriceAllowanceControl(
  props: Readonly<{
    organisationId: string;
    offer: PricedOffer;
    view: OfferPriceAllowanceView | null;
    canConfigure: boolean;
    transport: OfferPriceAllowanceTransport | undefined;
    busy: boolean;
    /**
     * Called once a write has landed, so the owner of the view can re-read it.
     * Without this the form keeps the revision it was rendered from, and the
     * next save is refused as stale for a change this same person just made.
     */
    onApplied?: () => void;
  }>,
): React.ReactNode {
  const [state, setState] = React.useState<AllowanceControlState>({
    kind: "idle",
  });
  const view = props.view;
  const [open, setOpen] = React.useState(false);
  const dialog = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  React.useEffect(syncDialog.bind(null, dialog, open), [open]);

  if (view === null) {
    return (
      <p className="commerce-empty">
        The allowance for this offer is unavailable.
      </p>
    );
  }

  const summary = allowanceSummary(view);
  if (!props.canConfigure || props.transport === undefined) {
    // A reviewer sees the band a proposed change would be judged against, and
    // no way to change it.
    return <p className="commerce-allowance-summary">{summary}</p>;
  }

  const transport = props.transport;
  const disabled = props.busy || state.kind === "saving";
  const close = setOpen.bind(null, false);
  const title =
    view.policy.kind === "enabled" ? "Edit allowance" : "Set allowance";
  return (
    <div className="commerce-allowance">
      <p className="commerce-allowance-summary">{summary}</p>
      <button
        type="button"
        className="secondary"
        onClick={setOpen.bind(null, true)}
        disabled={disabled}
      >
        {title}
      </button>
      <dialog
        ref={dialog}
        className="access35-dialog commerce-allowance-dialog"
        aria-labelledby={titleId}
        onCancel={cancelDialog.bind(null, close)}
        onClick={dismissAllowanceBackdrop.bind(null, close)}
      >
        <form
          aria-label={`Price allowance for ${allowanceVariantLabel(props.offer.variantId)}`}
          className="commerce-allowance-form"
          key={`${props.offer.offerId}-${view.policy.revision}`}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void submitAllowance({
              transport,
              organisationId: props.organisationId,
              offerId: props.offer.offerId,
              view,
              movement: Number(form.get("maxMovementBps")),
              setState,
              onApplied: props.onApplied,
            });
          }}
        >
          <DialogHeading id={titleId} title={title} close={close} />
          <p className="commerce-allowance-dialog-product">
            {allowanceVariantLabel(props.offer.variantId)}
          </p>
          <p>{summary}</p>
          <label>
            <span>Allowed movement (basis points)</span>
            <input
              aria-label={`Allowed movement (basis points) for ${allowanceVariantLabel(props.offer.variantId)}`}
              placeholder="e.g. 500 for 5%"
              name="maxMovementBps"
              type="number"
              min={1}
              max={10_000}
              required
              disabled={disabled}
              defaultValue={
                view.policy.kind === "enabled"
                  ? String(view.policy.maxMovementBps)
                  : ""
              }
            />
          </label>
          <p className="commerce-allowance-help">
            100 basis points = 1%. For example, 500 allows a 5% movement from
            the reference price.
          </p>
          <div className="commerce-allowance-dialog-actions">
            <button type="button" className="secondary" onClick={close}>
              Cancel
            </button>
            <button type="submit" disabled={disabled}>
              {state.kind === "saving" ? "Saving allowance…" : "Save allowance"}
            </button>
            {view.policy.kind === "enabled" ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  void withdrawAllowance({
                    transport,
                    organisationId: props.organisationId,
                    offerId: props.offer.offerId,
                    view,
                    setState,
                    onApplied: props.onApplied,
                  });
                }}
              >
                Withdraw allowance
              </button>
            ) : null}
          </div>
          {state.kind === "failed" ? (
            <p role="alert" className="form-error">
              {state.message}
            </p>
          ) : null}
          {state.kind === "saved" ? (
            <p role="status">Allowance saved.</p>
          ) : null}
        </form>
      </dialog>
    </div>
  );
}

function dismissAllowanceBackdrop(
  close: () => void,
  event: React.MouseEvent<HTMLDialogElement>,
): void {
  if (event.target !== event.currentTarget) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    close();
}

type AllowanceWrite = Readonly<{
  transport: OfferPriceAllowanceTransport;
  organisationId: string;
  offerId: string;
  view: OfferPriceAllowanceView;
  setState: (state: AllowanceControlState) => void;
  onApplied: (() => void) | undefined;
}>;

/**
 * Saves a band from the form's values.
 *
 * Lifted out of the component so the two things that matter can be asserted
 * without a browser: the write binds the revision and the price this form
 * was rendered from, and the owner of the view is told only once a write has
 * actually landed — never after a failure, which would re-read a revision
 * that did not change.
 */
export async function submitAllowance(
  input: AllowanceWrite & Readonly<{ movement: number }>,
): Promise<void> {
  const { movement, view } = input;
  if (!Number.isSafeInteger(movement) || movement <= 0 || movement > 10_000) {
    input.setState({
      kind: "failed",
      message: "Enter an allowance between 1 and 10000 basis points.",
    });
    return;
  }
  input.setState({ kind: "saving" });
  try {
    await input.transport.save(input.organisationId, input.offerId, {
      // Null names "no allowance yet"; anything else binds the revision this
      // form was rendered from, so two owners editing at once cannot both win.
      expectedRevision:
        view.policy.kind === "disabled" && view.policy.revision === 0
          ? null
          : view.policy.revision,
      maxMovementBps: movement,
      // The price this form showed. Applying refuses if it has moved since, so
      // the band is never measured from a price the owner did not see.
      expectedOfferRevision: view.currentOfferRevision,
    });
    input.setState({ kind: "saved" });
    input.onApplied?.();
  } catch (error: unknown) {
    input.setState({ kind: "failed", message: allowanceErrorMessage(error) });
  }
}

export async function withdrawAllowance(input: AllowanceWrite): Promise<void> {
  input.setState({ kind: "saving" });
  try {
    await input.transport.withdraw(
      input.organisationId,
      input.offerId,
      input.view.policy.revision,
    );
    input.setState({ kind: "saved" });
    input.onApplied?.();
  } catch (error: unknown) {
    input.setState({ kind: "failed", message: allowanceErrorMessage(error) });
  }
}

/**
 * Replaces one offer's view after a write landed, leaving the rest untouched.
 * Without this the form kept the revision it was rendered from, and the next
 * save was refused as stale for a change this same person had just made.
 */
export function mergeRefreshedView(
  current: OfferPriceAllowanceSectionState,
  offerId: string,
  view: OfferPriceAllowanceView,
): OfferPriceAllowanceSectionState {
  return current.kind === "ready"
    ? { ...current, views: { ...current.views, [offerId]: view } }
    : current;
}

/** What the allowance permits right now, in the words an operator needs. */
export function allowanceSummary(view: OfferPriceAllowanceView): string {
  const current = formatOfferPrice(view.currentPriceMinor, view.currency);
  if (view.policy.kind === "disabled" || view.allowedRange === null) {
    return `${current}. No allowance, so the price cannot be changed automatically.`;
  }
  const low = formatOfferPrice(view.allowedRange.minimumMinor, view.currency);
  const high = formatOfferPrice(view.allowedRange.maximumMinor, view.currency);
  const reference = formatOfferPrice(
    view.policy.referencePriceMinor,
    view.currency,
  );
  // The band is measured from the price the owner approved, not from today's,
  // so repeated small changes cannot walk the price away from it.
  return `${current}. Allowed between ${low} and ${high}, measured from ${reference}.`;
}

function allowanceErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The allowance could not be saved.";
}

const BASE = (organisationId: string) =>
  `/v1/control/organisations/${encodeURIComponent(organisationId)}`;

async function readPricedOffers(
  organisationId: string,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
): Promise<readonly PricedOffer[]> {
  const response = await fetcher(
    `${BASE(organisationId)}/commerce/priced-offers`,
    {
      method: "GET",
      headers: { accept: "application/json" },
    },
  );
  return parsePricedOffers(await response.json());
}

async function readOfferPriceAllowance(
  organisationId: string,
  offerId: string,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
): Promise<OfferPriceAllowanceView> {
  const response = await fetcher(
    `${BASE(organisationId)}/commerce/offers/${encodeURIComponent(offerId)}/price-policy`,
    { method: "GET", headers: { accept: "application/json" } },
  );
  return parseOfferPriceAllowanceView(await response.json());
}

/**
 * The allowance transport, over the same route the Portal reads.
 *
 * Every write carries an idempotency key derived from what it is changing, so
 * a retried save reports what it did instead of re-driving into a refusal
 * about a revision its own first attempt advanced.
 */
export function offerPriceAllowanceTransport(
  csrfToken: string,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
): OfferPriceAllowanceTransport {
  const write = async (
    organisationId: string,
    offerId: string,
    method: "PUT" | "DELETE",
    body: Readonly<Record<string, unknown>>,
    key: string,
  ): Promise<unknown> => {
    const response = await fetcher(
      `${BASE(organisationId)}/commerce/offers/${encodeURIComponent(offerId)}/price-policy`,
      {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-satyr-csrf": csrfToken,
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      },
    );
    const parsed: unknown = await response.json();
    if (!response.ok) throw new Error(allowanceRouteMessage(parsed));
    return parsed;
  };
  return {
    save: (organisationId, offerId, body) =>
      write(
        organisationId,
        offerId,
        "PUT",
        body,
        `allowance:${offerId}:${body.expectedRevision ?? "new"}:${body.maxMovementBps}`,
      ),
    withdraw: (organisationId, offerId, expectedRevision) =>
      write(
        organisationId,
        offerId,
        "DELETE",
        { expectedRevision },
        `allowance:${offerId}:${expectedRevision}:withdraw`,
      ),
  };
}

/** Says what the route refused, in words an operator can act on. */
function allowanceRouteMessage(body: unknown): string {
  const code =
    isRecord(body) && typeof body.error === "string"
      ? body.error
      : isRecord(body) && typeof body.code === "string"
        ? body.code
        : null;
  switch (code) {
    case "offer_price_policy_stale":
      return "Someone changed this allowance first. Reload and try again.";
    case "offer_price_moved":
      return "The price changed after this page loaded. Reload to see the new price, then set the allowance against it.";
    case "offer_price_policy_invalid":
      return "That allowance is not a value this offer can take.";
    case "offer_not_listed":
      return "This offer is not listed, so it has no price to govern.";
    case "underclerk_binding_missing":
    case "underclerk_unavailable":
      return "Commerce is unavailable right now.";
    case null:
      return "The allowance could not be saved.";
    default:
      return `The allowance could not be saved (${code}).`;
  }
}

type OfferPriceAllowanceSectionState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{
      kind: "ready";
      offers: readonly PricedOffer[];
      views: Readonly<Record<string, OfferPriceAllowanceView>>;
    }>;

/**
 * The price allowances a merchant's listed offers carry.
 *
 * It loads its own data rather than being fed by the commerce graph, because
 * the graph cannot reach an Offer: there is no product-to-offer relationship
 * and an Offer entity carries no price.
 */
export function OfferPriceAllowanceSection(
  props: Readonly<{
    organisationId: string;
    canConfigure: boolean;
    transport: OfferPriceAllowanceTransport | undefined;
    fetcher?: Fetcher;
  }>,
): React.ReactNode {
  const [state, setState] = React.useState<OfferPriceAllowanceSectionState>({
    kind: "loading",
  });
  const { organisationId, fetcher } = props;

  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const offers = await readPricedOffers(organisationId, fetcher);
        const views = await Promise.all(
          offers.map(
            async (offer) =>
              [
                offer.offerId,
                await readOfferPriceAllowance(
                  organisationId,
                  offer.offerId,
                  fetcher,
                ),
              ] as const,
          ),
        );
        if (live) {
          setState({ kind: "ready", offers, views: Object.fromEntries(views) });
        }
      } catch (error) {
        if (live)
          setState({ kind: "failed", message: allowanceErrorMessage(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [organisationId, fetcher]);

  return (
    <section
      className="portal-band commerce-panel commerce-allowances"
      aria-labelledby="commerce-allowances-title"
    >
      <div className="section-heading">
        <div>
          <h2 id="commerce-allowances-title">Price allowances</h2>
          <p>
            Set how far prices can change automatically. 100 basis points = 1%.
          </p>
        </div>
      </div>
      {renderAllowanceBody({ ...props, onApplied: refreshOffer }, state)}
    </section>
  );

  /** Re-reads one offer's allowance after a write, keeping its revision current. */
  async function refreshOffer(offerId: string): Promise<void> {
    try {
      const view = await readOfferPriceAllowance(
        organisationId,
        offerId,
        fetcher,
      );
      setState((current) => mergeRefreshedView(current, offerId, view));
    } catch {
      // The write landed; a failed re-read leaves the last known view rather
      // than replacing it with an error the owner did not cause.
    }
  }
}

/**
 * The section's body for one loaded state.
 *
 * Exported so each state can be rendered on its own: the section itself only
 * ever shows "loading" under static rendering, since its load runs in an
 * effect.
 */
function renderAllowanceBody(
  props: Readonly<{
    organisationId: string;
    canConfigure: boolean;
    transport: OfferPriceAllowanceTransport | undefined;
    onApplied?: (offerId: string) => void;
  }>,
  state: OfferPriceAllowanceSectionState,
): React.ReactNode {
  if (state.kind === "loading")
    return <p className="commerce-empty">Loading price allowances.</p>;
  if (state.kind === "failed") {
    return (
      <p role="alert" className="form-error">
        {state.message}
      </p>
    );
  }
  if (state.offers.length === 0) {
    return (
      <p className="empty-state commerce-empty">
        No offer is listed yet, so none has a price to govern.
      </p>
    );
  }
  return (
    <ul className="commerce-allowance-list">
      {state.offers.map((offer) => (
        <li key={offer.offerId}>
          <div className="commerce-allowance-product">
            <h3>{allowanceVariantLabel(offer.variantId)}</h3>
          </div>
          <OfferPriceAllowanceControl
            organisationId={props.organisationId}
            offer={offer}
            view={state.views[offer.offerId] ?? null}
            canConfigure={props.canConfigure}
            transport={props.transport}
            busy={false}
            onApplied={
              props.onApplied === undefined
                ? undefined
                : () => props.onApplied?.(offer.offerId)
            }
          />
        </li>
      ))}
    </ul>
  );
}

function allowanceVariantLabel(variantId: string): string {
  const label = (variantId.split(":").at(-1) ?? variantId)
    .replace(/^variant_/, "")
    .replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
