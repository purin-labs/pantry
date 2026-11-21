// The money that Stripe and Square send to the merchant's bank (spec section
// 12). The providers decide when a payout moves, so each read asks them and
// keeps what they answer: a provider that does not answer leaves the last record
// in the view. A paid payout does not change its sales, so those are read once.
import type {
  CommerceBankPayoutsV1,
  CommerceBankPayoutSourceV1,
  CommerceBankPayoutV1,
} from "@purin-labs/commerce-client";
import { isRecord } from "@purin-labs/std";

import type { CommerceDatabase } from "../database.ts";
import type { SquareConnectionV1 } from "./square/square-connection.ts";
import type { SquarePaymentAccounts } from "./square/square-payments.ts";
import type { StripePaymentAccounts } from "./stripe/stripe-payments.ts";

type BankPayoutWindow = Readonly<{ start: string; end: string }>;

type Provider = CommerceBankPayoutV1["provider"];
type Status = CommerceBankPayoutV1["status"];
type SourceState = CommerceBankPayoutSourceV1["state"];

/** One Stripe account or one Square location. */
type Source = Readonly<{ provider: Provider; account: string }>;

type Listed = Readonly<{
  payoutId: string;
  amountMinor: number;
  currency: string;
  status: Status;
  arrivalDate: string;
  sentAt: string;
  /** False when the provider cannot list the sales of this payout. */
  listsSales: boolean;
}>;

type ListAnswer = Readonly<{
  state: SourceState;
  payouts: readonly Listed[];
  /** True when the provider had more payouts than this read looked at. */
  more: boolean;
}>;

type Sales = Readonly<{ from: string; to: string }>;

type Row = Readonly<{
  provider: Provider;
  account: string;
  payoutId: string;
  amountMinor: number;
  currency: string;
  status: Status;
  arrivalDate: string;
  sentAt: string;
  salesFrom: string | null;
  salesTo: string | null;
}>;

const PAGE_SIZE = 100;
/** The pages of payouts that one read looks at, for each source. */
const LIST_PAGES = 5;
/** The payouts that one read returns. */
const PAYOUT_LIMIT = 200;
/** The payouts whose sales one read looks up; the next read goes on. */
const SALES_READS = 32;
const SALES_READS_AT_ONCE = 6;
/** The pages of one Stripe payout's sales; a longer payout has no known sales. */
const STRIPE_SALES_PAGES = 20;
/** The longest window that one read takes. */
const MAX_WINDOW_DAYS = 370;
/** Square lists by creation time; a payout arrives within these days of it. */
const SQUARE_ARRIVAL_DAYS = 14;
const DAY_MS = 86_400_000;

/** Stripe's and Square's entries that are sales, not refunds or fees. */
const STRIPE_SALE_TYPES: ReadonlySet<unknown> = new Set(["charge", "payment"]);
const SQUARE_SALE_TYPE = "CHARGE";

/** A half-open window of calendar days; null when it is not one. */
export function parseBankPayoutWindow(
  start: string | null,
  end: string | null,
): BankPayoutWindow | null {
  if (start === null || end === null) return null;
  const from = dayStart(start);
  const to = dayStart(end);
  if (from === null || to === null) return null;
  if (from >= to || to - from > MAX_WINDOW_DAYS * DAY_MS) return null;
  return { start, end };
}

function dayStart(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return null;
  const at = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(at) || isoDay(at) !== day ? null : at;
}

function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export class BankPayouts {
  readonly #database: CommerceDatabase;
  readonly #stripe: StripePaymentAccounts | undefined;
  readonly #square: SquarePaymentAccounts | undefined;
  readonly #now: () => string;

  constructor(
    options: Readonly<{
      database: CommerceDatabase;
      stripe?: StripePaymentAccounts;
      square?: SquarePaymentAccounts;
      now: () => string;
    }>,
  ) {
    this.#database = options.database;
    this.#stripe = options.stripe;
    this.#square = options.square;
    this.#now = options.now;
  }

  async read(
    merchantId: string,
    window: BankPayoutWindow,
  ): Promise<CommerceBankPayoutsV1> {
    const sources = this.#sources(merchantId);
    const answers = await Promise.all(
      sources.map((source) => this.#list(merchantId, source, window)),
    );
    this.#database.transaction(() => {
      sources.forEach((source, index) => {
        for (const payout of answers[index]?.payouts ?? [])
          this.#keep(merchantId, source, payout);
      });
    });
    await this.#readSales(merchantId, sources, window);
    const rows = this.#rows(merchantId, window);
    return {
      schemaVersion: "commerce.bank-payouts.v1",
      merchantId,
      sources: sourceStates(sources, answers),
      truncated:
        rows.length > PAYOUT_LIMIT || answers.some((answer) => answer.more),
      payouts: rows.slice(0, PAYOUT_LIMIT).map(toPayout),
    };
  }

  #sources(merchantId: string): readonly Source[] {
    const stripe = (this.#stripe?.list(merchantId) ?? []).map(
      (account) => account.providerAccountId,
    );
    const square = (this.#square?.list(merchantId) ?? []).map(
      (account) => account.locationId,
    );
    return [
      ...[...new Set(stripe)].map((account): Source => ({
        provider: "stripe",
        account,
      })),
      ...[...new Set(square)].map((account): Source => ({
        provider: "square",
        account,
      })),
    ];
  }

  #list(
    merchantId: string,
    source: Source,
    window: BankPayoutWindow,
  ): Promise<ListAnswer> {
    return source.provider === "stripe"
      ? this.#listStripe(source.account, window)
      : this.#listSquare(merchantId, source.account, window);
  }

  async #listStripe(
    account: string,
    window: BankPayoutWindow,
  ): Promise<ListAnswer> {
    const api = this.#stripe?.api;
    if (api === undefined) return failedList("unavailable");
    const payouts: Listed[] = [];
    let after: string | undefined;
    for (let page = 0; page < LIST_PAGES; page += 1) {
      const query = new URLSearchParams({
        limit: String(PAGE_SIZE),
        "arrival_date[gte]": String(seconds(window.start)),
        "arrival_date[lt]": String(seconds(window.end)),
      });
      if (after !== undefined) query.set("starting_after", after);
      const answer = await api.request("GET", `/v1/payouts?${query}`, {
        account,
      });
      if (answer.kind !== "ok") return failedList(failure(answer));
      const data = Array.isArray(answer.body.data) ? answer.body.data : [];
      payouts.push(...data.flatMap(parseStripePayout));
      if (answer.body.has_more !== true)
        return { state: "read", payouts, more: false };
      const last: unknown = data.at(-1);
      if (!isRecord(last) || typeof last.id !== "string")
        return { state: "read", payouts, more: true };
      after = last.id;
    }
    return { state: "read", payouts, more: true };
  }

  async #listSquare(
    merchantId: string,
    location: string,
    window: BankPayoutWindow,
  ): Promise<ListAnswer> {
    const connections = this.#square?.connections;
    if (connections === undefined) return failedList("unavailable");
    const begin = Date.parse(`${window.start}T00:00:00.000Z`);
    // A shop ahead of UTC sends a payout on the day before its date in UTC.
    const end = Math.min(
      Date.parse(`${window.end}T00:00:00.000Z`) + DAY_MS,
      Date.parse(this.#now()),
    );
    const beginTime = begin - SQUARE_ARRIVAL_DAYS * DAY_MS;
    if (beginTime >= end) return { state: "read", payouts: [], more: false };
    const payouts: Listed[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGES; page += 1) {
      const query = new URLSearchParams({
        location_id: location,
        begin_time: new Date(beginTime).toISOString(),
        end_time: new Date(end).toISOString(),
        sort_order: "DESC",
        limit: String(PAGE_SIZE),
      });
      if (cursor !== undefined) query.set("cursor", cursor);
      const answer = await connections.readProvider(
        merchantId,
        `/v2/payouts?${query}`,
      );
      if (answer.kind !== "ok")
        return failedList(squareFailure(connections.read(merchantId), answer));
      const data = Array.isArray(answer.body.payouts)
        ? answer.body.payouts
        : [];
      payouts.push(
        ...data
          .flatMap(parseSquarePayout)
          .filter(
            (payout) =>
              window.start <= payout.arrivalDate &&
              payout.arrivalDate < window.end,
          ),
      );
      const next = answer.body.cursor;
      if (typeof next !== "string" || next === "")
        return { state: "read", payouts, more: false };
      cursor = next;
    }
    return { state: "read", payouts, more: true };
  }

  #keep(merchantId: string, source: Source, payout: Listed): void {
    this.#database
      .prepare(
        `INSERT INTO bank_payout (
           merchant_id, provider, provider_payout_id, provider_account,
           amount_minor, currency, status, arrival_date, sent_at, sales_read, read_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (merchant_id, provider, provider_payout_id) DO UPDATE SET
           amount_minor = excluded.amount_minor,
           currency = excluded.currency,
           status = excluded.status,
           arrival_date = excluded.arrival_date,
           read_at = excluded.read_at`,
      )
      .run(
        merchantId,
        source.provider,
        payout.payoutId,
        source.account,
        payout.amountMinor,
        payout.currency,
        payout.status,
        payout.arrivalDate,
        payout.sentAt,
        payout.listsSales ? 0 : 1,
        this.#now(),
      );
  }

  /** Looks up the sales of the kept payouts that have none yet, newest first. */
  async #readSales(
    merchantId: string,
    sources: readonly Source[],
    window: BankPayoutWindow,
  ): Promise<void> {
    const connected = new Set(
      sources.map((source) => `${source.provider}:${source.account}`),
    );
    const waiting = this.#database
      .prepare(
        `SELECT provider, provider_account AS account, provider_payout_id AS payoutId
         FROM bank_payout
         WHERE merchant_id = ? AND sales_read = 0
           AND arrival_date >= ? AND arrival_date < ?
         ORDER BY arrival_date DESC, provider_payout_id`,
      )
      .all<Pick<Row, "provider" | "account" | "payoutId">>(
        merchantId,
        window.start,
        window.end,
      )
      .filter((row) => connected.has(`${row.provider}:${row.account}`))
      .slice(0, SALES_READS);
    for (let index = 0; index < waiting.length; index += SALES_READS_AT_ONCE) {
      await Promise.all(
        waiting.slice(index, index + SALES_READS_AT_ONCE).map(async (row) => {
          const sales =
            row.provider === "stripe"
              ? await this.#stripeSales(row.account, row.payoutId)
              : await this.#squareSales(merchantId, row.payoutId);
          if (sales === undefined) return;
          this.#database
            .prepare(
              `UPDATE bank_payout SET sales_read = 1, sales_from = ?, sales_to = ?
               WHERE merchant_id = ? AND provider = ? AND provider_payout_id = ?`,
            )
            .run(
              sales?.from ?? null,
              sales?.to ?? null,
              merchantId,
              row.provider,
              row.payoutId,
            );
        }),
      );
    }
  }

  /** The sales of a payout; null when it has none; undefined when not read. */
  async #stripeSales(
    account: string,
    payoutId: string,
  ): Promise<Sales | null | undefined> {
    const api = this.#stripe?.api;
    if (api === undefined) return undefined;
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    let after: string | undefined;
    for (let page = 0; page < STRIPE_SALES_PAGES; page += 1) {
      const query = new URLSearchParams({
        payout: payoutId,
        limit: String(PAGE_SIZE),
      });
      if (after !== undefined) query.set("starting_after", after);
      const answer = await api.request(
        "GET",
        `/v1/balance_transactions?${query}`,
        { account },
      );
      if (answer.kind !== "ok") return undefined;
      const data: readonly unknown[] = Array.isArray(answer.body.data)
        ? answer.body.data
        : [];
      for (const entry of data) {
        if (!isRecord(entry) || !STRIPE_SALE_TYPES.has(entry.type)) continue;
        if (typeof entry.created !== "number") continue;
        first = Math.min(first, entry.created);
        last = Math.max(last, entry.created);
      }
      const end = data.at(-1);
      if (answer.body.has_more !== true)
        return first > last
          ? null
          : { from: fromSeconds(first), to: fromSeconds(last) };
      if (!isRecord(end) || typeof end.id !== "string") return null;
      after = end.id;
    }
    return null;
  }

  /** Square sorts entries by time, so each end of the list gives one limit. */
  async #squareSales(
    merchantId: string,
    payoutId: string,
  ): Promise<Sales | null | undefined> {
    const connections = this.#square?.connections;
    if (connections === undefined) return undefined;
    const end = async (
      order: "ASC" | "DESC",
    ): Promise<string | null | undefined> => {
      const query = new URLSearchParams({
        sort_order: order,
        limit: String(PAGE_SIZE),
      });
      const answer = await connections.readProvider(
        merchantId,
        `/v2/payouts/${encodeURIComponent(payoutId)}/payout-entries?${query}`,
      );
      if (answer.kind !== "ok") return undefined;
      const entries: readonly unknown[] = Array.isArray(
        answer.body.payout_entries,
      )
        ? answer.body.payout_entries
        : [];
      for (const entry of entries)
        if (
          isRecord(entry) &&
          entry.type === SQUARE_SALE_TYPE &&
          isInstant(entry.effective_at)
        )
          return new Date(entry.effective_at).toISOString();
      return null;
    };
    const [from, to] = await Promise.all([end("ASC"), end("DESC")]);
    if (from === undefined || to === undefined) return undefined;
    return from === null || to === null ? null : { from, to };
  }

  #rows(merchantId: string, window: BankPayoutWindow): readonly Row[] {
    return this.#database
      .prepare(
        `SELECT provider, provider_account AS account,
           provider_payout_id AS payoutId, amount_minor AS amountMinor, currency,
           status, arrival_date AS arrivalDate, sent_at AS sentAt,
           sales_from AS salesFrom, sales_to AS salesTo
         FROM bank_payout
         WHERE merchant_id = ? AND arrival_date >= ? AND arrival_date < ?
         ORDER BY arrival_date DESC, provider_payout_id
         LIMIT ?`,
      )
      .all<Row>(merchantId, window.start, window.end, PAYOUT_LIMIT + 1);
  }
}

function failedList(state: Exclude<SourceState, "read">): ListAnswer {
  return { state, payouts: [], more: false };
}

/**
 * Square's connection names why it stopped: a scope that the seller did not
 * grant, a token that Square refused to refresh, or the application removed
 * in Square. Another refusal is read as Stripe's is.
 */
function squareFailure(
  connection: SquareConnectionV1 | undefined,
  answer:
    | Readonly<{ kind: "unavailable" }>
    | Readonly<{ kind: "refused"; status: number }>,
): Exclude<SourceState, "read"> {
  switch (connection?.state) {
    case "scope_missing":
    case "refresh_failed":
    case "revoked":
      return connection.state;
    case "connected":
    case undefined:
      return failure(answer);
  }
}

/** A provider that refuses the key or the token needs a new permission. */
function failure(
  answer:
    | Readonly<{ kind: "unavailable" }>
    | Readonly<{ kind: "refused"; status: number }>,
): Exclude<SourceState, "read"> {
  return answer.kind === "refused" &&
    (answer.status === 401 || answer.status === 403)
    ? "needs_permission"
    : "unavailable";
}

/** One state for each provider: the worst of its sources. */
function sourceStates(
  sources: readonly Source[],
  answers: readonly ListAnswer[],
): CommerceBankPayoutsV1["sources"] {
  const states = new Map<Provider, SourceState>();
  sources.forEach((source, index) => {
    const state = answers[index]?.state ?? "unavailable";
    const known = states.get(source.provider);
    // A cause that the operator must act on stays over an outage.
    if (
      known === undefined ||
      ((known === "read" || known === "unavailable") && state !== "read")
    )
      states.set(source.provider, state);
  });
  return [...states].map(([provider, state]) => ({ provider, state }));
}

function toPayout(row: Row): CommerceBankPayoutV1 {
  return {
    provider: row.provider,
    payoutId: row.payoutId,
    amount: { amountMinor: row.amountMinor, currency: row.currency },
    status: row.status,
    arrivalDate: row.arrivalDate,
    sentAt: row.sentAt,
    sales:
      row.salesFrom === null || row.salesTo === null
        ? null
        : { from: row.salesFrom, to: row.salesTo },
  };
}

function parseStripePayout(raw: unknown): readonly Listed[] {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !Number.isSafeInteger(raw.amount) ||
    typeof raw.currency !== "string" ||
    typeof raw.arrival_date !== "number" ||
    typeof raw.created !== "number"
  )
    return [];
  const status = stripeStatus(raw.status);
  if (status === null) return [];
  return [
    {
      payoutId: raw.id,
      amountMinor: raw.amount as number,
      currency: raw.currency.toUpperCase(),
      status,
      arrivalDate: isoDay(raw.arrival_date * 1_000),
      sentAt: fromSeconds(raw.created),
      // Stripe lists the sales of the payouts that it starts by itself only.
      listsSales: raw.automatic === true,
    },
  ];
}

function stripeStatus(raw: unknown): Status | null {
  switch (raw) {
    case "pending":
    case "in_transit":
      return "on_its_way";
    case "paid":
      return "arrived";
    case "failed":
      return "failed";
    case "canceled":
      return "cancelled";
    default:
      return null;
  }
}

function parseSquarePayout(raw: unknown): readonly Listed[] {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !isRecord(raw.amount_money) ||
    !Number.isSafeInteger(raw.amount_money.amount) ||
    !isInstant(raw.created_at)
  )
    return [];
  // The sandbox on 2026-11-03 answers `currency_code`; the reference says `currency`.
  const currency = raw.amount_money.currency_code ?? raw.amount_money.currency;
  if (typeof currency !== "string") return [];
  const status = squareStatus(raw.status);
  if (status === null) return [];
  const sentAt = new Date(raw.created_at).toISOString();
  return [
    {
      payoutId: raw.id,
      amountMinor: raw.amount_money.amount as number,
      currency,
      status,
      arrivalDate:
        typeof raw.arrival_date === "string" &&
        dayStart(raw.arrival_date) !== null
          ? raw.arrival_date
          : sentAt.slice(0, 10),
      sentAt,
      listsSales: true,
    },
  ];
}

function squareStatus(raw: unknown): Status | null {
  switch (raw) {
    case "SENT":
      return "on_its_way";
    case "PAID":
      return "arrived";
    case "FAILED":
      return "failed";
    default:
      return null;
  }
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function seconds(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) / 1_000;
}

function fromSeconds(at: number): string {
  return new Date(at * 1_000).toISOString();
}
