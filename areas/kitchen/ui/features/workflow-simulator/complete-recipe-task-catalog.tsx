import React from "react";
import {
  CATALOG_TIERS,
  ProductionCatalogGroup,
  ProductionCatalogItem,
} from "./catalog-group";
import type { CatalogSection } from "./production-workspace";

type CompleteRecipeTaskCard = Readonly<{
  section: Exclude<CatalogSection, null>;
  title: string;
  subtitle: string;
}>;

const COMPLETE_RECIPE_TASK_CARDS: readonly CompleteRecipeTaskCard[] = [
  {
    section: "siphon",
    title: "Siphon coffee physics",
    subtitle: "Hario ECA-3-B · seal, upflow, bamboo stir, steep & vacuum",
  },
  {
    section: "pour-over",
    title: "Pour-over station",
    subtitle: "FR10 gooseneck kettle · 4 timed spiral pours & scale tare",
  },
  {
    section: "espresso",
    title: "Espresso · Linea Classic S",
    subtitle: "Cup placement, 18 s pressurized extraction & service",
  },
  {
    section: "latte",
    title: "Caffe Latte · Milk steaming & pour",
    subtitle: "FR10 steam wand aeration, 63 °C whirlpool microfoam & Rosetta art",
  },
  {
    section: "black-sesame",
    title: "Black Sesame Milk · WSG60, Vitamix Quiet One & Severin SM 3587",
    subtitle:
      "FR10 4 × 55 g sesame grind, 760 g concentrate cold carrier & 65 °C milk service",
  },
  {
    section: "ginger-tea",
    title: "Ginger Black Tea & Two-Pan Milk Tea · FR10 Pan Staging",
    subtitle:
      "Heat-off steeping & rigid-insert pan staging to 78 °C milk finish",
  },
  {
    section: "financier-batter",
    title: "Financier Batter · Beurre Noisette & Hobart HL200",
    subtitle:
      "FR10 152 °C induction butter browning, Ohaus tare & 20 qt planetary mix",
  },
  {
    section: "financier-bake",
    title: "Financier Bake · Mould Depositing & Maruzen MBCO-5E",
    subtitle:
      "FR10 Matsunaga 8P dosing, 600 × 400 mm carrier load & 170 °C bosse bake",
  },
  {
    section: "financier-pack",
    title: "Financier Pack · Wire-Grid Demoulding & Gift Box",
    subtitle: "FR10 Matsunaga 8P demould, 23.5 g crumb check & gold-ribbon ballotin",
  },
  {
    section: "pastry-bench",
    title: "Pie Pastry Bench · Deformable Shortcrust & Puff Lid",
    subtitle: "MuJoCo 4.0.0 flexcomp · 3 mm shortcrust drape & 42 N fluted crimp",
  },
];

export function CompleteRecipeTaskCatalog(props: {
  readonly openCatalogSection: (section: CatalogSection) => void;
}): React.ReactNode {
  return (
    <ProductionCatalogGroup title={CATALOG_TIERS.task}>
      {COMPLETE_RECIPE_TASK_CARDS.map((card) => (
        <ProductionCatalogItem
          key={card.section}
          title={card.title}
          detail={card.subtitle}
          open={() => props.openCatalogSection(card.section)}
        />
      ))}
    </ProductionCatalogGroup>
  );
}
