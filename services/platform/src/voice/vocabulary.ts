import { VOICE_VOCABULARY_TERM_LIMIT } from "@purin-labs/control-api";

import {
  CAFE_MENU_ID,
  CAFE_STOREFRONT_ID,
} from "../control/routes/commerce-menu-publication";
import { resolveCafeBuyer } from "../control/routes/menu-screens";
import { listDevices } from "../devices/store";
import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { createCommerceClient } from "../commerce/contract/client";

const CACHE_MS = 5 * 60_000;
/** A prompt of this length stays well inside Whisper's 224 tokens. */
const PROMPT_CHARACTER_LIMIT = 600;
const TERM_CHARACTER_LIMIT = 80;
/**
 * The names that a person says to the agent, first in the list. "Pantry" is
 * the wake phrase's name: Whisper once wrote it as "Seder" (Plan 82 Phase 4).
 * "Sous Chef" is the agent and "Pantry" the short name of Purin Pantry.
 */
const ASSISTANT_NAMES = ["Satyr", "Sous Chef", "Pantry"] as const;

const cache = new Map<
  string,
  Readonly<{ terms: readonly string[]; until: number }>
>();

type Shop = NonNullable<Awaited<ReturnType<typeof resolveCafeBuyer>>>;

/**
 * The shop vocabulary for Whisper: the names that a baker says. Each name is
 * one that every member may read, from the viewer role up: the products that
 * the shop publishes, and the recipes, stock items and confirmed devices on the
 * Recipes, Ingredients & supplies and Devices pages. The list goes only to the
 * shop's enrolled Mac and to Workers AI, and no person reads it back, so it
 * adds no information-flow label to a transcript (Plan 82).
 *
 * Each source takes a turn, so a long menu does not push out the ingredients.
 * Null when a source fails: the Mac then keeps its last whole list, which a
 * short list would replace for five minutes.
 */
export async function readVoiceVocabulary(
  env: Env,
  organisationId: OrganisationId,
): Promise<readonly string[] | null> {
  const now = Date.now();
  const cached = cache.get(organisationId);
  if (cached !== undefined && cached.until > now) return cached.terms;
  const shop = await resolveCafeBuyer(env, organisationId);
  const [catalog, stock, devices] = await Promise.all([
    shop === null ? null : readCatalogNames(shop),
    shop === null ? null : readStockNames(env, organisationId, shop),
    readDeviceNames(env, organisationId),
  ]);
  if (catalog === null || stock === null || devices === null) return null;
  const terms = vocabularyOf(ASSISTANT_NAMES, [
    catalog,
    stock.recipes,
    stock.items,
    devices,
  ]);
  cache.set(organisationId, { terms, until: now + CACHE_MS });
  return terms;
}

/** The assistant's name, then one name from each source in turn. */
function vocabularyOf(
  first: readonly string[],
  sources: readonly (readonly string[])[],
): readonly string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  let characters = 0;
  const add = (name: string) => {
    const term = name.trim();
    const key = term.toLowerCase();
    if (
      term.length === 0 ||
      term.length > TERM_CHARACTER_LIMIT ||
      seen.has(key) ||
      terms.length === VOICE_VOCABULARY_TERM_LIMIT ||
      characters + term.length + 2 > PROMPT_CHARACTER_LIMIT
    )
      return;
    seen.add(key);
    terms.push(term);
    characters += term.length + 2;
  };
  for (const name of first) add(name);
  const longest = Math.max(0, ...sources.map((source) => source.length));
  for (let at = 0; at < longest; at += 1)
    for (const source of sources) if (at < source.length) add(source[at]!);
  return terms;
}

/** The published products as a guest of the order page sees them, the menu first. */
async function readCatalogNames(shop: Shop): Promise<string[] | null> {
  try {
    const session = await shop.buyer.createSession(
      shop.merchantId,
      CAFE_STOREFRONT_ID,
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok) return null;
    const catalog = await shop.buyer.readCatalog(
      shop.merchantId,
      CAFE_STOREFRONT_ID,
      session.value.token,
    );
    if (!catalog.ok) return null;
    const menu = new Set(
      catalog.value.menus
        .find((candidate) => candidate.menuId === CAFE_MENU_ID)
        ?.entries.map((entry) => entry.variantId) ?? [],
    );
    const listings = catalog.value.listings;
    return [
      ...listings.filter((l) => menu.has(l.variantId)),
      ...listings.filter((l) => !menu.has(l.variantId)),
    ].map((listing) => listing.title);
  } catch {
    return null;
  }
}

/** Active recipes and active stock items, as the Recipes page reads them. */
async function readStockNames(
  env: Env,
  organisationId: OrganisationId,
  shop: Shop,
): Promise<Readonly<{ recipes: string[]; items: string[] }> | null> {
  const client = createCommerceClient(env, undefined, {
    kind: "organisation",
    organisationId: String(organisationId),
  });
  if (client === null) return null;
  try {
    const snapshot = await client.readStockSnapshot(shop.merchantId);
    if (!snapshot.ok) return null;
    return {
      recipes: snapshot.value.foodService.resources.recipeRevisions
        .filter((recipe) => recipe.lifecycle.state === "active")
        .map((recipe) => recipe.name),
      items: snapshot.value.commerce.resources.inventoryItems
        .filter((item) => item.lifecycle === "active")
        .map((item) => item.name),
    };
  } catch {
    return null;
  }
}

/** The devices that a person confirmed on the Devices page and did not revoke. */
async function readDeviceNames(
  env: Env,
  organisationId: OrganisationId,
): Promise<string[] | null> {
  try {
    const scope = await OrganisationExecutionScope.resolve(env, organisationId);
    if (!scope.ok) return null;
    const devices = await listDevices(scope.value.database, organisationId);
    return devices
      .filter(
        (device) =>
          device.enrollment === "active" || device.enrollment === "restricted",
      )
      .map((device) => device.name);
  } catch {
    return null;
  }
}
