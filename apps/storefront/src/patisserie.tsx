// The pâtisserie menu of shop.purin.io: a flavour chart of financiers, the
// hotcake financier, savoury pies with their cross-section, fruit pastries
// and a board of drinks. Commerce owns the items, prices and stock; this module owns
// how they look. Items are drawn in CSS until the shop has photographs.
import React from "react";

const FONT_STYLESHEET_ID = "patisserie-fonts";
const FONT_STYLESHEET =
  "https://fonts.googleapis.com/css2?family=Caveat:wght@500&family=Cormorant+Garamond:ital,wght@0,500;1,500&family=Noto+Serif+JP:wght@400;500&display=swap";

/** The fonts load only on the pâtisserie site, not on the Nuki demo. */
function usePatisserieFonts(): void {
  React.useEffect(() => {
    if (document.getElementById(FONT_STYLESHEET_ID) !== null) return;
    const link = document.createElement("link");
    link.id = FONT_STYLESHEET_ID;
    link.rel = "stylesheet";
    link.href = FONT_STYLESHEET;
    document.head.append(link);
  }, []);
}

export function patisserieMastheadDetail(language: PatisserieLanguage): string {
  return language === "ja"
    ? "パティスリー・東京 — 事前にご注文、店頭でお受け取り"
    : "Pâtisserie · Tokyo — order ahead, collect at the counter";
}

const PATISSERIE_SLUGS = [
  "financier_black_sesame",
  "financier_hazelnut",
  "financier_maple",
  "financier_matcha",
  "financier_ginger_citrus",
  "financier_apple_cinnamon",
  "financier_coffee",
  "financier_houjicha",
  "hotcake_financier",
  "pie_steak_pepper",
  "pie_beef_carotte",
  "pie_beef_bourguignon",
  "pie_curry_chicken",
  "pie_chicken_vegetables",
  "pastry_apple",
  "pastry_pear",
  "pastry_nectarine",
  "drink_pour_over",
  "drink_espresso",
  "drink_caffe_latte",
  "drink_matcha_latte",
  "drink_houjicha_latte",
  "drink_black_sesame_latte",
  "drink_ginger_latte",
] as const;

export type PatisserieSlug = (typeof PATISSERIE_SLUGS)[number];
export type PatisserieProductId = `menu_entry_patisserie_${PatisserieSlug}`;
type PatisserieLanguage = "en" | "ja";

type FinancierFlavour =
  | "sesame"
  | "hazelnut"
  | "maple"
  | "matcha"
  | "ginger"
  | "apple"
  | "coffee"
  | "houjicha";
type PieFilling = "pepper" | "carotte" | "bourguignon" | "curry" | "chicken";
type PastryFruit = "apple" | "pear" | "nectarine";
type DrinkGroup = "coffee" | "latte";

type PatisserieArt =
  | Readonly<{ kind: "financier"; flavour: FinancierFlavour }>
  | Readonly<{ kind: "hotcake" }>
  | Readonly<{ kind: "pie"; filling: PieFilling }>
  | Readonly<{ kind: "pastry"; fruit: PastryFruit }>
  | Readonly<{ kind: "drink"; group: DrinkGroup }>;

type LocalText = Readonly<Record<PatisserieLanguage, string>>;

type PatisserieCopy = Readonly<{
  title: string;
  description: string;
  allergens: string;
}>;

type PatisserieProduct = Readonly<{
  slug: PatisserieSlug;
  art: PatisserieArt;
  japaneseName: string;
  chartName: string;
  inside?: LocalText;
  copy: Readonly<Record<PatisserieLanguage, PatisserieCopy>>;
}>;

const FINANCIER_ALLERGENS: LocalText = {
  en: "almond, wheat, dairy, egg",
  ja: "アーモンド・小麦・乳・卵",
};

function financier(
  slug: PatisserieSlug,
  flavour: FinancierFlavour,
  chartName: string,
  japaneseName: string,
  en: string,
  ja: string,
  extraAllergen?: LocalText,
): PatisserieProduct {
  return {
    slug,
    art: { kind: "financier", flavour },
    japaneseName,
    chartName,
    copy: {
      en: {
        title: `${chartName.charAt(0).toUpperCase()}${chartName.slice(1)} financier`,
        description: en,
        allergens:
          extraAllergen === undefined
            ? FINANCIER_ALLERGENS.en
            : `${FINANCIER_ALLERGENS.en}, ${extraAllergen.en}`,
      },
      ja: {
        title: `${japaneseName}フィナンシェ`,
        description: ja,
        allergens:
          extraAllergen === undefined
            ? FINANCIER_ALLERGENS.ja
            : `${FINANCIER_ALLERGENS.ja}・${extraAllergen.ja}`,
      },
    },
  };
}

function pie(
  slug: PatisserieSlug,
  filling: PieFilling,
  title: LocalText,
  japaneseName: string,
  inside: LocalText,
  meat: LocalText,
): PatisserieProduct {
  return {
    slug,
    art: { kind: "pie", filling },
    japaneseName,
    chartName: title.en,
    inside,
    copy: {
      en: {
        title: title.en,
        description: `A 12 cm pie of about 450 g: puff pastry lid, shortcrust base, ${inside.en.toLowerCase()}.`,
        allergens: `wheat, dairy, egg, ${meat.en}`,
      },
      ja: {
        title: title.ja,
        description: `直径12cm・約450gのパイ。パイ生地のふたとショートクラストの土台に、${inside.ja}。`,
        allergens: `小麦・乳・卵・${meat.ja}`,
      },
    },
  };
}

function pastry(
  slug: PatisserieSlug,
  fruit: PastryFruit,
  title: LocalText,
  japaneseName: string,
  description: LocalText,
  allergens: LocalText,
): PatisserieProduct {
  return {
    slug,
    art: { kind: "pastry", fruit },
    japaneseName,
    chartName: title.en,
    copy: {
      en: {
        title: title.en,
        description: description.en,
        allergens: allergens.en,
      },
      ja: {
        title: title.ja,
        description: description.ja,
        allergens: allergens.ja,
      },
    },
  };
}

function drink(
  slug: PatisserieSlug,
  group: DrinkGroup,
  title: LocalText,
  description: LocalText,
  allergens: LocalText,
): PatisserieProduct {
  return {
    slug,
    art: { kind: "drink", group },
    japaneseName: title.ja,
    chartName: title.en,
    copy: {
      en: {
        title: title.en,
        description: description.en,
        allergens: allergens.en,
      },
      ja: {
        title: title.ja,
        description: description.ja,
        allergens: allergens.ja,
      },
    },
  };
}

const NO_ALLERGENS: LocalText = { en: "none", ja: "なし" };
const DAIRY: LocalText = { en: "dairy", ja: "乳" };
const BEEF: LocalText = { en: "beef", ja: "牛肉" };
const CHICKEN: LocalText = { en: "chicken", ja: "鶏肉" };
// The bourguignon braises bacon lardons with the beef (docs/recipes/pies.md).
const BEEF_AND_PORK: LocalText = { en: "beef, pork", ja: "牛肉・豚肉" };

export const PATISSERIE_PRODUCTS: readonly PatisserieProduct[] = [
  financier(
    "financier_black_sesame",
    "sesame",
    "black sesame",
    "黒ごま",
    "Brown butter and almond with toasted black sesame.",
    "焦がしバターとアーモンドに、香ばしい黒ごま。",
    { en: "sesame", ja: "ごま" },
  ),
  financier(
    "financier_hazelnut",
    "hazelnut",
    "hazelnut",
    "ヘーゼルナッツ",
    "Brown butter and roasted hazelnut.",
    "焦がしバターとローストしたヘーゼルナッツ。",
    { en: "hazelnut", ja: "ヘーゼルナッツ" },
  ),
  financier(
    "financier_maple",
    "maple",
    "maple",
    "メープル",
    "Brown butter and almond under a maple glaze.",
    "焦がしバターとアーモンドに、メープルのグレーズ。",
  ),
  financier(
    "financier_matcha",
    "matcha",
    "matcha",
    "抹茶",
    "Brown butter and almond with clean matcha bitterness.",
    "焦がしバターとアーモンドに、すっきりした抹茶の苦み。",
  ),
  financier(
    "financier_ginger_citrus",
    "ginger",
    "ginger citrus",
    "ジンジャーシトラス",
    "Brown butter with fresh ginger and candied citrus peel.",
    "焦がしバターに、生姜と柑橘ピール。",
  ),
  financier(
    "financier_apple_cinnamon",
    "apple",
    "apple cinnamon",
    "アップルシナモン",
    "Brown butter and almond with apple and cinnamon.",
    "焦がしバターとアーモンドに、りんごとシナモン。",
    { en: "apple", ja: "りんご" },
  ),
  financier(
    "financier_coffee",
    "coffee",
    "coffee",
    "コーヒー",
    "Brown butter and almond with espresso.",
    "焦がしバターとアーモンドに、エスプレッソ。",
  ),
  financier(
    "financier_houjicha",
    "houjicha",
    "houjicha",
    "ほうじ茶",
    "Brown butter and almond with roasted houjicha tea.",
    "焦がしバターとアーモンドに、香ばしいほうじ茶。",
  ),
  {
    slug: "hotcake_financier",
    art: { kind: "hotcake" },
    japaneseName: "ホットケーキ・フィナンシェ",
    chartName: "hotcake financier",
    copy: {
      en: {
        title: "Hotcake financier",
        description:
          "Our financier, baked the size of a hotcake. Brown butter and almond, crisp at the edge and soft in the middle.",
        allergens: FINANCIER_ALLERGENS.en,
      },
      ja: {
        title: "ホットケーキ・フィナンシェ",
        description:
          "ホットケーキの大きさに焼いたフィナンシェ。焦がしバターとアーモンド、縁はカリッと、中はしっとり。",
        allergens: FINANCIER_ALLERGENS.ja,
      },
    },
  },
  pie(
    "pie_steak_pepper",
    "pepper",
    { en: "Steak and pepper", ja: "ステーキ＆ペッパーパイ" },
    "ステーキ＆ペッパー",
    {
      en: "Beef, cracked black pepper, gravy",
      ja: "牛肉、粗挽き黒こしょう、グレイビー",
    },
    BEEF,
  ),
  pie(
    "pie_beef_carotte",
    "carotte",
    { en: "Beef and carotte", ja: "ビーフ＆キャロットパイ" },
    "ビーフ＆キャロット",
    { en: "Beef, carrot, thyme", ja: "牛肉、にんじん、タイム" },
    BEEF,
  ),
  pie(
    "pie_beef_bourguignon",
    "bourguignon",
    { en: "Beef bourguignon", ja: "ブッフ・ブルギニョンパイ" },
    "ブッフ・ブルギニョン",
    {
      en: "Beef, red wine, mushroom, pearl onion",
      ja: "牛肉、赤ワイン、マッシュルーム、小玉ねぎ",
    },
    BEEF_AND_PORK,
  ),
  pie(
    "pie_curry_chicken",
    "curry",
    { en: "Curry chicken", ja: "カレーチキンパイ" },
    "カレーチキン",
    { en: "Chicken, curry, potato", ja: "鶏肉、カレー、じゃがいも" },
    CHICKEN,
  ),
  pie(
    "pie_chicken_vegetables",
    "chicken",
    { en: "Chicken and vegetables", ja: "チキン＆野菜パイ" },
    "チキン＆野菜",
    {
      en: "Chicken, leek, carrot, cream",
      ja: "鶏肉、ポロねぎ、にんじん、クリーム",
    },
    CHICKEN,
  ),
  pastry(
    "pastry_apple",
    "apple",
    { en: "Apple", ja: "アップル" },
    "アップル",
    { en: "Puff pastry, apple, vanilla", ja: "パイ生地、りんご、バニラ" },
    { en: "wheat, dairy, egg, apple", ja: "小麦・乳・卵・りんご" },
  ),
  pastry(
    "pastry_pear",
    "pear",
    { en: "Pear", ja: "洋梨" },
    "洋梨",
    {
      en: "Puff pastry, pear, almond cream",
      ja: "パイ生地、洋梨、アーモンドクリーム",
    },
    { en: "wheat, dairy, egg, almond", ja: "小麦・乳・卵・アーモンド" },
  ),
  pastry(
    "pastry_nectarine",
    "nectarine",
    { en: "Nectarine", ja: "ネクタリン" },
    "ネクタリン",
    {
      en: "Puff pastry, nectarine, apricot glaze",
      ja: "パイ生地、ネクタリン、アプリコットのグレーズ",
    },
    { en: "wheat, dairy, egg, peach", ja: "小麦・乳・卵・もも" },
  ),
  drink(
    "drink_pour_over",
    "coffee",
    { en: "Pour-over coffee", ja: "ハンドドリップコーヒー" },
    {
      en: "Single-origin coffee, brewed by hand through a paper filter.",
      ja: "シングルオリジンの豆を、ペーパーフィルターで一杯ずつ淹れます。",
    },
    NO_ALLERGENS,
  ),
  drink(
    "drink_espresso",
    "coffee",
    { en: "Espresso", ja: "エスプレッソ" },
    {
      en: "A double shot of our espresso blend.",
      ja: "エスプレッソブレンドのダブルショット。",
    },
    NO_ALLERGENS,
  ),
  drink(
    "drink_caffe_latte",
    "coffee",
    { en: "Caffè latte", ja: "カフェラテ" },
    {
      en: "A double espresso with steamed whole milk.",
      ja: "ダブルエスプレッソに、スチームした牛乳を注いで。",
    },
    DAIRY,
  ),
  drink(
    "drink_matcha_latte",
    "latte",
    { en: "Matcha latte", ja: "抹茶ラテ" },
    {
      en: "Ceremonial matcha, whisked and topped with steamed milk.",
      ja: "点てた抹茶に、スチームミルクを注いで。",
    },
    DAIRY,
  ),
  drink(
    "drink_houjicha_latte",
    "latte",
    { en: "Houjicha latte", ja: "ほうじ茶ラテ" },
    {
      en: "Roasted green tea with steamed milk.",
      ja: "香ばしいほうじ茶に、スチームミルクを合わせて。",
    },
    DAIRY,
  ),
  drink(
    "drink_black_sesame_latte",
    "latte",
    { en: "Black sesame latte", ja: "黒ごまラテ" },
    {
      en: "Toasted black sesame, ground and warmed with milk.",
      ja: "炒った黒ごまをすりつぶし、牛乳で温めて。",
    },
    { en: "sesame, dairy", ja: "ごま・乳" },
  ),
  drink(
    "drink_ginger_latte",
    "latte",
    { en: "Ginger latte", ja: "ジンジャーラテ" },
    {
      en: "Fresh ginger, simmered and stirred into steamed milk.",
      ja: "生姜を煮出して、スチームミルクに合わせて。",
    },
    DAIRY,
  ),
];

export function patisserieProductId(slug: PatisserieSlug): PatisserieProductId {
  return `menu_entry_patisserie_${slug}`;
}

export function patisserieProduct(id: string): PatisserieProduct | undefined {
  return PATISSERIE_PRODUCTS.find(
    (product) => patisserieProductId(product.slug) === id,
  );
}

type MenuCopy = Readonly<{
  sections: string;
  financierHeading: [string, string];
  financierNote: string;
  pies: string;
  inside: string;
  pastryLid: string;
  shortcrustBase: string;
  pastries: string;
  drinks: string;
  madeToOrder: string;
  drinkGroups: Readonly<Record<DrinkGroup, string>>;
  allergens: string;
  add: string;
  addToOrder: string;
  soldOut: string;
  remove: string;
  quantity: string;
}>;

const MENU_COPY: Readonly<Record<PatisserieLanguage, MenuCopy>> = {
  en: {
    sections: "Shop",
    financierHeading: ["Eight flavours of", "financier"],
    financierNote: "Brown butter and almond in every one.",
    pies: "Pies",
    inside: "Inside each pie",
    pastryLid: "Puff pastry lid",
    shortcrustBase: "Shortcrust base",
    pastries: "Pastries",
    drinks: "Drinks",
    madeToOrder: "Made to order",
    drinkGroups: { coffee: "Coffee", latte: "Tea and lattes" },
    allergens: "Allergens",
    add: "Add",
    addToOrder: "Add to order",
    soldOut: "Sold out",
    remove: "Remove one",
    quantity: "in your order",
  },
  ja: {
    sections: "ショップ",
    financierHeading: ["8種の", "フィナンシェ"],
    financierNote: "すべて焦がしバターとアーモンドで焼いています。",
    pies: "Pies",
    inside: "パイの中身",
    pastryLid: "パイ生地のふた",
    shortcrustBase: "ショートクラストの土台",
    pastries: "Pastries",
    drinks: "Drinks",
    madeToOrder: "ご注文を受けてからお作りします",
    drinkGroups: { coffee: "コーヒー", latte: "ティーとラテ" },
    allergens: "アレルギー",
    add: "追加",
    addToOrder: "カートに入れる",
    soldOut: "売り切れ",
    remove: "1つ減らす",
    quantity: "点をカートに",
  },
};

export type PatisserieMenuItem = Readonly<{
  slug: PatisserieSlug;
  price: string;
  available: boolean;
  quantity: number;
}>;

/** The cart and the order status, which the section bar also holds. */
type PatisserieShopNav = Readonly<{
  cartLabel: string;
  cartCount: number;
  cartOpen: boolean;
  onOpenCart: () => void;
  orderStatus?: Readonly<{ href: string; label: string }>;
}>;

type PatisserieMenuProps = Readonly<{
  language: PatisserieLanguage;
  items: readonly PatisserieMenuItem[];
  shopNav: PatisserieShopNav;
  onIncrease: React.MouseEventHandler<HTMLButtonElement>;
  onDecrease: React.MouseEventHandler<HTMLButtonElement>;
}>;

type Entry = Readonly<{ product: PatisserieProduct; item: PatisserieMenuItem }>;

export function PatisserieMenu(props: PatisserieMenuProps): React.ReactNode {
  usePatisserieFonts();
  const copy = MENU_COPY[props.language];
  const entries: Entry[] = [];
  for (const item of props.items) {
    const product = PATISSERIE_PRODUCTS.find(
      (candidate) => candidate.slug === item.slug,
    );
    if (product !== undefined) entries.push({ product, item });
  }
  const financiers = entries.filter(
    (entry) => entry.product.art.kind === "financier",
  );
  const hotcake = entries.find((entry) => entry.product.art.kind === "hotcake");
  const pies = entries.filter((entry) => entry.product.art.kind === "pie");
  const pastries = entries.filter(
    (entry) => entry.product.art.kind === "pastry",
  );
  const drinkGroups = (["coffee", "latte"] as const)
    .map((group) => ({
      group,
      drinks: entries.filter(
        (entry) =>
          entry.product.art.kind === "drink" &&
          entry.product.art.group === group,
      ),
    }))
    .filter((group) => group.drinks.length > 0);
  const sectionLinks = useScrollEdges<HTMLDivElement>(
    [financiers, pies, pastries, drinkGroups].filter(
      (section) => section.length > 0,
    ).length,
  );
  const control = (
    entry: Entry,
    variant: "link" | "pill" | "solid",
  ): React.ReactNode => (
    <PatisserieAddControl
      entry={entry}
      variant={variant}
      language={props.language}
      onIncrease={props.onIncrease}
      onDecrease={props.onDecrease}
    />
  );
  // The footer says that each item lists its allergens, so each one does.
  const allergens = (entry: Entry): React.ReactNode => (
    <p className="patisserie-allergens">
      {`${copy.allergens}: ${entry.product.copy[props.language].allergens}`}
    </p>
  );
  return (
    <div className="patisserie-menu">
      {/* The section bar stays at the top of the screen once the masthead
          scrolls away, with the cart at its end. */}
      <nav className="patisserie-sections" aria-label={copy.sections}>
        <div className="patisserie-sections-links" ref={sectionLinks}>
          {financiers.length === 0 ? null : (
            <a href="#patisserie-financiers">Financiers</a>
          )}
          {pies.length === 0 ? null : <a href="#patisserie-pies">Pies</a>}
          {pastries.length === 0 ? null : (
            <a href="#patisserie-pastries">Pastries</a>
          )}
          {drinkGroups.length === 0 ? null : (
            <a href="#patisserie-drinks">Drinks</a>
          )}
          {props.shopNav.orderStatus === undefined ? null : (
            <a href={props.shopNav.orderStatus.href}>
              {props.shopNav.orderStatus.label}
            </a>
          )}
        </div>
        <button
          type="button"
          className="patisserie-sections-cart"
          aria-haspopup="dialog"
          aria-expanded={props.shopNav.cartOpen}
          onClick={props.shopNav.onOpenCart}
        >
          {`${props.shopNav.cartLabel} (${props.shopNav.cartCount})`}
        </button>
      </nav>

      {financiers.length === 0 ? null : (
        <section
          id="patisserie-financiers"
          className="patisserie-chart"
          aria-labelledby="patisserie-financiers-heading"
        >
          <div className="patisserie-chart-heading">
            <span lang="ja">フィナンシェ</span>
            <h2 id="patisserie-financiers-heading">
              {copy.financierHeading[0]}
              <br />
              {copy.financierHeading[1]}
            </h2>
          </div>
          <div className="patisserie-chart-grid">
            {financiers.map((entry) => (
              <article
                key={entry.product.slug}
                className="patisserie-chart-item"
                id={patisserieProductId(entry.product.slug)}
              >
                <div className="patisserie-chart-art">
                  <PatisseriePhoto
                    product={entry.product}
                    sizes="(max-width: 47rem) 50vw, 18rem"
                  />
                </div>
                <div className="patisserie-chart-copy">
                  <h3>{entry.product.chartName}</h3>
                  <span lang="ja">{entry.product.japaneseName}</span>
                  {allergens(entry)}
                  <div className="patisserie-price-row">
                    <span className="patisserie-price">{entry.item.price}</span>
                    {control(entry, "link")}
                  </div>
                </div>
              </article>
            ))}
          </div>
          <p className="patisserie-chart-note">{copy.financierNote}</p>
        </section>
      )}

      {hotcake === undefined ? null : (
        <section
          className="patisserie-hotcake"
          id={patisserieProductId(hotcake.product.slug)}
          aria-labelledby="patisserie-hotcake-heading"
        >
          <div className="patisserie-arch patisserie-hotcake-arch">
            <PatisseriePhoto
              product={hotcake.product}
              sizes="(max-width: 47rem) 100vw, 40vw"
            />
          </div>
          <div className="patisserie-hotcake-copy">
            <span lang="ja">{hotcake.product.japaneseName}</span>
            <h2 id="patisserie-hotcake-heading">
              Hotcake
              <br />
              financier
            </h2>
            <p>{hotcake.product.copy[props.language].description}</p>
            {allergens(hotcake)}
            <div className="patisserie-price-row">
              <span className="patisserie-price">{hotcake.item.price}</span>
              {control(hotcake, "solid")}
            </div>
          </div>
        </section>
      )}

      {pies.length === 0 ? null : (
        <section
          id="patisserie-pies"
          className="patisserie-pies"
          aria-labelledby="patisserie-pies-heading"
        >
          <div className="patisserie-section-heading">
            <h2 id="patisserie-pies-heading">{copy.pies}</h2>
            <span>{copy.inside}</span>
          </div>
          {pies.map((entry) => (
            <article
              key={entry.product.slug}
              className="patisserie-pie"
              id={patisserieProductId(entry.product.slug)}
            >
              <span lang="ja" className="patisserie-pie-japanese">
                {entry.product.japaneseName}
              </span>
              <div className="patisserie-pie-disc">
                <PatisseriePhoto product={entry.product} sizes="11rem" />
              </div>
              <PieCrossSection
                slug={entry.product.slug}
                inside={entry.product.inside?.[props.language] ?? ""}
                lid={copy.pastryLid}
                base={copy.shortcrustBase}
              />
              <div className="patisserie-pie-copy">
                <h3>{entry.product.copy[props.language].title}</h3>
                {allergens(entry)}
                <div className="patisserie-price-row">
                  <span className="patisserie-price">{entry.item.price}</span>
                  {control(entry, "pill")}
                </div>
              </div>
            </article>
          ))}
        </section>
      )}

      {pastries.length === 0 ? null : (
        <section
          id="patisserie-pastries"
          className="patisserie-pastries"
          aria-labelledby="patisserie-pastries-heading"
        >
          <div className="patisserie-section-heading">
            <h2 id="patisserie-pastries-heading">{copy.pastries}</h2>
          </div>
          {/* The pies' round photographs, titles and buttons, in the ruled
              grid of the financier chart. */}
          <div className="patisserie-pastry-grid">
            {pastries.map((entry) => (
              <article
                key={entry.product.slug}
                className="patisserie-pastry"
                id={patisserieProductId(entry.product.slug)}
              >
                <div className="patisserie-pie-disc">
                  <PatisseriePhoto product={entry.product} sizes="11rem" />
                </div>
                <div className="patisserie-pastry-copy">
                  <h3>{entry.product.copy[props.language].title}</h3>
                  {props.language === "ja" ? null : (
                    <span lang="ja">{entry.product.japaneseName}</span>
                  )}
                  <p>{entry.product.copy[props.language].description}</p>
                  {allergens(entry)}
                  <div className="patisserie-price-row">
                    <span className="patisserie-price">{entry.item.price}</span>
                    {control(entry, "pill")}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {drinkGroups.length === 0 ? null : (
        <section
          id="patisserie-drinks"
          className="patisserie-drinks"
          aria-labelledby="patisserie-drinks-heading"
        >
          <div className="patisserie-section-heading">
            <h2 id="patisserie-drinks-heading">{copy.drinks}</h2>
            <span>{copy.madeToOrder}</span>
          </div>
          {/* A café board: the coffees and the milk drinks side by side,
              each a ruled list of photograph, name, description and
              price. */}
          <div className="patisserie-drink-board">
            {drinkGroups.map((group) => (
              <div key={group.group} className="patisserie-drink-group">
                <h3>{copy.drinkGroups[group.group]}</h3>
                <ul>
                  {group.drinks.map((entry) => (
                    <li
                      key={entry.product.slug}
                      className="patisserie-drink"
                      id={patisserieProductId(entry.product.slug)}
                    >
                      <div className="patisserie-drink-art">
                        <PatisseriePhoto product={entry.product} sizes="6rem" />
                      </div>
                      <div className="patisserie-drink-copy">
                        <h4>{entry.product.copy[props.language].title}</h4>
                        {props.language === "ja" ? null : (
                          <span lang="ja">{entry.product.japaneseName}</span>
                        )}
                        <p>{entry.product.copy[props.language].description}</p>
                        {allergens(entry)}
                      </div>
                      <div className="patisserie-price-row">
                        <span className="patisserie-price">
                          {entry.item.price}
                        </span>
                        {control(entry, "link")}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Marks a scrolling row with `data-more-before` and `data-more-after` while
 * content lies past that edge. On a phone the section links scroll under the
 * cart button, and the stylesheet fades each marked edge, so a link that is
 * out of view still shows that it is there. `itemCount` re-measures the row
 * when a section appears or goes.
 */
function useScrollEdges<T extends HTMLElement>(
  itemCount: number,
): React.RefObject<T | null> {
  const row = React.useRef<T>(null);
  React.useEffect(() => {
    const element = row.current;
    if (element === null) return;
    const mark = (): void => {
      const end = element.scrollWidth - element.clientWidth;
      element.toggleAttribute("data-more-before", element.scrollLeft > 1);
      element.toggleAttribute("data-more-after", element.scrollLeft < end - 1);
    };
    mark();
    element.addEventListener("scroll", mark, { passive: true });
    const resize = new ResizeObserver(mark);
    resize.observe(element);
    return () => {
      element.removeEventListener("scroll", mark);
      resize.disconnect();
    };
  }, [itemCount]);
  return row;
}

function PatisserieAddControl(
  props: Readonly<{
    entry: Entry;
    variant: "link" | "pill" | "solid";
    language: PatisserieLanguage;
    onIncrease: React.MouseEventHandler<HTMLButtonElement>;
    onDecrease: React.MouseEventHandler<HTMLButtonElement>;
  }>,
): React.ReactNode {
  const copy = MENU_COPY[props.language];
  const title = props.entry.product.copy[props.language].title;
  const id = patisserieProductId(props.entry.product.slug);
  if (!props.entry.item.available) {
    return <span className="patisserie-sold-out">{copy.soldOut}</span>;
  }
  if (props.entry.item.quantity === 0) {
    return (
      <button
        type="button"
        className={`patisserie-add patisserie-add-${props.variant}`}
        data-item-key={id}
        aria-label={`${copy.add} ${title}`}
        onClick={props.onIncrease}
      >
        {props.variant === "link" ? copy.add : copy.addToOrder}
      </button>
    );
  }
  return (
    <div
      className="patisserie-stepper"
      role="group"
      aria-label={`${title} ${copy.quantity}`}
    >
      <button
        type="button"
        data-item-key={id}
        aria-label={`${copy.remove} ${title}`}
        onClick={props.onDecrease}
      >
        −
      </button>
      <output aria-live="polite">{props.entry.item.quantity}</output>
      <button
        type="button"
        data-item-key={id}
        aria-label={`${copy.add} ${title}`}
        disabled={props.entry.item.quantity >= 12}
        onClick={props.onIncrease}
      >
        +
      </button>
    </div>
  );
}

/**
 * A photograph of the pie cut through its middle, with the lid, the filling
 * and the base named beside the layers they show.
 */
function PieCrossSection(
  props: Readonly<{
    slug: PatisserieSlug;
    inside: string;
    lid: string;
    base: string;
  }>,
): React.ReactNode {
  return (
    <div className="patisserie-cross-section">
      <img
        className="patisserie-cross-section-cut"
        src={`${PHOTO_ROOT}/${props.slug}-side.webp`}
        width={480}
        height={155}
        alt=""
        loading="lazy"
        decoding="async"
      />
      <ul className="patisserie-cross-section-labels">
        <li>{props.lid}</li>
        <li>{props.inside}</li>
        <li>{props.base}</li>
      </ul>
    </div>
  );
}

/** A photograph of the item, sized for where it shows. */
function PatisseriePhoto(
  props: Readonly<{
    product: PatisserieProduct;
    sizes: string;
    eager?: boolean;
  }>,
): React.ReactNode {
  const base = `${PHOTO_ROOT}/${props.product.slug}`;
  return (
    <img
      className="patisserie-photo"
      src={`${base}.webp`}
      srcSet={`${base}-320.webp 320w, ${base}.webp 720w`}
      sizes={props.sizes}
      width={720}
      height={540}
      alt={props.product.copy.en.title}
      loading={props.eager === true ? "eager" : "lazy"}
      decoding="async"
    />
  );
}

const PHOTO_ROOT = "/products/patisserie";

/**
 * The small photograph of an item for the cart, the checkout review and the
 * receipt, which show an image beside each line.
 */
export function patisserieThumbnail(slug: PatisserieSlug): string {
  return `${PHOTO_ROOT}/${slug}-320.webp`;
}

/** Bakes are made ahead; drinks are made when the order comes in. */
export function patisserieIsMadeToOrder(slug: PatisserieSlug): boolean {
  return slug.startsWith("drink_");
}

type CartDrawerProps = Readonly<{
  open: boolean;
  label: string;
  closeLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}>;

/**
 * The cart as a drawer (in the manner of shadcn/ui's Drawer): it slides in
 * from the right on a wide screen and up from the bottom on a phone. Escape,
 * the close button or a click on the shade closes it, and focus goes back
 * to the control that opened it.
 */
export function CartDrawer(props: CartDrawerProps): React.ReactNode {
  const panel = React.useRef<HTMLDivElement>(null);
  const { open, onClose } = props;
  React.useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    panel.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [open, onClose]);
  return (
    <div
      className="patisserie-drawer"
      data-state={open ? "open" : "closed"}
      inert={!open}
    >
      <div
        className="patisserie-drawer-shade"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={panel}
        className="patisserie-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
      >
        <span className="patisserie-drawer-handle" aria-hidden="true" />
        <button
          type="button"
          className="patisserie-drawer-close"
          aria-label={props.closeLabel}
          onClick={onClose}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M2 2l10 10M12 2 2 12"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {props.children}
      </div>
    </div>
  );
}
