# Savoury pies — working recipe

Version: 1 · Updated: 2026-10-30

The shop at shop.purin.io sells two beef pies. Each pie is 12 cm and about
450 g: a shortcrust base, a braised filling and a lid of bought-in puff pastry.

| Shop name            | Shop description                         |  Price |
| -------------------- | ---------------------------------------- | -----: |
| Steak and pepper pie | beef, cracked black pepper and gravy     | ¥1,600 |
| Beef bourguignon pie | beef, red wine, mushroom and pearl onion | ¥1,600 |

Status: a production formula for the simulation. No test bake is recorded
yet. Record the first bake with the form at the end.

## One pie

| Part                                              |      Mass |
| ------------------------------------------------- | --------: |
| Shortcrust base, rolled 3 mm, lines a 12 cm tin   |     110 g |
| Filling, chilled                                  |     260 g |
| Puff pastry lid, bought-in sheet                  |      80 g |
| Egg wash                                          |       5 g |
| **Before baking**                                 | **455 g** |
| Bake loss (water from the filling and the pastry) |      25 g |
| **After baking**                                  | **430 g** |

## Equipment

All steps use equipment that the kitchen has:

- Ohaus Ranger 3000 scale for every ingredient.
- Hobart HL200 with the flat beater for the shortcrust. It has no dough hook.
- Hoshizaki RT-120SNJ refrigerator to rest the shortcrust and chill the
  fillings.
- Four Vollrath 59500P induction units on the braising bench, each with its
  own induction pan. The pan holds about 1 l, so one pan cooks the filling
  for three pies. The fillings do not use the drinks' pans or the financier
  hob, so the 90-minute braise does not stop the rest of the shift.
- Maruzen MBCO-5E convection oven. One tray holds three 12 cm tins (about
  1.4 l of pies). The two trays of one pie type bake together on two shelves.
- Cooling rack, packing table and the Winterhalter UC-L warewasher.

## Day-before mise en place

The shortcrust and both fillings are made the afternoon before and held in the
refrigerator: the dough for up to 48 hours, the cooked fillings for up to 72
hours at 5 °C or colder. The morning only lines, fills, lids, bakes and packs.
See [bar mise en place](bar-mise-en-place.md) for the afternoon run.

## Shortcrust (twelve bases)

| Ingredient                  |                     Mass |
| --------------------------- | -----------------------: |
| Wheat flour                 |                    740 g |
| Cold unsalted butter, diced |                    370 g |
| Salt                        |                      6 g |
| Whole egg                   |                    100 g |
| Cold water                  |                    125 g |
| **Ingredients**             |              **1,341 g** |
| Left on the bowl and beater |                     21 g |
| **Dough**                   | **1,320 g** (12 × 110 g) |

1. Weigh all ingredients into the HL200 bowl.
2. Rub the butter into the flour with the beater on speed 1 for about
   4 minutes, until the mix looks like coarse crumbs.
3. Add the egg and water. Mix until the dough just comes together.
4. Flatten, wrap and rest the dough in the refrigerator for 30 minutes.
5. Clean the bowl and beater before the next batch.

## Fillings (one pan, three pies)

One pan makes 780 g of filling (3 × 260 g). Six pies of one type need two
pans. Weigh every ingredient into the braising pan before the pan goes on the
hob.

### Steak and pepper

| Step   | Ingredient                                       |        Mass |
| ------ | ------------------------------------------------ | ----------: |
| Sear   | Beef chuck, 2 cm dice                            |       600 g |
| Sear   | Onion, diced                                     |       150 g |
| Braise | Beef stock                                       |       250 g |
| Braise | Cracked black pepper                             |         4 g |
| Reduce | Gravy thickener                                  |        20 g |
|        | **Ingredients**                                  | **1,024 g** |
|        | Water lost: sear 45 g, braise 165 g, reduce 20 g |       230 g |
|        | Left in the pan                                  |        14 g |
|        | **Filling**                                      |   **780 g** |

### Beef bourguignon

| Step   | Ingredient                                      |        Mass |
| ------ | ----------------------------------------------- | ----------: |
| Sear   | Beef chuck, 2 cm dice                           |       500 g |
| Sear   | Bacon lardons                                   |        75 g |
| Sear   | Pearl onions, peeled                            |       100 g |
| Sear   | Mushrooms, quartered                            |       125 g |
| Braise | Red wine                                        |       200 g |
| Braise | Beef stock                                      |       100 g |
|        | **Ingredients**                                 | **1,100 g** |
|        | Water lost: sear 60 g, braise 240 g, reduce 5 g |       305 g |
|        | Left in the pan                                 |        15 g |
|        | **Filling**                                     |   **780 g** |

Method for both fillings:

1. Sear the beef (and for the bourguignon the lardons, onions and mushrooms)
   on high power for about 10 minutes.
2. Add the braising liquid and the pepper. Cover and braise at a simmer for
   90 minutes, until the beef is tender.
3. Reduce for about 10 minutes. For the steak and pepper pie, whisk in the
   gravy thickener here.
4. Spread the filling in a shallow tray and chill it for 60 minutes. A hot
   filling melts the pastry.

## Assembly and bake (six pies of one type, two trays of three)

Start a tray when the rested shortcrust and the chilled filling of its pan
are both ready.

1. Line three 12 cm tins with 110 g of shortcrust each.
2. Fill each with 260 g of chilled filling.
3. Cut 80 g lids from the puff pastry sheet. Seal and crimp the edges.
4. Brush with egg wash, 5 g for each pie, and cut a steam vent.
5. Do steps 1 to 4 for the second tray.
6. Bake both trays at about 200 °C (convection) for about 35 minutes, until
   the lids are deep golden.
7. Check the colour of the lids before the trays leave the oven.
8. Cool on the rack for 30 minutes, then pack.

## In the production simulation

In the optimised morning shift the dough and fillings are opening stock from
the previous afternoon (`stage: "assembly"`), and the pie bench starts at
600 s. The afternoon scenario runs the same compiler with `stage: "prep"`.
The workflows below describe a run that does both.

The BakeryOS morning shift makes six pies of each type with the four
financier flavours and the drinks. Its compiler is
`packages/production-simulation/src/recipes/bakery/pie.ts`. The workflows are
`shortcrust` (one batch), `<pie>-filling` (two pan batches of each type) and
`<pie>-pies` (two trays of each type that bake together). The people weigh,
line, fill, lid, egg-wash, load, check and pack; the appliances mix, rest,
braise, chill, bake and wash. Each batch weighs its ingredients in one step at
the scale, and the reduce step runs on the hob without a person. The pie bench
takes a type's trays when its filling can first be cold, about 2 h 50 min after
the pan goes on. The pan and tray sizes follow the 1 l induction
pan and the 2 l oven tray of the MuJoCo appliance models. The oven changes
between the 170 °C financier programme and the 200 °C pie programme with a
declared changeover. All masses balance exactly in milligrams.

## Bake record

- Date and changes:
- Shortcrust thickness and rest time:
- Filling temperature at assembly:
- Oven mode / temperature / tray position / time:
- Mass before and after baking:
- Base (crisp or soggy) / lid colour / filling texture and seasoning:
- Next adjustment:
