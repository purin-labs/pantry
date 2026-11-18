# Bar mise en place — working recipe

Version: 1 · Updated: 2026-10-30

The bar serves every drink order within 15 minutes. Two drinks need work that
takes longer than that, so the kitchen makes it the afternoon before and holds
it in the Hoshizaki refrigerator.

Status: a production plan for the simulation. No test batch is recorded yet.

## Black sesame concentrate

Two batches of the existing black sesame concentrate
([Plan 61B](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-61B-black-sesame-milk-workflow.md)): roast, grind, cook the
slurry, blend, standardise to 760 g and cool for 25 minutes. Each batch fills
two 380 g bottles, so the morning has 1,520 g. Twelve drinks use 912 g
(76 g each); the rest serves the next morning.

Hold: 48 hours, refrigerated.

## Ginger decoction (one for each tea batch)

| Tea              | Water | Fresh ginger | Lost while simmering | Decoction |
| ---------------- | ----: | -----------: | -------------------: | --------: |
| Ginger black tea | 450 g |         15 g |                 20 g |     445 g |
| Ginger milk tea  | 400 g |         15 g |                 20 g |     395 g |

1. Weigh the water and ginger into a saucepan.
2. Bring to a simmer on the hob (about 2 minutes).
3. Simmer for 7 minutes.
4. Decant into a labelled container and chill for 30 minutes before the lid
   goes on.

Hold: 48 hours, refrigerated.

In the morning, the barista pours one decoction into the pan, reheats it to a
simmer (about 2 minutes) and brews the tea to order. This removes the 9-minute
ginger heat and simmer from each order.

## Cups for the milk tea

Warm the two cups with 300 g of hot water from the espresso machine's tap
while the decoction reheats. Drain the water before the milk tea goes in.

## The previous afternoon's run

The afternoon also makes the pie shortcrust and both pie fillings
([pies](pies.md)). One baker starts at 13:00 and finishes at about 16:52.
At the end of the next morning's shift, every lot is 22 to 26 hours old,
inside its hold.

The simulation's afternoon scenario is `compileAfternoonPrep` in
`packages/production-simulation/src/recipes/bakery/bakery-shift.ts`, and the
lots and holds are in `mise-en-place.ts`.
