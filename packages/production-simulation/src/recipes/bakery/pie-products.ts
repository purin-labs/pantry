/**
 * The two savoury pies that the shop sells. Each pie is 12 cm and about 450 g:
 * a shortcrust base, a braised beef filling and a bought-in puff pastry lid.
 */
export const PIE_TYPES = ["steak-and-pepper", "beef-bourguignon"] as const;
export type PieType = (typeof PIE_TYPES)[number];

type PieProduct = Readonly<{
  pie: PieType;
  /** Product name as the shop shows it. */
  title: string;
  /** The filling, as the shop describes it. */
  description: string;
  /** Shop price, tax included. */
  unitPriceJpy: number;
}>;

export const PIE_PRODUCTS: Readonly<Record<PieType, PieProduct>> = {
  "steak-and-pepper": {
    pie: "steak-and-pepper",
    title: "Steak and pepper pie",
    description: "Beef, cracked black pepper and gravy",
    unitPriceJpy: 1_600,
  },
  "beef-bourguignon": {
    pie: "beef-bourguignon",
    title: "Beef bourguignon pie",
    description: "Beef, red wine, mushroom and pearl onion",
    unitPriceJpy: 1_600,
  },
};

/** The pie type of a filling or pie workflow, instance or task id. */
export function pieTypeOf(id: string): PieType | null {
  const subject = id.split("#")[0] ?? id;
  for (const pie of PIE_TYPES) if (subject.startsWith(`${pie}-`)) return pie;
  return null;
}
