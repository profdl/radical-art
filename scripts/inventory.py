"""
Survey every HTML page under legacy/ and emit pages_inventory.json.

Output is a flat list, one row per page, with metrics intended to reveal
archetypes (image-grid leaf, link-only hub, essay, quote collection, score,
single-work, etc.). No content extraction — measurement only.

Run from repo root:
    .venv/bin/python scripts/inventory.py
"""

from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from pathlib import Path

from bs4 import BeautifulSoup

LEGACY_ROOT = Path("legacy")
OUTPUT_PATH = Path("scripts/pages_inventory.json")
GRAPH_PATH = LEGACY_ROOT / "graph_data.json"

ENCODINGS = ["utf-8", "latin1", "cp1252", "iso-8859-1"]

# Pages we want to label by hand regardless of metrics — top-level long-form
# pieces and the small handful of utility pages.
MANUAL_OVERRIDES: dict[str, str] = {
    "index.html": "site-home",
    "about.html": "bio-credit",
    "meta.html": "long-essay",
    "QEndArt.html": "long-essay",
    "QLife.html": "long-essay",
    "aesthetics.html": "long-essay",
    "_downloads.html": "exclude",
    "site_graph.html": "exclude",
    # Residual triage from the first inventory pass.
    "AlgorithmicArt/grid/every/EveryIcon/eicon.html": "single-work",
    "AlgorithmicArt/links.html": "quote-collection",
    "concept/QuoteCollections.html": "quote-collection",
    "nothing/index-visual.html": "leaf-intro",
    "nothing/web.html": "leaf-intro",
    "nothing/concept/index.html": "link-hub",
    "destruction/pierce/index.html": "single-work",
    "destruction/wipe/index.html": "single-work",
}

DECORATIVE_IMG_RE = re.compile(
    r"buttons?/|bullet|spacer|pixel|line|rule|hr\.gif|dot\.gif", re.I
)


def read_html(path: Path) -> tuple[str, str]:
    for enc in ENCODINGS:
        try:
            return path.read_text(encoding=enc), enc
        except UnicodeDecodeError:
            continue
    return path.read_bytes().decode("latin1", errors="replace"), "latin1-fallback"


def max_table_depth(soup: BeautifulSoup) -> int:
    deepest = 0
    for table in soup.find_all("table"):
        depth = 1
        parent = table.parent
        while parent is not None:
            if getattr(parent, "name", None) == "table":
                depth += 1
            parent = parent.parent
        if depth > deepest:
            deepest = depth
    return deepest


def visible_text(soup: BeautifulSoup) -> str:
    for tag in soup(["script", "style"]):
        tag.decompose()
    return soup.get_text(" ", strip=True)


def load_graph_degrees() -> tuple[dict[str, int], dict[str, int]]:
    if not GRAPH_PATH.exists():
        return {}, {}
    data = json.loads(GRAPH_PATH.read_text())
    id_to_name = {n["id"]: n["name"] for n in data["nodes"]}
    in_deg: dict[str, int] = defaultdict(int)
    out_deg: dict[str, int] = defaultdict(int)
    for link in data["links"]:
        src = id_to_name.get(link["source"])
        tgt = id_to_name.get(link["target"])
        if src:
            out_deg[src] += 1
        if tgt:
            in_deg[tgt] += 1
    return dict(in_deg), dict(out_deg)


def child_folder_count(path: Path) -> int:
    """For an index.html, how many sibling sub-directories with index.html exist?
    A high count = real navigational hub; zero = leaf folder."""
    if path.name.lower() != "index.html":
        return 0
    parent = path.parent
    n = 0
    for entry in parent.iterdir():
        if entry.is_dir() and (entry / "index.html").exists():
            n += 1
    return n


def is_content_image(img) -> bool:
    src = img.get("src", "")
    if not src:
        return False
    return not DECORATIVE_IMG_RE.search(src)


def survey_page(
    path: Path, in_deg: dict[str, int], out_deg: dict[str, int]
) -> dict:
    rel = path.relative_to(LEGACY_ROOT).as_posix()
    text, encoding = read_html(path)
    soup = BeautifulSoup(text, "html.parser")

    title_tag = soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else ""

    h1 = soup.find(["h1", "h2"])
    heading = h1.get_text(" ", strip=True) if h1 else ""

    body_text = visible_text(soup)
    word_count = len(re.findall(r"\w+", body_text))

    all_imgs = soup.find_all("img")
    content_imgs = [img for img in all_imgs if is_content_image(img)]

    # How many content images sit inside table cells? (90s gallery idiom)
    imgs_in_td = 0
    for img in content_imgs:
        anc = img.parent
        while anc is not None:
            if getattr(anc, "name", None) == "td":
                imgs_in_td += 1
                break
            anc = anc.parent

    anchors = soup.find_all("a")
    out_links_in_page = sum(
        1 for a in anchors
        if a.get("href")
        and not a["href"].startswith(("#", "mailto:", "javascript:"))
        and "://" not in a["href"]
    )
    external_links = sum(
        1 for a in anchors if "://" in (a.get("href") or "")
    )

    # Anchors that wrap a thumbnail image (img-link to detail page) —
    # signature of an image-grid leaf.
    img_anchor_links = sum(
        1 for a in anchors
        if a.find("img")
        and a.get("href")
        and not a["href"].startswith(("#", "mailto:", "javascript:"))
        and "://" not in a["href"]
    )

    paragraphs = soup.find_all("p")
    blockquotes = soup.find_all("blockquote")
    headings_count = len(soup.find_all(re.compile(r"^h[1-6]$", re.I)))
    br_count = len(soup.find_all("br"))

    # Score-detection signals: lots of <br>, short average line length, few <p>.
    # Split body text by br-implied newlines isn't possible from soup directly,
    # so approximate using br_count vs. paragraph count and average line length
    # within paragraphs.
    line_lengths: list[int] = []
    for p in paragraphs:
        for line in p.get_text("\n", strip=True).split("\n"):
            line = line.strip()
            if line:
                line_lengths.append(len(line))
    avg_line_len = (sum(line_lengths) / len(line_lengths)) if line_lengths else 0

    is_index = path.name.lower() == "index.html"
    children = child_folder_count(path)

    metrics = {
        "path": rel,
        "section": rel.split("/")[0] if "/" in rel else "(root)",
        "is_index": is_index,
        "child_folders": children,
        "title": title,
        "heading": heading,
        "encoding": encoding,
        "byte_size": path.stat().st_size,
        "word_count": word_count,
        "paragraph_count": len(paragraphs),
        "blockquote_count": len(blockquotes),
        "heading_count": headings_count,
        "br_count": br_count,
        "avg_line_len": round(avg_line_len, 1),
        "image_count": len(content_imgs),
        "images_in_td": imgs_in_td,
        "image_anchor_links": img_anchor_links,
        "decorative_image_count": len(all_imgs) - len(content_imgs),
        "out_links": out_links_in_page,
        "external_links": external_links,
        "max_table_depth": max_table_depth(soup),
        "in_degree_from_graph": in_deg.get(rel, 0),
        "out_degree_from_graph": out_deg.get(rel, 0),
    }
    metrics["archetype_guess"] = classify(rel, metrics)
    return metrics


def classify(rel_path: str, m: dict) -> str:
    if rel_path in MANUAL_OVERRIDES:
        return MANUAL_OVERRIDES[rel_path]

    words = m["word_count"]
    images = m["image_count"]
    imgs_in_td = m["images_in_td"]
    img_links = m["image_anchor_links"]
    out_links = m["out_links"]
    is_index = m["is_index"]
    children = m["child_folders"]
    blockquotes = m["blockquote_count"]
    paragraphs = m["paragraph_count"]
    br = m["br_count"]
    avg_ll = m["avg_line_len"]

    # 0. Real-hub branch FIRST — index pages with child folders are hubs,
    #    full stop. This prevents them from getting labeled "score" because
    #    they happen to use table-layout (no <p>) and short link text.
    if is_index and children >= 2:
        if images >= 4 and imgs_in_td >= 4:
            # A few hubs are also media-rich (e.g. they preview each child).
            return "image-grid"  # treat presentation-wise as grid; section role still implied by URL
        if words > 400:
            return "hub-with-essay"
        return "link-hub"

    # 1. Stubs — almost no content AND no images.
    if words < 25 and images < 1 and out_links < 3:
        return "stub"

    # 2. Long-essay — lots of words, image-light. Check before quote-collection
    #    so a long essay with quoted matter doesn't get bucketed as "quotes".
    if words >= 2500 and images <= 4:
        return "long-essay"

    # 3. Quote / fragment collection — blockquote-dominant pages with little
    #    or no imagery. Tightened: require image-light AND very high bq density.
    if (
        blockquotes >= 6
        and images <= 2
        and blockquotes >= paragraphs * 0.5
        and words >= 200
    ):
        return "quote-collection"

    # 4. Image-grid — many images arranged in table cells, light text.
    #    Used for both leaf-folder index.html and named .html pages.
    if imgs_in_td >= 4 and images >= 4 and words < images * 50:
        return "image-grid"

    # 5. Score / instruction — image-free, lots of <br>, short lines, few <p>.
    #    Stricter: require image_count == 0 so we don't catch tiny leaves
    #    that use table-cell layout but display artwork.
    if (
        images == 0
        and br >= 8
        and paragraphs <= 6
        and 0 < avg_ll < 60
        and out_links < 6
    ):
        return "score"

    # 6. Remaining index pages (no children, fell through above).
    if is_index:
        if images >= 3:
            return "image-grid"  # small leaf grid
        if words >= 500:
            return "essay"
        return "leaf-intro"

    # 7. Single-work — small page with a few images.
    if 1 <= images <= 5 and words < 250:
        return "single-work"

    # 8. Essay — any prose-dominant non-image page. The component handles
    #    short and long essays the same way.
    if words >= 100:
        return "essay"

    # 9. Catch-all.
    return "content-page"


def main() -> None:
    in_deg, out_deg = load_graph_degrees()

    rows = []
    for root, _dirs, files in os.walk(LEGACY_ROOT):
        for f in files:
            if f.lower().endswith(".html"):
                rows.append(survey_page(Path(root) / f, in_deg, out_deg))

    rows.sort(key=lambda r: r["path"])

    by_archetype: dict[str, int] = defaultdict(int)
    for r in rows:
        by_archetype[r["archetype_guess"]] += 1

    summary = {
        "total_pages": len(rows),
        "by_archetype": dict(sorted(by_archetype.items(), key=lambda kv: -kv[1])),
        "by_section": dict(
            sorted(
                ((s, sum(1 for r in rows if r["section"] == s))
                 for s in {r["section"] for r in rows}),
                key=lambda kv: -kv[1],
            )
        ),
        "by_encoding": dict(
            sorted(
                ((e, sum(1 for r in rows if r["encoding"] == e))
                 for e in {r["encoding"] for r in rows}),
                key=lambda kv: -kv[1],
            )
        ),
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps({"summary": summary, "pages": rows}, indent=2)
    )
    print(f"Wrote {OUTPUT_PATH} — {len(rows)} pages")
    print(f"Summary: {json.dumps(summary, indent=2)}")


if __name__ == "__main__":
    main()
