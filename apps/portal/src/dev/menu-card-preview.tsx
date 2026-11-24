import { createRoot } from "react-dom/client";
import "@purin-labs/surface-portal/ui/styles.css";
import { CafeMenuPublicationDetails } from "@purin-labs/area-commerce/ui/features/governed-actions/cafe-menu-details";
import { commerceActionTitle } from "@purin-labs/area-commerce-contract/ui/features/governed-actions/commerce";
import { MenuPriceChangeDetails } from "@purin-labs/area-commerce/ui/features/governed-actions/menu-price-card";
import { ScaledBoard } from "@purin-labs/area-cafe/ui/features/menu-boards/board-view";
import "@purin-labs/area-cafe/ui/features/menu-boards/board-view.css";

// The owner's approval card for a menu publication, with sample facts, so a
// browser journey can see it without a step-up sign-in. The server's record
// for this card runs in tests/e2e/pi-cafe-menu-publication.test.ts.
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Menu card preview is development-only.");

createRoot(root).render(
  <main style={{ maxWidth: 640, margin: "32px auto", padding: "0 16px" }}>
    <section className="portal-band commerce-action-status">
      <div className="action-status-heading">
        <div>
          <h2>{commerceActionTitle("commerce.menu.publish")}</h2>
        </div>
        <span className="action-state action-state-proposed">
          Waiting for approval
        </span>
      </div>
      <p className="action-summary">
        Publish this menu to the shop's screens and order page.
      </p>
      <CafeMenuPublicationDetails
        details={{
          kind: "publish_cafe_menu",
          documentRevision: 7,
          expectedMenuRevision: 3,
          menu: {
            menuId: "menu_cafe_main",
            name: "Autumn menu",
            sections: [
              { sectionId: "section_main", name: "Tea", position: 0 },
              { sectionId: "section_coffee", name: "Coffee", position: 1 },
            ],
            entries: [
              { menuEntryId: "item_taro", sectionId: "section_main" },
              { menuEntryId: "item_ginger", sectionId: "section_main" },
              { menuEntryId: "item_latte", sectionId: "section_coffee" },
            ],
          },
          entryNames: [
            { menuEntryId: "item_taro", displayName: "Taro milk tea" },
            { menuEntryId: "item_ginger", displayName: "Ginger milk tea" },
            { menuEntryId: "item_latte", displayName: "Sesame latte" },
          ],
          addedEntryIds: ["item_ginger"],
          removedNames: ["Sesame cookie"],
        }}
      />
    </section>
    {/* Plan 40B phase 4: a deal's card, and the board that shows the deal
        after the approval. tests/e2e/pi-menu-board-price.test.ts runs the
        server's record and the screen's facts. */}
    <section
      className="portal-band commerce-action-status"
      data-preview="menu-price"
    >
      <div className="action-status-heading">
        <div>
          <h2>{commerceActionTitle("commerce.menu.change_price")}</h2>
        </div>
        <span className="action-state action-state-proposed">
          Waiting for approval
        </span>
      </div>
      <p className="action-summary">
        Change this item's price on every board, screen and the order page.
      </p>
      <MenuPriceChangeDetails
        details={{
          kind: "change_menu_price",
          offerId: "offer_taro_milk_tea",
          expectedOfferRevision: 3,
          menuEntryId: "item_taro",
          itemName: "Taro milk tea",
          before: {
            price: { amountMinor: 700, currency: "JPY" },
            compareAtPrice: null,
          },
          after: {
            price: { amountMinor: 600, currency: "JPY" },
            compareAtPrice: { amountMinor: 700, currency: "JPY" },
          },
        }}
      />
    </section>
    <section data-preview="menu-board-deal" style={{ marginTop: 24 }}>
      <ScaledBoard
        content={{
          title: "Drinks",
          layout: "two_columns",
          elements: [
            {
              id: "e_heading",
              kind: "heading",
              placement: { frameId: "header", order: 0 },
              eyebrow: "Café menu",
              title: "Drinks",
              detail: "Prices include tax",
            },
            {
              id: "e_section",
              kind: "section",
              placement: { frameId: "column_1", order: 0 },
              sectionId: "section_main",
              note: "",
            },
            {
              id: "e_featured",
              kind: "featured",
              placement: { frameId: "column_2", order: 0 },
              itemId: "item_taro",
              label: "Deal of the day",
              note: "",
            },
          ],
          sections: [
            {
              sectionId: "section_main",
              title: "Tea",
              itemIds: ["item_taro", "item_ginger"],
            },
          ],
          items: [
            {
              itemId: "item_taro",
              name: "Taro milk tea",
              description: "Nutty taro and Assam tea.",
            },
            { itemId: "item_ginger", name: "Ginger milk tea", description: "" },
          ],
        }}
        facts={{
          verified: true,
          facts: {
            observedAt: 0,
            orderUrl: null,
            entries: [
              {
                menuEntryId: "item_taro",
                price: { amountMinor: 600, currency: "JPY" },
                compareAtPrice: { amountMinor: 700, currency: "JPY" },
                availability: "available",
              },
              {
                menuEntryId: "item_ginger",
                price: { amountMinor: 650, currency: "JPY" },
                compareAtPrice: null,
                availability: "available",
              },
            ],
          },
        }}
      />
    </section>
  </main>,
);
