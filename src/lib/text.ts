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
