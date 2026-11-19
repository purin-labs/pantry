# Target Persona, Product Story & 6-Step Connection Framework

Date: 2026-11-19
Product: **Seams Pantry** ("the bakery operating system")
Deck assets: [`pdf_manifest.json`](pdf_manifest.json), [`build_pdf_deck.py`](build_pdf_deck.py), [`storyboard-slideshow.md`](storyboard-slideshow.md)

## 1. Audience Beachhead

Independent craft pâtisseries, bakeries, and cafés (`1–3 shops`, `2–8 staff`) making multi-batch fresh bakes and packaged gift lines in-house, selling across a live café counter, QR order pages, and online gift commerce.

- **Business reference:** A Tokyo-grade pâtisserie & coffee shop selling fresh morning bakes (savoury pies, four brown-butter financier flavours) and packaged gift boxes alongside specialty drinks.
- **Why this beachhead works:** Every morning combines tight physical kitchen constraints (one convection oven, one stand mixer, one undercounter warewasher, four bench induction hobs, one reach-in chiller) with high-margin fresh + gift commerce.

## 2. Target Personas

### Persona A — Mika (Owner-Maker)

- **Role:** Founder, head pastry maker, and daily operator of a 1-shop Tokyo pâtisserie & café with 3–5 staff.
- **Daily reality:** Wakes at 04:00 AM to start doughs and fillings, spends hours prepping across mismatched bowls, worries that a rushed tray drifts off-spec when she steps to the counter, and stays past 19:30 scrubbing pans and reconciling stock across counter POS and online gift orders.
- **What she wants:** Craft consistency without burnout — bake high-margin financiers, pies, and gift boxes that taste identical on Tuesday and Saturday, keep counter and online stock honest, and lock the door at 18:00.

### Persona B — Ken (Shift Lead)

- **Role:** Morning shift lead who runs the ovens, financier line, and espresso bar while Mika handles purchasing, customers, and recipes.
- **Daily reality:** Hands are covered in flour and butter; cannot tap through five spreadsheets mid-bake to check whether the hazelnut batter needs 180 g pre-browned butter, when the 200 °C pie changeover starts, or whether the black sesame concentrate lot is still inside its 48-hour hold.
- **What he wants:** One clear shift sequence, hands-free voice answers at the bench, zero flavour carry-over between batches, and predictable warewasher turnarounds so the sink stays empty.

## 3. Four Founder Bench Pain Points

The entire storyboard narrative starts at the physical workbench rather than an abstract software dashboard:

| # | Physical Bench Pain Point | Operational Root Cause | Seams Pantry Solution | Codebase Recipe / Plan Grounding |
| --- | --- | --- | --- | --- |
| 1 | **Waking up at 04:00 AM** | Making doughs, braised fillings, and drink concentrates from scratch before opening | Shift prep into a tracked afternoon mise-en-place (`13:00–16:52`) with cold holds (`48h` shortcrust & bar bases, `72h` braised fillings at ≤5 °C) | [`docs/recipes/bar-mise-en-place.md`](../../recipes/bar-mise-en-place.md), [`docs/recipes/pies.md`](../../recipes/pies.md) |
| 2 | **Preparation takes hours** | Sequential single-bowl weighing and hob bottlenecks block the whole morning shift | Direct-to-pan weighing on the Ohaus scale (`1,320 g` shortcrust, `780 g` per braising pan) and parallel Vollrath induction + Hobart HL200 + Hoshizaki timelines | [`docs/recipes/pies.md`](../../recipes/pies.md), Kitchen resource timeline (`Plan 42`) |
| 3 | **Batch-to-batch drift** | Unmeasured butter water loss, eye-balled cavity fills, and missed oven changeovers | `180 g` pre-brown butter check (`~22 g` water loss), `25 g` Matsunaga 8-cavity fill guards (`75–80%` depth), `170 °C → 200 °C` declared oven changeovers, and held-batch dispositions | [`docs/recipes/financiers.md`](../../recipes/financiers.md), `Plan 61C` |
| 4 | **Washing (`洗い物` sink mountains)** | Random flavour order forces extra bowl swaps and piles pans in the sink by noon | Fewest-bowl flavour sequencing (`Hazelnut → Coffee → Matcha → Black sesame`) paired with scheduled Winterhalter UC-L warewasher turnarounds between mixes | [`docs/recipes/financiers.md`](../../recipes/financiers.md), [`docs/recipes/pies.md`](../../recipes/pies.md) |

## 4. The 6-Step Product Connection Framework

How the physical bench story connects naturally to the Seams product stack (and maps directly to the **6-slide web pitch cut**):

1. **Step 1 — Anchor on craft (Slide 01 · Story):** Lead with the sunlit pâtisserie bench — fresh bakes, gift boxes, and coffee — not software screens.
2. **Step 2 — Kill the 04:00 AM alarm (Slide 03 · No 4 AM):** Show how tracked afternoon mise-en-place (`13:00–16:52`, `48h`/`72h` cold holds) gives bakers their mornings back.
3. **Step 3 — Lock 25 g craft consistency (Slide 05 · 25g Consistency):** Prove precision at the bench (`180 g` pre-brown butter, `25 g` Matsunaga cavity fill guards, exact milligram mass balance) with Kitchen workflows and Costs & margins (`Plan 86`).
4. **Step 4 — Clear the sink mountain (Slide 06 · Washing):** Show operational empathy that only real bakers recognize — fewest-bowl flavour order and scheduled warewasher cycles.
5. **Step 5 — Rehearse human-governed automation (Slide 09 · Gantry & Mitten):** Introduce **Seams Gantry** (ceiling cobots & smart ovens, simulation first under `Plan 24`) and **Seams Mitten** (insulated tray handling) under the exact same human approvals and receipts as **Sous Chef** and **Seams Checkout**.
6. **Step 6 — Close at 6:00 PM on time (Slide 10 · 6:00 PM Close):** Land the human payoff — counter, QR, and gift stock reconciled, kitchen spotless, tomorrow's cold holds chilled, and the owner walking home at 18:00.

## 5. Brand Portability Note (`Seams` → `Purin`)

- None of the 10 storyboard illustrations inside `images/` contain any brand wordmark or company text — only universal kitchen labels (`4:00`, `48h`, `25g`, `BUTTER`, `FLOUR`, `MENU`, `SOLD OUT`, `CLOSED`, `6:00`).
- All product and company names (`Seams`, `Seams Pantry`, `Sous Chef`, `Seams Checkout`, `Seams Gantry`, `Seams Mitten`) live exclusively in `pdf_manifest.json` and the HTML/CSS chrome of `build_pdf_deck.py`.
- Re-exporting the PDF after the post-hackathon `Purin` brand lock requires zero image redraws.
