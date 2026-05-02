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
PUBLIC_ASSETS = Path("public/assets")

ASSET_EXTS = {".pdf", ".zip", ".swf", ".mp3", ".mp4", ".mov", ".avi",
              ".wav", ".jpg", ".jpeg", ".png", ".gif", ".tif", ".tiff",
              ".doc", ".docx", ".rtf", ".txt", ".ps", ".eps"}

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
    # Malformed schemes like "http:foo.com/x" (missing //) — treat as external.
    if re.match(r"^https?:[^/]", href):
        return None
    parsed = urlparse(href)
    if parsed.netloc:
        return None  # external, caller keeps as-is
    # Resolve relative to the source file's directory.
    base_dir = os.path.dirname(source_rel)
    target = os.path.normpath(os.path.join(base_dir, href))
    target = target.replace("\\", "/")
    if target.startswith("./"):
        target = target[2:]
    full = LEGACY_ROOT / target
    ext = os.path.splitext(target)[1].lower()
    # Non-HTML asset: copy into public/assets and return its public URL.
    if ext in ASSET_EXTS and full.exists() and full.is_file():
        return _copy_asset(full, target)
    # Directory link → its index.html.
    if full.is_dir():
        target = (target + "/index.html").replace("//", "/")
    elif not target.endswith(".html") and "." not in os.path.basename(target):
        target = target + "/index.html"
    return "/" + page_slug(target) if target.endswith(".html") else None


def _copy_asset(src_path: Path, legacy_rel: str) -> str:
    """Copy a non-HTML legacy asset into public/assets/ preserving its name,
    namespaced by its top-level legacy folder so duplicates don't collide.
    Returns the public URL."""
    top = legacy_rel.split("/", 1)[0].lower()  # e.g. "pdf", "algorithmicart"
    top = slugify(top)
    filename = os.path.basename(legacy_rel)
    dest_dir = PUBLIC_ASSETS / top
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    if not dest.exists():
        shutil.copy2(src_path, dest)
    return f"/assets/{top}/{filename}"


# ---------- image handling ---------------------------------------------------

def is_decorative(src: str) -> bool:
    return bool(DECORATIVE_IMG_RE.search(src or ""))


def copy_image(src_attr: str, source_rel: str, page_slug_str: str) -> str | None:
    """Copy a content image into public/images/<page-slug>/<filename> and
       return the public path. Returns None if the source can't be found."""
    if not src_attr or src_attr.startswith(("http://", "https://", "data:")):
        # External / inline images — the legacy site has a handful of
        # absolute http://radicalart.info/... URLs that 404 today. We have no
        # local copy, so drop the figure rather than ship a broken <img>.
        return None
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


def _label_after_anchor(a: Tag) -> str:
    """Walk forward from <a> through siblings, skipping whitespace, decorative
    images, and <br>, and return the first text run encountered. Stops at the
    next <a> or at a hard break (block-level element, multiple <br>s).

    The legacy site's button-list idiom puts the link label *outside* the
    anchor: `<a><img></a>&nbsp;&nbsp;<b>LABEL</b>...`. This recovers that label.

    When the <a> is wrapped in an inline element (e.g. <font>), the label is
    often the next sibling of the *parent*, not the anchor itself, so we
    bubble up across inline-tag boundaries.
    """
    parts: list[str] = []
    # Build the iteration sequence: start with anchor's siblings, then bubble
    # up through inline ancestors and continue with their siblings.
    def iter_forward(start: Tag):
        node = start
        while node is not None:
            cur = node.next_sibling
            while cur is not None:
                yield cur
                cur = cur.next_sibling
            parent = node.parent
            if parent is None or not isinstance(parent, Tag): return
            if parent.name not in INLINE_TAGS and parent.name != "b": return
            node = parent

    # Stop as soon as we have the first meaningful text chunk and then hit
    # any whitespace/break separator — this keeps labels from absorbing the
    # next item's text in tightly-packed link lists.
    have_text = False
    for cur in iter_forward(a):
        if isinstance(cur, NavigableString):
            s = str(cur).replace("\xa0", " ")
            if s.strip():
                parts.append(s.strip())
                have_text = True
            elif have_text:
                break  # whitespace separator after our label
            continue
        if isinstance(cur, Tag):
            if cur.name == "a": break
            if cur.name == "br":
                if have_text: break
                continue
            if cur.name == "img":
                if is_decorative(cur.get("src", "")): continue
                break
            if cur.name in INLINE_TAGS or cur.name == "b":
                inner = " ".join(cur.get_text(" ", strip=True).split())
                if inner:
                    parts.append(inner)
                    have_text = True
                continue
            break
    label = " ".join(" ".join(parts).split())
    return label[:120]


def _consume_label_siblings(a: Tag, label: str) -> None:
    """Strip the text nodes/inline tags following <a> that we just used as
    its label, so they don't get re-emitted as orphan paragraphs by visit().
    Stops at the next <a> or block-level element."""
    label_norm = " ".join(label.split())
    accumulated = ""
    to_remove: list = []
    cur = a.next_sibling
    while cur is not None:
        if isinstance(cur, NavigableString):
            piece = " ".join(str(cur).replace("\xa0", " ").split())
            if piece:
                accumulated = (accumulated + " " + piece).strip()
            to_remove.append(cur)
        elif isinstance(cur, Tag):
            if cur.name == "a": break
            if cur.name == "br":
                to_remove.append(cur)
                cur = cur.next_sibling
                continue
            if cur.name == "img":
                if is_decorative(cur.get("src", "")):
                    to_remove.append(cur)
                    cur = cur.next_sibling
                    continue
                break
            if cur.name in INLINE_TAGS or cur.name == "b":
                inner = " ".join(cur.get_text(" ", strip=True).split())
                if inner:
                    accumulated = (accumulated + " " + inner).strip()
                to_remove.append(cur)
            else:
                break
        # Stop once we have the label fully covered.
        if accumulated and label_norm and label_norm in accumulated:
            break
        cur = cur.next_sibling
    for n in to_remove:
        try:
            if isinstance(n, Tag): n.decompose()
            else: n.extract()
        except Exception: pass


def collect_links(tag: Tag, source_rel: str) -> list[dict]:
    out = []
    # find_all("a") only returns descendants — include `tag` itself if it's
    # an anchor (happens when extract_blocks calls us with an <a> child).
    anchors = list(tag.find_all("a"))
    if tag.name == "a":
        anchors.insert(0, tag)
    for a in anchors:
        href = a.get("href", "")
        text = " ".join(a.get_text(" ", strip=True).split())
        if not text:
            # Anchor has no inner text. Try to recover a label from the
            # adjacent text run (legacy "<a><img></a>&nbsp;LABEL" idiom).
            text = _label_after_anchor(a)
        if not text and a.find("img") is None:
            continue
        # Treat malformed schemes ("http:foo.com/x") as external; repair the //.
        if re.match(r"^https?:[^/]", href):
            fixed = re.sub(r"^(https?:)", r"\1//", href, count=1)
            out.append({"text": text, "href": fixed, "external": True})
            continue
        parsed = urlparse(href)
        if parsed.netloc:
            out.append({"text": text, "href": href, "external": True})
        else:
            internal = normalize_local_link(href, source_rel)
            if internal:
                # Asset hrefs (under /assets/ or /images/) are external-like
                # in that they're not page routes — keep external=False so
                # they render as normal in-document links.
                out.append({"text": text, "href": internal, "external": False})
    return _dedupe_links(out)


def _dedupe_links(links: list[dict]) -> list[dict]:
    """Collapse anchors that point at the same href within a single block.
    Legacy pages frequently have <a href="x"><br></a><a href="x">label</a> or
    a button-anchor + label-anchor pair, both surfaced as separate entries.
    Keep the first occurrence with non-empty text; if multiple distinct
    labels point to the same href, keep the longest/most descriptive one."""
    seen: dict[str, int] = {}
    out: list[dict] = []
    for L in links:
        href = L.get("href")
        text = (L.get("text") or "").strip()
        if not href:
            out.append(L)
            continue
        if href not in seen:
            seen[href] = len(out)
            out.append(L)
            continue
        existing = out[seen[href]]
        existing_text = (existing.get("text") or "").strip()
        # Replace if the new label is meaningfully better:
        # - existing is empty, or
        # - existing is a substring of the new label (more descriptive)
        if not existing_text:
            existing["text"] = text
        elif text and text != existing_text and existing_text.lower() in text.lower():
            existing["text"] = text
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
    content_imgs = [i for i in imgs if not is_decorative(i.get("src", ""))]
    if content_imgs:
        return False
    text_len = len(tag.get_text(" ", strip=True))
    if text_len > 250:
        return False
    for p in tag.find_all("p"):
        if len(p.get_text(strip=True)) > 100:
            return False
    # A breadcrumb's anchors go UP the tree (../, ../../). A content link
    # list of buttons points DOWN (foo.html, foo/index.html). If the anchors
    # are mostly downward, this isn't a breadcrumb.
    anchors = tag.find_all("a")
    hrefs = [a.get("href", "") for a in anchors if a.get("href")]
    if hrefs:
        upward = sum(1 for h in hrefs if h.startswith("../") or h == "../"
                     or h.endswith("/index.html") and h.startswith(".."))
        if upward / len(hrefs) < 0.5:
            return False
    # Right-aligned is the breadcrumb's other strong signal; if explicitly
    # left- or center-aligned, refuse.
    align = (tag.get("align") or "").lower()
    if align in {"left", "center"}:
        return False
    return True


def _hoist_button_cell_links(root: Tag) -> None:
    """Find rows like <tr><td>[<a><img blue/></a>]</td><td>prose</td></tr>
    and rewrite them so the prose `<td>` becomes a link to the same href.
    Run before extraction so the rest of the pipeline sees a normal anchor."""
    for tr in root.find_all("tr"):
        tds = [td for td in tr.find_all("td", recursive=False)]
        if len(tds) < 2: continue
        for i, btn_td in enumerate(tds[:-1]):
            anchors = btn_td.find_all("a")
            if len(anchors) != 1: continue
            a = anchors[0]
            href = a.get("href", "")
            if not href: continue
            # Anchor must be image-only (no inner text)
            if a.get_text(strip=True): continue
            imgs = a.find_all("img")
            if not imgs or any(not is_decorative(i.get("src","")) for i in imgs):
                continue
            # Whole button cell must be small (just the anchor + whitespace)
            cell_text = btn_td.get_text(strip=True)
            if cell_text: continue
            desc_td = tds[i + 1]
            # Skip if desc cell already has its own anchors
            if desc_td.find("a"): continue
            desc_text = desc_td.get_text(strip=True)
            if not desc_text or len(desc_text) > 400: continue
            # Wrap the desc cell's contents in an <a>.
            new_a = root.find_parent("html")
            new_a = (root.find("html") or root).new_tag("a", href=href) if False else None
            # Simpler: use the soup the tag belongs to.
            from bs4 import BeautifulSoup as _BS
            soup_obj = next((p for p in [desc_td] if hasattr(p, 'new_tag')), None)
            # Tag has no new_tag, but its parents do; walk to soup root.
            doc = desc_td
            while doc.parent is not None: doc = doc.parent
            wrap = doc.new_tag("a", href=href)
            children = list(desc_td.children)
            for c in children: wrap.append(c.extract())
            desc_td.append(wrap)


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

    # Pre-process the legacy "button-cell + description-cell" table idiom:
    # <tr><td><a><img blue/></a></td><td>description prose</td></tr>
    # Hoist the link from the button cell into the description cell so the
    # downstream extractor associates the prose with the href.
    _hoist_button_cell_links(body)

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
                    href_links = collect_links(child, source_rel)
                    for img in inner_imgs:
                        emit_image(img, links=href_links)
                    continue
                # Bare/decorative-only <a>: recover label from text inside
                # OR from the adjacent text run (legacy button-list idiom:
                # `<a><img blue16.gif></a>&nbsp;LABEL`).
                inner_text = text_of(child).strip()
                label = inner_text or _label_after_anchor(child)
                links = collect_links(child, source_rel)
                # Force the link's text to the label we resolved, so later
                # zero-text checks don't drop it.
                if links and label and not links[0].get("text"):
                    links[0]["text"] = label
                emit_text_block("paragraph", label, links)
                # Mark the label-carrying siblings as consumed so they don't
                # get re-emitted as orphan paragraphs.
                if not inner_text and label:
                    _consume_label_siblings(child, label)
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
    blocks = strip_legacy_home_breadcrumbs(blocks)
    blocks = promote_section_labels(blocks)
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


# A handful of legacy pages encode their "back to home" breadcrumb as a
# bottom-of-page text run rather than a top-of-body <div>, so the breadcrumb
# detector misses them. They surface as paragraphs like "back to: things
# radical art (home page)" or as a "Home Page: Radical Art" prefix glued to
# the start of an otherwise legit content paragraph. This pass scrubs them.
_HOME_PHRASE_RE = re.compile(
    r"""
    (?:^|[\s ]|[\[\(])      # boundary
    (?:                          # one of the legacy phrasings
        home\s*page[:\s]*radical\s*art
      | radical\s*art\s*[\[\(]?\s*home\s*page\s*[\]\)]?
      | art\s*[\[\(]?\s*home\s*page\s*[\]\)]?
      | \[\s*home\s*page\s*\]
      | \(\s*home\s*page\s*\)
    )
    [\s \.,;]*              # trailing punctuation/whitespace
    """,
    re.IGNORECASE | re.VERBOSE,
)
_BACKLINK_LEAD_RE = re.compile(r"^\s*(?:back\s*to|related)\s*[:\-]\s*", re.IGNORECASE)


def _is_home_link(link: dict) -> bool:
    txt = (link.get("text") or "").strip()
    if not txt:
        return False
    return bool(_HOME_PHRASE_RE.search(txt))


def strip_legacy_home_breadcrumbs(blocks: list[dict]) -> list[dict]:
    """Remove leftover 'Home Page: Radical Art' breadcrumb cruft from
    extracted blocks. Drops back-link footer paragraphs entirely and trims
    leading home-link prefixes from mixed paragraphs."""
    out: list[dict] = []
    for b in blocks:
        if b.get("type") not in {"paragraph", "heading"}:
            out.append(b)
            continue
        text = b.get("text") or ""
        # Drop "back to: X / radical art (home page)" footer paragraphs.
        if _BACKLINK_LEAD_RE.match(text) and _HOME_PHRASE_RE.search(text):
            continue
        # Drop a paragraph that is *only* a home-page link/phrase.
        stripped_test = _HOME_PHRASE_RE.sub("", text).strip(" \t\n /|·•")
        if not stripped_test and (b.get("links") or text):
            continue
        # Drop a stand-alone "radical art" paragraph that links to / or /index.
        # These are top-of-page back-link breadcrumbs that escaped the
        # structural detector (often only ONE button image, while
        # is_breadcrumb_block requires two as a false-positive guard).
        norm = re.sub(r"\s+", " ", text).strip().lower().rstrip(".")
        if norm == "radical art":
            links = b.get("links", [])
            if len(links) == 1:
                tgt = (links[0].get("href") or "").strip("/").lower()
                if tgt in {"", "index"}:
                    continue
        # Strip a leading home-page phrase from longer content paragraphs.
        m = _HOME_PHRASE_RE.match(text)
        if m:
            text = text[m.end():].lstrip(" \t\n ")
            b = dict(b)
            b["text"] = text
        # Drop link entries that point at the home phrase.
        if b.get("links"):
            kept = [l for l in b["links"] if not _is_home_link(l)]
            if kept != b["links"]:
                b = dict(b)
                b["links"] = kept
        out.append(b)
    return out


def promote_section_labels(blocks: list[dict]) -> list[dict]:
    """Convert paragraph blocks that are short, link-less, and immediately
    precede a link-bearing paragraph into heading blocks. The legacy site
    used bold prose (not <h*>) to label clusters of links — without this
    pass they render as orphan body text that looks like broken links."""
    for i, b in enumerate(blocks):
        if b.get("type") != "paragraph": continue
        if b.get("links"): continue
        text = (b.get("text") or "").strip()
        if not text or len(text) > 60 or "\n\n" in text: continue
        # Must be followed by a paragraph that has links.
        nxt = next((blocks[j] for j in range(i + 1, min(i + 3, len(blocks)))
                    if blocks[j].get("type") in ("paragraph", "heading")), None)
        if not nxt or not nxt.get("links"): continue
        b["type"] = "heading"
        b["level"] = 4
    return blocks


# ---------- per-page driver --------------------------------------------------

def extract_page(row: dict) -> dict:
    rel = row["path"]
    source_path = LEGACY_ROOT / rel
    text, encoding = read_html(source_path)
    soup = BeautifulSoup(text, "html.parser")

    title = (soup.title.get_text(strip=True) if soup.title else "") or row["heading"]
    title = re.sub(r"\s*\(table of contents\)\s*$", "", title, flags=re.I).strip()
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
