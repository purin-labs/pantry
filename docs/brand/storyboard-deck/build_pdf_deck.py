#!/usr/bin/env python3
"""Build the 10-page 16:9 Seams Pantry (or Purin) storyboard PDF deck.

Uses local Hanken Grotesk woff2 fonts, the brand wordmark SVG, and Headless
Chrome --print-to-pdf. Intentionally avoids CSS box-shadow blur on .art-card
so Chromium's Skia PDF exporter never emits grey bounding rectangles in macOS
PDFKit / Apple Preview.

Usage:
  python3 docs/brand/storyboard-deck/build_pdf_deck.py
  python3 docs/brand/storyboard-deck/build_pdf_deck.py \
      docs/brand/storyboard-deck/pdf_manifest.json \
      docs/brand/storyboard-deck/seams_storyboard_deck.pdf
  python3 docs/brand/storyboard-deck/build_pdf_deck.py \
      --brand-name Purin --product-name "Purin Pantry" --host purin.io \
      --wordmark /path/to/purin-wordmark.svg \
      docs/brand/storyboard-deck/pdf_manifest.json \
      docs/brand/storyboard-deck/purin_storyboard_deck.pdf
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

CHROME_CANDIDATES = [
    Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    Path("/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
    Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
]


def find_chrome() -> str:
    for candidate in CHROME_CANDIDATES:
        if candidate.is_file():
            return str(candidate)
    for name in ("google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    raise FileNotFoundError("Google Chrome or Chromium not found for --print-to-pdf")


def data_uri(path: Path, mime: str) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def image_mime(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in (".jpg", ".jpeg"):
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".svg":
        return "image/svg+xml"
    raise ValueError(f"Unsupported image suffix: {path}")


def build_font_css(fonts_dir: Path) -> str:
    weights = [300, 400, 500, 600, 700]
    rules: list[str] = []
    for weight in weights:
        woff2 = fonts_dir / f"hanken-grotesk-latin-{weight}-normal.woff2"
        if not woff2.is_file():
            raise FileNotFoundError(f"Missing Hanken Grotesk weight {weight}: {woff2}")
        uri = data_uri(woff2, "font/woff2")
        rules.append(
            f"""@font-face {{
  font-family: "Hanken Grotesk";
  font-style: normal;
  font-weight: {weight};
  src: url("{uri}") format("woff2");
}}"""
        )
    return "\n".join(rules)


def apply_brand_overrides(manifest: dict, args: argparse.Namespace) -> dict:
    data = json.loads(json.dumps(manifest))
    brand = data["brand"]
    replacements: list[tuple[str, str]] = []

    if args.product_name and args.product_name != brand["product"]:
        replacements.append((brand["product"], args.product_name))
        brand["product"] = args.product_name
    if args.brand_name and args.brand_name != brand["company"]:
        old_co = brand["company"]
        new_co = args.brand_name
        replacements.extend(
            [
                (f"{old_co} Checkout", f"{new_co} Checkout"),
                (f"{old_co} Gantry", f"{new_co} Gantry"),
                (f"{old_co} Mitten", f"{new_co} Mitten"),
                (old_co, new_co),
            ]
        )
        brand["company"] = new_co
        brand["checkout"] = f"{new_co} Checkout"
        brand["gantry"] = f"{new_co} Gantry"
        brand["mitten"] = f"{new_co} Mitten"
    if args.host:
        brand["host"] = args.host
    if args.wordmark:
        brand["wordmark_svg"] = str(args.wordmark)
    if args.fonts_dir:
        brand["fonts_dir"] = str(args.fonts_dir)

    if replacements:
        def replace_text(val: object) -> object:
            if isinstance(val, str):
                out = val
                for src, dst in replacements:
                    out = out.replace(src, dst)
                return out
            if isinstance(val, list):
                return [replace_text(item) for item in val]
            if isinstance(val, dict):
                return {k: replace_text(v) for k, v in val.items()}
            return val

        data["pages"] = replace_text(data["pages"])
        data["deck"]["title"] = replace_text(data["deck"]["title"])

    return data


def esc(text: str) -> str:
    return html.escape(text, quote=True)


def render_page(
    page: dict,
    total_pages: int,
    brand: dict,
    wordmark_uri: str,
    base_dir: Path,
) -> str:
    img_path = (base_dir / page["image"]).resolve()
    if not img_path.is_file():
        raise FileNotFoundError(f"Missing slide illustration: {img_path}")
    img_uri = data_uri(img_path, image_mime(img_path))
    num = f"{page['number']:02d}"
    tot = f"{total_pages:02d}"
    host = esc(brand["host"])
    layer = esc(page["layer"])
    kicker = esc(page["kicker"])
    headline = esc(page["headline"])
    body = esc(page["body"])
    caption = esc(page.get("caption", ""))
    pitch_badge = (
        '<span class="pitch-pill"><span class="pitch-dot"></span>6-SLIDE WEB CUT</span>'
        if page.get("pitch_cut_6")
        else f'<span class="slide-meta">{esc(page.get("pitch_label", ""))}</span>'
    )

    layout = page.get("layout", "split")

    if layout == "cover":
        pills_html = "".join(
            f'<span class="cover-chip">{esc(pill)}</span>'
            for pill in page.get("pills", [])
        )
        return f"""<section class="slide slide--cover">
  <header class="topbar">
    <div class="topbar__left">
      <img class="wordmark" src="{wordmark_uri}" alt="{esc(brand['company'])}" />
      <span class="topbar__sep">/</span>
      <span class="topbar__layer">{layer}</span>
    </div>
    <div class="topbar__right">
      {pitch_badge}
      <span class="page-num">{num} / {tot}</span>
    </div>
  </header>

  <div class="cover-stage">
    <div class="cover-copy">
      <p class="kicker">{kicker}</p>
      <h1 class="cover-title">{headline}</h1>
      <p class="cover-body">{body}</p>
      <div class="cover-chips">{pills_html}</div>
    </div>
    <figure class="art-frame art-frame--cover">
      <div class="art-card art-card--cover">
        <img src="{img_uri}" alt="{esc(page['id'])}" />
      </div>
      <figcaption class="art-caption">{caption}</figcaption>
    </figure>
  </div>

  <footer class="footbar">
    <span>{host} · {esc(brand['product'])}</span>
    <span>{esc(brand['tagline'])}</span>
  </footer>
</section>"""

    if layout == "close":
        outcomes_html = "".join(
            f"""<div class="outcome-card">
  <div class="outcome-card__title">{esc(item['title'])}</div>
  <div class="outcome-card__detail">{esc(item['detail'])}</div>
</div>"""
            for item in page.get("outcomes", [])
        )
        return f"""<section class="slide slide--close">
  <header class="topbar">
    <div class="topbar__left">
      <img class="wordmark" src="{wordmark_uri}" alt="{esc(brand['company'])}" />
      <span class="topbar__sep">/</span>
      <span class="topbar__layer">{layer}</span>
    </div>
    <div class="topbar__right">
      {pitch_badge}
      <span class="page-num">{num} / {tot}</span>
    </div>
  </header>

  <div class="close-stage">
    <div class="close-top">
      <figure class="art-frame art-frame--close">
        <div class="art-card art-card--close">
          <img src="{img_uri}" alt="{esc(page['id'])}" />
        </div>
      </figure>
      <div class="close-copy">
        <p class="kicker">{kicker}</p>
        <h2 class="close-title">{headline}</h2>
        <p class="close-body">{body}</p>
      </div>
    </div>
    <div class="outcomes-grid">{outcomes_html}</div>
  </div>

  <footer class="footbar">
    <span>{host} · {esc(brand['tagline'])}</span>
    <span>{caption}</span>
  </footer>
</section>"""

    tone = page.get("tone", "evergreen")
    facts_html = "".join(
        f"""<div class="fact-row">
  <span class="fact-row__label">{esc(fact['label'])}</span>
  <span class="fact-row__value">{esc(fact['value'])}</span>
</div>"""
        for fact in page.get("facts", [])
    )
    return f"""<section class="slide slide--split">
  <header class="topbar">
    <div class="topbar__left">
      <img class="wordmark" src="{wordmark_uri}" alt="{esc(brand['company'])}" />
      <span class="topbar__sep">/</span>
      <span class="topbar__layer">{layer}</span>
    </div>
    <div class="topbar__right">
      {pitch_badge}
      <span class="page-num">{num} / {tot}</span>
    </div>
  </header>

  <div class="split-stage">
    <figure class="art-frame art-frame--split">
      <div class="art-card art-card--split">
        <img src="{img_uri}" alt="{esc(page['id'])}" />
      </div>
      <figcaption class="art-caption">{caption}</figcaption>
    </figure>

    <aside class="editorial-col">
      <span class="tone-badge tone-badge--{esc(tone)}">{kicker}</span>
      <h2 class="split-title">{headline}</h2>
      <p class="split-body">{body}</p>
      <div class="facts-list">{facts_html}</div>
    </aside>
  </div>

  <footer class="footbar">
    <span>{host} · {esc(brand['product'])}</span>
    <span>{esc(page.get('pitch_label', ''))}</span>
  </footer>
</section>"""


def build_html(manifest: dict, base_dir: Path) -> str:
    brand = manifest["brand"]
    deck = manifest["deck"]
    width_in = deck.get("page_width_in", 16)
    height_in = deck.get("page_height_in", 9)

    fonts_dir = (base_dir / brand["fonts_dir"]).resolve()
    wordmark_path = (base_dir / brand["wordmark_svg"]).resolve()
    if not wordmark_path.is_file():
        raise FileNotFoundError(f"Missing wordmark SVG: {wordmark_path}")

    font_css = build_font_css(fonts_dir)
    wordmark_uri = data_uri(wordmark_path, image_mime(wordmark_path))

    pages = manifest["pages"]
    slides_html = "\n".join(
        render_page(page, len(pages), brand, wordmark_uri, base_dir)
        for page in pages
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>{esc(deck['title'])}</title>
<style>
{font_css}

@page {{
  size: {width_in}in {height_in}in;
  margin: 0;
}}

* {{
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}}

html, body {{
  width: {width_in}in;
  background: #faf7f2;
  color: #12110f;
  font-family: "Hanken Grotesk", -apple-system, BlinkMacSystemFont, sans-serif;
  -webkit-font-smoothing: antialiased;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}}

.slide {{
  width: {width_in}in;
  height: {height_in}in;
  background: #faf7f2;
  padding: 0.44in 0.56in 0.36in;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  page-break-after: always;
  break-after: page;
  overflow: hidden;
  position: relative;
}}

.slide:last-child {{
  page-break-after: auto;
  break-after: auto;
}}

/* Top bar */
.topbar {{
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 0.16in;
  border-bottom: 1px solid #e6dfd5;
  flex: 0 0 auto;
}}

.topbar__left {{
  display: flex;
  align-items: center;
  gap: 12px;
}}

.wordmark {{
  height: 18px;
  width: auto;
  display: block;
}}

.topbar__sep {{
  color: #c4bbb0;
  font-size: 13px;
  font-weight: 400;
}}

.topbar__layer {{
  font-size: 12.5px;
  font-weight: 500;
  color: #5c564e;
  letter-spacing: -0.01em;
}}

.topbar__right {{
  display: flex;
  align-items: center;
  gap: 14px;
}}

.pitch-pill {{
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: #e4f0eb;
  color: #2f5c52;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}}

.pitch-dot {{
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #157f5f;
}}

.slide-meta {{
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #8f877d;
}}

.page-num {{
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: #12110f;
  font-variant-numeric: tabular-nums;
}}

/* Artwork card — strictly NO CSS box-shadow blur (avoids Skia PDFKit grey boxes) */
.art-frame {{
  margin: 0;
  display: flex;
  flex-direction: column;
}}

.art-card {{
  width: 100%;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #dfd7cc;
  background: #faf7f2;
  box-shadow: none;
}}

.art-card img {{
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}}

.art-caption {{
  margin-top: 10px;
  font-size: 11.5px;
  font-weight: 400;
  color: #777169;
  letter-spacing: -0.005em;
}}

/* Cover layout — full uncropped 16:9 artwork paired with display title */
.cover-stage {{
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: 0.92fr 1.55fr;
  gap: 0.48in;
  align-items: center;
  padding: 0.22in 0 0.14in;
  min-height: 0;
}}

.art-card--cover {{
  aspect-ratio: 16 / 9;
}}

.cover-copy {{
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}}

.kicker {{
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #537f75;
  margin-bottom: 14px;
}}

.cover-title {{
  font-size: 46px;
  font-weight: 500;
  line-height: 1.06;
  letter-spacing: -0.036em;
  color: #12110f;
  margin-bottom: 20px;
}}

.cover-body {{
  font-size: 16px;
  font-weight: 400;
  line-height: 1.6;
  color: #44403b;
  margin-bottom: 26px;
}}

.cover-chips {{
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}}

.cover-chip {{
  padding: 5px 11px;
  border-radius: 999px;
  background: #f1ece4;
  border: 1px solid #e2dad0;
  font-size: 11.5px;
  font-weight: 500;
  color: #3d3934;
}}

/* Split storyboard layout */
.split-stage {{
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: 1.58fr 1fr;
  gap: 0.44in;
  align-items: center;
  padding: 0.22in 0 0.14in;
  min-height: 0;
}}

.art-card--split {{
  aspect-ratio: 16 / 9;
}}

.editorial-col {{
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}}

.tone-badge {{
  display: inline-block;
  padding: 5px 11px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin-bottom: 16px;
}}

.tone-badge--evergreen {{
  background: #e4f0eb;
  color: #2f5c52;
}}

.tone-badge--amber {{
  background: #f6e7d4;
  color: #92460c;
}}

.split-title {{
  font-size: 32px;
  font-weight: 500;
  line-height: 1.13;
  letter-spacing: -0.032em;
  color: #12110f;
  margin-bottom: 16px;
}}

.split-body {{
  font-size: 15px;
  font-weight: 400;
  line-height: 1.6;
  color: #44403b;
  margin-bottom: 24px;
}}

.facts-list {{
  width: 100%;
  border-top: 1px solid #e2dbd1;
}}

.fact-row {{
  display: grid;
  grid-template-columns: 118px 1fr;
  gap: 14px;
  padding: 12px 0;
  border-bottom: 1px solid #e8e2d9;
  align-items: baseline;
}}

.fact-row__label {{
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #777169;
}}

.fact-row__value {{
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.42;
  color: #1e1c1a;
}}

/* Close layout */
.close-stage {{
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.3in;
  padding: 0.22in 0 0.14in;
  min-height: 0;
}}

.close-top {{
  display: grid;
  grid-template-columns: 1.45fr 1fr;
  gap: 0.44in;
  align-items: center;
}}

.art-card--close {{
  aspect-ratio: 16 / 9;
}}

.close-title {{
  font-size: 36px;
  font-weight: 500;
  line-height: 1.1;
  letter-spacing: -0.035em;
  color: #12110f;
  margin-bottom: 16px;
}}

.close-body {{
  font-size: 15.5px;
  font-weight: 400;
  line-height: 1.6;
  color: #44403b;
}}

.outcomes-grid {{
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}}

.outcome-card {{
  background: #f3eee6;
  border: 1px solid #e3dcd2;
  border-radius: 10px;
  padding: 16px 18px;
}}

.outcome-card__title {{
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: #12110f;
  margin-bottom: 4px;
}}

.outcome-card__detail {{
  font-size: 12.5px;
  font-weight: 400;
  line-height: 1.45;
  color: #5c564e;
}}

/* Footer */
.footbar {{
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 0.14in;
  border-top: 1px solid #e6dfd5;
  font-size: 11px;
  font-weight: 400;
  color: #8a8278;
  flex: 0 0 auto;
}}
</style>
</head>
<body>
{slides_html}
</body>
</html>
"""


def main() -> None:
    script_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Build 16:9 storyboard PDF deck.")
    parser.add_argument(
        "manifest",
        nargs="?",
        default=str(script_dir / "pdf_manifest.json"),
        help="Path to pdf_manifest.json",
    )
    parser.add_argument(
        "output",
        nargs="?",
        default=str(script_dir / "seams_storyboard_deck.pdf"),
        help="Output PDF path",
    )
    parser.add_argument("--brand-name", help="Override company name (e.g. Purin)")
    parser.add_argument("--product-name", help="Override product name (e.g. Purin Pantry)")
    parser.add_argument("--host", help="Override host footer (e.g. purin.io)")
    parser.add_argument("--wordmark", help="Override wordmark SVG path")
    parser.add_argument("--fonts-dir", help="Override Hanken Grotesk fonts directory")
    parser.add_argument("--keep-html", help="Optional path to save generated HTML")
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest = apply_brand_overrides(manifest, args)

    html_doc = build_html(manifest, manifest_path.parent)
    chrome = find_chrome()

    with tempfile.TemporaryDirectory(prefix="pantry_deck_") as tmp:
        html_path = Path(tmp) / "deck.html"
        html_path.write_text(html_doc, encoding="utf-8")
        if args.keep_html:
            Path(args.keep_html).write_text(html_doc, encoding="utf-8")

        cmd = [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--run-all-compositor-stages-before-draw",
            "--virtual-time-budget=10000",
            "--no-pdf-header-footer",
            f"--print-to-pdf={output_path}",
            html_path.as_uri(),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0 or not output_path.is_file():
            raise RuntimeError(
                f"Chrome print-to-pdf failed ({result.returncode}): {result.stderr}"
            )

    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"Built {output_path} ({size_mb:.2f} MB, {len(manifest['pages'])} pages)")


if __name__ == "__main__":
    main()
