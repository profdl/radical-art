import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// One image in the archive. `pageSlug` is the page where it appears (its
// "home" — images can technically appear on multiple pages but the dataset
// keys each figure to its source page). `category` is the top-level cluster
// slug after virtualParents reparenting (mirrors Sidebar.astro / build_graph.py).
export interface ConstellationImage {
  id: string; // src — unique within the archive
  src: string;
  alt: string;
  caption: string;
  pageSlug: string;
  pageTitle: string;
  pageBlurb: string;
  category: string | null; // null = uncategorized (homepage essays etc.)
  categoryLabel: string | null;
}

// Page → image ids it contains, page → its sibling pages (link-graph
// neighbors). Both precomputed at build time so the client just walks them.
export interface PageMeta {
  slug: string;
  title: string;
  blurb: string;
  category: string | null;
  categoryLabel: string | null;
  imageIds: string[];
  siblingSlugs: string[];
}

interface Props {
  basePath: string;
  /** URL to fetch the {images, pages} bundle from (built by
   *  src/pages/constellation.json.ts at build time). Lazy-fetching keeps the
   *  page HTML small — the 3,500-image archive index is ~2.5MB and would
   *  bloat constellation.html if inlined as serialized component props. */
  dataUrl: string;
}

interface SatelliteSlot {
  img: ConstellationImage;
  /** Angle on the ring, radians. */
  angle: number;
  /** Distance from center, px. */
  distance: number;
  /** Render size (longest edge), px. */
  size: number;
  /** Index of the inner-ring satellite this branch is anchored to.
   *  -1 = inner ring itself (no parent). */
  parentIndex: number;
}

const SATELLITES_TARGET = 7; // not counting the center
const SAME_PAGE_INNER_CAP = 3; // max inner satellites that can be from the
// same page as the center — the rest are reserved for sibling pages /
// category-mates so the user always has visible escape routes. On
// image-grid pages (60% of the archive) this is the difference between a
// constellation that traps you on one page and one that points outward.
const OUTER_PER_BRANCH = 2; // each inner satellite seeds N outer satellites
const TRAIL_LIMIT = 5;
const TRANSITION_MS = 720; // longer = more drift, less snap
const TRAVELER_MS = 820; // how long the clicked satellite takes to fly into the center
const SATELLITE_FADE_MS = 620; // fade-in for new satellites
const SATELLITE_STAGGER_MS = 35; // per-satellite stagger so the ring blooms outward
const SESSION_KEY = "constellation:state:v1";
const ZODIAC_OVERLAP_PX = 60; // a satellite within this radius of a zodiac
// label dims the label so the image is readable. Slightly bigger than the
// satellite half-width (110/2 = 55) so the fade kicks in just before
// visual collision.

// Spring-y easing for satellite arrivals — overshoots a hair, settles. The
// previous default cubic-bezier(.2,.7,.2,1) was lively but too uniform across
// elements. This curve has a tiny tail that reads as "settling into place"
// rather than "stopping precisely on the dot."
const TRAVEL_EASING = "cubic-bezier(.22,.61,.36,1)";

// The 10 categories surfaced by the legacy homepage, in the order they appear
// in Sidebar.astro topOrder. The constellation places them around the stage
// edge as a "zodiac" — always visible so the user sees the archive's shape
// regardless of where they currently are.
const ZODIAC: { slug: string; label: string }[] = [
  { slug: "concept", label: "concept" },
  { slug: "life", label: "life" },
  { slug: "everything", label: "everything" },
  { slug: "algorithmic-art", label: "algorithm" },
  { slug: "anything", label: "anything" },
  { slug: "kinetics", label: "mechanics" },
  { slug: "something", label: "something" },
  { slug: "process", label: "process" },
  { slug: "destruction", label: "destruction" },
  { slug: "nothing", label: "nothing" },
];

interface PersistedState {
  trail: string[];
  visited: string[];
}

// Thin-stroke refresh glyph used next to the *current* category label as a
// "click to re-roll" affordance. Hand-drawn so the stroke weight matches the
// surrounding 0.72rem uppercase label (the unicode ↻ character renders too
// heavy in IBM Plex Sans and the visual top of that glyph is the bottom of
// the arc, which read as upside-down). currentColor + thin stroke + a gap at
// 12 o'clock + arrowhead pointing back into the gap = unambiguous "refresh"
// at any orientation.
function RerollGlyph() {
  return (
    <span className="constellation-reroll-glyph" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
        {/* Arc from ~12:30 around clockwise to ~11:30 — leaves a gap at the top. */}
        <path d="M 9.2 3.2 A 5 5 0 1 1 3 8" />
        {/* Arrowhead pointing into the gap at the top, indicating direction. */}
        <path d="M 9.2 3.2 L 6.8 3.6 M 9.2 3.2 L 8.9 5.6" />
      </svg>
    </span>
  );
}

function loadPersisted(): PersistedState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (!Array.isArray(parsed.trail) || !Array.isArray(parsed.visited)) return null;
    return {
      trail: parsed.trail.filter((x): x is string => typeof x === "string"),
      visited: parsed.visited.filter((x): x is string => typeof x === "string"),
    };
  } catch {
    return null;
  }
}

export default function Constellation({ basePath, dataUrl }: Props) {
  const [images, setImages] = useState<ConstellationImage[] | null>(null);
  const [pages, setPages] = useState<PageMeta[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fetch the archive index once. Mirrors the pattern in MapView.tsx for
  // graph.json — keeps the page-shell tiny and lets the browser cache the
  // index across visits.
  useEffect(() => {
    let cancelled = false;
    fetch(dataUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`${dataUrl}: ${r.status}`);
        return r.json();
      })
      .then((data: { images: ConstellationImage[]; pages: PageMeta[] }) => {
        if (cancelled) return;
        setImages(data.images);
        setPages(data.pages);
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [dataUrl]);

  // Lookups. Empty maps until data arrives — downstream code tolerates this.
  const imageById = useMemo(() => {
    const m = new Map<string, ConstellationImage>();
    if (images) for (const it of images) m.set(it.id, it);
    return m;
  }, [images]);
  const pageBySlug = useMemo(() => {
    const m = new Map<string, PageMeta>();
    if (pages) for (const p of pages) m.set(p.slug, p);
    return m;
  }, [pages]);

  // Index images by category so leap-mode can pick from a specific category
  // cheaply, and so the zodiac ring can show counts/availability.
  const imagesByCategory = useMemo(() => {
    const m = new Map<string, ConstellationImage[]>();
    if (!images) return m;
    for (const it of images) {
      if (!it.category) continue;
      const arr = m.get(it.category);
      if (arr) arr.push(it);
      else m.set(it.category, [it]);
    }
    return m;
  }, [images]);

  // Pick a random *image* with a real category (no homepage stragglers) and
  // whose page has at least one other image — so the first constellation has
  // satellites, not just a lone center. Optionally constrained to a category.
  const pickRandomCenter = useCallback(
    (constrainCategory?: string | null): ConstellationImage | null => {
      if (!images || images.length === 0) return null;
      const pool = constrainCategory
        ? imagesByCategory.get(constrainCategory) ?? []
        : images;
      const candidates = pool.filter((it) => {
        if (!it.category) return false;
        const page = pageBySlug.get(it.pageSlug);
        if (!page) return false;
        return page.imageIds.length >= 2 || page.siblingSlugs.length >= 1;
      });
      if (candidates.length === 0) return pool[0] ?? images[0] ?? null;
      return candidates[Math.floor(Math.random() * candidates.length)];
    },
    [images, imagesByCategory, pageBySlug]
  );

  // Persisted state: trail, visited categories. Hydrated lazily from
  // sessionStorage so a refresh doesn't yank the user out of their walk.
  const [trail, setTrail] = useState<string[]>([]);
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const hydratedRef = useRef(false);

  // One-time hydration from sessionStorage. We do this in an effect (not in
  // useState's initializer) because the component runs client-only via
  // client:only="react" — but the init is still cheap to defer, and keeping
  // it here keeps SSR-safety guards out of the initializer paths.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const persisted = loadPersisted();
    if (persisted) {
      if (persisted.trail.length > 0) setTrail(persisted.trail);
      if (persisted.visited.length > 0) setVisited(new Set(persisted.visited));
    }
  }, []);

  // Persist on change. Throttled implicitly by React batching — fine for our
  // volume (a click or two per second at most).
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (typeof window === "undefined") return;
    try {
      const payload: PersistedState = {
        trail,
        visited: Array.from(visited),
      };
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch {
      // Quota exceeded or storage disabled — silent fail, the feature is
      // best-effort.
    }
  }, [trail, visited]);

  const centerId = trail[trail.length - 1] ?? null;

  // Pick the initial constellation as soon as data arrives — but only if
  // hydration has finished and produced no trail. The trail.length guard
  // prevents re-rolling on subsequent re-renders or after a session restore.
  useEffect(() => {
    if (!images || !hydratedRef.current || trail.length > 0) return;
    const c = pickRandomCenter();
    if (c) {
      setTrail([c.id]);
      if (c.category) setVisited((cur) => new Set(cur).add(c.category!));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  const center = centerId ? imageById.get(centerId) ?? null : null;
  const centerPage = center ? pageBySlug.get(center.pageSlug) ?? null : null;

  // Whenever the center changes (including on hydration), record its category
  // as visited. Idempotent — Set keeps it cheap.
  useEffect(() => {
    if (!center?.category) return;
    setVisited((cur) => {
      if (cur.has(center.category!)) return cur;
      const next = new Set(cur);
      next.add(center.category!);
      return next;
    });
  }, [center]);

  // Resolve the satellite set. Order of operations:
  //   1. Up to SAME_PAGE_INNER_CAP same-page images (was: unbounded). On
  //      image-heavy pages this prevents the ring from being 100% same-page,
  //      which traps the user on one page with no visible exits.
  //   2. Sibling pages (link-graph neighbors), one per page round-robin.
  //   3. Category-mates — random images from the center's top-level category
  //      *not* on the current page. Last-resort escape route for pages with
  //      few or no link-graph siblings (e.g. image-grid leaves whose only
  //      links point upward to a hub).
  // Excludes the center itself. If we still don't have enough, leave it
  // short — better than padding with arbitrary unrelated images.
  const satellites = useMemo<ConstellationImage[]>(() => {
    if (!center || !centerPage) return [];
    const out: ConstellationImage[] = [];
    const seen = new Set<string>([center.id]);

    // 1) same page, capped — reserves slots for escape routes.
    let samePageAdded = 0;
    for (const id of centerPage.imageIds) {
      if (samePageAdded >= SAME_PAGE_INNER_CAP) break;
      if (seen.has(id)) continue;
      const img = imageById.get(id);
      if (!img) continue;
      out.push(img);
      seen.add(id);
      samePageAdded++;
      if (out.length >= SATELLITES_TARGET) break;
    }

    // 2) Sibling pages, one per page round-robin so a single image-heavy
    //    sibling can't dominate.
    if (out.length < SATELLITES_TARGET) {
      const queues: string[][] = centerPage.siblingSlugs
        .map((s) => {
          const sp = pageBySlug.get(s);
          if (!sp) return [];
          return sp.imageIds.filter((id) => !seen.has(id));
        })
        .filter((q) => q.length > 0);
      let idx = 0;
      while (out.length < SATELLITES_TARGET && queues.some((q) => q.length > 0)) {
        const q = queues[idx % queues.length];
        if (q.length > 0) {
          const id = q.shift()!;
          if (!seen.has(id)) {
            const img = imageById.get(id);
            if (img) {
              out.push(img);
              seen.add(id);
            }
          }
        }
        idx++;
        if (idx > queues.length * 8) break;
      }
    }

    // 3) Category-mates fallback. Picks pseudo-random images from the
    //    center's category whose page differs from the center's page.
    //    Deterministic per-center via id-seeded hash so revisits are stable.
    if (out.length < SATELLITES_TARGET && center.category) {
      const pool = imagesByCategory.get(center.category) ?? [];
      // id-seeded shuffle index — visit `pool` in a stable rotated order.
      let h = 0;
      for (let i = 0; i < center.id.length; i++) h = (h * 31 + center.id.charCodeAt(i)) >>> 0;
      const len = pool.length;
      for (let step = 0; step < len && out.length < SATELLITES_TARGET; step++) {
        const i = (h + step * 1009) % len;
        const cand = pool[i];
        if (!cand) continue;
        if (seen.has(cand.id)) continue;
        if (cand.pageSlug === center.pageSlug) continue;
        out.push(cand);
        seen.add(cand.id);
      }
    }

    return out;
  }, [center, centerPage, imageById, pageBySlug, imagesByCategory]);

  // Outer ring is the **escape ring**: it intentionally never draws from the
  // center's own page. Each inner satellite seeds OUTER_PER_BRANCH outer
  // images drawn from that satellite's link-graph siblings and, as a last
  // resort, from category-mates. The visual contract becomes:
  //
  //   inner ring = "where you are" (a few same-page images + neighbors)
  //   outer ring = "where you can go" (always cross-page)
  //
  // Selection per branch (in order, until OUTER_PER_BRANCH is reached):
  //   1. First image of each sibling page of the satellite, round-robin.
  //      Skip if the sibling is the center's page (no recursion home).
  //   2. If the satellite is *itself* on a different page from the center,
  //      a few of its page-mates can be used (since they're already
  //      cross-page from the user's POV).
  //   3. Category-mates of the satellite (image not on center's page).
  // Empty branches are fine — better than padding with same-page images
  // that defeat the escape-ring purpose.
  const outerSatellites = useMemo<{ img: ConstellationImage; parentIndex: number }[]>(() => {
    if (!center || satellites.length === 0) return [];
    const centerPageSlug = center.pageSlug;
    const drawn = new Set<string>([center.id, ...satellites.map((s) => s.id)]);
    const out: { img: ConstellationImage; parentIndex: number }[] = [];

    satellites.forEach((sat, parentIdx) => {
      const satPage = pageBySlug.get(sat.pageSlug);
      if (!satPage) return;
      const picks: ConstellationImage[] = [];

      // 1) sibling pages of this satellite — primary escape source.
      for (const sibSlug of satPage.siblingSlugs) {
        if (picks.length >= OUTER_PER_BRANCH) break;
        if (sibSlug === centerPageSlug) continue;
        const sibPage = pageBySlug.get(sibSlug);
        if (!sibPage) continue;
        for (const id of sibPage.imageIds) {
          if (drawn.has(id)) continue;
          const img = imageById.get(id);
          if (!img) continue;
          if (img.pageSlug === centerPageSlug) continue;
          picks.push(img);
          drawn.add(id);
          break; // one per sibling page so the branch isn't dominated
        }
      }

      // 2) page-mates of the satellite — ONLY if the satellite is itself
      //    cross-page. Otherwise this would just be more center-page imagery,
      //    which is the trap we're trying to avoid.
      if (picks.length < OUTER_PER_BRANCH && sat.pageSlug !== centerPageSlug) {
        for (const id of satPage.imageIds) {
          if (picks.length >= OUTER_PER_BRANCH) break;
          if (drawn.has(id)) continue;
          const img = imageById.get(id);
          if (!img) continue;
          picks.push(img);
          drawn.add(id);
        }
      }

      // 3) Category-mates fallback. Stable per (sat.id) so the same
      //    constellation looks the same on revisit.
      if (picks.length < OUTER_PER_BRANCH && sat.category) {
        const pool = imagesByCategory.get(sat.category) ?? [];
        let h = 0;
        for (let i = 0; i < sat.id.length; i++) h = (h * 31 + sat.id.charCodeAt(i)) >>> 0;
        const len = pool.length;
        for (let step = 0; step < len && picks.length < OUTER_PER_BRANCH; step++) {
          const i = (h + step * 1009) % len;
          const cand = pool[i];
          if (!cand) continue;
          if (drawn.has(cand.id)) continue;
          if (cand.pageSlug === centerPageSlug) continue;
          picks.push(cand);
          drawn.add(cand.id);
        }
      }

      for (const img of picks) {
        out.push({ img, parentIndex: parentIdx });
      }
    });

    return out;
  }, [center, satellites, imageById, pageBySlug, imagesByCategory]);

  // Track the canvas-ish viewport size so we can place satellites in absolute
  // px from the center. Using a div + absolutely-positioned children (rather
  // than a real canvas) so each image is a regular <img> with browser-level
  // decoding, caching, and accessibility — important because images are the
  // *content* here, not decoration.
  //
  // Callback ref (not useRef + useEffect): the stage element is conditionally
  // rendered — a placeholder while data loads, the real stage afterward. A
  // mount-once useEffect would observe whichever stage was mounted first and
  // miss the swap, leaving stageSize at {0,0} forever and piling everything
  // at the top-left corner. The callback ref re-binds the ResizeObserver
  // every time React swaps the underlying DOM node.
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const stageElRef = useRef<HTMLDivElement | null>(null);
  const stageObserverRef = useRef<ResizeObserver | null>(null);
  const stageRef = useCallback((el: HTMLDivElement | null) => {
    if (stageObserverRef.current) {
      stageObserverRef.current.disconnect();
      stageObserverRef.current = null;
    }
    stageElRef.current = el;
    if (!el) return;
    const update = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    stageObserverRef.current = ro;
  }, []);

  // Compute satellite slots for both rings.
  //
  // Inner ring: even angular spacing around the center, with a small
  // deterministic jitter seeded by the center image id so the same
  // constellation looks identical on revisit but the *shape* differs from
  // page to page (so it doesn't read as a rigid wheel every time).
  //
  // Outer ring: each second-degree image is anchored at its parent inner
  // satellite's angle, fanned out symmetrically. Its angular offset depends
  // on how many siblings share the parent, and its radius is the outer ring
  // baseline plus a small per-image jitter. This is what makes the outer
  // ring read as branches off the inner ring rather than a second concentric
  // wheel of unrelated images.
  const { innerSlots, outerSlots } = useMemo(() => {
    if (!center || satellites.length === 0) {
      return { innerSlots: [] as SatelliteSlot[], outerSlots: [] as SatelliteSlot[] };
    }
    const N = satellites.length;
    const minDim = Math.min(stageSize.w || 800, stageSize.h || 600);
    // Inner ring stays roughly where it was. Outer ring pulls inward (was
    // 0.44) so it doesn't crowd the zodiac (now at 0.50). Gap between outer
    // and zodiac is ~0.10 of minDim, enough room for a 64px outer thumbnail
    // plus its label-fade buffer.
    const innerRing = Math.max(170, minDim * 0.27);
    const outerRing = Math.max(270, minDim * 0.40);

    // Deterministic hash → [0,1) for the center id, rotates the ring start
    // so different constellations don't all begin at -π/2.
    let h = 0;
    for (let i = 0; i < center.id.length; i++) h = (h * 31 + center.id.charCodeAt(i)) >>> 0;
    const startAngle = (h % 360) * (Math.PI / 180);

    const inner: SatelliteSlot[] = satellites.map((img, i) => {
      const base = startAngle + (i / N) * Math.PI * 2;
      let g = 0;
      for (let k = 0; k < img.id.length; k++) g = (g * 17 + img.id.charCodeAt(k)) >>> 0;
      const jitterAngle = ((g % 100) / 100 - 0.5) * 0.18;
      const jitterRadius = ((g % 1000) / 1000 - 0.5) * (innerRing * 0.18);
      return {
        img,
        angle: base + jitterAngle,
        distance: innerRing + jitterRadius,
        size: 110,
        parentIndex: -1,
      };
    });

    // Group outer satellites by parent so we can fan them symmetrically.
    const branches = new Map<number, ConstellationImage[]>();
    for (const o of outerSatellites) {
      const arr = branches.get(o.parentIndex);
      if (arr) arr.push(o.img);
      else branches.set(o.parentIndex, [o.img]);
    }

    const outer: SatelliteSlot[] = [];
    for (const [parentIdx, imgs] of branches) {
      const parent = inner[parentIdx];
      if (!parent) continue;
      const M = imgs.length;
      // Fan width tightens as branch count grows; never wider than ±0.32 rad.
      const fanHalf = Math.min(0.32, 0.14 + M * 0.04);
      imgs.forEach((img, j) => {
        // Position within the fan: spread (-fanHalf, +fanHalf), centered.
        const t = M === 1 ? 0 : (j / (M - 1)) * 2 - 1; // -1..1
        const branchAngle = parent.angle + t * fanHalf;
        // Per-image jitter (stable, id-seeded).
        let g = 0;
        for (let k = 0; k < img.id.length; k++) g = (g * 17 + img.id.charCodeAt(k)) >>> 0;
        const jitterAngle = ((g % 100) / 100 - 0.5) * 0.06;
        const jitterRadius = ((g % 1000) / 1000 - 0.5) * (outerRing * 0.1);
        outer.push({
          img,
          angle: branchAngle + jitterAngle,
          distance: outerRing + jitterRadius,
          size: 44,
          parentIndex: parentIdx,
        });
      });
    }

    return { innerSlots: inner, outerSlots: outer };
  }, [center, satellites, outerSatellites, stageSize.w, stageSize.h]);

  // "Traveler" — when a satellite is clicked, the clicked image visibly
  // flies from its slot into the center, growing to center size. The
  // actual center element is held at opacity 0 while the traveler is in
  // flight, then fades in once the traveler arrives.
  const [traveler, setTraveler] = useState<{
    id: string;
    fromAngle: number;
    fromDistance: number;
    fromSize: number;
    // enter: at the satellite slot, satellite size, dim.
    // leave: animating to center position at center size, opaque on arrival.
    phase: "enter" | "leave";
  } | null>(null);
  // Two-stage center reveal. While `centerHidden` is true the center
  // element is rendered with opacity:0 AND `transition: none` — this is
  // critical, otherwise React would animate the *outgoing* old center
  // image down to 0 (visible as a "ghost flash" at the destination before
  // the traveler arrives). Stage 1: snap to invisible. Stage 2: once the
  // traveler completes, flip to false WITH transition restored, fading the
  // new center in.
  const [centerHidden, setCenterHidden] = useState(false);
  const travelerTimerRef = useRef<number | null>(null);
  const launchTraveler = useCallback(
    (id: string, slot: SatelliteSlot) => {
      if (travelerTimerRef.current !== null) {
        window.clearTimeout(travelerTimerRef.current);
      }
      setCenterHidden(true);
      setTraveler({
        id,
        fromAngle: slot.angle,
        fromDistance: slot.distance,
        fromSize: slot.size,
        phase: "enter",
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTraveler((cur) => (cur && cur.id === id ? { ...cur, phase: "leave" } : cur));
        });
      });
      // The traveler arrives at center, opaque, at TRAVELER_MS. At that
      // exact moment we instantly swap: unmount the traveler and reveal
      // the real center with no fade. Both show the same image at the
      // same position and size, so the swap is invisible.
      travelerTimerRef.current = window.setTimeout(() => {
        setCenterHidden(false);
        setTraveler(null);
        travelerTimerRef.current = null;
      }, TRAVELER_MS);
    },
    []
  );
  useEffect(() => {
    return () => {
      if (travelerTimerRef.current !== null) {
        window.clearTimeout(travelerTimerRef.current);
      }
    };
  }, []);

  // Click a satellite (inner OR outer) → it becomes the new center. The
  // traveler animation carries the clicked image inward to the center
  // position; the outgoing center simply disappears under it.
  const travelTo = useCallback(
    (id: string, slot?: SatelliteSlot) => {
      if (slot) launchTraveler(id, slot);
      setTrail((prev) => {
        const next = [...prev, id];
        if (next.length > TRAIL_LIMIT) return next.slice(next.length - TRAIL_LIMIT);
        return next;
      });
    },
    [launchTraveler]
  );

  const trailJump = useCallback((idx: number) => {
    setTrail((prev) => prev.slice(0, idx + 1));
  }, []);

  // Re-roll signal: bumped each time the user clicks the *current* category
  // label (zodiac or horizon). Drives a brief eyebrow swap to "Drift again ·
  // {category}" so the user sees that the click produced a fresh random pick
  // rather than a no-op. The numeric key on the <p> re-triggers the CSS flash
  // every click; `rerollActive` flips back off after the flash so steady-state
  // copy returns to "Drift · {category}" rather than getting stuck on "again."
  const [rerollPulse, setRerollPulse] = useState(0);
  const [rerollActive, setRerollActive] = useState(false);
  const rerollTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (rerollPulse === 0) return;
    setRerollActive(true);
    if (rerollTimerRef.current !== null) window.clearTimeout(rerollTimerRef.current);
    rerollTimerRef.current = window.setTimeout(() => setRerollActive(false), 1400);
    return () => {
      if (rerollTimerRef.current !== null) window.clearTimeout(rerollTimerRef.current);
    };
  }, [rerollPulse]);

  // Jump straight to a chosen category (clicking a zodiac label).
  const jumpToCategory = useCallback(
    (slug: string) => {
      const c = pickRandomCenter(slug);
      if (c) {
        const isReroll = (center?.category ?? null) === slug;
        setTrail((prev) => {
          const next = [...prev, c.id];
          if (next.length > TRAIL_LIMIT) return next.slice(next.length - TRAIL_LIMIT);
          return next;
        });
        if (c.category) setVisited((cur) => new Set(cur).add(c.category!));
        if (isReroll) setRerollPulse((n) => n + 1);
      }
    },
    [pickRandomCenter, center]
  );

  // Hover state for caption hint.
  const [hoverId, setHoverId] = useState<string | null>(null);
  const hoverImg = hoverId ? imageById.get(hoverId) ?? null : null;
  const hoverPage = hoverImg ? pageBySlug.get(hoverImg.pageSlug) ?? null : null;

  // Center coords — used by both lines and image absolute positioning.
  const cx = stageSize.w / 2;
  const cy = stageSize.h / 2;
  const stageReady = stageSize.w > 0 && stageSize.h > 0;

  // Zodiac geometry: place each of the 10 categories on a ring near the
  // stage edge. Angles step evenly starting from the top (-π/2). The
  // current category gets a highlighted style.
  //
  // Radius is the smaller of:
  //   (a) 0.50 * minDim — the visual target,
  //   (b) the largest radius that keeps a label fully on-screen, given the
  //       stage's actual dimensions and a label-size margin.
  // (b) is what was missing: on wide/short viewports (16:9, ultrawide), the
  // center sits much further from the top edge horizontally than vertically,
  // so 0.50 * minDim — derived from the *short* dimension — could place the
  // top label at or above y=0. Cap separately by half-height and half-width,
  // minus a margin that accounts for the label itself.
  const zodiacRadius = useMemo(() => {
    const w = stageSize.w || 800;
    const h = stageSize.h || 600;
    const minDim = Math.min(w, h);
    // Margin = font ascent (~14px) + a little breathing room. Same value
    // used for both axes; horizontal labels are shorter than they are wide
    // so the height margin governs vertical fit.
    const labelMargin = 22;
    const visualTarget = Math.max(290, minDim * 0.50);
    const maxByHeight = h / 2 - labelMargin;
    const maxByWidth = w / 2 - labelMargin;
    return Math.max(180, Math.min(visualTarget, maxByHeight, maxByWidth));
  }, [stageSize.w, stageSize.h]);

  // Per-label overlap detection: a satellite within ZODIAC_OVERLAP_PX of a
  // label's anchor point fades that label out so the image stays readable.
  // We compute label fade factors here against the resolved inner+outer
  // slots. Recomputed on every layout change — the slot count is small
  // (≤ ~25) so the inner double-loop is cheap.
  //
  // Returns: Map<slug, opacityMultiplier> in [0, 1]. 1 = unobstructed,
  // 0 = directly under an image.
  const zodiacFade = useMemo(() => {
    const out = new Map<string, number>();
    if (!stageReady) return out;
    const allSlots = [...innerSlots, ...outerSlots];
    const N = ZODIAC.length;
    ZODIAC.forEach((z, i) => {
      const angle = -Math.PI / 2 + (i / N) * Math.PI * 2;
      const lx = cx + Math.cos(angle) * zodiacRadius;
      const ly = cy + Math.sin(angle) * zodiacRadius;
      let nearest = Infinity;
      for (const s of allSlots) {
        const sx = cx + Math.cos(s.angle) * s.distance;
        const sy = cy + Math.sin(s.angle) * s.distance;
        const dx = sx - lx;
        const dy = sy - ly;
        const d = Math.hypot(dx, dy);
        // Account for the satellite's own radius — bigger images need a
        // bigger buffer.
        const buffer = s.size / 2 + 18;
        const effective = d - buffer;
        if (effective < nearest) nearest = effective;
      }
      // Map [0, ZODIAC_OVERLAP_PX] → [0, 1] linearly. Below 0 = under the
      // image; above ZODIAC_OVERLAP_PX = full opacity.
      const fade = Math.max(0, Math.min(1, nearest / ZODIAC_OVERLAP_PX));
      out.set(z.slug, fade);
    });
    return out;
  }, [innerSlots, outerSlots, cx, cy, zodiacRadius, stageReady]);

  const zodiacPositions = useMemo(() => {
    const N = ZODIAC.length;
    return ZODIAC.map((z, i) => {
      const angle = -Math.PI / 2 + (i / N) * Math.PI * 2;
      return {
        ...z,
        angle,
        x: cx + Math.cos(angle) * zodiacRadius,
        y: cy + Math.sin(angle) * zodiacRadius,
      };
    });
  }, [cx, cy, zodiacRadius]);

  if (loadError) {
    return (
      <div className="constellation-root">
        <div className="constellation-loading">Couldn’t load the archive. {loadError}</div>
      </div>
    );
  }
  if (!images || !center) {
    return (
      <div className="constellation-root">
        <div ref={stageRef} className="constellation-stage">
          <div className="constellation-loading">Charting the sky…</div>
        </div>
      </div>
    );
  }

  // The category label (constellation title). Falls back to "drift" when the
  // center has no category — rare but possible (homepage-orbit images).
  const titleText = center.categoryLabel ?? centerPage?.categoryLabel ?? "drift";
  const currentCategory = center.category ?? centerPage?.category ?? null;
  const visitedCount = visited.size;

  return (
    <div className="constellation-root">
      <header className="constellation-header">
        {/* The eyebrow doubles as the random-walk affordance:
              · default "Constellation" before the user picks a direction
              · "Drift · {category}" once a category is current
              · briefly flashes "Drift again · {category}" each time the user
                re-rolls the same category (keyed by rerollPulse so the CSS
                animation re-fires on every click).
            This is the quietest possible way to communicate that clicking
            the current category re-rolls the result rather than no-ops. */}
        <p
          key={`eyebrow-${rerollPulse}`}
          className={`constellation-eyebrow ${rerollActive ? "is-rerolling" : ""}`}
        >
          {currentCategory && titleText !== "drift"
            ? rerollActive
              ? <>Drift again · <span className="constellation-eyebrow-cat">{titleText}</span></>
              : <>Drift · <span className="constellation-eyebrow-cat">{titleText}</span></>
            : "Constellation"}
        </p>
        <h1 className="constellation-title">{titleText}</h1>
        {centerPage?.title && (
          <p className="constellation-page">{centerPage.title}</p>
        )}
      </header>

      {/* Horizon panel — top-right. Shows visited progress against the 10
          categories, and acts as a quick-jump nav. The horizon doubles as
          the user's mental map of "what is this archive made of?" */}
      <aside className="constellation-horizon" aria-label="Categories">
        <p className="constellation-horizon-eyebrow">
          Horizon · {visitedCount}/{ZODIAC.length}
        </p>
        <ul className="constellation-horizon-list">
          {ZODIAC.map((z) => {
            const isVisited = visited.has(z.slug);
            const isCurrent = currentCategory === z.slug;
            return (
              <li key={z.slug}>
                <button
                  type="button"
                  className={`constellation-horizon-item ${isVisited ? "is-visited" : ""} ${isCurrent ? "is-current" : ""}`}
                  onClick={() => jumpToCategory(z.slug)}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-label={
                    isCurrent
                      ? `Drift again into ${z.label}`
                      : `Drift into ${z.label}`
                  }
                >
                  <span className="constellation-horizon-tick" aria-hidden="true">
                    {isVisited ? "●" : "○"}
                  </span>
                  <span>{z.label}</span>
                  {isCurrent && (
                    <RerollGlyph />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div ref={stageRef} className="constellation-stage">
        {/* Wait for the stage to have a real measured size before drawing the
            constellation. Without this guard, the center and satellites
            render at left:0/top:0 on the first paint (stageSize starts at
            {0,0}) — visible as everything piling up in the top-left until
            the ResizeObserver fires. */}
        {stageReady && (
        <>
        <svg
          className="constellation-svg"
          viewBox={`0 0 ${Math.max(stageSize.w, 1)} ${Math.max(stageSize.h, 1)}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {/* Faint zodiac ring — a subtle circle so the labels read as part
              of a single structure rather than floating points. */}
          <circle
            cx={cx}
            cy={cy}
            r={zodiacRadius}
            fill="none"
            stroke="rgba(245,245,240,0.06)"
            strokeWidth={1}
          />
          {/* Inner-ring lines: center → inner satellite. A whole branch
              brightens when you hover anywhere along it (the inner satellite
              itself, OR any of its outer offspring) — that's how the user
              learns "these images are connected through this satellite." */}
          {innerSlots.map((s, i) => {
            const sx = cx + Math.cos(s.angle) * s.distance;
            const sy = cy + Math.sin(s.angle) * s.distance;
            const branchActive =
              hoverId === s.img.id ||
              outerSlots.some((o) => o.parentIndex === i && hoverId === o.img.id);
            return (
              <line
                key={`line-${s.img.id}`}
                x1={cx}
                y1={cy}
                x2={sx}
                y2={sy}
                stroke={branchActive ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.18)"}
                strokeWidth={branchActive ? 1.2 : 0.7}
                style={{ transition: `stroke ${TRANSITION_MS}ms ease, stroke-width ${TRANSITION_MS}ms ease` }}
              />
            );
          })}
          {/* Outer-ring lines: inner satellite → outer (second-degree) image.
              Drawn fainter than inner lines so the eye reads the inner ring
              as the primary structure and the outer as a halo. */}
          {outerSlots.map((s) => {
            const parent = innerSlots[s.parentIndex];
            if (!parent) return null;
            const px = cx + Math.cos(parent.angle) * parent.distance;
            const py = cy + Math.sin(parent.angle) * parent.distance;
            const sx = cx + Math.cos(s.angle) * s.distance;
            const sy = cy + Math.sin(s.angle) * s.distance;
            const branchActive =
              hoverId === s.img.id ||
              hoverId === parent.img.id ||
              outerSlots.some((o) => o.parentIndex === s.parentIndex && hoverId === o.img.id);
            return (
              <line
                key={`outline-${s.img.id}`}
                x1={px}
                y1={py}
                x2={sx}
                y2={sy}
                stroke={branchActive ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.09)"}
                strokeWidth={branchActive ? 0.9 : 0.5}
                style={{ transition: `stroke ${TRANSITION_MS}ms ease, stroke-width ${TRANSITION_MS}ms ease` }}
              />
            );
          })}
        </svg>

        {/* Zodiac labels around the stage edge. Each is a button that
            re-rolls the constellation into that category. The current
            category is highlighted. Labels fade when satellites overlap
            them so the imagery stays readable.

            We always pass through *some* opacity (min ~0.18) for the current
            category and visited categories — they're high-signal IA hints,
            so even a totally-overlapped one stays minimally visible.
            Unvisited+un-current labels can fade all the way out since
            they're the most expendable. */}
        {zodiacPositions.map((z) => {
          const isCurrent = currentCategory === z.slug;
          const isVisited = visited.has(z.slug);
          const fade = zodiacFade.get(z.slug) ?? 1;
          const minOpacity = isCurrent ? 0.35 : isVisited ? 0.2 : 0;
          const opacity = Math.max(minOpacity, fade);
          return (
            <button
              key={z.slug}
              type="button"
              className={`constellation-zodiac ${isCurrent ? "is-current" : ""} ${isVisited ? "is-visited" : ""}`}
              style={{
                left: z.x,
                top: z.y,
                opacity,
                transition: "opacity 320ms ease, color 220ms ease, letter-spacing 220ms ease",
              }}
              onClick={() => jumpToCategory(z.slug)}
              aria-label={
                isCurrent
                  ? `Drift again into ${z.label}`
                  : `Drift into ${z.label}`
              }
              aria-current={isCurrent ? "true" : undefined}
            >
              {z.label}
              {/* Re-roll glyph — only on the current category; revealed on
                  hover/focus via CSS. Marks this click as "shuffle" rather
                  than "navigate." */}
              {isCurrent && (
                <RerollGlyph />
              )}
            </button>
          );
        })}

        {/* Traveler — the *incoming* image. Mounts at the clicked
            satellite's old slot at satellite-size, then animates to the
            center position at center-size. The actual center element is
            held transparent for the duration so the traveler IS the visible
            center until it settles. Counterpart to the echo (outgoing). */}
        {traveler && (() => {
          const tImg = imageById.get(traveler.id);
          if (!tImg) return null;
          const fromX = cx + Math.cos(traveler.fromAngle) * traveler.fromDistance;
          const fromY = cy + Math.sin(traveler.fromAngle) * traveler.fromDistance;
          const isEnter = traveler.phase === "enter";
          // Enter: at old satellite slot, satellite size, dim. Leave:
          // animates to center at center size, fully opaque. The traveler
          // unmounts the moment it arrives — at the same instant the real
          // center is revealed with no fade, so the swap is invisible
          // (same image, same position, same size).
          const targetSize = 200; // matches --frame-size in CSS
          return (
            <div
              key={`traveler-${traveler.id}`}
              className="constellation-traveler"
              style={{
                left: isEnter ? fromX : cx,
                top: isEnter ? fromY : cy,
                width: isEnter ? traveler.fromSize : targetSize,
                height: isEnter ? traveler.fromSize : targetSize,
                opacity: isEnter ? 0.85 : 1,
                transition: `left ${TRAVELER_MS}ms ${TRAVEL_EASING}, top ${TRAVELER_MS}ms ${TRAVEL_EASING}, width ${TRAVELER_MS}ms ${TRAVEL_EASING}, height ${TRAVELER_MS}ms ${TRAVEL_EASING}, opacity ${TRAVELER_MS}ms ease-out`,
              }}
              aria-hidden="true"
            >
              <img src={tImg.src} alt="" />
            </div>
          );
        })()}

        {/* Center image — the whole element (image + caption block) is one
            link to the page. The visible label below is the page title and,
            when present, the figure caption (which usually carries the
            artist name in the legacy data). No "Open page →" chrome — the
            click target is obvious from the cursor and the hover style. */}
        <a
          href={`${basePath}${center.pageSlug}`}
          className="constellation-center"
          style={{
            left: cx,
            top: cy,
            // The center is held invisible while the traveler is in
            // flight, then revealed instantly (no opacity transition) at
            // the moment the traveler unmounts — both show the same image
            // at the same position and size, so the swap is invisible.
            opacity: centerHidden ? 0 : 1,
            transition: `left ${TRANSITION_MS}ms ${TRAVEL_EASING}, top ${TRANSITION_MS}ms ${TRAVEL_EASING}`,
          }}
          aria-label={`Open page: ${center.pageTitle}${center.caption ? ` — ${center.caption}` : ""}`}
        >
          <div className="constellation-center-frame">
            <img src={center.src} alt={center.alt || center.caption || center.pageTitle} />
          </div>
          <div className="constellation-center-info">
            <p className="constellation-center-info-title">{center.pageTitle}</p>
            {center.caption && (
              <p className="constellation-center-info-caption">{center.caption}</p>
            )}
          </div>
        </a>

        {/* Inner-ring satellites — the primary "neighborhood" set. */}
        {innerSlots.map((s, i) => {
          const sx = cx + Math.cos(s.angle) * s.distance;
          const sy = cy + Math.sin(s.angle) * s.distance;
          const isHovered = hoverId === s.img.id;
          return (
            <button
              // Key includes centerId so React unmounts the old ring and
              // mounts a new one — this lets each new satellite play its
              // CSS bloom-in animation from scratch instead of just sliding.
              key={`${centerId}-${s.img.id}`}
              type="button"
              className={`constellation-satellite is-blooming ${isHovered ? "is-hover" : ""}`}
              style={{
                left: sx,
                top: sy,
                width: s.size,
                height: s.size,
                animationDelay: `${i * SATELLITE_STAGGER_MS}ms`,
                animationDuration: `${SATELLITE_FADE_MS}ms`,
                transition: `left ${TRANSITION_MS}ms ${TRAVEL_EASING}, top ${TRANSITION_MS}ms ${TRAVEL_EASING}, transform 240ms ease, border-color 240ms ease`,
              }}
              onClick={() => travelTo(s.img.id, s)}
              onMouseEnter={() => setHoverId(s.img.id)}
              onMouseLeave={() => setHoverId((cur) => (cur === s.img.id ? null : cur))}
              onFocus={() => setHoverId(s.img.id)}
              onBlur={() => setHoverId((cur) => (cur === s.img.id ? null : cur))}
              aria-label={`Travel to ${s.img.pageTitle}${s.img.caption ? ` — ${s.img.caption}` : ""}`}
            >
              <img src={s.img.src} alt={s.img.alt || s.img.caption || s.img.pageTitle} loading="lazy" />
            </button>
          );
        })}

        {/* Outer-ring satellites — second-degree neighbors, smaller and
            dimmer until hovered. Their job is to *imply* unseen depth: the
            user immediately sees that the constellation keeps going. */}
        {outerSlots.map((s, i) => {
          const sx = cx + Math.cos(s.angle) * s.distance;
          const sy = cy + Math.sin(s.angle) * s.distance;
          const isHovered = hoverId === s.img.id;
          const parentHovered = hoverId === innerSlots[s.parentIndex]?.img.id;
          // Outer satellites fade in *after* their parent inner satellite —
          // adds a brief depth-cue beat where the inner ring blooms first
          // and the outer halo follows.
          const outerDelay = (innerSlots.length + i) * SATELLITE_STAGGER_MS;
          return (
            <button
              key={`${centerId}-out-${s.img.id}`}
              type="button"
              className={`constellation-satellite is-outer is-blooming ${isHovered ? "is-hover" : ""} ${parentHovered ? "is-branch-active" : ""}`}
              style={{
                left: sx,
                top: sy,
                width: s.size,
                height: s.size,
                animationDelay: `${outerDelay}ms`,
                animationDuration: `${SATELLITE_FADE_MS}ms`,
                transition: `left ${TRANSITION_MS}ms ${TRAVEL_EASING}, top ${TRANSITION_MS}ms ${TRAVEL_EASING}, transform 240ms ease, border-color 240ms ease`,
              }}
              onClick={() => travelTo(s.img.id, s)}
              onMouseEnter={() => setHoverId(s.img.id)}
              onMouseLeave={() => setHoverId((cur) => (cur === s.img.id ? null : cur))}
              onFocus={() => setHoverId(s.img.id)}
              onBlur={() => setHoverId((cur) => (cur === s.img.id ? null : cur))}
              aria-label={`Travel to ${s.img.pageTitle}${s.img.caption ? ` — ${s.img.caption}` : ""}`}
            >
              <img src={s.img.src} alt={s.img.alt || s.img.caption || s.img.pageTitle} loading="lazy" />
            </button>
          );
        })}

        {/* Hover caption — now also surfaces the page blurb so users can
            judge a destination without having to commit to traveling. */}
        {hoverImg && (
          <div className="constellation-hover">
            <p className="constellation-hover-page">{hoverImg.pageTitle}</p>
            {hoverImg.caption && <p className="constellation-hover-cap">{hoverImg.caption}</p>}
            {hoverPage?.blurb && hoverPage.blurb !== hoverImg.caption && (
              <p className="constellation-hover-blurb">{hoverPage.blurb}</p>
            )}
          </div>
        )}
        </>
        )}
      </div>

      <footer className="constellation-footer">
        <div className="constellation-trail" aria-label="Travel history">
          {trail.map((id, i) => {
            const img = imageById.get(id);
            const isCurrent = i === trail.length - 1;
            return (
              <button
                key={`${id}-${i}`}
                type="button"
                className={`constellation-trail-dot ${isCurrent ? "is-current" : ""}`}
                onClick={() => trailJump(i)}
                aria-current={isCurrent ? "true" : undefined}
                aria-label={img ? `Step ${i + 1}: ${img.pageTitle}` : `Step ${i + 1}`}
                title={img?.pageTitle}
              />
            );
          })}
        </div>
      </footer>
    </div>
  );
}
