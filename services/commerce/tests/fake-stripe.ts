// A stand-in for api.stripe.com in journeys. It only records calls and
// answers them from its own state; the journey moves that state where Stripe
// would (the buyer's card confirmation, the bank finishing a refund), and
// Commerce's code must produce every outcome that the journey asserts.
type Form = Record<string, string>;

export type RecordedStripeCall = Readonly<{
  method: string;
  path: string;
  account: string | null;
}>;

type Intent = {
  id: string;
  account: string;
  amount: number;
  currency: string;
  status: string;
  metadata: Record<string, string>;
};

type Refund = {
  id: string;
  account: string;
  paymentIntent: string;
  amount: number;
  currency: string;
  status: string;
  metadata: Record<string, string>;
};

export class FakeStripe {
  readonly calls: RecordedStripeCall[] = [];
  readonly #accounts = new Set<string>();
  readonly #intents = new Map<string, Intent>();
  readonly #refunds = new Map<string, Refund>();
  readonly #answers = new Map<string, Record<string, unknown>>();
  /** The status that the next new refund takes. */
  nextRefundStatus: "succeeded" | "pending" = "succeeded";
  /** When set, the next new refund is made but its answer is lost. */
  loseNextRefundAnswer = false;

  /** A connected account with card payments in Japan. */
  connect(account: string): void {
    this.#accounts.add(account);
  }

  /** What Stripe.js does when the buyer's card is confirmed. */
  succeed(paymentIntentId: string): void {
    this.#intent(paymentIntentId).status = "succeeded";
  }

  /**
   * What Stripe does when the buyer's bank declines the card: the
   * PaymentIntent waits for another payment method.
   */
  decline(paymentIntentId: string): void {
    this.#intent(paymentIntentId).status = "requires_payment_method";
  }

  /** The bank finishes a pending refund. */
  finishRefund(refundId: string): void {
    const refund = this.#refunds.get(refundId);
    if (refund === undefined) throw new Error(`No refund ${refundId}`);
    refund.status = "succeeded";
  }

  /** A PaymentIntent that someone else made on the account (not Commerce). */
  foreignIntent(account: string, amount: number): string {
    const id = `pi_foreign_${this.#intents.size + 1}`;
    this.#intents.set(id, {
      id,
      account,
      amount,
      currency: "jpy",
      status: "succeeded",
      metadata: {},
    });
    return id;
  }

  refundsOf(paymentIntentId: string): readonly Readonly<Refund>[] {
    return [...this.#refunds.values()].filter(
      (refund) => refund.paymentIntent === paymentIntentId,
    );
  }

  posts(path: string): number {
    return this.calls.filter(
      (call) => call.method === "POST" && call.path === path,
    ).length;
  }

  /** A Connect event, as Stripe would send it to a webhook endpoint. */
  event(
    type: string,
    account: string,
    object: Record<string, unknown>,
    createdAt: string,
  ): string {
    return JSON.stringify({
      id: `evt_${type.replaceAll(".", "_")}_${this.calls.length}_${Date.parse(createdAt)}`,
      object: "event",
      type,
      account,
      created: Math.floor(Date.parse(createdAt) / 1_000),
      data: { object },
    });
  }

  intentObject(paymentIntentId: string): Record<string, unknown> {
    return this.#intentBody(this.#intent(paymentIntentId));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const account = headers.get("stripe-account");
    this.calls.push({ method, path: url.pathname, account });
    const form = Object.fromEntries(
      new URLSearchParams(
        typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
      ),
    ) as Form;
    const key = headers.get("idempotency-key");
    if (key !== null && this.#answers.has(key))
      return Response.json(this.#answers.get(key));
    const segments = url.pathname.split("/").filter(Boolean);
    if (method === "GET" && segments[1] === "accounts")
      return this.#accounts.has(segments[2] ?? "")
        ? Response.json({
            id: segments[2],
            object: "account",
            country: "JP",
            default_currency: "jpy",
            charges_enabled: true,
            details_submitted: true,
          })
        : missing();
    if (account === null || !this.#accounts.has(account)) return missing();
    if (method === "POST" && url.pathname === "/v1/payment_intents") {
      const intent: Intent = {
        id: `pi_fake_${this.#intents.size + 1}`,
        account,
        amount: Number(form.amount),
        currency: form.currency ?? "",
        status: "requires_payment_method",
        metadata: metadataOf(form),
      };
      this.#intents.set(intent.id, intent);
      return this.#answer(key, this.#intentBody(intent));
    }
    if (method === "GET" && segments[1] === "payment_intents") {
      const intent = this.#intents.get(segments[2] ?? "");
      return intent === undefined || intent.account !== account
        ? missing()
        : Response.json(this.#intentBody(intent));
    }
    if (method === "POST" && url.pathname === "/v1/refunds") {
      const refund: Refund = {
        id: `re_fake_${this.#refunds.size + 1}`,
        account,
        paymentIntent: form.payment_intent ?? "",
        amount: Number(form.amount),
        currency: this.#intent(form.payment_intent ?? "").currency,
        status: this.nextRefundStatus,
        metadata: metadataOf(form),
      };
      this.#refunds.set(refund.id, refund);
      const answer = this.#answer(key, refundBody(refund));
      if (!this.loseNextRefundAnswer) return answer;
      this.loseNextRefundAnswer = false;
      if (key !== null) this.#answers.delete(key);
      return Response.json({ error: { type: "api_error" } }, { status: 500 });
    }
    if (method === "GET" && url.pathname === "/v1/refunds") {
      const paymentIntent = url.searchParams.get("payment_intent");
      return Response.json({
        object: "list",
        data: [...this.#refunds.values()]
          .filter(
            (refund) =>
              refund.account === account &&
              refund.paymentIntent === paymentIntent,
          )
          .map(refundBody),
      });
    }
    if (method === "GET" && segments[1] === "refunds") {
      const refund = this.#refunds.get(segments[2] ?? "");
      return refund === undefined || refund.account !== account
        ? missing()
        : Response.json(refundBody(refund));
    }
    return missing();
  };

  #intent(id: string): Intent {
    const intent = this.#intents.get(id);
    if (intent === undefined) throw new Error(`No PaymentIntent ${id}`);
    return intent;
  }

  #intentBody(intent: Intent): Record<string, unknown> {
    return {
      id: intent.id,
      object: "payment_intent",
      amount: intent.amount,
      currency: intent.currency,
      status: intent.status,
      client_secret: `${intent.id}_secret_fake`,
      metadata: intent.metadata,
    };
  }

  #answer(key: string | null, body: Record<string, unknown>): Response {
    if (key !== null) this.#answers.set(key, body);
    return Response.json(body);
  }
}

function refundBody(refund: Refund): Record<string, unknown> {
  return {
    id: refund.id,
    object: "refund",
    amount: refund.amount,
    currency: refund.currency,
    payment_intent: refund.paymentIntent,
    status: refund.status,
    metadata: refund.metadata,
  };
}

function metadataOf(form: Form): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(form)) {
    const match = /^metadata\[(.+)\]$/u.exec(name);
    if (match?.[1] !== undefined) metadata[match[1]] = value;
  }
  return metadata;
}

function missing(): Response {
  return Response.json(
    { error: { type: "invalid_request_error", code: "resource_missing" } },
    { status: 404 },
  );
}
