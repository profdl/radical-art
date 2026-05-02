// Legacy HTML often had hard line wraps in the middle of sentences.
// Collapse single newlines into spaces; keep blank-line breaks as paragraph breaks.
export function unwrap(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/(?<!\n)\n(?!\n)/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function paragraphs(text: string): string[] {
  return unwrap(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Capitalize the first letter only — useful for section labels.
export function titleCase(s: string): string {
  return s
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

export function sectionLabel(section: string): string {
  if (section === "(root)") return "Radical Art";
  return titleCase(section.replace(/([A-Z])/g, " $1").trim());
}

// Prepend Astro's configured base path to a root-relative URL so links and
// asset srcs resolve correctly when the site is deployed under a sub-path
// (GitHub Pages: /radical-art/). External URLs and already-prefixed paths
// pass through unchanged. BASE_URL is "/radical-art/" in production and
// "/" in dev, both with trailing slash.
export function withBase(path: string): string {
  if (!path) return path;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) return path;
  if (path.startsWith("#") || path.startsWith("?")) return path;
  const base = import.meta.env.BASE_URL || "/";
  if (!path.startsWith("/")) return path;
  if (path === "/") return base;
  // Strip the leading slash from path; base already ends with "/".
  return base + path.slice(1);
}
