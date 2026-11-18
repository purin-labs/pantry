# Brown-butter financiers — working recipe

Version: 2 · Updated: 2026-10-30

Version 2 adds the four flavours that the shop sells (see
[Shop flavours](#shop-flavours)). The base formula and method below stay the
same; each flavour replaces the vanilla with its own mix-in.

Goal: crisp edges, a tender, fully baked centre, and moderate sweetness.

Equipment: Matsunaga shallow 8-cavity silicone-coated metal financier tray,
approximately 11 mm cavity depth.

Status: the user reported “results were good” after the suggested adjustments.
This records the latest recommended formula and method as our working baseline.
The exact oven setting, baking time, and quantities used in that successful
batch have not yet been individually confirmed.

## Ingredients

| Ingredient | Full batch |
| --- | ---: |
| Unsalted butter, weighed before browning | 180 g |
| Egg whites, weighed | 180 g |
| Ground almonds / almond flour | 100 g |
| Wheat flour | 100 g |
| Caster sugar | 195 g |
| Vanilla bean | ½ bean |

No baking powder. The original recipe used 220 g sugar; this version reduces
it by 25 g, approximately 11%.

Yield: depends on the fill level in the shallow tray; record the actual count
on the next bake. The source's yield of 16 refers to its own moulds.

## Method

1. Fully preheat the oven. The suggested settings were **180°C conventional**
   or **170°C fan/convection**. Record which setting works in your oven.
   Bake one tray at a time on the middle rack.
2. Brown the 180 g butter in a saucepan, watching carefully until it smells
   nutty and the milk solids are golden brown. Remove from the heat. Use the
   resulting browned butter without topping it back up to 180 g.
3. Mix the ground almonds, flour, sugar, and scraped vanilla seeds in a bowl.
4. Add the egg whites and whisk until combined. The whites go in unwhipped.
5. Gradually mix in the liquid browned butter until the batter is smooth and
   evenly blended, with no separate pools of butter.
6. Fill each cavity to approximately **75–80% of its depth**. Use the cavity
   fill level to portion the batter; avoid forcing the whole batch into 16
   financiers. Record the batter weight per cavity on the next bake.
7. Start checking at **12–15 minutes**, then continue baking as needed.
   This is a first-check window, not a confirmed total baking time.
   Look for well-browned edges, a set centre that springs back gently, and a
   skewer with moist crumbs rather than wet batter.
8. Cool in the tray for **2–3 minutes**, then turn out onto a wire rack.
   Wait another **10 minutes** before cutting one to judge the crumb.

Expect a modest dome. The centre should be tender and moist, with a visible
cake crumb. A paste-like or doughy centre after cooling needs investigation.

## Shop flavours

The shop at shop.seams.tokyo sells four financiers. Each is "brown butter and
almond financier" with one flavour:

| Shop name | Shop description | Price |
| --- | --- | ---: |
| Hazelnut financier | with roasted hazelnut | ¥350 |
| Coffee financier | with espresso | ¥330 |
| Matcha financier | with matcha | ¥350 |
| Black sesame financier | with toasted black sesame | ¥330 |

Each flavour is its own batter batch. The base is the formula above without
the vanilla. Weigh the mix-ins on the scale with the other dry ingredients;
they go into the bowl at the mix step. Clean the bowl and the beater before
the next flavour, so that no flavour carries into the next batch.

Quantities per full batch (fills three 8-cavity trays at 25 g per cavity):

| Ingredient | Hazelnut | Coffee | Matcha | Black sesame |
| --- | ---: | ---: | ---: | ---: |
| Unsalted butter, before browning | 180 g | 180 g | 180 g | 180 g |
| Egg whites | 180 g | 180 g | 180 g | 180 g |
| Almond flour | 60 g | 100 g | 100 g | 100 g |
| Wheat flour | 100 g | 100 g | 92 g | 100 g |
| Caster sugar | 195 g | 195 g | 195 g | 195 g |
| Roasted hazelnut flour | 40 g | | | |
| Chopped roasted hazelnut | 20 g | | | |
| Instant espresso powder | | 6 g | | |
| Matcha, sifted | | | 8 g | |
| Toasted black sesame paste | | | | 25 g |
| Toasted black sesame seeds | | | | 5 g |
| **Ingredients** | **775 g** | **761 g** | **755 g** | **785 g** |
| **Batter after browning and bowl residue** | **745 g** | **731 g** | **725 g** | **755 g** |

Flavour notes:

- Hazelnut: 40 g of the almond flour becomes roasted hazelnut flour. Fold in
  the chopped hazelnut last.
- Coffee: dissolve the espresso powder in 10 g of the egg whites first. Then
  add the rest of the whites. The 10 g is part of the 180 g.
- Matcha: sift the matcha with the flour. It replaces 8 g of the flour.
- Black sesame: whisk the paste into the whites before the dry ingredients go
  in. Add the seeds with the dry ingredients.

Browning removes about 22 g of water from 180 g butter, and about 8 g of
batter stays on the bowl and beater. Three trays use 600 g, so each batch
leaves 125–155 g of batter.

### In the production simulation

The BakeryOS morning shift makes one 8-cavity tray of each flavour. The
simulation scales each batch to the trays it fills (one third of the table
above for one tray) and keeps every mass balance exact in milligrams. Its
loads are `load-hazelnut-a`, `load-coffee-a`, `load-matcha-a` and
`load-black-sesame-a`. The compiler is
`packages/production-simulation/src/recipes/bakery/financier-flavours.ts`.
The batter stays fresh work of the morning: the baker browns the butter and
mixes each flavour in the shift, after the day-before mise en place of the bar
and the pies.

## Iteration history

### Original attempt — reported 2026-09-28

- Used the Matsunaga shallow tray.
- Followed the original 220 g sugar formula.
- Baked at 160°C for approximately 22–25 minutes; oven mode was unspecified.
- Result: insufficient rise, a centre resembling cookie dough, and slightly
  excessive sweetness.
- Source check: the video's 160°C setting is explicitly fan/convection.
  Its flexible silicone moulds are approximately 80 × 30 × 15 mm and are
  filled to the brim. Its baking time does not transfer directly to this tray.

### Version 1 — result reported 2026-10-04

- Suggested changes: 195 g sugar, higher baking temperature, 75–80% fill,
  and checking doneness from 12–15 minutes onward.
- Kept the remaining ingredient quantities unchanged and omitted baking powder.
- User feedback: **“results were good.”**
- Still to record: oven model and mode, actual temperature and total time,
  grams of batter per cavity, actual yield, and any deviations from this method.

## Next iteration

Keep this formula as the baseline. Record exact bake settings before making
another change, and change one variable at a time where practical.

For each bake, note:

- Date and ingredient changes:
- Oven mode / temperature / rack position:
- Batter rest, if any, and temperature at filling:
- Batter weight per cavity / total yield:
- Total baking time:
- Rise / edge crispness / centre texture / sweetness:
- Next adjustment:

## Source

Adapted from [Les financiers — English subtitles](https://www.youtube.com/watch?v=ygggwNzfYqU),
which credits pastry chef Benoît Castel. The uploaded video and its embedded
English subtitles were consulted during troubleshooting.
