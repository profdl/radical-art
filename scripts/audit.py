"""
Audit the rebuild against legacy/ to confirm content coverage.

Four checks:

1. PARITY      every legacy/*.html (minus 'exclude' archetype) must have
                a corresponding content/<archetype>/<slug>.json file, and
                vice versa.
2. REACHABILITY walk legacy/graph_data.json from the home node and confirm
                every reachable legacy page resolves to an extracted slug.
                Then walk the rebuild's own link graph (slugs referenced
                by content/*.json blocks) from '/' and report any
                extracted slugs that are not reachable from the home page.
3. FIDELITY    per-page comparison of image counts and paragraph-ish block
                counts between legacy HTML and the extracted JSON. Flags
                pages with large negative deltas (likely extraction loss).
4. HTTP        if the dev server is up at http://localhost:4321, GET every
                slug and report non-200s. Skipped quietly if the server
                is not running.

Run from repo root:

    .venv/bin/python scripts/audit.py
    .venv/bin/python scripts/audit.py --skip-http
    .venv/bin/python scripts/audit.py --base-url http://localhost:4321
    .venv/bin/python scripts/audit.py --json > audit.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse

from bs4 import BeautifulSoup

LEGACY_ROOT = Path("legacy")
CONTENT_ROOT = Path("content")
INVENTORY_PATH = Path("scripts/pages_inventory.json")
GRAPH_PATH = LEGACY_ROOT / "graph_data.json"

ENCODINGS = ["utf-8", "latin1", "cp1252", "iso-8859-1"]

DECORATIVE_IMG_RE = re.compile(
    r"buttons?/|bullet|spacer|pixel|/line\.|/rule\.|hr\.gif|dot\.gif", re.I
)

# Thresholds for flagging fidelity drift.
IMG_DELTA_FLAG = 2          # legacy_images - extracted_images >= this -> flag
PARA_DELTA_FLAG = 3          # legacy_paragraphs - extracted_blocks >= this -> flag


# ---------- shared helpers ----------------------------------------------------

def read_html(path: Path) -> str:
    for enc in ENCODINGS:
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_bytes().decode("latin1", errors="replace")


def slugify(s: str) -> str:
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", s)
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-") or "page"


def page_slug(rel_path: str) -> str:
    p = rel_path.replace("\\", "/")
    if p.endswith("/index.html"):
        p = p[: -len("/index.html")]
    elif p.endswith(".html"):
        p = p[: -len(".html")]
    parts = [slugify(seg) for seg in p.split("/") if seg]
    return "/".join(parts)


# ---------- step 1: parity ----------------------------------------------------

def load_inventory() -> dict:
    with INVENTORY_PATH.open() as f:
        return json.load(f)


def load_extracted() -> dict[str, dict]:
    """slug -> JSON document."""
    out: dict[str, dict] = {}
    for root, _, files in os.walk(CONTENT_ROOT):
        for name in files:
            if not name.endswith(".json"):
                continue
            with (Path(root) / name).open() as f:
                doc = json.load(f)
            out[doc["slug"]] = doc
    return out


def parity_check(inventory: dict, extracted: dict[str, dict]) -> dict:
    expected: dict[str, dict] = {}  # slug -> inventory row
    for row in inventory["pages"]:
        if row["archetype_guess"] == "exclude":
            continue
        slug = page_slug(row["path"])
        expected[slug] = row

    missing = sorted(set(expected) - set(extracted))
    orphan = sorted(set(extracted) - set(expected))

    archetype_mismatch = []
    for slug in sorted(set(expected) & set(extracted)):
        want = expected[slug]["archetype_guess"]
        got = extracted[slug]["archetype"]
        if want != got:
            archetype_mismatch.append({"slug": slug, "expected": want, "got": got})

    return {
        "expected_count": len(expected),
        "extracted_count": len(extracted),
        "missing": missing,
        "orphan_extracted": orphan,
        "archetype_mismatch": archetype_mismatch,
    }


# ---------- step 2: reachability ----------------------------------------------

def load_graph() -> dict:
    with GRAPH_PATH.open() as f:
        return json.load(f)


def legacy_reachable_from_home(graph: dict) -> tuple[set[str], list[str]]:
    """BFS over legacy graph_data.json starting at index.html.

    Returns (reachable_legacy_paths, isolated_legacy_paths).
    """
    by_id = {n["id"]: n["name"] for n in graph["nodes"]}
    name_to_id = {n["name"]: n["id"] for n in graph["nodes"]}
    adj: dict[int, list[int]] = defaultdict(list)
    for link in graph["links"]:
        adj[link["source"]].append(link["target"])

    home = name_to_id.get("index.html")
    if home is None:
        return set(), sorted(by_id.values())

    seen = {home}
    stack = [home]
    while stack:
        nid = stack.pop()
        for tgt in adj.get(nid, ()):
            if tgt not in seen:
                seen.add(tgt)
                stack.append(tgt)

    reachable = {by_id[i] for i in seen}
    isolated = sorted(set(by_id.values()) - reachable)
    return reachable, isolated


def reachability_check(graph: dict, extracted: dict[str, dict]) -> dict:
    reachable_legacy, isolated_legacy = legacy_reachable_from_home(graph)

    # legacy paths reachable from home but never extracted
    extracted_legacy_paths = {doc["legacy_path"] for doc in extracted.values()}
    reachable_but_unextracted = sorted(
        p for p in reachable_legacy
        if p not in extracted_legacy_paths and not p.startswith("_") and p != "site_graph.html"
    )

    # rebuild-side graph: which slugs do extracted pages link to?
    rebuild_adj: dict[str, set[str]] = defaultdict(set)
    slug_set = set(extracted)

    def walk_blocks(blocks):
        for b in blocks or []:
            for lk in b.get("links", []) or []:
                if lk.get("external"):
                    continue
                href = lk.get("href") or ""
                href = href.split("#")[0].split("?")[0]
                if not href.startswith("/"):
                    continue
                target = href.lstrip("/")
                # ignore links into /assets/ or /images/
                if target.startswith(("assets/", "images/")):
                    continue
                if target in slug_set:
                    yield target
            # recurse into common nested-block keys
            for key in ("items", "groups", "children", "blocks"):
                if isinstance(b.get(key), list):
                    for child in b[key]:
                        if isinstance(child, dict):
                            for t in walk_blocks([child]):
                                yield t

    home_doc = extracted.get("")  # site-home stored under empty slug? check
    # site-home slug is '' in our pipeline (index → root). Confirm.
    home_slugs = [s for s, d in extracted.items() if d.get("archetype") == "site-home"]
    if not home_slugs:
        # fall back: treat any slug containing 'index' or '' as start
        home_slugs = [s for s in extracted if s in ("", "index", "home")]

    for slug, doc in extracted.items():
        for tgt in walk_blocks(doc.get("blocks")):
            rebuild_adj[slug].add(tgt)

    rebuild_seen: set[str] = set()
    stack = list(home_slugs)
    rebuild_seen.update(stack)
    while stack:
        s = stack.pop()
        for t in rebuild_adj.get(s, ()):
            if t not in rebuild_seen:
                rebuild_seen.add(t)
                stack.append(t)

    rebuild_unreachable = sorted(set(extracted) - rebuild_seen)

    return {
        "legacy_total_nodes": len(graph["nodes"]),
        "legacy_reachable_from_home": len(reachable_legacy),
        "legacy_isolated_from_home": isolated_legacy,
        "reachable_but_unextracted": reachable_but_unextracted,
        "rebuild_home_slugs": home_slugs,
        "rebuild_unreachable_from_home": rebuild_unreachable,
    }


# ---------- step 3: per-page fidelity -----------------------------------------

def count_legacy_metrics(html: str) -> tuple[int, int]:
    """(content_image_count, paragraph_count) for a legacy page."""
    soup = BeautifulSoup(html, "html.parser")
    imgs = 0
    for img in soup.find_all("img"):
        src = img.get("src", "")
        if src and not DECORATIVE_IMG_RE.search(src):
            imgs += 1
    paras = len(soup.find_all("p"))
    return imgs, paras


def count_extracted_metrics(doc: dict) -> tuple[int, int]:
    img = 0
    para = 0
    def walk(blocks):
        nonlocal img, para
        for b in blocks or []:
            t = b.get("type")
            if t in ("image", "figure"):
                img += 1
            elif t in ("paragraph", "quote"):
                para += 1
            for key in ("items", "groups", "children", "blocks"):
                if isinstance(b.get(key), list):
                    walk(b[key])
    walk(doc.get("blocks"))
    return img, para


def fidelity_check(extracted: dict[str, dict]) -> dict:
    flagged = []
    for slug, doc in extracted.items():
        legacy_path = doc.get("legacy_path")
        if not legacy_path:
            continue
        full = LEGACY_ROOT / legacy_path
        if not full.is_file():
            continue
        try:
            html = read_html(full)
        except Exception as e:
            flagged.append({"slug": slug, "error": f"read failed: {e}"})
            continue
        l_img, l_para = count_legacy_metrics(html)
        e_img, e_para = count_extracted_metrics(doc)
        img_delta = l_img - e_img
        para_delta = l_para - e_para
        if img_delta >= IMG_DELTA_FLAG or para_delta >= PARA_DELTA_FLAG:
            flagged.append({
                "slug": slug,
                "legacy_path": legacy_path,
                "archetype": doc.get("archetype"),
                "legacy_images": l_img,
                "extracted_images": e_img,
                "img_delta": img_delta,
                "legacy_paragraphs": l_para,
                "extracted_paragraphs": e_para,
                "para_delta": para_delta,
            })
    flagged.sort(key=lambda r: (-(r.get("img_delta") or 0), -(r.get("para_delta") or 0)))
    return {
        "thresholds": {"img_delta_flag": IMG_DELTA_FLAG, "para_delta_flag": PARA_DELTA_FLAG},
        "flagged_count": len(flagged),
        "flagged": flagged[:200],
        "truncated": len(flagged) > 200,
    }


# ---------- step 4: HTTP smoke ------------------------------------------------

def http_check(extracted: dict[str, dict], base_url: str, timeout: float = 5.0) -> dict | None:
    # ping root first; if it fails, server is down.
    try:
        with urllib.request.urlopen(base_url + "/", timeout=timeout) as r:
            r.read(64)
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        return None

    failures = []
    checked = 0
    for slug, doc in sorted(extracted.items()):
        if doc.get("archetype") == "site-home":
            url = base_url + "/"
        else:
            url = base_url + "/" + slug
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                code = r.status
        except urllib.error.HTTPError as e:
            code = e.code
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            code = f"ERR:{e}"
        checked += 1
        if code != 200:
            failures.append({"slug": slug, "url": url, "status": code})
    return {"base_url": base_url, "checked": checked, "failures": failures}


# ---------- report ------------------------------------------------------------

def print_human_report(report: dict) -> None:
    p = report["parity"]
    print("=" * 72)
    print("PARITY")
    print("=" * 72)
    print(f"expected pages (non-exclude inventory): {p['expected_count']}")
    print(f"extracted JSON documents:               {p['extracted_count']}")
    if p["missing"]:
        print(f"\nMISSING ({len(p['missing'])}) — in inventory but no JSON:")
        for s in p["missing"]:
            print(f"  - {s}")
    if p["orphan_extracted"]:
        print(f"\nORPHAN ({len(p['orphan_extracted'])}) — JSON exists but no inventory row:")
        for s in p["orphan_extracted"]:
            print(f"  - {s}")
    if p["archetype_mismatch"]:
        print(f"\nARCHETYPE DRIFT ({len(p['archetype_mismatch'])}) — inventory says X, JSON says Y:")
        for r in p["archetype_mismatch"][:20]:
            print(f"  - {r['slug']}: {r['expected']} -> {r['got']}")
        if len(p["archetype_mismatch"]) > 20:
            print(f"  ... ({len(p['archetype_mismatch']) - 20} more)")
    if not (p["missing"] or p["orphan_extracted"] or p["archetype_mismatch"]):
        print("OK — every legacy page is extracted with the expected archetype.")

    r = report["reachability"]
    print()
    print("=" * 72)
    print("REACHABILITY")
    print("=" * 72)
    print(f"legacy nodes total:           {r['legacy_total_nodes']}")
    print(f"legacy reachable from home:   {r['legacy_reachable_from_home']}")
    print(f"legacy isolated from home:    {len(r['legacy_isolated_from_home'])}")
    if r["legacy_isolated_from_home"]:
        for n in r["legacy_isolated_from_home"][:15]:
            print(f"  - {n}")
        if len(r["legacy_isolated_from_home"]) > 15:
            print(f"  ... ({len(r['legacy_isolated_from_home']) - 15} more)")
    if r["reachable_but_unextracted"]:
        print(f"\nREACHABLE BUT UNEXTRACTED ({len(r['reachable_but_unextracted'])}):")
        for n in r["reachable_but_unextracted"]:
            print(f"  - {n}")
    print(f"\nrebuild home slug(s): {r['rebuild_home_slugs']!r}")
    print(f"rebuild unreachable from home: {len(r['rebuild_unreachable_from_home'])}")
    for s in r["rebuild_unreachable_from_home"][:30]:
        print(f"  - /{s}")
    if len(r["rebuild_unreachable_from_home"]) > 30:
        print(f"  ... ({len(r['rebuild_unreachable_from_home']) - 30} more)")

    f = report["fidelity"]
    print()
    print("=" * 72)
    print("FIDELITY (per-page extraction completeness)")
    print("=" * 72)
    print(f"flag thresholds: image delta >= {f['thresholds']['img_delta_flag']},"
          f" paragraph delta >= {f['thresholds']['para_delta_flag']}")
    print(f"flagged pages: {f['flagged_count']}")
    for row in f["flagged"][:25]:
        print(f"  - /{row['slug']:<55s}  imgs {row['legacy_images']:>3} -> {row['extracted_images']:<3} (Δ{row['img_delta']:+d})"
              f"  paras {row['legacy_paragraphs']:>3} -> {row['extracted_paragraphs']:<3} (Δ{row['para_delta']:+d})")
    if f["flagged_count"] > 25:
        print(f"  ... ({f['flagged_count'] - 25} more)")

    h = report.get("http")
    print()
    print("=" * 72)
    print("HTTP SMOKE")
    print("=" * 72)
    if h is None:
        print("dev server unreachable — skipped. (run `npm run dev` first.)")
    else:
        print(f"base: {h['base_url']}   checked: {h['checked']}   failures: {len(h['failures'])}")
        for row in h["failures"][:30]:
            print(f"  - {row['status']}  {row['url']}")
        if len(h["failures"]) > 30:
            print(f"  ... ({len(h['failures']) - 30} more)")

    print()
    print("=" * 72)
    print("SUMMARY")
    print("=" * 72)
    issues = (
        len(p["missing"])
        + len(p["orphan_extracted"])
        + len(p["archetype_mismatch"])
        + len(r["reachable_but_unextracted"])
        + len(r["rebuild_unreachable_from_home"])
        + f["flagged_count"]
        + (len(h["failures"]) if isinstance(h, dict) else 0)
    )
    print(f"total issues surfaced: {issues}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base-url", default="http://localhost:4321")
    ap.add_argument("--skip-http", action="store_true")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON instead of human report")
    args = ap.parse_args()

    if not INVENTORY_PATH.exists():
        print(f"missing {INVENTORY_PATH}; run scripts/inventory.py first.", file=sys.stderr)
        return 2
    if not CONTENT_ROOT.exists():
        print(f"missing {CONTENT_ROOT}; run scripts/extract.py first.", file=sys.stderr)
        return 2

    inventory = load_inventory()
    extracted = load_extracted()
    graph = load_graph() if GRAPH_PATH.exists() else {"nodes": [], "links": []}

    report = {
        "parity": parity_check(inventory, extracted),
        "reachability": reachability_check(graph, extracted),
        "fidelity": fidelity_check(extracted),
        "http": None if args.skip_http else http_check(extracted, args.base_url),
    }

    if args.json:
        json.dump(report, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print_human_report(report)

    return 0


if __name__ == "__main__":
    sys.exit(main())
