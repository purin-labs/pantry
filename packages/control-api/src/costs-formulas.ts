/**
 * Plan 86: Safe deterministic spreadsheet expression parser (`fx`) and two-way
 * goal solvers for the Kitchen Costs & margins workbook.
 *
 * Operators can either:
 * 1. Type a plain number into any column (`Units / d`, `Spoil`, `Price`, `COGS`,
 *    `Waste`, `Unit net`, `Margin`, `Net / day`) to set an override or back-solve
 *    the upstream input (`Price` or `Units / d`), or
 * 2. Type an Excel-style formula starting with `=` (for example `= BOM * 0.92`,
 *    `= INGR + PACK + 15`, `= D4 * 1.08`, or `= CEIL(COGS / (1 - 65% - TAX_RATE - FEE_RATE))`).
 */

export const COST_FORMULA_COLUMNS = [
  "units",
  "spoil",
  "price",
  "cogs",
  "waste",
  "unitNet",
  "margin",
  "netDay",
] as const;

export type CostFormulaColumn = (typeof COST_FORMULA_COLUMNS)[number];

const FORMULA_COLUMN_SET: ReadonlySet<string> = new Set(COST_FORMULA_COLUMNS);

export function isCostFormulaColumn(
  value: unknown,
): value is CostFormulaColumn {
  return typeof value === "string" && FORMULA_COLUMN_SET.has(value);
}

/** Excel column letters for `1. Product Margins` (`A` is Product title). */
export const COST_COLUMN_LETTERS: Readonly<Record<CostFormulaColumn, string>> =
  {
    units: "B",
    spoil: "C",
    price: "D",
    cogs: "E",
    waste: "F",
    unitNet: "H",
    margin: "I",
    netDay: "J",
  };

const LETTER_TO_COLUMN: Readonly<Record<string, CostFormulaColumn | "taxFee">> =
  {
    B: "units",
    C: "spoil",
    D: "price",
    E: "cogs",
    F: "waste",
    G: "taxFee",
    H: "unitNet",
    I: "margin",
    J: "netDay",
  };

export type CostFormulaRowContext = Readonly<{
  /** 1-based row index in the current sheet view. */
  rowNumber?: number;
  fulfillmentKind: "stocked" | "prepared";
  units: number;
  spoilPct: number;
  rejectPct: number;
  priceMajor: number;
  bomMajor: number;
  ingrMajor: number;
  packMajor: number;
  cogsMajor: number;
  wasteMajor: number;
  taxMajor: number;
  feeMajor: number;
  taxFeeMajor: number;
  taxPct: number;
  feePct: number;
  taxRate: number;
  feeRate: number;
  unitNetMajor: number;
  marginPct: number;
  netDayMajor: number;
  batchYield: number;
  batchesPerDay: number;
  /** Optional lookup for cross-row cell references like `D4` or `E2`. */
  resolveCell?: (
    col: CostFormulaColumn | "taxFee",
    rowNumber1Based: number,
  ) => number | null;
}>;

export type CostFormulaEvalResult =
  | Readonly<{ ok: true; value: number; normalized: string }>
  | Readonly<{
      ok: false;
      error: "syntax_error" | "division_by_zero" | "unknown_ref" | "cycle";
      message: string;
    }>;

/** Returns the human-readable default formula shown in the `fx` bar for a column. */
export function defaultCostColumnFormula(
  column: CostFormulaColumn | "taxFee",
  fulfillmentKind: "stocked" | "prepared",
): string {
  switch (column) {
    case "units":
      return "= ROUND(SUM(MON:SUN) / 7, 0)";
    case "spoil":
      return fulfillmentKind === "stocked" ? "= ASSUMED_SPOIL" : "= 0";
    case "price":
      return "= OFFER_PRICE";
    case "cogs":
      return "= INGR + PACK";
    case "waste":
      return fulfillmentKind === "stocked"
        ? "= MAX(0, (BATCHES * BATCH_YIELD * INGR) / UNITS - INGR)"
        : "= (INGR + PACK) * (1 / (1 - REJECT%) - 1)";
    case "taxFee":
      return "= TAX + FEE";
    case "unitNet":
      return "= PRICE - COGS - WASTE - TAX_FEE";
    case "margin":
      return "= (UNIT_NET / PRICE) * 100";
    case "netDay":
      return "= UNITS * UNIT_NET";
  }
}

export function isFormulaExpression(raw: string): boolean {
  return raw.trimStart().startsWith("=");
}

export function normalizeFormulaExpression(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("=")) {
    return `= ${trimmed}`;
  }
  const body = trimmed.slice(1).trim();
  return `= ${body}`;
}

/**
 * Validates that a formula string is syntactically well-formed and within CRDT
 * size limits (`<= 160` characters).
 */
export function isValidCostFormulaString(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 160) {
    return false;
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith("=")) {
    return false;
  }
  const body = trimmed.slice(1).trim();
  if (body.length === 0) {
    return false;
  }
  const tokens = tokenizeFormula(body);
  return tokens.ok && tokens.tokens.length > 0;
}

type Token =
  | Readonly<{ kind: "number"; value: number }>
  | Readonly<{ kind: "ident"; name: string }>
  | Readonly<{ kind: "op"; op: "+" | "-" | "*" | "/" | "%" }>
  | Readonly<{
      kind: "cmp";
      op: "=" | "==" | "!=" | "<>" | "<" | "<=" | ">" | ">=";
    }>
  | Readonly<{ kind: "lparen" }>
  | Readonly<{ kind: "rparen" }>
  | Readonly<{ kind: "comma" }>;

function tokenizeFormula(
  body: string,
):
  | Readonly<{ ok: true; tokens: readonly Token[] }>
  | Readonly<{ ok: false; message: string }> {
  const tokens: Token[] = [];
  let i = 0;
  let depth = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      tokens.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth < 0) {
        return { ok: false, message: "Unmatched closing parenthesis." };
      }
      tokens.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" });
      i += 1;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%") {
      tokens.push({ kind: "op", op: ch });
      i += 1;
      continue;
    }
    const twoChar = body.slice(i, i + 2);
    if (
      twoChar === "==" ||
      twoChar === "!=" ||
      twoChar === "<>" ||
      twoChar === "<=" ||
      twoChar === ">="
    ) {
      tokens.push({ kind: "cmp", op: twoChar });
      i += 2;
      continue;
    }
    if (ch === "=" || ch === "<" || ch === ">") {
      tokens.push({ kind: "cmp", op: ch });
      i += 1;
      continue;
    }
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      let end = i;
      let seenDot = false;
      while (end < body.length) {
        const c = body[end]!;
        if (c === ".") {
          if (seenDot) break;
          seenDot = true;
          end += 1;
        } else if (c >= "0" && c <= "9") {
          end += 1;
        } else {
          break;
        }
      }
      const slice = body.slice(i, end);
      const parsed = Number(slice);
      if (!Number.isFinite(parsed)) {
        return { ok: false, message: `Invalid number "${slice}".` };
      }
      tokens.push({ kind: "number", value: parsed });
      i = end;
      continue;
    }
    if (
      (ch >= "A" && ch <= "Z") ||
      (ch >= "a" && ch <= "z") ||
      ch === "_"
    ) {
      let end = i + 1;
      while (end < body.length) {
        const c = body[end]!;
        if (
          (c >= "A" && c <= "Z") ||
          (c >= "a" && c <= "z") ||
          (c >= "0" && c <= "9") ||
          c === "_"
        ) {
          end += 1;
        } else {
          break;
        }
      }
      tokens.push({ kind: "ident", name: body.slice(i, end).toUpperCase() });
      i = end;
      continue;
    }
    return { ok: false, message: `Unexpected character "${ch}".` };
  }
  if (depth !== 0) {
    return { ok: false, message: "Unclosed parenthesis in formula." };
  }
  return { ok: true, tokens };
}

/**
 * Evaluates an Excel-style formula expression against a product row's variables.
 */
export function evaluateCostFormula(
  rawFormula: string,
  context: CostFormulaRowContext,
): CostFormulaEvalResult {
  const trimmed = rawFormula.trim();
  const body = trimmed.startsWith("=") ? trimmed.slice(1).trim() : trimmed;
  if (body.length === 0) {
    return {
      ok: false,
      error: "syntax_error",
      message: "Enter an expression after '='.",
    };
  }
  const tokenized = tokenizeFormula(body);
  if (!tokenized.ok) {
    return {
      ok: false,
      error: "syntax_error",
      message: tokenized.message,
    };
  }
  const tokens = tokenized.tokens;
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const consume = (): Token | undefined => {
    const t = tokens[pos];
    pos += 1;
    return t;
  };

  const resolveVariable = (name: string): CostFormulaEvalResult => {
    switch (name) {
      case "UNITS":
      case "DAILY_UNITS":
        return { ok: true, value: context.units, normalized: name };
      case "SPOIL":
      case "SPOIL_PCT":
      case "ASSUMED_SPOIL":
        return { ok: true, value: context.spoilPct, normalized: name };
      case "REJECT":
      case "REJECT_PCT":
        return { ok: true, value: context.rejectPct, normalized: name };
      case "PRICE":
      case "OFFER_PRICE":
        return { ok: true, value: context.priceMajor, normalized: name };
      case "BOM":
      case "BOM_COST":
        return { ok: true, value: context.bomMajor, normalized: name };
      case "INGR":
      case "INGREDIENT":
      case "INGREDIENTS":
        return { ok: true, value: context.ingrMajor, normalized: name };
      case "PACK":
      case "PACKAGING":
        return { ok: true, value: context.packMajor, normalized: name };
      case "COGS":
        return { ok: true, value: context.cogsMajor, normalized: name };
      case "WASTE":
        return { ok: true, value: context.wasteMajor, normalized: name };
      case "TAX":
        return { ok: true, value: context.taxMajor, normalized: name };
      case "FEE":
        return { ok: true, value: context.feeMajor, normalized: name };
      case "TAX_FEE":
      case "TAXFEE":
        return { ok: true, value: context.taxFeeMajor, normalized: name };
      case "TAX_PCT":
        return { ok: true, value: context.taxPct, normalized: name };
      case "FEE_PCT":
        return { ok: true, value: context.feePct, normalized: name };
      case "TAX_RATE":
        return { ok: true, value: context.taxRate, normalized: name };
      case "FEE_RATE":
        return { ok: true, value: context.feeRate, normalized: name };
      case "UNIT_NET":
      case "UNITNET":
      case "NET":
        return { ok: true, value: context.unitNetMajor, normalized: name };
      case "MARGIN":
      case "MARGIN_PCT":
        return { ok: true, value: context.marginPct, normalized: name };
      case "NET_DAY":
      case "NETDAY":
      case "DAILY_NET":
        return { ok: true, value: context.netDayMajor, normalized: name };
      case "BATCH_YIELD":
      case "YIELD":
        return { ok: true, value: context.batchYield, normalized: name };
      case "BATCHES":
      case "RUNS":
        return { ok: true, value: context.batchesPerDay, normalized: name };
    }

    // Check cell coordinate like D4, E1, H12
    const cellMatch = /^([B-J])([1-9][0-9]{0,2})$/u.exec(name);
    if (cellMatch !== null) {
      const colLetter = cellMatch[1]!;
      const targetRow = Number(cellMatch[2]!);
      const colId = LETTER_TO_COLUMN[colLetter];
      if (colId !== undefined) {
        if (
          context.rowNumber !== undefined &&
          targetRow === context.rowNumber &&
          context.resolveCell === undefined
        ) {
          return resolveSameRowColumn(colId, context, name);
        }
        if (context.resolveCell !== undefined) {
          const val = context.resolveCell(colId, targetRow);
          if (val !== null && Number.isFinite(val)) {
            return { ok: true, value: val, normalized: name };
          }
        } else {
          return resolveSameRowColumn(colId, context, name);
        }
      }
    }

    return {
      ok: false,
      error: "unknown_ref",
      message: `Unknown variable or cell "${name}". Use PRICE, COGS, BOM, INGR, PACK, WASTE, SPOIL, UNITS, TAX_FEE, UNIT_NET, MARGIN, or B1..J24.`,
    };
  };

  function parseComparison(): CostFormulaEvalResult {
    const left = parseAdditive();
    if (!left.ok) return left;
    const next = peek();
    if (next?.kind === "cmp") {
      consume();
      const right = parseAdditive();
      if (!right.ok) return right;
      let passed = false;
      switch (next.op) {
        case "=":
        case "==":
          passed = Math.abs(left.value - right.value) < 1e-9;
          break;
        case "!=":
        case "<>":
          passed = Math.abs(left.value - right.value) >= 1e-9;
          break;
        case "<":
          passed = left.value < right.value;
          break;
        case "<=":
          passed = left.value <= right.value + 1e-9;
          break;
        case ">":
          passed = left.value > right.value;
          break;
        case ">=":
          passed = left.value + 1e-9 >= right.value;
          break;
      }
      return { ok: true, value: passed ? 1 : 0, normalized: body };
    }
    return left;
  }

  function parseAdditive(): CostFormulaEvalResult {
    let left = parseMultiplicative();
    if (!left.ok) return left;
    while (true) {
      const next = peek();
      if (next?.kind === "op" && (next.op === "+" || next.op === "-")) {
        consume();
        const right = parseMultiplicative();
        if (!right.ok) return right;
        const val: number =
          next.op === "+" ? left.value + right.value : left.value - right.value;
        left = { ok: true, value: val, normalized: body };
      } else {
        break;
      }
    }
    return left;
  }

  function parseMultiplicative(): CostFormulaEvalResult {
    let left = parseUnary();
    if (!left.ok) return left;
    while (true) {
      const next = peek();
      if (next?.kind === "op" && (next.op === "*" || next.op === "/")) {
        consume();
        const right = parseUnary();
        if (!right.ok) return right;
        if (next.op === "/") {
          if (Math.abs(right.value) < 1e-12) {
            return {
              ok: false,
              error: "division_by_zero",
              message: "Formula divides by zero (#DIV/0!).",
            };
          }
          left = {
            ok: true,
            value: left.value / right.value,
            normalized: body,
          };
        } else {
          left = {
            ok: true,
            value: left.value * right.value,
            normalized: body,
          };
        }
      } else {
        break;
      }
    }
    return left;
  }

  function parseUnary(): CostFormulaEvalResult {
    const next = peek();
    if (next?.kind === "op" && (next.op === "+" || next.op === "-")) {
      consume();
      const inner = parseUnary();
      if (!inner.ok) return inner;
      return {
        ok: true,
        value: next.op === "-" ? -inner.value : inner.value,
        normalized: body,
      };
    }
    return parsePostfix();
  }

  function parsePostfix(): CostFormulaEvalResult {
    let primary = parsePrimary();
    if (!primary.ok) return primary;
    while (true) {
      const next = peek();
      if (next?.kind === "op" && next.op === "%") {
        consume();
        primary = {
          ok: true,
          value: primary.value / 100,
          normalized: body,
        };
      } else {
        break;
      }
    }
    return primary;
  }

  function parsePrimary(): CostFormulaEvalResult {
    const tok = consume();
    if (tok === undefined) {
      return {
        ok: false,
        error: "syntax_error",
        message: "Unexpected end of formula.",
      };
    }
    if (tok.kind === "number") {
      return { ok: true, value: tok.value, normalized: body };
    }
    if (tok.kind === "lparen") {
      const inner = parseComparison();
      if (!inner.ok) return inner;
      const close = consume();
      if (close?.kind !== "rparen") {
        return {
          ok: false,
          error: "syntax_error",
          message: "Missing closing parenthesis ')'.",
        };
      }
      return inner;
    }
    if (tok.kind === "ident") {
      if (peek()?.kind === "lparen") {
        consume(); // '('
        const args: number[] = [];
        if (peek()?.kind !== "rparen") {
          while (true) {
            const arg = parseComparison();
            if (!arg.ok) return arg;
            args.push(arg.value);
            if (peek()?.kind === "comma") {
              consume();
              continue;
            }
            break;
          }
        }
        const close = consume();
        if (close?.kind !== "rparen") {
          return {
            ok: false,
            error: "syntax_error",
            message: `Missing ')' after ${tok.name}(...).`,
          };
        }
        return evaluateFunction(tok.name, args, body);
      }
      return resolveVariable(tok.name);
    }
    return {
      ok: false,
      error: "syntax_error",
      message: "Invalid token in formula.",
    };
  };

  const result = parseComparison();
  if (!result.ok) {
    return result;
  }
  if (pos < tokens.length) {
    return {
      ok: false,
      error: "syntax_error",
      message: "Unexpected trailing tokens in formula.",
    };
  }
  if (!Number.isFinite(result.value)) {
    return {
      ok: false,
      error: "division_by_zero",
      message: "Formula produced a non-finite value.",
    };
  }
  return {
    ok: true,
    value: result.value,
    normalized: normalizeFormulaExpression(rawFormula),
  };
}

function resolveSameRowColumn(
  colId: CostFormulaColumn | "taxFee",
  context: CostFormulaRowContext,
  name: string,
): CostFormulaEvalResult {
  switch (colId) {
    case "units":
      return { ok: true, value: context.units, normalized: name };
    case "spoil":
      return { ok: true, value: context.spoilPct, normalized: name };
    case "price":
      return { ok: true, value: context.priceMajor, normalized: name };
    case "cogs":
      return { ok: true, value: context.cogsMajor, normalized: name };
    case "waste":
      return { ok: true, value: context.wasteMajor, normalized: name };
    case "taxFee":
      return { ok: true, value: context.taxFeeMajor, normalized: name };
    case "unitNet":
      return { ok: true, value: context.unitNetMajor, normalized: name };
    case "margin":
      return { ok: true, value: context.marginPct, normalized: name };
    case "netDay":
      return { ok: true, value: context.netDayMajor, normalized: name };
  }
}

function evaluateFunction(
  fnName: string,
  args: readonly number[],
  body: string,
): CostFormulaEvalResult {
  switch (fnName) {
    case "ROUND": {
      if (args.length < 1 || args.length > 2) {
        return {
          ok: false,
          error: "syntax_error",
          message: "ROUND(value, [digits]) takes 1 or 2 arguments.",
        };
      }
      const digits = Math.trunc(args[1] ?? 0);
      const factor = 10 ** digits;
      return {
        ok: true,
        value: Math.round(args[0]! * factor) / factor,
        normalized: body,
      };
    }
    case "CEIL":
    case "CEILING":
    case "ROUNDUP": {
      if (args.length < 1 || args.length > 2) {
        return {
          ok: false,
          error: "syntax_error",
          message: `${fnName}(value, [digits]) takes 1 or 2 arguments.`,
        };
      }
      const digits = Math.trunc(args[1] ?? 0);
      const factor = 10 ** digits;
      return {
        ok: true,
        value: Math.ceil(args[0]! * factor) / factor,
        normalized: body,
      };
    }
    case "FLOOR":
    case "ROUNDDOWN": {
      if (args.length < 1 || args.length > 2) {
        return {
          ok: false,
          error: "syntax_error",
          message: `${fnName}(value, [digits]) takes 1 or 2 arguments.`,
        };
      }
      const digits = Math.trunc(args[1] ?? 0);
      const factor = 10 ** digits;
      return {
        ok: true,
        value: Math.floor(args[0]! * factor) / factor,
        normalized: body,
      };
    }
    case "MIN": {
      if (args.length === 0) {
        return {
          ok: false,
          error: "syntax_error",
          message: "MIN(...) requires at least 1 argument.",
        };
      }
      return { ok: true, value: Math.min(...args), normalized: body };
    }
    case "MAX": {
      if (args.length === 0) {
        return {
          ok: false,
          error: "syntax_error",
          message: "MAX(...) requires at least 1 argument.",
        };
      }
      return { ok: true, value: Math.max(...args), normalized: body };
    }
    case "SUM": {
      if (args.length === 0) {
        return {
          ok: false,
          error: "syntax_error",
          message: "SUM(...) requires at least 1 argument.",
        };
      }
      return {
        ok: true,
        value: args.reduce((acc, v) => acc + v, 0),
        normalized: body,
      };
    }
    case "AVG":
    case "AVERAGE": {
      if (args.length === 0) {
        return {
          ok: false,
          error: "syntax_error",
          message: `${fnName}(...) requires at least 1 argument.`,
        };
      }
      return {
        ok: true,
        value: args.reduce((acc, v) => acc + v, 0) / args.length,
        normalized: body,
      };
    }
    case "ABS": {
      if (args.length !== 1) {
        return {
          ok: false,
          error: "syntax_error",
          message: "ABS(value) takes 1 argument.",
        };
      }
      return { ok: true, value: Math.abs(args[0]!), normalized: body };
    }
    case "IF": {
      if (args.length !== 3) {
        return {
          ok: false,
          error: "syntax_error",
          message: "IF(condition, when_true, when_false) takes 3 arguments.",
        };
      }
      return {
        ok: true,
        value: args[0]! !== 0 ? args[1]! : args[2]!,
        normalized: body,
      };
    }
    default:
      return {
        ok: false,
        error: "unknown_ref",
        message: `Unknown function "${fnName}". Supported: ROUND, CEIL, FLOOR, MIN, MAX, SUM, AVG, ABS, IF.`,
      };
  }
}

/**
 * Two-way solver: given a target per-unit net contribution (`Unit net ¥`),
 * solves for the gross offer price (`Price ¥`) after included tax and channel fee.
 */
export function backSolveGrossPriceMinorForUnitNet(input: Readonly<{
  fixedUnitCostMinor: number;
  includedTaxBps: number;
  channelFeeBps: number;
  targetUnitNetMinor: number;
}>): number | null {
  const taxBps = clampInt(input.includedTaxBps, 0, 10_000);
  const feeBps = clampInt(input.channelFeeBps, 0, 3_000);
  const fixedCost = Math.max(0, input.fixedUnitCostMinor);
  const targetNet = clampNum(input.targetUnitNetMinor, -100_000_000, 100_000_000);
  const taxShare = taxBps > 0 ? taxBps / (10_000 + taxBps) : 0;
  const feeShare = feeBps / 10_000;
  const keepRatio = 1 - taxShare - feeShare;
  if (keepRatio <= 0.01) {
    return null;
  }
  const requiredBeforeTaxAndFee = fixedCost + targetNet;
  if (requiredBeforeTaxAndFee <= 0) {
    return 0;
  }
  const approx = Math.max(0, Math.ceil(requiredBeforeTaxAndFee / keepRatio));
  const start = Math.max(0, approx - 4);
  const end = Math.min(100_000_000, approx + 8);
  for (let candidate = start; candidate <= end; candidate += 1) {
    const taxMinor =
      taxBps > 0 ? Math.round((candidate * taxBps) / (10_000 + taxBps)) : 0;
    const feeMinor = (candidate * feeBps) / 10_000;
    const netMinor = candidate - fixedCost - taxMinor - feeMinor;
    if (netMinor + 0.5 >= targetNet) {
      return candidate;
    }
  }
  return clampInt(approx, 0, 100_000_000);
}

/**
 * Two-way solver: given a target daily net profit (`Net / day ¥`), solves for
 * daily units sold (`Units / d`).
 */
export function backSolveDailyUnitsForNetDay(input: Readonly<{
  targetDailyNetMinor: number;
  unitNetContributionMinor: number;
}>): number | null {
  const targetDailyNet = clampNum(
    input.targetDailyNetMinor,
    0,
    1_000_000_000,
  );
  if (targetDailyNet === 0) {
    return 0;
  }
  if (input.unitNetContributionMinor <= 0) {
    return null;
  }
  const solved = Math.ceil(targetDailyNet / input.unitNetContributionMinor);
  return clampInt(solved, 0, 100_000);
}

function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
