# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static HTML site — "Radical Art: an analytical anthology of anti-art and meta-art" — published by the Institute of Artificial Art Amsterdam. The repository is overwhelmingly hand-authored HTML content organized into thematic sections (`concept/`, `AlgorithmicArt/`, `kinetics/`, `process/`, `destruction/`, `everything/`, `nothing/`, `something/`, `anything/`, `Life/`, `informe/`, `ego/`, `nature/`, `physics/`, `things/`), with media in `gif/` and `PDF/`. Entry point is `index.html`.

The HTML is legacy-style (HTML 4.0 Transitional, table-based layout, latin1/cp1252 encodings in places). Preserve the existing markup style when editing — do not "modernize" pages unless explicitly asked.

## Tooling

There are only two pieces of code:

- `server.py` — a tiny `http.server` wrapper that adds `Access-Control-Allow-Origin: *` so `site_graph.html` can `fetch()` `graph_data.json` locally. Runs on `localhost:8000`.
- `generate_graph_data.py` — walks every `.html` file in the tree, parses anchors with BeautifulSoup, normalizes hrefs (handles relative paths, missing extensions, directory→`index.html`), and writes `graph_data.json` (nodes = pages, links = anchors, node `degree`/`size` precomputed for the D3 viz). It tries `utf-8`, `latin1`, `cp1252`, `iso-8859-1` in order — keep that fallback list when editing; many pages are not UTF-8.
- `site_graph.html` — D3 force-directed visualization of `graph_data.json`. Must be served (not opened via `file://`) because it `fetch`es the JSON.

### Common commands

```bash
# Install deps (only beautifulsoup4 is required)
pip install -r requirements.txt

# Rebuild graph_data.json after adding/removing pages or links
python generate_graph_data.py

# Serve the site locally (graph viz needs the CORS server, not file://)
python server.py
# then open http://localhost:8000/site_graph.html  (or /index.html for the site)
```

There is no build step, no bundler, no test suite, and no linter. `graph_data.json` is checked in — regenerate it whenever HTML link structure changes.

## Things to know before editing

- **Section landing pages** are `<section>/index.html`. Cross-section navigation is via relative links — `generate_graph_data.py`'s `normalize_path` resolves them, so be consistent (`../concept/index.html`, not absolute paths).
- **Encodings vary.** Don't blindly re-save a page as UTF-8; check the existing `<meta charset>` / `Content-Type` and preserve it, or the link crawler's encoding fallback masks the change.
- **`QEndArt.html`, `QLife.html`, `meta.html`, `aesthetics.html`** are top-level long-form essays linked from `index.html` — not section indexes.
- **`_downloads.html`** is a stub; `PDF/` holds the actual downloadables.
