// Storefront search over the buyer catalog (Plan 76 phase 7). A shop's
// catalog is small (tens to hundreds of listings), so a scan of the catalog
// snapshot answers in well under a millisecond and keeps search off the
// merchant object; the Worker and the object run this same function. SQLite
// FTS5's default tokenizer does not split Japanese text into words, so it
// would match Japanese queries worse than this substring search.
import type {
  CommerceBuyerCatalogListingV1,
  CommerceBuyerCatalogSearchV1,
  CommerceBuyerCatalogV1,
} from "@purin-labs/commerce-client";

const CATALOG_SEARCH_DEFAULT_LIMIT = 20;
const CATALOG_SEARCH_MAXIMUM_LIMIT = 50;

/**
 * The listings that contain every term of the query, best first: a term in
 * the title counts most, then the variant, the SKU and options, then the
 * description. Available listings come before unavailable ones.
 */
export function searchCatalog(
  catalog: CommerceBuyerCatalogV1,
  query: string,
  limit: number,
): CommerceBuyerCatalogSearchV1 {
  const terms = searchText(query).split(/\s+/u).filter(Boolean);
  const scored: { listing: CommerceBuyerCatalogListingV1; score: number }[] =
    [];
  if (terms.length > 0) {
    for (const listing of catalog.listings) {
      const fields = [
        [searchText(listing.title), 8],
        [searchText(listing.variantTitle), 4],
        [
          searchText(
            [
              listing.sku,
              listing.handle ?? "",
              ...listing.options.map((option) => option.value),
            ].join(" "),
          ),
          2,
        ],
        [searchText(listing.description), 1],
      ] as const;
      let score = 0;
      for (const term of terms) {
        const weight = fields.reduce(
          (best, [text, value]) =>
            text.includes(term) ? Math.max(best, value) : best,
          0,
        );
        if (weight === 0) {
          score = 0;
          break;
        }
        score += weight;
      }
      if (score > 0) scored.push({ listing, score });
    }
  }
  scored.sort(
    (left, right) =>
      Number(right.listing.availability === "available") -
        Number(left.listing.availability === "available") ||
      right.score - left.score ||
      left.listing.title.localeCompare(right.listing.title) ||
      left.listing.variantTitle.localeCompare(right.listing.variantTitle),
  );
  const bounded = Math.max(1, Math.min(CATALOG_SEARCH_MAXIMUM_LIMIT, limit));
  return {
    schemaVersion: "underclerk.buyer-catalog-search.v1",
    query,
    listings: scored.slice(0, bounded).map((item) => item.listing),
  };
}

/** The query and limit of a search request; undefined for a bad limit. */
export function catalogSearchRequest(
  request: Request,
): Readonly<{ query: string; limit: number }> | undefined {
  const search = new URL(request.url).searchParams;
  const raw = search.get("limit");
  const limit = raw === null ? CATALOG_SEARCH_DEFAULT_LIMIT : Number(raw);
  return Number.isSafeInteger(limit) && limit > 0
    ? { query: search.get("q") ?? "", limit }
    : undefined;
}

// Full-width and half-width forms as one (NFKC), case folded, and katakana
// as hiragana, so 「センチャ」 finds 「せんちゃ」.
function searchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/gu, (kana) =>
      String.fromCharCode(kana.charCodeAt(0) - 0x60),
    );
}
