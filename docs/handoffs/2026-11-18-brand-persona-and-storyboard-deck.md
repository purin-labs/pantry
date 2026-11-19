# Handoff: brand persona, product story and storyboard deck, 18 November 2026

Date: 2026-11-18 (rebuilt in `~/Dev/purin-io/pantry` on 2026-11-19)
Repository: `/Users/pta/Dev/purin-io/pantry`
Related docs: [Plan 65 — Hairline SVGs](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-65-hairline-svgs.md), [Plan 91 — Seams Atelier Rename](../plan-91-seams-atelier-rename.md), [Voice Handover](../plan-82-voice-handover.md)

## 1. Completed Deliverables (Saved in Repository Folder)

All story guides, hand-drawn `16:9` illustrations, the reproducible PDF generator, and the compiled `16in × 9in` PDF deck now live in `docs/brand/storyboard-deck/` (not only inside an ephemeral Antigravity conversation folder):

| File | Description |
| --- | --- |
| [`docs/brand/storyboard-deck/seams_storyboard_deck.pdf`](../brand/storyboard-deck/seams_storyboard_deck.pdf) | 10-page `16:9` (`16in × 9in`, `5.70 MB`) print-ready PDF deck typeset in `Hanken Grotesk` and verified in macOS `PDFKit` |
| [`docs/brand/storyboard-deck/story-and-persona.md`](../brand/storyboard-deck/story-and-persona.md) | Target personas (`Mika` Owner-Maker, `Ken` Shift Lead) and the 6-step product connection framework anchored on the 4 physical bench pain points |
| [`docs/brand/storyboard-deck/storyboard-slideshow.md`](../brand/storyboard-deck/storyboard-slideshow.md) | Markdown 10-slide preview matching the PDF deck |
| [`docs/brand/storyboard-deck/build_pdf_deck.py`](../brand/storyboard-deck/build_pdf_deck.py) & [`pdf_manifest.json`](../brand/storyboard-deck/pdf_manifest.json) | Reproducible Headless Chrome `--print-to-pdf` generator with `--brand-name`, `--product-name`, `--host`, and `--wordmark` overrides |
| `docs/brand/storyboard-deck/images/slide-01-cover.jpg` … `slide-10-six-pm-close.jpg` | 10 widescreen (`16:9`, `5.5 MiB` total) pastel 2D indie-anime storyboard illustrations with thin pencil-ink linework and soft lavender cel shadows |
| `docs/brand/storyboard-deck/references/ref-01-*.jpg` … `ref-11-*.jpg` | 11 style reference images locking the pastel linework, character, and lavender-shadow art direction (`1.3 MiB` total) |

**Storage note (`Plan 92`):** The 10 images, 11 style references, and PDF (`12.6 MiB` total across 22 files) must go to R2 (`node scripts/repo-binaries.mjs upload docs/brand/storyboard-deck/images docs/brand/storyboard-deck/references docs/brand/storyboard-deck/seams_storyboard_deck.pdf`) rather than directly into Git. Text, JSON, and script files commit normally to Git.

### Why the 10 Illustrations Survive the `Purin` Rename Untouched

None of the 10 hand-drawn image files contain `Seams` or `Satyr` text inside the artwork — only universal kitchen labels (`4:00`, `48h`, `25g`, `BUTTER`, `FLOUR`, `SOLD OUT`, `MENU`, `CLOSED`, `6:00`). All brand names (`Seams`, `Seams Pantry`, `Sous Chef`, `Seams Checkout`, `Seams Gantry`, `Seams Mitten`) live strictly in `pdf_manifest.json` and the HTML/CSS slide chrome inside `build_pdf_deck.py`, so switching the deck to `Purin` requires zero image redraws.

---

## 2. Remaining Tasks for `/Users/pta/Dev/purin-io/pantry`

### Task 1 — Re-export `purin_storyboard_deck.pdf` after the post-hackathon `Purin` brand lock

Do not start the `Purin` rename before the owner confirms that the hackathon is over (`docs/plan-82-voice-handover.md`, "The move to purin-io"). Once the `Purin` wordmark SVG and product tier names are finalized:

```bash
python3 docs/brand/storyboard-deck/build_pdf_deck.py \
  --brand-name Purin \
  --product-name "Purin Pantry" \
  --host purin.io \
  --wordmark /path/to/purin-wordmark.svg \
  docs/brand/storyboard-deck/pdf_manifest.json \
  docs/brand/storyboard-deck/purin_storyboard_deck.pdf
```

*(Keep `.art-card` free of CSS `box-shadow` blur so Chromium's Skia PDF exporter never emits grey bounding rectangles in macOS `PDFKit`.)*

### Task 2 — Build the public story page from the 6-slide pitch cut (optional)

When ready to publish this story on the web (`apps/portal/src/features/ecommerce/page.tsx` or the standalone site repo):

1. Use the 6-slide pitch cut (`slide-01-cover`, `slide-03-no-4am`, `slide-05-25g-consistency`, `slide-06-washing`, `slide-09-gantry-and-mitten`, `slide-10-six-pm-close`).
2. Optimize the selected `.jpg` illustrations to `.webp` and store binary assets above repository thresholds in R2 via `node scripts/repo-binaries.mjs upload` (`Plan 92`).

### Task 3 — Train the new wake-phrase ONNX model before changing voice UI text (`Plan 82`)

Tracked with voice work in [`docs/plan-82-voice-handover.md`](../plan-82-voice-handover.md) (step 5) and `docs/handoffs/2026-11-18-voice.md`.

1. Wait until the hackathon ends and the final wake phrase (`"Hey Sous Chef"` or `"Hey Purin"`) is chosen.
2. Train and benchmark the replacement openWakeWord ONNX classifier using `scripts/plan-82-g04/wake.py` and the dataset in `~/.satyr-voice-test/wake/` (`phrase-bench.py` against G0.4 limits), and add the phrase to `services/shop-voice/shop_voice/speech.py`.
3. Only after false-wake and recall checks pass, switch the model file and spoken prompt strings in `apps/portal/src/features/voice/{control.tsx,session.ts,approvals.tsx}` and `services/platform/src/voice/vocabulary.ts` in one release.
