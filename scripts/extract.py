"""
Extract every legacy/*.html page into structured content/*.json.

Reads scripts/pages_inventory.json (archetype labels) and emits one JSON
file per page under content/<archetype>/<slugified-path>.json. Body is
parsed into semantic blocks (heading / paragraph / quote / image / list /
linebreak-group / link-list). Images are copied into public/images/ with
a flatter, slug-based naming and refs are rewritten.

Run from repo root:
    .venv/bin/python scripts/extract.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urlparse

from bs4 import BeautifulSoup, NavigableString, Tag

LEGACY_ROOT = Path("legacy")
INVENTORY_PATH = Path("scripts/pages_inventory.json")
CONTENT_ROOT = Path("content")
PUBLIC_IMAGES = Path("public/images")

ENCODINGS = ["utf-8", "latin1", "cp1252", "iso-8859-1"]

DECORATIVE_IMG_RE = re.compile(
    r"buttons?/|bullet|spacer|pixel|/line\.|/rule\.|hr\.gif|dot\.gif", re.I
)

# Tags whose text we never want to keep — scripts, styles, comments handled
# via decompose / strip below.
INVISIBLE_TAGS = {"script", "style", "noscript", "head"}

# Inline tags we flatten: their text is folded into the parent block.
INLINE_TAGS = {
    "font", "span", "b", "strong", "i", "em", "u",
    "small", "big", "tt", "code", "sub", "sup",
    "center",
}


# ---------- file IO -----------------------------------------------------------

def read_html(path: Path) -> tuple[str, str]:
    for enc in ENCODINGS:
        try:
            return path.read_text(encoding=enc), enc
        except UnicodeDecodeError:
            continue
    return path.read_bytes().decode("latin1", errors="replace"), "latin1-fallback"


# ---------- slug + path helpers ----------------------------------------------

def slugify(s: str) -> str:
    # Insert a separator at camelCase / PascalCase boundaries first.
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", s)
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-") or "page"


def page_slug(rel_path: str) -> str:
    """legacy-relative .html path -> route-friendly slug.
       'AlgorithmicArt/chance/boyle/index.html' -> 'algorithmic-art/chance/boyle'
       'meta.html' -> 'meta'
    """
    p = rel_path.replace("\\", "/")
    if p.endswith("/index.html"):
        p = p[: -len("/index.html")]
    elif p.endswith(".html"):
        p = p[: -len(".html")]
    parts = [slugify(seg) for seg in p.split("/") if seg]
    return "/".join(parts)


def normalize_local_link(href: str, source_rel: str) -> str | None:
    """Turn a legacy <a href> into a slug route, or None if external/junk."""
    if not href:
        return None
    href = href.split("#")[0].split("?")[0].strip()
    if not href:
        return None
    if href.startswith(("mailto:", "javascript:")):
        return None
    parsed = urlparse(href)
    if parsed.netloc:
        return None  # external, caller keeps as-is
    # Resolve relative to the source file's directory.
    base_dir = os.path.dirname(source_rel)
    target = os.path.normpath(os.path.join(base_dir, href))
    target = target.replace("\\", "/")
    # Drop leading "./" / "../" leftovers (normpath should handle but be safe).
    if target.startswith("./"):
        target = target[2:]
    # Directory link → its index.html.
    full = LEGACY_ROOT / target
    if full.is_dir() or (full.exists() and not target.endswith(".html")):
        target = (target + "/index.html").replace("//", "/")
    if not target.endswith(".html") and "." not in os.path.basename(target):
        target = target + "/index.html"
    return "/" + page_slug(target) if target.endswith(".html") else None


# ---------- image handling ---------------------------------------------------

def is_decorative(src: str) -> bool:
    return bool(DECORATIVE_IMG_RE.search(src or ""))


def copy_image(src_attr: str, source_rel: str, page_slug_str: str) -> str | None:
    """Copy a content image into public/images/<page-slug>/<filename> and
       return the public path. Returns None if the source can't be found."""
    if not src_attr or src_attr.startswith(("http://", "https://", "data:")):
        return src_attr or None  # external image — keep URL as-is
    src_attr = unquote(src_attr).split("#")[0].split("?")[0]
    base_dir = os.path.dirname(source_rel)
    src_resolved = os.path.normpath(os.path.join(base_dir, src_attr))
    src_path = LEGACY_ROOT / src_resolved
    if not src_path.exists():
        return None
    # Flatten path: keep just the filename, namespaced under the page slug.
    filename = os.path.basename(src_resolved)
    # If two files in different sub-dirs share a name, prefix with the
    # immediate parent dir.
    rel_parent = os.path.dirname(src_resolved).split("/")[-1]
    if rel_parent and rel_parent not in {os.path.basename(base_dir), ""}:
        filename = f"{slugify(rel_parent)}-{filename}"
    dest_dir = PUBLIC_IMAGES / page_slug_str
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    if not dest.exists():
        shutil.copy2(src_path, dest)
    return f"/images/{page_slug_str}/{filename}"


# ---------- block extraction --------------------------------------------------

def text_of(node: Tag | NavigableString) -> str:
    if isinstance(node, NavigableString):
        return str(node)
    # Recursively flatten, replacing <br> with newlines.
    parts: list[str] = []
    for child in node.children:
        if isinstance(child, NavigableString):
            parts.append(str(child))
        elif isinstance(child, Tag):
            if child.name == "br":
                parts.append("\n")
            else:
                parts.append(text_of(child))
    return "".join(parts)


def collect_links(tag: Tag, source_rel: str) -> list[dict]:
    out = []
    for a in tag.find_all("a"):
        href = a.get("href", "")
        text = " ".join(a.get_text(" ", strip=True).split())
        if not text and a.find("img") is None:
            continue
        parsed = urlparse(href)
        if parsed.netloc:
            out.append({"text": text, "href": href, "external": True})
        else:
            internal = normalize_local_link(href, source_rel)
            if internal:
                out.append({"text": text, "href": internal, "external": False})
    return out


def is_breadcrumb_block(tag: Tag) -> bool:
    """A page-nav breadcrumb block: short, button-heavy, no real content.

    The 90s site puts a right-aligned <div> or <p> at the very top of each
    page listing 'up to parent / Root / IAAA' as a row of blueNN.gif buttons
    + text. These should be stripped — the new site has its own nav.

    Match criteria, all required:
      - tag is <div> or <p>
      - contains >= 2 buttons/blueNN.gif images
      - contains NO content (non-decorative) images — distinguishes the nav
        block from a content wrapper that uses buttons as bullet markers
      - has no descendant <p> with substantial prose
      - total text < 250 chars
    """
    if tag.name not in {"div", "p"}:
        return False
    imgs = tag.find_all("img")
    button_imgs = [i for i in imgs if "buttons/" in (i.get("src") or "")]
    if len(button_imgs) < 2:
        return False
    # Refuse to decompose if there's any non-decorative image — those are
    # content the page is really about.
    content_imgs = [i for i in imgs if not is_decorative(i.get("src", ""))]
    if content_imgs:
        return False
    text_len = len(tag.get_text(" ", strip=True))
    if text_len > 250:
        return False
    # Don't decompose if it contains a real prose paragraph.
    for p in tag.find_all("p"):
        if len(p.get_text(strip=True)) > 100:
            return False
    return True


def normalize_text(s: str) -> str:
    # Collapse runs of whitespace but preserve intentional newlines.
    lines = [re.sub(r"[ \t ]+", " ", ln).strip() for ln in s.splitlines()]
    out = "\n".join(ln for ln in lines if ln != "" or True)  # keep blanks
    # Trim leading/trailing blank lines.
    return out.strip("\n").strip()


def extract_blocks(
    soup: BeautifulSoup, source_rel: str, slug: str
) -> tuple[list[dict], list[dict]]:
    """Return (blocks, images_index). Blocks is the ordered semantic body.
       images_index is a flat list of every content image referenced."""
    body = soup.body or soup
    images_index: list[dict] = []

    # Strip what we never want.
    for t in body(list(INVISIBLE_TAGS)):
        t.decompose()
    for t in body.find_all(string=lambda s: isinstance(s, type(soup.new_string("")))
                           and getattr(s, "next_element", None) is None):
        pass  # noop guard; comment-stripping below
    for c in body.find_all(string=lambda s: getattr(s, "__class__", None).__name__ == "Comment"):
        c.extract()
    # Decompose only top-of-page breadcrumbs. We restrict the search to the
    # first few top-level children of <body>, since breadcrumbs always appear
    # at the very top — and "button" GIFs are reused as bullet markers
    # elsewhere on the page (footer link lists, sub-section links).
    for t in list(body.find_all(recursive=False))[:3]:
        if t.parent is None:
            continue
        if is_breadcrumb_block(t):
            t.decompose()
            continue
        # Some pages wrap the breadcrumb in <div align="left"><blockquote>…
        # Look one level deeper.
        for inner in list(t.find_all(recursive=False))[:2]:
            if inner.parent is None:
                continue
            if is_breadcrumb_block(inner):
                inner.decompose()
    # Drop horizontal rules and stray hr.
    for t in body.find_all("hr"):
        t.decompose()

    # Walk the document, but flatten table/blockquote/div containers — we
    # treat them as transparent and only pick up their atomic contents.
    # We do this by descending recursively and emitting blocks for atoms.
    blocks: list[dict] = []

    def emit_text_block(kind: str, text: str, links: list[dict]) -> None:
        text = normalize_text(text)
        if not text:
            return
        blocks.append({"type": kind, "text": text, "links": links})

    def visit(node: Tag) -> None:
        for child in list(node.children):
            if isinstance(child, NavigableString):
                s = str(child).strip()
                if s:
                    # Loose text directly under a container — keep as paragraph.
                    emit_text_block("paragraph", str(child), [])
                continue
            if not isinstance(child, Tag):
                continue
            name = child.name.lower()

            if name in INVISIBLE_TAGS:
                continue
            if name == "br":
                continue  # handled within block text via text_of()
            if name in INLINE_TAGS:
                # Treat as transparent; descend.
                visit(child)
                continue
            if name in {"div", "center", "table", "tbody", "tr", "td",
                        "th", "blockquote", "form", "fieldset", "section",
                        "article", "main"}:
                visit(child)
                continue
            if re.fullmatch(r"h[1-6]", name):
                # Headings sometimes wrap images (the legacy site uses
                # <h5><img></h5> as a captioned-image idiom). Emit any
                # embedded images as figures first, then the heading text.
                for inner_img in child.find_all("img"):
                    emit_image(inner_img)
                before = len(blocks)
                emit_text_block(
                    "heading",
                    text_of(child),
                    collect_links(child, source_rel),
                )
                if len(blocks) > before:
                    blocks[-1]["level"] = int(name[1])
                continue
            if name == "p":
                # A <p> may contain images — split.
                emit_paragraph_or_figure(child)
                continue
            if name in {"ul", "ol"}:
                items = []
                for li in child.find_all("li", recursive=False):
                    items.append({
                        "text": normalize_text(text_of(li)),
                        "links": collect_links(li, source_rel),
                    })
                if items:
                    blocks.append({
                        "type": "list",
                        "ordered": name == "ol",
                        "items": items,
                    })
                continue
            if name == "img":
                emit_image(child)
                continue
            if name == "a":
                # An <a> may wrap an image (link-on-thumbnail idiom).
                inner_imgs = [
                    i for i in child.find_all("img")
                    if not is_decorative(i.get("src", ""))
                ]
                if inner_imgs:
                    href = child.get("href", "")
                    href_links = collect_links(child, source_rel)
                    for img in inner_imgs:
                        emit_image(img, links=href_links)
                    continue
                # Plain text link directly under a structural container.
                emit_text_block(
                    "paragraph", text_of(child),
                    collect_links(child, source_rel),
                )
                continue
            if name == "pre":
                emit_text_block("preformatted", text_of(child), [])
                continue
            # Unknown / uninteresting → descend if it has children.
            visit(child)

    def emit_paragraph_or_figure(p: Tag) -> None:
        """A <p> may be prose, or a captioned image, or a mix. Emit every
           non-decorative image as a figure; the paragraph text caption is
           attached to the FIRST image (matches the legacy idiom of
           <img><br><br>caption inside a <td>/<p>)."""
        imgs = p.find_all("img")
        content_imgs = [i for i in imgs if not is_decorative(i.get("src", ""))]
        if not content_imgs:
            if imgs:
                # Only decorative images present — drop the imgs, keep the prose.
                emit_text_block(
                    "paragraph", text_of(p), collect_links(p, source_rel)
                )
                return
            emit_text_block(
                "paragraph", text_of(p), collect_links(p, source_rel)
            )
            return
        prose = normalize_text(text_of(p))
        links = collect_links(p, source_rel)
        for i, img in enumerate(content_imgs):
            if i == 0:
                emit_image(img, caption=prose, links=links)
            else:
                emit_image(img)

    def emit_image(img: Tag, caption: str = "", links: list[dict] | None = None) -> None:
        src = img.get("src", "")
        if is_decorative(src):
            return
        public_src = copy_image(src, source_rel, slug)
        if not public_src:
            return
        alt = img.get("alt", "") or ""
        block = {
            "type": "figure",
            "src": public_src,
            "alt": alt.strip(),
            "caption": caption,
            "width": img.get("width"),
            "height": img.get("height"),
            "links": links or [],
        }
        blocks.append(block)
        images_index.append({
            "src": public_src, "alt": alt.strip(),
            "caption": caption, "legacy_src": src,
        })

    visit(body)

    blocks = attach_captions(blocks)
    blocks = drop_caption_only_paragraphs(blocks)
    # Mirror caption back into images_index so it's not empty.
    cap_by_src = {b["src"]: b.get("caption", "") for b in blocks if b["type"] == "figure"}
    for img in images_index:
        if not img["caption"] and img["src"] in cap_by_src:
            img["caption"] = cap_by_src[img["src"]]

    return blocks, images_index


def attach_captions(blocks: list[dict]) -> list[dict]:
    """If a figure has no caption and is followed by a short paragraph that
       looks like a caption (<= ~120 chars, no embedded markdown lists), use
       that paragraph as the caption."""
    for i, b in enumerate(blocks):
        if b["type"] != "figure" or b.get("caption"):
            continue
        nxt = blocks[i + 1] if i + 1 < len(blocks) else None
        if not nxt or nxt["type"] != "paragraph":
            continue
        text = nxt["text"]
        if len(text) > 200 or "\n\n" in text:
            continue
        b["caption"] = text
        b.setdefault("links", [])
        b["links"].extend(nxt.get("links", []))
        nxt["_consumed"] = True
    return blocks


def drop_caption_only_paragraphs(blocks: list[dict]) -> list[dict]:
    return [b for b in blocks if not b.get("_consumed")]


# ---------- per-page driver --------------------------------------------------

def extract_page(row: dict) -> dict:
    rel = row["path"]
    source_path = LEGACY_ROOT / rel
    text, encoding = read_html(source_path)
    soup = BeautifulSoup(text, "html.parser")

    title = (soup.title.get_text(strip=True) if soup.title else "") or row["heading"]
    h1 = soup.find(["h1", "h2"])
    heading = h1.get_text(" ", strip=True) if h1 else ""

    # Description meta.
    description = ""
    desc_meta = soup.find("meta", attrs={"name": re.compile(r"^description$", re.I)})
    if desc_meta:
        description = desc_meta.get("content", "").strip()

    slug = page_slug(rel)
    blocks, images_index = extract_blocks(soup, rel, slug)

    # Outgoing internal links collected once at top level (for cross-linking
    # in nav components / breadcrumbs).
    out_links = []
    for b in blocks:
        for L in b.get("links", []):
            if not L.get("external"):
                out_links.append(L["href"])

    return {
        "slug": slug,
        "legacy_path": rel,
        "section": row["section"],
        "archetype": row["archetype_guess"],
        "title": title.strip(),
        "heading": heading.strip(),
        "description": description,
        "source_encoding": encoding,
        "blocks": blocks,
        "images": images_index,
        "out_links": sorted(set(out_links)),
    }


def main() -> None:
    inv = json.loads(INVENTORY_PATH.read_text())
    pages = [p for p in inv["pages"] if p["archetype_guess"] != "exclude"]

    PUBLIC_IMAGES.mkdir(parents=True, exist_ok=True)
    CONTENT_ROOT.mkdir(parents=True, exist_ok=True)

    by_arch: Counter[str] = Counter()
    failures: list[tuple[str, str]] = []
    for row in pages:
        try:
            doc = extract_page(row)
        except Exception as e:  # noqa: BLE001
            failures.append((row["path"], repr(e)))
            continue
        out_path = CONTENT_ROOT / doc["archetype"] / (doc["slug"] + ".json")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False))
        by_arch[doc["archetype"]] += 1

    print(f"Extracted {sum(by_arch.values())} pages")
    for arch, n in by_arch.most_common():
        print(f"  {arch:20s} {n}")
    if failures:
        print(f"\nFailures: {len(failures)}")
        for path, err in failures[:10]:
            print(f"  {path}: {err}")


if __name__ == "__main__":
    main()
