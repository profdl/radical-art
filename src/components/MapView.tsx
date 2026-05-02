import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, type ZoomBehavior } from "d3-zoom";

interface RawNode {
  id: string;
  title: string;
  blurb?: string;
  degree: number;
}
interface RawLink {
  source: string;
  target: string;
}
interface Graph {
  nodes: RawNode[];
  links: RawLink[];
}

interface SimNode extends SimulationNodeDatum, RawNode {
  r: number;
}
type SimLink = SimulationLinkDatum<SimNode>;

const NODE_R_MIN = 2;
const NODE_R_MAX = 11;

function radiusFor(degree: number, maxDegree: number): number {
  // sqrt scaling so the homepage doesn't dwarf everything.
  const t = Math.sqrt(degree) / Math.sqrt(maxDegree || 1);
  return NODE_R_MIN + t * (NODE_R_MAX - NODE_R_MIN);
}

export default function MapView() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Refs the render/event handlers read — avoid restarting the simulation on
  // every hover/selection/query change.
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const queryRef = useRef<string>("");
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  useEffect(() => { hoverRef.current = hoverId; }, [hoverId]);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  useEffect(() => { queryRef.current = query.trim().toLowerCase(); }, [query]);

  useEffect(() => {
    let cancelled = false;
    fetch("/graph.json")
      .then((r) => {
        if (!r.ok) throw new Error(`graph.json: ${r.status}`);
        return r.json();
      })
      .then((g: Graph) => { if (!cancelled) setGraph(g); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);

  // Build node lookups + neighbor index.
  const { nodes, links, neighbors, maxDegree } = useMemo(() => {
    if (!graph) return { nodes: [], links: [], neighbors: new Map<string, Set<string>>(), maxDegree: 1 };
    const maxDeg = graph.nodes.reduce((m, n) => Math.max(m, n.degree), 1);
    const nodes: SimNode[] = graph.nodes.map((n) => ({
      ...n,
      r: radiusFor(n.degree, maxDeg),
    }));
    const links: SimLink[] = graph.links.map((l) => ({ source: l.source, target: l.target }));
    const neighbors = new Map<string, Set<string>>();
    for (const n of nodes) neighbors.set(n.id, new Set());
    for (const l of graph.links) {
      neighbors.get(l.source)?.add(l.target);
      neighbors.get(l.target)?.add(l.source);
    }
    return { nodes, links, neighbors, maxDegree: maxDeg };
  }, [graph]);

  // Simulation + canvas wiring.
  useEffect(() => {
    if (!graph || !canvasRef.current || !wrapRef.current) return;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;

    const dpr = window.devicePixelRatio || 1;
    let width = wrap.clientWidth;
    let height = wrap.clientHeight;

    const resize = () => {
      width = wrap.clientWidth;
      height = wrap.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const ctx = canvas.getContext("2d")!;

    const sim = forceSimulation<SimNode>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(40)
          .strength(0.4),
      )
      .force("charge", forceManyBody<SimNode>().strength(-90).distanceMax(500))
      .force("center", forceCenter(width / 2, height / 2).strength(0.04))
      .force("collide", forceCollide<SimNode>().radius((d) => d.r + 2).iterations(2))
      .alpha(1)
      .alphaDecay(0.025);

    simRef.current = sim;

    const draw = () => {
      const t = transformRef.current;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.translate(t.x, t.y);
      ctx.scale(t.k, t.k);

      // Selection wins over hover. Either drives the "focus" treatment;
      // hover is still useful as a soft cue when nothing is selected.
      const selected = selectedRef.current;
      const hover = hoverRef.current;
      const focusId = selected ?? hover;
      const q = queryRef.current;
      const matchSet = q
        ? new Set(nodes.filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).map((n) => n.id))
        : null;
      const focusSet = focusId ? neighbors.get(focusId) : null;

      // edges
      ctx.lineWidth = 0.6 / t.k;
      for (const l of links) {
        const s = l.source as SimNode;
        const tg = l.target as SimNode;
        const inFocus = !!(focusId && (s.id === focusId || tg.id === focusId));
        const inMatch = matchSet ? matchSet.has(s.id) || matchSet.has(tg.id) : true;
        if (focusId && !inFocus) {
          ctx.strokeStyle = "rgba(17,17,17,0.04)";
        } else if (!inMatch) {
          ctx.strokeStyle = "rgba(17,17,17,0.04)";
        } else if (inFocus) {
          ctx.strokeStyle = "rgba(17,17,17,0.7)";
        } else {
          ctx.strokeStyle = "rgba(17,17,17,0.18)";
        }
        ctx.beginPath();
        ctx.moveTo(s.x ?? 0, s.y ?? 0);
        ctx.lineTo(tg.x ?? 0, tg.y ?? 0);
        ctx.stroke();
      }

      // nodes
      for (const n of nodes) {
        const isFocus = focusId === n.id;
        const isSelected = selected === n.id;
        const isNeighbor = !!(focusSet && focusSet.has(n.id));
        const inMatch = matchSet ? matchSet.has(n.id) : true;
        const dim = (focusId && !isFocus && !isNeighbor) || !inMatch;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, n.r, 0, Math.PI * 2);
        if (isFocus || isNeighbor) {
          ctx.fillStyle = "#111";
          ctx.fill();
          if (isSelected) {
            // Halo ring on the selected node so it's visually distinct from neighbors.
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, n.r + 4 / t.k, 0, Math.PI * 2);
            ctx.lineWidth = 1.25 / t.k;
            ctx.strokeStyle = "rgba(17,17,17,0.55)";
            ctx.stroke();
          }
        } else {
          ctx.fillStyle = dim ? "rgba(255,255,255,1)" : "#fff";
          ctx.fill();
          ctx.lineWidth = 1 / t.k;
          ctx.strokeStyle = dim ? "rgba(17,17,17,0.18)" : "rgba(17,17,17,0.7)";
          ctx.stroke();
        }
      }

      // labels: focus + neighbors + matches + (when nothing else is going on) high-degree.
      ctx.font = `500 ${12 / t.k}px "IBM Plex Sans", sans-serif`;
      ctx.textBaseline = "middle";
      const labelThreshold = Math.max(8, Math.floor(maxDegree * 0.08));
      for (const n of nodes) {
        const isFocus = focusId === n.id;
        const isNeighbor = !!(focusSet && focusSet.has(n.id));
        const inMatch = matchSet ? matchSet.has(n.id) : false;
        const prominent = n.degree >= labelThreshold;
        const show = isFocus || isNeighbor || inMatch || (!focusId && !matchSet && prominent);
        if (!show) continue;
        ctx.fillStyle = isFocus ? "#111" : "rgba(17,17,17,0.85)";
        ctx.fillText(n.title, (n.x ?? 0) + n.r + 4 / t.k, n.y ?? 0);
      }

      ctx.restore();
    };

    sim.on("tick", draw);

    // Pointer → world coords, hit test
    const screenToWorld = (cx: number, cy: number) => {
      const rect = canvas.getBoundingClientRect();
      const sx = cx - rect.left;
      const sy = cy - rect.top;
      const t = transformRef.current;
      return { x: (sx - t.x) / t.k, y: (sy - t.y) / t.k };
    };
    const hitTest = (cx: number, cy: number): SimNode | null => {
      const { x, y } = screenToWorld(cx, cy);
      let best: SimNode | null = null;
      let bestD2 = Infinity;
      for (const n of nodes) {
        const dx = (n.x ?? 0) - x;
        const dy = (n.y ?? 0) - y;
        const d2 = dx * dx + dy * dy;
        const r = n.r + 4 / transformRef.current.k;
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
      if (id !== hoverRef.current) setHoverId(id);
      canvas.style.cursor = hit ? "pointer" : "grab";
    };
    // Discriminate click from drag: track pointerdown position, only treat
    // pointerup as a click if the movement is small. Otherwise zoom/pan
    // gestures would clear the selection on release.
    let downAt: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const onUp = (e: PointerEvent) => {
      if (!downAt) return;
      const dx = e.clientX - downAt.x;
      const dy = e.clientY - downAt.y;
      const moved = Math.hypot(dx, dy);
      const dt = performance.now() - downAt.t;
      downAt = null;
      if (moved > 4 || dt > 500) return; // treated as a drag, not a click
      const hit = hitTest(e.clientX, e.clientY);
      setSelectedId(hit ? hit.id : null);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);

    // Zoom & pan
    const zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown> = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.2, 8])
      .on("zoom", (e) => {
        transformRef.current = { x: e.transform.x, y: e.transform.y, k: e.transform.k };
        draw();
      });
    select(canvas).call(zoomBehavior);

    return () => {
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      sim.stop();
    };
  }, [graph, nodes, links, neighbors, maxDegree]);

  // Re-trigger a render when hover/selection/query changes (sim may have settled).
  useEffect(() => {
    const sim = simRef.current;
    if (sim) sim.alpha(Math.max(sim.alpha(), 0.05)).restart();
  }, [hoverId, selectedId, query]);

  // Lookup table by id for fast panel rendering.
  const byId = useMemo(() => {
    const m = new Map<string, RawNode>();
    if (graph) for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);

  const selectedNode = selectedId ? byId.get(selectedId) ?? null : null;
  const selectedNeighbors = useMemo(() => {
    if (!selectedId) return [] as RawNode[];
    const ids = neighbors.get(selectedId);
    if (!ids) return [];
    const list: RawNode[] = [];
    for (const id of ids) {
      const n = byId.get(id);
      if (n) list.push(n);
    }
    list.sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title));
    return list;
  }, [selectedId, neighbors, byId]);

  if (error) {
    return <div className="py-20 text-center text-[color:var(--color-ink-muted)]">Couldn’t load the graph. {error}</div>;
  }

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
          {!selectedId && hoverId && graph && (
            <span className="ml-4 text-[color:var(--color-ink)] normal-case tracking-normal font-normal">
              {byId.get(hoverId)?.title}
            </span>
          )}
        </div>
      </div>

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: selectedNode ? "1fr 22rem" : "1fr 0", transition: "grid-template-columns 220ms ease" }}
      >
        <div
          ref={wrapRef}
          className="border border-[color:var(--color-rule-light)] bg-[color:var(--color-paper)] min-w-0"
          style={{ height: "calc(100vh - 220px)", minHeight: 500 }}
        >
          <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
        </div>

        <aside
          aria-hidden={!selectedNode}
          className="overflow-hidden"
          style={{
            height: "calc(100vh - 220px)",
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
                  <p className="section-label">Page</p>
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
                  href={`/${selectedNode.id}`}
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
                      onClick={() => setSelectedId(n.id)}
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
        Drag to pan · Scroll to zoom · Click a node to preview · Click empty space to deselect
      </p>
    </div>
  );
}
