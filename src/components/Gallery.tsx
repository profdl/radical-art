import { useDeferredValue, useEffect, useMemo, useState } from "react";

export interface GalleryItem {
  src: string;
  alt: string;
  caption: string;
  width: number | null;
  height: number | null;
  pageSlug: string;
  pageTitle: string;
  section: string;
  sectionSlug: string;
}

type SortKey = "page" | "caption" | "section" | "random";

interface Props {
  items: GalleryItem[];
  sections: { slug: string; label: string }[];
}

const PAGE_SIZE = 240;

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export default function Gallery({ items, sections }: Props) {
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<string>("");
  const [sort, setSort] = useState<SortKey>("random");
  const [seed, setSeed] = useState(0);
  const [visible, setVisible] = useState(PAGE_SIZE);

  const deferredQuery = useDeferredValue(query);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    let list = items;
    if (section) list = list.filter((it) => it.sectionSlug === section);
    if (q) {
      list = list.filter(
        (it) =>
          it.caption.toLowerCase().includes(q) ||
          it.pageTitle.toLowerCase().includes(q) ||
          it.alt.toLowerCase().includes(q),
      );
    }
    if (sort === "caption") {
      list = list.slice().sort((a, b) =>
        (a.caption || a.pageTitle).localeCompare(b.caption || b.pageTitle),
      );
    } else if (sort === "section") {
      list = list.slice().sort((a, b) => {
        const s = a.section.localeCompare(b.section);
        return s !== 0 ? s : a.pageTitle.localeCompare(b.pageTitle);
      });
    } else if (sort === "random") {
      list = shuffle(list);
    }
    // "page" is the natural order from the build-time index.
    return list;
  }, [items, deferredQuery, section, sort, seed]);

  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [deferredQuery, section, sort, seed]);

  useEffect(() => {
    function onScroll() {
      if (visible >= filtered.length) return;
      const remaining =
        document.documentElement.scrollHeight -
        window.innerHeight -
        window.scrollY;
      if (remaining < 1200) {
        setVisible((v) => Math.min(v + PAGE_SIZE, filtered.length));
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [visible, filtered.length]);

  const shown = filtered.slice(0, visible);

  return (
    <div>
      <div className="gallery-toolbar">
        <input
          type="search"
          placeholder="Search captions, artists, pages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="gallery-search"
          aria-label="Search images"
        />
        <select
          value={section}
          onChange={(e) => setSection(e.target.value)}
          className="gallery-select"
          aria-label="Filter by section"
        >
          <option value="">All sections</option>
          {sections.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => {
            const v = e.target.value as SortKey;
            setSort(v);
            if (v === "random") setSeed((n) => n + 1);
          }}
          className="gallery-select"
          aria-label="Sort images"
        >
          <option value="page">Sort: by page</option>
          <option value="caption">Sort: caption A–Z</option>
          <option value="section">Sort: by section</option>
          <option value="random">Sort: random</option>
        </select>
        {sort === "random" && (
          <button
            type="button"
            onClick={() => setSeed((n) => n + 1)}
            className="gallery-button"
          >
            Reshuffle
          </button>
        )}
        <span className="gallery-count">
          {filtered.length.toLocaleString()}{" "}
          {filtered.length === 1 ? "image" : "images"}
          {(query || section) && items.length !== filtered.length
            ? ` of ${items.length.toLocaleString()}`
            : ""}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="gallery-empty">No images match this search.</p>
      ) : (
        <div className="gallery-cascade">
          {shown.map((it, i) => (
            <Card key={`${it.src}-${i}`} item={it} />
          ))}
        </div>
      )}

      {visible < filtered.length && (
        <div className="gallery-loadmore">
          <button
            type="button"
            onClick={() =>
              setVisible((v) => Math.min(v + PAGE_SIZE, filtered.length))
            }
            className="gallery-button"
          >
            Show more ({(filtered.length - visible).toLocaleString()} remaining)
          </button>
        </div>
      )}
    </div>
  );
}

function Card({ item }: { item: GalleryItem }) {
  const ratio =
    item.width && item.height && item.width > 0 && item.height > 0
      ? item.height / item.width
      : null;
  const padTop = ratio ? `${ratio * 100}%` : "75%";

  return (
    <figure className="gallery-card">
      <a href={`/${item.pageSlug}`} className="gallery-card-image">
        <span className="gallery-card-frame" style={{ paddingTop: padTop }}>
          <img
            src={item.src}
            alt={item.alt || item.caption || item.pageTitle}
            loading="lazy"
            decoding="async"
          />
        </span>
      </a>
      <figcaption className="gallery-card-meta">
        {item.caption && (
          <p className="gallery-card-caption">{item.caption}</p>
        )}
        <a href={`/${item.pageSlug}`} className="gallery-card-page">
          {item.pageTitle}
        </a>
        <p className="gallery-card-section">{item.section}</p>
      </figcaption>
    </figure>
  );
}
