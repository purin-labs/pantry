# Purin ram (concept)

The Purin ram is a concept for a second mark: a chibi baby ram that holds a
caramel custard pudding. The owner chose these three images on 24 November 2026. The cat in `../purin-logo/` is still the Purin logo.

| File                              | What it is                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `reference/ram-pudding.jpg`       | The logo pose: the ram looks over a pudding that stands on the floor. Gemini made it. The trace uses it |
| `reference/ram-croissant-hug.png` | The ram hugs a croissant. The owner supplied it                                                         |
| `reference/ram-croissant-eat.png` | The ram eats a croissant. The owner supplied it                                                         |
| `ram-paths.json`                  | The traced parts of the logo pose, in the 1024 box of the image                                         |
| `ram-hug.json`, `ram-eat.json`    | The traced parts of the two croissant poses                                                             |

The owner prefers the croissant for a pose where the ram lifts its food. A
pudding stays on the floor.

## Colours

| Colour  | Value     | Use                                      |
| ------- | --------- | ---------------------------------------- |
| Ram     | `#9C7A5E` | The fur: a light chocolate colour        |
| Horn    | `#E2D5BC` | The horns: a light bone colour           |
| Line    | `#301D17` | Every drawn line (the colour of the cat) |
| Cream   | `#FBF0DC` | The muzzle                               |
| Custard | `#F0B141` | The pudding body                         |
| Caramel | `#B54D1F` | The sauce                                |
| Bread   | `#EAAE5C` | The light side of the croissant          |
| Crust   | `#C47F3C` | The shade of the croissant               |

On 24 November 2026 the owner also tried the oat colours of the palette
`charcoal-horns-oat-fur` (fur `#D6CEC2`, horns `#8C8986`) on the traced ram,
and kept mocha.

## The parts

The ram is drawn with lines, so a part is a fill and the lines that the part
owns. Each fill reaches the middle of its drawn line. The part in front owns a
line between two parts: the head owns the line between the head and a horn,
and the chest owns the lines of the paws over the pudding.

- The head group holds the horns, the ears, the head and the face. It turns
  about the neck.
- Each ear turns about its root.
- The face holds the muzzle, the mouth and the two closed eyes.
- The front group holds the pudding, the chest and the paws. The paws hold
  the pudding, so the ram and the pudding move as one.

The two croissant poses have no neck: the head and the body are one part.
The ears, the paws, the muzzle and the croissant are the other parts. When the
ram eats, the croissant and its paws move, and the croissant goes away bite by
bite. So the parts behind them are whole: the cream of the muzzle and the chin
is one egg, with no line round it, as in the image, and the body has its
outline where the left paw hid its edge.

`ram-eat.json` also holds the bites. `cuts` holds the part of the croissant
that is gone after each of the first three bites, and `bites` holds the line
on the edge of each cut. The first bite takes the top of the middle, the
second leaves half, and the third leaves the two ends. The fourth bite takes
the rest. `pivots.bite` is the point where the bites start.

`ram-paths.json` also holds the pudding alone (`puddingHull`, with the parts
under the paws filled), the pivots and the ram in one colour (`mono`).

## Two sets of lines

Each pose has two sets of lines. The owner kept both on 24 November 2026:

- Solid: the traced lines, clean and even.
- Brushed: the same lines, painted with the bristle brush of the front page
  drawings. They have torn edges, bristle streaks and small grain holes, so
  the ram fits beside the ink drawings of the site.

`brush` in each JSON file holds the brushed set, in the same parts as the
solid set. The brush paints each line along its middle, with one fixed seed,
so the marks are the same on every run. A line that meets another line at a
junction stays wet to its ends, so the joined pieces read as one line. The
tab icon keeps the solid lines, because the brush does not show at 32 px.

## Motion

The ram uses the motion classes of the cat. Its horns are hard, so no motion
bends, stretches or squeezes a horn. The soft parts (the fur, the ears and the
pudding) give:

- The head turns as one piece about the neck: it sways, and it turns to the
  pointer.
- The chest leans to the pointer about the tips of the paws (`paws`) and
  carries the head. The head takes the lean back out, so it only moves with
  the top of the chest.
- The ears hang: when the head turns, they turn back a little, late, and
  swing past before they settle.
- The face looks a short way to the pointer. The mouth and the beard move
  with the muzzle as one piece.
- An ear flick turns the ear up about its root, because the ears hang out
  from the head.
- The eyes are closed, so a blink is a small squeeze of each line.
- The ram and the pudding do not wobble at rest. A poke makes the pudding
  wobble, and the chest rides on it; the head only bobs with the neck.
- In the stamp, the pudding lands first. The ram climbs up behind it, then it
  puts its paws on the pudding: the pudding gives a little under them, the
  ears flick and the eyes squeeze. `grab` in `ram-paths.json` holds the rim
  (`above`, `below`) and the part of the chest that is in front of the
  pudding (`region`).
- In a croissant pose, the whole ram rocks about its feet. When it hugs, its
  body gives one small squeeze, then rests. The horns move with the point
  between their roots (`horns`) and keep their shape.
- In the loader, the bites fill the bar. The ram comes up with a whole
  croissant and takes four bites. At the top of each bite, a piece of the
  croissant is gone, two crumbs fly, the eyes squeeze and the bar takes its
  step. The last bite takes the rest and fills the bar: the ram gives one
  happy squeeze and flicks its ears. Then it goes down and gets a new
  croissant.

On the concept front page, the ram eats while a tool connects, and it hugs the
croissant at the end of the page.

## Script

```bash
python3 scripts/brand/trace-purin-ram.py
```

The script traces the three poses with one pipeline and writes their JSON
files. With `--site DIR`, it also writes `ram-paths.ts`, `ram-poses.ts`,
`ram-wordmark.svg` and `ram-icon.svg` for the concept front page of the
company site (`apps/seams-site/home-cat/`). The walls between the parts and
the pivots are measured on the three traced images. A new image needs new
values.

The horns are smaller than in the images. The owner asked for horns about 10%
smaller and more compact (24 November 2026), so the script draws both horns
0.9 times their size (`HORN_SCALE`). Both get smaller about one point on the
skull, between their roots, so the horns stay joined and come closer to the
head. The lines keep their width. Where a part in front hid an edge of a horn
in the image, the smaller horn draws that edge itself. The frames keep the
size of the images, so the ram does not grow.

For the brushed lines, the script finds the middle of each line and runs
`scripts/brand/brush-purin-ram.mjs` with Node 24. That file imports the brush
of the company site (`apps/seams-site/src/components/h2/ink/brush.ts`) from a
`purin-monorepo` checkout beside this repository, so the ram and the site use
one brush. Without that checkout, the script writes the solid lines only.
