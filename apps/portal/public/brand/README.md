# Mark assets

The product is now Purin Pantry (Plan 91,
`docs/plan-91-seams-atelier-rename.md`), but the goat mark stays until a
better Purin Pantry mark is drawn. The owner rejected a first replacement
(an arch with a stitched score line) on 17 November 2026. Its files are
`pantry-mark-*`.

The new mark is the Purin cat mark (the owner chose it on 19 November 2026).
Its SVG files and its icon pack are in `docs/brand/purin-logo`, and the Portal
components are `PurinMark` and `PurinIcon` in `src/ui`. Nothing in this folder
uses it yet: the goat files stay in use until the brand switch.

`pantry-mark.png` is the canonical 1024 px transparent source asset.

Keep the compact ram-head mark on navigation, favicons, application icons,
and formal product surfaces.

The exported PNG families preserve the same silhouette and transparent canvas:

- `pantry-mark-dark-{size}.png` uses a black mark for light surfaces.
- `pantry-mark-light-{size}.png` uses a white mark for dark surfaces.

Available sizes are 1024, 512, 256, 192, 128, 64, and 32 pixels.

Use 512 px for Slack and other application icons, 192 px for installable web
application metadata, and 32 or 64 px for browser and compact UI treatments.
Prefer the largest practical source when an external system performs its own
resizing.
