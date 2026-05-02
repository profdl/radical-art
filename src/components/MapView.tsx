import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

interface RawNode {
  id: string;
  title: string;
  blurb?: string;
  degree: number;
  category: string | null;
  isCategoryRoot: boolean;
}
interface RawLink {
  source: string;
  target: string;
}
interface CategoryMeta {
  id: string;
  label: string;
}
interface Graph {
  nodes: RawNode[];
  links: RawLink[];
  categories: CategoryMeta[];
}

interface PlacedNode extends RawNode {
  x: number;
  y: number;
  /** Marker radius (small — labels do the heavy visual work). */
  r: number;
  /** True for the synthesized "category" presentation when collapsed. */
  collapsed: boolean;
}

interface PlacedLink {
  source: string;
  target: string;
  weight: number;
}

// ---- visual constants -------------------------------------------------------
// Markers are deliberately small. The label is the primary visual; the dot is
// a hit target and a faint locator. Keep these in sync with the label rules
// in draw().
const MARKER_LEAF = 2.6;
const MARKER_ANCHOR = 4.2; // homepage hub + category roots (collapsed or expanded)

const FONT_LEAF = "500 13px \"IBM Plex Sans\", sans-serif";
const FONT_ANCHOR = "600 15px \"IBM Plex Sans\", sans-serif"; // homepage + category roots

// Layout — force-directed simulation, seeded from a category wheel. The wheel
// gives each category a stable angular slot around the homepage hub; a weak
// radial/tangential anchor keeps that arrangement recognizable. Within each
// category, children are seeded on a sector arc and then settle via charge +
// link forces, so connected pages cluster while collision keeps markers and
// labels from piling up.
const WHEEL_RATIO = 0.26; // wheel radius as fraction of min(width, height)
const ARC_INNER_GAP = 40; // px between root and start of children arc
const ARC_RADIAL_STEP = 38; // px between concentric children rings
const ARC_TANGENT_STEP = 60; // px between adjacent children on a ring

// Force-simulation tuning. Values were chosen so the wheel arrangement stays
// recognizable (categories near their starting angle) while connected children
// visibly pull together. SIM_TICKS is high enough for dense clusters
// (Nothing has 79 members) to settle without cooking the main thread on every
// expand/collapse — the simulation runs synchronously inside useMemo.
const SIM_TICKS = 280;
const SIM_ALPHA_DECAY = 1 - Math.pow(0.001, 1 / SIM_TICKS);
const CHARGE_LEAF = -110;
const CHARGE_CATEGORY = -260;
const CHARGE_HOMEPAGE = -420;
const COLLIDE_PADDING = 12; // extra space around each node's collision radius (label headroom)
const LINK_DISTANCE = 70;
const LINK_STRENGTH = 0.18;
const RADIAL_STRENGTH_CATEGORY = 0.55; // strong: keeps the wheel readable
const RADIAL_STRENGTH_LEAF = 0.12; // weak: leaves drift toward connections

export default function MapView() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drawRef = useRef<() => void>(() => {});

  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Refs the imperative draw loop reads.
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const queryRef = useRef<string>("");
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  useEffect(() => { hoverRef.current = hoverId; }, [hoverId]);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  useEffect(() => { queryRef.current = query.trim().toLowerCase(); }, [query]);

  // Canvas size, kept in a ref so draw() can read it without re-binding.
  const sizeRef = useRef({ w: 0, h: 0 });
  // Drawn label rects, in world coordinates. Updated each draw(); read by
  // hitTest so clicking a label selects its node.
  const labelHitsRef = useRef<{ id: string; rect: { x0: number; y0: number; x1: number; y1: number } }[]>([]);
  // The d3-zoom behavior, exposed so we can programmatically pan/zoom
  // (auto-center after expand/collapse).
  const zoomBehaviorRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  // Latest layout, exposed for hit-testing inside long-lived pointer handlers
  // that don't re-bind on every layout change.
  const layoutRef = useRef<{
    placed: PlacedNode[];
    links: PlacedLink[];
    viewNeighbors: Map<string, Set<string>>;
    byId: Map<string, PlacedNode>;
  }>({ placed: [], links: [], viewNeighbors: new Map(), byId: new Map() });
  const handleNodeClickRef = useRef<(n: PlacedNode | null) => void>(() => {});
  // Bumped whenever the *content* changes (expand/collapse, graph load) — used
  // to trigger an auto-center. Plain resizes do NOT bump this, so panning the
  // viewport survives a window resize or panel toggle.
  const recenterTokenRef = useRef(0);
  const lastRecenterTokenRef = useRef(-1);

  // Whenever the *content* set changes (graph load, expand/collapse), schedule
  // an auto-center by bumping the token. We use useMemo (not useEffect) so the
  // bump is visible to the draw effect on the same render — the draw effect
  // checks the token and applies the new transform synchronously, before the
  // first paint with the new layout. That avoids the one-frame flash where
  // the new layout is drawn at the *previous* transform (which made expanding
  // "Nothing" look like the map disappeared while it loaded).
  useMemo(() => { recenterTokenRef.current += 1; }, [graph, expanded]);

  // ---- load graph.json -----------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}graph.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`graph.json: ${r.status}`);
        return r.json();
      })
      .then((g: Graph) => { if (!cancelled) setGraph(g); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);

  // ---- raw graph indexes ---------------------------------------------------
  const indexes = useMemo(() => {
    if (!graph) {
      return {
        byId: new Map<string, RawNode>(),
        rawNeighbors: new Map<string, Set<string>>(),
        membersOf: new Map<string, RawNode[]>(),
        uncategorized: [] as RawNode[],
      };
    }
    const byId = new Map<string, RawNode>();
    for (const n of graph.nodes) byId.set(n.id, n);

    const rawNeighbors = new Map<string, Set<string>>();
    for (const n of graph.nodes) rawNeighbors.set(n.id, new Set());
    for (const l of graph.links) {
      rawNeighbors.get(l.source)?.add(l.target);
      rawNeighbors.get(l.target)?.add(l.source);
    }

    // category id -> non-root members (sorted: highest degree first, then alpha)
    const membersOf = new Map<string, RawNode[]>();
    for (const c of graph.categories) membersOf.set(c.id, []);
    for (const n of graph.nodes) {
      if (!n.category || n.isCategoryRoot) continue;
      const arr = membersOf.get(n.category);
      if (arr) arr.push(n);
    }
    for (const arr of membersOf.values()) {
      arr.sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title));
    }

    // pages with no category (homepage + the 4 root-level essays)
    const uncategorized = graph.nodes.filter((n) => n.category === null);

    return { byId, rawNeighbors, membersOf, uncategorized };
  }, [graph]);

  // We re-run layout on resize too. The bump counter goes into the layout
  // memo's deps so it actually re-computes. (Initial mount: sizeRef is 0/0
  // until the effect runs resize(); we bump once there to force a recompute
  // off the first real measurement.)
  const [resizeBump, setResizeBump] = useState(0);

  // ---- layout (deterministic, pure function of size + expanded) ------------
  const layout = useMemo(() => {
    const placed: PlacedNode[] = [];
    const links: PlacedLink[] = [];
    const viewNeighbors = new Map<string, Set<string>>();
    if (!graph) return { placed, links, viewNeighbors, byId: new Map<string, PlacedNode>() };

    const { w, h } = sizeRef.current;
    const cx = (w || 1000) / 2;
    const cy = (h || 700) / 2;
    const wheelR = Math.min(w || 1000, h || 700) * WHEEL_RATIO;

    const N = graph.categories.length;

    // Per-node anchor info we'll feed into the force simulation. We build a
    // seeded position (from the wheel layout) AND a radial target so a soft
    // forceRadial can keep each cluster recognizable — without rigid pinning,
    // connected nodes can still pull on each other.
    type SimNode = SimulationNodeDatum & {
      id: string;
      r: number; // marker radius
      collideR: number; // simulation collision radius
      anchorR: number; // target distance from center
      anchorStrength: number; // weight for the radial anchor force
      seedX: number;
      seedY: number;
      isHomepage: boolean;
      isCategoryRoot: boolean;
      collapsed: boolean;
      categorySeedAngle: number | null; // angular slot for soft tangential anchoring
    };
    const sims = new Map<string, SimNode>();
    // Estimate label footprint without measuring on a canvas (we don't have
    // one in scope here, and DOM measureText calls in a layout memo would be
    // expensive). Average glyph widths for IBM Plex Sans at the sizes we use:
    //   leaf 13px ~ 6.6px/char, category/homepage 15px ~ 7.6px/char.
    // The collision radius is sized so a label drawn beside the node (the
    // common placement) doesn't intrude into a neighbor's label region.
    const estimateLabelWidth = (text: string, fontPx: number, weight: number): number => {
      const perChar = fontPx <= 13 ? 6.6 : 7.6;
      // Bold/semibold widens a touch; the category and homepage fonts are 600.
      const weightMul = weight >= 600 ? 1.05 : 1.0;
      return text.length * perChar * weightMul;
    };
    const addSim = (
      id: string,
      r: number,
      seedX: number,
      seedY: number,
      anchorR: number,
      anchorStrength: number,
      flags: { isHomepage?: boolean; isCategoryRoot?: boolean; collapsed?: boolean; angle?: number | null } = {},
    ) => {
      const raw = indexes.byId.get(id);
      const title = raw?.title ?? id;
      const isBigLabel = !!(flags.isCategoryRoot || flags.isHomepage);
      const labelW = estimateLabelWidth(title, isBigLabel ? 15 : 13, isBigLabel ? 600 : 500);
      const labelH = isBigLabel ? 20 : 17;
      // Collision radius reserves a circular zone large enough that a label
      // placed beside this node won't crash into a neighbor's marker or
      // label. Half the label width + the marker radius approximates a
      // worst-case footprint when the label sits flush against the marker.
      // We add a small constant pad so cluttered clusters still breathe.
      const labelFootprint = Math.hypot(labelW * 0.5 + r, labelH * 0.5);
      const collideR = Math.max(
        r + COLLIDE_PADDING + (isBigLabel ? 14 : 6),
        labelFootprint + (isBigLabel ? 6 : 4),
      );
      sims.set(id, {
        id,
        r,
        collideR,
        anchorR,
        anchorStrength,
        seedX,
        seedY,
        x: seedX,
        y: seedY,
        isHomepage: !!flags.isHomepage,
        isCategoryRoot: !!flags.isCategoryRoot,
        collapsed: !!flags.collapsed,
        categorySeedAngle: flags.angle ?? null,
      });
    };

    // Homepage hub: pinned at center via fx/fy below.
    if (indexes.byId.get("index")) {
      addSim("index", MARKER_ANCHOR, cx, cy, 0, 0, { isHomepage: true });
    }

    // Uncategorized essays orbit the hub near the top. Soft anchor at a small
    // radius so they cluster near the homepage but can still spread.
    const otherUncat = indexes.uncategorized.filter((n) => n.id !== "index");
    if (otherUncat.length > 0) {
      const ringR = wheelR * 0.45;
      otherUncat.forEach((n, i) => {
        const spread = (i - (otherUncat.length - 1) / 2) * 0.45;
        const angle = -Math.PI / 2 + spread;
        addSim(n.id, MARKER_LEAF, cx + Math.cos(angle) * ringR, cy + Math.sin(angle) * ringR, ringR, RADIAL_STRENGTH_LEAF, { angle });
      });
    }

    // Categories — strong radial anchor so the wheel stays readable.
    const rootAngle = new Map<string, number>();
    graph.categories.forEach((c, i) => {
      const angle = -Math.PI / 2 + (i / Math.max(N, 1)) * Math.PI * 2;
      rootAngle.set(c.id, angle);
      if (!indexes.byId.get(c.id)) return;
      const isExpanded = expanded.has(c.id);
      addSim(
        c.id,
        MARKER_ANCHOR,
        cx + Math.cos(angle) * wheelR,
        cy + Math.sin(angle) * wheelR,
        wheelR,
        RADIAL_STRENGTH_CATEGORY,
        { isCategoryRoot: true, collapsed: !isExpanded, angle },
      );
    });

    // Children of expanded categories — seeded on the sector arc, then let
    // the simulation pull them toward their actual connections. The radial
    // anchor is weak, so links across categories can visibly tug a node out
    // of its home arc when warranted.
    const sectorHalf = Math.PI / Math.max(N, 1) * 0.92;
    for (const c of graph.categories) {
      if (!expanded.has(c.id)) continue;
      const members = indexes.membersOf.get(c.id) ?? [];
      if (members.length === 0) continue;
      const angle = rootAngle.get(c.id) ?? 0;

      let seededCount = 0;
      let ring = 0;
      while (seededCount < members.length) {
        const ringR = wheelR + ARC_INNER_GAP + ring * ARC_RADIAL_STEP;
        const arcLen = sectorHalf * 2 * ringR;
        const fit = Math.max(1, Math.floor(arcLen / ARC_TANGENT_STEP));
        const remaining = members.length - seededCount;
        const onThisRing = Math.min(fit, remaining);
        for (let i = 0; i < onThisRing; i++) {
          const m = members[seededCount + i];
          const t = onThisRing === 1 ? 0.5 : i / (onThisRing - 1);
          const a = angle - sectorHalf + t * sectorHalf * 2;
          addSim(
            m.id,
            MARKER_LEAF,
            cx + Math.cos(a) * ringR,
            cy + Math.sin(a) * ringR,
            ringR,
            RADIAL_STRENGTH_LEAF,
            { angle: a },
          );
        }
        seededCount += onThisRing;
        ring++;
      }
    }

    // Build sim links from raw graph edges, but only between visible nodes.
    // We'll later (after the simulation) collapse edges to category roots for
    // the *rendered* link aggregation; the simulation uses the per-edge view.
    type SimLink = SimulationLinkDatum<SimNode> & { source: string; target: string };
    const simLinks: SimLink[] = [];
    for (const l of graph.links) {
      if (sims.has(l.source) && sims.has(l.target)) {
        simLinks.push({ source: l.source, target: l.target });
      } else {
        // Edge from/to a hidden node: route to its category root if visible,
        // so collapsed clusters still feel "pulled" by their external links.
        const a = sims.has(l.source)
          ? l.source
          : indexes.byId.get(l.source)?.category ?? null;
        const b = sims.has(l.target)
          ? l.target
          : indexes.byId.get(l.target)?.category ?? null;
        if (a && b && a !== b && sims.has(a) && sims.has(b)) {
          simLinks.push({ source: a, target: b });
        }
      }
    }

    const simNodes = Array.from(sims.values());

    // Pin the homepage at the center. Pinning the categories instead of using
    // a strong radial force was tempting, but radial-only lets the wheel
    // breathe a little when expanded clusters tug their parent off-axis,
    // which reads as "force-directed" rather than "rigid wheel".
    const homepageSim = sims.get("index");
    if (homepageSim) {
      homepageSim.fx = cx;
      homepageSim.fy = cy;
    }

    if (simNodes.length > 0) {
      const sim = forceSimulation(simNodes)
        .force(
          "charge",
          forceManyBody<SimNode>().strength((n) =>
            n.isHomepage ? CHARGE_HOMEPAGE : n.isCategoryRoot ? CHARGE_CATEGORY : CHARGE_LEAF,
          ),
        )
        .force(
          "link",
          forceLink<SimNode, SimLink>(simLinks)
            .id((n) => n.id)
            .distance(LINK_DISTANCE)
            .strength(LINK_STRENGTH),
        )
        .force(
          "collide",
          // Strict collision is the legibility guarantee: full strength + many
          // iterations so dense clusters (Nothing has 79 members) actually
          // resolve their overlaps within SIM_TICKS rather than oscillating.
          forceCollide<SimNode>().radius((n) => n.collideR).strength(1).iterations(4),
        )
        .force("center", forceCenter(cx, cy).strength(0.02))
        // Soft radial anchor by node — keeps the wheel arrangement legible.
        .force(
          "radial",
          forceRadial<SimNode>(
            (n) => n.anchorR,
            cx,
            cy,
          ).strength((n) => n.anchorStrength),
        )
        // Soft tangential anchor: pulls each category toward its angular
        // slot, so e.g. "Concept" stays near the top even when its leaves
        // tug it sideways. Implemented as forceX/forceY toward the seed
        // position, scoped to nodes with a known angular slot.
        .force(
          "x",
          forceX<SimNode>((n) => (n.categorySeedAngle != null ? n.seedX : cx)).strength((n) =>
            n.isCategoryRoot ? 0.08 : 0.0,
          ),
        )
        .force(
          "y",
          forceY<SimNode>((n) => (n.categorySeedAngle != null ? n.seedY : cy)).strength((n) =>
            n.isCategoryRoot ? 0.08 : 0.0,
          ),
        )
        .alpha(1)
        .alphaDecay(SIM_ALPHA_DECAY)
        .stop();
      for (let i = 0; i < SIM_TICKS; i++) sim.tick();
    }

    // Translate simulation results into the PlacedNode list the renderer
    // expects. Order matters for layered drawing only insofar as it affects
    // hit-testing tie-breaks — keep homepage first, then categories, then
    // leaves, matching the previous code.
    const emitPlaced = (id: string) => {
      const sn = sims.get(id);
      const raw = indexes.byId.get(id);
      if (!sn || !raw) return;
      placed.push({
        ...raw,
        x: sn.x ?? sn.seedX,
        y: sn.y ?? sn.seedY,
        r: sn.r,
        collapsed: sn.collapsed,
      });
    };
    emitPlaced("index");
    for (const n of otherUncat) emitPlaced(n.id);
    for (const c of graph.categories) emitPlaced(c.id);
    for (const c of graph.categories) {
      if (!expanded.has(c.id)) continue;
      const members = indexes.membersOf.get(c.id) ?? [];
      for (const m of members) emitPlaced(m.id);
    }

    const byId = new Map<string, PlacedNode>();
    for (const p of placed) byId.set(p.id, p);

    // Aggregated, deduped links — only between visible nodes. Leaves in a
    // collapsed cluster collapse to the cluster root for edge purposes.
    const visible = new Set(byId.keys());
    const viewIdFor = (rawId: string): string | null => {
      const n = indexes.byId.get(rawId);
      if (!n) return null;
      if (visible.has(n.id)) return n.id;
      // not directly visible → fall back to its category root
      if (n.category) return n.category;
      return null;
    };
    const edgeWeight = new Map<string, number>();
    const edgeEndpoints = new Map<string, [string, string]>();
    for (const l of graph.links) {
      const a = viewIdFor(l.source);
      const b = viewIdFor(l.target);
      if (!a || !b || a === b) continue;
      const [s, t] = a < b ? [a, b] : [b, a];
      const key = `${s}||${t}`;
      edgeWeight.set(key, (edgeWeight.get(key) ?? 0) + 1);
      if (!edgeEndpoints.has(key)) edgeEndpoints.set(key, [s, t]);
    }
    for (const [key, weight] of edgeWeight) {
      const [s, t] = edgeEndpoints.get(key)!;
      links.push({ source: s, target: t, weight });
    }

    for (const id of byId.keys()) viewNeighbors.set(id, new Set());
    for (const l of links) {
      viewNeighbors.get(l.source)?.add(l.target);
      viewNeighbors.get(l.target)?.add(l.source);
    }

    return { placed, links, viewNeighbors, byId };
    // resizeBump is read so this memo recomputes when canvas size changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, expanded, indexes, resizeBump]);

  // ---- mount-once setup: canvas size, pointer listeners, zoom -------------
  // Kept separate from the per-layout draw effect: expanding/collapsing a
  // category should NOT tear down ResizeObserver, re-bind pointer listeners,
  // or reset the d3-zoom behavior on the canvas. Without this split, every
  // expand triggered a full setup/teardown cycle (visible as lag), and the
  // initial mount required two cycles to settle, which manifested as the map
  // appearing blank until the user clicked.
  useEffect(() => {
    if (!canvasRef.current || !wrapRef.current) return;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      sizeRef.current = { w, h };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    const wasZero = sizeRef.current.w === 0 || sizeRef.current.h === 0;
    resize();
    if (wasZero && sizeRef.current.w > 0 && sizeRef.current.h > 0) {
      setResizeBump((b) => b + 1);
    }
    const ro = new ResizeObserver(() => {
      const prev = sizeRef.current;
      resize();
      if (prev.w !== sizeRef.current.w || prev.h !== sizeRef.current.h) {
        setResizeBump((b) => b + 1);
      }
    });
    ro.observe(wrap);

    const screenToWorld = (cx: number, cy: number) => {
      const rect = canvas.getBoundingClientRect();
      const sx = cx - rect.left;
      const sy = cy - rect.top;
      const tr = transformRef.current;
      return { x: (sx - tr.x) / tr.k, y: (sy - tr.y) / tr.k };
    };
    const hitTest = (cx: number, cy: number): PlacedNode | null => {
      const { x, y } = screenToWorld(cx, cy);
      const labels = labelHitsRef.current;
      for (const l of labels) {
        if (x >= l.rect.x0 && x <= l.rect.x1 && y >= l.rect.y0 && y <= l.rect.y1) {
          const node = layoutRef.current.byId.get(l.id);
          if (node) return node;
        }
      }
      let best: PlacedNode | null = null;
      let bestD2 = Infinity;
      for (const n of layoutRef.current.placed) {
        const dx = n.x - x;
        const dy = n.y - y;
        const d2 = dx * dx + dy * dy;
        const r = Math.max(n.r + 6 / transformRef.current.k, 9 / transformRef.current.k);
        if (d2 < r * r && d2 < bestD2) {
          best = n;
          bestD2 = d2;
        }
      }
      return best;
    };

    const onMove = (e: PointerEvent) => {
      const hit = hitTest(e.clientX, e.clientY);
      const id = hit?.id ?? null;
      if (id !== hoverRef.current) {
        setHoverId(id);
        drawRef.current();
      }
      canvas.style.cursor = hit ? "pointer" : "grab";
    };
    let downAt: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const onUp = (e: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      const dt = performance.now() - downAt.t;
      downAt = null;
      if (moved > 4 || dt > 500) return;
      const hit = hitTest(e.clientX, e.clientY);
      handleNodeClickRef.current(hit);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);

    const zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown> = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.3, 6])
      .on("zoom", (e) => {
        transformRef.current = { x: e.transform.x, y: e.transform.y, k: e.transform.k };
        drawRef.current();
      });
    select(canvas).call(zoomBehavior);
    zoomBehaviorRef.current = zoomBehavior;

    return () => {
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
    };
  }, []);

  // ---- per-layout draw: rebuilds the draw closure and repaints -----------
  useEffect(() => {
    if (!graph || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    layoutRef.current = layout;

    const ctx = canvas.getContext("2d")!;

    const draw = () => {
      const { w, h } = sizeRef.current;
      const t = transformRef.current;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(t.x, t.y);
      ctx.scale(t.k, t.k);

      const selected = selectedRef.current;
      const hover = hoverRef.current;
      // Hover wins over selection: hovering must always preview what a click
      // would focus on, even when a node is already selected (the side panel
      // tracks selection independently).
      const focusId = hover ?? selected;
      const q = queryRef.current;
      const matchSet = q
        ? new Set(layout.placed.filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).map((n) => n.id))
        : null;
      const focusSet = focusId ? layout.viewNeighbors.get(focusId) : null;

      // ---- edges (very faint at rest; reveal on focus / match) -----------
      const hasFocus = !!focusId || !!matchSet;
      for (const l of layout.links) {
        const s = layout.byId.get(l.source);
        const tg = layout.byId.get(l.target);
        if (!s || !tg) continue;
        const inFocus = !!(focusId && (s.id === focusId || tg.id === focusId));
        const inMatch = matchSet ? matchSet.has(s.id) || matchSet.has(tg.id) : false;
        const reveal = inFocus || inMatch;
        const baseWidth = 0.5 + Math.min(1.6, Math.sqrt(l.weight) * 0.35);
        ctx.lineWidth = baseWidth / t.k;
        if (reveal) {
          ctx.strokeStyle = "rgba(17,17,17,0.22)";
        } else if (hasFocus) {
          ctx.strokeStyle = "rgba(17,17,17,0.008)";
        } else {
          ctx.strokeStyle = "rgba(17,17,17,0.012)";
        }
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(tg.x, tg.y);
        ctx.stroke();
      }

      // ---- (1) compute marker rects (used both for drawing and as forbidden
      //          zones for label placement; also used for hit-testing). -----
      type Rect = { x0: number; y0: number; x1: number; y1: number };
      const markerRectFor = (n: PlacedNode): Rect => {
        // Slightly larger than the visible disc so a label sitting flush
        // against the marker still reads as separate.
        const pad = 2 / t.k;
        return {
          x0: n.x - n.r - pad,
          y0: n.y - n.r - pad,
          x1: n.x + n.r + pad,
          y1: n.y + n.r + pad,
        };
      };
      const markerRects: Rect[] = layout.placed.map(markerRectFor);

      // ---- (2) markers ---------------------------------------------------
      for (const n of layout.placed) {
        const isFocus = focusId === n.id;
        const isSelected = selected === n.id;
        const isNeighbor = !!(focusSet && focusSet.has(n.id));
        const inMatch = matchSet ? matchSet.has(n.id) : true;
        const dim = (focusId && !isFocus && !isNeighbor) || !inMatch;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        if (isFocus || isSelected) {
          ctx.fillStyle = "#111";
          ctx.fill();
        } else if (n.collapsed || n.isCategoryRoot || n.id === "index") {
          ctx.fillStyle = dim ? "rgba(17,17,17,0.3)" : "#111";
          ctx.fill();
        } else {
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.lineWidth = 1 / t.k;
          ctx.strokeStyle = dim ? "rgba(17,17,17,0.2)" : "rgba(17,17,17,0.55)";
          ctx.stroke();
        }
        if (isSelected) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 5 / t.k, 0, Math.PI * 2);
          ctx.lineWidth = 1.25 / t.k;
          ctx.strokeStyle = "rgba(17,17,17,0.55)";
          ctx.stroke();
        }
      }

      // ---- (3) build label specs ----------------------------------------
      ctx.textBaseline = "middle";
      type LabelSpec = {
        n: PlacedNode;
        priority: number;
        font: string;
        emphasis: "anchor" | "focus" | "match" | "neighbor";
      };
      const specs: LabelSpec[] = [];
      for (const n of layout.placed) {
        const isHomepage = n.id === "index";
        const isAnchor = n.collapsed || isHomepage || (n.isCategoryRoot && expanded.has(n.category!));
        if (isAnchor) {
          specs.push({
            n,
            priority: 100 + (n.collapsed ? 0 : 1),
            font: FONT_ANCHOR,
            emphasis: "anchor",
          });
          continue;
        }
        const isFocus = focusId === n.id;
        const isNeighbor = !!(focusSet && focusSet.has(n.id));
        const inMatch = matchSet ? matchSet.has(n.id) : false;
        if (isFocus) {
          specs.push({ n, priority: 80, font: FONT_LEAF, emphasis: "focus" });
        } else if (inMatch) {
          specs.push({ n, priority: 50 + Math.min(n.degree, 30), font: FONT_LEAF, emphasis: "match" });
        } else if (isNeighbor) {
          specs.push({ n, priority: 20 + Math.min(n.degree, 30), font: FONT_LEAF, emphasis: "neighbor" });
        }
      }
      // Idle: also label expanded-cluster members and uncategorized essays.
      if (!hasFocus) {
        for (const n of layout.placed) {
          if (n.isCategoryRoot) continue;
          if (n.id === "index") continue;
          if (!n.category) continue;
          if (!expanded.has(n.category)) continue;
          specs.push({ n, priority: Math.min(n.degree, 40), font: FONT_LEAF, emphasis: "neighbor" });
        }
        for (const n of layout.placed) {
          if (n.id === "index") continue;
          if (n.category !== null) continue;
          specs.push({ n, priority: 60, font: FONT_LEAF, emphasis: "neighbor" });
        }
      }
      specs.sort((a, b) => b.priority - a.priority);

      // ---- (4) place labels with overlap-avoidance ----------------------
      // Each label is a candidate rect. We accept it only if it overlaps
      // neither another already-placed label nor any marker (other than the
      // node's own marker, which it sits flush against by definition).
      // If a label can't fit, the node still has its marker; the label
      // appears on hover (which always force-draws via "focus" emphasis).
      //
      // Both overlap tests use a uniform spatial hash so we don't pay an
      // O(n) scan per candidate — with everything expanded that's ~390
      // markers × ~9 candidates × ~N labels = millions of compares per draw.
      const GRID = Math.max(40, Math.min(sizeRef.current.w, sizeRef.current.h) / 16);
      const cellKey = (gx: number, gy: number) => gx * 100000 + gy;
      const eachCell = (r: Rect, fn: (key: number) => void) => {
        const gx0 = Math.floor(r.x0 / GRID);
        const gy0 = Math.floor(r.y0 / GRID);
        const gx1 = Math.floor(r.x1 / GRID);
        const gy1 = Math.floor(r.y1 / GRID);
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gy = gy0; gy <= gy1; gy++) fn(cellKey(gx, gy));
        }
      };
      const markerGrid = new Map<number, number[]>();
      for (let i = 0; i < markerRects.length; i++) {
        eachCell(markerRects[i], (key) => {
          let arr = markerGrid.get(key);
          if (!arr) { arr = []; markerGrid.set(key, arr); }
          arr.push(i);
        });
      }
      const labelGrid = new Map<number, Rect[]>();
      const labelHits: { id: string; rect: Rect }[] = [];
      const overlapsLabel = (r: Rect) => {
        let hit = false;
        eachCell(r, (key) => {
          if (hit) return;
          const arr = labelGrid.get(key);
          if (!arr) return;
          for (const p of arr) {
            if (r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0) { hit = true; return; }
          }
        });
        return hit;
      };
      const overlapsMarker = (r: Rect, ownId: string) => {
        let hit = false;
        eachCell(r, (key) => {
          if (hit) return;
          const arr = markerGrid.get(key);
          if (!arr) return;
          for (const i of arr) {
            const node = layout.placed[i];
            if (node.id === ownId) continue;
            const m = markerRects[i];
            if (r.x0 < m.x1 && r.x1 > m.x0 && r.y0 < m.y1 && r.y1 > m.y0) { hit = true; return; }
          }
        });
        return hit;
      };
      const recordLabel = (id: string, r: Rect) => {
        labelHits.push({ id, rect: r });
        eachCell(r, (key) => {
          let arr = labelGrid.get(key);
          if (!arr) { arr = []; labelGrid.set(key, arr); }
          arr.push(r);
        });
      };

      const cx = sizeRef.current.w / 2;
      const cy = sizeRef.current.h / 2;
      // Try a sequence of placements per label: outward (radial), then
      // tangential offsets, then opposite side. First fit wins.
      const buildCandidates = (n: PlacedNode): { x: number; y: number; align: "left" | "right" }[] => {
        const dx = n.x - cx;
        const dy = n.y - cy;
        const d = Math.hypot(dx, dy) || 1;
        const ux = dx / d;
        const uy = dy / d;
        const offset = (n.r + 7) / t.k;
        const tangentX = -uy;
        const tangentY = ux;
        // Tangent step is the distance between adjacent candidate slots on
        // the arc. It needs to be roughly a label-height (~16px) so each
        // sign step gives a fresh row that won't overlap the previous row.
        // Smaller values make all candidates collide with each other.
        const T = 16 / t.k;
        const cands: { x: number; y: number; align: "left" | "right" }[] = [];
        // For homepage / anchors near center, prefer right-side.
        const nearCenter = d < 8;
        if (nearCenter) {
          cands.push({ x: n.x + offset, y: n.y, align: "left" });
          cands.push({ x: n.x - offset, y: n.y, align: "right" });
        } else {
          // 1) outward radial
          cands.push({ x: n.x + ux * offset, y: n.y + uy * offset, align: ux >= 0 ? "left" : "right" });
          // 2) outward + tangential nudges (up & down along the arc).
          //   Wide range so cluster-leaf labels can step well past the
          //   adjacent label and find an open slot — without this they all
          //   pile up just outside the wheel and most get dropped.
          for (const sign of [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8]) {
            cands.push({
              x: n.x + ux * offset + tangentX * T * sign,
              y: n.y + uy * offset + tangentY * T * sign,
              align: ux >= 0 ? "left" : "right",
            });
          }
          // 3) push further radially-out, repeating the tangential search.
          //   Lets a leaf escape its row when the row is saturated.
          for (const radialMul of [2, 3, 4, 5]) {
            for (const sign of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) {
              cands.push({
                x: n.x + ux * offset * radialMul + tangentX * T * sign,
                y: n.y + uy * offset * radialMul + tangentY * T * sign,
                align: ux >= 0 ? "left" : "right",
              });
            }
          }
          // 4) inward (last resort, flips alignment)
          cands.push({ x: n.x - ux * offset, y: n.y - uy * offset, align: ux >= 0 ? "right" : "left" });
        }
        return cands;
      };

      // Cache text metrics per (font, text) — measureText is a real DOM call
      // and gets invoked thousands of times per draw via the candidate loop.
      const metricCache = new Map<string, { w: number; h: number }>();
      const getMetrics = (text: string, font: string) => {
        const key = font + "|" + text;
        let m = metricCache.get(key);
        if (m) return m;
        ctx.font = font;
        const tm = ctx.measureText(text);
        const ascent = tm.actualBoundingBoxAscent || 10;
        const descent = tm.actualBoundingBoxDescent || 4;
        m = { w: tm.width, h: ascent + descent };
        metricCache.set(key, m);
        return m;
      };
      const measureRect = (
        text: string,
        font: string,
        x: number,
        y: number,
        align: "left" | "right",
      ): Rect => {
        const m = getMetrics(text, font);
        const padX = 3 / t.k;
        const padY = 3 / t.k;
        const x0 = align === "left" ? x : x - m.w;
        const x1 = align === "left" ? x + m.w : x;
        return {
          x0: x0 - padX,
          y0: y - m.h / 2 - padY,
          x1: x1 + padX,
          y1: y + m.h / 2 + padY,
        };
      };

      // Every label must render — non-overlap is a preference, not a rule.
      // We try the placement candidates in order and accept the first one
      // that's clear; if all of them overlap something, we still draw at
      // the *least crowded* candidate so the label is visible. Dense
      // clusters (Nothing has 79 members) will have visible overlap; that
      // is the trade-off — the user asked for guaranteed display.
      const placeWithFallback = (s: LabelSpec) => {
        const cands = buildCandidates(s.n);
        // Score each candidate by how many existing labels and markers it
        // overlaps (cheap, since we only need a count, not a list).
        let bestRect: Rect | null = null;
        let bestX = 0;
        let bestY = 0;
        let bestAlign: "left" | "right" = "left";
        let bestScore = Infinity;
        for (const c of cands) {
          const rect = measureRect(s.n.title, s.font, c.x, c.y, c.align);
          const lbl = overlapsLabel(rect) ? 1 : 0;
          const mk = overlapsMarker(rect, s.n.id) ? 1 : 0;
          const score = lbl * 2 + mk; // labels overlapping labels is worse than overlapping a tiny marker dot
          // Accept first "good enough" placement — a sole tiny marker overlap
          // is acceptable and exhausting all ~60 candidates per label is the
          // hot path that made dense clusters (Concept, Nothing) feel laggy.
          if (score <= 1) {
            return { rect, x: c.x, y: c.y, align: c.align };
          }
          if (score < bestScore) {
            bestScore = score;
            bestRect = rect;
            bestX = c.x;
            bestY = c.y;
            bestAlign = c.align;
          }
        }
        return { rect: bestRect!, x: bestX, y: bestY, align: bestAlign };
      };

      for (const s of specs) {
        const placement = placeWithFallback(s);
        ctx.font = s.font;
        ctx.textAlign = placement.align;
        ctx.fillStyle =
          s.emphasis === "anchor" || s.emphasis === "focus" ? "#111" : "rgba(17,17,17,0.78)";
        ctx.fillText(s.n.title, placement.x, placement.y);
        recordLabel(s.n.id, placement.rect);
      }

      // Expose the placed label rects to the hit-tester (lives in a sibling
      // closure). The next paint clears these — that's fine; whatever's on
      // screen is what's clickable.
      labelHitsRef.current = labelHits;

      ctx.restore();
    };
    // Install the new draw closure FIRST so any zoom events fired below
    // (via zb.transform) draw against the new layout, not the previous one.
    drawRef.current = draw;

    // If the *content* changed (expand/collapse/graph load) since the last
    // draw, recenter the viewport on the new layout BEFORE drawing. Doing
    // this here — instead of in a separate effect — guarantees the first
    // paint with the new layout uses the new transform. Otherwise React
    // commits the draw effect first (which paints with the OLD transform,
    // putting most content off-screen) and runs the recenter effect after,
    // producing a flash where the map looks empty.
    const zb = zoomBehaviorRef.current;
    const { w: cw, h: ch } = sizeRef.current;
    const needsRecenter = recenterTokenRef.current !== lastRecenterTokenRef.current;
    let recenterDrew = false;
    if (needsRecenter && zb && cw > 200 && ch > 200 && layout.placed.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of layout.placed) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
      }
      const bbW = Math.max(maxX - minX, 1);
      const bbH = Math.max(maxY - minY, 1);
      const ccx = (minX + maxX) / 2;
      const ccy = (minY + maxY) / 2;
      const margin = 80;
      // Guard against tiny canvases mid-transition: clamp to a positive k.
      const kFit = Math.min((cw - margin * 2) / bbW, (ch - margin * 2) / bbH, 1);
      const k = kFit > 0.05 ? kFit : 1;
      const tx = cw / 2 - ccx * k;
      const ty = ch / 2 - ccy * k;
      // Push the new transform through the zoom behavior so its internal
      // state stays consistent with what we're rendering. This fires the
      // "zoom" event, which updates transformRef and triggers a draw against
      // the new closure we just installed.
      select(canvas).call(zb.transform, zoomIdentity.translate(tx, ty).scale(k));
      lastRecenterTokenRef.current = recenterTokenRef.current;
      // zb.transform fires the zoom handler synchronously, which calls
      // drawRef.current() — so we already drew with the new transform.
      recenterDrew = true;
    }

    if (!recenterDrew) draw();
  }, [graph, layout, expanded]);

  // Repaint when state that draw() reads changes (hover/select/query).
  // `layout` is intentionally omitted — the layout effect above already draws.
  useEffect(() => { drawRef.current(); }, [hoverId, selectedId, query]);

  // ---- click handling ------------------------------------------------------
  const handleNodeClick = useCallback(
    (n: PlacedNode | null) => {
      if (!n) {
        setSelectedId(null);
        return;
      }
      // Clicking a collapsed category expands it (and selects so the panel
      // shows the hub's blurb).
      if (n.collapsed) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(n.id);
          return next;
        });
        setSelectedId(n.id);
        return;
      }
      setSelectedId(n.id);
    },
    [],
  );

  // Keep the ref fresh so the mount-once pointer handlers always call the
  // latest closure (which has the latest `expanded` set in scope).
  useEffect(() => { handleNodeClickRef.current = handleNodeClick; }, [handleNodeClick]);

  const toggleCategory = useCallback((cat: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    if (!graph) return;
    setExpanded(new Set(graph.categories.map((c) => c.id)));
  }, [graph]);
  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  // ---- panel data ----------------------------------------------------------
  const selectedNode = selectedId ? indexes.byId.get(selectedId) ?? null : null;
  const selectedNeighbors = useMemo(() => {
    if (!selectedId) return [] as RawNode[];
    const ids = indexes.rawNeighbors.get(selectedId);
    if (!ids) return [];
    const list: RawNode[] = [];
    for (const id of ids) {
      const n = indexes.byId.get(id);
      if (n) list.push(n);
    }
    list.sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title));
    return list;
  }, [selectedId, indexes]);

  const focusOn = useCallback(
    (id: string) => {
      const n = indexes.byId.get(id);
      if (!n) return;
      if (n.category && !n.isCategoryRoot && !expanded.has(n.category)) {
        toggleCategory(n.category);
      }
      setSelectedId(id);
    },
    [indexes, expanded, toggleCategory],
  );

  if (error) {
    return <div className="py-20 text-center text-[color:var(--color-ink-muted)]">Couldn’t load the graph. {error}</div>;
  }

  const totalCategories = graph?.categories.length ?? 0;
  const expandedCount = expanded.size;

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between mb-3 gap-4 flex-wrap">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles…"
          className="border border-[color:var(--color-rule-light)] px-3 py-1.5 text-[0.95rem] font-sans w-64 focus:outline-none focus:border-[color:var(--color-ink)]"
        />
        <div className="section-label">
          {graph ? `${graph.nodes.length} pages · ${graph.links.length} links` : "loading…"}
          {hoverId && graph && hoverId !== selectedId && (
            <span className="ml-4 text-[color:var(--color-ink)] normal-case tracking-normal font-normal">
              {indexes.byId.get(hoverId)?.title}
            </span>
          )}
        </div>
      </div>

      {graph && (
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span className="section-label mr-1">Categories</span>
          {graph.categories.map((c) => {
            const isOpen = expanded.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleCategory(c.id)}
                aria-pressed={isOpen}
                className={
                  "font-sans text-[0.85rem] px-2.5 py-1 border rounded-full transition-colors " +
                  (isOpen
                    ? "bg-[color:var(--color-ink)] text-[color:var(--color-paper)] border-[color:var(--color-ink)]"
                    : "bg-[color:var(--color-paper)] text-[color:var(--color-ink)] border-[color:var(--color-rule-light)] hover:border-[color:var(--color-ink)]")
                }
              >
                {c.label}
              </button>
            );
          })}
          <span className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={expandAll}
              disabled={expandedCount === totalCategories}
              className="font-sans text-[0.85rem] underline underline-offset-4 disabled:opacity-30 disabled:no-underline"
            >
              Expand all
            </button>
            <button
              type="button"
              onClick={collapseAll}
              disabled={expandedCount === 0}
              className="font-sans text-[0.85rem] underline underline-offset-4 disabled:opacity-30 disabled:no-underline"
            >
              Collapse all
            </button>
          </span>
        </div>
      )}

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: selectedNode ? "1fr 22rem" : "1fr 0" }}
      >
        <div
          ref={wrapRef}
          className="border border-[color:var(--color-rule-light)] bg-[color:var(--color-paper)] min-w-0"
          style={{ height: "calc(100vh - 160px)", minHeight: 500 }}
        >
          <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
        </div>

        <aside
          aria-hidden={!selectedNode}
          className="overflow-hidden"
          style={{
            height: "calc(100vh - 160px)",
            minHeight: 500,
            opacity: selectedNode ? 1 : 0,
            transition: "opacity 180ms ease",
            pointerEvents: selectedNode ? "auto" : "none",
          }}
        >
          {selectedNode && (
            <div className="h-full flex flex-col border border-[color:var(--color-rule-light)] bg-[color:var(--color-paper)]">
              <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
                <div className="min-w-0">
                  <p className="section-label">
                    {selectedNode.isCategoryRoot ? "Category" : "Page"}
                  </p>
                  <h2 className="font-serif text-[1.35rem] leading-snug mt-1">{selectedNode.title}</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  aria-label="Close"
                  className="text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)] text-xl leading-none px-1"
                >
                  ×
                </button>
              </div>

              {selectedNode.blurb && (
                <p className="px-5 pb-4 font-serif text-[0.95rem] leading-relaxed text-[color:var(--color-ink-muted)]">
                  {selectedNode.blurb}
                </p>
              )}

              <div className="px-5 pb-3">
                <a
                  href={`${import.meta.env.BASE_URL}${selectedNode.id}`}
                  className="inline-block font-sans text-[0.95rem] underline underline-offset-4"
                >
                  Open page →
                </a>
              </div>

              <hr className="rule-light mx-5" />

              <div className="px-5 pt-4 pb-2 flex items-baseline justify-between">
                <p className="section-label">Linked from this page</p>
                <span className="section-label">{selectedNeighbors.length}</span>
              </div>
              <ul className="overflow-y-auto px-5 pb-5 space-y-1">
                {selectedNeighbors.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => focusOn(n.id)}
                      className="w-full text-left font-serif text-[0.95rem] leading-snug py-1 hover:underline underline-offset-4"
                    >
                      {n.title}
                    </button>
                  </li>
                ))}
                {selectedNeighbors.length === 0 && (
                  <li className="font-sans text-[0.85rem] text-[color:var(--color-ink-muted)]">No connections.</li>
                )}
              </ul>
            </div>
          )}
        </aside>
      </div>

      <p className="section-label mt-3">
        Click a category to expand · Click a page to preview · Drag to pan · Scroll to zoom
      </p>
    </div>
  );
}
