import type { BakeryServiceShiftInput } from "./shift-preset.ts";
import { FINANCIER_FLAVOURS } from "./financier-flavours.ts";
import { PIE_TYPES } from "./pie-products.ts";
import type { RetailOrder } from "./shift-inventory.ts";

export type ShiftDemand = Readonly<{
  sesameArrivalsSeconds: readonly number[];
  espressoArrivalsSeconds: readonly number[];
  pourOverArrivalsSeconds: readonly number[];
  retailOrders: readonly RetailOrder[];
}>;

/** Fixed, assumed demand supplied before execution. Supply never changes demand. */
export function bakeryShiftDemand(input: BakeryServiceShiftInput): ShiftDemand {
  const sixHour = input.kind === "six-hour-shift";
  let sesameArrivalsSeconds: readonly number[] = [
    3000, 3060, 3120, 3180, 3240, 3300, 3360, 3420, 3480, 3540, 3600, 3660,
  ];
  let espressoArrivalsSeconds: readonly number[] = [720, 1320, 1920, 2520];
  if (sixHour) {
    switch (input.demandPreset) {
      case "steady":
        sesameArrivalsSeconds = [
          2200, 2800, 5200, 5800, 8300, 8900, 9500, 12000, 12700, 13400, 17100,
          19000,
        ];
        espressoArrivalsSeconds = [300, 3900, 11400, 18300];
        break;
      case "gift-box-surge":
        sesameArrivalsSeconds = [
          2200, 2700, 5100, 5700, 8300, 8600, 9200, 11900, 12500, 13100, 17000,
          19000,
        ];
        espressoArrivalsSeconds = [300, 4020, 11460, 18240];
        break;
      case "rush":
        sesameArrivalsSeconds = [
          2200, 2500, 3000, 5200, 5800, 8300, 8800, 12000, 12600, 16900, 17400,
          19000,
        ];
        espressoArrivalsSeconds = [300, 3840, 11340, 18180];
        break;
    }
  }
  const retailOrders: RetailOrder[] = [];
  for (const [index, flavour] of FINANCIER_FLAVOURS.entries()) {
    const offset = index * 120;
    const arrivals = sixHour ? [1980, 9360, 12900, 18600] : [1980, 4680, 5100];
    for (const [order, arrival] of arrivals.entries()) {
      retailOrders.push({
        id: `retail-${flavour}-${order}`,
        atSeconds: arrival + offset,
        sku: `${flavour}-financier`,
        units: input.demandPreset === "gift-box-surge" && order === 1 ? 8 : 3,
      });
    }
  }
  for (const [index, pie] of PIE_TYPES.entries()) {
    if (input.piesPerType === 0) continue;
    for (const [order, arrival] of (sixHour
      ? [6600, 14400, 18600]
      : [6600, 7200]
    ).entries()) {
      retailOrders.push({
        id: `retail-${pie}-${order}`,
        atSeconds: arrival + index * 180,
        sku: `${pie}-pie`,
        units: 2,
      });
    }
  }
  retailOrders.sort(compareRetailOrders);
  return {
    sesameArrivalsSeconds,
    espressoArrivalsSeconds: espressoArrivalsSeconds.slice(
      0,
      input.espressoOrders,
    ),
    pourOverArrivalsSeconds: (sixHour ? [4400, 16400] : [780, 1980]).slice(
      0,
      input.pourOverOrders,
    ),
    retailOrders,
  };
}

function compareRetailOrders(left: RetailOrder, right: RetailOrder): number {
  return left.atSeconds - right.atSeconds || left.id.localeCompare(right.id);
}
