/**
 * ?scenario=commerce-action: the agent's answer proposes a menu price and
 * links to the action, and the chat shows the change as a card with one
 * Approve and apply button (the owner, 2026-11-07). The fake action moves
 * from proposed to signed to confirmed, as the Worker answers them; the
 * shape is a production record with its ids replaced.
 */
const NONCE = "00000000-0000-4000-8000-00000000c0de";
let previewState: "proposed" | "signed" | "confirmed" | "rejected" = "proposed";
const calls: string[] = [];
let stepUpPending = new URLSearchParams(window.location.search).get("stepup") === "1";
// A browser journey reads which steps the card asked for.
Object.assign(window, { satyrCommercePreviewCalls: calls });

export function commercePreviewEnabled(): boolean {
  return new URLSearchParams(window.location.search).get("scenario") === "commerce-action";
}

export function commercePreviewAnswer(organisationPath: string): string {
  return `I've proposed lowering the Black sesame financier from ¥300 to ¥280. Nothing changes until an owner or admin approves it. [Approve the price change](${organisationPath}/operations?commerceAction=${NONCE})`;
}

function record(): Record<string, unknown> {
  return {
    ok: true,
    action: {
      nonce: { value: NONCE },
      caseId: "case_00000000000000000000000000000000",
      proposalId: "proposal_preview_price",
      state: previewState,
      verb: "commerce.menu.change_price",
      resourceKey: "commerce:change_menu_price:offer_preview_black_sesame",
      amount: null,
      details: {
        kind: "change_menu_price",
        offerId: "offer_preview_black_sesame",
        expectedOfferRevision: 2,
        menuEntryId: "menu_entry_preview_black_sesame",
        itemName: "Black sesame financier",
        before: { price: { amountMinor: 300, currency: "JPY" }, compareAtPrice: null },
        after: { price: { amountMinor: 280, currency: "JPY" }, compareAtPrice: null },
      },
      commerceSystem: { kind: "commerce_system", system: "satyr_commerce", revision: 1 },
      providerResult: null,
    },
  };
}

/** The Worker's answers for the one preview action; null for other paths. */
export function previewCommerceActionResponse(url: URL, init?: RequestInit): Response | null {
  const match = /\/commerce\/actions\/([^/]+)(\/(approval|execute|rejection))?$/u.exec(url.pathname);
  if (match === null || match[1] !== NONCE) return null;
  const step = match[3] ?? "read";
  const method = init?.method ?? "GET";
  calls.push(`${method} ${step}`);
  if (step === "read" && method === "GET") return Response.json(record());
  if (method !== "POST") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  if (step === "approval") {
    // &stepup=1: the first approval needs the step-up sign-in, as a stale
    // sign-in does in production.
    if (stepUpPending) {
      stepUpPending = false;
      return Response.json({ ok: false, error: "approval_step_up_required" }, { status: 409 });
    }
    if (previewState !== "proposed" && previewState !== "signed")
      return Response.json({ ok: false, error: "commerce_action_state_invalid" }, { status: 409 });
    previewState = "signed";
    return Response.json({ ok: true, state: "signed", approval: { kind: "google_oidc_step_up" } });
  }
  if (step === "execute") {
    if (previewState !== "signed")
      return Response.json({ ok: false, error: "commerce_action_state_invalid" }, { status: 409 });
    previewState = "confirmed";
    return Response.json(record());
  }
  previewState = "rejected";
  return Response.json(record());
}
