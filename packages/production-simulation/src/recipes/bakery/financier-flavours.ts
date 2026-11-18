/**
 * The four financiers that the shop sells. Each flavour is one batter batch of
 * the shared brown-butter base with the flavour's mix-ins. The mix-ins are
 * weighed on the scale and go into the bowl at the mix step.
 */
export const FINANCIER_FLAVOURS = [
  "hazelnut",
  "coffee",
  "matcha",
  "black-sesame",
] as const;
export type FinancierFlavour = (typeof FINANCIER_FLAVOURS)[number];

export const FINANCIER_BASE_INGREDIENTS = [
  "butter",
  "egg-whites",
  "almond-flour",
  "wheat-flour",
  "sugar",
] as const;
export const FINANCIER_MIX_INS = [
  "roasted-hazelnut-flour",
  "chopped-roasted-hazelnut",
  "instant-espresso",
  "matcha",
  "black-sesame-paste",
  "toasted-black-sesame-seeds",
] as const;
export type FinancierIngredient =
  | (typeof FINANCIER_BASE_INGREDIENTS)[number]
  | (typeof FINANCIER_MIX_INS)[number];

export type FinancierFlavourProduct = Readonly<{
  flavour: FinancierFlavour;
  /** Product name as the shop shows it. */
  title: string;
  /** Shop description. */
  description: string;
  /** Shop price, tax included. */
  unitPriceJpy: number;
}>;

export const FINANCIER_FLAVOUR_PRODUCTS: Readonly<
  Record<FinancierFlavour, FinancierFlavourProduct>
> = {
  hazelnut: {
    flavour: "hazelnut",
    title: "Hazelnut financier",
    description: "Brown butter and almond financier with roasted hazelnut",
    unitPriceJpy: 350,
  },
  coffee: {
    flavour: "coffee",
    title: "Coffee financier",
    description: "Brown butter and almond financier with espresso",
    unitPriceJpy: 330,
  },
  matcha: {
    flavour: "matcha",
    title: "Matcha financier",
    description: "Brown butter and almond financier with matcha",
    unitPriceJpy: 350,
  },
  "black-sesame": {
    flavour: "black-sesame",
    title: "Black sesame financier",
    description: "Brown butter and almond financier with toasted black sesame",
    unitPriceJpy: 330,
  },
};

/**
 * Reference formula for one batch that fills three 8-cavity loads, in
 * milligrams. The base is the earlier brown-butter financier without vanilla.
 * - hazelnut: 40 g almond flour becomes roasted hazelnut flour, plus 20 g
 *   chopped roasted hazelnut.
 * - coffee: 6 g instant espresso, dissolved in 10 g of the egg whites in the
 *   bowl before the rest of the batter goes in.
 * - matcha: 8 g matcha sifted in place of 8 g wheat flour.
 * - black sesame: 25 g toasted black sesame paste plus 5 g seeds.
 */
const REFERENCE_LOADS = 3;
const REFERENCE_FORMULA: Readonly<
  Record<
    FinancierFlavour,
    Readonly<Partial<Record<FinancierIngredient, number>>>
  >
> = {
  hazelnut: {
    butter: 180_000,
    "egg-whites": 180_000,
    "almond-flour": 60_000,
    "wheat-flour": 100_000,
    sugar: 195_000,
    "roasted-hazelnut-flour": 40_000,
    "chopped-roasted-hazelnut": 20_000,
  },
  coffee: {
    butter: 180_000,
    "egg-whites": 180_000,
    "almond-flour": 100_000,
    "wheat-flour": 100_000,
    sugar: 195_000,
    "instant-espresso": 6_000,
  },
  matcha: {
    butter: 180_000,
    "egg-whites": 180_000,
    "almond-flour": 100_000,
    "wheat-flour": 92_000,
    sugar: 195_000,
    matcha: 8_000,
  },
  "black-sesame": {
    butter: 180_000,
    "egg-whites": 180_000,
    "almond-flour": 100_000,
    "wheat-flour": 100_000,
    sugar: 195_000,
    "black-sesame-paste": 25_000,
    "toasted-black-sesame-seeds": 5_000,
  },
};
/** Water that leaves 180 g butter while it browns. */
const REFERENCE_BUTTER = 180_000;
const REFERENCE_EVAPORATION = 22_000;
/** Batter that stays on the bowl, beater and spatula. */
const REFERENCE_RESIDUE = 8_000;

/** Ingredients in weighing order: the shared base, then the mix-ins. */
export function financierIngredients(
  flavour: FinancierFlavour,
): readonly FinancierIngredient[] {
  const formula = REFERENCE_FORMULA[flavour];
  const ingredients: FinancierIngredient[] = [];
  for (const ingredient of FINANCIER_BASE_INGREDIENTS)
    if (formula[ingredient] !== undefined) ingredients.push(ingredient);
  for (const ingredient of FINANCIER_MIX_INS)
    if (formula[ingredient] !== undefined) ingredients.push(ingredient);
  return ingredients;
}

export type FinancierBatchFormula = Readonly<{
  ingredientsMg: Readonly<Partial<Record<FinancierIngredient, number>>>;
  brownedButterMg: number;
  evaporationMg: number;
  residueMg: number;
  batterMg: number;
}>;

/**
 * One flavour's batch, scaled to the loads it fills. Integer milligrams; the
 * batter mass is derived, so the browning and mixing balances are exact.
 */
export function financierBatchFormula(
  flavour: FinancierFlavour,
  loads: number,
): FinancierBatchFormula {
  const reference = REFERENCE_FORMULA[flavour];
  const ingredientsMg: Partial<Record<FinancierIngredient, number>> = {};
  let others = 0;
  let butter = 0;
  for (const ingredient of financierIngredients(flavour)) {
    const amount = Math.round(
      ((reference[ingredient] ?? 0) * loads) / REFERENCE_LOADS,
    );
    ingredientsMg[ingredient] = amount;
    if (ingredient === "butter") butter = amount;
    else others += amount;
  }
  const evaporationMg = Math.round(
    (butter * REFERENCE_EVAPORATION) / REFERENCE_BUTTER,
  );
  const residueMg = Math.round((REFERENCE_RESIDUE * loads) / REFERENCE_LOADS);
  const brownedButterMg = butter - evaporationMg;
  return {
    ingredientsMg,
    brownedButterMg,
    evaporationMg,
    residueMg,
    batterMg: brownedButterMg + others - residueMg,
  };
}

/** Ids that other recipes, shifts and the Portal read for one flavour. */
export function financierPreparationWorkflow(flavour: FinancierFlavour) {
  return `${flavour}-financier-preparation`;
}
export function financierPreparationSource(flavour: FinancierFlavour) {
  return `${flavour}-preparation-batches`;
}
export function preparedFinancierBatter(flavour: FinancierFlavour) {
  return `prepared-${flavour}-financier-batter`;
}
export function financierBatterHolding(flavour: FinancierFlavour) {
  return `${flavour}-batter-holding`;
}
export function financierBatterPrepared(flavour: FinancierFlavour) {
  return `${flavour}-batter-prepared`;
}
export function financierLoadId(flavour: FinancierFlavour, index: number) {
  return `load-${flavour}-${String.fromCharCode(97 + index)}`;
}

/** The flavour of a load or preparation workflow, instance or task id. */
export function financierFlavourOf(id: string): FinancierFlavour | null {
  const subject = id.split("#")[0] ?? id;
  for (const flavour of FINANCIER_FLAVOURS) {
    if (subject.startsWith(`load-${flavour}-`)) return flavour;
    if (subject.startsWith(`${flavour}-financier-preparation`)) return flavour;
    if (subject.startsWith(`${flavour}-preparation-batches`)) return flavour;
  }
  return null;
}
