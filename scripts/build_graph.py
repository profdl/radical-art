#!/usr/bin/env python3
"""Build the force-directed map graph.

Spec (intentionally minimal — no inferred entities, no enrichment):
  - Nodes are legacy pages we ship on the new site (one per content/*.json).
  - Node label = the page <title> (already extracted into the JSON).
  - Edges are <a href> links between legacy pages.
  - Undirected, deduped (A↔B once regardless of direction or count).
  - Orphans (degree 0 after dedupe) are dropped.

Reuses scripts/extract.py: read_html() for encoding fallback,
normalize_local_link() for href→slug resolution. That guarantees the graph
URLs match what [...slug].astro actually serves.

Output: public/graph.json
  {
    "nodes": [{ "id": <slug>, "title": <str>, "degree": <int> }, ...],
    "links": [{ "source": <slug>, "target": <slug> }, ...]
  }
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Allow `from extract import ...`
SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from bs4 import BeautifulSoup  # type: ignore
from extract import (  # type: ignore
    LEGACY_ROOT,
    normalize_local_link,
    read_html,
)

ROOT = SCRIPTS_DIR.parent
CONTENT_DIR = ROOT / "content"
PUBLIC_DIR = ROOT / "public"
OUT_FILE = PUBLIC_DIR / "graph.json"

# Top-level categories surfaced by the legacy homepage. Mirrors topOrder in
# Sidebar.astro — must stay in sync.
TOP_ORDER = [
    "concept",
    "life",
    "everything",
    "algorithmic-art",
    "anything",
    "kinetics",
    "something",
    "process",
    "destruction",
    "nothing",
]
TOP_LABELS: dict[str, str] = {
    "concept": "Concept",
    "life": "Life",
    "everything": "Everything",
    "algorithmic-art": "Algorithm",
    "anything": "Anything",
    "kinetics": "Mechanics",
    "something": "Something",
    "process": "Process",
    "destruction": "Destruction",
    "nothing": "Nothing",
}
# Virtual reparenting (mirrors Sidebar.astro virtualParents): legacy top-level
# slugs the homepage doesn't link to are folded into their natural parent.
VIRTUAL_PARENTS: dict[str, str] = {
    "things": "everything",
    "nature": "everything",
    "physics": "nature",
    "ego": "life",
    "informe": "something",
}


def resolve_category(slug: str) -> str | None:
    """Return the top-level category slug a given page belongs to, after
    virtualParents reparenting. None for pages with no category (e.g. /index,
    /about, /meta, /qend-art) so the client can render them outside clusters."""
    if not slug or slug == "index":
        return None
    head = slug.split("/")[0]
    seen = set()
    while head in VIRTUAL_PARENTS and head not in seen:
        seen.add(head)
        head = VIRTUAL_PARENTS[head]
    return head if head in TOP_LABELS else None


def first_paragraph_blurb(blocks: list, limit: int = 220) -> str:
    """First non-trivial paragraph text from a page's blocks, truncated."""
    for b in blocks or []:
        if b.get("type") != "paragraph":
            continue
        text = (b.get("text") or "").strip()
        if len(text) < 20:
            continue
        if len(text) <= limit:
            return text
        cut = text[:limit].rsplit(" ", 1)[0]
        return cut + "…"
    return ""


def load_kept_pages() -> dict[str, dict]:
    """legacy_path -> {slug, title, blurb}. The keys are the only nodes we accept.

    blurb falls back: description (curated by the original authors via
    the page's intro line) → first paragraph → empty.
    """
    pages: dict[str, dict] = {}
    for json_path in CONTENT_DIR.rglob("*.json"):
        with json_path.open() as f:
            data = json.load(f)
        legacy_path = data.get("legacy_path")
        slug = data.get("slug")
        title = data.get("title") or data.get("heading") or slug or ""
        if not legacy_path or slug is None:
            continue
        blurb = (data.get("description") or "").strip()
        if not blurb:
            blurb = first_paragraph_blurb(data.get("blocks") or [])
        pages[legacy_path] = {
            "slug": slug,
            "title": title.strip(),
            "blurb": blurb,
        }
    return pages


def collect_outgoing_slugs(html_path: Path, source_rel: str) -> set[str]:
    """Return the set of in-site slugs (e.g. '/concept/tautology') this page
    links to. Excludes self-links, anchors, externals, and asset URLs."""
    text, _ = read_html(html_path)
    soup = BeautifulSoup(text, "html.parser")
    out: set[str] = set()
    for a in soup.find_all("a"):
        href = a.get("href")
        if not href:
            continue
        target = normalize_local_link(href, source_rel)
        if not target:
            continue
        # normalize_local_link returns either a route ("/foo/bar") or an
        # asset URL ("/assets/..." or "/images/..."). We only want routes.
        if not target.startswith("/") or target.startswith(("/assets/", "/images/")):
            continue
        out.add(target)
    return out


def main() -> None:
    pages = load_kept_pages()
    print(f"loaded {len(pages)} kept pages from content/")

    # slug -> title (lookup for endpoints), and the inverse for filtering hrefs.
    slug_to_title: dict[str, str] = {p["slug"]: p["title"] for p in pages.values()}
    valid_slugs = set(slug_to_title.keys())

    # Undirected, deduped pairs. Ordered tuple (a, b) with a < b is the canonical key.
    edges: set[tuple[str, str]] = set()

    for legacy_path, meta in pages.items():
        src_slug = meta["slug"]
        html_path = LEGACY_ROOT / legacy_path
        if not html_path.exists():
            print(f"  warn: missing legacy file {legacy_path}")
            continue
        outgoing = collect_outgoing_slugs(html_path, legacy_path)
        for target in outgoing:
            # normalize_local_link returns "/<slug>"; strip leading slash.
            tgt_slug = target.lstrip("/")
            if tgt_slug == src_slug:
                continue  # self-link
            if tgt_slug not in valid_slugs:
                continue  # link to an excluded/unknown page
            a, b = sorted((src_slug, tgt_slug))
            edges.add((a, b))

    print(f"collected {len(edges)} undirected edges")

    # Compute degrees, drop orphans.
    degree: dict[str, int] = {s: 0 for s in valid_slugs}
    for a, b in edges:
        degree[a] += 1
        degree[b] += 1

    kept = [s for s, d in degree.items() if d > 0]
    dropped = len(valid_slugs) - len(kept)
    print(f"kept {len(kept)} connected nodes, dropped {dropped} orphans")

    slug_to_blurb: dict[str, str] = {p["slug"]: p["blurb"] for p in pages.values()}
    nodes = [
        {
            "id": s,
            "title": slug_to_title[s],
            "blurb": slug_to_blurb.get(s, ""),
            "degree": degree[s],
            # category = top-level cluster slug (after virtualParents); or
            # null for the homepage and the four root-level essays. Pages
            # whose own slug *is* a category (e.g. "nothing") get themselves
            # as the category — they act as the cluster's anchor node.
            "category": resolve_category(s),
            "isCategoryRoot": s in TOP_LABELS,
        }
        for s in sorted(kept)
    ]
    links = [{"source": a, "target": b} for a, b in sorted(edges)]

    categories = [
        {"id": slug, "label": TOP_LABELS[slug]}
        for slug in TOP_ORDER
        if slug in slug_to_title  # only emit categories that survived as nodes
    ]

    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_FILE.open("w") as f:
        json.dump(
            {"nodes": nodes, "links": links, "categories": categories},
            f,
            indent=2,
        )
    print(f"wrote {OUT_FILE} ({len(categories)} categories)")


if __name__ == "__main__":
    main()
