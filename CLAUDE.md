# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repo.

## What this is

A rebuild of "Radical Art: an analytical anthology of anti-art and meta-art" — originally a hand-authored static HTML site by the Institute of Artificial Art Amsterdam — as a modern Astro + React + Tailwind site. The original site is preserved verbatim under `legacy/` as a reference and source-of-truth; a Python pipeline extracts its content into structured JSON, and Astro renders pages from that JSON using a small set of React/Astro components keyed off page archetype.

Visual direction: **Library Stack-inspired** (librarystack.org) — pure white background, black ink, no warm tones, IBM Plex Sans for chrome, IBM Plex Serif for body prose, generous whitespace, content-forward.

## Repo layout

```
.
├── legacy/                # Original site, untouched. 392 HTML files.
│   ├── *.html             # Top-level pages (index, meta, QEndArt, …)
│   ├── concept/, AlgorithmicArt/, kinetics/, …  # 15 thematic sections
│   ├── gif/               # Original images
│   ├── PDF/               # Downloadable PDFs
│   ├── server.py, generate_graph_data.py, site_graph.html
│   └── graph_data.json    # Pre-computed link graph (still useful for inventory)
├── scripts/
│   ├── inventory.py       # Survey legacy/ → pages_inventory.json (archetype-tagged)
│   ├── extract.py         # legacy/*.html → content/<archetype>/<slug>.json + public/images/
│   └── pages_inventory.json
├── content/               # Generated. One JSON file per page, by archetype.
│   ├── image-grid/ (252)  long-essay/ (10)   bio-credit/ (1)
│   ├── essay/ (50)        score/ (4)         site-home/ (1)
│   ├── link-hub/ (23)     hub-with-essay/ (4)
│   ├── quote-collection/ (19)  leaf-intro/ (15)  single-work/ (11)
├── public/images/         # Generated. 3,539 image copies, slug-organized.
├── src/
│   ├── content.config.ts  # Astro content collection schema (Zod)
│   ├── pages/
│   │   ├── index.astro    # Home page
│   │   └── [...slug].astro # Catch-all that renders every other page
│   ├── layouts/BaseLayout.astro  # Top nav + left sidebar + footer chrome
│   ├── components/        # One per archetype + shared primitives
│   │   ├── ImageGrid.astro     # 252 image-grid + 11 single-work pages
│   │   ├── Essay.astro         # 50 essay + 10 long-essay + 1 bio-credit
│   │   ├── Hub.astro           # 23 link-hub + 4 hub-with-essay + 15 leaf-intro
│   │   ├── QuoteCollection.astro  # 19 pages
│   │   ├── Score.astro         # 4 pages
│   │   ├── Figure.astro, Paragraph.astro, Sidebar.astro, Breadcrumb.astro
│   ├── lib/text.ts        # unwrap, paragraphs, sectionLabel, titleCase
│   └── styles/global.css  # Tailwind v4 + design tokens
├── astro.config.mjs       # React + Tailwind v4 plugin
├── package.json           # Astro 5, React 19, Tailwind 4
├── tsconfig.json          # ~/* alias = src/*
└── .venv/                 # Python virtualenv (gitignored)
```

## Pipeline (one-way: legacy/ → content/ → site)

1. **`scripts/inventory.py`** walks `legacy/`, computes per-page metrics
   (word count, image count, blockquote density, child-folder count, table
   nesting, etc.) and assigns each page an **archetype** label (12 total).
   Emits `scripts/pages_inventory.json`.
2. **`scripts/extract.py`** reads the inventory, parses each HTML page with
   BeautifulSoup, and writes a structured JSON document to
   `content/<archetype>/<slug>.json`. Body is decomposed into semantic blocks
   (`heading`, `paragraph`, `figure`, `list`). Images are copied to
   `public/images/<page-slug>/<filename>` and refs are rewritten.
3. **Astro** reads `content/` via a content collection (defined in
   `src/content.config.ts`) and renders each page through `[...slug].astro`,
   which switches on `archetype` to pick a component.

The legacy site is **never modified** by this pipeline. To re-run anything,
delete the generated dirs and re-extract:

```bash
rm -rf content public/images
.venv/bin/python scripts/extract.py
```

## Common commands

```bash
# Python: prepare venv (one-time)
python3 -m venv .venv
.venv/bin/pip install beautifulsoup4

# Re-survey + re-classify (after editing classifier in inventory.py)
.venv/bin/python scripts/inventory.py

# Re-extract content (after editing extract.py)
rm -rf content public/images
.venv/bin/python scripts/extract.py

# Node: install + run
npm install
npm run dev    # → http://localhost:4321
npm run build  # static build to dist/
```

## Archetypes (12) and which component renders each

| Archetype          | Pages | Component             |
|--------------------|------:|-----------------------|
| image-grid         |   252 | ImageGrid.astro       |
| essay              |    50 | Essay.astro           |
| link-hub           |    23 | Hub.astro             |
| quote-collection   |    19 | QuoteCollection.astro |
| leaf-intro         |    15 | Hub.astro             |
| single-work        |    11 | ImageGrid.astro       |
| long-essay         |    10 | Essay.astro           |
| score              |     4 | Score.astro           |
| hub-with-essay     |     4 | Hub.astro             |
| bio-credit         |     1 | Essay.astro           |
| site-home          |     1 | pages/index.astro     |
| exclude            |     2 | (skipped: `_downloads.html`, `site_graph.html`) |

Archetype assignment lives in `scripts/inventory.py` — `MANUAL_OVERRIDES` for
known pages, then heuristic `classify()` for the rest.

## Things to know before editing

### Astro JSX quirk: `<` inside `.map()` callbacks

Astro's compiler parses `<` as a JSX tag opener inside expressions. Code like
`{groups.map(g => g.level <= 2 ? <h2>… : <h3>…)}` will fail with
`CompilerError: Unable to assign attributes when using <> Fragment shorthand`.

**Fix:** pre-compute outside the JSX expression. Convert each item to a
discriminated-union shape, then map over it with simple `if`-returns:

```ts
const items = blocks.map(b => /* shape: { kind: 'h2', text } | { kind: 'h3', … } */);
```

```jsx
{items.map(it => {
  if (it.kind === 'h2') return <h2>{it.text}</h2>;
  if (it.kind === 'h3') return <h3>{it.text}</h3>;
  …
})}
```

This pattern is used in `Essay.astro`, `ImageGrid.astro`, `QuoteCollection.astro`.

### Encoding fallback (Python side)

Many legacy HTML files are not UTF-8 — they're latin1 or cp1252. The extractor
tries encodings in order: `utf-8`, `latin1`, `cp1252`, `iso-8859-1`.
Keep this fallback list when editing `read_html()`. Pages with international
text (Lyotard quotes in German, French dandyism essays) round-trip correctly
through the fallback.

### Breadcrumb detection is fragile

The legacy site's per-page top breadcrumb (right-aligned div with
`buttons/blue16.gif` images) needs to be stripped at extraction time. The
detector in `extract.py:is_breadcrumb_block()` matches:
- `<div>` or `<p>`
- ≥ 2 `buttons/blueNN.gif` images
- **NO non-decorative content images** (this is the load-bearing constraint —
  earlier versions over-matched any short button-containing div, eating
  whole-page wrappers)
- < 250 chars text, no descendant `<p>` with > 100 chars prose

Detection only runs on the first 3 children of `<body>`, since breadcrumbs are
always at the top — and button GIFs are reused as bullet markers in see-also
link lists at the bottom of pages. If you "fix" a page that's missing content,
suspect this detector first.

### Image extraction caveats

The extractor must look for images in **multiple parent contexts**, not just
`<p>`:
- `<p><img></p>` — the common case
- `<a href><img></a>` — link-on-thumbnail
- `<h5><img></h5>` — a legacy idiom for heading-attached imagery
- `<font>` containers (treated as transparent inline)
- multiple images per `<p>` (each emitted separately)

If a page is missing images, run the diagnostic in `scripts/` (or grep
`public/images/<slug>/`) and trace from `extract_blocks()` → `emit_image()`.

### Slugify

`slugify()` in `extract.py` inserts a hyphen at camelCase boundaries before
lowercasing: `AlgorithmicArt` → `algorithmic-art`, `1D` → `1-d`. Keep this
behavior — slugs are stable URLs.

### Hub component link detection

Many legacy hub pages collapsed all their child links into a single
`<heading>` block during extraction. `Hub.astro:isLinkGroup()` detects this
by checking that link-text length is ≥ 60% of total block text. If a hub is
showing weird "grids / / / / scatters …" headings instead of a proper link
list, that detector needs tuning.

## What's deliberately NOT done

- **No URL preservation.** New URLs use clean slugs (`/concept/`, not
  `/concept/index.html`). The legacy site lives at `legacy/` as reference;
  external links into the original page paths will not work post-launch.
  Decision was made early: the new site is a "reference to the content,"
  not a redirect-compatible mirror.
- **No editorial freeze.** Typos, broken legacy links, encoding glitches are
  fixed as we go. The legacy folder is the historical record if anything
  needs comparison.

## Useful sample pages for testing

```
http://localhost:4321/                                           # site-home
http://localhost:4321/algorithmic-art/chance/boyle               # image-grid (clean)
http://localhost:4321/algorithmic-art/grid/cellular/1-d          # image-grid (sectioned bibliography)
http://localhost:4321/ego/ben                                    # image-grid (was broken before image fixes)
http://localhost:4321/algorithmic-art                            # link-hub
http://localhost:4321/concept                                    # hub-with-essay
http://localhost:4321/meta                                       # long-essay (with figures)
http://localhost:4321/life/dandyism                              # long-essay (heading-heavy, intl chars)
http://localhost:4321/life                                       # quote-collection
http://localhost:4321/algorithmic-art/artificial                 # score
http://localhost:4321/about                                      # bio-credit
```

Smoke test (all 389 pages):
```bash
.venv/bin/python -c "import json,os; [print('/'+json.load(open(os.path.join(r,f)))['slug']) for r,_,fs in os.walk('content') for f in fs if f.endswith('.json') and json.load(open(os.path.join(r,f)))['archetype']!='site-home']" \
  | while read p; do printf '%s %s\n' "$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' http://localhost:4321$p)" "$p"; done \
  | grep -v '^200'
```

## Top-level long-form essays (curated)

The four root-level essays are flagged by `MANUAL_OVERRIDES` in `inventory.py`:
- `meta.html` → `/meta` — "Kant, Duchamp, Meta-Art" (Remko Scha, introductory)
- `QEndArt.html` → `/q-end-art` — "The End of Art"
- `QLife.html` → `/qlife`
- `aesthetics.html` → `/aesthetics`

Plus `about.html` → `/about` (bio-credit), and the home page at `index.html`.
