import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { withBase } from "~/lib/text";

// Mirrors src/pages/constellation.astro and build_graph.py.
const TOP_LABELS: Record<string, string> = {
  concept: "concept",
  life: "life",
  everything: "everything",
  "algorithmic-art": "algorithm",
  anything: "anything",
  kinetics: "mechanics",
  something: "something",
  process: "process",
  destruction: "destruction",
  nothing: "nothing",
};
const VIRTUAL_PARENTS: Record<string, string> = {
  things: "everything",
  nature: "everything",
  physics: "nature",
  ego: "life",
  informe: "something",
};
function resolveCategory(slug: string): string | null {
  if (!slug || slug === "index") return null;
  let head = slug.split("/")[0];
  const seen = new Set<string>();
  while (head in VIRTUAL_PARENTS && !seen.has(head)) {
    seen.add(head);
    head = VIRTUAL_PARENTS[head];
  }
  return head in TOP_LABELS ? head : null;
}

// Pre-rendered: Astro will produce a static constellation.json at build time
// (dist/constellation.json), so the client can fetch it like graph.json.
// This keeps the page HTML small — the 3,500-image index ships as a JSON
// asset that the browser caches separately, instead of being inlined into
// every constellation.html load.
export const prerender = true;

export const GET: APIRoute = async () => {
  const all = await getCollection("pages");

  type Img = {
    id: string;
    src: string;
    alt: string;
    caption: string;
    pageSlug: string;
    pageTitle: string;
    pageBlurb: string;
    category: string | null;
    categoryLabel: string | null;
  };
  type Page = {
    slug: string;
    title: string;
    blurb: string;
    category: string | null;
    categoryLabel: string | null;
    imageIds: string[];
    siblingSlugs: string[];
  };

  const images: Img[] = [];
  const pages: Page[] = [];

  for (const entry of all) {
    const d = entry.data;
    if (d.archetype === "site-home") continue;

    const category = resolveCategory(d.slug);
    const categoryLabel = category ? TOP_LABELS[category] : null;

    const siblingSlugs: string[] = [];
    for (const raw of d.out_links || []) {
      if (!raw) continue;
      const trimmed = raw.replace(/^\/+/, "");
      if (!trimmed || trimmed === d.slug) continue;
      siblingSlugs.push(trimmed);
    }

    const imageIds: string[] = [];
    for (const block of d.blocks) {
      if (block.type !== "figure" || !block.src) continue;
      if (/\/buttons\/blue\d+\.gif/i.test(block.src)) continue;
      const id = block.src;
      imageIds.push(id);
      images.push({
        id,
        src: withBase(block.src),
        alt: block.alt || "",
        caption: (block.caption || "").trim(),
        pageSlug: d.slug,
        pageTitle: d.title || d.slug,
        pageBlurb: (d.description || "").trim(),
        category,
        categoryLabel,
      });
    }

    pages.push({
      slug: d.slug,
      title: d.title || d.slug,
      blurb: (d.description || "").trim(),
      category,
      categoryLabel,
      imageIds,
      siblingSlugs,
    });
  }

  const validSlugs = new Set(pages.map((p) => p.slug));
  for (const p of pages) {
    p.siblingSlugs = p.siblingSlugs.filter((s) => validSlugs.has(s));
  }

  return new Response(JSON.stringify({ images, pages }), {
    headers: { "Content-Type": "application/json" },
  });
};
