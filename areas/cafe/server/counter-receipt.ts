import {
  RECEIPT_COLUMNS,
  type CounterRegisterPaymentMethod,
  type ReceiptLayout,
  type ReceiptLine,
} from "@purin-labs/control-api";

/**
 * The 80 mm receipt of one counter sale (Plan 90 Phase 5), as lines that the
 * shop gateway encodes for its printer. Commerce's order record is the only
 * source of the figures: the lines and their totals include the consumption
 * tax, and the tax of each line comes from the order.
 *
 * A Japanese simplified Qualified Invoice (適格簡易請求書) needs the seller's
 * registration number, the date, the items, the total for each tax rate and
 * the tax or the rate. The rate of a line is the one that its tax and price
 * give, rounded to a known rate; items at the reduced rate (8 %) carry a mark.
 */

export type CounterReceiptLine = Readonly<{
  title: string;
  quantity: number;
  modifiers: readonly string[];
  /** The price of the line, tax included when `taxIncluded`. */
  lineTotalMinor: number;
  taxMinor: number;
}>;

type CounterReceiptTender =
  | Readonly<{ kind: "cash"; receivedMinor: number; changeMinor: number }>
  | Readonly<{
      kind: "electronic";
      method: CounterRegisterPaymentMethod | null;
      brand: string | null;
    }>;

export type CounterReceiptInput = Readonly<{
  shopName: string;
  /** "ja" for a Japanese receipt, any other locale for an English one. */
  locale: string;
  issuedAt: string;
  timeZone: string;
  pickupCode: string | null;
  orderId: string;
  currency: string;
  lines: readonly CounterReceiptLine[];
  totalMinor: number;
  taxIncluded: boolean;
  /** The counter policy's rate, the first guess for a line's rate. */
  configuredRateBasisPoints: number | null;
  invoiceRegistrationNumber: string | null;
  tender: CounterReceiptTender;
  copy: "original" | "reprint";
}>;

const REDUCED_RATE = 800;
const KNOWN_RATES = [800, 1_000] as const;
/** Yen rounding moves a small line's implied rate by up to this much. */
const RATE_TOLERANCE = 150;

type Labels = Readonly<{
  registration: string;
  pickup: string;
  total: string;
  taxable: (rate: string) => string;
  tax: string;
  reducedNote: string;
  cash: string;
  change: string;
  card: string;
  felica: string;
  qrCode: string;
  electronic: string;
  reprint: string;
  order: string;
  thanks: string;
}>;

const JAPANESE: Labels = {
  registration: "登録番号",
  pickup: "お受け取り番号",
  total: "合計",
  taxable: (rate) => `${rate}対象`,
  tax: "内消費税",
  reducedNote: "※は軽減税率(8%)対象",
  cash: "お預かり",
  change: "お釣り",
  card: "クレジット",
  felica: "電子マネー",
  qrCode: "QR決済",
  electronic: "キャッシュレス",
  reprint: "再発行",
  order: "注文",
  thanks: "ありがとうございました",
};

const ENGLISH: Labels = {
  registration: "Registration No.",
  pickup: "Pickup code",
  total: "Total",
  taxable: (rate) => `${rate} taxable`,
  tax: "Tax included",
  reducedNote: "※ Reduced rate (8%)",
  cash: "Cash",
  change: "Change",
  card: "Card",
  felica: "E-money",
  qrCode: "QR payment",
  electronic: "Cashless",
  reprint: "Reprint",
  order: "Order",
  thanks: "Thank you",
};

export function renderCounterReceipt(
  input: CounterReceiptInput,
): ReceiptLayout {
  const labels = input.locale.toLowerCase().startsWith("ja")
    ? JAPANESE
    : ENGLISH;
  const money = (minor: number) => formatMoney(minor, input.currency);
  const lines: ReceiptLine[] = [];
  const text = (
    value: string,
    align: "left" | "center" | "right" = "left",
    emphasis = false,
    size: "normal" | "double" = "normal",
  ) => lines.push({ kind: "text", text: value, align, emphasis, size });
  const columns = (left: string, right: string, emphasis = false) =>
    lines.push({ kind: "columns", left, right, emphasis });

  text(input.shopName, "center", true);
  if (input.invoiceRegistrationNumber !== null)
    text(`${labels.registration} ${input.invoiceRegistrationNumber}`, "center");
  text(formatTime(input.issuedAt, input.timeZone), "center");
  if (input.copy === "reprint") text(`[ ${labels.reprint} ]`, "center", true);
  lines.push({ kind: "rule" });
  if (input.pickupCode !== null) {
    text(labels.pickup, "center");
    text(input.pickupCode, "center", true, "double");
    lines.push({ kind: "rule" });
  }

  const rated = input.lines.map((line) => ({
    line,
    rate: lineRate(line, input.taxIncluded, input.configuredRateBasisPoints),
  }));
  const hasReduced = rated.some(({ rate }) => rate === REDUCED_RATE);
  for (const { line, rate } of rated) {
    const mark = hasReduced && rate === REDUCED_RATE ? "※" : "";
    const quantity = line.quantity === 1 ? "" : ` x${line.quantity}`;
    columns(`${mark}${line.title}${quantity}`, money(line.lineTotalMinor));
    for (const modifier of line.modifiers) text(`  ${modifier}`);
  }
  lines.push({ kind: "rule" });
  columns(labels.total, money(input.totalMinor), true);

  const groups = new Map<number, { taxable: number; tax: number }>();
  for (const { line, rate } of rated) {
    const group = groups.get(rate) ?? { taxable: 0, tax: 0 };
    group.taxable += line.lineTotalMinor;
    group.tax += line.taxMinor;
    groups.set(rate, group);
  }
  for (const [rate, group] of [...groups].sort(([a], [b]) => b - a)) {
    columns(`  ${labels.taxable(formatRate(rate))}`, money(group.taxable));
    columns(`  ${labels.tax}`, money(group.tax));
  }
  if (hasReduced) text(labels.reducedNote);

  lines.push({ kind: "rule" });
  switch (input.tender.kind) {
    case "cash":
      columns(labels.cash, money(input.tender.receivedMinor));
      columns(labels.change, money(input.tender.changeMinor), true);
      break;
    case "electronic": {
      const method =
        input.tender.method === "card"
          ? labels.card
          : input.tender.method === "felica"
            ? labels.felica
            : input.tender.method === "qr_code"
              ? labels.qrCode
              : labels.electronic;
      const brand = input.tender.brand === null ? "" : ` ${input.tender.brand}`;
      columns(`${method}${brand}`, money(input.totalMinor));
      break;
    }
  }
  lines.push({ kind: "feed", lines: 1 });
  text(`${labels.order} ${input.orderId}`, "center");
  text(labels.thanks, "center");
  return { columns: RECEIPT_COLUMNS, lines };
}

/** The rate of one line in basis points, from its own tax and price. */
function lineRate(
  line: CounterReceiptLine,
  taxIncluded: boolean,
  configured: number | null,
): number {
  const net = taxIncluded
    ? line.lineTotalMinor - line.taxMinor
    : line.lineTotalMinor;
  if (line.taxMinor <= 0 || net <= 0) return 0;
  const implied = (line.taxMinor * 10_000) / net;
  const candidates =
    configured === null ? KNOWN_RATES : [configured, ...KNOWN_RATES];
  let best = candidates[0] ?? REDUCED_RATE;
  for (const candidate of candidates)
    if (Math.abs(candidate - implied) < Math.abs(best - implied))
      best = candidate;
  return Math.abs(best - implied) <= RATE_TOLERANCE
    ? best
    : Math.round(implied / 100) * 100;
}

function formatRate(basisPoints: number): string {
  return `${basisPoints / 100}%`;
}

function formatMoney(minor: number, currency: string): string {
  const format = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 0;
  return format.format(minor / 10 ** digits);
}

function formatTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part("minute")}`;
}

/** Whether the runtime knows this IANA time zone. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64)
    return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
